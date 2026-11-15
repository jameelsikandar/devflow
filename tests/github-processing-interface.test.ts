// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { GitHubProcessing } from '../src/components/github-processing';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it('shows sanitized queue/activity states and sends retry/enrichment commands only on explicit clicks', async () => {
  const writes: { path: string; input: unknown }[] = [];
  let failed = true;
  let enabled = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, 'http://localhost').pathname;
      if (init?.method === 'POST') {
        const input = JSON.parse(String(init.body));
        writes.push({ path, input });
        if (path.endsWith('/retry')) failed = false;
        else enabled = input.enabled;
        return new Response(JSON.stringify({ ok: true }));
      }
      return new Response(
        JSON.stringify(
          path.endsWith('/processing')
            ? {
                counts: { FAILED: failed ? 1 : 0, PENDING: failed ? 0 : 1 },
                total: 1,
                hasMore: false,
                enrichmentEnabled: enabled,
                disconnected: false,
                items: [
                  {
                    id: 'd',
                    event: 'push',
                    state: failed ? 'FAILED' : 'PENDING',
                    attempts: 1,
                    errorCode: failed ? 'LEASE_EXPIRED' : null,
                    deadLetteredAt: null,
                    availableAt: new Date().toISOString(),
                    leaseExpiresAt: null,
                  },
                ],
              }
            : {
                total: 1,
                hasMore: false,
                items: [
                  {
                    id: 'o',
                    kind: 'COMMIT',
                    key: 'a'.repeat(40),
                    sourceUpdatedAt: null,
                    links: [{ task: { id: 'task', number: 12, title: 'Tracked work' } }],
                    observations: [
                      {
                        id: 'obs',
                        incomplete: true,
                        enrichmentCode: 'ENRICHMENT_NOT_AUTHORIZED',
                        unresolvedRefs: ['DEV-45'],
                      },
                    ],
                  },
                ],
              },
        ),
      );
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  const openTask = vi.fn();
  const button = (text: string) =>
    [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  try {
    await act(async () =>
      root.render(
        h(
          QueryClientProvider,
          { client },
          h(GitHubProcessing, {
            workspaceId: 'w',
            projectId: 'p',
            connectionId: 'c',
            admin: true,
            scope: (route) => `${route}?workspaceId=w`,
            openTask,
          }),
        ),
      ),
    );
    await act(async () => {
      await vi.waitFor(() => expect(button('Retry delivery')).toBeDefined());
    });
    expect(writes).toHaveLength(0);
    expect(el.textContent).toContain('LEASE_EXPIRED');
    expect(el.textContent).toContain('incomplete');
    expect(el.textContent).toContain('unresolved: DEV-45');
    await act(async () => button('DEV-12 — Tracked work')!.click());
    expect(openTask).toHaveBeenCalledWith('task');
    await act(async () => button('Retry delivery')!.click());
    await act(async () => {
      await vi.waitFor(() => expect(button('Retry delivery')).toBeUndefined());
    });
    expect(writes[0]).toEqual({ path: '/api/github/repositories/c/deliveries/d/retry', input: {} });
    await act(async () => button('Authorize enrichment with my GitHub account')!.click());
    await act(async () => {
      await vi.waitFor(() => expect(button('Disable GitHub enrichment')).toBeDefined());
    });
    expect(writes[1]).toEqual({
      path: '/api/github/repositories/c/enrichment',
      input: { enabled: true },
    });
  } finally {
    await act(async () => root.unmount());
    client.clear();
    el.remove();
    vi.unstubAllGlobals();
  }
});
