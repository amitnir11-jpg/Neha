const express = require('express');
const path = require('path');
const fsp = require('fs/promises');
const Audit = require('../models/Audit');
const Dealer = require('../models/Dealer');
const Inventory = require('../models/Inventory');
const auth = require('./auth');
const { compactClosedAuditRawScans, rebuildMovementSummaries } = require('../services/inventoryMovementSummary');
const {
  clean,
  cleanCode,
  closeOtherActiveAudits,
  getActiveAudit,
  multiAuditEnabled,
  publicAudit,
  syncDealerWithAudit
} = require('../utils/audit');

const router = express.Router();
const AUDIT_DATA_DIR = path.resolve(__dirname, '..', 'Audit Data');

function buildAuditId(dealerCode, auditName) {
  const namePart = clean(auditName || 'AUDIT').replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 12);
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `AUD-${dealerCode}-${namePart}-${stamp}`;
}

function safeArchiveName(value = '') {
  return clean(value).replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'audit';
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

router.get('/active', auth.optionalAuth, async (req, res) => {
  try {
    const activeAudit = await getActiveAudit({ dealerCode: req.query.dealerCode });
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

    const statusText = clean(req.body.auditStatus || req.body.status || 'Active').toLowerCase();
    const isClosed = statusText === 'closed';
    const auditId = cleanCode(req.body.auditId) || buildAuditId(dealerCode, req.body.auditName);
    const payload = {
      auditId,
      auditName: clean(req.body.auditName || `${dealerCode} Audit`),
      dealerName,
      dealerCode,
      brand: clean(req.body.brand),
      location: clean(req.body.location),
      auditStartDate: req.body.auditStartDate ? new Date(req.body.auditStartDate) : new Date(),
      auditClosedDate: isClosed ? new Date() : undefined,
      auditorName: clean(req.body.auditorName),
      generalManager: clean(req.body.generalManager),
      spmName: clean(req.body.spmName),
      status: isClosed ? 'closed' : 'active'
    };
    if (!isClosed) delete payload.auditClosedDate;

    if (!isClosed && !(await multiAuditEnabled())) {
      await closeOtherActiveAudits(dealerCode, auditId);
    }

    const audit = await Audit.findOneAndUpdate(
      { auditId },
      isClosed ? { $set: payload } : { $set: payload, $unset: { auditClosedDate: '' } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const dealer = await syncDealerWithAudit(audit);

    const io = req.io || req.app.get('io');
    if (io) {
      io.emit('audit:active', publicAudit(audit));
      io.emit('dealers:update');
    }

    return res.json({ success: true, audit, dealer, activeAudit: isClosed ? null : publicAudit(audit) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/:auditId/close', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const auditId = clean(req.params.auditId);
    const completedByUser = req.user ? (req.user.name || req.user.username || req.user.email || '') : '';
    const audit = await Audit.findOneAndUpdate(
      { auditId },
      { status: 'closed', auditClosedDate: new Date(), completedBy: completedByUser },
      { new: true }
    );
    if (!audit) return res.status(404).json({ success: false, message: 'Audit not found' });
    await syncDealerWithAudit(audit);
    const backupArchive = await createClosedAuditBackup(audit.toObject ? audit.toObject() : audit, completedByUser);
    const movementSummary = await rebuildMovementSummaries({ dealerCode: audit.dealerCode, auditId: audit.auditId });
    const rawArchive = await compactClosedAuditRawScans({ dealerCode: audit.dealerCode, auditId: audit.auditId });

    const io = req.io || req.app.get('io');
    if (io) {
      io.emit('audit:closed', { auditId, dealerCode: audit.dealerCode });
      io.emit('dealers:update');
    }

    return res.json({ success: true, audit, backupArchive, movementSummary, rawArchive });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
