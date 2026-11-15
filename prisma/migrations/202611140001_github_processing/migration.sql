BEGIN;
-- CreateEnum
CREATE TYPE "GitHubObjectKind" AS ENUM ('COMMIT', 'PULL_REQUEST', 'ISSUE', 'WORKFLOW_RUN');

-- AlterTable
ALTER TABLE "GitHubRepositoryConnection" ADD COLUMN     "enrichmentAuthorizedAt" TIMESTAMP(3),
ADD COLUMN     "enrichmentUserId" TEXT,
ADD COLUMN     "enrichmentVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "GitHubWebhookDelivery" ADD COLUMN     "dataVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "deadLetteredAt" TIMESTAMP(3),
ADD COLUMN     "leaseExpiresAt" TIMESTAMP(3),
ADD COLUMN     "leaseToken" TEXT;

-- CreateTable
CREATE TABLE "GitHubObject" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "kind" "GitHubObjectKind" NOT NULL,
    "key" TEXT NOT NULL,
    "currentData" JSONB,
    "sourceUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitHubObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitHubObservation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "unresolvedRefs" TEXT[],
    "incomplete" BOOLEAN NOT NULL DEFAULT false,
    "enrichmentCode" TEXT NOT NULL DEFAULT 'LOCAL_ONLY',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitHubObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitHubTaskLink" (
    "projectId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitHubTaskLink_pkey" PRIMARY KEY ("objectId","taskId")
);

-- CreateTable
CREATE TABLE "GitHubTaskLinkEvidence" (
    "objectId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,

    CONSTRAINT "GitHubTaskLinkEvidence_pkey" PRIMARY KEY ("objectId","taskId","observationId")
);

-- CreateIndex
CREATE INDEX "GitHubObject_workspaceId_projectId_createdAt_idx" ON "GitHubObject"("workspaceId", "projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubObject_projectId_repositoryId_kind_key_key" ON "GitHubObject"("projectId", "repositoryId", "kind", "key");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubObject_projectId_repositoryId_id_key" ON "GitHubObject"("projectId", "repositoryId", "id");

-- CreateIndex
CREATE INDEX "GitHubObservation_connectionId_receivedAt_idx" ON "GitHubObservation"("connectionId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubObservation_objectId_deliveryId_key" ON "GitHubObservation"("objectId", "deliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubObservation_objectId_id_key" ON "GitHubObservation"("objectId", "id");

-- CreateIndex
CREATE INDEX "GitHubTaskLink_taskId_idx" ON "GitHubTaskLink"("taskId");

-- CreateIndex
CREATE INDEX "GitHubTaskLinkEvidence_observationId_idx" ON "GitHubTaskLinkEvidence"("observationId");

-- CreateIndex
CREATE INDEX "GitHubRepositoryConnection_enrichmentUserId_idx" ON "GitHubRepositoryConnection"("enrichmentUserId");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubRepositoryConnection_projectId_repositoryId_id_key" ON "GitHubRepositoryConnection"("projectId", "repositoryId", "id");

-- CreateIndex
CREATE INDEX "GitHubWebhookDelivery_state_leaseExpiresAt_idx" ON "GitHubWebhookDelivery"("state", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubWebhookDelivery_connectionId_id_key" ON "GitHubWebhookDelivery"("connectionId", "id");

-- AddForeignKey
ALTER TABLE "GitHubRepositoryConnection" ADD CONSTRAINT "GitHubRepositoryConnection_enrichmentUserId_fkey" FOREIGN KEY ("enrichmentUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubObject" ADD CONSTRAINT "GitHubObject_workspaceId_projectId_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubObservation" ADD CONSTRAINT "GitHubObservation_projectId_repositoryId_objectId_fkey" FOREIGN KEY ("projectId", "repositoryId", "objectId") REFERENCES "GitHubObject"("projectId", "repositoryId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubObservation" ADD CONSTRAINT "GitHubObservation_projectId_repositoryId_connectionId_fkey" FOREIGN KEY ("projectId", "repositoryId", "connectionId") REFERENCES "GitHubRepositoryConnection"("projectId", "repositoryId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubObservation" ADD CONSTRAINT "GitHubObservation_connectionId_deliveryId_fkey" FOREIGN KEY ("connectionId", "deliveryId") REFERENCES "GitHubWebhookDelivery"("connectionId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubTaskLink" ADD CONSTRAINT "GitHubTaskLink_projectId_repositoryId_objectId_fkey" FOREIGN KEY ("projectId", "repositoryId", "objectId") REFERENCES "GitHubObject"("projectId", "repositoryId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubTaskLink" ADD CONSTRAINT "GitHubTaskLink_projectId_taskId_fkey" FOREIGN KEY ("projectId", "taskId") REFERENCES "Task"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubTaskLinkEvidence" ADD CONSTRAINT "GitHubTaskLinkEvidence_objectId_taskId_fkey" FOREIGN KEY ("objectId", "taskId") REFERENCES "GitHubTaskLink"("objectId", "taskId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubTaskLinkEvidence" ADD CONSTRAINT "GitHubTaskLinkEvidence_objectId_observationId_fkey" FOREIGN KEY ("objectId", "observationId") REFERENCES "GitHubObservation"("objectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "GitHubWebhookDelivery" ADD CONSTRAINT "GitHubWebhookDelivery_dataVersion_check" CHECK ("dataVersion" > 0);
ALTER TABLE "GitHubRepositoryConnection" ADD CONSTRAINT "GitHubRepositoryConnection_enrichmentVersion_check" CHECK ("enrichmentVersion" >= 0);
CREATE INDEX "GitHubWebhookDelivery_claim_ready" ON "GitHubWebhookDelivery" ("availableAt", "receivedAt", "id") WHERE "state" IN ('PENDING', 'FAILED') AND "deadLetteredAt" IS NULL;
COMMIT;
