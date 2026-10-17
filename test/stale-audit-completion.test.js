const assert = require('node:assert/strict');
const test = require('node:test');

const auditRoute = require('../routes/audit');
const Audit = require('../models/Audit');
const Dealer = require('../models/Dealer');
const AuditLogService = require('../services/AuditLogService');

test('completion recovers a dealer-owned legacy currentAuditId with no stored status', async (t) => {
  const originals = [
    [Audit, 'findOne', Audit.findOne],
    [Audit, 'findOneAndUpdate', Audit.findOneAndUpdate],
    [Dealer, 'findOne', Dealer.findOne],
    [AuditLogService, 'record', AuditLogService.record]
  ];
  t.after(() => originals.forEach(([target, key, value]) => { target[key] = value; }));

  let recoveryPayload;
  let recoveryLog;
  Audit.findOne = async () => null;
  Audit.findOneAndUpdate = async (_filter, update) => {
    recoveryPayload = update.$setOnInsert;
    return { ...recoveryPayload };
  };
  Dealer.findOne = () => ({ lean: async () => ({
    dealerCode: '11688', dealerName: 'Legacy Dealer', currentAuditId: 'AUD-LEGACY-11688', active: true
  }) });
  AuditLogService.record = async entry => { recoveryLog = entry; };

  const audit = await auditRoute.resolveCompletionAudit('AUD-LEGACY-11688', '11688', { user: { username: 'admin' } });
  assert.equal(audit.auditId, 'AUD-LEGACY-11688');
  assert.equal(recoveryPayload.dealerCode, '11688');
  assert.equal(recoveryPayload.auditStatus, 'IN_PROGRESS');
  assert.equal(recoveryLog.eventType, 'AUDIT_SESSION_RECOVERED');
});

test('completion resolves the dealer active audit when the browser sends a legacy audit ID', async (t) => {
  const originals = [
    [Audit, 'findOne', Audit.findOne],
    [Dealer, 'findOne', Dealer.findOne]
  ];
  t.after(() => originals.forEach(([target, key, value]) => { target[key] = value; }));

  Audit.findOne = filter => {
    if (filter.$and) return { sort() { return this; }, lean: async () => ({ auditId: 'AUD-RUNNING', dealerCode: '11688', auditStatus: 'IN_PROGRESS' }) };
    return Promise.resolve(null);
  };
  Dealer.findOne = () => ({ lean: async () => ({ dealerCode: '11688', currentAuditId: 'AUD-LEGACY-11688', active: true }) });

  const audit = await auditRoute.resolveCompletionAudit('BROWSER-STALE-ID', '11688', {});
  assert.equal(audit.auditId, 'AUD-RUNNING');
});
