const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');

function modelHarness(values) {
  const filename = path.resolve('models/prismaModel.js');
  const localRequire = createRequire(filename);
  const records = values.map((partNumber, index) => ({ id: String(index), data: { partNumber } }));
  const context = { module: { exports: {} }, process, console, Buffer, RegExp,
    require: name => name === '../services/prisma' ? {
      Prisma: require('@prisma/client').Prisma,
      getPrismaClient: () => ({ $queryRaw: async () => records })
    } : localRequire(name)
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context);
  return context.module.exports.createModel({ name: 'MasterPart', delegate: 'masterPart', tableName: 'master_parts' });
}

test('bulk part lookup avoids rescanning the membership list for each returned row', async () => {
  const parts = Array.from({ length: 800 }, (_, index) => `PART${String(index).padStart(6, '0')}`);
  let listScans = 0;
  parts.some = function (...args) { listScans++; return Array.prototype.some.apply(this, args); };
  const Model = modelHarness(parts);
  const rows = await Model.find({ partNumber: { $in: parts } }).lean();
  assert.equal(rows.length, parts.length);
  assert.ok(listScans < 10, `expected one query-level list check, received ${listScans}`);
});

test('optimized membership preserves collation, numeric strings, null and regex behavior', async () => {
  const cases = [
    { values: ['PART1', 'part1', 'PART2'], items: ['PART1'], expected: ['PART1', 'part1'] },
    { values: ['café', 'CAFE', 'other'], items: ['café'], expected: ['café', 'CAFE'] },
    { values: ['PART01', 'PART1', 'PART2'], items: ['PART1'], expected: ['PART01', 'PART1'] },
    { values: ['2026-10-04', '2026-10-04T00:00:00Z', 'PART1'], items: ['2026-10-04'], expected: ['2026-10-04', '2026-10-04T00:00:00Z'] },
    { values: ['PART1', 'PART2', null], items: [/^PART/, null], expected: ['PART1', 'PART2', null] }
  ];
  for (const fixture of cases) {
    const Model = modelHarness(fixture.values);
    for (const operator of ['$in', '$nin']) {
      const rows = await Model.find({ partNumber: { [operator]: fixture.items } }).lean();
      const expected = operator === '$in' ? fixture.expected : fixture.values.filter(value => !fixture.expected.includes(value));
      assert.deepEqual(Array.from(rows, row => row.partNumber), expected);
    }
  }
});
