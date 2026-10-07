const { normalizePartNumber } = require('./normalize');
const { uniqueReportScans } = require('./reportScanIdentity');
const { summarizeMovementBucket } = require('./inventoryValueEngine');
const { movementTypeValue } = require('./inventoryMovementState');
const { fittedPhysicalMovement } = require('./fittedStock');
const { stockMovementQuantity } = require('./stockQuantity');

function clean(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function numberValue(value, fallback = 0) {
  const parsed = Number(String(value === undefined || value === null || value === '' ? fallback : value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function scanType(scan = {}) {
  return movementTypeValue(scan);
}

function scanPartNumber(scan = {}) {
  return normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part || scan.partNo || '');
}

function scanQuantity(scan = {}, fallback = 0) {
  if (scan._reportQuantity !== undefined) return Math.abs(numberValue(scan._reportQuantity, fallback));
  const value = scan.qty !== undefined && scan.qty !== null && scan.qty !== '' ? scan.qty : scan.quantity;
  const qty = numberValue(value, fallback);
  return Math.abs(qty);
}

function signedScanQuantity(scan = {}, fallback = 0) {
  if (scan._reportSignedQty !== undefined) return numberValue(scan._reportSignedQty, fallback);
  return stockMovementQuantity({ ...scan, qty: scanQuantity(scan, fallback) });
}

function isDuplicateScan(scan = {}) {
  const syncStatus = clean(scan.syncStatus).toLowerCase();
  const scanStatus = upper(scan.scanStatus || scan.status || '');
  return Boolean(
    scan.isDuplicate === true
    || syncStatus === 'duplicate'
    || scanStatus === 'DUPLICATE'
    || scanStatus === 'DUPLICATE_BLOCKED'
  );
}

function isUnknownPart(scan = {}) {
  if (scan._reportUnknown === true) return true;
  if (scan.masterFound === true || scan.masterMatch === true || scan.isMasterMatched === true) return false;
  const part = scanPartNumber(scan);
  if (!part || /^UNKNOWN|^INVALID|^SYNC/i.test(part)) return true;
  const text = [
    scan.status,
    scan.scanStatus,
    scan.syncStatus,
    scan.remarks,
    ...(Array.isArray(scan.warnings) ? scan.warnings : [])
  ].map(clean).join(' ');
  if (/not\s+found\s+in\s+master|unknown\s+part|invalid\s+part|rejected/i.test(text)) return true;
  return scan._masterLookupComplete === true
    && scan.masterFound === false
    && scan.masterMatch !== true
    && scan.isMasterMatched !== true;
}

function reportTotals(scans = [], options = {}) {
  const rows = options.dedupe ? uniqueReportScans(scans) : (Array.isArray(scans) ? scans.filter(Boolean) : []);
  const duplicateRows = rows.filter(isDuplicateScan);
  const unknownRows = rows.filter((scan) => scanType(scan) !== 'VERIFICATION' && scan._reportExcluded !== true && !isDuplicateScan(scan) && isUnknownPart(scan));
  const countedRows = rows.filter((scan) => scanType(scan) !== 'VERIFICATION' && scan._reportExcluded !== true && !isDuplicateScan(scan) && !isUnknownPart(scan));
  const uniqueParts = new Set(countedRows.map(scanPartNumber).filter(Boolean));
  const totalQuantity = countedRows.reduce((sum, scan) => sum + scanQuantity(scan, 0), 0);
  const inwardCount = countedRows.reduce((sum, scan) => ['INWARD', 'AUDIT'].includes(scanType(scan)) ? sum + scanQuantity(scan, 0) : sum, 0);
  const outwardCount = countedRows.reduce((sum, scan) => ['OUTWARD', 'FITTED', 'DAMAGE'].includes(scanType(scan)) ? sum + scanQuantity(scan, 0) : sum, 0);
  const movementSummary = summarizeMovementBucket(countedRows);
  const netAvailableCount = movementSummary.totalDealerStockQty;
  const duplicateCount = Number(options.duplicateCount || 0) + duplicateRows.length;
  const unknownParts = new Set(unknownRows.map(scanPartNumber).filter(Boolean));
  return {
    totalQuantity,
    partsScanned: totalQuantity,
    scanRows: countedRows.length,
    totalRows: countedRows.length,
    totalRecords: countedRows.length,
    uniqueParts: uniqueParts.size,
    uniquePartCount: uniqueParts.size,
    visibleRows: options.visibleRows !== undefined ? Number(options.visibleRows || 0) : countedRows.length,
    duplicateCount,
    duplicates: duplicateCount,
    unknownPartsCount: unknownRows.length,
    unknownPartCount: unknownRows.length,
    unknownUniqueParts: unknownParts.size,
    inwardCount,
    outwardCount,
    inwardQty: movementSummary.inwardQty,
    outwardQty: movementSummary.outwardQty,
    fittedQty: movementSummary.fittedQty,
    damageQty: movementSummary.damageQty,
    netQty: movementSummary.netQty,
    physicalStockQty: movementSummary.physicalBinQty,
    fittedWorkshopQty: movementSummary.fittedWorkshopQty,
    totalDealerStockQty: movementSummary.totalDealerStockQty,
    netAvailableCount,
    netQuantity: netAvailableCount
  };
}

function scanTimeValue(scan = {}) {
  const date = new Date(scan.timestamp || scan.scanTime || scan.createdAt || 0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function applyMovementCountRules(scans = [], options = {}) {
  const rows = (Array.isArray(scans) ? scans : []).filter(Boolean).slice()
    .sort((a, b) => scanTimeValue(a) - scanTimeValue(b));
  const output = [];

  rows.forEach((scan) => {
    const type = scanType(scan);
    const qty = scanQuantity(scan, 0);
    let reportSignedQty = 0;
    let excluded = false;
    let exclusionReason = '';

    if (type === 'VERIFICATION') {
      excluded = true;
      exclusionReason = 'Verification scan is not counted';
    } else if (['INWARD', 'AUDIT'].includes(type)) {
      reportSignedQty = qty;
    } else if (type === 'FITTED') {
      reportSignedQty = stockMovementQuantity(scan);
    } else if (['OUTWARD', 'DAMAGE'].includes(type)) {
      // Reports account for persisted scan transactions as entered. Stock
      // availability is validated by the scan service; report aggregation must
      // not erase or cap an OUTWARD/FITTED/DAMAGE row based on earlier scans.
      reportSignedQty = -qty;
    } else {
      reportSignedQty = qty;
    }

    const reportQty = Math.abs(reportSignedQty);
    const normalized = {
      ...scan,
      scanType: type,
      type,
      movementType: type,
      qty: reportQty,
      quantity: reportQty,
      _originalQty: scan.qty !== undefined ? scan.qty : scan.quantity,
      _reportQuantity: reportQty,
      _reportSignedQty: reportSignedQty,
      _reportExcluded: excluded,
      _reportExclusionReason: exclusionReason
    };
    output.push(normalized);
  });

  const sortedOutput = output.sort((a, b) => scanTimeValue(b) - scanTimeValue(a));
  return options.includeExcluded ? sortedOutput : sortedOutput.filter((scan) => scan._reportExcluded !== true);
}

module.exports = {
  applyMovementCountRules,
  reportTotals,
  scanPartNumber,
  scanQuantity,
  signedScanQuantity,
  isDuplicateScan,
  isUnknownPart
};
