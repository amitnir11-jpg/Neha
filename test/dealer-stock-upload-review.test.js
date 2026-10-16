const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
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

test('an unresolved question-mark part is rejected even if a legacy lookup could return pricing', async () => {
  const result = await rowsToStockRecords([headings, row('1168A', 'VD?53172ACP320S', '2')], '1168A', 'AUDIT-1', 'Tester');
  assert.equal(result.reviewRows[0].status, 'REJECTED');
  assert.match(result.reviewRows[0].reason, /unresolved \? character/);
  assert.equal(result.records.length, 0);
});

test('more than 10,000 rows remain reviewable without truncating exceptions', async () => {
  const rows = [headings, ...Array.from({ length: 10001 }, (_, index) => row('1168A', `UNKNOWN${index}`, '1'))];
  const result = await rowsToStockRecords(rows, '1168A', 'AUDIT-1', 'Tester');
  assert.equal(result.reviewRows.length, 10001);
  assert.equal(result.reviewRows.at(-1).rowNumber, 10002);
  assert.equal(result.records.length, 0);
});

test('HTTP review uploads only selected valid rows, then accepts a corrected dealer row', async t => {
  const User = require('../models/User');
  const Mapping = require('../models/UserDealerMapping');
  const Dealer = require('../models/Dealer');
  const Audit = require('../models/Audit');
  const DealerStock = require('../models/DealerStock');
  const ScanAuditLog = require('../models/ScanAuditLog');
  const { prisma } = require('../services/prisma');
  const originals = [];
  const replace = (model, method, implementation) => { originals.push([model, method, model[method]]); model[method] = implementation; };
  t.after(() => originals.forEach(([model, method, original]) => { model[method] = original; }));
  const query = value => ({ lean: async () => value, sort() { return this; }, select() { return this; } });
  replace(User, 'findOne', () => query({ _id: 'admin', username: 'admin', role: 'admin', approved: true, isActive: true }));
  replace(Mapping, 'find', () => query([]));
  replace(Dealer, 'findOne', filter => query({ _id: filter.dealerCode, dealerCode: filter.dealerCode, active: true }));
  replace(Audit, 'findOne', () => query({ dealerCode: '1168A', auditId: 'AUDIT-1', status: 'ACTIVE' }));
  const saved = [];
  replace(prisma, '$transaction', async work => work(prisma));
  replace(DealerStock, 'find', filter => query(saved.filter(item => item.dealerCode === filter.dealerCode && item.auditId === filter.auditId && (!filter.normalizedPartNumber || filter.normalizedPartNumber.$in.includes(item.normalizedPartNumber)))));
  replace(DealerStock, 'bulkUpsertBy', async rows => { saved.push(...rows); return { insertedCount: rows.length }; });
  replace(ScanAuditLog, 'create', async () => ({}));
  const app = express();
  app.use('/api/reconciliation', reconciliation);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const token = jwt.sign({ id: 'admin' }, process.env.JWT_SECRET || 'daksh_inventory_secret');
  const send = async (confirmed, csv, selectedRows = '[2]', corrections = '{}') => {
    const body = new FormData();
    body.set('dealerCode', '1168A');
    if (confirmed) { body.set('confirmed', 'true'); body.set('selectedRows', selectedRows); }
    body.set('corrections', corrections);
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
  assert.equal(saved.length, 0);
  const mixed = await send(true, `${header}\n1168A,0001,,2,A-01,,\n12320,0002,,3,B-01,,`, '[3]');
  assert.equal(mixed.status, 409);
  assert.match((await mixed.json()).message, /does not match selected dealer/);
  assert.equal(saved.length, 0);
  const csv = `${header}\n1168A,0001,,2,A-01,,\n12320,0002,,3,B-01,,`;
  const valid = await send(true, csv);
  assert.equal(valid.status, 200, JSON.stringify(await valid.clone().json()));
  assert.deepEqual(saved.map(item => item.partNumber), ['0001']);
  const corrected = await send(true, csv, '[3]', '{"3":{"dealerCode":"1168A"}}');
  assert.equal(corrected.status, 200, JSON.stringify(await corrected.clone().json()));
  assert.equal((await corrected.json()).summary.systemStockValue, 50);
  assert.deepEqual(saved.map(item => [item.dealerCode, item.partNumber]), [['1168A', '0001'], ['1168A', '0002']]);
});

test('browser review retains only exceptions after upload and selects revalidated corrections', async () => {
  const source = fs.readFileSync('public/ui.js', 'utf8');
  const nodes = new Map();
  const file = { name: 'dealer.csv' };
  const form = { dataset: {}, querySelector: () => ({ disabled: false }) };
  const $ = (selector) => {
    if (selector === '#dealerStockUploadForm') return form;
    if (selector === '[name="dealerCode"]') return { value: '1168A' };
    if (selector === '[name="file"]') return { files: [file] };
    if (!nodes.has(selector)) nodes.set(selector, { value: selector === '#stockReviewFilter' ? 'ALL' : '', hidden: false });
    return nodes.get(selector);
  };
  const responses = [
    { reviewRows: [{ rowNumber: 2, partNumber: '0001', dmsStock: 2, dlc: 10, mrp: 20, status: 'VALID' },
      { rowNumber: 3, dealerCode: '12320', partNumber: 'UNKNOWN', dmsStock: 3, status: 'REJECTED', reason: 'Dealer code does not match selected dealer' }] },
    { reviewRows: [{ rowNumber: 2, partNumber: '0001', dmsStock: 2, dlc: 10, mrp: 20, status: 'VALID' },
      { rowNumber: 3, dealerCode: '1168A', partNumber: '0002', dmsStock: 3, dlc: 10, mrp: 20, status: 'VALID' }] }
  ];
  const sent = [];
  const context = { $, state: {}, window: { crypto: { randomUUID: () => 'review-id' } },
    FormData: class { constructor() { this.fields = {}; } set(key, value) { this.fields[key] = value; } },
    api: async (_path, options) => { sent.push(options.body.fields); const response = responses.shift(); if (response instanceof Error) throw response; return response; },
    cleanDealerCode: value => String(value || '').toUpperCase(), activeReconDealer: () => '1168A',
    clean: value => String(value || ''), wholeNumber: String, money2: value => Number(value || 0).toFixed(2),
    escapeHtml: value => String(value || ''), enhanceDataTable: () => {},
    setText: (id, value) => { $(`#${id}`).textContent = value; }
  };
  vm.createContext(context);
  const renderStart = source.indexOf('  function renderDealerStockReview()');
  vm.runInContext(source.slice(renderStart, source.indexOf('  function isReconciliationDealerSelect', renderStart)), context);
  const uploadStart = source.indexOf('  async function uploadDealerStock(');
  vm.runInContext(source.slice(uploadStart, source.indexOf('  function syncReconDealer(', uploadStart)), context);
  await context.uploadDealerStock(form);
  assert.match($('#stockReviewRows').innerHTML, /UNKNOWN/);
  assert.match($('#stockReviewRows').innerHTML, /data-stock-edit="3"/);
  assert.match($('#stockReviewRows').innerHTML, /data-stock-select="3" aria-label="Select Excel row 3 for correction"/);
  const selectionHandlers = {};
  $('#stockReviewRows').addEventListener = (name, handler) => { selectionHandlers[name] = handler; };
  const changeStart = source.indexOf("    $('#stockReviewRows')?.addEventListener('change'");
  vm.runInContext(source.slice(changeStart, source.indexOf('    let stockSuggestionTimer;', changeStart)), context);
  selectionHandlers.change({ target: { dataset: { stockSelect: '3' }, checked: true } });
  assert.equal(context.state.dealerStockReview.selectedExceptions.has(3), true);
  assert.equal($('#stockReviewSelectedCount').textContent, '2');
  assert.equal($('#stockReviewSelectAll').checked, true);
  const selectAllHandlers = {};
  $('#stockReviewSelectAll').addEventListener = (name, handler) => { selectAllHandlers[name] = handler; };
  const selectAllStart = source.indexOf("    $('#stockReviewSelectAll')?.addEventListener('change'");
  vm.runInContext(source.slice(selectAllStart, source.indexOf("    $('#stockReviewFilter')?.addEventListener", selectAllStart)), context);
  selectAllHandlers.change({ target: { checked: false } });
  assert.equal(context.state.dealerStockReview.selectedExceptions.size, 0);
  assert.equal(context.state.dealerStockReview.excluded.has(2), true);
  selectAllHandlers.change({ target: { checked: true } });
  assert.equal(context.state.dealerStockReview.selectedExceptions.has(3), true);
  assert.equal(context.state.dealerStockReview.excluded.has(2), false);
  context.state.dealerStockReview.committed.add(2);
  context.renderDealerStockReview();
  assert.doesNotMatch($('#stockReviewRows').innerHTML, /0001/);
  assert.match($('#stockReviewRows').innerHTML, /UNKNOWN/);
  context.state.dealerStockReview.corrections[3] = { dealerCode: '1168A', partNumber: '0002' };
  context.state.dealerStockReview.excluded.add(3);
  context.state.dealerStockReview.rows[1].status = 'PENDING';
  await context.uploadDealerStock(form);
  assert.equal(context.state.dealerStockReview.excluded.has(3), false);
  assert.equal(context.state.dealerStockReview.selectedExceptions.has(3), false);
  assert.equal(context.state.dealerStockReview.committed.has(2), true);
  assert.match($('#stockReviewRows').innerHTML, /0002/);
  assert.doesNotMatch($('#stockReviewRows').innerHTML, /0001/);
  assert.equal(JSON.parse(sent[1].corrections)['3'].dealerCode, '1168A');
  const rowNode = $('#stockReviewRows');
  const handlers = {};
  rowNode.addEventListener = (name, handler) => { handlers[name] = handler; };
  const partInput = { value: '0002', dataset: { stockRow: '3', stockField: 'partNumber' },
    dispatchEvent() { handlers.change({ target: this }); } };
  rowNode.querySelectorAll = () => [partInput];
  context.window.prompt = () => '0003';
  context.Event = class { constructor(type) { this.type = type; } };
  const editStart = source.indexOf("    $('#stockReviewRows')?.addEventListener('click'");
  vm.runInContext(source.slice(editStart, source.indexOf('    let stockSuggestionTimer;', editStart)), context);
  handlers.click({ target: { closest: () => ({ dataset: { stockEdit: '3' } }) } });
  assert.equal(context.state.dealerStockReview.corrections[3].partNumber, '0003');
  assert.equal(context.state.dealerStockReview.rows[1].status, 'PENDING');

  // Exercise the toolbar through validation and the existing dealer-stock save handler.
  const notices = [];
  context.toast = message => notices.push(message);
  context.renderDealerStockPreview = () => {};
  context.renderDealerStockErrors = () => {};
  context.loadReconciliation = async () => {};
  const workflowStart = source.indexOf('    const validateAndTransferDealerStock = async');
  vm.runInContext(source.slice(workflowStart, source.indexOf("    $('#dealerStockUploadForm')?.addEventListener('submit'", workflowStart)), context);
  const confirmStart = source.indexOf('    const confirmDealerStockReview = async');
  vm.runInContext(source.slice(confirmStart, source.indexOf("    $('#stockReviewConfirm')?.addEventListener", confirmStart)), context);
  const toolbarHandlers = {};
  $('#stockReviewRevalidate').addEventListener = (name, handler) => { toolbarHandlers[name] = handler; };
  const toolbarStart = source.indexOf("    $('#stockReviewRevalidate')?.addEventListener");
  vm.runInContext(source.slice(toolbarStart, source.indexOf("    $('#stockReviewUseDealer')", toolbarStart)), context);
  const validatedRows = [
    { rowNumber: 2, partNumber: '0001', status: 'VALID', dmsStock: 2 },
    { rowNumber: 3, partNumber: '0003', status: 'VALID', dmsStock: 3, dlc: 10, mrp: 20 },
    { rowNumber: 4, partNumber: 'UNKNOWN4', status: 'WRONG_PART', dmsStock: 1 }
  ];
  responses.push({ reviewRows: validatedRows }, { summary: {}, message: 'Transferred' });
  const beforeTransfer = sent.length;
  const transfer = toolbarHandlers.click();
  assert.equal($('#stockReviewRevalidate').disabled, true);
  await toolbarHandlers.click();
  await transfer;
  assert.equal(sent.length, beforeTransfer + 2);
  assert.equal(sent.at(-1).confirmed, 'true');
  assert.deepEqual(JSON.parse(sent.at(-1).selectedRows), [3]);
  assert.equal(JSON.parse(sent.at(-1).corrections)['3'].partNumber, '0003');
  assert.equal(context.state.dealerStockReview.committed.has(2), true);
  assert.equal(context.state.dealerStockReview.committed.has(3), true);
  assert.equal(context.state.dealerStockReview.committed.has(4), false);
  assert.doesNotMatch($('#stockReviewRows').innerHTML, /0003/);
  assert.match($('#stockReviewRows').innerHTML, /UNKNOWN4/);
  assert.equal($('#dealerStockUploadMessage').textContent, 'Transferred');
  assert.equal($('#stockReviewRevalidate').disabled, false);
  responses.push({ reviewRows: validatedRows });
  await toolbarHandlers.click();
  assert.equal(sent.length, beforeTransfer + 3, 'unresolved errors alone do not trigger another save');
  assert.equal(notices.length, 0);
  handlers.change({ target: { dataset: { stockRow: '4', stockField: 'partNumber' }, value: '0004' } });
  const finalRows = validatedRows.map(row => row.rowNumber === 4 ? { ...row, partNumber: '0004', status: 'VALID', dlc: 10, mrp: 20 } : row);
  responses.push({ reviewRows: finalRows }, new Error('Save failed'));
  await toolbarHandlers.click();
  assert.equal(context.state.dealerStockReview.committed.has(4), false);
  assert.equal($('#stockReviewRevalidate').disabled, false);
  assert.equal($('#stockReviewConfirm').disabled, false);
  assert.deepEqual(notices, ['Save failed']);
  responses.push({ reviewRows: finalRows }, { summary: {}, message: 'Final correction transferred' });
  await toolbarHandlers.click();
  assert.deepEqual(JSON.parse(sent.at(-1).selectedRows), [4]);
  assert.equal(context.state.dealerStockReview.committed.has(4), true);
  assert.equal($('#stockReviewRevalidate').disabled, true);
  assert.match($('#stockReviewRows').innerHTML, /No rows remain/);
  assert.match(fs.readFileSync('public/Daksh.html', 'utf8'), /id="stockReviewRevalidate"[^>]*>Validate and Transfer</);
});
