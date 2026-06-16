const assert = require('assert');
const Inventory = require('../models/Inventory');
const duplicatePolicy = require('../utils/scanDuplicatePolicy');

const first = {
  dealerCode: 'D001',
  auditId: 'AUDIT-1',
  scanType: 'INWARD',
  binLocation: 'BIN-A',
  rawScan: 'OEM/UPI-987654/X/PART-100/1/500'
};
const second = {
  dealerCode: 'D999',
  auditId: 'AUDIT-9',
  scanType: 'DAMAGE',
  binLocation: 'BIN-Z',
  upiId: 'upi-987654',
  partNumber: 'OTHER-PART'
};
const sameAuditSecondScan = {
  ...second,
  dealerCode: first.dealerCode,
  auditId: first.auditId
};

assert.strictEqual(duplicatePolicy.canonicalUpiValue(first), 'UPI-987654');
assert.notStrictEqual(duplicatePolicy.globalUpiKey(first), duplicatePolicy.globalUpiKey(second));
assert.strictEqual(duplicatePolicy.globalUpiKey(first), duplicatePolicy.globalUpiKey(sameAuditSecondScan));
assert.strictEqual(duplicatePolicy.globalUpiKey({ partNumber: 'PART-100', source: 'manual' }), '');

const filter = duplicatePolicy.globalUpiDuplicateFilter(sameAuditSecondScan);
assert.strictEqual(filter.syncStatus, 'synced');
assert.strictEqual(filter.dealerCode, first.dealerCode);
assert.strictEqual(filter.auditId, first.auditId);
assert.deepStrictEqual(filter.scanStatus.$in, duplicatePolicy.COUNTED_SCAN_STATUSES);
assert(filter.$or.some((term) => term.globalUpiKey === duplicatePolicy.globalUpiKey(first)));

const message = duplicatePolicy.duplicateUpiMessage({
  binLocation: 'BIN-A',
  partNumber: 'PART-100',
  timestamp: '2026-06-14T08:00:00.000Z'
});
assert(message.startsWith('This UPI is already scanned in Bin Location: BIN-A, Part No: PART100, Scanned Date/Time:'));

const uniqueIndex = Inventory.schema.indexes().find(([fields, options]) => fields.globalUpiKey === 1 && options.name === 'global_upi_key_unique');
assert(uniqueIndex, 'global UPI index is missing');
assert.strictEqual(uniqueIndex[1].unique, true);

const dealerAuditUpiIndex = Inventory.schema.indexes().find(([fields, options]) => (
  fields.dealerCode === 1 && fields.auditId === 1 && fields.upiNo === 1 && options.name === 'dealer_audit_upi_unique'
));
assert(dealerAuditUpiIndex, 'dealer/audit UPI unique index is missing');
assert.strictEqual(dealerAuditUpiIndex[1].unique, true);
assert.strictEqual(dealerAuditUpiIndex[1].partialFilterExpression.syncStatus, 'synced');

console.log('Duplicate UPI regression checks passed.');
