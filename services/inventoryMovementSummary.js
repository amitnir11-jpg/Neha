const Inventory = require('../models/Inventory');
const InventoryMovementSummary = require('../models/InventoryMovementSummary');
const MasterCatalogue = require('../models/MasterCatalogue');
const { normalizePartNumber } = require('../utils/normalize');
const { cataloguePayload } = require('../utils/catalogue');
const { scanValueRow, summarizeMovementBucket } = require('../utils/inventoryValueEngine');

function clean(value) {
  return String(value || '').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function summaryKey({ dealerCode = '', auditId = '', partNumber = '', mrp = 0 }) {
  return [
    upper(dealerCode) || 'ALL',
    clean(auditId) || 'ALL',
    normalizePartNumber(partNumber),
    Number(mrp || 0).toFixed(2),
    'SCAN-UPI-MRP'
  ].join('::');
}

function baseScanFilter(filter = {}) {
  const query = {
    syncStatus: { $nin: ['duplicate', 'rejected', 'failed', 'deleted'] },
    isDuplicate: { $ne: true }
  };
  if (filter.dealerCode) query.dealerCode = upper(filter.dealerCode);
  if (filter.auditId) query.auditId = clean(filter.auditId);
  if (filter.partNumbers && filter.partNumbers.length) {
    query.normalizedPartNumber = { $in: filter.partNumbers.map(normalizePartNumber).filter(Boolean) };
  }
  return query;
}

async function rebuildMovementSummaries(filter = {}) {
  const scanFilter = baseScanFilter(filter);
  const scans = await Inventory.find(scanFilter).lean();
  const partNumbers = Array.from(new Set(scans.map((scan) => normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part)).filter(Boolean)));
  const catalogueRows = partNumbers.length ? await MasterCatalogue.find({ normalizedPartNumber: { $in: partNumbers } }).lean() : [];
  const catalogueByPart = new Map(catalogueRows.map((row) => [normalizePartNumber(row.normalizedPartNumber || row.partNumber), cataloguePayload(row)]));
  const groups = new Map();

  scans.forEach((scan) => {
    const valueRow = scanValueRow(scan);
    if (!valueRow.partNumber || valueRow.valuationMRP <= 0) return;
    const key = summaryKey({
      dealerCode: scan.dealerCode,
      auditId: scan.auditId,
      partNumber: valueRow.partNumber,
      mrp: valueRow.valuationMRP,
      priceSource: valueRow.valuationSource
    });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(scan);
  });

  const calculatedAt = new Date();
  const operations = [];
  groups.forEach((bucketScans, key) => {
    const first = bucketScans[0] || {};
    const valueRow = scanValueRow(first);
    const partNumber = valueRow.partNumber;
    const catalogue = catalogueByPart.get(partNumber) || {};
    const summary = summarizeMovementBucket(bucketScans, {
      referenceDate: calculatedAt,
      currentCatalogueMRP: Number(catalogue.mrp || 0)
    });
    operations.push({
      updateOne: {
        filter: { summaryKey: key },
        update: {
          $set: {
            summaryKey: key,
            partNumber,
            normalizedPartNumber: partNumber,
            dealerCode: upper(first.dealerCode),
            auditId: clean(first.auditId),
            mrp: valueRow.valuationMRP,
            scanUPIMRP: valueRow.valuationSource === 'UPI_SCANNED_MRP' ? valueRow.valuationMRP : 0,
            priceSource: valueRow.valuationSource,
            currentCatalogueMrp: Number(catalogue.mrp || 0),
            averageMRP: summary.averageScannedMRP,
            totalQty: summary.totalQty,
            scannedQty: summary.scannedQty,
            manualQty: summary.manualQty,
            inwardQty: summary.inwardQty,
            outwardQty: summary.outwardQty,
            fittedQty: summary.fittedQty,
            damageQty: summary.damageQty,
            remainingQty: summary.remainingQty,
            movementCount: summary.movementCount,
            totalScanValue: summary.totalScanValue,
            totalManualValue: summary.totalManualValue,
            finalInventoryValue: summary.finalInventoryValue,
            finalValue: summary.finalInventoryValue,
            firstScanDate: summary.firstScanDate,
            lastScanDate: summary.lastScanDate,
            ageingDays: summary.ageingDays,
            oldestPricePeriod: summary.firstScanDate,
            newestPricePeriod: summary.lastScanDate,
            pricePeriodFrom: summary.firstScanDate,
            pricePeriodTo: summary.lastScanDate,
            priceAgeingDays: summary.ageingDays,
            remarks: '',
            calculatedAt,
            rawScanCount: bucketScans.length
          }
        },
        upsert: true
      }
    });
  });

  const deleteFilter = {};
  if (filter.dealerCode) deleteFilter.dealerCode = upper(filter.dealerCode);
  if (filter.auditId) deleteFilter.auditId = clean(filter.auditId);
  if (partNumbers.length) deleteFilter.normalizedPartNumber = { $in: partNumbers };
  if (Object.keys(deleteFilter).length) await InventoryMovementSummary.deleteMany(deleteFilter);
  if (operations.length) await InventoryMovementSummary.bulkWrite(operations, { ordered: false });
  return { scannedCount: scans.length, summaryCount: operations.length, partCount: partNumbers.length };
}

async function compactClosedAuditRawScans({ dealerCode = '', auditId = '' } = {}) {
  const filter = {};
  if (dealerCode) filter.dealerCode = upper(dealerCode);
  if (auditId) filter.auditId = clean(auditId);
  if (!Object.keys(filter).length) return { modifiedCount: 0 };
  const result = await Inventory.updateMany(filter, {
    $unset: {
      rawScan: '',
      rawScanString: '',
      rawBarcode: '',
      rawQR: '',
      rawUpi: ''
    },
    $set: { rawScanArchivedAt: new Date() }
  });
  return { modifiedCount: result.modifiedCount || result.nModified || 0 };
}

function scheduleMovementSummaryRefresh(scans = [], delayMs = 750) {
  const list = Array.isArray(scans) ? scans : [scans];
  const scopes = new Map();
  list.forEach((scan) => {
    const dealerCode = upper(scan && scan.dealerCode);
    const auditId = clean(scan && scan.auditId);
    const partNumber = normalizePartNumber(scan && (scan.normalizedPartNumber || scan.partNumber || scan.part));
    if (!partNumber) return;
    const key = `${dealerCode}::${auditId}`;
    const scope = scopes.get(key) || { dealerCode, auditId, partNumbers: new Set() };
    scope.partNumbers.add(partNumber);
    scopes.set(key, scope);
  });
  if (!scopes.size) return;
  setTimeout(() => {
    scopes.forEach((scope) => {
      rebuildMovementSummaries({
        dealerCode: scope.dealerCode,
        auditId: scope.auditId,
        partNumbers: Array.from(scope.partNumbers)
      }).catch((error) => console.warn('[movement-summary] refresh failed', error.message));
    });
  }, delayMs).unref?.();
}

module.exports = {
  compactClosedAuditRawScans,
  rebuildMovementSummaries,
  scheduleMovementSummaryRefresh,
  summaryKey
};
