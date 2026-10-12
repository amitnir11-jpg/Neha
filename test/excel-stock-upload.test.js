const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ExcelJS = require('exceljs');

function harness() {
  const routes = new Map();
  let batch;
  let batches = [];
  let fixtureFile;
  let ledger = [];
  const clone = value => value == null ? value : structuredClone(value);
  const db = { excelStockUploadBatch: {
    findUnique: async () => clone(batch),
    findFirst: async ({ where }) => clone(batches.find(row => Object.entries(where).every(([key, value]) => row[key] === value))),
    findMany: async ({ where }) => clone(batches.filter(row => row.dealerCode === where.dealerCode)),
    create: async ({ data }) => { batch = { id: `batch-${batches.length}`, ...clone(data) }; batches.push(batch); return clone(batch); },
    update: async ({ where, data }) => { const saved = batches.find(row => row.id === where.id); Object.assign(saved, clone(data)); return clone(saved); }
  } };
  const deps = {
    express: { Router: () => Object.fromEntries(['get', 'post', 'patch'].map(method => [method, (path, ...handlers) => routes.set(`${method} ${path}`, handlers.at(-1))])) },
    multer: Object.assign(() => ({ single: () => () => {} }), { memoryStorage: () => ({}) }),
    './auth': { requireAuth() {}, requireAdmin() {}, validateUserDealerAccess: async (_user, code) => ({ allowed: code === 'D1' }) },
    '../models/Dealer': { findOne: () => ({ lean: async () => ({ dealerName: 'Dealer One' }) }) },
    '../models/MasterPart': { find: () => ({ lean: async () => [{ partNumber: 'PART1', dealerCode: 'D1', partDescription: 'Test part' }] }) },
    '../models/Bin': { findOne: () => ({ lean: async () => ({}) }), create: async () => ({}) },
    '../models/Inventory': {
      create: async row => { ledger.push({ _id: `scan-${ledger.length}`, ...clone(row) }); },
      find: () => ({ lean: async () => clone(ledger.filter(row => row.source === 'EXCEL_MANUAL')) })
    },
    '../models/ScanAuditLog': { create: async () => ({}) },
    '../utils/audit': { getActiveAudit: async () => ({ auditId: 'AUD1' }) },
    '../services/StockCalculationService': { loadPartStock: async () => {
      const bins = new Map();
      ledger.forEach(row => bins.set(row.binLocation, (bins.get(row.binLocation) || 0) + row.qty * (row.scanType === 'OUTWARD' ? -1 : 1)));
      return { binBreakdown: Array.from(bins, ([binLocation, availableQty]) => ({ binLocation, availableQty })) };
    } },
    '../services/prisma': { getPrismaClient: () => db, withDatabaseTransaction: async work => {
      const beforeBatch = clone(batch); const beforeBatches = clone(batches); const beforeLedger = clone(ledger);
      try { return await work(); } catch (error) { batches = beforeBatches; batch = batches.find(row => row.id === beforeBatch?.id); ledger = beforeLedger; throw error; }
    } },
    '../services/PartBinLocationService': { recordPartBinLocationFromScan: async () => {} },
    '../utils/safeCache': { invalidateCache() {} }
  };
  const context = { require: name => deps[name] || require(name.startsWith('../') ? `../routes/${name}` : name), module: { exports: {} }, console, Buffer };
  vm.runInNewContext(fs.readFileSync('routes/excelStockUpload.js', 'utf8'), context);
  async function call(method, path, body = {}, file) {
    let output; let error; let status = 200;
    const req = { body, query: body, file, params: { batchId: batch?.batchId }, user: { id: 'u1', username: 'Auditor' }, app: { get: () => null } };
    const res = { status(code) { status = code; return this; }, json(value) { output = clone(value); return this; } };
    await routes.get(`${method} ${path}`)(req, res, value => { error = value; });
    return { status: error?.statusCode || status, data: output, error };
  }
  async function preview() {
    if (!fixtureFile) {
      const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Stock');
      sheet.addRow(['Part Number', 'Qty', 'Bin Location']);
      sheet.addRow(['PART1', 2, 'BIN1']); sheet.addRow(['UNKNOWN', 3, 'BIN2']);
      fixtureFile = { buffer: await workbook.xlsx.writeBuffer(), originalname: 'stock.xlsx' };
    }
    return call('post', '/preview', { dealerCode: 'D1' }, fixtureFile);
  }
  return { call, preview, batch: () => clone(batch), ledger: () => clone(ledger) };
}

test('manual Excel upload previews, partially commits, corrects remaining rows, and reverses stock', async () => {
  const h = harness();
  const preview = await h.preview();
  assert.equal(preview.status, 201); assert.equal(preview.data.batch.acceptedRows, 1); assert.equal(preview.data.batch.rejectedRows, 1);
  assert.equal(h.ledger().length, 0, 'preview must never change stock');
  let rows = h.batch().rows; rows[0].checked = true;
  assert.equal((await h.call('patch', '/batches/:batchId/rows', { rows })).status, 200);
  const first = await h.call('post', '/batches/:batchId/confirm', { dealerCode: 'D1' });
  assert.equal(first.data.status, 'PARTIALLY_COMMITTED'); assert.equal(first.data.uploadedQty, 2);
  const receipt = h.batch().rows[0];
  rows = h.batch().rows; rows[1].partNumber = 'PART1'; rows[1].checked = true;
  await h.call('patch', '/batches/:batchId/rows', { rows });
  assert.equal(h.batch().rows[1].checked, false, 'correction requires fresh verification');
  assert.deepEqual(h.batch().rows[0], receipt, 'committed stock receipt remains unchanged');
  rows = h.batch().rows; rows[1].checked = true;
  await h.call('patch', '/batches/:batchId/rows', { rows });
  const second = await h.call('post', '/batches/:batchId/confirm', { dealerCode: 'D1' });
  assert.equal(second.data.status, 'COMMITTED'); assert.equal(second.data.totalUploadedQty, 5); assert.equal(h.ledger().length, 2);
  assert.equal((await h.call('post', '/batches/:batchId/confirm', { dealerCode: 'D1' })).status, 409, 'repeat commit cannot add stock');
  const reversed = await h.call('post', '/batches/:batchId/reverse', { dealerCode: 'D1' });
  assert.equal(reversed.status, 200); assert.equal(h.batch().status, 'REVERSED');
  assert.equal(h.ledger().reduce((sum, row) => sum + row.qty * (row.scanType === 'OUTWARD' ? -1 : 1), 0), 0);
  assert.equal((await h.call('post', '/batches/:batchId/reverse', { dealerCode: 'D1' })).status, 409);
});

test('row edits cannot forge upload receipts, replace original rows, or erase committed flags', async () => {
  const h = harness(); await h.preview();
  let rows = h.batch().rows; rows[0].committed = true; rows[0].checked = true; rows[0].originalPartNumber = 'FORGED';
  await h.call('patch', '/batches/:batchId/rows', { rows });
  assert.notEqual(h.batch().rows[0].committed, true); assert.equal(h.batch().rows[0].originalPartNumber, 'PART1');
  await h.call('post', '/batches/:batchId/confirm', { dealerCode: 'D1' });
  rows = h.batch().rows; rows[0].committed = false; rows[0].correctedQty = 999;
  await h.call('patch', '/batches/:batchId/rows', { rows });
  assert.equal(h.batch().rows[0].committed, true); assert.equal(h.batch().rows[0].qty, 2);
  rows = h.batch().rows; rows[0].qty = 999;
  assert.equal((await h.call('patch', '/batches/:batchId/rows', { rows })).status, 409);
  rows = h.batch().rows; rows[1].sourceRow = rows[0].sourceRow;
  assert.equal((await h.call('patch', '/batches/:batchId/rows', { rows })).status, 400);
  assert.equal((await h.call('patch', '/batches/:batchId/rows', { rows: [] })).status, 400);
  assert.equal((await h.call('post', '/batches/:batchId/confirm', { dealerCode: 'OTHER' })).status, 403);
  assert.equal(h.ledger().length, 1);
});

test('multiple upload rows for the same part and bin retain cumulative stock receipts', async () => {
  const h = harness(); await h.preview();
  let rows = h.batch().rows; rows[1].partNumber = 'PART1'; rows[1].binLocation = 'BIN1';
  await h.call('patch', '/batches/:batchId/rows', { rows });
  rows = h.batch().rows; rows.forEach(row => { row.checked = true; });
  await h.call('patch', '/batches/:batchId/rows', { rows });
  const result = await h.call('post', '/batches/:batchId/confirm', { dealerCode: 'D1' });
  assert.equal(result.status, 200);
  assert.deepEqual(h.batch().rows.map(row => [row.existingQty, row.finalQty]), [[0, 2], [2, 5]]);
  assert.equal((await h.call('post', '/batches/:batchId/reverse', { dealerCode: 'D1' })).status, 200);
});

test('a wrong unconfirmed sheet can be uploaded again, retaining both attempts in history', async () => {
  const h = harness();
  const first = await h.preview();
  const second = await h.preview();
  assert.equal(first.status, 201); assert.equal(second.status, 201);
  assert.notEqual(first.data.batch.batchId, second.data.batch.batchId);
  const history = await h.call('get', '/batches', { dealerCode: 'D1' });
  assert.equal(history.status, 200); assert.equal(history.data.batches.length, 2);
  assert.equal(history.data.batches[0].status, 'SUPERSEDED');
  assert.equal(history.data.batches[1].status, 'PENDING');
  assert.equal(history.data.batches[1].acceptedRows, 1); assert.equal(history.data.batches[1].rejectedRows, 1);
  assert.equal(h.ledger().length, 0);
  const rows = h.batch().rows;
  Object.assign(rows[1], { partNumber: 'PART1', qty: 7, binLocation: 'BIN9' });
  const edit = await h.call('patch', '/batches/:batchId/rows', { rows });
  assert.equal(edit.status, 200); assert.equal(edit.data.batch.acceptedRows, 2); assert.equal(edit.data.batch.rejectedRows, 0);
  assert.equal(edit.data.batch.rows[1].qty, 7); assert.equal(edit.data.batch.rows[1].binLocation, 'BIN9');
  assert.equal(edit.data.batch.rows[1].originalPartNumber, 'UNKNOWN');
  assert.equal((await h.call('get', '/batches', { dealerCode: 'OTHER' })).status, 403);
});

test('the same sheet cannot add stock twice, but can be re-uploaded after full reversal', async () => {
  const h = harness(); await h.preview();
  let rows = h.batch().rows; rows[0].checked = true;
  await h.call('patch', '/batches/:batchId/rows', { rows });
  await h.call('post', '/batches/:batchId/confirm', { dealerCode: 'D1' });
  assert.equal((await h.preview()).status, 409, 'partially committed sheet retains its duplicate guard');
  rows = h.batch().rows; rows[1].partNumber = 'PART1';
  await h.call('patch', '/batches/:batchId/rows', { rows });
  rows = h.batch().rows; rows[1].checked = true;
  await h.call('patch', '/batches/:batchId/rows', { rows });
  await h.call('post', '/batches/:batchId/confirm', { dealerCode: 'D1' });
  assert.equal((await h.preview()).status, 409, 'fully committed sheet retains its duplicate guard');
  await h.call('post', '/batches/:batchId/reverse', { dealerCode: 'D1' });
  assert.equal((await h.preview()).status, 201);
  const history = await h.call('get', '/batches', { dealerCode: 'D1' });
  assert.equal(history.data.batches[0].status, 'REVERSED');
  assert.equal(history.data.batches[1].status, 'PENDING');
});

test('selecting a sheet does not send it; Upload Sheet sends it once and refreshes history', async () => {
  const source = fs.readFileSync('public/ui.js', 'utf8');
  const nodes = new Map(); const requests = []; let historyRefreshes = 0;
  const $ = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { value: '', handlers: {}, addEventListener(event, handler) { this.handlers[event] = handler; } });
    return nodes.get(selector);
  };
  const context = { $, excelSelectedFile: null, excelUploadInProgress: false, excelStockApi: '/api/excel-stock-upload',
    excelSelectedDealer: () => 'D1', excelStockNotice: () => {}, renderExcelStockBatch: () => {},
    loadExcelUploadHistory: async () => { historyRefreshes++; },
    FormData: class { append() {} }, api: async (path, options) => { requests.push({ path, options }); return { batch: { batchId: 'TEST' } }; }
  };
  vm.createContext(context);
  const start = source.indexOf("$('#excelStockFile')?.addEventListener('change'");
  vm.runInContext(source.slice(start, source.indexOf("$('#excelStockRows')?.addEventListener('change'", start)), context);
  const file = { name: 'corrected.xlsx' };
  $('#excelStockFile').handlers.change({ target: { files: [file] } });
  assert.equal(requests.length, 0); assert.equal($('#excelSelectedFileName').textContent, file.name);
  assert.equal($('#excelUploadFileBtn').disabled, false);
  await $('#excelUploadFileBtn').handlers.click();
  assert.equal(requests.length, 1); assert.equal(requests[0].path, '/api/excel-stock-upload/preview');
  assert.equal(historyRefreshes, 1); assert.equal($('#excelUploadFileBtn').disabled, true);
  await $('#excelUploadFileBtn').handlers.click();
  assert.equal(requests.length, 1, 'a second click without selecting another sheet does nothing');
});

test('upload UI enables confirmation for verified remaining rows after a partial commit', () => {
  const source = fs.readFileSync('public/ui.js', 'utf8');
  const nodes = new Map();
  const $ = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { value: selector === '#excelRowsPerPage' ? '50' : '', querySelectorAll: () => [] });
    return nodes.get(selector);
  };
  const context = { $, excelStockBatch: { batchId: 'EXL1', status: 'PARTIALLY_COMMITTED', rows: [
    { partNumber: 'PART1', binLocation: 'BIN1', qty: 2, status: 'ACCEPTED', checked: true, committed: true },
    { partNumber: 'PART1', binLocation: 'BIN2', qty: 3, status: 'ACCEPTED', checked: true }
  ] }, excelStockPage: 1, excelStockVisibleRows: () => context.excelStockBatch.rows.map((row, index) => ({ row, index })), excelHtml: String };
  const start = source.indexOf('const renderExcelStockBatch =');
  vm.createContext(context);
  vm.runInContext(source.slice(start, source.indexOf('const saveExcelStockRows =', start)) + '\nrenderExcelStockBatch();', context);
  assert.equal($('#excelConfirmUpload').disabled, false);
  context.excelStockBatch.rows[1].checked = false;
  vm.runInContext('renderExcelStockBatch();', context);
  assert.equal($('#excelConfirmUpload').disabled, true, 'already uploaded rows do not enable confirmation');
  context.excelStockBatch.status = 'REVERSED';
  vm.runInContext('renderExcelStockBatch();', context);
  assert.equal($('#excelSelectPage').disabled, true);
  const html = fs.readFileSync('public/Daksh.html', 'utf8');
  assert.equal((html.match(/id="excelStockRows"/g) || []).length, 1);
  assert.equal((html.match(/id="excelRejectedCount"/g) || []).length, 1);
  assert.match($('#excelStockRows').innerHTML, /excel-badge accepted/);
  assert.equal($('#excelReviewStatus').textContent, 'Reversed');
});
