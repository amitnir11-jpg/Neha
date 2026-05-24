const express = require('express');
const ExcelJS = require('exceljs');
const { randomUUID } = require('crypto');
const Inventory = require('../models/Inventory');
const MasterPart = require('../models/MasterPart');
const Dealer = require('../models/Dealer');
const Device = require('../models/Device');
const BluetoothDevice = require('../models/BluetoothDevice');
const BluetoothScanLog = require('../models/BluetoothScanLog');
const DeletedScanLog = require('../models/DeletedScanLog');
const DuplicateScanLog = require('../models/DuplicateScanLog');
const VerificationLog = require('../models/VerificationLog');
const auth = require('./auth');
const { normalizePartNumber } = require('../utils/normalize');
const { findCataloguePart, reprocessScansWithCatalogue } = require('../utils/catalogue');
const { makeQrFingerprint, isDuplicateKeyError } = require('../utils/scanIdentity');
const masterValidation = require('../utils/masterValidation');
const { getActiveAudit, publicAudit } = require('../utils/audit');
const { dateDebugPayload, formatIstDateTime, validDate } = require('../utils/time');

const router = express.Router();
const VALID_TYPES = ['AUDIT', 'INWARD', 'OUTWARD', 'VERIFICATION', 'FITTED', 'DAMAGE'];
const BIN_REQUIRED_MESSAGE = 'Please enter/select bin location first.';
const SCAN_VERBOSE_LOGS = process.env.SCAN_VERBOSE_LOGS === 'true';
const realtimeRefreshDelay = Number(process.env.REALTIME_SCAN_REFRESH_DELAY_MS || 900);
const REALTIME_SCAN_REFRESH_DELAY_MS = Number.isFinite(realtimeRefreshDelay) && realtimeRefreshDelay >= 100
  ? realtimeRefreshDelay
  : 900;
let bluetoothScanQueue = Promise.resolve();
const realtimeDashboardTimers = new Map();

function scanDebug(...args) {
  if (SCAN_VERBOSE_LOGS) console.log(...args);
}

function clean(value) {
  return String(value || '').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function normalizeScanType(value) {
  const type = upper(value || 'INWARD');
  if (type === 'VERIFICATION' || type === 'FITTED') return 'AUDIT';
  return type;
}

function rawIdentity(input = {}) {
  return String(input.rawScanString || input.rawScan || input.rawBarcode || input.rawQR || input.rawUpi || input.upiNo || input.upiId || '').trim();
}

function acceptedStatuses() {
  return ['ACCEPTED', 'SUPERVISOR_APPROVED', 'OUTWARD_DONE'];
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
  return upper(paren ? paren[1] : text);
}

async function findMasterPart(partNumber, dealerCode = '') {
  return masterValidation.findMasterPart(partNumber, dealerCode);
}

function scanIdentity(input, parsed) {
  const explicit = input.scanId || input.uniqueScanId || input.mobileScanId || input.localId;
  if (explicit) {
    const bin = upper(input.binLocation || input.bin || input.location || parsed?.bin || '');
    return [String(explicit).trim(), bin].filter(Boolean).join('::BIN::');
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

function duplicateScanFilter(uniqueScanId, qrFingerprint, dealerCode = '', rawScan = '', upiNo = '', binLocation = '', auditId = '') {
  const terms = [];
  const raw = String(rawScan || '').trim();
  const upi = upper(upiNo);
  const dealer = normalizeDealerCode(dealerCode);
  const audit = String(auditId || '').trim();
  if (raw) terms.push({ rawScan: raw }, { rawScanString: raw }, { rawBarcode: raw }, { rawQR: raw }, { rawUpi: raw });
  if (upi) terms.push({ upiNo: upi }, { upiId: upi });
  if (qrFingerprint) terms.push({ qrFingerprint });
  if (uniqueScanId) terms.push({ uniqueScanId: String(uniqueScanId).trim() }, { scanId: String(uniqueScanId).trim() });
  if (!terms.length) return null;
  const filter = { scanStatus: { $in: acceptedStatuses() }, $or: terms };
  if (dealer) filter.dealerCode = dealer;
  if (audit) filter.auditId = audit;
  return filter;
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
    return {
      upiNo: upper(slashParts[1]),
      upiId: upper(slashParts[1]),
      part: upper(slashParts[3]).replace(/\s+/g, ''),
      qty: numberValue(slashParts[4], 1),
      mrp: undefined,
      mrpProvided: false,
      dlc: undefined,
      dlcProvided: false,
      bin: '',
      dealerCode: '',
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
  const text = String(value || '').trim();
  if (!text) return null;
  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    date.setHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
    return date;
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  if (endOfDay) date.setHours(23, 59, 59, 999);
  return date;
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
  if (selected === 'all') return filter;
  filter.$and = (filter.$and || []).concat([
    selected === 'test' ? testScanClause() : { $nor: testScanClause().$or },
    masterValidation.validScanClause()
  ]);
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
  const todayFilter = { ...filter, timestamp: { ...(filter.timestamp || {}), $gte: today } };
  const activeUserFilter = { ...filter, timestamp: { ...(filter.timestamp || {}), $gte: new Date(Date.now() - 30 * 1000) }, userId: { $nin: [null, ''] } };
  const liveCutoff = new Date(Date.now() - 30 * 1000);

  const duplicateFilter = {};
  if (filter.dealerCode) duplicateFilter.dealerCode = filter.dealerCode;
  if (filter.auditId) duplicateFilter.auditId = filter.auditId;
  if (filter.timestamp) duplicateFilter.timestamp = filter.timestamp;

  const [records, todayCount, activeDevices, activeUsers, lastScan, last10Scans, duplicateCount] = await Promise.all([
    Inventory.find(filter).select('qty quantity mrp type scanType synced isSynced warnings part partNumber normalizedPartNumber rawScan rawScanString rawUpi category productCategory').lean(),
    Inventory.countDocuments(todayFilter),
    Device.countDocuments({ status: 'online', lastSeen: { $gte: liveCutoff } }),
    Inventory.distinct('userId', activeUserFilter),
    Inventory.findOne(filter).sort({ timestamp: -1, createdAt: -1 }).lean(),
    Inventory.find(filter).sort({ timestamp: -1, createdAt: -1 }).limit(10).lean(),
    DuplicateScanLog.countDocuments(duplicateFilter)
  ]);
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
    if (scan.type === 'FITTED' || scan.type === 'VERIFICATION' || scan.type === 'AUDIT') {
      stats.fittedCount += qty;
      stats.auditCount += qty;
    }
    if (scan.type === 'DAMAGE') stats.damageCount += qty;
    if (!record.synced) stats.pendingSync += 1;
    if ((record.warnings || []).some((warning) => /mismatch|inactive|not found/i.test(warning))) stats.mismatchCount += 1;
    stats.totalScannedValue += qty * Number(scan.mrp || 0);
  });
  stats.totalUniqueScannedParts = uniqueParts.size;

  return stats;
}

async function dashboardProductGroupSummary({ limit = 100, q = '', filter = {} } = {}) {
  const search = String(q || '').trim();
  const pipeline = [
    { $match: applyTestScanMode({ ...(filter || {}) }, 'real') },
    {
      $addFields: {
        _dashboardProductGroup: firstNonBlankExpression(['productGroup', 'partGroup', 'productCategory', 'category'], 'OTHERS'),
        _dashboardProductSubGroup: firstNonBlankExpression(['partSubGroup', 'productSubGroup', 'productType'], 'GENERAL'),
        _dashboardPartNumber: firstNonBlankExpression(['normalizedPartNumber', 'partNumber', 'part', 'partNo'], ''),
        _dashboardQty: numberExpression(['qty', 'quantity']),
        _dashboardMrp: numberExpression(['mrp']),
        _dashboardDlc: numberExpression(['dlc'])
      }
    }
  ];
  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');
    pipeline.push({
      $match: {
        $or: [
          { _dashboardProductGroup: regex },
          { _dashboardProductSubGroup: regex }
        ]
      }
    });
  }
  pipeline.push(
    {
      $group: {
        _id: {
          productGroup: '$_dashboardProductGroup',
          partSubGroup: '$_dashboardProductSubGroup'
        },
        totalScans: { $sum: 1 },
        totalQuantity: { $sum: '$_dashboardQty' },
        uniquePartSet: { $addToSet: '$_dashboardPartNumber' },
        totalMrpValue: { $sum: { $multiply: ['$_dashboardQty', '$_dashboardMrp'] } },
        totalDlcValue: { $sum: { $multiply: ['$_dashboardQty', '$_dashboardDlc'] } }
      }
    },
    {
      $project: {
        _id: 0,
        productGroup: '$_id.productGroup',
        partSubGroup: '$_id.partSubGroup',
        totalScans: 1,
        scanCount: '$totalScans',
        totalQuantity: 1,
        qty: '$totalQuantity',
        uniqueParts: { $size: { $setDifference: ['$uniquePartSet', ['']] } },
        totalMrpValue: 1,
        totalDlcValue: 1
      }
    },
    { $sort: { totalQuantity: -1, totalScans: -1, productGroup: 1, partSubGroup: 1 } }
  );
  if (limit && Number(limit) > 0) pipeline.push({ $limit: Math.min(Number(limit), 5000) });
  return Inventory.aggregate(pipeline);
}

async function dashboardProductGroupDetails({ productGroup = '', partSubGroup = '', filter = {} } = {}) {
  const group = String(productGroup || 'OTHERS').trim() || 'OTHERS';
  const subGroup = String(partSubGroup || 'GENERAL').trim() || 'GENERAL';
  const pipeline = [
    { $match: applyTestScanMode({ ...(filter || {}) }, 'real') },
    {
      $addFields: {
        _dashboardProductGroup: firstNonBlankExpression(['productGroup', 'partGroup', 'productCategory', 'category'], 'OTHERS'),
        _dashboardProductSubGroup: firstNonBlankExpression(['partSubGroup', 'productSubGroup', 'productType'], 'GENERAL'),
        _dashboardPartNumber: firstNonBlankExpression(['normalizedPartNumber', 'partNumber', 'part', 'partNo'], ''),
        _dashboardPartDescription: firstNonBlankExpression(['partDescription', 'partName', 'description'], ''),
        _dashboardBinLocation: firstNonBlankExpression(['binLocation', 'bin'], ''),
        _dashboardQty: numberExpression(['qty', 'quantity']),
        _dashboardMrp: numberExpression(['mrp'])
      }
    },
    {
      $match: {
        _dashboardProductGroup: new RegExp(`^${escapeRegex(group)}$`, 'i'),
        _dashboardProductSubGroup: new RegExp(`^${escapeRegex(subGroup)}$`, 'i')
      }
    },
    {
      $group: {
        _id: {
          partNumber: '$_dashboardPartNumber',
          partDescription: '$_dashboardPartDescription',
          binLocation: '$_dashboardBinLocation',
          mrp: '$_dashboardMrp'
        },
        qty: { $sum: '$_dashboardQty' },
        scanCount: { $sum: 1 },
        mrpTotal: { $sum: { $multiply: ['$_dashboardQty', '$_dashboardMrp'] } }
      }
    },
    {
      $project: {
        _id: 0,
        partNumber: '$_id.partNumber',
        partDescription: '$_id.partDescription',
        qty: 1,
        binLocation: '$_id.binLocation',
        mrp: '$_id.mrp',
        mrpTotal: 1,
        scanCount: 1
      }
    },
    { $sort: { partNumber: 1, binLocation: 1 } }
  ];
  const rows = await Inventory.aggregate(pipeline);
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
  const mrp = numberValue(scan.mrp !== undefined ? scan.mrp : parsed.mrp, 0);
  const rawScan = scanRawText(scan);
  const syncStatus = normalizedSyncStatus(scan);
  const labels = sourceLabels(scan);
  return {
    ...scan,
    scanId: scan.scanId || scan.uniqueScanId || String(scan._id || ''),
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
    scanType: scan.scanType || scan.type || '',
    type: scan.scanType || scan.type || '',
    dealerCode: scan.dealerCode || '',
    dealerName: scan.dealerName || '',
    binLocation: scan.binLocation || scan.bin || '',
    bin: scan.binLocation || scan.bin || '',
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

function scanIdentityScope(filter = {}, dealerCode = '', auditId = '') {
  const dealer = normalizeDealerCode(dealerCode);
  const audit = String(auditId || '').trim();
  if (dealer) filter.dealerCode = dealer;
  if (audit) filter.auditId = audit;
  return filter;
}

function inboundAcceptedFilter(raw, dealerCode = '', auditId = '') {
  return scanIdentityScope({
    scanType: { $in: ['AUDIT', 'INWARD', 'VERIFICATION', 'FITTED'] },
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
      const [stats, recent] = await Promise.all([
        dashboardStats(dashboardFilter),
        Inventory.find(applyTestScanMode({ ...dashboardFilter }, 'real')).sort({ timestamp: -1, createdAt: -1 }).limit(12).lean()
      ]);
      stampDashboardScope(stats, dashboardFilter);
      const recentPublic = recent.map(publicScan);
      const realtimePayload = {
        source: 'inventory-api',
        scans: entry.latestScan ? [entry.latestScan] : [],
        stats,
        recent: recentPublic,
        count: entry.count,
        at: new Date(),
        dealerCode: dashboardFilter.dealerCode || '',
        auditId: dashboardFilter.auditId || ''
      };
      io.emit('scan:count:update', stats);
      io.emit('dashboard:update', realtimePayload);
      io.emit('inventory:update', realtimePayload);
      io.emit('reports:update', realtimePayload);
      io.emit('warehouse:feed', realtimePayload);
      io.emit('scan:last10:update', recentPublic);
      io.emit('stats:update', stats);
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

async function validateScan(payload, master, timestamp) {
  const warnings = [];
  const scannedMrp = optionalNumber(payload.mrp);
  const scannedDlc = optionalNumber(payload.dlc);
  const mrpCompareRequired = shouldComparePrice(payload, 'mrp');
  const dlcCompareRequired = shouldComparePrice(payload, 'dlc');
  const mrpMatch = !mrpCompareRequired || !approxMismatch(scannedMrp, master ? master.mrp : undefined);

  if (!master) {
    warnings.push(`Part not found in Master Catalogue: ${payload.part || payload.partNumber || ''}`);
  } else {
    if (mrpCompareRequired && approxMismatch(scannedMrp, master.mrp)) warnings.push('MRP mismatch');
    if (dlcCompareRequired && approxMismatch(scannedDlc, master.dlc)) warnings.push('DLC mismatch');
    if (!master.activeStatus) warnings.push('Inactive part');
  }

  scanDebug('RAW_SCAN:', payload.rawScan || payload.rawScanString || '');
  scanDebug('EXTRACTED_PART:', payload.part || payload.partNumber || '');
  scanDebug('MASTER_MRP:', master ? master.mrp : '');
  scanDebug('SCANNED_MRP:', mrpCompareRequired ? scannedMrp : '');
  scanDebug('MRP_COMPARE_REQUIRED', mrpCompareRequired);
  scanDebug('MRP_MATCH', mrpMatch);
  scanDebug('FINAL_STATUS:', !master ? 'Rejected / Not in Master' : warnings.includes('MRP mismatch') ? 'MRP mismatch' : warnings.length ? warnings.join(', ') : 'Synced');

  return warnings;
}

async function logValidationFailure(payload = {}, reason = 'Not Found In Master', timestamp = new Date()) {
  try {
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
    const validation = await masterValidation.validatePartAgainstMaster({
      partNumber: normalizedPartNumber,
      dealerCode: req.body.dealerCode || parsed.dealerCode,
      rawScannedValue: rawScanInput || parsed.rawScan || part,
      logger: SCAN_VERBOSE_LOGS ? console : null
    });
    const master = validation.master;

    const dealerCode = upper(req.body.dealerCode || req.body.dealer || parsed.dealerCode || (master ? master.dealerCode : ''));
    const dealer = dealerCode ? await Dealer.findOne({ dealerCode }).lean() : null;
    const auditId = String(req.body.auditId || (dealer ? dealer.currentAuditId : '') || '').trim();
    const type = normalizeScanType(req.body.type || req.body.scanType || req.body.action || parsed.type || 'INWARD');
    const timestamp = new Date();
    const mobileTime = firstValue(req.body, ['timestamp', 'scanTime', 'scannedAt', 'scanDateTime', 'dateTime', 'createdAt', 'localCreatedAt', 'localTimestamp']);
    console.log('[SCAN TIME] web/server scan received', {
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
    const binLocation = String(firstValue(req.body, ['binLocation', 'bin', 'location']) || parsed.bin || '').trim().toUpperCase();
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
    const duplicateIdentityRaw = rawScanText || upiNo;
    const serverSavedStatus = normalizedSyncStatus({
      ...req.body,
      source: entrySource,
      scanMode: req.body.scanMode || (entrySource === 'manual' ? 'Manual' : 'Barcode/Web Scan')
    });
    const serverSavedSynced = serverSavedStatus === 'synced';
    const syncKey = String(req.body.syncKey || buildSyncKey({ dealerCode, upiId, partNumber: part, scanType: type, timestamp })).trim();
    const uniqueScanId = scanIdentity({ ...req.body, syncKey }, parsed);
    const qrFingerprint = duplicateIdentityRaw ? makeQrFingerprint({
      ...req.body,
      dealerCode,
      auditId,
      scanType: type,
      partNumber: part,
      upiId,
      rawScanString: rawScanText,
      binLocation
    }) : '';
    const finalQrFingerprint = type === 'OUTWARD' && qrFingerprint ? `OUTWARD:${qrFingerprint}` : qrFingerprint;
    const duplicateQuery = duplicateScanFilter(uniqueScanId, finalQrFingerprint, dealerCode, rawScanText, upiNo, binLocation, auditId);
    let existing = null;
    if (type === 'OUTWARD') {
      existing = rawScanText ? await Inventory.findOne(outwardDoneFilter(rawScanText, dealerCode, auditId)).lean() : null;
      if (!existing && rawScanText) {
        const available = await Inventory.findOne(inboundAcceptedFilter(rawScanText, dealerCode, auditId)).lean();
        if (!available) return res.status(409).json({ success: false, message: 'Outward blocked. Item is not available in accepted stock.' });
      }
    } else {
      existing = duplicateQuery ? await Inventory.findOne(duplicateQuery).lean() : null;
    }
    if (existing) {
      await logDuplicateScan({
        ...req.body,
        uniqueScanId,
        scanId: uniqueScanId,
        qrFingerprint,
        partNumber: part,
        dealerCode,
        binLocation,
        scanType: type,
        rawScan: rawScanText,
        upiNo
      }, existing);
      if (req.io) {
        req.io.emit('scan:duplicate', publicScan(existing));
        req.io.emit('stats:update');
      }
      return res.json({
        success: true,
        skipped: true,
        duplicate: true,
        message: `Duplicate QR already scanned. First scanned by ${existing.userName || existing.staffName || existing.loginId || 'Unknown'}, at ${formatIstDateTime(existing.timestamp) || '-'}, Bin ${existing.binLocation || existing.bin || '-'}.`,
        scan: existing
      });
    }

    if (!part) {
      console.log('[MANUAL SCAN] validation failed', { reason: 'Part number is required', parsed });
      return res.status(400).json({ success: false, message: 'Part number is required' });
    }
    if (!isValidPartNumber(part)) {
      console.log('[MANUAL SCAN] validation failed', { reason: 'Invalid part number format', part, rawScanInput });
      return res.status(400).json({ success: false, message: 'Invalid part number format' });
    }
    if (!binLocation) {
      console.log('[MANUAL SCAN] validation failed', { reason: BIN_REQUIRED_MESSAGE, part });
      return res.status(400).json({ success: false, message: BIN_REQUIRED_MESSAGE });
    }
    if (!dealerCode) {
      console.log('[MANUAL SCAN] validation failed', { reason: 'Dealer code is required', part });
      return res.status(400).json({ success: false, message: 'Dealer code is required' });
    }
    if (!VALID_TYPES.includes(type)) {
      console.log('[MANUAL SCAN] validation failed', { reason: 'Invalid scan type', type, part, dealerCode });
      return res.status(400).json({ success: false, message: 'Invalid scan type' });
    }
    const role = String(req.body.role || (req.user ? req.user.role : '') || '').trim().toLowerCase();
    const roleError = roleScanError(role, type);
    if (roleError) return res.status(403).json({ success: false, message: roleError });

    const qty = numberValue(firstValue(req.body, ['qty', 'quantity', 'count']) || parsed.qty, 1);
    const bodyMrpProvided = booleanFlag(req.body.mrpProvided);
    const bodyDlcProvided = booleanFlag(req.body.dlcProvided);
    const parsedMrpProvided = booleanFlag(parsed.mrpProvided);
    const parsedDlcProvided = booleanFlag(parsed.dlcProvided);
    const mrpProvided = bodyMrpProvided || parsedMrpProvided;
    const dlcProvided = bodyDlcProvided || parsedDlcProvided;
    const scannedMrp = mrpProvided ? optionalNumber(bodyMrpProvided ? req.body.mrp : parsed.mrp) : undefined;
    const scannedDlc = dlcProvided ? optionalNumber(bodyDlcProvided ? req.body.dlc : parsed.dlc) : undefined;
    const candidate = {
      part,
      dealerCode,
      auditId,
      rawScan: rawScanText,
      rawScanProvided: Boolean(rawScanInput || parsed.rawScan),
      mrp: scannedMrp,
      mrpProvided,
      dlc: scannedDlc,
      dlcProvided
    };

    const warnings = await validateScan(candidate, master, timestamp);
    if (!master && manualEntryMode) {
      await logValidationFailure({
        ...req.body,
        partNumber: part,
        part,
        dealerCode,
        scanType: type,
        binLocation,
        rawScan: rawScanText,
        upiNo,
        upiId,
        loginId: String(req.body.loginId || req.body.userId || (req.user ? req.user.username || req.user.email : '') || ''),
        userId: String(req.body.userId || req.body.loginId || (req.user ? req.user.id : '') || ''),
        staffName: String(req.body.staffName || (req.user ? req.user.name : '') || ''),
        source: entrySource,
        deviceId: String(req.body.deviceId || '')
      }, 'Not Found In Master', timestamp);
      await masterValidation.rejectNotInMasterScan({
        ...req.body,
        partNumber: part,
        extractedPartNumber: part,
        dealerCode,
        scanType: type,
        binLocation,
        rawScannedValue: rawScanText,
        rawScan: rawScanText,
        originalScanId: uniqueScanId,
        source: entrySource,
        sourceRoute: req.originalUrl,
        userId: String(req.body.userId || req.body.loginId || (req.user ? req.user.id : '') || ''),
        loginId: String(req.body.loginId || req.body.userId || (req.user ? req.user.username || req.user.email : '') || '')
      }, console);
      console.log('[MANUAL SCAN] validation failed', {
        reason: 'Part not found in master. Scan rejected.',
        rawScanReceived: rawScanText,
        extractedPartNumber: part,
        dealerCode
      });
      return res.status(422).json({ success: false, rejected: true, message: 'Part not found in master. Scan rejected.' });
    }
    let scan;
    try {
      scan = await Inventory.create({
      uniqueScanId,
      scanId: uniqueScanId,
      qrFingerprint: finalQrFingerprint,
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
      mrp: master ? Number(master.mrp || 0) : numberValue(parsed.mrp !== undefined ? parsed.mrp : req.body.mrp),
      dlc: master ? Number(master.dlc || 0) : numberValue(req.body.dlc || parsed.dlc),
      bin: binLocation,
      binLocation,
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
      staffName: String(req.body.staffName || (req.user ? req.user.name : '') || ''),
      userName: String(req.body.userName || req.body.staffName || (req.user ? req.user.name || req.user.username : '') || ''),
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
      warnings,
      remarks: warnings.join(', '),
      masterFound: Boolean(master),
      masterMatch: Boolean(master),
      isMasterMatched: Boolean(master),
      overrideBy: warnings.length && req.user ? req.user.username || req.user.name : ''
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const duplicate = await Inventory.findOne(duplicateQuery).lean();
      if (duplicate) {
        await logDuplicateScan({
          ...req.body,
          uniqueScanId,
          scanId: uniqueScanId,
          qrFingerprint: finalQrFingerprint,
          partNumber: part,
          dealerCode,
          binLocation,
          scanType: type,
          rawScan: candidate.rawScan
        }, duplicate);
        if (req.io) {
          req.io.emit('scan:duplicate', publicScan(duplicate));
          req.io.emit('stats:update');
        }
        return res.json({
          success: true,
          skipped: true,
          duplicate: true,
          message: 'Duplicate QR scan skipped',
          scan: duplicate
        });
      }
      throw error;
    }

    console.log('[SCAN TIME] saved MongoDB timestamp verified', {
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
    res.status(201).json({ success: true, scan, warnings });
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

router.post('/scan', auth.optionalAuth, saveScanRequest);
router.post('/manual', auth.optionalAuth, saveScanRequest);
router.post('/', auth.optionalAuth, saveScanRequest);
router.post('/reprocess-with-catalogue', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const result = await reprocessScansWithCatalogue();
    req.io.emit('scan:saved');
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/sync', auth.optionalAuth, async (req, res) => {
  try {
    const incoming = Array.isArray(req.body.scans) ? req.body.scans : [];
    const failed = [];
    const saved = [];
    let skipped = 0;

    for (const item of incoming) {
      try {
        const rawScanInput = firstValue(item, ['rawScan', 'rawScanString', 'rawBarcode', 'rawScanValue', 'barcode', 'barcodeValue', 'scanValue', 'scanText', 'raw']);
        const parsed = parseRawScan(rawScanInput || item.part);
        const part = upper(parsed.part || firstValue(item, ['part', 'partNo', 'partNumber', 'sku', 'itemCode']));
        const normalizedPartNumber = normalizePartNumber(part);
        const master = part ? await findMasterPart(normalizedPartNumber, item.dealerCode || parsed.dealerCode) : null;

        const dealerCode = upper(item.dealerCode || item.dealer || parsed.dealerCode || (master ? master.dealerCode : ''));
        const type = upper(item.type || item.scanType || item.action || parsed.type || 'INWARD');
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
        const qrFingerprint = makeQrFingerprint({
          ...item,
          dealerCode,
          auditId,
          scanType: type,
          partNumber: part,
          upiId,
          rawScanString: rawScanText,
          binLocation
        });
        const itemMrpProvided = booleanFlag(item.mrpProvided);
        const itemDlcProvided = booleanFlag(item.dlcProvided);
        const parsedMrpProvided = booleanFlag(parsed.mrpProvided);
        const parsedDlcProvided = booleanFlag(parsed.dlcProvided);
        const mrpProvided = itemMrpProvided || parsedMrpProvided;
        const dlcProvided = itemDlcProvided || parsedDlcProvided;
        const scannedMrp = mrpProvided ? optionalNumber(itemMrpProvided ? item.mrp : parsed.mrp) : undefined;
        const scannedDlc = dlcProvided ? optionalNumber(itemDlcProvided ? item.dlc : parsed.dlc) : undefined;
        const duplicateQuery = duplicateScanFilter(uniqueScanId, qrFingerprint, dealerCode, rawScanText, upiNo, binLocation, auditId);
        const duplicate = duplicateQuery ? await Inventory.findOne(duplicateQuery).lean() : null;
        if (duplicate) {
          await logDuplicateScan({
            ...item,
            uniqueScanId,
            scanId: uniqueScanId,
      qrFingerprint,
            partNumber: part,
            dealerCode,
            binLocation,
            scanType: type,
            rawScan: rawScanText,
            upiNo
          }, duplicate);
          skipped += 1;
          continue;
        }
        const warnings = [];

        if (!part) warnings.push('Part number missing');
        if (part && !isValidPartNumber(part)) warnings.push('Invalid part number format');
        if (!binLocation) warnings.push(BIN_REQUIRED_MESSAGE);
        if (!dealerCode) warnings.push('Dealer code missing');
        if (!VALID_TYPES.includes(type)) warnings.push('Invalid scan type');
        if (!master) warnings.push(`Part number not found in master: ${part}`);
        if (master && !master.activeStatus) warnings.push('Inactive part');
        if (master && mrpProvided && approxMismatch(scannedMrp, master.mrp)) warnings.push('MRP mismatch');
        if (master && dlcProvided && approxMismatch(scannedDlc, master.dlc)) warnings.push('DLC mismatch');

        if (!part || !isValidPartNumber(part) || !binLocation || !dealerCode || !VALID_TYPES.includes(type) || (!master && manualEntryMode)) {
          if (!master && part && manualEntryMode) {
            await logValidationFailure({
              ...item,
              partNumber: part,
              part,
              dealerCode,
              scanType: type,
              binLocation,
              rawScan: rawScanText,
              upiNo,
              upiId,
              loginId: String(item.loginId || item.userId || (req.user ? req.user.username || req.user.email : '') || ''),
              userId: String(item.userId || item.loginId || (req.user ? req.user.id : '') || ''),
              staffName: String(item.staffName || (req.user ? req.user.name : '') || ''),
              source: entrySource,
              deviceId: String(item.deviceId || req.body.deviceId || '')
            }, 'Not Found In Master', timestamp);
            await masterValidation.rejectNotInMasterScan({
              ...item,
              partNumber: part,
              extractedPartNumber: part,
              dealerCode,
              scanType: type,
              binLocation,
              rawScannedValue: rawScanText,
              rawScan: rawScanText,
              originalScanId: uniqueScanId,
              source: entrySource,
              sourceRoute: req.originalUrl,
              userId: String(item.userId || item.loginId || (req.user ? req.user.id : '') || ''),
              loginId: String(item.loginId || item.userId || (req.user ? req.user.username || req.user.email : '') || ''),
              defaultScanMode: 'Sync'
            }, console);
          }
          failed.push({ uniqueScanId, message: !master && part && manualEntryMode ? 'Part not found in master. Scan rejected.' : warnings.join(', ') });
          continue;
        }

        const scan = await Inventory.create({
          uniqueScanId,
          scanId: uniqueScanId,
          qrFingerprint,
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
          qty: numberValue(firstValue(item, ['qty', 'quantity', 'count']) || parsed.qty, 1),
          quantity: numberValue(firstValue(item, ['qty', 'quantity', 'count']) || parsed.qty, 1),
          mrp: master && master.mrp ? Number(master.mrp || 0) : numberValue(parsed.mrp !== undefined ? parsed.mrp : item.mrp),
          dlc: master && master.dlc ? Number(master.dlc || 0) : numberValue(item.dlc || parsed.dlc),
          bin: binLocation,
          binLocation,
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
          syncStatus: 'synced',
          syncError: '',
          syncKey,
          warnings,
          remarks: warnings.join(', '),
          masterFound: Boolean(master),
          masterMatch: Boolean(master),
          isMasterMatched: Boolean(master)
        });
        console.log("Matched category:", scan.category || '');
        console.log("Matched partDescription:", scan.partDescription || scan.partName || '');
        console.log('SAVED_VALID_SCAN', { id: scan._id, partNumber: scan.partNumber, dealerCode: scan.dealerCode, source: 'sync' });
        saved.push(scan);
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          skipped += 1;
        } else {
          failed.push({ message: error.message, item });
        }
      }
    }

    if (saved.length) {
      await emitScanUpdate(req, saved[saved.length - 1]);
    }

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
      skippedDuplicates: skipped
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/history', auth.requireAuth, async (req, res) => {
  try {
    const filter = applyScanVisibility(req, applyTestScanMode(buildListQuery(req.query), req.query.testScanMode || 'real'));
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
    const records = await Inventory.find(filter).sort({ timestamp: -1 }).limit(500).lean();
    if (req.query.repair === '1' || req.query.repair === 'true') await repairParsedFields(records);
    res.json({ success: true, records: records.map(publicScan) });
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
      await masterValidation.saveRejectedScan({
        ...scan,
        rawScannedValue: scan.rawScan || scan.rawScanString || scan.rawUpi || '',
        extractedPartNumber: partNumber,
        originalScanId: scan.scanId || scan.uniqueScanId || String(scan._id),
        originalInventoryId: scan._id,
        sourceRoute: 'cleanup:move-not-in-master-to-rejected',
        defaultScanMode: scan.synced || scan.isSynced ? 'Sync' : 'Manual'
      });
      movedCount += 1;
      movedIds.push(scan._id);
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
module.exports.cleanupTestScans = cleanupTestScans;
module.exports.buildSyncKey = buildSyncKey;
module.exports.extractUpiId = extractUpiId;
module.exports.upper = upper;
module.exports.normalizeDealerCode = normalizeDealerCode;
module.exports.findMasterPart = findMasterPart;
module.exports.numberValue = numberValue;
module.exports.dashboardStats = dashboardStats;
module.exports.publicScan = publicScan;
