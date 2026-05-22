# Daksh Mobile Scanner

Daksh Mobile Scanner v1.0 Fresh Build is the production Android scanner app for the Daksh Inventory web portal.

## Production Flow

- Scan the web portal pairing QR or enter the Railway/web portal API URL.
- Login with a registered portal user password or PIN.
- Select/verify dealer code before scanning.
- Scan QR/barcodes continuously with camera debounce.
- Store scans locally in SQLite when offline.
- Sync immediately when online and retry pending records with WorkManager.

## Build

```powershell
flutter pub get
flutter build apk --release --build-name 1.0.0 --build-number 1
```

The release APK is copied to `public/downloads/daksh-mobile-scanner.apk` by the deployment workflow for web portal download.
