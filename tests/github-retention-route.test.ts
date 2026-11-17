import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ user: vi.fn(), member: vi.fn(), report: vi.fn() }));
vi.mock('../src/lib/server/auth', async (original) => ({
  ...(await original<typeof import('../src/lib/server/auth')>()),
  requireUser: m.user,
  membership: m.member,
  rateLimit: vi.fn(),
}));
vi.mock('../src/lib/server/github-retention', () => ({ githubRetentionImpact: m.report }));
import { GET, POST, DELETE } from '../src/app/api/[...path]/route';
import { HttpError } from '../src/lib/server/errors';
const params = { params: Promise.resolve({ path: ['github', 'projects', 'p', 'retention'] }) };
const url =
  'http://localhost:3000/api/github/projects/p/retention?workspaceId=w&days=7&userId=forged';
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('APP_URL', 'http://localhost:3000');
  m.user.mockResolvedValue({ id: 'actual', name: 'Admin' });
  m.member.mockResolvedValue({ role: 'OWNER' });
  m.report.mockResolvedValue({ complete: true });
});
afterEach(() => vi.unstubAllEnvs());
it('uses authenticated actor and project-scoped GET with no-store', async () => {
  const response = await GET(new Request(url), params);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(m.report).toHaveBeenCalledWith(
    { userId: 'actual', name: 'Admin', workspaceId: 'w' },
    'p',
    '7',
  );
});
it('requires session/membership/admin and prevents caching access errors', async () => {
  m.user.mockRejectedValueOnce(new HttpError(401, 'Sign in'));
  expect((await GET(new Request(url), params)).status).toBe(401);
  m.member.mockRejectedValueOnce(new HttpError(404, 'Workspace not found'));
  expect((await GET(new Request(url), params)).status).toBe(404);
  expect(m.report).not.toHaveBeenCalled();
  m.report.mockRejectedValueOnce(new HttpError(403, 'Administrator required'));
  const denied = await GET(new Request(url), params);
  expect(denied.status).toBe(403);
  expect(denied.headers.get('Cache-Control')).toBe('no-store');
});
it('provides no execution, deletion or policy-save method', async () => {
  for (const handler of [POST, DELETE]) {
    const method = handler === POST ? 'POST' : 'DELETE';
    expect(
      (
        await handler(
          new Request(url, { method, headers: { Origin: 'http://localhost:3000' } }),
          params,
        )
      ).status,
    ).toBe(404);
  }
  expect(m.report).not.toHaveBeenCalled();
});
it('returns a sanitized no-store failure when the read-only report times out', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    m.report.mockRejectedValueOnce(new Error('private SQL and payload details'));
    const response = await GET(new Request(url), params);
    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(JSON.stringify(await response.json())).not.toMatch(
      /private|payload|candidate|categories/,
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('private');
  } finally {
    log.mockRestore();
  }
});
