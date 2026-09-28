-- Preserve existing rows. NOT VALID constraints enforce all new/updated rows;
-- legacy rows can be validated after the explicit dealer backfill is reviewed.
CREATE UNIQUE INDEX IF NOT EXISTS dealers_dealer_code_fk_key
  ON dealers ("dealerCode");

CREATE UNIQUE INDEX IF NOT EXISTS audits_dealer_audit_fk_key
  ON audits ("dealerCode", "auditId");

CREATE UNIQUE INDEX IF NOT EXISTS audits_one_active_per_dealer
  ON audits ("dealerCode")
  WHERE "dealerCode" IS NOT NULL
    AND COALESCE("data"->>'auditStatus', '') IN ('', 'ACTIVE', 'IN_PROGRESS')
    AND COALESCE("status", '') IN ('', 'ACTIVE', 'active', 'open', 'IN_PROGRESS')
    AND NULLIF("data"->>'auditClosedDate', '') IS NULL;

ALTER TABLE audits
  ADD CONSTRAINT audits_dealer_code_fk
  FOREIGN KEY ("dealerCode") REFERENCES dealers ("dealerCode") NOT VALID;

ALTER TABLE inventories
  ADD CONSTRAINT inventories_dealer_code_fk
  FOREIGN KEY ("dealerCode") REFERENCES dealers ("dealerCode") NOT VALID;

ALTER TABLE inventories
  ADD CONSTRAINT inventories_dealer_audit_fk
  FOREIGN KEY ("dealerCode", "auditId") REFERENCES audits ("dealerCode", "auditId") NOT VALID;

ALTER TABLE scans
  ADD CONSTRAINT scans_dealer_code_fk
  FOREIGN KEY ("dealerCode") REFERENCES dealers ("dealerCode") NOT VALID;

ALTER TABLE scans
  ADD CONSTRAINT scans_dealer_audit_fk
  FOREIGN KEY ("dealerCode", "auditId") REFERENCES audits ("dealerCode", "auditId") NOT VALID;

ALTER TABLE bins
  ADD CONSTRAINT bins_dealer_code_fk
  FOREIGN KEY ("dealerCode") REFERENCES dealers ("dealerCode") NOT VALID;

ALTER TABLE dealer_stock_master
  ADD CONSTRAINT dealer_stock_master_dealer_code_fk
  FOREIGN KEY ("dealerCode") REFERENCES dealers ("dealerCode") NOT VALID;

ALTER TABLE dealer_stock_master
  ADD CONSTRAINT dealer_stock_master_dealer_audit_fk
  FOREIGN KEY ("dealerCode", "auditId") REFERENCES audits ("dealerCode", "auditId") NOT VALID;

ALTER TABLE offlinequeues
  ADD CONSTRAINT offlinequeues_dealer_code_fk
  FOREIGN KEY ("dealerCode") REFERENCES dealers ("dealerCode") NOT VALID;

ALTER TABLE offlinequeues
  ADD CONSTRAINT offlinequeues_dealer_audit_fk
  FOREIGN KEY ("dealerCode", "auditId") REFERENCES audits ("dealerCode", "auditId") NOT VALID;

ALTER TABLE bintransferhistories
  ADD CONSTRAINT bintransferhistories_dealer_code_fk
  FOREIGN KEY ("dealerCode") REFERENCES dealers ("dealerCode") NOT VALID;

ALTER TABLE bintransferhistories
  ADD CONSTRAINT bintransferhistories_dealer_audit_fk
  FOREIGN KEY ("dealerCode", "auditId") REFERENCES audits ("dealerCode", "auditId") NOT VALID;
