const { stockAvailableQuantity } = require('../utils/stockQuantity');
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const { randomUUID } = require('crypto');
const { jsPDF } = require('jspdf');
const autoTableModule = require('jspdf-autotable');
const DealerStock = require('../models/DealerStock');
const Inventory = require('../models/Inventory');
const Dealer = require('../models/Dealer');
const ScanAuditLog = require('../models/ScanAuditLog');
const auth = require('./auth');
const { getActiveAudit } = require('../utils/audit');
const { validScanClause } = require('../utils/masterValidation');
const { normalizePartNumber } = require('../utils/normalize');
const { uniqueReportScans } = require('../utils/reportScanIdentity');
const { applyMovementCountRules, signedScanQuantity } = require('../utils/reportTotals');
const { resolvePartPricing } = require('../utils/partPricing');
const { summarizeAuditValuation, priceValue, decimalSum } = require('../utils/auditValuation');
const { aggregateDealerStockRows } = require('../utils/dmsStockAggregation');
const { getPricesFromPartMaster, savedAuditPrice } = require('../utils/partMasterPrice');
const { resolveCategoryFromMaster } = require('../utils/categoryResolver');
const { applyCacheHeaders, getCachedResponse, invalidateCache } = require('../utils/safeCache');
const { withDatabaseTransaction } = require('../services/prisma');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const autoTable = autoTableModule.default || autoTableModule;

const EXCLUDED_SYNC_STATUSES = ['duplicate', 'rejected', 'failed', 'deleted'];
const POSITIVE_SCAN_TYPES = ['INWARD', 'AUDIT'];
const NEGATIVE_SCAN_TYPES = ['OUTWARD', 'FITTED', 'DAMAGE'];
const UPLOAD_ERROR_LIMIT = 10000;
const PREVIEW_LIMIT = 500;
// DealerStock rows contain 34 bound columns. Keep each INSERT below PostgreSQL's
// 32,767 bind-parameter limit while leaving room for schema additions.
const DEALER_STOCK_UPLOAD_BATCH_SIZE = 500;
const ACCEPTED_SCAN_STATUSES = ['ACCEPTED', 'SUPERVISOR_APPROVED', 'OUTWARD_DONE'];
const MASTER_NOT_FOUND_LABEL = 'UNKNOWN PART / MASTER NOT FOUND';

function clean(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function normalizePart(value) {
  return normalizePartNumber(value);
}

function invalidDealerStockPartReason(value) {
  return clean(value).includes('?') ? 'Part number contains an unresolved ? character. Enter the exact Part Master part number.' : '';
}

function numberValue(value, fallback = 0) {
  const parsed = parseNumber(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const text = clean(value)
    .replace(/\bRS\.?\b/gi, '')
    .replace(/\bINR\b/gi, '')
    .replace(/[₹$,\s]/g, '')
    .replace(/^\((.*)\)$/, '-$1');
  if (!text || text === '-' || /^na$/i.test(text)) return NaN;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function money(value) {
  const number = Number(value || 0);
  return Math.round((Number.isFinite(number) ? number : 0) * 100) / 100;
}

function compactParams(query = {}) {
  return Object.fromEntries(Object.entries(query).filter(([, value]) => clean(value)));
}

function escapeRegex(value) {
  return clean(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dealerCodeFromCell(value) {
  const text = clean(value);
  if (!text) return '';
  const paren = text.match(/\(([^()]+)\)\s*$/);
  if (paren) return upper(paren[1]);
  const leading = text.match(/^\s*([A-Za-z0-9_-]{3,})\s*(?:[-|:/,]|\s{2,})/);
  return upper(leading ? leading[1] : text);
}

function stockQtyExpression() {
  const qtyValue = {
    $convert: {
      input: { $ifNull: ['$qty', { $ifNull: ['$quantity', 0] }] },
      to: 'double',
      onError: 0,
      onNull: 0
    }
  };
  const typeValue = { $toUpper: { $toString: { $ifNull: ['$scanType', { $ifNull: ['$type', 'INWARD'] }] } } };
  return {
    $switch: {
      branches: [
        { case: { $in: [typeValue, POSITIVE_SCAN_TYPES] }, then: { $abs: qtyValue } },
        { case: { $in: [typeValue, NEGATIVE_SCAN_TYPES] }, then: { $multiply: [{ $abs: qtyValue }, -1] } },
        { case: { $eq: [typeValue, 'VERIFICATION'] }, then: 0 }
      ],
      default: { $abs: qtyValue }
    }
  };
}

function acceptedScanStatusClause() {
  return {
    $or: [
      { scanStatus: { $in: ACCEPTED_SCAN_STATUSES } },
      { scanStatus: { $exists: false } },
      { scanStatus: '' },
      { scanStatus: null }
    ]
  };
}

function nonVerificationScanClause() {
  return { $nor: [{ scanType: 'VERIFICATION' }, { type: 'VERIFICATION' }] };
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

function acceptedPhysicalScanClause() {
  return {
    syncStatus: 'synced',
    isDuplicate: { $ne: true },
    isDeleted: { $ne: true },
    deletedAt: null,
    $and: [
      nonVerificationScanClause(),
      acceptedScanStatusClause(),
      validScanClause(),
      { $nor: testScanClause().$or }
    ]
  };
}

const HEADER_ALIASES = {
  dealerCode: ['DEALER CODE', 'DEALERCODE', 'DEALER', 'DEALER NAME', 'LOCATION CODE', 'BRANCH CODE'],
  partNumber: ['PART NUMBER', 'PART NO', 'PARTNO', 'PART', 'PART #', 'PART#', 'PART CODE', 'ITEM CODE', 'MATERIAL CODE', 'SKU'],
  partDescription: ['PART DESCRIPTION', 'DESCRIPTION', 'PART NAME', 'ITEM DESCRIPTION', 'MATERIAL DESCRIPTION', 'PRODUCT DESCRIPTION', 'PRODUCT DESC'],
  hsn: ['HSN', 'HSN CODE', 'HSN/SAC', 'HSN SAC'],
  productCategory: ['PRODUCT CATEGORY', 'CATEGORY', 'PRODUCT CAT', 'ITEM CATEGORY'],
  productType: ['PRODUCT TYPE', 'PART TYPE', 'ITEM TYPE'],
  model: ['MODEL'],
  year: ['YEAR', 'MANUFACTURING YEAR', 'MFG YEAR'],
  productGroup: ['PRODUCT GROUP', 'GROUP', 'PG'],
  partSubGroup: ['PRODUCT SUBGROUP', 'PART SUBGROUP', 'SUB GROUP', 'SUBGROUP', 'SPG'],
  mrp: ['MRP', 'PRICE', 'MAX RETAIL PRICE'],
  dlp: ['DLP', 'DLC', 'DLC DLP', 'DLP DLC', 'DEALER LANDING COST', 'LANDING COST', 'DEALER LIST PRICE'],
  moq: ['MOQ', 'MIN ORDER QTY', 'MINIMUM ORDER QTY'],
  dmsStock: ['SYSTEM QUANTITY', 'SYSTEM QTY', 'SYSTEM STOCK', 'DMS STOCK', 'DMS QTY', 'STOCK', 'QUANTITY', 'QTY', 'STOCK ON HAND', 'STOCK IN HAND', 'STOCK INHAND', 'SOH', 'SIH'],
  actualStock: ['ACTUAL STOCK', 'ACTUAL QTY', 'PHYSICAL STOCK'],
  inventoryLocation: ['INVENTORY LOCATION', 'LOCATION', 'STOCK LOCATION', 'WAREHOUSE', 'WORKSHOP'],
  binLoc1: ['SYSTEM BIN LOC 1', 'SYSTEM BIN LOCATION 1', 'BIN LOC 1', 'BIN LOCATION 1', 'BIN 1', 'BIN LOC1'],
  binLoc2: ['SYSTEM BIN LOC 2', 'SYSTEM BIN LOCATION 2', 'BIN LOC 2', 'BIN LOCATION 2', 'BIN 2', 'BIN LOC2'],
  binLoc3: ['SYSTEM BIN LOC 3', 'SYSTEM BIN LOCATION 3', 'BIN LOC 3', 'BIN LOCATION 3', 'BIN 3', 'BIN LOC3'],
  reservedQty: ['RESERVED QTY', 'RESERVED QUANTITY', 'RESERVED'],
  movementCodeA: ['MOVEMENT CODE A', 'MOVEMENT A', 'ABC', 'ABC CODE', 'ABC CLASS'],
  movementCodeB: ['MOVEMENT CODE B', 'MOVEMENT B', 'FMS', 'FMS CODE', 'FMS CLASS'],
  averageDemand: ['AVERAGE DEMAND', 'AVG DEMAND', 'AVERAGE DEMAND QTY', 'AVG DEMAND QTY'],
  forecast: ['FORECAST', 'FORECAST QTY', 'DEMAND FORECAST'],
  safetyStock: ['SAFETY STOCK', 'SAFETY STOCK QTY', 'SAFETY QTY'],
  rop: ['ROP', 'REORDER POINT', 'RE ORDER POINT'],
  pendingOrder: ['PENDING ORDER', 'PENDING ORDERS', 'BACKORDER', 'BACK ORDER', 'BACKORDER QTY', 'BACK ORDER QTY', 'B2B PENDING', 'B2B BACK ORDER', 'B2B BACKORDER', 'B2B GIT', 'ANC AFM BACKORDER', 'ANC/AFM BACKORDER']
};

const NUMERIC_KEYS = new Set(['mrp', 'dlp', 'moq', 'dmsStock', 'actualStock', 'reservedQty', 'averageDemand', 'forecast', 'safetyStock', 'rop', 'pendingOrder']);
const SUM_NUMERIC_KEYS = new Set(['reservedQty', 'pendingOrder']);
const JOIN_TEXT_KEYS = new Set(['movementCodeA', 'movementCodeB']);

function normalizeHeader(value) {
  return upper(value).replace(/[^A-Z0-9]+/g, ' ').trim();
}

const HEADER_LOOKUP = Object.entries(HEADER_ALIASES).reduce((map, [key, aliases]) => {
  aliases.forEach((alias) => map.set(normalizeHeader(alias), key));
  return map;
}, new Map());

const DEALER_STOCK_TEMPLATE_PATH = path.join(
  __dirname,
  '..',
  'assets',
  'templates',
  'Daksh_Dealer_Stock_Upload_Template.xlsx'
);

async function sendDealerStockTemplate(req, res) {
  try {
    const buffer = await fs.promises.readFile(DEALER_STOCK_TEMPLATE_PATH);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Daksh_Dealer_Stock_Upload_Template.xlsx"');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buffer);
  } catch (error) {
    return res.status(500).json({ success: false, message: `Could not load dealer stock template: ${error.message}` });
  }
}

function canonicalHeader(header) {
  return HEADER_LOOKUP.get(normalizeHeader(header)) || '';
}

function csvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(cell);
      if (row.some((value) => clean(value))) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => clean(value))) rows.push(row);
  return rows;
}

async function readUploadedRows(file) {
  const name = clean(file.originalname).toLowerCase();
  if (name.endsWith('.csv')) return csvRows(file.buffer.toString('utf8'));
  try {
    const workbook = XLSX.read(file.buffer, { type: 'buffer', cellDates: false, raw: false });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return [];
    return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', blankrows: false, raw: false });
  } catch (xlsxError) {
    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(file.buffer);
      const sheet = workbook.worksheets[0];
      if (!sheet) return [];
      const rows = [];
      sheet.eachRow({ includeEmpty: false }, (row) => {
        rows.push(row.values.slice(1).map((value) => {
          if (value && typeof value === 'object' && value.text) return value.text;
          if (value && typeof value === 'object' && value.result !== undefined) return value.result;
          return value;
        }));
      });
      return rows;
    } catch (excelError) {
      throw new Error(`Could not read Excel file. ${xlsxError.message || excelError.message}`);
    }
  }
}

function findHeaderRow(rows = []) {
  let best = { index: -1, headers: [], keys: [] };
  rows.slice(0, 25).forEach((row, index) => {
    const headers = row.map(clean);
    const keys = headers.map(canonicalHeader);
    const score = new Set(keys.filter(Boolean)).size;
    if (score > new Set(best.keys.filter(Boolean)).size) best = { index, headers, keys };
  });
  return best.index >= 0 ? best : { index: 0, headers: rows[0] || [], keys: (rows[0] || []).map(canonicalHeader) };
}

function valueForKey(values = [], indexes = [], key = '') {
  const rawValues = indexes.map((index) => clean(values[index])).filter((value) => value !== '');
  if (NUMERIC_KEYS.has(key)) {
    if (SUM_NUMERIC_KEYS.has(key)) {
      const numbers = rawValues.map(parseNumber).filter(Number.isFinite);
      return numbers.reduce((sum, value) => sum + value, 0);
    }
    const first = rawValues.find((value) => Number.isFinite(parseNumber(value)));
    return first === undefined ? NaN : parseNumber(first);
  }
  if (JOIN_TEXT_KEYS.has(key)) {
    return Array.from(new Set(rawValues.map(upper).filter(Boolean))).join(' / ');
  }
  return rawValues[0] || '';
}

function mergeRecord(target, item) {
  const textFields = [
    'partDescription',
    'hsn',
    'productCategory',
    'category',
    'productType',
    'model',
    'year',
    'manufacturingYear',
    'productGroup',
    'partSubGroup',
    'binLoc1',
    'binLoc2',
    'binLoc3',
    'systemBinLoc1',
    'systemBinLoc2',
    'systemBinLoc3',
    'inventoryLocation',
    'movementCodeA',
    'movementCodeB'
  ];
  textFields.forEach((field) => {
    if (!target[field] && item[field]) target[field] = item[field];
  });
  ['mrp', 'dlp', 'dlc', 'moq', 'actualStock', 'averageDemand', 'forecast', 'safetyStock', 'rop'].forEach((field) => {
    if (Number(item[field] || 0) > 0) target[field] = Number(item[field] || 0);
  });
  target.dmsStock += Number(item.dmsStock || 0);
  target.systemQty = target.dmsStock;
  target.reservedQty += Number(item.reservedQty || 0);
  target.pendingOrder += Number(item.pendingOrder || 0);
  target.stockValue = money(target.dmsStock * Number(target.dlp || target.dlc || 0));
  return target;
}

async function rowsToStockRecords(rows, selectedDealerCode, auditId, userName, onProgress = () => {}, selectedRows = null) {
  if (!rows.length) return { records: [], errorRows: [{ rowNumber: 0, message: 'File is empty' }], columns: [], duplicateRowsMerged: 0, skippedCount: 1 };

  const headerInfo = findHeaderRow(rows);
  const headers = headerInfo.headers.map(clean);
  const keys = headerInfo.keys;
  const columnsByKey = {};
  keys.forEach((key, index) => {
    if (!key) return;
    columnsByKey[key] = columnsByKey[key] || [];
    columnsByKey[key].push(index);
  });

  const missing = [];
  if (!columnsByKey.partNumber) missing.push('Part Number');
  if (!columnsByKey.dmsStock) missing.push('System Quantity / DMS Stock / Stock In Hand');
  if (!columnsByKey.dealerCode) missing.push('Dealer Code');
  if (!auditId) missing.push('Active Audit ID');
  if (missing.length) {
    return {
      records: [],
      errorRows: [{ rowNumber: headerInfo.index + 1, message: `Missing required column(s): ${missing.join(', ')}` }],
      columns: headers,
      duplicateRowsMerged: 0,
      skippedCount: 1
    };
  }

  const now = new Date();
  const byPart = new Map();
  const seenSourceRows = new Set();
  const errorRows = [];
  const reviewRows = [];
  let duplicateRowsMerged = 0;
  let skippedCount = 0;

  const sourceRows = rows.slice(headerInfo.index + 1);
  for (let offset = 0; offset < sourceRows.length; offset += 1) {
    const values = sourceRows[offset];
    if (!values || !values.some((value) => clean(value))) {
      if ((offset + 1) % 1000 === 0) {
        onProgress(offset + 1, sourceRows.length);
        await new Promise((resolve) => setImmediate(resolve));
      }
      continue;
    }
    const rowNumber = headerInfo.index + offset + 2;
    const item = {};
    Object.entries(columnsByKey).forEach(([key, indexes]) => {
      item[key] = valueForKey(values, indexes, key);
    });

    const fileDealerCode = dealerCodeFromCell(item.dealerCode);
    const dealerCode = selectedDealerCode || fileDealerCode;
    const partNumber = normalizePart(item.partNumber);
    const errors = [];
    if (!dealerCode) errors.push('Dealer code missing');
    if (!fileDealerCode) errors.push('Dealer code missing');
    if (selectedDealerCode && fileDealerCode && selectedDealerCode !== fileDealerCode) errors.push(`Dealer code ${fileDealerCode} does not match selected dealer ${selectedDealerCode}`);
    if (!partNumber) errors.push('Part number blank');
    const partError = invalidDealerStockPartReason(item.partNumber);
    if (partError) errors.push(partError);
    if (!Number.isSafeInteger(item.dmsStock) || item.dmsStock < 0) errors.push('DMS stock must be a non-negative whole number');
    if (columnsByKey.mrp && !Number.isFinite(item.mrp)) errors.push('MRP must be numeric when provided');
    if (columnsByKey.dlp && !Number.isFinite(item.dlp)) errors.push('DLC / DLP must be numeric when provided');
    if (errors.length) {
      skippedCount += 1;
      reviewRows.push({ rowNumber, dealerCode: fileDealerCode, partNumber: clean(item.partNumber), partDescription: clean(item.partDescription), dmsStock: item.dmsStock, binLoc1: upper(item.binLoc1), binLoc2: upper(item.binLoc2), binLoc3: upper(item.binLoc3), status: 'REJECTED', reason: errors.join('; ') });
      if (errorRows.length < UPLOAD_ERROR_LIMIT) {
        errorRows.push({ rowNumber, partNumber: clean(item.partNumber), dealerCode: fileDealerCode || dealerCode, message: errors.join('; ') });
      }
      continue;
    }

    if (selectedRows && !selectedRows.has(rowNumber)) {
      reviewRows.push({ rowNumber, dealerCode, partNumber, partDescription: clean(item.partDescription), dmsStock: item.dmsStock, binLoc1: upper(item.binLoc1), binLoc2: upper(item.binLoc2), binLoc3: upper(item.binLoc3), status: 'EXCLUDED', reason: 'Excluded from this upload' });
      continue;
    }
    const sourceSignature = [
      partNumber,
      upper(item.inventoryLocation),
      Number(item.dmsStock || 0),
      upper(item.partDescription)
    ].join('|');
    if (seenSourceRows.has(sourceSignature)) {
      duplicateRowsMerged += 1;
      reviewRows.push({ rowNumber, dealerCode, partNumber, partDescription: clean(item.partDescription), dmsStock: item.dmsStock, binLoc1: upper(item.binLoc1), binLoc2: upper(item.binLoc2), binLoc3: upper(item.binLoc3), status: 'DUPLICATE', reason: 'Repeated source row excluded' });
      continue;
    }
    seenSourceRows.add(sourceSignature);

    const record = {
      auditId,
      dealerCode,
      partNumber,
      normalizedPartNumber: partNumber,
      partDescription: clean(item.partDescription),
      hsn: clean(item.hsn),
      productCategory: clean(item.productCategory),
      category: clean(item.productCategory),
      productType: clean(item.productType),
      model: clean(item.model),
      year: clean(item.year),
      manufacturingYear: clean(item.year),
      productGroup: upper(item.productGroup),
      partSubGroup: upper(item.partSubGroup),
      mrp: Number(item.mrp || 0),
      dlp: Number(item.dlp || 0),
      dlc: Number(item.dlp || 0),
      moq: Number(item.moq || 0),
      dmsStock: Number(item.dmsStock || 0),
      systemQty: Number(item.dmsStock || 0),
      actualStock: Number(item.actualStock || 0),
      inventoryLocation: clean(item.inventoryLocation),
      source: 'DEALER_STOCK_UPLOAD',
      binLoc1: upper(item.binLoc1),
      binLoc2: upper(item.binLoc2),
      binLoc3: upper(item.binLoc3),
      systemBinLoc1: upper(item.binLoc1),
      systemBinLoc2: upper(item.binLoc2),
      systemBinLoc3: upper(item.binLoc3),
      reservedQty: Number(item.reservedQty || 0),
      movementCodeA: upper(item.movementCodeA),
      movementCodeB: upper(item.movementCodeB),
      averageDemand: Number(item.averageDemand || 0),
      forecast: Number(item.forecast || 0),
      safetyStock: Number(item.safetyStock || 0),
      rop: Number(item.rop || 0),
      pendingOrder: Number(item.pendingOrder || 0),
      stockValue: money(Number(item.dmsStock || 0) * Number(item.dlp || 0)),
      uploadedBy: userName,
      uploadedAt: now
    };

    reviewRows.push({ rowNumber, dealerCode, partNumber, partDescription: record.partDescription, dmsStock: record.dmsStock, binLoc1: record.binLoc1, binLoc2: record.binLoc2, binLoc3: record.binLoc3, status: 'VALID', reason: '' });

    const existing = byPart.get(partNumber);
    if (existing) {
      duplicateRowsMerged += 1;
      mergeRecord(existing, record);
    } else {
      byPart.set(partNumber, record);
    }
    if ((offset + 1) % 1000 === 0) {
      onProgress(offset + 1, sourceRows.length);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  onProgress(sourceRows.length, sourceRows.length);

  const prices = new Map();
  const parts = Array.from(byPart.keys());
  for (let index = 0; index < parts.length; index += 500) {
    const batch = await getPricesFromPartMaster(parts.slice(index, index + 500), selectedDealerCode, { exact: true });
    for (const [part, price] of batch) prices.set(part, price);
  }
  for (const row of reviewRows) {
    if (row.status !== 'VALID') continue;
    const price = prices.get(row.partNumber);
    if (!price || !price.masterFound) { row.status = 'WRONG_PART'; row.reason = 'Part not found in Part Master'; }
    else if (!(Number(price.dlc) > 0) || !(Number(price.mrp) > 0)) { row.status = 'MISSING_PRICE'; row.reason = `${Number(price.dlc) > 0 ? '' : 'DLC'}${Number(price.dlc) > 0 || Number(price.mrp) > 0 ? '' : ' and '}${Number(price.mrp) > 0 ? '' : 'MRP'} missing in Part Master`; }
    if (row.status === 'VALID') {
      row.partDescription = clean(price.description || price.partDescription || price.partName);
      row.dlc = Number(price.dlc);
      row.mrp = Number(price.mrp);
    }
  }
  const validParts = new Set(reviewRows.filter(row => row.status === 'VALID').map(row => row.partNumber));
  const records = Array.from(byPart.values()).filter(record => validParts.has(record.partNumber)).map(record => {
    const price = prices.get(record.partNumber);
    const dlc = Number(price.dlc);
    const mrp = Number(price.mrp);
    return { ...record, partDescription: clean(price.description || price.partDescription || price.partName), dlc, dlp: dlc, mrp, stockValue: money(record.dmsStock * dlc) };
  });
  for (const row of reviewRows) {
    if (!['WRONG_PART', 'MISSING_PRICE'].includes(row.status)) continue;
    skippedCount += 1;
    if (errorRows.length < UPLOAD_ERROR_LIMIT) errorRows.push({ rowNumber: row.rowNumber, dealerCode: row.dealerCode, partNumber: row.partNumber, message: row.reason });
  }

  return {
    records,
    reviewRows,
    errorRows,
    columns: headers,
    duplicateRowsMerged,
    skippedCount,
    errorRowsTruncated: skippedCount > errorRows.length
  };
}

function publicStock(row, pricing = null) {
  pricing = savedAuditPrice(row, pricing) || pricing;
  const hasMasterRecord = Boolean(pricing && (pricing.partNumber || pricing.normalizedPartNumber || pricing.description || pricing.partDescription || pricing.partName || pricing.productGroup || pricing.productCategory || pricing.category));
  const hasValidMrp = Boolean(Number(pricing && pricing.mrp || 0) > 0);
  const hasValidDlc = Boolean(Number(pricing && (pricing.dlc ?? pricing.dlp) || 0) > 0);
  const hasValidPrice = hasValidMrp && hasValidDlc;
  const mrp = hasValidMrp ? Number(pricing.mrp || 0) : 0;
  const dlp = hasValidDlc ? Number(pricing.dlc ?? pricing.dlp ?? 0) : 0;
  const category = hasMasterRecord ? resolveCategoryFromMaster(pricing) : 'Uncategorized';
  const partDescription = hasMasterRecord
    ? clean(pricing.description || pricing.partDescription || pricing.partName || '')
    : MASTER_NOT_FOUND_LABEL;
  const dmsStock = Number(row.dmsStock || row.systemQty || 0);
  return {
    id: String(row._id || ''),
    auditId: row.auditId || '',
    dealerCode: row.dealerCode || '',
    partNumber: row.partNumber || '',
    partDescription,
    productCategory: category,
    category,
    mrp,
    dlp,
    dlc: dlp,
    dmsStock,
    systemQty: dmsStock,
    model: hasMasterRecord ? clean(pricing.model || '') : '',
    year: hasMasterRecord ? clean(pricing.manufacturingYear || pricing.year || '') : '',
    manufacturingYear: hasMasterRecord ? clean(pricing.manufacturingYear || pricing.year || '') : '',
    productGroup: hasMasterRecord ? clean(pricing.productGroup || '') : '',
    partSubGroup: hasMasterRecord ? clean(pricing.partSubGroup || pricing.productSubGroup || '') : '',
    binLoc1: row.binLoc1 || row.systemBinLoc1 || '',
    binLoc2: row.binLoc2 || row.systemBinLoc2 || '',
    binLoc3: row.binLoc3 || row.systemBinLoc3 || '',
    systemBinLoc1: row.systemBinLoc1 || row.binLoc1 || '',
    systemBinLoc2: row.systemBinLoc2 || row.binLoc2 || '',
    systemBinLoc3: row.systemBinLoc3 || row.binLoc3 || '',
    reservedQty: Number(row.reservedQty || 0),
    movementCodeA: row.movementCodeA || '',
    movementCodeB: row.movementCodeB || '',
    averageDemand: Number(row.averageDemand || 0),
    forecast: Number(row.forecast || 0),
    safetyStock: Number(row.safetyStock || 0),
    rop: Number(row.rop || 0),
    pendingOrder: Number(row.pendingOrder || 0),
    stockValue: hasValidDlc ? priceValue(dmsStock, dlp) : null,
    uploadBatchId: row.uploadBatchId || '',
    uploadedAt: row.uploadedAt || row.updatedAt || row.createdAt,
    pricingStatus: hasMasterRecord ? (hasValidPrice ? (pricing.pricingStatus || '') : 'PART_MASTER_PRICE_MISSING') : 'PART_MASTER_PRICE_MISSING',
    pricingSource: hasMasterRecord ? (pricing.pricingSource || '') : 'PART_MASTER_PRICE_MISSING',
    pricingWarnings: hasMasterRecord ? (pricing.pricingWarnings || []) : [],
    warnings: hasMasterRecord ? (pricing.warnings || []) : [MASTER_NOT_FOUND_LABEL]
  };
}

function pricedDealerStockRows(rows = [], priceByPart = new Map()) {
  return rows.map((row) => {
    const partNumber = normalizePart(row.normalizedPartNumber || row.partNumber || row.partNo || row.part);
    const masterPrice = invalidDealerStockPartReason(partNumber) ? null : (priceByPart.get(partNumber) || null);
    const priced = publicStock(row, resolvePartPricing({
      partNumber,
      partMasterPrice: masterPrice ? savedAuditPrice(row, masterPrice) : null,
      actualQty: 0,
      dmsQty: Number(row.dmsStock || row.systemQty || 0)
    }));
    if (!masterPrice || !(Number(masterPrice.dlc) > 0) || !(Number(masterPrice.mrp) > 0)) {
      return { ...priced, dlc: null, dlp: null, mrp: null, stockValue: null,
        pricingStatus: 'PART_MASTER_PRICE_MISSING', pricingSource: 'PART_MASTER_PRICE_MISSING' };
    }
    return priced;
  });
}

function dealerStockRange(total) {
  const count = Math.max(0, Math.trunc(Number(total || 0)));
  return {
    from: count > 0 ? 1 : 0,
    to: count,
    total: count,
    text: count > 0 ? `1-${count}` : '0'
  };
}

function dealerStockPreviewRange(total, visible) {
  const count = Math.max(0, Math.trunc(Number(total || 0)));
  const shown = Math.min(count, Math.max(0, Math.trunc(Number(visible || 0))));
  return {
    from: count > 0 && shown > 0 ? 1 : 0,
    to: shown,
    total: count,
    text: count > 0 && shown > 0 ? `1-${shown} of ${count}` : `0 of ${count}`
  };
}

function dealerStockSummaryFromPublicRows(rows = [], total = rows.length, visible = rows.length) {
  const lineRange = dealerStockRange(total);
  const valuationSummary = summarizeAuditValuation(rows.map(row => ({ ...row, actualQuantity: 0, uploadedStockPresent: true })));
  const systemStockValue = valuationSummary.totalDmsDlcValue;
  return {
    rows: lineRange.total,
    partLineCount: lineRange.total,
    totalPartsUploaded: lineRange.total,
    lineRange,
    previewRange: dealerStockPreviewRange(total, visible),
    dmsStock: rows.reduce((sum, row) => sum + Number(row.dmsStock || row.systemQty || 0), 0),
    systemStockValue,
    stockValue: systemStockValue,
    valuationSummary,
    valuationComplete: valuationSummary.valuationComplete,
    priceExceptions: valuationSummary.priceExceptions
  };
}

async function resolveScope(req, source = {}) {
  const dealerCode = upper(
    source.dealerCode ||
    req.params.dealerCode ||
    req.query.dealerCode ||
    req.query.activeDealerId ||
    (req.body && (req.body.dealerCode || req.body.activeDealerId)) ||
    ''
  );
  let auditId = clean(
    source.auditId ||
    req.params.auditId ||
    req.query.auditId ||
    req.query.audit ||
    (req.body && (req.body.auditId || req.body.audit)) ||
    ''
  );
  if (auditId.toLowerCase() === 'active') auditId = '';
  // Completed audits remain in Dealer.currentAuditId as history only; never
  // use that historical value to authorize operational reconciliation.
  if (dealerCode && dealerCode !== 'ALL') {
    const activeAudit = await getActiveAudit({ dealerCode }).catch(() => null);
    const activeAuditId = clean(activeAudit && activeAudit.auditId);
    auditId = activeAuditId && (!auditId || auditId === activeAuditId) ? activeAuditId : '';
  }
  return { dealerCode, auditId };
}

function requireScope(scope, res) {
  if (!scope.dealerCode || scope.dealerCode === 'ALL') {
    res.status(400).json({ success: false, message: 'Dealer Code is required' });
    return false;
  }
  if (!scope.auditId) {
    res.status(400).json({ success: false, message: 'Active Audit ID is required for dealer stock reconciliation' });
    return false;
  }
  return true;
}

async function emitReconciliationChanged(req, reason, payload = {}) {
  invalidateCache({
    tags: ['reconciliation', 'stock', 'report', 'dashboard'],
    scope: { dealerCode: payload.dealerCode || '', auditId: payload.auditId || '' }
  });
  const io = req.io || req.app.get('io');
  if (!io) return;
  io.emit('dealer-stock:update', { reason, ...payload, at: new Date() });
  io.emit('reports:update', { reason, ...payload, at: new Date() });
}

async function saveDealerStockRecords(records = [], onProgress = () => {}, upload = {}) {
  return withDatabaseTransaction(async () => {
    const now = new Date();
    let insertedCount = 0;
    let updatedCount = 0;
    for (let index = 0; index < records.length; index += DEALER_STOCK_UPLOAD_BATCH_SIZE) {
      const chunk = records.slice(index, index + DEALER_STOCK_UPLOAD_BATCH_SIZE).map((record) => ({ ...record, updatedAt: now }));
      const previous = await DealerStock.find({ dealerCode: chunk[0].dealerCode, auditId: chunk[0].auditId,
        normalizedPartNumber: { $in: chunk.map(record => record.normalizedPartNumber) } }).lean();
      const result = await DealerStock.bulkUpsertBy(chunk,
        ['dealerCode', 'auditId', 'normalizedPartNumber'],
        { lockKey: `dealer-stock:${chunk[0].dealerCode}:${chunk[0].auditId}` });
      await ScanAuditLog.create({ action: 'UPDATE', scanId: upload.batchId, dealerCode: chunk[0].dealerCode,
        performedByUserId: upload.userId, performedByUsername: upload.username, performedByName: upload.userName,
        performedByRole: upload.role, reason: `Dealer DMS stock update for audit ${chunk[0].auditId}; source file ${upload.fileName}`,
        oldData: { rows: previous }, newData: { rows: chunk }, timestamp: now });
      insertedCount += Number(result.insertedCount || 0);
      updatedCount += Number(result.updatedCount || 0);
      onProgress(Math.min(index + chunk.length, records.length), records.length);
    }
    return { upsertedCount: insertedCount, modifiedCount: updatedCount, matchedCount: updatedCount };
  }, { timeout: 120000 });
}

function scanMatch(scope, filters = {}) {
  const match = {
    dealerCode: scope.dealerCode,
    auditId: scope.auditId,
    ...acceptedPhysicalScanClause()
  };
  if (filters.partNumber) {
    const part = normalizePart(filters.partNumber);
    match.$and.push({ $or: [{ normalizedPartNumber: part }, { partNumber: part }, { part }] });
  }
  if (filters.bin) {
    const binRegex = new RegExp(escapeRegex(filters.bin), 'i');
    match.$and.push({ $or: [{ binLocation: binRegex }, { bin: binRegex }] });
  }
  return match;
}

function scanQty(scan = {}) {
  return stockAvailableQuantity(scan);
}

async function physicalRows(scope, filters = {}) {
  const scans = applyMovementCountRules(uniqueReportScans(await Inventory.find(scanMatch(scope, filters)).sort({ timestamp: 1, createdAt: 1 }).lean()));
  const groups = new Map();
  scans.forEach((scan) => {
    const partNumber = normalizePart(scan.normalizedPartNumber || scan.partNumber || scan.part);
    if (!partNumber) return;
    const group = groups.get(partNumber) || {
      _id: partNumber,
      partNumber,
      actualStock: 0,
      bins: new Set(),
      sources: new Set(),
      scanModes: new Set(),
      valuationSources: new Set(),
      scanCount: 0,
      priceSnapshot: null
    };
    group.actualStock += scanQty(scan);
    group.scanCount += 1;
    if (!group.priceSnapshot) group.priceSnapshot = scan;
    const bin = clean(scan.binLocation || scan.bin);
    if (bin) group.bins.add(bin);
    if (scan.source) group.sources.add(scan.source);
    if (scan.scanMode) group.scanModes.add(scan.scanMode);
    if (scan.valuationSource) group.valuationSources.add(scan.valuationSource);
    groups.set(partNumber, group);
  });
  const partNumbers = Array.from(groups.keys());
  const prices = partNumbers.length ? await getPricesFromPartMaster(partNumbers, scope.dealerCode) : new Map();
  return Array.from(groups.values())
    .filter((row) => row.actualStock !== 0 && row._id)
    .map((row) => {
      const pricing = savedAuditPrice(row.priceSnapshot, prices.get(row.partNumber) || null);
      const hasMasterRecord = Boolean(pricing && (pricing.partNumber || pricing.normalizedPartNumber || pricing.description || pricing.partDescription || pricing.partName || pricing.productGroup || pricing.productCategory || pricing.category));
      const hasValidPrice = Boolean(Number(pricing && pricing.mrp || 0) > 0 && Number(pricing && (pricing.dlc ?? pricing.dlp) || 0) > 0);
      const mrp = hasValidPrice ? Number(pricing.mrp || 0) : 0;
      const dlc = hasValidPrice ? Number(pricing.dlc ?? pricing.dlp ?? 0) : 0;
      return {
        ...row,
        partDescription: hasMasterRecord ? clean(pricing.description || pricing.partDescription || pricing.partName || '') : MASTER_NOT_FOUND_LABEL,
        productCategory: hasMasterRecord ? resolveCategoryFromMaster(pricing) : 'Uncategorized',
        category: hasMasterRecord ? resolveCategoryFromMaster(pricing) : 'Uncategorized',
        model: hasMasterRecord ? clean(pricing.model || '') : '',
        year: hasMasterRecord ? clean(pricing.manufacturingYear || pricing.year || '') : '',
        manufacturingYear: hasMasterRecord ? clean(pricing.manufacturingYear || pricing.year || '') : '',
        productGroup: hasMasterRecord ? clean(pricing.productGroup || '') : '',
        partSubGroup: hasMasterRecord ? clean(pricing.partSubGroup || pricing.productSubGroup || '') : '',
        mrp,
        dlp: dlc,
        dlc,
        actualStock: money(row.actualStock),
        bins: Array.from(row.bins),
        sources: Array.from(row.sources),
        scanModes: Array.from(row.scanModes),
        valuationSources: Array.from(row.valuationSources)
      };
    });
}

function stockFilter(row, filters = {}) {
  if (filters.partNumber && normalizePart(row.partNumber) !== normalizePart(filters.partNumber)) return false;
  if (filters.category && !upper(row.productCategory).includes(upper(filters.category))) return false;
  if (filters.bin) {
    const bins = [row.binLocation, row.bin, row.binLoc1, row.binLoc2, row.binLoc3, row.systemBinLoc1, row.systemBinLoc2, row.systemBinLoc3].map(upper);
    if (!bins.some((bin) => bin.includes(upper(filters.bin)))) return false;
  }
  if (filters.status && upper(row.status) !== upper(filters.status)) return false;
  if (filters.movement && !upper(`${row.movementType} ${row.movementStatus}`).includes(upper(filters.movement))) return false;
  return true;
}

function codeTokens(value) {
  return upper(value).split(/[^A-Z0-9]+/).filter(Boolean);
}

function hasCode(value, candidates) {
  const tokens = codeTokens(value);
  return candidates.some((candidate) => tokens.includes(upper(candidate)));
}

function classifyMovement(stock = {}, actualStock = 0) {
  const dmsStock = Number(stock.dmsStock || stock.systemQty || 0);
  const averageDemand = Number(stock.averageDemand || 0);
  const forecast = Number(stock.forecast || 0);
  const safetyStock = Number(stock.safetyStock || 0);
  const rop = Number(stock.rop || 0);
  const movementCodeA = stock.movementCodeA || '';
  const movementCodeB = stock.movementCodeB || '';

  const highDemand = averageDemand >= 10 || forecast >= 10 || (dmsStock > 0 && averageDemand >= dmsStock * 0.25);
  const lowDemand = averageDemand <= 2;
  const fast = hasCode(movementCodeA, ['A']) || hasCode(movementCodeB, ['6']) || highDemand;
  const dead = dmsStock > 0 && averageDemand === 0 && forecast === 0;
  const slow = hasCode(movementCodeA, ['B', 'C']) || (lowDemand && dmsStock > 0);

  let movementStatus = 'Normal';
  if (dead) movementStatus = 'Dead Stock';
  else if (fast) movementStatus = 'Fast Moving';
  else if (slow) movementStatus = 'Slow Moving';

  const criticalShortage = rop > 0 && (dmsStock < rop || Number(actualStock || 0) < rop);
  const excessStock = dmsStock > forecast + safetyStock;
  let movementType = 'Normal';
  if (criticalShortage) movementType = 'Critical Shortage';
  else if (dead) movementType = 'Dead Stock';
  else if (excessStock) movementType = 'Excess Stock';
  else if (movementStatus !== 'Normal') movementType = movementStatus;

  const movementLabels = [];
  if (fast) movementLabels.push('Fast Moving');
  if (slow) movementLabels.push('Slow Moving');
  if (dead) movementLabels.push('Dead Stock');
  if (criticalShortage) movementLabels.push('Critical Shortage');
  if (excessStock) movementLabels.push('Excess Stock');

  return {
    movementType,
    movementStatus,
    priorityMovementStatus: movementType,
    movementLabels,
    fastMoving: fast,
    slowMoving: slow,
    deadStock: dead,
    criticalShortage,
    excessStock
  };
}

function statusForVariance(variance, notInDms = false, manual = false) {
  if (notInDms && manual) return 'Manual / Not in DMS';
  if (notInDms) return 'Scanned but not in DMS';
  if (variance === 0) return 'Matched';
  return variance < 0 ? 'Shortage' : 'Excess';
}

function reportRowFromStock(stock, physical, pricing = null) {
  const publicRow = publicStock(stock, pricing);
  const actualStock = Number((physical && physical.actualStock) || 0);
  const dmsStock = Number(publicRow.dmsStock || 0);
  const variance = actualStock - dmsStock;
  const dlp = publicRow.dlp ?? null;
  const mrp = publicRow.mrp ?? null;
  const hasDlc = Number(dlp || 0) > 0;
  const hasMrp = Number(mrp || 0) > 0;
  const dlcVariance = pricing?.varianceStockValue ?? (hasDlc ? decimalSum([priceValue(actualStock, dlp), -priceValue(dmsStock, dlp)]) : null);
  const mrpVariance = pricing?.varianceMrpValue ?? (hasMrp ? decimalSum([priceValue(actualStock, mrp), -priceValue(dmsStock, mrp)]) : null);
  const movement = classifyMovement(publicRow, actualStock);
  const binLocation = [publicRow.binLoc1, publicRow.binLoc2, publicRow.binLoc3].filter(Boolean).join(', ')
    || ((physical && physical.bins) || []).filter(Boolean).join(', ');
  const status = statusForVariance(variance);
  return {
    ...publicRow,
    partNo: publicRow.partNumber,
    actualStock,
    physicalStock: actualStock,
    variance,
    netDifference: variance,
    status,
    binLocation,
    bin: binLocation,
    movementType: movement.movementType,
    movementStatus: movement.movementStatus,
    priorityMovementStatus: movement.priorityMovementStatus,
    fastSlowDeadStatus: movement.movementStatus,
    movementLabels: movement.movementLabels,
    fastMoving: movement.fastMoving,
    slowMoving: movement.slowMoving,
    deadStock: movement.deadStock,
    criticalShortage: movement.criticalShortage,
    excessStock: movement.excessStock,
    actualStockValue: pricing ? pricing.actualStockValue : null,
    dmsStockValue: pricing ? pricing.dmsStockValue : null,
    actualMrpValue: pricing ? pricing.actualMrpValue : null,
    dmsMrpValue: pricing ? pricing.dmsMrpValue : null,
    stockValue: publicRow.stockValue ?? null,
    shortageQty: Math.max(variance * -1, 0),
    excessQty: Math.max(variance, 0),
    short: Math.max(variance * -1, 0),
    excess: Math.max(variance, 0),
    shortageValue: hasDlc ? Math.max(-dlcVariance, 0) : null,
    excessValue: hasDlc ? Math.max(dlcVariance, 0) : null,
    varianceDlp: dlcVariance,
    varianceDlc: dlcVariance,
    varianceMrp: mrpVariance,
    pricingStatus: publicRow.pricingStatus || '',
    pricingSource: publicRow.pricingSource || '',
    pricingWarnings: publicRow.pricingWarnings || [],
    warnings: publicRow.warnings || [],
    notInDms: false,
    manual: false
  };
}

function reportRowFromPhysical(physical, pricing = null) {
  const baseRow = {
    ...physical,
    partNumber: physical.partNumber || physical._id || '',
    dmsStock: 0,
    systemQty: 0
  };
  const publicRow = publicStock(baseRow, pricing);
  const actualStock = Number(physical.actualStock || 0);
  const dlp = publicRow.dlp ?? null;
  const mrp = publicRow.mrp ?? null;
  const hasDlc = Number(dlp || 0) > 0;
  const hasMrp = Number(mrp || 0) > 0;
  const manual = [...(physical.sources || []), ...(physical.scanModes || []), ...(physical.valuationSources || [])]
    .some((value) => /manual/i.test(String(value || '')));
  const variance = actualStock;
  const status = statusForVariance(variance, true, manual);
  const binLocation = (physical.bins || []).filter(Boolean).join(', ');
  return {
    auditId: '',
    dealerCode: '',
    partNo: publicRow.partNumber || physical.partNumber || physical._id || '',
    partNumber: publicRow.partNumber || physical.partNumber || physical._id || '',
    partDescription: publicRow.partDescription || physical.partDescription || '',
    productCategory: publicRow.productCategory || physical.productCategory || '',
    category: publicRow.category || physical.productCategory || '',
    model: publicRow.model || physical.model || '',
    year: publicRow.year || physical.year || '',
    manufacturingYear: publicRow.manufacturingYear || physical.year || '',
    mrp,
    dlp,
    dlc: dlp,
    dmsStock: 0,
    systemQty: 0,
    actualStock,
    physicalStock: actualStock,
    variance,
    netDifference: variance,
    status,
    binLocation,
    bin: binLocation,
    movementType: manual ? 'Manual Entry' : 'Extra / Not in DMS',
    movementStatus: 'Not in DMS',
    fastSlowDeadStatus: 'Not in DMS',
    actualStockValue: pricing ? pricing.actualStockValue : null,
    dmsStockValue: pricing ? pricing.dmsStockValue : null,
    actualMrpValue: pricing ? pricing.actualMrpValue : null,
    dmsMrpValue: pricing ? pricing.dmsMrpValue : null,
    stockValue: publicRow.stockValue ?? null,
    shortageQty: 0,
    excessQty: Math.max(actualStock, 0),
    short: 0,
    excess: Math.max(actualStock, 0),
    shortageValue: 0,
    excessValue: hasDlc ? money(Math.max(actualStock, 0) * Number(dlp || 0)) : null,
    varianceDlp: hasDlc ? money(variance * Number(dlp || 0)) : null,
    varianceDlc: hasDlc ? money(variance * Number(dlp || 0)) : null,
    varianceMrp: hasMrp ? money(variance * Number(mrp || 0)) : null,
    pricingStatus: publicRow.pricingStatus || '',
    pricingSource: publicRow.pricingSource || '',
    pricingWarnings: publicRow.pricingWarnings || [],
    warnings: publicRow.warnings || [],
    notInDms: true,
    manual
  };
}

function selectReportRows(rows = [], reportType = 'dealer') {
  const type = clean(reportType || 'dealer').toLowerCase();
  const filtered = rows.filter((row) => {
    if (type === 'shortage') return row.status === 'Shortage';
    if (type === 'excess') return row.status === 'Excess' || row.notInDms;
    if (type === 'dead') return row.movementStatus === 'Dead Stock';
    if (type === 'scanned-not-in-dms' || type === 'extra') return row.notInDms;
    return true;
  });
  if (type === 'bin') return filtered.sort((a, b) => String(a.binLocation || '').localeCompare(String(b.binLocation || ''), undefined, { numeric: true }) || String(a.partNumber || '').localeCompare(String(b.partNumber || ''), undefined, { numeric: true }));
  if (type === 'movement') return filtered.sort((a, b) => String(a.movementStatus || '').localeCompare(String(b.movementStatus || '')) || String(a.partNumber || '').localeCompare(String(b.partNumber || ''), undefined, { numeric: true }));
  return filtered;
}

async function buildReconciliationReport(query = {}) {
  if (require('../services/CentralValuationService').enabled()) return require('../services/ValuationReportProjection').project(query,'reconciliation');
  const scope = { dealerCode: upper(query.dealerCode), auditId: clean(query.auditId) };
  if (!scope.dealerCode || scope.dealerCode === 'ALL') {
    return { scope, summary: {}, rows: [], stockCount: 0, message: 'Select Dealer Code to view reconciliation report' };
  }
  if (!scope.auditId) {
    return { scope, summary: {}, rows: [], stockCount: 0, message: 'Active Audit ID is required for reconciliation report' };
  }
  const cacheQuery = { ...compactParams(query), dealerCode: scope.dealerCode, auditId: scope.auditId };
  const cached = await getCachedResponse('reconciliation-report', cacheQuery, async (normalizedQuery) => {
    const filters = compactParams(normalizedQuery);
    const stockQuery = { dealerCode: scope.dealerCode, auditId: scope.auditId };
    const [rawStockRows, scannedRows] = await Promise.all([
      DealerStock.find(stockQuery).sort({ partNumber: 1 }).lean(),
      physicalRows(scope, filters)
    ]);

    const stockRows = aggregateDealerStockRows(rawStockRows);
    const partNumbers = Array.from(new Set([
      ...stockRows.map((row) => normalizePart(row.normalizedPartNumber || row.partNumber || row.partNo || row.part)),
      ...scannedRows.map((row) => normalizePart(row._id || row.partNumber || row.partNo || row.part))
    ].filter(Boolean)));
    const priceByPart = partNumbers.length
      ? await getPricesFromPartMaster(partNumbers, scope.dealerCode)
      : new Map();

    const physicalByPart = new Map(scannedRows.map((row) => [normalizePart(row._id || row.partNumber), row]));
    const usedPhysicalKeys = new Set();
    const stockRowsWithPricing = stockRows.map((stock) => {
      const key = normalizePart(stock.normalizedPartNumber || stock.partNumber);
      const physical = physicalByPart.get(key);
      if (physical) usedPhysicalKeys.add(key);
      const masterPrice = invalidDealerStockPartReason(key) ? null : (priceByPart.get(key) || null);
      const pricing = resolvePartPricing({
        partNumber: key,
        partMasterPrice: masterPrice ? savedAuditPrice(stock, masterPrice) : null,
        actualQty: physical ? Number(physical.actualStock || 0) : 0,
        dmsQty: Number(stock.dmsStock || stock.systemQty || 0)
      });
      return reportRowFromStock(stock, physical, pricing);
    });

    const physicalOnlyRows = scannedRows.map((physical) => {
      const key = normalizePart(physical._id || physical.partNumber);
      if (usedPhysicalKeys.has(key)) return null;
      const pricing = resolvePartPricing({
        partNumber: key,
        partMasterPrice: savedAuditPrice(physical.priceSnapshot, priceByPart.get(key) || null),
        actualQty: Number(physical.actualStock || 0),
        dmsQty: 0
      });
      return reportRowFromPhysical(physical, pricing);
    });
    const rows = stockRowsWithPricing.concat(physicalOnlyRows.filter(Boolean));

    const dealerStockOnly = ['1', 'true', 'yes'].includes(clean(filters.dealerStockOnly).toLowerCase());
    const filteredRows = rows.filter((row) => stockFilter(row, filters) && (!dealerStockOnly || !row.notInDms));
    filteredRows.sort((a, b) => String(a.partNumber || '').localeCompare(String(b.partNumber || ''), undefined, { numeric: true, sensitivity: 'base' }));
    const stockOnlyRows = filteredRows.filter((row) => !row.notInDms);
    const valuationSummary = summarizeAuditValuation(filteredRows, { stockUploadPresent: stockRows.length > 0 });
    const totalInventoryValue = money(stockRowsWithPricing.reduce((sum, row) => sum + Number(row.stockValue || 0), 0));
    const summary = {
      dealerCode: scope.dealerCode,
      auditId: scope.auditId,
      totalPartsUploaded: stockRows.length,
      totalDmsStockQty: stockRows.reduce((sum, row) => sum + Number(row.dmsStock || row.systemQty || 0), 0),
      totalActualScannedQty: filteredRows.reduce((sum, row) => sum + Number(row.actualStock || 0), 0),
      totalMatchedParts: stockOnlyRows.filter((row) => row.status === 'Matched').length,
      totalShortageParts: stockOnlyRows.filter((row) => row.status === 'Shortage').length,
      totalExcessParts: filteredRows.filter((row) => Number(row.variance || 0) > 0).length,
      totalFastMovingParts: stockOnlyRows.filter((row) => row.movementStatus === 'Fast Moving').length,
      totalSlowMovingParts: stockOnlyRows.filter((row) => row.movementStatus === 'Slow Moving').length,
      totalDeadStockParts: stockOnlyRows.filter((row) => row.movementStatus === 'Dead Stock').length,
      totalInventoryValue,
      actualStockValueDLC: money(filteredRows.reduce((sum, row) => sum + Number(row.actualStockValue || 0), 0)),
      dmsStockValueDLC: money(filteredRows.reduce((sum, row) => sum + Number(row.dmsStockValue || 0), 0)),
      actualStockValueMRP: money(filteredRows.reduce((sum, row) => sum + Number(row.actualMrpValue || 0), 0)),
      dmsStockValueMRP: money(filteredRows.reduce((sum, row) => sum + Number(row.dmsMrpValue || 0), 0)),
      valuationBasis: 'DLC',
      totalShortageValue: money(filteredRows.reduce((sum, row) => sum + Number(row.shortageValue || 0), 0)),
      totalExcessValue: money(filteredRows.reduce((sum, row) => sum + Number(row.excessValue || 0), 0)),
      totalScannedButNotInDms: filteredRows.filter((row) => row.notInDms).length,
      dmsStock: stockRows.reduce((sum, row) => sum + Number(row.dmsStock || row.systemQty || 0), 0),
      physicalStock: filteredRows.reduce((sum, row) => sum + Number(row.actualStock || 0), 0),
      actualStock: filteredRows.reduce((sum, row) => sum + Number(row.actualStock || 0), 0),
      excess: filteredRows.reduce((sum, row) => sum + Number(row.excessQty || row.excess || 0), 0),
      short: filteredRows.reduce((sum, row) => sum + Number(row.shortageQty || row.short || 0), 0),
      netDifference: filteredRows.reduce((sum, row) => sum + Number(row.variance || 0), 0),
      varianceMrp: money(filteredRows.reduce((sum, row) => sum + Number(row.varianceMrp || 0), 0)),
      varianceDlc: money(filteredRows.reduce((sum, row) => sum + Number(row.varianceDlc || 0), 0)),
      mismatchCount: filteredRows.filter((row) => Number(row.variance || 0) !== 0).length,
      valuationSummary,
      valuationComplete: valuationSummary.valuationComplete,
      reconciliationComplete: valuationSummary.reconciliationComplete,
      priceMissingParts: valuationSummary.priceMissingParts,
      priceExceptions: valuationSummary.priceExceptions
    };
    Object.assign(summary, { totalInventoryValue: valuationSummary.totalDmsDlcValue,
      dmsStockValueDLC: valuationSummary.totalDmsDlcValue, dmsStockValueMRP: valuationSummary.totalDmsMrpValue,
      actualStockValueDLC: valuationSummary.totalPhysicalDlcValue, actualStockValueMRP: valuationSummary.totalPhysicalMrpValue,
      totalShortageValue: valuationSummary.totalShortValue, totalExcessValue: valuationSummary.totalExcessValue,
      varianceDlc: valuationSummary.totalVarianceDlcValue, varianceMrp: valuationSummary.totalVarianceMrpValue });

    return {
      scope,
      summary,
      filters,
      rows: filteredRows,
      valuationSummary,
      priceExceptions: valuationSummary.priceExceptions,
      mismatchRecords: filteredRows.filter((row) => Number(row.variance || 0) !== 0),
      stockCount: stockRows.length,
      message: stockRows.length ? '' : 'No dealer DMS stock uploaded for selected dealer/audit'
    };
  }, {
    scope,
    tags: ['reconciliation', 'stock', 'scan', 'master', 'catalogue', 'dealer', 'audit']
  });

  return {
    ...cached.data,
    cacheStatus: cached.cacheStatus,
    cacheVersion: cached.cacheVersion,
    dataVersion: cached.dataVersion,
    generatedFromCache: cached.cacheHit
  };
}

function movementStatusText(row = {}) {
  const labels = Array.isArray(row.movementLabels) ? row.movementLabels.filter(Boolean) : [];
  if (labels.length) return Array.from(new Set(labels)).join(', ');
  return [row.movementStatus, row.movementType].filter((value) => value && value !== 'Normal').join(', ') || 'Normal';
}

function priorityMovementStatus(row = {}) {
  if (row.criticalShortage || row.movementType === 'Critical Shortage') return 'Critical Shortage';
  if (row.deadStock || row.movementStatus === 'Dead Stock' || row.fastSlowDeadStatus === 'Dead Stock') return 'Dead Stock';
  if (row.excessStock || row.movementType === 'Excess Stock') return 'Excess Stock';
  if (row.fastMoving || row.movementStatus === 'Fast Moving' || row.fastSlowDeadStatus === 'Fast Moving') return 'Fast Moving';
  if (row.slowMoving || row.movementStatus === 'Slow Moving' || row.fastSlowDeadStatus === 'Slow Moving') return 'Slow Moving';
  return 'Normal';
}

function movementAnalysisRow(row = {}) {
  const dmsStock = Number(row.dmsStock || row.systemQty || 0);
  const dlp = row.dlp ?? row.dlc ?? null;
  const mrp = row.mrp ?? null;
  const movementStatus = row.priorityMovementStatus || priorityMovementStatus(row);
  return {
    dealerCode: row.dealerCode || '',
    auditId: row.auditId || '',
    partNumber: row.partNumber || row.partNo || '',
    partDescription: row.partDescription || row.partName || '',
    productCategory: row.productCategory || 'Uncategorized',
    dmsStock,
    actualStock: Number(row.actualStock ?? row.physicalStock ?? 0),
    variance: Number(row.variance ?? row.netDifference ?? 0),
    reconciliationStatus: row.status || '',
    mrp,
    dlp,
    stockValue: row.stockValue ?? row.dmsStockValue ?? null,
    movementCodeA: row.movementCodeA || '',
    movementCodeB: row.movementCodeB || '',
    averageDemand: Number(row.averageDemand || 0),
    forecast: Number(row.forecast || 0),
    safetyStock: Number(row.safetyStock || 0),
    rop: Number(row.rop || 0),
    binLocation: row.binLocation || row.bin || '',
    movementType: row.movementType || 'Normal',
    fastSlowDeadStatus: row.fastSlowDeadStatus || row.movementStatus || 'Normal',
    movementStatus,
    movementStatusDetail: movementStatusText(row),
    movementLabels: Array.isArray(row.movementLabels) ? row.movementLabels : [],
    fastMoving: Boolean(row.fastMoving || row.movementStatus === 'Fast Moving'),
    slowMoving: Boolean(row.slowMoving || row.movementStatus === 'Slow Moving'),
    deadStock: Boolean(row.deadStock || row.movementStatus === 'Dead Stock'),
    criticalShortage: Boolean(row.criticalShortage || row.movementType === 'Critical Shortage'),
    excessStock: Boolean(row.excessStock || row.movementType === 'Excess Stock'),
    pricingStatus: row.pricingStatus || '',
    pricingSource: row.pricingSource || '',
    pricingWarnings: Array.isArray(row.pricingWarnings) ? row.pricingWarnings : [],
    warnings: Array.isArray(row.warnings) ? row.warnings : []
  };
}

function movementRowHasLabel(row = {}, value = '') {
  const needle = upper(value);
  if (!needle) return true;
  const labels = [
    ...(Array.isArray(row.movementLabels) ? row.movementLabels : []),
    row.movementType,
    row.fastSlowDeadStatus,
    row.movementStatus
  ].map(upper);
  return labels.some((label) => label === needle || label.includes(needle));
}

function movementAnalysisFilter(row = {}, filters = {}) {
  if (filters.productCategory && !upper(row.productCategory).includes(upper(filters.productCategory))) return false;
  if (filters.category && !upper(row.productCategory).includes(upper(filters.category))) return false;
  if (filters.binLocation && !upper(row.binLocation).includes(upper(filters.binLocation))) return false;
  if (filters.bin && !upper(row.binLocation).includes(upper(filters.bin))) return false;
  if (filters.movementStatus && upper(row.movementStatus) !== upper(filters.movementStatus)) return false;
  if (filters.movementType && !movementRowHasLabel(row, filters.movementType)) return false;
  if (filters.movement && !movementRowHasLabel(row, filters.movement)) return false;
  if (filters.fastSlowDead && !movementRowHasLabel(row, filters.fastSlowDead)) return false;
  if (filters.fastSlowDeadStatus && !movementRowHasLabel(row, filters.fastSlowDeadStatus)) return false;
  return true;
}

function movementAnalysisSections(rows = []) {
  return {
    fastMoving: rows.filter((row) => row.movementStatus === 'Fast Moving'),
    slowMoving: rows.filter((row) => row.movementStatus === 'Slow Moving'),
    deadStock: rows.filter((row) => row.movementStatus === 'Dead Stock'),
    criticalShortage: rows.filter((row) => row.movementStatus === 'Critical Shortage'),
    excessStock: rows.filter((row) => row.movementStatus === 'Excess Stock')
  };
}

function movementAnalysisSummary(rows = [], baseSummary = {}) {
  const fastMovingParts = rows.filter((row) => row.movementStatus === 'Fast Moving').length;
  const slowMovingParts = rows.filter((row) => row.movementStatus === 'Slow Moving').length;
  const deadStockParts = rows.filter((row) => row.movementStatus === 'Dead Stock').length;
  const criticalShortageParts = rows.filter((row) => row.movementStatus === 'Critical Shortage').length;
  const excessStockParts = rows.filter((row) => row.movementStatus === 'Excess Stock').length;
  const deadStockValue = money(rows.reduce((sum, row) => sum + (row.movementStatus === 'Dead Stock' ? Number(row.stockValue || 0) : 0), 0));
  const excessStockValue = money(rows.reduce((sum, row) => sum + (row.movementStatus === 'Excess Stock' ? Number(row.stockValue || 0) : 0), 0));
  return {
    dealerCode: baseSummary.dealerCode || '',
    auditId: baseSummary.auditId || '',
    totalParts: rows.length,
    totalRows: rows.length,
    fastMovingParts,
    fastMovingCount: fastMovingParts,
    slowMovingParts,
    slowMovingCount: slowMovingParts,
    deadStockParts,
    deadStockCount: deadStockParts,
    criticalShortageParts,
    criticalShortageCount: criticalShortageParts,
    excessStockParts,
    excessStockCount: excessStockParts,
    deadStockValue,
    excessStockValue,
    totalDeadStockValue: deadStockValue,
    totalExcessStockValue: excessStockValue,
    totalDmsStockQty: rows.reduce((sum, row) => sum + Number(row.dmsStock || 0), 0),
    totalActualScannedQty: rows.reduce((sum, row) => sum + Number(row.actualStock || 0), 0),
    netVariance: rows.reduce((sum, row) => sum + Number(row.variance || 0), 0),
    totalStockValue: money(rows.reduce((sum, row) => sum + Number(row.stockValue || 0), 0))
  };
}

async function buildMovementAnalysisReport(query = {}) {
  const baseQuery = { ...query };
  if (baseQuery.productCategory && !baseQuery.category) baseQuery.category = baseQuery.productCategory;
  if (baseQuery.binLocation && !baseQuery.bin) baseQuery.bin = baseQuery.binLocation;
  delete baseQuery.movementType;
  delete baseQuery.fastSlowDead;
  delete baseQuery.fastSlowDeadStatus;
  const report = await buildReconciliationReport(baseQuery);
  const scope = report.scope || { dealerCode: upper(baseQuery.dealerCode), auditId: clean(baseQuery.auditId) };
  const cacheQuery = { ...compactParams(query), dealerCode: scope.dealerCode, auditId: scope.auditId };
  const cached = await getCachedResponse('movement-analysis-report', cacheQuery, async (normalizedQuery) => {
    const filters = compactParams(normalizedQuery);
    const rows = (report.rows || [])
      .filter((row) => !row.notInDms)
      .map(movementAnalysisRow)
      .filter((row) => movementAnalysisFilter(row, filters))
      .sort((a, b) => String(a.movementStatus || '').localeCompare(String(b.movementStatus || '')) || String(a.partNumber || '').localeCompare(String(b.partNumber || ''), undefined, { numeric: true, sensitivity: 'base' }));
    const sections = movementAnalysisSections(rows);
    const summary = movementAnalysisSummary(rows, report.summary || {});
    return {
      scope,
      dealerCode: scope.dealerCode,
      auditId: scope.auditId,
      filters,
      summary,
      sections,
      columns: movementAnalysisColumns().map(({ header, key }) => ({ header, key })),
      rows,
      stockCount: report.stockCount,
      message: rows.length ? '' : (report.message || 'No movement analysis data found for selected filter')
    };
  }, {
    scope,
    tags: ['reconciliation', 'stock', 'scan', 'master', 'catalogue', 'dealer', 'audit']
  });
  return {
    ...cached.data,
    cacheStatus: cached.cacheStatus,
    cacheVersion: cached.cacheVersion,
    dataVersion: cached.dataVersion,
    generatedFromCache: cached.cacheHit
  };
}

function previewColumns() {
  return [
    { header: 'Part Number', key: 'partNumber', width: 18 },
    { header: 'Description', key: 'partDescription', width: 32 },
    { header: 'Category', key: 'productCategory', width: 20 },
    { header: 'MRP', key: 'mrp', width: 12 },
    { header: 'DLP', key: 'dlp', width: 12 },
    { header: 'DMS Stock', key: 'dmsStock', width: 12 },
    { header: 'Bin Loc 1', key: 'binLoc1', width: 14 },
    { header: 'Bin Loc 2', key: 'binLoc2', width: 14 },
    { header: 'Bin Loc 3', key: 'binLoc3', width: 14 },
    { header: 'Reserved Qty', key: 'reservedQty', width: 14 },
    { header: 'Dealer Code', key: 'dealerCode', width: 14 },
    { header: 'Movement A', key: 'movementCodeA', width: 14 },
    { header: 'Movement B', key: 'movementCodeB', width: 14 },
    { header: 'Avg Demand', key: 'averageDemand', width: 14 },
    { header: 'Forecast', key: 'forecast', width: 12 },
    { header: 'Safety Stock', key: 'safetyStock', width: 14 },
    { header: 'ROP', key: 'rop', width: 10 },
    { header: 'Pending Order', key: 'pendingOrder', width: 14 },
    { header: 'Stock Value', key: 'stockValue', width: 16 }
  ];
}

function reportColumns() {
  return [
    { header: 'Part Number', key: 'partNumber', width: 18 },
    { header: 'Description', key: 'partDescription', width: 32 },
    { header: 'Category', key: 'productCategory', width: 20 },
    { header: 'DMS Stock', key: 'dmsStock', width: 12 },
    { header: 'Actual Scanned Stock', key: 'actualStock', width: 18 },
    { header: 'Variance', key: 'variance', width: 12 },
    { header: 'Status', key: 'status', width: 20 },
    { header: 'MRP', key: 'mrp', width: 12 },
    { header: 'DLC/DLP', key: 'dlp', width: 12 },
    { header: 'Pricing Status', key: 'pricingStatus', width: 24 },
    { header: 'Pricing Source', key: 'pricingSource', width: 20 },
    { header: 'Actual Stock Value (DLC)', key: 'actualStockValue', width: 24 },
    { header: 'DMS Stock Value (DLC)', key: 'dmsStockValue', width: 24 },
    { header: 'Actual MRP Value (Reference)', key: 'actualMrpValue', width: 28 },
    { header: 'DMS MRP Value (Reference)', key: 'dmsMrpValue', width: 28 },
    { header: 'Bin Location', key: 'binLocation', width: 24 },
    { header: 'Movement Type', key: 'movementType', width: 18 },
    { header: 'Fast/Slow/Dead Status', key: 'movementStatus', width: 22 },
    { header: 'Movement A', key: 'movementCodeA', width: 14 },
    { header: 'Movement B', key: 'movementCodeB', width: 14 },
    { header: 'Average Demand', key: 'averageDemand', width: 16 },
    { header: 'Forecast', key: 'forecast', width: 12 },
    { header: 'Safety Stock', key: 'safetyStock', width: 14 },
    { header: 'ROP', key: 'rop', width: 10 },
    { header: 'Shortage Value', key: 'shortageValue', width: 16 },
    { header: 'Excess Value', key: 'excessValue', width: 16 }
  ];
}

function movementAnalysisColumns() {
  return [
    { header: 'Movement Status', key: 'movementStatus', width: 20 },
    { header: 'Part Number', key: 'partNumber', width: 18 },
    { header: 'Part Description', key: 'partDescription', width: 34 },
    { header: 'Product Category', key: 'productCategory', width: 22 },
    { header: 'DMS Stock', key: 'dmsStock', width: 12 },
    { header: 'Actual Scanned Stock', key: 'actualStock', width: 18 },
    { header: 'Variance', key: 'variance', width: 12 },
    { header: 'Reconciliation Status', key: 'reconciliationStatus', width: 22 },
    { header: 'MRP', key: 'mrp', width: 12 },
    { header: 'DLC/DLP', key: 'dlp', width: 12 },
    { header: 'Pricing Status', key: 'pricingStatus', width: 24 },
    { header: 'Pricing Source', key: 'pricingSource', width: 20 },
    { header: 'Stock Value', key: 'stockValue', width: 16 },
    { header: 'Bin Location', key: 'binLocation', width: 26 },
    { header: 'Movement Code A', key: 'movementCodeA', width: 16 },
    { header: 'Movement Code B', key: 'movementCodeB', width: 16 },
    { header: 'Average Demand', key: 'averageDemand', width: 16 },
    { header: 'Forecast', key: 'forecast', width: 12 },
    { header: 'Safety Stock', key: 'safetyStock', width: 14 },
    { header: 'ROP', key: 'rop', width: 10 }
  ];
}

function addSheet(workbook, name, columns, rows) {
  const sheet = workbook.addWorksheet(name.slice(0, 31));
  sheet.columns = columns;
  rows.forEach((row) => sheet.addRow(row));
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF153A5B' } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  return sheet;
}

function addSummarySheet(workbook, summary) {
  const sheet = workbook.addWorksheet('Final Summary');
  sheet.columns = [{ header: 'Metric', key: 'metric', width: 42 }, { header: 'Value', key: 'value', width: 34 }];
  [
    ['Dealer Code', summary.dealerCode],
    ['Audit ID', summary.auditId],
    ['Total Parts Uploaded', summary.totalPartsUploaded],
    ['Total DMS Stock Qty', summary.totalDmsStockQty],
    ['Total Actual Scanned Qty', summary.totalActualScannedQty],
    ['Total Matched Parts', summary.totalMatchedParts],
    ['Total Shortage Parts', summary.totalShortageParts],
    ['Total Excess Parts', summary.totalExcessParts],
    ['Total Fast Moving Parts', summary.totalFastMovingParts],
    ['Total Slow Moving Parts', summary.totalSlowMovingParts],
    ['Total Dead Stock Parts', summary.totalDeadStockParts],
    ['DMS Stock Value (DLC)', summary.totalInventoryValue],
    ['Total Shortage Value', summary.totalShortageValue],
    ['Total Excess Value', summary.totalExcessValue],
    ['Scanned but not in DMS', summary.totalScannedButNotInDms],
    ['Valuation Status', summary.valuationSummary?.finalStatus || ''],
    ['DMS DLC Known Subtotal', summary.valuationSummary?.totalDmsDlcValueKnownSubtotal],
    ['DMS MRP Known Subtotal', summary.valuationSummary?.totalDmsMrpValueKnownSubtotal],
    ['Price Missing Parts', summary.valuationSummary?.priceMissingParts || 0],
    ['DMS Quantity Awaiting Prices', summary.valuationSummary?.dmsPriceMissingQty || 0]
  ].forEach(([metric, value]) => sheet.addRow({ metric, value: value === null ? 'PRICE MISSING' : value }));
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF153A5B' } };
}

function addMovementAnalysisSummarySheet(workbook, summary = {}) {
  const sheet = workbook.addWorksheet('Movement Summary');
  sheet.columns = [{ header: 'Metric', key: 'metric', width: 34 }, { header: 'Value', key: 'value', width: 18 }];
  [
    ['Dealer Code', summary.dealerCode],
    ['Audit ID', summary.auditId],
    ['Fast Moving Count', summary.fastMovingCount],
    ['Slow Moving Count', summary.slowMovingCount],
    ['Dead Stock Count', summary.deadStockCount],
    ['Critical Shortage Count', summary.criticalShortageCount],
    ['Excess Stock Count', summary.excessStockCount],
    ['Total Dead Stock Value', summary.totalDeadStockValue],
    ['Total Excess Stock Value', summary.totalExcessStockValue],
    ['Total DMS Stock Qty', summary.totalDmsStockQty],
    ['Total Actual Scanned Qty', summary.totalActualScannedQty],
    ['Net Variance', summary.netVariance],
    ['Total Stock Value', summary.totalStockValue]
  ].forEach(([metric, value]) => sheet.addRow({ metric, value }));
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF153A5B' } };
}

async function sendReportExport(res, report, format, reportType = 'dealer') {
  const rows = selectReportRows(report.rows || [], reportType);
  const scope = {
    dealerCode: report.summary && report.summary.dealerCode ? report.summary.dealerCode : report.scope?.dealerCode || '',
    auditId: report.summary && report.summary.auditId ? report.summary.auditId : report.scope?.auditId || ''
  };
  if (format === 'excel' || format === 'xlsx') {
    const cached = await getCachedResponse('reconciliation-download', {
      ...compactParams(report.filters || {}),
      reportType,
      format: 'excel',
      dealerCode: scope.dealerCode,
      auditId: scope.auditId
    }, async () => {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Daksh Inventory';
      addSummarySheet(workbook, report.summary || {});
      addSheet(workbook, reportType === 'full' ? 'Dealer Report' : `${reportType || 'dealer'} report`, reportColumns(), rows);
      if (report.priceExceptions?.length) addSheet(workbook, 'Price Exceptions', [
        { header: 'Part Number', key: 'partNumber', width: 24 },
        { header: 'DMS Quantity', key: 'dmsQuantity', width: 18 },
        { header: 'Physical Quantity', key: 'actualQuantity', width: 18 },
        { header: 'DLC', key: 'dlc', width: 16 }, { header: 'MRP', key: 'mrp', width: 16 },
        { header: 'Missing DLC', key: 'missingDlc', width: 18 }, { header: 'Missing MRP', key: 'missingMrp', width: 18 }
      ], report.priceExceptions);
      if (reportType === 'full') {
        addSheet(workbook, 'Shortage Report', reportColumns(), selectReportRows(report.rows, 'shortage'));
        addSheet(workbook, 'Excess Report', reportColumns(), selectReportRows(report.rows, 'excess'));
        addSheet(workbook, 'Dead Stock Report', reportColumns(), selectReportRows(report.rows, 'dead'));
        addSheet(workbook, 'Scanned Not In DMS', reportColumns(), selectReportRows(report.rows, 'scanned-not-in-dms'));
        addSheet(workbook, 'Bin Wise Report', reportColumns(), selectReportRows(report.rows, 'bin'));
        addSheet(workbook, 'Movement Wise Report', reportColumns(), selectReportRows(report.rows, 'movement'));
      }
      return Buffer.from(await workbook.xlsx.writeBuffer());
    }, {
      scope,
      tags: ['reconciliation', 'stock', 'scan', 'master', 'catalogue', 'dealer', 'audit']
    });
    applyCacheHeaders(res, cached);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Daksh_Reconciliation_${reportType || 'dealer'}.xlsx"`);
    return res.send(cached.data);
  }
  if (format === 'pdf') {
    const cached = await getCachedResponse('reconciliation-download', {
      reportType,
      format: 'pdf',
      dealerCode: scope.dealerCode,
      auditId: scope.auditId
    }, async () => {
      const doc = new jsPDF({ orientation: 'landscape' });
      doc.setFontSize(14);
      doc.text('DAKSH INVENTORY SYSTEM - Dealer Reconciliation', 14, 15);
      doc.setFontSize(9);
      doc.text(`Dealer: ${report.summary.dealerCode || '-'} | Audit: ${report.summary.auditId || '-'} | Report: ${reportType || 'dealer'}`, 14, 21);
      const columns = reportColumns();
      autoTable(doc, {
        startY: 28,
        head: [columns.map((column) => column.header)],
        body: rows.slice(0, 1000).map((row) => columns.map((column) => row[column.key] ?? '')),
        styles: { fontSize: 7, cellPadding: 1.6 },
        headStyles: { fillColor: [21, 58, 91] }
      });
      return Buffer.from(doc.output('arraybuffer'));
    }, {
      scope,
      tags: ['reconciliation', 'stock', 'scan', 'master', 'catalogue', 'dealer', 'audit']
    });
    applyCacheHeaders(res, cached);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Daksh_Reconciliation_${reportType || 'dealer'}.pdf"`);
    return res.send(cached.data);
  }
  return null;
}

async function sendMovementAnalysisExport(res, analysis, format) {
  const rows = analysis.rows || [];
  const scope = {
    dealerCode: analysis.summary && analysis.summary.dealerCode ? analysis.summary.dealerCode : analysis.dealerCode || '',
    auditId: analysis.summary && analysis.summary.auditId ? analysis.summary.auditId : analysis.auditId || ''
  };
  if (format === 'excel' || format === 'xlsx') {
    const cached = await getCachedResponse('movement-analysis-download', {
      reportType: 'movement-analysis',
      format: 'excel',
      dealerCode: scope.dealerCode,
      auditId: scope.auditId
    }, async () => {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Daksh Inventory';
      addMovementAnalysisSummarySheet(workbook, analysis.summary || {});
      addSheet(workbook, 'Movement Analysis', movementAnalysisColumns(), rows);
      const movementTypeFilter = clean((analysis.filters && (analysis.filters.movementType || analysis.filters.fastSlowDead)) || '');
      if (!movementTypeFilter) {
        addSheet(workbook, 'Fast Moving Parts', movementAnalysisColumns(), analysis.sections.fastMoving || []);
        addSheet(workbook, 'Slow Moving Parts', movementAnalysisColumns(), analysis.sections.slowMoving || []);
        addSheet(workbook, 'Dead Stock Parts', movementAnalysisColumns(), analysis.sections.deadStock || []);
        addSheet(workbook, 'Critical Shortage', movementAnalysisColumns(), analysis.sections.criticalShortage || []);
        addSheet(workbook, 'Excess Stock Parts', movementAnalysisColumns(), analysis.sections.excessStock || []);
      }
      return Buffer.from(await workbook.xlsx.writeBuffer());
    }, {
      scope,
      tags: ['reconciliation', 'stock', 'scan', 'master', 'catalogue', 'dealer', 'audit']
    });
    applyCacheHeaders(res, cached);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Daksh_Movement_Analysis_Report.xlsx"');
    return res.send(cached.data);
  }
  if (format === 'pdf') {
    const cached = await getCachedResponse('movement-analysis-download', {
      reportType: 'movement-analysis',
      format: 'pdf',
      dealerCode: scope.dealerCode,
      auditId: scope.auditId
    }, async () => {
      const doc = new jsPDF({ orientation: 'landscape' });
      doc.setFontSize(14);
      doc.text('DAKSH INVENTORY SYSTEM - Movement Analysis Report', 14, 15);
      doc.setFontSize(9);
      doc.text(`Dealer: ${analysis.summary.dealerCode || '-'} | Audit: ${analysis.summary.auditId || '-'} | Rows: ${rows.length}`, 14, 21);
      const columns = movementAnalysisColumns();
      autoTable(doc, {
        startY: 28,
        head: [columns.map((column) => column.header)],
        body: rows.slice(0, 1000).map((row) => columns.map((column) => row[column.key] ?? '')),
        styles: { fontSize: 6.6, cellPadding: 1.2 },
        headStyles: { fillColor: [21, 58, 91] }
      });
      return Buffer.from(doc.output('arraybuffer'));
    }, {
      scope,
      tags: ['reconciliation', 'stock', 'scan', 'master', 'catalogue', 'dealer', 'audit']
    });
    applyCacheHeaders(res, cached);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="Daksh_Movement_Analysis_Report.pdf"');
    return res.send(cached.data);
  }
  return null;
}

function reconciliationReportType(query = {}) {
  if (clean(query.full) === '1' || clean(query.full).toLowerCase() === 'true') return 'full';
  return clean(query.report || query.reportType || 'dealer').toLowerCase() || 'dealer';
}

async function scopedReconciliationQuery(req, res) {
  const scope = await resolveScope(req);
  if (!requireScope(scope, res)) return null;
  return {
    ...req.query,
    ...req.params,
    dealerCode: scope.dealerCode,
    auditId: scope.auditId
  };
}

function exportHandler(format) {
  return async (req, res) => {
    try {
      const query = await scopedReconciliationQuery(req, res);
      if (!query) return null;
      const report = await buildReconciliationReport(query);
      return sendReportExport(res, report, format, reconciliationReportType(query));
    } catch (error) {
      return res.status(error.statusCode || 500).json({ success: false, message: error.message, reconciliation: error.reconciliation });
    }
  };
}

async function summaryHandler(req, res) {
  try {
    const query = await scopedReconciliationQuery(req, res);
    if (!query) return null;
    const report = await buildReconciliationReport(query);
    return res.json({
      success: true,
      dealerCode: query.dealerCode,
      auditId: query.auditId,
      summary: report.summary || {},
      ...report.summary,
      message: report.message || ''
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message, reconciliation: error.reconciliation });
  }
}

async function movementAnalysisHandler(req, res) {
  try {
    const query = await scopedReconciliationQuery(req, res);
    if (!query) return null;
    const analysis = await buildMovementAnalysisReport(query);
    const format = clean(query.format).toLowerCase();
    if (format === 'excel' || format === 'xlsx' || format === 'pdf') {
      return sendMovementAnalysisExport(res, analysis, format);
    }
    return res.json({ success: true, ...analysis });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message, reconciliation: error.reconciliation });
  }
}

async function reportHandler(req, res) {
  try {
    const query = await scopedReconciliationQuery(req, res);
    if (!query) return null;
    const report = await buildReconciliationReport(query);
    const format = clean(query.format).toLowerCase();
    if (format === 'excel' || format === 'xlsx' || format === 'pdf') {
      return sendReportExport(res, report, format, reconciliationReportType(query));
    }
    return res.json({
      success: true,
      ...report,
      totalRows: Array.isArray(report.rows) ? report.rows.length : 0
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message, reconciliation: error.reconciliation });
  }
}

async function uploadDealerStockHandler(req, res) {
  const perfStartedAt = performance.now();
  const perf = {};
  let perfMarkAt = perfStartedAt;
  const markPerf = (stage) => {
    const now = performance.now();
    perf[stage] = Math.round(now - perfMarkAt);
    perfMarkAt = now;
  };
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Upload DMS stock Excel/CSV file' });
    const scope = await resolveScope(req);
    if (!requireScope(scope, res)) return null;
    const uploadBatchId = randomUUID();
    const progressId = clean(req.body && req.body.progressId);
    const sendProgress = (stage, processed = 0, total = 0) => {
      const io = req.io || req.app.get('io');
      if (io && progressId) io.emit('dealer-stock:upload:progress', { progressId, stage, processed, total });
    };
    sendProgress('parsing');
    const userName = (req.user && (req.user.name || req.user.username || req.user.email)) || 'System';
    const rows = await readUploadedRows(req.file);
    const header = findHeaderRow(rows);
    const dealerIndex = header.keys.indexOf('dealerCode');
    const partIndex = header.keys.indexOf('partNumber');
    const qtyIndex = header.keys.indexOf('dmsStock');
    const binIndexes = ['binLoc1', 'binLoc2', 'binLoc3'].map(key => header.keys.indexOf(key));
    let corrections;
    let selectedRowNumbers;
    try {
      corrections = req.body.corrections ? JSON.parse(req.body.corrections) : {};
      selectedRowNumbers = req.body.selectedRows ? JSON.parse(req.body.selectedRows) : null;
    } catch (_) {
      return res.status(400).json({ success: false, message: 'Invalid upload review data.' });
    }
    if (!corrections || Array.isArray(corrections) || typeof corrections !== 'object') return res.status(400).json({ success: false, message: 'Invalid row corrections.' });
    if (rows.length - header.index - 1 > 50000) return res.status(413).json({ success: false, message: 'Upload at most 50,000 rows per file.' });
    if (Object.keys(corrections).length > 50000 || (selectedRowNumbers !== null && (!Array.isArray(selectedRowNumbers) || selectedRowNumbers.length > 50000))) return res.status(400).json({ success: false, message: 'Invalid upload review size.' });
    for (const [rowKey, edit] of Object.entries(corrections)) {
      const rowNumber = Number(rowKey);
      if (!Number.isSafeInteger(rowNumber) || rowNumber <= header.index + 1 || rowNumber > rows.length || !edit || typeof edit !== 'object') return res.status(400).json({ success: false, message: 'Invalid Excel row correction.' });
      const values = rows[rowNumber - 1];
      if (!Array.isArray(values)) return res.status(400).json({ success: false, message: 'Excel row was not found.' });
      if (dealerIndex >= 0 && edit.dealerCode !== undefined) values[dealerIndex] = clean(edit.dealerCode);
      if (partIndex >= 0 && edit.partNumber !== undefined) values[partIndex] = clean(edit.partNumber);
      if (qtyIndex >= 0 && edit.dmsStock !== undefined) values[qtyIndex] = clean(edit.dmsStock);
      binIndexes.forEach((index, position) => { if (index >= 0 && edit[`binLoc${position + 1}`] !== undefined) values[index] = clean(edit[`binLoc${position + 1}`]); });
    }
    markPerf('fileParseMs');
    const selectedRows = selectedRowNumbers === null ? null : new Set(selectedRowNumbers.map(Number));
    if (selectedRows && [...selectedRows].some(row => !Number.isSafeInteger(row) || row <= header.index + 1 || row > rows.length)) return res.status(400).json({ success: false, message: 'Invalid row selection.' });
    const parsed = await rowsToStockRecords(rows, scope.dealerCode, scope.auditId, userName,
      (processed, total) => sendProgress('validating', processed, total), req.body.confirmed === 'true' ? selectedRows : null);
    markPerf('validationAndMergeMs');
    if (!parsed.reviewRows) return res.status(400).json({ success: false, message: parsed.errorRows?.[0]?.message || 'Invalid Dealer Stock template.' });
    const reviewSummary = {
      excelRows: parsed.reviewRows?.length || 0,
      validRows: parsed.reviewRows?.filter(row => row.status === 'VALID').length || 0,
      wrongParts: parsed.reviewRows?.filter(row => row.status === 'WRONG_PART').length || 0,
      missingPrices: parsed.reviewRows?.filter(row => row.status === 'MISSING_PRICE').length || 0,
      duplicates: parsed.reviewRows?.filter(row => row.status === 'DUPLICATE').length || 0,
      selectedQty: parsed.records.reduce((sum, row) => sum + row.dmsStock, 0),
      dlcValue: money(parsed.records.reduce((sum, row) => sum + row.stockValue, 0)),
      mrpValue: money(parsed.records.reduce((sum, row) => sum + row.dmsStock * row.mrp, 0))
    };
    if (req.body.confirmed !== 'true') return res.json({ success: true, dealerCode: scope.dealerCode, auditId: scope.auditId, reviewRows: parsed.reviewRows, reviewSummary, message: 'Validated for review. No stock was saved.' });
    if (!selectedRows || !selectedRows.size) return res.status(400).json({ success: false, message: 'Select validated rows before confirming upload.' });
    const selectedInvalid = parsed.reviewRows.find(row => selectedRows.has(row.rowNumber) && row.status !== 'VALID');
    if (selectedInvalid) return res.status(409).json({ success: false, message: `Excel row ${selectedInvalid.rowNumber} is ${selectedInvalid.status}: ${selectedInvalid.reason}. Revalidate before uploading.`, reviewRows: parsed.reviewRows });
    sendProgress('processing', 0, parsed.records.length);
    if (!parsed.records.length) {
      return res.status(400).json({
        success: false,
        dealerCode: scope.dealerCode,
        auditId: scope.auditId,
        savedCount: 0,
        skippedCount: parsed.skippedCount || parsed.errorRows.length,
        errorRows: parsed.errorRows,
        errorRowsTruncated: Boolean(parsed.errorRowsTruncated),
        columns: parsed.columns,
        message: parsed.errorRows[0]?.message || 'No valid dealer stock rows found'
      });
    }
    const records = parsed.records.map((record) => ({
      ...record,
      dealerCode: scope.dealerCode,
      auditId: scope.auditId,
      uploadBatchId
    }));
    const writeResult = await saveDealerStockRecords(records, (processed, total) => sendProgress('processing', processed, total), {
      batchId: uploadBatchId, fileName: clean(req.file.originalname), userId: String(req.user?.id || req.user?._id || ''),
      username: clean(req.user?.username), userName, role: clean(req.user?.role)
    });
    markPerf('bulkSaveMs');
    // Re-read the scoped stock after upsert so split uploads accumulate into
    // the dealer's complete stock and the upload summary reflects that total.
    const savedStock = await DealerStock.find({ dealerCode: scope.dealerCode, auditId: scope.auditId }).lean();
    const previewPrices = await getPricesFromPartMaster(savedStock.map((record) => record.partNumber), scope.dealerCode, { exact: true });
    const pricedStock = pricedDealerStockRows(savedStock, previewPrices);
    const preview = pricedStock.slice(0, 100);
    const summary = dealerStockSummaryFromPublicRows(pricedStock, savedStock.length, preview.length);
    markPerf('pricingAndSummaryMs');
    await emitReconciliationChanged(req, 'dealer-stock-uploaded', {
      dealerCode: scope.dealerCode,
      auditId: scope.auditId,
      uploadBatchId,
      savedCount: records.length
    });
    sendProgress('complete', records.length, records.length);
    if (process.env.PERFORMANCE_LOGS === 'true') {
      console.info('[DEALER_STOCK_UPLOAD_PERF]', JSON.stringify({
        totalMs: Math.round(performance.now() - perfStartedAt),
        stagesMs: perf,
        inputRows: rows.length,
        acceptedRows: records.length,
        skippedRows: parsed.skippedCount || 0,
        batchSize: DEALER_STOCK_UPLOAD_BATCH_SIZE,
        batches: Math.ceil(records.length / DEALER_STOCK_UPLOAD_BATCH_SIZE)
      }));
    }
    return res.json({
      success: true,
      dealerCode: scope.dealerCode,
      auditId: scope.auditId,
      uploadBatchId,
      savedCount: records.length,
      skippedCount: parsed.skippedCount || parsed.errorRows.length,
      duplicateRowsMerged: parsed.duplicateRowsMerged,
      upsertedCount: writeResult.upsertedCount || 0,
      updatedCount: writeResult.modifiedCount || 0,
      errorRows: parsed.errorRows,
      errorRowsTruncated: Boolean(parsed.errorRowsTruncated),
      summary,
      previewRange: summary.previewRange,
      lineRange: summary.lineRange,
      preview,
      columns: parsed.columns,
      message: `Saved ${records.length} row(s) for ${scope.dealerCode} / ${scope.auditId}. Dealer stock now contains ${savedStock.length} part line(s), total quantity ${summary.dmsStock}. Line range ${summary.lineRange.text}. Skipped ${parsed.skippedCount || parsed.errorRows.length} row(s).`
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message, reconciliation: error.reconciliation });
  }
}

async function previewDealerStockHandler(req, res) {
  try {
    const scope = await resolveScope(req);
    if (!requireScope(scope, res)) return null;
    if(require('../services/CentralValuationService').enabled()){
      const snapshot=await require('../services/CentralValuationService').getSnapshot(scope);
      const rows=snapshot.rows.filter(r=>r.uploadedStockPresent);
      const limit=Math.min(Math.max(Number(req.query.limit||PREVIEW_LIMIT),1),2000);
      const summary={partLineCount:rows.length,totalPartsUploaded:rows.length,dmsStock:snapshot.summary.totalSystemQty,
        dmsStockQty:snapshot.summary.totalSystemQty,systemStockValue:snapshot.summary.totalDmsDlcValue,stockValue:snapshot.summary.totalDmsDlcValue,
        valuationSummary:snapshot.summary,valuationComplete:snapshot.summary.valuationComplete};
      return res.json({success:true,...scope,total:rows.length,summary,stock:rows.slice(0,limit),rows:rows.slice(0,limit),preview:rows.slice(0,limit),snapshotId:snapshot.snapshotId});
    }
    const limit = Math.min(Math.max(Number(req.query.limit || PREVIEW_LIMIT), 1), 2000);
    const query = { dealerCode: scope.dealerCode, auditId: scope.auditId };
    const allRows = await DealerStock.find(query).sort({ partNumber: 1 }).lean();
    const priceByPart = await getPricesFromPartMaster(allRows.map((row) => row.normalizedPartNumber || row.partNumber), scope.dealerCode, { exact: true });
    const pricedRows = pricedDealerStockRows(allRows, priceByPart).map(row => {
      const partError = invalidDealerStockPartReason(row.partNumber);
      const price = partError ? null : priceByPart.get(normalizePart(row.partNumber));
      return { ...row, validationStatus: partError || !price ? 'WRONG_PART' : (!(Number(price.dlc) > 0) || !(Number(price.mrp) > 0) ? 'MISSING_PRICE' : 'VALID') };
    });
    const invalidRows = pricedRows.filter(row => row.validationStatus !== 'VALID');
    const visible = req.query.invalidOnly === '1' ? invalidRows : pricedRows;
    const stock = visible.slice(0, limit);
    const total = visible.length;
    const summary = dealerStockSummaryFromPublicRows(pricedRows, allRows.length, stock.length);
    return res.json({
      success: true,
      dealerCode: scope.dealerCode,
      auditId: scope.auditId,
      total,
      invalidCount: invalidRows.length,
      summary,
      previewRange: summary.previewRange,
      lineRange: summary.lineRange,
      stock
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function correctDealerStockPartHandler(req, res) {
  try {
    const scope = await resolveScope(req);
    if (!requireScope(scope, res)) return null;
    const partNumber = normalizePart(req.body.partNumber);
    if (invalidDealerStockPartReason(partNumber)) return res.status(400).json({ success: false, message: invalidDealerStockPartReason(partNumber) });
    const prices = await getPricesFromPartMaster([partNumber], scope.dealerCode, { exact: true });
    const price = prices.get(partNumber);
    if (!price || !price.masterFound) return res.status(400).json({ success: false, message: 'Replacement part is not in Part Master.' });
    if (!(Number(price.dlc) > 0) || !(Number(price.mrp) > 0)) return res.status(400).json({ success: false, message: 'Correct the replacement part prices in Part Master first.' });
    const result = await withDatabaseTransaction(async () => {
      const query = { _id: req.params.id, dealerCode: scope.dealerCode, auditId: scope.auditId };
      const saved = await DealerStock.findOne(query).lean();
      if (!saved) throw Object.assign(new Error('Stock row was not found for this active dealer audit.'), { statusCode: 404 });
      const previous = normalizePart(saved.normalizedPartNumber || saved.partNumber);
      const previousPrice = (await getPricesFromPartMaster([previous], scope.dealerCode, { exact: true })).get(previous);
      if (previousPrice && Number(previousPrice.dlc) > 0 && Number(previousPrice.mrp) > 0) throw Object.assign(new Error('This stock row is already valid in Part Master.'), { statusCode: 409 });
      if (previous === partNumber) throw Object.assign(new Error('Select a different valid Part Master part.'), { statusCode: 400 });
      const collision = await DealerStock.findOne({ dealerCode: scope.dealerCode, auditId: scope.auditId, normalizedPartNumber: partNumber }).lean();
      if (collision) throw Object.assign(new Error('Replacement part already has DMS stock. Review it before merging quantities.'), { statusCode: 409 });
      const changes = { partNumber, normalizedPartNumber: partNumber, partDescription: clean(price.description || price.partDescription || price.partName), dlc: Number(price.dlc), dlp: Number(price.dlc), mrp: Number(price.mrp), stockValue: money(Number(saved.dmsStock || 0) * Number(price.dlc)), correctedAt: new Date(), correctedBy: clean(req.user?.username || req.user?.name || '') };
      await DealerStock.updateOne(query, { $set: changes });
      await ScanAuditLog.create({ action: 'UPDATE', scanId: String(saved._id || saved.id), dealerCode: scope.dealerCode, partNumber: previous, performedByUserId: String(req.user?.id || req.user?._id || ''), performedByUsername: clean(req.user?.username), performedByName: clean(req.user?.name), performedByRole: clean(req.user?.role), reason: `Correct invalid uploaded DMS part for audit ${scope.auditId}`, oldData: saved, newData: { ...saved, ...changes }, timestamp: new Date() });
      return { before: previous, after: partNumber };
    }, { timeout: 60000 });
    await emitReconciliationChanged(req, 'dealer-stock-part-corrected', { ...scope, ...result });
    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
}

async function exportDealerStockReviewExceptions(req, res) {
  try {
    const scope = await resolveScope(req);
    if (!requireScope(scope, res)) return null;
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || rows.length > 50000) return res.status(400).json({ success: false, message: 'Invalid exception rows.' });
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Draft Upload Exceptions');
    sheet.addRow(['Dealer Code', 'Excel Row', 'Part Number', 'Description', 'DMS Qty', 'Bin Loc 1', 'Bin Loc 2', 'Bin Loc 3', 'Status', 'Reason']);
    rows.filter(row => row && row.status !== 'VALID').forEach(row => {
      sheet.addRow([clean(row.dealerCode), Number(row.rowNumber) || 0, clean(row.partNumber), clean(row.partDescription),
        Number.isFinite(Number(row.dmsStock)) ? Number(row.dmsStock) : '', clean(row.binLoc1), clean(row.binLoc2), clean(row.binLoc3), clean(row.status), clean(row.reason)]);
    });
    sheet.getColumn(3).numFmt = '@';
    sheet.columns.forEach(column => { column.width = 22; });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${scope.dealerCode}_DMS_Upload_Exceptions.xlsx"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(Buffer.from(await workbook.xlsx.writeBuffer()));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
}

async function dealerStockUploadHistoryHandler(req, res) {
  try {
    const scope = await resolveScope(req);
    if (!requireScope(scope, res)) return null;
    const logs = await ScanAuditLog.find({ dealerCode: scope.dealerCode, reason: { $regex: `^Dealer DMS stock update for audit ${scope.auditId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')};` } })
      .sort({ timestamp: -1 }).limit(100).lean();
    return res.json({ success: true, dealerCode: scope.dealerCode, auditId: scope.auditId, uploads: logs.map(log => ({
      batchId: log.scanId || '', fileName: String(log.reason || '').split('; source file ')[1] || '',
      timestamp: log.timestamp, uploadedBy: log.performedByName || log.performedByUsername || '',
      acceptedRows: Array.isArray(log.newData?.rows) ? log.newData.rows.length : 0,
      replacedRows: Array.isArray(log.oldData?.rows) ? log.oldData.rows.length : 0
    })) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
}

async function exportDealerStockHandler(req, res) {
  try {
    const scope = await resolveScope(req);
    if (!requireScope(scope, res)) return null;
    // Export saved upload values without substituting part-master descriptions or prices.
    // Read every row: preview pagination must never truncate a verification download.
    const rows = await DealerStock.find({ dealerCode: scope.dealerCode, auditId: scope.auditId }).sort({ partNumber: 1 }).lean();
    if (!rows.length) return res.status(404).json({ success: false, message: 'No uploaded dealer stock found for the selected dealer and audit' });
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Uploaded Dealer Stock');
    sheet.columns = [
      { header: 'Dealer Code', key: 'dealerCode', width: 16 },
      { header: 'Part Number', key: 'partNumber', width: 24 },
      { header: 'Part Description', key: 'partDescription', width: 42 },
      { header: 'DMS Stock', key: 'dmsStock', width: 16 },
      { header: 'Bin Loc 1', key: 'binLoc1', width: 18 },
      { header: 'Bin Loc 2', key: 'binLoc2', width: 18 },
      { header: 'Bin Loc 3', key: 'binLoc3', width: 18 },
      ...Object.keys(HEADER_ALIASES)
        .filter(key => !['dealerCode', 'partNumber', 'partDescription', 'dmsStock', 'binLoc1', 'binLoc2', 'binLoc3'].includes(key))
        .map(key => ({ header: HEADER_ALIASES[key][0], key, width: 20 }))
    ];
    let totalQuantity = 0;
    for (const row of rows) {
      const dmsStock = numberValue(row.dmsStock ?? row.systemQty);
      totalQuantity += dmsStock;
      sheet.addRow({
        ...row, dealerCode: scope.dealerCode, partNumber: clean(row.partNumber), dmsStock,
        binLoc1: row.binLoc1 || row.systemBinLoc1 || '',
        binLoc2: row.binLoc2 || row.systemBinLoc2 || '',
        binLoc3: row.binLoc3 || row.systemBinLoc3 || ''
      });
    }
    sheet.getColumn('partNumber').numFmt = '@';
    sheet.getColumn('dealerCode').numFmt = '@';
    sheet.getColumn('dmsStock').numFmt = '0.########';
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: 'A1', to: { row: rows.length + 1, column: sheet.columns.length } };
    const summary = workbook.addWorksheet('Verification Summary');
    summary.columns = [{ width: 28 }, { width: 48 }];
    summary.addRows([
      ['Dealer Code', scope.dealerCode], ['Audit ID', scope.auditId],
      ['Saved Part Lines', rows.length], ['Total DMS Stock Qty', totalQuantity],
      ['Exported At (UTC)', new Date().toISOString()],
      ['Data', 'Current saved upload; duplicate part rows may be merged during upload.']
    ]);
    const safeName = value => clean(value).replace(/[^a-zA-Z0-9_-]/g, '_');
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Daksh_Uploaded_Stock_${safeName(scope.dealerCode)}_${safeName(scope.auditId)}.xlsx"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(Buffer.from(buffer));
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function deleteDealerStockHandler(req, res) {
  try {
    const scope = await resolveScope(req);
    if (!requireScope(scope, res)) return null;
    const result = await DealerStock.deleteMany({ dealerCode: scope.dealerCode, auditId: scope.auditId });
    await emitReconciliationChanged(req, 'dealer-stock-deleted', { dealerCode: scope.dealerCode, auditId: scope.auditId, deletedCount: result.deletedCount || 0 });
    return res.json({
      success: true,
      dealerCode: scope.dealerCode,
      auditId: scope.auditId,
      deletedCount: result.deletedCount || 0,
      message: `Deleted old DMS stock for ${scope.dealerCode} / ${scope.auditId}`
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}


router.post('/confirm-upload',auth.requireAuth,auth.requireAdmin,async(req,res)=>{
  try{const scope=await resolveScope(req);if(!requireScope(scope,res))return;
    const result=await require('../services/ValuationWorkflow').confirmUpload(req,scope);
    await emitReconciliationChanged(req,'dealer-stock-uploaded',scope);res.json(result);
  }catch(error){res.status(error.statusCode||500).json({success:false,message:error.message});}
});
router.get('/price-validation',auth.requireAuth,async(req,res)=>{
  try{const scope=await resolveScope(req);if(!requireScope(scope,res))return;
    const snapshot=await require('../services/CentralValuationService').getSnapshot({...scope,snapshotId:req.query.snapshotId});
    const search=normalizePart(req.query.search||'');const filter=clean(req.query.filter);
    const rows=snapshot.priceExceptions.filter(r=>(!search||r.partNumber.includes(search))&&(!filter||filter==='all'||(filter==='dlc'?r.missingDlc:r.missingMrp)));
    if(req.query.format==='excel'){
      const workbook=new ExcelJS.Workbook();const sheet=workbook.addWorksheet('Price Validation');
      sheet.addRow(['Dealer',scope.dealerCode,'Audit',scope.auditId,'Snapshot',snapshot.snapshotId]);
      sheet.addRow(['Part Number','DMS Qty','Physical Qty','DLC','MRP','Problem','Price Version']);
      rows.forEach(r=>sheet.addRow([r.partNumber,r.dmsQuantity,r.actualQuantity,r.dlc,r.mrp,[r.missingDlc?'Missing DLC':'',r.missingMrp?'Missing MRP':''].filter(Boolean).join(', '),r.priceVersion||r.dlcPriceDate||'']));
      sheet.columns.forEach(c=>c.width=22);
      res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition',`attachment; filename="Price_Validation_${scope.dealerCode}.xlsx"`);
      return res.send(Buffer.from(await workbook.xlsx.writeBuffer()));
    }
    res.json({success:true,...scope,rows,summary:snapshot.summary,snapshotId:snapshot.snapshotId});
  }catch(error){res.status(error.statusCode||500).json({success:false,message:error.message});}
});
router.patch('/master-price',auth.requireAuth,auth.requireAdmin,async(req,res)=>{
  try{const scope=await resolveScope(req);if(!requireScope(scope,res))return;
    const result=await require('../services/ValuationWorkflow').correctPrice(req,scope);
    await emitReconciliationChanged(req,'master-price-corrected',scope);res.json(result);
  }catch(error){res.status(error.statusCode||500).json({success:false,message:error.message});}
});
router.get('/import-history',auth.requireAuth,async(req,res)=>{
  try{const scope=await resolveScope(req);if(!requireScope(scope,res))return;
    await require('../services/CentralValuationService').validateScope(scope);
    const db=require('../services/prisma').getPrismaClient();
    const rows=await db.$queryRaw`SELECT id,file_name,status,created_at,confirmed_at FROM dealer_stock_imports WHERE dealer_code=${scope.dealerCode} AND audit_id=${scope.auditId} ORDER BY created_at DESC LIMIT 100`;
    res.json({success:true,...scope,rows});
  }catch(error){res.status(error.statusCode||500).json({success:false,message:error.message});}
});

router.get('/dealer-stock-template', auth.requireAuth, auth.requireAdmin, sendDealerStockTemplate);
router.post(['/upload-stock', '/upload'], auth.requireAuth, auth.requireAdmin, upload.single('file'), uploadDealerStockHandler);
router.get(['/stock-preview', '/preview/:dealerCode/:auditId'], auth.requireAuth, previewDealerStockHandler);
router.patch('/stock/:id', auth.requireAuth, auth.requireAdmin, correctDealerStockPartHandler);
router.post('/stock-review-exceptions', auth.requireAuth, auth.requireAdmin, exportDealerStockReviewExceptions);
router.get('/stock-upload-history', auth.requireAuth, auth.requireAdmin, dealerStockUploadHistoryHandler);
router.get('/stock-export', auth.requireAuth, exportDealerStockHandler);
router.delete(['/stock', '/delete/:dealerCode/:auditId'], auth.requireAuth, auth.requireAdmin, deleteDealerStockHandler);

router.get('/export/excel', auth.requireAuth, exportHandler('excel'));
router.get('/export/pdf', auth.requireAuth, exportHandler('pdf'));
router.get('/final-summary/:dealerCode/:auditId', auth.requireAuth, summaryHandler);
router.get('/movement-analysis/:dealerCode/:auditId', auth.requireAuth, movementAnalysisHandler);
router.get('/movement-analysis', auth.requireAuth, movementAnalysisHandler);
router.get('/report/:dealerCode/:auditId', auth.requireAuth, reportHandler);
router.get('/report', auth.requireAuth, reportHandler);
router.get('/', auth.requireAuth, reportHandler);

router.post('/reprocess', auth.requireAuth, async (req, res) => {
  try {
    const scope = await resolveScope(req);
    const report = await buildReconciliationReport({ ...req.query, ...(req.body || {}), dealerCode: scope.dealerCode, auditId: scope.auditId });
    await emitReconciliationChanged(req, 'reconciliation-reprocessed', { dealerCode: scope.dealerCode, auditId: scope.auditId });
    return res.json({
      success: true,
      dealerCode: scope.dealerCode,
      auditId: scope.auditId,
      summary: report.summary,
      rows: report.rows.slice(0, PREVIEW_LIMIT),
      message: 'Reconciliation reprocessed'
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
module.exports.buildReconciliationReport = buildReconciliationReport;
module.exports.buildMovementAnalysisReport = buildMovementAnalysisReport;
module.exports.rowsToStockRecords = rowsToStockRecords;
module.exports.readUploadedRows = readUploadedRows;
