const MasterCatalogue = require('../models/MasterCatalogue');
const { cleanText, normalizePartNumber, numberValue } = require('./normalize');
const { applyProductGroup } = require('./productGroupClassifier');
const { resolveCategoryFromMaster } = require('./categoryResolver');

const MASTER_PRICE_SOURCE = 'PART_MASTER_MRP_DLC';
const MISSING_PART_MASTER_PRICE_MESSAGE = 'MRP/DLC missing in Part Master. Please update Part Master first.';

function upper(value) {
  return cleanText(value).toUpperCase();
}

function normalizeDealerCode(value) {
  const text = cleanText(value);
  const paren = text.match(/\(([^()]+)\)\s*$/);
  return upper(paren ? paren[1] : text);
}

function partLookup(partNumber) {
  const part = normalizePartNumber(partNumber);
  if (!part) return { _id: '__NO_PART__' };
  return {
    $or: [
      { normalizedPartNumber: part },
      { partNumber: part },
      { partNo: part },
      { part: part }
    ]
  };
}

function partListLookup(partNumbers = []) {
  const parts = Array.from(new Set(partNumbers.map(normalizePartNumber).filter(Boolean)));
  if (!parts.length) return { _id: '__NO_PARTS__' };
  return {
    $or: [
      { normalizedPartNumber: { $in: parts } },
      { partNumber: { $in: parts } },
      { partNo: { $in: parts } },
      { part: { $in: parts } }
    ]
  };
}

function dateMs(value) {
  if (!value) return 0;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function recordTimestamp(record = {}) {
  return Math.max(
    dateMs(record.uploadedAt),
    dateMs(record.updatedAt),
    dateMs(record.createdAt)
  );
}

function sourceRank(record = {}) {
  if (record.source === 'MASTER_CATALOGUE') return 30;
  if (record.dealerMatched) return 20;
  if (record.source === 'MASTER_PART') return 10;
  return 0;
}

function latestSort(left = {}, right = {}) {
  return recordTimestamp(right) - recordTimestamp(left)
    || sourceRank(right) - sourceRank(left)
    || Number(Boolean(right.dealerMatched)) - Number(Boolean(left.dealerMatched))
    || String(right.partNumber || '').localeCompare(String(left.partNumber || ''));
}

function asPriceRecord(record = {}, source = 'MASTER_PART', dealerCode = '') {
  if (!record) return null;
  const partNumber = normalizePartNumber(record.normalizedPartNumber || record.partNumber || record.partNo || record.part || '');
  if (!partNumber) return null;
  const description = upper(record.partDescription || record.partName || record.description || '');
  const category = resolveCategoryFromMaster(record);
  const grouping = applyProductGroup({ ...record, partDescription: description, productCategory: category }, { force: false });
  const normalizedDealer = normalizeDealerCode(dealerCode);
  const rowDealer = normalizeDealerCode(record.dealerCode || '');
  const mrp = numberValue(
    record.mrp !== undefined ? record.mrp
      : record.currentCatalogueMRP !== undefined ? record.currentCatalogueMRP
        : record.currentCatalogueMrp !== undefined ? record.currentCatalogueMrp
          : record.rate !== undefined ? record.rate
            : record.price,
    0
  );
  const dlc = numberValue(record.dlc !== undefined ? record.dlc : record.dlp, 0);
  const payload = {
    source,
    pricingSource: source === 'MASTER_CATALOGUE' ? 'Master Catalogue' : 'Part Master',
    sourceRecord: record,
    masterRecord: null,
    dealerMatched: Boolean(normalizedDealer && rowDealer && normalizedDealer === rowDealer),
    part: partNumber,
    partNo: partNumber,
    partNumber,
    normalizedPartNumber: partNumber,
    description,
    partDescription: description,
    partName: description,
    category,
    productCategory: category,
    model: upper(record.model || ''),
    year: upper(record.year || record.manufacturingYear || ''),
    manufacturingYear: upper(record.manufacturingYear || record.year || ''),
    productGroup: upper(record.productGroup || grouping.productGroup || ''),
    partSubGroup: upper(record.partSubGroup || record.productSubGroup || grouping.partSubGroup || ''),
    productSubGroup: upper(record.productSubGroup || record.partSubGroup || grouping.partSubGroup || ''),
    productType: upper(record.productType || ''),
    superceededBy: upper(record.superceededBy || ''),
    partGroup: upper(record.partGroup || ''),
    gstCategory: upper(record.gstCategory || ''),
    bin: upper(record.bin || record.binLocation || ''),
    binLocation: upper(record.binLocation || record.bin || ''),
    dealerCode: rowDealer,
    activeStatus: record.activeStatus !== false,
    uploadedAt: record.uploadedAt || null,
    updatedAt: record.updatedAt || null,
    createdAt: record.createdAt || null,
    mrp,
    dlc,
    hasValidMrp: mrp > 0,
    hasValidDlc: dlc > 0,
    missingMrp: !(mrp > 0),
    missingDlc: !(dlc > 0),
    masterFound: true,
    masterMatch: true,
    isMasterMatched: true
  };
  payload.masterRecord = {
    ...record,
    source,
    part: partNumber,
    partNo: partNumber,
    partNumber,
    normalizedPartNumber: partNumber,
    partName: description || record.partName || record.partDescription || '',
    partDescription: description || record.partDescription || record.partName || '',
    category,
    productCategory: category,
    productGroup: payload.productGroup,
    partSubGroup: payload.partSubGroup,
    productSubGroup: payload.productSubGroup,
    model: payload.model,
    year: payload.year,
    manufacturingYear: payload.manufacturingYear,
    mrp,
    dlc,
    masterFound: true,
    masterMatch: true,
    isMasterMatched: true
  };
  return payload;
}

function pickBestPriceRecord(records = [], dealerCode = '') {
  const candidates = records
    .map((item) => item.normalized || asPriceRecord(item.record, item.source, dealerCode))
    .filter(Boolean)
    .sort(latestSort);
  return candidates[0] || null;
}

async function getPriceFromPartMaster(partNumber, dealerCode = '') {
  const part = normalizePartNumber(partNumber);
  if (!part) return null;
  const lookup = partLookup(part);
  const catalogueRows = await MasterCatalogue.find(lookup).sort({ uploadedAt: -1, updatedAt: -1, createdAt: -1 }).limit(25).lean();
  return pickBestPriceRecord(
    catalogueRows.map((record) => ({ source: 'MASTER_CATALOGUE', record })),
    dealerCode
  );
}

async function getPricesFromPartMaster(partNumbers = [], dealerCode = '') {
  const parts = Array.from(new Set(partNumbers.map(normalizePartNumber).filter(Boolean)));
  const map = new Map();
  if (!parts.length) return map;
  const lookup = partListLookup(parts);
  const catalogueRows = await MasterCatalogue.find(lookup).sort({ uploadedAt: -1, updatedAt: -1, createdAt: -1 }).lean();
  const byPart = new Map();
  catalogueRows.forEach((record) => {
    const normalized = asPriceRecord(record, 'MASTER_CATALOGUE', dealerCode);
    if (!normalized) return;
    const list = byPart.get(normalized.partNumber) || [];
    list.push({ normalized });
    byPart.set(normalized.partNumber, list);
  });
  parts.forEach((part) => {
    const picked = pickBestPriceRecord(byPart.get(part) || [], dealerCode);
    if (picked) map.set(part, picked);
  });
  return map;
}

function priceFromPartMasterRecord(record = {}, dealerCode = '') {
  if (!record) return null;
  const source = record.source === 'MASTER_CATALOGUE' ? 'MASTER_CATALOGUE' : 'MASTER_PART';
  return asPriceRecord(record, source, dealerCode);
}

function masterPriceScanFields(price = null, quantity = 0) {
  const qty = numberValue(quantity, 0);
  const mrp = numberValue(price && price.mrp, 0);
  const dlc = numberValue(price && price.dlc, 0);
  const hasCompletePrice = mrp > 0 && dlc > 0;
  return {
    mrp,
    scanMRP: 0,
    manualMRP: 0,
    valuationMRP: mrp,
    valuationSource: hasCompletePrice ? MASTER_PRICE_SOURCE : 'PART_MASTER_PRICE_MISSING',
    finalInventoryValue: Math.round(qty * mrp * 100) / 100,
    finalMRP: mrp,
    defaultMRP: mrp,
    currentCatalogueMRP: mrp,
    currentCatalogueDLC: dlc,
    dlc,
    mrpStatus: mrp > 0 && dlc > 0 ? 'AVAILABLE' : 'PENDING',
    mrpPendingUpdatedAt: null,
    priceHistoryId: '',
    pricePeriodFrom: null,
    pricePeriodTo: null,
    pricePeriodMatched: false,
    pricePeriodStatus: 'PART_MASTER_CURRENT'
  };
}

function scanWithPartMasterPrice(scan = {}, price = null) {
  const quantity = numberValue(scan.qty !== undefined ? scan.qty : scan.quantity, 0);
  const normalizedPrice = price && price.masterFound !== undefined
    ? price
    : priceFromPartMasterRecord(price);
  if (!normalizedPrice) {
    return {
      ...scan,
      ...masterPriceScanFields(null, quantity),
      masterFound: false,
      masterMatch: false,
      isMasterMatched: false
    };
  }
  price = normalizedPrice;
  const fields = masterPriceScanFields(price, quantity);
  return {
    ...scan,
    part: price.partNumber,
    partNo: price.partNumber,
    partNumber: price.partNumber,
    normalizedPartNumber: price.partNumber,
    partName: price.description,
    partDescription: price.description,
    description: price.description,
    category: price.category,
    productCategory: price.category,
    model: price.model,
    year: price.year,
    manufacturingYear: price.manufacturingYear,
    productGroup: price.productGroup,
    partSubGroup: price.partSubGroup,
    productSubGroup: price.productSubGroup,
    ...fields,
    masterFound: true,
    masterMatch: true,
    isMasterMatched: true
  };
}

function masterPriceMissing(price = null) {
  return !price || !(numberValue(price.mrp, 0) > 0) || !(numberValue(price.dlc, 0) > 0);
}

function masterPriceError(partNumber = '') {
  const error = new Error(MISSING_PART_MASTER_PRICE_MESSAGE);
  error.statusCode = 400;
  error.code = 'PART_MASTER_PRICE_MISSING';
  error.partNumber = normalizePartNumber(partNumber);
  return error;
}

function requirePartMasterPrice(price = null, partNumber = '') {
  if (masterPriceMissing(price)) throw masterPriceError(partNumber);
  return price;
}

module.exports = {
  MASTER_PRICE_SOURCE,
  MISSING_PART_MASTER_PRICE_MESSAGE,
  asPriceRecord,
  getPriceFromPartMaster,
  getPricesFromPartMaster,
  masterPriceError,
  masterPriceMissing,
  masterPriceScanFields,
  partListLookup,
  partLookup,
  pickBestPriceRecord,
  priceFromPartMasterRecord,
  requirePartMasterPrice,
  scanWithPartMasterPrice
};
