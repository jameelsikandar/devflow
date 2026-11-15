import { expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { runAgentLoop } from '../src/lib/server/agent-loop';
import { canReuseAgentRead, agentCatalog } from '../src/lib/server/agent-context';
const call = (id: string, name: string, args: unknown) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});
const reply = (...calls: ReturnType<typeof call>[]) => ({
  content: calls.length ? null : 'Done',
  tool_calls: calls,
});
function gateway() {
  return {
    read: vi.fn().mockResolvedValue({ items: [{ id: 'task', projectId: 'p' }], total: 1 }),
    preview: vi.fn().mockResolvedValue({ tool: 'updateTask', preview: {} }),
    canReuseRead: vi.fn().mockResolvedValue(true),
  };
}
it('reuses normalized default reads, preserving full audit data and referencing prior model results', async () => {
  const gw = gateway(),
    onEvent = vi.fn();
  const complete = vi
    .fn()
    .mockResolvedValueOnce(
      reply(
        call('a', 'listTasks', {}),
        call('b', 'listTasks', { scope: 'all', offset: 0, limit: 25, unfinished: false }),
      ),
    )
    .mockResolvedValueOnce(reply());
  const result = await runAgentLoop({ complete }, [], gw, AbortSignal.timeout(10000), onEvent);
  expect(gw.read).toHaveBeenCalledTimes(1);
  expect(gw.canReuseRead).toHaveBeenCalledTimes(1);
  expect(result.events[1].output).toMatchObject({ total: 1, readReuse: { sourceCallId: 'a' } });
  expect(JSON.parse(complete.mock.calls[1][0].at(-1).content)).toMatchObject({
    reusedFromToolCall: 'a',
  });
  expect(onEvent).toHaveBeenCalledTimes(2);
});
it('does not merge pagination, scope, project or assignee differences', async () => {
  const gw = gateway();
  const queries = [{}, { offset: 25 }, { scope: 'mine' }, { projectId: 'p' }, { assigneeId: null }];
  const complete = vi
    .fn()
    .mockResolvedValueOnce(reply(...queries.map((q, i) => call(String(i), 'listTasks', q))))
    .mockResolvedValueOnce(reply());
  await runAgentLoop({ complete }, [], gw, AbortSignal.timeout(10000));
  expect(gw.read).toHaveBeenCalledTimes(5);
});
it('bypasses reuse with fresh=true and invalidates after proposal preparation', async () => {
  const gw = gateway();
  const complete = vi
    .fn()
    .mockResolvedValueOnce(
      reply(
        call('a', 'getTask', { taskId: 't' }),
        call('b', 'getTask', { taskId: 't', fresh: true }),
        call('c', 'updateTask', { taskId: 't', changes: { priority: 'HIGH' } }),
        call('d', 'getTask', { taskId: 't' }),
      ),
    )
    .mockResolvedValueOnce(reply());
  await runAgentLoop({ complete }, [], gw, AbortSignal.timeout(10000));
  expect(gw.read).toHaveBeenCalledTimes(3);
  expect(gw.preview).toHaveBeenCalledTimes(1);
});
it('does not reuse across runs, gateways without authorization hooks, or denied authorization', async () => {
  const gw = gateway();
  const provider = () => ({
    complete: vi
      .fn()
      .mockResolvedValueOnce(reply(call('a', 'listProjects', {}), call('b', 'listProjects', {})))
      .mockResolvedValueOnce(reply()),
  });
  await runAgentLoop(provider(), [], gw, AbortSignal.timeout(10000));
  await runAgentLoop(provider(), [], gw, AbortSignal.timeout(10000));
  expect(gw.read).toHaveBeenCalledTimes(2);
  gw.canReuseRead.mockResolvedValue(false);
  await runAgentLoop(provider(), [], gw, AbortSignal.timeout(10000));
  expect(gw.read).toHaveBeenCalledTimes(4);
  await runAgentLoop(
    provider(),
    [],
    { read: gw.read, preview: gw.preview },
    AbortSignal.timeout(10000),
  );
  expect(gw.read).toHaveBeenCalledTimes(6);
});
it('rechecks membership and active-project boundaries before reuse', async () => {
  const actor = { workspaceId: 'w', userId: 'u', name: 'User', projectId: null };
  const findUnique = vi.fn().mockResolvedValue(null),
    count = vi.fn().mockResolvedValue(1);
  const tx = {
    workspaceMember: { findUnique },
    project: { count },
  } as unknown as Prisma.TransactionClient;
  await expect(
    canReuseAgentRead(tx, actor, 'listTasks', { items: [{ projectId: 'p' }] }),
  ).rejects.toMatchObject({ status: 404 });
  expect(count).not.toHaveBeenCalled();
  findUnique.mockResolvedValue({});
  count.mockResolvedValue(0);
  expect(await canReuseAgentRead(tx, actor, 'listTasks', { items: [{ projectId: 'p' }] })).toBe(
    false,
  );
  expect(count).toHaveBeenCalledWith({
    where: { id: { in: ['p'] }, workspaceId: 'w', archivedAt: null },
  });
});
it('loads only scoped authorized project names/counts and resolves names beyond the bounded catalog', async () => {
  const findMany = vi
    .fn()
    .mockResolvedValueOnce([{ id: 'p', name: 'First' }])
    .mockResolvedValueOnce([{ id: 'q', name: 'Target' }]);
  const tx = {
    workspaceMember: { findUnique: async () => ({}) },
    project: { findMany, count: async () => 101 },
  } as unknown as Prisma.TransactionClient;
  expect(
    await agentCatalog(tx, { workspaceId: 'w', userId: 'u', name: 'U', projectId: null }, 'Target'),
  ).toMatchObject({
    catalogComplete: false,
    projectTotal: 101,
    projects: expect.arrayContaining([{ id: 'q', name: 'Target' }]),
  });
  expect(findMany.mock.calls[0][0]).toMatchObject({
    where: { workspaceId: 'w', archivedAt: null },
    select: { id: true, name: true },
  });
});
it('does not reuse cached records outside a pinned project even inside the same workspace', async () => {
  const count = vi.fn().mockResolvedValue(2);
  const tx = {
    workspaceMember: { findUnique: async () => ({}) },
    project: { count },
  } as unknown as Prisma.TransactionClient;
  expect(
    await canReuseAgentRead(
      tx,
      { workspaceId: 'w', userId: 'u', name: 'U', projectId: 'p' },
      'listTasks',
      { items: [{ projectId: 'other' }] },
    ),
  ).toBe(false);
  expect(count).not.toHaveBeenCalled();
});
