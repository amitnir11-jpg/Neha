const express = require('express');
const QRCode = require('qrcode');
const { jsPDF } = require('jspdf');
const ExcelJS = require('exceljs');
const auth = require('./auth');
const Bin = require('../models/Bin');
const Inventory = require('../models/Inventory');
const MasterPart = require('../models/MasterPart');
const { serverInfo } = require('../utils/network');
const { getActiveAudit, publicAudit } = require('../utils/audit');

const router = express.Router();

function paperConfig(input = {}) {
  const paperSize = String(input.paperSize || 'a4').toLowerCase();
  const orientation = String(input.orientation || 'portrait').toLowerCase() === 'landscape' ? 'landscape' : 'portrait';
  const presets = {
    a4: [210, 297],
    a5: [148, 210],
    letter: [216, 279],
    legal: [216, 356],
    thermal80: [80, 200],
    thermal58: [58, 200]
  };
  let size = presets[paperSize] || presets.a4;
  if (paperSize === 'custom') {
    const width = Number(input.paperWidthMm || input.widthMm || 210);
    const height = Number(input.paperHeightMm || input.heightMm || 297);
    size = [Math.max(40, width), Math.max(40, height)];
  }
  if (orientation === 'landscape' && size[0] < size[1]) size = [size[1], size[0]];
  if (orientation === 'portrait' && size[0] > size[1]) size = [size[1], size[0]];
  return { orientation, size };
}

function positiveNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function clean(value) {
  return String(value || '').trim();
}

function cleanCode(value) {
  return clean(value).toUpperCase();
}

function escapeRegex(value) {
  return clean(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function naturalBinSort(a, b) {
  return clean(a.binCode || a.binLocation || a).localeCompare(clean(b.binCode || b.binLocation || b), undefined, { numeric: true, sensitivity: 'base' });
}

function labelSettings(input = {}) {
  return {
    paper: paperConfig(input),
    labelWidth: positiveNumber(input.labelWidthMm || input.labelWidth, 70, 20, 210),
    labelHeight: positiveNumber(input.labelHeightMm || input.labelHeight, 28, 12, 140),
    qrSize: positiveNumber(input.qrSizeMm || input.qrSize, 20, 8, 90),
    fontSize: positiveNumber(input.fontSize, 8, 5, 24),
    partFontSize: positiveNumber(input.partFontSize, 11, 6, 32),
    descriptionFontSize: positiveNumber(input.descriptionFontSize, 7, 5, 20),
    margin: positiveNumber(input.marginMm || input.margin, 8, 1, 40),
    gap: positiveNumber(input.gapMm || input.gap, 3, 0, 30),
    labelsPerRow: Math.max(1, Math.min(Number(input.labelsPerRow || input.columns || 2), 8))
  };
}

function rangeBins(start, end) {
  const from = clean(start);
  const to = clean(end);
  const startMatch = from.match(/^([A-Za-z-_\s]*?)(\d+)$/);
  const endMatch = to.match(/^([A-Za-z-_\s]*?)(\d+)$/);
  if (!startMatch || !endMatch || startMatch[1].toUpperCase() !== endMatch[1].toUpperCase()) return [];
  const prefix = startMatch[1];
  const first = Number(startMatch[2]);
  const last = Number(endMatch[2]);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return [];
  const min = Math.min(first, last);
  const max = Math.max(first, last);
  const width = Math.max(startMatch[2].length, endMatch[2].length);
  return Array.from({ length: max - min + 1 }, (_, index) => `${prefix}${String(min + index).padStart(width, '0')}`);
}

function binQrValue(item) {
  return JSON.stringify({
    type: 'BIN',
    dealerCode: cleanCode(item.dealerCode),
    binLocation: cleanCode(item.binLocation || item.binCode)
  });
}

function partQrValue(item, mode = 'part') {
  return JSON.stringify({
    type: mode === 'combined' ? 'BIN_PART' : 'PART',
    dealerCode: cleanCode(item.dealerCode),
    binLocation: cleanCode(item.binLocation || item.bin),
    partNumber: cleanCode(item.partNumber || item.partNo || item.part)
  });
}

function normalizePart(item = {}) {
  return {
    partNumber: cleanCode(item.partNumber || item.partNo || item.part),
    partDescription: clean(item.partDescription || item.partName),
    category: clean(item.productCategory || item.category),
    binLocation: cleanCode(item.binLocation || item.bin),
    dealerCode: cleanCode(item.dealerCode),
    qty: Number(item.qty || item.quantity || item.openingStockQty || 0)
  };
}

async function findBins({ dealerCode, category, selectedBins, rangeFrom, rangeTo }) {
  const dealer = cleanCode(dealerCode);
  if (!dealer) return [];
  const query = { active: { $ne: false } };
  query.dealerCode = dealer;
  if (category) query.category = { $regex: escapeRegex(category), $options: 'i' };
  let bins = await Bin.find(query).sort({ binCode: 1 }).lean();

  const selected = Array.isArray(selectedBins) ? selectedBins.map(cleanCode).filter(Boolean) : [];
  const range = rangeBins(rangeFrom, rangeTo).map(cleanCode);
  const wanted = new Set([...selected, ...range]);
  if (wanted.size) {
    bins = bins.filter((bin) => wanted.has(cleanCode(bin.binCode)));
    range.forEach((binCode) => {
      if (!bins.some((bin) => cleanCode(bin.binCode) === binCode)) {
        bins.push({ binCode, binName: binCode, dealerCode: dealer, category: clean(category), active: true });
      }
    });
  }

  return bins
    .map((bin) => ({
      binCode: cleanCode(bin.binCode),
      binLocation: cleanCode(bin.binCode),
      binName: clean(bin.binName),
      dealerCode: cleanCode(bin.dealerCode || dealer),
      category: clean(bin.category)
    }))
    .sort(naturalBinSort);
}

async function findBinParts({ dealerCode, binLocation, category }) {
  const dealer = cleanCode(dealerCode);
  if (!dealer) return [];
  const bin = cleanCode(binLocation);
  const categoryText = clean(category);
  const binPattern = bin ? new RegExp(`^\\s*${escapeRegex(bin)}\\s*$`, 'i') : null;
  const binFilter = bin ? { $or: [{ binLocation: binPattern }, { bin: binPattern }] } : {};
  const dealerFilter = dealer ? { dealerCode: dealer } : {};
  const categoryFilter = categoryText ? { $or: [{ category: { $regex: escapeRegex(categoryText), $options: 'i' } }, { productCategory: { $regex: escapeRegex(categoryText), $options: 'i' } }] } : {};

  const [scanRows, masterRows] = await Promise.all([
    Inventory.find({ ...dealerFilter, ...binFilter, ...(categoryText ? { category: { $regex: escapeRegex(categoryText), $options: 'i' } } : {}) }).sort({ timestamp: -1 }).limit(2000).lean(),
    MasterPart.find({ ...dealerFilter, ...binFilter, ...categoryFilter }).sort({ partNo: 1 }).limit(5000).lean()
  ]);

  const byPart = new Map();
  masterRows.forEach((row) => {
    const part = normalizePart(row);
    if (part.partNumber) byPart.set(part.partNumber, part);
  });
  scanRows.forEach((row) => {
    const part = normalizePart(row);
    if (!part.partNumber) return;
    const existing = byPart.get(part.partNumber) || {};
    byPart.set(part.partNumber, {
      ...existing,
      ...part,
      partDescription: existing.partDescription || part.partDescription,
      category: existing.category || part.category,
      qty: Number(existing.qty || 0) + Number(part.qty || 0)
    });
  });
  return Array.from(byPart.values()).sort((a, b) => a.partNumber.localeCompare(b.partNumber, undefined, { numeric: true }));
}

function addWrappedText(doc, text, x, y, width, lineHeight, maxLines = 2) {
  const lines = doc.splitTextToSize(clean(text), width).slice(0, maxLines);
  lines.forEach((line, index) => doc.text(line, x, y + index * lineHeight));
}

async function renderLabelsPdf(items, input, labelType) {
  const settings = labelSettings(input);
  const doc = new jsPDF({ orientation: settings.paper.orientation, unit: 'mm', format: settings.paper.size });
  const usableWidth = settings.paper.size[0] - settings.margin * 2;
  const perRow = Math.max(1, Math.min(settings.labelsPerRow, Math.floor((usableWidth + settings.gap) / (settings.labelWidth + settings.gap)) || 1));
  const perPageRows = Math.max(1, Math.floor((settings.paper.size[1] - settings.margin * 2 + settings.gap) / (settings.labelHeight + settings.gap)));
  const perPage = perRow * perPageRows;

  for (let index = 0; index < items.length; index += 1) {
    if (index > 0 && index % perPage === 0) doc.addPage(settings.paper.size, settings.paper.orientation);
    const pageIndex = index % perPage;
    const col = pageIndex % perRow;
    const row = Math.floor(pageIndex / perRow);
    const x = settings.margin + col * (settings.labelWidth + settings.gap);
    const y = settings.margin + row * (settings.labelHeight + settings.gap);
    const item = items[index];
    const value = labelType === 'bin' ? binQrValue(item) : partQrValue(item, input.mode === 'combined' ? 'combined' : 'part');
    const dataUrl = await QRCode.toDataURL(value, { margin: 1, width: 260 });

    doc.setDrawColor(210);
    doc.roundedRect(x, y, settings.labelWidth, settings.labelHeight, 1.5, 1.5);
    doc.addImage(dataUrl, 'PNG', x + 2, y + 2, settings.qrSize, settings.qrSize);
    const textX = x + settings.qrSize + 5;
    const textWidth = settings.labelWidth - settings.qrSize - 8;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(labelType === 'bin' ? settings.partFontSize : settings.partFontSize);
    doc.text(labelType === 'bin' ? cleanCode(item.binLocation || item.binCode) : cleanCode(item.partNumber), textX, y + 6);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(settings.descriptionFontSize);
    if (labelType === 'bin') {
      doc.text(`Dealer: ${cleanCode(item.dealerCode)}`, textX, y + 12);
      if (item.category) doc.text(`Category: ${clean(item.category)}`, textX, y + 17);
    } else {
      addWrappedText(doc, item.partDescription, textX, y + 12, textWidth, 4, 2);
      doc.setFontSize(settings.fontSize);
      doc.text(`BIN: ${cleanCode(item.binLocation)}`, textX, y + settings.labelHeight - 8);
      doc.text(`Dealer: ${cleanCode(item.dealerCode)}`, textX, y + settings.labelHeight - 4);
      if (item.category) doc.text(clean(item.category).slice(0, 28), x + 2, y + settings.labelHeight - 3);
    }
  }

  return Buffer.from(doc.output('arraybuffer'));
}

async function attachQrImages(items, labelType, mode) {
  const output = [];
  for (const item of items) {
    const value = labelType === 'bin' ? binQrValue(item) : partQrValue(item, mode === 'combined' ? 'combined' : 'part');
    output.push({
      ...item,
      qrValue: value,
      dataUrl: await QRCode.toDataURL(value, { margin: 1, width: 180 })
    });
  }
  return output;
}

async function sendExcel(items, res, fileName) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Labels');
  sheet.columns = [
    { header: 'Part Number', key: 'partNumber', width: 22 },
    { header: 'Part Description', key: 'partDescription', width: 36 },
    { header: 'Product Category', key: 'category', width: 24 },
    { header: 'Bin Location', key: 'binLocation', width: 16 },
    { header: 'Dealer Code', key: 'dealerCode', width: 14 },
    { header: 'Qty', key: 'qty', width: 10 }
  ];
  items.forEach((item) => sheet.addRow(item));
  sheet.getRow(1).font = { bold: true };
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  return res.send(Buffer.from(buffer));
}

async function sendBinExcel(items, res) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Bin QR');
  sheet.columns = [
    { header: 'Bin Location', key: 'binLocation', width: 18 },
    { header: 'Bin Name', key: 'binName', width: 24 },
    { header: 'Product Category', key: 'category', width: 24 },
    { header: 'Dealer Code', key: 'dealerCode', width: 14 }
  ];
  items.forEach((item) => sheet.addRow(item));
  sheet.getRow(1).font = { bold: true };
  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="Daksh_Bin_QR_List.xlsx"');
  return res.send(Buffer.from(buffer));
}

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}

function makeZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  files.forEach((file) => {
    const name = Buffer.from(file.name);
    const data = file.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(0, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  });
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

async function sendQr(req, res, value, label) {
  const format = String(req.query.format || 'json').toLowerCase();
  if (!value) return res.status(400).json({ success: false, message: `${label} value is required` });

  if (format === 'svg') {
    const svg = await QRCode.toString(value, { type: 'svg', margin: 1, width: 220 });
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.send(svg);
  }

  const dataUrl = await QRCode.toDataURL(value, { margin: 1, width: 240 });
  return res.json({ success: true, label, value, dataUrl });
}

router.get('/bin', auth.requireAuth, async (req, res) => {
  try {
    return sendQr(req, res, String(req.query.bin || req.query.value || '').trim(), 'Bin QR');
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/part', auth.requireAuth, async (req, res) => {
  try {
    return sendQr(req, res, String(req.query.partNo || req.query.part || req.query.value || '').trim(), 'Part QR');
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/pairing', auth.requireAuth, async (req, res) => {
  try {
    const port = req.app.locals.activePort || process.env.PORT || 3001;
    const info = serverInfo(port);
    const activeAudit = await getActiveAudit();
    const pairService = req.app.get('qrPairService');
    const securePairing = pairService
      ? await pairService.createPairing({ user: req.user, activeAudit, req, deviceId: req.query.deviceId })
      : null;
    const pairing = securePairing ? securePairing.pairing : {
      serverIp: info.ip,
      port: info.port,
      serverUrl: info.serverUrl,
      healthUrl: info.healthUrl,
      connectUrl: info.connectUrl,
      syncUrl: info.syncUrl,
      authToken: '',
      deviceId: `PAIR-${Date.now()}`,
      sessionId: ''
    };
    const value = securePairing ? securePairing.value : JSON.stringify(pairing);
    const format = String(req.query.format || 'json').toLowerCase();
    if (format === 'svg') {
      const svg = await QRCode.toString(value, { type: 'svg', margin: 1, width: 220 });
      res.setHeader('Content-Type', 'image/svg+xml');
      return res.send(svg);
    }
    const dataUrl = securePairing ? securePairing.dataUrl : await QRCode.toDataURL(value, { margin: 1, width: 260 });
    return res.json({
      success: true,
      label: 'Mobile Pairing QR',
      value,
      dataUrl,
      pairing,
      sessionId: securePairing ? securePairing.sessionId : pairing.sessionId,
      expiresAt: securePairing ? securePairing.expiresAt : '',
      ip: info.ip,
      port: info.port,
      serverUrl: info.serverUrl,
      healthUrl: info.healthUrl,
      connectUrl: info.connectUrl,
      syncUrl: info.syncUrl,
      activeAudit: publicAudit(activeAudit),
      connectionStatus: activeAudit ? 'Ready for secure mobile pairing' : 'No active audit'
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/bins', auth.requireAuth, async (req, res) => {
  try {
    const bins = await findBins({
      dealerCode: req.query.dealerCode,
      category: req.query.category,
      selectedBins: clean(req.query.selectedBins).split(',').filter(Boolean),
      rangeFrom: req.query.rangeFrom,
      rangeTo: req.query.rangeTo
    });
    return res.json({ success: true, bins });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/bin-parts', auth.requireAuth, async (req, res) => {
  try {
    const parts = await findBinParts({
      dealerCode: req.query.dealerCode,
      binLocation: req.query.binLocation,
      category: req.query.category
    });
    return res.json({ success: true, parts });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/generate-bin-labels', auth.requireAuth, async (req, res) => {
  try {
    const bins = Array.isArray(req.body.items) && req.body.items.length
      ? req.body.items.map((item) => ({ ...item, binLocation: item.binLocation || item.binCode }))
      : await findBins(req.body);
    if (!bins.length) return res.status(400).json({ success: false, message: 'No bins found for selected filters' });

    const format = clean(req.body.format || 'pdf').toLowerCase();
    if (format === 'json') return res.json({ success: true, items: await attachQrImages(bins, 'bin', req.body.mode) });
    if (format === 'excel') return sendBinExcel(bins, res);
    if (format === 'zip') {
      const files = [];
      for (const bin of bins) {
        const value = binQrValue(bin);
        const dataUrl = await QRCode.toDataURL(value, { margin: 1, width: 360 });
        files.push({
          name: `BIN_${cleanCode(bin.binLocation || bin.binCode)}.png`,
          data: Buffer.from(dataUrl.split(',')[1], 'base64')
        });
      }
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="Daksh_Bin_QR_PNG.zip"');
      return res.send(makeZip(files));
    }

    const pdf = await renderLabelsPdf(bins, req.body, 'bin');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="Daksh_Bin_QR_Labels.pdf"');
    return res.send(pdf);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/generate-part-labels', auth.requireAuth, async (req, res) => {
  try {
    let parts = Array.isArray(req.body.items) && req.body.items.length
      ? req.body.items.map(normalizePart)
      : await findBinParts(req.body);
    let binLocations = Array.isArray(req.body.binLocations) ? req.body.binLocations : [];
    if (!binLocations.length && (Array.isArray(req.body.selectedBins) || req.body.rangeFrom || req.body.rangeTo)) {
      const bins = await findBins(req.body);
      binLocations = bins.map((bin) => bin.binLocation || bin.binCode);
    }
    if (binLocations.length) {
      const all = [];
      for (const binLocation of binLocations) {
        all.push(...await findBinParts({ ...req.body, binLocation }));
      }
      parts = all;
    }
    const seen = new Set();
    parts = parts.filter((part) => {
      const key = `${part.dealerCode}-${part.binLocation}-${part.partNumber}`;
      if (!part.partNumber || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!parts.length) return res.status(400).json({ success: false, message: 'No parts found for selected bin' });

    const format = clean(req.body.format || 'pdf').toLowerCase();
    if (format === 'json') return res.json({ success: true, items: await attachQrImages(parts, 'part', req.body.mode) });
    if (format === 'excel') return sendExcel(parts, res, 'Daksh_Part_Label_List.xlsx');
    if (format === 'zip') {
      const files = [];
      for (const part of parts) {
        const value = partQrValue(part, req.body.mode === 'combined' ? 'combined' : 'part');
        const dataUrl = await QRCode.toDataURL(value, { margin: 1, width: 360 });
        files.push({
          name: `${cleanCode(part.binLocation)}_${cleanCode(part.partNumber)}.png`.replace(/[\\/:*?"<>|]/g, '_'),
          data: Buffer.from(dataUrl.split(',')[1], 'base64')
        });
      }
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="Daksh_Part_Label_QR_PNG.zip"');
      return res.send(makeZip(files));
    }

    const pdf = await renderLabelsPdf(parts, req.body, 'part');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="Daksh_Part_Labels.pdf"');
    return res.send(pdf);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/bulk-pdf', auth.requireAuth, async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items.filter(Boolean) : [];
    if (!items.length) return res.status(400).json({ success: false, message: 'At least one QR item is required' });

    const paper = paperConfig(req.body);
    const margin = positiveNumber(req.body.marginMm, 10, 2, 40);
    const qrSize = positiveNumber(req.body.qrSizeMm, 44, 12, 120);
    const labelFontSize = positiveNumber(req.body.labelFontSize, 9, 6, 18);
    const columns = Math.max(1, Math.min(Number(req.body.columns || 2), 8));
    const labelGap = 6;
    const usableWidth = paper.size[0] - margin * 2;
    const cellWidth = usableWidth / columns;
    const cellHeight = qrSize + labelGap + labelFontSize * 0.8 + 8;
    const rowsPerPage = Math.max(1, Math.floor((paper.size[1] - margin * 2 - 12) / cellHeight));
    const perPage = columns * rowsPerPage;
    const doc = new jsPDF({ orientation: paper.orientation, unit: 'mm', format: paper.size });
    doc.setFontSize(14);
    doc.text('DAKSH INVENTORY SYSTEM - Bulk QR', margin, margin + 2);

    for (let index = 0; index < items.length; index += 1) {
      const value = String(items[index].value || items[index].partNo || items[index].bin || items[index]).trim();
      const label = String(items[index].label || value).trim();
      const dataUrl = await QRCode.toDataURL(value, { margin: 1, width: 260 });
      const pageIndex = index % perPage;
      const col = pageIndex % columns;
      const row = Math.floor(pageIndex / columns);
      if (index > 0 && pageIndex === 0) {
        doc.addPage(paper.size, paper.orientation);
        doc.setFontSize(14);
        doc.text('DAKSH INVENTORY SYSTEM - Bulk QR', margin, margin + 2);
      }
      const x = margin + col * cellWidth + Math.max(0, (cellWidth - qrSize) / 2);
      const y = margin + 12 + row * cellHeight;
      doc.addImage(dataUrl, 'PNG', x, y, qrSize, qrSize);
      doc.setFontSize(labelFontSize);
      doc.text(label.slice(0, 34), margin + col * cellWidth + 2, y + qrSize + labelGap);
    }

    const pdf = Buffer.from(doc.output('arraybuffer'));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="Daksh_Bulk_QR.pdf"');
    return res.send(pdf);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
