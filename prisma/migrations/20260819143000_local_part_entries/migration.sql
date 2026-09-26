CREATE TABLE "local_part_entries" (
    "id" TEXT NOT NULL,
    "dealerCode" TEXT NOT NULL,
    "referenceAuditId" TEXT,
    "partNumber" TEXT NOT NULL,
    "normalizedPartNumber" TEXT NOT NULL,
    "partDescription" TEXT NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "mrp" DECIMAL(18,2) NOT NULL,
    "dlc" DECIMAL(18,2) NOT NULL,
    "remarks" TEXT,
    "enteredByUserId" TEXT NOT NULL,
    "enteredByName" TEXT NOT NULL,
    "lastUpdatedByUserId" TEXT,
    "lastUpdatedByName" TEXT,
    "deletedByUserId" TEXT,
    "deletedByName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "local_part_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "local_part_entries_dealerCode_idx" ON "local_part_entries"("dealerCode");
CREATE INDEX "local_part_entries_referenceAuditId_idx" ON "local_part_entries"("referenceAuditId");
CREATE INDEX "local_part_entries_normalizedPartNumber_idx" ON "local_part_entries"("normalizedPartNumber");
CREATE INDEX "local_part_entries_createdAt_idx" ON "local_part_entries"("createdAt");
CREATE INDEX "local_part_entries_status_idx" ON "local_part_entries"("status");
CREATE INDEX "local_part_entries_deletedAt_idx" ON "local_part_entries"("deletedAt");
