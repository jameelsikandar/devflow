import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  conversation: { findFirst: vi.fn(), update: vi.fn() },
  project: { findMany: vi.fn(), count: vi.fn() },
  workspaceMember: { findUnique: vi.fn() },
  run: {
    findUnique: vi.fn(),
    count: vi.fn(),
    updateMany: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    findUniqueOrThrow: vi.fn(),
  },
  proposal: { create: vi.fn() },
  event: { create: vi.fn() },
  read: vi.fn(),
  prepare: vi.fn(),
  execute: vi.fn(),
}));
vi.mock('../src/lib/server/db', () => {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    aIConversation: state.conversation,
    project: state.project,
    workspaceMember: state.workspaceMember,
    aIRun: state.run,
    aIProposal: state.proposal,
    aIToolEvent: state.event,
  };
  return { db: { ...tx, $transaction: async (fn: (tx: unknown) => unknown) => fn(tx) } };
});
vi.mock('../src/lib/server/agent-tools', async (original) => ({
  ...(await original<typeof import('../src/lib/server/agent-tools')>()),
  assertAgentActor: vi.fn().mockResolvedValue(undefined),
  readAgentTool: state.read,
  prepareAgentAction: state.prepare,
  executeAgentAction: state.execute,
}));
import { sendAgentTurn } from '../src/lib/server/agent-manager';
const actor = { userId: 'owner', workspaceId: 'w', name: 'Owner' };
const input = { requestId: 'ea99be41-37bc-4cad-9ff8-f863b333f03c', prompt: 'Plan some work' };
beforeEach(() => {
  vi.resetAllMocks();
  state.project.findMany.mockResolvedValue([{ id: 'p', name: 'DevFlow' }]);
  state.project.count.mockResolvedValue(1);
  state.workspaceMember.findUnique.mockResolvedValue({});
  state.conversation.findFirst.mockResolvedValue({
    id: 'c',
    userId: actor.userId,
    workspaceId: actor.workspaceId,
    projectId: 'p',
    workspace: { id: 'w', name: 'Workspace' },
    project: { id: 'p', name: 'DevFlow', archivedAt: null },
  });
  state.run.findUnique.mockResolvedValue(null);
  state.run.count.mockResolvedValue(0);
  state.run.findMany.mockResolvedValue([]);
  state.run.create.mockResolvedValue({ id: 'new-run' });
  state.run.findFirst.mockResolvedValue({ id: 'new-run', status: 'RUNNING' });
  state.run.findUniqueOrThrow.mockResolvedValue({ id: 'new-run', status: 'COMPLETED' });
  state.read.mockResolvedValue({ items: [], total: 0 });
  state.prepare.mockResolvedValue({
    tool: 'createTask',
    input: { projectId: 'p', title: 'Proposed' },
    projectId: 'p',
    preview: { project: { id: 'p', name: 'Project' }, title: 'Proposed' },
  });
});
describe('AI run state machine (mocked persistence)', () => {
  it('replays a completed request without a provider call or new run', async () => {
    state.run.findUnique.mockResolvedValue({
      id: 'old-run',
      prompt: input.prompt,
      status: 'COMPLETED',
    });
    const complete = vi.fn();
    expect(await sendAgentTurn(actor, 'c', input, { complete })).toMatchObject({ id: 'old-run' });
    expect(complete).not.toHaveBeenCalled();
    expect(state.run.create).not.toHaveBeenCalled();
  });
  it('rejects reused IDs with different prompts and overlapping active turns', async () => {
    const complete = vi.fn();
    state.run.findUnique.mockResolvedValue({ prompt: 'different prompt', status: 'COMPLETED' });
    await expect(sendAgentTurn(actor, 'c', input, { complete })).rejects.toMatchObject({
      status: 409,
    });
    state.run.findUnique.mockResolvedValue(null);
    state.run.count.mockResolvedValue(1);
    await expect(sendAgentTurn(actor, 'c', input, { complete })).rejects.toMatchObject({
      status: 409,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(state.run.create).not.toHaveBeenCalled();
  });
  it('cannot save a late result after the active-run fence fails', async () => {
    state.run.findFirst.mockResolvedValue(null);
    const complete = vi.fn().mockResolvedValue({ content: 'Late result', tool_calls: [] });
    await expect(sendAgentTurn(actor, 'c', input, { complete })).rejects.toMatchObject({
      status: 409,
    });
    expect(state.proposal.create).not.toHaveBeenCalled();
    expect(state.run.update).not.toHaveBeenCalled();
  });
  it('persists a pending preview and an audit event without executing it', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce({
        content: null,
        tool_calls: [
          {
            id: 'write',
            type: 'function',
            function: {
              name: 'createTask',
              arguments: JSON.stringify({ projectId: 'p', title: 'Proposed' }),
            },
          },
        ],
      })
      .mockResolvedValueOnce({ content: 'Please review.', tool_calls: [] });
    await sendAgentTurn(actor, 'c', input, { complete });
    expect(state.event.create).toHaveBeenCalledTimes(1);
    expect(state.proposal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tool: 'createTask',
          previewHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          expiresAt: expect.any(Date),
        }),
      }),
    );
    expect(state.execute).not.toHaveBeenCalled();
  });
  it('preserves completed read events when a later provider step fails and sanitizes the error', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce({
        content: null,
        tool_calls: [
          { id: 'read', type: 'function', function: { name: 'listProjects', arguments: '{}' } },
        ],
      })
      .mockRejectedValueOnce(new Error('private upstream credential dump'));
    await expect(sendAgentTurn(actor, 'c', input, { complete })).rejects.toThrow(
      'No proposed changes were applied',
    );
    expect(state.event.create).toHaveBeenCalledTimes(1);
    expect(state.proposal.create).not.toHaveBeenCalled();
    expect(state.run.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: 'new-run', status: 'RUNNING' },
        data: expect.objectContaining({
          status: 'FAILED',
          error: expect.not.stringContaining('private upstream'),
        }),
      }),
    );
  });
});

it('instructs the provider to distinguish assigned-to-me queries and render friendly Markdown', async () => {
  const complete = vi.fn().mockResolvedValue({ content: 'No tasks assigned.', tool_calls: [] });
  await sendAgentTurn(
    actor,
    'c',
    { ...input, prompt: 'My tasks? Explain dependencies too.' },
    { complete },
  );
  const system = complete.mock.calls[0][0][0].content;
  expect(system).toContain('GitHub-flavored Markdown');
  expect(system).toContain(JSON.stringify({ id: actor.userId, name: actor.name }));
  expect(system).toContain('listTasks scope=mine');
  expect(system).toContain('All project tasks: scope=all');
  expect(system).toContain('includeProjectContext=true');
  expect(system).toContain('Creator history is unsupported');
  expect(system).toContain('My assigned tasks: listTasks scope=mine across the workspace');
  expect(system).toContain('Workspace');
  expect(system).toContain('DevFlow');
  expect(system).toContain('Approval is an out-of-band user action');
  expect(state.execute).not.toHaveBeenCalled();
});

it('persists successful full tool records when a later provider call is rate limited, without proposals or retries', async () => {
  const { ProviderRateLimitError } = await import('../src/lib/server/provider-rate-limit');
  const record = {
    items: [],
    total: 0,
    scope: { kind: 'mine' },
    projectContext: {
      items: [{ id: 'actual', version: 8, number: 1, title: 'Actual work' }],
      total: 3,
      unassignedTotal: 3,
    },
  };
  state.read.mockResolvedValue(record);
  const complete = vi
    .fn()
    .mockResolvedValueOnce({
      content: null,
      tool_calls: [
        {
          id: 'read',
          type: 'function',
          function: {
            name: 'listTasks',
            arguments: '{"scope":"mine","includeProjectContext":true}',
          },
        },
      ],
    })
    .mockRejectedValueOnce(new ProviderRateLimitError('Groq', Date.now() + 60000));
  await expect(sendAgentTurn(actor, 'c', input, { complete })).rejects.toMatchObject({
    status: 429,
  });
  expect(complete).toHaveBeenCalledTimes(2);
  expect(state.event.create.mock.calls[0][0].data.output).toEqual(record);
  expect(state.proposal.create).not.toHaveBeenCalled();
  expect(state.execute).not.toHaveBeenCalled();
  expect(state.run.updateMany).toHaveBeenLastCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        status: 'FAILED',
        error: expect.stringContaining('Groq is rate limited'),
      }),
    }),
  );
});
it('answers sole-project current tasks without invoking the provider, preserving audit and no proposals', async () => {
  state.conversation.findFirst.mockResolvedValue({
    id: 'c',
    workspaceId: 'w',
    userId: actor.userId,
    projectId: null,
    workspace: { id: 'w', name: 'Workspace' },
    project: null,
  });
  state.read.mockResolvedValue({
    items: [],
    total: 0,
    scope: { kind: 'mine' },
    projectContext: {
      items: [],
      total: 0,
      unassignedTotal: 0,
      projectName: 'DevFlow',
      offset: 0,
      hasMore: false,
    },
  });
  const complete = vi.fn().mockRejectedValue(new Error('Quota must not be needed'));
  await sendAgentTurn(actor, 'c', { ...input, prompt: 'my current tasks' }, { complete });
  expect(complete).not.toHaveBeenCalled();
  expect(state.read).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    expect.objectContaining({ userId: actor.userId, projectId: null }),
    'listTasks',
    expect.objectContaining({
      projectId: 'p',
      scope: 'mine',
      unfinished: true,
      includeProjectContext: true,
    }),
  );
  expect(state.event.create).toHaveBeenCalledTimes(1);
  expect(state.proposal.create).not.toHaveBeenCalled();
  expect(state.execute).not.toHaveBeenCalled();
  expect(state.run.update).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        status: 'COMPLETED',
        answer: expect.stringContaining('no AI-generated narrative'),
      }),
    }),
  );
});
it('supplies the current explicit project selection to the model after a complex prior request', async () => {
  state.conversation.findFirst.mockResolvedValue({
    id: 'c',
    workspaceId: 'w',
    userId: actor.userId,
    projectId: null,
    workspace: { id: 'w', name: 'Workspace' },
    project: null,
  });
  state.run.findMany.mockResolvedValue([
    {
      prompt: 'Plan a sprint and explain risks',
      answer: 'Which project?',
      status: 'COMPLETED',
      proposals: [],
      events: [],
    },
  ]);
  const complete = vi
    .fn()
    .mockResolvedValue({ content: 'Ask for sprint dates next.', tool_calls: [] });
  await sendAgentTurn(actor, 'c', { ...input, prompt: 'project DevFlow' }, { complete });
  expect(complete.mock.calls[0][0][0].content).toContain('"establishedProjectId":"p"');
  expect(state.read).not.toHaveBeenCalled();
  expect(state.execute).not.toHaveBeenCalled();
});
