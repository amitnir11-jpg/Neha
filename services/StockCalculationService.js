const Inventory = require('../models/Inventory');
const { normalizePartNumber } = require('../utils/normalize');
const { uniqueReportScans } = require('../utils/reportScanIdentity');
const { stockQuantitySummary, activeStockTransaction } = require('../utils/stockQuantity');
const { getActiveAudit } = require('../utils/audit');

function calculatePartStock(scans = [], partNumber = '') {
  const part = normalizePartNumber(partNumber);
  const rows = uniqueReportScans(scans).filter(scan => activeStockTransaction(scan)
    && normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part) === part);
  const byBin = new Map();
  for (const row of rows) {
    const bin = String(row.stockDeductedFromBin || row.sourceBin || row.binLocation || row.bin || '').trim().toUpperCase();
    if (!bin) continue;
    if (!byBin.has(bin)) byBin.set(bin, []);
    byBin.get(bin).push(row);
  }
  return { partNumber: part, ...stockQuantitySummary(rows),
    binBreakdown: Array.from(byBin, ([binLocation, binRows]) => ({ binLocation, ...stockQuantitySummary(binRows) }))
      .sort((a, b) => a.binLocation.localeCompare(b.binLocation)) };
}

async function loadPartStock({ dealerCode, auditId, partNumber } = {}) {
  const dealer = String(dealerCode || '').trim().toUpperCase();
  const part = normalizePartNumber(partNumber);
  if (!dealer || !part) return calculatePartStock([], part);
  if (!auditId) {
    const audit = await getActiveAudit({ dealerCode: dealer });
    if (!audit) return calculatePartStock([], part);
    auditId = audit.auditId || audit._id;
  }
  const filter = require('../routes/inventory').applyTransactionScanFilter({ dealerCode: dealer, auditId: String(auditId),
    $or: [{ normalizedPartNumber: part }, { partNumber: part }, { part }] });
  const rows = await Inventory.find(filter).lean();
  return calculatePartStock(rows, part);
}

module.exports = { calculatePartStock, loadPartStock };
