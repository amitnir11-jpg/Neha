const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const prices = require('../utils/partMasterPrice');

const originalLookup = prices.getPricesFromPartMaster;
prices.getPricesFromPartMaster = async (parts) => new Map(parts.filter(part => !part.startsWith('UNKNOWN')).map(part => [part, {
  masterFound: true, description: `MASTER ${part}`, dlc: part === 'NODLC' ? 0 : 10, mrp: 20
}]));
const reconciliation = require('../routes/reconciliation');
const { rowsToStockRecords } = reconciliation;
prices.getPricesFromPartMaster = originalLookup;

const headings = ['Dealer Code', 'Part Number', 'Part Description', 'Dms Stock', 'Bin Loc 1', 'Bin Loc 2', 'Bin Loc 3'];
const row = (dealer, part, qty, bin = '') => [dealer, part, 'Spreadsheet description', qty, bin, '', ''];

test('DMS review preserves row numbers, leading zeros, invalid rows and authoritative prices', async () => {
  const result = await rowsToStockRecords([headings,
    row('1168A', '0001', '2', 'A-01'), row('1168A', 'UNKNOWN', '3'), row('1168A', 'NO-DLC', '4'),
    row('1168A', '0001', '2', 'A-01'), row('12320', '0003', '5'), row('1168A', '0004', '-1')
  ], '1168A', 'AUDIT-1', 'Tester');
  assert.deepEqual(result.reviewRows.map(item => item.status), ['VALID', 'WRONG_PART', 'MISSING_PRICE', 'DUPLICATE', 'REJECTED', 'REJECTED']);
  assert.deepEqual(result.reviewRows.map(item => item.rowNumber), [2, 3, 4, 5, 6, 7]);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].partNumber, '0001');
  assert.equal(result.records[0].partDescription, 'MASTER 0001');
  assert.equal(result.records[0].stockValue, 20);
  assert.equal(result.records[0].binLoc1, 'A-01');
});

test('only selected valid source rows contribute to the confirmed DMS update', async () => {
  const rows = [headings, row('1168A', '0001', '2'), row('1168A', '0001', '3'), row('1168A', 'UNKNOWN', '4')];
  const preview = await rowsToStockRecords(rows, '1168A', 'AUDIT-1', 'Tester');
  assert.equal(preview.records[0].dmsStock, 5);
  const selected = await rowsToStockRecords(rows, '1168A', 'AUDIT-1', 'Tester', () => {}, new Set([3]));
  assert.deepEqual(selected.reviewRows.map(item => item.status), ['EXCLUDED', 'VALID', 'EXCLUDED']);
  assert.equal(selected.records.length, 1);
  assert.equal(selected.records[0].dmsStock, 3);
});

test('required dealer heading and whole nonnegative DMS quantities are enforced', async () => {
  const missingHeading = await rowsToStockRecords([['Part Number', 'Dms Stock'], ['0001', 2]], '1168A', 'AUDIT-1', 'Tester');
  assert.match(missingHeading.errorRows[0].message, /Dealer Code/);
  const invalidQuantity = await rowsToStockRecords([headings, row('1168A', '0001', '2.5'), row('1168A', '0002', '')], '1168A', 'AUDIT-1', 'Tester');
  assert.deepEqual(invalidQuantity.reviewRows.map(item => item.status), ['REJECTED', 'REJECTED']);
  assert.equal(invalidQuantity.records.length, 0);
});

test('more than 10,000 rows remain reviewable without truncating exceptions', async () => {
  const rows = [headings, ...Array.from({ length: 10001 }, (_, index) => row('1168A', `UNKNOWN${index}`, '1'))];
  const result = await rowsToStockRecords(rows, '1168A', 'AUDIT-1', 'Tester');
  assert.equal(result.reviewRows.length, 10001);
  assert.equal(result.reviewRows.at(-1).rowNumber, 10002);
  assert.equal(result.records.length, 0);
});

test('HTTP preview never saves and confirmed mixed-dealer file is rejected', async t => {
  const User = require('../models/User');
  const Mapping = require('../models/UserDealerMapping');
  const Dealer = require('../models/Dealer');
  const Audit = require('../models/Audit');
  const DealerStock = require('../models/DealerStock');
  const originals = [];
  const replace = (model, method, implementation) => { originals.push([model, method, model[method]]); model[method] = implementation; };
  t.after(() => originals.forEach(([model, method, original]) => { model[method] = original; }));
  const query = value => ({ lean: async () => value, sort() { return this; }, select() { return this; } });
  replace(User, 'findOne', () => query({ _id: 'admin', username: 'admin', role: 'admin', approved: true, isActive: true }));
  replace(Mapping, 'find', () => query([]));
  replace(Dealer, 'findOne', filter => query({ _id: filter.dealerCode, dealerCode: filter.dealerCode, active: true }));
  replace(Audit, 'findOne', () => query({ dealerCode: '1168A', auditId: 'AUDIT-1', status: 'ACTIVE' }));
  let writes = 0;
  replace(DealerStock, 'bulkUpsertBy', async () => { writes += 1; return { insertedCount: 1 }; });
  const app = express();
  app.use('/api/reconciliation', reconciliation);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const token = jwt.sign({ id: 'admin' }, process.env.JWT_SECRET || 'daksh_inventory_secret');
  const send = async (confirmed, csv) => {
    const body = new FormData();
    body.set('dealerCode', '1168A');
    if (confirmed) { body.set('confirmed', 'true'); body.set('selectedRows', '[2]'); }
    body.set('file', new Blob([csv], { type: 'text/csv' }), 'dealer.csv');
    return fetch(`http://127.0.0.1:${server.address().port}/api/reconciliation/upload-stock?dealerCode=1168A`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body
    });
  };
  const header = headings.join(',');
  const preview = await send(false, `${header}\n1168A,0001,,2,A-01,,\n1168A,UNKNOWN,,3,B-01,,`);
  const result = await preview.json();
  assert.equal(preview.status, 200, JSON.stringify(result));
  assert.equal(result.reviewSummary.validRows, 1);
  assert.equal(result.reviewSummary.wrongParts, 1);
  assert.equal(writes, 0);
  const mixed = await send(true, `${header}\n1168A,0001,,2,A-01,,\n12320,0002,,3,B-01,,`);
  assert.equal(mixed.status, 400);
  assert.match((await mixed.json()).message, /Dealer code mismatch/);
  assert.equal(writes, 0);
});
