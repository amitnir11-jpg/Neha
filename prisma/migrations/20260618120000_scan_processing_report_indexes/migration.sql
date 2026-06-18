CREATE INDEX IF NOT EXISTS inventories_dealer_idx
  ON inventories ("dealerCode")
  WHERE "dealerCode" IS NOT NULL AND "dealerCode" <> '';

CREATE INDEX IF NOT EXISTS inventories_part_idx
  ON inventories ("partNumber")
  WHERE "partNumber" IS NOT NULL AND "partNumber" <> '';

CREATE INDEX IF NOT EXISTS inventories_norm_part_idx
  ON inventories ("normalizedPartNumber")
  WHERE "normalizedPartNumber" IS NOT NULL AND "normalizedPartNumber" <> '';

CREATE INDEX IF NOT EXISTS inventories_upi_idx
  ON inventories ("upiNo")
  WHERE "upiNo" IS NOT NULL AND "upiNo" <> '';

CREATE INDEX IF NOT EXISTS inventories_bin_location_idx
  ON inventories ("binLocation")
  WHERE "binLocation" IS NOT NULL AND "binLocation" <> '';

CREATE INDEX IF NOT EXISTS inventories_scan_status_idx
  ON inventories ("scanStatus")
  WHERE "scanStatus" IS NOT NULL AND "scanStatus" <> '';

CREATE INDEX IF NOT EXISTS inventories_created_at_idx
  ON inventories ("createdAt" DESC);

CREATE INDEX IF NOT EXISTS inventories_dealer_part_idx
  ON inventories ("dealerCode", "partNumber")
  WHERE "dealerCode" IS NOT NULL AND "dealerCode" <> '' AND "partNumber" IS NOT NULL AND "partNumber" <> '';

CREATE INDEX IF NOT EXISTS inventories_dealer_upi_idx
  ON inventories ("dealerCode", "upiNo")
  WHERE "dealerCode" IS NOT NULL AND "dealerCode" <> '' AND "upiNo" IS NOT NULL AND "upiNo" <> '';

CREATE INDEX IF NOT EXISTS inventories_dealer_bin_idx
  ON inventories ("dealerCode", "binLocation")
  WHERE "dealerCode" IS NOT NULL AND "dealerCode" <> '' AND "binLocation" IS NOT NULL AND "binLocation" <> '';

CREATE INDEX IF NOT EXISTS inventories_dealer_status_created_idx
  ON inventories ("dealerCode", "scanStatus", "createdAt" DESC)
  WHERE "dealerCode" IS NOT NULL AND "dealerCode" <> '';

CREATE INDEX IF NOT EXISTS inventories_barcode_data_idx
  ON inventories ((COALESCE("data"->>'rawBarcode', "data"->>'barcode', "data"->>'rawScanString', "data"->>'rawScan', '')));

CREATE INDEX IF NOT EXISTS inventories_category_data_idx
  ON inventories ((COALESCE("data"->>'category', "data"->>'productCategory', '')));

CREATE INDEX IF NOT EXISTS inventories_product_group_data_idx
  ON inventories (("data"->>'productGroup'));

CREATE INDEX IF NOT EXISTS mastercatalogues_dealer_idx
  ON mastercatalogues ("dealerCode")
  WHERE "dealerCode" IS NOT NULL AND "dealerCode" <> '';

CREATE INDEX IF NOT EXISTS mastercatalogues_part_lookup_idx
  ON mastercatalogues ("normalizedPartNumber", "partNumber");

CREATE INDEX IF NOT EXISTS mastercatalogues_part_no_data_idx
  ON mastercatalogues ((COALESCE("data"->>'partNo', "data"->>'part', "data"->>'sku', "data"->>'itemCode', '')));

CREATE INDEX IF NOT EXISTS masterparts_dealer_part_lookup_idx
  ON masterparts ("dealerCode", "normalizedPartNumber", "partNumber");

CREATE INDEX IF NOT EXISTS masterparts_part_no_data_idx
  ON masterparts ((COALESCE("data"->>'partNo', "data"->>'part', "data"->>'sku', "data"->>'itemCode', '')));
