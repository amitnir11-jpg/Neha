-- Additive only: source inventories, quantities and historical prices are untouched.
CREATE TABLE valuation_changes (
  id BIGSERIAL PRIMARY KEY, dealer_code TEXT NOT NULL DEFAULT '', audit_id TEXT NOT NULL DEFAULT '',
  part_number TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX valuation_changes_scope ON valuation_changes(dealer_code,audit_id,id);
CREATE INDEX valuation_changes_price ON valuation_changes(part_number,id) WHERE source='price';
CREATE TABLE valuation_snapshots (
  id TEXT PRIMARY KEY, dealer_code TEXT NOT NULL, audit_id TEXT NOT NULL, revision BIGINT NOT NULL,
  engine_version TEXT NOT NULL, metadata JSONB NOT NULL, summary JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(dealer_code,audit_id,revision,engine_version)
);
CREATE INDEX valuation_snapshot_scope ON valuation_snapshots(dealer_code,audit_id,created_at DESC);
CREATE TABLE valuation_items (
  snapshot_id TEXT NOT NULL REFERENCES valuation_snapshots(id), part_number TEXT NOT NULL,
  dms_qty NUMERIC(24,8) NOT NULL, physical_qty NUMERIC(24,8) NOT NULL,
  dlc NUMERIC(24,8), mrp NUMERIC(24,8), details JSONB NOT NULL,
  PRIMARY KEY(snapshot_id,part_number)
);
CREATE TABLE dealer_stock_imports (
  id TEXT PRIMARY KEY, dealer_code TEXT NOT NULL, audit_id TEXT NOT NULL, file_hash TEXT NOT NULL,
  file_name TEXT NOT NULL, original_file BYTEA NOT NULL, parsed JSONB NOT NULL, actor TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PREVIEW', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), confirmed_at TIMESTAMPTZ,
  UNIQUE(dealer_code,audit_id,file_hash)
);
CREATE TABLE master_price_revisions (
  id TEXT PRIMARY KEY, dealer_code TEXT NOT NULL, part_number TEXT NOT NULL,
  dlc NUMERIC(24,8) NOT NULL CHECK(dlc>0), mrp NUMERIC(24,8) NOT NULL CHECK(mrp>0),
  reason TEXT NOT NULL, actor TEXT NOT NULL, effective_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX master_price_revision_lookup ON master_price_revisions(dealer_code,part_number,effective_at DESC);
CREATE FUNCTION valuation_source_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r RECORD; old_scope RECORD; kind TEXT;
BEGIN
  kind := CASE WHEN TG_TABLE_NAME IN ('mastercatalogues','masterparts') THEN 'price' ELSE 'stock' END;
  IF TG_OP='DELETE' THEN r:=OLD; ELSE r:=NEW; END IF;
  INSERT INTO valuation_changes(dealer_code,audit_id,part_number,source)
  VALUES(coalesce(r."dealerCode",''),CASE WHEN kind='price' THEN '' ELSE coalesce(r."auditId",'') END,
    regexp_replace(upper(coalesce(r."normalizedPartNumber",r."partNumber",r.data->>'partNo',r.data->>'part','')),'[[:space:]*-]','','g'),kind);
  IF TG_OP='UPDATE' AND (OLD."dealerCode",OLD."auditId",OLD."normalizedPartNumber",OLD."partNumber") IS DISTINCT FROM
    (NEW."dealerCode",NEW."auditId",NEW."normalizedPartNumber",NEW."partNumber") THEN
    INSERT INTO valuation_changes(dealer_code,audit_id,part_number,source)
    VALUES(coalesce(OLD."dealerCode",''),CASE WHEN kind='price' THEN '' ELSE coalesce(OLD."auditId",'') END,
      regexp_replace(upper(coalesce(OLD."normalizedPartNumber",OLD."partNumber",OLD.data->>'partNo',OLD.data->>'part','')),'[[:space:]*-]','','g'),kind);
  END IF;
  RETURN r;
END $$;
CREATE TRIGGER valuation_inventory_change AFTER INSERT OR UPDATE OR DELETE ON inventories FOR EACH ROW EXECUTE FUNCTION valuation_source_changed();
CREATE TRIGGER valuation_upload_change AFTER INSERT OR UPDATE OR DELETE ON dealer_stock_master FOR EACH ROW EXECUTE FUNCTION valuation_source_changed();
CREATE TRIGGER valuation_catalogue_change AFTER INSERT OR UPDATE OR DELETE ON mastercatalogues FOR EACH ROW EXECUTE FUNCTION valuation_source_changed();
CREATE TRIGGER valuation_legacy_master_change AFTER INSERT OR UPDATE OR DELETE ON masterparts FOR EACH ROW EXECUTE FUNCTION valuation_source_changed();
