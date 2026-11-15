import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { GitHubRepositoryConnection, GitHubWebhookDelivery } from '@prisma/client';
const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  member: vi.fn(),
  connection: vi.fn(),
  cooldown: vi.fn(),
  save: vi.fn(),
  request: vi.fn(),
}));
vi.mock('../src/lib/server/db', () => ({
  db: {
    gitHubConnection: { findUnique: mocks.account },
    workspaceMember: { findUnique: mocks.member },
    gitHubRepositoryConnection: { findUnique: mocks.connection },
    rateLimit: { findUnique: mocks.cooldown },
    $executeRaw: mocks.save,
  },
}));
vi.mock('../src/lib/server/github-request', async (load) => ({
  ...(await load<typeof import('../src/lib/server/github-request')>()),
  githubRequest: mocks.request,
}));
import { enrichGitHubEvent } from '../src/lib/server/github-enrichment';
import { GitHubHttpError } from '../src/lib/server/github-request';
import { encrypt } from '../src/lib/server/crypto';
const connection = {
  id: 'c',
  projectId: 'p',
  workspaceId: 'w',
  repositoryId: '123',
  repositoryFullName: 'owner/repo',
  enrichmentUserId: 'owner',
  enrichmentAuthorizedAt: new Date(),
  enrichmentVersion: 1,
  disconnectedAt: null,
} as GitHubRepositoryConnection;
const delivery = {
  event: 'issues',
  dataVersion: 1,
  data: { repositoryId: '123', action: 'opened', number: 7, state: 'open', taskRefs: ['DEV-12'] },
} as unknown as GitHubWebhookDelivery;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'ef'.repeat(32));
  mocks.account.mockResolvedValue({ encryptedToken: encrypt('private-token') });
  mocks.member.mockResolvedValue({ role: 'OWNER' });
  mocks.connection.mockResolvedValue(connection);
  mocks.cooldown.mockResolvedValue(null);
  mocks.request.mockImplementation(async (path: string) =>
    path === '/repos/owner/repo'
      ? { id: 123, full_name: 'owner/repo', archived: false, permissions: { admin: true } }
      : {
          number: 7,
          updated_at: '2026-11-14T12:00:00Z',
          state: 'closed',
          title: 'DEV-18 private title',
          body: 'private body',
        },
  );
});
afterEach(() => vi.unstubAllEnvs());
it('does not borrow credentials without explicit enrichment authorization', async () => {
  expect((await enrichGitHubEvent(delivery, { ...connection, enrichmentUserId: null })).code).toBe(
    'ENRICHMENT_NOT_AUTHORIZED',
  );
  expect(mocks.account).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalled();
});
it('falls back to local facts if the authorizer leaves or loses admin role', async () => {
  mocks.member.mockResolvedValue({ role: 'MEMBER' });
  expect((await enrichGitHubEvent(delivery, connection)).code).toBe('ENRICHMENT_AUTH_CHANGED');
  expect(mocks.request).not.toHaveBeenCalled();
});
it('keeps signed observations and API projection provenance separate while minimizing private content', async () => {
  const result = await enrichGitHubEvent(delivery, connection);
  expect(result.code).toBe('ENRICHED');
  expect(result.facts[0].refs).toEqual(['DEV-12', 'DEV-18']);
  expect(result.facts[0].data.webhook).toMatchObject({ state: 'open' });
  expect(result.facts[0].projectionData).toMatchObject({ state: 'closed' });
  expect(JSON.stringify(result)).not.toContain('private');
});
it('rejects repository transfers or identity changes before fetching object details', async () => {
  mocks.request.mockReset().mockResolvedValue({
    id: 456,
    full_name: 'other/repo',
    archived: false,
    permissions: { admin: true },
  });
  expect((await enrichGitHubEvent(delivery, connection)).code).toBe(
    'GITHUB_REPOSITORY_UNAVAILABLE',
  );
  expect(mocks.request).toHaveBeenCalledOnce();
});
it('handles revoked OAuth locally and schedules transient rate failures with persistent cooldown', async () => {
  mocks.request
    .mockReset()
    .mockRejectedValueOnce(new GitHubHttpError('GITHUB_CREDENTIALS_REVOKED', 401, false));
  expect((await enrichGitHubEvent(delivery, connection)).code).toBe('GITHUB_CREDENTIALS_REVOKED');
  const retryAt = Date.now() + 120000;
  mocks.request.mockRejectedValueOnce(
    new GitHubHttpError('GITHUB_RATE_LIMITED', 429, true, retryAt),
  );
  await expect(enrichGitHubEvent(delivery, connection)).rejects.toMatchObject({
    code: 'GITHUB_RATE_LIMITED',
    retryAt,
  });
  expect(mocks.save).toHaveBeenCalledOnce();
});
it('does not call GitHub during a stored credential cooldown', async () => {
  mocks.cooldown.mockResolvedValue({ expiresAt: new Date(Date.now() + 120000) });
  await expect(enrichGitHubEvent(delivery, connection)).rejects.toMatchObject({
    code: 'GITHUB_RATE_LIMITED',
  });
  expect(mocks.request).not.toHaveBeenCalled();
});
it('bounds compare pagination to three pages and preserves incompleteness', async () => {
  mocks.request.mockReset().mockImplementation(async (path: string) => {
    if (path === '/repos/owner/repo')
      return { id: 123, full_name: 'owner/repo', archived: false, permissions: { admin: true } };
    const page = Number(new URL(path, 'https://api.github.com').searchParams.get('page'));
    return {
      total_commits: 500,
      commits: Array.from({ length: 100 }, (_, i) => ({
        sha: (page * 100 + i).toString(16).padStart(40, '0'),
        commit: { message: 'DEV-12 hidden content' },
      })),
    };
  });
  const push = {
    ...delivery,
    event: 'push',
    data: {
      repositoryId: '123',
      ref: 'refs/heads/main',
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
      deleted: false,
      commitCount: 500,
      commitsTruncated: true,
      commits: [{ sha: 'c'.repeat(40), taskRefs: [] }],
    },
  };
  const result = await enrichGitHubEvent(push, connection);
  expect(mocks.request).toHaveBeenCalledTimes(5);
  expect(result.facts).toHaveLength(300);
  expect(result.code).toBe('ENRICHMENT_TRUNCATED');
  expect(result.facts.every((f) => f.incomplete)).toBe(true);
  expect(JSON.stringify(result)).not.toContain('hidden content');
});
