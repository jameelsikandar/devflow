import type { Snapshot } from './types';
export function initialAssistantProject(data: Snapshot, selectedProjectId?: string) {
  return data.projects.some((p) => p.id === selectedProjectId && !p.archivedAt)
    ? selectedProjectId!
    : 'all';
}
export function conversationScopeLabel(
  data: Snapshot,
  projectId: string | null | undefined,
  loading = false,
) {
  if (loading) return 'Loading conversation scope…';
  if (!projectId) return 'All accessible projects in this workspace';
  const project = data.projects.find((p) => p.id === projectId);
  return project
    ? `Project: ${project.name}${project.archivedAt ? ' (archived)' : ''}`
    : 'Unavailable project';
}
export function modelLabel(model?: string) {
  if (!model) return 'Setup required';
  return model === 'openai/gpt-oss-120b' ? 'GPT-OSS 120B' : model.split('/').at(-1)!;
}
export const taskViewPrompts = [
  [
    'Assigned to me',
    'Show only tasks assigned to me in this conversation scope, with status, priority, assignee and due dates. Do not include other project tasks.',
  ],
  [
    'Unassigned',
    'Show unassigned tasks in this conversation scope, with status, priority and due dates.',
  ],
] as const;
export const projectTaskPrompt =
  'Show all project tasks in the selected conversation project, including unassigned and completed tasks. Include status, priority, assignee and due dates; label the scope and any partial page.';
export const workspaceTaskPrompt =
  'Show all workspace tasks across active authorized projects in this workspace. Include each project name, status, priority, assignee and due dates; label any partial page.';

export function conversationTitle(prompt: string) {
  return prompt.trim().replace(/\s+/g, ' ').slice(0, 100);
}
