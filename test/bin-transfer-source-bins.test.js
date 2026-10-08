const test = require('node:test');
const assert = require('node:assert/strict');
const Inventory = require('../models/Inventory');
const Bin = require('../models/Bin');
const router = require('../routes/binTransfer');

test('bin transfer source options only include bins with available scanned stock', async () => {
  const inventoryAggregate = Inventory.aggregate;
  const binFind = Bin.find;
  try {
    Inventory.aggregate = async (pipeline) => {
      const match = pipeline[0].$match;
      assert.equal(match.dealerCode, '11646');
      assert.equal(match.auditId, 'AUD1');
      assert.equal(match.syncStatus, 'synced');
      assert.equal(match.isDeleted.$ne, true);
      assert.equal(match.isDuplicate.$ne, true);
      assert.ok(match.$and.length >= 2);
      return [{ _id: '1', qty: 8 }];
    };
    Bin.find = () => ({
      sort() { return this; },
      async lean() { return [{ binCode: '1' }, { binCode: 'A1' }, { binCode: 'A2' }]; }
    });
    const route = router.stack.find((layer) => layer.route?.path === '/bins').route;
    const handler = route.stack.at(-1).handle;
    const response = { payload: null, statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.payload = value; return this; } };

    await handler({ query: { dealerCode: '11646', auditId: 'AUD1' } }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.auditId, 'AUD1');
    assert.deepEqual(response.payload.bins.map((bin) => bin.binCode), ['1']);
    assert.deepEqual(response.payload.sourceBins.map((bin) => bin.binCode), ['1']);
    assert.deepEqual(response.payload.destinationBins, ['1', 'A1', 'A2']);
  } finally {
    Inventory.aggregate = inventoryAggregate;
    Bin.find = binFind;
  }
});
