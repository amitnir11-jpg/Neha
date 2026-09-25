const assert = require('node:assert/strict');
const {
  assertDlcReconciliation,
  calculateDealerStockSystemValue,
  calculateStockValuation,
  stockValuationTotals
} = require('../utils/stockValuation');

const first = calculateStockValuation({ actualQuantity: 10, dmsQuantity: 8, dlc: 75.5, mrp: 100 });
assert.deepEqual(first, {
  actualQuantity: 10,
  dmsQuantity: 8,
  varianceQuantity: 2,
  dlc: 75.5,
  mrp: 100,
  actualStockValue: 755,
  dmsStockValue: 604,
  varianceStockValue: 151,
  actualMrpValue: 1000,
  dmsMrpValue: 800,
  varianceMrpValue: 200
});

const second = calculateStockValuation({ actualQuantity: 3, dmsQuantity: 5, dlc: 20, mrp: 30 });
assert.deepEqual(stockValuationTotals([first, second]), {
  actualDlcTotal: 815,
  dmsDlcTotal: 704,
  varianceDlcTotal: 111,
  actualMrpTotal: 1090,
  dmsMrpTotal: 950,
  varianceMrpTotal: 140
});

assert.deepEqual(calculateDealerStockSystemValue({ dmsStock: 5, mrp: '₹1,250.00' }), {
  quantity: 5,
  mrp: 1250,
  stockValue: 6250,
  missingMrp: false
});

assert.deepEqual(calculateDealerStockSystemValue({ systemQty: '3', mrp: 0 }, { mrp: '200' }), {
  quantity: 3,
  mrp: 200,
  stockValue: 600,
  missingMrp: false
});

assert.deepEqual(calculateDealerStockSystemValue({ dmsStock: 2, mrp: '' }, { mrp: null }), {
  quantity: 2,
  mrp: 0,
  stockValue: 0,
  missingMrp: true
});

assert.equal(assertDlcReconciliation({ partwise: 815, stockSummary: 815, category: 815, dashboard: 815 }).passed, true);
assert.throws(
  () => assertDlcReconciliation({ partwise: 815, stockSummary: 816, category: 815, dashboard: 815 }),
  (error) => error.code === 'REPORT_RECONCILIATION_FAILED' && error.statusCode === 409
);

process.stdout.write('Stock valuation and reconciliation checks passed.\n');
