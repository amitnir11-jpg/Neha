const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const { getCachedReport, clearReportCache } = require('../utils/reportCache');

test('preview, Excel and PDF share report calculations for the same filters', async () => {
  clearReportCache();
  const source = fs.readFileSync('routes/report.js', 'utf8');
  const start = source.indexOf('async function cachedReport(namespace, query, builder)');
  const context = { getCachedReport };
  vm.createContext(context);
  vm.runInContext(source.slice(start, source.indexOf('async function sendCachedDownload', start)), context);
  let builds = 0;
  const builder = async query => {
    builds++;
    assert.equal(query.dealerCode, '11688');
    assert.equal(query.auditId, 'AUD1');
    return { rows: [{ partNumber: 'PART1', qty: 2 }] };
  };
  const scope = { dealerCode: '11688', auditId: 'AUD1' };
  const results = await Promise.all([
    context.cachedReport('partwise-inventory-audit', { ...scope, page: '1', limit: '100' }, builder),
    context.cachedReport('partwise-inventory-audit', { ...scope, format: 'excel', columns: 'partNumber,qty' }, builder),
    context.cachedReport('partwise-inventory-audit', { ...scope, format: 'pdf' }, builder)
  ]);
  assert.equal(builds, 1, 'presentation options must not rebuild the same report');
  for (const result of results) assert.equal(result.rows.length, 1);
  await context.cachedReport('partwise-inventory-audit', { ...scope, auditId: 'AUD2' }, async query => {
    builds++; assert.equal(query.auditId, 'AUD2'); return { rows: [] };
  });
  assert.equal(builds, 2, 'different audits must keep independent caches');
  clearReportCache();
});
