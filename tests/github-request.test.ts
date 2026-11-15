import { afterEach, expect, it, vi } from 'vitest';
import { githubRateTiming, githubRequest } from '../src/lib/server/github-request';
afterEach(() => vi.unstubAllGlobals());
it('parses Retry-After seconds/dates and primary reset without exposing headers', () => {
  expect(githubRateTiming(new Headers({ 'retry-after': '12' }), 100000).retryAt).toBe(112000);
  expect(
    githubRateTiming(new Headers({ 'retry-after': new Date(120000).toUTCString() }), 100000)
      .retryAt,
  ).toBe(120000);
  expect(
    githubRateTiming(
      new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '150' }),
      100000,
    ).retryAt,
  ).toBe(150000);
  expect(
    githubRateTiming(new Headers({ 'retry-after': 'bad', 'x-ratelimit-reset': 'bad' })).retryAt,
  ).toBeNull();
});
it.each([401, 403, 404, 429, 503])(
  'returns typed sanitized HTTP %s failures without automatic retries',
  async (status) => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'private repository or token details' }), {
        status,
        headers: status === 429 ? { 'retry-after': '60' } : {},
      }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(githubRequest('/repos/owner/repo', 'secret-token')).rejects.toMatchObject({
      upstreamStatus: status,
      retryable: status === 429 || status === 503,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', cache: 'no-store' });
  },
);
it('recognizes a secondary limit carried by HTTP 403', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit.' }), {
        status: 403,
      }),
    ),
  );
  await expect(githubRequest('/repos/owner/repo', 'secret')).rejects.toMatchObject({
    code: 'GITHUB_RATE_LIMITED',
    retryable: true,
    retryAt: expect.any(Number),
  });
});
it('refuses arbitrary URLs, traversal and network failures safely', async () => {
  const fetch = vi.fn().mockRejectedValue(new Error('private token'));
  vi.stubGlobal('fetch', fetch);
  for (const path of ['https://evil.example', '//evil.example', '/repos/../user'])
    await expect(githubRequest(path, 'secret')).rejects.toMatchObject({
      code: 'GITHUB_INVALID_PATH',
    });
  expect(fetch).not.toHaveBeenCalled();
  await expect(githubRequest('/repos/owner/repo', 'secret')).rejects.toMatchObject({
    code: 'GITHUB_NETWORK_FAILURE',
    retryable: true,
    message: 'GitHub could not complete this request.',
  });
});
