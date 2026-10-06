const assert = require('node:assert/strict');
const test = require('node:test');
const { dashboardAggregateSummary } = require('../routes/inventory');

test('dashboard summary deduplicates scans and calculates dashboard facets in one pass', () => {
  const now = new Date('2026-10-06T12:00:00');
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(23, 0, 0, 0);
  const at = secondsAgo => new Date(now.getTime() - secondsAgo * 1000);
  const scans = [
    { _id: 'old', timestamp: yesterday, rawScan: 'yesterday', partNumber: 'P3', qty: 9, scanType: 'INWARD', binLocation: 'Z' },
    { _id: 'first-copy', timestamp: at(60), rawUpi: 'UP1', partNumber: 'P1', qty: 5, scanType: 'INWARD', binLocation: 'A', userId: 'admin' },
    { _id: 'later-copy', timestamp: at(10), rawScan: ' up1 ', partNumber: 'P1', qty: 100, scanType: 'INWARD', binLocation: 'A', userId: 'admin' },
    { _id: 'bin-b', timestamp: at(20), rawScan: 'P1-B', partNumber: 'P1', qty: 3, scanType: 'INWARD', binLocation: 'B', userId: 'staff' },
    { _id: 'p2-in', timestamp: at(300), rawScan: 'P2-IN', partNumber: 'P2', qty: 4, scanType: 'INWARD', binLocation: 'X' },
    { _id: 'p2-out', timestamp: at(290), rawScan: 'P2-OUT', partNumber: 'P2', qty: 4, scanType: 'OUTWARD', binLocation: 'Y' },
    { _id: 'manual', timestamp: at(280), rawScan: 'PM', partNumber: 'PM', qty: -2, scanType: 'INWARD', source: 'Manual' },
    { _id: 'damage', timestamp: at(270), rawScan: 'PD', partNumber: 'PD', qty: 2, scanType: 'DAMAGE' },
    { _id: 'fitted-return', timestamp: at(260), rawScan: 'PF', partNumber: 'PF', qty: 2, scanType: 'FITTED_RETURN' },
    { _id: 'outward', timestamp: at(250), rawScan: 'PO', partNumber: 'PO', qty: 2, scanType: 'OUTWARD' },
    { _id: 'latest', timestamp: at(5), rawScan: 'PLATEST', partNumber: 'PLATEST', qty: 1, scanType: 'INWARD', userId: 'admin' }
  ];

  const summary = dashboardAggregateSummary(scans, now);

  assert.equal(summary.todayCount, 9);
  assert.deepEqual(Object.fromEntries(summary.distribution), {
    INWARD: 22,
    OUTWARD: 6,
    MANUAL: 2,
    DAMAGE: 2,
    FITTED: 2
  });
  assert.equal(summary.activeUserCount, 2);
  assert.equal(summary.multipleBinPartCount, 1);
  assert.equal(summary.latestScan.part, 'PLATEST');
  assert.equal(summary.latestScan.time, scans.at(-1).timestamp);
  assert.equal(Object.hasOwn(scans[2], '__dashboardToday'), false);
});
