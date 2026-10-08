const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const { calculatePartStock } = require('../services/StockCalculationService');
const { stockQuantitySummary, stockMovementQuantity, stockAvailableQuantity } = require('../utils/stockQuantity');
const { summarizeMovementBucket } = require('../utils/inventoryValueEngine');
const { reportTotals, applyMovementCountRules } = require('../utils/reportTotals');
const { movementQty } = require('../utils/inventoryMovementState');
function row(id, scanType, binLocation, extra = {}) {
  return { _id: id, scanId: id, uniqueScanId: id, partNumber: 'ABC123', dealerCode: 'D01', auditId: 'AUD1',
    scanType, binLocation, qty: 1, quantity: 1, scanStatus: 'ACCEPTED', syncStatus: 'synced', masterFound: true, ...extra };
}
function verifyEveryView(rows, expected) {
  const part = calculatePartStock(rows, 'ABC123');
  const central = stockQuantitySummary(rows);
  const dashboard = summarizeMovementBucket(rows);
  const reports = reportTotals(applyMovementCountRules(rows));
  const reconciliation = rows.reduce((sum, scan) => sum + stockAvailableQuantity(scan), 0);
  for (const key of ['inwardQty', 'outwardQty', 'fittedQty', 'damageQty', 'availableQty']) {
    assert.equal(part[key], expected[key], `part ${key}`);
    assert.equal(central[key], expected[key], `central ${key}`);
  }
  assert.equal(dashboard.totalDealerStockQty, expected.availableQty);
  assert.equal(reports.totalDealerStockQty, expected.availableQty);
  assert.equal(reconciliation, expected.availableQty);
  assert.equal(part.binBreakdown.reduce((sum, bin) => sum + bin.availableQty, 0), expected.availableQty);
  assert.equal(rows.reduce((sum, scan) => sum + movementQty(scan), 0), part.storeQty);
  return part;
}
test('golden sequence: four inward, B1 outward, A1 fitted, B1 damage matches all stock consumers', () => {
  const rows = [row('in1', 'INWARD', 'A1', { upiNo: 'UPI001' }), row('in2', 'INWARD', 'A1', { upiNo: 'UPI002' }),
    row('in3', 'INWARD', 'B1', { upiNo: 'UPI003' }), row('in4', 'INWARD', 'B1', { upiNo: 'UPI004' })];
  verifyEveryView(rows, { inwardQty: 4, outwardQty: 0, fittedQty: 0, damageQty: 0, availableQty: 4 });
  rows.push(row('out5', 'OUTWARD', 'B1', { upiNo: 'UPI003' }));
  verifyEveryView(rows, { inwardQty: 4, outwardQty: 1, fittedQty: 0, damageQty: 0, availableQty: 3 });
  rows.push(row('fit6', 'FITTED', 'A1', { upiNo: 'UPI002', fittedQty: 1, status: 'FITTED_PENDING' }));
  let part = verifyEveryView(rows, { inwardQty: 4, outwardQty: 1, fittedQty: 1, damageQty: 0, availableQty: 3 });
  assert.equal(part.binBreakdown.find(bin => bin.binLocation === 'A1').storeQty, 1);
  assert.equal(part.binBreakdown.find(bin => bin.binLocation === 'A1').availableQty, 2);
  rows.push(row('damage7', 'DAMAGE', 'B1', { upiNo: 'UPI004' }));
  part = verifyEveryView(rows, { inwardQty: 4, outwardQty: 1, fittedQty: 1, damageQty: 1, availableQty: 2 });
  assert.equal(part.binBreakdown.find(bin => bin.binLocation === 'B1').availableQty, 0);
  assert.equal(part.storeQty, 1);
});
test('billing removes workshop unit once; returned unit restores stock through existing return transaction', () => {
  const rows = [row('in1', 'INWARD', 'A1'), row('fit2', 'FITTED', 'A1', { fittedQty: 1, status: 'FITTED_PENDING' })];
  assert.equal(calculatePartStock(rows, 'ABC123').availableQty, 1);
  rows[1].status = 'BILLED';
  assert.equal(calculatePartStock(rows, 'ABC123').availableQty, 0);
  rows[1].status = 'RETURNED_TO_BIN';
  rows.push(row('return3', 'FITTED_RETURN', 'B1'));
  assert.equal(calculatePartStock(rows, 'ABC123').availableQty, 1);
  assert.equal(stockMovementQuantity(rows[1]), -1);
});
test('deleted, duplicate, rejected, verification, and local rows do not enter stock balance', () => {
  const rows = [row('in1', 'INWARD', 'A1'), row('deleted2', 'INWARD', 'A1', { isDeleted: true }),
    row('dup3', 'INWARD', 'A1', { isDuplicate: true }), row('reject4', 'INWARD', 'A1', { scanStatus: 'REJECTED' }),
    row('verify5', 'VERIFICATION', 'A1'), row('local6', 'INWARD', 'A1', { isLocalPart: true })];
  assert.equal(calculatePartStock(rows, 'ABC123').availableQty, 1);
});
function extract(file, start, end) {
  const source = fs.readFileSync(file, 'utf8');
  const index = source.indexOf(start);
  return source.slice(index, source.indexOf(end, index));
}
function workspaceHarness() {
  const nodes = new Map();
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, { textContent: '', disabled: false, setAttribute() {}, classList: {
      flags: new Set(), toggle(name, enabled) { if (enabled) this.flags.add(name); else this.flags.delete(name); }
    } });
    return nodes.get(selector);
  }
  const buttons = [{ disabled: false }, { disabled: false }];
  const form = { elements: Object.fromEntries(['type', 'binLocation', 'part', 'rawScan', 'dealerCode', 'regdNo', 'jobCardNo'].map(name => [name, { value: '', disabled: false }])) };
  form.elements.dealerCode.value = 'D01';
  const state = {};
  const context = vm.createContext({ state, $: node, $$: () => buttons, cleanDealerCode: value => String(value).trim().toUpperCase(), setText() {} });
  vm.runInContext(extract('public/ui.js', 'function updateBarcodeWorkspace(', 'function acceptBarcodeBinQr('), context);
  return { context, form, state, node, buttons };
}
test('INWARD locks barcode, manual part and saves until the selected dealer bin validates', () => {
  const h = workspaceHarness();
  h.form.elements.type.value = 'INWARD';
  h.context.updateBarcodeWorkspace(h.form);
  assert.equal(h.form.elements.rawScan.disabled, true);
  assert.equal(h.form.elements.part.disabled, true);
  assert.ok(h.buttons.every(button => button.disabled));
  h.form.elements.binLocation.value = 'A1';
  h.context.updateBarcodeWorkspace(h.form);
  assert.equal(h.form.elements.rawScan.disabled, true);
  h.state.validatedBarcodeBin = 'D01|A1';
  h.context.updateBarcodeWorkspace(h.form);
  assert.equal(h.form.elements.rawScan.disabled, false);
  assert.equal(h.form.elements.part.disabled, false);
  assert.ok(h.buttons.every(button => !button.disabled));
  h.form.elements.dealerCode.value = 'D02';
  h.context.updateBarcodeWorkspace(h.form);
  assert.equal(h.form.elements.rawScan.disabled, true);
});
for (const type of ['OUTWARD', 'FITTED']) {
  test(`${type} hides and disables QR source bin and enables barcode immediately`, () => {
    const h = workspaceHarness();
    h.form.elements.type.value = type;
    h.context.updateBarcodeWorkspace(h.form);
    assert.equal(h.form.elements.binLocation.disabled, true);
    assert.equal(h.form.elements.binLocation.required, false);
    assert.equal(h.form.elements.rawScan.disabled, false);
    assert.ok(h.node('#barcodeBinLabel').classList.flags.has('hidden'));
    assert.ok(h.node('#barcodeBinStep').classList.flags.has('hidden'));
    assert.equal(h.node('#barcodeScanStep b').textContent, '2');
  });
}

function transactionHarness({ failInsert = false } = {}) {
  const { matchesFilter } = require('../models/prismaModel');
  const { upiCodeValue, movementTypeValue } = require('../utils/inventoryMovementState');
  const { normalizePartNumber } = require('../utils/normalize');
  const fittedStock = require('../utils/fittedStock');
  const rows = [row('in1', 'INWARD', 'B1', { upiNo: 'UPI003', upiStatus: 'AVAILABLE', currentLocationType: 'BIN', currentBin: 'B1', timestamp: new Date('2026-01-01') })];
  let gate = Promise.resolve();
  const withDatabaseTransaction = async work => {
    const previous = gate;
    let release;
    gate = new Promise(resolve => { release = resolve; });
    await previous;
    const snapshot = structuredClone(rows);
    try { return await work(); }
    catch (error) { rows.splice(0, rows.length, ...snapshot); throw error; }
    finally { release(); }
  };
  const Inventory = {
    find: filter => ({ lean: async () => rows.filter(scan => matchesFilter(scan, filter)) }),
    findOneAndUpdate: (filter, update) => ({ lean: async () => {
      const found = rows.find(scan => matchesFilter(scan, filter));
      if (found) Object.assign(found, update.$set);
      return found || null;
    } }),
    create: async scan => {
      if (failInsert) throw new Error('Simulated failed movement insert');
      const created = { _id: `created${rows.length}`, ...scan };
      rows.push(created);
      return created;
    }
  };
  const source = fs.readFileSync('routes/sync.js', 'utf8');
  const start = source.indexOf('    doc = await withDatabaseTransaction(async () => {');
  const end = source.indexOf("    markPerf('transactionSave');", start);
  function save(scanType, scanId) {
    const scan = { dealerCode: 'D01', auditId: 'AUD1', partNumber: 'ABC123', normalizedPartNumber: 'ABC123',
      binLocation: 'B1', upiNo: 'UPI003', upiId: 'UPI003', quantity: 1, scanType, uniqueScanId: scanId, source: {},
      globalUpiKey: scanId, rawScanString: 'UPI:UPI003', scanSource: 'barcode' };
    const context = vm.createContext({ Inventory, scan, options: {}, withDatabaseTransaction, console,
      upiCodeValue, movementTypeValue, normalizePartNumber, fittedStock,
      clean: value => String(value || '').trim(), upper: value => String(value || '').trim().toUpperCase(),
      isManualEntry: () => false, lockUpiIdentity: async () => {},
      duplicatePolicy: { activeUpiDuplicateFilter: () => null },
      inventory: { availableInwardStock: async () => ({ bins: [{ binLocation: 'B1', availableQty: rows.reduce((sum, scan) => sum + stockMovementQuantity(scan), 0) }] }) },
      UPI_LOCATION_REQUIRED_MESSAGE: 'Location unavailable', OUTWARD_SCANNED_STOCK_REQUIRED_MESSAGE: 'Not available',
      UPI_ALREADY_OUTWARD_MESSAGE: 'Already outward', UPI_ALREADY_FITTED_MESSAGE: 'Already fitted',
      finalBin: 'B1', finalQty: 1, finalDlc: 10, finalSavedTime: new Date(), mobileTime: null,
      master: { partName: 'Part' }, dealer: null, role: 'admin', valueFields: {}, storedUpiToken: 'UPI003', warnings: [],
      resolveCategoryFromMaster: () => 'Parts', req: { user: { id: 'user' } }, scanUserName: () => 'User', smartBinAuditFields: () => ({}), normalizeSource: () => 'barcode', mobileTimestamp: () => ''
    });
    vm.runInContext(extract('routes/sync.js', 'async function resolveUpiCurrentLocation(', 'function scanIdentityScope('), context);
    return vm.runInContext(`(async () => { let doc; ${source.slice(start, end)} return doc; })()`, context);
  }
  return { rows, save };
}
for (const type of ['OUTWARD', 'FITTED']) {
  test(`concurrent ${type} callbacks claim one UPI once using a transactional model stub`, async () => {
    const h = transactionHarness();
    const results = await Promise.allSettled([h.save(type, 'SCAN1'), h.save(type, 'SCAN2')]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(h.rows.filter(scan => scan.scanType === type).length, 1);
    assert.equal(h.rows[0].upiStatus, type);
    assert.equal(stockQuantitySummary(h.rows).availableQty, type === 'FITTED' ? 1 : 0);
  });
}
test('failed movement insertion rolls back source UPI claim in the transaction callback', async () => {
  const h = transactionHarness({ failInsert: true });
  await assert.rejects(h.save('OUTWARD', 'SCAN1'), /failed movement insert/);
  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].upiStatus, 'AVAILABLE');
  assert.equal(stockQuantitySummary(h.rows).availableQty, 1);
});

test('bin-wise report uses central store and workshop balances for the golden sequence', () => {
  const { fittedWorkshopQuantity } = require('../utils/fittedStock');
  const context = vm.createContext({ stockQuantitySummary, fittedWorkshopQuantity,
    money: value => Math.round(value * 100) / 100,
    canonicalizePartCategory: value => value,
    scanDlc: () => 10, scanValueRow: () => ({ valuationMRP: 20 }), scanQuantity: stockMovementQuantity
  });
  vm.runInContext(extract('routes/reports.js', 'function groupRows(', 'const AUDIT_COLUMNS'), context);
  vm.runInContext(extract('routes/reports.js', 'function selectRows(', 'function packText('), context);
  const scans = [row('in1', 'INWARD', 'A1'), row('in2', 'INWARD', 'A1'), row('in3', 'INWARD', 'B1'), row('in4', 'INWARD', 'B1'),
    row('out5', 'OUTWARD', 'B1'), row('fit6', 'FITTED', 'A1', { fittedQty: 1, status: 'FITTED_PENDING' }), row('damage7', 'DAMAGE', 'B1')];
  const reports = context.selectRows({ scans }, 'bin-wise-stock');
  assert.equal(reports.reduce((sum, bin) => sum + bin.qty, 0), 2);
  const a1 = reports.find(bin => bin.bin === 'A1');
  assert.equal(a1.qty, 2);
  assert.equal(a1.physicalBinQty, 1);
  assert.equal(a1.fittedWorkshopQty, 1);
  scans[5].status = 'BILLED';
  assert.equal(context.selectRows({ scans }, 'bin-wise-stock').reduce((sum, bin) => sum + bin.qty, 0), 1);
});

test('successful process response includes central part summary and complete bin breakdown', async () => {
  const rows = [row('in1', 'INWARD', 'A1', { qty: 4, quantity: 4 }), row('out2', 'OUTWARD', 'A1'),
    row('fit3', 'FITTED', 'A1', { fittedQty: 1, status: 'FITTED_PENDING' }), row('damage4', 'DAMAGE', 'A1')];
  const context = vm.createContext({ module: { exports: {} }, process, performance, console,
    require: name => {
      if (name === '../routes/sync') return { normalizeScan: input => input, saveNormalizedScan: async scan => ({ status: 'synced', scan }) };
      if (name === '../routes/inventory') return { publicScan: scan => scan };
      if (name === './StockCalculationService') return { loadPartStock: async () => calculatePartStock(rows, 'ABC123') };
      throw new Error(`Unexpected dependency ${name}`);
    }
  });
  vm.runInContext(fs.readFileSync('services/ScanProcessingService.js', 'utf8'), context);
  const result = await context.module.exports.processScan(rows.at(-1));
  assert.equal(result.success, true);
  assert.equal(result.partSummary.inwardQty, 4);
  assert.equal(result.partSummary.fittedQty, 1);
  assert.equal(result.partSummary.availableQty, 2);
  assert.equal(result.partSummary.binBreakdown[0].storeQty, 1);
});

test('legacy quantity parsing is preserved when historical rows have no explicit qty fields', () => {
  const scan = row('legacy1', 'INWARD', 'A1', { qty: undefined, quantity: undefined, rawScan: 'X/UPI001/X/ABC123/4/100' });
  assert.equal(calculatePartStock([scan], 'ABC123').availableQty, 4);
  assert.equal(summarizeMovementBucket([scan]).totalDealerStockQty, 4);
});
