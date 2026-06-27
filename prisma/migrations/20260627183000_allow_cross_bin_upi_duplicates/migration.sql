-- Cross-bin part placement is valid business behavior. UPI/raw scan values remain
-- searchable, but must not be the database uniqueness rule for inventory rows.
DROP INDEX IF EXISTS inventories_active_inward_upi_unique;
DROP INDEX IF EXISTS dealer_audit_upi_unique;
DROP INDEX IF EXISTS global_upi_key_unique;
DROP INDEX IF EXISTS scans_active_inward_upi_unique;

CREATE INDEX IF NOT EXISTS inventories_active_inward_upi_bin_lookup_idx
  ON inventories ("dealerCode", "auditId", "upiCode", "binLocation", "movementType", "activeInventory")
  WHERE "dealerCode" IS NOT NULL
    AND "dealerCode" <> ''
    AND "auditId" IS NOT NULL
    AND "auditId" <> ''
    AND "upiCode" IS NOT NULL
    AND "upiCode" <> ''
    AND "binLocation" IS NOT NULL
    AND "binLocation" <> ''
    AND "movementType" = 'INWARD'
    AND "activeInventory" = TRUE;

CREATE INDEX IF NOT EXISTS inventories_global_upi_key_lookup_idx
  ON inventories ("globalUpiKey")
  WHERE "globalUpiKey" IS NOT NULL
    AND "globalUpiKey" <> '';

CREATE INDEX IF NOT EXISTS scans_active_inward_upi_bin_lookup_idx
  ON scans ("dealerCode", "auditId", "upiCode", "binLocation", "movementType", "activeInventory")
  WHERE "dealerCode" IS NOT NULL
    AND "dealerCode" <> ''
    AND "auditId" IS NOT NULL
    AND "auditId" <> ''
    AND "upiCode" IS NOT NULL
    AND "upiCode" <> ''
    AND "binLocation" IS NOT NULL
    AND "binLocation" <> ''
    AND "movementType" = 'INWARD'
    AND "activeInventory" = TRUE;
