const express = require('express');
const { randomUUID } = require('crypto');
const ExcelJS = require('exceljs');
const QRCode = require('qrcode');
const Inventory = require('../models/Inventory');
const Bin = require('../models/Bin');
const BinTransferHistory = require('../models/BinTransferHistory');
const BinLabelPrintLog = require('../models/BinLabelPrintLog');
const auth = require('./auth');
const { validScanClause } = require('../utils/masterValidation');
const { formatIstDateTime } = require('../utils/time');

const router = express.Router();

function clean(value) {
  return String(value || '').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function normalizePart(value) {
  return upper(value).replace(/\s+/g, '');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function binRegex(bin) {
  return new RegExp(`^${escapeRegExp(clean(bin))}$`, 'i');
}

const BLANK_MARKERS = ['', 'NULL', 'UNDEFINED', 'N/A', 'NA', '-'];
const CURRENT_BIN_FIELDS = ['binLocation', 'bin', 'currentBin', 'current_bin', 'location'];
const PART_NUMBER_FIELDS = ['normalizedPartNumber', 'partNumber', 'part', 'partNo', 'extractedPartNumber'];

function firstNonBlankExpression(fields = []) {
  return fields.reduceRight((fallback, field) => ({
    $let: {
      vars: {
        value: {
          $trim: {
            input: { $toString: { $ifNull: [`$${field}`, ''] } }
          }
        }
      },
      in: {
        $cond: [
          { $in: [{ $toUpper: '$$value' }, BLANK_MARKERS] },
          fallback,
          '$$value'
        ]
      }
    }
  }), '');
}

function firstNonBlankValue(row = {}, fields = []) {
  for (const field of fields) {
    const value = clean(row[field]);
    if (value && !BLANK_MARKERS.includes(value.toUpperCase())) return value;
  }
  return '';
}

function binFieldClause(fromBin) {
  return { $or: CURRENT_BIN_FIELDS.map((field) => ({ [field]: binRegex(fromBin) })) };
}

function compactBins(items = []) {
  const seen = new Set();
  return items
    .map((item) => {
      const binCode = clean(typeof item === 'string' ? item : item.binCode || item.binLocation || item.bin || item._id);
      if (!binCode || ['NULL', 'UNDEFINED'].includes(binCode.toUpperCase())) return null;
      const key = binCode.toUpperCase();
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        binCode,
        binName: clean(item.binName || item.label || binCode),
        category: clean(item.category || ''),
        qty: Number(item.qty || 0)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.binCode.localeCompare(b.binCode, undefined, { numeric: true, sensitivity: 'base' }));
}

function stockQtyExpression() {
  const qtyValue = {
    $convert: {
      input: { $ifNull: ['$qty', { $ifNull: ['$quantity', { $ifNull: ['$availableQty', 0] }] }] },
      to: 'double',
      onError: 0,
      onNull: 0
    }
  };
  const scanType = {
    $toUpper: {
      $toString: { $ifNull: ['$scanType', { $ifNull: ['$type', ''] }] }
    }
  };
  return {
    $cond: [
      { $in: [scanType, ['OUTWARD', 'DAMAGE']] },
      { $multiply: [qtyValue, -1] },
      {
        $cond: [
          { $eq: [scanType, 'FITTED'] },
          0,
          qtyValue
        ]
      }
    ]
  };
}

function userName(req) {
  return (req.user && (req.user.name || req.user.username || req.user.email)) || 'System';
}

function arrayInput(value) {
  if (Array.isArray(value)) return value;
  return String(value || '')
    .split(/[\n,;]+/)
    .map(clean)
    .filter(Boolean);
}

function numberSetting(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function labelSettings(input = {}) {
  return {
    labelWidthMm: numberSetting(input.labelWidthMm || input.labelWidth, 70, 20, 210),
    labelHeightMm: numberSetting(input.labelHeightMm || input.labelHeight, 28, 12, 140),
    qrSizeMm: numberSetting(input.qrSizeMm || input.qrSize, 20, 8, 90),
    partFontSize: numberSetting(input.partFontSize, 12, 6, 32),
    binFontSize: numberSetting(input.binFontSize, 9, 6, 24),
    boldText: input.boldText !== false && String(input.boldText || 'true').toLowerCase() !== 'false',
    printArea: ['full', 'custom'].includes(String(input.printArea || '').toLowerCase()) ? String(input.printArea).toLowerCase() : 'full',
    copies: numberSetting(input.copies, 1, 1, 100)
  };
}

function binLabelQrValue(item = {}) {
  const identityType = upper(item.identityType || item.labelType || 'BIN');
  const identityValue = upper(item.vin || item.vinNo || item.binNumber || item.bin);
  return `${identityType === 'VIN' ? 'VIN' : 'BIN'}:${identityValue}`;
}

function publicPart(row) {
  return {
    partNumber: row.partNumber,
    partDescription: row.partDescription || '',
    category: row.category || '',
    productCategory: row.category || '',
    availableQty: row.availableQty || 0,
    quantity: row.availableQty || 0,
    currentBin: row.currentBin || '',
    dealerCode: row.dealerCode || ''
  };
}

async function groupedParts(dealerCode, fromBin = '') {
  const sourceBin = /^all$/i.test(clean(fromBin)) ? '' : clean(fromBin);
  const binMatch = sourceBin ? [{ $match: { _btCurrentBin: binRegex(sourceBin) } }] : [];
  const rows = await Inventory.aggregate([
    { $match: { dealerCode, ...validScanClause() } },
    {
      $addFields: {
        _btCurrentBin: firstNonBlankExpression(CURRENT_BIN_FIELDS),
        _btPartNumber: firstNonBlankExpression(PART_NUMBER_FIELDS),
        _btPartDescription: firstNonBlankExpression(['partDescription', 'partName', 'description', 'partDesc']),
        _btCategory: firstNonBlankExpression(['productCategory', 'category', 'productGroup']),
        _btStockQty: stockQtyExpression()
      }
    },
    ...binMatch,
    {
      $group: {
        _id: {
          partNumber: '$_btPartNumber',
          bin: '$_btCurrentBin'
        },
        dealerCode: { $first: '$dealerCode' },
        partDescription: { $first: '$_btPartDescription' },
        category: { $first: '$_btCategory' },
        availableQty: { $sum: '$_btStockQty' },
        lastScanTime: { $max: '$timestamp' }
      }
    },
    {
      $project: {
        _id: 0,
        partNumber: '$_id.partNumber',
        currentBin: '$_id.bin',
        dealerCode: 1,
        partDescription: 1,
        category: 1,
        availableQty: 1,
        lastScanTime: 1
      }
    },
    { $match: { availableQty: { $gt: 0 }, partNumber: { $nin: [null, ''] } } },
    { $sort: { partNumber: 1, currentBin: 1 } }
  ]);
  return rows.map(publicPart);
}

function selectedLabelKey(item = {}) {
  return `${upper(item.binNumber || item.bin || item.currentBin)}::${normalizePart(item.partNumber)}`;
}

async function labelPartsForBins(dealerCode, bins = [], partNumbers = [], selectedItems = []) {
  const partFilter = new Set(partNumbers.map(normalizePart).filter(Boolean));
  const selectedFilter = new Set((Array.isArray(selectedItems) ? selectedItems : []).map(selectedLabelKey).filter((key) => key !== '::'));
  const rows = [];
  for (const bin of bins) {
    const parts = await groupedParts(dealerCode, bin);
    parts.forEach((part) => {
      if (partFilter.size && !partFilter.has(normalizePart(part.partNumber))) return;
      if (selectedFilter.size && !selectedFilter.has(selectedLabelKey({ binNumber: part.currentBin || bin, partNumber: part.partNumber }))) return;
      rows.push({
        dealerCode,
        binNumber: part.currentBin || bin,
        partNumber: part.partNumber,
        partDescription: part.partDescription || '',
        productCategory: part.productCategory || part.category || '',
        availableQty: Number(part.availableQty || part.quantity || 0)
      });
    });
  }
  return rows.sort((a, b) => String(a.binNumber).localeCompare(String(b.binNumber), undefined, { numeric: true }) || String(a.partNumber).localeCompare(String(b.partNumber), undefined, { numeric: true }));
}

function maxPartsPerBinLabel(settings = {}) {
  const labelHeight = Number(settings.labelHeightMm || 28);
  const partFont = Number(settings.partFontSize || 12);
  const availableMm = Math.max(8, labelHeight - 5);
  const lineHeightMm = Math.max(2.6, partFont * 0.42);
  return Math.max(1, Math.floor(availableMm / lineHeightMm));
}

function groupedBinLabelItems(parts = [], settings = {}) {
  const maxParts = maxPartsPerBinLabel(settings);
  const byBin = new Map();
  parts.forEach((part) => {
    const binNumber = upper(part.binNumber || part.bin);
    if (!binNumber) return;
    if (!byBin.has(binNumber)) byBin.set(binNumber, []);
    byBin.get(binNumber).push(part);
  });

  const items = [];
  Array.from(byBin.entries())
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .forEach(([binNumber, binParts]) => {
      const sortedParts = binParts
        .slice()
        .sort((a, b) => String(a.partNumber).localeCompare(String(b.partNumber), undefined, { numeric: true }));
      for (let index = 0; index < sortedParts.length; index += maxParts) {
        const chunk = sortedParts.slice(index, index + maxParts);
        items.push({
          dealerCode: chunk[0]?.dealerCode || '',
          binNumber,
          qrValue: binLabelQrValue({ binNumber }),
          parts: chunk.map((part) => ({
            partNumber: normalizePart(part.partNumber),
            partDescription: clean(part.partDescription),
            availableQty: Number(part.availableQty || 0)
          })),
          partNumbers: chunk.map((part) => normalizePart(part.partNumber)).filter(Boolean),
          chunkNo: Math.floor(index / maxParts) + 1,
          totalChunks: Math.ceil(sortedParts.length / maxParts)
        });
      }
    });
  return items;
}

async function transferPart({ dealerCode, fromBin, toBin, partNumber, qty, transferType, req }) {
  const cleanPart = normalizePart(partNumber);
  const requestedQty = Number(qty);
  if (!dealerCode) throw new Error('Dealer required');
  if (!fromBin || !toBin) throw new Error('Source Bin and Transfer To Bin are required');
  if (fromBin.toUpperCase() === toBin.toUpperCase()) throw new Error('Source Bin and Transfer To Bin cannot be same');
  if (!cleanPart) throw new Error('Part Number is required');
  if (!Number.isFinite(requestedQty) || requestedQty <= 0) throw new Error('Qty to transfer must be greater than 0');

  const availablePart = (await groupedParts(dealerCode, fromBin)).find((part) => normalizePart(part.partNumber) === cleanPart);
  const netAvailableQty = Number((availablePart && (availablePart.availableQty || availablePart.quantity)) || 0);
  if (netAvailableQty <= 0) throw new Error('No available qty found for selected part in Source Bin');
  if (requestedQty > netAvailableQty) throw new Error('Qty cannot be greater than available qty');

  const records = (await Inventory.find({
    dealerCode,
    ...validScanClause(),
    ...binFieldClause(fromBin)
  }).sort({ timestamp: 1, createdAt: 1 }).lean()).filter((record) => {
    const recordPart = normalizePart(firstNonBlankValue(record, PART_NUMBER_FIELDS));
    const recordType = upper(record.scanType || record.type);
    return recordPart === cleanPart && !['OUTWARD', 'FITTED', 'DAMAGE'].includes(recordType);
  });

  const movableQty = records.reduce((sum, record) => sum + Number(record.qty || record.quantity || 0), 0);
  if (requestedQty > movableQty) throw new Error('Qty cannot be greater than available qty');

  let remaining = requestedQty;
  let partDescription = '';
  for (const record of records) {
    if (remaining <= 0) break;
    const recordQty = Number(record.qty || record.quantity || 0);
    if (recordQty <= 0) continue;
    partDescription = partDescription || record.partDescription || record.partName || '';

    if (recordQty <= remaining) {
      await Inventory.updateOne(
        { _id: record._id },
        { $set: { binLocation: toBin, bin: toBin } }
      );
      remaining -= recordQty;
    } else {
      const movedQty = remaining;
      await Inventory.updateOne(
        { _id: record._id },
        { $set: { qty: recordQty - movedQty, quantity: recordQty - movedQty } }
      );
      const clone = { ...record };
      delete clone._id;
      delete clone.createdAt;
      delete clone.updatedAt;
      clone.uniqueScanId = `TRANSFER-${Date.now()}-${randomUUID()}`;
      clone.scanId = clone.uniqueScanId;
      clone.syncKey = clone.uniqueScanId;
      clone.qty = movedQty;
      clone.quantity = movedQty;
      clone.binLocation = toBin;
      clone.bin = toBin;
      clone.timestamp = new Date();
      await Inventory.create(clone);
      remaining = 0;
    }
  }

  const history = await BinTransferHistory.create({
    transferId: `BT-${Date.now()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    dealerCode,
    fromBin,
    toBin,
    partNumber: cleanPart,
    partDescription,
    qty: requestedQty,
    transferType,
    transferredBy: userName(req),
    transferredAt: new Date()
  });

  return history;
}

async function dealerBins(dealerCode) {
  const [scanBins, masterBins] = await Promise.all([
    Inventory.aggregate([
      { $match: { dealerCode, ...validScanClause() } },
      { $project: { bin: firstNonBlankExpression(CURRENT_BIN_FIELDS), qty: stockQtyExpression() } },
      { $match: { bin: { $nin: ['', 'null', 'undefined', 'NULL', 'UNDEFINED'] } } },
      { $group: { _id: '$bin', qty: { $sum: '$qty' } } },
      { $match: { qty: { $gt: 0 } } },
      { $sort: { _id: 1 } }
    ]),
    Bin.find({ dealerCode, active: { $ne: false }, binCode: { $nin: [null, '', 'null', 'undefined'] } }).sort({ binCode: 1 }).lean()
  ]);

  return {
    fromBins: compactBins(scanBins),
    toBins: compactBins(masterBins)
  };
}

async function destinationBinsForDealer(dealerCode, sourceBin = '') {
  const sourceKey = upper(sourceBin);
  const { fromBins, toBins } = await dealerBins(dealerCode);
  const masterBins = toBins.filter((bin) => upper(bin.binCode) !== sourceKey);

  if (toBins.length) {
    return {
      bins: masterBins.map((bin) => bin.binCode),
      source: 'bin_master'
    };
  }

  return {
    bins: fromBins.filter((bin) => upper(bin.binCode) !== sourceKey).map((bin) => bin.binCode),
    source: 'fallback_from_current_stock'
  };
}

router.get('/dealers', auth.requireAuth, async (req, res) => {
  try {
    const [inventoryDealers, binDealers] = await Promise.all([
      Inventory.distinct('dealerCode', { dealerCode: { $nin: [null, ''] } }),
      Bin.distinct('dealerCode', { dealerCode: { $nin: [null, ''] }, active: { $ne: false } })
    ]);
    const dealers = Array.from(new Set([...inventoryDealers, ...binDealers].map(upper).filter(Boolean))).sort();
    return res.json({ success: true, dealers });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/source-bins', auth.requireAuth, async (req, res) => {
  try {
    const dealerCode = upper(req.query.dealerCode);
    if (!dealerCode) return res.status(400).json({ success: false, message: 'Dealer required' });
    const { fromBins, toBins } = await dealerBins(dealerCode);
    const bins = fromBins.length ? fromBins : toBins;
    const message = fromBins.length ? '' : 'No scanned stock bins found. Showing Bin Master locations.';
    return res.json({ success: true, bins, fromBins: bins, sourceBins: bins, source: fromBins.length ? 'current_stock' : 'bin_master_fallback', message });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

async function destinationBinsHandler(req, res) {
  try {
    const dealerCode = upper(req.query.dealerCode);
    if (!dealerCode) return res.status(400).json({ success: false, message: 'Dealer required' });
    const result = await destinationBinsForDealer(dealerCode, req.query.sourceBin || req.query.fromBin);
    const message = result.bins.length ? '' : 'No destination bins found. Please create bins in Bin Master / Sequence Creation or scan stock into another bin.';
    return res.json({
      success: true,
      bins: result.bins,
      toBins: result.bins,
      destinationBins: result.bins,
      source: result.source,
      message
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

router.get('/destination-bins', auth.requireAuth, destinationBinsHandler);
router.get('/to-bins', auth.requireAuth, destinationBinsHandler);

router.get('/bins', auth.requireAuth, async (req, res) => {
  try {
    const dealerCode = upper(req.query.dealerCode);
    if (!dealerCode) return res.status(400).json({ success: false, message: 'Dealer required' });
    const bins = await dealerBins(dealerCode);
    const sourceBin = req.query.sourceBin || req.query.fromBin;
    const destination = await destinationBinsForDealer(dealerCode, sourceBin);
    const message = destination.bins.length ? '' : 'No destination bins found. Please create bins in Bin Master / Sequence Creation or scan stock into another bin.';
    return res.json({
      success: true,
      ...bins,
      destinationBins: destination.bins,
      destinationSource: destination.source,
      message
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/parts', auth.requireAuth, async (req, res) => {
  try {
    const dealerCode = upper(req.query.dealerCode);
    const fromBin = /^all$/i.test(clean(req.query.binLocation || req.query.sourceBin || req.query.fromBin)) ? '' : clean(req.query.binLocation || req.query.sourceBin || req.query.fromBin);
    console.log('BIN_TRANSFER_PARTS_API_CALLED');
    console.log('DEALER_RECEIVED', dealerCode);
    console.log('SOURCE_BIN_RECEIVED', fromBin);
    const partNumber = normalizePart(req.query.partNumber);
    if (!dealerCode) return res.status(400).json({ success: false, message: 'Dealer required' });
    if (!fromBin && !partNumber && !/^all$/i.test(clean(req.query.sourceBin || req.query.fromBin || req.query.binLocation))) {
      return res.status(400).json({ success: false, message: 'Source Bin or Part Number is required' });
    }
    const parts = (await groupedParts(dealerCode, fromBin)).filter((part) => {
      if (!partNumber) return true;
      return normalizePart(part.partNumber).includes(partNumber);
    });
    console.log('PARTS_FOUND_COUNT', parts.length);
    if (req.query.format === 'excel') {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Available Scanned Parts');
      sheet.columns = [
        { header: 'Part Number', key: 'partNumber', width: 22 },
        { header: 'Part Description', key: 'partDescription', width: 34 },
        { header: 'Product Category', key: 'productCategory', width: 22 },
        { header: 'Current Bin', key: 'currentBin', width: 16 },
        { header: 'Available Qty', key: 'availableQty', width: 14 },
        { header: 'Dealer Code', key: 'dealerCode', width: 14 }
      ];
      parts.forEach((part) => sheet.addRow(part));
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF153A5B' } };
      const buffer = await workbook.xlsx.writeBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="Daksh_Bin_Transfer_Parts.xlsx"');
      return res.send(Buffer.from(buffer));
    }
    return res.json({ success: true, parts, data: parts, count: parts.length });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/label-parts', auth.requireAuth, async (req, res) => {
  try {
    const dealerCode = upper(req.query.dealerCode);
    const bins = arrayInput(req.query.bins || req.query.binNumbers || req.query.binLocation || req.query.sourceBin);
    if (!dealerCode) return res.status(400).json({ success: false, message: 'Dealer required' });
    if (!bins.length) return res.status(400).json({ success: false, message: 'Select at least one bin' });
    const rows = await labelPartsForBins(dealerCode, bins, arrayInput(req.query.partNumbers || req.query.partNumber));
    return res.json({ success: true, parts: rows, rows, count: rows.length });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/labels/preview', auth.requireAuth, async (req, res) => {
  try {
    const dealerCode = upper(req.body.dealerCode);
    const bins = arrayInput(req.body.bins || req.body.binNumbers || req.body.selectedBins);
    const partNumbers = arrayInput(req.body.partNumbers || req.body.selectedParts);
    const selectedItems = Array.isArray(req.body.selectedItems) ? req.body.selectedItems : [];
    if (!dealerCode) return res.status(400).json({ success: false, message: 'Dealer required' });
    if (!bins.length) return res.status(400).json({ success: false, message: 'Select at least one bin' });
    const settings = labelSettings(req.body);
    const parts = await labelPartsForBins(dealerCode, bins, partNumbers, selectedItems);
    if (!parts.length) return res.status(404).json({ success: false, message: 'No available parts found for selected bins' });
    const items = [];
    const groupedItems = groupedBinLabelItems(parts, settings);
    for (const label of groupedItems) {
      const qrValue = label.qrValue || binLabelQrValue(label);
      const dataUrl = await QRCode.toDataURL(qrValue, { margin: 1, width: 360 });
      for (let copy = 1; copy <= settings.copies; copy += 1) {
        items.push({ ...label, qrValue, dataUrl, copyNo: copy });
      }
    }
    return res.json({ success: true, settings, items, count: items.length });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/labels/log', auth.requireAuth, async (req, res) => {
  try {
    const dealerCode = upper(req.body.dealerCode);
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const settings = labelSettings(req.body.settings || req.body);
    if (!dealerCode) return res.status(400).json({ success: false, message: 'Dealer required' });
    if (!items.length) return res.status(400).json({ success: false, message: 'No labels to log' });
    const printedBy = userName(req);
    const printedAt = new Date();
    const rows = items.flatMap((item) => {
      const partNumbers = Array.isArray(item.partNumbers) && item.partNumbers.length
        ? item.partNumbers
        : (Array.isArray(item.parts) ? item.parts.map((part) => part.partNumber) : [item.partNumber]);
      return partNumbers.map((partNumber) => ({
        dealerCode,
        binNumber: upper(item.binNumber || item.bin),
        partNumber: normalizePart(partNumber),
        printedBy,
        printedAt,
        deviceId: clean(req.body.deviceId),
        copies: settings.copies,
        labelWidthMm: settings.labelWidthMm,
        labelHeightMm: settings.labelHeightMm,
        qrSizeMm: settings.qrSizeMm,
        printArea: settings.printArea
      }));
    }).filter((row) => row.binNumber && row.partNumber);
    if (!rows.length) return res.status(400).json({ success: false, message: 'No valid labels to log' });
    await BinLabelPrintLog.insertMany(rows);
    return res.json({ success: true, loggedCount: rows.length, printedAt });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/labels/logs', auth.requireAuth, async (req, res) => {
  try {
    const filter = {};
    const dealerCode = upper(req.query.dealerCode);
    if (dealerCode) filter.dealerCode = dealerCode;
    if (req.query.binNumber || req.query.bin) filter.binNumber = binRegex(req.query.binNumber || req.query.bin);
    if (req.query.partNumber) filter.partNumber = { $regex: normalizePart(req.query.partNumber), $options: 'i' };
    const logs = await BinLabelPrintLog.find(filter).sort({ printedAt: -1 }).limit(500).lean();
    if (req.query.format === 'excel') {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Bin Label Print Log');
      sheet.columns = [
        { header: 'Printed Date Time', key: 'printedAt', width: 24 },
        { header: 'Dealer Code', key: 'dealerCode', width: 16 },
        { header: 'Bin Number', key: 'binNumber', width: 16 },
        { header: 'Part Number', key: 'partNumber', width: 22 },
        { header: 'Printed By', key: 'printedBy', width: 22 },
        { header: 'Copies', key: 'copies', width: 10 }
      ];
      logs.forEach((row) => sheet.addRow({ ...row, printedAt: formatIstDateTime(row.printedAt) }));
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF153A5B' } };
      const buffer = await workbook.xlsx.writeBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="Daksh_Bin_Label_Print_Log.xlsx"');
      return res.send(Buffer.from(buffer));
    }
    return res.json({ success: true, logs });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/transfer', auth.requireAuth, async (req, res) => {
  try {
    const dealerCode = upper(req.body.dealerCode);
    const fromBin = clean(req.body.sourceBin || req.body.fromBin);
    const defaultToBin = clean(req.body.destinationBin || req.body.toBin);
    const fullBinTransfer = Boolean(req.body.fullBinTransfer);
    const selectedParts = Array.isArray(req.body.selectedParts) ? req.body.selectedParts : Array.isArray(req.body.parts) ? req.body.parts : [];
    if (!dealerCode) return res.status(400).json({ success: false, message: 'dealerCode required' });
    if (!fromBin) return res.status(400).json({ success: false, message: 'sourceBin required' });

    const parts = fullBinTransfer ? await groupedParts(dealerCode, fromBin) : selectedParts;
    if (!fullBinTransfer && !parts.length) return res.status(400).json({ success: false, message: 'selected parts required unless fullBinTransfer=true' });
    if (!parts.length) return res.status(400).json({ success: false, message: 'No parts found in selected Source Bin' });
    const transfers = parts.map((part) => {
      const item = typeof part === 'string' ? { partNumber: part } : part || {};
      return {
        partNumber: item.partNumber || item.part || item.normalizedPartNumber,
        qty: item.qty ?? item.transferQty ?? item.quantity ?? item.availableQty ?? 1,
        fromBin: clean(item.sourceBin || item.fromBin || item.currentBin || fromBin),
        toBin: clean(item.destinationBin || item.toBin || item.transferToBin || defaultToBin)
      };
    });

    for (const transfer of transfers) {
      if (!clean(transfer.partNumber)) return res.status(400).json({ success: false, message: 'partNumber required for every selected part' });
      if (!transfer.fromBin || /^all$/i.test(transfer.fromBin)) return res.status(400).json({ success: false, message: `Source Bin required for ${transfer.partNumber}` });
      if (!transfer.toBin) return res.status(400).json({ success: false, message: `Transfer To Bin required for ${transfer.partNumber}` });
      if (transfer.fromBin.toUpperCase() === transfer.toBin.toUpperCase()) return res.status(400).json({ success: false, message: `Source and destination bin cannot be same for ${transfer.partNumber}` });
    }

    const history = [];
    for (const part of transfers) {
      history.push(await transferPart({
        dealerCode,
        fromBin: part.fromBin,
        toBin: part.toBin,
        partNumber: part.partNumber,
        qty: part.qty,
        transferType: fullBinTransfer ? 'bulk' : transfers.length > 1 ? 'multiple' : 'single',
        req
      }));
    }
    req.io.emit('scan:saved');
    return res.json({ success: true, message: 'Bin transfer completed', transferredCount: history.length, history });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
});

router.get('/history', auth.requireAuth, async (req, res) => {
  try {
    const filter = {};
    const dealerCode = upper(req.query.dealerCode);
    if (dealerCode) filter.dealerCode = dealerCode;
    const sourceBin = clean(req.query.sourceBin || req.query.fromBin);
    const destinationBin = clean(req.query.destinationBin || req.query.toBin);
    const partNumber = normalizePart(req.query.partNumber);
    const transferType = clean(req.query.transferType);
    if (sourceBin) filter.fromBin = binRegex(sourceBin);
    if (destinationBin) filter.toBin = binRegex(destinationBin);
    if (partNumber) filter.partNumber = partNumber;
    if (transferType) filter.transferType = transferType;
    if (req.query.dateFrom || req.query.dateTo) {
      filter.transferredAt = {};
      if (req.query.dateFrom) filter.transferredAt.$gte = new Date(`${req.query.dateFrom}T00:00:00.000Z`);
      if (req.query.dateTo) filter.transferredAt.$lte = new Date(`${req.query.dateTo}T23:59:59.999Z`);
    }
    const history = await BinTransferHistory.find(filter).sort({ transferredAt: -1 }).limit(300).lean();
    if (req.query.format === 'excel') {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Bin Transfer History');
      sheet.columns = [
        { header: 'Date', key: 'transferredAt', width: 22 },
        { header: 'Dealer', key: 'dealerCode', width: 14 },
        { header: 'Source Bin', key: 'fromBin', width: 14 },
        { header: 'Destination Bin', key: 'toBin', width: 18 },
        { header: 'Part Number', key: 'partNumber', width: 20 },
        { header: 'Part Description', key: 'partDescription', width: 32 },
        { header: 'Qty', key: 'qty', width: 10 },
        { header: 'Transfer Type', key: 'transferType', width: 16 },
        { header: 'User', key: 'transferredBy', width: 18 }
      ];
      history.forEach((row) => sheet.addRow({
        ...row,
        transferredAt: formatIstDateTime(row.transferredAt)
      }));
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF153A5B' } };
      const buffer = await workbook.xlsx.writeBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="Daksh_Bin_Transfer_History.xlsx"');
      return res.send(Buffer.from(buffer));
    }
    return res.json({ success: true, history });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/single', auth.requireAuth, async (req, res) => {
  try {
    const history = await transferPart({
      dealerCode: upper(req.body.dealerCode),
      fromBin: clean(req.body.sourceBin || req.body.fromBin),
      toBin: clean(req.body.destinationBin || req.body.toBin),
      partNumber: req.body.partNumber,
      qty: req.body.qty,
      transferType: 'single',
      req
    });
    req.io.emit('scan:saved');
    return res.json({ success: true, message: 'Bin transfer completed', history });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
});

router.post('/multiple', auth.requireAuth, async (req, res) => {
  try {
    const dealerCode = upper(req.body.dealerCode);
    const fromBin = clean(req.body.sourceBin || req.body.fromBin);
    const toBin = clean(req.body.destinationBin || req.body.toBin);
    const parts = Array.isArray(req.body.parts) ? req.body.parts : [];
    if (!parts.length) return res.status(400).json({ success: false, message: 'Select at least one part' });
    const history = [];
    for (const part of parts) {
      history.push(await transferPart({
        dealerCode,
        fromBin,
        toBin,
        partNumber: part.partNumber || part,
        qty: part.qty || part.availableQty || 1,
        transferType: 'multiple',
        req
      }));
    }
    req.io.emit('scan:saved');
    return res.json({ success: true, message: 'Selected parts transferred', transferredCount: history.length, history });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
});

router.post('/bulk', auth.requireAuth, async (req, res) => {
  try {
    const dealerCode = upper(req.body.dealerCode);
    const fromBin = clean(req.body.sourceBin || req.body.fromBin);
    const toBin = clean(req.body.destinationBin || req.body.toBin);
    const parts = await groupedParts(dealerCode, fromBin);
    if (!parts.length) return res.status(400).json({ success: false, message: 'No scanned parts found in selected From Bin' });
    const history = [];
    for (const part of parts) {
      history.push(await transferPart({
        dealerCode,
        fromBin,
        toBin,
        partNumber: part.partNumber,
        qty: part.availableQty,
        transferType: 'bulk',
        req
      }));
    }
    req.io.emit('scan:saved');
    return res.json({ success: true, message: 'Full bin transferred', transferredCount: history.length, history });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
});

module.exports = router;
