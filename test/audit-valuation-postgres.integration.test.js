const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const databaseUrl = process.env.AUDIT_VALUATION_TEST_DATABASE_URL;
const fixtureFile = process.env.AUDIT_VALUATION_TEST_EXPECTATIONS_FILE;

// Customer data stays in an untracked local fixture, never in repository source.
test('uploaded quantities and valuation exceptions agree across PostgreSQL reports, dashboard and workbook', { skip: !databaseUrl || !fixtureFile }, async t => {
  const database = new URL(databaseUrl);
  assert.equal(database.hostname, '127.0.0.1');
  assert.equal(database.port, '55448');
  assert.equal(database.pathname, '/audit_valuation_test');
  const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
  const query = fixture.scope;
  const expected = fixture.expected;
  process.env.DATABASE_URL = databaseUrl;
  const connection = require('../services/prisma');
  await connection.connectDatabase();
  try {
    const report = require('../routes/report');
    const reconciliation = require('../routes/reconciliation');
    const [raw, partwise, stock, category, reconciled] = await Promise.all([
      report.buildReportData(query), report.buildPartwiseInventoryAuditReport(query),
      report.buildStockSummaryReport(query), report.buildCategoryWiseVarianceSummary(query),
      reconciliation.buildReconciliationReport(query)
    ]);
    const fields = ['dmsParts', 'totalSystemQty', 'totalPhysicalQty', 'totalShortQty', 'totalExcessQty',
      'totalVarianceQty', 'totalDmsDlcValueKnownSubtotal', 'totalDmsMrpValueKnownSubtotal',
      'totalPhysicalDlcValue', 'totalPhysicalMrpValue', 'priceMissingParts', 'dmsPriceMissingQty',
      'totalDmsDlcValue', 'valuationComplete'];
    for (const data of [raw, partwise, stock, category, reconciled]) {
      for (const field of fields) assert.equal(data.valuationSummary[field], expected[field], field);
      assert.equal(data.valuationSummary.totalExcessQty - data.valuationSummary.totalShortQty, expected.totalVarianceQty);
    }
    assert.equal(stock.summary.dmsStockValueDLC, expected.totalDmsDlcValue);
    assert.match(stock.summary.status, /INCOMPLETE/);
    assert.equal(category.grandTotal.sumDmsValueOnDLC, expected.totalDmsDlcValue);
    assert.equal(category.grandTotal.sumPhysicalValueOnDLC, expected.totalPhysicalDlcValue);
    const unscannedPart = await report.buildReportData({ ...query, partNumber: fixture.unscannedPart.partNumber });
    assert.equal(unscannedPart.finalRows.length, 1);
    assert.equal(unscannedPart.finalRows[0].partNumber, fixture.unscannedPart.partNumber);
    assert.equal(unscannedPart.valuationSummary.totalSystemQty, fixture.unscannedPart.dmsQuantity);
    assert.equal(unscannedPart.valuationSummary.totalPhysicalQty, 0);

    const Express = require('express');
    const jwt = require('jsonwebtoken');
    const User = require('../models/User');
    const Mapping = require('../models/UserDealerMapping');
    const userFind = User.findOne;
    const mappingFind = Mapping.find;
    t.after(() => { User.findOne = userFind; Mapping.find = mappingFind; });
    User.findOne = () => ({ lean: async () => ({ _id: 'validator', username: 'validator', role: 'admin', dealerAccess: [query.dealerCode], approved: true, isActive: true }) });
    Mapping.find = () => ({ select() { return this; }, lean: async () => [{ dealerId: query.dealerCode }] });
    const app = Express();
    app.use('/api/scans', require('../routes/inventory'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/scans/dashboard?${new URLSearchParams({ ...query, range: 'audit' })}`, {
      headers: { Authorization: `Bearer ${jwt.sign({ id: 'validator' }, process.env.JWT_SECRET || 'daksh_inventory_secret')}` }
    });
    assert.equal(response.status, 200);
    const dashboard = await response.json();
    assert.equal(dashboard.stats.valuationSummary.totalSystemQty, expected.totalSystemQty);
    assert.equal(dashboard.stats.valuationSummary.totalPhysicalQty, expected.totalPhysicalQty);
    assert.equal(dashboard.stats.systemStockValue, expected.totalDmsDlcValue);
    assert.equal(dashboard.stats.dealerStockMissingPriceLines, expected.priceMissingParts);
    assert.equal(dashboard.stats.actualStockValueDLC, expected.totalPhysicalDlcValue);
    assert.equal(dashboard.reconciliation.passed, false);
    assert.equal(dashboard.reconciliation.calculationTotalsMatch, true);

    const packRoute = require('../routes/reports').stack.find(layer => layer.route?.path === '/download-complete-audit-pack');
    let bytes;
    await packRoute.route.stack.at(-1).handle({ body: { ...query, reports: ['stock-summary', 'partwise-inventory-audit', 'reconciliation-report', 'dealer-reconciliation-report'] }, user: { username: 'local-validator' } }, {
      setHeader() {}, send(buffer) { bytes = buffer; }, status(code) { assert.fail(`Audit export returned ${code}`); }
    });
    const workbook = new (require('exceljs').Workbook)();
    await workbook.xlsx.load(bytes);
    const summaryText = JSON.stringify(workbook.getWorksheet('Audit Summary').getSheetValues());
    assert.ok(summaryText.includes(String(expected.totalSystemQty)));
    assert.ok(summaryText.includes(String(expected.totalPhysicalQty)));
    assert.match(summaryText, /PRICE MISSING/);
    assert.doesNotMatch(summaryText, /No variance found/);
    const exceptionText = JSON.stringify(workbook.getWorksheet('Price Exceptions').getSheetValues());
    for (const part of fixture.exceptionSamples) assert.ok(exceptionText.includes(part));
    const downloadRoute = reconciliation.stack.find(layer => layer.route?.path === '/export/excel');
    let reconciliationBytes;
    await downloadRoute.route.stack.at(-1).handle({ query, params: {} }, {
      setHeader() {}, send(buffer) { reconciliationBytes = buffer; }, status(code) { assert.fail(`Reconciliation export returned ${code}`); }
    });
    const reconciliationWorkbook = new (require('exceljs').Workbook)();
    await reconciliationWorkbook.xlsx.load(reconciliationBytes);
    assert.ok(reconciliationWorkbook.getWorksheet('Price Exceptions'));
    const metrics = reconciliationWorkbook.getWorksheet('Final Summary').getSheetValues();
    assert.equal(metrics.find(row => row?.[1] === 'DMS Stock Value (DLC)')[2], 'PRICE MISSING');
  } finally { await connection.disconnectDatabase(); }
});
