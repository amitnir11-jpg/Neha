# SAFE DELETE REPORT

Date: 2026-06-20

## Scope

Review performed for deployment/startup files, legacy Windows launchers, Render config, MongoDB references, and temp/log files.

## Confirmed Keep

- `package.json` because `npm start` uses `node scripts/railway-start.js`.
- `scripts/railway-start.js` because it is the primary startup path for Railway and local `npm start`.
- `mobile_scanner_app/android/gradlew.bat` because it is part of the Android build wrapper and is not an app startup script.
- `.env` / `.env.example` because they are environment templates, not startup junk.

## Confirmed Unused / Safe To Remove

- `start.bat`
- `start_daksh.bat`
- `start-daksh.bat`
- `start-daksh-hidden.vbs`
- `stop-daksh.bat`
- `open-daksh.bat`
- `render.yaml`

## Notes

- The Windows launcher files only referenced one another and were not referenced by `package.json`, Railway startup, or Prisma.
- `render.yaml` is an old Render deployment config and is not referenced by the current Railway startup flow.
- No tracked `.log`, `.tmp`, `.bak`, `.old`, `.pid`, or other temp files were found in the repository root during this review.
- MongoDB-specific runtime code was not found in the current startup path. Existing `MONGO_*` variables appear only in environment templates and are not required for the Railway/PostgreSQL startup flow.

## Files Marked For Review

- None.
