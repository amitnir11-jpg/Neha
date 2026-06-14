const { cleanText, normalizePartNumber, numberValue } = require('./normalize');
const { latestCurrentPriceFromRows } = require('./priceHistory');
const { calculateStockValuation } = require('./stockValuation');

function upper(value) {
  return cleanText(value).toUpperCase();
}

function sourceLabel(source = '') {
  switch (String(source || '').toUpperCase()) {
    case 'MASTER_CATALOGUE':
      return 'Master Catalogue';
    case 'MASTER_PART':
      return 'Part Master';
    case 'PRICE_HISTORY':
      return 'Price History';
    case 'DEALER_STOCK':
      return 'Dealer Stock';
    default:
      return cleanText(source) || 'Unknown';
  }
}

function normalizePricingRecord(record = {}, source = '') {
  const sourceRecord = record || {};
  const partNumber = normalizePartNumber(sourceRecord.normalizedPartNumber || sourceRecord.partNumber || sourceRecord.partNo || sourceRecord.part || '');
  if (!partNumber) return null;
  return {
    source,
    partNumber,
    normalizedPartNumber: partNumber,
    partDescription: upper(sourceRecord.partDescription || sourceRecord.partName || sourceRecord.description || ''),
    productCategory: upper(sourceRecord.productCategory || sourceRecord.category || ''),
    category: upper(sourceRecord.category || sourceRecord.productCategory || ''),
    model: upper(sourceRecord.model || ''),
    year: upper(sourceRecord.year || sourceRecord.manufacturingYear || ''),
    manufacturingYear: upper(sourceRecord.manufacturingYear || sourceRecord.year || ''),
    productGroup: upper(sourceRecord.productGroup || ''),
    partSubGroup: upper(sourceRecord.partSubGroup || sourceRecord.productSubGroup || ''),
    mrp: numberValue(sourceRecord.mrp ?? sourceRecord.currentCatalogueMRP ?? sourceRecord.currentCatalogueMrp ?? 0, 0),
    dlc: numberValue(sourceRecord.dlc ?? sourceRecord.dlp ?? 0, 0),
    dealerCode: upper(sourceRecord.dealerCode || '')
  };
}

function hasMetadata(record = {}) {
  return Boolean(
    record.partDescription ||
    record.productCategory ||
    record.category ||
    record.model ||
    record.year ||
    record.manufacturingYear ||
    record.productGroup ||
    record.partSubGroup
  );
}

function pickPositiveCandidate(candidates = [], key = 'mrp') {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const value = numberValue(candidate[key], 0);
    if (value > 0) {
      return { value, source: candidate.source || '', record: candidate };
    }
  }
  return { value: 0, source: '', record: null };
}

function resolvePartPricing(options = {}) {
  const actualQty = numberValue(options.actualQty ?? options.actualStock ?? options.physicalQty ?? 0, 0);
  const dmsQty = numberValue(options.dmsQty ?? options.systemQty ?? options.dmsStock ?? 0, 0);
  const asOf = options.asOf || new Date();

  const catalogue = normalizePricingRecord(options.catalogue || options.catalogueRecord || null, 'MASTER_CATALOGUE');
  const master = normalizePricingRecord(options.master || options.masterRecord || null, 'MASTER_PART');
  const stock = normalizePricingRecord(options.stock || options.stockRecord || null, 'DEALER_STOCK');
  const latestPriceHistory = latestCurrentPriceFromRows(Array.isArray(options.priceHistories) ? options.priceHistories : [], asOf);
  const priceHistory = normalizePricingRecord(latestPriceHistory, 'PRICE_HISTORY');
  const metadataRecord = [catalogue, master, stock, priceHistory].find((record) => record && hasMetadata(record))
    || catalogue || master || stock || priceHistory || null;
  const priceCandidates = [catalogue, master, priceHistory, stock];
  const mrpPick = pickPositiveCandidate(priceCandidates, 'mrp');
  const dlcPick = pickPositiveCandidate(priceCandidates, 'dlc');

  const valuation = calculateStockValuation({
    actualQuantity: actualQty,
    dmsQuantity: dmsQty,
    dlc: dlcPick.value,
    mrp: mrpPick.value
  });

  if (!(dlcPick.value > 0)) {
    valuation.actualStockValue = null;
    valuation.dmsStockValue = null;
    valuation.varianceStockValue = null;
  }
  if (!(mrpPick.value > 0)) {
    valuation.actualMrpValue = null;
    valuation.dmsMrpValue = null;
    valuation.varianceMrpValue = null;
  }

  const warnings = [];
  if (!(mrpPick.value > 0)) {
    warnings.push('Missing MRP in Part Master');
  } else if (!['MASTER_CATALOGUE', 'MASTER_PART'].includes(mrpPick.source)) {
    warnings.push(`MRP fallback from ${sourceLabel(mrpPick.source)}`);
  }
  if (!(dlcPick.value > 0)) {
    warnings.push('Missing DLC in Part Master');
  } else if (!['MASTER_CATALOGUE', 'MASTER_PART'].includes(dlcPick.source)) {
    warnings.push(`DLC fallback from ${sourceLabel(dlcPick.source)}`);
  }

  return {
    partNumber: metadataRecord ? metadataRecord.partNumber : '',
    normalizedPartNumber: metadataRecord ? metadataRecord.normalizedPartNumber : '',
    partDescription: metadataRecord ? metadataRecord.partDescription : '',
    productCategory: metadataRecord ? metadataRecord.productCategory : '',
    category: metadataRecord ? metadataRecord.category : '',
    model: metadataRecord ? metadataRecord.model : '',
    year: metadataRecord ? metadataRecord.year : '',
    manufacturingYear: metadataRecord ? metadataRecord.manufacturingYear : '',
    productGroup: metadataRecord ? metadataRecord.productGroup : '',
    partSubGroup: metadataRecord ? metadataRecord.partSubGroup : '',
    dealerCode: metadataRecord ? metadataRecord.dealerCode : '',
    ...valuation,
    mrp: mrpPick.value > 0 ? mrpPick.value : null,
    dlc: dlcPick.value > 0 ? dlcPick.value : null,
    mrpSource: mrpPick.source || '',
    dlcSource: dlcPick.source || '',
    pricingSource: [mrpPick.source, dlcPick.source].filter(Boolean).filter((value, index, array) => array.indexOf(value) === index).join(' / ') || (metadataRecord ? metadataRecord.source : ''),
    pricingStatus: warnings.length ? warnings.join(' | ') : 'OK',
    pricingWarnings: warnings,
    warnings,
    missingMrp: !(mrpPick.value > 0),
    missingDlc: !(dlcPick.value > 0),
    hasValidMrp: mrpPick.value > 0,
    hasValidDlc: dlcPick.value > 0,
    actualQuantity: actualQty,
    dmsQuantity: dmsQty
  };
}

module.exports = {
  normalizePricingRecord,
  resolvePartPricing,
  sourceLabel
};
