const mongoose = require('mongoose');

const scannerSessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, trim: true, index: true },
    deviceId: { type: String, trim: true, default: '', index: true },
    deviceName: { type: String, trim: true, default: 'Scanner Device' },
    deviceType: { type: String, trim: true, default: 'unknown', index: true },
    connectionMethod: { type: String, trim: true, default: 'unknown', index: true },
    tokenHash: { type: String, trim: true, default: '', index: true },
    tokenPreview: { type: String, trim: true, default: '' },
    serverUrl: { type: String, trim: true, default: '' },
    ipAddress: { type: String, trim: true, default: '' },
    userId: { type: String, trim: true, default: '', index: true },
    userName: { type: String, trim: true, default: '' },
    dealerCode: { type: String, trim: true, uppercase: true, default: '', index: true },
    auditId: { type: String, trim: true, default: '', index: true },
    status: { type: String, enum: ['pairing', 'active', 'expired', 'revoked'], default: 'pairing', index: true },
    pairedAt: { type: Date },
    expiresAt: { type: Date, index: true },
    lastSeen: { type: Date },
    capabilities: { type: [String], default: [] },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

module.exports = mongoose.model('ScannerSession', scannerSessionSchema);
