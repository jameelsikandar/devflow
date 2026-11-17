import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from './db';
import { HttpError } from './errors';
import { authorizeGitHubProject } from './github-repositories';
import {
  RETENTION_SCAN_LIMIT,
  retentionDays,
  retentionReasons,
  type RetentionReport,
} from '../github-retention';
import type { WorkspaceActor } from './tasks';
type Bucket = {
  reason: string;
  count: string;
  oldestAt: Date | null;
  newestAt: Date | null;
  dependencies: string;
};
/** Metadata-only, capped queries. Exported for fixed-clock PostgreSQL boundary tests. */
export function retentionQueries(workspaceId: string, projectId: string, cutoff: Date, now: Date) {
  const sources: {
    kind: RetentionReport['categories'][number]['kind'];
    source: Prisma.Sql;
    classify: Prisma.Sql;
  }[] = [
    {
      kind: 'DELIVERIES',
      source: Prisma.sql`SELECT d."id",d."connectionId",d."receivedAt" AS "at",d."state" FROM "GitHubRepositoryConnection" c JOIN "GitHubWebhookDelivery" d ON d."connectionId"=c."id" WHERE c."workspaceId"=${workspaceId} AND c."projectId"=${projectId}`,
      classify: Prisma.sql`SELECT s."at", CASE WHEN s."state" IN ('PENDING','PROCESSING') THEN 'ACTIVE_PROCESSING' WHEN s."state"='FAILED' THEN 'UNRESOLVED_STATE' ELSE 'REPLAY_PROTECTION' END AS reason,
    (EXISTS(SELECT 1 FROM "GitHubObservation" o WHERE o."connectionId"=s."connectionId" AND o."deliveryId"=s."id") OR EXISTS(SELECT 1 FROM "GitHubWorkflowExecution" e WHERE e."deliveryId"=s."id")) AS dependent FROM bounded s`,
    },
    {
      kind: 'OBSERVATIONS',
      source: Prisma.sql`SELECT o."id",o."receivedAt" AS "at",o."incomplete",cardinality(o."unresolvedRefs")>0 AS unresolved FROM "GitHubRepositoryConnection" c JOIN "GitHubObservation" o ON o."connectionId"=c."id" AND o."projectId"=c."projectId" WHERE c."workspaceId"=${workspaceId} AND c."projectId"=${projectId}`,
      classify: Prisma.sql`SELECT s."at",CASE WHEN s."incomplete" OR s.unresolved THEN 'UNRESOLVED_STATE' ELSE 'AUDIT_PROVENANCE' END AS reason,
    (EXISTS(SELECT 1 FROM "GitHubTaskLinkEvidence" l WHERE l."observationId"=s."id") OR EXISTS(SELECT 1 FROM "GitHubWorkflowExecution" e WHERE e."observationId"=s."id")) AS dependent FROM bounded s`,
    },
    {
      kind: 'OBJECTS',
      source: Prisma.sql`SELECT o."id",o."createdAt" AS "at" FROM "GitHubObject" o WHERE o."workspaceId"=${workspaceId} AND o."projectId"=${projectId}`,
      classify: Prisma.sql`SELECT s."at",'CURRENT_PROJECTION' AS reason,(EXISTS(SELECT 1 FROM "GitHubObservation" o WHERE o."objectId"=s."id") OR EXISTS(SELECT 1 FROM "GitHubTaskLink" l WHERE l."objectId"=s."id")) AS dependent FROM bounded s`,
    },
    {
      kind: 'TASK_LINKS',
      source: Prisma.sql`SELECT l."objectId",l."taskId",l."createdAt" AS "at" FROM "GitHubObject" o JOIN "GitHubTaskLink" l ON l."objectId"=o."id" AND l."projectId"=o."projectId" WHERE o."workspaceId"=${workspaceId} AND o."projectId"=${projectId}`,
      classify: Prisma.sql`SELECT s."at",'TASK_ASSOCIATION' AS reason,EXISTS(SELECT 1 FROM "GitHubTaskLinkEvidence" l WHERE l."objectId"=s."objectId" AND l."taskId"=s."taskId") AS dependent FROM bounded s`,
    },
    {
      kind: 'LINK_EVIDENCE',
      source: Prisma.sql`SELECT o."receivedAt" AS "at" FROM "GitHubRepositoryConnection" c JOIN "GitHubObservation" o ON o."connectionId"=c."id" AND o."projectId"=c."projectId" JOIN "GitHubTaskLinkEvidence" l ON l."observationId"=o."id" AND l."objectId"=o."objectId" WHERE c."workspaceId"=${workspaceId} AND c."projectId"=${projectId}`,
      classify: Prisma.sql`SELECT s."at",'AUDIT_PROVENANCE' AS reason,false AS dependent FROM bounded s`,
    },
    {
      kind: 'EXECUTIONS',
      source: Prisma.sql`SELECT e."id",GREATEST(e."createdAt",e."startedAt",e."completedAt") AS "at",e."state" FROM "GitHubWorkflowExecution" e WHERE e."workspaceId"=${workspaceId} AND e."projectId"=${projectId}`,
      classify: Prisma.sql`SELECT s."at",CASE WHEN s."state"='PENDING' THEN 'ACTIVE_PROCESSING' WHEN s."state" IN ('FAILED','CONFLICTED') THEN 'UNRESOLVED_STATE' ELSE 'AUDIT_PROVENANCE' END AS reason,
    EXISTS(SELECT 1 FROM "TaskActivity" a WHERE a."executionId"=s."id") AS dependent FROM bounded s`,
    },
    {
      kind: 'WORKER_SIGNALS',
      source: Prisma.sql`SELECT w."runId",w."connectionId",w."mode",w."state",w."endedAt",w."heartbeatAt",w."polledAt",w."progressAt",GREATEST(w."startedAt",w."heartbeatAt",w."polledAt",w."progressAt",w."endedAt") AS "at" FROM "GitHubWorkerSignal" w WHERE w."workspaceId"=${workspaceId} AND w."projectId"=${projectId}`,
      classify: Prisma.sql`SELECT s."at",CASE WHEN s."state"='RUNNING' OR s."endedAt" IS NULL THEN 'ACTIVE_PROCESSING' WHEN s."state" NOT IN ('COMPLETED','STOPPED') THEN 'UNRESOLVED_STATE' WHEN s.latest=1 OR s.latest_past=1 OR (s."polledAt" IS NOT NULL AND (s."polledAt"=s.max_poll OR s."polledAt"=s.past_poll)) OR (s."progressAt" IS NOT NULL AND (s."progressAt"=s.max_progress OR s."progressAt"=s.past_progress)) THEN 'WORKER_BASELINE' ELSE 'POTENTIAL_CANDIDATE' END AS reason,false AS dependent FROM (
     SELECT b.*,max(b."polledAt") OVER(PARTITION BY b."connectionId",b."mode") AS max_poll,
     max(b."progressAt") OVER(PARTITION BY b."connectionId",b."mode") AS max_progress,
     max(b."polledAt") FILTER(WHERE b."polledAt"<=${now}) OVER(PARTITION BY b."connectionId",b."mode") AS past_poll,
     max(b."progressAt") FILTER(WHERE b."progressAt"<=${now}) OVER(PARTITION BY b."connectionId",b."mode") AS past_progress,
     row_number() OVER(PARTITION BY b."connectionId",b."mode" ORDER BY b."heartbeatAt" DESC,b."runId" DESC) AS latest,
     row_number() OVER(PARTITION BY b."connectionId",b."mode" ORDER BY CASE WHEN b."heartbeatAt"<=${now} THEN 0 ELSE 1 END,b."heartbeatAt" DESC,b."runId" DESC) AS latest_past FROM bounded b
    ) s`,
    },
  ];
  return sources.map(({ kind, source, classify }) => ({
    kind,
    sql: Prisma.sql`
  WITH source AS MATERIALIZED (${source} LIMIT ${RETENTION_SCAN_LIMIT + 1}),
  sizing AS (SELECT count(*) AS n FROM source),
  bounded AS MATERIALIZED (SELECT s.* FROM source s WHERE (SELECT n FROM sizing)<=${RETENTION_SCAN_LIMIT}),
  classified AS (${classify}),
  buckets AS (SELECT "at",CASE WHEN "at">=${cutoff} THEN 'WITHIN_WINDOW' ELSE reason END AS reason,dependent FROM classified)
  SELECT reason,count(*)::text AS count,min("at") AS "oldestAt",max("at") AS "newestAt",count(*) FILTER(WHERE dependent AND "at"<${cutoff})::text AS dependencies FROM buckets GROUP BY reason
  UNION ALL SELECT 'LIMIT_EXCEEDED',n::text,NULL::timestamp,NULL::timestamp,'0' FROM sizing WHERE n>${RETENTION_SCAN_LIMIT}
 `,
  }));
}
function number(value: string) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new HttpError(503, 'Retention counts exceed supported range');
  return n;
}
function category(
  kind: RetentionReport['categories'][number]['kind'],
  rows: Bucket[],
): RetentionReport['categories'][number] {
  const exceeded = rows.find((r) => r.reason === 'LIMIT_EXCEEDED');
  if (exceeded)
    return {
      kind,
      complete: false,
      scannedAtLeast: number(exceeded.count),
      total: null,
      older: null,
      potentiallyEligible: null,
      preservedOlder: null,
      dependencyProtectedOlder: null,
      oldestAt: null,
      newestAt: null,
      reasons: [],
    };
  const reasons = rows.map((r) => ({
    code: z.enum(retentionReasons).parse(r.reason),
    count: number(r.count),
    oldestAt: r.oldestAt!.toISOString(),
    newestAt: r.newestAt!.toISOString(),
  }));
  const total = reasons.reduce((s, r) => s + r.count, 0),
    within = reasons.find((r) => r.code === 'WITHIN_WINDOW')?.count ?? 0;
  const older = total - within,
    potentiallyEligible = reasons.find((r) => r.code === 'POTENTIAL_CANDIDATE')?.count ?? 0;
  return {
    kind,
    complete: true,
    scannedAtLeast: total,
    total,
    older,
    potentiallyEligible,
    preservedOlder: older - potentiallyEligible,
    dependencyProtectedOlder: rows.reduce((s, r) => s + number(r.dependencies), 0),
    oldestAt: reasons.length
      ? new Date(Math.min(...reasons.map((r) => Date.parse(r.oldestAt)))).toISOString()
      : null,
    newestAt: reasons.length
      ? new Date(Math.max(...reasons.map((r) => Date.parse(r.newestAt)))).toISOString()
      : null,
    reasons,
  };
}
export async function githubRetentionImpact(
  actor: WorkspaceActor,
  projectId: string,
  proposedDays: unknown = 30,
): Promise<RetentionReport> {
  projectId = z.string().min(1).max(128).parse(projectId);
  const days = retentionDays.parse(proposedDays);
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '4s'`;
      const project = await authorizeGitHubProject(tx, actor, projectId);
      const [clock] = await tx.$queryRaw<
        { now: Date; cutoff: Date }[]
      >`SELECT transaction_timestamp() AT TIME ZONE 'UTC' AS now,(transaction_timestamp() AT TIME ZONE 'UTC') - ${days} * interval '24 hours' AS cutoff`;
      const categories = await Promise.all(
        retentionQueries(actor.workspaceId, projectId, clock.cutoff, clock.now).map(
          async ({ kind, sql }) => category(kind, await tx.$queryRaw<Bucket[]>(sql)),
        ),
      );
      return {
        scope: { workspaceId: actor.workspaceId, projectId, archived: !!project.archivedAt },
        asOf: clock.now.toISOString(),
        cutoff: clock.cutoff.toISOString(),
        days,
        scanLimit: RETENTION_SCAN_LIMIT,
        complete: categories.every((c) => c.complete),
        categories,
      };
    },
    { isolationLevel: 'RepeatableRead', timeout: 15000 },
  );
}
