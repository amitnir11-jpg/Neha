const mongoose = require('mongoose');

const skewEventSchema = new mongoose.Schema(
  {
    deviceId: { type: String, trim: true, index: true },
    dealerCode: { type: String, trim: true, uppercase: true, index: true },
    userId: { type: String, trim: true, index: true },
    batchId: { type: String, trim: true, index: true, default: '' },
    serverTime: { type: Date, default: Date.now, index: true },
    deviceTime: { type: Date },
    mobileReceivedTimeUtc: { type: String, trim: true, default: '' },
    skewMs: { type: Number, default: 0, index: true },
    status: { type: String, trim: true, default: 'detected' },
    eventType: { type: String, trim: true, default: 'sync_detected' },
    message: { type: String, trim: true, default: '' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('SkewEvent', skewEventSchema);
