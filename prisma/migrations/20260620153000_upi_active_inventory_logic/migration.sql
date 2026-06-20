ALTER TABLE inventories ADD COLUMN IF NOT EXISTS "upiCode" TEXT;
ALTER TABLE inventories ADD COLUMN IF NOT EXISTS "movementType" TEXT;
ALTER TABLE inventories ADD COLUMN IF NOT EXISTS "activeInventory" BOOLEAN;
ALTER TABLE inventories ADD COLUMN IF NOT EXISTS "remainingQty" DOUBLE PRECISION;

ALTER TABLE scans ADD COLUMN IF NOT EXISTS "upiCode" TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS "movementType" TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS "activeInventory" BOOLEAN;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS "remainingQty" DOUBLE PRECISION;

ALTER TABLE failedscans ADD COLUMN IF NOT EXISTS "upiCode" TEXT;
ALTER TABLE failedscans ADD COLUMN IF NOT EXISTS "movementType" TEXT;
ALTER TABLE failedscans ADD COLUMN IF NOT EXISTS "activeInventory" BOOLEAN;
ALTER TABLE failedscans ADD COLUMN IF NOT EXISTS "remainingQty" DOUBLE PRECISION;

ALTER TABLE duplicatescanlogs ADD COLUMN IF NOT EXISTS "upiCode" TEXT;
ALTER TABLE duplicatescanlogs ADD COLUMN IF NOT EXISTS "movementType" TEXT;
ALTER TABLE duplicatescanlogs ADD COLUMN IF NOT EXISTS "existingStatus" TEXT;
ALTER TABLE duplicatescanlogs ADD COLUMN IF NOT EXISTS "duplicateCount" INTEGER DEFAULT 1;
ALTER TABLE duplicatescanlogs ADD COLUMN IF NOT EXISTS "lastDuplicateTime" TIMESTAMPTZ;

UPDATE inventories
SET
  "upiCode" = UPPER(COALESCE(NULLIF("upiCode", ''), NULLIF("upiNo", ''))),
  "movementType" = UPPER(COALESCE(NULLIF("movementType", ''), NULLIF("scanType", ''), NULLIF("type", ''), 'INWARD')),
  "remainingQty" = CASE
    WHEN UPPER(COALESCE(NULLIF("movementType", ''), NULLIF("scanType", ''), NULLIF("type", ''), 'INWARD')) = 'INWARD'
      THEN COALESCE(
        NULLIF("remainingQty", 0),
        CASE
          WHEN COALESCE("data"->>'qty', '') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN ("data"->>'qty')::double precision
          WHEN COALESCE("data"->>'quantity', '') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN ("data"->>'quantity')::double precision
          ELSE 1
        END
      )
    ELSE 0
  END;

WITH ranked_inventories AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE("dealerCode", ''), COALESCE("auditId", ''), UPPER(COALESCE(NULLIF("upiCode", ''), NULLIF("upiNo", '')))
      ORDER BY COALESCE("timestamp", "createdAt") DESC, "createdAt" DESC, "id" DESC
    ) AS rn
  FROM inventories
  WHERE COALESCE(NULLIF("upiCode", ''), NULLIF("upiNo", '')) IS NOT NULL
)
UPDATE inventories i
SET "activeInventory" = CASE
  WHEN r.rn = 1
    AND UPPER(COALESCE(i."movementType", i."scanType", i."type", '')) = 'INWARD'
    AND COALESCE(i."remainingQty", 0) > 0
  THEN TRUE
  ELSE FALSE
END
FROM ranked_inventories r
WHERE i."id" = r."id";

UPDATE scans
SET
  "upiCode" = UPPER(COALESCE(NULLIF("upiCode", ''), NULLIF("upiNo", ''))),
  "movementType" = UPPER(COALESCE(NULLIF("movementType", ''), NULLIF("scanType", ''), NULLIF("type", ''), 'INWARD')),
  "remainingQty" = CASE
    WHEN UPPER(COALESCE(NULLIF("movementType", ''), NULLIF("scanType", ''), NULLIF("type", ''), 'INWARD')) = 'INWARD'
      THEN COALESCE(
        NULLIF("remainingQty", 0),
        CASE
          WHEN COALESCE("data"->>'qty', '') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN ("data"->>'qty')::double precision
          WHEN COALESCE("data"->>'quantity', '') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN ("data"->>'quantity')::double precision
          ELSE 1
        END
      )
    ELSE 0
  END;

WITH ranked_scans AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE("dealerCode", ''), COALESCE("auditId", ''), UPPER(COALESCE(NULLIF("upiCode", ''), NULLIF("upiNo", '')))
      ORDER BY COALESCE("timestamp", "createdAt") DESC, "createdAt" DESC, "id" DESC
    ) AS rn
  FROM scans
  WHERE COALESCE(NULLIF("upiCode", ''), NULLIF("upiNo", '')) IS NOT NULL
)
UPDATE scans s
SET "activeInventory" = CASE
  WHEN r.rn = 1
    AND UPPER(COALESCE(s."movementType", s."scanType", s."type", '')) = 'INWARD'
    AND COALESCE(s."remainingQty", 0) > 0
  THEN TRUE
  ELSE FALSE
END
FROM ranked_scans r
WHERE s."id" = r."id";

UPDATE failedscans
SET
  "upiCode" = UPPER(COALESCE(NULLIF("upiCode", ''), NULLIF("upiNo", ''))),
  "movementType" = UPPER(COALESCE(NULLIF("movementType", ''), NULLIF("scanType", ''), NULLIF("type", ''), 'INWARD')),
  "activeInventory" = FALSE,
  "remainingQty" = 0;

UPDATE duplicatescanlogs
SET
  "upiCode" = UPPER(COALESCE(NULLIF("upiCode", ''), NULLIF("upiNo", ''))),
  "movementType" = UPPER(COALESCE(NULLIF("movementType", ''), NULLIF("scanType", ''), NULLIF("type", ''), 'INWARD')),
  "existingStatus" = COALESCE(NULLIF("existingStatus", ''), NULLIF("status", ''), NULLIF("scanStatus", ''), NULLIF("syncStatus", '')),
  "duplicateCount" = COALESCE("duplicateCount", 1),
  "lastDuplicateTime" = COALESCE("lastDuplicateTime", "timestamp", "createdAt");

ALTER TABLE inventories ALTER COLUMN "activeInventory" SET DEFAULT FALSE;
ALTER TABLE inventories ALTER COLUMN "remainingQty" SET DEFAULT 0;
ALTER TABLE scans ALTER COLUMN "activeInventory" SET DEFAULT FALSE;
ALTER TABLE scans ALTER COLUMN "remainingQty" SET DEFAULT 0;
ALTER TABLE failedscans ALTER COLUMN "activeInventory" SET DEFAULT FALSE;
ALTER TABLE failedscans ALTER COLUMN "remainingQty" SET DEFAULT 0;

DROP INDEX IF EXISTS global_upi_key_unique;
DROP INDEX IF EXISTS dealer_audit_upi_unique;

CREATE INDEX IF NOT EXISTS inventories_upi_code_idx
  ON inventories ("upiCode")
  WHERE "upiCode" IS NOT NULL AND "upiCode" <> '';

CREATE INDEX IF NOT EXISTS inventories_movement_type_idx
  ON inventories ("movementType")
  WHERE "movementType" IS NOT NULL AND "movementType" <> '';

CREATE INDEX IF NOT EXISTS inventories_active_inventory_idx
  ON inventories ("activeInventory")
  WHERE "activeInventory" = TRUE;

CREATE INDEX IF NOT EXISTS inventories_dealer_audit_upi_idx
  ON inventories ("dealerCode", "auditId", "upiCode")
  WHERE "dealerCode" IS NOT NULL
    AND "dealerCode" <> ''
    AND "auditId" IS NOT NULL
    AND "auditId" <> ''
    AND "upiCode" IS NOT NULL
    AND "upiCode" <> '';

CREATE INDEX IF NOT EXISTS inventories_dealer_audit_movement_idx
  ON inventories ("dealerCode", "auditId", "movementType")
  WHERE "dealerCode" IS NOT NULL
    AND "dealerCode" <> ''
    AND "auditId" IS NOT NULL
    AND "auditId" <> ''
    AND "movementType" IS NOT NULL
    AND "movementType" <> '';

CREATE INDEX IF NOT EXISTS inventories_dealer_audit_active_idx
  ON inventories ("dealerCode", "auditId", "activeInventory")
  WHERE "dealerCode" IS NOT NULL
    AND "dealerCode" <> ''
    AND "auditId" IS NOT NULL
    AND "auditId" <> ''
    AND "activeInventory" = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS inventories_active_inward_upi_unique
  ON inventories ("dealerCode", "auditId", "upiCode")
  WHERE "dealerCode" IS NOT NULL
    AND "dealerCode" <> ''
    AND "auditId" IS NOT NULL
    AND "auditId" <> ''
    AND "upiCode" IS NOT NULL
    AND "upiCode" <> ''
    AND "movementType" = 'INWARD'
    AND "activeInventory" = TRUE;

CREATE INDEX IF NOT EXISTS scans_upi_code_idx
  ON scans ("upiCode")
  WHERE "upiCode" IS NOT NULL AND "upiCode" <> '';

CREATE INDEX IF NOT EXISTS scans_movement_type_idx
  ON scans ("movementType")
  WHERE "movementType" IS NOT NULL AND "movementType" <> '';

CREATE INDEX IF NOT EXISTS scans_active_inventory_idx
  ON scans ("activeInventory")
  WHERE "activeInventory" = TRUE;

CREATE INDEX IF NOT EXISTS scans_dealer_audit_upi_idx
  ON scans ("dealerCode", "auditId", "upiCode")
  WHERE "dealerCode" IS NOT NULL
    AND "dealerCode" <> ''
    AND "auditId" IS NOT NULL
    AND "auditId" <> ''
    AND "upiCode" IS NOT NULL
    AND "upiCode" <> '';

CREATE INDEX IF NOT EXISTS scans_dealer_audit_movement_idx
  ON scans ("dealerCode", "auditId", "movementType")
  WHERE "dealerCode" IS NOT NULL
    AND "dealerCode" <> ''
    AND "auditId" IS NOT NULL
    AND "auditId" <> ''
    AND "movementType" IS NOT NULL
    AND "movementType" <> '';

CREATE INDEX IF NOT EXISTS scans_dealer_audit_active_idx
  ON scans ("dealerCode", "auditId", "activeInventory")
  WHERE "dealerCode" IS NOT NULL
    AND "dealerCode" <> ''
    AND "auditId" IS NOT NULL
    AND "auditId" <> ''
    AND "activeInventory" = TRUE;

CREATE INDEX IF NOT EXISTS duplicatescanlogs_dealer_audit_time_idx
  ON duplicatescanlogs ("dealerCode", "auditId", "timestamp" DESC)
  WHERE "dealerCode" IS NOT NULL AND "dealerCode" <> '';

CREATE INDEX IF NOT EXISTS duplicatescanlogs_upi_code_idx
  ON duplicatescanlogs ("upiCode")
  WHERE "upiCode" IS NOT NULL AND "upiCode" <> '';

CREATE INDEX IF NOT EXISTS duplicatescanlogs_movement_type_idx
  ON duplicatescanlogs ("movementType")
  WHERE "movementType" IS NOT NULL AND "movementType" <> '';

CREATE INDEX IF NOT EXISTS duplicatescanlogs_scan_status_idx
  ON duplicatescanlogs ("scanStatus")
  WHERE "scanStatus" IS NOT NULL AND "scanStatus" <> '';
