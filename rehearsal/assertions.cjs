/* eslint-disable @typescript-eslint/no-require-imports -- Pure scenario assertions. */
'use strict';
const { insist } = require('./policy.cjs');
function replacement(old, next, now) {
  insist(
    next.state === 'PROCESSING' &&
      next.leaseToken &&
      next.leaseToken !== old.leaseToken &&
      next.attempts === old.attempts + 1 &&
      +next.leaseExpiresAt > +now,
    'REPLACEMENT_LEASE',
  );
}
function fenced(result, next, intact, now) {
  insist(
    result && result.committed === false && result.renewed === false && result.failed === false,
    'STALE_OWNER_PUBLISHED',
  );
  insist(
    intact.state === 'PROCESSING' &&
      intact.leaseToken === next.leaseToken &&
      intact.attempts === next.attempts &&
      +intact.leaseExpiresAt >= +next.leaseExpiresAt &&
      +intact.leaseExpiresAt > +now,
    'REPLACEMENT_LEASE_DAMAGED',
  );
}
function retryWindow(before, after, attempt, available) {
  const cap = Math.min(600000, 1000 * 2 ** Math.min(attempt, 16));
  insist(
    +after >= +before &&
      +after - +before <= 500 &&
      +available >= +before + cap / 2 &&
      +available <= +after + cap &&
      +available > +after,
    'BACKOFF_BOUNDS',
  );
}
function publication(c, automation = false) {
  insist(
    c.objects === 1 &&
      c.observations === (automation ? 2 : 1) &&
      c.links === 1 &&
      c.evidence === (automation ? 2 : 1),
    'PUBLICATION_UNIQUENESS',
  );
  insist(
    c.activities === (automation ? 1 : 0) &&
      c.executions === (automation ? 2 : 0) &&
      c.applied === (automation ? 1 : 0) &&
      c.skipped === (automation ? 1 : 0),
    'EXECUTION_UNIQUENESS',
  );
}
module.exports = { replacement, fenced, retryWindow, publication };
