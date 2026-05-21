const mongoose = require('mongoose');
const { randomUUID } = require('crypto');

const offlineQueueSchema = new mongoose.Schema(
  {
    queueId: { type: String, required: true, unique: true, default: randomUUID, trim: true, index: true },
    deviceId: { type: String, trim: true, default: '', index: true },
    sessionId: { type: String, trim: true, default: '', index: true },
    scanId: { type: String, trim: true, default: '', index: true },
    partNumber: { type: String, trim: true, uppercase: true, default: '', index: true },
    dealerCode: { type: String, trim: true, uppercase: true, default: '', index: true },
    auditId: { type: String, trim: true, default: '', index: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['pending', 'syncing', 'synced', 'failed'], default: 'pending', index: true },
    retryCount: { type: Number, default: 0 },
    lastError: { type: String, trim: true, default: '' },
    nextRetryAt: { type: Date, index: true },
    syncedAt: { type: Date }
  },
  { timestamps: true }
);

module.exports = mongoose.model('OfflineQueue', offlineQueueSchema);
