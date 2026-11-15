import { z } from 'zod';
import { db } from './db';
import { encrypt, decrypt, token, digest } from './crypto';
import { HttpError } from './errors';
import { env } from './env';
import { githubFetch } from './github';
import { lockActiveProject } from './project-lock';
import {
  repositoryCommand,
  repositoryName,
  normalizeGitHubEvent,
  verifyGitHubSignature,
} from './github-webhook';
import type { Prisma } from '@prisma/client';
import type { WorkspaceActor } from './tasks';

const publicConnection = {
  id: true,
  projectId: true,
  repositoryId: true,
  repositoryFullName: true,
  createdAt: true,
  disconnectedAt: true,
} as const;
async function authorize(
  tx: Prisma.TransactionClient,
  actor: WorkspaceActor,
  projectId: string,
  admin = true,
) {
  const member = await tx.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: actor.workspaceId, userId: actor.userId } },
  });
  if (!member) throw new HttpError(404, 'Workspace not found');
  if (admin && member.role === 'MEMBER')
    throw new HttpError(403, 'Workspace administrator access required');
  const project = await tx.project.findFirst({
    where: { id: projectId, workspaceId: actor.workspaceId },
  });
  if (!project) throw new HttpError(404, 'Project not found');
  return project;
}
export async function verifyRepositoryAccess(userId: string, name: string) {
  name = repositoryName.parse(name);
  const account = await db.gitHubConnection.findUnique({ where: { userId } });
  if (!account) throw new HttpError(409, 'Connect your GitHub account first');
  const response: unknown = await githubFetch(`/repos/${name}`, decrypt(account.encryptedToken));
  const repo = z
    .object({
      id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      full_name: repositoryName,
      archived: z.boolean(),
      disabled: z.boolean().optional(),
      permissions: z.object({ admin: z.literal(true) }),
    })
    .safeParse(response);
  if (!repo.success) throw new HttpError(403, 'GitHub repository administrator access is required');
  if (repo.data.archived || repo.data.disabled)
    throw new HttpError(409, 'Choose an active GitHub repository');
  if (repo.data.full_name.toLowerCase() !== name.toLowerCase())
    throw new HttpError(409, 'Repository identity changed. Refresh GitHub repositories.');
  return { id: String(repo.data.id), fullName: repo.data.full_name };
}
export async function listRepositoryConnections(actor: WorkspaceActor, projectId: string) {
  return db.$transaction(async (tx) => {
    await authorize(tx, actor, projectId, false);
    return tx.gitHubRepositoryConnection.findMany({
      where: { workspaceId: actor.workspaceId, projectId, disconnectedAt: null },
      select: publicConnection,
    });
  });
}
export async function connectRepository(actor: WorkspaceActor, value: unknown) {
  const input = repositoryCommand.parse(value);
  await db.$transaction(async (tx) => {
    await authorize(tx, actor, input.projectId);
  });
  // External permission lookup is not performed while holding database locks.
  const origin = new URL(env().APP_URL);
  if (
    origin.username ||
    origin.password ||
    (origin.protocol !== 'https:' &&
      !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)))
  )
    throw new HttpError(503, 'Configure a public HTTPS APP_URL for GitHub webhooks');
  const repo = await verifyRepositoryAccess(actor.userId, input.repository);
  const secret = token();
  const encryptedWebhookSecret = encrypt(secret);
  const connection = await db.$transaction(
    async (tx) => {
      await lockActiveProject(tx, actor.userId, actor.workspaceId, input.projectId);
      await authorize(tx, actor, input.projectId);
      if (
        await tx.gitHubRepositoryConnection.findFirst({
          where: { projectId: input.projectId, disconnectedAt: null },
        })
      )
        throw new HttpError(
          409,
          'Disconnect the current webhook connection before connecting another repository',
        );
      const created = await tx.gitHubRepositoryConnection.create({
        data: {
          workspaceId: actor.workspaceId,
          projectId: input.projectId,
          repositoryId: repo.id,
          repositoryFullName: repo.fullName,
          connectedById: actor.userId,
          encryptedWebhookSecret,
        },
        select: publicConnection,
      });
      await tx.project.update({
        where: { id: input.projectId },
        data: { repository: repo.fullName },
      });
      await tx.taskActivity.create({
        data: {
          workspaceId: actor.workspaceId,
          actorId: actor.userId,
          message: `connected GitHub webhook for ${repo.fullName}`,
        },
      });
      return created;
    },
    { isolationLevel: 'ReadCommitted' },
  );
  return {
    connection,
    setup: {
      url: `${origin.origin}/api/github/webhooks/${connection.id}`,
      secret,
      events: ['push', 'pull_request', 'issues', 'workflow_run'],
      contentType: 'application/json',
    },
  };
}
export async function disconnectRepository(actor: WorkspaceActor, id: string) {
  return db.$transaction(
    async (tx) => {
      const c = await tx.gitHubRepositoryConnection.findFirst({
        where: { id, workspaceId: actor.workspaceId },
      });
      if (!c) throw new HttpError(404, 'Repository connection not found');
      await authorize(tx, actor, c.projectId);
      // Disconnection remains possible for archived projects.
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${c.projectId} AND "workspaceId" = ${actor.workspaceId} FOR UPDATE`;
      await authorize(tx, actor, c.projectId);
      // Lock the inbox boundary after the project lock (same order as ingestion).
      await tx.$queryRaw`SELECT "id" FROM "GitHubRepositoryConnection" WHERE "id" = ${id} FOR UPDATE`;
      const changed = await tx.gitHubRepositoryConnection.updateMany({
        where: { id, disconnectedAt: null },
        data: {
          disconnectedAt: new Date(),
          encryptedWebhookSecret: '',
          enrichmentUserId: null,
          enrichmentAuthorizedAt: null,
          enrichmentVersion: { increment: 1 },
        },
      });
      if (changed.count) {
        await tx.gitHubWebhookDelivery.updateMany({
          where: { connectionId: id, state: { in: ['PENDING', 'FAILED', 'PROCESSING'] } },
          data: {
            state: 'CANCELLED',
            lockedAt: null,
            leaseToken: null,
            leaseExpiresAt: null,
            errorCode: 'CONNECTION_DISCONNECTED',
          },
        });
        await tx.project.updateMany({
          where: { id: c.projectId, repository: c.repositoryFullName },
          data: { repository: null },
        });
        await tx.taskActivity.create({
          data: {
            workspaceId: actor.workspaceId,
            actorId: actor.userId,
            message: `disconnected GitHub webhook for ${c.repositoryFullName}`,
          },
        });
      }
      return { ok: true, changed: !!changed.count };
    },
    { isolationLevel: 'ReadCommitted' },
  );
}
export async function listGitHubDeliveries(actor: WorkspaceActor, id: string) {
  return db.$transaction(async (tx) => {
    const c = await tx.gitHubRepositoryConnection.findFirst({
      where: { id, workspaceId: actor.workspaceId },
    });
    if (!c) throw new HttpError(404, 'Repository connection not found');
    await authorize(tx, actor, c.projectId);
    return tx.gitHubWebhookDelivery.findMany({
      where: { connectionId: id },
      orderBy: { receivedAt: 'desc' },
      take: 50,
      select: {
        deliveryId: true,
        event: true,
        state: true,
        receivedAt: true,
        attempts: true,
        errorCode: true,
      },
    });
  });
}
export async function ingestGitHubDelivery(id: string, raw: Buffer, headers: Headers) {
  const c = await db.gitHubRepositoryConnection.findUnique({ where: { id } });
  if (!c || c.disconnectedAt) throw new HttpError(404, 'Repository connection not found');
  if (
    !verifyGitHubSignature(
      raw,
      headers.get('x-hub-signature-256'),
      decrypt(c.encryptedWebhookSecret),
    )
  )
    throw new HttpError(401, 'Invalid GitHub webhook signature');
  const deliveryId = z.string().uuid().parse(headers.get('x-github-delivery'));
  const normalized = normalizeGitHubEvent(headers.get('x-github-event'), raw);
  if (normalized.repositoryId !== c.repositoryId)
    throw new HttpError(403, 'Repository is not authorized for this connection');
  const payloadHash = digest(raw.toString('base64'));
  return db.$transaction(
    async (tx) => {
      // Serialize project archive/disconnect against receipt acceptance; no task writes.
      const projects = await tx.$queryRaw<
        { archivedAt: Date | null }[]
      >`SELECT "archivedAt" FROM "Project" WHERE "id" = ${c.projectId} AND "workspaceId" = ${c.workspaceId} FOR UPDATE`;
      if (!projects.length || projects[0].archivedAt)
        throw new HttpError(409, 'Project is unavailable');
      await tx.$queryRaw`SELECT "id" FROM "GitHubRepositoryConnection" WHERE "id" = ${id} FOR UPDATE`;
      const current = await tx.gitHubRepositoryConnection.findUnique({ where: { id } });
      if (!current || current.disconnectedAt)
        throw new HttpError(404, 'Repository connection not found');
      const receipt = await tx.gitHubWebhookDelivery.findUnique({
        where: { connectionId_deliveryId: { connectionId: id, deliveryId } },
      });
      if (receipt) {
        if (receipt.payloadHash !== payloadHash || receipt.event !== normalized.event)
          throw new HttpError(409, 'Delivery ID already used for different content');
        return { accepted: true, duplicate: true };
      }
      // GitHub signs body bytes, not delivery/event headers: an exact captured body
      // must not become new work merely because its delivery ID was changed.
      const samePayload = await tx.gitHubWebhookDelivery.findUnique({
        where: { connectionId_payloadHash: { connectionId: id, payloadHash } },
      });
      if (samePayload) {
        if (samePayload.event !== normalized.event)
          throw new HttpError(409, 'Payload already received with a different event type');
        return { accepted: true, duplicate: true };
      }
      await tx.gitHubWebhookDelivery.create({
        data: {
          connectionId: id,
          deliveryId,
          event: normalized.event,
          payloadHash,
          dataVersion: 2,
          automationVersion: 1,
          data: normalized.data as Prisma.InputJsonValue,
        },
      });
      return { accepted: true, duplicate: false };
    },
    { isolationLevel: 'ReadCommitted' },
  );
}

export { authorize as authorizeGitHubProject };
