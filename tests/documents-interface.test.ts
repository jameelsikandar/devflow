// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ProjectDocuments } from '../src/components/project-documents';
import type { Snapshot } from '../src/lib/types';
import type { ProjectDocumentView } from '../src/lib/documents';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let el: HTMLDivElement, root: Root, client: QueryClient;
const person = { id: 'u', name: 'Owner', email: 'owner@example.invalid' };
const fixture = (): Snapshot => ({
  workspace: { id: 'w', name: 'Workspace', role: 'OWNER' },
  workspaces: [],
  projects: [
    {
      id: 'p',
      name: 'Project',
      description: '',
      color: '#aaa',
      repository: null,
      archivedAt: null,
      _count: { tasks: 0 },
    },
  ],
  members: [{ user: person, role: 'OWNER', lastSeenAt: new Date().toISOString() }],
  tasks: [],
  labels: [],
  activity: [],
  notifications: [],
});
const doc = (): ProjectDocumentView => ({
  id: 'd',
  projectId: 'p',
  workspaceId: 'w',
  title: 'Project guide',
  summary: 'Secure summary',
  ownerId: 'u',
  owner: { id: 'u', name: 'Owner' },
  version: 0,
  archivedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  permissions: { read: true, edit: true, manage: true },
  grants: [],
});
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
async function render(data = fixture()) {
  await act(async () =>
    root.render(
      h(
        QueryClientProvider,
        { client },
        h(ProjectDocuments, { data, selectedProjectId: 'p', onProjectChange: vi.fn() }),
      ),
    ),
  );
}
async function loaded(text: string) {
  await act(async () => {
    await vi.waitFor(() => expect(document.body.textContent).toContain(text));
  });
}
const button = (name: string) =>
  Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.trim() === name)!;
async function click(name: string) {
  await act(async () => button(name).click());
}
beforeEach(() => {
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/documents/d?')
        ? json({ ...doc(), projectArchived: false })
        : json({ documents: [doc()], total: 1, offset: 0, hasMore: false, projectArchived: false }),
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  el.remove();
  vi.unstubAllGlobals();
});
it('shows a scoped project list and opens accessible document details', async () => {
  await render();
  await loaded('Project guide');
  expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
    '/api/projects/p/documents?workspaceId=w&offset=0&archived=false',
  );
  const card = document.querySelector<HTMLButtonElement>('.document-card')!;
  await act(async () => card.click());
  await loaded('Owner: Owner');
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(button('Rename or edit summary')).toBeDefined();
});
it('renders an empty state without inventing document content', async () => {
  vi.mocked(fetch).mockResolvedValue(json({ documents: [], total: 0, offset: 0, hasMore: false }));
  await render();
  await loaded('No documents you can access');
  expect(document.body.textContent).toContain('content editing follows in M4.2');
});
it('keeps loading explicit and offers retry after an API error', async () => {
  let release!: (r: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  await render();
  expect(document.querySelector('[aria-label="Loading documents"]')).not.toBeNull();
  await act(async () => release(json({ error: 'Unable to load documents' }, 500)));
  await loaded('Unable to load documents');
  expect(button('Retry documents')).toBeDefined();
});
it('requires archive confirmation and sends the current metadata version', async () => {
  await render();
  await loaded('Project guide');
  await act(async () => document.querySelector<HTMLButtonElement>('.document-card')!.click());
  await loaded('Owner: Owner');
  await click('Archive document');
  expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  await click('Confirm archive');
  const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input).includes('/archive?'))!;
  expect(call[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ version: 0 }) });
});
it('does not show rename, access or archive controls to readers', async () => {
  vi.mocked(fetch).mockImplementation(async (input) =>
    String(input).includes('/documents/d?')
      ? json({ ...doc(), permissions: { read: true, edit: false, manage: false } })
      : json({ documents: [doc()], total: 1, offset: 0, hasMore: false }),
  );
  await render();
  await loaded('Project guide');
  await act(async () => document.querySelector<HTMLButtonElement>('.document-card')!.click());
  await loaded('Owner: Owner');
  expect(button('Archive document')).toBeUndefined();
  expect(button('Rename or edit summary')).toBeUndefined();
  expect(document.querySelector('[aria-label="Document permissions"]')).toBeNull();
});
it('escapes titles and summaries rather than injecting HTML', async () => {
  vi.mocked(fetch).mockResolvedValue(
    json({
      documents: [
        { ...doc(), title: '<img src=x onerror=alert(1)>', summary: '<script>bad()</script>' },
      ],
      total: 1,
      offset: 0,
      hasMore: false,
    }),
  );
  await render();
  await loaded('<script>bad()</script>');
  expect(document.querySelector('script')).toBeNull();
  expect(document.querySelector('img')).toBeNull();
});
it('provides labelled creation controls and prevents empty-title submission', async () => {
  await render();
  await loaded('Project guide');
  await click('New document');
  expect(document.querySelector('[role="dialog"] input[maxlength="160"]')).not.toBeNull();
  expect(button('Save document').disabled).toBe(true);
});
it('preserves readable styles without reducing mobile typography or fixing dialog widths', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync('src/components/project-documents.css', 'utf8');
  expect(css).toContain('var(--font-size-body)');
  expect(css).toContain('overflow-wrap: anywhere');
  expect(css.slice(css.indexOf('@media'))).not.toContain('font-size:');
  expect(css).not.toContain('100vw');
});
