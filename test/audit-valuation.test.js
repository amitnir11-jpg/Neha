const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { summarizeAuditValuation, priceValue } = require('../utils/auditValuation');
const { calculateStockValuation } = require('../utils/stockValuation');
const { savedAuditPrice, getPricesFromPartMaster, mergePriceRecordCandidates } = require('../utils/partMasterPrice');
const { matchesFilter } = require('../models/prismaModel');

test('DMS-only shortages, physical-only excesses and missing prices retain every quantity', () => {
  const summary = summarizeAuditValuation([
    { partNumber: 'UNSCANNED', systemQty: 5, totalDealerStockQty: 0, dlc: 10, mrp: 20 },
    { partNumber: 'EXTRA', systemQty: 0, totalDealerStockQty: 7, dlc: 3, mrp: 4 },
    { partNumber: 'MISSING', systemQty: 2, totalDealerStockQty: 0, dlc: null, mrp: 8 }
  ]);
  assert.equal(summary.totalSystemQty, 7);
  assert.equal(summary.totalPhysicalQty, 7);
  assert.equal(summary.totalShortQty, 7);
  assert.equal(summary.totalExcessQty, 7);
  assert.equal(summary.totalVarianceQty, 0);
  assert.equal(summary.totalDmsDlcValue, null);
  assert.equal(summary.totalDmsDlcValueKnownSubtotal, 50);
  assert.equal(summary.totalDmsMrpValue, 116);
  assert.equal(summary.totalPhysicalDlcValue, 21);
  assert.equal(summary.priceExceptions[0].dmsQuantity, 2);
  assert.equal(summary.priceExceptions[0].dlc, null);
  assert.equal(summary.valuationComplete, false);
  const source = fs.readFileSync('routes/reports.js', 'utf8');
  const start = source.indexOf('function reconciliationStatusText(');
  const end = source.indexOf('function buildReconciliationCategoryRows(', start);
  const context = vm.createContext({});
  vm.runInContext(source.slice(start, end), context);
  assert.equal(context.reconciliationStatusText(summary), 'Incomplete');
  assert.doesNotMatch(context.reconciliationRemarksText(summary), /No variance found/);
});

test('financial multiplication and differences use exact decimals and independent DLC/MRP', () => {
  assert.equal(priceValue(1, 1.005), 1.01);
  assert.equal(priceValue(100, 0.29), 29);
  const value = calculateStockValuation({ actualQuantity: 0.1, dmsQuantity: 0.2, dlc: 0.1, mrp: 1.015 });
  assert.equal(value.actualStockValue, 0.01);
  assert.equal(value.dmsStockValue, 0.02);
  assert.equal(value.varianceStockValue, -0.01);
  const missing = summarizeAuditValuation([{ systemQty: 5, actualStock: 0, mrp: 100, dlc: 0 }]);
  assert.equal(missing.totalDmsDlcValue, null, 'MRP never substitutes for missing DLC');
  assert.equal(missing.totalDmsMrpValue, 500);
  const fractional = summarizeAuditValuation([{ systemQty: 0.3, actualStock: 0.4, dlc: 1.015, mrp: 1.015 }]);
  assert.equal(fractional.totalExcessValue, 0.11);
  assert.equal(fractional.totalVarianceDlcValue, 0.11);
  assert.equal(fractional.totalVarianceDlcValue, fractional.totalExcessValue - fractional.totalShortValue);
});

test('empty stock sources remain incomplete rather than certifying no variance', () => {
  const summary = summarizeAuditValuation([], { stockUploadPresent: false });
  assert.equal(summary.reconciliationComplete, false);
  assert.match(summary.finalStatus, /STOCK UPLOAD REQUIRED/);
});

test('saved audit prices survive newer master prices without a record update', () => {
  const stock = { partNumber: 'PART1', mrp: 100, dlp: 75, uploadedAt: '2026-09-27' };
  const original = { ...stock };
  const price = savedAuditPrice(stock, { partNumber: 'PART1', mrp: 120, dlc: 90 });
  assert.equal(price.mrp, 100);
  assert.equal(price.dlc, 75);
  assert.equal(price.mrpResolution, 'SAVED_AUDIT_PRICE');
  assert.equal(price.dlcResolution, 'SAVED_AUDIT_PRICE');
  assert.deepEqual(stock, original);
  const fallback = savedAuditPrice({ partNumber: 'PART1', mrp: 0, dlp: 0, uploadedAt: '2020-01-01' },
    { partNumber: 'PART1', mrp: 120, dlc: 90, uploadedAt: '2026-09-28' });
  assert.equal(fallback.priceSnapshot, false);
  assert.equal(fallback.mrpPriceDate, '2026-09-28');
  assert.equal(fallback.dlcPriceDate, '2026-09-28');
  assert.equal(fallback.valuationDate, null, 'a current master fallback must not be silently presented as a historical audit price');
});

test('full master batch lookup normalizes legacy identifiers without crossing dealer scope', async t => {
  const MasterCatalogue = require('../models/MasterCatalogue');
  const MasterPart = require('../models/MasterPart');
  const originalCatalogue = MasterCatalogue.find;
  const originalMaster = MasterPart.find;
  t.after(() => { MasterCatalogue.find = originalCatalogue; MasterPart.find = originalMaster; });
  const fixtures = [
    { partNumber: ' 00-LEGACY PART001 ', dealerCode: '', mrp: 100, dlc: 75, source: 'MASTER_CATALOGUE' },
    { partNumber: '00LEGACYPART001', dealerCode: 'OTHER', mrp: 999, dlc: 999 }
  ];
  const query = rows => ({ sort() { return this; }, lean: async () => rows });
  MasterCatalogue.find = filter => query(fixtures.filter(row => matchesFilter(row, filter)));
  MasterPart.find = () => query([]);
  const prices = await getPricesFromPartMaster(['00LEGACYPART001'], 'SYNTHETIC-DEALER');
  assert.equal(prices.get('00LEGACYPART001').dlc, 75);
  assert.equal(prices.get('00LEGACYPART001').mrp, 100);
});

test('MRP and DLC retain the date of the independent master record supplying each rate', () => {
  const master = mergePriceRecordCandidates([
    { source: 'MASTER_CATALOGUE', record: { partNumber: 'PART1', mrp: 120, dlc: 0, uploadedAt: '2026-09-28' } },
    { source: 'MASTER_CATALOGUE', record: { partNumber: 'PART1', mrp: 100, dlc: 90, uploadedAt: '2026-09-01' } }
  ]);
  const price = savedAuditPrice({ partNumber: 'PART1', mrp: 0, dlp: 0 }, master);
  assert.equal(price.mrp, 120);
  assert.equal(price.dlc, 90);
  assert.equal(price.mrpPriceDate, '2026-09-28');
  assert.equal(price.dlcPriceDate, '2026-09-01');
});

test('customer reconciliation summary and category views keep unresolved financial values explicit', () => {
  const source = fs.readFileSync('routes/reports.js', 'utf8');
  const context = vm.createContext({ summarizeAuditValuation,
    packMetricRows: (_section, items) => items.map(([label, value]) => ({ label, value })) });
  const currencyStart = source.indexOf('function packCurrency(');
  vm.runInContext(source.slice(currencyStart, source.indexOf('function packPercentage(', currencyStart)), context);
  const start = source.indexOf('function reconciliationStatusText(');
  vm.runInContext(source.slice(start, source.indexOf('async function buildCompleteAuditPackWorkbook(', start)), context);
  const rows = [{ partNumber: 'UNPRICED', dmsStock: 5, actualStock: 0, dlc: null, mrp: null, productCategory: 'Parts' }];
  const valuationSummary = summarizeAuditValuation(rows);
  const report = { rows, valuationSummary, summary: { valuationSummary, totalPartsUploaded: 1 } };
  const categories = context.buildReconciliationCategoryRows(report);
  assert.equal(categories[0].dmsQty, 5);
  assert.equal(categories[0].dmsValue, null);
  assert.equal(categories[0].status, 'Incomplete');
  const summaryRows = context.buildReconciliationSummaryRows(report);
  assert.equal(summaryRows.find(row => row.label === 'DMS Stock Value (DLC)').value, 'PRICE MISSING');
  assert.equal(summaryRows.find(row => row.label === 'Total Parts Uploaded').value, 1);
  assert.doesNotMatch(summaryRows.find(row => row.label === 'Remarks').value, /No variance found/);
});
