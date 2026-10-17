# Central valuation testing release

This release is for the testing environment. Production deployment requires separate approval.

Dealer stock, valid deduplicated movements, and current master prices are assembled once in a serializable PostgreSQL transaction. PostgreSQL NUMERIC calculates SKU amounts, quantity differences, category totals and grand totals. DMS and physical amounts are rounded per SKU to cents, half away from zero; variance subtracts those rounded amounts. Missing prices remain null, with separate known subtotals. Signed negative stock is retained and flagged for investigation.

The dashboard, reconciliation, partwise inventory, stock summary, category variance and audit pack consume the same immutable snapshot. Exports pin its ID throughout generation. Database source triggers record scoped changes, including changes committed by other app instances. The first subsequent request rebuilds the affected dealer/audit; concurrent builds and reads share work. Source writes do not run valuation calculations. Bin reports use the same snapshot's location ledger and master prices. Existing original uploaded-stock exports remain a record of saved upload data.

Prices are read directly as numeric text from master JSON, matched by normalized exact SKU and dealer/shared scope. DLC and MRP resolve independently from current valid candidates; source record IDs and effective dates are retained. Admin correction creates a dealer-specific master revision, preserves the shared catalogue, and refreshes affected audits. Future effective prices are excluded. Existing source/master records do not require a destructive conversion migration.

Stock upload accepts part number and quantity. It stores original file bytes, hash, parsed preview, uploader and confirmation status. Confirmation checks dealer/audit and uploader and commits all upserts and the receipt together. Reconfirming the same file is idempotent. Other saved parts remain present. The correction workflow never edits scan or UPI quantities.

## Validation

Run `npm run test:central-valuation`. Unit tests run normally; database checks require `CENTRAL_VALUATION_TEST_DATABASE_URL` to point to the dedicated local test database specified in the integration guard. They never run against a Railway or production database.

Integration coverage includes quantity-only upload, precise master rates, missing-price quantities, ten simultaneous readers, dealer/audit/snapshot isolation, master correction and historical snapshot preservation, dashboard/report equality, real XLSX audit pack and price validation downloads, bin transfer quantity/value invariance, reversal, original-file preservation, repeated confirmation, and 5,000-SKU upload and concurrent valuation.

The normal report and full application regression suites also run with the feature disabled to verify rollback behavior. A browser check covers price health, search, scoped export and correction form; authenticated API checks cover the actual workbook downloads.

Authorized production validation fixtures, finance results, screenshots and backups stay in ignored local `private/`. They must not be committed or seeded into hosted testing without authorization for that destination.

## Deployment and rollback

1. Back up the isolated testing database with PostgreSQL `pg_dump -Fc` over a private connection. Validate the archive with `pg_restore --list` and restore it into a separate empty local database. Keep backups and temporary credentials outside Git. Revoke temporary credentials after backup.
2. Deploy this branch to the testing app only. Set `CENTRAL_VALUATION_ENABLED=true` and `DAKSH_SKIP_MIGRATIONS=false` there. Additive migrations create derived tables and change-event triggers; existing source tables and quantities are untouched.
3. Verify health, authenticated dashboard/reconciliation and Excel exports. Inspect the Price Validation tab and confirm current dealer/audit and snapshot identifiers.
4. For application rollback, set `CENTRAL_VALUATION_ENABLED=false` and redeploy the previous testing source. Leave additive tables and source data intact; no reverse/drop migration is needed. Do not restore an old backup over a live database with new user activity. If recovery is needed, restore into a separate database and reconcile subsequent activity first.
5. Before any approved production release, make a fresh production backup and validate its restore in isolation. Apply only the additive migrations. Re-run the scoped reconciliation and export checks before enabling the feature broadly.

Versioned snapshots contain a complete dealer/audit result. Storage growth should be monitored during testing; retention/compression policy for derived snapshots must be agreed before high-frequency long-running production use. The measured load check is local and does not guarantee the same latency on Railway resources.

## Calculation review — 2026-10-16

The screenshot scenario is covered by a synthetic PostgreSQL fixture: DMS quantity 10, physical quantity 1, shortage quantity 10, excess quantity 1, and net quantity -9. DMS DLC value and shortage value are 1,112.52; physical DLC value and excess value are 998.69; DLC variance is -113.83 and MRP variance is -130.00. Raw, partwise, stock, category and reconciliation projections agree for the same snapshot.

Existing code was corrected so filtered counts, transaction rows and bin rows use the selected SKUs; physical part lines exclude unscanned DMS-only SKUs; movement classifications use the existing shared rule; missing prices remain pending in screen rows and category/product-group exports; and the reconciliation export's Total Inventory Value uses the same DMS basis as Final Summary. Complete audit packs retain the requested historical snapshot. The valuation check now compares detail totals against the snapshot rather than returning unconditional success. Later corrections for a split SKU include already transferred rows from the same sheet when recomputing that SKU's DMS quantity.

Validation: `npm test` passed (195 assertions across its test groups, with two optional PostgreSQL checks skipped). A separate run passed 49 targeted tests with all four central PostgreSQL integration tests enabled against a fresh localhost-only database. Coverage includes real XLSX exports, preserved historical snapshots after price corrections, missing-price amounts, dealer/audit isolation, workshop billing, 5,000-SKU uploads and ten concurrent readers. The JavaScript build check passed. These checks use synthetic local records; they do not certify every live customer record or guarantee hosted load-test timings.
