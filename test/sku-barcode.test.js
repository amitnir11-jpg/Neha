const test = require('node:test');
const assert = require('node:assert/strict');
const parser = require('../utils/scanParser');
const policy = require('../utils/scanDuplicatePolicy');
const { makeQrFingerprint } = require('../utils/scanIdentity');
const { calculateSkuBins } = require('../services/SkuStockService');
const { calculatePartStock } = require('../services/StockCalculationService');
const { reportTotals, applyMovementCountRules } = require('../utils/reportTotals');
const { summarizeMovementBucket } = require('../utils/inventoryValueEngine');
const { legacyHeroBarcodeIdentity } = require('../utils/scanIdentity');

test('validated Hero 1D packaging label is a SKU, not a fabricated serial/UPI', () => {
  const raw = '32410KTC920S/G3223000065001';
  for (const format of ['CODE_128', 'CODE_39', 'UNKNOWN']) {
    const scan = parser.parseScannedCode(raw, format);
    assert.equal(scan.partNumber, '32410KTC920S');
    assert.equal(scan.rawValue, raw);
    assert.equal(scan.identityKind, 'SKU');
    assert.equal(scan.hasUniqueItemId, false);
    assert.equal(scan.upi, null);
    assert.equal(scan.quantity, 1);
  }
  assert.equal(parser.parseScanValue(raw).partNumber, '32410KTC920S');
  for (const raw of ['32410KTC920S/UNKNOWN', 'UNKNOWN/G3223000065001', '32410KTC920S/G123', '32410KTC920S/G3223000065001/EXTRA']) {
    assert.equal(parser.parseScannedCode(raw, 'CODE_128').success, false, raw);
  }
});

test('legacy Hero barcode labels block the same inward barcode but do not claim the suffix is a UPI', () => {
  const scan = { barcodeIdentityKind: 'SKU', rawScan: '32410KTC920S/G3223000065001', partNumber: '32410KTC920S', dealerCode: 'D01', auditId: 'A1', scanType: 'INWARD', uniqueScanId: 'PHYSICAL-SCAN-1' };
  assert.equal(legacyHeroBarcodeIdentity(scan), '32410KTC920S/G3223000065001');
  assert.equal(legacyHeroBarcodeIdentity({ ...scan, rawScan: '32410KTC920S' }), '');
  assert.equal(policy.globalUpiKey(scan), '');
  assert.equal(policy.canonicalUpiValue(scan), '');
  assert.equal(policy.rawUpiHash(scan), '');
  assert.ok(makeQrFingerprint(scan));
  assert.equal(makeQrFingerprint(scan), makeQrFingerprint({ ...scan, binLocation: 'B2', uniqueScanId: 'PHYSICAL-SCAN-2' }));
  assert.notEqual(makeQrFingerprint(scan), makeQrFingerprint({ ...scan, rawScan: '32410KTC920S/G3223000065002' }));
  assert.equal(makeQrFingerprint({ ...scan, scanType: 'OUTWARD' }), '');
  assert.equal(policy.activeUpiDuplicateFilter(scan), null);
  assert.ok(policy.identityDuplicateFilter(scan));
  const qr = parser.parseScannedCode('D/132/HE5B0199510/EBHPE5EQTWD4/44831KVH900S/001/20170505125743/00', 'QR_CODE');
  assert.equal(qr.identityKind, 'UNIQUE_UPI');
  assert.equal(qr.upi, 'EBHPE5EQTWD4');
  const matrix = parser.parseScannedCode('PART=32410KTC920S|UPI=DMUNIQUE123', 'DATA_MATRIX');
  assert.equal(matrix.identityKind, 'UNIQUE_UPI');
  assert.equal(matrix.barcodeType, '2D');
  assert.equal(matrix.upi, 'DMUNIQUE123');
});

test('SKU physical source bins exclude tracked UPIs, fitted pending stock, deleted and invalid rows', () => {
  const row = (id, type, bin, extras = {}) => ({ uniqueScanId: id, partNumber: '32410KTC920S', barcodeIdentityKind: 'SKU', scanType: type, binLocation: bin, quantity: 1, masterFound: true, scanStatus: 'ACCEPTED', syncStatus: 'synced', ...extras });
  const rows = [row('in1', 'INWARD', 'A1'), row('in2', 'INWARD', 'A1'), row('in3', 'INWARD', 'B1'),
    row('fit', 'FITTED', 'A1', { status: 'FITTED_PENDING', fittedQty: 1 }),
    row('upi', 'INWARD', 'C1', { barcodeIdentityKind: 'UNIQUE_UPI', upiNo: 'UPI123' }),
    row('deleted', 'INWARD', 'D1', { isDeleted: true }), row('invalid', 'INWARD', 'E1', { scanStatus: 'REJECTED' })];
  assert.deepEqual(calculateSkuBins(rows), [{ binLocation: 'A1', availableQty: 1 }, { binLocation: 'B1', availableQty: 1 }]);
});

test('repeated SKU transactions agree across part totals, dashboard and reports', () => {
  const rows = ['INWARD', 'INWARD', 'INWARD', 'OUTWARD', 'FITTED'].map((scanType, index) => ({
    uniqueScanId: `SKU${index}`, dealerCode: 'D01', auditId: 'A1', partNumber: '32410KTC920S',
    rawScan: '32410KTC920S/G3223000065001', barcodeIdentityKind: 'SKU', scanType,
    quantity: 1, binLocation: 'A1', masterFound: true, scanStatus: 'ACCEPTED', syncStatus: 'synced',
    ...(scanType === 'FITTED' ? { fittedQty: 1, status: 'FITTED_PENDING' } : {}) }));
  const totals = calculatePartStock(rows, '32410KTC920S');
  assert.equal(totals.inwardQty, 3);
  assert.equal(totals.storeQty, 1);
  assert.equal(totals.availableQty, 2);
  assert.equal(reportTotals(applyMovementCountRules(rows)).totalDealerStockQty, 2);
  assert.equal(summarizeMovementBucket(rows).totalDealerStockQty, 2);
});
