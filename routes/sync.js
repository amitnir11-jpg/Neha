const express = require('express');
const { randomUUID } = require('crypto');
const Inventory = require('../models/Inventory');
const Bin = require('../models/Bin');
const MasterPart = require('../models/MasterPart');
const Dealer = require('../models/Dealer');
const Device = require('../models/Device');
const SyncLog = require('../models/SyncLog');
const SkewEvent = require('../models/SkewEvent');
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
const { dateDebugPayload, formatIstDateTime, validDate: validTimestamp } = require('../utils/time');
const { decorateScanValue, money } = require('../utils/inventoryValueEngine');
const { findPricePeriod, pricePeriodPayload } = require('../utils/priceHistory');
const duplicatePolicy = require('../utils/scanDuplicatePolicy');
const { isDatabaseReady } = require('../services/prisma');

const router = express.Router();
const VALID_TYPES = ['AUDIT', 'INWARD', 'OUTWARD', 'VERIFICATION', 'FITTED', 'DAMAGE'];
const BIN_REQUIRED_MESSAGE = 'Please enter/select bin location first.';
const SYNC_VERBOSE_LOGS = process.env.SYNC_VERBOSE_LOGS === 'true';

/**
 * ====================================================================
 * SYNC ROUTE - INVENTORY VALUE CALCULATION COMPLIANCE
 * ====================================================================
 *
 * CRITICAL BUSINESS RULE:
 *   finalInventoryValue = qty × valuationMRP
 *
 * WHERE valuationMRP MUST BE:
 *   1. Manual MRP (if user entered manually)
 *   2. Scanned UPI MRP (if from QR/barcode)
 *   3. Parsed MRP from raw scan payload
 *   4. Current catalogue/master MRP fallback when QR has no price
 *   5. Stored valuationMRP only with correct source flag
 *
 * ENFORCEMENT:
 *   - decorateScanValue() from inventoryValueEngine.js sets valuationMRP
 *   - valuationFields() calls decorateScanValue()
 *   - finalInventoryValue calculated using valuationFields.valuationMRP
 *   - Manual batch merges use existing valuationMRP (not master)
 *
 * VALIDATION:
 *   - All valuationMRP values must have corresponding valuationSource
 *   - valuationSource must be 'MANUAL_ENTERED_MRP', 'UPI_SCANNED_MRP', or 'CATALOGUE_MRP_FALLBACK'
 *   - If valuationMRP = 0, valuationSource must be 'NO_SCANNED_OR_MANUAL_MRP'
 *
 * ====================================================================
 */
const NO_OUTWARD_STOCK_MESSAGE = 'Part not available in inward stock.';

function clean(value) {
  return String(value || '').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function validDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function newestDate(...values) {
  return values
    .map(validDate)
    .filter(Boolean)
    .sort((a, b) => b.getTime() - a.getTime())[0] || null;
}

async function latestSuccessfulSyncTime(dealerCode = '') {
  const dealer = upper(dealerCode);
  const syncFilter = dealer ? { dealerCode: dealer } : {};
  const inventoryFilter = { ...syncFilter, $and: [nonVerificationScanClause()] };
  const [lastLog, lastDevice, lastInventory] = await Promise.all([
    SyncLog.findOne({ ...syncFilter, status: { $in: ['success', 'partial'] } }).sort({ updatedAt: -1, createdAt: -1 }).select('updatedAt createdAt').lean(),
    Device.findOne({ ...syncFilter, lastSyncTime: { $exists: true, $ne: null } }).sort({ lastSyncTime: -1 }).select('lastSyncTime').lean(),
    Inventory.findOne({ ...inventoryFilter, $or: [{ syncStatus: 'synced' }, { isSynced: true }, { synced: true }] }).sort({ updatedAt: -1, timestamp: -1 }).select('updatedAt timestamp').lean()
  ]);
  return newestDate(
    lastLog && (lastLog.updatedAt || lastLog.createdAt),
    lastDevice && lastDevice.lastSyncTime,
    lastInventory && (lastInventory.updatedAt || lastInventory.timestamp)
  );
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
  if (type === 'VERIFY') return 'VERIFICATION';
  return type;
}

function rawIdentity(scan = {}) {
  return clean(scan.rawScanString || scan.rawScan || scan.rawBarcode || scan.rawQR || scan.rawUpi || scan.upiNo || scan.upiId);
}

function acceptedStatuses() {
  return ['ACCEPTED', 'SUPERVISOR_APPROVED', 'OUTWARD_DONE'];
}

function nonVerificationScanClause() {
  return { $nor: [{ scanType: 'VERIFICATION' }, { type: 'VERIFICATION' }] };
}

function scanQtyExpression() {
  const qty = {
    $convert: {
      input: { $ifNull: ['$qty', { $ifNull: ['$quantity', 0] }] },
      to: 'double',
      onError: 0,
      onNull: 0
    }
  };
  const type = { $toUpper: { $toString: { $ifNull: ['$scanType', { $ifNull: ['$type', ''] }] } } };
  return {
    $switch: {
      branches: [
        { case: { $eq: [type, 'INWARD'] }, then: { $abs: qty } },
        { case: { $in: [type, ['OUTWARD', 'FITTED', 'DAMAGE']] }, then: { $multiply: [{ $abs: qty }, -1] } },
        { case: { $eq: [type, 'VERIFICATION'] }, then: 0 }
      ],
      default: 0
    }
  };
}

function inwardQtyExpression() {
  const qty = {
    $convert: {
      input: { $ifNull: ['$qty', { $ifNull: ['$quantity', 0] }] },
      to: 'double',
      onError: 0,
      onNull: 0
    }
  };
  const type = { $toUpper: { $toString: { $ifNull: ['$scanType', { $ifNull: ['$type', ''] }] } } };
  return {
    $cond: [
      { $eq: [type, 'INWARD'] },
      { $abs: qty },
      0
    ]
  };
}

async function autoDetectOutwardBin(scan = {}) {
  const dealerCode = upper(scan.dealerCode);
  const partNumber = normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part);
  if (!dealerCode || !partNumber) return null;
  const match = {
    dealerCode,
    scanStatus: { $in: acceptedStatuses() },
    syncStatus: 'synced',
    isDuplicate: { $ne: true },
    $or: [
      { normalizedPartNumber: partNumber },
      { partNumber },
      { part: partNumber }
    ],
    $and: [
      {
        $or: [
          { binLocation: { $nin: [null, ''] } },
          { bin: { $nin: [null, ''] } }
        ]
      }
    ]
  };
  match.$and = (match.$and || []).concat([nonVerificationScanClause()]);
  if (scan.auditId) match.auditId = clean(scan.auditId);
  const rows = await Inventory.aggregate([
    { $match: match },
    {
      $addFields: {
        _outwardBin: {
          $trim: {
            input: { $toString: { $ifNull: ['$binLocation', { $ifNull: ['$bin', ''] }] } }
          }
        },
        _outwardQty: scanQtyExpression(),
        _inwardQty: inwardQtyExpression()
      }
    },
    { $match: { _outwardBin: { $nin: ['', 'NULL', 'UNDEFINED'] } } },
    {
      $group: {
        _id: '$_outwardBin',
        availableQty: { $sum: '$_outwardQty' },
        inwardQty: { $sum: '$_inwardQty' },
        oldestScanTime: { $min: '$timestamp' },
        oldestCreatedAt: { $min: '$createdAt' }
      }
    },
    { $match: { inwardQty: { $gt: 0 }, availableQty: { $gt: 0 } } }
  ]);
  if (!rows.length) return null;
  const binCodes = rows.map((row) => upper(row._id)).filter(Boolean);
  const bins = await Bin.find({ dealerCode, binCode: { $in: binCodes } }).lean().catch(() => []);
  const priorityByBin = new Map(bins.map((bin) => [
    upper(bin.binCode),
    Number(bin.priority ?? bin.binPriority ?? bin.sequence ?? bin.sortOrder ?? Number.MAX_SAFE_INTEGER)
  ]));
  rows.sort((a, b) => {
    const priorityA = priorityByBin.get(upper(a._id)) ?? Number.MAX_SAFE_INTEGER;
    const priorityB = priorityByBin.get(upper(b._id)) ?? Number.MAX_SAFE_INTEGER;
    if (priorityA !== priorityB) return priorityA - priorityB;
    return new Date(a.oldestScanTime || a.oldestCreatedAt || 0) - new Date(b.oldestScanTime || b.oldestCreatedAt || 0)
      || String(a._id).localeCompare(String(b._id), undefined, { numeric: true, sensitivity: 'base' });
  });
  return {
    binLocation: upper(rows[0]._id),
    availableQty: Number(rows[0].availableQty || 0)
  };
}

function scanIdentityScope(filter = {}, scan = {}) {
  const dealerCode = upper(scan.dealerCode || '');
  const auditId = clean(scan.auditId || '');
  if (dealerCode) filter.dealerCode = dealerCode;
  if (auditId) filter.auditId = auditId;
  return filter;
}

function identityUserKey(scan = {}) {
  return clean(scan.userId || scan.loginId || scan.userName || scan.staffName);
}

function identitySessionKey(scan = {}) {
  return clean(scan.auditId || scan.sessionId || scan.auditSessionId || '');
}

async function activeAuditForDealer(dealerCode = '') {
  const code = upper(dealerCode);
  return code ? getActiveAudit({ dealerCode: code }) : getActiveAudit();
}

function noActiveAuditMessage(dealerCode = '') {
  const code = upper(dealerCode);
  return code
    ? `No active audit found for dealer ${code}. Please start audit from PC Admin.`
    : 'No active audit found. Please start audit from PC Admin.';
}

function inboundAcceptedFilter(raw, scan = {}) {
  return scanIdentityScope({
    scanType: 'INWARD',
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
  if (role === 'scanner') return scanType === 'OUTWARD' ? 'Scanner users cannot perform OUTWARD scans' : '';
  return '';
}

function logSync(stage, details = {}) {
  if (!SYNC_VERBOSE_LOGS) return;
  const safeDetails = { ...details };
  if (Array.isArray(safeDetails.sample)) safeDetails.sample = safeDetails.sample.slice(0, 3);
  void stage;
  void safeDetails;
}

async function logMasterValidationFailure(scan = {}, reason = 'Not Found In Master') {
  try {
    if (upper(scan.scanType || scan.type || '') === 'VERIFICATION') return;
    if (!masterValidation.isManualRejectedSource({
      ...scan,
      source: normalizeSource(scan.scanSource || scan.source?.source || scan.source?.scanSource || scan.source, 'mobile'),
      defaultScanMode: 'Mobile'
    })) return;
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
    clientScanId: scan.clientScanId,
    clientSyncKey: scan.clientSyncKey,
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
    scanTime: scan.scanTime || scan.timestamp,
    createdAt: scan.createdAt,
    mrp: Number(scan.mrp || 0),
    scanMRP: Number(scan.scanMRP || 0),
    manualMRP: Number(scan.manualMRP || 0),
    valuationMRP: Number(scan.valuationMRP || scan.mrp || 0),
    valuationSource: scan.valuationSource || '',
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
  if (/manual/.test(source)) return 'manual';
  if (/ocr|ai/.test(source)) return 'ocr_label';
  if (/^qr$|qr[_\s-]*scan/.test(source)) return 'qr';
  if (/barcode/.test(source)) return 'barcode';
  if (/camera|mobile/.test(source)) return 'mobile';
  if (['manual', 'scanner', 'import', 'api', 'ocr_label', 'qr'].includes(source)) return source;
  return fallback;
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanFlag(value) {
  return value === true || value === 1 || String(value).trim().toLowerCase() === 'true' || String(value).trim() === '1';
}

function numericValue(value, fallback = 0) {
  if (inventory.numberValue) return inventory.numberValue(value, fallback);
  const parsed = optionalNumber(value);
  return parsed === undefined ? fallback : parsed;
}

function requestedQuantity(scan = {}, fallback = 1) {
  const source = scan.source && typeof scan.source === 'object' ? scan.source : {};
  const value = firstValue(source, ['qty', 'quantity', 'count'])
    || firstValue(scan, ['qty', 'quantity', 'count'])
    || fallback;
  const qty = Math.abs(numericValue(value, fallback));
  return qty > 0 ? qty : fallback;
}

function hasScanFlag(scan = {}, keys = []) {
  const source = scan.source && typeof scan.source === 'object' ? scan.source : {};
  return keys.some((key) => booleanFlag(scan[key]) || booleanFlag(source[key]));
}

function publicScanRow(scan = {}) {
  return inventory.publicScan ? inventory.publicScan(scan) : scan;
}

function manualDuplicatePayload(existing = {}, requestedQty = 1) {
  if (typeof inventory.manualDuplicatePayload === 'function') {
    return inventory.manualDuplicatePayload(existing, requestedQty);
  }
  const partNumber = normalizePartNumber(existing.normalizedPartNumber || existing.partNumber || existing.part || '');
  const binLocation = upper(existing.binLocation || existing.bin || '');
  const existingQty = numericValue(existing.qty !== undefined ? existing.qty : existing.quantity, 0);
  const addQty = Math.abs(numericValue(requestedQty, 1));
  return {
    manualDuplicate: true,
    partNumber,
    binLocation,
    existingQty,
    requestedQty: addQty,
    message: `Part ${partNumber} is already available in bin ${binLocation}. Current quantity: ${existingQty}. Do you want to add ${addQty} more?`
  };
}

async function addFittedQuantity(existing = {}, scan = {}, req = {}) {
  const addQty = requestedQuantity(scan, 1);
  if (!(addQty > 0)) return { error: 'Quantity to add must be greater than zero.' };
  const updated = await Inventory.findByIdAndUpdate(existing._id, {
    $inc: { qty: addQty, quantity: addQty, fittedQty: addQty },
    $set: {
      fittedLocation: 'VEHICLE',
      status: 'FITTED_ON_VEHICLE',
      syncStatus: 'synced',
      synced: true,
      isSynced: true
    }
  }, { new: true }).lean();
  const publicRow = publicScanRow(updated || existing);
  const io = req.io || (req.app && typeof req.app.get === 'function' ? req.app.get('io') : null);
  if (io) {
    io.emit('scan:saved', publicRow);
    io.emit('inventory:update', { reason: 'fitted-quantity-added', scan: publicRow, dealerCode: publicRow.dealerCode || '', auditId: publicRow.auditId || '', at: new Date() });
    io.emit('reports:update', { reason: 'fitted-quantity-added', scan: publicRow, dealerCode: publicRow.dealerCode || '', auditId: publicRow.auditId || '', at: new Date() });
    io.emit('stats:update');
  }
  return { updated: publicRow, addQty };
}

function duplicateResult(policy = {}, scan = {}) {
  const existing = policy.existing || scan;
  return {
    status: policy.status || 'duplicate',
    httpStatus: 409,
    scan: existing,
    existing,
    error: policy.message || policy.reason || 'Duplicate scan skipped',
    message: policy.message || policy.reason || 'Duplicate scan skipped',
    duplicate: true,
    skipped: true,
    upiDuplicate: Boolean(policy.upiDuplicate),
    manualDuplicate: Boolean(policy.manualDuplicate),
    fittedDuplicate: Boolean(policy.fittedDuplicate),
    requestedQty: policy.requestedQty,
    existingQty: policy.existingQty,
    binLocation: policy.binLocation || upper(existing.binLocation || existing.bin || scan.binLocation || scan.bin || ''),
    partNumber: policy.partNumber || normalizePartNumber(existing.normalizedPartNumber || existing.partNumber || existing.part || scan.partNumber || scan.part || ''),
    reason: policy.reason || ''
  };
}

async function confirmedDuplicateUpdate(policy = {}, scan = {}, req = {}) {
  const source = scan.source && typeof scan.source === 'object' ? scan.source : {};
  if (policy.manualDuplicate && hasScanFlag(scan, ['addManualQuantity', 'confirmAddQuantity'])) {
    if (typeof inventory.addManualQuantity !== 'function') {
      return { status: 'failed', httpStatus: 400, scan: policy.existing || scan, error: 'Manual quantity update is not available.' };
    }
    const addQty = requestedQuantity(scan, 1);
    const result = await inventory.addManualQuantity(policy.existing, {
      ...source,
      ...scan,
      qty: addQty,
      quantity: addQty,
      manualAddRequestId: source.manualAddRequestId || scan.manualAddRequestId || scan.uniqueScanId || scan.scanId || scan.clientScanId || scan.syncKey
    }, req);
    if (result.error) return { status: 'failed', httpStatus: 400, scan: policy.existing || scan, error: result.error };
    const newQty = numericValue(result.updated.qty !== undefined ? result.updated.qty : result.updated.quantity, 0);
    return {
      status: 'synced',
      httpStatus: 200,
      scan: result.updated,
      updated: true,
      duplicate: false,
      alreadyApplied: Boolean(result.alreadyApplied),
      addedQuantity: result.alreadyApplied ? 0 : result.addQty,
      newQuantity: newQty,
      error: '',
      message: result.alreadyApplied
        ? `Quantity was already added. Current quantity: ${newQty}.`
        : `Added ${result.addQty} more. New quantity: ${newQty}.`
    };
  }
  if (policy.fittedDuplicate && hasScanFlag(scan, ['addFittedQuantity', 'confirmAddQuantity'])) {
    const result = await addFittedQuantity(policy.existing, scan, req);
    if (result.error) return { status: 'failed', httpStatus: 400, scan: policy.existing || scan, error: result.error };
    const newQty = numericValue(result.updated.qty !== undefined ? result.updated.qty : result.updated.quantity, 0);
    return {
      status: 'synced',
      httpStatus: 200,
      scan: result.updated,
      updated: true,
      duplicate: false,
      alreadyApplied: false,
      addedQuantity: result.addQty,
      newQuantity: newQty,
      error: '',
      message: 'Fitted part quantity updated for this vehicle/job card'
    };
  }
  return null;
}

function valuationFields({ scan = {}, rawScanText = '', scannedMrp, mrpProvided = false, manualEntry = false, master = null } = {}) {
  const source = normalizeSource(scan.scanSource || scan.source?.source || scan.source?.scanSource || scan.source, manualEntry ? 'manual' : 'mobile');
  const valued = decorateScanValue({
    rawScan: rawScanText,
    rawScanString: rawScanText,
    source: manualEntry ? 'manual' : source,
    scanMode: manualEntry ? 'Manual' : source,
    scanMRP: !manualEntry && mrpProvided ? scannedMrp : undefined,
    manualMRP: manualEntry && mrpProvided ? scannedMrp : undefined
  });
  return {
    mrp: Number(valued.valuationMRP || 0),
    scanMRP: Number(valued.scanMRP || 0),
    manualMRP: Number(valued.manualMRP || 0),
    valuationMRP: Number(valued.valuationMRP || 0),
    valuationSource: valued.valuationSource || 'NO_SCANNED_OR_MANUAL_MRP'
  };
}

function existingHasPositiveMrp(scan = {}) {
  return [
    scan.finalMRP,
    scan.finalMrp,
    scan.valuationMRP,
    scan.valuationMrp,
    scan.scanMRP,
    scan.scanMrp,
    scan.manualMRP,
    scan.manualMrp,
    scan.mrp
  ].some((value) => Number(value || 0) > 0);
}

async function backfillDuplicateMrp(existing = {}, scan = {}, { manualEntry = false } = {}) {
  if (!existing || !existing._id || existingHasPositiveMrp(existing) || !scan.mrpProvided) return existing;
  const scannedMrp = optionalNumber(scan.mrp);
  if (!(Number(scannedMrp || 0) > 0)) return existing;
  const valueFields = valuationFields({ scan, rawScanText: scan.rawScanString, scannedMrp, mrpProvided: true, manualEntry });
  if (!(Number(valueFields.valuationMRP || 0) > 0)) return existing;
  const pricePeriod = await findPricePeriod(scan.partNumber || existing.partNumber || existing.part, scan.timestamp || scan.serverReceivedAt || new Date(), valueFields.valuationMRP).catch(() => null);
  const quantity = Number(existing.quantity || existing.qty || scan.quantity || 1);
  const update = {
    mrp: valueFields.mrp,
    scanMRP: valueFields.scanMRP,
    manualMRP: valueFields.manualMRP,
    valuationMRP: valueFields.valuationMRP,
    valuationSource: valueFields.valuationSource,
    finalInventoryValue: quantity * Number(valueFields.valuationMRP || 0),
    finalMRP: valueFields.valuationMRP,
    mrpStatus: 'AVAILABLE',
    mrpPendingUpdatedAt: new Date(),
    ...pricePeriodPayload(pricePeriod, valueFields.valuationMRP)
  };
  await Inventory.updateOne({ _id: existing._id }, { $set: update });
  return { ...existing, ...update };
}

function makeScanId(item = {}, timestamp = new Date()) {
  const explicit = clean(item.scanId || item.uniqueScanId || item.mobileScanId || item.localId);
  if (explicit) return explicit;
  if (randomUUID) return randomUUID();
  const deviceId = clean(item.deviceId || 'DEVICE').replace(/\s+/g, '-');
  const time = timestamp instanceof Date && !Number.isNaN(timestamp.getTime()) ? timestamp.getTime() : Date.now();
  return `${deviceId}-${time}-${Math.random().toString(36).slice(2, 10)}`;
}

function ackMetaFromScan(scan = {}, row = 0) {
  const source = scan.source && typeof scan.source === 'object' ? scan.source : {};
  const clientScanId = clean(scan.clientScanId || source.clientScanId || source.localId || source.mobileScanId || source.scanId || source.uniqueScanId);
  const clientSyncKey = clean(scan.clientSyncKey || source.clientSyncKey || source.localSyncKey || source.syncKey || clientScanId);
  const scanId = clean(scan.uniqueScanId || scan.scanId || clientScanId);
  return {
    row,
    scanId,
    uniqueScanId: scanId,
    clientScanId,
    clientSyncKey,
    localId: clientScanId,
    mobileScanId: clientScanId,
    syncKey: clean(scan.syncKey || clientSyncKey),
    partNumber: clean(scan.partNumber || scan.part),
    upiId: clean(scan.upiId || scan.upiNo),
    dealer: clean(scan.dealerCode)
  };
}

function ackList(meta = {}) {
  const list = Array.isArray(meta.acks) && meta.acks.length ? meta.acks : [meta];
  return list.map((item) => ({
    ...item,
    clientScanId: clean(item.clientScanId || item.localId || item.mobileScanId),
    clientSyncKey: clean(item.clientSyncKey || item.localSyncKey || item.syncKey || item.clientScanId || item.localId)
  }));
}

function syncLogFromAck(scan = {}, meta = {}, status = 'inserted', errorMessage = '') {
  const uniqueScanId = clean(scan.uniqueScanId || scan.scanId || meta.uniqueScanId || meta.scanId);
  const clientScanId = clean(meta.clientScanId || meta.localId || meta.mobileScanId || scan.clientScanId);
  const clientSyncKey = clean(meta.clientSyncKey || scan.clientSyncKey || clientScanId);
  return {
    time: new Date(),
    partNumber: clean(scan.partNumber || scan.part || meta.partNumber),
    upiId: clean(scan.upiId || scan.upiNo || meta.upiId),
    dealer: clean(scan.dealerCode || meta.dealer),
    syncKey: clean(scan.syncKey || meta.syncKey || clientSyncKey || uniqueScanId),
    scanId: clean(meta.scanId || uniqueScanId),
    uniqueScanId,
    clientScanId,
    clientSyncKey,
    localId: clientScanId,
    mobileScanId: clientScanId,
    status,
    errorMessage
  };
}

function mobileTimestamp(item = {}) {
  return firstValue(item, [
    'timestamp',
    'scanTime',
    'scannedAt',
    'scanDateTime',
    'dateTime',
    'createdAt',
    'localCreatedAt',
    'localTimestamp'
  ]);
}

function scanTimestamp(item = {}) {
  return item.serverReceivedAt instanceof Date && !Number.isNaN(item.serverReceivedAt.getTime())
    ? item.serverReceivedAt
    : new Date();
}

function liveCutoff() {
  return new Date(Date.now() - 30 * 1000);
}

function normalizeScan(item = {}) {
  const serverReceivedAt = item.serverReceivedAt instanceof Date && !Number.isNaN(item.serverReceivedAt.getTime())
    ? item.serverReceivedAt
    : new Date();
  const receivedMobileTimestamp = mobileTimestamp(item);
  const explicitScanId = clean(item.scanId || item.uniqueScanId || item.mobileScanId || item.localId);
  const clientScanId = clean(item.clientScanId || item.localId || item.mobileScanId || explicitScanId);
  const clientSyncKey = clean(item.clientSyncKey || item.localSyncKey || item.syncKey || clientScanId);
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
  const timestamp = scanTimestamp({ ...item, serverReceivedAt });
  const dealerCode = upper(item.dealerCode || item.dealer || item.dealerId || parsed.dealerCode);
  const scanSource = normalizeSource(item.source?.source || item.source?.scanSource || item.scanSource || item.source, 'mobile');
  const rawHasValue = Boolean(rawScan);
  const explicitPartNumber = firstValue(item, ['partNumber', 'partNo', 'part', 'sku', 'itemCode']);
  const partNumber = normalizePartNumber(scanSource === 'manual'
    ? (explicitPartNumber || parsed.part)
    : (parsed.part || (rawHasValue ? '' : explicitPartNumber)));
  const scanType = normalizeScanType(item.scanType || item.action || item.type || item.movement || parsed.type || 'INWARD');
  const binLocation = clean(item.binLocation || item.bin || item.location || parsed.bin);
  const regdNo = upper(item.regdNo || item.regNo || item.registrationNo || item.regdNumber || item.vehicleRegNo);
  const jobCardNo = upper(item.jobCardNo || item.jobcardNo || item.jobCard || item.jobcard || item.jobNo);
  const upiId = clean(item.upiNo || item.upiId || item.upiID || item.upiSequence || item.upiScanId || item.transactionId || item.txnId || inventory.extractUpiId(item, parsed));
  const upiNo = upiId;
  const syncKey = clean(item.syncKey || inventory.buildSyncKey({ dealerCode, upiId, partNumber, scanType, timestamp }));
  const quantity = inventory.numberValue(firstValue(item, ['quantity', 'qty', 'count']) || parsed.qty, 1);
  const idSource = scanSource === 'manual'
    ? { deviceId: item.deviceId }
    : { ...item, deviceId: item.deviceId };
  const uniqueScanId = explicitScanId || makeScanId(idSource, timestamp);
  const itemMrpValue = firstValue(item, ['mrp', 'scanMRP', 'scanMrp', 'scannedMRP', 'scannedMrp', 'upiMRP', 'upiMrp', 'valuationMRP', 'valuationMrp', 'finalMRP', 'finalMrp']);
  const itemMrpNumber = optionalNumber(itemMrpValue);
  const itemMrpFlag = item.mrpProvided === true || String(item.mrpProvided).toLowerCase() === 'true';
  const itemMrpSuppressed = item.mrpProvided === false || String(item.mrpProvided).toLowerCase() === 'false';
  const itemMrpProvided = itemMrpFlag || (!itemMrpSuppressed && itemMrpNumber !== undefined && Number(itemMrpNumber) > 0);
  const parsedMrpProvided = parsed.mrpProvided === true || String(parsed.mrpProvided).toLowerCase() === 'true';
  const mrpProvided = itemMrpProvided || parsedMrpProvided;
  const itemDlcValue = firstValue(item, ['dlc', 'manualDLC', 'manualDlc', 'manualEnteredDLC', 'manualEnteredDlc']);
  const itemDlcNumber = optionalNumber(itemDlcValue);
  const itemDlcFlag = item.dlcProvided === true || String(item.dlcProvided).toLowerCase() === 'true';
  const itemDlcSuppressed = item.dlcProvided === false || String(item.dlcProvided).toLowerCase() === 'false';
  const itemDlcProvided = itemDlcFlag || (!itemDlcSuppressed && itemDlcNumber !== undefined);
  const parsedDlcProvided = parsed.dlcProvided === true || String(parsed.dlcProvided).toLowerCase() === 'true';
  const dlcProvided = itemDlcProvided || parsedDlcProvided;

  return {
    source: item,
    serverReceivedAt,
    mobileReceivedTime: receivedMobileTimestamp,
    mobileReceivedTimeUtc: validTimestamp(receivedMobileTimestamp)?.toISOString() || '',
    scanSource,
    parsed,
    clientScanId,
    clientSyncKey,
    syncKey,
    uniqueScanId,
    scanId: uniqueScanId,
    scanIdProvided: Boolean(explicitScanId),
    partNumber,
    normalizedPartNumber: partNumber,
    partName: clean(item.partDescription || item.partName),
    partDescription: clean(item.partDescription || item.partName),
    binLocation,
    regdNo,
    jobCardNo,
    isFitted: scanType === 'FITTED',
    fittedQty: scanType === 'FITTED' ? quantity : 0,
    autoDetectedBin: item.autoDetectedBin === true || String(item.autoDetectedBin).toLowerCase() === 'true',
    binSelectionMode: upper(item.binSelectionMode),
    stockDeductedFromBin: upper(item.stockDeductedFromBin),
    quantity,
    mrp: mrpProvided ? inventory.numberValue(itemMrpProvided && itemMrpNumber !== undefined ? itemMrpNumber : parsed.mrp, 0) : undefined,
    mrpProvided,
    dlc: dlcProvided ? inventory.numberValue(itemDlcProvided && itemDlcNumber !== undefined ? itemDlcNumber : parsed.dlc, 0) : undefined,
    dlcProvided,
    scanType,
    upiId,
    upiNo,
    rawScanString: rawScan || (scanSource === 'manual' ? partNumber : ''),
    dealerCode,
    dealerName: clean(item.dealerName),
    auditId: clean(item.auditId || parsed.auditId),
    staffName: clean(item.staffName || parsed.staffName),
    userName: clean(item.userName || item.staffName || parsed.userName || parsed.staffName),
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
  scan.rawUpiHash = duplicatePolicy.rawUpiHash(scan);
  scan.globalUpiKey = duplicatePolicy.globalUpiKey(scan);
  return scan;
}

function duplicateQuery(scan) {
  if (upper(scan.scanType || scan.type) === 'FITTED') {
    return inventory.fittedIdentityFilter(scan) || { uniqueScanId: '__missing__' };
  }
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
  const filter = {
    scanStatus: { $in: acceptedStatuses() },
    syncStatus: 'synced',
    isDuplicate: { $ne: true },
    scanType: upper(scan.scanType || scan.type),
    $or: terms.length ? terms : [{ uniqueScanId: '__missing__' }]
  };
  const userKey = identityUserKey(scan);
  if (userKey) {
    const userKeys = Array.from(new Set([userKey, userKey.toLowerCase()].filter(Boolean)));
    filter.$and = (filter.$and || []).concat([{
      $or: [
        { userId: { $in: userKeys } },
        { loginId: { $in: userKeys } },
        { userName: { $in: userKeys } },
        { staffName: { $in: userKeys } }
      ]
    }]);
  }
  const sessionKey = identitySessionKey(scan);
  if (sessionKey) filter.auditId = sessionKey;
  return scanIdentityScope(filter, scan);
}

function isManualEntry(scan = {}) {
  return normalizeSource(scan.scanSource || scan.source?.source || scan.source?.scanSource || scan.source, 'mobile') === 'manual';
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
  const firstScan = publicScans[0] || {};
  const dashboardFilter = {};
  if (firstScan.dealerCode) dashboardFilter.dealerCode = upper(firstScan.dealerCode);
  if (firstScan.auditId) dashboardFilter.auditId = clean(firstScan.auditId);
  const realtimePayload = {
    source: 'sync-api',
    scans: publicScans,
    count: publicScans.length,
    at: new Date(),
    dealerCode: dashboardFilter.dealerCode || '',
    auditId: dashboardFilter.auditId || ''
  };
  io.emit('reports:update', realtimePayload);
  io.emit('warehouse:feed', realtimePayload);
  io.emit('syncData', realtimePayload);
  try {
    const recentFilter = { ...dashboardFilter };
    if (inventory.nonVerificationScanClause) {
      recentFilter.$and = (recentFilter.$and || []).concat([inventory.nonVerificationScanClause()]);
    }
    const [statsResult, recentRows] = await Promise.all([
      dashboardFilter.dealerCode && inventory.dashboardStats ? inventory.dashboardStats(dashboardFilter) : null,
      Inventory.find(recentFilter).sort({ timestamp: -1, createdAt: -1 }).limit(10).lean()
    ]);
    const stats = statsResult ? {
      ...statsResult,
      dealerCode: dashboardFilter.dealerCode || statsResult.dealerCode || '',
      auditId: dashboardFilter.auditId || statsResult.auditId || ''
    } : null;
    const recent = recentRows.map((scan) => inventory.publicScan ? inventory.publicScan(scan) : scan);
    const updatePayload = {
      ...realtimePayload,
      stats,
      recent,
      totalScannedCount: stats ? stats.totalScanRecords : undefined
    };
    if (stats) {
      io.emit('stats:update', updatePayload);
      io.emit('scan:count:update', updatePayload);
    }
    io.emit('scan:last10:update', updatePayload);
    io.emit('dashboard:update', updatePayload);
    io.emit('inventory:update', updatePayload);
  } catch (error) {
    logSync('realtime dashboard payload failed', { message: error.message });
  }
  logSync('socket broadcast success', { count: publicScans.length, events: ['scan:new', 'scan:saved', 'scanData', 'reports:update', 'syncData', 'dashboard:update'] });
}

async function scanPolicyResult(scan = {}) {
  scan.globalUpiKey = scan.globalUpiKey || duplicatePolicy.globalUpiKey(scan);
  const globalFilter = duplicatePolicy.globalUpiDuplicateFilter(scan);
  const globalDuplicate = globalFilter ? await Inventory.findOne(globalFilter).sort({ timestamp: 1, createdAt: 1 }).lean() : null;
  if (globalDuplicate) {
    return {
      ok: false,
      status: 'duplicate',
      existing: globalDuplicate,
      upiDuplicate: true,
      reason: 'Global duplicate UPI',
      message: duplicatePolicy.duplicateUpiMessage(globalDuplicate)
    };
  }
  if (scan.scanType === 'FITTED') {
    const duplicate = await Inventory.findOne(duplicateQuery(scan)).sort({ timestamp: 1, createdAt: 1 }).lean();
    if (duplicate) {
      const requestedQty = requestedQuantity(scan, 1);
      return {
        ok: false,
        status: 'duplicate',
        existing: duplicate,
        fittedDuplicate: true,
        requestedQty,
        existingQty: numericValue(duplicate.qty !== undefined ? duplicate.qty : duplicate.quantity, 0),
        partNumber: normalizePartNumber(duplicate.normalizedPartNumber || duplicate.partNumber || duplicate.part || scan.partNumber),
        reason: 'Fitted part already exists for this vehicle/job card',
        message: 'This fitted part already exists for this vehicle/job card. Add quantity?'
      };
    }
    return { ok: true };
  }
  if (isManualEntry(scan) && ['INWARD', 'DAMAGE'].includes(scan.scanType)) {
    const manualFilter = duplicatePolicy.manualBinDuplicateFilter(scan);
    const manualDuplicate = manualFilter ? await Inventory.findOne(manualFilter).sort({ timestamp: 1, createdAt: 1 }).lean() : null;
    if (manualDuplicate) {
      const payload = manualDuplicatePayload(manualDuplicate, requestedQuantity(scan, 1));
      return {
        ok: false,
        status: 'duplicate',
        existing: manualDuplicate,
        ...payload,
        reason: 'Manual duplicate in same bin'
      };
    }
  }
  scan.rawUpiHash = scan.rawUpiHash || duplicatePolicy.rawUpiHash(scan);
  const identityFilter = duplicatePolicy.identityDuplicateFilter(scan);
  const identityDuplicate = identityFilter ? await Inventory.findOne(identityFilter).sort({ timestamp: 1, createdAt: 1 }).lean() : null;
  if (identityDuplicate) {
    return { ok: false, status: 'duplicate', existing: identityDuplicate, reason: 'Duplicate exact UPI/barcode or scan id', message: 'Duplicate exact UPI/barcode already scanned.' };
  }
  const businessFilter = duplicatePolicy.businessDuplicateFilter(scan);
  const businessDuplicate = businessFilter ? await Inventory.findOne(businessFilter).sort({ timestamp: 1, createdAt: 1 }).lean() : null;
  if (businessDuplicate) {
    return { ok: false, status: 'duplicate', existing: businessDuplicate, reason: duplicatePolicy.DUPLICATE_PART_MESSAGE, message: duplicatePolicy.DUPLICATE_PART_MESSAGE };
  }
  const raw = rawIdentity(scan);
  if (scan.scanType === 'OUTWARD') {
    const outwardDone = raw ? await Inventory.findOne(outwardDoneFilter(raw, scan)).lean() : null;
    if (outwardDone) {
      return { ok: false, status: 'duplicate', existing: outwardDone, reason: 'Duplicate QR/UPI already outwarded', message: 'This QR/UPI is already outwarded and cannot be outwarded again.' };
    }
    const inbound = raw ? await Inventory.findOne(inboundAcceptedFilter(raw, scan)).sort({ timestamp: 1, createdAt: 1 }).lean() : null;
    if (!inbound) {
      return { ok: true };
    }
    return { ok: true, sourceScan: inbound };
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
  const requestedDealerCode = upper(scan.dealerCode || req.body?.dealerCode || req.query?.dealerCode);
  const activeAudit = await activeAuditForDealer(requestedDealerCode);
  if (!activeAudit) {
    logSync('scan rejected', { reason: 'No active audit', requestedDealerCode, deviceId: scan.deviceId, scanId: scan.uniqueScanId });
    return { status: 'failed', scan, error: noActiveAuditMessage(requestedDealerCode) };
  }
  applyActiveAudit(scan, activeAudit);
  applyUserContext(scan, await resolveScanUserContext(req, scan));
  if (scan.scanType === 'VERIFICATION') {
    const result = await inventory.verifyPartOnly({
      rawScan: scan.rawScanString,
      partNumber: scan.partNumber,
      dealerCode: scan.dealerCode,
      auditId: scan.auditId
    });
    return { status: 'verification', scan: result, error: result.message };
  }
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
  const manualEntry = isManualEntry(scan);
  const scannedMrp = scan.mrpProvided ? optionalNumber(scan.mrp) : undefined;
  const scannedDlc = scan.dlcProvided ? optionalNumber(scan.dlc) : undefined;
  const valueFields = valuationFields({ scan, rawScanText: scan.rawScanString, scannedMrp, mrpProvided: scan.mrpProvided, manualEntry, master });
  const pricePeriod = valueFields.valuationMRP > 0 ? await findPricePeriod(scan.partNumber, scan.timestamp || scan.serverReceivedAt, valueFields.valuationMRP) : null;
  const pricePeriodFields = pricePeriodPayload(pricePeriod, valueFields.valuationMRP);

  const errors = [];
  if (!scan.partNumber) errors.push('Part number missing');
  if (scan.partNumber && !isValidPartNumber(scan.partNumber)) errors.push('Invalid part number format');
  if (!master) errors.push(`Part not found in Master Catalogue: ${scan.partNumber || scan.rawScanString || 'unknown'}`);
  if (['INWARD', 'DAMAGE'].includes(scan.scanType) && !scan.binLocation) errors.push(BIN_REQUIRED_MESSAGE);
  if (scan.scanType === 'FITTED') {
    inventory.prepareFittedScan(scan, scan.quantity || 1);
    if (!scan.regdNo || !scan.jobCardNo) errors.push('Regd No and Job Card No are required for fitted parts.');
  }
  if (!scan.dealerCode) errors.push('Dealer code missing');
  if (!VALID_TYPES.includes(scan.scanType)) errors.push('Invalid scan type');
  if (!scan.syncKey) errors.push('Sync key missing');
  if (manualEntry && !(Number(scannedMrp || 0) > 0)) errors.push('MRP is mandatory for manual part entry.');
  if (!master && manualEntry) {
    scan.manualMasterMissing = true;
  }
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
    if (!master && scan.partNumber && manualEntry) {
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
    return { status: 'failed', scan, error: errors.join(', ') };
  }

  if (scan.scanType === 'OUTWARD') {
    const detected = await autoDetectOutwardBin(scan);
    if (!detected || !detected.binLocation) {
      logSync('outward auto bin failed', { deviceId: scan.deviceId, scanId: scan.uniqueScanId, partNumber: scan.partNumber });
      return { status: 'failed', scan, error: NO_OUTWARD_STOCK_MESSAGE };
    }
    scan.binLocation = detected.binLocation;
    scan.autoDetectedBin = true;
    scan.binSelectionMode = 'AUTO';
    scan.stockDeductedFromBin = detected.binLocation;
  } else if (['INWARD', 'DAMAGE'].includes(scan.scanType)) {
    scan.binSelectionMode = 'MANUAL';
    scan.autoDetectedBin = false;
    scan.stockDeductedFromBin = '';
  }

  scan.qrFingerprint = manualEntry ? '' : makeQrFingerprint(scan);
  if (scan.scanType === 'FITTED') scan.qrFingerprint = '';
  if (scan.scanType === 'OUTWARD' && scan.qrFingerprint) scan.qrFingerprint = `OUTWARD:${scan.qrFingerprint}`;
  scan.rawUpiHash = duplicatePolicy.rawUpiHash(scan);
  const policy = await scanPolicyResult(scan);
  if (!policy.ok) {
    const confirmedUpdate = await confirmedDuplicateUpdate(policy, scan, req);
    if (confirmedUpdate) return confirmedUpdate;
    if (policy.existing) await logDuplicateScan(scan, policy.existing, policy.reason);
    logSync('scan policy blocked', { status: policy.status, reason: policy.reason, deviceId: scan.deviceId, scanId: scan.uniqueScanId, existingId: policy.existing && policy.existing._id });
    return duplicateResult(policy, scan);
  }

  const warnings = [];
  if (!master) warnings.push(manualEntry ? `Manual part saved without Master Catalogue match: ${scan.partNumber}` : `Part not found in Master Catalogue: ${scan.partNumber}`);
  if (master && !master.activeStatus) warnings.push('Inactive part');
  if (master && scan.mrpProvided && pricePeriod && Math.abs(Number(valueFields.valuationMRP || 0) - Number(pricePeriod.mrp || 0)) > 0.01) warnings.push('MRP mismatch against price history period');
  if (master && scan.mrpProvided && !pricePeriod) warnings.push('No matching price history period for scanned MRP');
  if (master && scan.dlcProvided && scannedDlc !== undefined && Math.abs(Number(scannedDlc || 0) - Number(master.dlc || 0)) > 0.01) warnings.push('DLC mismatch');
  const finalQty = Number(scan.quantity || 1);
  const finalBin = scan.binLocation;
  const finalDlc = scannedDlc !== undefined
    ? scannedDlc
    : master && master.dlc !== undefined
      ? Number(master.dlc || 0)
      : inventory.numberValue(scan.source.dlc, 0);

  // Ensure final saved scan time is server time (serverReceivedAt)
  const finalSavedTime = scan.serverReceivedAt instanceof Date && !Number.isNaN(scan.serverReceivedAt.getTime()) ? scan.serverReceivedAt : new Date();
  // compute mobile time and skew for diagnostics
  const mobileTime = validDate(mobileTimestamp(scan)) || null;
  const skewMs = mobileTime ? Math.abs(finalSavedTime.getTime() - mobileTime.getTime()) : 0;
  // Log detailed debug info per-scan
  try {
    const batchId = scan.syncBatchId || (req && req.body && req.body.syncBatchId) || '';
    const tz = scan.serverTimeZone || (Intl && Intl.DateTimeFormat && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
    logSync('sync debug', {
      batchId,
      dealerCode: scan.dealerCode,
      userId: scan.userId || scan.loginId || '',
      serverTime: finalSavedTime.toISOString(),
      mobileTime: mobileTime ? mobileTime.toISOString() : '',
      receivedScanTime: scan.timestamp instanceof Date && !Number.isNaN(scan.timestamp.getTime()) ? scan.timestamp.toISOString() : '',
      savedScanTime: finalSavedTime.toISOString(),
      timeZone: tz,
      syncKey: scan.syncKey || '',
      qrFingerprint: scan.qrFingerprint || '',
      skewMs
    });

    // Emit realtime socket event if skew exceeds threshold
    try {
      const io = req && (req.io || req.app.get('io'));
      const thresholdMs = Number(process.env.CLOCK_SKEW_THRESHOLD_MS || 300000);
      if (io && skewMs > thresholdMs) {
        io.emit('sync:clockSkew', {
          batchId,
          dealerCode: scan.dealerCode,
          userId: scan.userId || scan.loginId || '',
          deviceId: scan.deviceId || '',
          mobileTime: mobileTime ? mobileTime.toISOString() : '',
          serverTime: finalSavedTime.toISOString(),
          skewMs,
          timeZone: tz,
          lastSyncStatus: 'skew_detected'
        });
        try {
          await SkewEvent.create({
            deviceId: scan.deviceId || '',
            dealerCode: scan.dealerCode || '',
            userId: scan.userId || scan.loginId || '',
            batchId,
            serverTime: finalSavedTime,
            deviceTime: mobileTime || undefined,
            mobileReceivedTimeUtc: mobileTime ? mobileTime.toISOString() : '',
            skewMs,
            status: 'skew_detected',
            eventType: 'sync_detected',
            message: `Detected clock skew of ${skewMs} ms for device ${scan.deviceId || ''}`
          });
        } catch (eventError) {
          logSync('skew event save failed', { message: eventError.message, batchId, deviceId: scan.deviceId || '', skewMs });
        }
      }
    } catch (e) {}
  } catch (e) {}

  let doc;
  try {
    doc = await Inventory.create({
    uniqueScanId: scan.uniqueScanId,
    scanId: scan.uniqueScanId,
    qrFingerprint: scan.qrFingerprint,
    rawUpiHash: scan.rawUpiHash,
    globalUpiKey: scan.globalUpiKey,
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
    mrp: valueFields.mrp,
    scanMRP: valueFields.scanMRP,
    manualMRP: valueFields.manualMRP,
    valuationMRP: valueFields.valuationMRP,
    valuationSource: valueFields.valuationSource,
    finalInventoryValue: Number(finalQty || 0) * Number(valueFields.valuationMRP || 0),
    finalMRP: Number(valueFields.valuationMRP || 0),
    mrpStatus: Number(valueFields.valuationMRP || 0) > 0 ? 'AVAILABLE' : 'PENDING',
    ...pricePeriodFields,
    dlc: finalDlc,
    bin: finalBin,
    binLocation: finalBin,
    autoDetectedBin: Boolean(scan.autoDetectedBin),
    binSelectionMode: scan.binSelectionMode || (scan.scanType === 'OUTWARD' ? 'AUTO' : 'MANUAL'),
    regdNo: scan.regdNo || '',
    jobCardNo: scan.jobCardNo || '',
    isFitted: scan.scanType === 'FITTED',
    fittedQty: scan.scanType === 'FITTED' ? finalQty : 0,
    fittedLocation: scan.scanType === 'FITTED' ? 'VEHICLE' : '',
    status: scan.scanType === 'FITTED' ? 'FITTED_ON_VEHICLE' : '',
    stockDeductedFromBin: scan.stockDeductedFromBin || (scan.scanType === 'OUTWARD' ? finalBin : ''),
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
    timestamp: finalSavedTime,
    synced: true,
    isSynced: true,
    scanTime: finalSavedTime,
    serverReceivedAt: scan.serverReceivedAt || finalSavedTime,
    mobileReceivedTime: scan.mobileReceivedTime || mobileTimestamp(scan) || '',
    mobileReceivedTimeUtc: scan.mobileReceivedTimeUtc || (mobileTime ? mobileTime.toISOString() : ''),
    syncBatchId: scan.syncBatchId || '',
    serverTimeZone: scan.serverTimeZone || '',
    clientScanId: scan.clientScanId,
    clientSyncKey: scan.clientSyncKey,
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
    const globalFilter = duplicatePolicy.globalUpiDuplicateFilter(scan);
    const existing = globalFilter
      ? await Inventory.findOne(globalFilter).sort({ timestamp: 1, createdAt: 1 }).lean()
      : await Inventory.findOne(duplicateQuery(scan)).lean();
    if (existing) await logDuplicateScan(scan, existing);
    return {
      status: 'duplicate',
      scan: existing || scan,
      error: existing && scan.globalUpiKey ? duplicatePolicy.duplicateUpiMessage(existing) : 'Duplicate scan skipped'
    };
  }

  logSync('DB insert success', { id: doc._id, deviceId: doc.deviceId, partNumber: doc.partNumber, dealerCode: doc.dealerCode, syncKey: doc.syncKey });
  logSync('saved valid scan', { id: doc._id, partNumber: doc.partNumber, dealerCode: doc.dealerCode, source: 'mobile' });
  await emitEnterpriseRealtime(req.io || req.app.get('io'), [doc]);
  return { status: 'synced', scan: doc, error: '' };
}

async function syncSummary(activePort, dealerCode = '', req = null) {
  await Device.updateMany({ status: 'online', lastSeen: { $lt: liveCutoff() } }, { status: 'offline' });
  const dealer = upper(dealerCode);
  const scope = dealer ? { dealerCode: dealer } : {};
  const transactionScope = { ...scope, $and: [nonVerificationScanClause()] };
  const [pendingRecords, failedRecords, totalSynced, connectedDevices, lastSyncAt] = await Promise.all([
    Inventory.countDocuments({ ...transactionScope, $or: [{ syncStatus: 'pending' }, { isSynced: false }] }),
    Inventory.countDocuments({ ...transactionScope, syncStatus: 'failed' }),
    Inventory.countDocuments({ ...transactionScope, $or: [{ syncStatus: 'synced' }, { isSynced: true }, { synced: true }] }),
    Device.countDocuments({ ...scope, status: 'online', lastSeen: { $gte: liveCutoff() } }),
    latestSuccessfulSyncTime(dealer)
  ]);
  const info = serverInfo(
    activePort,
    '',
    req ? req.protocol : '',
    req ? (req.get('x-forwarded-host') || req.get('host') || '') : ''
  );
  const lastSync = lastSyncAt ? lastSyncAt.toISOString() : '';

  return {
    serverStatus: 'online',
    dealerCode: dealer,
    databaseStatus: isDatabaseReady() ? 'online' : 'offline',
    postgresStatus: isDatabaseReady() ? 'online' : 'offline',
    db: isDatabaseReady() ? 'connected' : 'disconnected',
    lastSync,
    lastSyncTime: lastSync,
    lastSuccessfulSyncAt: lastSync,
    hasSyncData: Boolean(lastSync),
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
  const syncBatchId = (randomUUID && randomUUID()) || `batch-${Date.now()}`;
  const serverTimeZone = (Intl && Intl.DateTimeFormat && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
  try {
    const body = Array.isArray(req.body) ? { scans: req.body } : req.body || {};
    if (isLocalhostUrl(body.serverUrl)) {
      return res.status(400).json({ success: false, message: 'Do not use localhost on mobile. Use the cloud server URL from pairing QR.' });
    }

    const incomingRaw = incomingScansFromBody(body);
    logSync('server request received', {
      route: req.originalUrl,
      method: req.method,
      batchId: syncBatchId,
      deviceId: clean(body.deviceId || (incomingRaw[0] && incomingRaw[0].deviceId)),
      receivedCount: incomingRaw.length,
      ...dateDebugPayload({
        serverTime: startedAt,
        mobileTime: incomingRaw[0] ? mobileTimestamp(incomingRaw[0]) : ''
      }),
      bodyKeys: Object.keys(body).slice(0, 30),
      sample: incomingRaw.map((item) => ({
        scanId: clean(item.scanId || item.uniqueScanId || item.mobileScanId || item.localId),
        partNumber: clean(item.partNumber || item.partNo || item.part || item.sku || item.itemCode),
        dealerCode: clean(item.dealerCode || item.dealer),
        scanType: clean(item.scanType || item.action || item.type),
        qty: clean(item.qty || item.quantity),
        rawBarcode: clean(item.rawBarcode || item.rawScanValue || item.rawScan || item.rawScanString),
        upiId: clean(item.upiId || item.upiSequence || item.id),
        mobileReceivedTime: mobileTimestamp(item),
        batchId: syncBatchId
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
    const requestedDealerCode = upper(body.activeDealerId || body.dealerId || body.dealerCode || req.activeDealerId || (incomingRaw[0] && incomingRaw[0].dealerCode));
    if (req.user && requestedDealerCode) {
      const access = await auth.validateUserDealerAccess(req.user, requestedDealerCode);
      if (!access.allowed) {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized dealer access',
          requestedDealer: access.requestedDealer,
          userDealerAccess: access.userDealerAccess
        });
      }
    }
    const mismatchedDealer = incomingRaw.find((item) => {
      const itemDealer = upper(item.activeDealerId || item.dealerId || item.dealerCode || item.dealer);
      return itemDealer && requestedDealerCode && itemDealer !== requestedDealerCode;
    });
    if (mismatchedDealer) {
      return res.status(403).json({
        success: false,
        message: 'Scan dealer does not match selected dealer',
        requestedDealer: requestedDealerCode,
        scanDealer: upper(mismatchedDealer.dealerCode || mismatchedDealer.dealer)
      });
    }
    const activeAudit = await activeAuditForDealer(requestedDealerCode);
    if (!activeAudit) {
      logSync('request rejected', { reason: 'No active audit', requestedDealerCode, receivedCount: incomingRaw.length });
      return res.json({
        success: false,
        message: noActiveAuditMessage(requestedDealerCode),
        activeAudit: null,
        receivedCount: incomingRaw.length,
        failedCount: incomingRaw.length,
        failed: incomingRaw.length
      });
    }
    const activeAuditPayload = publicAudit(activeAudit);
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
      serverReceivedAt: new Date(),
      syncBatchId,
      serverTimeZone,
      dealerCode: activeAudit.dealerCode,
      dealerName: activeAudit.dealerName,
      auditId: activeAudit.auditId,
      deviceId: item.deviceId || body.deviceId,
      serverUrl: item.serverUrl || body.serverUrl
    }));
    const deviceId = clean(body.deviceId || (incoming[0] && incoming[0].deviceId));
    const dealerCode = upper(activeAudit.dealerCode);
    const activeAuditId = clean(activeAudit.auditId || activeAudit._id);
    const requestUserContext = await resolveScanUserContext(req, { ...body, deviceId });
    const logs = [];
    const failedRows = [];
    const errors = [];
    let invalidCleanedCount = 0;

    if (io) {
      io.emit('sync:started', { startedAt, count: incoming.length, deviceId });
      logSync('socket broadcast success', { event: 'sync:started', count: incoming.length, deviceId });
    }

    let normalized = incoming.map((item, index) => {
      const scan = applyActiveAudit(normalizeScan({ ...item, deviceId: item.deviceId || deviceId }), activeAudit);
      applyUserContext(scan, requestUserContext);
      // persist batch identifiers and server timezone info on each scan
      scan.syncBatchId = item.syncBatchId || syncBatchId;
      scan.serverTimeZone = item.serverTimeZone || serverTimeZone;
      scan.qrFingerprint = isManualEntry(scan) ? '' : makeQrFingerprint(scan);
      scan.rawUpiHash = duplicatePolicy.rawUpiHash(scan);
      scan.globalUpiKey = duplicatePolicy.globalUpiKey(scan);
      return { index, scan };
    });
    normalized.forEach(({ scan }) => {
      if (isManualEntry(scan)) scan.qrFingerprint = '';
      scan.rawUpiHash = duplicatePolicy.rawUpiHash(scan);
      scan.globalUpiKey = duplicatePolicy.globalUpiKey(scan);
    });
    const verificationResults = [];
    const transactionRows = [];
    for (const item of normalized) {
      if (item.scan.scanType === 'VERIFICATION') {
        verificationResults.push(await inventory.verifyPartOnly({
          rawScan: item.scan.rawScanString,
          partNumber: item.scan.partNumber,
          dealerCode: item.scan.dealerCode,
          auditId: item.scan.auditId
        }));
      } else {
        transactionRows.push(item);
      }
    }
    normalized = transactionRows;
    if (!normalized.length) {
      return res.json({
        success: true,
        activeAudit: activeAuditPayload,
        dealerCode: activeAuditPayload.dealerCode,
        dealerName: activeAuditPayload.dealerName,
        auditId: activeAuditPayload.auditId,
        receivedCount: 0,
        insertedCount: 0,
        syncedCount: 0,
        duplicateCount: 0,
        failedCount: 0,
        failedRows: [],
        invalidCleanedCount: 0,
        insertedRecords: [],
        verifiedInsertedCount: 0,
        synced: 0,
        duplicates: 0,
        failed: 0,
        logs: [],
        verificationResults,
        message: verificationResults[0]?.message || 'Verification completed'
      });
    }
    const partNumbers = Array.from(new Set(normalized.map((item) => item.scan.partNumber).filter(Boolean)));
    const dealerCodes = Array.from(new Set(normalized.map((item) => item.scan.dealerCode).filter(Boolean)));
    const normalizedScanIds = normalized.map((item) => item.scan.uniqueScanId).filter(Boolean);
    const normalizedSyncKeys = normalized.map((item) => item.scan.syncKey).filter(Boolean);
    const normalizedQrFingerprints = normalized.map((item) => item.scan.qrFingerprint).filter(Boolean);
    const normalizedRawUpiHashes = normalized.map((item) => item.scan.rawUpiHash || duplicatePolicy.rawUpiHash(item.scan)).filter(Boolean);
    const normalizedGlobalUpiKeys = normalized.map((item) => item.scan.globalUpiKey || duplicatePolicy.globalUpiKey(item.scan)).filter(Boolean);
    const normalizedRawScans = normalized
      .filter((item) => !isManualEntry(item.scan))
      .map((item) => item.scan.rawScanString)
      .filter(Boolean);
    const normalizedUpiNos = normalized
      .filter((item) => !isManualEntry(item.scan))
      .map((item) => item.scan.upiNo || item.scan.upiId)
      .filter(Boolean);
    const fittedDuplicateClauses = normalized
      .map((item) => item.scan)
      .filter((scan) => scan.scanType === 'FITTED' && scan.dealerCode && scan.partNumber && scan.regdNo && scan.jobCardNo)
      .map((scan) => ({
        dealerCode: upper(scan.dealerCode),
        auditId: clean(scan.auditId),
        scanType: 'FITTED',
        regdNo: upper(scan.regdNo),
        jobCardNo: upper(scan.jobCardNo),
        $or: [
          { normalizedPartNumber: normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part) },
          { partNumber: normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part) },
          { part: normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part) }
        ]
      }));
    const businessDuplicateClauses = normalized
      .map((item) => duplicatePolicy.businessDuplicateFilter(item.scan))
      .filter(Boolean);
    const [catalogueMasters, legacyMasters, dealers, existingScans] = await Promise.all([
      MasterCatalogue.find({ normalizedPartNumber: { $in: partNumbers } }).lean(),
      MasterPart.find({ $or: [{ normalizedPartNumber: { $in: partNumbers } }, { partNo: { $in: partNumbers } }, { partNumber: { $in: partNumbers } }] }).lean(),
      Dealer.find({ dealerCode: { $in: dealerCodes } }).lean(),
      Inventory.find({
        $or: [
          { uniqueScanId: { $in: normalizedScanIds } },
          { scanId: { $in: normalizedScanIds } },
          { syncKey: { $in: normalizedSyncKeys } },
          { qrFingerprint: { $in: normalizedQrFingerprints } },
          { rawUpiHash: { $in: normalizedRawUpiHashes } },
          { globalUpiKey: { $in: normalizedGlobalUpiKeys } },
          { dealerCode, auditId: activeAuditId, scanType: { $in: normalized.map((item) => item.scan.scanType).filter(Boolean) }, rawScan: { $in: normalizedRawScans } },
          { dealerCode, auditId: activeAuditId, scanType: { $in: normalized.map((item) => item.scan.scanType).filter(Boolean) }, rawScanString: { $in: normalizedRawScans } },
          { dealerCode, auditId: activeAuditId, scanType: { $in: normalized.map((item) => item.scan.scanType).filter(Boolean) }, rawUpi: { $in: normalizedRawScans } },
          { dealerCode, auditId: activeAuditId, scanType: { $in: normalized.map((item) => item.scan.scanType).filter(Boolean) }, upiNo: { $in: normalizedUpiNos } },
          { dealerCode, auditId: activeAuditId, scanType: { $in: normalized.map((item) => item.scan.scanType).filter(Boolean) }, upiId: { $in: normalizedUpiNos } },
          ...fittedDuplicateClauses,
          ...businessDuplicateClauses
        ]
        }).select('uniqueScanId scanId syncKey qrFingerprint rawUpiHash globalUpiKey rawScan rawScanString rawUpi upiNo upiId dealerCode auditId syncBatchId userId loginId userName staffName binLocation bin scanType type normalizedPartNumber partNumber part regdNo jobCardNo qty quantity mrp scanMRP manualMRP valuationMRP finalMRP valuationSource timestamp scanTime createdAt').lean()
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
      const identity = {
        _id: scan._id,
        uniqueScanId: scan.uniqueScanId,
        scanId: scan.scanId,
        qrFingerprint: scan.qrFingerprint,
        rawUpiHash: scan.rawUpiHash,
        globalUpiKey: scan.globalUpiKey,
        partNumber: scan.partNumber,
        part: scan.part,
        binLocation: scan.binLocation,
        bin: scan.bin,
        timestamp: scan.timestamp,
        scanTime: scan.scanTime,
        createdAt: scan.createdAt,
        qty: scan.qty,
        quantity: scan.quantity,
        mrp: scan.mrp,
        scanMRP: scan.scanMRP,
        manualMRP: scan.manualMRP,
        valuationMRP: scan.valuationMRP,
        finalMRP: scan.finalMRP,
        valuationSource: scan.valuationSource
      };
      const scanDealer = upper(scan.dealerCode);
      const scanAudit = clean(scan.auditId);
      const scanType = upper(scan.scanType || scan.type);
      const scanBin = upper(scan.binLocation || scan.bin);
      const scanUser = identityUserKey(scan);
      const scanSession = identitySessionKey(scan);
      const businessKey = duplicatePolicy.businessDuplicateKey(scan);
      if (businessKey) {
        existingScanIds.add(businessKey);
        existingIdentityByKey.set(businessKey, identity);
      }
      if (scanType === 'FITTED') {
        const fittedKey = [
          scanDealer,
          scanAudit,
          normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part),
          upper(scan.regdNo),
          upper(scan.jobCardNo),
          'FITTED'
        ].join('::');
        existingScanIds.add(fittedKey);
        existingIdentityByKey.set(fittedKey, identity);
      }
      if (scan.uniqueScanId) {
        existingScanIds.add(scan.uniqueScanId);
        existingIdentityByKey.set(scan.uniqueScanId, identity);
      }
      if (scan.scanId) {
        existingScanIds.add(scan.scanId);
        existingIdentityByKey.set(scan.scanId, identity);
      }
      if (scan.syncKey) {
        existingScanIds.add(scan.syncKey);
        existingIdentityByKey.set(scan.syncKey, identity);
      }
      if (scan.qrFingerprint) {
        existingScanIds.add(scan.qrFingerprint);
        existingIdentityByKey.set(scan.qrFingerprint, identity);
      }
      if (scan.rawUpiHash) {
        existingScanIds.add(scan.rawUpiHash);
        existingIdentityByKey.set(scan.rawUpiHash, identity);
      }
      if (scan.globalUpiKey) {
        existingScanIds.add(scan.globalUpiKey);
        existingIdentityByKey.set(scan.globalUpiKey, identity);
      }
      [scan.rawScan, scan.rawScanString, scan.rawUpi].filter(Boolean).forEach((raw) => {
        const key = `${scanDealer}::${scanAudit}::${scanUser}::${scanSession}::${scanType}::${scanBin}::RAW::${clean(raw)}`;
        existingScanIds.add(key);
        existingIdentityByKey.set(key, identity);
      });
      [scan.upiNo, scan.upiId].filter(Boolean).forEach((upi) => {
        const key = `${scanDealer}::${scanAudit}::${scanUser}::${scanSession}::${scanType}::${scanBin}::UPI::${upper(upi)}`;
        existingScanIds.add(key);
        existingIdentityByKey.set(key, identity);
      });
    });
    const duplicateScanIds = new Set();
    const operations = [];
    const insertDocs = [];
    const insertMeta = [];

    for (const { scan, index } of normalized) {
      if (scan.scanType === 'FITTED') {
        inventory.prepareFittedScan(scan, scan.quantity || 1);
      }
      if (scan.scanType === 'OUTWARD') {
        const detected = await autoDetectOutwardBin(scan);
        if (detected && detected.binLocation) {
          scan.binLocation = detected.binLocation;
          scan.autoDetectedBin = true;
          scan.binSelectionMode = 'AUTO';
          scan.stockDeductedFromBin = detected.binLocation;
        } else {
          scan._autoBinError = NO_OUTWARD_STOCK_MESSAGE;
        }
      } else if (['INWARD', 'DAMAGE'].includes(scan.scanType)) {
        scan.binSelectionMode = 'MANUAL';
        scan.autoDetectedBin = false;
        scan.stockDeductedFromBin = '';
      }
    }

    for (const { index, scan } of normalized) {
      const master = masterByDealer.get(`${scan.normalizedPartNumber || scan.partNumber}::${upper(scan.dealerCode)}`) || masterByPart.get(scan.normalizedPartNumber || scan.partNumber);
      const manualEntry = isManualEntry(scan);
      logSync('row normalized', {
        rawScanReceived: scan.rawScanString || scan.partNumber || '',
        extractedPartNumber: scan.partNumber || '',
        masterMatch: Boolean(master)
      });
      if (!scan.dealerCode && master && master.dealerCode) scan.dealerCode = master.dealerCode;
      const dealer = scan.dealerCode ? dealerByCode.get(scan.dealerCode) : null;

      const rowErrors = [];
      if (!scan.partNumber) rowErrors.push('partNumber missing');
      if (scan.partNumber && !isValidPartNumber(scan.partNumber)) rowErrors.push('invalid partNumber format');
      if (['INWARD', 'DAMAGE'].includes(scan.scanType) && !scan.binLocation) rowErrors.push(BIN_REQUIRED_MESSAGE);
      if (scan.scanType === 'FITTED') {
        if (!scan.regdNo || !scan.jobCardNo) rowErrors.push('Regd No and Job Card No are required for fitted parts.');
      }
      if (scan.scanType === 'OUTWARD' && scan._autoBinError) rowErrors.push(scan._autoBinError);
      if (!scan.dealerCode) rowErrors.push('dealerCode missing');
      if (scan.dealerCode && !dealer) rowErrors.push('Valid dealer code is required');
      if (!VALID_TYPES.includes(scan.scanType)) rowErrors.push('invalid scanType');
      if (!(scan.timestamp instanceof Date) || Number.isNaN(scan.timestamp.getTime())) rowErrors.push('invalid timestamp');
      if (scan.quantity === undefined || scan.quantity === null || Number.isNaN(Number(scan.quantity))) rowErrors.push('qty missing or invalid');
      if (!(Number(scan.quantity) > 0)) rowErrors.push('qty must be greater than zero');
      const manualMrpForValidation = scan.mrpProvided ? optionalNumber(scan.mrp) : undefined;
      if (manualEntry && !(Number(manualMrpForValidation || 0) > 0)) rowErrors.push('MRP is mandatory for manual part entry.');
      if (!master && manualEntry) {
        scan.manualMasterMissing = true;
      }

      if (rowErrors.length) {
        const isInvalidLocalRecord = rowErrors.some((reason) => /scanId missing|partNumber missing/.test(reason));
        if (!master && scan.partNumber && manualEntry) {
          logMasterValidationFailure(scan, 'Not Found In Master').catch(() => undefined);
          masterValidation.rejectNotInMasterScan({
            ...scan,
            rawScannedValue: scan.rawScanString,
            extractedPartNumber: scan.partNumber,
            originalScanId: scan.uniqueScanId,
            source: normalizeSource(scan.scanSource || scan.source?.source || scan.source?.scanSource || scan.source, 'mobile'),
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
        logs.push(syncLogFromAck(
          scan,
          ackMetaFromScan(scan, index + 1),
          isInvalidLocalRecord ? 'invalid' : 'failed',
          isInvalidLocalRecord ? 'Invalid record cleaned' : failed.reason
        ));
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
        continue;
      }

      const fittedKey = scan.scanType === 'FITTED'
        ? [
            upper(scan.dealerCode),
            clean(scan.auditId),
            normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part),
            upper(scan.regdNo),
            upper(scan.jobCardNo),
            'FITTED'
          ].join('::')
        : '';
      const identityBin = upper(scan.binLocation || scan.bin);
      const identityType = upper(scan.scanType || scan.type);
      const identityAudit = clean(scan.auditId);
      const identityUser = identityUserKey(scan);
      const identitySession = identitySessionKey(scan);
      scan.rawUpiHash = scan.rawUpiHash || duplicatePolicy.rawUpiHash(scan);
      scan.globalUpiKey = scan.globalUpiKey || duplicatePolicy.globalUpiKey(scan);
      const businessKey = duplicatePolicy.businessDuplicateKey(scan);
      const globalUpiDuplicate = Boolean(scan.globalUpiKey && (existingScanIds.has(scan.globalUpiKey) || duplicateScanIds.has(scan.globalUpiKey)));
      const rawIdentityKey = !manualEntry && clean(scan.rawScanString) ? `${upper(scan.dealerCode)}::${identityAudit}::${identityUser}::${identitySession}::${identityType}::${identityBin}::RAW::${clean(scan.rawScanString)}` : '';
      const upiIdentityKey = !manualEntry && upper(scan.upiNo || scan.upiId) ? `${upper(scan.dealerCode)}::${identityAudit}::${identityUser}::${identitySession}::${identityType}::${identityBin}::UPI::${upper(scan.upiNo || scan.upiId)}` : '';
      const fittedDuplicate = fittedKey && (existingScanIds.has(fittedKey) || duplicateScanIds.has(fittedKey));
      const businessDuplicate = Boolean(businessKey && (existingScanIds.has(businessKey) || duplicateScanIds.has(businessKey)));
      const storedIdentityDuplicate = Boolean(
        (scan.uniqueScanId && existingScanIds.has(scan.uniqueScanId))
        || (scan.scanId && existingScanIds.has(scan.scanId))
        || (scan.syncKey && existingScanIds.has(scan.syncKey))
        || (scan.rawUpiHash && existingScanIds.has(scan.rawUpiHash))
      );
      const batchIdentityDuplicate = Boolean(
        (scan.uniqueScanId && duplicateScanIds.has(scan.uniqueScanId))
        || (scan.scanId && duplicateScanIds.has(scan.scanId))
        || (scan.syncKey && duplicateScanIds.has(scan.syncKey))
        || (scan.rawUpiHash && duplicateScanIds.has(scan.rawUpiHash))
      );
      const barcodeDuplicate = !manualEntry && Boolean(
        (scan.qrFingerprint && (existingScanIds.has(scan.qrFingerprint) || duplicateScanIds.has(scan.qrFingerprint)))
        || (rawIdentityKey && (existingScanIds.has(rawIdentityKey) || duplicateScanIds.has(rawIdentityKey)))
        || (upiIdentityKey && (existingScanIds.has(upiIdentityKey) || duplicateScanIds.has(upiIdentityKey)))
      );
      const normalDuplicate = globalUpiDuplicate || (!fittedKey && (
        businessDuplicate
        || storedIdentityDuplicate
        || batchIdentityDuplicate
        || barcodeDuplicate
      ));
      if (fittedDuplicate || normalDuplicate) {
        if (scan.qrFingerprint) duplicateScanIds.add(scan.qrFingerprint);
        if (fittedKey) duplicateScanIds.add(fittedKey);
        if (businessKey) duplicateScanIds.add(businessKey);
        if (scan.rawUpiHash) duplicateScanIds.add(scan.rawUpiHash);
        if (scan.globalUpiKey) duplicateScanIds.add(scan.globalUpiKey);
        if (rawIdentityKey) duplicateScanIds.add(rawIdentityKey);
        if (upiIdentityKey) duplicateScanIds.add(upiIdentityKey);
        let existingIdentity = existingIdentityByKey.get(scan.globalUpiKey) || existingIdentityByKey.get(fittedKey) || existingIdentityByKey.get(businessKey) || existingIdentityByKey.get(scan.rawUpiHash) || existingIdentityByKey.get(scan.uniqueScanId) || existingIdentityByKey.get(scan.scanId) || existingIdentityByKey.get(scan.syncKey) || existingIdentityByKey.get(rawIdentityKey) || existingIdentityByKey.get(upiIdentityKey) || existingIdentityByKey.get(scan.qrFingerprint) || {};
        existingIdentity = await backfillDuplicateMrp(existingIdentity, scan, { manualEntry });
        const duplicateMessage = globalUpiDuplicate
          ? duplicatePolicy.duplicateUpiMessage(existingIdentity)
          : fittedKey
          ? 'Fitted part already exists for this vehicle/job card'
          : businessDuplicate
            ? duplicatePolicy.DUPLICATE_PART_MESSAGE
            : 'Duplicate exact UPI/barcode skipped';
        logDuplicateScan(scan, existingIdentity, duplicateMessage).catch(() => undefined);
        logSync('duplicate scan skipped', {
          row: index + 1,
          scanId: scan.uniqueScanId,
          qrFingerprint: scan.qrFingerprint,
          partNumber: scan.partNumber,
          dealerCode: scan.dealerCode,
          existing: existingIdentity || 'same request batch'
        });
        logs.push(syncLogFromAck(scan, ackMetaFromScan(scan, index + 1), 'duplicate', duplicateMessage));
        continue;
      }
      if (scan.uniqueScanId) duplicateScanIds.add(scan.uniqueScanId);
      if (scan.scanId) duplicateScanIds.add(scan.scanId);
      if (scan.syncKey) duplicateScanIds.add(scan.syncKey);
      scan.qrFingerprint = manualEntry || fittedKey ? '' : makeQrFingerprint(scan);
      if (scan.qrFingerprint) duplicateScanIds.add(scan.qrFingerprint);
      if (fittedKey) duplicateScanIds.add(fittedKey);
      if (businessKey) duplicateScanIds.add(businessKey);
      if (scan.rawUpiHash) duplicateScanIds.add(scan.rawUpiHash);
      if (scan.globalUpiKey) {
        duplicateScanIds.add(scan.globalUpiKey);
        existingIdentityByKey.set(scan.globalUpiKey, scan);
      }
      if (rawIdentityKey) duplicateScanIds.add(rawIdentityKey);
      if (upiIdentityKey) duplicateScanIds.add(upiIdentityKey);

      const finalQty = Number(scan.quantity || 1);
      const finalBin = scan.binLocation;
      const scannedMrp = scan.mrpProvided ? optionalNumber(scan.mrp) : undefined;
      const scannedDlc = scan.dlcProvided ? optionalNumber(scan.dlc) : undefined;
      const valueFields = valuationFields({ scan, rawScanText: scan.rawScanString, scannedMrp, mrpProvided: scan.mrpProvided, manualEntry, master });
      const pricePeriod = valueFields.valuationMRP > 0 ? await findPricePeriod(scan.partNumber, scan.timestamp || scan.serverReceivedAt, valueFields.valuationMRP) : null;
      const pricePeriodFields = pricePeriodPayload(pricePeriod, valueFields.valuationMRP);
      const warnings = master ? [] : [manualEntry ? `Manual part saved without Master Catalogue match: ${scan.partNumber}` : `Part not found in Master Catalogue: ${scan.partNumber}`];
      if (master && scan.mrpProvided && pricePeriod && Math.abs(Number(valueFields.valuationMRP || 0) - Number(pricePeriod.mrp || 0)) > 0.01) warnings.push('MRP mismatch against price history period');
      if (master && scan.mrpProvided && !pricePeriod) warnings.push('No matching price history period for scanned MRP');
      if (master && scan.dlcProvided && scannedDlc !== undefined && Math.abs(Number(scannedDlc || 0) - Number(master.dlc || 0)) > 0.01) warnings.push('DLC mismatch');
      const finalDlc = scannedDlc !== undefined
        ? scannedDlc
        : master && master.dlc !== undefined
          ? Number(master.dlc || 0)
          : inventory.numberValue(scan.source.dlc, 0);
      const doc = {
        uniqueScanId: scan.uniqueScanId,
        scanId: scan.uniqueScanId,
        qrFingerprint: scan.qrFingerprint,
        rawUpiHash: scan.rawUpiHash,
        globalUpiKey: scan.globalUpiKey,
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
        mrp: valueFields.mrp,
        scanMRP: valueFields.scanMRP,
        manualMRP: valueFields.manualMRP,
        valuationMRP: valueFields.valuationMRP,
        valuationSource: valueFields.valuationSource,
        finalInventoryValue: finalQty * Number(valueFields.valuationMRP || 0),
        finalMRP: Number(valueFields.valuationMRP || 0),
        mrpStatus: Number(valueFields.valuationMRP || 0) > 0 ? 'AVAILABLE' : 'PENDING',
        ...pricePeriodFields,
        dlc: finalDlc,
        bin: finalBin,
        binLocation: finalBin,
        autoDetectedBin: Boolean(scan.autoDetectedBin),
        binSelectionMode: scan.binSelectionMode || (scan.scanType === 'OUTWARD' ? 'AUTO' : 'MANUAL'),
        regdNo: scan.regdNo || '',
        jobCardNo: scan.jobCardNo || '',
        isFitted: scan.scanType === 'FITTED',
        fittedQty: scan.scanType === 'FITTED' ? finalQty : 0,
        fittedLocation: scan.scanType === 'FITTED' ? 'VEHICLE' : '',
        status: scan.scanType === 'FITTED' ? 'FITTED_ON_VEHICLE' : '',
        stockDeductedFromBin: scan.stockDeductedFromBin || (scan.scanType === 'OUTWARD' ? finalBin : ''),
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
        scanTime: scan.timestamp,
        serverReceivedAt: scan.serverReceivedAt || scan.timestamp,
        mobileReceivedTime: scan.mobileReceivedTime || '',
        mobileReceivedTimeUtc: scan.mobileReceivedTimeUtc || '',
        synced: true,
        isSynced: true,
        clientScanId: scan.clientScanId,
        clientSyncKey: scan.clientSyncKey,
        syncKey: scan.syncKey,
        syncStatus: 'synced',
        syncError: '',
        source: normalizeSource(scan.scanSource || scan.source.source || scan.source.scanSource, 'mobile'),
        warnings,
        remarks: warnings.join(', '),
        masterFound: Boolean(master),
        masterMatch: Boolean(master),
        isMasterMatched: Boolean(master)
      };
      const ack = ackMetaFromScan(scan, index + 1);
      insertDocs.push(doc);
      insertMeta.push({ ...ack, scanId: doc.uniqueScanId, uniqueScanId: doc.uniqueScanId, acks: [ack] });
      operations.push({ insertOne: { document: doc } });
      logSync('scan timestamp normalized', {
        scanId: doc.uniqueScanId,
        partNumber: doc.partNumber,
        dealerCode: doc.dealerCode,
        ...dateDebugPayload({
          serverTime: scan.serverReceivedAt || doc.timestamp,
          mobileTime: scan.mobileReceivedTime,
          savedTime: doc.timestamp
        })
      });
      logSync('saved valid scan', { scanId: doc.uniqueScanId, partNumber: doc.partNumber, dealerCode: doc.dealerCode, source: 'sync' });
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
        for (const writeError of writeErrors) {
          const opIndex = writeError.index;
          failedOperationIndexes.add(opIndex);
          const doc = insertDocs[opIndex] || {};
          const meta = insertMeta[opIndex] || {};
          const metaAcks = ackList(meta);
          const isDuplicate = writeError.code === 11000;
          let duplicateExisting = null;
          if (isDuplicate && doc.globalUpiKey) {
            duplicateExisting = await Inventory.findOne({ globalUpiKey: doc.globalUpiKey }).sort({ timestamp: 1, createdAt: 1 }).lean();
          }
          const failed = {
            row: meta.row || opIndex + 1,
            scanId: doc.uniqueScanId,
            partNumber: doc.partNumber,
            reason: isDuplicate
              ? (duplicateExisting ? duplicatePolicy.duplicateUpiMessage(duplicateExisting) : 'Duplicate exact UPI/barcode or scanId skipped')
              : writeError.errmsg || writeError.message || 'Insert failed'
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
            metaAcks.forEach((ack) => logs.push(syncLogFromAck(doc, ack, 'duplicate', failed.reason)));
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
            metaAcks.forEach((ack) => logs.push(syncLogFromAck(doc, ack, 'failed', failed.reason)));
          }
        }
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
    const verifiedInsertedCount = savedScans.length;
    if (insertedCount !== verifiedInsertedCount) {
      logSync('DB insert verification mismatch', {
        reportedInsertedCount: insertedCount,
        verifiedInsertedCount,
        insertedScanIds
      });
      insertedCount = verifiedInsertedCount;
    }

    const metaByScanId = new Map(insertMeta.map((meta) => [clean(meta.scanId || meta.uniqueScanId), meta]));
    savedScans.forEach((scan) => {
      logSync('saved scan fields', { category: scan.category || '', partDescription: scan.partDescription || scan.partName || '' });
      logSync('saved PostgreSQL timestamp verified', {
        scanId: scan.uniqueScanId || scan.scanId,
        partNumber: scan.partNumber || scan.part,
        ...dateDebugPayload({
          serverTime: scan.serverReceivedAt || scan.timestamp || scan.createdAt,
          mobileTime: scan.mobileReceivedTime,
          savedTime: scan.timestamp || scan.createdAt
        })
      });
      const meta = metaByScanId.get(clean(scan.uniqueScanId || scan.scanId)) || ackMetaFromScan(scan);
      ackList(meta).forEach((ack) => logs.push(syncLogFromAck(scan, ack, 'inserted', '')));
    });

    const duplicateCount = logs.filter((log) => log.status === 'duplicate').length;
    const failedCount = failedRows.filter((row) => row.status !== 'invalid').length;
    const acceptedCount = insertedCount + duplicateCount;
    const transactionReceivedCount = normalized.length;
    const allRowsRejected = transactionReceivedCount > 0 && acceptedCount === 0 && (failedCount > 0 || invalidCleanedCount > 0);
    const completedAt = new Date();
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
      const info = serverInfo(req.app.locals.activePort, req.ip || req.socket.remoteAddress, req.protocol, req.get('x-forwarded-host') || req.get('host') || '');
      const deviceUpdate = {
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
        lastSeen: completedAt,
        syncStatus: allRowsRejected || failedCount ? 'failed' : 'working',
        appVersion: clean(body.appVersion || body.version),
        batteryPercent: body.batteryPercent ?? body.battery,
        failedCount
      };
      if (!allRowsRejected) deviceUpdate.lastSyncTime = completedAt;
      await Device.findOneAndUpdate(
        { deviceId },
        deviceUpdate,
        { upsert: true, setDefaultsOnInsert: true }
      );
      if (io) io.emit('device:heartbeat', { deviceId, dealerCode, status: 'online', lastSeen: completedAt });
    }

    const summary = await syncSummary(req.app.locals.activePort, dealerCode, req);
    await emitEnterpriseRealtime(io, savedScans);
    const payload = {
      success: !allRowsRejected,
      activeAudit: activeAuditPayload,
      dealerCode: activeAuditPayload.dealerCode,
      dealerName: activeAuditPayload.dealerName,
      auditId: activeAuditPayload.auditId,
      receivedCount: transactionReceivedCount,
      insertedCount,
      startedAt,
      completedAt,
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
      verificationResults,
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
      syncBatchId: syncBatchId,
      dateDiagnostics: dateDebugPayload({ serverTime: startedAt, mobileTime: incomingRaw[0] ? mobileTimestamp(incomingRaw[0]) : '', savedTime: completedAt }),
      ...summary
    };

    await SyncLog.create({
      deviceId,
      dealerCode,
      batchId: syncBatchId,
      auditId: activeAuditPayload.auditId,
      route: req.originalUrl,
      status: allRowsRejected ? 'failed' : failedCount ? 'partial' : 'success',
      receivedCount: transactionReceivedCount,
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
    const dealerCode = auth.normalizeAccessCode(req.query.activeDealerId || req.query.dealerId || req.query.dealerCode || '');
    if (req.user && dealerCode) {
      const access = await auth.validateUserDealerAccess(req.user, dealerCode);
      if (!access.allowed) return res.status(403).json({ success: false, message: 'Unauthorized dealer access', requestedDealer: access.requestedDealer });
    }
    const [summary, lastLog] = await Promise.all([
      syncSummary(req.app.locals.activePort, dealerCode, req),
      SyncLog.findOne(dealerCode ? { dealerCode } : {}).sort({ createdAt: -1 }).lean()
    ]);
    res.json({ success: true, ...summary, syncEngineStatus: 'running', lastApiResponse: lastLog || null });
  } catch (error) {
    res.status(500).json({ success: false, serverStatus: 'online', databaseStatus: 'offline', postgresStatus: 'offline', db: 'disconnected', message: error.message });
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
    const records = await Inventory.find({ $and: [nonVerificationScanClause()], $or: [{ syncStatus: 'pending' }, { syncStatus: 'failed' }, { isSynced: false }] })
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
    filter.$and = (filter.$and || []).concat([nonVerificationScanClause()]);
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
