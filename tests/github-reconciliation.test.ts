import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  db: {} as Record<string, unknown>,
  request: vi.fn(),
  authorize: vi.fn(),
}));
vi.mock('../src/lib/server/db', () => ({ db: mocks.db }));
vi.mock('../src/lib/server/github-request', async (load) => ({
  ...(await load<typeof import('../src/lib/server/github-request')>()),
  githubRequest: mocks.request,
}));
vi.mock('../src/lib/server/github-repositories', () => ({
  authorizeGitHubProject: mocks.authorize,
}));
import { reconcileGitHubCommit } from '../src/lib/server/github-reconciliation';
import { encrypt } from '../src/lib/server/crypto';
const sha = '9023d37' + 'a'.repeat(33);
const actor = { userId: 'owner', workspaceId: 'workspace', name: 'Owner' };
let c: {
  id: string;
  projectId: string;
  workspaceId: string;
  repositoryId: string;
  repositoryFullName: string;
  disconnectedAt: Date | null;
  enrichmentUserId: string | null;
  enrichmentAuthorizedAt: Date | null;
  enrichmentVersion: number;
};
let links: Set<string>;
let evidence: Set<string>;
let audit: ReturnType<typeof vi.fn>;
let objects: ReturnType<typeof vi.fn>;
let findTasks: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'ab'.repeat(32));
  c = {
    id: 'connection',
    projectId: 'project',
    workspaceId: 'workspace',
    repositoryId: '123',
    repositoryFullName: 'owner/repo',
    disconnectedAt: null,
    enrichmentUserId: 'owner',
    enrichmentAuthorizedAt: new Date(),
    enrichmentVersion: 1,
  };
  const account = { encryptedToken: encrypt('fake-oauth-token') };
  links = new Set();
  evidence = new Set();
  audit = vi.fn();
  objects = vi.fn().mockResolvedValue([{ id: 'object', key: sha }]);
  findTasks = vi.fn().mockResolvedValue([{ id: 'task-two', number: 2 }]);
  const tx = {
    $queryRaw: async () => [{ archivedAt: null }],
    gitHubRepositoryConnection: {
      findFirst: async ({ where }: { where: { id: string; workspaceId: string } }) =>
        where.id === c.id && where.workspaceId === c.workspaceId ? c : null,
      findUnique: async () => c,
    },
    gitHubConnection: { findUnique: async () => account },
    workspaceMember: { findUnique: async () => ({ role: 'OWNER' }) },
    rateLimit: { findUnique: async () => null },
    gitHubObject: { findMany: objects },
    gitHubObservation: {
      findFirst: async () => ({ id: 'observation', data: { sha, taskRefs: [] } }),
    },
    task: { findMany: findTasks },
    gitHubTaskLink: {
      count: async () => links.size,
      createMany: async ({ data }: { data: { taskId: string }[] }) => {
        for (const d of data) links.add(d.taskId);
      },
    },
    gitHubTaskLinkEvidence: {
      count: async () => evidence.size,
      createMany: async ({ data }: { data: { taskId: string; observationId: string }[] }) => {
        for (const d of data) evidence.add(`${d.taskId}:${d.observationId}`);
      },
    },
    taskActivity: { create: audit },
  };
  Object.assign(mocks.db, tx, { $transaction: (fn: (value: unknown) => unknown) => fn(tx) });
  mocks.authorize.mockImplementation(async (_tx, a) => {
    if (a.userId !== 'owner') throw Object.assign(new Error('Forbidden'), { status: 403 });
    return { archivedAt: null };
  });
  mocks.request.mockImplementation(async (path: string) =>
    path === '/repos/owner/repo'
      ? { id: 123, full_name: 'owner/repo', archived: false, permissions: { admin: true } }
      : { sha, commit: { message: 'test: verify DevFlow task linking DEV-002' } },
  );
});
afterEach(() => vi.unstubAllEnvs());
it('repairs links from verified commit text, preserves observations, and makes repeats idempotent', async () => {
  expect(await reconcileGitHubCommit(actor, c.id, '9023d37')).toMatchObject({
    sha,
    references: ['DEV-2'],
    linksCreated: 1,
    evidenceCreated: 1,
    observationId: 'observation',
  });
  expect(await reconcileGitHubCommit(actor, c.id, '9023d37')).toMatchObject({
    linksCreated: 0,
    evidenceCreated: 0,
  });
  expect(links.size).toBe(1);
  expect(evidence.size).toBe(1);
  expect(audit).toHaveBeenCalledOnce();
  const message = audit.mock.calls[0][0].data.message;
  expect(message).toContain('GitHub API');
  expect(message).toContain('DEV-2');
  expect(message).not.toContain('test: verify');
  expect(findTasks.mock.calls[0][0].where).toMatchObject({
    projectId: c.projectId,
    project: { workspaceId: c.workspaceId, archivedAt: null },
    number: { in: [2] },
  });
  expect(mocks.request.mock.calls[1][0]).toBe(`/repos/owner/repo/commits/${sha}`);
});
it('requires caller admin membership, matching workspace and own explicit enrichment grant', async () => {
  await expect(
    reconcileGitHubCommit({ ...actor, userId: 'member' }, c.id, '9023d37'),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    reconcileGitHubCommit({ ...actor, workspaceId: 'foreign' }, c.id, '9023d37'),
  ).rejects.toMatchObject({ status: 404 });
  c.enrichmentUserId = null;
  await expect(reconcileGitHubCommit(actor, c.id, '9023d37')).rejects.toMatchObject({
    status: 403,
  });
  expect(mocks.request).not.toHaveBeenCalled();
  expect(links.size).toBe(0);
});
it('rejects ambiguous prefixes before GitHub access and rejects mismatching fetched commits', async () => {
  objects.mockResolvedValueOnce([
    { id: 'o1', key: sha },
    { id: 'o2', key: sha },
  ]);
  await expect(reconcileGitHubCommit(actor, c.id, '9023d37')).rejects.toMatchObject({
    status: 409,
  });
  expect(mocks.request).not.toHaveBeenCalled();
  mocks.request.mockImplementation(async (path: string) =>
    path.endsWith(sha)
      ? { sha: 'b'.repeat(40), commit: { message: 'DEV-2' } }
      : { id: 123, full_name: 'owner/repo', archived: false, permissions: { admin: true } },
  );
  await expect(reconcileGitHubCommit(actor, c.id, '9023d37')).rejects.toMatchObject({
    status: 409,
  });
  expect(links.size).toBe(0);
});
it('discards recovery results when authorization changes in flight', async () => {
  mocks.request.mockImplementation(async (path: string) => {
    if (path.endsWith(sha)) {
      c.enrichmentVersion++;
      return { sha, commit: { message: 'DEV-002' } };
    }
    return { id: 123, full_name: 'owner/repo', archived: false, permissions: { admin: true } };
  });
  await expect(reconcileGitHubCommit(actor, c.id, '9023d37')).rejects.toMatchObject({
    status: 403,
  });
  expect(links.size).toBe(0);
  expect(audit).not.toHaveBeenCalled();
});
it('does not invent tasks or create links for unmatched/foreign references', async () => {
  findTasks.mockResolvedValue([]);
  expect(await reconcileGitHubCommit(actor, c.id, '9023d37')).toMatchObject({
    unresolvedRefs: ['DEV-2'],
    linksCreated: 0,
    evidenceCreated: 0,
  });
  expect(audit).not.toHaveBeenCalled();
});
it('rejects insufficient GitHub repository permissions before reading commit content', async () => {
  mocks.request.mockResolvedValue({
    id: 123,
    full_name: 'owner/repo',
    archived: false,
    permissions: { admin: false },
  });
  await expect(reconcileGitHubCommit(actor, c.id, '9023d37')).rejects.toMatchObject({
    status: 403,
  });
  expect(mocks.request).toHaveBeenCalledOnce();
  expect(links.size).toBe(0);
  expect(audit).not.toHaveBeenCalled();
});
