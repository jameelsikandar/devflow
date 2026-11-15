import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/lib/server/db';
import { taskGitHubActivity } from '../src/lib/server/task-github';
import { taskPublicInclude } from '../src/lib/server/tasks';
import { encrypt } from '../src/lib/server/crypto';
import { normalizeGitHubEvent } from '../src/lib/server/github-webhook';
import { reconcileGitHubCommit } from '../src/lib/server/github-reconciliation';
import {
  claimGitHubDelivery,
  completeGitHubDelivery,
  failGitHubDelivery,
  recoverExpiredDeliveries,
  workerOptions,
} from '../src/lib/server/github-processing';
import { githubEventFacts, GitHubProcessingError } from '../src/lib/server/github-event-handlers';
import { publishGitHubFacts } from '../src/lib/server/github-activity';
import { processNextGitHubDelivery } from '../src/lib/server/github-job';
import { disconnectRepository } from '../src/lib/server/github-repositories';
import {
  githubProcessingStatus,
  githubProjectActivity,
  retryGitHubDelivery,
  setGitHubEnrichment,
} from '../src/lib/server/github-monitoring';
import type { Prisma } from '@prisma/client';
let connected = false;
const users: string[] = [];
const workspaces: string[] = [];
let userId = '';
let memberId = '';
let outsiderId = '';
let workspaceId = '';
let foreignWorkspace = '';
const actor = () => ({ userId, workspaceId, name: 'Worker owner' });
const fetchMock = vi.fn();
beforeAll(async () => {
  vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'ab'.repeat(32));
  await db.$connect();
  connected = true;
  for (const name of ['owner', 'member', 'outsider'])
    users.push(
      (
        await db.user.create({
          data: {
            name,
            email: `worker-${name}-${randomUUID()}@example.com`,
            passwordHash: 'not-a-login',
          },
        })
      ).id,
    );
  [userId, memberId, outsiderId] = users;
  workspaceId = (
    await db.workspace.create({
      data: {
        name: 'Worker fixture',
        members: {
          create: [
            { userId, role: 'OWNER' },
            { userId: memberId, role: 'MEMBER' },
          ],
        },
      },
    })
  ).id;
  workspaces.push(workspaceId);
  foreignWorkspace = (
    await db.workspace.create({
      data: { name: 'Foreign fixture', members: { create: { userId: outsiderId, role: 'OWNER' } } },
    })
  ).id;
  workspaces.push(foreignWorkspace);
});
beforeEach(async () => {
  fetchMock.mockReset().mockRejectedValue(new Error('Unexpected external request'));
  vi.stubGlobal('fetch', fetchMock);
  if (connected)
    await db.gitHubConnection.upsert({
      where: { userId },
      create: { userId, login: 'owner', encryptedToken: encrypt('fake-worker-oauth') },
      update: { encryptedToken: encrypt('fake-worker-oauth') },
    });
});
afterAll(async () => {
  try {
    if (connected) {
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
  const project = await db.project.create({ data: { workspaceId, name: 'Worker project' } });
  const connection = await db.gitHubRepositoryConnection.create({
    data: {
      projectId: project.id,
      workspaceId,
      repositoryId: '123',
      repositoryFullName: 'owner/repo',
      encryptedWebhookSecret: encrypt('fake-webhook-secret'),
      connectedById: userId,
    },
  });
  const options = workerOptions.parse({ connectionId: connection.id });
  const enqueue = (event = 'ping', data: unknown = { repositoryId: '123' }, version = 1) =>
    db.gitHubWebhookDelivery.create({
      data: {
        connectionId: connection.id,
        event,
        deliveryId: randomUUID(),
        payloadHash: randomUUID(),
        dataVersion: version,
        data: data as Prisma.InputJsonValue,
      },
    });
  return { project, connection, options, enqueue };
}
const push = (refs: string[], ref = 'refs/heads/main') => ({
  repositoryId: '123',
  ref,
  before: 'a'.repeat(40),
  after: 'b'.repeat(40),
  deleted: false,
  commitCount: 1,
  commitsTruncated: false,
  commits: [{ sha: 'c'.repeat(40), taskRefs: refs }],
});
const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(value), { status, headers });
const repo = { id: 123, full_name: 'owner/repo', archived: false, permissions: { admin: true } };
describe.sequential('real PostgreSQL GitHub worker transactions', () => {
  it('claims a legacy ping atomically across competing workers and processes without task activity', async () => {
    const f = await fixture();
    const d = await f.enqueue();
    const before = await db.taskActivity.count({ where: { workspaceId } });
    const claims = await Promise.all(
      Array.from({ length: 4 }, () => claimGitHubDelivery(f.options)),
    );
    const leases = claims.filter((r) => r !== null);
    expect(leases).toHaveLength(1);
    expect(await completeGitHubDelivery(leases[0]!)).toBe(true);
    expect((await db.gitHubWebhookDelivery.findUniqueOrThrow({ where: { id: d.id } })).state).toBe(
      'PROCESSED',
    );
    expect(await completeGitHubDelivery(leases[0]!)).toBe(false);
    expect(await db.taskActivity.count({ where: { workspaceId } })).toBe(before);
  });
  it('recovers abandoned leases and rejects old-owner completion/failure after replacement', async () => {
    const f = await fixture();
    await f.enqueue();
    const old = (await claimGitHubDelivery(f.options))!;
    await db.gitHubWebhookDelivery.update({
      where: { id: old.id },
      data: { leaseExpiresAt: new Date(0) },
    });
    expect(await completeGitHubDelivery(old)).toBe(false);
    await recoverExpiredDeliveries(8, f.connection.id);
    const current = (await claimGitHubDelivery(f.options))!;
    expect(current.leaseToken).not.toBe(old.leaseToken);
    expect(current.attempts).toBe(2);
    expect(await failGitHubDelivery(old, new Error('old worker'), f.options)).toBe(false);
    expect(await completeGitHubDelivery(current)).toBe(true);
  });
  it('rolls back activity and completion together if a worker crashes mid-publication', async () => {
    const f = await fixture();
    const data = push([]);
    const d = await f.enqueue('push', data);
    const lease = (await claimGitHubDelivery(f.options))!;
    await expect(
      completeGitHubDelivery(lease, async (tx, context) => {
        await publishGitHubFacts(tx, context, githubEventFacts('push', 1, data));
        throw new Error('simulated crash');
      }),
    ).rejects.toThrow('simulated crash');
    expect(await db.gitHubObject.count({ where: { projectId: f.project.id } })).toBe(0);
    expect((await db.gitHubWebhookDelivery.findUniqueOrThrow({ where: { id: d.id } })).state).toBe(
      'PROCESSING',
    );
    await db.gitHubWebhookDelivery.update({
      where: { id: lease.id },
      data: { leaseExpiresAt: new Date(0) },
    });
    await recoverExpiredDeliveries(8, f.connection.id);
    await processNextGitHubDelivery(f.options);
    expect(await db.gitHubObject.count({ where: { projectId: f.project.id } })).toBe(1);
  });
  it('rolls back writes when a lease expires during publication', async () => {
    const f = await fixture();
    const data = push([]);
    await f.enqueue('push', data);
    const lease = (await claimGitHubDelivery(f.options))!;
    await expect(
      completeGitHubDelivery(lease, async (tx, context) => {
        await publishGitHubFacts(tx, context, githubEventFacts('push', 1, data));
        await tx.gitHubWebhookDelivery.update({
          where: { id: lease.id },
          data: { leaseExpiresAt: new Date(0) },
        });
      }),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(await db.gitHubObject.count({ where: { projectId: f.project.id } })).toBe(0);
  });
  it('schedules backoff/provider cooldown and dead-letters exhausted failures', async () => {
    const f = await fixture();
    await f.enqueue();
    const lease = (await claimGitHubDelivery(f.options))!;
    const retryAt = Date.now() + 900000;
    await failGitHubDelivery(
      lease,
      new GitHubProcessingError('GITHUB_RATE_LIMITED', true, retryAt),
      f.options,
    );
    const failed = await db.gitHubWebhookDelivery.findUniqueOrThrow({ where: { id: lease.id } });
    expect(+failed.availableAt).toBeGreaterThanOrEqual(retryAt);
    expect(failed.deadLetteredAt).toBeNull();
    expect(await claimGitHubDelivery(f.options)).toBeNull();
    await recoverExpiredDeliveries(1, f.connection.id);
    expect(
      (await db.gitHubWebhookDelivery.findUniqueOrThrow({ where: { id: lease.id } }))
        .deadLetteredAt,
    ).not.toBeNull();
    await db.gitHubWebhookDelivery.update({
      where: { id: lease.id },
      data: { availableAt: new Date(0), attempts: 0, deadLetteredAt: null },
    });
    const last = (await claimGitHubDelivery({ ...f.options, maxAttempts: 1 }))!;
    await failGitHubDelivery(last, new Error('private failure'), { ...f.options, maxAttempts: 1 });
    expect(
      (await db.gitHubWebhookDelivery.findUniqueOrThrow({ where: { id: lease.id } }))
        .deadLetteredAt,
    ).not.toBeNull();
  });
  it('dead-letters corrupt versions without unbounded retries', async () => {
    const f = await fixture();
    const d = await f.enqueue('ping', { repositoryId: '123' }, 99);
    await processNextGitHubDelivery(f.options);
    expect(await db.gitHubWebhookDelivery.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject(
      { state: 'FAILED', errorCode: 'UNSUPPORTED_DATA_VERSION', deadLetteredAt: expect.any(Date) },
    );
  });
  it('deduplicates commit objects/links, records separate evidence and never mutates tasks', async () => {
    const f = await fixture();
    const task = await db.task.create({
      data: {
        projectId: f.project.id,
        title: 'Tracked task',
        status: 'IN_REVIEW',
        priority: 'HIGH',
        version: 7,
      },
    });
    const ref = `DEV-${task.number}`;
    await f.enqueue('push', push([ref, ref]));
    await f.enqueue('push', push([ref], 'refs/heads/other'));
    await Promise.all([processNextGitHubDelivery(f.options), processNextGitHubDelivery(f.options)]);
    expect(await db.gitHubObject.count({ where: { projectId: f.project.id } })).toBe(1);
    expect(await db.gitHubTaskLink.count({ where: { projectId: f.project.id } })).toBe(1);
    const object = await db.gitHubObject.findFirstOrThrow({ where: { projectId: f.project.id } });
    expect(await db.gitHubObservation.count({ where: { objectId: object.id } })).toBe(2);
    expect(await db.gitHubTaskLinkEvidence.count({ where: { objectId: object.id } })).toBe(2);
    expect(await db.task.findUniqueOrThrow({ where: { id: task.id } })).toEqual(task);
    expect(await db.sprintTask.count({ where: { taskId: task.id } })).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('resolves multiple local references while preserving unresolved cross-project/workspace references', async () => {
    const f = await fixture();
    const other = await db.project.create({ data: { workspaceId, name: 'Other' } });
    const foreign = await db.project.create({
      data: { workspaceId: foreignWorkspace, name: 'Foreign' },
    });
    const tasks = await Promise.all(
      [f.project.id, f.project.id, other.id, foreign.id].map((projectId) =>
        db.task.create({ data: { projectId, title: 'Scope fixture' } }),
      ),
    );
    await f.enqueue('push', push(tasks.map((t) => `DEV-${t.number}`)));
    await processNextGitHubDelivery(f.options);
    expect(await db.gitHubTaskLink.count({ where: { projectId: f.project.id } })).toBe(2);
    const observation = await db.gitHubObservation.findFirstOrThrow({
      where: { projectId: f.project.id },
    });
    expect(observation.unresolvedRefs.sort()).toEqual(
      tasks
        .slice(2)
        .map((t) => `DEV-${t.number}`)
        .sort(),
    );
    await expect(
      db.gitHubTaskLink.create({
        data: {
          projectId: f.project.id,
          repositoryId: '123',
          objectId: observation.objectId,
          taskId: tasks[3].id,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
  it('keeps immutable observations and prevents older/legacy source state from overwriting current projections', async () => {
    const f = await fixture();
    const value = (state: string, sourceUpdatedAt?: string) => ({
      repositoryId: '123',
      number: 7,
      action: 'edited',
      state,
      taskRefs: [],
      ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
    });
    await f.enqueue('issues', value('closed', '2026-11-14T12:00:00Z'), 2);
    await processNextGitHubDelivery(f.options);
    await f.enqueue('issues', value('open', '2026-11-14T11:00:00Z'), 2);
    await processNextGitHubDelivery(f.options);
    await f.enqueue('issues', value('open'));
    await processNextGitHubDelivery(f.options);
    expect(
      (await db.gitHubObject.findFirstOrThrow({ where: { projectId: f.project.id } })).currentData,
    ).toMatchObject({ state: 'closed' });
    expect(await db.gitHubObservation.count({ where: { projectId: f.project.id } })).toBe(3);
  });
  it('fences disconnect races and never leaves unfinished work publishable', async () => {
    const f = await fixture();
    const data = push([]);
    await f.enqueue('push', data);
    const lease = (await claimGitHubDelivery(f.options))!;
    const [completed] = await Promise.all([
      completeGitHubDelivery(lease, (tx, context) =>
        publishGitHubFacts(tx, context, githubEventFacts('push', 1, data)),
      ),
      disconnectRepository(actor(), f.connection.id),
    ]);
    const row = await db.gitHubWebhookDelivery.findUniqueOrThrow({ where: { id: lease.id } });
    expect(row.state).toBe(completed ? 'PROCESSED' : 'CANCELLED');
    expect(await completeGitHubDelivery(lease)).toBe(false);
    expect(await claimGitHubDelivery(f.options)).toBeNull();
    expect(await db.gitHubObject.count({ where: { projectId: f.project.id } })).toBe(
      completed ? 1 : 0,
    );
  });
  it('authorizes monitoring/retry and prevents processed delivery replay', async () => {
    const f = await fixture();
    await f.enqueue();
    const lease = (await claimGitHubDelivery(f.options))!;
    await failGitHubDelivery(lease, new GitHubProcessingError('INVALID_STORED_EVENT'), f.options);
    await expect(
      retryGitHubDelivery({ ...actor(), userId: memberId }, f.connection.id, lease.id),
    ).rejects.toMatchObject({ status: 403 });
    const outsider = { userId: outsiderId, workspaceId: foreignWorkspace, name: 'Outsider' };
    await expect(githubProcessingStatus(outsider, f.connection.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(githubProjectActivity(outsider, f.project.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(retryGitHubDelivery(outsider, f.connection.id, lease.id)).rejects.toMatchObject({
      status: 404,
    });
    expect((await githubProcessingStatus(actor(), f.connection.id, 'FAILED')).total).toBe(1);
    await retryGitHubDelivery(actor(), f.connection.id, lease.id);
    await processNextGitHubDelivery(f.options);
    await expect(retryGitHubDelivery(actor(), f.connection.id, lease.id)).rejects.toMatchObject({
      status: 409,
    });
    expect((await githubProcessingStatus(actor(), f.connection.id)).counts.PROCESSED).toBe(1);
  });
  it('requires explicit enrichment permission and verifies the repository with mocked GitHub', async () => {
    const f = await fixture();
    await expect(
      setGitHubEnrichment({ ...actor(), userId: memberId }, f.connection.id, { enabled: true }),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(json(repo));
    await setGitHubEnrichment(actor(), f.connection.id, { enabled: true });
    await f.enqueue('issues', {
      repositoryId: '123',
      number: 7,
      action: 'opened',
      state: 'open',
      taskRefs: [],
    });
    fetchMock.mockResolvedValueOnce(json(repo)).mockResolvedValueOnce(
      json({
        number: 7,
        state: 'closed',
        updated_at: '2026-11-14T13:00:00Z',
        title: 'Private title',
        body: null,
      }),
    );
    fetchMock.mockResolvedValueOnce(json(repo));
    await processNextGitHubDelivery(f.options);
    expect(
      (await db.gitHubObject.findFirstOrThrow({ where: { projectId: f.project.id } })).currentData,
    ).toMatchObject({ state: 'closed' });
    expect(JSON.stringify(await githubProjectActivity(actor(), f.project.id))).not.toContain(
      'Private title',
    );
  });
  it('processes local facts after OAuth revocation and discards enrichment revoked during an in-flight request', async () => {
    const f = await fixture();
    await db.gitHubRepositoryConnection.update({
      where: { id: f.connection.id },
      data: { enrichmentUserId: userId, enrichmentAuthorizedAt: new Date(), enrichmentVersion: 1 },
    });
    const value = { repositoryId: '123', number: 7, action: 'opened', state: 'open', taskRefs: [] };
    await f.enqueue('issues', value);
    fetchMock.mockResolvedValueOnce(json({ message: 'Bad credentials' }, 401));
    await processNextGitHubDelivery(f.options);
    expect(
      (await db.gitHubObservation.findFirstOrThrow({ where: { projectId: f.project.id } }))
        .enrichmentCode,
    ).toBe('GITHUB_CREDENTIALS_REVOKED');
    await f.enqueue('issues', { ...value, number: 8 });
    fetchMock.mockResolvedValueOnce(json(repo)).mockImplementationOnce(async () => {
      await db.gitHubConnection.delete({ where: { userId } });
      return json({
        number: 8,
        state: 'closed',
        updated_at: '2026-11-14T14:00:00Z',
        title: '',
        body: null,
      });
    });
    await processNextGitHubDelivery(f.options);
    const object = await db.gitHubObject.findFirstOrThrow({
      where: { projectId: f.project.id, key: '8' },
    });
    expect(object.currentData).toBeNull();
    expect(
      (await db.gitHubObservation.findFirstOrThrow({ where: { objectId: object.id } }))
        .enrichmentCode,
    ).toBe('ENRICHMENT_AUTH_CHANGED');
  });
  it('links padded numeric references extracted from commit messages without changing task data', async () => {
    const f = await fixture();
    const task = await db.task.create({
      data: { projectId: f.project.id, title: 'Padded reference task', version: 4 },
    });
    const message = `test: verify DevFlow task linking DEV-${String(task.number).padStart(3, '0')}`;
    const sha = '9023d37' + 'a'.repeat(33);
    const normalized = normalizeGitHubEvent(
      'push',
      Buffer.from(
        JSON.stringify({
          repository: { id: 123 },
          ref: 'refs/heads/main',
          before: 'a'.repeat(40),
          after: sha,
          commits: [{ id: sha, message }],
        }),
      ),
    );
    await f.enqueue('push', normalized.data, 2);
    await processNextGitHubDelivery(f.options);
    expect(await db.gitHubTaskLink.count({ where: { taskId: task.id } })).toBe(1);
    expect(await db.gitHubTaskLinkEvidence.count({ where: { taskId: task.id } })).toBe(1);
    expect(await db.task.findUniqueOrThrow({ where: { id: task.id } })).toEqual(task);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('reconciles already-processed empty-reference commits without duplicating immutable observations', async () => {
    const f = await fixture();
    const task = await db.task.create({
      data: { projectId: f.project.id, title: 'Recovery task', version: 8 },
    });
    const sha = '9023d37' + 'a'.repeat(33);
    const message = `test: verify DevFlow task linking DEV-${String(task.number).padStart(3, '0')}`;
    const data = { ...push([]), commits: [{ sha, taskRefs: [] }] };
    const delivery = await f.enqueue('push', data);
    await processNextGitHubDelivery(f.options);
    const original = await db.gitHubObservation.findFirstOrThrow({
      where: { projectId: f.project.id },
    });
    const object = await db.gitHubObject.findUniqueOrThrow({ where: { id: original.objectId } });
    await expect(reconcileGitHubCommit(actor(), f.connection.id, '9023d37')).rejects.toMatchObject({
      status: 403,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(json(repo));
    await setGitHubEnrichment(actor(), f.connection.id, { enabled: true });
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).pathname.endsWith(`/commits/${sha}`)
        ? json({ sha, commit: { message } })
        : json(repo),
    );
    expect(await reconcileGitHubCommit(actor(), f.connection.id, '9023d37')).toMatchObject({
      references: [`DEV-${task.number}`],
      linksCreated: 1,
      evidenceCreated: 1,
    });
    expect(await reconcileGitHubCommit(actor(), f.connection.id, '9023d37')).toMatchObject({
      linksCreated: 0,
      evidenceCreated: 0,
    });
    expect(await db.gitHubObservation.findUniqueOrThrow({ where: { id: original.id } })).toEqual(
      original,
    );
    expect(await db.gitHubObservation.count({ where: { projectId: f.project.id } })).toBe(1);
    expect(await db.gitHubObject.findUniqueOrThrow({ where: { id: object.id } })).toEqual(object);
    expect(
      (await db.gitHubWebhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).state,
    ).toBe('PROCESSED');
    expect(await db.gitHubTaskLink.count({ where: { taskId: task.id } })).toBe(1);
    expect(await db.gitHubTaskLinkEvidence.count({ where: { taskId: task.id } })).toBe(1);
    expect(await db.task.findUniqueOrThrow({ where: { id: task.id } })).toEqual(task);
  });
  it('reads all linked kinds in task details, supplies card counts and preserves task data', async () => {
    const f = await fixture();
    const task = await db.task.create({
      data: {
        projectId: f.project.id,
        title: 'GitHub visibility',
        status: 'IN_REVIEW',
        version: 9,
      },
    });
    const refs = [`DEV-${task.number}`];
    const sha = '9023d37' + 'a'.repeat(33);
    await f.enqueue('push', { ...push(refs), commits: [{ sha, taskRefs: refs }] });
    await f.enqueue('pull_request', {
      repositoryId: '123',
      action: 'closed',
      number: 7,
      state: 'closed',
      merged: true,
      mergeCommitSha: 'a'.repeat(40),
      taskRefs: refs,
    });
    await f.enqueue('issues', {
      repositoryId: '123',
      action: 'opened',
      number: 8,
      state: 'open',
      taskRefs: refs,
    });
    await f.enqueue(
      'workflow_run',
      {
        repositoryId: '123',
        action: 'completed',
        runId: 9,
        sha,
        status: 'completed',
        conclusion: 'success',
        taskRefs: refs,
      },
      2,
    );
    for (let i = 0; i < 4; i++) await processNextGitHubDelivery(f.options);
    const before = await db.taskActivity.count({ where: { workspaceId } });
    const result = await taskGitHubActivity({ ...actor(), userId: memberId }, task.id);
    expect(result.total).toBe(4);
    expect(result.items.map((i) => i.kind).sort()).toEqual([
      'COMMIT',
      'ISSUE',
      'PULL_REQUEST',
      'WORKFLOW_RUN',
    ]);
    expect(result.items.find((i) => i.kind === 'COMMIT')?.url).toBe(
      `https://github.com/owner/repo/commit/${sha}`,
    );
    expect(result.items.find((i) => i.kind === 'PULL_REQUEST')).toMatchObject({
      status: 'Merged',
      statusSource: 'observation',
      url: 'https://github.com/owner/repo/pull/7',
    });
    expect(result.items.find((i) => i.kind === 'WORKFLOW_RUN')?.status).toBe('Completed · Success');
    expect(JSON.stringify(result)).not.toMatch(
      /encryptedToken|encryptedWebhookSecret|fake-webhook-secret|taskRefs/,
    );
    const counted = await db.task.findUniqueOrThrow({
      where: { id: task.id },
      include: taskPublicInclude,
    });
    expect(counted._count.githubLinks).toBe(4);
    expect(await db.task.findUniqueOrThrow({ where: { id: task.id } })).toEqual(task);
    expect(await db.taskActivity.count({ where: { workspaceId } })).toBe(before);
    expect(fetchMock).not.toHaveBeenCalled();
    await disconnectRepository(actor(), f.connection.id);
    expect(
      (await taskGitHubActivity(actor(), task.id)).items.every(
        (i) => i.connection === 'disconnected' && i.url !== null,
      ),
    ).toBe(true);
  });
  it('isolates task GitHub reads from foreign workspaces and other tasks, including missing memberships', async () => {
    const f = await fixture();
    const task = await db.task.create({
      data: { projectId: f.project.id, title: 'Protected activity' },
    });
    await f.enqueue('push', push([`DEV-${task.number}`]));
    await processNextGitHubDelivery(f.options);
    const outsider = { userId: outsiderId, workspaceId: foreignWorkspace, name: 'Outsider' };
    await expect(taskGitHubActivity(outsider, task.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      taskGitHubActivity({ ...actor(), userId: outsiderId }, task.id),
    ).rejects.toMatchObject({ status: 404 });
    const other = await db.task.create({ data: { projectId: f.project.id, title: 'Other task' } });
    expect(await taskGitHubActivity(actor(), other.id)).toMatchObject({ total: 0, items: [] });
  });
  it('paginates task-linked objects without duplicate rows or losing the true total', async () => {
    const f = await fixture();
    const task = await db.task.create({ data: { projectId: f.project.id, title: 'Many commits' } });
    const commits = Array.from({ length: 11 }, (_, i) => ({
      sha: (i + 1).toString(16).padStart(40, '0'),
      taskRefs: [`DEV-${task.number}`],
    }));
    await f.enqueue('push', { ...push([]), commits, commitCount: 11 });
    await processNextGitHubDelivery(f.options);
    const first = await taskGitHubActivity(actor(), task.id);
    const next = await taskGitHubActivity(actor(), task.id, 10);
    expect(first).toMatchObject({ total: 11, offset: 0, limit: 10, hasMore: true });
    expect(first.items).toHaveLength(10);
    expect(next).toMatchObject({ total: 11, offset: 10, hasMore: false });
    expect(next.items).toHaveLength(1);
    expect(new Set([...first.items, ...next.items].map((i) => i.id)).size).toBe(11);
  });
});
