// @vitest-environment jsdom
import React, { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatMarkdown } from '../src/components/chat/markdown';
import { AIMessage } from '../src/components/chat/ai-message';
import { ToolActivity } from '../src/components/chat/tool-activity';
import { useChatScroll } from '../src/components/chat/use-chat-scroll';
import {
  safeMarkdownURL,
  friendlyField,
  friendlyDate,
  redactDiagnostics,
  type ChatContext,
} from '../src/lib/chat-presentation';
import type { Snapshot } from '../src/lib/types';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const data = {
  projects: [
    { id: 'p', name: 'DevFlow' },
    { id: 'other', name: 'Other' },
  ],
  tasks: [
    { id: 't1', number: 1, projectId: 'p', title: 'Install Codex' },
    { id: 't2', number: 2, projectId: 'other', title: 'Other task' },
    { id: 't3', number: 3, projectId: 'foreign', title: 'Hidden' },
  ],
  members: [{ user: { id: 'me', name: 'Jemi' } }],
  labels: [],
} as unknown as Snapshot;
const context: ChatContext = { data, projectId: 'p', openTask: vi.fn() };
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function render(node: React.ReactNode) {
  act(() => root.render(node));
}
function markdown(content: string) {
  render(h(ChatMarkdown, { content, context }));
}
function click(el: Element | null) {
  expect(el).not.toBeNull();
  act(() => (el as HTMLElement).click());
}

describe('safe React Markdown rendering', () => {
  it('renders headings, emphasis, nested lists, breaks, checklists, quotes and separators', () => {
    markdown(
      '# Heading\n\n## Subheading\n\n### Third\n\n**Bold** and *italic*\nnext line\n\n1. First\n   - Nested\n2. Second\n\n- [x] Finished\n- [ ] Pending\n\n> Quote\n\n---',
    );
    expect(container.querySelector('h1')?.textContent).toBe('Heading');
    expect(container.querySelector('h2')).not.toBeNull();
    expect(container.querySelector('h3')).not.toBeNull();
    expect(container.querySelector('strong')?.textContent).toBe('Bold');
    expect(container.querySelector('em')?.textContent).toBe('italic');
    expect(container.querySelector('ol ul li')?.textContent).toBe('Nested');
    expect(container.querySelector('br')).not.toBeNull();
    expect(container.querySelector('blockquote')?.textContent).toContain('Quote');
    expect(container.querySelector('hr')).not.toBeNull();
    expect(container.querySelectorAll('input:disabled')).toHaveLength(2);
    expect(container.querySelectorAll('input:checked')).toHaveLength(1);
  });
  it('renders actual responsive tables with headers and keyboard-scrollable container', () => {
    markdown(
      '| Task | Status | Priority | Assignee |\n|---|---|---|---|\n| DEV-1 — Install Codex | In Review | Medium | Unassigned |',
    );
    expect(container.querySelectorAll('th[scope="col"]')).toHaveLength(4);
    expect(container.querySelectorAll('tbody td')).toHaveLength(4);
    expect(container.querySelector('.chat-table-scroll')?.getAttribute('tabindex')).toBe('0');
    expect(container.querySelector('.chat-table-scroll')?.getAttribute('role')).toBe('region');
  });
  it('renders inline and highlighted fenced code as text, with language and copy controls', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    markdown('Use `const x`\n\n```typescript\nconst value = "<script>";\n```');
    expect(container.querySelector('.chat-inline-code')?.textContent).toBe('const x');
    expect(container.querySelector('.syntax-keyword')?.textContent).toBe('const');
    expect(container.querySelector('pre code')?.textContent).toBe('const value = "<script>";');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('.chat-code-heading')?.textContent).toContain('typescript');
    await act(async () =>
      (container.querySelector('[aria-label="Copy code"]') as HTMLElement).click(),
    );
    expect(writeText).toHaveBeenCalledWith('const value = "<script>";');
    markdown('```python\nprint("hello")\n```');
    expect(container.querySelector('pre code')?.textContent).toBe('print("hello")');
  });
  it('allows safe external links with protective attributes and blocks dangerous/obfuscated protocols', () => {
    markdown(
      '[**Docs**](https://example.com/docs) [Mail](mailto:team@example.com) [bad](javascript:alert%281%29) [data](data:text/html,evil) [encoded](javascript&#58;alert%281%29)',
    );
    const links = [...container.querySelectorAll('a')];
    expect(links).toHaveLength(2);
    expect(links[0].querySelector('strong')?.textContent).toBe('Docs');
    for (const link of links) {
      expect(link.target).toBe('_blank');
      expect(link.rel).toContain('noopener');
      expect(link.rel).toContain('noreferrer');
    }
    for (const url of [
      'javascript:alert(1)',
      'java\nscript:alert(1)',
      'vbscript:x',
      'data:text/html,x',
      '//evil.test',
      '/api/private',
      'https://user:password@example.com',
      'devflow-task:DEV-1',
    ])
      expect(safeMarkdownURL(url)).toBeNull();
  });
  it('never creates raw HTML, script, unsafe embeds, image requests or event handlers', () => {
    markdown(
      '<script>alert(1)</script>\n\n<img src="https://evil.test/track" onerror="alert(1)">\n\n<iframe src="https://evil.test"></iframe>\n\n![remote image](https://evil.test/image)\n\n&lt;script&gt;escaped&lt;/script&gt; &amp; safe',
    );
    expect(container.querySelector('script, img, iframe, object, embed')).toBeNull();
    expect(container.innerHTML).not.toContain('onerror=');
    expect(container.textContent).toContain('<script>escaped</script> & safe');
    expect(container.textContent).toContain('remote image');
  });
  it('only opens task references verified against the workspace AND conversation project', () => {
    markdown(
      'DEV-1 DEV-2 DEV-3 DEV-999 `DEV-1` [Install](devflow-task:DEV-1) [foreign](devflow-task:DEV-2)',
    );
    expect(container.querySelectorAll('button')).toHaveLength(2);
    click(container.querySelector('button'));
    expect(context.openTask).toHaveBeenCalledWith('t1');
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('code button')).toBeNull();
    expect(container.querySelector('button button')).toBeNull();
    render(h(ChatMarkdown, { content: 'DEV-2 DEV-3', context: { ...context, projectId: null } }));
    expect(container.querySelectorAll('button')).toHaveLength(1);
  });
  it('copies the original assistant response and keeps user messages plain', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(h(AIMessage, { role: 'assistant', content: '**Formatted**' }));
    expect(container.querySelector('strong')).not.toBeNull();
    await act(async () =>
      (container.querySelector('[aria-label="Copy response"]') as HTMLElement).click(),
    );
    expect(writeText).toHaveBeenCalledWith('**Formatted**');
    render(h(AIMessage, { role: 'user', content: '**Plain**' }));
    expect(container.querySelector('strong')).toBeNull();
    expect(container.textContent).toContain('**Plain**');
  });
  it('provides an accessible fallback when clipboard access is denied', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('Permission denied')) },
    });
    render(h(AIMessage, { role: 'assistant', content: 'Select this text' }));
    await act(async () =>
      (container.querySelector('[aria-label="Copy response"]') as HTMLElement).click(),
    );
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Copy unavailable');
    expect(container.textContent).toContain('Select this text');
  });
  it.each(['dark', 'light'])('renders with semantic theme-neutral markup in %s mode', (theme) => {
    document.documentElement.dataset.theme = theme;
    markdown('### Progress\n\n**Done**\n\n```json\n{"done": true}\n```');
    expect(container.querySelector('h3')?.textContent).toBe('Progress');
    expect(container.querySelector('.syntax-string')).not.toBeNull();
    delete document.documentElement.dataset.theme;
  });
});

describe('compact tool activity and friendly labels', () => {
  const event = {
    id: 'e',
    name: 'listTasks',
    input: { scope: 'mine' },
    output: {
      items: [
        {
          id: 't1',
          number: 1,
          title: 'Install Codex',
          status: 'IN_REVIEW',
          priority: 'MEDIUM',
          assigneeId: 'me',
        },
      ],
      total: 1,
      apiKey: 'private-key',
    },
  };
  it('is collapsed by default, expands structured data and keeps redacted diagnostics optional', () => {
    render(h(ToolActivity, { event, context }));
    const details = container.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toBe(
      'Retrieved 1 task assigned to you in DevFlow',
    );
    click(details.querySelector('summary'));
    expect(details.open).toBe(true);
    expect(container.querySelector('td')?.textContent).toContain('DEV-1');
    expect(container.textContent).toContain('In Review');
    expect(container.textContent).toContain('Jemi');
    expect(friendlyField('assigneeId', null, context)).toBe('Unassigned');
    expect(container.textContent).toContain('Medium');
    expect(container.textContent).not.toContain('private-key');
    expect(container.textContent).toContain('[Redacted]');
    expect(container.querySelector('.chat-developer-json')?.hasAttribute('open')).toBe(false);
    click(details.querySelector('summary'));
    expect(details.open).toBe(false);
  });
  it('distinguishes failures and proposals from completed operations', () => {
    render(
      h(ToolActivity, {
        context,
        event: { ...event, name: 'createTask', output: { status: 'awaiting_user_approval' } },
      }),
    );
    expect(container.textContent).toContain('Awaiting your approval');
    expect(container.textContent).not.toContain('Completed');
    render(h(ToolActivity, { context, event: { ...event, output: { error: 'Not found' } } }));
    expect(container.textContent).toContain('Failed');
    expect(container.textContent).toContain('Not found');
  });
  it('formats dates, statuses, project/member identities without changing stored IDs', () => {
    expect(friendlyField('projectId', 'p', context)).toBe('DevFlow');
    expect(friendlyField('assigneeId', 'me', context)).toBe('Jemi');
    expect(friendlyField('status', 'IN_PROGRESS', context)).toBe('In Progress');
    expect(friendlyDate('2026-11-13T00:00:00Z', 'en-US')).toBe('Nov 13, 2026');
    expect(friendlyField('taskId', 't2', context)).toBe('Unavailable task');
    expect(redactDiagnostics({ nested: { authorization: 'secret', result: 'ok' } })).toEqual({
      nested: { authorization: '[Redacted]', result: 'ok' },
    });
  });
});

it('auto-scroll follows new messages but respects reading older messages', () => {
  let scroll: ReturnType<typeof useChatScroll>;
  function View({ revision }: { revision: string }) {
    scroll = useChatScroll('conversation', revision);
    return h(
      'div',
      { ref: scroll.ref, onScroll: scroll.onScroll },
      h('button', { onClick: scroll.latest }, 'Latest'),
    );
  }
  render(h(View, { revision: '1' }));
  const div = container.firstElementChild as HTMLDivElement;
  Object.defineProperties(div, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 300 },
  });
  render(h(View, { revision: '2' }));
  expect(div.scrollTop).toBe(1000);
  div.scrollTop = 100;
  act(() => div.dispatchEvent(new Event('scroll')));
  render(h(View, { revision: '3' }));
  expect(div.scrollTop).toBe(100);
  expect(scroll!.showLatest).toBe(true);
  click(div.querySelector('button'));
  expect(div.scrollTop).toBe(1000);
  expect(scroll!.showLatest).toBe(false);
});

it('separates empty assigned results from related project work and displays actual due dates', () => {
  render(
    h(ToolActivity, {
      context,
      event: {
        id: 'context',
        name: 'listTasks',
        input: { scope: 'mine', includeProjectContext: true },
        output: {
          items: [],
          total: 0,
          scope: { kind: 'mine' },
          projectContext: {
            projectName: 'DevFlow',
            total: 3,
            unassignedTotal: 3,
            items: [
              {
                number: 1,
                title: 'Install Codex',
                assigneeId: null,
                status: 'IN_REVIEW',
                priority: 'MEDIUM',
                dueDate: '2026-11-13T00:00:00Z',
              },
            ],
          },
        },
      },
    }),
  );
  expect(container.querySelector('details')?.open).toBe(false);
  expect(container.querySelector('.agent-project-context')?.textContent).toContain(
    'Assigned query: 0 matches',
  );
  expect(container.querySelector('.agent-project-context')?.textContent).toContain(
    '3 tasks; 3 unassigned',
  );
  expect(container.querySelector('.agent-project-context')?.textContent).toContain(
    'not tasks assigned to you',
  );
  const related = container.querySelector('[aria-label="Related project tasks"]')!;
  expect(related.textContent).toContain('DEV-1');
  expect(related.textContent).toContain('Unassigned');
  expect(related.textContent).toContain('2026');
  click(related.querySelector('button'));
  expect(context.openTask).toHaveBeenCalledWith('t1');
});
it('separates identity text from response copy controls in the DOM', () => {
  render(h(AIMessage, { role: 'assistant', content: 'Answer' }));
  expect(container.querySelector('.chat-message-heading')?.textContent).toMatch(
    /DevFlow\s+Copy response/,
  );
});

it('resizes the composer for multiline input and caps it before enabling its own text scroll', async () => {
  const { resizeComposer } = await import('../src/components/chat/use-composer-size');
  const input = document.createElement('textarea');
  Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 40 });
  resizeComposer(input);
  expect(input.style.height).toBe('40px');
  expect(input.style.overflowY).toBe('hidden');
  Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 84 });
  resizeComposer(input);
  expect(input.style.height).toBe('84px');
  Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 300 });
  resizeComposer(input);
  expect(input.style.height).toBe('144px');
  expect(input.style.overflowY).toBe('auto');
  Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 40 });
  resizeComposer(input);
  expect(input.style.height).toBe('40px');
  Object.defineProperties(input, {
    offsetHeight: { value: 40 },
    clientHeight: { value: 38 },
    scrollHeight: { value: 58 },
  });
  resizeComposer(input);
  expect(input.style.height).toBe('60px');
});
it('does not imply failed-run tool previews have been saved for approval', () => {
  render(
    h(ToolActivity, {
      context,
      runFailed: true,
      event: {
        id: 'draft',
        name: 'updateTask',
        input: {},
        output: { status: 'awaiting_user_approval' },
      },
    }),
  );
  expect(container.textContent).toContain('not saved for approval');
  expect(container.textContent).not.toContain('shown separately above');
  expect(container.querySelector('button[aria-label*="Approve"]')).toBeNull();
});
