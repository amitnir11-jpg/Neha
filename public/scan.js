(function () {
  const APP_VERSION = '20260627-qr-global-bin-choice-v1';
  const CACHE_VERSION = APP_VERSION;
  const DB_NAME = 'daksh-fresh-scan';
  const STORE = 'queue';
  const SESSION_KEY = 'dakshFreshSession';
  const DEVICE_KEY = 'dakshFreshDeviceId';
  const MODE_KEY = 'dakshFreshMode';
  const BIN_KEY = 'dakshFreshActiveBin';
  const LAST_SYNC_KEY = 'dakshFreshLastSync';
  const SYNC_INTERVAL_MS = 45000;
  const RECENT_REFRESH_INTERVAL_MS = 8000;
  const HEARTBEAT_INTERVAL_MS = 90000;
  const API_TIMEOUT_MS = 45000;
  const LOGIN_CONFIG_TIMEOUT_MS = 15000;
  const STORAGE_OPEN_TIMEOUT_MS = 7000;
  const BATCH_SIZE = 50;
  const DEDUPE_MS = 2600;
  const DUPLICATE_NOTICE_MS = 3000;
  const SMART_BIN_DECISIONS = new Set(['USE_EXISTING', 'USE_EXISTING_BIN', 'SAVE_NEW_BIN', 'CONTINUE_NEW', 'ADD_ADDITIONAL']);
  const DEFAULT_DEVICE_NAME = 'Daksh Web Scanner';
  const LOCALHOST_NAMES = new Set(['localhost', '127.0.0.1', '::1']);
  const NATIVE_DETECTOR_FORMATS = [
    'qr_code',
    'data_matrix',
    'code_128',
    'code_39',
    'ean_13',
    'ean_8',
    'upc_a',
    'upc_e',
    'itf',
    'codabar',
    'pdf417',
    'aztec'
  ];

  const ZXING_SCRIPT_SRC = `/vendor/zxing/index.min.js?v=${CACHE_VERSION}`;

  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const byId = (id) => document.getElementById(id);

  function apiBaseUrl() {
    return String((window.DAKSH_CONFIG && window.DAKSH_CONFIG.apiBaseUrl) || window.DAKSH_API_BASE_URL || '').trim().replace(/\/+$/, '');
  }

  function apiUrl(path) {
    const text = String(path || '');
    if (/^https?:\/\//i.test(text)) return text;
    const base = apiBaseUrl();
    if (!base || !text.startsWith('/api')) return text;
    return `${base}${text}`;
  }

  const MODE_INFO = {
    INWARD: {
      label: 'Inward',
      requiresBin: true,
      note: 'Bin required'
    },
    OUTWARD: {
      label: 'Outward',
      requiresBin: false,
      note: 'Bin auto-detects'
    },
    FITTED: {
      label: 'Fitted',
      requiresBin: false,
      note: 'Vehicle + job card'
    },
    DAMAGE: {
      label: 'Damage',
      requiresBin: true,
      note: 'Bin required'
    },
    VERIFICATION: {
      label: 'Verification',
      requiresBin: false,
      note: 'Part only'
    }
  };

  const state = {
    db: null,
    session: loadSession(),
    pendingLogin: null,
    canonicalUrl: '',
    mode: loadMode(),
    allRows: [],
    scanReader: null,
    cameraRequested: false,
    scanning: false,
    paused: false,
    syncRunning: false,
    syncAgain: false,
    syncTimer: null,
    syncDelayTimer: null,
    recentRefreshTimer: null,
    heartbeatTimer: null,
    cameraTimer: null,
    autoCameraTimer: null,
    zxingRestartTimer: null,
    versionTimer: null,
    cameraRunId: 0,
    lastBinStartAt: 0,
    lastBinStartValue: '',
    nativeDetector: null,
    nativeDetectorPromise: null,
    nativeDetectorTimer: null,
    nativeDetectorFrame: null,
    nativeDetectorRunId: 0,
    nativeDetectorRunning: false,
    cameraStream: null,
    partMasterCache: new Map(),
    partMasterLookupPromise: new Map(),
    liveRecentRows: null,
    liveRecentRefreshPromise: null,
    liveRecentRefreshToken: 0,
    lastDecodeAtByKey: new Map(),
    duplicateNoticeLocks: new Map(),
    smartBinSettingsLoaded: false,
    smartBinSettings: { enabled: true, allowMultipleLocations: true, requireReason: true, maxAllowedLocationsPerPart: 3 },
    smartBinPromptOpen: false,
    smartBinPromptPayload: null,
    smartBinPromptResolver: null,
    duplicateAlertOpen: false,
    manualRaw: '',
    manualResumeAfterClose: false,
    manualMode: loadMode(),
    health: null,
    authReady: false,
    loginConfigLoading: true,
    loginConfigError: '',
    loginDealers: [],
    recommendedDealerCode: '',
    loginUrl: '/api/auth/mobile-login',
    zxingPromise: null
  };

  const CLEARABLE_STATUSES = new Set(['synced', 'duplicate', 'failed-duplicate', 'invalid', 'rejected']);

  function clean(value) {
    return String(value ?? '').trim();
  }

  function upper(value) {
    return clean(value).toUpperCase();
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function safeJsonParse(value, fallback = null) {
    try {
      return JSON.parse(value);
    } catch (_) {
      return fallback;
    }
  }

  function storageGet(key, fallback = '') {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (_) {
      return fallback;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (_) {}
  }

  function storageRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch (_) {}
  }

  function deviceId() {
    let id = storageGet(DEVICE_KEY, '');
    if (!id) {
      id = `WEB-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`.toUpperCase();
      storageSet(DEVICE_KEY, id);
    }
    return id;
  }

  function loadSession() {
    const raw = storageGet(SESSION_KEY, '');
    if (!raw) return null;
    const session = safeJsonParse(raw, null);
    return session && typeof session === 'object' ? session : null;
  }

  function saveSession(session) {
    state.session = session;
    storageSet(SESSION_KEY, JSON.stringify(session));
  }

  function clearSession() {
    state.session = null;
    storageRemove(SESSION_KEY);
    try {
      if (window.sessionStorage) sessionStorage.clear();
    } catch (_) {}
  }

  function loadMode() {
    const value = upper(storageGet(MODE_KEY, 'INWARD'));
    return MODE_INFO[value] ? value : 'INWARD';
  }

  function saveMode(mode) {
    state.mode = MODE_INFO[upper(mode)] ? upper(mode) : 'INWARD';
    storageSet(MODE_KEY, state.mode);
  }

  function activeDealerCode(session = state.session) {
    return upper(session?.dealerCode || session?.activeDealerId || '');
  }

  function activeDealerName(session = state.session) {
    return clean(session?.dealerName || '');
  }

  function activeAuditId(session = state.session) {
    return clean(session?.auditId || session?.activeAudit?.auditId || '');
  }

  function userKey(session = state.session) {
    const user = session?.user || {};
    return clean(user.id || user.username || user.email || user.name || session?.loginId || session?.userId).toLowerCase();
  }

  function sessionScopeKey(session = state.session) {
    const dealer = activeDealerCode(session);
    if (!dealer) return '';
    return [dealer, activeAuditId(session) || 'audit', userKey(session) || 'user', deviceId()].join('|');
  }

  function scopedKey(base, session = state.session) {
    const scope = sessionScopeKey(session);
    return scope ? `${base}:${scope}` : base;
  }

  function loadActiveBin(session = state.session) {
    return upper(storageGet(scopedKey(BIN_KEY, session), ''));
  }

  function saveActiveBin(value, session = state.session) {
    const bin = upper(value);
    const key = scopedKey(BIN_KEY, session);
    if (bin) storageSet(key, bin);
    else storageRemove(key);
    return bin;
  }

  function scanUrl() {
    const origin = window.location.origin.replace(/\/+$/, '');
    return `${origin}/mobile-scanner`;
  }

  function canonicalScanUrl() {
    return state.canonicalUrl || scanUrl();
  }

  function isSecureScannerContext() {
    return window.isSecureContext || LOCALHOST_NAMES.has(window.location.hostname) || window.location.hostname.endsWith('.localhost');
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(num) : '-';
  }

  function fmtTime(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return '-';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function authExpired(error) {
    return Boolean(error) && (
      Number(error.status) === 401 ||
      /login required|invalid token|jwt expired|token expired/i.test(error.message || '')
    );
  }

  function currentModeInfo(mode = state.mode) {
    return MODE_INFO[upper(mode)] || MODE_INFO.INWARD;
  }

  function currentScanType() {
    return upper(state.mode);
  }

  function requiresBin(mode = state.mode) {
    return Boolean(currentModeInfo(mode).requiresBin);
  }

  function suppressTimedKey(map, key, ttlMs = DUPLICATE_NOTICE_MS) {
    if (!key) return false;
    const now = Date.now();
    const until = Number(map.get(key) || 0);
    if (until > now) return true;
    const nextUntil = now + ttlMs;
    map.set(key, nextUntil);
    setTimeout(() => {
      if (map.get(key) === nextUntil) map.delete(key);
    }, ttlMs + 50);
    return false;
  }

  function normalizeText(value) {
    return upper(String(value ?? '').replace(/\s+/g, ' ').trim());
  }

  function parserKey(value) {
    return clean(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function firstParserValue(data = {}, keys = []) {
    for (const key of keys) {
      const value = data[parserKey(key)];
      if (value !== undefined && clean(value) !== '') return value;
    }
    return '';
  }

  function firstObjectValue(input = {}, keys = []) {
    const entries = Object.entries(input || {});
    for (const key of keys) {
      if (input[key] !== undefined && input[key] !== null && clean(input[key]) !== '') return input[key];
      const normalizedKey = parserKey(key);
      const found = entries.find(([entryKey, entryValue]) => parserKey(entryKey) === normalizedKey && clean(entryValue) !== '');
      if (found) return found[1];
    }
    return '';
  }

  function normalizePartCandidateValue(value) {
    return upper(clean(value).replace(/\s+/g, ''));
  }

  function isValidPartCandidate(value) {
    const part = normalizePartCandidateValue(value);
    return /^[A-Z0-9][A-Z0-9._\/-]{2,39}$/.test(part) && !/^UPI$/i.test(part);
  }

  function parseQueryLikeScan(raw = '') {
    const data = {};
    const text = clean(raw);
    if (!text) return data;
    const setValue = (value, key) => {
      const normalizedKey = parserKey(key);
      if (normalizedKey && clean(value)) data[normalizedKey] = clean(value);
    };
    try {
      const parsedUrl = new URL(text);
      parsedUrl.searchParams.forEach(setValue);
      return data;
    } catch (_) {
      const normalized = text.includes('?') ? text.slice(text.indexOf('?') + 1) : text;
      const params = new URLSearchParams(normalized.replace(/[|;]/g, '&'));
      params.forEach(setValue);
      return data;
    }
  }

  function parseKeyValueScan(raw = '') {
    const data = {};
    const pairs = String(raw || '').match(/[a-zA-Z][a-zA-Z0-9 _-]{0,24}\s*[:=]\s*[^|,;\n\r]+/g) || [];
    pairs.forEach((pair) => {
      const splitAt = pair.search(/[:=]/);
      const key = parserKey(pair.slice(0, splitAt));
      const value = clean(pair.slice(splitAt + 1));
      if (key && value) data[key] = value;
    });
    return data;
  }

  function extractUpiIdFromText(payload = {}) {
    const direct = clean(payload.upiNo || payload.upiId || payload.upiID || payload.upiScanId || payload.transactionId || payload.txnId);
    if (direct) return upper(direct).split('::')[0];
    const raw = clean(payload.rawScanString || payload.rawScan || payload.rawBarcode || payload.rawQR || payload.rawUpi || payload.scanText || payload.raw);
    if (!raw) return '';
    const slashParts = raw.split('/');
    if (slashParts.length >= 6 && clean(slashParts[1])) return upper(slashParts[1]).split('::')[0];
    const keyed = raw.match(/(?:upi|upid|upiid|txn|txnid|transaction|scanid)\s*[:=#-]?\s*([a-z0-9._/-]+)/i);
    return keyed ? upper(keyed[1]).split('::')[0] : '';
  }

  function scanIdentityKey(scan = {}) {
    const type = upper(scan.scanType || scan.type || state.mode);
    if (type === 'VERIFICATION') return '';
    const upi = extractUpiIdFromText(scan);
    if (upi) return ['UPI', upi].join('|');
    const raw = normalizeText(scan.rawScanString || scan.rawScan || scan.rawBarcode || scan.rawQR || scan.rawUpi || '');
    const part = duplicatePartKey(scan);
    if (/^MANUAL[:|#-]/i.test(clean(scan.rawScanString || scan.rawScan || ''))) return '';
    if (raw && raw !== part) return ['RAW', raw].join('|');
    return '';
  }

  function parsePartCandidate(raw = '') {
    const text = clean(raw);
    if (!text) return '';

    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        const fromObject = firstObjectValue(parsed, ['partNumber', 'partNo', 'part', 'sku', 'itemCode', 'item', 'p']);
        if (fromObject) return normalizePartCandidateValue(fromObject);
      }
    } catch (_) {}

    const slashParts = text.split('/');
    if (slashParts.length >= 6 && slashParts[3] && slashParts[4] && slashParts[5]) {
      return normalizePartCandidateValue(slashParts[3]);
    }

    const data = { ...parseQueryLikeScan(text), ...parseKeyValueScan(text) };
    const fromStructuredText = firstParserValue(data, ['partno', 'partnumber', 'part', 'pn', 'sku', 'item', 'p']);
    if (fromStructuredText) return normalizePartCandidateValue(fromStructuredText);

    const partMatch = text.match(/(?:part\s*no|part\s*number|part|pn|sku|item)\s*[:=#-]?\s*([a-z0-9._/-]+)/i);
    if (partMatch && partMatch[1]) return normalizePartCandidateValue(partMatch[1]);

    const simpleTokens = text.split(/[|,;\n\r\t ]+/).filter(Boolean);
    const rawLooksStructured = /[:?=&]|:\/\/|upi:|http/i.test(text);
    if (simpleTokens.length === 1 && !rawLooksStructured && isValidPartCandidate(simpleTokens[0])) {
      return normalizePartCandidateValue(simpleTokens[0]);
    }
    return '';
  }

  function parseRawPreview(raw = '') {
    const text = clean(raw);
    if (!text) return '';
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
  }

  function normalizeLoginDealer(dealer = {}) {
    const dealerCode = upper(dealer.dealerCode || dealer.code || dealer.id || dealer.dealerId || '');
    if (!dealerCode) return null;
    return {
      dealerCode,
      dealerName: clean(dealer.dealerName || dealer.name || ''),
      location: clean(dealer.location || ''),
      brand: clean(dealer.brand || ''),
      currentAuditId: clean(dealer.currentAuditId || dealer.auditId || '')
    };
  }

  function normalizeLoginDealers(dealers = []) {
    const seen = new Set();
    return (Array.isArray(dealers) ? dealers : [])
      .map((dealer) => normalizeLoginDealer(dealer))
      .filter(Boolean)
      .filter((dealer) => {
        if (seen.has(dealer.dealerCode)) return false;
        seen.add(dealer.dealerCode);
        return true;
      });
  }

  function loginDealerLabel(dealer = {}) {
    const code = upper(dealer.dealerCode);
    const name = clean(dealer.dealerName);
    return code ? `${code}${name ? ` - ${name}` : ''}` : name;
  }

  function renderLoginDealers(selectedDealerCode = '') {
    const select = byId('loginDealerSelect');
    if (!select) return;
    const dealers = normalizeLoginDealers(state.loginDealers);
    const chosen = upper(selectedDealerCode || state.pendingLogin?.dealerCode || state.recommendedDealerCode || select.value || '');
    const loading = state.loginConfigLoading && !dealers.length;
    const emptyLabel = loading
      ? 'Loading dealers...'
      : state.loginConfigError
        ? 'Dealer list unavailable'
        : 'No dealers available';
    select.disabled = !dealers.length;
    select.innerHTML = dealers.length
      ? ['<option value="">Select dealer code</option>', ...dealers.map((dealer) => {
        const label = loginDealerLabel(dealer);
        const audit = dealer.currentAuditId ? ` · Audit ${dealer.currentAuditId}` : '';
        return `<option value="${escapeHtml(dealer.dealerCode)}">${escapeHtml(`${label}${audit}`)}</option>`;
      })].join('')
      : `<option value="">${escapeHtml(emptyLabel)}</option>`;
    if (chosen && dealers.some((dealer) => dealer.dealerCode === chosen)) {
      select.value = chosen;
    } else if (dealers.length === 1) {
      select.value = dealers[0].dealerCode;
    } else {
      select.value = '';
    }
  }

  async function refreshMobileConfig() {
    state.loginConfigLoading = true;
    state.loginConfigError = '';
    renderLoginDealers();
    try {
      const data = await api('/api/mobile/config', { auth: false, timeoutMs: LOGIN_CONFIG_TIMEOUT_MS });
      if (await reloadForScannerBuild(data.webScannerBuild)) return null;
      state.authReady = true;
      state.canonicalUrl = data.mobileScannerUrl || data.scanUrl || state.canonicalUrl;
      state.loginUrl = data.loginUrl || state.loginUrl;
      state.recommendedDealerCode = upper(data.recommendedDealerCode || data.activeAudit?.dealerCode || '');
      state.loginDealers = normalizeLoginDealers(data.loginDealers || []);
      if (!state.loginDealers.length && state.recommendedDealerCode) {
        state.loginDealers = normalizeLoginDealers([{
          dealerCode: state.recommendedDealerCode,
          dealerName: data.activeAudit?.dealerName || ''
        }]);
      }
      state.loginConfigLoading = false;
      renderLoginDealers(state.pendingLogin?.dealerCode || state.recommendedDealerCode || '');
      renderUrlState();
      return data;
    } catch (error) {
      state.authReady = false;
      state.loginConfigLoading = false;
      state.loginConfigError = error.message || 'Dealer list unavailable';
      state.loginDealers = [];
      renderLoginDealers();
      return null;
    }
  }

  async function reloadForScannerBuild(serverBuild = '') {
    const build = clean(serverBuild);
    if (!build || build === CACHE_VERSION) return false;
    try {
      if (window.DAKSH_RUNTIME && typeof window.DAKSH_RUNTIME.refreshForVersionMismatch === 'function') {
        return await window.DAKSH_RUNTIME.refreshForVersionMismatch(build, { quiet: false });
      }
    } catch (error) {
      console.warn('[VERSION] runtime refresh failed', error);
    }
    const confirmed = window.confirm('New update available. Please refresh application.');
    if (!confirmed) return true;
    try {
      if (window.DAKSH_RUNTIME && typeof window.DAKSH_RUNTIME.clearClientCaches === 'function') {
        await window.DAKSH_RUNTIME.clearClientCaches();
      }
    } catch (error) {
      console.warn('[VERSION] cache clear fallback failed', error);
    }
    window.location.reload();
    return true;
  }

  async function checkScannerBuild() {
    try {
      const data = await api(`/api/mobile/version?t=${Date.now()}`, { auth: false, timeoutMs: 7000 });
      await reloadForScannerBuild(data.webScannerBuild);
    } catch (_) {}
  }

  function api(path, options = {}) {
    const { auth, timeoutMs = API_TIMEOUT_MS, ...fetchOptions } = options;
    const headers = { ...(fetchOptions.headers || {}) };
    const body = fetchOptions.body && typeof fetchOptions.body === 'object' && !(fetchOptions.body instanceof FormData)
      ? JSON.stringify(fetchOptions.body)
      : fetchOptions.body;
    if (!(body instanceof FormData)) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    if (state.session?.token && auth !== false) headers.Authorization = `Bearer ${state.session.token}`;

    fetchOptions.headers = headers;
    fetchOptions.body = body;

    let timeout = null;
    if (Number(timeoutMs) > 0 && typeof AbortController !== 'undefined' && !fetchOptions.signal) {
      const controller = new AbortController();
      fetchOptions.signal = controller.signal;
      timeout = setTimeout(() => controller.abort(), Number(timeoutMs));
    }

    fetchOptions.cache = fetchOptions.cache || 'no-store';

    return fetch(apiUrl(path), fetchOptions).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) {
        const error = new Error(data.message || response.statusText || 'Request failed');
        error.status = response.status;
        error.data = data;
        throw error;
      }
      return data;
    }).catch((error) => {
      if (error && error.name === 'AbortError') {
        throw new Error('Request timed out. Check network and retry.');
      }
      throw error;
    }).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  }

  function isRetryableTransportError(error = {}) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    const status = Number(error.status || 0);
    if ([408, 502, 503, 504].includes(status)) return true;
    if (status) return false;
    return /network|failed to fetch|load failed|timed?\s*out|timeout|offline|connection/i.test(clean(error.message || ''));
  }

  function toast(message, type = 'info') {
    const node = byId('toast');
    if (!node) return;
    node.textContent = message;
    node.hidden = false;
    node.dataset.kind = type;
    clearTimeout(node._hideTimer);
    node._hideTimer = setTimeout(() => {
      node.hidden = true;
    }, 3200);
  }

  function normalizeSmartBinSettings(value = {}) {
    const source = value && typeof value === 'object'
      ? (value.data && typeof value.data === 'object' ? { ...value.data, ...value } : { ...value })
      : {};
    const enabled = source.enabled === undefined ? true : Boolean(source.enabled);
    const allowMultipleLocations = source.allowMultipleLocations === undefined ? true : Boolean(source.allowMultipleLocations);
    const requireReason = source.requireReason === undefined ? true : Boolean(source.requireReason);
    const parsedMax = Number.parseInt(String(source.maxAllowedLocationsPerPart ?? 3), 10);
    const maxAllowedLocationsPerPart = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 3;
    return { enabled, allowMultipleLocations, requireReason, maxAllowedLocationsPerPart };
  }

  async function loadSmartBinSuggestionSettings(options = {}) {
    if (!options.force && state.smartBinSettingsLoaded) return state.smartBinSettings;
    try {
      const data = await api('/api/settings/smart-bin-suggestion', { timeoutMs: 8000 });
      state.smartBinSettings = normalizeSmartBinSettings(data);
      state.smartBinSettingsLoaded = true;
    } catch (error) {
      state.smartBinSettings = normalizeSmartBinSettings(state.smartBinSettings || {});
      state.smartBinSettingsLoaded = true;
      if (options.log !== false && state.session?.token) {
        console.warn('Smart bin settings load failed', error.message);
      }
    }
    return state.smartBinSettings;
  }

  function smartBinPromptNodes() {
    return {
      dialog: byId('smartBinSuggestionDialog'),
      title: byId('smartBinSuggestionTitle'),
      message: byId('smartBinSuggestionMessage'),
      bins: byId('smartBinExistingBins'),
      selectWrap: byId('smartBinExistingBinSelectWrap'),
      select: byId('smartBinExistingBinSelect'),
      useExisting: byId('smartBinUseExistingBtn'),
      saveNew: byId('smartBinSaveNewBtn'),
      cancel: byId('smartBinCancelBtn')
    };
  }

  function duplicateAlertNodes() {
    return {
      dialog: byId('duplicateAlertDialog'),
      title: byId('duplicateAlertTitle'),
      message: byId('duplicateAlertMessage'),
      ok: byId('duplicateAlertOkBtn')
    };
  }

  function closeSmartBinSuggestionModal(result = null) {
    const { dialog } = smartBinPromptNodes();
    if (dialog?.open) dialog.close();
    const resolve = state.smartBinPromptResolver;
    state.smartBinPromptResolver = null;
    state.smartBinPromptPayload = null;
    state.smartBinPromptOpen = false;
    if (resolve) resolve(result);
  }

  function closeDuplicateAlert() {
    const { dialog } = duplicateAlertNodes();
    if (dialog?.open) dialog.close();
    state.duplicateAlertOpen = false;
  }

  function smartBinExistingBinMarkup(existingBins = [], selectedBin = '') {
    if (!Array.isArray(existingBins) || !existingBins.length) {
      return '<div class="muted smart-bin-empty">No existing bin locations found.</div>';
    }
    const selected = upper(selectedBin || (existingBins[0] && existingBins[0].binLocation) || '');
    return existingBins.map((bin, index) => {
      const binLocation = clean(bin.binLocation || '');
      const active = index === 0 || upper(binLocation) === selected;
      const meta = [
        `Qty ${fmtNumber(Number(bin.qty || 0))}`,
        bin.createdBy ? `Created by ${bin.createdBy}` : '',
        bin.reason ? `Reason ${bin.reason}` : ''
      ].filter(Boolean).join(' · ');
      return `
        <button type="button" class="smart-bin-bin-row${active ? ' active' : ''}" data-bin="${escapeHtml(binLocation)}">
          <strong>${escapeHtml(binLocation || '-')} ${bin.locationType ? `<span class="smart-bin-location-type">${escapeHtml(bin.locationType)}</span>` : ''}</strong>
          <span>${escapeHtml(meta)}</span>
        </button>
      `;
    }).join('');
  }

  function refreshSmartBinActionLabels(payload = {}) {
    const { useExisting, saveNew, select } = smartBinPromptNodes();
    const existingBin = clean((select && select.value) || payload.selectedBin || payload.existingBin || payload.suggestedBin || payload.primaryBin || '');
    const newBin = clean(payload.newBin || payload.currentBin || payload.binLocation || '');
    if (useExisting) useExisting.textContent = existingBin ? `Use Existing ${existingBin}` : 'Use Existing Bin';
    if (saveNew) saveNew.textContent = newBin ? `Continue With ${newBin}` : 'Continue With Current Bin';
  }

  function renderDuplicateAlert(message = '', existing = {}) {
    const { dialog, title, message: messageNode, ok } = duplicateAlertNodes();
    if (!dialog) return;
    if (title) title.textContent = 'QR CODE ALREADY SCANNED';
    if (messageNode) {
      messageNode.textContent = clean(message || duplicateScanMessage(existing || {}));
    }
    if (!dialog.open) {
      state.duplicateAlertOpen = true;
      dialog.showModal();
      setTimeout(() => ok?.focus(), 0);
    }
  }

  function showDuplicateOnce(scan = {}, existing = {}, message = '') {
    const key = scanIdentityKey(scan) || scanIdentityKey(existing) || clean(scan.scanId || scan.uniqueScanId || '');
    if (suppressTimedKey(state.duplicateNoticeLocks, key, DUPLICATE_NOTICE_MS)) return;
    renderDuplicateAlert(message || duplicateScanMessage(existing || scan), existing || scan);
    beep('duplicate');
    vibrate([30, 40, 30]);
  }

  function renderSmartBinSuggestionModal(payload = {}) {
    const { dialog, title, message, bins, selectWrap, select, useExisting } = smartBinPromptNodes();
    if (!dialog) return;
    const existingBins = Array.isArray(payload.existingBins) ? payload.existingBins : [];
    const suggestedBin = clean(payload.suggestedBin || (existingBins[0] && existingBins[0].binLocation) || payload.currentBin || '');
    const currentBin = clean(payload.currentBin || '');
    const partNumber = clean(payload.partNumber || '');
    const partDescription = clean(payload.partDescription || payload.partName || '');
    const primaryBin = clean(payload.primaryBin || suggestedBin || currentBin || (existingBins[0] && existingBins[0].binLocation) || '');
    const selectedExistingBin = clean(payload.selectedBin || suggestedBin || (existingBins[0] ? existingBins[0].binLocation : '') || '');
    const existingBin = clean(payload.existingBin || selectedExistingBin || primaryBin || '');
    const newBin = clean(payload.newBin || currentBin || '');
    const promptTitle = clean(payload.promptTitle || 'PART ALREADY AVAILABLE IN OTHER BIN');
    state.smartBinPromptPayload = {
      ...payload,
      suggestedBin,
      currentBin,
      primaryBin,
      existingBins,
      partDescription,
      existingBin,
      newBin,
      selectedBin: selectedExistingBin,
      promptTitle
    };
    state.smartBinPromptOpen = true;

    if (title) title.textContent = promptTitle;
    if (message) {
      message.textContent = clean(payload.message || '') || `PART ${partNumber || '-'} IS AVAILABLE IN ${existingBin || '-'}\n\nWhat do you want to do?`;
    }
    if (bins) {
      bins.innerHTML = smartBinExistingBinMarkup(existingBins, selectedExistingBin || existingBin);
      qsa('[data-bin]', bins).forEach((button) => {
        button.addEventListener('click', () => {
          if (select) select.value = clean(button.dataset.bin || '');
          qsa('[data-bin]', bins).forEach((row) => row.classList.toggle('active', row === button));
          state.smartBinPromptPayload = {
            ...(state.smartBinPromptPayload || {}),
            selectedBin: clean(button.dataset.bin || '')
          };
          refreshSmartBinActionLabels(state.smartBinPromptPayload || {});
        });
      });
    }
    if (selectWrap) selectWrap.classList.toggle('hidden', existingBins.length <= 1);
    if (select) {
      select.innerHTML = existingBins.map((bin) => `<option value="${escapeHtml(bin.binLocation)}">${escapeHtml(bin.binLocation)} · Qty ${escapeHtml(fmtNumber(Number(bin.qty || 0)))}</option>`).join('');
      select.value = selectedExistingBin || (existingBins[0] ? existingBins[0].binLocation : '');
      select.onchange = () => {
        const selected = clean(select.value || '');
        state.smartBinPromptPayload = {
          ...(state.smartBinPromptPayload || {}),
          selectedBin: selected
        };
        if (bins) {
          qsa('[data-bin]', bins).forEach((row) => row.classList.toggle('active', upper(row.dataset.bin || '') === upper(selected || '')));
        }
        refreshSmartBinActionLabels(state.smartBinPromptPayload || {});
      };
    }
    if (useExisting) useExisting.hidden = !existingBin;
    refreshSmartBinActionLabels(state.smartBinPromptPayload || {});
    if (!dialog.open) {
      dialog.showModal();
    }
    beep('duplicate');
    vibrate([20, 30, 20]);
  }

  async function openSmartBinSuggestionModal(payload = {}) {
    const { dialog } = smartBinPromptNodes();
    if (!dialog) return null;
    if (state.smartBinPromptResolver) closeSmartBinSuggestionModal(null);
    renderSmartBinSuggestionModal(payload);
    return new Promise((resolve) => {
      state.smartBinPromptResolver = resolve;
    });
  }

  async function resolveSmartBinSuggestionAction(action, payload = {}) {
    const { select } = smartBinPromptNodes();
    const currentBin = clean(payload.currentBin || payload.binLocation || '');
    const suggestedBin = clean(payload.suggestedBin || (payload.existingBins && payload.existingBins[0] && payload.existingBins[0].binLocation) || '');
    const selectedExistingBin = clean((select && select.value) || suggestedBin || '');
    const useExisting = action === 'USE_EXISTING_BIN';
    const saveNew = action === 'SAVE_NEW_BIN';

    if (!useExisting && !saveNew) {
      closeSmartBinSuggestionModal(null);
      return null;
    }
    const decision = {
      action: useExisting ? 'USE_EXISTING_BIN' : 'SAVE_NEW_BIN',
      currentBin,
      selectedBin: useExisting ? selectedExistingBin : currentBin,
      suggestedBin,
      existingBins: Array.isArray(payload.existingBins) ? payload.existingBins : [],
      decisionBy: clean(state.session && (state.session.user?.name || state.session.user?.username || state.session.user?.email || state.session.user?.id || '')),
      decisionAt: nowIso(),
      checkedAt: payload.checkedAt || nowIso()
    };
    const finalBin = clean(decision.selectedBin || decision.currentBin || '');
    if (finalBin) setActiveBin(finalBin);
    closeSmartBinSuggestionModal(decision);
    if (state.scanning) cameraState('Ready to scan');
    else requestAutoCameraStart();
    return decision;
  }

  function beep(type = 'ok') {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const context = beep.context || (beep.context = new AudioContext());
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = type === 'error' ? 220 : type === 'duplicate' ? 620 : 1040;
      gain.gain.value = 0.001;
      const peak = type === 'error' ? 0.16 : 0.12;
      gain.gain.exponentialRampToValueAtTime(peak, context.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + (type === 'error' ? 0.3 : 0.12));
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + (type === 'error' ? 0.33 : 0.14));
    } catch (_) {}
  }

  function vibrate(pattern = 40) {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (_) {}
  }

  function openDb(timeoutMs = STORAGE_OPEN_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('Local browser storage is unavailable'));
        return;
      }
      let settled = false;
      const timer = setTimeout(() => finish(reject, new Error('Local browser storage timed out')), timeoutMs);
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      let request = null;
      try {
        request = indexedDB.open(DB_NAME, 1);
      } catch (error) {
        finish(reject, error);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        const store = db.createObjectStore(STORE, { keyPath: 'scanId' });
        store.createIndex('status', 'status');
        store.createIndex('syncStatus', 'syncStatus');
        store.createIndex('timestamp', 'timestamp');
        store.createIndex('dealerCode', 'dealerCode');
      };
      request.onsuccess = () => finish(resolve, request.result);
      request.onerror = () => finish(reject, request.error);
      request.onblocked = () => finish(reject, new Error('Local browser storage is blocked by another tab'));
    });
  }

  function txStore(mode = 'readonly') {
    return state.db.transaction(STORE, mode).objectStore(STORE);
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function getAllRecords() {
    if (!state.db) return [];
    return requestToPromise(txStore().getAll());
  }

  async function getRecord(scanId) {
    if (!state.db) return null;
    return requestToPromise(txStore().get(scanId));
  }

  async function putRecord(record) {
    if (!state.db) throw new Error('Local queue is not ready');
    await requestToPromise(txStore('readwrite').put(record));
  }

  async function deleteRecord(scanId) {
    if (!state.db) return;
    await requestToPromise(txStore('readwrite').delete(scanId));
  }

  function sessionUserCandidates(session = state.session) {
    const user = session?.user || {};
    return new Set([
      clean(user.id).toLowerCase(),
      clean(user.username).toLowerCase(),
      clean(user.email).toLowerCase(),
      clean(user.name).toLowerCase(),
      clean(session?.loginId).toLowerCase(),
      clean(session?.userId).toLowerCase()
    ].filter(Boolean));
  }

  function rowMatchesSession(row = {}, session = state.session) {
    if (!session?.token) return false;
    const dealer = activeDealerCode(session);
    if (dealer) {
      const rowDealer = upper(row.dealerCode || row.dealer || row.dealerId || '');
      if (rowDealer && rowDealer !== dealer) return false;
    }
    const audit = activeAuditId(session);
    if (audit && row.auditId && clean(row.auditId) !== audit) return false;
    const candidates = sessionUserCandidates(session);
    const rowUser = clean(row.userId || row.loginId || row.userName || row.staffName).toLowerCase();
    if (rowUser && candidates.size && !candidates.has(rowUser)) return false;
    return true;
  }

  function sessionRows() {
    return stateRows()
      .filter((row) => rowMatchesSession(row))
      .sort((left, right) => {
        const rightTime = new Date(right.mobileCreatedAt || right.timestamp || right.createdAt || 0).getTime();
        const leftTime = new Date(left.mobileCreatedAt || left.timestamp || left.createdAt || 0).getTime();
        return rightTime - leftTime;
      });
  }

  function stateRows() {
    return Array.isArray(state.allRows) ? state.allRows.slice() : [];
  }

  function recordKey(row = {}) {
    return clean(row.uniqueLocalId || row.scanId || row.uniqueScanId || row.localId || row.clientScanId || row.syncKey || row.clientSyncKey || '');
  }

  function upsertStateRow(record = {}) {
    const key = recordKey(record);
    if (!key) return;
    const rows = stateRows();
    const index = rows.findIndex((row) => recordKey(row) === key);
    if (index >= 0) {
      rows[index] = { ...rows[index], ...record };
    } else {
      rows.unshift(record);
    }
    state.allRows = rows;
  }

  function removeStateRow(identifier = '') {
    const key = typeof identifier === 'object' ? recordKey(identifier) : clean(identifier);
    if (!key) return;
    state.allRows = stateRows().filter((row) => recordKey(row) !== key);
  }

  function rowStatus(row = {}) {
    return clean(row.syncStatus || row.status || 'pending').toLowerCase();
  }

  function rowMovementType(row = {}) {
    return upper(row.movementType || row.scanType || row.type || state.mode);
  }

  function rowUpiCode(row = {}) {
    return upper(row.upiCode || row.upiNo || row.upiId || extractUpiIdFromText(row) || '');
  }

  function rowBlocksDuplicate(row = {}) {
    const status = rowStatus(row);
    if (row.serverDuplicateState === 'free') return false;
    if (['duplicate', 'failed-duplicate', 'failed', 'invalid', 'deleted', 'rejected'].includes(status)) return false;
    return rowMovementType(row) !== 'VERIFICATION';
  }

  function rowPart(row = {}) {
    return clean(row.partNumber || row.normalizedPartNumber || parsePartCandidate(row.rawScanString || row.rawScan || '') || row.rawScanString || row.rawScan || '-');
  }

  function rowQty(row = {}) {
    const value = Number(row.qty ?? row.quantity ?? 1);
    return Number.isFinite(value) ? value : 1;
  }

  function rowMode(row = {}) {
    return upper(row.scanType || row.type || 'INWARD');
  }

  function rowBin(row = {}) {
    return clean(row.binLocation || row.bin || '');
  }

  function mergeRecentRows() {
    const localRows = sessionRows();
    const remoteRows = Array.isArray(state.liveRecentRows) ? state.liveRecentRows : [];
    const merged = [];
    const seen = new Set();
    const push = (row = {}) => {
      const key = scanIdentityKey(row) || recordKey(row) || `${clean(row.rawScanString || row.rawScan || '')}|${clean(row.timestamp || row.createdAt || row.mobileCreatedAt || '')}`;
      if (!key || seen.has(key)) return;
      seen.add(key);
      merged.push(row);
    };
    localRows.forEach(push);
    remoteRows.forEach(push);
    return merged.slice(0, 10);
  }

  async function copyTextValue(value, label = 'Value') {
    const text = clean(value);
    if (!text) throw new Error(`${label} is not available`);
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const temp = document.createElement('input');
    temp.value = text;
    document.body.appendChild(temp);
    temp.select();
    document.execCommand('copy');
    temp.remove();
  }

  function partActionButtonHtml(kind, part, options = {}) {
    const isCopy = kind === 'copy';
    const removeMode = String(options.removeMode || options.deleteMode || '').trim().toLowerCase();
    const disabled = !isCopy && !removeMode;
    const classes = ['part-action-btn', isCopy ? 'copy-part-btn' : 'remove-part-btn'].join(' ');
    const attrs = [
      'type="button"',
      `class="${classes}"`,
      `data-part="${escapeHtml(part)}"`,
      `title="${escapeHtml(isCopy ? 'Copy part number' : options.removeTitle || 'Remove part number')}"`,
      `aria-label="${escapeHtml(isCopy ? `Copy part number ${part}` : options.removeLabel || `Remove part number ${part}`)}"`
    ];
    if (isCopy) {
      attrs.push(`data-copy-label="${escapeHtml(options.copyLabel || 'Part number')}"`);
    } else {
      if (removeMode) attrs.push(`data-delete-mode="${escapeHtml(removeMode)}"`);
      if (options.scanId) attrs.push(`data-scan-id="${escapeHtml(options.scanId)}"`);
      if (options.dealerCode) attrs.push(`data-dealer-code="${escapeHtml(options.dealerCode)}"`);
      if (options.auditId) attrs.push(`data-audit-id="${escapeHtml(options.auditId)}"`);
      if (options.partNumber) attrs.push(`data-part-number="${escapeHtml(options.partNumber)}"`);
      if (options.localOnly) attrs.push('data-local-only="true"');
      if (disabled) {
        attrs.push('disabled');
        attrs.push('aria-disabled="true"');
      }
    }
    return `<button ${attrs.join(' ')}>${isCopy ? '⧉' : '✕'}</button>`;
  }

  function partLink(partNumber, options = {}) {
    const part = clean(partNumber || '');
    if (!part) return escapeHtml(partNumber || '-');
    return `<span class="part-link-copy-group part-link-static"><span class="part-number-selectable">${escapeHtml(part)}</span></span>`;
  }

  function duplicateScanMessage(existing = {}) {
    void existing;
    return 'This QR code is already scanned.';
  }

  function duplicateRawKey(row = {}) {
    return normalizeText(row.rawScanString || row.rawScan || row.rawBarcode || row.rawQR || row.rawUpi || row.raw || '');
  }

  function duplicatePartKey(row = {}) {
    return normalizePartCandidateValue(row.partNumber || row.normalizedPartNumber || row.part || row.parsedPartNumber || '');
  }

  function smartBinGroupSort(a = {}, b = {}) {
    const qtyDiff = Number(b.qty || 0) - Number(a.qty || 0);
    if (qtyDiff) return qtyDiff;
    const timeA = new Date(a.lastScanDate || a.createdDate || a.updatedAt || 0).getTime();
    const timeB = new Date(b.lastScanDate || b.createdDate || b.updatedAt || 0).getTime();
    if (timeA !== timeB) return timeB - timeA;
    return String(a.binLocation || '').localeCompare(String(b.binLocation || ''), undefined, { numeric: true, sensitivity: 'base' });
  }

  function smartBinCountedRow(row = {}) {
    if (!row || row.deletedAt) return false;
    const status = rowStatus(row);
    if (['duplicate', 'failed-duplicate', 'failed', 'invalid', 'deleted', 'rejected'].includes(status)) return false;
    if (row.serverDuplicateState === 'free') return false;
    if (row.activeInventory === false) return false;
    if (Number(row.remainingQty ?? row.qty ?? row.quantity ?? 0) <= 0) return false;
    return ['INWARD', 'AUDIT'].includes(rowMovementType(row));
  }

  function buildLocalSmartBinSuggestion(record = {}) {
    if (!smartBinPreflightEligible(record)) return null;

    const partNumber = duplicatePartKey(record);
    const currentBin = rowBin(record);
    if (!partNumber || !currentBin) return null;

    const currentDealer = upper(record.dealerCode || activeDealerCode());
    const currentAudit = clean(record.auditId || activeAuditId());
    const currentKey = recordKey(record);
    const currentIdentity = scanIdentityKey(record);
    const bins = new Map();

    duplicateLookupRows().forEach((row) => {
      if (!row || !smartBinCountedRow(row)) return;
      if (currentDealer && upper(row.dealerCode || row.dealer || '') !== currentDealer) return;
      if (currentAudit && clean(row.auditId || row.audit || '') !== currentAudit) return;

      const rowPart = duplicatePartKey(row);
      const rowBinLocation = rowBin(row);
      if (!rowPart || rowPart !== partNumber || !rowBinLocation) return;
      if ((currentKey && recordKey(row) === currentKey) || (currentIdentity && scanIdentityKey(row) === currentIdentity)) return;

      const binKey = upper(rowBinLocation);
      const qty = Math.abs(Number(row.qty ?? row.quantity ?? 0) || 0);
      if (!qty) return;

      const rowMoment = new Date(row.smartBinDecisionAt || row.smartBinCheckedAt || row.mobileCreatedAt || row.timestamp || row.createdAt || row.scanTime || 0).getTime();
      const entry = bins.get(binKey) || {
        binLocation: binKey,
        qty: 0,
        locationType: 'SECONDARY',
        createdBy: '',
        createdDate: '',
        lastScanDate: '',
        reason: '',
        partDescription: '',
        lastScanMoment: 0
      };

      entry.qty += qty;
      entry.dealerCode = entry.dealerCode || upper(row.dealerCode || row.dealer || '');
      entry.auditId = entry.auditId || clean(row.auditId || row.audit || '');
      entry.partNumber = entry.partNumber || rowPart;
      if (!entry.partDescription) {
        entry.partDescription = clean(row.partDescription || row.partName || row.description || '');
      }
      if (!entry.createdBy) {
        entry.createdBy = clean(row.smartBinDecisionBy || row.userName || row.staffName || row.loginId || row.username || row.userId || row.deviceName || '');
      }
      if (!entry.reason) {
        entry.reason = clean(row.smartBinReason || row.reason || row.remarks || row.comment || row.comments || '');
      }
      if (rowMoment >= entry.lastScanMoment) {
        entry.lastScanMoment = rowMoment;
        entry.lastScanDate = rowMoment ? new Date(rowMoment).toISOString() : clean(row.smartBinDecisionAt || row.smartBinCheckedAt || row.mobileCreatedAt || row.timestamp || row.createdAt || row.scanTime || '');
        entry.createdDate = clean(row.createdAt || row.timestamp || row.scanTime || row.mobileCreatedAt || row.smartBinCheckedAt || row.smartBinDecisionAt || '');
        entry.createdBy = clean(row.smartBinDecisionBy || row.userName || row.staffName || row.loginId || row.username || row.userId || row.deviceName || entry.createdBy || '');
      }
      bins.set(binKey, entry);
    });

    const existingBins = Array.from(bins.values())
      .sort(smartBinGroupSort)
      .map((row, index) => ({
        binLocation: row.binLocation,
        qty: Number(row.qty || 0),
        locationType: index === 0 ? 'PRIMARY' : 'SECONDARY',
        createdBy: row.createdBy || '',
        createdDate: row.createdDate || '',
        lastScanDate: row.lastScanDate || '',
        reason: row.reason || '',
        partDescription: row.partDescription || ''
      }));

    if (!existingBins.length) return null;
    const sameBinExists = existingBins.some((row) => upper(row.binLocation || '') === currentBin);
    if (sameBinExists) return null;

    const primaryBin = existingBins[0] ? existingBins[0].binLocation : currentBin;
    const descriptionSource = existingBins.find((row) => clean(row.partDescription || '')) || {};
    const partDescription = clean(descriptionSource.partDescription || '');
    const totalQty = existingBins.reduce((sum, row) => sum + Number(row.qty || 0), 0);
    const allowMultipleLocations = state.smartBinSettings?.allowMultipleLocations === undefined
      ? true
      : Boolean(state.smartBinSettings.allowMultipleLocations);
    const maxAllowedLocationsPerPart = Math.max(1, Number.parseInt(String(state.smartBinSettings?.maxAllowedLocationsPerPart || 3), 10) || 3);
    const locationLimitReached = existingBins.length >= maxAllowedLocationsPerPart;
    const promptTitle = 'PART ALREADY AVAILABLE IN OTHER BIN';
    const existingBinText = existingBins.length > 1
      ? existingBins.map((row) => row.binLocation).join(', ')
      : primaryBin || '-';
    const message = `PART ${partNumber || '-'} IS AVAILABLE IN ${existingBinText || '-'}\n\nWhat do you want to do?`;

    return {
      dealerCode: currentDealer,
      auditId: currentAudit,
      partNumber,
      partDescription,
      currentBin,
      existingBin: primaryBin || currentBin,
      newBin: currentBin,
      primaryBin: primaryBin || currentBin,
      primaryLocation: primaryBin || currentBin,
      secondaryBins: existingBins.slice(1).map((row) => row.binLocation),
      existingBins,
      existingBinCount: existingBins.length,
      totalQty,
      suggestedBin: primaryBin || currentBin,
      sameBinExists: false,
      shouldPrompt: true,
      canUseExisting: Boolean(existingBins.length),
      canAddNewLocation: allowMultipleLocations && !locationLimitReached,
      canContinueCurrent: allowMultipleLocations && !locationLimitReached,
      locationLimitReached,
      allowMultipleLocations,
      maxAllowedLocationsPerPart,
      reasonRequired: Boolean(state.smartBinSettings?.requireReason ?? true),
      promptTitle,
      message
    };
  }

  function duplicateLookupRows() {
    const rows = [];
    const seen = new Set();
    const pushRow = (row = {}) => {
      const key = recordKey(row) || scanIdentityKey(row) || clean(row.scanId || row.uniqueScanId || row.localId || row.syncKey || '');
      if (key && seen.has(key)) return;
      if (key) seen.add(key);
      rows.push(row);
    };
    sessionRows().forEach(pushRow);
    if (Array.isArray(state.liveRecentRows)) state.liveRecentRows.forEach(pushRow);
    return rows;
  }

  function isSameQrDuplicateScan(record = {}, existing = {}) {
    if (!rowBlocksDuplicate(existing)) return false;
    const recordType = rowMode(record);
    const existingType = rowMode(existing);
    const recordKeyValue = recordKey(record);
    const existingKeyValue = recordKey(existing);
    if (recordKeyValue && existingKeyValue && recordKeyValue === existingKeyValue) return false;
    if (recordType === 'VERIFICATION' || existingType === 'VERIFICATION') return false;
    const recordIdentity = scanIdentityKey(record);
    const existingIdentity = scanIdentityKey(existing);
    return Boolean(recordIdentity && existingIdentity && recordIdentity === existingIdentity);
  }

  async function deleteHistoryRow(row = {}) {
    const scanId = clean(row.scanId || row.uniqueScanId || row.localId || '');
    if (!scanId) {
      toast('Scan record is not available', 'error');
      return;
    }
    const part = rowPart(row) || '-';
    const status = rowStatus(row);
    if (!window.confirm(`Delete part ${part}?`)) return;
    if (status === 'synced' && state.session?.role === 'admin') {
      await api('/api/inventory/delete-selected', {
        method: 'POST',
        body: { ids: [scanId], confirmText: 'DELETE' }
      });
    }
    await deleteRecord(scanId);
    removeStateRow(scanId);
    state.liveRecentRows = null;
    state.liveRecentRefreshPromise = null;
    state.liveRecentRefreshToken = Number(state.liveRecentRefreshToken || 0) + 1;
    renderQueueBadgeCounts();
    renderHistoryRows();
    refreshLiveRecentScans({ force: true, reason: 'delete' }).catch(() => undefined);
    toast(status === 'synced' ? 'Scan deleted' : 'Local scan removed', 'success');
  }

  function localDuplicateForRecord(record = {}) {
    if (!(rowUpiCode(record) || extractUpiIdFromText(record) || duplicateRawKey(record))) return null;
    return duplicateLookupRows().find((row) => isSameQrDuplicateScan(record, row)) || null;
  }

  function renderUrlState() {
    const url = canonicalScanUrl();
    state.canonicalUrl = url;
    const scannerUrlText = byId('scannerUrlText');
    const openScanUrl = byId('openScanUrl');
    const copyUrlBtn = byId('copyUrlBtn');
    const copyScannerUrlBtn = byId('copyScannerUrlBtn');
    if (scannerUrlText) scannerUrlText.textContent = url;
    if (openScanUrl) openScanUrl.href = url;
    if (copyUrlBtn) copyUrlBtn.dataset.url = url;
    if (copyScannerUrlBtn) copyScannerUrlBtn.dataset.url = url;
    const notice = byId('contextNotice');
    const secure = isSecureScannerContext();
    const secureBadge = byId('secureBadge');
    if (secureBadge) {
      secureBadge.textContent = secure ? 'Secure' : 'Insecure';
      secureBadge.className = `status-pill ${secure ? 'online' : 'warning'}`;
    }

    if (notice) {
      if (secure) {
        notice.hidden = true;
        notice.textContent = '';
      } else {
        notice.hidden = false;
        notice.textContent = `Camera access is blocked on this HTTP page. Open the secure Railway URL instead: ${url}`;
      }
    }
  }

  function renderConnectionBadge() {
    const badge = byId('networkBadge');
    const online = navigator.onLine;
    badge.textContent = online ? 'Online' : 'Offline';
    badge.className = `status-pill ${online ? 'online' : 'offline'}`;
  }

  function renderSessionHeader() {
    const dealerCode = activeDealerCode();
    const dealerName = activeDealerName();
    const user = state.session?.user || {};
    const userLabel = clean(user.name || user.username || state.session?.userName || 'User');
    const sessionLabel = dealerCode ? `${dealerCode}${dealerName ? ` - ${dealerName}` : ''}` : 'Dealer not loaded';
    byId('sessionDealerLabel').textContent = sessionLabel;
    byId('sessionUserLabel').textContent = state.session?.token
      ? `${userLabel} · ${deviceId()}`
      : 'Login to start scanning';

    const auditLabel = activeAuditId() ? `Audit ${activeAuditId()}${dealerName ? ` · ${dealerName}` : ''}` : 'No active audit loaded yet';
    byId('activeAuditLabel').textContent = auditLabel;
  }

  function renderServerSummary() {
    const health = state.health || {};
    const parts = [];
    if (health.status || health.serverStatus) parts.push(`Server ${health.status || health.serverStatus}`);
    if (health.databaseStatus || health.postgresStatus || health.db) parts.push(`DB ${health.databaseStatus || health.postgresStatus || health.db}`);
    if (Number.isFinite(Number(health.connectedDevices))) parts.push(`Devices ${Number(health.connectedDevices)}`);
    if (health.lastSyncTime) parts.push(`Last sync ${fmtTime(health.lastSyncTime)}`);
    if (!parts.length) parts.push('Server status unavailable');
    byId('serverStateLabel').textContent = parts.join(' · ');
  }

  function renderModeButtons() {
    qsa('.mode-btn').forEach((button) => {
      button.classList.toggle('active', upper(button.dataset.mode) === state.mode);
    });
  }

  function renderModeMeta() {
    const info = currentModeInfo();
    const cameraHint = byId('cameraHint');
    cameraHint.textContent = isSecureScannerContext()
      ? 'Ready to scan'
      : 'Camera blocked on non-HTTPS pages. Use the secure Railway scanner URL.';
    const manualNote = byId('manualNote');
    manualNote.textContent = info.note;
    byId('manualTitle').textContent = info.label === 'Fitted'
      ? 'Complete fitted details'
      : info.label === 'Verification'
        ? 'Verification entry'
        : 'Add scan manually';
  }

  function renderModeFields() {
    const info = currentModeInfo();
    const verification = state.mode === 'VERIFICATION';
    const fitted = state.mode === 'FITTED';
    const binWrap = byId('manualBinWrap');
    const mrpWrap = byId('manualMrpWrap');
    const dlcWrap = byId('manualDlcWrap');
    const qtyWrap = byId('manualQtyWrap');
    const regWrap = byId('manualRegWrap');
    const jobWrap = byId('manualJobWrap');
    const qtyInput = byId('manualQty');
    const mrpInput = byId('manualMrp');
    const dlcInput = byId('manualDlc');
    const binInput = byId('manualBinLocation');
    const regInput = byId('manualRegdNo');
    const jobInput = byId('manualJobCardNo');

    binWrap.classList.toggle('hidden', !info.requiresBin);
    mrpWrap.classList.toggle('hidden', verification);
    if (dlcWrap) dlcWrap.classList.toggle('hidden', verification);
    qtyWrap.classList.toggle('hidden', verification);
    regWrap.classList.toggle('hidden', !fitted);
    jobWrap.classList.toggle('hidden', !fitted);

    binInput.required = info.requiresBin;
    qtyInput.required = !verification;
    mrpInput.required = false;
    if (dlcInput) dlcInput.required = false;
    regInput.required = fitted;
    jobInput.required = fitted;
  }

  function renderBinPanel() {
    const panel = byId('binPanel');
    const input = byId('activeBinLocation');
    const message = byId('binPanelMessage');
    const info = currentModeInfo();
    const current = loadActiveBin();
    if (!panel || !input || !message) return;

    panel.classList.toggle('hidden', !info.requiresBin && state.mode !== 'OUTWARD');
    input.value = current;
    input.required = info.requiresBin;
    if (info.requiresBin) {
      const ready = Boolean(current);
      panel.classList.toggle('ready', ready);
      panel.classList.toggle('blocked', !ready);
      message.textContent = ready
        ? `Scanning will save to bin ${current}.`
        : 'Camera stays on automatically. Enter a bin before saving inward or damage scans.';
    } else if (state.mode === 'OUTWARD') {
      panel.classList.remove('blocked');
      panel.classList.remove('ready');
      message.textContent = 'Outward scans will auto-detect the source bin on sync.';
    } else if (state.mode === 'VERIFICATION') {
      panel.classList.remove('blocked');
      panel.classList.remove('ready');
      message.textContent = 'Bin location is not required for verification.';
    } else {
      panel.classList.remove('blocked');
      panel.classList.remove('ready');
      message.textContent = current
        ? `Current bin ${current} will be used as the default.`
        : 'You can keep a default bin ready for manual entry.';
    }
  }

  function ensureActiveBinReady() {
    if (!requiresBin()) return true;
    const bin = loadActiveBin();
    if (bin) return true;
    state.cameraRequested = true;
    cameraState('Camera on - enter a bin to save this scan.');
    toast('Bin location is required before inward or damage scans', 'error');
    byId('activeBinLocation').focus();
    return false;
  }

  function setActiveBin(value) {
    const bin = saveActiveBin(value);
    byId('activeBinLocation').value = bin;
    renderBinPanel();
    return bin;
  }

  function saveBinAndStartCamera() {
    const input = byId('activeBinLocation');
    const bin = setActiveBin(input?.value || '');
    if (!bin) {
      toast('Enter a bin location first', 'error');
      input?.focus();
      return '';
    }
    const startKey = `${state.mode}:${bin}`;
    const now = Date.now();
    if (state.lastBinStartValue === startKey && now - Number(state.lastBinStartAt || 0) < 700) return bin;
    state.lastBinStartValue = startKey;
    state.lastBinStartAt = now;
    toast(`Bin ${bin} saved`, 'success');
    state.paused = false;
    state.cameraRequested = true;
    clearTimeout(state.autoCameraTimer);
    if (state.scanning) {
      cameraState('Ready to scan');
    } else {
      requestAutoCameraStart();
    }
    return bin;
  }

  function renderQueueBadgeCounts() {
    const rows = sessionRows();
    const pending = rows.filter((row) => rowStatus(row) === 'pending').length;
    const synced = rows.filter((row) => rowStatus(row) === 'synced').length;
    const failed = rows.filter((row) => ['failed', 'failed-duplicate', 'invalid', 'duplicate', 'rejected'].includes(rowStatus(row))).length;
    byId('queueTotal').textContent = String(rows.length);
    byId('queueSynced').textContent = String(synced);
    byId('queuePending').textContent = String(pending);
    byId('queueFailed').textContent = String(failed);
    byId('pendingBadge').textContent = `Pending ${pending}`;
    byId('failedBadge').textContent = `Failed ${failed}`;
    const lastSync = storageGet(LAST_SYNC_KEY, '');
    byId('lastSyncBadge').textContent = lastSync ? `Last ${fmtTime(lastSync)}` : 'Never synced';
  }

  function recentRowsForDisplay() {
    return mergeRecentRows();
  }

  function renderHistoryRows() {
    const online = Boolean(state.session?.token && navigator.onLine);
    const hasDealer = Boolean(activeDealerCode());
    const rows = recentRowsForDisplay();
    const body = byId('scanRows');
    if (online && !hasDealer) {
      body.innerHTML = '<tr><td colspan="6">Waiting for dealer context...</td></tr>';
      return;
    }
    if (online && state.liveRecentRows === null && !sessionRows().length) {
      body.innerHTML = '<tr><td colspan="6">Loading live recent scans...</td></tr>';
      return;
    }
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="6">${online ? 'No active scans on server' : 'No scans yet'}</td></tr>`;
      return;
    }
    body.innerHTML = rows.map((row) => {
      const status = rowStatus(row);
      const statusLabel = status === 'failed-duplicate'
        ? 'Duplicate'
        : (status || 'pending').replace(/^./, (char) => char.toUpperCase());
      const time = fmtTime(row.mobileCreatedAt || row.timestamp || row.createdAt);
      const title = escapeHtml(row.syncError || '');
      return `
        <tr>
          <td>${escapeHtml(time)}</td>
          <td>${partLink(rowPart(row), {
            removeMode: rowStatus(row) === 'synced' ? (state.session?.role === 'admin' ? 'server' : '') : 'local',
            scanId: row.scanId || row.uniqueScanId || row.localId || '',
            dealerCode: row.dealerCode || activeDealerCode(),
            auditId: row.auditId || activeAuditId(),
            copyLabel: 'Part number',
            localOnly: rowStatus(row) !== 'synced',
            removeTitle: rowStatus(row) === 'synced'
              ? 'Remove part record from server'
              : 'Remove this local scan'
          })}</td>
          <td>${escapeHtml(fmtNumber(rowQty(row)))}</td>
          <td>${escapeHtml(rowMode(row))}</td>
          <td>${escapeHtml(rowBin(row) || '-')}</td>
          <td title="${title}">${escapeHtml(statusLabel)}</td>
      </tr>
      `;
    }).join('');
  }

  async function refreshLiveRecentScans({ force = false } = {}) {
    if (!state.session?.token) {
      state.liveRecentRows = null;
      renderHistoryRows();
      return [];
    }
    if (!activeDealerCode()) {
      state.liveRecentRows = null;
      renderHistoryRows();
      return [];
    }
    if (!navigator.onLine) {
      state.liveRecentRows = null;
      renderHistoryRows();
      return [];
    }
    if (!force && state.liveRecentRefreshPromise) return state.liveRecentRefreshPromise;
    const params = new URLSearchParams({
      dealerCode: activeDealerCode(),
      auditId: activeAuditId(),
      limit: '10'
    });
    const scopeKey = [activeDealerCode(), activeAuditId(), deviceId()].join('|');
    const requestToken = Number(state.liveRecentRefreshToken || 0) + 1;
    state.liveRecentRefreshToken = requestToken;
    const promise = (async () => {
      const data = await api(`/api/mobile/recent-scans?${params.toString()}`, {
        timeoutMs: Math.min(API_TIMEOUT_MS, 15000)
      });
      if (requestToken !== Number(state.liveRecentRefreshToken || 0) || scopeKey !== [activeDealerCode(), activeAuditId(), deviceId()].join('|')) {
        return mergeRecentRows();
      }
      const records = Array.isArray(data.records)
        ? data.records
        : Array.isArray(data.rows)
          ? data.rows
          : Array.isArray(data)
            ? data
            : [];
      state.liveRecentRows = records.slice(0, 10);
      updateLastScan(mergeRecentRows()[0] || null);
      renderHistoryRows();
      return mergeRecentRows();
    })();
    state.liveRecentRefreshPromise = promise;
    try {
      return await promise;
    } catch (error) {
      if (authExpired(error)) handleAuthExpired(error);
      return mergeRecentRows();
    } finally {
      if (state.liveRecentRefreshPromise === promise) {
        state.liveRecentRefreshPromise = null;
      }
    }
  }

  function renderAll() {
    renderUrlState();
    renderConnectionBadge();
    renderSessionHeader();
    renderServerSummary();
    renderModeButtons();
    renderModeMeta();
    renderModeFields();
    renderBinPanel();
    renderQueueBadgeCounts();
    renderHistoryRows();
  }

  function updateScannerPanel() {
    const loggedIn = Boolean(state.session?.token);
    document.body.classList.toggle('scanner-active', loggedIn);
    byId('loginPanel').classList.toggle('hidden', loggedIn);
    byId('scannerPanel').classList.toggle('hidden', !loggedIn);
    renderAll();
  }

  function cameraState(text) {
    byId('cameraState').textContent = text;
  }

  function cameraFrame() {
    return qs('.camera-frame');
  }

  function renderCameraControlState({ live = state.scanning, starting = false } = {}) {
    const button = byId('startScanBtn');
    if (!button) return;
    button.textContent = starting ? 'Starting...' : live ? 'Camera Off' : 'Camera On';
    button.disabled = Boolean(starting);
    button.setAttribute('aria-pressed', live ? 'true' : 'false');
  }

  function setCameraLive(live) {
    const frame = cameraFrame();
    if (frame) {
      frame.classList.toggle('camera-live', Boolean(live));
      frame.classList.toggle('camera-idle', !live);
      frame.classList.remove('camera-starting');
    }
    document.body.classList.toggle('camera-live', Boolean(live));
    renderCameraControlState({ live: Boolean(live), starting: false });
  }

  function setCameraStarting(starting) {
    const frame = cameraFrame();
    if (!frame) return;
    frame.classList.toggle('camera-starting', Boolean(starting));
    if (starting) frame.classList.remove('camera-live');
    renderCameraControlState({ live: false, starting: Boolean(starting) });
  }

  function bindVideoState(video) {
    if (!video || video.dataset.cameraStateBound === 'true') return;
    video.dataset.cameraStateBound = 'true';
    ['playing', 'loadeddata', 'canplay'].forEach((eventName) => {
      video.addEventListener(eventName, () => {
        if (state.scanning && video.srcObject) {
          setCameraStarting(false);
          setCameraLive(true);
        }
      });
    });
    ['emptied', 'error'].forEach((eventName) => {
      video.addEventListener(eventName, () => setCameraLive(false));
    });
  }

  function cameraConstraints() {
    const video = {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280, min: 640 },
      height: { ideal: 720, min: 480 },
      frameRate: { ideal: 30, min: 15, max: 45 },
      advanced: [
        { focusMode: 'continuous' },
        { exposureMode: 'continuous' },
        { whiteBalanceMode: 'continuous' }
      ]
    };
    return { audio: false, video };
  }

  function stopNativeDetector() {
    state.nativeDetectorRunning = false;
    state.nativeDetectorRunId += 1;
    if (state.nativeDetectorTimer) clearTimeout(state.nativeDetectorTimer);
    const video = byId('cameraPreview');
    if (state.nativeDetectorFrame) {
      if (video && typeof video.cancelVideoFrameCallback === 'function') {
        try {
          video.cancelVideoFrameCallback(state.nativeDetectorFrame);
        } catch (_) {}
      } else if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(state.nativeDetectorFrame);
      }
    }
    state.nativeDetectorTimer = null;
    state.nativeDetectorFrame = null;
  }

  async function nativeBarcodeDetector() {
    if (!('BarcodeDetector' in window)) return null;
    if (state.nativeDetector) return state.nativeDetector;
    if (state.nativeDetectorPromise) return state.nativeDetectorPromise;
    state.nativeDetectorPromise = Promise.resolve()
      .then(async () => {
        const supported = typeof window.BarcodeDetector.getSupportedFormats === 'function'
          ? await window.BarcodeDetector.getSupportedFormats()
          : NATIVE_DETECTOR_FORMATS;
        const formats = NATIVE_DETECTOR_FORMATS.filter((format) => supported.includes(format));
        if (!formats.length) return null;
        return new window.BarcodeDetector({ formats });
      })
      .then((detector) => {
        state.nativeDetector = detector;
        return detector;
      })
      .catch(() => null)
      .finally(() => {
        state.nativeDetectorPromise = null;
      });
    return state.nativeDetectorPromise;
  }

  function nativeBarcodeText(code = {}) {
    return clean(code.rawValue || code.rawText || code.displayValue || code.text || '');
  }

  function scheduleNativeDetection(video, runId, delay = 45) {
    if (!state.nativeDetectorRunning || runId !== state.nativeDetectorRunId) return;
    state.nativeDetectorTimer = setTimeout(() => {
      if (!state.nativeDetectorRunning || runId !== state.nativeDetectorRunId) return;
      if (typeof video?.requestVideoFrameCallback === 'function') {
        state.nativeDetectorFrame = video.requestVideoFrameCallback(() => detectNativeFrame(video, runId));
      } else if (typeof requestAnimationFrame === 'function') {
        state.nativeDetectorFrame = requestAnimationFrame(() => detectNativeFrame(video, runId));
      } else {
        detectNativeFrame(video, runId);
      }
    }, delay);
  }

  async function detectNativeFrame(video, runId) {
    if (!state.nativeDetectorRunning || runId !== state.nativeDetectorRunId || !video || video.paused || video.ended) return;
    try {
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        const detector = await nativeBarcodeDetector();
        if (detector && state.nativeDetectorRunning && runId === state.nativeDetectorRunId) {
          const codes = await detector.detect(video);
          const raw = nativeBarcodeText(codes && codes[0]);
          if (raw) handleDecodeResult({ text: raw, rawValue: raw });
        }
      }
    } catch (_) {
      // Native detector support varies by browser; ZXing remains the main fallback.
    }
    scheduleNativeDetection(video, runId, 45);
  }

  async function startNativeDetector(video) {
    if (!('BarcodeDetector' in window)) return;
    const runId = state.nativeDetectorRunId + 1;
    state.nativeDetectorRunId = runId;
    state.nativeDetectorRunning = true;
    const detector = await nativeBarcodeDetector();
    if (!detector || !state.nativeDetectorRunning || runId !== state.nativeDetectorRunId) return;
    scheduleNativeDetection(video, runId, 30);
  }

  function stopCamera({ preserveRequest = false } = {}) {
    state.cameraRunId += 1;
    stopNativeDetector();
    if (state.scanReader) {
      try {
        state.scanReader.stopContinuousDecode();
      } catch (_) {}
      try {
        state.scanReader.reset();
      } catch (_) {}
    }
    if (state.cameraStream) {
      try {
        state.cameraStream.getTracks().forEach((track) => track.stop());
      } catch (_) {}
      state.cameraStream = null;
    }
    const video = byId('cameraPreview');
    if (video) {
      try {
        video.pause();
      } catch (_) {}
      video.srcObject = null;
    }
    setCameraLive(false);
    clearTimeout(state.cameraTimer);
    clearTimeout(state.zxingRestartTimer);
    state.cameraTimer = null;
    state.zxingRestartTimer = null;
    state.scanning = false;
    if (!preserveRequest) {
      state.cameraRequested = false;
    }
    cameraState(preserveRequest ? 'Camera stopped' : 'Camera off');
  }

  async function loadZxingLibrary() {
    if (window.ZXing?.BrowserMultiFormatReader && window.ZXing?.DecodeHintType && window.ZXing?.BarcodeFormat) {
      return window.ZXing;
    }
    if (state.zxingPromise) return state.zxingPromise;
    state.zxingPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-zxing-loader="true"]');
      if (existing) {
        if (window.ZXing?.BrowserMultiFormatReader && window.ZXing?.DecodeHintType && window.ZXing?.BarcodeFormat) {
          resolve(window.ZXing);
          return;
        }
        existing.addEventListener('load', () => resolve(window.ZXing), { once: true });
        existing.addEventListener('error', () => reject(new Error('ZXing scanner library failed to load')), { once: true });
        return;
      }

      const script = document.createElement('script');
      script.src = ZXING_SCRIPT_SRC;
      script.async = true;
      script.dataset.zxingLoader = 'true';
      script.onload = () => {
        if (window.ZXing?.BrowserMultiFormatReader && window.ZXing?.DecodeHintType && window.ZXing?.BarcodeFormat) {
          resolve(window.ZXing);
          return;
        }
        reject(new Error('ZXing scanner library failed to load'));
      };
      script.onerror = () => reject(new Error('ZXing scanner library failed to load'));
      document.head.appendChild(script);
    }).catch((error) => {
      state.zxingPromise = null;
      throw error;
    });
    return state.zxingPromise;
  }

  async function ensureReader() {
    const ZX = await loadZxingLibrary();
    const BrowserMultiFormatReader = ZX?.BrowserMultiFormatReader;
    const DecodeHintType = ZX?.DecodeHintType;
    const BarcodeFormat = ZX?.BarcodeFormat;
    if (!BrowserMultiFormatReader || !DecodeHintType || !BarcodeFormat) {
      throw new Error('ZXing scanner library failed to load');
    }
    if (state.scanReader) return state.scanReader;
    const hints = new Map();
    const formats = [
      BarcodeFormat.QR_CODE,
      BarcodeFormat.DATA_MATRIX,
      BarcodeFormat.CODE_128,
      BarcodeFormat.CODE_39,
      BarcodeFormat.EAN_13,
      BarcodeFormat.EAN_8,
      BarcodeFormat.UPC_A,
      BarcodeFormat.UPC_E,
      BarcodeFormat.ITF,
      BarcodeFormat.CODABAR,
      BarcodeFormat.PDF_417,
      BarcodeFormat.AZTEC
    ].filter(Boolean);
    hints.set(DecodeHintType.POSSIBLE_FORMATS, formats);
    hints.set(DecodeHintType.TRY_HARDER, true);
    state.scanReader = new BrowserMultiFormatReader(hints, 45);
    state.scanReader.timeBetweenDecodingAttempts = 45;
    return state.scanReader;
  }

  async function enableCameraFocus(video) {
    try {
      const stream = video?.srcObject;
      const track = stream?.getVideoTracks?.()[0];
      if (!track?.getCapabilities || !track?.applyConstraints) return;
      const capabilities = track.getCapabilities();
      const focusModes = Array.isArray(capabilities.focusMode) ? capabilities.focusMode : [];
      const advanced = [];
      if (focusModes.includes('continuous')) {
        advanced.push({ focusMode: 'continuous' });
      } else if (focusModes.includes('single-shot')) {
        advanced.push({ focusMode: 'single-shot' });
      }
      const exposureModes = Array.isArray(capabilities.exposureMode) ? capabilities.exposureMode : [];
      if (exposureModes.includes('continuous')) advanced.push({ exposureMode: 'continuous' });
      const whiteBalanceModes = Array.isArray(capabilities.whiteBalanceMode) ? capabilities.whiteBalanceMode : [];
      if (whiteBalanceModes.includes('continuous')) advanced.push({ whiteBalanceMode: 'continuous' });
      if (advanced.length) await track.applyConstraints({ advanced });
    } catch (_) {}
  }

  function currentCameraTrack(video = byId('cameraPreview')) {
    return video?.srcObject?.getVideoTracks?.()[0] || null;
  }

  async function applyTapToFocus(event, video = byId('cameraPreview')) {
    try {
      const track = currentCameraTrack(video);
      if (!track?.getCapabilities || !track?.applyConstraints) return false;
      const capabilities = track.getCapabilities();
      const advanced = [];
      if (Array.isArray(capabilities.focusMode)) {
        if (capabilities.focusMode.includes('single-shot')) {
          advanced.push({ focusMode: 'single-shot' });
        } else if (capabilities.focusMode.includes('continuous')) {
          advanced.push({ focusMode: 'continuous' });
        }
      }
      const rect = video?.getBoundingClientRect ? video.getBoundingClientRect() : null;
      const supportsPointing = Boolean(
        rect &&
        Number(rect.width) > 0 &&
        Number(rect.height) > 0 &&
        (capabilities.pointsOfInterest || capabilities.focusPointOfInterest)
      );
      if (supportsPointing && event) {
        const clientX = Number(event.clientX || event.touches?.[0]?.clientX || 0);
        const clientY = Number(event.clientY || event.touches?.[0]?.clientY || 0);
        const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        const y = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
        advanced.push({ pointsOfInterest: [{ x, y }] });
      }
      if (!advanced.length) return false;
      await track.applyConstraints({ advanced });
      return true;
    } catch (_) {
      return false;
    }
  }

  function bindCameraTapToFocus(video = byId('cameraPreview')) {
    const frame = cameraFrame();
    if (!frame || frame.dataset.tapFocusBound === 'true') return;
    frame.dataset.tapFocusBound = 'true';
    const tapToFocus = (event) => {
      if (!state.scanning || state.paused) return;
      void applyTapToFocus(event, video).catch(() => undefined);
    };
    frame.addEventListener('pointerup', tapToFocus);
    frame.addEventListener('click', tapToFocus);
  }

  function createScanRecord({ rawText = '', manual = false, partNumber = '', qty = 1, binLocation = '', regdNo = '', jobCardNo = '' } = {}) {
    const timestamp = nowIso();
    const scanType = currentScanType();
    const part = normalizeText(partNumber || parsePartCandidate(rawText));
    const scanId = `SCAN-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`.toUpperCase();
    const uniqueLocalId = scanId;
    const sourceType = manual ? 'manual' : 'mobile';
    const record = {
      scanId,
      uniqueScanId: scanId,
      uniqueLocalId,
      clientScanId: scanId,
      localId: scanId,
      syncKey: scanId,
      clientSyncKey: scanId,
      rawScanString: rawText,
      rawScan: rawText,
      rawBarcode: rawText,
      rawUpi: rawText,
      rawQR: rawText,
      rawParsedValue: rawText,
      parsedRawScan: rawText,
      parsedPartNumber: part,
      partNumber: part,
      normalizedPartNumber: part,
      part: part,
      qty: scanType === 'VERIFICATION' ? 1 : Number(qty || 1) || 1,
      quantity: scanType === 'VERIFICATION' ? 1 : Number(qty || 1) || 1,
      mrp: undefined,
      dlc: undefined,
      manualMRP: undefined,
      mrpProvided: false,
      dlcProvided: false,
      binLocation: upper(binLocation),
      bin: upper(binLocation),
      regdNo: upper(regdNo),
      jobCardNo: upper(jobCardNo),
      dealerCode: activeDealerCode(),
      dealerName: activeDealerName(),
      auditId: activeAuditId(),
      upiCode: extractUpiIdFromText({ rawScanString: rawText, rawScan: rawText }) || '',
      deviceId: deviceId(),
      deviceName: clean(state.session?.deviceName || DEFAULT_DEVICE_NAME),
      userId: clean(state.session?.user?.id || ''),
      loginId: clean(state.session?.user?.username || state.session?.loginId || ''),
      userName: clean(state.session?.user?.name || state.session?.user?.username || state.session?.userName || ''),
      staffName: clean(state.session?.user?.name || state.session?.user?.username || state.session?.staffName || ''),
      role: clean(state.session?.user?.role || state.session?.role || ''),
      scanType,
      type: scanType,
      movementType: scanType,
      activeInventory: scanType === 'INWARD',
      remainingQty: scanType === 'INWARD' ? Math.abs(Number(qty || 1) || 1) : 0,
      scanSource: sourceType,
      source: { source: sourceType, scanSource: sourceType },
      entryMode: manual ? 'manual' : 'camera',
      entryChannel: 'web',
      appVersion: APP_VERSION,
      scanPayloadVersion: 2,
      smartBinEnabled: false,
      smartBinDecision: '',
      smartBinReason: '',
      smartBinSuggestedBin: '',
      smartBinSelectedBin: upper(binLocation),
      smartBinCurrentBin: upper(binLocation),
      smartBinExistingBins: [],
      smartBinAllowMultipleLocations: undefined,
      smartBinMaxAllowedLocationsPerPart: undefined,
      smartBinReasonRequired: undefined,
      allowCrossBinDuplicate: false,
      smartBinCheckedAt: '',
      smartBinDecisionAt: '',
      smartBinDecisionBy: '',
      smartBinAuditTrail: {},
      serverUrl: window.location.origin.replace(/\/+$/, ''),
      timestamp,
      scanTime: timestamp,
      mobileCreatedAt: timestamp,
      mobileReceivedTime: timestamp,
      mobileReceivedTimeUtc: timestamp,
      createdAt: timestamp,
      status: 'pending',
      syncStatus: 'pending',
      syncError: '',
      retryCount: 0
    };
    if (scanType === 'FITTED' && manual) {
      record.isFitted = true;
      record.fittedQty = record.qty;
      record.fittedLocation = 'VEHICLE';
    }
    return record;
  }

  function applySmartBinDecisionToRecord(record = {}, suggestion = {}, decision = {}) {
    const currentBin = clean(record.binLocation || record.bin || suggestion.currentBin || '');
    const selectedBin = clean(decision.selectedBin || decision.currentBin || suggestion.suggestedBin || suggestion.primaryBin || currentBin || '');
    const normalizedAction = clean(decision.action || '').toUpperCase();
    const finalBin = ['USE_EXISTING', 'USE_EXISTING_BIN'].includes(normalizedAction) && selectedBin ? selectedBin : currentBin;
    const existingBins = Array.isArray(decision.existingBins)
      ? decision.existingBins
      : Array.isArray(suggestion.existingBins)
        ? suggestion.existingBins
        : [];
    const decisionAt = decision.decisionAt || nowIso();
    const checkedAt = decision.checkedAt || suggestion.checkedAt || nowIso();
    const decisionBy = clean(decision.decisionBy || state.session?.user?.name || state.session?.user?.username || state.session?.user?.email || '');
    const trail = {
      enabled: true,
      decision: clean(decision.action || ''),
      reason: clean(decision.reason || ''),
      suggestedBin: clean(suggestion.suggestedBin || suggestion.primaryBin || selectedBin || currentBin || ''),
      selectedBin: finalBin,
      currentBin,
      existingBins,
      checkedAt,
      decisionAt,
      decisionBy
    };
    if (finalBin) setActiveBin(finalBin);
    return {
      ...record,
      binLocation: finalBin,
      bin: finalBin,
      allowCrossBinDuplicate: normalizedAction === 'SAVE_NEW_BIN',
      smartBinEnabled: true,
      smartBinDecision: normalizedAction || '',
      smartBinReason: normalizedAction === 'SAVE_NEW_BIN'
        ? 'User confirmed different bin'
        : clean(decision.reason || 'User selected existing bin'),
      smartBinSuggestedBin: clean(suggestion.suggestedBin || suggestion.primaryBin || currentBin || ''),
      smartBinSelectedBin: finalBin,
      smartBinCurrentBin: currentBin,
      smartBinExistingBins: existingBins,
      smartBinAllowMultipleLocations: suggestion.allowMultipleLocations === undefined ? true : Boolean(suggestion.allowMultipleLocations),
      smartBinMaxAllowedLocationsPerPart: Math.max(1, Number.parseInt(String(suggestion.maxAllowedLocationsPerPart ?? 3), 10) || 3),
      smartBinReasonRequired: Boolean(suggestion.reasonRequired ?? suggestion.requireReason ?? true),
      smartBinCheckedAt: checkedAt,
      smartBinDecisionAt: decisionAt,
      smartBinDecisionBy: decisionBy,
      smartBinLocationType: normalizedAction === 'SAVE_NEW_BIN' ? 'SECONDARY' : 'PRIMARY',
      smartBinIsSecondaryLocation: normalizedAction === 'SAVE_NEW_BIN',
      smartBinAuditTrail: trail
    };
  }

  function partMasterCacheKey(partNumber = '', dealerCode = activeDealerCode()) {
    const part = normalizePartCandidateValue(partNumber);
    const dealer = upper(dealerCode || activeDealerCode());
    return part ? `${dealer || 'ALL'}::${part}` : '';
  }

  function partMasterFieldsFromLookup(data = {}) {
    const partDescription = clean(data.partDescription || data.partName || data.description || '');
    const productCategory = clean(data.productCategory || data.category || '');
    const productGroup = clean(data.productGroup || '');
    const partSubGroup = clean(data.partSubGroup || '');
    const model = clean(data.model || '');
    const year = clean(data.year || data.manufacturingYear || '');
    const manufacturingYear = clean(data.manufacturingYear || data.year || '');
    const mrp = Number(data.mrp || 0);
    const dlc = Number(data.dlc || 0);
    return {
      partName: partDescription,
      partDescription,
      description: partDescription,
      category: productCategory,
      productCategory,
      productGroup,
      partSubGroup,
      model,
      year,
      manufacturingYear,
      mrp,
      currentCatalogueMRP: mrp,
      displayMRP: mrp,
      valuationMRP: mrp,
      dlc,
      currentCatalogueDLC: dlc,
      masterFound: true,
      masterMatch: true,
      isMasterMatched: true,
      valuationSource: mrp > 0 ? 'PART_MASTER_MRP_DLC' : 'PART_MASTER_PRICE_MISSING'
    };
  }

  function mergeMasterFields(record = {}, masterFields = null) {
    if (!masterFields) return record;
    const partDescription = clean(masterFields.partDescription || masterFields.partName || record.partDescription || record.partName || '');
    return {
      ...record,
      ...masterFields,
      partName: partDescription || record.partName || '',
      partDescription: partDescription || record.partDescription || '',
      description: partDescription || record.description || '',
      category: masterFields.category || record.category || '',
      productCategory: masterFields.productCategory || record.productCategory || '',
      productGroup: masterFields.productGroup || record.productGroup || '',
      partSubGroup: masterFields.partSubGroup || record.partSubGroup || '',
      model: masterFields.model || record.model || '',
      year: masterFields.year || record.year || '',
      manufacturingYear: masterFields.manufacturingYear || record.manufacturingYear || '',
      mrp: Number(masterFields.mrp ?? record.mrp ?? 0),
      currentCatalogueMRP: Number(masterFields.currentCatalogueMRP ?? record.currentCatalogueMRP ?? masterFields.mrp ?? record.mrp ?? 0),
      displayMRP: Number(masterFields.displayMRP ?? record.displayMRP ?? masterFields.mrp ?? record.currentCatalogueMRP ?? record.mrp ?? 0),
      valuationMRP: Number(masterFields.valuationMRP ?? record.valuationMRP ?? masterFields.mrp ?? record.mrp ?? 0),
      dlc: Number(masterFields.dlc ?? record.dlc ?? 0),
      currentCatalogueDLC: Number(masterFields.currentCatalogueDLC ?? record.currentCatalogueDLC ?? masterFields.dlc ?? record.dlc ?? 0),
      masterFound: true,
      masterMatch: true,
      isMasterMatched: true
    };
  }

  function smartBinPreflightEligible(record = {}) {
    const scanType = upper(record.scanType || record.type || currentScanType());
    return ['INWARD', 'DAMAGE', 'AUDIT'].includes(scanType)
      && Boolean(clean(record.dealerCode || activeDealerCode()))
      && Boolean(clean(record.auditId || activeAuditId()))
      && Boolean(clean(record.partNumber || record.part || ''))
      && Boolean(clean(record.binLocation || record.bin || ''));
  }

  async function preflightSmartBinDecision(record = {}) {
    const normalized = { ...record };
    if (clean(normalized.smartBinDecision || '')) return normalized;

    if (smartBinPreflightEligible(normalized) && navigator.onLine && state.session?.token) {
      await refreshLiveRecentScans({ force: true, reason: 'smart-bin-preflight' }).catch(() => undefined);
      try {
        const suggestion = await api('/api/scans/smart-bin-check', {
          method: 'POST',
          body: {
            dealerCode: normalized.dealerCode || activeDealerCode(),
            auditId: normalized.auditId || activeAuditId(),
            partNumber: normalized.partNumber || normalized.part || '',
            partDescription: normalized.partDescription || normalized.partName || '',
            binLocation: normalized.binLocation || normalized.bin || '',
            scanType: normalized.scanType || normalized.type || currentScanType(),
            qty: normalized.qty ?? normalized.quantity ?? 1,
            refresh: true
          },
          timeoutMs: 5500,
          cache: 'no-store'
        });
        if (suggestion && suggestion.shouldPrompt) {
          const decision = await openSmartBinSuggestionModal({
            ...suggestion,
            currentBin: suggestion.currentBin || normalized.binLocation || normalized.bin || '',
            reasonRequired: Boolean(suggestion.reasonRequired ?? suggestion.requireReason ?? true)
          });
          if (!decision) return null;
          return applySmartBinDecisionToRecord(normalized, suggestion, decision);
        }
        return normalized;
      } catch (error) {
        console.warn('[SMART BIN] server preflight skipped', error.message);
      }
    }

    const localSmartBinSuggestion = buildLocalSmartBinSuggestion(normalized);
    if (localSmartBinSuggestion?.shouldPrompt) {
      const decision = await openSmartBinSuggestionModal({
        ...localSmartBinSuggestion,
        currentBin: localSmartBinSuggestion.currentBin || normalized.binLocation || normalized.bin || '',
        newBin: localSmartBinSuggestion.newBin || normalized.binLocation || normalized.bin || '',
        existingBin: localSmartBinSuggestion.existingBin || (Array.isArray(localSmartBinSuggestion.existingBins) && localSmartBinSuggestion.existingBins[0] && localSmartBinSuggestion.existingBins[0].binLocation) || ''
      });
      if (!decision) return null;
      return applySmartBinDecisionToRecord(normalized, localSmartBinSuggestion, decision);
    }

    return normalized;
  }

  async function preflightDuplicateDecision(record = {}) {
    const normalized = { ...record };
    if (rowMode(normalized) === 'VERIFICATION') return normalized;

    if (navigator.onLine && state.session?.token) {
      await refreshLiveRecentScans({ force: true, reason: 'duplicate-preflight' }).catch(() => undefined);
      const result = await checkBackendDuplicateBeforeSync(normalized, { timeoutMs: 5000 });
      if (result?.duplicate) {
        const existing = result.existing || normalized;
        showDuplicateOnce(normalized, existing, result.message || duplicateScanMessage(existing));
        cameraState('Duplicate blocked');
        return null;
      }
      if (!result?.checkedOnline) {
        const localExisting = localDuplicateForRecord(normalized);
        if (localExisting) {
          showDuplicateOnce(normalized, localExisting, duplicateScanMessage(localExisting));
          cameraState('Duplicate blocked');
          return null;
        }
      }
      return normalized;
    }

    const localExisting = localDuplicateForRecord(normalized);
    if (localExisting) {
      showDuplicateOnce(normalized, localExisting, duplicateScanMessage(localExisting));
      cameraState('Duplicate blocked');
      return null;
    }

    return normalized;
  }

  function mergeStoredRecordWithServer(record = {}, serverScan = {}, extra = {}) {
    const rawScan = clean(
      record.rawScanString ||
      record.rawScan ||
      record.rawBarcode ||
      record.rawUpi ||
      record.rawQR ||
      serverScan.rawScanString ||
      serverScan.rawScan ||
      serverScan.rawBarcode ||
      serverScan.rawUpi ||
      serverScan.rawQR ||
      ''
    );
    const partNumber = normalizePartCandidateValue(
      serverScan.partNumber ||
      serverScan.normalizedPartNumber ||
      serverScan.part ||
      record.partNumber ||
      record.normalizedPartNumber ||
      record.part ||
      ''
    );
    const partDescription = clean(
      serverScan.partDescription ||
      serverScan.partName ||
      serverScan.description ||
      record.partDescription ||
      record.partName ||
      ''
    );
    const productCategory = clean(
      serverScan.productCategory ||
      serverScan.category ||
      record.productCategory ||
      record.category ||
      ''
    );
    const timestamp = clean(serverScan.timestamp || serverScan.scanTime || record.timestamp || record.scanTime || nowIso());
    const scanTime = clean(serverScan.scanTime || timestamp || record.scanTime || record.timestamp || nowIso());
    return {
      ...record,
      ...serverScan,
      ...extra,
      scanId: clean(serverScan.scanId || serverScan.uniqueScanId || record.scanId),
      uniqueScanId: clean(serverScan.uniqueScanId || serverScan.scanId || record.uniqueScanId || record.scanId),
      clientScanId: record.clientScanId || record.scanId,
      localId: record.localId || record.scanId,
      syncKey: record.syncKey || record.scanId,
      clientSyncKey: record.clientSyncKey || record.syncKey || record.scanId,
      rawScanString: rawScan,
      rawScan,
      rawBarcode: record.rawBarcode || serverScan.rawBarcode || rawScan,
      rawUpi: record.rawUpi || serverScan.rawUpi || rawScan,
      rawQR: record.rawQR || serverScan.rawQR || rawScan,
      rawParsedValue: record.rawParsedValue || rawScan,
      parsedRawScan: record.parsedRawScan || rawScan,
      parsedPartNumber: partNumber,
      partNumber,
      normalizedPartNumber: clean(serverScan.normalizedPartNumber || partNumber || record.normalizedPartNumber || record.partNumber || record.part || ''),
      part: clean(serverScan.part || serverScan.partNumber || record.part || partNumber),
      partName: partDescription || clean(serverScan.partName || record.partName || ''),
      partDescription: partDescription || clean(serverScan.partDescription || record.partDescription || ''),
      description: partDescription || clean(serverScan.description || record.description || ''),
      productCategory,
      category: clean(serverScan.category || serverScan.productCategory || record.category || ''),
      qty: serverScan.qty ?? serverScan.quantity ?? record.qty,
      quantity: serverScan.quantity ?? serverScan.qty ?? record.quantity,
      mrp: serverScan.mrp ?? record.mrp,
      dlc: serverScan.dlc ?? serverScan.currentCatalogueDLC ?? record.dlc,
      currentCatalogueMRP: serverScan.currentCatalogueMRP ?? serverScan.mrp ?? record.currentCatalogueMRP ?? record.mrp,
      currentCatalogueDLC: serverScan.currentCatalogueDLC ?? serverScan.dlc ?? record.currentCatalogueDLC ?? record.dlc,
      valuationMRP: serverScan.valuationMRP ?? record.valuationMRP,
      valuationSource: serverScan.valuationSource ?? record.valuationSource,
      finalInventoryValue: serverScan.finalInventoryValue ?? record.finalInventoryValue,
      scanType: upper(serverScan.scanType || serverScan.type || record.scanType || record.type || currentScanType()),
      type: upper(serverScan.type || serverScan.scanType || record.type || record.scanType || currentScanType()),
      movementType: upper(serverScan.movementType || serverScan.scanType || serverScan.type || record.movementType || record.scanType || record.type || currentScanType()),
      activeInventory: serverScan.activeInventory !== undefined
        ? Boolean(serverScan.activeInventory)
        : (record.activeInventory !== undefined ? Boolean(record.activeInventory) : upper(serverScan.scanType || serverScan.type || record.scanType || record.type || currentScanType()) === 'INWARD'),
      remainingQty: serverScan.remainingQty !== undefined
        ? serverScan.remainingQty
        : (record.remainingQty !== undefined ? record.remainingQty : (upper(serverScan.scanType || serverScan.type || record.scanType || record.type || currentScanType()) === 'INWARD' ? (Number(record.qty ?? record.quantity ?? 1) || 1) : 0)),
      status: extra.status || serverScan.status || record.status || 'synced',
      syncStatus: extra.syncStatus || serverScan.syncStatus || record.syncStatus || 'synced',
      syncError: extra.syncError ?? serverScan.syncError ?? record.syncError ?? '',
      retryCount: extra.retryCount ?? serverScan.retryCount ?? record.retryCount ?? 0,
      serverAck: extra.serverAck || serverScan,
      timestamp,
      scanTime,
      createdAt: record.createdAt || timestamp,
      mobileCreatedAt: record.mobileCreatedAt || timestamp,
      mobileReceivedTime: record.mobileReceivedTime || timestamp,
      mobileReceivedTimeUtc: record.mobileReceivedTimeUtc || timestamp,
      serverUrl: record.serverUrl || serverScan.serverUrl || window.location.origin.replace(/\/+$/, '')
    };
  }

  async function lookupMasterFields(partNumber = '', dealerCode = activeDealerCode()) {
    const part = normalizePartCandidateValue(partNumber);
    const key = partMasterCacheKey(part, dealerCode);
    if (!key) return null;
    if (state.partMasterCache.has(key)) return state.partMasterCache.get(key);
    if (state.partMasterLookupPromise.has(key)) return state.partMasterLookupPromise.get(key);
    if (!navigator.onLine) return null;
    const promise = api(`/api/mobile/validate-part?${new URLSearchParams({
      partNumber: part,
      dealerCode: upper(dealerCode || activeDealerCode())
    }).toString()}`, { timeoutMs: 10000 })
      .then((data) => {
        const fields = data && data.found ? partMasterFieldsFromLookup(data) : null;
        state.partMasterCache.set(key, fields);
        return fields;
      })
      .catch((error) => {
        state.partMasterCache.delete(key);
        throw error;
      })
      .finally(() => {
        state.partMasterLookupPromise.delete(key);
      });
    state.partMasterLookupPromise.set(key, promise);
    return promise;
  }

  async function validatePartBeforeSave(partNumber = '', dealerCode = activeDealerCode()) {
    const normalizedPart = normalizePartCandidateValue(partNumber);
    if (!isValidPartCandidate(normalizedPart)) {
      throw new Error('Invalid part number format');
    }
    if (!state.session?.token || !navigator.onLine) {
      return null;
    }
    try {
      const masterFields = await lookupMasterFields(normalizedPart, dealerCode);
      if (!masterFields) {
        throw new Error('Invalid part number - not found in master catalogue');
      }
      return masterFields;
    } catch (error) {
      if (isRetryableTransportError(error)) return null;
      throw error;
    }
  }

  async function enrichStoredRecord(record = {}) {
    const partNumber = normalizePartCandidateValue(record.partNumber || record.part || record.normalizedPartNumber || '');
    if (!partNumber) return null;
    const existingDescription = clean(record.partDescription || record.partName || '');
    const existingMrp = Number(record.currentCatalogueMRP ?? record.displayMRP ?? record.valuationMRP ?? record.mrp ?? 0);
    const existingDlc = Number(record.currentCatalogueDLC ?? record.dlc ?? 0);
    if (existingDescription && existingMrp > 0 && existingDlc > 0) return null;
    const masterFields = await lookupMasterFields(partNumber, record.dealerCode || activeDealerCode()).catch(() => null);
    if (!masterFields) return null;
    const latest = await getRecord(record.scanId).catch(() => null);
    const next = mergeMasterFields(latest || record, masterFields);
    await putRecord(next);
    upsertStateRow(next);
    applyRecordToUi(next);
    return next;
  }

  function updateLastScan(row = {}) {
    if (!row || !Object.keys(row).length) {
      byId('lastScanTitle').textContent = 'No recent scan';
      byId('lastScanMeta').textContent = 'Live recent scans will appear here.';
      byId('lastScanStatus').textContent = 'Ready to scan';
      byId('lastScanSync').textContent = '';
      byId('lastScanSync').hidden = true;
      return;
    }
    const part = rowPart(row);
    const description = clean(row.partDescription || row.partName || '');
    const mode = rowMode(row);
    const status = rowStatus(row);
    const qty = rowQty(row);
    const bin = rowBin(row);
    const mrp = Number(row.currentCatalogueMRP ?? row.displayMRP ?? row.valuationMRP ?? row.mrp ?? 0);
    const errorText = clean(row.syncError || row.errorMessage || row.reason || '');
    const networkPending = /network|timeout|timed out|offline|failed to fetch|connection|request timed out/i.test(errorText) || (!navigator.onLine && status === 'pending');
    const statusText = status === 'synced'
      ? 'Synced'
      : status === 'pending'
        ? (networkPending ? 'Network pending' : 'Queued')
      : status === 'duplicate' || status === 'failed-duplicate'
        ? 'Duplicate'
      : status === 'rejected' || status === 'invalid'
          ? 'Rejected'
      : status === 'failed'
          ? (networkPending ? 'Network pending' : `Failed${errorText ? `: ${errorText}` : ''}`)
          : 'Queued';
    const syncText = status === 'duplicate' || status === 'failed-duplicate'
      ? 'Synced'
      : status === 'pending'
        ? (networkPending ? 'Network pending' : 'Saved locally')
        : status === 'synced'
          ? ''
          : '';
    byId('lastScanTitle').textContent = description || part || 'Scan captured';
    byId('lastScanMeta').textContent = [
      part ? `Part ${part}` : '',
      mode,
      `Qty ${fmtNumber(qty)}`,
      bin ? `Bin ${bin}` : '',
      mrp > 0 ? `MRP ${fmtNumber(mrp)}` : ''
    ].filter(Boolean).join(' · ');
    byId('lastScanStatus').textContent = statusText;
    byId('lastScanSync').textContent = syncText;
    byId('lastScanSync').hidden = !syncText;
  }

  function applyRecordToUi(record) {
    updateLastScan(record);
    renderQueueBadgeCounts();
    renderHistoryRows();
  }

  async function saveRecord(record, { silent = false, deferSync = false } = {}) {
    await putRecord(record);
    upsertStateRow(record);
    applyRecordToUi(record);
    void enrichStoredRecord(record).catch(() => undefined);
    if (!silent) {
      toast(navigator.onLine ? 'Queued' : 'Network pending', navigator.onLine ? 'success' : 'warning');
      beep('ok');
      vibrate(40);
    }
    if (!deferSync && navigator.onLine && state.session?.token) scheduleSync();
  }

  function scheduleSync(delay = 250) {
    if (!navigator.onLine || !state.session?.token) return;
    clearTimeout(state.syncDelayTimer);
    state.syncDelayTimer = setTimeout(() => {
      syncQueue({ silent: true }).catch(() => undefined);
    }, delay);
  }

  function recordStatusCounts(rows) {
    const statuses = rows.map((row) => rowStatus(row));
    const pending = statuses.filter((status) => status === 'pending').length;
    const synced = statuses.filter((status) => status === 'synced').length;
    const failed = statuses.filter((status) => ['failed', 'failed-duplicate', 'invalid', 'duplicate', 'rejected'].includes(status)).length;
    return { total: rows.length, pending, synced, failed };
  }

  function syncIdentityKeys(row = {}) {
    const values = [
      row.uniqueLocalId,
      row.scanId,
      row.uniqueScanId,
      row.clientScanId,
      row.localId,
      row.mobileScanId,
      row.syncKey,
      row.clientSyncKey,
      row.localSyncKey,
      row.offlineScanId,
      row.offlineId
    ];
    const upi = extractUpiIdFromText(row);
    if (upi) values.push(`UPI:${upi}`);
    const scoped = scanIdentityKey(row);
    if (scoped) values.push(scoped);
    return Array.from(new Set(values.map((value) => clean(value)).filter(Boolean)));
  }

  function putIdentity(map, row = {}, value) {
    syncIdentityKeys(row).forEach((key) => map.set(key, value));
  }

  function identityValue(map, row = {}) {
    for (const key of syncIdentityKeys(row)) {
      if (map.has(key)) return map.get(key);
    }
    return undefined;
  }

  function convertToSyncPayload(row = {}) {
    const timestamp = row.timestamp || row.scanTime || row.mobileCreatedAt || nowIso();
    return {
      uniqueLocalId: row.uniqueLocalId || row.scanId,
      scanId: row.scanId,
      uniqueScanId: row.uniqueScanId || row.scanId,
      clientScanId: row.clientScanId || row.scanId,
      localId: row.localId || row.scanId,
      mobileScanId: row.mobileScanId || row.scanId,
      syncKey: row.syncKey || row.scanId,
      clientSyncKey: row.clientSyncKey || row.syncKey || row.scanId,
      rawScanString: row.rawScanString || row.rawScan || row.rawUpi || '',
      rawScan: row.rawScan || row.rawScanString || row.rawUpi || '',
      rawBarcode: row.rawBarcode || row.rawScanString || row.rawUpi || '',
      rawUpi: row.rawUpi || row.rawScanString || row.rawScan || '',
      rawQR: row.rawQR || row.rawScanString || row.rawScan || '',
      rawParsedValue: row.rawParsedValue || row.rawScanString || row.rawScan || row.rawUpi || '',
      parsedRawScan: row.parsedRawScan || row.rawScanString || row.rawScan || row.rawUpi || '',
      parsedPartNumber: row.parsedPartNumber || row.partNumber || row.part || '',
      upiCode: row.upiCode || row.upiNo || row.upiId || extractUpiIdFromText(row) || '',
      partNumber: row.partNumber || row.part || '',
      normalizedPartNumber: row.normalizedPartNumber || row.partNumber || row.part || '',
      part: row.part || row.partNumber || '',
      partName: row.partName || row.partDescription || row.part || row.partNumber || '',
      partDescription: row.partDescription || row.partName || row.part || row.partNumber || '',
      description: row.description || row.partDescription || row.partName || row.part || '',
      productCategory: row.productCategory || '',
      category: row.category || row.productCategory || '',
      qty: row.qty ?? row.quantity ?? 1,
      quantity: row.quantity ?? row.qty ?? 1,
      mrp: row.mrp,
      dlc: row.dlc,
      currentCatalogueMRP: row.currentCatalogueMRP ?? row.mrp,
      currentCatalogueDLC: row.currentCatalogueDLC ?? row.dlc,
      manualMRP: row.manualMRP,
      valuationMRP: row.valuationMRP,
      valuationSource: row.valuationSource,
      finalInventoryValue: row.finalInventoryValue,
      mrpProvided: row.mrpProvided,
      binLocation: row.binLocation || row.bin || '',
      bin: row.bin || row.binLocation || '',
      regdNo: row.regdNo || '',
      jobCardNo: row.jobCardNo || '',
      dealerCode: row.dealerCode || activeDealerCode(),
      dealerName: row.dealerName || activeDealerName(),
      auditId: row.auditId || activeAuditId(),
      userId: row.userId || '',
      loginId: row.loginId || '',
      userName: row.userName || '',
      staffName: row.staffName || '',
      role: row.role || '',
      scanType: row.scanType || row.type || currentScanType(),
      type: row.type || row.scanType || currentScanType(),
      movementType: row.movementType || row.scanType || row.type || currentScanType(),
      activeInventory: row.activeInventory !== undefined ? Boolean(row.activeInventory) : (row.scanType || row.type || currentScanType()) === 'INWARD',
      remainingQty: row.remainingQty !== undefined ? row.remainingQty : (row.scanType || row.type || currentScanType()) === 'INWARD' ? (Number(row.qty ?? row.quantity ?? 1) || 1) : 0,
      scanSource: row.scanSource || 'mobile',
      source: row.source || { source: row.scanSource || 'mobile', scanSource: row.scanSource || 'mobile' },
      entryMode: row.entryMode || 'camera',
      entryChannel: row.entryChannel || 'web',
      allowCrossBinDuplicate: Boolean(row.allowCrossBinDuplicate || row.smartBinIsSecondaryLocation || row.smartBinDecision === 'SAVE_NEW_BIN'),
      smartBinEnabled: row.smartBinEnabled === undefined ? undefined : Boolean(row.smartBinEnabled),
      smartBinDecision: row.smartBinDecision || '',
      smartBinReason: row.smartBinReason || '',
      smartBinSuggestedBin: row.smartBinSuggestedBin || '',
      smartBinSelectedBin: row.smartBinSelectedBin || row.binLocation || row.bin || '',
      smartBinCurrentBin: row.smartBinCurrentBin || row.binLocation || row.bin || '',
      smartBinExistingBins: Array.isArray(row.smartBinExistingBins) ? row.smartBinExistingBins : [],
      smartBinAllowMultipleLocations: row.smartBinAllowMultipleLocations === undefined ? undefined : Boolean(row.smartBinAllowMultipleLocations),
      smartBinMaxAllowedLocationsPerPart: row.smartBinMaxAllowedLocationsPerPart === undefined
        ? undefined
        : Math.max(1, Number.parseInt(String(row.smartBinMaxAllowedLocationsPerPart), 10) || 3),
      smartBinReasonRequired: row.smartBinReasonRequired === undefined ? undefined : Boolean(row.smartBinReasonRequired),
      smartBinLocationType: row.smartBinLocationType || '',
      smartBinIsSecondaryLocation: row.smartBinIsSecondaryLocation === undefined ? undefined : Boolean(row.smartBinIsSecondaryLocation),
      smartBinCheckedAt: row.smartBinCheckedAt || '',
      smartBinDecisionAt: row.smartBinDecisionAt || '',
      smartBinDecisionBy: row.smartBinDecisionBy || '',
      smartBinAuditTrail: row.smartBinAuditTrail && typeof row.smartBinAuditTrail === 'object' ? row.smartBinAuditTrail : undefined,
      deviceId: row.deviceId || deviceId(),
      deviceName: row.deviceName || clean(state.session?.deviceName || DEFAULT_DEVICE_NAME),
      appVersion: row.appVersion || APP_VERSION,
      timestamp,
      scanTime: row.scanTime || timestamp,
      mobileCreatedAt: row.mobileCreatedAt || timestamp,
      localCreatedAt: row.mobileCreatedAt || timestamp,
      mobileReceivedTime: row.mobileReceivedTime || timestamp,
      mobileReceivedTimeUtc: row.mobileReceivedTimeUtc || timestamp,
      serverUrl: row.serverUrl || window.location.origin.replace(/\/+$/, '')
    };
  }

  async function removeStoredQueueRecord(record = {}) {
    const key = clean(record.uniqueLocalId || record.scanId || record.uniqueScanId || record.localId || record.clientScanId || record.syncKey || '');
    if (!key) return;
    await deleteRecord(key).catch(() => undefined);
    removeStateRow({ uniqueLocalId: key, scanId: key, uniqueScanId: key, localId: key, clientScanId: key, syncKey: key });
  }

  async function saveRecordToServer(record = {}, options = {}) {
    const response = await api('/api/scans/process', {
      method: 'POST',
      body: convertToSyncPayload(record),
      timeoutMs: API_TIMEOUT_MS
    });
    const serverScan = response.scan || (Array.isArray(response.insertedRecords) ? response.insertedRecords[0] : null) || {};
    const saved = mergeStoredRecordWithServer(record, serverScan, {
      status: 'synced',
      syncStatus: 'synced',
      syncError: '',
      retryCount: Number(record.retryCount || 0),
      serverAck: serverScan
    });
    await removeStoredQueueRecord(record);
    applyRecordToUi(saved);
    void enrichStoredRecord(saved).catch(() => undefined);
    if (options.refreshRecent !== false) {
      await refreshLiveRecentScans({ force: true, reason: 'server-save' }).catch(() => undefined);
    }
    return { response, saved };
  }

  async function markDuplicateRecord(record = {}, existing = {}, message = '') {
    const latest = await getRecord(record.uniqueLocalId || record.scanId || record.uniqueScanId || record.localId || '').catch(() => null);
    const source = latest || record;
    const duplicateMessage = message || duplicateScanMessage(existing || source);
    await removeStoredQueueRecord(source);
    updateLastScan({
      ...source,
      status: 'duplicate',
      syncStatus: 'duplicate',
      syncError: duplicateMessage,
      serverDuplicateState: 'duplicate',
      serverDuplicateCheckedAt: nowIso(),
      serverAck: existing || source
    });
    renderQueueBadgeCounts();
    renderHistoryRows();
    cameraState('Duplicate blocked');
    showDuplicateOnce(source, existing || source, duplicateMessage);
  }

  async function clearStaleDuplicateMarks(record = {}) {
    const upiCode = rowUpiCode(record);
    if (!upiCode) return 0;
    const dealerCode = activeDealerCode();
    const auditId = activeAuditId();
    const rows = await getAllRecords().catch(() => []);
    const matchingRows = rows.filter((row) => {
      if (rowUpiCode(row) !== upiCode) return false;
      if (dealerCode && upper(row.dealerCode || '') !== dealerCode) return false;
      if (auditId && clean(row.auditId || '') !== auditId) return false;
      return true;
    });
    if (!matchingRows.length) return 0;
    const checkedAt = nowIso();
    for (const row of matchingRows) {
      const next = {
        ...row,
        serverDuplicateState: 'free',
        serverDuplicateCheckedAt: checkedAt
      };
      await putRecord(next);
      upsertStateRow(next);
    }
    renderQueueBadgeCounts();
    renderHistoryRows();
    return matchingRows.length;
  }

  async function checkBackendDuplicateBeforeSync(record = {}, options = {}) {
    if (!navigator.onLine || !state.session?.token) {
      return { checkedOnline: false, duplicate: false, existing: null, message: '', cleared: 0 };
    }
    try {
      const duplicatePayload = {
        ...convertToSyncPayload(record),
        allowCrossBinDuplicate: false,
        smartBinAllowCrossBinDuplicate: false,
        smartBinIsSecondaryLocation: false,
        smartBinDecision: ''
      };
      const data = await api('/api/scan/check-duplicate', {
        method: 'POST',
        body: duplicatePayload,
        timeoutMs: Number(options.timeoutMs || 10000)
      });
      const existing = data?.existing || data?.scan || null;
      const message = clean(data?.message || duplicateScanMessage(existing || record));
      if (data && data.duplicate) {
        return { checkedOnline: true, duplicate: true, existing, message, cleared: 0 };
      }
      const cleared = await clearStaleDuplicateMarks(record).catch(() => 0);
      return { checkedOnline: true, duplicate: false, existing: null, message: '', cleared };
    } catch (error) {
      if (authExpired(error)) {
        handleAuthExpired(error);
        return { checkedOnline: false, duplicate: false, existing: null, message: '', cleared: 0 };
      }
      return { checkedOnline: false, duplicate: false, existing: null, message: clean(error?.message || ''), cleared: 0 };
    }
  }

  async function refreshHealth() {
    try {
      const health = await api('/api/health', { auth: false, timeoutMs: LOGIN_CONFIG_TIMEOUT_MS });
      state.health = health;
      if (health.mobileScannerUrl) {
        state.canonicalUrl = health.mobileScannerUrl;
      }
      renderAll();
      return health;
    } catch (error) {
      state.health = null;
      renderAll();
      return null;
    }
  }

  async function refreshSessionContext() {
    if (!state.session?.token || !activeDealerCode()) return null;
    try {
      const query = new URLSearchParams({
        dealerCode: activeDealerCode(),
        deviceId: deviceId()
      });
      const data = await api(`/api/mobile/status?${query.toString()}`, { auth: true });
      if (data.mobileScannerUrl) state.canonicalUrl = data.mobileScannerUrl;
      if (data.activeAudit || data.auditId) {
        const nextSession = {
          ...state.session,
          activeAudit: data.activeAudit || state.session.activeAudit || null,
          auditId: data.activeAudit?.auditId || data.auditId || state.session.auditId || '',
          dealerName: data.activeAudit?.dealerName || state.session.dealerName || ''
        };
        saveSession(nextSession);
        state.liveRecentRows = null;
        state.liveRecentRefreshPromise = null;
        state.liveRecentRefreshToken = Number(state.liveRecentRefreshToken || 0) + 1;
        updateLastScan(null);
      }
      renderAll();
      refreshLiveRecentScans({ force: true, reason: 'session-context' }).catch(() => undefined);
      return data;
    } catch (error) {
      if (authExpired(error)) {
        handleAuthExpired(error);
        return null;
      }
      return null;
    }
  }

  function handleAuthExpired(error) {
    stopCamera({ preserveRequest: false });
    closeSmartBinSuggestionModal(null);
    closeDuplicateAlert();
    clearTimeout(state.autoCameraTimer);
    clearTimeout(state.syncDelayTimer);
    clearInterval(state.syncTimer);
    clearInterval(state.heartbeatTimer);
    clearInterval(state.recentRefreshTimer);
    clearInterval(state.versionTimer);
    state.autoCameraTimer = null;
    state.syncDelayTimer = null;
    state.syncTimer = null;
    state.heartbeatTimer = null;
    state.recentRefreshTimer = null;
    state.versionTimer = null;
    state.liveRecentRows = null;
    state.liveRecentRefreshPromise = null;
    state.liveRecentRefreshToken = Number(state.liveRecentRefreshToken || 0) + 1;
    clearSession();
    state.allRows = [];
    state.pendingLogin = null;
    state.manualRaw = '';
    state.manualResumeAfterClose = false;
    state.partMasterCache.clear();
    state.partMasterLookupPromise.clear();
    updateLastScan(null);
    updateScannerPanel();
    toast(error?.message || 'Login expired. Please sign in again.', 'error');
  }

  function logout() {
    stopCamera({ preserveRequest: false });
    closeSmartBinSuggestionModal(null);
    closeDuplicateAlert();
    clearTimeout(state.autoCameraTimer);
    clearTimeout(state.syncDelayTimer);
    clearInterval(state.syncTimer);
    clearInterval(state.heartbeatTimer);
    clearInterval(state.recentRefreshTimer);
    clearInterval(state.versionTimer);
    state.autoCameraTimer = null;
    state.syncDelayTimer = null;
    state.syncTimer = null;
    state.heartbeatTimer = null;
    state.recentRefreshTimer = null;
    state.versionTimer = null;
    state.cameraRequested = false;
    state.paused = false;
    state.pendingLogin = null;
    state.manualRaw = '';
    state.manualResumeAfterClose = false;
    state.partMasterCache.clear();
    state.partMasterLookupPromise.clear();
    state.liveRecentRows = null;
    state.liveRecentRefreshPromise = null;
    state.liveRecentRefreshToken = Number(state.liveRecentRefreshToken || 0) + 1;
    clearSession();
    state.allRows = [];
    updateLastScan(null);
    updateScannerPanel();
    toast('Logged out', 'info');
  }

  function ensureScanSession() {
    if (!state.session?.token) {
      toast('Please login first', 'error');
      return false;
    }
    return true;
  }

  function requestAutoCameraStart({ focusBin = false, forceRestart = false } = {}) {
    if (!state.session?.token) return;
    state.cameraRequested = true;
    state.paused = false;
    clearTimeout(state.autoCameraTimer);
    state.autoCameraTimer = null;
    if (!isSecureScannerContext() && !LOCALHOST_NAMES.has(window.location.hostname)) {
      cameraState('Open the secure Railway URL to use the camera.');
      return;
    }
    if (requiresBin() && !loadActiveBin() && focusBin) byId('activeBinLocation')?.focus();
    if (forceRestart && state.scanning) stopCamera({ preserveRequest: true });
    cameraState('Ready to scan');
    const startAttempt = () => {
      if (!state.session?.token || state.paused || !state.cameraRequested) return;
      startCamera().catch((error) => {
        cameraState(error.message || 'Camera failed to start');
        toast(error.message || 'Camera failed to start', 'error');
      });
    };
    if (forceRestart) {
      Promise.resolve().then(startAttempt);
      return;
    }
    state.autoCameraTimer = setTimeout(startAttempt, 150);
  }

  async function startCamera() {
    if (!ensureScanSession()) return;
    if (!isSecureScannerContext() && !LOCALHOST_NAMES.has(window.location.hostname)) {
      cameraState('Open the secure Railway URL to use the camera.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      cameraState('Camera API unavailable. Use manual entry.');
      return;
    }
    stopCamera({ preserveRequest: true });
    const runId = state.cameraRunId + 1;
    state.cameraRunId = runId;
    state.cameraRequested = true;
    state.paused = false;
    state.scanning = true;
    const video = byId('cameraPreview');
    if (!video) {
      state.scanning = false;
      throw new Error('Camera preview is unavailable');
    }
    bindVideoState(video);
    video.muted = true;
    video.autoplay = true;
    video.setAttribute('playsinline', '');
    bindCameraTapToFocus(video);
    const nativeDetectorPromise = nativeBarcodeDetector();
    cameraState('Ready to scan');
    setCameraStarting(true);
    let stream = null;
    try {
      const onDecode = (result, error) => {
        if (runId !== state.cameraRunId || !state.scanning) return;
        if (result) handleDecodeResult(result);
        if (error && !/NotFound|Checksum|Format/i.test(String(error.name || error.constructor?.name || ''))) {
          clearTimeout(state.zxingRestartTimer);
          state.zxingRestartTimer = setTimeout(() => {
            if (runId !== state.cameraRunId || !state.scanning) return;
            try {
              if (state.scanReader?.stopContinuousDecode) state.scanReader.stopContinuousDecode();
              if (state.scanReader?.decodeContinuously) state.scanReader.decodeContinuously(video, onDecode);
            } catch (_) {}
          }, 220);
        }
      };
      const openStream = async () => navigator.mediaDevices.getUserMedia(cameraConstraints());
      try {
        stream = await openStream();
      } catch (firstError) {
        throw firstError;
      }
      if (!state.scanning || runId !== state.cameraRunId) {
        stream?.getTracks?.().forEach((track) => track.stop());
        return;
      }
      state.cameraStream = stream;
      video.srcObject = stream;
      try {
        await video.play();
      } catch (_) {}
      setCameraLive(true);
      setCameraStarting(false);
      if (!state.scanning || runId !== state.cameraRunId) return;
      const nativeDetector = await nativeDetectorPromise.catch(() => null);
      if (nativeDetector) {
        cameraState('Ready to scan');
        startNativeDetector(video).catch(() => undefined);
      } else {
        const reader = await ensureReader();
        if (!state.scanning || runId !== state.cameraRunId) return;
        state.scanReader = reader;
        cameraState('Ready to scan');
        if (typeof reader.decodeContinuously === 'function') {
          try {
            reader.decodeContinuously(video, onDecode);
          } catch (error) {
            throw error;
          }
        } else if (reader && typeof reader.decodeFromConstraints === 'function') {
          state.cameraStream = null;
          try {
            stream.getTracks().forEach((track) => track.stop());
          } catch (_) {}
          const startDecode = () => reader.decodeFromConstraints(cameraConstraints(), video, onDecode);
          const promise = Promise.resolve(startDecode()).catch((error) => {
            if (state.scanning && runId === state.cameraRunId) {
              state.scanning = false;
              setCameraStarting(false);
              setCameraLive(false);
              const message = error?.message || 'Camera failed to start';
              cameraState(message);
              toast(message, 'error');
            }
          });
          promise.catch(() => undefined);
        } else {
          throw new Error('Scanner library failed to initialize');
        }
      }
      await enableCameraFocus(video);
      cameraState('Ready to scan');
      state.cameraTimer = setTimeout(() => {
        if (state.scanning && runId === state.cameraRunId && video?.srcObject && video.readyState >= 2) {
          setCameraLive(true);
          cameraState('Ready to scan');
        }
      }, 180);
      refreshLiveRecentScans({ force: true, reason: 'camera-start' }).catch(() => undefined);
    } catch (error) {
      if (runId !== state.cameraRunId) {
        stream?.getTracks?.().forEach((track) => track.stop());
        return;
      }
      state.scanning = false;
      setCameraStarting(false);
      setCameraLive(false);
      if (state.cameraStream) {
        try {
          state.cameraStream.getTracks().forEach((track) => track.stop());
        } catch (_) {}
      }
      state.cameraStream = null;
      if (video) {
        try {
          video.pause();
        } catch (_) {}
        video.srcObject = null;
      }
      cameraState(error.message || 'Camera failed to start');
      toast(error.message || 'Camera failed to start', 'error');
    }
  }

  function handleDecodeResult(result) {
    if (state.smartBinPromptOpen || state.duplicateAlertOpen) return;
    const raw = clean(typeof result?.getText === 'function' ? result.getText() : result?.text || result?.rawValue || result);
    if (!raw) return;
    const key = `${state.mode}|${raw}`;
    const lastSeen = state.lastDecodeAtByKey.get(key) || 0;
    if (Date.now() - lastSeen < DEDUPE_MS) return;
    state.lastDecodeAtByKey.set(key, Date.now());
    if (state.lastDecodeAtByKey.size > 40) {
      for (const [entryKey, timestamp] of state.lastDecodeAtByKey.entries()) {
        if (Date.now() - timestamp > 30000) state.lastDecodeAtByKey.delete(entryKey);
      }
    }
    cameraState('Scanned');
    void processDecodedText(raw);
  }

  async function processDecodedText(raw) {
    const mode = currentScanType();
    if (mode === 'FITTED') {
      toast('Fitted scans need vehicle and job card details', 'warning');
      vibrate([30, 40, 30]);
      openManualDialog({
        rawText: raw,
        title: 'Complete fitted details',
        autoPartNumber: parsePartCandidate(raw)
      });
      return;
    }
    if (requiresBin() && !ensureActiveBinReady()) {
      cameraState('Ready to scan');
      return;
    }
    let record = createScanRecord({
      rawText: raw,
      manual: false,
      partNumber: parsePartCandidate(raw),
      binLocation: requiresBin() ? loadActiveBin() : ''
    });
    try {
      record = await preflightDuplicateDecision(record);
      if (!record) return;
      record = await preflightSmartBinDecision(record);
      if (!record) {
        cameraState('Ready to scan');
        return;
      }
      await saveRecord(record, { silent: true, deferSync: false });
      byId('manualRawPreview').hidden = true;
      cameraState(navigator.onLine && state.session?.token ? 'Queued' : 'Network pending');
      beep('ok');
      vibrate(40);
      if (navigator.onLine && state.session?.token) scheduleSync(120);
    } catch (error) {
      if (authExpired(error)) {
        handleAuthExpired(error);
      } else {
        const message = clean(error?.message || 'Unable to queue scan');
        cameraState('Network pending');
        toast(message, 'error');
        beep('error');
        vibrate([30, 30, 30]);
      }
    }
  }

  async function syncQueue({ silent = false } = {}) {
    if (state.syncRunning) {
      state.syncAgain = true;
      return;
    }
    if (!state.session?.token || !navigator.onLine) return;
    const rows = sessionRows().filter((row) => rowStatus(row) === 'pending');
    if (!rows.length) {
      await refreshLiveRecentScans({ force: true, reason: 'sync-empty' }).catch(() => undefined);
      renderQueueBadgeCounts();
      renderHistoryRows();
      return;
    }
    const batch = rows.slice(0, BATCH_SIZE);
    if (rows.length > batch.length) state.syncAgain = true;
    state.syncRunning = true;
    let syncedCount = 0;
    let duplicateCount = 0;
    let rejectedCount = 0;
    let failedCount = 0;
    let pendingCount = 0;
    try {
      for (const row of batch) {
        try {
          const duplicateResult = await checkBackendDuplicateBeforeSync(row, { timeoutMs: 5000 });
          if (duplicateResult?.duplicate) {
            await markDuplicateRecord(row, duplicateResult.existing || {}, duplicateResult.message || duplicateScanMessage(duplicateResult.existing || row));
            duplicateCount += 1;
            continue;
          }
          const readyRow = await preflightSmartBinDecision(row);
          if (!readyRow) {
            await removeStoredQueueRecord(row);
            rejectedCount += 1;
            continue;
          }
          await saveRecordToServer(readyRow, { refreshRecent: false });
          syncedCount += 1;
        } catch (error) {
          if (authExpired(error)) {
            handleAuthExpired(error);
            return;
          }
          const data = error.data || {};
          const message = clean(data.message || error.message || 'Sync failed');
          if (Number(error.status) === 409 && data.smartBinWarning) {
            const smartBinPayload = data.smartBinSuggestion || data;
            const decision = await openSmartBinSuggestionModal({
              ...smartBinPayload,
              partDescription: row.partDescription || row.partName || data.partDescription || '',
              currentBin: smartBinPayload.currentBin || row.binLocation || row.bin || '',
              newBin: smartBinPayload.newBin || row.binLocation || row.bin || '',
              existingBin: smartBinPayload.existingBin || (Array.isArray(smartBinPayload.existingBins) && smartBinPayload.existingBins[0] && smartBinPayload.existingBins[0].binLocation) || '',
              requireReason: false
            });
            if (!decision) {
              await removeStoredQueueRecord(row);
              rejectedCount += 1;
              continue;
            }
            const updatedRow = applySmartBinDecisionToRecord(row, smartBinPayload, decision);
            await putRecord(updatedRow);
            upsertStateRow(updatedRow);
            try {
              await saveRecordToServer(updatedRow, { refreshRecent: false });
              syncedCount += 1;
              continue;
            } catch (retryError) {
              const retryData = retryError.data || {};
              const retryMessage = clean(retryData.message || retryError.message || 'Sync failed');
              const next = {
                ...updatedRow,
                status: 'failed',
                syncStatus: 'failed',
                syncError: retryMessage,
                retryCount: Number(updatedRow.retryCount || 0) + 1
              };
              await putRecord(next);
              upsertStateRow(next);
              failedCount += 1;
              continue;
            }
          }
          const duplicate = Number(error.status) === 409 || data.duplicate || data.upiDuplicate;
          if (duplicate) {
            duplicateCount += 1;
            await markDuplicateRecord(row, data.existing || data.scan || {}, message);
            continue;
          }
          if (isRetryableTransportError(error)) {
            pendingCount += 1;
            const next = {
              ...row,
              status: 'pending',
              syncStatus: 'pending',
              syncError: message,
              retryCount: Number(row.retryCount || 0) + 1
            };
            await putRecord(next);
            upsertStateRow(next);
            continue;
          }
          const rejected = [400, 404, 409, 422].includes(Number(error.status))
            || ['invalid', 'rejected'].includes(clean(data.status).toLowerCase());
          if (rejected) rejectedCount += 1;
          else failedCount += 1;
          if (rejected) {
            await removeStoredQueueRecord(row);
          } else {
            const next = {
              ...row,
              status: 'failed',
              syncStatus: 'failed',
              syncError: message,
              retryCount: Number(row.retryCount || 0) + 1
            };
            await putRecord(next);
            upsertStateRow(next);
          }
        }
      }

      if (syncedCount) storageSet(LAST_SYNC_KEY, nowIso());
      const terminalCount = syncedCount + duplicateCount + rejectedCount + failedCount;
      if (!silent) {
        const message = pendingCount
          ? `${pendingCount} scan(s) remain pending until the connection is restored.`
          : failedCount || rejectedCount
            ? `${terminalCount} scan(s) processed: ${rejectedCount} rejected, ${failedCount} failed.`
            : `${syncedCount} scan(s) synced${duplicateCount ? `, ${duplicateCount} duplicate(s) blocked` : ''}.`;
        toast(message, failedCount || rejectedCount ? 'error' : pendingCount || duplicateCount ? 'warning' : 'success');
      }
      sendHeartbeat().catch(() => undefined);
    } finally {
      state.syncRunning = false;
      await refreshLiveRecentScans({ force: true, reason: 'sync' }).catch(() => undefined);
      renderQueueBadgeCounts();
      renderHistoryRows();
      if (state.syncAgain && state.session?.token && navigator.onLine) {
        state.syncAgain = false;
        setTimeout(() => syncQueue({ silent: true }).catch(() => undefined), 0);
      }
    }
  }

  async function batteryPercent() {
    try {
      if (!navigator.getBattery) return undefined;
      const battery = await navigator.getBattery();
      return Math.round(Number(battery.level || 0) * 100);
    } catch (_) {
      return undefined;
    }
  }

  async function sendHeartbeat() {
    if (!state.session?.token) return null;
    const rows = sessionRows();
    const counts = recordStatusCounts(rows);
    try {
      return await api('/api/mobile/heartbeat', {
        method: 'POST',
        body: {
          deviceId: deviceId(),
          deviceName: clean(state.session?.deviceName || DEFAULT_DEVICE_NAME),
          dealerCode: activeDealerCode(),
          dealerName: activeDealerName(),
          userId: clean(state.session?.user?.id || ''),
          userName: clean(state.session?.user?.name || state.session?.user?.username || ''),
          role: clean(state.session?.user?.role || ''),
          appVersion: APP_VERSION,
          pendingCount: counts.pending,
          failedCount: counts.failed,
          batteryPercent: await batteryPercent()
        }
      });
    } catch (error) {
      if (authExpired(error)) handleAuthExpired(error);
      return null;
    }
  }

  function updateManualSuggestionList(parts = []) {
    const container = byId('partSuggestions');
    if (!parts.length) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML = parts.map((part, index) => {
      const partNo = clean(part.partNumber || part.partNo || part.part || '');
      const description = clean(part.partDescription || part.partName || '');
      const meta = [part.productCategory || part.category || '', part.mrp ? `MRP ${fmtNumber(part.mrp)}` : '', part.dlc ? `DLC ${fmtNumber(part.dlc)}` : ''].filter(Boolean).join(' · ');
      return `
        <button type="button" data-index="${index}">
          <strong>${escapeHtml(partNo)}</strong>
          ${description ? `<span>${escapeHtml(description)}</span>` : ''}
          ${meta ? `<small>${escapeHtml(meta)}</small>` : ''}
        </button>
      `;
    }).join('');
    qsa('button[data-index]', container).forEach((button) => {
      button.addEventListener('click', () => {
        const part = parts[Number(button.dataset.index)];
        const partNo = clean(part.partNumber || part.partNo || part.part || '');
        byId('manualPartNumber').value = upper(partNo);
        if (Number(part.mrp || 0) > 0 && !byId('manualMrpWrap').classList.contains('hidden')) {
          byId('manualMrp').value = String(part.mrp);
        }
        if (Number(part.dlc || 0) > 0 && byId('manualDlc') && !byId('manualDlcWrap')?.classList.contains('hidden')) {
          byId('manualDlc').value = String(part.dlc);
        }
        byId('manualPartNumber').focus();
        container.innerHTML = '';
      });
    });
  }

  function bindManualSearch() {
    let timer = null;
    byId('manualPartNumber').addEventListener('input', (event) => {
      const input = event.target;
      input.value = upper(input.value);
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = upper(input.value);
        if (q.length < 2 || !state.session?.token) {
          updateManualSuggestionList([]);
          return;
        }
        try {
          const params = new URLSearchParams({
            q,
            dealerCode: activeDealerCode(),
            limit: '5'
          });
          const data = await api(`/api/mobile/master-search?${params.toString()}`);
          const parts = Array.isArray(data.parts) ? data.parts : Array.isArray(data.suggestions) ? data.suggestions : [];
          updateManualSuggestionList(parts);
          const exact = parts.find((part) => upper(part.partNumber || part.partNo || part.part || '') === q);
          if (exact) {
            byId('manualMrp').value = Number(exact.mrp || 0) > 0 ? String(exact.mrp) : '';
            if (byId('manualDlc')) byId('manualDlc').value = Number(exact.dlc || 0) > 0 ? String(exact.dlc) : '';
          } else {
            byId('manualMrp').value = '';
            if (byId('manualDlc')) byId('manualDlc').value = '';
          }
        } catch (_) {
          updateManualSuggestionList([]);
        }
      }, 220);
    });
  }

  function openManualDialog({ rawText = '', autoPartNumber = '', title = '' } = {}) {
    if (!ensureScanSession()) return;
    const dialog = byId('manualDialog');
    state.manualRaw = clean(rawText);
    state.manualMode = state.mode;
    state.manualResumeAfterClose = state.cameraRequested && !state.paused;
    state.paused = true;
    stopCamera({ preserveRequest: true });
    renderModeMeta();
    renderModeFields();
    byId('manualForm').reset();
    byId('manualTitle').textContent = title || (state.mode === 'FITTED' ? 'Complete fitted details' : state.mode === 'VERIFICATION' ? 'Verification entry' : 'Add scan manually');
    byId('manualPartNumber').value = upper(autoPartNumber || parsePartCandidate(rawText));
    byId('manualQty').value = '1';
    byId('manualMrp').value = '';
    if (byId('manualDlc')) byId('manualDlc').value = '';
    byId('manualBinLocation').value = requiresBin() ? loadActiveBin() : '';
    byId('manualRegdNo').value = '';
    byId('manualJobCardNo').value = '';
    byId('partSuggestions').innerHTML = '';
    if (state.manualRaw) {
      byId('manualRawPreview').hidden = false;
      byId('manualRawPreview').textContent = `Captured code: ${parseRawPreview(state.manualRaw)}`;
    } else {
      byId('manualRawPreview').hidden = true;
      byId('manualRawPreview').textContent = '';
    }
    renderModeFields();
    dialog.showModal();
    byId('manualPartNumber').focus();
  }

  function closeManualDialog() {
    const dialog = byId('manualDialog');
    if (dialog.open) dialog.close();
    byId('partSuggestions').innerHTML = '';
    byId('manualRawPreview').hidden = true;
    if (state.manualResumeAfterClose) {
      state.manualResumeAfterClose = false;
      state.paused = false;
      startCamera().catch((error) => toast(error.message || 'Camera failed to resume', 'error'));
    }
  }

  async function submitManual(event) {
    event.preventDefault();
    if (!state.session?.token) {
      toast('Please login first', 'error');
      return;
    }
    const form = new FormData(event.currentTarget);
    const partNumber = upper(form.get('partNumber'));
    if (!partNumber) {
      toast('Part number is required', 'error');
      byId('manualPartNumber').focus();
      return;
    }
    const mode = currentScanType();
    const qty = Number(form.get('qty') || 1);
    const binLocation = upper(form.get('binLocation') || '');
    const regdNo = upper(form.get('regdNo') || '');
    const jobCardNo = upper(form.get('jobCardNo') || '');

    if (requiresBin() && !binLocation) {
      toast('Bin location is required for this mode', 'error');
      byId('manualBinLocation').focus();
      return;
    }

    if (mode === 'FITTED' && (!regdNo || !jobCardNo)) {
      toast('Registration number and job card number are required for fitted scans', 'error');
      return;
    }

    const rawText = state.manualRaw || `MANUAL:${partNumber}`;
    let record = createScanRecord({
      rawText,
      manual: true,
      partNumber,
      qty: mode === 'VERIFICATION' ? 1 : qty,
      binLocation,
      regdNo,
      jobCardNo
    });
    try {
      record = await preflightDuplicateDecision(record);
      if (!record) return;
      record = await preflightSmartBinDecision(record);
      if (!record) return;
      await saveRecord(record, { silent: true, deferSync: false });
      closeManualDialog();
      cameraState(navigator.onLine && state.session?.token ? 'Queued' : 'Network pending');
      toast(navigator.onLine ? 'Queued' : 'Network pending', navigator.onLine ? 'success' : 'warning');
      beep('ok');
      vibrate(40);
      if (navigator.onLine && state.session?.token) scheduleSync(120);
    } catch (error) {
      if (authExpired(error)) {
        handleAuthExpired(error);
      } else {
        const message = clean(error.message || 'Manual save failed');
        toast(message, 'error');
        beep('error');
        vibrate([30, 30, 30]);
      }
    }
  }

  function bindEvents() {
    byId('copyUrlBtn')?.addEventListener('click', () => copyScanUrl());
    byId('copyScannerUrlBtn').addEventListener('click', () => copyScanUrl());
    byId('loginForm').addEventListener('submit', (event) => {
      void submitLogin(event);
    });
    byId('logoutBtn')?.addEventListener('click', () => logout());
    document.addEventListener('click', (event) => {
      const copyButton = event.target.closest('.copy-part-btn');
      if (copyButton) {
        event.preventDefault();
        event.stopPropagation();
        const part = String(copyButton.dataset.part || '').trim();
        copyTextValue(part, copyButton.dataset.copyLabel || 'Part number')
          .then(() => toast(`Copied: ${part}`, 'success'))
          .catch((error) => toast(error.message, 'error'));
        return;
      }
      const removeButton = event.target.closest('.remove-part-btn');
      if (removeButton) {
        event.preventDefault();
        event.stopPropagation();
        if (removeButton.disabled) return;
        const scanId = String(removeButton.dataset.scanId || '').trim();
        const row = scanId ? sessionRows().find((item) => clean(item.scanId || item.uniqueScanId || item.localId || '') === scanId) : null;
        deleteHistoryRow(row || {
          scanId,
          uniqueScanId: scanId,
          localId: scanId,
          partNumber: removeButton.dataset.part || '',
          dealerCode: removeButton.dataset.dealerCode || '',
          auditId: removeButton.dataset.auditId || ''
        }).catch((error) => toast(error.message, 'error'));
      }
    }, true);
    byId('saveBinBtn').addEventListener('click', () => {
      saveBinAndStartCamera();
    });
    byId('clearBinBtn').addEventListener('click', () => {
      setActiveBin('');
      renderBinPanel();
      if (requiresBin() && state.scanning) {
        stopCamera({ preserveRequest: true });
      }
      byId('activeBinLocation').focus();
    });
    byId('startScanBtn').addEventListener('click', () => {
      if (state.scanning) {
        state.cameraRequested = false;
        state.paused = false;
        stopCamera({ preserveRequest: false });
        cameraState('Camera off');
        renderCameraControlState({ live: false, starting: false });
        return;
      }
      state.paused = false;
      state.cameraRequested = true;
      startCamera().catch((error) => toast(error.message || 'Camera failed to start', 'error'));
    });
    byId('manualBtn').addEventListener('click', () => openManualDialog({}));
    byId('syncNowBtn').addEventListener('click', () => {
      syncQueue({ silent: false }).catch((error) => toast(error.message || 'Sync failed', 'error'));
    });
    byId('clearSyncedBtn').addEventListener('click', () => clearSyncedRows());
    byId('loginDealerSelect')?.addEventListener('change', (event) => {
      const value = upper(event.target?.value || '');
      state.pendingLogin = state.pendingLogin ? { ...state.pendingLogin, dealerCode: value } : null;
      if (value) byId('loginMessage').textContent = '';
    });
    byId('activeBinLocation').addEventListener('input', (event) => {
      event.target.value = upper(event.target.value);
    });
    byId('activeBinLocation').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      saveBinAndStartCamera();
    });
    byId('activeBinLocation').addEventListener('change', () => {
      if (byId('activeBinLocation').value) saveBinAndStartCamera();
    });
    qsa('.mode-btn').forEach((button) => {
      button.addEventListener('click', () => setMode(button.dataset.mode));
    });
    byId('manualCancelBtn').addEventListener('click', () => closeManualDialog());
    byId('manualCloseBtn').addEventListener('click', () => closeManualDialog());
    byId('manualForm').addEventListener('submit', (event) => {
      void submitManual(event);
    });
    byId('smartBinSuggestionDialog')?.addEventListener('cancel', (event) => event.preventDefault());
    byId('duplicateAlertDialog')?.addEventListener('cancel', (event) => event.preventDefault());
    byId('duplicateAlertOkBtn')?.addEventListener('click', () => closeDuplicateAlert());
    byId('smartBinUseExistingBtn')?.addEventListener('click', () => resolveSmartBinSuggestionAction('USE_EXISTING_BIN', state.smartBinPromptPayload || {}).catch((error) => toast(error.message, 'error')));
    byId('smartBinSaveNewBtn')?.addEventListener('click', () => resolveSmartBinSuggestionAction('SAVE_NEW_BIN', state.smartBinPromptPayload || {}).catch((error) => toast(error.message, 'error')));
    byId('smartBinCancelBtn')?.addEventListener('click', () => resolveSmartBinSuggestionAction('ABORT', state.smartBinPromptPayload || {}).catch((error) => toast(error.message, 'error')));
    window.addEventListener('online', () => {
      renderConnectionBadge();
      renderUrlState();
      if (state.session?.token) {
        refreshHealth().catch(() => undefined);
        refreshLiveRecentScans({ force: true, reason: 'online' }).catch(() => undefined);
        syncQueue({ silent: true }).catch(() => undefined);
        sendHeartbeat().catch(() => undefined);
      }
    });
    window.addEventListener('offline', () => {
      renderConnectionBadge();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (state.scanning) stopCamera({ preserveRequest: true });
      } else if (state.cameraRequested && !state.paused && state.session?.token) {
        refreshLiveRecentScans({ force: true, reason: 'visible' }).catch(() => undefined);
        syncQueue({ silent: true }).catch(() => undefined);
        sendHeartbeat().catch(() => undefined);
        startCamera().catch(() => undefined);
      }
    });
    window.addEventListener('pagehide', () => stopCamera({ preserveRequest: true }));
    window.addEventListener('pageshow', () => {
      if (state.cameraRequested && !state.paused && state.session?.token && !state.scanning) {
        requestAutoCameraStart();
      }
    });
    window.addEventListener('beforeunload', () => stopCamera({ preserveRequest: false }));
  }

  async function submitLogin(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const selectedDealer = upper(form.get('dealerCode') || state.pendingLogin?.dealerCode || '');
    const login = clean(form.get('login') || state.pendingLogin?.login || '');
    const passwordOrPin = clean(form.get('passwordOrPin') || state.pendingLogin?.passwordOrPin || '');
    const deviceName = clean(form.get('deviceName')) || DEFAULT_DEVICE_NAME;

    if (!login) {
      byId('loginMessage').textContent = 'Enter your user ID.';
      return;
    }
    if (!passwordOrPin) {
      byId('loginMessage').textContent = 'Enter your password or PIN.';
      return;
    }
    if (!selectedDealer) {
      byId('loginMessage').textContent = 'Please select dealer code before login.';
      return;
    }

    const payload = {
      dealerCode: selectedDealer,
      login,
      passwordOrPin,
      deviceId: deviceId(),
      deviceName,
      appVersion: APP_VERSION,
      model: navigator.userAgent.slice(0, 120)
    };

    byId('loginMessage').textContent = 'Signing in...';
    try {
      const response = await api(state.loginUrl || '/api/auth/mobile-login', {
        method: 'POST',
        auth: false,
        body: payload
      });

      if (!response.dealerCode && response.needsDealerSelection && showDealerSelection(response, payload)) {
        return;
      }

      const session = {
        ...state.session,
        ...response,
        user: response.user || state.session?.user || null,
        token: response.token,
        deviceName,
        dealerCode: response.dealerCode || selectedDealer || payload.dealerCode || '',
        activeDealerId: response.activeDealerId || response.dealerCode || selectedDealer || payload.dealerCode || '',
        dealerName: response.dealerName || state.session?.dealerName || '',
        activeAudit: response.activeAudit || state.session?.activeAudit || null,
        auditId: response.auditId || response.activeAudit?.auditId || state.session?.auditId || '',
        assignedDealers: response.assignedDealers || response.activeDealers || state.session?.assignedDealers || [],
        activeDealers: response.activeDealers || response.assignedDealers || state.session?.activeDealers || [],
        loginId: response.user?.username || login,
        userId: response.user?.id || response.user?.userId || '',
        userName: response.user?.name || response.user?.username || login,
        staffName: response.user?.name || response.user?.username || login,
        role: response.user?.role || ''
      };

      state.pendingLogin = null;
      saveSession(session);
      state.liveRecentRows = null;
      state.liveRecentRefreshPromise = null;
      state.liveRecentRefreshToken = Number(state.liveRecentRefreshToken || 0) + 1;
      updateLastScan(null);
      loadSmartBinSuggestionSettings({ force: true }).catch(() => undefined);
      byId('loginMessage').textContent = '';
      renderLoginDealers(response.dealerCode || selectedDealer || payload.dealerCode || '');
      state.cameraRequested = true;
      state.paused = false;
      updateScannerPanel();
      byId('cameraState').textContent = isSecureScannerContext()
        ? 'Ready to scan'
        : 'Camera blocked on this HTTP page. Use the secure scanner URL.';
      startTimers();
      requestAutoCameraStart({ focusBin: false });
      toast('Login successful', 'success');
      sendHeartbeat().catch(() => undefined);
      await Promise.allSettled([refreshSessionContext(), refreshHealth()]);
      renderAll();
    } catch (error) {
      if (showDealerSelectionError(error)) return;
      byId('loginMessage').textContent = error.message;
      toast(error.message, 'error');
    }
  }

  function showDealerSelection(response, payload) {
    const dealers = normalizeLoginDealers(response.loginDealers || response.assignedDealers || response.activeDealers || []);
    if (!dealers.length) return false;
    state.loginDealers = dealers;
    state.loginConfigLoading = false;
    state.loginConfigError = '';
    state.recommendedDealerCode = upper(payload.dealerCode || response.requestedDealer || state.recommendedDealerCode || '');
    renderLoginDealers(state.recommendedDealerCode || payload.dealerCode || '');
    byId('loginMessage').textContent = 'Select a dealer code, then tap Sign In again.';
    state.pendingLogin = {
      login: payload.login || payload.username || '',
      passwordOrPin: payload.passwordOrPin || payload.password || payload.pin || '',
      deviceName: payload.deviceName,
      dealerCode: upper(payload.dealerCode || response.requestedDealer || '')
    };
    byId('loginDealerSelect')?.focus();
    return true;
  }

  function showDealerSelectionError(error) {
    if (!error || !error.data || !error.data.needsDealerSelection) return false;
    const dealers = error.data.assignedDealers || error.data.activeDealers || [];
    if (!dealers.length) return false;
    showDealerSelection(error.data, state.pendingLogin || {});
    return true;
  }

  function startTimers() {
    clearTimeout(state.syncDelayTimer);
    clearInterval(state.syncTimer);
    clearInterval(state.recentRefreshTimer);
    clearInterval(state.heartbeatTimer);
    clearInterval(state.versionTimer);
    state.syncDelayTimer = null;
    state.syncTimer = setInterval(() => {
      if (document.hidden) return;
      syncQueue({ silent: true }).catch(() => undefined);
    }, SYNC_INTERVAL_MS);
    state.recentRefreshTimer = setInterval(() => {
      if (document.hidden) return;
      refreshLiveRecentScans({ force: true, reason: 'poll' }).catch(() => undefined);
    }, RECENT_REFRESH_INTERVAL_MS);
    state.heartbeatTimer = setInterval(() => {
      if (document.hidden) return;
      sendHeartbeat().catch(() => undefined);
    }, HEARTBEAT_INTERVAL_MS);
    state.versionTimer = setInterval(() => {
      if (!document.hidden) checkScannerBuild().catch(() => undefined);
    }, 60000);
    refreshLiveRecentScans({ force: true, reason: 'timer-start' }).catch(() => undefined);
    syncQueue({ silent: true }).catch(() => undefined);
    sendHeartbeat().catch(() => undefined);
    checkScannerBuild().catch(() => undefined);
  }

  async function clearSyncedRows() {
    const rows = sessionRows();
    const clearable = rows.filter((row) => CLEARABLE_STATUSES.has(rowStatus(row)));
    if (!clearable.length) {
      toast('No synced rows to clear', 'info');
      return;
    }
    if (!window.confirm(`Clear ${clearable.length} synced or duplicate local row(s)?`)) return;
    await Promise.all(clearable.map((row) => deleteRecord(row.scanId)));
    clearable.forEach((row) => removeStateRow(row.scanId));
    renderQueueBadgeCounts();
    renderHistoryRows();
    toast(`Cleared ${clearable.length} row(s)`, 'success');
  }

  function setMode(mode, { silent = false } = {}) {
    const nextMode = MODE_INFO[upper(mode)] ? upper(mode) : 'INWARD';
    saveMode(nextMode);
    renderModeButtons();
    renderModeMeta();
    renderModeFields();
    const info = currentModeInfo();
    if (state.scanning && !state.paused) {
      stopCamera({ preserveRequest: true });
      startCamera().catch((error) => toast(error.message || 'Camera failed to restart', 'error'));
    }
    if (info.requiresBin) {
      const activeBin = loadActiveBin();
      if (activeBin) {
        byId('manualBinLocation').value = activeBin;
      }
    }
    if (!state.scanning && state.cameraRequested && !state.paused && state.session?.token) {
      requestAutoCameraStart({ focusBin: info.requiresBin });
    }
    if (!silent) toast(`${info.label} mode selected`, 'info');
  }

  async function copyScanUrl() {
    const url = canonicalScanUrl();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const temp = document.createElement('input');
        temp.value = url;
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        temp.remove();
      }
      toast('Scanner URL copied', 'success');
    } catch (_) {
      toast(url, 'info');
    }
  }

  async function init() {
    bindEvents();
    bindManualSearch();
    renderUrlState();
    renderConnectionBadge();
    renderSessionHeader();
    renderServerSummary();
    setMode(state.mode, { silent: true });

    const configReady = refreshMobileConfig();
    const dbReady = openDb()
      .then(async (db) => {
        state.db = db;
        state.allRows = await getAllRecords().catch(() => []);
        return true;
      })
      .catch((error) => {
        state.db = null;
        state.allRows = [];
        toast('Local browser storage is unavailable. Scans may not persist offline.', 'warning');
        console.warn(error);
        return false;
      });

    await dbReady;
    nativeBarcodeDetector().catch(() => undefined);

    if (state.session?.token) {
      byId('loginPanel').classList.add('hidden');
      byId('scannerPanel').classList.remove('hidden');
      document.body.classList.add('scanner-active');
      state.cameraRequested = true;
      renderAll();
      byId('cameraState').textContent = isSecureScannerContext()
        ? 'Ready to scan'
        : 'Camera is blocked on this HTTP page. Use the secure scanner URL.';
      requestAutoCameraStart({ focusBin: false });
    } else {
      byId('scannerPanel').classList.add('hidden');
      byId('loginPanel').classList.remove('hidden');
      document.body.classList.remove('scanner-active');
      renderAll();
    }

    await configReady;
    renderUrlState();
    renderConnectionBadge();
    renderSessionHeader();
    renderServerSummary();

    if (state.session?.token) {
      loadSmartBinSuggestionSettings({ force: true }).catch(() => undefined);
      startTimers();
      await Promise.allSettled([refreshSessionContext(), refreshHealth()]);
      state.allRows = await getAllRecords().catch(() => []);
      renderAll();
    } else {
      await refreshHealth();
      renderAll();
    }
  }

  init().catch((error) => {
    console.error(error);
    toast(error.message || 'Scanner failed to initialize', 'error');
  });
})();
