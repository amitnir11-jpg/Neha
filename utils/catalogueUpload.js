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
  {
    header: 'Part Number',
    key: 'partNumber',
    aliases: ['Part No', 'Part No.', 'PartNumber', 'Part No #', 'Item Code', 'Material Code'],
    mandatory: true,
    description: 'Unique part number used for master lookup and scan matching.'
  },
  {
    header: 'Part Description',
    key: 'partDescription',
    aliases: ['Part Name', 'Description', 'Part Desc', 'Part Name / Description'],
    mandatory: true,
    description: 'Display description for the part.'
  },
  {
    header: 'Active Flag',
    key: 'activeFlag',
    aliases: ['Active', 'Status'],
    mandatory: false,
    description: 'Optional Y/N flag. Blank rows default to active.'
  },
  {
    header: 'Product Category',
    key: 'productCategory',
    aliases: ['Category', 'Part Category'],
    mandatory: false,
    description: 'Category or head used for reporting and grouping.'
  },
  {
    header: 'Product Group',
    key: 'productGroup',
    aliases: ['Group', 'Product Group Name'],
    mandatory: false,
    description: 'Primary product group.'
  },
  {
    header: 'Product Group SubGroup',
    key: 'partSubGroup',
    aliases: ['Part SubGroup', 'Part Sub Group', 'Product SubGroup', 'SubGroup'],
    mandatory: false,
    description: 'Product sub-group / child grouping.'
  },
  {
    header: 'Model',
    key: 'model',
    aliases: ['Vehicle Model'],
    mandatory: false,
    description: 'Model reference from the catalogue.'
  },
  {
    header: 'Manufacturing Year',
    key: 'manufacturingYear',
    aliases: ['Year', 'Gen', 'MFG Year', 'Manufacturing Year / Gen'],
    mandatory: false,
    description: 'Manufacturing year or generation.'
  },
  {
    header: 'Product Type',
    key: 'productType',
    aliases: ['Type'],
    mandatory: false,
    description: 'Product type such as Spare Part, Accessory, etc.'
  },
  {
    header: 'MRP',
    key: 'mrp',
    aliases: ['MRP Price', 'Price', 'Rate'],
    mandatory: true,
    description: 'Maximum retail price. Required for upload.'
  },
  {
    header: 'DLP',
    key: 'dlc',
    aliases: ['DLC', 'Landed Cost'],
    mandatory: true,
    description: 'Dealer landed cost. The system stores this as DLC.'
  }
];

const CATALOGUE_OPTIONAL_COLUMNS = [
  {
    header: 'Superceeded By',
    key: 'superceededBy',
    aliases: ['Superceded By', 'Superseeded By', 'Superseded By'],
    mandatory: false,
    description: 'Legacy replacement part number.'
  },
  {
    header: 'Part Group',
    key: 'partGroup',
    aliases: ['Part Group Name'],
    mandatory: false,
    description: 'Legacy part group column accepted for older uploads.'
  },
  {
    header: 'GST Category',
    key: 'gstCategory',
    aliases: ['GST', 'Tax Category'],
    mandatory: false,
    description: 'GST category or tax group.'
  },
  {
    header: 'Split Flag',
    key: 'splitFlag',
    aliases: ['Split'],
    mandatory: false,
    description: 'Legacy split flag column.'
  }
];

const CATALOGUE_FIELD_DEFINITIONS = [...CATALOGUE_COLUMNS, ...CATALOGUE_OPTIONAL_COLUMNS];
const CATALOGUE_TEMPLATE_COLUMNS = CATALOGUE_COLUMNS.filter((column) => column.mandatory || column.key);
const COLUMN_BY_HEADER = new Map();

CATALOGUE_FIELD_DEFINITIONS.forEach((column) => {
  [column.header, ...(column.aliases || [])].forEach((alias) => {
    const normalized = normalizeHeader(alias);
    if (!COLUMN_BY_HEADER.has(normalized)) COLUMN_BY_HEADER.set(normalized, column);
  });
});

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
      key: expected ? expected.key : '',
      mandatory: expected ? Boolean(expected.mandatory) : false
    };
  });
  const mappedColumns = columns.filter((column) => column.key);
  const columnsByKey = new Map();
  mappedColumns.forEach((column) => {
    if (!columnsByKey.has(column.key)) columnsByKey.set(column.key, []);
    columnsByKey.get(column.key).push(column);
  });
  const duplicateColumns = Array.from(columnsByKey.values()).filter((items) => items.length > 1);
  if (duplicateColumns.length) {
    const duplicateNames = Array.from(new Set(duplicateColumns.flatMap((items) => items.map((item) => item.originalHeader || item.key))));
    const error = new Error(`Duplicate catalogue columns: ${duplicateNames.join(', ')}`);
    error.statusCode = 400;
    error.duplicateColumns = duplicateNames;
    throw error;
  }
  const missingColumns = CATALOGUE_FIELD_DEFINITIONS
    .filter((column) => column.mandatory && !columnsByKey.has(column.key))
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

function parseNumeric(value, fieldName, { required = false, blankError = `${fieldName} is mandatory`, invalidError = `${fieldName} must be numeric` } = {}) {
  const text = cleanText(value);
  if (!text) {
    if (required) return { error: blankError };
    return { value: 0 };
  }
  const normalized = text.replace(/,/g, '');
  const number = Number(normalized);
  if (!Number.isFinite(number)) return { error: invalidError };
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

function canonicalCatalogueFailureReason(reason) {
  const text = cleanText(reason);
  if (!text) return 'Unknown failure';
  const normalized = text.toUpperCase();
  if (normalized.startsWith('DATABASE INSERT ERROR') || normalized.startsWith('DATABASE IMPORT FAILED')) return 'Database insert error';
  if (normalized.startsWith('MISSING PART NUMBER') || normalized.startsWith('PART NUMBER IS MANDATORY')) return 'Missing Part Number';
  if (normalized.startsWith('BLANK MANDATORY FIELDS') || normalized.startsWith('BLANK ROW')) return 'Blank mandatory fields';
  if (normalized.startsWith('INVALID MRP/DLC')) return 'Invalid MRP/DLC';
  if (normalized.startsWith('DUPLICATE CONFLICT') || normalized.startsWith('DUPLICATE PART NUMBER')) return 'Duplicate conflict';
  return text;
}

function createUploadProgressReporter(onProgress) {
  if (typeof onProgress !== 'function') return null;
  let lastSignature = '';
  return (progress = {}, { force = false } = {}) => {
    const payload = { ...progress };
    if (payload.percent !== undefined) {
      const percent = Number(payload.percent);
      payload.percent = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
    }
    const signature = JSON.stringify([
      payload.stage || '',
      payload.percent || 0,
      payload.processedRows || 0,
      payload.totalRows || 0,
      payload.acceptedRowsCount || 0,
      payload.savedRowsCount || 0,
      payload.failedRowsCount || 0,
      payload.message || ''
    ]);
    if (!force && signature === lastSignature) return;
    lastSignature = signature;
    onProgress(payload);
  };
}

function betterCatalogueRow(existing = null, candidate = null) {
  if (!existing) return { winner: candidate, loser: null };
  if (!candidate) return { winner: existing, loser: null };
  const existingMrp = Number(existing.mapped && existing.mapped.mrp || 0);
  const candidateMrp = Number(candidate.mapped && candidate.mapped.mrp || 0);
  if (candidateMrp > existingMrp) return { winner: candidate, loser: existing };
  if (candidateMrp < existingMrp) return { winner: existing, loser: candidate };
  if (Number(candidate.rowNumber || 0) > Number(existing.rowNumber || 0)) return { winner: candidate, loser: existing };
  return { winner: existing, loser: candidate };
}

function validateCatalogueRows(parsed, sourceFileName = '', options = {}) {
  const onProgress = typeof options === 'function' ? options : options.onProgress;
  const emit = createUploadProgressReporter(onProgress);
  const acceptedRows = [];
  const failedRows = [];
  const duplicateRows = [];
  const skippedRows = [];
  const winnersByPart = new Map();
  let missingMandatoryFieldsCount = 0;
  const totalRows = parsed.rows.length;
  const progressStep = Math.max(250, Math.ceil(Math.max(totalRows, 1) / 100));

  if (emit) {
    emit({
      stage: 'validating',
      percent: 5,
      processedRows: 0,
      totalRows,
      fileRowsCount: totalRows,
      acceptedRowsCount: 0,
      failedRowsCount: 0,
      duplicateRowsCount: 0,
      skippedRowsCount: 0,
      message: `Parsing ${totalRows.toLocaleString('en-IN')} file row${totalRows === 1 ? '' : 's'}`
    }, { force: true });
  }

  parsed.rows.forEach((row, index) => {
    const hasAnyValue = row.originalValues.some((value) => cleanText(value) !== '');
    if (!hasAnyValue) {
      skippedRows.push({ ...row, status: 'SKIPPED', reason: 'Blank mandatory fields' });
    } else {
      const partNumber = normalizePartNumber(row.values.partNumber);
      const partDescription = upper(row.values.partDescription);
      const mrp = parseNumeric(row.values.mrp, 'MRP', {
        required: true,
        blankError: 'Blank mandatory fields',
        invalidError: 'Invalid MRP/DLC'
      });
      const dlc = parseNumeric(row.values.dlc, 'DLP', {
        required: true,
        blankError: 'Blank mandatory fields',
        invalidError: 'Invalid MRP/DLC'
      });
      let failureReason = '';
      if (!partNumber) {
        failureReason = 'Missing Part Number';
      } else if (!partDescription || mrp.error === 'Blank mandatory fields' || dlc.error === 'Blank mandatory fields') {
        failureReason = 'Blank mandatory fields';
      } else if (mrp.error || dlc.error) {
        failureReason = 'Invalid MRP/DLC';
      }
      if (failureReason) missingMandatoryFieldsCount += 1;
      if (failureReason) {
        failedRows.push({
          ...row,
          status: 'FAILED',
          reason: failureReason,
          validationErrors: [failureReason]
        });
      } else {
        const mapped = {
          partNumber,
          normalizedPartNumber: partNumber,
          partDescription,
          activeFlag: upper(row.values.activeFlag) || 'Y',
          activeStatus: activeStatus(row.values.activeFlag),
          productCategory: upper(row.values.productCategory),
          productGroup: upper(row.values.productGroup),
          partSubGroup: upper(row.values.partSubGroup),
          model: upper(row.values.model),
          manufacturingYear: upper(row.values.manufacturingYear),
          productType: upper(row.values.productType),
          superceededBy: upper(row.values.superceededBy),
          partGroup: upper(row.values.partGroup),
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
        const candidate = { ...row, mapped };
        const existing = winnersByPart.get(partNumber) || null;
        if (!existing) {
          winnersByPart.set(partNumber, candidate);
        } else {
          const { winner, loser } = betterCatalogueRow(existing, candidate);
          if (loser) {
            duplicateRows.push({
              ...loser,
              status: 'DUPLICATE',
              reason: 'Duplicate conflict',
              duplicateOfRowNumber: winner.rowNumber
            });
          }
          winnersByPart.set(partNumber, winner);
        }
      }
    }

    if (emit && (index === 0 || (index + 1) % progressStep === 0 || index + 1 === totalRows)) {
      const processed = index + 1;
      const percent = totalRows ? 5 + ((processed / totalRows) * 35) : 40;
      emit({
        stage: 'validating',
        percent,
        processedRows: processed,
        totalRows,
        fileRowsCount: totalRows,
        acceptedRowsCount: winnersByPart.size,
        failedRowsCount: failedRows.length,
        duplicateRowsCount: duplicateRows.length,
        skippedRowsCount: skippedRows.length,
        message: `Validated ${processed.toLocaleString('en-IN')} of ${totalRows.toLocaleString('en-IN')} file rows`
      });
    }
  });

  winnersByPart.forEach((value) => acceptedRows.push(value));

  if (emit) {
    emit({
      stage: 'validation-complete',
      percent: 40,
      processedRows: totalRows,
      totalRows,
      fileRowsCount: totalRows,
      acceptedRowsCount: acceptedRows.length,
      failedRowsCount: failedRows.length,
      duplicateRowsCount: duplicateRows.length,
      skippedRowsCount: skippedRows.length,
      message: `Validation complete. Accepted ${acceptedRows.length.toLocaleString('en-IN')} rows`
    }, { force: true });
  }

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

async function writeRowsInChunks(Model, rows, operationForRow, options = {}) {
  const onProgress = typeof options === 'function' ? options : options.onProgress;
  const emit = createUploadProgressReporter(onProgress);
  const stage = cleanText(options.stage || 'writing');
  const label = cleanText(options.label || Model.modelName || 'rows') || 'rows';
  const totalRows = rows.length;
  const successfulRows = [];
  const failedRows = [];
  const progressStart = Number.isFinite(Number(options.progressStart)) ? Number(options.progressStart) : 0;
  const progressSpan = Number.isFinite(Number(options.progressSpan)) ? Number(options.progressSpan) : 100;
  const startMessage = cleanText(options.startMessage || `Saving ${label}...`);
  const completeMessage = cleanText(options.completeMessage || `${label} saved`);

  if (emit) {
    emit({
      stage: stage ? `${stage}:start` : 'writing:start',
      percent: progressStart,
      processedRows: 0,
      totalRows,
      savedRowsCount: 0,
      failedRowsCount: 0,
      message: startMessage
    }, { force: true });
  }

  if (!totalRows) {
    if (emit) {
      emit({
        stage: stage ? `${stage}:complete` : 'writing:complete',
        percent: progressStart + progressSpan,
        processedRows: 0,
        totalRows: 0,
        savedRowsCount: 0,
        failedRowsCount: 0,
        message: completeMessage
      }, { force: true });
    }
    return { successfulRows, failedRows };
  }

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

    if (emit) {
      const processedRows = Math.min(totalRows, successfulRows.length + failedRows.length);
      const percent = progressStart + (progressSpan * (processedRows / totalRows));
      emit({
        stage,
        percent,
        processedRows,
        totalRows,
        savedRowsCount: successfulRows.length,
        failedRowsCount: failedRows.length,
        message: `${cleanText(options.progressMessagePrefix || 'Saved')} ${processedRows.toLocaleString('en-IN')} of ${totalRows.toLocaleString('en-IN')} ${label}`
      });
    }
  }

  if (emit) {
    emit({
      stage: stage ? `${stage}:complete` : 'writing:complete',
      percent: progressStart + progressSpan,
      processedRows: totalRows,
      totalRows,
      savedRowsCount: successfulRows.length,
      failedRowsCount: failedRows.length,
      message: completeMessage
    }, { force: true });
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

async function purgeFailureFiles() {
  try {
    await fs.promises.mkdir(FAILURE_DIR, { recursive: true });
    const entries = await fs.promises.readdir(FAILURE_DIR, { withFileTypes: true });
    await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith('.xlsx')).map(async (entry) => {
      await fs.promises.unlink(path.join(FAILURE_DIR, entry.name));
    }));
  } catch (error) {
    console.warn('Catalogue failed-row purge skipped:', error.message);
  }
}

function catalogueFieldReference() {
  return CATALOGUE_FIELD_DEFINITIONS.map((column) => ({
    field: column.key,
    label: column.header,
    aliases: [column.header, ...(column.aliases || [])],
    mandatory: Boolean(column.mandatory),
    description: column.description || ''
  }));
}

function templateWidth(column) {
  return Math.max(14, Math.min(34, (column.header || '').length + 4));
}

function styleTemplateHeader(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF153A5B' } };
  row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
}

async function createCatalogueTemplateWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Daksh Inventory v2';
  workbook.created = new Date();
  workbook.modified = new Date();

  const templateSheet = workbook.addWorksheet('Part Master Template');
  templateSheet.columns = CATALOGUE_TEMPLATE_COLUMNS.map((column) => ({
    header: column.header,
    key: column.key,
    width: templateWidth(column)
  }));
  templateSheet.views = [{ state: 'frozen', ySplit: 1 }];
  templateSheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: templateSheet.columnCount } };
  styleTemplateHeader(templateSheet.getRow(1));
  templateSheet.getRow(1).height = 22;

  const referenceSheet = workbook.addWorksheet('Required Fields');
  referenceSheet.columns = [
    { header: 'Column Name', key: 'label', width: 28 },
    { header: 'Required', key: 'mandatory', width: 12 },
    { header: 'Accepted Headers', key: 'aliases', width: 54 },
    { header: 'Description', key: 'description', width: 60 }
  ];
  catalogueFieldReference().forEach((column) => {
    referenceSheet.addRow({
      label: column.label,
      mandatory: column.mandatory ? 'Yes' : 'No',
      aliases: column.aliases.join(', '),
      description: column.description
    });
  });
  styleTemplateHeader(referenceSheet.getRow(1));
  referenceSheet.getRow(1).height = 22;
  referenceSheet.views = [{ state: 'frozen', ySplit: 1 }];
  referenceSheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, referenceSheet.rowCount), column: referenceSheet.columnCount } };
  referenceSheet.eachRow((row, rowNumber) => {
    if (rowNumber > 1) row.alignment = { vertical: 'top', wrapText: true };
  });

  return workbook;
}

async function createFailedRowsWorkbook(validation, nonImportedRows) {
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
  const rowsToWrite = nonImportedRows.length ? nonImportedRows : [{
    rowNumber: '',
    status: 'INFO',
    reason: 'No failed rows in this upload',
    originalValues: []
  }];
  rowsToWrite.forEach((row) => {
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
    reason: 'Database insert error',
    databaseError: reason
  }));
  const importedRowsCount = successfulRows.length;
  const insertedRowsCount = successfulRows.filter((row) => !existingSet.has(row.mapped.normalizedPartNumber)).length;
  const updatedRowsCount = importedRowsCount - insertedRowsCount;
  const fileRowsCount = validation.rows.length;
  const duplicateRowsCount = validation.duplicateRows.length;
  const skippedRowsCount = validation.skippedRows.length;
  const validationFailedRows = validation.failedRows.concat(validation.skippedRows);
  const failedRows = validationFailedRows.concat(databaseFailedRows);
  const nonImportedRows = failedRows.concat(validation.duplicateRows);
  const failureReasons = failureReasonCounts(nonImportedRows);
  const missingPartNumberCount = Number(failureReasons['Missing Part Number'] || 0);
  const blankMandatoryFieldsCount = Number(failureReasons['Blank mandatory fields'] || 0);
  const invalidMrpDlcCount = Number(failureReasons['Invalid MRP/DLC'] || 0);
  const duplicateConflictCount = Number(failureReasons['Duplicate conflict'] || 0);
  const databaseInsertErrorCount = Number(failureReasons['Database insert error'] || 0);
  const missingMandatoryFieldsCount = missingPartNumberCount + blankMandatoryFieldsCount;
  const accountedRowsCount = importedRowsCount + duplicateRowsCount + failedRows.length;
  const accountingGapCount = fileRowsCount - accountedRowsCount;
  return {
    fileRowsCount,
    totalRowsCount: fileRowsCount,
    importedRowsCount,
    savedRowsCount: importedRowsCount,
    failedRowsCount: failedRows.length,
    duplicateRowsCount,
    duplicateMergedRowsCount: duplicateRowsCount,
    skippedRowsCount,
    blankRowsCount: skippedRowsCount,
    insertedRowsCount,
    updatedRowsCount,
    missingMandatoryFieldsCount,
    missingPartNumberCount,
    blankMandatoryFieldsCount,
    invalidMrpDlcCount,
    duplicateConflictCount,
    databaseInsertErrorCount,
    priceHistoryRowsCount,
    priceHistoryFailedRowsCount,
    currentMasterRecordCount,
    finalMasterRecordCount: currentMasterRecordCount,
    masterCatalogueCount: currentMasterRecordCount,
    totalRowsUploaded: validation.rows.length,
    uploadedRowsCount: validation.rows.length,
    importedCount: importedRowsCount,
    uniquePartsCount: importedRowsCount,
    updatedDuplicateCount: updatedRowsCount,
    duplicateSkippedRows: duplicateRowsCount,
    skippedInvalidRowsCount: nonImportedRows.length,
    nonImportedRows,
    nonImportedRowsCount: nonImportedRows.length,
    failureReasons,
    accountedRowsCount,
    accountingGapCount,
    rowCountMismatch: fileRowsCount !== importedRowsCount
  };
}

function failureReasonCounts(rows = []) {
  return rows.reduce((counts, row) => {
    const reason = canonicalCatalogueFailureReason(row.reason);
    counts[reason] = (counts[reason] || 0) + 1;
    return counts;
  }, {});
}

async function importCatalogue(file, options = {}) {
  const sourceFileName = cleanText(file && file.originalname);
  const emit = createUploadProgressReporter(options.onProgress);

  if (emit) {
    emit({
      stage: 'received',
      percent: 0,
      processedRows: 0,
      totalRows: 0,
      savedRowsCount: 0,
      failedRowsCount: 0,
      message: 'File received. Parsing catalogue...'
    }, { force: true });
  }

  const parsed = await parseCatalogueUpload(file);

  if (emit) {
    emit({
      stage: 'parsed',
      percent: 3,
      processedRows: 0,
      totalRows: parsed.rows.length,
      savedRowsCount: 0,
      failedRowsCount: 0,
      message: `Parsed ${parsed.rows.length.toLocaleString('en-IN')} file rows`
    });
  }

  const validation = validateCatalogueRows(parsed, sourceFileName, { onProgress: options.onProgress });
  const validationIssueCount = validation.failedRows.length + validation.duplicateRows.length + validation.skippedRows.length;
  if (options.rejectOnValidationIssues && validationIssueCount) {
    const currentMasterRecordCount = await MasterCatalogue.countDocuments({});
    const summary = summaryFrom(validation, [], [], new Set(), 0, 0, currentMasterRecordCount);
    summary.failureDownloadId = await createFailedRowsWorkbook(validation, summary.nonImportedRows);
    delete summary.nonImportedRows;
    summary.blocked = true;
    if (emit) {
      emit({
        stage: 'validation-blocked',
        percent: 100,
        processedRows: validation.rows.length,
        totalRows: validation.rows.length,
        savedRowsCount: 0,
        failedRowsCount: validationIssueCount,
        message: 'Upload blocked by validation errors'
      }, { force: true });
    }
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
    if (emit) {
      emit({
        stage: 'deleting-old-catalogue',
        percent: 42,
        processedRows: 0,
        totalRows: 0,
        savedRowsCount: 0,
        failedRowsCount: 0,
        message: 'Deleting old catalogue...'
      }, { force: true });
    }
    const [deleted, deletedPrices] = await Promise.all([
      MasterCatalogue.deleteMany({}),
      PartPriceHistory.deleteMany({})
    ]);
    deletedOldRowsCount = deleted.deletedCount || 0;
    deletedPriceHistoryRowsCount = deletedPrices.deletedCount || 0;
    if (emit) {
      emit({
        stage: 'deleted-old-catalogue',
        percent: 48,
        processedRows: deletedOldRowsCount,
        totalRows: deletedOldRowsCount,
        savedRowsCount: 0,
        failedRowsCount: 0,
        deletedOldRowsCount,
        deletedPriceHistoryRowsCount,
        message: `Old catalogue deleted: ${deletedOldRowsCount.toLocaleString('en-IN')} rows`
      }, { force: true });
    }
  }

  if (emit) {
    emit({
      stage: 'writing-master',
      percent: 52,
      processedRows: 0,
      totalRows: validation.acceptedRows.length,
      savedRowsCount: 0,
      failedRowsCount: 0,
      message: `Saving ${validation.acceptedRows.length.toLocaleString('en-IN')} master rows...`
    }, { force: true });
  }

  const masterResult = await writeRowsInChunks(MasterCatalogue, validation.acceptedRows, (row) => ({
    updateOne: {
      filter: { normalizedPartNumber: row.mapped.normalizedPartNumber },
      update: { $set: row.mapped },
      upsert: true
    }
  }), {
    onProgress: options.onProgress,
    stage: 'writing-master',
    label: 'master rows',
    progressStart: 52,
    progressSpan: 28,
    startMessage: `Saving ${validation.acceptedRows.length.toLocaleString('en-IN')} master rows...`,
    completeMessage: 'Master rows saved'
  });
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
  if (emit) {
    emit({
      stage: 'writing-price-history',
      percent: 82,
      processedRows: 0,
      totalRows: priceRows.length,
      savedRowsCount: 0,
      failedRowsCount: 0,
      message: `Saving ${priceRows.length.toLocaleString('en-IN')} price history rows...`
    }, { force: true });
  }

  const priceResult = await writeRowsInChunks(PartPriceHistory, priceRows, (row) => ({
    updateOne: {
      filter: { normalizedPartNumber: row.price.normalizedPartNumber, effectiveFrom: null, effectiveTo: null },
      update: { $set: row.price },
      upsert: true
    }
  }), {
    onProgress: options.onProgress,
    stage: 'writing-price-history',
    label: 'price history rows',
    progressStart: 82,
    progressSpan: 10,
    startMessage: `Saving ${priceRows.length.toLocaleString('en-IN')} price history rows...`,
    completeMessage: 'Price history saved'
  });
  if (emit) {
    emit({
      stage: 'finalizing',
      percent: 95,
      processedRows: validation.rows.length,
      totalRows: validation.rows.length,
      savedRowsCount: masterResult.successfulRows.length,
      failedRowsCount: masterResult.failedRows.length + priceResult.failedRows.length,
      message: 'Finalizing upload summary...'
    }, { force: true });
  }
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
  if (emit) {
    emit({
      stage: 'completed',
      percent: 100,
      processedRows: validation.rows.length,
      totalRows: validation.rows.length,
      savedRowsCount: summary.savedRowsCount,
      failedRowsCount: summary.failedRowsCount,
      deletedOldRowsCount,
      deletedPriceHistoryRowsCount,
      message: 'Upload completed'
    }, { force: true });
  }
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
  CATALOGUE_OPTIONAL_COLUMNS,
  CATALOGUE_FIELD_DEFINITIONS,
  CATALOGUE_TEMPLATE_COLUMNS,
  MAX_UPLOAD_BYTES,
  appendUploadLog,
  cleanupFailureFiles,
  catalogueFieldReference,
  createCatalogueTemplateWorkbook,
  failureFilePath,
  importCatalogue,
  purgeFailureFiles,
  parseCatalogueUpload,
  validateCatalogueRows
};
