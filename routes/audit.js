const express = require('express');
const path = require('path');
const fsp = require('fs/promises');
const Audit = require('../models/Audit');
const Dealer = require('../models/Dealer');
const Inventory = require('../models/Inventory');
const User = require('../models/User');
const OfflineQueue = require('../models/OfflineQueue');
const SyncLog = require('../models/SyncLog');
const AuditLogService = require('../services/AuditLogService');
const auth = require('./auth');
const { compactClosedAuditRawScans } = require('../services/AuditArchiveService');
const {
  clean,
  cleanCode,
  getActiveAudit,
  publicAudit,
  syncDealerWithAudit
} = require('../utils/audit');

const router = express.Router();
const AUDIT_DATA_DIR = require('../utils/writablePaths').writablePath('Audit Data');

async function buildAuditId(dealerCode) {
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `AUD-${cleanCode(dealerCode)}-${datePart}-`;
  const audits = await Audit.find({ dealerCode: cleanCode(dealerCode) }).select('auditId').lean();
  let next = audits.reduce((max, row) => {
    const id = String(row.auditId || '');
    if (!id.startsWith(prefix)) return max;
    const suffix = Number(id.slice(prefix.length));
    return Number.isInteger(suffix) ? Math.max(max, suffix) : max;
  }, 0) + 1;
  let candidate = `${prefix}${String(next).padStart(3, '0')}`;
  while (await Audit.findOne({ auditId: candidate }).select('id').lean()) {
    next += 1;
    candidate = `${prefix}${String(next).padStart(3, '0')}`;
  }
  return candidate;
}

function safeArchiveName(value = '') {
  return clean(value).replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'audit';
}

async function auditUserPayload(body = {}) {
  const auditUserKey = clean(body.auditUserId || body.auditorUsername);
  let auditUser = null;
  if (auditUserKey) {
    const clauses = [
      { username: auditUserKey.toLowerCase() },
      { email: auditUserKey.toLowerCase() }
    ];
    if (/^[a-f0-9]{24}$/i.test(auditUserKey)) clauses.push({ _id: auditUserKey });
    auditUser = await User.findOne({ $or: clauses }).lean();
  }
  return {
    auditUserId: auditUser ? String(auditUser._id) : auditUserKey,
    auditorUsername: auditUser ? auditUser.username || '' : clean(body.auditorUsername).toLowerCase(),
    auditorName: clean(body.auditorName || (auditUser && (auditUser.name || auditUser.username)) || '')
  };
}

async function completionBlockers(audit) {
  const scope = { dealerCode: cleanCode(audit.dealerCode), auditId: clean(audit.auditId) };
  const [pendingOfflineSync, failedOfflineSync, pendingServerSync] = await Promise.all([
    OfflineQueue.countDocuments({ ...scope, status: { $in: ['pending', 'syncing'] } }),
    OfflineQueue.countDocuments({ ...scope, status: 'failed' }),
    SyncLog.countDocuments({ ...scope, status: { $in: ['pending', 'partial'] } })
  ]);
  return { pendingOfflineSync, failedOfflineSync, pendingServerSync };
}

function hasCompletionBlockers(blockers = {}) {
  return Object.values(blockers).some((count) => Number(count) > 0);
}

async function createClosedAuditBackup(audit, completedBy = '') {
  await fsp.mkdir(AUDIT_DATA_DIR, { recursive: true });
  const dealerCode = cleanCode(audit.dealerCode);
  const auditId = clean(audit.auditId);
  const [dealer, scans] = await Promise.all([
    Dealer.findOne({ dealerCode }).lean(),
    Inventory.find({ dealerCode, auditId }).lean()
  ]);
  const generatedAt = new Date();
  const archiveId = `${safeArchiveName(dealerCode)}_${safeArchiveName(auditId)}_${generatedAt.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}.json`;
  const archivePath = path.join(AUDIT_DATA_DIR, archiveId);
  const backup = {
    manifest: {
      archiveId,
      dealerCode,
      dealerName: dealer ? dealer.dealerName : audit.dealerName,
      auditId,
      auditName: audit.auditName,
      createdAt: generatedAt.toISOString(),
      createdBy: completedBy || 'System',
      purpose: 'Pre-compaction closed audit backup'
    },
    collections: {
      audits: [audit],
      dealers: dealer ? [dealer] : [],
      inventory: scans
    }
  };
  await fsp.writeFile(archivePath, JSON.stringify(backup, null, 2), 'utf8');
  return { archiveId, archivePath, scanCount: scans.length };
}

router.get('/active', auth.requireAuth, async (req, res) => {
  try {
    if (!cleanCode(req.query.dealerCode || req.activeDealerId)) {
      return res.status(400).json({ success: false, message: 'Dealer code is required to resolve an active audit.' });
    }
    const activeAudit = await getActiveAudit({ dealerCode: req.query.dealerCode || req.activeDealerId });
    if (!activeAudit) {
      return res.json({
        success: false,
        message: 'No active audit found. Please start audit from PC Admin.'
      });
    }
    return res.json(publicAudit(activeAudit));
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const dealerCode = cleanCode(req.body.dealerCode);
    const dealerName = clean(req.body.dealerName);
    if (!dealerCode || !dealerName) {
      return res.status(400).json({ success: false, message: 'Dealer name and dealer code are required' });
    }

    const statusText = clean(req.body.auditStatus || req.body.status || 'ACTIVE').toUpperCase();
    const isClosed = ['CLOSED', 'COMPLETED'].includes(statusText);
    const startsActive = ['ACTIVE', 'IN_PROGRESS', 'OPEN'].includes(statusText);
    if (!['DRAFT', 'ACTIVE', 'IN_PROGRESS', 'OPEN', 'PAUSED', 'COMPLETED', 'CLOSED', 'LOCKED', 'ARCHIVED'].includes(statusText)) {
      return res.status(400).json({ success: false, message: 'Invalid audit status' });
    }
    const requestedAuditId = cleanCode(req.body.auditId) || await buildAuditId(dealerCode);
    if (startsActive) {
      const existingActive = await getActiveAudit({ dealerCode });
      if (existingActive && clean(existingActive.auditId) !== requestedAuditId) {
        return res.status(409).json({
          success: false,
          code: 'ACTIVE_AUDIT_EXISTS',
          message: 'An active audit already exists for this dealer.',
          activeAudit: publicAudit(existingActive),
          options: ['OPEN_EXISTING_AUDIT', 'COMPLETE_EXISTING_AUDIT']
        });
      }
    }
    const auditClosedDate = isClosed ? new Date() : undefined;
    const auditId = requestedAuditId;
    const auditUser = await auditUserPayload(req.body);
    // Establish the dealer master row before creating its audit session. This
    // also satisfies the dealer/audit foreign key for new PostgreSQL writes.
    await Dealer.findOneAndUpdate(
      { dealerCode },
      {
        dealerCode,
        dealerName,
        brand: clean(req.body.brand),
        location: clean(req.body.location),
        active: true
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const payload = {
      auditId,
      auditName: clean(req.body.auditName || `${dealerCode} Audit`),
      dealerName,
      dealerCode,
      brand: clean(req.body.brand),
      location: clean(req.body.location),
      auditStartDate: req.body.auditStartDate ? new Date(req.body.auditStartDate) : new Date(),
      auditClosedDate,
      auditUserId: auditUser.auditUserId,
      auditorUsername: auditUser.auditorUsername,
      auditorName: auditUser.auditorName,
      generalManager: clean(req.body.generalManager),
      spmName: clean(req.body.spmName),
      auditStatus: startsActive ? 'ACTIVE' : statusText,
      completedAt: auditClosedDate,
      status: startsActive ? 'ACTIVE' : statusText
    };
    if (!isClosed) {
      delete payload.auditClosedDate;
      delete payload.completedAt;
    }

    const audit = await Audit.findOneAndUpdate(
      { auditId },
      isClosed ? { $set: payload } : { $set: payload, $unset: { auditClosedDate: '', completedAt: '', completedBy: '', completedByUserId: '', completionRemark: '' } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await AuditLogService.record({
      req,
      eventType: isClosed ? 'AUDIT_COMPLETED' : startsActive ? 'AUDIT_STARTED' : 'AUDIT_CREATED',
      module: 'audit',
      message: `Audit ${auditId} ${isClosed ? 'completed' : startsActive ? 'started' : 'created'} for dealer ${dealerCode}`,
      dealerCode,
      auditId,
      metadata: { auditStatus: audit.auditStatus, auditName: audit.auditName }
    });
    const dealer = await syncDealerWithAudit(audit);

    const io = req.io || req.app.get('io');
    if (io) {
      io.emit('audit:active', publicAudit(audit));
      io.emit('dealers:update');
    }

    return res.json({ success: true, audit, dealer, activeAudit: startsActive ? publicAudit(audit) : null });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/:auditId/close', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const auditId = clean(req.params.auditId);
    const currentAudit = await Audit.findOne({ auditId }).lean();
    if (!currentAudit) return res.status(404).json({ success: false, message: 'Audit not found' });
    const blockers = await completionBlockers(currentAudit);
    if (hasCompletionBlockers(blockers) && req.body.confirmPending !== true) {
      return res.status(409).json({ success: false, code: 'AUDIT_COMPLETION_PENDING_ITEMS', message: 'Pending sync items require explicit confirmation before audit completion.', blockers });
    }
    const completedAt = new Date();
    const completedByUser = req.user ? (req.user.name || req.user.username || req.user.email || '') : '';
    const audit = await Audit.findOneAndUpdate(
      { auditId },
      {
        status: 'closed',
        auditStatus: 'COMPLETED',
        auditClosedDate: completedAt,
        completedAt,
        completedBy: completedByUser
      },
      { new: true }
    );
    if (!audit) return res.status(404).json({ success: false, message: 'Audit not found' });
    await AuditLogService.record({
      req,
      eventType: 'AUDIT_COMPLETED',
      module: 'audit',
      message: `Audit ${auditId} completed`,
      dealerCode: audit.dealerCode,
      auditId,
      metadata: { pendingSyncConfirmed: req.body.confirmPending === true }
    });
    await syncDealerWithAudit(audit);
    const backupArchive = await createClosedAuditBackup(audit.toObject ? audit.toObject() : audit, completedByUser);
    const rawArchive = await compactClosedAuditRawScans({ dealerCode: audit.dealerCode, auditId: audit.auditId });

    const io = req.io || req.app.get('io');
    if (io) {
      io.emit('audit:closed', { auditId, dealerCode: audit.dealerCode });
      io.emit('dealers:update');
    }

    return res.json({ success: true, audit, backupArchive, rawArchive });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Update audit status to COMPLETED
router.post('/:auditId/status/complete', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const auditId = clean(req.params.auditId);
    const remark = clean(req.body.remark || '');
    const completedAt = new Date();
    const completedByUser = req.user ? (req.user.name || req.user.username || req.user.email || '') : 'System';
    const audit = await Audit.findOne({ auditId });

    if (!audit) {
      return res.status(404).json({ success: false, message: 'Audit not found' });
    }

    const blockers = await completionBlockers(audit);
    if (hasCompletionBlockers(blockers) && req.body.confirmPending !== true) {
      return res.status(409).json({ success: false, code: 'AUDIT_COMPLETION_PENDING_ITEMS', message: 'Pending sync items require explicit confirmation before audit completion.', blockers });
    }

    // Create status history entry
    const statusHistoryEntry = {
      status: 'COMPLETED',
      changedAt: completedAt,
      changedBy: completedByUser,
      remark: remark
    };

    // Update audit status
    const updatedAudit = await Audit.findOneAndUpdate(
      { auditId },
      {
        $set: {
          auditStatus: 'COMPLETED',
          status: 'COMPLETED',
          auditClosedDate: completedAt,
          completedAt,
          completedBy: completedByUser,
          completedByUserId: req.user ? (req.user.id || req.user._id || '') : '',
          completionRemark: remark
        },
        $push: { statusHistory: statusHistoryEntry }
      },
      { new: true }
    );

    if (!updatedAudit) {
      return res.status(404).json({ success: false, message: 'Failed to update audit status' });
    }

    const dealer = await syncDealerWithAudit(updatedAudit);

    const io = req.io || req.app.get('io');
    if (io) {
      io.emit('audit:completed', { auditId, dealerCode: updatedAudit.dealerCode });
      io.emit('dealers:update');
    }

    return res.json({ success: true, audit: updatedAudit, dealer, activeAudit: null });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Update audit status from COMPLETED back to IN_PROGRESS (Admin only)
router.post('/:auditId/status/reopen', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const auditId = clean(req.params.auditId);
    const remark = clean(req.body.remark || '');
    const audit = await Audit.findOne({ auditId });

    if (!audit) {
      return res.status(404).json({ success: false, message: 'Audit not found' });
    }

    if (audit.auditStatus !== 'COMPLETED') {
      return res.status(400).json({ success: false, message: 'Only completed audits can be reopened' });
    }

    // Create status history entry
    const statusHistoryEntry = {
      status: 'IN_PROGRESS',
      changedAt: new Date(),
      changedBy: req.user ? (req.user.name || req.user.username || req.user.email || '') : 'System',
      remark: remark
    };

    // Update audit status
    const updatedAudit = await Audit.findOneAndUpdate(
      { auditId },
      {
        $set: {
          auditStatus: 'IN_PROGRESS',
          status: 'IN_PROGRESS'
        },
        $unset: {
          auditClosedDate: '',
          completedAt: '',
          completedBy: '',
          completedByUserId: '',
          completionRemark: ''
        },
        $push: { statusHistory: statusHistoryEntry }
      },
      { new: true }
    );

    if (!updatedAudit) {
      return res.status(404).json({ success: false, message: 'Failed to reopen audit' });
    }

    const dealer = await syncDealerWithAudit(updatedAudit);

    const io = req.io || req.app.get('io');
    if (io) {
      io.emit('audit:reopened', { auditId, dealerCode: updatedAudit.dealerCode });
      io.emit('audit:active', publicAudit(updatedAudit));
      io.emit('dealers:update');
    }

    return res.json({ success: true, audit: updatedAudit, dealer, activeAudit: publicAudit(updatedAudit) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/:auditId/status', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const auditId = clean(req.params.auditId);
    const nextStatus = clean(req.body.status || req.body.auditStatus).toUpperCase();
    if (!['DRAFT', 'ACTIVE', 'PAUSED', 'LOCKED', 'ARCHIVED'].includes(nextStatus)) {
      return res.status(400).json({ success: false, message: 'Status must be DRAFT, ACTIVE, PAUSED, LOCKED, or ARCHIVED' });
    }
    const audit = await Audit.findOne({ auditId });
    if (!audit) return res.status(404).json({ success: false, message: 'Audit not found' });
    if (nextStatus === 'ACTIVE') {
      const existingActive = await getActiveAudit({ dealerCode: audit.dealerCode });
      if (existingActive && clean(existingActive.auditId) !== auditId) {
        return res.status(409).json({
          success: false,
          code: 'ACTIVE_AUDIT_EXISTS',
          message: 'An active audit already exists for this dealer.',
          activeAudit: publicAudit(existingActive),
          options: ['OPEN_EXISTING_AUDIT', 'COMPLETE_EXISTING_AUDIT']
        });
      }
    }
    const changedAt = new Date();
    const changedBy = req.user ? (req.user.name || req.user.username || '') : '';
    const statusUpdate = { auditStatus: nextStatus, status: nextStatus };
    if (nextStatus === 'LOCKED') {
      statusUpdate.lockedBy = changedBy;
      statusUpdate.lockedByUserId = clean(req.user && (req.user.id || req.user._id));
      statusUpdate.lockedAt = changedAt;
    }
    const updatedAudit = await Audit.findOneAndUpdate(
      { auditId },
      {
        $set: statusUpdate,
        $unset: {
          auditClosedDate: '', completedAt: '', completedBy: '', completedByUserId: '', completionRemark: '',
          ...(nextStatus === 'ACTIVE' ? { lockedBy: '', lockedByUserId: '', lockedAt: '' } : {})
        },
        $push: { statusHistory: { status: nextStatus, changedAt, changedBy, remark: clean(req.body.remark) } }
      },
      { new: true }
    );
    await AuditLogService.record({
      req,
      eventType: nextStatus === 'LOCKED' ? 'AUDIT_LOCKED' : nextStatus === 'ACTIVE' ? 'AUDIT_STARTED' : `AUDIT_${nextStatus}`,
      module: 'audit',
      message: `Audit ${auditId} changed to ${nextStatus}`,
      dealerCode: audit.dealerCode,
      auditId,
      metadata: { auditStatus: nextStatus, remark: clean(req.body.remark), lockedAt: nextStatus === 'LOCKED' ? changedAt : undefined }
    });
    const dealer = await syncDealerWithAudit(updatedAudit);
    const io = req.io || req.app.get('io');
    io?.to(`dealer:${cleanCode(audit.dealerCode)}:audit:${auditId}`).emit('audit:status', publicAudit(updatedAudit));
    return res.json({ success: true, audit: updatedAudit, dealer, activeAudit: nextStatus === 'ACTIVE' ? publicAudit(updatedAudit) : null });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
