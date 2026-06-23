-- Smart Bin Location Suggestion indexes
CREATE INDEX IF NOT EXISTS "inventory_dealer_audit_part_bin_idx"
  ON "inventories" ("dealerCode", "auditId", "partNumber", "binLocation");

CREATE INDEX IF NOT EXISTS "scan_dealer_audit_part_bin_idx"
  ON "scans" ("dealerCode", "auditId", "partNumber", "binLocation");
