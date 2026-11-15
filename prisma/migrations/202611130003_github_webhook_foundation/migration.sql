BEGIN;
-- CreateEnum
CREATE TYPE "GitHubDeliveryState" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "GitHubRepositoryConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "repositoryFullName" TEXT NOT NULL,
    "connectedById" TEXT,
    "encryptedWebhookSecret" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAt" TIMESTAMP(3),

    CONSTRAINT "GitHubRepositoryConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitHubWebhookDelivery" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "state" "GitHubDeliveryState" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitHubWebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GitHubRepositoryConnection_workspaceId_projectId_disconnect_idx" ON "GitHubRepositoryConnection"("workspaceId", "projectId", "disconnectedAt");

-- CreateIndex
CREATE INDEX "GitHubRepositoryConnection_connectedById_idx" ON "GitHubRepositoryConnection"("connectedById");

-- CreateIndex
CREATE INDEX "GitHubWebhookDelivery_state_availableAt_idx" ON "GitHubWebhookDelivery"("state", "availableAt");

-- CreateIndex
CREATE INDEX "GitHubWebhookDelivery_connectionId_receivedAt_idx" ON "GitHubWebhookDelivery"("connectionId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubWebhookDelivery_connectionId_deliveryId_key" ON "GitHubWebhookDelivery"("connectionId", "deliveryId");

-- AddForeignKey
ALTER TABLE "GitHubRepositoryConnection" ADD CONSTRAINT "GitHubRepositoryConnection_workspaceId_projectId_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubRepositoryConnection" ADD CONSTRAINT "GitHubRepositoryConnection_connectedById_fkey" FOREIGN KEY ("connectedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubWebhookDelivery" ADD CONSTRAINT "GitHubWebhookDelivery_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "GitHubRepositoryConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Preserve historical disconnected records while allowing only one live binding.
CREATE UNIQUE INDEX "GitHubRepositoryConnection_one_active_project" ON "GitHubRepositoryConnection"("projectId") WHERE "disconnectedAt" IS NULL;
ALTER TABLE "GitHubRepositoryConnection" ADD CONSTRAINT "GitHubRepositoryConnection_repositoryId_check" CHECK ("repositoryId" ~ '^[1-9][0-9]*$');
ALTER TABLE "GitHubWebhookDelivery" ADD CONSTRAINT "GitHubWebhookDelivery_attempts_check" CHECK ("attempts" >= 0);

CREATE UNIQUE INDEX "GitHubWebhookDelivery_connectionId_payloadHash_key" ON "GitHubWebhookDelivery"("connectionId", "payloadHash");
COMMIT;
