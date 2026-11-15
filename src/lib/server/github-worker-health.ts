import { randomUUID } from 'node:crypto';
import type { GitHubWorkerSignal, GitHubWorkerRunState } from '@prisma/client';
import { db } from './db';
import { githubWorkerLog, type WorkerOptions } from './github-processing';

export const WORKER_HEARTBEAT_MS = 10000;
export function workerStaleAfterMs(pollMs: number) {
  return Math.max(45000, pollMs * 3 + WORKER_HEARTBEAT_MS);
}
export type WorkerSignalInput = {
  runId: string;
  connectionId?: string;
  once: boolean;
  staleAfterMs: number;
  polled: boolean;
  idle: boolean;
  progress: string[];
};
/** Database clock, no hostnames, tokens, job payloads, or cross-scope progress counters. */
export async function persistWorkerSignal(input: WorkerSignalInput) {
  const progress = input.progress;
  return db.$transaction(async (tx) => {
    // FK checks also acquire locks. Acquire project locks first, before insertion can
    // lock a connection: preserve the worker/disconnect project → connection order.
    const projects = await tx.$queryRaw<{ id: string }[]>`SELECT p."id" FROM "Project" p
      WHERE p."archivedAt" IS NULL AND EXISTS (
        SELECT 1 FROM "GitHubRepositoryConnection" c WHERE c."projectId" = p."id"
          AND c."workspaceId" = p."workspaceId" AND c."disconnectedAt" IS NULL
          AND (${input.connectionId ?? null}::text IS NULL OR c."id" = ${input.connectionId ?? null})
      ) ORDER BY p."id" FOR KEY SHARE OF p`;
    if (!projects.length) return 0;
    const projectIds = projects.map((p) => p.id);
    return tx.$executeRaw`INSERT INTO "GitHubWorkerSignal"
    ("runId", "connectionId", "workspaceId", "projectId", "mode", "staleAfterMs",
     "heartbeatAt", "polledAt", "progressAt", "idleAt")
    SELECT ${input.runId}, c."id", c."workspaceId", c."projectId",
      ${input.once ? 'BOUNDED' : 'CONTINUOUS'}::"GitHubWorkerMode", ${input.staleAfterMs},
      clock_timestamp(), CASE WHEN ${input.polled} THEN clock_timestamp() END,
      CASE WHEN c."id" = ANY(${progress}::text[]) THEN clock_timestamp() END,
      CASE WHEN ${input.polled && input.idle} THEN clock_timestamp() END
    FROM "GitHubRepositoryConnection" c JOIN "Project" p
      ON p."id" = c."projectId" AND p."workspaceId" = c."workspaceId"
    WHERE c."projectId" = ANY(${projectIds}::text[])
      AND c."disconnectedAt" IS NULL AND p."archivedAt" IS NULL
      AND (${input.connectionId ?? null}::text IS NULL OR c."id" = ${input.connectionId ?? null})
    ON CONFLICT ("runId", "connectionId") DO UPDATE SET
      "heartbeatAt" = EXCLUDED."heartbeatAt",
      "polledAt" = COALESCE(EXCLUDED."polledAt", "GitHubWorkerSignal"."polledAt"),
      "progressAt" = COALESCE(EXCLUDED."progressAt", "GitHubWorkerSignal"."progressAt"),
      "idleAt" = CASE WHEN ${input.polled} THEN EXCLUDED."idleAt" ELSE "GitHubWorkerSignal"."idleAt" END
    WHERE "GitHubWorkerSignal"."state" = 'RUNNING'`;
  });
}
export async function finishWorkerSignal(
  runId: string,
  state: Exclude<GitHubWorkerRunState, 'RUNNING'>,
) {
  return db.$executeRaw`UPDATE "GitHubWorkerSignal" SET "state" = ${state}::"GitHubWorkerRunState",
    "endedAt" = clock_timestamp() WHERE "runId" = ${runId} AND "state" = 'RUNNING'`;
}
export type WorkerHealthRecorder = {
  start(): Promise<void>;
  progress(connectionId: string): void;
  polled(idle: boolean): Promise<void>;
  stop(state: Exclude<GitHubWorkerRunState, 'RUNNING'>): Promise<void>;
};
export function createWorkerHealth(
  options: WorkerOptions,
  once: boolean,
  storage = { pulse: persistWorkerSignal, finish: finishWorkerSignal },
): WorkerHealthRecorder {
  const runId = randomUUID();
  const progress = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending = Promise.resolve();
  let stopping = false;
  let heartbeatPending = false;
  let pollSequence = 0;
  let persistedPoll = 0;
  let lastIdle = false;
  const pulse = () => {
    pending = pending
      .catch(() => {})
      .then(async () => {
        const observedPoll = pollSequence;
        const polled = observedPoll > persistedPoll;
        const idle = lastIdle;
        const observed = [...progress];
        progress.clear();
        try {
          await storage.pulse({
            runId,
            connectionId: options.connectionId,
            once,
            staleAfterMs: workerStaleAfterMs(options.pollMs),
            polled,
            idle,
            progress: observed,
          });
          persistedPoll = observedPoll;
        } catch (error) {
          for (const id of observed) progress.add(id);
          throw error;
        }
      });
    return pending;
  };
  const safePulse = () =>
    pulse().catch(() => {
      githubWorkerLog('health_unavailable', undefined, 'WORKER_HEALTH_WRITE_FAILED');
    });
  return {
    async start() {
      await pulse(); // Missing migration/database: fail before claiming any work.
      timer = setInterval(() => {
        if (stopping || heartbeatPending) return;
        heartbeatPending = true;
        void safePulse().finally(() => {
          heartbeatPending = false;
        });
      }, WORKER_HEARTBEAT_MS);
      timer.unref();
    },
    progress(connectionId) {
      progress.add(connectionId);
    },
    async polled(idle) {
      pollSequence++;
      lastIdle = idle;
      // First completed poll is immediate; thereafter the periodic pulse coalesces
      // even 250ms queue polling into at most one normal write per ten seconds.
      if (!persistedPoll) await safePulse();
    },
    async stop(state) {
      stopping = true;
      clearInterval(timer);
      await pending.catch(() => {});
      if (progress.size || pollSequence > persistedPoll) await safePulse();
      try {
        await storage.finish(runId, state);
      } catch {
        // No claim of graceful shutdown if persistence failed; prior heartbeat ages out.
        githubWorkerLog('health_unavailable', undefined, 'WORKER_HEALTH_WRITE_FAILED');
      }
    },
  };
}

/** Read-side evidence classifier; no authorization or queue/execution permissions. */
export function classifyWorkerHealth(signals: GitHubWorkerSignal[], now: Date) {
  const continuous = signals.filter((s) => s.mode === 'CONTINUOUS');
  const fresh = continuous.filter(
    (s) =>
      s.state === 'RUNNING' && +now >= +s.heartbeatAt && +now - +s.heartbeatAt <= s.staleAfterMs,
  );
  if (fresh.length) {
    // A heartbeat alone proves liveness, not that polling/processing is advancing.
    const polled = fresh.filter(
      (s) => s.polledAt && +now >= +s.polledAt && +now - +s.polledAt <= s.staleAfterMs,
    );
    if (!polled.length) return 'INSUFFICIENT_EVIDENCE' as const;
    return polled.some((s) => !s.idleAt) ? ('HEALTHY_ACTIVE' as const) : ('HEALTHY_IDLE' as const);
  }
  if (continuous.some((s) => +now >= +s.heartbeatAt)) return 'UNAVAILABLE' as const;
  if (signals.some((s) => s.mode === 'BOUNDED')) return 'BOUNDED_RUN' as const;
  return 'INSUFFICIENT_EVIDENCE' as const;
}
