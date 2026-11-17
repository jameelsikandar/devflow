import { createHmac, randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import { db } from '../src/lib/server/db';
import { encrypt } from '../src/lib/server/crypto';
import { githubOperationalHealth } from '../src/lib/server/github-operational-health';
import { githubRetentionImpact } from '../src/lib/server/github-retention';
import { ingestGitHubDelivery } from '../src/lib/server/github-repositories';
import { retryGitHubDelivery } from '../src/lib/server/github-monitoring';
import { runGitHubWorker } from '../src/lib/server/github-worker-runtime';
import {
  createWorkerHealth,
  persistWorkerSignal,
  finishWorkerSignal,
  type WorkerSignalInput,
} from '../src/lib/server/github-worker-health';
import { processNextGitHubDelivery } from '../src/lib/server/github-job';
import {
  claimGitHubDelivery,
  completeGitHubDelivery,
  failGitHubDelivery,
  recoverExpiredDeliveries,
  renewGitHubLease,
  workerOptions,
} from '../src/lib/server/github-processing';
import { GitHubProcessingError } from '../src/lib/server/github-event-handlers';
let connected = false,
  workspaceId: string,
  foreignWorkspace: string;
const users: string[] = [],
  workspaces: string[] = [];
const actor = (index = 0, workspace = workspaceId) => ({
  userId: users[index],
  workspaceId: workspace,
  name: 'Recovery owner',
});
const secret = 'isolated-recovery-webhook-secret';
beforeAll(async () => {
  await db.$connect();
  connected = true;
  for (const name of ['owner', 'member', 'outsider'])
    users.push(
      (
        await db.user.create({
          data: {
            name,
            email: `operations-recovery-${randomUUID()}@example.com`,
            passwordHash: 'not-a-login',
          },
        })
      ).id,
    );
  workspaceId = (
    await db.workspace.create({
      data: {
        name: 'Recovery fixture',
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
      data: { name: 'Foreign recovery', members: { create: { userId: users[2], role: 'OWNER' } } },
    })
  ).id;
  workspaces.push(foreignWorkspace);
});
beforeEach(() => {
  vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'ab'.repeat(32));
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new Error('No live GitHub/Groq access permitted')),
  );
});
afterAll(async () => {
  try {
    if (connected) {
      await db.workspace.deleteMany({ where: { id: { in: workspaces } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
    }
  } finally {
    await db.$disconnect();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
});
async function fixture(workspace = workspaceId) {
  const project = await db.project.create({
    data: { workspaceId: workspace, name: 'Recovery project' },
  });
  const connection = await db.gitHubRepositoryConnection.create({
    data: {
      workspaceId: workspace,
      projectId: project.id,
      repositoryId: '123',
      repositoryFullName: 'fixture/repo',
      encryptedWebhookSecret: encrypt(secret),
    },
  });
  const options = workerOptions.parse({
    connectionId: connection.id,
    concurrency: 1,
    onceLimit: 1,
    maxAttempts: 2,
  });
  const raw = Buffer.from(
    JSON.stringify({ repository: { id: 123 }, zen: 'isolated recovery ping' }),
  );
  const deliveryId = randomUUID();
  const headers = (id = deliveryId, body = raw) =>
    new Headers({
      'x-github-event': 'ping',
      'x-github-delivery': id,
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    });
  const enqueue = async () => {
    await ingestGitHubDelivery(connection.id, raw, headers());
    return db.gitHubWebhookDelivery.findUniqueOrThrow({
      where: { connectionId_deliveryId: { connectionId: connection.id, deliveryId } },
    });
  };
  return { project, connection, options, raw, headers, enqueue };
}
// Controlled flush represents the next telemetry tick, avoiding real timer sleeps.
// The separate unit journey exercises actual coalesced timer behavior.
function controlledHealth(options: ReturnType<typeof workerOptions.parse>) {
  let snapshot: WorkerSignalInput | undefined;
  const recorder = createWorkerHealth(options, false, {
    pulse: async (input) => {
      snapshot = input;
      return persistWorkerSignal(input);
    },
    finish: finishWorkerSignal,
  });
  return {
    recorder,
    poll: async (idle: boolean) => {
      await recorder.polled(idle);
      await persistWorkerSignal({ ...snapshot!, polled: true, idle, progress: [] });
    },
  };
}
it('leaves durable queued work untouched when health startup fails before claiming', async () => {
  const f = await fixture();
  const receipt = await f.enqueue();
  const health = createWorkerHealth(f.options, false, {
    pulse: vi.fn().mockRejectedValue(new Error('simulated startup storage failure')),
    finish: finishWorkerSignal,
  });
  const process = vi.fn(() => processNextGitHubDelivery(f.options));
  const recover = vi.fn(() => recoverExpiredDeliveries(2, f.connection.id));
  await expect(
    runGitHubWorker(f.options, false, new AbortController().signal, {
      health,
      process,
      recover,
      idle: vi.fn(),
    }),
  ).rejects.toThrow('simulated startup storage failure');
  expect(process).not.toHaveBeenCalled();
  expect(recover).not.toHaveBeenCalled();
  expect(await db.gitHubWebhookDelivery.findUniqueOrThrow({ where: { id: receipt.id } })).toEqual(
    receipt,
  );
  expect((await githubOperationalHealth(actor(), f.connection.id)).worker.state).toBe(
    'INSUFFICIENT_EVIDENCE',
  );
});
it('observes processing then healthy idle and graceful shutdown without task or rule changes', async () => {
  const f = await fixture();
  const receipt = await f.enqueue();
  const task = await db.task.create({
    data: { projectId: f.project.id, title: 'Untouched recovery task', status: 'TODO', version: 9 },
  });
  const rule = await db.gitHubWorkflowRule.create({
    data: {
      workspaceId,
      projectId: f.project.id,
      name: 'Disabled recovery rule',
      trigger: 'PR_MERGED',
      targetStatus: 'DONE',
    },
  });
  const controller = new AbortController();
  const health = controlledHealth(f.options);
  const states: string[] = [];
  await runGitHubWorker(f.options, false, controller.signal, {
    health: {
      ...health.recorder,
      polled: async (idle) => {
        await health.poll(idle);
        states.push((await githubOperationalHealth(actor(), f.connection.id)).worker.state);
      },
    },
    recover: () => recoverExpiredDeliveries(2, f.connection.id),
    process: () => processNextGitHubDelivery(f.options, (id) => health.recorder.progress(id)),
    idle: async () => controller.abort(),
  });
  expect(states).toEqual(['HEALTHY_ACTIVE', 'HEALTHY_IDLE']);
  expect((await githubOperationalHealth(actor(), f.connection.id)).worker.state).toBe(
    'UNAVAILABLE',
  );
  const signals = await db.gitHubWorkerSignal.findMany({
    where: { connectionId: f.connection.id },
  });
  expect(signals).toHaveLength(1);
  expect(signals[0]).toMatchObject({
    state: 'STOPPED',
    endedAt: expect.any(Date),
    progressAt: expect.any(Date),
  });
  expect(
    await db.gitHubWebhookDelivery.findUniqueOrThrow({ where: { id: receipt.id } }),
  ).toMatchObject({ state: 'PROCESSED', attempts: 1 });
  expect(await db.task.findUniqueOrThrow({ where: { id: task.id } })).toEqual(task);
  expect(await db.gitHubWorkflowRule.findUniqueOrThrow({ where: { id: rule.id } })).toEqual(rule);
  expect(await db.taskActivity.count({ where: { workspaceId } })).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});
it('recovers interrupted leases once, fences the stale owner and distinguishes bounded recovery from continuous availability', async () => {
  const f = await fixture();
  const receipt = await f.enqueue();
  const lease = (await claimGitHubDelivery(f.options))!;
  const signal: WorkerSignalInput = {
    runId: randomUUID(),
    connectionId: f.connection.id,
    once: false,
    staleAfterMs: 45000,
    polled: true,
    idle: false,
    progress: [],
  };
  await persistWorkerSignal(signal);
  const live = await githubOperationalHealth(actor(), f.connection.id);
  expect(live.worker.state).toBe('HEALTHY_ACTIVE');
  expect(live.deliveries).toMatchObject({ processing: 1, expiredLeases: 0 });
  await db.gitHubWorkerSignal.update({
    where: { runId_connectionId: { runId: signal.runId, connectionId: f.connection.id } },
    data: { heartbeatAt: new Date(0), polledAt: new Date(0), startedAt: new Date(0) },
  });
  await db.gitHubWebhookDelivery.update({
    where: { id: receipt.id },
    data: { leaseExpiresAt: new Date(0) },
  });
  const before = await githubOperationalHealth(actor(), f.connection.id);
  expect(before.worker.state).toBe('UNAVAILABLE');
  expect(before.deliveries.expiredLeases).toBe(1);
  const report = await githubRetentionImpact(actor(), f.project.id, 7);
  expect(
    report.categories
      .find((c) => c.kind === 'WORKER_SIGNALS')
      ?.reasons.some((r) => r.code === 'ACTIVE_PROCESSING'),
  ).toBe(true);
  expect(await runGitHubWorker(f.options, true, new AbortController().signal)).toBe(1);
  expect(await completeGitHubDelivery(lease)).toBe(false);
  expect(await renewGitHubLease(lease, 120)).toBe(false);
  expect(await failGitHubDelivery(lease, new Error('stale owner'), f.options)).toBe(false);
  expect(
    await db.gitHubWebhookDelivery.findUniqueOrThrow({ where: { id: receipt.id } }),
  ).toMatchObject({ state: 'PROCESSED', attempts: 2 });
  expect((await githubOperationalHealth(actor(), f.connection.id)).worker.state).toBe(
    'UNAVAILABLE',
  );
  const controller = new AbortController();
  const health = controlledHealth(f.options);
  let observed = '';
  await runGitHubWorker(f.options, false, controller.signal, {
    health: {
      ...health.recorder,
      polled: async (idle) => {
        await health.poll(idle);
        observed = (await githubOperationalHealth(actor(), f.connection.id)).worker.state;
      },
    },
    recover: () => recoverExpiredDeliveries(2, f.connection.id),
    process: () => processNextGitHubDelivery(f.options),
    idle: async () => controller.abort(),
  });
  expect(observed).toBe('HEALTHY_IDLE');
  expect(await db.gitHubWebhookDelivery.count({ where: { connectionId: f.connection.id } })).toBe(
    1,
  );
});
it('keeps retries durable through backoff and dead-lettering, then permits only an explicit authorized retry', async () => {
  const f = await fixture();
  const receipt = await f.enqueue();
  const first = (await claimGitHubDelivery(f.options))!;
  const retryAt = Date.now() + 3600000;
  await failGitHubDelivery(
    first,
    new GitHubProcessingError('WORKER_TRANSIENT_FAILURE', true, retryAt),
    f.options,
  );
  const retry = await db.gitHubWebhookDelivery.findUniqueOrThrow({ where: { id: receipt.id } });
  expect(+retry.availableAt).toBeGreaterThanOrEqual(retryAt);
  expect(await claimGitHubDelivery(f.options)).toBeNull();
  await db.gitHubWebhookDelivery.update({
    where: { id: receipt.id },
    data: { availableAt: new Date(0) },
  });
  const second = (await claimGitHubDelivery(f.options))!;
  await failGitHubDelivery(
    second,
    new GitHubProcessingError('WORKER_TRANSIENT_FAILURE', true),
    f.options,
  );
  const dead = await githubOperationalHealth(actor(), f.connection.id);
  expect(dead.deliveries).toMatchObject({ failed: 1, deadLettered: 1, ready: 0 });
  await expect(retryGitHubDelivery(actor(1), f.connection.id, receipt.id)).rejects.toMatchObject({
    status: 403,
  });
  expect(await claimGitHubDelivery(f.options)).toBeNull();
  await retryGitHubDelivery(actor(), f.connection.id, receipt.id);
  await runGitHubWorker(f.options, true, new AbortController().signal);
  expect(
    await db.gitHubWebhookDelivery.findUniqueOrThrow({ where: { id: receipt.id } }),
  ).toMatchObject({ state: 'PROCESSED', attempts: 1, deadLetteredAt: null });
  await expect(retryGitHubDelivery(actor(), f.connection.id, receipt.id)).rejects.toMatchObject({
    status: 409,
  });
  expect(await db.taskActivity.count({ where: { workspaceId, source: 'GITHUB_AUTOMATION' } })).toBe(
    0,
  );
});
it('preserves signed replay protection after recovery and never requeues processed data', async () => {
  const f = await fixture();
  const receipt = await f.enqueue();
  await runGitHubWorker(f.options, true, new AbortController().signal);
  const before = await db.gitHubWebhookDelivery.findUniqueOrThrow({ where: { id: receipt.id } });
  for (const headers of [f.headers(), f.headers(randomUUID())])
    expect(await ingestGitHubDelivery(f.connection.id, f.raw, headers)).toMatchObject({
      duplicate: true,
    });
  const invalid = f.headers(randomUUID());
  invalid.set('x-hub-signature-256', `sha256=${'0'.repeat(64)}`);
  await expect(ingestGitHubDelivery(f.connection.id, f.raw, invalid)).rejects.toMatchObject({
    status: 401,
  });
  const changed = Buffer.from(
    JSON.stringify({ repository: { id: 123 }, zen: 'different signed content' }),
  );
  await expect(
    ingestGitHubDelivery(f.connection.id, changed, f.headers(undefined, changed)),
  ).rejects.toMatchObject({ status: 409 });
  expect(await db.gitHubWebhookDelivery.count({ where: { connectionId: f.connection.id } })).toBe(
    1,
  );
  expect(await db.gitHubWebhookDelivery.findUniqueOrThrow({ where: { id: receipt.id } })).toEqual(
    before,
  );
});
it('keeps recovery diagnostics scoped and sanitized for administrators only', async () => {
  const f = await fixture(),
    other = await fixture(),
    foreign = await fixture(foreignWorkspace);
  const receipt = await f.enqueue();
  await db.gitHubWebhookDelivery.update({
    where: { id: receipt.id },
    data: { state: 'FAILED', deadLetteredAt: new Date(), errorCode: 'private credential text' },
  });
  const summary = await githubOperationalHealth(actor(), f.connection.id);
  expect(summary.deliveries.deadLettered).toBe(1);
  expect(JSON.stringify(summary)).not.toMatch(
    /private credential|encrypted|payloadHash|leaseToken|runId/,
  );
  expect((await githubOperationalHealth(actor(), other.connection.id)).deliveries.total).toBe(0);
  await expect(githubOperationalHealth(actor(1), f.connection.id)).rejects.toMatchObject({
    status: 403,
  });
  await expect(
    githubOperationalHealth(actor(2, foreignWorkspace), f.connection.id),
  ).rejects.toMatchObject({ status: 404 });
  await expect(githubOperationalHealth(actor(), foreign.connection.id)).rejects.toMatchObject({
    status: 404,
  });
});
