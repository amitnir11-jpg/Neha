const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const MasterCatalogue = require('../models/MasterCatalogue');
const PartPriceHistory = require('../models/PartPriceHistory');
const { cleanText, normalizePartNumber } = require('./normalize');
const { applyProductGroup } = require('./productGroupClassifier');

function envNumber(name, fallback, minimum) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(minimum, value) : fallback;
}

const MAX_UPLOAD_BYTES = envNumber('CATALOGUE_UPLOAD_MAX_MB', 100, 10) * 1024 * 1024;
const BULK_CHUNK_SIZE = envNumber('CATALOGUE_UPLOAD_CHUNK_SIZE', 500, 100);
const FAILURE_RETENTION_MS = envNumber('CATALOGUE_FAILURE_RETENTION_HOURS', 24, 1) * 60 * 60 * 1000;
const FAILURE_DIR = path.resolve(__dirname, '..', 'logs', 'catalogue-upload-failures');
const UPLOAD_LOG = path.resolve(__dirname, '..', 'logs', 'catalogue-upload.log');

const CATALOGUE_COLUMNS = [
  { header: 'Part Number', key: 'partNumber' },
  { header: 'Part Description', key: 'partDescription' },
  { header: 'Active Flag', key: 'activeFlag' },
  { header: 'Product Category', key: 'productCategory' },
  { header: 'Product Group', key: 'productGroup' },
  { header: 'Model', key: 'model' },
  { header: 'Product Type', key: 'productType' },
  { header: 'Superceeded By', key: 'superceededBy' },
  { header: 'Part Group', key: 'partGroup' },
  { header: 'Part SubGroup', key: 'partSubGroup' },
  { header: 'GST Category', key: 'gstCategory' },
  { header: 'Split Flag', key: 'splitFlag' },
  { header: 'MRP', key: 'mrp' },
  { header: 'DLC', key: 'dlc' }
];

const COLUMN_BY_HEADER = new Map(CATALOGUE_COLUMNS.map((column) => [normalizeHeader(column.header), column]));

function normalizeHeader(value) {
  return cleanText(value).replace(/\s+/g, ' ').toUpperCase();
}

function cellValue(cell) {
  if (!cell) return '';
  const value = cell.value;
  if (value && typeof value === 'object') {
    if (value.text !== undefined) return value.text;
    if (value.result !== undefined) return value.result;
    if (Array.isArray(value.richText)) return value.richText.map((item) => item.text || '').join('');
    if (value.hyperlink && value.text) return value.text;
  }
  return value === undefined || value === null ? '' : value;
}

function displayCellValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return cleanText(JSON.stringify(value));
  return value;
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
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function buildParsedRows(headers, rawRows, sourceSheetName = '') {
  const columns = headers.map((header, index) => {
    const originalHeader = cleanText(header) || `Column ${index + 1}`;
    const expected = COLUMN_BY_HEADER.get(normalizeHeader(originalHeader));
    return {
      index,
      originalHeader,
      normalizedHeader: normalizeHeader(originalHeader),
      key: expected ? expected.key : ''
    };
  });
  const presentHeaders = new Set(columns.filter((column) => column.key).map((column) => column.normalizedHeader));
  const duplicateHeaders = Array.from(presentHeaders).filter((header) => columns.filter((column) => column.normalizedHeader === header).length > 1);
  if (duplicateHeaders.length) {
    const duplicateNames = duplicateHeaders.map((header) => COLUMN_BY_HEADER.get(header).header);
    const error = new Error(`Duplicate catalogue columns: ${duplicateNames.join(', ')}`);
    error.statusCode = 400;
    error.duplicateColumns = duplicateNames;
    throw error;
  }
  const missingColumns = CATALOGUE_COLUMNS
    .filter((column) => !presentHeaders.has(normalizeHeader(column.header)))
    .map((column) => column.header);
  if (missingColumns.length) {
    const error = new Error(`Missing catalogue columns: ${missingColumns.join(', ')}`);
    error.statusCode = 400;
    error.missingColumns = missingColumns;
    throw error;
  }
  return {
    columns,
    sourceSheetName,
    rows: rawRows.map((rawRow) => ({
      rowNumber: rawRow.rowNumber,
      originalValues: columns.map((column) => displayCellValue(rawRow.values[column.index])),
      values: Object.fromEntries(columns.filter((column) => column.key).map((column) => [column.key, rawRow.values[column.index]]))
    }))
  };
}

function parseCsv(buffer) {
  const lines = String(buffer || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return buildParsedRows([], []);
  const headers = splitCsvLine(lines[0]);
  const rows = lines.slice(1).map((line, index) => ({ rowNumber: index + 2, values: splitCsvLine(line) }));
  return buildParsedRows(headers, rows, 'CSV');
}

async function parseXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    const error = new Error('The uploaded workbook does not contain a worksheet');
    error.statusCode = 400;
    throw error;
  }
  const headerRow = sheet.getRow(1);
  const maxColumn = Math.max(headerRow.cellCount, headerRow.actualCellCount);
  const headers = Array.from({ length: maxColumn }, (_, index) => cellValue(headerRow.getCell(index + 1)));
  let lastDataRow = sheet.rowCount;
  while (lastDataRow > 1) {
    const row = sheet.getRow(lastDataRow);
    const hasValue = headers.some((_, index) => cleanText(cellValue(row.getCell(index + 1))) !== '');
    if (hasValue) break;
    lastDataRow -= 1;
  }
  const rows = [];
  for (let rowNumber = 2; rowNumber <= lastDataRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    rows.push({
      rowNumber,
      values: headers.map((_, index) => cellValue(row.getCell(index + 1)))
    });
  }
  return buildParsedRows(headers, rows, sheet.name || 'Sheet1');
}

function parseLegacyExcel(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    const error = new Error('The uploaded workbook does not contain a worksheet');
    error.statusCode = 400;
    throw error;
  }
  const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', blankrows: true, raw: true });
  const headers = matrix[0] || [];
  let lastIndex = matrix.length - 1;
  while (lastIndex > 0 && !(matrix[lastIndex] || []).some((value) => cleanText(value) !== '')) lastIndex -= 1;
  const rows = matrix.slice(1, lastIndex + 1).map((values, index) => ({ rowNumber: index + 2, values }));
  return buildParsedRows(headers, rows, sheetName);
}

async function parseCatalogueUpload(file) {
  if (!file || !file.buffer || !file.buffer.length) {
    const error = new Error('Select a catalogue file to upload');
    error.statusCode = 400;
    throw error;
  }
  if (file.size > MAX_UPLOAD_BYTES || file.buffer.length > MAX_UPLOAD_BYTES) {
    const error = new Error(`Catalogue file exceeds the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB upload limit`);
    error.statusCode = 413;
    throw error;
  }
  const lowerName = cleanText(file.originalname).toLowerCase();
  if (lowerName.endsWith('.csv') || file.mimetype === 'text/csv') return parseCsv(file.buffer);
  if (lowerName.endsWith('.xls')) return parseLegacyExcel(file.buffer);
  if (!lowerName.endsWith('.xlsx')) {
    const error = new Error('Only .xlsx, .xls, and .csv catalogue files are supported');
    error.statusCode = 400;
    throw error;
  }
  return parseXlsx(file.buffer);
}

function parseNumeric(value, fieldName) {
  const text = cleanText(value);
  if (!text) return { value: 0 };
  const normalized = text.replace(/,/g, '');
  const number = Number(normalized);
  if (!Number.isFinite(number)) return { error: `${fieldName} must be numeric` };
  return { value: number };
}

function activeStatus(value) {
  const text = cleanText(value).toUpperCase();
  if (!text) return true;
  return !['N', 'NO', 'FALSE', '0', 'INACTIVE', 'DISABLED'].includes(text);
}

function upper(value) {
  return cleanText(value).toUpperCase();
}

function validateCatalogueRows(parsed, sourceFileName = '') {
  const acceptedRows = [];
  const failedRows = [];
  const duplicateRows = [];
  const skippedRows = [];
  const seenParts = new Map();
  let missingMandatoryFieldsCount = 0;

  parsed.rows.forEach((row) => {
    const hasAnyValue = row.originalValues.some((value) => cleanText(value) !== '');
    if (!hasAnyValue) {
      skippedRows.push({ ...row, status: 'SKIPPED', reason: 'Blank row' });
      return;
    }
    const partNumber = normalizePartNumber(row.values.partNumber);
    const partDescription = upper(row.values.partDescription);
    const errors = [];
    if (!partNumber) errors.push('Part Number is mandatory');
    if (!partDescription) errors.push('Part Description is mandatory');
    if (errors.length) missingMandatoryFieldsCount += 1;
    const mrp = parseNumeric(row.values.mrp, 'MRP');
    const dlc = parseNumeric(row.values.dlc, 'DLC');
    if (mrp.error) errors.push(mrp.error);
    if (dlc.error) errors.push(dlc.error);
    if (errors.length) {
      failedRows.push({ ...row, status: 'FAILED', reason: errors.join('; ') });
      return;
    }
    if (seenParts.has(partNumber)) {
      duplicateRows.push({
        ...row,
        status: 'DUPLICATE',
        reason: `Duplicate Part Number in uploaded file; first occurrence is Excel row ${seenParts.get(partNumber)}`
      });
      return;
    }
    seenParts.set(partNumber, row.rowNumber);
    const mapped = {
      partNumber,
      normalizedPartNumber: partNumber,
      partDescription,
      activeFlag: upper(row.values.activeFlag),
      activeStatus: activeStatus(row.values.activeFlag),
      productCategory: upper(row.values.productCategory),
      productGroup: upper(row.values.productGroup),
      model: upper(row.values.model),
      productType: upper(row.values.productType),
      superceededBy: upper(row.values.superceededBy),
      partGroup: upper(row.values.partGroup),
      partSubGroup: upper(row.values.partSubGroup),
      gstCategory: upper(row.values.gstCategory),
      splitFlag: upper(row.values.splitFlag),
      mrp: mrp.value,
      dlc: dlc.value,
      sourceFileName,
      uploadedAt: new Date()
    };
    const grouping = applyProductGroup(mapped, { force: false });
    mapped.productGroup = grouping.productGroup;
    mapped.partSubGroup = grouping.partSubGroup;
    acceptedRows.push({ ...row, mapped });
  });

  return {
    ...parsed,
    acceptedRows,
    failedRows,
    duplicateRows,
    skippedRows,
    missingMandatoryFieldsCount
  };
}

function chunks(items, size = BULK_CHUNK_SIZE) {
  const output = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

async function loadExistingPartNumbers(partNumbers) {
  const existing = new Set();
  for (const partChunk of chunks(partNumbers)) {
    const rows = await MasterCatalogue.find({ normalizedPartNumber: { $in: partChunk } }).select('normalizedPartNumber').lean();
    rows.forEach((row) => existing.add(normalizePartNumber(row.normalizedPartNumber)));
  }
  return existing;
}

function errorMessage(error) {
  return cleanText(error && (error.errmsg || error.message || error.code)) || 'Database write failed';
}

async function writeRowsInChunks(Model, rows, operationForRow) {
  const successfulRows = [];
  const failedRows = [];
  for (const rowChunk of chunks(rows)) {
    const operations = rowChunk.map(operationForRow);
    try {
      await Model.bulkWrite(operations, { ordered: false });
      successfulRows.push(...rowChunk);
    } catch (error) {
      const writeErrors = Array.isArray(error.writeErrors) ? error.writeErrors : [];
      const failedIndexes = new Map(writeErrors.map((item) => [Number(item.index), errorMessage(item.err || item)]));
      for (let index = 0; index < rowChunk.length; index += 1) {
        if (!failedIndexes.has(index) && writeErrors.length) {
          successfulRows.push(rowChunk[index]);
          continue;
        }
        const operation = operations[index].updateOne;
        try {
          await Model.updateOne(operation.filter, operation.update, { upsert: operation.upsert });
          successfulRows.push(rowChunk[index]);
        } catch (retryError) {
          failedRows.push({ row: rowChunk[index], reason: errorMessage(retryError) || failedIndexes.get(index) });
        }
      }
    }
  }
  return { successfulRows, failedRows };
}

async function appendUploadLog(payload) {
  try {
    await fs.promises.mkdir(path.dirname(UPLOAD_LOG), { recursive: true });
    await fs.promises.appendFile(UPLOAD_LOG, `${JSON.stringify({ timestamp: new Date().toISOString(), ...payload })}\n`, 'utf8');
  } catch (error) {
    console.error('Catalogue upload logging failed:', error.message);
  }
}

function safeFailureId(value) {
  const id = cleanText(value);
  return /^[a-f0-9-]{36}$/i.test(id) ? id : '';
}

function failureFilePath(id) {
  const safeId = safeFailureId(id);
  return safeId ? path.join(FAILURE_DIR, `${safeId}.xlsx`) : '';
}

async function cleanupFailureFiles() {
  try {
    await fs.promises.mkdir(FAILURE_DIR, { recursive: true });
    const entries = await fs.promises.readdir(FAILURE_DIR, { withFileTypes: true });
    await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith('.xlsx')).map(async (entry) => {
      const target = path.join(FAILURE_DIR, entry.name);
      const stat = await fs.promises.stat(target);
      if (Date.now() - stat.mtimeMs > FAILURE_RETENTION_MS) await fs.promises.unlink(target);
    }));
  } catch (error) {
    console.warn('Catalogue failed-row cleanup skipped:', error.message);
  }
}

async function createFailedRowsWorkbook(validation, nonImportedRows) {
  if (!nonImportedRows.length) return '';
  await cleanupFailureFiles();
  const id = crypto.randomUUID();
  const target = failureFilePath(id);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Daksh Inventory v2';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Failed Rows');
  const originalHeaders = validation.columns.map((column) => column.originalHeader);
  sheet.columns = [
    { header: 'Excel Row', key: 'excelRow', width: 12 },
    ...originalHeaders.map((header, index) => ({ header, key: `source${index}`, width: Math.min(32, Math.max(12, header.length + 2)) })),
    { header: 'Row Status', key: 'rowStatus', width: 15 },
    { header: 'Error Reason', key: 'errorReason', width: 55 }
  ];
  nonImportedRows.forEach((row) => {
    const record = { excelRow: row.rowNumber, rowStatus: row.status || 'FAILED', errorReason: row.reason || 'Upload failed' };
    originalHeaders.forEach((header, index) => {
      record[`source${index}`] = row.originalValues[index] === undefined ? '' : row.originalValues[index];
    });
    sheet.addRow(record);
  });
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF153A5B' } };
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: sheet.columnCount } };
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber > 1) row.alignment = { vertical: 'top', wrapText: true };
  });
  await fs.promises.mkdir(FAILURE_DIR, { recursive: true });
  await workbook.xlsx.writeFile(target);
  return id;
}

function summaryFrom(validation, successfulRows, persistenceFailures, existingSet, priceHistoryRowsCount, priceHistoryFailedRowsCount, currentMasterRecordCount) {
  const databaseFailedRows = persistenceFailures.map(({ row, reason }) => ({
    ...row,
    status: 'FAILED',
    reason: `Database import failed: ${reason}`
  }));
  const failedRows = validation.failedRows.concat(databaseFailedRows);
  const importedRowsCount = successfulRows.length;
  const insertedRowsCount = successfulRows.filter((row) => !existingSet.has(row.mapped.normalizedPartNumber)).length;
  const updatedRowsCount = importedRowsCount - insertedRowsCount;
  return {
    totalRowsCount: validation.rows.length,
    importedRowsCount,
    failedRowsCount: failedRows.length,
    duplicateRowsCount: validation.duplicateRows.length,
    skippedRowsCount: validation.skippedRows.length,
    insertedRowsCount,
    updatedRowsCount,
    missingMandatoryFieldsCount: validation.missingMandatoryFieldsCount,
    priceHistoryRowsCount,
    priceHistoryFailedRowsCount,
    currentMasterRecordCount,
    masterCatalogueCount: currentMasterRecordCount,
    totalRowsUploaded: validation.rows.length,
    uploadedRowsCount: validation.rows.length,
    importedCount: importedRowsCount,
    uniquePartsCount: importedRowsCount,
    updatedDuplicateCount: updatedRowsCount,
    duplicateSkippedRows: validation.duplicateRows.length,
    skippedInvalidRowsCount: failedRows.length,
    nonImportedRows: failedRows.concat(validation.duplicateRows, validation.skippedRows)
  };
}

function failureReasonCounts(rows = []) {
  return rows.reduce((counts, row) => {
    const reason = cleanText(row.reason) || 'Unknown failure';
    counts[reason] = (counts[reason] || 0) + 1;
    return counts;
  }, {});
}

async function importCatalogue(file, options = {}) {
  const sourceFileName = cleanText(file && file.originalname);
  const parsed = await parseCatalogueUpload(file);
  const validation = validateCatalogueRows(parsed, sourceFileName);
  const validationIssueCount = validation.failedRows.length + validation.duplicateRows.length;
  if (options.rejectOnValidationIssues && validationIssueCount) {
    const currentMasterRecordCount = await MasterCatalogue.countDocuments({});
    const summary = summaryFrom(validation, [], [], new Set(), 0, 0, currentMasterRecordCount);
    summary.failureDownloadId = await createFailedRowsWorkbook(validation, summary.nonImportedRows);
    delete summary.nonImportedRows;
    summary.blocked = true;
    await appendUploadLog({
      event: 'catalogue-upload-blocked',
      sourceFileName,
      ...summary,
      failureReasons: failureReasonCounts(validation.failedRows.concat(validation.duplicateRows))
    });
    return summary;
  }

  const partNumbers = validation.acceptedRows.map((row) => row.mapped.normalizedPartNumber);
  const existingSet = options.replaceExisting ? new Set() : await loadExistingPartNumbers(partNumbers);
  let deletedOldRowsCount = 0;
  let deletedPriceHistoryRowsCount = 0;
  if (options.replaceExisting) {
    const [deleted, deletedPrices] = await Promise.all([
      MasterCatalogue.deleteMany({}),
      PartPriceHistory.deleteMany({})
    ]);
    deletedOldRowsCount = deleted.deletedCount || 0;
    deletedPriceHistoryRowsCount = deletedPrices.deletedCount || 0;
  }

  const masterResult = await writeRowsInChunks(MasterCatalogue, validation.acceptedRows, (row) => ({
    updateOne: {
      filter: { normalizedPartNumber: row.mapped.normalizedPartNumber },
      update: { $set: row.mapped },
      upsert: true
    }
  }));
  const successfulPartSet = new Set(masterResult.successfulRows.map((row) => row.mapped.normalizedPartNumber));
  const priceRows = masterResult.successfulRows.map((row) => ({
    ...row,
    price: {
      partNumber: row.mapped.partNumber,
      normalizedPartNumber: row.mapped.normalizedPartNumber,
      mrp: row.mapped.mrp,
      dlc: row.mapped.dlc,
      effectiveFrom: null,
      effectiveTo: null,
      isCurrentPrice: true,
      sourceFileName,
      uploadedAt: row.mapped.uploadedAt
    }
  }));
  const priceResult = await writeRowsInChunks(PartPriceHistory, priceRows, (row) => ({
    updateOne: {
      filter: { normalizedPartNumber: row.price.normalizedPartNumber, effectiveFrom: null, effectiveTo: null },
      update: { $set: row.price },
      upsert: true
    }
  }));
  const currentMasterRecordCount = await MasterCatalogue.countDocuments({});
  const summary = summaryFrom(
    validation,
    masterResult.successfulRows,
    masterResult.failedRows,
    existingSet,
    priceResult.successfulRows.filter((row) => successfulPartSet.has(row.mapped.normalizedPartNumber)).length,
    priceResult.failedRows.length,
    currentMasterRecordCount
  );
  const nonImportedRows = summary.nonImportedRows;
  summary.failureDownloadId = await createFailedRowsWorkbook(validation, summary.nonImportedRows);
  delete summary.nonImportedRows;
  summary.deletedOldRowsCount = deletedOldRowsCount;
  summary.deletedPriceHistoryRowsCount = deletedPriceHistoryRowsCount;
  await appendUploadLog({
    event: 'catalogue-upload-complete',
    sourceFileName,
    sourceSheetName: validation.sourceSheetName,
    ...summary,
    failureReasons: failureReasonCounts(nonImportedRows),
    priceHistoryFailureReasons: failureReasonCounts(priceResult.failedRows.map(({ row, reason }) => ({ ...row, reason })))
  });
  return summary;
}

module.exports = {
  BULK_CHUNK_SIZE,
  CATALOGUE_COLUMNS,
  MAX_UPLOAD_BYTES,
  appendUploadLog,
  cleanupFailureFiles,
  failureFilePath,
  importCatalogue,
  parseCatalogueUpload,
  validateCatalogueRows
};
