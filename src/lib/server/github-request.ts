import { HttpError } from './errors';
export class GitHubHttpError extends HttpError {
  constructor(
    public code: string,
    public upstreamStatus: number,
    public retryable: boolean,
    public retryAt: number | null = null,
    public rateLimit: {
      remaining: number | null;
      resetAt: number | null;
      retryAt?: number | null;
    } = {
      remaining: null,
      resetAt: null,
    },
  ) {
    super(
      upstreamStatus === 401 ? 409 : upstreamStatus === 403 ? 403 : 502,
      code === 'GITHUB_CREDENTIALS_REVOKED'
        ? 'GitHub authorization expired. Reconnect your account.'
        : code === 'GITHUB_RATE_LIMITED'
          ? 'GitHub is rate limited. Processing will resume after its cooldown.'
          : 'GitHub could not complete this request.',
    );
  }
}
export function githubRateTiming(headers: Headers, now = Date.now()) {
  const numeric = (name: string) => {
    const s = headers.get(name);
    return s !== null && /^\d+$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : null;
  };
  const remaining = numeric('x-ratelimit-remaining');
  const reset = numeric('x-ratelimit-reset');
  const resetAt = reset !== null && reset <= 8640000000000 ? reset * 1000 : null;
  const retry = headers.get('retry-after');
  let retryAt: number | null = null;
  if (retry !== null) {
    const time = /^\d+(?:\.\d+)?$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry);
    if (Number.isFinite(time) && time >= now && time <= 8640000000000000) retryAt = time;
  }
  if (remaining === 0 && resetAt !== null) retryAt = Math.max(retryAt ?? now, resetAt);
  return { remaining, resetAt, retryAt };
}
export async function githubRequest(path: string, accessToken: string): Promise<unknown> {
  let url: URL;
  try {
    url = new URL(path, 'https://api.github.com');
  } catch {
    throw new GitHubHttpError('GITHUB_INVALID_PATH', 400, false);
  }
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    url.origin !== 'https://api.github.com' ||
    url.hash ||
    path
      .split('?')[0]
      .split('/')
      .some((p) => ['.', '..'].includes(decodeURIComponent(p)))
  )
    throw new GitHubHttpError('GITHUB_INVALID_PATH', 400, false);
  try {
    const result = await fetch(url.href, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    const timing = githubRateTiming(result.headers);
    const reader = result.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 4 * 1024 * 1024) {
            await reader.cancel();
            throw new GitHubHttpError('GITHUB_RESPONSE_TOO_LARGE', result.status, false);
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
    let data: unknown;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      data = null;
    }
    if (!result.ok) {
      const message =
        data && typeof data === 'object' && 'message' in data ? String(data.message) : '';
      const limited =
        result.status === 429 ||
        (result.status === 403 &&
          (timing.remaining === 0 || timing.retryAt !== null || /rate.?limit/i.test(message)));
      throw new GitHubHttpError(
        limited
          ? 'GITHUB_RATE_LIMITED'
          : result.status === 401
            ? 'GITHUB_CREDENTIALS_REVOKED'
            : result.status === 403
              ? 'GITHUB_FORBIDDEN'
              : result.status === 404
                ? 'GITHUB_RESOURCE_UNAVAILABLE'
                : 'GITHUB_HTTP_FAILURE',
        result.status,
        limited || result.status >= 500,
        limited ? (timing.retryAt ?? Date.now() + 60000) : null,
        timing,
      );
    }
    if (data === null) throw new GitHubHttpError('GITHUB_INVALID_RESPONSE', result.status, true);
    return data;
  } catch (error) {
    if (error instanceof GitHubHttpError) throw error;
    throw new GitHubHttpError('GITHUB_NETWORK_FAILURE', 0, true);
  }
}
