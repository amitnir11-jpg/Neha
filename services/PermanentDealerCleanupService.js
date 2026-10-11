const crypto = require('crypto');
const Dealer = require('../models/Dealer');
const User = require('../models/User');
const UserDealerMapping = require('../models/UserDealerMapping');
const registry = require('../models/registry');
const auth = require('../routes/auth');
const { Prisma, getPrismaClient, withDatabaseTransaction } = require('./prisma');

// Explicitly ordered so transfer and scan references are removed before audit
// parents and the dealer account. Shared rows survive because every operation
// uses the exact dealer code resolved from the immutable dealer database ID.
const DEALER_DATA_MODELS = [
  'OfflineQueue', 'DealerStock', 'BinTransferHistory', 'Inventory', 'Scan',
  'Bin', 'PartBinLocation', 'LocalPartEntry', 'MasterPart',
  'PartPriceHistory', 'DuplicateScanLog', 'DeletedScanLog', 'VerificationLog',
  'RejectedScan', 'FailedScan', 'BluetoothScanLog', 'ScannerLog',
  'ScannerSession', 'BluetoothDevice', 'Device', 'BinLabelPrintLog',
  'ReportSnapshot', 'ReportFilterSetting', 'Setting', 'SyncLog',
  'AuditRestoreLog', 'AuditLog', 'ScanAuditLog', 'Audit'
];

const COUNT_GROUPS = {
  scanRecords: ['Inventory', 'Scan'],
  deletedAndDuplicateScanRecords: ['DeletedScanLog', 'DuplicateScanLog'],
  upiRecords: ['Inventory'],
  binsAndLocations: ['Bin', 'PartBinLocation'],
  binTransfers: ['BinTransferHistory'],
  dealerStockUploads: ['DealerStock'],
  localPartEntries: ['LocalPartEntry'],
  masterPartRows: ['MasterPart'],
  mobileSyncRecords: ['OfflineQueue', 'SyncLog', 'BluetoothScanLog', 'ScannerLog', 'ScannerSession'],
  devices: ['Device', 'BluetoothDevice'],
  reportCacheAndPreferences: ['ReportSnapshot', 'ReportFilterSetting'],
  auditAndOperationalLogs: ['Audit', 'AuditLog', 'AuditRestoreLog', 'ScanAuditLog', 'VerificationLog', 'RejectedScan', 'FailedScan', 'BinLabelPrintLog'],
  priceHistory: ['PartPriceHistory'],
  settings: ['Setting']
};

class CleanupError extends Error {
  constructor(message, status = 400, code = 'CLEANUP_INVALID') {
    super(message);
    this.name = 'CleanupError';
    this.status = status;
    this.code = code;
  }
}

function cleanCode(value) {
  return String(value || '').trim().toUpperCase();
}

function stableCounts(counts) {
  return Object.fromEntries(Object.keys(counts).sort().map((key) => [key, counts[key]]));
}

function cleanupSecret() {
  return String(process.env.DEALER_CLEANUP_HMAC_SECRET || process.env.JWT_SECRET || '');
}

function makePreviewToken({ dealerId, dealerCode, counts, issuedAt = Date.now() }) {
  const secret = cleanupSecret();
  if (secret.length < 24) throw new CleanupError('Permanent cleanup is disabled until a strong JWT_SECRET or DEALER_CLEANUP_HMAC_SECRET is configured.', 503, 'CLEANUP_SECRET_MISSING');
  const payload = Buffer.from(JSON.stringify({
    dealerId: String(dealerId),
    dealerCode: cleanCode(dealerCode),
    countSignature: JSON.stringify(stableCounts(counts.perTable)),
    issuedAt
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyPreviewToken(token, { dealerId, dealerCode, counts }) {
  const [payload, signature, extra] = String(token || '').split('.');
  const secret = cleanupSecret();
  if (!payload || !signature || extra || secret.length < 24) throw new CleanupError('Preview expired. Preview the dealer again before cleanup.', 409, 'CLEANUP_PREVIEW_REQUIRED');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest();
  let actual;
  try { actual = Buffer.from(signature, 'base64url'); } catch (_error) { actual = Buffer.alloc(0); }
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new CleanupError('Preview expired. Preview the dealer again before cleanup.', 409, 'CLEANUP_PREVIEW_REQUIRED');
  }
  let claims;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (_error) { claims = null; }
  if (!claims || Date.now() - Number(claims.issuedAt) > 10 * 60 * 1000 || Number(claims.issuedAt) > Date.now() + 30000
    || String(claims.dealerId) !== String(dealerId) || cleanCode(claims.dealerCode) !== cleanCode(dealerCode)
    || claims.countSignature !== JSON.stringify(stableCounts(counts.perTable))) {
    throw new CleanupError('Dealer records changed or preview expired. Preview the dealer again before cleanup.', 409, 'CLEANUP_PREVIEW_STALE');
  }
  return true;
}

async function findDealerById(dealerId) {
  const id = String(dealerId || '').trim();
  if (!id) throw new CleanupError('Select a dealer by database ID.', 400, 'DEALER_ID_REQUIRED');
  const dealer = await Dealer.findOne({ _id: id }).lean();
  if (!dealer) throw new CleanupError('The selected dealer no longer exists.', 404, 'DEALER_NOT_FOUND');
  return dealer;
}

async function impactCounts(dealerCode) {
  const code = cleanCode(dealerCode);
  if (!code) throw new CleanupError('Dealer code is missing from the selected dealer record.', 409, 'DEALER_CODE_MISSING');
  const perTableEntries = await Promise.all(DEALER_DATA_MODELS.map(async (name) => {
    if (name === 'LocalPartEntry') {
      return [name, await getPrismaClient().localPartEntry.count({ where: { dealerCode: code } })];
    }
    const Model = registry[name];
    if (!Model || typeof Model.countDocuments !== 'function') throw new Error(`Cleanup model is unavailable: ${name}`);
    return [name, await Model.countDocuments({ dealerCode: code })];
  }));
  const perTable = Object.fromEntries(perTableEntries);
  perTable.UserDealerMapping = await UserDealerMapping.countDocuments({ $or: [{ dealerCode: code }, { dealerId: code }] });
  perTable.uniqueParts = await uniquePartCount(code);
  perTable.uniqueUpiRecords = await registry.Inventory.countDocuments({ dealerCode: code, upiCode: { $nin: [null, ''] } });
  const groups = Object.fromEntries(Object.entries(COUNT_GROUPS).map(([group, models]) => [
    group,
    models.reduce((sum, model) => sum + Number(perTable[model] || 0), 0)
  ]));
  groups.linkedUsers = (await UserDealerMapping.distinct('userId', { $or: [{ dealerCode: code }, { dealerId: code }] })).filter(Boolean).length;
  groups.uniqueParts = perTable.uniqueParts;
  groups.uniqueUpiRecords = perTable.uniqueUpiRecords;
  groups.totalOperationalRecords = Object.entries(perTable)
    .filter(([key]) => !['uniqueParts', 'uniqueUpiRecords'].includes(key))
    .reduce((sum, [, value]) => sum + Number(value || 0), 0);
  return { perTable, ...groups };
}

async function uniquePartCount(dealerCode) {
  const client = getPrismaClient();
  const rows = await client.$queryRaw(Prisma.sql`
    SELECT COUNT(DISTINCT COALESCE(
      NULLIF("normalizedPartNumber", ''),
      NULLIF("partNumber", '')
    ))::int AS count
    FROM "inventories"
    WHERE "dealerCode" = ${cleanCode(dealerCode)}
  `);
  return Number(rows?.[0]?.count || 0);
}

async function previewDealer(dealerId) {
  const dealer = await findDealerById(dealerId);
  const dealerCode = cleanCode(dealer.dealerCode);
  if (!dealerCode) throw new CleanupError('Dealer record has no dealer code; cleanup is blocked.', 409, 'DEALER_CODE_MISSING');
  const persistedDealer = await getPrismaClient().dealer.findUnique({ where: { id: String(dealer._id || dealer.id) }, select: { cleanupStatus: true } });
  if (persistedDealer?.cleanupStatus === 'DELETING') throw new CleanupError('This dealer is already locked for cleanup.', 423, 'DEALER_CLEANUP_LOCKED');
  const tombstone = await getPrismaClient().deletedDealer.findUnique({ where: { targetDealerCode: dealerCode }, select: { id: true } });
  if (tombstone) throw new CleanupError('This dealer code has already been permanently retired.', 410, 'DEALER_RETIRED');
  const counts = await impactCounts(dealerCode);
  return {
    dealer: { id: String(dealer._id || dealer.id), dealerCode, dealerName: String(dealer.dealerName || dealer.name || dealerCode) },
    counts,
    previewToken: makePreviewToken({ dealerId: dealer._id || dealer.id, dealerCode, counts })
  };
}

function isAccessForCode(user, code) {
  const values = auth.normalizeDealerAccess(user.dealerAccess);
  return values.includes(code) || cleanCode(user.dealerCode) === code || cleanCode(user.activeDealerId) === code;
}

async function removeDealerFromUsers(code) {
  const users = await User.find({}).lean();
  let updated = 0;
  for (const user of users) {
    if (!isAccessForCode(user, code)) continue;
    const nextAccess = auth.normalizeDealerAccess(user.dealerAccess).filter((item) => item !== code);
    const set = { dealerAccess: nextAccess };
    if (cleanCode(user.dealerCode) === code) set.dealerCode = '';
    if (cleanCode(user.activeDealerId) === code) set.activeDealerId = '';
    await User.updateOne({ _id: user._id }, { $set: set });
    updated += 1;
  }
  return updated;
}

async function deleteDealerDataRows(code) {
  const counts = {};
  // The bin transfer table is cleared before its source inward scans. The
  // remaining order puts audit children before audits and audits before Dealer.
  for (const name of DEALER_DATA_MODELS) {
    if (name === 'LocalPartEntry') {
      const result = await getPrismaClient().localPartEntry.deleteMany({ where: { dealerCode: code } });
      counts[name] = Number(result.count || 0);
      continue;
    }
    const result = await registry[name].deleteMany({ dealerCode: code });
    counts[name] = Number(result.deletedCount || 0);
  }
  const mappingResult = await UserDealerMapping.deleteMany({ $or: [{ dealerCode: code }, { dealerId: code }] });
  counts.UserDealerMapping = Number(mappingResult.deletedCount || 0);
  return counts;
}

function actorSnapshot(actor = {}) {
  return {
    actorUserId: String(actor.id || actor._id || ''),
    actorUsername: String(actor.username || ''),
    actorName: String(actor.name || actor.username || ''),
    actorRole: String(actor.role || '')
  };
}

function assertCleanupConfirmation({ actor, confirmed }) {
  if (!actorSnapshot(actor).actorUserId || String(actor.role || '').toLowerCase() !== 'super_admin') {
    throw new CleanupError('Only a Super Admin may permanently clean up a dealer.', 403, 'SUPER_ADMIN_REQUIRED');
  }
  if (confirmed !== true) {
    throw new CleanupError('Confirm that you want to permanently delete the selected dealer data.', 400, 'CLEANUP_CONFIRMATION_REQUIRED');
  }
}

async function runDealerCleanup(input) {
  const {
    dealerId, previewToken, operation, actor, requestIp,
    confirmed
  } = input || {};
  if (!['DELETE_DATA', 'DELETE_DEALER'].includes(operation)) throw new CleanupError('Unknown cleanup operation.', 400, 'CLEANUP_OPERATION_INVALID');
  assertCleanupConfirmation({ actor, confirmed });
  const freshActor = await User.findOne({ _id: actor?.id || actor?._id }).lean();
  if (!freshActor || String(freshActor.role || '').toLowerCase() !== 'super_admin' || freshActor.active === false || freshActor.isActive === false || freshActor.approved === false) {
    throw new CleanupError('An active Super Admin account is required.', 403, 'SUPER_ADMIN_REQUIRED');
  }
  const dealer = await findDealerById(dealerId);
  const dealerCode = cleanCode(dealer.dealerCode);
  const dealerName = String(dealer.dealerName || dealer.name || dealerCode);
  const initialCounts = await impactCounts(dealerCode);
  verifyPreviewToken(previewToken, { dealerId: dealer._id || dealer.id, dealerCode, counts: initialCounts });
  const jobId = crypto.randomUUID();
  const actorInfo = actorSnapshot(actor);
  let locked = false;

  try {
    // This lock transaction drains in-flight DB writes via the dealer row lock
    // and the migration's BEFORE INSERT/UPDATE guards.
    const lockedContext = await withDatabaseTransaction(async (client) => {
      const rows = await client.$queryRaw(Prisma.sql`
        SELECT id, "dealerCode"
        FROM dealers
        WHERE id = ${String(dealer._id || dealer.id)}
          AND upper("dealerCode") = ${dealerCode}
        FOR UPDATE
      `);
      if (!rows.length) throw new CleanupError('Selected dealer ID/code changed; preview again.', 409, 'DEALER_IDENTITY_CHANGED');
      const statusRows = await client.$queryRaw(Prisma.sql`SELECT "cleanupStatus" FROM dealers WHERE id = ${String(dealer._id || dealer.id)}`);
      if (statusRows[0]?.cleanupStatus === 'DELETING') throw new CleanupError('This dealer is already locked for cleanup.', 423, 'DEALER_CLEANUP_LOCKED');
      const tombstone = await client.deletedDealer.findUnique({ where: { targetDealerCode: dealerCode }, select: { id: true } });
      if (tombstone) throw new CleanupError('This dealer code has already been permanently retired.', 410, 'DEALER_RETIRED');
      await client.dealer.update({ where: { id: String(dealer._id || dealer.id) }, data: { cleanupStatus: 'DELETING' } });
      const lockedCounts = await impactCounts(dealerCode);
      if (JSON.stringify(stableCounts(lockedCounts.perTable)) !== JSON.stringify(stableCounts(initialCounts.perTable))) {
        throw new CleanupError('Dealer data changed after preview. No data was deleted; preview again.', 409, 'CLEANUP_PREVIEW_STALE');
      }
      await client.permanentDealerCleanupAudit.create({
        data: {
          jobId,
          targetDealerId: String(dealer._id || dealer.id),
          targetDealerCode: dealerCode,
          targetDealerName: dealerName,
          operation,
          status: 'RUNNING',
          reason: operation === 'DELETE_DEALER' ? 'Super Admin confirmed dealer and data deletion.' : 'Super Admin confirmed dealer data deletion.',
          ...actorInfo,
          backupReference: '',
          backupRestoreTested: false,
          requestIp: String(requestIp || '').slice(0, 128),
          recordCounts: lockedCounts,
          startedAt: new Date()
        }
      });
      return { counts: lockedCounts };
    }, { timeout: 120000, attempts: 3 });
    locked = true;

    const result = await withDatabaseTransaction(async (client) => {
      const current = await client.dealer.findUnique({ where: { id: String(dealer._id || dealer.id) }, select: { id: true, dealerCode: true, cleanupStatus: true } });
      if (!current || cleanCode(current.dealerCode) !== dealerCode || current.cleanupStatus !== 'DELETING') throw new CleanupError('Dealer cleanup lock was lost; cleanup stopped.', 409, 'CLEANUP_LOCK_LOST');
      const nowCounts = await impactCounts(dealerCode);
      if (JSON.stringify(stableCounts(nowCounts.perTable)) !== JSON.stringify(stableCounts(lockedContext.counts.perTable))) {
        throw new CleanupError('Dealer data changed while cleanup was locked. Cleanup rolled back.', 409, 'CLEANUP_SCOPE_CHANGED');
      }
      const userReferencesCleared = await removeDealerFromUsers(dealerCode);
      await client.$queryRaw(Prisma.sql`SELECT set_config('app.dealer_cleanup_code', ${dealerCode}, true)`);
      const deletedCounts = await deleteDealerDataRows(dealerCode);
      const remaining = await impactCounts(dealerCode);
      if (remaining.totalOperationalRecords !== 0 || remaining.linkedUsers !== 0) {
        throw new CleanupError('Dealer cleanup verification found remaining scoped records; all changes were rolled back.', 409, 'CLEANUP_VERIFY_FAILED');
      }
      if (operation === 'DELETE_DEALER') {
        await client.deletedDealer.create({ data: {
          targetDealerId: String(dealer._id || dealer.id),
          targetDealerCode: dealerCode,
          targetDealerName: dealerName,
          deleteJobId: jobId
        } });
        const removedDealer = await client.dealer.deleteMany({ where: { id: String(dealer._id || dealer.id), dealerCode } });
        if (removedDealer.count !== 1) throw new CleanupError('Dealer account was not removed; cleanup rolled back.', 409, 'DEALER_DELETE_FAILED');
      } else {
        await client.dealer.update({ where: { id: String(dealer._id || dealer.id) }, data: { cleanupStatus: null } });
      }
      await client.permanentDealerCleanupAudit.update({
        where: { jobId },
        data: { status: 'SUCCEEDED', recordCounts: { ...lockedContext.counts, deletedCounts, userReferencesCleared }, completedAt: new Date() }
      });
      return { deletedCounts, remaining, dealerDeleted: operation === 'DELETE_DEALER' };
    }, { timeout: 120000, attempts: 3 });
    return { jobId, dealerId: String(dealer._id || dealer.id), dealerCode, dealerName, ...result };
  } catch (error) {
    if (locked) {
      await withDatabaseTransaction(async (client) => {
        await client.dealer.updateMany({
          where: { id: String(dealer._id || dealer.id), dealerCode, cleanupStatus: 'DELETING' },
          data: { cleanupStatus: null }
        });
        await client.permanentDealerCleanupAudit.updateMany({
          where: { jobId },
          data: { status: 'FAILED', errorMessage: String(error.message || error).slice(0, 2000), completedAt: new Date() }
        });
      }, { timeout: 15000, attempts: 1 }).catch((unlockError) => {
        console.error('[dealer-cleanup] lock recovery failed', { jobId, message: unlockError.message });
      });
    }
    throw error;
  }
}

module.exports = {
  CleanupError,
  DEALER_DATA_MODELS,
  COUNT_GROUPS,
  impactCounts,
  previewDealer,
  makePreviewToken,
  verifyPreviewToken,
  runDealerCleanup
};
