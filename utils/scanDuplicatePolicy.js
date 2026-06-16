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

function canonicalUpiValue(input = {}) {
  const direct = clean(input.upiNo || input.upiId || input.upiID || input.upiScanId || input.uniqueUpiId || input.transactionId || input.txnId);
  if (direct) return upper(direct);

  const raw = rawScanText(input);
  if (!raw) return '';
  const slashParts = raw.split('/');
  if (slashParts.length >= 6 && clean(slashParts[1])) return upper(slashParts[1]);

  const keyed = raw.match(/(?:upi|upid|upiid|txn|txnid|transaction|scanid)\s*[:=#-]?\s*([a-z0-9._/-]+)/i);
  return keyed ? upper(keyed[1]) : '';
}

function globalUpiKey(input = {}) {
  const upi = canonicalUpiValue(input);
  if (!upi) return '';
  const scope = [
    scanDealerCode(input),
    scanAuditId(input),
    upi
  ].map((value) => upper(value)).filter(Boolean).join('|');
  return scope ? createHash('sha256').update(scope).digest('hex') : '';
}

function globalUpiDuplicateFilter(input = {}) {
  if (scanType(input) === 'VERIFICATION') return null;
  const key = clean(input.globalUpiKey || globalUpiKey(input));
  const upi = canonicalUpiValue(input);
  if (!key && !upi) return null;
  const dealerCode = scanDealerCode(input);
  const auditId = scanAuditId(input);
  const terms = [];
  if (key) terms.push({ globalUpiKey: key });
  if (upi) terms.push({ upiNo: upi }, { upiId: upi });
  const filter = {
    ...countedScanClause(),
    $or: terms
  };
  if (dealerCode) filter.dealerCode = dealerCode;
  if (auditId) filter.auditId = auditId;
  return filter;
}

function duplicateUpiMessage(existing = {}) {
  const bin = upper(existing.binLocation || existing.bin) || '-';
  const part = scanPartNumber(existing) || '-';
  const rawTime = existing.timestamp || existing.scanTime || existing.createdAt;
  const parsedTime = rawTime ? new Date(rawTime) : null;
  const scannedAt = parsedTime && !Number.isNaN(parsedTime.getTime())
    ? parsedTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true })
    : '-';
  return `This UPI is already scanned in Bin Location: ${bin}, Part No: ${part}, Scanned Date/Time: ${scannedAt}`;
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
    syncStatus: 'synced',
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

function manualBinDuplicateFilter(input = {}) {
  const filter = businessDuplicateFilter(input);
  const binLocation = upper(input.binLocation || input.bin || input.location || '');
  if (!filter || !binLocation) return null;
  filter.$and.push({
    $or: [
      { binLocation },
      { bin: binLocation }
    ]
  });
  return filter;
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
  canonicalUpiValue,
  duplicateUpiMessage,
  globalUpiDuplicateFilter,
  globalUpiKey,
  identityDuplicateFilter,
  manualBinDuplicateFilter,
  rawUpiHash,
  rawScanText,
  scanAuditId,
  scanDealerCode,
  scanIdentityId,
  scanPartNumber,
  scanSyncKey,
  scanType
};
