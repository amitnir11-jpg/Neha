const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewBarcodeHistory } = require('../services/BarcodeHistoryReviewService');
const rawBarcode = 'D/GE9G0000206291/ECGSLTX9L2B2/12395AANB00S     /000005/0000010.00/AAA/1/G/000/00';

test('historical review separates quantity, price, test candidates and missing data without mutating records', () => {
  const rows = [
    { id: 'wrong', dealerCode: '12320', rawBarcode, qty: 1, mrp: 12 },
    { id: 'correct', dealerCode: '1168A', rawBarcode, qty: 5, mrp: 10 },
    { id: 'test', dealerCode: '12320', rawBarcode: rawBarcode.replace('GE9G0000206291', 'TEST001'), qty: 1 },
    { id: 'missing', qty: 1 },
    { id: 'ambiguous', rawBarcode: rawBarcode + '/UNKNOWN', qty: 1 },
    { id: 'noQuantity', rawBarcode, qty: null }
  ];
  const before = structuredClone(rows);
  const review = reviewBarcodeHistory(rows);
  assert.deepEqual(rows, before);
  assert.deepEqual(review.discrepancies.map(row => [row.id, row.difference]), [['wrong', 4], ['test', 4]]);
  assert.deepEqual(review.syntheticCandidates.map(row => row.id), ['test']);
  assert.equal(review.review.length, 3);
  assert.deepEqual(review.priceMismatches.map(row => row.id), ['wrong']);
});
