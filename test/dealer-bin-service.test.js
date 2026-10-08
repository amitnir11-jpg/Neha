const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureActiveDealerBin } = require('../services/DealerBinService');

function binModel(rows = []) {
  const records = new Map(rows.map(row => [`${row.dealerCode}:${row.binCode}`, { ...row }]));
  const keyFor = filter => `${filter.dealerCode}:${filter.binCode}`;
  return {
    records,
    findOne(filter) {
      return { lean: async () => records.get(keyFor(filter)) || null };
    },
    findOneAndUpdate(filter, update) {
      const key = keyFor(filter);
      const row = records.get(key);
      if (!row) return { lean: async () => null };
      Object.assign(row, update.$set);
      return { lean: async () => ({ ...row }) };
    },
    async create(row) {
      const normalized = { ...row };
      records.set(`${row.dealerCode}:${row.binCode}`, normalized);
      return normalized;
    }
  };
}

const directTransaction = work => work();

test('a typed bin is registered as active for the requested dealer', async () => {
  const Bin = binModel();
  const result = await ensureActiveDealerBin('11646', ' 2 ', { Bin, withDatabaseTransaction: directTransaction });
  assert.deepEqual(result, {
    bin: { dealerCode: '11646', binCode: '2', binName: '2', active: true },
    created: true,
    reactivated: false
  });
});

test('an explicitly selected inactive bin is reactivated for scanning', async () => {
  const Bin = binModel([{ dealerCode: '11646', binCode: '2', binName: 'Bin 2', active: false }]);
  const result = await ensureActiveDealerBin('11646', '2', { Bin, withDatabaseTransaction: directTransaction });
  assert.equal(result.bin.active, true);
  assert.equal(result.bin.binName, 'Bin 2');
  assert.equal(result.created, false);
  assert.equal(result.reactivated, true);
});

test('the same bin code remains dealer scoped', async () => {
  const Bin = binModel([{ dealerCode: 'OTHER', binCode: '2', binName: '2', active: true }]);
  const result = await ensureActiveDealerBin('11646', '2', { Bin, withDatabaseTransaction: directTransaction });
  assert.equal(result.bin.dealerCode, '11646');
  assert.equal(Bin.records.size, 2);
});
