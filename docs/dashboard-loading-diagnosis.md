# Dashboard loading diagnosis — 2026-10-04

Status: public production health confirms failed backend initialization and a PostgreSQL connection closure. The startup retry defect is reproduced locally; its recovery fix already exists among the user's pre-existing uncommitted changes. The permanent-refresh defect is also reproduced and fixed locally. Authenticated dealer data and the two failed queue entries remain unverified; this is not a production success sign-off.

## Required findings

| Item | Evidence |
| --- | --- |
| ROOT CAUSE | Confirmed live blocker: backend initialization is failed and health readiness remains false after a PostgreSQL connection closure. Committed startup code reproduces the same connected-database/failed-initialization state and schedules no retry. Separately, dashboard and live-bin fetches had no timeout, preventing refresh cleanup on a stalled request. |
| FAILED API | The locally reproduced stalls are `GET /api/scans/dashboard?dealerCode=11688&range=audit` and `GET /api/scans/live?limit=200&dealerCode=11688&range=audit`. Which request actually failed in production is unknown. |
| HTTP STATUS | Live `/api/health`: 503. Live `/dashboard` and `/api/ping`: 200. Unauthenticated dashboard/live/me probes: 401 Login required, expected without credentials. The authenticated dashboard response is still unknown. |
| BACKEND ERROR | Live health reports `applicationInitializationStatus: failed`, `ready: false`, `databaseStartupStatus: retrying`, and 29 attempts; its last attempt was over nine hours before inspection. |
| DATABASE QUERY/ERROR | Live error: `Invalid prisma.$queryRaw() invocation: Server has closed the connection.` Exact SQL and stack trace require Railway logs. Database status simultaneously reports connected. |
| FILES RESPONSIBLE | Startup retry/readiness: `server.js` and `services/prisma.js`; existing authentication recovery also involves `routes/auth.js` and `utils/databaseErrors.js`. Frontend refresh defects: `public/ui.js`. Dashboard script cache version: `public/Daksh.html`. |

## Live production evidence

Public HTTPS probes at approximately 18:26 IST on 4 October 2026:

| Request | Status | Elapsed |
| --- | --- | --- |
| GET `/dashboard` | 200 | 836 ms |
| GET `/api/health` | 503 | 421 ms |
| GET `/api/ping` | 200 | 249 ms |
| GET `/api/scans/dashboard?dealerCode=11688&range=audit` without credentials | 401 | 273 ms |
| GET `/api/scans/live?limit=200&dealerCode=11688&range=audit` without credentials | 401 | 252 ms |
| GET `/api/auth/me` without credentials | 401 | 256 ms |
| GET `/ui.js` | 200 | 469 ms |

Health reports version 2.0.43, build 44, database schema 13; last initialization attempt `2026-10-04T03:50:49.787Z` (09:20:49 IST), no successful initialization timestamp, schema verification true, and database connection time `2026-10-04T03:50:55.728Z`. Its database URL is configured; the local absence of DATABASE_URL is therefore unrelated to the live failure. The deployed script lacks the dashboard timeout and missing-summary checks introduced locally. The served HTML still references `/ui.js?v=20261004-barcode-save-v2`.

The committed startup code returns early and suppresses scheduling on `isDatabaseReady()`, rather than requiring full `applicationReady()`. Its failure handler does not invalidate the database readiness flag. A local replay of connection success, schema verification and later query failure produces `schemaVerified=true`, `initializationStatus=failed`, `databaseConnected=true`, `applicationReady=false`, and **zero queued retries**. This matches the live readiness inconsistency, though the exact failed SQL is unavailable.

The user's existing recovery changes in `server.js` and `services/prisma.js` already require complete application readiness and invalidate database readiness after failed initialization. New regressions in `test/dashboard-backend-recovery.test.js` verify that the real scheduler retries, reconnects and completes initialization after the first connection closure; both pass. No additional rewrite of those files was necessary.

## Initialization and request path from source

`server.js` serves `public/Daksh.html` for `/dashboard`; the standalone `public/dashboard.html` and `public/js/audit-dashboard.js` are not this page's entry points.

Startup validates the stored bearer token through `GET /api/auth/me`, restores dealer/view state, binds sockets and starts the existing 60-second health and queue timers. Browser desktop device-connect and heartbeat functions return early for non-mobile clients. `refreshAll()` awaits `GET /api/master/dealers` before starting dashboard loading, sync status, and smart-bin settings reads.

| Method / path | Purpose / scope |
| --- | --- |
| GET `/api/auth/me` | Validate authenticated user; bearer token, not logged in this report. |
| GET `/api/master/dealers` | Obtain accessible dealers and initialize selected dealer. |
| GET `/api/scans/dashboard` | Summary and bounded recent scans; `dealerCode`, `range`, optional explicit audit scope; manual refresh adds `refresh=true` and a timestamp. |
| GET `/api/scans/live?limit=200` | Top-bin widget using the same dashboard query scope. |
| GET `/api/health` | Health indicator; existing overlapping status-read deduplication and 15-second timeout. |
| GET `/api/sync/status` | Server queue status; also reads health first. |
| GET `/api/settings/smart-bin-suggestion` | Existing scan settings read. |
| GET `/api/scans/live?limit=12`, then `/api/scans/recent?limit=12` | Conditional recent-stream fallback if summary indicates activity but has no recent rows. |
| GET `/api/audit/active?dealerCode=…` | Dealer selection / queue-retry audit lookup. |
| POST `/api/scans/process` | Conditional queued scan retry; existing 20-second timeout and duplicate policy. |

This is a source trace, not an observed production network capture. Exact response times, statuses, authenticated role, resolved audit ID and response errors require the failing session. Mobile clients, restored views and queued records can add requests.

The frontend's Current audit dashboard normally sends the dealer and range; `activeDashboardScope()` resolves the active audit server-side through `utils/audit.js`, the same helper used by the active-audit API. If no active audit exists, the existing dashboard behavior selects the most recently started audit. Missing contexts use explicit no-dealer/no-audit sentinels. No audit is created by dashboard loading. Dealer 11688's actual audit and cross-module relationships remain unverified.

## Backend performance observations

The existing summary endpoint returns aggregate cards plus 20 recent scans. Its builder calls report calculations and valuation reconciliation. `Inventory.aggregate()` is implemented by `AggregateQuery.exec()` in `models/prismaModel.js`: it reads matching rows and runs the pipeline in JavaScript. The `$facet`/`$group` syntax therefore does not demonstrate PostgreSQL-side aggregation. This is a performance concern that needs query timings and row counts, not a proven production cause.

The Prisma schema contains dealer, audit, part and several compound indexes. Actual production index presence and query plans were not inspected. No indexes or migrations were added, and no database writes were made by this fix.

## Sync investigation boundary

`syncCounts()` reads the browser's dealer/audit-scoped queue. Its total includes failed entries, so Pending 2 and Failed 2 can describe the same two entries. Actual values cannot be confirmed without the session's queue and log. Existing sync logs retain `errorMessage`; queue retries call `/api/scans/process`. Nothing in the queue, retry rules, saved transaction identity or duplicate prevention was changed.

## Minimal changes

- `public/ui.js`: give dashboard GET requests a 30-second timeout, including response-body parsing; identify the timed-out dashboard path in the error.
- Reject failed or missing-summary payloads before rendering cards, preserving existing totals on failure.
- Check request identity after asynchronous widget/fallback/health work; cancel remaining widget work when a refresh ends.
- Keep existing refresh `finally`, ordinary-request deduplication, page layout, API contracts, business formulas and polling behavior.
- `test/dashboard-loading.test.js`: five focused regressions for stalled summary, stalled widget, stale dealer response, malformed summary and overlapping ordinary refresh.
- `public/Daksh.html`: change only the `ui.js` version query to ensure browsers fetch the dashboard fix despite immutable static caching; preserve the user's existing changes to this file.
- `test/dashboard-backend-recovery.test.js`: two regressions validating the existing backend recovery changes against the production readiness state.

## Validation

- New dashboard tests: 5 passed; the two stall tests failed before the fix.
- Existing status-request tests: 5 passed.
- Existing barcode/manual-save tests: passed; database repair integration test skipped without database access.
- Existing report-cache tests: 3 passed.
- Master pricing, stock valuation, category alignment, UPI duplicates, part/bin duplicates, movement calculation, cache safety, Prisma mirror types, mobile scanner, dealer-stock workbook: passed.
- Existing authentication recovery and network tests: 11 passed.
- `npm run build`: passed, including Prisma client generation and JavaScript syntax checks.
- `prisma validate`: passed using a dummy URL for schema-only validation; no database connection or migration.
- `npm test`: stopped at `scripts/report-scan-quantity-check.js:48`. Its legacy `fitted_on_vehicle` fixture expects fitted quantity 1 but receives 0. This assertion calls untouched business utilities before any frontend source checks. No business-rule change was made to satisfy it.
- `scripts/local-parts-isolation-check.js`: could not complete because DATABASE_URL is unavailable.

## Required production follow-up

The dashboard URL is available and public probes are recorded above. Obtain Railway startup logs and an authenticated inspection session or read-only runtime access. Capture authenticated request URLs, selected dealer/audit, role, status, timings and sanitized errors; correlate them with Railway/Prisma logs. Inspect the two queue error messages before retrying. Confirm dealer 11688's current audit, reconcile summary values with Scan Report, Reconciliation, Bin Inventory and fitted/dealer stock, and perform the requested interactive permissions/device/scanner regressions. No commit, push or deployment was performed because authenticated validation remains incomplete and the existing quantity regression still fails.
