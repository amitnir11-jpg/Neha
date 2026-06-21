function clean(value) {
  return String(value || '').trim();
}

function publicScan(scan = {}) {
  try {
    const inventory = require('../routes/inventory');
    return inventory.publicScan ? inventory.publicScan(scan) : scan;
  } catch (error) {
    return scan;
  }
}

function requestLike(req = {}, input = {}) {
  const app = req.app || { get: () => null };
  return {
    ...req,
    app,
    io: req.io || (app && typeof app.get === 'function' ? app.get('io') : null),
    body: {
      ...(req.body && typeof req.body === 'object' ? req.body : {}),
      ...(input && typeof input === 'object' ? input : {})
    },
    query: req.query || {},
    user: req.user || null,
    headers: req.headers || {},
    originalUrl: req.originalUrl || req.url || '',
    get: typeof req.get === 'function' ? req.get.bind(req) : () => '',
    protocol: req.protocol || 'https',
    ip: req.ip || '',
    socket: req.socket || {}
  };
}

function responseStatusFor(result = {}) {
  if (result.httpStatus) return result.httpStatus;
  const status = clean(result.status).toLowerCase();
  if (status === 'synced') return result.updated ? 200 : 201;
  if (status === 'verification') return 200;
  if (status === 'duplicate') return 409;
  return 422;
}

function scanProcessLog(level, stage, details = {}) {
  const logger = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
  logger(`[SCAN_PROCESS] ${stage}`, details);
}

async function processScan(input = {}, options = {}) {
  const sync = require('../routes/sync');
  const req = requestLike(options.req || {}, input);
  const normalized = sync.normalizeScan(input);
  scanProcessLog('info', 'incoming', {
    route: clean(req.originalUrl || req.url || '/api/scans/process'),
    source: clean(normalized.scanSource || input.scanSource || input.source || 'unknown'),
    scanType: clean(normalized.scanType || normalized.type || ''),
    partNumber: clean(normalized.partNumber || normalized.part || ''),
    dealerCode: clean(normalized.dealerCode || ''),
    auditId: clean(normalized.auditId || ''),
    upiId: clean(normalized.upiId || normalized.upiNo || ''),
    syncKey: clean(normalized.syncKey || ''),
    scanId: clean(normalized.scanId || normalized.uniqueScanId || '')
  });
  const result = await sync.saveNormalizedScan(normalized, req);
  const status = clean(result.status).toLowerCase();
  const success = status === 'synced' || status === 'verification';
  const scan = publicScan(result.scan || result.updated || normalized);
  const message = result.message || result.error || (success ? 'Scan saved successfully' : 'Scan could not be saved');
  const duplicate = status === 'duplicate' || Boolean(result.duplicate);
  const updated = Boolean(result.updated);
  const logStatus = status === 'synced' ? 'inserted' : status || 'failed';
  const log = {
    status: logStatus,
    scanId: scan.scanId || scan.uniqueScanId || normalized.scanId || '',
    uniqueScanId: scan.uniqueScanId || scan.scanId || normalized.uniqueScanId || '',
    clientScanId: normalized.clientScanId || input.clientScanId || input.localId || '',
    clientSyncKey: normalized.clientSyncKey || input.clientSyncKey || input.syncKey || '',
    localId: input.localId || normalized.clientScanId || '',
    syncKey: scan.syncKey || normalized.syncKey || '',
    partNumber: scan.partNumber || scan.part || normalized.partNumber || '',
    upiId: scan.upiId || scan.upiNo || normalized.upiId || '',
    dealer: scan.dealerCode || normalized.dealerCode || '',
    errorMessage: success ? '' : message
  };

  scanProcessLog(success ? 'info' : duplicate ? 'warn' : 'error', 'result', {
    route: clean(req.originalUrl || req.url || '/api/scans/process'),
    source: clean(normalized.scanSource || input.scanSource || input.source || 'unknown'),
    status,
    duplicate,
    masterFound: scan.masterFound !== undefined ? Boolean(scan.masterFound) : undefined,
    masterMatch: scan.isMasterMatched !== undefined
      ? Boolean(scan.isMasterMatched)
      : (scan.masterMatch !== undefined ? Boolean(scan.masterMatch) : undefined),
    partNumber: clean(scan.partNumber || scan.part || normalized.partNumber || ''),
    dealerCode: clean(scan.dealerCode || normalized.dealerCode || ''),
    auditId: clean(scan.auditId || normalized.auditId || ''),
    upiId: clean(scan.upiId || scan.upiNo || normalized.upiId || ''),
    scanId: clean(scan.scanId || scan.uniqueScanId || normalized.scanId || ''),
    syncKey: clean(scan.syncKey || normalized.syncKey || ''),
    message
  });

  return {
    success,
    status,
    httpStatus: responseStatusFor(result),
    message,
    scan,
    parsed: normalized.parsed || {},
    duplicate,
    skipped: duplicate || Boolean(result.skipped),
    upiDuplicate: Boolean(result.upiDuplicate) || (duplicate && /upi/i.test(message)),
    manualDuplicate: Boolean(result.manualDuplicate),
    fittedDuplicate: Boolean(result.fittedDuplicate),
    existing: result.existing ? publicScan(result.existing) : undefined,
    requestedQty: result.requestedQty,
    existingQty: result.existingQty,
    binLocation: result.binLocation || scan.binLocation || scan.bin || '',
    partNumber: result.partNumber || scan.partNumber || scan.part || normalized.partNumber || '',
    reason: result.reason || '',
    updated,
    alreadyApplied: Boolean(result.alreadyApplied),
    addedQuantity: result.addedQuantity,
    newQuantity: result.newQuantity,
    logs: [log],
    insertedRecords: status === 'synced' && !updated ? [scan] : [],
    insertedCount: status === 'synced' && !updated ? 1 : 0,
    syncedCount: status === 'synced' ? 1 : 0,
    duplicateCount: duplicate ? 1 : 0,
    failedCount: success || duplicate ? 0 : 1,
    verification: status === 'verification'
  };
}

module.exports = {
  processScan
};
