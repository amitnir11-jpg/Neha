const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('node:fs');
const vm = require('node:vm');
const User = require('../models/User');
const Mapping = require('../models/UserDealerMapping');
const Dealer = require('../models/Dealer');
const Inventory = require('../models/Inventory');
const Bin = require('../models/Bin');
const Device = require('../models/Device');
const SyncLog = require('../models/SyncLog');
const Audit = require('../models/Audit');
const cleanup = require('../services/PermanentDealerCleanupService');
const auth = require('../routes/auth');
const { matchesFilter } = require('../models/prismaModel');

test('authenticated APIs isolate pending scans, mobile totals and bin modifications', async t => {
  const originals = [];
  const replace = (model, method, implementation) => {
    originals.push([model, method, model[method]]);
    model[method] = implementation;
  };
  t.after(() => originals.forEach(([model, method, original]) => { model[method] = original; }));
  const rows = ['D-A', 'D-B'].map(dealerCode => ({ _id: dealerCode, dealerCode, partNumber: 'SAME-PART', binCode: 'SAME-BIN', syncStatus: 'pending', isSynced: false }));
  const query = value => ({ lean: async () => value, sort() { return this; }, limit() { return this; }, select() { return this; } });
  replace(User, 'findOne', filter => query({ _id: filter._id, username: filter._id, role: filter._id === 'super' ? 'super_admin' : filter._id === 'admin' ? 'admin' : 'mobile_user', dealerAccess: ['D-A'], approved: true, isActive: true }));
  replace(Mapping, 'find', () => query([{ dealerId: 'D-A' }]));
  replace(Dealer, 'findOne', filter => query(['D-A', 'D-B'].includes(filter.dealerCode) ? { _id: `primary-${filter.dealerCode}`, dealerCode: filter.dealerCode, active: true } : null));
  replace(Inventory, 'find', filter => query(rows.filter(row => matchesFilter(row, filter))));
  replace(Inventory, 'countDocuments', async filter => rows.filter(row => matchesFilter(row, filter)).length);
  replace(Device, 'findOne', filter => query(rows.find(row => matchesFilter(row, filter)) || null));
  replace(SyncLog, 'findOne', filter => query(rows.find(row => matchesFilter(row, filter)) || null));
  replace(Audit, 'findOne', filter => {
    assert.equal(filter.dealerCode, 'D-A', 'audit lookup must retain selected dealer');
    return Object.assign(Promise.resolve(null), query(null));
  });
  let writes = 0;
  replace(Bin, 'findOne', filter => {
    const row = rows.find(row => matchesFilter(row, filter)) || null;
    return Object.assign(Promise.resolve(row), query(row));
  });
  replace(Bin, 'deleteOne', async filter => { assert.equal(filter.dealerCode, 'D-A'); writes++; return { deletedCount: 1 }; });
  replace(Bin, 'findOneAndUpdate', async filter => { assert.equal(filter.dealerCode, 'D-A'); writes++; return rows[0]; });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.io = { emit() {} }; next(); });
  app.use('/api/sync', require('../routes/sync'));
  app.use('/api/mobile', require('../routes/mobile'));
  app.use('/api/bin-master', require('../routes/binMaster'));
  app.use('/api/audit', require('../routes/audit'));
  app.use('/api/admin-delete', require('../routes/adminDelete'));
  const cleanupTargets = [];
  replace(cleanup, 'previewDealer', async dealerId => {
    cleanupTargets.push(dealerId);
    return { dealer: { id: dealerId, dealerCode: 'D-B' }, counts: {} };
  });
  const reports = express.Router();
  reports.post('/probe', auth.requireAuth, (req, res) => res.json({ dealer: req.authorizedDealer, filters: req.body.filters }));
  app.use('/api/reports', reports);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const request = (path, user = 'admin', method = 'GET', body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, headers: { Authorization: `Bearer ${jwt.sign({ id: user }, process.env.JWT_SECRET || 'daksh_inventory_secret')}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  for (const suffix of ['', '?dealerCode=ALL', '?dealerCode=UNKNOWN']) {
    assert.equal((await request(`/api/sync/pending${suffix}`)).status, 400);
  }
  assert.equal((await request('/api/sync/pending?dealerCode=D-B', 'mobile')).status, 403);
  for (const dealer of ['D-A', 'D-B']) {
    const response = await request(`/api/sync/pending?dealerCode=${dealer}`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).records.map(row => row.dealerCode), [dealer]);
  }
  const implicit = await request('/api/sync/pending', 'mobile');
  assert.deepEqual((await implicit.json()).records.map(row => row.dealerCode), ['D-A']);
  const concurrent = await Promise.all(Array.from({ length: 20 }, (_, i) => request(`/api/sync/pending?dealerCode=${i % 2 ? 'D-A' : 'D-B'}`).then(res => res.json())));
  concurrent.forEach((data, i) => assert.equal(data.records[0].dealerCode, i % 2 ? 'D-A' : 'D-B'));
  const mobileStatus = await request('/api/mobile/sync-status?dealerCode=D-A');
  assert.equal((await mobileStatus.json()).lastApiResponse.dealerCode, 'D-A');
  for (const method of ['PUT', 'DELETE']) {
    assert.equal((await request('/api/bin-master/D-B?dealerCode=D-A', 'admin', method, method === 'PUT' ? { binCode: 'NEW-BIN' } : undefined)).status, 404);
  }
  assert.equal(writes, 0, 'another dealer bin was never changed');
  for (const suffix of ['close', 'status/complete', 'status/reopen', 'status']) {
    const response = await request(`/api/audit/OTHER-DEALER-AUDIT/${suffix}?dealerCode=D-A`, 'admin', 'POST', { status: 'ACTIVE', remark: 'test' });
    assert.equal(response.status, 404);
  }
  const mixed = await request('/api/reports/probe?dealerCode=D-A', 'admin', 'POST', { filters: { dealerCode: 'D-B' } });
  assert.equal(mixed.status, 400);
  const scoped = await request('/api/reports/probe?dealerCode=D-A', 'admin', 'POST', { filters: {} });
  const data = await scoped.json();
  assert.equal(data.dealer.id, 'primary-D-A');
  assert.equal(data.filters.dealerCode, 'D-A');
  const targetId = '77c08150-e409-4017-a772-7e3c0740f260';
  // The cleanup target is an immutable ID, distinct from the header dealer.
  const preview = await request('/api/admin-delete/permanent-cleanup/preview?dealerCode=D-A', 'super', 'POST', { dealerId: targetId });
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).dealer.id, targetId);
  for (const role of ['admin', 'mobile']) {
    const denied = await request('/api/admin-delete/permanent-cleanup/preview', role, 'POST', { dealerId: targetId });
    assert.equal(denied.status, 403);
  }
  assert.deepEqual(cleanupTargets, [targetId], 'only a Super Admin reaches the cleanup preview');
});

test('late frontend responses are rejected after A to B to A switching', async () => {
  const source = fs.readFileSync('public/ui.js', 'utf8');
  const start = source.indexOf('  async function apiRequest(');
  const end = source.indexOf('  function sanitizeDownloadFileName', start);
  let resolve;
  const context = {
    state: { token: 'admin' }, dealerContextVersion: 0,
    activeDealerId: () => 'D-A', shouldAttachDealerScope: () => true,
    apiUrl: path => path, withActiveDealerQuery: path => path, withActiveDealerBody: body => body,
    FormData, AbortController, setTimeout, clearTimeout,
    fetch: () => new Promise(done => { resolve = done; }),
    parseApiResponse: response => response.json(), apiErrorMessage: data => data.message
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const request = context.apiRequest('/api/scans/history?dealerCode=D-A');
  context.dealerContextVersion = 2;
  resolve({ ok: true, json: async () => ({ records: [{ dealerCode: 'D-A' }] }) });
  await assert.rejects(request, error => error.code === 'STALE_DEALER_RESPONSE' && error.status === 409);
});

test('queued request bodies keep their original dealer after the selection changes', () => {
  const source = fs.readFileSync('public/ui.js', 'utf8');
  const start = source.indexOf('  function shouldAttachDealerScope(');
  const end = source.indexOf('  let dealerContextVersion', start);
  const context = {
    state: { token: 'admin' }, activeDealerId: () => 'D-B',
    window: { location: { origin: 'http://localhost' } }, URL, FormData,
    cleanDealerCode: value => String(value || '').toUpperCase()
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const body = context.withActiveDealerBody({ dealerCode: 'D-A', scans: [{ dealerCode: 'D-A' }] });
  const path = context.withActiveDealerQuery('/api/sync/push', body);
  assert.equal(body.dealerCode, 'D-A');
  assert.equal(body.activeDealerId, 'D-A');
  assert.equal(new URL(path, 'http://localhost').searchParams.get('dealerCode'), 'D-A');
  assert.equal(context.withActiveDealerBody({ qty: 1 }).dealerCode, 'D-B');
  const cleanupPath = '/api/admin-delete/permanent-cleanup/preview';
  const cleanupBody = { dealerId: 'immutable-primary-key' };
  assert.equal(context.withActiveDealerQuery(cleanupPath, cleanupBody), cleanupPath);
  assert.equal(context.withActiveDealerBody(cleanupBody, cleanupPath), cleanupBody);
  assert.equal(Object.hasOwn(cleanupBody, 'dealerCode'), false);
  assert.equal(context.shouldAttachDealerScope('/api/admin-delete/permanent-cleanup/execute'), false);
});

test('scanner registration and heartbeat resolve only their original dealer audit', async () => {
  const failure = new Error('stop after audit lookup');
  const lookups = [];
  const context = { module: { exports: {} }, require: name => name === '../models/Device'
    ? { findOne: () => ({ lean: async () => ({ dealerCode: 'D-A' }) }) }
    : name === 'crypto' ? require('crypto') : {} };
  vm.runInNewContext(fs.readFileSync('services/ScannerManager.js', 'utf8'), context);
  const manager = new context.module.exports({ activeAuditProvider: async scope => {
    lookups.push(scope.dealerCode);
    throw failure;
  } });
  await assert.rejects(manager.register({ dealerCode: 'D-A' }), error => error === failure);
  await assert.rejects(manager.heartbeat({ deviceId: 'device-a' }), error => error === failure);
  assert.deepEqual(lookups, ['D-A', 'D-A']);
});

test('dealer-list audit actions retain the dealer selected in their own row', async () => {
  const source = fs.readFileSync('public/ui.js', 'utf8');
  const start = source.indexOf('  async function handleAuditComplete(');
  const end = source.indexOf('  async function loadBins()', start);
  const requests = [];
  const dealerLoads = [];
  const context = {
    window: { prompt: () => 'completed after verification', confirm: () => true },
    alert() {}, toast() {},
    api: async (path, options) => {
      requests.push({ path, body: options.body });
      return { success: true, activeAudit: null };
    },
    loadActiveAudit: async () => null,
    loadDealers: async options => { dealerLoads.push(options || {}); },
    loadDashboard: async () => null,
    $: () => null,
    encodeURIComponent
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  await context.handleAuditComplete('AUD-B', 'D-B');
  await context.handleAuditReopen('AUD-B', 'D-B');
  await context.handleAuditLock('AUD-B', 'D-B');
  assert.equal(requests.length, 3);
  requests.forEach(({ path, body }) => {
    assert.match(path, /AUD-B/);
    assert.equal(body.dealerCode, 'D-B');
  });
  assert.equal(dealerLoads[0].force, true, 'completion refreshes Dealer Master without using its cached status');
});
