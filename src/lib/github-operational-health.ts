import { z } from 'zod';
const timestamp = z.string().datetime({ offset: true });
const count = z.number().int().nonnegative();
export const HEALTH_REFRESH_MS = 30000;
export const HEALTH_SNAPSHOT_MAX_AGE_MS = 90000;
export const operationalHealthSchema = z.object({
  asOf: timestamp,
  scope: z.object({
    workspaceId: z.string(),
    projectId: z.string(),
    connectionId: z.string(),
    disconnected: z.boolean(),
    archived: z.boolean(),
  }),
  worker: z.object({
    state: z.enum([
      'HEALTHY_IDLE',
      'HEALTHY_ACTIVE',
      'UNAVAILABLE',
      'BOUNDED_RUN',
      'INSUFFICIENT_EVIDENCE',
      'DISCONNECTED',
      'PROJECT_ARCHIVED',
    ]),
    lastHeartbeatAt: timestamp.nullable(),
    lastPollAt: timestamp.nullable(),
    lastAttemptProgressAt: timestamp.nullable(),
    lastBoundedHeartbeatAt: timestamp.nullable(),
  }),
  deliveries: z.object({
    total: count,
    pending: count,
    failed: count,
    ready: count,
    scheduled: count,
    processing: count,
    expiredLeases: count,
    deadLettered: count,
    processed: count,
    cancelled: count,
    oldestReadyAt: timestamp.nullable(),
    nextScheduledAt: timestamp.nullable(),
    lastReceivedAt: timestamp.nullable(),
    lastProcessedAt: timestamp.nullable(),
  }),
  automation: z.object({
    total: count,
    pending: count,
    ready: count,
    scheduled: count,
    applied: count,
    skipped: count,
    conflicted: count,
    failed: count,
    oldestReadyAt: timestamp.nullable(),
    nextScheduledAt: timestamp.nullable(),
  }),
  // Render only recognized codes using local copy; ignore arbitrary response messages.
  diagnostics: z.array(z.object({ code: z.string().max(64) })).max(20),
});
export type OperationalHealth = z.infer<typeof operationalHealthSchema>;
export const workerHealthLabels: Record<
  OperationalHealth['worker']['state'],
  { title: string; description: string }
> = {
  HEALTHY_IDLE: {
    title: 'Healthy idle',
    description:
      'A recent continuous heartbeat and empty completed batch were observed. Idle is healthy.',
  },
  HEALTHY_ACTIVE: {
    title: 'Active',
    description:
      'A recent continuous heartbeat and completed batch with work were observed. Individual job outcomes are shown separately.',
  },
  UNAVAILABLE: {
    title: 'Unavailable',
    description:
      'No fresh continuous-worker signal remains. Check deployment and logs; this does not prove host failure.',
  },
  BOUNDED_RUN: {
    title: 'Bounded run',
    description:
      'Only bounded-run evidence is available. A one-time run does not establish continuous service.',
  },
  INSUFFICIENT_EVIDENCE: {
    title: 'Insufficient evidence',
    description:
      'Recent completed polling is not established. A heartbeat alone does not establish progress.',
  },
  DISCONNECTED: {
    title: 'Disconnected',
    description:
      'This connection is disconnected. Counts are historical and do not establish worker availability.',
  },
  PROJECT_ARCHIVED: {
    title: 'Project archived',
    description:
      'This project is archived. Counts are historical and do not represent executable work.',
  },
};
export const operationalGuidance: Record<string, string> = {
  CONNECTION_DISCONNECTED:
    'This connection is disconnected. Inspect historical records without assuming that work can execute.',
  PROJECT_ARCHIVED: 'This project is archived. Historical counts do not represent executable work.',
  WORKER_EVIDENCE_INSUFFICIENT:
    'Check worker deployment, database migration and logs. A heartbeat alone does not establish progress.',
  WORKER_BOUNDED_ONLY:
    'Verify continuous-worker deployment if continuous processing is expected. Bounded runs provide separate evidence.',
  WORKER_CONTINUOUS_SIGNAL_MISSING:
    'Check the intended continuous-worker deployment and logs. A missing signal is not proof of host failure.',
  DELIVERY_LEASES_EXPIRED:
    'Inspect worker recovery and database connectivity. Do not reset delivery receipts.',
  WORK_SCHEDULED_NOW:
    'Review worker evidence and oldest queued timestamps. Eligibility is revalidated during processing.',
  WORK_SCHEDULED_LATER:
    'Some work is scheduled later, including possible retry backoff. This alone does not indicate an unhealthy worker.',
  DELIVERY_DEAD_LETTERS:
    'Inspect failed deliveries below. Retry only eligible failures after investigating their cause.',
  AUTOMATION_TERMINAL_OUTCOMES:
    'Inspect failed or conflicted outcomes in the existing workflow execution history. Refreshing health does not retry them.',
};
export function operationalSnapshotState(asOf: string, now: number) {
  const stamp = Date.parse(asOf);
  if (stamp > now + 5000) return 'clock_difference' as const;
  return now - stamp > HEALTH_SNAPSHOT_MAX_AGE_MS ? ('stale' as const) : ('current' as const);
}
