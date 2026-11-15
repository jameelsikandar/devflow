import { expect, it } from 'vitest';
import {
  evaluateGitHubWorkflow,
  workflowDefinition,
  type WorkflowPreviewInput,
  type WorkflowRule,
} from '../src/lib/github-workflows';
const now = Date.parse('2026-11-15T12:00:00Z');
const data = {
  repositoryId: '123',
  action: 'closed',
  number: 12,
  state: 'closed',
  merged: true,
  sourceUpdatedAt: new Date(now - 1000).toISOString(),
  taskRefs: ['DEV-002'],
};
const rule: WorkflowRule = {
  id: 'r',
  version: 1,
  name: 'PR merged → Done',
  connectionId: 'c',
  trigger: 'PR_MERGED',
  targetStatus: 'DONE',
  enabled: true,
  priority: 100,
};
const event: WorkflowPreviewInput = {
  observationId: 'o',
  connectionId: 'c',
  repositoryId: '123',
  objectKey: '12',
  kind: 'PULL_REQUEST',
  event: 'pull_request',
  dataVersion: 2,
  data,
  currentData: data,
  sourceUpdatedAt: data.sourceUpdatedAt,
  disconnected: false,
  archived: false,
  processed: true,
  duplicate: false,
  incomplete: false,
  unresolvedRefs: [],
  tasks: [{ id: 't', number: 2, title: 'DevFlow task', status: 'TODO', version: 7 }],
};
const evaluate = (e: Partial<WorkflowPreviewInput> = {}, rules = [rule], includeDisabled = false) =>
  evaluateGitHubWorkflow({ ...event, ...e }, rules, includeDisabled, now);
it('normalizes padded references, explains the transition and preserves input records', () => {
  const before = structuredClone(event);
  expect(evaluate().transition).toMatchObject({
    reference: 'DEV-002',
    from: 'TODO',
    to: 'DONE',
    taskVersion: 7,
    ruleVersion: 1,
  });
  expect(event).toEqual(before);
  expect(evaluate()).toEqual(evaluate());
});
it('defaults to disabled definitions and strictly validates configuration', () => {
  const definition = {
    name: rule.name,
    connectionId: rule.connectionId,
    trigger: rule.trigger,
    targetStatus: rule.targetStatus,
    priority: rule.priority,
  };
  expect(workflowDefinition.parse(definition).enabled).toBe(false);
  expect(() => workflowDefinition.parse({ ...definition, action: 'execute' })).toThrow();
  expect(() => workflowDefinition.parse({ ...definition, priority: -1 })).toThrow();
});
it('only includes disabled rules with explicit hypothetical opt-in', () => {
  expect(evaluate({}, [{ ...rule, enabled: false }]).transition).toBeNull();
  expect(evaluate({}, [{ ...rule, enabled: false }], true).transition?.hypothetical).toBe(true);
});
it.each([
  ['opened', 'open', false, 'PR_OPENED'],
  ['ready_for_review', 'open', false, 'PR_READY_FOR_REVIEW'],
  ['closed', 'closed', true, 'PR_MERGED'],
  ['closed', 'closed', false, 'PR_CLOSED_UNMERGED'],
] as const)('recognizes only trustworthy %s PR facts', (action, state, merged, trigger) => {
  const d = { ...data, action, state, merged };
  expect(evaluate({ data: d, currentData: d }, [{ ...rule, trigger }]).transition).not.toBeNull();
});
it.each([
  [{ kind: 'COMMIT', event: 'push' }, 'NOT_PULL_REQUEST'],
  [{ data: { ...data, action: 'reconciled' } }, 'UNSUPPORTED_ACTION'],
  [{ data: { ...data, action: 'opened' } }, 'UNSUPPORTED_ACTION'],
  [{ data: { ...data, merged: undefined } }, 'MISSING_DATA'],
  [{ dataVersion: 1 }, 'MISSING_DATA'],
  [{ data: { ...data, repositoryId: '999' } }, 'IDENTITY_MISMATCH'],
  [{ objectKey: '13' }, 'IDENTITY_MISMATCH'],
  [{ sourceUpdatedAt: new Date(now).toISOString() }, 'STALE_EVENT'],
  [{ currentData: { ...data, merged: false } }, 'STATE_CONFLICT'],
  [{ currentData: null }, 'MISSING_DATA'],
  [{ disconnected: true }, 'DISCONNECTED'],
  [{ archived: true }, 'ARCHIVED'],
  [{ processed: false }, 'NOT_PROCESSED'],
  [{ duplicate: true }, 'DUPLICATE_EVENT'],
  [{ incomplete: true }, 'INCOMPLETE'],
  [{ unresolvedRefs: ['DEV-9'] }, 'INCOMPLETE'],
  [{ tasks: [] }, 'NO_TASK'],
  [{ data: { ...data, taskRefs: ['DEV-2', 'DEV-3'] } }, 'AMBIGUOUS_TASKS'],
  [{ data: { ...data, taskRefs: ['evil'] } }, 'MISSING_DATA'],
] as [Partial<WorkflowPreviewInput>, string][])(
  'blocks unsafe observations: %s',
  (patch, reason) => {
    const result = evaluate(patch);
    expect(result.blockers).toContain(reason);
    expect(result.transition).toBeNull();
  },
);
it('blocks old and future timestamps, even if they are the latest known source state', () => {
  for (const [time, reason] of [
    [now - 8 * 86400000, 'STALE_EVENT'],
    [now + 3600000, 'FUTURE_EVENT'],
  ] as const) {
    const sourceUpdatedAt = new Date(time).toISOString();
    expect(evaluate({ data: { ...data, sourceUpdatedAt }, sourceUpdatedAt }).blockers).toContain(
      reason,
    );
  }
});
it('resolves order deterministically, blocking conflicting top priorities', () => {
  const other = { ...rule, id: 'r2', targetStatus: 'IN_REVIEW' as const };
  expect(evaluate({}, [rule, other]).blockers).toContain('RULE_CONFLICT');
  const ordered = evaluate({}, [other, { ...rule, priority: 1 }]);
  expect(ordered.transition?.to).toBe('DONE');
  expect(ordered.warnings).toContain('Lower-priority matching rules are overridden.');
  expect(evaluate({}, [rule, { ...rule, id: 'r2' }]).transition).not.toBeNull();
});
it('enforces repository connection scoping and distinguishes no-op transitions', () => {
  expect(evaluate({}, [{ ...rule, connectionId: 'foreign' }]).matches[0].reason).toBe(
    'OTHER_CONNECTION',
  );
  expect(evaluate({}, [{ ...rule, connectionId: null }]).transition).not.toBeNull();
  expect(
    evaluate({ tasks: [{ ...event.tasks[0], status: 'DONE' }] }).transition?.alreadyAtTarget,
  ).toBe(true);
});
it('equivalent padded aliases do not create ambiguity', () => {
  expect(evaluate({ data: { ...data, taskRefs: ['DEV-2', 'DEV-002'] } }).blockers).toEqual([]);
});

it('rejects reference changes at the same source timestamp instead of guessing a target', () => {
  expect(evaluate({ currentData: { ...data, taskRefs: ['DEV-3'] } }).blockers).toContain(
    'STATE_CONFLICT',
  );
});
it.each([null, 'invalid', 42, [], { webhook: null }])(
  'handles missing or malformed stored facts without throwing: %s',
  (value) => {
    const result = evaluate({ data: value });
    expect(result.blockers).toContain('MISSING_DATA');
    expect(result.transition).toBeNull();
  },
);
