import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  transaction: vi.fn(),
  authorize: vi.fn(),
  rows: vi.fn(),
  count: vi.fn(),
}));
vi.mock('../src/lib/server/db', () => ({ db: { $transaction: m.transaction } }));
vi.mock('../src/lib/server/github-repositories', () => ({ authorizeGitHubProject: m.authorize }));
import {
  listGitHubWorkflowExecutions,
  executionStateFilter,
} from '../src/lib/server/github-automation-monitoring';
const actor = { workspaceId: 'w', userId: 'admin', name: 'Owner' };
beforeEach(() => {
  vi.resetAllMocks();
  m.authorize.mockResolvedValue({});
  m.count.mockResolvedValue(1);
  m.rows.mockResolvedValue([
    {
      id: 'e',
      state: 'APPLIED',
      reason: 'STATUS_CHANGED',
      attempts: 1,
      createdAt: new Date(),
      completedAt: new Date(),
      ruleVersion: 2,
      ruleSnapshot: { name: 'Merge', automationAuthorizedById: 'private-actor' },
      taskSnapshot: { reference: 'DEV-002', title: 'Work' },
      taskId: 't',
      expectedTaskVersion: 0,
      previousStatus: 'TODO',
      targetStatus: 'DONE',
      object: { key: '1' },
      connection: { repositoryFullName: 'owner/repo', disconnectedAt: null },
    },
  ]);
  m.transaction.mockImplementation((fn) =>
    fn({ gitHubWorkflowExecution: { findMany: m.rows, count: m.count } }),
  );
});
it('authorizes administrator reads before accessing execution records', async () => {
  m.authorize.mockRejectedValue({ status: 403 });
  await expect(listGitHubWorkflowExecutions(actor, 'p')).rejects.toMatchObject({ status: 403 });
  expect(m.rows).not.toHaveBeenCalled();
});
it('scopes pagination/state filters and returns only sanitized history and constructed source links', async () => {
  const result = await listGitHubWorkflowExecutions(actor, 'p', 0, 'APPLIED');
  expect(result).toMatchObject({
    total: 1,
    hasMore: false,
    items: [
      {
        ruleName: 'Merge',
        taskReference: 'DEV-002',
        prUrl: 'https://github.com/owner/repo/pull/1',
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain('private-actor');
  expect(m.rows.mock.calls[0][0]).toMatchObject({
    where: { workspaceId: 'w', projectId: 'p', state: 'APPLIED' },
    take: 25,
    skip: 0,
  });
  expect(m.rows.mock.calls[0][0].select.connection.select).toEqual({
    repositoryFullName: true,
    disconnectedAt: true,
  });
  expect(executionStateFilter.safeParse('EXECUTE').success).toBe(false);
});
