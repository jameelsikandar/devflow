import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  parseRetryAfter,
  retryDeadline,
  ProviderRateLimitError,
} from '../src/lib/server/provider-rate-limit';
import { OpenAICompatibleAgentProvider } from '../src/lib/server/agent-provider';
import { modelToolResult } from '../src/lib/server/agent-model-results';
import { toolDefinitions } from '../src/lib/agent';
import { errorResponse } from '../src/lib/server/http';
import { providerFailure } from '../src/lib/provider-failure';
const original = { ...process.env };
const now = Date.parse('2026-11-13T12:00:00Z');
let sequence = 0;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  process.env.DATABASE_URL = 'postgresql://localhost/devflow_test';
  process.env.AI_API_KEY = `isolated-fake-provider-key-${++sequence}`;
  process.env.AI_BASE_URL = 'https://api.groq.com/openai/v1';
  process.env.AI_MODEL = 'openai/gpt-oss-120b';
});
afterEach(() => {
  process.env = { ...original };
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it.each([
  ['2', 2000],
  ['1.5', 1500],
  ['0', 0],
  ['Fri, 13 Nov 2026 12:01:00 GMT', 60000],
  ['Fri, 13 Nov 2026 11:00:00 GMT', 0],
] as const)('parses Retry-After %s without guessing', (input, ms) => {
  expect(parseRetryAfter(input, now)).toBe(now + ms);
});
it.each(['', '-2', 'tomorrow', 'Infinity', '1e400'])(
  'rejects unsupported Retry-After %s',
  (input) => {
    expect(parseRetryAfter(input, now)).toBeNull();
  },
);
it('uses exhausted Groq reset headers only and honors explicit Retry-After first', () => {
  const headers = new Headers({
    'x-ratelimit-remaining-tokens': '0',
    'x-ratelimit-reset-tokens': '1m2.5s',
    'x-ratelimit-remaining-requests': '0',
    'x-ratelimit-reset-requests': '2m',
  });
  expect(retryDeadline(headers, now)).toBe(now + 120000);
  headers.set('retry-after', '7');
  expect(retryDeadline(headers, now)).toBe(now + 7000);
  expect(
    retryDeadline(
      new Headers({ 'x-ratelimit-remaining-tokens': '20', 'x-ratelimit-reset-tokens': '5s' }),
      now,
    ),
  ).toBeNull();
});
it('surfaces 429 safely, performs no automatic retry and blocks calls during an advertised cooldown', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response('private upstream dump', {
        status: 429,
        headers: { 'retry-after': '10', 'x-secret': 'hidden' },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ choices: [{ message: { content: 'Done', tool_calls: [] } }] }),
    );
  vi.stubGlobal('fetch', fetch);
  const complete = () =>
    new OpenAICompatibleAgentProvider().complete(
      [{ role: 'user', content: 'Tasks?' }],
      toolDefinitions,
      AbortSignal.timeout(10000),
    );
  let failure: unknown;
  try {
    await complete();
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ status: 429, retryAt: now + 10000 });
  expect(String(failure)).not.toContain('compatibility');
  expect(String(failure)).not.toContain('private');
  expect(fetch).toHaveBeenCalledTimes(1);
  await expect(complete()).rejects.toMatchObject({ status: 429 });
  expect(fetch).toHaveBeenCalledTimes(1);
  vi.setSystemTime(now + 10001);
  expect(await complete()).toMatchObject({ content: 'Done' });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('does not invent a retry delay when 429 has no valid timing headers', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 429 }));
  vi.stubGlobal('fetch', fetch);
  await expect(
    new OpenAICompatibleAgentProvider().complete([], toolDefinitions, AbortSignal.timeout(10000)),
  ).rejects.toMatchObject({ status: 429, retryAt: null });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('returns safe Retry-After to HTTP clients and recognizes the persisted error after refresh', async () => {
  const error = new ProviderRateLimitError('Groq', now + 12000);
  const response = errorResponse(error);
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('12');
  expect(await response.json()).toEqual({ error: error.message });
  expect(providerFailure(error.message)).toEqual({ provider: 'Groq', retryAt: now + 12000 });
  expect(providerFailure('other failure')).toBeNull();
});
const row = {
  id: 'cm-real-task',
  number: 3,
  projectId: 'project',
  title: 'Actual task',
  status: 'IN_REVIEW',
  priority: 'MEDIUM',
  assigneeId: null,
  startDate: null,
  dueDate: '2026-11-15T00:00:00Z',
  isMilestone: false,
  parentTaskId: null,
  version: 9,
  createdAt: '2026-11-13T00:00:00Z',
  completedAt: null,
  project: { name: 'DevFlow' },
  assignee: null,
  reference: 'DEV-3',
  statusLabel: 'In Review',
  priorityLabel: 'Medium',
  assigneeName: 'Unassigned',
  projectName: 'DevFlow',
};
it('compacts model task results while retaining internal IDs and full audit records separately', () => {
  const full = {
    items: [row, { ...row, id: 'second', number: 4, reference: 'DEV-4' }],
    total: 4,
    offset: 0,
    limit: 2,
    hasMore: true,
    nextOffset: 2,
    context: {
      authenticatedUserId: 'actor',
      createdBySupported: false,
      archivedProjectsExcluded: true,
    },
    scope: { kind: 'all', projectId: 'project' },
  };
  const before = JSON.stringify(full);
  const compact = modelToolResult('listTasks', full);
  expect(compact).toMatchObject({
    items: [
      {
        id: row.id,
        reference: 'DEV-3',
        status: 'In Review',
        assignee: 'Unassigned',
        dueDate: row.dueDate,
      },
      { id: 'second' },
    ],
    projects: { project: 'DevFlow' },
    total: 4,
    nextOffset: 2,
  });
  expect(JSON.stringify(compact).length).toBeLessThan(before.length * 0.65);
  expect(JSON.stringify(full)).toBe(before);
  expect(JSON.stringify(compact)).not.toContain('createdAt');
  expect(JSON.stringify(compact)).not.toContain('statusLabel');
});
it('keeps empty personal and bounded project records distinct without duplicating task rows', () => {
  const result = modelToolResult('listTasks', {
    items: [],
    total: 0,
    scope: { kind: 'mine' },
    projectContext: { items: [row], total: 3, unassignedTotal: 3, projectName: 'DevFlow' },
  });
  expect(result).toMatchObject({
    items: [],
    total: 0,
    projectContext: { items: [{ reference: 'DEV-3' }], total: 3, unassignedTotal: 3 },
  });
  expect(JSON.stringify(result).match(/Actual task/g)).toHaveLength(1);
});
it('never replaces full proposal input/version/before-after records with the compact model acknowledgement', () => {
  const full = {
    status: 'awaiting_user_approval',
    applied: false,
    preview: {
      tool: 'updateTask',
      version: 8,
      input: { changes: { description: 'x'.repeat(2000) } },
      preview: {
        task: { id: row.id, number: 3 },
        before: { description: 'old' },
        changes: { description: 'x'.repeat(2000) },
      },
    },
  };
  const before = JSON.stringify(full);
  expect(modelToolResult('updateTask', full)).toMatchObject({
    status: 'awaiting_user_approval',
    applied: false,
    changedFields: ['description'],
  });
  expect(JSON.stringify(modelToolResult('updateTask', full)).length).toBeLessThan(500);
  expect(JSON.stringify(full)).toBe(before);
});
it('corrects the legacy misleading 429 display without rewriting history or inventing a delay', async () => {
  const { providerErrorMessage } = await import('../src/lib/provider-failure');
  const original = 'AI provider returned 429. Verify model and tool-calling compatibility.';
  expect(providerErrorMessage(original)).toContain('No retry delay was recorded');
  expect(providerErrorMessage(original)).not.toContain('compatibility');
  expect(providerFailure(original)).toBeNull();
});
it('logs only aggregate request/usage and numeric rate information when explicitly enabled', async () => {
  process.env.AI_DIAGNOSTICS = '1';
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json(
        {
          choices: [{ message: { content: 'Private answer', tool_calls: [] } }],
          usage: {
            prompt_tokens: 123,
            completion_tokens: 45,
            total_tokens: 168,
            private_detail: 'not logged',
          },
        },
        {
          headers: {
            'x-ratelimit-remaining-tokens': '900',
            'x-ratelimit-limit-requests': '1000',
            authorization: 'secret-header',
          },
        },
      ),
    ),
  );
  try {
    await new OpenAICompatibleAgentProvider().complete(
      [{ role: 'user', content: 'private-prompt-do-not-log' }],
      toolDefinitions,
      AbortSignal.timeout(10000),
    );
    const serialized = JSON.stringify(log.mock.calls);
    expect(serialized).toContain('promptTokens');
    expect(serialized).toContain('123');
    expect(serialized).toContain('900');
    expect(serialized).not.toContain('private-prompt');
    expect(serialized).not.toContain('secret-header');
    expect(serialized).not.toContain('isolated-fake-provider-key');
    expect(serialized).not.toContain('Private answer');
  } finally {
    log.mockRestore();
  }
});
