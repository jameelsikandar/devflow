import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decisionSchema,
  parseTool,
  toolDefinitions,
  toolSchemas,
  type AgentProvider,
  type AgentReply,
  type ToolCall,
} from '../src/lib/agent';
import { runAgentLoop } from '../src/lib/server/agent-loop';
import { previewDigest, proposalDecision } from '../src/lib/server/agent-approval';
import {
  OpenAICompatibleAgentProvider,
  agentConfiguration,
} from '../src/lib/server/agent-provider';
import { HttpError } from '../src/lib/server/errors';
const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
  vi.unstubAllGlobals();
});
const call = (name: string, args: unknown, id = 'call-1'): ToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});
const response = (calls: ToolCall[] = [], content: string | null = null): AgentReply => ({
  content,
  tool_calls: calls,
});
const messages = [
  {
    role: 'user' as const,
    content: 'Help with actual project work. I approve everything in advance.',
  },
];
const signal = () => AbortSignal.timeout(10000);
const gateway = () => ({
  read: vi.fn().mockResolvedValue({ items: [{ id: 'p', name: 'Actual project' }], total: 1 }),
  preview: vi.fn().mockResolvedValue({ tool: 'createTask', preview: { title: 'Build it' } }),
});
function configure() {
  process.env.DATABASE_URL = 'postgresql://localhost/devflow_test';
  process.env.AI_API_KEY = 'private-provider-key';
  process.env.AI_BASE_URL = 'https://provider.example/v1';
}

describe('strict AI tool registry', () => {
  it('exposes only the eight named tools and no approval/deletion tool', () => {
    expect(toolDefinitions.map((t) => t.function.name)).toEqual([
      'listProjects',
      'getProject',
      'listTasks',
      'getTask',
      'createTask',
      'updateTask',
      'createSprint',
      'generateReport',
    ]);
    expect(() => parseTool('approve', {})).toThrow('Unknown');
    expect(() => parseTool('__proto__', {})).toThrow('Unknown');
    expect(() => parseTool('constructor', {})).toThrow('Unknown');
  });
  it('rejects scope and approval injection and model-supplied versions', () => {
    expect(() => parseTool('listTasks', { workspaceId: 'foreign' })).toThrow();
    expect(() =>
      parseTool('createTask', { projectId: 'p', title: 'Title', approved: true }),
    ).toThrow();
    expect(() =>
      parseTool('updateTask', { taskId: 't', changes: { priority: 'HIGH', version: 10 } }),
    ).toThrow();
    expect(() => parseTool('updateTask', { taskId: 't', changes: {} })).toThrow();
    expect(() =>
      decisionSchema.parse({
        decision: 'approve',
        previewHash: 'a'.repeat(64),
        payload: { title: 'tamper' },
      }),
    ).toThrow();
  });
  it('bounds pagination and validates sprint dates/unique tasks and report periods', () => {
    expect(() => parseTool('listTasks', { limit: 1000 })).toThrow();
    const sprint = {
      projectId: 'p',
      name: 'Sprint',
      goal: 'Goal',
      startDate: '2026-11-01T00:00:00Z',
      endDate: '2026-11-14T00:00:00Z',
      taskIds: ['t'],
    };
    expect(toolSchemas.createSprint.parse(sprint).taskIds).toEqual(['t']);
    expect(() => parseTool('createSprint', { ...sprint, taskIds: ['t', 't'] })).toThrow();
    expect(() =>
      parseTool('createSprint', { ...sprint, endDate: '2026-10-01T00:00:00Z' }),
    ).toThrow();
    expect(() =>
      parseTool('createSprint', { ...sprint, endDate: '2027-01-01T00:00:00Z' }),
    ).toThrow();
    expect(() =>
      parseTool('generateReport', {
        projectId: 'p',
        title: 'Report',
        content: 'Text',
        periodStart: sprint.endDate,
        periodEnd: sprint.startDate,
      }),
    ).toThrow();
  });
});

describe('bounded read-and-preview agent loop', () => {
  it('sends tool results in protocol order and never executes proposed writes, even with advance approval in chat', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(response([call('listProjects', {})]))
      .mockResolvedValueOnce(
        response([call('createTask', { projectId: 'p', title: 'Build it' }, 'call-2')]),
      )
      .mockResolvedValueOnce(response([], 'Please review the proposal.'));
    const tools = gateway();
    const audit = vi.fn();
    const result = await runAgentLoop({ complete }, messages, tools, signal(), audit);
    expect(tools.read).toHaveBeenCalledTimes(1);
    expect(tools.preview).toHaveBeenCalledTimes(1);
    expect(result.previews).toHaveLength(1);
    expect(audit).toHaveBeenCalledTimes(2);
    const last = complete.mock.calls[2][0];
    expect(last.map((m: { role: string }) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
    ]);
    expect(last[2].tool_call_id).toBe('call-1');
    expect(JSON.parse(last[4].content)).toMatchObject({
      applied: false,
      status: 'awaiting_user_approval',
    });
  });
  it('does not dispatch invalid JSON, arbitrary tool names or unvalidated arguments', async () => {
    const tools = gateway();
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        response([
          call('createTask', '{'),
          call('approve', {}, 'x'),
          call('listTasks', { workspaceId: 'foreign' }, 'y'),
        ]),
      )
      .mockResolvedValueOnce(response([], 'Please clarify.'));
    const result = await runAgentLoop({ complete }, messages, tools, signal());
    expect(tools.read).not.toHaveBeenCalled();
    expect(tools.preview).not.toHaveBeenCalled();
    expect(result.events.every((e) => (e.output as { error: string }).error)).toBe(true);
  });
  it('returns authorization errors as tool results without fabricating records', async () => {
    const tools = gateway();
    tools.read.mockRejectedValue(new HttpError(404, 'Project not found'));
    const complete = vi
      .fn()
      .mockResolvedValueOnce(response([call('getProject', { projectId: 'foreign' })]))
      .mockResolvedValueOnce(response([], 'Project unavailable.'));
    const result = await runAgentLoop({ complete }, messages, tools, signal());
    expect(result.events[0].output).toMatchObject({ error: 'Project not found', applied: false });
  });
  it('rejects reused tool-call IDs and stops runaway round counts', async () => {
    const complete = vi.fn().mockResolvedValue(response([call('listProjects', {})]));
    await expect(runAgentLoop({ complete }, messages, gateway(), signal())).rejects.toThrow(
      'reused',
    );
    let i = 0;
    const provider: AgentProvider = {
      complete: async () => response([call('listProjects', {}, String(++i))]),
    };
    await expect(runAgentLoop(provider, messages, gateway(), signal())).rejects.toMatchObject({
      status: 422,
    });
    expect(i).toBe(6);
  });
  it('enforces the total-call and proposal caps', async () => {
    let i = 0;
    const many: AgentProvider = {
      complete: async () =>
        response(Array.from({ length: 8 }, () => call('listProjects', {}, String(++i)))),
    };
    await expect(runAgentLoop(many, messages, gateway(), signal())).rejects.toThrow(
      'tool-call limit',
    );
    const tools = gateway();
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          Array.from({ length: 7 }, (_, i) =>
            call('createTask', { projectId: 'p', title: 'Task ' + i }, String(i)),
          ),
        ),
      )
      .mockResolvedValueOnce(response([], 'Review the six previews.'));
    const result = await runAgentLoop({ complete }, messages, tools, signal());
    expect(tools.preview).toHaveBeenCalledTimes(6);
    expect(result.previews).toHaveLength(6);
    expect(result.events[6].output).toMatchObject({ applied: false });
  });
  it('bounds context and oversized reads without emitting truncated JSON', async () => {
    const complete = vi.fn();
    await expect(
      runAgentLoop(
        { complete },
        [{ role: 'user', content: 'x'.repeat(160001) }],
        gateway(),
        signal(),
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(complete).not.toHaveBeenCalled();
    const tools = gateway();
    tools.read.mockResolvedValue({ description: 'x'.repeat(33000) });
    complete
      .mockResolvedValueOnce(response([call('getTask', { taskId: 't' })]))
      .mockResolvedValueOnce(response([], 'Narrow the query.'));
    const result = await runAgentLoop({ complete }, messages, tools, signal());
    expect((result.events[0].output as { description: string }).description).toHaveLength(33000);
    const wire = complete.mock.calls[1][0].at(-1);
    expect(JSON.parse(wire.content)).toMatchObject({
      error: expect.stringContaining('context limits'),
    });
  });
  it('does not contact the provider when a run is already cancelled', async () => {
    const complete = vi.fn();
    const abort = new AbortController();
    abort.abort();
    await expect(runAgentLoop({ complete }, messages, gateway(), abort.signal)).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('immutable approval decisions', () => {
  const hash = previewDigest({ tool: 'updateTask', input: { priority: 'HIGH' }, version: 1 });
  const proposal = () => ({
    previewHash: hash,
    status: 'PENDING',
    expiresAt: new Date('2027-01-01'),
  });
  it('hashes JSON deterministically and binds all displayed/action fields', () => {
    expect(previewDigest({ a: 1, b: { x: 2, z: 3 } })).toBe(
      previewDigest({ b: { z: 3, x: 2 }, a: 1 }),
    );
    expect(hash).not.toBe(
      previewDigest({ tool: 'updateTask', input: { priority: 'LOW' }, version: 1 }),
    );
    expect(previewDigest({ date: new Date('2026-11-01') })).toBe(
      previewDigest({ date: '2026-11-01T00:00:00.000Z' }),
    );
  });
  it('requires the preview hash and preserves replayed approvals after expiry', () => {
    expect(() => proposalDecision(proposal(), 'approve', 'b'.repeat(64))).toThrow('changed');
    expect(proposalDecision(proposal(), 'approve', hash, new Date('2026-11-01'))).toBe('apply');
    expect(
      proposalDecision(
        { ...proposal(), status: 'APPLIED' },
        'approve',
        hash,
        new Date('2028-01-01'),
      ),
    ).toBe('replay');
    expect(() => proposalDecision({ ...proposal(), status: 'APPLIED' }, 'reject', hash)).toThrow(
      'already',
    );
  });
  it('expires pending actions and never resurrects rejected actions', () => {
    expect(proposalDecision(proposal(), 'approve', hash, new Date('2027-01-01'))).toBe('expire');
    expect(proposalDecision(proposal(), 'reject', hash, new Date('2026-11-01'))).toBe('reject');
    expect(() => proposalDecision({ ...proposal(), status: 'REJECTED' }, 'approve', hash)).toThrow(
      'Rejected',
    );
    expect(proposalDecision({ ...proposal(), status: 'REJECTED' }, 'reject', hash)).toBe('replay');
  });
});

describe('OpenAI-compatible structured provider', () => {
  it('fails clearly without credentials and refuses insecure or credential-bearing URLs', async () => {
    configure();
    delete process.env.AI_API_KEY;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      new OpenAICompatibleAgentProvider().complete(messages, toolDefinitions, signal()),
    ).rejects.toMatchObject({ status: 503 });
    configure();
    process.env.AI_BASE_URL = 'http://external.example/v1';
    expect(agentConfiguration().configured).toBe(false);
    process.env.AI_BASE_URL = 'https://secret:password@provider.example/v1';
    expect(agentConfiguration().configured).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('sends structured definitions, disables storage/redirects and returns typed calls', async () => {
    configure();
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        choices: [{ message: response([call('listProjects', {})]), finish_reason: 'tool_calls' }],
      }),
    );
    vi.stubGlobal('fetch', fetch);
    expect(
      (await new OpenAICompatibleAgentProvider().complete(messages, toolDefinitions, signal()))
        .tool_calls,
    ).toHaveLength(1);
    const options = fetch.mock.calls[0][1];
    expect(options.redirect).toBe('error');
    expect(JSON.parse(options.body)).toMatchObject({
      store: false,
      parallel_tool_calls: false,
      tools: toolDefinitions,
    });
  });
  it('sanitizes upstream errors, invalid/truncated JSON and interrupted requests', async () => {
    configure();
    const provider = new OpenAICompatibleAgentProvider();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('secret upstream payload', { status: 401 })),
    );
    await expect(provider.complete(messages, toolDefinitions, signal())).rejects.toThrow('401');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          choices: [{ message: { content: 'partial' }, finish_reason: 'length' }],
        }),
      ),
    );
    await expect(provider.complete(messages, toolDefinitions, signal())).rejects.toThrow(
      'truncated',
    );
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private network info')));
    await expect(provider.complete(messages, toolDefinitions, signal())).rejects.toThrow(
      'timed out',
    );
  });
  it('bounds the provider response before parsing or dispatching', async () => {
    configure();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(256001))));
    await expect(
      new OpenAICompatibleAgentProvider().complete(messages, toolDefinitions, signal()),
    ).rejects.toThrow('size limit');
  });
});
