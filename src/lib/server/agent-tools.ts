import { z } from 'zod';
import { chatStatusLabels, chatPriorityLabels, taskReference } from '../chat-presentation';
import type { Prisma } from '@prisma/client';
import { toolSchemas, type ToolName, type WriteTool } from '../agent';
import { scheduleError } from '../roadmap';
import { HttpError } from './errors';
import type { WorkspaceActor } from './tasks';
import { createWorkspaceTask, updateWorkspaceTask } from './tasks';
import { lockActiveProject } from './project-lock';

export interface AgentActor extends WorkspaceActor {
  projectId: string | null;
}
export const preparedSchema = z
  .object({
    tool: z.enum(['createTask', 'updateTask', 'createSprint', 'generateReport']),
    input: z.record(z.unknown()),
    projectId: z.string(),
    version: z.number().int().min(0).optional(),
    taskVersions: z.record(z.number().int().min(0)).optional(),
    source: z.record(z.unknown()).optional(),
    preview: z.record(z.unknown()),
  })
  .strict();
export type PreparedAction = z.infer<typeof preparedSchema>;
export const asJson = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
export async function assertAgentActor(tx: Prisma.TransactionClient, actor: AgentActor) {
  if (
    !(await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: actor.workspaceId, userId: actor.userId } },
    }))
  )
    throw new HttpError(404, 'Workspace not found');
}
async function project(tx: Prisma.TransactionClient, actor: AgentActor, id: string) {
  await assertAgentActor(tx, actor);
  if (actor.projectId && actor.projectId !== id)
    throw new HttpError(404, 'Project not found in this conversation');
  const record = await tx.project.findFirst({
    where: { id, workspaceId: actor.workspaceId, archivedAt: null },
  });
  if (!record) throw new HttpError(404, 'Active project not found');
  return record;
}
const summary = {
  id: true,
  number: true,
  projectId: true,
  title: true,
  status: true,
  priority: true,
  assigneeId: true,
  startDate: true,
  dueDate: true,
  isMilestone: true,
  parentTaskId: true,
  version: true,
  createdAt: true,
  completedAt: true,
} as const;
async function task(tx: Prisma.TransactionClient, actor: AgentActor, id: string) {
  const reference = /^DEV[-–](\d+)$/i.exec(id);
  const record = await tx.task.findFirst({
    where: {
      ...(reference ? { number: Number(reference[1]) } : { id }),
      project: { workspaceId: actor.workspaceId, archivedAt: null },
      ...(actor.projectId ? { projectId: actor.projectId } : {}),
    },
    include: {
      labels: true,
      project: { select: { name: true } },
      assignee: { select: { name: true } },
    },
  });
  if (!record) throw new HttpError(404, 'Task not found in this conversation');
  return record;
}
function taskPresentation(t: {
  number: number;
  status: string;
  priority: string;
  project?: { name: string };
  assignee?: { name: string } | null;
}) {
  return {
    reference: taskReference(t.number),
    projectName: t.project?.name,
    assigneeName: t.assignee?.name ?? 'Unassigned',
    statusLabel: chatStatusLabels[t.status] ?? t.status,
    priorityLabel: chatPriorityLabels[t.priority] ?? t.priority,
  };
}
export async function readAgentTool(
  tx: Prisma.TransactionClient,
  actor: AgentActor,
  name: ToolName,
  value: unknown,
): Promise<unknown> {
  await assertAgentActor(tx, actor);
  const projectWhere = {
    workspaceId: actor.workspaceId,
    archivedAt: null,
    ...(actor.projectId ? { id: actor.projectId } : {}),
  };
  if (name === 'listProjects') {
    const input = toolSchemas.listProjects.parse(value);
    const [items, total] = await Promise.all([
      tx.project.findMany({
        where: projectWhere,
        select: { id: true, name: true, description: true, _count: { select: { tasks: true } } },
        orderBy: { id: 'asc' },
        skip: input.offset,
        take: input.limit,
      }),
      tx.project.count({ where: projectWhere }),
    ]);
    return { items, total, offset: input.offset, limit: input.limit };
  }
  if (name === 'getProject') {
    const input = toolSchemas.getProject.parse(value);
    const p = await project(tx, actor, input.projectId);
    const [
      statuses,
      overdue,
      workload,
      members,
      labels,
      dependencies,
      dependencyCount,
      sprints,
      reports,
    ] = await Promise.all([
      tx.task.groupBy({ by: ['status'], where: { projectId: p.id }, _count: true }),
      tx.task.count({
        where: { projectId: p.id, status: { not: 'DONE' }, dueDate: { lt: new Date() } },
      }),
      tx.task.groupBy({
        by: ['assigneeId'],
        where: { projectId: p.id, status: { not: 'DONE' } },
        _count: true,
      }),
      tx.workspaceMember.findMany({
        where: { workspaceId: actor.workspaceId },
        select: { user: { select: { id: true, name: true } } },
        orderBy: { userId: 'asc' },
        take: 100,
      }),
      tx.label.findMany({
        where: { workspaceId: actor.workspaceId },
        select: { id: true, name: true },
        take: 100,
        orderBy: { id: 'asc' },
      }),
      tx.taskDependency.findMany({
        where: { projectId: p.id },
        take: 50,
        orderBy: [{ predecessorId: 'asc' }, { successorId: 'asc' }],
      }),
      tx.taskDependency.count({ where: { projectId: p.id } }),
      tx.sprint.findMany({
        where: { projectId: p.id },
        include: { tasks: true },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      tx.projectReport.findMany({
        where: { projectId: p.id },
        select: { id: true, title: true, periodStart: true, periodEnd: true },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
    ]);
    return {
      project: { id: p.id, name: p.name, description: p.description },
      asOf: new Date(),
      statuses,
      overdue,
      workload,
      members,
      labels,
      dependencies,
      dependencyCount,
      sprints,
      reports,
      limits: { members: 100, labels: 100, dependencies: 50, sprints: 5, reports: 5 },
      workloadDefinition:
        'Current unfinished tasks per assignee in this project; not a capacity or skills estimate.',
    };
  }
  if (name === 'listTasks') {
    const input = toolSchemas.listTasks.parse(value);
    const reference = /^DEV[-–](\d+)$/i.exec(input.query ?? '');
    const assigneeId =
      input.scope === 'mine'
        ? actor.userId
        : input.scope === 'unassigned'
          ? null
          : input.assigneeId;
    if (input.scope !== 'all' && input.assigneeId !== undefined && input.assigneeId !== assigneeId)
      throw new HttpError(400, 'Task scope conflicts with the assignee filter');
    if (input.includeProjectContext && input.scope !== 'mine')
      throw new HttpError(400, 'Project context is only available for personal task queries');
    const selectedProjectId = input.projectId ?? actor.projectId;
    const selectedProject = selectedProjectId ? await project(tx, actor, selectedProjectId) : null;
    const where: Prisma.TaskWhereInput = {
      project: projectWhere,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(assigneeId !== undefined ? { assigneeId } : {}),
      ...(input.query
        ? {
            OR: [
              ...(reference ? [{ number: Number(reference[1]) }] : []),
              { title: { contains: input.query, mode: 'insensitive' } },
              { description: { contains: input.query, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(input.overdue || input.unfinished
        ? {
            AND: [
              { status: { not: 'DONE' } },
              ...(input.overdue ? [{ dueDate: { lt: new Date() } }] : []),
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      tx.task.findMany({
        where,
        select: {
          ...summary,
          project: { select: { name: true } },
          assignee: { select: { name: true } },
        },
        orderBy: { number: 'asc' },
        skip: input.offset,
        take: input.limit,
      }),
      tx.task.count({ where }),
    ]);
    // Keep assigned results intact. Extra context is opt-in, project-only and
    // independently labeled; never expand an empty personal query to the workspace.
    let projectContext: unknown;
    if (input.includeProjectContext && total === 0 && selectedProject) {
      const [page, unassignedTotal] = await Promise.all([
        readAgentTool(tx, actor, 'listTasks', {
          projectId: selectedProject.id,
          scope: 'all',
          limit: Math.min(input.limit, 25),
        }),
        tx.task.count({
          where: { project: projectWhere, projectId: selectedProject.id, assigneeId: null },
        }),
      ]);
      projectContext = {
        ...(page as object),
        projectName: selectedProject.name,
        unassignedTotal,
        definition:
          'All tasks in this selected project, without personal/status/search filters. These are not tasks assigned to the user.',
      };
    }
    const hasMore = items.length > 0 && input.offset + items.length < total;
    return {
      items: items.map((t) => ({ ...t, ...taskPresentation(t) })),
      total,
      offset: input.offset,
      limit: input.limit,
      asOf: new Date(),
      hasMore,
      nextOffset: hasMore ? input.offset + items.length : null,
      ...(projectContext ? { projectContext } : {}),
      context: {
        workspaceId: actor.workspaceId,
        projectId: selectedProjectId,
        projectName: selectedProject?.name ?? null,
        authenticatedUserId: actor.userId,
        archivedProjectsExcluded: true,
        createdBySupported: false,
      },
      scope: {
        kind: input.scope,
        ...(assigneeId !== undefined ? { assigneeId } : {}),
        projectId: selectedProjectId,
        unfinishedOnly: !!input.unfinished || !!input.overdue,
        definition:
          input.scope === 'mine'
            ? 'Tasks matching the supplied filters assigned to the authenticated user, not tasks they created.'
            : input.scope === 'unassigned'
              ? 'Tasks with no assignee.'
              : 'All tasks matching the supplied filters.',
      },
    };
  }
  if (name === 'getTask') {
    const input = toolSchemas.getTask.parse(value);
    const t = await task(tx, actor, input.taskId);
    const [comments, subtasks, dependencies] = await Promise.all([
      tx.taskComment.findMany({
        where: { taskId: t.id },
        select: { body: true, createdAt: true, author: { select: { id: true, name: true } } },
        take: 5,
        orderBy: { createdAt: 'desc' },
      }),
      tx.task.findMany({
        where: { parentTaskId: t.id, projectId: t.projectId },
        select: summary,
        orderBy: { number: 'asc' },
        take: 20,
      }),
      tx.taskDependency.findMany({
        where: { projectId: t.projectId, OR: [{ predecessorId: t.id }, { successorId: t.id }] },
        take: 20,
        orderBy: [{ predecessorId: 'asc' }, { successorId: 'asc' }],
      }),
    ]);
    return {
      ...Object.fromEntries(Object.keys(summary).map((key) => [key, t[key as keyof typeof t]])),
      ...taskPresentation(t),
      description: t.description.slice(0, 8000),
      descriptionTruncated: t.description.length > 8000,
      labels: t.labels,
      comments: comments.map((c) => ({ ...c, body: c.body.slice(0, 800) })),
      subtasks,
      dependencies,
      limits: { comments: 5, commentCharacters: 800, subtasks: 20, dependencies: 20 },
    };
  }
  throw new HttpError(400, 'This tool is not a read tool');
}
async function validateReferences(
  tx: Prisma.TransactionClient,
  actor: AgentActor,
  input: { assigneeId?: string | null; labelIds?: string[]; parentTaskId?: string | null },
  projectId: string,
) {
  if (
    input.assigneeId &&
    !(await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: actor.workspaceId, userId: input.assigneeId } },
    }))
  )
    throw new HttpError(400, 'Assignee is not a workspace member');
  if (
    input.labelIds &&
    (await tx.label.count({
      where: { workspaceId: actor.workspaceId, id: { in: [...new Set(input.labelIds)] } },
    })) !== new Set(input.labelIds).size
  )
    throw new HttpError(400, 'Labels must belong to this workspace');
  if (
    input.parentTaskId &&
    !(await tx.task.findFirst({ where: { id: input.parentTaskId, projectId } }))
  )
    throw new HttpError(400, 'Parent task must belong to this project');
}
async function sprintTasks(
  tx: Prisma.TransactionClient,
  input: z.infer<typeof toolSchemas.createSprint>,
  versions?: Record<string, number>,
) {
  const tasks = await tx.task.findMany({
    where: { id: { in: input.taskIds }, projectId: input.projectId },
    select: summary,
    orderBy: { number: 'asc' },
  });
  if (tasks.length !== input.taskIds.length)
    throw new HttpError(400, 'Every sprint task must belong to this project');
  if (tasks.some((t) => t.status === 'DONE' || (versions && versions[t.id] !== t.version)))
    throw new HttpError(409, 'Sprint tasks changed or are already complete. Generate a new plan.');
  const overlap = await tx.sprintTask.count({
    where: {
      taskId: { in: input.taskIds },
      sprint: {
        startDate: { lte: new Date(input.endDate) },
        endDate: { gte: new Date(input.startDate) },
      },
    },
  });
  if (overlap) throw new HttpError(409, 'A task is already planned in an overlapping sprint');
  return tasks;
}
export async function prepareAgentAction(
  tx: Prisma.TransactionClient,
  actor: AgentActor,
  name: WriteTool,
  value: unknown,
): Promise<PreparedAction> {
  await assertAgentActor(tx, actor);
  if (name === 'updateTask') {
    const input = toolSchemas.updateTask.parse(value);
    const t = await task(tx, actor, input.taskId);
    const p = await project(tx, actor, t.projectId);
    await validateReferences(tx, actor, input.changes, p.id);
    const invalid = scheduleError({ ...t, ...input.changes });
    if (invalid) throw new HttpError(400, invalid);
    const current = { ...t, labelIds: t.labels.map((l) => l.labelId) };
    return {
      tool: name,
      input,
      projectId: p.id,
      version: t.version,
      preview: {
        project: { id: p.id, name: p.name },
        task: { id: t.id, title: t.title, number: t.number },
        before: Object.fromEntries(
          Object.keys(input.changes).map((key) => [key, current[key as keyof typeof current]]),
        ),
        changes: input.changes,
      },
    };
  }
  if (name === 'createTask') {
    const input = toolSchemas.createTask.parse(value);
    const p = await project(tx, actor, input.projectId);
    await validateReferences(tx, actor, input, p.id);
    const invalid = scheduleError(input);
    if (invalid) throw new HttpError(400, invalid);
    const parent = input.parentTaskId
      ? await tx.task.findUnique({
          where: { id: input.parentTaskId },
          select: { title: true, number: true },
        })
      : null;
    return {
      tool: name,
      input,
      projectId: p.id,
      preview: { project: { id: p.id, name: p.name }, ...input, parent },
    };
  }
  if (name === 'createSprint') {
    const input = toolSchemas.createSprint.parse(value);
    const p = await project(tx, actor, input.projectId);
    const tasks = await sprintTasks(tx, input);
    return {
      tool: name,
      input,
      projectId: p.id,
      taskVersions: Object.fromEntries(tasks.map((t) => [t.id, t.version])),
      preview: { project: { id: p.id, name: p.name }, ...input, tasks },
    };
  }
  const input = toolSchemas.generateReport.parse(value);
  const p = await project(tx, actor, input.projectId);
  const [statuses, created, completed, overdue] = await Promise.all([
    tx.task.groupBy({ by: ['status'], where: { projectId: p.id }, _count: true }),
    tx.task.count({
      where: {
        projectId: p.id,
        createdAt: { gte: new Date(input.periodStart), lte: new Date(input.periodEnd) },
      },
    }),
    tx.task.count({
      where: {
        projectId: p.id,
        status: 'DONE',
        completedAt: { gte: new Date(input.periodStart), lte: new Date(input.periodEnd) },
      },
    }),
    tx.task.count({
      where: { projectId: p.id, status: { not: 'DONE' }, dueDate: { lt: new Date() } },
    }),
  ]);
  const source = {
    asOf: new Date().toISOString(),
    projectId: p.id,
    statuses,
    createdInPeriod: created,
    currentlyDoneCompletedInPeriod: completed,
    currentlyOverdue: overdue,
    definitions:
      'Current task states. Completion counts use current completedAt, not historical transitions; reopened/deleted tasks are not reconstructed. Narrative is AI-generated and requires review.',
  };
  return {
    tool: name,
    input,
    projectId: p.id,
    source,
    preview: { project: { id: p.id, name: p.name }, ...input, source },
  };
}

/** Only the explicit approval service calls this mutation function. */
export async function executeAgentAction(
  tx: Prisma.TransactionClient,
  actor: AgentActor,
  action: PreparedAction,
) {
  await project(tx, actor, action.projectId);
  await lockActiveProject(tx, actor.userId, actor.workspaceId, action.projectId);
  if (action.tool === 'createTask') {
    const input = toolSchemas.createTask.parse(action.input);
    if (input.projectId !== action.projectId) throw new HttpError(409, 'Preview project mismatch');
    const t = await createWorkspaceTask(tx, actor, input);
    return { type: 'task', id: t.id, title: t.title, number: t.number };
  }
  if (action.tool === 'updateTask') {
    const input = toolSchemas.updateTask.parse(action.input);
    const t = await task(tx, actor, input.taskId);
    if (t.projectId !== action.projectId || action.version === undefined)
      throw new HttpError(409, 'Invalid task preview');
    const updated = await updateWorkspaceTask(tx, actor, t.id, {
      ...input.changes,
      version: action.version,
    });
    return { type: 'task', id: updated.id, title: updated.title, version: updated.version };
  }
  if (action.tool === 'createSprint') {
    const input = toolSchemas.createSprint.parse(action.input);
    if (input.projectId !== action.projectId || !action.taskVersions)
      throw new HttpError(409, 'Invalid sprint preview');
    const tasks = await sprintTasks(tx, input, action.taskVersions);
    const data = {
      projectId: input.projectId,
      name: input.name,
      goal: input.goal,
      startDate: input.startDate,
      endDate: input.endDate,
    };
    const sprint = await tx.sprint.create({
      data: {
        ...data,
        tasks: {
          // The parent Sprint supplies projectId through the composite relation.
          create: tasks.map(
            (t) =>
              ({
                taskId: t.id,
                taskVersion: t.version,
                titleSnapshot: t.title,
                statusSnapshot: t.status,
              }) satisfies Prisma.SprintTaskUncheckedCreateWithoutSprintInput,
          ),
        },
      },
    });
    await tx.taskActivity.create({
      data: {
        workspaceId: actor.workspaceId,
        actorId: actor.userId,
        message: `approved sprint ${sprint.name}`,
      },
    });
    return { type: 'sprint', id: sprint.id, name: sprint.name, taskCount: tasks.length };
  }
  const input = toolSchemas.generateReport.parse(action.input);
  if (input.projectId !== action.projectId || !action.source)
    throw new HttpError(409, 'Invalid report preview');
  const report = await tx.projectReport.create({
    data: { ...input, source: asJson(action.source) },
  });
  await tx.taskActivity.create({
    data: {
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      message: `approved report ${report.title}`,
    },
  });
  return { type: 'report', id: report.id, title: report.title };
}
