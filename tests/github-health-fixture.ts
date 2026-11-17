import type { OperationalHealth } from '../src/lib/github-operational-health';
export function healthFixture(
  state: OperationalHealth['worker']['state'] = 'HEALTHY_IDLE',
  scope = { workspaceId: 'w', projectId: 'p', connectionId: 'c' },
  asOf = new Date().toISOString(),
): OperationalHealth {
  return {
    asOf,
    scope: { ...scope, disconnected: false, archived: false },
    worker: {
      state,
      lastHeartbeatAt: asOf,
      lastPollAt: asOf,
      lastAttemptProgressAt: null,
      lastBoundedHeartbeatAt: null,
    },
    deliveries: {
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
    },
    automation: {
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
    },
    diagnostics: [],
  };
}
