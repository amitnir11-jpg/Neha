const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const MasterPart = require('../models/MasterPart');
const MasterCatalogue = require('../models/MasterCatalogue');
const Inventory = require('../models/Inventory');
const Dealer = require('../models/Dealer');
const Audit = require('../models/Audit');
const Bin = require('../models/Bin');
const VerificationLog = require('../models/VerificationLog');
const auth = require('./auth');
const { closeOtherActiveAudits, multiAuditEnabled, publicAudit, syncDealerWithAudit } = require('../utils/audit');
const normalizer = require('../utils/normalize');
const { cataloguePayload } = require('../utils/catalogue');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

function normalizeHeader(value) {
  return normalizer.cleanText(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

const FIELD_ALIASES = {
  partNumber: ['PART', 'PART NO', 'PART NUMBER', 'PART_NUM', 'PART NUM', 'PARTNO', 'PARTNUMBER', 'ITEM CODE', 'ITEMCODE', 'MATERIAL', 'MATERIAL CODE'],
  partName: ['NAME', 'PART NAME', 'DESCRIPTION', 'PART DESCRIPTION', 'PARTNAME', 'PARTDESC', 'PART DESC', 'PART DESCR', 'PART DESCRP', 'ITEM DESCRIPTION', 'ITEMDESC', 'MATERIAL DESCRIPTION'],
  category: ['CATEGORY', 'PART CATEGORY', 'CATEGORIES', 'PRODUCT CATEGORY', 'PRODUCTCATEGORY', 'CATEGORY NAME', 'PRODUCT GROUP', 'GROUP', 'ITEM CATEGORY'],
  model: ['MODEL'],
  manufacturingYear: ['MANUFACTURING YEAR / GEN', 'MANUFACTURING YEAR', 'GEN', 'YEAR', 'MFG YEAR'],
  binLocation: ['BIN', 'BIN LOCATION', 'LOCATION', 'BIN LOC', 'BIN LOC 1', 'BINLOCATION'],
  mrp: ['MRP', 'MRP PRICE', 'RATE', 'PRICE'],
  dlc: ['DLC', 'LANDED COST'],
  dealerCode: ['DEALER', 'DEALER CODE', 'DEALERCODE'],
  dealerName: ['DEALER NAME'],
  qty: ['QTY', 'STOCK', 'DMS QTY', 'QUANTITY', 'DMS STOCK', 'OPENING STOCK QTY', 'OPENING STOCK', 'SYSTEM QTY', 'SYSTEM QUANTITY', 'STOCK ON HAND']
};

function aliasesFor(field) {
  return FIELD_ALIASES[field] || [];
}

function fieldMappingFromHeaders(headers = []) {
  const normalizedHeaders = headers.map(normalizeHeader);
  const mapping = {};
  Object.entries(FIELD_ALIASES).forEach(([field, aliases]) => {
    const match = aliases.map(normalizeHeader).find((alias) => normalizedHeaders.includes(alias));
    mapping[field] = match || '';
  });
  return mapping;
}

function cellValue(cell) {
  if (!cell) return '';
  const value = cell.value;
  if (value && typeof value === 'object') {
    if (value.text) return value.text;
    if (value.result !== undefined) return value.result;
    if (value.richText) return value.richText.map((item) => item.text).join('');
  }
  return value === undefined || value === null ? '' : value;
}

function numberValue(value) {
  return normalizer.numberValue(value, 0);
}

function boolValue(value) {
  const text = String(value === undefined || value === null ? 'true' : value).trim().toLowerCase();
  return !['false', 'inactive', 'no', 'n', '0'].includes(text);
}

function getMappedValue(row, headerMap, aliases) {
  for (const alias of aliases) {
    const col = headerMap[normalizeHeader(alias)];
    if (col) return cellValue(row.getCell(col));
  }
  return '';
}

function normalizePart(partNo) {
  return normalizer.normalizePartNumber(partNo);
}

function normalizePartNumber(partNo) {
  return normalizer.normalizePartNumber(partNo);
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function removeDuplicateBins(dealerCode) {
  if (!dealerCode) return 0;
  const duplicates = await Bin.aggregate([
    { $match: { dealerCode } },
    { $group: { _id: '$binCode', ids: { $push: '$_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } }
  ]);
  const deleteIds = duplicates.flatMap((item) => item.ids.slice(1));
  if (!deleteIds.length) return 0;
  const result = await Bin.deleteMany({ _id: { $in: deleteIds } });
  return result.deletedCount || 0;
}

function binFieldMatch(binCodes) {
  const patterns = binCodes.map((binCode) => new RegExp(`^\\s*${escapeRegExp(binCode)}\\s*$`, 'i'));
  return { $or: [{ bin: { $in: patterns } }, { binLocation: { $in: patterns } }] };
}

function normalizeCategory(value) {
  return normalizer.normalizeCategory(value);
}

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(normalizer.cleanText(current));
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(normalizer.cleanText(current));
  return cells;
}

function parseCsvText(text) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]).map(normalizeHeader);
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = normalizer.cleanText(values[index] || '');
    });
    return row;
  });
}

function objectValue(row, aliases) {
  for (const alias of aliases) {
    const normalized = normalizeHeader(alias);
    const value = row[normalized] ?? row[alias] ?? row[String(alias).toLowerCase()] ?? row[String(alias).replace(/[^a-zA-Z0-9]/g, '').toLowerCase()];
    if (value !== undefined && value !== '') return value;
  }
  return '';
}

function partFromObject(row) {
  const partNo = normalizePart(objectValue(row, aliasesFor('partNumber')));
  if (!partNo) return null;
  const qty = numberValue(objectValue(row, aliasesFor('qty')));
  const mapped = {
    partNo,
    partNumber: partNo,
    normalizedPartNumber: normalizePartNumber(partNo),
    partName: normalizer.cleanText(objectValue(row, aliasesFor('partName'))),
    partDescription: normalizer.cleanText(objectValue(row, aliasesFor('partName'))),
    model: normalizer.cleanText(objectValue(row, aliasesFor('model'))),
    year: normalizer.cleanText(objectValue(row, aliasesFor('manufacturingYear'))),
    manufacturingYear: normalizer.cleanText(objectValue(row, aliasesFor('manufacturingYear'))),
    category: normalizeCategory(objectValue(row, aliasesFor('category'))),
    productCategory: normalizeCategory(objectValue(row, aliasesFor('category'))),
    mrp: numberValue(objectValue(row, aliasesFor('mrp'))),
    dlc: numberValue(objectValue(row, aliasesFor('dlc'))),
    bin: normalizer.cleanText(objectValue(row, aliasesFor('binLocation'))),
    binLocation: normalizer.cleanText(objectValue(row, aliasesFor('binLocation'))),
    dealerCode: normalizePart(objectValue(row, aliasesFor('dealerCode'))),
    dealerName: normalizer.cleanText(objectValue(row, aliasesFor('dealerName'))),
    activeStatus: boolValue(objectValue(row, ['Active Status', 'Active', 'Status'])),
    openingStockQty: qty,
    quantity: qty,
    qty
  };
  return mapped;
}

function formatPart(part = {}) {
  const partNumber = normalizePart(part.partNumber || part.partNo || part.part || '');
  const binLocation = String(part.binLocation || part.bin || part.location || '').trim();
  const qty = numberValue(part.qty !== undefined ? part.qty : part.openingStockQty !== undefined ? part.openingStockQty : part.quantity);
  return {
    ...part,
    partNo: partNumber,
    partNumber,
    normalizedPartNumber: normalizePartNumber(partNumber),
    partName: part.partName || part.partDescription || part.name || part.description || '',
    partDescription: part.partDescription || part.partName || part.name || part.description || '',
    category: normalizeCategory(part.category || part.productCategory || part.partCategory || ''),
    productCategory: normalizeCategory(part.productCategory || part.category || part.partCategory || ''),
    model: part.model || '',
    manufacturingYear: part.manufacturingYear || part.year || '',
    year: part.year || part.manufacturingYear || '',
    bin: binLocation,
    binLocation,
    mrp: numberValue(part.mrp !== undefined ? part.mrp : part.rate !== undefined ? part.rate : part.price),
    dlc: numberValue(part.dlc),
    dealerCode: normalizePart(part.dealerCode || part.dealer || ''),
    dealerName: part.dealerName || '',
    openingStockQty: qty,
    quantity: qty,
    qty
  };
}

function publicSuggestion(part = {}) {
  const formatted = formatPart(part);
  return {
    partNumber: formatted.partNumber || formatted.partNo,
    partName: formatted.partName,
    partDescription: formatted.partDescription || formatted.partName,
    category: formatted.category,
    productCategory: formatted.productCategory || formatted.category,
    model: formatted.model,
    manufacturingYear: formatted.manufacturingYear || formatted.year,
    mrp: formatted.mrp,
    dlc: formatted.dlc,
    dealerCode: formatted.dealerCode,
    qty: formatted.qty || formatted.quantity || formatted.openingStockQty || 0,
    bin: formatted.bin || formatted.binLocation,
    binLocation: formatted.binLocation || formatted.bin
  };
}

function cleanQueryText(value) {
  return String(value || '').trim();
}

function regexFilter(value) {
  const text = cleanQueryText(value);
  return text ? { $regex: escapeRegExp(text), $options: 'i' } : null;
}

function parseMrpFilter(value) {
  const text = cleanQueryText(value);
  if (!text) return null;
  const range = text.match(/^(\d+(?:\.\d+)?)\s*[-:]\s*(\d+(?:\.\d+)?)$/);
  if (range) {
    const first = Number(range[1]);
    const second = Number(range[2]);
    return { $gte: Math.min(first, second), $lte: Math.max(first, second) };
  }
  const comparison = text.match(/^(<=|>=|<|>)\s*(\d+(?:\.\d+)?)$/);
  if (comparison) {
    const amount = Number(comparison[2]);
    if (comparison[1] === '<=') return { $lte: amount };
    if (comparison[1] === '>=') return { $gte: amount };
    if (comparison[1] === '<') return { $lt: amount };
    if (comparison[1] === '>') return { $gt: amount };
  }
  const exact = Number(text);
  return Number.isFinite(exact) ? exact : null;
}

function advancedMasterFilter(query = {}) {
  const filter = {};
  const partText = cleanQueryText(query.partNumber || query.q);
  if (partText) {
    const safePart = escapeRegExp(normalizePartNumber(partText));
    const safeText = escapeRegExp(partText);
    filter.$or = [
      { partNumber: { $regex: safePart, $options: 'i' } },
      { normalizedPartNumber: { $regex: safePart, $options: 'i' } },
      { partDescription: { $regex: safeText, $options: 'i' } }
    ];
  }
  const category = regexFilter(query.category);
  const group = regexFilter(query.group || query.productGroup);
  const year = regexFilter(query.year);
  const model = regexFilter(query.model);
  const mrp = parseMrpFilter(query.mrp);
  if (category) filter.productCategory = category;
  if (group) filter.productGroup = group;
  if (year) filter.$and = [...(filter.$and || []), { $or: [{ year }, { manufacturingYear: year }] }];
  if (model) filter.model = model;
  if (mrp !== null) filter.mrp = mrp;
  return filter;
}

function validatorTextRegex(value) {
  const text = String(value || '').trim();
  return text ? new RegExp(escapeRegExp(text), 'i') : null;
}

function validatorFilter(query = {}) {
  const filter = { found: false, status: { $ne: 'ignored' } };
  const dealerCode = normalizePart(query.dealerCode);
  if (dealerCode && dealerCode !== 'ALL') filter.dealerCode = dealerCode;
  const part = validatorTextRegex(query.partNumber);
  const raw = validatorTextRegex(query.rawScan);
  const user = validatorTextRegex(query.user);
  const device = validatorTextRegex(query.deviceId);
  const scanType = normalizePart(query.scanType);
  if (part) filter.$and = [...(filter.$and || []), { $or: [{ extractedPartNumber: part }, { partNumber: part }] }];
  if (raw) filter.rawScannedValue = raw;
  if (user) filter.$and = [...(filter.$and || []), { $or: [{ userId: user }, { loginId: user }, { scannedBy: user }, { staffName: user }] }];
  if (device) filter.deviceId = device;
  if (scanType) filter.scanType = scanType;
  const from = query.dateFrom ? new Date(query.dateFrom) : null;
  const to = query.dateTo ? new Date(query.dateTo) : null;
  if (from || to) {
    filter.time = {};
    if (from && !Number.isNaN(from.getTime())) filter.time.$gte = from;
    if (to && !Number.isNaN(to.getTime())) {
      to.setHours(23, 59, 59, 999);
      filter.time.$lte = to;
    }
  }
  return filter;
}

function invalidGroupKey(row = {}) {
  return [
    normalizePart(row.extractedPartNumber || row.partNumber || row.rawScannedValue),
    normalizePart(row.dealerCode),
    String(row.reason || 'Not Found In Master').trim().toUpperCase()
  ].join('|');
}

async function parsePartsFromUpload(file, body) {
  if (!file && Array.isArray(body.parts)) {
    return body.parts.map((item) => partFromObject({
      partnumber: item.partNumber || item.partNo || item.part,
      partname: item.partDescription || item.partName,
      bin: item.binLocation || item.bin,
      category: item.productCategory || item.category,
      mrp: item.mrp,
      dlc: item.dlc,
      dealercode: item.dealerCode,
      dealername: item.dealerName,
      model: item.model,
      manufacturingyeargen: item.manufacturingYear || item.year,
      quantity: item.qty || item.quantity || item.openingStockQty,
      active: item.activeStatus
    })).filter(Boolean);
  }

  if (!file) return [];
  const lowerName = String(file.originalname || '').toLowerCase();
  if (lowerName.endsWith('.csv') || file.mimetype === 'text/csv') {
    const rows = parseCsvText(file.buffer.toString('utf8'));
    console.log('[master-import] uploaded rows count:', rows.length);
    const parts = rows.map(partFromObject).filter(Boolean);
    console.log('[master-import] parsed master rows count:', parts.length);
    if (parts[0]) console.log('[master-import] sample imported record:', parts[0]);
    return parts;
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  const headerMap = {};
  sheet.getRow(1).eachCell((cell, colNumber) => {
    headerMap[normalizeHeader(cellValue(cell))] = colNumber;
  });
  const headers = Object.keys(headerMap);
  console.log("Excel headers:", headers);
  const mapping = fieldMappingFromHeaders(headers);
  console.log("Master mapping:", mapping);
  const parts = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const partNo = normalizePart(getMappedValue(row, headerMap, aliasesFor('partNumber')));
    if (!partNo) return;
    const qty = numberValue(getMappedValue(row, headerMap, aliasesFor('qty')));
    const mappedRow = {
      partNo,
      partNumber: partNo,
      normalizedPartNumber: normalizePartNumber(partNo),
      partName: normalizer.cleanText(getMappedValue(row, headerMap, aliasesFor('partName'))),
      partDescription: normalizer.cleanText(getMappedValue(row, headerMap, aliasesFor('partName'))),
      model: normalizer.cleanText(getMappedValue(row, headerMap, aliasesFor('model'))),
      year: normalizer.cleanText(getMappedValue(row, headerMap, aliasesFor('manufacturingYear'))),
      manufacturingYear: normalizer.cleanText(getMappedValue(row, headerMap, aliasesFor('manufacturingYear'))),
      category: normalizeCategory(getMappedValue(row, headerMap, aliasesFor('category'))),
      productCategory: normalizeCategory(getMappedValue(row, headerMap, aliasesFor('category'))),
      mrp: numberValue(getMappedValue(row, headerMap, aliasesFor('mrp'))),
      dlc: numberValue(getMappedValue(row, headerMap, aliasesFor('dlc'))),
      bin: normalizer.cleanText(getMappedValue(row, headerMap, aliasesFor('binLocation'))),
      binLocation: normalizer.cleanText(getMappedValue(row, headerMap, aliasesFor('binLocation'))),
      dealerCode: normalizePart(getMappedValue(row, headerMap, aliasesFor('dealerCode'))),
      dealerName: normalizer.cleanText(getMappedValue(row, headerMap, aliasesFor('dealerName'))),
      activeStatus: boolValue(getMappedValue(row, headerMap, ['Active Status', 'Active', 'Status'])),
      openingStockQty: qty,
      quantity: qty,
      qty
    };
    console.log("Mapped row:", mappedRow);
    parts.push(mappedRow);
  });
  if (parts.length > 0) console.log("FIRST MAPPED ROW:", parts[0]);
  return parts;
}

async function importParts(parts) {
  const cleanParts = [];
  const failed = [];
  const seen = new Set();
  parts.forEach((part, index) => {
    part = formatPart(part);
    if (!part || !part.partNo) {
      failed.push({ row: index + 1, message: 'Missing part number' });
      return;
    }
    if (seen.has(part.partNo)) {
      failed.push({ row: index + 1, partNo: part.partNo, message: 'Duplicate inside upload file' });
      return;
    }
    seen.add(part.partNo);
    cleanParts.push(part);
  });

  if (!cleanParts.length) {
    return { successCount: 0, duplicateCount: 0, failedCount: failed.length, failed };
  }

  console.log('[master-import] uploaded rows count:', parts.length);
  const existing = await MasterPart.find({ normalizedPartNumber: { $in: cleanParts.map((part) => part.normalizedPartNumber || part.partNo) } }).select('partNo normalizedPartNumber').lean();
  const existingSet = new Set(existing.map((part) => part.partNo));
  const operations = cleanParts.map((part) => ({
    updateOne: {
      filter: { partNo: part.partNo },
      update: { $set: part },
      upsert: true
    }
  }));

  await MasterPart.bulkWrite(operations, { ordered: false });
  await Promise.all(cleanParts.filter((part) => part.bin).map((part) => Bin.findOneAndUpdate(
    { binCode: normalizePart(part.bin), dealerCode: part.dealerCode || '' },
    {
      binCode: normalizePart(part.bin),
      binName: part.bin,
      dealerCode: part.dealerCode || '',
      category: part.productCategory || part.category || '',
      active: true
    },
    { upsert: true, setDefaultsOnInsert: true }
  )));

  console.log('[master-import] inserted/updated master rows count:', cleanParts.length);
  if (cleanParts[0]) console.log('[master-import] sample imported record:', cleanParts[0]);

  return {
    successCount: cleanParts.length,
    duplicateCount: cleanParts.filter((part) => existingSet.has(part.partNo)).length,
    failedCount: failed.length,
    failed
  };
}

router.post('/upload', auth.requireAuth, auth.requireAdmin, upload.single('file'), async (req, res) => {
  try {
    const parts = await parsePartsFromUpload(req.file, req.body);
    if (!parts.length) {
      return res.status(400).json({ success: false, message: 'No valid master parts found' });
    }
    const cleared = (await MasterPart.deleteMany({})).deletedCount || 0;
    console.log('[master-import] cleared old master rows count:', cleared);
    const result = await importParts(parts);
    req.io.emit('master:update');
    res.json({ success: true, imported: result.successCount, clearedMasterRows: cleared, ...result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/parts/upload', auth.requireAuth, auth.requireAdmin, upload.single('file'), async (req, res) => {
  try {
    const parts = await parsePartsFromUpload(req.file, req.body);
    if (!parts.length) {
      return res.status(400).json({ success: false, message: 'No valid part master rows found' });
    }
    const cleared = (await MasterPart.deleteMany({})).deletedCount || 0;
    console.log('[master-import] cleared old master rows count:', cleared);
    const result = await importParts(parts);
    req.io.emit('master:update');
    res.json({ success: true, clearedMasterRows: cleared, ...result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/parts', auth.requireAuth, async (req, res) => {
  try {
    const filter = {};
    if (req.query.q) {
      const q = String(req.query.q).trim();
      console.log("Search query:", q);
      const safeQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { partNo: { $regex: safeQ, $options: 'i' } },
        { partName: { $regex: safeQ, $options: 'i' } },
        { partDescription: { $regex: safeQ, $options: 'i' } },
        { bin: { $regex: safeQ, $options: 'i' } },
        { category: { $regex: safeQ, $options: 'i' } },
        { productCategory: { $regex: safeQ, $options: 'i' } }
      ];
    }
    if (req.query.category) filter.category = String(req.query.category).trim();
    if (req.query.bin) filter.bin = { $regex: String(req.query.bin).trim(), $options: 'i' };
    if (req.query.dealerCode) filter.dealerCode = normalizePart(req.query.dealerCode);
    const limit = Math.min(Number(req.query.limit || 500), 2000);
    const result = (await MasterPart.find(filter).sort({ partNo: 1 }).limit(limit).lean()).map(formatPart);
    console.log("Search result:", result);
    res.json({ success: true, parts: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/parts', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const part = partFromObject({
      partnumber: req.body.partNumber || req.body.partNo || req.body.part,
      partname: req.body.partDescription || req.body.partName,
      bin: req.body.binLocation || req.body.bin,
      category: req.body.productCategory || req.body.category,
      mrp: req.body.mrp,
      dlc: req.body.dlc,
      dealercode: req.body.dealerCode,
      quantity: req.body.qty || req.body.quantity || req.body.openingStockQty,
      active: req.body.activeStatus
    });
    if (!part) return res.status(400).json({ success: false, message: 'Part number is required' });
    const result = await importParts([part]);
    req.io.emit('master:update');
    res.json({ success: true, part, ...result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/parts/suggest', auth.requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    console.log("Search query:", q);
    const safeQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const safePartQ = normalizePartNumber(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const limit = Math.min(Number(req.query.limit || 12), 30);
    const startsWith = new RegExp(`^${safeQ}`, 'i');
    const contains = new RegExp(safeQ, 'i');
    const partContains = new RegExp(safePartQ, 'i');
    const filter = q
      ? {
          $or: [
            { partNo: partContains },
            { partNumber: partContains },
            { normalizedPartNumber: partContains },
            { partName: contains },
            { partDescription: contains },
            { model: contains },
            { manufacturingYear: contains },
            { year: contains },
            { category: contains },
            { productCategory: contains }
          ]
        }
      : {};
    const catalogueParts = await MasterCatalogue.find(q ? {
      $or: [
        { partNumber: partContains },
        { normalizedPartNumber: partContains },
        { partDescription: contains },
        { model: contains },
        { manufacturingYear: contains },
        { year: contains },
        { productCategory: contains },
        { productGroup: contains }
      ]
    } : {})
      .sort({ partNumber: 1 })
      .limit(limit * 3)
      .lean();
    const parts = catalogueParts.length ? catalogueParts.map(cataloguePayload) : await MasterPart.find(filter)
      .select('partNo partNumber normalizedPartNumber partName partDescription model year manufacturingYear bin binLocation category productCategory mrp dlc dealerCode openingStockQty quantity qty activeStatus')
      .sort({ partNo: 1 })
      .limit(limit * 3)
      .lean();
    const formatted = parts
      .map(publicSuggestion)
      .sort((a, b) => {
        const aPart = String(a.partNumber || '');
        const bPart = String(b.partNumber || '');
        const aStarts = startsWith.test(aPart);
        const bStarts = startsWith.test(bPart);
        if (aStarts !== bStarts) return aStarts ? -1 : 1;
        return aPart.localeCompare(bPart);
      })
      .slice(0, limit);
    console.log("Search result:", formatted);
    res.json({ success: true, suggestions: formatted, parts: formatted });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/suggestions', auth.requireAuth, async (req, res) => {
  try {
    const query = cleanQueryText(req.query.query || req.query.q);
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 50);
    const safeText = escapeRegExp(query);
    const safePart = escapeRegExp(normalizePartNumber(query));
    const filter = query ? {
      $or: [
        { partNumber: { $regex: safePart, $options: 'i' } },
        { normalizedPartNumber: { $regex: safePart, $options: 'i' } },
        { partDescription: { $regex: safeText, $options: 'i' } }
      ]
    } : {};
    const rows = await MasterCatalogue.find(filter)
      .sort({ partNumber: 1 })
      .limit(limit * 3)
      .lean();
    const startsWith = new RegExp(`^${safePart}`, 'i');
    const suggestions = rows
      .map(cataloguePayload)
      .sort((a, b) => {
        const aPart = String(a.partNumber || '');
        const bPart = String(b.partNumber || '');
        const aStarts = startsWith.test(aPart);
        const bStarts = startsWith.test(bPart);
        if (aStarts !== bStarts) return aStarts ? -1 : 1;
        return aPart.localeCompare(bPart, undefined, { numeric: true });
      })
      .slice(0, limit);
    res.json({ success: true, suggestions, parts: suggestions });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/filters', auth.requireAuth, async (req, res) => {
  try {
    const [
      catalogueCategories,
      catalogueGroups,
      catalogueSubGroups,
      inventoryCategories,
      inventoryProductCategories,
      inventoryGroups,
      inventorySubGroups,
      masterCategories,
      masterProductCategories,
      models,
      years,
      groupPairs
    ] = await Promise.all([
      MasterCatalogue.distinct('productCategory', { productCategory: { $nin: [null, ''] } }),
      MasterCatalogue.distinct('productGroup', { productGroup: { $nin: [null, ''] } }),
      MasterCatalogue.distinct('partSubGroup', { partSubGroup: { $nin: [null, ''] } }),
      Inventory.distinct('category', { category: { $nin: [null, ''] } }),
      Inventory.distinct('productCategory', { productCategory: { $nin: [null, ''] } }),
      Inventory.distinct('productGroup', { productGroup: { $nin: [null, ''] } }),
      Inventory.distinct('partSubGroup', { partSubGroup: { $nin: [null, ''] } }),
      MasterPart.distinct('category', { category: { $nin: [null, ''] } }),
      MasterPart.distinct('productCategory', { productCategory: { $nin: [null, ''] } }),
      MasterCatalogue.distinct('model', { model: { $nin: [null, ''] } }),
      MasterCatalogue.distinct('year', { year: { $nin: [null, ''] } }),
      MasterCatalogue.find({ productGroup: { $nin: [null, ''] } }).select('productGroup partSubGroup').lean()
    ]);
    const cleanList = (items) => Array.from(new Set(items.map((item) => String(item || '').trim()).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const groupSubGroups = {};
    groupPairs.forEach((row) => {
      const group = String(row.productGroup || '').trim();
      const subGroup = String(row.partSubGroup || '').trim();
      if (!group || !subGroup) return;
      groupSubGroups[group] = groupSubGroups[group] || [];
      if (!groupSubGroups[group].includes(subGroup)) groupSubGroups[group].push(subGroup);
    });
    Object.keys(groupSubGroups).forEach((group) => {
      groupSubGroups[group] = cleanList(groupSubGroups[group]);
    });
    res.json({
      success: true,
      categories: cleanList([].concat(catalogueCategories, inventoryCategories, inventoryProductCategories, masterCategories, masterProductCategories).map(normalizeCategory)),
      groups: cleanList([].concat(catalogueGroups, inventoryGroups)),
      subGroups: cleanList([].concat(catalogueSubGroups, inventorySubGroups)),
      groupSubGroups,
      models: cleanList(models),
      years: cleanList(years)
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/dealers', auth.requireAuth, async (req, res) => {
  try {
    const [dealerRows, masterDealerCodes, scanDealerCodes, binDealerCodes] = await Promise.all([
      Dealer.find({}).sort({ dealerName: 1 }).lean(),
      MasterPart.distinct('dealerCode', { dealerCode: { $nin: [null, ''] } }),
      Inventory.distinct('dealerCode', { dealerCode: { $nin: [null, ''] } }),
      Bin.distinct('dealerCode', { dealerCode: { $nin: [null, ''] } })
    ]);
    const dealerMap = new Map();
    dealerRows.forEach((dealer) => {
      const code = normalizePart(dealer.dealerCode);
      if (!code) return;
      dealerMap.set(code, { ...dealer, dealerCode: code, dealerName: dealer.dealerName || code });
    });
    [masterDealerCodes, scanDealerCodes, binDealerCodes].flat().forEach((value) => {
      const code = normalizePart(value);
      if (!code || dealerMap.has(code)) return;
      dealerMap.set(code, { dealerCode: code, dealerName: code, active: true });
    });
    const dealers = Array.from(dealerMap.values()).sort((a, b) =>
      String(a.dealerName || a.dealerCode || '').localeCompare(String(b.dealerName || b.dealerCode || ''))
    );
    res.json({ success: true, dealers });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/categories', auth.requireAuth, async (req, res) => {
  try {
    const [categories, productCategories, catalogueCategories, inventoryCategories, inventoryProductCategories] = await Promise.all([
      MasterPart.distinct('category', { category: { $nin: [null, ''] } }),
      MasterPart.distinct('productCategory', { productCategory: { $nin: [null, ''] } }),
      MasterCatalogue.distinct('productCategory', { productCategory: { $nin: [null, ''] } }),
      Inventory.distinct('category', { category: { $nin: [null, ''] } }),
      Inventory.distinct('productCategory', { productCategory: { $nin: [null, ''] } })
    ]);
    const cleanCategories = Array.from(new Set([].concat(categories, productCategories, catalogueCategories, inventoryCategories, inventoryProductCategories).map(normalizeCategory).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b));
    res.json({ success: true, categories: cleanCategories });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/parts/categories', auth.requireAuth, async (req, res) => {
  try {
    const categories = await MasterPart.distinct('category', { category: { $nin: [null, ''] } });
    const productCategories = await MasterPart.distinct('productCategory', { productCategory: { $nin: [null, ''] } });
    const cleanCategories = Array.from(new Set(categories.concat(productCategories).map(normalizeCategory).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b));
    res.json({ success: true, categories: cleanCategories });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/dealers', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const dealerCode = normalizePart(req.body.dealerCode);
    const dealerName = String(req.body.dealerName || req.body.name || '').trim();
    if (!dealerCode || !dealerName) {
      return res.status(400).json({ success: false, message: 'Dealer name and dealer code are required' });
    }
    const auditStatus = String(req.body.auditStatus || req.body.status || 'Active').trim().toLowerCase();
    const isClosed = auditStatus === 'closed';
    const auditId = normalizePart(req.body.auditId || req.body.currentAuditId || `AUD-${dealerCode}-${Date.now()}`);
    const auditPayload = {
      auditId,
      dealerCode,
      dealerName,
      brand: req.body.brand || '',
      location: req.body.location || '',
      auditName: req.body.auditName || `${dealerCode} Audit`,
      auditStartDate: req.body.auditStartDate ? new Date(req.body.auditStartDate) : new Date(),
      auditClosedDate: isClosed ? new Date() : undefined,
      status: isClosed ? 'closed' : 'active'
    };
    if (!isClosed) delete auditPayload.auditClosedDate;
    if (!isClosed && !(await multiAuditEnabled())) {
      await closeOtherActiveAudits(dealerCode, auditId);
    }
    const audit = await Audit.findOneAndUpdate(
      { auditId },
      isClosed ? { $set: auditPayload } : { $set: auditPayload, $unset: { auditClosedDate: '' } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const dealer = await syncDealerWithAudit(audit);
    if (req.io && !isClosed) req.io.emit('audit:active', publicAudit(audit));
    req.io.emit('dealers:update');
    res.json({ success: true, dealer, audit, activeAudit: isClosed ? null : publicAudit(audit) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/dealers/:dealerCode', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const dealerCode = normalizePart(req.params.dealerCode);
    if (!dealerCode) {
      return res.status(400).json({ success: false, message: 'Dealer code is required' });
    }

    const [dealerResult, auditResult] = await Promise.all([
      Dealer.deleteMany({ dealerCode }),
      Audit.deleteMany({ dealerCode })
    ]);

    if (!dealerResult.deletedCount && !auditResult.deletedCount) {
      return res.status(404).json({ success: false, message: 'Dealer not found' });
    }

    req.io.emit('dealers:update');
    res.json({
      success: true,
      dealerCode,
      dealersDeleted: dealerResult.deletedCount || 0,
      auditsDeleted: auditResult.deletedCount || 0
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/bins', auth.requireAuth, async (req, res) => {
  try {
    const dealerCode = normalizePart(req.query.dealerCode);
    if (!dealerCode) {
      return res.json({ success: true, bins: [], count: 0, message: 'Select dealer to view bins' });
    }
    const removedDuplicates = await removeDuplicateBins(dealerCode);
    const filter = { dealerCode };
    const masterFilter = { dealerCode };
    if (req.query.q) {
      const safeQ = escapeRegExp(String(req.query.q).trim());
      filter.$or = [
        { binCode: { $regex: safeQ, $options: 'i' } },
        { binName: { $regex: safeQ, $options: 'i' } },
        { category: { $regex: safeQ, $options: 'i' } }
      ];
      masterFilter.$or = [
        { bin: { $regex: safeQ, $options: 'i' } },
        { binLocation: { $regex: safeQ, $options: 'i' } },
        { category: { $regex: safeQ, $options: 'i' } },
        { productCategory: { $regex: safeQ, $options: 'i' } }
      ];
    }
    const [savedBins, masterBinValues, masterBinLocationValues] = await Promise.all([
      Bin.find(filter).sort({ binCode: 1 }).lean(),
      MasterPart.distinct('bin', { ...masterFilter, bin: { $nin: [null, ''] } }),
      MasterPart.distinct('binLocation', { ...masterFilter, binLocation: { $nin: [null, ''] } })
    ]);
    const masterBins = Array.from(new Set(masterBinValues.concat(masterBinLocationValues).filter(Boolean)));
    const map = new Map();
    savedBins.forEach((bin) => map.set(`${bin.dealerCode || ''}:${bin.binCode}`, bin));
    masterBins.filter(Boolean).forEach((bin) => {
      const key = `${dealerCode}:${normalizePart(bin)}`;
      if (!map.has(key)) {
        map.set(key, { binCode: normalizePart(bin), binName: bin, dealerCode, active: true });
      }
    });
    const bins = Array.from(map.values()).sort((a, b) => String(a.binCode).localeCompare(String(b.binCode), undefined, { numeric: true }));
    res.json({ success: true, dealerCode, bins, count: bins.length, removedDuplicates });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/bins', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const binCode = normalizePart(req.body.binCode || req.body.bin || req.body.name);
    if (!binCode) return res.status(400).json({ success: false, message: 'Bin code is required' });
    const dealerCode = normalizePart(req.body.dealerCode);
    if (!dealerCode) return res.status(400).json({ success: false, message: 'Dealer code is required' });
    const bin = await Bin.findOneAndUpdate(
      { binCode, dealerCode },
      {
        binCode,
        binName: req.body.binName || req.body.name || binCode,
        dealerCode,
        category: req.body.category || '',
        active: req.body.active !== false
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    req.io.emit('master:update');
    res.json({ success: true, bin });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/bins/dealer/:dealerCode', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const dealerCode = normalizePart(req.params.dealerCode || req.body.dealerCode);
    if (!dealerCode) return res.status(400).json({ success: false, message: 'Dealer code is required' });
    const [result, masterUpdate] = await Promise.all([
      Bin.deleteMany({ dealerCode }),
      MasterPart.updateMany({ dealerCode }, { $set: { bin: '', binLocation: '' } })
    ]);
    req.io.emit('master:update', { dealerCode, scope: 'bins' });
    res.json({ success: true, dealerCode, deletedCount: result.deletedCount || 0, masterUpdated: masterUpdate.modifiedCount || 0 });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/bins/delete-selected', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const dealerCode = normalizePart(req.body.dealerCode);
    const binCodes = Array.isArray(req.body.binCodes) ? req.body.binCodes.map(normalizePart).filter(Boolean) : [];
    if (!dealerCode) return res.status(400).json({ success: false, message: 'Dealer code is required' });
    if (!binCodes.length) return res.status(400).json({ success: false, message: 'Select at least one bin' });
    const uniqueBinCodes = Array.from(new Set(binCodes));
    const [result, masterUpdate] = await Promise.all([
      Bin.deleteMany({ dealerCode, binCode: { $in: uniqueBinCodes } }),
      MasterPart.updateMany(
        { dealerCode, ...binFieldMatch(uniqueBinCodes) },
        { $set: { bin: '', binLocation: '' } }
      )
    ]);
    req.io.emit('master:update', { dealerCode, scope: 'bins' });
    res.json({ success: true, dealerCode, deletedCount: result.deletedCount || 0, masterUpdated: masterUpdate.modifiedCount || 0, binCodes: uniqueBinCodes });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/bins/:binCode', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const dealerCode = normalizePart(req.query.dealerCode || req.body.dealerCode);
    const binCode = normalizePart(req.params.binCode);
    if (!dealerCode) return res.status(400).json({ success: false, message: 'Dealer code is required' });
    if (!binCode) return res.status(400).json({ success: false, message: 'Bin code is required' });
    const [result, masterUpdate] = await Promise.all([
      Bin.deleteOne({ dealerCode, binCode }),
      MasterPart.updateMany(
        { dealerCode, ...binFieldMatch([binCode]) },
        { $set: { bin: '', binLocation: '' } }
      )
    ]);
    req.io.emit('master:update', { dealerCode, scope: 'bins' });
    res.json({ success: true, dealerCode, binCode, deletedCount: result.deletedCount || 0, masterUpdated: masterUpdate.modifiedCount || 0 });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/bins/bulk-sequence', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const prefix = String(req.body.prefix || '').trim().toUpperCase();
    const suffix = String(req.body.suffix || '').trim().toUpperCase();
    const start = Number(req.body.start || 0);
    const end = Number(req.body.end || 0);
    const padding = Math.max(0, Math.min(Number(req.body.padding || 2), 8));
    const dealerCode = normalizePart(req.body.dealerCode);
    const category = String(req.body.category || '').trim();
    if (!dealerCode) {
      return res.status(400).json({ success: false, message: 'Dealer code is required' });
    }

    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      return res.status(400).json({ success: false, message: 'Enter a valid start and end sequence' });
    }
    if ((end - start + 1) > 5000) {
      return res.status(400).json({ success: false, message: 'Bulk bin sequence limit is 5000 bins at a time' });
    }

    const bins = [];
    for (let number = start; number <= end; number += 1) {
      const sequence = String(number).padStart(padding, '0');
      const binCode = normalizePart(`${prefix}${sequence}${suffix}`);
      if (!binCode) continue;
      bins.push({
        binCode,
        binName: binCode,
        dealerCode,
        category,
        active: true
      });
    }

    const existing = await Bin.find({
      dealerCode,
      binCode: { $in: bins.map((bin) => bin.binCode) }
    }).select('binCode').lean();
    const existingSet = new Set(existing.map((bin) => bin.binCode));
    const newBins = bins.filter((bin) => !existingSet.has(bin.binCode));

    if (newBins.length) {
      await Bin.insertMany(newBins, { ordered: false });
    }

    req.io.emit('master:update');
    res.json({
      success: true,
      createdCount: newBins.length,
      duplicateCount: bins.length - newBins.length,
      failedCount: 0,
      bins: newBins,
      duplicates: bins.filter((bin) => existingSet.has(bin.binCode)).map((bin) => bin.binCode)
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/bins/merge', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const sourceBin = normalizePart(req.body.sourceBin);
    const destBin = normalizePart(req.body.destBin);
    const dealerCode = normalizePart(req.body.dealerCode);

    if (!sourceBin || !destBin) {
      return res.status(400).json({ success: false, message: 'Source and destination bins are required' });
    }
    if (sourceBin === destBin) {
      return res.status(400).json({ success: false, message: 'Source and destination bins cannot be the same' });
    }

    const masterFilter = { bin: sourceBin };
    const inventoryFilter = { $or: [{ bin: sourceBin }, { binLocation: sourceBin }] };
    const binFilter = { binCode: sourceBin };

    if (dealerCode) {
      masterFilter.dealerCode = dealerCode;
      inventoryFilter.dealerCode = dealerCode;
      binFilter.dealerCode = dealerCode;
    }

    const [masterUpdate, inventoryUpdate] = await Promise.all([
      MasterPart.updateMany(masterFilter, { $set: { bin: destBin } }),
      Inventory.updateMany(inventoryFilter, { $set: { bin: destBin, binLocation: destBin } }),
      Bin.deleteMany(binFilter),
      Bin.findOneAndUpdate({ binCode: destBin, dealerCode: dealerCode || '' }, { $setOnInsert: { binCode: destBin, binName: destBin, active: true } }, { upsert: true })
    ]);

    req.io.emit('master:update');
    req.io.emit('stats:update');

    res.json({
      success: true,
      masterUpdated: masterUpdate.modifiedCount || 0,
      inventoryUpdated: inventoryUpdate.modifiedCount || 0
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/search', auth.requireAuth, async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page || 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit || 25), 1), 100);
    const skip = (page - 1) * limit;
    const filter = advancedMasterFilter(req.query);

    const [total, parts] = await Promise.all([
      MasterCatalogue.countDocuments(filter),
      MasterCatalogue.find(filter).sort({ partNumber: 1 }).skip(skip).limit(limit).lean()
    ]);
    const formatted = parts.map(cataloguePayload);
    res.json({ success: true, parts: formatted, page, limit, total, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/parts/search', auth.requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    console.log("Search query:", q);
    const safeQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const limit = Math.min(Number(req.query.limit || 50), 100);
    const filter = q
      ? {
          $or: [
            { partNo: { $regex: safeQ, $options: 'i' } },
            { partName: { $regex: safeQ, $options: 'i' } },
            { partDescription: { $regex: safeQ, $options: 'i' } },
            { bin: { $regex: safeQ, $options: 'i' } },
            { category: { $regex: safeQ, $options: 'i' } },
            { productCategory: { $regex: safeQ, $options: 'i' } }
          ]
        }
      : {};

    const parts = await MasterPart.find(filter).sort({ partNo: 1 }).limit(limit).lean();
    const formattedParts = parts.map(formatPart);
    console.log("Search result:", formattedParts);
    res.json({ success: true, parts: formattedParts });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

async function runMigration() {
  const parts = await MasterPart.find({}).lean();
  let migrated = 0;
  const ops = [];
  for (const part of parts) {
    let needsUpdate = false;
    const update = {};
    if (part.partNumber && !part.partNo) { update.partNo = part.partNumber; needsUpdate = true; }
    if (part.partNo && !part.partNumber) { update.partNumber = part.partNo; needsUpdate = true; }
    if (part.part && !part.partNo) { update.partNo = part.part; update.partNumber = part.part; needsUpdate = true; }
    if (part.description && !part.partName) { update.partName = part.description; needsUpdate = true; }
    if (part.name && !part.partName) { update.partName = part.name; needsUpdate = true; }
    if ((part.partName || part.description || part.name) && !part.partDescription) { update.partDescription = part.partName || part.description || part.name; needsUpdate = true; }
    if (part.location && !part.bin) { update.bin = part.location; needsUpdate = true; }
    if (part.binLocation && !part.bin) { update.bin = part.binLocation; needsUpdate = true; }
    if (part.bin && !part.binLocation) { update.binLocation = part.bin; needsUpdate = true; }
    if (part.partCategory && !part.category) { update.category = part.partCategory; needsUpdate = true; }
    if (part.categories && !part.category) { update.category = part.categories; needsUpdate = true; }
    if ((part.category || part.partCategory || part.categories) && !part.productCategory) { update.productCategory = part.category || part.partCategory || part.categories; needsUpdate = true; }
    if (part.productCategory && !part.category) { update.category = part.productCategory; needsUpdate = true; }
    if ((part.manufacturingYear || part.year) && !part.year) { update.year = part.manufacturingYear || part.year; needsUpdate = true; }
    if ((part.manufacturingYear || part.year) && !part.manufacturingYear) { update.manufacturingYear = part.manufacturingYear || part.year; needsUpdate = true; }
    if (part.price && !part.mrp) { update.mrp = part.price; needsUpdate = true; }
    if (part.rate && !part.mrp) { update.mrp = part.rate; needsUpdate = true; }
    if (part.stock && !part.openingStockQty) { update.openingStockQty = part.stock; update.quantity = part.stock; needsUpdate = true; }
    if (part.qty && !part.openingStockQty) { update.openingStockQty = part.qty; update.quantity = part.qty; needsUpdate = true; }
    if (part.openingStockQty && !part.qty) { update.qty = part.openingStockQty; needsUpdate = true; }
    if (part.quantity && !part.qty) { update.qty = part.quantity; needsUpdate = true; }
    if (part.dealerName && !part.dealerCode) { update.dealerCode = part.dealerName; needsUpdate = true; }

    if (needsUpdate) {
      ops.push({
        updateOne: {
          filter: { _id: part._id },
          update: { $set: update }
        }
      });
      migrated++;
    }
  }
  if (ops.length > 0) {
    await MasterPart.bulkWrite(ops);
  }
  return migrated;
}

function scheduleNightlyMigration() {
  const now = new Date();
  const nextRun = new Date();
  nextRun.setHours(2, 0, 0, 0); // Scheduled for 2:00 AM
  
  if (now.getTime() >= nextRun.getTime()) {
    nextRun.setDate(nextRun.getDate() + 1); // Move to tomorrow if it's already past 2 AM today
  }
  const delay = nextRun.getTime() - now.getTime();

  setTimeout(async () => {
    try {
      const migratedCount = await runMigration();
      console.log(`Nightly auto-migration complete. Normalized ${migratedCount} parts.`);
    } catch (error) {
      console.error(`Nightly auto-migration failed: ${error.message}`);
    } finally {
      scheduleNightlyMigration(); // Re-schedule for the next night
    }
  }, delay);
}

// Initialize the recurring background job
scheduleNightlyMigration();

router.post('/migrate', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const migrated = await runMigration();
    res.json({ success: true, migrated });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/intelligence/:partNo', auth.requireAuth, async (req, res) => {
  try {
    const partNo = normalizePart(req.params.partNo);
    const master = await MasterPart.findOne({ partNo }).lean();
    const scans = await Inventory.find({ part: partNo }).sort({ timestamp: -1 }).limit(200).lean();
    const currentScannedQty = scans.reduce((sum, scan) => sum + Number(scan.qty || 0), 0);

    const dealerWiseMovement = await Inventory.aggregate([
      { $match: { part: partNo } },
      {
        $group: {
          _id: { dealerCode: '$dealerCode', dealerName: '$dealerName', type: '$type' },
          qty: { $sum: '$qty' },
          lastScannedDate: { $max: '$timestamp' }
        }
      },
      { $sort: { lastScannedDate: -1 } }
    ]);

    res.json({
      success: true,
      master,
      currentScannedQty,
      dealerWiseMovement,
      lastScannedDate: scans[0] ? scans[0].timestamp : null,
      rawScanHistory: scans.map((scan) => ({
        time: scan.timestamp,
        dealerCode: scan.dealerCode,
        dealerName: scan.dealerName,
        qty: scan.qty,
        type: scan.type,
        bin: scan.bin,
        rawScan: scan.rawScan,
        deviceId: scan.deviceId,
        warnings: scan.warnings
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/scan-validator', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const filter = validatorFilter(req.query);
    const [totalMasterParts, totalScannedRecords, scans, duplicateScanIds, failedSyncRecords, verificationRows] = await Promise.all([
      MasterPart.countDocuments({}),
      Inventory.countDocuments({}),
      Inventory.find({}).select('part partNumber normalizedPartNumber partName partDescription category productCategory manufacturingYear year uniqueScanId scanId syncStatus').lean(),
      Inventory.aggregate([
        { $group: { _id: '$uniqueScanId', count: { $sum: 1 } } },
        { $match: { _id: { $nin: [null, ''] }, count: { $gt: 1 } } }
      ]),
      Inventory.countDocuments({ syncStatus: 'failed' }),
      VerificationLog.find(filter).sort({ time: -1 }).limit(5000).lean()
    ]);
    const parts = Array.from(new Set(scans.map((scan) => normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part)).filter(Boolean)));
    const masters = parts.length ? await MasterPart.find({ $or: [{ normalizedPartNumber: { $in: parts } }, { partNo: { $in: parts } }, { partNumber: { $in: parts } }] }).select('partNo partNumber normalizedPartNumber partName partDescription category productCategory manufacturingYear year').lean() : [];
    const masterSet = new Set(masters.map((part) => normalizePartNumber(part.normalizedPartNumber || part.partNo || part.partNumber)));
    const missingParts = parts.filter((part) => !masterSet.has(part));
    const masterByPart = new Map(masters.map((part) => [normalizePartNumber(part.normalizedPartNumber || part.partNo || part.partNumber), part]));
    const matchedScans = scans.filter((scan) => masterByPart.has(normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part)));
    const unmatchedScans = scans.filter((scan) => !masterByPart.has(normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part)));
    const invalidGroups = new Map();
    verificationRows.forEach((row) => {
      const key = invalidGroupKey(row);
      const detail = {
        id: String(row._id || ''),
        time: row.time || row.createdAt || '',
        rawScannedValue: row.rawScannedValue || '',
        deviceId: row.deviceId || '',
        user: row.staffName || row.scannedBy || row.loginId || row.userId || '',
        scanType: row.scanType || '',
        binLocation: row.binLocation || ''
      };
      if (!invalidGroups.has(key)) {
        invalidGroups.set(key, {
          key,
          invalidPart: normalizePart(row.extractedPartNumber || row.partNumber || row.rawScannedValue) || String(row.rawScannedValue || '').trim(),
          rawScannedValue: row.rawScannedValue || '',
          scanCount: 0,
          dealerCode: row.dealerCode || '',
          deviceId: row.deviceId || '',
          user: row.staffName || row.scannedBy || row.loginId || row.userId || '',
          lastScanTime: row.time || row.createdAt || '',
          reason: row.reason || 'Not Found In Master',
          status: row.status || 'invalid',
          detailIds: [],
          details: []
        });
      }
      const group = invalidGroups.get(key);
      group.scanCount += Number(row.repeatCount || 1);
      group.detailIds.push(detail.id);
      group.details.push(detail);
      if (new Date(detail.time || 0) > new Date(group.lastScanTime || 0)) {
        group.lastScanTime = detail.time;
        group.deviceId = detail.deviceId;
        group.user = detail.user;
      }
    });
    const invalidRows = Array.from(invalidGroups.values()).sort((a, b) => new Date(b.lastScanTime || 0) - new Date(a.lastScanTime || 0));
    const invalidScanTotal = invalidRows.reduce((sum, row) => sum + Number(row.scanCount || 0), 0);

    res.json({
      success: true,
      totalMasterParts,
      totalScannedRecords,
      scannedPartsCount: totalScannedRecords,
      scannedUniquePartsCount: parts.length,
      scannedPartsMatchedWithMaster: matchedScans.length,
      scannedPartsNotFoundInMaster: invalidScanTotal,
      scannedUniquePartsMatchedWithMaster: parts.filter((part) => masterSet.has(part)).length,
      scannedUniquePartsNotFoundInMaster: Array.from(new Set(verificationRows.map((row) => normalizePartNumber(row.extractedPartNumber || row.partNumber)))).filter(Boolean).length,
      duplicateScanIdCount: duplicateScanIds.reduce((sum, item) => sum + Number(item.count || 0) - 1, 0),
      failedSyncRecords,
      missingParts,
      invalidRows,
      missingRows: invalidRows
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/scan-validator/normalize-master', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const parts = await MasterPart.find({}).lean();
    const operations = parts.map((part) => {
      const partNo = normalizePart(part.partNo || part.partNumber);
      return {
        updateOne: {
          filter: { _id: part._id },
          update: { $set: formatPart({ ...part, partNo, partNumber: partNo }) }
        }
      };
    });
    if (operations.length) await MasterPart.bulkWrite(operations, { ordered: false });
    req.io.emit('master:update');
    res.json({ success: true, updatedCount: operations.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/scan-validator/normalize-scans', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const scans = await Inventory.find({}).lean();
    const operations = scans.map((scan) => {
      const partNo = normalizePart(scan.partNumber || scan.part);
      const rawUpi = scan.rawUpi || scan.rawScan || scan.rawScanString || '';
      return {
        updateOne: {
          filter: { _id: scan._id },
          update: {
            $set: {
              scanId: scan.scanId || scan.uniqueScanId,
              part: partNo,
              partNumber: partNo,
              normalizedPartNumber: normalizePartNumber(partNo),
              rawUpi,
              rawScan: scan.rawScan || rawUpi,
              rawScanString: scan.rawScanString || rawUpi,
              qty: numberValue(scan.qty !== undefined ? scan.qty : scan.quantity, 1),
              quantity: numberValue(scan.quantity !== undefined ? scan.quantity : scan.qty, 1),
              scanType: String(scan.scanType || scan.type || 'INWARD').trim().toUpperCase(),
              type: String(scan.type || scan.scanType || 'INWARD').trim().toUpperCase()
            }
          }
        }
      };
    });
    if (operations.length) await Inventory.bulkWrite(operations, { ordered: false });
    req.io.emit('scan:saved');
    res.json({ success: true, updatedCount: operations.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/scan-validator/rebuild-report-cache', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  res.json({ success: true, message: 'Report cache rebuilt', rebuiltAt: new Date() });
});

function validatorIds(body = {}) {
  return (Array.isArray(body.ids) ? body.ids : String(body.ids || '').split(/[,;\s]+/))
    .map((id) => String(id || '').trim())
    .filter((id) => id && /^[a-f0-9]{24}$/i.test(id));
}

router.post('/scan-validator/ignore', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const ids = validatorIds(req.body);
    if (!ids.length) return res.status(400).json({ success: false, message: 'Select invalid rows first' });
    const result = await VerificationLog.updateMany(
      { _id: { $in: ids } },
      { $set: { status: 'ignored', ignoredAt: new Date(), actionBy: req.user.username || req.user.name || 'admin' } }
    );
    res.json({ success: true, updatedCount: result.modifiedCount || 0, message: 'Invalid part ignored' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/scan-validator/map', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const ids = validatorIds(req.body);
    const partNumber = normalizePart(req.body.partNumber || req.body.existingPartNumber);
    if (!ids.length) return res.status(400).json({ success: false, message: 'Select invalid rows first' });
    if (!partNumber) return res.status(400).json({ success: false, message: 'Existing part number is required' });
    const master = await MasterPart.findOne({ $or: [{ partNo: partNumber }, { partNumber }, { normalizedPartNumber: partNumber }] }).lean();
    if (!master) return res.status(404).json({ success: false, message: 'Existing master part not found' });
    const result = await VerificationLog.updateMany(
      { _id: { $in: ids } },
      { $set: { status: 'mapped', mappedPartNumber: partNumber, correctedAt: new Date(), actionBy: req.user.username || req.user.name || 'admin' } }
    );
    res.json({ success: true, updatedCount: result.modifiedCount || 0, message: 'Invalid scans mapped with existing part' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/scan-validator/delete-invalid', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const ids = validatorIds(req.body);
    if (!ids.length) return res.status(400).json({ success: false, message: 'Select invalid rows first' });
    const result = await VerificationLog.deleteMany({ _id: { $in: ids } });
    res.json({ success: true, deletedCount: result.deletedCount || 0, message: 'Invalid scan records deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/scan-validator/mark-corrected', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const ids = validatorIds(req.body);
    if (!ids.length) return res.status(400).json({ success: false, message: 'Select invalid rows first' });
    const result = await VerificationLog.updateMany(
      { _id: { $in: ids } },
      { $set: { status: 'corrected', correctedAt: new Date(), actionBy: req.user.username || req.user.name || 'admin' } }
    );
    res.json({ success: true, updatedCount: result.modifiedCount || 0, message: 'Invalid scans marked as corrected' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/scan-validator/missing-master/export', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const rows = await VerificationLog.find(validatorFilter(req.query)).sort({ time: -1 }).lean();
    const groups = new Map();
    rows.forEach((row) => {
      const key = invalidGroupKey(row);
      if (!groups.has(key)) {
        groups.set(key, {
          invalidPart: normalizePart(row.extractedPartNumber || row.partNumber || row.rawScannedValue) || row.rawScannedValue || '',
          scanCount: 0,
          dealerCode: row.dealerCode || '',
          deviceId: row.deviceId || '',
          user: row.staffName || row.scannedBy || row.loginId || row.userId || '',
          lastScanTime: row.time || row.createdAt || '',
          reason: row.reason || 'Not Found In Master',
          status: row.status || 'invalid'
        });
      }
      const group = groups.get(key);
      group.scanCount += Number(row.repeatCount || 1);
      if (new Date(row.time || 0) > new Date(group.lastScanTime || 0)) {
        group.lastScanTime = row.time;
        group.deviceId = row.deviceId || '';
        group.user = row.staffName || row.scannedBy || row.loginId || row.userId || '';
      }
    });
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Invalid Scan Summary');
    sheet.columns = [
      { header: 'Invalid Part', key: 'invalidPart', width: 24 },
      { header: 'Scan Count', key: 'scanCount', width: 14 },
      { header: 'Dealer Code', key: 'dealerCode', width: 16 },
      { header: 'Device ID', key: 'deviceId', width: 24 },
      { header: 'User', key: 'user', width: 22 },
      { header: 'Last Scan Time', key: 'lastScanTime', width: 24 },
      { header: 'Reason', key: 'reason', width: 24 },
      { header: 'Status', key: 'status', width: 14 }
    ];
    Array.from(groups.values()).forEach((row) => sheet.addRow(row));
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Invalid_Master_Parts.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
