-- Permanent dealer cleanup support. No dealer data is changed by this migration.
ALTER TABLE dealers
  ADD COLUMN IF NOT EXISTS "cleanupStatus" TEXT;

CREATE TABLE IF NOT EXISTS deleteddealers (
  id TEXT PRIMARY KEY,
  "targetDealerId" TEXT NOT NULL,
  "targetDealerCode" TEXT NOT NULL UNIQUE,
  "targetDealerName" TEXT,
  "deleteJobId" TEXT NOT NULL UNIQUE,
  "deletedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS deleteddealers_target_dealer_id_idx
  ON deleteddealers ("targetDealerId");

CREATE TABLE IF NOT EXISTS permanentdealercleanupaudits (
  id TEXT PRIMARY KEY,
  "jobId" TEXT NOT NULL UNIQUE,
  "targetDealerId" TEXT NOT NULL,
  "targetDealerCode" TEXT NOT NULL,
  "targetDealerName" TEXT NOT NULL,
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "actorUsername" TEXT NOT NULL,
  "actorName" TEXT NOT NULL,
  "actorRole" TEXT NOT NULL,
  "backupReference" TEXT NOT NULL,
  "backupRestoreTested" BOOLEAN NOT NULL,
  "requestIp" TEXT NOT NULL,
  "recordCounts" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "errorMessage" TEXT,
  "startedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "completedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS permanentdealercleanupaudits_target_started_idx
  ON permanentdealercleanupaudits ("targetDealerId", "startedAt");
CREATE INDEX IF NOT EXISTS permanentdealercleanupaudits_status_started_idx
  ON permanentdealercleanupaudits (status, "startedAt");

CREATE OR REPLACE FUNCTION dealer_cleanup_json_access_has(access_data JSONB, requested_code TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  dealer_access JSONB;
  access_text TEXT;
BEGIN
  dealer_access := COALESCE(access_data->'dealerAccess', access_data->'data'->'dealerAccess');
  IF jsonb_typeof(dealer_access) = 'array' THEN
    RETURN dealer_access ? requested_code;
  END IF;
  IF jsonb_typeof(dealer_access) = 'string' THEN
    access_text := upper(dealer_access #>> '{}');
    RETURN requested_code = ANY(regexp_split_to_array(access_text, '[,;[:space:]]+'));
  END IF;
  RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION guard_dealer_cleanup_writes()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  row_json JSONB;
  row_dealer_code TEXT;
  locked_code TEXT;
  locked_status TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_json := to_jsonb(OLD);
  ELSE
    row_json := to_jsonb(NEW);
  END IF;
  row_dealer_code := upper(COALESCE(row_json->>'dealerCode', row_json->'data'->>'dealerCode', ''));
  IF TG_TABLE_NAME = 'userdealermappings' THEN
    row_dealer_code := upper(COALESCE(NULLIF(row_dealer_code, ''), row_json->'data'->>'dealerId', ''));
  END IF;

  IF row_dealer_code <> '' THEN
    IF EXISTS (SELECT 1 FROM deleteddealers d WHERE d."targetDealerCode" = row_dealer_code) THEN
      RAISE EXCEPTION 'Dealer % has been permanently deleted; delayed sync is blocked', row_dealer_code
        USING ERRCODE = '23514';
    END IF;
    SELECT d."cleanupStatus" INTO locked_status
      FROM dealers d
      WHERE upper(d."dealerCode") = row_dealer_code
      FOR SHARE;
    IF locked_status = 'DELETING'
      AND NOT (TG_OP = 'DELETE' AND current_setting('app.dealer_cleanup_code', true) = row_dealer_code) THEN
      RAISE EXCEPTION 'Dealer % is locked for permanent cleanup', row_dealer_code
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- User records can belong to several dealers. Reject new assignments to a
  -- locked/deleted dealer, while permitting cleanup to remove that assignment.
  IF TG_TABLE_NAME = 'users' THEN
    SELECT d."targetDealerCode" INTO locked_code
      FROM deleteddealers d
      WHERE dealer_cleanup_json_access_has(row_json, d."targetDealerCode")
      LIMIT 1;
    IF locked_code IS NOT NULL THEN
      RAISE EXCEPTION 'Dealer % has been permanently deleted; user access is blocked', locked_code
        USING ERRCODE = '23514';
    END IF;
    SELECT d."dealerCode" INTO locked_code
      FROM dealers d
      WHERE d."cleanupStatus" = 'DELETING'
        AND dealer_cleanup_json_access_has(row_json, upper(d."dealerCode"))
      LIMIT 1;
    IF locked_code IS NOT NULL THEN
      RAISE EXCEPTION 'Dealer % is locked for permanent cleanup; user access is blocked', locked_code
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- Each write obtains a shared lock on the selected dealer row. Setting its
-- cleanupStatus obtains a conflicting lock and therefore drains in-flight
-- writes before the cleanup lock becomes visible.
DO $$
DECLARE
  table_row RECORD;
BEGIN
  FOR table_row IN
    SELECT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = current_schema()
      AND c.column_name = 'dealerCode'
      AND c.table_name NOT IN ('dealers', 'deleteddealers', 'permanentdealercleanupaudits')
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS dealer_cleanup_write_guard ON %I', table_row.table_name);
    EXECUTE format(
      'CREATE TRIGGER dealer_cleanup_write_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_dealer_cleanup_writes()',
      table_row.table_name
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION prevent_deleted_dealer_recreation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM deleteddealers d
    WHERE d."targetDealerCode" = upper(NEW."dealerCode")
  ) THEN
    RAISE EXCEPTION 'Dealer code % is permanently retired', NEW."dealerCode"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_deleted_dealer_recreation ON dealers;
CREATE TRIGGER prevent_deleted_dealer_recreation
  BEFORE INSERT OR UPDATE OF "dealerCode" ON dealers
  FOR EACH ROW EXECUTE FUNCTION prevent_deleted_dealer_recreation();
