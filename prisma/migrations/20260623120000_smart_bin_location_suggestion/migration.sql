-- Smart Bin Location Suggestion indexes
CREATE INDEX IF NOT EXISTS "inventory_dealer_audit_part_bin_idx"
  ON "inventories" ("dealerCode", "auditId", "partNumber", "binLocation");

CREATE INDEX IF NOT EXISTS "scan_dealer_audit_part_bin_idx"
  ON "scans" ("dealerCode", "auditId", "partNumber", "binLocation");

CREATE TABLE IF NOT EXISTS "part_bin_locations" (
  "id" TEXT PRIMARY KEY,
  "data" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "dealerCode" TEXT NOT NULL,
  "auditId" TEXT NOT NULL,
  "partNumber" TEXT NOT NULL,
  "normalizedPartNumber" TEXT NOT NULL,
  "binLocation" TEXT NOT NULL,
  "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "locationType" TEXT NOT NULL DEFAULT 'SECONDARY',
  "createdBy" TEXT,
  "createdDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reason" TEXT,
  "lastScanDate" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS "part_bin_locations_touch_updated_at" ON "part_bin_locations";
CREATE TRIGGER "part_bin_locations_touch_updated_at"
BEFORE UPDATE ON "part_bin_locations"
FOR EACH ROW
EXECUTE FUNCTION daksh_touch_updated_at();

CREATE INDEX IF NOT EXISTS "part_bin_locations_dealer_idx"
  ON "part_bin_locations" ("dealerCode");

CREATE INDEX IF NOT EXISTS "part_bin_locations_audit_idx"
  ON "part_bin_locations" ("auditId");

CREATE INDEX IF NOT EXISTS "part_bin_locations_part_idx"
  ON "part_bin_locations" ("partNumber");

CREATE INDEX IF NOT EXISTS "part_bin_locations_normalized_part_idx"
  ON "part_bin_locations" ("normalizedPartNumber");

CREATE INDEX IF NOT EXISTS "part_bin_locations_bin_idx"
  ON "part_bin_locations" ("binLocation");

CREATE INDEX IF NOT EXISTS "part_bin_locations_location_type_idx"
  ON "part_bin_locations" ("locationType");

CREATE INDEX IF NOT EXISTS "part_bin_locations_dealer_audit_part_idx"
  ON "part_bin_locations" ("dealerCode", "auditId", "normalizedPartNumber");

CREATE UNIQUE INDEX IF NOT EXISTS "part_bin_locations_unique_part_bin"
  ON "part_bin_locations" ("dealerCode", "auditId", "normalizedPartNumber", "binLocation");
