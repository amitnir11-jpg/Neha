const test = require('node:test');
const assert = require('node:assert/strict');
const { ongoingAuditScopes } = require('../utils/ongoingAuditPricing');

test('ongoing audit refresh scopes include only active audits and deduplicate audit identities', () => {
  const scopes = ongoingAuditScopes([
    { dealerCode: 'd001', auditId: 'AUD-1', status: 'ACTIVE' },
    { dealerCode: 'D001', auditId: 'AUD-1', status: 'ACTIVE' },
    { dealerCode: 'D002', auditId: 'AUD-2', auditStatus: 'IN_PROGRESS' },
    { dealerCode: 'D003', auditId: 'AUD-3', status: 'COMPLETED' },
    { dealerCode: 'D004', auditId: 'AUD-4', status: 'PAUSED' },
    { dealerCode: 'D005', status: 'ACTIVE' }
  ]);

  assert.deepEqual(scopes, [
    { dealerCode: 'D001', auditId: 'AUD-1' },
    { dealerCode: 'D002', auditId: 'AUD-2' }
  ]);
});
