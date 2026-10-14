const assert = require('node:assert/strict');
const test = require('node:test');

const { aggregateDealerStockRows } = require('../utils/dmsStockAggregation');

test('DMS aggregation adds legacy duplicate rows instead of dropping a row by part number', () => {
  const rows = aggregateDealerStockRows([
    { _id: 'one', partNumber: ' abc-1 ', dmsStock: 3 },
    { _id: 'two', normalizedPartNumber: 'ABC-1', systemQty: 7 },
    { _id: 'three', partNumber: 'XYZ', dmsStock: 2 }
  ]);

  assert.deepEqual(rows.map((row) => ({
    partNumber: row.partNumber,
    dmsStock: row.dmsStock,
    systemQty: row.systemQty,
    sourceRowCount: row.sourceRowCount
  })), [
    { partNumber: 'ABC1', dmsStock: 10, systemQty: 10, sourceRowCount: 2 },
    { partNumber: 'XYZ', dmsStock: 2, systemQty: 2, sourceRowCount: 1 }
  ]);
});
