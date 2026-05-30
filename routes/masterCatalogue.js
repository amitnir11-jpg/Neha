const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const MasterCatalogue = require('../models/MasterCatalogue');
const PartPriceHistory = require('../models/PartPriceHistory');
const Inventory = require('../models/Inventory');
const auth = require('./auth');
const { cleanText, normalizePartNumber, numberValue } = require('../utils/normalize');
const { cataloguePayload, reprocessScansWithCatalogue } = require('../utils/catalogue');
const { applyProductGroup } = require('../utils/productGroupClassifier');
const { rebuildMovementSummaries } = require('../services/inventoryMovementSummary');

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
  gstCategory: ['GST CATEGORY', 'HSN'],
  effectiveFrom: ['EFFECTIVE START DATE', 'EFFECTIVE FROM', 'VALID FROM', 'FROM DATE', 'START DATE'],
  effectiveTo: ['EFFECTIVE END DATE', 'EFFECTIVE TO', 'VALID TO', 'TO DATE', 'END DATE']
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

function parseExcelDate(value) {
  if (value === undefined || value === null || cleanText(value) === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const date = new Date(excelEpoch.getTime() + value * 24 * 60 * 60 * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const text = cleanText(value);
  const dmy = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (dmy) {
    const year = Number(dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3]);
    const date = new Date(Date.UTC(year, Number(dmy[2]) - 1, Number(dmy[1])));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dateKey(value) {
  const date = parseExcelDate(value);
  return date ? date.toISOString().slice(0, 10) : '';
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
    effectiveFrom: parseExcelDate(aliasValue(row, 'effectiveFrom')),
    effectiveTo: parseExcelDate(aliasValue(row, 'effectiveTo')),
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

function priceHistoryPayload(row) {
  if (!row || !row.normalizedPartNumber) return null;
  const hasPrice = Number(row.mrp || 0) > 0 || Number(row.dlc || 0) > 0 || row.effectiveFrom || row.effectiveTo;
  if (!hasPrice) return null;
  return {
    partNumber: row.normalizedPartNumber,
    normalizedPartNumber: row.normalizedPartNumber,
    mrp: Number(row.mrp || 0),
    dlc: Number(row.dlc || 0),
    effectiveFrom: row.effectiveFrom || null,
    effectiveTo: row.effectiveTo || null,
    isCurrentPrice: !row.effectiveTo,
    sourceFileName: row.sourceFileName || '',
    uploadedAt: row.uploadedAt || new Date()
  };
}

function priceHistoryKey(row = {}) {
  return [
    row.normalizedPartNumber,
    Number(row.mrp || 0).toFixed(2),
    Number(row.dlc || 0).toFixed(2),
    dateKey(row.effectiveFrom),
    dateKey(row.effectiveTo)
  ].join('|');
}

function exactPeriodKey(row = {}) {
  return [
    row.normalizedPartNumber,
    dateKey(row.effectiveFrom),
    dateKey(row.effectiveTo)
  ].join('|');
}

function rangesOverlap(a = {}, b = {}) {
  const aStart = parseExcelDate(a.effectiveFrom) || new Date(-8640000000000000);
  const aEnd = parseExcelDate(a.effectiveTo) || new Date(8640000000000000);
  const bStart = parseExcelDate(b.effectiveFrom) || new Date(-8640000000000000);
  const bEnd = parseExcelDate(b.effectiveTo) || new Date(8640000000000000);
  return aStart <= bEnd && bStart <= aEnd;
}

function betterCatalogueRow(current, candidate) {
  if (!current) return candidate;
  if (!candidate) return current;
  const currentOpen = !current.effectiveTo;
  const candidateOpen = !candidate.effectiveTo;
  if (currentOpen !== candidateOpen) return candidateOpen ? candidate : current;
  const currentFrom = parseExcelDate(current.effectiveFrom);
  const candidateFrom = parseExcelDate(candidate.effectiveFrom);
  if (candidateFrom && (!currentFrom || candidateFrom > currentFrom)) return candidate;
  return current;
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
  const validRows = mapped.filter(Boolean);
  const invalidCount = rows.length - validRows.length;
  if (!validRows.length) {
    return {
      uploadedRowsCount: rows.length,
      totalRowsUploaded: rows.length,
      importedCount: 0,
      uniquePartsCount: 0,
      priceHistoryRowsCount: 0,
      updatedDuplicateCount: 0,
      duplicateSkippedRows: 0,
      skippedInvalidRowsCount: rows.length,
      overlapWarningCount: 0,
      warningReportRows: []
    };
  }

  const byPart = new Map();
  const priceRows = [];
  const seenPriceKeys = new Set();
  const seenPeriodKeys = new Set();
  const warningReportRows = [];
  let duplicateSkippedRows = 0;

  validRows.forEach((row, index) => {
    byPart.set(row.normalizedPartNumber, betterCatalogueRow(byPart.get(row.normalizedPartNumber), row));
    const priceRow = priceHistoryPayload(row);
    if (!priceRow) return;
    const exactPriceKey = priceHistoryKey(priceRow);
    if (seenPriceKeys.has(exactPriceKey)) {
      duplicateSkippedRows += 1;
      warningReportRows.push({
        row: index + 2,
        partNumber: row.normalizedPartNumber,
        type: 'DUPLICATE_SKIPPED',
        message: 'Exact duplicate price period skipped',
        mrp: priceRow.mrp,
        dlc: priceRow.dlc,
        effectiveFrom: dateKey(priceRow.effectiveFrom),
        effectiveTo: dateKey(priceRow.effectiveTo)
      });
      return;
    }
    seenPriceKeys.add(exactPriceKey);
    const periodKey = exactPeriodKey(priceRow);
    if (seenPeriodKeys.has(periodKey)) {
      warningReportRows.push({
        row: index + 2,
        partNumber: row.normalizedPartNumber,
        type: 'DUPLICATE_PERIOD_WARNING',
        message: 'Same effective period found with a different MRP/DLC',
        mrp: priceRow.mrp,
        dlc: priceRow.dlc,
        effectiveFrom: dateKey(priceRow.effectiveFrom),
        effectiveTo: dateKey(priceRow.effectiveTo)
      });
    }
    seenPeriodKeys.add(periodKey);
    priceRows.push(priceRow);
  });

  const priceRowsByPart = new Map();
  priceRows.forEach((row) => {
    const list = priceRowsByPart.get(row.normalizedPartNumber) || [];
    list.forEach((existing) => {
      if (rangesOverlap(row, existing) && priceHistoryKey(row) !== priceHistoryKey(existing)) {
        warningReportRows.push({
          row: '',
          partNumber: row.normalizedPartNumber,
          type: 'OVERLAP_WARNING',
          message: `Overlapping effective dates: ${dateKey(existing.effectiveFrom) || 'blank'} to ${dateKey(existing.effectiveTo) || 'current'} overlaps ${dateKey(row.effectiveFrom) || 'blank'} to ${dateKey(row.effectiveTo) || 'current'}`,
          mrp: row.mrp,
          dlc: row.dlc,
          effectiveFrom: dateKey(row.effectiveFrom),
          effectiveTo: dateKey(row.effectiveTo)
        });
      }
    });
    list.push(row);
    priceRowsByPart.set(row.normalizedPartNumber, list);
  });

  const valid = Array.from(byPart.values()).map((row) => {
    const copy = { ...row };
    delete copy.effectiveFrom;
    delete copy.effectiveTo;
    return copy;
  });

  const existing = await MasterCatalogue.find({ normalizedPartNumber: { $in: valid.map((row) => row.normalizedPartNumber) } }).select('normalizedPartNumber').lean();
  const existingSet = new Set(existing.map((row) => row.normalizedPartNumber));
  if (valid.length) {
    await MasterCatalogue.bulkWrite(valid.map((row) => ({
      updateOne: {
        filter: { normalizedPartNumber: row.normalizedPartNumber },
        update: { $set: row },
        upsert: true
      }
    })), { ordered: false });
  }
  if (priceRows.length) {
    const existingPriceRows = await PartPriceHistory.find({ normalizedPartNumber: { $in: Array.from(priceRowsByPart.keys()) } }).lean();
    const existingPriceKeys = new Set(existingPriceRows.map(priceHistoryKey));
    priceRows.forEach((row) => {
      existingPriceRows
        .filter((existingRow) => existingRow.normalizedPartNumber === row.normalizedPartNumber)
        .forEach((existingRow) => {
          if (!existingPriceKeys.has(priceHistoryKey(row)) && rangesOverlap(row, existingRow)) {
            warningReportRows.push({
              row: '',
              partNumber: row.normalizedPartNumber,
              type: 'EXISTING_OVERLAP_WARNING',
              message: `Uploaded period ${dateKey(row.effectiveFrom) || 'blank'} to ${dateKey(row.effectiveTo) || 'current'} overlaps existing period ${dateKey(existingRow.effectiveFrom) || 'blank'} to ${dateKey(existingRow.effectiveTo) || 'current'}`,
              mrp: row.mrp,
              dlc: row.dlc,
              effectiveFrom: dateKey(row.effectiveFrom),
              effectiveTo: dateKey(row.effectiveTo)
            });
          }
        });
    });
    const newPriceRows = priceRows.filter((row) => {
      const key = priceHistoryKey(row);
      if (existingPriceKeys.has(key)) {
        duplicateSkippedRows += 1;
        return false;
      }
      existingPriceKeys.add(key);
      return true;
    });
    if (newPriceRows.length) {
      await PartPriceHistory.bulkWrite(newPriceRows.map((row) => ({
        updateOne: {
          filter: {
            normalizedPartNumber: row.normalizedPartNumber,
            mrp: row.mrp,
            dlc: row.dlc,
            effectiveFrom: row.effectiveFrom,
            effectiveTo: row.effectiveTo
          },
          update: { $set: row },
          upsert: true
        }
      })), { ordered: false });
    }
  }
  await MasterCatalogue.syncIndexes();
  await PartPriceHistory.syncIndexes();
  rebuildMovementSummaries({ partNumbers: valid.map((row) => row.normalizedPartNumber) }).catch((error) => console.warn('[movement-summary] rebuild after catalogue upload failed', error.message));
  const currentMasterRecordCount = await MasterCatalogue.countDocuments({});

  return {
    uploadedRowsCount: rows.length,
    totalRowsUploaded: rows.length,
    importedCount: valid.length,
    uniquePartsCount: valid.length,
    currentMasterRecordCount,
    masterCatalogueCount: currentMasterRecordCount,
    priceHistoryRowsCount: priceRows.length,
    updatedDuplicateCount: valid.filter((row) => existingSet.has(row.normalizedPartNumber)).length,
    duplicateSkippedRows,
    skippedInvalidRowsCount: invalidCount,
    overlapWarningCount: warningReportRows.filter((row) => row.type === 'OVERLAP_WARNING').length,
    warningReportRows
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
    const [result, priceResult] = await Promise.all([
      MasterCatalogue.deleteMany({}),
      PartPriceHistory.deleteMany({})
    ]);
    req.io.emit('master:update');
    res.json({ success: true, deletedOldRowsCount: result.deletedCount || 0, deletedPriceHistoryRowsCount: priceResult.deletedCount || 0, currentMasterRecordCount: 0, masterCatalogueCount: 0 });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/delete-and-reupload', auth.requireAuth, auth.requireAdmin, upload.single('file'), async (req, res) => {
  try {
    const [deleted, deletedPrices] = await Promise.all([
      MasterCatalogue.deleteMany({}),
      PartPriceHistory.deleteMany({})
    ]);
    const result = await importCatalogue(req.file);
    const reprocess = await reprocessScansWithCatalogue();
    req.io.emit('master:update');
    req.io.emit('scan:saved');
    res.json({ success: true, deletedOldRowsCount: deleted.deletedCount || 0, deletedPriceHistoryRowsCount: deletedPrices.deletedCount || 0, ...result, reprocess });
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
