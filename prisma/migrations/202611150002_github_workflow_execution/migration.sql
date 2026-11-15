BEGIN;
-- CreateEnum
CREATE TYPE "ActivitySource" AS ENUM ('HUMAN', 'GITHUB_AUTOMATION');

-- CreateEnum
CREATE TYPE "GitHubWorkflowExecutionState" AS ENUM ('PENDING', 'APPLIED', 'SKIPPED', 'CONFLICTED', 'FAILED');

-- AlterTable
ALTER TABLE "TaskActivity" ADD COLUMN     "executionId" TEXT,
ADD COLUMN     "source" "ActivitySource" NOT NULL DEFAULT 'HUMAN',
ALTER COLUMN "actorId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "GitHubWebhookDelivery" ADD COLUMN     "automationVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "GitHubWorkflowRule" ADD COLUMN     "automationAuthorizedById" TEXT,
ADD COLUMN     "automationEnabledAt" TIMESTAMP(3),
ADD COLUMN     "automationEnabledVersion" INTEGER;

-- CreateTable
CREATE TABLE "GitHubWorkflowExecution" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "claimKey" TEXT,
    "duplicateOfId" TEXT,
    "ruleId" TEXT,
    "ruleVersion" INTEGER,
    "ruleSnapshot" JSONB,
    "taskId" TEXT,
    "taskProjectId" TEXT,
    "taskSnapshot" JSONB,
    "expectedTaskVersion" INTEGER,
    "previousStatus" "Status",
    "targetStatus" "Status",
    "evaluation" JSONB NOT NULL,
    "result" JSONB,
    "state" "GitHubWorkflowExecutionState" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "GitHubWorkflowExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GitHubWorkflowExecution_observationId_key" ON "GitHubWorkflowExecution"("observationId");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubWorkflowExecution_claimKey_key" ON "GitHubWorkflowExecution"("claimKey");

-- CreateIndex
CREATE INDEX "GitHubWorkflowExecution_state_availableAt_createdAt_idx" ON "GitHubWorkflowExecution"("state", "availableAt", "createdAt");

-- CreateIndex
CREATE INDEX "GitHubWorkflowExecution_workspaceId_projectId_createdAt_idx" ON "GitHubWorkflowExecution"("workspaceId", "projectId", "createdAt");

-- CreateIndex
CREATE INDEX "GitHubWorkflowExecution_projectId_repositoryId_eventKey_idx" ON "GitHubWorkflowExecution"("projectId", "repositoryId", "eventKey");

-- CreateIndex
CREATE INDEX "GitHubWorkflowExecution_taskId_idx" ON "GitHubWorkflowExecution"("taskId");

-- CreateIndex
CREATE INDEX "GitHubWorkflowExecution_deliveryId_idx" ON "GitHubWorkflowExecution"("deliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskActivity_executionId_key" ON "TaskActivity"("executionId");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubObservation_connectionId_deliveryId_objectId_id_key" ON "GitHubObservation"("connectionId", "deliveryId", "objectId", "id");

-- AddForeignKey
ALTER TABLE "TaskActivity" ADD CONSTRAINT "TaskActivity_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "GitHubWorkflowExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubWorkflowExecution" ADD CONSTRAINT "GitHubWorkflowExecution_workspaceId_projectId_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubWorkflowExecution" ADD CONSTRAINT "GitHubWorkflowExecution_projectId_repositoryId_connectionI_fkey" FOREIGN KEY ("projectId", "repositoryId", "connectionId") REFERENCES "GitHubRepositoryConnection"("projectId", "repositoryId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubWorkflowExecution" ADD CONSTRAINT "GitHubWorkflowExecution_connectionId_deliveryId_fkey" FOREIGN KEY ("connectionId", "deliveryId") REFERENCES "GitHubWebhookDelivery"("connectionId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubWorkflowExecution" ADD CONSTRAINT "GitHubWorkflowExecution_connectionId_deliveryId_objectId_o_fkey" FOREIGN KEY ("connectionId", "deliveryId", "objectId", "observationId") REFERENCES "GitHubObservation"("connectionId", "deliveryId", "objectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubWorkflowExecution" ADD CONSTRAINT "GitHubWorkflowExecution_projectId_repositoryId_objectId_fkey" FOREIGN KEY ("projectId", "repositoryId", "objectId") REFERENCES "GitHubObject"("projectId", "repositoryId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubWorkflowExecution" ADD CONSTRAINT "GitHubWorkflowExecution_projectId_ruleId_fkey" FOREIGN KEY ("projectId", "ruleId") REFERENCES "GitHubWorkflowRule"("projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubWorkflowExecution" ADD CONSTRAINT "GitHubWorkflowExecution_taskProjectId_taskId_fkey" FOREIGN KEY ("taskProjectId", "taskId") REFERENCES "Task"("projectId", "id") ON DELETE SET NULL ON UPDATE CASCADE;


ALTER TABLE "GitHubWorkflowExecution" ADD CONSTRAINT "GitHubWorkflowExecution_task_scope" CHECK (("taskId" IS NULL AND "taskProjectId" IS NULL) OR ("taskId" IS NOT NULL AND "taskProjectId" IS NOT NULL AND "taskProjectId" = "projectId"));
ALTER TABLE "GitHubWorkflowExecution" ADD CONSTRAINT "GitHubWorkflowExecution_attempts" CHECK ("attempts" >= 0);
ALTER TABLE "TaskActivity" ADD CONSTRAINT "TaskActivity_source_actor" CHECK (("source" = 'HUMAN' AND "actorId" IS NOT NULL AND "executionId" IS NULL) OR ("source" = 'GITHUB_AUTOMATION' AND "actorId" IS NULL AND "executionId" IS NOT NULL));

COMMIT;
