import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ user: vi.fn(), member: vi.fn(), check: vi.fn() }));
vi.mock('../src/lib/server/auth', async (original) => ({
  ...(await original<typeof import('../src/lib/server/auth')>()),
  requireUser: m.user,
  membership: m.member,
  rateLimit: vi.fn(),
}));
vi.mock('../src/lib/server/github-revalidation', () => ({ revalidateGitHubConnection: m.check }));
import { POST, GET } from '../src/app/api/[...path]/route';
import { HttpError } from '../src/lib/server/errors';
const params = { params: Promise.resolve({ path: ['github', 'repositories', 'c', 'revalidate'] }) };
const request = (body: unknown = {}, origin = 'http://localhost:3000') =>
  new Request(
    'http://localhost:3000/api/github/repositories/c/revalidate?workspaceId=w&userId=forged',
    {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('APP_URL', 'http://localhost:3000');
  m.user.mockResolvedValue({ id: 'actual', name: 'Owner' });
  m.member.mockResolvedValue({ role: 'OWNER' });
  m.check.mockResolvedValue({ code: 'ACCESS_VALID' });
});
afterEach(() => vi.unstubAllEnvs());
it('requires an explicit same-origin POST with an empty body and authenticated identity', async () => {
  const response = await POST(request(), params);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(m.check).toHaveBeenCalledWith({ userId: 'actual', workspaceId: 'w', name: 'Owner' }, 'c');
  expect((await POST(request({ repositoryId: 'forged' }), params)).status).toBe(400);
  const crossOrigin = await POST(request({}, 'https://other.example'), params);
  expect(crossOrigin.status).toBe(403);
  expect(crossOrigin.headers.get('Cache-Control')).toBe('no-store');
  expect(
    (
      await GET(
        new Request('http://localhost:3000/api/github/repositories/c/revalidate?workspaceId=w'),
        params,
      )
    ).status,
  ).toBe(404);
  expect(m.check).toHaveBeenCalledOnce();
});
it('enforces authentication, workspace membership and server administrator checks', async () => {
  m.user.mockRejectedValueOnce(new HttpError(401, 'Sign in'));
  expect((await POST(request(), params)).status).toBe(401);
  m.member.mockRejectedValueOnce(new HttpError(404, 'Workspace not found'));
  expect((await POST(request(), params)).status).toBe(404);
  expect(m.check).not.toHaveBeenCalled();
  m.check.mockRejectedValueOnce(new HttpError(403, 'Administrator required'));
  const denied = await POST(request(), params);
  expect(denied.status).toBe(403);
  expect(denied.headers.get('Cache-Control')).toBe('no-store');
});
it('sanitizes unexpected failures without credential/provider contents', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    m.check.mockRejectedValueOnce(new Error('private password/token'));
    const response = await POST(request(), params);
    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(JSON.stringify(await response.json())).not.toContain('private');
    expect(JSON.stringify(log.mock.calls)).not.toContain('private');
  } finally {
    log.mockRestore();
  }
});
