const assert = require('assert');
const duplicatePolicy = require('../utils/scanDuplicatePolicy');

const base = {
  dealerCode: 'D01',
  scanType: 'INWARD',
  partNumber: '33402KCC710S',
  binLocation: 'A23',
  auditId: 'AUD-1'
};

const sameBinDifferentAudit = {
  ...base,
  auditId: 'AUD-2'
};

const differentBin = {
  ...base,
  binLocation: 'A24'
};

const differentType = {
  ...base,
  scanType: 'DAMAGE'
};

assert.strictEqual(
  duplicatePolicy.businessDuplicateKey(base),
  'D01::INWARD::33402KCC710S::A23'
);
assert.strictEqual(
  duplicatePolicy.businessDuplicateKey(sameBinDifferentAudit),
  duplicatePolicy.businessDuplicateKey(base)
);
assert.notStrictEqual(
  duplicatePolicy.businessDuplicateKey(differentBin),
  duplicatePolicy.businessDuplicateKey(base)
);

const filter = duplicatePolicy.partBinDuplicateFilter(base);
assert(filter, 'part/bin duplicate filter should be built');
assert.strictEqual(filter.dealerCode, 'D01');
assert(Array.isArray(filter.$and), 'part/bin duplicate filter should include AND clauses');
assert(filter.$and.some((group) => group.$or.some((term) => term.scanType === 'INWARD' || term.type === 'INWARD')));
assert(filter.$and.some((group) => group.$or.some((term) => term.normalizedPartNumber === '33402KCC710S' || term.partNumber === '33402KCC710S' || term.part === '33402KCC710S')));
assert(filter.$and.some((group) => group.$or.some((term) => term.binLocation === 'A23' || term.bin === 'A23')));

const otherFilter = duplicatePolicy.partBinDuplicateFilter(differentBin);
assert(otherFilter.$and.some((group) => group.$or.some((term) => term.binLocation === 'A24' || term.bin === 'A24')));

assert.strictEqual(duplicatePolicy.sameBinLocation(base, sameBinDifferentAudit), true);
assert.strictEqual(duplicatePolicy.sameBinLocation(base, differentBin), false);
assert.strictEqual(duplicatePolicy.businessDuplicateFilter(differentType).$and.some((group) => group.$or.some((term) => term.scanType === 'DAMAGE' || term.type === 'DAMAGE')), true);

console.log('Part/bin duplicate policy checks passed.');
