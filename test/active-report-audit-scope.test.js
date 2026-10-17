const assert = require('node:assert/strict');
const test = require('node:test');

const reportRoute = require('../routes/report');
const Audit = require('../models/Audit');

function activeAuditQuery(audit) {
  return {
    sort() { return this; },
    lean: async () => audit
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('report requests are bound to the current active audit and reject completed audit IDs', async (t) => {
  const originalFindOne = Audit.findOne;
  t.after(() => { Audit.findOne = originalFindOne; });
  Audit.findOne = () => activeAuditQuery({ dealerCode: 'D-A', auditId: 'AUD-ACTIVE', auditStatus: 'ACTIVE' });

  const request = { method: 'GET', query: { dealerCode: 'D-A' } };
  const response = responseRecorder();
  let continued = false;
  await reportRoute.scopeReportRequestToActiveAudit(request, response, () => { continued = true; });
  assert.equal(continued, true);
  assert.equal(request.query.auditId, 'AUD-ACTIVE');
  assert.equal(request.query._includeAllAudits, false);

  const deniedRequest = { method: 'GET', query: { dealerCode: 'D-A', auditId: 'AUD-COMPLETED' } };
  const deniedResponse = responseRecorder();
  await reportRoute.scopeReportRequestToActiveAudit(deniedRequest, deniedResponse, () => {});
  assert.equal(deniedResponse.statusCode, 409);
  assert.equal(deniedResponse.body.code, 'REPORT_AUDIT_NOT_ACTIVE');
});

test('report requests reject a dealer with no running audit', async (t) => {
  const originalFindOne = Audit.findOne;
  t.after(() => { Audit.findOne = originalFindOne; });
  Audit.findOne = () => activeAuditQuery(null);

  const response = responseRecorder();
  await reportRoute.scopeReportRequestToActiveAudit({ method: 'GET', query: { dealerCode: 'D-CLOSED' } }, response, () => {});
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'REPORT_AUDIT_NOT_ACTIVE');
});
