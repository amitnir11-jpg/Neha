const assert = require('node:assert/strict');
const test = require('node:test');
const { legacyPartLookup } = require('../utils/partMasterPrice');

test('legacy Part Master lookup accepts spacing and hyphen formatting variants', () => {
  const query = legacyPartLookup('44831KVH900S');
  const fields = ['normalizedPartNumber', 'partNumber', 'partNo', 'part'];

  for (const field of fields) {
    const matcher = query.$or.find((condition) => condition[field])[field];
    assert.equal(matcher.test('44831KVH900S'), true);
    assert.equal(matcher.test('44831 KVH 900S'), true);
    assert.equal(matcher.test('44831-KVH-900S'), true);
    assert.equal(matcher.test('44831KVH901S'), false);
  }
});
