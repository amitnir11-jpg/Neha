# Barcode/Web Scan layout and validation — 2026-10-06

The operator workspace is implemented and verified with local browser/API fixtures. Physical USB scanner operation, audible beep on the user's device, authenticated production stock movements, and production report/reconciliation comparisons remain pending. This document is not a production inventory sign-off.

Before editing, the clean working version was preserved as `backup/barcode-layout-20261006`, pointing to `2e04673`. No schema, migration, database record, inventory calculation, pricing calculation, role rule, mobile scanner implementation, or WebSocket subscription was changed.

## Existing implementation traced before editing

`public/Daksh.html` supplies the four existing scan tabs, `barcodeScanForm`, the shared Scan History, and the manual entry form. `public/ui.js` owns their handlers.

Relevant existing state: user/token, dealer lists and assigned dealers, active dealer and audit, device ID, `barcodeAutoSaving`, `barcodeLastRaw`, `barcodeLastAt`, barcode scan/duplicate/server-check maps, Part Master lookup cache and pending lookup promises, history records/summary/sort/request ID, recent realtime IDs, refresh timers, and the existing scoped offline sync queue. Bin persistence uses `BARCODE_LAST_BIN_KEY`. New presentation/capture state is `barcodeCaptureQueue`, `barcodeLastCaptureKey`, `scanHistoryPage`, pagination, and the saved full history header.

The existing input/change/Enter/Tab/form-submit handlers feed `scheduleBarcodeAutosave` and `submitScan`. `normalizeScanPayload`, `parseRawScanText`, and the shared `DakshScanParser` parse ordinary, QR and UPI values. `submitScan` still sends the central `POST /api/scans/process` request and handles backend duplicate, unknown-part, fitted, smart-bin and offline responses. The existing queue and request IDs remain in use.

Part lookup still uses `bindSuggestions`, `fillPart`, and cached `validatePartAgainstMaster` (`GET /api/mobile/validate-part`). Pricing is supplied by the existing backend/Part Master. Bin suggestions still use `loadBarcodeBins` (`GET /api/qr/bins`), with manual typing supported by the original datalist input. Dealer/bin ownership checks in the save endpoint are unchanged.

Live updates still pass through `bindSocket` → `handleNewScan` → `prependScanHistory`. No listener or subscription was added to the socket. The existing `isAdminUser`, `canEditScanDetails`, auth middleware, destructive-action functions, and backend permission checks remain authoritative.

## Files and changes

| File | Change |
| --- | --- |
| `public/Daksh.html` | Workflow steps, bin state, compact context row, barcode/manual panels, readonly Part Master details, independent labelled history filters, pagination and cache version. Four tabs retained. |
| `public/barcode-workspace.css` | Scoped responsive layout, compact history, type badges, beep switch, and explicit hiding of restricted admin buttons. Uses the existing control cascade layer so shared legacy styles do not override it. |
| `public/ui.js` | UI adapters, mandatory bin guard, persistent bin, capture queue and shared lock, manual-form adapter, cached detail lookup, history display/pagination/filter handling, and insertion of new live records. Existing processing functions retained. |
| `routes/inventory.js` | History-only limit floor of 10; optional `partMatch=partial` for substring search. Default limit 100 and existing exact-first callers retain their behavior. |
| `test/barcode-save-performance.test.js` | Existing scanner harness adapted to capture snapshots; added three consecutive scans while a save is pending. |
| `test/barcode-workspace.test.js` | Actual history handler tests for pagination, combined filters and partial search; live insertion/deduplication/cap regression. |
| `scripts/barcode-workspace-browser-check.js` | Opt-in Chrome/Playwright fixture checks using the actual HTML, styles and complete frontend scripts. No production writes. |
| `docs/barcode-workspace-validation.md` | This implementation and validation record. |

Barcode entry requires a selected bin for all four displayed movement types. Bin QR values such as `BIN:A-01` and `BIN=A-01|PART=...` select the source bin without saving a part. Existing UPI stock-location resolution remains a backend rule. Successful saves and Clear retain the selected dealer, bin and movement type; clearing the bin is an explicit action.

Manual entry adapts a detached clone of the existing Manual Entry form and calls `submitScan`, preserving its validation and duplicate-confirmation path. It does not modify the actual Manual Entry tab or grant the special Scan History outward exception. Manual OUTWARD/FITTED remain subject to the existing backend stock/UPI rules.

Scanner suffix, idle autosave and Save share one timer/capture path. Each capture snapshots the fields and frees the raw input before its request. Captures are processed serially through `submitScan`; the manual button shares the in-progress lock. The existing server request identity and duplicate rules still apply.

History defaults to ten records in Barcode/Web Scan, remains paginated and filtered on the server, and retains the full columns in other scan tabs. New committed scans are inserted once and capped at ten. A successful ordinary save does not reload history or the Scan page. Search/Clear operate independently from scan context. Administrative deletion remains permission-gated.

## Validation and limits

- Build: `npm run build` passes (Prisma generation and JavaScript syntax checks). No separate lint/type-check script is configured.
- Four new workspace regressions pass: ten-row pagination, substring matching even when an exact record exists, independent combined filters, and live insertion/deduplication.
- Scanner/request/manual suite: 16 passed; one database-dependent migration test skipped without `DATABASE_URL`. Includes idle autosave, Enter, Tab, Save and three captures during an in-flight request.
- Additional manual, scan-save, outward, request, dashboard and Part Master tests: 26 passed.
- Report suite: all 59 passed. Pricing, stock valuation/reconciliation, category and duplicate policy checks passed. Movement calculation check passed. These verify fixture calculations; actual production audit values were not compared.
- Full `npm test` still stops at the existing fitted-quantity assertion in `scripts/report-scan-quantity-check.js:48` (`0 !== 1`). Its calculation code and fixture were not changed.
- The separate mobile regression script fails at line 53 on a literal LF-only source assertion. The untouched native file has CRLF endings; normalizing the string to LF makes that assertion match. No mobile code was changed to silence this test.
- Chrome fixture checks pass for both admin and audit-user sessions: dealer selection, bin list selection, bin QR, missing-bin rejection, bin retention, INWARD/OUTWARD/FITTED/DAMAGE requests, manual entry, quantity 3, registration/job card fields, cached autofill, known/unknown parts, invalid input, duplicates, rapid captures, Enter, beep toggle, immediate/live socket history updates, filters, Search/Clear, and administrative visibility/action restrictions. These are frontend integration checks with mocked API responses, not successful production stock operations.
- Chrome checks confirm four history rows visible at 1366×768, 1440×900 and 1920×1080. No unexpected JavaScript console errors were observed in either fixture session. Expected rejected-request responses are excluded from that count.
- Screenshots are `.codex-artifacts/barcode-workspace-1366.png`, `barcode-workspace-1440.png`, and `barcode-workspace-1920.png`; the JSON result is `.codex-artifacts/barcode-workspace-results.json`.
- Railway log inspection found recent PostgreSQL `terminating connection due to administrator command` messages. The existing deployed service's subsequent health probe returned `ready: true`, `status: OK`, and initialization `ready`. This is not evidence that the new scan workspace was tested against production.

Run the optional browser check with Playwright installed, or set `PLAYWRIGHT_MODULE` to its local module path. `CHROME_PATH` can select a local Chrome executable. The runner serves local static files and intercepts every API call with fixtures.

API changes: only the optional history filter and supported page size above. Scan-save API, QR payloads, stock/pricing APIs, role checks and socket event contracts are unchanged. Database changes: **NONE**.

Required operator sign-off: physical USB scanner, audible beep, genuine UPI/stock validation for outward/fitted, offline recovery, and before/after report and reconciliation values for an authenticated test audit. A test-session question was raised; no test session was supplied during implementation.

If you are unsure whether any code is used by another module, do not delete or change it. Trace its references first and report to me before modifying it.
