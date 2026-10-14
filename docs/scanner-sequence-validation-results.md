# Barcode / QR scanner validation — October 14, 2026

The fix is implemented on `testing/scanner-sequence-validation-20261014` and deployed to [Railway testing](https://neha-testing-testing.up.railway.app/dashboard). Production rollout requires the user's approval.

## Behavior

- `20K211S`, `20K411S`, and `41241AAN410S` are rejected in scanner input, including requests that supply a 1D barcode-format hint.
- Rejections show **Invalid Barcode / QR Sequence** and the requested instruction to use Manual Entry, Local Part, or Excel Stock Upload.
- The supplied Hero 1D packaging labels and padded QR formats remain supported. Encoded QR quantities and UPI duplicate protection remain authoritative on the server.
- Valid numeric EAN/UPC identifiers use their check digit. Decoder-supplied supported 1D identifiers remain supported. Standalone UPI identifiers require a matching previously validated identity in the same dealer/audit.
- Manual Entry retains part-master, quantity and bin validation. Local Part and Excel upload stock logic are unchanged by this fix.
- No historical audit or inventory migration is performed. Browser cache query parameters refresh the scripts without changing the mobile offline database/version identity.

## Verification

| Check | Result |
| --- | --- |
| Dedicated scanner regression suite | 10 passed |
| Full Node test command on the isolated release | Passed; optional database-dependent checks skip when their dedicated connection is absent |
| JavaScript build check | Passed |
| Isolated PostgreSQL integration | 2 passed, with a real database connection |
| Flutter tests | 12 passed |
| Desktop browser, admin and audit-user roles | Passed: zero save requests for invalid input, valid 1D quantity 1, padded QR quantity 4, and plain-part Manual Entry |
| Live testing API acceptance | 28 checks passed |
| Live testing browser | Passed: all three supplied plain part numbers show the requested error and send zero inventory-save requests |

PostgreSQL coverage includes INWARD, OUTWARD, DAMAGE and FITTED, QR quantities 1–100, duplicate/concurrent duplicate blocking, saved standalone UPI outward movement, genuine Hero 1D labels, numeric EAN-13, dealer isolation, manual entry and offline synchronization. Stock/report totals remain consistent. Invalid submissions leave complete inventory, bin and audit snapshots unchanged. Synthetic test cleanup is restricted to that run's random dealer in the guarded local fixture database.

Live testing compared history, audit, bins and stock before and after the rejection checks. The existing 29 history rows and all compared snapshots were unchanged; `/api/ready` returned success. Existing Bluetooth functionality is disabled and remains disabled (HTTP 410).

Mobile camera transport, offline guard and parser behavior are covered by automated tests. Physical handheld scanner and phone-camera hardware acceptance has not been performed in this session.

## Changed files

- Shared validation: `public/js/scan-parser.js`, `services/ScannerSequenceValidationService.js`.
- Backend enforcement and error propagation: `routes/sync.js`, `routes/inventory.js`, `services/ScanProcessingService.js`.
- Desktop/mobile browser flows and cache keys: `public/ui.js`, `public/scan.js`, `public/Daksh.html`, `public/scan.html`.
- Native mobile capture guard: `mobile_scanner_app/lib/utils/scan_parser.dart`, `mobile_scanner_app/lib/screens/scanner_home_screen.dart`.
- Tests: `test/scanner-sequence-validation.test.js`, `test/barcode-quantity-postgres.integration.test.js`, `test/barcode-save-performance.test.js`, `test/camera-code-parser.test.js`, `mobile_scanner_app/test/scan_parser_test.dart`, `scripts/scanner-sequence-browser-check.js`, `package.json`.
- Documentation: `docs/scan-flow-stock-logic.md`, this report.

Unrelated Excel upload, password-reset and other local work is preserved in the main workspace. The release checkout contains only this scanner change over the existing testing branch.
