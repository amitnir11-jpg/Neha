const express = require('express');
const Dealer = require('../models/Dealer');
const Audit = require('../models/Audit');
const auth = require('./auth');
const { auditWorkflowStatus, getActiveAudit, publicAudit } = require('../utils/audit');

const router = express.Router();

function cleanCode(value) {
  return String(value || '').trim().toUpperCase();
}

router.get('/', auth.requireAuth, async (req, res) => {
  try {
    const userAccess = await auth.userDealerAccessCodes(req.user);
    const canSeeAll = auth.isAdminRole(req.user.role);
    const dealerFilter = { dealerCode: { $not: /^SYNC/i }, dealerName: { $not: /Sync Test/i } };
    const auditFilter = {};
    if (!canSeeAll) {
      dealerFilter.dealerCode = userAccess.length ? { $in: userAccess } : '__none__';
      auditFilter.dealerCode = userAccess.length ? { $in: userAccess } : '__none__';
    }
    const dealers = await Dealer.find(dealerFilter).sort({ dealerName: 1 }).lean();
    const audits = await Audit.find(auditFilter).sort({ createdAt: -1 }).lean();
    
    // Map audit status to dealers
    const auditMap = {};
    audits.forEach(audit => {
      if (audit.auditId && !auditMap[audit.auditId]) {
        auditMap[audit.auditId] = {
          auditStatus: auditWorkflowStatus(audit),
          completedAt: audit.completedAt
        };
      }
    });
    
    // Add audit status to each dealer
    const dealersWithStatus = dealers.map(dealer => ({
      ...dealer,
      auditStatus: dealer.currentAuditId && auditMap[dealer.currentAuditId] 
        ? auditMap[dealer.currentAuditId].auditStatus 
        : 'IN_PROGRESS'
    }));
    
    res.json({ success: true, dealers: dealersWithStatus, audits });
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

    const payload = {
      dealerName,
      dealerCode,
      brand: req.body.brand || '',
      location: req.body.location || '',
      active: req.body.active !== false
    };

    const dealer = await Dealer.findOneAndUpdate(
      { dealerCode },
      payload,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const activeAudit = await getActiveAudit({ dealerCode });
    req.io.emit('dealers:update');
    res.json({ success: true, dealer, audit: activeAudit, activeAudit: activeAudit ? publicAudit(activeAudit) : null });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/:dealerCode', auth.requireAuth, async (req, res) => {
  try {
    const dealerCode = cleanCode(req.params.dealerCode);
    const access = await auth.validateUserDealerAccess(req.user, dealerCode);
    if (!access.allowed) {
      return res.status(403).json({ success: false, message: 'Unauthorized dealer access', requestedDealer: access.requestedDealer });
    }
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
