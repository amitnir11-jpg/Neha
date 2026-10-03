const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const { savedAuditPrice } = require('../utils/partMasterPrice');

function loadFunction(file, start, end, context) {
  const source = fs.readFileSync(file, 'utf8');
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))), context);
  return context;
}

function priceHarness(savedScan = null, savedStock = null) {
  let lookups = 0;
  const reads = [];
  const model = (name, row) => ({ findOne: () => {
    reads.push(name);
    return { sort: () => ({ lean: async () => row }) };
  } });
  const context = loadFunction('routes/sync.js', 'async function getMasterPrice(', 'function validDate(', {
    getPriceFromPartMaster: async () => { lookups++; return { partNumber: 'PART1', mrp: 100, dlc: 80 }; },
    Inventory: model('inventory', savedScan), DealerStock: model('stock', savedStock),
    normalizePartNo: value => value, upper: value => value, clean: value => value, savedAuditPrice
  });
  return { context, reads, lookups: () => lookups };
}

test('save reuses validated price and preserves the audit price snapshot', async () => {
  const { context, reads, lookups } = priceHarness({ partNumber: 'PART1', mrp: 65, dlc: 53.65 });
  const result = await context.getMasterPrice('PART1', '11688', {}, 'AUD1', { partNumber: 'PART1', mrp: 100, dlc: 80 });
  assert.equal(lookups(), 0);
  assert.deepEqual(reads, ['inventory', 'stock']);
  assert.equal(result.mrp, 65);
  assert.equal(result.dlc, 53.65);
});

test('pricing callers without a validation result still resolve current master pricing', async () => {
  const { context, lookups } = priceHarness();
  const result = await context.getMasterPrice('PART1', '11688', null, 'AUD1');
  assert.equal(lookups(), 1);
  assert.equal(result.mrp, 100);
  assert.equal(result.dlc, 80);
});

test('dealer access reuses request mappings while rejecting unauthorized dealers', async () => {
  let reads = 0;
  const context = loadFunction('routes/auth.js', 'async function validateUserDealerAccess(', 'function applyRequestDealer(', {
    normalizeAccessCode: value => value, normalizeRole: value => value,
    userDealerAccessCodes: async () => { reads++; return ['11688']; }
  });
  assert.equal((await context.validateUserDealerAccess({ role: 'audit_user' }, '11688', ['11688'])).allowed, true);
  assert.equal((await context.validateUserDealerAccess({ role: 'audit_user' }, 'OTHER', ['11688'])).allowed, false);
  assert.equal(reads, 0);
  assert.equal((await context.validateUserDealerAccess({ role: 'audit_user' }, '11688')).allowed, true);
  assert.equal(reads, 1);
});

test('authenticated manual saves do not query device identity', async () => {
  let deviceReads = 0;
  const context = loadFunction('routes/sync.js', 'async function resolveScanUserContext(', 'function normalizeScanType(', {
    clean: value => String(value || '').trim(),
    applyUserContext: (target, user) => Object.assign(target, user),
    auth: { normalizeRole: value => value },
    isManualEntry: scan => scan.source === 'manual',
    Device: { findOne: () => { deviceReads++; return { lean: async () => null }; } },
    userByContext: () => assert.fail('Authenticated identity must remain complete')
  });
  const result = await context.resolveScanUserContext({ user: { id: 'USER1', name: 'Auditor', username: 'auditor', role: 'audit_user' } }, { source: 'manual', deviceId: 'WEB1' });
  assert.equal(deviceReads, 0);
  assert.equal(result.userId, 'USER1');
  assert.equal(result.role, 'audit_user');
  await context.resolveScanUserContext({ user: { id: 'USER1', name: 'Auditor', username: 'auditor', role: 'audit_user' } }, { source: 'mobile', deviceId: 'PHONE1' });
  assert.equal(deviceReads, 1, 'mobile device enrichment must remain');
});
