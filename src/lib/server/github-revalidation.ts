import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { db } from './db';
import { rateLimit } from './auth';
import { HttpError } from './errors';
import { decrypt, digest } from './crypto';
import { repositoryName } from './github-webhook';
import { authorizeGitHubProject } from './github-repositories';
import { githubRequest, GitHubHttpError } from './github-request';
import {
  revalidationMessages,
  type RevalidationCode,
  type RevalidationResult,
} from '../github-revalidation';
import type { WorkspaceActor } from './tasks';
async function context(tx: Prisma.TransactionClient, actor: WorkspaceActor, id: string) {
  const c = await tx.gitHubRepositoryConnection.findFirst({
    where: { id, workspaceId: actor.workspaceId },
    select: {
      id: true,
      workspaceId: true,
      projectId: true,
      repositoryId: true,
      repositoryFullName: true,
      disconnectedAt: true,
      enrichmentUserId: true,
      enrichmentAuthorizedAt: true,
      enrichmentVersion: true,
    },
  });
  if (!c) throw new HttpError(404, 'Repository connection not found');
  const project = await authorizeGitHubProject(tx, actor, c.projectId);
  // Never load a different member's token, even for a workspace administrator.
  const ownGrant =
    (!c.enrichmentUserId && !c.enrichmentAuthorizedAt) ||
    (c.enrichmentUserId === actor.userId && !!c.enrichmentAuthorizedAt);
  const account =
    ownGrant && !c.disconnectedAt && !project.archivedAt
      ? await tx.gitHubConnection.findUnique({
          where: { userId: actor.userId },
          select: { id: true, login: true, encryptedToken: true },
        })
      : null;
  return { c, archivedAt: project.archivedAt, account };
}
type Context = Awaited<ReturnType<typeof context>>;
function fingerprint(s: Context) {
  return digest(JSON.stringify({ c: s.c, archivedAt: s.archivedAt, account: s.account }));
}
function localOutcome(s: Context, userId: string): RevalidationCode | null {
  if (s.c.disconnectedAt) return 'CONNECTION_DISCONNECTED';
  if (s.archivedAt) return 'PROJECT_ARCHIVED';
  if (!!s.c.enrichmentUserId !== !!s.c.enrichmentAuthorizedAt)
    return 'ENRICHMENT_AUTHORIZATION_INCOMPLETE';
  if (s.c.enrichmentUserId && s.c.enrichmentUserId !== userId) return 'OTHER_ENRICHMENT_AUTHORIZER';
  if (!s.account) return 'OAUTH_ACCOUNT_MISSING';
  return null;
}
/** Explicit diagnostic only. External GETs stay outside database transactions. */
export async function revalidateGitHubConnection(
  actor: WorkspaceActor,
  connectionId: string,
): Promise<RevalidationResult> {
  connectionId = z.string().min(1).max(128).parse(connectionId);
  const load = () =>
    db.$transaction((tx) => context(tx, actor, connectionId), { isolationLevel: 'RepeatableRead' });
  const source = await load();
  const result = (
    code: RevalidationCode,
    retryAt: number | null = null,
    retrySource: RevalidationResult['retrySource'] = null,
  ): RevalidationResult => ({
    scope: { workspaceId: actor.workspaceId, projectId: source.c.projectId, connectionId },
    checkedAt: new Date().toISOString(),
    authorizationSource:
      source.c.enrichmentUserId || source.c.enrichmentAuthorizedAt
        ? 'CONFIGURED_ENRICHMENT'
        : source.account
          ? 'REQUESTING_ADMIN'
          : 'NONE',
    state: revalidationMessages[code].state,
    code,
    retryAt: retryAt === null ? null : new Date(retryAt).toISOString(),
    retrySource,
  });
  const initial = localOutcome(source, actor.userId);
  if (initial) return result(initial);
  const repository = repositoryName.safeParse(source.c.repositoryFullName);
  if (!repository.success || !/^[1-9]\d*$/.test(source.c.repositoryId))
    return result('INVALID_CONNECTION_IDENTITY');
  let token: string;
  try {
    token = decrypt(source.account!.encryptedToken);
  } catch {
    return result('CREDENTIALS_UNREADABLE');
  }
  await rateLimit(
    `github-revalidation:${actor.workspaceId}:${connectionId}:${actor.userId}`,
    3,
    60000,
  );
  const key = `github-cooldown:${digest(source.account!.encryptedToken)}`;
  const unchanged = async () => {
    const current = await load();
    if (current.c.disconnectedAt) return 'CONNECTION_DISCONNECTED' as const;
    if (current.archivedAt) return 'PROJECT_ARCHIVED' as const;
    return fingerprint(current) === fingerprint(source) ? null : ('CONTEXT_CHANGED' as const);
  };
  const finish = async (
    code: RevalidationCode,
    retryAt: number | null = null,
    retrySource: RevalidationResult['retrySource'] = null,
  ) => {
    const changed = await unchanged();
    return changed ? result(changed) : result(code, retryAt, retrySource);
  };
  const cooldown = await db.rateLimit.findUnique({ where: { key }, select: { expiresAt: true } });
  if (cooldown && +cooldown.expiresAt > Date.now())
    return finish('AUTHORIZATION_COOLDOWN', +cooldown.expiresAt, 'LOCAL_COOLDOWN');
  let phase: 'account' | 'repository' = 'account';
  try {
    let changed = await unchanged();
    if (changed) return result(changed);
    const profile = z
      .object({
        id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        login: z.string().min(1).max(100),
      })
      .safeParse(await githubRequest('/user', token));
    if (!profile.success) return finish('GITHUB_RESPONSE_UNRECOGNIZED');
    if (profile.data.login.toLowerCase() !== source.account!.login.toLowerCase())
      return finish('ACCOUNT_IDENTITY_UNCONFIRMED');
    changed = await unchanged();
    if (changed) return result(changed);
    phase = 'repository';
    const repo = z
      .object({
        id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        full_name: repositoryName,
        archived: z.boolean(),
        disabled: z.boolean().optional(),
        permissions: z.object({ admin: z.boolean().optional() }).optional(),
      })
      .safeParse(await githubRequest(`/repos/${repository.data}`, token));
    if (!repo.success) return finish('GITHUB_RESPONSE_UNRECOGNIZED');
    if (
      String(repo.data.id) !== source.c.repositoryId ||
      repo.data.full_name.toLowerCase() !== repository.data.toLowerCase()
    )
      return finish('REPOSITORY_IDENTITY_CHANGED');
    if (repo.data.archived || repo.data.disabled) return finish('REPOSITORY_INACTIVE');
    if (repo.data.permissions?.admin === false) return finish('REPOSITORY_PERMISSION_INSUFFICIENT');
    if (repo.data.permissions?.admin !== true) return finish('PERMISSION_EVIDENCE_MISSING');
    return finish('ACCESS_VALID');
  } catch (error) {
    if (!(error instanceof GitHubHttpError)) throw error;
    if (error.code === 'GITHUB_RATE_LIMITED') {
      // error.retryAt may include worker fallback timing. Use only observed headers.
      const observed = error.rateLimit.retryAt ?? null;
      const retryAt = observed !== null && observed > Date.now() ? observed : null;
      if (retryAt !== null)
        await db.$executeRaw`INSERT INTO "RateLimit" ("key","count","expiresAt") VALUES (${key},0,${new Date(retryAt)}) ON CONFLICT ("key") DO UPDATE SET "expiresAt"=GREATEST("RateLimit"."expiresAt",EXCLUDED."expiresAt")`;
      return finish('GITHUB_RATE_LIMITED', retryAt, retryAt === null ? null : 'PROVIDER_HEADER');
    }
    if (error.upstreamStatus === 401) return finish('AUTHORIZATION_REJECTED');
    if (phase === 'repository' && error.upstreamStatus === 404)
      return finish('REPOSITORY_NOT_VISIBLE');
    if (phase === 'repository' && error.upstreamStatus === 403)
      return finish('REPOSITORY_ACCESS_BLOCKED');
    return finish(
      error.code === 'GITHUB_INVALID_RESPONSE'
        ? 'GITHUB_RESPONSE_UNRECOGNIZED'
        : 'GITHUB_UNAVAILABLE',
    );
  }
}
