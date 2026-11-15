import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { AgentProvider, AgentReply } from '../src/lib/agent';
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (key: string) => (jar.has(key) ? { value: jar.get(key) } : undefined),
    set: (key: string, value: string) => jar.set(key, value),
    delete: (key: string) => jar.delete(key),
  }),
}));
import { GET, POST, PATCH } from '../src/app/api/[...path]/route';
import {
  createConversation,
  decideAgentProposal,
  getConversation,
  sendAgentTurn,
} from '../src/lib/server/agent-manager';
import type { WorkspaceActor } from '../src/lib/server/tasks';
import { readAgentTool } from '../src/lib/server/agent-tools';
import { ProviderRateLimitError } from '../src/lib/server/provider-rate-limit';
const db = new PrismaClient();
const email = `agent-integration-${randomUUID()}@example.com`;
const otherEmail = `agent-outsider-${randomUUID()}@example.com`;
let actor: WorkspaceActor;
let workspaceId = '';
let projectId = '';
let parentId = '';
let conversationId = '';
let session = '';
let connected = false;
const workspaceIds: string[] = [];
async function call(method: 'GET' | 'POST' | 'PATCH', path: string, value?: unknown) {
  const request = new Request(`http://localhost:3000/api/${path}?workspaceId=${workspaceId}`, {
    method,
    headers: { origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  return { GET, POST, PATCH }[method](request, {
    params: Promise.resolve({ path: path.split('/') }),
  });
}
function providerFor(name: string, input: unknown): AgentProvider {
  let calls = 0;
  return {
    complete: async () =>
      ++calls === 1
        ? {
            content: null,
            tool_calls: [
              {
                id: 'tool-call',
                type: 'function',
                function: { name, arguments: JSON.stringify(input) },
              },
            ],
          }
        : { content: 'Integration provider fixture: review the pending action.', tool_calls: [] },
  };
}
const propose = (name: string, input: unknown) =>
  sendAgentTurn(
    actor,
    conversationId,
    { requestId: randomUUID(), prompt: `Integration fixture for ${name}` },
    providerFor(name, input),
  );
beforeAll(async () => {
  await db.$connect();
  connected = true;
  expect(
    (
      await call('POST', 'auth/register', {
        name: 'AI Integration Owner',
        email,
        password: 'an-ai-integration-password',
      })
    ).status,
  ).toBe(201);
  session = jar.get('devflow_session')!;
  const me = await (await call('GET', 'me')).json();
  workspaceId = me.workspaces[0].id;
  workspaceIds.push(workspaceId);
  actor = { userId: me.user.id, name: me.user.name, workspaceId };
  const project = await call('POST', 'projects', { name: 'Agent verification' });
  expect(project.status).toBe(201);
  projectId = (await project.json()).id;
  const parent = await call('POST', 'tasks', { projectId, title: 'Parent work' });
  expect(parent.status).toBe(201);
  parentId = (await parent.json()).id;
  conversationId = (await createConversation(actor, { title: 'Agent lifecycle', projectId })).id;
});
afterAll(async () => {
  try {
    if (connected) {
      await db.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
      await db.user.deleteMany({ where: { email: { in: [email, otherEmail] } } });
    }
  } finally {
    await db.$disconnect();
  }
});
describe.sequential(
  'agent persistence and approval integration (stubbed provider, real database)',
  () => {
    it('persists actual scoped read events and idempotently replays a completed request', async () => {
      const request = { requestId: randomUUID(), prompt: 'List actual projects' };
      const provider = providerFor('listProjects', {});
      const complete = vi.spyOn(provider, 'complete');
      const run = await sendAgentTurn(actor, conversationId, request, provider);
      expect(run.events).toHaveLength(1);
      expect(JSON.stringify(run.events[0].output)).toContain(projectId);
      const replay = await sendAgentTurn(actor, conversationId, request, provider);
      expect(replay.id).toBe(run.id);
      expect(complete).toHaveBeenCalledTimes(2);
      await expect(
        sendAgentTurn(actor, conversationId, { ...request, prompt: 'Different request' }, provider),
      ).rejects.toMatchObject({ status: 409 });
    });
    it('distinguishes personal, unassigned and all-project tasks with persisted friendly read results', async () => {
      const empty = await propose('listTasks', { scope: 'mine' });
      expect(empty.events[0].output).toMatchObject({
        items: [],
        total: 0,
        scope: { kind: 'mine', assigneeId: actor.userId },
      });
      const assigned = await db.task.create({
        data: {
          projectId,
          title: 'Assigned ownership fixture',
          assigneeId: actor.userId,
          status: 'IN_PROGRESS',
        },
      });
      const other = await db.project.create({
        data: { workspaceId, name: 'Ownership scope boundary' },
      });
      await db.task.create({
        data: {
          projectId: other.id,
          title: 'Outside personal conversation',
          assigneeId: actor.userId,
        },
      });
      const mine = await propose('listTasks', { scope: 'mine' });
      expect(mine.events[0].output).toMatchObject({
        total: 1,
        items: [
          {
            id: assigned.id,
            reference: `DEV-${assigned.number}`,
            statusLabel: 'In Progress',
            assigneeName: actor.name,
            projectName: 'Agent verification',
          },
        ],
      });
      const all = await propose('listTasks', { scope: 'all' });
      expect(all.events[0].output).toMatchObject({ total: 2 });
      const unassigned = await propose('listTasks', { scope: 'unassigned' });
      expect(unassigned.events[0].output).toMatchObject({
        total: 1,
        items: [{ id: parentId, assigneeName: 'Unassigned' }],
      });
      const saved = await getConversation(actor, conversationId);
      expect(saved.runs.find((r) => r.id === mine.id)?.events[0].output).toEqual(
        mine.events[0].output,
      );
      expect(mine.proposals).toHaveLength(0);
    });
    it('retrieves truthful empty-personal project context, workspace pages and archived isolation', async () => {
      // Explicit database fixtures, never automatic AI assignments.
      const p = await db.project.create({ data: { workspaceId, name: 'Contextual read fixture' } });
      const localActor = { ...actor, projectId: p.id };
      const tasks = await Promise.all(
        ['TODO', 'IN_PROGRESS', 'DONE'].map((status, i) =>
          db.task.create({
            data: {
              projectId: p.id,
              title: `Context work ${i}`,
              status: status as 'TODO' | 'IN_PROGRESS' | 'DONE',
            },
          }),
        ),
      );
      const read = (input: unknown) =>
        db.$transaction((tx) => readAgentTool(tx, localActor, 'listTasks', input), {
          isolationLevel: 'RepeatableRead',
        });
      const result = await read({ scope: 'mine', includeProjectContext: true });
      expect(result).toMatchObject({
        items: [],
        total: 0,
        context: { authenticatedUserId: actor.userId, createdBySupported: false },
        projectContext: { total: 3, unassignedTotal: 3, scope: { kind: 'all' } },
      });
      const explicit = await read({ scope: 'mine' });
      expect(explicit).not.toHaveProperty('projectContext');
      const pending = await read({ scope: 'unassigned', unfinished: true, limit: 1 });
      expect(pending).toMatchObject({ total: 2, hasMore: true, nextOffset: 1 });
      const next = await read({ scope: 'unassigned', unfinished: true, offset: 1, limit: 1 });
      expect(next).toMatchObject({ total: 2, hasMore: false, nextOffset: null });
      const workspaceRead = await db.$transaction((tx) =>
        readAgentTool(tx, { ...actor, projectId: null }, 'listTasks', { scope: 'all', limit: 50 }),
      );
      const expected = await db.task.count({
        where: { project: { workspaceId, archivedAt: null } },
      });
      expect(workspaceRead).toMatchObject({
        total: expected,
        items: expect.arrayContaining(tasks.map((t) => expect.objectContaining({ id: t.id }))),
      });
      const c = await createConversation(actor, { title: 'Verified context', projectId: p.id });
      const capture = providerFor('listTasks', { scope: 'mine', includeProjectContext: true });
      const complete = vi.spyOn(capture, 'complete');
      const run = await sendAgentTurn(
        actor,
        c.id,
        { requestId: randomUUID(), prompt: 'My current tasks?' },
        capture,
      );
      expect(run.proposals).toHaveLength(0);
      expect(run.events[0].output).toMatchObject({
        total: 0,
        projectContext: { total: 3, unassignedTotal: 3 },
      });
      expect(complete).not.toHaveBeenCalled();
      expect((await getConversation(actor, c.id)).project).toMatchObject({
        id: p.id,
        name: p.name,
      });
      await db.project.update({ where: { id: p.id }, data: { archivedAt: new Date() } });
      await expect(read({ scope: 'all' })).rejects.toMatchObject({ status: 404 });
      const activeOnly = await db.$transaction((tx) =>
        readAgentTool(tx, { ...actor, projectId: null }, 'listTasks', { scope: 'all', limit: 50 }),
      );
      expect(activeOnly).toMatchObject({
        items: expect.not.arrayContaining([expect.objectContaining({ projectId: p.id })]),
      });
      await expect(
        db.$transaction((tx) =>
          readAgentTool(tx, { ...localActor, userId: 'not-a-member' }, 'listTasks', {
            scope: 'mine',
            includeProjectContext: true,
          }),
        ),
      ).rejects.toMatchObject({ status: 404 });
    });
    it('does not leak another project through a scoped tool call', async () => {
      const other = await db.project.create({
        data: { workspaceId, name: 'Outside conversation context' },
      });
      const read = await propose('getProject', { projectId: other.id });
      expect(read.proposals).toHaveLength(0);
      expect(JSON.stringify(read.events[0].output)).toContain('not found');
      expect(JSON.stringify(read.events[0].output)).not.toContain(other.name);
      const write = await propose('createTask', {
        projectId: other.id,
        title: 'Scope escape attempt',
      });
      expect(write.proposals).toHaveLength(0);
      expect(await db.task.count({ where: { projectId: other.id } })).toBe(0);
    });
    it('creates no task before approval, then executes concurrent repeated approvals exactly once', async () => {
      const run = await propose('createTask', {
        projectId,
        title: 'Approved child',
        parentTaskId: parentId,
      });
      expect(await db.task.count({ where: { projectId, title: 'Approved child' } })).toBe(0);
      const proposal = run.proposals[0];
      expect(proposal.status).toBe('PENDING');
      const approvals = await Promise.all([
        call('POST', `ai/proposals/${proposal.id}/decision`, {
          decision: 'approve',
          previewHash: proposal.previewHash,
        }),
        call('POST', `ai/proposals/${proposal.id}/decision`, {
          decision: 'approve',
          previewHash: proposal.previewHash,
        }),
      ]);
      expect(approvals.map((r) => r.status)).toEqual([200, 200]);
      const receipts = await Promise.all(approvals.map((r) => r.json()));
      expect(receipts[0].result.id).toBe(receipts[1].result.id);
      expect(
        await db.task.count({
          where: { projectId, title: 'Approved child', parentTaskId: parentId },
        }),
      ).toBe(1);
    });
    it('rejects stale task updates without changing the task, and rejection is terminal', async () => {
      const run = await propose('updateTask', {
        taskId: parentId,
        changes: { priority: 'URGENT' },
      });
      const current = await db.task.findUniqueOrThrow({ where: { id: parentId } });
      expect(
        (await call('PATCH', `tasks/${parentId}`, { version: current.version, priority: 'LOW' }))
          .status,
      ).toBe(200);
      const p = run.proposals[0];
      expect(
        (
          await call('POST', `ai/proposals/${p.id}/decision`, {
            decision: 'approve',
            previewHash: p.previewHash,
          })
        ).status,
      ).toBe(409);
      expect((await db.task.findUniqueOrThrow({ where: { id: parentId } })).priority).toBe('LOW');
      expect(
        (
          await call('POST', `ai/proposals/${p.id}/decision`, {
            decision: 'reject',
            previewHash: p.previewHash,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await call('POST', `ai/proposals/${p.id}/decision`, {
            decision: 'approve',
            previewHash: p.previewHash,
          })
        ).status,
      ).toBe(409);
    });
    it('binds sprint baselines to current task versions and rejects overlapping task assignments', async () => {
      const input = {
        projectId,
        name: 'Verified sprint',
        goal: 'A real task baseline',
        startDate: '2026-11-15T00:00:00Z',
        endDate: '2026-11-28T23:59:59Z',
        taskIds: [parentId],
      };
      const old = (await propose('createSprint', input)).proposals[0];
      const task = await db.task.findUniqueOrThrow({ where: { id: parentId } });
      await call('PATCH', `tasks/${parentId}`, {
        version: task.version,
        title: 'Updated parent work',
      });
      await expect(
        decideAgentProposal(actor, old.id, { decision: 'approve', previewHash: old.previewHash }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await db.sprint.count({ where: { projectId } })).toBe(0);
      const fresh = (await propose('createSprint', input)).proposals[0];
      const applied = await decideAgentProposal(actor, fresh.id, {
        decision: 'approve',
        previewHash: fresh.previewHash,
      });
      expect(applied.status).toBe('APPLIED');
      expect(await db.sprintTask.count({ where: { projectId, taskId: parentId } })).toBe(1);
      const baseline = await db.sprintTask.findFirstOrThrow({
        where: { projectId, taskId: parentId },
      });
      const current = await db.task.findUniqueOrThrow({ where: { id: parentId } });
      expect(baseline).toMatchObject({
        taskVersion: current.version,
        titleSnapshot: current.title,
        statusSnapshot: current.status,
      });
      expect(
        (
          await decideAgentProposal(actor, fresh.id, {
            decision: 'approve',
            previewHash: fresh.previewHash,
          })
        ).replayed,
      ).toBe(true);
      expect(await db.sprint.count({ where: { projectId } })).toBe(1);
      expect(await db.sprintTask.count({ where: { projectId, taskId: parentId } })).toBe(1);
      const overlapping = await propose('createSprint', input);
      expect(overlapping.proposals).toHaveLength(0);
      expect(JSON.stringify(overlapping.events)).toContain('overlapping');
    });
    it('persists an approved report with actual snapshot metrics, and expires pending actions', async () => {
      const run = await propose('generateReport', {
        projectId,
        title: 'Integration weekly report',
        content: 'Narrative from an explicitly stubbed integration provider.',
        periodStart: '2026-11-01T00:00:00Z',
        periodEnd: '2026-11-30T23:59:59Z',
      });
      expect(await db.projectReport.count({ where: { projectId } })).toBe(0);
      const p = run.proposals[0];
      await decideAgentProposal(actor, p.id, { decision: 'approve', previewHash: p.previewHash });
      const report = await db.projectReport.findFirstOrThrow({ where: { projectId } });
      expect(JSON.stringify(report.source)).toContain('currentlyDoneCompletedInPeriod');
      const pending = (await propose('createTask', { projectId, title: 'Expired proposal' }))
        .proposals[0];
      await db.aIProposal.update({ where: { id: pending.id }, data: { expiresAt: new Date(0) } });
      await expect(
        decideAgentProposal(actor, pending.id, {
          decision: 'approve',
          previewHash: pending.previewHash,
        }),
      ).rejects.toMatchObject({ status: 410 });
      expect(await db.task.count({ where: { projectId, title: 'Expired proposal' } })).toBe(0);
      expect((await getConversation(actor, conversationId)).runs.length).toBeGreaterThan(0);
    });
    it('prevents a second active turn and fences a late result after run expiry', async () => {
      let started!: () => void;
      let finish!: (reply: AgentReply) => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const provider: AgentProvider = {
        complete: async () => {
          started();
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      };
      const request = {
        requestId: randomUUID(),
        prompt: 'Hold this run for concurrency verification',
      };
      const running = sendAgentTurn(actor, conversationId, request, provider);
      await ready;
      await expect(
        sendAgentTurn(actor, conversationId, { ...request, requestId: randomUUID() }, provider),
      ).rejects.toMatchObject({ status: 409 });
      await db.aIRun.updateMany({
        where: { conversationId, status: 'RUNNING' },
        data: { expiresAt: new Date(0) },
      });
      finish({ content: 'Late result must not be committed', tool_calls: [] });
      await expect(running).rejects.toMatchObject({ status: 409 });
    });
    it('persists full successful task data after a late rate limit without proposals or domain writes', async () => {
      const c = await createConversation(actor, { title: 'Partial provider response', projectId });
      const before = await db.task.count({ where: { projectId } });
      const complete = vi
        .fn()
        .mockResolvedValueOnce({
          content: null,
          tool_calls: [
            {
              id: 'read',
              type: 'function',
              function: { name: 'listTasks', arguments: '{"scope":"all"}' },
            },
          ],
        })
        .mockRejectedValueOnce(new ProviderRateLimitError('Groq', Date.now() + 60000));
      await expect(
        sendAgentTurn(
          actor,
          c.id,
          { requestId: randomUUID(), prompt: 'Project tasks?' },
          { complete },
        ),
      ).rejects.toMatchObject({ status: 429 });
      const saved = (await getConversation(actor, c.id)).runs[0];
      expect(saved.status).toBe('FAILED');
      expect(saved.answer).toBe('');
      expect(saved.events).toHaveLength(1);
      expect(saved.events[0].output).toMatchObject({
        total: before,
        items: expect.arrayContaining([
          expect.objectContaining({ id: parentId, version: expect.any(Number) }),
        ]),
      });
      expect(saved.proposals).toHaveLength(0);
      expect(complete).toHaveBeenCalledTimes(2);
      expect(await db.task.count({ where: { projectId } })).toBe(before);
    });
    it('keeps conversations/proposals private even from a member of the same workspace', async () => {
      const pending = (await propose('createTask', { projectId, title: 'Private pending action' }))
        .proposals[0];
      const response = await call('POST', 'auth/register', {
        name: 'Other member',
        email: otherEmail,
        password: 'another-ai-test-password',
      });
      expect(response.status).toBe(201);
      const me = await (await call('GET', 'me')).json();
      workspaceIds.push(me.workspaces[0].id);
      await db.workspaceMember.create({ data: { workspaceId, userId: me.user.id } });
      expect((await call('GET', `ai/conversations/${conversationId}`)).status).toBe(404);
      expect(
        (
          await call('POST', `ai/proposals/${pending.id}/decision`, {
            decision: 'approve',
            previewHash: pending.previewHash,
          })
        ).status,
      ).toBe(404);
      jar.set('devflow_session', session);
      await db.workspaceMember.delete({
        where: { workspaceId_userId: { workspaceId, userId: actor.userId } },
      });
      expect(
        (
          await call('POST', `ai/proposals/${pending.id}/decision`, {
            decision: 'approve',
            previewHash: pending.previewHash,
          })
        ).status,
      ).toBe(404);
      await db.workspaceMember.create({
        data: { workspaceId, userId: actor.userId, role: 'OWNER' },
      });
      expect(await db.task.count({ where: { projectId, title: 'Private pending action' } })).toBe(
        0,
      );
    });
  },
);

it('routes simple workspace reads and explicit name follow-ups with zero provider calls and real task scopes', async () => {
  const local = await db.project.create({ data: { workspaceId, name: 'Routing fixture' } });
  const unassigned = await db.task.create({
    data: { projectId: local.id, title: 'Unassigned routing task', status: 'TODO' },
  });
  const assigned = await db.task.create({
    data: {
      projectId: local.id,
      title: 'Assigned routing task',
      assigneeId: actor.userId,
      status: 'IN_PROGRESS',
    },
  });
  const c = await createConversation(actor, { title: 'Routing workspace' });
  const complete = vi.fn().mockRejectedValue(new Error('No provider budget available'));
  const send = (prompt: string) =>
    sendAgentTurn(actor, c.id, { requestId: randomUUID(), prompt }, { complete });
  const all = await send('all workspace tasks');
  expect(all.status).toBe('COMPLETED');
  expect(all.events).toHaveLength(1);
  expect(all.events[0].output).toMatchObject({
    items: expect.arrayContaining([
      expect.objectContaining({ id: assigned.id }),
      expect.objectContaining({ id: unassigned.id }),
    ]),
    scope: { projectId: null },
  });
  const mine = await send('my assigned tasks');
  expect(mine.events[0].output).toMatchObject({
    items: expect.arrayContaining([expect.objectContaining({ id: assigned.id })]),
    scope: { assigneeId: actor.userId, projectId: null },
  });
  const named = await send('unassigned tasks in project Routing fixture');
  expect(named.events[0].output).toMatchObject({
    total: 1,
    items: [{ id: unassigned.id }],
    scope: { kind: 'unassigned', projectId: local.id },
  });
  const selected = await send('all project tasks');
  expect(selected.events[0].output).toMatchObject({ total: 2, scope: { projectId: local.id } });
  expect(selected.answer).toContain('no AI-generated narrative');
  expect(complete).not.toHaveBeenCalled();
  expect(selected.proposals).toHaveLength(0);
});
