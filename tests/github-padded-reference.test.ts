import { expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { normalizeGitHubEvent } from '../src/lib/server/github-webhook';
import { githubEventFacts } from '../src/lib/server/github-event-handlers';
import { canonicalTaskReference, extractTaskReferences } from '../src/lib/task-reference';
import { resolveGitHubTaskReferences, linkGitHubTasks } from '../src/lib/server/github-task-links';
const message = 'test: verify DevFlow task linking DEV-002';
const sha = '9023d37' + 'a'.repeat(33); // Fixture SHA, not a claim about the live full SHA.
it('extracts the exact live-reported message and links padded DEV-002 to Task.number 2', async () => {
  const normalized = normalizeGitHubEvent(
    'push',
    Buffer.from(
      JSON.stringify({
        repository: { id: 123 },
        ref: 'refs/heads/main',
        before: 'a'.repeat(40),
        after: sha,
        commits: [{ id: sha, message }],
      }),
    ),
  );
  const facts = githubEventFacts('push', 2, normalized.data);
  expect(facts[0].refs).toEqual(['DEV-2']);
  expect(JSON.stringify(normalized)).not.toContain(message);
  expect(JSON.stringify(facts)).not.toContain('test: verify');
  const findMany = vi.fn().mockResolvedValue([{ id: 'task-two', number: 2 }]);
  const links = vi.fn();
  const evidence = vi.fn();
  const tx = {
    task: { findMany },
    gitHubTaskLink: { createMany: links },
    gitHubTaskLinkEvidence: { createMany: evidence },
  } as unknown as Prisma.TransactionClient;
  const scope = { workspaceId: 'workspace', projectId: 'project', repositoryId: '123' };
  const resolved = await resolveGitHubTaskReferences(tx, scope, [...facts[0].refs, 'DEV-002']);
  expect(findMany.mock.calls[0][0].where).toEqual({
    projectId: 'project',
    project: { workspaceId: 'workspace', archivedAt: null },
    number: { in: [2] },
  });
  await linkGitHubTasks(
    tx,
    scope,
    [{ objectId: 'commit', observationId: 'observation', refs: ['DEV-002', 'DEV-2', 'dev-0002'] }],
    resolved,
  );
  expect(links.mock.calls[0][0].data).toEqual([
    { projectId: 'project', repositoryId: '123', objectId: 'commit', taskId: 'task-two' },
  ]);
  expect(evidence.mock.calls[0][0].data).toEqual([
    { objectId: 'commit', taskId: 'task-two', observationId: 'observation' },
  ]);
});
it('normalizes padding without changing numeric task identities or accepting zero/oversized syntax', () => {
  expect(
    extractTaskReferences(`${message} DEV-2 dev-0002 DEV-000 DEV-002X DEV-12345678901`),
  ).toEqual(['DEV-2']);
  expect(canonicalTaskReference('DEV-000')).toBeNull();
  expect(canonicalTaskReference('DEV-12345678901')).toBeNull();
});
it('accepts padded references already present in legacy normalized records', () => {
  expect(
    githubEventFacts('issues', 1, {
      repositoryId: '123',
      action: 'opened',
      number: 4,
      state: 'open',
      taskRefs: ['DEV-002'],
    })[0].refs,
  ).toEqual(['DEV-2']);
});
