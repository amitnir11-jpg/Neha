-- Earlier Prisma adapter versions persisted soft-delete metadata only in the
-- JSON payload. The active fingerprint index reads scalar PostgreSQL columns,
-- so copy the canonical archived state into those indexed columns.
UPDATE inventories
SET "isDeleted" = CASE LOWER(COALESCE("data"->>'isDeleted', 'false'))
      WHEN 'true' THEN true
      WHEN '1' THEN true
      WHEN 'yes' THEN true
      ELSE false
    END,
    "deletedAt" = NULLIF("data"->>'deletedAt', '')::timestamptz
WHERE "isDeleted" IS DISTINCT FROM CASE LOWER(COALESCE("data"->>'isDeleted', 'false'))
        WHEN 'true' THEN true
        WHEN '1' THEN true
        WHEN 'yes' THEN true
        ELSE false
      END
   OR "deletedAt" IS DISTINCT FROM NULLIF("data"->>'deletedAt', '')::timestamptz;
