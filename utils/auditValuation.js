const { Prisma } = require('@prisma/client');
const { normalizePartNumber } = require('./normalize');
const Decimal = Prisma.Decimal;

function decimal(value = 0) {
  if (value === null || value === undefined || value === '') return new Decimal(0);
  return new Decimal(String(value).replace(/,/g, ''));
}
function decimalSum(values = [], places = 2) {
  return values.reduce((sum, value) => sum.plus(decimal(value)), new Decimal(0))
    .toDecimalPlaces(places, Decimal.ROUND_HALF_UP).toNumber();
}
function priceValue(quantity, rate) {
  return decimal(quantity).times(decimal(rate)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
}

// Shared by dashboard, reconciliation, stock/category reports and audit packs.
// Quantities survive missing prices; incomplete amounts remain null, with an
// explicitly named known subtotal and an exception list, never an invented zero.
function summarizeAuditValuation(rows = [], options = {}) {
  const details = rows.map(row => {
    const dmsQuantity = Number(row.systemQty ?? row.dmsStock ?? row.dmsQuantity ?? row.dmsQty ?? 0);
    const actualQuantity = Number(row.totalDealerStockQty ?? row.actualStock ?? row.actualQuantity ?? row.physicalQty ?? 0);
    const dlc = Number(row.dlc ?? row.dlp ?? 0);
    const mrp = Number(row.mrp ?? 0);
    const shortageQty = Decimal.max(decimal(dmsQuantity).minus(actualQuantity), 0).toNumber();
    const excessQty = Decimal.max(decimal(actualQuantity).minus(dmsQuantity), 0).toNumber();
    const value = (qty, rate) => qty === 0 ? 0 : rate > 0 ? priceValue(qty, rate) : null;
    const dmsDlcValue = value(dmsQuantity, dlc);
    const actualDlcValue = value(actualQuantity, dlc);
    const dmsMrpValue = value(dmsQuantity, mrp);
    const actualMrpValue = value(actualQuantity, mrp);
    const difference = (actual, system) => actual === null || system === null ? null : decimalSum([actual, -system]);
    const dlcDifference = difference(actualDlcValue, dmsDlcValue);
    const mrpDifference = difference(actualMrpValue, dmsMrpValue);
    const shortageValue = delta => shortageQty === 0 ? 0 : delta === null ? null : Math.max(-delta, 0);
    const excessValue = delta => excessQty === 0 ? 0 : delta === null ? null : Math.max(delta, 0);
    return { partNumber: normalizePartNumber(row.partNumber || row.partNo || row.partNum),
      dealerCode: row.dealerCode || '', auditId: row.auditId || '',
      partDescription: row.partDescription || row.partName || '', category: row.productCategory || row.category || 'Uncategorized',
      dmsQuantity, actualQuantity, shortageQty, excessQty,
      uploadedStockPresent: Boolean(row.uploadedStockPresent || row.notInDms === false || dmsQuantity !== 0),
      dlc: dlc > 0 ? dlc : null, mrp: mrp > 0 ? mrp : null,
      missingDlc: !(dlc > 0), missingMrp: !(mrp > 0),
      dmsDlcValue, actualDlcValue, dmsMrpValue, actualMrpValue,
      shortageDlcValue: shortageValue(dlcDifference), excessDlcValue: excessValue(dlcDifference),
      shortageMrpValue: shortageValue(mrpDifference), excessMrpValue: excessValue(mrpDifference),
      pricingSource: row.pricingSource || '', pricingStatus: !(dlc > 0) || !(mrp > 0) ? 'PRICE MISSING' : 'VERIFIED' };
  });
  const exceptions = details.filter(row => row.missingDlc || row.missingMrp);
  const sum = key => decimalSum(details.map(row => row[key]), 8);
  const summary = { totalParts: details.length, dmsParts: details.filter(row => row.uploadedStockPresent).length,
    totalSystemQty: sum('dmsQuantity'), totalPhysicalQty: sum('actualQuantity'),
    totalShortQty: sum('shortageQty'), totalExcessQty: sum('excessQty'),
    totalVarianceQty: decimalSum(details.map(row => decimal(row.actualQuantity).minus(row.dmsQuantity)), 8),
    priceMissingParts: exceptions.length,
    partsMissingDlc: details.filter(row => row.missingDlc).length,
    partsMissingMrp: details.filter(row => row.missingMrp).length,
    dmsPriceMissingParts: exceptions.filter(row => row.dmsQuantity !== 0).length,
    dmsPriceMissingQty: decimalSum(exceptions.map(row => row.dmsQuantity), 8),
    valuationComplete: exceptions.length === 0,
    reconciliationComplete: options.stockUploadPresent !== false, priceExceptions: exceptions };
  for (const [field, key] of Object.entries({ totalDmsDlcValue: 'dmsDlcValue', totalPhysicalDlcValue: 'actualDlcValue',
    totalDmsMrpValue: 'dmsMrpValue', totalPhysicalMrpValue: 'actualMrpValue',
    totalShortValue: 'shortageDlcValue', totalExcessValue: 'excessDlcValue',
    totalShortMrpValue: 'shortageMrpValue', totalExcessMrpValue: 'excessMrpValue' })) {
    summary[`${field}KnownSubtotal`] = decimalSum(details.map(row => row[key]));
    summary[field] = details.some(row => row[key] === null) ? null : summary[`${field}KnownSubtotal`];
  }
  for (const [field, actual, system] of [['totalVarianceDlcValue', 'totalPhysicalDlcValue', 'totalDmsDlcValue'],
    ['totalVarianceMrpValue', 'totalPhysicalMrpValue', 'totalDmsMrpValue']]) {
    summary[`${field}KnownSubtotal`] = decimalSum([summary[`${actual}KnownSubtotal`], -summary[`${system}KnownSubtotal`]]);
    summary[field] = summary[actual] === null || summary[system] === null ? null : decimalSum([summary[actual], -summary[system]]);
  }
  summary.finalStatus = !summary.reconciliationComplete ? 'INCOMPLETE — STOCK UPLOAD REQUIRED'
    : !summary.valuationComplete ? 'INCOMPLETE — PRICE MISSING'
    : summary.totalShortQty || summary.totalExcessQty ? 'VARIANCE FOUND' : 'BALANCED';
  return summary;
}

module.exports = { decimalSum, priceValue, summarizeAuditValuation };
