import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
    delete: (name: string) => jar.delete(name),
  }),
}));
import { GET, POST, PATCH, DELETE } from '../src/app/api/[...path]/route';
const db = new PrismaClient();
const stamp = `${Date.now()}-${Math.random()}`;
const email = `test-${stamp}@example.com`;
const outsiderEmail = `outsider-${stamp}@example.com`;
let workspaceId = '';
let foreignWorkspace = '';
let projectId = '';
let taskId = '';
let session = '';
let version = 0;
let connected = false;
async function call(
  method: string,
  path: string,
  value?: unknown,
  scope = workspaceId,
  origin = 'http://localhost:3000',
) {
  const [route, query] = path.split('?');
  const search = new URLSearchParams(query);
  if (scope) search.set('workspaceId', scope);
  const url = `http://localhost:3000/api/${route}?${search}`;
  const request = new Request(url, {
    method,
    headers: { origin, 'Content-Type': 'application/json' },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  const handler = { GET, POST, PATCH, DELETE }[method as 'GET'];
  return handler(request, { params: Promise.resolve({ path: route.split('/') }) });
}
beforeAll(async () => {
  await db.$connect();
  connected = true;
});
afterAll(async () => {
  if (!connected) {
    await db.$disconnect();
    return;
  }
  try {
    const users = await db.user.findMany({ where: { email: { in: [email, outsiderEmail] } } });
    const ws = await db.workspaceMember.findMany({
      where: { userId: { in: users.map((u) => u.id) } },
      select: { workspaceId: true },
    });
    await db.workspace.deleteMany({ where: { id: { in: ws.map((w) => w.workspaceId) } } });
    await db.user.deleteMany({ where: { email: { in: [email, outsiderEmail] } } });
  } finally {
    await db.$disconnect();
  }
});
describe.sequential('real database and API journeys', () => {
  it('rejects unauthenticated protected endpoints', async () => {
    jar.clear();
    expect((await call('GET', 'snapshot', undefined, 'unknown')).status).toBe(401);
    expect((await call('GET', 'roadmap', undefined, 'unknown')).status).toBe(401);
    for (const method of ['POST', 'DELETE'])
      expect(
        (
          await call(
            method,
            'roadmap/dependencies',
            { projectId: 'p', predecessorId: 'a', successorId: 'b' },
            'unknown',
          )
        ).status,
      ).toBe(401);
  });
  it('registers a user with a hashed password and opaque session', async () => {
    const response = await call('POST', 'auth/register', {
      name: 'Integration User',
      email,
      password: 'a-long-test-password',
    });
    expect(response.status).toBe(201);
    session = jar.get('devflow_session')!;
    expect(session).toHaveLength(64);
    const user = await db.user.findUniqueOrThrow({
      where: { email },
      include: { memberships: true, sessions: true },
    });
    expect(user.passwordHash).toMatch(/^scrypt:/);
    expect(user.sessions[0].tokenHash).not.toBe(session);
    workspaceId = user.memberships[0].workspaceId;
  });
  it('rejects cross-origin mutations', async () => {
    expect(
      (await call('POST', 'projects', { name: 'Rejected' }, workspaceId, 'https://evil.example'))
        .status,
    ).toBe(403);
  });
  it('creates projects, tasks, labels and assignment relationships', async () => {
    const p = await call('POST', 'projects', { name: 'Integration project' });
    expect(p.status).toBe(201);
    projectId = (await p.json()).id;
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    const label = await db.label.findFirstOrThrow({ where: { workspaceId } });
    const t = await call('POST', 'tasks', {
      projectId,
      title: 'Build the API',
      assigneeId: user.id,
      labelIds: [label.id],
    });
    expect(t.status).toBe(201);
    const result = await t.json();
    taskId = result.id;
    version = result.version;
    expect(result.labels[0].label.id).toBe(label.id);
    expect(result.assignee.id).toBe(user.id);
  });
  it('moves a task, persists order and status, and rejects stale writes', async () => {
    const response = await call('PATCH', `tasks/${taskId}`, {
      version,
      status: 'IN_PROGRESS',
      position: 1536,
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.status).toBe('IN_PROGRESS');
    expect(result.position).toBe(1536);
    expect((await call('PATCH', `tasks/${taskId}`, { version, status: 'DONE' })).status).toBe(409);
    version = result.version;
    const record = await db.task.findUniqueOrThrow({
      where: { id: taskId },
      include: { labels: true },
    });
    expect(record.labels).toHaveLength(1);
  });
  it('persists comments and durable collaboration activity', async () => {
    expect(
      (await call('POST', `tasks/${taskId}/comments`, { body: 'Ready for review' })).status,
    ).toBe(201);
    const detail = await (await call('GET', `tasks/${taskId}`)).json();
    expect(detail.comments[0].body).toBe('Ready for review');
    expect(
      detail.activities.some((a: { message: string }) => a.message.includes('commented')),
    ).toBe(true);
  });
  it('persists schedules and rejects invalid partial updates and stale rescheduling', async () => {
    const response = await call('PATCH', `tasks/${taskId}`, {
      version,
      startDate: '2026-11-01T00:00:00Z',
      dueDate: '2026-11-03T23:59:59Z',
    });
    expect(response.status).toBe(200);
    const updated = await response.json();
    expect(updated.startDate).toBe('2026-11-01T00:00:00.000Z');
    expect(
      (await call('PATCH', `tasks/${taskId}`, { version, dueDate: '2026-11-05T00:00:00Z' })).status,
    ).toBe(409);
    version = updated.version;
    expect(
      (await call('PATCH', `tasks/${taskId}`, { version, dueDate: '2026-10-31T23:59:59Z' })).status,
    ).toBe(400);
    expect((await call('PATCH', `tasks/${taskId}`, { version, isMilestone: true })).status).toBe(
      400,
    );
    const milestone = await call('POST', 'tasks', {
      projectId,
      title: 'Release milestone',
      startDate: '2026-11-05T00:00:00Z',
      dueDate: '2026-11-05T23:59:59Z',
      isMilestone: true,
    });
    expect(milestone.status).toBe(201);
    expect(
      (await call('POST', 'tasks', { projectId, title: 'Invalid milestone', isMilestone: true }))
        .status,
    ).toBe(400);
  });
  it('persists dependencies, rejects cycles and serializes concurrent opposite edges', async () => {
    const make = async (title: string) => {
      const response = await call('POST', 'tasks', { projectId, title });
      expect(response.status).toBe(201);
      return (await response.json()).id as string;
    };
    const a = await make('Dependency A');
    const b = await make('Dependency B');
    const c = await make('Dependency C');
    const dependency = (predecessorId: string, successorId: string) => ({
      projectId,
      predecessorId,
      successorId,
    });
    expect((await call('POST', 'roadmap/dependencies', dependency(a, b))).status).toBe(200);
    expect((await call('POST', 'roadmap/dependencies', dependency(a, b))).status).toBe(200);
    expect(await db.taskDependency.count({ where: dependency(a, b) })).toBe(1);
    expect((await call('POST', 'roadmap/dependencies', dependency(b, c))).status).toBe(200);
    expect((await call('POST', 'roadmap/dependencies', dependency(c, a))).status).toBe(400);
    expect((await call('POST', 'roadmap/dependencies', dependency(a, a))).status).toBe(400);
    expect(
      (await call('POST', 'roadmap/dependencies', dependency(taskId, 'unknown-task'))).status,
    ).toBe(404);
    const another = await call('POST', 'projects', { name: 'Other project' });
    const otherId = (await another.json()).id;
    const other = await (
      await call('POST', 'tasks', { projectId: otherId, title: 'Other project task' })
    ).json();
    expect((await call('POST', 'roadmap/dependencies', dependency(a, other.id))).status).toBe(404);
    const x = await make('Concurrent X');
    const y = await make('Concurrent Y');
    const results = await Promise.all([
      call('POST', 'roadmap/dependencies', dependency(x, y)),
      call('POST', 'roadmap/dependencies', dependency(y, x)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const u = await make('Concurrent chain U');
    const v = await make('Concurrent chain V');
    const w = await make('Concurrent chain W');
    expect((await call('POST', 'roadmap/dependencies', dependency(u, v))).status).toBe(200);
    const transitive = await Promise.all([
      call('POST', 'roadmap/dependencies', dependency(v, w)),
      call('POST', 'roadmap/dependencies', dependency(w, u)),
    ]);
    expect(transitive.map((r) => r.status).sort()).toEqual([200, 400]);
    expect((await call('DELETE', 'roadmap/dependencies', dependency(a, b))).status).toBe(200);
    expect(await db.taskDependency.count({ where: dependency(a, b) })).toBe(0);
    const repeatedDelete = await call('DELETE', 'roadmap/dependencies', dependency(a, b));
    expect(await repeatedDelete.json()).toMatchObject({ ok: true, changed: false });
    await call('POST', 'roadmap/dependencies', dependency(taskId, c));
    expect(await db.taskDependency.count({ where: { predecessorId: taskId } })).toBe(1);
    const roadmap = await call('GET', `roadmap?projectId=${projectId}`);
    expect(roadmap.status).toBe(200);
    const result = await roadmap.json();
    expect(result.project.id).toBe(projectId);
    expect(result.tasks.some((t: { id: string }) => t.id === taskId)).toBe(true);
    expect(
      result.dependencies.some((e: { predecessorId: string }) => e.predecessorId === taskId),
    ).toBe(true);
  });
  it('permits only one concurrent update for the same task version', async () => {
    const writes = await Promise.all([
      call('PATCH', `tasks/${taskId}`, { version, priority: 'HIGH' }),
      call('PATCH', `tasks/${taskId}`, { version, priority: 'LOW' }),
    ]);
    expect(writes.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = await writes.find((r) => r.status === 200)!.json();
    expect(winner.version).toBe(version + 1);
    const persisted = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(persisted.priority).toBe(winner.priority);
    version = winner.version;
  });
  it('prevents all cross-workspace resource access', async () => {
    jar.clear();
    expect(
      (
        await call('POST', 'auth/register', {
          name: 'Outsider',
          email: outsiderEmail,
          password: 'another-long-password',
        })
      ).status,
    ).toBe(201);
    const memberships = await db.workspaceMember.findMany({
      where: { user: { email: outsiderEmail } },
    });
    foreignWorkspace = memberships[0].workspaceId;
    expect((await call('GET', 'snapshot', undefined, workspaceId)).status).toBe(404);
    expect(
      (await call('GET', `roadmap?projectId=${projectId}`, undefined, workspaceId)).status,
    ).toBe(404);
    expect(
      (
        await call(
          'DELETE',
          'roadmap/dependencies',
          { projectId, predecessorId: taskId, successorId: 'unknown' },
          foreignWorkspace,
        )
      ).status,
    ).toBe(404);
    expect(
      (await call('GET', `roadmap?projectId=${projectId}`, undefined, foreignWorkspace)).status,
    ).toBe(404);
    expect(
      (
        await call(
          'POST',
          'roadmap/dependencies',
          { projectId, predecessorId: taskId, successorId: 'unknown' },
          foreignWorkspace,
        )
      ).status,
    ).toBe(404);
    expect((await call('GET', `tasks/${taskId}`, undefined, foreignWorkspace)).status).toBe(404);
    expect(
      (
        await call(
          'POST',
          'tasks',
          { projectId, title: 'Cross workspace attempt' },
          foreignWorkspace,
        )
      ).status,
    ).toBe(404);
    expect(
      (await call('PATCH', `projects/${projectId}`, { archived: true }, foreignWorkspace)).status,
    ).toBe(404);
    jar.set('devflow_session', session);
  });
  it('blocks edits to archived projects and allows restoration', async () => {
    expect((await call('PATCH', `projects/${projectId}`, { archived: true })).status).toBe(200);
    expect(
      (
        await call('POST', 'roadmap/dependencies', {
          projectId,
          predecessorId: taskId,
          successorId: 'unknown',
        })
      ).status,
    ).toBe(409);
    expect((await call('PATCH', `tasks/${taskId}`, { version, title: 'Blocked' })).status).toBe(
      409,
    );
    await call('PATCH', `projects/${projectId}`, { archived: false });
  });
  it('deletes task children through foreign-key cascades', async () => {
    expect((await call('DELETE', `tasks/${taskId}`)).status).toBe(200);
    expect(await db.taskComment.count({ where: { taskId } })).toBe(0);
    expect(await db.taskLabel.count({ where: { taskId } })).toBe(0);
    expect(
      await db.taskDependency.count({
        where: { OR: [{ predecessorId: taskId }, { successorId: taskId }] },
      }),
    ).toBe(0);
    expect((await call('GET', `tasks/${taskId}`)).status).toBe(404);
  });
  it('logs out, rejects invalid login, and creates a new session for valid login', async () => {
    expect((await call('POST', 'auth/logout')).status).toBe(200);
    expect((await call('GET', 'me')).status).toBe(401);
    expect((await call('POST', 'auth/login', { email, password: 'wrong password' })).status).toBe(
      401,
    );
    expect(
      (await call('POST', 'auth/login', { email, password: 'a-long-test-password' })).status,
    ).toBe(200);
    expect((await call('GET', 'me')).status).toBe(200);
  });
});
