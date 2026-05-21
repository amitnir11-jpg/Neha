const express = require('express');
const mongoose = require('mongoose');
const { randomUUID } = require('crypto');
const Inventory = require('../models/Inventory');
const MasterPart = require('../models/MasterPart');
const Dealer = require('../models/Dealer');
const Device = require('../models/Device');
const SyncLog = require('../models/SyncLog');
const DuplicateScanLog = require('../models/DuplicateScanLog');
const VerificationLog = require('../models/VerificationLog');
const User = require('../models/User');
const auth = require('./auth');
const inventory = require('./inventory');
const { isLocalhostUrl, serverInfo } = require('../utils/network');
const { getActiveAudit, publicAudit } = require('../utils/audit');
const { normalizePartNumber: normalizePartNo } = require('../utils/normalize');
const MasterCatalogue = require('../models/MasterCatalogue');
const { cataloguePayload } = require('../utils/catalogue');
const { makeQrFingerprint, isDuplicateKeyError } = require('../utils/scanIdentity');
const masterValidation = require('../utils/masterValidation');

const router = express.Router();
const VALID_TYPES = ['AUDIT', 'INWARD', 'OUTWARD', 'VERIFICATION', 'FITTED', 'DAMAGE'];
const BIN_REQUIRED_MESSAGE = 'Please enter/select bin location first.';

function clean(value) {
  return String(value || '').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function compactUserContext(source = {}) {
  const loginId = clean(source.loginId || source.username || source.email || source.user || source.userID);
  const userId = clean(source.userId || source.id || source._id || loginId);
  const userName = clean(source.userName || source.staffName || source.name || source.username || loginId);
  return {
    userId,
    loginId,
    userName,
    staffName: clean(source.staffName || source.name || userName),
    role: clean(source.role).toLowerCase()
  };
}

function applyUserContext(target = {}, context = {}) {
  const cleanContext = compactUserContext(context);
  if (!target.userId && cleanContext.userId) target.userId = cleanContext.userId;
  if (!target.loginId && cleanContext.loginId) target.loginId = cleanContext.loginId;
  if (!target.staffName && cleanContext.staffName) target.staffName = cleanContext.staffName;
  if (!target.userName && cleanContext.userName) target.userName = cleanContext.userName;
  if (!target.role && cleanContext.role) target.role = cleanContext.role;
  return target;
}

async function userByContext(context = {}) {
  const keys = Array.from(new Set([
    context.userId,
    context.loginId,
    context.userName,
    context.staffName
  ].map((value) => clean(value)).filter(Boolean)));
  if (!keys.length) return null;
  return User.findOne({
    $or: [
      { _id: { $in: keys.filter((value) => /^[a-f\d]{24}$/i.test(value)) } },
      { username: { $in: keys } },
      { email: { $in: keys } },
      { name: { $in: keys } }
    ]
  }).lean();
}

async function resolveScanUserContext(req = {}, scan = {}) {
  const body = req.body || {};
  const context = {};
  applyUserContext(context, scan.source || {});
  applyUserContext(context, body);
  applyUserContext(context, req.user || {});
  applyUserContext(context, scan);

  const deviceId = clean(scan.deviceId || body.deviceId);
  if (deviceId) {
    const device = await Device.findOne({ deviceId }).lean().catch(() => null);
    if (device) applyUserContext(context, device);
  }

  if (!context.userId || !context.userName || !context.role) {
    const user = await userByContext(context).catch(() => null);
    if (user) applyUserContext(context, user);
  }

  return context;
}

function normalizeScanType(value) {
  const type = upper(value || 'INWARD');
  if (type === 'VERIFICATION' || type === 'FITTED') return 'AUDIT';
  return type;
}

function rawIdentity(scan = {}) {
  return clean(scan.rawScanString || scan.rawScan || scan.rawBarcode || scan.rawQR || scan.rawUpi || scan.upiNo || scan.upiId);
}

function acceptedStatuses() {
  return ['ACCEPTED', 'SUPERVISOR_APPROVED', 'OUTWARD_DONE'];
}

function scanIdentityScope(filter = {}, scan = {}) {
  const dealerCode = upper(scan.dealerCode || '');
  const auditId = clean(scan.auditId || '');
  if (dealerCode) filter.dealerCode = dealerCode;
  if (auditId) filter.auditId = auditId;
  return filter;
}

function inboundAcceptedFilter(raw, scan = {}) {
  return scanIdentityScope({
    scanType: { $in: ['AUDIT', 'INWARD', 'VERIFICATION', 'FITTED'] },
    scanStatus: { $in: ['ACCEPTED', 'SUPERVISOR_APPROVED'] },
    $or: [
      { rawScan: raw },
      { rawScanString: raw },
      { rawBarcode: raw },
      { rawQR: raw },
      { rawUpi: raw },
      { upiNo: upper(raw) },
      { upiId: raw }
    ]
  }, scan);
}

function outwardDoneFilter(raw, scan = {}) {
  return scanIdentityScope({
    scanType: 'OUTWARD',
    scanStatus: 'OUTWARD_DONE',
    $or: [
      { rawScan: raw },
      { rawScanString: raw },
      { rawBarcode: raw },
      { rawQR: raw },
      { rawUpi: raw },
      { upiNo: upper(raw) },
      { upiId: raw }
    ]
  }, scan);
}

function scanRole(req, scan = {}) {
  return clean(scan.role || scan.source?.role || req.user?.role || '').toLowerCase();
}

function scanUserName(req, scan = {}) {
  return clean(scan.userName || scan.staffName || scan.source?.userName || scan.source?.staffName || req.user?.name || req.user?.username || req.user?.email);
}

function roleScanError(role, scanType) {
  if (!role) return '';
  if (role === 'admin' || role === 'supervisor') return '';
  if (role === 'outward_counter') return scanType === 'OUTWARD' ? '' : 'Outward Counter can only perform OUTWARD scans';
  if (role === 'scanner' || role === 'staff' || role === 'mobile_user') return scanType === 'OUTWARD' ? 'Scanner users cannot perform OUTWARD scans' : '';
  return '';
}

function logSync(stage, details = {}) {
  const safeDetails = { ...details };
  if (Array.isArray(safeDetails.sample)) safeDetails.sample = safeDetails.sample.slice(0, 3);
  console.log(`[MOBILE SYNC] ${stage}`, safeDetails);
}

async function logMasterValidationFailure(scan = {}, reason = 'Not Found In Master') {
  try {
    const now = scan.timestamp instanceof Date && !Number.isNaN(scan.timestamp.getTime()) ? scan.timestamp : new Date();
    const rawScannedValue = clean(scan.rawScanString || scan.rawScan || scan.rawUpi || scan.upiNo || scan.upiId);
    const recent = rawScannedValue ? await VerificationLog.findOne({
      found: false,
      rawScannedValue,
      dealerCode: upper(scan.dealerCode),
      deviceId: clean(scan.deviceId),
      time: { $gte: new Date(now.getTime() - 5000) }
    }).sort({ time: -1 }) : null;
    if (recent) {
      recent.repeatCount = Number(recent.repeatCount || 1) + 1;
      recent.time = now;
      await recent.save();
      return;
    }
    await VerificationLog.create({
      partNumber: normalizePartNumber(scan.partNumber || scan.part || ''),
      extractedPartNumber: normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part || ''),
      rawScannedValue,
      found: false,
      dealerCode: upper(scan.dealerCode),
      deviceId: clean(scan.deviceId),
      userId: clean(scan.userId),
      loginId: clean(scan.loginId),
      scannedBy: clean(scan.staffName || scan.loginId || scan.userId),
      staffName: clean(scan.staffName),
      scanType: upper(scan.scanType || scan.type),
      source: normalizeSource(scan.source?.source || scan.source?.scanSource || scan.source, 'mobile'),
      binLocation: upper(scan.binLocation || scan.bin),
      reason,
      repeatCount: 1,
      time: now
    });
  } catch (error) {
    logSync('verification log write failed', { message: error.message, reason, scanId: scan.uniqueScanId || scan.scanId });
  }
}

function scanPublicDebug(scan = {}) {
  return {
    id: scan._id,
    uniqueScanId: scan.uniqueScanId,
    scanId: scan.scanId,
    qrFingerprint: scan.qrFingerprint,
    partNumber: scan.partNumber || scan.part,
    dealerCode: scan.dealerCode,
    auditId: scan.auditId,
    qty: scan.qty,
    scanType: scan.scanType || scan.type,
    bin: scan.binLocation || scan.bin,
    syncKey: scan.syncKey,
    syncStatus: scan.syncStatus,
    deviceId: scan.deviceId,
    timestamp: scan.timestamp,
    createdAt: scan.createdAt,
    warnings: scan.warnings || [],
    masterFound: Boolean(scan.masterFound || scan.masterMatch || scan.isMasterMatched)
  };
}

function incomingScansFromBody(body = {}) {
  if (Array.isArray(body)) return body;
  const arrayKeys = ['records', 'scans', 'items', 'data', 'inventory', 'inventoryItems', 'pendingRecords'];
  for (const key of arrayKeys) {
    if (Array.isArray(body[key])) return body[key];
  }
  return Object.keys(body || {}).length ? [body] : [];
}

function firstValue(item = {}, keys = []) {
  for (const key of keys) {
    const value = item[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

function normalizeCategory(value) {
  const text = clean(value).replace(/\s+/g, ' ');
  if (!text) return '';
  const acronyms = new Set(['HDX', 'HHML', 'B2S2', 'HGP', 'HGO']);
  return text.split(' ').map((word) => {
    const upperWord = word.toUpperCase();
    if (acronyms.has(upperWord)) return upperWord;
    if (/^[A-Z0-9]+$/.test(word) || /^[a-z0-9]+$/.test(word)) return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    return word;
  }).join(' ');
}

function normalizePartNumber(value) {
  return normalizePartNo(value);
}

function isValidPartNumber(value) {
  const part = normalizePartNumber(value);
  return /^[A-Z0-9][A-Z0-9._/-]{2,39}$/.test(part) && !/^UPI$/i.test(part);
}

function normalizeSource(value, fallback = 'mobile') {
  const source = clean(value || fallback).toLowerCase();
  if (/ocr|ai/.test(source)) return 'ocr_label';
  if (/^qr$|qr[_\s-]*scan/.test(source)) return 'qr';
  if (/barcode/.test(source)) return 'barcode';
  if (/camera|mobile/.test(source)) return 'mobile';
  if (['manual', 'scanner', 'import', 'api', 'ocr_label', 'qr'].includes(source)) return source;
  return fallback;
}

function makeScanId(item = {}, timestamp = new Date()) {
  const explicit = clean(item.scanId || item.uniqueScanId || item.mobileScanId || item.localId);
  if (explicit) return explicit;
  if (randomUUID) return randomUUID();
  const deviceId = clean(item.deviceId || 'DEVICE').replace(/\s+/g, '-');
  const time = timestamp instanceof Date && !Number.isNaN(timestamp.getTime()) ? timestamp.getTime() : Date.now();
  return `${deviceId}-${time}-${Math.random().toString(36).slice(2, 10)}`;
}

function scanTimestamp(item = {}) {
  const raw = firstValue(item, [
    'timestamp',
    'scanTime',
    'scannedAt',
    'scanDateTime',
    'dateTime',
    'createdAt',
    'localCreatedAt',
    'localTimestamp'
  ]);
  if (!raw) return new Date();
  const parsed = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function liveCutoff() {
  return new Date(Date.now() - 30 * 1000);
}

function normalizeScan(item = {}) {
  const explicitScanId = clean(item.scanId || item.uniqueScanId || item.mobileScanId || item.localId);
  const rawScan = clean(firstValue(item, [
    'rawScanString',
    'rawScan',
    'rawBarcode',
    'rawScanValue',
    'barcode',
    'barcodeValue',
    'scanValue',
    'scanText',
    'raw'
  ]));
  const parsed = inventory.parseRawScan(rawScan);
  const timestamp = scanTimestamp(item);
  const dealerCode = upper(item.dealerCode || item.dealer || item.dealerId || parsed.dealerCode);
  const partNumber = normalizePartNumber(parsed.part || firstValue(item, ['partNumber', 'partNo', 'part', 'sku', 'itemCode']));
  const scanType = normalizeScanType(item.scanType || item.action || item.type || item.movement || parsed.type || 'INWARD');
  const binLocation = clean(item.binLocation || item.bin || item.location || parsed.bin);
  const upiId = clean(item.upiNo || item.upiId || item.upiID || item.upiSequence || item.upiScanId || item.transactionId || item.txnId || inventory.extractUpiId(item, parsed));
  const upiNo = upiId;
  const syncKey = clean(item.syncKey || inventory.buildSyncKey({ dealerCode, upiId, partNumber, scanType, timestamp }));
  const quantity = inventory.numberValue(firstValue(item, ['quantity', 'qty', 'count']) || parsed.qty, 1);
  const scanSource = normalizeSource(item.source?.source || item.source?.scanSource || item.scanSource || item.source, 'mobile');
  const idSource = scanSource === 'manual'
    ? { deviceId: item.deviceId }
    : { ...item, deviceId: item.deviceId };
  const uniqueScanId = scanSource === 'manual'
    ? makeScanId(idSource, timestamp)
    : (explicitScanId ? [explicitScanId, upper(binLocation)].filter(Boolean).join('::BIN::') : makeScanId(idSource, timestamp));
  const itemMrpProvided = item.mrpProvided === true || String(item.mrpProvided).toLowerCase() === 'true';
  const parsedMrpProvided = parsed.mrpProvided === true || String(parsed.mrpProvided).toLowerCase() === 'true';
  const mrpProvided = itemMrpProvided || parsedMrpProvided;

  return {
    source: item,
    scanSource,
    parsed,
    syncKey,
    uniqueScanId,
    scanId: uniqueScanId,
    scanIdProvided: Boolean(explicitScanId),
    partNumber,
    normalizedPartNumber: partNumber,
    partName: clean(item.partDescription || item.partName),
    partDescription: clean(item.partDescription || item.partName),
    binLocation,
    quantity,
    mrp: mrpProvided ? inventory.numberValue(itemMrpProvided ? item.mrp : parsed.mrp, 0) : undefined,
    mrpProvided,
    scanType,
    upiId,
    upiNo,
    rawScanString: rawScan || partNumber,
    dealerCode,
    dealerName: clean(item.dealerName),
    auditId: clean(item.auditId),
    staffName: clean(item.staffName),
    userName: clean(item.userName || item.staffName),
    role: clean(item.role),
    userId: clean(item.userId || item.userID || item.user || item.loginId || item.username),
    loginId: clean(item.loginId || item.username || item.userId || item.user),
    deviceId: clean(item.deviceId),
    deviceName: clean(item.deviceName || item.device || item.model),
    timestamp
  };
}

function applyActiveAudit(scan, activeAudit) {
  if (!activeAudit) return scan;
  const dealerCode = upper(activeAudit.dealerCode);
  scan.dealerCode = dealerCode;
  scan.dealerName = clean(activeAudit.dealerName);
  scan.auditId = clean(activeAudit.auditId || activeAudit._id);
  scan.syncKey = inventory.buildSyncKey({
    dealerCode,
    upiId: scan.upiNo || scan.upiId,
    partNumber: scan.partNumber,
    scanType: scan.scanType,
    timestamp: scan.timestamp
  });
  scan.qrFingerprint = makeQrFingerprint(scan);
  return scan;
}

function duplicateQuery(scan) {
  if (isManualEntry(scan)) {
    const scanId = clean(scan.uniqueScanId || scan.scanId);
    return scanIdentityScope({ $or: scanId ? [{ uniqueScanId: scanId }, { scanId }] : [{ uniqueScanId: '__missing__' }] }, scan);
  }
  const qrFingerprint = clean(scan.qrFingerprint || makeQrFingerprint(scan));
  const rawScan = rawIdentity(scan);
  const upiNo = upper(scan.upiNo || scan.upiId || rawScan);
  const terms = [];
  if (rawScan) terms.push({ rawScan }, { rawScanString: rawScan }, { rawBarcode: rawScan }, { rawQR: rawScan }, { rawUpi: rawScan });
  if (upiNo) terms.push({ upiNo }, { upiId: upiNo });
  if (qrFingerprint) terms.push({ qrFingerprint });
  return scanIdentityScope({
    scanStatus: { $in: acceptedStatuses() },
    $or: terms.length ? terms : [{ uniqueScanId: '__missing__' }]
  }, scan);
}

function isManualEntry(scan = {}) {
  return normalizeSource(scan.scanSource || scan.source?.source || scan.source?.scanSource || scan.source, 'mobile') === 'manual';
}

function manualMergeKey(scan = {}) {
  const source = normalizeSource(scan.scanSource || scan.source?.source || scan.source?.scanSource || scan.source, '');
  if (source !== 'manual') return '';
  const dealerCode = upper(scan.dealerCode);
  const partNumber = normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part);
  const scanType = upper(scan.scanType || scan.type || 'INWARD');
  const binLocation = upper(scan.binLocation || scan.bin);
  if (!dealerCode || !partNumber || !scanType) return '';
  return [dealerCode, partNumber, scanType, binLocation].join('::');
}

async function logDuplicateScan(scan = {}, existing = {}, reason = 'Duplicate scan skipped') {
  try {
    const duplicateTime = scan.timestamp instanceof Date && !Number.isNaN(scan.timestamp.getTime()) ? scan.timestamp : new Date();
    await DuplicateScanLog.create({
      scanId: clean(scan.scanId || scan.uniqueScanId),
      uniqueScanId: clean(scan.uniqueScanId || scan.scanId),
      qrFingerprint: clean(scan.qrFingerprint),
      existingScanId: clean(existing.scanId || existing.uniqueScanId || existing._id),
      partNumber: normalizePartNumber(scan.partNumber || existing.partNumber || existing.part),
      dealerCode: upper(scan.dealerCode || existing.dealerCode),
      auditId: clean(scan.auditId || existing.auditId),
      binLocation: upper(scan.binLocation || scan.bin || existing.binLocation || existing.bin),
      scanType: upper(scan.scanType || scan.type || existing.scanType || existing.type),
      deviceId: clean(scan.deviceId || existing.deviceId),
      deviceName: clean(scan.deviceName || scan.source?.deviceName),
      userId: clean(scan.userId || existing.userId),
      userName: clean(scan.userName || scan.staffName || scan.loginId || scan.source?.userName),
      role: clean(scan.role || scan.source?.role).toLowerCase(),
      loginId: clean(scan.loginId || existing.loginId),
      rawScan: rawIdentity(scan) || clean(existing.rawScanString || existing.rawScan),
      rawBarcode: rawIdentity(scan) || clean(existing.rawBarcode),
      rawQR: rawIdentity(scan) || clean(existing.rawQR),
      rawUpi: rawIdentity(scan) || clean(existing.rawUpi),
      firstScannedBy: clean(existing.userName || existing.staffName || existing.loginId || existing.userId),
      firstScanTime: existing.timestamp || existing.createdAt,
      firstDeviceId: clean(existing.deviceId),
      firstDeviceName: clean(existing.deviceName),
      firstBin: upper(existing.binLocation || existing.bin),
      duplicateScannedBy: clean(scan.userName || scan.staffName || scan.loginId || scan.userId),
      duplicateScanTime: duplicateTime,
      duplicateDeviceId: clean(scan.deviceId),
      duplicateDeviceName: clean(scan.deviceName || scan.source?.deviceName),
      duplicateBin: upper(scan.binLocation || scan.bin),
      source: normalizeSource(scan.source?.source || scan.source?.scanSource || scan.source || existing.source, 'mobile'),
      reason,
      timestamp: duplicateTime
    });
  } catch (error) {
    logSync('duplicate log write failed', { message: error.message });
  }
}

async function emitEnterpriseRealtime(io, scans = []) {
  if (!io) return;
  const publicScans = scans.map((scan) => inventory.publicScan ? inventory.publicScan(scan) : scan);
  publicScans.forEach((scan) => {
    io.emit('scan:new', scan);
    io.emit('scan:saved', scan);
    io.emit('scanData', scan);
  });
  const activeAudit = await getActiveAudit().catch(() => null);
  const firstScan = publicScans[0] || {};
  const dashboardFilter = {};
  if (activeAudit && activeAudit.dealerCode) dashboardFilter.dealerCode = upper(activeAudit.dealerCode);
  else if (firstScan.dealerCode) dashboardFilter.dealerCode = upper(firstScan.dealerCode);
  if (activeAudit && activeAudit.auditId) dashboardFilter.auditId = clean(activeAudit.auditId);
  else if (firstScan.auditId) dashboardFilter.auditId = clean(firstScan.auditId);
  const [stats, recent] = await Promise.all([
    inventory.dashboardStats(dashboardFilter),
    Inventory.find(inventory.applyTestScanMode({ ...dashboardFilter }, 'real')).sort({ timestamp: -1, createdAt: -1 }).limit(12).lean()
  ]);
  stats.dealerCode = dashboardFilter.dealerCode || '';
  stats.auditId = dashboardFilter.auditId || '';
  const recentPublic = recent.map(inventory.publicScan);
  const realtimePayload = {
    source: 'sync-api',
    scans: publicScans,
    stats,
    recent: recentPublic,
    count: publicScans.length,
    at: new Date(),
    dealerCode: dashboardFilter.dealerCode || '',
    auditId: dashboardFilter.auditId || '',
    activeAudit: activeAudit ? publicAudit(activeAudit) : null
  };
  io.emit('scan:count:update', stats);
  io.emit('dashboard:update', realtimePayload);
  io.emit('inventory:update', realtimePayload);
  io.emit('reports:update', realtimePayload);
  io.emit('warehouse:feed', realtimePayload);
  io.emit('scan:last10:update', recentPublic);
  io.emit('stats:update', stats);
  io.emit('syncData', realtimePayload);
  logSync('socket broadcast success', { count: publicScans.length, events: ['scan:new', 'scan:saved', 'scanData', 'inventory:update', 'reports:update', 'dashboard:update', 'scan:last10:update', 'syncData'] });
}

async function scanPolicyResult(scan = {}) {
  const raw = rawIdentity(scan);
  if (!raw || isManualEntry(scan)) return { ok: true };
  if (scan.scanType === 'OUTWARD') {
    const outwardDone = await Inventory.findOne(outwardDoneFilter(raw, scan)).lean();
    if (outwardDone) {
      return { ok: false, status: 'duplicate', existing: outwardDone, reason: 'Duplicate QR/UPI already outwarded', message: 'This QR/UPI is already outwarded and cannot be outwarded again.' };
    }
    const inbound = await Inventory.findOne(inboundAcceptedFilter(raw, scan)).sort({ timestamp: 1, createdAt: 1 }).lean();
    if (!inbound) {
      return { ok: false, status: 'failed', reason: 'OUTWARD item not available', message: 'Outward blocked. Item is not available in accepted stock.' };
    }
    return { ok: true, sourceScan: inbound };
  }
  const duplicate = await Inventory.findOne(duplicateQuery(scan)).sort({ timestamp: 1, createdAt: 1 }).lean();
  if (duplicate) {
    return { ok: false, status: 'duplicate', existing: duplicate, reason: 'Duplicate QR/UPI', message: `Duplicate QR already scanned. First scanned by ${duplicate.userName || duplicate.staffName || duplicate.loginId || 'Unknown'}, at ${duplicate.timestamp ? new Date(duplicate.timestamp).toLocaleString() : '-'}, Bin ${duplicate.binLocation || duplicate.bin || '-'}.` };
  }
  return { ok: true };
}

async function saveNormalizedScan(scan, req) {
  logSync('server scan received', {
    deviceId: scan.deviceId,
    rawScanReceived: scan.rawScanString,
    extractedPartNumber: scan.partNumber,
    partNumber: scan.partNumber,
    dealerCode: scan.dealerCode,
    syncKey: scan.syncKey,
    scanId: scan.uniqueScanId
  });
  const activeAudit = await getActiveAudit();
  if (!activeAudit) {
    logSync('scan rejected', { reason: 'No active audit', deviceId: scan.deviceId, scanId: scan.uniqueScanId });
    return { status: 'failed', scan, error: 'No active audit found. Please start audit from PC Admin.' };
  }
  applyActiveAudit(scan, activeAudit);
  applyUserContext(scan, await resolveScanUserContext(req, scan));
  const validation = await masterValidation.validatePartAgainstMaster({
    partNumber: scan.normalizedPartNumber || scan.partNumber,
    dealerCode: scan.dealerCode,
    rawScannedValue: scan.rawScanString,
    logger: console
  });
  const master = validation.master;
  
  if (!scan.dealerCode && master && master.dealerCode) {
    scan.dealerCode = master.dealerCode;
    scan.syncKey = inventory.buildSyncKey({
      dealerCode: scan.dealerCode,
      upiId: scan.upiId,
      partNumber: scan.partNumber,
      scanType: scan.scanType,
      timestamp: scan.timestamp
    });
  }

  const dealer = scan.dealerCode ? await Dealer.findOne({ dealerCode: scan.dealerCode }).lean() : null;

  const errors = [];
  if (!scan.partNumber) errors.push('Part number missing');
  if (scan.partNumber && !isValidPartNumber(scan.partNumber)) errors.push('Invalid part number format');
  if (!scan.binLocation) errors.push(BIN_REQUIRED_MESSAGE);
  if (!scan.dealerCode) errors.push('Dealer code missing');
  if (!VALID_TYPES.includes(scan.scanType)) errors.push('Invalid scan type');
  if (!scan.syncKey) errors.push('Sync key missing');
  if (!master) errors.push(`Part number not found in master: ${scan.partNumber}`);
  const role = scanRole(req, scan);
  const roleError = roleScanError(role, scan.scanType);
  if (roleError) errors.push(roleError);
  logSync('validation result', {
    deviceId: scan.deviceId,
    scanId: scan.uniqueScanId,
    valid: errors.length === 0,
    masterMatch: Boolean(master),
    errors,
    requiredFields: {
      partNumber: Boolean(scan.partNumber),
      dealerCode: Boolean(scan.dealerCode),
      scanType: scan.scanType,
      qty: scan.quantity,
      rawScanString: Boolean(scan.rawScanString)
    }
  });
  if (errors.length) {
    if (!master && scan.partNumber) {
      await logMasterValidationFailure(scan, 'Not Found In Master');
      await masterValidation.rejectNotInMasterScan({
        ...scan,
        rawScannedValue: scan.rawScanString,
        extractedPartNumber: scan.partNumber,
        originalScanId: scan.uniqueScanId,
        source: normalizeSource(scan.source.source || scan.source.scanSource, 'mobile'),
        sourceRoute: req.originalUrl,
        defaultScanMode: 'Mobile'
      }, console);
    }
    logSync('scan validation failed', { deviceId: scan.deviceId, scanId: scan.uniqueScanId, errors });
    return { status: 'failed', scan, error: !master && scan.partNumber ? 'Part not found in master. Scan rejected.' : errors.join(', ') };
  }

  const manualEntry = isManualEntry(scan);
  scan.qrFingerprint = manualEntry ? '' : makeQrFingerprint(scan);
  if (scan.scanType === 'OUTWARD' && scan.qrFingerprint) scan.qrFingerprint = `OUTWARD:${scan.qrFingerprint}`;
  const policy = manualEntry ? { ok: true } : await scanPolicyResult(scan);
  if (!policy.ok) {
    if (policy.existing) await logDuplicateScan(scan, policy.existing, policy.reason);
    logSync('scan policy blocked', { status: policy.status, reason: policy.reason, deviceId: scan.deviceId, scanId: scan.uniqueScanId, existingId: policy.existing && policy.existing._id });
    return { status: policy.status, scan: policy.existing || scan, error: policy.message || policy.reason };
  }

  const warnings = [];
  if (!master) warnings.push(`Part not found in Master Catalogue: ${scan.partNumber}`);
  if (master && !master.activeStatus) warnings.push('Inactive part');
  const finalQty = Number(scan.quantity || 1);
  const finalBin = scan.binLocation;

  let doc;
  try {
    doc = await Inventory.create({
    uniqueScanId: scan.uniqueScanId,
    scanId: scan.uniqueScanId,
    qrFingerprint: scan.qrFingerprint,
    part: scan.partNumber,
    partNumber: scan.partNumber,
    normalizedPartNumber: scan.normalizedPartNumber || scan.partNumber,
    partName: master && master.partName ? master.partName : scan.partName,
    partDescription: master ? (master.partDescription || master.partName || '') : scan.partDescription || scan.partName,
    model: master && master.model ? master.model : clean(scan.source.model),
    year: master && (master.manufacturingYear || master.year) ? (master.manufacturingYear || master.year) : clean(scan.source.manufacturingYear || scan.source.year),
    manufacturingYear: master && (master.manufacturingYear || master.year) ? (master.manufacturingYear || master.year) : clean(scan.source.manufacturingYear || scan.source.year),
    category: normalizeCategory(master && (master.productCategory || master.category) ? (master.productCategory || master.category) : clean(scan.source.productCategory || scan.source.category)),
    productCategory: normalizeCategory(master && (master.productCategory || master.category) ? (master.productCategory || master.category) : clean(scan.source.productCategory || scan.source.category)),
    productGroup: master ? master.productGroup || '' : clean(scan.source.productGroup).toUpperCase(),
    partSubGroup: master ? master.partSubGroup || '' : clean(scan.source.partSubGroup || scan.source.productSubGroup).toUpperCase(),
    qty: finalQty,
    quantity: finalQty,
    mrp: master && master.mrp !== undefined ? master.mrp : scan.mrp,
    dlc: master && master.dlc !== undefined ? master.dlc : inventory.numberValue(scan.source.dlc, 0),
    bin: finalBin,
    binLocation: finalBin,
    type: scan.scanType,
    scanType: scan.scanType,
    upiId: scan.upiId,
    upiNo: scan.upiNo || scan.upiId,
    dealerCode: scan.dealerCode,
    dealerName: scan.dealerName || (dealer ? dealer.dealerName : ''),
    auditId: scan.auditId || (dealer ? dealer.currentAuditId : ''),
    rawScan: scan.rawScanString,
    rawScanString: scan.rawScanString,
    rawBarcode: scan.rawScanString,
    rawQR: scan.rawScanString,
    rawUpi: scan.rawScanString,
    deviceId: scan.deviceId,
    deviceName: scan.deviceName,
    userId: scan.userId || (req.user ? req.user.id : ''),
    loginId: scan.loginId || (req.user ? req.user.username || req.user.email : ''),
    staffName: scan.staffName || (req.user ? req.user.name : ''),
    userName: scanUserName(req, scan),
    role,
    timestamp: scan.timestamp,
    synced: true,
    isSynced: true,
    syncKey: scan.syncKey,
    syncStatus: 'synced',
    scanStatus: scan.scanType === 'OUTWARD' ? 'OUTWARD_DONE' : 'ACCEPTED',
    syncError: '',
    source: normalizeSource(scan.scanSource || scan.source.source || scan.source.scanSource, 'mobile'),
    warnings,
    remarks: warnings.join(', '),
    masterFound: Boolean(master),
    masterMatch: Boolean(master),
    isMasterMatched: Boolean(master)
    });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    const existing = await Inventory.findOne(duplicateQuery(scan)).lean();
    if (existing) await logDuplicateScan(scan, existing);
    return { status: 'duplicate', scan: existing || scan, error: 'Duplicate scan skipped' };
  }

  logSync('DB insert success', { id: doc._id, deviceId: doc.deviceId, partNumber: doc.partNumber, dealerCode: doc.dealerCode, syncKey: doc.syncKey });
  console.log('SAVED_VALID_SCAN', { id: doc._id, partNumber: doc.partNumber, dealerCode: doc.dealerCode, source: 'mobile' });
  await emitEnterpriseRealtime(req.io || req.app.get('io'), [doc]);
  return { status: 'synced', scan: doc, error: '' };
}

async function syncSummary(activePort) {
  await Device.updateMany({ status: 'online', lastSeen: { $lt: liveCutoff() } }, { status: 'offline' });
  const [pendingRecords, failedRecords, totalSynced, connectedDevices] = await Promise.all([
    Inventory.countDocuments({ $or: [{ syncStatus: 'pending' }, { isSynced: false }] }),
    Inventory.countDocuments({ syncStatus: 'failed' }),
    Inventory.countDocuments({ $or: [{ syncStatus: 'synced' }, { isSynced: true }, { synced: true }] }),
    Device.countDocuments({ status: 'online', lastSeen: { $gte: liveCutoff() } })
  ]);
  const info = serverInfo(activePort);

  return {
    serverStatus: 'online',
    mongoStatus: mongoose.connection.readyState === 1 ? 'online' : 'offline',
    db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    lastSyncTime: new Date(),
    totalSynced,
    pendingRecords,
    failedRecords,
    connectedDevices,
    ip: info.ip,
    port: info.port,
    serverUrl: info.serverUrl,
    healthUrl: info.healthUrl,
    connectUrl: info.connectUrl,
    syncUrl: info.syncUrl
  };
}

async function pushHandler(req, res) {
  const io = req.io || req.app.get('io');
  const startedAt = new Date();
  try {
    const body = Array.isArray(req.body) ? { scans: req.body } : req.body || {};
    if (isLocalhostUrl(body.serverUrl)) {
      return res.status(400).json({ success: false, message: 'Do not use localhost on mobile. Use the cloud server URL from pairing QR.' });
    }

    const incomingRaw = incomingScansFromBody(body);
    logSync('server request received', {
      route: req.originalUrl,
      method: req.method,
      deviceId: clean(body.deviceId || (incomingRaw[0] && incomingRaw[0].deviceId)),
      receivedCount: incomingRaw.length,
      bodyKeys: Object.keys(body).slice(0, 30),
      sample: incomingRaw.map((item) => ({
        scanId: clean(item.scanId || item.uniqueScanId || item.mobileScanId || item.localId),
        partNumber: clean(item.partNumber || item.partNo || item.part || item.sku || item.itemCode),
        dealerCode: clean(item.dealerCode || item.dealer),
        scanType: clean(item.scanType || item.action || item.type),
        qty: clean(item.qty || item.quantity),
        rawBarcode: clean(item.rawBarcode || item.rawScanValue || item.rawScan || item.rawScanString),
        upiId: clean(item.upiId || item.upiSequence || item.id)
      }))
    });
    if (!incomingRaw.length) {
      logSync('request rejected', { reason: 'No scan records in request', bodyKeys: Object.keys(body).slice(0, 20) });
      return res.status(400).json({
        success: false,
        message: 'No scan records received from mobile. Please scan an item first, then sync again.',
        receivedCount: 0,
        insertedCount: 0,
        syncedCount: 0,
        synced: 0,
        duplicateCount: 0,
        failedCount: 0,
        failed: 0,
        invalidCleanedCount: 0
      });
    }
    const activeAudit = await getActiveAudit();
    if (!activeAudit) {
      logSync('request rejected', { reason: 'No active audit', receivedCount: incomingRaw.length });
      return res.json({
        success: false,
        message: 'No active audit found. Please start audit from PC Admin.',
        activeAudit: null,
        receivedCount: incomingRaw.length,
        failedCount: incomingRaw.length,
        failed: incomingRaw.length
      });
    }
    const activeAuditPayload = publicAudit(activeAudit);
    const requestedDealerCode = upper(body.dealerCode || (incomingRaw[0] && incomingRaw[0].dealerCode));
    if (requestedDealerCode && requestedDealerCode !== upper(activeAudit.dealerCode)) {
      const payload = {
        success: false,
        message: `Wrong dealer mapping. Active audit dealer is ${upper(activeAudit.dealerCode)}, received ${requestedDealerCode}.`,
        receivedCount: incomingRaw.length,
        insertedCount: 0,
        verifiedInsertedCount: 0,
        duplicateCount: 0,
        failedCount: incomingRaw.length,
        verificationResult: 'wrong_dealer_mapping',
        diagnostics: {
          failedStage: 'DEALER SELECTED',
          recommendedFix: 'Select the dealer linked to the active audit before scanning or start the correct audit from admin.'
        }
      };
      await SyncLog.create({
        deviceId: clean(body.deviceId || (incomingRaw[0] && incomingRaw[0].deviceId)),
        dealerCode: requestedDealerCode,
        auditId: activeAuditPayload.auditId,
        route: req.originalUrl,
        status: 'rejected',
        receivedCount: incomingRaw.length,
        failedCount: incomingRaw.length,
        message: payload.message,
        diagnostics: payload.diagnostics
      }).catch(() => undefined);
      return res.status(409).json(payload);
    }
    const incoming = incomingRaw.map((item) => ({
      ...item,
      dealerCode: activeAudit.dealerCode,
      dealerName: activeAudit.dealerName,
      auditId: activeAudit.auditId,
      deviceId: item.deviceId || body.deviceId,
      serverUrl: item.serverUrl || body.serverUrl
    }));
    const deviceId = clean(body.deviceId || (incoming[0] && incoming[0].deviceId));
    const dealerCode = upper(activeAudit.dealerCode);
    const requestUserContext = await resolveScanUserContext(req, { ...body, deviceId });
    const logs = [];
    const failedRows = [];
    const errors = [];
    let invalidCleanedCount = 0;

    if (io) {
      io.emit('sync:started', { startedAt, count: incoming.length, deviceId });
      logSync('socket broadcast success', { event: 'sync:started', count: incoming.length, deviceId });
    }

    const normalized = incoming.map((item, index) => {
      const scan = applyActiveAudit(normalizeScan({ ...item, deviceId: item.deviceId || deviceId }), activeAudit);
      applyUserContext(scan, requestUserContext);
      return { index, scan };
    });
    normalized.forEach(({ scan }) => {
      if (isManualEntry(scan)) scan.qrFingerprint = '';
    });
    const partNumbers = Array.from(new Set(normalized.map((item) => item.scan.partNumber).filter(Boolean)));
    const dealerCodes = Array.from(new Set(normalized.map((item) => item.scan.dealerCode).filter(Boolean)));
    const normalizedScanIds = normalized.map((item) => item.scan.uniqueScanId).filter(Boolean);
    const normalizedQrFingerprints = normalized.map((item) => item.scan.qrFingerprint).filter(Boolean);
    const normalizedRawScans = normalized
      .filter((item) => !isManualEntry(item.scan))
      .map((item) => item.scan.rawScanString)
      .filter(Boolean);
    const normalizedUpiNos = normalized
      .filter((item) => !isManualEntry(item.scan))
      .map((item) => item.scan.upiNo || item.scan.upiId)
      .filter(Boolean);
    const [catalogueMasters, legacyMasters, dealers, existingScans] = await Promise.all([
      MasterCatalogue.find({ normalizedPartNumber: { $in: partNumbers } }).lean(),
      MasterPart.find({ $or: [{ normalizedPartNumber: { $in: partNumbers } }, { partNo: { $in: partNumbers } }, { partNumber: { $in: partNumbers } }] }).lean(),
      Dealer.find({ dealerCode: { $in: dealerCodes } }).lean(),
      Inventory.find({
        $or: [
          { uniqueScanId: { $in: normalizedScanIds } },
          { scanId: { $in: normalizedScanIds } },
          { qrFingerprint: { $in: normalizedQrFingerprints } },
          { dealerCode, rawScan: { $in: normalizedRawScans } },
          { dealerCode, rawScanString: { $in: normalizedRawScans } },
          { dealerCode, rawUpi: { $in: normalizedRawScans } },
          { dealerCode, upiNo: { $in: normalizedUpiNos } },
          { dealerCode, upiId: { $in: normalizedUpiNos } }
        ]
      }).select('uniqueScanId scanId qrFingerprint rawScan rawScanString rawUpi upiNo upiId dealerCode binLocation bin').lean()
    ]);
    const masterByPart = new Map();
    const masterByDealer = new Map();
    catalogueMasters.map(cataloguePayload).concat(legacyMasters).forEach((master) => {
      const partNo = normalizePartNumber(master.normalizedPartNumber || master.partNo || master.partNumber);
      if (!partNo) return;
      if (!masterByPart.has(partNo)) masterByPart.set(partNo, master);
      if (master.dealerCode) masterByDealer.set(`${partNo}::${upper(master.dealerCode)}`, master);
    });
    const dealerByCode = new Map(dealers.map((dealer) => [dealer.dealerCode, dealer]));
    const existingScanIds = new Set();
    const existingIdentityByKey = new Map();
    existingScans.forEach((scan) => {
      const identity = { uniqueScanId: scan.uniqueScanId, scanId: scan.scanId, qrFingerprint: scan.qrFingerprint };
      const scanDealer = upper(scan.dealerCode);
      const scanBin = upper(scan.binLocation || scan.bin);
      if (scan.uniqueScanId) {
        existingScanIds.add(scan.uniqueScanId);
        existingIdentityByKey.set(scan.uniqueScanId, identity);
      }
      if (scan.scanId) {
        existingScanIds.add(scan.scanId);
        existingIdentityByKey.set(scan.scanId, identity);
      }
      if (scan.qrFingerprint) {
        existingScanIds.add(scan.qrFingerprint);
        existingIdentityByKey.set(scan.qrFingerprint, identity);
      }
      [scan.rawScan, scan.rawScanString, scan.rawUpi].filter(Boolean).forEach((raw) => {
        const key = `${scanDealer}::${scanBin}::RAW::${clean(raw)}`;
        existingScanIds.add(key);
        existingIdentityByKey.set(key, identity);
      });
      [scan.upiNo, scan.upiId].filter(Boolean).forEach((upi) => {
        const key = `${scanDealer}::${scanBin}::UPI::${upper(upi)}`;
        existingScanIds.add(key);
        existingIdentityByKey.set(key, identity);
      });
    });
    const duplicateScanIds = new Set();
    let operations = [];
    let insertDocs = [];
    let insertMeta = [];

    normalized.forEach(({ index, scan }) => {
      const master = masterByDealer.get(`${scan.normalizedPartNumber || scan.partNumber}::${upper(scan.dealerCode)}`) || masterByPart.get(scan.normalizedPartNumber || scan.partNumber);
      console.log('RAW_SCAN_RECEIVED', scan.rawScanString || scan.partNumber || '');
      console.log('EXTRACTED_PART_NUMBER', scan.partNumber || '');
      console.log('MASTER_MATCH_FOUND', Boolean(master));
      if (!scan.dealerCode && master && master.dealerCode) scan.dealerCode = master.dealerCode;
      const dealer = scan.dealerCode ? dealerByCode.get(scan.dealerCode) : null;

      const rowErrors = [];
      if (!scan.partNumber) rowErrors.push('partNumber missing');
      if (scan.partNumber && !isValidPartNumber(scan.partNumber)) rowErrors.push('invalid partNumber format');
      if (!scan.binLocation) rowErrors.push(BIN_REQUIRED_MESSAGE);
      if (!scan.dealerCode) rowErrors.push('dealerCode missing');
      if (!VALID_TYPES.includes(scan.scanType)) rowErrors.push('invalid scanType');
      if (!(scan.timestamp instanceof Date) || Number.isNaN(scan.timestamp.getTime())) rowErrors.push('invalid timestamp');
      if (scan.quantity === undefined || scan.quantity === null || Number.isNaN(Number(scan.quantity))) rowErrors.push('qty missing or invalid');
      if (!master) rowErrors.push(`Part number not found in master: ${scan.partNumber}`);

      if (rowErrors.length) {
        const isInvalidLocalRecord = rowErrors.some((reason) => /scanId missing|partNumber missing/.test(reason));
        if (!master && scan.partNumber) {
          logMasterValidationFailure(scan, 'Not Found In Master').catch(() => undefined);
          masterValidation.rejectNotInMasterScan({
            ...scan,
            rawScannedValue: scan.rawScanString,
            extractedPartNumber: scan.partNumber,
            originalScanId: scan.uniqueScanId,
            source: normalizeSource(scan.scanSource || scan.source.source || scan.source.scanSource, 'mobile'),
            sourceRoute: req.originalUrl,
            defaultScanMode: 'Sync'
          }, console).catch(() => undefined);
        }
        const failed = {
          row: index + 1,
          scanId: scan.uniqueScanId,
          partNumber: scan.partNumber,
          reason: rowErrors.join(', '),
          status: isInvalidLocalRecord ? 'invalid' : 'failed'
        };
        if (isInvalidLocalRecord) invalidCleanedCount += 1;
        failedRows.push(failed);
        logs.push({
          time: new Date(),
          partNumber: scan.partNumber,
          dealer: scan.dealerCode,
          syncKey: scan.syncKey,
          status: isInvalidLocalRecord ? 'invalid' : 'failed',
          errorMessage: !master && scan.partNumber ? 'Part not found in master. Scan rejected.' : (isInvalidLocalRecord ? 'Invalid record cleaned' : failed.reason)
        });
        logSync('row validation failed', {
          row: index + 1,
          rawScanReceived: scan.rawScanString,
          extractedPartNumber: scan.partNumber,
          scanId: scan.uniqueScanId,
          partNumber: scan.partNumber,
          dealerCode: scan.dealerCode,
          scanType: scan.scanType,
          masterMatch: Boolean(master),
          qty: scan.quantity,
          rawScanString: scan.rawScanString,
          errors: rowErrors
        });
        return;
      }

      const manualEntry = isManualEntry(scan);
      const identityBin = upper(scan.binLocation || scan.bin);
      const rawIdentityKey = !manualEntry && clean(scan.rawScanString) ? `${upper(scan.dealerCode)}::${identityBin}::RAW::${clean(scan.rawScanString)}` : '';
      const upiIdentityKey = !manualEntry && upper(scan.upiNo || scan.upiId) ? `${upper(scan.dealerCode)}::${identityBin}::UPI::${upper(scan.upiNo || scan.upiId)}` : '';
      if (!manualEntry && (existingScanIds.has(scan.uniqueScanId) || existingScanIds.has(scan.qrFingerprint) || (rawIdentityKey && existingScanIds.has(rawIdentityKey)) || (upiIdentityKey && existingScanIds.has(upiIdentityKey)) || duplicateScanIds.has(scan.uniqueScanId) || duplicateScanIds.has(scan.qrFingerprint) || (rawIdentityKey && duplicateScanIds.has(rawIdentityKey)) || (upiIdentityKey && duplicateScanIds.has(upiIdentityKey)))) {
        duplicateScanIds.add(scan.uniqueScanId);
        duplicateScanIds.add(scan.qrFingerprint);
        if (rawIdentityKey) duplicateScanIds.add(rawIdentityKey);
        if (upiIdentityKey) duplicateScanIds.add(upiIdentityKey);
        const existingIdentity = existingIdentityByKey.get(rawIdentityKey) || existingIdentityByKey.get(upiIdentityKey) || existingIdentityByKey.get(scan.uniqueScanId) || existingIdentityByKey.get(scan.qrFingerprint) || {};
        logDuplicateScan(scan, existingIdentity, 'Duplicate scanId skipped').catch(() => undefined);
        logSync('duplicate scan skipped', {
          row: index + 1,
          scanId: scan.uniqueScanId,
          qrFingerprint: scan.qrFingerprint,
          partNumber: scan.partNumber,
          dealerCode: scan.dealerCode,
          existing: existingIdentity || 'same request batch'
        });
        logs.push({ time: new Date(), partNumber: scan.partNumber, upiId: scan.upiId, dealer: scan.dealerCode, syncKey: scan.syncKey, status: 'duplicate', errorMessage: 'Duplicate scanId skipped' });
        return;
      }
      duplicateScanIds.add(scan.uniqueScanId);
      scan.qrFingerprint = manualEntry ? '' : makeQrFingerprint(scan);
      duplicateScanIds.add(scan.qrFingerprint);
      if (rawIdentityKey) duplicateScanIds.add(rawIdentityKey);
      if (upiIdentityKey) duplicateScanIds.add(upiIdentityKey);

      const finalQty = Number(scan.quantity || 1);
      const finalBin = scan.binLocation;
      const doc = {
        uniqueScanId: scan.uniqueScanId,
        scanId: scan.uniqueScanId,
        qrFingerprint: scan.qrFingerprint,
        part: scan.partNumber,
        partNumber: scan.partNumber,
        normalizedPartNumber: scan.normalizedPartNumber || scan.partNumber,
        partName: master ? master.partDescription || master.partName || '' : scan.partName || '',
        partDescription: master ? master.partDescription || master.partName || '' : scan.partDescription || scan.partName || '',
        model: master && master.model ? master.model : clean(scan.source.model),
        year: master && (master.manufacturingYear || master.year) ? (master.manufacturingYear || master.year) : clean(scan.source.manufacturingYear || scan.source.year),
        manufacturingYear: master && (master.manufacturingYear || master.year) ? (master.manufacturingYear || master.year) : clean(scan.source.manufacturingYear || scan.source.year),
        category: normalizeCategory(master && (master.productCategory || master.category) ? (master.productCategory || master.category) : scan.category || clean(scan.source.productCategory || scan.source.category)),
        productCategory: normalizeCategory(master && (master.productCategory || master.category) ? (master.productCategory || master.category) : scan.category || clean(scan.source.productCategory || scan.source.category)),
        productGroup: master ? master.productGroup || '' : clean(scan.source.productGroup).toUpperCase(),
        partSubGroup: master ? master.partSubGroup || '' : clean(scan.source.partSubGroup || scan.source.productSubGroup).toUpperCase(),
        qty: finalQty,
        quantity: finalQty,
        mrp: master && master.mrp !== undefined ? master.mrp : scan.mrp,
        dlc: master && master.dlc !== undefined ? master.dlc : inventory.numberValue(scan.source.dlc, 0),
        bin: finalBin,
        binLocation: finalBin,
        type: scan.scanType,
        scanType: scan.scanType,
        upiId: scan.upiId,
        upiNo: scan.upiNo || scan.upiId,
        dealerCode: scan.dealerCode,
        dealerName: scan.dealerName || (dealer ? dealer.dealerName : ''),
        auditId: scan.auditId || (dealer ? dealer.currentAuditId : ''),
        rawScan: scan.rawScanString,
        rawScanString: scan.rawScanString,
        rawBarcode: scan.rawScanString,
        rawQR: scan.rawScanString,
        rawUpi: scan.rawScanString,
        deviceId: scan.deviceId,
        deviceName: scan.deviceName,
        userId: scan.userId || (req.user ? req.user.id : ''),
        loginId: scan.loginId || (req.user ? req.user.username || req.user.email : ''),
        staffName: scan.staffName || (req.user ? req.user.name : ''),
        userName: scanUserName(req, scan),
        role: scanRole(req, scan),
        timestamp: scan.timestamp,
        synced: true,
        isSynced: true,
        syncKey: scan.syncKey,
        syncStatus: 'synced',
        syncError: '',
        source: normalizeSource(scan.scanSource || scan.source.source || scan.source.scanSource, 'mobile'),
        warnings: master ? [] : [`Part not found in Master Catalogue: ${scan.partNumber}`],
        remarks: master ? '' : `Part not found in Master Catalogue: ${scan.partNumber}`,
        masterFound: Boolean(master),
        masterMatch: Boolean(master),
        isMasterMatched: Boolean(master)
      };
      insertDocs.push(doc);
      insertMeta.push({ row: index + 1, scanId: doc.uniqueScanId, partNumber: doc.partNumber });
      operations.push({ insertOne: { document: doc } });
      console.log('SAVED_VALID_SCAN', { scanId: doc.uniqueScanId, partNumber: doc.partNumber, dealerCode: doc.dealerCode, source: 'sync' });
    });

    const manualBatch = new Map();
    const mergedDocs = [];
    const mergedMeta = [];
    insertDocs.forEach((doc, index) => {
      const key = manualMergeKey(doc);
      if (!key) {
        mergedDocs.push(doc);
        mergedMeta.push(insertMeta[index]);
        return;
      }
      const existing = manualBatch.get(key);
      if (existing) {
        const addQty = Number(doc.qty || doc.quantity || 0);
        existing.doc.qty = Number(existing.doc.qty || 0) + addQty;
        existing.doc.quantity = Number(existing.doc.quantity || 0) + addQty;
        existing.doc.rawScan = [existing.doc.rawScan, doc.rawScan].filter(Boolean).join(' | ');
        existing.doc.rawScanString = [existing.doc.rawScanString, doc.rawScanString].filter(Boolean).join(' | ');
        existing.doc.rawUpi = [existing.doc.rawUpi, doc.rawUpi].filter(Boolean).join(' | ');
        if (new Date(doc.timestamp) > new Date(existing.doc.timestamp || 0)) existing.doc.timestamp = doc.timestamp;
        return;
      }
      const entry = { doc, meta: insertMeta[index] };
      manualBatch.set(key, entry);
      mergedDocs.push(doc);
      mergedMeta.push(insertMeta[index]);
    });
    insertDocs = mergedDocs;
    insertMeta = mergedMeta;
    operations = insertDocs.map((doc) => ({ insertOne: { document: doc } }));

    const manualUpdatedScans = [];
    if (insertDocs.length) {
      const remainingDocs = [];
      const remainingMeta = [];
      for (let index = 0; index < insertDocs.length; index += 1) {
        const doc = insertDocs[index];
        const key = manualMergeKey(doc);
        if (!key) {
          remainingDocs.push(doc);
          remainingMeta.push(insertMeta[index]);
          continue;
        }
        const existing = await Inventory.findOneAndUpdate(
          {
            dealerCode: doc.dealerCode,
            normalizedPartNumber: doc.normalizedPartNumber || doc.partNumber,
            scanType: doc.scanType,
            binLocation: doc.binLocation || '',
            source: 'manual',
            syncStatus: { $ne: 'deleted' }
          },
          {
            $inc: { qty: Number(doc.qty || 0), quantity: Number(doc.quantity || doc.qty || 0) },
            $set: {
              timestamp: doc.timestamp,
              lastManualMergedAt: new Date(),
              syncStatus: 'synced',
              synced: true,
              isSynced: true
            }
          },
          { sort: { timestamp: -1, createdAt: -1 }, new: true }
        ).lean();
        if (existing) {
          manualUpdatedScans.push(existing);
          logs.push({
            time: new Date(),
            partNumber: existing.partNumber || existing.part,
            upiId: existing.upiId,
            dealer: existing.dealerCode,
            syncKey: existing.syncKey,
            status: 'inserted',
            errorMessage: ''
          });
          continue;
        }
        remainingDocs.push(doc);
        remainingMeta.push(insertMeta[index]);
      }
      insertDocs = remainingDocs;
      insertMeta = remainingMeta;
      operations = insertDocs.map((doc) => ({ insertOne: { document: doc } }));
    }

    let insertedCount = 0;
    const failedOperationIndexes = new Set();
    if (operations.length) {
      logSync('DB insert attempt', {
        collection: Inventory.collection.name,
        recordsCount: operations.length,
        sample: insertDocs.map((doc) => ({
          scanId: doc.uniqueScanId,
          partNumber: doc.partNumber,
          dealerCode: doc.dealerCode,
          syncKey: doc.syncKey
        }))
      });
      try {
        const result = await Inventory.bulkWrite(operations, { ordered: false });
        insertedCount = result.insertedCount || 0;
      } catch (error) {
        const writeErrors = error.writeErrors || error.result?.result?.writeErrors || [];
        writeErrors.forEach((writeError) => {
          const opIndex = writeError.index;
          failedOperationIndexes.add(opIndex);
          const doc = insertDocs[opIndex] || {};
          const meta = insertMeta[opIndex] || {};
          const isDuplicate = writeError.code === 11000;
          const failed = {
            row: meta.row || opIndex + 1,
            scanId: doc.uniqueScanId,
            partNumber: doc.partNumber,
            reason: isDuplicate ? 'Duplicate scanId skipped' : writeError.errmsg || writeError.message || 'Insert failed'
          };
          if (isDuplicate) {
            duplicateScanIds.add(doc.uniqueScanId);
            logDuplicateScan(doc, {}, failed.reason).catch(() => undefined);
            logSync('duplicate scan skipped', {
              row: failed.row,
              scanId: doc.uniqueScanId,
              qrFingerprint: doc.qrFingerprint,
              partNumber: doc.partNumber,
              dealerCode: doc.dealerCode,
              reason: failed.reason
            });
            logs.push({ time: new Date(), partNumber: doc.partNumber, dealer: doc.dealerCode, syncKey: doc.syncKey, status: 'duplicate', errorMessage: failed.reason });
          } else {
            logSync('DB insert failure', {
              row: failed.row,
              scanId: doc.uniqueScanId,
              partNumber: doc.partNumber,
              dealerCode: doc.dealerCode,
              reason: failed.reason
            });
            failedRows.push(failed);
            errors.push(failed.reason);
            logs.push({ time: new Date(), partNumber: doc.partNumber, dealer: doc.dealerCode, syncKey: doc.syncKey, status: 'failed', errorMessage: failed.reason });
          }
        });
        insertedCount = error.result?.insertedCount || error.result?.result?.nInserted || (operations.length - failedOperationIndexes.size);
        if (!writeErrors.length) throw error;
      }
    }

    const insertedScanIds = insertDocs
      .filter((doc, index) => !failedOperationIndexes.has(index) && !existingScanIds.has(doc.uniqueScanId))
      .map((doc) => doc.uniqueScanId);
    const savedScans = insertedScanIds.length
      ? await Inventory.find({ uniqueScanId: { $in: insertedScanIds } }).lean()
      : [];
    savedScans.push(...manualUpdatedScans);
    const verifiedInsertedCount = savedScans.length;
    if (insertedCount !== verifiedInsertedCount) {
      logSync('DB insert verification mismatch', {
        reportedInsertedCount: insertedCount,
        verifiedInsertedCount,
        insertedScanIds
      });
      insertedCount = verifiedInsertedCount;
    }

    savedScans.forEach((scan) => {
      console.log("Matched category:", scan.category || '');
      console.log("Matched partDescription:", scan.partDescription || scan.partName || '');
      logs.push({
        time: new Date(),
        partNumber: scan.partNumber || scan.part,
        upiId: scan.upiId,
        dealer: scan.dealerCode,
        syncKey: scan.syncKey,
        status: 'inserted',
        errorMessage: ''
      });
    });

    const duplicateCount = logs.filter((log) => log.status === 'duplicate').length;
    const failedCount = failedRows.filter((row) => row.status !== 'invalid').length;
    logSync('DB batch result', {
      collection: Inventory.collection.name,
      insertedCount,
      verifiedInsertedCount,
      duplicateCount,
      failedCount,
      invalidCleanedCount,
      failedRows
    });

    if (deviceId) {
      const info = serverInfo(req.app.locals.activePort);
      await Device.findOneAndUpdate(
        { deviceId },
        {
          deviceId,
          deviceName: clean(body.deviceName || 'Scanner Device'),
          model: clean(body.model),
          deviceType: 'mobile',
          approved: true,
          dealerCode,
          dealerName: activeAuditPayload.dealerName,
          auditId: activeAuditPayload.auditId,
          userId: requestUserContext.userId || '',
          loginId: requestUserContext.loginId || '',
          userName: requestUserContext.userName || '',
          staffName: requestUserContext.staffName || '',
          role: requestUserContext.role || '',
          serverUrl: clean(body.serverUrl || info.serverUrl),
          status: 'online',
          lastSeen: new Date(),
          lastSyncTime: new Date(),
          syncStatus: failedCount ? 'failed' : 'working',
          appVersion: clean(body.appVersion || body.version),
          batteryPercent: body.batteryPercent ?? body.battery,
          failedCount
        },
        { upsert: true, setDefaultsOnInsert: true }
      );
      if (io) io.emit('device:heartbeat', { deviceId, dealerCode, status: 'online', lastSeen: new Date() });
    }

    const summary = await syncSummary(req.app.locals.activePort);
    await emitEnterpriseRealtime(io, savedScans);
    const acceptedCount = insertedCount + duplicateCount;
    const allRowsRejected = incomingRaw.length > 0 && acceptedCount === 0 && (failedCount > 0 || invalidCleanedCount > 0);
    const payload = {
      success: !allRowsRejected,
      activeAudit: activeAuditPayload,
      dealerCode: activeAuditPayload.dealerCode,
      dealerName: activeAuditPayload.dealerName,
      auditId: activeAuditPayload.auditId,
      receivedCount: incomingRaw.length,
      insertedCount,
      startedAt,
      completedAt: new Date(),
      syncedCount: insertedCount,
      duplicateCount,
      failedCount,
      failedRows,
      invalidCleanedCount,
      dbCollection: Inventory.collection.name,
      insertedRecords: savedScans.map(scanPublicDebug),
      verifiedInsertedCount,
      synced: insertedCount,
      duplicates: duplicateCount,
      failed: failedCount,
      message: allRowsRejected
        ? 'No mobile scans were saved. Please check failed rows and scan data.'
        : (insertedCount ? `Sync completed: ${insertedCount} scan${insertedCount === 1 ? '' : 's'} saved` : duplicateCount ? 'Duplicate scans skipped' : 'Sync completed'),
      messages: [
        allRowsRejected ? 'No mobile scans were saved' : 'Sync completed',
        duplicateCount ? 'Duplicate scans skipped' : '',
        invalidCleanedCount ? 'Invalid records cleaned' : ''
      ].filter(Boolean),
      errors,
      logs,
      verificationResult: {
        backendAccepted: !allRowsRejected,
        exactInsertedCount: insertedCount,
        exactDuplicateCount: duplicateCount,
        exactFailedCount: failedCount,
        verifiedInsertedCount,
        fakeSuccessPrevented: allRowsRejected
      },
      diagnostics: {
        failedStage: allRowsRejected ? 'DATABASE INSERTED' : failedCount ? 'SYNC QUEUE ACTIVE' : '',
        recommendedFix: allRowsRejected
          ? 'No records were inserted. Check failedRows and retry after correcting scan data.'
          : failedCount
            ? 'Some records failed. Review failedRows and retry failed queue from Sync Center.'
            : 'Sync workflow healthy.'
      },
      ...summary
    };

    await SyncLog.create({
      deviceId,
      dealerCode,
      auditId: activeAuditPayload.auditId,
      route: req.originalUrl,
      status: allRowsRejected ? 'failed' : failedCount ? 'partial' : 'success',
      receivedCount: incomingRaw.length,
      insertedCount,
      duplicateCount,
      failedCount,
      invalidCleanedCount,
      message: payload.message,
      diagnostics: payload.diagnostics,
      logs
    }).catch((error) => logSync('sync log write failed', { message: error.message }));

    if (io) {
      io.emit('sync:completed', payload);
      io.emit('syncData', payload);
      logSync('socket broadcast success', { events: ['sync:completed', 'syncData'], insertedCount, duplicateCount, failedCount, deviceId });
    }
    logSync('success response', { insertedCount, duplicateCount, failedCount, totalSynced: payload.totalSynced, deviceId });
    return res.status(allRowsRejected ? 422 : 200).json(payload);
  } catch (error) {
    const payload = { success: false, startedAt, failedAt: new Date(), message: error.message };
    logSync('failure response', { message: error.message, stack: error.stack });
    if (io) io.emit('sync:failed', payload);
    return res.status(500).json(payload);
  }
}

router.post('/push', auth.optionalAuth, pushHandler);
router.post('/mobile', auth.optionalAuth, pushHandler);

router.get('/status', auth.optionalAuth, async (req, res) => {
  try {
    const [summary, lastLog] = await Promise.all([
      syncSummary(req.app.locals.activePort),
      SyncLog.findOne({}).sort({ createdAt: -1 }).lean()
    ]);
    res.json({ success: true, ...summary, syncEngineStatus: 'running', lastApiResponse: lastLog || null });
  } catch (error) {
    res.status(500).json({ success: false, serverStatus: 'online', mongoStatus: 'offline', db: 'disconnected', message: error.message });
  }
});

router.get('/logs', auth.requireAuth, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 100), 500);
    const filter = {};
    if (req.query.deviceId) filter.deviceId = clean(req.query.deviceId);
    if (req.query.dealerCode) filter.dealerCode = upper(req.query.dealerCode);
    const logs = await SyncLog.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ success: true, count: logs.length, logs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/pending', auth.requireAuth, async (req, res) => {
  try {
    const records = await Inventory.find({ $or: [{ syncStatus: 'pending' }, { syncStatus: 'failed' }, { isSynced: false }] })
      .sort({ createdAt: 1 })
      .limit(500)
      .lean();
    res.json({ success: true, records, count: records.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/debug/latest', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 25), 100);
    const dealerCode = upper(req.query.dealerCode);
    const auditId = clean(req.query.auditId);
    const filter = {};
    if (dealerCode) filter.dealerCode = dealerCode;
    if (auditId) filter.auditId = auditId;
    const [totalRecords, syncedRecords, latestRecords] = await Promise.all([
      Inventory.countDocuments(filter),
      Inventory.countDocuments({ ...filter, $or: [{ syncStatus: 'synced' }, { synced: true }, { isSynced: true }] }),
      Inventory.find(filter).sort({ timestamp: -1, createdAt: -1 }).limit(limit).lean()
    ]);
    return res.json({
      success: true,
      collection: Inventory.collection.name,
      filter,
      totalRecords,
      syncedRecords,
      latestRecords: latestRecords.map(scanPublicDebug)
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/retry', auth.optionalAuth, async (req, res) => {
  req.body.records = Array.isArray(req.body.records) ? req.body.records : [];
  return pushHandler(req, res);
});

router.pushHandler = pushHandler;
router.syncSummary = syncSummary;
router.normalizeScan = normalizeScan;
router.saveNormalizedScan = saveNormalizedScan;
router.emitEnterpriseRealtime = emitEnterpriseRealtime;

module.exports = router;
