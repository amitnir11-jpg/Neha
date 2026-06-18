CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION daksh_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW."updatedAt" = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  table_name text;
  tables text[] := ARRAY[
    'audits',
    'auditlogs',
    'auditrestorelogs',
    'bins',
    'binlabelprintlogs',
    'bintransferhistories',
    'bluetoothdevices',
    'bluetoothscanlogs',
    'dealers',
    'dealer_stock_master',
    'deletedscanlogs',
    'devices',
    'duplicatescanlogs',
    'failedscans',
    'inventories',
    'mastercatalogues',
    'masterparts',
    'offlinequeues',
    'partpricehistories',
    'rejectedscans',
    'reportfiltersettings',
    'reportsnapshots',
    'scans',
    'scannerlogs',
    'scannersessions',
    'settings',
    'skewevents',
    'synclogs',
    'users',
    'userdealermappings',
    'verificationlogs'
  ];
BEGIN
  FOREACH table_name IN ARRAY tables LOOP
    EXECUTE format($sql$
      CREATE TABLE IF NOT EXISTS %I (
        "id" TEXT PRIMARY KEY,
        "data" JSONB NOT NULL DEFAULT '{}'::jsonb,
        "dealerCode" TEXT,
        "auditId" TEXT,
        "partNumber" TEXT,
        "normalizedPartNumber" TEXT,
        "uniqueScanId" TEXT,
        "scanId" TEXT,
        "globalUpiKey" TEXT,
        "qrFingerprint" TEXT,
        "upiNo" TEXT,
        "rawUpiHash" TEXT,
        "bin" TEXT,
        "binLocation" TEXT,
        "scanType" TEXT,
        "type" TEXT,
        "syncStatus" TEXT,
        "scanStatus" TEXT,
        "status" TEXT,
        "source" TEXT,
        "userId" TEXT,
        "loginId" TEXT,
        "username" TEXT,
        "email" TEXT,
        "deviceId" TEXT,
        "key" TEXT,
        "reportName" TEXT,
        "currentAuditId" TEXT,
        "timestamp" TIMESTAMPTZ,
        "scanTime" TIMESTAMPTZ,
        "time" TIMESTAMPTZ,
        "dateTime" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    $sql$, table_name);

    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'daksh_touch_updated_at', table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION daksh_touch_updated_at()', 'daksh_touch_updated_at', table_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I USING GIN ("data")', left(table_name || '_data_gin_idx', 63), table_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I ("createdAt" DESC)', left(table_name || '_created_idx', 63), table_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I ("updatedAt" DESC)', left(table_name || '_updated_idx', 63), table_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I ("dealerCode") WHERE "dealerCode" IS NOT NULL AND "dealerCode" <> ''''', left(table_name || '_dealer_idx', 63), table_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I ("auditId") WHERE "auditId" IS NOT NULL AND "auditId" <> ''''', left(table_name || '_audit_idx', 63), table_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I ("partNumber") WHERE "partNumber" IS NOT NULL AND "partNumber" <> ''''', left(table_name || '_part_idx', 63), table_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I ("normalizedPartNumber") WHERE "normalizedPartNumber" IS NOT NULL AND "normalizedPartNumber" <> ''''', left(table_name || '_norm_part_idx', 63), table_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I ("status") WHERE "status" IS NOT NULL AND "status" <> ''''', left(table_name || '_status_idx', 63), table_name);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS dealers_dealer_code_unique
  ON dealers ("dealerCode")
  WHERE "dealerCode" IS NOT NULL AND "dealerCode" <> '';

CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique
  ON users ("username")
  WHERE "username" IS NOT NULL AND "username" <> '';

CREATE INDEX IF NOT EXISTS users_email_lookup
  ON users ("email")
  WHERE "email" IS NOT NULL AND "email" <> '';

CREATE UNIQUE INDEX IF NOT EXISTS settings_key_unique
  ON settings ("key")
  WHERE "key" IS NOT NULL AND "key" <> '';

CREATE UNIQUE INDEX IF NOT EXISTS devices_device_id_unique
  ON devices ("deviceId")
  WHERE "deviceId" IS NOT NULL AND "deviceId" <> '';

CREATE UNIQUE INDEX IF NOT EXISTS bluetoothdevices_device_id_unique
  ON bluetoothdevices ("deviceId")
  WHERE "deviceId" IS NOT NULL AND "deviceId" <> '';

CREATE UNIQUE INDEX IF NOT EXISTS mastercatalogues_norm_part_unique
  ON mastercatalogues ("normalizedPartNumber")
  WHERE "normalizedPartNumber" IS NOT NULL AND "normalizedPartNumber" <> '';

CREATE INDEX IF NOT EXISTS mastercatalogues_search_trgm
  ON mastercatalogues USING GIN (
    (
      coalesce("partNumber", '') || ' ' ||
      coalesce("normalizedPartNumber", '') || ' ' ||
      coalesce("data"->>'partDescription', '') || ' ' ||
      coalesce("data"->>'productCategory', '') || ' ' ||
      coalesce("data"->>'productGroup', '') || ' ' ||
      coalesce("data"->>'model', '')
    ) gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS masterparts_search_trgm
  ON masterparts USING GIN (
    (
      coalesce("partNumber", '') || ' ' ||
      coalesce("normalizedPartNumber", '') || ' ' ||
      coalesce("data"->>'partNo', '') || ' ' ||
      coalesce("data"->>'partDescription', '') || ' ' ||
      coalesce("data"->>'productCategory', '') || ' ' ||
      coalesce("data"->>'productGroup', '')
    ) gin_trgm_ops
  );

CREATE UNIQUE INDEX IF NOT EXISTS inventories_unique_scan_id_unique
  ON inventories ("uniqueScanId")
  WHERE "uniqueScanId" IS NOT NULL AND "uniqueScanId" <> '';

CREATE UNIQUE INDEX IF NOT EXISTS inventories_scan_id_unique
  ON inventories ("scanId")
  WHERE "scanId" IS NOT NULL AND "scanId" <> '';

CREATE UNIQUE INDEX IF NOT EXISTS inventories_qr_fingerprint_unique
  ON inventories ("qrFingerprint")
  WHERE "qrFingerprint" IS NOT NULL AND "qrFingerprint" <> '';

CREATE UNIQUE INDEX IF NOT EXISTS global_upi_key_unique
  ON inventories ("globalUpiKey")
  WHERE "globalUpiKey" IS NOT NULL AND "globalUpiKey" <> '';

CREATE UNIQUE INDEX IF NOT EXISTS dealer_audit_upi_unique
  ON inventories ("dealerCode", "auditId", "upiNo")
  WHERE "dealerCode" IS NOT NULL
    AND "dealerCode" <> ''
    AND "auditId" IS NOT NULL
    AND "auditId" <> ''
    AND "upiNo" IS NOT NULL
    AND "upiNo" <> ''
    AND "scanStatus" IN ('ACCEPTED', 'SUPERVISOR_APPROVED', 'OUTWARD_DONE')
    AND "syncStatus" = 'synced';

CREATE INDEX IF NOT EXISTS inventories_scan_history_idx
  ON inventories ("dealerCode", "auditId", "timestamp" DESC, "createdAt" DESC);

CREATE INDEX IF NOT EXISTS inventories_report_part_idx
  ON inventories ("dealerCode", "auditId", "normalizedPartNumber", "scanType", "timestamp" DESC);

CREATE INDEX IF NOT EXISTS inventories_report_bin_idx
  ON inventories ("dealerCode", "auditId", "scanType", "binLocation", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS inventories_sync_status_idx
  ON inventories ("dealerCode", "auditId", "syncStatus", "timestamp" DESC);

CREATE INDEX IF NOT EXISTS inventories_user_scan_idx
  ON inventories ("dealerCode", "auditId", "userId", "scanType", "timestamp" DESC);

CREATE INDEX IF NOT EXISTS inventories_login_scan_idx
  ON inventories ("dealerCode", "auditId", "loginId", "scanType", "timestamp" DESC);

CREATE INDEX IF NOT EXISTS duplicate_scan_report_idx
  ON duplicatescanlogs ("dealerCode", "auditId", "timestamp" DESC);

CREATE INDEX IF NOT EXISTS verification_log_report_idx
  ON verificationlogs ("dealerCode", "auditId", "time" DESC);

CREATE INDEX IF NOT EXISTS deleted_scan_report_idx
  ON deletedscanlogs ("dealerCode", "auditId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS bin_transfer_history_idx
  ON bintransferhistories ("dealerCode", "partNumber", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS dealer_stock_lookup_idx
  ON dealer_stock_master ("dealerCode", "auditId", "normalizedPartNumber");
