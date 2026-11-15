import { beforeEach, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type { GitHubWorkflowRule, GitHubWorkflowExecution } from '@prisma/client';
import type { GitHubPublishContext } from '../src/lib/server/github-processing';
import { evaluateGitHubWorkflow, type WorkflowPreviewInput } from '../src/lib/github-workflows';
const m = vi.hoisted(() => ({ transaction: vi.fn(), candidates: vi.fn(), evaluate: vi.fn() }));
vi.mock('../src/lib/server/db', () => ({
  db: { $transaction: m.transaction, gitHubWorkflowExecution: { findMany: m.candidates } },
}));
vi.mock('../src/lib/server/github-workflow-evaluation', () => ({
  evaluateStoredGitHubWorkflow: m.evaluate,
}));
import {
  automationBoundary,
  workflowEventKey,
  automationFailure,
  planGitHubAutomation,
  processNextGitHubAutomation,
} from '../src/lib/server/github-automation';
import { taskStatusFields } from '../src/lib/server/task-status';
import { workerOptions } from '../src/lib/server/github-processing';
const now = Date.now();
const source = new Date(now - 1000).toISOString();
const facts = {
  repositoryId: '123',
  action: 'closed',
  number: 1,
  state: 'closed',
  merged: true,
  sourceUpdatedAt: source,
  taskRefs: ['DEV-002'],
};
const ruleBase = {
  id: 'r',
  name: 'PR merged → Done',
  version: 1,
  trigger: 'PR_MERGED',
  targetStatus: 'DONE',
  priority: 100,
  enabled: true,
  deletedAt: null,
  connectionId: 'c',
  automationEnabledAt: new Date(now - 2000),
  automationAuthorizedById: 'admin',
  automationEnabledVersion: 1,
};
let rule: GitHubWorkflowRule;
let execution: GitHubWorkflowExecution;
let task: Record<string, unknown>;
let activities: unknown[];
let actorRole: string;
let disconnected: boolean;
let failActivity: boolean;
let extraRules: GitHubWorkflowRule[];
const opts = workerOptions.parse({ connectionId: 'c' });
const result = () => m.evaluate.mock.results.at(-1)?.value;
let tx: Record<string, unknown>;
beforeEach(() => {
  vi.resetAllMocks();
  rule = { ...ruleBase } as GitHubWorkflowRule;
  execution = {
    id: 'e',
    state: 'PENDING',
    attempts: 0,
    workspaceId: 'w',
    projectId: 'p',
    repositoryId: '123',
    connectionId: 'c',
    deliveryId: 'd',
    observationId: 'o',
    objectId: 'obj',
    ruleId: 'r',
    ruleVersion: 1,
    taskId: 't',
    expectedTaskVersion: 0,
    previousStatus: 'TODO',
    targetStatus: 'DONE',
    availableAt: new Date(0),
  } as GitHubWorkflowExecution;
  task = {
    id: 't',
    projectId: 'p',
    number: 2,
    title: 'Protected task',
    status: 'TODO',
    version: 0,
    completedAt: null,
    priority: 'HIGH',
    assigneeId: 'user',
    description: 'Keep me',
    position: 1024,
  };
  activities = [];
  actorRole = 'ADMIN';
  disconnected = false;
  failActivity = false;
  extraRules = [];
  m.evaluate.mockImplementation(async () => {
    const observation = {
      id: 'o',
      objectId: 'obj',
      connectionId: 'c',
      deliveryId: 'd',
      repositoryId: '123',
      receivedAt: new Date(),
      data: facts,
      object: { key: '1' },
      connection: {
        workspaceId: 'w',
        projectId: 'p',
        disconnectedAt: disconnected ? new Date() : null,
      },
      delivery: { id: 'd', state: 'PROCESSED', automationVersion: 1, receivedAt: new Date() },
    };
    const input = {
      observationId: 'o',
      connectionId: 'c',
      repositoryId: '123',
      objectKey: '1',
      kind: 'PULL_REQUEST',
      event: 'pull_request',
      dataVersion: 2,
      data: facts,
      currentData: facts,
      sourceUpdatedAt: source,
      disconnected,
      archived: false,
      processed: true,
      duplicate: false,
      incomplete: false,
      unresolvedRefs: [],
      tasks: [task],
    } as unknown as WorkflowPreviewInput;
    return {
      observation,
      rules: [rule, ...extraRules],
      evaluation: evaluateGitHubWorkflow(input, [rule, ...extraRules]),
    };
  });
  tx = {
    $queryRaw: async (parts: TemplateStringsArray | Prisma.Sql) =>
      (Array.isArray(parts) ? parts.join('') : (parts as Prisma.Sql).strings.join('')).includes(
        'WorkspaceMember',
      )
        ? [{ role: actorRole }]
        : [{ id: 'e', archivedAt: null }],
    gitHubWorkflowExecution: {
      findUniqueOrThrow: async () => execution,
      findUnique: async () => null,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        const { attempts, ...rest } = data;
        execution = {
          ...execution,
          ...rest,
          ...(attempts
            ? {
                attempts:
                  typeof attempts === 'number'
                    ? attempts
                    : execution.attempts + (attempts as { increment: number }).increment,
              }
            : {}),
        } as GitHubWorkflowExecution;
        return execution;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        execution = data as unknown as GitHubWorkflowExecution;
        return execution;
      },
    },
    gitHubObservation: { findMany: async () => [{ id: 'o' }] },
    workspaceMember: { findUnique: async () => ({ role: actorRole }) },
    task: {
      findFirst: async () => task,
      updateMany: async ({
        where,
        data,
      }: {
        where: { version: number };
        data: Record<string, unknown>;
      }) => {
        if (task.version !== where.version) return { count: 0 };
        const { version, ...rest } = data;
        task = {
          ...task,
          ...rest,
          version: Number(task.version) + (version as { increment: number }).increment,
        };
        return { count: 1 };
      },
    },
    taskActivity: {
      create: async ({ data }: { data: unknown }) => {
        if (failActivity) {
          failActivity = false;
          throw new Prisma.PrismaClientKnownRequestError('sanitized', {
            code: 'P2034',
            clientVersion: '6',
          });
        }
        activities.push(data);
      },
    },
  };
  m.transaction.mockImplementation(async (fn) => {
    const before = structuredClone({ execution, task, activities });
    try {
      return await fn(tx);
    } catch (e) {
      ({ execution, task, activities } = before);
      throw e;
    }
  });
  m.candidates.mockImplementation(async () =>
    execution.state === 'PENDING' && +execution.availableAt <= Date.now() ? [execution] : [],
  );
});
it('applies one status/version update with shared completion semantics and explicit machine attribution', async () => {
  const before = { ...task };
  expect(await processNextGitHubAutomation(opts)).toBe(true);
  expect(execution).toMatchObject({ state: 'APPLIED', reason: 'STATUS_CHANGED', attempts: 1 });
  expect(task).toMatchObject({
    ...before,
    status: 'DONE',
    version: 1,
    completedAt: expect.any(Date),
  });
  expect(activities).toEqual([
    expect.objectContaining({
      actorId: null,
      source: 'GITHUB_AUTOMATION',
      executionId: 'e',
      taskId: 't',
      message: expect.stringContaining('moved DEV-002 from Todo to Done'),
    }),
  ]);
  expect(await processNextGitHubAutomation(opts)).toBe(false);
  expect(activities).toHaveLength(1);
});
it.each([
  'disabled',
  'edited',
  'task changed',
  'disconnected',
  'role revoked',
  'preview only',
  'old event',
  'conflicting rules',
] as const)('safely blocks %s between evaluation and application', async (kind) => {
  if (kind === 'disabled') rule.enabled = false;
  if (kind === 'edited') rule.version = 2;
  if (kind === 'task changed') task.version = 1;
  if (kind === 'disconnected') disconnected = true;
  if (kind === 'role revoked') actorRole = 'MEMBER';
  if (kind === 'preview only') rule.automationEnabledAt = null;
  if (kind === 'old event') rule.automationEnabledAt = new Date();
  if (kind === 'conflicting rules') extraRules = [{ ...rule, id: 'r2', targetStatus: 'IN_REVIEW' }];
  const before = { ...task };
  await processNextGitHubAutomation(opts);
  expect(['SKIPPED', 'CONFLICTED']).toContain(execution.state);
  expect(task).toEqual(before);
  expect(activities).toHaveLength(0);
});
it('rolls back a crash after task CAS and retries without duplicate activity', async () => {
  failActivity = true;
  const before = { ...task };
  await processNextGitHubAutomation(opts);
  expect(task).toEqual(before);
  expect(activities).toHaveLength(0);
  expect(execution).toMatchObject({
    state: 'PENDING',
    reason: 'DATABASE_TRANSIENT_FAILURE',
    attempts: 1,
  });
  execution.availableAt = new Date(0);
  await processNextGitHubAutomation(opts);
  expect(task.version).toBe(1);
  expect(activities).toHaveLength(1);
  expect(execution.state).toBe('APPLIED');
});
it('dead-letters exhausted attempts without touching tasks', async () => {
  execution.attempts = opts.maxAttempts;
  await processNextGitHubAutomation(opts);
  expect(execution).toMatchObject({ state: 'FAILED', reason: 'ATTEMPTS_EXHAUSTED' });
  expect(task.version).toBe(0);
});
it('records original delivery planning as historical or pending, never mutating a task', async () => {
  const context = {
    connection: { id: 'c', projectId: 'p', workspaceId: 'w', repositoryId: '123' },
    delivery: { id: 'd', event: 'pull_request', automationVersion: 0, receivedAt: new Date() },
  } as GitHubPublishContext;
  await planGitHubAutomation(tx as unknown as Prisma.TransactionClient, context);
  expect(execution).toMatchObject({ state: 'SKIPPED', reason: 'ROLLOUT_BOUNDARY' });
  expect(task.version).toBe(0);
  context.delivery.automationVersion = 1;
  await planGitHubAutomation(tx as unknown as Prisma.TransactionClient, context);
  expect(execution).toMatchObject({
    state: 'PENDING',
    expectedTaskVersion: 0,
    ruleVersion: 1,
    previousStatus: 'TODO',
    targetStatus: 'DONE',
  });
  expect(activities).toHaveLength(0);
  expect(await result()).toHaveProperty('evaluation');
});
it('makes event keys independent of deliveries, task refs and rule changes, but not source identity', () => {
  const key = workflowEventKey('p', '123', '1', facts);
  expect(workflowEventKey('p', '123', '1', { ...facts, taskRefs: ['DEV-3'] })).toBe(key);
  expect(
    workflowEventKey('p', '123', '1', { webhook: facts, enrichment: { private: 'ignored' } }),
  ).toBe(key);
  expect(workflowEventKey('p2', '123', '1', facts)).not.toBe(key);
  expect(workflowEventKey('p', '123', '2', facts)).not.toBe(key);
  expect(
    workflowEventKey('p', '123', '1', { ...facts, sourceUpdatedAt: new Date(now).toISOString() }),
  ).not.toBe(key);
});
it('requires a confirmed activation and an event strictly after activation', () => {
  expect(automationBoundary(rule, new Date(), facts)).toBeNull();
  expect(automationBoundary({ ...rule, automationEnabledAt: null }, new Date(), facts)).toBe(
    'PREVIEW_ONLY_RULE',
  );
  expect(
    automationBoundary({ ...rule, automationEnabledAt: new Date(source) }, new Date(), facts),
  ).toBe('EVENT_BEFORE_ENABLE');
});
it('uses bounded safe error classifications without retaining secret error messages', () => {
  expect(automationFailure(new Error('token=secret'))).toEqual({
    retryable: false,
    code: 'EXECUTION_INVALID',
  });
  expect(
    automationFailure(
      new Prisma.PrismaClientKnownRequestError('secret', { code: 'P2034', clientVersion: '6' }),
    ).retryable,
  ).toBe(true);
});
it('reuses completion semantics when entering/leaving Done', () => {
  const date = new Date();
  expect(taskStatusFields('DONE', date).completedAt).toBe(date);
  expect(taskStatusFields('TODO', date).completedAt).toBeNull();
});

it('invalidates activation when an older client changes a rule without renewing confirmation', () => {
  expect(automationBoundary({ ...rule, version: 2 }, new Date(), facts)).toBe('PREVIEW_ONLY_RULE');
});
