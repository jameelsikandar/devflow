import { readFileSync } from 'node:fs';
import type { GitHubWorkerSignal } from '@prisma/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  classifyWorkerHealth,
  createWorkerHealth,
  WORKER_HEARTBEAT_MS,
  workerStaleAfterMs,
} from '../src/lib/server/github-worker-health';
import { workerOptions } from '../src/lib/server/github-processing';
import { runGitHubWorker } from '../src/lib/server/github-worker-runtime';

const now = new Date('2026-11-15T12:00:00Z');
const signal = (overrides: Partial<GitHubWorkerSignal> = {}): GitHubWorkerSignal => ({
  runId: 'run',
  connectionId: 'connection',
  workspaceId: 'workspace',
  projectId: 'project',
  mode: 'CONTINUOUS',
  state: 'RUNNING',
  startedAt: now,
  heartbeatAt: now,
  polledAt: now,
  idleAt: now,
  progressAt: null,
  endedAt: null,
  staleAfterMs: 45000,
  ...overrides,
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('distinguishes healthy idle and active evidence without requiring completed jobs', () => {
  expect(classifyWorkerHealth([signal()], now)).toBe('HEALTHY_IDLE');
  expect(classifyWorkerHealth([signal({ idleAt: null })], now)).toBe('HEALTHY_ACTIVE');
});
it('does not call a never-observed worker unavailable or infer liveness from a bounded run', () => {
  expect(classifyWorkerHealth([], now)).toBe('INSUFFICIENT_EVIDENCE');
  for (const state of ['RUNNING', 'COMPLETED', 'FAILED', 'STOPPED'] as const)
    expect(classifyWorkerHealth([signal({ mode: 'BOUNDED', state })], now)).toBe('BOUNDED_RUN');
});
it('reports unavailable continuous evidence and lets a fresh replica establish health', () => {
  const stale = signal({ heartbeatAt: new Date(+now - 45001) });
  expect(classifyWorkerHealth([stale], now)).toBe('UNAVAILABLE');
  expect(classifyWorkerHealth([signal({ state: 'STOPPED', endedAt: now })], now)).toBe(
    'UNAVAILABLE',
  );
  expect(classifyWorkerHealth([stale, signal()], now)).toBe('HEALTHY_IDLE');
});
it('does not interpret a heartbeat alone, stalled polling, or a future clock as healthy idle', () => {
  expect(classifyWorkerHealth([signal({ polledAt: null })], now)).toBe('INSUFFICIENT_EVIDENCE');
  expect(classifyWorkerHealth([signal({ polledAt: new Date(+now - 45001) })], now)).toBe(
    'INSUFFICIENT_EVIDENCE',
  );
  expect(classifyWorkerHealth([signal({ heartbeatAt: new Date(+now + 1) })], now)).toBe(
    'INSUFFICIENT_EVIDENCE',
  );
});
it('allows slow configured polling without misleading stale alerts', () => {
  expect(workerStaleAfterMs(2000)).toBe(45000);
  expect(workerStaleAfterMs(60000)).toBe(190000);
});
it('sends scoped heartbeats while idle and stops its timer on bounded completion', async () => {
  vi.useFakeTimers();
  const pulse = vi.fn().mockResolvedValue(1);
  const finish = vi.fn().mockResolvedValue(1);
  const health = createWorkerHealth(workerOptions.parse({ connectionId: 'local' }), true, {
    pulse,
    finish,
  });
  await health.start();
  await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_MS * 2);
  await health.polled(true);
  expect(pulse).toHaveBeenCalledTimes(4);
  expect(pulse.mock.calls.at(-1)![0]).toMatchObject({
    connectionId: 'local',
    once: true,
    polled: true,
    idle: true,
    progress: [],
  });
  const runId = pulse.mock.calls[0][0].runId;
  await health.stop('COMPLETED');
  await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_MS * 3);
  expect(pulse).toHaveBeenCalledTimes(4);
  expect(finish).toHaveBeenCalledWith(runId, 'COMPLETED');
});
it('retries telemetry failures without losing scoped progress or leaking database errors', async () => {
  const pulse = vi.fn().mockResolvedValue(1);
  const finish = vi.fn().mockResolvedValue(1);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const health = createWorkerHealth(workerOptions.parse({}), false, { pulse, finish });
  await health.start();
  health.progress('a');
  health.progress('a');
  pulse.mockRejectedValueOnce(new Error('secret connection credential'));
  await health.polled(false);
  await health.polled(false);
  expect(pulse.mock.calls.at(-1)![0].progress).toEqual(['a']);
  await health.polled(true);
  await health.stop('STOPPED');
  expect(pulse.mock.calls.at(-1)![0].progress).toEqual([]);
  expect(JSON.stringify(log.mock.calls)).toContain('WORKER_HEALTH_WRITE_FAILED');
  expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
});
it('keeps progress arriving during a heartbeat write for the next pulse', async () => {
  const pulse = vi.fn().mockResolvedValue(1);
  const health = createWorkerHealth(workerOptions.parse({}), false, {
    pulse,
    finish: vi.fn().mockResolvedValue(1),
  });
  await health.start();
  health.progress('a');
  pulse.mockImplementationOnce(async () => {
    health.progress('a');
    return 1;
  });
  await health.polled(false);
  await health.polled(false);
  await health.stop('STOPPED');
  expect(pulse.mock.calls.at(-1)![0].progress).toEqual(['a']);
});
it('coalesces slow periodic writes and drains them before recording shutdown', async () => {
  vi.useFakeTimers();
  const pulse = vi.fn().mockResolvedValue(1);
  const finish = vi.fn().mockResolvedValue(1);
  const health = createWorkerHealth(workerOptions.parse({}), false, { pulse, finish });
  await health.start();
  let release!: () => void;
  pulse.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_MS * 4);
  expect(pulse).toHaveBeenCalledTimes(2);
  const stopping = health.stop('STOPPED');
  expect(finish).not.toHaveBeenCalled();
  release();
  await stopping;
  expect(finish).toHaveBeenCalledOnce();
});
it('fails before queue claiming if initial health storage cannot start', async () => {
  const health = createWorkerHealth(workerOptions.parse({}), false, {
    pulse: vi.fn().mockRejectedValue(new Error('db')),
    finish: vi.fn(),
  });
  const process = vi.fn();
  await expect(
    runGitHubWorker(workerOptions.parse({}), false, new AbortController().signal, {
      health,
      process,
      recover: vi.fn(),
      idle: vi.fn(),
    }),
  ).rejects.toThrow('db');
  expect(process).not.toHaveBeenCalled();
});
it('records failed shutdown after draining rejected job batches and completes bounded runs', async () => {
  const health = { start: vi.fn(), progress: vi.fn(), polled: vi.fn(), stop: vi.fn() };
  const options = workerOptions.parse({ concurrency: 2, onceLimit: 1 });
  await expect(
    runGitHubWorker(options, false, new AbortController().signal, {
      health,
      recover: vi.fn(),
      idle: vi.fn(),
      process: vi.fn().mockRejectedValue(new Error('database')),
    }),
  ).rejects.toThrow('WORKER_DATABASE_FAILURE');
  expect(health.stop).toHaveBeenCalledWith('FAILED');
  await runGitHubWorker(options, true, new AbortController().signal, {
    health,
    recover: vi.fn(),
    idle: vi.fn(),
    process: vi.fn().mockResolvedValue(true),
  });
  expect(health.polled).toHaveBeenCalledWith(false);
  expect(health.stop).toHaveBeenLastCalledWith('COMPLETED');
});
it('uses additive isolated evidence DDL without touching queue, task or rule records', () => {
  const sql = readFileSync(
    'prisma/migrations/202611150003_github_worker_health/migration.sql',
    'utf8',
  );
  expect(sql).not.toMatch(/DROP TABLE|DELETE FROM|TRUNCATE|ALTER TABLE|UPDATE "Task"/i);
  expect(sql).toContain('REFERENCES "GitHubRepositoryConnection"("projectId", "id")');
  expect(sql).toContain('REFERENCES "Project"("workspaceId", "id")');
  expect(sql).toContain('PRIMARY KEY ("runId", "connectionId")');
});
it('keeps heartbeat evidence alive during long in-flight work and records graceful shutdown', async () => {
  vi.useFakeTimers();
  const pulse = vi.fn().mockResolvedValue(1);
  const finish = vi.fn().mockResolvedValue(1);
  const health = createWorkerHealth(workerOptions.parse({}), false, { pulse, finish });
  const controller = new AbortController();
  let release!: (result: boolean) => void;
  const process = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
  );
  const running = runGitHubWorker(
    workerOptions.parse({ concurrency: 1 }),
    false,
    controller.signal,
    {
      health,
      process,
      recover: vi.fn(),
      idle: vi.fn(),
    },
  );
  await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_MS * 2);
  expect(process).toHaveBeenCalledOnce();
  expect(pulse).toHaveBeenCalledTimes(3);
  expect(pulse.mock.calls.every(([input]) => input.polled === false)).toBe(true);
  health.progress('local');
  controller.abort();
  release(true);
  await running;
  expect(finish.mock.calls[0][1]).toBe('STOPPED');
  expect(pulse.mock.calls.at(-1)![0].progress).toEqual(['local']);
});

it('coalesces frequent queue polls and preserves their latest idle/progress evidence', async () => {
  vi.useFakeTimers();
  const pulse = vi.fn().mockResolvedValue(1);
  const health = createWorkerHealth(workerOptions.parse({ pollMs: 250 }), false, {
    pulse,
    finish: vi.fn().mockResolvedValue(1),
  });
  await health.start();
  await health.polled(false);
  for (let i = 0; i < 40; i++) await health.polled(true);
  health.progress('local');
  expect(pulse).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_MS);
  expect(pulse).toHaveBeenCalledTimes(3);
  expect(pulse.mock.calls.at(-1)![0]).toMatchObject({
    polled: true,
    idle: true,
    progress: ['local'],
  });
  await health.stop('STOPPED');
});
