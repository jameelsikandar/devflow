import { digest } from './crypto';
import { HttpError } from './errors';

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export const previewDigest = (payload: unknown) => digest(JSON.stringify(canonical(payload)));
export function proposalDecision(
  proposal: { status: string; expiresAt: Date; previewHash: string },
  decision: 'approve' | 'reject',
  hash: string,
  now = new Date(),
) {
  if (hash !== proposal.previewHash)
    throw new HttpError(409, 'This preview changed. Reload before approving.');
  if (proposal.status === 'APPLIED') {
    if (decision === 'reject') throw new HttpError(409, 'This action has already been applied.');
    return 'replay' as const;
  }
  if (proposal.status === 'REJECTED') {
    if (decision === 'approve') throw new HttpError(409, 'Rejected proposals cannot be approved.');
    return 'replay' as const;
  }
  if (proposal.status === 'EXPIRED' || proposal.expiresAt <= now) return 'expire' as const;
  if (proposal.status !== 'PENDING') throw new HttpError(409, 'This proposal is not pending.');
  return decision === 'approve' ? ('apply' as const) : ('reject' as const);
}
