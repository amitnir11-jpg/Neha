const Inventory = require('../models/Inventory');
const ScanAuditLog = require('../models/ScanAuditLog');
const AuditLog = require('../models/AuditLog');
const { activeInventoryValue, remainingQtyValue } = require('../utils/inventoryMovementState');
const { invalidateCache } = require('../utils/safeCache');

function clean(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function clone(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function adminError(message = 'Admin permission required.') {
  const error = new Error(message);
  error.status = 403;
  return error;
}

function assertAdmin(req) {
  if (!req || !req.user || String(req.user.role || '').toLowerCase() !== 'admin') throw adminError();
}

function requireReason(body = {}) {
  const reason = clean(body.reason);
  const remarks = clean(body.remarks);
  if (!reason) {
    const error = new Error('A reason is required for every scan modification.');
    error.status = 400;
    throw error;
  }
  if (reason.toLowerCase() === 'other' && !remarks) {
    const error = new Error('Remarks are required when the reason is Other.');
    error.status = 400;
    throw error;
  }
  return { reason, remarks };
}

function modificationBody(req, options = {}) {
  const body = { ...((req && req.body) || {}) };
  ['reason', 'remarks'].forEach((field) => {
    if (options[field] !== undefined) body[field] = options[field];
  });
  return body;
}

function actorFromRequest(req = {}) {
  const user = req.user || {};
  return {
    userId: clean(user.id || user._id),
    username: clean(user.username || user.loginId).toLowerCase(),
    name: clean(user.name),
    role: clean(user.role).toLowerCase() || 'admin'
  };
}

function actorFields(actor, modifiedAt) {
  return {
    lastModifiedBy: actor.userId || actor.username || actor.name,
    lastModifiedByUsername: actor.username,
    lastModifiedByName: actor.name,
    lastModifiedByRole: actor.role,
    lastModifiedAt: modifiedAt,
    updatedAt: modifiedAt
  };
}

function updateWithActor(update, fields) {
  if (Array.isArray(update)) return update.concat([{ $set: fields }]);
  const hasOperators = Object.keys(update || {}).some((key) => key.startsWith('$'));
  if (!hasOperators) return { $set: { ...(update || {}), ...fields } };
  return { ...(update || {}), $set: { ...((update && update.$set) || {}), ...fields } };
}

function scanIdentifier(row = {}) {
  return clean(row.uniqueScanId || row.scanId || row.id || row._id);
}

function scanIdFilter(scanId) {
  const value = clean(scanId);
  return {
    $or: [
      { _id: value },
      { id: value },
      { uniqueScanId: value },
      { scanId: value },
      { syncKey: value },
      { clientScanId: value }
    ]
  };
}

function auditPayload(action, before, after, req, reason, remarks) {
  const actor = actorFromRequest(req);
  return {
    action: String(action || 'UPDATE').toUpperCase(),
    scanId: scanIdentifier(after || before),
    dealerCode: clean((after || before || {}).dealerCode).toUpperCase(),
    dealerName: clean((after || before || {}).dealerName),
    partNumber: clean((after || before || {}).partNumber || (after || before || {}).part).toUpperCase(),
    performedByUserId: actor.userId,
    performedByUsername: actor.username,
    performedByName: actor.name,
    performedByRole: actor.role,
    reason,
    remarks: remarks || '',
    oldData: clone(before),
    newData: clone(after),
    timestamp: new Date(),
    ipAddress: clean(req?.ip || req?.headers?.['x-forwarded-for']),
    deviceId: clean(req?.body?.deviceId || req?.headers?.['x-device-id'] || (after || before || {}).deviceId),
    userAgent: clean(req?.headers?.['user-agent'])
  };
}

function invalidatedScope(row = {}) {
  return {
    dealerCode: row.dealerCode || '',
    auditId: row.auditId || ''
  };
}

function invalidateScanCaches(rows = []) {
  const scopes = rows.length ? rows : [{}];
  scopes.forEach((row) => invalidateCache({
    tags: ['scan', 'dashboard', 'report', 'reconciliation', 'mobile', 'stock'],
    scope: invalidatedScope(row)
  }));
}

function emitScanMutation(req, event, payload, rows = []) {
  if (!req?.io || typeof req.io.emit !== 'function') return;
  req.io.emit(event, payload);
  req.io.emit('stats:update');
  req.io.emit('reports:update', payload);
  req.io.emit('inventory:update', payload);
  rows.forEach((row) => req.io.emit('scan:modified', { ...payload, dealerCode: row.dealerCode || '', auditId: row.auditId || '' }));
}

async function saveAuditOrRollback(before, after, req, reason, remarks, action, update) {
  try {
    await ScanAuditLog.create(auditPayload(action, before, after, req, reason, remarks));
  } catch (auditError) {
    const actor = actorFromRequest(req);
    const row = after || before || {};
    try {
      await AuditLog.create({
        eventType: `scan.${String(action || 'UPDATE').toLowerCase()}.audit_fallback`,
        module: 'inventory',
        severity: 'warning',
        message: `Scan ${String(action || 'update').toLowerCase()} recorded using fallback audit storage`,
        actorId: actor.userId || actor.username,
        actorName: actor.name || actor.username,
        actorRole: actor.role,
        deviceId: clean(req?.body?.deviceId || req?.headers?.['x-device-id'] || row.deviceId),
        ipAddress: clean(req?.ip || req?.headers?.['x-forwarded-for']),
        userAgent: clean(req?.headers?.['user-agent']),
        dealerCode: clean(row.dealerCode).toUpperCase(),
        auditId: clean(row.auditId),
        scanId: scanIdentifier(row),
        partNumber: clean(row.partNumber || row.part).toUpperCase(),
        metadata: {
          reason,
          remarks: remarks || '',
          action: String(action || 'UPDATE').toUpperCase(),
          oldData: clone(before),
          newData: clone(after),
          auditStorageError: clean(auditError.message)
        }
      });
      console.warn('Scan audit log used fallback storage:', auditError.message);
      return;
    } catch (fallbackError) {
      auditError.fallbackError = fallbackError;
    }
    try {
      await Inventory.findByIdAndUpdate(before._id || before.id, { $set: before }, { new: true });
    } catch (rollbackError) {
      auditError.rollbackError = rollbackError;
    }
    const error = new Error('Scan change was rolled back because the audit log could not be created.');
    error.status = 500;
    error.cause = auditError;
    error.update = update;
    throw error;
  }
}

async function updateScan(scan, update, req, options = {}) {
  assertAdmin(req);
  if (scan && (scan.isDeleted === true || clean(scan.status).toUpperCase() === 'DELETED')) {
    const error = new Error('Deleted scans must be restored before they can be modified.');
    error.status = 409;
    throw error;
  }
  const { reason, remarks } = requireReason(modificationBody(req, options));
  const before = clone(scan);
  const actor = actorFromRequest(req);
  const modifiedAt = new Date();
  const nextUpdate = updateWithActor(update, actorFields(actor, modifiedAt));
  const updateFilter = {
    ...(options.filter || {}),
    _id: scan._id || scan.id
  };
  const after = await Inventory.findOneAndUpdate(updateFilter, nextUpdate, { new: true }).lean();
  if (!after) {
    const error = new Error('Scan not found');
    error.status = 404;
    throw error;
  }
  await saveAuditOrRollback(before, after, req, reason, remarks, options.action || 'UPDATE', nextUpdate);
  invalidateScanCaches([after]);
  emitScanMutation(req, 'scan:modified', { action: options.action || 'UPDATE', scan: after }, [after]);
  return after;
}

async function softDeleteScans(filter, req, options = {}) {
  assertAdmin(req);
  const { reason, remarks } = requireReason(modificationBody(req, options));
  const rows = await Inventory.find({ ...(filter || {}), isDeleted: { $ne: true } }).lean();
  const changed = [];
  const auditIds = [];
  const actor = actorFromRequest(req);
  const deletedAt = new Date();

  try {
    for (const row of rows) {
      const update = {
        isDeleted: true,
        deletedAt,
        deletedBy: actor.userId || actor.username || actor.name,
        deletedByUsername: actor.username,
        deletedByName: actor.name,
        deletedByRole: actor.role,
        deleteReason: reason,
        preDeleteStatus: clean(row.status || row.scanStatus || 'ACCEPTED'),
        preDeleteScanStatus: clean(row.scanStatus || row.status || 'ACCEPTED'),
        preDeleteSyncStatus: clean(row.syncStatus || 'synced'),
        status: 'DELETED',
        scanStatus: 'DELETED',
        syncStatus: 'deleted',
        activeInventory: false,
        remainingQty: 0,
        lastModifiedBy: actor.userId || actor.username || actor.name,
        lastModifiedByUsername: actor.username,
        lastModifiedByName: actor.name,
        lastModifiedByRole: actor.role,
        lastModifiedAt: deletedAt,
        updatedAt: deletedAt
      };
      const after = await Inventory.findByIdAndUpdate(row._id || row.id, { $set: update }, { new: true }).lean();
      if (!after) throw new Error(`Scan ${scanIdentifier(row)} could not be deleted`);
      changed.push({ before: row, after });
      const audit = await ScanAuditLog.create(auditPayload('DELETE', row, after, req, reason, remarks));
      auditIds.push(audit._id || audit.id);
    }
  } catch (error) {
    for (const item of changed) {
      await Inventory.findByIdAndUpdate(item.before._id || item.before.id, { $set: item.before }, { new: true }).catch(() => null);
    }
    if (auditIds.length) await ScanAuditLog.deleteMany({ _id: { $in: auditIds } }).catch(() => null);
    if (error.status) throw error;
    const wrapped = new Error('Scan deletion was rolled back because the audit log could not be created.');
    wrapped.status = 500;
    wrapped.cause = error;
    throw wrapped;
  }

  const deletedRows = changed.map((item) => item.after);
  invalidateScanCaches(deletedRows);
  emitScanMutation(req, 'scan:deleted', { action: 'DELETE', count: deletedRows.length, scans: deletedRows }, deletedRows);
  return { deletedCount: deletedRows.length, rows: deletedRows };
}

async function restoreScan(scanId, req) {
  assertAdmin(req);
  const { reason, remarks } = requireReason(req.body || {});
  const before = await Inventory.findOne({ ...scanIdFilter(scanId), isDeleted: true }).lean();
  if (!before) {
    const error = new Error('Deleted scan not found');
    error.status = 404;
    throw error;
  }
  const restoredAt = new Date();
  const restored = {
    isDeleted: false,
    deletedAt: null,
    status: before.preDeleteStatus || before.preDeleteScanStatus || 'ACCEPTED',
    scanStatus: before.preDeleteScanStatus || before.preDeleteStatus || 'ACCEPTED',
    syncStatus: before.preDeleteSyncStatus || 'synced',
    activeInventory: activeInventoryValue({ ...before, isDeleted: false, status: before.preDeleteStatus, scanStatus: before.preDeleteScanStatus }),
    remainingQty: remainingQtyValue({ ...before, isDeleted: false, status: before.preDeleteStatus, scanStatus: before.preDeleteScanStatus }),
    restoredAt,
    restoredBy: actorFromRequest(req).userId || actorFromRequest(req).username,
    lastModifiedAt: restoredAt,
    lastModifiedBy: actorFromRequest(req).userId || actorFromRequest(req).username,
    lastModifiedByUsername: actorFromRequest(req).username,
    lastModifiedByName: actorFromRequest(req).name,
    lastModifiedByRole: actorFromRequest(req).role,
    updatedAt: restoredAt
  };
  const after = await Inventory.findByIdAndUpdate(before._id || before.id, { $set: restored }, { new: true }).lean();
  try {
    await ScanAuditLog.create(auditPayload('RESTORE', before, after, req, reason, remarks));
  } catch (auditError) {
    await Inventory.findByIdAndUpdate(before._id || before.id, { $set: before }, { new: true }).catch(() => null);
    const error = new Error('Scan restore was rolled back because the audit log could not be created.');
    error.status = 500;
    error.cause = auditError;
    throw error;
  }
  invalidateScanCaches([after]);
  emitScanMutation(req, 'scan:modified', { action: 'RESTORE', scan: after }, [after]);
  return after;
}

module.exports = {
  adminError,
  assertAdmin,
  requireReason,
  scanIdFilter,
  updateScan,
  softDeleteScans,
  restoreScan
};
