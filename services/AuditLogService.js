const AuditLog = require('../models/AuditLog');

function clean(value) {
  return String(value || '').trim();
}

function requestIp(req) {
  if (!req) return '';
  return clean(req.headers && req.headers['x-forwarded-for'])
    .split(',')[0]
    .trim()
    .replace('::ffff:', '') || clean(req.socket && req.socket.remoteAddress).replace('::ffff:', '');
}

class AuditLogService {
  static async record(event = {}) {
    try {
      const req = event.req;
      const user = event.user || (req && req.user) || {};
      return await AuditLog.create({
        eventType: clean(event.eventType || event.event || 'system.event'),
        module: clean(event.module || 'system'),
        severity: clean(event.severity || 'info').toLowerCase(),
        message: clean(event.message),
        actorId: clean(event.actorId || user.id || user._id || user.username),
        actorName: clean(event.actorName || user.name || user.username),
        actorRole: clean(event.actorRole || user.role),
        deviceId: clean(event.deviceId),
        sessionId: clean(event.sessionId),
        ipAddress: clean(event.ipAddress || requestIp(req)),
        userAgent: clean(event.userAgent || (req && req.headers && req.headers['user-agent'])),
        dealerCode: clean(event.dealerCode).toUpperCase(),
        auditId: clean(event.auditId),
        scanId: clean(event.scanId),
        partNumber: clean(event.partNumber).toUpperCase(),
        metadata: event.metadata || {}
      });
    } catch (error) {
      console.warn('Audit log write skipped:', error.message);
      return null;
    }
  }
}

module.exports = AuditLogService;
