/**
 * ====================================================================
 * CENTRALIZED INVENTORY VALUE ENGINE - STRICT BUSINESS RULES
 * ====================================================================
 *
 * FINAL INVENTORY VALUE CALCULATION (ONLY SOURCE OF TRUTH):
 *
 *   TOTAL INVENTORY VALUE = 
 *     SUM(UPI scanned qty × scanned UPI MRP)
 *     +
 *     SUM(manual qty × manual entered MRP)
 *
 * NOT allowed:
 *   - Latest master MRP (only for catalogue/reference)
 *   - Current catalogue MRP (only for catalogue/reference)
 *   - Part master default MRP (only for catalogue/reference)
 *
 * ====================================================================
 * MASTER PRICE FILE PURPOSE (REFERENCE ONLY)
 * ====================================================================
 *
 * Master data is ONLY for:
 *   1. Part Catalogue Search
 *   2. Current Price Reference (display only)
 *   3. Part Movement Analysis (historical trends)
 *   4. Price Period Mapping (when was MRP effective)
 *   5. Stock Ageing Intelligence
 *   6. Historical MRP Matching
 *
 * MASTER PRICE MUST NOT directly override scanned/manual values.
 *
 * ====================================================================
 * UPI SCAN LOGIC
 * ====================================================================
 *
 * When UPI/QR/barcode scanned:
 *   1. Extract: part number + scanned MRP + scan datetime
 *   2. Save: scanMRP separately in valuationMRP field
 *   3. Match scanMRP with master price history for:
 *      - effectiveFrom date
 *      - effectiveTo date
 *   4. Tag stock with purchase period
 *   5. Use ONLY scanMRP for inventory valuation
 *   6. DO NOT replace with current master MRP
 *
 * ====================================================================
 * MANUAL ENTRY LOGIC
 * ====================================================================
 *
 * When user manually enters part:
 *   1. Show current master MRP by default (reference only)
 *   2. Allow user to edit MRP
 *   3. Save manualMRP separately in manualMRP field
 *   4. FINAL VALUE = manualQty × manualMRP (NOT master MRP)
 *
 * ====================================================================
 * VALUATION SOURCE PRIORITY (CRITICAL)
 * ====================================================================
 *
 * When calculating inventory value, check in this order:
 *
 *   1. Explicit Scanned MRP (UPI/QR data)
 *      → Use for scanned transactions
 *      → Source: 'UPI_SCANNED_MRP'
 *
 *   2. Parsed Raw MRP (from raw scan payload)
 *      → Extract from raw scan string if format matches
 *      → Source: 'UPI_SCANNED_MRP'
 *
 *   3. Explicit Manual MRP (if set by user)
 *      → Use for manual entry transactions
 *      → Source: 'MANUAL_ENTERED_MRP'
 *
 *   4. Stored Valuation MRP with correct source flag
 *      → Only if valuationSource is MANUAL_ENTERED_MRP or UPI_SCANNED_MRP
 *      → Use corresponding source
 *
 *   5. Fallback for manual scan detection
 *      → If manual scan detected, use mrp field
 *      → Source: 'MANUAL_ENTERED_MRP'
 *
 *   6. NO MRP FOUND
 *      → Zero value
 *      → Source: 'NO_SCANNED_OR_MANUAL_MRP'
 *      → Record warning in report
 *
 * ====================================================================
 * REPORT VALUE CONSISTENCY RULE (CRITICAL)
 * ====================================================================
 *
 * ALL REPORTS MUST USE:
 *   - calculateInventoryValue() function
 *   - scanValueRow() for per-scan decoration
 *   - summarizeMovementBucket() for movement analysis
 *
 * NO REPORT IS ALLOWED TO:
 *   - Recalculate inventory value independently
 *   - Use master MRP directly for inventory calculations
 *   - Use current catalogue MRP for value calculations
 *   - Aggregate values differently than calculateInventoryValue()
 *
 * ====================================================================
 * MOVEMENT REPORT REQUIREMENTS
 * ====================================================================
 *
 * Movement category must use:
 *   - Scan history (not just current MRP)
 *   - Old price period stock remaining
 *   - Outward movement patterns
 *   - Stock ageing (days since first scan)
 *   - Days since last movement
 *   - Qty under old MRP bucket
 *
 * Categories:
 *   - FAST MOVING: old MRP consumed quickly, regular movements
 *   - SLOW MOVING: partial old stock still remaining
 *   - DEAD STOCK: very old stock, no movement for 180+ days
 *   - NON MOVING: stock available but no outward found
 *
 * ====================================================================
 */

const { cleanText, normalizePartNumber, numberValue } = require('./normalize');

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

function getFinalInventoryMRP(scan = {}, catalogueData = {}) {
  const scanned = explicitScannedMrp(scan);
  if (scanned !== undefined) {
    return { mrp: money(scanned), source: 'UPI_SCANNED_MRP' };
  }

  const parsed = parseRawMrp(rawScanText(scan));
  if (parsed !== undefined) {
    return { mrp: money(parsed), source: 'UPI_SCANNED_MRP' };
  }

  const manual = explicitManualMrp(scan);
  if (manual !== undefined) {
    return { mrp: money(manual), source: 'MANUAL_ENTERED_MRP' };
  }

  const source = cleanText(scan.valuationSource || scan.priceSource).toUpperCase();
  const stored = optionalNumber(scan.valuationMRP !== undefined ? scan.valuationMRP : scan.valuationMrp);
  if (stored !== undefined && ['MANUAL_ENTERED_MRP', 'UPI_SCANNED_MRP'].includes(source)) {
    return { mrp: money(stored), source };
  }

  if (isManualScan(scan)) {
    const manualFallback = optionalNumber(scan.mrp);
    if (manualFallback !== undefined) {
      return { mrp: money(manualFallback), source: 'MANUAL_ENTERED_MRP' };
    }
  }

  const catalogue = optionalNumber(
    catalogueData.currentCatalogueMRP !== undefined ? catalogueData.currentCatalogueMRP
      : catalogueData.currentCatalogueMrp !== undefined ? catalogueData.currentCatalogueMrp
        : catalogueData.mrp
  );
  if (catalogue !== undefined) {
    return { mrp: money(catalogue), source: 'CATALOGUE_MRP_FALLBACK' };
  }

  return { mrp: 0, source: 'NO_SCANNED_OR_MANUAL_MRP' };
}

function scanValuation(scan = {}) {
  const valuation = getFinalInventoryMRP(scan);
  return valuation.source === 'CATALOGUE_MRP_FALLBACK'
    ? { mrp: 0, source: 'NO_SCANNED_OR_MANUAL_MRP' }
    : valuation;
}

function movementType(scan = {}) {
  return cleanText(scan.scanType || scan.type).toUpperCase();
}

function isMovementOut(scan = {}) {
  return ['OUTWARD', 'FITTED'].includes(movementType(scan));
}

function scanValueRow(scan = {}) {
  const parsedUpi = parseSlashDelimitedUpi(rawScanText(scan));
  const partNumber = normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part || scan.partNo || parsedUpi.partNumber);
  const qty = scanQty(scan);
  const valuation = scanValuation(scan);
  const value = money(qty * valuation.mrp);
  const manual = valuation.source === 'MANUAL_ENTERED_MRP';
  const scanned = valuation.source === 'UPI_SCANNED_MRP';
  return {
    scan,
    partNumber,
    qty,
    mrp: valuation.mrp,
    valuationMRP: valuation.mrp,
    valuationSource: valuation.source,
    scannedQty: scanned ? qty : 0,
    manualQty: manual ? qty : 0,
    totalScanValue: scanned ? value : 0,
    totalManualValue: manual ? value : 0,
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
  const finalInventoryValue = money(totalScanValue + totalManualValue);
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
    finalInventoryValue,
    averageScannedMRP,
    minScannedMRP: mrps.length ? Math.min(...mrps) : 0,
    maxScannedMRP: mrps.length ? Math.max(...mrps) : 0,
    priceChangeCount: new Set(mrps.map((mrp) => mrp.toFixed(2))).size,
    rows
  };
}

function decorateScanValue(scan = {}) {
  const row = scanValueRow(scan);
  const manual = row.valuationSource === 'MANUAL_ENTERED_MRP';
  const scanned = row.valuationSource === 'UPI_SCANNED_MRP';
  return {
    ...scan,
    mrp: row.valuationMRP,
    scanMRP: scanned ? row.valuationMRP : (scan.scanMRP || scan.scanMrp),
    manualMRP: manual ? row.valuationMRP : (scan.manualMRP || scan.manualMrp),
    valuationMRP: row.valuationMRP,
    valuationSource: row.valuationSource,
    finalInventoryValue: row.finalInventoryValue
  };
}

function movementWindowQty(rows = [], referenceDate, days) {
  const ref = validDate(referenceDate) || new Date();
  const cutoff = new Date(ref.getTime() - days * 24 * 60 * 60 * 1000);
  return rows.reduce((sum, row) => {
    const timestamp = row.timestamp;
    if (!timestamp || timestamp < cutoff || timestamp > ref) return sum;
    return sum + row.qty;
  }, 0);
}

function movementCategory({ remainingQty, movementCount, daysSinceLastMovement, ageingDays, movementQtyLast90Days }) {
  if (remainingQty > 0 && movementCount <= 0) return 'NON-MOVING';
  if (remainingQty > 0 && (Number(daysSinceLastMovement || 0) >= 180 || Number(ageingDays || 0) >= 365)) return 'DEAD';
  if (remainingQty > 0 && (Number(daysSinceLastMovement || 0) >= 60 || movementQtyLast90Days <= 0)) return 'SLOW';
  if (movementCount >= 3 && Number(daysSinceLastMovement || 0) <= 30) return 'FAST';
  if (remainingQty <= 0 && movementCount > 0) return 'FAST';
  return remainingQty > 0 ? 'SLOW' : '';
}

function summarizeMovementBucket(scans = [], options = {}) {
  const referenceDate = validDate(options.referenceDate) || new Date();
  const value = calculateInventoryValue(scans);
  const rows = value.rows;
  const dates = rows.map((row) => row.timestamp).filter(Boolean).sort((a, b) => a - b);
  const movementRows = rows.filter((row) => isMovementOut(row.scan));
  const firstScanDate = dates[0] || null;
  const lastScanDate = dates[dates.length - 1] || null;
  const movementDates = movementRows.map((row) => row.timestamp).filter(Boolean).sort((a, b) => a - b);
  const lastMovementDate = movementDates[movementDates.length - 1] || null;
  const inwardQty = rows.filter((row) => ['INWARD', 'AUDIT', 'VERIFICATION'].includes(movementType(row.scan))).reduce((sum, row) => sum + row.qty, 0);
  const outwardQty = rows.filter((row) => movementType(row.scan) === 'OUTWARD').reduce((sum, row) => sum + row.qty, 0);
  const fittedQty = rows.filter((row) => movementType(row.scan) === 'FITTED').reduce((sum, row) => sum + row.qty, 0);
  const damageQty = rows.filter((row) => movementType(row.scan) === 'DAMAGE').reduce((sum, row) => sum + row.qty, 0);
  const remainingQty = Math.max(inwardQty - outwardQty - fittedQty - damageQty, 0);
  const daysSinceLastMovement = lastMovementDate ? Math.max(0, Math.floor((referenceDate - lastMovementDate) / 86400000)) : null;
  const ageingDays = firstScanDate ? Math.max(0, Math.floor((referenceDate - firstScanDate) / 86400000)) : 0;
  const movementQtyLast90Days = movementWindowQty(movementRows, referenceDate, 90);
  return {
    ...value,
    inwardQty,
    outwardQty,
    fittedQty,
    damageQty,
    remainingQty,
    movementCount: movementRows.length,
    firstScanDate,
    lastScanDate,
    lastMovementDate,
    movementQtyLast30Days: movementWindowQty(movementRows, referenceDate, 30),
    movementQtyLast90Days,
    movementQtyLast180Days: movementWindowQty(movementRows, referenceDate, 180),
    movementQtyLast365Days: movementWindowQty(movementRows, referenceDate, 365),
    ageingDays,
    daysSinceLastMovement,
    movementCategory: movementCategory({
      remainingQty,
      movementCount: movementRows.length,
      daysSinceLastMovement,
      ageingDays,
      movementQtyLast90Days
    }),
    inventoryRiskValue: money(remainingQty * (value.averageScannedMRP || 0))
  };
}

/**
 * Validates that report value calculation ONLY uses scan/manual MRP
 * This function ensures no master MRP override happened
 * @param {Object} reportRow - Row from report with values
 * @returns {Object} Validation result with warnings
 */
function validateReportValueSource(reportRow = {}) {
  const warnings = [];
  
  // Check that finalInventoryValue is not using master MRP
  if (reportRow.finalInventoryValue && reportRow.finalInventoryValue > 0) {
    if (!reportRow.valuationSource) {
      warnings.push('WARNING: Missing valuationSource in report row');
    }
    if (!['UPI_SCANNED_MRP', 'MANUAL_ENTERED_MRP'].includes(reportRow.valuationSource)) {
      warnings.push(`WARNING: Invalid valuationSource "${reportRow.valuationSource}" - must be UPI_SCANNED_MRP or MANUAL_ENTERED_MRP`);
    }
  }
  
  // Ensure currentCatalogueMRP is ONLY for reference, not calculation
  if (reportRow.currentCatalogueMRP && reportRow.finalInventoryValue) {
    const expectedValue = (reportRow.scannedQty || 0) * (reportRow.averageScannedMRP || 0);
    const expectedManualValue = (reportRow.manualQty || 0) * (reportRow.manualMRP || 0);
    const expectedTotal = money(expectedValue + expectedManualValue);
    
    if (Math.abs(reportRow.finalInventoryValue - expectedTotal) > 0.01) {
      warnings.push(`VALUE MISMATCH: finalInventoryValue should equal scan value + manual value, not catalogue MRP`);
    }
  }
  
  return {
    isValid: warnings.length === 0,
    warnings,
    hasProperSource: ['UPI_SCANNED_MRP', 'MANUAL_ENTERED_MRP'].includes(reportRow.valuationSource)
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
    scannedValueCount: rows.filter(r => r.valuationSource === 'UPI_SCANNED_MRP').length,
    manualValueCount: rows.filter(r => r.valuationSource === 'MANUAL_ENTERED_MRP').length,
    noValueCount: rows.filter(r => r.valuationSource === 'NO_SCANNED_OR_MANUAL_MRP').length
  };
}

module.exports = {
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
