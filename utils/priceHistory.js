const PartPriceHistory = require('../models/PartPriceHistory');
const { normalizePartNumber } = require('./normalize');

function validDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sortByLatestEffectiveFrom(a = {}, b = {}) {
  const aFrom = validDate(a.effectiveFrom);
  const bFrom = validDate(b.effectiveFrom);
  const aUpdated = validDate(a.updatedAt || a.uploadedAt || a.createdAt);
  const bUpdated = validDate(b.updatedAt || b.uploadedAt || b.createdAt);
  return (bFrom ? bFrom.getTime() : 0) - (aFrom ? aFrom.getTime() : 0)
    || (bUpdated ? bUpdated.getTime() : 0) - (aUpdated ? aUpdated.getTime() : 0);
}

function priceIsCurrent(row = {}, asOf = new Date()) {
  const date = validDate(asOf) || new Date();
  const from = validDate(row.effectiveFrom);
  const to = validDate(row.effectiveTo);
  return (!from || from <= date) && (!to || to >= date);
}

function latestCurrentPriceFromRows(rows = [], asOf = new Date()) {
  const validRows = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && Number(row.mrp || 0) > 0);
  if (!validRows.length) return null;
  const currentRows = validRows
    .filter((row) => priceIsCurrent(row, asOf))
    .sort(sortByLatestEffectiveFrom);
  if (currentRows.length) return currentRows[0];
  return validRows.slice().sort(sortByLatestEffectiveFrom)[0] || null;
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

/**
 * Get the latest/current MRP for a part number
 * Priority:
 * 1. Active price period in Price History (effective as of today)
 * 2. Most recent price in Price History
 * 3. Current MRP from Part Master
 * 4. Current MRP from Master Catalogue
 * Returns: { mrp, source, priceHistoryId }
 */
async function getLatestMRP(partNumber, asOf = new Date()) {
  const normalizedPartNumber = normalizePartNumber(partNumber);
  const scanDate = validDate(asOf) || new Date();
  
  if (!normalizedPartNumber) return { mrp: 0, source: 'NOT_FOUND', priceHistoryId: null };

  // Try 1: Find the current price period effective as of now.
  const activePriceHistory = await PartPriceHistory.findOne({
    normalizedPartNumber,
    $and: [
      { $or: [{ effectiveFrom: { $lte: scanDate } }, { effectiveFrom: null }, { effectiveFrom: { $exists: false } }] },
      { $or: [{ effectiveTo: { $gte: scanDate } }, { effectiveTo: null }, { effectiveTo: { $exists: false } }] }
    ]
  }).sort({ effectiveFrom: -1, updatedAt: -1 }).lean();
  
  if (activePriceHistory && activePriceHistory.mrp > 0) {
    return {
      mrp: activePriceHistory.mrp,
      source: 'PRICE_HISTORY_ACTIVE',
      priceHistoryId: activePriceHistory._id
    };
  }

  // Try 2: Find most recent price in Price History
  const latestPriceHistory = await PartPriceHistory.findOne({
    normalizedPartNumber
  }).sort({ isCurrentPrice: -1, effectiveFrom: -1, updatedAt: -1 }).lean();
  
  if (latestPriceHistory && latestPriceHistory.mrp > 0) {
    return {
      mrp: latestPriceHistory.mrp,
      source: 'PRICE_HISTORY_LATEST',
      priceHistoryId: latestPriceHistory._id
    };
  }

  // Try 3: Check MasterPart model
  try {
    const MasterPart = require('../models/MasterPart');
    const masterPart = await MasterPart.findOne({ 
      normalizedPartNumber 
    }).lean();
    
    if (masterPart && masterPart.mrp > 0) {
      return {
        mrp: masterPart.mrp,
        source: 'MASTER_PART',
        priceHistoryId: null
      };
    }
  } catch (e) {
    // Continue if MasterPart not available
  }

  // Try 4: Check MasterCatalogue model
  try {
    const MasterCatalogue = require('../models/MasterCatalogue');
    const masterCatalogue = await MasterCatalogue.findOne({ 
      normalizedPartNumber 
    }).lean();
    
    if (masterCatalogue && masterCatalogue.mrp > 0) {
      return {
        mrp: masterCatalogue.mrp,
        source: 'MASTER_CATALOGUE',
        priceHistoryId: null
      };
    }
  } catch (e) {
    // Continue if MasterCatalogue not available
  }

  // No MRP found
  return { mrp: 0, source: 'MRP_NOT_FOUND', priceHistoryId: null };
}

module.exports = {
  findPricePeriod,
  pricePeriodPayload,
  getLatestMRP,
  latestCurrentPriceFromRows,
  priceIsCurrent
};
