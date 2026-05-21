const mongoose = require('mongoose');

const verificationLogSchema = new mongoose.Schema(
  {
    partNumber: { type: String, trim: true, uppercase: true, index: true },
    extractedPartNumber: { type: String, trim: true, uppercase: true, default: '', index: true },
    rawScannedValue: { type: String, trim: true, default: '' },
    found: { type: Boolean, default: false },
    dealerCode: { type: String, trim: true, uppercase: true, index: true },
    deviceId: { type: String, trim: true, default: '' },
    userId: { type: String, trim: true, default: '', index: true },
    loginId: { type: String, trim: true, default: '', index: true },
    scannedBy: { type: String, trim: true, default: '' },
    staffName: { type: String, trim: true, default: '' },
    scanType: { type: String, trim: true, uppercase: true, default: '', index: true },
    source: { type: String, trim: true, lowercase: true, default: '', index: true },
    binLocation: { type: String, trim: true, uppercase: true, default: '' },
    reason: { type: String, trim: true, default: '' },
    time: { type: Date, default: Date.now, index: true },
    status: { type: String, trim: true, lowercase: true, default: 'invalid', index: true },
    repeatCount: { type: Number, default: 1, min: 1 },
    mappedPartNumber: { type: String, trim: true, uppercase: true, default: '' },
    correctedAt: { type: Date },
    ignoredAt: { type: Date },
    actionBy: { type: String, trim: true, default: '' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('VerificationLog', verificationLogSchema);
