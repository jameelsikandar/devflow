import type { Prisma } from '@prisma/client';
import { db } from './db';
import { HttpError } from './errors';
import {
  conversationSchema,
  decisionSchema,
  PROPOSAL_TTL_MS,
  RUN_TTL_MS,
  turnSchema,
  type AgentMessage,
  type AgentProvider,
  type WriteTool,
} from '../agent';
import { OpenAICompatibleAgentProvider, agentConfiguration } from './agent-provider';
import { runAgentLoop, type AgentGateway } from './agent-loop';
import { agentCatalog, canReuseAgentRead } from './agent-context';
import { agentDiagnostic } from './agent-diagnostics';
import { agentInstructions, historyContext } from './agent-instructions';
import {
  establishedProject,
  resolveProject,
  namedProject,
  taskIntent,
  planTaskRead,
  verifiedTaskAnswer,
} from '../task-read-plan';
import {
  asJson,
  assertAgentActor,
  executeAgentAction,
  prepareAgentAction,
  preparedSchema,
  readAgentTool,
  type AgentActor,
} from './agent-tools';
import { previewDigest, proposalDecision } from './agent-approval';
import type { WorkspaceActor } from './tasks';

const publicProposal = {
  id: true,
  tool: true,
  preview: true,
  previewHash: true,
  status: true,
  expiresAt: true,
  createdAt: true,
  decidedAt: true,
  result: true,
} as const;
const publicRun = {
  id: true,
  requestId: true,
  prompt: true,
  answer: true,
  status: true,
  error: true,
  createdAt: true,
  completedAt: true,
  proposals: { select: publicProposal, orderBy: { createdAt: 'asc' as const } },
  events: {
    select: { id: true, name: true, input: true, output: true },
    orderBy: { createdAt: 'asc' as const },
  },
} as const;
async function conversation(
  tx: Prisma.TransactionClient,
  actor: WorkspaceActor,
  id: string,
  lock = false,
) {
  if (lock)
    await tx.$queryRaw`SELECT c."id" FROM "AIConversation" c WHERE c."id"=${id} AND c."userId"=${actor.userId} AND c."workspaceId"=${actor.workspaceId} FOR UPDATE`;
  const record = await tx.aIConversation.findFirst({
    where: { id, userId: actor.userId, workspaceId: actor.workspaceId },
    include: {
      workspace: { select: { id: true, name: true } },
      project: { select: { id: true, name: true, archivedAt: true } },
    },
  });
  if (!record) throw new HttpError(404, 'Conversation not found');
  await assertAgentActor(tx, { ...actor, projectId: record.projectId });
  return record;
}
export async function createConversation(actor: WorkspaceActor, value: unknown) {
  const input = conversationSchema.parse(value);
  return db.$transaction(async (tx) => {
    await assertAgentActor(tx, { ...actor, projectId: input.projectId ?? null });
    if (
      input.projectId &&
      !(await tx.project.findFirst({
        where: { id: input.projectId, workspaceId: actor.workspaceId, archivedAt: null },
      }))
    )
      throw new HttpError(404, 'Active project not found');
    return tx.aIConversation.create({
      data: { ...input, workspaceId: actor.workspaceId, userId: actor.userId },
    });
  });
}
export async function listConversations(actor: WorkspaceActor) {
  return db.$transaction(async (tx) => {
    await assertAgentActor(tx, { ...actor, projectId: null });
    return tx.aIConversation.findMany({
      where: { workspaceId: actor.workspaceId, userId: actor.userId },
      select: { id: true, title: true, projectId: true, updatedAt: true },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });
  });
}
export async function getConversation(actor: WorkspaceActor, id: string) {
  return db.$transaction(async (tx) => {
    const record = await conversation(tx, actor, id);
    const runs = await tx.aIRun.findMany({
      where: { conversationId: record.id },
      select: publicRun,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 30,
    });
    return { ...record, runs: runs.reverse(), historyLimit: 30 };
  });
}
export async function listAgentArtifacts(actor: WorkspaceActor, projectId?: string) {
  return db.$transaction(async (tx) => {
    await assertAgentActor(tx, { ...actor, projectId: null });
    if (
      projectId &&
      !(await tx.project.findFirst({ where: { id: projectId, workspaceId: actor.workspaceId } }))
    )
      throw new HttpError(404, 'Project not found');
    const project = {
      workspaceId: actor.workspaceId,
      ...(projectId ? { id: projectId } : { archivedAt: null }),
    };
    const [sprints, reports] = await Promise.all([
      tx.sprint.findMany({
        where: { project },
        include: { tasks: true, project: { select: { id: true, name: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 20,
      }),
      tx.projectReport.findMany({
        where: { project },
        include: { project: { select: { id: true, name: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 20,
      }),
    ]);
    return { sprints, reports, limit: 20 };
  });
}
export async function sendAgentTurn(
  actor: WorkspaceActor,
  id: string,
  value: unknown,
  injectedProvider?: AgentProvider,
) {
  const input = turnSchema.parse(value);
  if (!injectedProvider) {
    const state = agentConfiguration();
    if (!state.configured) throw new HttpError(503, state.reason!);
  }
  const claim = await db.$transaction(
    async (tx) => {
      const record = await conversation(tx, actor, id, true);
      const previous = await tx.aIRun.findUnique({
        where: { conversationId_requestId: { conversationId: id, requestId: input.requestId } },
        select: { ...publicRun, prompt: true },
      });
      if (previous) {
        if (previous.prompt !== input.prompt)
          throw new HttpError(409, 'This request ID belongs to a different prompt');
        if (previous.status === 'RUNNING')
          throw new HttpError(
            409,
            'This request is still running. Reload its history before retrying.',
          );
        return { replay: previous, record, run: null, history: [] };
      }
      const now = new Date();
      if (
        await tx.aIRun.count({
          where: { conversationId: id, status: 'RUNNING', expiresAt: { gt: now } },
        })
      )
        throw new HttpError(409, 'A request is already running in this conversation');
      await tx.aIRun.updateMany({
        where: { conversationId: id, status: 'RUNNING' },
        data: {
          status: 'FAILED',
          error: 'Request interrupted or expired; no actions were applied.',
          completedAt: now,
        },
      });
      const history = await tx.aIRun.findMany({
        where: { conversationId: id },
        select: {
          prompt: true,
          answer: true,
          status: true,
          proposals: { select: { tool: true, status: true, result: true } },
          events: {
            where: { name: { in: ['listTasks', 'getProject'] } },
            select: { input: true, output: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 10,
      });
      const run = await tx.aIRun.create({
        data: {
          conversationId: id,
          requestId: input.requestId,
          prompt: input.prompt,
          expiresAt: new Date(+now + RUN_TTL_MS),
        },
      });
      await tx.aIConversation.update({ where: { id }, data: { updatedAt: now } });
      return { replay: null, record, run, history: history.reverse() };
    },
    { isolationLevel: 'ReadCommitted' },
  );
  if (claim.replay) return claim.replay;
  const run = claim.run!;
  const context: AgentActor = { ...actor, projectId: claim.record.projectId };
  try {
    const onEvent: NonNullable<Parameters<typeof runAgentLoop>[4]> = async (event) => {
      await db.$transaction(async (tx) => {
        await assertAgentActor(tx, context);
        const active = await tx.aIRun.findFirst({
          where: { id: run.id, status: 'RUNNING', expiresAt: { gt: new Date() } },
        });
        if (!active) throw new HttpError(409, 'This AI run expired.');
        await tx.aIToolEvent.create({
          data: {
            runId: run.id,
            callId: event.callId,
            name: event.name,
            input: asJson(event.input),
            output: asJson(event.output),
          },
        });
      });
    };
    const prompts = claim.history.map((p) => p.prompt);
    const hintName =
      taskIntent(input.prompt)?.projectName ??
      namedProject(input.prompt) ??
      [...prompts]
        .reverse()
        .map((p) => taskIntent(p)?.projectName ?? namedProject(p))
        .find(Boolean);
    const lastRead = claim.history.at(-1)?.events?.[0];
    const lastPage =
      lastRead?.output && typeof lastRead.output === 'object'
        ? (lastRead.output as Record<string, unknown>)
        : {};
    const lastInput =
      lastRead?.input && typeof lastRead.input === 'object'
        ? (lastRead.input as Record<string, unknown>)
        : {};
    const catalog = await db.$transaction(
      (tx) =>
        agentCatalog(
          tx,
          context,
          hintName,
          typeof lastInput.projectId === 'string' && !lastPage.error
            ? lastInput.projectId
            : undefined,
        ),
      {
        isolationLevel: 'RepeatableRead',
      },
    );
    const toolProject =
      !lastPage.error &&
      typeof lastInput.projectId === 'string' &&
      catalog.projects.some((p) => p.id === lastInput.projectId)
        ? lastInput.projectId
        : null;
    const explicitSelection = namedProject(input.prompt) ?? taskIntent(input.prompt)?.projectName;
    const explicitProject = explicitSelection
      ? resolveProject(explicitSelection, catalog.projects)?.id
      : null;
    const readContext = {
      ...catalog,
      projectId: context.projectId,
      establishedProjectId:
        taskIntent(prompts.at(-1) ?? '')?.kind === 'workspace'
          ? null
          : (explicitProject ??
            toolProject ??
            establishedProject(prompts, {
              ...catalog,
              projectId: context.projectId,
            })),
    };
    const plan = planTaskRead(input.prompt, readContext, prompts.at(-1));
    const gateway: AgentGateway = {
      read: (name, args) =>
        db.$transaction((tx) => readAgentTool(tx, context, name, args), {
          isolationLevel: 'RepeatableRead',
        }),
      preview: (name, args) =>
        db.$transaction((tx) => prepareAgentAction(tx, context, name as WriteTool, args), {
          isolationLevel: 'RepeatableRead',
        }),
      canReuseRead: (name, _args, result) =>
        db.$transaction((tx) => canReuseAgentRead(tx, context, name, result), {
          isolationLevel: 'RepeatableRead',
        }),
    };
    const messages: AgentMessage[] = [
      {
        role: 'system',
        content: agentInstructions({
          workspace: claim.record.workspace,
          user: { id: actor.userId, name: actor.name },
          pinnedProject: claim.record.project,
          conversationScope: context.projectId ? 'project' : 'workspace',
          ...readContext,
          createdBySupported: false,
          lastTaskQuery: lastRead
            ? {
                input: lastRead.input,
                total: lastPage.total,
                offset: lastPage.offset,
                nextOffset: lastPage.nextOffset,
                hasMore: lastPage.hasMore,
              }
            : undefined,
        }),
      },
    ];
    messages.push(...historyContext(claim.history));
    messages.push({ role: 'user', content: input.prompt });
    let output: { answer: string; events: unknown[]; previews: unknown[] };
    if (plan?.kind === 'read') {
      const result = await gateway.read('listTasks', plan.input);
      const event = {
        callId: 'verified-task-read',
        name: 'listTasks',
        input: plan.input,
        output: result,
      };
      await onEvent(event);
      agentDiagnostic('verified_task_read', { providerRounds: 0, toolCalls: 1 });
      output = {
        answer: verifiedTaskAnswer(result, plan.interpretation),
        events: [event],
        previews: [],
      };
    } else if (plan?.kind === 'explain') output = { answer: plan.answer, events: [], previews: [] };
    else
      output = await runAgentLoop(
        injectedProvider ?? new OpenAICompatibleAgentProvider(),
        messages,
        gateway,
        AbortSignal.timeout(80000),
        onEvent,
      );
    return await db.$transaction(async (tx) => {
      await conversation(tx, actor, id, true);
      const active = await tx.aIRun.findFirst({
        where: { id: run.id, status: 'RUNNING', expiresAt: { gt: new Date() } },
      });
      if (!active) throw new HttpError(409, 'This AI request expired. No proposals were saved.');
      for (const action of output.previews) {
        const payload = asJson(preparedSchema.parse(action));
        const prepared = preparedSchema.parse(payload);
        await tx.aIProposal.create({
          data: {
            runId: run.id,
            tool: prepared.tool,
            payload,
            preview: asJson(prepared.preview),
            previewHash: previewDigest(payload),
            expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
          },
        });
      }
      await tx.aIRun.update({
        where: { id: run.id },
        data: { answer: output.answer, status: 'COMPLETED', completedAt: new Date() },
      });
      return tx.aIRun.findUniqueOrThrow({ where: { id: run.id }, select: publicRun });
    });
  } catch (error) {
    const message =
      error instanceof HttpError
        ? error.message
        : 'The AI request failed. No proposed changes were applied.';
    await db.aIRun.updateMany({
      where: { id: run.id, status: 'RUNNING' },
      data: { status: 'FAILED', error: message, completedAt: new Date() },
    });
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, message);
  }
}
export async function decideAgentProposal(actor: WorkspaceActor, id: string, value: unknown) {
  const input = decisionSchema.parse(value);
  const result = await db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT p."id" FROM "AIProposal" p JOIN "AIRun" r ON r."id"=p."runId" JOIN "AIConversation" c ON c."id"=r."conversationId" WHERE p."id"=${id} AND c."userId"=${actor.userId} AND c."workspaceId"=${actor.workspaceId} FOR UPDATE OF p`;
      const proposal = await tx.aIProposal.findFirst({
        where: {
          id,
          run: { conversation: { userId: actor.userId, workspaceId: actor.workspaceId } },
        },
        include: { run: { include: { conversation: true } } },
      });
      if (!proposal) throw new HttpError(404, 'Proposal not found');
      const context: AgentActor = { ...actor, projectId: proposal.run.conversation.projectId };
      await assertAgentActor(tx, context);
      if (previewDigest(proposal.payload) !== proposal.previewHash)
        throw new HttpError(409, 'Stored preview integrity check failed');
      const action = preparedSchema.parse(proposal.payload);
      if (
        action.tool !== proposal.tool ||
        previewDigest(action.preview) !== previewDigest(proposal.preview)
      )
        throw new HttpError(409, 'Stored preview mismatch');
      const decision = proposalDecision(proposal, input.decision, input.previewHash);
      if (decision === 'replay')
        return { id, status: proposal.status, result: proposal.result, replayed: true };
      if (decision === 'expire' || decision === 'reject') {
        await tx.aIProposal.update({
          where: { id },
          data: { status: decision === 'expire' ? 'EXPIRED' : 'REJECTED', decidedAt: new Date() },
        });
        return {
          id,
          status: decision === 'expire' ? 'EXPIRED' : 'REJECTED',
          result: null,
          replayed: false,
        };
      }
      const receipt = await executeAgentAction(tx, context, action);
      await tx.aIProposal.update({
        where: { id },
        data: { status: 'APPLIED', result: asJson(receipt), decidedAt: new Date() },
      });
      return { id, status: 'APPLIED', result: receipt, replayed: false };
    },
    { isolationLevel: 'ReadCommitted', timeout: 10000 },
  );
  if (result.status === 'EXPIRED')
    throw new HttpError(410, 'This proposal expired. Request a fresh preview.');
  return result;
}
