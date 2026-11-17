import { z } from 'zod';
import { db } from './db';
import { HttpError } from './errors';
import { authorizeGitHubProject } from './github-repositories';
import { classifyWorkerHealth, type WorkerHealthEvidence } from './github-worker-health';
import type { WorkspaceActor } from './tasks';

type DeliverySummary = {
  total: number;
  pending: number;
  ready: number;
  scheduled: number;
  processing: number;
  expiredLeases: number;
  failed: number;
  deadLettered: number;
  processed: number;
  cancelled: number;
  oldestReadyAt: Date | null;
  nextScheduledAt: Date | null;
  lastReceivedAt: Date | null;
  lastProcessedAt: Date | null;
};
type AutomationSummary = {
  total: number;
  pending: number;
  ready: number;
  scheduled: number;
  applied: number;
  skipped: number;
  conflicted: number;
  failed: number;
  oldestReadyAt: Date | null;
  nextScheduledAt: Date | null;
};
type WorkerTimes = {
  lastHeartbeatAt: Date | null;
  lastPollAt: Date | null;
  lastAttemptProgressAt: Date | null;
  lastBoundedHeartbeatAt: Date | null;
};
/** Read-only diagnostics. Never return payloads, free-form stored errors or global run IDs. */
export async function githubOperationalHealth(actor: WorkspaceActor, connectionId: string) {
  connectionId = z.string().min(1).max(128).parse(connectionId);
  return db.$transaction(
    async (tx) => {
      const connection = await tx.gitHubRepositoryConnection.findFirst({
        where: { id: connectionId, workspaceId: actor.workspaceId },
        select: { id: true, projectId: true, disconnectedAt: true },
      });
      if (!connection) throw new HttpError(404, 'Repository connection not found');
      // Defaults to administrator-only; do not substitute a workspace membership check.
      const project = await authorizeGitHubProject(tx, actor, connection.projectId);
      const [{ now }] = await tx.$queryRaw<
        { now: Date }[]
      >`SELECT transaction_timestamp() AS "now"`;
      const workspaceId = actor.workspaceId;
      const projectId = connection.projectId;
      const [signals, [times], [deliveries], [automation]] = await Promise.all([
        // Representative evidence from every classifier bucket. A LIMIT on recent rows
        // alone could hide a healthy replica behind many stalled/ended ones.
        tx.$queryRaw<WorkerHealthEvidence[]>`SELECT DISTINCT ON ("mode", category)
        "mode", "state", "heartbeatAt", "polledAt", "idleAt", "staleAfterMs"
        FROM (SELECT "mode", "state", "heartbeatAt", "polledAt", "idleAt", "staleAfterMs",
          CASE WHEN "mode" = 'CONTINUOUS' AND "state" = 'RUNNING'
            AND "heartbeatAt" <= ${now} AND "heartbeatAt" >= ${now}::timestamp - "staleAfterMs" * interval '1 millisecond'
          THEN CASE WHEN "polledAt" <= ${now} AND "polledAt" >= ${now}::timestamp - "staleAfterMs" * interval '1 millisecond'
            THEN CASE WHEN "idleAt" IS NULL THEN 'active' ELSE 'idle' END ELSE 'heartbeat_only' END
          WHEN "heartbeatAt" <= ${now} THEN 'history' ELSE 'future' END AS category
          FROM "GitHubWorkerSignal" WHERE "workspaceId" = ${workspaceId}
            AND "projectId" = ${projectId} AND "connectionId" = ${connectionId}
        ) evidence ORDER BY "mode", category, "heartbeatAt" DESC`,
        tx.$queryRaw<WorkerTimes[]>`SELECT max("heartbeatAt") AS "lastHeartbeatAt",
        max("polledAt") AS "lastPollAt", max("progressAt") AS "lastAttemptProgressAt",
        max("heartbeatAt") FILTER (WHERE "mode" = 'BOUNDED') AS "lastBoundedHeartbeatAt"
        FROM "GitHubWorkerSignal" WHERE "workspaceId" = ${workspaceId}
          AND "projectId" = ${projectId} AND "connectionId" = ${connectionId}`,
        tx.$queryRaw<DeliverySummary[]>`SELECT
        count(*)::int AS total, count(*) FILTER (WHERE "state" = 'PENDING')::int AS pending,
        count(*) FILTER (WHERE "state" = 'FAILED')::int AS failed,
        count(*) FILTER (WHERE "state" IN ('PENDING','FAILED') AND "deadLetteredAt" IS NULL AND "availableAt" <= ${now})::int AS ready,
        count(*) FILTER (WHERE "state" IN ('PENDING','FAILED') AND "deadLetteredAt" IS NULL AND "availableAt" > ${now})::int AS scheduled,
        count(*) FILTER (WHERE "state" = 'PROCESSING')::int AS processing,
        count(*) FILTER (WHERE "state" = 'PROCESSING' AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${now}))::int AS "expiredLeases",
        count(*) FILTER (WHERE "state" = 'FAILED' AND "deadLetteredAt" IS NOT NULL)::int AS "deadLettered",
        count(*) FILTER (WHERE "state" = 'PROCESSED')::int AS processed,
        count(*) FILTER (WHERE "state" = 'CANCELLED')::int AS cancelled,
        min("receivedAt") FILTER (WHERE "state" IN ('PENDING','FAILED') AND "deadLetteredAt" IS NULL AND "availableAt" <= ${now}) AS "oldestReadyAt",
        min("availableAt") FILTER (WHERE "state" IN ('PENDING','FAILED') AND "deadLetteredAt" IS NULL AND "availableAt" > ${now}) AS "nextScheduledAt",
        max("receivedAt") AS "lastReceivedAt", max("processedAt") AS "lastProcessedAt"
        FROM "GitHubWebhookDelivery" WHERE "connectionId" = ${connectionId}`,
        tx.$queryRaw<AutomationSummary[]>`SELECT
        count(*)::int AS total, count(*) FILTER (WHERE "state" = 'PENDING')::int AS pending,
        count(*) FILTER (WHERE "state" = 'PENDING' AND "availableAt" <= ${now})::int AS ready,
        count(*) FILTER (WHERE "state" = 'PENDING' AND "availableAt" > ${now})::int AS scheduled,
        count(*) FILTER (WHERE "state" = 'APPLIED')::int AS applied,
        count(*) FILTER (WHERE "state" = 'SKIPPED')::int AS skipped,
        count(*) FILTER (WHERE "state" = 'CONFLICTED')::int AS conflicted,
        count(*) FILTER (WHERE "state" = 'FAILED')::int AS failed,
        min("createdAt") FILTER (WHERE "state" = 'PENDING' AND "availableAt" <= ${now}) AS "oldestReadyAt",
        min("availableAt") FILTER (WHERE "state" = 'PENDING' AND "availableAt" > ${now}) AS "nextScheduledAt"
        FROM "GitHubWorkflowExecution" WHERE "workspaceId" = ${workspaceId}
          AND "projectId" = ${projectId} AND "connectionId" = ${connectionId}`,
      ]);
      const state = connection.disconnectedAt
        ? 'DISCONNECTED'
        : project.archivedAt
          ? 'PROJECT_ARCHIVED'
          : classifyWorkerHealth(signals, now);
      const diagnostics: { code: string; message: string }[] = [];
      const add = (code: string, message: string) => diagnostics.push({ code, message });
      if (state === 'DISCONNECTED')
        add(
          'CONNECTION_DISCONNECTED',
          'This connection is disconnected. Historical counts are read-only; no worker availability is inferred.',
        );
      else if (state === 'PROJECT_ARCHIVED')
        add(
          'PROJECT_ARCHIVED',
          'This project is archived. Historical counts do not represent executable work.',
        );
      else {
        if (state === 'INSUFFICIENT_EVIDENCE')
          add(
            'WORKER_EVIDENCE_INSUFFICIENT',
            'No recent completed poll is established. Check worker deployment, database migration and logs; a heartbeat alone does not establish progress.',
          );
        if (state === 'BOUNDED_RUN')
          add(
            'WORKER_BOUNDED_ONLY',
            'Only bounded-run evidence is available. Verify continuous-worker deployment if continuous processing is expected.',
          );
        if (state === 'UNAVAILABLE')
          add(
            'WORKER_CONTINUOUS_SIGNAL_MISSING',
            'No fresh continuous-worker signal remains. Check the intended worker deployment and logs; this is not proof of host failure.',
          );
        if (deliveries.expiredLeases)
          add(
            'DELIVERY_LEASES_EXPIRED',
            'Delivery leases have expired. Check continuous-worker recovery and database connectivity; do not reset delivery receipts.',
          );
        if (deliveries.ready || automation.ready)
          add(
            'WORK_SCHEDULED_NOW',
            'Work is scheduled at or before this snapshot. Review worker evidence and oldest queued timestamps; eligibility is revalidated during processing.',
          );
      }
      if (deliveries.scheduled || automation.scheduled)
        add(
          'WORK_SCHEDULED_LATER',
          'Work is scheduled for a later time, including possible retry backoff. This alone does not indicate an unhealthy worker.',
        );
      if (deliveries.deadLettered)
        add(
          'DELIVERY_DEAD_LETTERS',
          'Review failed deliveries in the existing processing panel. Retry only eligible failures after investigating the cause.',
        );
      if (automation.failed || automation.conflicted)
        add(
          'AUTOMATION_TERMINAL_OUTCOMES',
          'Review failed or conflicted executions in workflow history. This read does not retry or execute them.',
        );
      return {
        asOf: now,
        scope: {
          workspaceId,
          projectId,
          connectionId,
          disconnected: !!connection.disconnectedAt,
          archived: !!project.archivedAt,
        },
        worker: { state, ...times },
        deliveries,
        automation,
        diagnostics,
      };
    },
    { isolationLevel: 'RepeatableRead' },
  );
}
