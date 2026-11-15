import { z } from 'zod';
import { canonicalTaskReference } from './task-reference';

export const workflowTriggers = {
  PR_OPENED: 'Pull request opened',
  PR_READY_FOR_REVIEW: 'Pull request ready for review',
  PR_MERGED: 'Pull request merged',
  PR_CLOSED_UNMERGED: 'Pull request closed without merge',
} as const;
export const workflowDefinition = z
  .object({
    name: z.string().trim().min(1).max(100),
    connectionId: z.string().min(1).max(128).nullable(),
    trigger: z.enum(['PR_OPENED', 'PR_READY_FOR_REVIEW', 'PR_MERGED', 'PR_CLOSED_UNMERGED']),
    targetStatus: z.enum(['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE']),
    enabled: z.boolean().default(false),
    priority: z.number().int().min(0).max(10000).default(100),
  })
  .strict();
export type WorkflowDefinition = z.infer<typeof workflowDefinition>;
export type WorkflowRule = WorkflowDefinition & { id: string; version: number };
export const prWorkflowFacts = z.object({
  repositoryId: z.string().regex(/^[1-9]\d*$/),
  action: z.string(),
  number: z.number().int().positive().safe(),
  state: z.enum(['open', 'closed']),
  merged: z.boolean(),
  sourceUpdatedAt: z.string().datetime(),
  taskRefs: z.array(z.string()).max(100),
});
export type WorkflowTask = {
  id: string;
  number: number;
  title: string;
  status: WorkflowDefinition['targetStatus'];
  version: number;
};
export type WorkflowPreviewInput = {
  observationId: string;
  connectionId: string;
  repositoryId: string;
  objectKey: string;
  kind: string;
  event: string;
  dataVersion: number;
  data: unknown;
  currentData: unknown;
  sourceUpdatedAt: string | null;
  disconnected: boolean;
  archived: boolean;
  processed: boolean;
  duplicate: boolean;
  incomplete: boolean;
  unresolvedRefs: string[];
  tasks: WorkflowTask[];
};
export const workflowPreviewReasons: Record<string, string> = {
  NOT_PULL_REQUEST: 'This observation is not a pull request event.',
  MISSING_DATA: 'The original webhook lacks reliable PR state, references or source time.',
  IDENTITY_MISMATCH: 'Stored repository or pull request identity is inconsistent.',
  UNSUPPORTED_ACTION: 'This PR action is not a supported trigger.',
  DISCONNECTED: 'The repository connection is disconnected.',
  ARCHIVED: 'The project is archived.',
  NOT_PROCESSED: 'The delivery has not completed processing.',
  INCOMPLETE: 'The observation is incomplete or contains unresolved task references.',
  AMBIGUOUS_TASKS: 'The event references multiple tasks; no single target can be selected safely.',
  NO_TASK: 'No task link evidence from this observation matches its original references.',
  STALE_EVENT:
    'This observation is older than the current source state or more than seven days old.',
  FUTURE_EVENT: 'The source timestamp is unexpectedly in the future.',
  STATE_CONFLICT: 'The current source projection contradicts this observation.',
  DUPLICATE_EVENT: 'An earlier observation contains these same webhook facts.',
  RULE_CONFLICT: 'Matching rules at the highest priority propose different statuses.',
};
/** A pure preview. No imports from server, worker, task services, or database clients. */
export function evaluateGitHubWorkflow(
  input: WorkflowPreviewInput,
  rules: WorkflowRule[],
  includeDisabled = false,
  now = Date.now(),
) {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const block = (code: string) => {
    if (!blockers.includes(code)) blockers.push(code);
  };
  if (input.disconnected) block('DISCONNECTED');
  if (input.archived) block('ARCHIVED');
  if (!input.processed) block('NOT_PROCESSED');
  if (input.incomplete || input.unresolvedRefs.length) block('INCOMPLETE');
  if (input.duplicate) block('DUPLICATE_EVENT');
  if (input.kind !== 'PULL_REQUEST' || input.event !== 'pull_request') block('NOT_PULL_REQUEST');
  const parsed = prWorkflowFacts.safeParse(input.data);
  let trigger: WorkflowDefinition['trigger'] | null = null;
  let tasks: WorkflowTask[] = [];
  if (!parsed.success || input.dataVersion !== 2) block('MISSING_DATA');
  else {
    const p = parsed.data;
    if (p.repositoryId !== input.repositoryId || String(p.number) !== input.objectKey)
      block('IDENTITY_MISMATCH');
    if (p.action === 'opened' && p.state === 'open' && !p.merged) trigger = 'PR_OPENED';
    if (p.action === 'ready_for_review' && p.state === 'open' && !p.merged)
      trigger = 'PR_READY_FOR_REVIEW';
    if (p.action === 'closed' && p.state === 'closed')
      trigger = p.merged ? 'PR_MERGED' : 'PR_CLOSED_UNMERGED';
    if (!trigger) block('UNSUPPORTED_ACTION');
    const time = Date.parse(p.sourceUpdatedAt);
    if (
      !input.sourceUpdatedAt ||
      Date.parse(input.sourceUpdatedAt) !== time ||
      now - time > 7 * 86400000
    )
      block('STALE_EVENT');
    if (time > now + 300000) block('FUTURE_EVENT');
    const current = prWorkflowFacts
      .pick({ number: true, state: true, merged: true, repositoryId: true, taskRefs: true })
      .safeParse(input.currentData);
    if (!current.success) block('MISSING_DATA');
    else if (
      current.data.repositoryId !== p.repositoryId ||
      current.data.number !== p.number ||
      current.data.state !== p.state ||
      current.data.merged !== p.merged
    )
      block('STATE_CONFLICT');
    if (current.success) {
      const currentRefs = new Set(current.data.taskRefs.map(canonicalTaskReference));
      const originalRefs = new Set(p.taskRefs.map(canonicalTaskReference));
      if (
        currentRefs.has(null) ||
        originalRefs.size !== currentRefs.size ||
        [...originalRefs].some((r) => !currentRefs.has(r))
      )
        block('STATE_CONFLICT');
    }
    const refs = new Set(p.taskRefs.map(canonicalTaskReference));
    if (refs.has(null)) block('MISSING_DATA');
    tasks = input.tasks.filter((t) => refs.has(`DEV-${t.number}`));
    if (refs.size > 1 || tasks.length > 1) block('AMBIGUOUS_TASKS');
    if (!tasks.length) block('NO_TASK');
    if (tasks.length !== refs.size) block('INCOMPLETE');
  }
  const ordered = [...rules].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const matches = ordered.map((rule) => ({
    ...rule,
    reason:
      rule.connectionId && rule.connectionId !== input.connectionId
        ? 'OTHER_CONNECTION'
        : rule.trigger !== trigger
          ? 'OTHER_TRIGGER'
          : !rule.enabled && !includeDisabled
            ? 'DISABLED'
            : 'MATCH',
  }));
  const candidates = matches.filter((r) => r.reason === 'MATCH');
  const first = candidates[0];
  if (
    first &&
    new Set(candidates.filter((r) => r.priority === first.priority).map((r) => r.targetStatus))
      .size > 1
  )
    block('RULE_CONFLICT');
  if (
    first &&
    candidates.some((r) => r.priority > first.priority && r.targetStatus !== first.targetStatus)
  )
    warnings.push('Lower-priority matching rules are overridden.');
  if (includeDisabled) warnings.push('Hypothetical preview includes disabled rules.');
  const task = tasks[0];
  return {
    observationId: input.observationId,
    dryRun: true as const,
    trigger,
    blockers,
    warnings,
    matches,
    transition:
      !blockers.length && first && task
        ? {
            taskId: task.id,
            reference: `DEV-${String(task.number).padStart(3, '0')}`,
            title: task.title,
            from: task.status,
            to: first.targetStatus,
            taskVersion: task.version,
            ruleId: first.id,
            ruleVersion: first.version,
            alreadyAtTarget: task.status === first.targetStatus,
            hypothetical: !first.enabled || includeDisabled,
          }
        : null,
  };
}
export type WorkflowPreview = ReturnType<typeof evaluateGitHubWorkflow>;
