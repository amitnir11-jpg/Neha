const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync('public/ui.js', 'utf8');
function downloadHarness(fetch) {
  const timers = new Map();
  const downloads = [];
  const context = {
    state: { token: 'test' }, AbortController, fetch,
    apiUrl: path => path, withActiveDealerQuery: path => path,
    withActiveDealerBody: body => body,
    parseApiResponse: response => response.json(), apiErrorMessage: data => data.message,
    resolveDownloadFileName: () => 'AUDIT_PACK_11688.xlsx',
    triggerDownload: (blob, name) => downloads.push({ blob, name }),
    setTimeout: callback => { const timer = {}; timers.set(timer, callback); return timer; },
    clearTimeout: timer => timers.delete(timer)
  };
  vm.createContext(context);
  const start = source.indexOf('  async function downloadPost(');
  vm.runInContext(source.slice(start, source.indexOf('  function triggerDownload', start)), context);
  return { context, timers, downloads };
}

test('complete audit download times out while reading a stalled workbook body', async () => {
  const { context, timers, downloads } = downloadHarness(async (_path, options) => ({
    ok: true, blob: () => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    })
  }));
  const request = context.downloadPost('/api/reports/download-complete-audit-pack', { dealerCode: '11688' }, undefined, { signal: new AbortController().signal, timeoutMs: 120000 });
  const rejected = assert.rejects(request, /Report download timed out/);
  await new Promise(setImmediate);
  assert.equal(timers.size, 1, 'workbook download needs a deadline');
  for (const callback of [...timers.values()]) callback();
  await rejected;
  assert.equal(downloads.length, 0);
  assert.equal(timers.size, 0);
});

test('cancelled audit download does not start a file download', async () => {
  const { context, timers, downloads } = downloadHarness((_path, options) => new Promise((_resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    if (options.signal.aborted) abort();
    else options.signal.addEventListener('abort', abort, { once: true });
  }));
  const controller = new AbortController();
  const request = context.downloadPost('/api/reports/download-complete-audit-pack', {}, undefined, { signal: controller.signal, timeoutMs: 120000 });
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  assert.equal(timers.size, 0);
  assert.equal(downloads.length, 0);
});

test('successful download preserves request scope and starts the returned workbook download', async () => {
  const workbook = new Blob(['workbook-fixture']);
  let sent;
  const { context, timers, downloads } = downloadHarness(async (path, options) => {
    sent = { path, options }; return { ok: true, blob: async () => workbook };
  });
  const filename = await context.downloadPost('/api/reports/download-complete-audit-pack', { dealerCode: '11688', auditId: 'AUD1' }, undefined, { timeoutMs: 120000 });
  assert.equal(filename, 'AUDIT_PACK_11688.xlsx');
  assert.equal(sent.options.headers.Authorization, 'Bearer test');
  assert.deepEqual(JSON.parse(sent.options.body), { dealerCode: '11688', auditId: 'AUD1' });
  assert.equal(downloads[0].blob, workbook);
  assert.equal(timers.size, 0);
});

test('audit pack displays the actual server error and releases progress state', async () => {
  const progress = [];
  const messages = [];
  let downloadOptions;
  const context = {
    state: { auditPackRequestId: 0, auditPackProgress: {} }, AbortController,
    collectAuditPackPayload: () => ({ dealerCode: '11688' }),
    closeAuditPackModal() {}, openAuditPackProgress() {}, updateReportButtons() {},
    setInterval: () => 1, setTimeout: () => 1, clearAuditPackTimers() {},
    setAuditPackProgress: value => progress.push(value), toast: message => messages.push(message),
    downloadPost: async (_path, _body, _name, options) => {
      downloadOptions = options; throw new Error('The application database is temporarily unavailable.');
    }
  };
  vm.createContext(context);
  const start = source.indexOf('  async function generateAuditPack()');
  vm.runInContext(source.slice(start, source.indexOf('  function hasReportCriteria', start)), context);
  await context.generateAuditPack();
  assert.equal(downloadOptions.timeoutMs, 120000);
  assert.match(progress.at(-1).message, /database is temporarily unavailable/);
  assert.match(messages.at(-1), /database is temporarily unavailable/);
  assert.equal(context.state.auditPackInProgress, false);
  assert.equal(context.state.auditPackAbortController, null);
});
