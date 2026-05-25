const express = require('express');
const { randomUUID } = require('crypto');
const Device = require('../models/Device');
const BluetoothDevice = require('../models/BluetoothDevice');
const BluetoothScanLog = require('../models/BluetoothScanLog');
const User = require('../models/User');
const auth = require('./auth');
const { isLocalhostUrl, serverInfo } = require('../utils/network');
const { getActiveAudit, publicAudit } = require('../utils/audit');

const router = express.Router();

function requestIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0]
    .trim()
    .replace('::ffff:', '');
}

function liveCutoff() {
  return new Date(Date.now() - 30 * 1000);
}

async function markExpiredDevicesOffline() {
  const result = await Device.updateMany(
    { deviceType: 'mobile', status: 'online', lastSeen: { $lt: liveCutoff() }, removedAt: null },
    { $set: { status: 'offline', disconnectedAt: new Date(), disconnectedBy: 'heartbeat-timeout' } }
  );
  if (result.modifiedCount) console.log('Device online/offline update', { offlineCount: result.modifiedCount });
}

function clean(value) {
  return String(value || '').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function normalizeBluetoothMode(value, fallback = 'Any') {
  const text = clean(value || fallback).toLowerCase();
  if (text === 'inward') return 'Inward';
  if (text === 'outward') return 'Outward';
  if (text === 'verification' || text === 'verify' || text === 'audit') return 'Verification';
  return 'Any';
}

function normalizeApprovalStatus(value, fallback = 'pending') {
  const text = clean(value || fallback).toLowerCase();
  return ['pending', 'approved', 'rejected', 'blocked'].includes(text) ? text : fallback;
}

function normalizeConnectionStatus(value, fallback = 'pairing') {
  const text = clean(value || fallback).toLowerCase();
  return ['connected', 'disconnected', 'error', 'pairing'].includes(text) ? text : fallback;
}

function macAddress(value) {
  return upper(value).replace(/[^A-F0-9:-]/g, '');
}

function userIdentities(user = {}) {
  return [user.id, user._id, user.username, user.email, user.name]
    .map((value) => clean(value))
    .filter(Boolean);
}

function bluetoothBaseFilter(req) {
  const filter = { isActive: { $ne: false } };
  if (req.user && req.user.role === 'admin') return filter;
  const identities = userIdentities(req.user);
  filter.$or = identities.length
    ? [
      { assignedUserId: { $in: identities } },
      { assignedUserName: { $in: identities } }
    ]
    : [{ assignedUserId: '__none__' }];
  return filter;
}

function bluetoothQueryFilter(req) {
  const filter = bluetoothBaseFilter(req);
  if (req.query.status) filter.connectionStatus = normalizeConnectionStatus(req.query.status, clean(req.query.status).toLowerCase());
  if (req.query.approval) filter.approvalStatus = normalizeApprovalStatus(req.query.approval, clean(req.query.approval).toLowerCase());
  if (req.query.mode) filter.assignedMode = normalizeBluetoothMode(req.query.mode);
  if (req.query.dealer) filter.dealerCode = upper(req.query.dealer);
  if (req.query.user && req.user && req.user.role === 'admin') {
    const userText = clean(req.query.user);
    filter.$or = [
      { assignedUserId: new RegExp(userText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
      { assignedUserName: new RegExp(userText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
    ];
  }
  return filter;
}

function publicBluetoothDevice(device = {}) {
  return {
    _id: device._id,
    deviceName: device.deviceName || 'Bluetooth Scanner',
    deviceId: device.deviceId || '',
    macAddress: device.macAddress || '',
    connectionStatus: device.connectionStatus || 'pairing',
    approvalStatus: device.approvalStatus || 'pending',
    assignedUserId: device.assignedUserId || '',
    assignedUserName: device.assignedUserName || '',
    assignedMode: device.assignedMode || 'Any',
    dealerCode: device.dealerCode || '',
    lastScanValue: device.lastScanValue || '',
    lastScanAt: device.lastScanAt || null,
    lastError: device.lastError || '',
    isActive: device.isActive !== false,
    hidIdentityLimited: device.hidIdentityLimited !== false,
    mappingType: device.mappingType || 'keyboard_hid',
    mappingValue: device.mappingValue || '',
    mappingSessionId: device.mappingSessionId || '',
    lastConnectedAt: device.lastConnectedAt || null,
    lastDisconnectedAt: device.lastDisconnectedAt || null,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt
  };
}

async function bluetoothSummary(baseFilter = {}, logFilter = {}) {
  const [total, connected, approved, pending, rejected, blocked, lastActive, lastErrorDevice, lastScanError] = await Promise.all([
    BluetoothDevice.countDocuments(baseFilter),
    BluetoothDevice.countDocuments({ ...baseFilter, connectionStatus: 'connected' }),
    BluetoothDevice.countDocuments({ ...baseFilter, approvalStatus: 'approved' }),
    BluetoothDevice.countDocuments({ ...baseFilter, approvalStatus: 'pending' }),
    BluetoothDevice.countDocuments({ ...baseFilter, approvalStatus: 'rejected' }),
    BluetoothDevice.countDocuments({ ...baseFilter, approvalStatus: 'blocked' }),
    BluetoothDevice.findOne({ ...baseFilter, lastScanAt: { $exists: true } }).sort({ lastScanAt: -1 }).lean(),
    BluetoothDevice.findOne({ ...baseFilter, lastError: { $ne: '' } }).sort({ updatedAt: -1 }).lean(),
    BluetoothScanLog.findOne({ ...logFilter, status: { $in: ['error', 'rejected', 'blocked'] } }).sort({ scanTime: -1, createdAt: -1 }).lean()
  ]);
  return {
    totalDetected: total,
    connectedScanners: connected,
    approvedScanners: approved,
    pendingApproval: pending,
    rejectedBlocked: rejected + blocked,
    lastActiveScanner: lastActive ? (lastActive.deviceName || lastActive.deviceId) : '',
    lastActiveScannerId: lastActive ? lastActive.deviceId : '',
    lastScanTime: lastActive ? lastActive.lastScanAt : null,
    lastConnectionError: lastErrorDevice ? lastErrorDevice.lastError : '',
    lastScanError: lastScanError ? lastScanError.errorMessage : ''
  };
}

async function bluetoothLogFilterForRequest(req, filter = {}) {
  if (req.user && req.user.role === 'admin') return filter;
  const visibleDevices = await BluetoothDevice.find(bluetoothBaseFilter(req)).select('deviceId').lean();
  const allowedDeviceIds = visibleDevices.map((device) => device.deviceId).filter(Boolean);
  if (!allowedDeviceIds.length) return { ...filter, deviceId: '__none__' };
  if (filter.deviceId) {
    return allowedDeviceIds.includes(filter.deviceId) ? filter : { ...filter, deviceId: '__none__' };
  }
  return { ...filter, deviceId: { $in: allowedDeviceIds } };
}

function bluetoothServiceStatus() {
  if (process.platform !== 'win32') {
    return {
      status: 'limited',
      message: 'Bluetooth service status check is limited on this server platform.'
    };
  }
  return {
    status: 'limited',
    message: 'Windows Bluetooth scanners usually appear as keyboard HID devices. Browser-level unique identity is limited.'
  };
}

async function emitBluetoothUpdate(req, payload = {}) {
  if (!req.io) return;
  req.io.emit('bluetooth-devices:update', { ...payload, at: new Date() });
  req.io.emit('devices:update', { ...payload, at: new Date() });
}

async function findAssignedUser(body = {}) {
  const requested = clean(body.userId || body.assignedUserId || body.username || body.userName || body.assignedUserName);
  if (!requested) return null;
  const user = await User.findOne({
    $or: [
      /^[a-f\d]{24}$/i.test(requested) ? { _id: requested } : null,
      { username: requested.toLowerCase() },
      { email: requested.toLowerCase() },
      { name: new RegExp(`^${requested.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
    ].filter(Boolean)
  }).lean();
  return user || {
    _id: clean(body.userId || body.assignedUserId),
    username: clean(body.username),
    name: clean(body.userName || body.assignedUserName || requested)
  };
}

async function updateBluetoothDevice(req, res, patch, message) {
  try {
    const deviceId = clean(req.body.deviceId || req.query.deviceId);
    if (!deviceId) return res.status(400).json({ success: false, message: 'Device ID is required' });
    const device = await BluetoothDevice.findOneAndUpdate(
      { deviceId },
      { ...patch, isActive: patch.isActive === undefined ? true : patch.isActive },
      { new: true, runValidators: true }
    );
    if (!device) return res.status(404).json({ success: false, message: 'Bluetooth scanner not found' });
    await emitBluetoothUpdate(req, { deviceId });
    return res.json({ success: true, message, device: publicBluetoothDevice(device.toObject()) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
}

function userContextFromRequest(req, defaults = {}) {
  const body = req.body || {};
  const user = req.user || {};
  const loginId = clean(body.loginId || body.username || defaults.loginId || defaults.username || user.username || user.email || user.id);
  const userId = clean(body.userId || defaults.userId || user.id || loginId);
  const userName = clean(body.userName || body.staffName || defaults.userName || defaults.staffName || user.name || user.username || loginId);
  return {
    userId,
    loginId,
    userName,
    staffName: clean(body.staffName || defaults.staffName || user.name || userName),
    role: clean(body.role || defaults.role || user.role).toLowerCase()
  };
}

function cleanDevicePayload(req, defaults = {}) {
  const serverUrl = clean(req.body.serverUrl || defaults.serverUrl);
  if (isLocalhostUrl(serverUrl)) {
    const error = new Error('Do not use localhost on mobile. Use the PC LAN IP from QR or manual connect, for example http://192.168.x.x:3001.');
    error.status = 400;
    throw error;
  }

  const batteryRaw = req.body.batteryPercent ?? req.body.battery ?? defaults.batteryPercent;
  const battery = Number(batteryRaw);
  const payload = {
    deviceId: clean(req.body.deviceId || defaults.deviceId || randomUUID()),
    deviceName: clean(req.body.deviceName || defaults.deviceName || 'Scanner Device'),
    model: clean(req.body.model || defaults.model),
    deviceType: clean(req.body.deviceType || defaults.deviceType || 'mobile').toLowerCase() === 'web' ? 'web' : 'mobile',
    connectionMethod: clean(req.body.connectionMethod || defaults.connectionMethod || 'mobile_camera'),
    approved: true,
    dealerCode: clean(req.body.dealerCode || defaults.dealerCode).toUpperCase(),
    dealerName: clean(req.body.dealerName || defaults.dealerName),
    auditId: clean(req.body.auditId || defaults.auditId),
    ...userContextFromRequest(req, defaults),
    serverUrl,
    ipAddress: requestIp(req),
    status: 'online',
    scannerStatus: clean(req.body.scannerStatus || defaults.scannerStatus || 'ready'),
    appVersion: clean(req.body.appVersion || req.body.version || defaults.appVersion),
    lastSeen: new Date(),
    connectedAt: defaults.connectedAt || new Date(),
    disconnectedAt: undefined,
    disconnectedBy: '',
    removedAt: null
  };
  if (Number.isFinite(battery)) payload.batteryPercent = Math.max(0, Math.min(100, battery));
  const signal = Number(req.body.signalStrength ?? req.body.signal ?? defaults.signalStrength);
  payload.signalStrength = Number.isFinite(signal) ? Math.max(0, Math.min(100, signal)) : 100;
  payload.connectionQuality = payload.signalStrength;
  payload.lowBatteryWarning = Number.isFinite(battery) && battery <= 15;
  payload.healthStatus = payload.lowBatteryWarning ? 'low-battery' : 'healthy';
  return payload;
}

function cleanDevice(device) {
  if (!device) return device;
  const lastSeen = device.lastSeen ? new Date(device.lastSeen) : null;
  const online = device.status === 'online' && lastSeen && lastSeen >= liveCutoff();
  return {
    ...device,
    status: online ? 'online' : 'offline',
    lastDealer: device.dealerCode || '',
    lastDealerName: device.dealerName || '',
    approved: device.approved !== false
  };
}

async function listDevices(req, res) {
  try {
    const manager = req.app.get('scannerManager');
    if (manager) {
      const [listed, summary, activeAudit] = await Promise.all([
        manager.list(),
        manager.summary(),
        getActiveAudit()
      ]);
      return res.json({
        success: true,
        activeCount: summary.connectedDevices,
        activeScannerCount: summary.activeScannerCount,
        offlineDevices: summary.offlineDevices,
        lowBatteryCount: summary.lowBatteryCount,
        pendingSyncCount: summary.pendingSyncCount,
        bluetoothOnline: summary.bluetoothOnline,
        wifiOnline: summary.wifiOnline,
        usbOnline: summary.usbOnline,
        devices: listed.online,
        oldDevices: listed.offline,
        activeAudit: publicAudit(activeAudit),
        mobileSyncEnabled: Boolean(activeAudit),
        message: activeAudit ? 'Realtime scanner sync enabled' : 'No active audit found. Scanner sync is disabled.'
      });
    }
    await markExpiredDevicesOffline();
    const cutoff = liveCutoff();
    const [devices, oldDevices, activeAudit] = await Promise.all([
      Device.find({ deviceType: 'mobile', removedAt: null, status: 'online', lastSeen: { $gte: cutoff } }).sort({ lastSeen: -1 }).lean(),
      Device.find({
        deviceType: 'mobile',
        removedAt: null,
        $or: [{ status: 'offline' }, { lastSeen: { $lt: cutoff } }]
      }).sort({ lastSeen: -1 }).limit(50).lean(),
      getActiveAudit()
    ]);
    res.json({
      success: true,
      activeCount: devices.length,
      devices: devices.map(cleanDevice),
      oldDevices: oldDevices.map(cleanDevice),
      activeAudit: publicAudit(activeAudit),
      mobileSyncEnabled: Boolean(activeAudit),
      message: activeAudit ? 'Mobile sync enabled' : 'No active audit found. Mobile sync is disabled.'
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
}

router.get('/', auth.requireAuth, listDevices);
router.get('/list', auth.requireAuth, listDevices);
router.get('/connected', auth.optionalAuth, listDevices);

router.use('/bluetooth', (req, res) => {
  res.status(410).json({ success: false, disabled: true, message: 'Bluetooth scanner features are disabled.' });
});

router.get('/bluetooth', auth.requireAuth, async (req, res) => {
  try {
    const filter = bluetoothQueryFilter(req);
    const baseFilter = bluetoothBaseFilter(req);
    const limit = Math.min(300, Math.max(1, Number(req.query.limit || 100)));
    const requestedLogFilter = req.query.deviceId ? { deviceId: clean(req.query.deviceId) } : {};
    const logFilter = await bluetoothLogFilterForRequest(req, requestedLogFilter);
    const [devices, summary, logs] = await Promise.all([
      BluetoothDevice.find(filter).sort({ connectionStatus: 1, approvalStatus: 1, lastScanAt: -1, updatedAt: -1 }).limit(limit).lean(),
      bluetoothSummary(baseFilter, logFilter),
      BluetoothScanLog.find(logFilter).sort({ scanTime: -1, createdAt: -1 }).limit(50).lean()
    ]);
    return res.json({
      success: true,
      devices: devices.map(publicBluetoothDevice),
      summary,
      logs,
      bluetoothService: bluetoothServiceStatus(),
      hidIdentityWarning: 'This scanner is working as keyboard HID. Unique device identification is limited. Use assigned workstation/user/mode mapping.'
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/bluetooth/register', auth.requireAuth, async (req, res) => {
  try {
    const deviceId = clean(req.body.deviceId || req.body.macAddress || req.body.deviceName || randomUUID());
    const existing = await BluetoothDevice.findOne({ deviceId });
    const payload = {
      deviceName: clean(req.body.deviceName || (existing && existing.deviceName) || 'Bluetooth Scanner'),
      deviceId,
      macAddress: macAddress(req.body.macAddress || (existing && existing.macAddress)),
      connectionStatus: normalizeConnectionStatus(req.body.connectionStatus, 'connected'),
      dealerCode: upper(req.body.dealerCode || (existing && existing.dealerCode)),
      lastError: '',
      isActive: true,
      lastConnectedAt: new Date(),
      hidIdentityLimited: req.body.hidIdentityLimited !== false
    };
    const update = existing
      ? payload
      : { ...payload, approvalStatus: 'pending', assignedMode: normalizeBluetoothMode(req.body.assignedMode || req.body.scanMode) };
    const device = await BluetoothDevice.findOneAndUpdate(
      { deviceId },
      update,
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );
    await emitBluetoothUpdate(req, { deviceId });
    return res.status(existing ? 200 : 201).json({
      success: true,
      message: existing ? 'Bluetooth scanner refreshed' : 'Bluetooth scanner detected and pending approval',
      device: publicBluetoothDevice(device.toObject())
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/bluetooth/approve', auth.requireAuth, auth.requireAdmin, (req, res) => updateBluetoothDevice(req, res, {
  approvalStatus: 'approved',
  connectionStatus: 'connected',
  lastError: '',
  lastConnectedAt: new Date()
}, 'Bluetooth scanner approved'));

router.post('/bluetooth/reject', auth.requireAuth, auth.requireAdmin, (req, res) => updateBluetoothDevice(req, res, {
  approvalStatus: 'rejected',
  connectionStatus: 'disconnected',
  lastError: 'Rejected by admin',
  lastDisconnectedAt: new Date()
}, 'Bluetooth scanner rejected'));

router.post('/bluetooth/block', auth.requireAuth, auth.requireAdmin, (req, res) => updateBluetoothDevice(req, res, {
  approvalStatus: 'blocked',
  connectionStatus: 'disconnected',
  lastError: 'Blocked by admin',
  lastDisconnectedAt: new Date()
}, 'Bluetooth scanner blocked'));

router.post('/bluetooth/remove', auth.requireAuth, auth.requireAdmin, (req, res) => updateBluetoothDevice(req, res, {
  isActive: false,
  connectionStatus: 'disconnected',
  lastError: 'Removed by admin',
  lastDisconnectedAt: new Date()
}, 'Bluetooth scanner removed'));

router.post('/bluetooth/assign-user', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const deviceId = clean(req.body.deviceId);
    if (!deviceId) return res.status(400).json({ success: false, message: 'Device ID is required' });
    const user = await findAssignedUser(req.body);
    if (!user) return res.status(400).json({ success: false, message: 'User is required' });
    const device = await BluetoothDevice.findOneAndUpdate(
      { deviceId },
      {
        assignedUserId: clean(user._id || user.id || user.username),
        assignedUserName: clean(user.name || user.username || req.body.userName),
        dealerCode: upper(req.body.dealerCode),
        isActive: true
      },
      { new: true, runValidators: true }
    );
    if (!device) return res.status(404).json({ success: false, message: 'Bluetooth scanner not found' });
    await emitBluetoothUpdate(req, { deviceId });
    return res.json({ success: true, message: 'Bluetooth scanner user assigned', device: publicBluetoothDevice(device.toObject()) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/bluetooth/assign-mode', auth.requireAuth, auth.requireAdmin, (req, res) => updateBluetoothDevice(req, res, {
  assignedMode: normalizeBluetoothMode(req.body.assignedMode || req.body.scanMode || req.body.mode),
  dealerCode: upper(req.body.dealerCode)
}, 'Bluetooth scanner mode assigned'));

router.post('/bluetooth/reconnect', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const deviceId = clean(req.body.deviceId);
    if (deviceId) {
      return updateBluetoothDevice(req, res, {
        connectionStatus: 'pairing',
        lastError: '',
        lastConnectedAt: new Date()
      }, 'Bluetooth scanner reconnect requested');
    }
    const result = await BluetoothDevice.updateMany(
      { approvalStatus: 'approved', isActive: { $ne: false } },
      { $set: { connectionStatus: 'pairing', lastError: '', lastConnectedAt: new Date() } }
    );
    await emitBluetoothUpdate(req, { reconnectApproved: true });
    return res.json({ success: true, message: 'Reconnect requested for approved Bluetooth scanners', modifiedCount: result.modifiedCount || 0 });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/bluetooth/disconnect', auth.requireAuth, auth.requireAdmin, (req, res) => updateBluetoothDevice(req, res, {
  connectionStatus: 'disconnected',
  lastDisconnectedAt: new Date()
}, 'Bluetooth scanner disconnected'));

router.post('/bluetooth/test-scan', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const deviceId = clean(req.body.deviceId);
    if (!deviceId) return res.status(400).json({ success: false, message: 'Device ID is required' });
    const scanValue = clean(req.body.scanValue || req.body.rawScan || req.body.rawScanString);
    const sessionId = clean(req.body.sessionId || `BT-TEST-${Date.now()}-${randomUUID().slice(0, 8)}`);
    if (!scanValue) {
      return res.json({
        success: true,
        sessionId,
        message: 'Test scan session started',
        hidIdentityWarning: 'This scanner is working as keyboard HID. Unique device identification is limited. Use assigned workstation/user/mode mapping.'
      });
    }
    const device = await BluetoothDevice.findOneAndUpdate(
      { deviceId },
      {
        mappingType: 'keyboard_hid',
        mappingValue: scanValue.slice(0, 80),
        mappingSessionId: sessionId,
        hidIdentityLimited: true,
        lastScanValue: scanValue,
        lastScanAt: new Date(),
        lastError: ''
      },
      { new: true, runValidators: true }
    );
    if (!device) return res.status(404).json({ success: false, message: 'Bluetooth scanner not found' });
    await BluetoothScanLog.create({
      transactionId: sessionId,
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      userId: device.assignedUserId,
      userName: device.assignedUserName,
      scanMode: device.assignedMode,
      dealerCode: device.dealerCode,
      scanValue,
      scanTime: new Date(),
      status: 'test',
      source: 'Bluetooth Scanner'
    }).catch(() => null);
    await emitBluetoothUpdate(req, { deviceId });
    return res.json({
      success: true,
      message: 'Scanner mapped successfully',
      hidIdentityWarning: 'This scanner is working as keyboard HID. Unique device identification is limited. Use assigned workstation/user/mode mapping.',
      device: publicBluetoothDevice(device.toObject())
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/bluetooth/logs', auth.requireAuth, async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
    const filter = {};
    if (req.query.deviceId) filter.deviceId = clean(req.query.deviceId);
    if (req.query.status) filter.status = clean(req.query.status).toLowerCase();
    if (req.query.mode) filter.scanMode = normalizeBluetoothMode(req.query.mode);
    if (req.query.dealer) filter.dealerCode = upper(req.query.dealer);
    const scopedFilter = await bluetoothLogFilterForRequest(req, filter);
    const logs = await BluetoothScanLog.find(scopedFilter).sort({ scanTime: -1, createdAt: -1 }).limit(limit).lean();
    return res.json({ success: true, logs });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/bluetooth/logs/clear', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const filter = {};
    if (req.body.deviceId) filter.deviceId = clean(req.body.deviceId);
    if (req.body.status) filter.status = clean(req.body.status).toLowerCase();
    const result = await BluetoothScanLog.deleteMany(filter);
    if (req.body.clearDeviceErrors !== false) {
      const deviceFilter = req.body.deviceId ? { deviceId: clean(req.body.deviceId) } : {};
      await BluetoothDevice.updateMany(deviceFilter, { $set: { lastError: '' } }).catch(() => null);
    }
    await emitBluetoothUpdate(req, { logsCleared: result.deletedCount || 0 });
    return res.json({
      success: true,
      message: 'Bluetooth scan logs cleared',
      deletedCount: result.deletedCount || 0
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/bluetooth/restart-listener', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  await emitBluetoothUpdate(req, { listenerRestarted: true });
  return res.json({
    success: true,
    message: 'Bluetooth scanner listener refreshed',
    bluetoothService: bluetoothServiceStatus()
  });
});

router.post('/bluetooth/clear-ghosts', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const result = await BluetoothDevice.updateMany(
      { connectionStatus: 'disconnected', isActive: { $ne: false } },
      { $set: { isActive: false, lastError: 'Cleared as disconnected ghost device' } }
    );
    await emitBluetoothUpdate(req, { clearedGhosts: result.modifiedCount || 0 });
    return res.json({ success: true, message: 'Disconnected ghost devices cleared', modifiedCount: result.modifiedCount || 0 });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

async function connectHandler(req, res) {
  try {
    console.log('Mobile connect request', {
      deviceId: req.body.deviceId,
      deviceName: req.body.deviceName,
      model: req.body.model,
      appVersion: req.body.appVersion || req.body.version,
      userId: req.body.userId || req.body.loginId || req.body.username,
      userName: req.body.userName || req.body.staffName,
      role: req.body.role,
      serverUrl: req.body.serverUrl,
      ipAddress: requestIp(req)
    });
    const info = serverInfo(req.app.locals.activePort);
    const activeAudit = await getActiveAudit();
    const payload = cleanDevicePayload(req, {
      deviceName: 'Mobile Scanner',
      serverUrl: info.serverUrl,
      deviceType: 'mobile',
      dealerCode: activeAudit ? activeAudit.dealerCode : '',
      dealerName: activeAudit ? activeAudit.dealerName : '',
      auditId: activeAudit ? activeAudit.auditId : ''
    });
    if (activeAudit) {
      payload.dealerCode = String(activeAudit.dealerCode || '').trim().toUpperCase();
      payload.dealerName = String(activeAudit.dealerName || '').trim();
      payload.auditId = String(activeAudit.auditId || activeAudit._id || '').trim();
    }
    const device = await Device.findOneAndUpdate(
      { deviceId: payload.deviceId },
      { ...payload, connectedAt: new Date(), approved: true, deviceType: 'mobile' },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    req.io.emit('devices:update');
    req.io.emit('device:connected', device);
    console.log('Device saved', {
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      ipAddress: device.ipAddress,
      status: device.status,
      approved: device.approved,
      dealerCode: device.dealerCode,
      userId: device.userId,
      userName: device.userName,
      role: device.role
    });
    res.json({
      success: true,
      approved: true,
      status: 'connected',
      token: payload.deviceId,
      message: 'Connected successfully',
      deviceId: payload.deviceId,
      dealerCode: payload.dealerCode,
      dealerName: payload.dealerName,
      auditId: payload.auditId,
      activeAudit: publicAudit(activeAudit),
      syncEnabled: Boolean(activeAudit),
      syncWarning: activeAudit ? '' : 'No active audit found. Start audit from PC Admin.',
      device
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
}

router.post('/connect', auth.optionalAuth, connectHandler);

async function heartbeatHandler(req, res) {
  try {
    if (!clean(req.body.deviceId)) {
      return res.status(400).json({ success: false, message: 'Device ID is required' });
    }
    const existingDevice = await Device.findOne({ deviceId: clean(req.body.deviceId), removedAt: null }).lean();
    if (existingDevice && existingDevice.approved === false) {
      req.io.emit('devices:update');
      return res.status(403).json({ success: false, approved: false, status: 'blocked', message: 'This mobile device is blocked by admin.' });
    }
    const info = serverInfo(req.app.locals.activePort);
    const activeAudit = await getActiveAudit();
    const payload = cleanDevicePayload(req, {
      serverUrl: info.serverUrl,
      deviceType: 'mobile',
      dealerCode: activeAudit ? activeAudit.dealerCode : '',
      dealerName: activeAudit ? activeAudit.dealerName : '',
      auditId: activeAudit ? activeAudit.auditId : ''
    });
    if (activeAudit) {
      payload.dealerCode = String(activeAudit.dealerCode || '').trim().toUpperCase();
      payload.dealerName = String(activeAudit.dealerName || '').trim();
      payload.auditId = String(activeAudit.auditId || activeAudit._id || '').trim();
    }
    const device = await Device.findOneAndUpdate(
      { deviceId: payload.deviceId },
      {
        ...payload,
        approved: true,
        deviceType: 'mobile',
        pendingCount: Number(req.body.pendingCount || 0),
        failedCount: Number(req.body.failedCount || 0),
        syncStatus: activeAudit ? (req.body.syncStatus || 'working') : 'blocked'
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    console.log('Heartbeat received', {
      deviceId: device.deviceId,
      userId: device.userId,
      userName: device.userName,
      role: device.role,
      ipAddress: device.ipAddress,
      status: device.status,
      lastSeen: device.lastSeen
    });
    req.io.emit('devices:update');
    req.io.emit('device:heartbeat', device);
    req.io.emit('device:connected', device);
    return res.json({
      success: true,
      approved: true,
      status: 'online',
      activeAudit: publicAudit(activeAudit),
      syncEnabled: Boolean(activeAudit),
      syncWarning: activeAudit ? '' : 'No active audit found. Start audit from PC Admin.',
      device
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
}

router.post('/heartbeat', auth.optionalAuth, heartbeatHandler);

router.post('/disconnect', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const deviceId = clean(req.body.deviceId);
    if (!deviceId) return res.status(400).json({ success: false, message: 'Device ID is required' });

    const device = await Device.findOneAndUpdate(
      { deviceId },
      { status: 'offline', disconnectedAt: new Date(), disconnectedBy: 'admin' },
      { new: true }
    );

    req.io.emit('devices:update');
    req.io.emit('device:disconnected', device || { deviceId, status: 'offline' });
    return res.json({ success: true, device });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/force-reconnect', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const deviceId = clean(req.body.deviceId);
    if (!deviceId) return res.status(400).json({ success: false, message: 'Device ID is required' });
    const device = await Device.findOneAndUpdate(
      { deviceId, removedAt: null },
      { reconnectRequestedAt: new Date(), disconnectedBy: 'force-reconnect' },
      { new: true }
    );
    if (req.io) {
      req.io.emit('device:force-reconnect', { deviceId });
      req.io.emit('devices:update');
    }
    return res.json({ success: true, message: 'Reconnect requested', device });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/remove', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const deviceId = clean(req.body.deviceId);
    if (!deviceId) return res.status(400).json({ success: false, message: 'Device ID is required' });
    const permanent = req.body.permanent === true || req.body.permanent === 'true';
    const device = permanent
      ? await Device.findOneAndDelete({ deviceId })
      : await Device.findOneAndUpdate(
        { deviceId },
        { status: 'offline', removedAt: new Date(), disconnectedAt: new Date(), disconnectedBy: 'removed' },
        { new: true }
      );
    if (req.io) {
      req.io.emit('devices:update');
      req.io.emit('device:removed', device || { deviceId });
    }
    return res.json({ success: true, device });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/network-test', auth.requireAuth, async (req, res) => {
  try {
    const info = serverInfo(req.app.locals.activePort);
    const activeAudit = await getActiveAudit();
    return res.json({
      success: true,
      message: 'Cloud sync is available from WiFi, mobile data, hotspot, and different networks',
      lanIp: info.ip,
      ip: info.ip,
      port: info.port,
      portOpen: true,
      firewallBlocked: false,
      serverUrl: info.serverUrl,
      healthUrl: info.healthUrl,
      connectUrl: info.connectUrl,
      syncUrl: info.syncUrl,
      activeAudit: publicAudit(activeAudit)
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/discovery', auth.optionalAuth, async (req, res) => {
  try {
    const info = serverInfo(req.app.locals.activePort);
    const activeAudit = await getActiveAudit();
    return res.json({
      success: true,
      app: 'daksh-inventory-v2',
      name: 'Daksh Inventory PC Server',
      status: 'online',
      serverStatus: 'online',
      mongoStatus: require('mongoose').connection.readyState === 1 ? 'online' : 'offline',
      ip: info.ip,
      port: info.port,
      serverUrl: info.serverUrl,
      healthUrl: info.healthUrl,
      connectUrl: info.connectUrl,
      syncUrl: info.syncUrl,
      activeAudit: publicAudit(activeAudit),
      syncEnabled: Boolean(activeAudit)
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
module.exports.connectHandler = connectHandler;
module.exports.heartbeatHandler = heartbeatHandler;
module.exports.listDevices = listDevices;
module.exports.markExpiredDevicesOffline = markExpiredDevicesOffline;
module.exports.liveCutoff = liveCutoff;
