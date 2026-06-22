const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const scanJs = fs.readFileSync(path.join(root, 'public', 'scan.js'), 'utf8');
const scanHtml = fs.readFileSync(path.join(root, 'public', 'scan.html'), 'utf8');
const scanCss = fs.readFileSync(path.join(root, 'public', 'scan.css'), 'utf8');
const mobileRoute = fs.readFileSync(path.join(root, 'routes', 'mobile.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

const build = scanJs.match(/const CACHE_VERSION = '([^']+)'/)?.[1];
assert.ok(build, 'Scanner build version is required');
assert.ok(scanHtml.includes(`/scan.js?v=${build}`), 'Scanner script build must match HTML');
assert.ok(scanHtml.includes(`/scan.css?v=${build}`), 'Scanner stylesheet build must match HTML');
assert.ok(mobileRoute.includes(`const WEB_SCANNER_BUILD = '${build}'`), 'Backend scanner build must match frontend');
assert.ok(server.includes("req.path === '/mobile/version'"), 'Scanner version check must work without a database connection');
assert.ok(scanCss.includes('object-fit: contain'), 'Camera preview must show the full uncropped frame');
assert.ok(scanJs.includes("api('/api/scans/process'"), 'Scanner must use the common process API');
assert.ok(!scanJs.includes("api('/api/mobile/process'"), 'Legacy mobile process API must not be used');
assert.ok(!scanJs.includes("api('/api/mobile/sync-batch'"), 'Legacy mobile batch API must not be used');
assert.ok(scanJs.includes('state.pendingDecodeQueue.push(raw)'), 'Distinct scans must queue while a save is running');

const initStart = scanJs.indexOf('async function init()');
const cameraStart = scanJs.indexOf('requestAutoCameraStart({ focusBin: false });', initStart);
const configWait = scanJs.indexOf('await configReady;', initStart);
assert.ok(cameraStart > initStart && configWait > cameraStart, 'Camera must start before waiting for network config');

console.log('Mobile scanner regression checks passed.');
