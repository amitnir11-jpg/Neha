const { firstNonZeroNumber, firstPositiveNumber } = require('./normalize');

function numberValue(value, fallback = 0) {
  const parsed = Number(String(value === undefined || value === null || value === '' ? fallback : value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function money(value) {
  return Math.round(numberValue(value, 0) * 100) / 100;
}

function calculateStockValuation({ actualQuantity = 0, dmsQuantity = 0, dlc = 0, mrp = 0 } = {}) {
  const actualQty = numberValue(actualQuantity, 0);
  const dmsQty = numberValue(dmsQuantity, 0);
  const dlcRate = numberValue(dlc, 0);
  const mrpRate = numberValue(mrp, 0);
  const varianceQuantity = actualQty - dmsQty;

  return {
    actualQuantity: actualQty,
    dmsQuantity: dmsQty,
    varianceQuantity,
    dlc: dlcRate,
    mrp: mrpRate,
    actualStockValue: money(actualQty * dlcRate),
    dmsStockValue: money(dmsQty * dlcRate),
    varianceStockValue: money(varianceQuantity * dlcRate),
    actualMrpValue: money(actualQty * mrpRate),
    dmsMrpValue: money(dmsQty * mrpRate),
    varianceMrpValue: money(varianceQuantity * mrpRate)
  };
}

function stockValuationTotals(rows = []) {
  const totals = (Array.isArray(rows) ? rows : []).reduce((summary, row = {}) => {
    summary.actualDlcTotal += firstPositiveNumber(row.actualStockValue, row.physicalValueOnDlc);
    summary.dmsDlcTotal += firstPositiveNumber(row.dmsStockValue, row.systemValueOnDlc, row.systemDlcValue, row.stockValueDlc, row.stockValue);
    summary.varianceDlcTotal += firstNonZeroNumber(row.varianceStockValue, row.varianceOnDlc, row.differenceDlcValue);
    summary.actualMrpTotal += firstPositiveNumber(row.actualMrpValue, row.physicalValueOnMrp);
    summary.dmsMrpTotal += firstPositiveNumber(row.dmsMrpValue, row.systemValueOnMrp);
    summary.varianceMrpTotal += firstNonZeroNumber(row.varianceMrpValue, row.varianceOnMrp, row.differenceMrpValue);
    return summary;
  }, {
    actualDlcTotal: 0,
    dmsDlcTotal: 0,
    varianceDlcTotal: 0,
    actualMrpTotal: 0,
    dmsMrpTotal: 0,
    varianceMrpTotal: 0
  });

  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, money(value)]));
}

function reconcileDlcTotals(totals = {}, tolerance = 0.01) {
  const normalized = Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, money(value)]));
  const baseline = normalized.partwise;
  const differences = Object.fromEntries(Object.entries(normalized).map(([key, value]) => [key, money(value - baseline)]));
  const passed = Number.isFinite(baseline)
    && ['stockSummary', 'category', 'dashboard'].every((key) => Number.isFinite(normalized[key]) && Math.abs(normalized[key] - baseline) <= tolerance);

  return {
    passed,
    valuationBasis: 'DLC',
    formula: 'Actual Stock Value = Actual Quantity x DLC; DMS Stock Value = DMS Quantity x DLC',
    totals: normalized,
    differences,
    message: passed ? 'DLC valuation reconciliation passed' : 'Reconciliation failed: DLC totals do not match across reports'
  };
}

function assertDlcReconciliation(totals = {}, tolerance = 0.01) {
  const result = reconcileDlcTotals(totals, tolerance);
  if (!result.passed) {
    const error = new Error(result.message);
    error.code = 'REPORT_RECONCILIATION_FAILED';
    error.statusCode = 409;
    error.reconciliation = result;
    throw error;
  }
  return result;
}

module.exports = {
  assertDlcReconciliation,
  calculateStockValuation,
  money,
  reconcileDlcTotals,
  stockValuationTotals
};
