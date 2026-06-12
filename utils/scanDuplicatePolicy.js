const { createHash } = require('crypto');
const { normalizePartNumber } = require('./normalize');

const COUNTED_SCAN_STATUSES = ['ACCEPTED', 'SUPERVISOR_APPROVED', 'OUTWARD_DONE'];
const EXCLUDED_SYNC_STATUSES = ['duplicate', 'rejected', 'failed', 'deleted'];
const DUPLICATE_PART_MESSAGE = 'Duplicate part already scanned in this audit.';

function clean(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function scanType(input = {}) {
  const type = upper(input.scanType || input.type || input.action || 'INWARD');
  return type === 'VERIFY' ? 'VERIFICATION' : type;
}

function scanPartNumber(input = {}) {
  return normalizePartNumber(input.normalizedPartNumber || input.partNumber || input.part || input.partNo || '');
}

function scanDealerCode(input = {}) {
  const dealer = clean(input.dealerCode || input.dealer || input.dealerId || '');
  const paren = dealer.match(/\(([^()]+)\)\s*$/);
  const dash = dealer.match(/^([A-Za-z0-9_]{3,})\s+-\s+.+$/);
  return upper(paren ? paren[1] : dash ? dash[1] : dealer);
}

function scanAuditId(input = {}) {
  return clean(input.auditId || input.audit || input.auditNo || input.auditNumber || '');
}

function rawScanText(input = {}) {
  return clean(input.rawScanString || input.rawScan || input.rawBarcode || input.rawQR || input.rawUpi || input.rawUPI || input.barcode || input.raw || input.scanText);
}

function scanIdentityId(input = {}) {
  return clean(input.uniqueScanId || input.scanId || input.clientScanId || input.mobileScanId || input.offlineScanId || input.offline_scan_id || input.localId);
}

function scanSyncKey(input = {}) {
  return clean(input.syncKey || input.clientSyncKey || input.offlineId || input.offline_id || input.offlineScanId || input.offline_scan_id);
}

function rawUpiHash(input = {}) {
  const raw = rawScanText(input) || clean(input.upiNo || input.upiId || input.upiID || '');
  if (!raw) return '';
  const scope = [
    scanDealerCode(input),
    scanAuditId(input),
    scanType(input),
    raw
  ].map((value) => upper(value)).filter(Boolean).join('|');
  return createHash('sha256').update(scope).digest('hex');
}

function businessDuplicateKey(input = {}) {
  const dealerCode = scanDealerCode(input);
  const auditId = scanAuditId(input);
  const partNumber = scanPartNumber(input);
  const type = scanType(input);
  if (!dealerCode || !auditId || !partNumber || !type || type === 'VERIFICATION') return '';
  return [dealerCode, auditId, partNumber, type].join('::');
}

function countedScanClause() {
  return {
    scanStatus: { $in: COUNTED_SCAN_STATUSES },
    syncStatus: { $nin: EXCLUDED_SYNC_STATUSES },
    isDuplicate: { $ne: true }
  };
}

function partClauses(partNumber) {
  const part = normalizePartNumber(partNumber);
  return [{ normalizedPartNumber: part }, { partNumber: part }, { part }];
}

function scanTypeClauses(type) {
  const normalizedType = scanType({ scanType: type });
  return [{ scanType: normalizedType }, { type: normalizedType }];
}

function businessDuplicateFilter(input = {}) {
  const dealerCode = scanDealerCode(input);
  const auditId = scanAuditId(input);
  const partNumber = scanPartNumber(input);
  const type = scanType(input);
  if (!dealerCode || !auditId || !partNumber || !type || type === 'VERIFICATION') return null;
  return {
    ...countedScanClause(),
    dealerCode,
    auditId,
    $and: [
      { $or: scanTypeClauses(type) },
      { $or: partClauses(partNumber) }
    ]
  };
}

function identityDuplicateFilter(input = {}) {
  const dealerCode = scanDealerCode(input);
  const auditId = scanAuditId(input);
  const type = scanType(input);
  if (type === 'VERIFICATION') return null;
  const raw = rawScanText(input);
  const upi = upper(input.upiNo || input.upiId || input.upiID || '');
  const id = scanIdentityId(input);
  const syncKey = scanSyncKey(input);
  const hash = clean(input.rawUpiHash || rawUpiHash(input));
  const qrFingerprint = clean(input.qrFingerprint);
  const terms = [];
  if (id) terms.push({ uniqueScanId: id }, { scanId: id }, { clientScanId: id });
  if (syncKey) terms.push({ syncKey }, { clientSyncKey: syncKey });
  if (hash) terms.push({ rawUpiHash: hash });
  if (qrFingerprint) terms.push({ qrFingerprint });
  if (raw) terms.push({ rawScan: raw }, { rawScanString: raw }, { rawBarcode: raw }, { rawQR: raw }, { rawUpi: raw });
  if (upi) terms.push({ upiNo: upi }, { upiId: upi });
  if (!terms.length) return null;
  const filter = {
    ...countedScanClause(),
    $and: [{ $or: scanTypeClauses(type) }],
    $or: terms
  };
  if (dealerCode) filter.dealerCode = dealerCode;
  if (auditId) filter.auditId = auditId;
  return filter;
}

module.exports = {
  COUNTED_SCAN_STATUSES,
  EXCLUDED_SYNC_STATUSES,
  DUPLICATE_PART_MESSAGE,
  businessDuplicateFilter,
  businessDuplicateKey,
  identityDuplicateFilter,
  rawUpiHash,
  rawScanText,
  scanAuditId,
  scanDealerCode,
  scanIdentityId,
  scanPartNumber,
  scanSyncKey,
  scanType
};
