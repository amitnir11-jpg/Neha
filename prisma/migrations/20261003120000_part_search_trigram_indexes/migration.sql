-- Prisma submits this migration as a batch; concurrent index creation cannot run in that transaction.
CREATE INDEX IF NOT EXISTS mastercatalogues_normalized_part_trgm_idx
  ON mastercatalogues USING GIN ("normalizedPartNumber" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS mastercatalogues_part_number_trgm_idx
  ON mastercatalogues USING GIN ("partNumber" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS masterparts_normalized_part_trgm_idx
  ON masterparts USING GIN ("normalizedPartNumber" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS masterparts_part_number_trgm_idx
  ON masterparts USING GIN ("partNumber" gin_trgm_ops);
