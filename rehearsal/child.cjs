/* eslint-disable @typescript-eslint/no-require-imports -- Isolated CommonJS worker/preload tooling. */
'use strict';
const { bootstrap, requestCount } = require('./guard.cjs');
const { bounded } = require('./lifecycle.cjs');
const { insist } = require('./policy.cjs');
const modes = [
  'none',
  'active',
  'publish',
  'fence',
  'retry-once',
  'retry-always',
  'permanent',
  'post-commit',
];
function send(message, callback) {
  if (process.connected) process.send(message, callback);
}
async function main() {
  const config = bootstrap();
  insist(!!process.send && process.connected, 'OWNED_IPC_REQUIRED');
  const id = process.env.REHEARSAL_CONNECTION_ID;
  const mode = process.env.REHEARSAL_GATE;
  insist(
    typeof id === 'string' && /^[a-z0-9]{20,40}$/.test(id) && modes.includes(mode),
    'CHILD_CONFIG',
  );
  // Environment is set before the first production import. No .env flag is used.
  Object.assign(process.env, {
    GITHUB_WORKER_CONNECTION_ID: id,
    GITHUB_WORKER_CONCURRENCY: '1',
    GITHUB_WORKER_LEASE_SECONDS: '30',
    GITHUB_WORKER_MAX_ATTEMPTS: '3',
    GITHUB_WORKER_POLL_MS: '1000',
    GITHUB_WORKER_ONCE_LIMIT: '25',
  });
  const { context, migrationReady, app } = require('./database.cjs');
  const { db } = await context();
  await migrationReady(db);
  const c = await db.gitHubRepositoryConnection.findUnique({
    where: { id },
    include: { project: true },
  });
  insist(
    c &&
      c.project.name.startsWith(`rehearsal-${config.runId}-`) &&
      !c.disconnectedAt &&
      c.enrichmentUserId === null &&
      c.enrichmentAuthorizedAt === null,
    'FIXTURE_CONNECTION',
  );
  insist((await db.gitHubConnection.count()) === 0, 'OAUTH_RECORD_PRESENT');
  const processing = app('github-processing');
  const health = app('github-worker-health');
  const { GitHubProcessingError } = app('github-event-handlers');
  const claim = processing.claimGitHubDelivery;
  processing.claimGitHubDelivery = async (options) => {
    if (!process.connected) {
      process.emit('SIGTERM');
      return null;
    }
    const lease = await claim(options);
    if (lease) {
      const row = await db.gitHubWebhookDelivery.findUniqueOrThrow({ where: { id: lease.id } });
      insist(+row.lockedAt >= +row.availableAt, 'EARLY_CLAIM');
      send({
        type: 'claimed',
        attempts: lease.attempts,
        claimedAt: row.lockedAt.toISOString(),
        availableAt: row.availableAt.toISOString(),
      });
    }
    return lease;
  };
  const original = processing.completeGitHubDelivery;
  const renew = processing.renewGitHubLease,
    fail = processing.failGitHubDelivery;
  const waits = new Map();
  const released = new Set();
  let publishGate = false,
    pollGate = false,
    failures = 0;
  const gate = async (name) => {
    insist(process.connected, 'IPC_LOST');
    if (released.has(name)) return;
    process.channel.ref();
    send({ type: 'gate', name });
    try {
      await bounded(new Promise((resolve) => waits.set(name, resolve)), 90000);
    } catch (error) {
      process.exitCode = 1;
      process.emit('SIGTERM');
      throw error;
    } finally {
      process.channel?.unref();
    }
  };
  process.on('disconnect', () => {
    process.emit('SIGTERM');
    for (const resolve of waits.values()) resolve();
    waits.clear();
  });
  process.on('message', (message) => {
    if (
      message?.type !== 'release' ||
      !['publish', 'post-poll', 'post-commit'].includes(message.name)
    )
      return;
    released.add(message.name);
    waits.get(message.name)?.();
    waits.delete(message.name);
  });
  processing.completeGitHubDelivery = async (lease, publish) => {
    if (
      mode === 'permanent' ||
      mode === 'retry-always' ||
      (mode === 'retry-once' && failures++ === 0)
    ) {
      send({ type: 'fault' });
      throw new GitHubProcessingError(
        mode === 'permanent' ? 'REHEARSAL_PERMANENT' : 'REHEARSAL_TRANSIENT',
        mode !== 'permanent',
      );
    }
    if (['active', 'publish', 'fence'].includes(mode) && !publishGate) {
      publishGate = true;
      await gate('publish'); // Before the real transaction; renewal is already running.
    }
    const committed = await original(lease, publish);
    if (mode === 'fence') {
      const renewed = await renew(lease, 30);
      const failed = await fail(lease, new GitHubProcessingError('REHEARSAL_STALE', true), {
        maxAttempts: 3,
      });
      send({ type: 'result', committed, renewed, failed });
    }
    if (mode === 'post-commit' && !publishGate) {
      publishGate = true;
      await gate('post-commit');
    }
    return committed;
  };
  processing.failGitHubDelivery = async (lease, error, options) => {
    const [before] = await db.$queryRaw`SELECT clock_timestamp() AS now`;
    const changed = await fail(lease, error, options);
    if (changed && error instanceof GitHubProcessingError && error.code.startsWith('REHEARSAL_')) {
      const row = await db.gitHubWebhookDelivery.findUniqueOrThrow({ where: { id: lease.id } });
      const [after] = await db.$queryRaw`SELECT clock_timestamp() AS now`;
      require('./assertions.cjs').retryWindow(before.now, after.now, row.attempts, row.availableAt);
      send({
        type: 'retry-scheduled',
        attempts: row.attempts,
        availableAt: row.availableAt.toISOString(),
        positive: true,
      });
    }
    return changed;
  };
  const create = health.createWorkerHealth;
  health.createWorkerHealth = (options, once) => {
    let runId;
    const recorder = create(options, once, {
      pulse: async (input) => {
        const count = await health.persistWorkerSignal(input);
        if (count) {
          if (!runId) {
            runId = input.runId;
            send({ type: 'health-run', runId });
          }
          if (input.polled) send({ type: 'polled', runId: input.runId, idle: input.idle });
        }
        return count;
      },
      finish: health.finishWorkerSignal,
    });
    const polled = recorder.polled.bind(recorder);
    recorder.polled = async (idle) => {
      await polled(idle);
      if (mode === 'active' && !idle && !pollGate) {
        pollGate = true;
        await gate('post-poll'); // Real periodic telemetry runs; no fake database clock.
      }
    };
    return recorder;
  };
  process.once('beforeExit', () => {
    if (process.connected)
      send({ type: 'http-count', count: requestCount() }, () => {
        if (process.connected) process.disconnect();
      });
  });
  send({ type: 'booted' });
  require('/work/.worker/scripts/github-worker.js');
  // Production installed its abort handler synchronously; observe, never replace it.
  process.on('SIGTERM', () => send({ type: 'signal-observed', signal: 'SIGTERM' }));
  // IPC would otherwise keep the real CLI alive after its work drains. Keeping a
  // listener still permits releases while the CLI is alive; unref removes liveness.
  process.channel.unref();
}
if (require.main === module)
  main().catch(() => {
    console.error('REHEARSAL_CHILD_FAILED');
    process.exitCode = 1;
    process.disconnect?.();
  });
