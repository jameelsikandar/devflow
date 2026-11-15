import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { createWorkspaceTask, updateWorkspaceTask } from '../src/lib/server/tasks';
import { taskSchema } from '../src/lib/validation';
const lock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/server/project-lock', () => ({ lockActiveProject: lock }));
const actor = { userId: 'owner', workspaceId: 'workspace', name: 'Owner' };
function fixture() {
  const current = {
    id: 't',
    projectId: 'p',
    title: 'Current',
    status: 'TODO',
    priority: 'MEDIUM',
    assigneeId: null,
    startDate: null,
    dueDate: null,
    version: 2,
    completedAt: null,
  };
  return {
    workspaceMember: { findUnique: vi.fn().mockResolvedValue({}) },
    label: { count: vi.fn().mockResolvedValue(1) },
    task: {
      findFirst: vi.fn().mockResolvedValue(current),
      findUnique: vi.fn().mockResolvedValue(current),
      findUniqueOrThrow: vi.fn().mockResolvedValue(current),
      aggregate: vi.fn().mockResolvedValue({ _max: { position: 2048 } }),
      create: vi.fn().mockImplementation(async ({ data }) => ({ ...current, ...data })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    taskLabel: { deleteMany: vi.fn(), createMany: vi.fn() },
    taskActivity: { create: vi.fn() },
    notification: { create: vi.fn() },
  };
}
const tx = (value: unknown) => value as Prisma.TransactionClient;
beforeEach(() => {
  vi.clearAllMocks();
  lock.mockResolvedValue(undefined);
});
describe('shared task writes retain existing behavior', () => {
  it('locks the project, appends board position, deduplicates labels and notifies an assignee', async () => {
    const db = fixture();
    const task = await createWorkspaceTask(
      tx(db),
      actor,
      taskSchema.parse({
        projectId: 'p',
        title: 'Create task',
        assigneeId: 'member',
        labelIds: ['label', 'label'],
      }),
    );
    expect(task.position).toBe(3072);
    expect(lock).toHaveBeenCalledWith(db, actor.userId, actor.workspaceId, 'p');
    expect(db.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ labels: { create: [{ labelId: 'label' }] } }),
      }),
    );
    expect(db.notification.create).toHaveBeenCalledWith({
      data: { userId: 'member', message: 'Owner assigned you Create task' },
    });
    expect(db.taskActivity.create).toHaveBeenCalledTimes(1);
  });
  it('rejects foreign parents, assignees and invalid dates before creating a task', async () => {
    const db = fixture();
    db.task.findFirst.mockResolvedValue(null);
    await expect(
      createWorkspaceTask(
        tx(db),
        actor,
        taskSchema.parse({ projectId: 'p', title: 'Child', parentTaskId: 'foreign' }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    db.workspaceMember.findUnique.mockResolvedValue(null);
    await expect(
      createWorkspaceTask(
        tx(db),
        actor,
        taskSchema.parse({ projectId: 'p', title: 'Assigned', assigneeId: 'foreign' }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      createWorkspaceTask(
        tx(db),
        actor,
        taskSchema.parse({
          projectId: 'p',
          title: 'Reversed',
          startDate: '2026-11-03T00:00:00Z',
          dueDate: '2026-11-01T00:00:00Z',
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(db.task.create).not.toHaveBeenCalled();
  });
  it('blocks stale versions and invalid merged schedules before writing', async () => {
    const db = fixture();
    await expect(
      updateWorkspaceTask(tx(db), actor, 't', { version: 1, priority: 'HIGH' }),
    ).rejects.toMatchObject({ status: 409 });
    db.task.findUnique.mockResolvedValue({
      ...(await db.task.findUnique()),
      startDate: new Date('2026-11-03'),
    });
    await expect(
      updateWorkspaceTask(tx(db), actor, 't', { version: 2, dueDate: '2026-11-01T00:00:00Z' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(db.task.updateMany).not.toHaveBeenCalled();
  });
  it('preserves labels on unrelated updates and uses atomic version increments', async () => {
    const db = fixture();
    await updateWorkspaceTask(tx(db), actor, 't', { version: 2, status: 'DONE' });
    expect(db.task.updateMany).toHaveBeenCalledWith({
      where: { id: 't', version: 2 },
      data: { status: 'DONE', completedAt: expect.any(Date), version: { increment: 1 } },
    });
    expect(db.taskLabel.deleteMany).not.toHaveBeenCalled();
    expect(db.taskActivity.create).toHaveBeenCalledTimes(1);
  });
  it('does not write when the active-project authorization/lock fails', async () => {
    const db = fixture();
    lock.mockRejectedValue(new Error('Archived or unauthorized project'));
    await expect(
      createWorkspaceTask(tx(db), actor, taskSchema.parse({ projectId: 'p', title: 'Blocked' })),
    ).rejects.toThrow('Archived');
    expect(db.task.create).not.toHaveBeenCalled();
  });
});
