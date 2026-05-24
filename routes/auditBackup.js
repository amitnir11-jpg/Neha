const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const mongoose = require('mongoose');
const Inventory = require('../models/Inventory');
const MasterPart = require('../models/MasterPart');
const Dealer = require('../models/Dealer');
const Audit = require('../models/Audit');
const Bin = require('../models/Bin');
const BinTransferHistory = require('../models/BinTransferHistory');
const VerificationLog = require('../models/VerificationLog');
const DeletedScanLog = require('../models/DeletedScanLog');
const DuplicateScanLog = require('../models/DuplicateScanLog');
const RejectedScan = require('../models/RejectedScan');
const ReportSnapshot = require('../models/ReportSnapshot');
const AuditRestoreLog = require('../models/AuditRestoreLog');
const auth = require('./auth');
const { createZip, readZipEntries } = require('../utils/zipArchive');

const router = express.Router();
const AUDIT_DATA_DIR = path.resolve(__dirname, '..', 'Audit Data');
const restoreSessions = new Map();

const COLLECTION_ALIASES = {
  dealers: ['dealers', 'dealer'],
  audits: ['audits', 'audit', 'auditSummary', 'auditSummaries'],
  inventory: ['inventory', 'scans', 'scanRecords', 'scanData'],
  bins: ['bins', 'binLocations', 'binMaster'],
  binTransferHistory: ['binTransferHistory', 'binTransfers', 'transferHistory', 'transfers'],
  verificationLogs: ['verificationLogs', 'verifications', 'verificationData'],
  deletedScanLogs: ['deletedScanLogs', 'deletedScans', 'deletedScanHistory'],
  duplicateScanLogs: ['duplicateScanLogs', 'duplicateScans'],
  rejectedScans: ['rejectedScans', 'wrongNotFoundMaster', 'notInMasterScans'],
  reportSnapshots: ['reportSnapshots', 'reports', 'reportData'],
  masterParts: ['masterParts', 'master', 'partMaster', 'parts']
};

const RESTORE_GROUPS = {
  reports: ['reportSnapshots'],
  'scan-data': ['inventory', 'bins', 'binTransferHistory', 'verificationLogs', 'deletedScanLogs', 'duplicateScanLogs', 'rejectedScans'],
  complete: ['dealers', 'audits', 'inventory', 'bins', 'binTransferHistory', 'verificationLogs', 'deletedScanLogs', 'duplicateScanLogs', 'rejectedScans', 'reportSnapshots', 'masterParts']
};

const RESTORE_MODE_LABELS = {
  merge: 'Merge Data',
  replace: 'Replace Existing',
  'new-audit-session': 'Create New Audit Session'
};

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function clean(value) {
  return String(value || '').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function userName(req) {
  return clean(req.user && (req.user.name || req.user.username || req.user.email || req.user.id)) || 'admin';
}

async function ensureAuditDataDir() {
  await fsp.mkdir(AUDIT_DATA_DIR, { recursive: true });
}

function safeArchivePath(archiveId) {
  const name = path.basename(clean(archiveId));
  if (!name || name !== clean(archiveId)) throw new Error('Invalid backup archive id');
  const resolved = path.resolve(AUDIT_DATA_DIR, name);
  if (!resolved.startsWith(`${AUDIT_DATA_DIR}${path.sep}`)) throw new Error('Invalid backup archive path');
  return resolved;
}

function cleanDocument(document = {}) {
  const clone = { ...document };
  delete clone._id;
  delete clone.__v;
  return clone;
}

function firstArray(collections, aliases) {
  for (const key of aliases) {
    if (Array.isArray(collections[key])) return collections[key];
  }
  return [];
}

function normalizeCollections(backup = {}) {
  const raw = backup.collections || backup.data || backup;
  return Object.fromEntries(Object.entries(COLLECTION_ALIASES).map(([key, aliases]) => [key, firstArray(raw, aliases)]));
}

function mostCommon(values = []) {
  const counts = new Map();
  values.map(clean).filter(Boolean).forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

function collectionCounts(collections) {
  return Object.fromEntries(Object.keys(COLLECTION_ALIASES).map((key) => [key, collections[key].length]));
}

function archiveDetails(archiveId, stat, backup = {}, manifest = {}, status = 'valid', message = '') {
  const collections = normalizeCollections(backup);
  const dealers = collections.dealers;
  const audits = collections.audits;
  const scans = collections.inventory;
  const dealerCode = upper(manifest.dealerCode || backup.dealerCode || backup.filters?.dealerCode || dealers[0]?.dealerCode || audits[0]?.dealerCode || mostCommon(scans.map((scan) => scan.dealerCode)));
  const dealerName = clean(manifest.dealerName || backup.dealerName || dealers[0]?.dealerName || audits[0]?.dealerName || scans.find((scan) => scan.dealerName)?.dealerName);
  const auditDate = clean(manifest.auditDate || backup.auditDate || audits[0]?.auditStartDate || audits[0]?.createdAt || backup.generatedAt || stat.mtime);
  const auditId = clean(manifest.auditId || backup.auditId || audits[0]?.auditId || backup.filters?.auditId || mostCommon(scans.map((scan) => scan.auditId)));
  return {
    archiveId,
    dealerCode,
    dealerName,
    auditId,
    auditDate,
    createdBy: clean(manifest.createdBy || backup.createdBy || backup.generatedBy || 'System'),
    createdAt: clean(manifest.createdAt || backup.generatedAt || stat.mtime),
    backupSize: stat.size || 0,
    totalScans: collections.inventory.length,
    backupStatus: status,
    message,
    counts: collectionCounts(collections),
    restoreModes: RESTORE_MODE_LABELS,
    zipSupported: true
  };
}

async function directorySize(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(entryPath);
    else total += (await fsp.stat(entryPath)).size;
  }
  return total;
}

async function readJsonFile(filePath) {
  return JSON.parse(await fsp.readFile(filePath, 'utf8'));
}

async function loadDirectoryArchive(dirPath) {
  const files = await fsp.readdir(dirPath);
  const manifestFile = files.find((file) => /^manifest\.json$/i.test(file));
  const dataFile = files.find((file) => /^(backup|data|archive)\.json$/i.test(file)) || files.find((file) => /\.json$/i.test(file) && !/^manifest\.json$/i.test(file));
  if (!dataFile) throw new Error('No JSON backup data file found');
  return {
    backup: await readJsonFile(path.join(dirPath, dataFile)),
    manifest: manifestFile ? await readJsonFile(path.join(dirPath, manifestFile)) : {},
    files: await Promise.all(files.map(async (file) => ({ name: file, data: await fsp.readFile(path.join(dirPath, file)) })))
  };
}

async function loadZipArchive(filePath) {
  const entries = readZipEntries(await fsp.readFile(filePath));
  const names = Object.keys(entries);
  const manifestName = names.find((name) => /(^|\/)manifest\.json$/i.test(name));
  const dataName = names.find((name) => /(^|\/)(backup|data|archive)\.json$/i.test(name)) || names.find((name) => /\.json$/i.test(name) && name !== manifestName);
  if (!dataName) throw new Error('No JSON backup data file found in ZIP');
  return {
    backup: JSON.parse(entries[dataName].toString('utf8')),
    manifest: manifestName ? JSON.parse(entries[manifestName].toString('utf8')) : {},
    entries
  };
}

async function loadArchive(archiveId) {
  await ensureAuditDataDir();
  const archivePath = safeArchivePath(archiveId);
  const stat = await fsp.stat(archivePath);
  let loaded;
  if (stat.isDirectory()) {
    loaded = await loadDirectoryArchive(archivePath);
    stat.size = await directorySize(archivePath);
  } else if (/\.zip$/i.test(archivePath)) {
    loaded = await loadZipArchive(archivePath);
  } else if (/\.json$/i.test(archivePath)) {
    loaded = { backup: await readJsonFile(archivePath), manifest: {} };
  } else {
    throw new Error('Unsupported backup archive type');
  }
  return {
    archiveId,
    archivePath,
    stat,
    ...loaded,
    collections: normalizeCollections(loaded.backup)
  };
}

function archiveMatches(details, query = {}) {
  if (query.dealerCode && !details.dealerCode.includes(upper(query.dealerCode))) return false;
  if (query.dealerName && !details.dealerName.toLowerCase().includes(clean(query.dealerName).toLowerCase())) return false;
  if (query.createdBy && !details.createdBy.toLowerCase().includes(clean(query.createdBy).toLowerCase())) return false;
  if (query.auditDate && !String(details.auditDate || '').slice(0, 10).includes(clean(query.auditDate))) return false;
  return true;
}

function sessionProgress(sessionId, patch = {}, logLine = '') {
  if (!sessionId) return;
  const current = restoreSessions.get(sessionId) || { sessionId, percent: 0, status: 'starting', logs: [], cancelRequested: false };
  const logs = logLine ? current.logs.concat(`[${new Date().toLocaleTimeString()}] ${logLine}`) : current.logs;
  restoreSessions.set(sessionId, { ...current, ...patch, logs: logs.slice(-200) });
}

function assertNotCancelled(sessionId) {
  const progress = restoreSessions.get(sessionId);
  if (progress && progress.cancelRequested) {
    const error = new Error('Restore cancelled by user');
    error.cancelled = true;
    throw error;
  }
}

function restoreScopeFilter(dealerCode, auditId) {
  const filter = {};
  if (dealerCode) filter.dealerCode = dealerCode;
  if (auditId) filter.auditId = auditId;
  return filter;
}

function identityFilter(key, doc) {
  if (key === 'dealers') return doc.dealerCode ? { dealerCode: doc.dealerCode } : null;
  if (key === 'audits') return doc.auditId ? { auditId: doc.auditId } : null;
  if (key === 'masterParts') return doc.partNo || doc.partNumber ? { partNo: upper(doc.partNo || doc.partNumber) } : null;
  if (key === 'bins') return doc.binCode ? { binCode: upper(doc.binCode), dealerCode: upper(doc.dealerCode) } : null;
  if (key === 'binTransferHistory') return doc.transferId ? { transferId: doc.transferId } : null;
  if (key === 'inventory') return doc.uniqueScanId ? { uniqueScanId: doc.uniqueScanId } : doc.scanId ? { scanId: doc.scanId } : null;
  if (key === 'verificationLogs') return { dealerCode: upper(doc.dealerCode), rawScannedValue: doc.rawScannedValue || '', partNumber: upper(doc.partNumber || doc.extractedPartNumber), time: doc.time || doc.createdAt };
  if (key === 'deletedScanLogs') return { dealerCode: upper(doc.dealerCode), scanId: doc.scanId || '', deletedTime: doc.deletedTime || doc.createdAt };
  if (key === 'duplicateScanLogs') return doc.uniqueScanId ? { uniqueScanId: doc.uniqueScanId } : { dealerCode: upper(doc.dealerCode), scanId: doc.scanId || '', timestamp: doc.timestamp || doc.createdAt };
  if (key === 'rejectedScans') return { dealerCode: upper(doc.dealerCode), rawScannedValue: doc.rawScannedValue || '', extractedPartNumber: upper(doc.extractedPartNumber), dateTime: doc.dateTime || doc.createdAt };
  if (key === 'reportSnapshots') return doc.reportId ? { reportId: doc.reportId } : { dealerCode: upper(doc.dealerCode), auditId: doc.auditId || '', reportType: doc.reportType || '', generatedAt: doc.generatedAt || doc.createdAt };
  return null;
}

function modelForCollection(key) {
  return {
    dealers: Dealer,
    audits: Audit,
    masterParts: MasterPart,
    bins: Bin,
    binTransferHistory: BinTransferHistory,
    inventory: Inventory,
    verificationLogs: VerificationLog,
    deletedScanLogs: DeletedScanLog,
    duplicateScanLogs: DuplicateScanLog,
    rejectedScans: RejectedScan,
    reportSnapshots: ReportSnapshot
  }[key];
}

function rewriteForNewAuditSession(key, doc, restoreSessionId, newAuditId) {
  if (doc.auditId !== undefined) doc.auditId = newAuditId;
  if (key === 'audits') {
    doc.auditId = newAuditId;
    doc.auditName = `${doc.auditName || doc.dealerCode || 'Restored'} Restored`;
    doc.status = 'active';
    delete doc.auditClosedDate;
  }
  if (key === 'dealers') doc.currentAuditId = newAuditId;
  if (key === 'inventory') {
    const oldId = doc.uniqueScanId || doc.scanId || randomUUID();
    const nextId = `RESTORE-${restoreSessionId}-${oldId}`.slice(0, 180);
    doc.uniqueScanId = nextId;
    doc.scanId = nextId;
    if (doc.qrFingerprint) doc.qrFingerprint = `${nextId}-QR`;
    if (doc.syncKey) doc.syncKey = `${nextId}-SYNC`;
  }
  if (key === 'binTransferHistory' && doc.transferId) doc.transferId = `RESTORE-${restoreSessionId}-${doc.transferId}`.slice(0, 180);
  if (key === 'reportSnapshots') doc.reportId = `RESTORE-${restoreSessionId}-${doc.reportId || randomUUID()}`.slice(0, 180);
  return doc;
}

async function restoreCollection(key, docs, options) {
  const Model = modelForCollection(key);
  if (!Model || !Array.isArray(docs) || !docs.length) return 0;
  let restored = 0;
  for (const item of docs) {
    assertNotCancelled(options.sessionId);
    let doc = cleanDocument(item);
    if (options.restoreMode === 'new-audit-session') doc = rewriteForNewAuditSession(key, doc, options.sessionId, options.newAuditId);
    const filter = identityFilter(key, doc);
    if (!filter) continue;
    if (options.restoreMode === 'merge') {
      const updateOptions = { upsert: true, setDefaultsOnInsert: false };
      if (options.mongoSession) updateOptions.session = options.mongoSession;
      await Model.findOneAndUpdate(filter, doc, updateOptions);
    } else {
      const createOptions = options.mongoSession ? { session: options.mongoSession } : {};
      await Model.create([doc], createOptions);
    }
    restored += 1;
  }
  return restored;
}

async function deleteExistingForReplace(keys, dealerCode, auditId, mongoSession) {
  const scoped = restoreScopeFilter(dealerCode, auditId);
  const dealerScoped = dealerCode ? { dealerCode } : {};
  const withSession = (query) => (mongoSession ? query.session(mongoSession) : query);
  const deletes = [];
  if (keys.includes('reportSnapshots')) deletes.push(withSession(ReportSnapshot.deleteMany(scoped)));
  if (keys.includes('inventory')) deletes.push(withSession(Inventory.deleteMany(scoped)));
  if (keys.includes('bins')) deletes.push(withSession(Bin.deleteMany(dealerScoped)));
  if (keys.includes('binTransferHistory')) deletes.push(withSession(BinTransferHistory.deleteMany(dealerScoped)));
  if (keys.includes('verificationLogs')) deletes.push(withSession(VerificationLog.deleteMany(dealerScoped)));
  if (keys.includes('deletedScanLogs')) deletes.push(withSession(DeletedScanLog.deleteMany(dealerScoped)));
  if (keys.includes('duplicateScanLogs')) deletes.push(withSession(DuplicateScanLog.deleteMany(scoped)));
  if (keys.includes('rejectedScans')) deletes.push(withSession(RejectedScan.deleteMany(dealerScoped)));
  if (keys.includes('audits')) deletes.push(withSession(Audit.deleteMany(auditId ? { auditId } : dealerScoped)));
  if (keys.includes('dealers') && dealerCode) deletes.push(withSession(Dealer.deleteOne({ dealerCode })));
  if (keys.includes('masterParts')) deletes.push(withSession(MasterPart.deleteMany(dealerScoped)));
  await Promise.all(deletes);
}

async function duplicateSummary(collections) {
  const scanIds = collections.inventory.map((scan) => clean(scan.uniqueScanId || scan.scanId)).filter(Boolean);
  const existingScans = scanIds.length ? await Inventory.countDocuments({ $or: [{ uniqueScanId: { $in: scanIds } }, { scanId: { $in: scanIds } }] }) : 0;
  return { existingScans };
}

function isTransactionUnsupported(error) {
  return /Transaction numbers are only allowed|replica set member or mongos|Transaction.*not supported/i.test(error && error.message);
}

async function createArchiveZip(archiveId) {
  const loaded = await loadArchive(archiveId);
  if (/\.zip$/i.test(loaded.archivePath) && !loaded.stat.isDirectory()) return await fsp.readFile(loaded.archivePath);
  if (loaded.stat.isDirectory() && loaded.files) return createZip(loaded.files);
  return createZip([
    { name: 'backup.json', data: Buffer.from(JSON.stringify(loaded.backup, null, 2), 'utf8') },
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(archiveDetails(archiveId, loaded.stat, loaded.backup, loaded.manifest), null, 2), 'utf8') }
  ]);
}

router.get('/list', auth.requireAuth, auth.requireAdmin, asyncRoute(async (req, res) => {
  await ensureAuditDataDir();
  const entries = await fsp.readdir(AUDIT_DATA_DIR, { withFileTypes: true });
  const archives = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !/\.(json|zip)$/i.test(entry.name)) continue;
    try {
      const loaded = await loadArchive(entry.name);
      const details = archiveDetails(entry.name, loaded.stat, loaded.backup, loaded.manifest);
      details.existingDealer = details.dealerCode ? Boolean(await Dealer.exists({ dealerCode: details.dealerCode })) : false;
      if (archiveMatches(details, req.query)) archives.push(details);
    } catch (error) {
      const archivePath = safeArchivePath(entry.name);
      const stat = await fsp.stat(archivePath);
      const details = archiveDetails(entry.name, stat, {}, {}, 'invalid', error.message);
      if (archiveMatches(details, req.query)) archives.push(details);
    }
  }
  archives.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  res.json({ success: true, archiveDir: AUDIT_DATA_DIR, archives });
}));

router.get('/preview', auth.requireAuth, auth.requireAdmin, asyncRoute(async (req, res) => {
  const loaded = await loadArchive(req.query.archiveId);
  const details = archiveDetails(loaded.archiveId, loaded.stat, loaded.backup, loaded.manifest);
  details.existingDealer = details.dealerCode ? Boolean(await Dealer.exists({ dealerCode: details.dealerCode })) : false;
  details.duplicates = await duplicateSummary(loaded.collections);
  res.json({ success: true, archive: details });
}));

router.get('/download', auth.requireAuth, auth.requireAdmin, asyncRoute(async (req, res) => {
  const archiveId = clean(req.query.archiveId);
  const zipBuffer = await createArchiveZip(archiveId);
  const base = path.basename(archiveId).replace(/\.(json|zip)$/i, '') || 'audit-backup';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${base}.zip"`);
  res.send(zipBuffer);
}));

router.delete('/remove', auth.requireAuth, auth.requireAdmin, asyncRoute(async (req, res) => {
  const archivePath = safeArchivePath(req.query.archiveId);
  const stat = await fsp.stat(archivePath);
  if (stat.isDirectory()) await fsp.rm(archivePath, { recursive: true, force: true });
  else await fsp.unlink(archivePath);
  res.json({ success: true, message: 'Backup archive removed permanently' });
}));

router.get('/progress/:sessionId', auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json({ success: true, progress: restoreSessions.get(req.params.sessionId) || { sessionId: req.params.sessionId, status: 'unknown', percent: 0, logs: [] } });
});

router.post('/cancel/:sessionId', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const progress = restoreSessions.get(req.params.sessionId) || { sessionId: req.params.sessionId, logs: [] };
  restoreSessions.set(req.params.sessionId, { ...progress, cancelRequested: true, status: 'cancelling' });
  res.json({ success: true, message: 'Restore cancel requested' });
});

router.post('/restore', auth.requireAuth, auth.requireAdmin, asyncRoute(async (req, res) => {
  const sessionId = clean(req.body.restoreSessionId) || randomUUID();
  const restoreType = RESTORE_GROUPS[req.body.restoreType] ? req.body.restoreType : 'complete';
  const restoreMode = RESTORE_MODE_LABELS[req.body.restoreMode] ? req.body.restoreMode : 'merge';
  const loaded = await loadArchive(req.body.archiveId);
  const details = archiveDetails(loaded.archiveId, loaded.stat, loaded.backup, loaded.manifest);
  const dealerCode = details.dealerCode;
  const auditId = details.auditId;
  const keys = RESTORE_GROUPS[restoreType];
  const totalToRestore = keys.reduce((sum, key) => sum + (loaded.collections[key]?.length || 0), 0);
  const existingDealer = dealerCode ? Boolean(await Dealer.exists({ dealerCode })) : false;
  const newAuditId = restoreMode === 'new-audit-session' ? `${auditId || `AUD${dealerCode || 'RESTORE'}`}-RESTORED-${Date.now()}` : auditId;
  const logLines = [];
  const counts = {};
  let totalRecordsRestored = 0;
  let restoreLog;

  if (!dealerCode) return res.status(400).json({ success: false, message: 'Backup validation failed: dealer code missing' });
  if (!totalToRestore) return res.status(400).json({ success: false, message: 'Backup validation failed: no supported records found' });

  sessionProgress(sessionId, { status: 'started', percent: 3, archiveId: loaded.archiveId, dealerCode, restoreType, restoreMode }, 'Restore session created');
  restoreLog = await AuditRestoreLog.create({
    dealerCode,
    auditId,
    archiveId: loaded.archiveId,
    restoredBy: userName(req),
    restoreType,
    restoreMode,
    restoreStatus: 'started'
  });

  async function performRestore(mongoSession) {
    assertNotCancelled(sessionId);
    const duplicates = await duplicateSummary(loaded.collections);
    logLines.push(`Backup validated for dealer ${dealerCode}; duplicate active scans found: ${duplicates.existingScans}`);
    sessionProgress(sessionId, { percent: 8, duplicates }, logLines[logLines.length - 1]);

    if (restoreMode === 'replace') {
      await deleteExistingForReplace(keys, dealerCode, auditId, mongoSession);
      logLines.push(`Existing data removed for ${dealerCode}${auditId ? ` / ${auditId}` : ''}`);
      sessionProgress(sessionId, { percent: 14 }, logLines[logLines.length - 1]);
    }

    if (restoreMode === 'new-audit-session') {
      logLines.push(`Creating restored audit session ${newAuditId}`);
      sessionProgress(sessionId, { percent: 14, newAuditId }, logLines[logLines.length - 1]);
    } else if (existingDealer) {
      logLines.push(`${RESTORE_MODE_LABELS[restoreMode]} selected for existing dealer ${dealerCode}`);
    }

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const docs = loaded.collections[key] || [];
      if (!docs.length) {
        counts[key] = 0;
        continue;
      }
      const restored = await restoreCollection(key, docs, { sessionId, restoreMode, mongoSession, newAuditId });
      counts[key] = restored;
      totalRecordsRestored += restored;
      logLines.push(`Restored ${restored} ${key}`);
      sessionProgress(sessionId, { percent: Math.min(90, 18 + Math.round(((index + 1) / keys.length) * 70)), counts }, logLines[logLines.length - 1]);
    }
  }

  let mongoSession = await mongoose.startSession();
  let fallbackRestore = false;
  try {
    try {
      await mongoSession.withTransaction(() => performRestore(mongoSession));
    } catch (error) {
      await mongoSession.endSession();
      mongoSession = null;
      if (!isTransactionUnsupported(error) || existingDealer) throw error;
      fallbackRestore = true;
      totalRecordsRestored = 0;
      Object.keys(counts).forEach((key) => delete counts[key]);
      logLines.push('MongoDB transaction support is unavailable locally; using safe non-conflicting restore fallback.');
      sessionProgress(sessionId, { percent: 10 }, logLines[logLines.length - 1]);
      await performRestore(null);
    }

    await Promise.all([Inventory, Bin, BinTransferHistory, VerificationLog, DeletedScanLog, DuplicateScanLog, RejectedScan, ReportSnapshot, Dealer, Audit].map((Model) => Model.createIndexes().catch(() => null)));
    logLines.push('Indexes verified after restore');
    sessionProgress(sessionId, { status: 'completed', percent: 100, counts, totalRecordsRestored }, logLines[logLines.length - 1]);

    await AuditRestoreLog.findByIdAndUpdate(restoreLog._id, {
      restoreStatus: 'completed',
      totalRecordsRestored,
      counts,
      logs: logLines
    });

    if (req.io) {
      req.io.emit('backup:restored');
      req.io.emit('reports:update');
      req.io.emit('stats:update');
      req.io.emit('dashboard:update', {});
    }

    res.json({
      success: true,
      sessionId,
      dealerCode,
      auditId: restoreMode === 'new-audit-session' ? newAuditId : auditId,
      restoreType,
      restoreMode,
      restored: counts,
      totalRecordsRestored,
      message: 'Audit backup restored successfully'
    });
  } catch (error) {
    console.error('[audit-backup-restore] failed', error);
    if (fallbackRestore && !existingDealer) {
      await deleteExistingForReplace(keys, dealerCode, restoreMode === 'new-audit-session' ? newAuditId : auditId, null).catch(() => null);
    }
    const status = error.cancelled ? 'cancelled' : 'failed';
    await AuditRestoreLog.findByIdAndUpdate(restoreLog._id, {
      restoreStatus: status,
      totalRecordsRestored,
      counts,
      logs: logLines,
      errorMessage: error.message
    }).catch(() => null);
    sessionProgress(sessionId, { status, percent: status === 'cancelled' ? 0 : 100, errorMessage: error.message }, error.message);
    res.status(error.cancelled ? 409 : 500).json({ success: false, sessionId, message: error.message });
  } finally {
    if (mongoSession) await mongoSession.endSession();
  }
}));

router.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  return res.status(500).json({ success: false, message: error.message || 'Audit backup operation failed' });
});

module.exports = router;
