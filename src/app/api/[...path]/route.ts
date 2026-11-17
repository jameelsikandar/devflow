import { githubRetentionImpact } from '@/lib/server/github-retention';
import { revalidateGitHubConnection } from '@/lib/server/github-revalidation';
import { githubOperationalHealth } from '@/lib/server/github-operational-health';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { db } from '@/lib/server/db';
import {
  createSession,
  currentUser,
  membership,
  rateLimit,
  requireUser,
  sessionCookie,
} from '@/lib/server/auth';
import { digest, hashPassword, token, verifyPassword } from '@/lib/server/crypto';
import {
  errorResponse,
  guardOrigin,
  HttpError,
  jsonBody,
  personSelect,
  readLimited,
} from '@/lib/server/http';
import {
  aiSchema,
  commentSchema,
  inviteSchema,
  loginSchema,
  projectSchema,
  registerSchema,
  taskSchema,
  taskUpdateSchema,
  workspaceSchema,
} from '@/lib/validation';
import { generateAssistant } from '@/lib/server/ai';
import { githubData } from '@/lib/server/github';
import {
  listGitHubWorkflowRules,
  mutateGitHubWorkflowRule,
  gitHubWorkflowHistory,
  previewGitHubWorkflow,
} from '@/lib/server/github-workflows';
import {
  listGitHubWorkflowExecutions,
  executionStateFilter,
} from '@/lib/server/github-automation-monitoring';
import { taskGitHubActivity } from '@/lib/server/task-github';
import { reconcileGitHubCommit } from '@/lib/server/github-reconciliation';
import {
  githubProcessingStatus,
  githubProjectActivity,
  retryGitHubDelivery,
  setGitHubEnrichment,
  processingFilter,
  pageOffset,
} from '@/lib/server/github-monitoring';
import {
  connectRepository,
  disconnectRepository,
  listRepositoryConnections,
  listGitHubDeliveries,
} from '@/lib/server/github-repositories';
import { env } from '@/lib/server/env';
import { changeDependency, getRoadmap } from '@/lib/server/roadmap';
import { dependencySchema } from '@/lib/roadmap';
import { createWorkspaceTask, updateWorkspaceTask } from '@/lib/server/tasks';
import { lockActiveProject } from '@/lib/server/project-lock';
import {
  createConversation,
  decideAgentProposal,
  getConversation,
  listAgentArtifacts,
  listConversations,
  sendAgentTurn,
} from '@/lib/server/agent-manager';
import { agentConfiguration } from '@/lib/server/agent-provider';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const taskInclude = {
  assignee: { select: personSelect },
  labels: { include: { label: true } },
  _count: { select: { comments: true, githubLinks: true } },
} as const;
const activityInclude = { actor: { select: personSelect } };
async function handler(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  let operationalHealthRead = false;
  let connectionRevalidation = false;
  let retentionRead = false;
  try {
    const { path } = await params;
    operationalHealthRead =
      path.length === 4 &&
      path[0] === 'github' &&
      path[1] === 'repositories' &&
      path[3] === 'health' &&
      request.method === 'GET';
    connectionRevalidation =
      path.length === 4 &&
      path[0] === 'github' &&
      path[1] === 'repositories' &&
      path[3] === 'revalidate' &&
      request.method === 'POST';
    retentionRead =
      path.length === 4 &&
      path[0] === 'github' &&
      path[1] === 'projects' &&
      path[3] === 'retention' &&
      request.method === 'GET';
    // Recognize diagnostic responses for no-store, then enforce origin before auth/body/DB work.
    guardOrigin(request);
    const route = path.join('/');
    const method = request.method;
    const url = new URL(request.url);
    if (route === 'auth/login' || route === 'auth/register') {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const input = await jsonBody(request);
      const login = loginSchema.parse(input);
      // A global cap bounds password-hashing load; account cap works without trusting proxy headers.
      await rateLimit('auth:global', 100, 60000);
      await rateLimit(`auth:${digest(login.email)}`, 10, 15 * 60000);
      if (route === 'auth/register') {
        const data = registerSchema.parse(input);
        const passwordHash = await hashPassword(data.password);
        const user = await db.user.create({
          data: {
            name: data.name,
            email: data.email,
            passwordHash,
            memberships: {
              create: {
                role: 'OWNER',
                workspace: {
                  create: {
                    name: `${data.name.split(' ')[0]}'s workspace`,
                    labels: {
                      create: [
                        { name: 'Feature', color: '#a78bfa' },
                        { name: 'Bug', color: '#f87171' },
                        { name: 'Design', color: '#60a5fa' },
                      ],
                    },
                  },
                },
              },
            },
          },
        });
        await createSession(user.id);
        return NextResponse.json({ ok: true }, { status: 201 });
      }
      const user = await db.user.findUnique({ where: { email: login.email } });
      const fallback = 'scrypt:00000000000000000000000000000000:' + '0'.repeat(128);
      const valid = await verifyPassword(login.password, user?.passwordHash ?? fallback);
      if (!user || !valid) throw new HttpError(401, 'Email or password is incorrect');
      await createSession(user.id);
      return NextResponse.json({ ok: true });
    }
    if (route === 'me' && method === 'GET') {
      const user = await currentUser();
      if (!user) throw new HttpError(401, 'Please sign in to continue');
      const members = await db.workspaceMember.findMany({
        where: { userId: user.id },
        include: { workspace: true },
        orderBy: { createdAt: 'asc' },
      });
      return NextResponse.json({
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          hasAvatar: !!user.avatarType,
          updatedAt: user.updatedAt,
        },
        workspaces: members.map((m) => ({ ...m.workspace, role: m.role })),
      });
    }
    const user = await requireUser();
    if (method !== 'GET') await rateLimit(`write:${user.id}`, 120);
    if (route === 'auth/logout' && method === 'POST') {
      const jar = await cookies();
      const raw = jar.get(sessionCookie)?.value;
      if (raw) await db.session.deleteMany({ where: { tokenHash: digest(raw) } });
      jar.delete(sessionCookie);
      return NextResponse.json({ ok: true });
    }
    if (route === 'profile' && method === 'PATCH') {
      const input = z
        .object({
          name: z.string().trim().min(2).max(80),
          password: z.string().min(12).max(128).optional(),
          currentPassword: z.string().max(128).optional(),
        })
        .parse(await jsonBody(request));
      if (input.password && !(await verifyPassword(input.currentPassword ?? '', user.passwordHash)))
        throw new HttpError(400, 'Current password is incorrect');
      await db.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: {
            name: input.name,
            ...(input.password ? { passwordHash: await hashPassword(input.password) } : {}),
          },
        });
        if (input.password) await tx.session.deleteMany({ where: { userId: user.id } });
      });
      if (input.password) await createSession(user.id);
      return NextResponse.json({ ok: true });
    }
    if (route === 'avatar' && method === 'POST') {
      if (Number(request.headers.get('content-length') ?? 0) > 600000)
        throw new HttpError(413, 'Avatar must be under 512 KB');
      const bytes = await readLimited(request, 524288);
      if (bytes.length > 524288) throw new HttpError(413, 'Avatar must be under 512 KB');
      const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (!png && !jpeg) throw new HttpError(400, 'Choose a PNG or JPEG image');
      await db.user.update({
        where: { id: user.id },
        data: { avatar: new Uint8Array(bytes), avatarType: png ? 'image/png' : 'image/jpeg' },
      });
      return NextResponse.json({ ok: true });
    }
    if (route === 'workspaces' && method === 'POST') {
      const input = workspaceSchema.parse(await jsonBody(request));
      const workspace = await db.workspace.create({
        data: {
          ...input,
          members: { create: { userId: user.id, role: 'OWNER' } },
          labels: {
            create: [
              { name: 'Feature', color: '#a78bfa' },
              { name: 'Bug', color: '#f87171' },
              { name: 'Design', color: '#60a5fa' },
            ],
          },
        },
      });
      return NextResponse.json(workspace, { status: 201 });
    }
    if (route === 'invites/accept' && method === 'POST') {
      const input = z.object({ token: z.string().length(64) }).parse(await jsonBody(request));
      const result = await db.$transaction(async (tx) => {
        const invite = await tx.workspaceInvite.findUnique({
          where: { tokenHash: digest(input.token) },
        });
        if (!invite || invite.expiresAt < new Date() || invite.email !== user.email)
          throw new HttpError(
            400,
            'Invitation is invalid, expired, or belongs to a different email',
          );
        await tx.workspaceMember.upsert({
          where: { workspaceId_userId: { workspaceId: invite.workspaceId, userId: user.id } },
          update: {},
          create: { workspaceId: invite.workspaceId, userId: user.id },
        });
        await tx.workspaceInvite.delete({ where: { id: invite.id } });
        await tx.taskActivity.create({
          data: {
            workspaceId: invite.workspaceId,
            actorId: user.id,
            message: 'joined the workspace',
          },
        });
        return { workspaceId: invite.workspaceId };
      });
      return NextResponse.json(result);
    }
    const workspaceId = url.searchParams.get('workspaceId');
    if (!workspaceId) throw new HttpError(400, 'Select a workspace');
    const member = await membership(user.id, workspaceId);
    const actor = { userId: user.id, workspaceId, name: user.name };
    if (route === 'ai/config' && method === 'GET') return NextResponse.json(agentConfiguration());
    if (route === 'ai/conversations' && method === 'GET')
      return NextResponse.json(await listConversations(actor));
    if (route === 'ai/conversations' && method === 'POST')
      return NextResponse.json(await createConversation(actor, await jsonBody(request)), {
        status: 201,
      });
    if (path[0] === 'ai' && path[1] === 'conversations' && path[2]) {
      if (path.length === 3 && method === 'GET')
        return NextResponse.json(await getConversation(actor, path[2]));
      if (path.length === 4 && path[3] === 'messages' && method === 'POST') {
        await rateLimit(`agent:${user.id}`, 10);
        return NextResponse.json(await sendAgentTurn(actor, path[2], await jsonBody(request)));
      }
    }
    if (
      path[0] === 'ai' &&
      path[1] === 'proposals' &&
      path[2] &&
      path[3] === 'decision' &&
      path.length === 4 &&
      method === 'POST'
    )
      return NextResponse.json(await decideAgentProposal(actor, path[2], await jsonBody(request)));
    if (route === 'ai/artifacts' && method === 'GET')
      return NextResponse.json(
        await listAgentArtifacts(actor, url.searchParams.get('projectId') ?? undefined),
      );
    const activity = (message: string, taskId?: string) => ({
      workspaceId,
      actorId: user.id,
      message,
      taskId,
    });
    if (route === 'roadmap' && method === 'GET') {
      const projectId = z.string().min(1).parse(url.searchParams.get('projectId'));
      return NextResponse.json(await getRoadmap(user.id, workspaceId, projectId));
    }
    if (route === 'roadmap/dependencies' && (method === 'POST' || method === 'DELETE')) {
      const input = dependencySchema.parse(await jsonBody(request));
      return NextResponse.json(
        await changeDependency(user.id, workspaceId, input, method === 'DELETE'),
      );
    }
    if (route === 'snapshot' && method === 'GET') {
      const [workspace, workspaces, projects, tasks, members, labels, feed, notifications] =
        await Promise.all([
          db.workspace.findUniqueOrThrow({ where: { id: workspaceId } }),
          db.workspaceMember.findMany({
            where: { userId: user.id },
            include: { workspace: true },
            orderBy: { createdAt: 'asc' },
          }),
          db.project.findMany({
            where: { workspaceId },
            include: { _count: { select: { tasks: true } } },
            orderBy: { createdAt: 'asc' },
          }),
          db.task.findMany({
            where: { project: { workspaceId } },
            include: taskInclude,
            orderBy: [{ position: 'asc' }, { id: 'asc' }],
          }),
          db.workspaceMember.findMany({
            where: { workspaceId },
            include: { user: { select: personSelect } },
            orderBy: { createdAt: 'asc' },
          }),
          db.label.findMany({ where: { workspaceId }, orderBy: { name: 'asc' } }),
          db.taskActivity.findMany({
            where: { workspaceId },
            include: activityInclude,
            orderBy: { createdAt: 'desc' },
            take: 40,
          }),
          db.notification.findMany({
            where: { userId: user.id },
            orderBy: { createdAt: 'desc' },
            take: 30,
          }),
        ]);
      return NextResponse.json({
        workspace: { ...workspace, role: member.role },
        workspaces: workspaces.map((m) => ({ ...m.workspace, role: m.role })),
        projects,
        tasks,
        members,
        labels,
        activity: feed,
        notifications,
      });
    }
    if (route === 'heartbeat' && method === 'POST') {
      await db.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId: user.id } },
        data: { lastSeenAt: new Date() },
      });
      return NextResponse.json({ ok: true });
    }
    if (route === 'notifications/read' && method === 'POST') {
      await db.notification.updateMany({
        where: { userId: user.id, readAt: null },
        data: { readAt: new Date() },
      });
      return NextResponse.json({ ok: true });
    }
    if (route === 'invites' && method === 'POST') {
      await membership(user.id, workspaceId, true);
      const { email } = inviteSchema.parse(await jsonBody(request));
      const raw = token();
      const invite = await db.workspaceInvite.upsert({
        where: { workspaceId_email: { workspaceId, email } },
        update: { tokenHash: digest(raw), expiresAt: new Date(Date.now() + 7 * 86400000) },
        create: {
          workspaceId,
          email,
          tokenHash: digest(raw),
          expiresAt: new Date(Date.now() + 7 * 86400000),
        },
      });
      return NextResponse.json(
        { url: `${env().APP_URL}/?invite=${raw}`, expiresAt: invite.expiresAt },
        { status: 201 },
      );
    }
    if (route === 'projects' && method === 'POST') {
      const input = projectSchema.parse(await jsonBody(request));
      const project = await db.$transaction(async (tx) => {
        const p = await tx.project.create({ data: { workspaceId, ...input } });
        await tx.taskActivity.create({ data: activity(`created project ${p.name}`) });
        return p;
      });
      return NextResponse.json(project, { status: 201 });
    }
    if (path[0] === 'projects' && path.length === 2 && method === 'PATCH') {
      const project = await db.project.findFirst({ where: { id: path[1], workspaceId } });
      if (!project) throw new HttpError(404, 'Project not found');
      const input = projectSchema
        .partial()
        .extend({
          archived: z.boolean().optional(),
          repository: z
            .string()
            .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/)
            .nullable()
            .optional(),
        })
        .parse(await jsonBody(request));
      const { archived, ...data } = input;
      const result = await db.$transaction(async (tx) => {
        if (input.repository !== undefined) {
          await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${project.id} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
          const active = await tx.gitHubRepositoryConnection.findFirst({
            where: { projectId: project.id, disconnectedAt: null },
          });
          if (active && input.repository !== active.repositoryFullName)
            throw new HttpError(
              409,
              'Disconnect the repository webhook before changing its activity link',
            );
        }
        const p = await tx.project.update({
          where: { id: project.id },
          data: {
            ...data,
            ...(archived !== undefined ? { archivedAt: archived ? new Date() : null } : {}),
          },
        });
        await tx.taskActivity.create({
          data: activity(
            `${
              archived === true ? 'archived' : archived === false ? 'restored' : 'updated'
            } project ${p.name}`,
          ),
        });
        return p;
      });
      return NextResponse.json(result);
    }
    if (route === 'labels' && method === 'POST') {
      const input = z
        .object({
          name: z.string().trim().min(1).max(30),
          color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        })
        .parse(await jsonBody(request));
      return NextResponse.json(await db.label.create({ data: { workspaceId, ...input } }), {
        status: 201,
      });
    }
    if (route === 'tasks' && method === 'POST') {
      const input = taskSchema.parse(await jsonBody(request));
      const task = await db.$transaction((tx) =>
        createWorkspaceTask(tx, { userId: user.id, workspaceId, name: user.name }, input),
      );
      return NextResponse.json(task, { status: 201 });
    }
    if (path[0] === 'tasks' && path[1]) {
      const task = await db.task.findFirst({
        where: { id: path[1], project: { workspaceId } },
        include: { project: true },
      });
      if (!task) throw new HttpError(404, 'Task not found');
      if (path.length === 3 && path[2] === 'github' && method === 'GET')
        return NextResponse.json(
          await taskGitHubActivity(
            actor,
            task.id,
            pageOffset.parse(url.searchParams.get('offset') ?? undefined),
          ),
          { headers: { 'Cache-Control': 'no-store' } },
        );
      if (path.length === 2 && method === 'GET')
        return NextResponse.json(
          await db.task.findUnique({
            where: { id: task.id },
            include: {
              ...taskInclude,
              parentTask: { select: { id: true, number: true, title: true } },
              subtasks: {
                select: { id: true, number: true, title: true, status: true },
                orderBy: { number: 'asc' },
                take: 100,
              },
              comments: {
                include: { author: { select: personSelect } },
                orderBy: { createdAt: 'asc' },
              },
              activities: { include: activityInclude, orderBy: { createdAt: 'desc' }, take: 50 },
            },
          }),
        );
      if (task.project.archivedAt)
        throw new HttpError(409, 'Restore this project before editing its tasks');
      if (path.length === 2 && method === 'PATCH') {
        const input = taskUpdateSchema.parse(await jsonBody(request));
        const result = await db.$transaction((tx) =>
          updateWorkspaceTask(
            tx,
            { userId: user.id, workspaceId, name: user.name },
            task.id,
            input,
          ),
        );
        return NextResponse.json(result);
      }
      if (path.length === 2 && method === 'DELETE') {
        await db.$transaction(async (tx) => {
          await lockActiveProject(tx, user.id, workspaceId, task.projectId);
          await tx.taskActivity.create({ data: activity(`deleted ${task.title}`) });
          await tx.task.delete({ where: { id: task.id } });
        });
        return NextResponse.json({ ok: true });
      }
      if (path.length === 3 && path[2] === 'comments' && method === 'POST') {
        const input = commentSchema.parse(await jsonBody(request));
        const result = await db.$transaction(async (tx) => {
          await lockActiveProject(tx, user.id, workspaceId, task.projectId);
          const c = await tx.taskComment.create({
            data: { taskId: task.id, authorId: user.id, ...input },
            include: { author: { select: personSelect } },
          });
          await tx.taskActivity.create({ data: activity(`commented on ${task.title}`, task.id) });
          return c;
        });
        return NextResponse.json(result, { status: 201 });
      }
    }
    if (route === 'ai' && method === 'POST') {
      await rateLimit(`ai:${user.id}`, 10);
      const input = aiSchema.parse(await jsonBody(request));
      const projects = await db.project.findMany({
        where: {
          workspaceId,
          archivedAt: null,
          ...(input.projectId ? { id: input.projectId } : {}),
        },
        select: {
          name: true,
          tasks: {
            select: { title: true, description: true, status: true, priority: true, dueDate: true },
            take: 100,
            orderBy: { updatedAt: 'desc' },
          },
        },
      });
      if (input.projectId && !projects.length) throw new HttpError(404, 'Project not found');
      return NextResponse.json({
        text: await generateAssistant(input.action, input.prompt, projects),
      });
    }
    if (connectionRevalidation) {
      z.object({})
        .strict()
        .parse(await jsonBody(request));
      return NextResponse.json(await revalidateGitHubConnection(actor, path[2]), {
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    if (retentionRead)
      return NextResponse.json(
        await githubRetentionImpact(actor, path[2], url.searchParams.get('days') ?? undefined),
        { headers: { 'Cache-Control': 'no-store' } },
      );
    if (operationalHealthRead)
      return NextResponse.json(await githubOperationalHealth(actor, path[2]), {
        headers: { 'Cache-Control': 'no-store' },
      });
    if (
      path[0] === 'github' &&
      path[1] === 'repositories' &&
      path.length === 4 &&
      path[3] === 'processing' &&
      method === 'GET'
    )
      return NextResponse.json(
        await githubProcessingStatus(
          actor,
          path[2],
          processingFilter.parse(url.searchParams.get('state') ?? undefined),
          pageOffset.parse(url.searchParams.get('offset') ?? undefined),
        ),
        { headers: { 'Cache-Control': 'no-store' } },
      );
    if (
      path[0] === 'github' &&
      path[1] === 'repositories' &&
      path.length === 4 &&
      path[3] === 'enrichment' &&
      method === 'POST'
    )
      return NextResponse.json(await setGitHubEnrichment(actor, path[2], await jsonBody(request)));
    if (
      path[0] === 'github' &&
      path[1] === 'repositories' &&
      path.length === 6 &&
      path[3] === 'deliveries' &&
      path[5] === 'retry' &&
      method === 'POST'
    ) {
      z.object({})
        .strict()
        .parse(await jsonBody(request));
      return NextResponse.json(await retryGitHubDelivery(actor, path[2], path[4]));
    }
    if (
      path[0] === 'github' &&
      path[1] === 'projects' &&
      path.length === 4 &&
      path[3] === 'activity' &&
      method === 'GET'
    )
      return NextResponse.json(
        await githubProjectActivity(
          actor,
          path[2],
          pageOffset.parse(url.searchParams.get('offset') ?? undefined),
        ),
        { headers: { 'Cache-Control': 'no-store' } },
      );
    if (
      path[0] === 'github' &&
      path[1] === 'repositories' &&
      path.length === 6 &&
      path[3] === 'commits' &&
      path[5] === 'reconcile' &&
      method === 'POST'
    ) {
      z.object({})
        .strict()
        .parse(await jsonBody(request));
      return NextResponse.json(await reconcileGitHubCommit(actor, path[2], path[4]), {
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    if (
      path[0] === 'projects' &&
      path[2] === 'github-workflows' &&
      path.length >= 3 &&
      path.length <= 4
    ) {
      const projectId = z.string().min(1).max(128).parse(path[1]);
      let result: unknown;
      if (path.length === 3 && method === 'GET')
        result = await listGitHubWorkflowRules(
          actor,
          projectId,
          pageOffset.parse(url.searchParams.get('offset') ?? undefined),
        );
      else if (path.length === 3 && method === 'POST')
        result = await mutateGitHubWorkflowRule(
          actor,
          projectId,
          'CREATE',
          await jsonBody(request),
        );
      else if (path[3] === 'preview' && method === 'POST')
        result = await previewGitHubWorkflow(actor, projectId, await jsonBody(request));
      else if (path[3] === 'executions' && method === 'GET')
        result = await listGitHubWorkflowExecutions(
          actor,
          projectId,
          pageOffset.parse(url.searchParams.get('offset') ?? undefined),
          executionStateFilter.parse(url.searchParams.get('state') ?? undefined),
        );
      else if (path[3] === 'history' && method === 'GET')
        result = await gitHubWorkflowHistory(
          actor,
          projectId,
          pageOffset.parse(url.searchParams.get('offset') ?? undefined),
        );
      else if (path.length === 4 && ['PATCH', 'DELETE'].includes(method))
        result = await mutateGitHubWorkflowRule(
          actor,
          projectId,
          method === 'PATCH' ? 'UPDATE' : 'DELETE',
          await jsonBody(request),
          path[3],
        );
      else throw new HttpError(404, 'Endpoint not found');
      return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (route === 'github/repositories' && method === 'GET') {
      const projectId = z.string().min(1).max(128).parse(url.searchParams.get('projectId'));
      return NextResponse.json(await listRepositoryConnections(actor, projectId), {
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    if (route === 'github/repositories' && method === 'POST') {
      return NextResponse.json(await connectRepository(actor, await jsonBody(request)), {
        status: 201,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    if (
      path[0] === 'github' &&
      path[1] === 'repositories' &&
      path.length === 3 &&
      method === 'DELETE'
    )
      return NextResponse.json(await disconnectRepository(actor, path[2]));
    if (
      path[0] === 'github' &&
      path[1] === 'repositories' &&
      path[3] === 'deliveries' &&
      path.length === 4 &&
      method === 'GET'
    )
      return NextResponse.json(await listGitHubDeliveries(actor, path[2]), {
        headers: { 'Cache-Control': 'no-store' },
      });
    if (route === 'github' && method === 'GET') {
      const projectId = url.searchParams.get('projectId');
      let repository: string | null = null;
      if (projectId) {
        const project = await db.project.findFirst({ where: { id: projectId, workspaceId } });
        if (!project) throw new HttpError(404, 'Project not found');
        repository = project.repository;
      }
      return NextResponse.json(await githubData(user.id, repository));
    }
    if (route === 'github' && method === 'DELETE') {
      await db.gitHubConnection.deleteMany({ where: { userId: user.id } });
      return NextResponse.json({ ok: true });
    }
    throw new HttpError(404, 'Endpoint not found');
  } catch (error) {
    const response = errorResponse(error);
    if (operationalHealthRead || connectionRevalidation || retentionRead)
      response.headers.set('Cache-Control', 'no-store');
    return response;
  }
}
export { handler as GET, handler as POST, handler as PATCH, handler as DELETE };
