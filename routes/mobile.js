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
const { getActiveAudit, publicAudit } = require('../utils/audit');
const { serverInfo } = require('../utils/network');
const { normalizePartNumber } = require('../utils/normalize');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'daksh_inventory_secret';
const MOBILE_APP_VERSION = 'Daksh Mobile Scanner v1.0.2';

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
  return matches[0] || null;
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

function dealerAccessForUser(user, dealerCode) {
  const requestedDealer = auth.normalizeAccessCode(dealerCode);
  const access = auth.dealerAccessIncludes(user.dealerAccess, requestedDealer);
  if (user.role === 'admin') {
    return { ...access, requestedDealer, allowed: true, userDealerAccess: ['ALL'] };
  }
  return { ...access, requestedDealer };
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

function reportFilter(query = {}, scanType = '') {
  const filter = dealerFilter(query);
  if (scanType) filter.$or = [{ scanType }, { type: scanType }];
  return filter;
}

function reportRow(scan) {
  return {
    time: scan.timestamp || scan.createdAt || '',
    dealerCode: scan.dealerCode || '',
    partNumber: scan.partNumber || scan.part || '',
    qty: Number(scan.qty || scan.quantity || 0),
    mrp: Number(scan.mrp || 0),
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
    const records = await Inventory.find(reportFilter(req.query, scanType)).sort({ timestamp: -1, createdAt: -1 }).limit(1000).lean();
    return res.json({ success: true, type: scanType.toLowerCase(), count: records.length, rows: records.map(reportRow) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

function mobileItem(scan) {
  const timestamp = scan.timestamp ? new Date(scan.timestamp).getTime() : Date.now();
  return {
    id: scan.rawScan || scan.rawScanString || scan.uniqueScanId || String(scan._id),
    type: scan.type || scan.scanType || 'INWARD',
    upiSequence: scan.upiId || '',
    partNumber: scan.partNumber || scan.part || '',
    partName: scan.partName || '',
    partDescription: scan.partDescription || scan.partName || '',
    description: scan.partDescription || scan.partName || '',
    category: scan.productCategory || scan.category || '',
    productCategory: scan.productCategory || scan.category || '',
    binLocation: scan.binLocation || scan.bin || '',
    bin: scan.binLocation || scan.bin || '',
    quantity: Number(scan.quantity || scan.qty || 1),
    qty: Number(scan.quantity || scan.qty || 1),
    mrp: Number(scan.mrp || 0),
    damageReason: scan.damageReason || '',
    remarks: scan.remarks || '',
    vinNo: scan.vinNo || '',
    registrationNo: scan.registrationNo || '',
    jobNo: scan.jobNo || '',
    dealerCode: scan.dealerCode || '',
    userId: scan.userId || scan.loginId || '',
    userName: scan.userName || scan.staffName || scan.loginId || '',
    role: scan.role || '',
    scanType: scan.scanType || scan.type || 'INWARD',
    source: scan.source || '',
    rawUpi: scan.rawUpi || scan.rawScan || scan.rawScanString || '',
    rawScan: scan.rawScan || scan.rawScanString || scan.rawUpi || '',
    rawScanString: scan.rawScanString || scan.rawScan || '',
    timestamp: scan.timestamp || timestamp,
    scanTime: scan.timestamp || timestamp,
    syncStatus: scan.syncStatus || (scan.synced || scan.isSynced ? 'synced' : 'pending'),
    isSynced: true,
    isDuplicate: false
  };
}

router.post('/connect', auth.optionalAuth, devices.connectHandler);
router.post('/heartbeat', auth.optionalAuth, devices.heartbeatHandler);

router.post('/login', async (req, res) => {
  try {
    const username = cleanUsername(req.body.username || req.body.userId || req.body.login || req.body.email);
    const password = String(req.body.password || '');
    const pin = String(req.body.pin || '').trim();
    const dealerCode = auth.normalizeAccessCode(req.body.dealerCode);
    const deviceId = clean(req.body.deviceId);

    if (!dealerCode) return res.status(400).json({ success: false, message: 'Dealer code is required' });
    if (!username) return res.status(400).json({ success: false, message: 'User ID is required' });
    if (!password && !pin) return res.status(400).json({ success: false, message: 'Password or PIN is required' });

    const user = await findUserByLogin(username);
    if (!user) return res.status(401).json({ success: false, message: 'Invalid username, password, or PIN' });
    if (!userIsApproved(user)) return res.status(403).json({ success: false, message: 'Login not approved. Please contact administrator.' });
    if (!userIsActive(user)) return res.status(403).json({ success: false, message: 'User is blocked/inactive. Please contact administrator.' });

    const access = dealerAccessForUser(user, dealerCode);
    if (!access.allowed) {
      return res.status(403).json({
        success: false,
        message: 'Dealer access not assigned',
        requestedDealer: access.requestedDealer,
        userDealerAccess: access.userDealerAccess
      });
    }

    let valid = false;
    if (password) valid = await compareSecret(user, password, ['passwordHash', 'password']);
    if (!valid && pin) valid = await compareSecret(user, pin, ['pinHash', 'pin']);
    if (!valid) return res.status(401).json({ success: false, message: 'Invalid username, password, or PIN' });

    const dealer = await Dealer.findOne({ dealerCode: access.requestedDealer }).lean();
    const publicUser = auth.publicUser(user);
    const token = signMobileToken(user);
    if (deviceId) {
      await Device.findOneAndUpdate(
        { deviceId },
        {
          deviceId,
          deviceName: clean(req.body.deviceName || 'Daksh Android Scanner'),
          model: clean(req.body.model || 'Android'),
          deviceType: 'mobile',
          connectionMethod: 'mobile_camera',
          approved: true,
          dealerCode: access.requestedDealer,
          dealerName: dealer?.dealerName || '',
          userId: String(publicUser.id || ''),
          loginId: publicUser.username || '',
          userName: publicUser.name || publicUser.username || '',
          staffName: publicUser.name || publicUser.username || '',
          role: publicUser.role || '',
          appVersion: clean(req.body.appVersion || MOBILE_APP_VERSION),
          status: 'online',
          scannerStatus: 'ready',
          healthStatus: 'healthy',
          lastSeen: new Date(),
          connectedAt: new Date(),
          pendingCount: 0,
          failedCount: 0
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      req.app.get('io')?.emit('devices:update', { deviceId, at: new Date() });
    }

    return res.json({
      success: true,
      token,
      expiresIn: '12h',
      user: publicUser,
      dealerCode: access.requestedDealer,
      dealerName: dealer?.dealerName || '',
      appVersion: MOBILE_APP_VERSION,
      message: 'Login verified'
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

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

router.get('/config', auth.optionalAuth, async (req, res) => {
  try {
    const info = serverInfo(req.app.locals.activePort);
    const activeAudit = await getActiveAudit().catch(() => null);
    return res.json({
      success: true,
      appName: 'Daksh Inventory',
      mobileAppVersion: MOBILE_APP_VERSION,
      serverTime: new Date(),
      serverUrl: info.serverUrl,
      healthUrl: info.healthUrl,
      connectUrl: info.connectUrl,
      syncUrl: `${info.serverUrl}/api/mobile/sync-bulk`,
      loginUrl: `${info.serverUrl}/api/mobile/login`,
      cooldownMs: 4000,
      supportedScanTypes: ['INWARD', 'OUTWARD', 'VERIFICATION'],
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
    const access = dealerAccessForUser(req.user, dealerCode);
    if (!access.allowed) return res.status(403).json({ success: false, message: 'Dealer access not assigned' });

    const [dealer, activeAudit] = await Promise.all([
      Dealer.findOne({ dealerCode: access.requestedDealer }).lean(),
      getActiveAudit().catch(() => null)
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
        serverUrl: clean(req.body.serverUrl || serverInfo(req.app.locals.activePort).serverUrl),
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

router.post('/sync', auth.requireAuth, sync.pushHandler);
router.post('/scan', auth.requireAuth, sync.pushHandler);
router.post('/sync-bulk', auth.requireAuth, sync.pushHandler);
router.post('/realtime-scan', auth.requireAuth, sync.pushHandler);

router.get('/status', auth.optionalAuth, async (req, res) => {
  try {
    const info = serverInfo(req.app.locals.activePort);
    const activeAudit = await getActiveAudit().catch(() => null);
    const status = await mobileDeviceStatus(clean(req.query.deviceId));
    return res.json({
      success: true,
      serverStatus: 'online',
      status: status.status,
      connected: status.connected,
      approved: status.approved,
      loginVerified: Boolean(req.user),
      serverUrl: info.serverUrl,
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

router.get('/validate-part', auth.optionalAuth, async (req, res) => {
  try {
    const partNumber = normalizePartNumber(req.query.partNumber || req.query.part || '');
    const dealerCode = clean(req.query.dealerCode || '').toUpperCase();
    if (!partNumber) return res.status(400).json({ success: false, found: false, message: 'Part number is required' });
    const [catalogue, dealerMaster, anyMaster] = await Promise.all([
      MasterCatalogue.findOne({ normalizedPartNumber: partNumber }).lean(),
      dealerCode ? MasterPart.findOne({
        $or: [{ normalizedPartNumber: partNumber }, { partNo: partNumber }, { partNumber }],
        dealerCode
      }).lean() : null,
      MasterPart.findOne({ $or: [{ normalizedPartNumber: partNumber }, { partNo: partNumber }, { partNumber }] }).lean()
    ]);
    const master = catalogue || dealerMaster || anyMaster;
    return res.json({
      success: true,
      found: Boolean(master),
      partNumber,
      dealerCode,
      partDescription: master ? master.partDescription || master.partName || '' : '',
      productCategory: master ? master.productCategory || master.category || '' : ''
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
    const [catalogue, master] = await Promise.all([
      MasterCatalogue.findOne({ normalizedPartNumber: partNumber }).lean(),
      MasterPart.findOne({ normalizedPartNumber: partNumber, ...(dealerCode ? { dealerCode } : {}) }).lean()
    ]);
    const log = await VerificationLog.create({
      partNumber,
      found: Boolean(catalogue || master),
      dealerCode,
      deviceId: clean(req.body.deviceId),
      scannedBy: req.user ? req.user.username || req.user.name : ''
    });
    return res.json({ success: true, log });
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
    const records = await Inventory.find(dealerFilter(req.query))
      .sort({ timestamp: -1 })
      .limit(1000)
      .lean();
    return res.json(records.map(mobileItem));
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/reports/unique-upi', auth.optionalAuth, async (req, res) => {
  try {
    const records = await Inventory.find(dealerFilter(req.query))
      .sort({ timestamp: -1 })
      .limit(1000)
      .lean();
    const seen = new Set();
    const unique = [];
    records.forEach((scan) => {
      const key = scan.upiId || scan.rawScan || scan.rawScanString || scan.uniqueScanId || String(scan._id);
      if (seen.has(key)) return;
      seen.add(key);
      unique.push(mobileItem(scan));
    });
    return res.json(unique);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/reports/summary', auth.optionalAuth, async (req, res) => {
  try {
    const filter = dealerFilter(req.query);
    const [summaryRows, lastScan, duplicateCount] = await Promise.all([
      Inventory.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            totalQty: { $sum: '$qty' },
            inward: { $sum: { $cond: [{ $eq: ['$scanType', 'INWARD'] }, 1, 0] } },
            outward: { $sum: { $cond: [{ $eq: ['$scanType', 'OUTWARD'] }, 1, 0] } },
            fitted: { $sum: { $cond: [{ $eq: ['$scanType', 'FITTED'] }, 1, 0] } },
            damage: { $sum: { $cond: [{ $eq: ['$scanType', 'DAMAGE'] }, 1, 0] } },
            pending: { $sum: { $cond: [{ $eq: ['$syncStatus', 'pending'] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ['$syncStatus', 'failed'] }, 1, 0] } },
            synced: { $sum: { $cond: [{ $eq: ['$syncStatus', 'synced'] }, 1, 0] } },
            lastScanAt: { $max: '$timestamp' }
          }
        }
      ]),
      Inventory.findOne(filter).sort({ timestamp: -1, createdAt: -1 }).lean(),
      DuplicateScanLog.countDocuments(filter)
    ]);
    const row = summaryRows[0] || {};
    return res.json({
      success: true,
      summary: {
        dealerCode: clean(req.query.dealerCode).toUpperCase(),
        dealerName: lastScan?.dealerName || '',
        total: Number(row.total || 0),
        totalQty: Number(row.totalQty || 0),
        inward: Number(row.inward || 0),
        outward: Number(row.outward || 0),
        fitted: Number(row.fitted || 0),
        damage: Number(row.damage || 0),
        pending: Number(row.pending || 0),
        failed: Number(row.failed || 0),
        synced: Number(row.synced || 0),
        duplicates: Number(duplicateCount || 0),
        duplicateCount: Number(duplicateCount || 0),
        lastScanAt: row.lastScanAt || ''
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/reports/last-scans', auth.optionalAuth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 100);
    const records = await Inventory.find(dealerFilter(req.query)).sort({ timestamp: -1, createdAt: -1 }).limit(limit).lean();
    return res.json({ success: true, records: records.map(mobileItem) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/reports/verify-scan', auth.optionalAuth, async (req, res) => {
  try {
    const value = clean(req.query.value);
    const rawValue = value.toUpperCase();
    const partNumber = partFromVerificationValue(value);
    if (!value) {
      return res.status(400).json({ success: false, scanned: false, message: 'QR code or part number is required' });
    }
    const filter = dealerFilter(req.query);
    filter.$or = [
      { rawScan: rawValue },
      { rawScanString: rawValue },
      { rawUpi: rawValue },
      { partNumber },
      { part: partNumber },
      { normalizedPartNumber: partNumber }
    ];
    const scan = await Inventory.findOne(filter).sort({ timestamp: -1, createdAt: -1 }).lean();
    return res.json({
      success: true,
      scanned: Boolean(scan),
      query: value,
      partNumber,
      message: scan ? 'Scan found' : 'No matching scan data found',
      scan: scan ? mobileItem(scan) : null
    });
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
    const rows = await VerificationLog.find(dealerFilter(req.query)).sort({ time: -1 }).limit(1000).lean();
    return res.json({ success: true, count: rows.length, rows: rows.map((row) => ({
      time: row.time,
      dealerCode: row.dealerCode || '',
      user: row.staffName || row.scannedBy || row.loginId || row.userId || '',
      scanType: row.scanType || '',
      rawScannedValue: row.rawScannedValue || '',
      extractedPartNumber: row.extractedPartNumber || row.partNumber || '',
      partNumber: row.partNumber || row.extractedPartNumber || '',
      binLocation: row.binLocation || '',
      reason: row.reason || (row.found ? 'Found In Master' : 'Not Found In Master'),
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
      rows = (await Inventory.find(reportFilter(req.query, map[type])).sort({ timestamp: -1 }).limit(5000).lean()).map(reportRow);
    } else if (type === 'verification') {
      rows = (await VerificationLog.find(dealerFilter(req.query)).sort({ time: -1 }).limit(5000).lean()).map((row) => ({
        time: row.time,
        dealerCode: row.dealerCode || '',
        user: row.staffName || row.scannedBy || row.loginId || row.userId || '',
        scanType: row.scanType || '',
        rawScannedValue: row.rawScannedValue || '',
        extractedPartNumber: row.extractedPartNumber || row.partNumber || '',
        partNumber: row.partNumber || row.extractedPartNumber || '',
        binLocation: row.binLocation || '',
        reason: row.reason || (row.found ? 'Found In Master' : 'Not Found In Master'),
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
    rows.forEach((row) => sheet.addRow(row));
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
    const records = await Inventory.aggregate([
      { $match: dealerFilter(req.query) },
      {
        $group: {
          _id: {
            dealerCode: '$dealerCode',
            binLocation: '$binLocation',
            partNumber: '$partNumber',
            mrp: '$mrp',
            scanType: '$scanType',
            deviceId: '$deviceId'
          },
          qty: { $sum: '$qty' },
          partDescription: { $first: '$partDescription' },
          productCategory: { $first: '$productCategory' },
          lastScanTime: { $max: '$timestamp' }
        }
      },
      { $sort: { lastScanTime: -1 } },
      { $limit: 1000 }
    ]);
    return res.json({
      success: true,
      records: records.map((row) => ({
        dealerCode: row._id.dealerCode || '',
        binLocation: row._id.binLocation || '',
        partNumber: row._id.partNumber || '',
        partDescription: row.partDescription || '',
        productCategory: row.productCategory || '',
        qty: Number(row.qty || 0),
        mrp: Number(row._id.mrp || 0),
        scanType: row._id.scanType || '',
        lastScanTime: row.lastScanTime || '',
        deviceId: row._id.deviceId || ''
      }))
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
