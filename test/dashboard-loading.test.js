const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

function dashboardHarness(stalledPath) {
  const source = fs.readFileSync('public/ui.js', 'utf8');
  const timers = new Map();
  const rendered = [];
  const bins = [];
  const requests = [];
  let nextTimer = 0;
  const context = {
    state: { token: 'test-user' }, Map, FormData, AbortController, console,
    apiUrl: path => path, withActiveDealerQuery: path => path,
    withActiveDealerBody: body => body, logout: () => {},
    parseApiResponse: response => response.json(), apiErrorMessage: data => data.message,
    setTimeout: (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
    clearTimeout: id => timers.delete(id),
    dashboardQueryString: () => 'dealerCode=11688&range=audit',
    setDashboardRefreshState: value => { context.refreshing = value; },
    setDashboardLoading: value => { context.loading = value; },
    updateDashboardScopeSummary: () => {}, updateActiveAuditUi: () => {},
    loadHealth: async () => ({}), applyServerInfo: () => {},
    updateSyncBadges: () => {}, updateDashboardHealth: () => {},
    updateDashboardCards: stats => rendered.push(stats),
    renderScanStream: rows => rows, renderDashboardTopBins: rows => bins.push(rows),
    fetch: async (path, options) => {
      requests.push(path);
      if (path.startsWith(stalledPath)) {
        return { ok: true, json: () => new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('aborted'); error.name = 'AbortError'; reject(error);
          }, { once: true });
        }) };
      }
      return { ok: true, json: async () => ({ success: true, stats: { totalScannedQuantity: 7 }, recent: [{ qty: 7 }] }) };
    }
  };
  vm.createContext(context);
  const apiStart = source.indexOf('  const pendingStatusRequests = new Map();');
  vm.runInContext(source.slice(apiStart, source.indexOf('  function sanitizeDownloadFileName', apiStart)), context);
  const loadStart = source.indexOf('  async function loadDashboard(options = {})');
  vm.runInContext(source.slice(loadStart, source.indexOf('  function syncScanDealerScope', loadStart)), context);
  return { context, timers, rendered, bins, requests };
}

test('a stalled dashboard summary times out, releases Refreshing and preserves existing values', async () => {
  const { context, timers, rendered } = dashboardHarness('/api/scans/dashboard');
  const previous = { totalScannedQuantity: 12 };
  context.state.dashboardStats = previous;
  const request = context.loadDashboard();
  const rejected = assert.rejects(request, /Server response delayed/);
  await new Promise(setImmediate);
  assert.equal(context.refreshing, true);
  assert.ok(timers.size > 0, 'dashboard summary must have a timeout');
  for (const { callback } of [...timers.values()]) callback();
  await rejected;
  assert.equal(context.refreshing, false);
  assert.equal(context.loading, false);
  assert.equal(context.state.dashboardStats, previous);
  assert.equal(rendered.length, 0);
});

test('a stalled live-bin widget cannot hold a successful dashboard in Refreshing', async () => {
  const { context, timers, rendered, bins, requests } = dashboardHarness('/api/scans/live');
  const request = context.loadDashboard();
  await new Promise(setImmediate);
  assert.equal(rendered[0].totalScannedQuantity, 7);
  await request;
  assert.equal(context.refreshing, false);
  assert.equal(context.state.dashboardLoaded, true);
  assert.deepEqual(bins, [[{ qty: 7 }]], 'recent scans should populate the widget while live bins are loading');
  assert.equal(requests.length, 2);
  assert.ok([...timers.values()].some(timer => timer.delay === 7000), 'the optional live-bin request must have a bounded timeout');
  for (const { callback } of [...timers.values()]) callback();
  await new Promise(setImmediate);
  assert.equal(context.refreshing, false);
});

test('late live-bin data from a previous dealer cannot overwrite a newer dashboard', async () => {
  const { context } = dashboardHarness('/unused');
  let finishOldBins;
  const bins = [];
  context.renderDashboardTopBins = rows => bins.push(rows);
  context.fetch = async path => ({ ok: true, json: async () => {
    if (path.includes('dealerCode=11688') && path.startsWith('/api/scans/live')) {
      // A completed response body can resolve after cancellation has occurred.
      return new Promise(resolve => { finishOldBins = resolve; });
    }
    return { success: true, stats: { totalScannedQuantity: 9 }, recent: [{ qty: 9 }] };
  } });
  const old = context.loadDashboard();
  await new Promise(setImmediate);
  context.dashboardQueryString = () => 'dealerCode=22222&range=audit';
  await context.loadDashboard({ force: true });
  const loadedAt = context.state.dashboardLastLoadedAt;
  assert.equal(bins.length, 2);
  assert.equal(bins[1][0].qty, 9);
  finishOldBins({ records: [{ qty: 999 }] });
  await old;
  assert.equal(bins.length, 2);
  assert.equal(context.state.dashboardLastLoadedAt, loadedAt);
  assert.equal(context.refreshing, false);
});

test('failed or malformed summary responses do not render zero-valued cards', async () => {
  for (const payload of [{ success: false, message: 'Database unavailable' }, { success: true }]) {
    const { context, rendered } = dashboardHarness('/unused');
    context.fetch = async () => ({ ok: true, json: async () => payload });
    await assert.rejects(context.loadDashboard(), /Database unavailable|missing summary data/);
    assert.equal(rendered.length, 0);
    assert.equal(context.refreshing, false);
  }
});

test('overlapping ordinary refresh calls share one summary and live-bin request', async () => {
  const { context, requests } = dashboardHarness('/unused');
  await Promise.all([context.loadDashboard(), context.loadDashboard()]);
  assert.equal(requests.length, 2);
  assert.equal(requests.filter(path => path.startsWith('/api/scans/dashboard?')).length, 1);
  assert.equal(context.refreshing, false);
});
