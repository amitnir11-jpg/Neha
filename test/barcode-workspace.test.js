const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { matchesFilter } = require('../models/prismaModel');
const { normalizePartNumber } = require('../utils/normalize');

function extract(file, start, end) {
  const source = fs.readFileSync(file, 'utf8');
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return source.slice(a, b);
}
const upper = value => String(value || '').trim().toUpperCase();
const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function historyHarness() {
  const rows = Array.from({ length: 31 }, (_, index) => ({
    _id: String(index), partNumber: index % 2 ? '53155AAW000S' : '53155AAW000S-ALT',
    normalizedPartNumber: index % 2 ? '53155AAW000S' : '53155AAW000S-ALT',
    binLocation: index % 2 ? 'A1-B1' : 'C1', dealerCode: '11646', scanType: 'INWARD', qty: 1
  }));
  let handler;
  const reads = [];
  const context = vm.createContext({
    normalizePartNumber, upper, escapeRegex, clean: value => String(value || '').trim(),
    router: { get: (_path, _auth, callback) => { handler = callback; } }, auth: { requireAuth() {} },
    applyScanVisibility: (_req, filter) => filter, applyTestScanMode: filter => filter,
    getActiveAudit: async () => ({ auditId: 'AUD-FIXTURE' }),
    scanInventorySummary: async () => ({ netAvailableQuantity: rows.length, scanRows: rows.length, uniqueParts: 2 }),
    buildListQuery: query => ({ ...(query.dealerCode ? { dealerCode: query.dealerCode } : {}), ...(query.type ? { scanType: query.type } : {}) }),
    Inventory: {
      find: filter => {
        const read = { filter, skip: 0, limit: 100 }; reads.push(read);
        const query = { sort: () => query, skip: value => { read.skip = value; return query; }, limit: value => { read.limit = value; return query; }, lean: async () => rows.filter(row => matchesFilter(row, filter)).slice(read.skip, read.skip + read.limit) };
        return query;
      },
      countDocuments: async filter => rows.filter(row => matchesFilter(row, filter)).length,
      aggregate: async () => []
    },
    DuplicateScanLog: { countDocuments: async () => 0 },
    masterLookupForScans: async () => new Map(), publicScanWithMaster: row => row,
    uniqueReportScans: rows => rows, applyMovementCountRules: rows => rows, reportTotals: rows => ({ totalQuantity: rows.length })
  });
  vm.runInContext(extract('routes/inventory.js', 'function scanHistoryPartClause(', 'function applyScanVisibility('), context);
  vm.runInContext(extract('routes/inventory.js', "router.get('/history'", "router.get('/dashboard/product-group-summary/export'"), context);
  async function request(query) {
    let body, status = 200;
    await handler({ query }, { json: value => { body = value; }, status: code => { status = code; return { json: value => { body = value; } }; } });
    assert.equal(status, 200, body?.message);
    return body;
  }
  return { request, reads };
}

test('history honors 10-row server pagination without fetching full records', async () => {
  const h = historyHarness();
  const page = await h.request({ limit: '10', page: '2' });
  assert.equal(page.records.length, 10);
  assert.equal(page.records[0]._id, '10');
  assert.equal(page.pagination.totalPages, 4);
  assert.equal(h.reads[0].skip, 10);
  assert.equal(h.reads[0].limit, 10);
});

test('partial history searches match all variants even when an exact part also exists', async () => {
  const h = historyHarness();
  const partial = await h.request({ part: '53155aaw000s', partMatch: 'partial', limit: '10' });
  assert.equal(partial.pagination.totalRows, 31);
  assert.ok(partial.records.some(row => row.partNumber.endsWith('-ALT')));
  const exact = await h.request({ part: '53155AAW000S', limit: '10' });
  assert.equal(exact.pagination.totalRows, 15, 'existing exact-first callers retain their behavior');
});

test('part, bin, dealer and type filters remain independent and combine server-side', async () => {
  const h = historyHarness();
  const filtered = await h.request({ part: '53155', partMatch: 'partial', bin: 'a1-b', dealerCode: '11646', type: 'INWARD', limit: '10' });
  assert.equal(filtered.pagination.totalRows, 15);
  assert.ok(filtered.records.every(row => row.binLocation === 'A1-B1'));
  assert.equal((await h.request({ dealerCode: 'OTHER', limit: '10' })).pagination.totalRows, 0);
});

test('new live scans are inserted once and capped at 10 rows', () => {
  const context = vm.createContext({
    state: { scanHistoryRecords: Array.from({ length: 10 }, (_, i) => ({ scanId: `ROW${i}` })) },
    $: () => ({ querySelector: () => null }), activeAuditMatchesScan: () => true, scanMatchesScanHistoryFilters: () => true,
    scanHistoryRecordKey: scan => scan.scanId, sortScanHistoryRecords: rows => rows,
    mergeScanHistoryRecords: rows => rows, isBarcodeWorkspaceActive: () => true,
    scanHistorySummary: rows => ({ visibleRows: rows.length }), renderScanHistoryRecords() {}, enhanceCoreTables() {}
  });
  vm.runInContext(extract('public/ui.js', '  function prependScanHistory(', '  async function repairSyncStatus('), context);
  context.prependScanHistory({ scanId: 'NEW' });
  assert.equal(context.state.scanHistoryRecords.length, 10);
  assert.equal(context.state.scanHistoryRecords[0].scanId, 'NEW');
  context.prependScanHistory({ scanId: 'NEW', qty: 2 });
  assert.equal(context.state.scanHistoryRecords.length, 10);
  assert.equal(context.state.scanHistoryRecords[0].qty, 2);
});
