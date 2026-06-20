const { cleanText, numberValue } = require('./normalize');
const { calculateStockValuation } = require('./stockValuation');
const { priceFromPartMasterRecord } = require('./partMasterPrice');

function sourceLabel(source = '') {
  switch (String(source || '').toUpperCase()) {
    case 'MASTER_CATALOGUE':
      return 'Master Catalogue';
    case 'MASTER_PART':
      return 'Part Master';
    default:
      return cleanText(source) || 'Unknown';
  }
}

function normalizePricingRecord(record = {}, source = '') {
  if (!record) return null;
  const recordSource = record.source || source || 'MASTER_PART';
  const normalized = priceFromPartMasterRecord({ ...record, source: recordSource }, sourceRecordDealer(record));
  return normalized ? { ...normalized, source: recordSource } : null;
}

function sourceRecordDealer(record = {}) {
  return record && record.dealerCode ? record.dealerCode : '';
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

  const hasCentralPrice = Object.prototype.hasOwnProperty.call(options, 'partMasterPrice');
  const centralPrice = normalizePricingRecord(options.partMasterPrice, options.partMasterPrice && options.partMasterPrice.source);
  const catalogue = hasCentralPrice
    ? centralPrice
    : normalizePricingRecord(options.catalogue || options.catalogueRecord || null, 'MASTER_CATALOGUE');
  const master = hasCentralPrice
    ? null
    : normalizePricingRecord(options.master || options.masterRecord || null, 'MASTER_PART');
  const metadataRecord = [catalogue, master].find((record) => record && hasMetadata(record))
    || catalogue || master || null;
  const priceCandidates = [catalogue, master];
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
  }
  if (!(dlcPick.value > 0)) {
    warnings.push('Missing DLC in Part Master');
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
