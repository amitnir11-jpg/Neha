const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const { randomUUID } = require('crypto');
const { jsPDF } = require('jspdf');
const autoTableModule = require('jspdf-autotable');
const DealerStock = require('../models/DealerStock');
const Inventory = require('../models/Inventory');
const Dealer = require('../models/Dealer');
const auth = require('./auth');
const { getActiveAudit } = require('../utils/audit');
const { validScanClause } = require('../utils/masterValidation');
const { normalizePartNumber } = require('../utils/normalize');
const { uniqueReportScans } = require('../utils/reportScanIdentity');
const { applyMovementCountRules, signedScanQuantity } = require('../utils/reportTotals');
const { calculateStockValuation } = require('../utils/stockValuation');
const { resolvePartPricing } = require('../utils/partPricing');
const { getPricesFromPartMaster } = require('../utils/partMasterPrice');
const { applyCacheHeaders, getCachedResponse, invalidateCache } = require('../utils/safeCache');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const autoTable = autoTableModule.default || autoTableModule;

const EXCLUDED_SYNC_STATUSES = ['duplicate', 'rejected', 'failed', 'deleted'];
const POSITIVE_SCAN_TYPES = ['INWARD', 'AUDIT'];
const NEGATIVE_SCAN_TYPES = ['OUTWARD', 'FITTED', 'DAMAGE'];
const UPLOAD_ERROR_LIMIT = 250;
const PREVIEW_LIMIT = 500;
const ACCEPTED_SCAN_STATUSES = ['ACCEPTED', 'SUPERVISOR_APPROVED', 'OUTWARD_DONE'];

function clean(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function normalizePart(value) {
  return normalizePartNumber(value);
}

function numberValue(value, fallback = 0) {
  const parsed = parseNumber(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const text = clean(value)
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
  partNumber: ['PART NUMBER', 'PART NO', 'PARTNO', 'PART', 'PART CODE', 'ITEM CODE', 'MATERIAL CODE', 'SKU'],
  partDescription: ['PART DESCRIPTION', 'DESCRIPTION', 'PART NAME', 'ITEM DESCRIPTION', 'MATERIAL DESCRIPTION', 'PRODUCT DESCRIPTION', 'PRODUCT DESC'],
  productCategory: ['PRODUCT CATEGORY', 'CATEGORY', 'PRODUCT CAT', 'ITEM CATEGORY'],
  model: ['MODEL'],
  year: ['YEAR', 'MANUFACTURING YEAR', 'MFG YEAR'],
  productGroup: ['PRODUCT GROUP', 'GROUP', 'PG'],
  partSubGroup: ['PRODUCT SUBGROUP', 'PART SUBGROUP', 'SUB GROUP', 'SUBGROUP', 'SPG'],
  mrp: ['MRP', 'PRICE', 'MAX RETAIL PRICE'],
  dlp: ['DLP', 'DLC', 'DLC DLP', 'DLP DLC', 'DEALER LANDING COST', 'LANDING COST', 'DEALER LIST PRICE'],
  dmsStock: ['SYSTEM QUANTITY', 'SYSTEM QTY', 'SYSTEM STOCK', 'DMS STOCK', 'DMS QTY', 'STOCK', 'QUANTITY', 'QTY', 'STOCK ON HAND', 'STOCK IN HAND', 'STOCK INHAND', 'SOH', 'SIH'],
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

const NUMERIC_KEYS = new Set(['mrp', 'dlp', 'dmsStock', 'reservedQty', 'averageDemand', 'forecast', 'safetyStock', 'rop', 'pendingOrder']);
const SUM_NUMERIC_KEYS = new Set(['reservedQty', 'pendingOrder']);
const JOIN_TEXT_KEYS = new Set(['movementCodeA', 'movementCodeB']);

function normalizeHeader(value) {
  return upper(value).replace(/[^A-Z0-9]+/g, ' ').trim();
}

const HEADER_LOOKUP = Object.entries(HEADER_ALIASES).reduce((map, [key, aliases]) => {
  aliases.forEach((alias) => map.set(normalizeHeader(alias), key));
  return map;
}, new Map());

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
    'productCategory',
    'category',
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
    'movementCodeA',
    'movementCodeB'
  ];
  textFields.forEach((field) => {
    if (!target[field] && item[field]) target[field] = item[field];
  });
  ['mrp', 'dlp', 'dlc', 'averageDemand', 'forecast', 'safetyStock', 'rop'].forEach((field) => {
    if (Number(item[field] || 0) > 0) target[field] = Number(item[field] || 0);
  });
  target.dmsStock += Number(item.dmsStock || 0);
  target.systemQty = target.dmsStock;
  target.reservedQty += Number(item.reservedQty || 0);
  target.pendingOrder += Number(item.pendingOrder || 0);
  target.stockValue = money(target.dmsStock * Number(target.dlp || target.dlc || 0));
  return target;
}

function rowsToStockRecords(rows, selectedDealerCode, auditId, userName) {
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
  if (!columnsByKey.dealerCode && !selectedDealerCode) missing.push('Dealer Code or selected dealer');
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
  const errorRows = [];
  let duplicateRowsMerged = 0;
  let skippedCount = 0;

  rows.slice(headerInfo.index + 1).forEach((values, offset) => {
    if (!values || !values.some((value) => clean(value))) return;
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
    if (selectedDealerCode && fileDealerCode && selectedDealerCode !== fileDealerCode) errors.push(`Dealer code ${fileDealerCode} does not match selected dealer ${selectedDealerCode}`);
    if (!partNumber) errors.push('Part number blank');
    if (!Number.isFinite(item.dmsStock)) errors.push('DMS stock must be numeric');
    if (columnsByKey.mrp && !Number.isFinite(item.mrp)) errors.push('MRP must be numeric when provided');
    if (columnsByKey.dlp && !Number.isFinite(item.dlp)) errors.push('DLC / DLP must be numeric when provided');
    if (errors.length) {
      skippedCount += 1;
      if (errorRows.length < UPLOAD_ERROR_LIMIT) {
        errorRows.push({ rowNumber, partNumber: clean(item.partNumber), dealerCode: fileDealerCode || dealerCode, message: errors.join('; ') });
      }
      return;
    }

    const record = {
      auditId,
      dealerCode,
      partNumber,
      normalizedPartNumber: partNumber,
      partDescription: clean(item.partDescription),
      productCategory: clean(item.productCategory),
      category: clean(item.productCategory),
      model: clean(item.model),
      year: clean(item.year),
      manufacturingYear: clean(item.year),
      productGroup: upper(item.productGroup),
      partSubGroup: upper(item.partSubGroup),
      mrp: Number(item.mrp || 0),
      dlp: Number(item.dlp || 0),
      dlc: Number(item.dlp || 0),
      dmsStock: Number(item.dmsStock || 0),
      systemQty: Number(item.dmsStock || 0),
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

    const existing = byPart.get(partNumber);
    if (existing) {
      duplicateRowsMerged += 1;
      mergeRecord(existing, record);
    } else {
      byPart.set(partNumber, record);
    }
  });

  return {
    records: Array.from(byPart.values()),
    errorRows,
    columns: headers,
    duplicateRowsMerged,
    skippedCount,
    errorRowsTruncated: skippedCount > errorRows.length
  };
}

function publicStock(row, pricing = null) {
  const mrp = pricing ? pricing.mrp : Number(row.mrp || 0);
  const dlp = pricing ? (pricing.dlc ?? pricing.dlp ?? null) : Number(row.dlp || row.dlc || 0);
  const dmsStock = Number(row.dmsStock || row.systemQty || 0);
  return {
    id: String(row._id || ''),
    auditId: row.auditId || '',
    dealerCode: row.dealerCode || '',
    partNumber: row.partNumber || '',
    partDescription: (pricing && pricing.partDescription) || row.partDescription || '',
    productCategory: (pricing && pricing.productCategory) || row.productCategory || row.category || '',
    category: (pricing && pricing.category) || row.category || row.productCategory || '',
    mrp,
    dlp,
    dlc: dlp,
    dmsStock,
    systemQty: dmsStock,
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
    stockValue: pricing ? (pricing.dmsStockValue ?? null) : money(row.stockValue || dmsStock * Number(dlp || 0)),
    uploadBatchId: row.uploadBatchId || '',
    uploadedAt: row.uploadedAt || row.updatedAt || row.createdAt,
    pricingStatus: pricing ? pricing.pricingStatus : '',
    pricingSource: pricing ? pricing.pricingSource : '',
    pricingWarnings: pricing ? pricing.pricingWarnings : [],
    warnings: pricing ? pricing.warnings : []
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
  if (!auditId && dealerCode && dealerCode !== 'ALL') {
    const [dealer, activeAudit] = await Promise.all([
      Dealer.findOne({ dealerCode }).lean().catch(() => null),
      getActiveAudit({ dealerCode }).catch(() => null)
    ]);
    auditId = clean((dealer && dealer.currentAuditId) || (activeAudit && activeAudit.auditId) || '');
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
  const io = req.io || req.app.get('io');
  if (!io) return;
  invalidateCache({
    tags: ['reconciliation', 'stock', 'report', 'dashboard'],
    scope: { dealerCode: payload.dealerCode || '', auditId: payload.auditId || '' }
  });
  io.emit('dealer-stock:update', { reason, ...payload, at: new Date() });
  io.emit('reports:update', { reason, ...payload, at: new Date() });
}

async function saveDealerStockRecords(records = []) {
  const operations = [];
  const now = new Date();
  records.forEach((record) => {
    operations.push({
      updateOne: {
        filter: {
          dealerCode: record.dealerCode,
          auditId: record.auditId,
          normalizedPartNumber: record.normalizedPartNumber
        },
        update: {
          $set: {
            ...record,
            updatedAt: now
          },
          $setOnInsert: {
            createdAt: now
          }
        },
        upsert: true
      }
    });
  });
  let result = { upsertedCount: 0, modifiedCount: 0, matchedCount: 0 };
  for (let index = 0; index < operations.length; index += 1000) {
    const chunk = operations.slice(index, index + 1000);
    const chunkResult = await DealerStock.bulkWrite(chunk, { ordered: false });
    result = {
      upsertedCount: Number(result.upsertedCount || 0) + Number(chunkResult.upsertedCount || 0),
      modifiedCount: Number(result.modifiedCount || 0) + Number(chunkResult.modifiedCount || 0),
      matchedCount: Number(result.matchedCount || 0) + Number(chunkResult.matchedCount || 0)
    };
  }
  return result;
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
  if (scan._reportSignedQty !== undefined) return signedScanQuantity(scan, 0);
  const qty = numberValue(scan.qty !== undefined ? scan.qty : scan.quantity, 0);
  const type = upper(scan.scanType || scan.type || 'INWARD');
  if (POSITIVE_SCAN_TYPES.includes(type)) return Math.abs(qty);
  if (NEGATIVE_SCAN_TYPES.includes(type)) return -Math.abs(qty);
  if (type === 'VERIFICATION') return 0;
  return Math.abs(qty);
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
      partDescription: clean(scan.partDescription || scan.partName),
      productCategory: clean(scan.productCategory || scan.category),
      model: clean(scan.model),
      year: clean(scan.manufacturingYear || scan.year),
      productGroup: clean(scan.productGroup),
      partSubGroup: clean(scan.partSubGroup),
      mrp: 0,
      dlp: 0,
      actualStock: 0,
      bins: new Set(),
      sources: new Set(),
      scanModes: new Set(),
      valuationSources: new Set()
    };
    group.mrp = Math.max(group.mrp, numberValue(scan.valuationMRP || scan.finalMRP || scan.mrp, 0));
    group.dlp = Math.max(group.dlp, numberValue(scan.dlc, 0));
    group.actualStock += scanQty(scan);
    const bin = clean(scan.binLocation || scan.bin);
    if (bin) group.bins.add(bin);
    if (scan.source) group.sources.add(scan.source);
    if (scan.scanMode) group.scanModes.add(scan.scanMode);
    if (scan.valuationSource) group.valuationSources.add(scan.valuationSource);
    groups.set(partNumber, group);
  });
  return Array.from(groups.values())
    .filter((row) => row.actualStock !== 0 && row._id)
    .map((row) => ({
      ...row,
      actualStock: money(row.actualStock),
      bins: Array.from(row.bins),
      sources: Array.from(row.sources),
      scanModes: Array.from(row.scanModes),
      valuationSources: Array.from(row.valuationSources)
    }));
}

function stockFilter(row, filters = {}) {
  if (filters.partNumber && normalizePart(row.partNumber) !== normalizePart(filters.partNumber)) return false;
  if (filters.category && !upper(row.productCategory || row.category).includes(upper(filters.category))) return false;
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
    shortageValue: hasDlc ? money(Math.max(variance * -1, 0) * Number(dlp || 0)) : null,
    excessValue: hasDlc ? money(Math.max(variance, 0) * Number(dlp || 0)) : null,
    varianceDlp: hasDlc ? money(variance * Number(dlp || 0)) : null,
    varianceDlc: hasDlc ? money(variance * Number(dlp || 0)) : null,
    varianceMrp: hasMrp ? money(variance * Number(mrp || 0)) : null,
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
    const [stockRows, scannedRows] = await Promise.all([
      DealerStock.find(stockQuery).sort({ partNumber: 1 }).lean(),
      physicalRows(scope, filters)
    ]);

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
      const pricing = resolvePartPricing({
        partNumber: key,
        partMasterPrice: priceByPart.get(key) || null,
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
        partMasterPrice: priceByPart.get(key) || null,
        actualQty: Number(physical.actualStock || 0),
        dmsQty: 0
      });
      return reportRowFromPhysical(physical, pricing);
    });
    const rows = stockRowsWithPricing.concat(physicalOnlyRows.filter(Boolean));

    const filteredRows = rows.filter((row) => stockFilter(row, filters));
    filteredRows.sort((a, b) => String(a.partNumber || '').localeCompare(String(b.partNumber || ''), undefined, { numeric: true, sensitivity: 'base' }));
    const stockOnlyRows = filteredRows.filter((row) => !row.notInDms);
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
      mismatchCount: filteredRows.filter((row) => Number(row.variance || 0) !== 0).length
    };

    return {
      scope,
      summary,
      rows: filteredRows,
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
    productCategory: row.productCategory || row.category || '',
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
  sheet.columns = [{ header: 'Metric', key: 'metric', width: 34 }, { header: 'Value', key: 'value', width: 18 }];
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
    ['Total Inventory Value', summary.totalInventoryValue],
    ['Total Shortage Value', summary.totalShortageValue],
    ['Total Excess Value', summary.totalExcessValue],
    ['Scanned but not in DMS', summary.totalScannedButNotInDms]
  ].forEach(([metric, value]) => sheet.addRow({ metric, value }));
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
      reportType,
      format: 'excel',
      dealerCode: scope.dealerCode,
      auditId: scope.auditId
    }, async () => {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Daksh Inventory';
      addSummarySheet(workbook, report.summary || {});
      addSheet(workbook, reportType === 'full' ? 'Dealer Report' : `${reportType || 'dealer'} report`, reportColumns(), rows);
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

async function uploadDealerStockHandler(req, res) {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Upload DMS stock Excel/CSV file' });
    const scope = await resolveScope(req);
    if (!requireScope(scope, res)) return null;
    const uploadBatchId = randomUUID();
    const userName = (req.user && (req.user.name || req.user.username || req.user.email)) || 'System';
    const rows = await readUploadedRows(req.file);
    const parsed = rowsToStockRecords(rows, scope.dealerCode, scope.auditId, userName);
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
    const writeResult = await saveDealerStockRecords(records);
    const previewPrices = await getPricesFromPartMaster(records.map((record) => record.partNumber), scope.dealerCode);
    await emitReconciliationChanged(req, 'dealer-stock-uploaded', {
      dealerCode: scope.dealerCode,
      auditId: scope.auditId,
      uploadBatchId,
      savedCount: records.length
    });
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
      preview: records.slice(0, 100).map((record) => {
        const price = previewPrices.get(record.partNumber) || null;
        return publicStock(record, resolvePartPricing({
          partNumber: record.partNumber,
          partMasterPrice: price,
          actualQty: 0,
          dmsQty: record.dmsStock
        }));
      }),
      columns: parsed.columns,
      message: `Saved ${records.length} row(s) for ${scope.dealerCode} / ${scope.auditId}. Skipped ${parsed.skippedCount || parsed.errorRows.length} row(s).`
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message, reconciliation: error.reconciliation });
  }
}

async function previewDealerStockHandler(req, res) {
  try {
    const scope = await resolveScope(req);
    if (!requireScope(scope, res)) return null;
    const limit = Math.min(Math.max(Number(req.query.limit || PREVIEW_LIMIT), 1), 2000);
    const query = { dealerCode: scope.dealerCode, auditId: scope.auditId };
    const [rows, total] = await Promise.all([
      DealerStock.find(query).sort({ partNumber: 1 }).limit(limit).lean(),
      DealerStock.countDocuments(query)
    ]);
    const priceByPart = await getPricesFromPartMaster(rows.map((row) => row.partNumber), scope.dealerCode);
    const stock = rows.map((row) => {
      const partNumber = normalizePart(row.normalizedPartNumber || row.partNumber);
      return publicStock(row, resolvePartPricing({
        partNumber,
        partMasterPrice: priceByPart.get(partNumber) || null,
        actualQty: 0,
        dmsQty: Number(row.dmsStock || row.systemQty || 0)
      }));
    });
    return res.json({
      success: true,
      dealerCode: scope.dealerCode,
      auditId: scope.auditId,
      total,
      summary: {
        rows: total,
        dmsStock: stock.reduce((sum, row) => sum + Number(row.dmsStock || 0), 0),
        stockValue: money(stock.reduce((sum, row) => sum + Number(row.stockValue || 0), 0))
      },
      stock
    });
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

async function reportHandler(req, res) {
  try {
    const scope = await resolveScope(req);
    const report = await buildReconciliationReport({ ...req.query, dealerCode: scope.dealerCode, auditId: scope.auditId });
    const reconciliation = await require('./report').validateValuationReports(scope);
    if (req.query.format) return sendReportExport(res, report, req.query.format, req.query.report || (req.query.full ? 'full' : 'dealer'));
    return res.json({ success: true, ...report, reconciliation, dealerCode: scope.dealerCode, auditId: scope.auditId });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message, reconciliation: error.reconciliation });
  }
}

async function summaryHandler(req, res) {
  try {
    const scope = await resolveScope(req);
    const report = await buildReconciliationReport({ ...req.query, dealerCode: scope.dealerCode, auditId: scope.auditId });
    const reconciliation = await require('./report').validateValuationReports(scope);
    return res.json({ success: true, dealerCode: scope.dealerCode, auditId: scope.auditId, summary: report.summary, reconciliation });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function movementAnalysisHandler(req, res) {
  try {
    const scope = await resolveScope(req);
    const analysis = await buildMovementAnalysisReport({ ...req.query, dealerCode: scope.dealerCode, auditId: scope.auditId });
    const reconciliation = await require('./report').validateValuationReports(scope);
    if (req.query.format) return sendMovementAnalysisExport(res, analysis, req.query.format);
    return res.json({ success: true, ...analysis, reconciliation, dealerCode: scope.dealerCode, auditId: scope.auditId });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message, reconciliation: error.reconciliation });
  }
}

function exportHandler(format) {
  return async (req, res) => {
    try {
      const scope = await resolveScope(req);
      const report = await buildReconciliationReport({ ...req.query, dealerCode: scope.dealerCode, auditId: scope.auditId });
      await require('./report').validateValuationReports(scope);
      return sendReportExport(res, report, format, req.query.report || (req.query.full ? 'full' : 'dealer'));
    } catch (error) {
      return res.status(error.statusCode || 500).json({ success: false, message: error.message, reconciliation: error.reconciliation });
    }
  };
}

router.post(['/upload-stock', '/upload'], auth.requireAuth, auth.requireAdmin, upload.single('file'), uploadDealerStockHandler);
router.get(['/stock-preview', '/preview/:dealerCode/:auditId'], auth.requireAuth, previewDealerStockHandler);
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
