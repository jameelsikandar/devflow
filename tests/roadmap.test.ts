import { describe, expect, it } from 'vitest';
import {
  criticalPath,
  deadlineWarnings,
  dependencyOrder,
  dependencySchema,
  scheduleError,
  shiftSchedule,
  utcDay,
  type Dependency,
  type ScheduledTask,
} from '../src/lib/roadmap';
const task = (id: string, start = '2026-11-01', due = start, milestone = false): ScheduledTask => ({
  id,
  startDate: `${start}T00:00:00.000Z`,
  dueDate: `${due}T23:59:59.000Z`,
  isMilestone: milestone,
  status: 'TODO',
});
const edge = (predecessorId: string, successorId: string): Dependency => ({
  projectId: 'p',
  predecessorId,
  successorId,
});

describe('dependency validation', () => {
  it('orders a diamond graph and tolerates duplicate edges in calculations', () => {
    expect(
      dependencyOrder(
        ['a', 'b', 'c', 'd'],
        [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd'), edge('a', 'b')],
      ),
    ).toEqual(['a', 'b', 'c', 'd']);
  });
  it('rejects self edges, two-task cycles and transitive cycles', () => {
    expect(() => dependencyOrder(['a'], [edge('a', 'a')])).toThrow('circular');
    expect(() => dependencyOrder(['a', 'b'], [edge('a', 'b'), edge('b', 'a')])).toThrow('circular');
    expect(() =>
      dependencyOrder(['a', 'b', 'c'], [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]),
    ).toThrow('circular');
    expect(dependencySchema.safeParse(edge('a', 'a')).success).toBe(false);
  });
  it('rejects endpoints outside the project and unknown input fields', () => {
    expect(() => dependencyOrder(['a'], [edge('a', 'foreign')])).toThrow('same project');
    expect(dependencySchema.safeParse({ ...edge('a', 'b'), workspaceId: 'foreign' }).success).toBe(
      false,
    );
  });
  it('handles a long chain without recursive stack overflow', () => {
    const ids = Array.from({ length: 15000 }, (_, i) => String(i));
    const edges = ids.slice(1).map((id, i) => edge(String(i), id));
    expect(dependencyOrder(ids, edges)).toHaveLength(15000);
  });
});

describe('calendar-day critical path', () => {
  it('finds the longest branch and computes slack on shorter branches', () => {
    const result = criticalPath(
      [
        task('a', '2026-11-01', '2026-11-02'),
        task('b', '2026-11-03', '2026-11-06'),
        task('c', '2026-11-03'),
        task('d', '2026-11-07'),
      ],
      [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')],
    );
    expect(result.duration).toBe(7);
    expect(result.criticalIds).toEqual(['a', 'b', 'd']);
    expect(result.slack.c).toBe(3);
  });
  it('identifies multiple equally critical branches and zero-duration milestones', () => {
    const result = criticalPath(
      [task('a'), task('b'), task('m', '2026-11-02', '2026-11-02', true)],
      [edge('a', 'm'), edge('b', 'm')],
    );
    expect(result.duration).toBe(1);
    expect(new Set(result.criticalIds)).toEqual(new Set(['a', 'b', 'm']));
  });
  it('reports incomplete data instead of inventing durations', () => {
    const result = criticalPath([task('a'), { ...task('b'), startDate: null }], [edge('a', 'b')]);
    expect(result).toMatchObject({
      complete: false,
      duration: null,
      criticalIds: [],
      incomplete: ['b'],
    });
    expect(criticalPath([], []).complete).toBe(false);
  });
  it('includes an independent task when it determines the project duration', () => {
    expect(
      criticalPath([task('a'), task('b', '2026-11-01', '2026-11-05')], []).criticalIds,
    ).toEqual(['b']);
  });
});

describe('schedule integrity and warnings', () => {
  it('validates merged dates and milestone requirements', () => {
    expect(scheduleError(task('a'))).toBeNull();
    expect(scheduleError({ startDate: '2026-11-03', dueDate: '2026-11-01' })).toContain('before');
    expect(scheduleError({ isMilestone: true })).toContain('same UTC day');
    expect(scheduleError(task('m', '2026-11-01', '2026-11-02', true))).toContain('same UTC day');
    expect(scheduleError(task('m', '2026-11-01', '2026-11-01', true))).toBeNull();
  });
  it('shifts the full interval and preserves time of day, including negative shifts', () => {
    expect(shiftSchedule(task('a', '2026-11-01', '2026-11-03'), -1)).toEqual({
      startDate: '2026-10-31T00:00:00.000Z',
      dueDate: '2026-11-02T23:59:59.000Z',
    });
    expect(() => shiftSchedule({ ...task('a'), startDate: null }, 1)).toThrow('both dates');
  });
  it('uses UTC across daylight saving boundaries', () => {
    expect(utcDay('2026-11-01T23:00:00-05:00')).toBe(utcDay('2026-11-02T04:00:00Z'));
    expect(shiftSchedule(task('a'), 1).startDate).toBe('2026-11-02T00:00:00.000Z');
  });
  it('excludes completed tasks from overdue counts and detects approaching deadlines', () => {
    const result = deadlineWarnings(
      [
        task('late'),
        { ...task('done'), status: 'DONE' },
        task('today', '2026-11-03'),
        task('soon', '2026-11-06'),
        task('later', '2026-11-07'),
      ],
      [],
      new Date('2026-11-03T12:00:00Z'),
    );
    expect(result.overdue).toEqual(['late']);
    expect(result.approaching).toEqual(['today', 'soon']);
  });
  it('warns about finish-to-start conflicts, allowing same-day milestone handoffs', () => {
    expect(deadlineWarnings([task('a'), task('b')], [edge('a', 'b')]).conflicts).toHaveLength(1);
    expect(
      deadlineWarnings([task('a'), task('b', '2026-11-02')], [edge('a', 'b')]).conflicts,
    ).toHaveLength(0);
    expect(
      deadlineWarnings([task('a', '2026-11-01', '2026-11-01', true), task('b')], [edge('a', 'b')])
        .conflicts,
    ).toHaveLength(0);
  });
});
