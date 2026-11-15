import { db } from './db';
import { HttpError } from './errors';
import type { WorkspaceActor } from './tasks';
import {
  githubTaskObjectURL,
  githubTaskStatus,
  githubObservationData,
  type TaskGitHubActivityPage,
} from '../github-task-activity';

export async function taskGitHubActivity(
  actor: WorkspaceActor,
  taskId: string,
  offset = 0,
): Promise<TaskGitHubActivityPage> {
  return db.$transaction(
    async (tx) => {
      const member = await tx.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: actor.workspaceId, userId: actor.userId } },
      });
      if (!member) throw new HttpError(404, 'Workspace not found');
      const task = await tx.task.findFirst({
        where: { id: taskId, project: { workspaceId: actor.workspaceId } },
        select: { id: true, projectId: true },
      });
      if (!task) throw new HttpError(404, 'Task not found');
      const where = {
        taskId: task.id,
        projectId: task.projectId,
        object: { workspaceId: actor.workspaceId, projectId: task.projectId },
      };
      const [total, links] = await Promise.all([
        tx.gitHubTaskLink.count({ where }),
        tx.gitHubTaskLink.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { objectId: 'desc' }],
          skip: offset,
          take: 10,
          select: {
            object: {
              select: {
                id: true,
                repositoryId: true,
                kind: true,
                key: true,
                currentData: true,
                sourceUpdatedAt: true,
                observations: {
                  orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
                  take: 1,
                  select: { data: true, incomplete: true, receivedAt: true },
                },
              },
            },
          },
        }),
      ]);
      const repositoryIds = [...new Set(links.map((l) => l.object.repositoryId))];
      const connections = repositoryIds.length
        ? await tx.gitHubRepositoryConnection.findMany({
            where: {
              workspaceId: actor.workspaceId,
              projectId: task.projectId,
              repositoryId: { in: repositoryIds },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: { repositoryId: true, repositoryFullName: true, disconnectedAt: true },
          })
        : [];
      const items = links.map(({ object }) => {
        const records = connections.filter((c) => c.repositoryId === object.repositoryId);
        const active = records.find((c) => !c.disconnectedAt);
        const repository = active ?? records[0];
        const observation = object.observations[0];
        const hasProjection = object.sourceUpdatedAt !== null && object.currentData !== null;
        return {
          id: object.id,
          kind: object.kind,
          key: object.key,
          repositoryName: repository?.repositoryFullName ?? null,
          connection: active
            ? ('connected' as const)
            : repository
              ? ('disconnected' as const)
              : ('unavailable' as const),
          url: githubTaskObjectURL(repository?.repositoryFullName ?? null, object.kind, object.key),
          status: githubTaskStatus(
            object.kind,
            hasProjection ? object.currentData : githubObservationData(observation?.data),
          ),
          statusSource: hasProjection ? ('source' as const) : ('observation' as const),
          updatedAt:
            (hasProjection ? object.sourceUpdatedAt : observation?.receivedAt)?.toISOString() ??
            null,
          incomplete: observation?.incomplete ?? false,
        };
      });
      return { total, offset, limit: 10, hasMore: offset + items.length < total, items };
    },
    { isolationLevel: 'RepeatableRead' },
  );
}
