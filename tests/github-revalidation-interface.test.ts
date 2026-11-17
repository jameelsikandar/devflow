// @vitest-environment jsdom
import { act, createElement as h, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { GitHubConnectionRevalidation } from '../src/components/github-connection-revalidation';
import { revalidationMessages, type RevalidationCode } from '../src/lib/github-revalidation';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let el: HTMLDivElement, root: Root, client: QueryClient;
const props = { workspaceId: 'w', projectId: 'p', connectionId: 'c', admin: true };
const result = (code: RevalidationCode = 'ACCESS_VALID') => ({
  scope: { workspaceId: 'w', projectId: 'p', connectionId: 'c' },
  checkedAt: new Date().toISOString(),
  authorizationSource: 'REQUESTING_ADMIN',
  code,
  state: revalidationMessages[code].state,
  retryAt: null,
  retrySource: null,
});
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
async function render(extra: Partial<ComponentProps<typeof GitHubConnectionRevalidation>> = {}) {
  await act(async () =>
    root.render(
      h(QueryClientProvider, { client }, h(GitHubConnectionRevalidation, { ...props, ...extra })),
    ),
  );
}
async function text(value: string) {
  await act(async () => {
    await vi.waitFor(() => expect(el.textContent).toContain(value));
  });
}
const button = () => el.querySelector('button')!;
beforeEach(() => {
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json(result())),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  el.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  onlineManager.setOnline(true);
});
it('makes no mount/poll request and checks only on explicit keyboard-focusable action', async () => {
  await render();
  expect(fetch).not.toHaveBeenCalled();
  button().focus();
  expect(document.activeElement).toBe(button());
  await act(async () => button().click());
  await text('Repository access verified');
  expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
  const [url, options] = vi.mocked(fetch).mock.calls[0];
  expect(String(url)).toContain('/revalidate?workspaceId=w');
  expect(options).toMatchObject({ method: 'POST', body: '{}', cache: 'no-store' });
  expect(el.textContent).toContain('Your OAuth account only');
  expect(el.textContent).toContain('Point-in-time diagnostic');
});
it('shows a loading state and prevents duplicate submissions while pending', async () => {
  let release!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  await render();
  await act(async () => button().click());
  expect(button().disabled).toBe(true);
  expect(el.textContent).toContain('Checking authorization');
  await act(async () => button().click());
  expect(fetch).toHaveBeenCalledOnce();
  await act(async () => release(json(result())));
  await text('Repository access verified');
});
it('hides administrator actions for members, missing connection and role loss', async () => {
  await render({ admin: false });
  expect(el.textContent).toBe('');
  await render({ connectionId: undefined });
  expect(el.textContent).toBe('');
  expect(fetch).not.toHaveBeenCalled();
  await render();
  await act(async () => button().click());
  await text('Repository access verified');
  await render({ admin: false });
  expect(el.textContent).toBe('');
});
it('clears evidence on scope changes and refuses a response from another project', async () => {
  await render();
  await act(async () => button().click());
  await text('Repository access verified');
  await render({ projectId: 'other' });
  expect(el.textContent).not.toContain('Repository access verified');
  expect(fetch).toHaveBeenCalledOnce();
  await act(async () => button().click());
  await text('unavailable for this account or connection');
  expect(el.textContent).not.toContain('Repository access verified');
});
it('shows sanitized failures and explicit retry without scheduling any retry', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(json({ error: 'private token' }, 500));
  await render();
  await act(async () => button().click());
  await text('Unable to complete revalidation');
  expect(el.textContent).not.toContain('private token');
  expect(button().textContent).toBe('Try revalidation again');
  expect(fetch).toHaveBeenCalledOnce();
  expect(client.getMutationCache().getAll()[0].state.error?.message).not.toContain('private token');
  await act(async () => button().click());
  await text('Repository access verified');
  expect(fetch).toHaveBeenCalledTimes(2);
});
it.each([
  'AUTHORIZATION_REJECTED',
  'OTHER_ENRICHMENT_AUTHORIZER',
  'REPOSITORY_PERMISSION_INSUFFICIENT',
  'PERMISSION_EVIDENCE_MISSING',
  'REPOSITORY_IDENTITY_CHANGED',
  'OAUTH_ACCOUNT_MISSING',
] as const)('explains %s without arbitrary server diagnostics', async (code) => {
  vi.mocked(fetch).mockResolvedValueOnce(
    json({ ...result(code), message: 'private provider content', encryptedToken: 'secret' }),
  );
  await render();
  await act(async () => button().click());
  await text(revalidationMessages[code].title);
  expect(el.textContent).not.toMatch(/private provider|secret/);
});
it('waits only for evidenced retry timing and never triggers an automatic external check', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-17T12:00:00Z'));
  vi.mocked(fetch).mockResolvedValueOnce(
    json({
      ...result('GITHUB_RATE_LIMITED'),
      retryAt: new Date(Date.now() + 2000).toISOString(),
      retrySource: 'PROVIDER_HEADER',
    }),
  );
  await render();
  await act(async () => {
    button().click();
    await vi.advanceTimersByTimeAsync(20);
  });
  expect(el.textContent).toContain('Observed provider retry deadline');
  expect(button().disabled).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(button().disabled).toBe(false);
  expect(fetch).toHaveBeenCalledOnce();
});
it('does not fabricate retry timing when provider timing is absent', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(json(result('GITHUB_RATE_LIMITED')));
  await render();
  await act(async () => button().click());
  await text('GitHub rate limited');
  expect(el.textContent).not.toContain('Observed provider retry deadline');
  expect(button().disabled).toBe(false);
});
it('clears results on remount instead of silently revalidating', async () => {
  await render();
  await act(async () => button().click());
  await text('Repository access verified');
  await render({ admin: false });
  await render();
  expect(el.textContent).not.toContain('Repository access verified');
  expect(fetch).toHaveBeenCalledOnce();
});

it('fails an explicit offline attempt immediately instead of silently running it on reconnect', async () => {
  vi.useFakeTimers();
  onlineManager.setOnline(false);
  vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));
  await render();
  await act(async () => {
    button().click();
    await vi.advanceTimersByTimeAsync(20);
  });
  expect(el.textContent).toContain('Unable to complete revalidation');
  expect(fetch).toHaveBeenCalledOnce();
  await act(async () => {
    onlineManager.setOnline(true);
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(fetch).toHaveBeenCalledOnce();
});
