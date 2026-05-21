const express = require('express');
const mongoose = require('mongoose');
const Inventory = require('../models/Inventory');
const MasterPart = require('../models/MasterPart');
const Bin = require('../models/Bin');
const Dealer = require('../models/Dealer');
const VerificationLog = require('../models/VerificationLog');
const BinTransferHistory = require('../models/BinTransferHistory');
const DuplicateScanLog = require('../models/DuplicateScanLog');
const auth = require('./auth');
const inventory = require('./inventory');
const { normalizePartNumber } = require('../utils/normalize');

const router = express.Router();

function dealerCode(value) {
  return inventory.normalizeDealerCode(value);
}

function partList(value) {
  return String(value || '')
    .split(/[\n,;]+/)
    .map((part) => normalizePartNumber(part))
    .filter(Boolean);
}

function dateFilter(input = {}) {
  const filter = {};
  const from = input.dateFrom || input.fromDate || input.from;
  const to = input.dateTo || input.toDate || input.to;
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

function idFilter(ids = []) {
  const terms = ids.map((id) => String(id || '').trim()).filter(Boolean).flatMap((id) => {
    const row = [{ scanId: id }, { uniqueScanId: id }];
    if (mongoose.Types.ObjectId.isValid(id)) row.push({ _id: id });
    return row;
  });
  return terms.length ? { $or: terms } : null;
}

function partFilter(parts = []) {
  const normalized = parts.map((part) => normalizePartNumber(part)).filter(Boolean);
  return normalized.length ? { $or: [{ normalizedPartNumber: { $in: normalized } }, { partNumber: { $in: normalized } }, { part: { $in: normalized } }, { partNo: { $in: normalized } }] } : {};
}

function criteriaParts(body = {}) {
  const parts = partList(body.parts || body.partNumbers);
  const single = normalizePartNumber(body.partNumber);
  if (single) parts.push(single);
  return Array.from(new Set(parts));
}

function scanFilter(body = {}) {
  const filter = { dealerCode: dealerCode(body.dealerCode), ...dateFilter(body) };
  const parts = criteriaParts(body);
  const type = String(body.deleteType || '').toLowerCase();
  if (parts.length && ['single-part', 'multiple-parts'].includes(type)) Object.assign(filter, partFilter(parts));
  if (type === 'unknown-not-master') {
    filter.$or = [{ masterFound: false }, { masterMatch: false }, { isMasterMatched: false }];
  }
  return filter;
}

function duplicateLogFilter(body = {}) {
  const filter = { dealerCode: dealerCode(body.dealerCode), ...dateFilter(body) };
  const parts = criteriaParts(body);
  if (parts.length) filter.partNumber = { $in: parts };
  return filter;
}

function masterFilter(body = {}) {
  const filter = { dealerCode: dealerCode(body.dealerCode) };
  const parts = criteriaParts(body);
  if (parts.length) Object.assign(filter, partFilter(parts));
  return filter;
}

function binFilter(body = {}) {
  return { dealerCode: dealerCode(body.dealerCode) };
}

function transferFilter(body = {}) {
  return { dealerCode: dealerCode(body.dealerCode) };
}

function locationScope(dataType) {
  const type = String(dataType || 'scan-data').toLowerCase();
  return {
    scans: ['scan-data', 'full-dealer-data'].includes(type),
    master: ['master-data', 'full-dealer-data'].includes(type),
    bins: ['bin-data', 'full-dealer-data'].includes(type),
    transfers: ['transfer-history', 'full-dealer-data'].includes(type),
    dealer: type === 'full-dealer-data'
  };
}

async function countForCriteria(body = {}) {
  const type = String(body.deleteType || body.dataType || 'selected-parts').toLowerCase();
  const byIds = Array.isArray(body.ids) && body.ids.length;
  const scanIdQuery = byIds ? idFilter(body.ids) : null;
  const counts = { scanCount: 0, masterCount: 0, binCount: 0, transferCount: 0, dealerCount: 0 };
  if (byIds && scanIdQuery) {
    counts.scanCount = await Inventory.countDocuments({ dealerCode: dealerCode(body.dealerCode), ...scanIdQuery });
    counts.totalCount = counts.scanCount;
    return counts;
  }
  if (['single-part', 'multiple-parts', 'selected-parts', 'all-scan-data', 'unknown-not-master'].includes(type)) {
    counts.scanCount = await Inventory.countDocuments(scanFilter(body));
  } else if (type === 'bin-data') {
    counts.binCount = await Bin.countDocuments(binFilter(body));
  } else if (type === 'master-parts') {
    counts.masterCount = await MasterPart.countDocuments(masterFilter(body));
  } else if (type === 'full-dealer-data') {
    counts.scanCount = await Inventory.countDocuments({ dealerCode: dealerCode(body.dealerCode) });
    counts.masterCount = await MasterPart.countDocuments(masterFilter(body));
    counts.binCount = await Bin.countDocuments(binFilter(body));
    counts.transferCount = await BinTransferHistory.countDocuments(transferFilter(body));
    counts.dealerCount = await Dealer.countDocuments({ dealerCode: dealerCode(body.dealerCode) });
  }
  counts.totalCount = counts.scanCount + counts.masterCount + counts.binCount + counts.transferCount + counts.dealerCount;
  return counts;
}

function publicRow(scan = {}) {
  const sourceText = String(scan.source || '').toLowerCase();
  const source = sourceText === 'mobile' || sourceText === 'camera' ? 'Mobile' : sourceText === 'manual' ? 'Manual' : 'Web';
  return {
    id: String(scan.scanId || scan.uniqueScanId || scan._id || ''),
    partNumber: scan.normalizedPartNumber || scan.partNumber || scan.part || '',
    partDescription: scan.partDescription || scan.partName || '',
    productCategory: scan.productCategory || scan.category || '',
    binLocation: scan.binLocation || scan.bin || '',
    quantity: scan.qty ?? scan.quantity ?? 0,
    scanType: scan.scanType || scan.type || '',
    dealerCode: scan.dealerCode || '',
    dateTime: scan.timestamp || scan.createdAt || '',
    source,
    status: scan.syncStatus || (scan.isDuplicate ? 'duplicate' : scan.synced || scan.isSynced ? 'synced' : 'pending')
  };
}

router.get('/dealers', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const dealers = await Dealer.find({}).sort({ dealerCode: 1 }).select('dealerCode dealerName').lean();
    res.json({ success: true, dealers });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/parts', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const code = dealerCode(req.query.dealerCode);
    if (!code) return res.status(400).json({ success: false, message: 'Dealer Code required' });
    const scans = await Inventory.find(scanFilter(req.query)).sort({ timestamp: -1, createdAt: -1 }).limit(2000).lean();
    res.json({ success: true, rows: scans.map(publicRow), count: scans.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/preview', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    if (!dealerCode(req.body.dealerCode)) return res.status(400).json({ success: false, message: 'Dealer Code required' });
    const counts = await countForCriteria(req.body);
    res.json({ success: true, ...counts, count: counts.totalCount });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/delete-selected', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const code = dealerCode(req.body.dealerCode);
    const filter = idFilter(req.body.ids || []);
    if (!code) return res.status(400).json({ success: false, message: 'Dealer Code required' });
    if (!filter) return res.status(400).json({ success: false, message: 'Select rows to delete' });
    const result = await Inventory.deleteMany({ dealerCode: code, ...filter });
    const duplicateResult = await DuplicateScanLog.deleteMany({ dealerCode: code, ...filter });
    req.io.emit('scan:deleted');
    req.io.emit('stats:update');
    res.json({ success: true, deletedCount: result.deletedCount || 0, duplicateLogsDeleted: duplicateResult.deletedCount || 0 });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/delete-all-dealer', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const code = dealerCode(req.body.dealerCode);
    if (!code) return res.status(400).json({ success: false, message: 'Dealer Code required' });
    const type = String(req.body.deleteType || '').toLowerCase();
    const result = { scansDeleted: 0, duplicateLogsDeleted: 0, masterDeleted: 0, binsDeleted: 0, transferDeleted: 0, dealersDeleted: 0, verificationDeleted: 0 };
    if (['single-part', 'multiple-parts', 'selected-parts', 'all-scan-data', 'unknown-not-master'].includes(type)) {
      result.scansDeleted = (await Inventory.deleteMany(scanFilter(req.body))).deletedCount || 0;
      result.duplicateLogsDeleted = (await DuplicateScanLog.deleteMany(duplicateLogFilter(req.body))).deletedCount || 0;
    } else if (type === 'bin-data') {
      result.binsDeleted = (await Bin.deleteMany(binFilter(req.body))).deletedCount || 0;
    } else if (type === 'master-parts') {
      result.masterDeleted = (await MasterPart.deleteMany(masterFilter(req.body))).deletedCount || 0;
    } else if (type === 'full-dealer-data') {
      result.scansDeleted = (await Inventory.deleteMany({ dealerCode: code })).deletedCount || 0;
      result.duplicateLogsDeleted = (await DuplicateScanLog.deleteMany({ dealerCode: code })).deletedCount || 0;
      result.masterDeleted = (await MasterPart.deleteMany({ dealerCode: code })).deletedCount || 0;
      result.binsDeleted = (await Bin.deleteMany({ dealerCode: code })).deletedCount || 0;
      result.transferDeleted = (await BinTransferHistory.deleteMany({ dealerCode: code })).deletedCount || 0;
      result.verificationDeleted = (await VerificationLog.deleteMany({ dealerCode: code })).deletedCount || 0;
      result.dealersDeleted = (await Dealer.deleteMany({ dealerCode: code })).deletedCount || 0;
    }
    req.io.emit('scan:deleted');
    req.io.emit('stats:update');
    res.json({ success: true, ...result, totalDeleted: Object.values(result).reduce((sum, value) => sum + Number(value || 0), 0) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/check-location-count', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const code = dealerCode(req.body.dealerCode);
    if (!code) return res.status(400).json({ success: false, message: 'Dealer Code required' });
    const scope = locationScope(req.body.dataType);
    const counts = {
      scanCount: scope.scans ? await Inventory.countDocuments({ dealerCode: code }) : 0,
      masterCount: scope.master ? await MasterPart.countDocuments({ dealerCode: code }) : 0,
      binCount: scope.bins ? await Bin.countDocuments({ dealerCode: code }) : 0,
      transferCount: scope.transfers ? await BinTransferHistory.countDocuments({ dealerCode: code }) : 0,
      dealerCount: scope.dealer ? await Dealer.countDocuments({ dealerCode: code }) : 0
    };
    counts.totalCount = counts.scanCount + counts.masterCount + counts.binCount + counts.transferCount + counts.dealerCount;
    res.json({ success: true, ...counts, count: counts.totalCount });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/delete-location-data', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const code = dealerCode(req.body.dealerCode);
    if (!code) return res.status(400).json({ success: false, message: 'Dealer Code required' });
    const scope = locationScope(req.body.dataType);
    const result = {
      scansDeleted: scope.scans ? (await Inventory.deleteMany({ dealerCode: code })).deletedCount || 0 : 0,
      duplicateLogsDeleted: scope.scans ? (await DuplicateScanLog.deleteMany({ dealerCode: code })).deletedCount || 0 : 0,
      masterDeleted: scope.master ? (await MasterPart.deleteMany({ dealerCode: code })).deletedCount || 0 : 0,
      binsDeleted: scope.bins ? (await Bin.deleteMany({ dealerCode: code })).deletedCount || 0 : 0,
      transferDeleted: scope.transfers ? (await BinTransferHistory.deleteMany({ dealerCode: code })).deletedCount || 0 : 0,
      dealersDeleted: scope.dealer ? (await Dealer.deleteMany({ dealerCode: code })).deletedCount || 0 : 0
    };
    result.totalDeleted = Object.values(result).reduce((sum, value) => sum + Number(value || 0), 0);
    req.io.emit('scan:deleted');
    req.io.emit('stats:update');
    res.json({ success: true, ...result, deletedCount: result.totalDeleted });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
