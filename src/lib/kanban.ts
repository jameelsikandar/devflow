/** Fractional positions preserve unaffected tasks; version checks reject concurrent moves. */
export function taskPosition(ordered: { position: number }[], index: number): number {
  const safe = Math.max(0, Math.min(index, ordered.length));
  const before = ordered[safe - 1]?.position;
  const after = ordered[safe]?.position;
  if (before === undefined && after === undefined) return 1024;
  if (before === undefined) return after! - 1024;
  if (after === undefined) return before + 1024;
  return (before + after) / 2;
}
