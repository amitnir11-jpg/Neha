const assert = require('node:assert/strict');
const test = require('node:test');
const { scanQuantityBridge } = require('../routes/inventory');

test('scan quantity bridge keeps an unclassified residual visible', () => {
  const bridge = scanQuantityBridge(19297, 6777 + 12347 + 1 + 10);
  assert.deepEqual(bridge, {
    reportedQuantity: 19297,
    classifiedQuantity: 19135,
    unclassifiedQuantity: 162,
    overclassifiedQuantity: 0,
    difference: 162,
    reconciled: false,
    message: 'Some reported scan quantity is not represented by the displayed movement types. Review the transaction-level reconciliation before sign-off.'
  });
});
