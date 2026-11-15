import { z } from 'zod';
import { db } from './db';
import { decrypt, digest } from './crypto';
import { HttpError } from './errors';
import { githubRequest, GitHubHttpError } from './github-request';
import { repositoryName } from './github-webhook';
import { authorizeGitHubProject } from './github-repositories';
import { enrichmentStillAuthorized } from './github-enrichment';
import { extractTaskReferences } from '../task-reference';
import { linkGitHubTasks, resolveGitHubTaskReferences } from './github-task-links';
import type { WorkspaceActor } from './tasks';

/** Explicit repair of links only. Never requeues a receipt or rewrites an observation. */
export async function reconcileGitHubCommit(
  actor: WorkspaceActor,
  connectionId: string,
  prefix: string,
) {
  const key = z
    .string()
    .regex(/^[a-f0-9]{7,64}$/i)
    .parse(prefix)
    .toLowerCase();
  const source = await db.$transaction(async (tx) => {
    const c = await tx.gitHubRepositoryConnection.findFirst({
      where: { id: connectionId, workspaceId: actor.workspaceId },
    });
    if (!c) throw new HttpError(404, 'Repository connection not found');
    const project = await authorizeGitHubProject(tx, actor, c.projectId);
    if (c.disconnectedAt || project.archivedAt)
      throw new HttpError(409, 'Connection or project is unavailable');
    if (c.enrichmentUserId !== actor.userId || !c.enrichmentAuthorizedAt)
      throw new HttpError(
        403,
        'Explicitly authorize enrichment with your own GitHub account first',
      );
    const objects = await tx.gitHubObject.findMany({
      where: {
        workspaceId: actor.workspaceId,
        projectId: c.projectId,
        repositoryId: c.repositoryId,
        kind: 'COMMIT',
        key: { startsWith: key },
      },
      take: 2,
    });
    if (objects.length !== 1)
      throw new HttpError(
        objects.length ? 409 : 404,
        objects.length
          ? 'Ambiguous commit prefix; use its full SHA'
          : 'Commit not found in this project/repository',
      );
    const object = objects[0];
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(object.key))
      throw new HttpError(409, 'Stored commit SHA is invalid');
    const observation = await tx.gitHubObservation.findFirst({
      where: { objectId: object.id, connectionId: c.id, delivery: { state: 'PROCESSED' } },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    });
    if (!observation)
      throw new HttpError(409, 'No processed source observation exists for this connection');
    const account = await tx.gitHubConnection.findUnique({ where: { userId: actor.userId } });
    if (!account) throw new HttpError(409, 'Reconnect your GitHub account');
    return { c, object, observation, encryptedToken: account.encryptedToken };
  });
  const auth = {
    userId: actor.userId,
    version: source.c.enrichmentVersion,
    credentialHash: digest(source.encryptedToken),
  };
  const cooldownKey = `github-cooldown:${auth.credentialHash}`;
  const get = async (path: string) => {
    const c = await db.gitHubRepositoryConnection.findUnique({ where: { id: connectionId } });
    if (!c || c.disconnectedAt || !(await enrichmentStillAuthorized(db, c, auth)))
      throw new HttpError(403, 'Enrichment authorization changed');
    const cooldown = await db.rateLimit.findUnique({ where: { key: cooldownKey } });
    if (cooldown && +cooldown.expiresAt > Date.now())
      throw new GitHubHttpError('GITHUB_RATE_LIMITED', 429, true, +cooldown.expiresAt);
    try {
      return await githubRequest(path, decrypt(source.encryptedToken));
    } catch (error) {
      if (error instanceof GitHubHttpError && error.retryAt !== null) {
        const until = new Date(error.retryAt);
        await db.$executeRaw`INSERT INTO "RateLimit" ("key", "count", "expiresAt") VALUES (${cooldownKey}, 0, ${until}) ON CONFLICT ("key") DO UPDATE SET "expiresAt" = GREATEST("RateLimit"."expiresAt", EXCLUDED."expiresAt")`;
      }
      throw error;
    }
  };
  const name = repositoryName.parse(source.c.repositoryFullName);
  const verifyRepo = async () => {
    const parsed = z
      .object({
        id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        full_name: repositoryName,
        archived: z.boolean(),
        disabled: z.boolean().optional(),
        permissions: z.object({ admin: z.literal(true) }),
      })
      .safeParse(await get(`/repos/${name}`));
    if (!parsed.success)
      throw new HttpError(403, 'GitHub repository administrator access is required');
    const repo = parsed.data;
    if (
      String(repo.id) !== source.c.repositoryId ||
      repo.full_name.toLowerCase() !== name.toLowerCase() ||
      repo.archived ||
      repo.disabled
    )
      throw new HttpError(409, 'Repository identity or permissions changed');
  };
  await verifyRepo();
  const commit = z
    .object({ sha: z.string(), commit: z.object({ message: z.string().max(100000) }) })
    .parse(await get(`/repos/${name}/commits/${source.object.key}`));
  if (commit.sha.toLowerCase() !== source.object.key)
    throw new HttpError(409, 'GitHub returned a different commit');
  const references = extractTaskReferences(commit.commit.message);
  await verifyRepo();
  return db.$transaction(
    async (tx) => {
      const projects = await tx.$queryRaw<
        { archivedAt: Date | null }[]
      >`SELECT "archivedAt" FROM "Project" WHERE "id" = ${source.c.projectId} AND "workspaceId" = ${actor.workspaceId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "GitHubRepositoryConnection" WHERE "id" = ${connectionId} FOR UPDATE`;
      await authorizeGitHubProject(tx, actor, source.c.projectId);
      const c = await tx.gitHubRepositoryConnection.findUnique({ where: { id: connectionId } });
      if (
        !projects.length ||
        projects[0].archivedAt ||
        !c ||
        c.disconnectedAt ||
        !(await enrichmentStillAuthorized(tx, c, auth))
      )
        throw new HttpError(409, 'Connection, project or enrichment authorization changed');
      const observation = await tx.gitHubObservation.findFirst({
        where: {
          id: source.observation.id,
          objectId: source.object.id,
          connectionId,
          delivery: { state: 'PROCESSED' },
        },
      });
      if (!observation) throw new HttpError(409, 'Source observation is no longer available');
      const tasks = await resolveGitHubTaskReferences(tx, c, references);
      const before = await tx.gitHubTaskLink.count({ where: { objectId: source.object.id } });
      const evidenceBefore = await tx.gitHubTaskLinkEvidence.count({
        where: { objectId: source.object.id, observationId: observation.id },
      });
      await linkGitHubTasks(
        tx,
        c,
        [{ objectId: source.object.id, observationId: observation.id, refs: references }],
        tasks,
      );
      const linksCreated =
        (await tx.gitHubTaskLink.count({ where: { objectId: source.object.id } })) - before;
      const evidenceCreated =
        (await tx.gitHubTaskLinkEvidence.count({
          where: { objectId: source.object.id, observationId: observation.id },
        })) - evidenceBefore;
      // This is the human's explicit repair request, not an automated GitHub action.
      // Preserve API-derived references separately from the immutable original event.
      if (linksCreated || evidenceCreated)
        await tx.taskActivity.create({
          data: {
            workspaceId: actor.workspaceId,
            actorId: actor.userId,
            message: `requested GitHub API commit reconciliation: ${source.object.key}; project ${c.projectId}; verified references ${references.join(', ') || 'none'}; source observation ${observation.id}`,
          },
        });
      return {
        sha: source.object.key,
        references,
        unresolvedRefs: references.filter((r) => !tasks.has(r)),
        linksCreated,
        evidenceCreated,
        observationId: observation.id,
      };
    },
    { isolationLevel: 'ReadCommitted' },
  );
}
