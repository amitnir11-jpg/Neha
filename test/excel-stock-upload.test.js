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
  let deletionBlocked = false;
  let auditBlocked = false;
  let audits = [];
  const clone = value => value == null ? value : structuredClone(value);
  const db = { excelStockUploadBatch: {
    findUnique: async () => clone(batch),
    findFirst: async ({ where }) => clone(batches.find(row => Object.entries(where).every(([key, value]) => row[key] === value))),
    findMany: async ({ where }) => clone(batches.filter(row => row.dealerCode === where.dealerCode && row.status !== where.status?.not)),
    create: async ({ data }) => { batch = { id: `batch-${batches.length}`, ...clone(data) }; batches.push(batch); return clone(batch); },
    update: async ({ where, data }) => { const saved = batches.find(row => row.id === where.id); Object.assign(saved, clone(data)); return clone(saved); }
  } };
  const deps = {
    express: { Router: () => Object.fromEntries(['get', 'post', 'patch', 'delete'].map(method => [method, (path, ...handlers) => routes.set(`${method} ${path}`, handlers.at(-1))])) },
    multer: Object.assign(() => ({ single: () => () => {} }), { memoryStorage: () => ({}) }),
    './auth': { requireAuth() {}, requireAdmin() {}, validateUserDealerAccess: async (_user, code) => ({ allowed: code === 'D1' }) },
    '../models/Dealer': { findOne: () => ({ lean: async () => ({ dealerName: 'Dealer One' }) }) },
    '../utils/partMasterPrice': { getPricesFromPartMaster: async (parts, dealerCode) => new Map(parts.filter(part => part === 'PART1' && dealerCode === 'D1').map(part => [part, { masterRecord: { partNumber: part, dealerCode, partDescription: 'Catalogue test part', source: 'MASTER_CATALOGUE' } }])) },
    '../models/Bin': { findOne: () => ({ lean: async () => ({}) }), create: async () => ({}) },
    '../models/Inventory': {
      create: async row => { ledger.push({ _id: `scan-${ledger.length}`, ...clone(row) }); },
      find: () => ({ lean: async () => clone(ledger.filter(row => row.source === 'EXCEL_MANUAL' && !row.isDeleted)) })
    },
    '../models/ScanAuditLog': { create: async audit => { if (auditBlocked) throw new Error('Audit storage failed'); audits.push(clone(audit)); return {}; } },
    '../utils/audit': { getActiveAudit: async () => ({ auditId: 'AUD1' }) },
    '../services/StockCalculationService': { loadPartStock: async () => {
      const bins = new Map();
      ledger.filter(row => !row.isDeleted).forEach(row => bins.set(row.binLocation, (bins.get(row.binLocation) || 0) + row.qty * (row.scanType === 'OUTWARD' ? -1 : 1)));
      return { binBreakdown: Array.from(bins, ([binLocation, availableQty]) => ({ binLocation, availableQty })) };
    } },
    '../services/prisma': { getPrismaClient: () => db, withDatabaseTransaction: async work => {
      const beforeBatch = clone(batch); const beforeBatches = clone(batches); const beforeLedger = clone(ledger); const beforeAudits = clone(audits);
      try { return await work(); } catch (error) { batches = beforeBatches; batch = batches.find(row => row.id === beforeBatch?.id); ledger = beforeLedger; audits = beforeAudits; throw error; }
    } },
    '../services/PartBinLocationService': { recordPartBinLocationFromScan: async () => {} },
    '../services/ScanModificationService': { softDeleteScans: async filter => {
      if (deletionBlocked) throw Object.assign(new Error('Dependent stock activity exists'), { status: 409 });
      const rows = ledger.filter(scan => (Array.isArray(filter._id?.$in) ? filter._id.$in.includes(scan._id) : scan._id === filter._id) && !scan.isDeleted);
      rows.forEach(row => { row.isDeleted = true; }); return { deletedCount: rows.length };
    } },
    '../utils/safeCache': { invalidateCache() {} }
  };
  const context = { require: name => deps[name] || require(name.startsWith('../') ? `../routes/${name}` : name), module: { exports: {} }, console, Buffer };
  vm.runInNewContext(fs.readFileSync('routes/excelStockUpload.js', 'utf8'), context);
  async function call(method, path, body = {}, file) {
    let output; let error; let status = 200;
    const req = { body, query: body, file, params: { batchId: batch?.batchId, sourceRow: body.sourceRow }, user: { id: 'u1', username: 'Auditor' }, app: { get: () => null } };
    const res = { status(code) { status = code; return this; }, json(value) { output = clone(value); return this; } };
    await routes.get(`${method} ${path}`)(req, res, value => { error = value; });
    return { status: error?.statusCode || error?.status || (error ? 500 : status), data: output, error };
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
  return { call, preview, batch: () => clone(batch), ledger: () => clone(ledger), audits: () => clone(audits), blockDeletion: () => { deletionBlocked = true; }, blockAudit: () => { auditBlocked = true; } };
}

test('deleting a pending upload removes it from compact history and keeps an audit receipt', async () => {
  const h = harness(); await h.preview();
  const deleted = await h.call('delete', '/batches/:batchId');
  assert.equal(deleted.status, 200); assert.equal(h.batch().status, 'DELETED');
  assert.equal(h.batch().rows.length, 2); assert.equal(h.audits()[0].action, 'DELETE');
  assert.equal((await h.call('get', '/batches', { dealerCode: 'D1' })).data.batches.length, 0);
  assert.equal((await h.call('delete', '/batches/:batchId')).status, 409);
  assert.equal((await h.preview()).status, 201);
});

test('deleting a partially committed upload removes its stock once and excludes it from history', async () => {
  const h = harness(); await h.preview(); const rows = h.batch().rows; rows[0].checked = true;
  await h.call('patch', '/batches/:batchId/rows', { rows });
  await h.call('post', '/batches/:batchId/confirm', { dealerCode: 'D1' });
  assert.equal((await h.call('delete', '/batches/:batchId')).status, 200);
  assert.equal(h.ledger()[0].isDeleted, true);
  assert.equal((await h.call('get', '/batches', { dealerCode: 'D1' })).data.batches.length, 0);
});

test('batch deletion rolls back all stock and history changes when audit storage fails', async () => {
  const h = harness(); await h.preview(); const rows = h.batch().rows; rows[0].checked = true;
  await h.call('patch', '/batches/:batchId/rows', { rows });
  await h.call('post', '/batches/:batchId/confirm', { dealerCode: 'D1' });
  const before = h.batch(); h.blockAudit();
  assert.equal((await h.call('delete', '/batches/:batchId')).status, 500);
  assert.deepEqual(h.batch(), before); assert.notEqual(h.ledger()[0].isDeleted, true);
});

test('deleting a reversed upload archives history without deleting its original stock twice', async () => {
  const h = harness(); await h.preview(); let rows = h.batch().rows; rows[1].partNumber = 'PART1';
  await h.call('patch', '/batches/:batchId/rows', { rows }); rows = h.batch().rows; rows.forEach(row => { row.checked = true; });
  await h.call('patch', '/batches/:batchId/rows', { rows });
  await h.call('post', '/batches/:batchId/confirm', { dealerCode: 'D1' });
  await h.call('post', '/batches/:batchId/reverse', { dealerCode: 'D1' });
  const before = h.ledger();
  assert.equal((await h.call('delete', '/batches/:batchId')).status, 200);
  assert.deepEqual(h.ledger(), before); assert.equal(h.batch().status, 'DELETED');
});

test('dependent stock prevents whole-batch deletion without changing any receipt', async () => {
  const h = harness(); await h.preview(); const rows = h.batch().rows; rows[0].checked = true;
  await h.call('patch', '/batches/:batchId/rows', { rows });
  await h.call('post', '/batches/:batchId/confirm', { dealerCode: 'D1' });
  const before = h.batch(); h.blockDeletion();
  assert.equal((await h.call('delete', '/batches/:batchId')).status, 409);
  assert.deepEqual(h.batch(), before); assert.notEqual(h.ledger()[0].isDeleted, true);
});

test('compact history summarizes pending parts without transferring full row data', async () => {
  const h = harness(); await h.preview();
  const batch = (await h.call('get', '/batches', { dealerCode: 'D1' })).data.batches[0];
  assert.equal(batch.acceptedRows, 1); assert.equal(batch.rejectedRows, 1); assert.equal(batch.uploadedQty, 0);
  assert.equal(batch.rows, undefined);
});

test('delete removes pending rows and uploaded stock while preserving receipts', async () => {
  const h = harness(); await h.preview();
  const removed = await h.call('delete', '/batches/:batchId/rows/:sourceRow', { sourceRow: 3 });
  assert.equal(removed.status, 200); assert.equal(h.batch().rows[1].deleted, true); assert.equal(h.batch().rejectedRows, 0);
  let rows = h.batch().rows; rows[1].deleted = false; rows[1].status = 'ACCEPTED'; rows[0].checked = true;
  await h.call('patch', '/batches/:batchId/rows', { rows });
  assert.equal(h.batch().rows[1].deleted, true, 'a row patch cannot resurrect a deleted receipt');
  const committed = await h.call('post', '/batches/:batchId/confirm', { dealerCode: 'D1' });
  assert.equal(committed.data.status, 'COMMITTED'); assert.equal(h.ledger().length, 1);
  assert.equal((await h.call('delete', '/batches/:batchId/rows/:sourceRow', { sourceRow: 2 })).status, 200);
  assert.equal(h.batch().status, 'CANCELLED'); assert.equal(h.batch().uploadedQty, 0); assert.equal(h.ledger()[0].isDeleted, true);
  assert.equal((await h.call('delete', '/batches/:batchId/rows/:sourceRow', { sourceRow: 2 })).status, 409);
  assert.equal((await h.preview()).status, 201, 'fully removed stock does not block a fresh sheet');
});

test('uploaded-row deletion rolls back when dependent stock exists', async () => {
  const h = harness(); await h.preview(); const rows = h.batch().rows; rows[0].checked = true;
  await h.call('patch', '/batches/:batchId/rows', { rows });
  await h.call('post', '/batches/:batchId/confirm', { dealerCode: 'D1' });
  const before = h.batch(); h.blockDeletion();
  assert.equal((await h.call('delete', '/batches/:batchId/rows/:sourceRow', { sourceRow: 2 })).status, 409);
  assert.deepEqual(h.batch(), before); assert.notEqual(h.ledger()[0].isDeleted, true);
});

test('batch reversal excludes a previously deleted uploaded row', async () => {
  const h = harness(); await h.preview(); let rows = h.batch().rows;
  rows[1].partNumber = 'PART1'; rows[1].binLocation = 'BIN1';
  await h.call('patch', '/batches/:batchId/rows', { rows }); rows = h.batch().rows; rows.forEach(row => { row.checked = true; });
  await h.call('patch', '/batches/:batchId/rows', { rows });
  await h.call('post', '/batches/:batchId/confirm', { dealerCode: 'D1' });
  assert.equal((await h.call('delete', '/batches/:batchId/rows/:sourceRow', { sourceRow: 2 })).status, 200);
  assert.equal(h.batch().uploadedQty, 3);
  const reversal = await h.call('post', '/batches/:batchId/reverse', { dealerCode: 'D1' });
  assert.equal(reversal.status, 200);
  assert.equal(h.ledger().filter(row => !row.isDeleted).reduce((sum, row) => sum + row.qty * (row.scanType === 'OUTWARD' ? -1 : 1), 0), 0);
});

test('manual Excel upload previews, partially commits, corrects remaining rows, and reverses stock', async () => {
  const h = harness();
  const preview = await h.preview();
  assert.equal(preview.status, 201); assert.equal(preview.data.batch.acceptedRows, 1); assert.equal(preview.data.batch.rejectedRows, 1);
  assert.equal(preview.data.batch.rows[0].partDescription, 'Catalogue test part', 'upload accepts the shared catalogue lookup result');
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
