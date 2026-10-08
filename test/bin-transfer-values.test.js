const test = require('node:test');
const assert = require('node:assert/strict');
const { firstNonBlankValue } = require('../utils/binTransfer');

test('bin transfer identity lookup skips blank markers and uses the real part number', () => {
  assert.equal(firstNonBlankValue({ normalizedPartNumber: 'N/A', partNumber: '-', part: '20K211S' },
    ['normalizedPartNumber', 'partNumber', 'part']), '20K211S');
  assert.equal(firstNonBlankValue({ normalizedPartNumber: 'UNDEFINED', partNumber: 'NULL' },
    ['normalizedPartNumber', 'partNumber']), '');
});
