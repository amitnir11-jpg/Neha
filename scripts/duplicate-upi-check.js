const assert = require('assert');
const Inventory = require('../models/Inventory');
const Scan = require('../models/Scan');
const duplicatePolicy = require('../utils/scanDuplicatePolicy');

const inwardScan = {
  dealerCode: 'D001',
  auditId: 'AUDIT-1',
  scanType: 'INWARD',
  partNumber: 'PART-100',
  binLocation: 'BIN-A',
  rawScan: 'OEM/UPI-987654/X/PART-100/1/500'
};
const sameScopeInward = {
  ...inwardScan,
  partNumber: 'PART-100'
};
const differentQrSamePartSameBin = {
  ...inwardScan,
  rawScan: 'OEM/UPI-222222/X/PART-100/1/500'
};
const differentScopeInward = {
  ...inwardScan,
  dealerCode: 'D999',
  auditId: 'AUDIT-9'
};
const differentBinInward = {
  ...inwardScan,
  binLocation: 'BIN-B'
};
const differentPartInward = {
  ...inwardScan,
  partNumber: 'PART-101'
};
const nonInward = {
  ...sameScopeInward,
  scanType: 'DAMAGE'
};

assert.strictEqual(duplicatePolicy.canonicalUpiValue(inwardScan), 'UPI-987654');
assert.strictEqual(duplicatePolicy.globalUpiKey(inwardScan), duplicatePolicy.globalUpiKey(differentScopeInward));
assert.strictEqual(duplicatePolicy.globalUpiKey(inwardScan), duplicatePolicy.globalUpiKey(differentBinInward));
assert.strictEqual(duplicatePolicy.globalUpiKey(inwardScan), duplicatePolicy.globalUpiKey(differentPartInward));
assert.strictEqual(duplicatePolicy.globalUpiKey(inwardScan), duplicatePolicy.globalUpiKey(sameScopeInward));
assert.notStrictEqual(duplicatePolicy.globalUpiKey(inwardScan), duplicatePolicy.globalUpiKey(differentQrSamePartSameBin));
assert.strictEqual(duplicatePolicy.globalUpiKey({ partNumber: 'PART-100', rawScanString: 'MANUAL:PART-100', source: 'manual' }), '');

const activeFilter = duplicatePolicy.activeUpiDuplicateFilter(sameScopeInward);
assert(activeFilter, 'global UPI duplicate filter should exist for QR scans');
assert.strictEqual(Object.prototype.hasOwnProperty.call(activeFilter, 'dealerCode'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(activeFilter, 'auditId'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(activeFilter, 'activeInventory'), false);
assert(activeFilter.$or.some((term) => term.upiCode?.$regex || term.upiNo?.$regex || term.upiId?.$regex));
assert(duplicatePolicy.globalUpiDuplicateFilter(nonInward), 'damage QR scans must also use global duplicate validation');

const identityFilter = duplicatePolicy.identityDuplicateFilter({
  ...inwardScan,
  uniqueScanId: 'SCAN-1',
  scanId: 'SCAN-1',
  syncKey: 'SYNC-1'
});
assert(identityFilter, 'identity duplicate filter should exist for exact request ids');
assert.deepStrictEqual(identityFilter.$or, [
  { uniqueScanId: 'SCAN-1' },
  { scanId: 'SCAN-1' },
  { clientScanId: 'SCAN-1' },
  { syncKey: 'SYNC-1' },
  { clientSyncKey: 'SYNC-1' }
]);
assert.strictEqual(Object.prototype.hasOwnProperty.call(identityFilter, 'rawUpiHash'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(identityFilter, 'qrFingerprint'), false);

const message = duplicatePolicy.duplicateUpiMessage({
  binLocation: 'BIN-A',
  partNumber: 'PART-100',
  timestamp: '2026-06-14T08:00:00.000Z'
});
assert.strictEqual(message, 'This QR code is already scanned.');

const inventoryIndexes = Inventory.schema.indexes();
assert(inventoryIndexes.some(([fields, options]) => fields.upiCode === 1 && options.name === 'inventory_upi_code_idx'));
assert(inventoryIndexes.some(([fields, options]) => fields.dealerCode === 1 && fields.auditId === 1 && fields.upiCode === 1 && fields.movementType === 1 && fields.activeInventory === 1 && options.name === 'inventory_active_upi_lookup_idx'));

const scanIndexes = Scan.schema.indexes();
assert(scanIndexes.some(([fields, options]) => fields.upiCode === 1 && options.name === 'scan_upi_code_idx'));
assert(scanIndexes.some(([fields, options]) => fields.dealerCode === 1 && fields.auditId === 1 && fields.upiCode === 1 && fields.movementType === 1 && fields.activeInventory === 1 && options.name === 'scan_active_upi_lookup_idx'));

console.log('Duplicate UPI regression checks passed.');
