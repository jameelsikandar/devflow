// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { GitHubWorkflowSettings } from '../src/components/github-workflow-settings';
import { ActivityFeed } from '../src/components/workspace-views';
import { workflowPreviewReasons } from '../src/lib/github-workflows';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let element: HTMLDivElement;
let error = false;
let empty = false;
let writes: { path: string; method: string; input: Record<string, unknown> }[];
const rule = {
  id: 'r',
  version: 1,
  name: 'PR merged → Done',
  connectionId: 'c',
  trigger: 'PR_MERGED',
  targetStatus: 'DONE',
  priority: 100,
  enabled: false,
  deletedAt: null,
};
const scope = (p: string) => `${p}?workspaceId=w`;
beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  writes = [];
  error = false;
  empty = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, 'http://localhost').pathname;
      if (init?.method && init.method !== 'GET')
        writes.push({ path, method: init.method, input: JSON.parse(String(init.body)) });
      if (error)
        return new Response(JSON.stringify({ error: 'Settings unavailable' }), { status: 503 });
      if (path.endsWith('/preview'))
        return new Response(
          JSON.stringify({
            dryRun: true,
            observationId: 'o',
            trigger: 'PR_MERGED',
            blockers: [],
            warnings: ['Hypothetical preview includes disabled rules.'],
            matches: [{ ...rule, reason: 'MATCH' }],
            transition: {
              taskId: 't',
              reference: 'DEV-002',
              title: 'Protected task',
              from: 'TODO',
              to: 'DONE',
              taskVersion: 9,
              ruleVersion: 1,
              hypothetical: true,
            },
          }),
        );
      if (path.endsWith('/executions'))
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 'execution',
                state: 'APPLIED',
                reason: 'STATUS_CHANGED',
                attempts: 1,
                createdAt: '2026-11-15T12:00:00Z',
                completedAt: '2026-11-15T12:00:00Z',
                ruleName: rule.name,
                ruleVersion: 2,
                taskId: 't',
                taskReference: 'DEV-002',
                taskTitle: 'Protected task',
                expectedTaskVersion: 0,
                previousStatus: 'TODO',
                targetStatus: 'DONE',
                repository: 'owner/repo',
                prNumber: '1',
                prUrl: 'https://github.com/owner/repo/pull/1',
                disconnected: false,
              },
            ],
            total: 1,
            offset: 0,
            hasMore: false,
          }),
        );
      if (path.endsWith('/history'))
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 'revision',
                version: 1,
                operation: 'CREATE',
                createdAt: '2026-11-15T12:00:00Z',
                snapshot: { name: rule.name },
              },
            ],
            offset: 0,
            hasMore: false,
          }),
        );
      return new Response(
        JSON.stringify({
          rules: empty ? [] : [rule],
          archived: false,
          connections: [{ id: 'c', repositoryFullName: 'owner/repo', disconnectedAt: null }],
          observations: empty
            ? []
            : [
                {
                  id: 'o',
                  number: '12',
                  action: 'closed',
                  repository: 'owner/repo',
                  receivedAt: '2026-11-15T12:00:00Z',
                  state: 'PROCESSED',
                  disconnected: false,
                },
              ],
          total: empty ? 0 : 1,
          offset: 0,
          hasMore: false,
        }),
      );
    }),
  );
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const button = (name: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!;
async function render() {
  await act(async () =>
    root.render(
      h(GitHubWorkflowSettings, {
        projectId: 'p',
        projectName: 'DevFlow',
        scope,
        onClose: vi.fn(),
      }),
    ),
  );
}
it('renders an accessible scoped dialog and explicit hypothetical preview without task API writes', async () => {
  await render();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    'GitHub workflow rules · DevFlow',
  );
  expect(writes).toHaveLength(0);
  const select = [...document.querySelectorAll('select')].find((s) =>
    s.parentElement?.textContent?.startsWith('Pull request observation'),
  )!;
  await act(async () => {
    select.value = 'o';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const checkbox = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
    (c) => c.parentElement?.textContent?.includes('Include disabled'),
  )!;
  await act(async () => checkbox.click());
  await act(async () => button('Preview only').click());
  expect(writes).toEqual([
    {
      path: '/api/projects/p/github-workflows/preview',
      method: 'POST',
      input: { observationId: 'o', includeDisabled: true },
    },
  ]);
  expect(document.querySelector('.workflow-result')?.textContent).toContain(
    'DEV-002 — Protected task',
  );
  expect(document.querySelector('.workflow-result')?.textContent).toContain(
    'Dry run — no tasks changed',
  );
  expect(document.querySelector('.workflow-result')?.textContent).toContain('task v9, rule v1');
  await act(async () => button('View configuration history').click());
  expect(document.querySelector('[aria-label="Rule audit history"]')?.textContent).toContain(
    'create · v1',
  );
});
it('sends optimistic-version/idempotency data only after explicit enable and edit actions', async () => {
  await render();
  await act(async () => button('Enable').click());
  expect(writes[0]).toMatchObject({
    method: 'PATCH',
    path: '/api/projects/p/github-workflows/r',
    input: { expectedVersion: 1, definition: { enabled: true } },
  });
  expect(writes[0].input.requestId).toMatch(/^[a-f0-9-]{36}$/);
  await act(async () => button('Edit PR merged → Done').click());
  await act(async () =>
    document
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(writes[1]).toMatchObject({ method: 'PATCH', input: { expectedVersion: 1 } });
  expect(writes.every((w) => w.path.startsWith('/api/projects/p/github-workflows'))).toBe(true);
});
it('displays empty/error states and reloads without creating rules or task changes', async () => {
  error = true;
  await render();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Settings unavailable');
  error = false;
  empty = true;
  await act(async () => button('Reload settings').click());
  expect(document.body.textContent).toContain('No rules yet');
  expect(document.body.textContent).toContain('No stored pull request observations');
  expect(button('Preview only').disabled).toBe(true);
  expect(writes).toHaveLength(0);
});
it('provides explanations for every safety blocker', () => {
  for (const key of [
    'AMBIGUOUS_TASKS',
    'STALE_EVENT',
    'DUPLICATE_EVENT',
    'DISCONNECTED',
    'INCOMPLETE',
    'RULE_CONFLICT',
    'NO_TASK',
    'MISSING_DATA',
  ])
    expect(workflowPreviewReasons[key].length).toBeGreaterThan(20);
});

it('requires explicit confirmation before enabling and keeps cancellation read-only', async () => {
  await render();
  vi.mocked(window.confirm).mockReturnValue(false);
  await act(async () => button('Enable').click());
  expect(writes).toHaveLength(0);
  expect(window.confirm).toHaveBeenCalledWith(
    expect.stringContaining('Future verified PR events may change'),
  );
  vi.mocked(window.confirm).mockReturnValue(true);
  await act(async () => button('Enable').click());
  expect(writes[0].input.automationConfirmed).toBe(true);
});
it('shows safe paginated execution history and machine activity without a human actor', async () => {
  await render();
  await act(async () => button('Refresh execution history').click());
  const history = document.querySelector('[aria-label="Automation execution history"]')!;
  expect(history.textContent).toContain('applied');
  expect(history.textContent).toContain('DEV-002');
  const link = history.querySelector('a')!;
  expect(link.href).toBe('https://github.com/owner/repo/pull/1');
  expect(link.rel).toBe('noopener noreferrer');
  await act(async () =>
    root.render(
      h(ActivityFeed, {
        activities: [
          {
            id: 'a',
            taskId: 't',
            message: 'moved DEV-002 from Todo to Done · PR #1',
            createdAt: new Date().toISOString(),
            actor: null,
            source: 'GITHUB_AUTOMATION',
          },
        ],
        openTask: vi.fn(),
      }),
    ),
  );
  expect(element.textContent).toContain('GitHub automation');
  expect(element.textContent).toContain('moved DEV-002 from Todo to Done');
  expect(element.querySelector('[aria-label="GitHub automation"]')).not.toBeNull();
});
