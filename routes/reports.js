const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const { jsPDF } = require('jspdf');
const autoTableModule = require('jspdf-autotable');
const nodemailer = require('nodemailer');
const reportModule = require('./report');
const reconciliationRoute = require('./reconciliation');
const Inventory = require('../models/Inventory');
const Dealer = require('../models/Dealer');
const router = reportModule;
const auth = require('./auth');
const { applyCacheHeaders, getCachedResponse } = require('../utils/reportCache');
const { applyMovementCountRules, reportTotals, signedScanQuantity } = require('../utils/reportTotals');
const { stockValuationTotals } = require('../utils/stockValuation');
const categoryResolver = require('../utils/categoryResolver');
const DuplicateScanLog = require('../models/DuplicateScanLog');
const VerificationLog = require('../models/VerificationLog');
const { formatDateLikeFields, formatIstDateTime, parseIstFilterDate } = require('../utils/time');
const { scanValueRow } = require('../utils/inventoryValueEngine');
const { normalizePartNumber } = require('../utils/normalize');
const canonicalizePartCategory = typeof categoryResolver.canonicalizePartCategory === 'function'
  ? categoryResolver.canonicalizePartCategory
  : (value, options = {}) => {
      const text = String(value === undefined || value === null ? '' : value).trim().replace(/\s+/g, ' ');
      return text || options.uncategorized || 'Uncategorized';
    };

const INVALID_PART_MESSAGE = 'Invalid part number - not found in master catalogue';

const autoTable = autoTableModule.default || autoTableModule;
const DAKSH_REPORT_LOGO_PNG = path.resolve(__dirname, '..', 'public', 'brand', 'logo-report.png');
const DAKSH_REPORT_LOGO_BUFFER = fs.readFileSync(DAKSH_REPORT_LOGO_PNG);
const workbookLogoIds = new WeakMap();

function reportErrorStatus(error) {
  const status = Number(error && (error.statusCode || error.status));
  return Number.isFinite(status) && status >= 400 ? status : 500;
}

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function clean(value) {
  return String(value || '').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function regex(value) {
  return { $regex: clean(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
}

function appendAnd(filter, clause) {
  filter.$and = (filter.$and || []).concat([clause]);
}

function applyCommonMetadataFilters(filter, query = {}, options = {}) {
  const raw = clean(query.upiRawQr || query.rawUpi || query.rawQR || query.rawScan);
  if (query.userName) appendAnd(filter, { $or: [{ userName: regex(query.userName) }, { loginId: regex(query.userName) }, { userId: regex(query.userName) }, { duplicateScannedBy: regex(query.userName) }] });
  if (query.role) filter.role = regex(query.role);
  if (query.deviceName) appendAnd(filter, { $or: [{ deviceName: regex(query.deviceName) }, { duplicateDeviceName: regex(query.deviceName) }, { firstDeviceName: regex(query.deviceName) }] });
  if (query.deviceId) appendAnd(filter, { $or: [{ deviceId: regex(query.deviceId) }, { duplicateDeviceId: regex(query.deviceId) }, { firstDeviceId: regex(query.deviceId) }] });
  if (query.scanStatus) filter.scanStatus = upper(query.scanStatus);
  if (query.syncStatus) filter.syncStatus = clean(query.syncStatus).toLowerCase();
  if (query.entryMode) appendAnd(filter, { $or: [{ entryMode: regex(query.entryMode) }, { scanMode: regex(query.entryMode) }, { source: regex(query.entryMode) }] });
  if (query.entryChannel) appendAnd(filter, { $or: [{ entryChannel: regex(query.entryChannel) }, { source: regex(query.entryChannel) }, { deviceId: regex(query.entryChannel) }] });
  if (query.entrySource) appendAnd(filter, { $or: [{ scanSourceLabel: regex(query.entrySource) }, { source: regex(query.entrySource) }, { scanMode: regex(query.entrySource) }] });
  if (raw) appendAnd(filter, { $or: (options.rawFields || ['rawUpi', 'rawQR', 'rawScan', 'rawScanString', 'rawBarcode', 'rawScannedValue']).map((field) => ({ [field]: regex(raw) })) });
}

function parseFilterDate(value, endOfDay = false) {
  return parseIstFilterDate(value, endOfDay);
}

function duplicateReportFilter(query = {}) {
  const filter = {};
  if (query.dealerCode) filter.dealerCode = upper(query.dealerCode);
  if (query.auditId) filter.auditId = clean(query.auditId);
  if (query.partNumber) filter.partNumber = { $regex: clean(query.partNumber), $options: 'i' };
  if (query.upiCode || query.upiNo || query.upiId) filter.upiCode = { $regex: clean(query.upiCode || query.upiNo || query.upiId), $options: 'i' };
  if (query.scanType) filter.scanType = upper(query.scanType) === 'VERIFICATION' ? '__NO_VERIFICATION_TRANSACTIONS__' : upper(query.scanType);
  else filter.scanType = { $ne: 'VERIFICATION' };
  if (query.bin || query.binLocation) filter.binLocation = regex(query.bin || query.binLocation);
  applyCommonMetadataFilters(filter, query, { rawFields: ['rawUpi', 'rawQR', 'rawScan', 'rawBarcode'] });
  if (query.fromDate || query.dateFrom || query.from || query.toDate || query.dateTo || query.to) {
    filter.timestamp = {};
    const from = parseFilterDate(query.fromDate || query.dateFrom || query.from || '');
    const to = parseFilterDate(query.toDate || query.dateTo || query.to || '', true);
    if (from && !Number.isNaN(from.getTime())) filter.timestamp.$gte = from;
    if (to && !Number.isNaN(to.getTime())) filter.timestamp.$lte = to;
  }
  return filter;
}

function selectedDealerCode(payload = {}) {
  const dealerCode = String(payload.dealerCode || '').trim();
  return dealerCode && dealerCode.toLowerCase() !== 'all' ? dealerCode : '';
}

function requireDealerSelection(res) {
  return res.status(400).json({ success: false, message: 'Select dealer code first to view report' });
}

async function duplicateReportRows(query = {}) {
  const rows = await DuplicateScanLog.find(duplicateReportFilter(query)).sort({ timestamp: -1, createdAt: -1 }).limit(5000).lean();
  const grouped = new Map();
  rows.forEach((row) => {
    const upiCode = clean(row.upiCode || row.upiNo || row.rawBarcode || row.rawQR || row.rawUpi || row.rawScan || row.rawScanString);
    const key = [upper(row.dealerCode || ''), clean(row.auditId || ''), upiCode || clean(row.partNumber || ''), clean(row.scanType || '')].join('|');
    const duplicateTime = row.duplicateScanTime || row.lastDuplicateTime || row.timestamp || row.createdAt;
    const next = grouped.get(key) || {
      time: duplicateTime,
      scanTime: duplicateTime,
      lastDuplicateTime: duplicateTime,
      duplicateCount: 0,
      dealerCode: row.dealerCode || '',
      dealerName: row.dealerName || '',
      upiCode,
      partNumber: row.partNumber || '',
      scanMode: row.scanType || '',
      binLocation: row.binLocation || '',
      deviceId: row.deviceId || '',
      deviceName: row.deviceName || '',
      userId: row.userId || row.loginId || '',
      userName: row.userName || row.duplicateScannedBy || '',
      existingStatus: row.existingStatus || row.scanStatus || row.status || row.syncStatus || '',
      reason: row.reason || 'Duplicate UPI',
      firstScannedBy: row.firstScannedBy || '',
      firstScanTime: row.firstScanTime || '',
      firstDevice: row.firstDeviceName || row.firstDeviceId || '',
      firstBin: row.firstBin || '',
      duplicateScannedBy: row.duplicateScannedBy || row.userName || '',
      duplicateDevice: row.duplicateDeviceName || row.duplicateDeviceId || row.deviceName || row.deviceId || '',
      duplicateDeviceName: row.duplicateDeviceName || '',
      duplicateDeviceId: row.duplicateDeviceId || '',
      duplicateBin: row.duplicateBin || row.binLocation || '',
      existingScanId: row.existingScanId || '',
      rawScan: row.rawScan || ''
    };
    next.duplicateCount += Number(row.duplicateCount || 1) || 1;
    if (!next.scanTime || new Date(duplicateTime) < new Date(next.scanTime)) next.scanTime = duplicateTime;
    if (!next.time || new Date(duplicateTime) < new Date(next.time)) next.time = duplicateTime;
    if (!next.lastDuplicateTime || new Date(duplicateTime) > new Date(next.lastDuplicateTime)) next.lastDuplicateTime = duplicateTime;
    next.userName = row.duplicateScannedBy || row.userName || row.userId || next.userName;
    next.deviceName = row.duplicateDeviceName || row.deviceName || row.duplicateDevice || next.deviceName;
    next.deviceId = row.duplicateDeviceId || row.deviceId || row.duplicateDevice || next.deviceId;
    next.scanMode = row.scanType || next.scanMode;
    next.existingStatus = row.existingStatus || next.existingStatus;
    grouped.set(key, next);
  });
  return Array.from(grouped.values())
    .sort((a, b) => new Date(b.lastDuplicateTime || b.scanTime || 0) - new Date(a.lastDuplicateTime || a.scanTime || 0))
    .map((row) => ({
      ...row,
      duplicateRawBarcodeUpi: row.upiCode || row.rawScan || '',
      duplicateScanTime: row.scanTime || row.time,
      duplicateCount: Number(row.duplicateCount || 0),
      lastDuplicateTime: row.lastDuplicateTime || row.scanTime || row.time
    }));
}

function rejectedReportFilter(query = {}) {
  const filter = {};
  filter.found = false;
  filter.scanType = { $ne: 'VERIFICATION' };
  if (query.dealerCode) filter.dealerCode = upper(query.dealerCode);
  if (query.partNumber) {
    const text = clean(query.partNumber);
    filter.$and = (filter.$and || []).concat([{
      $or: [
        { extractedPartNumber: { $regex: text, $options: 'i' } },
        { partNumber: { $regex: text, $options: 'i' } },
        { rawScannedValue: { $regex: text, $options: 'i' } }
      ]
    }]);
  }
  if (query.scanType) filter.scanType = upper(query.scanType);
  if (query.bin) filter.binLocation = { $regex: clean(query.bin), $options: 'i' };
  if (query.dealerName) filter.dealerName = regex(query.dealerName);
  if (query.source) filter.source = regex(query.source);
  applyCommonMetadataFilters(filter, query, { rawFields: ['rawScannedValue'] });
  if (query.fromDate || query.dateFrom || query.from || query.toDate || query.dateTo || query.to) {
    filter.time = {};
    const from = parseFilterDate(query.fromDate || query.dateFrom || query.from || '');
    const to = parseFilterDate(query.toDate || query.dateTo || query.to || '', true);
    if (from && !Number.isNaN(from.getTime())) filter.time.$gte = from;
    if (to && !Number.isNaN(to.getTime())) filter.time.$lte = to;
  }
  return filter;
}

async function rejectedReportRows(query = {}) {
  const rows = await VerificationLog.find(rejectedReportFilter(query)).sort({ time: -1, createdAt: -1 }).limit(5000).lean();
  return rows.map((row) => ({
    time: row.time || row.dateTime || row.createdAt,
    rawScanValue: row.rawScannedValue || row.rawScan || row.rawQR || row.rawUpi || '',
    parsedValue: row.extractedPartNumber || row.partNumber || '',
    reason: row.reason || INVALID_PART_MESSAGE,
    device: row.deviceName || row.deviceId || '',
    user: row.staffName || row.scannedBy || row.loginId || row.userId || '',
    dealer: row.dealerCode || '',
    source: row.source || row.scanMode || row.entryMode || ''
  }));
}

const MULTIPLE_BIN_LOCATION_ALERT_COLUMNS = [
  { header: 'DEALER CODE', key: 'dealerCode', width: 18 },
  { header: 'AUDIT ID', key: 'auditId', width: 20 },
  { header: 'PART NUMBER', key: 'partNumber', width: 18 },
  { header: 'PART DESCRIPTION', key: 'partDescription', width: 34 },
  { header: 'PRIMARY BIN', key: 'primaryBin', width: 16 },
  { header: 'SECONDARY BIN LOCATIONS', key: 'secondaryBinLocations', width: 30 },
  { header: 'PRIMARY BIN QTY', key: 'primaryBinQty', width: 14 },
  { header: 'SECONDARY BIN QTY', key: 'secondaryBinQty', width: 18 },
  { header: 'EXISTING BIN LOCATIONS', key: 'existingBinLocations', width: 34 },
  { header: 'QUANTITY IN EACH BIN', key: 'quantityInEachBin', width: 26 },
  { header: 'TOTAL QUANTITY', key: 'totalQty', width: 14 },
  { header: 'LAST SCANNED BY', key: 'lastScannedBy', width: 22 },
  { header: 'LAST SCAN DATE/TIME', key: 'lastScanDateTime', width: 24 },
  { header: 'REASON FOR MULTIPLE LOCATION', key: 'reasonForMultipleLocation', width: 34 }
];

async function multipleBinLocationAlertRows(query = {}) {
  const dealerCode = selectedDealerCode(query);
  if (!dealerCode) return null;
  const dealerRecord = await Dealer.findOne({ dealerCode }).lean().catch(() => null);
  const resolvedAuditId = clean(query.auditId || query.audit || (dealerRecord ? dealerRecord.currentAuditId : '') || '');
  const filter = {
    dealerCode
  };
  if (resolvedAuditId) filter.auditId = resolvedAuditId;
  if (query.partNumber) {
    const text = clean(query.partNumber);
    filter.$and = (filter.$and || []).concat([{
      $or: [
        { normalizedPartNumber: { $regex: text, $options: 'i' } },
        { partNumber: { $regex: text, $options: 'i' } },
        { part: { $regex: text, $options: 'i' } }
      ]
    }]);
  }
  if (query.binLocation || query.bin) {
    const text = clean(query.binLocation || query.bin);
    filter.$and = (filter.$and || []).concat([{
      $or: [
        { binLocation: { $regex: text, $options: 'i' } },
        { bin: { $regex: text, $options: 'i' } }
      ]
    }]);
  }
  if (query.auditDate && !(query.fromDate || query.dateFrom || query.from || query.toDate || query.dateTo || query.to)) {
    filter.timestamp = {};
    const auditDateFrom = parseFilterDate(query.auditDate);
    const auditDateTo = parseFilterDate(query.auditDate, true);
    if (auditDateFrom && !Number.isNaN(auditDateFrom.getTime())) filter.timestamp.$gte = auditDateFrom;
    if (auditDateTo && !Number.isNaN(auditDateTo.getTime())) filter.timestamp.$lte = auditDateTo;
  } else if (query.fromDate || query.dateFrom || query.from || query.toDate || query.dateTo || query.to) {
    filter.timestamp = {};
    const from = parseFilterDate(query.fromDate || query.dateFrom || query.from || '');
    const to = parseFilterDate(query.toDate || query.dateTo || query.to || '', true);
    if (from && !Number.isNaN(from.getTime())) filter.timestamp.$gte = from;
    if (to && !Number.isNaN(to.getTime())) filter.timestamp.$lte = to;
  }
  const scopedFilter = applyTestScanMode(filter, query.testScanMode || 'real');

  const rows = await Inventory.find(scopedFilter)
    .select('dealerCode auditId partNumber normalizedPartNumber partDescription partName binLocation bin scanType type qty quantity timestamp scanTime createdAt updatedAt userName loginId username staffName reason remarks smartBinReason smartBinDecisionReason syncStatus scanStatus status deletedAt')
    .sort({ timestamp: 1, createdAt: 1, _id: 1 })
    .lean();
  const report = buildMultipleBinLocationAlertRows(rows);
  return {
    ...report,
    title: 'Multiple Bin Location Alert Report',
    columns: MULTIPLE_BIN_LOCATION_ALERT_COLUMNS,
    totalRows: report.rows.length,
    message: report.rows.length ? '' : 'No parts found in multiple bin locations for selected filter'
  };
}

const INVALID_SCAN_COLUMNS = [
  { header: 'TIME', key: 'time', width: 22 },
  { header: 'RAW SCAN VALUE', key: 'rawScanValue', width: 42 },
  { header: 'PARSED VALUE', key: 'parsedValue', width: 18 },
  { header: 'REASON', key: 'reason', width: 28 },
  { header: 'DEVICE', key: 'device', width: 24 },
  { header: 'USER', key: 'user', width: 22 },
  { header: 'DEALER', key: 'dealer', width: 18 },
  { header: 'SOURCE', key: 'source', width: 18 }
];

function groupRows(rows, keyFn, seedFn, updateFn) {
  const map = new Map();
  rows.forEach((row) => {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, seedFn(row));
    updateFn(map.get(key), row);
  });
  return Array.from(map.values());
}

const AUDIT_COLUMNS = [
  { header: 'PART NUMBER', key: 'partNumber', width: 18 },
  { header: 'PART DESCRIPTION', key: 'partDescription', width: 34 },
  { header: 'MODEL', key: 'model', width: 16 },
  { header: 'MANUFACTURING YEAR', key: 'manufacturingYear', width: 20 },
  { header: 'PRODUCT CATEGORY', key: 'productCategory', width: 20 },
  { header: 'BIN', key: 'bin', width: 16 },
  { header: 'MRP', key: 'mrp', width: 12 },
  { header: 'SCAN UPI MRP', key: 'scanUPIMRP', width: 18 },
  { header: 'CURRENT CATALOGUE MRP', key: 'currentCatalogueMRP', width: 22 },
  { header: 'AVERAGE SCANNED MRP', key: 'averageScannedMRP', width: 22 },
  { header: 'PRICE PERIOD', key: 'pricePeriod', width: 30 },
  { header: 'PRICE AGEING DAYS', key: 'priceAgeingDays', width: 18 },
  { header: 'ACTUAL STOCK VALUE (DLC)', key: 'finalInventoryValue', width: 24 },
  { header: 'DLC', key: 'dlc', width: 12 },
  { header: 'PRODUCT GROUP', key: 'productGroup', width: 18 },
  { header: 'PRODUCT SUBGROUP', key: 'partSubGroup', width: 18 },
  { header: 'DMS QTY', key: 'dmsQty', width: 12 },
  { header: 'PHYSICAL BIN QTY', key: 'physicalBinQty', width: 18 },
  { header: 'ACTUAL AUDIT QTY', key: 'physicalQty', width: 18 },
  { header: 'INWARD QTY', key: 'inwardQty', width: 14 },
  { header: 'OUTWARD QTY', key: 'outwardQty', width: 14 },
  { header: 'FITTED QTY', key: 'fittedQty', width: 14 },
  { header: 'FITTED REGD NO', key: 'regdNo', width: 16 },
  { header: 'FITTED JOB CARD NO', key: 'jobCardNo', width: 18 },
  { header: 'FITTED STATUS', key: 'fittedStatus', width: 16 },
  { header: 'DAMAGE QTY', key: 'damageQty', width: 14 },
  { header: 'SHORT QTY', key: 'shortQty', width: 12 },
  { header: 'EXCESS QTY', key: 'excessQty', width: 12 },
  { header: 'NET DIFFERENCE', key: 'netDifference', width: 16 },
  { header: 'SCAN COUNT', key: 'scanCount', width: 14 },
  { header: 'SCAN TYPE', key: 'scanType', width: 18 },
  { header: 'USER WISE SCAN SUMMARY', key: 'userWiseScanSummary', width: 42 },
  { header: 'USER AUDIT TRAIL', key: 'userAuditTrail', width: 34 },
  { header: 'DEALER', key: 'dealer', width: 24 },
  { header: 'LAST SCAN TIME', key: 'lastScanTime', width: 22 }
];

const BIN_COLUMNS = [
  { header: 'DEALER CODE', key: 'dealerCode', width: 16 },
  { header: 'BIN LOCATION', key: 'bin', width: 16 },
  { header: 'PART NUMBER', key: 'partNumber', width: 18 },
  { header: 'PART DESCRIPTION', key: 'partDescription', width: 34 },
  { header: 'PRODUCT CATEGORY', key: 'productCategory', width: 20 },
  { header: 'QTY', key: 'qty', width: 12 },
  { header: 'PHYSICAL BIN QTY', key: 'physicalBinQty', width: 18 },
  { header: 'MRP', key: 'mrp', width: 12 },
  { header: 'SCAN TYPE', key: 'scanType', width: 16 },
  { header: 'FITTED QTY', key: 'fittedQty', width: 14 },
  { header: 'FITTED STATUS', key: 'fittedStatus', width: 16 },
  { header: 'REGD NO', key: 'regdNo', width: 16 },
  { header: 'JOB CARD NO', key: 'jobCardNo', width: 18 },
  { header: 'AUTO DETECTED BIN', key: 'autoDetectedBin', width: 20 },
  { header: 'STOCK DEDUCTED FROM BIN', key: 'stockDeductedFromBin', width: 24 },
  { header: 'LAST SCAN TIME', key: 'lastScanTime', width: 22 },
  { header: 'DEVICE ID', key: 'deviceId', width: 24 }
];

const SCAN_COLUMNS = [
  { header: 'SCAN TIME', key: 'scanTime', width: 22 },
  { header: 'SCAN STATUS', key: 'scanStatus', width: 20 },
  { header: 'SCAN TYPE', key: 'scanType', width: 16 },
  { header: 'PART NUMBER', key: 'partNumber', width: 18 },
  { header: 'PART DESCRIPTION', key: 'partDescription', width: 34 },
  { header: 'QTY', key: 'quantity', width: 10 },
  { header: 'RAW QR / UPI', key: 'rawBarcode', width: 34 },
  { header: 'BIN LOCATION', key: 'binLocation', width: 16 },
  { header: 'REGD NO', key: 'regdNo', width: 16 },
  { header: 'JOB CARD NO', key: 'jobCardNo', width: 18 },
  { header: 'FITTED QTY', key: 'fittedQty', width: 14 },
  { header: 'FITTED STATUS', key: 'fittedStatus', width: 16 },
  { header: 'AUTO DETECTED BIN', key: 'autoDetectedBin', width: 20 },
  { header: 'STOCK DEDUCTED FROM BIN', key: 'stockDeductedFromBin', width: 24 },
  { header: 'DEALER CODE', key: 'dealerCode', width: 16 },
  { header: 'USER NAME', key: 'userName', width: 20 },
  { header: 'ROLE', key: 'role', width: 16 },
  { header: 'DEVICE NAME', key: 'deviceName', width: 22 },
  { header: 'DEVICE ID', key: 'deviceId', width: 24 },
  { header: 'ENTRY MODE', key: 'entryMode', width: 18 },
  { header: 'ENTRY CHANNEL', key: 'entryChannel', width: 18 },
  { header: 'ENTRY SOURCE', key: 'scanSourceLabel', width: 24 },
  { header: 'SYNC STATUS', key: 'syncStatus', width: 16 }
];

const SCAN_REGISTER_COLUMNS = [
  { header: 'SCAN TIME', key: 'scanTime', width: 22 },
  { header: 'SCAN STATUS', key: 'scanStatus', width: 16 },
  { header: 'SCAN TYPE', key: 'scanType', width: 16 },
  { header: 'DEALER CODE', key: 'dealerCode', width: 16 },
  { header: 'DEALER NAME', key: 'dealerName', width: 28 },
  { header: 'PART NUMBER', key: 'partNumber', width: 18 },
  { header: 'PART DESCRIPTION', key: 'partDescription', width: 34 },
  { header: 'QTY', key: 'quantity', width: 10 },
  { header: 'MRP', key: 'mrp', width: 12 },
  { header: 'SCAN UPI MRP', key: 'scanUPIMRP', width: 18 },
  { header: 'MANUAL MRP', key: 'manualMRP', width: 14 },
  { header: 'DLC', key: 'dlc', width: 12 },
  { header: 'ACTUAL STOCK VALUE (DLC)', key: 'finalInventoryValue', width: 24 },
  { header: 'MRP VALUE (REFERENCE)', key: 'mrpValueReference', width: 22 },
  { header: 'BIN LOCATION', key: 'binLocation', width: 16 },
  { header: 'REGD NO', key: 'regdNo', width: 16 },
  { header: 'JOB CARD NO', key: 'jobCardNo', width: 18 },
  { header: 'FITTED QTY', key: 'fittedQty', width: 14 },
  { header: 'FITTED STATUS', key: 'fittedStatus', width: 16 },
  { header: 'AUTO DETECTED BIN', key: 'autoDetectedBin', width: 20 },
  { header: 'STOCK DEDUCTED FROM BIN', key: 'stockDeductedFromBin', width: 24 },
  { header: 'RAW QR / UPI', key: 'rawQrUpi', width: 36 },
  { header: 'USER NAME', key: 'userName', width: 22 },
  { header: 'DEVICE NAME', key: 'deviceName', width: 24 },
  { header: 'DEVICE ID', key: 'deviceId', width: 24 },
  { header: 'ENTRY MODE', key: 'entryMode', width: 16 },
  { header: 'SYNC STATUS', key: 'syncStatus', width: 16 },
  { header: 'DUPLICATE STATUS', key: 'duplicateStatus', width: 18 },
  { header: 'REMARKS', key: 'remarks', width: 34 }
];

const USER_DEALER_COLUMNS = [
  { header: 'DEALER NAME', key: 'dealerName', width: 28 },
  { header: 'DEALER CODE', key: 'dealerCode', width: 16 },
  { header: 'USER NAME', key: 'userName', width: 22 },
  { header: 'USER ID', key: 'userId', width: 22 },
  { header: 'ROLE', key: 'role', width: 16 },
  { header: 'SCAN COUNT', key: 'scanCount', width: 14 },
  { header: 'TOTAL QTY', key: 'totalQty', width: 14 },
  { header: 'AUDIT QTY', key: 'auditQty', width: 14 },
  { header: 'INWARD QTY', key: 'inwardQty', width: 14 },
  { header: 'OUTWARD QTY', key: 'outwardQty', width: 14 },
  { header: 'FITTED QTY', key: 'fittedQty', width: 14 },
  { header: 'DAMAGE QTY', key: 'damageQty', width: 14 },
  { header: 'UNIQUE PARTS', key: 'uniqueParts', width: 14 },
  { header: 'DEVICES', key: 'devices', width: 34 },
  { header: 'ACTUAL STOCK VALUE (DLC)', key: 'totalDlcValue', width: 24 },
  { header: 'MRP VALUE (REFERENCE)', key: 'totalMrpValue', width: 22 },
  { header: 'LAST SCAN TIME', key: 'lastScanTime', width: 22 }
];

const DEVICE_COLUMNS = [
  { header: 'DEVICE NAME', key: 'deviceName', width: 24 },
  { header: 'DEVICE ID', key: 'deviceId', width: 28 },
  { header: 'SCAN COUNT', key: 'scanCount', width: 14 },
  { header: 'TOTAL QTY', key: 'totalQty', width: 14 },
  { header: 'AUDIT QTY', key: 'auditQty', width: 14 },
  { header: 'INWARD QTY', key: 'inwardQty', width: 14 },
  { header: 'OUTWARD QTY', key: 'outwardQty', width: 14 },
  { header: 'FITTED QTY', key: 'fittedQty', width: 14 },
  { header: 'DAMAGE QTY', key: 'damageQty', width: 14 },
  { header: 'USERS', key: 'users', width: 34 },
  { header: 'LAST SCAN TIME', key: 'lastScanTime', width: 22 }
];

const DUPLICATE_COLUMNS = [
  { header: 'SCAN TIME', key: 'scanTime', width: 22 },
  { header: 'UPI', key: 'upiCode', width: 28 },
  { header: 'PART NUMBER', key: 'partNumber', width: 18 },
  { header: 'DEALER CODE', key: 'dealerCode', width: 16 },
  { header: 'USER', key: 'userName', width: 22 },
  { header: 'DEVICE', key: 'deviceName', width: 24 },
  { header: 'SCAN MODE', key: 'scanMode', width: 16 },
  { header: 'EXISTING STATUS', key: 'existingStatus', width: 18 },
  { header: 'DUPLICATE COUNT', key: 'duplicateCount', width: 16 },
  { header: 'LAST DUPLICATE TIME', key: 'lastDuplicateTime', width: 22 },
  { header: 'REASON', key: 'reason', width: 24 }
];

const COMPLETE_AUDIT_PACK_REPORTS = [
  { key: 'bin-wise-stock', label: 'Bin Wise Stock Report' },
  { key: 'user-dealer-wise', label: 'User & Dealer Wise Report' },
  { key: 'raw-upi', label: 'Raw UPI Report' },
  { key: 'scan-register', label: 'Scan Register Report' },
  { key: 'invalid-scan-report', label: 'Invalid Scan Report' },
  { key: 'stock-summary', label: 'Stock Summary' },
  { key: 'short', label: 'Short Report' },
  { key: 'excess', label: 'Excess Report' },
  { key: 'movement_wise_stock_analysis', label: 'Movement Wise Stock Analysis Report' },
  { key: 'damage', label: 'Damage Report' },
  { key: 'category-wise-variance-summary', label: 'Category Wise Variance Summary' },
  { key: 'partwise-inventory-audit', label: 'Partwise Inventory Audit Report' },
  { key: 'parts-inventory-refresh-template', label: 'Part Inventory Refresh Template' },
  { key: 'reconciliation-report', label: 'Reconciliation Report' },
  { key: 'dealer-reconciliation-report', label: 'Dealer Reconciliation Report' },
  { key: 'dead-stock-report', label: 'Dead Stock Report' },
  { key: 'fast-moving-report', label: 'Fast Moving Report' },
  { key: 'slow-moving-report', label: 'Slow Moving Report' },
  { key: 'critical-shortage-report', label: 'Critical Shortage Report' }
];

const COMPLETE_AUDIT_PACK_REPORT_MAP = new Map(COMPLETE_AUDIT_PACK_REPORTS.map((item) => [item.key, item.label]));

const COMPLETE_AUDIT_PACK_EXTRA_OPTIONS = [
  { key: 'includeDashboardSummary', label: 'Include Dashboard Summary' },
  { key: 'includeAuditInformation', label: 'Include Audit Information' },
  { key: 'includeDealerInformation', label: 'Include Dealer Information' },
  { key: 'includeScanStatistics', label: 'Include Scan Statistics' },
  { key: 'includePendingOfflineScanDetails', label: 'Include Pending/Offline Scan Details' },
  { key: 'includeUserWiseSummary', label: 'Include User Wise Summary' }
];

const CATEGORY_VARIANCE_COLUMNS = [
  { header: 'Product Category', key: 'productCategory', width: 28 },
  { header: 'Action / Scan Type', key: 'action', width: 22 },
  { header: 'Total Scanned Parts', key: 'totalScannedParts', width: 22, numFmt: '#,##0' },
  { header: 'Total Scanned Quantity', key: 'totalScannedQuantity', width: 24, numFmt: '#,##0.00' },
  { header: 'Actual Stock Value (DLC)', key: 'sumPhysicalValueOnDLC', width: 26, numFmt: '#,##0.00' },
  { header: 'DMS Stock Value (DLC)', key: 'sumDmsValueOnDLC', width: 26, numFmt: '#,##0.00' },
  { header: 'Variance Value (DLC)', key: 'sumVarianceOnDLC', width: 24, numFmt: '#,##0.00' },
  { header: 'Actual MRP Value (Reference)', key: 'sumPhysicalValueOnMRP', width: 28, numFmt: '#,##0.00' },
  { header: 'DMS MRP Value (Reference)', key: 'sumDmsValueOnMRP', width: 28, numFmt: '#,##0.00' },
  { header: 'Variance MRP Value (Reference)', key: 'sumVarianceOnMRP', width: 30, numFmt: '#,##0.00' }
];

const RAW_UPI_COLUMNS = [
  { header: 'Time', key: 'time', width: 22 },
  { header: 'Raw Scan', key: 'rawScan', width: 50 },
  { header: 'Part Number', key: 'partNumber', width: 16 },
  { header: 'Part Description', key: 'partDescription', width: 28 },
  { header: 'Model', key: 'model', width: 16 },
  { header: 'Manufacturing Year', key: 'manufacturingYear', width: 18 },
  { header: 'Product Category', key: 'productCategory', width: 20 },
  { header: 'MRP', key: 'mrp', width: 12 },
  { header: 'DLC', key: 'dlc', width: 12 },
  { header: 'Qty', key: 'qty', width: 10 },
  { header: 'Type', key: 'type', width: 12 },
  { header: 'Bin', key: 'bin', width: 12 },
  { header: 'Regd No', key: 'regdNo', width: 16 },
  { header: 'Job Card No', key: 'jobCardNo', width: 18 },
  { header: 'Fitted Qty', key: 'fittedQty', width: 14 },
  { header: 'Auto Detected Bin', key: 'autoDetectedBin', width: 20 },
  { header: 'Stock Deducted From Bin', key: 'stockDeductedFromBin', width: 24 },
  { header: 'Dealer Code', key: 'dealerCode', width: 14 },
  { header: 'Audit ID', key: 'auditId', width: 24 },
  { header: 'Device', key: 'deviceId', width: 20 },
  { header: 'Entry Mode', key: 'entryMode', width: 18 },
  { header: 'Entry Channel', key: 'entryChannel', width: 16 },
  { header: 'Entry Source', key: 'scanSourceLabel', width: 24 },
  { header: 'Staff', key: 'staffName', width: 18 },
  { header: 'Warnings', key: 'warnings', width: 32 }
];

const RECONCILIATION_COLUMNS = [
  { header: 'PART NUMBER', key: 'partNumber', width: 18 },
  { header: 'PART DESCRIPTION', key: 'partDescription', width: 32 },
  { header: 'CATEGORY', key: 'productCategory', width: 20 },
  { header: 'DMS STOCK', key: 'dmsStock', width: 12 },
  { header: 'ACTUAL STOCK', key: 'actualStock', width: 14 },
  { header: 'VARIANCE', key: 'variance', width: 12 },
  { header: 'STATUS', key: 'status', width: 20 },
  { header: 'MRP', key: 'mrp', width: 12 },
  { header: 'DLC/DLP', key: 'dlp', width: 12 },
  { header: 'PRICING STATUS', key: 'pricingStatus', width: 24 },
  { header: 'PRICING SOURCE', key: 'pricingSource', width: 20 },
  { header: 'ACTUAL STOCK VALUE (DLC)', key: 'actualStockValue', width: 24 },
  { header: 'DMS STOCK VALUE (DLC)', key: 'dmsStockValue', width: 24 },
  { header: 'ACTUAL MRP VALUE (REFERENCE)', key: 'actualMrpValue', width: 28 },
  { header: 'DMS MRP VALUE (REFERENCE)', key: 'dmsMrpValue', width: 28 },
  { header: 'BIN LOCATION', key: 'binLocation', width: 24 },
  { header: 'MOVEMENT TYPE', key: 'movementType', width: 18 },
  { header: 'FAST/SLOW/DEAD STATUS', key: 'movementStatus', width: 22 },
  { header: 'MOVEMENT A', key: 'movementCodeA', width: 14 },
  { header: 'MOVEMENT B', key: 'movementCodeB', width: 14 },
  { header: 'AVERAGE DEMAND', key: 'averageDemand', width: 16 },
  { header: 'FORECAST', key: 'forecast', width: 12 },
  { header: 'SAFETY STOCK', key: 'safetyStock', width: 14 },
  { header: 'ROP', key: 'rop', width: 10 },
  { header: 'SHORTAGE VALUE', key: 'shortageValue', width: 16 },
  { header: 'EXCESS VALUE', key: 'excessValue', width: 16 }
];

const USER_WISE_SUMMARY_COLUMNS = [
  { header: 'USER NAME', key: 'userName', width: 22 },
  { header: 'USER ID', key: 'userId', width: 22 },
  { header: 'ROLE', key: 'role', width: 16 },
  { header: 'SCAN COUNT', key: 'scanCount', width: 14 },
  { header: 'TOTAL QTY', key: 'totalQty', width: 14 },
  { header: 'AUDIT QTY', key: 'auditQty', width: 14 },
  { header: 'INWARD QTY', key: 'inwardQty', width: 14 },
  { header: 'OUTWARD QTY', key: 'outwardQty', width: 14 },
  { header: 'FITTED QTY', key: 'fittedQty', width: 14 },
  { header: 'DAMAGE QTY', key: 'damageQty', width: 14 },
  { header: 'UNIQUE PARTS', key: 'uniqueParts', width: 14 },
  { header: 'DEALERS', key: 'dealers', width: 34 },
  { header: 'DEVICES', key: 'devices', width: 34 },
  { header: 'TOTAL MRP VALUE', key: 'totalMrpValue', width: 18 },
  { header: 'TOTAL DLC VALUE', key: 'totalDlcValue', width: 18 },
  { header: 'LAST SCAN TIME', key: 'lastScanTime', width: 22 }
];

function auditRow(row) {
  return {
    partNumber: row.partNumber || row.partNo,
    partDescription: row.partDescription || row.partName,
    model: row.model,
    manufacturingYear: row.manufacturingYear || row.year,
    category: canonicalizePartCategory(row.productCategory || ''),
    productCategory: canonicalizePartCategory(row.productCategory || ''),
    bin: row.binLocation || row.bin,
    mrp: row.currentCatalogueMRP || row.mrp,
    scanUPIMRP: row.scanUPIMRP || '',
    currentCatalogueMRP: row.currentCatalogueMRP || 0,
    averageScannedMRP: row.averageScannedMRP || 0,
    pricePeriod: row.pricePeriod || '',
    priceAgeingDays: row.priceAgeingDays || 0,
    partMovement: row.partMovement || '',
    finalInventoryValue: row.actualStockValue ?? row.physicalValueOnDlc ?? row.finalInventoryValue ?? 0,
    dlc: row.currentCatalogueDLC || row.dlc,
    productGroup: row.productGroup,
    partSubGroup: row.partSubGroup,
    dmsQty: row.dmsQty,
    physicalQty: row.physicalQty,
    physicalBinQty: row.physicalBinQty ?? row.binPhysicalQty ?? row.physicalQty,
    actualAuditQty: row.actualAuditQty ?? row.physicalQty,
    inwardQty: row.inwardQty || 0,
    outwardQty: row.outwardQty || 0,
    fittedQty: row.fittedQty || 0,
    regdNo: row.fittedRegdNo || row.regdNo || '',
    jobCardNo: row.fittedJobCardNo || row.jobCardNo || '',
    fittedRegdNo: row.fittedRegdNo || row.regdNo || '',
    fittedJobCardNo: row.fittedJobCardNo || row.jobCardNo || '',
    fittedStatus: Number(row.fittedQty || 0) > 0 ? 'Fitted' : 'Not Fitted',
    damageQty: row.damageQty || 0,
    shortQty: row.shortQty,
    excessQty: row.excessQty,
    netDifference: row.netDifference,
    scanCount: row.scanCount || 0,
    scanType: row.scanType,
    userWiseScanSummary: row.userWiseScanSummary || '',
    userAuditTrail: row.userAuditTrail || '',
    dealer: row.dealer,
    lastScanTime: row.lastScanTime
  };
}

function scanAuditRow(scan) {
  const physicalQty = scanQuantity(scan);
  const isFitted = (scan.scanType || scan.type) === 'FITTED' || scan.isFitted;
  const physicalBinQty = physicalQty;
  const fittedQty = isFitted ? Math.abs(physicalQty) : 0;
  return {
    partNumber: scan.partNumber || scan.part,
    partDescription: scan.partDescription || scan.partName,
    model: scan.model,
    manufacturingYear: scan.manufacturingYear || scan.year,
    category: canonicalizePartCategory(scan.productCategory || ''),
    productCategory: canonicalizePartCategory(scan.productCategory || ''),
    bin: isFitted ? 'FITTED - VEHICLE' : (scan.binLocation || scan.bin),
    mrp: scan.currentCatalogueMRP || 0,
    dlc: scan.currentCatalogueDLC || 0,
    productGroup: scan.productGroup,
    partSubGroup: scan.partSubGroup,
    dmsQty: scan.dmsQty || 0,
    physicalQty,
    physicalBinQty,
    actualAuditQty: physicalQty,
    inwardQty: 0,
    outwardQty: 0,
    damageQty: (scan.scanType || scan.type) === 'DAMAGE' ? physicalQty : 0,
    fittedQty,
    fittedRegdNo: isFitted ? scan.regdNo || '' : '',
    fittedJobCardNo: isFitted ? scan.jobCardNo || '' : '',
    regdNo: isFitted ? scan.regdNo || '' : '',
    jobCardNo: isFitted ? scan.jobCardNo || '' : '',
    fittedStatus: isFitted ? 'Fitted' : 'Not Fitted',
    shortQty: 0,
    excessQty: 0,
    netDifference: physicalQty - Number(scan.dmsQty || 0),
    scanCount: 1,
    scanType: scan.scanType || scan.type,
    userWiseScanSummary: scan.userName || scan.staffName || scan.loginId || '',
    userAuditTrail: scan.userName || scan.staffName || scan.loginId || '',
    dealer: scan.dealerName || scan.dealerCode,
    lastScanTime: scan.timestamp
  };
}

function validScanRow(scan) {
  const isFitted = (scan.scanType || scan.type) === 'FITTED' || scan.isFitted;
  return {
    scanTime: scan.timestamp,
    scanStatus: scan.scanStatus || ((scan.scanType || scan.type) === 'OUTWARD' ? 'OUTWARD_DONE' : 'ACCEPTED'),
    scanType: scan.scanType || scan.type || '',
    partNumber: scan.partNumber || scan.part || '',
    partDescription: scan.partDescription || scan.partName || '',
    quantity: scanQuantity(scan),
    rawBarcode: scan.rawBarcode || scan.rawQR || scan.rawUpi || scan.rawScan || scan.rawScanString || '',
    binLocation: isFitted ? 'FITTED - VEHICLE' : (scan.binLocation || scan.bin || ''),
    regdNo: scan.regdNo || '',
    jobCardNo: scan.jobCardNo || '',
    fittedQty: Number(scan.fittedQty || ((scan.scanType || scan.type) === 'FITTED' ? scan.qty || scan.quantity || 0 : 0)),
    fittedStatus: isFitted ? 'Fitted' : 'Not Fitted',
    autoDetectedBin: scan.autoDetectedBin ? 'Yes' : 'No',
    stockDeductedFromBin: scan.stockDeductedFromBin || '',
    dealerCode: scan.dealerCode || '',
    userName: scan.userName || scan.staffName || scan.loginId || '',
    userId: scan.userId || scan.loginId || '',
    role: scan.role || '',
    deviceName: scan.deviceName || '',
    deviceId: scan.deviceId || '',
    entryMode: scan.entryMode || '',
    entryChannel: scan.entryChannel || '',
    scanSourceLabel: scan.scanSourceLabel || '',
    syncStatus: scan.syncStatus || (scan.synced || scan.isSynced ? 'synced' : 'pending')
  };
}

function registerEntryMode(input = {}) {
  const text = clean(input.entryMode || input.scanMode || input.scanSourceLabel || input.source).toLowerCase();
  const deviceId = clean(input.deviceId).toUpperCase();
  if (/manual/.test(text)) return 'Manual';
  if (/mobile|camera/.test(text) || deviceId.startsWith('MOB-')) return 'Mobile';
  if (/barcode|scanner|qr|upi|bluetooth/.test(text)) return 'Barcode';
  if (/web/.test(text) || deviceId.startsWith('WEB-')) return 'Web';
  return text ? text.replace(/\b\w/g, (char) => char.toUpperCase()) : '';
}

function registerScanStatus(input = {}) {
  const explicit = clean(input.scanStatus || input.status).toUpperCase();
  const syncStatus = clean(input.syncStatus).toLowerCase();
  if (/DELETE/.test(explicit)) return 'Deleted';
  if (/DUPLICATE/.test(explicit) || syncStatus === 'duplicate') return 'Duplicate';
  if (/REJECT/.test(explicit) || syncStatus === 'rejected') return 'Rejected';
  if (/FAIL/.test(explicit) || syncStatus === 'failed') return 'Failed Sync';
  return 'Accepted';
}

function normalizeRegisterStatus(value) {
  const text = clean(value).toLowerCase().replace(/[_-]+/g, ' ');
  if (!text) return '';
  if (/duplicate/.test(text)) return 'duplicate';
  if (/reject/.test(text)) return 'rejected';
  if (/fail/.test(text)) return 'failed sync';
  if (/delete/.test(text)) return 'deleted';
  if (/accept|supervisor|outward done|synced/.test(text)) return 'accepted';
  return text;
}

function scanRegisterInventoryRow(scan) {
  const syncStatus = scan.syncStatus || (scan.synced || scan.isSynced ? 'synced' : 'pending');
  const status = registerScanStatus({ scanStatus: scan.scanStatus, syncStatus });
  const isFitted = (scan.scanType || scan.type) === 'FITTED' || scan.isFitted;
  const valueRow = scanValueRow(scan);
  return {
    scanTime: scan.timestamp,
    scanStatus: status,
    scanType: scan.scanType || scan.type || '',
    dealerCode: scan.dealerCode || '',
    dealerName: scan.dealerName || '',
    partNumber: scan.partNumber || scan.part || '',
    partDescription: scan.partDescription || scan.partName || '',
    quantity: scanQuantity(scan),
    mrp: Number(scan.currentCatalogueMRP || valueRow.valuationMRP || 0),
    scanUPIMRP: valueRow.valuationSource === 'UPI_SCANNED_MRP' ? Number(valueRow.valuationMRP || 0) : '',
    manualMRP: valueRow.valuationSource === 'MANUAL_ENTERED_MRP' ? Number(valueRow.valuationMRP || 0) : '',
    dlc: Number(scan.currentCatalogueDLC || 0),
    finalInventoryValue: money(scanQuantity(scan) * Number(scan.currentCatalogueDLC || 0)),
    mrpValueReference: Number(valueRow.finalInventoryValue || 0),
    binLocation: isFitted ? 'FITTED - VEHICLE' : (scan.binLocation || scan.bin || ''),
    regdNo: scan.regdNo || '',
    jobCardNo: scan.jobCardNo || '',
    fittedQty: Number(scan.fittedQty || ((scan.scanType || scan.type) === 'FITTED' ? scan.qty || scan.quantity || 0 : 0)),
    fittedStatus: isFitted ? 'Fitted' : 'Not Fitted',
    autoDetectedBin: scan.autoDetectedBin ? 'Yes' : 'No',
    stockDeductedFromBin: scan.stockDeductedFromBin || '',
    rawQrUpi: scan.rawBarcode || scan.rawQR || scan.rawUpi || scan.rawScan || scan.rawScanString || scan.upiNo || scan.upiId || '',
    userName: scan.userName || scan.staffName || scan.loginId || scan.userId || '',
    deviceName: scan.deviceName || '',
    deviceId: scan.deviceId || '',
    entryMode: registerEntryMode(scan),
    syncStatus,
    duplicateStatus: status === 'Duplicate' ? 'Duplicate' : 'No',
    remarks: clean([scan.remarks, ...(Array.isArray(scan.warnings) ? scan.warnings : [])].filter(Boolean).join(', '))
  };
}

function scanRegisterDuplicateRow(row) {
  return {
    scanTime: row.scanTime || row.duplicateScanTime || row.time,
    scanStatus: 'Duplicate',
    scanType: row.scanMode || row.scanType || '',
    dealerCode: row.dealerCode || '',
    dealerName: row.dealerName || '',
    partNumber: row.partNumber || '',
    partDescription: row.partDescription || '',
    quantity: 0,
    mrp: '',
    scanUPIMRP: '',
    manualMRP: '',
    finalInventoryValue: '',
    binLocation: row.duplicateBin || row.binLocation || '',
    fittedStatus: 'Not Fitted',
    rawQrUpi: row.duplicateRawBarcodeUpi || row.upiCode || row.rawScan || '',
    upiCode: row.upiCode || '',
    userName: row.userName || row.duplicateScannedBy || row.userId || '',
    deviceName: row.deviceName || row.duplicateDeviceName || row.duplicateDevice || '',
    deviceId: row.deviceId || row.duplicateDeviceId || row.duplicateDevice || '',
    entryMode: registerEntryMode(row),
    syncStatus: 'duplicate',
    duplicateStatus: 'Duplicate',
    existingStatus: row.existingStatus || '',
    duplicateCount: Number(row.duplicateCount || 0),
    lastDuplicateTime: row.lastDuplicateTime || row.scanTime || row.time,
    remarks: row.reason || 'Duplicate UPI'
  };
}

function scanRegisterRejectedRow(row) {
  return {
    scanTime: row.scanTime,
    scanStatus: 'Rejected',
    scanType: row.scanType || '',
    dealerCode: row.dealerCode || '',
    dealerName: row.dealerName || '',
    partNumber: row.partNumber || '',
    partDescription: '',
    quantity: 0,
    mrp: '',
    scanUPIMRP: '',
    manualMRP: '',
    finalInventoryValue: '',
    binLocation: row.binLocation || '',
    fittedStatus: 'Not Fitted',
    rawQrUpi: row.rawQrUpi || '',
    userName: row.userName || '',
    deviceName: row.deviceName || '',
    deviceId: row.deviceId || '',
    entryMode: registerEntryMode({ ...row, source: row.entryMode || 'manual' }),
    syncStatus: row.syncStatus || 'rejected',
    duplicateStatus: 'No',
    remarks: row.reason || INVALID_PART_MESSAGE
  };
}

function stripRegisterOnlyFilters(query = {}) {
  const copy = { ...query };
  delete copy.scanStatus;
  delete copy.syncStatus;
  return copy;
}

function rowReportScanWindow(query = {}) {
  if (query.format) return {};
  const { page, limit } = pagination(query);
  const scanLimit = Math.min(2500, Math.max(limit * page + limit, limit, 250));
  return { _scanLimit: scanLimit };
}

function registerFilterMatch(row = {}, query = {}) {
  const equals = (actual, expected) => !clean(expected) || clean(actual).toLowerCase() === clean(expected).toLowerCase();
  const contains = (actual, expected) => !clean(expected) || clean(actual).toLowerCase().includes(clean(expected).toLowerCase());
  if (clean(query.scanStatus) && normalizeRegisterStatus(row.scanStatus) !== normalizeRegisterStatus(query.scanStatus)) return false;
  if (!equals(row.syncStatus, query.syncStatus)) return false;
  if (!equals(row.scanType, query.scanType)) return false;
  if (!contains(row.userName, query.userName)) return false;
  if (!contains(row.deviceName, query.deviceName)) return false;
  if (!contains(row.deviceId, query.deviceId)) return false;
  if (!contains(row.entryMode, query.entryMode)) return false;
  return true;
}

async function scanRegisterRows(query = {}, options = {}) {
  const sourceQuery = { ...stripRegisterOnlyFilters(query), ...rowReportScanWindow(query) };
  const hasPreloadedScans = Array.isArray(options.scans);
  const data = options.reportData || (hasPreloadedScans ? { scans: options.scans } : await reportModule.buildReportData(sourceQuery));
  const duplicates = await duplicateReportRows(sourceQuery);
  const scans = hasPreloadedScans
    ? options.scans
    : Array.isArray(data.scans)
      ? data.scans
      : [];
  return [
    ...scans.map(scanRegisterInventoryRow),
    ...duplicates.map(scanRegisterDuplicateRow)
  ]
    .filter((row) => registerFilterMatch(row, query))
    .sort((a, b) => new Date(b.scanTime || 0) - new Date(a.scanTime || 0));
}

function scanTypeQtyBucket(scan) {
  const type = String(scan.scanType || scan.type || '').toUpperCase();
  if (type === 'VERIFICATION') return '';
  if (type === 'AUDIT') return 'auditQty';
  if (type === 'INWARD') return 'inwardQty';
  if (type === 'OUTWARD') return 'outwardQty';
  if (type === 'FITTED') return 'fittedQty';
  if (type === 'DAMAGE') return 'damageQty';
  return '';
}

function isMovementScan(scan = {}) {
  return ['INWARD', 'OUTWARD', 'DAMAGE', 'FITTED'].includes(String(scan.scanType || scan.type || '').toUpperCase());
}

function scanQuantity(scan) {
  if (scan._reportSignedQty !== undefined) return signedScanQuantity(scan, 0);
  const qty = Math.abs(Number(scan.qty !== undefined ? scan.qty : scan.quantity || 0));
  const type = String(scan.scanType || scan.type || '').toUpperCase();
  if (type === 'INWARD') return qty;
  if (['OUTWARD', 'FITTED', 'DAMAGE'].includes(type)) return -qty;
  if (type === 'VERIFICATION') return 0;
  return 0;
}

function scanUserLabel(scan) {
  return scan.userName || scan.staffName || scan.loginId || scan.userId || '';
}

function scanDeviceLabel(scan) {
  return scan.deviceName || scan.deviceId || '';
}

function groupedScanSummary(scans, keyFn, seedFn, memberFields = {}) {
  const memberKeys = Object.keys(memberFields);
  return groupRows(
    scans,
    keyFn,
    (scan) => ({
      ...seedFn(scan),
      scanCount: 0,
      totalQty: 0,
      auditQty: 0,
      inwardQty: 0,
      outwardQty: 0,
      fittedQty: 0,
      damageQty: 0,
      totalMrpValue: 0,
      totalDlcValue: 0,
      uniquePartSet: new Set(),
      memberSets: Object.fromEntries(memberKeys.map((key) => [key, new Set()])),
      lastScanTime: scan.timestamp
    }),
    (target, scan) => {
      const qty = scanQuantity(scan);
      target.scanCount += 1;
      target.totalQty += qty;
      target.totalMrpValue = money(target.totalMrpValue + Number(scanValueRow(scan).finalInventoryValue || 0));
      target.totalDlcValue = money(target.totalDlcValue + qty * Number(scan.currentCatalogueDLC || 0));
      const bucket = scanTypeQtyBucket(scan);
      if (bucket) target[bucket] += qty;
      const part = scan.partNumber || scan.part || '';
      if (part) target.uniquePartSet.add(part);
      memberKeys.forEach((key) => {
        const member = memberFields[key](scan);
        if (member) target.memberSets[key].add(member);
      });
      if (new Date(scan.timestamp) > new Date(target.lastScanTime || 0)) target.lastScanTime = scan.timestamp;
    }
  ).map((row) => {
    const uniqueParts = row.uniquePartSet.size;
    const members = Object.fromEntries(Object.entries(row.memberSets).map(([key, set]) => [key, Array.from(set).sort().join(', ')]));
    delete row.uniquePartSet;
    delete row.memberSets;
    return { ...row, uniqueParts, ...members };
  }).sort((a, b) => Number(b.scanCount || 0) - Number(a.scanCount || 0) || String(a.userName || a.dealerName || a.deviceName || '').localeCompare(String(b.userName || b.dealerName || b.deviceName || '')));
}

function selectRows(data, type) {
  if (type === 'bin-wise-stock' || type === 'bin-stock' || type === 'bin-wise') {
    const binScans = data.scans.filter((scan) => String(scan.scanType || scan.type || '').toUpperCase() !== 'FITTED');
    return groupRows(
      binScans,
      (scan) => `${scan.dealerCode || 'UNKNOWN'}:${scan.binLocation || scan.bin || 'UNKNOWN'}:${scan.partNumber || scan.part || ''}:${scan.scanType || scan.type || ''}`,
      (scan) => ({
        dealerCode: scan.dealerCode || '',
        bin: scan.binLocation || scan.bin || 'UNKNOWN',
        partNumber: scan.partNumber || scan.part || '',
        partDescription: scan.partDescription || scan.partName || '',
        productCategory: canonicalizePartCategory(scan.productCategory || ''),
        mrp: scan.currentCatalogueMRP || 0,
        scanType: scan.scanType || scan.type || '',
        fittedQty: 0,
        fittedStatus: '',
        regdNo: '',
        jobCardNo: '',
        autoDetectedBin: '',
        stockDeductedFromBin: '',
        qty: 0,
        physicalBinQty: 0,
        actualAuditQty: 0,
        lastScanTime: scan.timestamp,
        deviceId: scan.deviceId || ''
      }),
      (target, scan) => {
        target.qty += scanQuantity(scan);
        target.physicalBinQty = target.qty;
        target.actualAuditQty = target.qty;
        if (!target.partDescription) target.partDescription = scan.partDescription || scan.partName || '';
        if (!target.productCategory) target.productCategory = canonicalizePartCategory(scan.productCategory || '');
        if (!target.deviceId) target.deviceId = scan.deviceId || '';
        if ((scan.scanType || scan.type) === 'FITTED') target.fittedQty += Number(scan.fittedQty || scan.qty || scan.quantity || 0);
        target.fittedStatus = target.fittedQty > 0 ? 'Fitted' : 'Not Fitted';
        if (!target.regdNo) target.regdNo = scan.regdNo || '';
        if (!target.jobCardNo) target.jobCardNo = scan.jobCardNo || '';
        if (!target.autoDetectedBin && scan.autoDetectedBin) target.autoDetectedBin = 'Yes';
        if (!target.stockDeductedFromBin) target.stockDeductedFromBin = scan.stockDeductedFromBin || '';
        if (new Date(scan.timestamp) > new Date(target.lastScanTime || 0)) target.lastScanTime = scan.timestamp;
      }
    ).sort((a, b) => String(a.bin).localeCompare(String(b.bin)) || String(a.partNumber).localeCompare(String(b.partNumber)));
  }

  if (type === 'user-dealer-wise') {
    return groupedScanSummary(
      data.scans,
      (scan) => [
        scan.dealerCode || scan.dealerName || 'UNKNOWN',
        scan.userId || scan.loginId || scan.staffName || scan.userName || 'UNKNOWN',
        scan.role || ''
      ].join('::'),
      (scan) => ({
        dealerCode: scan.dealerCode || 'UNKNOWN',
        dealerName: scan.dealerName || scan.dealerCode || 'UNKNOWN',
        userName: scan.userName || scan.staffName || scan.loginId || 'UNKNOWN',
        userId: scan.userId || scan.loginId || '',
        role: scan.role || ''
      }),
      {
        devices: scanDeviceLabel
      }
    );
  }

  if (type === 'valid-scans') return data.scans.map(validScanRow);
  if (type === 'device-wise') {
    return groupedScanSummary(
      data.scans,
      (scan) => scan.deviceId || scan.deviceName || 'UNKNOWN',
      (scan) => ({
        deviceName: scan.deviceName || scan.deviceId || 'UNKNOWN',
        deviceId: scan.deviceId || ''
      }),
      {
        users: scanUserLabel
      }
    );
  }

  if (type === 'raw-upi') return data.rawLogRows;
  return data.finalRows.map(auditRow);
}

function packText(value) {
  if (value === undefined || value === null || value === '') return '-';
  if (Array.isArray(value)) return value.filter(Boolean).map((item) => packText(item)).filter(Boolean).join(', ') || '-';
  if (value instanceof Date) return formatIstDateTime(value);
  if (typeof value === 'number') return Number.isInteger(value)
    ? value.toLocaleString('en-IN')
    : value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  const text = String(value).trim();
  return text || '-';
}

function packNumber(value, digits = 0) {
  const number = Number(value || 0);
  return number.toLocaleString('en-IN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function packCurrency(value) {
  const number = Number(value || 0);
  return `₹ ${number.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function packPercentage(value) {
  const number = Number(value || 0);
  return `${number.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%`;
}

function sanitizeSheetName(name = 'Sheet') {
  const text = String(name || 'Sheet').replace(/[:\\/?*\[\]]/g, ' ').replace(/\s+/g, ' ').trim() || 'Sheet';
  return text.slice(0, 31);
}

function uniqueSheetName(workbook, desiredName) {
  const used = new Set((workbook.worksheets || []).map((sheet) => String(sheet.name || '').toLowerCase()));
  const base = sanitizeSheetName(desiredName);
  if (!used.has(base.toLowerCase())) return base;
  for (let index = 2; index < 100; index += 1) {
    const suffix = ` (${index})`;
    const candidate = sanitizeSheetName(`${base.slice(0, Math.max(1, 31 - suffix.length))}${suffix}`);
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return sanitizeSheetName(`${base.slice(0, 28)}...`);
}

function normalizePackRow(row = {}) {
  const flattened = formatDateLikeFields(row);
  return Object.fromEntries(Object.entries(flattened).map(([key, value]) => {
    if (Array.isArray(value)) return [key, value.filter(Boolean).join(', ')];
    if (value && typeof value === 'object' && !(value instanceof Date)) return [key, JSON.stringify(value)];
    return [key, value];
  }));
}

function countRows(rows = [], predicate = () => true) {
  return rows.reduce((sum, row) => sum + (predicate(row) ? 1 : 0), 0);
}

function countScanRegisterRows(rows = []) {
  return rows.reduce((counts, row) => {
    const scanStatus = clean(row.scanStatus).toLowerCase();
    const syncStatus = clean(row.syncStatus).toLowerCase();
    const key = scanStatus.includes('duplicate') || syncStatus === 'duplicate'
      ? 'duplicate'
      : scanStatus.includes('reject') || syncStatus === 'rejected'
        ? 'rejected'
        : scanStatus.includes('fail') || syncStatus === 'failed'
          ? 'failed'
          : scanStatus.includes('delete')
            ? 'deleted'
            : syncStatus === 'pending'
              ? 'pending'
              : syncStatus === 'synced'
                ? 'synced'
                : 'accepted';
    counts[key] = (counts[key] || 0) + 1;
    counts.total += 1;
    return counts;
  }, { accepted: 0, pending: 0, failed: 0, duplicate: 0, rejected: 0, deleted: 0, synced: 0, total: 0 });
}

function auditSyncStatus(counts = {}) {
  const pending = Number(counts.pending || 0);
  const failed = Number(counts.failed || 0);
  const duplicate = Number(counts.duplicate || 0);
  const rejected = Number(counts.rejected || 0);
  if (failed > 0 && pending > 0) return `Mixed (${failed} failed, ${pending} pending)`;
  if (failed > 0) return `Failed (${failed})`;
  if (pending > 0) return `Pending (${pending})`;
  if (duplicate > 0 || rejected > 0) return 'Synced with exceptions';
  return 'Synced';
}

function packColumnWidths(columns = [], rows = [], sampleSize = 100, maxWidth = 60) {
  const samples = Array.isArray(rows) ? rows.slice(0, sampleSize) : [];
  return columns.map((column, index) => {
    const headerLength = String(column.header || column.key || `Column ${index + 1}`).length;
    const sampleLength = samples.reduce((max, row) => Math.max(max, packText(row[column.key]).length), 0);
    return {
      ...column,
      width: Math.min(maxWidth, Math.max(column.width || 12, headerLength + 2, sampleLength + 2))
    };
  });
}

function packMetricWidths(rows = []) {
  const samples = Array.isArray(rows) ? rows.slice(0, 120) : [];
  const sectionWidth = Math.min(28, Math.max(16, samples.reduce((max, row) => Math.max(max, packText(row.section).length), 0) + 2));
  const metricWidth = Math.min(36, Math.max(18, samples.reduce((max, row) => Math.max(max, packText(row.metric).length), 0) + 2));
  const valueWidth = Math.min(70, Math.max(24, samples.reduce((max, row) => Math.max(max, packText(row.value).length), 0) + 2));
  return [sectionWidth, metricWidth, valueWidth];
}

function styleHeaderRow(row, fill = PACK_THEME.header) {
  row.font = { name: PACK_FONT, size: 11, bold: true, color: { argb: PACK_THEME.titleText } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  row.height = 24;
  row.eachCell((cell) => {
    cell.border = {
      top: { style: 'thin', color: { argb: PACK_THEME.border } },
      left: { style: 'thin', color: { argb: PACK_THEME.border } },
      bottom: { style: 'thin', color: { argb: PACK_THEME.border } },
      right: { style: 'thin', color: { argb: PACK_THEME.border } }
    };
  });
}

function styleDataRow(row, columns, options = {}) {
  const zebraFill = options.rowIndex !== undefined && options.rowIndex % 2 === 1 ? PACK_THEME.altRow : PACK_THEME.value;
  row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
    const column = columns[columnNumber - 1] || {};
    const key = clean(column.key || '').toLowerCase();
    const numericValue = typeof cell.value === 'number'
      ? cell.value
      : (cell.value && typeof cell.value === 'object' && typeof cell.value.result === 'number'
        ? cell.value.result
        : NaN);
    cell.border = {
      top: { style: 'thin', color: { argb: PACK_THEME.border } },
      left: { style: 'thin', color: { argb: PACK_THEME.border } },
      bottom: { style: 'thin', color: { argb: PACK_THEME.border } },
      right: { style: 'thin', color: { argb: PACK_THEME.border } }
    };
    const keyText = clean(column.key || '').toLowerCase();
    const isQuantityColumn = /(^|_)(qty|quantity|count|parts|rows|scan|scans|users|devices|bins|damage|short|excess|pending|failed|duplicate|rejected|deleted)(_|$)/.test(keyText)
      && !/value|amount|price|cost|mrp|dlc|dms|variance|difference|inventory|stock/.test(keyText);
    const isCurrencyColumn = /value|amount|price|cost|mrp|dlc|dms|variance|difference|inventory|stock/.test(keyText);
    const shouldRightAlign = options.rightAlignColumns && options.rightAlignColumns.has(columnNumber - 1);
    cell.alignment = {
      vertical: 'middle',
      horizontal: isQuantityColumn ? 'center' : shouldRightAlign || isCurrencyColumn ? 'right' : 'left',
      wrapText: true
    };
    cell.font = { name: PACK_FONT, size: 10, color: { argb: 'FF1F2937' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebraFill } };
    if (column.numFmt) cell.numFmt = column.numFmt;
    if (/^(status|reconciliationstatus|syncstatus|scanstatus|inventoryriskstatus)$/i.test(key)) {
      const tone = packValueTone({ label: column.header || key, value: cell.value, kind: 'status' });
      if (tone) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: tone.fill } };
        cell.font = { name: PACK_FONT, size: 10, bold: true, color: { argb: tone.font } };
      }
    } else if (Number.isFinite(numericValue)) {
      if (numericValue < 0 && /(variance|difference|short|damage|loss|netdifference)/.test(key)) {
        cell.font = { name: PACK_FONT, size: 10, bold: key.includes('variance') || key.includes('difference'), color: { argb: PACK_THEME.dangerText } };
        if (key.includes('short') || key.includes('damage') || key.includes('variance')) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE2E2' } };
        }
      } else if (numericValue > 0 && /(excess|surplus)/.test(key)) {
        cell.font = { name: PACK_FONT, size: 10, bold: key.includes('excess'), color: { argb: PACK_THEME.successText } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PACK_THEME.sectionGreen } };
      }
    }
  });
}

function addSheetFooter(sheet, generatedAt = '') {
  const stamp = generatedAt ? `Generated: ${generatedAt}` : 'Generated: Premium audit pack export';
  sheet.headerFooter = {
    oddFooter: `&LDaksh Inventory Solution V2&C${stamp}&RPage &P of &N`
  };
}

const PACK_CURRENCY_FORMAT = '₹ #,##0.00;[Red]-₹ #,##0.00';
const PACK_INTEGER_FORMAT = '#,##0';
const PACK_THEME = {
  title: 'FF1F4E78',
  titleText: 'FFFFFFFF',
  subtitle: 'FFDCEEFF',
  subtitleText: 'FF1F4E78',
  sectionBlue: 'FFDCEEFF',
  sectionGreen: 'FFD9EAD3',
  sectionGold: 'FFF4E3B2',
  sectionGrey: 'FFF3F5F7',
  warningFill: 'FFFBE4D5',
  header: 'FF1F4E78',
  total: 'FFD9EAD3',
  value: 'FFFFFFFF',
  altRow: 'FFF8FAFC',
  border: 'FFD0D7DE',
  labelBorder: 'FFC4D0DB',
  logo: 'FFF4E3B2',
  successText: 'FF166534',
  warningText: 'FF9A3412',
  dangerText: 'FFB91C1C'
};

const PACK_FONT = 'Calibri';

function packValueTone(item = {}) {
  const label = clean(item.label || '').toLowerCase();
  const valueText = clean(item.value || '').toLowerCase();
  const kind = clean(item.kind || '').toLowerCase();
  const text = `${label} ${valueText}`.trim();
  if (kind === 'status' || /status/.test(label)) {
    if (/balanced|matched|synced|accepted|completed|ok|success/.test(text)) {
      return { fill: PACK_THEME.sectionGreen, font: PACK_THEME.successText };
    }
    if (/excess|duplicate/.test(text)) {
      return { fill: PACK_THEME.sectionGold, font: PACK_THEME.warningText };
    }
    if (/short|failed|reject|damage|pending|error/.test(text)) {
      return { fill: PACK_THEME.warningFill, font: PACK_THEME.dangerText };
    }
    return { fill: PACK_THEME.sectionBlue, font: PACK_THEME.subtitleText };
  }
  if (kind === 'remarks') return { fill: PACK_THEME.sectionGrey, font: 'FF1F2937' };
  if (kind === 'warning') return { fill: PACK_THEME.warningFill, font: PACK_THEME.warningText };
  if (kind === 'danger') return { fill: PACK_THEME.warningFill, font: PACK_THEME.dangerText };
  const numeric = packNumberLike(item.value, NaN);
  if (Number.isFinite(numeric)) {
    if (numeric < 0) return { fill: PACK_THEME.warningFill, font: PACK_THEME.dangerText };
    if (numeric > 0 && /excess|surplus|positive/.test(label)) {
      return { fill: PACK_THEME.sectionGreen, font: PACK_THEME.successText };
    }
    if (numeric > 0 && /short|damage|loss/.test(label)) {
      return { fill: PACK_THEME.warningFill, font: PACK_THEME.dangerText };
    }
  }
  return { fill: PACK_THEME.value, font: 'FF1F2937' };
}

function packNumberLike(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value ?? '')
    .replace(/[₹,$,\s]/g, '')
    .replace(/^\((.*)\)$/, '-$1');
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function firstPresentValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '') ?? '';
}

function firstNumericValue(...values) {
  for (const value of values) {
    const number = packNumberLike(value, NaN);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function countDistinctBy(rows = [], selector = () => '') {
  return new Set(rows.map((row, index) => clean(selector(row, index))).filter(Boolean)).size;
}

function sumBy(rows = [], selector = () => 0) {
  return rows.reduce((sum, row, index) => sum + packNumberLike(selector(row, index), 0), 0);
}

function normalizePackCategory(value) {
  return canonicalizePartCategory(value || 'Uncategorized') || 'Uncategorized';
}

function summarizeByCategory(rows = [], options = {}) {
  const buckets = new Map();
  rows.forEach((row, index) => {
    const category = normalizePackCategory(firstPresentValue(
      options.categoryResolver ? options.categoryResolver(row, index) : '',
      row.productCategory,
      row.category,
      row.partCategory,
      row.partDescription,
      row.partName
    ));
    const bucket = buckets.get(category) || {
      category,
      parts: 0,
      qty: 0,
      value: 0,
      dmsQty: 0,
      actualQty: 0,
      dmsValue: 0,
      actualValue: 0,
      shortValue: 0,
      excessValue: 0,
      varianceQty: 0,
      varianceValue: 0,
      partSet: new Set()
    };
    bucket.parts += 1;
    bucket.qty += packNumberLike(options.qtyResolver ? options.qtyResolver(row, index) : firstPresentValue(row.physicalQty, row.actualStock, row.qty, row.totalQty, row.scanCount, row.dmsStock), 0);
    bucket.value += packNumberLike(options.valueResolver ? options.valueResolver(row, index) : firstPresentValue(row.finalInventoryValue, row.stockValue, row.actualStockValue, row.totalDlcValue), 0);
    bucket.dmsQty += packNumberLike(options.dmsQtyResolver ? options.dmsQtyResolver(row, index) : firstPresentValue(row.dmsStock, row.systemQty), 0);
    bucket.actualQty += packNumberLike(options.actualQtyResolver ? options.actualQtyResolver(row, index) : firstPresentValue(row.physicalQty, row.actualStock, row.qty), 0);
    bucket.dmsValue += packNumberLike(options.dmsValueResolver ? options.dmsValueResolver(row, index) : firstPresentValue(row.dmsStockValue), 0);
    bucket.actualValue += packNumberLike(options.actualValueResolver ? options.actualValueResolver(row, index) : firstPresentValue(row.actualStockValue, row.finalInventoryValue), 0);
    bucket.shortValue += packNumberLike(options.shortValueResolver ? options.shortValueResolver(row, index) : firstPresentValue(row.shortageValue, row.shortValue), 0);
    bucket.excessValue += packNumberLike(options.excessValueResolver ? options.excessValueResolver(row, index) : firstPresentValue(row.excessValue), 0);
    bucket.varianceQty += packNumberLike(options.varianceQtyResolver ? options.varianceQtyResolver(row, index) : firstPresentValue(row.varianceQty, row.variance), 0);
    bucket.varianceValue += packNumberLike(options.varianceValueResolver ? options.varianceValueResolver(row, index) : firstPresentValue(row.varianceDlc, row.varianceValue, row.netDifference), 0);
    bucket.partSet.add(clean(firstPresentValue(row.partNumber, row.partNo, row._id)));
    buckets.set(category, bucket);
  });
  const aggregated = Array.from(buckets.values()).sort((a, b) => b.value - a.value || a.category.localeCompare(b.category));
  const totalValue = aggregated.reduce((sum, bucket) => sum + bucket.value, 0);
  return aggregated.map((bucket) => ({
    ...bucket,
    uniqueParts: bucket.partSet.size,
    share: totalValue > 0 ? bucket.value / totalValue : 0
  }));
}

function packResolveColumns(columns = [], rows = [], minimumColumns = 12, maxWidth = 60) {
  const resolved = packColumnWidths(columns, rows, 100, maxWidth).map((column) => {
    if (column.numFmt) return column;
    const text = `${column.key || ''} ${column.header || ''}`.toLowerCase();
    if (/date|time|timestamp/.test(text)) return column;
    if (/value|amount|price|cost|mrp|dlc|dlp|variance|difference|inventory|stock/.test(text) && !/qty|quantity|count|lines|parts|rows|users|devices/.test(text)) {
      return { ...column, numFmt: PACK_CURRENCY_FORMAT };
    }
    if (/qty|quantity|count|lines|parts|rows|users|devices|scan|short|excess|damage|matched|pending|failed|duplicate/.test(text)) {
      return { ...column, numFmt: PACK_INTEGER_FORMAT };
    }
    return column;
  });
  while (resolved.length < minimumColumns) {
    resolved.push({ header: '', key: `blank_${resolved.length + 1}`, width: 2.5 });
  }
  return resolved;
}

function packStyleRange(sheet, startRow, endRow, startCol, endCol, options = {}) {
  for (let rowNumber = startRow; rowNumber <= endRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    if (options.height) row.height = options.height;
    for (let colNumber = startCol; colNumber <= endCol; colNumber += 1) {
      const cell = sheet.getCell(rowNumber, colNumber);
      cell.border = {
        top: { style: 'thin', color: { argb: options.borderColor || PACK_THEME.border } },
        left: { style: 'thin', color: { argb: options.borderColor || PACK_THEME.border } },
        bottom: { style: 'thin', color: { argb: options.borderColor || PACK_THEME.border } },
        right: { style: 'thin', color: { argb: options.borderColor || PACK_THEME.border } }
      };
      if (options.fill) cell.fill = options.fill;
      if (options.font) cell.font = options.font;
      if (options.alignment) cell.alignment = options.alignment;
    }
  }
}

function packMergeBand(sheet, rowNumber, startCol, endCol, value, options = {}) {
  sheet.mergeCells(rowNumber, startCol, rowNumber, endCol);
  const cell = sheet.getCell(rowNumber, startCol);
  cell.value = value;
  packStyleRange(sheet, rowNumber, rowNumber, startCol, endCol, options);
}

function packRenderTitleBlock(sheet, totalColumns, subtitle) {
  packMergeBand(sheet, 1, 1, 3, '', {
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } },
    font: { name: PACK_FONT, size: 12, bold: true, color: { argb: PACK_THEME.title } },
    alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
    borderColor: PACK_THEME.border,
    height: 28
  });
  const logoId = packGetDakshReportLogoId(sheet.workbook);
  if (logoId !== null) {
    sheet.addImage(logoId, {
      tl: { col: 0.2, row: 0.16 },
      ext: { width: 126, height: 32 }
    });
  }
  packMergeBand(sheet, 1, 4, totalColumns, 'Daksh Inventory Solution V2', {
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: PACK_THEME.title } },
    font: { name: PACK_FONT, size: 20, bold: true, color: { argb: PACK_THEME.titleText } },
    alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
    borderColor: PACK_THEME.title,
    height: 26
  });
  packMergeBand(sheet, 2, 1, 3, 'Premium Audit Pack', {
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: PACK_THEME.sectionGrey } },
    font: { name: PACK_FONT, size: 10, bold: true, color: { argb: PACK_THEME.subtitleText } },
    alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
    borderColor: PACK_THEME.border,
    height: 22
  });
  packMergeBand(sheet, 2, 4, totalColumns, subtitle || '', {
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: PACK_THEME.subtitle } },
    font: { name: PACK_FONT, size: 12, bold: true, color: { argb: PACK_THEME.subtitleText } },
    alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
    borderColor: PACK_THEME.border,
    height: 22
  });
}

function packRenderInfoBlock(sheet, startRow, totalColumns, leftTitle, leftRows = [], rightTitle, rightRows = []) {
  const leftEnd = 6;
  const rightStart = 7;
  const rightEnd = Math.max(totalColumns, 12);
  packMergeBand(sheet, startRow, 1, leftEnd, leftTitle || 'Dealer Details', {
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: PACK_THEME.sectionBlue } },
    font: { name: PACK_FONT, size: 11, bold: true, color: { argb: PACK_THEME.subtitleText } },
    alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
    borderColor: PACK_THEME.border,
    height: 20
  });
  packMergeBand(sheet, startRow, rightStart, rightEnd, rightTitle || 'Audit Details', {
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: PACK_THEME.sectionGold } },
    font: { name: PACK_FONT, size: 11, bold: true, color: { argb: PACK_THEME.subtitleText } },
    alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
    borderColor: PACK_THEME.border,
    height: 20
  });
  const rowCount = Math.max(leftRows.length, rightRows.length);
  for (let index = 0; index < rowCount; index += 1) {
    const rowNumber = startRow + 1 + index;
    const left = leftRows[index] || {};
    const right = rightRows[index] || {};
    packMergeBand(sheet, rowNumber, 1, 2, left.label ? `${left.label} :` : '', {
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: PACK_THEME.sectionBlue } },
      font: { name: PACK_FONT, size: 10, bold: true, color: { argb: PACK_THEME.subtitleText } },
      alignment: { vertical: 'middle', horizontal: 'right', wrapText: true },
      borderColor: PACK_THEME.border,
      height: 20
    });
    const leftTone = packValueTone({ label: left.label, value: left.value, kind: left.kind });
    packMergeBand(sheet, rowNumber, 3, leftEnd, firstPresentValue(left.value, ''), {
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: leftTone.fill || PACK_THEME.value } },
      font: { name: PACK_FONT, size: 10, bold: Boolean(left.boldValue), color: { argb: leftTone.font || 'FF1F2937' } },
      alignment: { vertical: 'middle', horizontal: 'left', wrapText: true },
      borderColor: PACK_THEME.border,
      height: 20
    });
    packMergeBand(sheet, rowNumber, rightStart, rightStart + 1, right.label ? `${right.label} :` : '', {
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: PACK_THEME.sectionGold } },
      font: { name: PACK_FONT, size: 10, bold: true, color: { argb: PACK_THEME.subtitleText } },
      alignment: { vertical: 'middle', horizontal: 'right', wrapText: true },
      borderColor: PACK_THEME.border,
      height: 20
    });
    const rightTone = packValueTone({ label: right.label, value: right.value, kind: right.kind });
    packMergeBand(sheet, rowNumber, rightStart + 2, rightEnd, firstPresentValue(right.value, ''), {
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: rightTone.fill || PACK_THEME.value } },
      font: { name: PACK_FONT, size: 10, bold: Boolean(right.boldValue), color: { argb: rightTone.font || 'FF1F2937' } },
      alignment: { vertical: 'middle', horizontal: 'left', wrapText: true },
      borderColor: PACK_THEME.border,
      height: 20
    });
  }
  return startRow + rowCount;
}

function packRenderMetricCards(sheet, startRow, totalColumns, title, metrics = [], options = {}) {
  const effectiveMetrics = metrics.length ? metrics : [{ label: 'No Data Available', value: '-' }];
  packMergeBand(sheet, startRow, 1, totalColumns, title || 'Summary', {
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: options.fill || PACK_THEME.sectionBlue } },
    font: { name: PACK_FONT, size: 11, bold: true, color: { argb: PACK_THEME.subtitleText } },
    alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
    borderColor: PACK_THEME.border,
    height: 20
  });
  const palette = options.palette || [PACK_THEME.sectionBlue, PACK_THEME.sectionGreen, PACK_THEME.sectionGold, PACK_THEME.sectionGrey];
  const cardsPerRow = 4;
  const cardWidth = Math.max(3, Math.floor(Math.min(totalColumns, 12) / cardsPerRow));
  let currentRow = startRow + 1;
  for (let index = 0; index < effectiveMetrics.length; index += cardsPerRow) {
    const chunk = effectiveMetrics.slice(index, index + cardsPerRow);
    chunk.forEach((metric, cardIndex) => {
      const startCol = 1 + cardIndex * cardWidth;
      const endCol = Math.min(totalColumns, startCol + cardWidth - 1);
      const fillArgb = metric.fill || palette[(index + cardIndex) % palette.length];
      const tone = packValueTone(metric);
      packMergeBand(sheet, currentRow, startCol, endCol, metric.label || '', {
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: fillArgb } },
        font: { name: PACK_FONT, size: 10, bold: true, color: { argb: PACK_THEME.subtitleText } },
        alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
        borderColor: PACK_THEME.border,
        height: 20
      });
      packMergeBand(sheet, currentRow + 1, startCol, endCol, firstPresentValue(metric.value, ''), {
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: metric.valueFill || tone.fill || PACK_THEME.value } },
        font: { name: PACK_FONT, size: 13, bold: true, color: { argb: tone.font || 'FF1F2937' } },
        alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
        borderColor: PACK_THEME.border,
        height: 24
      });
    });
    currentRow += 2;
  }
  return currentRow - 1;
}

function packRenderSummaryRows(sheet, startRow, totalColumns, title, rows = [], options = {}) {
  const effectiveRows = rows.length ? rows : [{ label: 'No Data Available', value: '-', kind: 'info' }];
  packMergeBand(sheet, startRow, 1, totalColumns, title || 'Summary', {
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: options.fill || PACK_THEME.sectionGreen } },
    font: { name: PACK_FONT, size: 11, bold: true, color: { argb: PACK_THEME.subtitleText } },
    alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
    borderColor: PACK_THEME.border,
    height: 20
  });
  const labelEnd = Math.min(4, totalColumns - 1);
  const valueStart = labelEnd + 1;
  let rowNumber = startRow + 1;
  effectiveRows.forEach((item) => {
    const valueTone = packValueTone(item);
    const valueFillArgb = item.valueFill || valueTone.fill || (item.kind === 'status'
      ? PACK_THEME.total
      : item.kind === 'remarks'
        ? PACK_THEME.sectionGrey
        : item.kind === 'warning' || item.kind === 'danger'
          ? PACK_THEME.warningFill
          : PACK_THEME.value);
    packMergeBand(sheet, rowNumber, 1, labelEnd, `${item.label || ''}${item.label ? ' :' : ''}`, {
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: item.labelFill || PACK_THEME.sectionBlue } },
      font: { name: PACK_FONT, size: 10, bold: true, color: { argb: PACK_THEME.subtitleText } },
      alignment: { vertical: 'middle', horizontal: 'right', wrapText: true },
      borderColor: PACK_THEME.border,
      height: item.kind === 'remarks' ? 30 : 20
    });
    packMergeBand(sheet, rowNumber, valueStart, totalColumns, firstPresentValue(item.value, ''), {
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: valueFillArgb } },
      font: { name: PACK_FONT, size: 10, bold: true, color: { argb: valueFillArgb === PACK_THEME.total ? 'FFFFFFFF' : valueTone.font || 'FF1F2937' } },
      alignment: { vertical: 'middle', horizontal: item.kind === 'remarks' ? 'left' : 'center', wrapText: true },
      borderColor: PACK_THEME.border,
      height: item.kind === 'remarks' ? 30 : 20
    });
    rowNumber += 1;
  });
  return rowNumber - 1;
}

function packRenderDataTable(sheet, startRow, totalColumns, title, columns = [], rows = [], options = {}) {
  const effectiveColumns = packResolveColumns(columns, rows, Math.max(1, columns.length), options.maxWidth || 60);
  const sheetColumns = effectiveColumns.map((column) => ({
    header: column.header || '',
    key: column.key || '',
    width: column.width || 14
  }));
  while (sheetColumns.length < totalColumns) {
    sheetColumns.push({ header: '', key: `blank_${sheetColumns.length + 1}`, width: 2.5 });
  }
  sheet.columns = sheetColumns;

  packMergeBand(sheet, startRow, 1, totalColumns, title || 'Detailed Data', {
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: options.fill || PACK_THEME.sectionBlue } },
    font: { name: PACK_FONT, size: 11, bold: true, color: { argb: PACK_THEME.subtitleText } },
    alignment: { vertical: 'middle', horizontal: 'center', wrapText: true },
    borderColor: PACK_THEME.border,
    height: 20
  });

  const headerRow = sheet.getRow(startRow + 1);
  const visibleColumns = columns.length || 1;
  for (let index = 0; index < visibleColumns; index += 1) {
    headerRow.getCell(index + 1).value = effectiveColumns[index] && effectiveColumns[index].header ? effectiveColumns[index].header : '';
  }
  styleHeaderRow(headerRow, options.headerFill || PACK_THEME.header);
  headerRow.height = 22;

  const dataRows = rows.length ? rows : [{ [effectiveColumns[0] && effectiveColumns[0].key ? effectiveColumns[0].key : 'message']: options.emptyMessage || 'No Data Available' }];
  const rightAlignColumns = new Set(effectiveColumns
    .map((column, index) => (column.numFmt ? index : null))
    .filter((index) => index !== null));
  dataRows.forEach((row) => {
    const added = sheet.addRow(formatDateLikeFields(normalizePackRow(row)));
    styleDataRow(added, effectiveColumns, { rightAlignColumns });
    if (row.rowType === 'total' || row.rowType === 'grandTotal' || row.isTotal) {
      added.font = { bold: true };
      added.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PACK_THEME.total } };
        cell.font = { name: PACK_FONT, bold: true, color: { argb: PACK_THEME.successText } };
      });
    }
    if (String(row.message || '').trim() === (options.emptyMessage || 'No Data Available')) {
      added.font = { italic: true, color: { argb: 'FF64748B' } };
    }
    added.height = 20;
  });

  sheet.autoFilter = { from: { row: startRow + 1, column: 1 }, to: { row: startRow + 1, column: visibleColumns } };
  return { headerRow: startRow + 1, nextRow: startRow + 1 + dataRows.length };
}

function addTableSheet(workbook, name, columns, rows, options = {}) {
  const sheet = workbook.addWorksheet(uniqueSheetName(workbook, name));
  const reportData = options.reportData || {};
  const selectedDealer = reportData.selectedDealer || {};
  const selectedAudit = reportData.selectedAudit || {};
  const subtitle = options.title || name;
  const visibleColumns = Array.isArray(columns) ? columns : [];
  const resolvedColumns = packResolveColumns(visibleColumns, rows, Math.max(visibleColumns.length, 12), options.maxWidth || 60);
  const totalColumns = Math.max(12, resolvedColumns.length);
  sheet.columns = Array.from({ length: totalColumns }, (_, index) => ({ width: index < 4 ? 18 : 14 }));
  packRenderTitleBlock(sheet, totalColumns, subtitle);

  const dealerInfo = Array.isArray(options.dealerInfo) && options.dealerInfo.length ? options.dealerInfo : [
    { label: 'Dealer Name', value: packText(selectedDealer.dealerName || reportData.summary?.[0]?.dealerName || '-') },
    { label: 'Dealer Code', value: packText(selectedDealer.dealerCode || reportData.summary?.[0]?.dealerCode || options.dealerCode || '-') },
    { label: 'Location', value: packText(selectedDealer.location || '-') },
    { label: 'Auditor Name', value: packText(selectedAudit.auditorName || selectedDealer.auditorName || '-') }
  ];
  const auditInfo = Array.isArray(options.auditInfo) && options.auditInfo.length ? options.auditInfo : [
    { label: 'Audit ID', value: packText(selectedAudit.auditId || options.auditId || '-') },
    { label: 'Audit Date', value: packText(selectedAudit.auditStartDate || selectedAudit.auditDate || options.auditDate || '-') },
    { label: 'Generated By', value: packText(options.generatedBy || '-') },
    { label: 'Generated At', value: packText(options.generatedAt || '-') }
  ];
  let currentRow = 3;
  currentRow = packRenderInfoBlock(sheet, currentRow, totalColumns, options.dealerTitle || 'Dealer Details', dealerInfo, options.auditTitle || 'Audit Details', auditInfo) + 1;

  const summaryMetrics = Array.isArray(options.summaryMetrics) && options.summaryMetrics.length ? options.summaryMetrics : [
    { label: 'Rows', value: packNumber(rows.length, 0), fill: 'FFEFF6FF' },
    { label: 'Unique Parts', value: packNumber(countDistinctBy(rows, (row) => firstPresentValue(row.partNumber, row.partNo, row._id)), 0), fill: 'FFEFFAF1' },
    { label: 'Total Qty', value: packNumber(sumBy(rows, (row) => firstNumericValue(row.qty, row.quantity, row.actualStock, row.physicalQty, row.dmsStock, row.totalQty, row.scanCount)), 0), fill: 'FFFFF7ED' },
    { label: 'Total Value', value: packCurrency(sumBy(rows, (row) => firstNumericValue(row.finalInventoryValue, row.stockValue, row.actualStockValue, row.dmsStockValue, row.totalDlcValue, row.excessValue, row.shortageValue))), fill: 'FFFDF2F8' }
  ];
  currentRow = packRenderMetricCards(sheet, currentRow, totalColumns, options.summaryTitle || 'Report Summary', summaryMetrics, {
    fill: options.summaryFill || PACK_THEME.sectionBlue
  }) + 1;

  const table = packRenderDataTable(sheet, currentRow, totalColumns, options.tableTitle || subtitle, visibleColumns, rows, options);
  sheet.views = [{ state: 'frozen', ySplit: table.headerRow, showGridLines: false }];
  sheet.pageSetup = {
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    orientation: options.orientation || 'landscape',
    paperSize: 9
  };
  addSheetFooter(sheet, options.generatedAt || '');
  return sheet;
}

function addMetricSheet(workbook, name, rows, options = {}) {
  const sheet = workbook.addWorksheet(uniqueSheetName(workbook, name));
  const subtitle = options.title || name;
  const rowData = Array.isArray(rows) ? rows : [];
  const tables = Array.isArray(options.tables) ? options.tables : [];
  const tableWidth = tables.reduce((max, table) => Math.max(max, Array.isArray(table.columns) ? table.columns.length : 0), 0);
  const totalColumns = Math.max(12, tableWidth);
  sheet.columns = Array.from({ length: totalColumns }, (_, index) => ({ width: index < 4 ? 18 : 14 }));
  packRenderTitleBlock(sheet, totalColumns, subtitle);

  const sections = [];
  const sectionMap = new Map();
  rowData.forEach((row, index) => {
    const section = packText(row.section || row.group || 'Summary');
    if (!sectionMap.has(section)) {
      sectionMap.set(section, []);
      sections.push(section);
    }
    sectionMap.get(section).push({ ...row, __index: index });
  });

  let currentRow = 3;
  sections.forEach((section, index) => {
    const sectionRows = sectionMap.get(section).map((row) => ({
      label: row.metric || row.label || '',
      value: row.value === undefined || row.value === null ? '' : row.value,
      kind: row.kind || 'info'
    }));
    currentRow = packRenderSummaryRows(sheet, currentRow, totalColumns, section, sectionRows, {
      fill: (options.sectionFills && options.sectionFills[section]) || [PACK_THEME.sectionBlue, PACK_THEME.sectionGreen, PACK_THEME.sectionGold, PACK_THEME.sectionGrey][index % 4]
    }) + 1;
  });

  let firstTableHeader = null;
  tables.forEach((table, index) => {
    currentRow += 1;
    const rendered = packRenderDataTable(sheet, currentRow, totalColumns, table.title || table.name || 'Detailed Data', table.columns || [], table.rows || [], {
      ...options,
      ...(table.options || {}),
      fill: table.fill || options.tableFill,
      headerFill: table.headerFill || options.headerFill,
      maxWidth: table.maxWidth || options.maxWidth
    });
    if (!firstTableHeader) firstTableHeader = rendered.headerRow;
    currentRow = rendered.nextRow;
  });

  sheet.views = [{ state: 'frozen', ySplit: firstTableHeader || 2, showGridLines: false }];
  sheet.pageSetup = {
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    orientation: options.orientation || 'landscape',
    paperSize: 9
  };
  addSheetFooter(sheet, options.generatedAt || '');
  return sheet;
}

function packMetricRows(section, entries = []) {
  return entries.map(([metric, value]) => ({
    section,
    metric,
    value
  }));
}

function reportLabelForKey(key) {
  return COMPLETE_AUDIT_PACK_REPORT_MAP.get(key) || key;
}

function selectedReportLabels(selectedReports = []) {
  return selectedReports.map((key) => reportLabelForKey(key)).filter(Boolean);
}

function extraLabelMap() {
  return new Map(COMPLETE_AUDIT_PACK_EXTRA_OPTIONS.map((item) => [item.key, item.label]));
}

function selectedExtraLabels(extras = {}) {
  const labels = [];
  COMPLETE_AUDIT_PACK_EXTRA_OPTIONS.forEach((item) => {
    if (extras[item.key]) labels.push(item.label);
  });
  return labels;
}

function normalizeAuditPackSelection(payload = {}) {
  const reports = Array.isArray(payload.reports)
    ? payload.reports
    : String(payload.reports || '')
      .split(/[,;\n]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  const selectedReports = Array.from(new Set(reports.filter((key) => COMPLETE_AUDIT_PACK_REPORT_MAP.has(key))));
  const extras = {};
  COMPLETE_AUDIT_PACK_EXTRA_OPTIONS.forEach((item) => {
    extras[item.key] = payload[item.key] === true || payload[item.key] === 'true' || payload[item.key] === 1 || payload[item.key] === '1';
  });
  return {
    dealerCode: selectedDealerCode(payload),
    auditId: clean(payload.auditId || payload.audit || ''),
    fromDate: clean(payload.fromDate || payload.from || ''),
    toDate: clean(payload.toDate || payload.to || ''),
    includeSummary: payload.includeSummary !== false && payload.includeSummary !== 'false',
    reports: selectedReports,
    ...extras
  };
}

function buildAuditPackContext(reportData = {}, movementAnalysis = null, scanRegisterRowsData = [], options = {}) {
  const summary = Array.isArray(reportData.summary) && reportData.summary.length ? reportData.summary[0] : {};
  const dealer = reportData.selectedDealer || {};
  const audit = reportData.selectedAudit || {};
  const finalRows = Array.isArray(reportData.finalRows) ? reportData.finalRows : [];
  const scans = Array.isArray(reportData.scans) ? reportData.scans : [];
  const movementSummary = movementAnalysis && movementAnalysis.summary ? movementAnalysis.summary : {};
  const registerCounts = countScanRegisterRows(scanRegisterRowsData);
  const scanTotals = reportTotals(scans, {
    dedupe: true,
    duplicateCount: summary.duplicateCount || summary.duplicates || 0,
    visibleRows: summary.visibleRows || finalRows.length
  });
  const valuationTotals = stockValuationTotals(finalRows);
  const totalQuantity = firstNumericValue(summary.totalQuantity, summary.totalPhysicalQty, scanTotals.totalQuantity, finalRows.reduce((sum, row) => sum + firstNumericValue(row.physicalQty, row.qty, row.actualStock, row.totalQty, row.scanCount), 0));
  const totalParts = firstNumericValue(summary.totalMasterParts, finalRows.length);
  const totalScans = firstNumericValue(summary.totalScans, scanTotals.scanRows, scans.length);
  const uniqueParts = firstNumericValue(summary.uniqueParts, scanTotals.uniqueParts, countDistinctBy(finalRows, (row) => row.partNumber || row.partNo || row._id));
  const visibleRows = firstNumericValue(summary.visibleRows, finalRows.length);
  const totalPhysicalQty = firstNumericValue(summary.totalPhysicalQty, totalQuantity);
  const totalSystemQty = firstNumericValue(summary.totalSystemQty, finalRows.reduce((sum, row) => sum + firstNumericValue(row.systemQty, row.dmsStock), 0));
  const totalPhysicalDlcValue = firstNumericValue(summary.totalActualStockValue, summary.totalPhysicalStockValue, valuationTotals.actualDlcTotal);
  const totalDmsDlcValue = firstNumericValue(summary.totalDmsStockValue, valuationTotals.dmsDlcTotal);
  const totalPhysicalMrpValue = firstNumericValue(summary.totalActualMrpValue, valuationTotals.actualMrpTotal);
  const totalDmsMrpValue = firstNumericValue(summary.totalDmsMrpValue, valuationTotals.dmsMrpTotal);
  const totalVarianceDlcValue = firstNumericValue(summary.totalVarianceValue, valuationTotals.varianceDlcTotal);
  const totalVarianceMrpValue = firstNumericValue(summary.totalVarianceMrpValue, valuationTotals.varianceMrpTotal);
  const totalExcessValue = firstNumericValue(summary.totalExcessValue, sumBy(finalRows, (row) => firstNumericValue(row.excessValue, 0)));
  const totalShortValue = firstNumericValue(summary.totalShortValue, sumBy(finalRows, (row) => firstNumericValue(row.shortageValue, 0)));
  const damageCount = countRows(finalRows, (row) => Number(firstNumericValue(row.damageQty, 0)) > 0 || /damage/.test(String(row.status || '').toLowerCase()));
  const excessCount = countRows(finalRows, (row) => Number(firstNumericValue(row.excessQty, row.excess, 0)) > 0 || /excess|extra part/.test(String(row.status || '').toLowerCase()));
  const shortCount = countRows(finalRows, (row) => Number(firstNumericValue(row.shortQty, row.shortageQty, row.short, 0)) > 0 || /short/.test(String(row.status || '').toLowerCase()));
  const deadStockCount = firstNumericValue(movementSummary.deadStockCount, movementSummary.deadStockParts, 0);
  const fastMovingCount = firstNumericValue(movementSummary.fastMovingCount, movementSummary.fastMovingParts, 0);
  const slowMovingCount = firstNumericValue(movementSummary.slowMovingCount, movementSummary.slowMovingParts, 0);
  const criticalShortageCount = firstNumericValue(movementSummary.criticalShortageCount, movementSummary.criticalShortageParts, 0);
  const uniqueUsers = countDistinctBy(scans, (scan) => scan.userName || scan.staffName || scan.loginId || scan.userId);
  const uniqueDevices = countDistinctBy(scans, (scan) => scan.deviceId || scan.deviceName);
  const categoryRows = summarizeByCategory(finalRows, {
    qtyResolver: (row) => firstNumericValue(row.physicalQty, row.actualStock, row.qty),
    valueResolver: (row) => firstNumericValue(row.finalInventoryValue, row.stockValue, row.actualStockValue)
  }).slice(0, 8);
  const netDifference = firstNumericValue(summary.netDifference, summary.netDiff, totalVarianceDlcValue);
  const finalStatus = summary.status || reconciliationStatusText({
    netDifference,
    totalShortageValue: totalShortValue,
    totalExcessValue
  });
  return {
    summary,
    dealer,
    audit,
    finalRows,
    scans,
    movementSummary,
    registerCounts,
    scanTotals,
    valuationTotals,
    categoryRows,
    selectedReports: Array.isArray(options.selectedReports) ? options.selectedReports : [],
    extras: options.extras || {},
    generatedBy: options.generatedBy || '',
    generatedAt: options.generatedAt || '',
    resolvedQuery: options.resolvedQuery || {},
    totals: {
      totalParts,
      totalScans,
      totalQuantity,
      uniqueParts,
      visibleRows,
      totalPhysicalQty,
      totalSystemQty,
      totalPhysicalDlcValue,
      totalDmsDlcValue,
      totalPhysicalMrpValue,
      totalDmsMrpValue,
      totalVarianceDlcValue,
      totalVarianceMrpValue,
      totalExcessValue,
      totalShortValue,
      damageCount,
      excessCount,
      shortCount,
      deadStockCount,
      fastMovingCount,
      slowMovingCount,
      criticalShortageCount,
      uniqueUsers,
      uniqueDevices,
      netDifference,
      finalStatus
    }
  };
}

function buildSummaryStatusRows(reportData = {}, selectedReports = [], extras = {}, generatedBy = '', generatedAt = '', movementAnalysis = null, scanRegisterRowsData = [], context = null) {
  const packContext = context || buildAuditPackContext(reportData, movementAnalysis, scanRegisterRowsData, {
    selectedReports,
    extras,
    generatedBy,
    generatedAt
  });
  const { summary, dealer, audit, categoryRows, totals, registerCounts, movementSummary } = packContext;
  return [
    ...packMetricRows('Dealer Information', [
      ['Dealer Name', dealer.dealerName || summary.dealerName || packText(summary.dealerCode || dealer.dealerCode || reportData.filters?.dealerCode)],
      ['Dealer Code', dealer.dealerCode || summary.dealerCode || reportData.filters?.dealerCode || '-'],
      ['Location', dealer.location || '-'],
      ['Auditor Name', dealer.auditorName || audit.auditorName || '-'],
      ['Brand', dealer.brand || '-']
    ]),
    ...packMetricRows('Audit Information', [
      ['Audit ID', audit.auditId || summary.auditId || '-'],
      ['Audit Date', audit.auditStartDate || audit.auditDate || summary.fromDate || reportData.filters?.fromDate || reportData.filters?.from || '-'],
      ['Audit End Date', audit.auditClosedDate || audit.auditEndDate || summary.toDate || reportData.filters?.toDate || reportData.filters?.to || '-'],
      ['Generated By', generatedBy || 'System'],
      ['Generated At', generatedAt || '-'],
      ['Selected Reports', packNumber(selectedReports.length, 0)],
      ['Included Extras', selectedExtraLabels(extras).join(', ') || '-'],
      ['Sync Status', auditSyncStatus(registerCounts)]
    ]),
    ...packMetricRows('Inventory Summary', [
      ['Total Parts', packNumber(totals.totalParts || 0, 0)],
      ['Total Scans', packNumber(totals.totalScans || 0, 0)],
      ['Total Quantity', packNumber(totals.totalQuantity || 0, 0)],
      ['Unique Parts', packNumber(totals.uniqueParts || 0, 0)],
      ['Total Physical Qty', packNumber(totals.totalPhysicalQty || 0, 0)],
      ['Total System Qty', packNumber(totals.totalSystemQty || 0, 0)],
      ['Inventory Value (DLC)', packCurrency(totals.totalPhysicalDlcValue || 0)],
      ['DMS Value (DLC)', packCurrency(totals.totalDmsDlcValue || 0)],
      ['Net Difference (DLC)', packCurrency(totals.totalVarianceDlcValue || 0)]
    ]),
    ...packMetricRows('Variance Summary', [
      ['Total Excess', packNumber(totals.excessCount || 0, 0)],
      ['Total Short', packNumber(totals.shortCount || 0, 0)],
      ['Damage Count', packNumber(totals.damageCount || 0, 0)],
      ['Dead Stock', packNumber(totals.deadStockCount || 0, 0)],
      ['Net Difference', packCurrency(totals.netDifference || 0)],
      ['Pending Sync', packNumber(registerCounts.pending || 0, 0)],
      ['Failed Sync', packNumber(registerCounts.failed || 0, 0)],
      ['Duplicate Sync', packNumber(registerCounts.duplicate || 0, 0)],
      ['Movement Status', auditSyncStatus(registerCounts)]
    ]),
    ...packMetricRows('Movement Summary', [
      ['Fast Moving', packNumber(totals.fastMovingCount || 0, 0)],
      ['Slow Moving', packNumber(totals.slowMovingCount || 0, 0)],
      ['Dead Stock', packNumber(totals.deadStockCount || 0, 0)],
      ['Critical Shortage', packNumber(totals.criticalShortageCount || 0, 0)]
    ]),
    ...packMetricRows('Category Summary', categoryRows.map((row) => ([
      row.category,
      `Parts ${packNumber(row.uniqueParts || row.parts || 0, 0)} | Qty ${packNumber(row.qty || 0, 0)} | Value ${packCurrency(row.value || 0)} | Share ${packNumber((row.share || 0) * 100, 2)}%`
    ]))),
    ...packMetricRows('Selected Reports Summary', selectedReportLabels(selectedReports).map((label) => ([
      label,
      'Included'
    ])))
  ];
}

function buildDashboardSummaryRows(reportData = {}, movementAnalysis = null, scanRegisterRowsData = [], context = null) {
  const packContext = context || buildAuditPackContext(reportData, movementAnalysis, scanRegisterRowsData);
  const { totals, registerCounts, movementSummary } = packContext;
  return [
    ...packMetricRows('Dashboard KPIs', [
      ['Total Parts', packNumber(totals.totalParts || 0, 0)],
      ['Total Scans', packNumber(totals.totalScans || 0, 0)],
      ['Total Quantity', packNumber(totals.totalQuantity || 0, 0)],
      ['Unique Parts', packNumber(totals.uniqueParts || 0, 0)],
      ['Visible Rows', packNumber(totals.visibleRows || 0, 0)],
      ['Inventory Value (DLC)', packCurrency(totals.totalPhysicalDlcValue || 0)],
      ['DMS Value (DLC)', packCurrency(totals.totalDmsDlcValue || 0)],
      ['Variance (DLC)', packCurrency(totals.totalVarianceDlcValue || 0)],
      ['Pending Records', packNumber(registerCounts.pending || 0, 0)],
      ['Failed Records', packNumber(registerCounts.failed || 0, 0)],
      ['Duplicate Records', packNumber(registerCounts.duplicate || 0, 0)],
      ['Users', packNumber(totals.uniqueUsers || 0, 0)],
      ['Devices', packNumber(totals.uniqueDevices || 0, 0)],
      ['Net Status', totals.finalStatus || reconciliationStatusText({ netDifference: totals.netDifference, totalShortageValue: totals.totalShortValue, totalExcessValue: totals.totalExcessValue })]
    ]),
    ...packMetricRows('Movement Summary', [
      ['Fast Moving', packNumber(totals.fastMovingCount || movementSummary.fastMovingCount || movementSummary.fastMovingParts || 0, 0)],
      ['Slow Moving', packNumber(totals.slowMovingCount || movementSummary.slowMovingCount || movementSummary.slowMovingParts || 0, 0)],
      ['Dead Stock', packNumber(totals.deadStockCount || movementSummary.deadStockCount || movementSummary.deadStockParts || 0, 0)],
      ['Critical Shortage', packNumber(totals.criticalShortageCount || movementSummary.criticalShortageCount || movementSummary.criticalShortageParts || 0, 0)],
      ['Excess Stock', packNumber(totals.excessCount || movementSummary.excessStockCount || movementSummary.excessStockParts || 0, 0)]
    ])
  ];
}

function buildAuditInformationRows(payload = {}, reportData = {}) {
  const selectedDealer = reportData.selectedDealer || {};
  const selectedAudit = reportData.selectedAudit || {};
  return packMetricRows('Scope', [
    ['Dealer Code', payload.dealerCode || selectedDealer.dealerCode || reportData.filters?.dealerCode || '-'],
    ['Dealer Name', selectedDealer.dealerName || reportData.summary?.[0]?.dealerName || '-'],
    ['Audit ID', payload.auditId || selectedAudit.auditId || reportData.summary?.[0]?.auditId || '-'],
    ['Audit Start Date', payload.fromDate || payload.from || selectedAudit.auditStartDate || reportData.summary?.[0]?.fromDate || '-'],
    ['Audit End Date', payload.toDate || payload.to || selectedAudit.auditClosedDate || reportData.summary?.[0]?.toDate || '-'],
    ['Product Category', payload.category || payload.productCategory || '-'],
    ['Product Group', payload.productGroup || '-'],
    ['Product SubGroup', payload.partSubGroup || payload.productSubGroup || '-'],
    ['Part Number', payload.partNumber || '-'],
    ['Bin Location', payload.bin || payload.binLocation || '-'],
    ['Movement Status', payload.movementStatus || '-'],
    ['Scan Type', payload.scanType || payload.type || '-']
  ]);
}

function buildDealerInformationRows(reportData = {}) {
  const dealer = reportData.selectedDealer || {};
  const keys = [
    ['Dealer Code', dealer.dealerCode],
    ['Dealer Name', dealer.dealerName],
    ['Brand', dealer.brand],
    ['Location', dealer.location],
    ['Current Audit ID', dealer.currentAuditId],
    ['Audit Name', dealer.auditName],
    ['Auditor Name', dealer.auditorName],
    ['General Manager', dealer.generalManager],
    ['SPM Name', dealer.spmName],
    ['Phone', dealer.phone || dealer.mobileNumber || dealer.contactNumber],
    ['Email', dealer.email],
    ['Address', dealer.address]
  ];
  return packMetricRows('Dealer', keys);
}

function buildScanStatisticsRows(reportData = {}, scanRegisterRowsData = [], context = null) {
  const packContext = context || buildAuditPackContext(reportData, null, scanRegisterRowsData);
  const { summary, totals, registerCounts } = packContext;
  return [
    ...packMetricRows('Scan Totals', [
      ['Total Scan Rows', packNumber(totals.totalScans || 0, 0)],
      ['Total Quantity', packNumber(totals.totalQuantity || 0, 0)],
      ['Total Parts', packNumber(totals.totalParts || 0, 0)],
      ['Unique Parts', packNumber(totals.uniqueParts || 0, 0)],
      ['Visible Rows', packNumber(totals.visibleRows || 0, 0)],
      ['Unknown Parts', packNumber(summary.unknownPartsCount || 0, 0)],
      ['Merged Duplicate Scan Rows', packNumber(summary.mergedDuplicateScanRows || 0, 0)],
      ['Unique Users', packNumber(totals.uniqueUsers || 0, 0)],
      ['Unique Devices', packNumber(totals.uniqueDevices || 0, 0)]
    ]),
    ...packMetricRows('Status Breakdown', [
      ['Accepted', packNumber(registerCounts.accepted || 0, 0)],
      ['Pending', packNumber(registerCounts.pending || 0, 0)],
      ['Failed', packNumber(registerCounts.failed || 0, 0)],
      ['Duplicate', packNumber(registerCounts.duplicate || 0, 0)],
      ['Rejected', packNumber(registerCounts.rejected || 0, 0)],
      ['Deleted', packNumber(registerCounts.deleted || 0, 0)],
      ['Synced', packNumber(registerCounts.synced || 0, 0)]
    ]),
    ...packMetricRows('Users & Devices', [
      ['Unique Users', packNumber(totals.uniqueUsers || 0, 0)],
      ['Unique Devices', packNumber(totals.uniqueDevices || 0, 0)],
      ['First Scan Time', packText(summary.firstScanTime || '')],
      ['Last Scan Time', packText(summary.lastScanTime || '')]
    ])
  ];
}

function buildPendingOfflineRows(scanRegisterRowsData = []) {
  return scanRegisterRowsData
    .filter((row) => clean(row.syncStatus).toLowerCase() !== 'synced')
    .map((row) => normalizePackRow(row));
}

function buildUserWiseSummaryRows(reportData = {}) {
  const scans = Array.isArray(reportData.scans) ? reportData.scans : [];
  return groupedScanSummary(
    scans,
    (scan) => clean(scan.userId || scan.loginId || scan.staffName || scan.userName || 'UNKNOWN').toUpperCase(),
    (scan) => ({
      userName: scan.userName || scan.staffName || scan.loginId || scan.userId || 'UNKNOWN',
      userId: scan.userId || scan.loginId || '',
      role: scan.role || ''
    }),
    {
      dealers: (scan) => {
        const code = clean(scan.dealerCode || '');
        const name = clean(scan.dealerName || '');
        return code ? `${code}${name ? ` (${name})` : ''}` : name;
      },
      devices: scanDeviceLabel
    }
  ).map((row) => ({
    userName: row.userName,
    userId: row.userId,
    role: row.role,
    scanCount: row.scanCount,
    totalQty: row.totalQty,
    auditQty: row.auditQty,
    inwardQty: row.inwardQty,
    outwardQty: row.outwardQty,
    fittedQty: row.fittedQty,
    damageQty: row.damageQty,
    uniqueParts: row.uniqueParts,
    dealers: row.dealers,
    devices: row.devices,
    totalMrpValue: row.totalMrpValue,
    totalDlcValue: row.totalDlcValue,
    lastScanTime: row.lastScanTime
  }));
}

function buildCategoryVarianceRows(data = {}, context = null) {
  const rows = Array.isArray(data.rows) ? data.rows.slice() : [];
  const totals = context && context.totals ? context.totals : {};
  return rows.concat([{
    productCategory: 'Grand Total',
    action: '',
    totalScannedParts: Number(totals.totalParts || data.grandTotal?.totalScannedParts || 0),
    totalScannedQuantity: Number(totals.totalQuantity || data.grandTotal?.totalScannedQuantity || 0),
    sumPhysicalValueOnMRP: Number(totals.totalPhysicalMrpValue || data.grandTotal?.sumPhysicalValueOnMRP || 0),
    sumPhysicalValueOnDLC: Number(totals.totalPhysicalDlcValue || data.grandTotal?.sumPhysicalValueOnDLC || 0),
    sumDmsValueOnMRP: Number(totals.totalDmsMrpValue || data.grandTotal?.sumDmsValueOnMRP || 0),
    sumDmsValueOnDLC: Number(totals.totalDmsDlcValue || data.grandTotal?.sumDmsValueOnDLC || 0),
    sumVarianceOnMRP: Number(totals.totalVarianceMrpValue || data.grandTotal?.sumVarianceOnMRP || 0),
    sumVarianceOnDLC: Number(totals.totalVarianceDlcValue || data.grandTotal?.sumVarianceOnDLC || 0),
    rowType: 'grandTotal'
  }]);
}

function reconciliationStatusText(summary = {}) {
  const net = Number(summary.netDifference || 0);
  const shortValue = Number(summary.totalShortageValue || 0);
  const excessValue = Number(summary.totalExcessValue || 0);
  if (net === 0 && shortValue === 0 && excessValue === 0) return 'Balanced';
  if (net > 0) return 'Excess';
  if (net < 0) return 'Shortage';
  return 'Review Required';
}

function reconciliationRemarksText(summary = {}) {
  const status = reconciliationStatusText(summary);
  if (status === 'Balanced') return 'No variance found in the selected reconciliation scope';
  if (status === 'Excess') return 'Excess stock detected. Review category-wise mismatches before closure';
  if (status === 'Shortage') return 'Shortage detected. Verify missing items and pending postings';
  return 'Reconciliation requires manual review';
}

function buildReconciliationCategoryRows(report = {}, context = null) {
  const rows = Array.isArray(report.rows) ? report.rows : [];
  const contextTotals = context && context.totals ? context.totals : {};
  const categories = summarizeByCategory(rows, {
    qtyResolver: (row) => firstNumericValue(row.actualStock, row.physicalQty, row.qty),
    valueResolver: (row) => firstNumericValue(row.actualStockValue, row.finalInventoryValue, row.stockValue),
    dmsQtyResolver: (row) => firstNumericValue(row.dmsStock, row.systemQty),
    actualQtyResolver: (row) => firstNumericValue(row.actualStock, row.physicalQty, row.qty),
    dmsValueResolver: (row) => firstNumericValue(row.dmsStockValue, 0),
    actualValueResolver: (row) => firstNumericValue(row.actualStockValue, row.finalInventoryValue, row.stockValue),
    shortValueResolver: (row) => firstNumericValue(row.shortageValue, 0),
    excessValueResolver: (row) => firstNumericValue(row.excessValue, 0),
    varianceQtyResolver: (row) => firstNumericValue(row.variance, row.varianceQty, 0),
    varianceValueResolver: (row) => firstNumericValue(row.varianceDlc, row.varianceValue, row.netDifference, 0)
  });
  const aggregated = categories.map((row) => ({
    category: row.category,
    dmsQty: row.dmsQty,
    actualQty: row.actualQty,
    varianceQty: row.actualQty - row.dmsQty,
    dmsValue: row.dmsValue,
    actualValue: row.actualValue,
    shortValue: row.shortValue,
    excessValue: row.excessValue,
    netDifference: row.varianceValue,
    status: reconciliationStatusText({ netDifference: row.varianceValue, totalShortageValue: row.shortValue, totalExcessValue: row.excessValue })
  }));
  const aggregatedTotals = aggregated.reduce((summary, row) => ({
    dmsQty: summary.dmsQty + Number(row.dmsQty || 0),
    actualQty: summary.actualQty + Number(row.actualQty || 0),
    varianceQty: summary.varianceQty + Number(row.varianceQty || 0),
    dmsValue: summary.dmsValue + Number(row.dmsValue || 0),
    actualValue: summary.actualValue + Number(row.actualValue || 0),
    shortValue: summary.shortValue + Number(row.shortValue || 0),
    excessValue: summary.excessValue + Number(row.excessValue || 0),
    netDifference: summary.netDifference + Number(row.netDifference || 0)
  }), {
    dmsQty: 0,
    actualQty: 0,
    varianceQty: 0,
    dmsValue: 0,
    actualValue: 0,
    shortValue: 0,
    excessValue: 0,
    netDifference: 0
  });
  aggregated.push({
    category: 'Grand Total',
    dmsQty: Number(contextTotals.totalSystemQty || aggregatedTotals.dmsQty || 0),
    actualQty: Number(contextTotals.totalPhysicalQty || aggregatedTotals.actualQty || 0),
    varianceQty: Number((contextTotals.totalPhysicalQty || aggregatedTotals.actualQty || 0) - (contextTotals.totalSystemQty || aggregatedTotals.dmsQty || 0)),
    dmsValue: Number(contextTotals.totalDmsDlcValue || aggregatedTotals.dmsValue || 0),
    actualValue: Number(contextTotals.totalPhysicalDlcValue || aggregatedTotals.actualValue || 0),
    shortValue: Number(contextTotals.totalShortValue || aggregatedTotals.shortValue || 0),
    excessValue: Number(contextTotals.totalExcessValue || aggregatedTotals.excessValue || 0),
    netDifference: Number(firstNumericValue(contextTotals.netDifference, contextTotals.totalVarianceDlcValue, 0)),
    status: reconciliationStatusText({
      netDifference: firstNumericValue(contextTotals.netDifference, contextTotals.totalVarianceDlcValue, 0),
      totalShortageValue: contextTotals.totalShortValue || aggregatedTotals.shortValue || 0,
      totalExcessValue: contextTotals.totalExcessValue || aggregatedTotals.excessValue || 0
    }),
    rowType: 'grandTotal'
  });
  return aggregated;
}

function buildReconciliationSummaryRows(report = {}, context = null) {
  const summary = report.summary || {};
  const totals = context && context.totals ? context.totals : {};
  const rows = packMetricRows('Inventory Reconciliation Summary', [
    ['Dealer Code', summary.dealerCode || report.scope?.dealerCode || report.filters?.dealerCode || '-'],
    ['Audit ID', summary.auditId || report.scope?.auditId || report.filters?.auditId || '-'],
    ['Total Parts Uploaded', totals.totalParts || summary.totalPartsUploaded || 0],
    ['Total DMS Stock Qty', totals.totalSystemQty || summary.totalDmsStockQty || 0],
    ['Total Actual Scanned Qty', totals.totalPhysicalQty || summary.totalActualScannedQty || 0],
    ['Total Matched Parts', summary.totalMatchedParts || 0],
    ['Total Shortage Parts', totals.shortCount || summary.totalShortageParts || 0],
    ['Total Excess Parts', totals.excessCount || summary.totalExcessParts || 0],
    ['Total Fast Moving Parts', totals.fastMovingCount || summary.totalFastMovingParts || 0],
    ['Total Slow Moving Parts', totals.slowMovingCount || summary.totalSlowMovingParts || 0],
    ['Total Dead Stock Parts', totals.deadStockCount || summary.totalDeadStockParts || 0],
    ['Total Inventory Value', packCurrency(totals.totalPhysicalDlcValue || summary.totalInventoryValue || 0)],
    ['Actual Stock Value (DLC)', packCurrency(totals.totalPhysicalDlcValue || summary.actualStockValueDLC || 0)],
    ['DMS Stock Value (DLC)', packCurrency(totals.totalDmsDlcValue || summary.dmsStockValueDLC || 0)],
    ['Total Shortage Value', packCurrency(totals.totalShortValue || summary.totalShortageValue || 0)],
    ['Total Excess Value', packCurrency(totals.totalExcessValue || summary.totalExcessValue || 0)],
    ['Scanned But Not In DMS', summary.totalScannedButNotInDms || 0],
    ['Net Difference', packCurrency(totals.netDifference || summary.netDifference || 0)],
    ['Mismatch Count', summary.mismatchCount || 0],
    ['Final Status', totals.finalStatus || reconciliationStatusText(summary)],
    ['Remarks', reconciliationRemarksText({
      netDifference: totals.netDifference || summary.netDifference || 0,
      totalShortageValue: totals.totalShortValue || summary.totalShortageValue || 0,
      totalExcessValue: totals.totalExcessValue || summary.totalExcessValue || 0
    })]
  ]);
  if (rows.length >= 2) {
    rows[rows.length - 2].kind = 'status';
    rows[rows.length - 1].kind = 'remarks';
  }
  return rows;
}

async function buildCompleteAuditPackWorkbook(payload = {}, user = {}) {
  const normalized = normalizeAuditPackSelection(payload);
  if (!normalized.reports.length) {
    const error = new Error('Please select at least one report');
    error.statusCode = 400;
    throw error;
  }
  if (!normalized.dealerCode) {
    const error = new Error('Select dealer code first to generate complete audit pack');
    error.statusCode = 400;
    throw error;
  }

  let reportData = await reportModule.buildReportData(normalized);
  const resolvedAuditId = clean(normalized.auditId || reportData.selectedAudit?.auditId || reportData.selectedDealer?.currentAuditId || (Array.isArray(reportData.audits) && reportData.audits[0] ? reportData.audits[0].auditId : ''));
  const resolvedQuery = resolvedAuditId
    ? { ...normalized, auditId: resolvedAuditId }
    : normalized;

  const [scanRegisterRowsData, movementAnalysisData] = await Promise.all([
    scanRegisterRows(resolvedQuery, { scans: reportData.scans }),
    reconciliationRoute.buildMovementAnalysisReport(resolvedQuery)
  ]);
  const selectedDealer = reportData.selectedDealer || {};
  const selectedAudit = reportData.selectedAudit
    || (resolvedQuery.auditId && Array.isArray(reportData.audits)
      ? reportData.audits.find((audit) => audit && clean(audit.auditId) === clean(resolvedQuery.auditId))
      : null)
    || {};
  const generatedBy = clean(user.name || user.username || user.email || user.id || 'System');
  const generatedAt = formatIstDateTime(new Date());
  const createLazyPromise = (factory) => {
    let promise = null;
    return () => {
      if (!promise) promise = Promise.resolve().then(factory);
      return promise;
    };
  };
  const getStockSummaryData = createLazyPromise(() => reportModule.buildStockSummaryReport(resolvedQuery));
  const getPartwiseData = createLazyPromise(() => reportModule.buildPartwiseInventoryAuditReport(resolvedQuery));
  const getCategoryData = createLazyPromise(() => reportModule.buildCategoryWiseVarianceSummary(resolvedQuery));
  const getReconciliationData = createLazyPromise(() => reconciliationRoute.buildReconciliationReport(resolvedQuery));
  const validationPromise = Promise.allSettled([getPartwiseData(), getStockSummaryData(), getCategoryData()])
    .then(async (validationResults) => {
      try {
        const validationPayload = {};
        if (validationResults[0].status === 'fulfilled') validationPayload.partwise = validationResults[0].value;
        if (validationResults[1].status === 'fulfilled') validationPayload.stockSummary = validationResults[1].value;
        if (validationResults[2].status === 'fulfilled') validationPayload.category = validationResults[2].value;
        await reportModule.validateValuationReports(resolvedQuery, validationPayload);
      } catch (error) {
        console.error('Complete audit pack valuation validation failed', {
          dealerCode: resolvedQuery.dealerCode,
          auditId: resolvedQuery.auditId,
          message: error.message,
          reconciliation: error.reconciliation || null
        });
      }
    });
  const packContext = buildAuditPackContext(reportData, movementAnalysisData, scanRegisterRowsData, {
    selectedReports: resolvedQuery.reports,
    extras: normalized,
    generatedBy,
    generatedAt,
    resolvedQuery
  });
  const workbook = new ExcelJS.Workbook();
  workbook.creator = generatedBy || 'Daksh Inventory';
  workbook.lastModifiedBy = generatedBy || workbook.creator;
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.title = 'Complete Audit Pack';
  workbook.subject = 'Daksh Inventory Complete Audit Pack';
  workbook.company = 'DAKSH INVENTORY SYSTEM';
  workbook.properties = { date1904: false };

  addMetricSheet(workbook, 'Audit Summary', buildSummaryStatusRows(
    reportData,
    resolvedQuery.reports,
    normalized,
    generatedBy,
    generatedAt,
    movementAnalysisData,
    scanRegisterRowsData,
    packContext
  ), {
    title: 'AUDIT SUMMARY',
    orientation: 'landscape',
    generatedAt
  });

  if (normalized.includeDashboardSummary) {
    addMetricSheet(workbook, 'Dashboard Summary', buildDashboardSummaryRows(reportData, movementAnalysisData, scanRegisterRowsData, packContext), {
      title: 'DASHBOARD SUMMARY',
      orientation: 'landscape',
      generatedAt
    });
  }

  if (normalized.includeAuditInformation) {
    addMetricSheet(workbook, 'Audit Information', buildAuditInformationRows(resolvedQuery, reportData), {
      title: 'AUDIT INFORMATION',
      orientation: 'landscape',
      generatedAt
    });
  }

  if (normalized.includeDealerInformation) {
    addMetricSheet(workbook, 'Dealer Information', buildDealerInformationRows(reportData), {
      title: 'DEALER INFORMATION',
      orientation: 'landscape',
      generatedAt
    });
  }

  if (normalized.includeScanStatistics) {
    addMetricSheet(workbook, 'Scan Statistics', buildScanStatisticsRows(reportData, scanRegisterRowsData, packContext), {
      title: 'SCAN STATISTICS',
      orientation: 'landscape',
      generatedAt
    });
  }

  if (normalized.includePendingOfflineScanDetails) {
    addTableSheet(workbook, 'Pending Offline Scans', SCAN_REGISTER_COLUMNS, buildPendingOfflineRows(scanRegisterRowsData), {
      emptyMessage: 'No Data Available',
      generatedAt
    });
  }

  if (normalized.includeUserWiseSummary) {
    addTableSheet(workbook, 'User Wise Summary', USER_WISE_SUMMARY_COLUMNS, buildUserWiseSummaryRows(reportData), {
      emptyMessage: 'No Data Available',
      generatedAt
    });
  }
  const buildDealerInfoRows = () => [
    { label: 'Dealer Name', value: packText(selectedDealer.dealerName || reportData.summary?.[0]?.dealerName || resolvedQuery.dealerCode || '-') },
    { label: 'Dealer Code', value: packText(selectedDealer.dealerCode || reportData.summary?.[0]?.dealerCode || resolvedQuery.dealerCode || '-') },
    { label: 'Location', value: packText(selectedDealer.location || '-') },
    { label: 'Auditor Name', value: packText(selectedDealer.auditorName || selectedAudit.auditorName || '-') },
    { label: 'Brand', value: packText(selectedDealer.brand || '-') }
  ];
  const buildAuditInfoRows = () => [
    { label: 'Audit ID', value: packText(selectedAudit.auditId || resolvedQuery.auditId || '-') },
    { label: 'Audit Date', value: packText(selectedAudit.auditStartDate || selectedAudit.auditDate || reportData.summary?.[0]?.fromDate || resolvedQuery.fromDate || '-') },
    { label: 'Audit End Date', value: packText(selectedAudit.auditClosedDate || selectedAudit.auditEndDate || reportData.summary?.[0]?.toDate || resolvedQuery.toDate || '-') },
    { label: 'Generated By', value: generatedBy },
    { label: 'Generated At', value: generatedAt },
    { label: 'Selected Reports', value: packNumber(normalized.reports.length, 0) },
    { label: 'Included Extras', value: selectedExtraLabels(normalized).join(', ') || '-' }
  ];
  const buildSummaryMetricsForReport = (reportKey, rows = [], context = {}) => {
    const rowCount = rows.length;
    const uniqueParts = countDistinctBy(rows, (row) => row.partNumber || row.partNo || row._id || row.upiCode || row.rawScan || row.rawScanValue || row.rawScanString);
    const totalQty = sumBy(rows, (row) => firstNumericValue(row.qty, row.quantity, row.actualStock, row.physicalQty, row.dmsStock, row.totalQty, row.scanCount, row.totalScannedQuantity));
    const totalValue = sumBy(rows, (row) => firstNumericValue(row.finalInventoryValue, row.stockValue, row.actualStockValue, row.dmsStockValue, row.totalDlcValue, row.excessValue, row.shortageValue, row.varianceDlc));
    const movement = context.movementSummary || (context.movementAnalysis && context.movementAnalysis.summary) || {};
    const registerCounts = context.registerCounts || countScanRegisterRows(rows);
    const totals = context.totals || {};
    switch (reportKey) {
      case 'bin-wise-stock':
        return [
          { label: 'Rows', value: packNumber(rowCount, 0) },
          { label: 'Unique Bins', value: packNumber(countDistinctBy(rows, (row) => row.bin || row.binLocation), 0) },
          { label: 'Unique Parts', value: packNumber(uniqueParts, 0) },
          { label: 'Total Qty', value: packNumber(totals.totalQuantity || totalQty, 0) }
        ];
      case 'user-dealer-wise':
        return [
          { label: 'Rows', value: packNumber(rowCount, 0) },
          { label: 'Unique Users', value: packNumber(countDistinctBy(rows, (row) => row.userName || row.staffName || row.userId || row.loginId), 0) },
          { label: 'Unique Dealers', value: packNumber(countDistinctBy(rows, (row) => row.dealerCode || row.dealerName), 0) },
          { label: 'Scan Count', value: packNumber(sumBy(rows, (row) => firstNumericValue(row.scanCount, 0)), 0) }
        ];
      case 'raw-upi':
        return [
          { label: 'Rows', value: packNumber(rowCount, 0) },
          { label: 'Unique Parts', value: packNumber(uniqueParts, 0) },
          { label: 'Total Qty', value: packNumber(totalQty, 0) },
          { label: 'Total Value', value: packCurrency(totalValue) }
        ];
      case 'scan-register':
        return [
          { label: 'Rows', value: packNumber(registerCounts.total || rowCount, 0) },
          { label: 'Accepted', value: packNumber(registerCounts.accepted || 0, 0) },
          { label: 'Pending', value: packNumber(registerCounts.pending || 0, 0) },
          { label: 'Failed', value: packNumber(registerCounts.failed || 0, 0) },
          { label: 'Duplicate', value: packNumber(registerCounts.duplicate || 0, 0) },
          { label: 'Rejected', value: packNumber(registerCounts.rejected || 0, 0) }
        ];
      case 'invalid-scan-report':
        return [
          { label: 'Rows', value: packNumber(rowCount, 0) },
          { label: 'Unique Reasons', value: packNumber(countDistinctBy(rows, (row) => row.reason), 0) },
          { label: 'Unique Users', value: packNumber(countDistinctBy(rows, (row) => row.user || row.scannedBy), 0) },
          { label: 'Unique Devices', value: packNumber(countDistinctBy(rows, (row) => row.device), 0) }
        ];
      case 'short':
        return [
          { label: 'Rows', value: packNumber(rowCount, 0) },
          { label: 'Total Short Qty', value: packNumber(sumBy(rows, (row) => firstNumericValue(row.shortQty, row.shortageQty, row.short, row.variance && row.variance < 0 ? Math.abs(row.variance) : 0)), 0) },
          { label: 'Total Short Value', value: packCurrency(sumBy(rows, (row) => firstNumericValue(row.shortageValue, row.varianceDlc, row.varianceValue))) }
        ];
      case 'excess':
        return [
          { label: 'Rows', value: packNumber(rowCount, 0) },
          { label: 'Total Excess Qty', value: packNumber(sumBy(rows, (row) => firstNumericValue(row.excessQty, row.excess, row.variance && row.variance > 0 ? row.variance : 0)), 0) },
          { label: 'Total Excess Value', value: packCurrency(sumBy(rows, (row) => firstNumericValue(row.excessValue, row.varianceDlc, row.varianceValue))) }
        ];
      case 'damage':
        return [
          { label: 'Rows', value: packNumber(rowCount, 0) },
          { label: 'Damage Qty', value: packNumber(sumBy(rows, (row) => firstNumericValue(row.damageQty, 0)), 0) },
          { label: 'Damage Value', value: packCurrency(sumBy(rows, (row) => firstNumericValue(row.damageValue, row.excessValue, row.shortageValue))) }
        ];
      case 'movement_wise_stock_analysis':
        return [
          { label: 'Rows', value: packNumber(rowCount, 0) },
          { label: 'Fast Moving', value: packNumber(movement.fastMovingCount || movement.fastMovingParts || 0, 0) },
          { label: 'Slow Moving', value: packNumber(movement.slowMovingCount || movement.slowMovingParts || 0, 0) },
          { label: 'Dead Stock', value: packNumber(movement.deadStockCount || movement.deadStockParts || 0, 0) },
          { label: 'Critical Shortage', value: packNumber(movement.criticalShortageCount || movement.criticalShortageParts || 0, 0) }
        ];
      case 'category-wise-variance-summary': {
        const categoryCount = rowCount > 0 && rows[rowCount - 1] && rows[rowCount - 1].rowType === 'grandTotal' ? rowCount - 1 : rowCount;
        return [
          { label: 'Categories', value: packNumber(categoryCount, 0) },
          { label: 'Total Scanned Parts', value: packNumber(totals.totalParts || sumBy(rows, (row) => firstNumericValue(row.totalScannedParts, 0)), 0) },
          { label: 'Total Scanned Qty', value: packNumber(totals.totalQuantity || sumBy(rows, (row) => firstNumericValue(row.totalScannedQuantity, 0)), 0) },
          { label: 'Variance Value', value: packCurrency(totals.totalVarianceDlcValue || sumBy(rows, (row) => firstNumericValue(row.sumVarianceOnDLC, 0))) }
        ];
      }
      case 'partwise-inventory-audit':
        return [
          { label: 'Rows', value: packNumber(rowCount, 0) },
          { label: 'Unique Categories', value: packNumber(countDistinctBy(rows, (row) => row.productCategory || row.category), 0) },
          { label: 'Total Qty', value: packNumber(totals.totalQuantity || totalQty, 0) },
          { label: 'Total Value', value: packCurrency(totals.totalPhysicalDlcValue || totalValue) },
          { label: 'Net Difference', value: packCurrency(totals.totalVarianceDlcValue || sumBy(rows, (row) => firstNumericValue(row.varianceDlc, row.netDifference, row.varianceValue))) }
        ];
      case 'parts-inventory-refresh-template':
        return [
          { label: 'Rows', value: packNumber(rowCount, 0) },
          { label: 'Unique Parts', value: packNumber(uniqueParts, 0) },
          { label: 'Total Qty', value: packNumber(totalQty, 0) }
        ];
      case 'dead-stock-report':
      case 'fast-moving-report':
      case 'slow-moving-report':
      case 'critical-shortage-report':
        return [
          { label: 'Rows', value: packNumber(rowCount, 0) },
          { label: 'Total Qty', value: packNumber(totalQty, 0) },
          { label: 'Total Value', value: packCurrency(totalValue) }
        ];
      case 'dealer-reconciliation-report':
        return [
          { label: 'Rows', value: packNumber(rowCount, 0) },
          { label: 'Matched', value: packNumber(countRows(rows, (row) => row.status === 'Matched'), 0) },
          { label: 'Shortage', value: packNumber(countRows(rows, (row) => row.status === 'Shortage'), 0) },
          { label: 'Excess', value: packNumber(countRows(rows, (row) => row.status === 'Excess' || row.notInDms), 0) }
        ];
      default:
        return [
          { label: 'Rows', value: packNumber(rowCount, 0) },
          { label: 'Unique Parts', value: packNumber(uniqueParts, 0) },
          { label: 'Total Qty', value: packNumber(totals.totalQuantity || totalQty, 0) },
          { label: 'Total Value', value: packCurrency(totals.totalPhysicalDlcValue || totalValue) }
        ];
    }
  };

  const packBuildMap = {
    'bin-wise-stock': async () => ({
      title: 'BIN WISE STOCK REPORT',
      kind: 'table',
      columns: BIN_COLUMNS,
      rows: selectRows(reportData, 'bin-wise-stock'),
      dealerInfo: buildDealerInfoRows(),
      auditInfo: buildAuditInfoRows(),
      summaryMetrics: buildSummaryMetricsForReport('bin-wise-stock', selectRows(reportData, 'bin-wise-stock'), packContext),
      reportKey: 'bin-wise-stock'
    }),
    'user-dealer-wise': async () => ({
      title: 'USER & DEALER WISE REPORT',
      kind: 'table',
      columns: USER_DEALER_COLUMNS,
      rows: selectRows(reportData, 'user-dealer-wise'),
      dealerInfo: buildDealerInfoRows(),
      auditInfo: buildAuditInfoRows(),
      summaryMetrics: buildSummaryMetricsForReport('user-dealer-wise', selectRows(reportData, 'user-dealer-wise'), packContext),
      reportKey: 'user-dealer-wise'
    }),
    'raw-upi': async () => ({
      title: 'RAW UPI REPORT',
      kind: 'table',
      columns: RAW_UPI_COLUMNS,
      rows: Array.isArray(reportData.rawLogRows) ? reportData.rawLogRows : [],
      dealerInfo: buildDealerInfoRows(),
      auditInfo: buildAuditInfoRows(),
      summaryMetrics: buildSummaryMetricsForReport('raw-upi', Array.isArray(reportData.rawLogRows) ? reportData.rawLogRows : [], packContext),
      reportKey: 'raw-upi'
    }),
    'scan-register': async () => ({
      title: 'SCAN REGISTER REPORT',
      kind: 'table',
      columns: SCAN_REGISTER_COLUMNS,
      rows: scanRegisterRowsData,
      dealerInfo: buildDealerInfoRows(),
      auditInfo: buildAuditInfoRows(),
      summaryMetrics: buildSummaryMetricsForReport('scan-register', scanRegisterRowsData, packContext),
      reportKey: 'scan-register'
    }),
    'invalid-scan-report': async () => {
      const rejectedRows = await rejectedReportRows(resolvedQuery);
      return {
        title: 'INVALID SCAN REPORT',
        kind: 'table',
        columns: INVALID_SCAN_COLUMNS,
        rows: rejectedRows,
        dealerInfo: buildDealerInfoRows(),
        auditInfo: buildAuditInfoRows(),
        summaryMetrics: buildSummaryMetricsForReport('invalid-scan-report', rejectedRows, packContext),
        reportKey: 'invalid-scan-report'
      };
    },
    'stock-summary': async () => {
      const stockSummary = await getStockSummaryData();
      return {
        title: 'STOCK SUMMARY',
        kind: 'stock-summary',
        data: stockSummary
      };
    },
    short: async () => {
      const partwise = await getPartwiseData();
      return {
        title: 'SHORT REPORT',
        kind: 'table',
        columns: partwise.columns || [],
        rows: (partwise.rows || []).filter((row) => String(row.status || '').toLowerCase() === 'short'),
        dealerInfo: buildDealerInfoRows(),
        auditInfo: buildAuditInfoRows(),
        summaryMetrics: buildSummaryMetricsForReport('short', (partwise.rows || []).filter((row) => String(row.status || '').toLowerCase() === 'short'), packContext),
        reportKey: 'short'
      };
    },
    excess: async () => {
      const partwise = await getPartwiseData();
      return {
        title: 'EXCESS REPORT',
        kind: 'table',
        columns: partwise.columns || [],
        rows: (partwise.rows || []).filter((row) => ['excess', 'extra part'].includes(String(row.status || '').toLowerCase())),
        dealerInfo: buildDealerInfoRows(),
        auditInfo: buildAuditInfoRows(),
        summaryMetrics: buildSummaryMetricsForReport('excess', (partwise.rows || []).filter((row) => ['excess', 'extra part'].includes(String(row.status || '').toLowerCase())), packContext),
        reportKey: 'excess'
      };
    },
    movement_wise_stock_analysis: async () => ({
      title: 'MOVEMENT WISE STOCK ANALYSIS',
      kind: 'table',
      columns: movementAnalysisData.columns || [],
      rows: movementAnalysisData.rows || [],
      dealerInfo: buildDealerInfoRows(),
      auditInfo: buildAuditInfoRows(),
      summaryMetrics: buildSummaryMetricsForReport('movement_wise_stock_analysis', movementAnalysisData.rows || [], packContext),
      reportKey: 'movement_wise_stock_analysis'
    }),
    damage: async () => {
      const partwise = await getPartwiseData();
      return {
        title: 'DAMAGE REPORT',
        kind: 'table',
        columns: partwise.columns || [],
        rows: (partwise.rows || []).filter((row) => Number(row.damageQty || 0) > 0),
        dealerInfo: buildDealerInfoRows(),
        auditInfo: buildAuditInfoRows(),
        summaryMetrics: buildSummaryMetricsForReport('damage', (partwise.rows || []).filter((row) => Number(row.damageQty || 0) > 0), packContext),
        reportKey: 'damage'
      };
    },
    'category-wise-variance-summary': async () => {
      const category = await getCategoryData();
      return {
        title: 'CATEGORY WISE VARIANCE SUMMARY',
        kind: 'table',
        columns: CATEGORY_VARIANCE_COLUMNS,
        rows: buildCategoryVarianceRows(category, packContext),
        dealerInfo: buildDealerInfoRows(),
        auditInfo: buildAuditInfoRows(),
        summaryMetrics: buildSummaryMetricsForReport('category-wise-variance-summary', buildCategoryVarianceRows(category, packContext), packContext),
        reportKey: 'category-wise-variance-summary'
      };
    },
    'partwise-inventory-audit': async () => {
      const partwise = await getPartwiseData();
      return {
        title: 'PARTWISE INVENTORY AUDIT REPORT',
        kind: 'table',
        columns: partwise.columns || [],
        rows: partwise.rows || [],
        dealerInfo: buildDealerInfoRows(),
        auditInfo: buildAuditInfoRows(),
        summaryMetrics: buildSummaryMetricsForReport('partwise-inventory-audit', partwise.rows || [], packContext),
        reportKey: 'partwise-inventory-audit'
      };
    },
    'parts-inventory-refresh-template': async () => {
      const rows = await reportModule.buildPartsInventoryRefreshRows(resolvedQuery);
      const maxBinCount = Math.max(1, ...rows.map((row) => (row.binLocations || []).length));
      const binColumns = Array.from({ length: maxBinCount }, (_, index) => ({
        header: `Bin Loc ${index + 1}`,
        key: `binLocation${index + 1}`,
        width: 16
      }));
      const columns = [
        { header: 'Part Number', key: 'partNumber', width: 18 },
        { header: 'Qty', key: 'qty', width: 10 },
        { header: 'Physical Bin Qty', key: 'physicalBinQty', width: 18 },
        { header: 'Fitted Qty', key: 'fittedQty', width: 14 },
        { header: 'Fitted Regd No', key: 'fittedRegdNo', width: 18 },
        { header: 'Fitted Job Card No', key: 'fittedJobCardNo', width: 20 },
        ...binColumns
      ];
      return {
        title: 'PART INVENTORY REFRESH TEMPLATE',
        kind: 'table',
        columns,
        rows: rows.map((row) => {
          const record = {
            partNumber: row.partNumber || '',
            qty: row.qty || row.quantity || 0,
            physicalBinQty: row.physicalBinQty || 0,
            fittedQty: row.fittedQty || 0,
            fittedRegdNo: row.fittedRegdNo || '',
            fittedJobCardNo: row.fittedJobCardNo || ''
          };
          binColumns.forEach((column, index) => {
            record[column.key] = (row.binLocations || [])[index] || '';
          });
          return record;
        }),
        dealerInfo: buildDealerInfoRows(),
        auditInfo: buildAuditInfoRows(),
        summaryMetrics: buildSummaryMetricsForReport('parts-inventory-refresh-template', rows, packContext),
        reportKey: 'parts-inventory-refresh-template'
      };
    },
    'reconciliation-report': async () => {
      const reconciliation = await getReconciliationData();
      return {
        title: 'RECONCILIATION REPORT',
        kind: 'metrics',
        rows: buildReconciliationSummaryRows(reconciliation, packContext),
        tables: [{
          title: 'CATEGORY-WISE RECONCILIATION',
          columns: [
            { header: 'CATEGORY', key: 'category', width: 24 },
            { header: 'DMS QTY', key: 'dmsQty', width: 12, numFmt: '#,##0' },
            { header: 'ACTUAL QTY', key: 'actualQty', width: 12, numFmt: '#,##0' },
            { header: 'VARIANCE QTY', key: 'varianceQty', width: 14, numFmt: '#,##0' },
            { header: 'DMS VALUE (DLC)', key: 'dmsValue', width: 18, numFmt: PACK_CURRENCY_FORMAT },
            { header: 'ACTUAL VALUE (DLC)', key: 'actualValue', width: 20, numFmt: PACK_CURRENCY_FORMAT },
            { header: 'SHORT VALUE', key: 'shortValue', width: 14, numFmt: PACK_CURRENCY_FORMAT },
            { header: 'EXCESS VALUE', key: 'excessValue', width: 14, numFmt: PACK_CURRENCY_FORMAT },
            { header: 'NET DIFFERENCE', key: 'netDifference', width: 16, numFmt: PACK_CURRENCY_FORMAT },
            { header: 'STATUS', key: 'status', width: 14 }
          ],
          rows: buildReconciliationCategoryRows(reconciliation, packContext)
        }],
        reportKey: 'reconciliation-report'
      };
    },
    'dealer-reconciliation-report': async () => {
      const reconciliation = await getReconciliationData();
      return {
        title: 'DEALER RECONCILIATION REPORT',
        kind: 'table',
        columns: RECONCILIATION_COLUMNS,
        rows: reconciliation.rows || [],
        dealerInfo: buildDealerInfoRows(),
        auditInfo: buildAuditInfoRows(),
        summaryMetrics: buildSummaryMetricsForReport('dealer-reconciliation-report', reconciliation.rows || [], packContext),
        reportKey: 'dealer-reconciliation-report'
      };
    },
    'dead-stock-report': async () => ({
      title: 'DEAD STOCK REPORT',
      kind: 'table',
      columns: movementAnalysisData.columns || [],
      rows: (movementAnalysisData.sections && movementAnalysisData.sections.deadStock) || [],
      dealerInfo: buildDealerInfoRows(),
      auditInfo: buildAuditInfoRows(),
      summaryMetrics: buildSummaryMetricsForReport('dead-stock-report', (movementAnalysisData.sections && movementAnalysisData.sections.deadStock) || [], packContext),
      reportKey: 'dead-stock-report'
    }),
    'fast-moving-report': async () => ({
      title: 'FAST MOVING REPORT',
      kind: 'table',
      columns: movementAnalysisData.columns || [],
      rows: (movementAnalysisData.sections && movementAnalysisData.sections.fastMoving) || [],
      dealerInfo: buildDealerInfoRows(),
      auditInfo: buildAuditInfoRows(),
      summaryMetrics: buildSummaryMetricsForReport('fast-moving-report', (movementAnalysisData.sections && movementAnalysisData.sections.fastMoving) || [], packContext),
      reportKey: 'fast-moving-report'
    }),
    'slow-moving-report': async () => ({
      title: 'SLOW MOVING REPORT',
      kind: 'table',
      columns: movementAnalysisData.columns || [],
      rows: (movementAnalysisData.sections && movementAnalysisData.sections.slowMoving) || [],
      dealerInfo: buildDealerInfoRows(),
      auditInfo: buildAuditInfoRows(),
      summaryMetrics: buildSummaryMetricsForReport('slow-moving-report', (movementAnalysisData.sections && movementAnalysisData.sections.slowMoving) || [], packContext),
      reportKey: 'slow-moving-report'
    }),
    'critical-shortage-report': async () => ({
      title: 'CRITICAL SHORTAGE REPORT',
      kind: 'table',
      columns: movementAnalysisData.columns || [],
      rows: (movementAnalysisData.sections && movementAnalysisData.sections.criticalShortage) || [],
      dealerInfo: buildDealerInfoRows(),
      auditInfo: buildAuditInfoRows(),
      summaryMetrics: buildSummaryMetricsForReport('critical-shortage-report', (movementAnalysisData.sections && movementAnalysisData.sections.criticalShortage) || [], packContext),
      reportKey: 'critical-shortage-report'
    })
  };

  const selectedSpecs = (await Promise.all(normalized.reports.map(async (reportKey) => {
    const builder = packBuildMap[reportKey];
    if (!builder) return null;
    try {
      return await builder();
    } catch (error) {
      return {
        title: reportLabelForKey(reportKey).toUpperCase(),
        kind: 'metrics',
        rows: packMetricRows('Error', [['Message', error.message]])
      };
    }
  }))).filter(Boolean);

  selectedSpecs.forEach((spec) => {
    if (!spec) return;
    if (spec.kind === 'stock-summary') {
      reportModule.addStockSummarySheet(workbook, spec.data || {}, {
        generatedBy,
        generatedAt,
        canonicalContext: packContext,
        reportData
      });
      return;
    }
    if (spec.kind === 'metrics') {
      addMetricSheet(workbook, spec.title, spec.rows || [], {
        title: spec.title,
        tables: spec.tables || [],
        sectionFills: spec.sectionFills || {},
        orientation: spec.orientation || 'landscape',
        generatedAt
      });
      return;
    }
    const summaryMetrics = Array.isArray(spec.summaryMetrics) && spec.summaryMetrics.length
      ? spec.summaryMetrics
      : buildSummaryMetricsForReport(
        spec.reportKey || '',
        spec.rows || [],
        { movementAnalysis: movementAnalysisData, registerCounts: countScanRegisterRows(scanRegisterRowsData) }
      );
    addTableSheet(workbook, spec.title, spec.columns || [], spec.rows || [], {
      title: spec.title,
      dealerInfo: spec.dealerInfo || buildDealerInfoRows(),
      auditInfo: spec.auditInfo || buildAuditInfoRows(),
      summaryMetrics,
      reportData,
      generatedBy,
      generatedAt,
      canonicalContext: packContext,
      dealerTitle: 'Dealer Details',
      auditTitle: 'Audit Details',
      summaryTitle: spec.summaryTitle || 'Report Summary',
      tableTitle: spec.tableTitle || spec.title,
      emptyMessage: spec.emptyMessage || 'No Data Available',
      orientation: spec.orientation || 'landscape',
      maxWidth: spec.maxWidth
    });
  });

  return {
    workbook,
    normalized,
    resolvedQuery,
    reportData,
    selectedDealer,
    selectedAudit,
    generatedBy,
    generatedAt
  };
}

function packFileDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
}

function sanitizePackFilePart(value) {
  return clean(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function buildAuditPackFilename(result = {}) {
  const normalized = result.normalized || {};
  const selectedDealer = result.selectedDealer || {};
  const selectedAudit = result.selectedAudit || {};
  const dealerCode = sanitizePackFilePart(selectedDealer.dealerCode || normalized.dealerCode || 'DEALER');
  const dealerName = sanitizePackFilePart(selectedDealer.dealerName || normalized.dealerName || selectedDealer.dealerCode || 'AUDIT');
  const auditDate = packFileDate(
    selectedAudit.auditClosedDate ||
    selectedAudit.auditEndDate ||
    selectedAudit.auditStartDate ||
    selectedAudit.auditDate ||
    normalized.toDate ||
    normalized.fromDate ||
    new Date()
  );
  return `AUDIT_PACK_${dealerCode}_${dealerName}_${auditDate}.xlsx`;
}

function columnsForRows(rows) {
  const first = rows[0] || {};
  return Object.keys(first).filter((key) => !key.startsWith('_')).map((key) => ({
    header: key.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase()),
    key,
    width: Math.max(14, Math.min(34, key.length + 8))
  }));
}

function columnsForReport(type, rows) {
  if (type === 'bin-wise-stock' || type === 'bin-stock' || type === 'bin-wise') return BIN_COLUMNS;
  if (type === 'valid-scans') return SCAN_COLUMNS;
  if (type === 'scan-register') return SCAN_REGISTER_COLUMNS;
  if (type === 'user-dealer-wise') return USER_DEALER_COLUMNS;
  if (type === 'device-wise') return DEVICE_COLUMNS;
  if (type === 'duplicate-scans') return DUPLICATE_COLUMNS;
  if (type === 'invalid-scan-report' || type === 'wrong-not-found-master') return INVALID_SCAN_COLUMNS;
  if (type === 'multiple-bin-location-alert') return MULTIPLE_BIN_LOCATION_ALERT_COLUMNS;
  return columnsForRows(rows);
}

function selectedColumns(columns, query = {}) {
  const selected = String(query.columns || query.fields || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  if (!selected.length) return columns;
  const byKey = new Map(columns.map((column) => [column.key, column]));
  const filtered = selected.map((key) => byKey.get(key)).filter(Boolean);
  return filtered.length ? filtered : columns;
}

function pagination(query = {}) {
  const page = Math.max(1, Number.parseInt(query.page || '1', 10) || 1);
  const limit = Math.min(500, Math.max(25, Number.parseInt(query.limit || '100', 10) || 100));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

function pageRows(rows = [], query = {}) {
  const { page, limit, skip } = pagination(query);
  return {
    rows: rows.slice(skip, skip + limit),
    page,
    limit,
    skip,
    totalRows: rows.length,
    totalPages: Math.max(1, Math.ceil(rows.length / limit))
  };
}

function renderExcelReportHeader(sheet, workbook, title, subtitle, totalColumns) {
  const endColumn = Math.max(4, Number(totalColumns) || 4);
  sheet.mergeCells(1, 1, 2, 3);
  sheet.getCell(1, 1).value = '';
  sheet.getRow(1).height = 28;
  sheet.getRow(2).height = 22;
  const logoId = packGetDakshReportLogoId(workbook);
  if (logoId !== null) {
    sheet.addImage(logoId, {
      tl: { col: 0.2, row: 0.16 },
      ext: { width: 126, height: 32 }
    });
  }
  sheet.mergeCells(1, 4, 1, endColumn);
  sheet.getCell(1, 4).value = title || 'DAKSH INVENTORY SYSTEM';
  sheet.getCell(1, 4).font = { name: PACK_FONT, size: 20, bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getCell(1, 4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF153A5B' } };
  sheet.getCell(1, 4).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  sheet.mergeCells(2, 4, 2, endColumn);
  sheet.getCell(2, 4).value = subtitle || '';
  sheet.getCell(2, 4).font = { name: PACK_FONT, size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getCell(2, 4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B5CAB' } };
  sheet.getCell(2, 4).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  sheet.getRow(3).height = 20;
}

async function sendExcel(res, title, rows, type, query = {}) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(title.slice(0, 31));
  const columns = selectedColumns(columnsForReport(type, rows), query);
  const tableColumns = columns.length ? columns : [{ header: 'Message', key: 'message', width: 30 }];
  sheet.columns = tableColumns.map((column) => ({ key: column.key, width: column.width }));
  renderExcelReportHeader(sheet, workbook, 'DAKSH INVENTORY SYSTEM', title, tableColumns.length + 3);
  sheet.getRow(3).values = tableColumns.map((column) => column.header);
  sheet.getRow(3).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF153A5B' } };
  sheet.getRow(3).alignment = { vertical: 'middle', horizontal: 'left' };
  sheet.views = [{ state: 'frozen', ySplit: 3 }];
  (rows.length ? rows : [{ message: 'No data found' }]).forEach((row) => {
    const added = sheet.addRow(formatDateLikeFields(row));
    added.eachCell((cell) => {
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
      };
    });
  });
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${title.replace(/[^a-z0-9]/gi, '_')}.xlsx"`);
  res.send(Buffer.from(buffer));
}

async function buildExcelBuffer(title, rows, type, query = {}) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(title.slice(0, 31));
  const columns = selectedColumns(columnsForReport(type, rows), query);
  const tableColumns = columns.length ? columns : [{ header: 'Message', key: 'message', width: 30 }];
  sheet.columns = tableColumns.map((column) => ({ key: column.key, width: column.width }));
  renderExcelReportHeader(sheet, workbook, 'DAKSH INVENTORY SYSTEM', title, tableColumns.length + 3);
  sheet.getRow(3).values = tableColumns.map((column) => column.header);
  sheet.getRow(3).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF153A5B' } };
  sheet.getRow(3).alignment = { vertical: 'middle', horizontal: 'left' };
  sheet.views = [{ state: 'frozen', ySplit: 3 }];
  (rows.length ? rows : [{ message: 'No data found' }]).forEach((row) => {
    const added = sheet.addRow(formatDateLikeFields(row));
    added.eachCell((cell) => {
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
      };
    });
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function sendPdf(res, title, rows, type, query = {}) {
  const doc = new jsPDF({ orientation: 'landscape' });
  const columns = selectedColumns(columnsForReport(type, rows), query).slice(0, 12);
  const bodyRows = (rows.length ? rows : [{ message: 'No data found' }]).slice(0, 200);
  doc.addImage(DAKSH_REPORT_LOGO_BUFFER, 'PNG', 14, 8, 72, 18);
  doc.setFontSize(14);
  doc.text(`DAKSH INVENTORY SYSTEM - ${title}`, 92, 16);
  autoTable(doc, {
    startY: 30,
    head: [columns.length ? columns.map((column) => column.header) : ['Message']],
    body: bodyRows.map((row) => {
      const formatted = formatDateLikeFields(row);
      return columns.length ? columns.map((column) => String(formatted[column.key] ?? '')) : ['No data found'];
    }),
    styles: { fontSize: 7, cellPadding: 2 },
    headStyles: { fillColor: [21, 58, 91] }
  });
  const pdf = Buffer.from(doc.output('arraybuffer'));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${title.replace(/[^a-z0-9]/gi, '_')}.pdf"`);
  res.send(pdf);
}

function buildPdfBuffer(title, rows, type, query = {}) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const columns = selectedColumns(columnsForReport(type, rows), query).slice(0, 12);
  const bodyRows = (rows.length ? rows : [{ message: 'No data found' }]).slice(0, 500);
  doc.addImage(DAKSH_REPORT_LOGO_BUFFER, 'PNG', 24, 12, 104, 26);
  doc.setFontSize(14);
  doc.text(`DAKSH INVENTORY SYSTEM - ${title}`, 142, 28);
  autoTable(doc, {
    startY: 42,
    head: [columns.length ? columns.map((column) => column.header) : ['Message']],
    body: bodyRows.map((row) => {
      const formatted = formatDateLikeFields(row);
      return columns.length ? columns.map((column) => String(formatted[column.key] ?? '')) : ['No data found'];
    }),
    styles: { fontSize: 7, cellPadding: 2 },
    headStyles: { fillColor: [21, 58, 91] }
  });
  return Buffer.from(doc.output('arraybuffer'));
}

async function handleReport(req, res, type, title) {
  try {
    const query = { ...req.query };
    if (type === 'scan-register' && /\/valid-scans$/i.test(req.path)) query.scanStatus = 'Accepted';
    if (type === 'scan-register' && /\/duplicate-scans$/i.test(req.path)) query.scanStatus = 'Duplicate';
    if (!selectedDealerCode(query)) return requireDealerSelection(res);
    if (type === 'multiple-bin-location-alert') {
      const report = await multipleBinLocationAlertRows(query);
      if (!report) return requireDealerSelection(res);
      const rows = report.rows || [];
      if (query.format === 'excel') return sendExcel(res, report.title, rows, type, query);
      if (query.format === 'pdf') return sendPdf(res, report.title, rows, type, query);
      const paged = pageRows(rows, query);
      return res.json({
        success: true,
        type,
        title: report.title,
        summary: { ...report.summary, totalRows: rows.length, visibleRows: rows.length, pageRows: paged.rows.length },
        reconciliation: null,
        columns: columnsForReport(type, paged.rows.length ? paged.rows : rows).map(({ header, key }) => ({ header, key })),
        rows: paged.rows,
        totalRows: rows.length,
        pagination: { page: paged.page, limit: paged.limit, skip: paged.skip, totalRows: paged.totalRows, totalPages: paged.totalPages },
        message: report.message || (rows.length ? '' : 'No multiple bin location alerts found for selected filter')
      });
    }
    const reconciliation = await reportModule.validateValuationReports(query);
    if (type === 'scan-register') {
      const rows = await scanRegisterRows(query);
      const statuses = rows.map((row) => normalizeRegisterStatus(row.scanStatus || row.syncStatus || row.reason));
      const duplicateCount = statuses.filter((status) => status === 'duplicate').length;
      const rejectedRows = rows.filter((row, index) => statuses[index] === 'rejected');
      const failedCount = statuses.filter((status) => status === 'failed sync').length;
      const validRows = rows.filter((row, index) => !['duplicate', 'rejected', 'failed sync', 'deleted'].includes(statuses[index]));
      const totals = reportTotals(validRows, { visibleRows: rows.length, duplicateCount });
      totals.unknownPartsCount = rejectedRows.length;
      totals.unknownPartCount = rejectedRows.length;
      totals.unknownUniqueParts = new Set(rejectedRows.map((row) => normalizePartNumber(row.partNumber)).filter(Boolean)).size;
      totals.rejectedCount = rejectedRows.length;
      totals.failedCount = failedCount;
      if (query.format === 'excel') return sendExcel(res, title, rows, type, query);
      if (query.format === 'pdf') return sendPdf(res, title, rows, type, query);
      const paged = pageRows(rows, query);
      return res.json({
        success: true,
        type,
        title,
        summary: { ...totals, totalRows: rows.length, visibleRows: rows.length, pageRows: paged.rows.length },
        reconciliation,
        columns: columnsForReport(type, paged.rows.length ? paged.rows : rows).map(({ header, key }) => ({ header, key })),
        rows: paged.rows,
        totalRows: rows.length,
        pagination: { page: paged.page, limit: paged.limit, skip: paged.skip, totalRows: paged.totalRows, totalPages: paged.totalPages },
        message: rows.length ? '' : 'No scan register data found for selected filter'
      });
    }
    const rowOriented = ['valid-scans', 'raw-upi'].includes(type);
    const data = await reportModule.buildReportData(rowOriented ? { ...query, ...rowReportScanWindow(query) } : query);
    const rows = selectRows(data, type);
    const totals = reportTotals(data.scans || [], { visibleRows: rows.length });
    if (query.format === 'excel') return sendExcel(res, title, rows, type, query);
    if (query.format === 'pdf') return sendPdf(res, title, rows, type, query);
    const paged = pageRows(rows, query);
    return res.json({
      success: true,
      type,
      title,
      summary: { ...(data.summary[0] || {}), ...totals, visibleRows: rows.length, pageRows: paged.rows.length },
      reconciliation,
      columns: columnsForReport(type, paged.rows.length ? paged.rows : rows).map(({ header, key }) => ({ header, key })),
      rows: paged.rows,
      totalRows: rows.length,
      pagination: { page: paged.page, limit: paged.limit, skip: paged.skip, totalRows: paged.totalRows, totalPages: paged.totalPages },
      message: rows.length ? '' : 'No report data found for selected filter'
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message, reconciliation: error.reconciliation });
  }
}

async function emailReport(req, res, type, title) {
  try {
    if (!selectedDealerCode(req.body.filters || {})) return requireDealerSelection(res);
    if (type === 'multiple-bin-location-alert') {
      const report = await multipleBinLocationAlertRows(req.body.filters || {});
      if (!report) return requireDealerSelection(res);
      const rows = report.rows || [];
      const to = String(req.body.to || req.body.email || '').trim();
      const cc = String(req.body.cc || '').trim();
      const subject = String(req.body.subject || `Daksh Inventory - ${report.title}`).trim();
      const message = String(req.body.message || `Please find attached the ${report.title}.`).trim();
      const attachmentType = String(req.body.attachmentType || 'Excel').trim().toLowerCase();
      if (!to) return res.status(400).json({ success: false, message: 'Email To is required' });
      if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        return res.status(400).json({ success: false, message: 'SMTP_USER and SMTP_PASS must be configured in .env' });
      }

      const attachments = [];
      if (attachmentType === 'excel' || attachmentType === 'both') {
        attachments.push({ filename: `${report.title.replace(/[^a-z0-9]/gi, '_')}.xlsx`, content: await buildExcelBuffer(report.title, rows, type) });
      }
      if (attachmentType === 'pdf' || attachmentType === 'both') {
        attachments.push({ filename: `${report.title.replace(/[^a-z0-9]/gi, '_')}.pdf`, content: buildPdfBuffer(report.title, rows, type) });
      }

      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: Number(process.env.SMTP_PORT || 587) === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      });

      await transporter.sendMail({
        from: process.env.REPORT_EMAIL || process.env.SMTP_USER,
        to,
        cc: cc || undefined,
        subject,
        text: message,
        attachments
      });

      return res.json({ success: true, message: 'Report email sent' });
    }
    await reportModule.validateValuationReports(req.body.filters || {});
    const to = String(req.body.to || req.body.email || '').trim();
    const cc = String(req.body.cc || '').trim();
    const subject = String(req.body.subject || `Daksh Inventory - ${title}`).trim();
    const message = String(req.body.message || `Please find attached the ${title}.`).trim();
    const attachmentType = String(req.body.attachmentType || 'Excel').trim().toLowerCase();
    if (!to) return res.status(400).json({ success: false, message: 'Email To is required' });
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      return res.status(400).json({ success: false, message: 'SMTP_USER and SMTP_PASS must be configured in .env' });
    }

    let rows;
    if (type === 'scan-register') {
      rows = await scanRegisterRows(req.body.filters || {});
    } else {
      rows = selectRows(await reportModule.buildReportData(req.body.filters || {}), type);
    }
    const attachments = [];
    if (attachmentType === 'excel' || attachmentType === 'both') {
      attachments.push({ filename: `${title.replace(/[^a-z0-9]/gi, '_')}.xlsx`, content: await buildExcelBuffer(title, rows, type) });
    }
    if (attachmentType === 'pdf' || attachmentType === 'both') {
      attachments.push({ filename: `${title.replace(/[^a-z0-9]/gi, '_')}.pdf`, content: buildPdfBuffer(title, rows, type) });
    }

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT || 587) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });

    await transporter.sendMail({
      from: process.env.REPORT_EMAIL || process.env.SMTP_USER,
      to,
      cc: cc || undefined,
      subject,
      text: message,
      attachments
    });

    return res.json({ success: true, message: 'Report email sent' });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message, reconciliation: error.reconciliation });
  }
}

const REPORTS = {
  'bin-wise-stock': ['bin-wise-stock', 'Bin Wise Stock Report'],
  'user-dealer-wise': ['user-dealer-wise', 'User & Dealer Wise Report'],
  'scan-register': ['scan-register', 'Scan Register Report'],
};

Object.entries(REPORTS).forEach(([path, [type, title]]) => {
  router.get(`/${path}`, auth.requireAuth, (req, res) => handleReport(req, res, type, title));
  router.post(`/${path}/email`, auth.requireAuth, auth.requireAdmin, (req, res) => emailReport(req, res, type, title));
});

function scanRegisterAliasQuery(query = {}, scanStatus = '') {
  return { ...query, scanStatus: scanStatus || query.scanStatus || '' };
}

function handleScanRegisterAlias(req, res, scanStatus = '') {
  req.query = scanRegisterAliasQuery(req.query, scanStatus);
  return handleReport(req, res, 'scan-register', 'Scan Register Report');
}

function emailScanRegisterAlias(req, res, scanStatus = '') {
  req.body = {
    ...req.body,
    filters: scanRegisterAliasQuery(req.body && req.body.filters || {}, scanStatus)
  };
  return emailReport(req, res, 'scan-register', 'Scan Register Report');
}

async function handleInvalidScanReport(req, res) {
  try {
    if (!selectedDealerCode(req.query)) return requireDealerSelection(res);
    const rows = await rejectedReportRows(req.query);
    const title = 'Invalid Scan Report';
    if (req.query.format === 'excel') return sendExcel(res, title, rows, 'invalid-scan-report', req.query);
    if (req.query.format === 'pdf') return sendPdf(res, title, rows, 'invalid-scan-report', req.query);
    return res.json({
      success: true,
      type: 'invalid-scan-report',
      title,
      summary: { invalidCount: rows.length },
      columns: INVALID_SCAN_COLUMNS.map(({ header, key }) => ({ header, key })),
      rows,
      totalRows: rows.length,
      message: rows.length ? '' : 'No invalid scans found for selected filter'
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function handleCompleteAuditPack(req, res) {
  try {
    const normalized = normalizeAuditPackSelection(req.body || {});
    if (!normalized.dealerCode) return requireDealerSelection(res);
    if (!normalized.reports.length) {
      return res.status(400).json({ success: false, message: 'Please select at least one report' });
    }

    const generatedBy = clean(req.user && (req.user.name || req.user.username || req.user.email || req.user.id || 'System'));
    const cacheQuery = {
      ...normalized,
      generatedBy
    };

    const cached = await getCachedResponse('complete-audit-pack', cacheQuery, async () => {
      const result = await buildCompleteAuditPackWorkbook({
        ...normalized,
        generatedBy
      }, req.user || {});
      const buffer = Buffer.from(await result.workbook.xlsx.writeBuffer());
      return {
        buffer,
        filename: buildAuditPackFilename(result)
      };
    }, {
      scope: { dealerCode: normalized.dealerCode, auditId: normalized.auditId },
      tags: ['report', 'reconciliation', 'scan', 'stock', 'master', 'catalogue', 'dealer', 'bin', 'price', 'audit']
    });

    applyCacheHeaders(res, cached);
    const output = cached.data || {};
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${output.filename || 'AUDIT_PACK.xlsx'}"`);
    return res.send(Buffer.isBuffer(output.buffer) ? output.buffer : Buffer.from(output.buffer || []));
  } catch (error) {
    return res.status(reportErrorStatus(error)).json({ success: false, message: error.message });
  }
}

router.get('/invalid-scan-report', auth.requireAuth, handleInvalidScanReport);
router.get('/wrong-not-found-master', auth.requireAuth, handleInvalidScanReport);
router.post('/download-complete-audit-pack', auth.requireAuth, handleCompleteAuditPack);
router.get('/multiple-bin-location-alert', auth.requireAuth, (req, res) => handleReport(req, res, 'multiple-bin-location-alert', 'Multiple Bin Location Alert Report'));
router.post('/multiple-bin-location-alert/email', auth.requireAuth, auth.requireAdmin, (req, res) => emailReport(req, res, 'multiple-bin-location-alert', 'Multiple Bin Location Alert Report'));

router.get('/duplicate-scans', auth.requireAuth, (req, res) => handleScanRegisterAlias(req, res, 'Duplicate'));
router.post('/duplicate-scans/email', auth.requireAuth, auth.requireAdmin, (req, res) => emailScanRegisterAlias(req, res, 'Duplicate'));

router.get('/bin-wise', auth.requireAuth, (req, res) => handleReport(req, res, 'bin-wise-stock', 'Bin Wise Stock Report'));
router.get('/bin-stock', auth.requireAuth, (req, res) => handleReport(req, res, 'bin-wise-stock', 'Bin Wise Stock Report'));
router.get('/raw-upi', auth.requireAuth, (req, res) => handleReport(req, res, 'raw-upi', 'Raw UPI Report'));
router.get('/valid-scans', auth.requireAuth, (req, res) => handleScanRegisterAlias(req, res, 'Accepted'));
router.get('/device-wise', auth.requireAuth, (req, res) => handleScanRegisterAlias(req, res, ''));
router.post('/valid-scans/email', auth.requireAuth, auth.requireAdmin, (req, res) => emailScanRegisterAlias(req, res, 'Accepted'));
router.post('/device-wise/email', auth.requireAuth, auth.requireAdmin, (req, res) => emailScanRegisterAlias(req, res, ''));

module.exports = router;
module.exports.handleReport = handleReport;
module.exports.emailReport = emailReport;
