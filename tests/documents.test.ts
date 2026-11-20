import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  documentCreate,
  documentEdit,
  documentPermissions,
  documentQuery,
} from '../src/lib/documents';
const m = vi.hoisted(() => ({
  role: 'MEMBER',
  tx: {
    $queryRaw: vi.fn(),
    project: { findFirst: vi.fn() },
    workspaceMember: { findUnique: vi.fn() },
    projectDocument: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    documentGrant: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
  transaction: vi.fn(),
}));
vi.mock('../src/lib/server/db', () => ({ db: { $transaction: m.transaction } }));
import {
  createProjectDocument,
  getProjectDocument,
  listProjectDocuments,
  mutateProjectDocument,
} from '../src/lib/server/documents';
const actor = { userId: 'u', workspaceId: 'w', name: 'Owner' };
const record = () => ({
  id: 'd',
  workspaceId: 'w',
  projectId: 'p',
  ownerId: 'u',
  updatedById: 'u',
  title: 'Architecture',
  summary: '',
  version: 0,
  archivedAt: null as Date | null,
  createdAt: new Date(),
  updatedAt: new Date(),
  owner: { id: 'u', name: 'Owner' },
  grants: [] as { userId: string; access: string }[],
});
beforeEach(() => {
  vi.resetAllMocks();
  m.role = 'MEMBER';
  m.transaction.mockImplementation((f) => f(m.tx));
  m.tx.$queryRaw.mockImplementation(async (sql: TemplateStringsArray) =>
    sql.join('').includes('FROM "Project"')
      ? [{ id: 'p', archivedAt: null }]
      : sql.join('').includes('SELECT "role"')
        ? [{ role: m.role }]
        : [{ userId: 'target' }],
  );
  m.tx.workspaceMember.findUnique.mockResolvedValue({ role: 'MEMBER' });
  m.tx.project.findFirst.mockResolvedValue({ archivedAt: null });
  m.tx.projectDocument.findFirst.mockResolvedValue(record());
  m.tx.projectDocument.create.mockResolvedValue(record());
  m.tx.projectDocument.findMany.mockResolvedValue([record()]);
  m.tx.projectDocument.count.mockResolvedValue(26);
  m.tx.projectDocument.updateMany.mockResolvedValue({ count: 1 });
  m.tx.documentGrant.count.mockResolvedValue(0);
  m.tx.documentGrant.findUnique.mockResolvedValue(null);
  m.tx.documentGrant.findMany.mockResolvedValue([]);
});
describe('document input and access policy', () => {
  it.each(['OWNER', 'ADMIN'])('allows %s management without a grant', (role) =>
    expect(documentPermissions(role, false).manage).toBe(true),
  );
  it('distinguishes private, reader, editor and owner access', () => {
    expect(documentPermissions('MEMBER', false)).toEqual({
      read: false,
      edit: false,
      manage: false,
    });
    expect(documentPermissions('MEMBER', false, 'READER')).toEqual({
      read: true,
      edit: false,
      manage: false,
    });
    expect(documentPermissions('MEMBER', false, 'EDITOR')).toEqual({
      read: true,
      edit: true,
      manage: false,
    });
    expect(documentPermissions('MEMBER', true).manage).toBe(true);
  });
  it.each([
    { title: '' },
    { title: ' ' },
    { title: 'a'.repeat(161) },
    { title: 'ok', ownerId: 'forged' },
    { title: 'ok', body: 'not a collaborative body' },
    { title: 'ok', summary: 'x'.repeat(2001) },
  ])('rejects invalid or unsupported create input %j', (input) =>
    expect(documentCreate.safeParse(input).success).toBe(false),
  );
  it('trims metadata and rejects invalid versions and pagination', () => {
    expect(documentCreate.parse({ title: ' Plan ' })).toEqual({ title: 'Plan', summary: '' });
    expect(documentEdit.safeParse({ title: 'x', version: -1 }).success).toBe(false);
    expect(documentQuery.safeParse({ offset: 10001 }).success).toBe(false);
  });
});
it('creates with authenticated ownership and scope after project locking', async () => {
  await createProjectDocument(actor, 'p', { title: 'Plan' });
  expect(m.tx.$queryRaw.mock.calls[0][0].join('')).toContain('FOR UPDATE OF p');
  expect(m.tx.projectDocument.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: {
        title: 'Plan',
        summary: '',
        projectId: 'p',
        workspaceId: 'w',
        ownerId: 'u',
        updatedById: 'u',
      },
    }),
  );
});
it('lists only accessible documents with bounded pagination and accurate count metadata', async () => {
  const result = await listProjectDocuments(actor, 'p', { offset: 25 });
  expect(result).toMatchObject({ offset: 25, total: 26, hasMore: false });
  const query = m.tx.projectDocument.findMany.mock.calls[0][0];
  expect(query).toMatchObject({
    take: 25,
    skip: 25,
    where: {
      projectId: 'p',
      workspaceId: 'w',
      archivedAt: null,
      OR: [{ ownerId: 'u' }, { grants: { some: { userId: 'u' } } }],
    },
  });
  expect(m.tx.projectDocument.count).toHaveBeenCalledWith({ where: query.where });
});
it('denies revoked workspace membership before returning private documents', async () => {
  m.tx.workspaceMember.findUnique.mockResolvedValue(null);
  await expect(listProjectDocuments(actor, 'p')).rejects.toMatchObject({ status: 404 });
  expect(m.tx.projectDocument.findMany).not.toHaveBeenCalled();
});
it('denies foreign project scope before reading a document', async () => {
  m.tx.project.findFirst.mockResolvedValue(null);
  await expect(getProjectDocument(actor, 'foreign', 'd')).rejects.toMatchObject({ status: 404 });
  expect(m.tx.projectDocument.findFirst).not.toHaveBeenCalled();
});
it('hides private documents from a member without a grant', async () => {
  m.tx.projectDocument.findFirst.mockResolvedValue({ ...record(), ownerId: 'other' });
  await expect(getProjectDocument(actor, 'p', 'd')).rejects.toMatchObject({ status: 404 });
});
it('returns no access-list information to readers and denies rename', async () => {
  m.tx.projectDocument.findFirst.mockResolvedValue({
    ...record(),
    ownerId: 'other',
    grants: [{ userId: 'u', access: 'READER' }],
  });
  const result = await getProjectDocument(actor, 'p', 'd');
  expect(result.grants).toBeUndefined();
  expect(result.permissions).toEqual({ read: true, edit: false, manage: false });
  expect(m.tx.documentGrant.findMany).not.toHaveBeenCalled();
  await expect(
    mutateProjectDocument(actor, 'p', 'd', 'EDIT', { title: 'X', version: 0 }),
  ).rejects.toMatchObject({ status: 403 });
  expect(m.tx.projectDocument.updateMany).not.toHaveBeenCalled();
});
it('allows editor rename but denies grant management and archival', async () => {
  m.tx.projectDocument.findFirst.mockResolvedValue({
    ...record(),
    ownerId: 'other',
    grants: [{ userId: 'u', access: 'EDITOR' }],
  });
  await mutateProjectDocument(actor, 'p', 'd', 'EDIT', { title: 'New', version: 0 });
  expect(m.tx.projectDocument.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ version: 0 }),
      data: expect.objectContaining({ title: 'New', version: { increment: 1 } }),
    }),
  );
  await expect(
    mutateProjectDocument(actor, 'p', 'd', 'ARCHIVE', { version: 0 }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    mutateProjectDocument(actor, 'p', 'd', 'GRANT', { version: 0, access: 'READER' }, 'target'),
  ).rejects.toMatchObject({ status: 403 });
});
it('rejects stale versions before any permission or metadata writes', async () => {
  await expect(
    mutateProjectDocument(actor, 'p', 'd', 'GRANT', { version: 1, access: 'READER' }, 'target'),
  ).rejects.toMatchObject({ status: 409 });
  expect(m.tx.documentGrant.upsert).not.toHaveBeenCalled();
  expect(m.tx.projectDocument.updateMany).not.toHaveBeenCalled();
});
it('blocks writes to archived documents and projects', async () => {
  m.tx.projectDocument.findFirst.mockResolvedValue({ ...record(), archivedAt: new Date() });
  await expect(
    mutateProjectDocument(actor, 'p', 'd', 'ARCHIVE', { version: 0 }),
  ).rejects.toMatchObject({ status: 409 });
  m.tx.$queryRaw.mockResolvedValueOnce([{ id: 'p', archivedAt: new Date() }]);
  await expect(createProjectDocument(actor, 'p', { title: 'X' })).rejects.toMatchObject({
    status: 409,
  });
});
it('rejects granting access to a nonmember or overriding the owner', async () => {
  await expect(
    mutateProjectDocument(actor, 'p', 'd', 'GRANT', { version: 0, access: 'EDITOR' }, 'u'),
  ).rejects.toMatchObject({ status: 400 });
  m.tx.$queryRaw
    .mockResolvedValueOnce([{ id: 'p', archivedAt: null }])
    .mockResolvedValueOnce([{ role: 'MEMBER' }])
    .mockResolvedValueOnce([]);
  await expect(
    mutateProjectDocument(actor, 'p', 'd', 'GRANT', { version: 0, access: 'READER' }, 'foreign'),
  ).rejects.toMatchObject({ status: 404 });
  expect(m.tx.documentGrant.upsert).not.toHaveBeenCalled();
});
it('caps new grants without exposing an incomplete permission list', async () => {
  m.tx.documentGrant.count.mockResolvedValue(100);
  await expect(
    mutateProjectDocument(actor, 'p', 'd', 'GRANT', { version: 0, access: 'READER' }, 'target'),
  ).rejects.toMatchObject({ status: 409 });
});
it('rejects a concurrent version conflict and atomically scopes archival', async () => {
  m.tx.projectDocument.updateMany.mockResolvedValue({ count: 0 });
  await expect(
    mutateProjectDocument(actor, 'p', 'd', 'ARCHIVE', { version: 0 }),
  ).rejects.toMatchObject({ status: 409 });
  expect(m.tx.projectDocument.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ archivedAt: expect.any(Date) }),
      where: { id: 'd', workspaceId: 'w', projectId: 'p', version: 0, archivedAt: null },
    }),
  );
});

it('renames without erasing an omitted existing summary', async () => {
  await mutateProjectDocument(actor, 'p', 'd', 'EDIT', { title: 'Renamed', version: 0 });
  const data = m.tx.projectDocument.updateMany.mock.calls[0][0].data;
  expect(data.title).toBe('Renamed');
  expect(Object.hasOwn(data, 'summary')).toBe(false);
});
