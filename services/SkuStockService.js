const Inventory = require('../models/Inventory');
const { normalizePartNumber } = require('../utils/normalize');
const { uniqueReportScans } = require('../utils/reportScanIdentity');
const { stockMovementQuantity, activeStockTransaction } = require('../utils/stockQuantity');
const { upiCodeValue } = require('../utils/inventoryMovementState');

function calculateSkuBins(rows = []) {
  const bins = new Map();
  for (const row of uniqueReportScans(rows)) {
    // SKU movements never silently consume an individually tracked UPI.
    if (!activeStockTransaction(row) || upiCodeValue(row)) continue;
    const binLocation = String(row.binLocation || row.bin || row.sourceBin || '').trim().toUpperCase();
    if (!binLocation) continue;
    bins.set(binLocation, (bins.get(binLocation) || 0) + stockMovementQuantity(row));
  }
  return Array.from(bins, ([binLocation, availableQty]) => ({ binLocation, availableQty }))
    .filter(bin => bin.availableQty > 0)
    .sort((a, b) => a.binLocation.localeCompare(b.binLocation, undefined, { numeric: true }));
}

async function loadSkuBins({ dealerCode, auditId, partNumber }) {
  const part = normalizePartNumber(partNumber);
  if (!dealerCode || !auditId || !part) return [];
  const filter = require('../routes/inventory').applyTransactionScanFilter({ dealerCode, auditId,
    $or: [{ normalizedPartNumber: part }, { partNumber: part }, { part }] });
  const rows = await Inventory.find(filter).lean();
  return calculateSkuBins(rows);
}

async function prepareSkuSourceLocation(scan) {
  const bins = await loadSkuBins(scan);
  const requestedBin = String(scan.binLocation || '').trim().toUpperCase();
  const selected = requestedBin ? bins.find(bin => bin.binLocation === requestedBin) : bins.length === 1 ? bins[0] : null;
  if (!selected) return {
    status: bins.length > 1 && !requestedBin ? 'bin_selection_required' : 'failed',
    httpStatus: bins.length > 1 && !requestedBin ? 409 : 422,
    requiresBinSelection: bins.length > 1 && !requestedBin,
    binOptions: bins,
    error: bins.length > 1 && !requestedBin ? 'This SKU is available in multiple bins. Select the source bin.'
      : 'No eligible SKU stock in the selected bin. Scan a unique UPI to move individually tracked stock.'
  };
  if (selected.availableQty < Number(scan.quantity || 1)) return { status: 'failed', httpStatus: 422, error: 'Insufficient physical SKU stock in the selected bin.' };
  scan.binLocation = selected.binLocation;
  scan.bin = selected.binLocation;
  scan.sourceBin = selected.binLocation;
  scan.stockDeductedFromBin = selected.binLocation;
  scan.autoDetectedBin = !requestedBin;
  scan.binSelectionMode = requestedBin ? 'SKU_SELECTED' : 'SKU_SINGLE_BIN';
  return null;
}

module.exports = { calculateSkuBins, loadSkuBins, prepareSkuSourceLocation };
