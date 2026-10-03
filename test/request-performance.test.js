const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

test('service worker leaves API and non-static requests untouched', () => {
  const listeners = {};
  const context = {
    URL, self: { location: { origin: 'https://example.test' },
      addEventListener: (name, handler) => { listeners[name] = handler; } },
    fetch: () => { throw new Error('Unexpected network interception'); }
  };
  vm.runInNewContext(fs.readFileSync('public/sw.js', 'utf8'), context);
  for (const path of ['/api/health', '/api/devices', '/api/scans/history?part=ABC', '/health', '/config.js']) {
    listeners.fetch({ request: { method: 'GET', url: `https://example.test${path}` },
      respondWith: () => assert.fail(`Intercepted ${path}`) });
  }
});

function apiHarness(fetch) {
  const source = fs.readFileSync('public/ui.js', 'utf8');
  const start = source.indexOf('  const pendingStatusRequests = new Map();');
  const end = source.indexOf('  function sanitizeDownloadFileName', start);
  let timer;
  const context = {
    state: { token: 'user-a' }, Map, FormData, AbortController, fetch,
    apiUrl: (path) => path, withActiveDealerQuery: (path) => `${path}${path.includes('?') ? '&' : '?'}activeDealerId=11688`,
    withActiveDealerBody: (body) => body,
    parseApiResponse: (response) => response.json(), apiErrorMessage: (data) => data.message,
    logout: () => {}, setTimeout: (callback) => { timer = callback; return 1; }, clearTimeout: () => {}
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return { context, expire: () => timer() };
}

test('overlapping status reads share a request and clear after completion', async () => {
  let finish;
  let calls = 0;
  const { context } = apiHarness(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const first = context.api('/api/health');
  const second = context.api('/api/health');
  assert.equal(first, second);
  assert.equal(calls, 1);
  finish({ ok: true, json: async () => ({ success: true }) });
  await first;
  const third = context.api('/api/health');
  assert.equal(calls, 2);
  finish({ ok: true, json: async () => ({ success: true }) });
  await third;
});

test('status timeout covers a stalled response body and allows retry', async () => {
  const { context, expire } = apiHarness(async (_path, options) => ({
    ok: true, json: () => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })
  }));
  const request = context.api('/api/devices');
  await new Promise(setImmediate);
  expire();
  await assert.rejects(request, /Server response delayed/);
  const retry = context.api('/api/devices');
  assert.notEqual(request, retry);
  await new Promise(setImmediate);
  expire();
  await assert.rejects(retry, /Server response delayed/);
});

test('health responds without accessing database models', () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const start = source.indexOf("app.get('/api/health',");
  const end = source.indexOf("app.get('/api/ping',", start);
  let handler;
  const context = { app: { get: (_path, fn) => { handler = fn; } }, PORT: 3300,
    serverInfo: () => ({}), applicationReady: () => true,
    currentDatabaseStatus: () => 'connected', currentDatabasePayload: () => ({}),
    runtimePayload: () => ({}), currentStoragePayload: () => ({}), RELEASE_BUILD: {},
    DEPLOYMENT_NAME: 'test', IS_RENDER: false, IS_RAILWAY: false };
  vm.runInNewContext(source.slice(start, end), context);
  let result;
  handler({ app: { locals: {} }, socket: {}, get: () => '' }, {
    setHeader: () => {}, status: (code) => { assert.equal(code, 200); return { json: (value) => { result = value; } }; }
  });
  assert.equal(result.server, 'online');
  assert.equal(result.db, 'connected');
});

test('device summary reuses list rows without repeating expiry or online query', async () => {
  let reads = 0;
  const Device = {
    find: () => { reads++; return { lean: async () => [] }; },
    countDocuments: async () => 150
  };
  const context = { module: { exports: {} }, require: (name) => name === '../models/Device' ? Device : {} };
  vm.runInNewContext(fs.readFileSync('services/ScannerManager.js', 'utf8'), context);
  const manager = new context.module.exports();
  manager.markExpiredOffline = () => assert.fail('Repeated expiry write');
  const result = await manager.summary({ online: [{ deviceType: 'mobile', pendingCount: 3, connectionMethod: 'wifi' }] });
  assert.equal(reads, 1, 'only the low-battery lookup should remain');
  assert.equal(result.connectedDevices, 1);
  assert.equal(result.activeScannerCount, 1);
  assert.equal(result.pendingSyncCount, 3);
  assert.equal(result.offlineDevices, 150, 'offline count must not use the capped list');
});
