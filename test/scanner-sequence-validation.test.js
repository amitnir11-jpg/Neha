const assert = require('node:assert/strict');
const test = require('node:test');
const parser = require('../utils/scanParser');
const sync = require('../routes/sync');

const oneDimensionalExamples = [
  '77238KTC900ZCS/G3122000021001',
  '61108AACH40ZCS/D3533000166001'
];

const paddedQr = 'D/GHCG0000926915/HCGLDYY6KJ2T/20K1120S          /000001/0000920.00/ABL/1/G/000/0';
const testQr = 'D/TEST0000000002/TESTUPI00002/12395AANB00S /000004/0000010.00/AAA/1/G/000/00';

test('accepts supported Hero one-dimensional barcode structures', () => {
  for (const raw of oneDimensionalExamples) {
    const result = parser.validateScannerSequence(raw);
    assert.equal(result.valid, true, raw);
    assert.equal(result.parsed.success, true, raw);
  }
});

test('accepts padded and test QR payloads without losing encoded quantity or raw padding', () => {
  for (const [raw, expectedPart, expectedQty] of [
    [paddedQr, '20K1120S', 1],
    [testQr, '12395AANB00S', 4]
  ]) {
    const validation = parser.validateScannerSequence(raw);
    const parsed = parser.parseScanValue(raw);
    assert.equal(validation.valid, true, raw);
    assert.equal(parsed.success, true, raw);
    assert.equal(parsed.partNumber, expectedPart);
    assert.equal(parsed.quantity, expectedQty);
    assert.equal(parsed.rawScan, raw);
  }
});

test('rejects plain part numbers and malformed or unsupported sequences', () => {
  for (const raw of ['20K211S', '20K411S', '41241AAN410S', 'D/TEST/UPI/PART/BAD/PRICE/A/1/G/000/00', 'A/B/C']) {
    assert.equal(parser.validateScannerSequence(raw).valid, false, raw);
    for (const format of ['UNKNOWN', 'CODE_128', 'CODE_39', 'QR_CODE']) {
      assert.equal(parser.validateScannerSequence(raw, format).valid, false, `${format}: ${raw}`);
    }
  }
});

test('accepts no-slash direct values only when the decoder supplies a supported 1D format', () => {
  assert.equal(parser.validateScannerSequence('ABC12345').valid, false);
  assert.equal(parser.validateScannerSequence('ABC12345', 'CODE_128').valid, true);
  assert.equal(parser.validateScannerSequence('20K211S', 'QR_CODE').valid, false);
  assert.equal(parser.validateScannerSequence('4006381333931').valid, true);
  assert.equal(parser.validateScannerSequence('96385074').valid, true);
  assert.equal(parser.validateScannerSequence('4006381333932').valid, false);
  assert.equal(parser.validateScannerSequence('A123456B').valid, true);
});

test('server scan processing rejects a plain part before entering inventory processing', async () => {
  for (const scanType of ['INWARD', 'OUTWARD', 'DAMAGE', 'FITTED']) {
   for (const body of [
    { rawScan: '20K211S', partNumber: '20K211S' },
    { rawScan: '20K411S', partNumber: '20K411S', barcodeFormat: 'CODE_128', cameraDecoded: true },
    { rawScan: '41241AAN410S', barcodeFormat: 'CODE_39', cameraDecoded: true },
    { rawScan: 'unknown/broken' },
    { partNumber: '20K211S' }
  ]) {
    const scan = sync.normalizeScan({
      ...body,
      source: 'barcode',
      dealerCode: 'TEST',
      scanType
    });
    const result = await sync.saveNormalizedScan(scan, {
      body: {},
      app: { get: () => null }
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.httpStatus, 422);
    assert.equal(result.code, 'INVALID_SCANNER_SEQUENCE');
    assert.equal(result.title, parser.invalidScannerSequenceTitle);
    assert.equal(result.message, parser.invalidScannerSequenceMessage);
   }
  }
});

test('QR quantities 1, 2, 4, 5, 10 and 20 survive scanner validation', () => {
  for (const qty of [1, 2, 4, 5, 10, 20]) {
    const raw = testQr.replace('000004', String(qty).padStart(6, '0'));
    const validation = parser.validateScannerSequence(raw);
    assert.equal(validation.valid, true);
    assert.equal(validation.parsed.quantity, qty);
    assert.equal(validation.parsed.rawValue, raw);
  }
});

test('existing structured JSON, query/URL and key-value labels remain supported', () => {
  for (const raw of ['{"partNumber":"20K211S","qty":4,"upi":"UNIQUE001"}',
    'part=20K211S|qty=2', 'https://parts.test/?part=20K211S&qty=5', '{"partNumber":"20K211S"}']) {
    assert.equal(parser.validateScannerSequence(raw).valid, true, raw);
  }
  assert.equal(parser.validateScannerSequence('4006381333932', 'EAN_13').valid, false);
});

function response() {
  return { statusCode: 200, status(value) { this.statusCode = value; return this; },
    json(value) { this.data = value; return this; }, setHeader() {} };
}

test('bulk mobile sync rejects invalid rows before any database connection or transaction', async () => {
  const res = response();
  await sync.pushHandler({ body: { scans: [{ rawScanString: '20K211S', source: 'mobile',
    barcodeFormat: 'CODE_128', partNumber: '20K211S', localId: 'INVALID-LOCAL' }] },
    app: { get: () => null } }, res);
  assert.equal(res.statusCode, 422);
  assert.equal(res.data.insertedCount, 0);
  assert.equal(res.data.code, 'INVALID_SCANNER_SEQUENCE');
  assert.equal(res.data.logs[0].localId, 'INVALID-LOCAL');
});

test('web and mobile process services carry the rejection code and never request stock summaries', async () => {
  const { processScan } = require('../services/ScanProcessingService');
  const result = await processScan({ rawScanString: '20K211S', source: 'barcode' },
    { req: { app: { get: () => null } } });
  assert.equal(result.httpStatus, 422);
  assert.equal(result.code, 'INVALID_SCANNER_SEQUENCE');
  assert.equal(result.insertedCount, 0);
  assert.equal(result.partSummary, undefined);
});

test('code resolution and legacy inventory sync reject invalid scanner input before database access', async () => {
  const inventory = require('../routes/inventory');
  const resolve = inventory.stack.find(layer => layer.route?.path === '/resolve-code').route.stack.at(-1).handle;
  const res = response();
  await resolve({ query: { dealerCode: 'TEST', rawValue: '20K211S' } }, res);
  assert.equal(res.statusCode, 422);
  assert.equal(res.data.code, 'INVALID_SCANNER_SEQUENCE');
  const legacy = inventory.stack.find(layer => layer.route?.path === '/sync').route.stack.at(-1).handle;
  const batchRes = response();
  await legacy({ body: { scans: [{ rawScan: '20K211S', source: 'mobile' }] }, user: {} }, batchRes);
  assert.equal(batchRes.data.savedCount || 0, 0);
  assert.equal(batchRes.data.failedItems[0].code, 'INVALID_SCANNER_SEQUENCE');
});
