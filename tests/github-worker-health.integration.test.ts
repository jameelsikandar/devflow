import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { db } from '../src/lib/server/db';
import {
  persistWorkerSignal,
  finishWorkerSignal,
  classifyWorkerHealth,
  type WorkerSignalInput,
} from '../src/lib/server/github-worker-health';
import { runGitHubWorker } from '../src/lib/server/github-worker-runtime';
import { workerOptions } from '../src/lib/server/github-processing';
let workspaceId: string | undefined;
beforeAll(async () => {
  await db.$connect();
  workspaceId = (await db.workspace.create({ data: { name: 'Isolated worker health fixture' } }))
    .id;
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('No external requests allowed')));
});
afterAll(async () => {
  try {
    if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
  } finally {
    await db.$disconnect();
    vi.unstubAllGlobals();
  }
});
async function fixture() {
  const project = await db.project.create({
    data: { workspaceId: workspaceId!, name: 'Health project' },
  });
  const connection = await db.gitHubRepositoryConnection.create({
    data: {
      workspaceId: workspaceId!,
      projectId: project.id,
      repositoryId: '123',
      repositoryFullName: 'fixture/repo',
      encryptedWebhookSecret: 'not-used',
    },
  });
  const input: WorkerSignalInput = {
    runId: randomUUID(),
    connectionId: connection.id,
    once: false,
    staleAfterMs: 45000,
    polled: false,
    idle: false,
    progress: [],
  };
  const read = () =>
    db.gitHubWorkerSignal.findUniqueOrThrow({
      where: { runId_connectionId: { runId: input.runId, connectionId: connection.id } },
    });
  return { project, connection, input, read };
}
it('persists idle liveness, poll and exact-scope attempt progress without changing tasks', async () => {
  const f = await fixture();
  const task = await db.task.create({
    data: { projectId: f.project.id, title: 'Untouched', version: 8 },
  });
  await persistWorkerSignal(f.input);
  expect(classifyWorkerHealth([await f.read()], new Date())).toBe('INSUFFICIENT_EVIDENCE');
  await persistWorkerSignal({ ...f.input, polled: true, idle: true });
  const idle = await f.read();
  expect(classifyWorkerHealth([idle], new Date())).toBe('HEALTHY_IDLE');
  await persistWorkerSignal({ ...f.input, polled: true, progress: [f.connection.id] });
  const active = await f.read();
  expect(active.progressAt).not.toBeNull();
  expect(active.idleAt).toBeNull();
  await persistWorkerSignal(f.input);
  expect((await f.read()).progressAt).toEqual(active.progressAt);
  expect(await db.task.findUniqueOrThrow({ where: { id: task.id } })).toEqual(task);
  expect(await db.taskActivity.count({ where: { workspaceId } })).toBe(0);
});
it('isolates scoped workers and foreign progress, and enforces both composite scope keys', async () => {
  const a = await fixture(),
    b = await fixture();
  await persistWorkerSignal({ ...a.input, progress: [b.connection.id] });
  expect((await a.read()).progressAt).toBeNull();
  expect(await db.gitHubWorkerSignal.count({ where: { runId: a.input.runId } })).toBe(1);
  await expect(
    db.gitHubWorkerSignal.create({
      data: {
        runId: randomUUID(),
        connectionId: b.connection.id,
        workspaceId: workspaceId!,
        projectId: a.project.id,
        mode: 'CONTINUOUS',
        staleAfterMs: 45000,
      },
    }),
  ).rejects.toMatchObject({ code: 'P2003' });
  const foreign = await db.workspace.create({ data: { name: 'Foreign health' } });
  try {
    await expect(
      db.gitHubWorkerSignal.create({
        data: {
          runId: randomUUID(),
          connectionId: a.connection.id,
          workspaceId: foreign.id,
          projectId: a.project.id,
          mode: 'CONTINUOUS',
          staleAfterMs: 45000,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  } finally {
    await db.workspace.delete({ where: { id: foreign.id } });
  }
});
it('supports concurrent replicas without duplicate signal rows or revived terminal runs', async () => {
  const f = await fixture();
  await Promise.all(Array.from({ length: 4 }, () => persistWorkerSignal(f.input)));
  expect(await db.gitHubWorkerSignal.count({ where: { runId: f.input.runId } })).toBe(1);
  await finishWorkerSignal(f.input.runId, 'STOPPED');
  const ended = await f.read();
  await persistWorkerSignal({ ...f.input, polled: true, idle: true });
  await finishWorkerSignal(f.input.runId, 'FAILED');
  expect(await f.read()).toEqual(ended);
  await persistWorkerSignal({ ...f.input, runId: randomUUID() });
  expect(await db.gitHubWorkerSignal.count({ where: { connectionId: f.connection.id } })).toBe(2);
});
it('preserves historical evidence without heartbeating disconnected or archived scopes', async () => {
  const f = await fixture();
  await persistWorkerSignal(f.input);
  const before = await f.read();
  await db.gitHubRepositoryConnection.update({
    where: { id: f.connection.id },
    data: { disconnectedAt: new Date() },
  });
  expect(await persistWorkerSignal({ ...f.input, polled: true })).toBe(0);
  expect(await f.read()).toEqual(before);
  const g = await fixture();
  await db.project.update({ where: { id: g.project.id }, data: { archivedAt: new Date() } });
  expect(await persistWorkerSignal(g.input)).toBe(0);
});
it('runs two bounded workers on one verified ping without altering delivery idempotency or creating activity', async () => {
  const f = await fixture();
  const delivery = await db.gitHubWebhookDelivery.create({
    data: {
      connectionId: f.connection.id,
      deliveryId: randomUUID(),
      payloadHash: randomUUID(),
      event: 'ping',
      data: { repositoryId: f.connection.repositoryId },
    },
  });
  const options = workerOptions.parse({
    connectionId: f.connection.id,
    concurrency: 1,
    onceLimit: 1,
  });
  await Promise.all([
    runGitHubWorker(options, true, new AbortController().signal),
    runGitHubWorker(options, true, new AbortController().signal),
  ]);
  const signals = await db.gitHubWorkerSignal.findMany({
    where: { connectionId: f.connection.id },
  });
  expect(signals).toHaveLength(2);
  expect(signals.every((s) => s.state === 'COMPLETED' && s.mode === 'BOUNDED' && s.endedAt)).toBe(
    true,
  );
  expect(signals.filter((s) => s.progressAt)).toHaveLength(1);
  expect(classifyWorkerHealth(signals, new Date())).toBe('BOUNDED_RUN');
  expect(
    await db.gitHubWebhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } }),
  ).toMatchObject({ state: 'PROCESSED', attempts: 1 });
  expect(await db.taskActivity.count({ where: { workspaceId } })).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});
it('keeps crash evidence stale while a replacement continuous run can report healthy idle', async () => {
  const f = await fixture();
  await persistWorkerSignal(f.input);
  await db.gitHubWorkerSignal.update({
    where: { runId_connectionId: { runId: f.input.runId, connectionId: f.connection.id } },
    data: { heartbeatAt: new Date(0) },
  });
  expect(classifyWorkerHealth([await f.read()], new Date())).toBe('UNAVAILABLE');
  await persistWorkerSignal({ ...f.input, runId: randomUUID(), polled: true, idle: true });
  const rows = await db.gitHubWorkerSignal.findMany({ where: { connectionId: f.connection.id } });
  expect(classifyWorkerHealth(rows, new Date())).toBe('HEALTHY_IDLE');
});
it('observes disconnect races in project-before-connection lock order without reviving scope', async () => {
  const f = await fixture();
  await Promise.all([
    persistWorkerSignal(f.input),
    db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${f.project.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "GitHubRepositoryConnection" WHERE "id" = ${f.connection.id} FOR UPDATE`;
      await tx.gitHubRepositoryConnection.update({
        where: { id: f.connection.id },
        data: { disconnectedAt: new Date() },
      });
    }),
  ]);
  expect(await persistWorkerSignal({ ...f.input, polled: true, idle: true })).toBe(0);
});
