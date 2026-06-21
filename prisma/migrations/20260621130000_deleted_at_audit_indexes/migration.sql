ALTER TABLE inventories ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMPTZ;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS inventories_audit_id_idx
  ON inventories ("auditId")
  WHERE "auditId" IS NOT NULL AND "auditId" <> '';

CREATE INDEX IF NOT EXISTS scans_audit_id_idx
  ON scans ("auditId")
  WHERE "auditId" IS NOT NULL AND "auditId" <> '';

CREATE INDEX IF NOT EXISTS inventories_deleted_at_idx
  ON inventories ("deletedAt")
  WHERE "deletedAt" IS NOT NULL;

CREATE INDEX IF NOT EXISTS scans_deleted_at_idx
  ON scans ("deletedAt")
  WHERE "deletedAt" IS NOT NULL;
