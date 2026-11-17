import { z } from 'zod';
export const RETENTION_SCAN_LIMIT = 10000;
export const retentionDays = z.coerce
  .number()
  .pipe(z.union([z.literal(7), z.literal(30), z.literal(90)]))
  .default(30);
export const retentionKinds = [
  'DELIVERIES',
  'OBSERVATIONS',
  'OBJECTS',
  'TASK_LINKS',
  'LINK_EVIDENCE',
  'EXECUTIONS',
  'WORKER_SIGNALS',
] as const;
export const retentionReasons = [
  'WITHIN_WINDOW',
  'ACTIVE_PROCESSING',
  'UNRESOLVED_STATE',
  'REPLAY_PROTECTION',
  'AUDIT_PROVENANCE',
  'CURRENT_PROJECTION',
  'TASK_ASSOCIATION',
  'WORKER_BASELINE',
  'POTENTIAL_CANDIDATE',
] as const;
export const retentionLabels: Record<
  (typeof retentionKinds)[number],
  { title: string; basis: string }
> = {
  DELIVERIES: {
    title: 'Webhook deliveries / processing',
    basis: 'Receipt time; processing state lives in the same row.',
  },
  OBSERVATIONS: { title: 'Source observations', basis: 'Observation receipt time.' },
  OBJECTS: {
    title: 'GitHub objects',
    basis: 'Object creation time; retained current projections.',
  },
  TASK_LINKS: { title: 'Task associations', basis: 'Association creation time.' },
  LINK_EVIDENCE: {
    title: 'Task-link evidence',
    basis: 'Source observation receipt time; evidence has no independent timestamp.',
  },
  EXECUTIONS: {
    title: 'Automation executions',
    basis: 'Latest creation, start or completion time.',
  },
  WORKER_SIGNALS: {
    title: 'Worker signals',
    basis: 'Latest start, heartbeat, poll, progress or end time.',
  },
};
export const retentionReasonLabels: Record<(typeof retentionReasons)[number], string> = {
  WITHIN_WINDOW: 'Within proposed window (including exact cutoff/future timestamps)',
  ACTIVE_PROCESSING: 'Active or unfinished processing',
  UNRESOLVED_STATE: 'Unresolved state or failed processing',
  REPLAY_PROTECTION: 'Replay/deduplication receipts',
  AUDIT_PROVENANCE: 'Audit and provenance / idempotency history',
  CURRENT_PROJECTION: 'Current GitHub object projection',
  TASK_ASSOCIATION: 'Existing task association',
  WORKER_BASELINE: 'Latest worker evidence for its connection/mode',
  POTENTIAL_CANDIDATE: 'Potential policy candidate; no cleanup authorized',
};
const stamp = z.string().datetime({ offset: true });
const n = z.number().int().nonnegative().safe();
export const retentionReportSchema = z.object({
  scope: z.object({ workspaceId: z.string(), projectId: z.string(), archived: z.boolean() }),
  asOf: stamp,
  cutoff: stamp,
  days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
  scanLimit: n,
  complete: z.boolean(),
  categories: z
    .array(
      z.object({
        kind: z.enum(retentionKinds),
        complete: z.boolean(),
        scannedAtLeast: n,
        total: n.nullable(),
        older: n.nullable(),
        potentiallyEligible: n.nullable(),
        preservedOlder: n.nullable(),
        dependencyProtectedOlder: n.nullable(),
        oldestAt: stamp.nullable(),
        newestAt: stamp.nullable(),
        reasons: z
          .array(
            z.object({
              code: z.enum(retentionReasons),
              count: n,
              oldestAt: stamp,
              newestAt: stamp,
            }),
          )
          .max(retentionReasons.length),
      }),
    )
    .length(retentionKinds.length),
});
export type RetentionReport = z.infer<typeof retentionReportSchema>;
export function retentionAgeRange(oldest: string | null, newest: string | null, asOf: string) {
  if (!oldest || !newest) return 'No recorded timestamps';
  if (Date.parse(newest) > Date.parse(asOf)) return 'Includes future-dated activity';
  const days = (value: string) => (Date.parse(asOf) - Date.parse(value)) / 86400000;
  return `${days(newest).toFixed(1)}–${days(oldest).toFixed(1)} days`;
}
