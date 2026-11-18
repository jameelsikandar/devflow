import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
// Only pure lifecycle modules: no controller bootstrap, Prisma, process spawning,
// environment loading, filesystem, transport or database operations.
const { Migration } = require('./migration.cjs');
const { OperationLane } = require('./lifecycle.cjs');
const flush = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve();
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function fixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    connected: true,
    stdout: {},
    stderr: {},
    send: vi.fn((_message: object, callback: (error: Error | null) => void) => {
      callback(null);
      return true;
    }),
    kill: vi.fn(),
  });
  const log = { onError: vi.fn(), attach: vi.fn(), end: vi.fn(async () => {}) };
  const migration = new Migration();
  // Even the hypothetical Prisma launch is a spy, never an application import.
  const prisma = vi.fn();
  const fork = vi.fn(() => {
    prisma();
    return child;
  });
  const openLog = vi.fn(async () => log);
  const finish = (code = 1) => {
    child.emit('message', { type: 'migration-terminal', code, descendants: 0 });
    child.emit('exit', code, null);
    child.emit('close');
  };
  return { child, log, migration, prisma, fork, openLog, finish };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('migration setup cancellation and deadlines', () => {
  it('rejects an already-aborted operation before opening a log or authorizing Prisma', async () => {
    const f = fixture(),
      abort = new AbortController();
    abort.abort();
    await expect(
      f.migration.run({ openLog: f.openLog, forkChild: f.fork, signal: abort.signal }),
    ).rejects.toThrow('CANCELLED');
    expect(f.openLog).not.toHaveBeenCalled();
    expect(f.fork).not.toHaveBeenCalled();
    expect(f.prisma).not.toHaveBeenCalled();
  });
  it('rejects explicit cancellation before setup', async () => {
    const f = fixture();
    f.migration.cancel();
    await expect(f.migration.run({ openLog: f.openLog, forkChild: f.fork })).rejects.toThrow(
      'CANCELLED',
    );
    expect(f.openLog).not.toHaveBeenCalled();
    expect(f.fork).not.toHaveBeenCalled();
  });
  it('discards a delayed log that opens after operation cancellation; never forks', async () => {
    const f = fixture(),
      pending = deferred<typeof f.log>(),
      abort = new AbortController();
    const open = vi.fn(() => pending.promise);
    const result = f.migration
      .run({ openLog: open, forkChild: f.fork, signal: abort.signal })
      .catch((e: Error) => e);
    await flush();
    expect(open).toHaveBeenCalledOnce();
    abort.abort();
    await expect(result).resolves.toHaveProperty('message', 'REHEARSAL_OPERATION_CANCELLED');
    expect(f.migration.unresolved).toBe(true);
    pending.resolve(f.log);
    await flush();
    expect(f.log.end).toHaveBeenCalledOnce();
    expect(f.fork).not.toHaveBeenCalled();
    expect(f.prisma).not.toHaveBeenCalled();
  });
  it('bounds log opening and safely closes a log arriving after the setup deadline', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      pending = deferred<typeof f.log>();
    const result = f.migration
      .run({ openLog: () => pending.promise, forkChild: f.fork })
      .catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(10001);
    await expect(result).resolves.toHaveProperty('message', 'REHEARSAL_DEADLINE');
    pending.resolve(f.log);
    await flush();
    expect(f.log.end).toHaveBeenCalledOnce();
    expect(f.fork).not.toHaveBeenCalled();
    expect(f.prisma).not.toHaveBeenCalled();
    expect(f.migration.unresolved).toBe(true);
  });
  it('rejects a log acquired past the monotonic setup deadline before timer delivery', async () => {
    vi.useFakeTimers();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const f = fixture(),
      pending = deferred<typeof f.log>();
    const result = f.migration
      .run({ openLog: () => pending.promise, forkChild: f.fork })
      .catch((e: Error) => e);
    await flush();
    const timers = vi.getTimerCount();
    // Move only the monotonic clock: no timeout callback has been delivered.
    clock.mockReturnValue(10001);
    pending.resolve(f.log);
    await expect(result).resolves.toHaveProperty('message', 'REHEARSAL_DEADLINE');
    expect(timers).toBeGreaterThan(0);
    expect(f.fork).not.toHaveBeenCalled();
    expect(f.prisma).not.toHaveBeenCalled();
    expect(f.log.end).toHaveBeenCalledOnce();
    expect(f.migration.record).toBeNull();
    expect(f.migration.unresolved).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rechecks the monotonic setup deadline immediately before the fork', async () => {
    vi.useFakeTimers();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const f = fixture();
    f.log.onError.mockImplementation(() => {
      clock.mockReturnValue(10001);
    });
    await expect(f.migration.run({ openLog: f.openLog, forkChild: f.fork })).rejects.toThrow(
      'DEADLINE',
    );
    expect(f.fork).not.toHaveBeenCalled();
    expect(f.log.end).toHaveBeenCalledOnce();
    expect(f.migration.unresolved).toBe(true);
  });
  it('rechecks the controller absolute deadline even if its timer has not fired', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      pending = deferred<typeof f.log>(),
      lane = new OperationLane();
    const result = lane
      .run(() => f.migration.run({ openLog: () => pending.promise, forkChild: f.fork }), {
        milliseconds: 50,
      })
      .catch((e: Error) => e);
    await flush();
    vi.setSystemTime(Date.now() + 51);
    pending.resolve(f.log);
    await result;
    expect(f.fork).not.toHaveBeenCalled();
    expect(f.log.end).toHaveBeenCalledOnce();
    expect(lane.blocked).toBe(true);
  });
  it('rechecks cancellation after synchronous log-error registration before fork', async () => {
    const f = fixture(),
      abort = new AbortController();
    f.log.onError.mockImplementation(() => {
      abort.abort();
    });
    await expect(
      f.migration.run({ openLog: f.openLog, forkChild: f.fork, signal: abort.signal }),
    ).rejects.toThrow('CANCELLED');
    expect(f.fork).not.toHaveBeenCalled();
    expect(f.log.end).toHaveBeenCalledOnce();
  });
  it('bounds late-log closure failure and keeps unresolved ownership', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      pending = deferred<typeof f.log>(),
      abort = new AbortController();
    f.log.end.mockImplementation(() => new Promise(() => {}));
    const result = f.migration
      .run({ openLog: () => pending.promise, forkChild: f.fork, signal: abort.signal })
      .catch((e: Error) => e);
    await flush();
    abort.abort();
    await result;
    pending.resolve(f.log);
    await vi.advanceTimersByTimeAsync(5001);
    expect(f.fork).not.toHaveBeenCalled();
    expect(f.migration.unresolved).toBe(true);
    await expect(f.migration.stop()).rejects.toThrow('DEADLINE');
  });
});
describe('owned migration IPC and termination evidence', () => {
  async function start() {
    const f = fixture();
    const result = f.migration
      .run({ openLog: f.openLog, forkChild: f.fork })
      .catch((e: Error) => e);
    await flush();
    expect(f.fork).toHaveBeenCalledOnce();
    return { ...f, result };
  }
  it('sends cancellation once with a callback and waits for confirmed termination', async () => {
    const f = await start();
    f.migration.cancel();
    f.migration.cancel();
    const stopped = f.migration.stop();
    let done = false;
    void stopped.then(() => {
      done = true;
    });
    await flush();
    expect(f.child.send).toHaveBeenCalledTimes(1);
    expect(f.child.send).toHaveBeenCalledWith({ type: 'cancel' }, expect.any(Function));
    expect(done).toBe(false);
    f.finish();
    await stopped;
    await f.result;
    expect(f.child.kill).not.toHaveBeenCalled();
  });
  it('does not send to disconnected IPC or infer termination from channel loss', async () => {
    const f = await start();
    f.child.connected = false;
    f.child.emit('disconnect');
    f.migration.cancel();
    f.migration.cancel();
    expect(f.child.send).not.toHaveBeenCalled();
    expect(f.migration.unresolved).toBe(true);
    f.child.emit('message', { type: 'migration-terminal', code: 1, descendants: 0 });
    expect(f.migration.unresolved).toBe(true);
    f.child.emit('exit', 1, null);
    expect(f.migration.unresolved).toBe(true);
    f.child.emit('close');
    await f.result;
    expect(f.migration.unresolved).toBe(false);
  });
  it.each(['callback', 'throw'] as const)(
    'handles %s send failures without retries or arbitrary signals',
    async (kind) => {
      const f = await start();
      f.child.send.mockImplementation((_m, cb) => {
        if (kind === 'throw') throw Error('IPC closed');
        cb(Error('IPC closed'));
        return false;
      });
      expect(() => {
        f.migration.cancel();
        f.migration.cancel();
      }).not.toThrow();
      await flush();
      expect(f.migration.unresolved).toBe(true);
      expect(f.child.send).toHaveBeenCalledTimes(1);
      f.finish();
      await expect(f.result).resolves.toHaveProperty('message', 'REHEARSAL_MIGRATION_IPC_LOST');
      expect(f.child.kill).not.toHaveBeenCalled();
    },
  );
  it('handles disconnect during send and a late error callback', async () => {
    const f = await start();
    let fail!: (e: Error | null) => void;
    f.child.send.mockImplementation((_m, cb) => {
      fail = cb;
      f.child.connected = false;
      f.child.emit('disconnect');
      return false;
    });
    f.migration.cancel();
    fail(Error('channel closed'));
    f.migration.cancel();
    await flush();
    expect(f.migration.unresolved).toBe(true);
    f.finish();
    await f.result;
    expect(f.child.send).toHaveBeenCalledTimes(1);
  });
  it('handles repeated child errors and does not mistake rejection for process closure', async () => {
    const f = await start();
    let settled = false;
    void f.result.then(() => {
      settled = true;
    });
    expect(() => {
      f.child.emit('error', Error('early'));
      f.child.emit('error', Error('late'));
    }).not.toThrow();
    await flush();
    expect(settled).toBe(false);
    expect(f.migration.unresolved).toBe(true);
    f.finish();
    await f.result;
    expect(() => f.child.emit('error', Error('after close'))).not.toThrow();
    expect(f.child.listenerCount('error')).toBe(1);
    expect(f.migration.unresolved).toBe(true);
  });
  it('never reports success when explicit cancellation races a zero exit', async () => {
    const f = await start();
    f.migration.cancel();
    f.finish(0);
    await expect(f.result).resolves.toHaveProperty('message', 'REHEARSAL_OPERATION_CANCELLED');
    expect(f.log.end).toHaveBeenCalledOnce();
  });
  it('rejects cancellation during deferred final log closure without losing termination evidence', async () => {
    const f = fixture(),
      closing = deferred<void>(),
      abort = new AbortController();
    f.log.end.mockImplementation(() => closing.promise);
    const result = f.migration
      .run({ openLog: f.openLog, forkChild: f.fork, signal: abort.signal })
      .catch((e: Error) => e);
    await flush();
    f.finish(0);
    await flush();
    expect(f.log.end).toHaveBeenCalledOnce();
    abort.abort();
    closing.resolve();
    await expect(result).resolves.toHaveProperty('message', 'REHEARSAL_OPERATION_CANCELLED');
    expect(f.migration.record).toMatchObject({
      closed: true,
      exit: { code: 0, signal: null },
      terminal: { code: 0, descendants: 0 },
    });
    // Cancellation is not evidence that the already-confirmed process is unknown.
    expect(f.migration.unresolved).toBe(false);
    expect(f.child.send).not.toHaveBeenCalled();
  });
  it('rejects deadline expiry during deferred final log closure even before timer delivery', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      closing = deferred<void>();
    f.log.end.mockImplementation(() => closing.promise);
    const result = f.migration
      .run({ openLog: f.openLog, forkChild: f.fork })
      .catch((e: Error) => e);
    await flush();
    f.finish(0);
    await flush();
    expect(f.log.end).toHaveBeenCalledOnce();
    vi.setSystemTime(Date.now() + 120001);
    closing.resolve();
    await expect(result).resolves.toHaveProperty('message', 'REHEARSAL_OPERATION_CANCELLED');
    expect(f.migration.record.closed).toBe(true);
    expect(f.migration.unresolved).toBe(false);
  });
  it('preserves unresolved controller state when cancellation during cleanup lacks descendant proof', async () => {
    const f = fixture(),
      closing = deferred<void>(),
      abort = new AbortController();
    const states: { state: string }[] = [];
    const lane = new OperationLane((state: { state: string }) => states.push(state));
    f.log.end.mockImplementation(() => closing.promise);
    const result = lane
      .run(
        async (op: { signal: AbortSignal }) => {
          try {
            await f.migration.run({ openLog: f.openLog, forkChild: f.fork, signal: op.signal });
          } catch (error) {
            lane.poison('MIGRATION_REQUIRES_REVIEW');
            throw error;
          }
        },
        { signal: abort.signal },
      )
      .catch((e: Error) => e);
    await flush();
    f.child.emit('exit', 0, null);
    f.child.emit('close'); // No descendant-drained receipt.
    await flush();
    expect(f.log.end).toHaveBeenCalledOnce();
    abort.abort();
    closing.resolve();
    await result;
    await flush();
    expect(f.migration.unresolved).toBe(true);
    expect(f.migration.record.child).toBe(f.child);
    expect(lane.blocked).toBe(true);
    expect(states.at(-1)?.state).toBe('UNRESOLVED');
    expect(states.some((state) => state.state === 'COMPLETED')).toBe(false);
    await expect(lane.run(vi.fn())).rejects.toThrow('OPERATION_LOCKED');
  });
  it('permits normal terminal IPC disconnect only after actual exit and close evidence', async () => {
    const f = await start();
    f.child.emit('message', { type: 'migration-terminal', code: 0, descendants: 0 });
    f.child.connected = false;
    f.child.emit('disconnect');
    expect(f.migration.unresolved).toBe(true);
    f.child.emit('exit', 0, null);
    f.child.emit('close');
    await expect(f.result).resolves.toBeUndefined();
    expect(f.migration.unresolved).toBe(false);
  });
  it('retains unresolved state when IPC is lost and no termination proof arrives', async () => {
    vi.useFakeTimers();
    const f = await start();
    f.child.connected = false;
    f.child.emit('disconnect');
    f.migration.cancel();
    await vi.advanceTimersByTimeAsync(45001);
    expect(f.migration.unresolved).toBe(true);
    await expect(f.result).resolves.toBeInstanceOf(Error);
    expect(f.migration.record.child).toBe(f.child);
  });
});
it('never overwrites a poisoned operation with FAILED after a later rejection', async () => {
  const states: { state: string; code?: string }[] = [];
  const lane = new OperationLane((state: { state: string; code?: string }) => states.push(state));
  await expect(
    lane.run(async () => {
      lane.poison('MIGRATION_REQUIRES_REVIEW');
      throw Error('late failure');
    }),
  ).rejects.toThrow('late failure');
  expect(states.at(-1)).toEqual({ state: 'UNRESOLVED', code: 'MIGRATION_REQUIRES_REVIEW' });
  expect(states.some((s) => s.state === 'FAILED')).toBe(false);
  expect(lane.blocked).toBe(true);
  await expect(lane.run(vi.fn())).rejects.toThrow('OPERATION_LOCKED');
});

it('keeps UNRESOLVED dominant for an operation aborted before it starts', async () => {
  const states: { state: string }[] = [];
  const lane = new OperationLane((state: { state: string }) => states.push(state));
  const abort = new AbortController();
  abort.abort();
  const work = vi.fn();
  await expect(lane.run(work, { signal: abort.signal })).rejects.toThrow('CANCELLED');
  expect(work).not.toHaveBeenCalled();
  const firstUnresolved = states.findIndex((s) => s.state === 'UNRESOLVED');
  expect(firstUnresolved).toBeGreaterThanOrEqual(0);
  expect(states.slice(firstUnresolved).every((s) => s.state === 'UNRESOLVED')).toBe(true);
  expect(lane.blocked).toBe(true);
});
