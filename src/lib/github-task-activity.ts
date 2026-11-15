export type GitHubTaskObjectKind = 'COMMIT' | 'PULL_REQUEST' | 'ISSUE' | 'WORKFLOW_RUN';
export const githubTaskObjectLabels: Record<GitHubTaskObjectKind, string> = {
  COMMIT: 'Commit',
  PULL_REQUEST: 'Pull request',
  ISSUE: 'Issue',
  WORKFLOW_RUN: 'Workflow run',
};
/** Construct links from known identifiers only; never render a payload-supplied URL. */
export function githubTaskObjectURL(
  repository: string | null,
  kind: GitHubTaskObjectKind,
  key: string,
): string | null {
  if (!repository || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/.test(repository))
    return null;
  const [owner, name] = repository.split('/');
  if (name === '.' || name === '..') return null;
  const root = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  if (kind === 'COMMIT')
    return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(key) ? `${root}/commit/${key}` : null;
  if (!/^[1-9]\d{0,15}$/.test(key) || !Number.isSafeInteger(Number(key))) return null;
  const path =
    kind === 'PULL_REQUEST'
      ? 'pull'
      : kind === 'ISSUE'
        ? 'issues'
        : kind === 'WORKFLOW_RUN'
          ? 'actions/runs'
          : null;
  return path ? `${root}/${path}/${key}` : null;
}
export interface TaskGitHubActivityItem {
  id: string;
  kind: GitHubTaskObjectKind;
  key: string;
  repositoryName: string | null;
  connection: 'connected' | 'disconnected' | 'unavailable';
  url: string | null;
  status: string | null;
  statusSource: 'source' | 'observation';
  updatedAt: string | null;
  incomplete: boolean;
}
export interface TaskGitHubActivityPage {
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  items: TaskGitHubActivityItem[];
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
/** Stored observations are not claimed to be live GitHub state. */
export function githubTaskStatus(kind: GitHubTaskObjectKind, input: unknown): string | null {
  const data = record(input);
  if (kind === 'COMMIT') return null;
  if (kind === 'PULL_REQUEST' && data.merged === true) return 'Merged';
  if (kind === 'PULL_REQUEST' || kind === 'ISSUE')
    return data.state === 'open' ? 'Open' : data.state === 'closed' ? 'Closed' : null;
  const names: Record<string, string> = {
    queued: 'Queued',
    in_progress: 'In progress',
    completed: 'Completed',
    waiting: 'Waiting',
    requested: 'Requested',
    pending: 'Pending',
    success: 'Success',
    failure: 'Failed',
    cancelled: 'Cancelled',
    skipped: 'Skipped',
    timed_out: 'Timed out',
    action_required: 'Action required',
    neutral: 'Neutral',
    startup_failure: 'Startup failure',
    stale: 'Stale',
  };
  const status =
    typeof data.status === 'string' && Object.hasOwn(names, data.status)
      ? names[data.status]
      : undefined;
  const conclusion =
    typeof data.conclusion === 'string' && Object.hasOwn(names, data.conclusion)
      ? names[data.conclusion]
      : undefined;
  return status ? `${status}${conclusion ? ` · ${conclusion}` : ''}` : null;
}
export function githubObservationData(value: unknown) {
  const data = record(value);
  return data.webhook !== undefined ? record(data.webhook) : data;
}
