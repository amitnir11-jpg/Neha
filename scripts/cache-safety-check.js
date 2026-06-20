const assert = require('assert');
const {
  clearCache,
  getCachedResponse,
  invalidateCache
} = require('../utils/safeCache');

async function main() {
  clearCache();

  let reportBuilds = 0;
  const reportQuery = { dealerCode: '24780', auditId: 'A-1', reportType: 'stock-summary', format: 'excel' };
  const reportScope = { dealerCode: '24780', auditId: 'A-1' };

  const firstReport = await getCachedResponse('report-download', reportQuery, async (normalizedQuery) => {
    reportBuilds += 1;
    return Buffer.from(`report:${normalizedQuery.dealerCode}:${normalizedQuery.auditId}:${reportBuilds}`);
  }, { scope: reportScope });
  const secondReport = await getCachedResponse('report-download', reportQuery, async () => {
    reportBuilds += 1;
    return Buffer.from('should-not-run');
  }, { scope: reportScope });

  assert.strictEqual(reportBuilds, 1, 'report download should reuse cache');
  assert.strictEqual(firstReport.cacheHit, false);
  assert.strictEqual(secondReport.cacheHit, true);
  assert.strictEqual(secondReport.data.toString(), firstReport.data.toString());

  invalidateCache({ tags: ['scan', 'report', 'dashboard'], scope: reportScope });
  const thirdReport = await getCachedResponse('report-download', reportQuery, async () => {
    reportBuilds += 1;
    return Buffer.from(`report-after-scan:${reportBuilds}`);
  }, { scope: reportScope });
  assert.strictEqual(reportBuilds, 2, 'scan invalidation should rebuild report download');
  assert.strictEqual(thirdReport.cacheHit, false);

  let searchBuilds = 0;
  const searchQuery = { q: 'ABC123', dealerCode: '24780', limit: 10 };
  const searchScope = { dealerCode: '24780' };
  const searchFirst = await getCachedResponse('search', searchQuery, async (normalizedQuery) => {
    searchBuilds += 1;
    return { parts: [{ partNumber: normalizedQuery.q, build: searchBuilds }] };
  }, { scope: searchScope });
  const searchSecond = await getCachedResponse('search', searchQuery, async () => {
    searchBuilds += 1;
    return { parts: [{ partNumber: 'BROKEN' }] };
  }, { scope: searchScope });
  assert.strictEqual(searchBuilds, 1, 'repeated part search should reuse cache');
  assert.strictEqual(searchSecond.data.parts[0].partNumber, searchFirst.data.parts[0].partNumber);

  const otherDealerSearch = await getCachedResponse('search', { ...searchQuery, dealerCode: '24781' }, async () => {
    searchBuilds += 1;
    return { parts: [{ partNumber: 'OTHER-DEALER' }] };
  }, { scope: { dealerCode: '24781' } });
  assert.strictEqual(searchBuilds, 2, 'different dealer should have separate search cache');
  assert.strictEqual(otherDealerSearch.cacheHit, false);

  invalidateCache({ tags: ['catalogue', 'master', 'search', 'dashboard', 'report'], scope: searchScope });
  const searchAfterCatalogue = await getCachedResponse('search', searchQuery, async () => {
    searchBuilds += 1;
    return { parts: [{ partNumber: 'AFTER-CATALOGUE' }] };
  }, { scope: searchScope });
  assert.strictEqual(searchBuilds, 3, 'catalogue invalidation should rebuild search cache');
  assert.strictEqual(searchAfterCatalogue.cacheHit, false);

  invalidateCache({ tags: ['price', 'master', 'report', 'dashboard'], scope: searchScope });

  let ttlBuilds = 0;
  let now = Date.now();
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const ttlQuery = { q: 'TTL', dealerCode: '24780' };
    const ttlScope = { dealerCode: '24780' };
    await getCachedResponse('search', ttlQuery, async () => {
      ttlBuilds += 1;
      return { ok: ttlBuilds };
    }, { scope: ttlScope, ttlMs: 5000 });
    now += 6001;
    await getCachedResponse('search', ttlQuery, async () => {
      ttlBuilds += 1;
      return { ok: ttlBuilds };
    }, { scope: ttlScope, ttlMs: 5000 });
    assert.strictEqual(ttlBuilds, 2, 'expired cache entry should be rebuilt');
  } finally {
    Date.now = originalNow;
  }

  console.log('cache-safety-check: ok');
}

main().catch((error) => {
  console.error('cache-safety-check failed:', error);
  process.exitCode = 1;
});
