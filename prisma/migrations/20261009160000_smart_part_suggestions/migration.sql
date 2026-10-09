-- Search-only indexes. No master or inventory rows are modified.
CREATE INDEX IF NOT EXISTS mastercatalogues_smart_part_prefix_idx ON mastercatalogues
  (upper(COALESCE(NULLIF("normalizedPartNumber", ''), "partNumber", data->>'partNo', data->>'part', '')) text_pattern_ops);
CREATE INDEX IF NOT EXISTS masterparts_smart_part_prefix_idx ON masterparts
  (upper(COALESCE(NULLIF("normalizedPartNumber", ''), "partNumber", data->>'partNo', data->>'part', '')) text_pattern_ops);
CREATE INDEX IF NOT EXISTS mastercatalogues_smart_part_trgm_idx ON mastercatalogues USING GIN
  (upper(COALESCE(NULLIF("normalizedPartNumber", ''), "partNumber", data->>'partNo', data->>'part', '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS masterparts_smart_part_trgm_idx ON masterparts USING GIN
  (upper(COALESCE(NULLIF("normalizedPartNumber", ''), "partNumber", data->>'partNo', data->>'part', '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS mastercatalogues_smart_description_trgm_idx ON mastercatalogues USING GIN
  (upper(COALESCE(data->>'partDescription', data->>'partName', '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS masterparts_smart_description_trgm_idx ON masterparts USING GIN
  (upper(COALESCE(data->>'partDescription', data->>'partName', '')) gin_trgm_ops);
