import { z } from 'zod';
import type { GitHubDeliveryState, Prisma } from '@prisma/client';
import type { WorkspaceActor } from './tasks';
import { db } from './db';
import { HttpError } from './errors';
import { authorizeGitHubProject, verifyRepositoryAccess } from './github-repositories';
export const processingFilter = z
  .enum(['PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'CANCELLED'])
  .optional();
export const pageOffset = z.coerce.number().int().min(0).max(1000000).default(0);
async function connection(tx: Prisma.TransactionClient, actor: WorkspaceActor, id: string) {
  const c = await tx.gitHubRepositoryConnection.findFirst({
    where: { id, workspaceId: actor.workspaceId },
  });
  if (!c) throw new HttpError(404, 'Repository connection not found');
  await authorizeGitHubProject(tx, actor, c.projectId);
  return c;
}
export async function githubProcessingStatus(
  actor: WorkspaceActor,
  id: string,
  state?: GitHubDeliveryState,
  offset = 0,
) {
  return db.$transaction(async (tx) => {
    const c = await connection(tx, actor, id);
    const where = { connectionId: id, ...(state ? { state } : {}) };
    const [counts, total, items] = await Promise.all([
      tx.gitHubWebhookDelivery.groupBy({
        by: ['state'],
        where: { connectionId: id },
        _count: { _all: true },
      }),
      tx.gitHubWebhookDelivery.count({ where }),
      tx.gitHubWebhookDelivery.findMany({
        where,
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        skip: offset,
        take: 25,
        select: {
          id: true,
          deliveryId: true,
          event: true,
          state: true,
          attempts: true,
          availableAt: true,
          leaseExpiresAt: true,
          deadLetteredAt: true,
          dataVersion: true,
          errorCode: true,
          receivedAt: true,
          processedAt: true,
        },
      }),
    ]);
    return {
      counts: Object.fromEntries(counts.map((r) => [r.state, r._count._all])),
      total,
      offset,
      limit: 25,
      hasMore: offset + items.length < total,
      items,
      disconnected: !!c.disconnectedAt,
      enrichmentEnabled: !!c.enrichmentUserId && !!c.enrichmentAuthorizedAt,
    };
  });
}
export async function githubProjectActivity(actor: WorkspaceActor, projectId: string, offset = 0) {
  return db.$transaction(async (tx) => {
    await authorizeGitHubProject(tx, actor, projectId, false);
    const where = { workspaceId: actor.workspaceId, projectId };
    const [total, items] = await Promise.all([
      tx.gitHubObject.count({ where }),
      tx.gitHubObject.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: offset,
        take: 25,
        select: {
          id: true,
          kind: true,
          key: true,
          repositoryId: true,
          currentData: true,
          sourceUpdatedAt: true,
          observations: {
            orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
            take: 3,
            select: {
              id: true,
              data: true,
              unresolvedRefs: true,
              incomplete: true,
              enrichmentCode: true,
              receivedAt: true,
            },
          },
          links: { select: { task: { select: { id: true, number: true, title: true } } } },
        },
      }),
    ]);
    return { total, offset, limit: 25, hasMore: offset + items.length < total, items };
  });
}
export async function retryGitHubDelivery(actor: WorkspaceActor, id: string, deliveryId: string) {
  return db.$transaction(
    async (tx) => {
      const initial = await connection(tx, actor, id);
      const projects = await tx.$queryRaw<
        { archivedAt: Date | null }[]
      >`SELECT "archivedAt" FROM "Project" WHERE "id" = ${initial.projectId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "GitHubRepositoryConnection" WHERE "id" = ${id} FOR UPDATE`;
      const current = await connection(tx, actor, id);
      if (!projects.length || projects[0].archivedAt || current.disconnectedAt)
        throw new HttpError(409, 'Connection or project is unavailable');
      const changed = await tx.gitHubWebhookDelivery.updateMany({
        where: { id: deliveryId, connectionId: id, state: 'FAILED' },
        data: {
          state: 'PENDING',
          attempts: 0,
          availableAt: new Date(),
          deadLetteredAt: null,
          errorCode: null,
          leaseToken: null,
          leaseExpiresAt: null,
          lockedAt: null,
        },
      });
      if (!changed.count) throw new HttpError(409, 'Only failed deliveries can be retried');
      await tx.taskActivity.create({
        data: {
          workspaceId: actor.workspaceId,
          actorId: actor.userId,
          message: 'requested GitHub delivery retry',
        },
      });
      return { ok: true };
    },
    { isolationLevel: 'ReadCommitted' },
  );
}
export async function setGitHubEnrichment(actor: WorkspaceActor, id: string, value: unknown) {
  const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(value);
  const initial = await db.$transaction((tx) => connection(tx, actor, id));
  if (enabled) {
    const repo = await verifyRepositoryAccess(actor.userId, initial.repositoryFullName);
    if (repo.id !== initial.repositoryId) throw new HttpError(409, 'Repository identity changed');
  }
  return db.$transaction(
    async (tx) => {
      const projects = await tx.$queryRaw<
        { archivedAt: Date | null }[]
      >`SELECT "archivedAt" FROM "Project" WHERE "id" = ${initial.projectId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "GitHubRepositoryConnection" WHERE "id" = ${id} FOR UPDATE`;
      const current = await connection(tx, actor, id);
      if (current.disconnectedAt || !projects.length || (enabled && projects[0].archivedAt))
        throw new HttpError(409, 'Connection or project is unavailable');
      await tx.gitHubRepositoryConnection.update({
        where: { id },
        data: {
          enrichmentUserId: enabled ? actor.userId : null,
          enrichmentAuthorizedAt: enabled ? new Date() : null,
          enrichmentVersion: { increment: 1 },
        },
      });
      await tx.taskActivity.create({
        data: {
          workspaceId: actor.workspaceId,
          actorId: actor.userId,
          message: enabled
            ? 'authorized GitHub enrichment with their OAuth account'
            : 'disabled GitHub enrichment',
        },
      });
      return { enabled };
    },
    { isolationLevel: 'ReadCommitted' },
  );
}
