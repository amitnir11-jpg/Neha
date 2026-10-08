const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const { matchesFilter } = require('../models/prismaModel');
const { uniqueReportScans } = require('../utils/reportScanIdentity');
const { applyMovementCountRules, reportTotals } = require('../utils/reportTotals');
const { movementTypeValue, upiCodeValue } = require('../utils/inventoryMovementState');
const fittedStock = require('../utils/fittedStock');
const masterValidation = require('../utils/masterValidation');
const { normalizePartNumber } = require('../utils/normalize');
const clean = value => String(value ?? '').trim();
const upper = value => clean(value).toUpperCase();
function extract(file, start, end) {
  const source = fs.readFileSync(file, 'utf8');
  const index = source.indexOf(start);
  assert.ok(index >= 0);
  return source.slice(index, source.indexOf(end, index));
}
function stockRow(id, type, qty, extras = {}) {
  return { _id: id, uniqueScanId: id, dealerCode: 'D01', auditId: 'AUD1', partNumber: 'PART123', binLocation: 'A1', scanType: type, qty, quantity: qty, syncStatus: 'synced', scanStatus: type === 'OUTWARD' ? 'OUTWARD_DONE' : 'ACCEPTED', masterFound: true, timestamp: new Date(1700000000000 + Number(id.replace(/\D/g, '') || 0) * 1000), ...extras };
}
function locationHarness(rows) {
  const context = vm.createContext({ clean, upper, normalizePartNumber, upiCodeValue, movementTypeValue, fittedStock, isManualEntry: scan => scan.scanSource === 'manual',
    Inventory: { find: filter => ({ lean: async () => rows.filter(row => matchesFilter(row, filter)) }) },
    OUTWARD_SCANNED_STOCK_REQUIRED_MESSAGE: 'Part/UPI is not available in current inventory. OUTWARD cannot be processed.',
    UPI_ALREADY_OUTWARD_MESSAGE: 'This UPI is already OUTWARD or is no longer available in inventory.',
    UPI_LOCATION_REQUIRED_MESSAGE: 'Location missing', UPI_ALREADY_FITTED_MESSAGE: 'Already fitted'
  });
  vm.runInContext(extract('routes/sync.js', 'async function resolveUpiCurrentLocation(', 'function scanIdentityScope('), context);
  return context;
}
for (const bin of ['A1', 'B2']) {
  test(`UPI outward resolves exact bin ${bin} and forces manual quantity 10 to 1`, async () => {
    const context = locationHarness([
      stockRow('in1', 'INWARD', 1, { upiNo: 'UPI001', binLocation: 'A1' }),
      stockRow('in2', 'INWARD', 1, { upiNo: 'UPI002', binLocation: 'B2' })
    ]);
    const scan = { dealerCode: 'D01', auditId: 'AUD1', scanType: 'OUTWARD', partNumber: 'PART123', upiNo: bin === 'A1' ? 'UPI001' : 'UPI002', binLocation: 'WRONG', quantity: 10 };
    assert.equal(await context.prepareUpiSourceLocation(scan), null);
    assert.equal(scan.binLocation, bin);
    assert.equal(scan.quantity, 1);
    assert.equal(scan.qty, 1);
  });
}
test('already outward UPI is rejected and unknown/dealer/audit mismatch never resolves stock', async () => {
  const rows = [stockRow('in1', 'INWARD', 1, { upiNo: 'UPI001' }), stockRow('out2', 'OUTWARD', 1, { upiNo: 'UPI001' })];
  const context = locationHarness(rows);
  const scan = { dealerCode: 'D01', auditId: 'AUD1', scanType: 'OUTWARD', upiNo: 'UPI001' };
  assert.match(await context.prepareUpiSourceLocation(scan), /already OUTWARD/);
  for (const extras of [{ upiNo: 'UNKNOWN' }, { dealerCode: 'D02' }, { auditId: 'AUD2' }]) {
    assert.match(await context.prepareUpiSourceLocation({ ...scan, ...extras }), /not available/);
  }
  assert.equal(rows.length, 2);
});
function summaryHarness(rows) {
  let requested;
  const context = vm.createContext({ clean, upper, normalizePartNumber, masterValidation,
    nonVerificationScanClause: () => ({ $nor: [{ scanType: 'VERIFICATION' }, { type: 'VERIFICATION' }] }),
    acceptedStatuses: () => ['ACCEPTED', 'SUPERVISOR_APPROVED', 'OUTWARD_DONE'],
    buildListQuery: scope => Object.fromEntries(Object.entries(scope).filter(([, value]) => value)),
    applyScanVisibility: (req, filter) => filter,
    getActiveAudit: async filter => { assert.equal(filter.dealerCode, 'D01'); return { auditId: 'AUD1' }; },
    Inventory: { find: filter => { requested = filter; return { select: () => ({ lean: async () => rows.filter(row => matchesFilter(row, filter)) }) }; } },
    uniqueReportScans, applyMovementCountRules, reportTotals
  });
  vm.runInContext(extract('routes/inventory.js', 'function testScanClause(', 'function applyRecentScanMode('), context);
  vm.runInContext(extract('routes/inventory.js', 'async function scanInventorySummary(', "router.get('/part-summary'"), context);
  return { summary: query => context.scanInventorySummary(query), filter: () => requested };
}
test('full inventory summary reports 15 - 1 = 14 with separate row and part counts', async () => {
  const h = summaryHarness([stockRow('in1', 'INWARD', 15), stockRow('out2', 'OUTWARD', 1)]);
  const totals = await h.summary({ dealerCode: 'D01', auditId: 'AUD1' });
  assert.equal(totals.netAvailableQuantity, 14);
  assert.equal(totals.scanRows, 2);
  assert.equal(totals.uniqueParts, 1);
});
test('last-ten limit, part/bin/type/visibility search do not alter full dealer balance of 94', async () => {
  const rows = Array.from({ length: 15 }, (_, i) => stockRow(`in${i + 1}`, 'INWARD', i === 0 ? 81 : 1));
  rows.push(stockRow('out20', 'OUTWARD', 1));
  const h = summaryHarness(rows);
  const full = await h.summary({ dealerCode: 'D01', auditId: 'AUD1', limit: 10 });
  const searched = await h.summary({ dealerCode: 'D01', auditId: 'AUD1', part: 'OTHER', bin: 'B2', type: 'OUTWARD', limit: 10 });
  assert.equal(full.netAvailableQuantity, 94);
  assert.equal(full.scanRows, 16);
  assert.deepEqual(searched, full);
  assert.equal(h.filter().type, undefined);
});
test('summary resolves active audit, excludes deleted/rejected/other scope, preserves workshop and billing', async () => {
  const rows = [stockRow('in1', 'INWARD', 10), stockRow('out2', 'OUTWARD', 3),
    stockRow('in3', 'INWARD', 5, { partNumber: 'PART456' }), stockRow('damage4', 'DAMAGE', 1, { partNumber: 'PART456' }),
    stockRow('in5', 'INWARD', 100, { isDeleted: true }), stockRow('in6', 'INWARD', 100, { deletedAt: new Date() }),
    stockRow('in7', 'INWARD', 100, { dealerCode: 'D02' }), stockRow('in8', 'INWARD', 100, { auditId: 'OLD' }),
    stockRow('in9', 'INWARD', 100, { syncStatus: 'failed' }),
    stockRow('fitted10', 'FITTED', 1, { fittedQty: 1, status: 'FITTED_PENDING' })];
  const h = summaryHarness(rows);
  const pending = await h.summary({ dealerCode: 'D01' });
  assert.equal(pending.netAvailableQuantity, 11);
  assert.equal(pending.scanRows, 5);
  assert.equal(pending.uniqueParts, 2);
  rows.at(-1).status = 'BILLED';
  assert.equal((await h.summary({ dealerCode: 'D01' })).netAvailableQuantity, 10);
});
test('recent history includes OUTWARD and retains dealer/audit validity filter', () => {
  const context = vm.createContext({ clean, transactionFilter: query => ({ dealerCode: query.dealerCode, isDeleted: { $ne: true } }) });
  vm.runInContext(extract('routes/mobile.js', 'function recentScanFilter(', 'function latestUniqueScans('), context);
  const filter = context.recentScanFilter({ dealerCode: 'D01', auditId: 'AUD1' });
  assert.ok(matchesFilter(stockRow('out1', 'OUTWARD', 1), filter));
  assert.ok(!matchesFilter(stockRow('out1', 'OUTWARD', 1, { auditId: 'OLD' }), filter));
});
test('history loading preserves full server totals while rendering ten visible rows', async () => {
  const records = Array.from({ length: 10 }, (_, i) => stockRow(`in${i}`, 'INWARD', 1));
  const state = {};
  let rendered;
  const context = vm.createContext({ state, URLSearchParams,
    scanHistoryQueryParams: () => new URLSearchParams(),
    api: async () => ({ records, pagination: { totalPages: 2 }, summary: { scanRows: 16, netAvailableQuantity: 94, uniqueParts: 1, visibleRows: 10 } }),
    sortScanHistoryRecords: rows => rows, mergeScanHistoryRecords: rows => rows,
    scanHistoryQuantity: scan => scan.qty, scanHistoryPartNumber: scan => scan.partNumber,
    setText() {}, $: () => null, enhanceCoreTables() {},
    renderScanHistoryRecords: (rows, summary) => { rendered = { rows, summary }; }
  });
  vm.runInContext(extract('public/ui.js', 'function scanHistorySummary(', 'function updateScanHistorySummary('), context);
  vm.runInContext(extract('public/ui.js', 'async function loadScanHistory(', 'function canEditScanDetails('), context);
  await context.loadScanHistory();
  assert.equal(rendered.rows.length, 10);
  assert.equal(rendered.summary.partsScanned, 94);
  assert.equal(rendered.summary.scanRows, 16);
});

test('committed outward triggers history refresh without refreshing dashboard', async () => {
  const state = { recentRealtimeScanIds: new Set() };
  let refreshes = 0;
  let inserted;
  const timers = [];
  const context = vm.createContext({ state, console, activeAuditMatchesScan: () => true,
    prependScanHistory: scan => { inserted = scan; }, showScanPopup() {},
    loadScanHistory: async () => { refreshes += 1; }, refreshPartStockSummary: async () => {},
    setTimeout: (fn, delay) => { if (delay === 80) timers.push(fn); return 1; }, clearTimeout() {}
  });
  vm.runInContext(extract('public/ui.js', 'async function handleNewScan(', 'function setDashboardLoading('), context);
  const outward = stockRow('out1', 'OUTWARD', 1);
  await context.handleNewScan(outward);
  assert.equal(inserted, outward);
  assert.equal(timers.length, 1);
  await timers[0]();
  assert.equal(refreshes, 1);
});
test('mobile history orders a newly committed remote outward ahead of twenty old local scans', () => {
  const old = Array.from({ length: 20 }, (_, i) => stockRow(`in${i + 1}`, 'INWARD', 1));
  const outward = stockRow('out21', 'OUTWARD', 1);
  const context = vm.createContext({ state: { liveRecentRows: [outward] }, clean,
    sessionRows: () => old, scanIdentityKey: row => row.uniqueScanId, recordKey: row => row._id });
  vm.runInContext(extract('public/scan.js', 'function mergeRecentRows(', 'async function copyTextValue('), context);
  const rows = context.mergeRecentRows();
  assert.equal(rows.length, 20);
  assert.equal(rows[0].scanType, 'OUTWARD');
});

test('mobile history retains separate movements for one UPI and merges copies of the same transaction', () => {
  const inward = stockRow('in1', 'INWARD', 1);
  const fitted = stockRow('fit2', 'FITTED', 1);
  const context = vm.createContext({ state: { liveRecentRows: [fitted, inward] }, clean,
    sessionRows: () => [{ ...fitted }], scanIdentityKey: () => 'UPI:SAME', recordKey: row => row._id });
  vm.runInContext(extract('public/scan.js', 'function mergeRecentRows(', 'async function copyTextValue('), context);
  const rows = context.mergeRecentRows();
  assert.equal(rows.length, 2);
  assert.deepEqual(Array.from(rows, row => row.scanType).sort(), ['FITTED', 'INWARD']);
});

test('mobile recent rows expose transaction IDs instead of relying on shared QR text', () => {
  const context = vm.createContext({ clean, decorateScanValue: row => row });
  vm.runInContext(extract('routes/mobile.js', 'function mobileItem(', "router.post('/connect'"), context);
  const inward = context.mobileItem({ _id: 'row-in', scanId: 'in1', uniqueScanId: 'in1', rawScan: 'SAME-QR', scanType: 'INWARD', auditId: 'AUD1', deviceId: 'WEB-TEST' });
  const fitted = context.mobileItem({ _id: 'row-fit', scanId: 'fit2', uniqueScanId: 'fit2', rawScan: 'SAME-QR', scanType: 'FITTED', auditId: 'AUD1' });
  assert.equal(inward.id, fitted.id);
  assert.notEqual(inward.uniqueScanId, fitted.uniqueScanId);
  assert.equal(inward.auditId, 'AUD1');
  assert.equal(inward.deviceId, 'WEB-TEST');
});

test('normalization uses quantity one for unique UPI and preserves aggregated manual quantity', () => {
  const { normalizeScan } = require('../routes/sync');
  for (const scanType of ['INWARD', 'OUTWARD', 'FITTED', 'DAMAGE']) {
    const scan = normalizeScan({ partNumber: 'PART123', upiNo: 'UPI001', quantity: 10, scanType });
    assert.equal(scan.quantity, 1);
  }
  const manual = normalizeScan({ partNumber: 'PART123', quantity: 10, scanType: 'INWARD', source: 'manual' });
  assert.equal(manual.quantity, 10);
});

test('plain UPI001 resolves the exact stored token even when parser derived identity is 001', async () => {
  const context = locationHarness([
    stockRow('in1', 'INWARD', 1, { upiNo: 'UPI001', binLocation: 'B2' }),
    stockRow('in2', 'INWARD', 1, { upiNo: '001', binLocation: 'A1' })
  ]);
  const scan = { dealerCode: 'D01', auditId: 'AUD1', scanType: 'OUTWARD', partNumber: 'UPI001', upiId: '001', rawScanString: 'UPI001', quantity: 10 };
  assert.equal(await context.prepareUpiSourceLocation(scan), null);
  assert.equal(scan.binLocation, 'B2');
  assert.equal(scan.upiId, 'UPI001');
  assert.equal(scan.partNumber, 'PART123');
  assert.equal(scan.quantity, 1);
});
test('FITTED resolves the unique source bin and rejects an already fitted UPI', async () => {
  const rows = [stockRow('in1', 'INWARD', 1, { upiNo: 'UPI002', binLocation: 'B2' })];
  const context = locationHarness(rows);
  const scan = { dealerCode: 'D01', auditId: 'AUD1', scanType: 'FITTED', upiNo: 'UPI002', quantity: 10 };
  assert.equal(await context.prepareUpiSourceLocation(scan), null);
  assert.equal(scan.binLocation, 'B2');
  assert.equal(scan.quantity, 1);
  rows.push(stockRow('fit2', 'FITTED', 1, { upiNo: 'UPI002', status: 'FITTED_PENDING' }));
  assert.equal(await context.prepareUpiSourceLocation(scan), 'Already fitted');
});
