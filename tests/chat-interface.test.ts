// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Assistant } from '../src/components/integrations';
import type { Snapshot } from '../src/lib/types';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const data = {
  workspace: { id: 'w', name: 'Workspace', role: 'OWNER' },
  projects: [
    { id: 'p', name: 'DevFlow' },
    { id: 'q', name: 'Second project' },
  ],
  tasks: [],
  members: [],
  labels: [],
} as unknown as Snapshot;
let root: Root, el: HTMLDivElement, client: QueryClient;
let decisions: { decision: string; previewHash: string }[];
let fetchMock: ReturnType<typeof vi.fn>;
const hash = 'a'.repeat(64);
const proposal = () => ({
  id: 'proposal',
  tool: 'createTask',
  preview: {
    project: { name: 'DevFlow' },
    title: 'Review me',
    description: '**Acceptance criteria**',
    status: 'IN_REVIEW',
    priority: 'MEDIUM',
    assigneeId: null,
  },
  previewHash: hash,
  expiresAt: new Date(Date.now() + 600000).toISOString(),
  status: 'PENDING',
  result: null,
});
let preview: ReturnType<typeof proposal>;
let savedProjectId: string | null;
let newProjectId: string | null;
let sentPrompt: string;
beforeEach(() => {
  decisions = [];
  savedProjectId = 'p';
  newProjectId = null;
  sentPrompt = '';
  vi.stubGlobal('crypto', { randomUUID: () => 'ea99be41-37bc-4cad-9ff8-f863b333f03c' });
  preview = proposal();
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    let json: unknown;
    if (url.includes('/decision')) {
      const input = JSON.parse(String(init?.body));
      decisions.push(input);
      preview.status = input.decision === 'approve' ? 'APPLIED' : 'REJECTED';
      json = { status: preview.status };
    } else if (url === '/api/ai/conversations' && init?.method === 'POST') {
      newProjectId = JSON.parse(String(init.body)).projectId ?? null;
      json = { id: 'new' };
    } else if (url.endsWith('/messages')) {
      sentPrompt = JSON.parse(String(init?.body)).prompt;
      json = {
        id: 'new-run',
        prompt: sentPrompt,
        answer: 'Scoped fixture answer',
        status: 'COMPLETED',
        events: [],
        proposals: [],
      };
    } else if (url === '/api/ai/conversations/new')
      json = {
        id: 'new',
        title: 'New scope',
        projectId: newProjectId,
        runs: [
          {
            id: 'new-run',
            prompt: sentPrompt,
            answer: 'Scoped fixture answer',
            status: 'COMPLETED',
            events: [],
            proposals: [],
          },
        ],
      };
    else if (url === '/api/ai/config') json = { configured: true, model: 'openai/gpt-oss-120b' };
    else if (url === '/api/ai/conversations')
      json = [{ id: 'c', title: 'Saved conversation', projectId: savedProjectId }];
    else if (url.startsWith('/api/ai/artifacts')) json = { sprints: [], reports: [] };
    else if (url === '/api/ai/conversations/c')
      json = {
        id: 'c',
        title: 'Saved conversation',
        projectId: savedProjectId,
        runs: [
          {
            id: 'r',
            prompt: 'Project tasks?',
            answer: '## Tasks in DevFlow\n\n| Task | Status |\n|---|---|\n| DEV-1 | In Review |',
            status: 'COMPLETED',
            events: [],
            proposals: [preview],
          },
        ],
      };
    else if (url === '/api/ai') json = { text: 'Original quick draft result' };
    else throw new Error(`Unexpected URL ${url}`);
    return { ok: true, json: async () => json };
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  el.remove();
  vi.unstubAllGlobals();
});
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}
async function mount(selectedProjectId?: string) {
  act(() =>
    root.render(
      h(
        QueryClientProvider,
        { client },
        h(Assistant, { data, scope: (route) => route, refresh: async () => {}, selectedProjectId }),
      ),
    ),
  );
  await settle();
}
async function click(text: string) {
  const button = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
  await settle();
}
it('reloads saved history into formatted messages after a component remount', async () => {
  await mount();
  await click('Saved conversation');
  expect(el.querySelector('.chat-markdown h2')?.textContent).toBe('Tasks in DevFlow');
  expect(el.querySelector('tbody td')?.textContent).toBe('DEV-1');
  act(() => root.unmount());
  root = createRoot(el);
  client.clear();
  await mount();
  await click('Saved conversation');
  expect(el.querySelector('.chat-markdown h2')?.textContent).toBe('Tasks in DevFlow');
  expect(decisions).toHaveLength(0);
});
it.each(['approve', 'reject'])(
  'keeps %s explicit and sends only the original immutable preview hash',
  async (decision) => {
    await mount();
    await click('Saved conversation');
    expect(decisions).toHaveLength(0);
    expect(JSON.parse(el.querySelector('.agent-preview-values pre')!.textContent!)).toEqual(
      preview.preview,
    );
    expect(el.querySelector('.agent-preview-values')!.hasAttribute('open')).toBe(false);
    expect(el.textContent).toContain('In Review');
    expect(el.textContent).toContain('Unassigned');
    await click(decision === 'approve' ? 'Approve: create task' : 'Reject');
    expect(decisions).toEqual([{ decision, previewHash: hash }]);
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/tasks'))).toBe(false);
  },
);
it('keeps Quick Drafts action selection, request and response behavior', async () => {
  await mount();
  await click('Quick drafts');
  expect(el.querySelectorAll('.ai-action')).toHaveLength(6);
  await click('Give me a starting point');
  const request = fetchMock.mock.calls.find(([url]) => url === '/api/ai');
  expect(JSON.parse(String(request?.[1]?.body))).toEqual({ action: 'subtasks', prompt: '' });
  expect(el.textContent).toContain('Original quick draft result');
  expect(decisions).toHaveLength(0);
});
it('inherits the selected project, exposes clear context and task chips without sending automatically', async () => {
  await mount('p');
  const indicator = el.querySelector('[aria-label="Conversation context"]')!;
  expect(indicator.textContent).toContain('Workspace');
  expect(indicator.textContent).toContain('Project: DevFlow');
  expect(indicator.textContent).toContain('GPT-OSS 120B');
  expect((el.querySelector('[aria-label="AI project context"]') as HTMLSelectElement).value).toBe(
    'p',
  );
  await click('Assigned to me');
  const prompt = el.querySelector('#agent-prompt') as HTMLTextAreaElement;
  expect(prompt.value).toContain('Show only tasks assigned to me');
  expect(document.activeElement).toBe(prompt);
  await click('All project tasks');
  expect(prompt.value).toContain('including unassigned and completed tasks');
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  expect(el.querySelector('.agent-artifacts')?.hasAttribute('open')).toBe(false);
});
it('keeps an existing conversation immutable across visible project changes and creates a new scope explicitly', async () => {
  await mount('q');
  await click('Saved conversation');
  expect(el.querySelector('[aria-label="Conversation context"]')?.textContent).toContain(
    'Project: DevFlow',
  );
  expect(el.querySelector('[aria-label="AI project context"]')).toBeNull();
  // A parent project change cannot retarget an existing conversation.
  await mount('q');
  expect(el.querySelector('[aria-label="Conversation context"]')?.textContent).toContain(
    'Project: DevFlow',
  );
  await click('Start a new scope');
  const select = el.querySelector('[aria-label="AI project context"]') as HTMLSelectElement;
  expect(select.value).toBe('p');
  act(() => {
    select.value = 'q';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click('Assigned to me');
  const prompt = el.querySelector('#agent-prompt')!;
  await act(async () =>
    prompt.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
    ),
  );
  await settle();
  await settle();
  const creation = fetchMock.mock.calls.find(
    ([url, init]) => url === '/api/ai/conversations' && init?.method === 'POST',
  );
  expect(JSON.parse(String(creation?.[1]?.body))).toMatchObject({ projectId: 'q' });
  expect(fetchMock.mock.calls.some(([url]) => url.includes('/conversations/c/messages'))).toBe(
    false,
  );
  expect(el.querySelector('[aria-label="Conversation context"]')?.textContent).toContain(
    'Project: Second project',
  );
  expect(decisions).toHaveLength(0);
});
it('shows workspace scope honestly and offers a workspace task shortcut', async () => {
  savedProjectId = null;
  await mount('p');
  await click('Saved conversation');
  expect(el.querySelector('[aria-label="Conversation context"]')?.textContent).toContain(
    'All accessible projects in this workspace',
  );
  await click('All workspace tasks');
  expect((el.querySelector('#agent-prompt') as HTMLTextAreaElement).value).toContain(
    'all workspace tasks',
  );
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
it('holds the composer while real conversation scope is loading', async () => {
  const implementation = fetchMock.getMockImplementation()!;
  let resolve!: () => void;
  const loading = new Promise<void>((r) => {
    resolve = r;
  });
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/ai/conversations/c') await loading;
    return implementation(url, init);
  });
  await mount('p');
  await click('Saved conversation');
  expect(el.querySelector('[aria-label="Conversation context"]')?.textContent).toContain(
    'Loading conversation scope',
  );
  expect((el.querySelector('#agent-prompt') as HTMLTextAreaElement).disabled).toBe(true);
  await act(async () => resolve());
  await settle();
  expect((el.querySelector('#agent-prompt') as HTMLTextAreaElement).disabled).toBe(false);
});
it('preserves Enter as a newline and uses Cmd+Enter to submit exactly one scoped request', async () => {
  await mount();
  await click('Unassigned');
  const input = el.querySelector('#agent-prompt')!;
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }),
    );
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }),
    );
  });
  await settle();
  await settle();
  const sent = fetchMock.mock.calls.filter(([url]) => url.endsWith('/messages'));
  expect(sent).toHaveLength(1);
  expect(JSON.parse(String(sent[0][1]?.body))).toMatchObject({
    requestId: 'ea99be41-37bc-4cad-9ff8-f863b333f03c',
    prompt: expect.stringContaining('unassigned tasks'),
  });
});
it('uses authorized conversation metadata to explain archived scope even with an older snapshot', async () => {
  const implementation = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const response = await implementation(url, init);
    if (url !== '/api/ai/conversations/c') return response;
    return {
      ok: true,
      json: async () => ({
        ...((await response.json()) as object),
        project: { id: 'p', name: 'DevFlow', archivedAt: '2026-11-13T00:00:00Z' },
      }),
    };
  });
  await mount();
  await click('Saved conversation');
  expect(el.querySelector('[aria-label="Conversation context"]')?.textContent).toContain(
    '(archived)',
  );
  expect(el.textContent).toContain('This project is archived');
  expect((el.querySelector('#agent-prompt') as HTMLTextAreaElement).disabled).toBe(true);
  await click('Start a new scope');
  expect((el.querySelector('[aria-label="AI project context"]') as HTMLSelectElement).value).toBe(
    'all',
  );
});
it('keeps Quick Draft context and payload aligned while formatting its read-only response', async () => {
  const implementation = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
    url === '/api/ai'
      ? {
          ok: true,
          json: async () => ({
            text: '## Draft brief\n\n**Acceptance criteria**\n\n- Review the result',
          }),
        }
      : implementation(url, init),
  );
  await mount('p');
  await click('Quick drafts');
  expect(el.querySelector('[aria-label="Quick Draft context"]')?.textContent).toContain(
    'Project: DevFlow',
  );
  expect(el.querySelector('[aria-label="Quick Draft context"]')?.textContent).toContain(
    'GPT-OSS 120B',
  );
  await click('Give me a starting point');
  expect(el.querySelector('.ai-result h2')?.textContent).toBe('Draft brief');
  expect(el.querySelector('.ai-result strong')?.textContent).toBe('Acceptance criteria');
  const request = fetchMock.mock.calls.find(([url]) => url === '/api/ai');
  expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
    action: 'subtasks',
    projectId: 'p',
  });
  expect(decisions).toHaveLength(0);
});
it('clears Quick Draft results and scope when the active workspace changes', async () => {
  await mount('p');
  await click('Quick drafts');
  await click('Give me a starting point');
  expect(el.textContent).toContain('Original quick draft result');
  const otherData = {
    ...data,
    workspace: { ...data.workspace, id: 'other-workspace', name: 'Other workspace' },
    projects: [{ ...data.projects[0], id: 'other-project', name: 'Other project' }],
  };
  act(() =>
    root.render(
      h(
        QueryClientProvider,
        { client },
        h(Assistant, {
          data: otherData,
          selectedProjectId: 'other-project',
          scope: (route) => route,
          refresh: async () => {},
        }),
      ),
    ),
  );
  await settle();
  expect(el.textContent).not.toContain('Original quick draft result');
  expect(el.querySelector('[aria-label="Quick Draft context"]')?.textContent).toContain(
    'Other workspace',
  );
  expect(el.querySelector('[aria-label="Quick Draft context"]')?.textContent).toContain(
    'Other project',
  );
});
it('only titles a new conversation from the submitted request, not a suggested prompt', async () => {
  await mount('p');
  await click('Task brief');
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  await click('Assigned to me');
  await click('Send request');
  await settle();
  const request = fetchMock.mock.calls.find(
    ([url, init]) => url === '/api/ai/conversations' && init?.method === 'POST',
  );
  expect(JSON.parse(String(request?.[1]?.body)).title).toMatch(/^Show only tasks assigned to me/);
  expect(el.textContent).toContain('Saved conversation');
});
it('opens keyboard-accessible history and returns to the selected conversation', async () => {
  await mount();
  await act(async () =>
    (el.querySelector('[aria-label="Open conversations"]') as HTMLButtonElement).click(),
  );
  await settle();
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog).not.toBeNull();
  expect(dialog.querySelector('nav[aria-label="AI conversations"]')).not.toBeNull();
  const item = dialog.querySelector('nav button') as HTMLButtonElement;
  expect(item.title).toBe('Saved conversation');
  await act(async () => item.click());
  await settle();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(el.querySelector('.agent-chat-heading h2')?.textContent).toBe('Saved conversation');
});
it('switches plans into a secondary pane without moving or resetting the chat', async () => {
  await mount();
  await click('Saved conversation');
  const transcript = el.querySelector('.agent-transcript') as HTMLElement;
  transcript.scrollTop = 50;
  await click('Plans & reports');
  expect(transcript.hidden).toBe(true);
  expect((el.querySelector('.agent-composer') as HTMLElement).hidden).toBe(true);
  expect((el.querySelector('.agent-artifacts') as HTMLElement).hidden).toBe(false);
  await click('Chat');
  expect(transcript.hidden).toBe(false);
  expect(transcript.scrollTop).toBe(50);
});
it('renders a single persisted rate-limit failure with successful verified task data and no fake answer', async () => {
  const implementation = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const response = await implementation(url, init);
    if (url !== '/api/ai/conversations/c') return response;
    return {
      ok: true,
      json: async () => ({
        ...((await response.json()) as object),
        runs: [
          {
            id: 'limited',
            prompt: 'My tasks?',
            answer: '',
            status: 'FAILED',
            error: `Groq is rate limited or has reached its quota. Retry after ${new Date(Date.now() + 60000).toISOString()}.`,
            proposals: [],
            events: [
              {
                id: 'read',
                name: 'listTasks',
                input: { scope: 'mine' },
                output: {
                  items: [],
                  total: 0,
                  scope: { kind: 'mine' },
                  projectContext: {
                    projectName: 'DevFlow',
                    items: [
                      {
                        id: 'real',
                        number: 7,
                        title: 'Retrieved actual task',
                        status: 'TODO',
                        priority: 'MEDIUM',
                        assigneeId: null,
                      },
                    ],
                    total: 3,
                    unassignedTotal: 3,
                  },
                },
              },
            ],
          },
        ],
      }),
    };
  });
  await mount();
  await click('Saved conversation');
  expect(el.querySelectorAll('[role="alert"]')).toHaveLength(1);
  expect(el.textContent).toContain('retrieved successfully');
  expect(el.querySelector('[aria-label="Verified task data"]')?.textContent).toContain(
    'Retrieved actual task',
  );
  expect(el.querySelector('.chat-copy[aria-label="Copy response"]')).toBeNull();
  expect(el.querySelector('.chat-tool-activity')?.hasAttribute('open')).toBe(false);
  await click('Assigned to me');
  expect((el.querySelector('[aria-label="Send request"]') as HTMLButtonElement).disabled).toBe(
    false,
  );
  expect(decisions).toHaveLength(0);
});
it('retains the active conversation when moving between Quick Drafts and chat', async () => {
  await mount();
  await click('Saved conversation');
  await click('Quick drafts');
  expect((el.querySelector('.assistant-manager-frame') as HTMLElement).hidden).toBe(true);
  await click('Project manager');
  expect(el.querySelector('.agent-chat-heading h2')?.textContent).toBe('Saved conversation');
  expect((el.querySelector('.assistant-manager-frame') as HTMLElement).hidden).toBe(false);
});
