import { describe, expect, it } from 'vitest';
import { analytics } from '../src/lib/analytics';
import { taskPosition } from '../src/lib/kanban';
import { commentSchema, registerSchema, taskSchema, taskUpdateSchema } from '../src/lib/validation';
import type { Task, Project } from '../src/lib/types';
const project = { id: 'p', archivedAt: null } as Project;
const task = (values: Partial<Task>): Task =>
  ({
    id: 't',
    projectId: 'p',
    status: 'TODO',
    dueDate: null,
    completedAt: null,
    createdAt: '2026-11-10T12:00:00.000Z',
    priority: 'MEDIUM',
    ...values,
  }) as Task;
describe('database-derived analytics', () => {
  it('excludes archived projects and avoids overdue completed tasks', () => {
    const result = analytics(
      [
        task({ id: '1', dueDate: '2026-11-01T12:00:00Z' }),
        task({
          id: '2',
          status: 'DONE',
          dueDate: '2026-11-01T12:00:00Z',
          completedAt: '2026-11-12T00:00:00.000Z',
        }),
        task({ id: '3', projectId: 'archived' }),
      ],
      [project, { id: 'archived', archivedAt: '2026-11-01' } as Project],
      new Date('2026-11-12T13:00:00Z'),
    );
    expect(result).toMatchObject({ projects: 1, active: 1, completed: 1, overdue: 1, rate: 50 });
    expect(result.days.reduce((n, d) => n + d.completed, 0)).toBe(1);
    expect(result.priorities.find((p) => p.name === 'MEDIUM')?.value).toBe(1);
  });
  it('handles empty workspaces and UTC midnight boundaries', () => {
    expect(analytics([], [], new Date('2026-11-12T00:01:00Z'))).toMatchObject({
      rate: 0,
      active: 0,
      completed: 0,
      overdue: 0,
    });
    const result = analytics(
      [task({ status: 'DONE', completedAt: '2026-11-11T23:59:59.999Z' })],
      [project],
      new Date('2026-11-12T00:01:00Z'),
    );
    expect(result.days.at(-2)?.completed).toBe(1);
    expect(result.days.at(-1)?.completed).toBe(0);
  });
});
describe('Kanban ordering', () => {
  it('places tasks before, between, after, and in empty columns', () => {
    const order = [{ position: 1024 }, { position: 2048 }];
    expect(taskPosition([], 0)).toBe(1024);
    expect(taskPosition(order, 0)).toBeLessThan(1024);
    expect(taskPosition(order, 1)).toBe(1536);
    expect(taskPosition(order, 2)).toBeGreaterThan(2048);
  });
  it('clamps indexes and remains finite', () => {
    expect(taskPosition([{ position: 0 }], -10)).toBe(-1024);
    expect(taskPosition([{ position: 0 }], 100)).toBe(1024);
  });
});
describe('API validation', () => {
  it('normalizes email and rejects short passwords', () => {
    expect(
      registerSchema.parse({
        name: 'Alex',
        email: ' Alex@Example.COM ',
        password: 'safe-long-password',
      }).email,
    ).toBe('alex@example.com');
    expect(registerSchema.safeParse({ name: 'A', email: 'bad', password: 'short' }).success).toBe(
      false,
    );
  });
  it('rejects empty and oversized task titles and malformed dates', () => {
    expect(taskSchema.safeParse({ projectId: 'p', title: '  ' }).success).toBe(false);
    expect(taskSchema.safeParse({ projectId: 'p', title: 'x'.repeat(201) }).success).toBe(false);
    expect(
      taskSchema.safeParse({ projectId: 'p', title: 'Valid title', dueDate: 'tomorrow' }).success,
    ).toBe(false);
  });
  it('requires optimistic concurrency versions and finite positions', () => {
    expect(taskUpdateSchema.safeParse({ status: 'DONE' }).success).toBe(false);
    expect(taskUpdateSchema.safeParse({ version: 0, position: Infinity }).success).toBe(false);
    expect(taskUpdateSchema.parse({ version: 2, status: 'DONE' })).toEqual({
      version: 2,
      status: 'DONE',
    });
  });
  it('does not overwrite labels or descriptions on partial updates', () => {
    const patch = taskUpdateSchema.parse({ version: 0, status: 'IN_REVIEW' });
    expect(patch).not.toHaveProperty('labelIds');
    expect(patch).not.toHaveProperty('description');
  });
  it('rejects blank comments and invalid statuses', () => {
    expect(commentSchema.safeParse({ body: '  ' }).success).toBe(false);
    expect(
      taskSchema.safeParse({ projectId: 'p', title: 'A task', status: 'SHIPPED' }).success,
    ).toBe(false);
  });
});
