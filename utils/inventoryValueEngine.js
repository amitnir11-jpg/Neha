/**
 * ====================================================================
 * CENTRALIZED INVENTORY VALUE ENGINE - STRICT BUSINESS RULES
 * ====================================================================
 *
 * FINAL INVENTORY VALUE CALCULATION (ONLY SOURCE OF TRUTH):
 *
 *   TOTAL INVENTORY VALUE =
 *     SUM(qty x latest Part Master MRP)
 *
 * NOT allowed:
 *   - MRP parsed from scan data
 *   - Old user-entered scan/manual MRP as a final calculation source
 *
 * ====================================================================
 * MASTER PRICE FILE PURPOSE
 * ====================================================================
 *
 * Master data is the final pricing source for MRP/DLC valuation. Scan data
 * contributes the part number and quantity only.
 *
 * ====================================================================
 * UPI SCAN LOGIC
 * ====================================================================
 *
 * When UPI/QR/barcode scanned:
 *   1. Extract the part number only for pricing purposes
 *   2. Fetch current MRP/DLC from Part Master
 *   3. Save and value the scan with the master prices
 *
 * ====================================================================
 * MANUAL ENTRY LOGIC
 * ====================================================================
 *
 * When user manually enters part:
 *   1. Fetch and show current Part Master MRP/DLC
 *   2. Ignore user-entered price fields for final valuation
 *   3. Reject only when Part Master MRP or DLC is missing
 *
 * ====================================================================
 * VALUATION SOURCE (CRITICAL)
 * ====================================================================
 *
 * Current Part Master MRP/DLC is the only allowed final price source.
 * Missing master prices produce PART_MASTER_PRICE_MISSING and zero value.
 *
 * ====================================================================
 * REPORT VALUE CONSISTENCY RULE (CRITICAL)
 * ====================================================================
 *
 * ALL REPORTS MUST USE:
 *   - calculateInventoryValue() function
 *   - scanValueRow() for per-scan decoration
 *   - summarizeMovementBucket() for audit quantity/value aggregation
 *
 * NO REPORT IS ALLOWED TO:
 *   - Recalculate inventory value independently
 *   - Use scan/manual MRP for inventory calculations
 *   - Aggregate values differently than calculateInventoryValue()
 *
 * ====================================================================
 * AUDIT RISK REQUIREMENTS
 * ====================================================================
 *
 * The application does not maintain sales history. OUTWARD is an
 * audit-time outward entry, not regular sales movement. Reports must not
 * calculate movement velocity or sales categories from OUTWARD/FITTED
 * scan rows.
 *
 * Inventory risk status is derived from:
 *   - finalMRP availability
 *   - Physical Qty + Fitted Qty versus System Qty
 *
 * ====================================================================
 */

const { cleanText, normalizePartNumber, numberValue } = require('./normalize');
const { MASTER_PRICE_SOURCE } = require('./partMasterPrice');

const MASTER_VALUATION_SOURCES = new Set([
  MASTER_PRICE_SOURCE,
  'PART_MASTER_MRP',
  'PART_MASTER_PRICE',
  'MASTER_CATALOGUE_MRP',
  'CATALOGUE_MRP_FALLBACK'
]);

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function validDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(number) ? number : undefined;
}

function parseRawMrp(rawValue) {
  const raw = String(rawValue || '');
  if (!raw) return undefined;
  const slashUpi = parseSlashDelimitedUpi(raw);
  if (slashUpi.mrp !== undefined) return slashUpi.mrp;
  const queryText = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : raw;
  try {
    const params = new URLSearchParams(queryText.replace(/[|;]/g, '&'));
    for (const key of ['mrp', 'price']) {
      const value = optionalNumber(params.get(key));
      if (value !== undefined) return value;
    }
  } catch (error) {
    // Continue to the generic regex parser.
  }
  const match = raw.match(/(?:mrp|price)\s*[:=]\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  return match ? optionalNumber(match[1]) : undefined;
}

function parseSlashDelimitedUpi(rawValue) {
  const raw = String(rawValue || '').trim();
  const parts = raw.split('/').map((part) => part.trim());
  if (parts.length < 6 || !parts[3]) return {};
  const partNumber = normalizePartNumber(parts[3]);
  const qty = optionalNumber(parts[4]);
  const mrp = optionalNumber(parts[5]);
  if (!partNumber || mrp === undefined) return {};
  return {
    upiNo: cleanText(parts[1]).toUpperCase(),
    upiId: cleanText(parts[1]).toUpperCase(),
    partNumber,
    qty: qty !== undefined ? qty : 1,
    mrp: money(mrp)
  };
}

function rawScanText(scan = {}) {
  return cleanText(scan.rawScan || scan.rawScanString || scan.rawUpi || scan.rawBarcode || scan.rawQR || '');
}

function isManualScan(scan = {}) {
  const sourceText = [
    scan.valuationSource,
    scan.priceSource,
    scan.source,
    scan.scanSource,
    scan.entryMode,
    scan.scanMode
  ].map((value) => cleanText(value).toLowerCase()).join(' ');
  return /\bmanual\b/.test(sourceText);
}

function scanQty(scan = {}) {
  if (movementType(scan) === 'VERIFICATION') return 0;
  const direct = optionalNumber(scan.qty !== undefined ? scan.qty : scan.quantity);
  if (direct !== undefined) return Math.abs(direct);
  return Math.abs(numberValue(parseSlashDelimitedUpi(rawScanText(scan)).qty, 0));
}

function explicitManualMrp(scan = {}) {
  return optionalNumber(
    scan.manualMRP !== undefined ? scan.manualMRP
      : scan.manualMrp !== undefined ? scan.manualMrp
        : scan.manualEnteredMRP !== undefined ? scan.manualEnteredMRP
          : scan.manualEnteredMrp
  );
}

function explicitScannedMrp(scan = {}) {
  return optionalNumber(
    scan.scanMRP !== undefined ? scan.scanMRP
      : scan.scanMrp !== undefined ? scan.scanMrp
        : scan.scannedMRP !== undefined ? scan.scannedMRP
          : scan.scannedMrp !== undefined ? scan.scannedMrp
            : scan.upiMRP !== undefined ? scan.upiMRP
              : scan.upiMrp
  );
}

function explicitFinalMrp(scan = {}) {
  return optionalNumber(
    scan.finalMRP !== undefined ? scan.finalMRP
      : scan.finalMrp !== undefined ? scan.finalMrp
        : scan.final_mrp
  );
}

function getFinalInventoryMRP(scan = {}, catalogueData = {}) {
  const source = cleanText(scan.valuationSource || scan.priceSource).toUpperCase();
  const stored = optionalNumber(scan.valuationMRP !== undefined ? scan.valuationMRP : scan.valuationMrp);
  if (stored !== undefined && MASTER_VALUATION_SOURCES.has(source)) {
    return { mrp: money(stored), source };
  }

  const finalMrp = explicitFinalMrp(scan);
  if (finalMrp !== undefined && MASTER_VALUATION_SOURCES.has(source)) {
    return { mrp: money(finalMrp), source: source || MASTER_PRICE_SOURCE };
  }

  const explicitMasterMrp = optionalNumber(
    scan.currentCatalogueMRP !== undefined ? scan.currentCatalogueMRP
      : scan.currentCatalogueMrp !== undefined ? scan.currentCatalogueMrp
        : scan.masterMRP !== undefined ? scan.masterMRP
          : scan.masterMrp
  );
  if (explicitMasterMrp !== undefined) {
    return { mrp: money(explicitMasterMrp), source: MASTER_PRICE_SOURCE };
  }

  const catalogue = optionalNumber(
    catalogueData.currentCatalogueMRP !== undefined ? catalogueData.currentCatalogueMRP
      : catalogueData.currentCatalogueMrp !== undefined ? catalogueData.currentCatalogueMrp
        : catalogueData.mrp
  );
  if (catalogue !== undefined) {
    return { mrp: money(catalogue), source: MASTER_PRICE_SOURCE };
  }

  return { mrp: 0, source: 'PART_MASTER_PRICE_MISSING' };
}

function scanValuation(scan = {}) {
  return getFinalInventoryMRP(scan);
}

function movementType(scan = {}) {
  return cleanText(scan.scanType || scan.type).toUpperCase();
}

function scanValueRow(scan = {}) {
  const parsedUpi = parseSlashDelimitedUpi(rawScanText(scan));
  const partNumber = normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part || scan.partNo || parsedUpi.partNumber);
  const qty = scanQty(scan);
  const valuation = scanValuation(scan);
  const value = money(qty * valuation.mrp);
  const manual = false;
  const scanned = false;
  const master = MASTER_VALUATION_SOURCES.has(valuation.source);
  return {
    scan,
    partNumber,
    qty,
    mrp: valuation.mrp,
    valuationMRP: valuation.mrp,
    valuationSource: valuation.source,
    scannedQty: scanned ? qty : 0,
    manualQty: manual ? qty : 0,
    masterQty: master ? qty : 0,
    totalScanValue: 0,
    totalManualValue: 0,
    totalMasterValue: master ? value : 0,
    finalInventoryValue: value,
    timestamp: validDate(scan.timestamp || scan.scanTime || scan.createdAt)
  };
}

function calculateInventoryValue(input = [], options = {}) {
  const scans = Array.isArray(input) ? input : Array.isArray(input.scans) ? input.scans : [input];
  const rows = scans.map(scanValueRow).filter((row) => row.partNumber || options.includeBlankPart);
  const pricedRows = rows.filter((row) => row.mrp > 0 && row.qty > 0);
  const totalQty = rows.reduce((sum, row) => sum + row.qty, 0);
  const scannedQty = rows.reduce((sum, row) => sum + row.scannedQty, 0);
  const manualQty = rows.reduce((sum, row) => sum + row.manualQty, 0);
  const totalScanValue = money(rows.reduce((sum, row) => sum + row.totalScanValue, 0));
  const totalManualValue = money(rows.reduce((sum, row) => sum + row.totalManualValue, 0));
  const totalMasterValue = money(rows.reduce((sum, row) => sum + Number(row.totalMasterValue || 0), 0));
  const finalInventoryValue = money(rows.reduce((sum, row) => sum + row.finalInventoryValue, 0));
  const mrpQty = pricedRows.reduce((sum, row) => sum + row.qty, 0);
  const averageScannedMRP = mrpQty
    ? money(pricedRows.reduce((sum, row) => sum + row.mrp * row.qty, 0) / mrpQty)
    : 0;
  const mrps = pricedRows.map((row) => row.mrp);
  return {
    totalQty,
    scannedQty,
    manualQty,
    totalScanValue,
    totalManualValue,
    totalMasterValue,
    finalInventoryValue,
    averageScannedMRP,
    minScannedMRP: mrps.length ? Math.min(...mrps) : 0,
    maxScannedMRP: mrps.length ? Math.max(...mrps) : 0,
    priceChangeCount: new Set(mrps.map((mrp) => mrp.toFixed(2))).size,
    rows
  };
}

function auditStockStatus({ mrp = 0, physicalQty = 0, fittedQty = 0, systemQty = 0 } = {}) {
  if (Number(mrp || 0) <= 0) return 'MRP Pending';
  const auditedQty = Number(physicalQty || 0);
  const system = Number(systemQty || 0);
  if (auditedQty === system) return 'Inventory Matched';
  return auditedQty > system ? 'Excess' : 'Short';
}

function decorateScanValue(scan = {}) {
  const row = scanValueRow(scan);
  return {
    ...scan,
    mrp: row.valuationMRP,
    scanMRP: 0,
    manualMRP: 0,
    valuationMRP: row.valuationMRP,
    valuationSource: row.valuationSource,
    finalInventoryValue: row.finalInventoryValue
  };
}

function summarizeMovementBucket(scans = [], options = {}) {
  const referenceDate = validDate(options.referenceDate) || new Date();
  const value = calculateInventoryValue(scans);
  const rows = value.rows;
  const dates = rows.map((row) => row.timestamp).filter(Boolean).sort((a, b) => a - b);
  const firstScanDate = dates[0] || null;
  const lastScanDate = dates[dates.length - 1] || null;
  const inwardQty = rows.filter((row) => movementType(row.scan) === 'INWARD').reduce((sum, row) => sum + row.qty, 0);
  const outwardQty = rows.filter((row) => movementType(row.scan) === 'OUTWARD').reduce((sum, row) => sum + row.qty, 0);
  const fittedQty = rows.filter((row) => movementType(row.scan) === 'FITTED').reduce((sum, row) => sum + row.qty, 0);
  const damageQty = rows.filter((row) => movementType(row.scan) === 'DAMAGE').reduce((sum, row) => sum + row.qty, 0);
  const remainingQty = Math.max(inwardQty - outwardQty - fittedQty - damageQty, 0);
  const ageingDays = firstScanDate ? Math.max(0, Math.floor((referenceDate - firstScanDate) / 86400000)) : 0;
  return {
    ...value,
    inwardQty,
    outwardQty,
    fittedQty,
    damageQty,
    remainingQty,
    movementCount: 0,
    firstScanDate,
    lastScanDate,
    ageingDays
  };
}

/**
 * Validates that report value calculation uses the current Part Master price.
 * @param {Object} reportRow - Row from report with values
 * @returns {Object} Validation result with warnings
 */
function validateReportValueSource(reportRow = {}) {
  const warnings = [];
  
  if (reportRow.finalInventoryValue && reportRow.finalInventoryValue > 0) {
    if (!reportRow.valuationSource) {
      warnings.push('WARNING: Missing valuationSource in report row');
    }
    if (!MASTER_VALUATION_SOURCES.has(cleanText(reportRow.valuationSource).toUpperCase())) {
      warnings.push(`WARNING: Invalid valuationSource "${reportRow.valuationSource}" - must be ${MASTER_PRICE_SOURCE}`);
    }
  }

  return {
    isValid: warnings.length === 0,
    warnings,
    hasProperSource: MASTER_VALUATION_SOURCES.has(cleanText(reportRow.valuationSource).toUpperCase())
  };
}

/**
 * Creates report-ready row with proper column structure
 * Enforces business rules for report output
 * @param {Object} scan - Inventory scan record
 * @param {Object} catalogueData - Optional catalogue reference data
 * @returns {Object} Report row with all required fields
 */
function reportRowFromScan(scan = {}, catalogueData = {}) {
  const row = scanValueRow(scan);
  const validation = validateReportValueSource({
    ...row,
    currentCatalogueMRP: Number(catalogueData.mrp || 0)
  });
  
  return {
    // Part Identification
    partNumber: row.partNumber || scan.partNumber || '',
    partDescription: scan.partDescription || scan.partName || '',
    productCategory: scan.productCategory || scan.category || '',
    
    // Quantity Breakdown
    totalQty: row.qty,
    scannedQty: row.scannedQty,
    manualQty: row.manualQty,
    
    // Price Information
    currentCatalogueMRP: Number(catalogueData.mrp || 0),
    averageScannedMRP: row.mrp,
    minScannedMRP: row.mrp,
    maxScannedMRP: row.mrp,
    
    // Value Calculation (CRITICAL - Source of Truth)
    totalScanValue: row.totalScanValue,
    totalManualValue: row.totalManualValue,
    finalInventoryValue: row.finalInventoryValue,
    
    // Valuation Source (MUST BE TRACKED)
    valuationSource: row.valuationSource,
    valuationMRP: row.valuationMRP,
    
    // Data Quality
    hasValidSource: validation.hasProperSource,
    sourceValidationWarnings: validation.warnings,
    
    // Raw scan info
    valuationWarnings: scan.warnings || []
  };
}

/**
 * Aggregates multiple report rows while maintaining value integrity
 * ENFORCES: All values use same calculation engine
 * @param {Array} rows - Array of report rows to aggregate
 * @returns {Object} Aggregated totals
 */
function aggregateReportValues(rows = []) {
  // Use calculateInventoryValue for consistency
  const summary = calculateInventoryValue(rows.map(r => r.scan || r));
  
  // Add aggregated fields
  return {
    ...summary,
    
    // Additional report-level aggregation
    uniqueParts: new Set(rows.filter(r => r.partNumber).map(r => r.partNumber)).size,
    totalRows: rows.length,
    rowsWithProperSource: rows.filter(r => r.hasValidSource).length,
    rowsWithValidationWarnings: rows.filter(r => (r.sourceValidationWarnings || []).length > 0).length,
    
    // Source breakdown
    masterValueCount: rows.filter(r => MASTER_VALUATION_SOURCES.has(cleanText(r.valuationSource).toUpperCase())).length,
    noValueCount: rows.filter(r => !MASTER_VALUATION_SOURCES.has(cleanText(r.valuationSource).toUpperCase())).length
  };
}

module.exports = {
  auditStockStatus,
  calculateInventoryValue,
  decorateScanValue,
  getFinalInventoryMRP,
  money,
  parseRawMrp,
  parseSlashDelimitedUpi,
  scanQty,
  scanValueRow,
  scanValuation,
  summarizeMovementBucket,
  reportRowFromScan,
  validateReportValueSource,
  aggregateReportValues
};
