import { taskViewPrompts, projectTaskPrompt, workspaceTaskPrompt } from './agent-view';
import { record, chatStatusLabels, chatPriorityLabels } from './chat-presentation';
export type ProjectHint = { id: string; name: string };
export type TaskIntent = {
  kind: 'assigned' | 'current' | 'unassigned' | 'project' | 'workspace';
  projectName?: string;
};
export type ReadContext = {
  projects: ProjectHint[];
  projectTotal: number;
  projectId: string | null;
  establishedProjectId?: string | null;
};
/** Deliberately anchored allowlist. Extra filters, instructions or mutations use the agent. */
export function taskIntent(prompt: string): TaskIntent | null {
  const known =
    prompt.trim() === taskViewPrompts[0][1]
      ? 'My assigned tasks'
      : prompt.trim() === taskViewPrompts[1][1]
        ? 'Unassigned tasks'
        : prompt.trim() === projectTaskPrompt
          ? 'All project tasks'
          : prompt.trim() === workspaceTaskPrompt
            ? 'All workspace tasks'
            : prompt;
  let text = known
    .trim()
    .replace(/[?.!]+$/, '')
    .replace(/\s+/g, ' ');
  const named = /^(.*?)\s+(?:in|for|from)\s+(?:the\s+)?(?:project\s+)?(.+)$/i.exec(text);
  const projectName = named?.[2].trim();
  if (named) text = named[1];
  const kind = /^(?:(?:show|list)(?: me)? )?my assigned tasks$/i.test(text)
    ? 'assigned'
    : /^(?:(?:show|list)(?: me)? )?my (?:current )?tasks$/i.test(text) ||
        /^what am i working on$/i.test(text)
      ? 'current'
      : /^(?:(?:show|list)(?: me)? )?(?:all )?unassigned tasks$/i.test(text)
        ? 'unassigned'
        : /^(?:(?:show|list)(?: me)? )?all (?:my )?project tasks$/i.test(text)
          ? 'project'
          : /^(?:(?:show|list)(?: me)? )?all workspace tasks$/i.test(text)
            ? 'workspace'
            : null;
  return kind ? { kind, ...(projectName ? { projectName } : {}) } : null;
}
export function namedProject(prompt: string) {
  return /^project\s+(.+?)[.!?]?$/i.exec(prompt.trim())?.[1]?.trim();
}
export function resolveProject(name: string, projects: ProjectHint[]) {
  const matches = projects.filter(
    (p) =>
      p.name.normalize('NFKC').toLocaleLowerCase() === name.normalize('NFKC').toLocaleLowerCase(),
  );
  return matches.length === 1 ? matches[0] : null;
}
export function establishedProject(prompts: string[], context: ReadContext): string | null {
  for (const prompt of [...prompts].reverse()) {
    const intent = taskIntent(prompt);
    if (intent?.kind === 'workspace') return null;
    const name = intent?.projectName ?? namedProject(prompt);
    if (name) return resolveProject(name, context.projects)?.id ?? null;
  }
  return null;
}
export function planTaskRead(prompt: string, context: ReadContext, previousPrompt?: string) {
  let intent = taskIntent(prompt);
  const selection = namedProject(prompt);
  if (!intent && selection && previousPrompt) {
    const previous = taskIntent(previousPrompt);
    if (previous) intent = { ...previous, projectName: selection };
  }
  if (!intent || (intent.kind === 'workspace' && intent.projectName)) return null;
  if (intent.kind === 'workspace' && context.projectId)
    return {
      kind: 'explain' as const,
      answer:
        'This conversation is limited to one project. Start a workspace-scoped conversation to retrieve all workspace tasks.',
    };
  // An explicit name never silently falls back to another project.
  const named = intent.projectName ? resolveProject(intent.projectName, context.projects) : null;
  if (intent.projectName && (!named || (context.projectId && named.id !== context.projectId)))
    return null;
  const sole =
    context.projectTotal === 1 && context.projects.length === 1 ? context.projects[0].id : null;
  const selected = context.projectId ?? context.establishedProjectId ?? sole;
  const projectId =
    named?.id ??
    (intent.kind === 'workspace' || intent.kind === 'assigned' ? context.projectId : selected);
  if (intent.kind === 'project' && !projectId) return null;
  const input = {
    scope:
      intent.kind === 'assigned' || intent.kind === 'current'
        ? ('mine' as const)
        : intent.kind === 'unassigned'
          ? ('unassigned' as const)
          : ('all' as const),
    ...(projectId ? { projectId } : {}),
    ...(intent.kind === 'current' ? { unfinished: true, includeProjectContext: !!projectId } : {}),
    offset: 0,
    limit: 25,
  };
  const scope = projectId
    ? `project ${context.projects.find((p) => p.id === projectId)?.name ?? 'selected project'}`
    : 'all active projects in this workspace';
  return {
    kind: 'read' as const,
    input,
    interpretation: `${intent.kind === 'current' ? 'My current tasks means unfinished tasks assigned to you' : intent.kind === 'assigned' ? 'Assigned tasks means tasks assigned to you, including completed tasks' : intent.kind === 'unassigned' ? 'Unassigned tasks means tasks with no assignee' : 'All tasks, including unassigned and completed tasks'} in ${scope}.`,
  };
}
function escape(value: unknown) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\\`*_{}\[\]()#+.!|><~-]/g, '\\$&');
}
export function verifiedTaskAnswer(output: unknown, interpretation: string) {
  const data = record(output);
  if (data.error) throw new Error('Cannot summarize a failed read');
  const related = record(data.projectContext),
    contextual = Array.isArray(related.items);
  const page = contextual ? related : data,
    rows = Array.isArray(page.items) ? page.items.map(record) : [];
  const personal = record(data.scope).kind === 'mine';
  const intro = personal
    ? `**Assigned matches:** ${data.total}.`
    : `**Matching tasks:** ${data.total}.`;
  const context = contextual
    ? `\n\n${escape(related.projectName)} contains **${related.total} project tasks**, **${related.unassignedTotal} unassigned**. These are project records, not personal assignment matches; this contextual view includes all statuses.`
    : '';
  const table = rows.length
    ? '\n\n| Task | Project | Status | Priority | Assignee | Due date (UTC) |\n|---|---|---|---|---|---|\n' +
      rows
        .map((t) => {
          const reference =
            typeof t.number === 'number' ? `DEV-${t.number}` : String(t.reference ?? '');
          const link = /^DEV-\d+$/.test(reference)
            ? `[${reference}](devflow-task:${reference})`
            : escape(reference);
          const date =
            typeof t.dueDate === 'string' || t.dueDate instanceof Date ? new Date(t.dueDate) : null;
          return `| ${link} — ${escape(t.title)} | ${escape(t.projectName)} | ${escape(t.statusLabel ?? chatStatusLabels[String(t.status)] ?? t.status)} | ${escape(t.priorityLabel ?? chatPriorityLabels[String(t.priority)] ?? t.priority)} | ${escape(t.assigneeId === null ? 'Unassigned' : (t.assigneeName ?? 'Unavailable member'))} | ${date && Number.isFinite(+date) ? new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(date) : 'Not set'} |`;
        })
        .join('\n')
    : '\n\nNo tasks matched this view.';
  const offset = typeof page.offset === 'number' ? page.offset : 0;
  return `### Verified task records\n\nDevFlow database summary; no AI-generated narrative.\n\n${escape(interpretation)}\n\n${intro}${context}${table}\n\nShowing ${rows.length} of ${page.total} matching ${contextual ? 'project' : 'task'} records, offset ${offset}. ${page.hasMore ? `This is a partial page; next offset is ${page.nextOffset}.` : 'This page completes the matching result.'}`;
}
