const OfflineQueue = require('../models/OfflineQueue');

function clean(value) {
  return String(value || '').trim();
}

class OfflineSyncService {
  async enqueue(records = [], defaults = {}) {
    const items = (Array.isArray(records) ? records : [records]).filter(Boolean);
    const operations = items.map((record) => ({
      updateOne: {
        filter: {
          deviceId: clean(record.deviceId || defaults.deviceId),
          scanId: clean(record.scanId || record.uniqueScanId || record.localId || record.syncKey)
        },
        update: {
          $set: {
            deviceId: clean(record.deviceId || defaults.deviceId),
            sessionId: clean(record.sessionId || defaults.sessionId),
            scanId: clean(record.scanId || record.uniqueScanId || record.localId || record.syncKey),
            partNumber: clean(record.partNumber || record.part).toUpperCase(),
            dealerCode: clean(record.dealerCode || defaults.dealerCode).toUpperCase(),
            auditId: clean(record.auditId || defaults.auditId),
            payload: record,
            status: 'pending',
            lastError: ''
          },
          $setOnInsert: { retryCount: 0 }
        },
        upsert: true
      }
    }));
    if (operations.length) await OfflineQueue.bulkWrite(operations, { ordered: false });
    return { success: true, queuedCount: operations.length };
  }

  async summary(deviceId = '') {
    const filter = deviceId ? { deviceId: clean(deviceId) } : {};
    const [pending, failed, syncing] = await Promise.all([
      OfflineQueue.countDocuments({ ...filter, status: 'pending' }),
      OfflineQueue.countDocuments({ ...filter, status: 'failed' }),
      OfflineQueue.countDocuments({ ...filter, status: 'syncing' })
    ]);
    return { pending, failed, syncing, total: pending + failed + syncing };
  }

  async list(deviceId = '', limit = 100) {
    const filter = deviceId ? { deviceId: clean(deviceId) } : {};
    return OfflineQueue.find(filter).sort({ updatedAt: -1 }).limit(limit).lean();
  }
}

module.exports = OfflineSyncService;
