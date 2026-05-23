const ExcelJS = require('exceljs');
const { jsPDF } = require('jspdf');
const autoTableModule = require('jspdf-autotable');
const nodemailer = require('nodemailer');
const router = require('./report');
const reportModule = require('./report');
const auth = require('./auth');
const DuplicateScanLog = require('../models/DuplicateScanLog');
const RejectedScan = require('../models/RejectedScan');
const { formatDateLikeFields } = require('../utils/time');

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
  if (query.deviceId) filter.deviceId = clean(query.deviceId);
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
    dateTime: row.dateTime || row.createdAt,
    dealerCode: row.dealerCode || '',
    userId: row.userId || '',
    userName: row.userName || row.loginId || '',
    role: row.role || '',
    deviceId: row.deviceId || '',
    scanMode: row.scanMode || '',
    scanType: row.scanType || '',
    rawScannedValue: row.rawScannedValue || '',
    extractedPartNumber: row.extractedPartNumber || '',
    binLocation: row.binLocation || '',
    reason: row.reason || 'Part Not Found In Master',
    status: row.status || 'REJECTED'
  }));
}

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
  { header: 'DLC', key: 'dlc', width: 12 },
  { header: 'PRODUCT GROUP', key: 'productGroup', width: 18 },
  { header: 'PRODUCT SUBGROUP', key: 'partSubGroup', width: 18 },
  { header: 'DMS QTY', key: 'dmsQty', width: 12 },
  { header: 'PHYSICAL QTY', key: 'physicalQty', width: 14 },
  { header: 'INWARD QTY', key: 'inwardQty', width: 14 },
  { header: 'OUTWARD QTY', key: 'outwardQty', width: 14 },
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
  { header: 'MRP', key: 'mrp', width: 12 },
  { header: 'SCAN TYPE', key: 'scanType', width: 16 },
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
    dlc: row.dlc,
    productGroup: row.productGroup,
    partSubGroup: row.partSubGroup,
    dmsQty: row.dmsQty,
    physicalQty: row.physicalQty,
    inwardQty: row.inwardQty || 0,
    outwardQty: row.outwardQty || 0,
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
  return {
    partNumber: scan.partNumber || scan.part,
    partDescription: scan.partDescription || scan.partName,
    model: scan.model,
    manufacturingYear: scan.manufacturingYear || scan.year,
    category: scan.productCategory || scan.category,
    productCategory: scan.productCategory || scan.category,
    bin: scan.binLocation || scan.bin,
    mrp: scan.mrp,
    dlc: scan.dlc,
    productGroup: scan.productGroup,
    partSubGroup: scan.partSubGroup,
    dmsQty: scan.dmsQty || 0,
    physicalQty,
    inwardQty: 0,
    outwardQty: 0,
    damageQty: (scan.scanType || scan.type) === 'DAMAGE' ? physicalQty : 0,
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
  return {
    scanTime: scan.timestamp,
    scanStatus: scan.scanStatus || ((scan.scanType || scan.type) === 'OUTWARD' ? 'OUTWARD_DONE' : 'ACCEPTED'),
    scanType: scan.scanType || scan.type || '',
    partNumber: scan.partNumber || scan.part || '',
    partDescription: scan.partDescription || scan.partName || '',
    quantity: Number(scan.qty || scan.quantity || 0),
    rawBarcode: scan.rawBarcode || scan.rawQR || scan.rawUpi || scan.rawScan || scan.rawScanString || '',
    binLocation: scan.binLocation || scan.bin || '',
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
      target.totalMrpValue = money(target.totalMrpValue + qty * Number(scan.mrp || 0));
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

function selectRows(data, type) {
  if (type === 'full-audit') {
    return data.finalRows.map(auditRow);
  }

  if (type === 'bin-wise-stock' || type === 'bin-stock' || type === 'bin-wise') {
    return groupRows(
      data.scans,
      (scan) => `${scan.dealerCode || 'UNKNOWN'}:${scan.binLocation || scan.bin || 'UNKNOWN'}:${scan.partNumber || scan.part || ''}:${scan.scanType || scan.type || ''}`,
      (scan) => ({
        dealerCode: scan.dealerCode || '',
        bin: scan.binLocation || scan.bin || 'UNKNOWN',
        partNumber: scan.partNumber || scan.part || '',
        partDescription: scan.partDescription || scan.partName || '',
        productCategory: scan.productCategory || scan.category || '',
        mrp: scan.mrp,
        scanType: scan.scanType || scan.type || '',
        qty: 0,
        lastScanTime: scan.timestamp,
        deviceId: scan.deviceId || ''
      }),
      (target, scan) => {
        target.qty += Number(scan.qty || scan.quantity || 0);
        if (!target.partDescription) target.partDescription = scan.partDescription || scan.partName || '';
        if (!target.productCategory) target.productCategory = scan.productCategory || scan.category || '';
        if (!target.deviceId) target.deviceId = scan.deviceId || '';
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
  if (type === 'movement-scans') return data.scans.filter(isMovementScan).map(validScanRow);
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
  if (['full-audit', 'main-inventory-audit', 'compile-audit', 'consolidated-final'].includes(type)) return AUDIT_COLUMNS;
  if (type === 'bin-wise-stock' || type === 'bin-stock' || type === 'bin-wise') return BIN_COLUMNS;
  if (['valid-scans', 'movement-scans'].includes(type)) return SCAN_COLUMNS;
  if (type === 'user-dealer-wise') return USER_DEALER_COLUMNS;
  if (type === 'device-wise') return DEVICE_COLUMNS;
  if (type === 'duplicate-scans') return DUPLICATE_COLUMNS;
  return columnsForRows(rows);
}

async function sendExcel(res, title, rows, type) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(title.slice(0, 31));
  const columns = columnsForReport(type, rows);
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

async function buildExcelBuffer(title, rows, type) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(title.slice(0, 31));
  const columns = columnsForReport(type, rows);
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

function sendPdf(res, title, rows, type) {
  const doc = new jsPDF({ orientation: 'landscape' });
  const columns = columnsForReport(type, rows).slice(0, 12);
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

function buildPdfBuffer(title, rows, type) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const columns = columnsForReport(type, rows).slice(0, 12);
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
    if (!selectedDealerCode(req.query)) return requireDealerSelection(res);
    console.log("REPORT API:", req.path, req.query);
    const data = await reportModule.buildReportData(req.query);
    const rows = selectRows(data, type);
    if (req.query.format === 'excel') return sendExcel(res, title, rows, type);
    if (req.query.format === 'pdf') return sendPdf(res, title, rows, type);
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

    const data = await reportModule.buildReportData(req.body.filters || {});
    const rows = selectRows(data, type);
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
  'full-audit': ['full-audit', 'Full Audit Report'],
  'bin-wise-stock': ['bin-wise-stock', 'Bin Wise Stock Report'],
  'user-dealer-wise': ['user-dealer-wise', 'User & Dealer Wise Report'],
  'movement-scans': ['movement-scans', 'Movement Scan Report'],
  'raw-upi': ['raw-upi', 'Raw UPI Report'],
  'valid-scans': ['valid-scans', 'Valid Scan Report'],
  'device-wise': ['device-wise', 'Device Wise Scan Report'],
  'duplicate-scans': ['duplicate-scans', 'Duplicate Scan Report'],
  'wrong-not-found-master': ['wrong-not-found-master', 'Wrong / Not Found In Master Scan Report'],
  'main-inventory-audit': ['main-inventory-audit', 'Main Inventory Audit Report'],
  'compile-audit': ['compile-audit', 'Compile Audit Report'],
  'consolidated-final': ['consolidated-final', 'Consolidated Final Report']
};

Object.entries(REPORTS).forEach(([path, [type, title]]) => {
  if (type === 'duplicate-scans' || type === 'wrong-not-found-master') return;
  router.get(`/${path}`, auth.requireAuth, (req, res) => handleReport(req, res, type, title));
  router.post(`/${path}/email`, auth.requireAuth, auth.requireAdmin, (req, res) => emailReport(req, res, type, title));
});

router.get('/wrong-not-found-master', auth.requireAuth, async (req, res) => {
  try {
    if (!selectedDealerCode(req.query)) return requireDealerSelection(res);
    const rows = await rejectedReportRows(req.query);
    const title = 'Wrong / Not Found In Master Scan Report';
    if (req.query.format === 'excel') return sendExcel(res, title, rows, 'wrong-not-found-master');
    if (req.query.format === 'pdf') return sendPdf(res, title, rows, 'wrong-not-found-master');
    return res.json({
      success: true,
      type: 'wrong-not-found-master',
      title,
      summary: { rejectedCount: rows.length },
      columns: [
        { header: 'Date Time', key: 'dateTime' },
        { header: 'Dealer Code', key: 'dealerCode' },
        { header: 'User ID', key: 'userId' },
        { header: 'User Name', key: 'userName' },
        { header: 'Role', key: 'role' },
        { header: 'Device ID', key: 'deviceId' },
        { header: 'Scan Mode', key: 'scanMode' },
        { header: 'Scan Type', key: 'scanType' },
        { header: 'Raw Scanned Value', key: 'rawScannedValue' },
        { header: 'Extracted Part Number', key: 'extractedPartNumber' },
        { header: 'Bin Location', key: 'binLocation' },
        { header: 'Reason', key: 'reason' },
        { header: 'Status', key: 'status' }
      ],
      rows,
      totalRows: rows.length,
      message: rows.length ? '' : 'No rejected not-in-master scans found for selected filter'
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/duplicate-scans', auth.requireAuth, async (req, res) => {
  try {
    if (!selectedDealerCode(req.query)) return requireDealerSelection(res);
    const rows = await duplicateReportRows(req.query);
    if (req.query.format === 'excel') return sendExcel(res, 'Duplicate Scan Report', rows, 'duplicate-scans');
    if (req.query.format === 'pdf') return sendPdf(res, 'Duplicate Scan Report', rows, 'duplicate-scans');
    return res.json({
      success: true,
      type: 'duplicate-scans',
      title: 'Duplicate Scan Report',
      summary: { duplicateCount: rows.length },
      columns: columnsForReport('duplicate-scans', rows).map(({ header, key }) => ({ header, key })),
      rows,
      totalRows: rows.length,
      message: rows.length ? '' : 'No duplicate scans found for selected filter'
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/bin-wise', auth.requireAuth, (req, res) => handleReport(req, res, 'bin-wise-stock', 'Bin Wise Stock Report'));
router.get('/bin-stock', auth.requireAuth, (req, res) => handleReport(req, res, 'bin-wise-stock', 'Bin Wise Stock Report'));
router.get('/raw-upi', auth.requireAuth, (req, res) => handleReport(req, res, 'raw-upi', 'Raw UPI Report'));
router.get('/valid-scans', auth.requireAuth, (req, res) => handleReport(req, res, 'valid-scans', 'Valid Scan Report'));
router.get('/device-wise', auth.requireAuth, (req, res) => handleReport(req, res, 'device-wise', 'Device Wise Scan Report'));

module.exports = router;
