ALTER TABLE mastercatalogues ADD COLUMN IF NOT EXISTS "upiCode" TEXT;
ALTER TABLE mastercatalogues ADD COLUMN IF NOT EXISTS "movementType" TEXT;
ALTER TABLE mastercatalogues ADD COLUMN IF NOT EXISTS "activeInventory" BOOLEAN DEFAULT FALSE;
ALTER TABLE mastercatalogues ADD COLUMN IF NOT EXISTS "remainingQty" DOUBLE PRECISION DEFAULT 0;

CREATE INDEX IF NOT EXISTS mastercatalogues_upi_code_idx
  ON mastercatalogues ("upiCode")
  WHERE "upiCode" IS NOT NULL AND "upiCode" <> '';

CREATE INDEX IF NOT EXISTS mastercatalogues_movement_type_idx
  ON mastercatalogues ("movementType")
  WHERE "movementType" IS NOT NULL AND "movementType" <> '';

CREATE INDEX IF NOT EXISTS mastercatalogues_active_inventory_idx
  ON mastercatalogues ("activeInventory")
  WHERE "activeInventory" = TRUE;
