# Daksh Inventory Solution v2 — testing build report (16 October 2026)

Status: **testing build only; production release is unchanged**.

## Build and rollback

- Branch: `mobile/apk-v2-production-connection`.
- Test APK: `D:\Daksh\Neha-main-github\.codex-artifacts\apk-v2-testing-20261016\daksh-inventory-v2-testing-1.2.21+28-release.apk` (69,914,422 bytes; SHA-256 `AA513D1D43DF8879F8D521FC1558C9B737AEB00E23B7F6606038B87019C8FCF3`).
- Package/version: `com.daksh.inventory.scanner`, `1.2.21` (code 28). This test build is compiled for `https://neha-testing-testing.up.railway.app`.
- APK signing certificate SHA-256: `14f0191a2dde8cbe83e44c36051632fa67307cb717d0d45290602bf842071f97`, matching the existing production APK. The project currently signs release builds with the Android debug key; this is compatible with the existing APK, but a dedicated production signing setup should be planned before wider distribution.
- Current production APK backup: `D:\Daksh\Neha-main-github\.codex-artifacts\apk-v2-backup-20261016\daksh-mobile-scanner-before-v2.apk` (SHA-256 `CEEF7FD118EBDF6C570193619894D002E405A0D44A17883B4BED0181FC773C1B`). The production download has the same checksum and was not overwritten.
- Rollback: keep or reinstall the backed-up APK. As this build increments Android version code, Android may require uninstalling the test version before installing the older APK; export and retain pending scans first, as uninstalling clears app-local data.

## Cleanup

- Removed one copied, unoptimized debug test APK (215,146,098 bytes) after the optimized test APK was built and verified.
- Preserved the production download, its backup, source project, generated build outputs, signing configuration, dealer data, and audit history.
- No active download was deleted. No other obsolete active APK was confirmed, so no further deletion was made.

## Automated verification

- Flutter analyzer: no issues.
- Flutter tests: 12 passed.
- Node login/database and scan regression tests: 59 passed in the targeted suites.
- Testing and production Railway `/api/health`: HTTP 200.
- APK package metadata, signature, version, and checksum verified locally.

## Required before release

- No Android device was detected by `adb`, so installation, login, QR scanning, offline queue persistence, reconnection, concurrent devices, and stock/report checks have not been performed on a real phone.
- The new no-dealer-code login also needs the accompanying backend change on an isolated testing deployment. The supplied release instructions explicitly prohibit backend deployment and replacing the production APK until testing and approval; neither happened.
- Device Control download links still serve the current production APK. Update them only after a real-phone test and production release approval.
- The existing Daksh brand icon now replaces the default Flutter launcher icon; a new warehouse/QR visual matching the reference has not yet been created.
