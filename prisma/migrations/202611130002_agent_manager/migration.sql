BEGIN;
CREATE TYPE "AIRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');
CREATE TYPE "AIProposalStatus" AS ENUM ('PENDING', 'APPLIED', 'REJECTED', 'EXPIRED');
ALTER TABLE "Task" ADD COLUMN "parentTaskId" TEXT;
ALTER TABLE "Task" ADD CONSTRAINT "Task_parentTaskId_fkey" FOREIGN KEY ("parentTaskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Task_parentTaskId_idx" ON "Task"("parentTaskId");
CREATE UNIQUE INDEX "Project_workspaceId_id_key" ON "Project"("workspaceId", "id");
CREATE TABLE "AIConversation" (
  "id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL, "userId" TEXT NOT NULL,
  "projectId" TEXT, "title" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AIConversation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AIConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AIConversation_workspaceId_projectId_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AIConversation_workspaceId_userId_updatedAt_idx" ON "AIConversation"("workspaceId", "userId", "updatedAt");
CREATE TABLE "AIRun" (
  "id" TEXT PRIMARY KEY, "conversationId" TEXT NOT NULL, "requestId" TEXT NOT NULL,
  "prompt" TEXT NOT NULL, "answer" TEXT NOT NULL DEFAULT '', "status" "AIRunStatus" NOT NULL DEFAULT 'RUNNING',
  "error" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL, "completedAt" TIMESTAMP(3),
  CONSTRAINT "AIRun_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AIConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AIRun_conversationId_requestId_key" ON "AIRun"("conversationId", "requestId");
CREATE INDEX "AIRun_conversationId_createdAt_idx" ON "AIRun"("conversationId", "createdAt");
-- Partial uniqueness supplements the conversation row lock used by the service.
CREATE UNIQUE INDEX "AIRun_one_running_per_conversation" ON "AIRun"("conversationId") WHERE "status" = 'RUNNING';
CREATE TABLE "AIToolEvent" (
  "id" TEXT PRIMARY KEY, "runId" TEXT NOT NULL, "callId" TEXT NOT NULL,
  "name" TEXT NOT NULL, "input" JSONB NOT NULL, "output" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AIToolEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AIRun"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AIToolEvent_runId_callId_key" ON "AIToolEvent"("runId", "callId");
CREATE TABLE "AIProposal" (
  "id" TEXT PRIMARY KEY, "runId" TEXT NOT NULL, "tool" TEXT NOT NULL,
  "payload" JSONB NOT NULL, "preview" JSONB NOT NULL, "previewHash" TEXT NOT NULL,
  "status" "AIProposalStatus" NOT NULL DEFAULT 'PENDING', "result" JSONB,
  "expiresAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMP(3),
  CONSTRAINT "AIProposal_applied_receipt_check" CHECK ("status" <> 'APPLIED' OR ("result" IS NOT NULL AND "decidedAt" IS NOT NULL)),
  CONSTRAINT "AIProposal_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AIRun"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AIProposal_runId_status_idx" ON "AIProposal"("runId", "status");
CREATE TABLE "Sprint" (
  "id" TEXT PRIMARY KEY, "projectId" TEXT NOT NULL, "name" TEXT NOT NULL, "goal" TEXT NOT NULL,
  "startDate" TIMESTAMP(3) NOT NULL, "endDate" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Sprint_dates_check" CHECK ("startDate" <= "endDate"),
  CONSTRAINT "Sprint_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Sprint_projectId_id_key" ON "Sprint"("projectId", "id");
CREATE INDEX "Sprint_projectId_startDate_endDate_idx" ON "Sprint"("projectId", "startDate", "endDate");
CREATE TABLE "SprintTask" (
  "projectId" TEXT NOT NULL, "sprintId" TEXT NOT NULL, "taskId" TEXT NOT NULL,
  "taskVersion" INTEGER NOT NULL CHECK ("taskVersion" >= 0), "titleSnapshot" TEXT NOT NULL, "statusSnapshot" "Status" NOT NULL,
  CONSTRAINT "SprintTask_pkey" PRIMARY KEY ("sprintId", "taskId"),
  CONSTRAINT "SprintTask_projectId_sprintId_fkey" FOREIGN KEY ("projectId", "sprintId") REFERENCES "Sprint"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SprintTask_projectId_taskId_fkey" FOREIGN KEY ("projectId", "taskId") REFERENCES "Task"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SprintTask_taskId_idx" ON "SprintTask"("taskId");
CREATE TABLE "ProjectReport" (
  "id" TEXT PRIMARY KEY, "projectId" TEXT NOT NULL, "title" TEXT NOT NULL, "content" TEXT NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL, "periodEnd" TIMESTAMP(3) NOT NULL,
  "source" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectReport_dates_check" CHECK ("periodStart" <= "periodEnd"),
  CONSTRAINT "ProjectReport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ProjectReport_projectId_createdAt_idx" ON "ProjectReport"("projectId", "createdAt");
COMMIT;
