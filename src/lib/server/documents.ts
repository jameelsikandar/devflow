import { Prisma } from '@prisma/client';
import { db } from './db';
import { HttpError } from './errors';
import { lockActiveProject } from './project-lock';
import type { WorkspaceActor } from './tasks';
import {
  documentCreate,
  documentEdit,
  documentGrant,
  documentId,
  documentPermissions,
  documentQuery,
  documentVersion,
} from '../documents';
const include = {
  owner: { select: { id: true, name: true } },
  grants: { select: { userId: true, access: true } },
} as const;
type RecordWithGrants = Prisma.ProjectDocumentGetPayload<{ include: typeof include }>;
function present(record: RecordWithGrants, actor: WorkspaceActor, role: string) {
  const permissions = documentPermissions(
    role,
    record.ownerId === actor.userId,
    record.grants.find((g) => g.userId === actor.userId)?.access,
  );
  const { grants, ...rest } = record;
  void grants;
  return { ...rest, permissions };
}
async function scope(
  tx: Prisma.TransactionClient,
  actor: WorkspaceActor,
  projectId: string,
  write = false,
) {
  documentId.parse(projectId);
  if (write) await lockActiveProject(tx, actor.userId, actor.workspaceId, projectId);
  const member = write
    ? (
        await tx.$queryRaw<
          { role: string }[]
        >`SELECT "role" FROM "WorkspaceMember" WHERE "workspaceId"=${actor.workspaceId} AND "userId"=${actor.userId} FOR SHARE`
      )[0]
    : await tx.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: actor.workspaceId, userId: actor.userId } },
      });
  if (!member) throw new HttpError(404, 'Project not found');
  const project = await tx.project.findFirst({
    where: { id: projectId, workspaceId: actor.workspaceId },
    select: { archivedAt: true },
  });
  if (!project) throw new HttpError(404, 'Project not found');
  return { role: member.role, project };
}
async function readable(
  tx: Prisma.TransactionClient,
  actor: WorkspaceActor,
  projectId: string,
  id: string,
  role: string,
) {
  documentId.parse(id);
  const record = await tx.projectDocument.findFirst({
    where: { id, projectId, workspaceId: actor.workspaceId },
    include,
  });
  if (!record || !present(record, actor, role).permissions.read)
    throw new HttpError(404, 'Document not found');
  return record;
}
export async function listProjectDocuments(
  actor: WorkspaceActor,
  projectId: string,
  input: unknown = {},
) {
  const query = documentQuery.parse(input);
  return db.$transaction(
    async (tx) => {
      const { role, project } = await scope(tx, actor, projectId);
      const where: Prisma.ProjectDocumentWhereInput = {
        workspaceId: actor.workspaceId,
        projectId,
        archivedAt: query.archived === 'true' ? { not: null } : null,
        ...(!documentPermissions(role, false).manage
          ? { OR: [{ ownerId: actor.userId }, { grants: { some: { userId: actor.userId } } }] }
          : {}),
      };
      const [records, total] = await Promise.all([
        tx.projectDocument.findMany({
          where,
          include,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 25,
          skip: query.offset,
        }),
        tx.projectDocument.count({ where }),
      ]);
      return {
        documents: records.map((r) => present(r, actor, role)),
        total,
        offset: query.offset,
        hasMore: query.offset + records.length < total,
        projectArchived: !!project.archivedAt,
      };
    },
    { isolationLevel: 'RepeatableRead' },
  );
}
export async function getProjectDocument(actor: WorkspaceActor, projectId: string, id: string) {
  return db.$transaction(
    async (tx) => {
      const { role, project } = await scope(tx, actor, projectId);
      const record = await readable(tx, actor, projectId, id, role);
      const result = present(record, actor, role);
      // Only managers receive the access list; readers never receive other grants.
      const grants = result.permissions.manage
        ? await tx.documentGrant.findMany({
            where: { documentId: id, workspaceId: actor.workspaceId, projectId },
            select: {
              userId: true,
              access: true,
              member: { select: { user: { select: { id: true, name: true } } } },
            },
            orderBy: { userId: 'asc' },
            take: 100,
          })
        : undefined;
      return { ...result, grants, projectArchived: !!project.archivedAt };
    },
    { isolationLevel: 'RepeatableRead' },
  );
}
export async function createProjectDocument(
  actor: WorkspaceActor,
  projectId: string,
  input: unknown,
) {
  const data = documentCreate.parse(input);
  return db.$transaction(async (tx) => {
    const { role } = await scope(tx, actor, projectId, true);
    const record = await tx.projectDocument.create({
      data: {
        ...data,
        projectId,
        workspaceId: actor.workspaceId,
        ownerId: actor.userId,
        updatedById: actor.userId,
      },
      include,
    });
    return present(record, actor, role);
  });
}
export async function mutateProjectDocument(
  actor: WorkspaceActor,
  projectId: string,
  id: string,
  operation: 'EDIT' | 'ARCHIVE' | 'GRANT' | 'REVOKE',
  input: unknown,
  targetId?: string,
) {
  const edit = operation === 'EDIT' ? documentEdit.parse(input) : null;
  const grant = operation === 'GRANT' ? documentGrant.parse(input) : null;
  const data = edit ?? grant ?? documentVersion.parse(input);
  if (operation === 'GRANT' || operation === 'REVOKE') documentId.parse(targetId);
  return db.$transaction(async (tx) => {
    const { role } = await scope(tx, actor, projectId, true);
    const record = await readable(tx, actor, projectId, id, role);
    const permissions = present(record, actor, role).permissions;
    if (!(operation === 'EDIT' ? permissions.edit : permissions.manage))
      throw new HttpError(403, 'Document permission required');
    if (record.archivedAt) throw new HttpError(409, 'Archived documents are read-only');
    if (record.version !== data.version)
      throw new HttpError(409, 'Document changed. Reload before saving');
    if (operation === 'GRANT' || operation === 'REVOKE') {
      if (targetId === record.ownerId)
        throw new HttpError(400, 'The owner already has full access');
      const target = await tx.$queryRaw<
        { userId: string }[]
      >`SELECT "userId" FROM "WorkspaceMember" WHERE "workspaceId"=${actor.workspaceId} AND "userId"=${targetId!} FOR SHARE`;
      if (!target.length) throw new HttpError(404, 'Workspace member not found');
      if (operation === 'GRANT') {
        const count = await tx.documentGrant.count({ where: { documentId: id } });
        const existing = await tx.documentGrant.findUnique({
          where: { documentId_userId: { documentId: id, userId: targetId! } },
        });
        if (!existing && count >= 100)
          throw new HttpError(409, 'A document supports up to 100 grants');
        await tx.documentGrant.upsert({
          where: { documentId_userId: { documentId: id, userId: targetId! } },
          create: {
            workspaceId: actor.workspaceId,
            projectId,
            documentId: id,
            userId: targetId!,
            access: grant!.access,
          },
          update: { access: grant!.access },
        });
      } else
        await tx.documentGrant.deleteMany({
          where: { documentId: id, userId: targetId, workspaceId: actor.workspaceId, projectId },
        });
    }
    const changed = await tx.projectDocument.updateMany({
      where: {
        id,
        workspaceId: actor.workspaceId,
        projectId,
        version: data.version,
        archivedAt: null,
      },
      data: {
        version: { increment: 1 },
        updatedById: actor.userId,
        ...(edit
          ? { title: edit.title, ...(edit.summary !== undefined ? { summary: edit.summary } : {}) }
          : {}),
        ...(operation === 'ARCHIVE' ? { archivedAt: new Date() } : {}),
      },
    });
    if (changed.count !== 1) throw new HttpError(409, 'Document changed. Reload before saving');
    return present(await readable(tx, actor, projectId, id, role), actor, role);
  });
}
