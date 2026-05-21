const crypto = require('crypto');
const QRCode = require('qrcode');
const ScannerSession = require('../models/ScannerSession');
const { serverInfo } = require('../utils/network');

function clean(value) {
  return String(value || '').trim();
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

class QRPairService {
  constructor({ portProvider } = {}) {
    this.portProvider = portProvider || (() => process.env.PORT || 3001);
  }

  async createPairing({ user = {}, activeAudit = null, req = null, ttlMinutes = 30, deviceId = '' } = {}) {
    const port = this.portProvider();
    const info = serverInfo(port);
    const sessionId = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
    const audit = activeAudit || {};
    const pairing = {
      app: 'daksh-inventory-v2',
      mode: 'scanner-pairing',
      serverIp: info.ip,
      port: info.port,
      serverUrl: info.serverUrl,
      healthUrl: info.healthUrl,
      connectUrl: info.connectUrl,
      syncUrl: info.syncUrl,
      socketUrl: info.serverUrl,
      authToken: token,
      deviceId: clean(deviceId) || `PAIR-${Date.now()}`,
      sessionId,
      dealerCode: clean(audit.dealerCode).toUpperCase(),
      dealerName: clean(audit.dealerName),
      auditId: clean(audit.auditId || audit._id),
      userId: clean(user.id || user._id || user.username),
      userName: clean(user.name || user.username),
      issuedAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
      heartbeatSeconds: 10,
      reconnect: true
    };
    await ScannerSession.create({
      sessionId,
      deviceId: pairing.deviceId,
      deviceName: 'Unpaired Scanner',
      deviceType: 'unknown',
      connectionMethod: 'qr_pair',
      tokenHash: tokenHash(token),
      tokenPreview: token.slice(0, 8),
      serverUrl: info.serverUrl,
      ipAddress: req && req.socket ? String(req.socket.remoteAddress || '').replace('::ffff:', '') : '',
      userId: pairing.userId,
      userName: pairing.userName,
      dealerCode: pairing.dealerCode,
      auditId: pairing.auditId,
      status: 'pairing',
      expiresAt,
      capabilities: ['socket.io', 'rest-sync', 'offline-queue', 'auto-reconnect']
    });
    const value = JSON.stringify(pairing);
    const dataUrl = await QRCode.toDataURL(value, { margin: 1, width: 280 });
    return { pairing, value, dataUrl, sessionId, expiresAt };
  }

  async verifyToken(token) {
    const session = await ScannerSession.findOne({
      tokenHash: tokenHash(token),
      status: { $in: ['pairing', 'active'] },
      expiresAt: { $gt: new Date() }
    });
    return session;
  }
}

module.exports = QRPairService;
