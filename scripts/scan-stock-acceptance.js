// Run only against an isolated local database named scan_acceptance.
// Apply migrations first, then set SCAN_ACCEPTANCE_DATABASE_URL and run this file.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const databaseUrl = new URL(process.env.SCAN_ACCEPTANCE_DATABASE_URL || 'http://missing');
assert.ok(['postgres:', 'postgresql:'].includes(databaseUrl.protocol)
  && ['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname)
  && databaseUrl.pathname === '/scan_acceptance', 'Set SCAN_ACCEPTANCE_DATABASE_URL to an isolated local scan_acceptance database');
process.env.DATABASE_URL = databaseUrl.href;
const { prisma } = require('../services/prisma');
const models = require('../models/registry');
const jwt = require('jsonwebtoken');
const suffix = randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
const dealerCode = `SCAN${suffix}`;
const auditId = `AUD-${suffix}`;
const partNumber = '53155AAW000S';
const secret = randomUUID();
const port = Number(process.env.SCAN_ACCEPTANCE_PORT || 55439);
const origin = `http://127.0.0.1:${port}`;
const artifactDir = path.resolve('.codex-artifacts/scan-acceptance');
fs.mkdirSync(artifactDir, { recursive: true });
const checks = [];
const scanTimings = [];
let server, log, browser, token, user, secondUser;
function passed(name) { checks.push(name); console.log(`PASS ${name}`); }
async function api(route, body, authToken = token) {
  const started = performance.now();
  const response = await fetch(`${origin}${route}`, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  const result = { code: response.status, ...await response.json() };
  if (route === '/api/scans/process') scanTimings.push({ type: body?.type, cameraDecoded: body?.cameraDecoded === true, status: response.status, elapsedMs: Math.round(performance.now() - started) });
  return result;
}
function payload(type, upi, binLocation = '', extra = {}) {
  return { dealerCode, auditId, partNumber, type, upiNo: upi, rawScan: upi ? `${partNumber}/${upi}` : '',
    ...(upi ? { smartBinDecision: 'SAVE_NEW_BIN' } : {}),
    binLocation, quantity: 9, source: 'barcode', scanSource: 'barcode', uniqueScanId: randomUUID(),
    deviceId: 'SCAN-ACCEPTANCE', ...extra };
}
async function scan(type, upi, bin, extra) { return api('/api/scans/process', payload(type, upi, bin, extra)); }
async function summary() { return api(`/api/scans/part-summary?dealerCode=${dealerCode}&auditId=${auditId}&partNumber=${partNumber}`); }
async function history(query = '') { return api(`/api/scans/history?dealerCode=${dealerCode}&auditId=${auditId}&limit=10${query}`); }
async function main() {
  await models.Dealer.create({ dealerCode, dealerName: 'Scan Acceptance', currentAuditId: auditId, active: true });
  await models.Audit.create({ dealerCode, auditId, status: 'ACTIVE', auditStatus: 'ACTIVE', auditStartDate: new Date() });
  await models.Bin.create({ dealerCode, binCode: 'A1', active: true });
  await models.Bin.create({ dealerCode, binCode: 'B1', active: true });
  await models.Bin.create({ dealerCode, binCode: 'C1', active: true });
  await models.MasterPart.create({ dealerCode, partNumber, partDescription: 'Acceptance steering handle', mrp: 100, dlc: 80, category: 'SHEET METAL' });
  for (const [number, description] of [['32410KTC920S', 'CABLE START MOTOR'], ['44831KVH900S', 'Hero QR fixture'], ['4006381333931', 'EAN fixture']]) {
    await models.MasterPart.create({ dealerCode, partNumber: number, partDescription: description, mrp: 86, dlc: 70, category: 'ELECTRICAL' });
  }
  const createdUser = await models.User.create({ username: `scan-${suffix.toLowerCase()}`, name: 'Scan Acceptance', role: 'admin', dealerAccess: [dealerCode], active: true, approved: true });
  user = require('../routes/auth').publicUser(createdUser);
  secondUser = require('../routes/auth').publicUser(await models.User.create({ username: `scan-second-${suffix.toLowerCase()}`, name: 'Second operator', role: 'mobile_user', dealerAccess: [dealerCode], active: true, approved: true }));
  token = jwt.sign(user, secret, { expiresIn: '1h' });
  log = fs.openSync(path.join(artifactDir, 'server.log'), 'w');
  server = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), windowsHide: true,
    env: { ...process.env, JWT_SECRET: secret, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test',
      DAKSH_LICENSE_REQUIRED: 'false', MDNS_ENABLED: 'false', MOBILE_DISCOVERY_ENABLED: 'false',
      DAKSH_DATA_ROOT: path.join(artifactDir, 'runtime') }, stdio: ['ignore', log, log] });
  for (let attempt = 0; ; attempt++) {
    try { if ((await api('/api/ready')).code === 200) break; } catch {}
    assert.ok(attempt < 90 && server.exitCode === null, 'Acceptance server must become ready; inspect server.log');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal((await api('/api/scans/process', payload('INWARD', 'INVALID', 'UNKNOWN'))).success, false);
  assert.equal(await models.Inventory.countDocuments({ dealerCode }), 0);
  passed('invalid INWARD bin writes no inventory');
  const mobileToken = jwt.sign(secondUser, secret, { expiresIn: '1h' });
  const setBin = () => api('/api/scans/set-bin', { dealerCode, auditId, binLocation: ' a5 ' }, mobileToken);
  const registrations = await Promise.all([setBin(), setBin()]);
  assert.ok(registrations.every(result => result.valid && result.binLocation === 'A5'), JSON.stringify(registrations));
  assert.equal(registrations.filter(result => result.created).length, 1);
  assert.equal(await models.Bin.countDocuments({ dealerCode, binCode: 'A5' }), 1);
  assert.equal((await scan('INWARD', 'AUTO-BIN', 'A5')).success, true);
  assert.equal((await api('/api/scans/set-bin', { dealerCode: 'OTHER-DEALER', binLocation: 'A5' }, mobileToken)).code, 403);
  assert.equal(await models.Bin.countDocuments({ dealerCode: 'OTHER-DEALER', binCode: 'A5' }), 0);
  await models.Bin.create({ dealerCode, binCode: 'DISABLED', active: false });
  assert.equal((await api('/api/scans/set-bin', { dealerCode, auditId, binLocation: 'DISABLED' }, mobileToken)).code, 422);
  assert.equal((await models.Bin.findOne({ dealerCode, binCode: 'DISABLED' }).lean()).active, false);
  // Leave the golden stock sequence's part untouched by this registration check.
  await models.Inventory.deleteMany({ dealerCode, upiNo: 'AUTO-BIN' });
  await models.PartBinLocation.deleteMany({ dealerCode, partNumber, binLocation: 'A5' });
  passed('mobile operator creates a new bin once, scans inward, and cannot change another dealer or reactivate an inactive bin');
  for (const [upi, bin] of [['UPI001', 'A1'], ['UPI002', 'A1'], ['UPI003', 'B1'], ['UPI004', 'B1']]) {
    const saved = await scan('INWARD', upi, bin);
    assert.equal(saved.success, true, JSON.stringify(saved));
    assert.equal(saved.scan.quantity, 1);
  }
  assert.equal((await summary()).availableQty, 4);
  const outward = await scan('OUTWARD', 'UPI003', 'A1', { rawScan: 'UPI003' });
  assert.equal(outward.success, true, JSON.stringify(outward));
  assert.equal(outward.scan.binLocation, 'B1');
  assert.equal(outward.partSummary.availableQty, 3);
  const fitted = await scan('FITTED', 'UPI002', '', { rawScan: 'UPI002', regdNo: 'CAR123', jobCardNo: 'JC001' });
  assert.equal(fitted.success, true, JSON.stringify(fitted));
  assert.equal(fitted.scan.binLocation, 'A1');
  assert.equal(fitted.partSummary.storeQty, 2);
  assert.equal(fitted.partSummary.availableQty, 3);
  const damage = await scan('DAMAGE', 'UPI004', 'B1');
  assert.equal(damage.success, true, JSON.stringify(damage));
  const golden = await summary();
  assert.deepEqual([golden.inwardQty, golden.outwardQty, golden.fittedQty, golden.damageQty, golden.storeQty, golden.availableQty], [4, 1, 1, 1, 1, 2]);
  assert.equal(golden.binBreakdown.find(bin => bin.binLocation === 'A1').availableQty, 2);
  assert.equal(golden.binBreakdown.find(bin => bin.binLocation === 'B1').availableQty, 0);
  passed('persisted golden sequence and exact automatic source-bin deduction');
  const beforeRejection = await models.Inventory.countDocuments({ dealerCode });
  assert.equal((await scan('OUTWARD', 'UPI003')).success, false);
  assert.equal((await scan('OUTWARD', 'UNKNOWN')).success, false);
  assert.equal((await scan('FITTED', 'UPI002', '', { regdNo: 'CAR123', jobCardNo: 'JC001' })).success, false);
  assert.equal(await models.Inventory.countDocuments({ dealerCode }), beforeRejection);
  passed('repeated OUTWARD/FITTED and unknown UPI leave persisted stock unchanged');
  await models.Audit.create({ dealerCode, auditId: `${auditId}-OLD`, status: 'ARCHIVED', auditStatus: 'ARCHIVED' });
  await models.Inventory.create({ dealerCode, auditId: `${auditId}-OLD`, partNumber, upiNo: 'OLD-AUDIT', scanType: 'INWARD', binLocation: 'A1', quantity: 1, qty: 1, masterFound: true });
  assert.equal((await scan('OUTWARD', 'OLD-AUDIT')).success, false);
  assert.equal((await api('/api/scans/process', payload('OUTWARD', 'UPI001', '', { auditId: `${auditId}-OLD` }))).code, 409);
  assert.equal((await summary()).availableQty, golden.availableQty);
  passed('other-audit UPI cannot be consumed or counted in active-audit totals');
  for (const type of ['OUTWARD', 'FITTED']) {
    const upi = `RACE-${type}`;
    assert.equal((await scan('INWARD', upi, 'A1')).success, true);
    const otherToken = jwt.sign(secondUser, secret, { expiresIn: '1h' });
    const requests = [token, otherToken].map(authToken => api('/api/scans/process', payload(type, upi, 'B1', { regdNo: 'CAR123', jobCardNo: 'JC002' }), authToken));
    const results = await Promise.all(requests);
    assert.equal(results.filter(result => result.success).length, 1, JSON.stringify(results));
    assert.ok(results.every(result => result.code < 500), JSON.stringify(results));
    assert.equal(await models.Inventory.countDocuments({ dealerCode, upiNo: upi, scanType: type }), 1);
    passed(`simultaneous ${type} requests commit exactly one movement`);
  }
  assert.equal((await scan('INWARD', 'ROLLBACK', 'B1')).success, true);
  const beforeRollback = await summary();
  // Fail the real database INSERT after the source claim; PostgreSQL must roll back both.
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION scan_acceptance_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."dealerCode" = '${dealerCode}' AND NEW."scanType" = 'OUTWARD' AND NEW."upiNo" = 'ROLLBACK' THEN RAISE EXCEPTION 'Acceptance forced insertion failure'; END IF; RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe('CREATE TRIGGER scan_acceptance_fail_insert BEFORE INSERT ON inventories FOR EACH ROW EXECUTE FUNCTION scan_acceptance_fail_insert()');
  try {
    assert.equal((await scan('OUTWARD', 'ROLLBACK')).success, false);
    const source = await models.Inventory.findOne({ dealerCode, upiNo: 'ROLLBACK', scanType: 'INWARD' }).lean();
    assert.equal(source.upiStatus, 'AVAILABLE');
    assert.equal(source.currentBin, 'B1');
    assert.equal((await summary()).availableQty, beforeRollback.availableQty);
    assert.equal(await models.Inventory.countDocuments({ dealerCode, upiNo: 'ROLLBACK', scanType: 'OUTWARD' }), 0);
  } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS scan_acceptance_fail_insert ON inventories');
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS scan_acceptance_fail_insert()');
  }
  passed('real PostgreSQL insertion failure rolls back source claim and stock');
  const manual = await scan('INWARD', '', 'C1', { source: 'manual', scanSource: 'manual', quantity: 10, smartBinDecision: 'SAVE_NEW_BIN' });
  assert.equal(manual.success, true, JSON.stringify(manual));
  assert.equal(manual.scan.quantity, 10);
  for (let i = 0; i < 12; i++) assert.equal((await scan('INWARD', `HISTORY-${i}`, 'B1')).success, true);
  const all = await history();
  const filtered = await history('&part=NO-MATCH&bin=UNKNOWN&type=OUTWARD');
  assert.equal(all.records.length, 10);
  assert.ok(all.pagination.totalRows > 10);
  assert.equal(filtered.records.length, 0);
  assert.equal(filtered.summary.netAvailableQuantity, all.summary.netAvailableQuantity);
  assert.equal(all.summary.netAvailableQuantity, (await summary()).availableQty);
  passed('manual quantity, ten-row history and filter-independent full stock totals');
  const skuRaw = '32410KTC920S/G3223000065001';
  const skuPart = '32410KTC920S';
  for (const binCode of ['SKUA', 'SKUB']) await models.Bin.create({ dealerCode, binCode, active: true });
  const skuPayload = (type, binLocation = '', extra = {}) => payload(type, '', binLocation, {
    partNumber: skuPart, cameraDecoded: true, rawDecodedValue: skuRaw, rawScan: skuRaw,
    barcodeFormat: 'CODE_128', ...extra });
  const skuScan = (type, bin, extra) => api('/api/scans/process', skuPayload(type, bin, extra));
  const skuSummary = () => api(`/api/scans/part-summary?dealerCode=${dealerCode}&auditId=${auditId}&partNumber=${skuPart}`);
  let lastSkuRequest;
  for (let i = 0; i < 3; i++) {
    lastSkuRequest = skuPayload('INWARD', 'SKUA', { quantity: 99, upiNo: 'FALSE-CLIENT-SERIAL' });
    const saved = await api('/api/scans/process', lastSkuRequest);
    assert.equal(saved.success, true, JSON.stringify(saved));
    assert.equal(saved.scan.partNumber, skuPart);
    assert.equal(saved.scan.quantity, 1);
    assert.equal(saved.scan.barcodeIdentityKind, 'SKU');
    assert.equal(saved.scan.upiNo, '');
    assert.equal(saved.scan.globalUpiKey, '');
    assert.equal(saved.scan.rawDecodedValue, skuRaw);
  }
  assert.equal((await skuSummary()).availableQty, 3);
  assert.equal((await api('/api/scans/process', lastSkuRequest)).alreadyApplied, true);
  assert.equal((await skuSummary()).availableQty, 3);
  passed('sample SKU inward counts three separate pieces, never invents a UPI, and request replay is idempotent');
  const skuOut = await skuScan('OUTWARD');
  assert.equal(skuOut.success, true, JSON.stringify(skuOut));
  assert.equal(skuOut.scan.binLocation, 'SKUA');
  const skuFit = await skuScan('FITTED', '', { regdNo: 'SKUCAR', jobCardNo: 'SKUJOB' });
  assert.equal(skuFit.success, true, JSON.stringify(skuFit));
  assert.equal((await skuSummary()).availableQty, 2);
  assert.equal((await skuSummary()).storeQty, 1);
  assert.equal((await skuSummary()).fittedQty, 1);
  assert.equal((await skuScan('DAMAGE')).success, true);
  assert.equal((await skuSummary()).storeQty, 0);
  assert.equal((await skuSummary()).availableQty, 1);
  assert.equal((await skuScan('OUTWARD')).success, false);
  passed('SKU outward, fitted and damage use eligible physical stock and never consume pending workshop stock');
  assert.equal((await skuScan('INWARD', 'SKUA')).success, true);
  const concurrentSku = await Promise.all([skuScan('OUTWARD'), skuScan('OUTWARD')]);
  assert.equal(concurrentSku.filter(result => result.success).length, 1, JSON.stringify(concurrentSku));
  assert.equal((await skuSummary()).storeQty, 0);
  passed('two simultaneous SKU outward requests cannot oversell the last physical piece');
  for (const bin of ['SKUA', 'SKUB']) assert.equal((await skuScan('INWARD', bin, { smartBinDecision: 'SAVE_NEW_BIN' })).success, true);
  const chooseSku = await skuScan('OUTWARD');
  assert.equal(chooseSku.requiresBinSelection, true, JSON.stringify(chooseSku));
  assert.deepEqual(chooseSku.binOptions.map(bin => bin.binLocation), ['SKUA', 'SKUB']);
  assert.equal((await skuScan('OUTWARD', 'UNKNOWN')).success, false);
  assert.equal((await skuScan('OUTWARD', 'SKUB')).success, true);
  assert.equal((await skuScan('FITTED', 'SKUA', { regdNo: 'SKUCAR', jobCardNo: 'SKUJOB' })).success, true);
  passed('SKU multiple-bin movement requires a selected eligible bin and repeated fitted SKU pieces remain separate transactions');
  const cameraRaw = ' \r\n32410ktc920s\t ';
  const directCamera = await scan('INWARD', '', 'A1', { partNumber: 'WRONG-CLIENT-FIELD', cameraDecoded: true, rawDecodedValue: cameraRaw, rawScan: cameraRaw, barcodeFormat: 'code_128' });
  assert.equal(directCamera.success, true, JSON.stringify(directCamera));
  assert.equal(directCamera.scan.partNumber, '32410KTC920S');
  assert.equal(directCamera.scan.rawDecodedValue, cameraRaw);
  assert.equal(directCamera.scan.parsedCode.barcodeFormat, 'CODE_128');
  // Keep the API fixture distinct from the physical QR image decoded later.
  const qrRaw = 'D/132/HE5B0199510/APICAMERAUPI/44831KVH900S      /001/20170505125743/00';
  const qrCamera = await scan('INWARD', '', 'A1', { partNumber: 'APICAMERAUPI', cameraDecoded: true, rawDecodedValue: qrRaw, rawScan: qrRaw, barcodeFormat: 'qr_code' });
  assert.equal(qrCamera.success, true, JSON.stringify(qrCamera));
  assert.equal(qrCamera.scan.partNumber, '44831KVH900S');
  assert.equal(qrCamera.scan.parsedCode.upi, 'APICAMERAUPI');
  assert.equal((await scan('INWARD', '', 'A1', { cameraDecoded: true, rawDecodedValue: 'PREFIX-32410KTC920S', rawScan: 'PREFIX-32410KTC920S', barcodeFormat: 'CODE_128' })).success, false);
  const numericCamera = await scan('INWARD', '', 'B1', { cameraDecoded: true, rawDecodedValue: '4006381333931', rawScan: '4006381333931', barcodeFormat: 'ean_13' });
  assert.equal(numericCamera.success, true, JSON.stringify(numericCamera));
  passed('camera direct/QR/EAN raw values override wrong client fields and reject unknown prefixes');
  // The APK offline queue uses the existing bulk endpoint with raw camera data.
  const apkRaw = 'D/132/HE5B0199510/APKUPI123/44831KVH900S/001/20170505125743/00';
  const apkScan = payload('INWARD', '', 'B1', { partNumber: '', cameraDecoded: true, rawDecodedValue: apkRaw, rawScan: apkRaw, barcodeFormat: 'qrCode', deviceId: 'APK-ACCEPTANCE', source: 'mobile', smartBinDecision: 'SAVE_NEW_BIN' });
  const apkBulk = await api('/api/mobile/sync-bulk', { dealerCode, auditId, deviceId: 'APK-ACCEPTANCE', scans: [apkScan] });
  assert.equal(apkBulk.success, true, JSON.stringify(apkBulk));
  assert.equal(apkBulk.insertedRecords[0].partNumber, '44831KVH900S');
  assert.equal(apkBulk.insertedRecords[0].parsedCode.upi, 'APKUPI123');
  passed('APK offline bulk payload uses the same authoritative raw camera parser');
  await verifyDuplicateAndManualBins();
  if (process.env.PLAYWRIGHT_MODULE) await verifyBrowser();
  fs.writeFileSync(path.join(artifactDir, 'results.json'), JSON.stringify({ checks, scanTimings, browserVerified: Boolean(browser), timestamp: new Date().toISOString() }, null, 2));
}

async function verifyDuplicateAndManualBins() {
  const uniquePart = '957010805000S';
  const manualPart = 'MANUALCHECK123';
  for (const number of [uniquePart, manualPart]) await models.MasterPart.create({ dealerCode, partNumber: number, partDescription: 'Duplicate and bin acceptance', mrp: 100, dlc: 80, category: 'FASTENER' });
  const firstRaw = `D/GCSG0000272850/CCG8FN2C6D4C/${uniquePart}     /000010/0000011.00/AAB/1/G/000/00`;
  const changedRaw = `D/OTHERBATCH123/CCG8FN2C6D4C/${uniquePart}/000001/0000012.00/OTHER/1/G/000/00`;
  const qr = (rawValue, binLocation = 'A1', extras = {}) => payload('INWARD', '', binLocation, { partNumber: uniquePart,
    rawScan: rawValue, rawDecodedValue: rawValue, cameraDecoded: true, barcodeFormat: 'QR_CODE', ...extras });
  const uniqueRows = () => models.Inventory.find({ dealerCode, auditId, partNumber: uniquePart, isDeleted: { $ne: true } }).lean();
  const first = await api('/api/scans/process', qr(firstRaw));
  assert.equal(first.success, true, JSON.stringify(first));
  for (const request of [qr(firstRaw), qr(changedRaw, 'B1'), qr('CCG8FN2C6D4C'), qr(changedRaw, 'B1', { source: 'manual', scanSource: 'manual', cameraDecoded: false })]) {
    const duplicate = await api('/api/scans/process', request);
    assert.equal(duplicate.code, 409, JSON.stringify(duplicate));
    assert.equal(duplicate.upiDuplicate, true);
    assert.match(duplicate.message, /already scanned/i);
    assert.equal((await uniqueRows()).length, 1);
    assert.equal((await uniqueRows())[0].quantity, 1);
  }
  // The active unique fingerprint index is the final guard for new UPI rows.
  await assert.rejects(prisma.inventory.create({ data: { id: randomUUID(), dealerCode, auditId, scanType: 'INWARD',
    qrFingerprint: first.scan.qrFingerprint, isDeleted: false, deletedAt: null, data: { partNumber: uniquePart } } }), error => error.code === 'P2002');
  // Recognize historical full-QR aliases without a production backfill.
  await models.Inventory.updateOne({ _id: first.scan._id }, { $set: { upiId: firstRaw, upiNo: firstRaw, upiCode: firstRaw, globalUpiKey: 'LEGACY-ACCEPTANCE-KEY' } });
  assert.equal((await api('/api/scans/process', qr(changedRaw))).upiDuplicate, true);
  const mobileToken = jwt.sign(secondUser, secret, { expiresIn: '1h' });
  const duplicateBulk = await api('/api/mobile/sync-bulk', { dealerCode, auditId, deviceId: 'UPI-APK', scans: [qr(changedRaw, 'B1')] }, mobileToken);
  assert.equal(duplicateBulk.duplicateCount, 1, JSON.stringify(duplicateBulk));
  assert.equal((await uniqueRows()).length, 1);
  passed('unique UPI repeats across text variants, bins, manual raw scans and APK bulk are errors with unchanged quantities; database index rejects duplicate fingerprints');
  const raceRaw1 = firstRaw.replace('CCG8FN2C6D4C', 'RACEUPI1234');
  const raceRaw2 = changedRaw.replace('CCG8FN2C6D4C', 'RACEUPI1234');
  const race = await Promise.all([api('/api/scans/process', qr(raceRaw1, 'B1', { smartBinDecision: 'SAVE_NEW_BIN' })),
    api('/api/scans/process', qr(raceRaw2, 'C1', { smartBinDecision: 'SAVE_NEW_BIN' }), mobileToken)]);
  assert.equal(race.filter(result => result.success).length, 1, JSON.stringify(race));
  assert.equal(race.filter(result => result.upiDuplicate).length, 1, JSON.stringify(race));
  assert.equal((await uniqueRows()).length, 2);
  const different = await api('/api/scans/process', qr(firstRaw.replace('CCG8FN2C6D4C', 'DIFFERENTUPI1')));
  assert.equal(different.success, true, JSON.stringify(different));
  assert.equal((await uniqueRows()).length, 3);
  await models.Inventory.updateOne({ _id: first.scan._id }, { $set: { isDeleted: true, deletedAt: new Date() } });
  await require('../services/PartBinLocationService').rebuildPartBinLocations({ dealerCode, auditId, partNumber: uniquePart });
  assert.equal((await api('/api/scans/process', qr(firstRaw))).success, true);
  assert.equal((await uniqueRows()).length, 3);
  passed('simultaneous unique UPI scans create one row, different UPIs for the same part are accepted, and a soft-deleted UPI may be rescanned');
  const manual = (bin, quantity, extras = {}) => payload('INWARD', '', bin, { partNumber: manualPart, source: 'manual', scanSource: 'manual', quantity, ...extras });
  const manualRows = () => models.Inventory.find({ dealerCode, auditId, partNumber: manualPart }).lean();
  const initialManual = await api('/api/scans/process', manual('A1', 3));
  assert.equal(initialManual.success, true, JSON.stringify(initialManual));
  const sameRequest = manual('B1', 2);
  const samePrompt = await api('/api/scans/process', sameRequest, mobileToken);
  assert.equal(samePrompt.smartBinWarning, true, JSON.stringify(samePrompt));
  assert.equal(samePrompt.smartBinSuggestion.lastBin, 'A1');
  assert.equal((await manualRows()).length, 1);
  const savedSame = await api('/api/scans/process', { ...sameRequest, smartBinDecision: 'USE_EXISTING_BIN', smartBinSelectedBin: 'A1' }, mobileToken);
  assert.equal(savedSame.success, true, JSON.stringify(savedSame));
  assert.equal(savedSame.scan.binLocation, 'A1');
  assert.equal((await models.Inventory.findById(initialManual.scan._id).lean()).quantity, 3);
  assert.equal((await manualRows()).reduce((sum, row) => sum + row.quantity, 0), 5);
  const newRequest = manual('B1', 4);
  assert.equal((await api('/api/scans/process', newRequest)).smartBinWarning, true);
  const savedNew = await api('/api/scans/process', { ...newRequest, smartBinDecision: 'SAVE_NEW_BIN' });
  assert.equal(savedNew.success, true, JSON.stringify(savedNew));
  assert.equal(savedNew.scan.binLocation, 'B1');
  const backRequest = manual('A1', 1);
  const backPrompt = await api('/api/scans/process', backRequest);
  assert.equal(backPrompt.smartBinWarning, true, JSON.stringify(backPrompt));
  assert.equal(backPrompt.smartBinSuggestion.lastBin, 'B1');
  assert.equal((await manualRows()).reduce((sum, row) => sum + row.quantity, 0), 9);
  assert.equal((await api('/api/scans/process', { ...backRequest, smartBinDecision: 'SAVE_NEW_BIN' })).success, true);
  assert.equal((await api('/api/scans/process', { ...sameRequest, smartBinDecision: 'USE_EXISTING_BIN', smartBinSelectedBin: 'A1' })).alreadyApplied, true);
  assert.equal((await manualRows()).reduce((sum, row) => sum + row.quantity, 0), 10);
  passed('manual different-bin entry asks for last bin, saves either chosen bin once, prompts even for an existing destination and preserves original rows');
  const uniqueQuantities = (await uniqueRows()).map(row => ({ id: row._id, qty: row.quantity }));
  const untrackedManual = await api('/api/scans/process', payload('INWARD', '', 'A1', { partNumber: uniquePart, source: 'manual', scanSource: 'manual', quantity: 2 }));
  assert.equal(untrackedManual.success, true, JSON.stringify(untrackedManual));
  for (const row of uniqueQuantities) assert.equal((await models.Inventory.findById(row.id).lean()).quantity, row.qty);
  passed('manual entry does not merge quantity into a uniquely tracked UPI row');
}

async function verifyBrowser() {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined), headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'daksh_auth', value: token, url: origin }]);
  await context.addInitScript(({ token, user, dealerCode }) => {
    localStorage.setItem('dakshToken', token);
    localStorage.setItem('dakshUser', JSON.stringify(user));
    localStorage.setItem('dakshAssignedDealers', JSON.stringify([{ dealerCode, dealerName: 'Scan Acceptance' }]));
    localStorage.setItem('dakshActiveDealerId', dealerCode);
  }, { token, user, dealerCode });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(`${origin}/dashboard?view=scan`);
  try {
    await page.waitForFunction(() => window.__DAKSH_DASHBOARD_BOOT__?.markers.some(marker => marker.label === 'DOMContentLoaded startup complete'));
  } catch (error) {
    await page.screenshot({ path: path.join(artifactDir, 'browser-failure.png'), fullPage: true });
    console.error('Browser startup', await page.url(), await page.locator('body').innerText(), errors);
    throw error;
  }
  await page.locator('#barcodeScanForm [name="dealerCode"]').selectOption(dealerCode);
  await page.waitForFunction(() => document.querySelector('#barcodeRaw').disabled);
  await page.locator('#barcodeBinLocation').fill('A1');
  await page.locator('#barcodeBinLocation').press('Enter');
  await page.waitForFunction(() => !document.querySelector('#barcodeRaw').disabled);
  passed('authenticated browser INWARD gate unlocks after real bin validation');
  await page.locator('#barcodeScanForm [name="type"]').selectOption('OUTWARD');
  assert.equal(await page.locator('#barcodeBinLocation').isVisible(), false);
  assert.equal(await page.locator('#barcodeRaw').isEnabled(), true);
  await page.locator('#barcodeRaw').fill('UPI001');
  await page.locator('#barcodeRaw').press('Enter');
  await page.waitForFunction(() => document.querySelector('#barcodeReadyStatus').textContent.includes('Saved'));
  assert.equal(await models.Inventory.countDocuments({ dealerCode, upiNo: 'UPI001', scanType: 'OUTWARD' }), 1);
  await page.waitForFunction(expected => Number(document.querySelector('#scanHistoryTotalQty').textContent.replace(/,/g, '')) === expected, (await history()).summary.netAvailableQuantity);
  await page.screenshot({ path: path.join(artifactDir, 'desktop-outward.png'), fullPage: true });
  passed('authenticated desktop OUTWARD saves and refreshes authoritative history totals');
  const beforeRemote = (await history()).summary.netAvailableQuantity;
  assert.equal((await scan('OUTWARD', 'HISTORY-0')).success, true);
  await page.waitForFunction(expected => Number(document.querySelector('#scanHistoryTotalQty').textContent.replace(/,/g, '')) === expected, beforeRemote - 1);
  passed('live authenticated socket refresh after another request commits');
  await page.locator('#barcodeScanForm [name="type"]').selectOption('FITTED');
  assert.equal(await page.locator('#barcodeBinLocation').isVisible(), false);
  await page.locator('#barcodeRaw').fill('HISTORY-1');
  await page.locator('#barcodeRaw').press('Enter');
  await page.waitForFunction(() => document.querySelector('#barcodeScanForm [name="regdNo"]') === document.activeElement);
  assert.equal(await page.locator('#barcodeRaw').inputValue(), 'HISTORY-1');
  await page.locator('#barcodeScanForm [name="regdNo"]').fill('CAR456');
  await page.locator('#barcodeScanForm [name="jobCardNo"]').fill('JC003');
  const fittedResponse = page.waitForResponse(response => response.url().endsWith('/api/scans/process') && response.request().method() === 'POST');
  await page.locator('#barcodeScanForm [name="jobCardNo"]').press('Tab');
  const fittedResult = await (await fittedResponse).json();
  assert.equal(fittedResult.success, true, JSON.stringify(fittedResult));
  assert.equal(await models.Inventory.countDocuments({ dealerCode, upiNo: 'HISTORY-1', scanType: 'FITTED' }), 1);
  await page.waitForFunction(expected => document.querySelector('#scanPartSummary').textContent.includes(`Available ${expected}`), (await summary()).availableQty);
  passed('desktop FITTED retains QR until vehicle/job details and shows committed part summary');
  assert.deepEqual(errors, []);
  await context.close();

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
  await mobile.addInitScript(({ token, user, dealerCode, auditId }) => {
    localStorage.setItem('dakshFreshSession', JSON.stringify({ token, user, dealerCode, auditId, dealerName: 'Scan Acceptance', activeAudit: { dealerCode, auditId, status: 'ACTIVE' } }));
    // Supply decoded camera input while retaining the real UI, sync API, database and sockets.
    window.BarcodeDetector = class {
      static async getSupportedFormats() { return ['qr_code']; }
      async detect() { window.acceptanceNativeFrames = (window.acceptanceNativeFrames || 0) + 1; const value = window.acceptanceBarcode; window.acceptanceBarcode = ''; return value ? [{ rawValue: value }] : []; }
    };
  }, { token, user, dealerCode, auditId });
  const mobilePage = await mobile.newPage();
  mobilePage.setDefaultTimeout(25000);
  mobilePage.on('pageerror', error => errors.push(error.message));
  await mobilePage.goto(`${origin}/mobile-web`);
  await mobilePage.locator('#scannerPanel').waitFor({ state: 'visible' });
  await mobilePage.locator('#manualBtn').click();
  assert.equal(await mobilePage.locator('#manualPartNumber').isDisabled(), true);
  await mobilePage.locator('#manualBinLocation').fill('C1');
  await mobilePage.locator('#manualBinLocation').press('Tab');
  await mobilePage.waitForFunction(() => !document.querySelector('#manualPartNumber').disabled);
  await mobilePage.locator('#manualCancelBtn').click();
  passed('mobile INWARD manual entry unlocks after dealer-bin validation');
  await mobilePage.locator('[data-mode="OUTWARD"]').click();
  assert.equal(await mobilePage.locator('#activeBinLocation').isVisible(), false);
  if ((await mobilePage.locator('#startScanBtn').textContent()).includes('Camera On')) await mobilePage.locator('#startScanBtn').click();
  await mobilePage.waitForFunction(() => document.querySelector('#cameraPreview').srcObject
    && document.querySelector('#cameraPreview').readyState >= 2
    && document.querySelector('#startScanBtn').textContent.includes('Camera Off'));
  await mobilePage.locator('#cameraPreview').scrollIntoViewIfNeeded();
  await mobilePage.waitForFunction(() => window.acceptanceNativeFrames > 0);
  const outwardResponse = mobilePage.waitForResponse(response => response.url().endsWith('/api/scans/process') && response.request().method() === 'POST');
  await mobilePage.evaluate(() => { window.acceptanceBarcode = 'HISTORY-2'; });
  const outwardResult = await (await outwardResponse).json();
  assert.equal(outwardResult.success, true, JSON.stringify(outwardResult));
  for (let attempt = 0; !(await models.Inventory.countDocuments({ dealerCode, upiNo: 'HISTORY-2', scanType: 'OUTWARD' })); attempt++) {
    assert.ok(attempt < 60, 'Mobile camera capture must persist OUTWARD');
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  const mobileQty = (await summary()).availableQty;
  await mobilePage.waitForFunction(expected => document.querySelector('#scanPartSummary').textContent.includes(`Available ${expected}`), mobileQty);
  await mobilePage.screenshot({ path: path.join(artifactDir, 'mobile-outward.png'), fullPage: true });
  passed('mobile camera OUTWARD uses automatic bin, persists through sync and updates part summary');
  assert.equal((await scan('OUTWARD', 'HISTORY-3')).success, true);
  await mobilePage.waitForFunction(expected => document.querySelector('#scanPartSummary').textContent.includes(`Available ${expected}`), mobileQty - 1);
  passed('mobile authenticated socket refresh updates committed part totals');
  const fittedQr = 'X/MOBILE-FITTED/X/53155AAW000S/1/100';
  assert.equal((await scan('INWARD', 'MOBILE-FITTED', 'B1', { rawScan: fittedQr })).success, true);
  const beforeMobileFit = (await summary()).availableQty;
  await mobilePage.locator('[data-mode="FITTED"]').click();
  assert.equal(await mobilePage.locator('#activeBinLocation').isVisible(), false);
  await mobilePage.evaluate(qr => { window.acceptanceBarcode = qr; }, fittedQr);
  await mobilePage.locator('#manualDialog').waitFor({ state: 'visible' });
  assert.equal(await mobilePage.locator('#manualBinLocation').isVisible(), false);
  await mobilePage.locator('#manualRegdNo').fill('CAR789');
  await mobilePage.locator('#manualJobCardNo').fill('JC004');
  await mobilePage.locator('#manualForm button[type="submit"]').click();
  await mobilePage.locator('#manualDialog').waitFor({ state: 'hidden' });
  for (let attempt = 0; !(await models.Inventory.countDocuments({ dealerCode, rawScan: fittedQr, scanType: 'FITTED' })); attempt++) {
    if (attempt === 60) {
      await mobilePage.screenshot({ path: path.join(artifactDir, 'mobile-fitted-failure.png'), fullPage: true });
      console.error('Mobile FITTED state', await mobilePage.locator('body').innerText());
    }
    assert.ok(attempt < 60, 'Mobile fitted details must persist FITTED');
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert.equal((await summary()).availableQty, beforeMobileFit);
  await mobilePage.waitForFunction(() => document.querySelector('#scanVisibleRows').textContent === '20');
  assert.equal(await mobilePage.locator('#torchBtn').isVisible(), false, 'Unsupported fake camera hides torch');
  await mobilePage.screenshot({ path: path.join(artifactDir, 'mobile-fitted.png'), fullPage: true });
  passed('mobile FITTED camera capture collects vehicle/job details and preserves total availability');
  assert.deepEqual(errors, []);
  await mobile.close();
  const optical = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await optical.addInitScript(({ token, user, dealerCode, auditId }) => {
    localStorage.setItem('dakshFreshSession', JSON.stringify({ token, user, dealerCode, auditId, activeAudit: { dealerCode, auditId, status: 'ACTIVE' } }));
    delete window.BarcodeDetector;
    window.acceptanceCameraStarts = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      window.acceptanceCameraStarts++;
      const canvas = document.createElement('canvas');
      canvas.width = 1280; canvas.height = 720;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      window.acceptanceCanvas = canvas;
      const stream = canvas.captureStream(0);
      setInterval(() => {
        ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        const image = window.acceptanceCameraImage;
        if (image) ctx.drawImage(image, (canvas.width - image.width) / 2, (canvas.height - image.height) / 2);
        stream.getVideoTracks()[0]?.requestFrame?.();
      }, 70);
      return stream;
    };
  }, { token, user, dealerCode, auditId });
  const opticalPage = await optical.newPage();
  opticalPage.setDefaultTimeout(30000);
  opticalPage.on('pageerror', error => errors.push(error.message));
  await opticalPage.goto(`${origin}/mobile-web?scanDebug=1`);
  await opticalPage.locator('#scannerPanel').waitFor({ state: 'visible' });
  // Use a fresh bin so the real 1D camera save is independent of previous fixture scans.
  await opticalPage.locator('#activeBinLocation').fill('CAMERA1');
  await opticalPage.locator('#saveBinBtn').click();
  try {
    await opticalPage.waitForFunction(() => document.querySelector('#binPanelMessage').textContent.includes('Scanning will save to bin CAMERA1'));
  } catch (error) {
    await opticalPage.screenshot({ path: path.join(artifactDir, 'mobile-bin-failure.png'), fullPage: true });
    console.error('Optical bin setup', await opticalPage.locator('#toast').textContent(),
      await opticalPage.locator('#binPanelMessage').textContent(), errors);
    throw error;
  }
  assert.equal(await models.Bin.countDocuments({ dealerCode, binCode: 'CAMERA1' }), 1);
  passed('mobile Set Bin creates a missing dealer bin and starts the camera');
  await opticalPage.waitForFunction(() => document.querySelector('#cameraPreview').readyState >= 2 && window.ZXingWASM);
  const starts = await opticalPage.evaluate(() => window.acceptanceCameraStarts);
  const captureImage = async (fixture, expectedPart, { clear = true } = {}) => {
    const savedResponse = opticalPage.waitForResponse(response => response.url().endsWith('/api/scans/process') && response.request().method() === 'POST').catch(async error => {
      await opticalPage.screenshot({ path: path.join(artifactDir, 'mobile-optical-failure.png'), fullPage: true });
      console.error('Optical capture failure', fixture, await opticalPage.locator('#cameraState').textContent(),
        await opticalPage.locator('#scanDecodeDebug').textContent(), await opticalPage.locator('#binPanelMessage').textContent(), errors);
      throw error;
    });
    await opticalPage.evaluate(async imageData => {
      const image = new Image(); image.src = imageData; await image.decode();
      window.acceptanceCameraImage = image;
      const canvas = window.acceptanceCanvas, ctx = canvas.getContext('2d');
      ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, (canvas.width - image.width) / 2, (canvas.height - image.height) / 2);
    }, `data:image/png;base64,${fs.readFileSync(path.join('test/fixtures/barcodes', fixture)).toString('base64')}`);
    const result = await (await savedResponse).json();
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.scan.partNumber, expectedPart);
    if (clear) await opticalPage.evaluate(() => { window.acceptanceCameraImage = null; const ctx = window.acceptanceCanvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1280, 720); });
    return result;
  };
  const oneD = await captureImage('fixture-code128.png', '32410KTC920S');
  assert.equal(oneD.scan.parsedCode.barcodeFormat, 'CODE_128');
  // QR uses the existing INWARD bin lifecycle and the same unchanged camera stream.
  const hero = await captureImage('fixture-qrcode.png', '44831KVH900S');
  assert.equal(hero.scan.parsedCode.upi, 'EBHPE5EQTWD4');
  assert.equal(await opticalPage.evaluate(() => window.acceptanceCameraStarts), starts);
  await opticalPage.locator('#scanDecodeDebug').waitFor({ state: 'visible' });
  await opticalPage.screenshot({ path: path.join(artifactDir, 'mobile-real-decoder.png'), fullPage: true });
  assert.deepEqual(errors, []);
  passed('mobile camera optically decodes CODE128 and Hero QR with one continuous stream and visible raw development log');
  const beforeHeldSku = await models.Inventory.countDocuments({ dealerCode, partNumber: '32410KTC920S', binLocation: 'CAMERA1', scanType: 'INWARD' });
  const sampleSku = await captureImage('fixture-hero-sku-code128.png', '32410KTC920S', { clear: false });
  assert.equal(sampleSku.scan.barcodeIdentityKind, 'SKU');
  assert.equal(sampleSku.scan.upiNo, '');
  const heldStarted = await opticalPage.evaluate(() => performance.now());
  await opticalPage.waitForFunction(started => performance.now() - started > 3000, heldStarted);
  assert.equal(await models.Inventory.countDocuments({ dealerCode, partNumber: '32410KTC920S', binLocation: 'CAMERA1', scanType: 'INWARD' }), beforeHeldSku + 1);
  await opticalPage.evaluate(() => { window.acceptanceCameraImage = null; const ctx = window.acceptanceCanvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1280, 720); });
  passed('mobile camera decodes the complete sample SKU and a continuously held label adds only one piece');
  // Exercise recovery with the actual fallback decoder and the same live stream.
  await opticalPage.evaluate(() => {
    window.ZXingWASM.readBarcodes = async () => { throw new Error('Acceptance decoder runtime failure'); };
  });
  const fallbackBarcode = await captureImage('fixture-ean13.png', '4006381333931');
  assert.equal(fallbackBarcode.scan.parsedCode.barcodeFormat, 'EAN_13');
  await opticalPage.locator('[data-mode="OUTWARD"]').click();
  const fallbackQr = await captureImage('fixture-qrcode.png', '44831KVH900S');
  assert.equal(fallbackQr.scan.scanType, 'OUTWARD');
  assert.equal(fallbackQr.scan.parsedCode.upi, 'EBHPE5EQTWD4');
  assert.equal(fallbackQr.scan.parsedCode.barcodeFormat, 'QR_CODE');
  assert.equal(await opticalPage.evaluate(() => window.acceptanceCameraStarts), starts);
  assert.deepEqual(errors, []);
  passed('decoder runtime failure falls back to real 1D and QR decoding without reopening the camera');
  await optical.close();
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server && server.exitCode === null) { server.kill(); await new Promise(resolve => server.once('exit', resolve)); }
  if (log !== undefined) fs.closeSync(log);
  // Only fixtures owned by this run are removed.
  for (const name of ['inventory', 'audit', 'bin', 'masterPart', 'dealer', 'partBinLocation', 'duplicateScanLog', 'scanAuditLog', 'rejectedScan', 'syncLog']) {
    await prisma[name].deleteMany({ where: { dealerCode } });
  }
  if (user) await prisma.user.deleteMany({ where: { id: user.id } });
  if (secondUser) await prisma.user.deleteMany({ where: { id: secondUser.id } });
  await prisma.$disconnect();
});
