import { db } from '../src/lib/server/db';
import { githubWorkerLog, workerOptions } from '../src/lib/server/github-processing';
import { runGitHubWorker } from '../src/lib/server/github-worker-runtime';
async function main() {
  const allowed = new Set(['--once']);
  if (process.argv.slice(2).some((arg) => !allowed.has(arg))) throw new Error('INVALID_ARGUMENT');
  const once = process.argv.includes('--once');
  const options = workerOptions.parse({
    connectionId: process.env.GITHUB_WORKER_CONNECTION_ID,
    concurrency: process.env.GITHUB_WORKER_CONCURRENCY,
    leaseSeconds: process.env.GITHUB_WORKER_LEASE_SECONDS,
    maxAttempts: process.env.GITHUB_WORKER_MAX_ATTEMPTS,
    pollMs: process.env.GITHUB_WORKER_POLL_MS,
    onceLimit: process.env.GITHUB_WORKER_ONCE_LIMIT,
  });
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    await db.$connect();
    githubWorkerLog('started');
    await runGitHubWorker(options, once, controller.signal);
  } finally {
    stop();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await db.$disconnect();
    githubWorkerLog('stopped');
  }
}
void main().catch(() => {
  githubWorkerLog('fatal', undefined, 'WORKER_START_OR_DATABASE_FAILURE');
  process.exitCode = 1;
});
