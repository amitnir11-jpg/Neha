# Uploaded stock valuation and audit reconciliation

The Audit Pack's original calculation read all uploaded stock rows but requested Part Master prices only for scanned parts and built final rows only from scan groups. Unscanned uploaded stock therefore disappeared from the customer Audit Summary. The default part-wise builder also restricted uploaded stock to scanned part numbers. Separately, the dashboard's uploaded-stock helper could substitute MRP for missing DLC.

The correction treats uploaded stock and net physical stock as independent inputs. Every uploaded part enters reconciliation, and physically scanned parts absent from the upload enter with zero DMS quantity. Part Master lookups cover their combined normalized part numbers and remain restricted to the selected dealer and shared master records. Scoped audits use the stock upload table for DMS quantities rather than inferred master quantities.

`utils/auditValuation.js` now supplies the quantity, DLC/MRP, shortage, excess, and exception totals for the dashboard, reconciliation, stock/category reports and Audit Pack. Missing prices leave the affected final valuation null. Known subtotals are named separately. Empty stock sources and unresolved prices prevent a completed/balanced certification. Quantities and shortages/excesses remain present regardless of pricing status.

Financial amounts use decimal multiplication, cent rounding and decimal summation. Financial differences and shortage/excess amounts derive from the same rounded stock amounts so line and final totals agree, including fractional quantities.

Saved positive audit prices are retained. Absent rates can be filled from Part Master without updating saved stock, scans or price history. Each rate carries its own source date; a master fallback is not dated as an historical audit snapshot. Legacy identifier formatting is normalized for bulk lookup without removing dealer-specific SKU suffixes or inventing prices.

The Audit Summary includes uploaded DMS quantity, net physical quantity, part-wise shortage/excess quantities, and DLC/MRP values. A Price Exceptions sheet and on-screen exception list identify missing rates. Reconciliation downloads include their filter scope in the download cache and flag incomplete financial values instead of displaying zero.

## Validation

- Standard project regression command: `npm.cmd test`.
- Focused report/export and finance checks: `node --test test/report-*.test.js test/complete-audit-workbook.test.js test/audit-pack-download.test.js test/audit-valuation.test.js test/dealer-stock-export.test.js test/reconciliation-dealer-selection.test.js`.
- JavaScript syntax/build check: `node scripts/build-check.js`.
- PostgreSQL integration: `node --test test/audit-valuation-postgres.integration.test.js` with the two environment variables below.

The PostgreSQL integration test is restricted to a local database named `audit_valuation_test` on `127.0.0.1:55448`. Set `AUDIT_VALUATION_TEST_DATABASE_URL` to that database URL and `AUDIT_VALUATION_TEST_EXPECTATIONS_FILE` to the path of an authorized, untracked fixture JSON. The fixture contains `scope`, `expected` valuation controls, `unscannedPart`, and `exceptionSamples`. It verifies all report builders, the authenticated dashboard endpoint, a filtered unscanned-part query, and the exported Audit Summary/Price Exceptions sheets.

Customer snapshots, expected financial values, database files, before/after reports and credential material stay outside repository source. The integration test skips when its local fixture configuration is absent.

No production scan records are deleted, reset, reimported or updated by this correction. No schema migration is required for the fix. Production deployment remains subject to user approval.
