import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  transaction: vi.fn(),
  connection: vi.fn(),
  authorize: vi.fn(),
  query: vi.fn(),
}));
vi.mock('../src/lib/server/db', () => ({ db: { $transaction: m.transaction } }));
vi.mock('../src/lib/server/github-repositories', () => ({ authorizeGitHubProject: m.authorize }));
import { githubOperationalHealth } from '../src/lib/server/github-operational-health';
const actor = { userId: 'admin', workspaceId: 'workspace', name: 'Admin' };
const now = new Date('2026-11-17T12:00:00Z');
const evidence = {
  mode: 'CONTINUOUS',
  state: 'RUNNING',
  heartbeatAt: now,
  polledAt: now,
  idleAt: now,
  staleAfterMs: 45000,
};
let signals: unknown[];
let deliveries: Record<string, unknown>;
let automation: Record<string, unknown>;
beforeEach(() => {
  vi.resetAllMocks();
  signals = [evidence];
  deliveries = {
    total: 0,
    pending: 0,
    failed: 0,
    ready: 0,
    scheduled: 0,
    processing: 0,
    expiredLeases: 0,
    deadLettered: 0,
    processed: 0,
    cancelled: 0,
    oldestReadyAt: null,
    nextScheduledAt: null,
    lastReceivedAt: null,
    lastProcessedAt: null,
  };
  automation = {
    total: 0,
    pending: 0,
    ready: 0,
    scheduled: 0,
    applied: 0,
    skipped: 0,
    conflicted: 0,
    failed: 0,
    oldestReadyAt: null,
    nextScheduledAt: null,
  };
  m.connection.mockResolvedValue({ id: 'c', projectId: 'p', disconnectedAt: null });
  m.authorize.mockResolvedValue({ id: 'p', archivedAt: null });
  m.transaction.mockImplementation((fn) =>
    fn({ gitHubRepositoryConnection: { findFirst: m.connection }, $queryRaw: m.query }),
  );
  m.query.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (sql.includes('transaction_timestamp')) return [{ now }];
    if (sql.includes('DISTINCT ON')) return signals;
    if (sql.includes('max("heartbeatAt")'))
      return [
        {
          lastHeartbeatAt: now,
          lastPollAt: now,
          lastAttemptProgressAt: null,
          lastBoundedHeartbeatAt: null,
        },
      ];
    if (sql.includes('FROM "GitHubWebhookDelivery"')) return [deliveries];
    if (sql.includes('FROM "GitHubWorkflowExecution"')) return [automation];
    throw Error('Unexpected query');
  });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('No external requests')));
});
afterEach(() => vi.unstubAllGlobals());
it('authorizes administrators before reading any operational records', async () => {
  m.authorize.mockRejectedValueOnce({ status: 403 });
  await expect(githubOperationalHealth(actor, 'c')).rejects.toMatchObject({ status: 403 });
  expect(m.query).not.toHaveBeenCalled();
  expect(m.authorize).toHaveBeenCalledWith(expect.anything(), actor, 'p');
});
it('does not look up foreign connections or accept malformed identifiers', async () => {
  m.connection.mockResolvedValue(null);
  await expect(githubOperationalHealth(actor, 'foreign')).rejects.toMatchObject({ status: 404 });
  expect(m.connection.mock.calls[0][0]).toMatchObject({
    where: { id: 'foreign', workspaceId: 'workspace' },
  });
  expect(m.query).not.toHaveBeenCalled();
  await expect(githubOperationalHealth(actor, 'x'.repeat(129))).rejects.toThrow();
  expect(m.connection).toHaveBeenCalledOnce();
});
it('uses a consistent database-clock snapshot and connection/project/workspace predicates', async () => {
  const result = await githubOperationalHealth(actor, 'c');
  expect(result.worker.state).toBe('HEALTHY_IDLE');
  expect(result.asOf).toEqual(now);
  expect(m.transaction.mock.calls[0][1]).toEqual({ isolationLevel: 'RepeatableRead' });
  const scoped = m.query.mock.calls
    .slice(1)
    .map(([strings, ...values]) => ({ sql: strings.join('?'), values }));
  for (const { sql, values } of scoped) {
    expect(sql).toContain('"connectionId" =');
    expect(values).toContain('c');
    if (!sql.includes('FROM "GitHubWebhookDelivery"')) {
      expect(sql).toContain('"workspaceId" =');
      expect(values).toContain('workspace');
      expect(sql).toContain('"projectId" =');
      expect(values).toContain('p');
    }
  }
  expect(scoped[0].sql).toContain('DISTINCT ON');
  expect(fetch).not.toHaveBeenCalled();
});
it('returns only safe aggregate fields without raw evidence, identities or stored error content', async () => {
  const result = await githubOperationalHealth(actor, 'c');
  const text = JSON.stringify(result);
  expect(text).not.toMatch(/runId|encrypted|payload|leaseToken|ruleSnapshot|taskSnapshot|userId/);
  expect(Object.keys(result.worker).sort()).toEqual(
    [
      'state',
      'lastHeartbeatAt',
      'lastPollAt',
      'lastAttemptProgressAt',
      'lastBoundedHeartbeatAt',
    ].sort(),
  );
  for (const [strings] of m.query.mock.calls) {
    expect(strings.join('')).not.toMatch(
      /SELECT \*|errorCode|"data"|"reason"|UPDATE |DELETE |INSERT /,
    );
  }
});
it('reports missing evidence and bounded runs without a false continuous availability claim', async () => {
  signals = [];
  expect((await githubOperationalHealth(actor, 'c')).worker.state).toBe('INSUFFICIENT_EVIDENCE');
  signals = [{ ...evidence, mode: 'BOUNDED' }];
  const result = await githubOperationalHealth(actor, 'c');
  expect(result.worker.state).toBe('BOUNDED_RUN');
  expect(result.diagnostics.map((d) => d.code)).toContain('WORKER_BOUNDED_ONLY');
});
it('retains a healthy replica even with many stale or stalled replicas', async () => {
  signals = [{ ...evidence, heartbeatAt: new Date(0) }, { ...evidence, polledAt: null }, evidence];
  expect((await githubOperationalHealth(actor, 'c')).worker.state).toBe('HEALTHY_IDLE');
});
it('disconnected and archived scope override fresh worker evidence', async () => {
  m.connection.mockResolvedValueOnce({ id: 'c', projectId: 'p', disconnectedAt: now });
  expect((await githubOperationalHealth(actor, 'c')).worker.state).toBe('DISCONNECTED');
  m.authorize.mockResolvedValueOnce({ id: 'p', archivedAt: now });
  expect((await githubOperationalHealth(actor, 'c')).worker.state).toBe('PROJECT_ARCHIVED');
});
it('separates scheduled backoff, expired leases and terminal outcomes with static actionable diagnostics', async () => {
  deliveries = { ...deliveries, ready: 1, scheduled: 2, expiredLeases: 1, deadLettered: 1 };
  automation = { ...automation, conflicted: 1, failed: 1 };
  const result = await githubOperationalHealth(actor, 'c');
  expect(result.worker.state).toBe('HEALTHY_IDLE');
  expect(result.diagnostics.map((d) => d.code)).toEqual(
    expect.arrayContaining([
      'WORK_SCHEDULED_NOW',
      'WORK_SCHEDULED_LATER',
      'DELIVERY_LEASES_EXPIRED',
      'DELIVERY_DEAD_LETTERS',
      'AUTOMATION_TERMINAL_OUTCOMES',
    ]),
  );
  signals = [{ ...evidence, heartbeatAt: new Date(0) }];
  expect((await githubOperationalHealth(actor, 'c')).diagnostics.map((d) => d.code)).toContain(
    'WORKER_CONTINUOUS_SIGNAL_MISSING',
  );
});
