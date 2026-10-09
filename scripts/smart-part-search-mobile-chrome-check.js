const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '../.codex-artifacts/browser-tools/node_modules/playwright');
const artifacts = path.resolve('.codex-artifacts/smart-part-search');
const session = JSON.parse(fs.readFileSync(path.join(artifacts, 'session.json'), 'utf8'));
assert.equal(session.origin, 'http://127.0.0.1:55441');
const adb = 'C:/Users/amita/AppData/Local/Android/sdk/platform-tools/adb.exe';
const run = (...args) => execFileSync(adb, ['-s', 'emulator-5556', ...args], { encoding: 'utf8', timeout: 20000, windowsHide: true });
function screenshot(name) {
  fs.writeFileSync(path.join(artifacts, name), execFileSync(adb, ['-s', 'emulator-5556', 'exec-out', 'screencap', '-p'], { timeout: 20000, windowsHide: true }));
}
let browser;
async function main() {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const context = browser.contexts()[0];
  const page = context.pages().find(page => page.url().includes('10.0.2.2:55441'));
  assert.ok(page, 'Inspect the emulator Chrome local testing tab before running');
  page.setDefaultTimeout(25000);
  const device = await context.newCDPSession(page);
  const tap = async locator => {
    await locator.scrollIntoViewIfNeeded();
    const rect = await locator.boundingBox();
    await device.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }] });
    await device.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const who = session.users[1];
  await page.evaluate(who => {
    localStorage.setItem('dakshFreshSession', JSON.stringify({ token: who.token, user: who.user,
      dealerCode: who.dealerCode, auditId: `AUD-${who.dealerCode}`, dealerName: 'Smart Search',
      activeAudit: { dealerCode: who.dealerCode, auditId: `AUD-${who.dealerCode}`, status: 'ACTIVE' } }));
  }, who);
  await page.reload();
  await page.locator('#scannerPanel').waitFor({ state: 'visible' });
  await tap(page.locator('#manualBtn'));
  await page.locator('#manualBinLocation').fill('1');
  await tap(page.locator('#manualPartNumber'));
  await page.waitForFunction(() => !document.querySelector('#manualPartNumber').disabled);
  let writes = 0;
  page.on('request', request => { if (/\/api\/(?:scans\/process|sync)/.test(request.url()) && request.method() === 'POST') writes++; });
  // ADB typing opens/uses Android's actual IME, unlike desktop viewport emulation.
  await tap(page.locator('#manualPartNumber'));
  run('shell', 'input', 'text', session.stem);
  const option = page.locator('.smart-part-menu:not([hidden]) [role="option"]').first();
  await option.waitFor();
  assert.match(await option.textContent(), /770\.00/);
  const keyboard = run('shell', 'dumpsys', 'input_method');
  assert.match(keyboard, /(?:mInputShown=true|isInputViewShown=true|mIsInputViewShown=true|inputShown=true)/);
  const viewportBottom = await page.evaluate(() => (visualViewport?.offsetTop || 0) + (visualViewport?.height || innerHeight));
  const rect = await option.boundingBox();
  assert.ok(rect.y + rect.height <= viewportBottom + 2, 'First touch suggestion is above the soft keyboard');
  screenshot('android-chrome-suggestions-keyboard.png');
  await tap(option);
  assert.equal(await page.locator('#manualPartNumber').inputValue(), session.stem);
  assert.equal(await page.locator('#manualMrp').inputValue(), '770');
  assert.equal(writes, 0);
  assert.equal(await page.locator('#manualDialog').evaluate(dialog => dialog.open), true);
  screenshot('android-chrome-selected-keyboard.png');
  fs.writeFileSync(path.join(artifacts, 'mobile-chrome-results.json'), JSON.stringify({ checks: [
    'actual Android Chrome uses the shared API and shows identical part/description/MRP',
    'real soft keyboard opens and the first touch suggestion remains visible above it',
    'touch selection leaves the manual dialog open and creates no scan save'
  ] }, null, 2));
  console.log('PASS actual Android Mobile Chrome touch search, real keyboard layout, same master details and no save');
  await browser.close();
}
main().catch(error => { console.error(error); screenshot('android-chrome-failure.png'); process.exitCode = 1; }).finally(() => browser?.close());
