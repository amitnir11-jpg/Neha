-- Keep duplicate protection for active scans while allowing archived scans to
-- be rescanned and allowing the same barcode in a separate dealer/audit.
DROP INDEX IF EXISTS inventories_qr_fingerprint_unique;
CREATE UNIQUE INDEX IF NOT EXISTS inventories_qr_fingerprint_active_unique
  ON inventories ("dealerCode", "auditId", "qrFingerprint")
  WHERE "qrFingerprint" IS NOT NULL
    AND "qrFingerprint" <> ''
    AND "isDeleted" = false
    AND "deletedAt" IS NULL;

-- globalUpiKey is also a derived barcode identity. Scope its database guard in
-- the same way for lookups. Existing production data can legitimately contain
-- multiple active transactions sharing this derived key, so it is not unique.
DROP INDEX IF EXISTS global_upi_key_unique;
DROP INDEX IF EXISTS global_upi_key_active_unique;
CREATE INDEX IF NOT EXISTS inventories_global_upi_key_scope_idx
  ON inventories ("dealerCode", "auditId", "globalUpiKey")
  WHERE "globalUpiKey" IS NOT NULL
    AND "globalUpiKey" <> ''
    AND "dealerCode" IS NOT NULL
    AND "auditId" IS NOT NULL
    AND "isDeleted" = false
    AND "deletedAt" IS NULL;

-- Normalize existing values; Prisma's inventory writer canonicalizes new rows.
UPDATE inventories
SET "scanType" = UPPER(BTRIM("scanType")),
    "movementType" = UPPER(BTRIM("movementType")),
    "type" = UPPER(BTRIM("type"))
WHERE "scanType" IS NOT NULL OR "movementType" IS NOT NULL OR "type" IS NOT NULL;

DROP TRIGGER IF EXISTS inventories_normalize_scan_types ON inventories;
