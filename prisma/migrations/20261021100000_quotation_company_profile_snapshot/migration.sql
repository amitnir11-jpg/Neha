INSERT INTO "settings" ("id", "data", "key", "createdAt", "updatedAt")
SELECT
  'quotation-company-profile-default',
  '{"companyName":"DAKSH INVENTORY SOLUTION V2","addressLine1":"S-2/63, Deep Nagar, Benad Road,","addressLine2":"Jhotwara, Jaipur, Rajasthan - 302012","quotationTitle":"COMMERCIAL QUOTATION","quotationSubtitle":"Physical Inventory Audit & Stock Reconciliation Services","authorizedSignatory":"Bineet","signatoryTitle":"Authorized Signatory","stampLabel":"DAKSH INVENTORY SOLUTION V2"}'::jsonb,
  'quotation-company-profile',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "settings" WHERE "key" = 'quotation-company-profile');

UPDATE "quotations"
SET "data" = jsonb_set(
  COALESCE("data", '{}'::jsonb),
  '{companyProfile}',
  '{"companyName":"DAKSH INVENTORY SOLUTION V2","addressLine1":"S-2/63, Deep Nagar, Benad Road,","addressLine2":"Jhotwara, Jaipur, Rajasthan - 302012","quotationTitle":"COMMERCIAL QUOTATION","quotationSubtitle":"Physical Inventory Audit & Stock Reconciliation Services","authorizedSignatory":"Bineet","signatoryTitle":"Authorized Signatory","stampLabel":"DAKSH INVENTORY SOLUTION V2"}'::jsonb,
  true
)
WHERE NOT (COALESCE("data", '{}'::jsonb) ? 'companyProfile');
