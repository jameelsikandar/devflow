import { z } from 'zod';
import type { Prisma, GitHubRepositoryConnection, GitHubWebhookDelivery } from '@prisma/client';
import { db } from './db';
import { decrypt, digest } from './crypto';
import { githubRequest, GitHubHttpError } from './github-request';
import { repositoryName } from './github-webhook';
import {
  extractTaskReferences,
  githubEventFacts,
  GitHubProcessingError,
  type GitHubFact,
} from './github-event-handlers';
const repoSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  full_name: repositoryName,
  archived: z.boolean(),
  disabled: z.boolean().optional(),
  permissions: z.object({ admin: z.literal(true) }),
});
function withEnrichmentProvenance(facts: GitHubFact[], local: GitHubFact[]) {
  const original = new Map(local.map((f) => [`${f.kind}:${f.key}`, f]));
  return facts.map((f) => {
    const source = original.get(`${f.kind}:${f.key}`);
    return {
      ...f,
      projectionData: f.data,
      data: {
        webhook: source?.data ?? null,
        enrichment: f.data,
        enrichedAt: new Date().toISOString(),
      },
      refs: [...new Set([...(source?.refs ?? []), ...f.refs])],
    };
  });
}
const sha = z.string().regex(/^[a-f0-9]{40,64}$/i);
export type EnrichmentSnapshot = { userId: string; version: number; credentialHash: string };
export async function enrichmentStillAuthorized(
  tx: Pick<Prisma.TransactionClient, 'workspaceMember' | 'gitHubConnection'>,
  c: GitHubRepositoryConnection,
  auth: EnrichmentSnapshot,
) {
  if (
    c.enrichmentUserId !== auth.userId ||
    c.enrichmentVersion !== auth.version ||
    !c.enrichmentAuthorizedAt
  )
    return false;
  const member = await tx.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: c.workspaceId, userId: auth.userId } },
  });
  const account = await tx.gitHubConnection.findUnique({ where: { userId: auth.userId } });
  return (
    !!member &&
    member.role !== 'MEMBER' &&
    !!account &&
    digest(account.encryptedToken) === auth.credentialHash
  );
}
export async function enrichGitHubEvent(
  delivery: GitHubWebhookDelivery,
  c: GitHubRepositoryConnection,
): Promise<{ facts: GitHubFact[]; code: string; auth?: EnrichmentSnapshot }> {
  const local = githubEventFacts(delivery.event, delivery.dataVersion, delivery.data);
  if (!local.length) return { facts: local, code: 'LOCAL_ONLY' };
  if (!c.enrichmentUserId || !c.enrichmentAuthorizedAt)
    return { facts: local, code: 'ENRICHMENT_NOT_AUTHORIZED' };
  const account = await db.gitHubConnection.findUnique({ where: { userId: c.enrichmentUserId } });
  if (!account) return { facts: local, code: 'GITHUB_CREDENTIALS_UNAVAILABLE' };
  const auth = {
    userId: c.enrichmentUserId,
    version: c.enrichmentVersion,
    credentialHash: digest(account.encryptedToken),
  };
  if (!(await enrichmentStillAuthorized(db, c, auth)))
    return { facts: local, code: 'ENRICHMENT_AUTH_CHANGED' };
  const key = `github-cooldown:${auth.credentialHash}`;
  const get = async (path: string) => {
    const current = await db.gitHubRepositoryConnection.findUnique({ where: { id: c.id } });
    if (!current || current.disconnectedAt || !(await enrichmentStillAuthorized(db, current, auth)))
      throw new GitHubProcessingError('ENRICHMENT_AUTH_CHANGED');
    const cooldown = await db.rateLimit.findUnique({ where: { key } });
    if (cooldown && +cooldown.expiresAt > Date.now())
      throw new GitHubProcessingError('GITHUB_RATE_LIMITED', true, +cooldown.expiresAt);
    try {
      return await githubRequest(path, decrypt(account.encryptedToken));
    } catch (error) {
      if (error instanceof GitHubHttpError && error.retryAt !== null) {
        try {
          const until = new Date(error.retryAt);
          await db.$executeRaw`INSERT INTO "RateLimit" ("key", "count", "expiresAt") VALUES (${key}, 0, ${until}) ON CONFLICT ("key") DO UPDATE SET "expiresAt" = GREATEST("RateLimit"."expiresAt", EXCLUDED."expiresAt")`;
        } catch {
          throw new GitHubProcessingError('COOLDOWN_PERSISTENCE_FAILURE', true, error.retryAt);
        }
      }
      throw error;
    }
  };
  try {
    const name = repositoryName.parse(c.repositoryFullName);
    const repo = repoSchema.safeParse(await get(`/repos/${name}`));
    if (
      !repo.success ||
      String(repo.data.id) !== c.repositoryId ||
      repo.data.full_name.toLowerCase() !== name.toLowerCase() ||
      repo.data.archived ||
      repo.data.disabled
    )
      return { facts: local, code: 'GITHUB_REPOSITORY_UNAVAILABLE' };
    const recheckRepository = async () => {
      const current = repoSchema.safeParse(await get(`/repos/${name}`));
      if (
        !current.success ||
        String(current.data.id) !== c.repositoryId ||
        current.data.full_name.toLowerCase() !== name.toLowerCase() ||
        current.data.archived ||
        current.data.disabled
      )
        throw new GitHubProcessingError('GITHUB_REPOSITORY_UNAVAILABLE');
    };
    const input = delivery.data as Record<string, unknown>;
    if (delivery.event === 'push') {
      if (!input.commitsTruncated) return { facts: local, code: 'VERIFIED_REPOSITORY', auth };
      const before = sha.parse(input.before);
      const after = sha.parse(input.after);
      if (/^0+$/.test(before) || /^0+$/.test(after))
        return { facts: local, code: 'COMPARE_UNAVAILABLE', auth };
      const commits = new Map(local.map((f) => [f.key, f]));
      let complete = false;
      for (let page = 1; page <= 3; page++) {
        const response = z
          .object({
            total_commits: z.number().int().nonnegative(),
            commits: z
              .array(z.object({ sha, commit: z.object({ message: z.string().max(100000) }) }))
              .max(100),
          })
          .parse(
            await get(`/repos/${name}/compare/${before}...${after}?per_page=100&page=${page}`),
          );
        for (const item of response.commits) {
          const refs = extractTaskReferences(item.commit.message);
          commits.set(item.sha.toLowerCase(), {
            kind: 'COMMIT',
            key: item.sha.toLowerCase(),
            refs,
            data: { sha: item.sha.toLowerCase(), taskRefs: refs, ref: input.ref, before, after },
            sourceUpdatedAt: null,
            incomplete: true,
          });
        }
        if (response.commits.length < 100 || page * 100 >= response.total_commits) {
          complete = true;
          break;
        }
      }
      await recheckRepository();
      return {
        facts: withEnrichmentProvenance(
          [...commits.values()]
            .slice(0, 300)
            .map((f) => ({ ...f, incomplete: !complete || commits.size > 300 })),
          local,
        ),
        code: complete && commits.size <= 300 ? 'ENRICHED' : 'ENRICHMENT_TRUNCATED',
        auth,
      };
    }
    const fact = local[0];
    const path =
      delivery.event === 'pull_request'
        ? `pulls/${fact.key}`
        : delivery.event === 'issues'
          ? `issues/${fact.key}`
          : `actions/runs/${fact.key}`;
    const record = z
      .object({
        updated_at: z.string().datetime(),
        head_commit: z
          .object({ message: z.string().max(100000) })
          .nullable()
          .optional(),
        number: z.number().int().optional(),
        id: z.number().int().optional(),
        title: z.string().max(10000).optional(),
        body: z.string().max(1000000).nullable().optional(),
        state: z.enum(['open', 'closed']).optional(),
        merged: z.boolean().optional(),
        merge_commit_sha: sha.nullable().optional(),
        head_sha: sha.optional(),
        status: z.string().max(40).optional(),
        conclusion: z.string().max(40).nullable().optional(),
      })
      .parse(await get(`/repos/${name}/${path}`));
    if (
      (delivery.event === 'workflow_run' ? String(record.id) : String(record.number)) !== fact.key
    )
      return { facts: local, code: 'GITHUB_OBJECT_IDENTITY_CHANGED' };
    const data =
      delivery.event === 'workflow_run'
        ? {
            repositoryId: c.repositoryId,
            runId: record.id,
            taskRefs: extractTaskReferences(record.head_commit?.message ?? ''),
            sha: record.head_sha,
            status: record.status,
            conclusion: record.conclusion,
            action: 'reconciled',
            sourceUpdatedAt: record.updated_at,
          }
        : {
            repositoryId: c.repositoryId,
            number: record.number,
            state: record.state,
            ...(delivery.event === 'pull_request'
              ? { merged: record.merged ?? false, mergeCommitSha: record.merge_commit_sha ?? null }
              : {}),
            taskRefs: extractTaskReferences(`${record.title ?? ''}\n${record.body ?? ''}`),
            action: 'reconciled',
            sourceUpdatedAt: record.updated_at,
          };
    await recheckRepository();
    const facts = githubEventFacts(delivery.event, 2, data);
    return { facts: withEnrichmentProvenance(facts, local), code: 'ENRICHED', auth };
  } catch (error) {
    if (error instanceof GitHubHttpError) {
      if (error.retryable) throw new GitHubProcessingError(error.code, true, error.retryAt);
      return { facts: local, code: error.code };
    }
    if (error instanceof GitHubProcessingError && error.retryable) throw error;
    return {
      facts: local,
      code: error instanceof GitHubProcessingError ? error.code : 'GITHUB_INVALID_RESPONSE',
    };
  }
}
