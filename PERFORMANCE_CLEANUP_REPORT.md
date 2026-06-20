# Performance Cleanup Report

Date: 2026-06-20

## Scope

I scanned the repository to identify dead code, generated artifacts, duplicate wiring, and the main performance bottlenecks causing slow loads and report hangs.

This report is written **before any deletion**, so the cleanup stays conservative and reversible.

## Confirmed Architecture

- The live backend is **Prisma + PostgreSQL**, not MongoDB.
- Main data access layer:
  - `services/prisma.js`
  - `prisma/schema.prisma`
  - `models/prismaModel.js`
  - `models/registry.js`
- Report-heavy logic is mainly in:
  - `routes/report.js`
  - `routes/reports.js`
  - `public/ui.js`

## Confirmed Safe-to-Delete Generated Artifacts

These are build outputs, IDE caches, or runtime logs. They are not business features.

### Flutter / mobile scanner build output

- `routes/.dart_tool/`
- `routes/build/`
- `routes/.flutter-plugins`
- `routes/.flutter-plugins-dependencies`
- `mobile_scanner_app/.dart_tool/`
- `mobile_scanner_app/build/`
- `mobile_scanner_app/.idea/`

### Runtime / server logs and pid files

- `codex-start.err.log`
- `codex-start.out.log`
- `server-3002.err.log`
- `server-3002.out.log`
- `server-current.err.log`
- `server-current.out.log`
- `server-restart.err.log`
- `server-restart.out.log`
- `server.err.log`
- `server.out.log`
- `server.stderr.log`
- `server.stdout.log`
- `server_port.txt`
- `server_process.pid`

### Local app artifacts

- `routes/routes.iml`
- `mobile_scanner_app/mobile_scanner_app.iml`

## Review-Only Items

These may be old or generated, but I am not deleting them yet because they may still be useful to the Flutter toolchain or to the team.

- `routes/.metadata`
- `mobile_scanner_app/.metadata`
- `mobile_scanner_app/test/widget_test.dart`
- `routes/.gitignore`
- `mobile_scanner_app/.gitignore`
- `routes/.env.example`
- `mobile_scanner_app/README.md`

## Likely Duplicate / Unnecessary Wiring

- `routes/reports.js` requires `./report` twice:
  - `const router = require('./report');`
  - `const reportModule = require('./report');`
- The `router` variable is used for route registration, while `reportModule` is used for report builders. This is not a bug, but the duplicate import is unnecessary and can be simplified safely.

## Performance Hot Spots

### 1) Report loading still does too much work in memory

- `routes/report.js` `buildReportData()` fetches large scan sets and then groups, filters, and enriches them in JavaScript.
- This causes full-data loading, which is the biggest cause of slow report responses and hanging pages.

### 2) Front-end report filters still depend on submit-driven refreshes

- `public/ui.js` has report filter change handlers that update UI state, but not all filters auto-trigger a debounced reload.
- The report loader already has abort logic, but several filter changes still leave the user guessing whether a request is in progress.

### 3) Dashboard refreshes can stack up

- `public/ui.js` `loadDashboard()` deduplicates some work, but multiple force-refresh paths still exist.
- Socket events and timers can trigger repeated reloads.

### 4) Pagination is only partially effective

- Some APIs accept `page` / `limit`, but several report paths still build a full result set first and page later.
- This makes “showing the first page” nearly as expensive as loading everything.

### 5) Index coverage is incomplete for the way data is queried

- Current Prisma indexes cover several top-level fields.
- Several important report fields live inside JSON-backed rows or mirrored data, so some filters still need query-side work or new database indexes.

## Known Data / Filter Fields To Improve

Priority fields for auto-filtering and query optimization:

- dealerCode
- partNumber
- upiCode
- barcode
- binLocation
- category
- productGroup
- scanStatus
- movement
- createdAt

## Cleanup Plan

1. Remove only the confirmed generated artifacts listed above.
2. Keep review-only items unless a later pass confirms they are safe to delete.
3. Add debounced auto-filter loading in the report UI.
4. Strengthen request cancellation so the latest filter selection wins.
5. Reduce report and dashboard full-load behavior.
6. Add or migrate indexes where the data model supports it safely.

## Notes

- No evidence was found that the app uses MongoDB in the live code path.
- I did not delete any live business feature before writing this report.
- Any file not clearly safe should stay in review until confirmed.
