const express = require('express');
const Inventory = require('../models/Inventory');
const inventory = require('./inventory');
const auth = require('./auth');
const { getActiveAudit, publicAudit } = require('../utils/audit');

const router = express.Router();

async function activeDashboardScope(query = {}) {
  const filter = {};
  const dealerCode = inventory.normalizeDealerCode(query.dealerCode || query.dealer || '');
  const auditId = String(query.auditId || query.audit || '').trim();
  if (dealerCode && dealerCode !== 'ALL') filter.dealerCode = dealerCode;
  if (auditId) filter.auditId = auditId;
  const activeAudit = await getActiveAudit(filter.dealerCode ? { dealerCode: filter.dealerCode } : {});
  if (!filter.dealerCode && activeAudit && activeAudit.dealerCode) filter.dealerCode = inventory.normalizeDealerCode(activeAudit.dealerCode);
  if (!filter.auditId && activeAudit && activeAudit.auditId) filter.auditId = String(activeAudit.auditId).trim();
  return { filter, activeAudit: activeAudit ? publicAudit(activeAudit) : null };
}

router.get('/stats', auth.requireAuth, async (req, res) => {
  try {
    const { filter, activeAudit } = await activeDashboardScope(req.query);
    const stats = await inventory.dashboardStats(filter);
    stats.dealerCode = filter.dealerCode || '';
    stats.auditId = filter.auditId || '';
    const recent = await Inventory.find(inventory.applyTestScanMode({ ...filter }, 'real')).sort({ timestamp: -1, createdAt: -1 }).limit(12).lean();
    return res.json({
      success: true,
      activeAudit,
      dealerCode: filter.dealerCode || '',
      auditId: filter.auditId || '',
      stats,
      recent: recent.map(inventory.publicScan)
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
