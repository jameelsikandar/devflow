import { z } from 'zod';
import { db } from './db';
import { authorizeGitHubProject } from './github-repositories';
import type { WorkspaceActor } from './tasks';
import { executionStates } from '../github-automation';
import { githubTaskObjectURL } from '../github-task-activity';
export const executionStateFilter = z.enum(executionStates).optional();
const record = (data: unknown) =>
  data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
export async function listGitHubWorkflowExecutions(
  actor: WorkspaceActor,
  projectId: string,
  offset = 0,
  state?: (typeof executionStates)[number],
) {
  return db.$transaction(
    async (tx) => {
      await authorizeGitHubProject(tx, actor, projectId);
      const where = { workspaceId: actor.workspaceId, projectId, ...(state ? { state } : {}) };
      const [rows, total] = await Promise.all([
        tx.gitHubWorkflowExecution.findMany({
          where,
          skip: offset,
          take: 25,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            state: true,
            reason: true,
            attempts: true,
            createdAt: true,
            completedAt: true,
            ruleVersion: true,
            ruleSnapshot: true,
            taskSnapshot: true,
            taskId: true,
            expectedTaskVersion: true,
            previousStatus: true,
            targetStatus: true,
            object: { select: { key: true } },
            connection: { select: { repositoryFullName: true, disconnectedAt: true } },
          },
        }),
        tx.gitHubWorkflowExecution.count({ where }),
      ]);
      return {
        items: rows.map((r) => {
          const rule = record(r.ruleSnapshot);
          const task = record(r.taskSnapshot);
          return {
            id: r.id,
            state: r.state,
            reason: r.reason,
            attempts: r.attempts,
            createdAt: r.createdAt,
            completedAt: r.completedAt,
            ruleName: typeof rule.name === 'string' ? rule.name : 'No eligible rule',
            ruleVersion: r.ruleVersion,
            taskId: r.taskId,
            taskReference: typeof task.reference === 'string' ? task.reference : null,
            taskTitle: typeof task.title === 'string' ? task.title : null,
            expectedTaskVersion: r.expectedTaskVersion,
            previousStatus: r.previousStatus,
            targetStatus: r.targetStatus,
            repository: r.connection.repositoryFullName,
            prNumber: r.object.key,
            prUrl: githubTaskObjectURL(
              r.connection.repositoryFullName,
              'PULL_REQUEST',
              r.object.key,
            ),
            disconnected: !!r.connection.disconnectedAt,
          };
        }),
        total,
        offset,
        hasMore: offset + rows.length < total,
      };
    },
    { isolationLevel: 'RepeatableRead' },
  );
}
