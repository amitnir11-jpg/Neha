const syncRoutes = require('../routes/sync');
const FailedScan = require('../models/FailedScan');

function clean(value) {
  return String(value || '').trim();
}

class InventorySyncService {
  constructor({ io, app, scannerManager, realtime }) {
    this.io = io;
    this.app = app;
    this.scannerManager = scannerManager;
    this.realtime = realtime;
  }

  async processScan(payload = {}, user = null) {
    const normalized = syncRoutes.normalizeScan(payload);
    const result = await syncRoutes.saveNormalizedScan(normalized, { io: this.io, app: this.app, user });
    if (result.status === 'synced' && result.scan) {
      if (this.scannerManager) await this.scannerManager.recordScanActivity(result.scan);
      if (this.realtime) await this.realtime.broadcastInventoryChanged([result.scan], { source: 'inventory-sync-service' });
    }
    if (result.status === 'failed') {
      await FailedScan.create({
        deviceId: clean(normalized.deviceId),
        sessionId: clean(normalized.sessionId),
        scanId: clean(normalized.uniqueScanId || normalized.scanId),
        partNumber: clean(normalized.partNumber).toUpperCase(),
        dealerCode: clean(normalized.dealerCode).toUpperCase(),
        auditId: clean(normalized.auditId),
        reason: result.error || 'Scan failed',
        payload: normalized
      }).catch(() => null);
    }
    return result;
  }
}

module.exports = InventorySyncService;
