const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');
const ExcelJS = require('exceljs');

test('complete audit route produces a readable multi-sheet workbook with scoped fixture data', async () => {
  const calls = [];
  let handler;
  const selectedDealer = { dealerCode: '11688', dealerName: 'Fixture Dealer' };
  const selectedAudit = { auditId: 'AUD-FIXTURE', auditStartDate: '2026-10-04' };
  const scan = { partNumber: 'PART1', qty: 2, scanType: 'INWARD', dealerCode: '11688', auditId: 'AUD-FIXTURE', syncStatus: 'synced', masterFound: true, dlc: 10, binLocation: 'BIN1' };
  const columns = [{ header: 'Part Number', key: 'partNumber', width: 18 }, { header: 'Quantity', key: 'qty', width: 12 }];
  const partwise = { rows: [{ partNumber: 'PART1', qty: 2, physicalQty: 2, physicalValueOnDlc: 20 }], columns, selectedDealer, selectedAudit };
  const record = query => { calls.push(query); };
  const reportModule = {
    get() {}, post(route, ...handlers) { if (route === '/download-complete-audit-pack') handler = handlers.at(-1); },
    buildReportData: async query => {
      record(query); return { scans: [scan], summary: [{}], selectedDealer, selectedAudit, finalRows: [], rawLogRows: [{ partNumber: 'PART1', rawScan: 'UPI1/PART1', qty: 2 }] };
    },
    buildPartwiseInventoryAuditReport: async query => { record(query); return partwise; },
    buildStockSummaryReport: async query => { record(query); return { columns, rows: [{ partNumber: 'PART1', qty: 2 }], sections: { grandTotal: { physicalValue: 20 } } }; },
    buildCategoryWiseVarianceSummary: async query => { record(query); return { rows: [], grandTotal: { sumPhysicalValueOnDLC: 20 } }; },
    validateValuationReports: async query => { record(query); return { passed: true }; }
  };
  const emptyModel = { find: () => {
    const query = { sort: () => query, select: () => query, limit: () => query, lean: async () => [] };
    return query;
  } };
  const filename = path.resolve('routes/reports.js');
  const localRequire = createRequire(filename);
  const context = {
    module: { exports: {} }, __dirname: path.dirname(filename), Buffer, process, console,
    require: name => {
      if (name === './report') return reportModule;
      if (name === './reconciliation') return { buildMovementAnalysisReport: async query => {
        record(query); return { rows: [], summary: {}, sections: {} };
      } };
      if (name.startsWith('../models/')) return emptyModel;
      if (name === '../utils/reportCache') return {
        applyCacheHeaders() {}, getCachedResponse: async (_namespace, _query, builder) => ({ data: await builder() })
      };
      return localRequire(name);
    }
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const headers = {};
  let body;
  const response = {
    setHeader: (key, value) => { headers[key] = value; }, send: value => { body = value; },
    status: status => { assert.fail(`Complete audit fixture returned HTTP ${status}`); }
  };
  await handler({ body: { dealerCode: '11688', auditId: 'AUD-FIXTURE', reports: ['stock-summary', 'raw-upi'] }, user: { username: 'fixture-user' } }, response);
  assert.ok(Buffer.isBuffer(body));
  assert.equal(headers['Content-Type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(headers['Content-Disposition'], /AUDIT_PACK_11688_FIXTURE_DEALER.*\.xlsx/);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(body);
  assert.ok(workbook.worksheets.length >= 6);
  assert.ok(workbook.getWorksheet('Audit Summary'));
  const contents = workbook.worksheets.map(sheet => JSON.stringify(sheet.getSheetValues())).join('\n');
  assert.match(contents, /PART1/);
  assert.match(contents, /UPI1\/PART1/);
  assert.ok(calls.length > 0);
  for (const query of calls) {
    assert.equal(query.dealerCode, '11688');
    assert.equal(query.auditId, 'AUD-FIXTURE');
  }
});
