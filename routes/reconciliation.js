const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { jsPDF } = require('jspdf');
const autoTableModule = require('jspdf-autotable');
const DealerStock = require('../models/DealerStock');
const Inventory = require('../models/Inventory');
const auth = require('./auth');
const { validScanClause } = require('../utils/masterValidation');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });
const autoTable = autoTableModule.default || autoTableModule;

function clean(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function normalizePart(value) {
  return upper(value).replace(/\s+/g, '');
}

function numberValue(value) {
  const text = clean(value).replace(/[,₹$]/g, '');
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compactParams(query = {}) {
  return Object.fromEntries(Object.entries(query).filter(([, value]) => clean(value)));
}

function stockQtyExpression() {
  const qtyValue = { $ifNull: ['$qty', { $ifNull: ['$quantity', 0] }] };
  return {
    $cond: [
      { $in: [{ $ifNull: ['$scanType', '$type'] }, ['OUTWARD', 'FITTED', 'DAMAGE']] },
      { $multiply: [qtyValue, -1] },
      qtyValue
    ]
  };
}

const HEADER_ALIASES = {
  dealerCode: ['DEALER CODE', 'DEALERCODE', 'DEALER', 'LOCATION CODE'],
  partNumber: ['PART NUMBER', 'PART NO', 'PARTNO', 'PART', 'PART CODE', 'ITEM CODE', 'MATERIAL CODE'],
  partDescription: ['PART DESCRIPTION', 'DESCRIPTION', 'PART NAME', 'ITEM DESCRIPTION', 'MATERIAL DESCRIPTION'],
  productCategory: ['PRODUCT CATEGORY', 'CATEGORY', 'PRODUCT CAT', 'ITEM CATEGORY'],
  model: ['MODEL'],
  year: ['YEAR', 'MANUFACTURING YEAR', 'MFG YEAR'],
  productGroup: ['PRODUCT GROUP', 'GROUP'],
  partSubGroup: ['PRODUCT SUBGROUP', 'PART SUBGROUP', 'SUB GROUP', 'SUBGROUP'],
  mrp: ['MRP', 'PRICE', 'MAX RETAIL PRICE'],
  dlc: ['DLC', 'DEALER LANDING COST', 'LANDING COST'],
  systemQty: ['SYSTEM QUANTITY', 'SYSTEM QTY', 'DMS STOCK', 'DMS QTY', 'STOCK', 'QUANTITY', 'QTY', 'STOCK ON HAND'],
  systemBinLoc1: ['SYSTEM BIN LOC 1', 'SYSTEM BIN LOCATION 1', 'BIN LOC 1', 'BIN LOCATION 1', 'BIN 1'],
  systemBinLoc2: ['SYSTEM BIN LOC 2', 'SYSTEM BIN LOCATION 2', 'BIN LOC 2', 'BIN LOCATION 2', 'BIN 2'],
  systemBinLoc3: ['SYSTEM BIN LOC 3', 'SYSTEM BIN LOCATION 3', 'BIN LOC 3', 'BIN LOCATION 3', 'BIN 3'],
  reservedQty: ['RESERVED QTY', 'RESERVED QUANTITY', 'RESERVED']
};

function normalizeHeader(value) {
  return upper(value).replace(/[^A-Z0-9]+/g, ' ').trim();
}

function canonicalHeader(header) {
  const normalized = normalizeHeader(header);
  return Object.entries(HEADER_ALIASES).find(([, aliases]) => aliases.includes(normalized))?.[0] || '';
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
}

function rowsToStockRecords(rows, fallbackDealerCode, userName) {
  if (!rows.length) return { records: [], errors: ['File is empty'], columns: [] };
  const headers = rows[0].map(clean);
  const keys = headers.map(canonicalHeader);
  const missing = [];
  if (!keys.includes('partNumber')) missing.push('Part Number');
  if (!keys.includes('systemQty')) missing.push('System Quantity / DMS Stock');
  if (!keys.includes('dealerCode') && !fallbackDealerCode) missing.push('Dealer Code');
  if (missing.length) return { records: [], errors: [`Missing required column(s): ${missing.join(', ')}`], columns: headers };

  const byPart = new Map();
  rows.slice(1).forEach((values) => {
    const item = {};
    keys.forEach((key, index) => {
      if (key) item[key] = clean(values[index]);
    });
    item.dealerCode = upper(item.dealerCode || fallbackDealerCode);
    item.partNumber = upper(item.partNumber);
    item.normalizedPartNumber = normalizePart(item.partNumber);
    if (!item.dealerCode || !item.normalizedPartNumber) return;

    const existing = byPart.get(item.normalizedPartNumber) || {
      dealerCode: item.dealerCode,
      partNumber: item.partNumber,
      normalizedPartNumber: item.normalizedPartNumber,
      partDescription: '',
      productCategory: '',
      category: '',
      model: '',
      year: '',
      manufacturingYear: '',
      productGroup: '',
      partSubGroup: '',
      mrp: 0,
      dlc: 0,
      systemQty: 0,
      dmsStock: 0,
      systemBinLoc1: '',
      systemBinLoc2: '',
      systemBinLoc3: '',
      reservedQty: 0,
      uploadedBy: userName,
      uploadedAt: new Date()
    };

    existing.partDescription = existing.partDescription || item.partDescription || '';
    existing.productCategory = existing.productCategory || item.productCategory || '';
    existing.category = existing.category || item.productCategory || '';
    existing.model = existing.model || item.model || '';
    existing.year = existing.year || item.year || '';
    existing.manufacturingYear = existing.manufacturingYear || item.year || '';
    existing.productGroup = existing.productGroup || item.productGroup || '';
    existing.partSubGroup = existing.partSubGroup || item.partSubGroup || '';
    existing.mrp = existing.mrp || numberValue(item.mrp);
    existing.dlc = existing.dlc || numberValue(item.dlc);
    existing.systemQty += numberValue(item.systemQty);
    existing.dmsStock = existing.systemQty;
    existing.reservedQty += numberValue(item.reservedQty);
    existing.systemBinLoc1 = existing.systemBinLoc1 || item.systemBinLoc1 || '';
    existing.systemBinLoc2 = existing.systemBinLoc2 || item.systemBinLoc2 || '';
    existing.systemBinLoc3 = existing.systemBinLoc3 || item.systemBinLoc3 || '';
    byPart.set(existing.normalizedPartNumber, existing);
  });

  return { records: Array.from(byPart.values()), errors: [], columns: headers };
}

function publicStock(row) {
  return {
    id: String(row._id || ''),
    dealerCode: row.dealerCode,
    partNumber: row.partNumber,
    partDescription: row.partDescription,
    productCategory: row.productCategory || row.category,
    mrp: row.mrp || 0,
    dlc: row.dlc || 0,
    systemQty: row.systemQty || row.dmsStock || 0,
    dmsStock: row.systemQty || row.dmsStock || 0,
    systemBinLoc1: row.systemBinLoc1 || '',
    systemBinLoc2: row.systemBinLoc2 || '',
    systemBinLoc3: row.systemBinLoc3 || '',
    reservedQty: row.reservedQty || 0,
    uploadedAt: row.uploadedAt || row.updatedAt
  };
}

async function physicalRows(dealerCode, filters = {}) {
  const match = { dealerCode, ...validScanClause() };
  if (filters.partNumber) {
    const part = normalizePart(filters.partNumber);
    match.$and = [
      ...(match.$and || []),
      { $or: [{ normalizedPartNumber: part }, { partNumber: part }, { part: part }] }
    ];
  }
  if (filters.bin) {
    const binRegex = new RegExp(`^${clean(filters.bin).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    match.$and = [
      ...(match.$and || []),
      { $or: [{ binLocation: binRegex }, { bin: binRegex }] }
    ];
  }
  const rows = await Inventory.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $ifNull: ['$normalizedPartNumber', { $ifNull: ['$partNumber', '$part'] }] },
        partNumber: { $first: { $ifNull: ['$partNumber', '$part'] } },
        partDescription: { $first: { $ifNull: ['$partDescription', '$partName'] } },
        productCategory: { $first: { $ifNull: ['$productCategory', '$category'] } },
        model: { $first: '$model' },
        year: { $first: { $ifNull: ['$manufacturingYear', '$year'] } },
        productGroup: { $first: '$productGroup' },
        partSubGroup: { $first: '$partSubGroup' },
        mrp: { $max: '$mrp' },
        dlc: { $max: '$dlc' },
        physicalStock: { $sum: stockQtyExpression() },
        bins: { $addToSet: { $ifNull: ['$binLocation', '$bin'] } },
        rawProofs: { $addToSet: { $ifNull: ['$rawScan', { $ifNull: ['$upiNo', '$uniqueScanId'] }] } }
      }
    },
    { $match: { physicalStock: { $ne: 0 }, _id: { $nin: [null, ''] } } }
  ]);
  return rows;
}

function stockFilter(row, filters = {}) {
  if (filters.partNumber && normalizePart(row.partNumber) !== normalizePart(filters.partNumber)) return false;
  if (filters.category && !upper(row.productCategory || row.category).includes(upper(filters.category))) return false;
  if (filters.bin) {
    const bins = [row.bin, row.systemBinLoc1, row.systemBinLoc2, row.systemBinLoc3].map(upper);
    if (!bins.some((bin) => bin.includes(upper(filters.bin)))) return false;
  }
  return true;
}

async function buildUploadedStockReport(query = {}) {
  const dealerCode = upper(query.dealerCode);
  if (!dealerCode || dealerCode === 'ALL') return { summary: {}, rows: [], stockCount: 0, message: 'Select Dealer Code to view reconciliation report' };
  const filters = compactParams(query);
  const [stockRows, scannedRows] = await Promise.all([
    DealerStock.find({ dealerCode }).sort({ partNumber: 1 }).lean(),
    physicalRows(dealerCode, filters)
  ]);
  const physicalByPart = new Map(scannedRows.map((row) => [normalizePart(row._id || row.partNumber), row]));
  const usedPhysicalKeys = new Set();
  const rows = stockRows.filter((row) => stockFilter(row, filters)).map((stock) => {
    const key = normalizePart(stock.normalizedPartNumber || stock.partNumber);
    const physical = physicalByPart.get(key);
    if (physical) usedPhysicalKeys.add(key);
    const dmsStock = Number(stock.systemQty || stock.dmsStock || 0);
    const physicalStock = Number((physical && physical.physicalStock) || 0);
    const netDifference = physicalStock - dmsStock;
    const mrp = Number(stock.mrp || (physical && physical.mrp) || 0);
    const dlc = Number(stock.dlc || (physical && physical.dlc) || 0);
    return {
      partNo: stock.partNumber,
      partNumber: stock.partNumber,
      partDescription: stock.partDescription || (physical && physical.partDescription) || '',
      model: stock.model || (physical && physical.model) || '',
      manufacturingYear: stock.manufacturingYear || stock.year || (physical && physical.year) || '',
      year: stock.year || stock.manufacturingYear || (physical && physical.year) || '',
      category: stock.category || stock.productCategory || (physical && physical.productCategory) || '',
      productCategory: stock.productCategory || stock.category || (physical && physical.productCategory) || '',
      mrp,
      dlc,
      productGroup: stock.productGroup || (physical && physical.productGroup) || '',
      partSubGroup: stock.partSubGroup || (physical && physical.partSubGroup) || '',
      bin: [stock.systemBinLoc1, stock.systemBinLoc2, stock.systemBinLoc3].filter(Boolean).join(', ') || ((physical && physical.bins || []).filter(Boolean).join(', ')),
      dmsStock,
      physicalStock,
      excess: Math.max(netDifference, 0),
      short: Math.max(netDifference * -1, 0),
      netDifference,
      varianceMrp: netDifference * mrp,
      varianceDlc: netDifference * dlc,
      status: netDifference === 0 ? 'MATCHED' : netDifference > 0 ? 'EXCESS' : 'SHORT',
      rawScanProof: ((physical && physical.rawProofs) || []).filter(Boolean).slice(0, 4).join(' | ')
    };
  });

  scannedRows.forEach((physical) => {
    const key = normalizePart(physical._id || physical.partNumber);
    if (usedPhysicalKeys.has(key)) return;
    const row = {
      partNo: physical.partNumber,
      partNumber: physical.partNumber,
      partDescription: physical.partDescription || '',
      model: physical.model || '',
      manufacturingYear: physical.year || '',
      year: physical.year || '',
      category: physical.productCategory || '',
      productCategory: physical.productCategory || '',
      mrp: Number(physical.mrp || 0),
      dlc: Number(physical.dlc || 0),
      productGroup: physical.productGroup || '',
      partSubGroup: physical.partSubGroup || '',
      bin: (physical.bins || []).filter(Boolean).join(', '),
      dmsStock: 0,
      physicalStock: Number(physical.physicalStock || 0),
      excess: Math.max(Number(physical.physicalStock || 0), 0),
      short: 0,
      netDifference: Number(physical.physicalStock || 0),
      varianceMrp: Number(physical.physicalStock || 0) * Number(physical.mrp || 0),
      varianceDlc: Number(physical.physicalStock || 0) * Number(physical.dlc || 0),
      status: 'EXCESS',
      rawScanProof: (physical.rawProofs || []).filter(Boolean).slice(0, 4).join(' | ')
    };
    if (stockFilter(row, filters)) rows.push(row);
  });

  rows.sort((a, b) => String(a.partNo || '').localeCompare(String(b.partNo || ''), undefined, { numeric: true, sensitivity: 'base' }));
  const summary = {
    dmsStock: rows.reduce((sum, row) => sum + Number(row.dmsStock || 0), 0),
    physicalStock: rows.reduce((sum, row) => sum + Number(row.physicalStock || 0), 0),
    excess: rows.reduce((sum, row) => sum + Number(row.excess || 0), 0),
    short: rows.reduce((sum, row) => sum + Number(row.short || 0), 0),
    netDifference: rows.reduce((sum, row) => sum + Number(row.netDifference || 0), 0),
    varianceMrp: rows.reduce((sum, row) => sum + Number(row.varianceMrp || 0), 0),
    varianceDlc: rows.reduce((sum, row) => sum + Number(row.varianceDlc || 0), 0)
  };
  return { summary, rows, stockCount: stockRows.length, message: stockRows.length ? '' : 'No dealer DMS stock uploaded for selected dealer' };
}

function exportColumns() {
  return [
    { header: 'Part Number', key: 'partNo', width: 18 },
    { header: 'Part Description', key: 'partDescription', width: 32 },
    { header: 'Model', key: 'model', width: 14 },
    { header: 'Year', key: 'manufacturingYear', width: 12 },
    { header: 'Category', key: 'productCategory', width: 20 },
    { header: 'MRP', key: 'mrp', width: 12 },
    { header: 'DLC', key: 'dlc', width: 12 },
    { header: 'Product Group', key: 'productGroup', width: 18 },
    { header: 'Bin', key: 'bin', width: 22 },
    { header: 'DMS Stock', key: 'dmsStock', width: 12 },
    { header: 'Physical', key: 'physicalStock', width: 12 },
    { header: 'Excess', key: 'excess', width: 12 },
    { header: 'Short', key: 'short', width: 12 },
    { header: 'Net', key: 'netDifference', width: 12 },
    { header: 'Variance on MRP', key: 'varianceMrp', width: 18 },
    { header: 'Variance on DLC', key: 'varianceDlc', width: 18 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Raw Proof', key: 'rawScanProof', width: 44 }
  ];
}

async function sendReportExport(res, report, format) {
  const rows = report.rows || [];
  if (format === 'csv') {
    const columns = exportColumns();
    const csv = [
      columns.map((column) => `"${column.header}"`).join(','),
      ...rows.map((row) => columns.map((column) => `"${clean(row[column.key]).replace(/"/g, '""')}"`).join(','))
    ].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="Daksh_Reconciliation.csv"');
    return res.send(csv);
  }
  if (format === 'excel' || format === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Reconciliation');
    sheet.columns = exportColumns();
    rows.forEach((row) => sheet.addRow(row));
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF153A5B' } };
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Daksh_Reconciliation.xlsx"');
    return res.send(Buffer.from(buffer));
  }
  if (format === 'pdf') {
    const doc = new jsPDF({ orientation: 'landscape' });
    doc.setFontSize(14);
    doc.text('DAKSH INVENTORY SYSTEM - Dealer Reconciliation', 14, 15);
    autoTable(doc, {
      startY: 24,
      head: [['Part Number', 'Part Description', 'Model', 'Year', 'Category', 'MRP', 'DLC', 'Product Group', 'Bin', 'DMS', 'Physical', 'Excess', 'Short', 'Net', 'Status']],
      body: rows.slice(0, 500).map((row) => [row.partNo, row.partDescription, row.model, row.manufacturingYear, row.productCategory, row.mrp, row.dlc, row.productGroup, row.bin, row.dmsStock, row.physicalStock, row.excess, row.short, row.netDifference, row.status]),
      styles: { fontSize: 7, cellPadding: 2 },
      headStyles: { fillColor: [21, 58, 91] }
    });
    const pdf = Buffer.from(doc.output('arraybuffer'));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="Daksh_Reconciliation.pdf"');
    return res.send(pdf);
  }
  return null;
}

async function reconciliationReportHandler(req, res) {
  try {
    const report = await buildUploadedStockReport(req.query);
    if (req.query.format) return sendReportExport(res, report, req.query.format);
    return res.json({ success: true, ...report });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

router.post('/upload-stock', auth.requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Upload DMS stock Excel/CSV file' });
    const fallbackDealerCode = upper(req.body.dealerCode);
    const rows = await readUploadedRows(req.file);
    const parsed = rowsToStockRecords(rows, fallbackDealerCode, (req.user && (req.user.name || req.user.username || req.user.email)) || 'System');
    if (parsed.errors.length) return res.status(400).json({ success: false, message: parsed.errors.join('; '), columns: parsed.columns });
    const dealerCode = upper(fallbackDealerCode || parsed.records[0]?.dealerCode);
    if (!dealerCode) return res.status(400).json({ success: false, message: 'Dealer Code is required' });
    const records = parsed.records.map((record) => ({ ...record, dealerCode }));
    await DealerStock.deleteMany({ dealerCode });
    if (records.length) await DealerStock.insertMany(records, { ordered: false });
    return res.json({
      success: true,
      dealerCode,
      savedCount: records.length,
      preview: records.slice(0, 100).map(publicStock),
      columns: parsed.columns,
      message: `Saved ${records.length} DMS stock rows for ${dealerCode}`
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/stock-preview', auth.requireAuth, async (req, res) => {
  try {
    const dealerCode = upper(req.query.dealerCode);
    if (!dealerCode || dealerCode === 'ALL') return res.status(400).json({ success: false, message: 'Dealer Code is required' });
    const rows = await DealerStock.find({ dealerCode }).sort({ partNumber: 1 }).limit(500).lean();
    const total = await DealerStock.countDocuments({ dealerCode });
    return res.json({
      success: true,
      dealerCode,
      total,
      summary: {
        rows: total,
        dmsStock: rows.reduce((sum, row) => sum + Number(row.systemQty || row.dmsStock || 0), 0)
      },
      stock: rows.map(publicStock)
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/stock', auth.requireAuth, async (req, res) => {
  try {
    const dealerCode = upper(req.query.dealerCode);
    if (!dealerCode || dealerCode === 'ALL') return res.status(400).json({ success: false, message: 'Dealer Code is required' });
    const result = await DealerStock.deleteMany({ dealerCode });
    return res.json({ success: true, dealerCode, deletedCount: result.deletedCount || 0, message: `Deleted old DMS stock for ${dealerCode}` });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/report', auth.requireAuth, reconciliationReportHandler);
router.get('/', auth.requireAuth, reconciliationReportHandler);

router.post('/reprocess', auth.requireAuth, async (req, res) => {
  try {
    const report = await buildUploadedStockReport(req.query);
    return res.json({ success: true, dealerCode: upper(req.query.dealerCode), summary: report.summary, rows: report.rows.slice(0, 500), message: 'Reconciliation reprocessed' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
