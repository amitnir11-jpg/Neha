// Controls only the emulator created for this task; never a connected phone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const adb = process.env.SMART_SEARCH_ADB || 'C:/Users/amita/AppData/Local/Android/sdk/platform-tools/adb.exe';
const artifacts = path.resolve('.codex-artifacts/smart-part-search');
const session = JSON.parse(fs.readFileSync(path.join(artifacts, 'session.json'), 'utf8'));
assert.equal(session.origin, 'http://127.0.0.1:55441');
process.env.DATABASE_URL = 'postgresql://scan_test@127.0.0.1:55438/scan_acceptance';
const { prisma } = require('../services/prisma');
const checks = [];
const run = (...args) => execFileSync(adb, ['-s', 'emulator-5556', ...args], { encoding: 'utf8', timeout: 30000, windowsHide: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const passed = name => { checks.push(name); console.log(`PASS ${name}`); };
function nodes() {
  run('shell', 'uiautomator', 'dump', '/sdcard/smartsearch-ui.xml');
  const xml = run('shell', 'cat', '/sdcard/smartsearch-ui.xml');
  fs.writeFileSync(path.join(artifacts, 'android-ui.xml'), xml);
  return [...xml.matchAll(/<node\b[^>]*>/g)].map(match => {
    const fields = Object.fromEntries([...match[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(attr => [attr[1], attr[2].replace(/&amp;/g, '&').replace(/&#10;/g, '\n')]));
    fields.bounds = (fields.bounds || '').match(/\d+/g)?.map(Number) || [];
    return fields;
  });
}
function tap(node) {
  assert.ok(node, 'Requested Android control must be visible in the inspected UI');
  const [x1, y1, x2, y2] = node.bounds;
  run('shell', 'input', 'tap', String(Math.round((x1 + x2) / 2)), String(Math.round((y1 + y2) / 2)));
}
function screenshot(name) {
  const png = execFileSync(adb, ['-s', 'emulator-5556', 'exec-out', 'screencap', '-p'], { timeout: 30000, windowsHide: true });
  fs.writeFileSync(path.join(artifacts, name), png);
}
async function fill(hint, value) {
  tap(nodes().find(node => node.hint === hint));
  run('shell', 'input', 'keycombination', '113', '29'); // Ctrl+A in this test field.
  run('shell', 'input', 'text', value);
  run('shell', 'input', 'keyevent', '4'); // Hide keyboard; leave login form open.
  await pause(150);
}
async function main() {
  const before = await prisma.inventory.count();
  let ui = nodes();
  if (ui.some(node => node.hint === 'User ID')) {
    await fill('Dealer Code', session.users[1].dealerCode);
    await fill('User ID', session.users[1].user.username);
    await fill('Password', 'SmartSearch-Local-Only-2026');
    run('shell', 'input', 'swipe', '540', '1600', '540', '650', '400');
    ui = nodes();
    tap(ui.find(node => node['content-desc'] === 'Login and Start Scanning'));
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    ui = nodes();
    if (ui.some(node => node['content-desc'] === 'Manual Entry')) break;
    const cameraDenial = ui.find(node => (node.package || '').includes('permissioncontroller') && /^Don.*allow$/i.test(node.text || ''));
    if (cameraDenial) tap(cameraDenial);
    if (ui.some(node => /(?:approval required|awaiting Admin approval)/i.test(node['content-desc'] || ''))) {
      // Approve only this fresh fixture dealer's Android emulator registration,
      // using the existing Admin approval API rather than bypassing permissions.
      const Device = require('../models/Device');
      const devices = await Device.find({ dealerCode: session.users[1].dealerCode, deviceName: 'Daksh Android Scanner', approved: false }).lean();
      assert.equal(devices.length, 1, 'Only this emulator fixture can be approved');
      const response = await fetch(`${session.origin}/api/admin/mobile-device/block`, { method: 'POST',
        headers: { Authorization: `Bearer ${session.users[3].token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: devices[0].deviceId, block: false }) });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).blocked, false);
      tap(ui.find(node => node['content-desc'] === 'Login and Start Scanning'));
    }
    await pause(500);
  }
  screenshot('android-home.png');
  let manual = ui.find(node => node['content-desc'] === 'Manual Entry');
  assert.ok(manual, 'Authenticated scanner home must expose Manual Entry');
  if (manual.bounds[3] - manual.bounds[1] < 40) {
    run('shell', 'input', 'swipe', '540', '1550', '540', '650', '500');
    manual = nodes().find(node => node['content-desc'] === 'Manual Entry');
  }
  passed('rebuilt release APK logs in to the isolated testing server');
  tap(manual);
  await pause(300);
  ui = nodes();
  const partInput = ui.find(node => node.hint === 'Part Number');
  assert.ok(partInput, 'Native manual part field exists');
  tap(partInput);
  run('shell', 'input', 'text', session.stem);
  let suggestion;
  for (let attempt = 0; attempt < 15; attempt++) {
    ui = nodes();
    suggestion = ui.find(node => (node['content-desc'] || '').startsWith(session.stem) && (node['content-desc'] || '').includes('CHAIN SPROCKET'));
    if (suggestion) break;
    await pause(250);
  }
  screenshot('android-suggestions-keyboard.png');
  assert.ok(suggestion, 'APK receives the same master part and description as the web API');
  const currentInput = ui.find(node => node.hint === 'Part Number');
  assert.ok(suggestion.bounds[1] >= currentInput.bounds[3], 'Suggestions are below the native input');
  const keyboard = run('shell', 'dumpsys', 'input_method');
  assert.match(keyboard, /(?:mInputShown=true|isInputViewShown=true|mIsInputViewShown=true|inputShown=true)/);
  passed('native touch dropdown shows the same part/description directly below the input with the soft keyboard open');
  tap(suggestion);
  await pause(200);
  ui = nodes();
  assert.equal(ui.find(node => node.hint === 'Part Number')?.text, session.stem);
  assert.ok(ui.some(node => (node['content-desc'] || '').includes('Manual Entry')), 'Selecting leaves the entry dialog open');
  assert.equal(await prisma.inventory.count(), before);
  screenshot('android-selected-keyboard.png');
  passed('APK touch selection keeps manual entry open and creates no inventory transaction');
  fs.writeFileSync(path.join(artifacts, 'android-results.json'), JSON.stringify({ checks, inventoryBefore: before }, null, 2));
}
main().catch(error => { console.error(error); screenshot('android-failure.png'); process.exitCode = 1; }).finally(() => prisma.$disconnect());
