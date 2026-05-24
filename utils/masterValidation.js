const MasterPart = require('../models/MasterPart');
const MasterCatalogue = require('../models/MasterCatalogue');
const RejectedScan = require('../models/RejectedScan');
const { normalizePartNumber } = require('./normalize');
const { findCataloguePart, cataloguePayload } = require('./catalogue');

function clean(value) {
  return String(value || '').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function normalizeDealerCode(value) {
  const text = clean(value);
  const paren = text.match(/\(([^()]+)\)\s*$/);
  return upper(paren ? paren[1] : text);
}

function scanMode(value, fallback = 'Manual') {
  const text = clean(value || fallback).toLowerCase();
  if (/sync/.test(text)) return 'Sync';
  if (/camera/.test(text)) return 'Camera';
  if (/mobile/.test(text)) return 'Mobile';
  if (/barcode|scanner/.test(text)) return 'Camera';
  return 'Manual';
}

function validScanClause() {
  return {
    $and: [
      {
        $or: [
          { masterFound: true },
          { masterMatch: true },
          { isMasterMatched: true },
          {
            $and: [
              { masterFound: { $ne: false } },
              { masterMatch: { $ne: false } },
              { isMasterMatched: { $ne: false } }
            ]
          }
        ]
      },
      { warnings: { $not: /not\s+found\s+in\s+master|not\s+found\s+in\s+master\s+catalogue/i } },
      { remarks: { $not: /not\s+found\s+in\s+master|not\s+found\s+in\s+master\s+catalogue/i } }
    ]
  };
}

function notInMasterClause() {
  return {
    $or: [
      { masterFound: false },
      { masterMatch: false },
      { isMasterMatched: false },
      { warnings: /not\s+found\s+in\s+master|not\s+found\s+in\s+master\s+catalogue/i },
      { remarks: /not\s+found\s+in\s+master|not\s+found\s+in\s+master\s+catalogue/i }
    ]
  };
}

async function findMasterPart(partNumber, dealerCode = '') {
  const normalizedPartNumber = normalizePartNumber(partNumber);
  if (!normalizedPartNumber) return null;
  const catalogue = await findCataloguePart(normalizedPartNumber);
  if (catalogue) return cataloguePayload(catalogue);
  const code = normalizeDealerCode(dealerCode);
  if (code) {
    const dealerMaster = await MasterPart.findOne({ normalizedPartNumber, dealerCode: code }).lean();
    if (dealerMaster) return dealerMaster;
  }
  return MasterPart.findOne({
    $or: [
      { normalizedPartNumber },
      { partNo: normalizedPartNumber },
      { partNumber: normalizedPartNumber }
    ]
  }).lean();
}

async function validatePartAgainstMaster({ partNumber, dealerCode, rawScannedValue = '', logger = console }) {
  const extractedPartNumber = normalizePartNumber(partNumber);
  if (logger && logger.log) {
    logger.log('RAW_SCAN_RECEIVED', rawScannedValue || extractedPartNumber);
    logger.log('EXTRACTED_PART_NUMBER', extractedPartNumber);
  }
  const master = extractedPartNumber ? await findMasterPart(extractedPartNumber, dealerCode) : null;
  if (logger && logger.log) logger.log('MASTER_MATCH_FOUND', Boolean(master));
  return {
    valid: Boolean(master),
    master,
    extractedPartNumber,
    reason: master ? '' : 'Part not found in master'
  };
}

async function saveRejectedScan(input = {}) {
  const extractedPartNumber = normalizePartNumber(input.extractedPartNumber || input.partNumber || input.part || input.normalizedPartNumber || '');
  const originalScanId = clean(input.originalScanId || input.scanId || input.uniqueScanId || input.syncKey || '');
  const doc = {
    dateTime: input.dateTime || input.timestamp || new Date(),
    dealerCode: normalizeDealerCode(input.dealerCode || input.dealer || ''),
    dealerName: clean(input.dealerName || input.dealer || ''),
    userId: clean(input.userId || input.loginId || input.username || ''),
    loginId: clean(input.loginId || input.username || input.userId || ''),
    userName: clean(input.userName || input.staffName || input.loginId || input.username || ''),
    role: clean(input.role || '').toLowerCase(),
    deviceId: clean(input.deviceId || ''),
    deviceName: clean(input.deviceName || ''),
    scanMode: scanMode(input.scanMode || input.source || input.scanSource, input.defaultScanMode || 'Manual'),
    scanType: upper(input.scanType || input.type || ''),
    rawScannedValue: clean(input.rawScannedValue || input.rawScan || input.rawScanString || input.rawUpi || input.upiNo || input.upiId || ''),
    extractedPartNumber,
    binLocation: upper(input.binLocation || input.bin || ''),
    reason: input.reason || 'Part not found in master',
    status: 'REJECTED',
    syncStatus: 'rejected',
    originalScanId,
    originalInventoryId: input.originalInventoryId || input._id,
    sourceRoute: clean(input.sourceRoute || '')
  };
  if (originalScanId) {
    await RejectedScan.updateOne({ originalScanId }, { $setOnInsert: doc }, { upsert: true });
    return RejectedScan.findOne({ originalScanId }).lean();
  }
  return RejectedScan.create(doc);
}

async function rejectNotInMasterScan(input = {}, logger = console) {
  if (logger && logger.log) logger.log('REJECTED_NOT_IN_MASTER', {
    partNumber: input.extractedPartNumber || input.partNumber || input.part,
    dealerCode: input.dealerCode,
    rawScannedValue: input.rawScannedValue || input.rawScan || input.rawScanString || ''
  });
  return saveRejectedScan(input);
}

module.exports = {
  findMasterPart,
  validatePartAgainstMaster,
  saveRejectedScan,
  rejectNotInMasterScan,
  validScanClause,
  notInMasterClause,
  normalizeDealerCode,
  scanMode
};
