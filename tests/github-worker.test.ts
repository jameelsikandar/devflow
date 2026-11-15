import { expect, it } from 'vitest';
import { retryDelay, workerOptions } from '../src/lib/server/github-processing';
it('bounds worker concurrency, leases, retries and once-mode workload', () => {
  expect(workerOptions.parse({})).toMatchObject({ concurrency: 2, maxAttempts: 8, onceLimit: 25 });
  for (const bad of [
    { concurrency: 100 },
    { leaseSeconds: 0 },
    { onceLimit: -1 },
    { maxAttempts: 0 },
  ])
    expect(workerOptions.safeParse(bad).success).toBe(false);
});
it('uses bounded exponential backoff with jitter', () => {
  expect(retryDelay(1, () => 0)).toBe(1000);
  expect(retryDelay(1, () => 1)).toBe(2000);
  expect(retryDelay(20, () => 1)).toBe(600000);
});

import { vi } from 'vitest';
import { runGitHubWorker } from '../src/lib/server/github-worker-runtime';
import { githubWorkerLog } from '../src/lib/server/github-processing';
it('runs bounded once-mode batches and stops claiming after shutdown', async () => {
  const options = workerOptions.parse({ concurrency: 2, onceLimit: 3 });
  const controller = new AbortController();
  let active = 0;
  let maximum = 0;
  const process = vi.fn(async () => {
    active++;
    maximum = Math.max(maximum, active);
    await Promise.resolve();
    active--;
    return true;
  });
  const recover = vi.fn(async () => 0);
  const idle = vi.fn(async () => {});
  expect(await runGitHubWorker(options, true, controller.signal, { process, recover, idle })).toBe(
    3,
  );
  expect(maximum).toBe(2);
  expect(process).toHaveBeenCalledTimes(3);
  controller.abort();
  await runGitHubWorker(options, false, controller.signal, { process, recover, idle });
  expect(process).toHaveBeenCalledTimes(3);
});
it('drains in-flight jobs when shutdown is requested', async () => {
  const controller = new AbortController();
  let finished = 0;
  const process = vi.fn(async () => {
    controller.abort();
    await Promise.resolve();
    finished++;
    return true;
  });
  await runGitHubWorker(workerOptions.parse({ concurrency: 2 }), false, controller.signal, {
    process,
    recover: async () => 0,
    idle: async () => {},
  });
  expect(finished).toBe(2);
  expect(process).toHaveBeenCalledTimes(2);
});
it('does not log untrusted failure messages, event strings or credentials', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    githubWorkerLog(
      'failed',
      { id: 'delivery', leaseToken: 'secret-token', event: 'private content', attempts: 1 },
      'private-token',
    );
    const output = String(log.mock.calls[0][0]);
    expect(output).not.toContain('private');
    expect(output).not.toContain('secret-token');
    expect(output).toContain('WORKER_FAILURE');
  } finally {
    log.mockRestore();
  }
});
