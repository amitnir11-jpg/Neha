const testDatabaseUrl = process.env.BIN_TRANSFER_TEST_DATABASE_URL || '';
if (testDatabaseUrl) {
  const parsed = new URL(testDatabaseUrl);
  if (parsed.hostname !== '127.0.0.1' || parsed.port !== '55439' || parsed.pathname !== '/daksh_bin_transfer_isolated_test') {
    throw new Error('BIN_TRANSFER_TEST_DATABASE_URL must point to the dedicated local test database on 127.0.0.1:55439.');
  }
  process.env.DATABASE_URL = testDatabaseUrl;
}

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const Inventory = require('../models/Inventory');
const Bin = require('../models/Bin');
const BinTransferHistory = require('../models/BinTransferHistory');
const { connectDatabase, disconnectDatabase } = require('../services/prisma');
const router = require('../routes/binTransfer');
const { calculateInventoryLedger } = require('../services/InventoryCalculationService');

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

async function transfer({ dealerCode, partNumber, qty, destinationBin, transferRequestId }) {
  const response = responseStub();
  await routeHandler('/transfer')({ body: {
    dealerCode,
    auditId: 'BT-ISOLATED-AUDIT',
    sourceBin: '1',
    transferRequestId,
    selectedParts: [{ partNumber, qty, sourceBin: '1', destinationBin }]
  }, user: { role: 'admin', username: 'isolated-test' }, io: { emit() {} } }, response);
  return response;
}

test('PostgreSQL serializable transfers prevent overspend, preserve quantity/value, and reject request replays', {
  skip: !testDatabaseUrl && 'Set BIN_TRANSFER_TEST_DATABASE_URL to run against the dedicated isolated PostgreSQL test database.'
}, async () => {
  const dealerCode = `BT${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  const auditId = 'BT-ISOLATED-AUDIT';
  try {
    await connectDatabase();
    await Promise.all(['1', '2', '3'].map((binCode) => Bin.create({ dealerCode, binCode, active: true })));
    await Inventory.create([
      { dealerCode, auditId, uniqueScanId: `${dealerCode}-ABC`, normalizedPartNumber: 'ABC123', partNumber: 'ABC123', partDescription: 'Part ABC', scanType: 'INWARD', type: 'INWARD', qty: 5, quantity: 5, binLocation: '1', bin: '1', syncStatus: 'synced', scanStatus: 'ACCEPTED', status: 'ACCEPTED', masterFound: true, currentCatalogueDLC: 10, isDeleted: false, deletedAt: null, isDuplicate: false },
      { dealerCode, auditId, uniqueScanId: `${dealerCode}-XYZ`, normalizedPartNumber: 'XYZ9', partNumber: 'XYZ9', partDescription: 'Part XYZ', scanType: 'INWARD', type: 'INWARD', qty: 6, quantity: 6, binLocation: '1', bin: '1', syncStatus: 'synced', scanStatus: 'ACCEPTED', status: 'ACCEPTED', masterFound: true, currentCatalogueDLC: 4, isDeleted: false, deletedAt: null, isDuplicate: false }
    ]);

    const initialParts = responseStub();
    await routeHandler('/parts')({ query: { dealerCode, auditId, sourceBin: '1' } }, initialParts);
    assert.equal(initialParts.payload.count, 2, JSON.stringify(await Inventory.find({ dealerCode, auditId }).lean()));

    const overspend = await Promise.all([
      transfer({ dealerCode, partNumber: 'ABC123', qty: 4, destinationBin: '2', transferRequestId: `${dealerCode}-overspend-a` }),
      transfer({ dealerCode, partNumber: 'ABC123', qty: 4, destinationBin: '3', transferRequestId: `${dealerCode}-overspend-b` })
    ]);
    assert.equal(overspend.filter((response) => response.statusCode === 200).length, 1, JSON.stringify(overspend.map((response) => response.payload)));
    assert.equal(overspend.filter((response) => response.statusCode !== 200).length, 1, JSON.stringify(overspend.map((response) => response.payload)));

    const duplicateRequestId = `${dealerCode}-replay`;
    const replays = await Promise.all([
      transfer({ dealerCode, partNumber: 'XYZ9', qty: 2, destinationBin: '2', transferRequestId: duplicateRequestId }),
      transfer({ dealerCode, partNumber: 'XYZ9', qty: 2, destinationBin: '2', transferRequestId: duplicateRequestId })
    ]);
    assert.equal(replays.filter((response) => response.statusCode === 200).length, 1);
    assert.equal(replays.filter((response) => response.statusCode === 409).length, 1);

    const records = await Inventory.find({ dealerCode, auditId }).lean();
    const stock = calculateInventoryLedger(records, { scope: { dealerCode, auditId } });
    assert.equal(stock.binBreakdown.reduce((sum, row) => sum + row.availableQty, 0), 11);
    assert.equal(stock.binBreakdown.reduce((sum, row) => sum + row.stockValue, 0), 74);
    assert.equal(stock.binBreakdown.filter((row) => row.partNumber === 'ABC123').reduce((sum, row) => sum + row.availableQty, 0), 5);
    assert.equal(stock.binBreakdown.filter((row) => row.partNumber === 'XYZ9').reduce((sum, row) => sum + row.availableQty, 0), 6);
    const currentBins = responseStub();
    await routeHandler('/bins')({ query: { dealerCode, auditId } }, currentBins);
    const partsAfterTransfer = responseStub();
    await routeHandler('/parts')({ query: { dealerCode, auditId, sourceBin: 'ALL' } }, partsAfterTransfer);
    assert.deepEqual(currentBins.payload.bins.map((bin) => bin.binCode), ['1', '2', '3'].filter((bin) => stock.binBreakdown.some((row) => row.binLocation === bin)), JSON.stringify(stock.binBreakdown.map(({ partNumber, binLocation, availableQty, dlc, stockValue }) => ({ partNumber, binLocation, availableQty, dlc, stockValue }))));
    assert.deepEqual(
      partsAfterTransfer.payload.parts.map((part) => [part.partNumber, part.currentBin, part.availableQty]).sort(),
      stock.binBreakdown.filter((row) => row.availableQty > 0).map((row) => [row.partNumber, row.binLocation, row.availableQty]).sort()
    );
    const histories = await BinTransferHistory.find({ dealerCode, auditId }).lean();
    assert.equal(histories.length, 2);
  } finally {
    if (testDatabaseUrl) {
      await Promise.all([
        Inventory.deleteMany({ dealerCode }),
        BinTransferHistory.deleteMany({ dealerCode }),
        Bin.deleteMany({ dealerCode })
      ]).catch(() => null);
      await disconnectDatabase();
    }
  }
});
