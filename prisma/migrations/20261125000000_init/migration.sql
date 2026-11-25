-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "primaryEmail" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "externalCrmId" TEXT,
    "region" TEXT NOT NULL DEFAULT 'us-east',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Entitlement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalId" TEXT,
    "accountId" TEXT NOT NULL,
    "contractRef" TEXT,
    "featureCode" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "quotaLimit" INTEGER,
    "quotaUnit" TEXT,
    "supportLevel" TEXT,
    "maxCaseSeverity" TEXT,
    "slaResponseMinutes" INTEGER,
    "effectiveFrom" DATETIME NOT NULL,
    "effectiveTo" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Entitlement_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Customer" ("accountId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalEventId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "metricCode" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'api',
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsageEvent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Customer" ("accountId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SupportCase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseNumber" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "entitlementId" TEXT,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "entitledSupportLevel" TEXT NOT NULL,
    "requesterEmail" TEXT NOT NULL,
    "assigneeId" TEXT,
    "slaResponseDueAt" DATETIME NOT NULL,
    "resolvedAt" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SupportCase_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Customer" ("accountId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SupportCase_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "Entitlement" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CaseComment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorRole" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CaseComment_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "SupportCase" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IntegrationSyncRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceSummary" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "customersProcessed" INTEGER NOT NULL DEFAULT 0,
    "entitlementsProcessed" INTEGER NOT NULL DEFAULT 0,
    "usageEventsProcessed" INTEGER NOT NULL DEFAULT 0,
    "errorDetail" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT,
    "actorId" TEXT NOT NULL,
    "actorScopes" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "traceId" TEXT,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "routePath" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "responseEtag" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "signingSecret" TEXT NOT NULL,
    "subscribedEventsJson" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "endpointId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "accountId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "signatureHeader" TEXT NOT NULL,
    "timestampHeader" INTEGER NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "responseStatus" INTEGER,
    "lastError" TEXT,
    "deliveredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_accountId_key" ON "Customer"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_externalCrmId_key" ON "Customer"("externalCrmId");

-- CreateIndex
CREATE INDEX "Customer_status_tier_idx" ON "Customer"("status", "tier");

-- CreateIndex
CREATE UNIQUE INDEX "Entitlement_externalId_key" ON "Entitlement"("externalId");

-- CreateIndex
CREATE INDEX "Entitlement_accountId_featureCode_status_idx" ON "Entitlement"("accountId", "featureCode", "status");

-- CreateIndex
CREATE UNIQUE INDEX "UsageEvent_externalEventId_key" ON "UsageEvent"("externalEventId");

-- CreateIndex
CREATE INDEX "UsageEvent_accountId_metricCode_recordedAt_idx" ON "UsageEvent"("accountId", "metricCode", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupportCase_caseNumber_key" ON "SupportCase"("caseNumber");

-- CreateIndex
CREATE INDEX "SupportCase_accountId_status_severity_idx" ON "SupportCase"("accountId", "status", "severity");

-- CreateIndex
CREATE INDEX "CaseComment_caseId_idx" ON "CaseComment"("caseId");

-- CreateIndex
CREATE INDEX "AuditEvent_accountId_idx" ON "AuditEvent"("accountId");

-- CreateIndex
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "AuditEvent"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_key_method_routePath_actorId_key" ON "IdempotencyRecord"("key", "method", "routePath", "actorId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_endpointId_status_idx" ON "WebhookDelivery"("endpointId", "status");

-- CreateIndex
CREATE INDEX "WebhookDelivery_eventType_idx" ON "WebhookDelivery"("eventType");
