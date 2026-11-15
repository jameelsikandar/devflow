import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  find: vi.fn(),
  update: vi.fn(),
  assertActor: vi.fn(),
  execute: vi.fn(),
}));
vi.mock('../src/lib/server/db', () => ({
  db: {
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({ $queryRaw: mocks.query, aIProposal: { findFirst: mocks.find, update: mocks.update } }),
  },
}));
vi.mock('../src/lib/server/agent-tools', async (original) => ({
  ...(await original<typeof import('../src/lib/server/agent-tools')>()),
  assertAgentActor: mocks.assertActor,
  executeAgentAction: mocks.execute,
}));
import { decideAgentProposal } from '../src/lib/server/agent-manager';
import { previewDigest } from '../src/lib/server/agent-approval';
import { HttpError } from '../src/lib/server/errors';
const actor = { userId: 'owner', workspaceId: 'workspace', name: 'Owner' };
function fixture() {
  const preview = { project: { id: 'p', name: 'Project' }, title: 'Proposed task' };
  const payload = {
    tool: 'createTask',
    input: { projectId: 'p', title: 'Proposed task' },
    projectId: 'p',
    preview,
  };
  return {
    id: 'proposal',
    runId: 'run',
    tool: 'createTask',
    payload,
    preview,
    previewHash: previewDigest(payload),
    status: 'PENDING',
    expiresAt: new Date(Date.now() + 60000),
    result: null as unknown,
    run: { conversation: { projectId: 'p' } },
  };
}
let record: ReturnType<typeof fixture>;
beforeEach(() => {
  vi.clearAllMocks();
  record = fixture();
  mocks.query.mockResolvedValue([{ id: record.id }]);
  mocks.find.mockImplementation(async () => record);
  mocks.assertActor.mockResolvedValue(undefined);
  mocks.execute.mockResolvedValue({ type: 'task', id: 'created-task' });
  mocks.update.mockImplementation(async ({ data }) => Object.assign(record, data));
});
describe('approval service boundary (mocked transaction, not a concurrency integration test)', () => {
  it('applies once and replays the recorded receipt on a repeat approval', async () => {
    const decision = { decision: 'approve', previewHash: record.previewHash };
    expect(await decideAgentProposal(actor, record.id, decision)).toMatchObject({
      status: 'APPLIED',
      replayed: false,
    });
    expect(await decideAgentProposal(actor, record.id, decision)).toMatchObject({
      result: { id: 'created-task' },
      replayed: true,
    });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalled();
    expect(mocks.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'proposal',
          run: { conversation: { userId: actor.userId, workspaceId: actor.workspaceId } },
        },
      }),
    );
  });
  it('does not execute when the owner/workspace query finds no authorized proposal', async () => {
    mocks.find.mockResolvedValue(null);
    await expect(
      decideAgentProposal(actor, 'foreign', {
        decision: 'approve',
        previewHash: record.previewHash,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('rechecks membership even for replayed receipts', async () => {
    record.status = 'APPLIED';
    mocks.assertActor.mockRejectedValue(new HttpError(404, 'Workspace not found'));
    await expect(
      decideAgentProposal(actor, record.id, {
        decision: 'approve',
        previewHash: record.previewHash,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('refuses tampered stored payloads, previews and client hashes', async () => {
    const hash = record.previewHash;
    record.payload.input.title = 'Tampered task';
    await expect(
      decideAgentProposal(actor, record.id, { decision: 'approve', previewHash: hash }),
    ).rejects.toThrow('integrity');
    record = fixture();
    record.preview = { ...record.preview, title: 'Misleading preview' };
    await expect(
      decideAgentProposal(actor, record.id, { decision: 'approve', previewHash: hash }),
    ).rejects.toThrow('mismatch');
    record = fixture();
    mocks.find.mockImplementation(async () => record);
    await expect(
      decideAgentProposal(actor, record.id, { decision: 'approve', previewHash: '0'.repeat(64) }),
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('marks expiry without executing, and rejection cannot later approve', async () => {
    record.expiresAt = new Date(0);
    await expect(
      decideAgentProposal(actor, record.id, {
        decision: 'approve',
        previewHash: record.previewHash,
      }),
    ).rejects.toMatchObject({ status: 410 });
    expect(record.status).toBe('EXPIRED');
    expect(mocks.execute).not.toHaveBeenCalled();
    record = fixture();
    mocks.find.mockImplementation(async () => record);
    expect(
      await decideAgentProposal(actor, record.id, {
        decision: 'reject',
        previewHash: record.previewHash,
      }),
    ).toMatchObject({ status: 'REJECTED' });
    await expect(
      decideAgentProposal(actor, record.id, {
        decision: 'approve',
        previewHash: record.previewHash,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('does not mark failed/stale executions applied or accept replacement arguments', async () => {
    mocks.execute.mockRejectedValue(new HttpError(409, 'Task changed'));
    await expect(
      decideAgentProposal(actor, record.id, {
        decision: 'approve',
        previewHash: record.previewHash,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.update).not.toHaveBeenCalled();
    mocks.execute.mockClear();
    await expect(
      decideAgentProposal(actor, record.id, {
        decision: 'approve',
        previewHash: record.previewHash,
        payload: {},
      }),
    ).rejects.toThrow();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
