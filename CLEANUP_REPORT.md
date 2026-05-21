# Daksh Inventory Cleanup Report

Cleanup date: 2026-05-17

Backup created before cleanup:

- `D:\New daksh inventory\backup_before_cleanup_20260517_203317`

Size summary:

- Project size before cleanup: 1049.98 MB
- Active project size after cleanup, excluding `_cleanup_quarantine`: 181.63 MB
- Quarantine size: 868.36 MB
- Physical project folder size including `_cleanup_quarantine`: 1049.99 MB
- Note: no files were permanently deleted. Quarantined files still exist under `_cleanup_quarantine`.

## Files Safe To Delete

These files/folders were moved to `_cleanup_quarantine` instead of being deleted.

| Path moved to quarantine | Reason |
| --- | --- |
| `backups/` | Old database backup snapshot from 2026-05-07. No active code references `backups` or `db-backup`. A new full project backup was created before cleanup. |
| `logs/` | Runtime log output only. Active server code does not require historical log files. |
| `daksh-server-restart.err.log` | Runtime log file. |
| `daksh-server-restart.log` | Runtime log file. |
| `daksh-server.log` | Runtime log file. |
| `server_port.txt` | Runtime marker written again by `server.js` on startup. |
| `server_process.pid` | Runtime marker used by batch startup scripts; can be regenerated. |
| `old-reference/` | Empty old-reference folder. |
| `routes/build/` | Flutter/Android generated build output, including APK/build intermediates. Not required by the Node server. |
| `routes/.dart_tool/` | Flutter generated tool cache. Not required by the Node server. |
| `routes/android/.gradle/` | Gradle cache/build metadata. Not required by the Node server. |
| `routes/.idea/` | IDE metadata. Not required at runtime. |
| `routes/test/` | Old Flutter widget test folder. Not used by the current Node backend. |
| `routes/auth.controller.js` | Old PostgreSQL auth backend remnant. Current app uses `routes/auth.js`. |
| `routes/auth.middleware.js` | Old PostgreSQL auth backend remnant. Current app uses `routes/auth.js`. |
| `routes/auth.routes.js` | Old PostgreSQL auth backend remnant. Current app uses `routes/auth.js`. |
| `routes/db.js` | Old PostgreSQL database helper. Current app uses MongoDB/Mongoose models. |
| `routes/device.js` | Unreferenced old route stub. Current app uses `routes/devices.js`. |
| `routes/server.js` | Old nested backend server entry. Current app starts from root `server.js`. |
| `routes/package.json` | Old nested backend package file. Current app uses root `package.json`. |
| `public/assets/images/warehouse-bg.jpg` | Unreferenced image; no HTML/CSS/JS reference found. |

Correction during verification:

- `routes/report.js` was first classified as safe because root `server.js` does not mount it directly.
- Startup verification showed `routes/reports.js` imports `./report`, so `routes/report.js` was restored immediately from `_cleanup_quarantine`.
- It is now listed under "Files Must Keep".

## Doubtful / Need Manual Review

These were not moved because they may still be useful even if they look redundant.

| Path | Reason |
| --- | --- |
| `public/dashboard.html` | Not used by the `/dashboard` route, which serves `public/Daksh.html`; kept because it remains reachable as a static file. |
| `routes/dashboard_screen.dart` and `routes/lib/dashboard_screen.dart` | Exact duplicate content, but mobile source ownership is unclear. |
| `routes/app_theme.dart` and `routes/lib/app_theme.dart` | Exact duplicate content, but mobile source ownership is unclear. |
| `routes/splash_screen.dart` and `routes/lib/splash_screen.dart` | Exact duplicate content, but mobile source ownership is unclear. |
| `routes/custom_button.dart` and `routes/lib/custom_button.dart` | Exact duplicate content, but mobile source ownership is unclear. |
| `routes/custom_textfield.dart` and `routes/lib/custom_textfield.dart` | Exact duplicate content, but mobile source ownership is unclear. |
| `routes/app_router.dart` and `routes/lib/app_router.dart` | Exact duplicate content, but mobile source ownership is unclear. |
| `routes/main.dart` and `routes/lib/main.dart` | Exact duplicate content, but mobile source ownership is unclear. |
| `routes/.flutter-plugins`, `routes/.flutter-plugins-dependencies`, `routes/.metadata`, `routes/pubspec.lock` | Generated/lock metadata for Flutter; kept to avoid affecting mobile development. |
| `routes/ios/RunnerTests/`, `routes/macos/RunnerTests/` | Template test folders; kept because they belong to the mobile source tree. |
| `start_daksh.bat` and `start.bat` | Exact duplicates, but both are user-facing launch shortcuts. |

## Files Must Keep

| Path | Reason |
| --- | --- |
| `server.js` | Active Node/Express entry point. |
| `package.json`, `package-lock.json` | Active dependency and start script definitions. |
| `node_modules/` | Current dependency install used by the running app. It is ignored by git but not quarantined. |
| `.env`, `.env.example` | Runtime configuration and sample environment file. `.env` is now ignored by git. |
| `models/` | Active Mongoose models used by server routes. |
| `utils/` | Active shared helpers including audit, catalogue, normalize, and network utilities. |
| `config/` | Active configuration helpers. |
| `routes/auth.js`, `routes/admin.js`, `routes/adminDelete.js`, `routes/users.js` | Active login/admin/user APIs mounted by `server.js`. |
| `routes/bin.js`, `routes/binMaster.js`, `routes/binTransfer.js` | Active bin and transfer APIs mounted by `server.js`. |
| `routes/dashboard.js`, `routes/inventory.js`, `routes/reports.js`, `routes/dealer.js` | Active dashboard, scan/inventory, reports, and dealer setup APIs. |
| `routes/devices.js`, `routes/master.js`, `routes/masterCatalogue.js` | Active device and master data APIs. |
| `routes/backup.js`, `routes/reconciliation.js`, `routes/qr.js`, `routes/audit.js` | Active backup, reconciliation, QR, and audit APIs. |
| `routes/sync.js`, `routes/mobile.js` | Active mobile sync APIs mounted at `/api/sync` and `/api/mobile`. |
| `routes/report.js`, `routes/reports.js` | Active reports implementation. `routes/reports.js` imports `routes/report.js`. |
| `public/index.html` | Active login page served at `/`. |
| `public/Daksh.html` | Active dashboard app served at `/dashboard`. |
| `public/report.html` | Active report page served at `/report`. |
| `public/style.css`, `public/ui.js` | Active dashboard app CSS and JavaScript. |
| `public/css/style.css`, `public/js/app.js` | Active login/report public CSS and JavaScript. |
| `public/downloads/daksh-mobile-scanner.apk` | Active APK served by `/apk`, `/download-apk`, and `/api/apk/download`. |

## Git Ignore Update

Created root `.gitignore` and added the requested cleanup ignores:

- `node_modules/`
- `dist/`
- `build/`
- `.env`
- `*.log`
- `uploads/temp/`
- `backup*/`
- `_cleanup_quarantine/`
- `*.zip`
- `*.apk`

Additional runtime/cache ignores were added for `server_process.pid`, `server_port.txt`, `logs/`, `.dart_tool/`, `.gradle/`, and `.idea/`.

## Verification

Completed after cleanup:

| Check | Result |
| --- | --- |
| `npm install` | Passed. Dependencies were already up to date; 277 packages audited. |
| Active backend JS syntax | Passed for `server.js` and 21 active route files. |
| `npm start` | Passed after restoring `routes/report.js`; app is listening on port 3001. |
| MongoDB connection | Passed. `/api/health` reports `mongodb=online`, `mongoStatus=online`, `serverStatus=online`. |
| Login page `/` | 200 OK. |
| Dashboard page `/dashboard` | 200 OK. Contains Scan, Reports, Users, and Dealer text. |
| Reports page `/report` | 200 OK. |
| Dashboard API `/api/dashboard/stats` | 401 Unauthorized, expected without login token; route is alive. |
| Scan API `/api/inventory/live` | 200 OK. |
| Scan save API `/api/inventory/scan` | 400 Bad Request for empty test body, expected; route is alive. |
| Reports API `/api/reports/main-inventory-audit` | 401 Unauthorized, expected without login token; route is alive. |
| Users API `/api/users` | 401 Unauthorized, expected without login token; route is alive. |
| Dealer setup API `/api/dealers` | 401 Unauthorized, expected without login token; route is alive. |
| Mobile device status `/api/mobile/status/test-device` | 200 OK. |
| Mobile sync status `/api/sync/status` | 200 OK. |
| APK download `/api/apk/download` | 200 OK; active APK was kept. |

Startup notes:

- Current listener: `node server.js` on port 3001.
- Startup stderr contains existing Mongoose/index warnings, but the server starts and health reports MongoDB online.
