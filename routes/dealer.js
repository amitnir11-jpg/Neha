const express = require('express');
const Dealer = require('../models/Dealer');
const Audit = require('../models/Audit');
const auth = require('./auth');
const { closeOtherActiveAudits, multiAuditEnabled, publicAudit } = require('../utils/audit');

const router = express.Router();

function cleanCode(value) {
  return String(value || '').trim().toUpperCase();
}

function buildAuditId(dealerCode, auditName) {
  const namePart = String(auditName || 'AUDIT').replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 12);
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `AUD-${dealerCode}-${namePart}-${stamp}`;
}

router.get('/', auth.requireAuth, async (req, res) => {
  try {
    const dealers = await Dealer.find({ dealerCode: { $not: /^SYNC/i }, dealerName: { $not: /Sync Test/i } }).sort({ dealerName: 1 }).lean();
    const audits = await Audit.find({}).sort({ createdAt: -1 }).lean();
    res.json({ success: true, dealers, audits });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const dealerCode = cleanCode(req.body.dealerCode);
    const dealerName = String(req.body.dealerName || '').trim();
    if (!dealerCode || !dealerName) {
      return res.status(400).json({ success: false, message: 'Dealer name and dealer code are required' });
    }

    const auditId = cleanCode(req.body.auditId) || buildAuditId(dealerCode, req.body.auditName);
    const payload = {
      dealerName,
      dealerCode,
      brand: req.body.brand || '',
      location: req.body.location || '',
      auditName: req.body.auditName || '',
      auditStartDate: req.body.auditStartDate || undefined,
      auditClosedDate: req.body.auditClosedDate || undefined,
      auditorName: req.body.auditorName || '',
      generalManager: req.body.generalManager || '',
      spmName: req.body.spmName || '',
      currentAuditId: auditId,
      active: req.body.active !== false
    };

    const dealer = await Dealer.findOneAndUpdate(
      { dealerCode },
      payload,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const isClosed = Boolean(payload.auditClosedDate) || String(req.body.auditStatus || req.body.status || '').toLowerCase() === 'closed';
    if (!isClosed) delete payload.auditClosedDate;
    if (!isClosed && !(await multiAuditEnabled())) {
      await closeOtherActiveAudits(dealerCode, auditId);
    }

    const audit = await Audit.findOneAndUpdate(
      { auditId },
      isClosed ? { $set: {
        ...payload,
        auditId,
        status: isClosed ? 'closed' : 'active'
      } } : { $set: {
        ...payload,
        auditId,
        status: 'active'
      }, $unset: { auditClosedDate: '' } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    if (req.io && !isClosed) req.io.emit('audit:active', publicAudit(audit));
    req.io.emit('dealers:update');
    res.json({ success: true, dealer, audit, activeAudit: isClosed ? null : publicAudit(audit) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/:dealerCode', auth.requireAuth, async (req, res) => {
  try {
    const dealerCode = cleanCode(req.params.dealerCode);
    const dealer = await Dealer.findOne({ dealerCode }).lean();
    const audits = await Audit.find({ dealerCode }).sort({ createdAt: -1 }).lean();
    if (!dealer) {
      return res.status(404).json({ success: false, message: 'Dealer not found' });
    }
    res.json({ success: true, dealer, audits });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
