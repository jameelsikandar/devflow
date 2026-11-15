import { createHash } from 'node:crypto';
import { HttpError } from './errors';
// Local-process backoff, not a distributed quota manager. No raw credentials retained.
const cooldowns = new Map<string, number>();
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value?.trim()) return null;
  const v = value.trim();
  const until = /^\d+(\.\d+)?$/.test(v)
    ? now + Number(v) * 1000
    : /^[A-Za-z]{3},/.test(v)
      ? Date.parse(v)
      : NaN;
  return Number.isFinite(until) && Math.abs(until) <= 8640000000000000
    ? Math.max(now, until)
    : null;
}
function duration(value: string | null): number | null {
  if (!value || !/^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/.test(value)) return null;
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)].reduce(
    (sum, m) => sum + Number(m[1]) * units[m[2]],
    0,
  );
}
export function retryDeadline(headers: Headers, now = Date.now()) {
  const explicit = parseRetryAfter(headers.get('retry-after'), now);
  if (explicit !== null) return explicit;
  const deadlines = ['requests', 'tokens'].flatMap((kind) => {
    if (headers.get(`x-ratelimit-remaining-${kind}`) !== '0') return [];
    const ms = duration(headers.get(`x-ratelimit-reset-${kind}`));
    return ms !== null && Number.isFinite(now + ms) && now + ms <= 8640000000000000
      ? [now + ms]
      : [];
  });
  return deadlines.length ? Math.max(...deadlines) : null;
}
export class ProviderRateLimitError extends HttpError {
  constructor(
    public provider: string,
    public retryAt: number | null,
  ) {
    super(
      429,
      `${provider} is rate limited or has reached its quota. ${retryAt !== null ? `Retry after ${new Date(retryAt).toISOString()}.` : 'No retry delay was provided. Try again later or review your provider quota.'}`,
    );
  }
}
export function providerBackoff(config: {
  AI_BASE_URL: string;
  AI_API_KEY?: string;
  AI_MODEL: string;
}) {
  const provider = new URL(config.AI_BASE_URL).hostname === 'api.groq.com' ? 'Groq' : 'AI provider';
  const key = createHash('sha256')
    .update(JSON.stringify([config.AI_BASE_URL, config.AI_API_KEY, config.AI_MODEL]))
    .digest('hex');
  return {
    check() {
      const until = cooldowns.get(key);
      if (until && until > Date.now()) throw new ProviderRateLimitError(provider, until);
      cooldowns.delete(key);
    },
    limited(headers: Headers) {
      const until = retryDeadline(headers);
      if (until !== null && until > Date.now()) {
        for (const [k, time] of cooldowns) if (time <= Date.now()) cooldowns.delete(k);
        if (cooldowns.size >= 128) cooldowns.delete(cooldowns.keys().next().value!);
        cooldowns.set(key, until);
      }
      return new ProviderRateLimitError(provider, until);
    },
  };
}
