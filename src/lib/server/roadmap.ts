import { db } from './db';
import { personSelect, HttpError } from './http';
import { dependencyOrder, type Dependency } from '../roadmap';
import { lockActiveProject } from './project-lock';

export async function getRoadmap(userId: string, workspaceId: string, projectId: string) {
  // Repeat the authorization in this service, so future tools cannot bypass it.
  return db.$transaction(
    async (tx) => {
      const project = await tx.project.findFirst({
        where: { id: projectId, workspaceId, workspace: { members: { some: { userId } } } },
        include: { _count: { select: { tasks: true } } },
      });
      if (!project) throw new HttpError(404, 'Project not found');
      const tasks = await tx.task.findMany({
        where: { projectId },
        include: {
          assignee: { select: personSelect },
          labels: { include: { label: true } },
          _count: { select: { comments: true } },
        },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
      });
      const dependencies = await tx.taskDependency.findMany({
        where: { projectId },
        orderBy: { createdAt: 'asc' },
      });
      return { project, tasks, dependencies };
    },
    { isolationLevel: 'RepeatableRead' },
  );
}

export async function changeDependency(
  userId: string,
  workspaceId: string,
  edge: Dependency,
  remove = false,
) {
  return db.$transaction(
    async (tx) => {
      // Serialize all graph mutations for a project BEFORE reading any edges. Under
      // READ COMMITTED, a waiter then sees its predecessor's committed graph.
      await lockActiveProject(tx, userId, workspaceId, edge.projectId);
      const tasks = await tx.task.findMany({
        where: { projectId: edge.projectId },
        select: { id: true },
      });
      const ids = tasks.map((t) => t.id);
      if (edge.predecessorId === edge.successorId)
        throw new HttpError(400, 'A task cannot depend on itself');
      if (!ids.includes(edge.predecessorId) || !ids.includes(edge.successorId))
        throw new HttpError(404, 'Both tasks must belong to this project');
      const where = {
        predecessorId_successorId: {
          predecessorId: edge.predecessorId,
          successorId: edge.successorId,
        },
      };
      const existing = await tx.taskDependency.findUnique({ where });
      if (remove) {
        if (!existing) return { ok: true, changed: false };
        await tx.taskDependency.delete({ where });
      } else {
        if (existing) return { ok: true, changed: false };
        const edges = await tx.taskDependency.findMany({ where: { projectId: edge.projectId } });
        try {
          dependencyOrder(ids, [...edges, edge]);
        } catch (error) {
          throw new HttpError(400, (error as Error).message);
        }
        await tx.taskDependency.create({ data: edge });
      }
      await tx.taskActivity.create({
        data: {
          workspaceId,
          actorId: userId,
          taskId: edge.successorId,
          message: `${remove ? 'removed' : 'added'} a finish-to-start dependency`,
        },
      });
      return { ok: true, changed: true };
    },
    { isolationLevel: 'ReadCommitted' },
  );
}
