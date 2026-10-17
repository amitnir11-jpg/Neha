DO $$
DECLARE constraint_name text;
BEGIN
  SELECT conname INTO constraint_name FROM pg_constraint
    WHERE conrelid='valuation_snapshots'::regclass AND contype='u';
  EXECUTE format('ALTER TABLE valuation_snapshots RENAME CONSTRAINT %I TO valuation_snapshot_revision_key',constraint_name);
END $$;
