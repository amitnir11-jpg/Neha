const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '../.codex-artifacts/browser-tools/node_modules/playwright');
const artifacts = path.resolve('.codex-artifacts/smart-part-search');
const session = JSON.parse(fs.readFileSync(path.join(artifacts, 'session.json'), 'utf8'));
assert.ok(/^http:\/\/127\.0\.0\.1:55441$/.test(session.origin), 'Only the isolated local testing server is allowed');
const checks = [], errors = [];
const passed = name => { checks.push(name); console.log(`PASS ${name}`); };

async function desktop(browser, userIndex = 0) {
  const who = session.users[userIndex];
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'daksh_auth', value: who.token, url: session.origin }]);
  await context.addInitScript(({ who }) => {
    localStorage.setItem('dakshToken', who.token);
    localStorage.setItem('dakshUser', JSON.stringify(who.user));
    localStorage.setItem('dakshAssignedDealers', JSON.stringify([{ dealerCode: who.dealerCode, dealerName: 'Smart Search' }]));
    localStorage.setItem('dakshActiveDealerId', who.dealerCode);
  }, { who });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${session.origin}/dashboard?view=scan`);
  await page.waitForFunction(() => window.__DAKSH_DASHBOARD_BOOT__?.markers.some(marker => marker.label === 'DOMContentLoaded startup complete'));
  await page.locator('#barcodeScanForm [name="dealerCode"]').selectOption(who.dealerCode);
  await page.locator('#barcodeBinLocation').fill('1');
  await page.locator('#barcodeBinLocation').press('Enter');
  await page.waitForFunction(() => !document.querySelector('#barcodePartNumber').disabled);
  return { context, page, who };
}

async function main() {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const { context, page } = await desktop(browser);
    let writes = 0;
    page.on('request', request => { if (/\/api\/(?:scans|inventory)\//.test(request.url()) && ['POST', 'PATCH', 'DELETE'].includes(request.method())) writes++; });
    const input = page.locator('#barcodePartNumber');
    await input.fill(session.stem.toLowerCase());
    await page.locator('.smart-part-menu:not([hidden]) [role="option"]').first().waitFor();
    assert.equal(await page.locator('.smart-part-menu:not([hidden]) [role="option"]').count(), 10);
    await page.locator('.smart-part-menu:not([hidden]) [role="option"]').first().click();
    assert.equal(await input.inputValue(), session.stem);
    assert.equal(await page.locator('#barcodeScanForm [name="mrp"]').inputValue(), '770');
    assert.equal(await page.locator('#barcodeBinLocation').inputValue(), '1');
    await page.waitForTimeout(500);
    assert.equal(await page.locator('#barcodeScanForm [name="mrp"]').inputValue(), '770');
    assert.equal(writes, 0);
    passed('PC mouse selection fills same-master details, keeps mandatory inward bin and performs no scan save');
    await input.fill(`${session.stem.slice(0, -1)}`);
    await page.locator('.smart-part-menu:not([hidden]) [role="option"]').first().waitFor();
    await input.press('ArrowDown'); await input.press('Enter');
    assert.equal(await input.inputValue(), session.stem);
    assert.equal(writes, 0);
    passed('PC keyboard suggestion selection does not submit the scan form');
    await page.screenshot({ path: path.join(artifacts, 'desktop-manual.png') });
    // A USB/Bluetooth scanner delivering keyboard-wedge input must keep its
    // raw-code field focus. No camera decoding or scanner handler is modified.
    const raw = page.locator('#barcodeRaw');
    await raw.focus(); await raw.pressSequentially('HARDWARE-SCANNER-INPUT', { delay: 1 });
    assert.equal(await raw.inputValue(), 'HARDWARE-SCANNER-INPUT');
    assert.equal(await raw.evaluate(element => element === document.activeElement), true);
    assert.equal(await page.locator('.smart-part-menu:not([hidden])').count(), 0);
    passed('simulated hardware keyboard-wedge scanner input retains raw field focus');

    const admin = await desktop(browser, 3);
    const fields = ['#partMasterSearchInput', '#binTransferPartSearch', '#reportFilters [name="partNumber"]', '#scanHistoryFilters [name="part"]'];
    // Check binding on each actual screen; selection/search itself is tested on
    // the shared component and the manual screens, independently of navigation.
    for (const selector of fields) assert.equal(await admin.page.locator(selector).getAttribute('role'), 'combobox', selector);
    const reconFields = await admin.page.locator('form[id*="recon"] input[name="partNumber"]').count();
    if (reconFields) assert.equal(await admin.page.locator('form[id*="recon"] input[name="partNumber"]').first().getAttribute('role'), 'combobox');
    assert.equal(await admin.page.locator('#localPartForm input[name="partNumber"]').getAttribute('role'), null);
    passed('Part Master, Bin Transfer, report, reconciliation and history filters share autocomplete; Local Part entry stays independent');
    // Exercise the shared API on the actual search screens, beyond binding.
    await admin.page.locator('#dashboardDealerSelect').selectOption(admin.who.dealerCode);
    for (const [view, selector, dealerSelector] of [
      ['master', '#partMasterSearchInput', null],
      ['binTransfer', '#binTransferPartSearch', '#binTransferDealer'],
      ['reconciliation', '#reconFilters input[name="partNumber"]', '#reconDealer'],
      ['reports', '#reportFilters input[name="partNumber"]', '#reportFilters select[name="dealerCode"]']
    ]) {
      await admin.page.locator(`.side-link[data-view="${view}"]`).click();
      if (view === 'reports') {
        await admin.page.locator('#reportTypeSelect').selectOption('partwise-inventory-audit');
        await admin.page.locator('#reportFilterSettingsOpen').click();
        await admin.page.locator('#reportFilterSettingsList input[value="partNumber"]').check();
        await admin.page.locator('#reportFilterSettingsSave').click();
      }
      if (dealerSelector) await admin.page.locator(dealerSelector).selectOption(admin.who.dealerCode);
      const field = admin.page.locator(selector);
      await field.waitFor({ state: 'visible' });
      await field.fill(session.stem);
      const option = admin.page.locator('.smart-part-menu:not([hidden]) [role="option"]').first();
      await option.waitFor();
      assert.match(await option.textContent(), /770\.00/);
      await option.click();
      assert.equal(await field.inputValue(), session.stem);
    }
    passed('actual Part Master, Bin Transfer, reconciliation and inventory report screens return the same selected part and MRP');

    const mobileWho = session.users[1];
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await mobile.addInitScript(({ who }) => {
      window.mediaRequests = 0;
      if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { window.mediaRequests++; throw new Error('Camera must remain off during manual search'); };
      localStorage.setItem('dakshFreshSession', JSON.stringify({ token: who.token, user: who.user, dealerCode: who.dealerCode,
        auditId: `AUD-${who.dealerCode}`, dealerName: 'Smart Search', activeAudit: { dealerCode: who.dealerCode, auditId: `AUD-${who.dealerCode}`, status: 'ACTIVE' } }));
    }, { who: mobileWho });
    const phone = await mobile.newPage();
    phone.setDefaultTimeout(20000);
    phone.on('pageerror', error => errors.push(error.message));
    await phone.goto(`${session.origin}/mobile-web`);
    await phone.locator('#scannerPanel').waitFor({ state: 'visible' });
    await phone.locator('#manualBtn').tap();
    assert.equal(await phone.locator('#manualPartNumber').isDisabled(), true);
    await phone.locator('#manualBinLocation').fill('1');
    await phone.locator('#manualBinLocation').press('Tab');
    await phone.waitForFunction(() => !document.querySelector('#manualPartNumber').disabled);
    let phoneWrites = 0;
    phone.on('request', request => { if (/\/api\/(?:scans\/process|sync)/.test(request.url()) && request.method() === 'POST') phoneWrites++; });
    const phoneInput = phone.locator('#manualPartNumber');
    await phoneInput.fill(session.stem);
    await phone.locator('.smart-part-menu:not([hidden]) [role="option"]').first().waitFor();
    const rect = await phoneInput.boundingBox();
    const popup = await phone.locator('.smart-part-menu:not([hidden])').boundingBox();
    assert.ok(popup.y >= rect.y + rect.height, 'dropdown lies immediately below input');
    await phone.locator('.smart-part-menu:not([hidden]) [role="option"]').first().tap();
    assert.equal(await phoneInput.inputValue(), session.stem);
    assert.match(await phone.locator('#manualPartDetails').textContent(), /Dealer A/i);
    assert.equal(await phone.locator('#manualMrp').inputValue(), '770');
    assert.equal(await phone.locator('#manualBinLocation').inputValue(), '1');
    assert.equal(await phone.evaluate(() => window.mediaRequests), 0);
    assert.equal(phoneWrites, 0);
    await phone.screenshot({ path: path.join(artifacts, 'mobile-manual.png') });
    passed('Mobile Chrome touch selection displays same details below input, preserves bin, never opens camera or saves a scan');

    // Requests intentionally ignore cancellation to exercise the sequence guard.
    let release;
    await phone.route('**/api/parts/suggestions?**', async route => {
      const q = new URL(route.request().url()).searchParams.get('q');
      if (q === 'OLDQUERY') await new Promise(resolve => { release = resolve; });
      await route.fulfill({ json: { success: true, suggestions: [{ partNumber: q === 'OLDQUERY' ? 'OLDRESULT' : 'NEWRESULT', partDescription: 'Controlled slow network', mrp: 100 }] } }).catch(() => {});
    });
    await phoneInput.fill('OLDQUERY');
    await phone.waitForTimeout(300);
    assert.ok(release);
    await phoneInput.fill('NEWQUERY');
    await phone.locator('.smart-part-menu:not([hidden])').getByText('NEWRESULT', { exact: true }).waitFor();
    release();
    await phone.waitForTimeout(300);
    assert.equal(await phone.getByText('OLDRESULT', { exact: true }).count(), 0);
    await phoneInput.fill('');
    assert.equal(await phone.locator('.smart-part-menu:not([hidden])').count(), 0);
    await phone.unroute('**/api/parts/suggestions?**');
    await phone.route('**/api/parts/suggestions?**', route => route.abort('internetdisconnected'));
    await phoneInput.fill('20K');
    await phone.getByText('Suggestions unavailable. Keep typing or retry.').waitFor();
    assert.equal(await phoneInput.inputValue(), '20K');
    await phone.unroute('**/api/parts/suggestions?**');
    await phoneInput.fill(session.stem);
    await phone.locator('.smart-part-menu:not([hidden]) [role="option"]').first().waitFor();
    passed('slow/outdated responses, cleared queries, connection loss and successful retry preserve the latest input');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(artifacts, 'browser-results.json'), JSON.stringify({ checks, errors }, null, 2));
    await context.close(); await admin.context.close(); await mobile.close();
  } catch (error) { console.error(error); throw error; }
  finally { await browser.close(); }
}
main().catch(() => { process.exitCode = 1; });
