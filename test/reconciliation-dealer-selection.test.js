const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('public/ui.js', 'utf8');
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
function harness() {
  const selects = ['dashboardDealerSelect', 'dealerStockDealer', 'reconDealer'].map(id => ({
    id, value: '1168A', options: [{ value: '11688' }, { value: '1168A' }], closest: () => null
  }));
  const nodes = Object.fromEntries(selects.map(node => [`#${node.id}`, node]));
  const displayed = { rows: [{ dealerCode: '1168A' }], text: {} };
  const state = { token: 'admin', dashboardDealerCode: '1168A', activeDealerId: '1168A',
    dealers: selects[0].options.map(option => ({ dealerCode: option.value })),
    activeAudit: { dealerCode: '1168A', auditId: 'OLD' }, reconRows: displayed.rows,
    reconLoaded: true, reconDashboardStats: { dealerCode: '1168A' }, reconAuditId: 'OLD' };
  const noop = () => {};
  const context = { state, dealerContextVersion: 0, displayed,
    $: selector => nodes[selector] || null, $$: () => selects,
    cleanDealerCode: value => String(value || '').trim().toUpperCase(),
    isAdminUser: () => true, setDealerSelectValue: (select, value) => { select.value = value; },
    syncDealerSelectDisplay: noop, clearTimeout, URLSearchParams,
    setText: (key, value) => { displayed.text[key] = value; },
    storageSet: noop, storageRemove: noop, userScopedStorageKey: key => key,
    ACTIVE_DEALER_KEY: 'dealer', pendingStatusRequests: new Map(),
    clearScopedLiveCaches: () => context.clearReconciliationSelectionData(),
    renderSyncQueue: noop, renderSyncLog: noop, updateSyncBadges: noop,
    renderReconciliationRows: () => { displayed.rows = state.reconRows; },
    setReconciliationSummary: value => { displayed.summary = value; },
    renderDealerStockPreview: rows => { displayed.preview = rows; }, renderDealerStockErrors: noop,
    activeDealer: () => state.dealers.find(dealer => dealer.dealerCode === state.dashboardDealerCode),
    dashboardScopeDealerCode: () => state.dashboardDealerCode,
    formatDealerDisplay: dealer => dealer.dealerCode, setLivePill: noop, setDashboardKpiValue: noop,
    updateDashboardScopeSummary: noop, syncLocalPartFormIdentity: noop, restoreManualScanBin: noop,
    updateAuditPriceRefreshUi: noop, toast: noop, loadDealerStockPreview: async () => {},
    queryFromForm: () => ({ dealerCode: '1168A' })
  };
  vm.createContext(context);
  vm.runInContext(section('  function activeDealerId()', '  function dealerByCode'), context);
  vm.runInContext(section('  function setActiveDealerId(', '  function clearScopedLiveCaches'), context);
  vm.runInContext(section('  function updateActiveAuditUi()', '  async function loadActiveAudit'), context);
  vm.runInContext(section('  function activeReconDealer()', '  function renderDealerStockErrors'), context);
  vm.runInContext(section('  function syncReconDealer(', '  function activateReconciliationTab'), context);
  vm.runInContext(section('  function reconciliationExportQuery(', '  function clearPartSearch'), context);
  return { context, selects, state, displayed };
}

test('admin reconciliation choice updates the header and survives background audit refresh', () => {
  const { context, selects, state, displayed } = harness();
  context.selectReconciliationDealer('11688');
  context.updateActiveAuditUi();
  assert.equal(state.dashboardDealerCode, '11688');
  assert.equal(context.activeReconDealer(), '11688');
  assert.ok(selects.every(select => select.value === '11688'));
  assert.equal(displayed.rows.length, 0, 'old dealer rows cleared immediately');
  assert.equal(displayed.preview.length, 0);
  assert.equal(state.reconDashboardStats, null);
  assert.equal(state.reconAuditId, '');
  assert.equal(displayed.text.reconSelectedDealer, '11688');
  const query = new URLSearchParams(context.reconciliationExportQuery('excel'));
  assert.equal(query.get('dealerCode'), '11688', 'export overrides stale hidden form selection');
  context.selectReconciliationDealer('1168A');
  assert.ok(selects.every(select => select.value === '1168A'));
});

test('late preview and report responses cannot restore another dealer, including A to B to A', () => {
  const { context } = harness();
  context.selectReconciliationDealer('11688');
  const version = context.dealerContextVersion;
  assert.equal(context.reconciliationResponseIsCurrent('11688', version, { dealerCode: '11688' }), true);
  assert.throws(() => context.reconciliationResponseIsCurrent('11688', version, { stock: [{ dealerCode: '1168A' }] }), /does not match/);
  context.selectReconciliationDealer('1168A');
  assert.equal(context.reconciliationResponseIsCurrent('11688', version, { dealerCode: '11688' }), false);
  context.selectReconciliationDealer('11688');
  assert.equal(context.reconciliationResponseIsCurrent('11688', version, { dealerCode: '11688' }), false);
});

test('downloads reject changed dealer context and mismatched server scope before saving', async () => {
  const { context } = harness();
  context.selectReconciliationDealer('11688');
  Object.assign(context, { AbortController, setTimeout, clearTimeout,
    apiUrl: path => path, withActiveDealerQuery: path => path,
    resolveDownloadFileName: () => '11688.xlsx', triggerDownload: () => { context.saved = true; },
    parseApiResponse: async () => ({}), apiErrorMessage: () => 'error'
  });
  vm.runInContext(section('  async function downloadGet(', '  async function downloadPost'), context);
  let finish;
  context.fetch = () => new Promise(resolve => { finish = resolve; });
  const response = dealer => ({ ok: true, blob: async () => Buffer.from('xlsx'), headers: { get: () => dealer } });
  const options = { expectedDealerCode: '11688' };
  const request = context.downloadGet('/api/reconciliation/stock-export?dealerCode=11688', '11688.xlsx', options);
  context.selectReconciliationDealer('1168A');
  finish(response('11688'));
  await assert.rejects(request, /Dealer changed during download/);
  assert.equal(context.saved, undefined);
  context.selectReconciliationDealer('11688');
  context.fetch = async () => response('1168A');
  await assert.rejects(context.downloadGet('/api/reconciliation/stock-export?dealerCode=11688', '11688.xlsx', options), /does not match/);
  context.fetch = async () => response('11688');
  await context.downloadGet('/api/reconciliation/stock-export?dealerCode=11688', '11688.xlsx', options);
  assert.equal(context.saved, true);
});

test('preview and combined reconciliation requests discard stock when selection changes during loading', async () => {
  const { context, state, displayed } = harness();
  context.selectReconciliationDealer('11688');
  let finishPreview;
  context.api = () => new Promise(resolve => { finishPreview = resolve; });
  vm.runInContext(section('  async function loadDealerStockPreview()', '  async function uploadDealerStock'), context);
  context.loadReconciliation = async () => {};
  const preview = context.loadDealerStockPreview();
  // Change the authoritative dealer without scheduling another preview.
  context.setActiveDealerId('1168A');
  finishPreview({ dealerCode: '11688', auditId: 'A', stock: [{ dealerCode: '11688' }], total: 1 });
  assert.equal(await preview, null);
  assert.equal(displayed.preview.length, 0);
  context.setActiveDealerId('11688');
  let finishDashboard;
  const paths = [];
  context.api = path => {
    paths.push(path);
    return path.includes('/scans/dashboard')
      ? new Promise(resolve => { finishDashboard = resolve; })
      : Promise.resolve({ dealerCode: '11688', auditId: 'A', summary: {}, rows: [{ dealerCode: '11688' }] });
  };
  vm.runInContext(section('  async function loadReconciliation(', '  function reconciliationExportQuery'), context);
  const report = context.loadReconciliation();
  assert.ok(paths.every(path => new URL(path, 'http://localhost').searchParams.get('dealerCode') === '11688'));
  context.setActiveDealerId('1168A');
  finishDashboard({ stats: { dealerCode: '11688' } });
  await report;
  assert.equal(state.reconRows.length, 0);
  assert.equal(state.reconLoaded, false);
  assert.equal(state.reconDashboardStats, null);
});
