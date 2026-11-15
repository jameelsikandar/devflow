import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, afterEach, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { withTransactionAbort } from './transaction-abort';
import { db } from '../src/lib/server/db';
import { processNextGitHubDelivery } from '../src/lib/server/github-job';
import { processNextGitHubAutomation } from '../src/lib/server/github-automation';
import { publishGitHubFacts } from '../src/lib/server/github-activity';
import { githubEventFacts } from '../src/lib/server/github-event-handlers';
import {
  claimGitHubDelivery,
  completeGitHubDelivery,
  workerOptions,
} from '../src/lib/server/github-processing';
import {
  mutateGitHubWorkflowRule,
  previewGitHubWorkflow,
} from '../src/lib/server/github-workflows';
import { listGitHubWorkflowExecutions } from '../src/lib/server/github-automation-monitoring';
import { disconnectRepository } from '../src/lib/server/github-repositories';
import type { GitHubWorkflowRule } from '@prisma/client';
let connected = false;
const users: string[] = [];
const workspaces: string[] = [];
let userId: string;
let memberId: string;
let workspaceId: string;
let foreignWorkspace: string;
const actor = () => ({ userId, workspaceId, name: 'Automation owner' });
beforeAll(async () => {
  await db.$connect();
  connected = true;
  for (const name of ['owner', 'member'])
    users.push(
      (
        await db.user.create({
          data: {
            name,
            email: `automation-${randomUUID()}@example.com`,
            passwordHash: 'not-a-login',
          },
        })
      ).id,
    );
  [userId, memberId] = users;
  workspaceId = (
    await db.workspace.create({
      data: {
        name: 'Automation test',
        members: {
          create: [
            { userId, role: 'OWNER' },
            { userId: memberId, role: 'MEMBER' },
          ],
        },
      },
    })
  ).id;
  foreignWorkspace = (await db.workspace.create({ data: { name: 'Foreign automation' } })).id;
  workspaces.push(workspaceId, foreignWorkspace);
});
beforeEach(async () => {
  if (connected)
    await db.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId } },
      data: { role: 'OWNER' },
    });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new Error('No live GitHub/Groq request allowed')),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  if (connected) {
    await db.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
  }
  await db.$disconnect();
});
async function fixture(enabled = true, automationVersion = 1) {
  const project = await db.project.create({ data: { workspaceId, name: 'Automation project' } });
  const connection = await db.gitHubRepositoryConnection.create({
    data: {
      workspaceId,
      projectId: project.id,
      repositoryId: '123',
      repositoryFullName: 'owner/repo',
      encryptedWebhookSecret: 'not-used',
      connectedById: userId,
    },
  });
  const task = await db.task.create({
    data: {
      projectId: project.id,
      title: 'Protected target',
      description: 'Keep description',
      status: 'TODO',
      priority: 'HIGH',
      assigneeId: memberId,
      position: 1234,
      version: 0,
    },
  });
  const definition = {
    name: 'PR merged → Done',
    connectionId: connection.id,
    trigger: 'PR_MERGED',
    targetStatus: 'DONE',
    enabled,
    priority: 100,
  };
  const rule = (
    await mutateGitHubWorkflowRule(actor(), project.id, 'CREATE', {
      requestId: randomUUID(),
      automationConfirmed: true,
      definition,
    })
  ).rule as unknown as GitHubWorkflowRule;
  // Deterministic signed-event fixture time is after activation, within allowed clock skew; no sleeps.
  const sourceUpdatedAt = new Date(Date.now() + 1000).toISOString();
  const data = {
    repositoryId: '123',
    action: 'closed',
    number: 1,
    state: 'closed',
    merged: true,
    mergeCommitSha: null,
    sourceUpdatedAt,
    taskRefs: [`DEV-${String(task.number).padStart(3, '0')}`],
  };
  const delivery = await db.gitHubWebhookDelivery.create({
    data: {
      connectionId: connection.id,
      deliveryId: randomUUID(),
      payloadHash: randomUUID(),
      event: 'pull_request',
      dataVersion: 2,
      automationVersion,
      data,
      receivedAt: new Date(sourceUpdatedAt),
    },
  });
  const options = workerOptions.parse({ connectionId: connection.id });
  const plan = async () => {
    expect(await processNextGitHubDelivery(options)).toBe(true);
    return db.gitHubWorkflowExecution.findFirstOrThrow({ where: { deliveryId: delivery.id } });
  };
  const apply = () => processNextGitHubAutomation(options);
  const current = () => db.task.findUniqueOrThrow({ where: { id: task.id } });
  const execution = () =>
    db.gitHubWorkflowExecution.findFirstOrThrow({ where: { deliveryId: delivery.id } });
  return {
    project,
    connection,
    task,
    rule,
    definition,
    delivery,
    options,
    data,
    plan,
    apply,
    current,
    execution,
  };
}
it('applies an enabled merged-PR rule once, atomically writing machine activity and preserving unrelated fields', async () => {
  const f = await fixture();
  const planned = await f.plan();
  expect(planned).toMatchObject({ state: 'PENDING', expectedTaskVersion: 0, ruleVersion: 1 });
  expect((await f.current()).status).toBe('TODO');
  await f.apply();
  const after = await f.current();
  const {
    status: _status,
    version: _version,
    completedAt: _date,
    updatedAt: _updated,
    ...unchanged
  } = f.task;
  expect(after).toMatchObject(unchanged);
  expect(after).toMatchObject({ status: 'DONE', version: 1, completedAt: expect.any(Date) });
  expect([_status, _version, _date, _updated]).toHaveLength(4);
  expect((await f.execution()).state).toBe('APPLIED');
  const events = await db.taskActivity.findMany({ where: { taskId: f.task.id } });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    actorId: null,
    source: 'GITHUB_AUTOMATION',
    executionId: planned.id,
  });
  expect(events[0].message).toContain('from Todo to Done');
  expect(events[0].message).toContain('PR #1');
  expect(await f.apply()).toBe(false);
  expect((await f.current()).version).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
});
it('never executes disabled rules or dry runs', async () => {
  const f = await fixture(false);
  expect((await f.plan()).state).toBe('SKIPPED');
  const observation = await db.gitHubObservation.findFirstOrThrow({
    where: { deliveryId: f.delivery.id },
  });
  expect(
    (
      await previewGitHubWorkflow(actor(), f.project.id, {
        observationId: observation.id,
        includeDisabled: true,
      })
    ).transition,
  ).not.toBeNull();
  await f.apply();
  expect(await f.current()).toEqual(f.task);
  expect(await db.taskActivity.count({ where: { taskId: f.task.id } })).toBe(0);
});
it('never retroactively executes pre-upgrade pending events', async () => {
  const f = await fixture(true, 0);
  expect(await f.plan()).toMatchObject({ state: 'SKIPPED', reason: 'ROLLOUT_BOUNDARY' });
  await f.apply();
  expect(await f.current()).toEqual(f.task);
});
it('treats previously enabled M3.3 rules as preview-only until confirmation', async () => {
  const f = await fixture();
  await db.gitHubWorkflowRule.update({
    where: { id: f.rule.id },
    data: { automationEnabledAt: null, automationAuthorizedById: null },
  });
  expect(await f.plan()).toMatchObject({ state: 'SKIPPED', reason: 'PREVIEW_ONLY_RULE' });
  expect((await f.current()).version).toBe(0);
});
it('blocks delayed old events and source events older than seven days', async () => {
  for (const age of [10000, 8 * 86400000]) {
    const f = await fixture();
    const data = { ...f.data, sourceUpdatedAt: new Date(Date.now() - age).toISOString() };
    await db.gitHubWebhookDelivery.update({ where: { id: f.delivery.id }, data: { data } });
    const e = await f.plan();
    expect(e.state).toBe('SKIPPED');
    expect(['EVENT_BEFORE_ENABLE', 'STALE_EVENT']).toContain(e.reason);
    expect(await f.current()).toEqual(f.task);
  }
});
it('uses database event identity to suppress distinct redeliveries without duplicating task activity', async () => {
  const f = await fixture();
  await f.plan();
  await f.apply();
  const repeat = await db.gitHubWebhookDelivery.create({
    data: {
      connectionId: f.connection.id,
      deliveryId: randomUUID(),
      payloadHash: randomUUID(),
      event: 'pull_request',
      dataVersion: 2,
      automationVersion: 1,
      data: f.data,
      receivedAt: new Date(Date.now() + 2000),
    },
  });
  await processNextGitHubDelivery(f.options);
  expect(
    await db.gitHubWorkflowExecution.findFirstOrThrow({ where: { deliveryId: repeat.id } }),
  ).toMatchObject({ state: 'SKIPPED', reason: 'DUPLICATE_EVENT', claimKey: null });
  expect(
    await db.gitHubWorkflowExecution.count({
      where: { projectId: f.project.id, claimKey: { not: null } },
    }),
  ).toBe(1);
  expect(await db.taskActivity.count({ where: { taskId: f.task.id } })).toBe(1);
  expect((await f.current()).version).toBe(1);
});
it('serializes competing workers so only one can commit a transition', async () => {
  const f = await fixture();
  await f.plan();
  await Promise.all([f.apply(), f.apply(), f.apply()]);
  expect((await f.execution()).state).toBe('APPLIED');
  expect((await f.current()).version).toBe(1);
  expect(await db.taskActivity.count({ where: { taskId: f.task.id } })).toBe(1);
});
it('rolls back a crash after status/activity writes and safely resumes the pending execution', async () => {
  const f = await fixture();
  await f.plan();
  const original = db.$transaction;
  const { transactionResult } = await withTransactionAbort(
    db,
    new Prisma.PrismaClientKnownRequestError('simulated transaction abort', {
      code: 'P2034',
      clientVersion: '6',
    }),
    f.apply,
  );
  // Prove the crash happened after the actual status/activity callback, not before it.
  expect(transactionResult).toMatchObject({ state: 'APPLIED', reason: 'STATUS_CHANGED' });
  expect(db.$transaction).toBe(original);
  expect(await f.current()).toEqual(f.task);
  expect(await db.taskActivity.count({ where: { taskId: f.task.id } })).toBe(0);
  expect(await f.execution()).toMatchObject({
    state: 'PENDING',
    attempts: 1,
    reason: 'DATABASE_TRANSIENT_FAILURE',
  });
  await db.gitHubWorkflowExecution.update({
    where: { id: (await f.execution()).id },
    data: { availableAt: new Date(0) },
  });
  await f.apply();
  expect((await f.current()).version).toBe(1);
  expect(await db.taskActivity.count({ where: { taskId: f.task.id } })).toBe(1);
});
it('persists terminal sanitized failures and bounded exhausted attempts without mutating tasks', async () => {
  const f = await fixture();
  await f.plan();
  const original = db.$transaction;
  const { transactionResult } = await withTransactionAbort(
    db,
    new Error('private-token-must-not-appear'),
    f.apply,
  );
  expect(transactionResult).toMatchObject({ state: 'APPLIED', reason: 'STATUS_CHANGED' });
  expect(db.$transaction).toBe(original);
  expect(await f.execution()).toMatchObject({
    state: 'FAILED',
    reason: 'EXECUTION_INVALID',
    attempts: 1,
  });
  expect(await f.current()).toEqual(f.task);
  const g = await fixture();
  const e = await g.plan();
  await db.gitHubWorkflowExecution.update({
    where: { id: e.id },
    data: { attempts: g.options.maxAttempts },
  });
  await g.apply();
  expect(await g.execution()).toMatchObject({ state: 'FAILED', reason: 'ATTEMPTS_EXHAUSTED' });
});
it.each(['disable', 'edit', 'task', 'disconnect', 'demote', 'source'] as const)(
  'revalidates %s changes after planning',
  async (change) => {
    const f = await fixture();
    await f.plan();
    if (change === 'disable')
      await mutateGitHubWorkflowRule(
        actor(),
        f.project.id,
        'UPDATE',
        {
          requestId: randomUUID(),
          expectedVersion: 1,
          definition: { ...f.definition, enabled: false },
        },
        f.rule.id,
      );
    if (change === 'edit')
      await mutateGitHubWorkflowRule(
        actor(),
        f.project.id,
        'UPDATE',
        {
          requestId: randomUUID(),
          expectedVersion: 1,
          automationConfirmed: true,
          definition: { ...f.definition, name: 'Edited rule' },
        },
        f.rule.id,
      );
    if (change === 'task')
      await db.task.update({
        where: { id: f.task.id },
        data: { version: { increment: 1 }, title: 'User edit wins' },
      });
    if (change === 'disconnect') await disconnectRepository(actor(), f.connection.id);
    if (change === 'demote')
      await db.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId } },
        data: { role: 'MEMBER' },
      });
    if (change === 'source')
      await db.gitHubObject.updateMany({
        where: { projectId: f.project.id },
        data: { sourceUpdatedAt: new Date(Date.now() + 5000) },
      });
    const before = await f.current();
    await f.apply();
    expect(await f.current()).toEqual(before);
    expect(['SKIPPED', 'CONFLICTED']).toContain((await f.execution()).state);
    if (change === 'demote')
      await db.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId } },
        data: { role: 'OWNER' },
      });
  },
);
it('blocks equal-priority conflicts and ambiguous multiple task references', async () => {
  const f = await fixture();
  await mutateGitHubWorkflowRule(actor(), f.project.id, 'CREATE', {
    requestId: randomUUID(),
    automationConfirmed: true,
    definition: { ...f.definition, targetStatus: 'IN_REVIEW' },
  });
  expect(await f.plan()).toMatchObject({ state: 'CONFLICTED', reason: 'RULE_CONFLICT' });
  expect(await f.current()).toEqual(f.task);
  const g = await fixture();
  const other = await db.task.create({ data: { projectId: g.project.id, title: 'Second target' } });
  await db.gitHubWebhookDelivery.update({
    where: { id: g.delivery.id },
    data: { data: { ...g.data, taskRefs: [...g.data.taskRefs, `DEV-${other.number}`] } },
  });
  expect(await g.plan()).toMatchObject({ state: 'SKIPPED', reason: 'AMBIGUOUS_TASKS' });
  expect(await g.current()).toEqual(g.task);
});
it('cannot resolve or mutate foreign-project/workspace task references', async () => {
  const f = await fixture();
  const foreign = await db.project.create({
    data: { workspaceId: foreignWorkspace, name: 'Foreign' },
  });
  const target = await db.task.create({ data: { projectId: foreign.id, title: 'Do not touch' } });
  await db.gitHubWebhookDelivery.update({
    where: { id: f.delivery.id },
    data: { data: { ...f.data, taskRefs: [`DEV-${target.number}`] } },
  });
  expect((await f.plan()).state).toBe('SKIPPED');
  expect(await db.task.findUniqueOrThrow({ where: { id: target.id } })).toEqual(target);
  expect((await f.current()).version).toBe(0);
  await expect(
    listGitHubWorkflowExecutions({ ...actor(), userId: memberId }, f.project.id),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    listGitHubWorkflowExecutions({ ...actor(), workspaceId: foreignWorkspace }, f.project.id),
  ).rejects.toMatchObject({ status: 404 });
});
it('requires admin confirmation on enable and preserves history boundaries', async () => {
  const f = await fixture(false);
  await expect(
    mutateGitHubWorkflowRule(
      actor(),
      f.project.id,
      'UPDATE',
      {
        requestId: randomUUID(),
        expectedVersion: 1,
        definition: { ...f.definition, enabled: true },
      },
      f.rule.id,
    ),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    mutateGitHubWorkflowRule(
      { ...actor(), userId: memberId },
      f.project.id,
      'UPDATE',
      {
        requestId: randomUUID(),
        expectedVersion: 1,
        automationConfirmed: true,
        definition: { ...f.definition, enabled: true },
      },
      f.rule.id,
    ),
  ).rejects.toMatchObject({ status: 403 });
  expect(
    (await db.gitHubWorkflowRule.findUniqueOrThrow({ where: { id: f.rule.id } })).enabled,
  ).toBe(false);
});
it('enforces task scope and machine actor constraints at the database boundary', async () => {
  const f = await fixture();
  const e = await f.plan();
  const other = await db.project.create({ data: { workspaceId, name: 'Other' } });
  const target = await db.task.create({ data: { projectId: other.id, title: 'Foreign target' } });
  await expect(
    db.gitHubWorkflowExecution.update({
      where: { id: e.id },
      data: { taskProjectId: other.id, taskId: target.id },
    }),
  ).rejects.toBeTruthy();
  await expect(
    db.taskActivity.create({
      data: {
        workspaceId,
        taskId: f.task.id,
        actorId: userId,
        source: 'GITHUB_AUTOMATION',
        executionId: e.id,
        message: 'bad human attribution',
      },
    }),
  ).rejects.toBeTruthy();
  await f.apply();
  const page = await listGitHubWorkflowExecutions(actor(), f.project.id, 0, 'APPLIED');
  expect(page.total).toBe(1);
  expect(page.items[0]).toMatchObject({
    state: 'APPLIED',
    prUrl: 'https://github.com/owner/repo/pull/1',
  });
  expect(JSON.stringify(page)).not.toContain('encryptedWebhookSecret');
});

it('does not discover or replay already-processed M3.3 observations when a rule is enabled', async () => {
  const f = await fixture(false, 0);
  const lease = await claimGitHubDelivery(f.options);
  expect(lease).not.toBeNull();
  await completeGitHubDelivery(lease!, (tx, context) =>
    publishGitHubFacts(tx, context, githubEventFacts('pull_request', 2, f.data)),
  );
  await mutateGitHubWorkflowRule(
    actor(),
    f.project.id,
    'UPDATE',
    {
      requestId: randomUUID(),
      expectedVersion: 1,
      automationConfirmed: true,
      definition: { ...f.definition, enabled: true },
    },
    f.rule.id,
  );
  expect(await processNextGitHubDelivery(f.options)).toBe(false);
  expect(await f.apply()).toBe(false);
  expect(await db.gitHubWorkflowExecution.count({ where: { projectId: f.project.id } })).toBe(0);
  expect(await f.current()).toEqual(f.task);
  expect(
    (await db.gitHubWebhookDelivery.findUniqueOrThrow({ where: { id: f.delivery.id } })).state,
  ).toBe('PROCESSED');
});
it('denies ordinary-member edit and delete operations', async () => {
  const f = await fixture(false);
  for (const operation of ['UPDATE', 'DELETE'] as const)
    await expect(
      mutateGitHubWorkflowRule(
        { ...actor(), userId: memberId },
        f.project.id,
        operation,
        {
          requestId: randomUUID(),
          expectedVersion: 1,
          ...(operation === 'UPDATE' ? { definition: f.definition } : {}),
        },
        f.rule.id,
      ),
    ).rejects.toMatchObject({ status: 403 });
});
