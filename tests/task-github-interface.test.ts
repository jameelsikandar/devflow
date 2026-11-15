// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TaskGitHubActivity } from '../src/components/task-github-activity';
import { TaskDialog } from '../src/components/task-dialog';
import { Board } from '../src/components/kanban';
import type { Snapshot, TaskDetail } from '../src/lib/types';
import { githubTaskObjectURL, type TaskGitHubActivityPage } from '../src/lib/github-task-activity';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const sha = '9023d37' + 'a'.repeat(33);
const task: TaskDetail = {
  id: 'task',
  number: 2,
  projectId: 'project',
  title: 'Tracked work',
  description: '',
  status: 'TODO',
  priority: 'MEDIUM',
  assigneeId: null,
  assignee: null,
  startDate: null,
  dueDate: null,
  isMilestone: false,
  position: 0,
  version: 7,
  completedAt: null,
  createdAt: '2026-11-14T12:00:00Z',
  updatedAt: '2026-11-14T12:00:00Z',
  labels: [],
  _count: { comments: 0, githubLinks: 4 },
  comments: [],
  activities: [],
};
const data = {
  workspace: { id: 'workspace', role: 'OWNER', name: 'Workspace' },
  projects: [{ id: 'project', name: 'DevFlow', archivedAt: null }],
  tasks: [task],
  members: [],
  labels: [],
} as unknown as Snapshot;
let page: TaskGitHubActivityPage;
let mode: 'ready' | 'error';
let writes: string[];
let el: HTMLDivElement;
let root: Root;
let client: QueryClient;
beforeEach(() => {
  page = {
    total: 4,
    offset: 0,
    limit: 10,
    hasMore: false,
    items: (['COMMIT', 'PULL_REQUEST', 'ISSUE', 'WORKFLOW_RUN'] as const).map((kind, i) => ({
      id: `object-${i}`,
      kind,
      key: i ? String(i + 6) : sha,
      repositoryName: 'jameelsikandar/25-react-projects',
      connection: 'connected',
      url: githubTaskObjectURL('jameelsikandar/25-react-projects', kind, i ? String(i + 6) : sha),
      status: [null, 'Merged', 'Open', 'Completed · Success'][i],
      statusSource: i ? 'source' : 'observation',
      updatedAt: '2026-11-14T12:00:00Z',
      incomplete: false,
    })),
  };
  mode = 'ready';
  writes = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method && init.method !== 'GET') writes.push(init.method);
      if (new URL(url, 'http://localhost').pathname === '/api/tasks/task')
        return new Response(JSON.stringify(task));
      return mode === 'error'
        ? new Response(JSON.stringify({ error: 'Fixture unavailable' }), { status: 503 })
        : new Response(JSON.stringify(page));
    }),
  );
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  el.remove();
  vi.unstubAllGlobals();
});
async function render(widget: React.ReactNode) {
  await act(async () => root.render(h(QueryClientProvider, { client }, widget)));
}
async function ready() {
  await act(async () => {
    await vi.waitFor(() =>
      expect(document.querySelector('a[href*="/commit/9023d37"]')).not.toBeNull(),
    );
  });
}
const section = () => document.querySelector<HTMLElement>('.task-github-activity')!;
const refresh = () =>
  section().querySelector<HTMLButtonElement>('[aria-label="Refresh GitHub activity"]')!;
it('shows all four linked object kinds safely inside the real task dialog without disrupting existing controls', async () => {
  const close = vi.fn();
  await render(
    h(TaskDialog, {
      id: task.id,
      onClose: close,
      data,
      scope: (path) => `${path}?workspaceId=workspace`,
      refresh: async () => {},
    }),
  );
  await ready();
  expect(document.querySelector('[role="dialog"]')?.contains(section())).toBe(true);
  expect(document.querySelector<HTMLInputElement>('input[name="title"]')?.value).toBe(
    'Tracked work',
  );
  expect(
    document.querySelector('textarea[placeholder="Share a thought or an update..."]'),
  ).not.toBeNull();
  expect(section().querySelectorAll('a')).toHaveLength(4);
  expect(section().textContent).toContain('9023d37');
  expect(section().textContent).toContain('Merged');
  expect(section().textContent).toContain('Completed · Success');
  for (const link of section().querySelectorAll('a')) {
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    expect(link.rel).toContain('noreferrer');
    expect(new URL(link.href).hostname).toBe('github.com');
  }
  expect(writes).toHaveLength(0);
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!.click(),
  );
  expect(close).toHaveBeenCalledOnce();
});
it('handles loading, errors, retry, disconnected history and empty results without task writes', async () => {
  let release!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  await render(
    h(TaskGitHubActivity, {
      taskId: 'task',
      projectId: 'project',
      workspaceId: 'workspace',
      scope: (path) => `${path}?workspaceId=workspace`,
    }),
  );
  expect(section().querySelector('[role="status"]')?.textContent).toContain('Loading');
  await act(async () => release(new Response(JSON.stringify(page))));
  await ready();
  mode = 'error';
  await act(async () => {
    refresh().click();
  });
  await act(async () => {
    await vi.waitFor(() => expect(section().querySelector('[role="alert"]')).not.toBeNull());
  });
  expect(section().textContent).toContain('Could not load');
  mode = 'ready';
  page.items = page.items.map((item) => ({ ...item, connection: 'disconnected' }));
  await act(async () =>
    [...section().querySelectorAll('button')]
      .find((b) => b.textContent === 'Try GitHub activity again')!
      .click(),
  );
  await act(async () => {
    await vi.waitFor(() => expect(section().textContent).toContain('Repository disconnected'));
  });
  expect(section().querySelectorAll('a')).toHaveLength(4);
  page = { ...page, total: 0, items: [] };
  await act(async () => refresh().click());
  await act(async () => {
    await vi.waitFor(() => expect(section().textContent).toContain('No GitHub activity linked'));
  });
  expect(writes).toHaveLength(0);
});
it('refuses a malicious API URL and retains labels in dark and light themes', async () => {
  page.items[0].url = 'javascript:alert(1)';
  await render(
    h(TaskGitHubActivity, {
      taskId: 'task',
      projectId: 'project',
      workspaceId: 'workspace',
      scope: (path) => `${path}?workspaceId=workspace`,
    }),
  );
  await act(async () => {
    await vi.waitFor(() => expect(section().textContent).toContain('9023d37'));
  });
  expect(section().querySelector('a[href^="javascript:"]')).toBeNull();
  expect(section().querySelectorAll('a')).toHaveLength(3);
  for (const theme of ['dark', 'light']) {
    document.documentElement.dataset.theme = theme;
    expect(section().querySelector('h3')?.textContent).toContain('GitHub activity');
  }
  delete document.documentElement.dataset.theme;
});
it('adds a passive card indicator, preserves the existing open action and leaves the drag grip intact', async () => {
  const openTask = vi.fn();
  const move = vi.fn();
  await render(h(Board, { tasks: [task], data, openTask, move, pending: false, create: vi.fn() }));
  const badge = el.querySelector<HTMLElement>('.task-github-indicator')!;
  expect(badge.getAttribute('aria-label')).toContain('4 linked objects');
  expect(badge.querySelector('button')).toBeNull();
  expect(badge.closest('button')?.className).toBe('task-open');
  expect(el.querySelector('button[aria-label="Move Tracked work"]')).not.toBeNull();
  await act(async () => badge.click());
  expect(openTask).toHaveBeenCalledWith('task');
  expect(move).not.toHaveBeenCalled();
});
