const Inventory = require('../models/Inventory');
const inventoryRoute = require('../routes/inventory');

function publicScan(scan) {
  return inventoryRoute.publicScan ? inventoryRoute.publicScan(scan) : scan;
}

class SocketRealtimeService {
  constructor(io) {
    this.io = io;
  }

  emit(event, payload) {
    if (this.io) this.io.emit(event, payload);
  }

  async broadcastInventoryChanged(scans = [], options = {}) {
    if (!this.io) return;
    const scanList = Array.isArray(scans) ? scans.filter(Boolean) : [scans].filter(Boolean);
    const publicScans = scanList.map(publicScan);
    publicScans.forEach((scan) => {
      this.io.emit('scan:new', scan);
      this.io.emit('scan:saved', scan);
      this.io.emit('scanData', scan);
      this.io.emit('scanner:activity', {
        deviceId: scan.deviceId || '',
        deviceName: scan.deviceName || '',
        partNumber: scan.partNumber || scan.part || '',
        scanId: scan.scanId || scan.uniqueScanId || '',
        scanType: scan.scanType || scan.type || '',
        timestamp: scan.timestamp || new Date()
      });
    });

    const [stats, recent] = await Promise.all([
      inventoryRoute.dashboardStats({}),
      Inventory.find({}).sort({ timestamp: -1, createdAt: -1 }).limit(12).lean()
    ]);
    const recentPublic = recent.map(publicScan);
    const payload = {
      source: options.source || 'scanner-network',
      scans: publicScans,
      stats,
      recent: recentPublic,
      count: publicScans.length,
      at: new Date()
    };
    this.io.emit('inventory:update', payload);
    this.io.emit('reports:update', payload);
    this.io.emit('dashboard:update', payload);
    this.io.emit('warehouse:feed', payload);
    this.io.emit('scan:count:update', stats);
    this.io.emit('scan:last10:update', recentPublic);
    this.io.emit('stats:update', stats);
    this.io.emit('syncData', payload);
  }

  broadcastDeviceChanged(device, event = 'device:update') {
    if (!this.io) return;
    this.io.emit(event, device);
    this.io.emit('devices:update', { deviceId: device && device.deviceId, at: new Date() });
    this.io.emit('scanner:status', device);
  }
}

module.exports = SocketRealtimeService;
