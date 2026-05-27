const PartPriceHistory = require('../models/PartPriceHistory');
const { normalizePartNumber } = require('./normalize');

function validDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function findPricePeriod(partNumber, asOf = new Date(), scanMrp = undefined) {
  const normalizedPartNumber = normalizePartNumber(partNumber);
  const scanDate = validDate(asOf) || new Date();
  if (!normalizedPartNumber) return null;
  const scannedMrp = Number(scanMrp || 0);
  if (scannedMrp > 0) {
    const mrpWindow = { $gte: scannedMrp - 0.01, $lte: scannedMrp + 0.01 };
    const activePriceMatch = await PartPriceHistory.findOne({
      normalizedPartNumber,
      mrp: mrpWindow,
      $and: [
        { $or: [{ effectiveFrom: { $lte: scanDate } }, { effectiveFrom: null }, { effectiveFrom: { $exists: false } }] },
        { $or: [{ effectiveTo: { $gte: scanDate } }, { effectiveTo: null }, { effectiveTo: { $exists: false } }] }
      ]
    }).sort({ effectiveFrom: -1, updatedAt: -1 }).lean();
    if (activePriceMatch) return activePriceMatch;

    const historicalPriceMatch = await PartPriceHistory.findOne({
      normalizedPartNumber,
      mrp: mrpWindow
    }).sort({ isCurrentPrice: -1, effectiveFrom: -1, updatedAt: -1 }).lean();
    if (historicalPriceMatch) return historicalPriceMatch;
  }
  const activePeriod = await PartPriceHistory.findOne({
    normalizedPartNumber,
    $and: [
      { $or: [{ effectiveFrom: { $lte: scanDate } }, { effectiveFrom: null }, { effectiveFrom: { $exists: false } }] },
      { $or: [{ effectiveTo: { $gte: scanDate } }, { effectiveTo: null }, { effectiveTo: { $exists: false } }] }
    ]
  }).sort({ effectiveFrom: -1, updatedAt: -1 }).lean();
  if (activePeriod) return activePeriod;
  return PartPriceHistory.findOne({ normalizedPartNumber }).sort({ isCurrentPrice: -1, effectiveFrom: -1, updatedAt: -1 }).lean();
}

function pricePeriodPayload(period = null, scanMrp = undefined) {
  if (!period) {
    return {
      priceHistoryId: null,
      pricePeriodFrom: null,
      pricePeriodTo: null,
      pricePeriodMatched: false,
      pricePeriodStatus: scanMrp ? 'NO_PRICE_PERIOD' : ''
    };
  }
  const expected = Number(period.mrp || 0);
  const actual = Number(scanMrp || 0);
  const matched = actual > 0 && Math.abs(expected - actual) <= 0.01;
  return {
    priceHistoryId: period._id,
    pricePeriodFrom: period.effectiveFrom || null,
    pricePeriodTo: period.effectiveTo || null,
    pricePeriodMatched: matched,
    pricePeriodStatus: actual > 0 ? (matched ? 'MATCHED_PRICE_PERIOD' : 'MRP_DIFFERS_FROM_PRICE_PERIOD') : 'NO_SCANNED_MRP'
  };
}

module.exports = {
  findPricePeriod,
  pricePeriodPayload
};
