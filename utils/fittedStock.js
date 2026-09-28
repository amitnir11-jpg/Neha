const TERMINAL_FITTED_STATUSES = new Set(['BILLED', 'RETURNED_TO_BIN', 'CANCELLED']);

function fittedStatus(scan = {}) {
  const status = String(scan.status || scan.fittedStatus || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (status === 'RETURNED' || status === 'RETURNED_TO_STORE') return 'RETURNED_TO_BIN';
  if (status === 'FITTED' || status === 'FITTED_ON_VEHICLE' || status === 'PENDING') return 'FITTED_PENDING';
  return status || 'FITTED_PENDING';
}

function fittedQuantity(scan = {}) {
  return Math.abs(Number(scan.fittedQty !== undefined ? scan.fittedQty : scan.qty !== undefined ? scan.qty : scan.quantity) || 0);
}

function fittedWorkshopQuantity(scan = {}) {
  if (String(scan.scanType || scan.type || scan.movementType || '').trim().toUpperCase() !== 'FITTED') return 0;
  return TERMINAL_FITTED_STATUSES.has(fittedStatus(scan)) ? 0 : fittedQuantity(scan);
}

function fittedPhysicalMovement(scan = {}) {
  if (String(scan.scanType || scan.type || scan.movementType || '').trim().toUpperCase() !== 'FITTED') return null;
  return -fittedQuantity(scan);
}

module.exports = { fittedPhysicalMovement, fittedQuantity, fittedStatus, fittedWorkshopQuantity };
