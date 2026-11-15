import { createHash } from 'node:crypto';
import { Prisma, type GitHubWorkflowRule, type GitHubWorkflowExecution } from '@prisma/client';
import { db } from './db';
import type { GitHubPublishContext, WorkerOptions } from './github-processing';
import { retryDelay } from './github-processing';
import { evaluateStoredGitHubWorkflow } from './github-workflow-evaluation';
import { prWorkflowFacts } from '../github-workflows';
import { taskStatusFields } from './task-status';
import { taskUpdateSchema } from '../validation';
import { scheduleError } from '../roadmap';
import { statusNames } from '../types';

const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
export function originalWebhook(data: unknown): unknown {
  return data !== null && typeof data === 'object' && !Array.isArray(data) && 'webhook' in data
    ? data.webhook
    : data;
}
/** Excludes delivery IDs, rule edits, refs and task IDs: changing any cannot replay a source event. */
export function workflowEventKey(
  projectId: string,
  repositoryId: string,
  objectKey: string,
  data: unknown,
) {
  const p = prWorkflowFacts.safeParse(originalWebhook(data));
  return createHash('sha256')
    .update(
      JSON.stringify(
        p.success
          ? {
              projectId,
              repositoryId,
              objectKey,
              action: p.data.action,
              state: p.data.state,
              merged: p.data.merged,
              sourceUpdatedAt: new Date(p.data.sourceUpdatedAt).toISOString(),
            }
          : { projectId, repositoryId, objectKey, invalid: true },
      ),
    )
    .digest('hex');
}
export function automationBoundary(
  rule: Pick<
    GitHubWorkflowRule,
    | 'enabled'
    | 'deletedAt'
    | 'automationEnabledAt'
    | 'automationAuthorizedById'
    | 'automationEnabledVersion'
    | 'version'
  >,
  receivedAt: Date,
  data: unknown,
) {
  if (!rule.enabled || rule.deletedAt) return 'RULE_DISABLED';
  if (
    !rule.automationEnabledAt ||
    !rule.automationAuthorizedById ||
    rule.automationEnabledVersion !== rule.version
  )
    return 'PREVIEW_ONLY_RULE';
  const parsed = prWorkflowFacts.safeParse(originalWebhook(data));
  if (!parsed.success) return 'MISSING_DATA';
  if (
    +receivedAt < +rule.automationEnabledAt ||
    Date.parse(parsed.data.sourceUpdatedAt) <= +rule.automationEnabledAt
  )
    return 'EVENT_BEFORE_ENABLE';
  return null;
}
export function automationFailure(error: unknown) {
  const code = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : '';
  const transient =
    error instanceof Prisma.PrismaClientInitializationError ||
    ['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034'].includes(code);
  return {
    retryable: transient,
    code: transient ? 'DATABASE_TRANSIENT_FAILURE' : 'EXECUTION_INVALID',
  };
}
/** Called ONLY inside completeGitHubDelivery's project→connection→delivery fenced transaction. */
export async function planGitHubAutomation(
  tx: Prisma.TransactionClient,
  context: GitHubPublishContext,
) {
  const { delivery, connection: c } = context;
  if (delivery.event !== 'pull_request') return;
  const observations = await tx.gitHubObservation.findMany({
    where: { connectionId: c.id, deliveryId: delivery.id },
    select: { id: true },
  });
  for (const { id } of observations) {
    if (await tx.gitHubWorkflowExecution.findUnique({ where: { observationId: id } })) continue;
    const {
      observation: o,
      rules,
      evaluation,
    } = await evaluateStoredGitHubWorkflow(tx, c, c.projectId, id, false, false, delivery.id);
    const eventKey = workflowEventKey(c.projectId, c.repositoryId, o.object.key, o.data);
    const previous = await tx.gitHubWorkflowExecution.findUnique({
      where: { claimKey: eventKey },
      select: { id: true },
    });
    const transition = evaluation.transition;
    const winner = rules.find((r) => r.id === transition?.ruleId);
    let reason: string | null = previous
      ? 'DUPLICATE_EVENT'
      : delivery.automationVersion !== 1
        ? 'ROLLOUT_BOUNDARY'
        : (evaluation.blockers[0] ?? (!transition ? 'NO_ENABLED_MATCH' : null));
    if (!reason && !winner) reason = 'NO_ENABLED_MATCH';
    if (!reason && winner) reason = automationBoundary(winner, delivery.receivedAt, o.data);
    if (!reason && winner) {
      const authorizer = await tx.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: c.workspaceId,
            userId: winner.automationAuthorizedById!,
          },
        },
      });
      if (!authorizer || authorizer.role === 'MEMBER') reason = 'AUTHORIZATION_REVOKED';
    }
    if (!reason && transition?.alreadyAtTarget) reason = 'ALREADY_AT_TARGET';
    await tx.gitHubWorkflowExecution.create({
      data: {
        workspaceId: c.workspaceId,
        projectId: c.projectId,
        repositoryId: c.repositoryId,
        connectionId: c.id,
        deliveryId: delivery.id,
        observationId: id,
        objectId: o.objectId,
        eventKey,
        claimKey: previous ? null : eventKey,
        duplicateOfId: previous?.id,
        ruleId: winner?.id,
        ruleVersion: winner?.version,
        ...(winner ? { ruleSnapshot: json(winner) } : {}),
        taskId: transition?.taskId,
        taskProjectId: transition ? c.projectId : null,
        ...(transition ? { taskSnapshot: json(transition) } : {}),
        expectedTaskVersion: transition?.taskVersion,
        previousStatus: transition?.from,
        targetStatus: transition?.to,
        evaluation: json(evaluation),
        state: ['RULE_CONFLICT', 'STATE_CONFLICT'].includes(reason ?? '')
          ? 'CONFLICTED'
          : reason
            ? 'SKIPPED'
            : 'PENDING',
        reason,
        completedAt: reason ? new Date() : null,
      },
    });
  }
}
/** One short SQL-only stage; PostgreSQL locks are the crash-recoverable claim. */
async function lockExecution(
  tx: Prisma.TransactionClient,
  candidate: GitHubWorkflowExecution,
  wait = false,
) {
  const lock = wait ? Prisma.sql`FOR UPDATE` : Prisma.sql`FOR UPDATE SKIP LOCKED`;
  const projects = await tx.$queryRaw<{ archivedAt: Date | null }[]>(
    Prisma.sql`SELECT "archivedAt" FROM "Project" WHERE "id"=${candidate.projectId} AND "workspaceId"=${candidate.workspaceId} ${lock}`,
  );
  if (!projects.length) return null;
  await tx.$queryRaw`SELECT "id" FROM "GitHubRepositoryConnection" WHERE "id"=${candidate.connectionId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "GitHubWebhookDelivery" WHERE "id"=${candidate.deliveryId} FOR UPDATE`;
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT "id" FROM "GitHubWorkflowExecution" WHERE "id"=${candidate.id} AND "state"='PENDING' AND "availableAt" <= clock_timestamp() FOR UPDATE SKIP LOCKED`;
  if (!rows.length) return null;
  const execution = await tx.gitHubWorkflowExecution.findUniqueOrThrow({
    where: { id: candidate.id },
  });
  return { execution, archived: !!projects[0].archivedAt };
}
async function applyExecution(
  tx: Prisma.TransactionClient,
  execution: GitHubWorkflowExecution,
  archived: boolean,
) {
  const startedAt = new Date();
  const finish = (
    state: 'SKIPPED' | 'CONFLICTED' | 'APPLIED' | 'FAILED',
    reason: string,
    result?: unknown,
  ) =>
    tx.gitHubWorkflowExecution.update({
      where: { id: execution.id },
      data: {
        state,
        reason,
        startedAt,
        completedAt: new Date(),
        attempts: { increment: 1 },
        ...(result ? { result: json(result) } : {}),
      },
    });
  if (!execution.taskId || !execution.ruleId) return finish('SKIPPED', 'TARGET_DELETED');
  await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id"=${execution.taskId} AND "projectId"=${execution.projectId} FOR UPDATE`;
  const {
    observation: o,
    rules,
    evaluation,
  } = await evaluateStoredGitHubWorkflow(
    tx,
    execution,
    execution.projectId,
    execution.observationId,
    false,
    archived,
  );
  if (
    o.connectionId !== execution.connectionId ||
    o.deliveryId !== execution.deliveryId ||
    o.objectId !== execution.objectId ||
    o.repositoryId !== execution.repositoryId ||
    o.connection.workspaceId !== execution.workspaceId ||
    o.connection.projectId !== execution.projectId
  )
    return finish('FAILED', 'IDENTITY_MISMATCH');
  if (o.delivery.automationVersion !== 1) return finish('SKIPPED', 'ROLLOUT_BOUNDARY');
  const rule = rules.find((r) => r.id === execution.ruleId);
  if (!rule || !rule.enabled || rule.deletedAt) return finish('SKIPPED', 'RULE_DISABLED');
  if (rule.version !== execution.ruleVersion) return finish('CONFLICTED', 'RULE_CHANGED');
  const boundary = automationBoundary(rule, o.delivery.receivedAt, o.data);
  if (boundary) return finish('SKIPPED', boundary);
  const authorizers = await tx.$queryRaw<
    { role: string }[]
  >`SELECT "role" FROM "WorkspaceMember" WHERE "workspaceId"=${execution.workspaceId} AND "userId"=${rule.automationAuthorizedById} FOR SHARE`;
  if (!authorizers.length || !['OWNER', 'ADMIN'].includes(authorizers[0].role))
    return finish('SKIPPED', 'AUTHORIZATION_REVOKED');
  if (evaluation.blockers.length) return finish('SKIPPED', evaluation.blockers[0], evaluation);
  const next = evaluation.transition;
  if (
    !next ||
    next.ruleId !== execution.ruleId ||
    next.ruleVersion !== execution.ruleVersion ||
    next.to !== execution.targetStatus ||
    next.taskId !== execution.taskId
  )
    return finish('CONFLICTED', 'RULE_SELECTION_CHANGED', evaluation);
  const current = await tx.task.findFirst({
    where: {
      id: execution.taskId,
      projectId: execution.projectId,
      project: { workspaceId: execution.workspaceId },
    },
  });
  if (!current) return finish('SKIPPED', 'TARGET_DELETED');
  if (
    current.version !== execution.expectedTaskVersion ||
    current.status !== execution.previousStatus
  )
    return finish('CONFLICTED', 'TASK_VERSION_CHANGED');
  if (current.status === next.to) return finish('SKIPPED', 'ALREADY_AT_TARGET');
  const parsed = taskUpdateSchema.safeParse({ version: current.version, status: next.to });
  if (!parsed.success || scheduleError(current)) return finish('SKIPPED', 'TASK_VALIDATION_FAILED');
  const changed = await tx.task.updateMany({
    where: {
      id: current.id,
      projectId: execution.projectId,
      project: { workspaceId: execution.workspaceId },
      version: execution.expectedTaskVersion!,
      status: execution.previousStatus!,
    },
    data: { ...taskStatusFields(next.to, current.completedAt), version: { increment: 1 } },
  });
  if (changed.count !== 1) return finish('CONFLICTED', 'TASK_VERSION_CHANGED');
  await tx.taskActivity.create({
    data: {
      workspaceId: execution.workspaceId,
      taskId: current.id,
      actorId: null,
      source: 'GITHUB_AUTOMATION',
      executionId: execution.id,
      message: `moved DEV-${String(current.number).padStart(3, '0')} from ${statusNames[current.status]} to ${statusNames[next.to]} · PR #${o.object.key} · ${rule.name} (v${rule.version})`,
    },
  });
  return finish('APPLIED', 'STATUS_CHANGED', {
    taskVersion: current.version + 1,
    from: current.status,
    to: next.to,
  });
}
export async function processNextGitHubAutomation(
  options: WorkerOptions,
  onAttempt?: (connectionId: string) => void,
) {
  const candidates = await db.gitHubWorkflowExecution.findMany({
    where: {
      state: 'PENDING',
      availableAt: { lte: new Date() },
      ...(options.connectionId ? { connectionId: options.connectionId } : {}),
    },
    take: 16,
    orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
  });
  for (const candidate of candidates) {
    try {
      const result = await db.$transaction(async (tx) => {
        const locked = await lockExecution(tx, candidate);
        if (!locked) return null;
        if (locked.execution.attempts >= options.maxAttempts)
          return tx.gitHubWorkflowExecution.update({
            where: { id: candidate.id },
            data: { state: 'FAILED', reason: 'ATTEMPTS_EXHAUSTED', completedAt: new Date() },
          });
        return applyExecution(tx, locked.execution, locked.archived);
      });
      if (!result) continue;
      console.log(
        JSON.stringify({
          component: 'github-automation',
          id: result.id,
          state: result.state,
          reason: result.reason,
        }),
      );
    } catch (error) {
      const failure = automationFailure(error);
      // The application transaction rolled back. Persist bounded failure scheduling separately;
      // re-lock in the same order, never overwrite a terminal result from another worker.
      await db.$transaction(async (tx) => {
        const locked = await lockExecution(tx, candidate, true);
        if (!locked) return;
        const attempts = locked.execution.attempts + 1;
        const terminal = !failure.retryable || attempts >= options.maxAttempts;
        await tx.gitHubWorkflowExecution.update({
          where: { id: candidate.id },
          data: {
            state: terminal ? 'FAILED' : 'PENDING',
            reason: failure.code,
            attempts,
            availableAt: new Date(Date.now() + retryDelay(attempts)),
            startedAt: new Date(),
            completedAt: terminal ? new Date() : null,
          },
        });
      });
      console.log(
        JSON.stringify({
          component: 'github-automation',
          id: candidate.id,
          state: 'error',
          reason: failure.code,
        }),
      );
    }
    // Report an attempt only after the action/failure transaction has settled.
    onAttempt?.(candidate.connectionId);
    return true;
  }
  return false;
}
