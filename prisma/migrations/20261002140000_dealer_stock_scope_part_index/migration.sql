CREATE INDEX CONCURRENTLY IF NOT EXISTS "dealer_stock_scope_part_idx"
  ON "dealer_stock_master" ("dealerCode", "auditId", "normalizedPartNumber");
