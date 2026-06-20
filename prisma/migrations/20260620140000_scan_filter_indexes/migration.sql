CREATE INDEX IF NOT EXISTS scans_dealer_idx
  ON scans ("dealerCode")
  WHERE "dealerCode" IS NOT NULL AND "dealerCode" <> '';

CREATE INDEX IF NOT EXISTS scans_part_idx
  ON scans ("partNumber")
  WHERE "partNumber" IS NOT NULL AND "partNumber" <> '';

CREATE INDEX IF NOT EXISTS scans_norm_part_idx
  ON scans ("normalizedPartNumber")
  WHERE "normalizedPartNumber" IS NOT NULL AND "normalizedPartNumber" <> '';

CREATE INDEX IF NOT EXISTS scans_upi_idx
  ON scans ("upiNo")
  WHERE "upiNo" IS NOT NULL AND "upiNo" <> '';

CREATE INDEX IF NOT EXISTS scans_bin_location_idx
  ON scans ("binLocation")
  WHERE "binLocation" IS NOT NULL AND "binLocation" <> '';

CREATE INDEX IF NOT EXISTS scans_scan_type_idx
  ON scans ("scanType")
  WHERE "scanType" IS NOT NULL AND "scanType" <> '';

CREATE INDEX IF NOT EXISTS scans_scan_status_idx
  ON scans ("scanStatus")
  WHERE "scanStatus" IS NOT NULL AND "scanStatus" <> '';

CREATE INDEX IF NOT EXISTS scans_status_idx
  ON scans ("status")
  WHERE "status" IS NOT NULL AND "status" <> '';

CREATE INDEX IF NOT EXISTS scans_created_at_idx
  ON scans ("createdAt" DESC);

CREATE INDEX IF NOT EXISTS scans_dealer_part_idx
  ON scans ("dealerCode", "partNumber")
  WHERE "dealerCode" IS NOT NULL AND "dealerCode" <> '' AND "partNumber" IS NOT NULL AND "partNumber" <> '';

CREATE INDEX IF NOT EXISTS scans_dealer_scan_type_created_idx
  ON scans ("dealerCode", "scanType", "createdAt" DESC)
  WHERE "dealerCode" IS NOT NULL AND "dealerCode" <> '' AND "scanType" IS NOT NULL AND "scanType" <> '';

CREATE INDEX IF NOT EXISTS scans_dealer_scan_status_created_idx
  ON scans ("dealerCode", "scanStatus", "createdAt" DESC)
  WHERE "dealerCode" IS NOT NULL AND "dealerCode" <> '' AND "scanStatus" IS NOT NULL AND "scanStatus" <> '';
