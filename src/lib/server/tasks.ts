import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { taskSchema, taskUpdateSchema } from '../validation';
import { scheduleError } from '../roadmap';
import { HttpError, personSelect } from './http';
import { taskStatusFields } from './task-status';
import { lockActiveProject } from './project-lock';

export interface WorkspaceActor {
  userId: string;
  workspaceId: string;
  name: string;
}
export const taskPublicInclude = {
  assignee: { select: personSelect },
  labels: { include: { label: true } },
  _count: { select: { comments: true, githubLinks: true } },
} as const;
async function relations(
  tx: Prisma.TransactionClient,
  actor: WorkspaceActor,
  assigneeId: string | null | undefined,
  labelIds?: string[],
) {
  if (
    assigneeId &&
    !(await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: actor.workspaceId, userId: assigneeId } },
    }))
  )
    throw new HttpError(400, 'Assignee must belong to this workspace');
  if (
    labelIds &&
    (await tx.label.count({
      where: { workspaceId: actor.workspaceId, id: { in: [...new Set(labelIds)] } },
    })) !== new Set(labelIds).size
  )
    throw new HttpError(400, 'Labels must belong to this workspace');
}
export async function createWorkspaceTask(
  tx: Prisma.TransactionClient,
  actor: WorkspaceActor,
  values: z.infer<typeof taskSchema>,
) {
  const { labelIds, ...input } = taskSchema.parse(values);
  await lockActiveProject(tx, actor.userId, actor.workspaceId, input.projectId);
  const invalid = scheduleError(input);
  if (invalid) throw new HttpError(400, invalid);
  await relations(tx, actor, input.assigneeId, labelIds);
  if (
    input.parentTaskId &&
    !(await tx.task.findFirst({ where: { id: input.parentTaskId, projectId: input.projectId } }))
  )
    throw new HttpError(400, 'Parent task must belong to this project');
  const max = await tx.task.aggregate({
    where: { projectId: input.projectId, status: input.status },
    _max: { position: true },
  });
  const task = await tx.task.create({
    data: {
      ...input,
      position: (max._max.position ?? 0) + 1024,
      completedAt: input.status === 'DONE' ? new Date() : null,
      labels: { create: [...new Set(labelIds)].map((labelId) => ({ labelId })) },
    },
    include: taskPublicInclude,
  });
  await tx.taskActivity.create({
    data: {
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      taskId: task.id,
      message: `created ${task.title}`,
    },
  });
  if (task.assigneeId && task.assigneeId !== actor.userId)
    await tx.notification.create({
      data: { userId: task.assigneeId, message: `${actor.name} assigned you ${task.title}` },
    });
  return task;
}
export async function updateWorkspaceTask(
  tx: Prisma.TransactionClient,
  actor: WorkspaceActor,
  taskId: string,
  values: z.infer<typeof taskUpdateSchema>,
) {
  const { version, labelIds, ...input } = taskUpdateSchema.parse(values);
  const initial = await tx.task.findFirst({
    where: { id: taskId, project: { workspaceId: actor.workspaceId } },
    select: { projectId: true },
  });
  if (!initial) throw new HttpError(404, 'Task not found');
  await lockActiveProject(tx, actor.userId, actor.workspaceId, initial.projectId);
  const current = await tx.task.findUnique({ where: { id: taskId } });
  if (!current) throw new HttpError(404, 'Task not found');
  if (current.version !== version)
    throw new HttpError(409, 'This task changed. Refresh and try again.');
  const invalid = scheduleError({ ...current, ...input });
  if (invalid) throw new HttpError(400, invalid);
  await relations(tx, actor, input.assigneeId, labelIds);
  const changed = await tx.task.updateMany({
    where: { id: taskId, version },
    data: {
      ...input,
      version: { increment: 1 },
      ...(input.status ? taskStatusFields(input.status, current.completedAt) : {}),
    },
  });
  if (changed.count !== 1) throw new HttpError(409, 'This task changed. Refresh and try again.');
  if (labelIds) {
    await tx.taskLabel.deleteMany({ where: { taskId } });
    await tx.taskLabel.createMany({
      data: [...new Set(labelIds)].map((labelId) => ({ taskId, labelId })),
    });
  }
  await tx.taskActivity.create({
    data: {
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      taskId,
      message:
        input.status && input.status !== current.status
          ? `moved ${current.title} to ${input.status.toLowerCase().replaceAll('_', ' ')}`
          : `updated ${current.title}`,
    },
  });
  if (
    input.assigneeId &&
    input.assigneeId !== current.assigneeId &&
    input.assigneeId !== actor.userId
  )
    await tx.notification.create({
      data: {
        userId: input.assigneeId,
        message: `${actor.name} assigned you ${input.title ?? current.title}`,
      },
    });
  return tx.task.findUniqueOrThrow({ where: { id: taskId }, include: taskPublicInclude });
}
