const test = require('node:test');
const assert = require('node:assert/strict');
const Inventory = require('../models/Inventory');
const Bin = require('../models/Bin');
const ScanAuditLog = require('../models/ScanAuditLog');
const BinTransferHistory = require('../models/BinTransferHistory');
const { prisma } = require('../services/prisma');
const { softDeleteScans } = require('../services/ScanModificationService');
const { calculateInventoryLedger } = require('../services/InventoryCalculationService');
const binTransferRouter = require('../routes/binTransfer');

function routeHandler(path) {
  const route = binTransferRouter.stack.find((layer) => layer.route?.path === path)?.route;
  assert.ok(route, `route ${path} exists`);
  return route.stack.at(-1).handle;
}

function responseStub() {
  return { payload: null, statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; } };
}

test('sample scan appears in Bin Transfer and stock report, then disappears after committed deletion and refresh event', async () => {
  const saved = {
    inventoryFind: Inventory.find,
    inventoryFindByIdAndUpdate: Inventory.findByIdAndUpdate,
    binFind: Bin.find,
    transferFind: BinTransferHistory.find,
    auditCreate: ScanAuditLog.create,
    transaction: prisma.$transaction
  };
  const sample = { _id: 'sample-scan-1', dealerCode: '11646', auditId: 'AUD1', partNumber: 'ABC123',
    scanType: 'INWARD', qty: 1, quantity: 1, binLocation: 'A1', syncStatus: 'synced',
    scanStatus: 'ACCEPTED', status: 'ACCEPTED', isDeleted: false, deletedAt: null, isDuplicate: false };
  let committed = false;

  const matchesStockReport = (filter, row) => row.dealerCode === filter.dealerCode
    && row.auditId === filter.auditId
    && row.syncStatus === 'synced'
    && ['ACCEPTED', 'SUPERVISOR_APPROVED', 'OUTWARD_DONE'].includes(row.scanStatus)
    && row.isDeleted !== true && row.deletedAt == null && row.isDuplicate !== true;
  const visibleRows = (filter) => matchesStockReport(filter, sample) ? [{ ...sample }] : [];

  try {
    Inventory.find = (filter) => ({
      select() { return this; },
      sort() { return this; },
      async lean() { return visibleRows(filter); }
    });
    Inventory.findByIdAndUpdate = (id, update) => ({
      async lean() {
        assert.equal(id, sample._id);
        Object.assign(sample, update.$set || {});
        return { ...sample };
      }
    });
    Bin.find = () => ({ sort() { return this; }, async lean() { return [{ binCode: 'A1', active: true }]; } });
    BinTransferHistory.find = () => ({ async lean() { return []; } });
    ScanAuditLog.create = async (data) => ({ ...data, _id: 'audit-delete-1' });
    prisma.$transaction = async (work) => {
      const result = await work({});
      committed = true;
      return result;
    };

    const partsRequest = { query: { dealerCode: '11646', auditId: 'AUD1', sourceBin: 'A1' } };
    const beforeParts = responseStub();
    await routeHandler('/parts')(partsRequest, beforeParts);
    assert.deepEqual(beforeParts.payload.parts.map((part) => [part.partNumber, part.currentBin, part.availableQty]), [['ABC123', 'A1', 1]]);
    const beforeReport = calculateInventoryLedger(visibleRows({ dealerCode: '11646', auditId: 'AUD1', syncStatus: 'synced' }));
    assert.deepEqual(beforeReport.binBreakdown.map((part) => [part.partNumber, part.binLocation, part.availableQty]), [['ABC123', 'A1', 1]]);

    const emitted = [];
    const req = { user: { role: 'admin', username: 'tester', name: 'Test Admin' }, body: { reason: 'test cleanup' },
      io: { emit(event) {
        if (event === 'scan:deleted' || event === 'reports:update') assert.equal(committed, true, `${event} fires after commit`);
        emitted.push(event);
      } } };
    BinTransferHistory.find = () => ({ async lean() {
      return [{ transferId: 'BT-DEPENDENT', fromBin: 'A1', toBin: 'A2', transferredAt: new Date() }];
    } });
    await assert.rejects(softDeleteScans({ _id: sample._id, dealerCode: '11646', auditId: 'AUD1' }, req),
      (error) => error.status === 409 && /dependent stock activity/.test(error.message));
    assert.equal(sample.isDeleted, false, 'dependent stock must not be deleted');

    BinTransferHistory.find = () => ({ async lean() { return []; } });
    const deletion = await softDeleteScans({ _id: sample._id, dealerCode: '11646', auditId: 'AUD1' }, req);
    assert.equal(deletion.deletedCount, 1);

    const afterParts = responseStub();
    await routeHandler('/parts')(partsRequest, afterParts);
    assert.deepEqual(afterParts.payload.parts, []);
    const afterReport = calculateInventoryLedger(visibleRows({ dealerCode: '11646', auditId: 'AUD1', syncStatus: 'synced' }));
    assert.deepEqual(afterReport.binBreakdown, []);

    const afterBins = responseStub();
    await routeHandler('/bins')({ query: { dealerCode: '11646', auditId: 'AUD1' } }, afterBins);
    assert.deepEqual(afterBins.payload.bins, []);
    assert.ok(emitted.includes('scan:deleted'));
    assert.ok(emitted.includes('reports:update'));
  } finally {
    Inventory.find = saved.inventoryFind;
    Inventory.findByIdAndUpdate = saved.inventoryFindByIdAndUpdate;
    Bin.find = saved.binFind;
    BinTransferHistory.find = saved.transferFind;
    ScanAuditLog.create = saved.auditCreate;
    prisma.$transaction = saved.transaction;
  }
});
