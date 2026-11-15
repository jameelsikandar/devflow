import { expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { linkGitHubTasks, resolveGitHubTaskReferences } from '../src/lib/server/github-task-links';
it('resolves only authorized project/workspace tasks and preserves deduplicated provenance', async () => {
  const findMany = vi.fn().mockResolvedValue([{ id: 'task', number: 12 }]);
  const link = vi.fn();
  const evidence = vi.fn();
  const tx = {
    task: { findMany },
    gitHubTaskLink: { createMany: link },
    gitHubTaskLinkEvidence: { createMany: evidence },
  } as unknown as Prisma.TransactionClient;
  const scope = { workspaceId: 'w', projectId: 'p', repositoryId: '123' };
  const tasks = await resolveGitHubTaskReferences(tx, scope, [
    'DEV-12',
    'dev-12',
    'DEV-45',
    'DEV-9999999999',
  ]);
  expect([...tasks.keys()]).toEqual(['DEV-12']);
  expect(findMany.mock.calls[0][0].where).toEqual({
    projectId: 'p',
    project: { workspaceId: 'w', archivedAt: null },
    number: { in: [12, 45] },
  });
  await linkGitHubTasks(
    tx,
    scope,
    [{ objectId: 'o', observationId: 'observation', refs: ['DEV-12', 'dev-12', 'DEV-45'] }],
    tasks,
  );
  expect(link.mock.calls[0][0]).toEqual({
    data: [{ projectId: 'p', repositoryId: '123', objectId: 'o', taskId: 'task' }],
    skipDuplicates: true,
  });
  expect(evidence.mock.calls[0][0].data).toEqual([
    { objectId: 'o', taskId: 'task', observationId: 'observation' },
  ]);
});
