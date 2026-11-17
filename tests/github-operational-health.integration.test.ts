import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
  }),
}));
import { db } from '../src/lib/server/db';
import { digest } from '../src/lib/server/crypto';
import { githubOperationalHealth } from '../src/lib/server/github-operational-health';
import { GET } from '../src/app/api/[...path]/route';
const users: string[] = [];
const workspaces: string[] = [];
let workspaceId: string;
let foreignWorkspace: string;
let connected = false;
const sessions: string[] = [];
const actor = (index = 0, scope = workspaceId) => ({
  userId: users[index],
  workspaceId: scope,
  name: 'Fixture admin',
});
beforeAll(async () => {
  await db.$connect();
  connected = true;
  for (const name of ['owner', 'admin', 'member', 'outsider']) {
    users.push(
      (
        await db.user.create({
          data: {
            name,
            email: `health-summary-${randomUUID()}@example.com`,
            passwordHash: 'not-a-login',
          },
        })
      ).id,
    );
  }
  workspaceId = (
    await db.workspace.create({
      data: {
        name: 'Health summary fixture',
        members: {
          create: [
            { userId: users[0], role: 'OWNER' },
            { userId: users[1], role: 'ADMIN' },
            { userId: users[2], role: 'MEMBER' },
          ],
        },
      },
    })
  ).id;
  workspaces.push(workspaceId);
  foreignWorkspace = (
    await db.workspace.create({
      data: {
        name: 'Foreign health fixture',
        members: { create: { userId: users[3], role: 'OWNER' } },
      },
    })
  ).id;
  workspaces.push(foreignWorkspace);
  for (const userId of users) {
    const session = randomUUID();
    sessions.push(session);
    await db.session.create({
      data: { userId, tokenHash: digest(session), expiresAt: new Date(Date.now() + 3600000) },
    });
  }
});
beforeEach(() => {
  jar.clear();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('No live requests permitted')));
});
afterAll(async () => {
  try {
    if (connected) {
      await db.workspace.deleteMany({ where: { id: { in: workspaces } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
    }
  } finally {
    await db.$disconnect();
    vi.unstubAllGlobals();
  }
});
async function fixture(scope = workspaceId) {
  const project = await db.project.create({
    data: { workspaceId: scope, name: 'Operational summary' },
  });
  const c = await db.gitHubRepositoryConnection.create({
    data: {
      workspaceId: scope,
      projectId: project.id,
      repositoryId: '123',
      repositoryFullName: 'fixture/repo',
      encryptedWebhookSecret: 'fixture-not-a-secret',
    },
  });
  const scopeFields = { workspaceId: scope, projectId: project.id, connectionId: c.id };
  const signal = () => ({
    runId: randomUUID(),
    ...scopeFields,
    mode: 'CONTINUOUS' as const,
    staleAfterMs: 45000,
    polledAt: new Date(),
    idleAt: new Date(),
  });
  const delivery = (
    state: 'PENDING' | 'FAILED' | 'PROCESSING' | 'PROCESSED' | 'CANCELLED' = 'PENDING',
    extra: Record<string, unknown> = {},
  ) =>
    db.gitHubWebhookDelivery.create({
      data: {
        connectionId: c.id,
        deliveryId: randomUUID(),
        payloadHash: randomUUID(),
        event: 'ping',
        data: { private: 'private payload' },
        state,
        ...extra,
      },
    });
  return { project, c, scopeFields, signal, delivery };
}
async function get(id: string, scope = workspaceId) {
  return GET(
    new Request(`http://localhost:3000/api/github/repositories/${id}/health?workspaceId=${scope}`),
    { params: Promise.resolve({ path: ['github', 'repositories', id, 'health'] }) },
  );
}
it('serves authenticated owner/admin no-store reads and leaves tasks, rules and receipts unchanged', async () => {
  const f = await fixture();
  const task = await db.task.create({
    data: { projectId: f.project.id, title: 'Untouched fixture', version: 9 },
  });
  const d = await f.delivery();
  for (const index of [0, 1]) {
    jar.set('devflow_session', sessions[index]);
    const response = await get(f.c.id);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const data = await response.json();
    expect(data.worker.state).toBe('INSUFFICIENT_EVIDENCE');
    expect(data.deliveries).toMatchObject({
      total: 1,
      pending: 1,
      ready: 1,
      scheduled: 0,
      deadLettered: 0,
    });
    expect(data.automation.total).toBe(0);
    expect(JSON.stringify(data)).not.toMatch(
      /private payload|encrypted|runId|payloadHash|leaseToken|fixture-not-a-secret/,
    );
  }
  expect(await db.task.findUniqueOrThrow({ where: { id: task.id } })).toEqual(task);
  expect(await db.gitHubWebhookDelivery.findUniqueOrThrow({ where: { id: d.id } })).toEqual(d);
  expect(await db.taskActivity.count({ where: { workspaceId } })).toBe(0);
  expect(await db.gitHubWorkflowRule.count({ where: { projectId: f.project.id } })).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});
it('rejects unauthenticated, member, nonmember and foreign-workspace administrator reads', async () => {
  const f = await fixture();
  expect((await get(f.c.id)).status).toBe(401);
  jar.set('devflow_session', sessions[2]);
  expect((await get(f.c.id)).status).toBe(403);
  await expect(githubOperationalHealth(actor(3), f.c.id)).rejects.toMatchObject({ status: 404 });
  jar.set('devflow_session', sessions[3]);
  expect((await get(f.c.id, foreignWorkspace)).status).toBe(404);
  expect((await get(f.c.id, workspaceId)).status).toBe(404);
  const foreign = await fixture(foreignWorkspace);
  await expect(githubOperationalHealth(actor(), foreign.c.id)).rejects.toMatchObject({
    status: 404,
  });
});
it('preserves healthy idle evidence behind more than 100 stalled replicas and excludes other projects', async () => {
  const f = await fixture();
  const other = await fixture();
  await db.gitHubWorkerSignal.createMany({
    data: [
      { ...f.signal(), heartbeatAt: new Date(Date.now() - 1000) },
      ...Array.from({ length: 110 }, () => ({ ...f.signal(), polledAt: null, idleAt: null })),
    ],
  });
  expect((await githubOperationalHealth(actor(), f.c.id)).worker.state).toBe('HEALTHY_IDLE');
  expect((await githubOperationalHealth(actor(), other.c.id)).worker.state).toBe(
    'INSUFFICIENT_EVIDENCE',
  );
  await other.delivery();
  expect((await githubOperationalHealth(actor(), f.c.id)).deliveries.total).toBe(0);
});
it('distinguishes bounded, unavailable and live-but-unproven evidence', async () => {
  const f = await fixture();
  await db.gitHubWorkerSignal.create({ data: { ...f.signal(), mode: 'BOUNDED' } });
  expect((await githubOperationalHealth(actor(), f.c.id)).worker.state).toBe('BOUNDED_RUN');
  await db.gitHubWorkerSignal.create({ data: { ...f.signal(), heartbeatAt: new Date(0) } });
  expect((await githubOperationalHealth(actor(), f.c.id)).worker.state).toBe('UNAVAILABLE');
  await db.gitHubWorkerSignal.create({ data: { ...f.signal(), polledAt: null } });
  expect((await githubOperationalHealth(actor(), f.c.id)).worker.state).toBe(
    'INSUFFICIENT_EVIDENCE',
  );
});
it('returns disconnected and archived states even when persisted heartbeats are fresh', async () => {
  const f = await fixture();
  await db.gitHubWorkerSignal.create({ data: f.signal() });
  await db.gitHubRepositoryConnection.update({
    where: { id: f.c.id },
    data: { disconnectedAt: new Date() },
  });
  expect((await githubOperationalHealth(actor(), f.c.id)).worker.state).toBe('DISCONNECTED');
  const g = await fixture();
  await db.gitHubWorkerSignal.create({ data: g.signal() });
  await db.project.update({ where: { id: g.project.id }, data: { archivedAt: new Date() } });
  expect((await githubOperationalHealth(actor(), g.c.id)).worker.state).toBe('PROJECT_ARCHIVED');
});
it('separates current backlog, future backoff, expired leases and terminal receipts without disclosing errors', async () => {
  const f = await fixture();
  const future = new Date(Date.now() + 3600000);
  await f.delivery();
  await f.delivery('FAILED', {
    availableAt: future,
    attempts: 1,
    errorCode: 'private error/token',
  });
  await f.delivery('PROCESSING', { leaseExpiresAt: new Date(0) });
  await f.delivery('PROCESSING');
  await f.delivery('FAILED', { deadLetteredAt: new Date(), errorCode: 'private secret' });
  await f.delivery('PROCESSED', { processedAt: new Date() });
  await f.delivery('CANCELLED');
  const result = await githubOperationalHealth(actor(), f.c.id);
  expect(result.deliveries).toMatchObject({
    total: 7,
    pending: 1,
    failed: 2,
    ready: 1,
    scheduled: 1,
    processing: 2,
    expiredLeases: 2,
    deadLettered: 1,
    processed: 1,
    cancelled: 1,
    nextScheduledAt: future,
  });
  expect(result.deliveries.oldestReadyAt).not.toBeNull();
  expect(JSON.stringify(result)).not.toMatch(/private|token|secret/);
});
it('aggregates workflow lifecycle without executing actions or returning private snapshots', async () => {
  const f = await fixture();
  const object = await db.gitHubObject.create({
    data: {
      workspaceId,
      projectId: f.project.id,
      repositoryId: '123',
      kind: 'PULL_REQUEST',
      key: '1',
    },
  });
  for (const state of [
    'PENDING',
    'PENDING',
    'APPLIED',
    'SKIPPED',
    'CONFLICTED',
    'FAILED',
  ] as const) {
    const d = await f.delivery('PROCESSED');
    const o = await db.gitHubObservation.create({
      data: {
        projectId: f.project.id,
        repositoryId: '123',
        connectionId: f.c.id,
        deliveryId: d.id,
        objectId: object.id,
        data: { private: 'observation' },
        unresolvedRefs: [],
      },
    });
    await db.gitHubWorkflowExecution.create({
      data: {
        ...f.scopeFields,
        repositoryId: '123',
        deliveryId: d.id,
        observationId: o.id,
        objectId: object.id,
        eventKey: randomUUID(),
        evaluation: { private: 'evaluation' },
        ruleSnapshot: { private: 'rule' },
        state,
        reason: 'private reason',
        availableAt: new Date(0),
      },
    });
  }
  const latest = await db.gitHubWorkflowExecution.findFirstOrThrow({
    where: { connectionId: f.c.id, state: 'PENDING' },
  });
  await db.gitHubWorkflowExecution.update({
    where: { id: latest.id },
    data: { availableAt: new Date(Date.now() + 3600000) },
  });
  const result = await githubOperationalHealth(actor(), f.c.id);
  expect(result.automation).toMatchObject({
    total: 6,
    pending: 2,
    ready: 1,
    scheduled: 1,
    applied: 1,
    skipped: 1,
    conflicted: 1,
    failed: 1,
  });
  expect(JSON.stringify(result)).not.toMatch(/private|ruleSnapshot|evaluation|reason/);
  expect(await db.taskActivity.count({ where: { workspaceId } })).toBe(0);
});
it('rechecks administrator membership on subsequent reads', async () => {
  const f = await fixture();
  await db.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId, userId: users[1] } },
    data: { role: 'MEMBER' },
  });
  try {
    await expect(githubOperationalHealth(actor(1), f.c.id)).rejects.toMatchObject({ status: 403 });
  } finally {
    await db.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId: users[1] } },
      data: { role: 'ADMIN' },
    });
  }
});
it('isolates earlier connections within one project and shared run IDs across workspaces', async () => {
  const f = await fixture();
  const earlier = await db.gitHubRepositoryConnection.create({
    data: {
      workspaceId,
      projectId: f.project.id,
      repositoryId: '456',
      repositoryFullName: 'fixture/earlier',
      encryptedWebhookSecret: 'fixture-not-a-secret',
      disconnectedAt: new Date(),
    },
  });
  await db.gitHubWebhookDelivery.create({
    data: {
      connectionId: earlier.id,
      deliveryId: randomUUID(),
      payloadHash: randomUUID(),
      event: 'ping',
      data: {},
    },
  });
  const foreign = await fixture(foreignWorkspace);
  const sharedRun = randomUUID();
  await db.gitHubWorkerSignal.createMany({
    data: [
      { ...f.signal(), runId: sharedRun, heartbeatAt: new Date(0) },
      { ...foreign.signal(), runId: sharedRun },
    ],
  });
  const result = await githubOperationalHealth(actor(), f.c.id);
  expect(result.worker.state).toBe('UNAVAILABLE');
  expect(result.worker.lastHeartbeatAt).toEqual(new Date(0));
  expect(result.deliveries.total).toBe(0);
  expect(JSON.stringify(result)).not.toContain(sharedRun);
  const historical = await githubOperationalHealth(actor(), earlier.id);
  expect(historical.worker.state).toBe('DISCONNECTED');
  expect(historical.deliveries.total).toBe(1);
});
