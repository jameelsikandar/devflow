import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  transaction: vi.fn(),
  lock: vi.fn(),
  member: vi.fn(),
  project: vi.fn(),
  revision: vi.fn(),
  audit: vi.fn(),
  create: vi.fn(),
  find: vi.fn(),
  update: vi.fn(),
  connection: vi.fn(),
}));
vi.mock('../src/lib/server/db', () => ({ db: { $transaction: m.transaction } }));
vi.mock('../src/lib/server/project-lock', () => ({ lockActiveProject: m.lock }));
import {
  listGitHubWorkflowRules,
  mutateGitHubWorkflowRule,
  previewGitHubWorkflow,
} from '../src/lib/server/github-workflows';
const actor = { userId: 'owner', workspaceId: 'workspace', name: 'Owner' };
const definition = {
  name: 'Merged',
  connectionId: 'c',
  trigger: 'PR_MERGED',
  targetStatus: 'DONE',
  enabled: false,
  priority: 100,
};
const rule = {
  ...definition,
  id: 'rule',
  version: 1,
  projectId: 'project',
  workspaceId: 'workspace',
};
beforeEach(() => {
  vi.resetAllMocks();
  m.member.mockResolvedValue({ role: 'OWNER' });
  m.project.mockResolvedValue({ id: 'project' });
  m.revision.mockResolvedValue(null);
  m.create.mockResolvedValue(rule);
  m.find.mockResolvedValue(rule);
  m.connection.mockResolvedValue({ id: 'c' });
  m.transaction.mockImplementation((fn) =>
    fn({
      workspaceMember: { findUnique: m.member },
      project: { findFirst: m.project },
      gitHubWorkflowRuleRevision: { findUnique: m.revision, create: m.audit },
      gitHubWorkflowRule: {
        create: m.create,
        count: async () => 0,
        findFirst: m.find,
        update: m.update,
      },
      gitHubRepositoryConnection: { findFirst: m.connection },
      task: new Proxy(
        {},
        {
          get: () => {
            throw new Error('Task mutation/read is forbidden in configuration');
          },
        },
      ),
    }),
  );
});
it('checks membership/admin roles before reading project data, previewing or changing definitions', async () => {
  m.member.mockResolvedValue({ role: 'MEMBER' });
  await expect(listGitHubWorkflowRules(actor, 'project')).rejects.toMatchObject({ status: 403 });
  await expect(
    previewGitHubWorkflow(actor, 'project', { observationId: 'o' }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    mutateGitHubWorkflowRule(actor, 'project', 'CREATE', { requestId: randomUUID(), definition }),
  ).rejects.toMatchObject({ status: 403 });
  expect(m.project).not.toHaveBeenCalled();
  expect(m.create).not.toHaveBeenCalled();
  m.member.mockResolvedValue(null);
  await expect(listGitHubWorkflowRules(actor, 'project')).rejects.toMatchObject({ status: 404 });
  m.member.mockResolvedValue({ role: 'ADMIN' });
  m.project.mockResolvedValue(null);
  await expect(listGitHubWorkflowRules(actor, 'foreign')).rejects.toMatchObject({ status: 404 });
});
it('records one versioned, atomic audit revision and reuses only matching idempotency receipts', async () => {
  const input = { requestId: randomUUID(), definition };
  await mutateGitHubWorkflowRule(actor, 'project', 'CREATE', input);
  expect(m.lock).toHaveBeenCalledWith(expect.anything(), 'owner', 'workspace', 'project');
  expect(m.create).toHaveBeenCalledExactlyOnceWith({
    data: {
      ...definition,
      automationEnabledAt: null,
      automationEnabledVersion: null,
      automationAuthorizedById: null,
      projectId: 'project',
      workspaceId: 'workspace',
    },
  });
  expect(m.audit.mock.calls[0][0].data).toMatchObject({
    actorId: 'owner',
    version: 1,
    operation: 'CREATE',
    requestId: input.requestId,
    snapshot: rule,
  });
  const receipt = m.audit.mock.calls[0][0].data;
  m.revision.mockResolvedValue(receipt);
  expect((await mutateGitHubWorkflowRule(actor, 'project', 'CREATE', input)).replayed).toBe(true);
  expect(m.create).toHaveBeenCalledTimes(1);
  await expect(
    mutateGitHubWorkflowRule(actor, 'project', 'CREATE', {
      ...input,
      automationConfirmed: true,
      definition: { ...definition, enabled: true },
    }),
  ).rejects.toMatchObject({ status: 409 });
});
it('rejects stale versions, foreign or disconnected enabled connections and unsupported payload fields', async () => {
  await expect(
    mutateGitHubWorkflowRule(
      actor,
      'project',
      'UPDATE',
      { requestId: randomUUID(), expectedVersion: 2, definition },
      'rule',
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(m.update).not.toHaveBeenCalled();
  m.connection.mockResolvedValue(null);
  await expect(
    mutateGitHubWorkflowRule(actor, 'project', 'CREATE', {
      requestId: randomUUID(),
      automationConfirmed: true,
      definition: { ...definition, enabled: true },
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(m.connection.mock.calls.at(-1)![0].where).toEqual({
    id: 'c',
    projectId: 'project',
    workspaceId: 'workspace',
    disconnectedAt: null,
  });
  await expect(
    mutateGitHubWorkflowRule(actor, 'project', 'CREATE', {
      requestId: randomUUID(),
      definition,
      execute: true,
    }),
  ).rejects.toThrow();
  expect(m.create).not.toHaveBeenCalled();
});

it('returns a blocked preview for malformed legacy JSON instead of throwing or consulting task mutation services', async () => {
  m.transaction.mockImplementation((fn) =>
    fn({
      workspaceMember: { findUnique: m.member },
      project: { findFirst: m.project },
      gitHubWorkflowRule: { findMany: async () => [] },
      gitHubObservation: {
        findFirst: async ({ where }: { where: { id?: string } }) =>
          where.id
            ? {
                id: 'o',
                objectId: 'object',
                connectionId: 'c',
                repositoryId: '123',
                receivedAt: new Date(),
                data: 'malformed',
                object: {
                  key: '12',
                  kind: 'PULL_REQUEST',
                  currentData: null,
                  sourceUpdatedAt: null,
                },
                connection: { disconnectedAt: null },
                delivery: { event: 'pull_request', state: 'PROCESSED', dataVersion: 1 },
                incomplete: false,
                unresolvedRefs: [],
                evidence: [],
              }
            : null,
      },
    }),
  );
  const result = await previewGitHubWorkflow(actor, 'project', { observationId: 'o' });
  expect(result.blockers).toContain('MISSING_DATA');
  expect(result.transition).toBeNull();
});

it('never enables an automation rule without explicit server-validated consent', async () => {
  await expect(
    mutateGitHubWorkflowRule(actor, 'project', 'CREATE', {
      requestId: randomUUID(),
      definition: { ...definition, enabled: true },
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(m.create).not.toHaveBeenCalled();
});
