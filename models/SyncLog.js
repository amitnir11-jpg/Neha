const mongoose = require('mongoose');

const syncLogSchema = new mongoose.Schema(
  {
    deviceId: { type: String, trim: true, index: true },
    dealerCode: { type: String, trim: true, uppercase: true, index: true },
    auditId: { type: String, trim: true, index: true },
    route: { type: String, trim: true },
    batchId: { type: String, trim: true, default: '' },
    status: { type: String, enum: ['success', 'failed', 'partial', 'rejected'], index: true },
    receivedCount: { type: Number, default: 0 },
    insertedCount: { type: Number, default: 0 },
    duplicateCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    invalidCleanedCount: { type: Number, default: 0 },
    message: { type: String, trim: true, default: '' },
    diagnostics: { type: Object, default: {} },
    logs: { type: Array, default: [] }
  },
  { timestamps: true }
);

module.exports = mongoose.model('SyncLog', syncLogSchema);
