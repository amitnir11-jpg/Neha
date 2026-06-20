const assert = require('assert');
const Inventory = require('../models/Inventory');
const Scan = require('../models/Scan');
const duplicatePolicy = require('../utils/scanDuplicatePolicy');

const inwardScan = {
  dealerCode: 'D001',
  auditId: 'AUDIT-1',
  scanType: 'INWARD',
  binLocation: 'BIN-A',
  rawScan: 'OEM/UPI-987654/X/PART-100/1/500'
};
const sameScopeInward = {
  ...inwardScan,
  partNumber: 'OTHER-PART'
};
const differentScopeInward = {
  ...inwardScan,
  dealerCode: 'D999',
  auditId: 'AUDIT-9'
};
const nonInward = {
  ...sameScopeInward,
  scanType: 'DAMAGE'
};

assert.strictEqual(duplicatePolicy.canonicalUpiValue(inwardScan), 'UPI-987654');
assert.notStrictEqual(duplicatePolicy.globalUpiKey(inwardScan), duplicatePolicy.globalUpiKey(differentScopeInward));
assert.strictEqual(duplicatePolicy.globalUpiKey(inwardScan), duplicatePolicy.globalUpiKey(sameScopeInward));
assert.strictEqual(duplicatePolicy.globalUpiKey({ partNumber: 'PART-100', source: 'manual' }), '');

const activeFilter = duplicatePolicy.activeUpiDuplicateFilter(sameScopeInward);
assert(activeFilter, 'active UPI duplicate filter should exist for inward scans');
assert.strictEqual(activeFilter.dealerCode, inwardScan.dealerCode);
assert.strictEqual(activeFilter.auditId, inwardScan.auditId);
assert.strictEqual(activeFilter.activeInventory.$ne, false);
assert(activeFilter.$and.some((group) => group.$or.some((term) => term.movementType === 'INWARD' || term.scanType === 'INWARD' || term.type === 'INWARD')));
assert(activeFilter.$or.some((term) => term.upiCode === 'UPI-987654' || term.upiNo === 'UPI-987654' || term.upiId === 'UPI-987654'));
assert.strictEqual(duplicatePolicy.globalUpiDuplicateFilter(nonInward), null);

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
assert(message.startsWith('This UPI is already scanned in Bin Location: BIN-A, Part No: PART100, Scanned Date/Time:'));

const inventoryIndexes = Inventory.schema.indexes();
assert(inventoryIndexes.some(([fields, options]) => fields.upiCode === 1 && options.name === 'inventory_upi_code_idx'));
assert(inventoryIndexes.some(([fields, options]) => fields.dealerCode === 1 && fields.auditId === 1 && fields.upiCode === 1 && fields.movementType === 1 && fields.activeInventory === 1 && options.name === 'inventory_active_upi_lookup_idx'));

const scanIndexes = Scan.schema.indexes();
assert(scanIndexes.some(([fields, options]) => fields.upiCode === 1 && options.name === 'scan_upi_code_idx'));
assert(scanIndexes.some(([fields, options]) => fields.dealerCode === 1 && fields.auditId === 1 && fields.upiCode === 1 && fields.movementType === 1 && fields.activeInventory === 1 && options.name === 'scan_active_upi_lookup_idx'));

console.log('Duplicate UPI regression checks passed.');
