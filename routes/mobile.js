const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Device = require('../models/Device');
const Dealer = require('../models/Dealer');
const Inventory = require('../models/Inventory');
const MasterPart = require('../models/MasterPart');
const MasterCatalogue = require('../models/MasterCatalogue');
const SyncLog = require('../models/SyncLog');
const User = require('../models/User');
const VerificationLog = require('../models/VerificationLog');
const DeletedScanLog = require('../models/DeletedScanLog');
const DuplicateScanLog = require('../models/DuplicateScanLog');
const ExcelJS = require('exceljs');
const auth = require('./auth');
const devices = require('./devices');
const sync = require('./sync');
const inventoryRoute = require('./inventory');
const { getActiveAudit, publicAudit } = require('../utils/audit');
const { serverInfo } = require('../utils/network');
const { normalizePartNumber } = require('../utils/normalize');
const { formatDateLikeFields } = require('../utils/time');
const { decorateScanValue } = require('../utils/inventoryValueEngine');
const { uniqueReportScans, reportScanIdentity } = require('../utils/reportScanIdentity');
const { applyMovementCountRules, reportTotals, signedScanQuantity } = require('../utils/reportTotals');
const { getPriceFromPartMaster, getPricesFromPartMaster, scanWithPartMasterPrice } = require('../utils/partMasterPrice');
const { applyCacheHeaders, getCachedResponse } = require('../utils/safeCache');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'daksh_inventory_secret';
const MOBILE_APP_VERSION = 'Daksh Mobile Scanner v1.2.2';
const WEB_SCANNER_BUILD = '20260629-smart-bin-popup-v1';
const INVALID_PART_MESSAGE = 'Invalid part number - not found in master catalogue';
const MOBILE_SCAN_SELECT = [
  'uniqueScanId scanId syncKey qrFingerprint rawUpiHash',
  'part partNumber normalizedPartNumber partName partDescription category productCategory productGroup partSubGroup model year manufacturingYear',
  'qty quantity mrp scanMRP manualMRP valuationMRP valuationSource finalInventoryValue finalMRP currentCatalogueMRP currentCatalogueDLC dlc',
  'bin binLocation autoDetectedBin binSelectionMode stockDeductedFromBin regdNo jobCardNo isFitted fittedQty fittedLocation status type scanType movementType activeInventory remainingQty',
  'upiId upiNo upiCode dealerCode dealerName auditId rawScan rawScanString rawBarcode rawQR rawUpi',
  'deviceId deviceName userId loginId staffName userName role timestamp scanTime createdAt',
  'syncStatus synced isSynced scanStatus source scanMode warnings remarks masterFound masterMatch isMasterMatched'
].join(' ');

function clean(value) {
  return String(value || '').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function cleanUsername(value) {
  return clean(value).toLowerCase();
}

function isBcryptHash(value) {
  return /^\$2[aby]\$\d{2}\$/.test(String(value || ''));
}

async function sendCachedJson(res, namespace, query, builder, options = {}) {
  const result = await getCachedResponse(namespace, query, builder, options);
  applyCacheHeaders(res, result);
  return res.json(result.data);
}

function userIsActive(user) {
  return Boolean(user) && user.active !== false && user.isActive !== false;
}

function userIsApproved(user) {
  return Boolean(user) && user.approved !== false;
}

async function findUserByLogin(value) {
  const login = cleanUsername(value);
  if (!login) return null;
  const byUsername = await User.findOne({ username: login });
  if (byUsername) return byUsername;
  const matches = await User.find({ email: login }).limit(2);
  if (matches.length > 1) {
    const error = new Error('This email ID is linked to multiple users. Please use the username.');
    error.status = 400;
    throw error;
  }
  if (matches[0]) return matches[0];

  const fallbackFields = ['loginId', 'userId'];
  for (const field of fallbackFields) {
    const match = await User.findOne({ [field]: login });
    if (match) return match;
  }

  return null;
}

async function compareSecret(user, input, fields) {
  const value = String(input || '');
  if (!value) return false;
  for (const field of fields) {
    const stored = user[field];
    if (!stored) continue;
    const matched = isBcryptHash(stored) ? await bcrypt.compare(value, stored) : stored === value;
    if (!matched) continue;
    if (!isBcryptHash(stored) || fields.some((name) => !user[name] || user[name] !== stored)) {
      const hash = await bcrypt.hash(value, 10);
      fields.forEach((name) => {
        user[name] = hash;
      });
      await user.save();
    }
    return true;
  }
  return false;
}

function signMobileToken(user) {
  return jwt.sign(auth.publicUser(user), JWT_SECRET, { expiresIn: '12h' });
}

async function dealerAccessForUser(user, dealerCode) {
  const requestedDealer = auth.normalizeAccessCode(dealerCode);
  return auth.validateUserDealerAccess(user, requestedDealer);
}

function compactDealer(row) {
  return {
    id: row._id,
    dealerCode: row.dealerCode || '',
    code: row.dealerCode || '',
    dealerName: row.dealerName || '',
    name: row.dealerName || '',
    location: row.location || '',
    brand: row.brand || '',
    currentAuditId: row.currentAuditId || ''
  };
}

async function mobileDeviceStatus(deviceId) {
  await devices.markExpiredDevicesOffline();
  const device = deviceId ? await Device.findOne({ deviceId }).lean() : null;
  return {
    approved: Boolean(device && device.approved !== false),
    connected: Boolean(device && device.status === 'online'),
    status: device && device.status === 'online' ? 'connected' : 'offline',
    syncStatus: device ? device.syncStatus || 'idle' : 'idle',
    pendingCount: Number(device?.pendingCount || 0),
    failedCount: Number(device?.failedCount || 0),
    lastSeen: device?.lastSeen || '',
    lastSyncTime: device?.lastSyncTime || '',
    device: device || null
  };
}

function dealerFilter(query = {}) {
  const dealerCode = clean(query.dealerCode).toUpperCase();
  const filter = dealerCode ? { dealerCode } : {};
  const deviceId = clean(query.deviceId);
  const userId = clean(query.userId || query.loginId || query.username);
  if (deviceId || userId) {
    filter.$and = (filter.$and || []).concat([{
      $or: [
        deviceId ? { deviceId } : null,
        userId ? { userId } : null,
        userId ? { loginId: userId } : null,
        userId ? { staffName: userId } : null
      ].filter(Boolean)
    }]);
  }
  return filter;
}

function transactionFilter(query = {}) {
  return inventoryRoute.applyTransactionScanFilter(dealerFilter(query));
}

function recentScanFilter(query = {}) {
  const filter = transactionFilter(query);
  filter.activeInventory = { $ne: false };
  filter.deletedAt = null;
  filter.scanStatus = { $in: ['ACCEPTED', 'SUPERVISOR_APPROVED'] };
  filter.$and = (filter.$and || []).concat([
    { $or: [{ movementType: 'INWARD' }, { scanType: 'INWARD' }, { type: 'INWARD' }] }
  ]);
  return filter;
}

function latestUniqueScans(scans = []) {
  const seen = new Set();
  const rows = [];
  scans.forEach((scan) => {
    const key = reportScanIdentity(scan);
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    rows.push(scan);
  });
  return rows;
}

function scanQty(scan = {}) {
  if (scan._reportSignedQty !== undefined) return signedScanQuantity(scan, 0);
  const qty = Number(scan.qty !== undefined ? scan.qty : scan.quantity || 0);
  const safeQty = Number.isFinite(qty) ? qty : 0;
  const type = upper(scan.scanType || scan.type || '');
  if (type === 'INWARD') return Math.abs(safeQty);
  if (['OUTWARD', 'FITTED', 'DAMAGE'].includes(type)) return -Math.abs(safeQty);
  if (type === 'VERIFICATION') return 0;
  return 0;
}

function newestFirst(a = {}, b = {}) {
  return new Date(b.timestamp || b.createdAt || 0) - new Date(a.timestamp || a.createdAt || 0);
}

async function withCurrentMasterPrices(scans = [], dealerCode = '') {
  const priceByPart = await getPricesFromPartMaster(
    scans.map((scan) => scan.normalizedPartNumber || scan.partNumber || scan.part),
    dealerCode
  );
  return scans.map((scan) => {
    const partNumber = normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part);
    return scanWithPartMasterPrice(scan, priceByPart.get(partNumber) || null);
  });
}

async function buildRecentScans(query = {}) {
  const limit = Math.min(Math.max(Number(query.limit || 10), 1), 100);
  const fetchLimit = Math.min(Math.max(limit * 5, 50), 250);
  const records = await Inventory.find(recentScanFilter(query))
    .select(MOBILE_SCAN_SELECT)
    .sort({ timestamp: -1, createdAt: -1, _id: -1 })
    .limit(fetchLimit)
    .lean();
  const unique = latestUniqueScans(records).slice(0, limit);
  const priced = await withCurrentMasterPrices(unique, query.dealerCode);
  return priced.map(mobileItem);
}

function reportRow(scan) {
  const valued = decorateScanValue(scan);
  return {
    time: scan.timestamp || scan.createdAt || '',
    dealerCode: scan.dealerCode || '',
    partNumber: scan.partNumber || scan.part || '',
    qty: Number(scan.qty || scan.quantity || 0),
    mrp: Number(valued.valuationMRP || 0),
    valuationSource: valued.valuationSource || '',
    finalInventoryValue: Number(valued.finalInventoryValue || 0),
    binLocation: scan.binLocation || scan.bin || '',
    scanType: scan.scanType || scan.type || '',
    deviceId: scan.deviceId || '',
    userId: scan.userId || scan.loginId || '',
    userName: scan.userName || scan.staffName || scan.loginId || '',
    role: scan.role || '',
    source: scan.source || '',
    syncStatus: scan.syncStatus || (scan.synced || scan.isSynced ? 'synced' : 'pending'),
    rawScan: scan.rawScan || scan.rawScanString || scan.rawUpi || ''
  };
}

function partFromVerificationValue(value) {
  const raw = clean(value).toUpperCase();
  const slashParts = raw.split('/');
  if (slashParts.length >= 4 && slashParts[3].trim()) {
    return normalizePartNumber(slashParts[3]);
  }
  const match = /(?:PART\s*NO|PART|PN|SKU)[:=#-]?\s*([A-Z0-9._/-]+)/i.exec(raw);
  return normalizePartNumber(match ? match[1] : raw);
}

async function scanReport(req, res, scanType) {
  try {
    const records = await Inventory.find(transactionFilter(req.query)).select(MOBILE_SCAN_SELECT).sort({ timestamp: 1, createdAt: 1 }).limit(5000).lean();
    const normalized = applyMovementCountRules(uniqueReportScans(records));
    const priced = await withCurrentMasterPrices(normalized, req.query.dealerCode);
    const rows = priced.filter((scan) => upper(scan.scanType || scan.type || '') === scanType).sort(newestFirst).slice(0, 1000).map(reportRow);
    return res.json({ success: true, type: scanType.toLowerCase(), count: rows.length, rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

function mobileItem(scan) {
  const timestamp = scan.timestamp || scan.scanTime || scan.createdAt || Date.now();
  const valued = decorateScanValue(scan);
  return {
    id: scan.rawScan || scan.rawScanString || scan.uniqueScanId || String(scan._id),
    type: scan.type || scan.scanType || 'INWARD',
    upiSequence: scan.upiId || '',
    partNumber: scan.partNumber || scan.part || '',
    partName: scan.partName || '',
    partDescription: scan.partDescription || scan.partName || '',
    description: scan.partDescription || scan.partName || '',
    category: scan.productCategory || '',
    productCategory: scan.productCategory || '',
    binLocation: scan.binLocation || scan.bin || '',
    bin: scan.binLocation || scan.bin || '',
    quantity: Number(scan.quantity || scan.qty || 1),
    qty: Number(scan.quantity || scan.qty || 1),
    mrp: Number(valued.valuationMRP || 0),
    valuationSource: valued.valuationSource || '',
    finalInventoryValue: Number(valued.finalInventoryValue || 0),
    damageReason: scan.damageReason || '',
    remarks: scan.remarks || '',
    vinNo: scan.vinNo || '',
    registrationNo: scan.registrationNo || '',
    jobNo: scan.jobNo || '',
    dealerCode: scan.dealerCode || '',
    userId: scan.userId || scan.loginId || '',
    userName: scan.userName || scan.staffName || scan.loginId || '',
    role: scan.role || '',
    upiCode: scan.upiCode || scan.upiNo || scan.upiId || '',
    scanType: scan.scanType || scan.type || 'INWARD',
    movementType: scan.movementType || scan.scanType || scan.type || 'INWARD',
    activeInventory: scan.activeInventory !== undefined ? Boolean(scan.activeInventory) : (scan.scanType || scan.type) === 'INWARD',
    remainingQty: Number(scan.remainingQty !== undefined ? scan.remainingQty : Number(scan.qty || scan.quantity || 0)),
    source: scan.source || '',
    rawUpi: scan.rawUpi || scan.rawScan || scan.rawScanString || '',
    rawScan: scan.rawScan || scan.rawScanString || scan.rawUpi || '',
    rawScanString: scan.rawScanString || scan.rawScan || '',
    timestamp,
    scanTime: scan.scanTime || scan.timestamp || timestamp,
    syncStatus: scan.syncStatus || (scan.synced || scan.isSynced ? 'synced' : 'pending'),
    isSynced: true,
    isDuplicate: false
  };
}

router.post('/connect', auth.optionalAuth, devices.connectHandler);
router.post('/heartbeat', auth.optionalAuth, devices.heartbeatHandler);

router.post('/login', auth.mobileLoginHandler);

router.get('/dealers', auth.requireAuth, async (req, res) => {
  try {
    const userAccess = auth.normalizeDealerAccess(req.user.dealerAccess);
    const canSeeAll = req.user.role === 'admin' || userAccess.includes('ALL');
    const filter = canSeeAll ? {} : userAccess.length ? { dealerCode: { $in: userAccess } } : { dealerCode: '__none__' };
    const dealersList = await Dealer.find(filter).sort({ dealerName: 1, dealerCode: 1 }).limit(1000).lean();
    return res.json({ success: true, count: dealersList.length, dealers: dealersList.map(compactDealer) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/version', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  return res.json({
    success: true,
    appVersion: req.app.locals.appVersion || WEB_SCANNER_BUILD,
    version: req.app.locals.appVersion || WEB_SCANNER_BUILD,
    webScannerBuild: req.app.locals.webScannerBuild || WEB_SCANNER_BUILD,
    mobileAppVersion: req.app.locals.mobileAppVersion || MOBILE_APP_VERSION
  });
});

router.get('/config', auth.optionalAuth, async (req, res) => {
  try {
    const info = serverInfo(req.app.locals.activePort, req.ip || req.socket.remoteAddress, req.protocol, req.get('x-forwarded-host') || req.get('host') || '');
    const activeAudit = await getActiveAudit({ dealerCode: req.query.dealerCode }).catch(() => null);
    const loginDealerDocs = await Dealer.find({
      dealerCode: { $not: /^SYNC/i },
      active: { $ne: false }
    }).sort({ dealerName: 1, dealerCode: 1 }).limit(500).lean();
    const loginDealers = [];
    const seenDealerCodes = new Set();
    const addDealer = (dealer = {}) => {
      const compact = compactDealer(dealer);
      if (!compact.dealerCode || seenDealerCodes.has(compact.dealerCode)) return;
      seenDealerCodes.add(compact.dealerCode);
      loginDealers.push(compact);
    };
    if (activeAudit && activeAudit.dealerCode) {
      addDealer({
        dealerCode: activeAudit.dealerCode,
        dealerName: activeAudit.dealerName,
        location: activeAudit.location,
        brand: activeAudit.brand,
        currentAuditId: activeAudit.auditId
      });
    }
    loginDealerDocs.forEach(addDealer);
    return res.json({
      success: true,
      appName: 'Daksh Inventory',
      appVersion: req.app.locals.appVersion || WEB_SCANNER_BUILD,
      version: req.app.locals.appVersion || WEB_SCANNER_BUILD,
      mobileAppVersion: MOBILE_APP_VERSION,
      webScannerBuild: req.app.locals.webScannerBuild || WEB_SCANNER_BUILD,
      serverTime: new Date(),
      serverUrl: info.serverUrl,
      scanUrl: info.scanUrl,
      mobileScannerUrl: info.mobileScannerUrl,
      healthUrl: info.healthUrl,
      connectUrl: info.connectUrl,
      syncUrl: `${info.serverUrl}/api/mobile/sync-bulk`,
      loginUrl: `${info.serverUrl}/api/auth/mobile-login`,
      recommendedDealerCode: activeAudit ? activeAudit.dealerCode : '',
      loginDealers,
      cooldownMs: 4000,
      supportedScanTypes: ['INWARD', 'OUTWARD', 'FITTED', 'DAMAGE', 'VERIFICATION'],
      activeAudit: activeAudit ? publicAudit(activeAudit) : null,
      loginVerified: Boolean(req.user)
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/device-register', auth.requireAuth, async (req, res) => {
  try {
    const deviceId = clean(req.body.deviceId);
    const dealerCode = auth.normalizeAccessCode(req.body.dealerCode);
    if (!deviceId) return res.status(400).json({ success: false, message: 'Device ID is required' });
    if (!dealerCode) return res.status(400).json({ success: false, message: 'Dealer code is required' });
    const access = await dealerAccessForUser(req.user, dealerCode);
    if (!access.allowed) return res.status(403).json({ success: false, message: 'Dealer access not assigned' });

    const [dealer, activeAudit] = await Promise.all([
      Dealer.findOne({ dealerCode: access.requestedDealer }).lean(),
      getActiveAudit({ dealerCode: access.requestedDealer }).catch(() => null)
    ]);
    const now = new Date();
    const device = await Device.findOneAndUpdate(
      { deviceId },
      {
        deviceId,
        deviceName: clean(req.body.deviceName || 'Daksh Android Scanner'),
        model: clean(req.body.model || 'Android'),
        deviceType: 'mobile',
        connectionMethod: 'mobile_camera',
        approved: true,
        dealerCode: access.requestedDealer,
        dealerName: dealer?.dealerName || req.body.dealerName || '',
        auditId: activeAudit ? activeAudit.auditId : '',
        userId: clean(req.body.userId || req.user.id),
        loginId: clean(req.body.loginId || req.user.username),
        userName: clean(req.body.userName || req.user.name || req.user.username),
        staffName: clean(req.body.staffName || req.body.userName || req.user.name || req.user.username),
        role: clean(req.body.role || req.user.role).toLowerCase(),
        serverUrl: clean(req.body.serverUrl || serverInfo(req.app.locals.activePort, req.ip || req.socket.remoteAddress, req.protocol, req.get('x-forwarded-host') || req.get('host') || '').serverUrl),
        status: 'online',
        syncStatus: Number(req.body.failedCount || 0) > 0 ? 'failed' : 'idle',
        scannerStatus: 'ready',
        healthStatus: 'healthy',
        appVersion: clean(req.body.appVersion || MOBILE_APP_VERSION),
        batteryPercent: req.body.batteryPercent ?? req.body.battery,
        pendingCount: Number(req.body.pendingCount || 0),
        failedCount: Number(req.body.failedCount || 0),
        lastSeen: now,
        connectedAt: now,
        disconnectedAt: undefined,
        disconnectedBy: ''
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    req.app.get('io')?.emit('devices:update', { deviceId, at: now });
    return res.json({ success: true, message: 'Device registered', device });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

async function processMobileScan(req, res) {
  try {
    const { processScan } = require('../services/ScanProcessingService');
    const result = await processScan(req.body || {}, { req });
    return res.status(result.httpStatus || (result.success ? 201 : 422)).json(result);
  } catch (error) {
    return res.status(500).json({ success: false, status: 'failed', message: error.message });
  }
}

router.post('/process', auth.requireAuth, processMobileScan);
router.post('/process-scan', auth.requireAuth, processMobileScan);
router.post('/sync', auth.requireAuth, sync.pushHandler);
router.post('/scan', auth.requireAuth, processMobileScan);
router.post('/sync-batch', auth.requireAuth, sync.pushHandler);
router.post('/sync-bulk', auth.requireAuth, sync.pushHandler);
router.post('/realtime-scan', auth.requireAuth, processMobileScan);

router.get('/status', auth.optionalAuth, async (req, res) => {
  try {
    const info = serverInfo(req.app.locals.activePort, req.ip || req.socket.remoteAddress, req.protocol, req.get('x-forwarded-host') || req.get('host') || '');
    const activeAudit = await getActiveAudit({ dealerCode: req.query.dealerCode }).catch(() => null);
    const status = await mobileDeviceStatus(clean(req.query.deviceId));
    return res.json({
      success: true,
      serverStatus: 'online',
      status: status.status,
      connected: status.connected,
      approved: status.approved,
      loginVerified: Boolean(req.user),
      serverUrl: info.serverUrl,
      scanUrl: info.scanUrl,
      mobileScannerUrl: info.mobileScannerUrl,
      healthUrl: info.healthUrl,
      syncUrl: `${info.serverUrl}/api/mobile/sync-bulk`,
      activeAudit: activeAudit ? publicAudit(activeAudit) : null,
      ...status
    });
  } catch (error) {
    return res.status(500).json({ success: false, serverStatus: 'offline', status: 'offline', message: error.message });
  }
});

router.get('/sync-status', auth.requireAuth, async (req, res) => {
  try {
    const deviceId = clean(req.query.deviceId);
    const filter = deviceId ? { deviceId } : {};
    const [device, lastLog, totalSynced, failedRecords] = await Promise.all([
      deviceId ? Device.findOne({ deviceId }).lean() : null,
      SyncLog.findOne(filter).sort({ createdAt: -1 }).lean(),
      Inventory.countDocuments({ ...filter, $or: [{ syncStatus: 'synced' }, { synced: true }, { isSynced: true }] }),
      Inventory.countDocuments({ ...filter, syncStatus: 'failed' })
    ]);
    return res.json({
      success: true,
      deviceId,
      status: device?.status || 'offline',
      syncStatus: device?.syncStatus || 'idle',
      pendingCount: Number(device?.pendingCount || 0),
      failedCount: Number(device?.failedCount || failedRecords || 0),
      totalSynced,
      lastSyncTime: device?.lastSyncTime || lastLog?.createdAt || '',
      lastApiResponse: lastLog || null
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/master-search', auth.requireAuth, async (req, res) => {
  try {
    return await sendCachedJson(res, 'search', req.query, async (normalizedQuery) => {
      const q = upper(normalizedQuery.q || normalizedQuery.partNumber || normalizedQuery.part || '');
      const dealerCode = upper(normalizedQuery.dealerCode || '');
      const limit = Math.min(Math.max(Number(normalizedQuery.limit || 10), 1), 25);
      if (!q || q.length < 2) return { success: true, count: 0, parts: [], suggestions: [] };
      const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const [dealerParts, catalogueParts] = await Promise.all([
        MasterPart.find({
          $or: [
            { normalizedPartNumber: regex },
            { partNumber: regex },
            { partNo: regex },
            { partDescription: regex },
            { partName: regex }
          ]
        }).sort({ dealerCode: -1, partNumber: 1 }).limit(limit).lean(),
        MasterCatalogue.find({
          $or: [
            { normalizedPartNumber: regex },
            { partNumber: regex },
            { partNo: regex },
            { partDescription: regex },
            { partName: regex }
          ]
        }).sort({ partNumber: 1 }).limit(limit).lean()
      ]);
      const candidates = Array.from(new Set(dealerParts.concat(catalogueParts)
        .map((part) => normalizePartNumber(part.normalizedPartNumber || part.partNumber || part.partNo || part.part))
        .filter(Boolean)));
      const priceByPart = await getPricesFromPartMaster(candidates, dealerCode);
      const parts = candidates.map((partNumber) => priceByPart.get(partNumber)).filter(Boolean)
        .sort((a, b) => Number(b.partNumber === q) - Number(a.partNumber === q) || a.partNumber.localeCompare(b.partNumber))
        .slice(0, limit)
        .map((price) => ({
          id: price.sourceRecord && price.sourceRecord._id,
          partNumber: price.partNumber,
          partNo: price.partNumber,
          partDescription: price.description,
          partName: price.description,
          productCategory: price.category,
          category: price.category,
          mrp: price.mrp,
          dlc: price.dlc,
          model: price.model,
          year: price.year,
          manufacturingYear: price.manufacturingYear,
          productGroup: price.productGroup,
          partSubGroup: price.partSubGroup,
          binLocation: price.binLocation,
          bin: price.bin
        }));
      return { success: true, count: parts.length, parts, suggestions: parts };
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/validate-part', auth.optionalAuth, async (req, res) => {
  try {
    return await sendCachedJson(res, 'lookup', req.query, async (normalizedQuery) => {
      const partNumber = normalizePartNumber(normalizedQuery.partNumber || normalizedQuery.part || '');
      const dealerCode = clean(normalizedQuery.dealerCode || '').toUpperCase();
      if (!partNumber) return { success: false, found: false, message: 'Part number is required' };
      const price = await getPriceFromPartMaster(partNumber, dealerCode).catch(() => null);
      const master = price && (price.masterRecord || price.sourceRecord) ? price : null;
      return {
        success: true,
        found: Boolean(master),
        partNumber,
        dealerCode,
        partDescription: master ? master.description || master.partDescription || master.partName || '' : '',
        productCategory: master ? master.category || master.productCategory || '' : '',
        mrp: master ? Number(master.mrp || 0) : 0,
        dlc: master ? Number(master.dlc || 0) : 0,
        category: master ? master.category || master.productCategory || '' : '',
        model: master ? master.model || '' : '',
        productGroup: master ? master.productGroup || '' : '',
        partSubGroup: master ? master.partSubGroup || '' : ''
      };
    });
  } catch (error) {
    return res.status(500).json({ success: false, found: false, message: error.message });
  }
});

router.post('/verification-log', auth.optionalAuth, async (req, res) => {
  try {
    const partNumber = clean(req.body.partNumber || req.body.part || '').toUpperCase();
    const dealerCode = clean(req.body.dealerCode || '').toUpperCase();
    if (!partNumber) return res.status(400).json({ success: false, message: 'Part number is required' });
    const result = await inventoryRoute.verifyPartOnly({
      rawScan: clean(req.body.rawScan || req.body.rawScannedValue || partNumber),
      partNumber,
      dealerCode,
      auditId: clean(req.body.auditId || '')
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/status/:deviceId', auth.optionalAuth, async (req, res) => {
  try {
    await devices.markExpiredDevicesOffline();
    const deviceId = clean(req.params.deviceId);
    if (!deviceId) {
      return res.status(400).json({ success: false, approved: false, status: 'offline', message: 'Device ID is required' });
    }

    const device = await Device.findOneAndUpdate(
      { deviceId, deviceType: 'mobile', status: 'online' },
      { lastSeen: new Date(), status: 'online', approved: true },
      { new: true }
    ).lean();

    if (!device) {
      return res.json({
        success: true,
        approved: false,
        connected: false,
        status: 'offline',
        message: 'Device not connected'
      });
    }

    return res.json({
      success: true,
      approved: true,
      connected: true,
      status: 'connected',
      token: deviceId,
      message: 'Connected successfully',
      device
    });
  } catch (error) {
    return res.status(500).json({ success: false, approved: false, status: 'offline', message: error.message });
  }
});

router.get('/inventory', auth.optionalAuth, async (req, res) => {
  try {
    const records = await Inventory.find(transactionFilter(req.query)).select(MOBILE_SCAN_SELECT)
      .sort({ timestamp: -1 })
      .limit(1000)
      .lean();
    return res.json((await withCurrentMasterPrices(records, req.query.dealerCode)).map(mobileItem));
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/reports/unique-upi', auth.optionalAuth, async (req, res) => {
  try {
    const records = await Inventory.find(transactionFilter(req.query)).select(MOBILE_SCAN_SELECT)
      .sort({ timestamp: -1 })
      .limit(1000)
      .lean();
    const priced = await withCurrentMasterPrices(applyMovementCountRules(uniqueReportScans(records)), req.query.dealerCode);
    return res.json(priced.sort(newestFirst).map(mobileItem));
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/reports/summary', auth.optionalAuth, async (req, res) => {
  try {
    const filter = transactionFilter(req.query);
    const [rawRecords, duplicateCount] = await Promise.all([
      Inventory.find(filter).select(MOBILE_SCAN_SELECT).sort({ timestamp: -1, createdAt: -1 }).lean(),
      DuplicateScanLog.countDocuments(filter)
    ]);
    const records = applyMovementCountRules(uniqueReportScans(rawRecords));
    const lastScan = records.slice().sort((a, b) => new Date(b.timestamp || b.createdAt || 0) - new Date(a.timestamp || a.createdAt || 0))[0] || null;
    const totals = reportTotals(records);
    const row = records.reduce((summary, scan) => {
      const type = upper(scan.scanType || scan.type || '');
      const syncStatus = clean(scan.syncStatus).toLowerCase();
      summary.total += 1;
      summary.totalQty += Math.abs(scanQty(scan));
      if (type === 'INWARD') summary.inward += 1;
      if (type === 'OUTWARD') summary.outward += 1;
      if (type === 'FITTED') summary.fitted += 1;
      if (type === 'DAMAGE') summary.damage += 1;
      if (syncStatus === 'pending') summary.pending += 1;
      if (syncStatus === 'failed') summary.failed += 1;
      if (syncStatus === 'synced' || scan.synced === true || scan.isSynced === true) summary.synced += 1;
      return summary;
    }, { total: 0, totalQty: 0, inward: 0, outward: 0, fitted: 0, damage: 0, pending: 0, failed: 0, synced: 0 });
    return res.json({
      success: true,
      summary: {
        dealerCode: clean(req.query.dealerCode).toUpperCase(),
        dealerName: lastScan?.dealerName || '',
        total: Number(totals.scanRows || row.total || 0),
        scanRows: Number(totals.scanRows || row.total || 0),
        uniqueParts: Number(totals.uniqueParts || 0),
        totalQty: Number(totals.totalQuantity || row.totalQty || 0),
        totalQuantity: Number(totals.totalQuantity || row.totalQty || 0),
        partsScanned: Number(totals.partsScanned || row.totalQty || 0),
        inward: Number(totals.inwardCount ?? row.inward ?? 0),
        inwardCount: Number(totals.inwardCount ?? row.inward ?? 0),
        outward: Number(totals.outwardCount ?? row.outward ?? 0),
        outwardCount: Number(totals.outwardCount ?? row.outward ?? 0),
        netAvailableCount: Number(totals.netAvailableCount || 0),
        unknownPartsCount: Number(totals.unknownPartsCount || 0),
        fitted: Number(row.fitted || 0),
        damage: Number(row.damage || 0),
        pending: Number(row.pending || 0),
        failed: Number(row.failed || 0),
        synced: Number(row.synced || 0),
        duplicates: Number(duplicateCount || 0),
        duplicateCount: Number(duplicateCount || 0),
        lastScanAt: lastScan ? lastScan.timestamp || lastScan.createdAt || '' : ''
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/recent-scans', auth.optionalAuth, async (req, res) => {
  try {
    const records = await buildRecentScans(req.query);
    return res.json({ success: true, count: records.length, records });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/reports/last-scans', auth.optionalAuth, async (req, res) => {
  try {
    const records = await buildRecentScans(req.query);
    return res.json({ success: true, count: records.length, records });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/reports/verify-scan', auth.optionalAuth, async (req, res) => {
  try {
    const value = clean(req.query.value);
    const partNumber = partFromVerificationValue(value);
    if (!value) {
      return res.status(400).json({ success: false, scanned: false, message: 'QR code or part number is required' });
    }
    const result = await inventoryRoute.verifyPartOnly({
      rawScan: value,
      partNumber,
      dealerCode: req.query.dealerCode || '',
      auditId: req.query.auditId || ''
    });
    return res.json({ ...result, query: value });
  } catch (error) {
    return res.status(500).json({ success: false, scanned: false, message: error.message });
  }
});

router.get('/reports/inward', auth.optionalAuth, (req, res) => scanReport(req, res, 'INWARD'));
router.get('/reports/outward', auth.optionalAuth, (req, res) => scanReport(req, res, 'OUTWARD'));
router.get('/reports/fitted', auth.optionalAuth, (req, res) => scanReport(req, res, 'FITTED'));
router.get('/reports/damage', auth.optionalAuth, (req, res) => scanReport(req, res, 'DAMAGE'));

router.get('/reports/verification', auth.optionalAuth, async (req, res) => {
  try {
    const rows = await VerificationLog.find({ ...dealerFilter(req.query), scanType: { $ne: 'VERIFICATION' } }).sort({ time: -1 }).limit(1000).lean();
    return res.json({ success: true, count: rows.length, rows: rows.map((row) => ({
      time: row.time,
      dealerCode: row.dealerCode || '',
      user: row.staffName || row.scannedBy || row.loginId || row.userId || '',
      scanType: row.scanType || '',
      rawScannedValue: row.rawScannedValue || '',
      extractedPartNumber: row.extractedPartNumber || row.partNumber || '',
      partNumber: row.partNumber || row.extractedPartNumber || '',
      binLocation: row.binLocation || '',
      reason: row.reason || (row.found ? 'Found In Master' : INVALID_PART_MESSAGE),
      found: row.found ? 'Found' : 'Not Found',
      deviceId: row.deviceId
    })) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/reports/deleted', auth.optionalAuth, async (req, res) => {
  try {
    const rows = await DeletedScanLog.find(dealerFilter(req.query)).sort({ deletedTime: -1 }).limit(1000).lean();
    return res.json({ success: true, count: rows.length, rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/reports/export-excel', auth.optionalAuth, async (req, res) => {
  try {
    const type = clean(req.query.type || 'inward').toLowerCase();
    const map = { inward: 'INWARD', outward: 'OUTWARD', fitted: 'FITTED', damage: 'DAMAGE' };
    let rows = [];
    if (map[type]) {
      const scans = applyMovementCountRules(uniqueReportScans(await Inventory.find(transactionFilter(req.query)).select(MOBILE_SCAN_SELECT).sort({ timestamp: 1, createdAt: 1 }).limit(5000).lean()));
      const priced = await withCurrentMasterPrices(scans, req.query.dealerCode);
      rows = priced.filter((scan) => upper(scan.scanType || scan.type || '') === map[type]).sort(newestFirst).map(reportRow);
    } else if (type === 'verification') {
      rows = (await VerificationLog.find({ ...dealerFilter(req.query), scanType: { $ne: 'VERIFICATION' } }).sort({ time: -1 }).limit(5000).lean()).map((row) => ({
        time: row.time,
        dealerCode: row.dealerCode || '',
        user: row.staffName || row.scannedBy || row.loginId || row.userId || '',
        scanType: row.scanType || '',
        rawScannedValue: row.rawScannedValue || '',
        extractedPartNumber: row.extractedPartNumber || row.partNumber || '',
        partNumber: row.partNumber || row.extractedPartNumber || '',
        binLocation: row.binLocation || '',
        reason: row.reason || (row.found ? 'Found In Master' : INVALID_PART_MESSAGE),
        found: row.found ? 'Found' : 'Not Found',
        deviceId: row.deviceId || ''
      }));
    } else if (type === 'deleted') {
      rows = await DeletedScanLog.find(dealerFilter(req.query)).sort({ deletedTime: -1 }).limit(5000).lean();
    }
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(`${type} report`.slice(0, 31));
    const keys = Object.keys(rows[0] || { time: '', dealerCode: '', partNumber: '', qty: '', mrp: '', binLocation: '', scanType: '', deviceId: '', syncStatus: '' });
    sheet.columns = keys.map((key) => ({ header: key, key, width: 18 }));
    rows.forEach((row) => sheet.addRow(formatDateLikeFields(row)));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Daksh_${type}_report.xlsx"`);
    await workbook.xlsx.write(res);
    return res.end();
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/reports/bin-wise', auth.optionalAuth, async (req, res) => {
  try {
    const scans = await withCurrentMasterPrices(
      applyMovementCountRules(uniqueReportScans(await Inventory.find(transactionFilter(req.query)).select(MOBILE_SCAN_SELECT).sort({ timestamp: 1, createdAt: 1 }).limit(5000).lean())),
      req.query.dealerCode
    );
    const groups = new Map();
    scans.forEach((scan) => {
      const key = [
        scan.dealerCode || '',
        scan.binLocation || scan.bin || '',
        scan.partNumber || scan.part || '',
        scan.currentCatalogueMRP || '',
        scan.scanType || scan.type || '',
        scan.deviceId || ''
      ].join('|');
      const group = groups.get(key) || {
        dealerCode: scan.dealerCode || '',
        binLocation: scan.binLocation || scan.bin || '',
        partNumber: scan.partNumber || scan.part || '',
        partDescription: scan.partDescription || scan.partName || '',
        productCategory: scan.productCategory || '',
        qty: 0,
        mrp: Number(scan.currentCatalogueMRP || 0),
        scanType: scan.scanType || scan.type || '',
        lastScanTime: scan.timestamp || scan.createdAt || '',
        deviceId: scan.deviceId || ''
      };
      group.qty += scanQty(scan);
      if (new Date(scan.timestamp || scan.createdAt || 0) > new Date(group.lastScanTime || 0)) group.lastScanTime = scan.timestamp || scan.createdAt || '';
      groups.set(key, group);
    });
    const records = Array.from(groups.values())
      .sort((a, b) => new Date(b.lastScanTime || 0) - new Date(a.lastScanTime || 0))
      .slice(0, 1000);
    return res.json({
      success: true,
      records: records.map((row) => ({
        dealerCode: row.dealerCode || '',
        binLocation: row.binLocation || '',
        partNumber: row.partNumber || '',
        partDescription: row.partDescription || '',
        productCategory: row.productCategory || '',
        qty: Number(row.qty || 0),
        mrp: Number(row.mrp || 0),
        scanType: row.scanType || '',
        lastScanTime: row.lastScanTime || '',
        deviceId: row.deviceId || ''
      }))
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
