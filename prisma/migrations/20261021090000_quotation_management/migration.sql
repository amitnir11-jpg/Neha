CREATE TABLE IF NOT EXISTS "quotations" (
  "id" TEXT NOT NULL,
  "data" JSONB NOT NULL DEFAULT '{}',
  "dealerCode" TEXT NOT NULL,
  "quotationNumber" TEXT NOT NULL,
  "customerName" TEXT NOT NULL,
  "customerPhone" TEXT,
  "customerEmail" TEXT,
  "customerAddress" TEXT,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "validUntil" TIMESTAMP(3),
  "subtotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "discountAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "taxableAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "taxAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "totalAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "quotations_dealerCode_quotationNumber_key" ON "quotations"("dealerCode", "quotationNumber");
CREATE INDEX IF NOT EXISTS "quotations_dealerCode_createdAt_idx" ON "quotations"("dealerCode", "createdAt");
CREATE INDEX IF NOT EXISTS "quotations_dealerCode_status_idx" ON "quotations"("dealerCode", "status");
CREATE INDEX IF NOT EXISTS "quotations_customerName_idx" ON "quotations"("customerName");
