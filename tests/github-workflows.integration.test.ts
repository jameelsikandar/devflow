import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
    delete: (name: string) => jar.delete(name),
  }),
}));
import { GET, POST } from '../src/app/api/[...path]/route';
import { createSession } from '../src/lib/server/auth';
import { db } from '../src/lib/server/db';
import {
  listGitHubWorkflowRules,
  mutateGitHubWorkflowRule,
  previewGitHubWorkflow,
  gitHubWorkflowHistory,
} from '../src/lib/server/github-workflows';
import type { WorkflowDefinition } from '../src/lib/github-workflows';
import type { GitHubWorkflowRule, Prisma } from '@prisma/client';
let connected = false;
const users: string[] = [];
const workspaces: string[] = [];
let userId: string;
let memberId: string;
let workspaceId: string;
let foreignWorkspace: string;
const actor = () => ({ userId, workspaceId, name: 'Rule owner' });
beforeAll(async () => {
  await db.$connect();
  connected = true;
  for (const name of ['owner', 'member'])
    users.push(
      (
        await db.user.create({
          data: { name, email: `rules-${randomUUID()}@example.com`, passwordHash: 'not-a-login' },
        })
      ).id,
    );
  [userId, memberId] = users;
  workspaceId = (
    await db.workspace.create({
      data: {
        name: 'Workflow test',
        members: {
          create: [
            { userId, role: 'OWNER' },
            { userId: memberId, role: 'MEMBER' },
          ],
        },
      },
    })
  ).id;
  foreignWorkspace = (await db.workspace.create({ data: { name: 'Foreign rules' } })).id;
  workspaces.push(workspaceId, foreignWorkspace);
});
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('No external requests permitted')));
});
afterAll(async () => {
  if (connected) {
    await db.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
  }
  vi.unstubAllGlobals();
  await db.$disconnect();
});
async function fixture() {
  const project = await db.project.create({ data: { workspaceId, name: 'Workflow project' } });
  const connection = await db.gitHubRepositoryConnection.create({
    data: {
      projectId: project.id,
      workspaceId,
      repositoryId: '123',
      repositoryFullName: 'owner/repo',
      encryptedWebhookSecret: 'not-used',
    },
  });
  const task = await db.task.create({
    data: { projectId: project.id, title: 'Read only target', status: 'TODO', version: 9 },
  });
  const sourceUpdatedAt = new Date().toISOString();
  const data = {
    repositoryId: '123',
    action: 'closed',
    number: 12,
    state: 'closed',
    merged: true,
    sourceUpdatedAt,
    mergeCommitSha: null,
    taskRefs: [`DEV-${String(task.number).padStart(3, '0')}`],
  };
  const object = await db.gitHubObject.create({
    data: {
      workspaceId,
      projectId: project.id,
      repositoryId: '123',
      kind: 'PULL_REQUEST',
      key: '12',
      currentData: data,
      sourceUpdatedAt,
    },
  });
  const delivery = await db.gitHubWebhookDelivery.create({
    data: {
      connectionId: connection.id,
      deliveryId: randomUUID(),
      payloadHash: randomUUID(),
      event: 'pull_request',
      dataVersion: 2,
      state: 'PROCESSED',
      data,
    },
  });
  const observation = await db.gitHubObservation.create({
    data: {
      projectId: project.id,
      repositoryId: '123',
      connectionId: connection.id,
      deliveryId: delivery.id,
      objectId: object.id,
      data,
      unresolvedRefs: [],
    },
  });
  await db.gitHubTaskLink.create({
    data: {
      projectId: project.id,
      repositoryId: '123',
      objectId: object.id,
      taskId: task.id,
      evidence: { create: { observationId: observation.id } },
    },
  });
  const definition: WorkflowDefinition = {
    name: 'PR merged → Done',
    connectionId: connection.id,
    trigger: 'PR_MERGED',
    targetStatus: 'DONE',
    enabled: false,
    priority: 100,
  };
  const create = async (patch = {}) =>
    (
      await mutateGitHubWorkflowRule(actor(), project.id, 'CREATE', {
        requestId: randomUUID(),
        automationConfirmed: true,
        definition: { ...definition, ...patch },
      })
    ).rule as unknown as GitHubWorkflowRule;
  return { project, connection, task, object, delivery, observation, data, definition, create };
}
it('stores disabled definitions, immutable audit versions and idempotent creation receipts', async () => {
  const f = await fixture();
  const input = { requestId: randomUUID(), definition: f.definition };
  const concurrent = await Promise.all(
    [1, 2].map(() => mutateGitHubWorkflowRule(actor(), f.project.id, 'CREATE', input)),
  );
  expect(concurrent.map((r) => r.replayed).sort()).toEqual([false, true]);
  const first = concurrent.find((r) => !r.replayed)!;
  expect(await mutateGitHubWorkflowRule(actor(), f.project.id, 'CREATE', input)).toEqual({
    ...first,
    replayed: true,
  });
  await expect(
    mutateGitHubWorkflowRule(actor(), f.project.id, 'CREATE', {
      ...input,
      definition: { ...f.definition, enabled: true },
    }),
  ).rejects.toMatchObject({ status: 409 });
  const page = await listGitHubWorkflowRules(actor(), f.project.id);
  expect(page.rules).toHaveLength(1);
  expect(page.rules[0].enabled).toBe(false);
  const history = await gitHubWorkflowHistory(actor(), f.project.id);
  expect(history.items).toHaveLength(1);
  expect(history.items[0]).toMatchObject({ version: 1, actorId: userId, operation: 'CREATE' });
});
it('enforces admin access, workspace ownership and project-scoped connection identity', async () => {
  const f = await fixture();
  for (const operation of [
    () => listGitHubWorkflowRules({ ...actor(), userId: memberId }, f.project.id),
    () =>
      mutateGitHubWorkflowRule({ ...actor(), userId: memberId }, f.project.id, 'CREATE', {
        requestId: randomUUID(),
        automationConfirmed: true,
        definition: f.definition,
      }),
    () =>
      previewGitHubWorkflow({ ...actor(), userId: memberId }, f.project.id, {
        observationId: f.observation.id,
      }),
    () => gitHubWorkflowHistory({ ...actor(), userId: memberId }, f.project.id),
  ])
    await expect(operation()).rejects.toMatchObject({ status: 403 });
  await expect(
    listGitHubWorkflowRules({ ...actor(), workspaceId: foreignWorkspace }, f.project.id),
  ).rejects.toMatchObject({ status: 404 });
  const other = await fixture();
  await expect(
    mutateGitHubWorkflowRule(actor(), f.project.id, 'CREATE', {
      requestId: randomUUID(),
      definition: { ...f.definition, connectionId: other.connection.id },
    }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    previewGitHubWorkflow(actor(), f.project.id, { observationId: other.observation.id }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    db.gitHubWorkflowRule.create({
      data: {
        ...f.definition,
        workspaceId,
        projectId: f.project.id,
        connectionId: other.connection.id,
      },
    }),
  ).rejects.toMatchObject({ code: 'P2003' });
  await expect(
    db.gitHubWorkflowRule.create({
      data: { ...f.definition, workspaceId: foreignWorkspace, projectId: f.project.id },
    }),
  ).rejects.toMatchObject({ code: 'P2003' });
});
it('serializes concurrent updates, rejects stale versions and retains deletion history', async () => {
  const f = await fixture();
  const rule = await f.create();
  const outcomes = await Promise.allSettled(
    [1, 2].map((priority) =>
      mutateGitHubWorkflowRule(
        actor(),
        f.project.id,
        'UPDATE',
        { requestId: randomUUID(), expectedVersion: 1, definition: { ...f.definition, priority } },
        rule.id,
      ),
    ),
  );
  expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.find((o) => o.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
  const deletion = { requestId: randomUUID(), expectedVersion: 2 };
  await mutateGitHubWorkflowRule(actor(), f.project.id, 'DELETE', deletion, rule.id);
  expect(
    (await mutateGitHubWorkflowRule(actor(), f.project.id, 'DELETE', deletion, rule.id)).replayed,
  ).toBe(true);
  expect((await listGitHubWorkflowRules(actor(), f.project.id)).rules).toHaveLength(0);
  const revisions = (await gitHubWorkflowHistory(actor(), f.project.id)).items;
  expect(revisions.map((r) => r.version)).toEqual([3, 2, 1]);
  expect(revisions[0].operation).toBe('DELETE');
});
it('previews stored evidence repeatedly without changing any task or creating execution effects', async () => {
  const f = await fixture();
  await f.create();
  const before = await db.task.findUniqueOrThrow({ where: { id: f.task.id } });
  const revisions = await db.gitHubWorkflowRuleRevision.count({
    where: { projectId: f.project.id },
  });
  const noDisabled = await previewGitHubWorkflow(actor(), f.project.id, {
    observationId: f.observation.id,
  });
  expect(noDisabled.transition).toBeNull();
  const preview = await previewGitHubWorkflow(actor(), f.project.id, {
    observationId: f.observation.id,
    includeDisabled: true,
  });
  expect(preview.transition).toMatchObject({
    from: 'TODO',
    to: 'DONE',
    taskVersion: 9,
    hypothetical: true,
  });
  expect(
    await previewGitHubWorkflow(actor(), f.project.id, {
      observationId: f.observation.id,
      includeDisabled: true,
    }),
  ).toEqual(preview);
  expect(await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).toEqual(before);
  expect(await db.taskActivity.count({ where: { taskId: f.task.id } })).toBe(0);
  expect(await db.gitHubWorkflowRuleRevision.count({ where: { projectId: f.project.id } })).toBe(
    revisions,
  );
  expect(fetch).not.toHaveBeenCalled();
});
it('blocks contradictory top-priority rules and reports lower-priority overrides', async () => {
  const f = await fixture();
  await f.create({ enabled: true });
  await f.create({ enabled: true, targetStatus: 'IN_REVIEW' });
  const preview = () =>
    previewGitHubWorkflow(actor(), f.project.id, { observationId: f.observation.id });
  expect((await preview()).blockers).toContain('RULE_CONFLICT');
  const r = (await listGitHubWorkflowRules(actor(), f.project.id)).rules[0];
  await mutateGitHubWorkflowRule(
    actor(),
    f.project.id,
    'UPDATE',
    {
      requestId: randomUUID(),
      expectedVersion: r.version,
      automationConfirmed: true,
      definition: { ...f.definition, targetStatus: r.targetStatus, enabled: true, priority: 1 },
    },
    r.id,
  );
  expect((await preview()).transition?.ruleId).toBe(r.id);
});
it('rejects duplicate webhook facts and does not duplicate observations on preview', async () => {
  const f = await fixture();
  await f.create({ enabled: true });
  const d = await db.gitHubWebhookDelivery.create({
    data: {
      connectionId: f.connection.id,
      deliveryId: randomUUID(),
      payloadHash: randomUUID(),
      event: 'pull_request',
      dataVersion: 2,
      data: f.data,
      state: 'PROCESSED',
    },
  });
  const o = await db.gitHubObservation.create({
    data: {
      projectId: f.project.id,
      repositoryId: '123',
      objectId: f.object.id,
      connectionId: f.connection.id,
      deliveryId: d.id,
      data: f.data,
      unresolvedRefs: [],
      receivedAt: new Date(Date.now() + 1000),
    },
  });
  expect(
    (await previewGitHubWorkflow(actor(), f.project.id, { observationId: o.id })).blockers,
  ).toContain('DUPLICATE_EVENT');
  expect(await db.gitHubObservation.count({ where: { objectId: f.object.id } })).toBe(2);
});
it('handles disconnection, incomplete data, legacy timestamps and stale source projections safely', async () => {
  const f = await fixture();
  await f.create({ enabled: true });
  const preview = () =>
    previewGitHubWorkflow(actor(), f.project.id, { observationId: f.observation.id });
  await db.gitHubRepositoryConnection.update({
    where: { id: f.connection.id },
    data: { disconnectedAt: new Date() },
  });
  expect((await preview()).blockers).toContain('DISCONNECTED');
  const r = (await listGitHubWorkflowRules(actor(), f.project.id)).rules[0];
  await mutateGitHubWorkflowRule(
    actor(),
    f.project.id,
    'UPDATE',
    { requestId: randomUUID(), expectedVersion: 1, definition: f.definition },
    r.id,
  );
  await expect(f.create({ enabled: true })).rejects.toMatchObject({ status: 409 });
  await db.gitHubObservation.update({
    where: { id: f.observation.id },
    data: { unresolvedRefs: ['DEV-999999'], incomplete: true },
  });
  expect((await preview()).blockers).toContain('INCOMPLETE');
  await db.gitHubWebhookDelivery.update({ where: { id: f.delivery.id }, data: { dataVersion: 1 } });
  expect((await preview()).blockers).toContain('MISSING_DATA');
  await db.gitHubWebhookDelivery.update({ where: { id: f.delivery.id }, data: { dataVersion: 2 } });
  await db.gitHubObject.update({
    where: { id: f.object.id },
    data: { sourceUpdatedAt: new Date(Date.now() + 1000) },
  });
  expect((await preview()).blockers).toContain('STALE_EVENT');
});
it('uses original webhook facts rather than enriched or later association facts', async () => {
  const f = await fixture();
  await f.create({ enabled: true });
  await db.gitHubObservation.update({
    where: { id: f.observation.id },
    data: {
      data: {
        webhook: { ...f.data, action: 'synchronize' },
        enrichment: f.data,
      } as Prisma.InputJsonValue,
    },
  });
  expect(
    (await previewGitHubWorkflow(actor(), f.project.id, { observationId: f.observation.id }))
      .blockers,
  ).toContain('UNSUPPORTED_ACTION');
  await db.gitHubObservation.update({
    where: { id: f.observation.id },
    data: { data: { ...f.data, taskRefs: ['DEV-999999'] } },
  });
  expect(
    (await previewGitHubWorkflow(actor(), f.project.id, { observationId: f.observation.id }))
      .blockers,
  ).toContain('NO_TASK');
});

it('enforces authenticated API scope, safe origin checks and strict request validation', async () => {
  const f = await fixture();
  const call = (
    method: 'GET' | 'POST',
    suffix = '',
    body?: unknown,
    origin = 'http://localhost:3000',
  ) => {
    const path = `projects/${f.project.id}/github-workflows${suffix}`;
    return { GET, POST }[method](
      new Request(`http://localhost:3000/api/${path}?workspaceId=${workspaceId}`, {
        method,
        headers: { origin, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      { params: Promise.resolve({ path: path.split('/') }) },
    );
  };
  jar.clear();
  expect((await call('GET')).status).toBe(401);
  await createSession(userId);
  expect((await call('GET')).status).toBe(200);
  expect(
    (
      await call(
        'POST',
        '',
        { requestId: randomUUID(), definition: f.definition },
        'https://evil.example',
      )
    ).status,
  ).toBe(403);
  expect(
    (await call('POST', '', { requestId: randomUUID(), definition: f.definition, execute: true }))
      .status,
  ).toBe(400);
  expect(
    (await call('POST', '', { requestId: randomUUID(), definition: f.definition })).status,
  ).toBe(200);
  expect(
    (await call('POST', '/preview', { observationId: f.observation.id, includeDisabled: true }))
      .status,
  ).toBe(200);
  expect((await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).version).toBe(9);
  await createSession(memberId);
  expect((await call('GET')).status).toBe(403);
  jar.clear();
});
