import type { Status } from '@prisma/client';
/** Shared human/automation status semantics; never changes unrelated task fields. */
export function taskStatusFields(status: Status, completedAt: Date | null, now = new Date()) {
  return { status, completedAt: status === 'DONE' ? (completedAt ?? now) : null };
}
