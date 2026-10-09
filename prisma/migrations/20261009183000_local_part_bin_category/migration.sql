ALTER TABLE "local_part_entries"
  ADD COLUMN IF NOT EXISTS "binLocation" TEXT,
  ADD COLUMN IF NOT EXISTS "category" TEXT;
