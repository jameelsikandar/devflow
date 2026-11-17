import { retentionKinds, type RetentionReport } from '../src/lib/github-retention';
export function retentionFixture(days: 7 | 30 | 90 = 30): RetentionReport {
  const asOf = new Date('2026-11-18T12:00:00Z');
  return {
    scope: { workspaceId: 'w', projectId: 'p', archived: false },
    asOf: asOf.toISOString(),
    cutoff: new Date(+asOf - days * 86400000).toISOString(),
    days,
    scanLimit: 10000,
    complete: true,
    categories: retentionKinds.map((kind) => ({
      kind,
      complete: true,
      scannedAtLeast: 0,
      total: 0,
      older: 0,
      potentiallyEligible: 0,
      preservedOlder: 0,
      dependencyProtectedOlder: 0,
      oldestAt: null,
      newestAt: null,
      reasons: [],
    })),
  };
}
