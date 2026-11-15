BEGIN;
CREATE TYPE "GitHubWorkerMode" AS ENUM ('CONTINUOUS', 'BOUNDED');
CREATE TYPE "GitHubWorkerRunState" AS ENUM ('RUNNING', 'STOPPED', 'COMPLETED', 'FAILED');
CREATE TABLE "GitHubWorkerSignal" (
  "runId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "mode" "GitHubWorkerMode" NOT NULL,
  "state" "GitHubWorkerRunState" NOT NULL DEFAULT 'RUNNING',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "polledAt" TIMESTAMP(3),
  "progressAt" TIMESTAMP(3),
  "idleAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "staleAfterMs" INTEGER NOT NULL,
  CONSTRAINT "GitHubWorkerSignal_pkey" PRIMARY KEY ("runId", "connectionId"),
  CONSTRAINT "GitHubWorkerSignal_stale_check" CHECK ("staleAfterMs" BETWEEN 30000 AND 300000),
  CONSTRAINT "GitHubWorkerSignal_end_check" CHECK (("state" = 'RUNNING') = ("endedAt" IS NULL)),
  CONSTRAINT "GitHubWorkerSignal_connection_fkey" FOREIGN KEY ("projectId", "connectionId")
    REFERENCES "GitHubRepositoryConnection"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "GitHubWorkerSignal_project_fkey" FOREIGN KEY ("workspaceId", "projectId")
    REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "GitHubWorkerSignal_scope_heartbeat_idx" ON "GitHubWorkerSignal"("workspaceId", "projectId", "connectionId", "heartbeatAt");
COMMIT;
