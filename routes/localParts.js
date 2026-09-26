const express = require('express');
const ExcelJS = require('exceljs');
const { jsPDF } = require('jspdf');
const autoTableModule = require('jspdf-autotable');
const auth = require('./auth');
const { createLocalPartService, LocalPartError } = require('../services/LocalPartService');
const { invalidateCache } = require('../utils/reportCache');

const router = express.Router();
const service = createLocalPartService();
const autoTable = autoTableModule.default || autoTableModule;

const LOCAL_PART_REPORT_COLUMNS = [
  { header: 'Serial Number', key: 'serialNumber', width: 14 },
  { header: 'Dealer Code', key: 'dealerCode', width: 16 },
  { header: 'Dealer Name', key: 'dealerName', width: 28 },
  { header: 'Reference Audit ID', key: 'referenceAuditId', width: 22 },
  { header: 'Entry Date', key: 'entryDate', width: 14 },
  { header: 'Entry Time', key: 'entryTime', width: 16 },
  { header: 'Part Number', key: 'partNumber', width: 20 },
  { header: 'Part Description', key: 'partDescription', width: 36 },
  { header: 'Quantity', key: 'quantity', width: 13, numberFormat: '#,##0.000' },
  { header: 'MRP', key: 'mrp', width: 13, numberFormat: '#,##0.00' },
  { header: 'Total MRP Value', key: 'totalMrpValue', width: 19, numberFormat: '#,##0.00' },
  { header: 'DLC', key: 'dlc', width: 13, numberFormat: '#,##0.00' },
  { header: 'Total DLC Value', key: 'totalDlcValue', width: 19, numberFormat: '#,##0.00' },
  { header: 'Entered By', key: 'enteredByName', width: 22 },
  { header: 'Remarks', key: 'remarks', width: 34 },
  { header: 'Status', key: 'status', width: 14 },
  { header: 'Last Updated At', key: 'lastUpdatedAt', width: 24 }
];

function statusCode(error) {
  return error && (error.statusCode || error.status) ? Number(error.statusCode || error.status) : 500;
}

function sendError(res, error) {
  const code = error instanceof LocalPartError ? error.statusCode : statusCode(error);
  return res.status(code).json({ success: false, message: error.message || 'Local Part request failed' });
}

async function allowedDealerCodes(req, requestedDealerCode = '') {
  const dealerCode = String(requestedDealerCode || '').trim().toUpperCase();
  if (dealerCode && dealerCode !== 'ALL') {
    const access = await auth.validateUserDealerAccess(req.user, dealerCode);
    if (!access.allowed) throw new LocalPartError('Unauthorized dealer access', 403);
    return [access.requestedDealer];
  }
  if (req.user && req.user.role === 'admin') return null;
  const codes = await auth.userDealerAccessCodes(req.user || {});
  return codes.includes('ALL') ? null : codes;
}

async function assertEntryAccess(req, entry) {
  await allowedDealerCodes(req, entry.dealerCode);
  return entry;
}

function emitLocalPartUpdate(req, action, entry) {
  const io = req.io || (req.app && req.app.get('io'));
  if (!io) return;
  io.emit('local-parts:update', {
    action,
    id: entry.id,
    dealerCode: entry.dealerCode,
    referenceAuditId: entry.referenceAuditId || '',
    status: entry.status,
    updatedAt: entry.updatedAt || new Date().toISOString()
  });
}

function invalidateLocalPartCaches(entry = {}) {
  invalidateCache({
    namespaces: ['complete-audit-pack'],
    tags: ['local-parts', 'complete-audit-pack'],
    scope: {
      dealerCode: entry.dealerCode,
      auditId: entry.referenceAuditId || ''
    },
    clearInFlight: true
  });
}

function selectedColumns(query = {}) {
  const requested = String(query.columns || '').split(',').map((key) => key.trim()).filter(Boolean);
  if (!requested.length) return LOCAL_PART_REPORT_COLUMNS;
  const selected = new Set(requested);
  const columns = LOCAL_PART_REPORT_COLUMNS.filter((column) => selected.has(column.key));
  return columns.length ? columns : LOCAL_PART_REPORT_COLUMNS;
}

function addLocalPartsWorksheet(workbook, report, columns) {
  const sheet = workbook.addWorksheet('Local Parts Report', {
    views: [{ state: 'frozen', ySplit: 5, showGridLines: false }]
  });
  sheet.mergeCells(1, 1, 1, columns.length);
  sheet.getCell(1, 1).value = 'DAKSH INVENTORY - LOCAL PARTS REPORT';
  sheet.getCell(1, 1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 15 };
  sheet.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12345B' } };
  sheet.getCell(1, 1).alignment = { horizontal: 'left', vertical: 'middle' };
  sheet.getRow(1).height = 30;
  sheet.mergeCells(2, 1, 2, columns.length);
  sheet.getCell(2, 1).value = `Generated: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;
  sheet.mergeCells(3, 1, 3, columns.length);
  sheet.getCell(3, 1).value = `Rows: ${report.summary.totalRows} | Total Quantity: ${report.summary.grandTotalQuantity.toFixed(3)} | Total MRP Value: ${report.summary.grandTotalMrpValue.toFixed(2)} | Total DLC Value: ${report.summary.grandTotalDlcValue.toFixed(2)}`;
  const headerRow = sheet.getRow(5);
  columns.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = column.header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4E89' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    sheet.getColumn(index + 1).width = column.width;
  });
  report.entries.forEach((entry) => {
    const row = sheet.addRow(columns.map((column) => entry[column.key] ?? ''));
    columns.forEach((column, index) => {
      if (column.numberFormat) row.getCell(index + 1).numFmt = column.numberFormat;
      row.getCell(index + 1).alignment = { vertical: 'top', wrapText: ['partDescription', 'remarks'].includes(column.key) };
    });
  });
  sheet.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5, column: columns.length } };
  return sheet;
}

async function sendExcel(res, report, query) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Daksh Inventory';
  workbook.created = new Date();
  const columns = selectedColumns(query);
  addLocalPartsWorksheet(workbook, report, columns);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="Local_Parts_Report.xlsx"');
  res.setHeader('Cache-Control', 'private, no-store');
  return res.send(buffer);
}

function sendPdf(res, report, query) {
  const columns = selectedColumns(query);
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a3' });
  doc.setFontSize(15);
  doc.text('DAKSH INVENTORY - LOCAL PARTS REPORT', 14, 14);
  doc.setFontSize(8);
  doc.text(`Rows: ${report.summary.totalRows} | Total Quantity: ${report.summary.grandTotalQuantity.toFixed(3)} | Total MRP Value: ${report.summary.grandTotalMrpValue.toFixed(2)} | Total DLC Value: ${report.summary.grandTotalDlcValue.toFixed(2)}`, 14, 21);
  autoTable(doc, {
    startY: 27,
    head: [columns.map((column) => column.header)],
    body: report.entries.map((entry) => columns.map((column) => entry[column.key] ?? '')),
    styles: { fontSize: 6.2, cellPadding: 1.2, overflow: 'linebreak' },
    headStyles: { fillColor: [29, 78, 137], textColor: 255 },
    alternateRowStyles: { fillColor: [246, 249, 253] },
    margin: { left: 10, right: 10 }
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="Local_Parts_Report.pdf"');
  res.setHeader('Cache-Control', 'private, no-store');
  return res.send(Buffer.from(doc.output('arraybuffer')));
}

router.post('/', auth.requireAuth, async (req, res) => {
  try {
    await allowedDealerCodes(req, req.body && req.body.dealerCode);
    const entry = await service.create(req.body || {}, req.user);
    invalidateLocalPartCaches(entry);
    emitLocalPartUpdate(req, 'created', entry);
    return res.status(201).json({ success: true, entry, message: 'Local Part saved successfully' });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/', auth.requireAuth, async (req, res) => {
  try {
    const accessCodes = await allowedDealerCodes(req, req.query.dealerCode);
    const result = await service.list(req.query, { allowedDealerCodes: accessCodes });
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/:id', auth.requireAuth, async (req, res) => {
  try {
    const entry = await service.getById(req.params.id);
    await assertEntryAccess(req, entry);
    return res.json({ success: true, entry });
  } catch (error) {
    return sendError(res, error);
  }
});

router.put('/:id', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const current = await service.getById(req.params.id);
    await assertEntryAccess(req, current);
    await allowedDealerCodes(req, req.body && req.body.dealerCode);
    const entry = await service.update(req.params.id, req.body || {}, req.user);
    invalidateLocalPartCaches(entry);
    emitLocalPartUpdate(req, 'updated', entry);
    return res.json({ success: true, entry, message: 'Local Part updated successfully' });
  } catch (error) {
    return sendError(res, error);
  }
});

router.delete('/:id', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const current = await service.getById(req.params.id);
    await assertEntryAccess(req, current);
    const entry = await service.softDelete(req.params.id, req.user);
    invalidateLocalPartCaches(entry);
    emitLocalPartUpdate(req, 'deleted', entry);
    return res.json({ success: true, entry, message: 'Local Part deleted' });
  } catch (error) {
    return sendError(res, error);
  }
});

async function reportHandler(req, res) {
  try {
    const accessCodes = await allowedDealerCodes(req, req.query.dealerCode);
    const format = String(req.query.format || '').trim().toLowerCase();
    const result = await service.list(req.query, {
      allowedDealerCodes: accessCodes,
      all: format === 'excel' || format === 'xlsx' || format === 'pdf'
    });
    if (format === 'excel' || format === 'xlsx') return sendExcel(res, result, req.query);
    if (format === 'pdf') return sendPdf(res, result, req.query);
    return res.json({
      success: true,
      type: 'local-parts',
      title: 'Local Parts Report',
      columns: LOCAL_PART_REPORT_COLUMNS.map(({ header, key }) => ({ header, key })),
      rows: result.entries,
      totalRows: result.totalRows,
      pagination: result.pagination,
      summary: result.summary,
      grandTotal: result.summary,
      message: result.entries.length ? '' : 'No Local Part entries found for selected filter'
    });
  } catch (error) {
    return sendError(res, error);
  }
}

async function buildReportData(query = {}, user = {}) {
  const accessCodes = await allowedDealerCodes({ user }, query.dealerCode);
  return service.list(query, {
    allowedDealerCodes: accessCodes,
    all: true
  });
}

module.exports = router;
module.exports.LOCAL_PART_REPORT_COLUMNS = LOCAL_PART_REPORT_COLUMNS;
module.exports.buildReportData = buildReportData;
module.exports.reportHandler = reportHandler;
module.exports.selectedColumns = selectedColumns;
