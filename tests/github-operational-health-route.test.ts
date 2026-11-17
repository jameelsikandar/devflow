import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ user: vi.fn(), membership: vi.fn(), health: vi.fn() }));
vi.mock('../src/lib/server/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/server/auth')>()),
  requireUser: m.user,
  membership: m.membership,
  rateLimit: vi.fn(),
}));
vi.mock('../src/lib/server/github-operational-health', () => ({
  githubOperationalHealth: m.health,
}));
import { GET, POST } from '../src/app/api/[...path]/route';
import { HttpError } from '../src/lib/server/errors';
const params = { params: Promise.resolve({ path: ['github', 'repositories', 'c', 'health'] }) };
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('APP_URL', 'http://localhost:3000');
  m.user.mockResolvedValue({ id: 'actual-user', name: 'Admin' });
  m.membership.mockResolvedValue({ role: 'OWNER' });
  m.health.mockResolvedValue({ worker: { state: 'INSUFFICIENT_EVIDENCE' } });
});
afterEach(() => vi.unstubAllEnvs());
it('uses authenticated identity, preserves workspace scope, and prevents caching', async () => {
  const response = await GET(
    new Request(
      'http://localhost:3000/api/github/repositories/c/health?workspaceId=w&userId=forged&projectId=forged',
    ),
    params,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(m.health).toHaveBeenCalledWith(
    { userId: 'actual-user', workspaceId: 'w', name: 'Admin' },
    'c',
  );
});
it('requires authentication, membership and administrator service authorization', async () => {
  const request = () =>
    new Request('http://localhost:3000/api/github/repositories/c/health?workspaceId=w');
  m.user.mockRejectedValueOnce(new HttpError(401, 'Please sign in'));
  const unauthenticated = await GET(request(), params);
  expect(unauthenticated.status).toBe(401);
  expect(unauthenticated.headers.get('Cache-Control')).toBe('no-store');
  m.membership.mockRejectedValueOnce(new HttpError(404, 'Workspace not found'));
  expect((await GET(request(), params)).status).toBe(404);
  expect(m.health).not.toHaveBeenCalled();
  m.health.mockRejectedValueOnce(new HttpError(403, 'Workspace administrator access required'));
  expect((await GET(request(), params)).status).toBe(403);
});
it('rejects a missing workspace and provides no mutation route', async () => {
  expect(
    (await GET(new Request('http://localhost:3000/api/github/repositories/c/health'), params))
      .status,
  ).toBe(400);
  expect(
    (
      await POST(
        new Request('http://localhost:3000/api/github/repositories/c/health?workspaceId=w', {
          method: 'POST',
          headers: { Origin: 'http://localhost:3000' },
        }),
        params,
      )
    ).status,
  ).toBe(404);
  expect(m.health).not.toHaveBeenCalled();
});

it('sanitizes database failures and prevents caching error responses', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    m.health.mockRejectedValueOnce(new Error('private database password'));
    const response = await GET(
      new Request('http://localhost:3000/api/github/repositories/c/health?workspaceId=w'),
      params,
    );
    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(JSON.stringify(await response.json())).not.toContain('private');
    expect(JSON.stringify(log.mock.calls)).not.toContain('private');
  } finally {
    log.mockRestore();
  }
});
