import { record, chatStatusLabels, chatPriorityLabels } from '../chat-presentation';
function pick(value: unknown, keys: string[]) {
  const item = record(value);
  return Object.fromEntries(keys.filter((k) => item[k] !== undefined).map((k) => [k, item[k]]));
}
function task(value: unknown, full = false) {
  const t = record(value);
  return {
    ...pick(t, ['id', 'title', 'projectId', 'dueDate']),
    reference: t.reference ?? (typeof t.number === 'number' ? `DEV-${t.number}` : undefined),
    status: t.statusLabel ?? chatStatusLabels[String(t.status)] ?? t.status,
    priority: t.priorityLabel ?? chatPriorityLabels[String(t.priority)] ?? t.priority,
    assignee: t.assigneeName ?? record(t.assignee).name ?? 'Unassigned',
    ...(t.assigneeId ? { assigneeId: t.assigneeId } : {}),
    ...(full
      ? pick(t, [
          'version',
          'projectName',
          'startDate',
          'isMilestone',
          'parentTaskId',
          'description',
          'descriptionTruncated',
          'labels',
          'comments',
          'dependencies',
          'limits',
        ])
      : {}),
  };
}
function page(value: unknown) {
  const p = record(value),
    items = Array.isArray(p.items) ? p.items : [];
  const projects = Object.fromEntries(
    items
      .map(record)
      .filter((t) => t.projectId && (t.projectName || record(t.project).name))
      .map((t) => [String(t.projectId), t.projectName ?? record(t.project).name]),
  );
  return {
    ...pick(p, ['total', 'offset', 'limit', 'hasMore', 'nextOffset', 'asOf']),
    scope: pick(p.scope, ['kind', 'projectId', 'unfinishedOnly']),
    projects,
    items: items.map((t) => task(t)),
  };
}
/** Derived wire view only. Persisted audit/proposal records are NEVER replaced. */
export function modelToolResult(name: string, value: unknown): unknown {
  const output = record(value);
  if (output.error) return pick(output, ['error', 'applied']);
  if (output.status === 'awaiting_user_approval') {
    const action = record(output.preview),
      preview = record(action.preview);
    return {
      status: output.status,
      applied: false,
      tool: action.tool,
      project: preview.project,
      task: preview.task,
      title: preview.title ?? preview.name,
      changedFields: Object.keys(record(preview.changes)),
      note: 'Prepared for review only. No domain changes applied. The full immutable preview is displayed separately.',
    };
  }
  if (name === 'listTasks')
    return {
      ...page(output),
      ...(output.projectContext
        ? {
            projectContext: {
              ...page(output.projectContext),
              ...pick(output.projectContext, ['projectName', 'unassignedTotal']),
              note: 'Project tasks, not personal matches; includes completed tasks.',
            },
          }
        : {}),
    };
  if (name === 'getTask')
    return {
      ...task(output, true),
      subtasks: Array.isArray(output.subtasks) ? output.subtasks.map((t) => task(t)) : [],
    };
  if (name === 'listProjects')
    return {
      ...pick(output, ['total', 'offset', 'limit']),
      items: Array.isArray(output.items)
        ? output.items.map((p) => ({
            ...pick(p, ['id', 'name']),
            taskCount: record(record(p)._count).tasks,
          }))
        : [],
    };
  if (name === 'getProject')
    return {
      ...pick(output, [
        'project',
        'asOf',
        'statuses',
        'overdue',
        'workload',
        'workloadDefinition',
        'members',
        'labels',
        'dependencies',
        'dependencyCount',
        'limits',
        'reports',
      ]),
      sprints: Array.isArray(output.sprints)
        ? output.sprints.map((s) => ({
            ...pick(s, ['id', 'name', 'goal', 'startDate', 'endDate']),
            taskCount: Array.isArray(record(s).tasks) ? (record(s).tasks as unknown[]).length : 0,
          }))
        : [],
    };
  return value;
}
