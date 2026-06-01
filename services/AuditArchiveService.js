const Inventory = require('../models/Inventory');

function clean(value) {
  return String(value || '').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

async function compactClosedAuditRawScans({ dealerCode = '', auditId = '' } = {}) {
  const filter = {};
  if (dealerCode) filter.dealerCode = upper(dealerCode);
  if (auditId) filter.auditId = clean(auditId);
  if (!Object.keys(filter).length) return { modifiedCount: 0 };
  const result = await Inventory.updateMany(filter, {
    $unset: {
      rawScan: '',
      rawScanString: '',
      rawBarcode: '',
      rawQR: '',
      rawUpi: ''
    },
    $set: { rawScanArchivedAt: new Date() }
  });
  return { modifiedCount: result.modifiedCount || result.nModified || 0 };
}

module.exports = {
  compactClosedAuditRawScans
};
