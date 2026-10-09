const test = require('node:test');
const assert = require('node:assert/strict');
const Inventory = require('../models/Inventory');
const Bin = require('../models/Bin');
const BinTransferHistory = require('../models/BinTransferHistory');
const { prisma } = require('../services/prisma');
const router = require('../routes/binTransfer');

function routeHandler(path) {
  const route = router.stack.find((layer) => layer.route?.path === path)?.route;
  assert.ok(route, `route ${path} exists`);
  return route.stack.at(-1).handle;
}

function responseStub() {
  return { payload: null, statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; } };
}

function query(rows) {
  return { select() { return this; }, sort() { return this; }, async lean() { return rows; } };
}

async function withInventoryFixtures(run) {
  const saved = {
    inventoryFind: Inventory.find,
    inventoryUpdateOne: Inventory.updateOne,
    inventoryCreate: Inventory.create,
    binFind: Bin.find,
    historyFindOne: BinTransferHistory.findOne,
    historyCreate: BinTransferHistory.create,
    transaction: prisma.$transaction
  };
  let scans = [
    { _id: 'in-abc', dealerCode: '11646', auditId: 'AUD1', partNumber: 'ABC123', normalizedPartNumber: 'ABC123', partDescription: 'Part ABC', scanType: 'INWARD', qty: 8, quantity: 8, binLocation: '1', syncStatus: 'synced', scanStatus: 'ACCEPTED', status: 'ACCEPTED', dlc: 12, isDeleted: false, deletedAt: null },
    { _id: 'in-def', dealerCode: '11646', auditId: 'AUD1', partNumber: 'DEF456', normalizedPartNumber: 'DEF456', partDescription: 'Part DEF', scanType: 'INWARD', qty: 4, quantity: 4, binLocation: '1', syncStatus: 'synced', scanStatus: 'ACCEPTED', status: 'ACCEPTED', dlc: 5, isDeleted: false, deletedAt: null }
  ];
  const history = [];
  try {
    Inventory.find = (filter = {}) => query(scans.filter((scan) =>
      (!filter.dealerCode || scan.dealerCode === filter.dealerCode)
      && (!filter.auditId || scan.auditId === filter.auditId)));
    Inventory.updateOne = async (filter, update) => {
      const scan = scans.find((row) => row._id === filter._id && row.dealerCode === filter.dealerCode && row.auditId === filter.auditId);
      if (!scan) return { modifiedCount: 0 };
      Object.assign(scan, update.$set || {});
      return { modifiedCount: 1 };
    };
    Inventory.create = async (data) => {
      const scan = { ...data, _id: `moved-${scans.length}` };
      scans.push(scan);
      return scan;
    };
    Bin.find = (filter) => {
      assert.equal(filter.dealerCode, '11646');
      return { sort() { return this; }, async lean() { return [{ binCode: '1' }, { binCode: '2' }, { binCode: '3' }]; } };
    };
    BinTransferHistory.findOne = (filter) => ({ async lean() {
      return history.find((item) => item.dealerCode === filter.dealerCode && item.auditId === filter.auditId && item.transferRequestId === filter.transferRequestId) || null;
    } });
    BinTransferHistory.create = async (data) => {
      const item = { ...data, _id: `history-${history.length}` };
      history.push(item);
      return item;
    };
    prisma.$transaction = async (work) => {
      const scanSnapshot = structuredClone(scans);
      const historySnapshot = structuredClone(history);
      try { return await work({}); }
      catch (error) { scans = scanSnapshot; history.splice(0, history.length, ...historySnapshot); throw error; }
    };
    await run({ get scans() { return scans; }, history });
  } finally {
    Inventory.find = saved.inventoryFind;
    Inventory.updateOne = saved.inventoryUpdateOne;
    Inventory.create = saved.inventoryCreate;
    Bin.find = saved.binFind;
    BinTransferHistory.findOne = saved.historyFindOne;
    BinTransferHistory.create = saved.historyCreate;
    prisma.$transaction = saved.transaction;
  }
}

test('a failed item rolls back the whole selected transfer batch', async () => {
  await withInventoryFixtures(async (fixture) => {
    const req = { body: {
      dealerCode: '11646', auditId: 'AUD1', sourceBin: '1', transferRequestId: 'request-atomic-1',
      selectedParts: [
        { partNumber: 'ABC123', qty: 2, sourceBin: '1', destinationBin: '2' },
        { partNumber: 'DEF456', qty: 99, sourceBin: '1', destinationBin: '3' }
      ]
    }, io: { emit() {} }, user: { role: 'admin', username: 'fixture' } };
    const response = responseStub();
    await routeHandler('/transfer')(req, response);
    assert.equal(response.statusCode, 400);
    assert.equal(fixture.scans.length, 2);
    assert.deepEqual(fixture.scans.map((scan) => [scan.partNumber, scan.binLocation, scan.qty]), [['ABC123', '1', 8], ['DEF456', '1', 4]]);
    assert.equal(fixture.history.length, 0);
  });
});

test('a successful transfer preserves stock quantity and value and rejects a replayed request key', async () => {
  await withInventoryFixtures(async (fixture) => {
    const req = { body: {
      dealerCode: '11646', auditId: 'AUD1', sourceBin: '1', transferRequestId: 'request-once-1',
      selectedParts: [{ partNumber: 'ABC123', qty: 3, sourceBin: '1', destinationBin: '2' }]
    }, io: { emit() {} }, user: { role: 'admin', username: 'fixture' } };
    const beforeQty = fixture.scans.reduce((sum, scan) => sum + Number(scan.qty || 0), 0);
    const beforeValue = fixture.scans.reduce((sum, scan) => sum + Number(scan.qty || 0) * Number(scan.dlc || 0), 0);
    const first = responseStub();
    await routeHandler('/transfer')(req, first);
    assert.equal(first.statusCode, 200);
    assert.equal(fixture.history.length, 1);
    assert.equal(fixture.history[0].transferRequestId, 'request-once-1');
    assert.equal(fixture.scans.reduce((sum, scan) => sum + Number(scan.qty || 0), 0), beforeQty);
    assert.equal(fixture.scans.reduce((sum, scan) => sum + Number(scan.qty || 0) * Number(scan.dlc || 0), 0), beforeValue);
    assert.equal(fixture.scans.find((scan) => scan.binLocation === '2').qty, 3);
    const replay = responseStub();
    await routeHandler('/transfer')(req, replay);
    assert.equal(replay.statusCode, 409);
    assert.equal(fixture.history.length, 1);
  });
});

test('destination bins are validated against the selected dealer before mutation', async () => {
  await withInventoryFixtures(async (fixture) => {
    const before = fixture.scans.map((scan) => [scan._id, scan.binLocation, scan.qty]);
    const response = responseStub();
    await routeHandler('/transfer')({ body: {
      dealerCode: '11646', auditId: 'AUD1', sourceBin: '1', transferRequestId: 'request-bad-destination',
      selectedParts: [{ partNumber: 'ABC123', qty: 1, sourceBin: '1', destinationBin: 'OTHER-DEALER-BIN' }]
    }, io: { emit() {} }, user: { role: 'admin', username: 'fixture' } }, response);
    assert.equal(response.statusCode, 400);
    assert.match(response.payload.message, /Destination bin .* is not available for dealer 11646/);
    assert.deepEqual(fixture.scans.map((scan) => [scan._id, scan.binLocation, scan.qty]), before);
    assert.equal(fixture.history.length, 0);
  });
});
