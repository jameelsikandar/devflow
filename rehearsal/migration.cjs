/* eslint-disable @typescript-eslint/no-require-imports -- Owned migration lifecycle. */
'use strict';
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { ownedChild, insist } = require('./policy.cjs');
const { bounded, check } = require('./lifecycle.cjs');
class Migration {
  constructor() {
    this.record = null;
    this.unresolved = false;
    this.cancelled = false;
    this.started = false;
  }
  get unresolved() {
    const r = this.record;
    return (
      this.failureUnresolved ||
      !!(r?.ipcLost && !(r.closed && r.exit && r.terminal?.descendants === 0))
    );
  }
  set unresolved(value) {
    this.failureUnresolved = value;
  }
  cancel() {
    this.cancelled = true;
    const r = this.record;
    if (!r || r.exit || r.cancelSent) return;
    ownedChild(r, r.child, r.token, 'SIGTERM');
    r.cancelSent = true;
    const lost = () => {
      r.ipcLost = true;
      r.rejectFailure?.(Error('REHEARSAL_MIGRATION_IPC_LOST'));
    };
    if (!r.child.connected) {
      lost();
      return;
    }
    try {
      r.child.send({ type: 'cancel' }, (error) => {
        if (error) lost();
      });
    } catch {
      lost();
    }
  }
  async stop() {
    this.cancel();
    const r = this.record;
    if (!r) {
      if (this.setupPromise) await bounded(this.setupPromise, 45000);
      insist(!this.unresolved, 'MIGRATION_UNRESOLVED');
      return;
    }
    await bounded(r.closedPromise, 45000);
    insist(r.closed && r.exit && r.terminal?.descendants === 0, 'MIGRATION_UNRESOLVED');
  }
  async run({ openLog, forkChild, signal }) {
    insist(!this.started, 'MIGRATION_ALREADY_STARTED');
    const deadline = Date.now() + 120000;
    const active = () => {
      check(); // Includes the controller operation's absolute deadline.
      insist(!this.cancelled && !signal?.aborted && Date.now() < deadline, 'OPERATION_CANCELLED');
    };
    active(); // Do not even open a log for an already-cancelled operation.
    this.started = true;
    const setupDeadline = performance.now() + 10000;
    const setupActive = () => {
      active();
      if (performance.now() >= setupDeadline) {
        this.unresolved = true; // Keep expired setup subject to controller review.
        insist(false, 'DEADLINE');
      }
    };
    let openedLog,
      closedLog,
      setupSettled = false;
    const closeLog = () => {
      if (!openedLog) return Promise.resolve();
      if (!closedLog)
        closedLog = bounded(
          Promise.resolve().then(() => openedLog.end()),
          5000,
        ).catch((error) => {
          this.unresolved = true;
          throw error;
        });
      return closedLog;
    };
    this.setupPromise = Promise.resolve()
      .then(async () => {
        setupActive();
        openedLog = await openLog();
        try {
          setupActive();
          return openedLog;
        } catch (error) {
          await closeLog(); // A late log is discarded; it can never lead to a fork.
          throw error;
        }
      })
      .finally(() => {
        setupSettled = true;
      });
    // A setup still pending after the deadline remains owned and observed.
    void this.setupPromise.catch(() => {});
    let log;
    try {
      log = await bounded(
        this.setupPromise,
        Math.max(0, setupDeadline - performance.now()),
        signal,
      );
      setupActive();
    } catch (error) {
      this.cancel();
      if (!setupSettled) this.unresolved = true;
      await closeLog();
      throw error;
    }
    let child,
      logFailed = false,
      rejectLog;
    const logFailure = new Promise((_, reject) => {
      rejectLog = reject;
    });
    void logFailure.catch(() => {});
    try {
      log.onError(() => {
        logFailed = true;
        this.cancel();
        rejectLog(Error('REHEARSAL_PRIVATE_LOG_FAILED'));
      });
      insist(!logFailed, 'PRIVATE_LOG_FAILED');
      setupActive(); // No await between this authorization and the owned fork.
      child = forkChild();
    } catch (error) {
      await closeLog();
      throw error;
    }
    const r = { child, pid: child.pid, token: randomUUID(), exit: null, terminal: null };
    this.record = r;
    let rejectFailure;
    const processFailure = new Promise((_, reject) => {
      rejectFailure = reject;
    });
    void processFailure.catch(() => {});
    r.rejectFailure = rejectFailure;
    // Closure evidence must not reject early when a process/IPC error occurs.
    const closed = new Promise((resolve) => {
      child.on('message', (m) => {
        if (m?.type === 'migration-terminal' && [0, 1].includes(m.code) && m.descendants === 0)
          r.terminal = m;
        if (m?.type === 'migration-unresolved') {
          this.unresolved = true;
          rejectFailure(Error('REHEARSAL_MIGRATION_DESCENDANTS_UNRESOLVED'));
        }
      });
      child.once('exit', (code, signal) => {
        r.exit = { code, signal };
      });
      child.once('close', () => {
        r.closed = true;
        resolve();
      });
      // Remain installed even after rejection/close: late errors must be handled.
      child.on('error', () => {
        this.unresolved = true;
        rejectFailure(Error('REHEARSAL_MIGRATION_PROCESS_ERROR'));
      });
      child.on('disconnect', () => {
        // A terminal receipt alone is not proof that the process has terminated.
        if (!r.closed) {
          r.ipcLost = true;
        }
      });
    });
    r.closedPromise = closed;
    const cancel = () => this.cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (signal?.aborted) cancel();
      log.attach(child.stdout);
      log.attach(child.stderr);
      await bounded(
        Promise.race([closed, logFailure, processFailure]),
        Math.max(0, deadline - Date.now()),
        signal,
      );
      active();
      insist(
        r.exit?.code === 0 && !r.exit.signal && r.terminal?.code === 0 && !this.unresolved,
        'MIGRATION_FAILED',
      );
    } catch (error) {
      this.cancel();
      try {
        await bounded(closed, 45000);
      } catch {
        this.unresolved = true;
      }
      if (!r.terminal || r.terminal.descendants !== 0) this.unresolved = true;
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
      try {
        await closeLog();
      } catch {
        this.unresolved = true;
      }
    }
    active(); // Cancellation/deadline may have occurred while final log closure awaited.
    insist(!this.unresolved, 'MIGRATION_UNRESOLVED');
  }
}
module.exports = { Migration };
