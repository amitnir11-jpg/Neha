# Daksh Mobile Scanner

Daksh Mobile Scanner v1.0.2 is the production Android scanner app for the Daksh Inventory web portal.

## Production Flow

- The Railway cloud server is configured automatically on fresh install.
- Scan the web portal pairing QR or enter a custom API URL only when changing servers.
- Login with a registered portal user password or PIN.
- Select/verify dealer code before scanning.
- Scan QR/barcodes continuously with camera debounce.
- Store scans locally in SQLite when offline.
- Sync immediately when online, retry pending records in the foreground, and retry with WorkManager.

## Build

```powershell
flutter pub get
flutter build apk --release --split-per-abi --build-name 1.0.2 --build-number 3
```

Use the `app-arm64-v8a-release.apk` output for current Android phones. It is copied to `public/downloads/daksh-mobile-scanner.apk` for web portal download.
