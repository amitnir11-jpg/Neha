# Scan flow and shared stock calculation validation

## Mobile Web bin registration and decoder recovery — 2026-10-08

Mobile Web now registers a missing dealer bin when the operator enters it and uses Set Bin or confirms the field. This addresses the reported A1/A5 rejection when those bins had not been created in Bin Master. `POST /api/scans/set-bin` runs through authenticated dealer/audit access checks and a serializable transaction, returns an existing active bin unchanged, creates a missing bin, and rejects inactive bins. Concurrent requests create one record. Manual-entry bin confirmation uses the same operation; typing partial bin codes does not create records.

Camera decoder initialization now has an eight-second timeout and falls back to the JavaScript QR/1D decoder. Repeated WASM frame exceptions also trigger that fallback on the existing stream. Late initialization after Camera Off cannot restart detection, and a temporary video pause no longer permanently stops native detection. Full-frame decoding remains enabled for QR and 1D codes, and scanner assets/build identifiers advance to `20261008-bin-camera-v9`.

All 22 acceptance checks pass, covering mobile-user bin registration, concurrent registration, inward persistence, dealer isolation, inactive-bin protection, Mobile Web Set Bin, optical CODE128/Hero QR capture and actual JavaScript 1D/QR fallback after a forced WASM failure. The full `npm test` passes with the isolated database enabled. Four camera recovery unit tests cover startup timeout, repeated errors versus undecodable frames, cancellation and temporary video pause. These are local checks with fixture images; the photographed physical label and the user's phone still require a device retest after deployment.

## Verification follow-up — 2026-10-08

`npm test` and `npm run build` pass. The database-dependent barcode migration test was rerun with the isolated local PostgreSQL database and passed (nine barcode-save tests, zero skips). The Local Parts database check also passed all 32 assertions.

The PostgreSQL/API/authenticated Chrome acceptance runner passed all 19 checks, including real optical CODE128 and Hero QR decoding from fixture images through a canvas camera stream, with one continuous camera session. The API QR fixture previously reused the optical fixture's UPI and caused the final check to fail on legitimate duplicate protection; it now has a separate UPI. Application duplicate rules are unchanged. Results and screenshots are in `.codex-artifacts/scan-acceptance/`. Physical device checks and authenticated production verification remain outstanding.

The implementation follows the new INWARD / OUTWARD / FITTED workflow. On 7 October 2026, the remaining acceptance checks passed against an isolated local PostgreSQL 18 cluster with all 20 project migrations applied. Real HTTP requests, persisted stock, simultaneous scans, rollback after a forced database insertion failure, authenticated Chrome screens, and live Socket.IO refresh were verified. This verifies the local application; deployment has not been performed or tested.

## Behavior implemented

- INWARD requires an active bin belonging to the selected dealer. Barcode/manual part fields and save actions stay disabled until validation succeeds. The selected bin remains available for continuous scanning. The common save service rejects unknown/inactive INWARD bins as well.
- OUTWARD and FITTED QR workflows hide and disable the source-bin input, clear its previous value, and focus the barcode field. Mobile web FITTED no longer requires the old part/bin-first step. Vehicle/job-card requirements remain in force; a FITTED QR is retained until those required details are supplied.
- Unique scans normalize quantity to one. Manual aggregated quantities remain independent.
- UPI location resolution uses dealer and audit scope. A plain token such as `UPI001` is tried exactly before a parser-derived identity such as `001`, without changing the QR parser. The resolved inventory part replaces an inferred UPI-as-part value before master validation.
- OUTWARD and FITTED revalidate the UPI and exact store-bin stock inside the existing serializable transaction, then conditionally claim the source and insert the movement. Manual allocation validates the selected part/bin quantity in the same transaction. The existing workshop billing and return workflow remains in place.
- The scan response includes `partSummary`; `GET /api/scans/part-summary` refreshes the same authoritative calculation. It returns `partNumber`, `inwardQty`, `outwardQty`, `fittedQty`, `damageQty`, `availableQty`, `storeQty`, `returnQty`, and `binBreakdown`.
- Both web scan screens show the compact line beneath the scan area and refresh it from committed responses and inventory events. Recent history and complete dealer totals remain independent of its ten-row display limit.

## Shared calculation

`utils/stockQuantity.js` owns movement signs, pending workshop quantity, and available quantity. `services/StockCalculationService.js` loads the complete valid dealer/audit/part dataset and supplies part/bin breakdowns. Existing movement-state, inventory value, report totals, dashboard inventory summaries, reports, bin availability, and reconciliation call the shared calculation.

For pending FITTED stock, total available equals inward minus outward minus damage. Store quantity decreases on FITTED and the same quantity remains in workshop stock. Billing removes workshop availability under the existing status lifecycle. Return transactions restore store stock under the existing return lifecycle.

`storeQty` / `physicalBinQty` describe units actually left in the store. `fittedQty` / `fittedWorkshopQty` describe pending units in the workshop. `availableQty` / `totalDealerStockQty` include both. Bin breakdowns retain the source-bin attribution of workshop stock, so their available totals reconcile with the part total while their store quantities remain separate.

The bin-wise report now groups by dealer/part/bin and calculates the balance through the shared helper, including pending workshop and billed states. Report export layout and valuation fields remain available. Legacy quantity parsing is preserved for historical rows that lack explicit quantity fields; existing data is not rewritten.

## Golden example results

The following values were verified with production calculation functions and fixtures, including the bin-wise report builder.

| Stage | Inward | Outward | Fitted in workshop | Damage | Store | Total available |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| UPI001, UPI002 inward to A1; UPI003, UPI004 inward to B1 | 4 | 0 | 0 | 0 | 4 | 4 |
| OUTWARD UPI003 from B1 | 4 | 1 | 0 | 0 | 3 | 3 |
| FITTED UPI002 from A1 | 4 | 1 | 1 | 0 | 2 | 3 |
| DAMAGE UPI004 from B1 | 4 | 1 | 1 | 1 | 1 | 2 |

Final A1 has one store unit plus one workshop unit attributed to A1, for two total available units. B1 has zero available units. Part, shared summary, dashboard value engine, report totals, reconciliation quantity, and bin-wise report calculations agree in these fixtures.

## Files changed for this follow-up

- `utils/stockQuantity.js`: central quantity definition, aliases, deletion/duplicate/rejection handling, and legacy quantity fallback.
- `services/StockCalculationService.js`: authoritative part and bin summaries.
- `services/ScanProcessingService.js`: committed response includes part summary, with frontend refresh fallback if summary loading fails.
- `utils/inventoryMovementState.js`, `utils/inventoryValueEngine.js`, `utils/reportTotals.js`: use shared stock quantity functions.
- `routes/inventory.js`: shared bin availability/dashboard signs; part-summary and bin-validation endpoints.
- `routes/sync.js`: exact plain-UPI resolution, FITTED validation, INWARD bin enforcement, manual allocation validation, and OUTWARD/FITTED transaction-time stock checks.
- `routes/reconciliation.js`, `routes/report.js`, `routes/reports.js`: common stock calculation and complete bin balances.
- `public/ui.js`, `public/Daksh.html`, `public/style.css`: mode-specific source-bin visibility, bin validation gates, live part line, and retained FITTED capture.
- `public/scan.js`, `public/scan.html`, `public/scan.css`: mobile web auto-bin FITTED, INWARD gates, part summary, and history device/date display.
- `routes/mobile.js`, `server.js`: matching scanner build identifiers, retaining the earlier recent-history correction.
- `package.json`, `test/scan-flow-stock.test.js`, `test/scan-outward-summary.test.js`, `test/barcode-save-performance.test.js`, `test/scan-history-outward.test.js`: shared calculation, mode gates, plain-UPI, metadata capture, summary response, and transaction regression tests.
- `public/barcode-workspace.css`, `public/Daksh.html`: fix layered CSS overriding the hidden OUTWARD/FITTED source-bin field, workflow step, and clear button; update the stylesheet cache identifier.
- `public/scan.js`, `routes/mobile.js`, `test/scan-outward-summary.test.js`: return transaction/audit/device identity on recent mobile rows and merge history by transaction identity, retaining distinct INWARD/FITTED/OUTWARD movements for one UPI while combining local/server copies of the same save. Browser verification confirms ten visible rows after FITTED.
- `scripts/scan-stock-acceptance.js`: repeatable isolated PostgreSQL and optional browser acceptance runner, available through `npm run test:scan:acceptance`.

## Verification

- `npm run test:barcode` through the full suite with the isolated database: 59 passed, zero failed, zero skipped, including migration replay, mobile response identity, and distinct-UPI-movement history coverage.
- `npm run test:reports`: 59 passed.
- `test/scan-flow-stock.test.js`: includes the exact golden sequence, billing/return behavior, invalid/deleted/local exclusion, legacy quantity compatibility, INWARD gates, automatic OUTWARD/FITTED bin visibility, bin-wise report parity, response summary, concurrent callbacks, and rollback after failed insertion.
- The component transaction tests use a serialized model stub. The additional acceptance runner executes the real server and PostgreSQL serializable transactions: two distinct authenticated users simultaneously submit OUTWARD and FITTED for one UPI, with exactly one successful movement each. A PostgreSQL trigger forces insertion failure after the source claim; the claim, stock balance, and movement all roll back.
- Part Master pricing, stock valuation/reconciliation, category alignment, duplicate UPI, part/bin duplicate policy, report performance, report scan quantity, movement calculation, cache safety, Prisma mirror types, mobile scanner regression, and dealer-stock template checks passed during the full test command.
- The previously failing legacy FITTED alias check now passes because movement normalization uses the shared quantity definition.
- Network discovery tests: three passed separately.
- `npm run build` and the build checker passed. `git diff --check` passed.

`npm test` completed successfully with the isolated database, including Local Parts isolation and network discovery. The acceptance runner passed 16 checks covering invalid INWARD bins, the golden sequence, duplicate/unknown UPI rejection, archived-audit isolation, simultaneous OUTWARD/FITTED, database rollback, manual quantity ten, complete totals with ten visible rows and search filters, desktop/mobile bin gates, desktop OUTWARD/FITTED saves, mobile OUTWARD/FITTED sync, committed part summaries, and authenticated socket refresh.

The Chrome mobile tests use a simulated camera stream and controlled decoded QR values. The actual browser UI, IndexedDB queue, HTTP API, PostgreSQL writes and sockets run without mocks. Physical camera decoding and the deployed environment remain outside this local verification. The six-field FITTED QR fixture is first stored through INWARD using the same complete QR identity, preserving the existing duplicate identity policy.

## Repeat the acceptance checks

Use an isolated local PostgreSQL database named `scan_acceptance`. The runner refuses remote databases and other database names, starts its own local API server, creates uniquely scoped fixtures, and removes those fixtures and stops the API server at completion. Apply migrations before running it.

```powershell
$env:DATABASE_URL = 'postgresql://scan_test@127.0.0.1:55438/scan_acceptance'
npx prisma migrate deploy
$env:SCAN_ACCEPTANCE_DATABASE_URL = $env:DATABASE_URL
# Optional: path to an installed Playwright module enables the browser checks.
$env:PLAYWRIGHT_MODULE = "$PWD\.codex-artifacts\scan-acceptance\browser\node_modules\playwright"
npm run test:scan:acceptance
```

With Playwright enabled, Chrome on Windows is used by default; `CHROME_PATH` overrides its executable. `SCAN_ACCEPTANCE_PORT` overrides the API test port (55439). Without Playwright the runner performs eight database/API checks. Logs, screenshots, and `results.json` are written to the ignored `.codex-artifacts/scan-acceptance/` directory. The local PostgreSQL cluster used for this verification is stopped after final checks; its data remains available there for inspection.
