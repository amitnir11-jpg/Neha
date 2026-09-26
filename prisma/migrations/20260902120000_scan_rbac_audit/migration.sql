-- RBAC scan immutability fields. Scan rows remain physically present after deletion.
ALTER TABLE inventories ADD COLUMN IF NOT EXISTS "isDeleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE inventories ADD COLUMN IF NOT EXISTS "deletedBy" TEXT;
ALTER TABLE inventories ADD COLUMN IF NOT EXISTS "deletedByUsername" TEXT;
ALTER TABLE inventories ADD COLUMN IF NOT EXISTS "deletedByName" TEXT;
ALTER TABLE inventories ADD COLUMN IF NOT EXISTS "deletedByRole" TEXT;
ALTER TABLE inventories ADD COLUMN IF NOT EXISTS "deleteReason" TEXT;
ALTER TABLE inventories ADD COLUMN IF NOT EXISTS "preDeleteStatus" TEXT;
ALTER TABLE inventories ADD COLUMN IF NOT EXISTS "preDeleteScanStatus" TEXT;
ALTER TABLE inventories ADD COLUMN IF NOT EXISTS "preDeleteSyncStatus" TEXT;
ALTER TABLE inventories ADD COLUMN IF NOT EXISTS "lastModifiedBy" TEXT;
ALTER TABLE inventories ADD COLUMN IF NOT EXISTS "lastModifiedByUsername" TEXT;
ALTER TABLE inventories ADD COLUMN IF NOT EXISTS "lastModifiedByName" TEXT;
ALTER TABLE inventories ADD COLUMN IF NOT EXISTS "lastModifiedByRole" TEXT;
ALTER TABLE inventories ADD COLUMN IF NOT EXISTS "lastModifiedAt" TIMESTAMPTZ;
ALTER TABLE inventories ADD COLUMN IF NOT EXISTS "createdBy" TEXT;
ALTER TABLE inventories ADD COLUMN IF NOT EXISTS "createdByUsername" TEXT;
ALTER TABLE inventories ADD COLUMN IF NOT EXISTS "createdByName" TEXT;
ALTER TABLE inventories ADD COLUMN IF NOT EXISTS "createdByRole" TEXT;
ALTER TABLE inventories ADD COLUMN IF NOT EXISTS "restoredAt" TIMESTAMPTZ;
ALTER TABLE inventories ADD COLUMN IF NOT EXISTS "restoredBy" TEXT;

ALTER TABLE scans ADD COLUMN IF NOT EXISTS "isDeleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS "deletedBy" TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS "deletedByUsername" TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS "deletedByName" TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS "deletedByRole" TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS "deleteReason" TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS "preDeleteStatus" TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS "preDeleteScanStatus" TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS "preDeleteSyncStatus" TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS "lastModifiedBy" TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS "lastModifiedByUsername" TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS "lastModifiedByName" TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS "lastModifiedByRole" TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS "lastModifiedAt" TIMESTAMPTZ;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS "createdBy" TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS "createdByUsername" TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS "createdByName" TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS "createdByRole" TEXT;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS "restoredAt" TIMESTAMPTZ;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS "restoredBy" TEXT;

CREATE INDEX IF NOT EXISTS inventories_is_deleted_idx ON inventories ("isDeleted");
CREATE INDEX IF NOT EXISTS scans_is_deleted_idx ON scans ("isDeleted");

CREATE TABLE IF NOT EXISTS scanauditlogs (
  "id" TEXT NOT NULL,
  "data" JSONB NOT NULL DEFAULT '{}',
  "action" TEXT NOT NULL,
  "scanId" TEXT,
  "dealerCode" TEXT,
  "dealerName" TEXT,
  "partNumber" TEXT,
  "performedByUserId" TEXT,
  "performedByUsername" TEXT,
  "performedByName" TEXT,
  "performedByRole" TEXT,
  "reason" TEXT NOT NULL,
  "remarks" TEXT,
  "oldData" JSONB,
  "newData" JSONB,
  "timestamp" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ipAddress" TEXT,
  "deviceId" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT scanauditlogs_pkey PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS scanauditlogs_action_idx ON scanauditlogs ("action");
CREATE INDEX IF NOT EXISTS scanauditlogs_scan_id_idx ON scanauditlogs ("scanId");
CREATE INDEX IF NOT EXISTS scanauditlogs_dealer_code_idx ON scanauditlogs ("dealerCode");
CREATE INDEX IF NOT EXISTS scanauditlogs_part_number_idx ON scanauditlogs ("partNumber");
CREATE INDEX IF NOT EXISTS scanauditlogs_username_idx ON scanauditlogs ("performedByUsername");
CREATE INDEX IF NOT EXISTS scanauditlogs_timestamp_idx ON scanauditlogs ("timestamp");

-- Canonicalize legacy roles in the JSON-backed user records.
UPDATE users
SET "data" = jsonb_set(
  COALESCE("data", '{}'::jsonb),
  '{role}',
  to_jsonb(CASE lower(COALESCE("data"->>'role', ''))
    WHEN 'admin' THEN 'admin'
    WHEN 'mobile_user' THEN 'mobile_user'
    ELSE 'audit_user'
  END),
  true
)
WHERE lower(COALESCE("data"->>'role', '')) NOT IN ('admin', 'audit_user', 'mobile_user');
