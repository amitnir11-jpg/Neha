const assert = require('assert');
const { movementTypeValue } = require('../utils/inventoryMovementState');
const { summarizeMovementBucket } = require('../utils/inventoryValueEngine');

const scans = [
  { partNumber: 'ABC123', scanType: 'inward', qty: 10 },
  { partNumber: 'ABC123', scanType: 'Outward', qty: 2 },
  { partNumber: 'ABC123', scanType: 'Fitted', qty: 1 },
  { partNumber: 'ABC123', scanType: 'DAMAGE', qty: 1 },
  { partNumber: 'ABC123', scanType: 'INWARD', qty: 100, isDeleted: true },
  { partNumber: 'ABC123', scanType: 'INWARD', qty: 100, deletedAt: new Date() }
];

assert.strictEqual(movementTypeValue({ scanType: 'out' }), 'OUTWARD');
assert.strictEqual(movementTypeValue({ scanType: 'fitted' }), 'FITTED');
const summary = summarizeMovementBucket(scans);
assert.strictEqual(summary.inwardQty, 10);
assert.strictEqual(summary.outwardQty, 2);
assert.strictEqual(summary.fittedQty, 1);
assert.strictEqual(summary.damageQty, 1);
assert.strictEqual(summary.netQty, 6);
assert.strictEqual(summary.remainingQty, 6);
console.log('Active scan movement calculation checks passed.');
