-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "annualRecurringRevenue" INTEGER;

-- AlterTable
ALTER TABLE "SupportCase" ADD COLUMN "escalatedAt" DATETIME;
ALTER TABLE "SupportCase" ADD COLUMN "escalationReason" TEXT;

-- AlterTable
ALTER TABLE "CaseComment" ADD COLUMN "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "IdempotencyRecord" ADD COLUMN "lockExpiresAt" DATETIME;

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventType" TEXT NOT NULL,
    "accountId" TEXT,
    "payloadJson" TEXT NOT NULL,
    "correlationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_WebhookDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "endpointId" TEXT NOT NULL,
    "outboxEventId" TEXT,
    "eventType" TEXT NOT NULL,
    "accountId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "signatureHeader" TEXT NOT NULL,
    "timestampHeader" INTEGER NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "responseStatus" INTEGER,
    "lastError" TEXT,
    "nextAttemptAt" DATETIME,
    "lockedUntil" DATETIME,
    "deliveredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WebhookDelivery_outboxEventId_fkey" FOREIGN KEY ("outboxEventId") REFERENCES "OutboxEvent" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_WebhookDelivery" ("accountId", "attemptCount", "createdAt", "deliveredAt", "endpointId", "eventType", "id", "lastError", "payloadJson", "responseStatus", "signatureHeader", "status", "timestampHeader", "updatedAt") SELECT "accountId", "attemptCount", "createdAt", "deliveredAt", "endpointId", "eventType", "id", "lastError", "payloadJson", "responseStatus", "signatureHeader", "status", "timestampHeader", "updatedAt" FROM "WebhookDelivery";
DROP TABLE "WebhookDelivery";
ALTER TABLE "new_WebhookDelivery" RENAME TO "WebhookDelivery";
CREATE INDEX "WebhookDelivery_endpointId_status_idx" ON "WebhookDelivery"("endpointId", "status");
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");
CREATE INDEX "WebhookDelivery_eventType_idx" ON "WebhookDelivery"("eventType");
CREATE UNIQUE INDEX "WebhookDelivery_outboxEventId_endpointId_key" ON "WebhookDelivery"("outboxEventId", "endpointId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "OutboxEvent_eventType_createdAt_idx" ON "OutboxEvent"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "SupportCase_createdAt_id_idx" ON "SupportCase"("createdAt", "id");

-- CreateIndex
CREATE INDEX "SupportCase_updatedAt_id_idx" ON "SupportCase"("updatedAt", "id");

-- CreateIndex
CREATE INDEX "SupportCase_slaResponseDueAt_id_idx" ON "SupportCase"("slaResponseDueAt", "id");

-- CreateIndex
CREATE INDEX "SupportCase_severity_id_idx" ON "SupportCase"("severity", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CaseComment_caseId_idempotencyKey_key" ON "CaseComment"("caseId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

-- Backfill: make pre-existing PENDING deliveries eligible for the background dispatcher
UPDATE "WebhookDelivery" SET "nextAttemptAt" = "createdAt" WHERE "status" = 'PENDING' AND "nextAttemptAt" IS NULL;

-- Append-only audit trail: reject any UPDATE or DELETE at the storage layer
CREATE TRIGGER "AuditEvent_no_update"
BEFORE UPDATE ON "AuditEvent"
BEGIN
    SELECT RAISE(ABORT, 'AuditEvent rows are immutable');
END;

CREATE TRIGGER "AuditEvent_no_delete"
BEFORE DELETE ON "AuditEvent"
BEGIN
    SELECT RAISE(ABORT, 'AuditEvent rows are immutable');
END;

