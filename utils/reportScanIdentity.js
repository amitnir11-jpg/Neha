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

function reportScanIdentity(scan = {}) {
  const raw = rawScanIdentity(scan);
  if (raw) return `${scanScope(scan)}|RAW|${raw}`;

  const qrFingerprint = clean(scan.qrFingerprint);
  if (qrFingerprint) return `${scanScope(scan)}|QR|${qrFingerprint}`;

  const syncKey = clean(scan.syncKey);
  const source = upper(scan.source || scan.scanMode || scan.entryMode);
  if (syncKey && !source.includes('MANUAL')) return `${scanScope(scan)}|SYNC|${syncKey}`;

  return `${scanScope(scan)}|ROW|${clean(scan._id || scan.scanId || scan.uniqueScanId || scan.clientScanId || scan.localId || scan.timestamp || scan.createdAt || 'missing-id')}`;
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
