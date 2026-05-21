const express = require('express');
const Device = require('../models/Device');
const ScannerLog = require('../models/ScannerLog');
const ScannerSession = require('../models/ScannerSession');
const auth = require('./auth');
const { getActiveAudit, publicAudit } = require('../utils/audit');
const DeviceDiscoveryService = require('../services/DeviceDiscoveryService');
const QRPairService = require('../services/QRPairService');
const OfflineSyncService = require('../services/OfflineSyncService');
const AuditLogService = require('../services/AuditLogService');

const router = express.Router();

function clean(value) {
  return String(value || '').trim();
}

function scannerManager(req) {
  return req.app.get('scannerManager');
}

function qrPairService(req) {
  return req.app.get('qrPairService') || new QRPairService({ portProvider: () => req.app.locals.activePort || process.env.PORT || 3001 });
}

function discoveryService(req) {
  return req.app.get('deviceDiscoveryService') || new DeviceDiscoveryService({ portProvider: () => req.app.locals.activePort || process.env.PORT || 3001 });
}

function offlineSyncService(req) {
  return req.app.get('offlineSyncService') || new OfflineSyncService();
}

async function verifyPairingToken(req, res, next) {
  try {
    const token = clean(req.body.authToken || req.body.deviceToken || req.headers['x-device-token']);
    if (!token) return next();
    const session = await qrPairService(req).verifyToken(token);
    if (!session) return res.status(401).json({ success: false, message: 'Invalid or expired scanner pairing token' });
    req.scannerSession = session;
    return next();
  } catch (error) {
    return res.status(401).json({ success: false, message: error.message });
  }
}

router.get('/status', auth.requireAuth, async (req, res) => {
  try {
    const [summary, queueSummary, activeAudit] = await Promise.all([
      scannerManager(req).summary(),
      offlineSyncService(req).summary(),
      getActiveAudit()
    ]);
    res.json({
      ...summary,
      queue: queueSummary,
      activeAudit: publicAudit(activeAudit),
      realtime: true,
      heartbeatSeconds: 10,
      autoReconnect: true
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/discover', auth.optionalAuth, async (req, res) => {
  try {
    const activeAudit = await getActiveAudit();
    const listed = scannerManager(req) ? await scannerManager(req).list() : { online: [], offline: [] };
    res.json(discoveryService(req).discoveryPayload({
      activeAudit: publicAudit(activeAudit),
      knownDevices: listed.online,
      offlineDevices: listed.offline.length,
      autoConnect: true,
      qrPairFallback: true,
      manualIpFallback: true
    }));
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/pairing', auth.requireAuth, async (req, res) => {
  try {
    const activeAudit = await getActiveAudit();
    const result = await qrPairService(req).createPairing({
      user: req.user,
      activeAudit,
      req,
      deviceId: req.query.deviceId
    });
    await AuditLogService.record({
      eventType: 'scanner.qr_pairing_created',
      module: 'scanner-network',
      message: 'Scanner pairing QR generated',
      sessionId: result.sessionId,
      dealerCode: activeAudit && activeAudit.dealerCode,
      auditId: activeAudit && (activeAudit.auditId || activeAudit._id),
      req
    });
    res.json({
      success: true,
      label: 'Secure Scanner Pairing QR',
      value: result.value,
      dataUrl: result.dataUrl,
      pairing: result.pairing,
      sessionId: result.sessionId,
      expiresAt: result.expiresAt,
      activeAudit: publicAudit(activeAudit),
      connectionStatus: activeAudit ? 'Ready for secure scanner pairing' : 'No active audit'
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/connect', auth.optionalAuth, verifyPairingToken, async (req, res) => {
  try {
    const session = req.scannerSession;
    const device = await scannerManager(req).register(
      {
        ...req.body,
        sessionId: clean(req.body.sessionId || (session && session.sessionId)),
        deviceId: clean(req.body.deviceId || (session && session.deviceId)),
        connectionMethod: clean(req.body.connectionMethod || (session && session.connectionMethod))
      },
      { req, user: req.user, sessionId: session && session.sessionId }
    );
    res.json({
      success: true,
      approved: device.approved !== false,
      status: 'connected',
      token: device.deviceId,
      device,
      message: 'Scanner connected to realtime network'
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

router.post('/heartbeat', auth.optionalAuth, verifyPairingToken, async (req, res) => {
  try {
    const device = await scannerManager(req).heartbeat(req.body, { req, user: req.user });
    res.json({ success: true, approved: device.approved !== false, status: device.status, device });
  } catch (error) {
    res.status(error.message === 'Device ID is required' ? 400 : 500).json({ success: false, message: error.message });
  }
});

router.get('/devices', auth.requireAuth, async (req, res) => {
  try {
    const listed = await scannerManager(req).list();
    const summary = await scannerManager(req).summary();
    res.json({ success: true, ...summary, devices: listed.online, oldDevices: listed.offline });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/rename', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const device = await scannerManager(req).rename(req.body.deviceId, req.body.deviceName, req.user);
    res.json({ success: true, device });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.post('/priority', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const device = await scannerManager(req).setPriority(req.body.deviceId, req.body.priority, req.user);
    res.json({ success: true, device });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.post('/disconnect', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const device = await scannerManager(req).disconnect(req.body.deviceId, 'admin', req.user);
    res.json({ success: true, device });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.post('/reconnect', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const deviceId = clean(req.body.deviceId);
    const device = await Device.findOneAndUpdate(
      { deviceId, removedAt: null },
      { reconnectRequestedAt: new Date(), disconnectedBy: 'force-reconnect' },
      { new: true }
    );
    req.io.emit('device:force-reconnect', { deviceId });
    req.io.emit('devices:update', { deviceId, at: new Date() });
    await AuditLogService.record({ eventType: 'scanner.reconnect_requested', module: 'scanner-network', message: 'Reconnect requested', deviceId, user: req.user });
    res.json({ success: true, message: 'Reconnect requested', device });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.post('/remove', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const deviceId = clean(req.body.deviceId);
    const permanent = req.body.permanent === true || req.body.permanent === 'true';
    const device = permanent
      ? await Device.findOneAndDelete({ deviceId })
      : await Device.findOneAndUpdate(
        { deviceId },
        { status: 'offline', removedAt: new Date(), disconnectedAt: new Date(), disconnectedBy: 'removed', scannerStatus: 'disconnected', healthStatus: 'offline' },
        { new: true }
      );
    req.io.emit('device:removed', device || { deviceId });
    req.io.emit('devices:update', { deviceId, at: new Date() });
    await AuditLogService.record({ eventType: 'scanner.removed', module: 'scanner-network', message: permanent ? 'Scanner permanently removed' : 'Scanner removed', deviceId, user: req.user });
    res.json({ success: true, device });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.get('/logs', auth.requireAuth, async (req, res) => {
  try {
    const limit = Math.min(300, Math.max(1, Number(req.query.limit || 100)));
    const filter = {};
    if (req.query.deviceId) filter.deviceId = clean(req.query.deviceId);
    const logs = await ScannerLog.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ success: true, logs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/logs/clear', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const filter = {};
    if (req.body.deviceId) filter.deviceId = clean(req.body.deviceId);
    const result = await ScannerLog.deleteMany(filter);
    req.io.emit('devices:update', { scannerLogsCleared: result.deletedCount || 0, at: new Date() });
    res.json({
      success: true,
      message: 'Scanner connection logs cleared',
      deletedCount: result.deletedCount || 0
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/sessions', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const sessions = await ScannerSession.find({}).sort({ createdAt: -1 }).limit(100).lean();
    res.json({ success: true, sessions });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/offline-queue', auth.optionalAuth, verifyPairingToken, async (req, res) => {
  try {
    const records = Array.isArray(req.body.records) ? req.body.records : Array.isArray(req.body.scans) ? req.body.scans : [req.body];
    const result = await offlineSyncService(req).enqueue(records, {
      deviceId: req.body.deviceId,
      sessionId: req.body.sessionId,
      dealerCode: req.body.dealerCode,
      auditId: req.body.auditId
    });
    if (req.io) req.io.emit('offline-queue:update', { deviceId: req.body.deviceId, queuedCount: result.queuedCount, at: new Date() });
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/offline-queue', auth.requireAuth, async (req, res) => {
  try {
    const rows = await offlineSyncService(req).list(req.query.deviceId, Math.min(300, Number(req.query.limit || 100)));
    const summary = await offlineSyncService(req).summary(req.query.deviceId);
    res.json({ success: true, summary, rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
