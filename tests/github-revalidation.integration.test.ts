import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest';
import { db } from '../src/lib/server/db';
import { encrypt, digest } from '../src/lib/server/crypto';
import { revalidateGitHubConnection } from '../src/lib/server/github-revalidation';
const users: string[] = [],
  workspaces: string[] = [],
  cooldowns: string[] = [];
let workspaceId: string,
  foreignWorkspace: string,
  connected = false;
const actor = (index = 0, scope = workspaceId) => ({
  userId: users[index],
  workspaceId: scope,
  name: 'Revalidation admin',
});
const profile = { id: 1, login: 'fixture' };
const repo = { id: 123, full_name: 'fixture/repo', archived: false, permissions: { admin: true } };
const json = (data: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(data), { status, headers });
beforeAll(async () => {
  await db.$connect();
  connected = true;
  for (const name of ['owner', 'admin', 'member', 'outsider'])
    users.push(
      (
        await db.user.create({
          data: {
            name,
            email: `revalidation-${randomUUID()}@example.com`,
            passwordHash: 'fixture-not-a-login',
          },
        })
      ).id,
    );
  workspaceId = (
    await db.workspace.create({
      data: {
        name: 'Revalidation fixture',
        members: {
          create: [
            { userId: users[0], role: 'OWNER' },
            { userId: users[1], role: 'ADMIN' },
            { userId: users[2], role: 'MEMBER' },
          ],
        },
      },
    })
  ).id;
  workspaces.push(workspaceId);
  foreignWorkspace = (
    await db.workspace.create({
      data: {
        name: 'Foreign revalidation fixture',
        members: { create: { userId: users[3], role: 'OWNER' } },
      },
    })
  ).id;
  workspaces.push(foreignWorkspace);
});
beforeEach(() => {
  vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'ab'.repeat(32));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => json(url.endsWith('/user') ? profile : repo)),
  );
});
afterAll(async () => {
  try {
    if (connected) {
      await db.rateLimit.deleteMany({
        where: {
          OR: [
            { key: { in: cooldowns } },
            ...workspaces.map((id) => ({ key: { startsWith: `github-revalidation:${id}:` } })),
          ],
        },
      });
      await db.workspace.deleteMany({ where: { id: { in: workspaces } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
    }
  } finally {
    await db.$disconnect();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});
async function fixture() {
  const project = await db.project.create({
    data: { workspaceId, name: 'Repository check fixture' },
  });
  const c = await db.gitHubRepositoryConnection.create({
    data: {
      workspaceId,
      projectId: project.id,
      repositoryId: '123',
      repositoryFullName: 'fixture/repo',
      encryptedWebhookSecret: 'fixture-webhook-secret',
    },
  });
  const encryptedToken = encrypt('fixture-oauth-token');
  cooldowns.push(`github-cooldown:${digest(encryptedToken)}`);
  const account = await db.gitHubConnection.upsert({
    where: { userId: users[0] },
    create: { userId: users[0], login: 'fixture', encryptedToken },
    update: { login: 'fixture', encryptedToken },
  });
  return { project, c, account };
}
it('allows owner checks while preserving tasks, disabled rules, repository identity, credentials and activity', async () => {
  const f = await fixture();
  const task = await db.task.create({
    data: { projectId: f.project.id, title: 'Isolated diagnostic fixture', version: 7 },
  });
  const rule = await db.gitHubWorkflowRule.create({
    data: {
      workspaceId,
      projectId: f.project.id,
      name: 'Disabled fixture',
      trigger: 'PR_MERGED',
      targetStatus: 'DONE',
    },
  });
  expect((await revalidateGitHubConnection(actor(), f.c.id)).state).toBe('VALID');
  expect(await db.gitHubRepositoryConnection.findUniqueOrThrow({ where: { id: f.c.id } })).toEqual(
    f.c,
  );
  expect(await db.gitHubConnection.findUniqueOrThrow({ where: { userId: users[0] } })).toEqual(
    f.account,
  );
  expect(await db.task.findUniqueOrThrow({ where: { id: task.id } })).toEqual(task);
  expect(await db.gitHubWorkflowRule.findUniqueOrThrow({ where: { id: rule.id } })).toEqual(rule);
  expect(await db.taskActivity.count({ where: { workspaceId } })).toBe(0);
  expect(await db.gitHubWebhookDelivery.count({ where: { connectionId: f.c.id } })).toBe(0);
  expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
});
it('rejects ordinary members, missing memberships and cross-workspace reads before using credentials', async () => {
  const f = await fixture();
  await expect(revalidateGitHubConnection(actor(2), f.c.id)).rejects.toMatchObject({ status: 403 });
  await expect(revalidateGitHubConnection(actor(3), f.c.id)).rejects.toMatchObject({ status: 404 });
  await expect(
    revalidateGitHubConnection(actor(3, foreignWorkspace), f.c.id),
  ).rejects.toMatchObject({ status: 404 });
  expect(fetch).not.toHaveBeenCalled();
});
it('does not borrow configured enrichment credentials from another administrator', async () => {
  const f = await fixture();
  await db.gitHubRepositoryConnection.update({
    where: { id: f.c.id },
    data: { enrichmentUserId: users[1], enrichmentAuthorizedAt: new Date(), enrichmentVersion: 1 },
  });
  expect((await revalidateGitHubConnection(actor(), f.c.id)).code).toBe(
    'OTHER_ENRICHMENT_AUTHORIZER',
  );
  expect(fetch).not.toHaveBeenCalled();
  const encryptedToken = encrypt('fixture-other-admin-token');
  cooldowns.push(`github-cooldown:${digest(encryptedToken)}`);
  await db.gitHubConnection.upsert({
    where: { userId: users[1] },
    create: { userId: users[1], login: 'fixture', encryptedToken },
    update: { login: 'fixture', encryptedToken },
  });
  expect(await revalidateGitHubConnection(actor(1), f.c.id)).toMatchObject({
    state: 'VALID',
    authorizationSource: 'CONFIGURED_ENRICHMENT',
  });
});
it('discards positive provider evidence if credentials or enrichment settings change in flight', async () => {
  const f = await fixture();
  vi.mocked(fetch).mockImplementationOnce(async () => {
    await db.gitHubConnection.update({
      where: { userId: users[0] },
      data: { encryptedToken: encrypt('fixture-replacement') },
    });
    return json(profile);
  });
  expect((await revalidateGitHubConnection(actor(), f.c.id)).code).toBe('CONTEXT_CHANGED');
  expect(fetch).toHaveBeenCalledOnce();
  const g = await fixture();
  vi.mocked(fetch)
    .mockResolvedValueOnce(json(profile))
    .mockImplementationOnce(async () => {
      await db.gitHubRepositoryConnection.update({
        where: { id: g.c.id },
        data: { enrichmentVersion: { increment: 1 } },
      });
      return json(repo);
    });
  expect((await revalidateGitHubConnection(actor(), g.c.id)).code).toBe('CONTEXT_CHANGED');
});
it('handles disconnect and administrator-role loss without publishing a valid result', async () => {
  const f = await fixture();
  vi.mocked(fetch).mockImplementationOnce(async () => {
    await db.gitHubRepositoryConnection.update({
      where: { id: f.c.id },
      data: { disconnectedAt: new Date() },
    });
    return json(profile);
  });
  expect((await revalidateGitHubConnection(actor(), f.c.id)).state).toBe('DISCONNECTED');
  const g = await fixture();
  vi.mocked(fetch).mockImplementationOnce(async () => {
    await db.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId: users[0] } },
      data: { role: 'MEMBER' },
    });
    return json(profile);
  });
  try {
    await expect(revalidateGitHubConnection(actor(), g.c.id)).rejects.toMatchObject({
      status: 403,
    });
  } finally {
    await db.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId: users[0] } },
      data: { role: 'OWNER' },
    });
  }
});
it('persists only observed cooldown metadata and reuses it without another GitHub request', async () => {
  const f = await fixture();
  vi.mocked(fetch).mockResolvedValueOnce(
    json({ message: 'private limited details' }, 429, { 'Retry-After': '120' }),
  );
  const first = await revalidateGitHubConnection(actor(), f.c.id);
  expect(first.retrySource).toBe('PROVIDER_HEADER');
  const cooldown = await db.rateLimit.findUniqueOrThrow({ where: { key: cooldowns.at(-1)! } });
  expect(cooldown.expiresAt.toISOString()).toBe(first.retryAt);
  const again = await revalidateGitHubConnection(actor(), f.c.id);
  expect(again.code).toBe('AUTHORIZATION_COOLDOWN');
  expect(again.retrySource).toBe('LOCAL_COOLDOWN');
  expect(fetch).toHaveBeenCalledOnce();
  expect(JSON.stringify(first)).not.toContain('private');
  expect(await db.gitHubRepositoryConnection.findUniqueOrThrow({ where: { id: f.c.id } })).toEqual(
    f.c,
  );
});
it('leaves identity unchanged on permission failure, repository replacement and authorization rejection', async () => {
  const f = await fixture();
  vi.mocked(fetch)
    .mockResolvedValueOnce(json(profile))
    .mockResolvedValueOnce(json({ ...repo, permissions: { admin: false } }));
  expect((await revalidateGitHubConnection(actor(), f.c.id)).state).toBe('INSUFFICIENT_PERMISSION');
  vi.mocked(fetch)
    .mockResolvedValueOnce(json(profile))
    .mockResolvedValueOnce(json({ ...repo, id: 456 }));
  expect((await revalidateGitHubConnection(actor(), f.c.id)).code).toBe(
    'REPOSITORY_IDENTITY_CHANGED',
  );
  vi.mocked(fetch).mockResolvedValueOnce(json({ message: 'Bad credentials' }, 401));
  expect((await revalidateGitHubConnection(actor(), f.c.id)).state).toBe('AUTHORIZATION_REJECTED');
  expect(await db.gitHubRepositoryConnection.findUniqueOrThrow({ where: { id: f.c.id } })).toEqual(
    f.c,
  );
});
it('bounds repeated checks using existing atomic per-administrator request budgets', async () => {
  const f = await fixture();
  await Promise.all(Array.from({ length: 3 }, () => revalidateGitHubConnection(actor(), f.c.id)));
  const before = vi.mocked(fetch).mock.calls.length;
  await expect(revalidateGitHubConnection(actor(), f.c.id)).rejects.toMatchObject({ status: 429 });
  expect(fetch).toHaveBeenCalledTimes(before);
  expect(await db.taskActivity.count({ where: { workspaceId } })).toBe(0);
});
it('recovers from an observed provider cooldown only after an explicit later request', async () => {
  const f = await fixture();
  vi.mocked(fetch).mockResolvedValueOnce(
    json({ message: 'limited' }, 429, { 'Retry-After': '120' }),
  );
  expect((await revalidateGitHubConnection(actor(), f.c.id)).code).toBe('GITHUB_RATE_LIMITED');
  expect((await revalidateGitHubConnection(actor(), f.c.id)).code).toBe('AUTHORIZATION_COOLDOWN');
  expect(fetch).toHaveBeenCalledOnce();
  // Model elapsed cooldown on the isolated fixture key; no clock sleeps or app records.
  await db.rateLimit.update({
    where: { key: cooldowns.at(-1)! },
    data: { expiresAt: new Date(0) },
  });
  expect((await revalidateGitHubConnection(actor(), f.c.id)).state).toBe('VALID');
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(await db.gitHubRepositoryConnection.findUniqueOrThrow({ where: { id: f.c.id } })).toEqual(
    f.c,
  );
  expect(await db.gitHubConnection.findUniqueOrThrow({ where: { userId: users[0] } })).toEqual(
    f.account,
  );
});
