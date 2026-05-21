const MasterCatalogue = require('../models/MasterCatalogue');
const MasterPart = require('../models/MasterPart');
const { cleanText, normalizePartNumber, numberValue } = require('./normalize');
const { applyProductGroup } = require('./productGroupClassifier');

function upper(value) {
  return cleanText(value).toUpperCase();
}

function cataloguePartNumber(record = {}) {
  return normalizePartNumber(record.normalizedPartNumber || record.partNumber || record.partNo || record.part);
}

function cataloguePayload(record = {}) {
  const year = upper(record.year || record.manufacturingYear || '');
  const category = upper(record.productCategory || record.category || '');
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
    activeStatus: record.activeStatus !== false,
    masterMatch: true,
    isMasterMatched: true
  };
}

async function findCataloguePart(partNumber) {
  const normalized = normalizePartNumber(partNumber);
  if (!normalized) return null;
  const catalogue = await MasterCatalogue.findOne({ normalizedPartNumber: normalized }).lean();
  if (catalogue) return cataloguePayload(catalogue);
  const legacy = await MasterPart.findOne({
    $or: [{ normalizedPartNumber: normalized }, { partNo: normalized }, { partNumber: normalized }]
  }).lean();
  return legacy ? cataloguePayload(legacy) : null;
}

async function reprocessScansWithCatalogue() {
  const Inventory = require('../models/Inventory');
  const scans = await Inventory.find({}).lean();
  let updatedCount = 0;
  let unmatchedCount = 0;
  const operations = [];
  for (const scan of scans) {
    const partNo = normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part);
    const catalogue = await findCataloguePart(partNo);
    if (!catalogue) unmatchedCount += 1;
    operations.push({
      updateOne: {
        filter: { _id: scan._id },
        update: {
          $set: {
            ...enrichScanFields({ ...scan, partNumber: partNo }, catalogue),
            warnings: catalogue ? (scan.warnings || []).filter((warning) => !/not found in master|catalogue/i.test(warning)) : Array.from(new Set([...(scan.warnings || []), 'Part not found in Master Catalogue']))
          }
        }
      }
    });
    updatedCount += 1;
  }
  if (operations.length) await Inventory.bulkWrite(operations, { ordered: false });
  return { updatedCount, unmatchedCount, scannedCount: scans.length };
}

function enrichScanFields(scan = {}, catalogue = null) {
  const partNo = normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part);
  const base = {
    part: partNo,
    partNumber: partNo,
    normalizedPartNumber: partNo,
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
    mrp: catalogue.mrp || 0,
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
  enrichScanFields,
  reprocessScansWithCatalogue
};
