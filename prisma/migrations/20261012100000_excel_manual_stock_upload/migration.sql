CREATE TABLE "excel_stock_upload_batches" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "dealerCode" TEXT NOT NULL,
  "dealerName" TEXT,
  "auditId" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "fileHash" TEXT NOT NULL,
  "uploadedBy" TEXT NOT NULL,
  "uploadedByName" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "acceptedRows" INTEGER NOT NULL DEFAULT 0,
  "rejectedRows" INTEGER NOT NULL DEFAULT 0,
  "uploadedQty" INTEGER NOT NULL DEFAULT 0,
  "rows" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "excel_stock_upload_batches_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "excel_stock_upload_batches_batchId_key" ON "excel_stock_upload_batches"("batchId");
CREATE INDEX "excel_stock_upload_batches_dealerCode_createdAt_idx" ON "excel_stock_upload_batches"("dealerCode", "createdAt");
CREATE INDEX "excel_stock_upload_batches_auditId_status_idx" ON "excel_stock_upload_batches"("auditId", "status");
CREATE UNIQUE INDEX "excel_stock_upload_batches_dealerCode_auditId_fileHash_key" ON "excel_stock_upload_batches"("dealerCode", "auditId", "fileHash");
