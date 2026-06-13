const express = require('express');
const ExcelJS = require('exceljs');
const { randomUUID } = require('crypto');
const Inventory = require('../models/Inventory');
const Bin = require('../models/Bin');
const MasterPart = require('../models/MasterPart');
const MasterCatalogue = require('../models/MasterCatalogue');
const Dealer = require('../models/Dealer');
const Audit = require('../models/Audit');
const Device = require('../models/Device');
const BluetoothDevice = require('../models/BluetoothDevice');
const BluetoothScanLog = require('../models/BluetoothScanLog');
const DeletedScanLog = require('../models/DeletedScanLog');
const DuplicateScanLog = require('../models/DuplicateScanLog');
const VerificationLog = require('../models/VerificationLog');
const AuditLog = require('../models/AuditLog');
const auth = require('./auth');
const { normalizePartNumber } = require('../utils/normalize');
const { findCataloguePart, cataloguePayload } = require('../utils/catalogue');
const { makeQrFingerprint, isDuplicateKeyError } = require('../utils/scanIdentity');
const masterValidation = require('../utils/masterValidation');
const { getActiveAudit, isCompletedAudit, publicAudit } = require('../utils/audit');
const { dateDebugPayload, formatIstDateTime, parseIstFilterDate, validDate } = require('../utils/time');
const { decorateScanValue, money } = require('../utils/inventoryValueEngine');
const { findPricePeriod, pricePeriodPayload } = require('../utils/priceHistory');
const { uniqueReportScans } = require('../utils/reportScanIdentity');
const { reportTotals } = require('../utils/reportTotals');
const duplicatePolicy = require('../utils/scanDuplicatePolicy');

const router = express.Router();
const VALID_TYPES = ['AUDIT', 'INWARD', 'OUTWARD', 'VERIFICATION', 'FITTED', 'DAMAGE'];
const BIN_REQUIRED_MESSAGE = 'Please enter/select bin location first.';
const NO_OUTWARD_STOCK_MESSAGE = 'Part not available in inward stock.';
const VERIFICATION_FOUND_MESSAGE = 'Part Found';
const VERIFICATION_NOT_FOUND_MESSAGE = 'Part Not Found';
const SCAN_VERBOSE_LOGS = process.env.SCAN_VERBOSE_LOGS === 'true';
const realtimeRefreshDelay = Number(process.env.REALTIME_SCAN_REFRESH_DELAY_MS || 900);
const REALTIME_SCAN_REFRESH_DELAY_MS = Number.isFinite(realtimeRefreshDelay) && realtimeRefreshDelay >= 100
  ? realtimeRefreshDelay
  : 900;

/**
 * ====================================================================
 * INVENTORY ROUTE - DASHBOARD & STATISTICS COMPLIANCE
 * ====================================================================
 *
 * DASHBOARD STATS CALCULATION:
 *   totalScannedValue = SUM of finalInventoryValue from all records
 *
 * WHERE finalInventoryValue must be:
 *   - Calculated using decorateScanValue() from inventoryValueEngine.js
 *   - Based on scanned MRP or manual entered MRP only
 *   - NOT based on master MRP or current catalogue MRP
 *
 * CRITICAL:
 *   - dashboardStats() reads finalInventoryValue from database records
 *   - Each record already has finalInventoryValue calculated at save time
 *   - aggregation does NOT recalculate, only sums existing values
 *   - This ensures dashboard total == report total
 *
 * ====================================================================
 */
let bluetoothScanQueue = Promise.resolve();
const realtimeDashboardTimers = new Map();

function scanDebug(...args) {
  if (SCAN_VERBOSE_LOGS) void args;
}

function clean(value) {
  return String(value || '').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function normalizeScanType(value) {
  const type = upper(value || 'INWARD');
  if (type === 'VERIFY') return 'VERIFICATION';
  return type;
}

function rawIdentity(input = {}) {
  return String(input.rawScanString || input.rawScan || input.rawBarcode || input.rawQR || input.rawUpi || input.upiNo || input.upiId || '').trim();
}

function acceptedStatuses() {
  return ['ACCEPTED', 'SUPERVISOR_APPROVED', 'OUTWARD_DONE'];
}

function nonVerificationScanClause() {
  return { $nor: [{ scanType: 'VERIFICATION' }, { type: 'VERIFICATION' }] };
}

function applyTransactionScanFilter(filter = {}) {
  filter.$and = (filter.$and || []).concat([nonVerificationScanClause()]);
  return filter;
}

function normalizeCategory(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const acronyms = new Set(['HDX', 'HHML', 'B2S2', 'HGP', 'HGO']);
  return text.split(' ').map((word) => {
    const upperWord = word.toUpperCase();
    if (acronyms.has(upperWord)) return upperWord;
    if (/^[A-Z0-9]+$/.test(word) || /^[a-z0-9]+$/.test(word)) return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    return word;
  }).join(' ');
}

function normalizeDealerCode(value) {
  const text = String(value || '').trim();
  const paren = text.match(/\(([^()]+)\)\s*$/);
  if (paren) return upper(paren[1]);
  const dash = text.match(/^([A-Za-z0-9_]{3,})\s+-\s+.+$/);
  return upper(dash ? dash[1] : text);
}

async function findMasterPart(partNumber, dealerCode = '') {
  return masterValidation.findMasterPart(partNumber, dealerCode);
}

function scanIdentity(input, parsed) {
  const explicit = input.scanId || input.uniqueScanId || input.mobileScanId || input.localId;
  if (explicit) {
    return String(explicit).trim();
  }
  return randomUUID();
}

function firstValue(input = {}, keys = []) {
  for (const key of keys) {
    const value = input[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

function sourceLooksManual(input = {}) {
  const source = String(input.source || input.scanMode || '').trim().toLowerCase();
  return !source || /manual/.test(source);
}

function extractUpiId(input, parsed) {
  if (parsed && (parsed.upiNo || parsed.upiId)) return String(parsed.upiNo || parsed.upiId).trim();
  const direct = input.upiId || input.upiID || input.upiScanId || input.uniqueUpiId || input.transactionId || input.txnId;
  if (direct) return String(direct).trim();
  const raw = String(firstValue(input, ['rawScan', 'rawScanString', 'rawBarcode', 'rawScanValue', 'barcode', 'barcodeValue', 'scanValue', 'scanText']) || (parsed && parsed.rawScan) || '');
  const match = raw.match(/(?:upi|upid|upiid|txn|txnid|transaction|scanid)\s*[:=#-]?\s*([a-z0-9._/-]+)/i);
  return match ? match[1].trim() : '';
}

function buildSyncKey({ dealerCode, upiId, partNumber, scanType, timestamp }) {
  const time = timestamp instanceof Date ? timestamp.toISOString() : new Date(timestamp || Date.now()).toISOString();
  return [dealerCode || 'NO-DEALER', upiId || 'NO-UPI', partNumber || 'NO-PART', scanType || 'INWARD', time]
    .map((value) => String(value).trim().toUpperCase().replace(/\s+/g, '_'))
    .join('|');
}

function scanTimestamp(item = {}) {
  const raw = firstValue(item, [
    'timestamp',
    'scanTime',
    'scannedAt',
    'scanDateTime',
    'dateTime',
    'createdAt',
    'localCreatedAt',
    'localTimestamp'
  ]);
  if (!raw) return new Date();
  const parsed = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function duplicateScanFilter(uniqueScanId, qrFingerprint, dealerCode = '', rawScan = '', upiNo = '', binLocation = '', auditId = '', userKey = '', scanType = '') {
  const terms = [];
  const raw = String(rawScan || '').trim();
  const upi = upper(upiNo);
  const dealer = normalizeDealerCode(dealerCode);
  const audit = String(auditId || '').trim();
  const type = upper(scanType);
  if (raw) terms.push({ rawScan: raw }, { rawScanString: raw }, { rawBarcode: raw }, { rawQR: raw }, { rawUpi: raw });
  if (upi) terms.push({ upiNo: upi }, { upiId: upi });
  if (qrFingerprint) terms.push({ qrFingerprint });
  if (!terms.length && uniqueScanId) terms.push({ uniqueScanId: String(uniqueScanId).trim() }, { scanId: String(uniqueScanId).trim() });
  if (!terms.length) return null;
  const filter = {
    scanStatus: { $in: acceptedStatuses() },
    syncStatus: { $nin: ['duplicate', 'rejected', 'failed', 'deleted'] },
    isDuplicate: { $ne: true },
    $or: terms
  };
  if (dealer) filter.dealerCode = dealer;
  if (audit) filter.auditId = audit;
  if (type) filter.scanType = type;
  return filter;
}

function duplicateLookupPayload(input = {}) {
  const partNumber = normalizePartNumber(input.partNumber || input.part || input.normalizedPartNumber || '');
  const dealerCode = normalizeDealerCode(input.dealerCode || input.dealer || '');
  const auditId = String(input.auditId || '').trim();
  const scanType = normalizeScanType(input.scanType || input.type || 'INWARD');
  const rawScan = String(input.rawScan || input.rawScanString || input.rawBarcode || input.rawQR || input.rawUpi || '').trim();
  const rawUpiHash = duplicatePolicy.rawUpiHash({
    ...input,
    partNumber,
    dealerCode,
    auditId,
    scanType,
    rawScanString: rawScan
  });
  return {
    ...input,
    partNumber,
    part: partNumber,
    normalizedPartNumber: partNumber,
    dealerCode,
    auditId,
    scanType,
    type: scanType,
    rawScan,
    rawScanString: rawScan,
    rawUpiHash
  };
}

async function findBackendDuplicate(input = {}, options = {}) {
  const payload = duplicateLookupPayload(input);
  if (payload.scanType === 'VERIFICATION') return null;
  const identityFilter = duplicatePolicy.identityDuplicateFilter(payload);
  const businessFilter = options.skipBusinessRule ? null : duplicatePolicy.businessDuplicateFilter(payload);
  const existing = identityFilter ? await Inventory.findOne(identityFilter).sort({ timestamp: 1, createdAt: 1 }).lean() : null;
  if (existing) {
    return {
      existing,
      reason: 'Duplicate exact UPI/barcode or scan id',
      message: 'Duplicate exact UPI/barcode already scanned.'
    };
  }
  const businessDuplicate = businessFilter ? await Inventory.findOne(businessFilter).sort({ timestamp: 1, createdAt: 1 }).lean() : null;
  if (businessDuplicate) {
    return {
      existing: businessDuplicate,
      reason: duplicatePolicy.DUPLICATE_PART_MESSAGE,
      message: duplicatePolicy.DUPLICATE_PART_MESSAGE
    };
  }
  return null;
}

function fittedIdentityFilter({ dealerCode, partNumber, regdNo, jobCardNo } = {}) {
  const dealer = normalizeDealerCode(dealerCode);
  const part = normalizePartNumber(partNumber);
  const regd = upper(regdNo);
  const job = upper(jobCardNo);
  if (!dealer || !part || !regd || !job) return null;
  const filter = {
    dealerCode: dealer,
    scanType: 'FITTED',
    regdNo: regd,
    jobCardNo: job,
    scanStatus: { $in: acceptedStatuses() },
    syncStatus: { $nin: ['duplicate', 'rejected', 'failed'] },
    isDuplicate: { $ne: true },
    $or: [{ normalizedPartNumber: part }, { partNumber: part }, { part }]
  };
  return filter;
}

function prepareFittedScan(scan = {}, qty = 0) {
  scan.binLocation = '';
  scan.bin = '';
  scan.binSelectionMode = '';
  scan.autoDetectedBin = false;
  scan.isFitted = true;
  scan.fittedQty = Number(qty || scan.quantity || scan.qty || 1);
  scan.fittedLocation = 'VEHICLE';
  scan.status = 'FITTED_ON_VEHICLE';
  scan.stockDeductedFromBin = '';
  return scan;
}

function numberValue(value, fallback = 0) {
  const parsed = Number(String(value === undefined || value === null || value === '' ? fallback : value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanFlag(value) {
  return value === true || String(value).toLowerCase() === 'true' || value === 1 || value === '1';
}

function valuationFields({ rawScanText = '', scannedMrp, mrpProvided = false, entrySource = '', manualEntryMode = false } = {}) {
  const valued = decorateScanValue({
    rawScan: rawScanText,
    rawScanString: rawScanText,
    source: manualEntryMode ? 'manual' : entrySource,
    scanMode: manualEntryMode ? 'Manual' : entrySource,
    scanMRP: !manualEntryMode && mrpProvided ? scannedMrp : undefined,
    manualMRP: manualEntryMode && mrpProvided ? scannedMrp : undefined
  });
  return {
    mrp: Number(valued.valuationMRP || 0),
    scanMRP: Number(valued.scanMRP || 0),
    manualMRP: Number(valued.manualMRP || 0),
    valuationMRP: Number(valued.valuationMRP || 0),
    valuationSource: valued.valuationSource || 'NO_SCANNED_OR_MANUAL_MRP',
    finalInventoryValue: Number(valued.finalInventoryValue || 0)
  };
}

function existingHasPositiveMrp(scan = {}) {
  return [
    scan.finalMRP,
    scan.finalMrp,
    scan.valuationMRP,
    scan.valuationMrp,
    scan.scanMRP,
    scan.scanMrp,
    scan.manualMRP,
    scan.manualMrp,
    scan.mrp
  ].some((value) => Number(value || 0) > 0);
}

async function backfillDuplicateMrp(existing = {}, { partNumber = '', rawScanText = '', scannedMrp, mrpProvided = false, entrySource = 'barcode', manualEntryMode = false, qty = 1, timestamp = new Date() } = {}) {
  if (!existing || !existing._id || existingHasPositiveMrp(existing) || !mrpProvided || !(Number(scannedMrp || 0) > 0)) return existing;
  const valueFields = valuationFields({ rawScanText, scannedMrp, mrpProvided, entrySource, manualEntryMode });
  if (!(Number(valueFields.valuationMRP || 0) > 0)) return existing;
  const pricePeriod = await findPricePeriod(partNumber || existing.partNumber || existing.part, timestamp, valueFields.valuationMRP).catch(() => null);
  const quantity = Number(existing.quantity || existing.qty || qty || 1);
  const update = {
    mrp: valueFields.mrp,
    scanMRP: valueFields.scanMRP,
    manualMRP: valueFields.manualMRP,
    valuationMRP: valueFields.valuationMRP,
    valuationSource: valueFields.valuationSource,
    finalInventoryValue: Number(quantity || 0) * Number(valueFields.valuationMRP || 0),
    finalMRP: valueFields.valuationMRP,
    mrpStatus: 'AVAILABLE',
    mrpPendingUpdatedAt: timestamp,
    ...pricePeriodPayload(pricePeriod, valueFields.valuationMRP)
  };
  await Inventory.updateOne({ _id: existing._id }, { $set: update });
  return { ...existing, ...update };
}

const DASHBOARD_BLANK_MARKERS = ['', 'NULL', 'UNDEFINED', 'N/A', 'NA', '-'];

function firstNonBlankExpression(fields = [], fallback = '') {
  return fields.reduceRight((next, field) => ({
    $let: {
      vars: {
        value: {
          $trim: {
            input: { $toString: { $ifNull: [`$${field}`, ''] } }
          }
        }
      },
      in: {
        $cond: [
          { $in: [{ $toUpper: '$$value' }, DASHBOARD_BLANK_MARKERS] },
          next,
          '$$value'
        ]
      }
    }
  }), fallback);
}

function numberExpression(fields = []) {
  return {
    $convert: {
      input: firstNonBlankExpression(fields, '0'),
      to: 'double',
      onError: 0,
      onNull: 0
    }
  };
}

function scanRawText(scan = {}) {
  return String(scan.rawScan || scan.rawScanString || scan.rawUpi || '').trim();
}

function approxMismatch(a, b) {
  const left = optionalNumber(a);
  const right = optionalNumber(b);
  if (left === undefined || right === undefined) return false;
  return Math.abs(left - right) > 0.01;
}

function shouldComparePrice(payload = {}, field) {
  const value = optionalNumber(payload[field]);
  return value !== undefined && booleanFlag(payload[`${field}Provided`]);
}

function getFirst(data, keys) {
  for (const key of keys) {
    const value = data[key.toLowerCase()];
    if (value !== undefined && value !== '') return value;
  }
  return '';
}

function parseKeyValueText(rawScan) {
  const data = {};
  const raw = String(rawScan || '');
  const pairs = raw.match(/[a-zA-Z][a-zA-Z0-9 _-]{0,24}\s*[:=]\s*[^|,;\n\r]+/g) || [];
  pairs.forEach((pair) => {
    const splitAt = pair.search(/[:=]/);
    const key = pair.slice(0, splitAt).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const value = pair.slice(splitAt + 1).trim();
    data[key] = value;
  });
  return data;
}

function parseQueryLikeText(rawScan) {
  const data = {};
  const raw = String(rawScan || '').trim();

  try {
    const parsedUrl = new URL(raw);
    parsedUrl.searchParams.forEach((value, key) => {
      data[key.toLowerCase().replace(/[^a-z0-9]/g, '')] = value;
    });
  } catch (error) {
    const normalized = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : raw;
    const params = new URLSearchParams(normalized.replace(/[|;]/g, '&'));
    params.forEach((value, key) => {
      data[key.toLowerCase().replace(/[^a-z0-9]/g, '')] = value;
    });
  }

  return data;
}

function parseRawScan(rawScan) {
  const raw = String(rawScan || '').trim();
  const slashParts = raw.split('/');
  if (slashParts.length >= 6 && slashParts[3] && slashParts[4] && slashParts[5]) {
    const slashQty = optionalNumber(slashParts[4]);
    const slashMrp = optionalNumber(slashParts[5]);
    return {
      upiNo: upper(slashParts[1]),
      upiId: upper(slashParts[1]),
      part: upper(slashParts[3]).replace(/\s+/g, ''),
      qty: slashQty !== undefined ? slashQty : 1,
      mrp: slashMrp,
      mrpProvided: slashMrp !== undefined,
      dlc: undefined,
      dlcProvided: false,
      bin: '',
      dealerCode: '',
      auditId: '',
      staffName: '',
      userName: '',
      type: '',
      rawScan: raw
    };
  }
  const queryData = parseQueryLikeText(raw);
  const kvData = parseKeyValueText(raw);
  const data = { ...queryData, ...kvData };
  const simpleTokens = raw.split(/[|,;\n\r\t ]+/).filter(Boolean);

  let part = upper(getFirst(data, ['partno', 'partnumber', 'part', 'pn', 'sku', 'item', 'p']));
  if (!part) {
    const partMatch = raw.match(/(?:part\s*no|part|pn|sku)\s*[:=#-]?\s*([a-z0-9._/-]+)/i);
    part = upper(partMatch ? partMatch[1] : '');
  }
  if (!part && simpleTokens.length === 1) {
    part = upper(simpleTokens[0]);
  }

  const qty = numberValue(getFirst(data, ['qty', 'quantity', 'q']), undefined);
  const mrpRaw = getFirst(data, ['mrp', 'price']);
  const dlcRaw = getFirst(data, ['dlc', 'cost', 'dealerprice']);
  const mrp = optionalNumber(mrpRaw);
  const dlc = optionalNumber(dlcRaw);
  const bin = String(getFirst(data, ['bin', 'binlocation', 'location', 'rack']) || '').trim();
  const dealerCode = upper(getFirst(data, ['dealercode', 'dealer', 'dc']));
  const auditId = String(getFirst(data, ['auditid', 'audit', 'auditno', 'auditnumber']) || '').trim();
  const staffName = String(getFirst(data, ['staffname', 'staff', 'username', 'user', 'operator', 'scannedby']) || '').trim();
  const scanTypeText = upper(getFirst(data, ['type', 'scantype', 'movement']));
  const type = VALID_TYPES.includes(scanTypeText) ? scanTypeText : '';
  const upiNo = upper(getFirst(data, ['upino', 'upi', 'upiid', 'serial', 'sequence']));

  return {
    part,
    upiNo,
    upiId: upiNo,
    qty,
    mrp,
    mrpProvided: mrp !== undefined,
    dlc,
    dlcProvided: dlc !== undefined,
    bin,
    dealerCode,
    auditId,
    staffName,
    userName: staffName,
    type,
    rawScan: raw
  };
}

function isValidPartNumber(value) {
  const part = normalizePartNumber(value);
  return /^[A-Z0-9][A-Z0-9._/-]{2,39}$/.test(part) && !/^UPI$/i.test(part);
}

function normalizeSource(value, fallback = 'manual') {
  const source = String(value || fallback).trim().toLowerCase();
  if (/manual/.test(source)) return 'manual';
  if (/bluetooth/.test(source)) return 'bluetooth_scanner';
  if (/ocr|ai/.test(source)) return 'ocr_label';
  if (/^qr$|qr[_\s-]*scan/.test(source)) return 'qr';
  if (/barcode/.test(source)) return 'barcode';
  if (/camera|mobile/.test(source)) return 'mobile';
  if (['manual', 'scanner', 'bluetooth_scanner', 'import', 'api', 'ocr_label', 'qr'].includes(source)) return source;
  return fallback;
}

function isManualEntryMode(input = {}, rawScanText = '', upiId = '', defaultSource = 'manual') {
  const sourceText = firstValue(input, ['entryMode', 'scanMode', 'scanSource', 'source']);
  const fallback = rawScanText || upiId ? 'barcode' : defaultSource;
  return normalizeSource(sourceText, fallback) === 'manual';
}

function sourceLabels(scan = {}) {
  const source = normalizeSource(scan.source || scan.scanSource || '', '');
  const deviceId = String(scan.deviceId || '').trim().toUpperCase();
  const channel = source === 'bluetooth_scanner'
    ? 'Bluetooth'
    : deviceId.startsWith('MOB-') || ['mobile', 'camera', 'qr', 'ocr_label'].includes(source)
    ? 'Mobile'
    : deviceId.startsWith('WEB-') || ['manual', 'barcode', 'scanner'].includes(source)
      ? 'Web'
      : 'Server';
  const entryMode = source === 'manual'
    ? 'Manual Entry'
    : source === 'bluetooth_scanner'
      ? 'Bluetooth Scanner'
    : source === 'ocr_label'
      ? 'OCR Label Scan'
      : ['barcode', 'scanner', 'qr', 'mobile', 'camera'].includes(source)
        ? 'Barcode/QR Scan'
        : 'System/API';
  return {
    entryMode,
    entryChannel: channel,
    scanSourceLabel: `${channel} ${entryMode}`
  };
}

function buildListQuery(query) {
  const filter = {};
  if (query.dealerCode) filter.dealerCode = normalizeDealerCode(query.dealerCode);
  if (query.auditId) filter.auditId = String(query.auditId).trim();
  if (query.category) filter.category = String(query.category).trim();
  if (query.type) filter.type = upper(query.type);

  const from = parseFilterDate(query.from);
  const to = parseFilterDate(query.to, true);
  if (from || to) {
    filter.timestamp = {};
    if (from && !Number.isNaN(from.getTime())) filter.timestamp.$gte = from;
    if (to && !Number.isNaN(to.getTime())) filter.timestamp.$lte = to;
  }
  return filter;
}

function parseFilterDate(value, endOfDay = false) {
  return parseIstFilterDate(value, endOfDay);
}

function testScanClause() {
  return {
    $or: [
      { dealerName: /Sync Test/i },
      { deviceId: /sync-test/i },
      { deviceName: /sync-test/i },
      { rawUpi: /SYNCPT|scan test/i },
      { rawScan: /SYNCPT|scan test/i },
      { rawScanString: /SYNCPT|scan test/i },
      { staffName: /sync test|test sync/i },
      { partName: /Sync Test/i },
      { partDescription: /Sync Test/i }
    ]
  };
}

function applyTestScanMode(filter = {}, mode = 'real') {
  const selected = String(mode || 'real').trim().toLowerCase();
  const clauses = [nonVerificationScanClause()];
  if (selected !== 'all') clauses.push(selected === 'test' ? testScanClause() : { $nor: testScanClause().$or });
  clauses.push(
    masterValidation.validScanClause()
  );
  filter.$and = (filter.$and || []).concat(clauses);
  return filter;
}

async function activeDashboardScope(query = {}) {
  const filter = {};
  const requestedDealerCode = normalizeDealerCode(query.dealerCode || query.dealer || '');
  const requestedAuditId = clean(query.auditId || query.audit || '');
  if (requestedDealerCode && requestedDealerCode !== 'ALL') filter.dealerCode = requestedDealerCode;
  if (requestedAuditId) filter.auditId = requestedAuditId;

  const activeAudit = await getActiveAudit(filter.dealerCode ? { dealerCode: filter.dealerCode } : {});
  if (!filter.dealerCode && activeAudit && activeAudit.dealerCode) {
    filter.dealerCode = normalizeDealerCode(activeAudit.dealerCode);
  }
  if (!filter.auditId && activeAudit && activeAudit.auditId) {
    filter.auditId = clean(activeAudit.auditId);
  }

  return {
    filter,
    activeAudit: activeAudit ? publicAudit(activeAudit) : null
  };
}

function scanDashboardScope(scan = {}) {
  const filter = {};
  const dealerCode = normalizeDealerCode(scan.dealerCode || '');
  const auditId = clean(scan.auditId || '');
  if (dealerCode) filter.dealerCode = dealerCode;
  if (auditId) filter.auditId = auditId;
  return filter;
}

function stampDashboardScope(stats = {}, filter = {}) {
  stats.dealerCode = filter.dealerCode || '';
  stats.auditId = filter.auditId || '';
  return stats;
}

async function dashboardStats(filter) {
  filter = applyTestScanMode({ ...(filter || {}) }, 'real');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const activeUserFilter = { ...filter, timestamp: { ...(filter.timestamp || {}), $gte: new Date(Date.now() - 30 * 1000) }, userId: { $nin: [null, ''] } };
  const liveCutoff = new Date(Date.now() - 30 * 1000);

  const duplicateFilter = {};
  if (filter.dealerCode) duplicateFilter.dealerCode = filter.dealerCode;
  if (filter.auditId) duplicateFilter.auditId = filter.auditId;
  if (filter.timestamp) duplicateFilter.timestamp = filter.timestamp;

  const [rawRecords, activeDevices, activeUsers, duplicateCount] = await Promise.all([
    Inventory.find(filter).select('qty quantity mrp scanMRP manualMRP valuationMRP valuationSource finalInventoryValue type scanType source scanMode entryMode synced isSynced warnings part partNumber normalizedPartNumber rawScan rawScanString rawBarcode rawQR rawUpi upiNo upiId qrFingerprint dealerCode auditId scanId uniqueScanId syncKey category productCategory timestamp createdAt').lean(),
    Device.countDocuments({ status: 'online', lastSeen: { $gte: liveCutoff } }),
    Inventory.distinct('userId', activeUserFilter),
    DuplicateScanLog.countDocuments(duplicateFilter)
  ]);
  const records = uniqueReportScans(rawRecords);
  const recentRecords = records.slice().sort((a, b) => new Date(b.timestamp || b.createdAt || 0) - new Date(a.timestamp || a.createdAt || 0));
  const todayCount = uniqueReportScans(rawRecords.filter((record) => new Date(record.timestamp || record.createdAt || 0) >= today)).length;
  const lastScan = recentRecords[0] || null;
  const last10Scans = recentRecords.slice(0, 10);
  const uniqueParts = new Set();
  const categoryWiseScannedCount = {};

  const stats = {
    totalUniqueScannedParts: 0,
    totalScanRecords: records.length,
    totalScannedQuantity: 0,
    categoryWiseScannedCount,
    last10Scans: last10Scans.map(publicScan),
    totalScannedToday: todayCount,
    totalInward: 0,
    totalOutward: 0,
    fittedCount: 0,
    auditCount: 0,
    damageCount: 0,
    activeDevices,
    activeUsers: activeUsers.length,
    pendingSync: 0,
    duplicateCount,
    mismatchCount: 0,
    totalScannedValue: 0,
    lastScanTime: lastScan ? lastScan.timestamp : null,
    lastScannedPart: lastScan ? lastScan.partNumber || lastScan.part : ''
  };

  records.forEach((record) => {
    const scan = publicScan(record);
    const qty = Number(scan.qty || 0);
    if (scan.partNumber) uniqueParts.add(scan.partNumber);
    const category = scan.productCategory || scan.category || 'UNKNOWN';
    categoryWiseScannedCount[category] = (categoryWiseScannedCount[category] || 0) + 1;
    stats.totalScannedQuantity += qty;
    if (scan.type === 'INWARD') stats.totalInward += qty;
    if (scan.type === 'OUTWARD') stats.totalOutward += qty;
    if (scan.type === 'FITTED') stats.fittedCount += qty;
    if (scan.type === 'AUDIT') stats.auditCount += qty;
    if (scan.type === 'DAMAGE') stats.damageCount += qty;
    if (!record.synced) stats.pendingSync += 1;
    if ((record.warnings || []).some((warning) => /mismatch|inactive|not found/i.test(warning))) stats.mismatchCount += 1;
    stats.totalScannedValue += Number(scan.finalInventoryValue || 0);
  });
  stats.totalUniqueScannedParts = uniqueParts.size;

  return stats;
}

function masterPartNumber(record = {}) {
  return normalizePartNumber(record.normalizedPartNumber || record.partNumber || record.partNo || record.part || '');
}

async function masterLookupForScans(scans = []) {
  const partNumbers = Array.from(new Set(scans.map(masterPartNumber).filter(Boolean)));
  if (!partNumbers.length) {
    return { byPart: new Map(), byDealer: new Map(), catalogueParts: new Set() };
  }

  const [catalogues, legacyMasters] = await Promise.all([
    MasterCatalogue.find({ normalizedPartNumber: { $in: partNumbers } }).lean(),
    MasterPart.find({
      $or: [
        { normalizedPartNumber: { $in: partNumbers } },
        { partNo: { $in: partNumbers } },
        { partNumber: { $in: partNumbers } }
      ]
    }).lean()
  ]);

  const byPart = new Map();
  const byDealer = new Map();
  const catalogueParts = new Set();

  catalogues.forEach((row) => {
    const payload = cataloguePayload(row);
    const partNo = masterPartNumber(payload);
    if (!partNo) return;
    byPart.set(partNo, payload);
    catalogueParts.add(partNo);
  });

  legacyMasters.forEach((row) => {
    const payload = cataloguePayload(row);
    const partNo = masterPartNumber(payload);
    if (!partNo) return;
    const code = normalizeDealerCode(row.dealerCode);
    if (code) byDealer.set(`${partNo}::${code}`, payload);
    if (!byPart.has(partNo)) byPart.set(partNo, payload);
  });

  return { byPart, byDealer, catalogueParts };
}

function masterForScan(scan = {}, lookup = {}) {
  const partNo = masterPartNumber(scan);
  if (!partNo) return null;
  const byPart = lookup.byPart || new Map();
  const byDealer = lookup.byDealer || new Map();
  const catalogueParts = lookup.catalogueParts || new Set();
  if (catalogueParts.has(partNo)) return byPart.get(partNo) || null;
  const code = normalizeDealerCode(scan.dealerCode);
  return (code ? byDealer.get(`${partNo}::${code}`) : null) || byPart.get(partNo) || null;
}

async function dashboardProductGroupSummary({ limit = 100, q = '', filter = {} } = {}) {
  const search = String(q || '').trim();
  const regex = search ? new RegExp(escapeRegex(search), 'i') : null;
  const records = await Inventory.find(applyTestScanMode({ ...(filter || {}) }, 'real'))
    .select('part partNumber normalizedPartNumber dealerCode auditId productGroup partGroup productCategory category partSubGroup productSubGroup productType qty quantity mrp scanMRP manualMRP valuationMRP valuationSource finalInventoryValue rawScan rawScanString rawBarcode rawQR rawUpi upiNo upiId qrFingerprint scanId uniqueScanId syncKey source scanMode entryMode dlc timestamp createdAt')
    .lean();
  const scans = uniqueReportScans(records.map(publicScan));
  const masterLookup = await masterLookupForScans(scans);
  const groups = new Map();
  scans.forEach((scan) => {
    const master = masterForScan(scan, masterLookup) || {};
    const productGroup = clean(master.productGroup || scan.productGroup || scan.partGroup || scan.productCategory || scan.category || 'OTHERS') || 'OTHERS';
    const partSubGroup = clean(master.partSubGroup || scan.partSubGroup || scan.productSubGroup || scan.productType || 'GENERAL') || 'GENERAL';
    if (regex && !regex.test(productGroup) && !regex.test(partSubGroup)) return;
    const key = `${productGroup}::${partSubGroup}`;
    const group = groups.get(key) || {
      productGroup,
      partSubGroup,
      totalScans: 0,
      scanCount: 0,
      totalQuantity: 0,
      qty: 0,
      uniquePartSet: new Set(),
      totalMrpValue: 0,
      totalDlcValue: 0
    };
    const qty = Number(scan.qty || 0);
    group.totalScans += 1;
    group.scanCount = group.totalScans;
    group.totalQuantity += qty;
    group.qty = group.totalQuantity;
    if (scan.partNumber) group.uniquePartSet.add(scan.partNumber);
    group.totalMrpValue += Number(scan.finalInventoryValue || 0);
    group.totalDlcValue += qty * Number(master.dlc !== undefined ? master.dlc : scan.dlc || 0);
    groups.set(key, group);
  });
  const rows = Array.from(groups.values()).map((row) => {
    const uniqueParts = row.uniquePartSet.size;
    delete row.uniquePartSet;
    return { ...row, uniqueParts, totalMrpValue: money(row.totalMrpValue), totalDlcValue: money(row.totalDlcValue) };
  }).sort((a, b) => Number(b.totalQuantity || 0) - Number(a.totalQuantity || 0) || Number(b.totalScans || 0) - Number(a.totalScans || 0) || String(a.productGroup).localeCompare(String(b.productGroup)) || String(a.partSubGroup).localeCompare(String(b.partSubGroup)));
  return limit && Number(limit) > 0 ? rows.slice(0, Math.min(Number(limit), 5000)) : rows;
}

async function dashboardProductGroupDetails({ productGroup = '', partSubGroup = '', filter = {} } = {}) {
  const group = String(productGroup || 'OTHERS').trim() || 'OTHERS';
  const subGroup = String(partSubGroup || 'GENERAL').trim() || 'GENERAL';
  const records = await Inventory.find(applyTestScanMode({ ...(filter || {}) }, 'real'))
    .select('part partNumber normalizedPartNumber dealerCode auditId partDescription partName productGroup partGroup productCategory category partSubGroup productSubGroup productType binLocation bin qty quantity mrp scanMRP manualMRP valuationMRP valuationSource finalInventoryValue rawScan rawScanString rawBarcode rawQR rawUpi upiNo upiId qrFingerprint scanId uniqueScanId syncKey source scanMode entryMode timestamp createdAt')
    .lean();
  const scans = uniqueReportScans(records.map(publicScan));
  const masterLookup = await masterLookupForScans(scans);
  const groups = new Map();
  scans.forEach((scan) => {
    const master = masterForScan(scan, masterLookup) || {};
    const productGroupText = clean(master.productGroup || scan.productGroup || scan.partGroup || scan.productCategory || scan.category || 'OTHERS') || 'OTHERS';
    const partSubGroupText = clean(master.partSubGroup || scan.partSubGroup || scan.productSubGroup || scan.productType || 'GENERAL') || 'GENERAL';
    if (!new RegExp(`^${escapeRegex(group)}$`, 'i').test(productGroupText)) return;
    if (!new RegExp(`^${escapeRegex(subGroup)}$`, 'i').test(partSubGroupText)) return;
    const key = [scan.partNumber, scan.partDescription || scan.partName, scan.binLocation || scan.bin, scan.valuationMRP || 0].join('::');
    const item = groups.get(key) || {
      partNumber: scan.partNumber,
      partDescription: scan.partDescription || scan.partName || '',
      qty: 0,
      binLocation: scan.binLocation || scan.bin || '',
      mrp: scan.valuationMRP || 0,
      mrpTotal: 0,
      scanCount: 0
    };
    item.qty += Number(scan.qty || 0);
    item.mrpTotal += Number(scan.finalInventoryValue || 0);
    item.scanCount += 1;
    groups.set(key, item);
  });
  const rows = Array.from(groups.values()).map((row) => ({ ...row, mrpTotal: money(row.mrpTotal) })).sort((a, b) => String(a.partNumber).localeCompare(String(b.partNumber)) || String(a.binLocation).localeCompare(String(b.binLocation)));
  return {
    productGroup: group,
    partSubGroup: subGroup,
    rows,
    totals: {
      partCount: rows.length,
      totalQty: rows.reduce((sum, row) => sum + Number(row.qty || 0), 0),
      totalMrpValue: rows.reduce((sum, row) => sum + Number(row.mrpTotal || 0), 0)
    }
  };
}

async function logDuplicateScan(input = {}, existing = {}, reason = 'Duplicate scan skipped') {
  try {
    const raw = rawIdentity(input) || rawIdentity(existing);
    const now = new Date();
    await DuplicateScanLog.create({
      scanId: String(input.scanId || input.uniqueScanId || ''),
      uniqueScanId: String(input.uniqueScanId || input.scanId || ''),
      qrFingerprint: String(input.qrFingerprint || ''),
      existingScanId: String(existing.scanId || existing.uniqueScanId || existing._id || ''),
      partNumber: normalizePartNumber(input.partNumber || input.part || existing.partNumber || existing.part || ''),
      dealerCode: normalizeDealerCode(input.dealerCode || existing.dealerCode || ''),
      auditId: String(input.auditId || existing.auditId || ''),
      binLocation: String(input.binLocation || input.bin || existing.binLocation || existing.bin || '').trim().toUpperCase(),
      scanType: upper(input.scanType || input.type || existing.scanType || existing.type || ''),
      deviceId: String(input.deviceId || existing.deviceId || ''),
      deviceName: String(input.deviceName || existing.deviceName || ''),
      userId: String(input.userId || existing.userId || ''),
      userName: String(input.userName || input.staffName || input.loginId || existing.userName || existing.staffName || ''),
      role: String(input.role || existing.role || '').trim().toLowerCase(),
      loginId: String(input.loginId || existing.loginId || ''),
      rawScan: raw,
      rawBarcode: raw,
      rawQR: raw,
      rawUpi: raw,
      firstScannedBy: String(existing.userName || existing.staffName || existing.loginId || existing.userId || ''),
      firstScanTime: existing.timestamp || existing.createdAt,
      firstDeviceId: String(existing.deviceId || ''),
      firstDeviceName: String(existing.deviceName || ''),
      firstBin: String(existing.binLocation || existing.bin || '').trim().toUpperCase(),
      duplicateScannedBy: String(input.userName || input.staffName || input.loginId || input.userId || ''),
      duplicateScanTime: now,
      duplicateDeviceId: String(input.deviceId || ''),
      duplicateDeviceName: String(input.deviceName || ''),
      duplicateBin: String(input.binLocation || input.bin || '').trim().toUpperCase(),
      source: String(input.source || existing.source || '').trim().toLowerCase(),
      reason,
      timestamp: now
    });
  } catch (error) {
    console.error('[DUPLICATE SCAN LOG] failed', error.message);
  }
}

function publicScan(scan = {}) {
  const parsed = parseRawScan(scanRawText(scan));
  const partNumber = normalizePartNumber(scan.partNumber || scan.part || scan.normalizedPartNumber || parsed.part || '');
  const qty = numberValue(scan.qty !== undefined ? scan.qty : scan.quantity !== undefined ? scan.quantity : parsed.qty, 0);
  const rawScan = scanRawText(scan);
  const syncStatus = normalizedSyncStatus(scan);
  const labels = sourceLabels(scan);
  const valued = decorateScanValue({
    ...scan,
    rawScan,
    rawScanString: rawScan,
    qty,
    quantity: qty
  });
  const mrp = numberValue(valued.valuationMRP, 0);
  return {
    ...valued,
    scanId: scan.scanId || scan.uniqueScanId || String(scan._id || ''),
    uniqueScanId: scan.uniqueScanId || scan.scanId || String(scan._id || ''),
    qrFingerprint: scan.qrFingerprint || '',
    syncKey: scan.syncKey || '',
    upiId: scan.upiId || '',
    upiNo: scan.upiNo || '',
    rawUpi: rawScan,
    rawScan,
    rawScanString: rawScan,
    partNumber,
    part: partNumber,
    normalizedPartNumber: scan.normalizedPartNumber || partNumber,
    partName: scan.partName || '',
    partDescription: scan.partDescription || scan.partName || '',
    category: scan.productCategory || normalizeCategory(scan.category || ''),
    productCategory: scan.productCategory || normalizeCategory(scan.category || ''),
    productGroup: scan.productGroup || '',
    partSubGroup: scan.partSubGroup || '',
    qty,
    quantity: qty,
    mrp,
    dlc: numberValue(scan.dlc, 0),
    scanMRP: valued.scanMRP || 0,
    manualMRP: valued.manualMRP || 0,
    valuationMRP: mrp,
    valuationSource: valued.valuationSource || '',
    finalInventoryValue: valued.finalInventoryValue || 0,
    scanType: scan.scanType || scan.type || '',
    type: scan.scanType || scan.type || '',
    dealerCode: scan.dealerCode || '',
    dealerName: scan.dealerName || '',
    auditId: scan.auditId || '',
    binLocation: scan.binLocation || scan.bin || '',
    bin: scan.binLocation || scan.bin || '',
    autoDetectedBin: Boolean(scan.autoDetectedBin),
    binSelectionMode: scan.binSelectionMode || '',
    regdNo: scan.regdNo || '',
    jobCardNo: scan.jobCardNo || '',
    isFitted: Boolean(scan.isFitted || (scan.scanType || scan.type) === 'FITTED'),
    fittedQty: numberValue(scan.fittedQty !== undefined ? scan.fittedQty : ((scan.scanType || scan.type) === 'FITTED' ? qty : 0), 0),
    fittedLocation: scan.fittedLocation || ((scan.scanType || scan.type) === 'FITTED' || scan.isFitted ? 'VEHICLE' : ''),
    status: scan.status || ((scan.scanType || scan.type) === 'FITTED' || scan.isFitted ? 'FITTED_ON_VEHICLE' : ''),
    stockDeductedFromBin: scan.stockDeductedFromBin || '',
    deviceId: scan.deviceId || '',
    deviceName: scan.deviceName || '',
    userId: scan.userId || '',
    userName: scan.userName || scan.staffName || scan.loginId || '',
    role: scan.role || '',
    scanStatus: scan.scanStatus || (scan.scanType === 'OUTWARD' || scan.type === 'OUTWARD' ? 'OUTWARD_DONE' : 'ACCEPTED'),
    syncStatus,
    synced: syncStatus === 'synced' || scan.synced === true,
    isSynced: syncStatus === 'synced' || scan.isSynced === true,
    timestamp: scan.timestamp || scan.scanTime || scan.createdAt,
    scanTime: scan.scanTime || scan.timestamp || scan.createdAt,
    createdAt: scan.createdAt,
    source: scan.source || 'server',
    entryMode: labels.entryMode,
    entryChannel: labels.entryChannel,
    scanSourceLabel: labels.scanSourceLabel
  };
}

function publicScanWithMaster(record = {}, masterLookup = {}) {
  const scan = publicScan(record);
  const master = masterForScan(scan, masterLookup) || null;
  if (!master) {
    return {
      ...scan,
      _masterLookupComplete: true,
      masterFound: false,
      masterMatch: false,
      isMasterMatched: false
    };
  }
  const scanDlc = numberValue(scan.dlc, 0);
  const masterDlc = numberValue(master.dlc, 0);
  const scanMrp = numberValue(scan.mrp, 0);
  const masterMrp = numberValue(master.mrp, 0);
  return {
    ...scan,
    partName: scan.partName || master.partName || master.partDescription || '',
    partDescription: scan.partDescription || master.partDescription || master.partName || '',
    category: scan.category || master.productCategory || master.category || '',
    productCategory: scan.productCategory || master.productCategory || master.category || '',
    productGroup: scan.productGroup || master.productGroup || '',
    partSubGroup: scan.partSubGroup || master.partSubGroup || master.productSubGroup || '',
    model: scan.model || master.model || '',
    year: scan.year || master.year || master.manufacturingYear || '',
    manufacturingYear: scan.manufacturingYear || master.manufacturingYear || master.year || '',
    currentCatalogueMRP: masterMrp,
    displayMRP: scanMrp > 0 ? scanMrp : masterMrp,
    dlc: scanDlc > 0 ? scanDlc : masterDlc,
    _masterLookupComplete: true,
    masterFound: true,
    masterMatch: true,
    isMasterMatched: true
  };
}

function scanIdentityScope(filter = {}, dealerCode = '', auditId = '') {
  const dealer = normalizeDealerCode(dealerCode);
  const audit = String(auditId || '').trim();
  if (dealer) filter.dealerCode = dealer;
  if (audit) filter.auditId = audit;
  return filter;
}

function inboundAcceptedFilter(raw, dealerCode = '', auditId = '') {
  return scanIdentityScope({
    scanType: 'INWARD',
    scanStatus: { $in: ['ACCEPTED', 'SUPERVISOR_APPROVED'] },
    $or: [
      { rawScan: raw },
      { rawScanString: raw },
      { rawBarcode: raw },
      { rawQR: raw },
      { rawUpi: raw },
      { upiNo: upper(raw) },
      { upiId: raw }
    ]
  }, dealerCode, auditId);
}

function outwardDoneFilter(raw, dealerCode = '', auditId = '') {
  return scanIdentityScope({
    scanType: 'OUTWARD',
    scanStatus: 'OUTWARD_DONE',
    $or: [
      { rawScan: raw },
      { rawScanString: raw },
      { rawBarcode: raw },
      { rawQR: raw },
      { rawUpi: raw },
      { upiNo: upper(raw) },
      { upiId: raw }
    ]
  }, dealerCode, auditId);
}

function roleScanError(role, scanType) {
  const value = String(role || '').trim().toLowerCase();
  if (!value || value === 'admin' || value === 'supervisor') return '';
  if (value === 'outward_counter') return scanType === 'OUTWARD' ? '' : 'Outward Counter can only perform OUTWARD scans';
  if (['scanner', 'staff', 'mobile_user'].includes(value)) return scanType === 'OUTWARD' ? 'Scanner users cannot perform OUTWARD scans' : '';
  return '';
}

function isWebServerSavedScan(scan = {}) {
  const deviceId = String(scan.deviceId || '').trim().toUpperCase();
  const scanMode = String(scan.scanMode || scan.source || scan.scanSource || '').trim().toLowerCase();
  return deviceId.startsWith('WEB-') || ['barcode/web scan', 'web scan', 'barcode', 'manual', 'scanner', 'bluetooth_scanner', 'bluetooth scanner', 'api'].includes(scanMode);
}

function normalizedSyncStatus(scan = {}) {
  const explicit = String(scan.syncStatus || '').trim().toLowerCase();
  if (['failed', 'rejected', 'duplicate'].includes(explicit)) return explicit;
  if (explicit === 'synced' || scan.synced === true || scan.isSynced === true || isWebServerSavedScan(scan)) return 'synced';
  return 'pending';
}

function stockQtyExpression() {
  const qty = {
    $convert: {
      input: { $ifNull: ['$qty', { $ifNull: ['$quantity', 0] }] },
      to: 'double',
      onError: 0,
      onNull: 0
    }
  };
  const type = { $toUpper: { $toString: { $ifNull: ['$scanType', { $ifNull: ['$type', ''] }] } } };
  return {
    $switch: {
      branches: [
        { case: { $eq: [type, 'INWARD'] }, then: { $abs: qty } },
        { case: { $in: [type, ['OUTWARD', 'FITTED', 'DAMAGE']] }, then: { $multiply: [{ $abs: qty }, -1] } },
        { case: { $eq: [type, 'VERIFICATION'] }, then: 0 }
      ],
      default: 0
    }
  };
}

function inwardQtyExpression() {
  const qty = {
    $convert: {
      input: { $ifNull: ['$qty', { $ifNull: ['$quantity', 0] }] },
      to: 'double',
      onError: 0,
      onNull: 0
    }
  };
  const type = { $toUpper: { $toString: { $ifNull: ['$scanType', { $ifNull: ['$type', ''] }] } } };
  return {
    $cond: [
      { $eq: [type, 'INWARD'] },
      { $abs: qty },
      0
    ]
  };
}

function stockQty(scan = {}) {
  const qty = Math.abs(numberValue(scan.qty !== undefined ? scan.qty : scan.quantity, 0));
  const type = upper(scan.scanType || scan.type);
  if (type === 'INWARD') return qty;
  if (['OUTWARD', 'FITTED', 'DAMAGE'].includes(type)) return -qty;
  if (type === 'VERIFICATION') return 0;
  return 0;
}

function inwardQty(scan = {}) {
  return upper(scan.scanType || scan.type) === 'INWARD'
    ? Math.abs(numberValue(scan.qty !== undefined ? scan.qty : scan.quantity, 0))
    : 0;
}

function manualDuplicatePayload(existing = {}, requestedQty = 1) {
  const partNumber = normalizePartNumber(existing.normalizedPartNumber || existing.partNumber || existing.part || '');
  const binLocation = upper(existing.binLocation || existing.bin || '');
  const existingQty = numberValue(existing.qty !== undefined ? existing.qty : existing.quantity, 0);
  const addQty = Math.abs(numberValue(requestedQty, 1));
  return {
    manualDuplicate: true,
    partNumber,
    binLocation,
    existingQty,
    requestedQty: addQty,
    message: `Part ${partNumber} is already available in bin ${binLocation}. Current quantity: ${existingQty}. Do you want to add ${addQty} more?`
  };
}

async function addManualQuantity(existing = {}, input = {}, req) {
  const addQty = Math.abs(numberValue(firstValue(input, ['qty', 'quantity', 'count']), 0));
  if (!(addQty > 0)) return { error: 'Quantity to add must be greater than zero.' };
  const requestId = clean(input.manualAddRequestId || input.uniqueScanId || input.scanId || input.clientScanId || input.syncKey || '');
  if (!requestId) return { error: 'Manual quantity update request ID is required.' };

  const now = new Date();
  const currentQtyExpression = {
    $convert: {
      input: { $ifNull: ['$qty', { $ifNull: ['$quantity', 0] }] },
      to: 'double',
      onError: 0,
      onNull: 0
    }
  };
  const currentMrpExpression = {
    $convert: {
      input: { $ifNull: ['$valuationMRP', { $ifNull: ['$manualMRP', { $ifNull: ['$mrp', 0] }] }] },
      to: 'double',
      onError: 0,
      onNull: 0
    }
  };
  const nextQtyExpression = { $add: [currentQtyExpression, addQty] };
  let updated = await Inventory.findOneAndUpdate(
    { _id: existing._id, lastManualAddRequestId: { $ne: requestId } },
    [{
      $set: {
        qty: nextQtyExpression,
        quantity: nextQtyExpression,
        finalInventoryValue: { $multiply: [nextQtyExpression, currentMrpExpression] },
        lastManualAddRequestId: requestId,
        lastManualMergedAt: now,
        syncStatus: 'synced',
        synced: true,
        isSynced: true,
        updatedAt: now
      }
    }],
    { new: true }
  ).lean();
  const alreadyApplied = !updated;
  if (!updated) updated = await Inventory.findById(existing._id).lean();
  if (!updated) return { error: 'Existing manual scan record was not found.' };

  const actor = req.user || {};
  if (!alreadyApplied) {
    await AuditLog.create({
      eventType: 'scan.manual.quantity.added',
      module: 'inventory',
      severity: 'info',
      message: `Manual quantity added for ${updated.partNumber || updated.part}`,
      actorId: String(actor.id || actor._id || actor.username || actor.email || ''),
      actorName: String(actor.name || actor.username || actor.email || ''),
      actorRole: String(actor.role || ''),
      deviceId: String(input.deviceId || updated.deviceId || ''),
      ipAddress: req.ip || '',
      userAgent: req.headers['user-agent'] || '',
      dealerCode: updated.dealerCode || '',
      auditId: updated.auditId || '',
      scanId: updated.scanId || updated.uniqueScanId || String(updated._id),
      partNumber: updated.partNumber || updated.part || '',
      metadata: {
        added_quantity: addQty,
        new_quantity: numberValue(updated.qty !== undefined ? updated.qty : updated.quantity, 0),
        bin_location: updated.binLocation || updated.bin || '',
        request_id: requestId,
        updated_at: now
      }
    }).catch(() => undefined);
  }

  const publicRow = publicScan(updated);
  if (req.io && !alreadyApplied) {
    req.io.emit('scan:saved', publicRow);
    req.io.emit('inventory:update', { reason: 'manual-quantity-added', scan: publicRow, dealerCode: publicRow.dealerCode || '', auditId: publicRow.auditId || '', at: now });
    req.io.emit('reports:update', { reason: 'manual-quantity-added', scan: publicRow, dealerCode: publicRow.dealerCode || '', auditId: publicRow.auditId || '', at: now });
    req.io.emit('stats:update');
  }
  return { updated: publicRow, alreadyApplied, addQty };
}

function partStockMatch({ dealerCode = '', auditId = '', partNumber = '', rawScan = '' } = {}) {
  const dealer = normalizeDealerCode(dealerCode);
  const audit = clean(auditId);
  const part = normalizePartNumber(partNumber);
  const raw = clean(rawScan);
  const rawUpper = upper(raw);
  const identityTerms = [];
  if (part) identityTerms.push({ normalizedPartNumber: part }, { partNumber: part }, { part });
  if (raw) {
    identityTerms.push(
      { rawScan: raw },
      { rawScanString: raw },
      { rawBarcode: raw },
      { rawQR: raw },
      { rawUpi: raw },
      { upiNo: rawUpper },
      { upiId: raw }
    );
  }
  const match = {
    scanStatus: { $in: acceptedStatuses() },
    syncStatus: { $nin: ['duplicate', 'rejected', 'failed', 'deleted'] },
    isDuplicate: { $ne: true },
    $and: [nonVerificationScanClause()]
  };
  if (dealer) match.dealerCode = dealer;
  if (audit) match.auditId = audit;
  if (identityTerms.length) match.$and.push({ $or: identityTerms });
  return match;
}

async function availableInwardStock(input = {}) {
  const match = partStockMatch(input);
  if (!match.$and || !match.$and.some((clause) => clause.$or)) return { availableQty: 0, inwardQty: 0, bins: [] };
  const scans = uniqueReportScans(await Inventory.find(match).sort({ timestamp: 1, createdAt: 1 }).lean());
  const byBin = new Map();
  scans.forEach((scan) => {
    const bin = upper(scan.binLocation || scan.bin);
    if (!bin) return;
    const row = byBin.get(bin) || { _id: bin, availableQty: 0, inwardQty: 0, oldestScanTime: scan.timestamp, oldestCreatedAt: scan.createdAt };
    row.availableQty += stockQty(scan);
    row.inwardQty += inwardQty(scan);
    if (new Date(scan.timestamp || scan.createdAt || 0) < new Date(row.oldestScanTime || row.oldestCreatedAt || 0)) {
      row.oldestScanTime = scan.timestamp;
      row.oldestCreatedAt = scan.createdAt;
    }
    byBin.set(bin, row);
  });
  const rows = Array.from(byBin.values())
    .filter((row) => row.inwardQty > 0 && row.availableQty > 0)
    .sort((a, b) => new Date(a.oldestScanTime || a.oldestCreatedAt || 0) - new Date(b.oldestScanTime || b.oldestCreatedAt || 0) || String(a._id).localeCompare(String(b._id), undefined, { numeric: true, sensitivity: 'base' }));
  return {
    availableQty: rows.reduce((sum, row) => sum + Number(row.availableQty || 0), 0),
    inwardQty: rows.reduce((sum, row) => sum + Number(row.inwardQty || 0), 0),
    bins: rows.map((row) => ({
      binLocation: upper(row._id),
      availableQty: Number(row.availableQty || 0),
      inwardQty: Number(row.inwardQty || 0),
      oldestScanTime: row.oldestScanTime,
      oldestCreatedAt: row.oldestCreatedAt
    })).filter((row) => row.binLocation)
  };
}

async function verifyPartOnly({ rawScan = '', partNumber = '', dealerCode = '', auditId = '' } = {}) {
  const parsed = parseRawScan(rawScan || partNumber);
  const part = normalizePartNumber(partNumber || parsed.part || '');
  const stock = await availableInwardStock({
    rawScan,
    partNumber: part,
    dealerCode,
    auditId
  });
  const found = stock.availableQty > 0;
  return {
    success: true,
    verification: true,
    transactional: false,
    found,
    scanned: found,
    partNumber: part,
    rawScan,
    dealerCode: normalizeDealerCode(dealerCode),
    auditId: clean(auditId),
    availableQty: stock.availableQty,
    inwardQty: stock.inwardQty,
    bins: stock.bins,
    color: found ? 'yellow' : '',
    message: found ? VERIFICATION_FOUND_MESSAGE : VERIFICATION_NOT_FOUND_MESSAGE
  };
}

async function autoDetectOutwardBin({ dealerCode, auditId, partNumber }) {
  const dealer = normalizeDealerCode(dealerCode);
  const part = normalizePartNumber(partNumber);
  if (!dealer || !part) return null;
  const match = {
    dealerCode: dealer,
    scanStatus: { $in: ['ACCEPTED', 'SUPERVISOR_APPROVED', 'OUTWARD_DONE'] },
    syncStatus: { $nin: ['duplicate', 'rejected', 'failed'] },
    isDuplicate: { $ne: true },
    $or: [{ normalizedPartNumber: part }, { partNumber: part }, { part }],
    $and: [{
      $or: [
        { binLocation: { $nin: [null, ''] } },
        { bin: { $nin: [null, ''] } }
      ]
    }]
  };
  if (auditId) match.auditId = String(auditId).trim();
  const scans = uniqueReportScans(await Inventory.find(match).sort({ timestamp: 1, createdAt: 1 }).lean());
  const byBin = new Map();
  scans.forEach((scan) => {
    const bin = upper(scan.binLocation || scan.bin);
    if (!bin || ['NULL', 'UNDEFINED'].includes(bin)) return;
    const row = byBin.get(bin) || { _id: bin, availableQty: 0, inwardQty: 0, oldestScanTime: scan.timestamp, oldestCreatedAt: scan.createdAt };
    row.availableQty += stockQty(scan);
    row.inwardQty += inwardQty(scan);
    if (new Date(scan.timestamp || scan.createdAt || 0) < new Date(row.oldestScanTime || row.oldestCreatedAt || 0)) {
      row.oldestScanTime = scan.timestamp;
      row.oldestCreatedAt = scan.createdAt;
    }
    byBin.set(bin, row);
  });
  const rows = Array.from(byBin.values()).filter((row) => row.inwardQty > 0 && row.availableQty > 0);
  if (!rows.length) return null;
  const binCodes = rows.map((row) => upper(row._id)).filter(Boolean);
  const bins = await Bin.find({ dealerCode: dealer, binCode: { $in: binCodes } }).lean().catch(() => []);
  const priorityByBin = new Map(bins.map((bin) => [
    upper(bin.binCode),
    Number(bin.priority ?? bin.binPriority ?? bin.sequence ?? bin.sortOrder ?? Number.MAX_SAFE_INTEGER)
  ]));
  rows.sort((a, b) => {
    const priorityA = priorityByBin.get(upper(a._id)) ?? Number.MAX_SAFE_INTEGER;
    const priorityB = priorityByBin.get(upper(b._id)) ?? Number.MAX_SAFE_INTEGER;
    if (priorityA !== priorityB) return priorityA - priorityB;
    return new Date(a.oldestScanTime || a.oldestCreatedAt || 0) - new Date(b.oldestScanTime || b.oldestCreatedAt || 0)
      || String(a._id).localeCompare(String(b._id), undefined, { numeric: true, sensitivity: 'base' });
  });
  return { binLocation: upper(rows[0]._id), availableQty: Number(rows[0].availableQty || 0) };
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyScanVisibility(req, filter = {}) {
  if (req.user && req.user.role === 'admin') return filter;
  const userId = String((req.user && (req.user.id || req.user.username || req.user.email)) || req.query.userId || req.query.loginId || '').trim();
  const deviceId = String(req.query.deviceId || '').trim();
  const staffName = String((req.user && (req.user.name || req.user.username)) || '').trim();
  const terms = [
    userId ? { userId } : null,
    userId ? { loginId: userId } : null,
    deviceId ? { deviceId } : null,
    staffName ? { staffName } : null
  ].filter(Boolean);
  if (terms.length) filter.$and = (filter.$and || []).concat([{ $or: terms }]);
  return filter;
}

async function repairParsedFields(records = []) {
  const operations = [];
  records.forEach((record) => {
    const parsed = parseRawScan(scanRawText(record));
    const partNumber = normalizePartNumber(record.partNumber || record.part || record.normalizedPartNumber || parsed.part || '');
    const qty = numberValue(record.qty !== undefined ? record.qty : record.quantity !== undefined ? record.quantity : parsed.qty, 0);
    const mrp = numberValue(record.mrp !== undefined ? record.mrp : parsed.mrp, 0);
    const patch = {};
    if (partNumber && (!record.partNumber || !record.part || !record.normalizedPartNumber)) {
      patch.part = partNumber;
      patch.partNumber = partNumber;
      patch.normalizedPartNumber = partNumber;
    }
    if ((record.qty === undefined || record.qty === null || Number(record.qty) === 0) && qty) patch.qty = qty;
    if ((record.quantity === undefined || record.quantity === null || Number(record.quantity) === 0) && qty) patch.quantity = qty;
    if ((record.mrp === undefined || record.mrp === null || Number(record.mrp) === 0) && mrp) patch.mrp = mrp;
    if (parsed.mrpProvided) {
      const valueFields = valuationFields({
        rawScanText: scanRawText(record),
        scannedMrp: parsed.mrp,
        mrpProvided: true,
        entrySource: record.source || 'barcode',
        manualEntryMode: false
      });
      patch.mrp = valueFields.mrp;
      patch.scanMRP = valueFields.scanMRP;
      patch.valuationMRP = valueFields.valuationMRP;
      patch.valuationSource = valueFields.valuationSource;
      patch.finalInventoryValue = qty * Number(valueFields.valuationMRP || 0);
    }
    if (Object.keys(patch).length && record._id) operations.push({ updateOne: { filter: { _id: record._id }, update: { $set: patch } } });
  });
  if (operations.length) await Inventory.bulkWrite(operations, { ordered: false });
}

async function emitScanUpdate(req, savedScan) {
  const io = req.io || req.app.get('io');
  if (!io) return;
  const plainScan = publicScan(savedScan.toObject ? savedScan.toObject() : savedScan);
  const dashboardFilter = scanDashboardScope(plainScan);
  io.emit('scan:new', plainScan);
  io.emit('scan:saved', plainScan);
  io.emit('scanner:activity', {
    deviceId: plainScan.deviceId || '',
    deviceName: plainScan.deviceName || '',
    partNumber: plainScan.partNumber || plainScan.part || '',
    scanId: plainScan.scanId || plainScan.uniqueScanId || '',
    scanType: plainScan.scanType || plainScan.type || '',
    timestamp: plainScan.timestamp || new Date()
  });
  queueRealtimeDashboardUpdate(io, dashboardFilter, plainScan);
  const scannerManager = req.app.get('scannerManager');
  if (scannerManager) scannerManager.recordScanActivity(plainScan).catch((error) => console.warn('Scanner activity update failed:', error.message));
}

function realtimeDashboardKey(filter = {}) {
  return `${filter.dealerCode || ''}|${filter.auditId || ''}`;
}

function queueRealtimeDashboardUpdate(io, dashboardFilter = {}, plainScan = {}) {
  const key = realtimeDashboardKey(dashboardFilter);
  const entry = realtimeDashboardTimers.get(key) || {
    count: 0,
    latestScan: null,
    timer: null
  };
  entry.count += 1;
  entry.latestScan = plainScan || entry.latestScan;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(async () => {
    realtimeDashboardTimers.delete(key);
    try {
      const realtimePayload = {
        source: 'inventory-api',
        scans: entry.latestScan ? [entry.latestScan] : [],
        count: entry.count,
        at: new Date(),
        dealerCode: dashboardFilter.dealerCode || '',
        auditId: dashboardFilter.auditId || ''
      };
      io.emit('reports:update', realtimePayload);
      io.emit('warehouse:feed', realtimePayload);
    } catch (error) {
      console.warn('[MANUAL SCAN] realtime dashboard update failed', error.message);
    }
  }, REALTIME_SCAN_REFRESH_DELAY_MS);
  realtimeDashboardTimers.set(key, entry);
}

async function cleanupTestScans(req, res) {
  try {
    const result = await Inventory.deleteMany(testScanClause());
    req.io.emit('scan:deleted');
    req.io.emit('stats:update');
    res.json({ success: true, deletedCount: result.deletedCount || 0 });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function validateScan(payload, master, timestamp, pricePeriod = null) {
  const warnings = [];
  const scannedMrp = optionalNumber(payload.mrp);
  const scannedDlc = optionalNumber(payload.dlc);
  const mrpCompareRequired = shouldComparePrice(payload, 'mrp');
  const dlcCompareRequired = shouldComparePrice(payload, 'dlc');
  const expectedMrp = pricePeriod ? pricePeriod.mrp : undefined;
  const mrpMatch = !mrpCompareRequired || expectedMrp === undefined || !approxMismatch(scannedMrp, expectedMrp);

  if (!master) {
    warnings.push(`Part not found in Master Catalogue: ${payload.part || payload.partNumber || ''}`);
  } else {
    if (mrpCompareRequired && expectedMrp !== undefined && approxMismatch(scannedMrp, expectedMrp)) warnings.push('MRP mismatch against price history period');
    if (mrpCompareRequired && expectedMrp === undefined) warnings.push('No matching price history period for scanned MRP');
    if (dlcCompareRequired && approxMismatch(scannedDlc, master.dlc)) warnings.push('DLC mismatch');
    if (!master.activeStatus) warnings.push('Inactive part');
  }

  scanDebug('RAW_SCAN:', payload.rawScan || payload.rawScanString || '');
  scanDebug('EXTRACTED_PART:', payload.part || payload.partNumber || '');
  scanDebug('PRICE_HISTORY_MRP:', expectedMrp !== undefined ? expectedMrp : '');
  scanDebug('SCANNED_MRP:', mrpCompareRequired ? scannedMrp : '');
  scanDebug('MRP_COMPARE_REQUIRED', mrpCompareRequired);
  scanDebug('MRP_MATCH', mrpMatch);
  scanDebug('FINAL_STATUS:', !master ? 'Rejected / Not in Master' : warnings.includes('MRP mismatch') ? 'MRP mismatch' : warnings.length ? warnings.join(', ') : 'Synced');

  return warnings;
}

async function logValidationFailure(payload = {}, reason = 'Not Found In Master', timestamp = new Date()) {
  try {
    if (upper(payload.scanType || payload.type || '') === 'VERIFICATION') return;
    if (!masterValidation.isManualRejectedSource(payload)) return;
    const now = timestamp instanceof Date && !Number.isNaN(timestamp.getTime()) ? timestamp : new Date();
    const rawScannedValue = String(payload.rawScan || payload.rawScanString || payload.rawUpi || payload.upiNo || payload.upiId || '').trim();
    const dealerCode = normalizeDealerCode(payload.dealerCode || payload.dealer || '');
    const deviceId = String(payload.deviceId || '').trim();
    const recent = rawScannedValue ? await VerificationLog.findOne({
      found: false,
      rawScannedValue,
      dealerCode,
      deviceId,
      time: { $gte: new Date(now.getTime() - 5000) }
    }).sort({ time: -1 }) : null;
    if (recent) {
      recent.repeatCount = Number(recent.repeatCount || 1) + 1;
      recent.time = now;
      await recent.save();
      return;
    }
    await VerificationLog.create({
      partNumber: normalizePartNumber(payload.part || payload.partNumber || ''),
      extractedPartNumber: normalizePartNumber(payload.part || payload.partNumber || ''),
      rawScannedValue,
      found: false,
      dealerCode,
      deviceId,
      userId: String(payload.userId || '').trim(),
      loginId: String(payload.loginId || '').trim(),
      scannedBy: String(payload.staffName || payload.loginId || payload.userId || '').trim(),
      staffName: String(payload.staffName || '').trim(),
      scanType: upper(payload.scanType || payload.type || ''),
      source: normalizeSource(payload.source, 'manual'),
      binLocation: String(payload.binLocation || payload.bin || '').trim().toUpperCase(),
      reason,
      repeatCount: 1,
      time: now
    });
  } catch (error) {
    console.warn('[MANUAL SCAN] verification log write failed', error.message);
  }
}

function scanLookupFilter(scanId = '') {
  const id = String(scanId || '').trim();
  const clauses = [{ scanId: id }, { uniqueScanId: id }];
  if (/^[a-f\d]{24}$/i.test(id)) clauses.push({ _id: id });
  return { $or: clauses };
}

function isManualScanRecord(scan = {}) {
  const source = normalizeSource(scan.source || scan.scanSource || scan.scanMode || scan.entryMode, '');
  const text = [scan.source, scan.scanSource, scan.scanMode, scan.entryMode, scan.scanSourceLabel]
    .map((value) => String(value || '').toLowerCase())
    .join(' ');
  const rawText = scanRawText(scan);
  return source === 'manual'
    || /\bmanual\b/.test(text)
    || /^MANUAL:/i.test(rawText)
    || /MANUAL_ENTERED_MRP/i.test(String(scan.valuationSource || ''))
    || numberValue(scan.manualMRP, 0) > 0;
}

async function updateManualMrp(req, res) {
  try {
    const mrp = optionalNumber(firstValue(req.body || {}, ['mrp', 'newMrp', 'new_mrp', 'manualMRP', 'manualMrp']));
    const dlc = optionalNumber(firstValue(req.body || {}, ['dlc', 'newDlc', 'new_dlc', 'manualDLC', 'manualDlc']));
    if (!(Number(mrp || 0) > 0)) {
      return res.status(400).json({ success: false, message: 'MRP is mandatory for manual part entry.' });
    }
    if (dlc !== undefined && dlc < 0) {
      return res.status(400).json({ success: false, message: 'DLC must be zero or greater.' });
    }
    const scan = await Inventory.findOne(scanLookupFilter(req.params.scanId)).lean();
    if (!scan) return res.status(404).json({ success: false, message: 'Scan record not found' });

    const now = new Date();
    const qty = numberValue(scan.qty !== undefined ? scan.qty : scan.quantity, 1);
    const oldMrp = numberValue(scan.manualMRP || scan.valuationMRP || scan.mrp || 0, 0);
    const oldDlc = numberValue(scan.dlc, 0);
    const pricePeriod = await findPricePeriod(scan.partNumber || scan.part, scan.timestamp || scan.scanTime || now, mrp).catch(() => null);
    const update = {
      mrp,
      manualMRP: mrp,
      scanMRP: 0,
      valuationMRP: mrp,
      valuationSource: 'MANUAL_ENTERED_MRP',
      finalInventoryValue: money(qty * mrp),
      finalMRP: mrp,
      mrpStatus: 'UPDATED',
      mrpPendingUpdatedAt: now,
      ...pricePeriodPayload(pricePeriod, mrp)
    };
    if (dlc !== undefined) update.dlc = dlc;
    const updated = await Inventory.findByIdAndUpdate(scan._id, { $set: update }, { new: true }).lean();
    const actor = req.user || {};
    await AuditLog.create({
      eventType: 'scan_pricing.updated',
      module: 'inventory',
      severity: 'info',
      message: `Scan pricing updated for ${scan.partNumber || scan.part || ''}`,
      actorId: String(actor.id || actor._id || actor.username || actor.email || ''),
      actorName: String(actor.name || actor.username || actor.email || ''),
      actorRole: String(actor.role || ''),
      deviceId: String(req.body.deviceId || scan.deviceId || ''),
      ipAddress: req.ip || '',
      userAgent: req.headers['user-agent'] || '',
      dealerCode: scan.dealerCode || '',
      auditId: scan.auditId || '',
      scanId: scan.scanId || scan.uniqueScanId || String(scan._id),
      partNumber: scan.partNumber || scan.part || '',
      metadata: {
        old_mrp: oldMrp,
        new_mrp: mrp,
        old_dlc: oldDlc,
        new_dlc: dlc !== undefined ? dlc : oldDlc,
        updated_by: String(actor.username || actor.name || actor.email || actor.id || ''),
        updated_at: now
      }
    }).catch(() => undefined);

    const publicRow = publicScan(updated);
    if (req.io) {
      req.io.emit('mrp:updated', publicRow);
      req.io.emit('scan:saved', publicRow);
      req.io.emit('reports:update', {
        reason: 'scan-pricing-update',
        scan: publicRow,
        dealerCode: publicRow.dealerCode || '',
        auditId: publicRow.auditId || '',
        at: now
      });
    }
    return res.json({ success: true, scan: publicRow, message: dlc !== undefined ? 'MRP/DLC updated successfully' : 'MRP updated successfully' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function updateScanDetails(req, res) {
  try {
    const scan = await Inventory.findOne(scanLookupFilter(req.params.scanId)).lean();
    if (!scan) return res.status(404).json({ success: false, message: 'Scan record not found' });

    const oldPartNumber = normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part || '');
    const partNumber = normalizePartNumber(firstValue(req.body || {}, ['partNumber', 'part', 'partNo']) || oldPartNumber);
    const qty = optionalNumber(firstValue(req.body || {}, ['qty', 'quantity']));
    const mrp = optionalNumber(firstValue(req.body || {}, ['mrp', 'manualMRP', 'valuationMRP']));
    const dlc = optionalNumber(firstValue(req.body || {}, ['dlc', 'manualDLC']));
    const binLocation = upper(firstValue(req.body || {}, ['binLocation', 'bin']));
    const scanType = normalizeScanType(scan.scanType || scan.type || 'INWARD');

    if (!partNumber) return res.status(400).json({ success: false, message: 'Part number is required.' });
    if (!(Number(qty) > 0)) return res.status(400).json({ success: false, message: 'Quantity must be greater than zero.' });
    if (mrp === undefined || mrp < 0) return res.status(400).json({ success: false, message: 'MRP must be zero or greater.' });
    if (dlc === undefined || dlc < 0) return res.status(400).json({ success: false, message: 'DLC must be zero or greater.' });
    if (['INWARD', 'OUTWARD', 'DAMAGE'].includes(scanType) && !binLocation) {
      return res.status(400).json({ success: false, message: 'Bin location is required for this scan type.' });
    }

    const partChanged = partNumber !== oldPartNumber;
    const master = await findMasterPart(partNumber, scan.dealerCode);
    if (partChanged && !master) {
      return res.status(400).json({ success: false, message: `Part number not found in master: ${partNumber}` });
    }
    if (partChanged) {
      const duplicateFilter = duplicatePolicy.businessDuplicateFilter({
        ...scan,
        partNumber,
        normalizedPartNumber: partNumber,
        scanType
      });
      const duplicate = duplicateFilter
        ? await Inventory.findOne({ ...duplicateFilter, _id: { $ne: scan._id } }).lean()
        : null;
      if (duplicate) {
        return res.status(409).json({ success: false, duplicate: true, message: duplicatePolicy.DUPLICATE_PART_MESSAGE });
      }
    }

    const now = new Date();
    const pricePeriod = mrp > 0
      ? await findPricePeriod(partNumber, scan.timestamp || scan.scanTime || now, mrp).catch(() => null)
      : null;
    const update = {
      part: partNumber,
      partNumber,
      normalizedPartNumber: partNumber,
      qty,
      quantity: qty,
      mrp,
      manualMRP: mrp,
      scanMRP: 0,
      valuationMRP: mrp,
      valuationSource: mrp > 0 ? 'MANUAL_ENTERED_MRP' : 'NO_SCANNED_OR_MANUAL_MRP',
      finalInventoryValue: money(qty * mrp),
      finalMRP: mrp,
      mrpStatus: mrp > 0 ? 'UPDATED' : 'PENDING',
      mrpPendingUpdatedAt: mrp > 0 ? now : null,
      dlc,
      bin: scanType === 'FITTED' ? '' : binLocation,
      binLocation: scanType === 'FITTED' ? '' : binLocation,
      ...pricePeriodPayload(pricePeriod, mrp)
    };
    if (scanType === 'FITTED') update.fittedQty = qty;
    if (scanType === 'OUTWARD') {
      update.autoDetectedBin = false;
      update.binSelectionMode = 'MANUAL';
      update.stockDeductedFromBin = binLocation;
    } else if (['INWARD', 'DAMAGE'].includes(scanType)) {
      update.autoDetectedBin = false;
      update.binSelectionMode = 'MANUAL';
    }
    if (master) {
      update.partName = master.partName || master.partDescription || '';
      update.partDescription = master.partDescription || master.partName || '';
      update.model = master.model || '';
      update.year = master.manufacturingYear || master.year || '';
      update.manufacturingYear = master.manufacturingYear || master.year || '';
      update.category = normalizeCategory(master.productCategory || master.category || '');
      update.productCategory = normalizeCategory(master.productCategory || master.category || '');
      update.productGroup = upper(master.productGroup || '');
      update.productType = upper(master.productType || '');
      update.partGroup = upper(master.partGroup || '');
      update.partSubGroup = upper(master.partSubGroup || '');
      update.gstCategory = upper(master.gstCategory || '');
      update.superceededBy = upper(master.superceededBy || '');
      update.masterFound = true;
      update.masterMatch = true;
      update.isMasterMatched = true;
      update.warnings = (Array.isArray(scan.warnings) ? scan.warnings : []).filter((warning) => !/not\s+found\s+in\s+master|unknown\s+part|invalid\s+part/i.test(String(warning || '')));
      update.remarks = String(scan.remarks || '')
        .split(',')
        .map((remark) => remark.trim())
        .filter((remark) => remark && !/not\s+found\s+in\s+master|unknown\s+part|invalid\s+part/i.test(remark))
        .join(', ');
    }

    const updated = await Inventory.findByIdAndUpdate(scan._id, { $set: update }, { new: true, runValidators: true }).lean();
    const actor = req.user || {};
    await AuditLog.create({
      eventType: 'scan.details.updated',
      module: 'inventory',
      severity: 'info',
      message: `Scan details updated for ${partNumber}`,
      actorId: String(actor.id || actor._id || actor.username || actor.email || ''),
      actorName: String(actor.name || actor.username || actor.email || ''),
      actorRole: String(actor.role || ''),
      deviceId: String(req.body.deviceId || scan.deviceId || ''),
      ipAddress: req.ip || '',
      userAgent: req.headers['user-agent'] || '',
      dealerCode: scan.dealerCode || '',
      auditId: scan.auditId || '',
      scanId: scan.scanId || scan.uniqueScanId || String(scan._id),
      partNumber,
      metadata: {
        old_part_number: oldPartNumber,
        new_part_number: partNumber,
        old_quantity: numberValue(scan.qty !== undefined ? scan.qty : scan.quantity, 0),
        new_quantity: qty,
        old_mrp: numberValue(scan.valuationMRP || scan.mrp, 0),
        new_mrp: mrp,
        old_dlc: numberValue(scan.dlc, 0),
        new_dlc: dlc,
        old_bin_location: upper(scan.binLocation || scan.bin),
        new_bin_location: scanType === 'FITTED' ? '' : binLocation,
        updated_by: String(actor.username || actor.name || actor.email || actor.id || ''),
        updated_at: now
      }
    }).catch(() => undefined);

    const publicRow = publicScan(updated);
    if (req.io) {
      req.io.emit('scan:saved', publicRow);
      req.io.emit('inventory:update', { reason: 'scan-details-update', scan: publicRow, dealerCode: publicRow.dealerCode || '', auditId: publicRow.auditId || '', at: now });
      req.io.emit('reports:update', { reason: 'scan-details-update', scan: publicRow, dealerCode: publicRow.dealerCode || '', auditId: publicRow.auditId || '', at: now });
      req.io.emit('stats:update');
    }
    return res.json({ success: true, scan: publicRow, message: 'Part details updated successfully' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function saveScanRequest(req, res) {
  try {
    const rawScanInput = firstValue(req.body, ['rawScan', 'rawScanString', 'rawBarcode', 'rawScanValue', 'barcode', 'barcodeValue', 'scanValue', 'scanText']);
    scanDebug('[MANUAL SCAN] request received', {
      bodyKeys: Object.keys(req.body || {}).slice(0, 30),
      partNumber: req.body.partNumber || req.body.partNo || req.body.part || '',
      dealerCode: req.body.dealerCode || req.body.dealer || '',
      scanType: req.body.scanType || req.body.action || req.body.type || '',
      qty: req.body.qty || req.body.quantity || '',
      deviceId: req.body.deviceId || '',
      hasRawScan: Boolean(rawScanInput)
    });
    const parsed = parseRawScan(rawScanInput);
    const explicitPartInput = firstValue(req.body, ['part', 'partNumber', 'partNo', 'sku', 'itemCode']);
    const part = upper(parsed.part || explicitPartInput);
    const normalizedPartNumber = normalizePartNumber(part);
    const requestedDealerCode = upper(req.body.dealerCode || req.body.dealer || parsed.dealerCode || '');
    let validation = null;
    let master = null;
    if (!requestedDealerCode) {
      validation = await masterValidation.validatePartAgainstMaster({
        partNumber: normalizedPartNumber,
        dealerCode: '',
        rawScannedValue: rawScanInput || parsed.rawScan || part,
        logger: SCAN_VERBOSE_LOGS ? console : null
      });
      master = validation.master;
    }

    const dealerCode = requestedDealerCode || upper(master ? master.dealerCode : '');
    const dealer = dealerCode ? await Dealer.findOne({ dealerCode }).lean() : null;
    const auditId = String(req.body.auditId || parsed.auditId || (dealer ? dealer.currentAuditId : '') || '').trim();
    
    // Check if audit is completed - prevent scanning
    if (auditId) {
      const audit = await Audit.findOne({ auditId }).lean();
      if (audit && isCompletedAudit(audit)) {
        return res.status(403).json({ 
          success: false, 
          message: 'Scanning is not allowed for completed audits. Only admin can reopen this audit.',
          auditCompleted: true
        });
      }
    }

    const type = normalizeScanType(req.body.type || req.body.scanType || req.body.action || parsed.type || 'INWARD');
    const timestamp = new Date();
    if (type === 'VERIFICATION') {
      if (!part) return res.status(400).json({ success: false, message: 'Part number is required' });
      const result = await verifyPartOnly({
        rawScan: String(rawScanInput || parsed.rawScan || part),
        partNumber: part,
        dealerCode,
        auditId
      });
      return res.json(result);
    }
    const mobileTime = firstValue(req.body, ['timestamp', 'scanTime', 'scannedAt', 'scanDateTime', 'dateTime', 'createdAt', 'localCreatedAt', 'localTimestamp']);
    scanDebug('[SCAN TIME] web/server scan received', {
      deviceId: req.body.deviceId || '',
      partNumber: part,
      dealerCode,
      scanType: type,
      ...dateDebugPayload({
        serverTime: timestamp,
        mobileTime,
        savedTime: timestamp
      })
    });
    let binLocation = String(firstValue(req.body, ['binLocation', 'bin', 'location']) || parsed.bin || '').trim().toUpperCase();
    const regdNo = upper(firstValue(req.body, ['regdNo', 'regNo', 'registrationNo', 'vehicleRegNo']));
    const jobCardNo = upper(firstValue(req.body, ['jobCardNo', 'jobcardNo', 'jobCard', 'jobNo']));
    let autoDetectedBin = false;
    let binSelectionMode = ['INWARD', 'DAMAGE'].includes(type) ? 'MANUAL' : '';
    let stockDeductedFromBin = '';
    if (type === 'FITTED') {
      binLocation = '';
      binSelectionMode = '';
    }
    if (type === 'OUTWARD') {
      const detected = await autoDetectOutwardBin({ dealerCode, auditId, partNumber: part });
      if (!detected || !detected.binLocation) {
        return res.status(409).json({ success: false, message: NO_OUTWARD_STOCK_MESSAGE });
      }
      binLocation = detected.binLocation;
      autoDetectedBin = true;
      binSelectionMode = 'AUTO';
      stockDeductedFromBin = detected.binLocation;
    }
    const upiId = extractUpiId(req.body, parsed);
    const upiNo = upiId;
    const rawPartOnlyManualEntry = sourceLooksManual(req.body)
      && rawScanInput
      && explicitPartInput
      && normalizePartNumber(rawScanInput) === normalizePartNumber(explicitPartInput);
    const rawScanText = rawPartOnlyManualEntry ? '' : String(rawScanInput || parsed.rawScan || '');
    const entrySource = normalizeSource(
      firstValue(req.body, ['entryMode', 'scanMode', 'scanSource', 'source']),
      rawScanText || upiId ? 'barcode' : 'manual'
    );
    const manualEntryMode = isManualEntryMode(req.body, rawScanText, upiId);
    const bodyMrpCandidate = optionalNumber(firstValue(req.body, ['mrp', 'manualMRP', 'manualMrp', 'manualEnteredMRP', 'valuationMRP', 'finalMRP']));
    const bodyDlcCandidate = optionalNumber(firstValue(req.body, ['dlc', 'manualDLC', 'manualDlc', 'manualEnteredDLC', 'manualEnteredDlc']));
    const preBodyMrpProvided = booleanFlag(req.body.mrpProvided) || (manualEntryMode && bodyMrpCandidate !== undefined);
    const preParsedMrpProvided = booleanFlag(parsed.mrpProvided);
    const preMrpProvided = preBodyMrpProvided || preParsedMrpProvided;
    const preScannedMrp = preMrpProvided ? optionalNumber(preBodyMrpProvided ? bodyMrpCandidate : parsed.mrp) : undefined;
    const qtyInput = firstValue(req.body, ['qty', 'quantity', 'count']);
    const qtyCandidate = qtyInput !== undefined && qtyInput !== null && String(qtyInput).trim() !== ''
      ? optionalNumber(qtyInput)
      : optionalNumber(parsed.qty);
    const preQty = qtyCandidate !== undefined ? qtyCandidate : 1;
    if (qtyInput !== undefined && qtyInput !== null && String(qtyInput).trim() !== '' && qtyCandidate === undefined) {
      return res.status(400).json({ success: false, message: 'Quantity must be numeric.' });
    }
    if (!(Number(preQty) > 0)) {
      return res.status(400).json({ success: false, message: 'Quantity must be greater than zero.' });
    }
    if (manualEntryMode && !(Number(preScannedMrp || 0) > 0)) {
      return res.status(400).json({ success: false, message: 'MRP is mandatory for manual part entry.' });
    }
    const duplicateIdentityRaw = rawScanText || upiNo;
    const serverSavedStatus = normalizedSyncStatus({
      ...req.body,
      source: entrySource,
      scanMode: req.body.scanMode || (entrySource === 'manual' ? 'Manual' : 'Barcode/Web Scan')
    });
    const requestUser = {
      userId: String(req.body.userId || req.body.loginId || (req.user ? req.user.id : '') || '').trim(),
      loginId: String(req.body.loginId || req.body.userId || (req.user ? req.user.username || req.user.email : '') || '').trim(),
      staffName: String(req.body.staffName || parsed.staffName || (req.user ? req.user.name : '') || '').trim(),
      userName: String(req.body.userName || req.body.staffName || parsed.userName || parsed.staffName || (req.user ? req.user.name || req.user.username : '') || '').trim()
    };
    const duplicateUserKey = requestUser.userId || requestUser.loginId || requestUser.userName || requestUser.staffName;
    const serverSavedSynced = serverSavedStatus === 'synced';
    const syncKey = String(req.body.syncKey || buildSyncKey({ dealerCode, upiId, partNumber: part, scanType: type, timestamp })).trim();
    const uniqueScanId = scanIdentity({ ...req.body, syncKey }, parsed);
    const manualAddRequestId = manualEntryMode
      ? clean(req.body.manualAddRequestId || uniqueScanId)
      : '';
    const rawUpiHash = duplicatePolicy.rawUpiHash({
      ...req.body,
      dealerCode,
      auditId,
      scanType: type,
      partNumber: part,
      rawScanString: rawScanText,
      upiId,
      upiNo
    });
    const qrFingerprint = duplicateIdentityRaw ? makeQrFingerprint({
      ...req.body,
      dealerCode,
      auditId,
      scanType: type,
      partNumber: part,
      upiId,
      rawScanString: rawScanText,
      binLocation,
      userId: requestUser.userId,
      loginId: requestUser.loginId,
      userName: requestUser.userName || requestUser.staffName
    }) : '';
    const finalQrFingerprint = type === 'FITTED' ? '' : (type === 'OUTWARD' && qrFingerprint ? `OUTWARD:${qrFingerprint}` : qrFingerprint);
    const duplicateQuery = type === 'FITTED' ? null : duplicateScanFilter(uniqueScanId, finalQrFingerprint, dealerCode, rawScanText, upiNo, binLocation, auditId, duplicateUserKey, type);
    let existing = null;
    let duplicateReason = '';
    let duplicateMessage = '';
    let manualBinDuplicate = false;
    if (manualEntryMode && ['INWARD', 'DAMAGE'].includes(type) && binLocation) {
      const manualDuplicateFilter = duplicatePolicy.manualBinDuplicateFilter({
        dealerCode,
        auditId,
        partNumber: part,
        scanType: type,
        binLocation
      });
      existing = manualDuplicateFilter
        ? await Inventory.findOne(manualDuplicateFilter).sort({ timestamp: 1, createdAt: 1 }).lean()
        : null;
      manualBinDuplicate = Boolean(existing);
    }
    if (!existing && type === 'FITTED' && regdNo && jobCardNo) {
      existing = await Inventory.findOne(fittedIdentityFilter({ dealerCode, partNumber: part, regdNo, jobCardNo, auditId })).lean();
    } else if (!existing && type === 'OUTWARD') {
      existing = rawScanText ? await Inventory.findOne(outwardDoneFilter(rawScanText, dealerCode, auditId)).lean() : null;
      if (existing) {
        duplicateReason = 'Duplicate QR/UPI already outwarded';
        duplicateMessage = 'This QR/UPI is already outwarded and cannot be outwarded again.';
      }
    } else if (!existing) {
      existing = duplicateQuery ? await Inventory.findOne(duplicateQuery).lean() : null;
    }
    if (!existing && type !== 'FITTED') {
      const backendDuplicate = await findBackendDuplicate({
        ...req.body,
        uniqueScanId,
        scanId: uniqueScanId,
        syncKey,
        rawUpiHash,
        qrFingerprint: finalQrFingerprint,
        partNumber: part,
        dealerCode,
        auditId,
        scanType: type,
        rawScan: rawScanText,
        rawScanString: rawScanText,
        rawUpi: rawScanText,
        upiNo,
        upiId
      });
      if (backendDuplicate) {
        existing = backendDuplicate.existing;
        duplicateReason = backendDuplicate.reason;
        duplicateMessage = backendDuplicate.message;
      }
    }
    if (existing) {
      if (manualBinDuplicate) {
        if (manualAddRequestId && existing.lastManualAddRequestId === manualAddRequestId) {
          const publicRow = publicScan(existing);
          const currentQty = numberValue(publicRow.qty !== undefined ? publicRow.qty : publicRow.quantity, 0);
          return res.json({
            success: true,
            updated: true,
            duplicate: false,
            alreadyApplied: true,
            addedQuantity: 0,
            newQuantity: currentQty,
            message: `This manual save was already applied. Current quantity: ${currentQty}.`,
            scan: publicRow
          });
        }
        if (booleanFlag(req.body.addManualQuantity || req.body.confirmAddQuantity)) {
          const result = await addManualQuantity(existing, { ...req.body, qty: preQty }, req);
          if (result.error) return res.status(400).json({ success: false, message: result.error });
          const newQty = numberValue(result.updated.qty !== undefined ? result.updated.qty : result.updated.quantity, 0);
          return res.json({
            success: true,
            updated: true,
            duplicate: false,
            alreadyApplied: result.alreadyApplied,
            addedQuantity: result.addQty,
            newQuantity: newQty,
            message: result.alreadyApplied
              ? `Quantity was already added. Current quantity: ${newQty}.`
              : `Added ${result.addQty} more. New quantity: ${newQty}.`,
            scan: result.updated
          });
        }
        return res.status(409).json({
          success: false,
          duplicate: true,
          skipped: true,
          ...manualDuplicatePayload(existing, preQty),
          scan: publicScan(existing)
        });
      }
      existing = await backfillDuplicateMrp(existing, {
        partNumber: part,
        rawScanText,
        scannedMrp: preScannedMrp,
        mrpProvided: preMrpProvided,
        entrySource,
        manualEntryMode,
        qty: preQty,
        timestamp
      });
      if (type === 'FITTED') {
        if (booleanFlag(req.body.addFittedQuantity || req.body.confirmAddQuantity)) {
          const addQty = numberValue(firstValue(req.body, ['qty', 'quantity', 'count']) || parsed.qty, 1);
          const updated = await Inventory.findByIdAndUpdate(existing._id, {
            $inc: { qty: addQty, quantity: addQty, fittedQty: addQty },
            $set: {
              fittedLocation: 'VEHICLE',
              status: 'FITTED_ON_VEHICLE',
              syncStatus: 'synced',
              synced: true,
              isSynced: true
            }
          }, { new: true }).lean();
          if (req.io) {
            req.io.emit('scan:saved', publicScan(updated || existing));
            req.io.emit('stats:update');
          }
          return res.json({
            success: true,
            updated: true,
            duplicate: false,
            message: 'Fitted part quantity updated for this vehicle/job card',
            scan: updated || existing
          });
        }
        return res.status(409).json({
          success: false,
          duplicate: true,
          fittedDuplicate: true,
          message: 'This fitted part already exists for this vehicle/job card. Add quantity?',
          scan: existing
        });
      }
      logDuplicateScan({
        ...req.body,
        uniqueScanId,
        scanId: uniqueScanId,
        qrFingerprint: finalQrFingerprint,
        rawUpiHash,
        partNumber: part,
        dealerCode,
        binLocation,
        scanType: type,
        rawScan: rawScanText,
        upiNo
      }, existing).catch(() => undefined);
      if (req.io) {
        req.io.emit('scan:duplicate', publicScan(existing));
        req.io.emit('stats:update');
      }
      return res.status(409).json({
        success: false,
        skipped: true,
        duplicate: true,
        message: duplicateMessage || `${duplicatePolicy.DUPLICATE_PART_MESSAGE} First scanned by ${existing.userName || existing.staffName || existing.loginId || 'Unknown'}, at ${formatIstDateTime(existing.timestamp) || '-'}, Bin ${existing.binLocation || existing.bin || '-'}.`,
        reason: duplicateReason || duplicatePolicy.DUPLICATE_PART_MESSAGE,
        scan: existing
      });
    }

    if (!validation) {
      validation = await masterValidation.validatePartAgainstMaster({
        partNumber: normalizedPartNumber,
        dealerCode,
        rawScannedValue: rawScanInput || parsed.rawScan || part,
        logger: SCAN_VERBOSE_LOGS ? console : null
      });
      master = validation.master;
    }

    if (!part) {
      scanDebug('[MANUAL SCAN] validation failed', { reason: 'Part number is required', parsed });
      return res.status(400).json({ success: false, message: 'Part number is required' });
    }
    if (!isValidPartNumber(part)) {
      scanDebug('[MANUAL SCAN] validation failed', { reason: 'Invalid part number format', part, rawScanInput });
      return res.status(400).json({ success: false, message: 'Invalid part number format' });
    }
    if (['INWARD', 'DAMAGE'].includes(type) && !binLocation) {
      scanDebug('[MANUAL SCAN] validation failed', { reason: BIN_REQUIRED_MESSAGE, part });
      return res.status(400).json({ success: false, message: BIN_REQUIRED_MESSAGE });
    }
    if (type === 'FITTED' && (!regdNo || !jobCardNo)) {
      const message = 'Regd No and Job Card No are required for fitted parts.';
      scanDebug('[MANUAL SCAN] validation failed', { reason: message, part });
      return res.status(400).json({ success: false, message });
    }
    if (!dealerCode) {
      scanDebug('[MANUAL SCAN] validation failed', { reason: 'Dealer code is required', part });
      return res.status(400).json({ success: false, message: 'Dealer code is required' });
    }
    if (!dealer) {
      scanDebug('[MANUAL SCAN] validation failed', { reason: 'Invalid dealer code', dealerCode, part });
      return res.status(400).json({ success: false, message: 'Valid dealer code is required' });
    }
    if (!VALID_TYPES.includes(type)) {
      scanDebug('[MANUAL SCAN] validation failed', { reason: 'Invalid scan type', type, part, dealerCode });
      return res.status(400).json({ success: false, message: 'Invalid scan type' });
    }
    const role = String(req.body.role || (req.user ? req.user.role : '') || '').trim().toLowerCase();
    const roleError = roleScanError(role, type);
    if (roleError) return res.status(403).json({ success: false, message: roleError });

    const qty = preQty;
    const bodyMrpProvided = preBodyMrpProvided;
    const bodyDlcProvided = booleanFlag(req.body.dlcProvided) || bodyDlcCandidate !== undefined;
    const parsedMrpProvided = preParsedMrpProvided;
    const parsedDlcProvided = booleanFlag(parsed.dlcProvided);
    const mrpProvided = preMrpProvided;
    const dlcProvided = bodyDlcProvided || parsedDlcProvided;
    const scannedMrp = preScannedMrp;
    const scannedDlc = dlcProvided ? optionalNumber(bodyDlcProvided ? bodyDlcCandidate : parsed.dlc) : undefined;
    const finalDlc = scannedDlc !== undefined
      ? scannedDlc
      : master && master.dlc !== undefined
        ? Number(master.dlc || 0)
        : numberValue(parsed.dlc, 0);
    const valueFields = valuationFields({ rawScanText, scannedMrp, mrpProvided, entrySource, manualEntryMode });
    const finalMRP = Number(valueFields.valuationMRP || 0);
    const defaultMRP = 0;
    const mrpStatus = finalMRP > 0 ? 'AVAILABLE' : 'PENDING';
    const valueFieldsWithFinalMRP = {
      ...valueFields,
      finalInventoryValue: Number(qty || 0) * finalMRP
    };
    
    const pricePeriod = finalMRP > 0 ? await findPricePeriod(part, timestamp, finalMRP) : null;
    const pricePeriodFields = pricePeriodPayload(pricePeriod, finalMRP);
    const candidate = {
      part,
      dealerCode,
      auditId,
      rawScan: rawScanText,
      rawScanProvided: Boolean(rawScanInput || parsed.rawScan),
      mrp: valueFieldsWithFinalMRP.valuationMRP || scannedMrp,
      mrpProvided,
      dlc: scannedDlc,
      dlcProvided
    };

    const warnings = await validateScan(candidate, master, timestamp, pricePeriod);
    if (!master && manualEntryMode) {
      warnings.push('Manual part saved without master catalogue match');
    }
    let scan;
    try {
      scan = await Inventory.create({
      uniqueScanId,
      scanId: uniqueScanId,
      qrFingerprint: finalQrFingerprint,
      rawUpiHash,
      part,
      partNumber: part,
      normalizedPartNumber,
      partName: master ? master.partName : String(req.body.partName || ''),
      partDescription: master ? (master.partDescription || master.partName || '') : String(req.body.partDescription || req.body.partName || ''),
      model: master ? master.model : String(req.body.model || ''),
      year: master ? (master.manufacturingYear || master.year) : String(req.body.manufacturingYear || req.body.year || ''),
      manufacturingYear: master ? (master.manufacturingYear || master.year) : String(req.body.manufacturingYear || req.body.year || ''),
      category: normalizeCategory(master ? (master.productCategory || master.category) : String(req.body.productCategory || req.body.category || '')),
      productCategory: normalizeCategory(master ? (master.productCategory || master.category) : String(req.body.productCategory || req.body.category || '')),
      productGroup: master ? master.productGroup || '' : String(req.body.productGroup || '').toUpperCase(),
      productType: master ? master.productType || '' : String(req.body.productType || '').toUpperCase(),
      superceededBy: master ? master.superceededBy || '' : String(req.body.superceededBy || '').toUpperCase(),
      partGroup: master ? master.partGroup || '' : String(req.body.partGroup || '').toUpperCase(),
      partSubGroup: master ? master.partSubGroup || '' : String(req.body.partSubGroup || '').toUpperCase(),
      gstCategory: master ? master.gstCategory || '' : String(req.body.gstCategory || '').toUpperCase(),
      qty,
      quantity: qty,
      mrp: valueFieldsWithFinalMRP.mrp,
      scanMRP: valueFieldsWithFinalMRP.scanMRP,
      manualMRP: valueFieldsWithFinalMRP.manualMRP,
      valuationMRP: valueFieldsWithFinalMRP.valuationMRP,
      valuationSource: valueFieldsWithFinalMRP.valuationSource,
      finalInventoryValue: valueFieldsWithFinalMRP.finalInventoryValue,
      // NEW MRP Management fields
      defaultMRP,
      finalMRP,
      mrpStatus,
      mrpPendingUpdatedAt: mrpStatus === 'UPDATED' ? timestamp : null,
      ...pricePeriodFields,
      dlc: finalDlc,
      bin: binLocation,
      binLocation,
      autoDetectedBin,
      binSelectionMode,
      regdNo,
      jobCardNo,
      isFitted: type === 'FITTED',
      fittedQty: type === 'FITTED' ? qty : 0,
      fittedLocation: type === 'FITTED' ? 'VEHICLE' : '',
      status: type === 'FITTED' ? 'FITTED_ON_VEHICLE' : '',
      stockDeductedFromBin,
      type,
      scanType: type,
      upiId,
      upiNo,
      dealerCode,
      dealerName: dealer ? dealer.dealerName : String(req.body.dealerName || ''),
      auditId,
      rawScan: candidate.rawScan,
      rawScanString: candidate.rawScan,
      rawBarcode: candidate.rawScan,
      rawQR: candidate.rawScan,
      rawUpi: candidate.rawScan,
      source: entrySource,
      scanMode: req.body.scanMode || (entrySource === 'manual' ? 'Manual' : 'Barcode/Web Scan'),
      deviceId: String(req.body.deviceId || ''),
      deviceName: String(req.body.deviceName || req.body.device || ''),
      userId: String(req.body.userId || req.body.loginId || (req.user ? req.user.id : '') || ''),
      loginId: String(req.body.loginId || req.body.userId || (req.user ? req.user.username || req.user.email : '') || ''),
      staffName: String(req.body.staffName || parsed.staffName || (req.user ? req.user.name : '') || ''),
      userName: String(req.body.userName || req.body.staffName || parsed.userName || parsed.staffName || (req.user ? req.user.name || req.user.username : '') || ''),
      role,
      timestamp,
      scanTime: timestamp,
      serverReceivedAt: timestamp,
      mobileReceivedTime: mobileTime || '',
      mobileReceivedTimeUtc: validDate(mobileTime)?.toISOString() || '',
      synced: serverSavedSynced,
      isSynced: serverSavedSynced,
      syncStatus: serverSavedStatus,
      scanStatus: type === 'OUTWARD' ? 'OUTWARD_DONE' : 'ACCEPTED',
      syncError: '',
      syncKey,
      lastManualAddRequestId: manualAddRequestId,
      warnings,
      remarks: warnings.join(', '),
      masterFound: Boolean(master),
      masterMatch: Boolean(master),
      isMasterMatched: Boolean(master),
      overrideBy: warnings.length && req.user ? req.user.username || req.user.name : ''
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      let duplicate = duplicateQuery ? await Inventory.findOne(duplicateQuery).lean() : null;
      if (!duplicate) {
        const backendDuplicate = await findBackendDuplicate({
          ...req.body,
          uniqueScanId,
          scanId: uniqueScanId,
          syncKey,
          rawUpiHash,
          qrFingerprint: finalQrFingerprint,
          partNumber: part,
          dealerCode,
          auditId,
          scanType: type,
          rawScan: rawScanText,
          rawScanString: rawScanText,
          rawUpi: rawScanText,
          upiNo,
          upiId
        });
        duplicate = backendDuplicate && backendDuplicate.existing;
      }
      if (duplicate) {
        duplicate = await backfillDuplicateMrp(duplicate, {
          partNumber: part,
          rawScanText,
          scannedMrp: preScannedMrp,
          mrpProvided: preMrpProvided,
          entrySource,
          manualEntryMode,
          qty,
          timestamp
        });
        logDuplicateScan({
          ...req.body,
          uniqueScanId,
          scanId: uniqueScanId,
          qrFingerprint: finalQrFingerprint,
          rawUpiHash,
          partNumber: part,
          dealerCode,
          binLocation,
          scanType: type,
          rawScan: candidate.rawScan
        }, duplicate).catch(() => undefined);
        if (req.io) {
          req.io.emit('scan:duplicate', publicScan(duplicate));
          req.io.emit('stats:update');
        }
        return res.status(409).json({
          success: false,
          skipped: true,
          duplicate: true,
          message: duplicatePolicy.DUPLICATE_PART_MESSAGE,
          reason: duplicatePolicy.DUPLICATE_PART_MESSAGE,
          scan: duplicate
        });
      }
      throw error;
    }

    scanDebug('[SCAN TIME] saved MongoDB timestamp verified', {
      id: scan._id,
      partNumber: scan.partNumber,
      dealerCode: scan.dealerCode,
      scanType: scan.scanType,
      deviceId: scan.deviceId,
      ...dateDebugPayload({
        serverTime: timestamp,
        mobileTime,
        savedTime: scan.timestamp || scan.createdAt
      })
    });
    scanDebug('[MANUAL SCAN] DB insert success', { id: scan._id, partNumber: scan.partNumber, dealerCode: scan.dealerCode, scanType: scan.scanType, deviceId: scan.deviceId });
    scanDebug('SAVED_VALID_SCAN', { id: scan._id, partNumber: scan.partNumber, dealerCode: scan.dealerCode });
    scanDebug("Matched category:", scan.category || '');
    scanDebug("Matched partDescription:", scan.partDescription || scan.partName || '');
    emitScanUpdate(req, scan).catch((error) => console.warn('[MANUAL SCAN] realtime refresh failed', error.message));
    res.status(201).json({ success: true, scan, warnings, message: type === 'FITTED' ? 'Fitted part saved successfully' : 'Scan saved successfully' });
  } catch (error) {
    console.error('[MANUAL SCAN] save failed', { message: error.message, stack: error.stack });
    res.status(500).json({ success: false, message: error.message });
  }
}

function normalizeBluetoothMode(value, fallback = 'Any') {
  const text = clean(value || fallback).toLowerCase();
  if (text === 'inward') return 'Inward';
  if (text === 'outward') return 'Outward';
  if (text === 'verification' || text === 'verify' || text === 'audit') return 'Verification';
  return 'Any';
}

function bluetoothScanTypeFromMode(deviceMode, body = {}) {
  const assigned = normalizeBluetoothMode(deviceMode);
  if (assigned === 'Inward') return 'INWARD';
  if (assigned === 'Outward') return 'OUTWARD';
  if (assigned === 'Verification') return 'VERIFICATION';
  const requested = normalizeBluetoothMode(body.activeMode || body.assignedMode || body.scanMode || body.mode || body.scanType || body.type, '');
  if (requested === 'Inward') return 'INWARD';
  if (requested === 'Outward') return 'OUTWARD';
  if (requested === 'Verification') return 'VERIFICATION';
  const explicit = upper(body.scanType || body.type || body.action);
  if (VALID_TYPES.includes(explicit)) return explicit;
  return 'INWARD';
}

function bluetoothTransactionId(body = {}, deviceId = '') {
  return clean(body.transactionId || body.scanTransactionId || body.scanId || body.uniqueScanId)
    || `BT-${clean(deviceId).replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40) || 'SCANNER'}-${Date.now()}-${randomUUID()}`;
}

function enqueueBluetoothScan(job) {
  const run = bluetoothScanQueue.catch(() => null).then(job);
  bluetoothScanQueue = run.catch(() => null);
  return run;
}

async function rejectBluetoothScan(res, statusCode, payload, logPayload = {}, devicePatch = null) {
  if (logPayload.transactionId) {
    await BluetoothScanLog.create({
      source: 'Bluetooth Scanner',
      scanTime: new Date(),
      ...logPayload
    }).catch(() => null);
  }
  if (devicePatch && logPayload.deviceId) {
    await BluetoothDevice.findOneAndUpdate({ deviceId: logPayload.deviceId }, devicePatch).catch(() => null);
  }
  return res.status(statusCode).json(payload);
}

async function handleBluetoothScan(req, res) {
  const body = req.body || {};
  const deviceId = clean(body.deviceId || body.macAddress || body.device);
  const scanValue = clean(firstValue(body, ['scanValue', 'rawScan', 'rawScanString', 'rawBarcode', 'rawScanValue', 'barcode', 'barcodeValue', 'scanText', 'raw']));
  const transactionId = bluetoothTransactionId(body, deviceId);
  const scanTime = new Date();

  if (!deviceId) {
    return rejectBluetoothScan(res, 400, { success: false, message: 'Bluetooth device ID is required' }, {
      transactionId,
      scanValue,
      scanTime,
      status: 'error',
      errorMessage: 'Bluetooth device ID is required'
    });
  }
  if (!scanValue) {
    return rejectBluetoothScan(res, 400, { success: false, message: 'Scan value is required' }, {
      transactionId,
      deviceId,
      scanValue,
      scanTime,
      status: 'error',
      errorMessage: 'Scan value is required'
    });
  }

  let device = await BluetoothDevice.findOne({ deviceId, isActive: { $ne: false } });
  if (!device) {
    device = await BluetoothDevice.create({
      deviceId,
      deviceName: clean(body.deviceName || body.device || 'Bluetooth Scanner'),
      macAddress: upper(body.macAddress),
      approvalStatus: 'pending',
      connectionStatus: 'connected',
      dealerCode: upper(body.dealerCode),
      lastScanValue: scanValue,
      lastScanAt: scanTime,
      lastError: 'Pending admin approval'
    });
    if (req.io) req.io.emit('bluetooth-devices:update', { deviceId, at: new Date() });
    return rejectBluetoothScan(res, 403, {
      success: false,
      pendingApproval: true,
      message: 'Bluetooth scanner is pending admin approval'
    }, {
      transactionId,
      deviceId,
      deviceName: device.deviceName,
      dealerCode: device.dealerCode,
      scanMode: device.assignedMode,
      scanValue,
      scanTime,
      status: 'rejected',
      errorMessage: 'Pending admin approval'
    });
  }

  const approvalStatus = clean(device.approvalStatus || 'pending').toLowerCase();
  if (approvalStatus !== 'approved') {
    const blocked = approvalStatus === 'blocked' || approvalStatus === 'rejected';
    const errorMessage = blocked ? `Bluetooth scanner ${approvalStatus}` : 'Bluetooth scanner is pending admin approval';
    return rejectBluetoothScan(res, 403, {
      success: false,
      ignored: blocked,
      pendingApproval: approvalStatus === 'pending',
      message: errorMessage
    }, {
      transactionId,
      deviceId,
      deviceName: device.deviceName,
      userId: device.assignedUserId,
      userName: device.assignedUserName,
      dealerCode: device.dealerCode || upper(body.dealerCode),
      scanMode: device.assignedMode,
      scanValue,
      scanTime,
      status: approvalStatus === 'blocked' ? 'blocked' : 'rejected',
      errorMessage
    }, {
      lastScanValue: scanValue,
      lastScanAt: scanTime,
      lastError: errorMessage
    });
  }

  const assignedMode = normalizeBluetoothMode(device.assignedMode);
  const scanType = bluetoothScanTypeFromMode(assignedMode, body);
  const userId = clean(device.assignedUserId || body.userId || body.loginId || (req.user && req.user.id));
  const userName = clean(device.assignedUserName || body.userName || body.staffName || (req.user && (req.user.name || req.user.username)) || userId);
  const dealerCode = upper(body.dealerCode || device.dealerCode);

  await BluetoothScanLog.create({
    transactionId,
    deviceId,
    deviceName: device.deviceName,
    userId,
    userName,
    scanMode: assignedMode,
    dealerCode,
    scanValue,
    scanTime,
    status: 'pending',
    source: 'Bluetooth Scanner'
  });

  const originalBody = req.body;
  req.body = {
    ...body,
    transactionId,
    uniqueScanId: transactionId,
    scanId: transactionId,
    localId: transactionId,
    rawScan: scanValue,
    rawScanString: scanValue,
    rawBarcode: scanValue,
    rawScanValue: scanValue,
    barcode: scanValue,
    barcodeValue: scanValue,
    scanValue,
    scanText: scanValue,
    deviceId,
    deviceName: device.deviceName,
    userId,
    loginId: clean(body.loginId || userId),
    userName,
    staffName: userName,
    dealerCode,
    scanType,
    type: scanType,
    source: 'Bluetooth Scanner',
    scanSource: 'Bluetooth Scanner',
    scanMode: 'Bluetooth Scanner',
    synced: true,
    isSynced: true,
    syncStatus: 'synced'
  };

  const originalStatus = res.status.bind(res);
  const originalJson = res.json.bind(res);
  let responseStatus = res.statusCode || 200;

  res.status = function patchedStatus(code) {
    responseStatus = code;
    return originalStatus(code);
  };

  res.json = function patchedJson(payload) {
    const data = payload && typeof payload === 'object' ? payload : { message: String(payload || '') };
    const ok = responseStatus < 400 && data.success !== false;
    const duplicate = ok && data.duplicate === true;
    const logStatus = ok ? (duplicate ? 'duplicate' : 'accepted') : 'error';
    const errorMessage = ok ? (duplicate ? data.message || 'Duplicate scan skipped' : '') : data.message || 'Bluetooth scan failed';
    const inventoryScanId = data.scan ? clean(data.scan.scanId || data.scan.uniqueScanId || data.scan._id) : '';
    const deviceUpdate = {
      connectionStatus: ok ? 'connected' : 'error',
      lastScanValue: scanValue,
      lastScanAt: scanTime,
      lastError: errorMessage,
      lastConnectedAt: ok ? new Date() : device.lastConnectedAt
    };
    if (ok && dealerCode && !device.dealerCode) deviceUpdate.dealerCode = dealerCode;
    Promise.all([
      BluetoothScanLog.findOneAndUpdate(
        { transactionId },
        { status: logStatus, errorMessage, inventoryScanId },
        { new: true }
      ),
      BluetoothDevice.findOneAndUpdate({ deviceId }, deviceUpdate, { new: true })
    ])
      .catch((error) => console.warn('[BLUETOOTH SCAN] status update failed', error.message))
      .finally(() => {
        if (req.io) {
          req.io.emit('bluetooth-devices:update', { deviceId, transactionId, status: logStatus, at: new Date() });
          req.io.emit('devices:update', { deviceId, at: new Date() });
        }
        data.bluetooth = { transactionId, deviceId, status: logStatus, source: 'Bluetooth Scanner' };
        originalJson(data);
      });
    return res;
  };

  try {
    await saveScanRequest(req, res);
  } finally {
    req.body = originalBody;
  }
}

router.post('/bluetooth', auth.optionalAuth, async (req, res) => {
  return res.status(410).json({ success: false, disabled: true, message: 'Bluetooth scanner features are disabled.' });
});

async function verifyPartRequest(req, res) {
  try {
    const rawScan = firstValue(req.body || {}, ['rawScan', 'rawScanString', 'rawBarcode', 'rawScanValue', 'barcode', 'barcodeValue', 'scanValue', 'scanText', 'value'])
      || firstValue(req.query || {}, ['rawScan', 'rawScanString', 'rawBarcode', 'rawScanValue', 'barcode', 'barcodeValue', 'scanValue', 'scanText', 'value']);
    const parsed = parseRawScan(rawScan);
    const partNumber = upper(parsed.part || firstValue(req.body || {}, ['part', 'partNumber', 'partNo', 'sku', 'itemCode'])
      || firstValue(req.query || {}, ['part', 'partNumber', 'partNo', 'sku', 'itemCode']));
    const dealerCode = normalizeDealerCode(firstValue(req.body || {}, ['dealerCode', 'dealer'])
      || firstValue(req.query || {}, ['dealerCode', 'dealer']));
    const auditId = clean(firstValue(req.body || {}, ['auditId', 'audit'])
      || firstValue(req.query || {}, ['auditId', 'audit']));
    if (!rawScan && !partNumber) return res.status(400).json({ success: false, message: 'Part number is required' });
    const result = await verifyPartOnly({
      rawScan: String(rawScan || parsed.rawScan || partNumber),
      partNumber,
      dealerCode,
      auditId
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

router.get('/verify', auth.optionalAuth, verifyPartRequest);
router.post('/verify', auth.optionalAuth, verifyPartRequest);
router.post('/scan', auth.optionalAuth, saveScanRequest);
router.post('/manual', auth.optionalAuth, saveScanRequest);
router.post('/', auth.optionalAuth, saveScanRequest);
router.patch('/:scanId/details', auth.requireAuth, updateScanDetails);
router.patch('/:scanId/mrp', auth.requireAuth, updateManualMrp);
router.post('/sync', auth.optionalAuth, async (req, res) => {
  try {
    const incoming = Array.isArray(req.body.scans) ? req.body.scans : [];
    const failed = [];
    const saved = [];
    const verificationResults = [];
    let skipped = 0;

    for (const item of incoming) {
      try {
        const rawScanInput = firstValue(item, ['rawScan', 'rawScanString', 'rawBarcode', 'rawScanValue', 'barcode', 'barcodeValue', 'scanValue', 'scanText', 'raw']);
        const parsed = parseRawScan(rawScanInput || item.part);
        const part = upper(parsed.part || firstValue(item, ['part', 'partNo', 'partNumber', 'sku', 'itemCode']));
        const normalizedPartNumber = normalizePartNumber(part);
        const master = part ? await findMasterPart(normalizedPartNumber, item.dealerCode || parsed.dealerCode) : null;

        const dealerCode = upper(item.dealerCode || item.dealer || parsed.dealerCode || (master ? master.dealerCode : ''));
        const type = normalizeScanType(item.type || item.scanType || item.action || parsed.type || 'INWARD');
        const timestamp = scanTimestamp(item);
        const binLocation = String(firstValue(item, ['binLocation', 'bin', 'location']) || parsed.bin || '').trim().toUpperCase();
        const upiId = extractUpiId(item, parsed);
        const upiNo = upiId;
        const rawScanText = String(rawScanInput || parsed.rawScan || part);
        const entrySource = normalizeSource(
          firstValue(item, ['entryMode', 'scanMode', 'scanSource', 'source']),
          rawScanText || upiId ? 'barcode' : 'mobile'
        );
        const manualEntryMode = isManualEntryMode(item, rawScanText, upiId, 'mobile');
        const syncKey = String(item.syncKey || buildSyncKey({ dealerCode, upiId, partNumber: part, scanType: type, timestamp })).trim();
        const uniqueScanId = scanIdentity({ ...item, syncKey }, parsed);
        const dealer = dealerCode ? await Dealer.findOne({ dealerCode }).lean() : null;
        const auditId = String(item.auditId || (dealer ? dealer.currentAuditId : '') || '').trim();
        const qtyInput = firstValue(item, ['qty', 'quantity', 'count']);
        const qtyCandidate = qtyInput !== undefined && qtyInput !== null && String(qtyInput).trim() !== ''
          ? optionalNumber(qtyInput)
          : optionalNumber(parsed.qty);
        const finalQty = qtyCandidate !== undefined ? qtyCandidate : 1;
        if (qtyInput !== undefined && qtyInput !== null && String(qtyInput).trim() !== '' && qtyCandidate === undefined) {
          failed.push({ uniqueScanId, message: 'Quantity must be numeric.', item });
          continue;
        }
        if (!(Number(finalQty) > 0)) {
          failed.push({ uniqueScanId, message: 'Quantity must be greater than zero.', item });
          continue;
        }
        if (type === 'VERIFICATION') {
          verificationResults.push(await verifyPartOnly({
            rawScan: rawScanText,
            partNumber: part,
            dealerCode,
            auditId
          }));
          continue;
        }
        const qrFingerprint = makeQrFingerprint({
          ...item,
          dealerCode,
          auditId,
          scanType: type,
          partNumber: part,
          upiId,
          rawScanString: rawScanText,
          binLocation,
          userId: item.userId || item.loginId || '',
          loginId: item.loginId || item.userId || '',
          userName: item.userName || item.staffName || ''
        });
        const rawUpiHash = duplicatePolicy.rawUpiHash({
          ...item,
          dealerCode,
          auditId,
          scanType: type,
          partNumber: part,
          rawScanString: rawScanText,
          upiId,
          upiNo
        });
        const itemMrpCandidate = optionalNumber(firstValue(item, ['mrp', 'manualMRP', 'manualMrp', 'manualEnteredMRP', 'valuationMRP', 'finalMRP']));
        const itemDlcCandidate = optionalNumber(firstValue(item, ['dlc', 'manualDLC', 'manualDlc', 'manualEnteredDLC', 'manualEnteredDlc']));
        const itemMrpProvided = booleanFlag(item.mrpProvided) || (manualEntryMode && itemMrpCandidate !== undefined);
        const itemDlcProvided = booleanFlag(item.dlcProvided) || itemDlcCandidate !== undefined;
        const parsedMrpProvided = booleanFlag(parsed.mrpProvided);
        const parsedDlcProvided = booleanFlag(parsed.dlcProvided);
        const mrpProvided = itemMrpProvided || parsedMrpProvided;
        const dlcProvided = itemDlcProvided || parsedDlcProvided;
        const scannedMrp = mrpProvided ? optionalNumber(itemMrpProvided ? itemMrpCandidate : parsed.mrp) : undefined;
        const scannedDlc = dlcProvided ? optionalNumber(itemDlcProvided ? itemDlcCandidate : parsed.dlc) : undefined;
        const finalDlc = scannedDlc !== undefined
          ? scannedDlc
          : master && master.dlc !== undefined
            ? Number(master.dlc || 0)
            : numberValue(parsed.dlc, 0);
        if (manualEntryMode && !(Number(scannedMrp || 0) > 0)) {
          failed.push({ message: 'MRP is mandatory for manual part entry.', item });
          continue;
        }
        const valueFields = valuationFields({ rawScanText, scannedMrp, mrpProvided, entrySource, manualEntryMode });
        const pricePeriod = valueFields.valuationMRP > 0 ? await findPricePeriod(part, timestamp, valueFields.valuationMRP) : null;
        const pricePeriodFields = pricePeriodPayload(pricePeriod, valueFields.valuationMRP);
        let finalBinLocation = binLocation;
        let autoDetectedBin = false;
        let binSelectionMode = ['INWARD', 'DAMAGE'].includes(type) ? 'MANUAL' : '';
        let stockDeductedFromBin = '';
        if (type === 'OUTWARD') {
          const detected = await autoDetectOutwardBin({ dealerCode, auditId, partNumber: part });
          if (!detected || !detected.binLocation) {
            failed.push({ uniqueScanId, message: NO_OUTWARD_STOCK_MESSAGE, item });
            continue;
          }
          finalBinLocation = detected.binLocation;
          autoDetectedBin = true;
          binSelectionMode = 'AUTO';
          stockDeductedFromBin = detected.binLocation;
        }
        const duplicateUserKey = String(item.userId || item.loginId || item.userName || item.staffName || '').trim();
        const duplicateQuery = duplicateScanFilter(uniqueScanId, qrFingerprint, dealerCode, rawScanText, upiNo, finalBinLocation, auditId, duplicateUserKey, type);
        const duplicate = duplicateQuery ? await Inventory.findOne(duplicateQuery).lean() : null;
        const backendDuplicate = duplicate ? null : await findBackendDuplicate({
          ...item,
          uniqueScanId,
          scanId: uniqueScanId,
          syncKey,
          rawUpiHash,
          qrFingerprint,
          partNumber: part,
          dealerCode,
          auditId,
          scanType: type,
          rawScan: rawScanText,
          rawScanString: rawScanText,
          rawUpi: rawScanText,
          upiNo,
          upiId
        });
        const duplicateRecord = duplicate || (backendDuplicate && backendDuplicate.existing);
        if (duplicateRecord) {
          await logDuplicateScan({
            ...item,
            uniqueScanId,
            scanId: uniqueScanId,
            qrFingerprint,
            rawUpiHash,
            partNumber: part,
            dealerCode,
            binLocation: finalBinLocation,
            scanType: type,
            rawScan: rawScanText,
            upiNo
          }, duplicateRecord, backendDuplicate?.reason || duplicatePolicy.DUPLICATE_PART_MESSAGE);
          skipped += 1;
          failed.push({ uniqueScanId, message: backendDuplicate?.message || duplicatePolicy.DUPLICATE_PART_MESSAGE, duplicate: true });
          continue;
        }
        const warnings = [];

        if (!part) warnings.push('Part number missing');
        if (part && !isValidPartNumber(part)) warnings.push('Invalid part number format');
        if (['INWARD', 'DAMAGE'].includes(type) && !finalBinLocation) warnings.push(BIN_REQUIRED_MESSAGE);
        if (!dealerCode) warnings.push('Dealer code missing');
        if (dealerCode && !dealer) warnings.push('Valid dealer code is required');
        if (!VALID_TYPES.includes(type)) warnings.push('Invalid scan type');
        if (!master) warnings.push(`Part number not found in master: ${part}`);
        if (master && !master.activeStatus) warnings.push('Inactive part');
        if (master && mrpProvided && pricePeriod && approxMismatch(valueFields.valuationMRP, pricePeriod.mrp)) warnings.push('MRP mismatch against price history period');
        if (master && mrpProvided && !pricePeriod) warnings.push('No matching price history period for scanned MRP');
        if (master && dlcProvided && approxMismatch(scannedDlc, master.dlc)) warnings.push('DLC mismatch');

        if (!part || !isValidPartNumber(part) || (['INWARD', 'DAMAGE'].includes(type) && !finalBinLocation) || !dealerCode || !dealer || !VALID_TYPES.includes(type)) {
          failed.push({ uniqueScanId, message: warnings.join(', ') });
          continue;
        }

        const scan = await Inventory.create({
          uniqueScanId,
          scanId: uniqueScanId,
          qrFingerprint,
          rawUpiHash,
          part,
          partNumber: part,
          normalizedPartNumber,
          partName: master && master.partName ? master.partName : String(item.partDescription || item.partName || ''),
          partDescription: master ? (master.partDescription || master.partName || '') : String(item.partDescription || item.partName || ''),
          model: master && master.model ? master.model : String(item.model || ''),
          year: master && (master.manufacturingYear || master.year) ? (master.manufacturingYear || master.year) : String(item.manufacturingYear || item.year || ''),
          manufacturingYear: master && (master.manufacturingYear || master.year) ? (master.manufacturingYear || master.year) : String(item.manufacturingYear || item.year || ''),
          category: normalizeCategory(master && (master.productCategory || master.category) ? (master.productCategory || master.category) : String(item.productCategory || item.category || '')),
          productCategory: normalizeCategory(master && (master.productCategory || master.category) ? (master.productCategory || master.category) : String(item.productCategory || item.category || '')),
          productGroup: master ? master.productGroup || '' : String(item.productGroup || '').toUpperCase(),
          productType: master ? master.productType || '' : String(item.productType || '').toUpperCase(),
          superceededBy: master ? master.superceededBy || '' : String(item.superceededBy || '').toUpperCase(),
          partGroup: master ? master.partGroup || '' : String(item.partGroup || '').toUpperCase(),
          partSubGroup: master ? master.partSubGroup || '' : String(item.partSubGroup || '').toUpperCase(),
          gstCategory: master ? master.gstCategory || '' : String(item.gstCategory || '').toUpperCase(),
          qty: finalQty,
          quantity: finalQty,
          mrp: valueFields.mrp,
          scanMRP: valueFields.scanMRP,
          manualMRP: valueFields.manualMRP,
          valuationMRP: valueFields.valuationMRP,
          valuationSource: valueFields.valuationSource,
          finalInventoryValue: finalQty * Number(valueFields.valuationMRP || 0),
          ...pricePeriodFields,
          dlc: finalDlc,
          bin: finalBinLocation,
          binLocation: finalBinLocation,
          autoDetectedBin,
          binSelectionMode,
          stockDeductedFromBin,
          type,
          scanType: type,
          upiId,
          upiNo,
          dealerCode,
          dealerName: dealer ? dealer.dealerName : String(item.dealerName || ''),
          auditId,
          rawScan: rawScanText,
          rawScanString: rawScanText,
          rawUpi: String(item.rawUpi || rawScanText),
          source: entrySource,
          deviceId: String(item.deviceId || req.body.deviceId || ''),
          userId: String(item.userId || item.loginId || (req.user ? req.user.id : '') || ''),
          loginId: String(item.loginId || item.userId || (req.user ? req.user.username || req.user.email : '') || ''),
          staffName: String(item.staffName || (req.user ? req.user.name : '') || ''),
          timestamp,
          synced: true,
          isSynced: true,
          scanStatus: type === 'OUTWARD' ? 'OUTWARD_DONE' : 'ACCEPTED',
          syncStatus: 'synced',
          syncError: '',
          syncKey,
          warnings,
          remarks: warnings.join(', '),
          masterFound: Boolean(master),
          masterMatch: Boolean(master),
          isMasterMatched: Boolean(master)
        });
        scanDebug('saved valid sync scan', {
          id: scan._id,
          partNumber: scan.partNumber,
          dealerCode: scan.dealerCode,
          category: scan.category || '',
          partDescription: scan.partDescription || scan.partName || ''
        });
        saved.push(scan);
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          skipped += 1;
        } else {
          failed.push({ message: error.message, item });
        }
      }
    }

    if (saved.length) await emitScanUpdate(req, saved[saved.length - 1]);

    const [pending, totalSynced] = await Promise.all([
      Inventory.countDocuments({ synced: false }),
      Inventory.countDocuments({ synced: true })
    ]);

    res.json({
      success: true,
      lastSyncTime: new Date(),
      totalSynced,
      syncedNow: saved.length,
      pending,
      failed: failed.length,
      failedItems: failed,
      skippedDuplicates: skipped,
      verificationResults
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/history', auth.requireAuth, async (req, res) => {
  try {
    const filter = applyScanVisibility(req, applyTestScanMode(buildListQuery(req.query), req.query.testScanMode || 'real'));
    const page = Math.max(1, Number.parseInt(req.query.page || '1', 10) || 1);
    const limit = Math.min(500, Math.max(25, Number.parseInt(req.query.limit || '100', 10) || 100));
    const skip = (page - 1) * limit;
    if (req.query.part || req.query.partNo || req.query.partNumber) {
      const partRegex = { $regex: escapeRegex(upper(req.query.part || req.query.partNo || req.query.partNumber)), $options: 'i' };
      filter.$and = (filter.$and || []).concat([{
        $or: [
          { part: partRegex },
          { partNumber: partRegex },
          { normalizedPartNumber: partRegex },
          { rawScan: partRegex },
          { rawScanString: partRegex },
          { rawUpi: partRegex }
        ]
      }]);
    }
    if (req.query.bin) {
      const binRegex = { $regex: escapeRegex(String(req.query.bin).trim()), $options: 'i' };
      filter.$and = (filter.$and || []).concat([{ $or: [{ bin: binRegex }, { binLocation: binRegex }] }]);
    }
    if (req.query.dealer) {
      const dealer = String(req.query.dealer).trim();
      filter.$or = [
        { dealerCode: { $regex: dealer, $options: 'i' } },
        { dealerName: { $regex: dealer, $options: 'i' } }
      ];
    }
    const duplicateFilter = {};
    if (filter.dealerCode) duplicateFilter.dealerCode = filter.dealerCode;
    if (filter.auditId) duplicateFilter.auditId = filter.auditId;
    if (filter.timestamp) duplicateFilter.timestamp = filter.timestamp;
    if (req.query.type) duplicateFilter.scanType = upper(req.query.type);
    if (req.query.part || req.query.partNo || req.query.partNumber) duplicateFilter.partNumber = { $regex: escapeRegex(upper(req.query.part || req.query.partNo || req.query.partNumber)), $options: 'i' };
    if (req.query.bin) duplicateFilter.$or = [{ binLocation: { $regex: escapeRegex(String(req.query.bin).trim()), $options: 'i' } }, { duplicateBin: { $regex: escapeRegex(String(req.query.bin).trim()), $options: 'i' } }];
    const [records, totalRecords, duplicateCount, totals] = await Promise.all([
      Inventory.find(filter).sort({ timestamp: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      Inventory.countDocuments(filter),
      DuplicateScanLog.countDocuments(duplicateFilter),
      Inventory.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            uniqueParts: {
              $addToSet: {
                $ifNull: ['$normalizedPartNumber', { $ifNull: ['$partNumber', '$part'] }]
              }
            },
            totalQuantity: {
              $sum: {
                $cond: [
                  { $ne: ['$qty', null] },
                  '$qty',
                  {
                    $cond: [
                      { $ne: ['$quantity', null] },
                      '$quantity',
                      1
                    ]
                  }
                ]
              }
            }
          }
        }
      ])
    ]);
    if (req.query.repair === '1' || req.query.repair === 'true') await repairParsedFields(records);
    const masterLookup = await masterLookupForScans(records);
    const publicRecords = records.map((record) => publicScanWithMaster(record, masterLookup));
    const aggregateTotals = totals[0] || {};
    const uniqueParts = (aggregateTotals.uniqueParts || []).map((part) => normalizePartNumber(part || '')).filter(Boolean);
    const visibleTotals = reportTotals(publicRecords, { visibleRows: publicRecords.length, duplicateCount });
    const partsScanned = Number(aggregateTotals.totalQuantity || 0);
    res.json({
      success: true,
      records: publicRecords,
      pagination: {
        page,
        limit,
        skip,
        totalRows: totalRecords,
        totalPages: Math.max(1, Math.ceil(totalRecords / limit))
      },
      summary: {
        scanRows: totalRecords,
        totalRows: totalRecords,
        totalRecords,
        visibleRows: publicRecords.length,
        uniqueParts: new Set(uniqueParts).size,
        visibleUniqueParts: visibleTotals.uniqueParts,
        partsScanned,
        visiblePartsScanned: visibleTotals.partsScanned,
        totalQuantity: partsScanned,
        databaseQuantity: partsScanned,
        duplicateCount,
        unknownPartsCount: visibleTotals.unknownPartsCount,
        inwardCount: visibleTotals.inwardCount,
        outwardCount: visibleTotals.outwardCount,
        netAvailableCount: visibleTotals.netAvailableCount
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/dashboard/product-group-summary/export', auth.requireAuth, async (req, res) => {
  try {
    const { filter } = await activeDashboardScope(req.query);
    const rows = await dashboardProductGroupSummary({ limit: 0, q: req.query.q || '', filter });
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Product Group Summary');
    sheet.columns = [
      { header: 'Product Group', key: 'productGroup', width: 24 },
      { header: 'Product Sub Group', key: 'partSubGroup', width: 26 },
      { header: 'Total Scans', key: 'totalScans', width: 14 },
      { header: 'Total Quantity', key: 'totalQuantity', width: 16 },
      { header: 'Unique Parts', key: 'uniqueParts', width: 14 },
      { header: 'Total MRP Value', key: 'totalMrpValue', width: 18 },
      { header: 'Total DLC Value', key: 'totalDlcValue', width: 18 }
    ];
    rows.forEach((row) => sheet.addRow(row));
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF153A5B' } };
    ['C', 'D', 'E'].forEach((column) => { sheet.getColumn(column).numFmt = '#,##0'; });
    ['F', 'G'].forEach((column) => { sheet.getColumn(column).numFmt = '#,##0.00'; });
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Daksh_Product_Group_Summary.xlsx"');
    return res.send(Buffer.from(buffer));
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/dashboard/product-group-summary/details', auth.requireAuth, async (req, res) => {
  try {
    const { filter } = await activeDashboardScope(req.query);
    const data = await dashboardProductGroupDetails({
      productGroup: req.query.productGroup,
      partSubGroup: req.query.partSubGroup || req.query.productSubGroup,
      filter
    });
    if (String(req.query.format || '').toLowerCase() === 'excel') {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Group Parts');
      sheet.columns = [
        { header: 'Product Group', key: 'productGroup', width: 24 },
        { header: 'Product Sub Group', key: 'partSubGroup', width: 26 },
        { header: 'Part Number', key: 'partNumber', width: 18 },
        { header: 'Part Description', key: 'partDescription', width: 36 },
        { header: 'Qty', key: 'qty', width: 12 },
        { header: 'Bin Location', key: 'binLocation', width: 16 },
        { header: 'MRP', key: 'mrp', width: 12 },
        { header: 'MRP Total', key: 'mrpTotal', width: 16 }
      ];
      data.rows.forEach((row) => sheet.addRow({ productGroup: data.productGroup, partSubGroup: data.partSubGroup, ...row }));
      sheet.addRow({});
      sheet.addRow({ partDescription: 'Total Parts', qty: data.totals.partCount });
      sheet.addRow({ partDescription: 'Total Qty', qty: data.totals.totalQty });
      sheet.addRow({ partDescription: 'Total MRP Value', mrpTotal: data.totals.totalMrpValue });
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF153A5B' } };
      ['E'].forEach((column) => { sheet.getColumn(column).numFmt = '#,##0'; });
      ['G', 'H'].forEach((column) => { sheet.getColumn(column).numFmt = '#,##0.00'; });
      const buffer = await workbook.xlsx.writeBuffer();
      const safeGroup = data.productGroup.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'Product_Group';
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Daksh_${safeGroup}_Parts.xlsx"`);
      return res.send(Buffer.from(buffer));
    }
    return res.json({ success: true, ...data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/dashboard', auth.requireAuth, async (req, res) => {
  try {
    const { filter, activeAudit } = await activeDashboardScope(req.query);
    const [stats, recent, productGroupSummary] = await Promise.all([
      dashboardStats(filter),
      Inventory.find(applyTestScanMode({ ...filter }, 'real')).sort({ timestamp: -1, createdAt: -1 }).limit(12).lean(),
      dashboardProductGroupSummary({ limit: 100, filter })
    ]);
    stampDashboardScope(stats, filter);

    res.json({
      success: true,
      activeAudit,
      dealerCode: filter.dealerCode || '',
      auditId: filter.auditId || '',
      stats,
      recent: recent.map(publicScan),
      productGroupSummary: productGroupSummary.map((item) => ({
        productGroup: item.productGroup || 'OTHERS',
        partSubGroup: item.partSubGroup || 'GENERAL',
        totalScans: item.totalScans || item.scanCount || 0,
        scanCount: item.totalScans || item.scanCount || 0,
        totalQuantity: item.totalQuantity || item.qty || 0,
        qty: item.totalQuantity || item.qty || 0,
        uniqueParts: item.uniqueParts || 0,
        totalMrpValue: item.totalMrpValue || 0,
        totalDlcValue: item.totalDlcValue || 0
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/recent', auth.requireAuth, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 10), 100);
    const records = await Inventory.find(applyTestScanMode({}, req.query.testScanMode || 'real')).sort({ timestamp: -1, createdAt: -1 }).limit(limit).lean();
    res.json({ success: true, records: records.map(publicScan), scans: records.map(publicScan) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/live', auth.optionalAuth, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 200);
    const records = await Inventory.find(applyTestScanMode({}, req.query.testScanMode || 'real'))
      .sort({ timestamp: -1, createdAt: -1 })
      .limit(limit)
      .lean();
    res.json({ success: true, records });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/repair-sync-status', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const webFilter = {
      $or: [
        { deviceId: /^WEB-/i },
        { source: { $in: ['barcode', 'manual', 'scanner', 'api'] } }
      ],
      syncStatus: { $ne: 'synced' }
    };
    const result = await Inventory.updateMany(webFilter, {
      $set: { syncStatus: 'synced', synced: true, isSynced: true, syncError: '' }
    });
    const count = result.modifiedCount || result.nModified || 0;
    if (req.io) {
      req.io.emit('scan:saved');
      req.io.emit('stats:update');
    }
    res.json({
      success: true,
      message: `Repair complete. ${count} WEB/server-saved pending records marked synced.`,
      matchedCount: result.matchedCount || result.n || 0,
      modifiedCount: count
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/deduplicate', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const duplicates = await Inventory.aggregate([
      { $match: { uniqueScanId: { $ne: '' } } },
      { $group: { _id: '$uniqueScanId', ids: { $push: '$_id' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } }
    ]);
    const deleteIds = duplicates.flatMap((item) => item.ids.slice(1));
    const result = deleteIds.length ? await Inventory.deleteMany({ _id: { $in: deleteIds } }) : { deletedCount: 0 };
    req.io.emit('scan:deleted');
    req.io.emit('stats:update');
    res.json({ success: true, duplicateGroups: duplicates.length, deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/move-not-in-master-to-rejected', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const records = await Inventory.find({}).lean();
    let movedCount = 0;
    const movedIds = [];
    for (const scan of records) {
      const partNumber = normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part || '');
      const master = await findMasterPart(partNumber, scan.dealerCode);
      if (master) continue;
      const rejected = await masterValidation.saveRejectedScan({
        ...scan,
        rawScannedValue: scan.rawScan || scan.rawScanString || scan.rawUpi || '',
        extractedPartNumber: partNumber,
        originalScanId: scan.scanId || scan.uniqueScanId || String(scan._id),
        originalInventoryId: scan._id,
        sourceRoute: 'cleanup:move-not-in-master-to-rejected',
        defaultScanMode: scan.synced || scan.isSynced ? 'Sync' : 'Manual'
      });
      if (rejected) {
        movedCount += 1;
        movedIds.push(scan._id);
      }
    }
    const deleteResult = movedIds.length ? await Inventory.deleteMany({ _id: { $in: movedIds } }) : { deletedCount: 0 };
    req.io.emit('scan:deleted');
    req.io.emit('scan:saved');
    req.io.emit('stats:update');
    res.json({
      success: true,
      message: `Moved ${movedCount} not-in-master scans to rejected report`,
      scannedCount: records.length,
      movedCount,
      deletedCount: deleteResult.deletedCount || 0
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/list', auth.requireAuth, async (req, res) => {
  try {
    const filter = applyTestScanMode(buildListQuery(req.query), req.query.testScanMode || 'real');
    const limit = Math.min(Number(req.query.limit || 200), 1000);
    const records = await Inventory.find(filter).sort({ timestamp: -1, createdAt: -1 }).limit(limit).lean();
    const stats = await dashboardStats(filter);
    res.json({ success: true, records, stats });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/delete-selected', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    if (String(req.body.confirmText || '') !== 'DELETE') {
      return res.status(400).json({ success: false, message: 'Type DELETE to confirm' });
    }
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (!ids.length) {
      return res.status(400).json({ success: false, message: 'Select records to delete' });
    }
    const rows = await Inventory.find({ _id: { $in: ids } }).lean();
    if (rows.length) {
      await DeletedScanLog.insertMany(rows.map((scan) => ({
        deletedBy: req.user.username || req.user.name || 'admin',
        dealerCode: scan.dealerCode || '',
        partNumber: scan.partNumber || scan.part || '',
        qty: Number(scan.qty || scan.quantity || 0),
        scanType: scan.scanType || scan.type || '',
        reason: req.body.reason || 'Selected scan delete',
        source: 'PC',
        scanId: scan.scanId || scan.uniqueScanId || String(scan._id)
      })));
    }
    const result = await Inventory.deleteMany({ _id: { $in: ids } });
    req.io.emit('scan:deleted');
    req.io.emit('stats:update');
    res.json({ success: true, deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/delete-all', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    if (String(req.body.confirmText || '') !== 'DELETE') {
      return res.status(400).json({ success: false, message: 'Type DELETE to confirm' });
    }

    const scope = String(req.body.scope || '').trim();
    const filter = {};
    if (scope === 'dealer') {
      const dealerCode = upper(req.body.dealerCode);
      if (!dealerCode) {
        return res.status(400).json({ success: false, message: 'Dealer code is required' });
      }
      filter.dealerCode = dealerCode;
      if (req.body.auditId) filter.auditId = String(req.body.auditId).trim();
    } else if (scope === 'date') {
      const dateBefore = new Date(req.body.dateBefore);
      if (Number.isNaN(dateBefore.getTime())) {
        return res.status(400).json({ success: false, message: 'Valid date is required' });
      }
      filter.timestamp = { $lt: dateBefore };
    } else if (scope === 'category') {
      const category = String(req.body.category || '').trim();
      if (!category) {
        return res.status(400).json({ success: false, message: 'Category is required' });
      }
      filter.category = category;
    } else if (scope === 'bin') {
      const bin = String(req.body.bin || '').trim();
      if (!bin) {
        return res.status(400).json({ success: false, message: 'Bin location is required' });
      }
      filter.bin = bin;
    } else if (scope !== 'system') {
      return res.status(400).json({ success: false, message: 'Invalid delete scope' });
    }

    const result = await Inventory.deleteMany(filter);
    let duplicateLogsDeleted = 0;
    if (scope === 'dealer' || scope === 'date') {
      duplicateLogsDeleted = (await DuplicateScanLog.deleteMany(filter)).deletedCount || 0;
    }
    req.io.emit('scan:deleted');
    req.io.emit('stats:update');
    res.json({ success: true, deletedCount: result.deletedCount, duplicateLogsDeleted });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
module.exports.parseRawScan = parseRawScan;
module.exports.buildListQuery = buildListQuery;
module.exports.testScanClause = testScanClause;
module.exports.applyTestScanMode = applyTestScanMode;
module.exports.applyTransactionScanFilter = applyTransactionScanFilter;
module.exports.nonVerificationScanClause = nonVerificationScanClause;
module.exports.cleanupTestScans = cleanupTestScans;
module.exports.buildSyncKey = buildSyncKey;
module.exports.extractUpiId = extractUpiId;
module.exports.upper = upper;
module.exports.normalizeDealerCode = normalizeDealerCode;
module.exports.findMasterPart = findMasterPart;
module.exports.numberValue = numberValue;
module.exports.dashboardStats = dashboardStats;
module.exports.publicScan = publicScan;
module.exports.fittedIdentityFilter = fittedIdentityFilter;
module.exports.findBackendDuplicate = findBackendDuplicate;
module.exports.duplicateLookupPayload = duplicateLookupPayload;
module.exports.prepareFittedScan = prepareFittedScan;
module.exports.availableInwardStock = availableInwardStock;
module.exports.verifyPartOnly = verifyPartOnly;
