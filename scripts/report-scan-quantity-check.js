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

const movementScans = [
  { _id: 'movement-in', dealerCode: 'D01', auditId: 'AUD-1', scanType: 'INWARD', partNumber: 'PART-200', qty: 5, timestamp: '2026-06-30T08:00:00Z' },
  { _id: 'movement-out', dealerCode: 'D01', auditId: 'AUD-1', scanType: 'OUTWARD', partNumber: 'PART-200', qty: 2, timestamp: '2026-06-30T08:01:00Z' },
  { _id: 'movement-fitted', dealerCode: 'D01', auditId: 'AUD-1', scanType: 'FITTED', partNumber: 'PART-200', qty: 1, fittedQty: 1, timestamp: '2026-06-30T08:02:00Z' },
  { _id: 'movement-damage', dealerCode: 'D01', auditId: 'AUD-1', scanType: 'DAMAGE', partNumber: 'PART-200', qty: 1, timestamp: '2026-06-30T08:03:00Z' }
];
const movementTotals = reportTotals(applyMovementCountRules(movementScans));
assert.equal(movementTotals.inwardQty, 5);
assert.equal(movementTotals.outwardQty, 2);
assert.equal(movementTotals.fittedQty, 1);
assert.equal(movementTotals.damageQty, 1);
assert.equal(movementTotals.netQty, 1);

const withoutInward = reportTotals(applyMovementCountRules([movementScans[1], movementScans[2]]));
assert.equal(withoutInward.outwardQty, 2, 'outward rows are reported even without a preceding inward row in the report window');
assert.equal(withoutInward.fittedQty, 1, 'fitted rows are reported even without a preceding inward row in the report window');
const legacyTypeTotals = reportTotals(applyMovementCountRules([
  { scanType: 'out', partNumber: 'PART-300', qty: 2 },
  { scanType: 'fitted_on_vehicle', partNumber: 'PART-300', qty: 1 }
]));
assert.equal(legacyTypeTotals.outwardQty, 2);
assert.equal(legacyTypeTotals.fittedQty, 1);

const exactRetryScans = [
  { ...repeatedPartScans[0], _id: 'retry-a', uniqueScanId: 'SCAN-1', scanId: 'SCAN-1' },
  { ...repeatedPartScans[0], _id: 'retry-b', uniqueScanId: 'SCAN-1', scanId: 'SCAN-1', timestamp: new Date(Date.UTC(2026, 5, 30, 9, 0)).toISOString() }
];

assert.equal(uniqueReportScans(exactRetryScans).length, 1, 'same exact scan request id should still dedupe');

const reportsRoute = fs.readFileSync(path.join(__dirname, '..', 'routes', 'reports.js'), 'utf8');
assert.match(reportsRoute, /ACTUAL STOCK VALUE \(DLC\)'?, key: 'finalInventoryValue'/, 'reports must expose the row-level DLC value');
assert.match(reportsRoute, /finalInventoryValue: money\(qty \* dlc\)/, 'bin-wise stock rows must calculate available quantity x DLC');
assert.match(reportsRoute, /row\.finalInventoryValue = money\(row\.qty \* Number\(entry\.dlc \|\| row\.dlc \|\| 0\)\)/, 'local-part additions must recalculate total quantity x DLC');

console.log('Report scan quantity regression checks passed.');
