const mongoose = require('mongoose');
const { randomUUID } = require('crypto');

const failedScanSchema = new mongoose.Schema(
  {
    failedScanId: { type: String, required: true, unique: true, default: randomUUID, trim: true, index: true },
    deviceId: { type: String, trim: true, default: '', index: true },
    sessionId: { type: String, trim: true, default: '', index: true },
    scanId: { type: String, trim: true, default: '', index: true },
    partNumber: { type: String, trim: true, uppercase: true, default: '', index: true },
    dealerCode: { type: String, trim: true, uppercase: true, default: '', index: true },
    auditId: { type: String, trim: true, default: '', index: true },
    reason: { type: String, trim: true, default: '' },
    stage: { type: String, trim: true, default: 'validation' },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    resolved: { type: Boolean, default: false, index: true },
    resolvedAt: { type: Date }
  },
  { timestamps: true }
);

module.exports = mongoose.model('FailedScan', failedScanSchema);
