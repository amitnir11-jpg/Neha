const mongoose = require('mongoose');

const bluetoothScanLogSchema = new mongoose.Schema(
  {
    transactionId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true
    },
    deviceId: {
      type: String,
      trim: true,
      default: '',
      index: true
    },
    deviceName: {
      type: String,
      trim: true,
      default: ''
    },
    userId: {
      type: String,
      trim: true,
      default: '',
      index: true
    },
    userName: {
      type: String,
      trim: true,
      default: ''
    },
    scanMode: {
      type: String,
      enum: ['Inward', 'Outward', 'Verification', 'Any'],
      default: 'Any',
      index: true
    },
    dealerCode: {
      type: String,
      trim: true,
      uppercase: true,
      default: '',
      index: true
    },
    scanValue: {
      type: String,
      trim: true,
      default: ''
    },
    scanTime: {
      type: Date,
      default: Date.now,
      index: true
    },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'duplicate', 'rejected', 'blocked', 'error', 'test'],
      default: 'pending',
      index: true
    },
    errorMessage: {
      type: String,
      trim: true,
      default: ''
    },
    source: {
      type: String,
      trim: true,
      default: 'Bluetooth Scanner'
    },
    inventoryScanId: {
      type: String,
      trim: true,
      default: '',
      index: true
    }
  },
  {
    timestamps: true
  }
);

bluetoothScanLogSchema.index({ deviceId: 1, scanTime: -1 });
bluetoothScanLogSchema.index({ dealerCode: 1, scanMode: 1, scanTime: -1 });

module.exports = mongoose.model('BluetoothScanLog', bluetoothScanLogSchema);
