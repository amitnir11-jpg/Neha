const mongoose = require('mongoose');

const duplicateScanLogSchema = new mongoose.Schema(
  {
    scanId: { type: String, trim: true, default: '', index: true },
    uniqueScanId: { type: String, trim: true, default: '', index: true },
    qrFingerprint: { type: String, trim: true, default: '', index: true },
    existingScanId: { type: String, trim: true, default: '' },
    partNumber: { type: String, trim: true, uppercase: true, default: '', index: true },
    dealerCode: { type: String, trim: true, uppercase: true, default: '', index: true },
    auditId: { type: String, trim: true, default: '', index: true },
    binLocation: { type: String, trim: true, uppercase: true, default: '' },
    scanType: { type: String, trim: true, uppercase: true, default: '' },
    deviceId: { type: String, trim: true, default: '', index: true },
    deviceName: { type: String, trim: true, default: '' },
    userId: { type: String, trim: true, default: '', index: true },
    userName: { type: String, trim: true, default: '' },
    role: { type: String, trim: true, lowercase: true, default: '' },
    loginId: { type: String, trim: true, default: '', index: true },
    rawScan: { type: String, default: '' },
    rawBarcode: { type: String, default: '' },
    rawQR: { type: String, default: '' },
    rawUpi: { type: String, default: '' },
    firstScannedBy: { type: String, trim: true, default: '' },
    firstScanTime: { type: Date },
    firstDeviceId: { type: String, trim: true, default: '' },
    firstDeviceName: { type: String, trim: true, default: '' },
    firstBin: { type: String, trim: true, uppercase: true, default: '' },
    duplicateScannedBy: { type: String, trim: true, default: '' },
    duplicateScanTime: { type: Date, default: Date.now },
    duplicateDeviceId: { type: String, trim: true, default: '' },
    duplicateDeviceName: { type: String, trim: true, default: '' },
    duplicateBin: { type: String, trim: true, uppercase: true, default: '' },
    source: { type: String, trim: true, default: '' },
    reason: { type: String, trim: true, default: 'Duplicate QR/UPI' },
    timestamp: { type: Date, default: Date.now, index: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('DuplicateScanLog', duplicateScanLogSchema);
