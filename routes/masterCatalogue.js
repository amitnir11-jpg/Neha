const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const MasterCatalogue = require('../models/MasterCatalogue');
const Inventory = require('../models/Inventory');
const auth = require('./auth');
const { cleanText, normalizePartNumber, numberValue } = require('../utils/normalize');
const { cataloguePayload, reprocessScansWithCatalogue } = require('../utils/catalogue');
const { applyProductGroup } = require('../utils/productGroupClassifier');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const FIELD_ALIASES = {
  partNumber: ['PART NUMBER', 'PART #', 'PART NO', 'PART', 'PARTNUMBER', 'PARTNO'],
  partDescription: ['PART DESCRIPTION', 'DESCRIPTION'],
  productCategory: ['PRODUCT CATEGORY', 'CATEGORY'],
  mrp: ['MRP PRICE', 'MRP', 'PRICE'],
  dlc: ['DLC', 'DLP'],
  productGroup: ['PRODUCT GROUP', 'GROUP'],
  model: ['MODEL'],
  year: ['YEAR', 'MANUFACTURING YEAR', 'MANUFACTURING YEAR / GEN', 'MFG YEAR'],
  productType: ['PRODUCT TYPE'],
  superceededBy: ['SUPERCEEDED BY', 'SUPERSEDED BY'],
  partGroup: ['PART GROUP'],
  partSubGroup: ['PRODUCT GROUP SUBGROUP', 'PRODUCT GROUP SUB GROUP', 'PRODUCT SUBGROUP', 'PRODUCT SUB GROUP', 'PART SUBGROUP', 'PART SUB GROUP'],
  gstCategory: ['GST CATEGORY', 'HSN']
};

function normalizeHeader(value) {
  return cleanText(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function aliasValue(row, field) {
  for (const alias of FIELD_ALIASES[field] || []) {
    const value = row[normalizeHeader(alias)];
    if (value !== undefined && cleanText(value) !== '') return value;
  }
  return '';
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
      cells.push(cleanText(current));
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(cleanText(current));
  return cells;
}

function parseCsv(buffer) {
  const lines = String(buffer || '').split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]).map(normalizeHeader);
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = cleanText(values[index] || '');
    });
    return row;
  });
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

async function parseUpload(file) {
  if (!file) return [];
  const lowerName = String(file.originalname || '').toLowerCase();
  if (lowerName.endsWith('.csv') || file.mimetype === 'text/csv') return parseCsv(file.buffer);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  const headers = [];
  sheet.getRow(1).eachCell((cell, colNumber) => {
    headers[colNumber] = normalizeHeader(cellValue(cell));
  });
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const item = {};
    headers.forEach((header, colNumber) => {
      if (header) item[header] = cleanText(cellValue(row.getCell(colNumber)));
    });
    rows.push(item);
  });
  return rows;
}

function mapRow(row, sourceFileName) {
  const normalizedPartNumber = normalizePartNumber(aliasValue(row, 'partNumber'));
  if (!normalizedPartNumber) return null;
  const year = cleanText(aliasValue(row, 'year')).toUpperCase();
  const mapped = {
    partNumber: normalizedPartNumber,
    normalizedPartNumber,
    partDescription: cleanText(aliasValue(row, 'partDescription')).toUpperCase(),
    productCategory: cleanText(aliasValue(row, 'productCategory')).toUpperCase(),
    mrp: numberValue(aliasValue(row, 'mrp'), 0),
    dlc: numberValue(aliasValue(row, 'dlc'), 0),
    productGroup: cleanText(aliasValue(row, 'productGroup')).toUpperCase(),
    model: cleanText(aliasValue(row, 'model')).toUpperCase(),
    year,
    manufacturingYear: year,
    productType: cleanText(aliasValue(row, 'productType')).toUpperCase(),
    superceededBy: cleanText(aliasValue(row, 'superceededBy')).toUpperCase(),
    partGroup: cleanText(aliasValue(row, 'partGroup')).toUpperCase(),
    partSubGroup: cleanText(aliasValue(row, 'partSubGroup')).toUpperCase(),
    gstCategory: cleanText(aliasValue(row, 'gstCategory')).toUpperCase(),
    sourceFileName,
    uploadedAt: new Date()
  };
  const grouping = applyProductGroup(mapped);
  mapped.productGroup = grouping.productGroup;
  mapped.partSubGroup = grouping.partSubGroup;
  return mapped;
}

async function reprocessProductGroups({ force = true } = {}) {
  const records = await MasterCatalogue.find({}).lean();
  const operations = records.map((record) => ({
    updateOne: {
      filter: { _id: record._id },
      update: { $set: applyProductGroup(record, { force }) }
    }
  }));
  if (operations.length) await MasterCatalogue.bulkWrite(operations, { ordered: false });
  return { updatedCount: operations.length };
}

async function reprocessCatalogueRecords({ forceProductGroup = false } = {}) {
  const records = await MasterCatalogue.find({}).lean();
  const operations = records.map((record) => {
    const payload = cataloguePayload(record);
    const grouping = applyProductGroup(payload, { force: forceProductGroup });
    return {
      updateOne: {
        filter: { _id: record._id },
        update: {
          $set: {
            partNumber: payload.partNumber,
            normalizedPartNumber: payload.normalizedPartNumber,
            partDescription: payload.partDescription,
            productCategory: payload.productCategory,
            mrp: payload.mrp,
            dlc: payload.dlc,
            productGroup: grouping.productGroup,
            model: payload.model,
            year: payload.year,
            manufacturingYear: payload.manufacturingYear,
            productType: payload.productType,
            superceededBy: payload.superceededBy,
            partGroup: payload.partGroup,
            partSubGroup: grouping.partSubGroup,
            gstCategory: payload.gstCategory,
            updatedAt: new Date()
          }
        }
      }
    };
  });
  if (operations.length) await MasterCatalogue.bulkWrite(operations, { ordered: false });
  await MasterCatalogue.syncIndexes();
  return { updatedCount: operations.length };
}

async function importCatalogue(file) {
  const sourceFileName = file ? cleanText(file.originalname) : '';
  const rows = await parseUpload(file);
  const mapped = rows.map((row) => mapRow(row, sourceFileName));
  const valid = [];
  const seen = new Set();
  let duplicateInsideFile = 0;
  mapped.forEach((row) => {
    if (!row) return;
    if (seen.has(row.normalizedPartNumber)) {
      duplicateInsideFile += 1;
      return;
    }
    seen.add(row.normalizedPartNumber);
    valid.push(row);
  });
  if (!valid.length) return { uploadedRowsCount: rows.length, importedCount: 0, updatedDuplicateCount: 0, skippedInvalidRowsCount: rows.length };

  const existing = await MasterCatalogue.find({ normalizedPartNumber: { $in: valid.map((row) => row.normalizedPartNumber) } }).select('normalizedPartNumber').lean();
  const existingSet = new Set(existing.map((row) => row.normalizedPartNumber));
  await MasterCatalogue.bulkWrite(valid.map((row) => ({
    updateOne: {
      filter: { normalizedPartNumber: row.normalizedPartNumber },
      update: { $set: row },
      upsert: true
    }
  })), { ordered: false });
  await MasterCatalogue.syncIndexes();

  return {
    uploadedRowsCount: rows.length,
    importedCount: valid.length,
    updatedDuplicateCount: valid.filter((row) => existingSet.has(row.normalizedPartNumber)).length + duplicateInsideFile,
    skippedInvalidRowsCount: rows.length - valid.length
  };
}

router.post('/upload', auth.requireAuth, auth.requireAdmin, upload.single('file'), async (req, res) => {
  try {
    const result = await importCatalogue(req.file);
    req.io.emit('master:update');
    res.json({ success: true, deletedOldRowsCount: 0, ...result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const result = await MasterCatalogue.deleteMany({});
    req.io.emit('master:update');
    res.json({ success: true, deletedOldRowsCount: result.deletedCount || 0 });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/delete-and-reupload', auth.requireAuth, auth.requireAdmin, upload.single('file'), async (req, res) => {
  try {
    const deleted = await MasterCatalogue.deleteMany({});
    const result = await importCatalogue(req.file);
    const reprocess = await reprocessScansWithCatalogue();
    req.io.emit('master:update');
    req.io.emit('scan:saved');
    res.json({ success: true, deletedOldRowsCount: deleted.deletedCount || 0, ...result, reprocess });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/search', auth.requireAuth, async (req, res) => {
  try {
    const q = cleanText(req.query.q);
    const page = Math.max(Number(req.query.page || 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 50);
    const skip = (page - 1) * limit;
    const normalized = normalizePartNumber(q);
    const safeText = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const safePart = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const filter = q ? {
      $or: [
        { partNumber: { $regex: safePart, $options: 'i' } },
        { normalizedPartNumber: { $regex: safePart, $options: 'i' } },
        { partDescription: { $regex: safeText, $options: 'i' } },
        { productCategory: { $regex: safeText, $options: 'i' } },
        { model: { $regex: safeText, $options: 'i' } },
        { year: { $regex: safeText, $options: 'i' } },
        { manufacturingYear: { $regex: safeText, $options: 'i' } },
        { productGroup: { $regex: safeText, $options: 'i' } },
        { partSubGroup: { $regex: safeText, $options: 'i' } },
        { dlc: Number.isFinite(Number(q)) ? Number(q) : -1 }
      ]
    } : { _id: null };
    const [total, records] = await Promise.all([
      MasterCatalogue.countDocuments(filter),
      MasterCatalogue.find(filter).sort({ partNumber: 1 }).skip(skip).limit(limit).lean()
    ]);
    res.json({ success: true, records, parts: records.map(cataloguePayload), page, limit, total, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/reprocess', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const catalogue = await reprocessCatalogueRecords({ forceProductGroup: false });
    const result = await reprocessScansWithCatalogue();
    req.io.emit('scan:saved');
    res.json({ success: true, catalogueUpdatedCount: catalogue.updatedCount, ...result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/reprocess-product-groups', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const productGroups = await reprocessProductGroups({ force: true });
    const scans = await reprocessScansWithCatalogue();
    req.io.emit('master:update');
    req.io.emit('scan:saved');
    res.json({ success: true, updatedCount: productGroups.updatedCount, scansUpdatedCount: scans.updatedCount, unmatchedCount: scans.unmatchedCount });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/unmatched-parts', auth.requireAuth, async (req, res) => {
  try {
    const rows = await Inventory.aggregate([
      { $match: { $or: [{ masterMatch: false }, { isMasterMatched: false }, { warnings: /Part not found in Master Catalogue|Not Found in Master/i }] } },
      { $group: { _id: '$normalizedPartNumber', partNumber: { $first: '$partNumber' }, scanCount: { $sum: 1 }, lastScanTime: { $max: '$timestamp' } } },
      { $sort: { lastScanTime: -1 } }
    ]);
    res.json({ success: true, rows: rows.map((row) => ({ partNumber: row.partNumber || row._id, scanCount: row.scanCount, lastScanTime: row.lastScanTime })) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
