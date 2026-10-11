# Dealer isolation follow-up — 11 October 2026

The earlier isolation change left Admin reads without a dealer context, an unscoped pending-sync inventory query, mobile sync totals filtered only by device, and bin/audit mutations identified only by record ID. Scanner registration also resolved a global active audit. These paths could cross dealer boundaries despite the existing part-search and scan-edit protections.

## Changes

- Authentication requires exactly one dealer for dealer-specific routes, including Admin reads. It rejects conflicting aliases, nested report filters, mixed batches, missing/ALL context, unknown dealers and inactive dealers. A user with one assigned dealer can derive that dealer from the server mapping.
- The selected dealer is resolved to a database record; its primary key and canonical code are recorded in the request and response headers. Existing transaction storage and foreign keys continue to use dealerCode.
- Pending-sync inventory, mobile sync status, device lists and device totals use the selected dealer.
- Bin edit/delete and audit close/complete/reopen/status operations include dealer ownership in lookup and mutation filters.
- Scanner registration/heartbeat resolve the active audit within the supplied dealer rather than choosing the global active audit.
- Desktop requests carry Admin dealer context, preserve an explicit queued scan's dealer, check response dealer headers and reject late responses using a generation counter, including A → B → A. Dealer switches clear history and caches, abort dashboard/report requests and block scan writes until the selected audit context loads.
- APK sync batches use the queued record's original dealer, process one dealer per batch, and retain other dealers for subsequent batches. Missing original dealer identities are marked for review rather than reassigned. Authenticated mobile reads attach dealer context.

## Validation

- Full npm test suite passed; database-dependent migration and Local Parts checks were skipped because DATABASE_URL is not configured.
- JavaScript build check passed for 205 files; final syntax checks and 37 focused regressions passed after the audit/scanner additions.
- Added authenticated API regressions covering missing/ALL/unknown dealer rejection, unauthorized requests, inferred assigned dealer, 20 concurrent alternating dealer reads, mobile sync status, cross-dealer bin modifications, nested report conflicts and cross-dealer audit operations.
- Added browser logic regressions covering late responses after A → B → A, queued dealer preservation and dealer-specific scanner audit resolution.
- Dart analysis of api_client.dart and sync_service.dart passed after flutter pub get.
- Flutter tests exposed a pre-existing assertion that treated the selected input text as an open suggestion. The assertion now checks that the suggestion Text widget closes while preserving the selected EditableText value.
- All 10 Flutter tests passed after that assertion correction.

## Production acceptance still requires evidence

No production database access, migrations, stock resets, reassignment, deletions or historical corrections were performed in this follow-up. No new database constraints were added. The existing NOT VALID dealer/audit constraints and nullable legacy fields still require backup-based investigation and validation. Converting transaction ownership from dealerCode to immutable dealer primary-key columns requires a separately tested schema migration; this change does not claim that conversion.

The contamination triage SQL remains a prepared query, not an executed investigation report. A verified PostgreSQL backup, isolated PostgreSQL concurrency/rollback tests, phone/APK retesting, deployment confirmation and safe live API/write verification remain required before certifying the complete P0 acceptance checklist.
