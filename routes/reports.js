const ExcelJS = require('exceljs');
const { jsPDF } = require('jspdf');
const autoTableModule = require('jspdf-autotable');
const nodemailer = require('nodemailer');
const router = require('./report');
const reportModule = require('./report');
const auth = require('./auth');
const DuplicateScanLog = require('../models/DuplicateScanLog');
const RejectedScan = require('../models/RejectedScan');
const Inventory = require('../models/Inventory');
const MasterPart = require('../models/MasterPart');
const MasterCatalogue = require('../models/MasterCatalogue');
const PartPriceHistory = require('../models/PartPriceHistory');
const InventoryMovementSummary = require('../models/InventoryMovementSummary');
const { formatDateLikeFields } = require('../utils/time');
const { scanValueRow, summarizeMovementBucket } = require('../utils/inventoryValueEngine');
const { normalizePartNumber } = require('../utils/normalize');
const { cataloguePayload } = require('../utils/catalogue');
const { rebuildMovementSummaries } = require('../services/inventoryMovementSummary');

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
  const text = clean(value);
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

function duplicateReportFilter(query = {}) {
  const filter = {};
  if (query.dealerCode) filter.dealerCode = upper(query.dealerCode);
  if (query.auditId) filter.auditId = clean(query.auditId);
  if (query.partNumber) filter.partNumber = { $regex: clean(query.partNumber), $options: 'i' };
  if (query.scanType) filter.scanType = upper(query.scanType);
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
  return rows.map((row) => ({
    time: row.timestamp || row.createdAt,
    dealerCode: row.dealerCode || '',
    dealerName: row.dealerName || '',
    duplicateRawBarcodeUpi: row.rawBarcode || row.rawQR || row.rawUpi || row.rawScan || '',
    partNumber: row.partNumber || '',
    scanType: row.scanType || '',
    binLocation: row.binLocation || '',
    deviceId: row.deviceId || '',
    deviceName: row.deviceName || '',
    userId: row.userId || row.loginId || '',
    userName: row.userName || row.duplicateScannedBy || '',
    firstScannedBy: row.firstScannedBy || '',
    firstScanTime: row.firstScanTime || '',
    firstDevice: row.firstDeviceName || row.firstDeviceId || '',
    firstBin: row.firstBin || '',
    duplicateScannedBy: row.duplicateScannedBy || row.userName || '',
    duplicateScanTime: row.duplicateScanTime || row.timestamp || row.createdAt,
    duplicateDevice: row.duplicateDeviceName || row.duplicateDeviceId || row.deviceName || row.deviceId || '',
    duplicateDeviceName: row.duplicateDeviceName || '',
    duplicateDeviceId: row.duplicateDeviceId || '',
    duplicateBin: row.duplicateBin || row.binLocation || '',
    existingScanId: row.existingScanId || '',
    reason: row.reason || 'Duplicate QR/UPI',
    rawScan: row.rawScan || ''
  }));
}

function rejectedReportFilter(query = {}) {
  const filter = {};
  if (query.dealerCode) filter.dealerCode = upper(query.dealerCode);
  if (query.partNumber) filter.extractedPartNumber = { $regex: clean(query.partNumber), $options: 'i' };
  if (query.scanType) filter.scanType = upper(query.scanType);
  if (query.bin) filter.binLocation = { $regex: clean(query.bin), $options: 'i' };
  if (query.dealerName) filter.dealerName = regex(query.dealerName);
  applyCommonMetadataFilters(filter, query, { rawFields: ['rawScannedValue', 'rawUpi', 'rawQR', 'rawScan'] });
  if (query.fromDate || query.dateFrom || query.from || query.toDate || query.dateTo || query.to) {
    filter.dateTime = {};
    const from = parseFilterDate(query.fromDate || query.dateFrom || query.from || '');
    const to = parseFilterDate(query.toDate || query.dateTo || query.to || '', true);
    if (from && !Number.isNaN(from.getTime())) filter.dateTime.$gte = from;
    if (to && !Number.isNaN(to.getTime())) filter.dateTime.$lte = to;
  }
  return filter;
}

async function rejectedReportRows(query = {}) {
  const rows = await RejectedScan.find(rejectedReportFilter(query)).sort({ dateTime: -1, createdAt: -1 }).limit(5000).lean();
  return rows.map((row) => ({
    dealerCode: row.dealerCode || '',
    dealerName: row.dealerName || '',
    scanTime: row.dateTime || row.createdAt,
    partNumber: row.extractedPartNumber || row.partNumber || '',
    rawQrUpi: row.rawScannedValue || row.rawUpi || row.rawQR || row.rawScan || '',
    reason: 'Part not found in master',
    userName: row.userName || row.loginId || '',
    deviceName: row.deviceName || '',
    deviceId: row.deviceId || '',
    binLocation: row.binLocation || '',
    entryMode: row.scanMode || '',
    scanType: row.scanType || '',
    syncStatus: row.syncStatus || 'rejected'
  }));
}

const REJECTED_COLUMNS = [
  { header: 'DEALER CODE', key: 'dealerCode', width: 16 },
  { header: 'DEALER NAME', key: 'dealerName', width: 28 },
  { header: 'SCAN TIME', key: 'scanTime', width: 22 },
  { header: 'PART NUMBER', key: 'partNumber', width: 18 },
  { header: 'RAW QR / UPI', key: 'rawQrUpi', width: 42 },
  { header: 'REASON', key: 'reason', width: 28 },
  { header: 'USER NAME', key: 'userName', width: 22 },
  { header: 'DEVICE NAME', key: 'deviceName', width: 24 },
  { header: 'SCAN TYPE', key: 'scanType', width: 16 },
  { header: 'SYNC STATUS', key: 'syncStatus', width: 16 }
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
  { header: 'FINAL INVENTORY VALUE', key: 'finalInventoryValue', width: 22 },
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

const MOVEMENT_VALUE_COLUMNS = [
  { header: 'Part Number', key: 'partNumber', width: 18 },
  { header: 'Part Description', key: 'partDescription', width: 34 },
  { header: 'Product Category', key: 'productCategory', width: 22 },
  { header: 'Product Group', key: 'productGroup', width: 20 },
  { header: 'Scan Qty', key: 'scanQty', width: 14 },
  { header: 'Manual Qty', key: 'manualQty', width: 14 },
  { header: 'Scan UPI MRP', key: 'scanUPIMRP', width: 18 },
  { header: 'Manual MRP', key: 'manualMRP', width: 14 },
  { header: 'Current Catalogue MRP', key: 'currentCatalogueMRP', width: 22 },
  { header: 'Average Scanned MRP', key: 'averageScannedMRP', width: 22 },
  { header: 'Min Scanned MRP', key: 'minScannedMRP', width: 18 },
  { header: 'Max Scanned MRP', key: 'maxScannedMRP', width: 18 },
  { header: 'Price Period From', key: 'pricePeriodFrom', width: 20 },
  { header: 'Price Period To', key: 'pricePeriodTo', width: 20 },
  { header: 'Price Ageing Days', key: 'priceAgeingDays', width: 18 },
  { header: 'Final Inventory Value', key: 'finalInventoryValue', width: 22 },
  { header: 'Remarks', key: 'remarks', width: 36 }
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
  { header: 'TOTAL MRP VALUE', key: 'totalMrpValue', width: 18 },
  { header: 'TOTAL DLC VALUE', key: 'totalDlcValue', width: 18 },
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
  { header: 'DUPLICATE TIME', key: 'duplicateScanTime', width: 22 },
  { header: 'DUPLICATE RAW QR / UPI', key: 'duplicateRawBarcodeUpi', width: 34 },
  { header: 'PART NUMBER', key: 'partNumber', width: 18 },
  { header: 'FIRST SCANNED BY', key: 'firstScannedBy', width: 22 },
  { header: 'FIRST SCAN TIME', key: 'firstScanTime', width: 22 },
  { header: 'FIRST DEVICE', key: 'firstDevice', width: 24 },
  { header: 'FIRST BIN', key: 'firstBin', width: 16 },
  { header: 'DUPLICATE SCANNED BY', key: 'duplicateScannedBy', width: 24 },
  { header: 'DUPLICATE DEVICE', key: 'duplicateDevice', width: 24 },
  { header: 'DUPLICATE BIN', key: 'duplicateBin', width: 16 },
  { header: 'SCAN TYPE', key: 'scanType', width: 16 },
  { header: 'DEALER CODE', key: 'dealerCode', width: 16 },
  { header: 'REASON', key: 'reason', width: 24 }
];

function auditRow(row) {
  return {
    partNumber: row.partNumber || row.partNo,
    partDescription: row.partDescription || row.partName,
    model: row.model,
    manufacturingYear: row.manufacturingYear || row.year,
    category: row.productCategory || row.category,
    productCategory: row.productCategory || row.category,
    bin: row.binLocation || row.bin,
    mrp: row.mrp,
    scanUPIMRP: row.scanUPIMRP || '',
    currentCatalogueMRP: row.currentCatalogueMRP || 0,
    averageScannedMRP: row.averageScannedMRP || 0,
    pricePeriod: row.pricePeriod || '',
    priceAgeingDays: row.priceAgeingDays || 0,
    partMovement: row.partMovement || '',
    finalInventoryValue: row.finalInventoryValue || row.physicalMrpValue || 0,
    dlc: row.dlc,
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
  const physicalQty = Number(scan.qty || scan.quantity || 0);
  const isFitted = (scan.scanType || scan.type) === 'FITTED' || scan.isFitted;
  const physicalBinQty = isFitted ? 0 : physicalQty;
  const fittedQty = isFitted ? Math.abs(physicalQty) : 0;
  return {
    partNumber: scan.partNumber || scan.part,
    partDescription: scan.partDescription || scan.partName,
    model: scan.model,
    manufacturingYear: scan.manufacturingYear || scan.year,
    category: scan.productCategory || scan.category,
    productCategory: scan.productCategory || scan.category,
    bin: isFitted ? 'FITTED - VEHICLE' : (scan.binLocation || scan.bin),
    mrp: scan.mrp,
    dlc: scan.dlc,
    productGroup: scan.productGroup,
    partSubGroup: scan.partSubGroup,
    dmsQty: scan.dmsQty || 0,
    physicalQty,
    physicalBinQty,
    actualAuditQty: physicalBinQty + fittedQty,
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
    quantity: Number(scan.qty || scan.quantity || 0),
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
  return {
    scanTime: scan.timestamp,
    scanStatus: status,
    scanType: scan.scanType || scan.type || '',
    dealerCode: scan.dealerCode || '',
    dealerName: scan.dealerName || '',
    partNumber: scan.partNumber || scan.part || '',
    partDescription: scan.partDescription || scan.partName || '',
    quantity: Number(scan.qty || scan.quantity || 0),
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
    scanTime: row.duplicateScanTime || row.time,
    scanStatus: 'Duplicate',
    scanType: row.scanType || '',
    dealerCode: row.dealerCode || '',
    dealerName: row.dealerName || '',
    partNumber: row.partNumber || '',
    partDescription: row.partDescription || '',
    quantity: 0,
    binLocation: row.duplicateBin || row.binLocation || '',
    fittedStatus: 'Not Fitted',
    rawQrUpi: row.duplicateRawBarcodeUpi || row.rawScan || '',
    userName: row.duplicateScannedBy || row.userName || row.userId || '',
    deviceName: row.duplicateDeviceName || row.deviceName || row.duplicateDevice || '',
    deviceId: row.duplicateDeviceId || row.deviceId || row.duplicateDevice || '',
    entryMode: registerEntryMode(row),
    syncStatus: 'duplicate',
    duplicateStatus: 'Duplicate',
    remarks: row.reason || 'Duplicate QR/UPI'
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
    binLocation: row.binLocation || '',
    fittedStatus: 'Not Fitted',
    rawQrUpi: row.rawQrUpi || '',
    userName: row.userName || '',
    deviceName: row.deviceName || '',
    deviceId: row.deviceId || '',
    entryMode: registerEntryMode({ ...row, source: row.entryMode || 'manual' }),
    syncStatus: row.syncStatus || 'rejected',
    duplicateStatus: 'No',
    remarks: row.reason || 'Part not found in master'
  };
}

function stripRegisterOnlyFilters(query = {}) {
  const copy = { ...query };
  delete copy.scanStatus;
  delete copy.syncStatus;
  return copy;
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
  const sourceQuery = stripRegisterOnlyFilters(query);
  const data = await reportModule.buildReportData(sourceQuery);
  const [duplicates, rejected] = await Promise.all([
    duplicateReportRows(sourceQuery),
    rejectedReportRows(sourceQuery)
  ]);
  return [
    ...data.scans.map(scanRegisterInventoryRow),
    ...duplicates.map(scanRegisterDuplicateRow),
    ...rejected.map(scanRegisterRejectedRow)
  ]
    .filter((row) => registerFilterMatch(row, query))
    .sort((a, b) => new Date(b.scanTime || 0) - new Date(a.scanTime || 0));
}

function scanTypeQtyBucket(scan) {
  const type = String(scan.scanType || scan.type || '').toUpperCase();
  if (type === 'AUDIT' || type === 'VERIFICATION') return 'auditQty';
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
  return Math.abs(Number(scan.qty !== undefined ? scan.qty : scan.quantity || 0));
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
      target.totalDlcValue = money(target.totalDlcValue + qty * Number(scan.dlc || 0));
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

function movementDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function movementDateText(value) {
  const date = movementDate(value);
  return date ? date.toISOString().slice(0, 10) : '';
}

function masterPartNumber(row = {}) {
  return normalizePartNumber(row.normalizedPartNumber || row.partNumber || row.partNo || row.part || '');
}

function movementScanFilter(query = {}) {
  const filter = {
    syncStatus: { $nin: ['duplicate', 'rejected', 'failed', 'deleted'] },
    isDuplicate: { $ne: true }
  };
  if (query.dealerCode) filter.dealerCode = upper(query.dealerCode);
  if (query.auditId) filter.auditId = clean(query.auditId);
  if (query.partNumber) {
    const part = normalizePartNumber(query.partNumber);
    appendAnd(filter, { $or: [
      { normalizedPartNumber: regex(part) },
      { partNumber: regex(part) },
      { part: regex(part) }
    ] });
  }
  if (query.scanType || query.type) filter.scanType = upper(query.scanType || query.type);
  if (query.syncStatus) filter.syncStatus = clean(query.syncStatus).toLowerCase();
  if (query.scanStatus) filter.scanStatus = upper(query.scanStatus);
  if (query.bin || query.binLocation) appendAnd(filter, { $or: [{ binLocation: regex(query.bin || query.binLocation) }, { bin: regex(query.bin || query.binLocation) }] });
  applyCommonMetadataFilters(filter, query);
  if (query.fromDate || query.dateFrom || query.from || query.toDate || query.dateTo || query.to) {
    filter.timestamp = {};
    const from = parseFilterDate(query.fromDate || query.dateFrom || query.from || '');
    const to = parseFilterDate(query.toDate || query.dateTo || query.to || '', true);
    if (from) filter.timestamp.$gte = from;
    if (to) filter.timestamp.$lte = to;
  }
  return filter;
}

function valueRowWithManualFallback(scan = {}, catalogue = {}) {
  const row = scanValueRow(scan);
  const sourceText = [
    scan.valuationSource,
    scan.source,
    scan.scanSource,
    scan.scanMode,
    scan.entryMode
  ].map((value) => clean(value).toLowerCase()).join(' ');
  const manual = /\bmanual\b/.test(sourceText);
  const catalogueMrp = Number(catalogue.mrp || catalogue.currentCatalogueMRP || catalogue.currentCatalogueMrp || 0);
  if (manual && row.valuationMRP <= 0 && catalogueMrp > 0) {
    const qty = Number(row.qty || 0);
    return {
      ...row,
      mrp: money(catalogueMrp),
      valuationMRP: money(catalogueMrp),
      valuationSource: 'MANUAL_ENTERED_MRP',
      manualQty: qty,
      scannedQty: 0,
      totalManualValue: money(qty * catalogueMrp),
      totalScanValue: 0,
      finalInventoryValue: money(qty * catalogueMrp)
    };
  }
  return row;
}

function priceHistoryMatch(priceRows = [], mrp = 0) {
  const amount = Number(mrp || 0);
  if (amount <= 0) return null;
  return priceRows.find((row) => Math.abs(Number(row.mrp || 0) - amount) <= 0.01) || null;
}

function averageMasterMRP(catalogue = {}, priceRows = []) {
  const values = [];
  const catalogueMrp = Number(catalogue.mrp || catalogue.currentCatalogueMRP || catalogue.currentCatalogueMrp || 0);
  if (catalogueMrp > 0) values.push(catalogueMrp);
  priceRows.forEach((row) => {
    const mrp = Number(row && row.mrp || 0);
    if (mrp > 0) values.push(mrp);
  });
  const uniqueValues = Array.from(new Set(values.map((value) => Number(value).toFixed(2)))).map(Number);
  return uniqueValues.length
    ? uniqueValues.reduce((sum, value) => sum + value, 0) / uniqueValues.length
    : 0;
}

function mergeCachedSummary(current = {}, cached = {}) {
  return {
    ...current,
    remainingQty: Number(cached.remainingQty ?? current.remainingQty ?? 0),
    priceAgeingDays: Number(cached.priceAgeingDays || cached.ageingDays || current.priceAgeingDays || current.ageingDays || 0)
  };
}

async function movementValueRowsFromScans(scans = [], query = {}) {
  const groups = new Map();
  const partNumbers = Array.from(new Set(scans.map((scan) => normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part)).filter(Boolean)));
  const [catalogueRows, legacyRows, priceRows, cachedRows] = partNumbers.length ? await Promise.all([
    MasterCatalogue.find({ normalizedPartNumber: { $in: partNumbers } }).lean(),
    MasterPart.find({ $or: [{ normalizedPartNumber: { $in: partNumbers } }, { partNo: { $in: partNumbers } }, { partNumber: { $in: partNumbers } }] }).lean(),
    PartPriceHistory.find({ normalizedPartNumber: { $in: partNumbers } }).sort({ normalizedPartNumber: 1, effectiveFrom: -1 }).lean(),
    InventoryMovementSummary.find({
      normalizedPartNumber: { $in: partNumbers },
      ...(query.dealerCode ? { dealerCode: upper(query.dealerCode) } : {}),
      ...(query.auditId ? { auditId: clean(query.auditId) } : {})
    }).lean()
  ]) : [[], [], [], []];
  const catalogueByPart = new Map(catalogueRows.map((row) => [masterPartNumber(row), cataloguePayload(row)]).filter(([part]) => part));
  legacyRows.forEach((row) => {
    const part = masterPartNumber(row);
    if (part && !catalogueByPart.has(part)) catalogueByPart.set(part, row);
  });
  const priceByPart = new Map();
  priceRows.forEach((row) => {
    const part = masterPartNumber(row);
    if (!part) return;
    const list = priceByPart.get(part) || [];
    list.push(row);
    priceByPart.set(part, list);
  });
  const cacheByBucket = new Map();
  cachedRows.forEach((row) => {
    const key = [upper(row.dealerCode), clean(row.auditId), masterPartNumber(row), Number(row.mrp || 0).toFixed(2)].join('::');
    cacheByBucket.set(key, row);
  });

  scans.forEach((scan) => {
    const partNumber = upper(scan.normalizedPartNumber || scan.partNumber || scan.part);
    if (!partNumber) return;
    const catalogue = catalogueByPart.get(partNumber) || {};
    const valueRow = valueRowWithManualFallback(scan, catalogue);
    const scanUpiMrp = valueRow.valuationSource === 'UPI_SCANNED_MRP' ? Number(valueRow.valuationMRP || 0) : 0;
    const manualMrp = valueRow.valuationSource === 'MANUAL_ENTERED_MRP' ? Number(valueRow.valuationMRP || 0) : 0;
    const bucketMrp = scanUpiMrp || manualMrp || 0;
    const key = [upper(scan.dealerCode), clean(scan.auditId), partNumber, Number(scanUpiMrp || 0).toFixed(2), Number(manualMrp || 0).toFixed(2)].join('::');
    const group = groups.get(key) || {
      dealerCode: upper(scan.dealerCode),
      auditId: clean(scan.auditId),
      partNumber,
      scanUPIMRP: scanUpiMrp,
      manualMRP: manualMrp,
      scans: [],
      valueRows: []
    };
    group.scans.push(scan);
    group.valueRows.push(valueRow);
    if (!group.scanUPIMRP && scanUpiMrp) group.scanUPIMRP = scanUpiMrp;
    if (!group.manualMRP && manualMrp) group.manualMRP = manualMrp;
    group.bucketMrp = bucketMrp;
    groups.set(key, group);
  });

  return Array.from(groups.values()).map((group) => {
    const rows = group.scans;
    const first = rows[0] || {};
    const partNumber = group.partNumber;
    const catalogue = catalogueByPart.get(partNumber) || {};
    const hasMaster = Boolean(masterPartNumber(catalogue));
    const valueRows = group.valueRows;
    const scanQty = valueRows.reduce((sum, row) => sum + Number(row.scannedQty || 0), 0);
    const manualQty = valueRows.reduce((sum, row) => sum + Number(row.manualQty || 0), 0);
    const scannedMrps = valueRows.filter((row) => row.valuationSource === 'UPI_SCANNED_MRP' && Number(row.valuationMRP || 0) > 0);
    const manualMrps = valueRows.filter((row) => row.valuationSource === 'MANUAL_ENTERED_MRP' && Number(row.valuationMRP || 0) > 0);
    const finalInventoryValue = money(valueRows.reduce((sum, row) => sum + Number(row.finalInventoryValue || 0), 0));
    const averageScannedMRP = scannedMrps.length
      ? money(scannedMrps.reduce((sum, row) => sum + Number(row.valuationMRP || 0) * Number(row.qty || 0), 0) / Math.max(1, scannedMrps.reduce((sum, row) => sum + Number(row.qty || 0), 0)))
      : 0;
    const minScannedMRP = scannedMrps.length ? Math.min(...scannedMrps.map((row) => Number(row.valuationMRP || 0))) : 0;
    const maxScannedMRP = scannedMrps.length ? Math.max(...scannedMrps.map((row) => Number(row.valuationMRP || 0))) : 0;
    const masterAverageMRP = averageMasterMRP(catalogue, priceByPart.get(partNumber) || []);
    const fallbackSummary = summarizeMovementBucket(rows, {
      masterAverageMRP,
      currentCatalogueMRP: Number(catalogue.mrp || 0)
    });
    const cacheKey = [upper(first.dealerCode), clean(first.auditId), partNumber, Number(group.scanUPIMRP || group.manualMRP || 0).toFixed(2)].join('::');
    const cached = cacheByBucket.get(cacheKey);
    const summary = mergeCachedSummary(fallbackSummary, cached || {});
    const priceMatch = group.scanUPIMRP ? priceHistoryMatch(priceByPart.get(partNumber) || [], group.scanUPIMRP) : null;
    const priceFound = !group.scanUPIMRP || Boolean(priceMatch);
    const priceAgeingDays = priceMatch && priceMatch.effectiveFrom
      ? Math.max(0, Math.floor((Date.now() - new Date(priceMatch.effectiveFrom).getTime()) / 86400000))
      : Number(summary.priceAgeingDays || summary.ageingDays || 0);
    const remarks = [];
    if (!hasMaster) remarks.push('UNKNOWN / NOT FOUND IN MASTER');
    if (group.scanUPIMRP && !priceMatch) remarks.push('MRP NOT FOUND IN MASTER');
    if (!cached) remarks.push('Calculated from scan data');
    return {
      partNumber,
      partDescription: catalogue.partDescription || first.partDescription || first.partName || 'UNKNOWN / NOT FOUND IN MASTER',
      productCategory: catalogue.productCategory || first.productCategory || first.category || 'UNKNOWN',
      productGroup: catalogue.productGroup || first.productGroup || first.partGroup || 'UNKNOWN',
      scanQty,
      manualQty,
      scanUPIMRP: group.scanUPIMRP || 0,
      manualMRP: manualMrps.length ? Array.from(new Set(manualMrps.map((row) => Number(row.valuationMRP || 0).toFixed(2)))).join(', ') : '',
      currentCatalogueMRP: Number(catalogue.mrp || first.currentCatalogueMRP || 0),
      averageScannedMRP,
      minScannedMRP,
      maxScannedMRP,
      pricePeriodFrom: priceMatch ? priceMatch.effectiveFrom : (group.scanUPIMRP ? 'MRP NOT FOUND IN MASTER' : ''),
      pricePeriodTo: priceMatch ? (priceMatch.effectiveTo || '') : '',
      priceAgeingDays,
      finalInventoryValue,
      remarks: remarks.join(' ; ')
    };
  }).sort((a, b) => String(a.partNumber).localeCompare(String(b.partNumber)) || Number(a.scanUPIMRP || 0) - Number(b.scanUPIMRP || 0));
}

function movementValueRows(scans = []) {
  return [];
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
        productCategory: scan.productCategory || scan.category || '',
        mrp: scan.mrp,
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
        target.qty += Number(scan.qty || scan.quantity || 0);
        target.physicalBinQty = target.qty;
        target.actualAuditQty = target.qty;
        if (!target.partDescription) target.partDescription = scan.partDescription || scan.partName || '';
        if (!target.productCategory) target.productCategory = scan.productCategory || scan.category || '';
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
  if (type === 'movement-scans') return movementValueRows(data.scans);
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
  if (['main-inventory-audit', 'compile-audit', 'consolidated-final'].includes(type)) return data.finalRows.map(auditRow);
  return data.finalRows.map(auditRow);
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
  if (['main-inventory-audit', 'compile-audit', 'consolidated-final'].includes(type)) return AUDIT_COLUMNS;
  if (type === 'bin-wise-stock' || type === 'bin-stock' || type === 'bin-wise') return BIN_COLUMNS;
  if (type === 'movement-scans') return MOVEMENT_VALUE_COLUMNS;
  if (type === 'valid-scans') return SCAN_COLUMNS;
  if (type === 'scan-register') return SCAN_REGISTER_COLUMNS;
  if (type === 'user-dealer-wise') return USER_DEALER_COLUMNS;
  if (type === 'device-wise') return DEVICE_COLUMNS;
  if (type === 'duplicate-scans') return DUPLICATE_COLUMNS;
  if (type === 'wrong-not-found-master') return REJECTED_COLUMNS;
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
  const columns = type === 'movement-scans'
    ? selectedColumns(columnsForReport(type, rows), query)
    : selectedColumns(columnsForReport(type, rows), query).slice(0, 12);
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
  const columns = type === 'movement-scans'
    ? selectedColumns(columnsForReport(type, rows), query)
    : selectedColumns(columnsForReport(type, rows), query).slice(0, 12);
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
    console.log("REPORT API:", req.path, query);
    if (type === 'scan-register') {
      const rows = await scanRegisterRows(query);
      if (query.format === 'excel') return sendExcel(res, title, rows, type, query);
      if (query.format === 'pdf') return sendPdf(res, title, rows, type, query);
      return res.json({
        success: true,
        type,
        title,
        summary: { totalRows: rows.length },
        columns: columnsForReport(type, rows).map(({ header, key }) => ({ header, key })),
        rows,
        totalRows: rows.length,
        message: rows.length ? '' : 'No scan register data found for selected filter'
      });
    }
    if (type === 'movement-scans') {
      const scanFilter = movementScanFilter(query);
      const scans = await Inventory.find(scanFilter).sort({ timestamp: 1, createdAt: 1 }).lean();
      const rows = await movementValueRowsFromScans(scans, query);
      if (query.format === 'excel') return sendExcel(res, title, rows, type, query);
      if (query.format === 'pdf') return sendPdf(res, title, rows, type, query);
      return res.json({
        success: true,
        type,
        title,
        summary: { totalRows: rows.length, scannedRows: scans.length },
        columns: columnsForReport(type, rows).map(({ header, key }) => ({ header, key })),
        rows,
        totalRows: rows.length,
        message: rows.length ? '' : 'No movement scan data found for selected filter'
      });
    }
    const data = await reportModule.buildReportData(query);
    const rows = selectRows(data, type);
    if (query.format === 'excel') return sendExcel(res, title, rows, type, query);
    if (query.format === 'pdf') return sendPdf(res, title, rows, type, query);
    return res.json({
      success: true,
      type,
      title,
      summary: data.summary[0],
      columns: columnsForReport(type, rows).map(({ header, key }) => ({ header, key })),
      rows,
      totalRows: rows.length,
      message: rows.length ? '' : 'No report data found for selected filter'
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function emailReport(req, res, type, title) {
  try {
    if (!selectedDealerCode(req.body.filters || {})) return requireDealerSelection(res);
    console.log("REPORT API:", req.path, req.body.filters || {});
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
    } else if (type === 'movement-scans') {
      const filters = req.body.filters || {};
      rows = await movementValueRowsFromScans(await Inventory.find(movementScanFilter(filters)).sort({ timestamp: 1, createdAt: 1 }).lean(), filters);
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
    return res.status(500).json({ success: false, message: error.message });
  }
}

const REPORTS = {
  'bin-wise-stock': ['bin-wise-stock', 'Bin Wise Stock Report'],
  'user-dealer-wise': ['user-dealer-wise', 'User & Dealer Wise Report'],
  'movement-scans': ['movement-scans', 'Movement Scan Report'],
  'raw-upi': ['raw-upi', 'Raw UPI Report'],
  'scan-register': ['scan-register', 'Scan Register Report'],
  'valid-scans': ['scan-register', 'Scan Register Report'],
  'device-wise': ['scan-register', 'Scan Register Report'],
  'duplicate-scans': ['scan-register', 'Scan Register Report'],
  'wrong-not-found-master': ['wrong-not-found-master', 'Rejected Report'],
  'main-inventory-audit': ['main-inventory-audit', 'Main Inventory Audit Report'],
  'compile-audit': ['compile-audit', 'Compile Audit Report'],
  'consolidated-final': ['consolidated-final', 'Consolidated Final Report']
};

router.post('/movement-analysis/refresh', auth.requireAuth, async (req, res) => {
  try {
    const filters = { ...(req.body || {}), ...(req.query || {}) };
    if (!selectedDealerCode(filters)) return requireDealerSelection(res);
    const result = await rebuildMovementSummaries({
      dealerCode: filters.dealerCode,
      auditId: filters.auditId,
      partNumbers: filters.partNumber ? [filters.partNumber] : undefined
    });
    const io = req.app && req.app.get ? req.app.get('io') : null;
    if (io) io.emit('reports:update', { type: 'movement-scans', refreshedAt: new Date() });
    return res.json({ success: true, message: 'Movement analysis refreshed', ...result });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

Object.entries(REPORTS).forEach(([path, [type, title]]) => {
  if (type === 'wrong-not-found-master') return;
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

router.get('/wrong-not-found-master', auth.requireAuth, async (req, res) => {
  try {
    if (!selectedDealerCode(req.query)) return requireDealerSelection(res);
    const rows = await rejectedReportRows(req.query);
    const title = 'Rejected Report';
    if (req.query.format === 'excel') return sendExcel(res, title, rows, 'wrong-not-found-master', req.query);
    if (req.query.format === 'pdf') return sendPdf(res, title, rows, 'wrong-not-found-master', req.query);
    return res.json({
      success: true,
      type: 'wrong-not-found-master',
      title,
      summary: { rejectedCount: rows.length },
      columns: REJECTED_COLUMNS.map(({ header, key }) => ({ header, key })),
      rows,
      totalRows: rows.length,
      message: rows.length ? '' : 'No rejected not-in-master scans found for selected filter'
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

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
