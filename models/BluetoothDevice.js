const mongoose = require('mongoose');

const bluetoothDeviceSchema = new mongoose.Schema(
  {
    deviceName: {
      type: String,
      trim: true,
      default: 'Bluetooth Scanner'
    },
    deviceId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true
    },
    macAddress: {
      type: String,
      trim: true,
      default: '',
      index: true
    },
    approvalStatus: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'blocked'],
      default: 'pending',
      index: true
    },
    connectionStatus: {
      type: String,
      enum: ['connected', 'disconnected', 'error', 'pairing'],
      default: 'pairing',
      index: true
    },
    assignedUserId: {
      type: String,
      trim: true,
      default: '',
      index: true
    },
    assignedUserName: {
      type: String,
      trim: true,
      default: ''
    },
    assignedMode: {
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
    lastScanValue: {
      type: String,
      trim: true,
      default: ''
    },
    lastScanAt: {
      type: Date,
      index: true
    },
    lastError: {
      type: String,
      trim: true,
      default: ''
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true
    },
    hidIdentityLimited: {
      type: Boolean,
      default: true
    },
    mappingType: {
      type: String,
      trim: true,
      default: 'keyboard_hid'
    },
    mappingValue: {
      type: String,
      trim: true,
      default: ''
    },
    mappingSessionId: {
      type: String,
      trim: true,
      default: ''
    },
    lastConnectedAt: {
      type: Date
    },
    lastDisconnectedAt: {
      type: Date
    }
  },
  {
    timestamps: true
  }
);

bluetoothDeviceSchema.index({ approvalStatus: 1, connectionStatus: 1 });
bluetoothDeviceSchema.index({ assignedUserId: 1, assignedMode: 1 });
bluetoothDeviceSchema.index({ dealerCode: 1, lastScanAt: -1 });

module.exports = mongoose.model('BluetoothDevice', bluetoothDeviceSchema);
