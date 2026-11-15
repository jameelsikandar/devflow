import type { Prisma } from '@prisma/client';
import { HttpError } from './errors';

/** Lock first, then read graph/tasks under READ COMMITTED; all new project writes use this boundary. */
export async function lockActiveProject(
  tx: Prisma.TransactionClient,
  userId: string,
  workspaceId: string,
  projectId: string,
) {
  const projects = await tx.$queryRaw<{ id: string; archivedAt: Date | null }[]>`
    SELECT p."id", p."archivedAt" FROM "Project" p
    WHERE p."id" = ${projectId} AND p."workspaceId" = ${workspaceId}
      AND EXISTS (SELECT 1 FROM "WorkspaceMember" m
        WHERE m."workspaceId" = p."workspaceId" AND m."userId" = ${userId})
    FOR UPDATE OF p`;
  if (!projects.length) throw new HttpError(404, 'Project not found');
  if (projects[0].archivedAt)
    throw new HttpError(409, 'Restore this project before making changes');
}
