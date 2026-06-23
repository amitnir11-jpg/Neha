const crypto = require('crypto');
const Inventory = require('../models/Inventory');
const { PartBinLocation } = require('../models/registry');
const { buildBinLocationGroups, normalizeBinLocation, movementQty } = require('../utils/smartBinSuggestion');
const { normalizePartNumber } = require('../utils/normalize');
const { invalidateCache } = require('../utils/safeCache');

function clean(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function numberValue(value, fallback = 0) {
  const parsed = Number(String(value === undefined || value === null || value === '' ? fallback : value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePartBinScope(input = {}) {
  const dealerCode = upper(input.dealerCode || input.dealer || '');
  const auditId = clean(input.auditId || input.audit || '');
  const partNumber = normalizePartNumber(input.partNumber || input.part || input.normalizedPartNumber || '');
  const currentBin = normalizeBinLocation(input.binLocation || input.bin || '');
  return { dealerCode, auditId, partNumber, currentBin };
}

function scopeFilter(scope = {}) {
  const normalized = normalizePartBinScope(scope);
  const filter = {};
  if (normalized.dealerCode) filter.dealerCode = normalized.dealerCode;
  if (normalized.auditId) filter.auditId = normalized.auditId;
  if (normalized.partNumber) {
    filter.$and = (filter.$and || []).concat([{
      $or: [
        { normalizedPartNumber: normalized.partNumber },
        { partNumber: normalized.partNumber }
      ]
    }]);
  }
  return filter;
}

function rowId(scope = {}, binLocation = '') {
  const normalized = normalizePartBinScope(scope);
  const raw = [
    normalized.dealerCode,
    normalized.auditId,
    normalized.partNumber,
    normalizeBinLocation(binLocation)
  ].join('|');
  return `PBL-${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 24)}`;
}

function sortLocationRows(rows = []) {
  return rows.slice().sort((a, b) => {
    const qtyDiff = Number(b.quantity || 0) - Number(a.quantity || 0);
    if (qtyDiff) return qtyDiff;
    const timeA = new Date(a.lastScanDate || a.createdDate || a.updatedAt || 0).getTime();
    const timeB = new Date(b.lastScanDate || b.createdDate || b.updatedAt || 0).getTime();
    if (timeA !== timeB) return timeB - timeA;
    return String(a.binLocation || '').localeCompare(String(b.binLocation || ''), undefined, { numeric: true, sensitivity: 'base' });
  });
}

function normalizeLocationType(value, isPrimary = false) {
  const text = upper(value);
  if (isPrimary) return 'PRIMARY';
  return text === 'PRIMARY' ? 'PRIMARY' : 'SECONDARY';
}

async function queryPartBinLocationRows(scope = {}) {
  try {
    return await PartBinLocation.find(scopeFilter(scope)).lean();
  } catch (error) {
    return [];
  }
}

async function queryInventoryRows(scope = {}) {
  const normalized = normalizePartBinScope(scope);
  if (!normalized.dealerCode || !normalized.auditId || !normalized.partNumber) return [];
  const filter = {
    dealerCode: normalized.dealerCode,
    auditId: normalized.auditId,
    $and: [
      {
        $or: [
          { normalizedPartNumber: normalized.partNumber },
          { partNumber: normalized.partNumber },
          { part: normalized.partNumber }
        ]
      },
      {
        $or: [
          { binLocation: { $nin: [null, ''] } },
          { bin: { $nin: [null, ''] } }
        ]
      }
    ]
  };

  try {
    return await Inventory.find(filter)
      .select('dealerCode auditId partNumber normalizedPartNumber partDescription partName binLocation bin scanType type qty quantity timestamp scanTime createdAt updatedAt userName loginId username staffName smartBinDecisionBy reason remarks smartBinReason smartBinDecisionReason deletedAt syncStatus scanStatus status')
      .sort({ timestamp: 1, createdAt: 1, _id: 1 })
      .lean();
  } catch (error) {
    return [];
  }
}

function rowFromGroup(group = {}, scope = {}, existing = null) {
  const normalized = normalizePartBinScope(scope);
  const binLocation = normalizeBinLocation(group.binLocation || group.bin || existing?.binLocation || '');
  const createdBy = clean(existing?.createdBy || group.lastScannedBy || '');
  const createdDate = existing?.createdDate || group.lastScanTime || existing?.createdAt || new Date();
  const lastScanDate = group.lastScanTime || existing?.lastScanDate || createdDate;
  const quantity = Math.max(0, numberValue(group.qty || group.quantity || existing?.quantity || 0, 0));

  return {
    id: existing?.id || existing?._id || rowId(normalized, binLocation),
    dealerCode: normalized.dealerCode,
    auditId: normalized.auditId,
    partNumber: normalized.partNumber,
    normalizedPartNumber: normalized.partNumber,
    binLocation,
    quantity,
    locationType: normalizeLocationType(existing?.locationType || group.locationType, false),
    createdBy,
    createdDate,
    reason: clean(group.reason || existing?.reason || ''),
    lastScanDate
  };
}

async function rebuildPartBinLocations(scope = {}) {
  const normalized = normalizePartBinScope(scope);
  if (!normalized.dealerCode || !normalized.auditId || !normalized.partNumber) return [];

  const inventoryRows = await queryInventoryRows(normalized);
  const existingRows = await queryPartBinLocationRows(normalized);
  const existingByBin = new Map(existingRows.map((row) => [normalizeBinLocation(row.binLocation), row]));
  const groups = buildBinLocationGroups(inventoryRows).filter((row) => normalizePartBinScope(row).partNumber === normalized.partNumber);
  const nextRows = groups
    .map((group) => rowFromGroup(group, normalized, existingByBin.get(normalizeBinLocation(group.binLocation))))
    .filter((row) => row.binLocation && row.quantity > 0);

  const activeBins = new Set(nextRows.map((row) => row.binLocation));
  const staleIds = existingRows
    .filter((row) => !activeBins.has(normalizeBinLocation(row.binLocation)))
    .map((row) => row.id || row._id)
    .filter(Boolean);

  if (staleIds.length) {
    try {
      await PartBinLocation.deleteMany({ _id: { $in: staleIds } });
    } catch (error) {
      // Best-effort clean-up. If the table is unavailable we still keep the scan path working.
    }
  }

  for (const [index, row] of sortLocationRows(nextRows).entries()) {
    const locationType = index === 0 ? 'PRIMARY' : 'SECONDARY';
    const payload = {
      ...row,
      locationType
    };
    try {
      await PartBinLocation.findOneAndUpdate(
        { _id: row.id },
        {
          $set: payload,
          $setOnInsert: {
            createdBy: row.createdBy || '',
            createdDate: row.createdDate || new Date(),
            reason: row.reason || ''
          }
        },
        { upsert: true, new: true }
      );
    } catch (error) {
      // If the table is not ready yet, fall back to inventory-derived suggestions.
    }
  }

  const finalRows = sortLocationRows(await queryPartBinLocationRows(normalized));
  for (const [index, row] of finalRows.entries()) {
    const expectedType = index === 0 ? 'PRIMARY' : 'SECONDARY';
    if (normalizeLocationType(row.locationType) === expectedType) continue;
    try {
      await PartBinLocation.findOneAndUpdate(
        { _id: row.id || row._id },
        { $set: { locationType: expectedType } },
        { new: true }
      );
      row.locationType = expectedType;
    } catch (error) {
      // Ignore ranking update failures and keep the scan flow fast.
    }
  }

  invalidateCache({ tags: ['smart-bin'], scope: { dealerCode: normalized.dealerCode, auditId: normalized.auditId } });
  return sortLocationRows(await queryPartBinLocationRows(normalized));
}

async function ensurePartBinLocations(scope = {}, options = {}) {
  const normalized = normalizePartBinScope(scope);
  if (!normalized.dealerCode || !normalized.auditId || !normalized.partNumber) return [];
  if (options.refresh) return rebuildPartBinLocations(normalized);
  const rows = sortLocationRows(await queryPartBinLocationRows(normalized));
  if (rows.length) return rows;
  return rebuildPartBinLocations(normalized);
}

function buildSuggestionPayload(rows = [], scope = {}, settings = {}) {
  const normalized = normalizePartBinScope(scope);
  const currentBin = normalized.currentBin;
  const existingBins = sortLocationRows(rows)
    .filter((row) => Number(row.quantity || 0) > 0)
    .map((row) => ({
      binLocation: normalizeBinLocation(row.binLocation),
      qty: Number(row.quantity || 0),
      locationType: normalizeLocationType(row.locationType, row.locationType === 'PRIMARY'),
      createdBy: clean(row.createdBy || ''),
      createdDate: row.createdDate || '',
      lastScanDate: row.lastScanDate || '',
      reason: clean(row.reason || '')
    }))
    .filter((row) => row.binLocation);

  const primaryBin = existingBins[0] ? existingBins[0].binLocation : currentBin;
  const secondaryBins = existingBins.slice(1).map((row) => row.binLocation);
  const sameBinExists = Boolean(currentBin && existingBins.some((row) => row.binLocation === currentBin));
  const allowMultipleLocations = settings.allowMultipleLocations === undefined ? true : Boolean(settings.allowMultipleLocations);
  const maxAllowedLocationsPerPart = Math.max(1, Number(settings.maxAllowedLocationsPerPart || 3) || 3);
  const locationLimitReached = existingBins.length >= maxAllowedLocationsPerPart;
  const canAddNewLocation = allowMultipleLocations && !locationLimitReached;
  const canContinueCurrent = allowMultipleLocations && !locationLimitReached;
  const shouldPrompt = Boolean(existingBins.length && currentBin && !sameBinExists);
  const message = existingBins.length === 1
    ? `Part: ${normalized.partNumber}\nAlready available in Bin: ${existingBins[0].binLocation}\n\nWould you like to continue using existing location?`
    : `Part: ${normalized.partNumber}\nAlready available in Bins: ${existingBins.map((row) => row.binLocation).join(', ')}\n\nWould you like to continue using existing location?`;

  return {
    dealerCode: normalized.dealerCode,
    auditId: normalized.auditId,
    partNumber: normalized.partNumber,
    currentBin,
    primaryBin,
    primaryLocation: primaryBin,
    secondaryBins,
    existingBins,
    existingBinCount: existingBins.length,
    totalQty: existingBins.reduce((sum, row) => sum + Number(row.qty || 0), 0),
    suggestedBin: primaryBin || currentBin,
    sameBinExists,
    shouldPrompt,
    canUseExisting: Boolean(existingBins.length),
    canAddNewLocation,
    canContinueCurrent,
    locationLimitReached,
    allowMultipleLocations,
    maxAllowedLocationsPerPart,
    reasonRequired: Boolean(settings.requireReason),
    message
  };
}

async function getSmartBinSuggestion(input = {}, options = {}) {
  const scope = normalizePartBinScope(input);
  if (!scope.dealerCode || !scope.auditId || !scope.partNumber || !scope.currentBin) {
    return {
      ...scope,
      suggestedBin: scope.currentBin,
      existingBins: [],
      existingBinCount: 0,
      totalQty: 0,
      primaryBin: scope.currentBin,
      primaryLocation: scope.currentBin,
      secondaryBins: [],
      sameBinExists: false,
      shouldPrompt: false,
      canUseExisting: false,
      canAddNewLocation: true,
      canContinueCurrent: true,
      locationLimitReached: false,
      allowMultipleLocations: true,
      maxAllowedLocationsPerPart: 3,
      reasonRequired: true,
      message: ''
    };
  }

  const rows = await ensurePartBinLocations(scope, { refresh: Boolean(options.refresh) });
  return buildSuggestionPayload(rows, scope, options.settings || {});
}

async function recordPartBinLocationFromScan(scan = {}, options = {}) {
  const scope = normalizePartBinScope(scan);
  if (!scope.dealerCode || !scope.auditId || !scope.partNumber) return [];
  if (!scope.currentBin && !normalizeBinLocation(options.binLocation || '')) return [];

  const refreshScope = {
    dealerCode: scope.dealerCode,
    auditId: scope.auditId,
    partNumber: scope.partNumber
  };
  const rows = await rebuildPartBinLocations(refreshScope);
  return rows;
}

module.exports = {
  buildSuggestionPayload,
  ensurePartBinLocations,
  getSmartBinSuggestion,
  normalizePartBinScope,
  recordPartBinLocationFromScan,
  rebuildPartBinLocations,
  sortLocationRows
};
