import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  authorize: vi.fn(),
  verify: vi.fn(),
  update: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('../src/lib/server/db', () => ({ db: { $transaction: mocks.transaction } }));
vi.mock('../src/lib/server/github-repositories', () => ({
  authorizeGitHubProject: mocks.authorize,
  verifyRepositoryAccess: mocks.verify,
}));
import { retryGitHubDelivery, setGitHubEnrichment } from '../src/lib/server/github-monitoring';
const actor = { userId: 'owner', workspaceId: 'workspace', name: 'Owner' };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.authorize.mockResolvedValue({});
  mocks.update.mockResolvedValue({ count: 1 });
  mocks.transaction.mockImplementation((fn) =>
    fn({
      $queryRaw: async () => [{ archivedAt: null }],
      gitHubRepositoryConnection: {
        findFirst: async ({ where }: { where: { workspaceId: string } }) =>
          where.workspaceId === 'workspace'
            ? {
                id: 'c',
                projectId: 'p',
                repositoryId: '123',
                repositoryFullName: 'owner/repo',
                disconnectedAt: null,
              }
            : null,
        update: mocks.update,
      },
      gitHubWebhookDelivery: { updateMany: mocks.update },
      taskActivity: { create: mocks.audit },
    }),
  );
});
it('does not retry after authorization failure or cross-workspace lookup', async () => {
  mocks.authorize.mockRejectedValueOnce({ status: 403 });
  await expect(retryGitHubDelivery(actor, 'c', 'd')).rejects.toMatchObject({ status: 403 });
  await expect(
    retryGitHubDelivery({ ...actor, workspaceId: 'foreign' }, 'c', 'd'),
  ).rejects.toMatchObject({ status: 404 });
  expect(mocks.update).not.toHaveBeenCalled();
});
it('limits manual retry to failed records and clears prior lease/dead-letter state', async () => {
  await retryGitHubDelivery(actor, 'c', 'd');
  expect(mocks.update.mock.calls[0][0]).toMatchObject({
    where: { id: 'd', connectionId: 'c', state: 'FAILED' },
    data: {
      state: 'PENDING',
      attempts: 0,
      deadLetteredAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  expect(mocks.audit).toHaveBeenCalledOnce();
  mocks.update.mockResolvedValueOnce({ count: 0 });
  await expect(retryGitHubDelivery(actor, 'c', 'processed')).rejects.toMatchObject({ status: 409 });
});
it('requires explicit boolean consent and matching fresh repository identity', async () => {
  await expect(
    setGitHubEnrichment(actor, 'c', { enabled: true, userId: 'other' }),
  ).rejects.toThrow();
  mocks.verify.mockResolvedValueOnce({ id: '456' });
  await expect(setGitHubEnrichment(actor, 'c', { enabled: true })).rejects.toMatchObject({
    status: 409,
  });
  expect(mocks.update).not.toHaveBeenCalled();
  await setGitHubEnrichment(actor, 'c', { enabled: false });
  expect(mocks.update.mock.calls[0][0].data).toMatchObject({
    enrichmentUserId: null,
    enrichmentAuthorizedAt: null,
    enrichmentVersion: { increment: 1 },
  });
});
