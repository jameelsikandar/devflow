import { randomUUID, createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/lib/server/db';
import * as github from '../src/lib/server/github';
import { encrypt, decrypt } from '../src/lib/server/crypto';
import {
  connectRepository,
  disconnectRepository,
  listRepositoryConnections,
  listGitHubDeliveries,
} from '../src/lib/server/github-repositories';
import { POST } from '../src/app/api/github/webhooks/[connectionId]/route';

let connected = false;
let workspaceId = '';
let foreignWorkspaceId = '';
let userId = '';
let memberId = '';
let foreignUserId = '';
let foreignProjectId = '';
const users: string[] = [];
const actor = () => ({ userId, workspaceId, name: 'GitHub owner' });
const provider = vi.spyOn(github, 'githubFetch');
beforeAll(async () => {
  vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'cd'.repeat(32));
  await db.$connect();
  connected = true;
  for (const name of ['owner', 'member', 'outsider']) {
    const user = await db.user.create({
      data: {
        name,
        email: `github-${name}-${randomUUID()}@example.com`,
        passwordHash: 'integration-fixture-not-a-login',
      },
    });
    users.push(user.id);
  }
  [userId, memberId, foreignUserId] = users;
  workspaceId = (
    await db.workspace.create({
      data: {
        name: 'GitHub fixture',
        members: {
          create: [
            { userId, role: 'OWNER' },
            { userId: memberId, role: 'MEMBER' },
          ],
        },
      },
    })
  ).id;
  foreignWorkspaceId = (
    await db.workspace.create({
      data: {
        name: 'Foreign GitHub fixture',
        members: { create: { userId: foreignUserId, role: 'OWNER' } },
      },
    })
  ).id;
  foreignProjectId = (
    await db.project.create({ data: { workspaceId: foreignWorkspaceId, name: 'Foreign project' } })
  ).id;
  await db.gitHubConnection.create({
    data: {
      userId,
      login: 'fixture-owner',
      encryptedToken: encrypt('fixture-token-never-sent-to-GitHub'),
    },
  });
});
beforeEach(() => {
  provider.mockReset().mockResolvedValue({
    id: 123,
    full_name: 'owner/repo',
    archived: false,
    permissions: { admin: true },
  });
});
afterAll(async () => {
  try {
    if (connected) {
      await db.workspace.deleteMany({
        where: { id: { in: [workspaceId, foreignWorkspaceId].filter(Boolean) } },
      });
      await db.user.deleteMany({ where: { id: { in: users } } });
    }
  } finally {
    await db.$disconnect();
    vi.unstubAllEnvs();
    provider.mockRestore();
  }
});
async function project() {
  return db.project.create({ data: { workspaceId, name: `Webhook ${randomUUID()}` } });
}
async function connection() {
  const p = await project();
  return connectRepository(actor(), { projectId: p.id, repository: 'owner/repo' });
}
function deliver(
  id: string,
  secret: string,
  options: {
    deliveryId?: string;
    event?: string;
    body?: unknown;
    signature?: string;
    raw?: string;
    contentType?: string;
  } = {},
) {
  const raw =
    options.raw ??
    JSON.stringify(
      options.body ?? {
        repository: { id: 123 },
        hook: { config: { secret: 'do-not-store' } },
        sender: { email: 'do-not-store@example.com' },
      },
    );
  const signature =
    options.signature ?? `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  return POST(
    new Request(`http://localhost:3000/api/github/webhooks/${id}`, {
      method: 'POST',
      headers: {
        'content-type': options.contentType ?? 'application/json',
        'x-github-event': options.event ?? 'ping',
        'x-github-delivery': options.deliveryId ?? randomUUID(),
        'x-hub-signature-256': signature,
      },
      body: raw,
    }),
    { params: Promise.resolve({ connectionId: id }) },
  );
}
describe.sequential('real database GitHub repository connections and webhook inbox', () => {
  it('persists scoped encrypted setup, legacy activity link and audit without leaking secrets from reads', async () => {
    const c = await connection();
    const stored = await db.gitHubRepositoryConnection.findUniqueOrThrow({
      where: { id: c.connection.id },
    });
    expect(decrypt(stored.encryptedWebhookSecret)).toBe(c.setup.secret);
    expect(stored.encryptedWebhookSecret).not.toContain(c.setup.secret);
    expect(c.setup.url).toContain(`/api/github/webhooks/${stored.id}`);
    expect(
      (await db.project.findUniqueOrThrow({ where: { id: stored.projectId } })).repository,
    ).toBe('owner/repo');
    const visible = await listRepositoryConnections(actor(), stored.projectId);
    expect(visible).toHaveLength(1);
    expect(JSON.stringify(visible)).not.toContain('encryptedWebhookSecret');
    expect(JSON.stringify(visible)).not.toContain(c.setup.secret);
    expect(
      await db.taskActivity.count({
        where: { workspaceId, message: 'connected GitHub webhook for owner/repo' },
      }),
    ).toBeGreaterThan(0);
  });
  it('requires both workspace admin and fresh GitHub repo-admin permissions; isolates foreign projects', async () => {
    const p = await project();
    const input = { projectId: p.id, repository: 'owner/repo' };
    await expect(connectRepository({ ...actor(), userId: memberId }, input)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      connectRepository(actor(), { ...input, projectId: foreignProjectId }),
    ).rejects.toMatchObject({ status: 404 });
    expect(provider).not.toHaveBeenCalled();
    await expect(
      db.gitHubRepositoryConnection.create({
        data: {
          workspaceId,
          projectId: foreignProjectId,
          repositoryId: '123',
          repositoryFullName: 'owner/repo',
          encryptedWebhookSecret: encrypt('foreign'),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    provider.mockResolvedValueOnce({
      id: 123,
      full_name: 'owner/repo',
      archived: false,
      permissions: { push: true, admin: false },
    });
    await expect(connectRepository(actor(), input)).rejects.toMatchObject({ status: 403 });
    expect(await db.gitHubRepositoryConnection.count({ where: { projectId: p.id } })).toBe(0);
  });
  it('accepts verified raw bytes durably as PENDING, minimizes fields, and never changes tasks', async () => {
    const c = await connection();
    const before = await db.task.count({ where: { projectId: c.connection.projectId } });
    expect((await deliver(c.connection.id, c.setup.secret)).status).toBe(202);
    const receipt = await db.gitHubWebhookDelivery.findFirstOrThrow({
      where: { connectionId: c.connection.id },
    });
    expect(receipt).toMatchObject({ state: 'PENDING', attempts: 0, data: { repositoryId: '123' } });
    expect(JSON.stringify(receipt)).not.toContain('do-not-store');
    expect(await db.task.count({ where: { projectId: c.connection.projectId } })).toBe(before);
  });
  it('serializes concurrent duplicate delivery IDs and rejects content/event substitution', async () => {
    const c = await connection();
    const deliveryId = randomUUID();
    const responses = await Promise.all([
      deliver(c.connection.id, c.setup.secret, { deliveryId }),
      deliver(c.connection.id, c.setup.secret, { deliveryId }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 202]);
    // An unsigned delivery-ID change cannot enqueue the same signed bytes twice.
    expect((await deliver(c.connection.id, c.setup.secret)).status).toBe(200);
    expect(await db.gitHubWebhookDelivery.count({ where: { connectionId: c.connection.id } })).toBe(
      1,
    );
    expect(
      (
        await deliver(c.connection.id, c.setup.secret, {
          deliveryId,
          body: { repository: { id: 123 }, changed: true },
        })
      ).status,
    ).toBe(409);
  });
  it('rejects forged, unsupported, wrong-repository and malformed deliveries without receipts', async () => {
    const c = await connection();
    for (const [options, status] of [
      [{ signature: 'sha256=' + '0'.repeat(64) }, 401],
      [{ event: 'member' }, 422],
      [{ body: { repository: { id: 456 } } }, 403],
      [{ deliveryId: 'not-a-uuid' }, 400],
      [{ raw: '{' }, 400],
      [{ contentType: 'text/plain' }, 415],
      [{ raw: 'x'.repeat(1024 * 1024 + 1) }, 413],
    ] as const)
      expect((await deliver(c.connection.id, c.setup.secret, options)).status).toBe(status);
    expect(await db.gitHubWebhookDelivery.count({ where: { connectionId: c.connection.id } })).toBe(
      0,
    );
  });
  it('does not let another workspace read, disconnect or sign for this connection', async () => {
    const c = await connection();
    const outsider = { userId: foreignUserId, workspaceId: foreignWorkspaceId, name: 'Outsider' };
    await expect(listRepositoryConnections(outsider, c.connection.projectId)).rejects.toMatchObject(
      { status: 404 },
    );
    await expect(listGitHubDeliveries(outsider, c.connection.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(disconnectRepository(outsider, c.connection.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      listGitHubDeliveries({ ...actor(), userId: memberId }, c.connection.id),
    ).rejects.toMatchObject({ status: 403 });
    // Workspace ownership alone cannot grant access without a GitHub account.
    await expect(
      connectRepository(outsider, { projectId: foreignProjectId, repository: 'owner/repo' }),
    ).rejects.toMatchObject({ status: 409 });
    await db.gitHubConnection.create({
      data: {
        userId: foreignUserId,
        login: 'foreign-owner',
        encryptedToken: encrypt('foreign-fixture-token'),
      },
    });
    const foreign = await connectRepository(outsider, {
      projectId: foreignProjectId,
      repository: 'owner/repo',
    });
    expect((await deliver(c.connection.id, foreign.setup.secret)).status).toBe(401);
  });
  it('allows only one concurrent active project connection and preserves historical receipts on reconnect', async () => {
    const p = await project();
    const input = { projectId: p.id, repository: 'owner/repo' };
    const outcomes = await Promise.allSettled([
      connectRepository(actor(), input),
      connectRepository(actor(), input),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { status: 409 },
    });
    const c = outcomes.find((r) => r.status === 'fulfilled')!;
    if (c.status !== 'fulfilled') throw new Error('Expected connection');
    await deliver(c.value.connection.id, c.value.setup.secret);
    expect(await disconnectRepository(actor(), c.value.connection.id)).toMatchObject({
      changed: true,
    });
    expect(await disconnectRepository(actor(), c.value.connection.id)).toMatchObject({
      changed: false,
    });
    expect((await listGitHubDeliveries(actor(), c.value.connection.id))[0].state).toBe('CANCELLED');
    expect((await deliver(c.value.connection.id, c.value.setup.secret)).status).toBe(404);
    const replacement = await connectRepository(actor(), input);
    expect(replacement.connection.id).not.toBe(c.value.connection.id);
    expect(replacement.setup.secret).not.toBe(c.value.setup.secret);
    expect(await db.gitHubRepositoryConnection.count({ where: { projectId: p.id } })).toBe(2);
    expect(
      await db.gitHubWebhookDelivery.count({ where: { connectionId: c.value.connection.id } }),
    ).toBe(1);
  });
  it('serializes disconnect against incoming events without leaving pending work', async () => {
    const c = await connection();
    const [response] = await Promise.all([
      deliver(c.connection.id, c.setup.secret),
      disconnectRepository(actor(), c.connection.id),
    ]);
    expect([202, 404]).toContain(response.status);
    expect(
      await db.gitHubWebhookDelivery.count({
        where: { connectionId: c.connection.id, state: 'PENDING' },
      }),
    ).toBe(0);
  });
  it('rejects archived-project ingress while permitting safe disconnect', async () => {
    const c = await connection();
    await db.project.update({
      where: { id: c.connection.projectId },
      data: { archivedAt: new Date() },
    });
    expect((await deliver(c.connection.id, c.setup.secret)).status).toBe(409);
    expect(await disconnectRepository(actor(), c.connection.id)).toMatchObject({ changed: true });
  });
});
