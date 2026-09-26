const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { finished } = require('stream/promises');
const { prisma } = require('../services/prisma');

const EXPORT_ERROR = 'Complete Part Master could not be downloaded. Please try again or contact administrator.';
const EXPORT_COLUMNS = [
  { header: 'Part Number', key: 'partNumber', width: 24, style: { numFmt: '@' } },
  { header: 'Part Description', key: 'partDescription', width: 42 },
  { header: 'Active Flag', key: 'activeFlag', width: 14 },
  { header: 'Product Category', key: 'productCategory', width: 22 },
  { header: 'Product Group', key: 'productGroup', width: 24 },
  { header: 'Product Group SubGroup', key: 'partSubGroup', width: 26 },
  { header: 'Model', key: 'model', width: 24, style: { numFmt: '@' } },
  { header: 'Manufacturing Year', key: 'manufacturingYear', width: 22, style: { numFmt: '@' } },
  { header: 'Product Type', key: 'productType', width: 18 },
  { header: 'MRP', key: 'mrp', width: 14, style: { numFmt: '#,##0.00' } },
  { header: 'DLP', key: 'dlc', width: 14, style: { numFmt: '#,##0.00' } },
  { header: 'Superceeded By', key: 'superceededBy', width: 20 },
  { header: 'Part Group', key: 'partGroup', width: 20 },
  { header: 'GST Category', key: 'gstCategory', width: 18 },
  { header: 'Split Flag', key: 'splitFlag', width: 14 }
];

function textCell(value) {
  return ['string', 'number', 'boolean'].includes(typeof value) ? String(value) : '';
}

function priceCell(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'object') return '';
  const number = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(number) ? number : '';
}

function exportRow(record) {
  const data = record.data && typeof record.data === 'object' ? record.data : {};
  const row = {};
  for (const { key } of EXPORT_COLUMNS) row[key] = textCell(data[key]);
  row.partNumber = textCell(data.partNumber ?? record.partNumber ?? data.partNo ?? data.normalizedPartNumber ?? record.normalizedPartNumber);
  row.partDescription = textCell(data.partDescription ?? data.partName);
  row.productCategory = textCell(data.productCategory ?? data.category);
  row.manufacturingYear = textCell(data.manufacturingYear ?? data.year);
  row.mrp = priceCell(data.mrp);
  row.dlc = priceCell(data.dlc ?? data.dlp);
  return row;
}

// Count and cursor share a repeatable-read snapshot, so concurrent uploads
// cannot add, remove, or duplicate rows partway through an export.
async function writePartMasterWorkbook(db, file, { signal, stats = {} } = {}) {
  const stream = fs.createWriteStream(file);
  const streamFinished = finished(stream);
  streamFinished.catch(() => {});
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useSharedStrings: false, useStyles: true, zip: { zlib: { level: 1 } } });
  workbook.creator = 'Daksh Inventory';
  const sheet = workbook.addWorksheet('Part Master', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = EXPORT_COLUMNS;
  sheet.autoFilter = 'A1:O1';
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF153A5B' } };
  sheet.getRow(1).commit();
  stats.exported = 0;
  stats.queryMs = 0;
  const started = Date.now();
  try {
    let queryStarted = Date.now();
    const counts = await db.$queryRawUnsafe('SELECT COUNT(*)::int AS count FROM "mastercatalogues"');
    stats.expected = counts[0].count;
    stats.queryMs += Date.now() - queryStarted;
    if (stats.expected > 1048575) throw new Error('Part Master exceeds the Excel worksheet row capacity');
    await db.$executeRawUnsafe('DECLARE daksh_part_master_export NO SCROLL CURSOR FOR SELECT "id", "partNumber", "normalizedPartNumber", "data" FROM "mastercatalogues" ORDER BY "partNumber", "id"');
    while (true) {
      if (signal?.aborted) throw new Error('Part Master export cancelled by client');
      queryStarted = Date.now();
      const rows = await db.$queryRawUnsafe('FETCH FORWARD 5000 FROM daksh_part_master_export');
      stats.queryMs += Date.now() - queryStarted;
      if (!rows.length) break;
      for (const row of rows) {
        sheet.addRow(exportRow(row)).commit();
        stats.exported += 1;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    await db.$executeRawUnsafe('CLOSE daksh_part_master_export');
    if (stats.exported !== stats.expected) throw new Error(`Export count mismatch: ${stats.expected} expected, ${stats.exported} written`);
    sheet.commit();
    await workbook.commit();
    await streamFinished;
    return stats;
  } catch (error) {
    workbook.zip.abort();
    stream.destroy();
    await streamFinished.catch(() => {});
    throw error;
  } finally {
    stats.exportMs = Date.now() - started;
  }
}

async function createPartMasterExport({ signal, stats = {}, client = prisma } = {}) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'daksh-part-master-'));
  const file = path.join(directory, 'part-master.xlsx');
  const cleanup = async () => {
    await fs.promises.rm(file, { force: true });
    await fs.promises.rmdir(directory);
  };
  try {
    await client.$transaction(async (db) => {
      await db.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await writePartMasterWorkbook(db, file, { signal, stats });
    }, { isolationLevel: 'RepeatableRead', timeout: 120000, maxWait: 10000 });
    return { file, stats, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

const activeExports = new Set();

async function downloadCompletePartMaster(req, res) {
  const user = req.user?.id || req.user?.username || 'unknown';
  if (activeExports.has(user)) return res.status(409).json({ success: false, message: 'A complete Part Master download is already being prepared.' });
  activeExports.add(user);
  const stats = {};
  const started = Date.now();
  const controller = new AbortController();
  const cancel = () => { if (!res.writableFinished) controller.abort(); };
  res.once('close', cancel);
  let result;
  try {
    result = await createPartMasterExport({ signal: controller.signal, stats });
    if (controller.signal.aborted) throw new Error('Part Master export cancelled by client');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('X-Export-Record-Count', String(stats.exported));
    const filename = `Daksh_Complete_Part_Master_${new Date().toISOString().slice(0, 10)}.xlsx`;
    await new Promise((resolve, reject) => res.download(result.file, filename, (error) => error ? reject(error) : resolve()));
    console.info('[PART MASTER EXPORT]', { user, recordsExpected: stats.expected, recordsExported: stats.exported, status: 'SUCCESS', timeMs: Date.now() - started });
  } catch (error) {
    console.error('[PART-MASTER-EXPORT-ERROR]', { user, recordCount: stats.expected ?? null, recordsExported: stats.exported || 0, queryMs: stats.queryMs || 0, exportMs: stats.exportMs || Date.now() - started, error: error.message, stack: error.stack });
    if (!res.headersSent && !res.destroyed) res.status(500).json({ success: false, message: EXPORT_ERROR });
    else if (!res.destroyed) res.destroy(error);
  } finally {
    res.removeListener('close', cancel);
    activeExports.delete(user);
    if (result) await result.cleanup().catch((error) => console.error('[PART-MASTER-EXPORT-ERROR] Temporary file cleanup:', error.message));
  }
}

module.exports = { EXPORT_COLUMNS, EXPORT_ERROR, exportRow, writePartMasterWorkbook, createPartMasterExport, downloadCompletePartMaster };
