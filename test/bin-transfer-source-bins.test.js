const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Inventory = require('../models/Inventory');
const Bin = require('../models/Bin');
const router = require('../routes/binTransfer');

test('Bin Transfer screen has no reset control', () => {
  const html = fs.readFileSync('public/Daksh.html', 'utf8');
  const ui = fs.readFileSync('public/ui.js', 'utf8');
  assert.doesNotMatch(html, /id="binTransferResetBtn"/);
  assert.doesNotMatch(ui, /binTransferResetBtn/);
});

test('bin transfer source options only include bins with available scanned stock', async () => {
  const inventoryFind = Inventory.find;
  const binFind = Bin.find;
  try {
    Inventory.find = (filter) => {
      assert.equal(filter.dealerCode, '11646');
      assert.equal(filter.auditId, 'AUD1');
      assert.equal(filter.syncStatus, 'synced');
      assert.equal(filter.isDuplicate.$ne, true);
      assert.ok(filter.$and.some((clause) => clause.scanStatus?.$in?.includes('ACCEPTED')));
      assert.ok(filter.$and.length >= 3);
      return {
        select() { return this; },
        sort() { return this; },
        async lean() { return [
          { _id: 'scan1', dealerCode: '11646', auditId: 'AUD1', partNumber: 'PART1', scanType: 'INWARD', qty: 8, binLocation: '1' },
          { _id: 'scan2', dealerCode: '11646', auditId: 'AUD1', partNumber: 'PART2', scanType: 'INWARD', qty: 1, binLocation: 'A1' },
          { _id: 'scan3', dealerCode: '11646', auditId: 'AUD1', partNumber: 'PART2', scanType: 'OUTWARD', qty: 1, binLocation: 'A1', stockDeductedFromBin: 'A1' }
        ]; }
      };
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
    Inventory.find = inventoryFind;
    Bin.find = binFind;
  }
});
