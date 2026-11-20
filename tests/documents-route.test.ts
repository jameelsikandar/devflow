import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  user: vi.fn(),
  member: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock('../src/lib/server/auth', async (original) => ({
  ...(await original<typeof import('../src/lib/server/auth')>()),
  requireUser: m.user,
  membership: m.member,
  rateLimit: vi.fn(),
}));
vi.mock('../src/lib/server/documents', () => ({
  listProjectDocuments: m.list,
  getProjectDocument: m.get,
  createProjectDocument: m.create,
  mutateProjectDocument: m.mutate,
}));
import { GET, POST, PATCH, PUT, DELETE } from '../src/app/api/[...path]/route';
import { HttpError } from '../src/lib/server/errors';
const base = 'http://localhost:3000/api/projects/p/documents';
const params = (path: string[] = []) => ({
  params: Promise.resolve({ path: ['projects', 'p', 'documents', ...path] }),
});
const request = (method: string, suffix = '', value: unknown = {}) =>
  new Request(`${base}${suffix}?workspaceId=w`, {
    method,
    headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
    ...(method !== 'GET' ? { body: JSON.stringify(value) } : {}),
  });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('APP_URL', 'http://localhost:3000');
  m.user.mockResolvedValue({ id: 'actual', name: 'Member' });
  m.member.mockResolvedValue({ role: 'MEMBER' });
  m.list.mockResolvedValue({ documents: [] });
  m.get.mockResolvedValue({ id: 'd' });
  m.create.mockResolvedValue({ id: 'd' });
  m.mutate.mockResolvedValue({ id: 'd' });
});
afterEach(() => vi.unstubAllEnvs());
it('uses authenticated identity and returns no-store scoped lists', async () => {
  const r = await GET(request('GET'), params());
  expect(r.status).toBe(200);
  expect(r.headers.get('Cache-Control')).toContain('no-store');
  expect(m.list).toHaveBeenCalledWith({ userId: 'actual', name: 'Member', workspaceId: 'w' }, 'p', {
    offset: undefined,
    archived: undefined,
  });
});
it('creates a document with 201 and forwards metadata only to validated services', async () => {
  const input = { title: 'Plan', summary: 'A summary' };
  expect((await POST(request('POST', '', input), params())).status).toBe(201);
  expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'actual' }), 'p', input);
});
it('supports view, rename, archive and explicit grant/revoke HTTP methods', async () => {
  expect((await GET(request('GET', '/d'), params(['d']))).status).toBe(200);
  await PATCH(request('PATCH', '/d', { title: 'New', version: 0 }), params(['d']));
  await POST(request('POST', '/d/archive', { version: 1 }), params(['d', 'archive']));
  await PUT(
    request('PUT', '/d/grants/u', { version: 2, access: 'READER' }),
    params(['d', 'grants', 'u']),
  );
  await DELETE(request('DELETE', '/d/grants/u', { version: 3 }), params(['d', 'grants', 'u']));
  expect(m.mutate.mock.calls.map((c) => c[3])).toEqual(['EDIT', 'ARCHIVE', 'GRANT', 'REVOKE']);
  expect(m.mutate.mock.calls[2][5]).toBe('u');
});
it('denies missing authentication, foreign workspace and document access without caching', async () => {
  m.user.mockRejectedValueOnce(new HttpError(401, 'Sign in'));
  const unauth = await GET(request('GET'), params());
  expect(unauth.status).toBe(401);
  expect(unauth.headers.get('Cache-Control')).toContain('no-store');
  m.member.mockRejectedValueOnce(new HttpError(404, 'Workspace not found'));
  expect((await GET(request('GET'), params())).status).toBe(404);
  m.get.mockRejectedValueOnce(new HttpError(404, 'Document not found'));
  expect((await GET(request('GET', '/d'), params(['d']))).status).toBe(404);
  expect(m.list).not.toHaveBeenCalled();
});
it('rejects wrong origin and unsupported deletion without executing mutations', async () => {
  const bad = new Request(`${base}?workspaceId=w`, {
    method: 'POST',
    headers: { Origin: 'https://foreign.invalid' },
    body: '{}',
  });
  expect((await POST(bad, params())).status).toBe(403);
  expect((await DELETE(request('DELETE', '/d'), params(['d']))).status).toBe(405);
  expect(m.mutate).not.toHaveBeenCalled();
  expect(m.create).not.toHaveBeenCalled();
});
it('preserves stale-version conflict responses and validates JSON', async () => {
  m.mutate.mockRejectedValueOnce(new HttpError(409, 'Reload document'));
  expect(
    (await PATCH(request('PATCH', '/d', { title: 'X', version: 0 }), params(['d']))).status,
  ).toBe(409);
  const bad = new Request(`${base}?workspaceId=w`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
    body: '{',
  });
  expect((await POST(bad, params())).status).toBe(400);
});
