const crypto = require('crypto');
const Device = require('../models/Device');
const ScannerLog = require('../models/ScannerLog');
const ScannerSession = require('../models/ScannerSession');
const AuditLogService = require('./AuditLogService');

const LIVE_WINDOW_MS = 30 * 1000;

function clean(value) {
  return String(value || '').trim();
}

function numberOrDefault(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function requestIp(reqOrSocket) {
  if (!reqOrSocket) return '';
  const header = reqOrSocket.headers && reqOrSocket.headers['x-forwarded-for'];
  const socketAddress = reqOrSocket.handshake?.address || reqOrSocket.socket?.remoteAddress || reqOrSocket.remoteAddress || '';
  return clean(header || socketAddress).split(',')[0].trim().replace('::ffff:', '');
}

function inferConnectionMethod(payload = {}) {
  const raw = clean(payload.connectionMethod || payload.transport || payload.source || payload.deviceType || payload.model).toLowerCase();
  if (/bluetooth|bt/.test(raw)) return 'bluetooth';
  if (/usb|hid|keyboard/.test(raw)) return 'usb';
  if (/qr|pair/.test(raw)) return 'qr_pair';
  if (/camera|mobile/.test(raw)) return 'mobile_camera';
  if (/pda|android/.test(raw)) return 'android_pda';
  if (/manual|ip/.test(raw)) return 'manual_ip';
  if (/wifi|wi-fi|socket|lan|mobile/.test(raw)) return 'wifi';
  return 'wifi';
}

function inferDeviceType(payload = {}) {
  const raw = clean(payload.deviceType || payload.model || payload.deviceName || payload.source).toLowerCase();
  if (/bluetooth/.test(raw)) return 'bluetooth_scanner';
  if (/usb|hid|keyboard/.test(raw)) return 'usb_scanner';
  if (/pda|android/.test(raw)) return 'android_pda';
  if (/camera/.test(raw)) return 'camera';
  if (/mobile/.test(raw)) return 'mobile';
  if (/wifi|scanner/.test(raw)) return 'wifi_scanner';
  if (/web/.test(raw)) return 'web';
  return 'mobile';
}

function connectionQualityFrom(device = {}) {
  const signal = numberOrDefault(device.signalStrength, 100);
  const lastSeen = device.lastSeen ? new Date(device.lastSeen).getTime() : 0;
  const ageMs = lastSeen ? Date.now() - lastSeen : LIVE_WINDOW_MS * 3;
  const freshness = Math.max(0, 100 - Math.floor(ageMs / 1000) * 4);
  const pendingPenalty = Math.min(40, numberOrDefault(device.pendingCount, 0) * 4);
  return Math.max(0, Math.min(100, Math.round((signal * 0.55) + (freshness * 0.45) - pendingPenalty)));
}

function healthStatus(device = {}) {
  const battery = device.batteryPercent;
  const quality = device.connectionQuality ?? connectionQualityFrom(device);
  if (device.status !== 'online') return 'offline';
  if (battery !== undefined && battery !== null && Number(battery) <= 15) return 'low-battery';
  if (quality < 45 || numberOrDefault(device.failedCount, 0) > 0) return 'warning';
  return 'healthy';
}

class ScannerManager {
  constructor({ io = null, activeAuditProvider = null } = {}) {
    this.io = io;
    this.activeAuditProvider = activeAuditProvider || (async () => null);
  }

  setSocketServer(io) {
    this.io = io;
  }

  async log(event = {}) {
    try {
      await ScannerLog.create(event);
    } catch (error) {
      console.warn('Scanner log write skipped:', error.message);
    }
  }

  async markExpiredOffline() {
    const cutoff = new Date(Date.now() - LIVE_WINDOW_MS);
    const result = await Device.updateMany(
      { status: 'online', lastSeen: { $lt: cutoff }, removedAt: null },
      { $set: { status: 'offline', disconnectedAt: new Date(), disconnectedBy: 'heartbeat-timeout', healthStatus: 'offline' } }
    );
    if (result.modifiedCount && this.io) this.io.emit('devices:update', { offlineCount: result.modifiedCount, at: new Date() });
    return result.modifiedCount || 0;
  }

  async register(payload = {}, context = {}) {
    const activeAudit = await this.activeAuditProvider();
    const deviceId = clean(payload.deviceId || context.deviceId || crypto.randomUUID());
    const connectionMethod = inferConnectionMethod(payload);
    const deviceType = inferDeviceType(payload);
    const signalStrength = Math.max(0, Math.min(100, numberOrDefault(payload.signalStrength ?? payload.signal, 100)));
    const pendingCount = numberOrDefault(payload.pendingCount, 0);
    const failedCount = numberOrDefault(payload.failedCount, 0);
    const update = {
      deviceId,
      deviceName: clean(payload.deviceName || payload.name || 'Scanner Device'),
      model: clean(payload.model || payload.userAgent || ''),
      deviceType,
      approved: payload.approved !== false,
      dealerCode: clean(activeAudit?.dealerCode || payload.dealerCode).toUpperCase(),
      dealerName: clean(activeAudit?.dealerName || payload.dealerName),
      auditId: clean(activeAudit?.auditId || activeAudit?._id || payload.auditId),
      userId: clean(payload.userId || context.user?.id || context.user?._id || ''),
      loginId: clean(payload.loginId || context.user?.username || ''),
      userName: clean(payload.userName || payload.staffName || context.user?.name || context.user?.username || ''),
      staffName: clean(payload.staffName || payload.userName || context.user?.name || ''),
      role: clean(payload.role || context.user?.role || '').toLowerCase(),
      serverUrl: clean(payload.serverUrl || ''),
      ipAddress: clean(payload.ipAddress || requestIp(context.req || context.socket)),
      status: 'online',
      lastSeen: new Date(),
      connectedAt: new Date(),
      appVersion: clean(payload.appVersion || payload.version || ''),
      batteryPercent: payload.batteryPercent ?? payload.battery,
      pendingCount,
      failedCount,
      signalStrength,
      connectionMethod,
      connectionQuality: 100,
      healthStatus: 'healthy',
      scannerStatus: 'ready',
      sessionId: clean(payload.sessionId || context.sessionId || ''),
      lastActivity: new Date(),
      capabilities: Array.isArray(payload.capabilities) ? payload.capabilities : [],
      lowBatteryWarning: Number(payload.batteryPercent ?? payload.battery ?? 100) <= 15,
      disconnectedAt: undefined,
      disconnectedBy: '',
      removedAt: null
    };
    update.connectionQuality = connectionQualityFrom(update);
    update.healthStatus = healthStatus(update);
    const device = await Device.findOneAndUpdate(
      { deviceId },
      update,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    if (update.sessionId) {
      await ScannerSession.findOneAndUpdate(
        { sessionId: update.sessionId },
        { deviceId, deviceName: update.deviceName, deviceType, connectionMethod, status: 'active', pairedAt: new Date(), lastSeen: new Date() },
        { new: true }
      ).catch(() => null);
    }
    await this.log({
      deviceId,
      sessionId: update.sessionId,
      event: 'scanner.connected',
      message: `${update.deviceName} connected`,
      connectionMethod,
      deviceType,
      batteryPercent: update.batteryPercent,
      signalStrength
    });
    await AuditLogService.record({
      eventType: 'scanner.connected',
      module: 'scanner-network',
      message: `${update.deviceName} connected`,
      deviceId,
      sessionId: update.sessionId,
      dealerCode: update.dealerCode,
      auditId: update.auditId,
      user: context.user
    });
    if (this.io) {
      this.io.emit('device:connected', device);
      this.io.emit('scanner:status', device);
      this.io.emit('devices:update', { deviceId, at: new Date() });
    }
    return device;
  }

  async heartbeat(payload = {}, context = {}) {
    const deviceId = clean(payload.deviceId || context.deviceId);
    if (!deviceId) throw new Error('Device ID is required');
    const activeAudit = await this.activeAuditProvider();
    const existing = await Device.findOne({ deviceId }).lean();
    const patch = {
      deviceName: clean(payload.deviceName || existing?.deviceName || 'Scanner Device'),
      model: clean(payload.model || existing?.model || ''),
      deviceType: inferDeviceType(payload.deviceType ? payload : existing || payload),
      connectionMethod: inferConnectionMethod(payload.connectionMethod ? payload : existing || payload),
      dealerCode: clean(activeAudit?.dealerCode || payload.dealerCode || existing?.dealerCode).toUpperCase(),
      dealerName: clean(activeAudit?.dealerName || payload.dealerName || existing?.dealerName),
      auditId: clean(activeAudit?.auditId || activeAudit?._id || payload.auditId || existing?.auditId),
      serverUrl: clean(payload.serverUrl || existing?.serverUrl),
      ipAddress: clean(payload.ipAddress || requestIp(context.req || context.socket) || existing?.ipAddress),
      status: 'online',
      lastSeen: new Date(),
      appVersion: clean(payload.appVersion || payload.version || existing?.appVersion),
      batteryPercent: payload.batteryPercent ?? payload.battery ?? existing?.batteryPercent,
      pendingCount: numberOrDefault(payload.pendingCount, existing?.pendingCount || 0),
      failedCount: numberOrDefault(payload.failedCount, existing?.failedCount || 0),
      syncStatus: activeAudit ? clean(payload.syncStatus || existing?.syncStatus || 'idle') : 'blocked',
      signalStrength: Math.max(0, Math.min(100, numberOrDefault(payload.signalStrength ?? payload.signal, existing?.signalStrength ?? 100))),
      scannerStatus: clean(payload.scannerStatus || 'ready'),
      lastActivity: new Date(),
      lowBatteryWarning: Number(payload.batteryPercent ?? payload.battery ?? existing?.batteryPercent ?? 100) <= 15,
      disconnectedAt: undefined,
      disconnectedBy: '',
      removedAt: null
    };
    patch.connectionQuality = connectionQualityFrom({ ...existing, ...patch });
    patch.healthStatus = healthStatus({ ...existing, ...patch });
    const device = await Device.findOneAndUpdate({ deviceId }, patch, { upsert: true, new: true, setDefaultsOnInsert: true });
    if (this.io) {
      this.io.emit('device:heartbeat', device);
      this.io.emit('scanner:status', device);
      this.io.emit('devices:update', { deviceId, at: new Date() });
    }
    return device;
  }

  async recordScanActivity(scan = {}) {
    const deviceId = clean(scan.deviceId);
    if (!deviceId) return null;
    const patch = {
      lastScanAt: scan.timestamp || new Date(),
      lastScanPartNumber: clean(scan.partNumber || scan.part).toUpperCase(),
      lastActivity: new Date(),
      scannerStatus: 'scanning',
      syncStatus: 'working',
      status: 'online',
      lastSeen: new Date()
    };
    const device = await Device.findOneAndUpdate({ deviceId }, patch, { new: true });
    await this.log({
      deviceId,
      event: 'scanner.scan',
      message: `Scan received: ${patch.lastScanPartNumber || '-'}`,
      scanId: clean(scan.scanId || scan.uniqueScanId),
      partNumber: patch.lastScanPartNumber,
      metadata: { dealerCode: scan.dealerCode, scanType: scan.scanType || scan.type }
    });
    if (this.io && device) {
      this.io.emit('scanner:activity', {
        deviceId,
        partNumber: patch.lastScanPartNumber,
        scanId: scan.scanId || scan.uniqueScanId || '',
        timestamp: patch.lastScanAt
      });
      this.io.emit('scanner:status', device);
    }
    return device;
  }

  async list() {
    await this.markExpiredOffline();
    const cutoff = new Date(Date.now() - LIVE_WINDOW_MS);
    const [online, offline] = await Promise.all([
      Device.find({ removedAt: null, status: 'online', lastSeen: { $gte: cutoff } }).sort({ scannerPriority: -1, lastSeen: -1 }).lean(),
      Device.find({ removedAt: null, $or: [{ status: 'offline' }, { lastSeen: { $lt: cutoff } }] }).sort({ lastSeen: -1 }).limit(100).lean()
    ]);
    return {
      online: online.map((device) => this.publicDevice(device)),
      offline: offline.map((device) => this.publicDevice(device))
    };
  }

  publicDevice(device = {}) {
    const connectionQuality = connectionQualityFrom(device);
    return {
      ...device,
      connectionQuality,
      healthStatus: healthStatus({ ...device, connectionQuality }),
      lowBatteryWarning: Number(device.batteryPercent ?? 100) <= 15
    };
  }

  async summary() {
    await this.markExpiredOffline();
    const cutoff = new Date(Date.now() - LIVE_WINDOW_MS);
    const [onlineDevices, offlineDevices, lowBatteryDevices] = await Promise.all([
      Device.find({ removedAt: null, status: 'online', lastSeen: { $gte: cutoff } }).lean(),
      Device.countDocuments({ removedAt: null, $or: [{ status: 'offline' }, { lastSeen: { $lt: cutoff } }] }),
      Device.find({ removedAt: null, status: 'online', batteryPercent: { $lte: 15 } }).lean()
    ]);
    const activeScanners = onlineDevices.filter((device) => device.deviceType !== 'web');
    return {
      success: true,
      connectedDevices: onlineDevices.length,
      activeScannerCount: activeScanners.length,
      offlineDevices,
      lowBatteryCount: lowBatteryDevices.length,
      pendingSyncCount: onlineDevices.reduce((sum, device) => sum + numberOrDefault(device.pendingCount, 0), 0),
      bluetoothOnline: activeScanners.some((device) => device.connectionMethod === 'bluetooth'),
      wifiOnline: activeScanners.some((device) => ['wifi', 'android_pda', 'mobile_camera', 'qr_pair'].includes(device.connectionMethod)),
      usbOnline: activeScanners.some((device) => device.connectionMethod === 'usb'),
      lastActivityAt: onlineDevices.map((device) => device.lastActivity || device.lastSeen).filter(Boolean).sort().pop() || null,
      devices: onlineDevices.map((device) => this.publicDevice(device)),
      lowBatteryDevices: lowBatteryDevices.map((device) => this.publicDevice(device))
    };
  }

  async rename(deviceId, deviceName, user) {
    const device = await Device.findOneAndUpdate({ deviceId: clean(deviceId), removedAt: null }, { deviceName: clean(deviceName) }, { new: true });
    if (!device) throw new Error('Device not found');
    await AuditLogService.record({ eventType: 'scanner.renamed', module: 'scanner-network', message: `Scanner renamed to ${device.deviceName}`, deviceId, user });
    if (this.io) this.io.emit('devices:update', { deviceId, at: new Date() });
    return device;
  }

  async setPriority(deviceId, priority, user) {
    const device = await Device.findOneAndUpdate({ deviceId: clean(deviceId), removedAt: null }, { scannerPriority: numberOrDefault(priority, 0) }, { new: true });
    if (!device) throw new Error('Device not found');
    await AuditLogService.record({ eventType: 'scanner.priority', module: 'scanner-network', message: `Scanner priority set to ${device.scannerPriority}`, deviceId, user });
    if (this.io) this.io.emit('devices:update', { deviceId, at: new Date() });
    return device;
  }

  async disconnect(deviceId, reason = 'admin', user = null) {
    const device = await Device.findOneAndUpdate(
      { deviceId: clean(deviceId) },
      { status: 'offline', scannerStatus: 'disconnected', healthStatus: 'offline', disconnectedAt: new Date(), disconnectedBy: reason },
      { new: true }
    );
    await AuditLogService.record({ eventType: 'scanner.disconnected', module: 'scanner-network', message: `Scanner disconnected: ${reason}`, deviceId, user });
    if (this.io) {
      this.io.emit('device:disconnected', device || { deviceId, status: 'offline' });
      this.io.emit('devices:update', { deviceId, at: new Date() });
    }
    return device;
  }
}

module.exports = ScannerManager;
