import { z } from 'zod';

export interface Dependency {
  projectId: string;
  predecessorId: string;
  successorId: string;
}
export interface ScheduledTask {
  id: string;
  startDate: string | null;
  dueDate: string | null;
  isMilestone: boolean;
  status: string;
}
export const DAY_MS = 86400000;
export function utcDay(value: string | Date) {
  const date = typeof value === 'string' ? new Date(value) : value;
  return Math.floor(date.getTime() / DAY_MS);
}
export function dayISO(day: number) {
  return new Date(day * DAY_MS).toISOString();
}
export function scheduleError(task: {
  startDate?: string | Date | null;
  dueDate?: string | Date | null;
  isMilestone?: boolean;
}): string | null {
  if (task.startDate && task.dueDate && +new Date(task.startDate) > +new Date(task.dueDate))
    return 'Start date must be on or before the due date';
  if (
    task.isMilestone &&
    (!task.startDate || !task.dueDate || utcDay(task.startDate) !== utcDay(task.dueDate))
  )
    return 'Milestones need a start and due date on the same UTC day';
  return null;
}
export const dependencySchema = z
  .object({
    projectId: z.string().min(1).max(128),
    predecessorId: z.string().min(1).max(128),
    successorId: z.string().min(1).max(128),
  })
  .strict()
  .refine((e) => e.predecessorId !== e.successorId, 'A task cannot depend on itself');

/** Kahn ordering also detects cycles without recursive stack growth. */
export function dependencyOrder(
  ids: string[],
  edges: Pick<Dependency, 'predecessorId' | 'successorId'>[],
) {
  const known = new Set(ids);
  if (known.size !== ids.length) throw new Error('Duplicate task identifiers');
  const remaining = new Map(ids.map((id) => [id, 0]));
  const next = new Map(ids.map((id) => [id, [] as string[]]));
  const unique = new Set<string>();
  for (const edge of edges) {
    if (!known.has(edge.predecessorId) || !known.has(edge.successorId))
      throw new Error('Dependencies must connect tasks in the same project');
    const key = `${edge.predecessorId}:${edge.successorId}`;
    if (unique.has(key)) continue;
    unique.add(key);
    next.get(edge.predecessorId)!.push(edge.successorId);
    remaining.set(edge.successorId, remaining.get(edge.successorId)! + 1);
  }
  const order = ids.filter((id) => remaining.get(id) === 0);
  for (let i = 0; i < order.length; i++) {
    for (const id of next.get(order[i])!) {
      remaining.set(id, remaining.get(id)! - 1);
      if (remaining.get(id) === 0) order.push(id);
    }
  }
  if (order.length !== ids.length)
    throw new Error('This dependency would create a circular reference');
  return order;
}

/** Calendar-day CPM; no inferred durations for unscheduled tasks. Milestones take zero days. */
export function criticalPath(tasks: ScheduledTask[], edges: Dependency[]) {
  const order = dependencyOrder(
    tasks.map((t) => t.id),
    edges,
  );
  const incomplete = tasks.filter((t) => !t.startDate || !t.dueDate).map((t) => t.id);
  if (incomplete.length || !tasks.length)
    return {
      complete: false,
      duration: null,
      criticalIds: [] as string[],
      slack: {} as Record<string, number>,
      incomplete,
    };
  const durations = new Map(
    tasks.map((t) => [
      t.id,
      t.isMilestone ? 0 : Math.max(1, utcDay(t.dueDate!) - utcDay(t.startDate!) + 1),
    ]),
  );
  const predecessors = new Map(order.map((id) => [id, [] as string[]]));
  const successors = new Map(order.map((id) => [id, [] as string[]]));
  for (const e of edges) {
    predecessors.get(e.successorId)!.push(e.predecessorId);
    successors.get(e.predecessorId)!.push(e.successorId);
  }
  const finish = new Map<string, number>();
  for (const id of order) {
    let start = 0;
    for (const predecessor of predecessors.get(id)!)
      start = Math.max(start, finish.get(predecessor)!);
    finish.set(id, start + durations.get(id)!);
  }
  let duration = 0;
  for (const value of finish.values()) duration = Math.max(duration, value);
  const latestStart = new Map<string, number>();
  const slack: Record<string, number> = {};
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    let latestFinish = duration;
    for (const successor of successors.get(id)!)
      latestFinish = Math.min(latestFinish, latestStart.get(successor)!);
    latestStart.set(id, latestFinish - durations.get(id)!);
    slack[id] = latestFinish - finish.get(id)!;
  }
  return {
    complete: true,
    duration,
    criticalIds: order.filter((id) => slack[id] === 0),
    slack,
    incomplete,
  };
}

export function deadlineWarnings(tasks: ScheduledTask[], edges: Dependency[], now = new Date()) {
  const today = utcDay(now);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const overdue = tasks
    .filter((t) => t.status !== 'DONE' && t.dueDate && utcDay(t.dueDate) < today)
    .map((t) => t.id);
  const approaching = tasks
    .filter(
      (t) =>
        t.status !== 'DONE' &&
        t.dueDate &&
        utcDay(t.dueDate) >= today &&
        utcDay(t.dueDate) <= today + 3,
    )
    .map((t) => t.id);
  const conflicts = edges.filter((e) => {
    const before = byId.get(e.predecessorId);
    const after = byId.get(e.successorId);
    if (!before?.dueDate || !after?.startDate) return false;
    return utcDay(after.startDate) < utcDay(before.dueDate) + (before.isMilestone ? 0 : 1);
  });
  return { overdue, approaching, conflicts };
}

export function shiftSchedule(task: ScheduledTask, days: number) {
  if (!task.startDate || !task.dueDate) throw new Error('Set both dates before moving a task');
  // Preserve time-of-day for legacy due dates while shifting whole UTC days.
  return {
    startDate: new Date(+new Date(task.startDate) + days * DAY_MS).toISOString(),
    dueDate: new Date(+new Date(task.dueDate) + days * DAY_MS).toISOString(),
  };
}
