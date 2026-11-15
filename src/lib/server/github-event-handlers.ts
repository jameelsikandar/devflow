import { z } from 'zod';
import { canonicalTaskReference } from '../task-reference';
export { extractTaskReferences } from '../task-reference';
import type { GitHubObjectKind } from '@prisma/client';

export class GitHubProcessingError extends Error {
  constructor(
    public code: string,
    public retryable = false,
    public retryAt: number | null = null,
  ) {
    super(code);
  }
}
const sha = z.string().regex(/^[a-f0-9]{40,64}$/i);
const refs = z
  .array(
    z
      .string()
      .refine((r) => canonicalTaskReference(r) !== null, 'Invalid task reference')
      .transform((r) => canonicalTaskReference(r)!),
  )
  .max(100);
const number = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const base = {
  repositoryId: z.string().regex(/^[1-9]\d*$/),
  sourceUpdatedAt: z.string().datetime().optional(),
};
const schemas = {
  ping: z.object(base),
  push: z.object({
    ...base,
    ref: z.string().max(1024),
    before: sha,
    after: sha,
    deleted: z.boolean(),
    commitCount: z.number().int().nonnegative(),
    commitsTruncated: z.boolean(),
    commits: z.array(z.object({ sha, taskRefs: refs })).max(300),
  }),
  pull_request: z.object({
    ...base,
    action: z.string().max(64),
    number,
    state: z.enum(['open', 'closed']),
    merged: z.boolean(),
    mergeCommitSha: sha.nullable(),
    taskRefs: refs,
  }),
  issues: z.object({
    ...base,
    action: z.string().max(64),
    number,
    state: z.enum(['open', 'closed']),
    taskRefs: refs,
  }),
  workflow_run: z.object({
    ...base,
    action: z.string().max(64),
    runId: number,
    taskRefs: refs.default([]),
    sha,
    status: z.string().max(40),
    conclusion: z.string().max(40).nullable(),
  }),
};
export function parseStoredGitHubEvent(event: string, dataVersion: number, data: unknown) {
  if (![1, 2].includes(dataVersion)) throw new GitHubProcessingError('UNSUPPORTED_DATA_VERSION');
  const schema = schemas[event as keyof typeof schemas];
  if (!schema) throw new GitHubProcessingError('UNSUPPORTED_EVENT');
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new GitHubProcessingError('INVALID_STORED_EVENT');
  return parsed.data;
}
export interface GitHubFact {
  kind: GitHubObjectKind;
  key: string;
  data: Record<string, unknown>;
  projectionData?: Record<string, unknown>;
  refs: string[];
  sourceUpdatedAt: string | null;
  incomplete: boolean;
}
export function githubEventFacts(event: string, version: number, input: unknown): GitHubFact[] {
  const parsed = parseStoredGitHubEvent(event, version, input);
  if (event === 'ping') return [];
  if (event === 'push') {
    const data = schemas.push.parse(parsed);
    return data.commits.map((c) => ({
      kind: 'COMMIT',
      key: c.sha.toLowerCase(),
      data: {
        sha: c.sha.toLowerCase(),
        taskRefs: c.taskRefs,
        ref: data.ref,
        before: data.before,
        after: data.after,
        deleted: data.deleted,
        suppliedCommitCount: data.commitCount,
      },
      refs: c.taskRefs,
      sourceUpdatedAt: null,
      incomplete: data.commitsTruncated,
    }));
  }
  if (event === 'issues' || event === 'pull_request') {
    const data =
      event === 'issues' ? schemas.issues.parse(parsed) : schemas.pull_request.parse(parsed);
    return [
      {
        kind: event === 'issues' ? 'ISSUE' : 'PULL_REQUEST',
        key: String(data.number),
        data: { ...data },
        refs: data.taskRefs,
        sourceUpdatedAt: version === 2 ? (data.sourceUpdatedAt ?? null) : null,
        incomplete: false,
      },
    ];
  }
  const data = schemas.workflow_run.parse(parsed);
  return [
    {
      kind: 'WORKFLOW_RUN',
      key: String(data.runId),
      data: { ...data },
      refs: data.taskRefs,
      sourceUpdatedAt: version === 2 ? (data.sourceUpdatedAt ?? null) : null,
      incomplete: false,
    },
  ];
}
export function shouldAdvanceProjection(previous: Date | null, incoming: string | null) {
  return incoming !== null && (previous === null || +new Date(incoming) > +previous);
}
