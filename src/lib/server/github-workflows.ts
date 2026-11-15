import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from './db';
import { HttpError } from './errors';
import { authorizeGitHubProject } from './github-repositories';
import { lockActiveProject } from './project-lock';
import type { WorkspaceActor } from './tasks';
import { workflowDefinition } from '../github-workflows';
import { evaluateStoredGitHubWorkflow } from './github-workflow-evaluation';

const command = z
  .object({
    requestId: z.string().uuid(),
    definition: workflowDefinition,
    automationConfirmed: z.boolean().optional(),
  })
  .strict();
const update = command.extend({ expectedVersion: z.number().int().positive() });
const deletion = z
  .object({ requestId: z.string().uuid(), expectedVersion: z.number().int().positive() })
  .strict();
export const dryRunCommand = z
  .object({
    observationId: z.string().min(1).max(128),
    includeDisabled: z.boolean().default(false),
  })
  .strict();
const connectionSelect = { id: true, repositoryFullName: true, disconnectedAt: true } as const;
export async function listGitHubWorkflowRules(
  actor: WorkspaceActor,
  projectId: string,
  offset = 0,
) {
  return db.$transaction(
    async (tx) => {
      const project = await authorizeGitHubProject(tx, actor, projectId);
      const where = {
        object: { workspaceId: actor.workspaceId, projectId, kind: 'PULL_REQUEST' as const },
      };
      const [rules, connections, observations, total] = await Promise.all([
        tx.gitHubWorkflowRule.findMany({
          where: { projectId, workspaceId: actor.workspaceId, deletedAt: null },
          orderBy: [{ priority: 'asc' }, { id: 'asc' }],
        }),
        tx.gitHubRepositoryConnection.findMany({
          where: { projectId, workspaceId: actor.workspaceId },
          select: connectionSelect,
          orderBy: { createdAt: 'desc' },
        }),
        tx.gitHubObservation.findMany({
          where,
          take: 25,
          skip: offset,
          orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            receivedAt: true,
            incomplete: true,
            object: { select: { key: true } },
            connection: { select: connectionSelect },
            delivery: { select: { event: true, state: true, data: true } },
          },
        }),
        tx.gitHubObservation.count({ where }),
      ]);
      return {
        rules,
        connections,
        archived: !!project.archivedAt,
        observations: observations.map((o) => {
          const data = o.delivery.data as Record<string, unknown> | null;
          return {
            id: o.id,
            number: o.object.key,
            receivedAt: o.receivedAt,
            repository: o.connection.repositoryFullName,
            disconnected: !!o.connection.disconnectedAt,
            action: typeof data?.action === 'string' ? data.action : 'unknown',
            state: o.delivery.state,
          };
        }),
        total,
        offset,
        hasMore: offset + observations.length < total,
      };
    },
    { isolationLevel: 'RepeatableRead' },
  );
}
export async function mutateGitHubWorkflowRule(
  actor: WorkspaceActor,
  projectId: string,
  operation: 'CREATE' | 'UPDATE' | 'DELETE',
  input: unknown,
  ruleId?: string,
) {
  const parsed =
    operation === 'CREATE'
      ? command.parse(input)
      : operation === 'UPDATE'
        ? update.parse(input)
        : deletion.parse(input);
  const hash = createHash('sha256')
    .update(JSON.stringify({ actor: actor.userId, operation, ruleId, input: parsed }))
    .digest('hex');
  return db.$transaction(async (tx) => {
    // Same project-first boundary as repository disconnect and task/roadmap writes.
    await lockActiveProject(tx, actor.userId, actor.workspaceId, projectId);
    await authorizeGitHubProject(tx, actor, projectId);
    const previous = await tx.gitHubWorkflowRuleRevision.findUnique({
      where: { projectId_requestId: { projectId, requestId: parsed.requestId } },
    });
    if (previous) {
      if (previous.requestHash !== hash)
        throw new HttpError(409, 'Request ID was already used for a different change');
      return { rule: previous.snapshot, replayed: true };
    }
    const definition = 'definition' in parsed ? parsed.definition : null;
    if (
      definition?.enabled &&
      (!('automationConfirmed' in parsed) || parsed.automationConfirmed !== true)
    )
      throw new HttpError(
        409,
        'Confirm GitHub automation before enabling or editing an enabled rule',
      );
    const activation = {
      automationEnabledAt: definition?.enabled ? new Date() : null,
      automationAuthorizedById: definition?.enabled ? actor.userId : null,
    };

    if (definition?.connectionId) {
      const c = await tx.gitHubRepositoryConnection.findFirst({
        where: {
          id: definition.connectionId,
          projectId,
          workspaceId: actor.workspaceId,
          ...(definition.enabled ? { disconnectedAt: null } : {}),
        },
      });
      if (!c)
        throw new HttpError(
          409,
          'Choose a repository connection in this project (active when enabling)',
        );
    }
    let rule;
    if (operation === 'CREATE' && definition) {
      if ((await tx.gitHubWorkflowRule.count({ where: { projectId, deletedAt: null } })) >= 100)
        throw new HttpError(409, 'Maximum 100 rules per project');
      rule = await tx.gitHubWorkflowRule.create({
        data: {
          ...definition,
          ...activation,
          automationEnabledVersion: definition.enabled ? 1 : null,
          projectId,
          workspaceId: actor.workspaceId,
        },
      });
    } else {
      const old = await tx.gitHubWorkflowRule.findFirst({
        where: { id: ruleId, projectId, workspaceId: actor.workspaceId, deletedAt: null },
      });
      if (!old) throw new HttpError(404, 'Rule not found');
      if (!('expectedVersion' in parsed) || old.version !== parsed.expectedVersion)
        throw new HttpError(409, 'Rule changed. Reload before saving.');
      rule = await tx.gitHubWorkflowRule.update({
        where: { id: old.id },
        data: {
          ...(operation === 'DELETE'
            ? {
                enabled: false,
                deletedAt: new Date(),
                automationEnabledAt: null,
                automationAuthorizedById: null,
                automationEnabledVersion: null,
              }
            : {
                ...definition,
                ...activation,
                automationEnabledVersion: definition?.enabled ? old.version + 1 : null,
              }),
          version: { increment: 1 },
        },
      });
    }
    const snapshot = JSON.parse(JSON.stringify(rule)) as Prisma.InputJsonValue;
    await tx.gitHubWorkflowRuleRevision.create({
      data: {
        workspaceId: actor.workspaceId,
        projectId,
        ruleId: rule.id,
        version: rule.version,
        actorId: actor.userId,
        operation,
        requestId: parsed.requestId,
        requestHash: hash,
        snapshot,
      },
    });
    return { rule: snapshot, replayed: false };
  });
}
export async function gitHubWorkflowHistory(actor: WorkspaceActor, projectId: string, offset = 0) {
  return db.$transaction(
    async (tx) => {
      await authorizeGitHubProject(tx, actor, projectId);
      const where = { projectId, workspaceId: actor.workspaceId };
      const [items, total] = await Promise.all([
        tx.gitHubWorkflowRuleRevision.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: offset,
          take: 25,
          select: {
            id: true,
            ruleId: true,
            version: true,
            actorId: true,
            operation: true,
            snapshot: true,
            createdAt: true,
          },
        }),
        tx.gitHubWorkflowRuleRevision.count({ where }),
      ]);
      return { items, total, offset, hasMore: offset + items.length < total };
    },
    { isolationLevel: 'RepeatableRead' },
  );
}
export async function previewGitHubWorkflow(
  actor: WorkspaceActor,
  projectId: string,
  input: unknown,
) {
  const { observationId, includeDisabled } = dryRunCommand.parse(input);
  return db.$transaction(
    async (tx) => {
      const project = await authorizeGitHubProject(tx, actor, projectId);
      return (
        await evaluateStoredGitHubWorkflow(
          tx,
          actor,
          projectId,
          observationId,
          includeDisabled,
          !!project.archivedAt,
        )
      ).evaluation;
    },
    { isolationLevel: 'RepeatableRead' },
  );
}
