import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { db } from '../src/lib/server/db';
import { githubRetentionImpact, retentionQueries } from '../src/lib/server/github-retention';
import { RETENTION_SCAN_LIMIT } from '../src/lib/github-retention';
const users: string[] = [],
  workspaces: string[] = [];
let workspaceId: string,
  foreignWorkspace: string,
  connected = false;
const actor = (index = 0, workspace = workspaceId) => ({
  userId: users[index],
  workspaceId: workspace,
  name: 'Retention admin',
});
const now = new Date('2026-11-18T12:00:00Z'),
  old = new Date('2026-08-01T00:00:00Z');
beforeAll(async () => {
  await db.$connect();
  connected = true;
  for (const role of ['owner', 'member', 'outsider'])
    users.push(
      (
        await db.user.create({
          data: {
            name: role,
            email: `retention-${randomUUID()}@example.com`,
            passwordHash: 'fixture-not-a-login',
          },
        })
      ).id,
    );
  workspaceId = (
    await db.workspace.create({
      data: {
        name: 'Retention fixture',
        members: {
          create: [
            { userId: users[0], role: 'OWNER' },
            { userId: users[1], role: 'MEMBER' },
          ],
        },
      },
    })
  ).id;
  workspaces.push(workspaceId);
  foreignWorkspace = (
    await db.workspace.create({
      data: { name: 'Foreign retention', members: { create: { userId: users[2], role: 'OWNER' } } },
    })
  ).id;
  workspaces.push(foreignWorkspace);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('No external reads allowed')));
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
  const p = await db.project.create({ data: { workspaceId: scope, name: 'Retention project' } });
  const c = await db.gitHubRepositoryConnection.create({
    data: {
      workspaceId: scope,
      projectId: p.id,
      repositoryId: '123',
      repositoryFullName: 'fixture/repo',
      encryptedWebhookSecret: 'fixture-not-used',
    },
  });
  const delivery = (
    state: 'PROCESSED' | 'PENDING' | 'FAILED' | 'PROCESSING' = 'PROCESSED',
    at = old,
  ) =>
    db.gitHubWebhookDelivery.create({
      data: {
        connectionId: c.id,
        deliveryId: randomUUID(),
        payloadHash: randomUUID(),
        event: 'ping',
        state,
        receivedAt: at,
        data: { private: 'never-return-this' },
      },
    });
  return { p, c, delivery };
}
async function bucket(projectId: string, kind: string, days: number) {
  const cutoff = new Date(+now - days * 86400000);
  const query = retentionQueries(workspaceId, projectId, cutoff, now).find((q) => q.kind === kind)!;
  return db.$queryRaw<{ reason: string; count: string }[]>(query.sql);
}
it('authorizes administrators, denies members/nonmembers/foreign projects and reports empty scope', async () => {
  const f = await fixture(),
    foreign = await fixture(foreignWorkspace);
  await expect(githubRetentionImpact(actor(1), f.p.id)).rejects.toMatchObject({ status: 403 });
  await expect(githubRetentionImpact(actor(2), f.p.id)).rejects.toMatchObject({ status: 404 });
  await expect(githubRetentionImpact(actor(2, foreignWorkspace), f.p.id)).rejects.toMatchObject({
    status: 404,
  });
  await expect(githubRetentionImpact(actor(), foreign.p.id)).rejects.toMatchObject({ status: 404 });
  const report = await githubRetentionImpact(actor(), f.p.id);
  expect(report.complete).toBe(true);
  expect(report.categories.every((c) => c.total === 0)).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
it.each([7, 30, 90])(
  'classifies exact %i-day cutoff as within-window using the production query',
  async (days) => {
    const f = await fixture();
    const cutoff = +now - days * 86400000;
    await f.delivery('PROCESSED', new Date(cutoff - 1));
    await f.delivery('PROCESSED', new Date(cutoff));
    await f.delivery('PROCESSED', new Date(cutoff + 1));
    const rows = await bucket(f.p.id, 'DELIVERIES', days);
    expect(rows.find((r) => r.reason === 'REPLAY_PROTECTION')?.count).toBe('1');
    expect(rows.find((r) => r.reason === 'WITHIN_WINDOW')?.count).toBe('2');
  },
);
it('preserves complete provenance/audit relationships and does not change records', async () => {
  const f = await fixture(),
    d = await f.delivery();
  const t = await db.task.create({
    data: { projectId: f.p.id, title: 'Untouched retention fixture', version: 8 },
  });
  const o = await db.gitHubObject.create({
    data: {
      workspaceId,
      projectId: f.p.id,
      repositoryId: '123',
      kind: 'PULL_REQUEST',
      key: '1',
      createdAt: old,
      currentData: { private: 'projection' },
    },
  });
  const obs = await db.gitHubObservation.create({
    data: {
      projectId: f.p.id,
      repositoryId: '123',
      connectionId: f.c.id,
      deliveryId: d.id,
      objectId: o.id,
      data: { private: 'observation' },
      unresolvedRefs: [],
      receivedAt: old,
    },
  });
  await db.gitHubTaskLink.create({
    data: { projectId: f.p.id, repositoryId: '123', objectId: o.id, taskId: t.id, createdAt: old },
  });
  await db.gitHubTaskLinkEvidence.create({
    data: { objectId: o.id, taskId: t.id, observationId: obs.id },
  });
  const execution = await db.gitHubWorkflowExecution.create({
    data: {
      workspaceId,
      projectId: f.p.id,
      repositoryId: '123',
      connectionId: f.c.id,
      deliveryId: d.id,
      observationId: obs.id,
      objectId: o.id,
      eventKey: randomUUID(),
      state: 'APPLIED',
      createdAt: old,
      completedAt: old,
      evaluation: { private: 'evaluation' },
    },
  });
  const activity = await db.taskActivity.create({
    data: {
      workspaceId,
      taskId: t.id,
      executionId: execution.id,
      source: 'GITHUB_AUTOMATION',
      message: 'Isolated fixture',
    },
  });
  const result = await githubRetentionImpact(actor(), f.p.id, 7);
  for (const kind of [
    'DELIVERIES',
    'OBSERVATIONS',
    'OBJECTS',
    'TASK_LINKS',
    'LINK_EVIDENCE',
    'EXECUTIONS',
  ])
    expect(result.categories.find((c) => c.kind === kind)).toMatchObject({
      total: 1,
      older: 1,
      preservedOlder: 1,
      potentiallyEligible: 0,
    });
  expect(result.categories.find((c) => c.kind === 'DELIVERIES')?.dependencyProtectedOlder).toBe(1);
  expect(result.categories.find((c) => c.kind === 'EXECUTIONS')?.dependencyProtectedOlder).toBe(1);
  expect(JSON.stringify(result)).not.toMatch(
    /never-return-this|projection|evaluation|runId|payloadHash|encryptedWebhookSecret/,
  );
  expect(await db.task.findUniqueOrThrow({ where: { id: t.id } })).toEqual(t);
  expect(await db.gitHubWebhookDelivery.findUniqueOrThrow({ where: { id: d.id } })).toEqual(d);
  expect(
    await db.gitHubWorkflowExecution.findUniqueOrThrow({ where: { id: execution.id } }),
  ).toEqual(execution);
  expect(await db.taskActivity.findUniqueOrThrow({ where: { id: activity.id } })).toEqual(activity);
});
it('keeps pending/processing/failed receipts and unresolved observations protected', async () => {
  const f = await fixture();
  for (const state of ['PENDING', 'PROCESSING', 'FAILED'] as const) await f.delivery(state);
  const d = await f.delivery();
  const o = await db.gitHubObject.create({
    data: {
      workspaceId,
      projectId: f.p.id,
      repositoryId: '123',
      kind: 'ISSUE',
      key: '2',
      createdAt: old,
    },
  });
  await db.gitHubObservation.create({
    data: {
      projectId: f.p.id,
      repositoryId: '123',
      connectionId: f.c.id,
      deliveryId: d.id,
      objectId: o.id,
      data: {},
      unresolvedRefs: ['DEV-99999'],
      incomplete: true,
      receivedAt: old,
    },
  });
  const result = await githubRetentionImpact(actor(), f.p.id);
  const deliveries = result.categories.find((c) => c.kind === 'DELIVERIES')!;
  expect(deliveries.potentiallyEligible).toBe(0);
  expect(deliveries.reasons.find((r) => r.code === 'ACTIVE_PROCESSING')?.count).toBe(2);
  expect(deliveries.reasons.find((r) => r.code === 'UNRESOLVED_STATE')?.count).toBe(1);
  expect(result.categories.find((c) => c.kind === 'OBSERVATIONS')?.reasons[0].code).toBe(
    'UNRESOLVED_STATE',
  );
});
it('protects active/failed and latest per-mode worker anchors including future clock evidence', async () => {
  const f = await fixture();
  const a = new Date(+now - 40 * 86400000),
    b = new Date(+a + 1000),
    ancient = new Date(+a - 1000),
    future = new Date(+now + 86400000);
  for (const [mode, state, at] of [
    ['CONTINUOUS', 'COMPLETED', a],
    ['CONTINUOUS', 'STOPPED', b],
    ['CONTINUOUS', 'RUNNING', ancient],
    ['CONTINUOUS', 'FAILED', ancient],
    ['BOUNDED', 'COMPLETED', a],
    ['BOUNDED', 'COMPLETED', b],
    ['BOUNDED', 'COMPLETED', future],
  ] as const) {
    await db.gitHubWorkerSignal.create({
      data: {
        runId: randomUUID(),
        workspaceId,
        projectId: f.p.id,
        connectionId: f.c.id,
        mode,
        state,
        startedAt: at,
        heartbeatAt: at,
        polledAt: at,
        endedAt: state === 'RUNNING' ? null : at,
        staleAfterMs: 45000,
      },
    });
  }
  const rows = await bucket(f.p.id, 'WORKER_SIGNALS', 30);
  expect(rows.find((r) => r.reason === 'POTENTIAL_CANDIDATE')?.count).toBe('2');
  expect(rows.find((r) => r.reason === 'WORKER_BASELINE')?.count).toBe('2');
  expect(rows.find((r) => r.reason === 'ACTIVE_PROCESSING')?.count).toBe('1');
  expect(rows.find((r) => r.reason === 'UNRESOLVED_STATE')?.count).toBe('1');
  expect(rows.find((r) => r.reason === 'WITHIN_WINDOW')?.count).toBe('1');
});
it('includes disconnected history while isolating other projects/workspaces', async () => {
  const f = await fixture(),
    other = await fixture(),
    foreign = await fixture(foreignWorkspace);
  await db.gitHubRepositoryConnection.update({
    where: { id: f.c.id },
    data: { disconnectedAt: new Date() },
  });
  await f.delivery();
  await other.delivery();
  await foreign.delivery();
  expect(
    (await githubRetentionImpact(actor(), f.p.id)).categories.find((c) => c.kind === 'DELIVERIES')
      ?.total,
  ).toBe(1);
});
it('fails closed at the per-category scan bound without fetching payloads', async () => {
  const f = await fixture();
  for (let i = 0; i <= RETENTION_SCAN_LIMIT; i += 1000) {
    const count = Math.min(1000, RETENTION_SCAN_LIMIT + 1 - i);
    await db.gitHubWebhookDelivery.createMany({
      data: Array.from({ length: count }, () => ({
        connectionId: f.c.id,
        deliveryId: randomUUID(),
        payloadHash: randomUUID(),
        event: 'ping',
        state: 'PROCESSED' as const,
        receivedAt: old,
        data: { private: 'not-returned' },
      })),
    });
  }
  const report = await githubRetentionImpact(actor(), f.p.id);
  expect(report.complete).toBe(false);
  expect(report.categories.find((c) => c.kind === 'DELIVERIES')).toMatchObject({
    scannedAtLeast: 10001,
    complete: false,
    total: null,
    potentiallyEligible: null,
    oldestAt: null,
  });
  expect(JSON.stringify(report).length).toBeLessThan(10000);
});
it('PostgreSQL read-only transaction setting rejects writes to isolated fixtures', async () => {
  const f = await fixture();
  await expect(
    db.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.project.update({ where: { id: f.p.id }, data: { name: 'Must not change' } });
    }),
  ).rejects.toThrow();
  expect(await db.project.findUniqueOrThrow({ where: { id: f.p.id } })).toEqual(f.p);
});
it('keeps the last progress-bearing run even when a newer idle run has no progress', async () => {
  const f = await fixture();
  const earlier = new Date(+now - 40 * 86400000),
    later = new Date(+earlier + 10000);
  await db.gitHubWorkerSignal.createMany({
    data: [
      {
        runId: randomUUID(),
        workspaceId,
        projectId: f.p.id,
        connectionId: f.c.id,
        mode: 'CONTINUOUS',
        state: 'STOPPED',
        startedAt: earlier,
        heartbeatAt: earlier,
        polledAt: earlier,
        progressAt: earlier,
        endedAt: earlier,
        staleAfterMs: 45000,
      },
      {
        runId: randomUUID(),
        workspaceId,
        projectId: f.p.id,
        connectionId: f.c.id,
        mode: 'CONTINUOUS',
        state: 'STOPPED',
        startedAt: later,
        heartbeatAt: later,
        polledAt: later,
        endedAt: later,
        staleAfterMs: 45000,
      },
    ],
  });
  const rows = await bucket(f.p.id, 'WORKER_SIGNALS', 30);
  expect(rows.find((r) => r.reason === 'WORKER_BASELINE')?.count).toBe('2');
  expect(rows.some((r) => r.reason === 'POTENTIAL_CANDIDATE')).toBe(false);
});
