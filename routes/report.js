const express = require('express');
const ExcelJS = require('exceljs');
const nodemailer = require('nodemailer');
const { jsPDF } = require('jspdf');
const autoTableModule = require('jspdf-autotable');
const Inventory = require('../models/Inventory');
const MasterPart = require('../models/MasterPart');
const MasterCatalogue = require('../models/MasterCatalogue');
const PartPriceHistory = require('../models/PartPriceHistory');
const DealerStock = require('../models/DealerStock');
const Dealer = require('../models/Dealer');
const Audit = require('../models/Audit');
const User = require('../models/User');
const Device = require('../models/Device');
const InventoryMovementSummary = require('../models/InventoryMovementSummary');
const auth = require('./auth');
const inventoryRoute = require('./inventory');
const { normalizePartNumber: normalizePartNo, cleanText: normalizedCleanText, numberValue } = require('../utils/normalize');
const { cataloguePayload } = require('../utils/catalogue');
const { formatDateLikeFields, formatIstDateTime, isDateLikeKey } = require('../utils/time');
const { calculateInventoryValue, decorateScanValue, scanValueRow, summarizeMovementBucket, validateReportValueSource } = require('../utils/inventoryValueEngine');

const router = express.Router();
const autoTable = autoTableModule.default || autoTableModule;

/**
 * ====================================================================
 * REPORT ROUTE - INVENTORY VALUE CALCULATION COMPLIANCE
 * ====================================================================
 *
 * ALL REPORTS MUST USE:
 *   - calculateInventoryValue() for value aggregation
 *   - scanValueRow() for per-scan decoration
 *   - validateReportValueSource() for data quality checks
 *
 * FINAL INVENTORY VALUE FORMULA (FOR ALL REPORTS):
 *   finalInventoryValue = SUM(scanned qty × scanned MRP) + SUM(manual qty × manual MRP)
 *
 * NEVER:
 *   - Recalculate inventory value independently
 *   - Use master MRP for inventory calculations
 *   - Use current catalogue MRP for value calculations
 *   - Aggregate values differently than calculateInventoryValue()
 *
 * REPORT CONSISTENCY CHECKS:
 *   1. Dashboard total must match Report total
 *   2. All reports use same calculation engine
 *   3. No report-specific MRP overrides allowed
 *   4. Movement categories based on scan history, not just current MRP
 *
 * ====================================================================
 */

const PROFESSIONAL_REPORTS = {
  main: {
    title: 'Main Inventory Audit Report',
    fileName: 'Main_Inventory_Audit_Report'
  },
  compile: {
    title: 'Compile Audit Report',
    fileName: 'Compile_Audit_Report'
  },
  consolidated: {
    title: 'Consolidated Final Report',
    fileName: 'Consolidated_Final_Report'
  }
};

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function rowValueSummary(scans = [], catalogue = {}, priceHistories = []) {
  const summary = calculateInventoryValue(scans);
  return {
    currentCatalogueMRP: Number(catalogue && catalogue.mrp || 0),
    totalQty: summary.totalQty,
    scanUPIMRP: scanUpiMrpDisplay(summary.rows),
    averageScannedMRP: summary.averageScannedMRP,
    minScannedMRP: summary.minScannedMRP,
    maxScannedMRP: summary.maxScannedMRP,
    totalScanValue: summary.totalScanValue,
    totalManualValue: summary.totalManualValue,
    finalInventoryValue: summary.finalInventoryValue,
    scannedQty: summary.scannedQty,
    manualQty: summary.manualQty,
    priceChangeCount: summary.priceChangeCount,
    pricePeriod: pricePeriodDisplay(scans, priceHistories, summary.rows)
  };
}

function valuationRateForDisplay(summary = {}) {
  return Number(summary.averageScannedMRP || summary.minScannedMRP || summary.maxScannedMRP || 0);
}

function scanUpiMrpDisplay(valueRows = []) {
  const values = Array.from(new Set(
    valueRows
      .filter((row) => row.valuationSource === 'UPI_SCANNED_MRP' && Number(row.valuationMRP || 0) > 0)
      .map((row) => Number(row.valuationMRP || 0).toFixed(2))
  )).sort((a, b) => Number(a) - Number(b));
  if (!values.length) return 0;
  if (values.length === 1) return Number(values[0]);
  return values.join(', ');
}

function pricePeriodText(from, to, status = '') {
  const fromText = formatDate(from);
  const toText = formatDate(to);
  if (fromText || toText) return `${fromText || 'START'} to ${toText || 'CURRENT'}`;
  return cleanText(status).replace(/_/g, ' ');
}

function priceHistoryPeriodDisplay(priceHistories = [], valueRows = []) {
  const histories = Array.isArray(priceHistories) ? priceHistories : [];
  if (!histories.length) return '';
  const scannedMrps = Array.from(new Set(valueRows
    .filter((row) => row.valuationSource === 'UPI_SCANNED_MRP' && Number(row.valuationMRP || 0) > 0)
    .map((row) => Number(row.valuationMRP || 0).toFixed(2))));
  const periods = scannedMrps.map((mrpText) => {
    const mrp = Number(mrpText);
    const match = histories.find((history) => Math.abs(Number(history.mrp || 0) - mrp) <= 0.01);
    return match ? pricePeriodText(match.effectiveFrom, match.effectiveTo, `MRP ${mrpText}`) : '';
  }).filter(Boolean);
  return Array.from(new Set(periods)).join(' ; ');
}

function pricePeriodDisplay(scans = [], priceHistories = [], valueRows = []) {
  const historyPeriod = priceHistoryPeriodDisplay(priceHistories, valueRows);
  if (historyPeriod) return historyPeriod;
  const periods = Array.from(new Set(scans.map((scan) => pricePeriodText(
    scan.pricePeriodFrom,
    scan.pricePeriodTo,
    scan.pricePeriodStatus
  )).filter(Boolean)));
  if (periods.length <= 3) return periods.join(' ; ');
  return `${periods.slice(0, 3).join(' ; ')} ; +${periods.length - 3} more`;
}

function partMovementLabel(value = '') {
  const text = cleanText(value).toUpperCase().replace(/_/g, '-');
  if (text === 'FAST') return 'FAST MOVING';
  if (text === 'SLOW') return 'SLOW MOVING';
  if (text === 'DEAD') return 'DEAD STOCK';
  if (text === 'NON-MOVING' || text === 'NON MOVING') return 'NON MOVING';
  return text;
}

function blankMovementSummary() {
  return {
    oldestPricePeriod: null,
    newestPricePeriod: null,
    priceAgeingDays: 0,
    lastMovementDate: null,
    movementQtyLast30Days: 0,
    movementQtyLast90Days: 0,
    movementQtyLast180Days: 0,
    movementQtyLast365Days: 0,
    movementCategory: '',
    inventoryRiskValue: 0
  };
}

function mergeMovementSummary(current, summaryRow = {}) {
  const merged = current || blankMovementSummary();
  const oldest = summaryRow.oldestPricePeriod || summaryRow.firstScanDate;
  const newest = summaryRow.newestPricePeriod || summaryRow.lastScanDate;
  if (oldest && (!merged.oldestPricePeriod || new Date(oldest) < new Date(merged.oldestPricePeriod))) merged.oldestPricePeriod = oldest;
  if (newest && (!merged.newestPricePeriod || new Date(newest) > new Date(merged.newestPricePeriod))) merged.newestPricePeriod = newest;
  if (summaryRow.lastMovementDate && (!merged.lastMovementDate || new Date(summaryRow.lastMovementDate) > new Date(merged.lastMovementDate))) merged.lastMovementDate = summaryRow.lastMovementDate;
  merged.priceAgeingDays = Math.max(merged.priceAgeingDays, Number(summaryRow.priceAgeingDays || summaryRow.ageingDays || 0));
  merged.movementQtyLast30Days += Number(summaryRow.movementQtyLast30Days || 0);
  merged.movementQtyLast90Days += Number(summaryRow.movementQtyLast90Days || 0);
  merged.movementQtyLast180Days += Number(summaryRow.movementQtyLast180Days || 0);
  merged.movementQtyLast365Days += Number(summaryRow.movementQtyLast365Days || 0);
  merged.inventoryRiskValue += Number(summaryRow.inventoryRiskValue || 0);
  if (summaryRow.movementCategory === 'DEAD') merged.movementCategory = 'DEAD';
  else if (summaryRow.movementCategory === 'NON-MOVING' && merged.movementCategory !== 'DEAD') merged.movementCategory = 'NON-MOVING';
  else if (summaryRow.movementCategory === 'SLOW' && !['DEAD', 'NON-MOVING'].includes(merged.movementCategory)) merged.movementCategory = 'SLOW';
  else if (summaryRow.movementCategory === 'FAST' && !merged.movementCategory) merged.movementCategory = 'FAST';
  return merged;
}

async function cachedMovementByPart(partNumbers = [], query = {}) {
  const allParts = Array.from(new Set(partNumbers.map(normalizePartNumber).filter(Boolean)));
  if (!allParts.length) return new Map();
  const movementFilter = { normalizedPartNumber: { $in: allParts } };
  if (query.dealerCode) movementFilter.dealerCode = String(query.dealerCode).trim().toUpperCase();
  if (query.auditId) movementFilter.auditId = String(query.auditId).trim();
  const movementSummaries = await InventoryMovementSummary.find(movementFilter).lean();
  const movementByPart = new Map();
  movementSummaries.forEach((summaryRow) => {
    const partNo = normalizePartNumber(summaryRow.normalizedPartNumber || summaryRow.partNumber);
    if (!partNo) return;
    movementByPart.set(partNo, mergeMovementSummary(movementByPart.get(partNo), summaryRow));
  });
  return movementByPart;
}

function attachCachedMovement(rows = [], movementByPart = new Map()) {
  rows.forEach((row) => {
    const movement = movementByPart.get(normalizePartNumber(row.partNum || row.partNumber || row.partNo)) || {};
    Object.assign(row, {
      oldestPricePeriod: movement.oldestPricePeriod || row.oldestPricePeriod || '',
      newestPricePeriod: movement.newestPricePeriod || row.newestPricePeriod || '',
      priceAgeingDays: movement.priceAgeingDays || row.priceAgeingDays || 0,
      lastMovementDate: movement.lastMovementDate || row.lastMovementDate || '',
      movementQtyLast30Days: movement.movementQtyLast30Days || row.movementQtyLast30Days || 0,
      movementQtyLast90Days: movement.movementQtyLast90Days || row.movementQtyLast90Days || 0,
      movementQtyLast180Days: movement.movementQtyLast180Days || row.movementQtyLast180Days || 0,
      movementQtyLast365Days: movement.movementQtyLast365Days || row.movementQtyLast365Days || 0,
      movementCategory: movement.movementCategory || row.movementCategory || '',
      inventoryRiskValue: money(movement.inventoryRiskValue || row.inventoryRiskValue || 0)
    });
  });
  return rows;
}

function scanSourceValue(scan = {}) {
  const source = String(scan.source || scan.scanSource || '').trim().toLowerCase();
  if (/manual/.test(source)) return 'manual';
  if (/ocr|ai/.test(source)) return 'ocr_label';
  if (/^qr$|qr[_\s-]*scan/.test(source)) return 'qr';
  if (/barcode/.test(source)) return 'barcode';
  if (/scanner/.test(source)) return 'scanner';
  if (/camera|mobile/.test(source)) return 'mobile';
  if (['import', 'api'].includes(source)) return source;
  return '';
}

function scanSourceLabels(scan = {}) {
  const source = scanSourceValue(scan);
  const deviceId = String(scan.deviceId || '').trim().toUpperCase();
  const entryChannel = deviceId.startsWith('MOB-') || ['mobile', 'camera', 'qr', 'ocr_label'].includes(source)
    ? 'Mobile'
    : deviceId.startsWith('WEB-') || ['manual', 'barcode', 'scanner'].includes(source)
      ? 'Web'
      : 'Server';
  const entryMode = source === 'manual'
    ? 'Manual Entry'
    : source === 'ocr_label'
      ? 'OCR Label Scan'
      : ['barcode', 'scanner', 'qr', 'mobile', 'camera'].includes(source)
        ? 'Barcode/QR Scan'
        : 'System/API';
  return { entryMode, entryChannel, scanSourceLabel: `${entryChannel} ${entryMode}` };
}

const CATEGORY_VARIANCE_ACTIONS = [
  'Inventory Addition',
  'Inventory Matched',
  'Inward',
  'Outward',
  'Fitted',
  'Damage'
];

function cleanText(value) {
  return normalizedCleanText(value);
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeReportQuery(query = {}) {
  const rawDealerCode = reqSafeValue(query.dealerCode);
  const dealerCode = rawDealerCode.toLowerCase() === 'all' ? '' : inventoryRoute.normalizeDealerCode(rawDealerCode);
  const auditDate = reportQueryValue(query.auditDate || query.auditDateOn || query.selectedAuditDate || '');
  const fromDate = reportQueryValue(query.from || query.fromDate || query.dateFrom || query.auditDateFrom || auditDate);
  const toDate = reportQueryValue(query.to || query.toDate || query.dateTo || query.auditDateTo || auditDate);
  const enriched = {
    ...query,
    dealerCode,
    auditDate,
    from: fromDate,
    to: toDate,
    bin: reportQueryValue(query.bin || query.binLocation || ''),
    partNumber: reportQueryValue(query.partNumber || query.partNo || query.part || ''),
    type: reportQueryValue(query.type || query.scanType || ''),
    category: reportQueryValue(query.category),
    productCategory: reportQueryValue(query.productCategory),
    productGroup: reportQueryValue(query.productGroup),
    partSubGroup: reportQueryValue(query.partSubGroup || query.productSubGroup),
    productSubGroup: reportQueryValue(query.productSubGroup || query.partSubGroup),
    model: reportQueryValue(query.model),
    year: reportQueryValue(query.year || query.manufacturingYear),
    action: reportQueryValue(query.action),
    status: reportQueryValue(query.status),
    scanStatus: reportQueryValue(query.scanStatus),
    userName: reportQueryValue(query.userName || query.staffName || query.loginId),
    syncStatus: reportQueryValue(query.syncStatus),
    upiRawQr: reportQueryValue(query.upiRawQr || query.rawUpi || query.rawQR || query.rawScan),
    role: reportQueryValue(query.role),
    deviceName: reportQueryValue(query.deviceName),
    deviceId: reportQueryValue(query.deviceId),
    entryMode: reportQueryValue(query.entryMode),
    entryChannel: reportQueryValue(query.entryChannel),
    entrySource: reportQueryValue(query.entrySource || query.scanSourceLabel || query.source),
    dealerName: reportQueryValue(query.dealerName),
    varianceType: reportQueryValue(query.varianceType).toLowerCase()
  };
  return enriched;
}

function reqSafeValue(value) {
  return String(value || '').trim();
}

function reportQueryValue(value) {
  const text = cleanText(value);
  return /^all(\s|$)/i.test(text) ? '' : text;
}

function requireDealerForReport(payload = {}) {
  const query = normalizeReportQuery(payload);
  if (!query.dealerCode) {
    const error = new Error('Select dealer code first to view report');
    error.statusCode = 400;
    throw error;
  }
  return query;
}

function requireDealerForConsolidated(kind, payload = {}) {
  return requireDealerForReport(payload);
}

function reportErrorStatus(error) {
  return error.statusCode || 500;
}

function splitBins(value) {
  const bins = cleanText(value)
    .split(/[|,;/]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return [bins[0] || '', bins[1] || '', bins[2] || ''];
}

function splitAllBins(value) {
  return cleanText(value)
    .split(/[|,;/]+/)
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

function csvCell(value) {
  return `"${String(value === undefined || value === null ? '' : value).replace(/"/g, '""')}"`;
}

function uniqueBins(entries = []) {
  const counts = new Map();
  entries.forEach((entry) => {
    const bin = cleanText(entry.bin || entry.binLocation || entry.location || '');
    if (!bin) return;
    counts.set(bin, (counts.get(bin) || 0) + numberValue(entry.qty !== undefined ? entry.qty : entry.quantity, 1));
  });
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || sortText(a[0], b[0])).map(([bin]) => bin);
}

function binDisplay(entries = []) {
  const bins = uniqueBins(entries);
  return {
    bin1: bins[0] || '',
    bin2: bins[1] || '',
    bin3: bins[2] || '',
    otherBins: bins.slice(3).join(', ')
  };
}

function topThreeBins(entries = []) {
  const bins = uniqueBins(entries);
  return bins.concat(['', '', '']).slice(0, 3);
}

function actionForDifference(diffQty) {
  if (diffQty > 0) return 'Inward';
  if (diffQty < 0) return 'Outward';
  return 'Inventory Matched';
}

function statusLabel(row) {
  if (row.status === 'Extra Part') return 'Inventory Addition';
  if (Number(row.differenceQty || 0) > 0) return 'Increase';
  if (Number(row.differenceQty || 0) < 0) return 'Decrease';
  return 'Inventory Matched';
}

function formatDate(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return cleanText(value);
  return date.toISOString().slice(0, 10);
}

function reportFilter(query = {}) {
  query = normalizeReportQuery(query);
  const filter = inventoryRoute.buildListQuery(query);
  inventoryRoute.applyTestScanMode(filter, query.testScanMode || 'real');
  delete filter.category;
  const partNumber = query.partNumber || query.partNo || query.part;
  if (partNumber) filter.part = { $regex: String(partNumber).trim(), $options: 'i' };
  if (query.dealerName) filter.dealerName = { $regex: escapeRegExp(query.dealerName), $options: 'i' };
  applyReportMetadataFilters(filter, query);
  return filter;
}

function appendAnd(filter, clause) {
  filter.$and = (filter.$and || []).concat([clause]);
}

function regexClause(fields, value) {
  const text = reportQueryValue(value);
  if (!text) return null;
  const regex = { $regex: escapeRegExp(text), $options: 'i' };
  return { $or: fields.map((field) => ({ [field]: regex })) };
}

function applyReportMetadataFilters(filter, query = {}) {
  const userClause = regexClause(['userName', 'staffName', 'loginId', 'userId'], query.userName);
  if (userClause) appendAnd(filter, userClause);
  if (query.syncStatus) filter.syncStatus = String(query.syncStatus).trim().toLowerCase();
  const rawClause = regexClause(['rawUpi', 'rawQR', 'rawScan', 'rawScanString', 'rawBarcode', 'upiNo', 'upiId'], query.upiRawQr);
  if (rawClause) appendAnd(filter, rawClause);
  if (query.role) filter.role = { $regex: escapeRegExp(String(query.role).trim()), $options: 'i' };
  if (query.deviceName) filter.deviceName = { $regex: escapeRegExp(query.deviceName), $options: 'i' };
  if (query.deviceId) filter.deviceId = { $regex: escapeRegExp(query.deviceId), $options: 'i' };
  if (query.entryMode) appendAnd(filter, { $or: [{ entryMode: { $regex: escapeRegExp(query.entryMode), $options: 'i' } }, { scanMode: { $regex: escapeRegExp(query.entryMode), $options: 'i' } }, { source: { $regex: escapeRegExp(query.entryMode), $options: 'i' } }] });
  if (query.entryChannel) appendAnd(filter, { $or: [{ entryChannel: { $regex: escapeRegExp(query.entryChannel), $options: 'i' } }, { source: { $regex: escapeRegExp(query.entryChannel), $options: 'i' } }, { deviceId: { $regex: escapeRegExp(query.entryChannel), $options: 'i' } }] });
  if (query.entrySource) appendAnd(filter, { $or: [{ scanSourceLabel: { $regex: escapeRegExp(query.entrySource), $options: 'i' } }, { source: { $regex: escapeRegExp(query.entrySource), $options: 'i' } }, { scanMode: { $regex: escapeRegExp(query.entrySource), $options: 'i' } }] });
  if (query.scanStatus) filter.scanStatus = String(query.scanStatus).trim().toUpperCase();
}

function sortText(a, b) {
  return String(a || '').localeCompare(String(b || ''));
}

function sortCategoryVarianceRows(a, b) {
  const categoryCompare = sortText(String(a.productCategory || '').replace(/\s+TOTAL$/i, ''), String(b.productCategory || '').replace(/\s+TOTAL$/i, ''));
  if (categoryCompare) return categoryCompare;
  const typeRank = { detail: 0, subtotal: 1, grandTotal: 2 };
  const typeCompare = (typeRank[a.rowType] || 0) - (typeRank[b.rowType] || 0);
  if (typeCompare) return typeCompare;
  const actionRank = new Map(CATEGORY_VARIANCE_ACTIONS.map((action, index) => [action.toUpperCase(), index]));
  return (actionRank.get(String(a.action || '').toUpperCase()) ?? 99) - (actionRank.get(String(b.action || '').toUpperCase()) ?? 99);
}

function normalizePartNumber(value) {
  return normalizePartNo(value);
}

function normalizeCategory(value) {
  return cleanText(value).replace(/\s+/g, ' ');
}

function displayCategory(value) {
  const category = normalizeCategory(value).toUpperCase();
  return category || 'UNCATEGORIZED';
}

function displayAction(value) {
  const text = cleanText(value).toLowerCase().replace(/[\s_-]+/g, ' ');
  if (!text) return '';
  if (text.includes('inventory addition') || text.includes('opening') || text.includes('master addition') || text.includes('stock addition')) return 'Inventory Addition';
  if (text.includes('inventory matched') || text === 'matched') return 'Inventory Matched';
  if (text.includes('damage')) return 'Damage';
  if (text.includes('fitted')) return 'Fitted';
  if (text.includes('outward') || text.includes('sale') || text.includes('issue') || text.includes('short')) return 'Outward';
  if (text.includes('inward')) return 'Inward';
  return '';
}

function actionForScan(scan = {}) {
  return displayAction(scan.action || scan.transactionType || scan.movementType || scan.type || scan.scanType);
}

function physicalScanQty(scan = {}) {
  const qty = numberValue(scan.qty !== undefined ? scan.qty : scan.quantity, 0);
  const type = cleanText(scan.scanType || scan.type).toUpperCase();
  if (['OUTWARD', 'DAMAGE'].includes(type)) return -Math.abs(qty);
  return Math.abs(qty);
}

function binPhysicalScanQty(scan = {}) {
  const type = cleanText(scan.scanType || scan.type).toUpperCase();
  if (type === 'FITTED' || scan.isFitted) return 0;
  return physicalScanQty(scan);
}

function fittedScanQty(scan = {}) {
  const type = cleanText(scan.scanType || scan.type).toUpperCase();
  return type === 'FITTED' || scan.isFitted ? Math.abs(numberValue(scan.fittedQty !== undefined ? scan.fittedQty : scan.qty !== undefined ? scan.qty : scan.quantity, 0)) : 0;
}

function binDisplayWithFitted(entries = []) {
  const nonFitted = entries.filter((scan) => !fittedScanQty(scan));
  return binDisplay(nonFitted);
}

function fittedDetails(scans = []) {
  const fittedScans = scans.filter((scan) => fittedScanQty(scan));
  return {
    fittedScans,
    fittedQty: fittedScans.reduce((sum, scan) => sum + fittedScanQty(scan), 0),
    fittedRegdNo: Array.from(new Set(fittedScans.map((scan) => cleanText(scan.regdNo)).filter(Boolean))).join(', '),
    fittedJobCardNo: Array.from(new Set(fittedScans.map((scan) => cleanText(scan.jobCardNo)).filter(Boolean))).join(', ')
  };
}

function signedVarianceQty(action, qty) {
  const amount = Math.abs(numberValue(qty, 0));
  switch (action) {
    case 'Inventory Addition':
    case 'Inward':
      return amount;
    case 'Outward':
    case 'Fitted':
    case 'Damage':
      return -amount;
    case 'Inventory Matched':
      return 0;
    default:
      return amount;
  }
}

function scanDuplicateKey(scan = {}) {
  const type = cleanText(scan.scanType || scan.type).toUpperCase();
  if (type === 'FITTED' || scan.isFitted) {
    return [
      cleanText(scan.dealerCode).toUpperCase(),
      normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part),
      cleanText(scan.regdNo).toUpperCase(),
      cleanText(scan.jobCardNo).toUpperCase(),
      'FITTED'
    ].filter(Boolean).join('::');
  }
  const id = cleanText(scan.uniqueScanId || scan.scanId || scan.upiId || scan.rawUpi || scan.rawScan || scan.rawScanString || scan.syncKey || scan._id);
  const bin = cleanText(scan.binLocation || scan.bin || scan.location);
  return [id, bin].filter(Boolean).join('::BIN::');
}

function rowStatus(diffQty) {
  if (diffQty > 0) return 'Excess';
  if (diffQty < 0) return 'Short';
  return 'Matched';
}

function partwiseStatus({ hasCatalogue, hasSystemStock, physicalQty, varianceQty }) {
  if (!hasCatalogue) return 'MASTER NOT FOUND';
  if (!hasSystemStock && physicalQty > 0) return 'EXTRA PHYSICAL STOCK';
  if (varianceQty > 0) return 'EXCESS';
  if (varianceQty < 0) return 'SHORT';
  return 'MATCHED';
}

function partwiseAction(varianceQty, hasSystemStock, physicalQty) {
  if (!hasSystemStock && physicalQty > 0) return 'Inventory Addition';
  if (varianceQty > 0) return 'Inward';
  if (varianceQty < 0) return 'Outward';
  return 'Inventory Matched';
}

function applyVarianceFilter(rows, varianceType) {
  switch (cleanText(varianceType).toLowerCase()) {
    case 'matched':
      return rows.filter((row) => row.status === 'Matched');
    case 'short':
      return rows.filter((row) => Number(row.differenceQty || 0) < 0);
    case 'excess':
      return rows.filter((row) => Number(row.differenceQty || 0) > 0);
    case 'extra':
    case 'inventory-addition':
      return rows.filter((row) => row.status === 'Extra Part');
    case 'not-scanned':
      return rows.filter((row) => Number(row.systemQty || 0) > 0 && Number(row.physicalQty || 0) === 0);
    case 'damage':
      return rows.filter((row) => Number(row.damageQty || 0) > 0);
    case 'non-moving':
      return rows.filter((row) => Number(row.systemQty || 0) > 0 && Number(row.physicalQty || 0) === 0);
    default:
      return rows;
  }
}

function applyHeaderStyle(sheet) {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF153A5B' } };
  header.alignment = { vertical: 'middle', horizontal: 'center' };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: Math.max(sheet.columnCount, 1) }
  };
}

function addSheet(workbook, name, columns, rows) {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = columns.map((column) => ({
    header: column.header,
    key: column.key,
    width: column.width || 18
  }));
  rows.forEach((row) => {
    const formatted = { ...row };
    columns.forEach((column) => {
      if (isDateLikeKey(column.key) && formatted[column.key]) {
        formatted[column.key] = formatIstDateTime(formatted[column.key]) || formatted[column.key];
      }
    });
    sheet.addRow(formatDateLikeFields(formatted));
  });
  applyHeaderStyle(sheet);
  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
      };
    });
  });
  return sheet;
}

function requestedReportColumnKeys(query = {}) {
  return String(query.columns || query.fields || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

function hasRequestedReportColumns(query = {}) {
  return requestedReportColumnKeys(query).length > 0;
}

function selectedReportColumns(columns = [], query = {}) {
  const selected = requestedReportColumnKeys(query);
  if (!selected.length) return columns;
  const byKey = new Map(columns.map((column) => [column.key, column]));
  const ordered = selected.map((key) => byKey.get(key)).filter(Boolean);
  return ordered.length ? ordered : columns;
}

async function sendSelectedColumnsWorkbook(res, filename, sheetName, columns, rows, query = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Daksh Inventory v2';
  workbook.created = new Date();
  addSheet(workbook, sheetName.slice(0, 31), selectedReportColumns(columns, query), rows);
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/\.xlsx$/i, '')}.xlsx"`);
  return res.send(Buffer.from(buffer));
}

async function buildLegacyReportData(query = {}) {
  query = normalizeReportQuery(query);
  console.log("REPORT API:", '/api/reports', query);
  const filter = reportFilter(query);
  const masterFilter = {};
  if (query.category) masterFilter.category = String(query.category).trim();
  if (query.partNumber || query.partNo || query.part) {
    masterFilter.partNo = { $regex: String(query.partNumber || query.partNo || query.part).trim(), $options: 'i' };
  }
  if (query.bin) masterFilter.bin = { $regex: String(query.bin).trim(), $options: 'i' };
  if (query.dealerCode) masterFilter.$or = [
    { dealerCode: String(query.dealerCode).trim().toUpperCase() },
    { dealerCode: '' },
    { dealerCode: { $exists: false } }
  ];
  const [filteredMasterParts, scans, dealers, audits] = await Promise.all([
    MasterPart.find(masterFilter).sort({ partNo: 1 }).lean(),
    Inventory.find(filter).sort({ timestamp: -1 }).lean(),
    Dealer.find({}).sort({ dealerName: 1 }).lean(),
    Audit.find({}).sort({ createdAt: -1 }).lean()
  ]);

  const scanPartNumbers = Array.from(new Set(scans.map((scan) => normalizePartNumber(scan.partNumber || scan.part)).filter(Boolean)));
  const extraMasterParts = scanPartNumbers.length
    ? await MasterPart.find({ $or: [{ normalizedPartNumber: { $in: scanPartNumbers } }, { partNo: { $in: scanPartNumbers } }, { partNumber: { $in: scanPartNumbers } }] }).lean()
    : [];
  const masterByPart = new Map();
  filteredMasterParts.concat(extraMasterParts).forEach((part) => {
    const partNo = masterPartNumber(part);
    if (partNo) masterByPart.set(partNo, part);
  });
  const masterParts = filteredMasterParts;
  const scanTotals = new Map();
  const countedTotals = new Map();
  const damageTotals = new Map();
  const saleQtyLast12Months = new Map();
  const movementCounts = new Map();
  const scanByPart = new Map();
  const twelveMonthCutoff = new Date();
  twelveMonthCutoff.setFullYear(twelveMonthCutoff.getFullYear() - 1);

  scans.forEach((scan) => {
    const partNo = normalizePartNumber(scan.partNumber || scan.part);
    scan.part = partNo;
    scan.partNumber = partNo;
    const master = masterByPart.get(partNo);
    if (master) {
      scan.partName = rowDescription(scan, master);
      scan.partDescription = rowDescription(scan, master);
      scan.category = rowCategory(scan, master);
      scan.productCategory = rowCategory(scan, master);
      scan.bin = scan.bin || scan.binLocation || master.bin || master.binLocation;
      scan.binLocation = scan.binLocation || scan.bin || master.bin || master.binLocation;
      scan = Object.assign(scan, decorateScanValue(scan));
      scan.currentCatalogueMRP = Number(master.mrp || 0);
      scan.dlc = scan.dlc || master.dlc;
      scan.dealerCode = scan.dealerCode || master.dealerCode;
    }

    const qty = Number(scan.qty || 0);
    scanTotals.set(partNo, (scanTotals.get(partNo) || 0) + qty);
    if (scan.type === 'DAMAGE') {
      damageTotals.set(partNo, (damageTotals.get(partNo) || 0) + qty);
    } else {
      countedTotals.set(partNo, (countedTotals.get(partNo) || 0) + qty);
    }
    if (['OUTWARD', 'FITTED'].includes(scan.type) && new Date(scan.timestamp) >= twelveMonthCutoff) {
      saleQtyLast12Months.set(partNo, (saleQtyLast12Months.get(partNo) || 0) + qty);
      movementCounts.set(partNo, (movementCounts.get(partNo) || 0) + 1);
    }
    if (!scanByPart.has(partNo)) scanByPart.set(partNo, []);
    scanByPart.get(partNo).push(scan);
  });

  const rows = masterParts.map((part) => {
    const relatedScans = scanByPart.get(part.partNo) || [];
    const valueSummary = rowValueSummary(relatedScans, part);
    const displayMrp = valuationRateForDisplay(valueSummary);
    const systemQty = Number(part.openingStockQty || 0);
    const physicalQty = Number(scanTotals.get(part.partNo) || 0);
    const countedQty = Number(countedTotals.get(part.partNo) || 0);
    const damageQty = Number(damageTotals.get(part.partNo) || 0);
    const diffQty = physicalQty - systemQty;
    const shortQty = systemQty > physicalQty ? systemQty - physicalQty : 0;
    const excessQty = physicalQty > systemQty ? physicalQty - systemQty : 0;
    const binLocation = part.binLocation || part.bin || '';
    const physicalBins = binDisplay(scanByPart.get(part.partNo) || []);
    const systemBins = splitBins(binLocation);
    return {
      partNo: part.partNo,
      partNumber: part.partNo,
      partName: part.partName,
      model: part.model,
      year: part.year,
      category: part.productCategory || part.category,
      productCategory: part.productCategory || part.category,
      bin: binLocation,
      binLocation,
      mrp: displayMrp,
      currentCatalogueMRP: valueSummary.currentCatalogueMRP,
      totalQty: valueSummary.totalQty,
      scannedQty: valueSummary.scannedQty,
      manualQty: valueSummary.manualQty,
      averageScannedMRP: valueSummary.averageScannedMRP,
      minScannedMRP: valueSummary.minScannedMRP,
      maxScannedMRP: valueSummary.maxScannedMRP,
      totalScanValue: valueSummary.totalScanValue,
      totalManualValue: valueSummary.totalManualValue,
      finalInventoryValue: valueSummary.finalInventoryValue,
      dlc: Number(part.dlc || 0),
      systemQty,
      dmsQty: systemQty,
      physicalQty,
      shortQty,
      excessQty,
      netDifference: diffQty,
      countedQty,
      manualQty: valueSummary.manualQty,
      damageQty,
      totalAuditQty: physicalQty,
      saleQtyLast12Months: Number(saleQtyLast12Months.get(part.partNo) || 0),
      movementCodeA: Number(movementCounts.get(part.partNo) || 0),
      reservedQty: Number(part.reservedQty || 0),
      physicalBin1: physicalBins.bin1,
      physicalBin2: physicalBins.bin2,
      physicalBin3: physicalBins.bin3,
      otherBinLocations: physicalBins.otherBins,
      systemBin1: systemBins[0],
      systemBin2: systemBins[1],
      systemBin3: systemBins[2],
      systemMrpValue: 0,
      physicalMrpValue: valueSummary.finalInventoryValue,
      systemDlcValue: money(systemQty * Number(part.dlc || 0)),
      physicalDlcValue: money(physicalQty * Number(part.dlc || 0)),
      differenceQty: diffQty,
      varianceQty: Math.abs(diffQty),
      varianceValue: valueSummary.finalInventoryValue,
      differenceMrpValue: valueSummary.finalInventoryValue,
      differenceDlcValue: money(diffQty * Number(part.dlc || 0)),
      status: rowStatus(diffQty),
      rawScanProof: (scanByPart.get(part.partNo) || []).map((scan) => scan.rawScan).filter(Boolean).slice(0, 5).join(' | ')
    };
  });

  const extraParts = [];
  scanTotals.forEach((physicalQty, partNo) => {
    if (masterByPart.has(partNo)) return;
    const related = scanByPart.get(partNo) || [];
    const first = related[0] || {};
    const countedQty = Number(countedTotals.get(partNo) || 0);
    const damageQty = Number(damageTotals.get(partNo) || 0);
    const physicalBins = binDisplay(related);
    const master = masterByPart.get(partNo);
    const partName = first.partName || (master ? master.partName : '');
    const category = first.category || (master ? master.category : '');
    const binLocation = first.binLocation || first.bin || (master ? master.binLocation || master.bin : '');
    const valueSummary = rowValueSummary(related, master || {});
    const mrp = valuationRateForDisplay(valueSummary);
    extraParts.push({
      partNo,
      partNumber: partNo,
      partName,
      model: first.model || '',
      year: first.year || '',
      category,
      bin: binLocation,
      binLocation,
      mrp,
      currentCatalogueMRP: valueSummary.currentCatalogueMRP,
      totalQty: valueSummary.totalQty,
      scannedQty: valueSummary.scannedQty,
      manualQty: valueSummary.manualQty,
      averageScannedMRP: valueSummary.averageScannedMRP,
      minScannedMRP: valueSummary.minScannedMRP,
      maxScannedMRP: valueSummary.maxScannedMRP,
      totalScanValue: valueSummary.totalScanValue,
      totalManualValue: valueSummary.totalManualValue,
      finalInventoryValue: valueSummary.finalInventoryValue,
      dlc: Number(first.dlc || 0),
      systemQty: 0,
      dmsQty: 0,
      physicalQty,
      shortQty: 0,
      excessQty: physicalQty,
      netDifference: physicalQty,
      countedQty,
      manualQty: valueSummary.manualQty,
      damageQty,
      totalAuditQty: physicalQty,
      saleQtyLast12Months: Number(saleQtyLast12Months.get(partNo) || 0),
      movementCodeA: Number(movementCounts.get(partNo) || 0),
      reservedQty: 0,
      physicalBin1: physicalBins.bin1,
      physicalBin2: physicalBins.bin2,
      physicalBin3: physicalBins.bin3,
      otherBinLocations: physicalBins.otherBins,
      systemBin1: '',
      systemBin2: '',
      systemBin3: '',
      systemMrpValue: 0,
      physicalMrpValue: valueSummary.finalInventoryValue,
      systemDlcValue: 0,
      physicalDlcValue: money(physicalQty * Number(first.dlc || 0)),
      differenceQty: physicalQty,
      varianceQty: physicalQty,
      varianceValue: valueSummary.finalInventoryValue,
      differenceMrpValue: valueSummary.finalInventoryValue,
      differenceDlcValue: money(physicalQty * Number(first.dlc || 0)),
      status: 'Extra Part',
      rawScanProof: related.map((scan) => scan.rawScan).filter(Boolean).slice(0, 5).join(' | ')
    });
  });

  const allFinalRows = rows.sort((a, b) => sortText(a.partNo, b.partNo));
  let finalRows = applyVarianceFilter(allFinalRows, query.varianceType);
  if (query.category) finalRows = finalRows.filter((row) => new RegExp(escapeRegExp(query.category), 'i').test(row.category || ''));
  if (query.bin) finalRows = finalRows.filter((row) => new RegExp(escapeRegExp(query.bin), 'i').test(row.binLocation || row.bin || ''));
  const categoryMap = new Map();
  finalRows.forEach((row) => {
    const key = row.category || 'Uncategorized';
    const item = categoryMap.get(key) || {
      category: key,
      systemQty: 0,
      physicalQty: 0,
      differenceQty: 0,
      differenceMrpValue: 0,
      differenceDlcValue: 0,
      matched: 0,
      short: 0,
      excess: 0
    };
    item.systemQty += row.systemQty;
    item.physicalQty += row.physicalQty;
    item.differenceQty += row.differenceQty;
    item.differenceMrpValue = money(item.differenceMrpValue + row.differenceMrpValue);
    item.differenceDlcValue = money(item.differenceDlcValue + row.differenceDlcValue);
    if (row.status === 'Matched') item.matched += 1;
    if (row.status === 'Short') item.short += 1;
    if (row.status === 'Excess' || row.status === 'Extra Part') item.excess += 1;
    categoryMap.set(key, item);
  });

  const now = new Date();
  const selectedDealer = query.dealerCode
    ? dealers.find((dealer) => dealer.dealerCode === String(query.dealerCode).trim().toUpperCase())
    : (query.dealerName ? dealers.find((dealer) => new RegExp(escapeRegExp(query.dealerName), 'i').test(dealer.dealerName || '')) : null);
  const selectedAudit = query.auditId
    ? audits.find((audit) => audit.auditId === String(query.auditId).trim())
    : (selectedDealer && selectedDealer.currentAuditId ? audits.find((audit) => audit.auditId === selectedDealer.currentAuditId) : null);
  const summary = [{
    generatedAt: formatIstDateTime(now),
    dealerName: query.dealerName || (selectedDealer ? selectedDealer.dealerName : 'All'),
    dealerCode: query.dealerCode || 'All',
    auditId: query.auditId || 'All',
    fromDate: query.from || '',
    toDate: query.to || '',
    category: query.category || 'All',
    partNumber: query.partNumber || 'All',
    binLocation: query.bin || 'All',
    varianceType: query.varianceType || 'All',
    scanType: query.type || 'All',
    totalMasterParts: masterParts.length,
    totalScans: scans.length,
    totalSystemQty: finalRows.reduce((sum, row) => sum + row.systemQty, 0),
    totalPhysicalQty: finalRows.reduce((sum, row) => sum + row.physicalQty, 0),
    totalSystemMrpValue: money(finalRows.reduce((sum, row) => sum + row.systemMrpValue, 0)),
    totalPhysicalMrpValue: money(finalRows.reduce((sum, row) => sum + row.physicalMrpValue, 0)),
    matched: finalRows.filter((row) => row.status === 'Matched').length,
    short: finalRows.filter((row) => row.status === 'Short').length,
    excess: finalRows.filter((row) => row.status === 'Excess' || row.status === 'Extra Part').length,
    notScanned: finalRows.filter((row) => row.physicalQty === 0 && row.systemQty > 0).length
  }];

  return {
    filters: query,
    summary,
    selectedDealer,
    selectedAudit,
    allFinalRows,
    finalRows,
    categoryRows: Array.from(categoryMap.values()).sort((a, b) => sortText(a.category, b.category)),
    scans,
    damageRows: scans.filter((scan) => scan.type === 'DAMAGE'),
    openingRows: masterParts,
    oilRows: finalRows.filter((row) => /oil|lube|lubricant/i.test(row.category || row.partName)),
    accessoryRows: finalRows.filter((row) => /accessor/i.test(row.category || row.partName)),
    nonMovingRows: finalRows.filter((row) => row.systemQty > 0 && row.physicalQty === 0),
    highValueNonMovingRows: finalRows.filter((row) => row.systemQty > 0 && row.physicalQty === 0 && row.mrp >= 5000).sort((a, b) => b.mrp - a.mrp),
    binRows: finalRows.map((row) => ({
      bin: row.bin,
      partNumber: row.partNumber || row.partNo,
      partDescription: row.partDescription || row.partName,
      productCategory: row.productCategory || row.category,
      systemQty: row.systemQty,
      physicalQty: row.physicalQty,
      differenceQty: row.differenceQty,
      status: row.status
    })),
    rawLogRows: finalRows.map((row) => ({
      partNumber: row.partNumber || row.partNo,
      countedQuantity: row.physicalQty,
      variance: row.differenceQty,
      action: actionForDifference(Number(row.differenceQty || 0)),
      status: row.status
    })),
    dealerBackupRows: dealers.map((dealer) => ({
      dealerName: dealer.dealerName,
      dealerCode: dealer.dealerCode,
      brand: dealer.brand,
      location: dealer.location,
      currentAuditId: dealer.currentAuditId,
      auditName: dealer.auditName,
      auditorName: dealer.auditorName,
      generalManager: dealer.generalManager,
      spmName: dealer.spmName
    })),
    dealers,
    audits
  };
}

function finalColumns() {
  return [
    { header: 'Part Number', key: 'partNumber', width: 16 },
    { header: 'Part Description', key: 'partDescription', width: 28 },
    { header: 'Model', key: 'model', width: 16 },
    { header: 'Manufacturing Year', key: 'manufacturingYear', width: 18 },
    { header: 'Product Category', key: 'productCategory', width: 20 },
    { header: 'Bin', key: 'bin', width: 14 },
    { header: 'Bin Loc 1', key: 'physicalBin1', width: 16 },
    { header: 'Bin Loc 2', key: 'physicalBin2', width: 16 },
    { header: 'Bin Loc 3', key: 'physicalBin3', width: 16 },
    { header: 'Other Bin Locations', key: 'otherBinLocations', width: 24 },
    { header: 'MRP', key: 'mrp', width: 12 },
    { header: 'SCAN UPI MRP', key: 'scanUPIMRP', width: 18 },
    { header: 'CURRENT CATALOGUE MRP', key: 'currentCatalogueMRP', width: 22 },
    { header: 'AVERAGE SCANNED MRP', key: 'averageScannedMRP', width: 22 },
    { header: 'PRICE PERIOD', key: 'pricePeriod', width: 30 },
    { header: 'PRICE AGEING DAYS', key: 'priceAgeingDays', width: 18 },
    { header: 'PART MOVEMENT', key: 'partMovement', width: 20 },
    { header: 'FINAL INVENTORY VALUE', key: 'finalInventoryValue', width: 22 },
    { header: 'DLC', key: 'dlc', width: 12 },
    { header: 'Product Group', key: 'productGroup', width: 18 },
    { header: 'Product SubGroup', key: 'partSubGroup', width: 18 },
    { header: 'System Qty', key: 'systemQty', width: 12 },
    { header: 'Physical Bin Qty', key: 'physicalBinQty', width: 16 },
    { header: 'Fitted Qty', key: 'fittedQty', width: 12 },
    { header: 'Actual Audit Qty', key: 'physicalQty', width: 16 },
    { header: 'Fitted Regd No', key: 'fittedRegdNo', width: 16 },
    { header: 'Fitted Job Card No', key: 'fittedJobCardNo', width: 18 },
    { header: 'Fitted Status', key: 'fittedStatus', width: 16 },
    { header: 'System MRP Value', key: 'systemMrpValue', width: 18 },
    { header: 'Physical MRP Value', key: 'physicalMrpValue', width: 18 },
    { header: 'System DLC Value', key: 'systemDlcValue', width: 18 },
    { header: 'Physical DLC Value', key: 'physicalDlcValue', width: 18 },
    { header: 'Difference Qty', key: 'differenceQty', width: 14 },
    { header: 'Difference MRP Value', key: 'differenceMrpValue', width: 20 },
    { header: 'Difference DLC Value', key: 'differenceDlcValue', width: 20 },
    { header: 'Dealer', key: 'dealer', width: 20 },
    { header: 'Date/Time', key: 'lastScanTime', width: 22 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Raw Scan Proof', key: 'rawScanProof', width: 40 }
  ];
}

function scanColumns() {
  return [
    { header: 'Time', key: 'time', width: 22 },
    { header: 'Part Number', key: 'partNumber', width: 16 },
    { header: 'Part Description', key: 'partDescription', width: 28 },
    { header: 'Model', key: 'model', width: 16 },
    { header: 'Manufacturing Year', key: 'manufacturingYear', width: 18 },
    { header: 'Product Category', key: 'productCategory', width: 20 },
    { header: 'MRP', key: 'mrp', width: 12 },
    { header: 'DLC', key: 'dlc', width: 12 },
    { header: 'Product Group', key: 'productGroup', width: 18 },
    { header: 'Product SubGroup', key: 'partSubGroup', width: 18 },
    { header: 'Qty', key: 'qty', width: 10 },
    { header: 'Type', key: 'type', width: 12 },
    { header: 'Bin', key: 'bin', width: 12 },
    { header: 'Regd No', key: 'regdNo', width: 16 },
    { header: 'Job Card No', key: 'jobCardNo', width: 18 },
    { header: 'Fitted Qty', key: 'fittedQty', width: 14 },
    { header: 'Auto Detected Bin', key: 'autoDetectedBin', width: 20 },
    { header: 'Stock Deducted From Bin', key: 'stockDeductedFromBin', width: 24 },
    { header: 'Dealer Code', key: 'dealerCode', width: 14 },
    { header: 'Dealer Name', key: 'dealerName', width: 24 },
    { header: 'Audit ID', key: 'auditId', width: 24 },
    { header: 'Device', key: 'deviceId', width: 20 },
    { header: 'Entry Mode', key: 'entryMode', width: 18 },
    { header: 'Entry Channel', key: 'entryChannel', width: 16 },
    { header: 'Entry Source', key: 'scanSourceLabel', width: 24 },
    { header: 'Staff', key: 'staffName', width: 18 },
    { header: 'Raw Scan', key: 'rawScan', width: 45 },
    { header: 'Warnings', key: 'warnings', width: 32 }
  ];
}

async function createWorkbook(query) {
  const data = await buildReportData(query);
  const categoryVarianceData = await buildCategoryWiseVarianceSummary(query);
  const partwiseInventoryAuditData = await buildPartwiseInventoryAuditReport(query);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Daksh Inventory v2';
  workbook.created = new Date();

  addSheet(workbook, 'Audit Summary', [
    { header: 'Generated At', key: 'generatedAt', width: 24 },
    { header: 'Dealer Code', key: 'dealerCode', width: 16 },
    { header: 'Audit ID', key: 'auditId', width: 24 },
    { header: 'From Date', key: 'fromDate', width: 14 },
    { header: 'To Date', key: 'toDate', width: 14 },
    { header: 'Category', key: 'category', width: 18 },
    { header: 'Scan Type', key: 'scanType', width: 12 },
    { header: 'Master Parts', key: 'totalMasterParts', width: 14 },
    { header: 'Scans', key: 'totalScans', width: 10 },
    { header: 'System Qty', key: 'totalSystemQty', width: 14 },
    { header: 'Physical Qty', key: 'totalPhysicalQty', width: 14 },
    { header: 'System MRP Value', key: 'totalSystemMrpValue', width: 18 },
    { header: 'Physical MRP Value', key: 'totalPhysicalMrpValue', width: 18 },
    { header: 'Matched', key: 'matched', width: 10 },
    { header: 'Short', key: 'short', width: 10 },
    { header: 'Excess', key: 'excess', width: 10 },
    { header: 'Not Scanned', key: 'notScanned', width: 14 }
  ], data.summary);

  addSheet(workbook, 'Final Compile Report', finalColumns(), data.finalRows);
  addPartwiseInventoryAuditSheet(workbook, partwiseInventoryAuditData);
  addCategoryWiseVarianceSheet(workbook, categoryVarianceData);

  addSheet(workbook, 'Counting Raw Data', scanColumns(), data.scans.map((scan) => ({ ...scan, time: scan.timestamp, warnings: (scan.warnings || []).join(', ') })));
  addSheet(workbook, 'Damage Report', scanColumns(), data.damageRows.map((scan) => ({ ...scan, time: scan.timestamp, warnings: (scan.warnings || []).join(', ') })));
  addSheet(workbook, 'Opening Stock / DMS Stock', [
    { header: 'Part Number', key: 'partNumber', width: 16 },
    { header: 'Part Description', key: 'partDescription', width: 28 },
    { header: 'Model', key: 'model', width: 16 },
    { header: 'Year', key: 'year', width: 10 },
    { header: 'Category', key: 'category', width: 18 },
    { header: 'MRP', key: 'mrp', width: 12 },
    { header: 'DLC', key: 'dlc', width: 12 },
    { header: 'Bin', key: 'bin', width: 12 },
    { header: 'Active Status', key: 'activeStatus', width: 14 },
    { header: 'Opening Stock Qty', key: 'openingStockQty', width: 18 }
  ], data.openingRows);
  addSheet(workbook, 'Transaction Log', scanColumns(), data.scans.map((scan) => ({ ...scan, time: scan.timestamp, warnings: (scan.warnings || []).join(', ') })));
  addSheet(workbook, 'Oil / Lube Report', finalColumns(), data.oilRows);
  addSheet(workbook, 'Accessories Report', finalColumns(), data.accessoryRows);
  addSheet(workbook, 'Non Moving Parts', finalColumns(), data.nonMovingRows);
  addSheet(workbook, 'High Value Non Moving Parts', finalColumns(), data.highValueNonMovingRows);
  addSheet(workbook, 'Bin Location Report', [
    { header: 'Bin', key: 'bin', width: 16 },
    { header: 'Part Number', key: 'partNumber', width: 16 },
    { header: 'Part Description', key: 'partDescription', width: 28 },
    { header: 'Model', key: 'model', width: 16 },
    { header: 'Manufacturing Year', key: 'manufacturingYear', width: 18 },
    { header: 'Product Category', key: 'productCategory', width: 20 },
    { header: 'MRP', key: 'mrp', width: 12 },
    { header: 'DLC', key: 'dlc', width: 12 },
    { header: 'Product Group', key: 'productGroup', width: 18 },
    { header: 'Product SubGroup', key: 'partSubGroup', width: 18 },
    { header: 'System Qty', key: 'systemQty', width: 14 },
    { header: 'Physical Bin Qty', key: 'physicalBinQty', width: 18 },
    { header: 'Actual Audit Qty', key: 'actualAuditQty', width: 18 },
    { header: 'Part Total Physical Qty', key: 'partLevelPhysicalQty', width: 22 },
    { header: 'Part Level Difference Qty', key: 'differenceQty', width: 22 },
    { header: 'Status', key: 'status', width: 14 }
  ], data.binRows);
  addSheet(workbook, 'Raw UPI Scan Log', [
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
  ], data.rawLogRows);
  addSheet(workbook, 'Dealer Backup Data', [
    { header: 'Dealer Name', key: 'dealerName', width: 26 },
    { header: 'Dealer Code', key: 'dealerCode', width: 16 },
    { header: 'Brand', key: 'brand', width: 16 },
    { header: 'Location', key: 'location', width: 20 },
    { header: 'Current Audit ID', key: 'currentAuditId', width: 28 },
    { header: 'Audit Name', key: 'auditName', width: 24 },
    { header: 'Auditor Name', key: 'auditorName', width: 20 },
    { header: 'General Manager', key: 'generalManager', width: 20 },
    { header: 'SPM Name', key: 'spmName', width: 20 }
  ], data.dealerBackupRows);

  return { workbook, data };
}

function professionalReport(kind) {
  return PROFESSIONAL_REPORTS[kind] ? kind : null;
}

function mainAuditColumns() {
  return [
    { header: 'PART NUMBER', key: 'partNumber', width: 18 },
    { header: 'PART DESCRIPTION', key: 'partDescription', width: 36 },
    { header: 'MODEL', key: 'model', width: 16 },
    { header: 'MANUFACTURING YEAR', key: 'manufacturingYear', width: 20 },
    { header: 'CATEGORY', key: 'category', width: 20 },
    { header: 'BIN', key: 'bin', width: 16 },
    { header: 'MRP', key: 'mrp', width: 12, numFmt: '#,##0.00' },
    { header: 'SCAN UPI MRP', key: 'scanUPIMRP', width: 18 },
    { header: 'CURRENT CATALOGUE MRP', key: 'currentCatalogueMRP', width: 22, numFmt: '#,##0.00' },
    { header: 'AVERAGE SCANNED MRP', key: 'averageScannedMRP', width: 22, numFmt: '#,##0.00' },
    { header: 'PRICE PERIOD', key: 'pricePeriod', width: 30 },
    { header: 'PRICE AGEING DAYS', key: 'priceAgeingDays', width: 18, numFmt: '#,##0' },
    { header: 'PART MOVEMENT', key: 'partMovement', width: 20 },
    { header: 'FINAL INVENTORY VALUE', key: 'finalInventoryValue', width: 22, numFmt: '#,##0.00' },
    { header: 'DLC', key: 'dlc', width: 12, numFmt: '#,##0.00' },
    { header: 'PRODUCT GROUP', key: 'productGroup', width: 18 },
    { header: 'PRODUCT SUBGROUP', key: 'partSubGroup', width: 18 },
    { header: 'DMS QTY', key: 'dmsQty', width: 12, numFmt: '#,##0.00' },
    { header: 'PHYSICAL BIN QTY', key: 'physicalBinQty', width: 18, numFmt: '#,##0.00' },
    { header: 'ACTUAL AUDIT QTY', key: 'physicalQty', width: 18, numFmt: '#,##0.00' },
    { header: 'FITTED QTY', key: 'fittedQty', width: 14, numFmt: '#,##0.00' },
    { header: 'FITTED REGD NO', key: 'regdNo', width: 16 },
    { header: 'FITTED JOB CARD NO', key: 'jobCardNo', width: 18 },
    { header: 'FITTED STATUS', key: 'fittedStatus', width: 16 },
    { header: 'SHORT QTY', key: 'shortQty', width: 12, numFmt: '#,##0.00' },
    { header: 'EXCESS QTY', key: 'excessQty', width: 12, numFmt: '#,##0.00' },
    { header: 'NET DIFFERENCE', key: 'netDifference', width: 16, numFmt: '#,##0.00' },
    { header: 'SCAN TYPE', key: 'scanType', width: 18 },
    { header: 'DEALER', key: 'dealer', width: 24 },
    { header: 'LAST SCAN TIME', key: 'lastScanTime', width: 22 }
  ];
}

function compileAuditColumns() {
  return mainAuditColumns();
}

function consolidatedColumns() {
  return mainAuditColumns();
}

function mainAuditRows(data) {
  return data.finalRows.map((row) => ({
    partNumber: row.partNumber || row.partNo,
    partDescription: row.partDescription || row.partName,
    model: row.model,
    manufacturingYear: row.manufacturingYear || row.year,
    category: row.category,
    bin: row.binLocation || row.bin,
    physicalBin1: row.physicalBin1 || row.binLoc1 || '',
    physicalBin2: row.physicalBin2 || row.binLoc2 || '',
    physicalBin3: row.physicalBin3 || row.binLoc3 || '',
    otherBinLocations: row.otherBinLocations || '',
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
    fittedQty: row.fittedQty || 0,
    regdNo: row.fittedRegdNo || row.regdNo || '',
    jobCardNo: row.fittedJobCardNo || row.jobCardNo || '',
    fittedRegdNo: row.fittedRegdNo || row.regdNo || '',
    fittedJobCardNo: row.fittedJobCardNo || row.jobCardNo || '',
    fittedStatus: row.fittedStatus || (Number(row.fittedQty || 0) > 0 ? 'Fitted' : 'Not Fitted'),
    shortQty: row.shortQty,
    excessQty: row.excessQty,
    netDifference: row.netDifference,
    scanType: row.scanType,
    dealer: row.dealer,
    lastScanTime: row.lastScanTime
  }));
}

function compileAuditRows(data) {
  return mainAuditRows(data);
}

function consolidatedRows(data) {
  return mainAuditRows(data);
}

function previewForReport(kind, data) {
  if (kind === 'compile') return { columns: compileAuditColumns(), rows: compileAuditRows(data) };
  if (kind === 'consolidated') return { columns: consolidatedColumns(), rows: consolidatedRows(data) };
  return { columns: mainAuditColumns(), rows: mainAuditRows(data) };
}

function addFormulaSheet(workbook, name, columns, rows) {
  const sheet = workbook.addWorksheet(name.slice(0, 31));
  sheet.columns = columns.map((column) => ({
    header: column.header,
    key: column.key,
    width: column.width || 18
  }));
  rows.forEach((rowData) => {
    const rowNumber = sheet.rowCount + 1;
    const excelRow = {};
    columns.forEach((column) => {
      excelRow[column.key] = column.formula
        ? { formula: column.formula(rowNumber), result: rowData[column.key] }
        : rowData[column.key];
    });
    sheet.addRow(excelRow);
  });
  columns.forEach((column, index) => {
    if (column.numFmt) sheet.getColumn(index + 1).numFmt = column.numFmt;
  });
  applyHeaderStyle(sheet);
  sheet.eachRow((row, rowNumber) => {
    row.height = rowNumber === 1 ? 28 : 21;
    row.eachCell((cell) => {
      cell.alignment = { vertical: 'middle', wrapText: true };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
      };
    });
  });
  return sheet;
}

function addOverviewSheet(workbook, data) {
  const summary = data.summary[0] || {};
  const rows = [
    { metric: 'Generated At', value: summary.generatedAt },
    { metric: 'Dealer Name', value: summary.dealerName },
    { metric: 'Dealer Code', value: summary.dealerCode },
    { metric: 'Audit ID', value: summary.auditId },
    { metric: 'Audit Date From', value: summary.fromDate },
    { metric: 'Audit Date To', value: summary.toDate },
    { metric: 'Category', value: summary.category },
    { metric: 'Part Number', value: summary.partNumber },
    { metric: 'Bin Location', value: summary.binLocation },
    { metric: 'Variance Type', value: summary.varianceType },
    { metric: 'System Qty', value: summary.totalSystemQty },
    { metric: 'Physical Qty', value: summary.totalPhysicalQty },
    { metric: 'System MRP Value', value: summary.totalSystemMrpValue },
    { metric: 'Physical MRP Value', value: summary.totalPhysicalMrpValue },
    { metric: 'Matched Lines', value: summary.matched },
    { metric: 'Short Lines', value: summary.short },
    { metric: 'Excess Lines', value: summary.excess },
    { metric: 'Not Scanned Lines', value: summary.notScanned }
  ];
  return addSheet(workbook, 'Report Overview', [
    { header: 'Metric', key: 'metric', width: 28 },
    { header: 'Value', key: 'value', width: 34 }
  ], rows);
}

function categoryActionRows(rows) {
  const map = new Map();
  rows.forEach((row) => {
    const action = actionForDifference(row.differenceQty);
    const key = `${row.category || 'Uncategorized'}:${action}`;
    const current = map.get(key) || {
      category: row.category || 'Uncategorized',
      action,
      lines: 0,
      varianceMrp: 0,
      varianceDlc: 0
    };
    current.lines += 1;
    current.varianceMrp = money(current.varianceMrp + Number(row.differenceMrpValue || 0));
    current.varianceDlc = money(current.varianceDlc + Number(row.differenceDlcValue || 0));
    map.set(key, current);
  });
  return Array.from(map.values()).sort((a, b) => sortText(a.category, b.category) || sortText(a.action, b.action));
}

function countingRows(data) {
  return data.scans.map((scan) => ({
    username: scan.staffName || '',
    partNo: scan.part,
    location: scan.bin || scan.binLocation || '',
    description: scan.partName || '',
    landedCost: Number(scan.valuationMRP || 0),
    count: Number(scan.qty || 0),
    finalCount: Number(scan.qty || 0),
    category: scan.category || '',
    remark: (scan.warnings || []).length ? (scan.warnings || []).join(', ') : 'OK',
    notInPartMaster: (scan.warnings || []).some((warning) => /not found|unknown|does not exist/i.test(warning)) ? 'Yes' : '',
    dateCreated: scan.timestamp,
    dateModified: scan.updatedAt || '',
    transactedPart: ['OUTWARD', 'FITTED'].includes(scan.type) ? 'Yes' : 'No'
  }));
}

function stockRows(data) {
  return data.openingRows.map((part) => ({
    partNo: part.partNo,
    hsn: part.hsn || '',
    partDescription: part.partDescription || part.partName,
    stockOnHand: Number(part.openingStockQty || 0),
    mrp: Number(part.mrp || 0),
    dlc: Number(part.dlc || 0),
    reserved: Number(part.reservedQty || 0),
    moq: Number(part.moq || 0),
    actualStockOnHand: Number(part.quantity || part.openingStockQty || 0),
    exposeFlag: part.activeStatus === false ? 'N' : 'Y',
    category: part.productCategory || part.category,
    productCategory: part.productCategory || part.category,
    productType: part.productType || '',
    bin: part.bin
  }));
}

function damageRows(data) {
  return data.damageRows.map((scan) => ({
    username: scan.staffName || '',
    partNo: scan.part,
    location: scan.bin || scan.binLocation || '',
    description: scan.partName || '',
    landedCost: Number(scan.valuationMRP || 0),
    count: Number(scan.qty || 0),
    finalCount: Number(scan.qty || 0),
    value: Number(scanValueRow(scan).finalInventoryValue || 0),
    category: scan.category || '',
    remark: 'Damaged',
    dateCreated: scan.timestamp,
    dateModified: scan.updatedAt || ''
  }));
}

function addMainSupportSheets(workbook, data, categoryVarianceData) {
  addOverviewSheet(workbook, data);
  addCategoryWiseVarianceSheet(workbook, categoryVarianceData);
  addFormulaSheet(workbook, 'Non Moving Parts', mainAuditColumns().slice(0, 16), mainAuditRows({ finalRows: data.finalRows.filter((row) => row.systemQty > 0 && row.physicalQty === 0) }));
  addSheet(workbook, 'Bin Location Report', [
    { header: 'Part Number', key: 'partNo', width: 18 },
    { header: 'Part Description', key: 'partName', width: 34 },
    { header: 'Physical Quantity', key: 'physicalQty', width: 18 },
    { header: 'Bin Loc 1', key: 'physicalBin1', width: 16 },
    { header: 'Bin Loc 2', key: 'physicalBin2', width: 16 },
    { header: 'Bin Loc 3', key: 'physicalBin3', width: 16 },
    { header: 'Other Bin Locations', key: 'otherBinLocations', width: 24 },
    { header: 'System Bin Loc 1', key: 'systemBin1', width: 18 },
    { header: 'System Bin Loc 2', key: 'systemBin2', width: 18 },
    { header: 'System Bin Loc 3', key: 'systemBin3', width: 18 }
  ], data.finalRows);
}

function addCompileSupportSheets(workbook, data) {
  addOverviewSheet(workbook, data);
  addSheet(workbook, 'Parts Summary', [
    { header: 'Category', key: 'category', width: 24 },
    { header: 'DMS Stock Value', key: 'systemValue', width: 18 },
    { header: 'DMS Part Lines', key: 'systemLines', width: 16 },
    { header: 'DMS Quantity', key: 'systemQty', width: 16 },
    { header: 'Physical Stock Value', key: 'physicalValue', width: 20 },
    { header: 'Physical Part Lines', key: 'physicalLines', width: 18 },
    { header: 'Physical Quantity', key: 'physicalQty', width: 18 },
    { header: 'Excess Found Value', key: 'excessValue', width: 18 },
    { header: 'Excess Lines', key: 'excessLines', width: 14 },
    { header: 'Short Found Value', key: 'shortValue', width: 18 },
    { header: 'Short Lines', key: 'shortLines', width: 14 }
  ], data.categoryRows.map((row) => ({
    category: row.category,
    systemValue: money(data.finalRows.filter((item) => (item.category || 'Uncategorized') === row.category).reduce((sum, item) => sum + Number(item.systemDlcValue || 0), 0)),
    systemLines: data.finalRows.filter((item) => (item.category || 'Uncategorized') === row.category && Number(item.systemQty || 0) > 0).length,
    systemQty: row.systemQty,
    physicalValue: money(data.finalRows.filter((item) => (item.category || 'Uncategorized') === row.category).reduce((sum, item) => sum + Number(item.physicalDlcValue || 0), 0)),
    physicalLines: data.finalRows.filter((item) => (item.category || 'Uncategorized') === row.category && Number(item.physicalQty || 0) > 0).length,
    physicalQty: row.physicalQty,
    excessValue: money(data.finalRows.filter((item) => (item.category || 'Uncategorized') === row.category && Number(item.differenceDlcValue || 0) > 0).reduce((sum, item) => sum + Number(item.differenceDlcValue || 0), 0)),
    excessLines: row.excess,
    shortValue: money(data.finalRows.filter((item) => (item.category || 'Uncategorized') === row.category && Number(item.differenceDlcValue || 0) < 0).reduce((sum, item) => sum + Number(item.differenceDlcValue || 0), 0)),
    shortLines: row.short
  })));
  addSheet(workbook, 'Counting Data', [
    { header: 'Username', key: 'username', width: 18 },
    { header: 'Part Number', key: 'partNo', width: 18 },
    { header: 'Location', key: 'location', width: 14 },
    { header: 'Description', key: 'description', width: 34 },
    { header: 'Landed Cost', key: 'landedCost', width: 14 },
    { header: 'Count', key: 'count', width: 10 },
    { header: 'Final Count', key: 'finalCount', width: 12 },
    { header: 'Category', key: 'category', width: 18 },
    { header: 'Remark', key: 'remark', width: 26 },
    { header: 'Not In Part Master', key: 'notInPartMaster', width: 18 },
    { header: 'Date Created', key: 'dateCreated', width: 22 },
    { header: 'Date Modified', key: 'dateModified', width: 22 },
    { header: 'Transacted Part', key: 'transactedPart', width: 16 }
  ], countingRows(data));
  addSheet(workbook, 'Stock Data', [
    { header: 'Part Number', key: 'partNo', width: 18 },
    { header: 'HSN', key: 'hsn', width: 12 },
    { header: 'Part Description', key: 'partDescription', width: 34 },
    { header: 'Stock on Hand', key: 'stockOnHand', width: 14 },
    { header: 'MRP', key: 'mrp', width: 12 },
    { header: 'DLC', key: 'dlc', width: 12 },
    { header: 'On Hand Reserved', key: 'reserved', width: 16 },
    { header: 'MOQ', key: 'moq', width: 10 },
    { header: 'Actual Stock on Hand', key: 'actualStockOnHand', width: 18 },
    { header: 'Expose Flag', key: 'exposeFlag', width: 12 },
    { header: 'Category', key: 'category', width: 18 },
    { header: 'Product Type', key: 'productType', width: 18 },
    { header: 'Bin Location', key: 'bin', width: 16 }
  ], stockRows(data));
  addSheet(workbook, 'Damage Report', [
    { header: 'Username', key: 'username', width: 18 },
    { header: 'Part Number', key: 'partNo', width: 18 },
    { header: 'Location', key: 'location', width: 14 },
    { header: 'Description', key: 'description', width: 34 },
    { header: 'Landed Cost', key: 'landedCost', width: 14 },
    { header: 'Count', key: 'count', width: 10 },
    { header: 'Final Count', key: 'finalCount', width: 12 },
    { header: 'Value', key: 'value', width: 14 },
    { header: 'Category', key: 'category', width: 18 },
    { header: 'Remark', key: 'remark', width: 16 },
    { header: 'Date Created', key: 'dateCreated', width: 22 },
    { header: 'Date Modified', key: 'dateModified', width: 22 }
  ], damageRows(data));
}

async function createProfessionalWorkbook(kind, query) {
  const data = await buildReportData(query);
  const categoryVarianceData = await buildCategoryWiseVarianceSummary(query);
  const report = PROFESSIONAL_REPORTS[kind];
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Daksh Inventory';
  workbook.created = new Date();

  if (kind === 'main') {
    addFormulaSheet(workbook, report.title, mainAuditColumns(), mainAuditRows(data));
    addMainSupportSheets(workbook, data, categoryVarianceData);
  } else if (kind === 'compile') {
    addFormulaSheet(workbook, report.title, compileAuditColumns(), compileAuditRows(data));
    addCompileSupportSheets(workbook, data);
  } else {
    addFormulaSheet(workbook, 'Main Inventory Audit Report', mainAuditColumns(), mainAuditRows(data));
    addFormulaSheet(workbook, 'Compile Audit Report', compileAuditColumns(), compileAuditRows(data));
    addFormulaSheet(workbook, 'Consolidated Final Report', consolidatedColumns(), consolidatedRows(data));
    addCategoryWiseVarianceSheet(workbook, categoryVarianceData);
  }

  return { workbook, data };
}

function pdfColumnsFor(kind) {
  if (kind === 'compile') return compileAuditColumns();
  if (kind === 'consolidated') return consolidatedColumns();
  return mainAuditColumns();
}

function pdfRowsFor(kind, data) {
  if (kind === 'compile') return compileAuditRows(data);
  if (kind === 'consolidated') return consolidatedRows(data);
  return mainAuditRows(data);
}

function buildProfessionalPdfBuffer(kind, data) {
  const report = PROFESSIONAL_REPORTS[kind];
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a3' });
  const summary = data.summary[0] || {};
  const sections = kind === 'consolidated'
    ? [
      { title: 'Main Inventory Audit Report', columns: mainAuditColumns(), rows: mainAuditRows(data) },
      { title: 'Compile Audit Report', columns: compileAuditColumns(), rows: compileAuditRows(data) },
      { title: 'Consolidated Final Report', columns: consolidatedColumns(), rows: consolidatedRows(data) }
    ]
    : [{ title: report.title, columns: pdfColumnsFor(kind), rows: pdfRowsFor(kind, data) }];

  sections.forEach((section, index) => {
    if (index) doc.addPage();
    doc.setFontSize(15);
    doc.text(section.title, 28, 30);
    doc.setFontSize(8);
    doc.text(`Dealer: ${summary.dealerName || 'All'} | Code: ${summary.dealerCode || 'All'} | Date: ${summary.fromDate || 'All'} to ${summary.toDate || 'All'} | Generated: ${summary.generatedAt || ''}`, 28, 46);
    autoTable(doc, {
      startY: 62,
      head: [section.columns.map((column) => column.header)],
      body: section.rows.slice(0, 500).map((row) => section.columns.map((column) => {
        const value = row[column.key];
        return value instanceof Date ? formatDate(value) : String(value ?? '');
      })),
      styles: { fontSize: section.columns.length > 18 ? 5 : 7, cellPadding: 2, overflow: 'linebreak' },
      headStyles: { fillColor: [21, 58, 91], textColor: [255, 255, 255] },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      margin: { left: 18, right: 18 }
    });
  });

  return Buffer.from(doc.output('arraybuffer'));
}

function masterKey(partNumber, dealerCode = '') {
  return `${normalizePartNumber(partNumber)}::${cleanText(dealerCode).toUpperCase()}`;
}

function masterPartNumber(master = {}) {
  return normalizePartNumber(master.normalizedPartNumber || master.partNo || master.partNumber || master.part);
}

function masterDescription(master = {}) {
  return realReportText(master.partDescription || master.partName || master.name || master.description);
}

function masterCategory(master = {}) {
  return realReportText(master.productCategory || master.category || master.partCategory || master.categories);
}

function rowDescription(scan = {}, master = {}) {
  const hasMaster = Boolean(master && (master.partNo || master.partNumber || master.normalizedPartNumber));
  return masterDescription(master) || (hasMaster ? '' : 'Not in Master');
}

function rowCategory(scan = {}, master = {}) {
  const hasMaster = Boolean(master && (master.partNo || master.partNumber || master.normalizedPartNumber));
  return masterCategory(master) || (hasMaster ? '' : 'Not in Master');
}

function unknownIfBlank(value) {
  return realReportText(value) || 'UNKNOWN';
}

function showFullMasterWithZeroScan(query = {}) {
  return ['1', 'true', 'on', 'yes', 'full-master', 'master'].includes(String(query.showFullMasterWithZeroScan || query.includeFullMaster || query.reportDataMode || '').trim().toLowerCase());
}

function realReportText(value) {
  const text = cleanText(value);
  return /^not\s+in\s+master$/i.test(text) ? '' : text;
}

function masterQty(master = {}) {
  return Number(master.qty !== undefined ? master.qty : master.openingStockQty !== undefined ? master.openingStockQty : master.quantity || 0);
}

function enrichScan(scan = {}, master = {}) {
  master = master || {};
  scan = decorateScanValue(scan);
  const partNo = normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part);
  const hasMaster = Boolean(master && (master.partNo || master.partNumber || master.normalizedPartNumber));
  const binLocation = scan.binLocation || scan.bin || master.binLocation || master.bin || '';
  const year = hasMaster ? master.manufacturingYear || master.year || '' : '';
  const qty = Number(scan.qty || scan.quantity || 0);
  const partDescription = rowDescription(scan, hasMaster ? master : {});
  const category = rowCategory(scan, hasMaster ? master : {});
  const source = scanSourceLabels(scan);
  const enriched = {
    ...scan,
    scanId: scan.scanId || scan.uniqueScanId || String(scan._id || ''),
    rawUpi: scan.rawUpi || scan.rawScan || scan.rawScanString || '',
    part: partNo,
    partNo,
    partNumber: partNo,
    normalizedPartNumber: partNo,
    partName: partDescription,
    partDescription,
    model: hasMaster ? master.model || '' : '',
    year,
    manufacturingYear: year,
    category,
    productCategory: category,
    bin: binLocation,
    binLocation,
    mrp: Number(scan.valuationMRP || 0),
    scanMRP: Number(scan.scanMRP || 0),
    manualMRP: Number(scan.manualMRP || 0),
    valuationMRP: Number(scan.valuationMRP || 0),
    valuationSource: scan.valuationSource || '',
    finalInventoryValue: Number(scan.finalInventoryValue || 0),
    currentCatalogueMRP: Number(master.mrp || 0),
    dlc: Number(master.dlc !== undefined ? master.dlc : scan.dlc || 0),
    productGroup: hasMaster ? master.productGroup || scan.productGroup || '' : scan.productGroup || '',
    partSubGroup: hasMaster ? master.partSubGroup || scan.partSubGroup || '' : scan.partSubGroup || '',
    qty,
    quantity: qty,
    type: scan.type || scan.scanType || '',
    scanType: scan.scanType || scan.type || '',
    dealerCode: scan.dealerCode || master.dealerCode || '',
    dealerName: scan.dealerName || master.dealerName || '',
    entryMode: source.entryMode,
    entryChannel: source.entryChannel,
    scanSourceLabel: source.scanSourceLabel,
    masterFound: hasMaster,
    dmsQty: hasMaster ? masterQty(master) : 0,
    systemQty: hasMaster ? masterQty(master) : 0
  };
  console.log("Report part:", enriched.partNumber);
  console.log("Scan normalized:", enriched.normalizedPartNumber);
  console.log("Master found:", hasMaster);
  console.log("Master data:", hasMaster ? master : null);
  console.log("Final report row:", enriched);
  return enriched;
}

function scanBasedFilter(query = {}) {
  query = normalizeReportQuery(query);
  console.log("Report dealerCode:", query.dealerCode || 'All');
  const filter = inventoryRoute.buildListQuery(query);
  inventoryRoute.applyTestScanMode(filter, 'real');
  if (!query.scanStatus) {
    filter.$and = (filter.$and || []).concat([{
      $or: [
        { scanStatus: { $in: ['ACCEPTED', 'SUPERVISOR_APPROVED', 'OUTWARD_DONE'] } },
        { scanStatus: { $exists: false } },
        { scanStatus: '' },
        { scanStatus: null }
      ]
    }]);
  }
  delete filter.category;
  if (query.type) filter.$or = [{ type: String(query.type).trim().toUpperCase() }, { scanType: String(query.type).trim().toUpperCase() }];
  if (query.partNumber) {
    const part = normalizePartNumber(query.partNumber);
    const partClause = { $or: [{ part: { $regex: escapeRegExp(part), $options: 'i' } }, { partNumber: { $regex: escapeRegExp(part), $options: 'i' } }, { normalizedPartNumber: { $regex: escapeRegExp(part), $options: 'i' } }] };
    filter.$and = (filter.$and || []).concat([partClause]);
  }
  if (query.bin) {
    filter.$and = (filter.$and || []).concat([{ $or: [{ bin: { $regex: escapeRegExp(query.bin), $options: 'i' } }, { binLocation: { $regex: escapeRegExp(query.bin), $options: 'i' } }] }]);
  }
  if (query.model) filter.model = { $regex: escapeRegExp(query.model), $options: 'i' };
  if (query.year) {
    filter.$and = (filter.$and || []).concat([{ $or: [{ year: { $regex: escapeRegExp(query.year), $options: 'i' } }, { manufacturingYear: { $regex: escapeRegExp(query.year), $options: 'i' } }] }]);
  }
  if (query.productGroup) filter.productGroup = { $regex: escapeRegExp(query.productGroup), $options: 'i' };
  if (query.partSubGroup || query.productSubGroup) filter.partSubGroup = { $regex: escapeRegExp(query.partSubGroup || query.productSubGroup), $options: 'i' };
  if (query.dealerName) filter.dealerName = { $regex: escapeRegExp(query.dealerName), $options: 'i' };
  applyReportMetadataFilters(filter, query);
  return filter;
}

function partsRefreshScanTypeExpression() {
  return { $toUpper: { $ifNull: ['$scanType', { $ifNull: ['$type', ''] }] } };
}

function partsRefreshPhysicalBinQtyExpression() {
  const qtyValue = { $ifNull: ['$qty', { $ifNull: ['$quantity', 0] }] };
  const qtyAbs = { $abs: qtyValue };
  const typeValue = partsRefreshScanTypeExpression();
  return {
    $cond: [
      { $in: [typeValue, ['OUTWARD', 'DAMAGE']] },
      { $multiply: [qtyAbs, -1] },
      {
        $cond: [
          { $eq: [typeValue, 'FITTED'] },
          0,
          qtyAbs
        ]
      }
    ]
  };
}

function partsRefreshFittedQtyExpression() {
  const qtyValue = { $ifNull: ['$fittedQty', { $ifNull: ['$qty', { $ifNull: ['$quantity', 0] }] }] };
  return {
    $cond: [
      { $eq: [partsRefreshScanTypeExpression(), 'FITTED'] },
      { $abs: qtyValue },
      0
    ]
  };
}

function partsRefreshFittedFieldExpression(field) {
  return {
    $cond: [
      { $eq: [partsRefreshScanTypeExpression(), 'FITTED'] },
      { $ifNull: [`$${field}`, ''] },
      ''
    ]
  };
}

function partsRefreshPhysicalBinExpression() {
  return {
    $cond: [
      { $eq: [partsRefreshScanTypeExpression(), 'FITTED'] },
      '',
      { $ifNull: ['$binLocation', '$bin'] }
    ]
  };
}

async function buildPartsInventoryRefreshRows(query = {}) {
  const filter = scanBasedFilter(query);
  filter.$and = (filter.$and || []).concat([
    { syncStatus: { $nin: ['duplicate', 'rejected', 'failed'] } },
    { isDuplicate: { $ne: true } }
  ]);

  const rows = await Inventory.aggregate([
    { $match: filter },
    {
      $group: {
        _id: { $ifNull: ['$normalizedPartNumber', { $ifNull: ['$partNumber', '$part'] }] },
        partNumber: { $first: { $ifNull: ['$partNumber', '$part'] } },
        physicalBinQty: { $sum: partsRefreshPhysicalBinQtyExpression() },
        fittedQty: { $sum: partsRefreshFittedQtyExpression() },
        bins: { $addToSet: partsRefreshPhysicalBinExpression() },
        fittedRegdNos: { $addToSet: partsRefreshFittedFieldExpression('regdNo') },
        fittedJobCardNos: { $addToSet: partsRefreshFittedFieldExpression('jobCardNo') }
      }
    },
    { $match: { _id: { $nin: [null, ''] } } },
    { $sort: { _id: 1 } }
  ]);

  return rows.map((row) => ({
    partNumber: row.partNumber || row._id,
    quantity: Number(row.physicalBinQty || 0) + Number(row.fittedQty || 0),
    qty: Number(row.physicalBinQty || 0) + Number(row.fittedQty || 0),
    physicalBinQty: Number(row.physicalBinQty || 0),
    fittedQty: Number(row.fittedQty || 0),
    fittedRegdNo: Array.from(new Set((row.fittedRegdNos || []).map(cleanText).filter(Boolean))).sort().join(', '),
    fittedJobCardNo: Array.from(new Set((row.fittedJobCardNos || []).map(cleanText).filter(Boolean))).sort().join(', '),
    binLocations: Array.from(new Set((row.bins || []).flatMap(splitAllBins))).sort()
  }));
}

function partsInventoryRefreshCsv(rows = []) {
  const maxBinCount = Math.max(1, ...rows.map((row) => (row.binLocations || []).length));
  const binHeaders = Array.from({ length: maxBinCount }, (_, index) => `Bin Loc ${index + 1}`);
  const lines = [
    ['Part Number', 'Qty', 'Physical Bin Qty', 'Fitted Qty', 'Fitted Regd No', 'Fitted Job Card No', ...binHeaders].map(csvCell).join(',')
  ];
  rows.forEach((row) => {
    const binLocations = row.binLocations || [];
    const binCells = Array.from({ length: maxBinCount }, (_, index) => binLocations[index] || '');
    lines.push([row.partNumber, row.quantity, row.physicalBinQty, row.fittedQty, row.fittedRegdNo, row.fittedJobCardNo, ...binCells].map(csvCell).join(','));
  });
  return `${lines.join('\r\n')}\r\n`;
}

function finalReportCsv(rows = []) {
  const columns = [
    ['Part Number', (row) => row.partNo || row.partNumber || ''],
    ['Part Description', (row) => row.partDescription || row.partName || ''],
    ['Model', (row) => row.model || ''],
    ['Year', (row) => row.manufacturingYear || row.year || ''],
    ['Category', (row) => row.category || row.productCategory || ''],
    ['MRP', (row) => row.mrp || ''],
    ['SCAN UPI MRP', (row) => row.scanUPIMRP || ''],
    ['CURRENT CATALOGUE MRP', (row) => row.currentCatalogueMRP || 0],
    ['AVERAGE SCANNED MRP', (row) => row.averageScannedMRP || 0],
    ['PRICE PERIOD', (row) => row.pricePeriod || ''],
    ['PRICE AGEING DAYS', (row) => row.priceAgeingDays || 0],
    ['PART MOVEMENT', (row) => row.partMovement || ''],
    ['FINAL INVENTORY VALUE', (row) => row.finalInventoryValue || row.physicalMrpValue || 0],
    ['DLC', (row) => row.dlc || ''],
    ['Product Group', (row) => row.productGroup || ''],
    ['Product SubGroup', (row) => row.partSubGroup || row.productSubGroup || ''],
    ['System Qty', (row) => row.systemQty || 0],
    ['Physical Qty', (row) => row.physicalQty || 0],
    ['Fitted Qty', (row) => row.fittedQty || 0],
    ['Regd No', (row) => row.regdNo || ''],
    ['Job Card No', (row) => row.jobCardNo || ''],
    ['Fitted Status', (row) => row.fittedStatus || (Number(row.fittedQty || 0) > 0 ? 'Fitted' : 'Not Fitted')],
    ['Difference', (row) => row.differenceQty || row.difference || 0],
    ['System MRP Value', (row) => row.systemMrpValue || 0],
    ['Physical MRP Value', (row) => row.physicalMrpValue || 0],
    ['Status', (row) => row.status || '']
  ];
  const lines = [columns.map(([header]) => csvCell(header)).join(',')];
  rows.forEach((row) => {
    lines.push(columns.map(([, valueFor]) => csvCell(valueFor(row))).join(','));
  });
  return `${lines.join('\r\n')}\r\n`;
}

function buildAuditRow(group, master = {}) {
  const first = group.scans[0] || {};
  const scanBreakdown = group.scans.reduce((total, scan) => {
    const type = String(scan.scanType || scan.type || '').toUpperCase();
    const qty = Math.abs(Number(scan.qty || scan.quantity || 0));
    if (type === 'INWARD') total.inwardQty += qty;
    else if (type === 'OUTWARD') total.outwardQty += qty;
    else if (type === 'FITTED') total.fittedQty += qty;
    else if (type === 'DAMAGE') total.damageQty += qty;
    const user = firstPresent(scan.userName, scan.staffName, scan.loginId, scan.userId) || '';
    if (user) {
      const key = cleanText(user).toUpperCase();
      const item = total.users.get(key) || { name: user, scanCount: 0, totalQty: 0, inwardQty: 0, outwardQty: 0, fittedQty: 0, damageQty: 0 };
      item.scanCount += 1;
      item.totalQty += qty;
      if (type === 'INWARD') item.inwardQty += qty;
      else if (type === 'OUTWARD') item.outwardQty += qty;
      else if (type === 'FITTED') item.fittedQty += qty;
      else if (type === 'DAMAGE') item.damageQty += qty;
      total.users.set(key, item);
    }
    return total;
  }, { inwardQty: 0, outwardQty: 0, fittedQty: 0, damageQty: 0, users: new Map() });
  const userWiseScanSummary = Array.from(scanBreakdown.users.values()).map((item) => {
    const parts = [`${item.name}: ${item.scanCount} scans`, `Qty ${money(item.totalQty)}`];
    if (item.inwardQty) parts.push(`Inward ${money(item.inwardQty)}`);
    if (item.outwardQty) parts.push(`Outward ${money(item.outwardQty)}`);
    if (item.fittedQty) parts.push(`Fitted ${money(item.fittedQty)}`);
    if (item.damageQty) parts.push(`Damage ${money(item.damageQty)}`);
    return parts.join(' / ');
  }).join('; ');
  const hasMaster = Boolean(master && (master.partNo || master.partNumber || master.normalizedPartNumber));
  const dmsQty = hasMaster ? masterQty(master) : 0;
  const binPhysicalQty = numberValue(group.binPhysicalQty !== undefined ? group.binPhysicalQty : group.qty, 0);
  const physicalQty = binPhysicalQty + numberValue(scanBreakdown.fittedQty, 0);
  const diffQty = physicalQty - dmsQty;
  const valueSummary = rowValueSummary(group.scans, master);
  const movementSummary = summarizeMovementBucket(group.scans, {
    partNumber: group.partNo,
    currentCatalogueMRP: valueSummary.currentCatalogueMRP
  });
  const mrp = valuationRateForDisplay(valueSummary);
  const dlc = Number(hasMaster ? master.dlc || 0 : 0);
  const physicalBins = binDisplayWithFitted(group.scans);
  const systemBins = splitBins(master.binLocation || master.bin || '');
  const partDescription = rowDescription(first, hasMaster ? master : {});
  const category = rowCategory(first, hasMaster ? master : {});
  const fitted = fittedDetails(group.scans);
  const row = {
    partNo: group.partNo,
    partNumber: group.partNo,
    partName: partDescription,
    partDescription,
    model: hasMaster ? master.model || '' : '',
    year: hasMaster ? master.manufacturingYear || master.year || '' : '',
    manufacturingYear: hasMaster ? master.manufacturingYear || master.year || '' : '',
    category,
    productCategory: category,
    bin: physicalBins.bin1 || '',
    binLocation: physicalBins.bin1 || '',
    mrp,
    scanUPIMRP: valueSummary.scanUPIMRP,
    currentCatalogueMRP: valueSummary.currentCatalogueMRP,
    averageScannedMRP: valueSummary.averageScannedMRP,
    minScannedMRP: valueSummary.minScannedMRP,
    maxScannedMRP: valueSummary.maxScannedMRP,
    totalScanValue: valueSummary.totalScanValue,
    totalManualValue: valueSummary.totalManualValue,
    finalInventoryValue: valueSummary.finalInventoryValue,
    pricePeriod: valueSummary.pricePeriod,
    priceAgeingDays: movementSummary.ageingDays || 0,
    movementCategory: movementSummary.movementCategory || '',
    partMovement: partMovementLabel(movementSummary.movementCategory),
    inventoryRiskValue: movementSummary.inventoryRiskValue || 0,
    lastMovementDate: movementSummary.lastMovementDate || '',
    dlc,
    productGroup: hasMaster ? master.productGroup || '' : first.productGroup || '',
    partSubGroup: hasMaster ? master.partSubGroup || '' : first.partSubGroup || '',
    dmsQty,
    systemQty: dmsQty,
    physicalQty,
    binPhysicalQty,
    physicalBinQty: binPhysicalQty,
    actualAuditQty: physicalQty,
    finalAuditQty: physicalQty,
    shortQty: Math.max(dmsQty - physicalQty, 0),
    excessQty: Math.max(physicalQty - dmsQty, 0),
    netDifference: diffQty,
    scanCount: group.scans.length,
    countedQty: group.scans.filter((scan) => scan.type !== 'DAMAGE' && scan.scanType !== 'DAMAGE').reduce((sum, scan) => sum + Number(scan.qty || 0), 0),
    manualQty: valueSummary.manualQty,
    inwardQty: scanBreakdown.inwardQty,
    outwardQty: scanBreakdown.outwardQty,
    fittedQty: scanBreakdown.fittedQty,
    regdNo: fitted.fittedRegdNo,
    jobCardNo: fitted.fittedJobCardNo,
    fittedRegdNo: fitted.fittedRegdNo,
    fittedJobCardNo: fitted.fittedJobCardNo,
    fittedStatus: scanBreakdown.fittedQty > 0 ? 'Fitted' : 'Not Fitted',
    damageQty: scanBreakdown.damageQty,
    totalAuditQty: physicalQty,
    saleQtyLast12Months: 0,
    movementCodeA: 0,
    reservedQty: Number(master.reservedQty || 0),
    physicalBin1: physicalBins.bin1,
    physicalBin2: physicalBins.bin2,
    physicalBin3: physicalBins.bin3,
    otherBinLocations: physicalBins.otherBins,
    systemBin1: systemBins[0],
    systemBin2: systemBins[1],
    systemBin3: systemBins[2],
    systemMrpValue: 0,
    physicalMrpValue: valueSummary.finalInventoryValue,
    systemDlcValue: money(dmsQty * dlc),
    physicalDlcValue: money(physicalQty * dlc),
    differenceQty: diffQty,
    varianceQty: Math.abs(diffQty),
    varianceValue: valueSummary.finalInventoryValue,
    differenceMrpValue: valueSummary.finalInventoryValue,
    differenceDlcValue: money(diffQty * dlc),
    status: hasMaster ? rowStatus(diffQty) : 'Extra Part',
    scanType: Array.from(new Set(group.scans.map((scan) => scan.scanType || scan.type).filter(Boolean))).join(', '),
    dealer: first.dealerName || first.dealerCode || '',
    dealerCode: first.dealerCode || '',
    dealerName: first.dealerName || '',
    userWiseScanSummary,
    userAuditTrail: Array.from(scanBreakdown.users.values()).map((item) => item.name).join(', '),
    lastScanTime: group.lastScanTime,
    rawScanProof: group.scans.map((scan) => scan.rawUpi || scan.rawScan).filter(Boolean).slice(0, 5).join(' | ')
  };
  console.log("Final report row:", row);
  return row;
}

function binWiseRowsFromScans(scans = [], finalRows = []) {
  const finalByPartDealer = new Map(finalRows.map((row) => [
    `${normalizePartNumber(row.partNumber || row.partNo)}::${cleanText(row.dealerCode).toUpperCase()}`,
    row
  ]));
  const groups = new Map();
  scans.forEach((scan) => {
    if (fittedScanQty(scan)) return;
    const partNumber = normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part);
    const dealerCode = cleanText(scan.dealerCode).toUpperCase();
    const bin = cleanText(scan.binLocation || scan.bin || scan.location).toUpperCase();
    if (!partNumber || !bin) return;
    const key = `${bin}::${partNumber}::${dealerCode}`;
    const group = groups.get(key) || { bin, partNumber, dealerCode, scans: [], physicalQty: 0, lastScanTime: scan.timestamp };
    const qty = physicalScanQty(scan);
    group.scans.push({ ...scan, qty });
    group.physicalQty += qty;
    if (new Date(scan.timestamp) > new Date(group.lastScanTime || 0)) group.lastScanTime = scan.timestamp;
    groups.set(key, group);
  });
  return Array.from(groups.values()).map((group) => {
    const finalRow = finalByPartDealer.get(`${group.partNumber}::${group.dealerCode}`) || {};
    const first = group.scans[0] || {};
    return {
      bin: group.bin,
      binLocation: group.bin,
      partNumber: group.partNumber,
      partDescription: finalRow.partDescription || finalRow.partName || first.partDescription || first.partName || '',
      model: finalRow.model || first.model || '',
      manufacturingYear: finalRow.manufacturingYear || finalRow.year || first.manufacturingYear || first.year || '',
      year: finalRow.manufacturingYear || finalRow.year || first.manufacturingYear || first.year || '',
      productCategory: finalRow.productCategory || finalRow.category || first.productCategory || first.category || '',
      category: finalRow.productCategory || finalRow.category || first.productCategory || first.category || '',
      mrp: finalRow.mrp ?? first.mrp ?? 0,
      dlc: finalRow.dlc ?? first.dlc ?? 0,
      productGroup: finalRow.productGroup || first.productGroup || '',
      partSubGroup: finalRow.partSubGroup || first.partSubGroup || '',
      systemQty: finalRow.systemQty ?? finalRow.dmsQty ?? 0,
      physicalQty: group.physicalQty,
      physicalBinQty: group.physicalQty,
      actualAuditQty: group.physicalQty,
      fittedQty: 0,
      regdNo: '',
      jobCardNo: '',
      fittedRegdNo: '',
      fittedJobCardNo: '',
      fittedStatus: 'Not Fitted',
      partLevelPhysicalQty: finalRow.physicalQty ?? group.physicalQty,
      partLevelActualAuditQty: finalRow.actualAuditQty ?? finalRow.physicalQty ?? group.physicalQty,
      differenceQty: finalRow.differenceQty ?? finalRow.netDifference ?? '',
      status: finalRow.status || '',
      qty: group.physicalQty,
      dealer: finalRow.dealer || first.dealerName || group.dealerCode,
      dealerCode: group.dealerCode,
      lastScanTime: group.lastScanTime
    };
  }).sort((a, b) => sortText(a.bin, b.bin) || sortText(a.partNumber, b.partNumber));
}

async function enrichScanUsers(scans = []) {
  const deviceIds = Array.from(new Set(scans.map((scan) => String(scan.deviceId || '').trim()).filter(Boolean)));
  const devices = deviceIds.length ? await Device.find({ deviceId: { $in: deviceIds } }).lean() : [];
  const deviceById = new Map(devices.map((device) => [String(device.deviceId || '').trim(), device]));
  const userKeys = Array.from(new Set(scans.flatMap((scan) => {
    const device = deviceById.get(String(scan.deviceId || '').trim()) || {};
    return [
    scan.userId,
    scan.loginId,
    scan.userName,
      scan.staffName,
      device.userId,
      device.loginId,
      device.userName,
      device.staffName
    ];
  }).map((value) => String(value || '').trim()).filter(Boolean)));
  const users = userKeys.length ? await User.find({
    $or: [
      { _id: { $in: userKeys.filter((value) => /^[a-f\d]{24}$/i.test(value)) } },
      { username: { $in: userKeys } },
      { email: { $in: userKeys } },
      { name: { $in: userKeys } }
    ]
  }).lean() : [];
  const byKey = new Map();
  users.forEach((user) => {
    [user._id, user.username, user.email, user.name].forEach((key) => {
      const text = String(key || '').trim();
      if (text) byKey.set(text, user);
    });
  });
  return scans.map((scan) => {
    const device = deviceById.get(String(scan.deviceId || '').trim()) || {};
    const user = byKey.get(String(scan.userId || '').trim())
      || byKey.get(String(scan.loginId || '').trim())
      || byKey.get(String(scan.userName || '').trim())
      || byKey.get(String(scan.staffName || '').trim())
      || byKey.get(String(device.userId || '').trim())
      || byKey.get(String(device.loginId || '').trim())
      || byKey.get(String(device.userName || '').trim())
      || byKey.get(String(device.staffName || '').trim());
    if (!user && !device.userId && !device.loginId && !device.userName && !device.role) return scan;
    return {
      ...scan,
      userId: scan.userId || (user ? String(user._id || '') : '') || device.userId || device.loginId || '',
      loginId: scan.loginId || (user ? user.username || user.email || '' : '') || device.loginId || '',
      userName: scan.userName || (user ? user.name || user.username || '' : '') || device.userName || device.staffName || device.loginId || '',
      staffName: scan.staffName || (user ? user.name || user.username || '' : '') || device.staffName || device.userName || '',
      role: scan.role || (user ? user.role || '' : '') || device.role || ''
    };
  });
}

async function buildReportData(query = {}) {
  query = normalizeReportQuery(query);
  console.log("REPORT API:", '/api/reports', query);
  let [rawScans, dealers, audits] = await Promise.all([
    Inventory.find(scanBasedFilter(query)).sort({ timestamp: -1 }).lean(),
    Dealer.find({}).sort({ dealerName: 1 }).lean(),
    Audit.find({}).sort({ createdAt: -1 }).lean()
  ]);
  rawScans = rawScans.map(inventoryRoute.publicScan);
  rawScans = await enrichScanUsers(rawScans);
  console.log("Report scan count:", rawScans.length);
  const realScansForLookup = rawScans.filter((scan) => !/^SYNC/i.test(normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part)));
  const partNumbers = Array.from(new Set(realScansForLookup.map((scan) => normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part)).filter(Boolean)));
  const catalogueMasters = partNumbers.length ? await MasterCatalogue.find({ normalizedPartNumber: { $in: partNumbers } }).lean() : [];
  let masters = catalogueMasters.map(cataloguePayload);
  const catalogueFound = new Set(masters.map((master) => masterPartNumber(master)).filter(Boolean));
  const legacyPartNumbers = partNumbers.filter((partNo) => !catalogueFound.has(partNo));
  const masterFilter = legacyPartNumbers.length ? { $or: [{ normalizedPartNumber: { $in: legacyPartNumbers } }, { partNo: { $in: legacyPartNumbers } }, { partNumber: { $in: legacyPartNumbers } }] } : { _id: null };
  masters = masters.concat(await MasterPart.find(masterFilter).lean());
  const foundParts = new Set(masters.map((master) => masterPartNumber(master)).filter(Boolean));
  if (partNumbers.some((partNo) => !foundParts.has(partNo))) {
    const allMasters = await MasterPart.find({}).lean();
    const allByPart = new Map(allMasters.map((master) => [masterPartNumber(master), master]).filter(([partNo]) => partNo));
    partNumbers.forEach((partNo) => {
      if (!foundParts.has(partNo) && allByPart.has(partNo)) {
        masters.push(allByPart.get(partNo));
        foundParts.add(partNo);
      }
    });
  }
  const masterByDealer = new Map();
  const masterByPart = new Map();
  masters.forEach((master) => {
    const partNo = masterPartNumber(master);
    const dealerCode = cleanText(master.dealerCode).toUpperCase();
    if (partNo && dealerCode) masterByDealer.set(masterKey(partNo, dealerCode), master);
    if (partNo && !masterByPart.has(partNo)) masterByPart.set(partNo, master);
  });
  let scans = rawScans.map((scan) => {
    const partNo = normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part);
    const dealerCode = cleanText(scan.dealerCode).toUpperCase();
    return enrichScan(scan, masterByDealer.get(masterKey(partNo, dealerCode)) || masterByPart.get(partNo) || null);
  });
  const matchedCount = scans.filter((scan) => scan.masterFound).length;
  console.log("Matched master:", matchedCount);
  console.log("[report-join] unmatched scan part numbers count:", partNumbers.length - new Set(scans.filter((scan) => scan.masterFound).map((scan) => scan.normalizedPartNumber)).size);
  scans = scans.filter((scan) => scan.masterFound);
  if (query.category) scans = scans.filter((scan) => new RegExp(escapeRegExp(query.category), 'i').test(scan.category || ''));

  const groupMap = new Map();
  scans.forEach((scan) => {
    const key = `${scan.normalizedPartNumber}::${scan.dealerCode || ''}`;
    const group = groupMap.get(key) || { partNo: scan.normalizedPartNumber, dealerCode: scan.dealerCode || '', scans: [], qty: 0, binPhysicalQty: 0, masterFound: false, lastScanTime: scan.timestamp };
    group.scans.push(scan);
    group.qty += physicalScanQty(scan);
    group.binPhysicalQty += binPhysicalScanQty(scan);
    group.masterFound = group.masterFound || scan.masterFound;
    if (new Date(scan.timestamp) > new Date(group.lastScanTime || 0)) group.lastScanTime = scan.timestamp;
    groupMap.set(key, group);
  });
  const allFinalRows = Array.from(groupMap.values()).map((group) => buildAuditRow(group, masterByDealer.get(masterKey(group.partNo, group.dealerCode)) || masterByPart.get(group.partNo) || {})).sort((a, b) => sortText(a.partNo, b.partNo));
  const finalRows = applyVarianceFilter(allFinalRows, query.varianceType).filter((row) => row.physicalQty > 0);
  console.log("Report rows:", finalRows.length);
  console.log("First report row:", finalRows[0]);

  const categoryMap = new Map();
  finalRows.forEach((row) => {
    const key = row.category || 'Uncategorized';
    const item = categoryMap.get(key) || { category: key, systemQty: 0, physicalQty: 0, differenceQty: 0, differenceMrpValue: 0, differenceDlcValue: 0, matched: 0, short: 0, excess: 0 };
    item.systemQty += row.systemQty;
    item.physicalQty += row.physicalQty;
    item.differenceQty += row.differenceQty;
    item.differenceMrpValue = money(item.differenceMrpValue + row.differenceMrpValue);
    item.differenceDlcValue = money(item.differenceDlcValue + row.differenceDlcValue);
    if (row.status === 'Matched') item.matched += 1;
    if (row.status === 'Short') item.short += 1;
    if (row.status === 'Excess' || row.status === 'Extra Part') item.excess += 1;
    categoryMap.set(key, item);
  });
  const selectedDealer = query.dealerCode ? dealers.find((dealer) => dealer.dealerCode === String(query.dealerCode).trim().toUpperCase()) : null;
  const selectedAudit = query.auditId ? audits.find((audit) => audit.auditId === String(query.auditId).trim()) : null;
  const summary = [{ generatedAt: formatIstDateTime(new Date()), dealerName: query.dealerName || (selectedDealer ? selectedDealer.dealerName : 'All'), dealerCode: query.dealerCode || 'All', auditId: query.auditId || 'All', fromDate: query.from || '', toDate: query.to || '', category: query.category || 'All', partNumber: query.partNumber || 'All', binLocation: query.bin || 'All', varianceType: query.varianceType || 'All', scanType: query.type || 'All', totalMasterParts: masters.length, totalScans: scans.length, totalSystemQty: finalRows.reduce((sum, row) => sum + row.systemQty, 0), totalPhysicalQty: finalRows.reduce((sum, row) => sum + row.physicalQty, 0), totalSystemMrpValue: money(finalRows.reduce((sum, row) => sum + row.systemMrpValue, 0)), totalPhysicalMrpValue: money(finalRows.reduce((sum, row) => sum + row.physicalMrpValue, 0)), matched: finalRows.filter((row) => row.status === 'Matched').length, short: finalRows.filter((row) => row.status === 'Short').length, excess: finalRows.filter((row) => row.status === 'Excess' || row.status === 'Extra Part').length, notScanned: 0 }];

  return { filters: query, summary, selectedDealer, selectedAudit, allFinalRows, finalRows, categoryRows: Array.from(categoryMap.values()).sort((a, b) => sortText(a.category, b.category)), scans, damageRows: scans.filter((scan) => scan.type === 'DAMAGE' || scan.scanType === 'DAMAGE'), openingRows: finalRows, oilRows: finalRows.filter((row) => /oil|lube|lubricant/i.test(row.category || row.partDescription || row.partName)), accessoryRows: finalRows.filter((row) => /accessor/i.test(row.category || row.partDescription || row.partName)), nonMovingRows: [], highValueNonMovingRows: [], binRows: binWiseRowsFromScans(scans, finalRows), rawLogRows: scans.map((scan) => ({ time: scan.timestamp, rawScan: scan.rawScan || scan.rawScanString || scan.rawUpi || '', partNumber: scan.partNumber || scan.part, partDescription: scan.partDescription || scan.partName, qty: scan.qty, type: scan.scanType || scan.type, bin: fittedScanQty(scan) ? 'FITTED - VEHICLE' : (scan.binLocation || scan.bin), dealerCode: scan.dealerCode, auditId: scan.auditId, userId: scan.userId || scan.loginId || '', userName: scan.userName || scan.staffName || scan.loginId || '', role: scan.role || '', deviceId: scan.deviceId, entryMode: scan.entryMode, entryChannel: scan.entryChannel, scanSourceLabel: scan.scanSourceLabel, staffName: scan.staffName, regdNo: scan.regdNo || '', jobCardNo: scan.jobCardNo || '', fittedQty: scan.fittedQty || ((scan.scanType || scan.type) === 'FITTED' ? scan.qty : 0), fittedStatus: (scan.scanType || scan.type) === 'FITTED' || scan.isFitted ? 'Fitted' : 'Not Fitted', autoDetectedBin: scan.autoDetectedBin ? 'Yes' : 'No', stockDeductedFromBin: scan.stockDeductedFromBin || '', warnings: (scan.warnings || []).join(', ') })), dealerBackupRows: dealers.map((dealer) => ({ dealerName: dealer.dealerName, dealerCode: dealer.dealerCode, brand: dealer.brand, location: dealer.location, currentAuditId: dealer.currentAuditId, auditName: dealer.auditName, auditorName: dealer.auditorName, generalManager: dealer.generalManager, spmName: dealer.spmName })), dealers, audits };
}

function partwiseInventoryAuditColumns() {
  return [
    { header: 'Part Num', key: 'partNum', width: 18 },
    { header: 'Part Description', key: 'partDescription', width: 34 },
    { header: 'Product Category', key: 'productCategory', width: 20 },
    { header: 'Product Group', key: 'productGroup', width: 20 },
    { header: 'MRP', key: 'mrp', width: 12, numFmt: '#,##0.00' },
    { header: 'SCAN UPI MRP', key: 'scanUPIMRP', width: 18 },
    { header: 'CURRENT CATALOGUE MRP', key: 'currentCatalogueMRP', width: 22, numFmt: '#,##0.00' },
    { header: 'AVERAGE SCANNED MRP', key: 'averageScannedMRP', width: 22, numFmt: '#,##0.00' },
    { header: 'Min Scanned MRP', key: 'minScannedMRP', width: 18, numFmt: '#,##0.00' },
    { header: 'Max Scanned MRP', key: 'maxScannedMRP', width: 18, numFmt: '#,##0.00' },
    { header: 'Total Scan Value', key: 'totalScanValue', width: 18, numFmt: '#,##0.00' },
    { header: 'Total Manual Value', key: 'totalManualValue', width: 20, numFmt: '#,##0.00' },
    { header: 'Final Inventory Value', key: 'finalInventoryValue', width: 22, numFmt: '#,##0.00' },
    { header: 'PRICE PERIOD', key: 'pricePeriod', width: 30 },
    { header: 'Oldest Price Period', key: 'oldestPricePeriod', width: 22 },
    { header: 'Newest Price Period', key: 'newestPricePeriod', width: 22 },
    { header: 'PRICE AGEING DAYS', key: 'priceAgeingDays', width: 18, numFmt: '#,##0' },
    { header: 'Last Movement Date', key: 'lastMovementDate', width: 22 },
    { header: 'Movement Qty 30 Days', key: 'movementQtyLast30Days', width: 22, numFmt: '#,##0.00' },
    { header: 'Movement Qty 90 Days', key: 'movementQtyLast90Days', width: 22, numFmt: '#,##0.00' },
    { header: 'Movement Qty 180 Days', key: 'movementQtyLast180Days', width: 24, numFmt: '#,##0.00' },
    { header: 'Movement Qty 365 Days', key: 'movementQtyLast365Days', width: 24, numFmt: '#,##0.00' },
    { header: 'PART MOVEMENT', key: 'partMovement', width: 20 },
    { header: 'Inventory Risk Value', key: 'inventoryRiskValue', width: 22, numFmt: '#,##0.00' },
    { header: 'DLC', key: 'dlc', width: 12, numFmt: '#,##0.00' },
    { header: 'Opening Stock', key: 'openingStock', width: 16, numFmt: '#,##0.00' },
    { header: 'Physical Bin Quantity', key: 'binPhysicalQty', width: 22, numFmt: '#,##0.00' },
    { header: 'Physical Quantity / Actual Audit Quantity', key: 'physicalQty', width: 34, numFmt: '#,##0.00' },
    { header: 'Physical Value On MRP', key: 'physicalValueOnMrp', width: 20, numFmt: '#,##0.00' },
    { header: 'Physical Value On DLC', key: 'physicalValueOnDlc', width: 20, numFmt: '#,##0.00' },
    { header: 'Scan Count', key: 'scanCount', width: 14, numFmt: '#,##0' },
    { header: 'Scan Type / Action', key: 'scanTypeAction', width: 20 },
    { header: 'Scan Details', key: 'scanDetails', width: 48 },
    { header: 'Dealer Code', key: 'dealerCode', width: 16 },
    { header: 'Bin Loc 1', key: 'binLoc1', width: 16 },
    { header: 'Bin Loc 2', key: 'binLoc2', width: 16 },
    { header: 'Bin Loc 3', key: 'binLoc3', width: 16 },
    { header: 'Other Bin Locations', key: 'otherBinLocations', width: 24 },
    { header: 'User Audit Trail', key: 'userAuditTrail', width: 34 },
    { header: 'User Wise Scan Summary', key: 'userWiseScanSummary', width: 42 },
    { header: 'Device Audit Trail', key: 'deviceAuditTrail', width: 34 },
    { header: 'Last Scan Time', key: 'lastScanTime', width: 22 },
    { header: 'Inward Quantity', key: 'inwardQty', width: 18, numFmt: '#,##0.00' },
    { header: 'Outward Quantity', key: 'outwardQty', width: 18, numFmt: '#,##0.00' },
    { header: 'Fitted Quantity', key: 'fittedQty', width: 18, numFmt: '#,##0.00' },
    { header: 'Fitted Regd No', key: 'regdNo', width: 16 },
    { header: 'Fitted Job Card No', key: 'jobCardNo', width: 18 },
    { header: 'Fitted Status', key: 'fittedStatus', width: 16 },
    { header: 'Damage Quantity', key: 'damageQty', width: 18, numFmt: '#,##0.00' },
    { header: 'Final Available Quantity', key: 'finalAvailableQty', width: 24, numFmt: '#,##0.00' },
    { header: 'Short Quantity', key: 'shortQty', width: 18, numFmt: '#,##0.00' },
    { header: 'Excess Quantity', key: 'excessQty', width: 18, numFmt: '#,##0.00' },
    { header: 'Variance Quantity', key: 'varianceQty', width: 18, numFmt: '#,##0.00' },
    { header: 'Status', key: 'status', width: 20 }
  ];
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && cleanText(value) !== '');
}

function systemQtyValue(master = {}) {
  return numberValue(firstPresent(master.openingStockQty, master.quantity, master.qty, master.stockOnHand, master.systemQty), 0);
}

function reservedQtyValue(master = {}) {
  return numberValue(firstPresent(master.reservedQty, master.onHandReserved, master.reserved, master.reserveQty), 0);
}

function saleQtyLast12Value(master = {}) {
  return numberValue(firstPresent(master.saleQtyLast12Months, master.salesQtyLast12Months, master.saleQty12Months, master.last12MonthsSaleQty, master.last12MonthSaleQty), 0);
}

function movementCodeAValue(master = {}) {
  return firstPresent(master.movementCodeA, master.movementCode, master.movementA, master.movementCodeLast12Months) || '';
}

function scanDetailsForPartwise(scans = []) {
  const details = scans.slice(0, 10).map((scan) => {
    const type = actionForScan(scan) || displayAction(scan.scanType || scan.type) || cleanText(scan.scanType || scan.type) || 'Scan';
    const qty = money(Math.abs(numberValue(scan.qty !== undefined ? scan.qty : scan.quantity, 0)));
    const bin = cleanText(scan.binLocation || scan.bin || scan.location);
    const user = firstPresent(scan.userName, scan.staffName, scan.loginId, scan.userId);
    const device = firstPresent(scan.deviceName, scan.deviceId);
    const raw = cleanText(scan.rawUpi || scan.rawScan || scan.rawScanString);
    const regdNo = cleanText(scan.regdNo);
    const jobCardNo = cleanText(scan.jobCardNo);
    const stockDeductedFromBin = cleanText(scan.stockDeductedFromBin);
    const time = scan.timestamp ? new Date(scan.timestamp) : null;
    const timeText = time && !Number.isNaN(time.getTime()) ? formatIstDateTime(time) : cleanText(scan.timestamp);
    const parts = [`${type} Qty ${qty}`];
    if (bin) parts.push(`Bin ${bin}`);
    if (user) parts.push(`User ${user}`);
    if (device) parts.push(`Device ${device}`);
    if (regdNo) parts.push(`Regd ${regdNo}`);
    if (jobCardNo) parts.push(`Job Card ${jobCardNo}`);
    if (stockDeductedFromBin) parts.push(`Stock Bin ${stockDeductedFromBin}`);
    if (timeText) parts.push(`Time ${timeText}`);
    if (raw) parts.push(`Raw ${raw}`);
    return parts.join(', ');
  });
  if (scans.length > 10) details.push(`+${scans.length - 10} more scan(s)`);
  return details.join(' ; ');
}

function partwiseRowFrom(partNo, group = {}, catalogue = {}, system = {}, priceHistories = []) {
  const scans = group.scans || [];
  const firstScan = scans[0] || {};
  const hasCatalogue = Boolean(catalogue && (catalogue.partNo || catalogue.partNumber || catalogue.normalizedPartNumber));
  const hasSystemStock = Boolean(system && (system.partNo || system.partNumber || system.normalizedPartNumber));
  const detailSource = hasCatalogue ? catalogue : (hasSystemStock ? system : firstScan);
  const valueSummary = rowValueSummary(scans, detailSource, priceHistories);
  const movementSummary = scans.length ? summarizeMovementBucket(scans) : blankMovementSummary();
  const mrp = valuationRateForDisplay(valueSummary);
  const dlc = numberValue(firstPresent(detailSource.dlc, firstScan.dlc), 0);
  const auditTypes = new Set(['AUDIT', 'VERIFICATION', 'FITTED']);
  const userSummary = new Map();
  const breakdown = scans.reduce((total, scan) => {
    const type = cleanText(scan.scanType || scan.type).toUpperCase();
    const qty = Math.abs(numberValue(scan.qty !== undefined ? scan.qty : scan.quantity, 0));
    const action = auditTypes.has(type) ? 'Audit' : displayAction(type) || type || 'Scan';
    if (auditTypes.has(type)) {
      total.auditQty += qty;
      if (type === 'FITTED') total.fittedQty += qty;
    }
    else if (type === 'INWARD') total.inwardQty += qty;
    else if (type === 'OUTWARD') total.outwardQty += qty;
    else if (type === 'DAMAGE') total.damageQty += qty;
    const user = firstPresent(scan.userName, scan.staffName, scan.loginId, scan.userId) || 'UNKNOWN';
    const userKey = cleanText(user).toUpperCase();
    const userItem = userSummary.get(userKey) || { name: user, scanCount: 0, totalQty: 0, auditQty: 0, inwardQty: 0, outwardQty: 0, fittedQty: 0, damageQty: 0 };
    userItem.scanCount += 1;
    userItem.totalQty += qty;
    if (action === 'Audit' || action === 'Inventory Matched') {
      userItem.auditQty += qty;
      if (type === 'FITTED') userItem.fittedQty += qty;
    }
    else if (action === 'Inward') userItem.inwardQty += qty;
    else if (action === 'Outward') userItem.outwardQty += qty;
    else if (action === 'Fitted') userItem.fittedQty += qty;
    else if (action === 'Damage') userItem.damageQty += qty;
    userSummary.set(userKey, userItem);
    return total;
  }, { auditQty: 0, inwardQty: 0, outwardQty: 0, fittedQty: 0, damageQty: 0 });
  const fittedQty = numberValue(breakdown.fittedQty, 0);
  const binPhysicalQty = numberValue(group.binPhysicalQty !== undefined ? group.binPhysicalQty : group.physicalQty, 0);
  const physicalQty = binPhysicalQty + fittedQty;
  const systemQty = hasSystemStock ? systemQtyValue(system) : 0;
  const finalAvailableQty = systemQty;
  const varianceQty = physicalQty - finalAvailableQty;
  const shortQty = Math.max(finalAvailableQty - physicalQty, 0);
  const excessQty = Math.max(physicalQty - finalAvailableQty, 0);
  const physicalBins = binDisplayWithFitted(scans);
  const fitted = fittedDetails(scans);
  const status = partwiseStatus({ hasCatalogue: hasCatalogue || hasSystemStock, hasSystemStock, physicalQty, varianceQty });
  const action = partwiseAction(varianceQty, hasSystemStock, physicalQty);
  const scanTypes = Array.from(new Set(scans.map((scan) => actionForScan(scan) || displayAction(scan.scanType || scan.type) || cleanText(scan.scanType || scan.type)).filter(Boolean)));
  const userAuditTrail = Array.from(new Set(scans.map((scan) => firstPresent(scan.userName, scan.staffName, scan.loginId, scan.userId)).filter(Boolean))).join(', ');
  const userWiseScanSummary = Array.from(userSummary.values()).map((item) => {
    const parts = [`${item.name}: ${item.scanCount} scans`, `Qty ${money(item.totalQty)}`];
    if (item.auditQty) parts.push(`Audit ${money(item.auditQty)}`);
    if (item.inwardQty) parts.push(`Inward ${money(item.inwardQty)}`);
    if (item.outwardQty) parts.push(`Outward ${money(item.outwardQty)}`);
    if (item.fittedQty) parts.push(`Fitted ${money(item.fittedQty)}`);
    if (item.damageQty) parts.push(`Damage ${money(item.damageQty)}`);
    return parts.join(' / ');
  }).join('; ');
  const deviceAuditTrail = Array.from(new Set(scans.map((scan) => firstPresent(scan.deviceName, scan.deviceId)).filter(Boolean))).join(', ');

  return {
    partNum: partNo,
    partDescription: unknownIfBlank(firstPresent(detailSource.partDescription, detailSource.partName, firstScan.partDescription, firstScan.partName)),
    productCategory: unknownIfBlank(firstPresent(detailSource.productCategory, detailSource.category, firstScan.productCategory, firstScan.category)),
    productGroup: unknownIfBlank(firstPresent(detailSource.productGroup, firstScan.productGroup)),
    model: firstPresent(detailSource.model, firstScan.model) || '',
    year: firstPresent(detailSource.manufacturingYear, detailSource.year, firstScan.manufacturingYear, firstScan.year) || '',
    mrp,
    scanUPIMRP: valueSummary.scanUPIMRP,
    currentCatalogueMRP: valueSummary.currentCatalogueMRP,
    averageScannedMRP: valueSummary.averageScannedMRP,
    minScannedMRP: valueSummary.minScannedMRP,
    maxScannedMRP: valueSummary.maxScannedMRP,
    totalScanValue: valueSummary.totalScanValue,
    totalManualValue: valueSummary.totalManualValue,
    finalInventoryValue: valueSummary.finalInventoryValue,
    priceChangeCount: valueSummary.priceChangeCount,
    pricePeriod: valueSummary.pricePeriod,
    oldestPricePeriod: movementSummary.firstScanDate || '',
    newestPricePeriod: movementSummary.lastScanDate || '',
    priceAgeingDays: movementSummary.ageingDays || 0,
    lastMovementDate: movementSummary.lastMovementDate || '',
    movementQtyLast30Days: movementSummary.movementQtyLast30Days || 0,
    movementQtyLast90Days: movementSummary.movementQtyLast90Days || 0,
    movementQtyLast180Days: movementSummary.movementQtyLast180Days || 0,
    movementQtyLast365Days: movementSummary.movementQtyLast365Days || 0,
    movementCategory: movementSummary.movementCategory || '',
    partMovement: partMovementLabel(movementSummary.movementCategory),
    inventoryRiskValue: money(movementSummary.inventoryRiskValue || 0),
    dlc,
    openingStock: systemQty,
    saleQtyLast12Months: saleQtyLast12Value(system) || saleQtyLast12Value(detailSource),
    movementCodeA: movementCodeAValue(system) || movementCodeAValue(detailSource),
    physicalQty,
    binPhysicalQty,
    physicalBinQty: binPhysicalQty,
    actualAuditQty: physicalQty,
    finalAuditQty: physicalQty,
    inwardQty: breakdown.inwardQty,
    outwardQty: breakdown.outwardQty,
    fittedQty,
    regdNo: fitted.fittedRegdNo,
    jobCardNo: fitted.fittedJobCardNo,
    fittedRegdNo: fitted.fittedRegdNo,
    fittedJobCardNo: fitted.fittedJobCardNo,
    fittedStatus: breakdown.fittedQty > 0 ? 'Fitted' : 'Not Fitted',
    damageQty: breakdown.damageQty,
    finalAvailableQty,
    shortQty,
    excessQty,
    physicalValueOnMrp: valueSummary.finalInventoryValue,
    physicalValueOnDlc: physicalQty * dlc,
    systemQty,
    systemValueOnMrp: 0,
    systemValueOnDlc: systemQty * dlc,
    varianceQty,
    varianceOnMrp: valueSummary.finalInventoryValue,
    varianceOnDlc: varianceQty * dlc,
    reservedQty: reservedQtyValue(system) || reservedQtyValue(detailSource),
    action,
    scanCount: scans.length,
    scanTypeAction: scanTypes.join(', ') || action,
    scanDetails: scanDetailsForPartwise(scans),
    dealerCode: group.dealerCode || firstScan.dealerCode || '',
    binLoc1: physicalBins.bin1,
    binLoc2: physicalBins.bin2,
    binLoc3: physicalBins.bin3,
    otherBinLocations: physicalBins.otherBins,
    userAuditTrail,
    userWiseScanSummary,
    deviceAuditTrail,
    lastScanTime: group.lastScanTime || '',
    status
  };
}

function sortPartwiseInventoryRows(a, b) {
  const aHasScans = Number(a.scanCount || 0) > 0 || Number(a.physicalQty || 0) !== 0;
  const bHasScans = Number(b.scanCount || 0) > 0 || Number(b.physicalQty || 0) !== 0;
  if (aHasScans !== bHasScans) return aHasScans ? -1 : 1;
  return sortText(a.partNum, b.partNum);
}

function applyPartwiseFilters(rows, query = {}) {
  let filtered = rows;
  if (query.productCategory || query.category) {
    const category = cleanText(query.productCategory || query.category);
    filtered = filtered.filter((row) => new RegExp(escapeRegExp(category), 'i').test(row.productCategory || ''));
  }
  if (query.partNumber) {
    const part = normalizePartNumber(query.partNumber);
    filtered = filtered.filter((row) => normalizePartNumber(row.partNum).includes(part));
  }
  if (query.status) {
    const status = cleanText(query.status).toUpperCase();
    filtered = filtered.filter((row) => cleanText(row.status).toUpperCase() === status);
  }
  if (query.action) {
    const action = displayAction(query.action) || cleanText(query.action);
    filtered = filtered.filter((row) => cleanText(row.action).toUpperCase() === cleanText(action).toUpperCase());
  }
  if (query.bin || query.binLocation) {
    const bin = cleanText(query.bin || query.binLocation);
    filtered = filtered.filter((row) => [row.binLoc1, row.binLoc2, row.binLoc3, row.otherBinLocations, row.systemBinLoc1, row.systemBinLoc2, row.systemBinLoc3].some((item) => new RegExp(escapeRegExp(bin), 'i').test(item || '')));
  }
  return filtered;
}

async function buildPartwiseInventoryAuditReport(query = {}) {
  query = normalizeReportQuery(query);
  const scanFilter = scanBasedFilter({ ...query, category: '', productCategory: '' });
  const includeFullMaster = showFullMasterWithZeroScan(query);
  let [rawScans, dealers, audits, allCatalogueCount] = await Promise.all([
    Inventory.find(scanFilter).sort({ timestamp: 1 }).lean(),
    Dealer.find({}).sort({ dealerName: 1 }).lean(),
    Audit.find({}).sort({ createdAt: -1 }).lean(),
    MasterCatalogue.countDocuments({})
  ]);
  rawScans = rawScans.map(inventoryRoute.publicScan);

  const seenScanIds = new Set();
  const groups = new Map();
  const validationLog = {
    totalMasterParts: allCatalogueCount,
    totalScannedParts: 0,
    matchedParts: 0,
    unmatchedParts: 0,
    duplicateScanIdsSkipped: 0,
    totalVarianceQuantity: 0,
    totalVarianceOnMRP: 0,
    totalVarianceOnDLC: 0
  };

  rawScans.forEach((scan) => {
    const duplicateKey = scanDuplicateKey(scan);
    if (duplicateKey && seenScanIds.has(duplicateKey)) {
      validationLog.duplicateScanIdsSkipped += 1;
      return;
    }
    if (duplicateKey) seenScanIds.add(duplicateKey);
    const partNo = normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part);
    if (!partNo || /^SYNC/i.test(partNo)) return;
    const dealerCode = cleanText(scan.dealerCode).toUpperCase();
    const scanType = cleanText(scan.scanType || scan.type).toUpperCase();
    const key = [partNo, dealerCode].join('::');
    const group = groups.get(key) || { partNo, dealerCode, scanType, scans: [], physicalQty: 0, binPhysicalQty: 0, lastScanTime: scan.timestamp };
    const qty = physicalScanQty(scan);
    group.scans.push({ ...scan, qty });
    group.physicalQty += qty;
    group.binPhysicalQty += binPhysicalScanQty(scan);
    if (new Date(scan.timestamp) > new Date(group.lastScanTime || 0)) group.lastScanTime = scan.timestamp;
    groups.set(key, group);
  });
  validationLog.totalScannedParts = groups.size;

  const scannedParts = Array.from(new Set(Array.from(groups.values()).map((group) => group.partNo).filter(Boolean)));
  const systemFilter = {};
  if (query.dealerCode) systemFilter.$or = [
    { dealerCode: String(query.dealerCode).trim().toUpperCase() },
    { dealerCode: '' },
    { dealerCode: { $exists: false } }
  ];
  if (!includeFullMaster) {
    systemFilter.$and = (systemFilter.$and || []).concat([{
      $or: [
        { normalizedPartNumber: { $in: scannedParts } },
        { partNo: { $in: scannedParts } },
        { partNumber: { $in: scannedParts } }
      ]
    }]);
  }
  if (query.partNumber) {
    const part = normalizePartNumber(query.partNumber);
    systemFilter.$and = (systemFilter.$and || []).concat([{
      $or: [{ normalizedPartNumber: { $regex: escapeRegExp(part), $options: 'i' } }, { partNo: { $regex: escapeRegExp(part), $options: 'i' } }, { partNumber: { $regex: escapeRegExp(part), $options: 'i' } }]
    }]);
  }
  if (query.bin || query.binLocation) {
    const bin = cleanText(query.bin || query.binLocation);
    systemFilter.$and = (systemFilter.$and || []).concat([{ $or: [{ bin: { $regex: escapeRegExp(bin), $options: 'i' } }, { binLocation: { $regex: escapeRegExp(bin), $options: 'i' } }] }]);
  }
  const systemParts = await MasterPart.find(systemFilter).lean();
  validationLog.totalMasterParts = Math.max(validationLog.totalMasterParts, systemParts.length);
  const partSet = new Set(scannedParts);
  if (includeFullMaster) {
    systemParts.forEach((part) => {
      const partNo = masterPartNumber(part);
      if (partNo) partSet.add(partNo);
    });
  }

  const allParts = Array.from(partSet).filter(Boolean);
  const [catalogueRows, priceHistoryRows] = allParts.length ? await Promise.all([
    MasterCatalogue.find({ normalizedPartNumber: { $in: allParts } }).lean(),
    PartPriceHistory.find({ normalizedPartNumber: { $in: allParts } }).sort({ normalizedPartNumber: 1, isCurrentPrice: -1, effectiveFrom: -1 }).lean()
  ]) : [[], []];
  const catalogueByPart = new Map(catalogueRows.map((row) => [masterPartNumber(row), cataloguePayload(row)]).filter(([partNo]) => partNo));
  const priceHistoryByPart = new Map();
  priceHistoryRows.forEach((row) => {
    const partNo = normalizePartNumber(row.normalizedPartNumber || row.partNumber);
    if (!partNo) return;
    const rowsForPart = priceHistoryByPart.get(partNo) || [];
    rowsForPart.push(row);
    priceHistoryByPart.set(partNo, rowsForPart);
  });
  const systemByPart = new Map();
  systemParts.forEach((part) => {
    const partNo = masterPartNumber(part);
    if (partNo && !systemByPart.has(partNo)) systemByPart.set(partNo, part);
  });

  const groupedRows = Array.from(groups.values()).map((group) => partwiseRowFrom(group.partNo, group, catalogueByPart.get(group.partNo), systemByPart.get(group.partNo), priceHistoryByPart.get(group.partNo) || []));
  const zeroScanRows = includeFullMaster
    ? allParts.filter((partNo) => !scannedParts.includes(partNo)).map((partNo) => partwiseRowFrom(partNo, { partNo, scans: [], physicalQty: 0 }, catalogueByPart.get(partNo), systemByPart.get(partNo), priceHistoryByPart.get(partNo) || []))
    : [];
  const rows = applyPartwiseFilters(groupedRows.concat(zeroScanRows), query)
    .filter((row) => row.status !== 'MASTER NOT FOUND')
    .sort(sortPartwiseInventoryRows);
  const movementFilter = { normalizedPartNumber: { $in: allParts } };
  if (query.dealerCode) movementFilter.dealerCode = String(query.dealerCode).trim().toUpperCase();
  if (query.auditId) movementFilter.auditId = String(query.auditId).trim();
  const movementSummaries = allParts.length ? await InventoryMovementSummary.find(movementFilter).lean() : [];
  const movementByPart = new Map();
  movementSummaries.forEach((summaryRow) => {
    const partNo = normalizePartNumber(summaryRow.normalizedPartNumber || summaryRow.partNumber);
    if (!partNo) return;
    const current = movementByPart.get(partNo) || {
      oldestPricePeriod: null,
      newestPricePeriod: null,
      priceAgeingDays: 0,
      lastMovementDate: null,
      movementQtyLast30Days: 0,
      movementQtyLast90Days: 0,
      movementQtyLast180Days: 0,
      movementQtyLast365Days: 0,
      movementCategory: '',
      inventoryRiskValue: 0
    };
    const oldest = summaryRow.oldestPricePeriod || summaryRow.firstScanDate;
    const newest = summaryRow.newestPricePeriod || summaryRow.lastScanDate;
    if (oldest && (!current.oldestPricePeriod || new Date(oldest) < new Date(current.oldestPricePeriod))) current.oldestPricePeriod = oldest;
    if (newest && (!current.newestPricePeriod || new Date(newest) > new Date(current.newestPricePeriod))) current.newestPricePeriod = newest;
    if (summaryRow.lastMovementDate && (!current.lastMovementDate || new Date(summaryRow.lastMovementDate) > new Date(current.lastMovementDate))) current.lastMovementDate = summaryRow.lastMovementDate;
    current.priceAgeingDays = Math.max(current.priceAgeingDays, Number(summaryRow.priceAgeingDays || summaryRow.ageingDays || 0));
    current.movementQtyLast30Days += Number(summaryRow.movementQtyLast30Days || 0);
    current.movementQtyLast90Days += Number(summaryRow.movementQtyLast90Days || 0);
    current.movementQtyLast180Days += Number(summaryRow.movementQtyLast180Days || 0);
    current.movementQtyLast365Days += Number(summaryRow.movementQtyLast365Days || 0);
    current.inventoryRiskValue += Number(summaryRow.inventoryRiskValue || 0);
    if (summaryRow.movementCategory === 'DEAD') current.movementCategory = 'DEAD';
    else if (summaryRow.movementCategory === 'NON-MOVING' && current.movementCategory !== 'DEAD') current.movementCategory = 'NON-MOVING';
    else if (summaryRow.movementCategory === 'SLOW' && !['DEAD', 'NON-MOVING'].includes(current.movementCategory)) current.movementCategory = 'SLOW';
    else if (summaryRow.movementCategory === 'FAST' && !current.movementCategory) current.movementCategory = 'FAST';
    movementByPart.set(partNo, current);
  });
  rows.forEach((row) => {
    const movement = movementByPart.get(normalizePartNumber(row.partNum || row.partNumber)) || {};
    Object.assign(row, {
      oldestPricePeriod: movement.oldestPricePeriod || row.oldestPricePeriod || '',
      newestPricePeriod: movement.newestPricePeriod || row.newestPricePeriod || '',
      priceAgeingDays: movement.priceAgeingDays || row.priceAgeingDays || 0,
      lastMovementDate: movement.lastMovementDate || row.lastMovementDate || '',
      movementQtyLast30Days: movement.movementQtyLast30Days || 0,
      movementQtyLast90Days: movement.movementQtyLast90Days || 0,
      movementQtyLast180Days: movement.movementQtyLast180Days || 0,
      movementQtyLast365Days: movement.movementQtyLast365Days || 0,
      movementCategory: movement.movementCategory || row.movementCategory || '',
      partMovement: partMovementLabel(movement.movementCategory || row.movementCategory || row.partMovement),
      inventoryRiskValue: money(movement.inventoryRiskValue || row.inventoryRiskValue || 0)
    });
  });

  rows.forEach((row) => {
    if (row.status === 'MASTER NOT FOUND') validationLog.unmatchedParts += 1;
    else validationLog.matchedParts += 1;
    validationLog.totalVarianceQuantity += Number(row.varianceQty || 0);
    validationLog.totalVarianceOnMRP += Number(row.varianceOnMrp || 0);
    validationLog.totalVarianceOnDLC += Number(row.varianceOnDlc || 0);
  });
  validationLog.totalVarianceQuantity = money(validationLog.totalVarianceQuantity);
  validationLog.totalVarianceOnMRP = money(validationLog.totalVarianceOnMRP);
  validationLog.totalVarianceOnDLC = money(validationLog.totalVarianceOnDLC);

  const selectedDealer = query.dealerCode ? dealers.find((dealer) => dealer.dealerCode === String(query.dealerCode).trim().toUpperCase()) : null;
  const selectedAudit = query.auditId ? audits.find((audit) => audit.auditId === String(query.auditId).trim()) : null;
  const summary = {
    generatedAt: formatIstDateTime(new Date()),
    dealerName: query.dealerName || (selectedDealer ? selectedDealer.dealerName : 'All'),
    dealerCode: query.dealerCode || 'All',
    auditId: query.auditId || 'All',
    fromDate: query.from || '',
    toDate: query.to || '',
    productCategory: query.productCategory || query.category || 'All',
    partNumber: query.partNumber || 'All',
    status: query.status || 'All',
    action: query.action || 'All',
    binLocation: query.bin || 'All'
  };

  console.log('[partwise-inventory-audit] validation:', validationLog);
  return { rows, columns: partwiseInventoryAuditColumns(), summary, validationLog, selectedDealer, selectedAudit };
}

function addPartwiseInventoryAuditSheet(workbook, data, name = 'Partwise Inventory Audit') {
  const columns = partwiseInventoryAuditColumns();
  const sheet = workbook.addWorksheet(name.slice(0, 31));
  sheet.columns = columns.map((column) => ({ key: column.key, width: column.width || 18 }));
  sheet.mergeCells(1, 1, 1, columns.length);
  sheet.getCell(1, 1).value = 'PARTWISE INVENTORY AUDIT REPORT';
  sheet.getCell(1, 1).font = { bold: true, size: 14 };
  sheet.addRow(['Dealer', data.summary.dealerName || 'All', 'Dealer Code', data.summary.dealerCode || 'All', 'Audit', data.summary.auditId || 'All']);
  sheet.addRow(['Date Range', `${data.summary.fromDate || 'All'} to ${data.summary.toDate || 'All'}`, 'Product Category', data.summary.productCategory || 'All', 'Status', data.summary.status || 'All']);
  sheet.addRow([]);
  sheet.addRow(columns.map((column) => column.header));
  const headerRowNumber = sheet.rowCount;
  data.rows.forEach((row) => sheet.addRow(row));
  columns.forEach((column, index) => {
    if (column.numFmt) sheet.getColumn(index + 1).numFmt = column.numFmt;
  });
  const header = sheet.getRow(headerRowNumber);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF153A5B' } };
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  sheet.views = [{ state: 'frozen', ySplit: headerRowNumber }];
  sheet.autoFilter = {
    from: { row: headerRowNumber, column: 1 },
    to: { row: headerRowNumber, column: columns.length }
  };
  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
      };
      cell.alignment = { vertical: 'middle', wrapText: true };
    });
  });
  return sheet;
}

function buildPartwiseInventoryAuditPdfBuffer(data) {
  const columns = partwiseInventoryAuditColumns();
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a3' });
  doc.setFontSize(14);
  doc.text('PARTWISE INVENTORY AUDIT REPORT', 24, 28);
  doc.setFontSize(8);
  doc.text(`Dealer: ${data.summary.dealerName || 'All'} | Code: ${data.summary.dealerCode || 'All'} | Audit: ${data.summary.auditId || 'All'} | Date: ${data.summary.fromDate || 'All'} to ${data.summary.toDate || 'All'}`, 24, 44);
  autoTable(doc, {
    startY: 58,
    head: [columns.map((column) => column.header)],
    body: data.rows.slice(0, 1000).map((row) => columns.map((column) => {
      const value = row[column.key];
      return typeof value === 'number' ? value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(value ?? '');
    })),
    styles: { fontSize: 5, cellPadding: 1.5, overflow: 'linebreak' },
    headStyles: { fillColor: [21, 58, 91], textColor: [255, 255, 255] },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    margin: { left: 12, right: 12 }
  });
  return Buffer.from(doc.output('arraybuffer'));
}

function categoryVarianceColumns() {
  return [
    { header: 'Product Category', key: 'productCategory', width: 28 },
    { header: 'Action / Scan Type', key: 'action', width: 22 },
    { header: 'Total Scanned Parts', key: 'totalScannedParts', width: 22, numFmt: '#,##0' },
    { header: 'Total Scanned Quantity', key: 'totalScannedQuantity', width: 24, numFmt: '#,##0.00' },
    { header: 'Sum of Physical Value On MRP', key: 'sumPhysicalValueOnMRP', width: 28, numFmt: '#,##0.00' },
    { header: 'Sum of Physical Value On DLC', key: 'sumPhysicalValueOnDLC', width: 28, numFmt: '#,##0.00' },
    { header: 'Sum of Variance On MRP', key: 'sumVarianceOnMRP', width: 24, numFmt: '#,##0.00' },
    { header: 'Sum of Variance On DLC', key: 'sumVarianceOnDLC', width: 24, numFmt: '#,##0.00' }
  ];
}

async function masterMapsForScans(scans = []) {
  const partNumbers = Array.from(new Set(scans.map((scan) => normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part)).filter(Boolean)));
  const catalogueMasters = partNumbers.length ? await MasterCatalogue.find({ normalizedPartNumber: { $in: partNumbers } }).lean() : [];
  let masters = catalogueMasters.map(cataloguePayload);
  const catalogueFound = new Set(masters.map((master) => masterPartNumber(master)).filter(Boolean));
  const legacyPartNumbers = partNumbers.filter((partNo) => !catalogueFound.has(partNo));
  if (legacyPartNumbers.length) {
    masters = masters.concat(await MasterPart.find({
      $or: [
        { normalizedPartNumber: { $in: legacyPartNumbers } },
        { partNo: { $in: legacyPartNumbers } },
        { partNumber: { $in: legacyPartNumbers } }
      ]
    }).lean());
  }

  const masterByDealer = new Map();
  const masterByPart = new Map();
  masters.forEach((master) => {
    const partNo = masterPartNumber(master);
    const dealerCode = cleanText(master.dealerCode).toUpperCase();
    if (partNo && dealerCode) masterByDealer.set(masterKey(partNo, dealerCode), master);
    if (partNo && !masterByPart.has(partNo)) masterByPart.set(partNo, master);
  });
  return { masterByDealer, masterByPart };
}

function addCategoryVarianceGroup(groupMap, productCategory, action, varianceQty, mrp, dlc) {
  const category = displayCategory(productCategory);
  const key = `${category}::${action}`;
  const group = groupMap.get(key) || {
    productCategory: category,
    action,
    sumVarianceOnMRP: 0,
    sumVarianceOnDLC: 0,
    rowType: 'detail'
  };
  group.sumVarianceOnMRP += varianceQty * mrp;
  group.sumVarianceOnDLC += varianceQty * dlc;
  groupMap.set(key, group);
}

async function buildCategoryWiseVarianceSummary(query = {}) {
  query = normalizeReportQuery(query);
  {
  const partwise = await buildPartwiseInventoryAuditReport(query);
  const groupMap = new Map();
  partwise.rows.forEach((row) => {
    const category = displayCategory(row.productCategory);
    const action = row.scanTypeAction || row.action || partwiseAction(Number(row.varianceQty || 0), Number(row.systemQty || 0) > 0, Number(row.physicalQty || 0));
    const key = `${category}::${action}`;
    const group = groupMap.get(key) || {
      productCategory: category,
      action,
      partSet: new Set(),
      totalScannedParts: 0,
      totalScannedQuantity: 0,
      sumPhysicalValueOnMRP: 0,
      sumPhysicalValueOnDLC: 0,
      sumVarianceOnMRP: 0,
      sumVarianceOnDLC: 0,
      rowType: 'detail'
    };
    if (Number(row.physicalQty || 0) > 0) group.partSet.add(row.partNum || row.partNumber || row.partNo);
    group.totalScannedQuantity += Number(row.physicalQty || 0);
    group.sumPhysicalValueOnMRP += Number(row.physicalValueOnMrp || 0);
    group.sumPhysicalValueOnDLC += Number(row.physicalValueOnDlc || 0);
    group.sumVarianceOnMRP += Number(row.varianceOnMrp || 0);
    group.sumVarianceOnDLC += Number(row.varianceOnDlc || 0);
    groupMap.set(key, group);
  });

  const detailRows = Array.from(groupMap.values()).map((row) => ({
    ...row,
    partSet: undefined,
    totalScannedParts: row.partSet.size,
    totalScannedQuantity: money(row.totalScannedQuantity),
    sumPhysicalValueOnMRP: money(row.sumPhysicalValueOnMRP),
    sumPhysicalValueOnDLC: money(row.sumPhysicalValueOnDLC),
    sumVarianceOnMRP: money(row.sumVarianceOnMRP),
    sumVarianceOnDLC: money(row.sumVarianceOnDLC)
  })).sort(sortCategoryVarianceRows);
  const byCategory = new Map();
  detailRows.forEach((row) => {
    const subtotal = byCategory.get(row.productCategory) || { totalScannedParts: 0, totalScannedQuantity: 0, sumPhysicalValueOnMRP: 0, sumPhysicalValueOnDLC: 0, sumVarianceOnMRP: 0, sumVarianceOnDLC: 0 };
    subtotal.totalScannedParts += Number(row.totalScannedParts || 0);
    subtotal.totalScannedQuantity += Number(row.totalScannedQuantity || 0);
    subtotal.sumPhysicalValueOnMRP += Number(row.sumPhysicalValueOnMRP || 0);
    subtotal.sumPhysicalValueOnDLC += Number(row.sumPhysicalValueOnDLC || 0);
    subtotal.sumVarianceOnMRP += Number(row.sumVarianceOnMRP || 0);
    subtotal.sumVarianceOnDLC += Number(row.sumVarianceOnDLC || 0);
    byCategory.set(row.productCategory, subtotal);
  });

  const rows = [];
  Array.from(byCategory.keys()).sort(sortText).forEach((category) => {
    CATEGORY_VARIANCE_ACTIONS.forEach((action) => {
      const row = detailRows.find((item) => item.productCategory === category && item.action === action);
      if (row) rows.push(row);
    });
    detailRows
      .filter((item) => item.productCategory === category && !CATEGORY_VARIANCE_ACTIONS.includes(item.action))
      .forEach((row) => rows.push(row));
    const subtotal = byCategory.get(category);
    rows.push({
      productCategory: `${category} TOTAL`,
      action: '',
      totalScannedParts: subtotal.totalScannedParts,
      totalScannedQuantity: money(subtotal.totalScannedQuantity),
      sumPhysicalValueOnMRP: money(subtotal.sumPhysicalValueOnMRP),
      sumPhysicalValueOnDLC: money(subtotal.sumPhysicalValueOnDLC),
      sumVarianceOnMRP: money(subtotal.sumVarianceOnMRP),
      sumVarianceOnDLC: money(subtotal.sumVarianceOnDLC),
      rowType: 'subtotal'
    });
  });

  const grandTotal = {
    totalScannedParts: rows.filter((row) => row.rowType === 'subtotal').reduce((sum, row) => sum + Number(row.totalScannedParts || 0), 0),
    totalScannedQuantity: money(rows.filter((row) => row.rowType === 'subtotal').reduce((sum, row) => sum + Number(row.totalScannedQuantity || 0), 0)),
    sumPhysicalValueOnMRP: money(rows.filter((row) => row.rowType === 'subtotal').reduce((sum, row) => sum + Number(row.sumPhysicalValueOnMRP || 0), 0)),
    sumPhysicalValueOnDLC: money(rows.filter((row) => row.rowType === 'subtotal').reduce((sum, row) => sum + Number(row.sumPhysicalValueOnDLC || 0), 0)),
    sumVarianceOnMRP: money(rows.filter((row) => row.rowType === 'subtotal').reduce((sum, row) => sum + Number(row.sumVarianceOnMRP || 0), 0)),
    sumVarianceOnDLC: money(rows.filter((row) => row.rowType === 'subtotal').reduce((sum, row) => sum + Number(row.sumVarianceOnDLC || 0), 0))
  };
  const validationLog = {
    ...partwise.validationLog,
    grandTotalMRP: grandTotal.sumVarianceOnMRP,
    grandTotalDLC: grandTotal.sumVarianceOnDLC
  };
  console.log('[category-wise-variance-summary] validation:', validationLog);
  return { rows, grandTotal, validationLog, summary: partwise.summary, selectedDealer: partwise.selectedDealer, selectedAudit: partwise.selectedAudit };
  }

  const productCategoryFilter = displayCategory(query.productCategory || query.category || '');
  const hasProductCategoryFilter = Boolean(cleanText(query.productCategory || query.category));
  const actionFilter = displayAction(query.action);
  const filter = scanBasedFilter({ ...query, category: '' });
  let [rawScans, dealers, audits] = await Promise.all([
    Inventory.find(filter).sort({ timestamp: 1 }).lean(),
    Dealer.find({}).sort({ dealerName: 1 }).lean(),
    Audit.find({}).sort({ createdAt: -1 }).lean()
  ]);
  rawScans = rawScans.map(inventoryRoute.publicScan);
  const { masterByDealer, masterByPart } = await masterMapsForScans(rawScans);
  const seen = new Set();
  const groupMap = new Map();
  const validationLog = {
    totalRowsProcessed: 0,
    unmatchedMasterRows: 0,
    duplicateScanIdsSkipped: 0,
    grandTotalMRP: 0,
    grandTotalDLC: 0
  };

  rawScans.forEach((scan) => {
    const duplicateKey = scanDuplicateKey(scan);
    if (duplicateKey && seen.has(duplicateKey)) {
      validationLog.duplicateScanIdsSkipped += 1;
      return;
    }
    if (duplicateKey) seen.add(duplicateKey);
    validationLog.totalRowsProcessed += 1;

    const partNo = normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part);
    const dealerCode = cleanText(scan.dealerCode).toUpperCase();
    const master = masterByDealer.get(masterKey(partNo, dealerCode)) || masterByPart.get(partNo) || null;
    if (!master) {
      validationLog.unmatchedMasterRows += 1;
      return;
    }

    const category = displayCategory(scan.productCategory || scan.category || (master ? master.productCategory || master.category : ''));
    const action = actionForScan(scan) || 'Inward';
    if (hasProductCategoryFilter && category !== productCategoryFilter) return;

    const qty = numberValue(scan.qty !== undefined ? scan.qty : scan.quantity, 0);
    const valueRow = scanValueRow(scan);
    const mrp = numberValue(valueRow.valuationMRP, 0);
    const dlc = numberValue(master && master.dlc !== undefined ? master.dlc : scan.dlc, 0);
    if (actionFilter === 'Inventory Matched') {
      if (master) addCategoryVarianceGroup(groupMap, category, 'Inventory Matched', 0, mrp, dlc);
      return;
    }
    if (actionFilter && action !== actionFilter) return;

    const varianceQty = signedVarianceQty(action, qty);
    addCategoryVarianceGroup(groupMap, category, action, varianceQty, mrp, dlc);
    if (master && action !== 'Inventory Matched' && (!actionFilter || actionFilter === 'Inventory Matched')) {
      addCategoryVarianceGroup(groupMap, category, 'Inventory Matched', 0, mrp, dlc);
    }
  });

  const detailRows = Array.from(groupMap.values()).map((row) => ({
    ...row,
    sumVarianceOnMRP: money(row.sumVarianceOnMRP),
    sumVarianceOnDLC: money(row.sumVarianceOnDLC)
  })).sort(sortCategoryVarianceRows);

  const byCategory = new Map();
  detailRows.forEach((row) => {
    const subtotal = byCategory.get(row.productCategory) || { sumVarianceOnMRP: 0, sumVarianceOnDLC: 0 };
    subtotal.sumVarianceOnMRP += Number(row.sumVarianceOnMRP || 0);
    subtotal.sumVarianceOnDLC += Number(row.sumVarianceOnDLC || 0);
    byCategory.set(row.productCategory, subtotal);
  });

  const rows = [];
  Array.from(byCategory.keys()).sort(sortText).forEach((category) => {
    CATEGORY_VARIANCE_ACTIONS.forEach((action) => {
      const row = detailRows.find((item) => item.productCategory === category && item.action === action);
      if (row) rows.push(row);
    });
    const subtotal = byCategory.get(category);
    rows.push({
      productCategory: `${category} TOTAL`,
      action: '',
      sumVarianceOnMRP: money(subtotal.sumVarianceOnMRP),
      sumVarianceOnDLC: money(subtotal.sumVarianceOnDLC),
      rowType: 'subtotal'
    });
  });

  const grandTotal = {
    sumVarianceOnMRP: money(rows.filter((row) => row.rowType === 'subtotal').reduce((sum, row) => sum + Number(row.sumVarianceOnMRP || 0), 0)),
    sumVarianceOnDLC: money(rows.filter((row) => row.rowType === 'subtotal').reduce((sum, row) => sum + Number(row.sumVarianceOnDLC || 0), 0))
  };
  validationLog.grandTotalMRP = grandTotal.sumVarianceOnMRP;
  validationLog.grandTotalDLC = grandTotal.sumVarianceOnDLC;

  const selectedDealer = query.dealerCode ? dealers.find((dealer) => dealer.dealerCode === String(query.dealerCode).trim().toUpperCase()) : null;
  const selectedAudit = query.auditId ? audits.find((audit) => audit.auditId === String(query.auditId).trim()) : null;
  const summary = {
    generatedAt: formatIstDateTime(new Date()),
    dealerName: query.dealerName || (selectedDealer ? selectedDealer.dealerName : 'All'),
    dealerCode: query.dealerCode || 'All',
    auditId: query.auditId || 'All',
    fromDate: query.from || '',
    toDate: query.to || '',
    productCategory: hasProductCategoryFilter ? productCategoryFilter : 'All',
    action: actionFilter || 'All'
  };

  console.log('[category-wise-variance-summary] validation:', validationLog);
  return { rows, grandTotal, validationLog, summary, selectedDealer, selectedAudit };
}

function addCategoryWiseVarianceSheet(workbook, data, name = 'Category Wise Variance Summary') {
  const sheet = workbook.addWorksheet(name.slice(0, 31));
  const columns = categoryVarianceColumns();
  sheet.columns = columns.map((column) => ({ key: column.key, width: column.width || 18 }));
  sheet.mergeCells(1, 1, 1, columns.length);
  sheet.getCell('A1').value = 'CATEGORY WISE VARIANCE SUMMARY';
  sheet.getCell('A1').font = { bold: true, size: 14 };
  sheet.addRow(['Dealer', data.summary.dealerName || 'All', 'Dealer Code', data.summary.dealerCode || 'All']);
  sheet.addRow(['Audit ID', data.summary.auditId || 'All', 'Date Range', `${data.summary.fromDate || 'All'} to ${data.summary.toDate || 'All'}`]);
  sheet.addRow([]);
  sheet.addRow(columns.map((column) => column.header));
  const headerRowNumber = sheet.rowCount;
  data.rows.forEach((row) => sheet.addRow({
    productCategory: row.productCategory,
    action: row.action,
    totalScannedParts: Number(row.totalScannedParts || 0),
    totalScannedQuantity: Number(row.totalScannedQuantity || 0),
    sumPhysicalValueOnMRP: Number(row.sumPhysicalValueOnMRP || 0),
    sumPhysicalValueOnDLC: Number(row.sumPhysicalValueOnDLC || 0),
    sumVarianceOnMRP: Number(row.sumVarianceOnMRP || 0),
    sumVarianceOnDLC: Number(row.sumVarianceOnDLC || 0)
  }));
  sheet.addRow({
    productCategory: 'Grand Total',
    action: '',
    totalScannedParts: Number(data.grandTotal.totalScannedParts || 0),
    totalScannedQuantity: Number(data.grandTotal.totalScannedQuantity || 0),
    sumPhysicalValueOnMRP: Number(data.grandTotal.sumPhysicalValueOnMRP || 0),
    sumPhysicalValueOnDLC: Number(data.grandTotal.sumPhysicalValueOnDLC || 0),
    sumVarianceOnMRP: Number(data.grandTotal.sumVarianceOnMRP || 0),
    sumVarianceOnDLC: Number(data.grandTotal.sumVarianceOnDLC || 0)
  });

  const header = sheet.getRow(headerRowNumber);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF153A5B' } };
  columns.forEach((column, index) => {
    if (column.numFmt) sheet.getColumn(index + 1).numFmt = column.numFmt;
  });
  sheet.eachRow((row, rowNumber) => {
    row.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
      };
    });
    const label = String(row.getCell(1).value || '');
    if (rowNumber > headerRowNumber && (/TOTAL$/i.test(label) || label === 'Grand Total')) {
      row.font = { bold: true };
    }
    if (label === 'Grand Total') {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F2FC' } };
    }
  });
  sheet.views = [{ state: 'frozen', ySplit: headerRowNumber }];
  return sheet;
}

function buildCategoryWiseVariancePdfBuffer(data) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const columns = categoryVarianceColumns();
  doc.setFontSize(14);
  doc.text('CATEGORY WISE VARIANCE SUMMARY', 24, 26);
  doc.setFontSize(9);
  doc.text(`Dealer: ${data.summary.dealerName || 'All'} | Code: ${data.summary.dealerCode || 'All'} | Audit: ${data.summary.auditId || 'All'} | Date: ${data.summary.fromDate || 'All'} to ${data.summary.toDate || 'All'}`, 24, 42);
  const body = data.rows.concat([{ productCategory: 'Grand Total', action: '', ...data.grandTotal, rowType: 'grandTotal' }]).map((row) => columns.map((column) => {
    const value = row[column.key];
    return typeof value === 'number' || column.numFmt ? Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: column.key === 'totalScannedParts' ? 0 : 2, maximumFractionDigits: column.key === 'totalScannedParts' ? 0 : 2 }) : String(value || '');
  }));
  autoTable(doc, {
    startY: 58,
    head: [columns.map((column) => column.header)],
    body,
    styles: { fontSize: 6, cellPadding: 3 },
    headStyles: { fillColor: [21, 58, 91], textColor: [255, 255, 255] },
    didParseCell: (hookData) => {
      if (hookData.section !== 'body') return;
      const label = String(hookData.row.raw[0] || '');
      if (/TOTAL$/i.test(label) || label === 'Grand Total') hookData.cell.styles.fontStyle = 'bold';
      if (label === 'Grand Total') hookData.cell.styles.fillColor = [232, 242, 252];
    }
  });
  return Buffer.from(doc.output('arraybuffer'));
}

const STOCK_SUMMARY_TITLE = 'Stock Summary Report';
const STOCK_SUMMARY_CATEGORIES = [
  'HHML Parts',
  'VIDA Parts',
  'HHML Publication',
  'HHML Tyre',
  'Lubricant',
  'Accessories',
  'Merchandise',
  'Helmet',
  'Tools',
  'HHML Consumables'
];

function stockSummaryColumns() {
  return [
    { header: 'Category', key: 'category', width: 20 },
    { header: 'Value', key: 'dmsValue', width: 16 },
    { header: 'Part Lines', key: 'dmsPartLines', width: 12 },
    { header: 'Quantity', key: 'dmsQuantity', width: 14 },
    { header: 'Value', key: 'physicalValue', width: 16 },
    { header: 'Part Lines', key: 'physicalPartLines', width: 12 },
    { header: 'Quantity', key: 'physicalQuantity', width: 14 },
    { header: 'Value', key: 'excessValue', width: 16 },
    { header: 'Part Lines', key: 'excessPartLines', width: 12 },
    { header: 'Value', key: 'shortValue', width: 16 },
    { header: 'Part Lines', key: 'shortPartLines', width: 12 },
    { header: 'Value', key: 'netDifference', width: 16 }
  ];
}

function stockSummaryQty(scan = {}) {
  const qty = numberValue(scan.qty !== undefined ? scan.qty : scan.quantity, 0);
  const type = cleanText(scan.scanType || scan.type).toUpperCase();
  if (type === 'FITTED' || scan.isFitted) return 0;
  if (['OUTWARD', 'DAMAGE'].includes(type)) return -Math.abs(qty);
  return Math.abs(qty);
}

function stockSummaryValue(row = {}, qtyKey, rateKey) {
  if (rateKey === 'mrp') {
    if (/^system/i.test(qtyKey)) return 0;
    return Number(row.finalInventoryValue || row.physicalValueOnMrp || row.varianceOnMrp || 0);
  }
  return Number(row[qtyKey] || 0) * Number(row[rateKey] || 0);
}

function stockSummaryPct(value, base) {
  const denominator = Number(base || 0);
  return denominator ? Number(value || 0) / denominator : 0;
}

function stockSummaryCategoryText(row = {}) {
  return [row.productCategory, row.category, row.productGroup, row.partSubGroup, row.partDescription].filter(Boolean).join(' ').toUpperCase();
}

function isStockSummaryExcluded(row = {}) {
  const text = stockSummaryCategoryText(row);
  if (/\b(OIL|LUBE|LUBRICANT|PUBLICATION|BATTERY|TOOLS?|MERCHANDISE|CONSUMABLES?)\b/i.test(text)) return true;
  if (/LOCAL/i.test(text) && /(PART|ACCESSOR)/i.test(text)) return true;
  return false;
}

function isStockSummaryAccessory(row = {}) {
  return /ACCESSOR/i.test(stockSummaryCategoryText(row)) && !/LOCAL/i.test(stockSummaryCategoryText(row));
}

function stockSummaryRowMatchesFilters(row = {}, query = {}) {
  const category = cleanText(query.productCategory || query.category);
  if (category && !new RegExp(escapeRegExp(category), 'i').test(row.productCategory || row.category || '')) return false;
  if (query.model && !new RegExp(escapeRegExp(query.model), 'i').test(row.model || '')) return false;
  if (query.year && ![row.year, row.manufacturingYear].some((value) => new RegExp(escapeRegExp(query.year), 'i').test(value || ''))) return false;
  if (query.productGroup && !new RegExp(escapeRegExp(query.productGroup), 'i').test(row.productGroup || '')) return false;
  if ((query.partSubGroup || query.productSubGroup) && !new RegExp(escapeRegExp(query.partSubGroup || query.productSubGroup), 'i').test(row.partSubGroup || '')) return false;
  return true;
}

function summarizeStockRows(rows = []) {
  return rows.reduce((total, row) => {
    total.skuCount += 1;
    total.physicalBinQty += Number(row.physicalBinQty ?? row.physicalQty ?? 0);
    total.fittedQty += Number(row.fittedQty || 0);
    total.finalAuditQty += Number(row.finalAuditQty ?? row.actualAuditQty ?? row.physicalQty ?? 0);
    total.physicalMrp += stockSummaryValue(row, 'physicalQty', 'mrp');
    total.physicalDlc += stockSummaryValue(row, 'physicalQty', 'dlc');
    total.finalAuditMrp += stockSummaryValue(row, 'finalAuditQty', 'mrp');
    total.finalAuditDlc += stockSummaryValue(row, 'finalAuditQty', 'dlc');
    total.systemMrp += stockSummaryValue(row, 'systemQty', 'mrp');
    total.systemDlc += stockSummaryValue(row, 'systemQty', 'dlc');
    total.varianceMrp += stockSummaryValue(row, 'varianceQty', 'mrp');
    total.varianceDlc += stockSummaryValue(row, 'varianceQty', 'dlc');
    return total;
  }, { skuCount: 0, physicalBinQty: 0, fittedQty: 0, finalAuditQty: 0, physicalMrp: 0, physicalDlc: 0, finalAuditMrp: 0, finalAuditDlc: 0, systemMrp: 0, systemDlc: 0, varianceMrp: 0, varianceDlc: 0 });
}

function caseSummary(rows = [], mode) {
  const filtered = rows.filter((row) => {
    const physical = Number(row.finalAuditQty ?? row.physicalQty ?? 0);
    const system = Number(row.systemQty || 0);
    if (mode === 'case1') return physical > 0 && system <= 0;
    if (mode === 'case2') return physical > system && system > 0;
    if (mode === 'case3') return system > physical;
    if (mode === 'case4') return physical === system && (physical > 0 || system > 0);
    return false;
  });
  return filtered.reduce((total, row) => {
    const physical = Number(row.finalAuditQty ?? row.physicalQty ?? 0);
    const system = Number(row.systemQty || 0);
    const diff = physical - system;
    const qty = mode === 'case4' ? physical : Math.abs(diff);
    total.skuCount += 1;
    total.valueOnMrp += mode === 'case3' ? 0 : Number(row.finalInventoryValue || row.physicalValueOnMrp || 0);
    total.valueOnDlc += qty * Number(row.dlc || 0);
    total.signedMrp += diff < 0 ? 0 : Number(row.finalInventoryValue || row.physicalValueOnMrp || 0);
    total.signedDlc += diff * Number(row.dlc || 0);
    return total;
  }, { skuCount: 0, valueOnMrp: 0, valueOnDlc: 0, signedMrp: 0, signedDlc: 0 });
}

function stockSummaryAuditDateLabel(query = {}) {
  return query.auditDate || (query.from && query.to && query.from === query.to ? query.from : query.to || query.from || 'selected audit date');
}

function emptyStockSummaryCategory(category) {
  return {
    category,
    dmsValue: 0,
    dmsPartLines: 0,
    dmsQuantity: 0,
    physicalValue: 0,
    physicalPartLines: 0,
    physicalQuantity: 0,
    excessValue: 0,
    excessPartLines: 0,
    shortValue: 0,
    shortPartLines: 0,
    netDifference: 0
  };
}

function stockSummaryCategory(row = {}) {
  const text = stockSummaryCategoryText(row);
  if (/\bVIDA\b/i.test(text)) return 'VIDA Parts';
  if (/PUBLICATION|PUBLI|CATALOG|CATALOGUE|MANUAL|BOOK|LITERATURE/i.test(text)) return 'HHML Publication';
  if (/\b(TYRE|TIRE|TUBE)\b/i.test(text)) return 'HHML Tyre';
  if (/\b(OIL|LUBE|LUBRICANT|GREASE)\b/i.test(text)) return 'Lubricant';
  if (/ACCESSOR/i.test(text)) return 'Accessories';
  if (/MERCHANDISE|MERCH/i.test(text)) return 'Merchandise';
  if (/HELMET/i.test(text)) return 'Helmet';
  if (/\bTOOLS?\b/i.test(text)) return 'Tools';
  if (/CONSUMABLE/i.test(text)) return 'HHML Consumables';
  return 'HHML Parts';
}

function addStockSummaryMatrixValues(total, row = {}) {
  const systemQty = Number(row.systemQty || 0);
  const physicalQty = Number(row.finalAuditQty ?? row.actualAuditQty ?? row.physicalQty ?? 0);
  const varianceQty = physicalQty - systemQty;
  const dmsValue = 0;
  const physicalValue = Number(row.finalInventoryValue || row.physicalValueOnMrp || 0);
  const varianceValue = varianceQty > 0 ? physicalValue : 0;
  total.dmsValue += dmsValue;
  total.dmsQuantity += systemQty;
  if (systemQty !== 0) total.dmsPartLines += 1;
  total.physicalValue += physicalValue;
  total.physicalQuantity += physicalQty;
  if (physicalQty !== 0) total.physicalPartLines += 1;
  if (varianceQty > 0) {
    total.excessValue += varianceValue;
    total.excessPartLines += 1;
  } else if (varianceQty < 0) {
    total.shortValue += varianceValue;
    total.shortPartLines += 1;
  }
  total.netDifference += varianceValue;
}

function roundStockSummaryMatrixRow(row = {}) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (key === 'category' || key === 'rowType') return [key, value];
    return [key, money(value)];
  }));
}

function stockSummaryMatrixRows(rows = []) {
  const buckets = new Map(STOCK_SUMMARY_CATEGORIES.map((category) => [category, emptyStockSummaryCategory(category)]));
  rows.forEach((row) => {
    const category = stockSummaryCategory(row);
    const bucket = buckets.get(category) || emptyStockSummaryCategory(category);
    addStockSummaryMatrixValues(bucket, row);
    buckets.set(category, bucket);
  });
  return STOCK_SUMMARY_CATEGORIES.map((category) => roundStockSummaryMatrixRow(buckets.get(category) || emptyStockSummaryCategory(category)));
}

function stockSummaryGrandTotal(rows = []) {
  const total = rows.reduce((summary, row) => {
    stockSummaryColumns().forEach((column) => {
      if (column.key !== 'category') summary[column.key] += Number(row[column.key] || 0);
    });
    return summary;
  }, emptyStockSummaryCategory('Grand Total'));
  return { ...roundStockSummaryMatrixRow(total), rowType: 'total' };
}

function stockSummaryDamageValue(scans = [], rowByPart = new Map()) {
  return scans.reduce((sum, scan) => {
    const type = cleanText(scan.scanType || scan.type).toUpperCase();
    if (type !== 'DAMAGE') return sum;
    const qty = Math.abs(numberValue(scan.qty !== undefined ? scan.qty : scan.quantity, 0));
    const valueRow = scanValueRow(scan);
    return sum + qty * Number(valueRow.valuationMRP || 0);
  }, 0);
}

function stockSummaryDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return cleanText(value);
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'Asia/Kolkata'
  }).format(date);
}

function stockSummaryMetadata(selectedDealer = {}, selectedAudit = {}, query = {}) {
  const audit = selectedAudit || {};
  const dealer = selectedDealer || {};
  const brand = firstPresent(audit.brand, dealer.brand, '');
  const dealerName = firstPresent(query.dealerName, audit.dealerName, dealer.dealerName, '');
  const dealership = dealerName ? `${dealerName}${brand ? ` (${brand})` : ''}` : '';
  return [
    { label: 'Dealership Name', value: dealership },
    { label: 'Brand', value: brand || '' },
    { label: 'Location', value: firstPresent(audit.location, dealer.location, '') || '' },
    { label: 'Audit Start Date', value: stockSummaryDate(firstPresent(audit.auditStartDate, dealer.auditStartDate, query.from)) },
    { label: 'Audit End Date', value: stockSummaryDate(firstPresent(audit.auditClosedDate, dealer.auditClosedDate, query.to)) },
    { label: 'Audit Completed By', value: firstPresent(audit.completedBy, '') || '' },
    { label: 'SPM Name', value: firstPresent(audit.spmName, dealer.spmName, '') || '' },
    { label: 'General Manager', value: firstPresent(audit.generalManager, dealer.generalManager, '') || '' },
    { label: 'Auditer Name', value: firstPresent(audit.auditorName, dealer.auditorName, '') || '' }
  ];
}

async function buildStockSummaryReport(query = {}) {
  query = normalizeReportQuery(query);
  const dealerCode = query.dealerCode;
  const scanFilter = scanBasedFilter({ ...query, category: '', productCategory: '', productGroup: '', partSubGroup: '', productSubGroup: '', model: '', year: '', type: '', scanType: '' });
  scanFilter.$and = (scanFilter.$and || []).concat([
    { syncStatus: { $nin: ['duplicate', 'rejected', 'failed'] } },
    { isDuplicate: { $ne: true } }
  ]);
  const [rawScans, stockRows, dealers, audits] = await Promise.all([
    Inventory.find(scanFilter).sort({ timestamp: 1 }).lean(),
    DealerStock.find({ dealerCode }).sort({ partNumber: 1 }).lean(),
    Dealer.find({}).sort({ dealerName: 1 }).lean(),
    Audit.find({ dealerCode }).sort({ createdAt: -1 }).lean()
  ]);
  const scans = rawScans.map(inventoryRoute.publicScan);
  const seenScanIds = new Set();
  const physicalGroups = new Map();
  scans.forEach((scan) => {
    const duplicateKey = scanDuplicateKey(scan);
    if (duplicateKey && seenScanIds.has(duplicateKey)) return;
    if (duplicateKey) seenScanIds.add(duplicateKey);
    const partNo = normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part);
    if (!partNo || /^SYNC/i.test(partNo)) return;
    const group = physicalGroups.get(partNo) || { partNo, scans: [], physicalQty: 0, fittedQty: 0, firstScan: scan };
    const qty = stockSummaryQty(scan);
    group.scans.push({ ...scan, qty });
    group.physicalQty += qty;
    if (cleanText(scan.scanType || scan.type).toUpperCase() === 'FITTED') group.fittedQty += Math.abs(numberValue(scan.qty !== undefined ? scan.qty : scan.quantity, 0));
    physicalGroups.set(partNo, group);
  });
  const stockByPart = new Map();
  stockRows.forEach((stock) => {
    const partNo = normalizePartNumber(stock.normalizedPartNumber || stock.partNumber);
    if (!partNo) return;
    const existing = stockByPart.get(partNo);
    if (existing) {
      existing.systemQty = Number(existing.systemQty || existing.dmsStock || 0) + Number(stock.systemQty || stock.dmsStock || 0);
      existing.dmsStock = existing.systemQty;
    } else {
      stockByPart.set(partNo, { ...stock, systemQty: Number(stock.systemQty || stock.dmsStock || 0), dmsStock: Number(stock.systemQty || stock.dmsStock || 0) });
    }
  });
  const allParts = Array.from(new Set([...stockByPart.keys(), ...physicalGroups.keys()]));
  const catalogueRows = allParts.length ? await MasterCatalogue.find({ normalizedPartNumber: { $in: allParts } }).lean() : [];
  const catalogueByPart = new Map(catalogueRows.map((row) => [masterPartNumber(row), cataloguePayload(row)]).filter(([partNo]) => partNo));
  const rows = allParts.filter((partNo) => stockByPart.has(partNo) || catalogueByPart.has(partNo)).map((partNo) => {
    const stock = stockByPart.get(partNo) || {};
    const physical = physicalGroups.get(partNo) || {};
    const firstScan = physical.firstScan || {};
    const catalogue = catalogueByPart.get(partNo) || {};
    const detail = Object.keys(stock).length ? stock : (Object.keys(catalogue).length ? catalogue : firstScan);
    const valueSummary = rowValueSummary(physical.scans || [], catalogue);
    const mrp = valuationRateForDisplay(valueSummary);
    const dlc = numberValue(firstPresent(stock.dlc, catalogue.dlc, firstScan.dlc), 0);
    const systemQty = numberValue(firstPresent(stock.systemQty, stock.dmsStock), 0);
    const physicalQty = numberValue(physical.physicalQty, 0);
    const fittedQty = numberValue(physical.fittedQty, 0);
    const finalAuditQty = physicalQty + fittedQty;
    const varianceQty = finalAuditQty - systemQty;
    const fitted = fittedDetails(physical.scans || []);
    return {
      partNumber: partNo,
      partNo,
      partDescription: firstPresent(detail.partDescription, detail.partName, firstScan.partDescription, firstScan.partName) || '',
      productCategory: firstPresent(detail.productCategory, detail.category, firstScan.productCategory, firstScan.category) || '',
      category: firstPresent(detail.category, detail.productCategory, firstScan.category, firstScan.productCategory) || '',
      productGroup: firstPresent(detail.productGroup, firstScan.productGroup) || '',
      partSubGroup: firstPresent(detail.partSubGroup, firstScan.partSubGroup) || '',
      model: firstPresent(detail.model, firstScan.model) || '',
      year: firstPresent(detail.year, detail.manufacturingYear, firstScan.year, firstScan.manufacturingYear) || '',
      manufacturingYear: firstPresent(detail.manufacturingYear, detail.year, firstScan.manufacturingYear, firstScan.year) || '',
      mrp,
      currentCatalogueMRP: valueSummary.currentCatalogueMRP,
      averageScannedMRP: valueSummary.averageScannedMRP,
      minScannedMRP: valueSummary.minScannedMRP,
      maxScannedMRP: valueSummary.maxScannedMRP,
      totalScanValue: valueSummary.totalScanValue,
      totalManualValue: valueSummary.totalManualValue,
      finalInventoryValue: valueSummary.finalInventoryValue,
      dlc,
      systemQty,
      physicalQty,
      physicalBinQty: physicalQty,
      fittedQty,
      finalAuditQty,
      actualAuditQty: finalAuditQty,
      fittedRegdNo: fitted.fittedRegdNo,
      fittedJobCardNo: fitted.fittedJobCardNo,
      regdNo: fitted.fittedRegdNo,
      jobCardNo: fitted.fittedJobCardNo,
      fittedStatus: fittedQty > 0 ? 'Fitted' : 'Not Fitted',
      varianceQty,
      systemValueOnMrp: 0,
      systemValueOnDlc: systemQty * dlc,
      physicalValueOnMrp: valueSummary.finalInventoryValue,
      physicalValueOnDlc: finalAuditQty * dlc,
      varianceOnMrp: valueSummary.finalInventoryValue,
      varianceOnDlc: varianceQty * dlc
    };
  }).filter((row) => stockSummaryRowMatchesFilters(row, query));
  const selectedDealer = dealerCode ? dealers.find((dealer) => dealer.dealerCode === dealerCode) : null;
  const selectedAudit = query.auditId
    ? audits.find((audit) => audit.auditId === query.auditId)
    : (selectedDealer && selectedDealer.currentAuditId
      ? audits.find((audit) => audit.auditId === selectedDealer.currentAuditId)
      : audits[0]);
  const matrixRows = stockSummaryMatrixRows(rows);
  const grandTotal = stockSummaryGrandTotal(matrixRows);
  const rowByPart = new Map(rows.map((row) => [normalizePartNumber(row.partNo || row.partNumber), row]).filter(([partNo]) => partNo));
  const footer = {
    damagedItemsValue: money(stockSummaryDamageValue(scans, rowByPart)),
    manualContribution: '',
    totalShortValue: grandTotal.shortValue,
    totalExcessValue: grandTotal.excessValue,
    netDiff: grandTotal.netDifference,
    undefinedItemsDeadline: '',
    damagedItemsDeadline: ''
  };
  const metadata = stockSummaryMetadata(selectedDealer, selectedAudit, query);
  const sections = {
    title: STOCK_SUMMARY_TITLE,
    metadata,
    rows: matrixRows,
    grandTotal,
    footer
  };
  const summary = {
    title: STOCK_SUMMARY_TITLE,
    metadata,
    footer,
    generatedAt: formatIstDateTime(new Date()),
    dealerName: query.dealerName || (selectedDealer ? selectedDealer.dealerName : ''),
    dealerCode,
    auditId: selectedAudit ? selectedAudit.auditId : (query.auditId || ''),
    auditDate: stockSummaryDate(firstPresent(selectedAudit && selectedAudit.auditStartDate, selectedDealer && selectedDealer.auditStartDate, query.from)),
    productCategory: query.productCategory || query.category || 'All',
    model: query.model || 'All',
    year: query.year || 'All',
    totalSkuCount: rows.length,
    totalStockRows: stockRows.length,
    totalPhysicalParts: physicalGroups.size
  };
  return { rows: matrixRows.concat([grandTotal]), columns: stockSummaryColumns(), sections, summary, detailRows: rows, message: rows.length ? '' : 'No stock summary data found for selected dealer/filter' };
}

function styleStockSummaryRange(sheet, startRow, endRow, startCol = 1, endCol = 6) {
  for (let rowNumber = startRow; rowNumber <= endRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    for (let col = startCol; col <= endCol; col += 1) {
      const cell = row.getCell(col);
      cell.border = {
        top: { style: 'thin', color: { argb: 'FF94A3B8' } },
        left: { style: 'thin', color: { argb: 'FF94A3B8' } },
        bottom: { style: 'thin', color: { argb: 'FF94A3B8' } },
        right: { style: 'thin', color: { argb: 'FF94A3B8' } }
      };
      cell.alignment = { vertical: 'middle', wrapText: true };
    }
  }
}

function addStockSummarySheet(workbook, data) {
  const sheet = workbook.addWorksheet('Stock Summary');
  sheet.columns = [
    { width: 22 }, { width: 15 }, { width: 11 }, { width: 12 },
    { width: 15 }, { width: 11 }, { width: 12 }, { width: 14 },
    { width: 11 }, { width: 14 }, { width: 11 }, { width: 14 }
  ];
  const fills = {
    title: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBDD7EE' } },
    meta: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC9C9C9' } },
    green: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFA7BF95' } },
    dms: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6A58E' } },
    physical: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD8C87E' } },
    excess: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7188AD' } },
    short: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBFBFBF' } },
    net: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8FB2CC' } },
    total: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF70A83A' } },
    black: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000000' } }
  };
  const border = {
    top: { style: 'thin', color: { argb: 'FF000000' } },
    left: { style: 'thin', color: { argb: 'FF000000' } },
    bottom: { style: 'thin', color: { argb: 'FF000000' } },
    right: { style: 'thin', color: { argb: 'FF000000' } }
  };
  const center = { vertical: 'middle', horizontal: 'center', wrapText: true };
  const numberKeys = stockSummaryColumns().filter((column) => column.key !== 'category').map((column) => column.key);
  const applyRange = (startRow, endRow, startCol = 1, endCol = 12) => {
    for (let rowNumber = startRow; rowNumber <= endRow; rowNumber += 1) {
      for (let colNumber = startCol; colNumber <= endCol; colNumber += 1) {
        const cell = sheet.getCell(rowNumber, colNumber);
        cell.border = border;
        cell.alignment = center;
      }
    }
  };
  const setFill = (rowNumber, startCol, endCol, fill, font = {}) => {
    for (let colNumber = startCol; colNumber <= endCol; colNumber += 1) {
      const cell = sheet.getCell(rowNumber, colNumber);
      cell.fill = fill;
      cell.font = { name: 'Arial', size: 10, ...font };
    }
  };
  const setNumber = (rowNumber, colNumber, value) => {
    const cell = sheet.getCell(rowNumber, colNumber);
    cell.value = Number(value || 0);
    cell.numFmt = '0';
  };

  sheet.mergeCells('A1:L1');
  sheet.getCell('A1').value = 'Daksh Inventory Solution V2';
  setFill(1, 1, 12, fills.black, { bold: true, size: 16, color: { argb: 'FFFFFFFF' } });
  sheet.getRow(1).height = 24;

  sheet.mergeCells('A2:L2');
  sheet.getCell('A2').value = data.sections.title || STOCK_SUMMARY_TITLE;
  setFill(2, 1, 12, fills.title, { bold: false, size: 14 });
  sheet.getRow(2).height = 22;

  const metadata = data.sections.metadata || [];
  metadata.forEach((item, index) => {
    const rowNumber = index + 3;
    sheet.mergeCells(rowNumber, 1, rowNumber, 3);
    sheet.mergeCells(rowNumber, 4, rowNumber, 12);
    sheet.getCell(rowNumber, 1).value = `${item.label || ''} :`;
    sheet.getCell(rowNumber, 4).value = item.value || '';
    sheet.getCell(rowNumber, 1).alignment = { vertical: 'middle', horizontal: 'right', wrapText: true };
    sheet.getCell(rowNumber, 4).alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    setFill(rowNumber, 1, 12, fills.meta, { bold: false });
    sheet.getCell(rowNumber, 1).font = { name: 'Arial', size: 10, bold: true };
    sheet.getCell(rowNumber, 4).font = { name: 'Arial', size: 10, bold: /Dealership Name/i.test(item.label || '') };
  });

  const serviceRow = metadata.length + 3;
  sheet.mergeCells(serviceRow, 1, serviceRow, 12);
  sheet.getCell(serviceRow, 1).value = data.sections.title || STOCK_SUMMARY_TITLE;
  setFill(serviceRow, 1, 12, fills.green, { bold: true });

  const groupRow = serviceRow + 1;
  const subHeadRow = serviceRow + 2;
  sheet.mergeCells(groupRow, 1, subHeadRow, 1);
  sheet.getCell(groupRow, 1).value = 'Category';
  sheet.mergeCells(groupRow, 2, groupRow, 4);
  sheet.getCell(groupRow, 2).value = 'DMS Stock';
  sheet.mergeCells(groupRow, 5, groupRow, 7);
  sheet.getCell(groupRow, 5).value = 'Physical Stock as Counted';
  sheet.mergeCells(groupRow, 8, groupRow, 9);
  sheet.getCell(groupRow, 8).value = 'Excess Found';
  sheet.mergeCells(groupRow, 10, groupRow, 11);
  sheet.getCell(groupRow, 10).value = 'Short Found';
  sheet.getCell(groupRow, 12).value = 'Net Difference';
  ['Value', 'Part Lines', 'Quantity', 'Value', 'Part Lines', 'Quantity', 'Value', 'Part Lines', 'Value', 'Part Lines', 'Value']
    .forEach((value, index) => { sheet.getCell(subHeadRow, index + 2).value = value; });
  setFill(groupRow, 1, 1, fills.green, { bold: true });
  setFill(subHeadRow, 1, 1, fills.green, { bold: true });
  setFill(groupRow, 2, 4, fills.dms, { bold: true });
  setFill(subHeadRow, 2, 4, fills.dms, { bold: true });
  setFill(groupRow, 5, 7, fills.physical, { bold: true });
  setFill(subHeadRow, 5, 7, fills.physical, { bold: true });
  setFill(groupRow, 8, 9, fills.excess, { bold: true });
  setFill(subHeadRow, 8, 9, fills.excess, { bold: true });
  setFill(groupRow, 10, 11, fills.short, { bold: true });
  setFill(subHeadRow, 10, 11, fills.short, { bold: true });
  setFill(groupRow, 12, 12, fills.net, { bold: true });
  setFill(subHeadRow, 12, 12, fills.net, { bold: true });

  const rows = data.rows || [];
  const dataStartRow = subHeadRow + 1;
  rows.forEach((row, rowIndex) => {
    const rowNumber = dataStartRow + rowIndex;
    sheet.getCell(rowNumber, 1).value = row.category;
    numberKeys.forEach((key, index) => setNumber(rowNumber, index + 2, row[key]));
    const isTotal = row.rowType === 'total';
    setFill(rowNumber, 1, 12, isTotal ? fills.total : fills.meta, { bold: isTotal });
    sheet.getCell(rowNumber, 1).font = { name: 'Arial', size: 10, bold: true };
    setFill(rowNumber, 2, 4, isTotal ? fills.total : fills.dms, { bold: isTotal });
    setFill(rowNumber, 5, 7, isTotal ? fills.total : fills.physical, { bold: isTotal });
    setFill(rowNumber, 8, 9, isTotal ? fills.total : fills.excess, { bold: isTotal });
    setFill(rowNumber, 10, 11, isTotal ? fills.total : fills.short, { bold: isTotal });
    setFill(rowNumber, 12, 12, isTotal ? fills.total : fills.net, { bold: isTotal });
  });

  const footerStart = dataStartRow + rows.length + 1;
  const footer = data.sections.footer || {};
  const footerRows = [
    ['Damaged Items Value( Considered Value)', footer.damagedItemsValue || 0, 'damage'],
    ['Manual Contribution', footer.manualContribution || '', 'normal'],
    ['Total Short Value', footer.totalShortValue || 0, 'short'],
    ['Total Excess Value', footer.totalExcessValue || 0, 'excess'],
    ['Net Diff', footer.netDiff || 0, 'net'],
    ['Undefined Items Dead Line', footer.undefinedItemsDeadline || '', 'normal'],
    ['Damaged items dead line', footer.damagedItemsDeadline || '', 'normal']
  ];
  footerRows.forEach(([label, value, kind], index) => {
    const rowNumber = footerStart + index;
    sheet.mergeCells(rowNumber, 1, rowNumber, 4);
    sheet.mergeCells(rowNumber, 5, rowNumber, 7);
    sheet.mergeCells(rowNumber, 8, rowNumber, 12);
    sheet.getCell(rowNumber, 1).value = label;
    sheet.getCell(rowNumber, 5).value = value === '' ? '' : Number(value || 0);
    if (value !== '') sheet.getCell(rowNumber, 5).numFmt = '0';
    setFill(rowNumber, 1, 4, fills.green, { bold: true });
    setFill(rowNumber, 5, 7, kind === 'damage' ? fills.excess : kind === 'net' ? fills.black : fills.meta, { bold: true });
    setFill(rowNumber, 8, 12, fills.meta, {});
    if (kind === 'short') sheet.getCell(rowNumber, 5).font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFF0000' } };
    if (kind === 'excess') sheet.getCell(rowNumber, 5).font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF008000' } };
    if (kind === 'net') sheet.getCell(rowNumber, 5).font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
  });

  applyRange(1, footerStart + footerRows.length - 1);
  sheet.views = [{ state: 'frozen', ySplit: subHeadRow }];
  return sheet;
}

router.get('/stock-summary', auth.requireAuth, async (req, res) => {
  try {
    const reportQuery = requireDealerForReport(req.query);
    const data = await buildStockSummaryReport(reportQuery);
    if (req.query.format === 'excel') {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Daksh Inventory v2';
      workbook.created = new Date();
      addStockSummarySheet(workbook, data);
      const buffer = await workbook.xlsx.writeBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="Stock_Summary.xlsx"');
      return res.send(Buffer.from(buffer));
    }
    return res.json({
      success: true,
      type: 'stock-summary',
      title: 'Stock Summary',
      columns: data.columns.map(({ header, key }) => ({ header, key })),
      rows: data.rows,
      sections: data.sections,
      summary: data.summary,
      totalRows: data.rows.length,
      message: data.message
    });
  } catch (error) {
    return res.status(reportErrorStatus(error)).json({ success: false, message: error.message });
  }
});

router.get('/category-wise-variance-summary', auth.requireAuth, async (req, res) => {
  try {
    const data = await buildCategoryWiseVarianceSummary(req.query);
    if (req.query.format === 'excel') {
      if (hasRequestedReportColumns(req.query)) {
        const exportRows = data.rows.concat([{ productCategory: 'Grand Total', action: '', ...data.grandTotal, rowType: 'grandTotal' }]);
        return sendSelectedColumnsWorkbook(res, 'Category_Wise_Variance_Summary.xlsx', 'Category Wise Variance Summary', categoryVarianceColumns(), exportRows, req.query);
      }
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Daksh Inventory v2';
      workbook.created = new Date();
      addCategoryWiseVarianceSheet(workbook, data);
      const buffer = await workbook.xlsx.writeBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="Category_Wise_Variance_Summary.xlsx"');
      return res.send(Buffer.from(buffer));
    }
    if (req.query.format === 'pdf') {
      const pdf = buildCategoryWiseVariancePdfBuffer(data);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="Category_Wise_Variance_Summary.pdf"');
      return res.send(pdf);
    }
    return res.json({
      success: true,
      type: 'category-wise-variance-summary',
      title: 'Category Wise Variance Summary',
      columns: categoryVarianceColumns().map(({ header, key }) => ({ header, key })),
      rows: data.rows,
      grandTotal: data.grandTotal,
      validationLog: data.validationLog,
      summary: data.summary,
      totalRows: data.rows.length,
      message: data.rows.length ? '' : 'No report data found for selected filter'
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/partwise-inventory-audit', auth.requireAuth, async (req, res) => {
  try {
    const reportQuery = requireDealerForReport(req.query);
    const data = await buildPartwiseInventoryAuditReport(reportQuery);
    if (req.query.format === 'excel') {
      if (hasRequestedReportColumns(reportQuery)) {
        return sendSelectedColumnsWorkbook(res, 'Partwise_Inventory_Audit_Report.xlsx', 'Partwise Inventory Audit', data.columns, data.rows, reportQuery);
      }
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Daksh Inventory v2';
      workbook.created = new Date();
      addPartwiseInventoryAuditSheet(workbook, data);
      const buffer = await workbook.xlsx.writeBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="Partwise_Inventory_Audit_Report.xlsx"');
      return res.send(Buffer.from(buffer));
    }
    if (req.query.format === 'pdf') {
      const pdf = buildPartwiseInventoryAuditPdfBuffer(data);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="Partwise_Inventory_Audit_Report.pdf"');
      return res.send(pdf);
    }
    return res.json({
      success: true,
      type: 'partwise-inventory-audit',
      title: 'PARTWISE INVENTORY AUDIT REPORT',
      columns: data.columns.map(({ header, key }) => ({ header, key })),
      rows: data.rows,
      summary: data.summary,
      validationLog: data.validationLog,
      totalRows: data.rows.length,
      message: data.rows.length ? '' : 'No report data found for selected filter'
    });
  } catch (error) {
    return res.status(reportErrorStatus(error)).json({ success: false, message: error.message });
  }
});

router.post('/partwise-inventory-audit/email', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const to = String(req.body.to || req.body.email || '').trim();
    const cc = String(req.body.cc || '').trim();
    const attachmentType = String(req.body.attachmentType || 'Excel').toLowerCase();
    if (!to) return res.status(400).json({ success: false, message: 'Email To is required' });
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      return res.status(400).json({ success: false, message: 'SMTP_USER and SMTP_PASS must be configured in .env' });
    }

    const reportFilters = requireDealerForReport(req.body.filters || {});
    const data = await buildPartwiseInventoryAuditReport(reportFilters);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Daksh Inventory v2';
    workbook.created = new Date();
    addPartwiseInventoryAuditSheet(workbook, data);
    const attachments = [];
    if (attachmentType === 'excel' || attachmentType === 'both') {
      attachments.push({ filename: 'Partwise_Inventory_Audit_Report.xlsx', content: Buffer.from(await workbook.xlsx.writeBuffer()) });
    }
    if (attachmentType === 'pdf' || attachmentType === 'both') {
      attachments.push({ filename: 'Partwise_Inventory_Audit_Report.pdf', content: buildPartwiseInventoryAuditPdfBuffer(data) });
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
      subject: req.body.subject || 'Daksh Inventory - PARTWISE INVENTORY AUDIT REPORT',
      text: req.body.message || 'Please find attached the PARTWISE INVENTORY AUDIT REPORT.',
      attachments
    });
    return res.json({ success: true, message: 'Report email sent' });
  } catch (error) {
    return res.status(reportErrorStatus(error)).json({ success: false, message: error.message });
  }
});

router.get('/professional/:kind', auth.requireAuth, async (req, res) => {
  try {
    const kind = professionalReport(req.params.kind);
    if (!kind) return res.status(404).json({ success: false, message: 'Report type not found' });
    const reportQuery = requireDealerForReport(req.query);

    const report = PROFESSIONAL_REPORTS[kind];
    if (reportQuery.format === 'excel') {
      if (hasRequestedReportColumns(reportQuery)) {
        const data = await buildReportData(reportQuery);
        const preview = previewForReport(kind, data);
        return sendSelectedColumnsWorkbook(res, `${report.fileName}.xlsx`, report.title, preview.columns, preview.rows, reportQuery);
      }
      const { workbook } = await createProfessionalWorkbook(kind, reportQuery);
      const buffer = await workbook.xlsx.writeBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${report.fileName}.xlsx"`);
      return res.send(Buffer.from(buffer));
    }

    const data = await buildReportData(reportQuery);
    if (reportQuery.format === 'pdf') {
      const pdf = buildProfessionalPdfBuffer(kind, data);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${report.fileName}.pdf"`);
      return res.send(pdf);
    }

    const preview = previewForReport(kind, data);
    return res.json({
      success: true,
      reportType: kind,
      title: report.title,
      summary: data.summary[0],
      columns: preview.columns.map(({ header, key }) => ({ header, key })),
      rows: preview.rows.slice(0, 500),
      totalRows: preview.rows.length
    });
  } catch (error) {
    return res.status(reportErrorStatus(error)).json({ success: false, message: error.message });
  }
});

router.post('/professional/:kind/email', auth.requireAuth, async (req, res) => {
  try {
    const kind = professionalReport(req.params.kind);
    if (!kind) return res.status(404).json({ success: false, message: 'Report type not found' });

    const to = String(req.body.email || '').trim();
    if (!to) return res.status(400).json({ success: false, message: 'Email ID is required' });
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      return res.status(400).json({ success: false, message: 'SMTP_USER and SMTP_PASS must be configured in .env' });
    }

    const report = PROFESSIONAL_REPORTS[kind];
    const reportFilters = requireDealerForReport(req.body.filters || {});
    const { workbook, data } = await createProfessionalWorkbook(kind, reportFilters);
    const excelBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const pdfBuffer = buildProfessionalPdfBuffer(kind, data);
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT || 587) === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    await transporter.sendMail({
      from: process.env.REPORT_EMAIL || process.env.SMTP_USER,
      to,
      subject: `Daksh Inventory - ${report.title}`,
      text: `Please find attached the ${report.title}.`,
      attachments: [
        { filename: `${report.fileName}.xlsx`, content: excelBuffer },
        { filename: `${report.fileName}.pdf`, content: pdfBuffer }
      ]
    });

    return res.json({ success: true, message: 'Report email sent' });
  } catch (error) {
    return res.status(reportErrorStatus(error)).json({ success: false, message: error.message });
  }
});

async function professionalAlias(req, res, kind) {
  try {
    const report = PROFESSIONAL_REPORTS[kind];
    const reportQuery = requireDealerForReport(req.query);
    console.log("REPORT API:", req.path, req.query);
    if (reportQuery.format === 'excel') {
      if (hasRequestedReportColumns(reportQuery)) {
        const data = await buildReportData(reportQuery);
        const preview = previewForReport(kind, data);
        return sendSelectedColumnsWorkbook(res, `${report.fileName}.xlsx`, report.title, preview.columns, preview.rows, reportQuery);
      }
      const { workbook } = await createProfessionalWorkbook(kind, reportQuery);
      const buffer = await workbook.xlsx.writeBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${report.fileName}.xlsx"`);
      return res.send(Buffer.from(buffer));
    }

    const data = await buildReportData(reportQuery);
    if (reportQuery.format === 'pdf') {
      const pdf = buildProfessionalPdfBuffer(kind, data);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${report.fileName}.pdf"`);
      return res.send(pdf);
    }

    const preview = previewForReport(kind, data);
    return res.json({
      success: true,
      reportType: kind,
      title: report.title,
      summary: data.summary[0],
      columns: preview.columns.map(({ header, key }) => ({ header, key })),
      rows: preview.rows.slice(0, 500),
      totalRows: preview.rows.length,
      message: preview.rows.length ? '' : 'No report data found for selected filter'
    });
  } catch (error) {
    return res.status(reportErrorStatus(error)).json({ success: false, message: error.message });
  }
}

async function professionalAliasEmail(req, res, kind) {
  try {
    const to = String(req.body.to || req.body.email || '').trim();
    const cc = String(req.body.cc || '').trim();
    const attachmentType = String(req.body.attachmentType || 'Excel').toLowerCase();
    if (!to) return res.status(400).json({ success: false, message: 'Email To is required' });
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      return res.status(400).json({ success: false, message: 'SMTP_USER and SMTP_PASS must be configured in .env' });
    }

    const report = PROFESSIONAL_REPORTS[kind];
    const filters = requireDealerForReport(req.body.filters || {});
    const { workbook, data } = await createProfessionalWorkbook(kind, filters);
    const attachments = [];
    if (attachmentType === 'excel' || attachmentType === 'both') {
      attachments.push({ filename: `${report.fileName}.xlsx`, content: Buffer.from(await workbook.xlsx.writeBuffer()) });
    }
    if (attachmentType === 'pdf' || attachmentType === 'both') {
      attachments.push({ filename: `${report.fileName}.pdf`, content: buildProfessionalPdfBuffer(kind, data) });
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
      subject: req.body.subject || `Daksh Inventory - ${report.title}`,
      text: req.body.message || `Please find attached the ${report.title}.`,
      attachments
    });

    return res.json({ success: true, message: 'Report email sent' });
  } catch (error) {
    return res.status(reportErrorStatus(error)).json({ success: false, message: error.message });
  }
}

router.get('/main-inventory-audit', auth.requireAuth, (req, res) => professionalAlias(req, res, 'main'));
router.get('/compile-audit', auth.requireAuth, (req, res) => professionalAlias(req, res, 'compile'));
router.get('/consolidated-final', auth.requireAuth, (req, res) => professionalAlias(req, res, 'consolidated'));
router.post('/main-inventory-audit/email', auth.requireAuth, auth.requireAdmin, (req, res) => professionalAliasEmail(req, res, 'main'));
router.post('/compile-audit/email', auth.requireAuth, auth.requireAdmin, (req, res) => professionalAliasEmail(req, res, 'compile'));
router.post('/consolidated-final/email', auth.requireAuth, auth.requireAdmin, (req, res) => professionalAliasEmail(req, res, 'consolidated'));

router.get('/data', auth.requireAuth, async (req, res) => {
  try {
    const reportQuery = requireDealerForReport(req.query);
    const data = await buildReportData(reportQuery);
    res.json({
      success: true,
      summary: data.summary[0],
      finalRows: data.finalRows.slice(0, 500),
      categoryRows: data.categoryRows,
      rawLogRows: data.rawLogRows.slice(0, 500)
    });
  } catch (error) {
    res.status(reportErrorStatus(error)).json({ success: false, message: error.message });
  }
});

router.get('/parts-inventory-refresh-template.csv', auth.requireAuth, async (req, res) => {
  try {
    const reportQuery = requireDealerForReport(req.query);
    const rows = await buildPartsInventoryRefreshRows(reportQuery);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="Parts_Inventory_Refresh_Template.csv"');
    res.send(partsInventoryRefreshCsv(rows));
  } catch (error) {
    res.status(reportErrorStatus(error)).json({ success: false, message: error.message });
  }
});

router.get('/parts-inventory-refresh-template', auth.requireAuth, async (req, res) => {
  try {
    const reportQuery = requireDealerForReport(req.query);
    const rows = await buildPartsInventoryRefreshRows(reportQuery);
    const maxBinCount = Math.max(1, ...rows.map((row) => (row.binLocations || []).length));
    const binColumns = Array.from({ length: maxBinCount }, (_, index) => ({
      header: `Bin Loc ${index + 1}`,
      key: `binLocation${index + 1}`
    }));
    const previewRows = rows.map((row) => {
      const record = {
        partNumber: row.partNumber || '',
        quantity: row.quantity || 0,
        qty: row.quantity || 0,
        physicalBinQty: row.physicalBinQty || 0,
        fittedQty: row.fittedQty || 0,
        fittedRegdNo: row.fittedRegdNo || '',
        fittedJobCardNo: row.fittedJobCardNo || ''
      };
      binColumns.forEach((column, index) => {
        record[column.key] = (row.binLocations || [])[index] || '';
      });
      return record;
    });
    res.json({
      success: true,
      type: 'parts-inventory-refresh-template',
      title: 'Part Inventory Refresh Template CSV',
      summary: { rows: previewRows.length },
      columns: [
        { header: 'Part Number', key: 'partNumber' },
        { header: 'Qty', key: 'qty' },
        { header: 'Physical Bin Qty', key: 'physicalBinQty' },
        { header: 'Fitted Qty', key: 'fittedQty' },
        { header: 'Fitted Regd No', key: 'fittedRegdNo' },
        { header: 'Fitted Job Card No', key: 'fittedJobCardNo' },
        ...binColumns
      ],
      rows: previewRows,
      totalRows: previewRows.length,
      message: previewRows.length ? '' : 'No scan data found for selected filter'
    });
  } catch (error) {
    res.status(reportErrorStatus(error)).json({ success: false, message: error.message });
  }
});

router.get('/full', auth.requireAuth, async (req, res) => {
  try {
    const reportQuery = requireDealerForReport(req.query);
    const { workbook } = await createWorkbook(reportQuery);
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Daksh_Inventory_Full_Report.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (error) {
    res.status(reportErrorStatus(error)).json({ success: false, message: error.message });
  }
});

router.get('/full.csv', auth.requireAuth, async (req, res) => {
  try {
    const reportQuery = requireDealerForReport(req.query);
    const data = await buildReportData(reportQuery);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="Daksh_Inventory_Full_Report.csv"');
    res.send(finalReportCsv(data.finalRows || []));
  } catch (error) {
    res.status(reportErrorStatus(error)).json({ success: false, message: error.message });
  }
});

router.get('/pdf', auth.requireAuth, async (req, res) => {
  try {
    const reportQuery = requireDealerForReport(req.query);
    const data = await buildReportData(reportQuery);
    const doc = new jsPDF({ orientation: 'landscape' });
    doc.setFontSize(15);
    doc.text('Daksh Inventory v2 - Inventory Audit Report', 14, 15);
    doc.setFontSize(9);
    doc.text(`Generated: ${formatIstDateTime(new Date())}`, 14, 22);
    const body = data.finalRows.slice(0, 80).map((row) => [
      row.partNumber || row.partNo,
      row.partDescription || row.partName,
      row.category,
      row.scanUPIMRP || '',
      row.currentCatalogueMRP || 0,
      row.averageScannedMRP || 0,
      row.systemQty,
      row.physicalQty,
      row.differenceQty,
      row.finalInventoryValue || row.physicalMrpValue || 0,
      row.priceAgeingDays || 0,
      row.partMovement || '',
      row.status
    ]);
    autoTable(doc, {
      head: [['Part Number', 'Part Description', 'Category', 'SCAN UPI MRP', 'CURRENT CATALOGUE MRP', 'AVERAGE SCANNED MRP', 'System Qty', 'Physical Qty', 'Diff Qty', 'FINAL INVENTORY VALUE', 'PRICE AGEING DAYS', 'PART MOVEMENT', 'Status']],
      body,
      startY: 28,
      styles: { fontSize: 7, cellPadding: 2 },
      headStyles: { fillColor: [21, 58, 91] }
    });
    const pdf = Buffer.from(doc.output('arraybuffer'));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="Daksh_Inventory_Report.pdf"');
    res.send(pdf);
  } catch (error) {
    res.status(reportErrorStatus(error)).json({ success: false, message: error.message });
  }
});

router.post('/email', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const to = String(req.body.email || '').trim();
    if (!to) {
      return res.status(400).json({ success: false, message: 'Dealer email is required' });
    }
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      return res.status(400).json({ success: false, message: 'SMTP_USER and SMTP_PASS must be configured in .env' });
    }

    const reportFilters = requireDealerForReport(req.body.filters || {});
    const { workbook } = await createWorkbook(reportFilters);
    const buffer = await workbook.xlsx.writeBuffer();
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT || 587) === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    await transporter.sendMail({
      from: process.env.REPORT_EMAIL || process.env.SMTP_USER,
      to,
      subject: 'Daksh Inventory v2 Audit Report',
      text: 'Please find the Daksh Inventory v2 full audit report attached.',
      attachments: [
        {
          filename: 'Daksh_Inventory_Full_Report.xlsx',
          content: Buffer.from(buffer)
        }
      ]
    });

    res.json({ success: true, message: 'Report email sent' });
  } catch (error) {
    res.status(reportErrorStatus(error)).json({ success: false, message: error.message });
  }
});

module.exports = router;
module.exports.buildReportData = buildReportData;
module.exports.createWorkbook = createWorkbook;
module.exports.buildCategoryWiseVarianceSummary = buildCategoryWiseVarianceSummary;
module.exports.buildStockSummaryReport = buildStockSummaryReport;
module.exports.buildPartwiseInventoryAuditReport = buildPartwiseInventoryAuditReport;
module.exports.buildPartsInventoryRefreshRows = buildPartsInventoryRefreshRows;
module.exports.addStockSummarySheet = addStockSummarySheet;
