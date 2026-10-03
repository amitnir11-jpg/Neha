CREATE INDEX CONCURRENTLY IF NOT EXISTS mastercatalogues_normalized_part_trgm_idx
  ON mastercatalogues USING GIN ("normalizedPartNumber" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS mastercatalogues_part_number_trgm_idx
  ON mastercatalogues USING GIN ("partNumber" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS masterparts_normalized_part_trgm_idx
  ON masterparts USING GIN ("normalizedPartNumber" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS masterparts_part_number_trgm_idx
  ON masterparts USING GIN ("partNumber" gin_trgm_ops);
