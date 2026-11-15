import { createHmac, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  account: vi.fn(),
  github: vi.fn(),
  connection: vi.fn(),
}));
vi.mock('../src/lib/server/db', () => ({
  db: {
    $transaction: mocks.transaction,
    gitHubConnection: { findUnique: mocks.account },
    gitHubRepositoryConnection: { findUnique: mocks.connection },
  },
}));
vi.mock('../src/lib/server/github', () => ({ githubFetch: mocks.github }));
import {
  connectRepository,
  verifyRepositoryAccess,
  listRepositoryConnections,
  ingestGitHubDelivery,
} from '../src/lib/server/github-repositories';
import { encrypt, digest } from '../src/lib/server/crypto';

const actor = { userId: 'owner', workspaceId: 'workspace', name: 'Owner' };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'ab'.repeat(32));
  mocks.account.mockResolvedValue({ encryptedToken: encrypt('test-token') });
  mocks.github.mockResolvedValue({
    id: 123,
    full_name: 'owner/repo',
    archived: false,
    permissions: { admin: true },
  });
});
afterEach(() => vi.unstubAllEnvs());
describe('repository connection permission boundary', () => {
  it('checks actual repository admin permissions with the existing encrypted OAuth token', async () => {
    expect(await verifyRepositoryAccess(actor.userId, 'owner/repo')).toEqual({
      id: '123',
      fullName: 'owner/repo',
    });
    expect(mocks.github).toHaveBeenCalledWith('/repos/owner/repo', 'test-token');
  });
  it.each([{}, { admin: false }, { push: true }])(
    'rejects insufficient repository permissions %j',
    async (permissions) => {
      mocks.github.mockResolvedValue({
        id: 123,
        full_name: 'owner/repo',
        archived: false,
        permissions,
      });
      await expect(verifyRepositoryAccess(actor.userId, 'owner/repo')).rejects.toMatchObject({
        status: 403,
      });
    },
  );
  it('rejects expired/missing account and archived repositories', async () => {
    mocks.account.mockResolvedValueOnce(null);
    await expect(verifyRepositoryAccess(actor.userId, 'owner/repo')).rejects.toMatchObject({
      status: 409,
    });
    mocks.github.mockResolvedValue({
      id: 123,
      full_name: 'owner/repo',
      archived: true,
      permissions: { admin: true },
    });
    await expect(verifyRepositoryAccess(actor.userId, 'owner/repo')).rejects.toMatchObject({
      status: 409,
    });
  });
  it('rejects removed membership and member-only roles before requesting GitHub', async () => {
    for (const member of [null, { role: 'MEMBER' }]) {
      mocks.transaction.mockImplementation((fn) =>
        fn({ workspaceMember: { findUnique: async () => member } }),
      );
      await expect(
        connectRepository(actor, { projectId: 'p', repository: 'owner/repo' }),
      ).rejects.toMatchObject({ status: member ? 403 : 404 });
    }
    expect(mocks.github).not.toHaveBeenCalled();
  });
  it('rejects cross-workspace project lookup before requesting GitHub', async () => {
    const find = vi.fn().mockResolvedValue(null);
    mocks.transaction.mockImplementation((fn) =>
      fn({
        workspaceMember: { findUnique: async () => ({ role: 'OWNER' }) },
        project: { findFirst: find },
      }),
    );
    await expect(
      connectRepository(actor, { projectId: 'foreign', repository: 'owner/repo' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(find).toHaveBeenCalledWith({ where: { id: 'foreign', workspaceId: actor.workspaceId } });
    expect(mocks.github).not.toHaveBeenCalled();
  });
  it('never selects encrypted secrets when listing connections', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    mocks.transaction.mockImplementation((fn) =>
      fn({
        workspaceMember: { findUnique: async () => ({ role: 'MEMBER' }) },
        project: { findFirst: async () => ({}) },
        gitHubRepositoryConnection: { findMany },
      }),
    );
    await listRepositoryConnections(actor, 'p');
    expect(findMany.mock.calls[0][0].select).not.toHaveProperty('encryptedWebhookSecret');
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      workspaceId: actor.workspaceId,
      projectId: 'p',
      disconnectedAt: null,
    });
  });
});

describe('verified webhook receipt boundary (mocked transaction)', () => {
  function fixture() {
    const secret = 'isolated-webhook-secret';
    const raw = Buffer.from('{"repository":{"id":123}}');
    const headers = new Headers({
      'x-github-delivery': randomUUID(),
      'x-github-event': 'ping',
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
    });
    const c = {
      id: 'connection',
      workspaceId: 'workspace',
      projectId: 'project',
      repositoryId: '123',
      disconnectedAt: null,
      encryptedWebhookSecret: encrypt(secret),
    };
    const current = vi.fn().mockResolvedValue(c);
    const receipt = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockResolvedValue({});
    mocks.connection.mockResolvedValue(c);
    mocks.transaction.mockImplementation((fn) =>
      fn({
        $queryRaw: vi.fn().mockResolvedValue([{ archivedAt: null }]),
        gitHubRepositoryConnection: { findUnique: current },
        gitHubWebhookDelivery: { findUnique: receipt, create },
      }),
    );
    return { raw, headers, current, receipt, create, c };
  }
  it('does not acknowledge when durable insertion fails', async () => {
    const f = fixture();
    f.create.mockRejectedValue(new Error('database unavailable'));
    await expect(ingestGitHubDelivery('connection', f.raw, f.headers)).rejects.toThrow(
      'database unavailable',
    );
  });
  it('reuses matching receipt and refuses a delivery ID reused for changed content', async () => {
    const f = fixture();
    f.receipt.mockResolvedValue({ payloadHash: digest(f.raw.toString('base64')), event: 'ping' });
    expect(await ingestGitHubDelivery('connection', f.raw, f.headers)).toEqual({
      accepted: true,
      duplicate: true,
    });
    f.receipt.mockResolvedValue({ payloadHash: 'different', event: 'ping' });
    await expect(ingestGitHubDelivery('connection', f.raw, f.headers)).rejects.toMatchObject({
      status: 409,
    });
    expect(f.create).not.toHaveBeenCalled();
  });
  it('does not re-enqueue identical signed bytes under a changed delivery ID', async () => {
    const f = fixture();
    f.receipt.mockResolvedValueOnce(null).mockResolvedValueOnce({ event: 'ping' });
    expect(await ingestGitHubDelivery('connection', f.raw, f.headers)).toEqual({
      accepted: true,
      duplicate: true,
    });
    expect(f.create).not.toHaveBeenCalled();
  });
  it('rechecks disconnect after acquiring the lock', async () => {
    const f = fixture();
    f.current.mockResolvedValue({ ...f.c, disconnectedAt: new Date() });
    await expect(ingestGitHubDelivery('connection', f.raw, f.headers)).rejects.toMatchObject({
      status: 404,
    });
    expect(f.create).not.toHaveBeenCalled();
  });
  it('rejects tampered bytes before opening a receipt transaction', async () => {
    const f = fixture();
    await expect(
      ingestGitHubDelivery('connection', Buffer.from('{}'), f.headers),
    ).rejects.toMatchObject({ status: 401 });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });
});
