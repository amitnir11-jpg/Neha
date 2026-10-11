-- Read-only triage query for a verified PostgreSQL backup or isolated restore.
-- Do not run against the production Railway database as part of this fix.
-- It flags transactions whose dealer ownership conflicts with Dealer/Audit
-- evidence. It does not infer a replacement dealer and never updates rows.

WITH audit_dealer_evidence AS (
  SELECT
    "auditId",
    array_agg(DISTINCT NULLIF(upper(btrim("dealerCode")), '') ORDER BY NULLIF(upper(btrim("dealerCode")), ''))
      FILTER (WHERE NULLIF(btrim("dealerCode"), '') IS NOT NULL) AS dealer_codes
  FROM audits
  WHERE NULLIF(btrim("auditId"), '') IS NOT NULL
  GROUP BY "auditId"
), transaction_rows AS (
  SELECT
    i.id AS transaction_id,
    COALESCE(NULLIF(upper(btrim(i."dealerCode")), ''), NULLIF(upper(btrim(i.data->>'dealerCode')), '')) AS current_dealer_code,
    COALESCE(NULLIF(i."auditId", ''), NULLIF(i.data->>'auditId', '')) AS audit_id,
    COALESCE(NULLIF(i."partNumber", ''), NULLIF(i."normalizedPartNumber", ''), NULLIF(i.data->>'partNumber', ''), NULLIF(i.data->>'part', '')) AS part_number,
    COALESCE(NULLIF(i."upiCode", ''), NULLIF(i."upiNo", ''), NULLIF(i.data->>'upiCode', ''), NULLIF(i.data->>'upiNo', ''), NULLIF(i.data->>'upiId', '')) AS upi,
    COALESCE(i."qty", NULLIF(i.data->>'qty', '')::numeric, NULLIF(i.data->>'quantity', '')::numeric) AS quantity,
    COALESCE(NULLIF(i."binLocation", ''), NULLIF(i."bin", ''), NULLIF(i.data->>'binLocation', ''), NULLIF(i.data->>'bin', '')) AS bin_location,
    COALESCE(i."timestamp", i."createdAt") AS transaction_time,
    i."scanType" AS scan_type,
    i."deviceId" AS device_id
  FROM inventories i
)
SELECT
  t.transaction_id,
  t.current_dealer_code,
  t.part_number,
  t.upi,
  t.quantity,
  t.bin_location,
  t.transaction_time,
  t.scan_type,
  t.audit_id,
  e.dealer_codes AS audit_dealer_evidence,
  t.device_id,
  CASE
    WHEN t.current_dealer_code IS NULL THEN 'MISSING_DEALER_CODE'
    WHEN d."dealerCode" IS NULL THEN 'UNKNOWN_DEALER_CODE'
    WHEN t.audit_id IS NOT NULL AND e.dealer_codes IS NULL THEN 'AUDIT_NOT_FOUND'
    WHEN cardinality(e.dealer_codes) > 1 THEN 'AUDIT_ID_MATCHES_MULTIPLE_DEALERS'
    WHEN t.audit_id IS NOT NULL AND NOT (t.current_dealer_code = ANY(e.dealer_codes)) THEN 'AUDIT_DEALER_MISMATCH'
    ELSE 'REVIEW'
  END AS review_reason
FROM transaction_rows t
LEFT JOIN dealers d ON upper(btrim(d."dealerCode")) = t.current_dealer_code
LEFT JOIN audit_dealer_evidence e ON e."auditId" = t.audit_id
WHERE t.current_dealer_code IS NULL
   OR d."dealerCode" IS NULL
   OR (t.audit_id IS NOT NULL AND (
        e.dealer_codes IS NULL
        OR cardinality(e.dealer_codes) > 1
        OR NOT (t.current_dealer_code = ANY(e.dealer_codes))
      ))
ORDER BY t.transaction_time NULLS LAST, t.transaction_id;
