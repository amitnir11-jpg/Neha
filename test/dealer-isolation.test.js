const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const path = require('node:path');
const { matchesFilter } = require('../models/prismaModel');
const { dealerScopedPartLookup } = require('../utils/partMasterPrice');
const { candidateQuery, recordsQuery } = require('../services/PartSuggestionService');
const { extractRequestDealer, extractRequestDealerCodes, applyRequestDealer } = require('../routes/auth');
const { assertScanModificationAccess } = require('../utils/scanModificationAccess');

test('request dealer context is request-local and rejects conflicting aliases or batch rows', () => {
  const requestA = { query: { activeDealerId: 'D-A' }, body: { dealerCode: 'D-A' }, params: {} };
  const requestB = { query: { dealerCode: 'D-B' }, body: {}, params: {} };
  assert.equal(extractRequestDealer(requestA), 'D-A');
  assert.equal(extractRequestDealer(requestB), 'D-B');
  assert.deepEqual(extractRequestDealerCodes(requestA), ['D-A']);
  assert.deepEqual(extractRequestDealerCodes({ query: { activeDealerId: 'D-A' }, body: { dealerCode: 'D-B' } }), ['D-A', 'D-B']);
  assert.deepEqual(extractRequestDealerCodes({ body: { dealerCode: 'D-A', scans: [{ dealerCode: 'D-B' }] } }), ['D-A', 'D-B']);
});

test('authenticated dealer is copied into each request field consumed by route handlers', () => {
  const req = { query: { activeDealerId: 'D-A', dealerCode: 'D-A' }, body: { dealerCode: 'D-A', scans: [{ dealerCode: 'D-A' }] } };
  applyRequestDealer(req, 'D-A');
  assert.equal(req.activeDealerId, 'D-A');
  assert.equal(req.query.dealerCode, 'D-A');
  assert.equal(req.body.dealerCode, 'D-A');
  assert.equal(req.body.scans[0].dealerCode, 'D-A');
});

test('dealer master lookups include only the selected dealer and shared rows, including legacy fallback scope', () => {
  const query = { $or: [{ partNumber: 'PART-1' }, { normalizedPartNumber: 'PART-1' }] };
  const scoped = dealerScopedPartLookup(query, 'D-A');
  for (const dealerCode of ['D-A', null, '', 'ALL']) {
    assert.equal(matchesFilter({ partNumber: 'PART-1', dealerCode }, scoped), true, `${dealerCode} remains in the selected/shared scope`);
  }
  assert.equal(matchesFilter({ partNumber: 'PART-1', dealerCode: 'D-B' }, scoped), false);
  const sharedOnly = dealerScopedPartLookup(query, '');
  assert.equal(matchesFilter({ partNumber: 'PART-1', dealerCode: 'D-B' }, sharedOnly), false);
});

test('PostgreSQL suggestion queries never drop dealer predicates when the selected dealer is missing', () => {
  const selected = candidateQuery('MASTER_PART', 'exact', 'PART-1', 'D-A', 10);
  const noSelection = candidateQuery('MASTER_PART', 'exact', 'PART-1', '', 10);
  const detailFallback = recordsQuery('MASTER_PART', ['PART-1'], 'D-A');
  assert.ok(selected.text.includes('"dealerCode"'));
  assert.ok(selected.values.includes('D-A'));
  assert.ok(!selected.text.includes('TRUE'));
  assert.ok(noSelection.text.includes('"dealerCode" IS NULL'));
  assert.ok(!noSelection.text.includes('TRUE'));
  assert.ok(detailFallback.text.includes('"dealerCode"'));
  assert.ok(detailFallback.values.includes('D-A'));
});

test('Admin scan edits cannot cross the selected dealer boundary', () => {
  assert.throws(() => assertScanModificationAccess({ user: { role: 'admin' }, activeDealerId: 'D-A' }, { dealerCode: 'D-B' }),
    error => error.status === 403 && /another dealer/i.test(error.message));
  assert.doesNotThrow(() => assertScanModificationAccess({ user: { role: 'admin' }, activeDealerId: 'D-A' }, { dealerCode: 'D-A' }));
});

test('server has no process-wide currentDealerId variable', () => {
  for (const file of ['server.js', 'routes/auth.js', 'routes/inventory.js', 'routes/sync.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(source, /(?:let|var)\s+currentDealerId\b/);
  }
});
