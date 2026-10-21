const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const { randomUUID, createHash } = require('crypto');
const auth = require('./auth');
const Dealer = require('../models/Dealer');
const { getPricesFromPartMaster } = require('../utils/partMasterPrice');
const Bin = require('../models/Bin');
const Inventory = require('../models/Inventory');
const ScanAuditLog = require('../models/ScanAuditLog');
const { normalizePartNumber } = require('../utils/normalize');
const { getActiveAudit } = require('../utils/audit');
const { loadPartStock } = require('../services/StockCalculationService');
const { withDatabaseTransaction, getPrismaClient } = require('../services/prisma');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
const batchFields = { id: true, batchId: true, dealerCode: true, dealerName: true, auditId: true, fileName: true, uploadedBy: true, uploadedByName: true, status: true, acceptedRows: true, rejectedRows: true, uploadedQty: true, rows: true, createdAt: true, updatedAt: true };

function clean(value) { return String(value ?? '').trim(); }
function upper(value) { return clean(value).toUpperCase(); }
function actor(req) { return String(req.user?.id || req.user?._id || req.user?.username || ''); }
function actorName(req) { return clean(req.user?.name || req.user?.username || req.user?.email); }
function integerQty(value) {
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function sourceValue(row, headings, names) {
  const index = headings.findIndex(value => names.includes(value));
  return index >= 0 ? clean(row[index]) : '';
}

function parseUploadRows(file) {
  const workbook = XLSX.read(file.buffer, { type: 'buffer', raw: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw Object.assign(new Error('The workbook has no worksheet.'), { statusCode: 400 });
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  const headings = (data[0] || []).map(value => clean(value).toLowerCase());
  const partNames = ['part number', 'partnumber', 'part no', 'partno'];
  const qtyNames = ['qty', 'quantity', 'dms stock', 'dms qty'];
  const binNames = ['bin location', 'bin', 'bin loc', 'bin loc 1'];
  if (!headings.some(value => partNames.includes(value)) || !headings.some(value => qtyNames.includes(value)) || !headings.some(value => binNames.includes(value))) {
    throw Object.assign(new Error('Required columns: Part Number, Qty, Bin Location.'), { statusCode: 400 });
  }
  return data.slice(1).map((values, index) => {
    const partNumber = sourceValue(values, headings, partNames);
    const qty = sourceValue(values, headings, qtyNames);
    const binLocation = sourceValue(values, headings, binNames);
    if (!partNumber && !qty && !binLocation) return null;
    return { sourceRow: index + 2, originalPartNumber: partNumber, originalQty: qty, originalBinLocation: binLocation, partNumber, qty, binLocation, corrections: [] };
  }).filter(Boolean);
}

async function resolveScope(req, requestedCode) {
  const dealerCode = upper(requestedCode);
  if (!dealerCode || dealerCode === 'ALL') throw Object.assign(new Error('Select one dealer before uploading.'), { statusCode: 400 });
  const access = await auth.validateUserDealerAccess(req.user, dealerCode);
  if (!access.allowed) throw Object.assign(new Error('Unauthorized dealer access.'), { statusCode: 403 });
  const [dealer, audit] = await Promise.all([
    Dealer.findOne({ dealerCode, active: { $ne: false } }).lean(),
    getActiveAudit({ dealerCode })
  ]);
  if (!dealer) throw Object.assign(new Error('Dealer was not found or is inactive.'), { statusCode: 404 });
  if (!audit) throw Object.assign(new Error('Start an active audit for this dealer before uploading stock.'), { statusCode: 409 });
  return { dealerCode, dealerName: dealer.dealerName || dealer.name || dealerCode, auditId: String(audit.auditId || audit._id) };
}

async function validateRows(dealerCode, auditId, inputRows) {
  const partNumbers = [...new Set(inputRows.map(row => normalizePartNumber(row.correctedPartNumber || row.partNumber || '')).filter(Boolean))];
  const pricesByPart = await getPricesFromPartMaster(partNumbers, dealerCode);
  const masterByPart = new Map([...pricesByPart].map(([part, price]) => [part, { price, master: price.masterRecord || price }]));
  const stockEntries = await Promise.all(partNumbers.map(async partNumber => [partNumber, await loadPartStock({ dealerCode, auditId, partNumber })]));
  const stockByPart = new Map(stockEntries);
  const rows = [];
  for (const input of inputRows) {
    if (input.committed === true || input.deleted === true) { rows.push({ ...input }); continue; }
    const row = { ...input };
    const partNumber = normalizePartNumber(row.correctedPartNumber || row.partNumber || '');
    const binLocation = upper(row.correctedBinLocation || row.binLocation || '');
    const qty = integerQty(row.correctedQty ?? row.qty);
    let reason = ''; let validationStatus = 'VALID';
    let master = null;
    if (!partNumber) reason = 'Part number is required';
    else {
      const matched = masterByPart.get(partNumber) || null;
      master = matched && matched.master;
      if (!master || master.activeStatus === false) { reason = 'Part not found in Part Master'; validationStatus = 'INVALID_PART_NUMBER'; }
      else {
        const pricing = matched.price || {};
        const dlc = Number(pricing.dlc ?? master.dlc ?? master.dlp ?? 0);
        const mrp = Number(pricing.mrp ?? master.mrp ?? 0);
        row.masterDlc = dlc > 0 ? dlc : null;
        row.masterMrp = mrp > 0 ? mrp : null;
        if (!(dlc > 0) && !(mrp > 0)) { reason = 'Both DLC and MRP are missing in Part Master'; validationStatus = 'BOTH_PRICES_MISSING'; }
        else if (!(dlc > 0)) { reason = 'DLC is missing in Part Master'; validationStatus = 'DLC_MISSING'; }
        else if (!(mrp > 0)) { reason = 'MRP is missing in Part Master'; validationStatus = 'MRP_MISSING'; }
      }
    }
    if (!reason && qty === null) reason = 'Quantity must be a positive whole number';
    if (!reason && !binLocation) reason = 'Bin missing';
    if (!reason && (binLocation.length > 50 || /[^A-Z0-9 _./-]/.test(binLocation))) reason = 'Enter a valid bin location';
    let existing = 0;
    if (!reason) {
      const stock = stockByPart.get(partNumber) || {};
      existing = Number(stock.binBreakdown?.find(item => upper(item.binLocation) === binLocation)?.availableQty ?? 0);
    }
    row.partNumber = partNumber || clean(row.partNumber);
    row.binLocation = binLocation || clean(row.binLocation);
    row.qty = qty ?? row.qty;
    row.existingQty = existing;
    row.finalQty = reason ? null : existing + qty;
    row.partDescription = clean(master?.partDescription || master?.partName || '');
    row.validationStatus = reason ? validationStatus : 'VALID';
    row.valuationStatus = reason && /DLC|MRP|Part Master/.test(reason) ? 'PENDING_UNVALUED' : 'VALUED';
    row.status = reason ? 'REJECTED' : 'ACCEPTED';
    row.reason = reason;
    row.checked = reason ? false : input.checked === true;
    rows.push(row);
  }
  // Surface repeated part/bin rows to the reviewer. They remain accepted because
  // a stock sheet may legitimately split one bin balance across rows; commit
  // retains a separate immutable receipt for each source row.
  const seen = new Map();
  rows.forEach(row => {
    if (row.status !== 'ACCEPTED') return;
    const key = `${normalizePartNumber(row.partNumber)}::${upper(row.binLocation)}`;
    if (seen.has(key)) {
      row.validationStatus = 'DUPLICATE_RECORD';
      row.reason = `Duplicate part and bin (matches Excel row ${seen.get(key)})`;
    } else seen.set(key, row.sourceRow);
  });
  return rows;
}

function summarize(rows) {
  const accepted = rows.filter(row => row.status === 'ACCEPTED');
  const rejected = rows.filter(row => row.status === 'REJECTED').length;
  const issues = rows.filter(row => row.status === 'REJECTED');
  const count = status => issues.filter(row => row.validationStatus === status);
  const acceptedQty = accepted.reduce((sum, row) => sum + Number(row.qty || 0), 0);
  const issueQty = issues.reduce((sum, row) => sum + Number(row.qty || 0), 0);
  return { acceptedRows: accepted.length, rejectedRows: rejected, uploadedQty: accepted.reduce((sum, row) => sum + Number(row.qty || 0), 0),
    validationSummary: { totalRows: rows.length, validRows: accepted.length, invalidPartRows: count('INVALID_PART_NUMBER').length,
      missingDlcRows: count('DLC_MISSING').length, missingMrpRows: count('MRP_MISSING').length, bothPricesMissingRows: count('BOTH_PRICES_MISSING').length,
      duplicateRows: rows.filter(row => row.validationStatus === 'DUPLICATE_RECORD').length, affectedQty: issueQty, pendingExceptionQty: issueQty,
      approvedStockQty: acceptedQty, uniqueAffectedSkus: new Set(issues.map(row => row.partNumber).filter(Boolean)).size,
      validatedDlcValue: accepted.reduce((sum, row) => sum + Number(row.qty || 0) * Number(row.masterDlc || 0), 0),
      validatedMrpValue: accepted.reduce((sum, row) => sum + Number(row.qty || 0) * Number(row.masterMrp || 0), 0) } };
}

router.get('/template', auth.requireAuth, async (_req, res, next) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Stock Upload');
    sheet.columns = [{ header: 'Part Number', key: 'partNumber', width: 24 }, { header: 'Qty', key: 'qty', width: 12 }, { header: 'Bin Location', key: 'binLocation', width: 20 }];
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12345B' } };
    sheet.getColumn(1).numFmt = '@';
    sheet.addRow({ partNumber: '52170ACL000S', qty: 2, binLocation: 'A030' });
    sheet.addRow({ partNumber: '20K211S', qty: 5, binLocation: 'BIN 1' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="daksh-stock-upload-template.xlsx"');
    await workbook.xlsx.write(res); res.end();
  } catch (error) { next(error); }
});

router.post('/preview', auth.requireAuth, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Choose an Excel file first.' });
    const scope = await resolveScope(req, req.body.dealerCode);
    const sourceRows = parseUploadRows(req.file);
    if (!sourceRows.length) return res.status(400).json({ success: false, message: 'No stock rows were found.' });
    if (sourceRows.length > 10000) return res.status(413).json({ success: false, message: 'A batch can contain at most 10,000 rows.' });
    const rows = await validateRows(scope.dealerCode, scope.auditId, sourceRows);
    const summary = summarize(rows); const batchId = `EXL-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const fileHash = createHash('sha256').update(`${scope.dealerCode}|${scope.auditId}|`).update(req.file.buffer).digest('hex');
    let batch;
    try {
      batch = await withDatabaseTransaction(async () => {
        const db = getPrismaClient();
        const duplicate = await db.excelStockUploadBatch.findFirst({ where: { dealerCode: scope.dealerCode, auditId: scope.auditId, fileHash } });
        if (duplicate) {
          if (!['PENDING', 'REVERSED', 'SUPERSEDED', 'CANCELLED', 'DELETED'].includes(duplicate.status)) {
            throw Object.assign(new Error(`Stock from this sheet was already added in batch ${duplicate.batchId}. Open that batch in Upload History to correct remaining rows.`), { statusCode: 409 });
          }
          await db.excelStockUploadBatch.update({ where: { id: duplicate.id }, data: {
            fileHash: `${fileHash}:replaced:${duplicate.id}`,
            ...(duplicate.status === 'PENDING' ? { status: 'SUPERSEDED' } : {})
          } });
        }
        return db.excelStockUploadBatch.create({ data: { batchId, dealerCode: scope.dealerCode, dealerName: scope.dealerName, auditId: scope.auditId, fileName: req.file.originalname.slice(0, 240), fileHash, uploadedBy: actor(req), uploadedByName: actorName(req), status: 'PENDING', acceptedRows: summary.acceptedRows, rejectedRows: summary.rejectedRows, uploadedQty: 0, rows } });
      }, { timeout: 60000 });
    } catch (error) {
      if (error.code === 'P2002') return res.status(409).json({ success: false, message: 'This file was submitted by another user at the same time. Refresh Upload History.' });
      throw error;
    }
    const responseSummary = summarize(batch.rows || []);
    res.status(201).json({ success: true, batch: { ...batch, acceptedRows: responseSummary.acceptedRows, rejectedRows: responseSummary.rejectedRows, validationSummary: responseSummary.validationSummary } });
  } catch (error) { next(error); }
});

router.get('/batches', auth.requireAuth, async (req, res, next) => {
  try {
    const dealerCode = upper(req.query.dealerCode);
    if (!dealerCode || dealerCode === 'ALL') return res.status(400).json({ success: false, message: 'Select one dealer to view Upload History.' });
    const access = await auth.validateUserDealerAccess(req.user, dealerCode);
    if (!access.allowed) return res.status(403).json({ success: false, message: 'Unauthorized dealer access.' });
    const batches = await getPrismaClient().excelStockUploadBatch.findMany({ where: { dealerCode, status: { not: 'DELETED' } }, select: batchFields, orderBy: { createdAt: 'desc' }, take: 100 });
    res.json({ success: true, batches: batches.map(batch => {
      const rows = (batch.rows || []).filter(row => !row.deleted);
      const { rows: _rows, ...receipt } = batch;
      return { ...receipt, ...summarize(rows), uploadedQty: rows.filter(row => row.committed).reduce((sum, row) => sum + Number(row.qty), 0) };
    }) });
  } catch (error) { next(error); }
});

router.get('/batches/:batchId', auth.requireAuth, async (req, res, next) => {
  try {
    const batch = await getPrismaClient().excelStockUploadBatch.findUnique({ where: { batchId: req.params.batchId }, select: batchFields });
    if (!batch) return res.status(404).json({ success: false, message: 'Upload batch not found.' });
    const access = await auth.validateUserDealerAccess(req.user, batch.dealerCode);
    if (!access.allowed) return res.status(403).json({ success: false, message: 'Unauthorized dealer access.' });
    const responseSummary = summarize((batch.rows || []).filter(row => !row.deleted));
    res.json({ success: true, batch: { ...batch, acceptedRows: responseSummary.acceptedRows, rejectedRows: responseSummary.rejectedRows, validationSummary: responseSummary.validationSummary } });
  } catch (error) { next(error); }
});

router.patch('/batches/:batchId/rows', auth.requireAuth, async (req, res, next) => {
  try {
    const updated = await withDatabaseTransaction(async () => {
    const db = getPrismaClient();
    const batch = await db.excelStockUploadBatch.findUnique({ where: { batchId: req.params.batchId } });
    if (!batch) throw Object.assign(new Error('Upload batch not found.'), { statusCode: 404 });
    const access = await auth.validateUserDealerAccess(req.user, batch.dealerCode);
    if (!access.allowed) throw Object.assign(new Error('Unauthorized dealer access.'), { statusCode: 403 });
    if (!['PENDING', 'PARTIALLY_COMMITTED'].includes(batch.status)) throw Object.assign(new Error('This batch is no longer editable.'), { statusCode: 409 });
    const requested = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (requested.length !== batch.rows.length) throw Object.assign(new Error('Upload rows cannot be added or removed.'), { statusCode: 400 });
    const edits = [];
    for (let index = 0; index < (batch.rows || []).length; index += 1) {
      const saved = batch.rows[index]; const incoming = requested[index];
      if (!incoming || incoming.sourceRow !== saved.sourceRow) throw Object.assign(new Error('Original Excel row identities cannot be changed.'), { statusCode: 400 });
      if (saved.committed || saved.deleted) {
        if (saved.partNumber !== incoming.partNumber || Number(saved.qty) !== Number(incoming.qty) || saved.binLocation !== incoming.binLocation) {
          throw Object.assign(new Error('Committed rows are locked and cannot be edited.'), { statusCode: 409 });
        }
        edits.push(saved);
        continue;
      }
      const changed = saved.partNumber !== incoming.partNumber || Number(saved.qty) !== Number(incoming.qty) || saved.binLocation !== incoming.binLocation;
      edits.push({ ...saved, partNumber: incoming.partNumber, qty: incoming.qty, binLocation: incoming.binLocation,
        correctedPartNumber: '', correctedQty: undefined, correctedBinLocation: '', checked: !changed && incoming.checked === true,
        corrections: changed ? [...(saved.corrections || []), { at: new Date().toISOString(), by: actorName(req), partNumber: incoming.partNumber, qty: incoming.qty, binLocation: incoming.binLocation }] : saved.corrections || [] });
    }
    const validated = await validateRows(batch.dealerCode, batch.auditId, edits);
    const summary = summarize(validated);
    return db.excelStockUploadBatch.update({ where: { id: batch.id }, data: {
      rows: validated,
      acceptedRows: summary.acceptedRows,
      rejectedRows: summary.rejectedRows,
      uploadedQty: batch.status === 'PARTIALLY_COMMITTED' ? batch.uploadedQty : summary.uploadedQty
    }, select: batchFields });
    }, { timeout: 60000 });
    const responseSummary = summarize((updated.rows || []).filter(row => !row.deleted));
    res.json({ success: true, batch: { ...updated, acceptedRows: responseSummary.acceptedRows, rejectedRows: responseSummary.rejectedRows, validationSummary: responseSummary.validationSummary } });
  } catch (error) { next(error); }
});

router.post('/batches/:batchId/confirm', auth.requireAuth, async (req, res, next) => {
  try {
    const access = await auth.validateUserDealerAccess(req.user, upper(req.body.dealerCode));
    if (!access.allowed) return res.status(403).json({ success: false, message: 'Unauthorized dealer access.' });
    const result = await withDatabaseTransaction(async () => {
      const db = getPrismaClient();
      const batch = await db.excelStockUploadBatch.findUnique({ where: { batchId: req.params.batchId } });
      if (!batch || batch.dealerCode !== upper(req.body.dealerCode)) throw Object.assign(new Error('Upload batch was not found for this dealer.'), { statusCode: 404 });
      if (!['PENDING', 'PARTIALLY_COMMITTED'].includes(batch.status)) throw Object.assign(new Error('This batch has already been submitted.'), { statusCode: 409 });
      const scope = await resolveScope(req, batch.dealerCode);
      if (scope.auditId !== batch.auditId) throw Object.assign(new Error('The active audit changed. Preview this file again before committing.'), { statusCode: 409 });
      const rows = await validateRows(batch.dealerCode, batch.auditId, batch.rows);
      const eligible = rows.filter(row => row.status === 'ACCEPTED' && row.checked === true && row.committed !== true);
      if (!eligible.length) throw Object.assign(new Error('Select at least one valid row and mark it checked before confirming.'), { statusCode: 400 });
      const now = new Date();
      for (const row of eligible) {
        const bin = await Bin.findOne({ dealerCode: batch.dealerCode, binCode: row.binLocation }).lean();
        if (!bin) await Bin.create({ dealerCode: batch.dealerCode, binCode: row.binLocation, binName: row.binLocation, bin: row.binLocation, binLocation: row.binLocation, active: true });
        const stock = await loadPartStock({ dealerCode: batch.dealerCode, auditId: batch.auditId, partNumber: row.partNumber });
        const existing = Number(stock.binBreakdown?.find(item => upper(item.binLocation) === row.binLocation)?.availableQty ?? 0);
        const scanId = `EXCEL-${batch.batchId}-${row.sourceRow}-${randomUUID()}`;
        await Inventory.create({ dealerCode: batch.dealerCode, dealerName: batch.dealerName, auditId: batch.auditId,
          partNumber: row.partNumber, normalizedPartNumber: row.partNumber, part: row.partNumber,
          partName: row.partDescription, quantity: row.qty, qty: row.qty,
          binLocation: row.binLocation, bin: row.binLocation, currentBin: row.binLocation,
          scanType: 'INWARD', type: 'INWARD', movementType: 'INWARD', source: 'EXCEL_MANUAL', scanMode: 'Excel Manual Stock Upload',
          masterFound: true, masterMatch: true, isMasterMatched: true, isLocalPart: false,
          activeInventory: true, remainingQty: Number(row.qty), status: 'ACCEPTED', scanStatus: 'ACCEPTED', syncStatus: 'synced',
          uniqueScanId: scanId, scanId,
          timestamp: now, scanTime: now, createdAt: now,
          userId: actor(req), loginId: req.user?.username || '', username: req.user?.username || '', userName: actorName(req), staffName: actorName(req), role: req.user?.role || '',
          createdBy: actor(req), createdByUsername: req.user?.username || '', createdByName: actorName(req), createdByRole: req.user?.role || '',
          uploadBatchId: batch.batchId, uploadExistingQty: existing, uploadFinalQty: existing + Number(row.qty) });
        row.existingQty = existing;
        row.finalQty = existing + Number(row.qty);
      }
      const committedIds = new Set(eligible.map(row => row.sourceRow));
      const updatedRows = rows.map(row => committedIds.has(row.sourceRow) ? { ...row, committed: true, committedAt: now.toISOString() } : row);
      const allCommitted = updatedRows.every(row => row.committed === true || row.deleted === true);
      const previouslyCommittedRows = (batch.rows || []).filter(row => row.committed === true && !row.deleted);
      const previouslyCommitted = previouslyCommittedRows.length;
      const previouslyUploadedQty = previouslyCommittedRows.reduce((sum, row) => sum + Number(row.qty || 0), 0);
      const cumulativeQty = previouslyUploadedQty + eligible.reduce((sum, row) => sum + Number(row.qty), 0);
      const rejectedRows = updatedRows.filter(row => row.status === 'REJECTED').length;
      await db.excelStockUploadBatch.update({ where: { id: batch.id }, data: { status: allCommitted ? 'COMMITTED' : 'PARTIALLY_COMMITTED', rows: updatedRows, acceptedRows: summarize(updatedRows).acceptedRows, rejectedRows, uploadedQty: cumulativeQty } });
      return { acceptedRows: eligible.length, rejectedRows, uploadedQty: eligible.reduce((sum, row) => sum + Number(row.qty), 0), totalAcceptedRows: previouslyCommitted + eligible.length, totalUploadedQty: cumulativeQty, status: allCommitted ? 'COMMITTED' : 'PARTIALLY_COMMITTED', dealerCode: batch.dealerCode, auditId: batch.auditId, committedRows: eligible };
    }, { timeout: 60000 });
    const { committedRows, ...summary } = result;
    const { recordPartBinLocationFromScan } = require('../services/PartBinLocationService');
    try {
      for (const row of committedRows) await recordPartBinLocationFromScan({ dealerCode: result.dealerCode, auditId: result.auditId, partNumber: row.partNumber, normalizedPartNumber: row.partNumber, binLocation: row.binLocation, qty: row.qty, quantity: row.qty, scanType: 'INWARD', source: 'EXCEL_MANUAL', userName: actorName(req) }, { incremental: true });
    } catch (projectionError) { console.error('Excel stock upload committed but bin projection refresh failed:', projectionError.message); }
    require('../utils/safeCache').invalidateCache({ namespaces: ['dashboard', 'report', 'report-download', 'reconciliation'], tags: ['scan', 'inventory', 'stock'], scope: { dealerCode: result.dealerCode, auditId: result.auditId }, clearInFlight: true });
    const io = req.io || req.app?.get('io');
    io?.emit('inventory:update', { reason: 'excel-manual-stock-upload', dealerCode: result.dealerCode, auditId: result.auditId, batchId: req.params.batchId, at: new Date().toISOString() });
    io?.emit('reports:update', { reason: 'excel-manual-stock-upload', dealerCode: result.dealerCode, auditId: result.auditId, batchId: req.params.batchId, at: new Date().toISOString() });
    res.json({ success: true, message: 'Verified stock was committed.', ...summary });
  } catch (error) { next(error); }
});

router.delete('/batches/:batchId', auth.requireAuth, async (req, res, next) => {
  try {
    const batch = await withDatabaseTransaction(async () => {
      const db = getPrismaClient();
      const saved = await db.excelStockUploadBatch.findUnique({ where: { batchId: req.params.batchId } });
      if (!saved) throw Object.assign(new Error('Upload batch not found.'), { statusCode: 404 });
      const access = await auth.validateUserDealerAccess(req.user, saved.dealerCode);
      if (!access.allowed) throw Object.assign(new Error('Unauthorized dealer access.'), { statusCode: 403 });
      if (saved.status === 'DELETED') throw Object.assign(new Error('This upload is already deleted.'), { statusCode: 409 });
      const committed = saved.rows.filter(row => row.committed && !row.deleted);
      if (committed.length && ['COMMITTED', 'PARTIALLY_COMMITTED'].includes(saved.status)) {
        const scope = await resolveScope(req, saved.dealerCode);
        if (scope.auditId !== saved.auditId) throw Object.assign(new Error('Only uploads in the active audit can have their stock deleted.'), { statusCode: 409 });
        const scans = await Inventory.find({ dealerCode: saved.dealerCode, auditId: saved.auditId, uploadBatchId: saved.batchId, source: 'EXCEL_MANUAL', isDeleted: { $ne: true } }).lean();
        if (scans.length !== committed.length || committed.some(row => scans.filter(scan =>
          (String(scan.scanId || '').startsWith(`EXCEL-${saved.batchId}-${row.sourceRow}-`) || String(scan.uniqueScanId || '').startsWith(`EXCEL-${saved.batchId}-${row.sourceRow}-`))
          && normalizePartNumber(scan.partNumber) === row.partNumber && upper(scan.binLocation || scan.bin) === row.binLocation && Number(scan.qty ?? scan.quantity) === Number(row.qty)).length !== 1)) {
          throw Object.assign(new Error('Uploaded stock records do not match the batch receipt; deletion was stopped.'), { statusCode: 409 });
        }
        const removed = await require('../services/ScanModificationService').softDeleteScans({ _id: { $in: scans.map(scan => scan._id || scan.id) }, dealerCode: saved.dealerCode }, req, { reason: 'Incorrect Excel stock upload deleted from history' });
        if (removed.deletedCount !== committed.length) throw Object.assign(new Error('Uploaded stock could not be fully deleted.'), { statusCode: 409 });
      }
      await ScanAuditLog.create({ action: 'DELETE', scanId: saved.batchId, dealerCode: saved.dealerCode, dealerName: saved.dealerName,
        auditId: saved.auditId, performedByUserId: actor(req), performedByUsername: req.user?.username || '', performedByName: actorName(req), performedByRole: req.user?.role || '',
        reason: 'Excel stock upload removed from history', oldData: { status: saved.status, fileName: saved.fileName, uploadedQty: saved.uploadedQty }, newData: { status: 'DELETED' }, timestamp: new Date() });
      return db.excelStockUploadBatch.update({ where: { id: saved.id }, data: { status: 'DELETED' }, select: batchFields });
    }, { timeout: 60000 });
    require('../utils/safeCache').invalidateCache({ namespaces: ['dashboard', 'report', 'report-download', 'reconciliation'], tags: ['scan', 'inventory', 'stock'], scope: { dealerCode: batch.dealerCode, auditId: batch.auditId }, clearInFlight: true });
    const io = req.io || req.app?.get('io');
    for (const event of ['inventory:update', 'reports:update']) io?.emit(event, { reason: 'excel-upload-batch-deleted', dealerCode: batch.dealerCode, auditId: batch.auditId, batchId: batch.batchId });
    res.json({ success: true, message: 'Upload deleted from history.', batchId: batch.batchId });
  } catch (error) { next(error); }
});

router.delete('/batches/:batchId/rows/:sourceRow', auth.requireAuth, async (req, res, next) => {
  try {
    const batch = await withDatabaseTransaction(async () => {
      const db = getPrismaClient();
      const saved = await db.excelStockUploadBatch.findUnique({ where: { batchId: req.params.batchId } });
      if (!saved) throw Object.assign(new Error('Upload batch not found.'), { statusCode: 404 });
      const access = await auth.validateUserDealerAccess(req.user, saved.dealerCode);
      if (!access.allowed) throw Object.assign(new Error('Unauthorized dealer access.'), { statusCode: 403 });
      if (!['PENDING', 'PARTIALLY_COMMITTED', 'COMMITTED'].includes(saved.status)) throw Object.assign(new Error('This batch can no longer be changed.'), { statusCode: 409 });
      const row = saved.rows.find(item => item.sourceRow === Number(req.params.sourceRow));
      if (!row || row.deleted) throw Object.assign(new Error('Upload row was not found or is already deleted.'), { statusCode: 404 });
      if (row.committed) {
        const scope = await resolveScope(req, saved.dealerCode);
        if (scope.auditId !== saved.auditId) throw Object.assign(new Error('Only rows in the active audit can be deleted.'), { statusCode: 409 });
        const scans = await Inventory.find({ dealerCode: saved.dealerCode, auditId: saved.auditId, uploadBatchId: saved.batchId, source: 'EXCEL_MANUAL', isDeleted: { $ne: true } }).lean();
        const prefix = `EXCEL-${saved.batchId}-${row.sourceRow}-`;
        const matches = scans.filter(scan => (String(scan.scanId || '').startsWith(prefix) || String(scan.uniqueScanId || '').startsWith(prefix))
          && normalizePartNumber(scan.partNumber) === row.partNumber && upper(scan.binLocation || scan.bin) === row.binLocation && Number(scan.qty ?? scan.quantity) === Number(row.qty));
        if (matches.length !== 1) throw Object.assign(new Error('The uploaded stock record does not match this row; deletion was stopped.'), { statusCode: 409 });
        const removed = await require('../services/ScanModificationService').softDeleteScans({ _id: matches[0]._id || matches[0].id, dealerCode: saved.dealerCode }, req, { reason: 'Incorrect part removed from Excel stock upload' });
        if (removed.deletedCount !== 1) throw Object.assign(new Error('The uploaded stock row could not be deleted.'), { statusCode: 409 });
      }
      row.deleted = true; row.deletedAt = new Date().toISOString(); row.deletedBy = actor(req); row.status = 'DELETED'; row.checked = false;
      const remaining = saved.rows.filter(item => !item.deleted);
      const committed = remaining.filter(item => item.committed);
      const status = !remaining.length ? 'CANCELLED' : committed.length === remaining.length ? 'COMMITTED' : committed.length ? 'PARTIALLY_COMMITTED' : 'PENDING';
      const summary = summarize(remaining);
      return db.excelStockUploadBatch.update({ where: { id: saved.id }, data: { rows: saved.rows, status, ...summary,
        uploadedQty: status === 'PENDING' ? summary.uploadedQty : committed.reduce((sum, item) => sum + Number(item.qty), 0) }, select: batchFields });
    }, { timeout: 60000 });
    require('../utils/safeCache').invalidateCache({ namespaces: ['dashboard', 'report', 'report-download', 'reconciliation'], tags: ['scan', 'inventory', 'stock'], scope: { dealerCode: batch.dealerCode, auditId: batch.auditId }, clearInFlight: true });
    const io = req.io || req.app?.get('io');
    for (const event of ['inventory:update', 'reports:update']) io?.emit(event, { reason: 'excel-upload-row-deleted', dealerCode: batch.dealerCode, auditId: batch.auditId, batchId: batch.batchId });
    res.json({ success: true, message: 'Part removed from the upload.', batch });
  } catch (error) { next(error); }
});

router.post('/batches/:batchId/reverse', auth.requireAuth, auth.requireAdmin, async (req, res, next) => {
  try {
    const batchRef = await getPrismaClient().excelStockUploadBatch.findUnique({ where: { batchId: req.params.batchId } });
    if (!batchRef) return res.status(404).json({ success: false, message: 'Upload batch not found.' });
    const access = await auth.validateUserDealerAccess(req.user, batchRef.dealerCode);
    if (!access.allowed) return res.status(403).json({ success: false, message: 'Unauthorized dealer access.' });
    const result = await withDatabaseTransaction(async () => {
      const db = getPrismaClient();
      const batch = await db.excelStockUploadBatch.findUnique({ where: { batchId: req.params.batchId } });
      if (batch.status !== 'COMMITTED') throw Object.assign(new Error('Only a fully committed, unreversed batch can be reversed.'), { statusCode: 409 });
      const rows = (batch.rows || []).filter(row => row.committed === true && !row.deleted);
      const now = new Date();
      const sourceRows = await Inventory.find({ dealerCode: batch.dealerCode, auditId: batch.auditId, uploadBatchId: batch.batchId, source: 'EXCEL_MANUAL', isDeleted: { $ne: true } }).lean();
      if (sourceRows.length !== rows.length) throw Object.assign(new Error('Committed Excel ledger records do not match the batch receipt; reversal was stopped for review.'), { statusCode: 409 });
      for (const source of sourceRows) {
        const matches = rows.find(row => normalizePartNumber(row.partNumber) === normalizePartNumber(source.normalizedPartNumber || source.partNumber)
          && upper(row.binLocation) === upper(source.binLocation || source.bin)
          && Number(row.qty) === Number(source.qty ?? source.quantity));
        if (!matches || source.source !== 'EXCEL_MANUAL' || String(source.scanType || source.movementType).toUpperCase() !== 'INWARD') {
          throw Object.assign(new Error('A batch ledger row does not match its committed receipt; reversal was stopped for review.'), { statusCode: 409 });
        }
        if (source.status === 'SUCCESS' || source.scanStatus === 'SUCCESS') {
          const oldData = { status: source.status, scanStatus: source.scanStatus };
          await Inventory.updateOne({ _id: source._id }, { $set: { status: 'ACCEPTED', scanStatus: 'ACCEPTED', activeInventory: true, remainingQty: Number(source.qty ?? source.quantity) } });
          await ScanAuditLog.create({ action: 'UPDATE', scanId: String(source._id || source.id), dealerCode: batch.dealerCode,
            dealerName: batch.dealerName, partNumber: source.partNumber, performedByUserId: actor(req),
            performedByUsername: req.user?.username || '', performedByName: actorName(req), performedByRole: req.user?.role || '',
            reason: 'Excel upload ledger status correction before controlled batch reversal', oldData,
            newData: { status: 'ACCEPTED', scanStatus: 'ACCEPTED' }, timestamp: now });
        }
      }
      const byPartBin = new Map();
      for (const row of rows) {
        const key = `${normalizePartNumber(row.partNumber)}|${upper(row.binLocation)}`;
        byPartBin.set(key, (byPartBin.get(key) || 0) + Number(row.qty));
      }
      for (const [key, qty] of byPartBin) {
        const [partNumber, binLocation] = key.split('|');
        const stock = await loadPartStock({ dealerCode: batch.dealerCode, auditId: batch.auditId, partNumber });
        const available = Number(stock.binBreakdown?.find(item => upper(item.binLocation) === binLocation)?.availableQty ?? 0);
        if (available < qty) throw Object.assign(new Error(`Cannot reverse ${partNumber} in ${binLocation}: only ${available} units remain available.`), { statusCode: 409 });
      }
      for (const row of rows) {
        const scanId = `EXCEL-REV-${batch.batchId}-${row.sourceRow}-${randomUUID()}`;
        await Inventory.create({ dealerCode: batch.dealerCode, dealerName: batch.dealerName, auditId: batch.auditId,
          partNumber: row.partNumber, normalizedPartNumber: row.partNumber, part: row.partNumber,
          partName: row.partDescription, quantity: row.qty, qty: row.qty,
          binLocation: row.binLocation, bin: row.binLocation, currentBin: row.binLocation, stockDeductedFromBin: row.binLocation,
          scanType: 'OUTWARD', type: 'OUTWARD', movementType: 'OUTWARD', source: 'EXCEL_MANUAL_REVERSAL', scanMode: 'Excel Manual Stock Upload Reversal',
          masterFound: true, masterMatch: true, isMasterMatched: true, isLocalPart: false,
          activeInventory: false, remainingQty: 0, status: 'ACCEPTED', scanStatus: 'ACCEPTED', syncStatus: 'synced',
          uniqueScanId: scanId, scanId, timestamp: now, scanTime: now, createdAt: now,
          userId: actor(req), loginId: req.user?.username || '', username: req.user?.username || '', userName: actorName(req), staffName: actorName(req), role: req.user?.role || '',
          createdBy: actor(req), createdByUsername: req.user?.username || '', createdByName: actorName(req), createdByRole: req.user?.role || '',
          uploadBatchId: batch.batchId, reversalOf: row.sourceRow });
      }
      await db.excelStockUploadBatch.update({ where: { id: batch.id }, data: { status: 'REVERSED' } });
      return { dealerCode: batch.dealerCode, auditId: batch.auditId, reversedRows: rows.length, reversedQty: rows.reduce((sum, row) => sum + Number(row.qty || 0), 0), rows };
    }, { timeout: 60000 });
    const { recordPartBinLocationFromScan } = require('../services/PartBinLocationService');
    try {
      for (const row of result.rows) await recordPartBinLocationFromScan({ dealerCode: result.dealerCode, auditId: result.auditId, partNumber: row.partNumber, normalizedPartNumber: row.partNumber, binLocation: row.binLocation, stockDeductedFromBin: row.binLocation, qty: row.qty, quantity: row.qty, scanType: 'OUTWARD', source: 'EXCEL_MANUAL_REVERSAL', userName: actorName(req) }, { incremental: true });
    } catch (projectionError) { console.error('Excel stock reversal committed but bin projection refresh failed:', projectionError.message); }
    require('../utils/safeCache').invalidateCache({ namespaces: ['dashboard', 'report', 'report-download', 'reconciliation'], tags: ['scan', 'inventory', 'stock'], scope: { dealerCode: result.dealerCode, auditId: result.auditId }, clearInFlight: true });
    const io = req.io || req.app?.get('io');
    io?.emit('inventory:update', { reason: 'excel-manual-stock-reversal', dealerCode: result.dealerCode, auditId: result.auditId, batchId: req.params.batchId, at: new Date().toISOString() });
    io?.emit('reports:update', { reason: 'excel-manual-stock-reversal', dealerCode: result.dealerCode, auditId: result.auditId, batchId: req.params.batchId, at: new Date().toISOString() });
    const { rows: _rows, ...summary } = result;
    res.json({ success: true, message: 'Reversal transactions were recorded.', ...summary });
  } catch (error) { next(error); }
});

async function writeExceptionsWorkbook(req, res, next) {
  try {
    const batch = await getPrismaClient().excelStockUploadBatch.findUnique({ where: { batchId: req.params.batchId } });
    if (!batch) return res.status(404).json({ success: false, message: 'Upload batch not found.' });
    const access = await auth.validateUserDealerAccess(req.user, batch.dealerCode);
    if (!access.allowed) return res.status(403).json({ success: false, message: 'Unauthorized dealer access.' });
    const selectedRows = new Set(clean(req.query.sourceRows).split(',').map(Number).filter(Number.isInteger));
    const exceptions = (batch.rows || []).filter(row => (row.status === 'REJECTED' || row.validationStatus === 'DUPLICATE_RECORD') && !row.deleted && (!selectedRows.size || selectedRows.has(Number(row.sourceRow))));
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Daksh Inventory Solution V2'; workbook.created = new Date();
    const summary = workbook.addWorksheet('Summary', { views: [{ state: 'frozen', ySplit: 1 }] });
    summary.columns = [{ header: 'Field', key: 'field', width: 34 }, { header: 'Value', key: 'value', width: 28 }];
    summary.addRows([
      { field: 'Dealer Code', value: batch.dealerCode }, { field: 'Dealer Name', value: batch.dealerName },
      { field: 'Audit ID', value: batch.auditId }, { field: 'Upload Batch', value: batch.batchId },
      { field: 'Exception Rows Exported', value: exceptions.length }, { field: 'Generated At', value: new Date().toISOString() }
    ]);
    const sheet = workbook.addWorksheet('Exceptions', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'Dealer Code', key: 'dealerCode', width: 16 }, { header: 'Audit ID', key: 'auditId', width: 20 },
      { header: 'Original Excel Row Number', key: 'sourceRow', width: 22 }, { header: 'Part Number', key: 'partNumber', width: 24 },
      { header: 'Part Description', key: 'partDescription', width: 32 }, { header: 'Uploaded Quantity', key: 'qty', width: 18 },
      { header: 'Bin Location', key: 'binLocation', width: 20 }, { header: 'DLC', key: 'masterDlc', width: 14 }, { header: 'MRP', key: 'masterMrp', width: 14 },
      { header: 'Issue Type', key: 'validationStatus', width: 24 }, { header: 'Issue Detail', key: 'reason', width: 42 },
      { header: 'Correction Status', key: 'correctionStatus', width: 22 }
    ];
    exceptions.forEach(row => sheet.addRow({ ...row, dealerCode: batch.dealerCode, auditId: batch.auditId, correctionStatus: (row.corrections || []).length ? 'Corrected — revalidation pending' : 'Correction required' }));
    for (const worksheet of [summary, sheet]) {
      worksheet.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + worksheet.columnCount)}1` };
      worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF173F68' } };
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', `attachment; filename="${batch.batchId}-exceptions.xlsx"`);
    await workbook.xlsx.write(res); res.end();
  } catch (error) { next(error); }
}

router.get('/batches/:batchId/exceptions.xlsx', auth.requireAuth, writeExceptionsWorkbook);
router.get('/batches/:batchId/rejected.xlsx', auth.requireAuth, writeExceptionsWorkbook);

module.exports = router;
