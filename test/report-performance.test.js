const assert = require('node:assert/strict');
const { test } = require('node:test');
const reports = require('../routes/report');
const Inventory = require('../models/Inventory');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function cachedReportHarness() {
  const fixture = { rows: [{
    partNum: 'PART1', productCategory: 'Parts', systemQty: 4,
    physicalQty: 2, totalDealerStockQty: 2, dlc: 10,
    physicalValueOnDlc: 20, systemValueOnDlc: 40, varianceOnDlc: -20,
    scanTypeAction: 'INWARD'
  }], summary: {}, selectedDealer: null, selectedAudit: null };
  const scans = [{ partNumber: 'PART1', qty: 2, scanType: 'INWARD', dealerCode: 'D01', auditId: 'AUD1', masterFound: true }];
  const rawData = { scans, rawLogRows: [{ partNumber: 'PART1', rawScan: 'UPI1/PART1', qty: 2 }], summary: [{}] };
  const cacheModule = require('../utils/reportCache');
  const reportFile = path.resolve('routes/report.js');
  const localRequire = createRequire(reportFile);
  const metadata = { namespace: 'stock-summary', cacheStatus: 'Fresh generated', scope: { dealerCode: 'D01' } };
  const context = { module: { exports: {} }, __dirname: path.dirname(reportFile), Buffer, process, console,
    require: name => name === '../utils/reportCache' ? {
      ...cacheModule,
      getCachedReport: async (namespace, query, builder) => {
        if (namespace === 'partwise-inventory-audit') return { data: fixture };
        if (namespace === 'report-data') return { data: rawData };
        return { data: await builder(query, metadata) };
      }
    } : localRequire(name) };
  vm.runInNewContext(fs.readFileSync(reportFile, 'utf8'), context, { filename: reportFile });
  return { reports: context.module.exports, fixture, rawData };
}

test('cached stock and category builders do not treat cache metadata as report rows', async () => {
  const { reports } = cachedReportHarness();
  const query = { dealerCode: 'D01', auditId: 'AUD1' };
  const stock = await reports.buildStockSummaryReport(query);
  assert.equal(stock.detailRows.length, 1);
  const category = await reports.buildCategoryWiseVarianceSummary(query);
  assert.equal(category.grandTotal.sumPhysicalValueOnDLC, 20);
  const reconciliation = await reports.validateValuationReports(query);
  assert.equal(reconciliation.totals.partwise, 20);
});

test('Raw UPI report loads rows and exports Excel through cached reconciliation', async () => {
  const harness = cachedReportHarness();
  const reportFile = path.resolve('routes/reports.js');
  const localRequire = createRequire(reportFile);
  const context = { module: { exports: {} }, __dirname: path.dirname(reportFile), Buffer, process, console,
    require: name => name === './report' ? harness.reports : localRequire(name) };
  vm.runInNewContext(fs.readFileSync(reportFile, 'utf8'), context, { filename: reportFile });
  let body;
  const headers = {};
  const response = { json: value => { body = value; }, send: value => { body = value; },
    setHeader: (key, value) => { headers[key] = value; },
    status: code => { assert.fail(`Raw UPI returned HTTP ${code}`); } };
  const req = { query: { dealerCode: 'D01', auditId: 'AUD1' }, path: '/raw-upi' };
  await context.module.exports.handleReport(req, response, 'raw-upi', 'Raw UPI Report');
  assert.equal(body.success, true);
  assert.equal(body.rows[0].partNumber, 'PART1');
  assert.equal(body.rows[0].rawScan, 'UPI1/PART1');
  assert.equal(body.pagination.totalRows, 1);
  req.query.format = 'excel';
  await context.module.exports.handleReport(req, response, 'raw-upi', 'Raw UPI Report');
  assert.equal(headers['Content-Type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.ok(Buffer.isBuffer(body));
  const workbook = new (require('exceljs').Workbook)();
  await workbook.xlsx.load(body);
  assert.equal(workbook.worksheets[0].getRow(4).getCell(2).value, 'UPI1/PART1');
});

test('full-master reconciliation reuses supplied inventory even on refresh', async () => {
  const original = Inventory.find;
  Inventory.find = () => { throw new Error('Inventory must not be loaded again'); };
  try {
    const result = await reports.validateValuationReports({
      dealerCode: 'D01', auditId: 'AUD-1', showFullMasterWithZeroScan: 'on', refresh: 'true'
    }, { partwise: { rows: [], summary: {}, selectedDealer: null, selectedAudit: null } });
    assert.equal(result.passed, true);
    assert.equal(result.totals.partwise, 0);
  } finally {
    Inventory.find = original;
  }
});
