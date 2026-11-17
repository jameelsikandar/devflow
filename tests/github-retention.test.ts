import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  transaction: vi.fn(),
  authorize: vi.fn(),
  execute: vi.fn(),
  query: vi.fn(),
}));
vi.mock('../src/lib/server/db', () => ({ db: { $transaction: m.transaction } }));
vi.mock('../src/lib/server/github-repositories', () => ({ authorizeGitHubProject: m.authorize }));
import { githubRetentionImpact, retentionQueries } from '../src/lib/server/github-retention';
import {
  retentionDays,
  RETENTION_SCAN_LIMIT,
  retentionAgeRange,
  retentionReportSchema,
} from '../src/lib/github-retention';
const actor = { workspaceId: 'w', userId: 'admin', name: 'Admin' };
const now = new Date('2026-11-18T12:00:00Z'),
  cutoff = new Date('2026-10-19T12:00:00Z'),
  old = new Date('2026-10-01T12:00:00Z');
let rows: {
  reason: string;
  count: string;
  oldestAt: Date | null;
  newestAt: Date | null;
  dependencies: string;
}[][];
beforeEach(() => {
  vi.resetAllMocks();
  rows = Array.from({ length: 7 }, () => []);
  let index = 0;
  m.authorize.mockResolvedValue({ archivedAt: null });
  m.execute.mockResolvedValue(0);
  m.query.mockImplementation(async (input) =>
    Array.isArray(input) ? [{ now, cutoff }] : rows[index++],
  );
  m.transaction.mockImplementation((fn) => fn({ $executeRaw: m.execute, $queryRaw: m.query }));
});
it('enforces read-only/time-bounded transaction settings and admin authorization before aggregate reads', async () => {
  m.authorize.mockRejectedValueOnce({ status: 403 });
  await expect(githubRetentionImpact(actor, 'p')).rejects.toMatchObject({ status: 403 });
  expect(m.query).not.toHaveBeenCalled();
  expect(m.execute.mock.calls.map(([sql]) => sql.join(''))).toEqual([
    'SET TRANSACTION READ ONLY',
    "SET LOCAL statement_timeout = '4s'",
  ]);
  expect(m.transaction.mock.calls[0][1]).toEqual({
    isolationLevel: 'RepeatableRead',
    timeout: 15000,
  });
});
it.each([7, 30, 90])(
  'supports only proposed %i-day windows without saving policy',
  async (days) => {
    const result = await githubRetentionImpact(actor, 'p', days);
    expect(result.days).toBe(days);
    expect(result.complete).toBe(true);
    expect(result.categories).toHaveLength(7);
    expect(retentionReportSchema.safeParse(result).success).toBe(true);
    expect(result.categories.every((c) => c.total === 0 && c.oldestAt === null)).toBe(true);
    expect(m.authorize).toHaveBeenCalledWith(expect.anything(), actor, 'p');
  },
);
it.each([0, 8, 365, '7; DELETE', null])(
  'rejects unsupported window %j before database work',
  async (days) => {
    await expect(githubRetentionImpact(actor, 'p', days)).rejects.toThrow();
    expect(m.transaction).not.toHaveBeenCalled();
  },
);
it('returns exact grouped age/preservation counts without overlapping dependency double-counts', async () => {
  rows[0] = [
    { reason: 'REPLAY_PROTECTION', count: '3', oldestAt: old, newestAt: old, dependencies: '2' },
    { reason: 'WITHIN_WINDOW', count: '1', oldestAt: now, newestAt: now, dependencies: '0' },
  ];
  rows[6] = [
    { reason: 'POTENTIAL_CANDIDATE', count: '2', oldestAt: old, newestAt: old, dependencies: '0' },
    { reason: 'WORKER_BASELINE', count: '1', oldestAt: old, newestAt: old, dependencies: '0' },
  ];
  const result = await githubRetentionImpact(actor, 'p');
  expect(result.categories[0]).toMatchObject({
    total: 4,
    older: 3,
    potentiallyEligible: 0,
    preservedOlder: 3,
    dependencyProtectedOlder: 2,
  });
  expect(result.categories[6]).toMatchObject({
    total: 3,
    older: 3,
    potentiallyEligible: 2,
    preservedOlder: 1,
  });
  expect(JSON.stringify(result)).not.toMatch(
    /runId|deliveryId|payload|encrypted|taskId|ruleSnapshot/,
  );
});
it('fails closed for oversized categories rather than returning truncated totals or ages', async () => {
  rows[0] = [
    { reason: 'LIMIT_EXCEEDED', count: '10001', oldestAt: null, newestAt: null, dependencies: '0' },
  ];
  const result = await githubRetentionImpact(actor, 'p');
  expect(result.complete).toBe(false);
  expect(result.categories[0]).toMatchObject({
    complete: false,
    scannedAtLeast: 10001,
    total: null,
    older: null,
    potentiallyEligible: null,
    preservedOlder: null,
    oldestAt: null,
    reasons: [],
  });
});
it('bounds and scopes every metadata query, preserves replay/audit records and uses strict cutoff classification', () => {
  const queries = retentionQueries('w', 'p', cutoff, now);
  expect(queries).toHaveLength(7);
  for (const query of queries) {
    expect(query.sql.values).toContain('w');
    expect(query.sql.values).toContain('p');
    expect(query.sql.values).toContain(RETENTION_SCAN_LIMIT + 1);
    expect(query.sql.sql).toContain('AS MATERIALIZED');
    expect(query.sql.sql).toContain('"at">=');
    expect(query.sql.sql).not.toMatch(
      /\b(DELETE|INSERT|UPDATE|TRUNCATE|DROP|ALTER)\b|"data"|"currentData"|"message"|"encryptedToken"/i,
    );
  }
  expect(queries[0].sql.sql).toContain('REPLAY_PROTECTION');
  expect(queries[5].sql.sql).not.toContain("THEN 'POTENTIAL_CANDIDATE'");
  expect(queries[6].sql.sql).toContain('PARTITION BY');
  expect(queries[6].sql.sql).toContain('latest_past=1');
});
it('keeps snapshot ages reproducible and does not fabricate missing/evidence timestamps', () => {
  expect(retentionAgeRange(old.toISOString(), cutoff.toISOString(), now.toISOString())).toBe(
    '30.0–48.0 days',
  );
  expect(retentionAgeRange(null, null, now.toISOString())).toBe('No recorded timestamps');
  expect(
    retentionAgeRange(old.toISOString(), new Date(+now + 1).toISOString(), now.toISOString()),
  ).toBe('Includes future-dated activity');
  expect(retentionDays.parse(undefined)).toBe(30);
});
it('rejects a query timeout instead of publishing partial or zero-filled eligibility', async () => {
  m.query
    .mockImplementationOnce(async () => [{ now, cutoff }])
    .mockRejectedValueOnce(new Error('private statement timeout'));
  await expect(githubRetentionImpact(actor, 'p')).rejects.toThrow('private statement timeout');
  expect(m.execute.mock.calls.map(([sql]) => sql.join(''))).toContain(
    "SET LOCAL statement_timeout = '4s'",
  );
});
