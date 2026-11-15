import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from './errors';
import { extractTaskReferences as taskRefs } from '../task-reference';

export const githubEvents = ['ping', 'push', 'pull_request', 'issues', 'workflow_run'] as const;
export const repositoryName = z
  .string()
  .max(201)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/)
  .refine((name) => !['.', '..'].includes(name.split('/')[1]), 'Invalid repository name');
export const repositoryCommand = z
  .object({ projectId: z.string().min(1).max(128), repository: repositoryName })
  .strict();
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sha = z.string().regex(/^[a-f0-9]{40,64}$/i);
const action = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z_]+$/);
/** Verify bytes BEFORE JSON decoding. No legacy SHA-1 or unsigned delivery fallback. */
export function verifyGitHubSignature(raw: Buffer, signature: string | null, secret: string) {
  if (!/^sha256=[a-f0-9]{64}$/.test(signature ?? '')) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature!.slice(7), 'hex'));
}

/** Discard sender profiles, emails, arbitrary URLs, bodies, diffs and hook config. */
export function normalizeGitHubEvent(event: string | null, raw: Buffer) {
  const kind = z.enum(githubEvents).safeParse(event);
  if (!kind.success) throw new HttpError(422, 'Unsupported GitHub event');
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid webhook JSON');
  }
  const base = z.object({ repository: z.object({ id }) }).parse(value);
  const repositoryId = String(base.repository.id);
  if (kind.data === 'ping') return { event: kind.data, repositoryId, data: { repositoryId } };
  if (kind.data === 'push') {
    const p = z
      .object({
        ref: z.string().min(1).max(1024),
        before: sha,
        after: sha,
        deleted: z.boolean().default(false),
        commits: z.array(z.object({ id: sha, message: z.string().max(100000) })).max(2048),
      })
      .parse(value);
    return {
      event: kind.data,
      repositoryId,
      data: {
        repositoryId,
        ref: p.ref,
        before: p.before,
        after: p.after,
        deleted: p.deleted,
        commitCount: p.commits.length,
        commitsTruncated: p.commits.length > 100,
        commits: p.commits.slice(0, 100).map((c) => ({ sha: c.id, taskRefs: taskRefs(c.message) })),
      },
    };
  }
  if (kind.data === 'pull_request' || kind.data === 'issues') {
    const entity = z.object({
      number: id,
      title: z.string().max(10000),
      body: z.string().max(1000000).nullable().optional(),
      state: z.enum(['open', 'closed']),
      merged: z.boolean().optional(),
      merge_commit_sha: sha.nullable().optional(),
      updated_at: z.string().datetime().optional(),
    });
    const p = z
      .object({ action, pull_request: entity.optional(), issue: entity.optional() })
      .parse(value);
    const record = kind.data === 'pull_request' ? p.pull_request : p.issue;
    if (!record) throw new HttpError(400, 'Missing GitHub event record');
    return {
      event: kind.data,
      repositoryId,
      data: {
        repositoryId,
        action: p.action,
        number: record.number,
        state: record.state,
        ...(kind.data === 'pull_request'
          ? { merged: record.merged ?? false, mergeCommitSha: record.merge_commit_sha ?? null }
          : {}),
        taskRefs: taskRefs(`${record.title}\n${record.body ?? ''}`),
        ...(record.updated_at ? { sourceUpdatedAt: record.updated_at } : {}),
      },
    };
  }
  const p = z
    .object({
      action,
      workflow_run: z.object({
        id,
        head_sha: sha,
        status: z.string().max(40),
        conclusion: z.string().max(40).nullable(),
        updated_at: z.string().datetime().optional(),
        head_commit: z
          .object({ message: z.string().max(100000) })
          .nullable()
          .optional(),
      }),
    })
    .parse(value);
  return {
    event: kind.data,
    repositoryId,
    data: {
      repositoryId,
      action: p.action,
      runId: p.workflow_run.id,
      sha: p.workflow_run.head_sha,
      status: p.workflow_run.status,
      conclusion: p.workflow_run.conclusion,
      ...(p.workflow_run.head_commit
        ? { taskRefs: taskRefs(p.workflow_run.head_commit.message) }
        : {}),
      ...(p.workflow_run.updated_at ? { sourceUpdatedAt: p.workflow_run.updated_at } : {}),
    },
  };
}
