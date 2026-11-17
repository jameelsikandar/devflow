// @vitest-environment jsdom
import { act, createElement as h, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GitHubOperationalHealth } from '../src/components/github-operational-health';
import { healthFixture } from './github-health-fixture';
import {
  HEALTH_REFRESH_MS,
  HEALTH_SNAPSHOT_MAX_AGE_MS,
  workerHealthLabels,
  operationalHealthSchema,
} from '../src/lib/github-operational-health';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let el: HTMLDivElement, root: Root, client: QueryClient;
const props = { workspaceId: 'w', projectId: 'p', connectionId: 'c', admin: true };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
async function render(overrides: Partial<ComponentProps<typeof GitHubOperationalHealth>> = {}) {
  await act(async () =>
    root.render(
      h(QueryClientProvider, { client }, h(GitHubOperationalHealth, { ...props, ...overrides })),
    ),
  );
}
async function loaded(text = 'Healthy idle') {
  await act(async () => {
    await vi.waitFor(() => expect(el.textContent).toContain(text));
  });
}
const refresh = () => el.querySelector('button')!;
beforeEach(() => {
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json(healthFixture())),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  el.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete document.documentElement.dataset.theme;
});
it.each(Object.entries(workerHealthLabels))(
  'labels %s without confusing worker evidence with job success',
  async (state, label) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(healthFixture(state as keyof typeof workerHealthLabels))),
    );
    await render();
    await loaded(label.title);
    expect(el.textContent).toContain(label.description);
    expect(el.querySelector('section')!.getAttribute('aria-labelledby')).toBeTruthy();
  },
);
it('has an accessible loading state, refresh control and independent empty-work state', async () => {
  let release!: (value: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    ),
  );
  await render();
  expect(el.querySelector('[role="status"]')?.textContent).toContain('Loading operational health');
  expect(refresh().disabled).toBe(true);
  await act(async () => release(json(healthFixture())));
  await loaded();
  expect(el.textContent).toContain('No deliveries or workflow executions recorded');
  expect(refresh().textContent).toContain('Refresh operational health');
  expect(refresh().disabled).toBe(false);
});
it('shows queue, backoff, failed delivery and automation outcome values from the authorized summary', async () => {
  const data = healthFixture();
  Object.assign(data.deliveries, {
    total: 12,
    failed: 3,
    ready: 2,
    scheduled: 4,
    processing: 1,
    expiredLeases: 1,
    deadLettered: 1,
    processed: 6,
  });
  Object.assign(data.automation, { total: 7, applied: 5, conflicted: 1, failed: 1 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json(data)),
  );
  await render();
  await loaded();
  const value = (section: string, label: string) =>
    [...el.querySelectorAll(`section[aria-label="${section}"] dt`)].find(
      (dt) => dt.textContent === label,
    )?.nextElementSibling?.textContent;
  expect(value('Delivery queue health', 'Ready now')).toBe('2');
  expect(value('Delivery queue health', 'Scheduled later')).toBe('4');
  expect(value('Delivery retry and failure health', 'Failed total')).toBe('3');
  expect(value('Delivery retry and failure health', 'Dead letters')).toBe('1');
  expect(value('Automation execution health', 'Applied')).toBe('5');
  expect(value('Automation execution health', 'Conflicted')).toBe('1');
  expect(el.textContent).not.toContain('No deliveries or workflow executions');
});
it('hides all health content and makes no request for ordinary members or a missing connection', async () => {
  client.setQueryData(['github-health', 'w', 'p', 'c'], healthFixture());
  await render({ admin: false });
  expect(el.textContent).toBe('');
  expect(fetch).not.toHaveBeenCalled();
  await render({ connectionId: undefined });
  expect(el.textContent).toContain('Select a connected repository');
  expect(fetch).not.toHaveBeenCalled();
});
it('never flashes cached data before authorization revalidation and hides it on 403', async () => {
  client.setQueryData(['github-health', 'w', 'p', 'c'], healthFixture());
  let release!: (value: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    ),
  );
  await render();
  expect(el.textContent).not.toContain('Healthy idle');
  await act(async () => release(json({ error: 'private denial payload' }, 403)));
  await loaded('unavailable for this account or connection');
  expect(el.textContent).not.toMatch(/Healthy idle|private denial|Delivery queue/);
});
it('removes previously visible cached health immediately when administrator access is lost', async () => {
  await render();
  await loaded();
  const calls = vi.mocked(fetch).mock.calls.length;
  await render({ admin: false });
  expect(el.textContent).toBe('');
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
});
it('isolates workspace/project/connection switches and rejects mismatched response scope', async () => {
  await render();
  await loaded();
  let release!: (value: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  await render({
    workspaceId: 'other workspace',
    projectId: 'other-project',
    connectionId: 'other-connection',
  });
  expect(el.textContent).not.toContain('Healthy idle');
  const [url, options] = vi.mocked(fetch).mock.calls.at(-1)!;
  expect(String(url)).toContain('other-connection/health?workspaceId=other%20workspace');
  expect(options).toMatchObject({ cache: 'no-store' });
  expect(options?.signal).toBeDefined();
  await act(async () => release(json(healthFixture())));
  await loaded('unavailable for this account or connection');
  expect(el.textContent).not.toContain('Healthy idle');
});
it('sanitizes transport errors and keeps successful stale evidence clearly labeled after refresh failure', async () => {
  await render();
  await loaded();
  vi.mocked(fetch).mockResolvedValueOnce(json({ error: 'private token' }, 500));
  await act(async () => refresh().click());
  await loaded('Could not refresh operational health');
  expect(el.textContent).toContain('Last observed: Healthy idle');
  expect(el.textContent).toContain('Snapshot stale');
  expect(el.textContent).not.toContain('private token');
  expect(client.getQueryState(['github-health', 'w', 'p', 'c'])?.error?.message).not.toContain(
    'private token',
  );
  expect(el.querySelector('[data-tone="healthy"]')).toBeNull();
});
it('ages snapshots locally and distinguishes a clock difference without claiming current healthy status', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-17T12:00:00Z'));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      json(
        healthFixture(
          'HEALTHY_IDLE',
          undefined,
          new Date(Date.now() - HEALTH_SNAPSHOT_MAX_AGE_MS + 1).toISOString(),
        ),
      ),
    ),
  );
  await render();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });
  expect(el.textContent).toContain('Healthy idle');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(el.textContent).toContain('Snapshot stale');
  vi.mocked(fetch).mockResolvedValueOnce(
    json(healthFixture('HEALTHY_IDLE', undefined, new Date(Date.now() + 60000).toISOString())),
  );
  await act(async () => {
    refresh().click();
    await vi.advanceTimersByTimeAsync(20);
  });
  expect(el.textContent).toContain('differs from this device');
});
it('polls read-only on an interval, supports keyboard-focusable refresh, and stops automatic polling after denial', async () => {
  vi.useFakeTimers();
  await render();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });
  refresh().focus();
  expect(document.activeElement).toBe(refresh());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(HEALTH_REFRESH_MS);
  });
  expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThanOrEqual(2);
  vi.mocked(fetch).mockResolvedValueOnce(json({ error: 'Access revoked' }, 403));
  await act(async () => {
    refresh().click();
    await vi.advanceTimersByTimeAsync(20);
  });
  const count = vi.mocked(fetch).mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(HEALTH_REFRESH_MS * 2);
  });
  expect(vi.mocked(fetch).mock.calls).toHaveLength(count);
  for (const [url, options] of vi.mocked(fetch).mock.calls) {
    expect(String(url)).toContain('/health?');
    expect(options?.method ?? 'GET').toBe('GET');
  }
});
it('shows only known guidance and never renders response messages or extra credential fields', async () => {
  const data = {
    ...healthFixture(),
    encryptedToken: 'private-token',
    diagnostics: [
      { code: 'WORK_SCHEDULED_LATER', message: '<script>private-secret</script>' },
      { code: 'UNKNOWN_PRIVATE_DIAGNOSTIC', message: 'private-token' },
    ],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json(data)),
  );
  await render();
  await loaded();
  expect(el.textContent).toContain('retry backoff');
  expect(el.textContent).not.toMatch(/private|UNKNOWN_PRIVATE/);
  const summary = [...el.querySelectorAll('summary')].find((s) =>
    s.textContent?.includes('Operational guidance'),
  )!;
  expect(summary.parentElement?.hasAttribute('open')).toBe(false);
  await act(async () => summary.click());
  expect(summary.parentElement?.hasAttribute('open')).toBe(true);
});
it.each(['dark', 'light'])('retains accessible semantic content in the %s theme', async (theme) => {
  document.documentElement.dataset.theme = theme;
  await render();
  await loaded();
  expect(el.querySelectorAll('dl').length).toBe(4);
  expect(el.querySelectorAll('time').length).toBeGreaterThan(0);
  expect(el.textContent).toContain('Read only');
});
it('rejects malformed health data without exposing validation errors', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ private: 'secret', worker: { state: 'INVENTED' } })),
  );
  await render();
  await loaded('Could not refresh operational health');
  expect(el.textContent).not.toMatch(/secret|INVENTED|ZodError/);
  expect(operationalHealthSchema.safeParse(healthFixture()).success).toBe(true);
});

it('does not reveal pre-existing cached summaries after a failed mount-time verification', async () => {
  client.setQueryData(['github-health', 'w', 'p', 'c'], healthFixture());
  vi.mocked(fetch).mockResolvedValueOnce(json({ error: 'database unavailable' }, 500));
  await render();
  await loaded('Could not refresh operational health');
  expect(el.textContent).not.toMatch(/Healthy idle|Delivery queue|Last observed/);
});
it('does not restore cached evidence after access denial followed by a transport failure', async () => {
  await render();
  await loaded();
  vi.mocked(fetch).mockResolvedValueOnce(json({ error: 'Forbidden' }, 403));
  await act(async () => refresh().click());
  await loaded('unavailable for this account or connection');
  vi.mocked(fetch).mockResolvedValueOnce(json({ error: 'Network failure' }, 500));
  await act(async () => refresh().click());
  await loaded('Could not refresh operational health');
  expect(el.textContent).not.toMatch(/Healthy idle|Delivery queue|Last observed/);
});
