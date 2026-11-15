import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma, GitHubWebhookDelivery, GitHubRepositoryConnection } from '@prisma/client';
import { db } from './db';
import { GitHubProcessingError } from './github-event-handlers';

export const workerOptions = z.object({
  connectionId: z.string().min(1).max(128).optional(),
  concurrency: z.coerce.number().int().min(1).max(8).default(2),
  leaseSeconds: z.coerce.number().int().min(30).max(900).default(120),
  maxAttempts: z.coerce.number().int().min(1).max(20).default(8),
  pollMs: z.coerce.number().int().min(250).max(60000).default(2000),
  onceLimit: z.coerce.number().int().min(1).max(1000).default(25),
});
export type WorkerOptions = z.infer<typeof workerOptions>;
export type DeliveryLease = { id: string; leaseToken: string; attempts: number; event: string };
export function retryDelay(attempt: number, random = Math.random) {
  const cap = Math.min(600000, 1000 * 2 ** Math.min(attempt, 16));
  return Math.floor(cap / 2 + (random() * cap) / 2);
}
export async function recoverExpiredDeliveries(maxAttempts: number, connectionId?: string) {
  return db.$executeRaw`WITH expired AS (
    SELECT "id" FROM "GitHubWebhookDelivery" WHERE
    (${connectionId ?? null}::text IS NULL OR "connectionId" = ${connectionId ?? null}) AND (
      ("state" = 'PROCESSING' AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= clock_timestamp()))
      OR ("state" IN ('PENDING', 'FAILED') AND "attempts" >= ${maxAttempts} AND "deadLetteredAt" IS NULL)
    )
    ORDER BY "leaseExpiresAt" NULLS FIRST, "id" FOR UPDATE SKIP LOCKED LIMIT 100
  ) UPDATE "GitHubWebhookDelivery" d SET "state" = 'FAILED', "leaseToken" = NULL,
    "leaseExpiresAt" = NULL, "lockedAt" = NULL, "availableAt" = clock_timestamp(),
    "errorCode" = CASE WHEN d."state" = 'PROCESSING' THEN 'LEASE_EXPIRED' ELSE 'ATTEMPTS_EXHAUSTED' END, "deadLetteredAt" = CASE WHEN d."attempts" >= ${maxAttempts} THEN clock_timestamp() ELSE NULL END
    FROM expired WHERE d."id" = expired."id"`;
}
export async function claimGitHubDelivery(options: WorkerOptions): Promise<DeliveryLease | null> {
  const token = randomUUID();
  // Delivery-only short transaction: never wait for project/connection locks here.
  const rows = await db.$queryRaw<DeliveryLease[]>`WITH candidate AS (
    SELECT d."id" FROM "GitHubWebhookDelivery" d
    JOIN "GitHubRepositoryConnection" c ON c."id" = d."connectionId"
    JOIN "Project" p ON p."id" = c."projectId" AND p."workspaceId" = c."workspaceId"
    WHERE d."state" IN ('PENDING', 'FAILED') AND d."deadLetteredAt" IS NULL
      AND (${options.connectionId ?? null}::text IS NULL OR d."connectionId" = ${options.connectionId ?? null})
      AND d."availableAt" <= clock_timestamp() AND d."attempts" < ${options.maxAttempts}
      AND c."disconnectedAt" IS NULL AND p."archivedAt" IS NULL
    ORDER BY d."availableAt", d."receivedAt", d."id"
    FOR UPDATE OF d SKIP LOCKED LIMIT 1
  ) UPDATE "GitHubWebhookDelivery" d SET "state" = 'PROCESSING',
    "leaseToken" = ${token}, "lockedAt" = clock_timestamp(),
    "leaseExpiresAt" = clock_timestamp() + ${options.leaseSeconds} * interval '1 second',
    "attempts" = d."attempts" + 1, "errorCode" = NULL
    FROM candidate WHERE d."id" = candidate."id"
    RETURNING d."id", d."leaseToken", d."attempts", d."event"`;
  return rows[0] ?? null;
}
export type GitHubPublishContext = {
  delivery: GitHubWebhookDelivery;
  connection: GitHubRepositoryConnection;
};
export async function completeGitHubDelivery(
  lease: DeliveryLease,
  publish?: (tx: Prisma.TransactionClient, context: GitHubPublishContext) => Promise<void>,
) {
  const source = await db.gitHubWebhookDelivery.findUnique({
    where: { id: lease.id },
    include: { connection: true },
  });
  if (!source) return false;
  return db.$transaction(
    async (tx) => {
      const projects = await tx.$queryRaw<
        { archivedAt: Date | null }[]
      >`SELECT "archivedAt" FROM "Project" WHERE "id" = ${source.connection.projectId} AND "workspaceId" = ${source.connection.workspaceId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "GitHubRepositoryConnection" WHERE "id" = ${source.connectionId} FOR UPDATE`;
      const owned = await tx.$queryRaw<
        { id: string }[]
      >`SELECT "id" FROM "GitHubWebhookDelivery" WHERE "id" = ${lease.id} AND "state" = 'PROCESSING' AND "leaseToken" = ${lease.leaseToken} AND "leaseExpiresAt" > clock_timestamp() FOR UPDATE`;
      if (!owned.length) return false;
      const connection = await tx.gitHubRepositoryConnection.findUniqueOrThrow({
        where: { id: source.connectionId },
      });
      if (!projects.length || projects[0].archivedAt || connection.disconnectedAt) {
        await tx.gitHubWebhookDelivery.update({
          where: { id: lease.id },
          data: {
            state: 'CANCELLED',
            leaseToken: null,
            leaseExpiresAt: null,
            lockedAt: null,
            errorCode: 'CONNECTION_OR_PROJECT_UNAVAILABLE',
          },
        });
        return false;
      }
      const delivery = await tx.gitHubWebhookDelivery.findUniqueOrThrow({
        where: { id: lease.id },
      });
      if (!publish && delivery.event !== 'ping')
        throw new GitHubProcessingError('HANDLER_REQUIRED');
      if (publish) await publish(tx, { delivery, connection });
      // Recheck expiry after publishing too; throwing rolls back all projection/link writes.
      const changed =
        await tx.$executeRaw`UPDATE "GitHubWebhookDelivery" SET "state" = 'PROCESSED', "processedAt" = clock_timestamp(), "leaseToken" = NULL, "leaseExpiresAt" = NULL, "lockedAt" = NULL, "errorCode" = NULL WHERE "id" = ${lease.id} AND "leaseToken" = ${lease.leaseToken} AND "state" = 'PROCESSING' AND "leaseExpiresAt" > clock_timestamp()`;
      if (!changed) throw new GitHubProcessingError('LEASE_LOST', true);
      return true;
    },
    { isolationLevel: 'ReadCommitted' },
  );
}
export async function failGitHubDelivery(
  lease: DeliveryLease,
  error: unknown,
  options: WorkerOptions,
) {
  const failure =
    error instanceof GitHubProcessingError
      ? error
      : new GitHubProcessingError('WORKER_TRANSIENT_FAILURE', true);
  return db.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<
        { attempts: number; now: Date }[]
      >`SELECT "attempts", clock_timestamp() AS "now" FROM "GitHubWebhookDelivery" WHERE "id" = ${lease.id} AND "state" = 'PROCESSING' AND "leaseToken" = ${lease.leaseToken} AND "leaseExpiresAt" > clock_timestamp() FOR UPDATE`;
      if (!rows.length) return false;
      const dead = !failure.retryable || rows[0].attempts >= options.maxAttempts;
      const availableAt = new Date(
        Math.max(+rows[0].now + retryDelay(rows[0].attempts), failure.retryAt ?? 0),
      );
      await tx.gitHubWebhookDelivery.update({
        where: { id: lease.id },
        data: {
          state: 'FAILED',
          errorCode: /^[A-Z_]{1,64}$/.test(failure.code) ? failure.code : 'WORKER_FAILURE',
          availableAt,
          deadLetteredAt: dead ? rows[0].now : null,
          leaseToken: null,
          leaseExpiresAt: null,
          lockedAt: null,
        },
      });
      return true;
    },
    { isolationLevel: 'ReadCommitted' },
  );
}
export function githubWorkerLog(state: string, lease?: DeliveryLease, code?: string) {
  console.log(
    JSON.stringify({
      component: 'github-worker',
      state,
      ...(lease
        ? {
            id: lease.id,
            event: ['ping', 'push', 'pull_request', 'issues', 'workflow_run'].includes(lease.event)
              ? lease.event
              : 'unsupported',
            attempt: lease.attempts,
          }
        : {}),
      ...(code ? { code: /^[A-Z_]{1,64}$/.test(code) ? code : 'WORKER_FAILURE' } : {}),
    }),
  );
}

export async function renewGitHubLease(lease: DeliveryLease, seconds: number) {
  return !!(await db.$executeRaw`UPDATE "GitHubWebhookDelivery" SET "leaseExpiresAt" = clock_timestamp() + ${seconds} * interval '1 second' WHERE "id" = ${lease.id} AND "state" = 'PROCESSING' AND "leaseToken" = ${lease.leaseToken} AND "leaseExpiresAt" > clock_timestamp()`);
}
