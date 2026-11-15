-- Additive: existing tasks retain their due date and remain unscheduled.
ALTER TABLE "Task" ADD COLUMN "startDate" TIMESTAMP(3);
ALTER TABLE "Task" ADD COLUMN "isMilestone" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Task" ADD CONSTRAINT "Task_schedule_order_check"
  CHECK ("startDate" IS NULL OR "dueDate" IS NULL OR "startDate" <= "dueDate");
ALTER TABLE "Task" ADD CONSTRAINT "Task_milestone_date_check"
  CHECK (NOT "isMilestone" OR ("startDate" IS NOT NULL AND "dueDate" IS NOT NULL
    AND "startDate"::date = "dueDate"::date));
CREATE UNIQUE INDEX "Task_projectId_id_key" ON "Task"("projectId", "id");
CREATE INDEX "Task_projectId_startDate_dueDate_idx" ON "Task"("projectId", "startDate", "dueDate");
CREATE TABLE "TaskDependency" (
  "projectId" TEXT NOT NULL,
  "predecessorId" TEXT NOT NULL,
  "successorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaskDependency_pkey" PRIMARY KEY ("predecessorId", "successorId"),
  CONSTRAINT "TaskDependency_no_self_check" CHECK ("predecessorId" <> "successorId"),
  CONSTRAINT "TaskDependency_predecessor_fkey" FOREIGN KEY ("projectId", "predecessorId")
    REFERENCES "Task"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TaskDependency_successor_fkey" FOREIGN KEY ("projectId", "successorId")
    REFERENCES "Task"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TaskDependency_projectId_successorId_idx" ON "TaskDependency"("projectId", "successorId");
-- Cycles are checked by the service while holding a project row lock. All graph
-- writes must use that service; the foreign keys also prevent cross-project edges.
