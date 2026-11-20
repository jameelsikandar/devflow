CREATE TYPE "DocumentAccess" AS ENUM ('READER', 'EDITOR');
CREATE TABLE "ProjectDocument" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "updatedById" TEXT,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL DEFAULT '',
  "version" INTEGER NOT NULL DEFAULT 0,
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectDocument_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectDocument_title_check" CHECK (char_length(btrim("title")) BETWEEN 1 AND 160),
  CONSTRAINT "ProjectDocument_summary_check" CHECK (char_length("summary") <= 2000),
  CONSTRAINT "ProjectDocument_version_check" CHECK ("version" >= 0)
);
CREATE TABLE "DocumentGrant" (
  "workspaceId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "access" "DocumentAccess" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DocumentGrant_pkey" PRIMARY KEY ("documentId", "userId")
);
CREATE UNIQUE INDEX "ProjectDocument_workspaceId_projectId_id_key" ON "ProjectDocument"("workspaceId", "projectId", "id");
CREATE INDEX "ProjectDocument_scope_archive_created_idx" ON "ProjectDocument"("workspaceId", "projectId", "archivedAt", "createdAt", "id");
CREATE INDEX "ProjectDocument_ownerId_idx" ON "ProjectDocument"("ownerId");
CREATE INDEX "DocumentGrant_workspaceId_userId_idx" ON "DocumentGrant"("workspaceId", "userId");
ALTER TABLE "ProjectDocument" ADD CONSTRAINT "ProjectDocument_workspaceId_projectId_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectDocument" ADD CONSTRAINT "ProjectDocument_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectDocument" ADD CONSTRAINT "ProjectDocument_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DocumentGrant" ADD CONSTRAINT "DocumentGrant_workspaceId_projectId_documentId_fkey" FOREIGN KEY ("workspaceId", "projectId", "documentId") REFERENCES "ProjectDocument"("workspaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentGrant" ADD CONSTRAINT "DocumentGrant_workspaceId_userId_fkey" FOREIGN KEY ("workspaceId", "userId") REFERENCES "WorkspaceMember"("workspaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
