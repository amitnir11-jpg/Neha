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

function codeTokens(value) {
  return upper(value).split(/[^A-Z0-9]+/).filter(Boolean);
}

function hasCode(value, candidates) {
  const tokens = codeTokens(value);
  return candidates.some((candidate) => tokens.includes(upper(candidate)));
}

function classifyMovement(stock = {}, actualStock = 0) {
  const dmsStock = Number(stock.dmsStock || stock.systemQty || 0);
  const averageDemand = Number(stock.averageDemand || 0);
  const forecast = Number(stock.forecast || 0);
  const safetyStock = Number(stock.safetyStock || 0);
  const rop = Number(stock.rop || 0);
  const movementCodeA = stock.movementCodeA || '';
  const movementCodeB = stock.movementCodeB || '';

  const highDemand = averageDemand >= 10 || forecast >= 10 || (dmsStock > 0 && averageDemand >= dmsStock * 0.25);
  const lowDemand = averageDemand <= 2;
  const fast = hasCode(movementCodeA, ['A']) || hasCode(movementCodeB, ['6']) || highDemand;
  const dead = dmsStock > 0 && averageDemand === 0 && forecast === 0;
  const slow = hasCode(movementCodeA, ['B', 'C']) || (lowDemand && dmsStock > 0);

  let movementStatus = 'Normal';
  if (dead) movementStatus = 'Dead Stock';
  else if (fast) movementStatus = 'Fast Moving';
  else if (slow) movementStatus = 'Slow Moving';

  const criticalShortage = rop > 0 && (dmsStock < rop || Number(actualStock || 0) < rop);
  const excessStock = dmsStock > forecast + safetyStock;
  let movementType = 'Normal';
  if (criticalShortage) movementType = 'Critical Shortage';
  else if (dead) movementType = 'Dead Stock';
  else if (excessStock) movementType = 'Excess Stock';
  else if (movementStatus !== 'Normal') movementType = movementStatus;

  const movementLabels = [];
  if (fast) movementLabels.push('Fast Moving');
  if (slow) movementLabels.push('Slow Moving');
  if (dead) movementLabels.push('Dead Stock');
  if (criticalShortage) movementLabels.push('Critical Shortage');
  if (excessStock) movementLabels.push('Excess Stock');

  return {
    movementType,
    movementStatus,
    priorityMovementStatus: movementType,
    movementLabels,
    fastMoving: fast,
    slowMoving: slow,
    deadStock: dead,
    criticalShortage,
    excessStock
  };
}

module.exports = {
  classifyMovement,
  applyMovementCountRules,
  reportTotals,
  scanPartNumber,
  scanQuantity,
  signedScanQuantity,
  isDuplicateScan,
  isUnknownPart
};
