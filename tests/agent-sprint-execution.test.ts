import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { executeAgentAction, type PreparedAction } from '../src/lib/server/agent-tools';

const actor = { workspaceId: 'workspace', userId: 'owner', name: 'Owner', projectId: 'project' };
const action: PreparedAction = {
  tool: 'createSprint',
  projectId: 'project',
  input: {
    projectId: 'project',
    name: 'Sprint',
    goal: 'Ship verified work',
    startDate: '2026-11-15T00:00:00Z',
    endDate: '2026-11-28T23:59:59Z',
    taskIds: ['task'],
  },
  taskVersions: { task: 7 },
  preview: {},
};
function fixture() {
  const db = {
    workspaceMember: { findUnique: vi.fn().mockResolvedValue({}) },
    project: { findFirst: vi.fn().mockResolvedValue({ id: 'project' }) },
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'project', archivedAt: null }]),
    task: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: 'task', title: 'Verified work', status: 'TODO', version: 7 }]),
    },
    sprintTask: { count: vi.fn().mockResolvedValue(0) },
    sprint: { create: vi.fn().mockResolvedValue({ id: 'sprint', name: 'Sprint' }) },
    taskActivity: { create: vi.fn().mockResolvedValue({}) },
  };
  return { db, tx: db as unknown as Prisma.TransactionClient };
}
describe('approved sprint execution (mocked transaction)', () => {
  it('lets Prisma inherit the composite parent project key and retains task baselines and audit', async () => {
    const { db, tx } = fixture();
    expect(await executeAgentAction(tx, actor, action)).toMatchObject({
      type: 'sprint',
      taskCount: 1,
    });
    expect(db.sprint.create).toHaveBeenCalledWith({
      data: {
        projectId: 'project',
        name: 'Sprint',
        goal: 'Ship verified work',
        startDate: action.input.startDate,
        endDate: action.input.endDate,
        tasks: {
          create: [
            {
              taskId: 'task',
              taskVersion: 7,
              titleSnapshot: 'Verified work',
              statusSnapshot: 'TODO',
            },
          ],
        },
      },
    });
    expect(db.$queryRaw).toHaveBeenCalledOnce();
    expect(db.taskActivity.create).toHaveBeenCalledOnce();
  });
  it.each(['changed', 'overlap', 'foreign task', 'removed membership'] as const)(
    'rejects %s before sprint or audit writes',
    async (reason) => {
      const { db, tx } = fixture();
      if (reason === 'changed')
        db.task.findMany.mockResolvedValue([
          { id: 'task', title: 'Changed', status: 'TODO', version: 8 },
        ]);
      if (reason === 'overlap') db.sprintTask.count.mockResolvedValue(1);
      if (reason === 'foreign task') db.task.findMany.mockResolvedValue([]);
      if (reason === 'removed membership') db.workspaceMember.findUnique.mockResolvedValue(null);
      await expect(executeAgentAction(tx, actor, action)).rejects.toMatchObject({
        status: reason === 'removed membership' ? 404 : reason === 'foreign task' ? 400 : 409,
      });
      expect(db.sprint.create).not.toHaveBeenCalled();
      expect(db.taskActivity.create).not.toHaveBeenCalled();
    },
  );
});
