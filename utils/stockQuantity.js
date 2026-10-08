const { fittedPhysicalMovement, fittedWorkshopQuantity } = require('./fittedStock');

function stockMovementType(scan = {}) {
  const type = String(scan.scanType || scan.movementType || scan.type || 'INWARD').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return ({ VERIFY: 'VERIFICATION', OUT: 'OUTWARD', FIT: 'FITTED', FITTED_ON_VEHICLE: 'FITTED', DAMAGED: 'DAMAGE' })[type] || type;
}

function stockMovementBin(scan = {}) {
  const type = stockMovementType(scan);
  const fields = type === 'FITTED_RETURN'
    ? [scan.returnedToBin, scan.stockDeductedFromBin, scan.binLocation, scan.bin]
    : ['OUTWARD', 'FITTED', 'DAMAGE'].includes(type)
      ? [scan.stockDeductedFromBin, scan.sourceBin, scan.binLocation, scan.bin]
      : [scan.binLocation, scan.bin, scan.currentBin];
  return String(fields.find(value => String(value || '').trim()) || '').trim().toUpperCase();
}

function stockUnitQuantity(scan = {}) {
  // Load the existing legacy quantity parser only at call time to avoid the value-engine import cycle.
  const value = scan.qty ?? scan.quantity ?? require('./inventoryValueEngine').scanQty(scan);
  const qty = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(qty) ? Math.abs(qty) : 0;
}

function activeStockTransaction(scan = {}) {
  return scan.isDeleted !== true && !scan.deletedAt && scan.isDuplicate !== true
    && !['FAILED', 'REJECTED', 'DUPLICATE', 'DUPLICATE_BLOCKED'].includes(String(scan.syncStatus || '').toUpperCase())
    && !['REJECTED', 'DUPLICATE', 'DUPLICATE_BLOCKED'].includes(String(scan.scanStatus || '').toUpperCase())
    && !scan.isLocalPart && stockMovementType(scan) !== 'LOCAL_PART';
}

function stockMovementQuantity(scan = {}) {
  if (!activeStockTransaction(scan)) return 0;
  const type = stockMovementType(scan);
  const qty = stockUnitQuantity(scan);
  if (['INWARD', 'AUDIT', 'FITTED_RETURN'].includes(type)) return qty;
  if (type === 'FITTED') return fittedPhysicalMovement({ ...scan, scanType: type }) || 0;
  if (['OUTWARD', 'DAMAGE'].includes(type)) return -qty;
  return 0;
}

function stockWorkshopQuantity(scan = {}) {
  return activeStockTransaction(scan)
    ? fittedWorkshopQuantity({ ...scan, scanType: stockMovementType(scan) }) : 0;
}

function stockAvailableQuantity(scan = {}) {
  return stockMovementQuantity(scan) + stockWorkshopQuantity(scan);
}

function stockQuantitySummary(scans = []) {
  const totals = { inwardQty: 0, outwardQty: 0, fittedQty: 0, damageQty: 0, returnQty: 0, storeQty: 0, availableQty: 0 };
  for (const scan of scans) {
    if (!activeStockTransaction(scan)) continue;
    const type = stockMovementType(scan);
    const qty = stockUnitQuantity(scan);
    if (['INWARD', 'AUDIT'].includes(type)) totals.inwardQty += qty;
    if (type === 'OUTWARD') totals.outwardQty += qty;
    if (type === 'DAMAGE') totals.damageQty += qty;
    if (type === 'FITTED_RETURN') totals.returnQty += qty;
    totals.fittedQty += stockWorkshopQuantity(scan);
    totals.storeQty += stockMovementQuantity(scan);
    totals.availableQty += stockAvailableQuantity(scan);
  }
  return totals;
}

module.exports = { stockMovementType, stockMovementBin, stockUnitQuantity, activeStockTransaction, stockMovementQuantity, stockWorkshopQuantity, stockAvailableQuantity, stockQuantitySummary };
