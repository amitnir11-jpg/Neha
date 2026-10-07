The following records the earlier OUTWARD-only implementation. The latest workflow and validation report is [scan-flow-stock-logic.md](scan-flow-stock-logic.md).

Update, 7 October 2026: the previously pending local PostgreSQL and authenticated desktop/mobile browser acceptance work is complete. The latest report records the 16 passing acceptance checks, full test suite, CSS visibility correction, and repeatable runner. The pending statements below describe the earlier verification state.

# OUTWARD and scan quantity implementation report

Status: code changes and local regression checks completed; PostgreSQL and authenticated browser acceptance remain unverified. This report does not certify the issue as fully fixed against a database.

## Root causes

- The desktop barcode workspace required a selected source bin at submission and autosave, overriding the existing backend UPI location lookup. The mobile web scanner also required a part/bin step before an OUTWARD QR scan.
- Unique scans could inherit a quantity other than one. Backend source preparation rejected these rather than normalizing their quantity.
- The mobile recent-scans query explicitly selected active INWARD records, excluding OUTWARD movements.
- Desktop history calculated summary values from the current page. Its loader then overwrote server totals with a summary derived from the displayed records. Optimistic insertion also replaced the summary with page counts.
- The mobile web scanner relied on polling for other users' changes and merged old local rows before newer server movements.

## Files changed

| File | Change |
| --- | --- |
| `routes/sync.js` | Unit quantity normalization, audit-scoped UPI lookup, automatic-bin metadata, transaction-time source/bin availability validation, rejection messages. |
| `routes/inventory.js` | Complete valid dealer/audit summary independent of table filters; current audit fallback; separate visible row count. |
| `routes/mobile.js` | Recent movements include OUTWARD, use audit scope, and return the complete inventory summary. |
| `public/ui.js` | Read-only automatic source bin for OUTWARD QR, quantity one for unique scans, preserved server totals, event-driven history refresh, separate manual entry navigation. |
| `public/scan.js` | OUTWARD QR bypasses the part/bin prerequisite; summary state, authenticated inventory events, refresh after sync, newest-first recent movements. |
| `public/scan.html`, `public/scan.css` | Four summary figures directly above recent history; responsive summary layout; Socket.IO client. |
| `public/Daksh.html`, `server.js` | Cache/version identifiers match the changed frontend assets. |
| `package.json` | Standard barcode test command includes scan history, save, and new summary regressions. |
| `test/scan-outward-summary.test.js` | UPI resolution, quantities, full-scope totals, audit/deletion handling, FITTED lifecycle, recent movements, and refresh regression coverage. |
| `docs/scan-outward-summary-diagnosis.md` | This implementation and validation report. |

## Backend behavior

OUTWARD resolves the current UPI within the selected dealer and audit. A unique scan normalizes quantity to one. Within the existing serializable PostgreSQL transaction, the existing advisory identity lock is acquired; OUTWARD re-resolves its source and checks the exact resolved bin's transaction-based available stock. The existing conditional source claim and movement insertion remain in the same transaction. A changed source, unavailable bin, failed claim, or failed insertion rolls back.

Bin availability is derived from persisted movement transactions; there is no separate bin quantity counter to update. The transaction writes the OUTWARD movement and claims the source UPI status together. The existing background inventory-state refresh continues after a committed save.

The complete summary uses the existing valid-scan filtering and movement rules, including existing physical-bin plus pending-workshop stock calculation. Pending FITTED remains in dealer stock; BILLED removes it under the existing lifecycle. FITTED operations and the existing workshop billing branch are retained. Local Parts remains in its separate storage/workflow. No database migration or historical record rewrite was performed.

The main net quantity, scan row count, and unique part count ignore table part, bin, type, page, and date filters. The table retains these filters and its own visible row count. Archived/deleted, rejected, duplicate, verification, and invalid records are excluded through existing active transaction filters.

## Frontend and realtime behavior

Selecting OUTWARD clears the barcode source bin and makes it read-only with the automatic lookup placeholder. A committed QR movement reports its picked bin and clears the field for the next scan. The manual button uses the existing separate Manual Entry form; the existing server manual authorization/allocation rules remain unchanged.

A successful scan immediately prepends the committed movement and schedules a short debounced reload of authoritative history totals. Inventory events also refresh the active scan history. The mobile web scanner now subscribes to authenticated scan/inventory events, refreshes after its own sync, and sorts merged history by time so newer remote OUTWARD rows are visible. Polling remains a fallback. The four figures remain distinct; neither quantity nor distinct parts is calculated from ten visible rows.

## Requested acceptance matrix

Component tests use fixtures and model stubs; they do not prove PostgreSQL persistence or browser rendering.

| Requested test | Local evidence | Remaining acceptance |
| --- | --- | --- |
| 1. UPI001 in A1, outward one, history and balance update | Exact A1 resolution, unit quantity, movement deduction and refresh components pass. | Full UPI save and database balance verification. |
| 2. UPI002 in B2 | Exact B2 resolution component passes. | Database verification. |
| 3. Re-scan already OUTWARD | Rejection and unchanged fixture rows pass. | Database row/quantity verification. |
| 4. Unknown UPI | Unknown, other-dealer, and other-audit rejection pass. | Database verification. |
| 5. Same part in two bins | Exact UPI chooses B2 despite A1/wrong client bin. | Database deduction verification. |
| 6. Two users simultaneously scan one UPI | Existing advisory lock test passes; transaction and conditional claim reviewed. | Not run against PostgreSQL; one-success/one-failure acceptance pending. |
| 7. Manual quantity ten, unique scan quantity one | Normalization and source preparation tests pass; manual aggregated quantity remains ten. | Authenticated browser workflow. |
| 8. Fifteen inward minus one outward equals fourteen | Complete summary component passes; scan rows remain two. | Database comparison. |
| 9. Ten visible rows with complete balance ninety-four | Complete summary and frontend loader components pass. | Database/browser comparison. |
| 10. Search does not change dealer net quantity | Part/bin/type/limit-independent summary component passes. | Authenticated browser search. |
| 11. Immediate history and four figures | Commit-triggered refresh, server-summary preservation, recent OUTWARD inclusion, and newest-first merge components pass. | Live browser/socket and database end-to-end verification. |

## Checks run

- `npm run test:barcode`: 41 passed, 0 failed, 1 existing database-dependent migration test skipped.
- `npm run test:reports` (through `npm test`): 59 passed.
- Report performance tests: 3 passed; network discovery tests: 3 passed.
- Part Master pricing, stock valuation, category alignment, duplicate UPI, part/bin duplicates, active movement calculations, cache safety, Prisma mirror types, mobile scanner regression, and dealer-stock template checks passed.
- `npm run build` passed; the build checker was rerun after subsequent code changes and passed.
- `git diff --check` passed.

`npm test` stops at `scripts/report-scan-quantity-check.js:48`: the unchanged legacy `fitted_on_vehicle` fixture expects fitted quantity one but receives zero. The same assertion was reproduced using the HEAD script after confirming all its relevant utility modules are unchanged. The approved FITTED/report rules were not changed to mask this unrelated failure. Checks after that stopping point were run separately.

`node scripts/local-parts-isolation-check.js` cannot complete its database phase because `DATABASE_URL` is absent. No configured PostgreSQL test connection or PostgreSQL CLI/container runtime was available. Database concurrency, rollback, exact persisted bin deduction, and live browser acceptance are therefore pending. Use an isolated test database and authenticated test dealer/audit to finish the matrix before certifying the fix.
