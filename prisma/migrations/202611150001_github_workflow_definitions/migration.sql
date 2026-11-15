BEGIN;
-- CreateEnum
CREATE TYPE "GitHubWorkflowTrigger" AS ENUM ('PR_OPENED', 'PR_READY_FOR_REVIEW', 'PR_MERGED', 'PR_CLOSED_UNMERGED');

-- CreateTable
CREATE TABLE "GitHubWorkflowRule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "connectionId" TEXT,
    "name" TEXT NOT NULL,
    "trigger" "GitHubWorkflowTrigger" NOT NULL,
    "targetStatus" "Status" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitHubWorkflowRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitHubWorkflowRuleRevision" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "actorId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitHubWorkflowRuleRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GitHubWorkflowRule_workspaceId_projectId_deletedAt_priority_idx" ON "GitHubWorkflowRule"("workspaceId", "projectId", "deletedAt", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubWorkflowRule_projectId_id_key" ON "GitHubWorkflowRule"("projectId", "id");

-- CreateIndex
CREATE INDEX "GitHubWorkflowRuleRevision_projectId_createdAt_idx" ON "GitHubWorkflowRuleRevision"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubWorkflowRuleRevision_ruleId_version_key" ON "GitHubWorkflowRuleRevision"("ruleId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubWorkflowRuleRevision_projectId_requestId_key" ON "GitHubWorkflowRuleRevision"("projectId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubRepositoryConnection_projectId_id_key" ON "GitHubRepositoryConnection"("projectId", "id");

-- AddForeignKey
ALTER TABLE "GitHubWorkflowRule" ADD CONSTRAINT "GitHubWorkflowRule_workspaceId_projectId_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubWorkflowRule" ADD CONSTRAINT "GitHubWorkflowRule_projectId_connectionId_fkey" FOREIGN KEY ("projectId", "connectionId") REFERENCES "GitHubRepositoryConnection"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubWorkflowRuleRevision" ADD CONSTRAINT "GitHubWorkflowRuleRevision_projectId_ruleId_fkey" FOREIGN KEY ("projectId", "ruleId") REFERENCES "GitHubWorkflowRule"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubWorkflowRuleRevision" ADD CONSTRAINT "GitHubWorkflowRuleRevision_workspaceId_projectId_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "GitHubWorkflowRule" ADD CONSTRAINT "GitHubWorkflowRule_bounds" CHECK ("priority" BETWEEN 0 AND 10000 AND "version" > 0);
ALTER TABLE "GitHubWorkflowRuleRevision" ADD CONSTRAINT "GitHubWorkflowRuleRevision_operation" CHECK ("operation" IN ('CREATE', 'UPDATE', 'DELETE') AND "version" > 0);

COMMIT;
