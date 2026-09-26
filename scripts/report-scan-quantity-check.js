const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { uniqueReportScans } = require('../utils/reportScanIdentity');
const { applyMovementCountRules, reportTotals } = require('../utils/reportTotals');

const repeatedPartScans = Array.from({ length: 5 }, (_, index) => ({
  _id: `row-${index + 1}`,
  dealerCode: 'D01',
  auditId: 'AUD-1',
  scanType: 'INWARD',
  partNumber: 'PART-100',
  rawScan: 'PART-100',
  qty: 1,
  timestamp: new Date(Date.UTC(2026, 5, 30, 8, index)).toISOString()
}));

const uniqueRepeatedPartScans = uniqueReportScans(repeatedPartScans);
assert.equal(uniqueRepeatedPartScans.length, 5, 'same part barcode scans must count as separate saved rows');

const countedRepeatedPartScans = applyMovementCountRules(uniqueRepeatedPartScans);
const totals = reportTotals(countedRepeatedPartScans);
assert.equal(totals.scanRows, 5);
assert.equal(totals.totalQuantity, 5);
assert.equal(totals.uniqueParts, 1);

const exactRetryScans = [
  { ...repeatedPartScans[0], _id: 'retry-a', uniqueScanId: 'SCAN-1', scanId: 'SCAN-1' },
  { ...repeatedPartScans[0], _id: 'retry-b', uniqueScanId: 'SCAN-1', scanId: 'SCAN-1', timestamp: new Date(Date.UTC(2026, 5, 30, 9, 0)).toISOString() }
];

assert.equal(uniqueReportScans(exactRetryScans).length, 1, 'same exact scan request id should still dedupe');

const reportsRoute = fs.readFileSync(path.join(__dirname, '..', 'routes', 'reports.js'), 'utf8');
assert.match(reportsRoute, /ACTUAL STOCK VALUE \(DLC\)'?, key: 'finalInventoryValue'/, 'reports must expose the row-level DLC value');
assert.match(reportsRoute, /target\.finalInventoryValue = money\(target\.qty \* Number\(target\.dlc \|\| 0\)\)/, 'bin-wise rows must calculate qty x DLC');

console.log('Report scan quantity regression checks passed.');
