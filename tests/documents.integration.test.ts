import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { db } from '../src/lib/server/db';
import {
  createProjectDocument,
  getProjectDocument,
  listProjectDocuments,
  mutateProjectDocument,
} from '../src/lib/server/documents';
let ready = false;
let workspaceId: string, foreignWorkspaceId: string, projectId: string, otherProjectId: string;
let ownerId: string, memberId: string, adminId: string;
const users: string[] = [];
const actor = (userId = ownerId, scope = workspaceId) => ({
  userId,
  workspaceId: scope,
  name: 'Document test actor',
});
beforeAll(async () => {
  // Additional suite-specific guard before any connection, fixture or cleanup.
  if (new URL(process.env.DATABASE_URL ?? '').pathname !== '/devflow_test')
    throw Error('Document integration tests require devflow_test');
  await db.$connect();
  ready = true;
  for (const name of ['owner', 'reader', 'admin'])
    users.push(
      (
        await db.user.create({
          data: {
            name,
            email: `documents-${name}-${randomUUID()}@example.invalid`,
            passwordHash: 'not-a-login',
          },
        })
      ).id,
    );
  [ownerId, memberId, adminId] = users;
  workspaceId = (
    await db.workspace.create({
      data: {
        name: 'Document integration fixtures',
        members: {
          create: [
            { userId: ownerId, role: 'OWNER' },
            { userId: memberId, role: 'MEMBER' },
            { userId: adminId, role: 'ADMIN' },
          ],
        },
      },
    })
  ).id;
  foreignWorkspaceId = (await db.workspace.create({ data: { name: 'Foreign documents' } })).id;
  projectId = (await db.project.create({ data: { name: 'Docs', workspaceId } })).id;
  otherProjectId = (await db.project.create({ data: { name: 'Other docs', workspaceId } })).id;
});
afterAll(async () => {
  if (ready) {
    await db.workspace.deleteMany({
      where: { id: { in: [workspaceId, foreignWorkspaceId].filter(Boolean) } },
    });
    await db.user.deleteMany({ where: { id: { in: users } } });
  }
  await db.$disconnect();
});
const create = () =>
  createProjectDocument(actor(), projectId, { title: 'Project guide', summary: 'Metadata only' });
it('creates, lists and views private metadata with authenticated ownership', async () => {
  const d = await create();
  expect(d).toMatchObject({
    ownerId,
    workspaceId,
    projectId,
    version: 0,
    summary: 'Metadata only',
  });
  expect(
    (await listProjectDocuments(actor(), projectId)).documents.some((x) => x.id === d.id),
  ).toBe(true);
  expect((await getProjectDocument(actor(), projectId, d.id)).title).toBe('Project guide');
  expect(
    (await listProjectDocuments(actor(memberId), projectId)).documents.some((x) => x.id === d.id),
  ).toBe(false);
  await expect(getProjectDocument(actor(memberId), projectId, d.id)).rejects.toMatchObject({
    status: 404,
  });
});
it('allows members to own private documents and administrators to manage them', async () => {
  const d = await createProjectDocument(actor(memberId), projectId, { title: 'Member document' });
  expect(d.permissions.manage).toBe(true);
  expect((await getProjectDocument(actor(adminId), projectId, d.id)).permissions.manage).toBe(true);
  await mutateProjectDocument(actor(adminId), projectId, d.id, 'EDIT', {
    title: 'Admin rename',
    version: 0,
  });
  expect((await getProjectDocument(actor(memberId), projectId, d.id)).title).toBe('Admin rename');
});
it('enforces reader/editor grants, management boundaries and revocation', async () => {
  const d = await create();
  await mutateProjectDocument(
    actor(),
    projectId,
    d.id,
    'GRANT',
    { version: 0, access: 'READER' },
    memberId,
  );
  const read = await getProjectDocument(actor(memberId), projectId, d.id);
  expect(read.permissions.edit).toBe(false);
  expect(read.grants).toBeUndefined();
  await expect(
    mutateProjectDocument(actor(memberId), projectId, d.id, 'EDIT', {
      title: 'Denied',
      version: 1,
    }),
  ).rejects.toMatchObject({ status: 403 });
  await mutateProjectDocument(
    actor(),
    projectId,
    d.id,
    'GRANT',
    { version: 1, access: 'EDITOR' },
    memberId,
  );
  await mutateProjectDocument(actor(memberId), projectId, d.id, 'EDIT', {
    title: 'Editor rename',
    version: 2,
  });
  await expect(
    mutateProjectDocument(actor(memberId), projectId, d.id, 'ARCHIVE', { version: 3 }),
  ).rejects.toMatchObject({ status: 403 });
  await mutateProjectDocument(actor(), projectId, d.id, 'REVOKE', { version: 3 }, memberId);
  await expect(getProjectDocument(actor(memberId), projectId, d.id)).rejects.toMatchObject({
    status: 404,
  });
  expect((await db.projectDocument.findUniqueOrThrow({ where: { id: d.id } })).version).toBe(4);
});
it('archives without deleting records or access grants and blocks later edits', async () => {
  const d = await create();
  await mutateProjectDocument(
    actor(),
    projectId,
    d.id,
    'GRANT',
    { version: 0, access: 'READER' },
    memberId,
  );
  await mutateProjectDocument(actor(), projectId, d.id, 'ARCHIVE', { version: 1 });
  expect((await getProjectDocument(actor(memberId), projectId, d.id)).archivedAt).not.toBeNull();
  expect(
    (await listProjectDocuments(actor(), projectId)).documents.some((x) => x.id === d.id),
  ).toBe(false);
  expect(
    (await listProjectDocuments(actor(), projectId, { archived: 'true' })).documents.some(
      (x) => x.id === d.id,
    ),
  ).toBe(true);
  await expect(
    mutateProjectDocument(actor(), projectId, d.id, 'EDIT', { title: 'No', version: 2 }),
  ).rejects.toMatchObject({ status: 409 });
  expect(await db.documentGrant.count({ where: { documentId: d.id } })).toBe(1);
});
it('isolates document IDs across projects and workspaces and rejects foreign grantees', async () => {
  const d = await create();
  await expect(getProjectDocument(actor(), otherProjectId, d.id)).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    getProjectDocument(actor(ownerId, foreignWorkspaceId), projectId, d.id),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    mutateProjectDocument(
      actor(),
      projectId,
      d.id,
      'GRANT',
      { version: 0, access: 'EDITOR' },
      randomUUID(),
    ),
  ).rejects.toMatchObject({ status: 404 });
  expect((await db.projectDocument.findUniqueOrThrow({ where: { id: d.id } })).version).toBe(0);
});
it('database constraints reject mismatched grant project and membership scopes', async () => {
  const d = await create();
  await expect(
    db.documentGrant.create({
      data: {
        documentId: d.id,
        workspaceId,
        projectId: otherProjectId,
        userId: memberId,
        access: 'EDITOR',
      },
    }),
  ).rejects.toMatchObject({ code: 'P2003' });
  await expect(
    db.documentGrant.create({
      data: {
        documentId: d.id,
        workspaceId: foreignWorkspaceId,
        projectId,
        userId: memberId,
        access: 'EDITOR',
      },
    }),
  ).rejects.toMatchObject({ code: 'P2003' });
  await expect(
    db.projectDocument.create({
      data: { workspaceId: foreignWorkspaceId, projectId, ownerId, title: 'Foreign' },
    }),
  ).rejects.toMatchObject({ code: 'P2003' });
});
it('concurrent metadata writes accept one version and reject the stale writer', async () => {
  const d = await create();
  const results = await Promise.allSettled(
    ['First', 'Second'].map((title) =>
      mutateProjectDocument(actor(), projectId, d.id, 'EDIT', { title, version: 0 }),
    ),
  );
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  const denied = results.find((r) => r.status === 'rejected');
  expect(denied?.status === 'rejected' && denied.reason.status).toBe(409);
  expect((await db.projectDocument.findUniqueOrThrow({ where: { id: d.id } })).version).toBe(1);
});
it('stale grant mutations leave both permissions and metadata unchanged', async () => {
  const d = await create();
  await mutateProjectDocument(actor(), projectId, d.id, 'EDIT', { title: 'Current', version: 0 });
  await expect(
    mutateProjectDocument(
      actor(),
      projectId,
      d.id,
      'GRANT',
      { version: 0, access: 'EDITOR' },
      memberId,
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(await db.documentGrant.count({ where: { documentId: d.id } })).toBe(0);
  expect((await getProjectDocument(actor(), projectId, d.id)).title).toBe('Current');
  expect((await getProjectDocument(actor(), projectId, d.id)).summary).toBe('Metadata only');
});
it('membership removal cascades grants and prevents subsequent reads or writes', async () => {
  const user = await db.user.create({
    data: {
      email: `removed-${randomUUID()}@example.invalid`,
      name: 'Removed',
      passwordHash: 'not-a-login',
    },
  });
  users.push(user.id);
  await db.workspaceMember.create({ data: { workspaceId, userId: user.id } });
  const d = await create();
  await mutateProjectDocument(
    actor(),
    projectId,
    d.id,
    'GRANT',
    { version: 0, access: 'EDITOR' },
    user.id,
  );
  await db.workspaceMember.delete({
    where: { workspaceId_userId: { workspaceId, userId: user.id } },
  });
  expect(await db.documentGrant.count({ where: { documentId: d.id, userId: user.id } })).toBe(0);
  await expect(getProjectDocument(actor(user.id), projectId, d.id)).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    mutateProjectDocument(actor(user.id), projectId, d.id, 'EDIT', { title: 'No', version: 1 }),
  ).rejects.toMatchObject({ status: 404 });
});
it('archived project is readable but prevents creation and metadata writes', async () => {
  const p = await db.project.create({ data: { workspaceId, name: 'Archived' } });
  const d = await createProjectDocument(actor(), p.id, { title: 'Before' });
  await db.project.update({ where: { id: p.id }, data: { archivedAt: new Date() } });
  expect((await getProjectDocument(actor(), p.id, d.id)).projectArchived).toBe(true);
  await expect(createProjectDocument(actor(), p.id, { title: 'After' })).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    mutateProjectDocument(actor(), p.id, d.id, 'ARCHIVE', { version: 0 }),
  ).rejects.toMatchObject({ status: 409 });
});
it('paginates with accurate accessible counts while hiding ungranted documents', async () => {
  const p = await db.project.create({ data: { workspaceId, name: 'Pagination' } });
  await db.projectDocument.createMany({
    data: Array.from({ length: 26 }, (_, i) => ({
      projectId: p.id,
      workspaceId,
      ownerId,
      title: `Page ${i}`,
    })),
  });
  const first = await listProjectDocuments(actor(), p.id),
    last = await listProjectDocuments(actor(), p.id, { offset: 25 });
  expect(first).toMatchObject({ total: 26, hasMore: true });
  expect(first.documents).toHaveLength(25);
  expect(last).toMatchObject({ total: 26, hasMore: false });
  expect(last.documents).toHaveLength(1);
  expect((await listProjectDocuments(actor(memberId), p.id)).total).toBe(0);
});
