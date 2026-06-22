const ExcelJS = require('exceljs');
const { jsPDF } = require('jspdf');
const autoTableModule = require('jspdf-autotable');
const nodemailer = require('nodemailer');
const reportModule = require('./report');
const reconciliationRoute = require('./reconciliation');
const router = reportModule;
const auth = require('./auth');
const { applyCacheHeaders, getCachedResponse } = require('../utils/reportCache');
const DuplicateScanLog = require('../models/DuplicateScanLog');
const VerificationLog = require('../models/VerificationLog');
const { formatDateLikeFields, formatIstDateTime, parseIstFilterDate } = require('../utils/time');
const { scanValueRow } = require('../utils/inventoryValueEngine');
const { normalizePartNumber } = require('../utils/normalize');
const { reportTotals, signedScanQuantity } = require('../utils/reportTotals');
const categoryResolver = require('../utils/categoryResolver');
const canonicalizePartCategory = typeof categoryResolver.canonicalizePartCategory === 'function'
  ? categoryResolver.canonicalizePartCategory
  : (value, options = {}) => String(value || '').trim() || options.uncategorized || 'Uncategorized';

const INVALID_PART_MESSAGE = 'Invalid part number - not found in master catalogue';

const autoTable = autoTableModule.default || autoTableModule;

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

async function scanRegisterRows(query = {}) {
  const sourceQuery = { ...stripRegisterOnlyFilters(query), ...rowReportScanWindow(query) };
  const data = await reportModule.buildReportData(sourceQuery);
  const duplicates = await duplicateReportRows(sourceQuery);
  return [
    ...data.scans.map(scanRegisterInventoryRow),
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

function styleHeaderRow(row, fill = 'FF153A5B') {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  row.eachCell((cell) => {
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFD7E2EE' } },
      left: { style: 'thin', color: { argb: 'FFD7E2EE' } },
      bottom: { style: 'thin', color: { argb: 'FFD7E2EE' } },
      right: { style: 'thin', color: { argb: 'FFD7E2EE' } }
    };
  });
}

function styleDataRow(row, columns, options = {}) {
  row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
    const column = columns[columnNumber - 1] || {};
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
    };
    cell.alignment = {
      vertical: 'middle',
      horizontal: options.rightAlignColumns && options.rightAlignColumns.has(columnNumber - 1) ? 'right' : 'left',
      wrapText: true
    };
    if (column.numFmt) cell.numFmt = column.numFmt;
  });
}

function addSheetFooter(sheet) {
  sheet.headerFooter = {
    oddFooter: '&LGenerated from DAKSH Inventory System'
  };
}

function addTableSheet(workbook, name, columns, rows, options = {}) {
  const sheet = workbook.addWorksheet(uniqueSheetName(workbook, name));
  const rowData = Array.isArray(rows) && rows.length ? rows : [{
    [columns[0] && columns[0].key ? columns[0].key : 'message']: options.emptyMessage || 'No Data Available'
  }];
  const resolvedColumns = packColumnWidths(columns, rowData, options.sampleSize || 100, options.maxWidth || 60);
  sheet.columns = resolvedColumns.map((column) => ({
    header: column.header,
    key: column.key,
    width: column.width
  }));
  resolvedColumns.forEach((column, index) => {
    if (column.numFmt) sheet.getColumn(index + 1).numFmt = column.numFmt;
  });
  styleHeaderRow(sheet.getRow(1), options.headerFill || 'FF153A5B');
  sheet.getRow(1).height = 22;
  const rightAlignColumns = new Set(resolvedColumns
    .map((column, index) => (column.numFmt ? index : null))
    .filter((index) => index !== null));
  rowData.forEach((row) => {
    const added = sheet.addRow(normalizePackRow(row));
    styleDataRow(added, resolvedColumns, { rightAlignColumns });
    if (row.rowType === 'grandTotal' || row.rowType === 'subtotal' || row.isTotal) {
      added.font = { bold: true };
      added.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF6FF' } };
    }
    if (String(row.message || '').trim() === 'No Data Available') {
      added.font = { italic: true, color: { argb: 'FF64748B' } };
    }
  });
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: resolvedColumns.length } };
  addSheetFooter(sheet);
  sheet.pageSetup = { fitToPage: true, orientation: options.orientation || 'landscape' };
  return sheet;
}

function addMetricSheet(workbook, name, rows, options = {}) {
  const sheet = workbook.addWorksheet(uniqueSheetName(workbook, name));
  const title = options.title || name;
  const rowData = Array.isArray(rows) && rows.length ? rows : [{
    section: 'Info',
    metric: 'No Data Available',
    value: '-'
  }];
  const [sectionWidth, metricWidth, valueWidth] = packMetricWidths(rowData);
  sheet.columns = [
    { key: 'section', width: sectionWidth },
    { key: 'metric', width: metricWidth },
    { key: 'value', width: valueWidth }
  ];
  sheet.mergeCells(1, 1, 1, 3);
  sheet.getCell(1, 1).value = title;
  sheet.getCell(1, 1).font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  sheet.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: options.titleFill || 'FF0F4C81' } };
  sheet.getCell(1, 1).alignment = { vertical: 'middle', horizontal: 'left' };
  const headerRow = sheet.getRow(2);
  headerRow.values = ['Section', 'Metric', 'Value'];
  styleHeaderRow(headerRow, options.headerFill || 'FF153A5B');
  headerRow.height = 22;
  rowData.forEach((row) => {
    const added = sheet.addRow({
      section: packText(row.section),
      metric: packText(row.metric),
      value: packText(row.value)
    });
    styleDataRow(added, sheet.columns, {});
  });
  sheet.views = [{ state: 'frozen', ySplit: 2 }];
  sheet.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: 3 } };
  addSheetFooter(sheet);
  sheet.pageSetup = { fitToPage: true, orientation: options.orientation || 'portrait' };
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

function buildSummaryStatusRows(reportData = {}, selectedReports = [], extras = {}, generatedBy = '', generatedAt = '', movementAnalysis = null, scanRegisterRowsData = []) {
  const summary = Array.isArray(reportData.summary) && reportData.summary.length ? reportData.summary[0] : {};
  const dealer = reportData.selectedDealer || {};
  const audit = reportData.selectedAudit || {};
  const finalRows = Array.isArray(reportData.finalRows) ? reportData.finalRows : [];
  const scans = Array.isArray(reportData.scans) ? reportData.scans : [];
  const registerCounts = countScanRegisterRows(scanRegisterRowsData);
  const totalQuantity = Number(summary.totalQuantity || summary.totalScans || finalRows.reduce((sum, row) => sum + Number(row.physicalQty || row.qty || 0), 0) || 0);
  const totalVariance = finalRows.reduce((sum, row) => sum + Number(row.varianceQty !== undefined ? row.varianceQty : row.differenceQty || row.variance || 0), 0);
  const totalExcess = countRows(finalRows, (row) => Number(row.excessQty || 0) > 0 || String(row.status || '').toLowerCase().includes('excess'));
  const totalShort = countRows(finalRows, (row) => Number(row.shortQty || 0) > 0 || String(row.status || '').toLowerCase().includes('short'));
  const damageCount = countRows(finalRows, (row) => Number(row.damageQty || 0) > 0);
  const uniqueUsers = new Set(scans.map((scan) => clean(scan.userName || scan.staffName || scan.loginId || scan.userId)).filter(Boolean)).size;
  const uniqueDevices = new Set(scans.map((scan) => clean(scan.deviceId || scan.deviceName)).filter(Boolean)).size;
  const movementSummary = movementAnalysis && movementAnalysis.summary ? movementAnalysis.summary : {};
  const labelText = selectedReportLabels(selectedReports).join(', ') || '-';
  const extraText = selectedExtraLabels(extras).join(', ') || '-';
  const categoryTotals = {
    hhml: countRows(finalRows, (row) => /hhml/i.test(String(row.productCategory || row.category || ''))),
    lubricant: countRows(finalRows, (row) => /lubricant|lube/i.test(String(row.productCategory || row.category || row.partDescription || row.partName || ''))),
    battery: countRows(finalRows, (row) => /battery/i.test(String(row.productCategory || row.category || row.partDescription || row.partName || ''))),
    oil: countRows(finalRows, (row) => /(^|\b)oil\b/i.test(String(row.productCategory || row.category || row.partDescription || row.partName || '')))
  };
  return [
    ...packMetricRows('Audit Details', [
      ['Dealer Name', dealer.dealerName || summary.dealerName || packText(summary.dealerCode || dealer.dealerCode || reportData.filters?.dealerCode)],
      ['Dealer Code', dealer.dealerCode || summary.dealerCode || reportData.filters?.dealerCode || '-'],
      ['Audit Start Date', packText(audit.auditStartDate || audit.auditDate || summary.fromDate || reportData.filters?.fromDate || reportData.filters?.from)],
      ['Audit End Date', packText(audit.auditClosedDate || audit.auditEndDate || summary.toDate || reportData.filters?.toDate || reportData.filters?.to)],
      ['Generated By', generatedBy],
      ['Generated Date Time', generatedAt],
      ['Selected Reports', labelText],
      ['Included Extras', extraText]
    ]),
    ...packMetricRows('Audit Totals', [
      ['Total Parts', packNumber(summary.totalMasterParts || finalRows.length || 0)],
      ['Total Scan Qty', packNumber(totalQuantity, 0)],
      ['Total Variance', packNumber(totalVariance, 2)],
      ['Total Excess', packNumber(totalExcess, 0)],
      ['Total Short', packNumber(totalShort, 0)],
      ['Damage Count', packNumber(damageCount, 0)],
      ['User Count', packNumber(uniqueUsers, 0)],
      ['Scan Device Count', packNumber(uniqueDevices, 0)],
      ['Sync Status', auditSyncStatus(registerCounts)]
    ]),
    ...packMetricRows('Category Totals', [
      ['HHML Parts Total', packNumber(categoryTotals.hhml, 0)],
      ['Lubricant Total', packNumber(categoryTotals.lubricant, 0)],
      ['Battery Total', packNumber(categoryTotals.battery, 0)],
      ['Oil Total', packNumber(categoryTotals.oil, 0)]
    ]),
    ...packMetricRows('Movement Totals', [
      ['Fast Moving', packNumber(movementSummary.fastMovingCount || movementSummary.fastMovingParts || 0, 0)],
      ['Slow Moving', packNumber(movementSummary.slowMovingCount || movementSummary.slowMovingParts || 0, 0)],
      ['Dead Stock', packNumber(movementSummary.deadStockCount || movementSummary.deadStockParts || 0, 0)],
      ['Critical Shortage', packNumber(movementSummary.criticalShortageCount || movementSummary.criticalShortageParts || 0, 0)]
    ])
  ];
}

function buildDashboardSummaryRows(reportData = {}, movementAnalysis = null, scanRegisterRowsData = []) {
  const summary = Array.isArray(reportData.summary) && reportData.summary.length ? reportData.summary[0] : {};
  const scans = Array.isArray(reportData.scans) ? reportData.scans : [];
  const registerCounts = countScanRegisterRows(scanRegisterRowsData);
  const movementSummary = movementAnalysis && movementAnalysis.summary ? movementAnalysis.summary : {};
  return [
    ...packMetricRows('Dashboard KPIs', [
      ['Total Parts', packNumber(summary.totalMasterParts || reportData.finalRows?.length || 0, 0)],
      ['Total Scans', packNumber(summary.totalScans || scans.length || 0, 0)],
      ['Total Quantity', packNumber(summary.totalQuantity || 0, 0)],
      ['Unique Parts', packNumber(summary.uniqueParts || 0, 0)],
      ['Visible Rows', packNumber(summary.visibleRows || reportData.finalRows?.length || 0, 0)],
      ['Pending Records', packNumber(registerCounts.pending || 0, 0)],
      ['Failed Records', packNumber(registerCounts.failed || 0, 0)],
      ['Duplicate Records', packNumber(registerCounts.duplicate || 0, 0)],
      ['Rejected Records', packNumber(registerCounts.rejected || 0, 0)],
      ['Deleted Records', packNumber(registerCounts.deleted || 0, 0)],
      ['Users', packNumber(new Set(scans.map((scan) => clean(scan.userName || scan.staffName || scan.loginId || scan.userId)).filter(Boolean)).size, 0)],
      ['Devices', packNumber(new Set(scans.map((scan) => clean(scan.deviceId || scan.deviceName)).filter(Boolean)).size, 0)]
    ]),
    ...packMetricRows('Movement Summary', [
      ['Fast Moving', packNumber(movementSummary.fastMovingCount || movementSummary.fastMovingParts || 0, 0)],
      ['Slow Moving', packNumber(movementSummary.slowMovingCount || movementSummary.slowMovingParts || 0, 0)],
      ['Dead Stock', packNumber(movementSummary.deadStockCount || movementSummary.deadStockParts || 0, 0)],
      ['Critical Shortage', packNumber(movementSummary.criticalShortageCount || movementSummary.criticalShortageParts || 0, 0)],
      ['Excess Stock', packNumber(movementSummary.excessStockCount || movementSummary.excessStockParts || 0, 0)]
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

function buildScanStatisticsRows(reportData = {}, scanRegisterRowsData = []) {
  const summary = Array.isArray(reportData.summary) && reportData.summary.length ? reportData.summary[0] : {};
  const registerCounts = countScanRegisterRows(scanRegisterRowsData);
  const scans = Array.isArray(reportData.scans) ? reportData.scans : [];
  const uniqueUsers = new Set(scans.map((scan) => clean(scan.userName || scan.staffName || scan.loginId || scan.userId)).filter(Boolean)).size;
  const uniqueDevices = new Set(scans.map((scan) => clean(scan.deviceId || scan.deviceName)).filter(Boolean)).size;
  return [
    ...packMetricRows('Scan Totals', [
      ['Total Scan Rows', packNumber(summary.totalScans || scans.length || 0, 0)],
      ['Total Quantity', packNumber(summary.totalQuantity || 0, 0)],
      ['Total Parts', packNumber(summary.totalMasterParts || reportData.finalRows?.length || 0, 0)],
      ['Unique Parts', packNumber(summary.uniqueParts || 0, 0)],
      ['Visible Rows', packNumber(summary.visibleRows || reportData.finalRows?.length || 0, 0)],
      ['Unknown Parts', packNumber(summary.unknownPartsCount || 0, 0)],
      ['Merged Duplicate Scan Rows', packNumber(summary.mergedDuplicateScanRows || 0, 0)]
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
      ['Unique Users', packNumber(uniqueUsers, 0)],
      ['Unique Devices', packNumber(uniqueDevices, 0)],
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

function buildCategoryVarianceRows(data = {}) {
  const rows = Array.isArray(data.rows) ? data.rows.slice() : [];
  return rows.concat([{
    productCategory: 'Grand Total',
    action: '',
    totalScannedParts: Number(data.grandTotal?.totalScannedParts || 0),
    totalScannedQuantity: Number(data.grandTotal?.totalScannedQuantity || 0),
    sumPhysicalValueOnMRP: Number(data.grandTotal?.sumPhysicalValueOnMRP || 0),
    sumPhysicalValueOnDLC: Number(data.grandTotal?.sumPhysicalValueOnDLC || 0),
    sumDmsValueOnMRP: Number(data.grandTotal?.sumDmsValueOnMRP || 0),
    sumDmsValueOnDLC: Number(data.grandTotal?.sumDmsValueOnDLC || 0),
    sumVarianceOnMRP: Number(data.grandTotal?.sumVarianceOnMRP || 0),
    sumVarianceOnDLC: Number(data.grandTotal?.sumVarianceOnDLC || 0),
    rowType: 'grandTotal'
  }]);
}

function buildReconciliationSummaryRows(report = {}) {
  const summary = report.summary || {};
  return packMetricRows('Reconciliation', [
    ['Dealer Code', summary.dealerCode || report.scope?.dealerCode || '-'],
    ['Audit ID', summary.auditId || report.scope?.auditId || '-'],
    ['Total Parts Uploaded', summary.totalPartsUploaded || 0],
    ['Total DMS Stock Qty', summary.totalDmsStockQty || 0],
    ['Total Actual Scanned Qty', summary.totalActualScannedQty || 0],
    ['Total Matched Parts', summary.totalMatchedParts || 0],
    ['Total Shortage Parts', summary.totalShortageParts || 0],
    ['Total Excess Parts', summary.totalExcessParts || 0],
    ['Total Fast Moving Parts', summary.totalFastMovingParts || 0],
    ['Total Slow Moving Parts', summary.totalSlowMovingParts || 0],
    ['Total Dead Stock Parts', summary.totalDeadStockParts || 0],
    ['Total Inventory Value', packCurrency(summary.totalInventoryValue || 0)],
    ['Actual Stock Value (DLC)', packCurrency(summary.actualStockValueDLC || 0)],
    ['DMS Stock Value (DLC)', packCurrency(summary.dmsStockValueDLC || 0)],
    ['Total Shortage Value', packCurrency(summary.totalShortageValue || 0)],
    ['Total Excess Value', packCurrency(summary.totalExcessValue || 0)],
    ['Scanned But Not In DMS', summary.totalScannedButNotInDms || 0],
    ['Net Difference', summary.netDifference || 0],
    ['Mismatch Count', summary.mismatchCount || 0]
  ]);
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
  const resolvedQuery = resolvedAuditId && resolvedAuditId !== normalized.auditId
    ? { ...normalized, auditId: resolvedAuditId }
    : normalized;
  if (resolvedQuery.auditId !== normalized.auditId || !reportData.selectedAudit) {
    reportData = await reportModule.buildReportData(resolvedQuery);
  }

  const [scanRegisterRowsData, movementAnalysisData] = await Promise.all([
    scanRegisterRows(resolvedQuery),
    reconciliationRoute.buildMovementAnalysisReport(resolvedQuery)
  ]);
  const selectedDealer = reportData.selectedDealer || {};
  const selectedAudit = reportData.selectedAudit || (resolvedQuery.auditId && Array.isArray(reportData.audits) ? reportData.audits.find((audit) => clean(audit.auditId) === clean(resolvedQuery.auditId)) : null) || null;
  const generatedBy = clean(user.name || user.username || user.email || user.id || 'System');
  const generatedAt = formatIstDateTime(new Date());
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
    scanRegisterRowsData
  ), {
    title: 'AUDIT SUMMARY',
    orientation: 'portrait'
  });

  if (normalized.includeDashboardSummary) {
    addMetricSheet(workbook, 'Dashboard Summary', buildDashboardSummaryRows(reportData, movementAnalysisData, scanRegisterRowsData), {
      title: 'DASHBOARD SUMMARY',
      orientation: 'portrait'
    });
  }

  if (normalized.includeAuditInformation) {
    addMetricSheet(workbook, 'Audit Information', buildAuditInformationRows(resolvedQuery, reportData), {
      title: 'AUDIT INFORMATION',
      orientation: 'portrait'
    });
  }

  if (normalized.includeDealerInformation) {
    addMetricSheet(workbook, 'Dealer Information', buildDealerInformationRows(reportData), {
      title: 'DEALER INFORMATION',
      orientation: 'portrait'
    });
  }

  if (normalized.includeScanStatistics) {
    addMetricSheet(workbook, 'Scan Statistics', buildScanStatisticsRows(reportData, scanRegisterRowsData), {
      title: 'SCAN STATISTICS',
      orientation: 'portrait'
    });
  }

  if (normalized.includePendingOfflineScanDetails) {
    addTableSheet(workbook, 'Pending Offline Scans', SCAN_REGISTER_COLUMNS, buildPendingOfflineRows(scanRegisterRowsData), {
      emptyMessage: 'No Data Available'
    });
  }

  if (normalized.includeUserWiseSummary) {
    addTableSheet(workbook, 'User Wise Summary', USER_WISE_SUMMARY_COLUMNS, buildUserWiseSummaryRows(reportData), {
      emptyMessage: 'No Data Available'
    });
  }

  const packBuildMap = {
    'bin-wise-stock': async () => ({
      title: 'BIN WISE STOCK REPORT',
      kind: 'table',
      columns: BIN_COLUMNS,
      rows: selectRows(reportData, 'bin-wise-stock')
    }),
    'user-dealer-wise': async () => ({
      title: 'USER & DEALER WISE REPORT',
      kind: 'table',
      columns: USER_DEALER_COLUMNS,
      rows: selectRows(reportData, 'user-dealer-wise')
    }),
    'raw-upi': async () => ({
      title: 'RAW UPI REPORT',
      kind: 'table',
      columns: RAW_UPI_COLUMNS,
      rows: Array.isArray(reportData.rawLogRows) ? reportData.rawLogRows : []
    }),
    'scan-register': async () => ({
      title: 'SCAN REGISTER REPORT',
      kind: 'table',
      columns: SCAN_REGISTER_COLUMNS,
      rows: scanRegisterRowsData
    }),
    'invalid-scan-report': async () => ({
      title: 'INVALID SCAN REPORT',
      kind: 'table',
      columns: INVALID_SCAN_COLUMNS,
      rows: await rejectedReportRows(resolvedQuery)
    }),
    'stock-summary': async () => {
      const stockSummary = await reportModule.buildStockSummaryReport(resolvedQuery);
      return {
        title: 'STOCK SUMMARY',
        kind: 'table',
        columns: stockSummary.columns || [],
        rows: stockSummary.rows || []
      };
    },
    short: async () => {
      const partwise = await reportModule.buildPartwiseInventoryAuditReport(resolvedQuery);
      return {
        title: 'SHORT REPORT',
        kind: 'table',
        columns: partwise.columns || [],
        rows: (partwise.rows || []).filter((row) => String(row.status || '').toLowerCase() === 'short')
      };
    },
    excess: async () => {
      const partwise = await reportModule.buildPartwiseInventoryAuditReport(resolvedQuery);
      return {
        title: 'EXCESS REPORT',
        kind: 'table',
        columns: partwise.columns || [],
        rows: (partwise.rows || []).filter((row) => ['excess', 'extra part'].includes(String(row.status || '').toLowerCase()))
      };
    },
    movement_wise_stock_analysis: async () => ({
      title: 'MOVEMENT WISE STOCK ANALYSIS',
      kind: 'table',
      columns: movementAnalysisData.columns || [],
      rows: movementAnalysisData.rows || []
    }),
    damage: async () => {
      const partwise = await reportModule.buildPartwiseInventoryAuditReport(resolvedQuery);
      return {
        title: 'DAMAGE REPORT',
        kind: 'table',
        columns: partwise.columns || [],
        rows: (partwise.rows || []).filter((row) => Number(row.damageQty || 0) > 0)
      };
    },
    'category-wise-variance-summary': async () => {
      const category = await reportModule.buildCategoryWiseVarianceSummary(resolvedQuery);
      return {
        title: 'CATEGORY WISE VARIANCE SUMMARY',
        kind: 'table',
        columns: CATEGORY_VARIANCE_COLUMNS,
        rows: buildCategoryVarianceRows(category)
      };
    },
    'partwise-inventory-audit': async () => {
      const partwise = await reportModule.buildPartwiseInventoryAuditReport(resolvedQuery);
      return {
        title: 'PARTWISE INVENTORY AUDIT REPORT',
        kind: 'table',
        columns: partwise.columns || [],
        rows: partwise.rows || []
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
        })
      };
    },
    'reconciliation-report': async () => ({
      title: 'RECONCILIATION REPORT',
      kind: 'metrics',
      rows: buildReconciliationSummaryRows(await reconciliationRoute.buildReconciliationReport(resolvedQuery))
    }),
    'dealer-reconciliation-report': async () => {
      const reconciliation = await reconciliationRoute.buildReconciliationReport(resolvedQuery);
      return {
        title: 'DEALER RECONCILIATION REPORT',
        kind: 'table',
        columns: RECONCILIATION_COLUMNS,
        rows: reconciliation.rows || []
      };
    },
    'dead-stock-report': async () => ({
      title: 'DEAD STOCK REPORT',
      kind: 'table',
      columns: movementAnalysisData.columns || [],
      rows: (movementAnalysisData.sections && movementAnalysisData.sections.deadStock) || []
    }),
    'fast-moving-report': async () => ({
      title: 'FAST MOVING REPORT',
      kind: 'table',
      columns: movementAnalysisData.columns || [],
      rows: (movementAnalysisData.sections && movementAnalysisData.sections.fastMoving) || []
    }),
    'slow-moving-report': async () => ({
      title: 'SLOW MOVING REPORT',
      kind: 'table',
      columns: movementAnalysisData.columns || [],
      rows: (movementAnalysisData.sections && movementAnalysisData.sections.slowMoving) || []
    }),
    'critical-shortage-report': async () => ({
      title: 'CRITICAL SHORTAGE REPORT',
      kind: 'table',
      columns: movementAnalysisData.columns || [],
      rows: (movementAnalysisData.sections && movementAnalysisData.sections.criticalShortage) || []
    })
  };

  const selectedSpecs = [];
  for (const reportKey of normalized.reports) {
    const builder = packBuildMap[reportKey];
    if (!builder) continue;
    try {
      selectedSpecs.push(await builder());
    } catch (error) {
      selectedSpecs.push({
        title: reportLabelForKey(reportKey).toUpperCase(),
        kind: 'metrics',
        rows: packMetricRows('Error', [['Message', error.message]])
      });
    }
  }

  selectedSpecs.forEach((spec) => {
    if (!spec) return;
    if (spec.kind === 'metrics') {
      addMetricSheet(workbook, spec.title, spec.rows || [], { title: spec.title });
      return;
    }
    addTableSheet(workbook, spec.title, spec.columns || [], spec.rows || [], {
      emptyMessage: spec.emptyMessage || 'No Data Available'
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

async function sendExcel(res, title, rows, type, query = {}) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(title.slice(0, 31));
  const columns = selectedColumns(columnsForReport(type, rows), query);
  sheet.columns = columns.length ? columns : [{ header: 'Message', key: 'message', width: 30 }];
  (rows.length ? rows : [{ message: 'No data found' }]).forEach((row) => sheet.addRow(formatDateLikeFields(row)));
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF153A5B' } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${title.replace(/[^a-z0-9]/gi, '_')}.xlsx"`);
  res.send(Buffer.from(buffer));
}

async function buildExcelBuffer(title, rows, type, query = {}) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(title.slice(0, 31));
  const columns = selectedColumns(columnsForReport(type, rows), query);
  sheet.columns = columns.length ? columns : [{ header: 'Message', key: 'message', width: 30 }];
  (rows.length ? rows : [{ message: 'No data found' }]).forEach((row) => sheet.addRow(formatDateLikeFields(row)));
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF153A5B' } };
  sheet.eachRow((row) => row.eachCell((cell) => {
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' }
    };
  }));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function sendPdf(res, title, rows, type, query = {}) {
  const doc = new jsPDF({ orientation: 'landscape' });
  const columns = selectedColumns(columnsForReport(type, rows), query).slice(0, 12);
  const bodyRows = (rows.length ? rows : [{ message: 'No data found' }]).slice(0, 200);
  doc.setFontSize(14);
  doc.text(`DAKSH INVENTORY SYSTEM - ${title}`, 14, 15);
  autoTable(doc, {
    startY: 24,
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
  doc.setFontSize(14);
  doc.text(`DAKSH INVENTORY SYSTEM - ${title}`, 24, 24);
  autoTable(doc, {
    startY: 38,
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
