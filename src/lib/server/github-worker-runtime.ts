import { processNextGitHubAutomation } from './github-automation';
import { setTimeout as delay } from 'node:timers/promises';
import { recoverExpiredDeliveries, type WorkerOptions } from './github-processing';
import { processNextGitHubDelivery } from './github-job';
export async function runGitHubWorker(
  options: WorkerOptions,
  once: boolean,
  signal: AbortSignal,
  dependencies = {
    recover: () => recoverExpiredDeliveries(options.maxAttempts, options.connectionId),
    process: async () =>
      (await processNextGitHubAutomation(options)) || processNextGitHubDelivery(options),
    idle: () => delay(options.pollMs, undefined, { signal }).catch(() => {}),
  },
) {
  let claimed = 0;
  while (!signal.aborted && (!once || claimed < options.onceLimit)) {
    await dependencies.recover();
    if (signal.aborted) break;
    const width = once
      ? Math.min(options.concurrency, options.onceLimit - claimed)
      : options.concurrency;
    // Wait for every in-flight job even when one loses database connectivity.
    const outcomes = await Promise.allSettled(
      Array.from({ length: width }, () => dependencies.process()),
    );
    if (outcomes.some((r) => r.status === 'rejected')) throw new Error('WORKER_DATABASE_FAILURE');
    const count = outcomes.filter((r) => r.status === 'fulfilled' && r.value).length;
    claimed += count;
    if (once && count === 0) break;
    if (!count && !signal.aborted) await dependencies.idle();
  }
  return claimed;
}
