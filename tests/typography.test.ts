import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Board } from '../src/components/kanban';
import type { Task, Snapshot } from '../src/lib/types';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// Parse real CSS using the already installed Tailwind/PostCSS dependency. These
// tests validate design contracts, not browser layout or complete WCAG conformance.
type Rule = { selector: string; nodes: { prop?: string; value?: string }[] };
type Sheet = { walkRules: (visit: (rule: Rule) => void) => void };
const fromTailwind = createRequire(require.resolve('@tailwindcss/postcss'));
const { parse } = fromTailwind('postcss') as { parse: (css: string) => Sheet };
const cssFiles = [
  'src/app/globals.css',
  'src/components/roadmap.css',
  'src/components/agent-manager.css',
  'src/components/assistant-page.css',
  'src/components/chat/chat.css',
  'src/components/task-github-activity.css',
  'src/components/github-operational-health.css',
  'src/components/github-retention-report.css',
];
const sheets = cssFiles.map((file) => parse(readFileSync(file, 'utf8')));
function declarations(sheet: Sheet, selector: string) {
  const matches: Record<string, string>[] = [];
  sheet.walkRules((rule) => {
    if (rule.selector !== selector) return;
    matches.push(
      Object.fromEntries(rule.nodes.filter((n) => n.prop).map((n) => [n.prop!, n.value!])),
    );
  });
  return matches;
}
const root = declarations(sheets[0], ':root')[0];
const light = { ...root, ...declarations(sheets[0], "[data-theme='light']")[0] };
function luminance(hex: string) {
  const value = hex.slice(1);
  const expanded = value.length === 3 ? [...value].map((c) => c + c).join('') : value;
  if (!/^[a-f\d]{6}$/i.test(expanded)) throw Error('Expected an opaque palette color');
  const rgb = [0, 2, 4].map((i) => parseInt(expanded.slice(i, i + 2), 16) / 255);
  const linear = rgb.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function contrast(a: string, b: string) {
  const [dark, bright] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (bright + 0.05) / (dark + 0.05);
}

describe('readable semantic typography', () => {
  it('uses browser-relative sizes without replacing the font family or root size', () => {
    for (const [name, value] of Object.entries(root))
      if (name.startsWith('--font-size-') && !value.startsWith('var('))
        expect(value).toMatch(/rem$/);
    expect(root['--font-size-body']).toBe('0.9375rem');
    expect(root['--font-size-control']).toBe('0.875rem');
    expect(root['--font-size-task']).toBe('0.9375rem');
    expect(root['--font-size-description']).toBe('0.8125rem');
    expect(root['--font-size-metadata']).toBe('0.75rem');
    const body = declarations(sheets[0], 'body')[0];
    expect(body['font-family']).toContain('Inter');
    expect(body['font-family']).toContain('Segoe UI');
    expect(body['line-height']).toBe('var(--line-height-body)');
    expect(declarations(sheets[0], 'html').some((rule) => rule['font-size'])).toBe(false);
  });

  it('keeps task/navigation/description roles consistent in responsive rules', () => {
    for (const [selector, expected] of [
      ['.nav-item', 'navigation'],
      ['.project-nav .nav-item', 'navigation'],
      ['.sidebar .nav-item', 'navigation'],
      ['.sidebar .project-nav .nav-item', 'navigation'],
      ['.task-card h3', 'task'],
      ['.focus-task-name strong', 'task'],
      ['.project-open h3', 'task'],
      ['.overview-heading p,\n  .page-heading p', 'description'],
    ]) {
      const matches = declarations(sheets[0], selector);
      expect(matches.length).toBeGreaterThan(0);
      for (const match of matches.filter((r) => r['font-size']))
        expect(match['font-size']).toBe(`var(--font-size-${expected})`);
    }
    const chat = sheets[4];
    for (const selector of ['.chat-message', '.chat-markdown'])
      for (const match of declarations(chat, selector))
        expect(match['font-size']).toBe('var(--font-size-body)');
  });

  it('uses scalable font declarations in every audited stylesheet', () => {
    for (const sheet of sheets)
      sheet.walkRules((rule) => {
        for (const node of rule.nodes)
          if (node.prop === 'font-size') expect(node.value, rule.selector).not.toMatch(/\dpx/);
      });
    // Inputs grow on mobile for focus usability, rather than shrinking other UI.
    expect(declarations(sheets[0], ':root').at(-1)?.['--font-size-input']).toBe('1rem');
  });

  it('keeps the roadmap label/row geometry aligned with the existing connector renderer', () => {
    const roadmap = sheets[1];
    expect(declarations(roadmap, '.roadmap-row')[0].height).toBe('54px');
    expect(declarations(roadmap, '.roadmap-task-label')[0].width).toBe('260px');
    expect(declarations(roadmap, '.roadmap-task-label strong')[0]['line-height']).toBe(
      'var(--line-height-compact)',
    );
    expect(declarations(sheets[0], '.task-card h3')[0]['overflow-wrap']).toBe('anywhere');
    expect(declarations(sheets[4], '.chat-table-scroll')[0]['overflow-x']).toBe('auto');
  });
});

describe.each([
  ['dark', root],
  ['light', light],
] as const)('%s palette contrast', (_name, palette) => {
  it('meets 4.5:1 for normal semantic text on all primary UI surfaces', () => {
    for (const foreground of [
      '--text',
      '--secondary',
      '--muted',
      '--accent',
      '--green',
      '--red',
      '--warning',
    ])
      for (const background of [
        '--background',
        '--sidebar',
        '--surface',
        '--surface-raised',
        '--surface-hover',
        '--accent-bg',
      ])
        expect(
          contrast(palette[foreground], palette[background]),
          `${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
  });
  it('keeps primary button normal and hover text readable', () => {
    const foreground = _name === 'dark' ? '#21192f' : '#ffffff';
    expect(contrast(foreground, palette['--accent'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(foreground, palette['--accent-hover'])).toBeGreaterThanOrEqual(4.5);
  });
});

it('keeps a custom-colored Kanban label readable without changing its name or task controls', () => {
  const label = { id: 'label', name: 'Important release', color: '#ffffff' };
  const task = {
    id: 'readability-task',
    number: 42,
    projectId: 'project',
    title: 'Readable task title',
    description: '',
    status: 'TODO',
    priority: 'MEDIUM',
    assignee: null,
    assigneeId: null,
    startDate: null,
    dueDate: null,
    isMilestone: false,
    position: 1,
    version: 0,
    completedAt: null,
    createdAt: '2026-11-18T00:00:00Z',
    updatedAt: '2026-11-18T00:00:00Z',
    labels: [{ label }],
    _count: { comments: 0 },
  } satisfies Task;
  const data = { tasks: [task], members: [], labels: [label] } as unknown as Snapshot;
  const html = renderToStaticMarkup(
    createElement(Board, {
      tasks: [task],
      data,
      openTask: () => {},
      move: () => {},
      pending: false,
      create: () => {},
    }),
  );
  expect(html).toContain('Important release');
  expect(html).toContain('color:var(--text)');
  expect(html).toContain('background:#ffffff13');
  expect(html).toContain('border-inline-start:2px solid #ffffff');
  expect(html).toContain('aria-label="Move Readable task title"');
  expect(html).toContain('Readable task title');
});
