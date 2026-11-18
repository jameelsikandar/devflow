/* eslint-disable @typescript-eslint/no-require-imports -- Isolated CommonJS rehearsal tooling. */
'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { insist } = require('./policy.cjs');
const current = new AsyncLocalStorage();
function budget() {
  return current.getStore();
}
function check() {
  budget()?.check();
}
function bounded(promise, milliseconds, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      fn(value);
    };
    const abort = () => finish(reject, new Error('REHEARSAL_OPERATION_CANCELLED'));
    const timer = setTimeout(
      () => finish(reject, new Error('REHEARSAL_DEADLINE')),
      Math.max(0, milliseconds),
    );
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    Promise.resolve(promise).then(
      (v) => finish(resolve, v),
      (e) => finish(reject, e),
    );
  });
}
class OperationLane {
  constructor(record = () => {}) {
    this.record = (status) => {
      try {
        record(status);
      } catch {
        this.blocked = true;
        if (this.active) this.active.state = 'UNRESOLVED';
        throw Error('REHEARSAL_EVIDENCE_UNRESOLVED');
      }
    };
    this.active = null;
    this.blocked = false;
  }
  poison(code) {
    this.blocked = true;
    if (this.active) this.active.state = 'UNRESOLVED';
    this.record({ state: 'UNRESOLVED', code });
  }
  async run(work, { milliseconds = 240000, signal } = {}) {
    insist(!this.active && !this.blocked, 'OPERATION_LOCKED');
    const controller = new AbortController();
    const operation = {
      state: 'RUNNING',
      deadline: Date.now() + milliseconds,
      signal: controller.signal,
      check: () => {
        insist(
          !controller.signal.aborted && Date.now() < operation.deadline,
          'OPERATION_CANCELLED',
        );
      },
    };
    this.active = operation;
    let finished = false;
    const cancel = () => {
      this.poison('CLIENT_DISCONNECTED');
      controller.abort();
    };
    this.record({ state: 'RUNNING' });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const workPromise = current.run(operation, async () => {
      operation.check();
      return work(operation);
    });
    // Keep the lane occupied until the underlying operation really settles.
    const tracked = workPromise.finally(() => {
      finished = true;
      if (!this.blocked) this.active = null;
    });
    try {
      const result = await bounded(tracked, milliseconds, controller.signal);
      operation.check();
      insist(!this.blocked, 'OPERATION_UNRESOLVED');
      this.record({ state: 'COMPLETED' });
      return result;
    } catch (error) {
      if (!finished || controller.signal.aborted || Date.now() >= operation.deadline) {
        this.poison('OPERATION_UNRESOLVED');
        controller.abort();
      } else if (!this.blocked && operation.state !== 'UNRESOLVED') {
        this.record({ state: 'FAILED' });
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }
}
function guardedDatabase(db, inspectBudget = budget) {
  const cache = new WeakMap();
  const wrap = (target) => {
    if (cache.has(target)) return cache.get(target);
    const proxy = new Proxy(target, {
      get(object, key) {
        const value = Reflect.get(object, key);
        if (typeof value === 'object' && value && !Array.isArray(value)) return wrap(value);
        if (typeof value !== 'function') return value;
        if (key === '$disconnect') return value.bind(object);
        return (...args) => {
          const op = inspectBudget();
          op?.check();
          if (key === '$transaction') {
            insist(typeof args[0] === 'function', 'TRANSACTION_CALLBACK_REQUIRED');
            const callback = args[0];
            args[0] = (tx) => callback(wrap(tx));
            args[1] = { ...args[1], maxWait: 3000, timeout: 10000 };
          }
          return Promise.resolve(Reflect.apply(value, object, args)).then((result) => {
            op?.check();
            return result;
          });
        };
      },
    });
    cache.set(target, proxy);
    return proxy;
  };
  return wrap(db);
}
module.exports = { OperationLane, bounded, budget, check, current, guardedDatabase };
