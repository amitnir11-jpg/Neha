const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    eventType: { type: String, trim: true, index: true, default: 'system.event' },
    module: { type: String, trim: true, index: true, default: 'system' },
    severity: { type: String, enum: ['info', 'warning', 'error', 'security'], default: 'info', index: true },
    message: { type: String, trim: true, default: '' },
    actorId: { type: String, trim: true, default: '', index: true },
    actorName: { type: String, trim: true, default: '' },
    actorRole: { type: String, trim: true, default: '' },
    deviceId: { type: String, trim: true, default: '', index: true },
    sessionId: { type: String, trim: true, default: '', index: true },
    ipAddress: { type: String, trim: true, default: '' },
    userAgent: { type: String, trim: true, default: '' },
    dealerCode: { type: String, trim: true, uppercase: true, default: '', index: true },
    auditId: { type: String, trim: true, default: '', index: true },
    scanId: { type: String, trim: true, default: '', index: true },
    partNumber: { type: String, trim: true, uppercase: true, default: '', index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

module.exports = mongoose.model('AuditLog', auditLogSchema);
