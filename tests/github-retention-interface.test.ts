// @vitest-environment jsdom
import { act, createElement as h, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { GitHubRetentionReport } from '../src/components/github-retention-report';
import { retentionFixture } from './github-retention-fixture';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let el: HTMLDivElement, root: Root, client: QueryClient;
const props = { workspaceId: 'w', projectId: 'p', admin: true };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
async function render(extra: Partial<ComponentProps<typeof GitHubRetentionReport>> = {}) {
  await act(async () =>
    root.render(
      h(QueryClientProvider, { client }, h(GitHubRetentionReport, { ...props, ...extra })),
    ),
  );
}
async function loaded(value = 'No GitHub operational records') {
  await act(async () => {
    await vi.waitFor(() => expect(el.textContent).toContain(value));
  });
}
const button = () => el.querySelector('button')!;
beforeEach(() => {
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  client = new QueryClient();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json(retentionFixture())),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  el.remove();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});
it('reports only after an explicit read-only request and provides a clear empty state', async () => {
  await render();
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => button().click());
  await loaded();
  expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
    '/api/github/projects/p/retention?workspaceId=w&days=30',
  );
  expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ cache: 'no-store' });
  expect(el.querySelectorAll('tbody tr')).toHaveLength(7);
  expect(el.textContent).toContain('Nothing is deleted');
  expect(el.querySelector('table caption')).not.toBeNull();
});
it('has loading/disabled controls and explicit retry with sanitized errors', async () => {
  let release!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  await render();
  await act(async () => button().click());
  await act(async () => {
    await vi.waitFor(() => expect(button().disabled).toBe(true));
  });
  expect(el.querySelector('select')!.disabled).toBe(true);
  expect(el.textContent).toContain('Calculating scoped counts');
  await act(async () => release(json({ error: 'private database secret' }, 500)));
  await loaded('Could not calculate retention impact');
  expect(el.textContent).not.toContain('private');
  expect(fetch).toHaveBeenCalledOnce();
  await act(async () => button().click());
  await loaded();
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('hides the report for members and clears prior results after role or project changes', async () => {
  await render({ admin: false });
  expect(el.textContent).toBe('');
  expect(fetch).not.toHaveBeenCalled();
  await render();
  await act(async () => button().click());
  await loaded();
  await render({ admin: false });
  expect(el.textContent).toBe('');
  await render({ projectId: 'other' });
  expect(el.textContent).not.toContain('No GitHub operational records');
  await act(async () => button().click());
  await loaded('unavailable for this account or project');
});
it('clears selected-window results and rejects mismatched window/scope replies', async () => {
  await render();
  await act(async () => button().click());
  await loaded();
  await act(async () => {
    const select = el.querySelector('select')!;
    select.value = '7';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(el.textContent).not.toContain('No GitHub operational records');
  expect(fetch).toHaveBeenCalledOnce();
  await act(async () => button().click());
  await loaded('unavailable for this account or project');
  expect(el.textContent).not.toContain('No GitHub operational records');
});
it('shows bounds as incomplete instead of zero totals or cleanup permission', async () => {
  const fixture = retentionFixture();
  fixture.complete = false;
  Object.assign(fixture.categories[0], {
    complete: false,
    scannedAtLeast: 10001,
    total: null,
    older: null,
    potentiallyEligible: null,
    preservedOlder: null,
    dependencyProtectedOlder: null,
  });
  vi.mocked(fetch).mockResolvedValueOnce(json(fixture));
  await render();
  await act(async () => button().click());
  await loaded('Report incomplete');
  expect(el.textContent).toContain('analysis not calculated');
  expect(el.querySelector('tbody tr td')?.getAttribute('colspan')).toBe('5');
  expect(el.textContent).not.toContain('No GitHub operational records');
});
it('shows preservation evidence and locale timestamps without arbitrary messages or identifiers', async () => {
  const fixture = retentionFixture();
  Object.assign(fixture.categories[0], {
    total: 2,
    scannedAtLeast: 2,
    older: 2,
    preservedOlder: 2,
    dependencyProtectedOlder: 1,
    oldestAt: '2026-01-01T00:00:00Z',
    newestAt: '2026-01-02T00:00:00Z',
    reasons: [
      {
        code: 'REPLAY_PROTECTION',
        count: 2,
        oldestAt: '2026-01-01T00:00:00Z',
        newestAt: '2026-01-02T00:00:00Z',
      },
    ],
  });
  vi.mocked(fetch).mockResolvedValueOnce(
    json({ ...fixture, payload: 'private-token', message: 'private-secret' }),
  );
  await render();
  await act(async () => button().click());
  await loaded('Replay/deduplication receipts');
  expect(el.textContent).not.toMatch(/private-token|private-secret/);
  expect(el.querySelector('details')?.open).toBe(false);
  expect(el.querySelectorAll('time').length).toBeGreaterThan(1);
  expect(el.querySelectorAll('button')).toHaveLength(1);
});
it.each(['dark', 'light'])(
  'retains table semantics and keyboard access in %s theme',
  async (theme) => {
    document.documentElement.dataset.theme = theme;
    await render();
    button().focus();
    expect(document.activeElement).toBe(button());
    await act(async () => button().click());
    await loaded();
    const region = el.querySelector('[aria-label="Retention impact counts"]') as HTMLElement;
    region.focus();
    expect(document.activeElement).toBe(region);
    expect(el.querySelectorAll('thead th[scope="col"]')).toHaveLength(6);
  },
);
it('removes previous eligibility after a failed regeneration instead of presenting it as current', async () => {
  await render();
  await act(async () => button().click());
  await loaded();
  vi.mocked(fetch).mockResolvedValueOnce(json({ error: 'private SQL timeout' }, 500));
  await act(async () => button().click());
  await loaded('Could not calculate retention impact');
  expect(el.querySelector('table')).toBeNull();
  expect(el.textContent).not.toContain('No GitHub operational records');
  expect(el.textContent).not.toContain('private');
});
