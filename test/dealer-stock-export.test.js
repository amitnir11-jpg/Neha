const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
const User = require('../models/User');
const Mapping = require('../models/UserDealerMapping');
const Dealer = require('../models/Dealer');
const DealerStock = require('../models/DealerStock');
const Audit = require('../models/Audit');

test('uploaded stock export is complete, preserves upload values and isolates dealer/audit', async t => {
  const originals = [];
  const replace = (model, method, implementation) => {
    originals.push([model, method, model[method]]);
    model[method] = implementation;
  };
  t.after(() => originals.forEach(([model, method, original]) => { model[method] = original; }));
  const query = value => ({ lean: async () => value, sort() { return this; }, select() { return this; } });
  replace(User, 'findOne', filter => query({ _id: filter._id, username: filter._id, role: filter._id === 'admin' ? 'admin' : 'audit_user', dealerAccess: ['D-A'], approved: true, isActive: true }));
  replace(Mapping, 'find', () => query([{ dealerId: 'D-A' }]));
  replace(Dealer, 'findOne', filter => query({ _id: filter.dealerCode, dealerCode: filter.dealerCode, active: true, currentAuditId: 'CURRENT' }));
  replace(Audit, 'findOne', () => query({ auditId: 'CURRENT', dealerCode: 'D-A', status: 'ACTIVE' }));
  const rows = Array.from({ length: 2594 }, (_, index) => ({
    dealerCode: 'D-A', auditId: 'CURRENT', partNumber: `00${index}`, partDescription: 'Uploaded description',
    dmsStock: index === 0 ? 0 : 1.5, binLoc1: 'A1', mrp: 42, dlp: 31
  }));
  rows.push({ dealerCode: 'D-B', auditId: 'CURRENT', partNumber: 'OTHER-DEALER', dmsStock: 999 });
  rows.push({ dealerCode: 'D-A', auditId: 'OLD', partNumber: 'OLD-AUDIT', dmsStock: 888 });
  let reads = 0;
  replace(DealerStock, 'find', filter => {
    reads++;
    assert.ok(['D-A', 'D-B'].includes(filter.dealerCode));
    assert.ok(filter.auditId);
    return query(rows.filter(row => row.dealerCode === filter.dealerCode && row.auditId === filter.auditId));
  });
  const app = express();
  app.use('/api/reconciliation', require('../routes/reconciliation'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const request = (suffix, authenticated = true, user = 'admin') => fetch(`http://127.0.0.1:${server.address().port}/api/reconciliation/stock-export${suffix}`, {
    headers: authenticated ? { Authorization: `Bearer ${jwt.sign({ id: user }, process.env.JWT_SECRET || 'daksh_inventory_secret')}` } : {}
  });
  assert.equal((await request('?dealerCode=D-A&auditId=CURRENT', false)).status, 401);
  assert.equal((await request('?dealerCode=D-B&auditId=CURRENT', true, 'reader')).status, 403);
  assert.equal((await request('?dealerCode=D-A&auditId=CURRENT', true, 'reader')).status, 403, 'existing reconciliation role restrictions apply');
  assert.equal(reads, 0, 'unauthorized downloads never query stock');
  const response = await request('?dealerCode=D-A&auditId=CURRENT&limit=1');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-disposition'), /D-A_CURRENT.xlsx/);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
  const sheet = workbook.getWorksheet('Uploaded Dealer Stock');
  assert.equal(sheet.rowCount, 2595, 'all 2594 stock rows exported regardless of preview limit');
  assert.equal(sheet.getCell('B2').value, '000');
  assert.equal(sheet.getCell('B2').numFmt, '@');
  assert.equal(sheet.getCell('C2').value, 'Uploaded description');
  assert.equal(sheet.getCell('D2').value, 0);
  assert.equal(sheet.getCell('D3').value, 1.5);
  assert.equal(sheet.getCell('E2').value, 'A1');
  const mrpColumn = sheet.getRow(1).values.indexOf('MRP');
  assert.equal(sheet.getRow(2).getCell(mrpColumn).value, 42);
  const summary = workbook.getWorksheet('Verification Summary');
  assert.equal(summary.getCell('B2').value, 'CURRENT');
  assert.equal(summary.getCell('B3').value, 2594);
  assert.equal(summary.getCell('B4').value, 2593 * 1.5);
  const empty = await request('?dealerCode=D-A&auditId=EMPTY');
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).message, /Active Audit ID/);
  assert.equal((await request('?dealerCode=D-A')).status, 200, 'UI download resolves the active audit');
  assert.equal((await request('?dealerCode=ALL')).status, 400);
  const otherDealer = await request('?dealerCode=D-B&auditId=CURRENT');
  assert.equal(otherDealer.status, 200);
  assert.equal(otherDealer.headers.get('x-dealer-code'), 'D-B');
  const otherWorkbook = new ExcelJS.Workbook();
  await otherWorkbook.xlsx.load(Buffer.from(await otherDealer.arrayBuffer()));
  const otherSheet = otherWorkbook.getWorksheet('Uploaded Dealer Stock');
  assert.equal(otherSheet.rowCount, 2);
  assert.equal(otherSheet.getCell('A2').value, 'D-B');
  assert.equal(otherSheet.getCell('B2').value, 'OTHER-DEALER');
  assert.equal(otherSheet.getCell('D2').value, 999);
});
