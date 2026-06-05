const Audit = require('../models/Audit');
const Dealer = require('../models/Dealer');
const Setting = require('../models/Setting');

function clean(value) {
  return String(value || '').trim();
}

function cleanCode(value) {
  return clean(value).toUpperCase();
}

function activeStatusFilter() {
  return {
    $and: [
      {
        $or: [
          { status: { $in: ['active', 'open', 'IN_PROGRESS'] } },
          { status: { $exists: false } },
          { status: null },
          { status: '' }
        ]
      },
      {
        $or: [
          { auditStatus: 'IN_PROGRESS' },
          { auditStatus: { $exists: false } },
          { auditStatus: null },
          { auditStatus: '' }
        ]
      },
      { auditClosedDate: null }
    ]
  };
}

function auditWorkflowStatus(audit = {}) {
  const auditStatus = clean(audit.auditStatus).toUpperCase();
  const status = clean(audit.status).toUpperCase();
  if (auditStatus === 'COMPLETED' || status === 'COMPLETED' || status === 'CLOSED' || audit.auditClosedDate) {
    return 'COMPLETED';
  }
  return 'IN_PROGRESS';
}

function isCompletedAudit(audit = {}) {
  return auditWorkflowStatus(audit) === 'COMPLETED';
}

function publicAudit(audit = {}) {
  if (!audit) return null;
  return {
    success: true,
    dealerCode: cleanCode(audit.dealerCode),
    dealerName: clean(audit.dealerName),
    brand: clean(audit.brand),
    location: clean(audit.location),
    auditId: clean(audit.auditId || audit._id),
    auditName: clean(audit.auditName),
    auditStartDate: audit.auditStartDate || audit.createdAt || null,
    auditStatus: auditWorkflowStatus(audit)
  };
}

async function multiAuditEnabled() {
  const setting = await Setting.findOne({ key: 'multiAuditMode' }).lean();
  const value = setting ? setting.value : false;
  if (value && typeof value === 'object') return value.enabled === true;
  return value === true || value === 'true';
}

async function getActiveAudit(filter = {}) {
  const query = { ...activeStatusFilter() };
  if (filter.dealerCode) query.dealerCode = cleanCode(filter.dealerCode);
  return Audit.findOne(query).sort({ auditStartDate: -1, createdAt: -1 }).lean();
}

async function closeOtherActiveAudits(dealerCode, auditId) {
  await Audit.updateMany(
    {
      ...activeStatusFilter(),
      auditId: { $ne: auditId }
    },
    {
      $set: {
        status: 'closed',
        auditClosedDate: new Date()
      }
    }
  );
}

async function syncDealerWithAudit(audit) {
  if (!audit || !audit.dealerCode) return null;
  const completed = isCompletedAudit(audit);
  return Dealer.findOneAndUpdate(
    { dealerCode: cleanCode(audit.dealerCode) },
    {
      dealerName: clean(audit.dealerName),
      dealerCode: cleanCode(audit.dealerCode),
      brand: clean(audit.brand),
      location: clean(audit.location),
      auditName: clean(audit.auditName),
      auditStartDate: audit.auditStartDate,
      auditClosedDate: audit.auditClosedDate,
      currentAuditId: clean(audit.auditId),
      active: !completed
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

module.exports = {
  activeStatusFilter,
  auditWorkflowStatus,
  clean,
  cleanCode,
  closeOtherActiveAudits,
  getActiveAudit,
  isCompletedAudit,
  multiAuditEnabled,
  publicAudit,
  syncDealerWithAudit
};
