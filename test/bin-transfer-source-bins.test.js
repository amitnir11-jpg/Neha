const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Inventory = require('../models/Inventory');
const Bin = require('../models/Bin');
const router = require('../routes/binTransfer');

function responseStub() {
  return { payload: null, statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; } };
}

function routeHandler(path) {
  const route = router.stack.find((layer) => layer.route?.path === path)?.route;
  assert.ok(route, `route ${path} exists`);
  return route.stack.at(-1).handle;
}

test('Bin Transfer screen has no reset control', () => {
  const html = fs.readFileSync('public/Daksh.html', 'utf8');
  const ui = fs.readFileSync('public/ui.js', 'utf8');
  assert.doesNotMatch(html, /id="binTransferResetBtn"/);
  assert.doesNotMatch(ui, /binTransferResetBtn/);
});

test('Source Bin uses the checkbox multi-select control with an independent Select All option', () => {
  const html = fs.readFileSync('public/Daksh.html', 'utf8');
  const ui = fs.readFileSync('public/ui.js', 'utf8');
  const sourceField = html.match(/<div class="bin-transfer-source-field">([\s\S]*?)<\/div><\/div>/)?.[1] || '';
  assert.match(sourceField, /bin-transfer-source-trigger/);
  assert.match(sourceField, /bin-transfer-source-all/);
  assert.match(sourceField, /bin-transfer-source-options/);
  assert.match(ui, /allOption\.indeterminate = someBinsSelected && !everyBinSelected/);
  assert.match(ui, /All Bins Selected/);
  assert.match(ui, /event\.key !== 'Escape'/);
  assert.match(ui, /bin-transfer-source-picker/);
  assert.match(html, /id="binTransferSelectAll" type="checkbox"/);
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

test('Bin Transfer only exposes live positive-stock bins and scopes multi-bin search to selected bins', async () => {
  const inventoryFind = Inventory.find;
  const binFind = Bin.find;
  const rows = [
    { _id: 'a1', dealerCode: '11646', auditId: 'AUD1', partNumber: 'ABC123', scanType: 'INWARD', qty: 8, binLocation: '1', syncStatus: 'synced', scanStatus: 'ACCEPTED' },
    { _id: 'a2', dealerCode: '11646', auditId: 'AUD1', partNumber: 'XYZ9', scanType: 'INWARD', qty: 2, binLocation: '2', syncStatus: 'synced', scanStatus: 'ACCEPTED' },
    { _id: 'a3', dealerCode: '11646', auditId: 'AUD1', partNumber: 'XYZ9', scanType: 'OUTWARD', qty: 2, binLocation: '2', stockDeductedFromBin: '2', syncStatus: 'synced', scanStatus: 'OUTWARD_DONE' },
    { _id: 'a6', dealerCode: '11646', auditId: 'AUD1', partNumber: 'ABC123', scanType: 'INWARD', qty: 3, binLocation: '6', syncStatus: 'synced', scanStatus: 'ACCEPTED' },
    { _id: 'a4', dealerCode: '11646', auditId: 'AUD1', partNumber: 'OLD', scanType: 'INWARD', qty: 5, binLocation: '3', isDeleted: true, deletedAt: new Date(), syncStatus: 'synced', scanStatus: 'ACCEPTED' },
    { _id: 'a5', dealerCode: '11646', auditId: 'AUD1', partNumber: 'REV', scanType: 'INWARD', qty: 6, binLocation: '5', status: 'REVERSED', syncStatus: 'synced', scanStatus: 'ACCEPTED' },
    { _id: 'b1', dealerCode: '99999', auditId: 'AUD1', partNumber: 'OTHER', scanType: 'INWARD', qty: 10, binLocation: '9', syncStatus: 'synced', scanStatus: 'ACCEPTED' }
  ];
  const seenFilters = [];
  try {
    Inventory.find = (filter) => {
      seenFilters.push(filter);
      return { select() { return this; }, sort() { return this; }, async lean() {
        return rows.filter((row) => row.dealerCode === filter.dealerCode && row.auditId === filter.auditId);
      } };
    };
    Bin.find = (filter) => {
      assert.equal(filter.dealerCode, '11646');
      return { sort() { return this; }, async lean() { return [{ binCode: '1' }, { binCode: '2' }, { binCode: '3' }, { binCode: '4' }, { binCode: '5' }, { binCode: '6' }]; } };
    };
    const bins = responseStub();
    await routeHandler('/bins')({ query: { dealerCode: '11646', auditId: 'AUD1' } }, bins);
    assert.deepEqual(bins.payload.bins.map((bin) => bin.binCode), ['1', '6']);
    assert.deepEqual(bins.payload.allBins.map((bin) => bin.binCode), ['1', '6']);
    assert.equal(seenFilters[0].dealerCode, '11646');
    assert.equal(seenFilters[0].auditId, 'AUD1');

    const parts = responseStub();
    await routeHandler('/parts')({ query: { dealerCode: '11646', auditId: 'AUD1', sourceBins: ['1', '2', '6'] } }, parts);
    assert.deepEqual(parts.payload.parts.map((part) => [part.partNumber, part.currentBin, part.availableQty]), [['ABC123', '1', 8], ['ABC123', '6', 3]]);

    const search = responseStub();
    await routeHandler('/parts')({ query: { dealerCode: '11646', auditId: 'AUD1', sourceBins: ['1', '2', '6'], partNumber: 'ABC' } }, search);
    assert.deepEqual(search.payload.parts.map((part) => [part.partNumber, part.currentBin]), [['ABC123', '1'], ['ABC123', '6']]);
  } finally {
    Inventory.find = inventoryFind;
    Bin.find = binFind;
  }
});
