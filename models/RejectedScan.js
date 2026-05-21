const mongoose = require('mongoose');

const rejectedScanSchema = new mongoose.Schema(
  {
    dateTime: {
      type: Date,
      default: Date.now,
      index: true
    },
    dealerCode: {
      type: String,
      trim: true,
      uppercase: true,
      index: true
    },
    userId: {
      type: String,
      trim: true,
      default: ''
    },
    loginId: {
      type: String,
      trim: true,
      default: ''
    },
    userName: {
      type: String,
      trim: true,
      default: ''
    },
    role: {
      type: String,
      trim: true,
      lowercase: true,
      default: ''
    },
    deviceId: {
      type: String,
      trim: true,
      default: ''
    },
    deviceName: {
      type: String,
      trim: true,
      default: ''
    },
    scanMode: {
      type: String,
      trim: true,
      default: 'Manual',
      index: true
    },
    scanType: {
      type: String,
      trim: true,
      uppercase: true,
      default: ''
    },
    rawScannedValue: {
      type: String,
      trim: true,
      default: ''
    },
    extractedPartNumber: {
      type: String,
      trim: true,
      uppercase: true,
      index: true
    },
    binLocation: {
      type: String,
      trim: true,
      uppercase: true,
      default: ''
    },
    reason: {
      type: String,
      trim: true,
      default: 'Part Not Found In Master'
    },
    status: {
      type: String,
      trim: true,
      uppercase: true,
      default: 'REJECTED',
      index: true
    },
    originalScanId: {
      type: String,
      trim: true,
      default: '',
      index: true
    },
    originalInventoryId: {
      type: mongoose.Schema.Types.ObjectId,
      index: true
    },
    sourceRoute: {
      type: String,
      trim: true,
      default: ''
    }
  },
  {
    timestamps: true
  }
);

rejectedScanSchema.index(
  { originalScanId: 1 },
  {
    unique: true,
    partialFilterExpression: { originalScanId: { $type: 'string', $gt: '' } }
  }
);

module.exports = mongoose.model('RejectedScan', rejectedScanSchema);
