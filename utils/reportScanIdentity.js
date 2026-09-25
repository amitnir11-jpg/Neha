function clean(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function upper(value) {
  return clean(value).toUpperCase().replace(/\s+/g, ' ');
}

function rawScanIdentity(scan = {}) {
  return upper(
    scan.rawUpi ||
    scan.rawScan ||
    scan.rawScanString ||
    scan.rawBarcode ||
    scan.rawQR ||
    scan.upiNo ||
    scan.upiId ||
    ''
  );
}

function scanType(scan = {}) {
  return upper(scan.scanType || scan.type || 'INWARD');
}

function scanScope(scan = {}) {
  return [
    upper(scan.dealerCode),
    clean(scan.auditId),
    scanType(scan)
  ].join('|');
}

function isManualScan(scan = {}) {
  const source = [
    scan.source,
    scan.scanMode,
    scan.entryMode,
    scan.scanSourceLabel
  ].map(upper).join(' ');
  return source.includes('MANUAL');
}

function reportScanIdentity(scan = {}) {
  const scope = scanScope(scan);
  const uniqueScanId = clean(scan.uniqueScanId || scan.scanId);
  if (uniqueScanId) return `${scope}|ID|${uniqueScanId}`;

  const clientScanId = clean(scan.clientScanId || scan.localId);
  if (clientScanId) return `${scope}|CLIENT|${clientScanId}`;

  const syncKey = clean(scan.syncKey || scan.clientSyncKey);
  if (syncKey && !isManualScan(scan)) return `${scope}|SYNC|${syncKey}`;

  const rowId = clean(scan._id || scan.timestamp || scan.createdAt);
  if (rowId) return `${scope}|ROW|${rowId}`;

  const qrFingerprint = clean(scan.qrFingerprint);
  if (qrFingerprint) return `${scope}|QR|${qrFingerprint}`;

  const raw = rawScanIdentity(scan);
  if (raw) return `${scope}|RAW|${raw}`;

  return `${scope}|ROW|missing-id`;
}

function scanTimeValue(scan = {}) {
  const date = new Date(scan.timestamp || scan.scanTime || scan.createdAt || 0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function preferredReportScan(current = {}, candidate = {}) {
  const currentTime = scanTimeValue(current);
  const candidateTime = scanTimeValue(candidate);
  if (candidateTime && (!currentTime || candidateTime < currentTime)) return candidate;
  if (!rawScanIdentity(current) && rawScanIdentity(candidate)) return candidate;
  return current;
}

function uniqueReportScans(scans = []) {
  const byIdentity = new Map();
  scans.forEach((scan) => {
    const key = reportScanIdentity(scan);
    const existing = byIdentity.get(key);
    byIdentity.set(key, existing ? preferredReportScan(existing, scan) : scan);
  });
  return Array.from(byIdentity.values()).sort((a, b) => scanTimeValue(a) - scanTimeValue(b));
}

function duplicateReportScanCount(scans = []) {
  return Math.max(0, scans.length - uniqueReportScans(scans).length);
}

module.exports = {
  rawScanIdentity,
  reportScanIdentity,
  uniqueReportScans,
  duplicateReportScanCount
};
