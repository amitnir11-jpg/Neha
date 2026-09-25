const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const scanJs = fs.readFileSync(path.join(root, 'public', 'scan.js'), 'utf8');
const scanHtml = fs.readFileSync(path.join(root, 'public', 'scan.html'), 'utf8');
const scanCss = fs.readFileSync(path.join(root, 'public', 'scan.css'), 'utf8');
const runtimeJs = fs.readFileSync(path.join(root, 'public', 'js', 'runtime.js'), 'utf8');
const serviceWorkerJs = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
const mobileRoute = fs.readFileSync(path.join(root, 'routes', 'mobile.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const nativeScannerHome = fs.readFileSync(path.join(root, 'mobile_scanner_app', 'lib', 'screens', 'scanner_home_screen.dart'), 'utf8');
const nativeLocalDatabase = fs.readFileSync(path.join(root, 'mobile_scanner_app', 'lib', 'services', 'local_database.dart'), 'utf8');

const build = scanJs.match(/const APP_VERSION = '([^']+)'/)?.[1]
  || scanJs.match(/const CACHE_VERSION = '([^']+)'/)?.[1];
const runtimeBuild = runtimeJs.match(/const APP_VERSION = '([^']+)'/)?.[1];
const serviceWorkerBuild = serviceWorkerJs.match(/const APP_VERSION = '([^']+)'/)?.[1];
assert.ok(build, 'Scanner build version is required');
assert.ok(runtimeBuild, 'Runtime app build version is required');
assert.ok(scanHtml.includes(`/scan.js?v=${build}`), 'Scanner script build must match HTML');
assert.ok(scanHtml.includes(`/scan.css?v=${build}`), 'Scanner stylesheet build must match HTML');
assert.ok(mobileRoute.includes(`const WEB_SCANNER_BUILD = '${build}'`), 'Backend scanner build must match frontend');
assert.ok(server.includes('const APP_VERSION = RELEASE_BUILD.appVersion || RELEASE_BUILD.version'), 'Backend app version must come from generated build info');
assert.ok(server.includes(`const WEB_SCANNER_BUILD = '${build}'`), 'Server scanner build must match scanner frontend');
assert.strictEqual(serviceWorkerBuild, runtimeBuild, 'Service worker build must match runtime build');
assert.ok(server.includes("'/api/apk/lite'"), 'Lite APK download route must be registered');
assert.ok(scanHtml.includes('href="/api/apk/lite"'), 'Web scanner must link to the Lite APK when browser camera is blocked');
assert.ok(scanHtml.includes('id="liteApkBtn"'), 'Lite APK button must be present in scanner controls');
assert.ok(!runtimeJs.includes('New update available. Please refresh application.'), 'Runtime must not block startup with an update confirm dialog');
assert.ok(!scanJs.includes('New update available. Please refresh application.'), 'Scanner must not block startup with an update confirm dialog');
assert.ok(server.includes("req.path === '/mobile/version'"), 'Scanner version check must work without a database connection');
assert.ok(scanCss.includes('object-fit: cover'), 'Camera preview must fill the frame without black bars');
assert.ok(scanHtml.includes('id="lastScanStatus"'), 'Last scan status line must be present');
assert.ok(scanHtml.includes('id="lastScanSync"'), 'Last scan sync line must be present');
assert.ok(scanJs.includes("api('/api/scans/process'"), 'Scanner must use the common process API');
assert.ok(!scanJs.includes("api('/api/mobile/process'"), 'Legacy mobile process API must not be used');
assert.ok(!scanJs.includes("api('/api/mobile/sync-batch'"), 'Legacy mobile batch API must not be used');
assert.ok(scanJs.includes("await saveRecord(record, { silent: true, deferSync: false })"), 'Scanner must queue decoded scans locally before sync');
assert.ok(!scanJs.includes('pendingDecodeQueue'), 'Legacy pending decode queue should not be used');
assert.ok(scanJs.includes('function saveBinAndStartCamera({ openCapture = true } = {})'), 'Saving a bin must start the scanner from a user gesture');
assert.ok(scanJs.includes('function hasLiveCameraApi()'), 'Scanner must prefer live in-box camera when the browser exposes getUserMedia');
assert.ok(/function shouldUseCaptureScanner\(\)\s*{\s*return false;\s*}/.test(scanJs), 'Visible scanner controls must not open the phone photo capture picker');
assert.strictEqual((scanJs.match(/startCaptureScan\(/g) || []).length, 1, 'Capture picker helper must not be called by visible scanner controls');
assert.ok(scanJs.includes('startCamera({ allowCaptureFallback: false })'), 'Automatic resume paths must not open the capture picker without a user tap');
assert.ok(scanCss.includes('content: attr(data-message)'), 'Idle camera frame must show scanner state instead of a blank box');

const initStart = scanJs.indexOf('async function init()');
const cameraStart = scanJs.indexOf('requestAutoCameraStart({ focusBin: false });', initStart);
const configWait = scanJs.indexOf('await configReady;', initStart);
assert.ok(cameraStart > initStart && configWait > cameraStart, 'Camera must start before waiting for network config');
assert.ok(nativeScannerHome.includes('if (_syncInFlight) {\n      _syncRequested = true;'), 'Native scanner must request a follow-up sync when a scan arrives during an active sync');
assert.ok(nativeScannerHome.includes('final syncAgain = _syncRequested;'), 'Native scanner must drain scans added during an active sync');
assert.ok(!nativeScannerHome.includes("reason: 'This QR / UPI was just scanned.'"), 'Repeated camera frames must not be shown as duplicate inventory scans');
assert.ok(nativeLocalDatabase.includes("AND status = ?"), 'Native duplicate lookup must only use server-synced records');
assert.ok(nativeLocalDatabase.includes("userId, 'Synced'"), 'Pending local rows must not be treated as central-inventory duplicates');

console.log('Mobile scanner regression checks passed.');
