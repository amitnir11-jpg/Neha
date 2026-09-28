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
-- the same way so it cannot reintroduce the cross-audit restriction.
DROP INDEX IF EXISTS global_upi_key_unique;
CREATE UNIQUE INDEX IF NOT EXISTS global_upi_key_active_unique
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
