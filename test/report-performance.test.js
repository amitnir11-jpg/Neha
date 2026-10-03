const assert = require('node:assert/strict');
const { test } = require('node:test');
const reports = require('../routes/report');
const Inventory = require('../models/Inventory');

test('full-master reconciliation reuses supplied inventory even on refresh', async () => {
  const original = Inventory.find;
  Inventory.find = () => { throw new Error('Inventory must not be loaded again'); };
  try {
    const result = await reports.validateValuationReports({
      dealerCode: 'D01', auditId: 'AUD-1', showFullMasterWithZeroScan: 'on', refresh: 'true'
    }, { partwise: { rows: [], summary: {}, selectedDealer: null, selectedAudit: null } });
    assert.equal(result.passed, true);
    assert.equal(result.totals.partwise, 0);
  } finally {
    Inventory.find = original;
  }
});
