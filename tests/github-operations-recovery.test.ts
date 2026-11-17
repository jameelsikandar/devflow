import { afterEach, expect, it, vi } from 'vitest';
import { runGitHubWorker } from '../src/lib/server/github-worker-runtime';
import { workerOptions } from '../src/lib/server/github-processing';
import {
  createWorkerHealth,
  classifyWorkerHealth,
  WORKER_HEARTBEAT_MS,
  type WorkerHealthEvidence,
} from '../src/lib/server/github-worker-health';
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const options = workerOptions.parse({ concurrency: 1, connectionId: 'fixture' });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('does not start storage, recovery or processors when shutdown was already requested', async () => {
  const controller = new AbortController();
  controller.abort();
  const health = { start: vi.fn(), progress: vi.fn(), polled: vi.fn(), stop: vi.fn() };
  const process = vi.fn(),
    recover = vi.fn();
  expect(
    await runGitHubWorker(options, false, controller.signal, {
      health,
      process,
      recover,
      idle: vi.fn(),
    }),
  ).toBe(0);
  expect(health.start).not.toHaveBeenCalled();
  expect(health.stop).not.toHaveBeenCalled();
  expect(process).not.toHaveBeenCalled();
  expect(recover).not.toHaveBeenCalled();
});
it('stops cleanly if shutdown arrives during recovery without claiming a new batch', async () => {
  const controller = new AbortController();
  const health = { start: vi.fn(), progress: vi.fn(), polled: vi.fn(), stop: vi.fn() };
  const process = vi.fn();
  await runGitHubWorker(options, false, controller.signal, {
    health,
    process,
    recover: async () => controller.abort(),
    idle: vi.fn(),
  });
  expect(process).not.toHaveBeenCalled();
  expect(health.stop).toHaveBeenCalledWith('STOPPED');
});
it('drains a successful sibling before reporting a rejected batch or closing health storage', async () => {
  const sibling = gate<boolean>();
  const entered = gate<void>();
  const events: string[] = [];
  const health = {
    start: vi.fn(),
    progress: vi.fn(),
    polled: vi.fn(),
    stop: vi.fn(async () => {
      events.push('stopped');
    }),
  };
  const process = vi
    .fn()
    .mockRejectedValueOnce(new Error('private DB credentials'))
    .mockImplementationOnce(async () => {
      entered.resolve();
      const result = await sibling.promise;
      events.push('sibling finished');
      return result;
    });
  const outcome = runGitHubWorker(
    { ...options, concurrency: 2 },
    false,
    new AbortController().signal,
    { health, process, recover: vi.fn(), idle: vi.fn() },
  ).catch((error) => error);
  await entered.promise;
  expect(health.stop).not.toHaveBeenCalled();
  sibling.resolve(true);
  expect((await outcome).message).toBe('WORKER_DATABASE_FAILURE');
  expect(events).toEqual(['sibling finished', 'stopped']);
  expect(health.stop).toHaveBeenCalledWith('FAILED');
});
it('survives a telemetry outage, distinguishes stale/live-without-poll evidence, and resumes processing', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-18T12:00:00Z'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const controller = new AbortController();
  let evidence: WorkerHealthEvidence | undefined;
  let outage = false;
  const finish = vi.fn(async (_id: string, state: 'STOPPED' | 'COMPLETED' | 'FAILED') => {
    evidence = { ...evidence!, state };
    return 1;
  });
  const health = createWorkerHealth(options, false, {
    pulse: async (input) => {
      if (outage) throw new Error('private storage error');
      const stamp = new Date();
      evidence = {
        mode: 'CONTINUOUS',
        state: 'RUNNING',
        heartbeatAt: stamp,
        polledAt: input.polled ? stamp : (evidence?.polledAt ?? null),
        idleAt: input.polled ? (input.idle ? stamp : null) : (evidence?.idleAt ?? null),
        staleAfterMs: input.staleAfterMs,
      };
      return 1;
    },
    finish,
  });
  const idleEntered = gate<void>(),
    idleRelease = gate<void>(),
    processingEntered = gate<void>(),
    processingRelease = gate<boolean>();
  let calls = 0;
  const running = runGitHubWorker(options, false, controller.signal, {
    health,
    recover: vi.fn(),
    idle: async () => {
      idleEntered.resolve();
      await idleRelease.promise;
    },
    process: async () => {
      calls++;
      if (calls === 1) return false;
      if (calls === 2) {
        health.progress('fixture');
        return true;
      }
      processingEntered.resolve();
      return processingRelease.promise;
    },
  });
  try {
    await idleEntered.promise;
    expect(classifyWorkerHealth([evidence!], new Date())).toBe('HEALTHY_IDLE');
    outage = true;
    await vi.advanceTimersByTimeAsync(50000);
    expect(classifyWorkerHealth([evidence!], new Date())).toBe('UNAVAILABLE');
    expect(finish).not.toHaveBeenCalled();
    outage = false;
    await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_MS);
    expect(classifyWorkerHealth([evidence!], new Date())).toBe('INSUFFICIENT_EVIDENCE');
    idleRelease.resolve();
    await processingEntered.promise;
    await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_MS);
    expect(classifyWorkerHealth([evidence!], new Date())).toBe('HEALTHY_ACTIVE');
  } finally {
    controller.abort();
    idleRelease.resolve();
    processingRelease.resolve(false);
    await running;
  }
  expect(finish).toHaveBeenCalledWith(expect.any(String), 'STOPPED');
  expect(classifyWorkerHealth([evidence!], new Date())).toBe('UNAVAILABLE');
  expect(JSON.stringify(log.mock.calls)).not.toContain('private');
  expect(calls).toBe(3);
});
it('does not mask a processing failure or leak storage errors when terminal health persistence fails', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const health = createWorkerHealth(options, false, {
    pulse: vi.fn().mockResolvedValue(1),
    finish: vi.fn().mockRejectedValue(new Error('private shutdown token')),
  });
  await expect(
    runGitHubWorker(options, false, new AbortController().signal, {
      health,
      recover: vi.fn(),
      idle: vi.fn(),
      process: vi.fn().mockRejectedValue(new Error('private job error')),
    }),
  ).rejects.toThrow('WORKER_DATABASE_FAILURE');
  expect(JSON.stringify(log.mock.calls)).toContain('WORKER_HEALTH_WRITE_FAILED');
  expect(JSON.stringify(log.mock.calls)).not.toContain('private');
});
