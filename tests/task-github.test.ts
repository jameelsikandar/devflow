import { beforeEach, expect, it, vi } from 'vitest';
import { githubTaskObjectURL, githubTaskStatus } from '../src/lib/github-task-activity';
const mocks = vi.hoisted(() => ({ tx: {} as Record<string, unknown>, transaction: vi.fn() }));
vi.mock('../src/lib/server/db', () => ({ db: { $transaction: mocks.transaction } }));
import { taskGitHubActivity } from '../src/lib/server/task-github';
const actor = { userId: 'member', workspaceId: 'workspace', name: 'Member' };
let member: ReturnType<typeof vi.fn>;
let task: ReturnType<typeof vi.fn>;
let links: ReturnType<typeof vi.fn>;
let connections: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetAllMocks();
  member = vi.fn().mockResolvedValue({ role: 'MEMBER' });
  task = vi.fn().mockResolvedValue({ id: 'task', projectId: 'project' });
  links = vi.fn().mockResolvedValue([
    {
      object: {
        id: 'object',
        repositoryId: '123',
        kind: 'COMMIT',
        key: '9023d37' + 'a'.repeat(33),
        currentData: { sha: 'private-irrelevant-fields' },
        sourceUpdatedAt: null,
        observations: [
          {
            data: { taskRefs: ['DEV-2'], sender: { email: 'private@example.com' } },
            incomplete: false,
            receivedAt: new Date('2026-11-14T12:00:00Z'),
          },
        ],
      },
    },
  ]);
  connections = vi.fn().mockResolvedValue([
    {
      repositoryId: '123',
      repositoryFullName: 'jameelsikandar/25-react-projects',
      disconnectedAt: null,
    },
  ]);
  Object.assign(mocks.tx, {
    workspaceMember: { findUnique: member },
    task: { findFirst: task },
    gitHubTaskLink: { count: async () => 1, findMany: links },
    gitHubRepositoryConnection: { findMany: connections },
  });
  mocks.transaction.mockImplementation((fn) => fn(mocks.tx));
});
it('returns only task-scoped presentation data and never selects tokens or webhook secrets', async () => {
  const result = await taskGitHubActivity(actor, 'task');
  expect(task.mock.calls[0][0].where).toEqual({
    id: 'task',
    project: { workspaceId: 'workspace' },
  });
  expect(links.mock.calls[0][0]).toMatchObject({
    where: {
      taskId: 'task',
      projectId: 'project',
      object: { workspaceId: 'workspace', projectId: 'project' },
    },
    take: 10,
    skip: 0,
  });
  expect(connections.mock.calls[0][0].select).toEqual({
    repositoryId: true,
    repositoryFullName: true,
    disconnectedAt: true,
  });
  expect(result.items[0]).toMatchObject({
    repositoryName: 'jameelsikandar/25-react-projects',
    connection: 'connected',
    status: null,
  });
  expect(result.items[0].url).toContain('/commit/9023d37');
  expect(JSON.stringify(result)).not.toContain('private');
  expect(JSON.stringify(result)).not.toContain('taskRefs');
});
it('rejects missing membership and foreign task IDs before reading GitHub data', async () => {
  member.mockResolvedValueOnce(null);
  await expect(taskGitHubActivity(actor, 'task')).rejects.toMatchObject({ status: 404 });
  expect(task).not.toHaveBeenCalled();
  task.mockResolvedValueOnce(null);
  await expect(taskGitHubActivity(actor, 'foreign')).rejects.toMatchObject({ status: 404 });
  expect(links).not.toHaveBeenCalled();
});
it('retains historical links when disconnected and suppresses links without repository metadata', async () => {
  connections.mockResolvedValueOnce([
    { repositoryId: '123', repositoryFullName: 'owner/repo', disconnectedAt: new Date() },
  ]);
  expect((await taskGitHubActivity(actor, 'task')).items[0]).toMatchObject({
    connection: 'disconnected',
    repositoryName: 'owner/repo',
  });
  connections.mockResolvedValueOnce([]);
  expect((await taskGitHubActivity(actor, 'task')).items[0]).toMatchObject({
    connection: 'unavailable',
    repositoryName: null,
    url: null,
  });
});
it('constructs safe GitHub links for every object kind and refuses unsafe identifiers/protocols', () => {
  expect(githubTaskObjectURL('owner/repo', 'PULL_REQUEST', '7')).toBe(
    'https://github.com/owner/repo/pull/7',
  );
  expect(githubTaskObjectURL('owner/repo', 'ISSUE', '8')).toBe(
    'https://github.com/owner/repo/issues/8',
  );
  expect(githubTaskObjectURL('owner/repo', 'WORKFLOW_RUN', '9')).toBe(
    'https://github.com/owner/repo/actions/runs/9',
  );
  for (const name of [
    'javascript:alert(1)',
    'https://evil.example/a/b',
    '../repo',
    'owner/..',
    'owner/repo#evil',
  ])
    expect(githubTaskObjectURL(name, 'COMMIT', 'a'.repeat(40))).toBeNull();
  expect(githubTaskObjectURL('owner/repo', 'ISSUE', '../secret')).toBeNull();
  expect(githubTaskObjectURL('owner/repo', 'COMMIT', 'javascript:alert(1)')).toBeNull();
});
it('formats only known stored statuses without inventing current state', () => {
  expect(githubTaskStatus('PULL_REQUEST', { merged: true, state: 'closed' })).toBe('Merged');
  expect(githubTaskStatus('ISSUE', { state: 'open' })).toBe('Open');
  expect(githubTaskStatus('WORKFLOW_RUN', { status: 'completed', conclusion: 'success' })).toBe(
    'Completed · Success',
  );
  expect(githubTaskStatus('WORKFLOW_RUN', { status: '__proto__' })).toBeNull();
  expect(githubTaskStatus('COMMIT', { state: 'closed' })).toBeNull();
});
