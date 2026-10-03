-- The model adapter reads mirrored fields with a JSON fallback. Match that
-- expression so exact price lookups do not scan the entire catalogue.
CREATE INDEX IF NOT EXISTS mastercatalogues_effective_normalized_part_idx
  ON mastercatalogues ((COALESCE("normalizedPartNumber", "data"->>'normalizedPartNumber')));

CREATE INDEX IF NOT EXISTS mastercatalogues_effective_part_number_idx
  ON mastercatalogues ((COALESCE("partNumber", "data"->>'partNumber')));
