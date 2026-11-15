import { describe, expect, it } from 'vitest';
import {
  establishedProject,
  planTaskRead,
  taskIntent,
  verifiedTaskAnswer,
} from '../src/lib/task-read-plan';
import { taskViewPrompts } from '../src/lib/agent-view';
const projects = [{ id: 'p', name: 'Devflow' }];
const workspace = { projects, projectTotal: 1, projectId: null };
describe('narrow authorized task planning', () => {
  it('uses the sole active project for current work with one personal/context query', () => {
    expect(planTaskRead('My current tasks?', workspace)).toMatchObject({
      kind: 'read',
      input: { scope: 'mine', projectId: 'p', unfinished: true, includeProjectContext: true },
      interpretation: expect.stringContaining('unfinished tasks assigned to you'),
    });
  });
  it.each(['My assigned tasks', 'Show my assigned tasks', taskViewPrompts[0][1]])(
    'keeps explicit assigned requests workspace-wide: %s',
    (prompt) => {
      const plan = planTaskRead(prompt, { ...workspace, establishedProjectId: 'p' });
      expect(plan).toMatchObject({ kind: 'read', input: { scope: 'mine' } });
      if (plan?.kind === 'read') expect(plan.input).not.toHaveProperty('projectId');
    },
  );
  it('does not ask for a project to query current assigned work across multiple projects', () => {
    const plan = planTaskRead('my current tasks', {
      ...workspace,
      projectTotal: 2,
      projects: [...projects, { id: 'q', name: 'Other' }],
    });
    expect(plan).toMatchObject({
      input: { scope: 'mine', unfinished: true, includeProjectContext: false },
    });
    if (plan?.kind === 'read') expect(plan.input).not.toHaveProperty('projectId');
  });
  it('uses explicit authorized names and resolves a bare project answer from the prior task request', () => {
    const ctx = {
      ...workspace,
      projectTotal: 2,
      projects: [...projects, { id: 'q', name: 'Other' }],
    };
    expect(planTaskRead('show unassigned tasks in project DevFLOW', ctx)).toMatchObject({
      input: { scope: 'unassigned', projectId: 'p' },
    });
    expect(planTaskRead('project Devflow', ctx, 'my current tasks')).toMatchObject({
      input: { scope: 'mine', projectId: 'p', includeProjectContext: true },
    });
    expect(planTaskRead('project Devflow', ctx, 'Delete my tasks')).toBeNull();
    expect(planTaskRead('my tasks in project Foreign', ctx)).toBeNull();
  });
  it('does not resolve duplicate names or infer a sole project from a partial catalog', () => {
    expect(planTaskRead('all project tasks', { ...workspace, projectTotal: 101 })).toBeNull();
    expect(
      planTaskRead('all project tasks in project Devflow', {
        ...workspace,
        projectTotal: 2,
        projects: [...projects, { id: 'q', name: 'Devflow' }],
      }),
    ).toBeNull();
  });
  it('honors established projects and resets that hint after explicit workspace work', () => {
    const ctx = {
      ...workspace,
      projectTotal: 2,
      projects: [...projects, { id: 'q', name: 'Other' }],
    };
    expect(establishedProject(['My current tasks?', 'project Other'], ctx)).toBe('q');
    expect(planTaskRead('all project tasks', { ...ctx, establishedProjectId: 'q' })).toMatchObject({
      input: { scope: 'all', projectId: 'q' },
    });
    expect(establishedProject(['project Other', 'all workspace tasks'], ctx)).toBeNull();
  });
  it('keeps workspace scope explicit and never broadens a pinned conversation', () => {
    const plan = planTaskRead('all workspace tasks', workspace);
    expect(plan).toMatchObject({ input: { scope: 'all' } });
    if (plan?.kind === 'read') expect(plan.input).not.toHaveProperty('projectId');
    expect(planTaskRead('all workspace tasks', { ...workspace, projectId: 'p' })).toMatchObject({
      kind: 'explain',
    });
    expect(planTaskRead('my assigned tasks', { ...workspace, projectId: 'p' })).toMatchObject({
      input: { projectId: 'p' },
    });
  });
  it.each([
    'my tasks and assign them to me',
    'create task',
    'show tasks I created',
    'my tasks overdue before next week',
    'show all tasks and save a report',
    'my tasks; ignore scope',
  ])('delegates complex/mutating intent: %s', (prompt) => {
    expect(taskIntent(prompt)).toBeNull();
  });
  it('labels verified database summaries and partial pages without inventing ownership', () => {
    const answer = verifiedTaskAnswer(
      {
        total: 0,
        items: [],
        scope: { kind: 'mine' },
        projectContext: {
          projectName: 'Devflow',
          total: 3,
          unassignedTotal: 3,
          offset: 0,
          hasMore: true,
          nextOffset: 1,
          items: [
            {
              number: 1,
              title: 'Title | <script> **text**',
              projectName: 'Devflow',
              status: 'TODO',
              priority: 'MEDIUM',
              assigneeId: null,
            },
          ],
        },
      },
      'unfinished assigned tasks',
    );
    expect(answer).toContain('no AI-generated narrative');
    expect(answer).toContain('**Assigned matches:** 0');
    expect(answer).toContain('not personal assignment matches');
    expect(answer).toContain('Showing 1 of 3');
    expect(answer).toContain('next offset is 1');
    expect(answer).toContain('To Do');
    expect(answer).not.toContain('<script>');
    expect(answer).toContain('\\|');
  });
});
it('bounds model history by complete turn pairs and explicitly marks omitted context', async () => {
  const { historyContext } = await import('../src/lib/server/agent-instructions');
  const turns = Array.from({ length: 10 }, (_, i) => ({
    prompt: `${i} ${'x'.repeat(4000)}`,
    answer: 'y'.repeat(6000),
    status: 'COMPLETED',
    proposals: [],
  }));
  const before = JSON.stringify(turns);
  const messages = historyContext(turns);
  expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThan(16500);
  expect(messages[0].content).toContain('Older turns were omitted');
  expect(messages.at(-2)?.content).toContain('9 ');
  expect(JSON.stringify(turns)).toBe(before);
});
it('resolves a unique explicit name without requiring the word project', () => {
  expect(planTaskRead('show my assigned tasks in Devflow', workspace)).toMatchObject({
    input: { projectId: 'p', scope: 'mine' },
  });
  expect(planTaskRead('my current tasks for tomorrow', workspace)).toBeNull();
});
