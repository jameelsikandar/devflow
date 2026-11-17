import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  transaction: vi.fn(),
  connection: vi.fn(),
  account: vi.fn(),
  authorize: vi.fn(),
  limit: vi.fn(),
  cooldown: vi.fn(),
  execute: vi.fn(),
}));
vi.mock('../src/lib/server/db', () => ({
  db: {
    $transaction: m.transaction,
    rateLimit: { findUnique: m.cooldown },
    $executeRaw: m.execute,
  },
}));
vi.mock('../src/lib/server/github-repositories', () => ({ authorizeGitHubProject: m.authorize }));
vi.mock('../src/lib/server/auth', () => ({ rateLimit: m.limit }));
import { encrypt } from '../src/lib/server/crypto';
import { revalidateGitHubConnection } from '../src/lib/server/github-revalidation';
const actor = { userId: 'owner', workspaceId: 'workspace', name: 'Owner' };
const c = {
  id: 'c',
  workspaceId: 'workspace',
  projectId: 'p',
  repositoryId: '123',
  repositoryFullName: 'owner/repo',
  disconnectedAt: null as Date | null,
  enrichmentUserId: null as string | null,
  enrichmentAuthorizedAt: null as Date | null,
  enrichmentVersion: 0,
};
const profile = { id: 10, login: 'owner' };
const repo = { id: 123, full_name: 'owner/repo', archived: false, permissions: { admin: true } };
const json = (data: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(data), { status, headers });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'ab'.repeat(32));
  Object.assign(c, {
    repositoryId: '123',
    repositoryFullName: 'owner/repo',
    disconnectedAt: null,
    enrichmentUserId: null,
    enrichmentAuthorizedAt: null,
    enrichmentVersion: 0,
  });
  m.connection.mockImplementation(async ({ where }) =>
    where.id === 'c' && where.workspaceId === 'workspace' ? { ...c } : null,
  );
  m.account.mockResolvedValue({
    id: 'account',
    login: 'owner',
    encryptedToken: encrypt('fixture-revalidation-token'),
  });
  m.authorize.mockResolvedValue({ archivedAt: null });
  m.cooldown.mockResolvedValue(null);
  m.execute.mockResolvedValue(1);
  m.transaction.mockImplementation((fn) =>
    fn({
      gitHubRepositoryConnection: { findFirst: m.connection },
      gitHubConnection: { findUnique: m.account },
    }),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => json(url.endsWith('/user') ? profile : repo)),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it('checks only authenticated administrator access, using bounded GETs without changing identity or domain records', async () => {
  const result = await revalidateGitHubConnection(actor, 'c');
  expect(result).toMatchObject({
    code: 'ACCESS_VALID',
    state: 'VALID',
    authorizationSource: 'REQUESTING_ADMIN',
    scope: { workspaceId: 'workspace', projectId: 'p', connectionId: 'c' },
  });
  expect(m.account.mock.calls.every(([arg]) => arg.where.userId === 'owner')).toBe(true);
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
    'https://api.github.com/user',
    'https://api.github.com/repos/owner/repo',
  ]);
  for (const [, options] of vi.mocked(fetch).mock.calls)
    expect(options).toMatchObject({ cache: 'no-store', redirect: 'error' });
  expect(m.execute).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toMatch(
    /encryptedToken|fixture-|credentialHash|login|repositoryFullName/,
  );
  expect(m.connection.mock.calls[0][0].select.encryptedWebhookSecret).toBeUndefined();
});
it('rejects members, missing memberships and cross-workspace connections before external calls', async () => {
  m.authorize.mockRejectedValueOnce({ status: 403 });
  await expect(revalidateGitHubConnection(actor, 'c')).rejects.toMatchObject({ status: 403 });
  m.authorize.mockRejectedValueOnce({ status: 404 });
  await expect(revalidateGitHubConnection(actor, 'c')).rejects.toMatchObject({ status: 404 });
  await expect(
    revalidateGitHubConnection({ ...actor, workspaceId: 'foreign' }, 'c'),
  ).rejects.toMatchObject({ status: 404 });
  expect(fetch).not.toHaveBeenCalled();
  expect(m.limit).not.toHaveBeenCalled();
});
it('never borrows another enrichment authorizer’s token or silently falls back to the requesting account', async () => {
  Object.assign(c, { enrichmentUserId: 'someone-else', enrichmentAuthorizedAt: new Date() });
  expect(await revalidateGitHubConnection(actor, 'c')).toMatchObject({
    code: 'OTHER_ENRICHMENT_AUTHORIZER',
    state: 'INCONCLUSIVE',
    authorizationSource: 'CONFIGURED_ENRICHMENT',
  });
  expect(m.account).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it('checks an explicitly configured own grant, and distinguishes missing account from revocation', async () => {
  Object.assign(c, { enrichmentUserId: 'owner', enrichmentAuthorizedAt: new Date() });
  expect((await revalidateGitHubConnection(actor, 'c')).authorizationSource).toBe(
    'CONFIGURED_ENRICHMENT',
  );
  m.account.mockResolvedValue(null);
  expect((await revalidateGitHubConnection(actor, 'c')).code).toBe('OAUTH_ACCOUNT_MISSING');
});
it('returns local incomplete, disconnected, archived and unreadable credential evidence without GitHub calls', async () => {
  c.enrichmentUserId = 'owner';
  expect((await revalidateGitHubConnection(actor, 'c')).code).toBe(
    'ENRICHMENT_AUTHORIZATION_INCOMPLETE',
  );
  c.disconnectedAt = new Date();
  expect((await revalidateGitHubConnection(actor, 'c')).state).toBe('DISCONNECTED');
  c.disconnectedAt = null;
  c.enrichmentUserId = null;
  m.authorize.mockResolvedValueOnce({ archivedAt: new Date() });
  expect((await revalidateGitHubConnection(actor, 'c')).state).toBe('PROJECT_ARCHIVED');
  m.account.mockResolvedValue({ id: 'a', login: 'owner', encryptedToken: 'unreadable' });
  expect((await revalidateGitHubConnection(actor, 'c')).code).toBe('CREDENTIALS_UNREADABLE');
  expect(fetch).not.toHaveBeenCalled();
});
it('does not infer revoked versus expired from a rejected credential', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(json({ message: 'private upstream error' }, 401));
  expect(await revalidateGitHubConnection(actor, 'c')).toMatchObject({
    state: 'AUTHORIZATION_REJECTED',
    code: 'AUTHORIZATION_REJECTED',
    retryAt: null,
  });
  expect(fetch).toHaveBeenCalledOnce();
});
it.each([
  [404, 'REPOSITORY_NOT_VISIBLE'],
  [403, 'REPOSITORY_ACCESS_BLOCKED'],
  [500, 'GITHUB_UNAVAILABLE'],
  [301, 'GITHUB_UNAVAILABLE'],
])('classifies repository HTTP %i conservatively as %s', async (status, code) => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(json(profile))
    .mockResolvedValueOnce(json({ message: 'private diagnostic' }, status));
  const result = await revalidateGitHubConnection(actor, 'c');
  expect(result.code).toBe(code);
  expect(JSON.stringify(result)).not.toContain('private');
});
it.each([
  [{ ...repo, permissions: { admin: false } }, 'REPOSITORY_PERMISSION_INSUFFICIENT'],
  [{ ...repo, permissions: undefined }, 'PERMISSION_EVIDENCE_MISSING'],
  [{ ...repo, id: 456 }, 'REPOSITORY_IDENTITY_CHANGED'],
  [{ ...repo, full_name: 'other/repo' }, 'REPOSITORY_IDENTITY_CHANGED'],
  [{ ...repo, archived: true }, 'REPOSITORY_INACTIVE'],
  [{ ...repo, disabled: true }, 'REPOSITORY_INACTIVE'],
  [{ unexpected: 'private' }, 'GITHUB_RESPONSE_UNRECOGNIZED'],
])('preserves identity and diagnoses repository evidence %j', async (value, code) => {
  vi.mocked(fetch).mockResolvedValueOnce(json(profile)).mockResolvedValueOnce(json(value));
  expect((await revalidateGitHubConnection(actor, 'c')).code).toBe(code);
  expect(c.repositoryId).toBe('123');
  expect(c.repositoryFullName).toBe('owner/repo');
});
it('rejects account-identity drift without overwriting login or requesting another repository', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(json({ ...profile, login: 'different' }));
  expect((await revalidateGitHubConnection(actor, 'c')).code).toBe('ACCOUNT_IDENTITY_UNCONFIRMED');
  expect(fetch).toHaveBeenCalledOnce();
});
it('uses recorded cooldowns without a request and preserves observed Retry-After without guessing delays', async () => {
  const future = new Date(Date.now() + 120000);
  m.cooldown.mockResolvedValueOnce({ expiresAt: future });
  expect(await revalidateGitHubConnection(actor, 'c')).toMatchObject({
    code: 'AUTHORIZATION_COOLDOWN',
    retryAt: future.toISOString(),
    retrySource: 'LOCAL_COOLDOWN',
  });
  expect(fetch).not.toHaveBeenCalled();
  vi.mocked(fetch).mockResolvedValueOnce(
    json({ message: 'Rate limited' }, 429, { 'Retry-After': '120' }),
  );
  const observed = await revalidateGitHubConnection(actor, 'c');
  expect(observed.retrySource).toBe('PROVIDER_HEADER');
  expect(Date.parse(observed.retryAt!)).toBeGreaterThan(Date.now());
  expect(m.execute).toHaveBeenCalledOnce();
  vi.mocked(fetch).mockResolvedValueOnce(json({ message: 'Rate limited' }, 429));
  expect(await revalidateGitHubConnection(actor, 'c')).toMatchObject({
    code: 'GITHUB_RATE_LIMITED',
    retryAt: null,
    retrySource: null,
  });
  expect(m.execute).toHaveBeenCalledOnce();
});
it('honors observed reset timing and never automatically retries provider requests', async () => {
  const reset = Math.ceil(Date.now() / 1000) + 180;
  vi.mocked(fetch).mockResolvedValueOnce(
    json({ message: 'limited' }, 403, {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(reset),
    }),
  );
  expect((await revalidateGitHubConnection(actor, 'c')).retryAt).toBe(
    new Date(reset * 1000).toISOString(),
  );
  expect(fetch).toHaveBeenCalledOnce();
});
it('sanitizes malformed responses and transport failures without automatic retry', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response('private non-JSON body'));
  expect((await revalidateGitHubConnection(actor, 'c')).code).toBe('GITHUB_RESPONSE_UNRECOGNIZED');
  vi.mocked(fetch).mockRejectedValueOnce(new Error('private network token'));
  expect((await revalidateGitHubConnection(actor, 'c')).code).toBe('GITHUB_UNAVAILABLE');
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('discards results after credential replacement, disconnect or role loss while external reads are in flight', async () => {
  vi.mocked(fetch).mockImplementationOnce(async () => {
    m.account.mockResolvedValue({
      id: 'new',
      login: 'owner',
      encryptedToken: encrypt('replacement'),
    });
    return json(profile);
  });
  expect((await revalidateGitHubConnection(actor, 'c')).code).toBe('CONTEXT_CHANGED');
  expect(fetch).toHaveBeenCalledOnce();
  vi.mocked(fetch).mockImplementationOnce(async () => {
    c.disconnectedAt = new Date();
    return json(profile);
  });
  expect((await revalidateGitHubConnection(actor, 'c')).state).toBe('DISCONNECTED');
  c.disconnectedAt = null;
  vi.mocked(fetch).mockImplementationOnce(async () => {
    m.authorize.mockRejectedValue({ status: 403 });
    return json(profile);
  });
  await expect(revalidateGitHubConnection(actor, 'c')).rejects.toMatchObject({ status: 403 });
});
it('does not publish valid results if the grant changes during the repository response', async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(json(profile))
    .mockImplementationOnce(async () => {
      c.enrichmentVersion++;
      return json(repo);
    });
  expect((await revalidateGitHubConnection(actor, 'c')).code).toBe('CONTEXT_CHANGED');
});
it('respects local request budgets before external calls and rejects malformed stored identity', async () => {
  m.limit.mockRejectedValueOnce({ status: 429 });
  await expect(revalidateGitHubConnection(actor, 'c')).rejects.toMatchObject({ status: 429 });
  expect(fetch).not.toHaveBeenCalled();
  c.repositoryFullName = 'https://untrusted.example/repo';
  expect((await revalidateGitHubConnection(actor, 'c')).code).toBe('INVALID_CONNECTION_IDENTITY');
});
it.each(['account', 'repository'] as const)(
  'treats a %s request timeout as inconclusive and recovers only after an explicit new check',
  async (phase) => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    try {
      if (phase === 'repository') vi.mocked(fetch).mockResolvedValueOnce(json(profile));
      vi.mocked(fetch).mockImplementationOnce(
        async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('private timeout content', 'TimeoutError')),
              { once: true },
            );
          }),
      );
      const pending = revalidateGitHubConnection(actor, 'c');
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(phase === 'repository' ? 2 : 1));
      controller.abort();
      const failed = await pending;
      expect(failed).toMatchObject({
        code: 'GITHUB_UNAVAILABLE',
        state: 'INCONCLUSIVE',
        retryAt: null,
      });
      expect(JSON.stringify(failed)).not.toContain('private');
      expect(timeout).toHaveBeenCalledWith(15000);
    } finally {
      timeout.mockRestore();
    }
    const calls = vi.mocked(fetch).mock.calls.length;
    expect((await revalidateGitHubConnection(actor, 'c')).state).toBe('VALID');
    expect(fetch).toHaveBeenCalledTimes(calls + 2);
  },
);
it.each([401, 403, 404] as const)(
  'does not persist a negative HTTP %i diagnosis or change settings before a later explicit successful check',
  async (status) => {
    if (status !== 401) vi.mocked(fetch).mockResolvedValueOnce(json(profile));
    vi.mocked(fetch).mockResolvedValueOnce(json({ message: 'private rejection details' }, status));
    expect((await revalidateGitHubConnection(actor, 'c')).state).not.toBe('VALID');
    const original = { ...c };
    expect((await revalidateGitHubConnection(actor, 'c')).state).toBe('VALID');
    expect(c).toEqual(original);
    expect(m.execute).not.toHaveBeenCalled();
  },
);
