const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema(
  {
    deviceId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true
    },
    deviceName: {
      type: String,
      trim: true,
      default: 'Scanner Device'
    },
    model: {
      type: String,
      trim: true,
      default: ''
    },
    deviceType: {
      type: String,
      enum: ['mobile', 'web', 'android_pda', 'wifi_scanner', 'bluetooth_scanner', 'usb_scanner', 'camera', 'pda', 'unknown'],
      default: 'unknown',
      index: true
    },
    connectionMethod: {
      type: String,
      enum: ['wifi', 'bluetooth', 'usb', 'android_pda', 'mobile_camera', 'qr_pair', 'manual_ip', 'websocket', 'unknown'],
      default: 'unknown',
      index: true
    },
    scannerPriority: {
      type: Number,
      default: 0,
      index: true
    },
    approved: {
      type: Boolean,
      default: true,
      index: true
    },
    dealerCode: {
      type: String,
      trim: true,
      uppercase: true,
      default: '',
      index: true
    },
    dealerName: {
      type: String,
      trim: true,
      default: ''
    },
    auditId: {
      type: String,
      trim: true,
      default: '',
      index: true
    },
    userId: {
      type: String,
      trim: true,
      default: '',
      index: true
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
    staffName: {
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
    serverUrl: {
      type: String,
      trim: true,
      default: ''
    },
    ipAddress: {
      type: String,
      trim: true,
      default: ''
    },
    status: {
      type: String,
      enum: ['online', 'offline'],
      default: 'online',
      index: true
    },
    lastSeen: {
      type: Date,
      default: Date.now,
      index: true
    },
    connectedAt: {
      type: Date
    },
    lastSyncTime: {
      type: Date
    },
    syncStatus: {
      type: String,
      enum: ['working', 'failed', 'idle', 'blocked'],
      default: 'idle'
    },
    scannerStatus: {
      type: String,
      enum: ['ready', 'scanning', 'syncing', 'blocked', 'disconnected', 'error'],
      default: 'ready',
      index: true
    },
    healthStatus: {
      type: String,
      enum: ['healthy', 'warning', 'low-battery', 'offline', 'error'],
      default: 'healthy',
      index: true
    },
    appVersion: {
      type: String,
      trim: true,
      default: ''
    },
    batteryPercent: {
      type: Number,
      min: 0,
      max: 100
    },
    signalStrength: {
      type: Number,
      min: 0,
      max: 100,
      default: 100
    },
    connectionQuality: {
      type: Number,
      min: 0,
      max: 100,
      default: 100
    },
    lowBatteryWarning: {
      type: Boolean,
      default: false,
      index: true
    },
    lastScanAt: {
      type: Date,
      index: true
    },
    lastScanPartNumber: {
      type: String,
      trim: true,
      uppercase: true,
      default: ''
    },
    lastActivity: {
      type: Date,
      index: true
    },
    sessionId: {
      type: String,
      trim: true,
      default: '',
      index: true
    },
    capabilities: {
      type: [String],
      default: []
    },
    lastError: {
      type: String,
      trim: true,
      default: ''
    },
    reconnectRequestedAt: {
      type: Date
    },
    removedAt: {
      type: Date
    },
    pendingCount: {
      type: Number,
      default: 0
    },
    failedCount: {
      type: Number,
      default: 0
    },
    disconnectedAt: {
      type: Date
    },
    disconnectedBy: {
      type: String,
      trim: true,
      default: ''
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('Device', deviceSchema);
