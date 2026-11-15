import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { prepareAgentAction, readAgentTool } from '../src/lib/server/agent-tools';
const actor = {
  workspaceId: 'workspace',
  userId: 'owner',
  name: 'Owner',
  projectId: 'allowed-project',
};
const tx = (value: unknown) => value as Prisma.TransactionClient;
describe('scoped AI tool queries', () => {
  it('rejects removed membership before querying project data', async () => {
    const project = { findFirst: vi.fn() };
    await expect(
      readAgentTool(
        tx({ workspaceMember: { findUnique: async () => null }, project }),
        actor,
        'getProject',
        { projectId: 'allowed-project' },
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(project.findFirst).not.toHaveBeenCalled();
  });
  it('rejects project-scope escape before a project query', async () => {
    const project = { findFirst: vi.fn() };
    const db = tx({ workspaceMember: { findUnique: async () => ({}) }, project });
    await expect(
      readAgentTool(db, actor, 'getProject', { projectId: 'foreign-project' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      prepareAgentAction(db, actor, 'createTask', {
        projectId: 'foreign-project',
        title: 'Attempt',
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(project.findFirst).not.toHaveBeenCalled();
  });
  it('keeps task filters inside the conversation project and authorized workspace', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await readAgentTool(
      tx({
        workspaceMember: { findUnique: async () => ({}) },
        project: { findFirst: async () => ({ id: actor.projectId, name: 'DevFlow' }) },
        task: { findMany, count: async () => 0 },
      }),
      actor,
      'listTasks',
      { overdue: true, query: 'DEV-123' },
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          project: { workspaceId: actor.workspaceId, archivedAt: null, id: actor.projectId },
          OR: expect.arrayContaining([{ number: 123 }]),
        }),
      }),
    );
  });
  it('captures server versions and full before/after fields when preparing an update', async () => {
    const create = vi.fn();
    const updateMany = vi.fn();
    const prepared = await prepareAgentAction(
      tx({
        workspaceMember: { findUnique: async () => ({}) },
        project: { findFirst: async () => ({ id: actor.projectId, name: 'Project' }) },
        task: {
          findFirst: async () => ({
            id: 'task',
            projectId: actor.projectId,
            number: 10,
            title: 'Current',
            priority: 'LOW',
            version: 7,
            labels: [],
            startDate: null,
            dueDate: null,
          }),
          create,
          updateMany,
        },
      }),
      actor,
      'updateTask',
      { taskId: 'task', changes: { priority: 'HIGH' } },
    );
    expect(prepared.version).toBe(7);
    expect(prepared.preview).toMatchObject({
      before: { priority: 'LOW' },
      changes: { priority: 'HIGH' },
    });
    expect(create).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('task ownership scopes and presentation', () => {
  function database() {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'internal-task',
        number: 7,
        projectId: actor.projectId,
        title: 'Actual task',
        status: 'IN_PROGRESS',
        priority: 'HIGH',
        assigneeId: actor.userId,
        project: { name: 'DevFlow' },
        assignee: { name: 'Owner' },
      },
    ]);
    const count = vi.fn().mockResolvedValue(1);
    return {
      findMany,
      count,
      client: tx({
        workspaceMember: { findUnique: async () => ({}) },
        project: { findFirst: async () => ({ id: actor.projectId, name: 'DevFlow' }) },
        task: { findMany, count },
      }),
    };
  }
  it.each([
    ['mine', actor.userId],
    ['unassigned', null],
    ['all', undefined],
  ] as const)(
    'resolves %s server-side and retains the authorized project boundary',
    async (scope, assigneeId) => {
      const db = database();
      const result = await readAgentTool(db.client, actor, 'listTasks', { scope });
      if (scope === 'all') expect(result).toMatchObject({ scope: { kind: 'all' } });
      if (scope === 'all')
        expect((result as { scope: object }).scope).not.toHaveProperty('assigneeId');
      const where = db.findMany.mock.calls[0][0].where;
      expect(where.project).toEqual({
        workspaceId: actor.workspaceId,
        archivedAt: null,
        id: actor.projectId,
      });
      if (assigneeId === undefined) expect(where).not.toHaveProperty('assigneeId');
      else expect(where.assigneeId).toBe(assigneeId);
      expect(db.count.mock.calls[0][0].where).toEqual(where);
      expect(result).toMatchObject({
        scope: { kind: scope },
        items: [
          {
            id: 'internal-task',
            reference: 'DEV-7',
            projectName: 'DevFlow',
            assigneeName: 'Owner',
            statusLabel: 'In Progress',
            priorityLabel: 'High',
          },
        ],
      });
    },
  );
  it('rejects contradictory assignee filters before reading records', async () => {
    const db = database();
    await expect(
      readAgentTool(db.client, actor, 'listTasks', { scope: 'mine', assigneeId: 'someone-else' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      readAgentTool(db.client, actor, 'listTasks', {
        scope: 'unassigned',
        assigneeId: actor.userId,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(db.findMany).not.toHaveBeenCalled();
  });
  it('returns an honest empty assigned-to-me result without substituting project tasks', async () => {
    const db = database();
    db.findMany.mockResolvedValue([]);
    db.count.mockResolvedValue(0);
    expect(await readAgentTool(db.client, actor, 'listTasks', { scope: 'mine' })).toMatchObject({
      items: [],
      total: 0,
      scope: { kind: 'mine', assigneeId: actor.userId },
    });
    expect(db.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('contextual task retrieval boundaries and pagination', () => {
  function database() {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const findFirst = vi.fn().mockResolvedValue({ id: actor.projectId, name: 'DevFlow' });
    const client = tx({
      workspaceMember: { findUnique: async () => ({}) },
      project: { findFirst },
      task: { findMany, count },
    });
    return { client, findMany, count, findFirst };
  }
  const row = {
    id: 'actual',
    number: 3,
    title: 'Unassigned work',
    status: 'TODO',
    priority: 'MEDIUM',
    assigneeId: null,
    projectId: actor.projectId,
    project: { name: 'DevFlow' },
    assignee: null,
  };
  it('keeps zero assigned matches and retrieves separately labeled project context only on opt-in', async () => {
    const db = database();
    db.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([row]);
    db.count.mockResolvedValueOnce(0).mockResolvedValueOnce(3).mockResolvedValueOnce(3);
    const result = await readAgentTool(db.client, actor, 'listTasks', {
      scope: 'mine',
      includeProjectContext: true,
    });
    expect(result).toMatchObject({
      items: [],
      total: 0,
      scope: { kind: 'mine', assigneeId: actor.userId },
      projectContext: {
        total: 3,
        unassignedTotal: 3,
        projectName: 'DevFlow',
        scope: { kind: 'all' },
        items: [{ reference: 'DEV-3', assigneeName: 'Unassigned' }],
      },
    });
    expect(db.findMany).toHaveBeenCalledTimes(2);
    expect(db.findMany.mock.calls[0][0].where.assigneeId).toBe(actor.userId);
    expect(db.findMany.mock.calls[1][0].where).not.toHaveProperty('assigneeId');
    for (const [input] of db.findMany.mock.calls)
      expect(input.where.project).toEqual({
        workspaceId: actor.workspaceId,
        archivedAt: null,
        id: actor.projectId,
      });
  });
  it('does not attach unrelated project work when a personal query has results', async () => {
    const db = database();
    db.findMany.mockResolvedValue([row]);
    db.count.mockResolvedValue(1);
    expect(
      await readAgentTool(db.client, actor, 'listTasks', {
        scope: 'mine',
        includeProjectContext: true,
      }),
    ).not.toHaveProperty('projectContext');
    expect(db.findMany).toHaveBeenCalledTimes(1);
  });
  it('does not broaden a workspace personal query when no project is known', async () => {
    const db = database();
    const result = await readAgentTool(db.client, { ...actor, projectId: null }, 'listTasks', {
      scope: 'mine',
      includeProjectContext: true,
    });
    expect(result).not.toHaveProperty('projectContext');
    expect(db.findMany).toHaveBeenCalledTimes(1);
    expect(db.findFirst).not.toHaveBeenCalled();
    expect(db.findMany.mock.calls[0][0].where).toMatchObject({
      project: { workspaceId: actor.workspaceId, archivedAt: null },
      assigneeId: actor.userId,
    });
  });
  it('allows an explicit authorized project in a workspace conversation and keeps the follow-up there', async () => {
    const db = database();
    await readAgentTool(db.client, { ...actor, projectId: null }, 'listTasks', {
      scope: 'mine',
      projectId: actor.projectId,
      includeProjectContext: true,
    });
    for (const [input] of db.findMany.mock.calls)
      expect(input.where.projectId).toBe(actor.projectId);
    expect(db.findMany).toHaveBeenCalledTimes(2);
  });
  it('rejects project escape, foreign and archived projects before any task retrieval', async () => {
    const db = database();
    await expect(
      readAgentTool(db.client, actor, 'listTasks', {
        projectId: 'other',
        scope: 'mine',
        includeProjectContext: true,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(db.findFirst).not.toHaveBeenCalled();
    db.findFirst.mockResolvedValue(null);
    await expect(
      readAgentTool(db.client, actor, 'listTasks', { scope: 'all' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      readAgentTool(db.client, { ...actor, projectId: null }, 'listTasks', {
        projectId: 'foreign',
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(db.findMany).not.toHaveBeenCalled();
    expect(db.findFirst).toHaveBeenCalledWith({
      where: { id: actor.projectId, workspaceId: actor.workspaceId, archivedAt: null },
    });
  });
  it('retrieves all workspace tasks without an assignee/project filter but always excludes archived projects', async () => {
    const db = database();
    await readAgentTool(db.client, { ...actor, projectId: null }, 'listTasks', { scope: 'all' });
    expect(db.findMany.mock.calls[0][0].where).toEqual({
      project: { workspaceId: actor.workspaceId, archivedAt: null },
    });
  });
  it('returns counts and next offsets for exactly the same filtered unfinished query', async () => {
    const db = database();
    db.findMany.mockResolvedValue([row, { ...row, id: 'second', number: 4 }]);
    db.count.mockResolvedValue(5);
    expect(
      await readAgentTool(db.client, actor, 'listTasks', {
        scope: 'unassigned',
        unfinished: true,
        offset: 1,
        limit: 2,
      }),
    ).toMatchObject({ total: 5, offset: 1, limit: 2, hasMore: true, nextOffset: 3 });
    const query = db.findMany.mock.calls[0][0];
    expect(query).toMatchObject({
      skip: 1,
      take: 2,
      where: { assigneeId: null, AND: [{ status: { not: 'DONE' } }] },
    });
    expect(db.count.mock.calls[0][0].where).toEqual(query.where);
    db.findMany.mockResolvedValue([]);
    expect(await readAgentTool(db.client, actor, 'listTasks', { offset: 5 })).toMatchObject({
      hasMore: false,
      nextOffset: null,
    });
  });
  it('includes completed tasks by default and does not invent creator support', async () => {
    const db = database();
    const result = await readAgentTool(db.client, actor, 'listTasks', {});
    expect(db.findMany.mock.calls[0][0].where).not.toHaveProperty('AND');
    expect(result).toMatchObject({
      context: { createdBySupported: false, authenticatedUserId: actor.userId },
    });
    await expect(
      readAgentTool(db.client, actor, 'listTasks', { scope: 'created' }),
    ).rejects.toThrow();
    await expect(
      readAgentTool(db.client, actor, 'listTasks', { scope: 'all', includeProjectContext: true }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('keeps assignment proposals versioned and read-only until explicit approval', async () => {
    const update = vi.fn();
    const db = tx({
      workspaceMember: { findUnique: async () => ({}) },
      project: { findFirst: async () => ({ id: actor.projectId, name: 'DevFlow' }) },
      task: {
        findFirst: async () => ({ ...row, version: 6, labels: [], startDate: null, dueDate: null }),
        update,
      },
    });
    const prepared = await prepareAgentAction(db, actor, 'updateTask', {
      taskId: row.id,
      changes: { assigneeId: actor.userId },
    });
    expect(prepared).toMatchObject({
      version: 6,
      preview: { before: { assigneeId: null }, changes: { assigneeId: actor.userId } },
    });
    expect(update).not.toHaveBeenCalled();
  });
});
