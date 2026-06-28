const { createHash } = require('crypto');
const { normalizePartNumber } = require('./normalize');

const COUNTED_SCAN_STATUSES = ['ACCEPTED', 'SUPERVISOR_APPROVED', 'OUTWARD_DONE'];
const EXCLUDED_SYNC_STATUSES = ['duplicate', 'rejected', 'failed', 'deleted'];
const DUPLICATE_PART_MESSAGE = 'This QR code is already scanned.';

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
  if (!allowMultipleLocations) return decision === 'USE_EXISTING_BIN' || decision === 'USE_EXISTING';
  return ['USE_EXISTING', 'USE_EXISTING_BIN', 'SAVE_NEW_BIN', 'CONTINUE_NEW', 'ADD_ADDITIONAL'].includes(decision);
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

function stripStoredBinSuffix(value = '') {
  const text = clean(value);
  const marker = text.indexOf('::');
  return marker > 0 ? text.slice(0, marker) : text;
}

function compactIdentity(value = '') {
  return upper(stripStoredBinSuffix(value));
}

function compactRawIdentity(value = '') {
  return compactIdentity(value).replace(/\s+/g, '');
}

function slashUpiToken(raw = '') {
  const parts = clean(raw).split('/');
  if (parts.length < 6) return '';
  return compactIdentity(parts[1] || '');
}

function slashQrIdentity(raw = '') {
  const text = clean(raw);
  const parts = text.split('/');
  if (parts.length < 6 || !clean(parts[1]) || !clean(parts[3])) return '';
  return compactRawIdentity(text);
}

function directUpiValue(input = {}) {
  const direct = clean(input.upiCode || input.upiNo || input.upiId || input.upiID || input.upiScanId || input.uniqueUpiId || input.transactionId || input.txnId);
  if (/^MANUAL[:|#-]/i.test(direct)) return '';
  const value = compactIdentity(direct);
  const partNumber = scanPartNumber(input);
  if (value && partNumber && value === partNumber) return '';
  return value;
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
  const raw = rawScanText(input);
  const slashIdentity = slashQrIdentity(raw);
  if (slashIdentity) return slashIdentity;

  const direct = directUpiValue(input);
  if (direct) return direct;

  if (!raw) return '';

  const keyed = raw.match(/(?:upi|upid|upiid|txn|txnid|transaction|scanid)\s*[:=#-]?\s*([a-z0-9._/-]+)/i);
  if (keyed) {
    const keyedValue = compactIdentity(keyed[1]);
    const partNumber = scanPartNumber(input);
    if (keyedValue && (!partNumber || keyedValue !== partNumber)) return keyedValue;
  }

  const rawIdentity = compactRawIdentity(raw);
  const partNumber = scanPartNumber(input);
  if (/^MANUAL[:|#-]/i.test(raw)) return '';
  if (rawIdentity && (!partNumber || rawIdentity !== partNumber)) return rawIdentity;
  return '';
}

function globalQrIdentity(input = {}) {
  const raw = rawScanText(input);
  const slashIdentity = slashQrIdentity(raw);
  if (slashIdentity) return { type: 'QR', value: slashIdentity };

  const upi = directUpiValue(input);
  if (upi) return { type: 'UPI', value: upi };

  const keyed = raw.match(/(?:upi|upid|upiid|txn|txnid|transaction|scanid)\s*[:=#-]?\s*([a-z0-9._/-]+)/i);
  if (keyed) {
    const keyedValue = compactIdentity(keyed[1]);
    const partNumber = scanPartNumber(input);
    if (keyedValue && (!partNumber || keyedValue !== partNumber)) return { type: 'UPI', value: keyedValue };
  }

  const partNumber = scanPartNumber(input);
  const rawNormalized = compactRawIdentity(raw);
  if (/^MANUAL[:|#-]/i.test(raw)) return { type: '', value: '' };
  if (raw && rawNormalized && rawNormalized !== partNumber) {
    return { type: 'RAW', value: rawNormalized };
  }
  return { type: '', value: '' };
}

function globalUpiKey(input = {}) {
  const identity = globalQrIdentity(input);
  if (!identity.value) return '';
  const dealerCode = scanDealerCode(input);
  return createHash('sha256').update(`${dealerCode || 'NO-DEALER'}|${identity.type}|${identity.value}`).digest('hex');
}

function activeUpiDuplicateFilter(input = {}) {
  const identity = globalQrIdentity(input);
  const globalKey = clean(input.globalUpiKey || globalUpiKey(input));
  if (!identity.value && !globalKey) return null;
  const terms = [];
  const addUpiTerms = (value = '') => {
    const token = compactIdentity(value);
    if (!token) return;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const upiPattern = `^${escaped}(?:::.+)?$`;
    terms.push(
      { upiCode: { $regex: upiPattern, $options: 'i' } },
      { upiNo: { $regex: upiPattern, $options: 'i' } },
      { upiId: { $regex: upiPattern, $options: 'i' } }
    );
  };
  if (identity.value && identity.type === 'UPI') addUpiTerms(identity.value);
  const raw = rawScanText(input);
  const rawSlashToken = slashUpiToken(raw);
  if (rawSlashToken) addUpiTerms(rawSlashToken);
  if (identity.value && ['QR', 'RAW'].includes(identity.type)) {
    const rawValue = raw ? upper(raw) : identity.value;
    const escapedRaw = rawValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    terms.push(
      { rawScan: { $regex: `^${escapedRaw}$`, $options: 'i' } },
      { rawScanString: { $regex: `^${escapedRaw}$`, $options: 'i' } },
      { rawBarcode: { $regex: `^${escapedRaw}$`, $options: 'i' } },
      { rawQR: { $regex: `^${escapedRaw}$`, $options: 'i' } },
      { rawUpi: { $regex: `^${escapedRaw}$`, $options: 'i' } }
    );
  }
  if (globalKey) terms.push({ globalUpiKey: globalKey });
  const filter = {
    deletedAt: null,
    syncStatus: { $nin: EXCLUDED_SYNC_STATUSES },
    $nor: [{ scanType: 'VERIFICATION' }, { type: 'VERIFICATION' }],
    $or: terms.length ? terms : [{ upiCode: '__NO_UPI__' }]
  };
  const dealerCode = scanDealerCode(input);
  if (dealerCode) filter.dealerCode = dealerCode;
  return filter;
}

function globalUpiDuplicateFilter(input = {}) {
  if (scanType(input) === 'VERIFICATION') return null;
  return activeUpiDuplicateFilter(input);
}

function duplicateUpiMessage(existing = {}) {
  void existing;
  return 'This QR code is already scanned.';
}

function duplicateBinLocation(input = {}) {
  return upper(input.binLocation || input.bin || input.location || '');
}

function sameBinLocation(left = {}, right = {}) {
  const leftBin = duplicateBinLocation(left);
  const rightBin = duplicateBinLocation(right);
  return Boolean(leftBin && rightBin && leftBin === rightBin);
}

function allowCrossBinDuplicate(input = {}) {
  const action = upper(input.smartBinDecision || input.smartBinAction || input.smartBinOverride || '');
  return boolValue(
    input.allowCrossBinDuplicate ||
    input.smartBinAllowCrossBinDuplicate ||
    input.smartBinIsSecondaryLocation ||
    ['SAVE_NEW_BIN', 'CONTINUE_NEW', 'ADD_ADDITIONAL'].includes(action)
  );
}

function duplicateScope(input = {}) {
  return {
    dealerCode: scanDealerCode(input),
    type: scanType(input),
    partNumber: scanPartNumber(input),
    binLocation: duplicateBinLocation(input)
  };
}

function businessDuplicateKey(input = {}) {
  void input;
  return '';
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
  void input;
  return null;
}

function manualBinDuplicateFilter(input = {}) {
  return businessDuplicateFilter(input);
}

function partBinDuplicateFilter(input = {}) {
  return businessDuplicateFilter(input);
}

function partBinDuplicateMessage(existing = {}, input = {}) {
  const partNumber = scanPartNumber(existing) || scanPartNumber(input) || '-';
  const binLocation = upper(existing.binLocation || existing.bin || input.binLocation || input.bin || '') || '-';
  return `Part ${partNumber} is already scanned in bin ${binLocation}.`;
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
  allowCrossBinDuplicate,
  globalQrIdentity,
  globalUpiDuplicateFilter,
  globalUpiKey,
  identityDuplicateFilter,
  manualBinDuplicateFilter,
  partBinDuplicateFilter,
  partBinDuplicateMessage,
  rawUpiHash,
  rawScanText,
  scanAuditId,
  scanDealerCode,
  scanIdentityId,
  scanPartNumber,
  scanSyncKey,
  scanType,
  sameBinLocation,
  smartBinDecisionAllowsDuplicate
};
