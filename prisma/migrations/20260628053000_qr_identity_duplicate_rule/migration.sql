-- Duplicate prevention is dealer + exact QR/UPI identity.
-- Part number and bin placement must never be database uniqueness rules.
DROP INDEX IF EXISTS inventories_active_inward_upi_unique;
DROP INDEX IF EXISTS scans_active_inward_upi_unique;
DROP INDEX IF EXISTS dealer_audit_upi_unique;
DROP INDEX IF EXISTS global_upi_key_unique;

DO $$
DECLARE
  idx RECORD;
BEGIN
  FOR idx IN
    SELECT schemaname, indexname
    FROM pg_indexes
    WHERE tablename IN ('inventories', 'scans')
      AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
      AND indexdef ILIKE '%"dealerCode"%'
      AND indexdef ILIKE '%"auditId"%'
      AND indexdef ILIKE '%"upiCode"%'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I.%I', idx.schemaname, idx.indexname);
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS inventories_dealer_global_upi_lookup_idx
  ON inventories ("dealerCode", "globalUpiKey")
  WHERE "dealerCode" IS NOT NULL
    AND "dealerCode" <> ''
    AND "globalUpiKey" IS NOT NULL
    AND "globalUpiKey" <> '';

CREATE INDEX IF NOT EXISTS inventories_dealer_upi_code_lookup_idx
  ON inventories ("dealerCode", "upiCode")
  WHERE "dealerCode" IS NOT NULL
    AND "dealerCode" <> ''
    AND "upiCode" IS NOT NULL
    AND "upiCode" <> '';

CREATE INDEX IF NOT EXISTS scans_dealer_global_upi_lookup_idx
  ON scans ("dealerCode", "globalUpiKey")
  WHERE "dealerCode" IS NOT NULL
    AND "dealerCode" <> ''
    AND "globalUpiKey" IS NOT NULL
    AND "globalUpiKey" <> '';
