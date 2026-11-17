// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { GitHub } from '../src/components/integrations';
import type { Snapshot } from '../src/lib/types';
import { healthFixture } from './github-health-fixture';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it('connects the selected project, reveals setup only in its dialog, then disconnects through the authorized endpoint', async () => {
  const data = {
    workspace: { id: 'workspace', role: 'OWNER' },
    projects: [{ id: 'project', name: 'Launch', repository: null, archivedAt: null }],
  } as unknown as Snapshot;
  let active: { id: string; repositoryFullName: string }[] = [];
  const writes: { path: string; method: string; input?: unknown }[] = [];
  const secret = 'one-time-fixture-secret';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, 'http://localhost').pathname;
      if (path.endsWith('/health'))
        return new Response(
          JSON.stringify(
            healthFixture('HEALTHY_IDLE', {
              workspaceId: 'workspace',
              projectId: 'project',
              connectionId: 'connection',
            }),
          ),
        );
      let json: unknown;
      if (path === '/api/github/repositories' && init?.method === 'POST') {
        writes.push({ path, method: init.method, input: JSON.parse(String(init.body)) });
        active = [{ id: 'connection', repositoryFullName: 'owner/repo' }];
        json = {
          connection: active[0],
          setup: {
            secret,
            url: 'https://devflow.example/api/github/webhooks/connection',
            events: ['push', 'pull_request', 'issues', 'workflow_run'],
          },
        };
      } else if (path === '/api/github/repositories/connection' && init?.method === 'DELETE') {
        writes.push({ path, method: init.method });
        active = [];
        json = { ok: true };
      } else if (path === '/api/github/repositories') json = active;
      else
        json = {
          configured: true,
          connected: true,
          login: 'owner',
          repositories: [
            {
              id: 123,
              full_name: 'owner/repo',
              html_url: 'https://github.com/owner/repo',
              description: '',
              private: true,
              stargazers_count: 0,
            },
          ],
          commits: [],
          pulls: [],
        };
      return new Response(JSON.stringify(json));
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  const button = (text: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  try {
    await act(async () =>
      root.render(
        h(
          QueryClientProvider,
          { client },
          h(GitHub, {
            data,
            scope: (path) => `${path}?workspaceId=workspace`,
            refresh: async () => {},
          }),
        ),
      ),
    );
    await act(async () => {
      await vi.waitFor(() => expect(button('Connect project')?.disabled).toBe(false));
    });
    expect(writes).toHaveLength(0);
    await act(async () => button('Connect project')!.click());
    await act(async () => {
      await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    });
    expect(writes).toEqual([
      {
        path: '/api/github/repositories',
        method: 'POST',
        input: { projectId: 'project', repository: 'owner/repo' },
      },
    ]);
    expect(
      [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input')].map((i) => i.value),
    ).toContain(secret);
    expect(
      JSON.stringify(client.getQueryData(['github-repositories', 'workspace', 'project'])),
    ).not.toContain(secret);
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!.click(),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect([...document.querySelectorAll('input')].some((i) => i.value === secret)).toBe(false);
    await act(async () => {
      await vi.waitFor(() => expect(button('Disconnect repository webhook')?.disabled).toBe(false));
    });
    await act(async () => button('Disconnect repository webhook')!.click());
    await act(async () => {
      await vi.waitFor(() => expect(button('Connect project')?.disabled).toBe(false));
    });
    expect(writes[1]).toEqual({ path: '/api/github/repositories/connection', method: 'DELETE' });
  } finally {
    await act(async () => root.unmount());
    client.clear();
    el.remove();
    vi.unstubAllGlobals();
  }
});

it('keeps operational summaries hidden for ordinary members in the existing GitHub page', async () => {
  const data = {
    workspace: { id: 'workspace', role: 'MEMBER' },
    projects: [{ id: 'project', name: 'Member project', repository: null, archivedAt: null }],
  } as unknown as Snapshot;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = new URL(url, 'http://localhost').pathname;
      if (path.endsWith('/health')) throw new Error('Member must not request administrator health');
      return new Response(
        JSON.stringify(
          path === '/api/github/repositories'
            ? [{ id: 'connection', repositoryFullName: 'fixture/repo' }]
            : path.endsWith('/activity')
              ? { items: [], total: 0, hasMore: false }
              : { configured: false, connected: false, repositories: [], commits: [], pulls: [] },
        ),
      );
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  try {
    await act(async () =>
      root.render(
        h(
          QueryClientProvider,
          { client },
          h(GitHub, {
            data,
            scope: (route) => `${route}?workspaceId=workspace`,
            refresh: vi.fn(async () => {}),
          }),
        ),
      ),
    );
    await act(async () => {
      await vi.waitFor(() => expect(el.textContent).toContain('No processed GitHub objects yet.'));
    });
    expect(el.textContent).not.toContain('Operational health');
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/health'))).toBe(
      false,
    );
  } finally {
    await act(async () => root.unmount());
    client.clear();
    el.remove();
    vi.unstubAllGlobals();
  }
});
