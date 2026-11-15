import type { Status } from './types';
export const executionStates = ['PENDING', 'APPLIED', 'SKIPPED', 'CONFLICTED', 'FAILED'] as const;
export type ExecutionState = (typeof executionStates)[number];
export const automationReasons: Record<string, string> = {
  STATUS_CHANGED: 'Status changed successfully.',
  ROLLOUT_BOUNDARY: 'Historical delivery: preview only.',
  EVENT_BEFORE_ENABLE: 'The event predates this confirmed rule activation.',
  PREVIEW_ONLY_RULE: 'This rule has not been confirmed for automation.',
  RULE_DISABLED: 'The rule was disabled or deleted.',
  RULE_CHANGED: 'The rule changed after evaluation.',
  RULE_SELECTION_CHANGED: 'Rule selection changed after evaluation.',
  AUTHORIZATION_REVOKED:
    'The administrator who activated this rule no longer has administrator access.',
  TASK_VERSION_CHANGED: 'Someone changed the task after evaluation. Nothing was overwritten.',
  TARGET_DELETED: 'The target task or rule is no longer available.',
  NO_ENABLED_MATCH: 'No enabled rule matched.',
  ALREADY_AT_TARGET: 'Task already has the target status.',
  TASK_VALIDATION_FAILED: 'Task validation prevented this transition.',
  DATABASE_TRANSIENT_FAILURE: 'Temporary database failure; bounded retry scheduled or exhausted.',
  EXECUTION_INVALID: 'Execution could not be completed safely.',
  ATTEMPTS_EXHAUSTED: 'The configured retry limit was reached.',
};
export interface WorkflowExecutionPage {
  items: {
    id: string;
    state: ExecutionState;
    reason: string | null;
    attempts: number;
    createdAt: string;
    completedAt: string | null;
    ruleName: string;
    ruleVersion: number | null;
    taskId: string | null;
    taskReference: string | null;
    taskTitle: string | null;
    expectedTaskVersion: number | null;
    previousStatus: Status | null;
    targetStatus: Status | null;
    repository: string;
    prNumber: string;
    prUrl: string | null;
    disconnected: boolean;
  }[];
  offset: number;
  total: number;
  hasMore: boolean;
}
