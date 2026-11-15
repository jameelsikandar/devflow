import type { Task, Project } from './types';
export function analytics(tasks: Task[], projects: Project[], now = new Date()) {
  const activeProjects = projects.filter((p) => !p.archivedAt);
  const projectIds = new Set(activeProjects.map((p) => p.id));
  const work = tasks.filter((t) => projectIds.has(t.projectId));
  const done = work.filter((t) => t.status === 'DONE');
  const overdue = work.filter((t) => t.status !== 'DONE' && t.dueDate && new Date(t.dueDate) < now);
  const days = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(now);
    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() - 6 + i);
    const key = day.toISOString().slice(0, 10);
    return {
      day: day.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
      completed: done.filter((t) => t.completedAt?.slice(0, 10) === key).length,
      created: work.filter((t) => t.createdAt.slice(0, 10) === key).length,
    };
  });
  return {
    projects: activeProjects.length,
    active: work.length - done.length,
    completed: done.length,
    overdue: overdue.length,
    rate: work.length ? Math.round((done.length / work.length) * 100) : 0,
    days,
    priorities: ['URGENT', 'HIGH', 'MEDIUM', 'LOW'].map((priority) => ({
      name: priority,
      value: work.filter((t) => t.priority === priority && t.status !== 'DONE').length,
    })),
    health: activeProjects.map((project) => {
      const list = work.filter((t) => t.projectId === project.id);
      return {
        project,
        total: list.length,
        completed: list.filter((t) => t.status === 'DONE').length,
        overdue: overdue.filter((t) => t.projectId === project.id).length,
      };
    }),
  };
}
