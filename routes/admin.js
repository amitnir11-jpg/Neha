const express = require('express');
const mongoose = require('mongoose');
const Inventory = require('../models/Inventory');
const MasterPart = require('../models/MasterPart');
const Bin = require('../models/Bin');
const Dealer = require('../models/Dealer');
const VerificationLog = require('../models/VerificationLog');
const DuplicateScanLog = require('../models/DuplicateScanLog');
const SkewEvent = require('../models/SkewEvent');
const auth = require('./auth');
const inventory = require('./inventory');
const smtpConfig = require('../utils/smtpConfig');
const { cleanText, normalizePartNumber, normalizeCategory } = require('../utils/normalize');

const router = express.Router();
const DELETE_MESSAGE = 'Are you sure you want to delete this data? This action cannot be undone.';

function normalizedPartNumber(value) {
  return normalizePartNumber(value);
}

function dealerCode(value) {
  return inventory.normalizeDealerCode(value);
}

function masterCompletenessScore(part = {}) {
  return [
    part.partDescription || part.partName || part.description || part.name,
    part.productCategory || part.category || part.partCategory || part.categories,
    part.manufacturingYear || part.year,
    part.model,
    Number(part.mrp || part.price || part.rate || 0) > 0 ? 'mrp' : '',
    Number(part.dlc || 0) > 0 ? 'dlc' : '',
    Number(part.openingStockQty || part.quantity || part.qty || 0) > 0 ? 'qty' : '',
    part.bin || part.binLocation
  ].filter(Boolean).length;
}

function pickCanonicalMaster(parts = []) {
  return parts.slice().sort((a, b) => {
    const scoreDiff = masterCompletenessScore(b) - masterCompletenessScore(a);
    if (scoreDiff) return scoreDiff;
    return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
  })[0];
}

function partMatch(partNumber, dealer = '') {
  const normalized = normalizedPartNumber(partNumber);
  const regex = new RegExp(String(normalized || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const clauses = [
    { normalizedPartNumber: normalized },
    { partNo: normalized },
    { partNumber: normalized },
    { part: normalized },
    { rawScan: regex },
    { rawScanString: regex },
    { rawUpi: regex }
  ];
  const filter = { $or: clauses };
  if (dealer) filter.dealerCode = dealerCode(dealer);
  return filter;
}

function scanIdMatch(scanId) {
  const id = String(scanId || '').trim();
  const clauses = [{ scanId: id }, { uniqueScanId: id }];
  if (mongoose.Types.ObjectId.isValid(id)) clauses.push({ _id: id });
  return { $or: clauses };
}

function dateRangeFilter(body = {}) {
  const filter = {};
  const from = body.fromDate || body.dateFrom || body.from;
  const to = body.toDate || body.dateTo || body.to;
  if (from || to) {
    filter.timestamp = {};
    const fromDate = from ? new Date(from) : null;
    const toDate = to ? new Date(to) : null;
    if (fromDate && !Number.isNaN(fromDate.getTime())) filter.timestamp.$gte = fromDate;
    if (toDate && !Number.isNaN(toDate.getTime())) {
      toDate.setHours(23, 59, 59, 999);
      filter.timestamp.$lte = toDate;
    }
  }
  return filter;
}

function scanCriteria(body = {}) {
  const filter = { ...dateRangeFilter(body) };
  if (body.dealerCode) filter.dealerCode = dealerCode(body.dealerCode);
  if (body.partNumber) Object.assign(filter, partMatch(body.partNumber, body.dealerCode));
  return filter;
}

async function unknownScanFilter(extra = {}) {
  const scans = await Inventory.find(extra).select('_id normalizedPartNumber partNumber part dealerCode warnings isMasterMatched').lean();
  const parts = Array.from(new Set(scans.map((scan) => normalizedPartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part)).filter(Boolean)));
  const masters = parts.length ? await MasterPart.find({ normalizedPartNumber: { $in: parts } }).select('normalizedPartNumber partNumber partNo dealerCode').lean() : [];
  const masterByDealer = new Set();
  const masterByPart = new Set();
  masters.forEach((master) => {
    const partNo = normalizedPartNumber(master.normalizedPartNumber || master.partNumber || master.partNo);
    const code = dealerCode(master.dealerCode);
    if (partNo) masterByPart.add(partNo);
    if (partNo && code) masterByDealer.add(`${partNo}::${code}`);
  });
  const ids = scans
    .filter((scan) => {
      const partNo = normalizedPartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part);
      const code = dealerCode(scan.dealerCode);
      return !partNo || !(masterByDealer.has(`${partNo}::${code}`) || masterByPart.has(partNo));
    })
    .map((scan) => scan._id);
  return { _id: { $in: ids } };
}

async function emitRefresh(req) {
  if (!req.io) return;
  req.io.emit('scan:deleted');
  req.io.emit('master:update');
  req.io.emit('dealers:update');
  req.io.emit('stats:update');
}

async function cleanupDeleteByScope(scope, code = '') {
  const dealerFilter = code ? { dealerCode: code } : {};
  if (scope === 'old-bin-data') {
    const [binsDeleted, masterUpdated, scanUpdated] = await Promise.all([
      Bin.deleteMany(dealerFilter),
      MasterPart.updateMany(dealerFilter, { $set: { bin: '', binLocation: '' } }),
      Inventory.updateMany(dealerFilter, { $set: { bin: '', binLocation: '' } })
    ]);
    return {
      binsDeleted: binsDeleted.deletedCount || 0,
      masterUpdated: masterUpdated.modifiedCount || 0,
      scansUpdated: scanUpdated.modifiedCount || 0
    };
  }

  if (scope === 'unknown-part-scan-data') {
    const [legacyUnknownDeleted, verificationDeleted] = await Promise.all([
      Inventory.deleteMany({ ...dealerFilter, $or: [{ masterFound: false }, { masterMatch: false }, { isMasterMatched: false }] }),
      VerificationLog.deleteMany({ ...dealerFilter, found: false })
    ]);
    return {
      scansDeleted: legacyUnknownDeleted.deletedCount || 0,
      verificationDeleted: verificationDeleted.deletedCount || 0
    };
  }

  if (scope === 'mobile-scan-data') {
    const [scanResult, verificationResult, duplicateLogsDeleted] = await Promise.all([
      Inventory.deleteMany({ ...dealerFilter, source: { $in: ['mobile', 'camera'] } }),
      VerificationLog.deleteMany({ ...dealerFilter, source: { $in: ['mobile', 'camera'] } }),
      DuplicateScanLog.deleteMany({ ...dealerFilter, source: { $in: ['mobile', 'camera', ''] } })
    ]);
    return {
      scansDeleted: scanResult.deletedCount || 0,
      verificationDeleted: verificationResult.deletedCount || 0,
      duplicateLogsDeleted: duplicateLogsDeleted.deletedCount || 0
    };
  }

  if (scope === 'manual-entry-data') {
    const [scanResult, verificationResult, duplicateLogsDeleted] = await Promise.all([
      Inventory.deleteMany({ ...dealerFilter, source: 'manual' }),
      VerificationLog.deleteMany({ ...dealerFilter, source: 'manual' }),
      DuplicateScanLog.deleteMany({ ...dealerFilter, source: 'manual' })
    ]);
    return {
      scansDeleted: scanResult.deletedCount || 0,
      verificationDeleted: verificationResult.deletedCount || 0,
      duplicateLogsDeleted: duplicateLogsDeleted.deletedCount || 0
    };
  }

  if (scope === 'selected-dealer-data') {
    return deleteDealerData(
      { params: { dealerCode: code }, io: null },
      {
        status() { return this; },
        json(payload) { this.payload = payload; return payload; }
      },
      'all'
    );
  }

  throw new Error('Invalid cleanup scope');
}

async function deleteDealerData(req, res, scope) {
  try {
    const code = dealerCode(req.params.dealerCode);
    console.log("Deleting dealer data:", code);
    if (!code) return res.status(400).json({ success: false, message: 'Dealer code is required' });

    const result = { dealerCode: code, scansDeleted: 0, duplicateLogsDeleted: 0, masterPartsDeleted: 0, binsDeleted: 0, dealersDeleted: 0 };
    if (scope === 'scans' || scope === 'all') {
      result.scansDeleted = (await Inventory.deleteMany({ dealerCode: code })).deletedCount || 0;
      result.duplicateLogsDeleted = (await DuplicateScanLog.deleteMany({ dealerCode: code })).deletedCount || 0;
    }
    if (scope === 'master-parts' || scope === 'all') result.masterPartsDeleted = (await MasterPart.deleteMany({ dealerCode: code })).deletedCount || 0;
    if (scope === 'bins' || scope === 'all') result.binsDeleted = (await Bin.deleteMany({ dealerCode: code })).deletedCount || 0;
    if (scope === 'all') result.dealersDeleted = (await Dealer.deleteMany({ dealerCode: code })).deletedCount || 0;
    await emitRefresh(req);
    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function reprocessScans(req, res) {
  try {
    const mastersBeforeNormalize = await MasterPart.find({}).lean();
    const duplicateGroups = new Map();
    mastersBeforeNormalize.forEach((part) => {
      const partNo = normalizedPartNumber(part.normalizedPartNumber || part.partNumber || part.partNo);
      if (!partNo) return;
      const group = duplicateGroups.get(partNo) || [];
      group.push(part);
      duplicateGroups.set(partNo, group);
    });
    const duplicateIdsToDelete = [];
    duplicateGroups.forEach((group) => {
      if (group.length < 2) return;
      const keeper = pickCanonicalMaster(group);
      group.forEach((part) => {
        if (String(part._id) !== String(keeper._id)) duplicateIdsToDelete.push(part._id);
      });
    });
    if (duplicateIdsToDelete.length) {
      await MasterPart.deleteMany({ _id: { $in: duplicateIdsToDelete } });
    }

    const mastersToNormalize = await MasterPart.find({}).lean();
    const masterOperations = mastersToNormalize.map((part) => {
      const partNo = normalizedPartNumber(part.normalizedPartNumber || part.partNumber || part.partNo);
      const partDescription = cleanText(part.partDescription || part.partName || part.description || part.name || '');
      const productCategory = normalizeCategory(part.productCategory || part.category || part.partCategory || part.categories || '');
      const manufacturingYear = cleanText(part.manufacturingYear || part.year || '');
      return {
        updateOne: {
          filter: { _id: part._id },
          update: {
            $set: {
              partNo,
              partNumber: partNo,
              normalizedPartNumber: partNo,
              partName: partDescription,
              partDescription,
              category: productCategory,
              productCategory,
              manufacturingYear,
              year: manufacturingYear,
              model: cleanText(part.model || ''),
              mrp: Number(part.mrp || part.price || part.rate || 0),
              dlc: Number(part.dlc || 0)
            }
          }
        }
      };
    });
    if (masterOperations.length) await MasterPart.bulkWrite(masterOperations, { ordered: false });

    const [scans, masters] = await Promise.all([Inventory.find({}).lean(), MasterPart.find({}).lean()]);
    const masterByDealer = new Map();
    const masterByPart = new Map();
    masters.forEach((master) => {
      const partNo = normalizedPartNumber(master.normalizedPartNumber || master.partNo || master.partNumber);
      const code = dealerCode(master.dealerCode);
      if (!partNo) return;
      if (code) masterByDealer.set(`${partNo}::${code}`, master);
      if (!masterByPart.has(partNo)) masterByPart.set(partNo, master);
    });

    let matchedCount = 0;
    const operations = scans.map((scan) => {
      const partNo = normalizedPartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part);
      const code = dealerCode(scan.dealerCode);
      const master = masterByDealer.get(`${partNo}::${code}`) || masterByPart.get(partNo);
      const update = {
        scanId: scan.scanId || scan.uniqueScanId,
        part: partNo,
        partNumber: partNo,
        normalizedPartNumber: partNo,
        rawUpi: scan.rawUpi || scan.rawScan || scan.rawScanString || '',
        isMasterMatched: Boolean(master)
      };
      if (master) {
        matchedCount += 1;
        update.partName = master.partDescription || master.partName || '';
        update.partDescription = master.partDescription || master.partName || '';
        update.category = master.productCategory || master.category || '';
        update.productCategory = master.productCategory || master.category || '';
        update.model = master.model || '';
        update.manufacturingYear = master.manufacturingYear || master.year || '';
        update.year = master.manufacturingYear || master.year || '';
        update.mrp = Number(master.mrp || 0);
        update.dlc = Number(master.dlc || 0);
      }
      return { updateOne: { filter: { _id: scan._id }, update: { $set: update } } };
    });

    if (operations.length) await Inventory.bulkWrite(operations, { ordered: false });
    await emitRefresh(req);
    res.json({ success: true, masterUpdatedCount: masterOperations.length, duplicateMasterDeleted: duplicateIdsToDelete.length, scannedRecords: scans.length, matchedCount, updatedCount: operations.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

router.post('/reprocess-scans', auth.requireAuth, auth.requireAdmin, reprocessScans);
router.post('/reprocess-master-lookup', auth.requireAuth, auth.requireAdmin, reprocessScans);

async function clockSkewList(req, res) {
  try {
    const thresholdMs = Number(req.query.thresholdMs || req.query.thresholdMinutes ? Number(req.query.thresholdMinutes) * 60000 : 300000);
    const sinceDays = Number(req.query.sinceDays || 7);
    const sinceDate = new Date(Date.now() - Math.max(0, sinceDays) * 24 * 60 * 60 * 1000);
    const filter = { eventType: 'sync_detected', skewMs: { $gte: thresholdMs }, createdAt: { $gte: sinceDate } };
    if (req.query.dealerCode) filter.dealerCode = inventory.normalizeDealerCode(req.query.dealerCode);
    if (req.query.deviceId) filter.deviceId = String(req.query.deviceId).trim();
    if (req.query.userId) filter.userId = String(req.query.userId).trim();

    const records = await SkewEvent.find(filter)
      .sort({ createdAt: -1 })
      .limit(5000)
      .lean();

    const byDevice = new Map();
    for (const doc of records) {
      const deviceId = (doc.deviceId || 'unknown').toString();
      const existing = byDevice.get(deviceId);
      if (!existing || new Date(doc.createdAt).getTime() > new Date(existing.createdAt).getTime()) {
        byDevice.set(deviceId, {
          deviceId,
          batchId: doc.batchId || '',
          dealerCode: doc.dealerCode || '',
          userId: doc.userId || '',
          serverTime: doc.serverTime ? new Date(doc.serverTime).toISOString() : '',
          deviceTime: doc.deviceTime ? new Date(doc.deviceTime).toISOString() : doc.mobileReceivedTimeUtc || '',
          skewMs: doc.skewMs || 0,
          lastSeen: doc.createdAt || doc.serverTime,
          message: doc.message || ''
        });
      }
    }

    const list = Array.from(byDevice.values()).sort((a, b) => b.skewMs - a.skewMs);
    res.json({ success: true, count: list.length, thresholdMs, list });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

async function notifyClockSkewDevices(req, res) {
  try {
    const deviceIds = Array.isArray(req.body.deviceIds) ? req.body.deviceIds.map(String).map((id) => id.trim()).filter(Boolean) : [];
    const message = String(req.body.message || 'Device date/time is skewed. Please open Date/Time Settings and correct it.');
    if (!deviceIds.length) return res.status(400).json({ success: false, message: 'No deviceIds provided.' });

    const io = req.app.get('io');
    if (io) {
      io.emit('sync:clockSkewNotify', { deviceIds, message, sentAt: new Date().toISOString() });
    }

    await SkewEvent.insertMany(deviceIds.map((deviceId) => ({
      deviceId,
      dealerCode: String(req.body.dealerCode || '').trim().toUpperCase(),
      userId: String(req.body.userId || '').trim(),
      batchId: String(req.body.batchId || '').trim(),
      serverTime: new Date(),
      skewMs: 0,
      status: 'admin_notified',
      eventType: 'admin_notification',
      message
    })));

    res.json({ success: true, deviceIds: deviceIds.length, message: 'Notification queued to devices.' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
}

router.get('/clock-skew', auth.requireAuth, auth.requireAdmin, clockSkewList);
router.post('/clock-skew/notify', auth.requireAuth, auth.requireAdmin, notifyClockSkewDevices);

router.get('/smtp-status', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const status = smtpConfig.publicStatus(await smtpConfig.getStoredSmtp(false));
    res.json({ success: true, smtp: status });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/smtp-save', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const smtp = await smtpConfig.saveSmtpSettings(req.body, req.user.username || req.user.name || 'admin');
    res.json({ success: true, smtp, message: 'Password Saved Securely. SMTP Configured' });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message || 'SMTP Test Failed' });
  }
});

router.post('/smtp-change-password', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const smtp = await smtpConfig.changeSmtpPassword(
      req.body.newPassword || req.body.smtpPassword,
      req.body.confirmPassword || req.body.confirmSmtpPassword,
      req.user.username || req.user.name || 'admin'
    );
    res.json({ success: true, smtp, message: 'Password Saved Securely. SMTP Configured' });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message || 'SMTP Test Failed' });
  }
});

router.post('/smtp-test', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    await smtpConfig.sendTestOtp(req.body.testEmail || req.body.email);
    res.json({ success: true, message: 'SMTP verified and OTP sent successfully' });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message || 'SMTP configuration failed. Please check email/app password.' });
  }
});

router.post('/reprocess-master-data', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const parts = await MasterPart.find({}).lean();
    const operations = parts.map((part) => {
      const partNo = normalizedPartNumber(part.normalizedPartNumber || part.partNumber || part.partNo);
      const partDescription = cleanText(part.partDescription || part.partName || part.description || part.name || '');
      const productCategory = normalizeCategory(part.productCategory || part.category || part.partCategory || part.categories || '');
      const year = cleanText(part.year || part.manufacturingYear || '');
      return {
        updateOne: {
          filter: { _id: part._id },
          update: {
            $set: {
              partNo,
              partNumber: partNo,
              normalizedPartNumber: partNo,
              partName: partDescription,
              partDescription,
              category: productCategory,
              productCategory,
              year,
              manufacturingYear: year,
              model: cleanText(part.model || ''),
              mrp: Number(part.mrp || part.price || part.rate || 0),
              dlc: Number(part.dlc || 0)
            }
          }
        }
      };
    });
    if (operations.length) await MasterPart.bulkWrite(operations, { ordered: false });
    const [scans, masters] = await Promise.all([Inventory.find({}).lean(), MasterPart.find({}).lean()]);
    const masterByDealer = new Map();
    const masterByPart = new Map();
    masters.forEach((master) => {
      const partNo = normalizedPartNumber(master.normalizedPartNumber || master.partNo || master.partNumber);
      const code = dealerCode(master.dealerCode);
      if (!partNo) return;
      if (code) masterByDealer.set(`${partNo}::${code}`, master);
      if (!masterByPart.has(partNo)) masterByPart.set(partNo, master);
    });
    let matchedCount = 0;
    const scanOperations = scans.map((scan) => {
      const partNo = normalizedPartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part);
      const code = dealerCode(scan.dealerCode);
      const master = masterByDealer.get(`${partNo}::${code}`) || masterByPart.get(partNo);
      const update = {
        part: partNo,
        partNumber: partNo,
        normalizedPartNumber: partNo,
        isMasterMatched: Boolean(master)
      };
      if (master) {
        matchedCount += 1;
        update.partName = master.partDescription || master.partName || '';
        update.partDescription = master.partDescription || master.partName || '';
        update.category = master.productCategory || master.category || '';
        update.productCategory = master.productCategory || master.category || '';
        update.model = master.model || '';
        update.manufacturingYear = master.manufacturingYear || master.year || '';
        update.year = master.manufacturingYear || master.year || '';
        update.mrp = Number(master.mrp || 0);
        update.dlc = Number(master.dlc || 0);
      }
      return { updateOne: { filter: { _id: scan._id }, update: { $set: update } } };
    });
    if (scanOperations.length) await Inventory.bulkWrite(scanOperations, { ordered: false });
    console.log('[master-reprocess] master rows normalized:', operations.length);
    console.log('[master-reprocess] report lookup scans refreshed:', scanOperations.length);
    console.log('[master-reprocess] unmatched scan part numbers count:', scans.length - matchedCount);
    await emitRefresh(req);
    res.json({ success: true, updatedCount: operations.length, scansUpdatedCount: scanOperations.length, matchedCount, unmatchedCount: scans.length - matchedCount });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/dealer/:dealerCode/scans', auth.requireAuth, auth.requireAdmin, (req, res) => deleteDealerData(req, res, 'scans'));
router.delete('/dealer/:dealerCode/master', auth.requireAuth, auth.requireAdmin, (req, res) => deleteDealerData(req, res, 'master-parts'));
router.delete('/dealer/:dealerCode/master-parts', auth.requireAuth, auth.requireAdmin, (req, res) => deleteDealerData(req, res, 'master-parts'));
router.delete('/dealer/:dealerCode/bins', auth.requireAuth, auth.requireAdmin, (req, res) => deleteDealerData(req, res, 'bins'));
router.delete('/dealer/:dealerCode/all', auth.requireAuth, auth.requireAdmin, (req, res) => deleteDealerData(req, res, 'all'));

router.get('/part/check', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const partNo = normalizedPartNumber(req.query.partNumber);
    const code = dealerCode(req.query.dealerCode);
    if (!partNo) return res.status(400).json({ success: false, message: 'Part number is required' });
    const [masterRecord, scanCount, bins, lastScan] = await Promise.all([
      MasterPart.findOne(partMatch(partNo, code)).lean(),
      Inventory.countDocuments(partMatch(partNo, code)),
      Inventory.distinct('binLocation', partMatch(partNo, code)),
      Inventory.findOne(partMatch(partNo, code)).sort({ timestamp: -1, createdAt: -1 }).lean()
    ]);
    res.json({
      success: true,
      normalizedPartNumber: partNo,
      masterRecord,
      scanCount,
      binLocations: bins.filter(Boolean),
      lastScanTime: lastScan ? lastScan.timestamp : null,
      reportsAffected: scanCount ? ['All scan-based reports for this part'] : []
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

async function partPreview(partNo, code = '') {
  const [masterRecord, scanCount, lastScan] = await Promise.all([
    MasterPart.findOne(partMatch(partNo, code)).lean(),
    Inventory.countDocuments(partMatch(partNo, code)),
    Inventory.findOne(partMatch(partNo, code)).sort({ timestamp: -1, createdAt: -1 }).lean()
  ]);
  return {
    partNumber: normalizedPartNumber(partNo),
    dealer: code || (lastScan && (lastScan.dealerName || lastScan.dealerCode)) || (masterRecord && (masterRecord.dealerName || masterRecord.dealerCode)) || '',
    scanCount,
    lastScanTime: lastScan ? lastScan.timestamp : null,
    masterFound: Boolean(masterRecord)
  };
}

function listedParts(body = {}) {
  const raw = Array.isArray(body.parts) ? body.parts.join('\n') : String(body.parts || body.partNumbers || '');
  return Array.from(new Set(raw.split(/[\n,;]+/).map(normalizedPartNumber).filter(Boolean)));
}

router.post('/parts/check', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const code = dealerCode(req.body.dealerCode || req.query.dealerCode);
    const parts = listedParts(req.body);
    const rows = await Promise.all(parts.map((partNo) => partPreview(partNo, code)));
    res.json({ success: true, rows, count: rows.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/parts/scans', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const code = dealerCode(req.body.dealerCode || req.query.dealerCode);
    const parts = listedParts(req.body);
    const filters = parts.map((partNo) => partMatch(partNo, code));
    const result = filters.length ? await Inventory.deleteMany({ $or: filters }) : { deletedCount: 0 };
    await emitRefresh(req);
    res.json({ success: true, deletedCount: result.deletedCount || 0, count: parts.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/parts/all', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const code = dealerCode(req.body.dealerCode || req.query.dealerCode);
    const parts = listedParts(req.body);
    const filters = parts.map((partNo) => partMatch(partNo, code));
    const [masterResult, scanResult] = filters.length ? await Promise.all([
      MasterPart.deleteMany({ $or: filters }),
      Inventory.deleteMany({ $or: filters })
    ]) : [{ deletedCount: 0 }, { deletedCount: 0 }];
    await emitRefresh(req);
    res.json({ success: true, masterDeleted: masterResult.deletedCount || 0, scansDeleted: scanResult.deletedCount || 0, count: parts.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/part/master', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const partNo = normalizedPartNumber(req.body.partNumber || req.query.partNumber);
    const code = dealerCode(req.body.dealerCode || req.query.dealerCode);
    console.log("Deleting part:", partNo);
    const result = await MasterPart.deleteMany(partMatch(partNo, code));
    await emitRefresh(req);
    res.json({ success: true, deletedCount: result.deletedCount || 0 });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/scans/:scanId', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const result = await Inventory.deleteOne(scanIdMatch(req.params.scanId));
    await emitRefresh(req);
    res.json({ success: true, message: DELETE_MESSAGE, deletedCount: result.deletedCount || 0 });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/scans/delete-selected', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ success: false, message: 'Select scans to delete' });
    const result = await Inventory.deleteMany({ $or: ids.map(scanIdMatch) });
    await emitRefresh(req);
    res.json({ success: true, message: DELETE_MESSAGE, deletedCount: result.deletedCount || 0 });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/scans/delete-by-parts', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const parts = listedParts(req.body);
    const code = dealerCode(req.body.dealerCode || req.query.dealerCode);
    const base = dateRangeFilter(req.body);
    const filters = parts.map((partNo) => ({ ...base, ...partMatch(partNo, code) }));
    const result = filters.length ? await Inventory.deleteMany({ $or: filters }) : { deletedCount: 0 };
    await emitRefresh(req);
    res.json({ success: true, message: DELETE_MESSAGE, deletedCount: result.deletedCount || 0, count: parts.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/cleanup-unknown-parts', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const filter = await unknownScanFilter(scanCriteria(req.body));
    const result = await Inventory.deleteMany(filter);
    await emitRefresh(req);
    res.json({ success: true, message: DELETE_MESSAGE, deletedCount: result.deletedCount || 0 });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/cleanup-delete', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const scope = String(req.body.scope || '').trim();
    const code = dealerCode(req.body.dealerCode || req.query.dealerCode);
    if (scope === 'selected-dealer-data' && !code) {
      return res.status(400).json({ success: false, message: 'Dealer code is required' });
    }
    const result = await cleanupDeleteByScope(scope, code);
    await emitRefresh(req);
    return res.json({ success: true, scope, dealerCode: code, ...result });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
});

router.delete('/part/scans', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const partNo = normalizedPartNumber(req.body.partNumber || req.query.partNumber);
    const code = dealerCode(req.body.dealerCode || req.query.dealerCode);
    console.log("Deleting part:", partNo);
    const result = await Inventory.deleteMany(partMatch(partNo, code));
    await emitRefresh(req);
    res.json({ success: true, deletedCount: result.deletedCount || 0 });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/part/all', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const partNo = normalizedPartNumber(req.body.partNumber || req.query.partNumber);
    const code = dealerCode(req.body.dealerCode || req.query.dealerCode);
    console.log("Deleting part:", partNo);
    const [masterResult, scanResult] = await Promise.all([
      MasterPart.deleteMany(partMatch(partNo, code)),
      Inventory.deleteMany(partMatch(partNo, code))
    ]);
    await emitRefresh(req);
    res.json({ success: true, masterDeleted: masterResult.deletedCount || 0, scansDeleted: scanResult.deletedCount || 0 });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
