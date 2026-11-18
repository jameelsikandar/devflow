/* eslint-disable @typescript-eslint/no-require-imports -- Isolated CommonJS worker/preload tooling. */
'use strict';
const { fork } = require('node:child_process');
const { bounded, budget, check } = require('./lifecycle.cjs');
const { randomUUID } = require('node:crypto');
const { ownedChild, shouldRestart, insist, evidenceLine } = require('./policy.cjs');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, code, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const op = budget();
    op?.check();
    const value = await bounded(
      predicate(),
      Math.min(deadline - Date.now(), op ? op.deadline - Date.now() : timeout),
      op?.signal,
    );
    op?.check();
    if (value) return value;
    await delay(200);
  }
  throw new Error(`REHEARSAL_TIMEOUT_${code}`);
}
class Workers {
  constructor(emit) {
    this.emit = emit;
    this.records = new Map();
  }
  start(slot, connectionId, mode = 'none') {
    check();
    insist(!this.records.has(slot), 'SLOT_ALREADY_USED');
    insist(/^[a-z][a-z0-9-]{0,30}$/.test(slot), 'SLOT');
    const token = randomUUID();
    const child = fork('/work/rehearsal/child.cjs', [], {
      cwd: '/work',
      execArgv: [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, REHEARSAL_CONNECTION_ID: connectionId, REHEARSAL_GATE: mode },
    });
    const record = {
      child,
      token,
      pid: child.pid,
      events: [],
      exit: null,
      stopped: false,
      validatedExit: false,
      expected: null,
    };
    this.records.set(slot, record);
    child.on('error', () => {
      record.error = true;
    });
    child.on('message', (message) => {
      if (
        message &&
        [
          'gate',
          'result',
          'booted',
          'fault',
          'http-count',
          'claimed',
          'signal-observed',
          'polled',
          'health-run',
          'retry-scheduled',
        ].includes(message.type)
      ) {
        record.events.push(message);
        if (record.draining && message.type === 'gate' && !record.exit)
          this.release(slot, message.name);
      }
    });
    // Do not retain raw stdout/stderr. Production JSON is deliberately reduced.
    const consume = (stream) => {
      let buffer = '';
      stream.on('data', (chunk) => {
        buffer = (buffer + chunk.toString()).slice(-16384);
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const event = JSON.parse(line);
            if (
              ['github-worker', 'github-automation'].includes(event.component) &&
              /^[A-Za-z_]{1,60}$/.test(event.state)
            )
              this.emit('WORKER_LOG', { slot, state: event.state });
          } catch {
            /* No raw diagnostic output, including rejected JSON. */
          }
        }
      });
    };
    consume(child.stdout);
    consume(child.stderr);
    record.done = new Promise((resolve) =>
      child.once('exit', (code, signal) => {
        record.exit = { code, signal };
        this.emit('CHILD_EXIT', { slot, exitCode: code, ...(signal ? { signal } : {}) });
        resolve(record.exit);
      }),
    );
    this.emit('CHILD_START', { slot, pid: child.pid });
    return record;
  }
  record(slot) {
    const r = this.records.get(slot);
    insist(r, 'UNKNOWN_SLOT');
    return r;
  }
  signal(slot, signal) {
    const r = this.record(slot);
    ownedChild(r, r.child, r.token, signal);
    insist(r.child.kill(signal), 'SIGNAL_FAILED');
    if (signal === 'SIGKILL') r.expected = { code: null, signal };
    if (signal === 'SIGTERM') r.expected = { code: 0, signal: null };
    if (signal === 'SIGSTOP') r.stopped = true;
    if (signal === 'SIGCONT') r.stopped = false;
    this.emit('CHILD_SIGNAL', { slot, signal });
  }
  release(slot, gate) {
    const r = this.record(slot);
    ownedChild(r, r.child, r.token, 'SIGCONT');
    insist(
      r.events.some((e) => e.type === 'gate' && e.name === gate),
      'GATE_NOT_OWNED',
    );
    r.child.send({ type: 'release', name: gate });
  }
  gate(slot, name) {
    return until(
      () => {
        const r = this.record(slot);
        insist(!r.exit && !r.error, 'CHILD_UNEXPECTED_EXIT');
        return r.events.some((e) => e.type === 'gate' && e.name === name);
      },
      'GATE',
      30000,
    );
  }
  async ready(slot, db, connectionId, idle = true) {
    return until(
      async () => {
        const r = this.record(slot);
        insist(!r.exit && !r.error, 'CHILD_UNEXPECTED_EXIT');
        const own = r.events.find((e) => e.type === 'health-run');
        const poll = r.events.find(
          (e) => e.type === 'polled' && e.runId === own?.runId && e.idle === idle,
        );
        if (!own || !poll) return false;
        const row = await db.gitHubWorkerSignal.findUnique({
          where: { runId_connectionId: { runId: own.runId, connectionId } },
        });
        return row &&
          row.runId === own.runId &&
          row.connectionId === connectionId &&
          row.state === 'RUNNING' &&
          row.polledAt &&
          Date.now() >= +row.heartbeatAt &&
          Date.now() >= +row.polledAt &&
          Date.now() - +row.polledAt <= row.staleAfterMs &&
          Date.now() - +row.heartbeatAt <= row.staleAfterMs &&
          (idle ? !!row.idleAt : !row.idleAt)
          ? row
          : false;
      },
      'OWN_WORKER_READY',
      30000,
    );
  }
  async exited(slot, code = 0, signal = null) {
    const r = this.record(slot);
    const exit = await until(() => r.exit, 'EXIT', 45000);
    insist(exit.code === code && exit.signal === signal, 'EXIT_STATUS');
    insist(
      signal === null
        ? code === 0 && r.expected?.code === 0 && r.expected?.signal === null
        : r.expected?.signal === signal,
      'UNEXPECTED_EXIT',
    );
    insist(!r.events.some((e) => e.type === 'http-count' && e.count !== 0), 'HTTP_ATTEMPT');
    r.validatedExit = true;
    return exit;
  }
  async stop(slot) {
    const r = this.record(slot);
    if (r.exit) {
      insist(r.validatedExit, 'UNEXPECTED_EXIT');
      return;
    }
    if (r.stopped) this.signal(slot, 'SIGCONT');
    this.signal(slot, 'SIGTERM');
    r.draining = true;
    for (const event of r.events.filter((e) => e.type === 'gate')) this.release(slot, event.name);
    await this.exited(slot);
  }
  async drain() {
    // No data deletion and no implicit SIGKILL. Failure is retained for review.
    const results = await Promise.allSettled([...this.records.keys()].map((s) => this.stop(s)));
    insist(
      results.every((r) => r.status === 'fulfilled'),
      'OWNED_CHILD_DRAIN_FAILED',
    );
  }
}
async function supervise(attempt, pause, onRestart, limit = 2) {
  let restarts = 0;
  while (true) {
    const exit = await attempt(restarts);
    if (!shouldRestart(exit, restarts, limit))
      return { exit, restarts, exhausted: exit.code !== 0 || exit.signal !== null };
    await pause(2000);
    restarts++;
    onRestart(restarts);
  }
}
module.exports = { supervise, Workers, until, delay, evidenceLine };
