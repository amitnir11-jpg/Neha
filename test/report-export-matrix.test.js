const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');
const ExcelJS = require('exceljs');

function reportHarness() {
  const scan = { _id: 'SCAN1', partNumber: 'PART1', qty: 2, scanType: 'INWARD', masterFound: true, dealerCode: '11688', auditId: 'AUD1', syncStatus: 'synced', dlc: 10, mrp: 20, binLocation: 'BIN1' };
  const row = { partNumber: 'PART1', partNum: 'PART1', qty: 2, physicalQty: 2, physicalBinQty: 2, totalDealerStockQty: 2, systemQty: 4, productCategory: 'Parts', dlc: 10, mrp: 20, physicalValueOnDlc: 20, systemValueOnDlc: 40, varianceOnDlc: -20, status: 'short', damageQty: 1, scanTypeAction: 'INWARD' };
  const selectedDealer = { dealerCode: '11688', dealerName: 'Fixture Dealer' };
  const selectedAudit = { auditId: 'AUD1' };
  const fixture = { rows: [row], columns: [{ header: 'Part Number', key: 'partNumber' }, { header: 'Quantity', key: 'qty' }], summary: { dealerName: 'Fixture Dealer', dealerCode: '11688', auditId: 'AUD1' }, selectedDealer, selectedAudit, validationLog: {} };
  const raw = { scans: [scan], summary: [{}], rawLogRows: [{ partNumber: 'PART1', rawScan: 'UPI1/PART1', qty: 2 }], finalRows: [row], selectedDealer, selectedAudit };
  const model = rows => ({ findOne: () => ({ lean: async () => rows[0] || null }), find: () => {
    const query = { sort: () => query, select: () => query, limit: () => query, lean: async () => rows };
    return query;
  } });
  const movement = { rows: [row], summary: fixture.summary, sections: {} };
  const load = (relative, overrides = {}) => {
    const filename = path.resolve(relative);
    const localRequire = createRequire(filename);
    const context = { module: { exports: {} }, __dirname: path.dirname(filename), Buffer, process, console,
      require: name => {
        if (Object.hasOwn(overrides, name)) return overrides[name];
        if (name.startsWith('../models/')) return model(name === '../models/Inventory' ? [scan] : []);
        if (name === '../utils/reportCache') return {
          ...localRequire(name),
          getCachedResponse: async (namespace, query, builder, options) => {
            assert.equal(query.dealerCode, '11688', 'download cache must include the selected dealer');
            assert.equal(query.auditId, 'AUD1', 'download cache must include the selected audit');
            return localRequire(name).getCachedResponse(namespace, query, builder, options);
          },
          getCachedReport: async (namespace, query, builder) => namespace === 'partwise-inventory-audit'
            ? { data: fixture } : namespace === 'report-data' ? { data: raw } : { data: await builder(query) }
        };
        if (name === './reconciliation') return { buildMovementAnalysisReport: async () => movement };
        return localRequire(name);
      }
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    return context.module.exports;
  };
  const localParts = load('routes/localParts.js', {
    './auth': { ...require('../routes/auth'), validateUserDealerAccess: async () => ({ allowed: true, requestedDealer: '11688' }) },
    '../services/LocalPartService': { LocalPartError: class extends Error {}, createLocalPartService: () => ({
      list: async () => ({ entries: [{ ...row, quantity: 2, dealerCode: '11688' }], totalRows: 1, summary: { totalRows: 1, grandTotalQuantity: 2, grandTotalMrpValue: 40, grandTotalDlcValue: 20 }, pagination: {} })
    }) }
  });
  const reports = load('routes/report.js');
  load('routes/reports.js', { './report': reports, './localParts': localParts });
  return reports;
}

const reports = reportHarness();
const types = [
  'bin-wise-stock', 'user-dealer-wise', 'raw-upi', 'scan-register', 'invalid-scan-report',
  'wrong-not-found-master', 'multiple-bin-location-alert', 'stock-summary', 'short', 'excess',
  'movement_wise_stock_analysis', 'damage', 'category-wise-variance-summary',
  'partwise-inventory-audit', 'parts-inventory-refresh-template', 'local-parts'
];
const noPdf = new Set(['stock-summary', 'parts-inventory-refresh-template']);
for (const type of types) {
  for (const format of ['', 'excel', ...(noPdf.has(type) ? [] : ['pdf'])]) {
    test(`${type} supports ${format || 'preview'}`, async () => {
      const route = reports.stack.find(layer => layer.route?.path === `/${type}` && layer.route.methods.get)?.route;
      assert.ok(route, `missing ${type} route`);
      const headers = {};
      let body;
      let status = 200;
      const response = {
        setHeader: (key, value) => { headers[key] = value; },
        send: value => { body = value; }, json: value => { body = value; },
        status: value => { status = value; return response; }
      };
      await route.stack.at(-1).handle({ path: `/${type}`, query: { dealerCode: '11688', auditId: 'AUD1', ...(format ? { format } : {}) }, user: { role: 'admin', username: 'fixture' } }, response);
      assert.equal(status, 200, body?.message);
      if (!format) {
        assert.equal(body.success, true);
        assert.ok(Array.isArray(body.rows));
      } else {
        assert.ok(Buffer.isBuffer(body), `${type} returned JSON instead of ${format}`);
        assert.match(headers['Content-Disposition'], /attachment/);
        if (format === 'excel') {
          assert.match(headers['Content-Type'], /spreadsheetml/);
          const workbook = new ExcelJS.Workbook();
          await workbook.xlsx.load(body);
          assert.ok(workbook.worksheets.length > 0);
        } else {
          assert.equal(headers['Content-Type'], 'application/pdf');
          assert.equal(body.subarray(0, 5).toString(), '%PDF-');
        }
      }
    });
  }
}

test('product group summary downloads a readable Excel workbook', async () => {
  const source = fs.readFileSync('routes/inventory.js', 'utf8');
  const start = source.indexOf("router.get('/dashboard/product-group-summary/export'");
  let handler;
  const context = {
    Buffer, ExcelJS, auth: { requireAuth() {} },
    router: { get: (_path, _auth, callback) => { handler = callback; } },
    activeDashboardScope: async () => ({ filter: { dealerCode: '11688', auditId: 'AUD1' } }),
    require: () => ({ validateValuationReports: async () => ({ passed: true }) }),
    dashboardProductGroupSummary: async () => [{ productGroup: 'PARTS', partSubGroup: 'GENERAL', totalQuantity: 2, totalDlcValue: 20 }]
  };
  vm.runInNewContext(source.slice(start, source.indexOf("router.get('/dashboard/product-group-summary',", start)), context);
  let body;
  await handler({ query: {} }, { setHeader() {}, send: value => { body = value; }, status: value => assert.fail(`HTTP ${value}`) });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(body);
  assert.equal(workbook.getWorksheet('Product Group Summary').getCell('A2').value, 'PARTS');
});
