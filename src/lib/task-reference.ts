/** Task numbers are numeric; padding is a presentation alias, never a new identity. */
export function canonicalTaskReference(value: string): string | null {
  const match = /^DEV-(\d{1,10})$/i.exec(value);
  if (!match) return null;
  const number = Number(match[1]);
  return number > 0 && Number.isSafeInteger(number) ? `DEV-${number}` : null;
}
export function extractTaskReferences(text: string): string[] {
  return [
    ...new Set(
      (text.match(/\bDEV-\d{1,10}\b/gi) ?? [])
        .map(canonicalTaskReference)
        .filter((r): r is string => r !== null),
    ),
  ].slice(0, 100);
}
