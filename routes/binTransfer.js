const express = require('express');
const { randomUUID } = require('crypto');
const ExcelJS = require('exceljs');
const QRCode = require('qrcode');
const Inventory = require('../models/Inventory');
const Bin = require('../models/Bin');
const MasterPart = require('../models/MasterPart');
const BinTransferHistory = require('../models/BinTransferHistory');
const BinLabelPrintLog = require('../models/BinLabelPrintLog');
const auth = require('./auth');
const { formatIstDateTime } = require('../utils/time');
const { calculateInventoryLedger, resolveCurrentAudit } = require('../services/InventoryCalculationService');
const { applyTransactionScanFilter } = require('./inventory');
const { stockMovementType, stockMovementBin, activeStockTransaction } = require('../utils/stockQuantity');
const { withDatabaseTransaction } = require('../services/prisma');
const scanModification = require('../services/ScanModificationService');
const { invalidateCache } = require('../utils/safeCache');
const { firstNonBlankValue } = require('../utils/binTransfer');

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

const PART_NUMBER_FIELDS = ['normalizedPartNumber', 'partNumber', 'part', 'partNo', 'extractedPartNumber'];

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
    binFontSize: numberSetting(input.binFontSize, 18, 6, 24),
    boldText: input.boldText !== false && String(input.boldText || 'true').toLowerCase() !== 'false',
    printArea: ['full', 'custom'].includes(String(input.printArea || '').toLowerCase()) ? String(input.printArea).toLowerCase() : 'full',
    copies: numberSetting(input.copies, 1, 1, 100)
  };
}

function binLabelQrValue(item = {}) {
  const identityType = upper(item.identityType || item.labelType || 'BIN');
  const identityValue = upper(item.vin || item.vinNo || item.binNumber || item.bin);
  if (identityType === 'VIN') return `VIN:${identityValue}`;
  const partNumbers = (Array.isArray(item.partNumbers) && item.partNumbers.length
    ? item.partNumbers
    : Array.isArray(item.parts)
      ? item.parts.map((part) => part.partNumber)
      : [item.partNumber])
    .map(normalizePart)
    .filter(Boolean);
  const uniqueParts = Array.from(new Set(partNumbers));
  if (!uniqueParts.length) return `BIN:${identityValue}`;
  const partField = uniqueParts.length === 1
    ? `PART=${uniqueParts[0]}`
    : `PARTS=${uniqueParts.join(',')}`;
  return `BIN=${identityValue}|${partField}`;
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

async function resolveTransferAuditId(dealerCode, requestedAuditId = '') {
  const requested = clean(requestedAuditId);
  if (requested && requested.toLowerCase() !== 'active') return requested;
  const scope = await resolveCurrentAudit(dealerCode);
  return clean(scope.auditId === '__NO_AUDIT_SELECTED__' ? '' : scope.auditId);
}

async function groupedParts(dealerCode, fromBin = '', auditId = '') {
  const sourceBin = /^all$/i.test(clean(fromBin)) ? '' : clean(fromBin).toUpperCase();
  if (!clean(dealerCode)) return [];
  const currentAuditId = clean(auditId) || await resolveTransferAuditId(dealerCode);
  if (!currentAuditId) return [];
  const scope = { dealerCode: upper(dealerCode), auditId: currentAuditId };
  const reportCompatibleFilter = applyTransactionScanFilter({ dealerCode: scope.dealerCode, auditId: scope.auditId });
  const records = await Inventory.find(reportCompatibleFilter).sort({ timestamp: -1, createdAt: -1 }).lean();
  return calculateInventoryLedger(records, { scope }).binBreakdown
    .filter((row) => Number(row.availableQty) > 0
      && (!sourceBin || upper(row.binLocation) === sourceBin))
    .map((row) => publicPart({
      partNumber: row.partNumber,
      partDescription: row.partDescription,
      category: row.category,
      availableQty: row.availableQty,
      currentBin: row.binLocation,
      dealerCode: scope.dealerCode
    }));
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
          parts: chunk.map((part) => ({
            partNumber: normalizePart(part.partNumber),
            partDescription: clean(part.partDescription),
            availableQty: Number(part.availableQty || 0)
          })),
          partNumbers: chunk.map((part) => normalizePart(part.partNumber)).filter(Boolean),
          chunkNo: Math.floor(index / maxParts) + 1,
          totalChunks: Math.ceil(sortedParts.length / maxParts)
        });
        items[items.length - 1].qrValue = binLabelQrValue(items[items.length - 1]);
      }
    });
  return items;
}

async function transferPartInTransaction({ dealerCode, auditId = '', fromBin, toBin, partNumber, qty, transferType, req }) {
  const cleanPart = normalizePart(partNumber);
  const requestedQty = Number(qty);
  if (!dealerCode) throw new Error('Dealer required');
  if (!fromBin || !toBin) throw new Error('Source Bin and Transfer To Bin are required');
  if (fromBin.toUpperCase() === toBin.toUpperCase()) throw new Error('Source Bin and Transfer To Bin cannot be same');
  if (!cleanPart) throw new Error('Part Number is required');
  if (!Number.isFinite(requestedQty) || requestedQty <= 0) throw new Error('Qty to transfer must be greater than 0');

  const availablePart = (await groupedParts(dealerCode, fromBin, auditId)).find((part) => normalizePart(part.partNumber) === cleanPart);
  const netAvailableQty = Number((availablePart && (availablePart.availableQty || availablePart.quantity)) || 0);
  if (netAvailableQty <= 0) throw new Error('No available qty found for selected part in Source Bin');
  if (requestedQty > netAvailableQty) throw new Error('Qty cannot be greater than available qty');

  const reportCompatibleFilter = applyTransactionScanFilter({ dealerCode, auditId });
  const ledgerRows = await Inventory.find(reportCompatibleFilter).sort({ timestamp: -1, createdAt: -1 }).lean();
  const records = ledgerRows.filter((record) => {
    const recordPart = normalizePart(firstNonBlankValue(record, PART_NUMBER_FIELDS));
    const recordType = stockMovementType(record);
    const recordBin = stockMovementBin(record);
    return recordPart === cleanPart && recordBin === upper(fromBin)
      && ['INWARD', 'AUDIT', 'FITTED_RETURN'].includes(recordType);
  }).sort((a, b) => new Date(a.timestamp || a.createdAt || 0) - new Date(b.timestamp || b.createdAt || 0));

  const movableQty = records.reduce((sum, record) => sum + Number(record.qty || record.quantity || 0), 0);
  if (requestedQty > movableQty) throw new Error('Qty cannot be greater than available qty');

  let remaining = requestedQty;
  let partDescription = '';
  const sourceScanIds = [];
  const movedScanIds = [];
  for (const record of records) {
    if (remaining <= 0) break;
    const recordQty = Number(record.qty || record.quantity || 0);
    if (recordQty <= 0) continue;
    partDescription = partDescription || record.partDescription || record.partName || '';
    sourceScanIds.push(String(record._id || record.id));

    if (recordQty <= remaining) {
      await Inventory.updateOne(
        { _id: record._id },
        { $set: {
          binLocation: toBin,
          bin: toBin,
          ...(record.upiCode || record.upiNo || record.upiId
            ? { currentBin: upper(toBin), currentLocationType: 'BIN', upiStatus: 'AVAILABLE' }
            : {})
        } }
      );
      movedScanIds.push(String(record._id || record.id));
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
      clone.transferOriginScanId = String(record._id || record.id);
      clone.binLocation = toBin;
      clone.bin = toBin;
      if (clone.upiCode || clone.upiNo || clone.upiId) {
        clone.currentBin = upper(toBin);
        clone.currentLocationType = 'BIN';
        clone.upiStatus = 'AVAILABLE';
      }
      clone.timestamp = new Date();
      const movedRecord = await Inventory.create(clone);
      movedScanIds.push(String(movedRecord._id || movedRecord.id || clone._id || ''));
      remaining = 0;
    }
  }

  const history = await BinTransferHistory.create({
    transferId: `BT-${Date.now()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    dealerCode,
    auditId,
    fromBin,
    toBin,
    partNumber: cleanPart,
    partDescription,
    qty: requestedQty,
    sourceScanIds: Array.from(new Set(sourceScanIds)),
    movedScanIds: Array.from(new Set(movedScanIds.filter(Boolean))),
    transferType,
    transferredBy: userName(req),
    transferredAt: new Date()
  });

  return history;
}

async function transferPart(input) {
  // Inventory edits and their history row must commit or roll back together.
  // PostgreSQL serializable transactions also make concurrent availability
  // checks retry against the newly committed stock state.
  return withDatabaseTransaction(() => transferPartInTransaction(input));
}

async function dealerBins(dealerCode, auditId = '') {
  const [scanBins, masterBins] = await Promise.all([
    groupedParts(dealerCode, '', auditId).then((parts) => {
      const byBin = new Map();
      parts.forEach((part) => byBin.set(part.currentBin, (byBin.get(part.currentBin) || 0) + Number(part.availableQty || 0)));
      return Array.from(byBin, ([_id, qty]) => ({ _id, qty }));
    }),
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
    const bins = compactBins([...toBins, ...fromBins]);
    return res.json({ success: true, bins, fromBins: bins, sourceBins: bins, source: 'bin_master_and_current_stock' });
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
    const auditId = await resolveTransferAuditId(dealerCode, req.query.auditId);
    const binData = await dealerBins(dealerCode, auditId);
    // A source bin must contain positive available stock. Master-only bins
    // remain valid destinations, but should not appear as transferable stock.
    const bins = binData.fromBins;
    const activityRows = await Inventory.find(applyTransactionScanFilter({ dealerCode, auditId }))
      .select('binLocation bin currentBin stockDeductedFromBin sourceBin returnedToBin scanType type movementType')
      .lean();
    const activityBins = activityRows.map((row) => stockMovementBin(row)).filter(Boolean);
    const allBins = compactBins([...binData.toBins, ...binData.fromBins, ...activityBins]);
    const sourceKey = upper(req.query.sourceBin || req.query.fromBin);
    const destinationBins = binData.toBins.length
      ? binData.toBins.filter((bin) => upper(bin.binCode) !== sourceKey).map((bin) => bin.binCode)
      : binData.fromBins.filter((bin) => upper(bin.binCode) !== sourceKey).map((bin) => bin.binCode);
    const message = destinationBins.length ? '' : 'No destination bins found. Please create bins in Bin Master / Sequence Creation or scan stock into another bin.';
    return res.json({
      success: true,
      auditId,
      bins,
      sourceBins: bins,
      allBins,
      fromBins: bins,
      toBins: binData.toBins,
      destinationBins,
      destinationSource: binData.toBins.length ? 'bin_master' : 'fallback_from_current_stock',
      message
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/delete-stock', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const dealerCode = upper(req.body.dealerCode);
    if (!dealerCode) return res.status(400).json({ success: false, message: 'Dealer required' });
    const auditId = await resolveTransferAuditId(dealerCode, req.body.auditId);

    const items = Array.isArray(req.body.items) ? req.body.items.map((item) => ({
      bin: upper(item?.bin || item?.currentBin),
      partNumber: normalizePart(item?.partNumber)
    })).filter((item) => item.bin && item.partNumber) : [];
    const binCodes = Array.from(new Set((Array.isArray(req.body.binCodes) ? req.body.binCodes : [])
      .map(upper).filter(Boolean)));
    if (!items.length && !binCodes.length) {
      return res.status(400).json({ success: false, message: 'Select a bin or part stock row to delete.' });
    }
    if (items.length && !auditId) {
      return res.status(400).json({ success: false, message: 'No active audit is selected for deleting part stock.' });
    }

    const targets = new Set([
      ...binCodes.map((bin) => `${bin}::`),
      ...items.map((item) => `${item.bin}::${item.partNumber}`)
    ]);
    const targetBins = Array.from(new Set([...binCodes, ...items.map((item) => item.bin)]));
    const binPatterns = targetBins.map(binRegex);
    const candidates = auditId ? await Inventory.find({
      dealerCode,
      ...(auditId ? { auditId } : {}),
      isDeleted: { $ne: true },
      deletedAt: null,
      $or: [
        { binLocation: { $in: binPatterns } },
        { bin: { $in: binPatterns } },
        { currentBin: { $in: binPatterns } },
        { returnedToBin: { $in: binPatterns } },
        { stockDeductedFromBin: { $in: binPatterns } },
        { sourceBin: { $in: binPatterns } }
      ]
    }).lean() : [];
    const deletableIds = candidates.filter((row) => {
      if (!activeStockTransaction(row)) return false;
      const movement = stockMovementType(row);
      if (!['INWARD', 'AUDIT', 'FITTED_RETURN'].includes(movement)) return false;
      const bin = upper(stockMovementBin(row));
      const partNumber = normalizePart(row.normalizedPartNumber || row.partNumber || row.part || row.partNo);
      return targets.has(`${bin}::`) || targets.has(`${bin}::${partNumber}`);
    }).map((row) => row._id || row.id).filter(Boolean);

    const result = await withDatabaseTransaction(async () => {
      const deleted = deletableIds.length
        ? await scanModification.softDeleteScans({ _id: { $in: deletableIds } }, req, {
          reason: 'Bin inventory removal',
          remarks: `Removed stock from bin(s): ${targetBins.join(', ')}`
        })
        : { deletedCount: 0 };
      let binsDeleted = 0;
      let masterUpdated = 0;
      if (binCodes.length) {
        const [binResult, masterResult] = await Promise.all([
          Bin.deleteMany({ dealerCode, binCode: { $in: binCodes } }),
          MasterPart.updateMany({ dealerCode, $or: binCodes.flatMap((bin) => [
            { bin: binRegex(bin) }, { binLocation: binRegex(bin) }
          ]) }, { $set: { bin: '', binLocation: '' } })
        ]);
        binsDeleted = binResult.deletedCount || 0;
        masterUpdated = masterResult.modifiedCount || 0;
      }
      return { deletedCount: deleted.deletedCount || 0, binsDeleted, masterUpdated };
    });

    invalidateCache({ tags: ['inventory', 'scans', 'reports', 'bins', 'master', 'dashboard'], scope: { dealerCode, auditId } });
    if (req.io && typeof req.io.emit === 'function' && binCodes.length) {
      req.io.emit('master:update', { dealerCode, scope: 'bins' });
    }
    return res.json({ success: true, auditId, ...result, bins: binCodes });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

router.get('/parts', auth.requireAuth, async (req, res) => {
  try {
    const dealerCode = upper(req.query.dealerCode);
    const fromBin = /^all$/i.test(clean(req.query.binLocation || req.query.sourceBin || req.query.fromBin)) ? '' : clean(req.query.binLocation || req.query.sourceBin || req.query.fromBin);
    const partNumber = normalizePart(req.query.partNumber);
    if (!dealerCode) return res.status(400).json({ success: false, message: 'Dealer required' });
    if (!fromBin && !partNumber && !/^all$/i.test(clean(req.query.sourceBin || req.query.fromBin || req.query.binLocation))) {
      return res.status(400).json({ success: false, message: 'Source Bin or Part Number is required' });
    }
    const auditId = await resolveTransferAuditId(dealerCode, req.query.auditId);
    const parts = (await groupedParts(dealerCode, fromBin, auditId)).filter((part) => {
      if (!partNumber) return true;
      return normalizePart(part.partNumber).includes(partNumber);
    });
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
    return res.json({ success: true, auditId, parts, data: parts, count: parts.length });
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
    let groupedItems;
    if (selectedItems.length || partNumbers.length) {
      const parts = await labelPartsForBins(dealerCode, bins, partNumbers, selectedItems);
      if (!parts.length) return res.status(404).json({ success: false, message: 'No available parts found for selected bins' });
      groupedItems = groupedBinLabelItems(parts, settings);
    } else {
      const { fromBins, toBins } = await dealerBins(dealerCode);
      const validBins = new Map(compactBins([...toBins, ...fromBins]).map((bin) => [upper(bin.binCode), bin.binCode]));
      const selectedBins = Array.from(new Set(bins.map(upper))).map((bin) => validBins.get(bin)).filter(Boolean);
      if (!selectedBins.length) return res.status(404).json({ success: false, message: 'No valid bins found for selected dealer' });
      groupedItems = selectedBins.map((binNumber) => ({ dealerCode, binNumber, parts: [], partNumbers: [], binOnly: true }));
    }
    const items = [];
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
      const partNumbers = item.binOnly || (Array.isArray(item.parts) && item.parts.length === 0 && !item.partNumber)
        ? ['']
        : (Array.isArray(item.partNumbers) && item.partNumbers.length
          ? item.partNumbers
          : (Array.isArray(item.parts) ? item.parts.map((part) => part.partNumber) : [item.partNumber]));
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
    }).filter((row) => row.binNumber);
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
    const auditId = await resolveTransferAuditId(dealerCode, req.body.auditId);
    const fromBin = clean(req.body.sourceBin || req.body.fromBin);
    const defaultToBin = clean(req.body.destinationBin || req.body.toBin);
    const fullBinTransfer = Boolean(req.body.fullBinTransfer);
    const selectedParts = Array.isArray(req.body.selectedParts) ? req.body.selectedParts : Array.isArray(req.body.parts) ? req.body.parts : [];
    if (!dealerCode) return res.status(400).json({ success: false, message: 'dealerCode required' });
    if (!fromBin) return res.status(400).json({ success: false, message: 'sourceBin required' });

    const parts = fullBinTransfer ? await groupedParts(dealerCode, fromBin, auditId) : selectedParts;
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
        auditId,
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
    const dealerCode = upper(req.body.dealerCode);
    const auditId = await resolveTransferAuditId(dealerCode, req.body.auditId);
    const history = await transferPart({
      dealerCode,
      auditId,
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
    const auditId = await resolveTransferAuditId(dealerCode, req.body.auditId);
    const fromBin = clean(req.body.sourceBin || req.body.fromBin);
    const toBin = clean(req.body.destinationBin || req.body.toBin);
    const parts = Array.isArray(req.body.parts) ? req.body.parts : [];
    if (!parts.length) return res.status(400).json({ success: false, message: 'Select at least one part' });
    const history = [];
    for (const part of parts) {
      history.push(await transferPart({
        dealerCode,
        auditId,
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
    const auditId = await resolveTransferAuditId(dealerCode, req.body.auditId);
    const fromBin = clean(req.body.sourceBin || req.body.fromBin);
    const toBin = clean(req.body.destinationBin || req.body.toBin);
    const parts = await groupedParts(dealerCode, fromBin, auditId);
    if (!parts.length) return res.status(400).json({ success: false, message: 'No scanned parts found in selected From Bin' });
    const history = [];
    for (const part of parts) {
      history.push(await transferPart({
        dealerCode,
        auditId,
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
