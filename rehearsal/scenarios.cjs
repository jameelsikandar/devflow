/* eslint-disable @typescript-eslint/no-require-imports -- Isolated CommonJS worker/preload tooling. */
'use strict';
const { insist } = require('./policy.cjs');
const { until, delay, supervise } = require('./processes.cjs');
const assertions = require('./assertions.cjs');
const { makeFixture } = require('./fixtures.cjs');
async function runScenario(ctx, scenario, workers, emit) {
  const f = await makeFixture(ctx, scenario);
  const count = (state) =>
    f.db.gitHubWebhookDelivery.count({ where: { connectionId: f.connection.id, state } });
  const healthState = async () => (await f.health()).worker.state;
  const taskUnchanged = async () =>
    insist(JSON.stringify(await f.current()) === JSON.stringify(f.task), 'TASK_CHANGED');
  const start = async (slot, mode = 'none') => {
    workers.start(slot, f.connection.id, mode);
    await workers.ready(slot, f.db, f.connection.id);
  };
  const processed = (id) =>
    until(async () => (await f.delivery(id)).state === 'PROCESSED', 'PROCESSED');
  const sample = async () => {
    const h = await f.health();
    emit('HEALTH', {
      state: h.worker.state,
      heartbeatAt: h.worker.lastHeartbeatAt?.toISOString() ?? null,
      polledAt: h.worker.lastPollAt?.toISOString() ?? null,
    });
  };
  if (scenario === 'idle-active') {
    await start('a', 'active');
    await sample();
    const first = await f.health();
    await until(
      async () => +(await f.health()).worker.lastHeartbeatAt > +first.worker.lastHeartbeatAt,
      'HEARTBEAT_ADVANCE',
      20000,
    );
    const event = await f.push();
    await workers.gate('a', 'publish');
    const held = await f.delivery(event.delivery.id);
    insist(held.state === 'PROCESSING' && held.attempts === 1, 'NOT_PROCESSING');
    emit('LEASE', {
      state: held.state,
      attempts: held.attempts,
      leaseExpiresAt: held.leaseExpiresAt.toISOString(),
    });
    await until(
      async () => +(await f.delivery(held.id)).leaseExpiresAt > +held.leaseExpiresAt,
      'LEASE_RENEWAL',
      20000,
    );
    workers.release('a', 'publish');
    await workers.gate('a', 'post-poll');
    await until(async () => (await healthState()) === 'HEALTHY_ACTIVE', 'HEALTHY_ACTIVE', 20000);
    await sample();
    workers.release('a', 'post-poll');
    await processed(held.id);
    await workers.stop('a');
  } else if (scenario === 'graceful-shutdown') {
    await start('a', 'publish');
    const first = await f.push();
    await workers.gate('a', 'publish');
    const second = await f.push();
    workers.signal('a', 'SIGTERM');
    await until(
      () => workers.record('a').events.some((e) => e.type === 'signal-observed'),
      'SIGTERM_OBSERVED',
      10000,
    );
    insist(!workers.record('a').exit, 'DID_NOT_DRAIN');
    workers.release('a', 'publish');
    await workers.exited('a');
    await processed(first.delivery.id);
    insist((await f.delivery(second.delivery.id)).state === 'PENDING', 'CLAIM_AFTER_SIGTERM');
    const signals = await f.db.gitHubWorkerSignal.findMany({
      where: { connectionId: f.connection.id },
    });
    insist(
      signals.length === 1 && signals[0].state === 'STOPPED' && !!signals[0].endedAt,
      'SHUTDOWN_SIGNAL',
    );
  } else if (scenario === 'crash-recovery' || scenario === 'stale-owner-fencing') {
    const fence = scenario === 'stale-owner-fencing';
    await start('a', fence ? 'fence' : 'publish');
    const event = await f.push();
    await workers.gate('a', 'publish');
    const old = await f.delivery(event.delivery.id);
    workers.signal('a', fence ? 'SIGSTOP' : 'SIGKILL');
    if (!fence) await workers.exited('a', null, 'SIGKILL');
    // Real expiry and stale-heartbeat progression; never edit timestamps to pass.
    await until(
      async () => {
        const [clock] = await f.db.$queryRaw`SELECT clock_timestamp() AS now`;
        return +clock.now > +(await f.delivery(old.id)).leaseExpiresAt;
      },
      'LEASE_EXPIRY',
      60000,
    );
    await until(async () => (await healthState()) === 'UNAVAILABLE', 'STALE_HEALTH', 65000);
    await sample();
    workers.start('b', f.connection.id, fence ? 'publish' : 'none');
    if (fence) {
      await workers.gate('b', 'publish');
      const replacement = await f.delivery(old.id);
      const [clockBefore] = await f.db.$queryRaw`SELECT clock_timestamp() AS now`;
      assertions.replacement(old, replacement, clockBefore.now);
      insist((await f.objects()) === 0 && (await f.observations()) === 0, 'PREMATURE_PUBLICATION');
      workers.signal('a', 'SIGCONT');
      workers.signal('a', 'SIGTERM');
      workers.release('a', 'publish');
      await workers.exited('a');
      const result = workers.record('a').events.find((e) => e.type === 'result');
      const intact = await f.delivery(old.id);
      const [clockAfter] = await f.db.$queryRaw`SELECT clock_timestamp() AS now`;
      assertions.fenced(result, replacement, intact, clockAfter.now);
      insist((await f.objects()) === 0 && (await f.observations()) === 0, 'STALE_PUBLICATION');
      emit('FENCED', { committed: false, renewed: false, failed: false });
      workers.release('b', 'publish');
    }
    await processed(old.id);
    const recovered = await f.delivery(old.id);
    insist(recovered.attempts === 2 && recovered.leaseToken === null, 'RECOVERY_ATTEMPTS');
    await workers.ready('b', f.db, f.connection.id);
    await sample();
    insist((await f.objects()) === 1 && (await f.observations()) === 1, 'DUPLICATE_PUBLICATION');
    await workers.stop('b');
  } else if (scenario === 'retry-backoff' || scenario === 'dead-letter') {
    const dead = scenario === 'dead-letter';
    await start('a', dead ? 'retry-always' : 'retry-once');
    const event = await f.push();
    const failed = await until(
      async () => {
        const d = await f.delivery(event.delivery.id);
        return d.state === 'FAILED' && d.attempts === 1 ? d : null;
      },
      'RETRY_SCHEDULE',
      20000,
    );
    insist(failed.errorCode === 'REHEARSAL_TRANSIENT' && !failed.deadLetteredAt, 'RETRY_METADATA');
    emit('RETRY', { attempts: failed.attempts, availableAt: failed.availableAt.toISOString() });
    if (dead) {
      const terminal = await until(
        async () => {
          const d = await f.delivery(failed.id);
          return d.deadLetteredAt ? d : null;
        },
        'DEAD_LETTER',
        30000,
      );
      insist(terminal.state === 'FAILED' && terminal.attempts === 3, 'RETRY_BOUND');
      // Force a new observed poll, not an arbitrary sleep, then check no reclaim.
      await until(
        async () => {
          const [clock] = await f.db.$queryRaw`SELECT clock_timestamp() AS now`;
          return +clock.now > +terminal.availableAt;
        },
        'DEAD_LETTER_ELIGIBILITY',
        15000,
      );
      const before = (await workers.ready('a', f.db, f.connection.id)).polledAt;
      await until(
        async () => +(await workers.ready('a', f.db, f.connection.id)).polledAt > +before,
        'POST_DEAD_POLL',
        20000,
      );
      insist((await f.delivery(terminal.id)).attempts === 3, 'DEAD_RECLAIMED');
      await workers.stop('a');
      // Independent permanent fault, first attempt, using a fresh fixture scope.
      const p = await makeFixture(ctx, 'permanent');
      workers.start('permanent', p.connection.id, 'permanent');
      await workers.ready('permanent', p.db, p.connection.id);
      const evt = await p.push();
      const result = await until(
        async () => {
          const d = await p.delivery(evt.delivery.id);
          return d.deadLetteredAt ? d : null;
        },
        'PERMANENT',
        20000,
      );
      insist(
        result.attempts === 1 && result.errorCode === 'REHEARSAL_PERMANENT',
        'PERMANENT_RETRIED',
      );
      await workers.stop('permanent');
      insist(
        JSON.stringify(await p.current()) === JSON.stringify(p.task) &&
          Object.values(await p.counts()).every((n) => n === 0),
        'PERMANENT_SIDE_EFFECTS',
      );
    } else {
      await processed(failed.id);
      insist((await f.delivery(failed.id)).attempts === 2, 'RETRY_NOT_DURABLE');
      await workers.stop('a');
    }
  } else if (scenario === 'duplicate-events') {
    await start('a');
    const event = await f.push();
    await processed(event.delivery.id);
    const repeat = await f.ingest(event.event, event.value, event.deliveryId);
    const replay = await f.ingest(event.event, event.value);
    insist(repeat.receipt.duplicate && replay.receipt.duplicate, 'BODY_REPLAY');
    insist(
      (await f.db.gitHubWebhookDelivery.count({ where: { connectionId: f.connection.id } })) === 1,
      'DUPLICATE_DELIVERIES',
    );
    insist(
      (await count('PROCESSED')) === 1 &&
        (await f.objects()) === 1 &&
        (await f.observations()) === 1,
      'DUPLICATE_RECORDS',
    );
    await workers.stop('a');
  } else if (scenario === 'automation-idempotency') {
    await start('a');
    const event = await f.merged();
    await processed(event.delivery.id);
    await until(async () => (await f.current()).status === 'DONE', 'AUTOMATION');
    const after = await f.current();
    insist(after.version === 1 && (await f.activities()) === 1, 'AUTOMATION_DUPLICATE');
    const unrelated = (t) => {
      const { status, version, completedAt, updatedAt, ...rest } = t;
      void status;
      void version;
      void completedAt;
      void updatedAt;
      return rest;
    };
    insist(
      JSON.stringify(unrelated(after)) === JSON.stringify(unrelated(f.task)) && after.completedAt,
      'UNRELATED_TASK_FIELDS',
    );
    await f.ingest(event.event, event.value, event.deliveryId);
    await f.ingest(event.event, event.value);
    // Different body/hash, same source event: provenance can grow, mutation cannot.
    const distinct = await f.ingest(event.event, { ...event.value, ignored: 'different envelope' });
    await processed(distinct.delivery.id);
    await until(
      async () =>
        !!(await f.db.gitHubWorkflowExecution.findFirst({
          where: { deliveryId: distinct.delivery.id, state: 'SKIPPED', reason: 'DUPLICATE_EVENT' },
        })),
      'SEMANTIC_DUPLICATE',
    );
    await workers.stop('a');
    insist((await f.current()).version === 1 && (await f.activities()) === 1, 'AUTOMATION_REPLAY');
    const activity = await f.db.taskActivity.findFirst({
      where: { taskId: f.task.id, source: 'GITHUB_AUTOMATION' },
    });
    insist(activity.actorId === null && !!activity.executionId, 'MACHINE_ACTOR');
    insist(
      (await f.db.gitHubWebhookDelivery.count({ where: { connectionId: f.connection.id } })) === 2,
      'DUPLICATE_DELIVERIES',
    );
    emit('TASK_TRANSITION', { version: 1, count: 1 });
  } else if (scenario === 'supervisor-restart') {
    let evt;
    const result = await supervise(
      async (restart) => {
        const slot = restart === 0 ? 'a' : `replacement-${restart}`;
        if (restart === 0) {
          await start(slot, 'publish');
          evt = await f.push();
          await workers.gate(slot, 'publish');
          workers.signal(slot, 'SIGKILL');
          return workers.exited(slot, null, 'SIGKILL');
        }
        workers.start(slot, f.connection.id);
        await workers.ready(slot, f.db, f.connection.id);
        await processed(evt.delivery.id);
        insist((await f.delivery(evt.delivery.id)).attempts === 2, 'SUPERVISOR_RECOVERY');
        await workers.stop(slot);
        return workers.record(slot).exit;
      },
      delay,
      (restart) => emit('SUPERVISOR_RESTART', { restart }),
    );
    insist(result.restarts === 1 && !result.exhausted, 'SUPERVISOR_RESULT');
    const limitFixture = await makeFixture(ctx, 'supervisor-limit');
    const exhausted = await supervise(
      async (restart) => {
        const slot = `limit-${restart}`;
        workers.start(slot, limitFixture.connection.id);
        await workers.ready(slot, limitFixture.db, limitFixture.connection.id);
        workers.signal(slot, 'SIGKILL');
        return workers.exited(slot, null, 'SIGKILL');
      },
      delay,
      (restart) => emit('SUPERVISOR_RESTART', { restart }),
    );
    insist(exhausted.restarts === 2 && exhausted.exhausted, 'RESTART_LIMIT');
  } else throw new Error('REHEARSAL_UNKNOWN_SCENARIO');
  if (scenario === 'retry-backoff' || scenario === 'dead-letter') {
    const schedules = workers.record('a').events.filter((e) => e.type === 'retry-scheduled');
    insist(
      schedules.length === (scenario === 'dead-letter' ? 3 : 1) &&
        schedules.every((e) => e.positive),
      'BACKOFF_EVIDENCE',
    );
    const claims = workers.record('a').events.filter((e) => e.type === 'claimed');
    insist(
      claims.length >= 2 &&
        claims.every((e) => Date.parse(e.claimedAt) >= Date.parse(e.availableAt)),
      'EARLY_RETRY',
    );
  }
  if (
    [
      'idle-active',
      'crash-recovery',
      'stale-owner-fencing',
      'retry-backoff',
      'duplicate-events',
      'automation-idempotency',
    ].includes(scenario)
  )
    assertions.publication(await f.counts(), scenario === 'automation-idempotency');
  if (scenario === 'dead-letter')
    insist(
      Object.values(await f.counts()).every((n) => n === 0),
      'DEAD_LETTER_SIDE_EFFECTS',
    );
  if (scenario !== 'automation-idempotency') await taskUnchanged();
  await workers.drain();
}
module.exports = { runScenario };
