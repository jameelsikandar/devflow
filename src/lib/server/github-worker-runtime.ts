import { processNextGitHubAutomation } from './github-automation';
import { setTimeout as delay } from 'node:timers/promises';
import { recoverExpiredDeliveries, type WorkerOptions } from './github-processing';
import { processNextGitHubDelivery } from './github-job';
import { createWorkerHealth, type WorkerHealthRecorder } from './github-worker-health';
type WorkerDependencies = {
  recover(): Promise<unknown>;
  process(): Promise<boolean>;
  idle(): Promise<void>;
  health?: WorkerHealthRecorder;
};
export async function runGitHubWorker(
  options: WorkerOptions,
  once: boolean,
  signal: AbortSignal,
  dependencies?: WorkerDependencies,
) {
  // Test-injected processors never start a real database monitor implicitly.
  const health = dependencies ? dependencies.health : createWorkerHealth(options, once);
  const work = dependencies ?? {
    recover: () => recoverExpiredDeliveries(options.maxAttempts, options.connectionId),
    process: async () =>
      (await processNextGitHubAutomation(options, (id) => health?.progress(id))) ||
      processNextGitHubDelivery(options, (id) => health?.progress(id)),
    idle: () => delay(options.pollMs, undefined, { signal }).catch(() => {}),
  };
  if (signal.aborted) return 0;
  await health?.start();
  let endState: 'STOPPED' | 'COMPLETED' | 'FAILED' = 'FAILED';
  try {
    let claimed = 0;
    while (!signal.aborted && (!once || claimed < options.onceLimit)) {
      await work.recover();
      if (signal.aborted) break;
      const width = once
        ? Math.min(options.concurrency, options.onceLimit - claimed)
        : options.concurrency;
      // Wait for every in-flight job even when one loses database connectivity.
      const outcomes = await Promise.allSettled(
        Array.from({ length: width }, () => work.process()),
      );
      if (outcomes.some((r) => r.status === 'rejected')) throw new Error('WORKER_DATABASE_FAILURE');
      const count = outcomes.filter((r) => r.status === 'fulfilled' && r.value).length;
      claimed += count;
      await health?.polled(count === 0);
      if (once && count === 0) break;
      if (!count && !signal.aborted) await work.idle();
    }
    endState = signal.aborted ? 'STOPPED' : 'COMPLETED';
    return claimed;
  } finally {
    await health?.stop(endState);
  }
}
