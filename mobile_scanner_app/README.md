# Daksh Mobile Scanner

Daksh Scan Lite v1.2.6 is the Android scanner app for the Daksh Inventory web portal.

## Offline Flow

- The app auto-discovers the Daksh PC server when the phone joins the same WiFi/hotspot network.
- The local server is discovered as `daksh.local` using mDNS, with the existing UDP and subnet probes as fallbacks.
- Scan the temporary web portal pairing QR or enter a custom API URL only when automatic discovery cannot find the server.
- Login with a registered portal user password or PIN.
- Select/verify dealer code before scanning.
- Scan QR/barcodes continuously with camera debounce.
- Store scans locally in SQLite when offline.
- Sync immediately when online, retry pending records in the foreground, and retry with WorkManager.

The Android app can use the phone camera with the local HTTP server. Browser-based mobile web scanning still needs HTTPS for camera access on Android Chrome.

## Build

```powershell
flutter pub get
flutter build apk --release --split-per-abi --build-name 1.2.4 --build-number 11
```

Use the `app-arm64-v8a-release.apk` output for current Android phones. It is copied to `public/downloads/daksh-lite-scanner.apk` for web portal download.
