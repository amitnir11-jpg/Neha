const { firstNonZeroNumber, firstPositiveNumber } = require('./normalize');
const { decimalSum, priceValue } = require('./auditValuation');

function numberValue(value, fallback = 0) {
  const parsed = Number(String(value === undefined || value === null || value === '' ? fallback : value)
    .replace(/\bRS\.?\b/gi, '')
    .replace(/\bINR\b/gi, '')
    .replace(/[₹$,\s]/g, '')
    .replace(/^\((.*)\)$/, '-$1')
    .trim());
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
    actualStockValue: priceValue(actualQty, dlcRate),
    dmsStockValue: priceValue(dmsQty, dlcRate),
    varianceStockValue: decimalSum([priceValue(actualQty, dlcRate), -priceValue(dmsQty, dlcRate)]),
    actualMrpValue: priceValue(actualQty, mrpRate),
    dmsMrpValue: priceValue(dmsQty, mrpRate),
    varianceMrpValue: decimalSum([priceValue(actualQty, mrpRate), -priceValue(dmsQty, mrpRate)])
  };
}

function firstPositiveStockNumber(...values) {
  for (const value of values) {
    const parsed = numberValue(value, 0);
    if (parsed > 0) return parsed;
  }
  return 0;
}

function dealerStockSystemMrp(row = {}, masterPrice = null) {
  return firstPositiveStockNumber(
    row.dlc,
    row.systemDlc,
    row.currentCatalogueDLC,
    row.valuationDLC,
    row.finalDLC,
    masterPrice && masterPrice.dlc,
    masterPrice && masterPrice.currentCatalogueDLC,
    masterPrice && masterPrice.valuationDLC,
    masterPrice && masterPrice.finalDLC,
    row.mrp,
    row.systemMrp,
    row.currentCatalogueMRP,
    row.valuationMRP,
    row.finalMRP,
    masterPrice && masterPrice.mrp,
    masterPrice && masterPrice.currentCatalogueMRP,
    masterPrice && masterPrice.valuationMRP,
    masterPrice && masterPrice.finalMRP,
    masterPrice && masterPrice.rate,
    masterPrice && masterPrice.price
  );
}

function calculateDealerStockSystemValue(row = {}, masterPrice = null) {
  const quantity = numberValue(row.dmsStock ?? row.systemQty ?? row.qty ?? row.quantity, 0);
  const mrp = dealerStockSystemMrp(row, masterPrice);
  return {
    quantity,
    mrp,
    stockValue: money(quantity * mrp),
    missingMrp: !(mrp > 0)
  };
}

function stockValuationTotals(rows = []) {
  const input = Array.isArray(rows) ? rows : [];
  return {
    actualDlcTotal: decimalSum(input.map(row => firstPositiveNumber(row.actualStockValue, row.physicalValueOnDlc))),
    dmsDlcTotal: decimalSum(input.map(row => firstPositiveNumber(row.dmsStockValue, row.systemValueOnDlc, row.systemDlcValue, row.stockValueDlc, row.stockValue))),
    varianceDlcTotal: decimalSum(input.map(row => firstNonZeroNumber(row.varianceStockValue, row.varianceOnDlc, row.differenceDlcValue))),
    actualMrpTotal: decimalSum(input.map(row => firstPositiveNumber(row.actualMrpValue, row.physicalValueOnMrp))),
    dmsMrpTotal: decimalSum(input.map(row => firstPositiveNumber(row.dmsMrpValue, row.systemValueOnMrp))),
    varianceMrpTotal: decimalSum(input.map(row => firstNonZeroNumber(row.varianceMrpValue, row.varianceOnMrp, row.differenceMrpValue)))
  };
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
  calculateDealerStockSystemValue,
  calculateStockValuation,
  dealerStockSystemMrp,
  money,
  reconcileDlcTotals,
  stockValuationTotals
};
