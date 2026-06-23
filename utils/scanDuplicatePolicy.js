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

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return Boolean(fallback);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = clean(value).toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(text)) return false;
  return Boolean(fallback);
}

function scanType(input = {}) {
  const type = upper(input.scanType || input.type || input.action || 'INWARD');
  return type === 'VERIFY' ? 'VERIFICATION' : type;
}

function smartBinDecisionAllowsDuplicate(input = {}) {
  const decision = upper(input.smartBinDecision || input.smartBinAction || input.smartBinOverride || '');
  const allowMultipleLocations = boolValue(input.smartBinAllowMultipleLocations, true);
  if (!allowMultipleLocations) return decision === 'USE_EXISTING';
  return ['USE_EXISTING', 'CONTINUE_NEW', 'ADD_ADDITIONAL'].includes(decision);
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

function activeUpiDuplicateFilter(input = {}) {
  const upi = canonicalUpiValue(input);
  const dealerCode = scanDealerCode(input);
  const auditId = scanAuditId(input);
  const binLocation = upper(input.binLocation || input.bin || input.location || '');
  if (smartBinDecisionAllowsDuplicate(input) && !binLocation) return null;
  const globalKey = clean(input.globalUpiKey || globalUpiKey(input));
  if (!upi && !globalKey) return null;
  const terms = [];
  if (upi) terms.push({ upiCode: upi }, { upiNo: upi }, { upiId: upi });
  if (globalKey) terms.push({ globalUpiKey: globalKey });
  const filter = {
    activeInventory: { $ne: false },
    deletedAt: null,
    $and: [{ $or: [{ movementType: 'INWARD' }, { scanType: 'INWARD' }, { type: 'INWARD' }] }],
    $or: terms.length ? terms : [{ upiCode: '__NO_UPI__' }]
  };
  if (dealerCode) filter.dealerCode = dealerCode;
  if (auditId) filter.auditId = auditId;
  if (binLocation) {
    filter.$and = (filter.$and || []).concat([{
      $or: [
        { binLocation },
        { bin: binLocation }
      ]
    }]);
  }
  return filter;
}

function globalUpiDuplicateFilter(input = {}) {
  if (scanType(input) !== 'INWARD') return null;
  return activeUpiDuplicateFilter(input);
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
  const id = scanIdentityId(input);
  const syncKey = scanSyncKey(input);
  const terms = [];
  if (id) terms.push({ uniqueScanId: id }, { scanId: id }, { clientScanId: id });
  if (syncKey) terms.push({ syncKey }, { clientSyncKey: syncKey });
  if (!terms.length) return null;
  const filter = { $or: terms };
  if (dealerCode) filter.dealerCode = dealerCode;
  if (auditId) filter.auditId = auditId;
  return filter;
}

module.exports = {
  COUNTED_SCAN_STATUSES,
  EXCLUDED_SYNC_STATUSES,
  DUPLICATE_PART_MESSAGE,
  activeUpiDuplicateFilter,
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
  scanType,
  smartBinDecisionAllowsDuplicate
};
