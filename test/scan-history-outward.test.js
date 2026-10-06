const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { movementTypeValue, movementQty, remainingQtyValue, upiCodeValue } = require('../utils/inventoryMovementState');
const { normalizeScan } = require('../routes/sync');

const clean = value => String(value ?? '').trim();
const upper = value => clean(value).toUpperCase();
function extract(file, start, end) {
  const source = fs.readFileSync(file, 'utf8');
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}

function harness() {
  const source = { _id: 'IN1', partNumber: 'PART123', dealerCode: '11646', auditId: 'AUD1', binLocation: 'A1', scanType: 'INWARD', qty: 10, quantity: 10, remainingQty: 10, activeInventory: true };
  const rows = [source];
  const locationContext = vm.createContext({
    upiCodeValue,
    OUTWARD_SCANNED_STOCK_REQUIRED_MESSAGE: 'Part not available in scanned inventory. Outward not allowed.'
  });
  vm.runInContext(extract('routes/sync.js', 'async function prepareUpiSourceLocation(', 'function scanIdentityScope('), locationContext);
  const serviceContext = vm.createContext({
    module: { exports: {} }, process, performance, console: { info() {}, error() {}, warn() {} },
    require: name => {
      if (name === '../routes/inventory') return { publicScan: scan => scan };
      assert.equal(name, '../routes/sync');
      return {
        normalizeScan,
        saveNormalizedScan: async (scan, req, options) => {
          const error = await locationContext.prepareUpiSourceLocation(scan, options);
          if (error) return { status: 'failed', scan, error };
          rows.push(scan);
          return { status: 'synced', scan };
        }
      };
    }
  });
  vm.runInContext(fs.readFileSync('services/ScanProcessingService.js', 'utf8'), serviceContext);
  let handler;
  const context = vm.createContext({
    clean, upper, normalizePartNumber: upper, normalizeDealerCode: upper, randomUUID,
    numberValue: (value, fallback = 0) => Number(value ?? fallback), movementTypeValue, remainingQtyValue,
    auth: { requireAuth() {}, requireAdmin() {} },
    router: { post: (path, ...handlers) => { handler = handlers.at(-1); } },
    Inventory: {
      findOne: () => ({ lean: async () => ({ ...source }) }),
      updateOne: async (filter, update) => { assert.equal(filter._id, source._id); Object.assign(source, update.$set); }
    },
    scanLookupFilter: id => ({ _id: id }),
    availableInwardStock: async () => ({ bins: [{ binLocation: 'A1', availableQty: rows.reduce((sum, row) => sum + movementQty(row), 0) }] }),
    withDatabaseTransaction: async work => work(), invalidateInventoryCaches() {}, publicScan: scan => scan,
    require: name => { assert.equal(name, '../services/ScanProcessingService'); return serviceContext.module.exports; }
  });
  vm.runInContext(extract('routes/inventory.js', 'function buildScanHistoryOutwardMovement(', 'async function verifyPartOnly('), context);
  vm.runInContext(extract('routes/inventory.js', "router.post('/:scanId/mark-outward'", "router.post('/:scanId/fitted-status'"), context);
  async function outward(quantity) {
    let status = 200;
    let body;
    await handler({ body: { quantity }, params: { scanId: source._id }, user: { id: 'ADMIN1', role: 'admin' } }, {
      status: value => { status = value; return { json: value => { body = value; } }; },
      json: value => { body = value; }
    });
    return { status, body };
  }
  return { source, rows, outward, processScan: serviceContext.module.exports.processScan };
}

test('Scan History outward saves a movement and updates 10 to 9, then 8', async () => {
  const h = harness();
  for (const remaining of [9, 8]) {
    const result = await h.outward(1);
    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.remainingQty, remaining);
    assert.equal(h.source.remainingQty, remaining);
    assert.equal(h.source.qty, 10, 'original inward quantity remains available for ledger calculations');
    assert.equal(h.rows.reduce((sum, row) => sum + movementQty(row), 0), remaining);
  }
  assert.equal(h.rows[1].scanType, 'OUTWARD');
  assert.equal(h.rows[1].source.sourceScanId, 'IN1');
  assert.equal(h.rows[1].binLocation, 'A1');
  assert.equal(h.rows[1].dealerCode, '11646');
  assert.equal(h.rows[1].auditId, 'AUD1');
});

test('outward rejects insufficient or invalid quantities without changing stock', async () => {
  const h = harness();
  for (const quantity of [11, 0, -1, 'bad']) {
    const result = await h.outward(quantity);
    assert.equal(result.body.success, false);
    assert.equal(h.rows.length, 1);
    assert.equal(h.source.remainingQty, 10);
  }
  assert.equal((await h.outward(10)).body.remainingQty, 0);
  assert.equal(h.source.activeInventory, false);
  assert.equal((await h.outward(1)).status, 409);
  assert.equal(h.rows.length, 2);
});

test('ordinary outward cannot bypass barcode validation using client fields', async () => {
  const h = harness();
  const result = await h.processScan({ scanType: 'OUTWARD', quantity: 1, partNumber: 'PART123', scanHistoryOutward: true, source: 'manual', scanMode: 'Scan History Outward' }, { req: { body: { scanHistoryOutward: true } } });
  assert.equal(result.success, false);
  assert.match(result.message, /Part not available in scanned inventory/);
  assert.equal(h.rows.length, 1);
});

test('history shows remaining inward quantity including zero while preserving outward quantity', () => {
  const context = vm.createContext({ scanQuantity: (scan, fallback) => scan.qty ?? scan.quantity ?? fallback });
  vm.runInContext(extract('public/ui.js', '  function scanHistoryDisplayQuantity(', '  function scanHistoryRow('), context);
  assert.equal(context.scanHistoryDisplayQuantity({ scanType: 'INWARD', qty: 10, remainingQty: 9 }), 9);
  assert.equal(context.scanHistoryDisplayQuantity({ scanType: 'INWARD', qty: 10, remainingQty: 0 }), 0);
  assert.equal(context.scanHistoryDisplayQuantity({ scanType: 'INWARD', qty: 10 }), 10);
  assert.equal(context.scanHistoryDisplayQuantity({ scanType: 'OUTWARD', qty: 1, remainingQty: 0 }), 1);
});
