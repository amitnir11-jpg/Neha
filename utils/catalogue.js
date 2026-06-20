const MasterCatalogue = require('../models/MasterCatalogue');
const MasterPart = require('../models/MasterPart');
const { cleanText, normalizePartNumber, numberValue } = require('./normalize');
const { applyProductGroup } = require('./productGroupClassifier');
const { decorateScanValue } = require('./inventoryValueEngine');
const { resolveCategoryFromMaster } = require('./categoryResolver');

function upper(value) {
  return cleanText(value).toUpperCase();
}

function cataloguePartNumber(record = {}) {
  return normalizePartNumber(record.normalizedPartNumber || record.partNumber || record.partNo || record.part);
}

function cataloguePayload(record = {}) {
  const year = upper(record.year || record.manufacturingYear || '');
  const category = resolveCategoryFromMaster(record);
  const description = upper(record.partDescription || record.partName || '');
  const grouping = applyProductGroup({ ...record, partDescription: description, productCategory: category }, { force: false });
  return {
    part: cataloguePartNumber(record),
    partNumber: cataloguePartNumber(record),
    normalizedPartNumber: cataloguePartNumber(record),
    partName: description,
    partDescription: description,
    category,
    productCategory: category,
    mrp: numberValue(record.mrp, 0),
    dlc: numberValue(record.dlc, 0),
    productGroup: upper(record.productGroup || grouping.productGroup),
    model: upper(record.model || ''),
    year,
    manufacturingYear: year,
    productType: upper(record.productType || ''),
    superceededBy: upper(record.superceededBy || ''),
    partGroup: upper(record.partGroup || ''),
    partSubGroup: upper(record.partSubGroup || grouping.partSubGroup),
    gstCategory: upper(record.gstCategory || ''),
    activeFlag: upper(record.activeFlag || ''),
    activeStatus: record.activeStatus !== false,
    splitFlag: upper(record.splitFlag || ''),
    masterMatch: true,
    isMasterMatched: true
  };
}

async function findCataloguePart(partNumber) {
  const normalized = normalizePartNumber(partNumber);
  if (!normalized) return null;
  const lookup = {
    $or: [
      { normalizedPartNumber: normalized },
      { partNumber: normalized },
      { partNo: normalized },
      { part: normalized }
    ]
  };
  const catalogue = await MasterCatalogue.findOne(lookup).lean();
  if (catalogue) return cataloguePayload(catalogue);
  const legacy = await MasterPart.findOne(lookup).lean();
  return legacy ? cataloguePayload(legacy) : null;
}

function enrichScanFields(scan = {}, catalogue = null) {
  const partNo = normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part);
  const valued = decorateScanValue(scan);
  const base = {
    part: partNo,
    partNumber: partNo,
    normalizedPartNumber: partNo,
    mrp: valued.valuationMRP || 0,
    scanMRP: valued.scanMRP || 0,
    manualMRP: valued.manualMRP || 0,
    valuationMRP: valued.valuationMRP || 0,
    valuationSource: valued.valuationSource || '',
    finalInventoryValue: valued.finalInventoryValue || 0,
    masterMatch: Boolean(catalogue),
    isMasterMatched: Boolean(catalogue)
  };
  if (!catalogue) return base;
  return {
    ...base,
    partName: catalogue.partDescription || '',
    partDescription: catalogue.partDescription || '',
    category: catalogue.productCategory || '',
    productCategory: catalogue.productCategory || '',
    currentCatalogueMRP: catalogue.mrp || 0,
    dlc: catalogue.dlc || 0,
    productGroup: catalogue.productGroup || '',
    model: catalogue.model || '',
    year: catalogue.year || catalogue.manufacturingYear || '',
    manufacturingYear: catalogue.manufacturingYear || catalogue.year || '',
    productType: catalogue.productType || '',
    superceededBy: catalogue.superceededBy || '',
    partGroup: catalogue.partGroup || '',
    partSubGroup: catalogue.partSubGroup || '',
    gstCategory: catalogue.gstCategory || ''
  };
}

module.exports = {
  upper,
  cataloguePartNumber,
  cataloguePayload,
  findCataloguePart,
  enrichScanFields
};
