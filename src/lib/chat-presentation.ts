import type { Snapshot, Task } from './types';

export const chatStatusLabels: Record<string, string> = {
  BACKLOG: 'Backlog',
  TODO: 'To Do',
  IN_PROGRESS: 'In Progress',
  IN_REVIEW: 'In Review',
  DONE: 'Done',
};
export const chatPriorityLabels: Record<string, string> = {
  URGENT: 'Urgent',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};
export const taskReference = (number: number) => `DEV-${number}`;
export function friendlyDate(value: unknown, locale?: string) {
  if (typeof value !== 'string' || !value) return 'Not set';
  const parsed = new Date(value);
  if (!Number.isFinite(+parsed)) return value;
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
}
export interface ChatContext {
  data: Snapshot;
  projectId: string | null;
  openTask?: (id: string) => void;
}
export function verifiedTask(
  context: ChatContext | undefined,
  reference: string,
): Task | undefined {
  const match = /^DEV[-–](\d+)$/i.exec(reference.trim());
  if (!context || !match) return undefined;
  return context.data.tasks.find(
    (t) =>
      t.number === Number(match[1]) &&
      (!context.projectId || t.projectId === context.projectId) &&
      context.data.projects.some((p) => p.id === t.projectId),
  );
}
export function safeMarkdownURL(raw: string): string | null {
  const value = raw.trim();
  if (/[\u0000-\u0020\u007f]/u.test(value)) return null;
  if (!/^https?:\/\//i.test(value) && !/^mailto:[^?]+@[^?]+$/i.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol) || url.username || url.password)
      return null;
    return url.href;
  } catch {
    return null;
  }
}
export function friendlyField(
  key: string,
  value: unknown,
  context: ChatContext,
  locale?: string,
): string {
  if (value === null || value === undefined) return key === 'assigneeId' ? 'Unassigned' : 'Not set';
  if (key === 'status' || key === 'statusSnapshot')
    return chatStatusLabels[String(value)] ?? String(value);
  if (key === 'priority') return chatPriorityLabels[String(value)] ?? String(value);
  if (key === 'projectId')
    return context.data.projects.find((p) => p.id === value)?.name ?? 'Unavailable project';
  if (key === 'assigneeId' || key === 'userId')
    return context.data.members.find((m) => m.user.id === value)?.user.name ?? 'Unavailable member';
  if (['taskId', 'parentTaskId', 'predecessorId', 'successorId'].includes(key)) {
    const task = context.data.tasks.find((t) => t.id === value);
    return task && verifiedTask(context, taskReference(task.number))
      ? `${taskReference(task.number)} — ${task.title}`
      : 'Unavailable task';
  }
  if (/Date$|^period(Start|End)$|At$/.test(key)) return friendlyDate(value, locale);
  if (key === 'labelIds' && Array.isArray(value))
    return (
      value
        .map((id) => context.data.labels.find((l) => l.id === id)?.name ?? 'Unavailable label')
        .join(', ') || 'None'
    );
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return typeof value === 'string' ? value : JSON.stringify(value);
}
const sensitiveKey = /password|token|secret|authorization|api[-_]?key|cookie/i;
export function redactDiagnostics(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[Depth limit]';
  if (Array.isArray(value)) return value.map((v) => redactDiagnostics(v, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        sensitiveKey.test(key) ? '[Redacted]' : redactDiagnostics(entry, depth + 1),
      ]),
    );
  return value;
}
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export interface ChatToolEvent {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
}
export function toolActivity(event: ChatToolEvent, context: ChatContext) {
  const output = record(event.output),
    input = record(event.input);
  if (output.error)
    return { state: 'error' as const, summary: 'Workspace request needs attention' };
  if (output.status === 'awaiting_user_approval')
    return {
      state: 'proposal' as const,
      summary:
        (
          {
            createTask: 'Prepared a task for your review',
            updateTask: 'Prepared task changes for your review',
            createSprint: 'Prepared a sprint plan for your review',
            generateReport: 'Prepared a report for your review',
          } as Record<string, string>
        )[event.name] ?? 'Prepared a proposal for your review',
    };
  const items = Array.isArray(output.items) ? output.items : null;
  if (event.name === 'listTasks' && items) {
    const total = typeof output.total === 'number' ? output.total : items.length;
    const count = total > items.length ? `${items.length} of ${total}` : String(items.length);
    const related = record(output.projectContext);
    if (Array.isArray(related.items))
      return {
        state: 'complete' as const,
        summary: `Retrieved ${related.items.length} of ${related.total} project tasks · ${output.total} assigned matches`,
      };
    const filter = record(output.scope);
    const mine = input.scope === 'mine' || filter.kind === 'mine';
    const unassigned =
      input.scope === 'unassigned' ||
      (Object.hasOwn(input, 'assigneeId') && input.assigneeId === null);
    const projectId = typeof input.projectId === 'string' ? input.projectId : context.projectId;
    const projectName = context.data.projects.find((p) => p.id === projectId)?.name;
    return {
      state: 'complete' as const,
      summary: `Retrieved ${count} ${unassigned ? 'unassigned ' : ''}task${total === 1 ? '' : 's'}${mine ? ' assigned to you' : ''}${projectName ? ` in ${projectName}` : ' in the workspace'}`,
    };
  }
  if (event.name === 'listProjects' && items)
    return {
      state: 'complete' as const,
      summary: `Retrieved ${items.length} project${items.length === 1 ? '' : 's'}`,
    };
  if (event.name === 'getProject')
    return {
      state: 'complete' as const,
      summary: `Reviewed ${String(record(output.project).name ?? 'project progress')}`,
    };
  if (event.name === 'getTask')
    return {
      state: 'complete' as const,
      summary: `Reviewed ${typeof output.number === 'number' ? taskReference(output.number) : 'task details'}`,
    };
  return { state: 'complete' as const, summary: 'Workspace query completed' };
}
