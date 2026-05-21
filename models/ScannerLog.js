const mongoose = require('mongoose');

const scannerLogSchema = new mongoose.Schema(
  {
    deviceId: { type: String, trim: true, default: '', index: true },
    sessionId: { type: String, trim: true, default: '', index: true },
    level: { type: String, enum: ['info', 'warning', 'error', 'security'], default: 'info', index: true },
    event: { type: String, trim: true, index: true, default: 'scanner.event' },
    message: { type: String, trim: true, default: '' },
    connectionMethod: { type: String, trim: true, default: '' },
    deviceType: { type: String, trim: true, default: '' },
    batteryPercent: { type: Number, min: 0, max: 100 },
    signalStrength: { type: Number, min: 0, max: 100 },
    connectionQuality: { type: Number, min: 0, max: 100 },
    scanId: { type: String, trim: true, default: '', index: true },
    partNumber: { type: String, trim: true, uppercase: true, default: '', index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

module.exports = mongoose.model('ScannerLog', scannerLogSchema);
