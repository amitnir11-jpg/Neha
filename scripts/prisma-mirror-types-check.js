const assert = require('assert');
const { Prisma } = require('../services/prisma');
const { booleanMirrorValue, valueForMirror } = require('../models/prismaModel');
const { activeInventoryValue } = require('../utils/inventoryMovementState');

const inventory = Prisma.dmmf.datamodel.models.find((model) => model.name === 'Inventory');
const field = (name) => inventory.fields.find((item) => item.name === name);

assert.strictEqual(booleanMirrorValue('true'), true);
assert.strictEqual(booleanMirrorValue('false'), false);
assert.strictEqual(activeInventoryValue({ activeInventory: 'true', scanType: 'OUTWARD', qty: 0 }), true);
assert.strictEqual(activeInventoryValue({ activeInventory: 'false', scanType: 'INWARD', qty: 1 }), false);
assert.strictEqual(valueForMirror({ activeInventory: 'true' }, 'activeInventory', field('activeInventory')), true);
assert.strictEqual(valueForMirror({ activeInventory: 'false' }, 'activeInventory', field('activeInventory')), false);
assert.strictEqual(valueForMirror({ remainingQty: '1.25' }, 'remainingQty', field('remainingQty')), 1.25);
assert.ok(valueForMirror({ timestamp: '2026-06-22T04:39:46.184Z' }, 'timestamp', field('timestamp')) instanceof Date);
assert.strictEqual(valueForMirror({ dealerCode: 24780 }, 'dealerCode', field('dealerCode')), '24780');

console.log('Prisma mirror type checks passed.');
