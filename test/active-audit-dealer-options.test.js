const assert = require('node:assert/strict');
const test = require('node:test');

const auth = require('../routes/auth');
const Dealer = require('../models/Dealer');
const Audit = require('../models/Audit');

function sortedQuery(rows) {
  return { sort() { return this; }, lean: async () => rows };
}

test('login and dealer selectors receive only dealers with a running audit', async (t) => {
  const originalDealerFind = Dealer.find;
  const originalAuditFind = Audit.find;
  t.after(() => {
    Dealer.find = originalDealerFind;
    Audit.find = originalAuditFind;
  });
  Dealer.find = () => sortedQuery([
    { dealerCode: 'ACTIVE', dealerName: 'Running dealer', active: true },
    { dealerCode: 'COMPLETE', dealerName: 'Closed dealer', active: true }
  ]);
  Audit.find = () => sortedQuery([
    { dealerCode: 'ACTIVE', auditId: 'AUD-RUNNING', auditStatus: 'ACTIVE' }
  ]);

  const dealers = await auth.activeDealersForUser({ role: 'super_admin', dealerAccess: ['ALL'] });
  assert.deepEqual(dealers.map((dealer) => dealer.dealerCode), ['ACTIVE']);
  assert.equal(dealers[0].currentAuditId, 'AUD-RUNNING');
});
