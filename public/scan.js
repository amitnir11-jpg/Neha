(function () {
  const APP_VERSION = 'Daksh Fresh Web Scanner v1.1.0';
  const CACHE_VERSION = '20260616-mobile-login-dealer-fix';
  const DB_NAME = 'daksh-fresh-scan';
  const STORE = 'queue';
  const SESSION_KEY = 'dakshFreshSession';
  const DEVICE_KEY = 'dakshFreshDeviceId';
  const MODE_KEY = 'dakshFreshMode';
  const CAMERA_KEY = 'dakshFreshCameraId';
  const BIN_KEY = 'dakshFreshActiveBin';
  const LAST_SYNC_KEY = 'dakshFreshLastSync';
  const SYNC_INTERVAL_MS = 45000;
  const HEARTBEAT_INTERVAL_MS = 90000;
  const BATCH_SIZE = 50;
  const DEDUPE_MS = 1200;
  const DEFAULT_DEVICE_NAME = 'Daksh Web Scanner';
  const LOCALHOST_NAMES = new Set(['localhost', '127.0.0.1', '::1']);

  const ZXING_SCRIPT_SRC = '/vendor/zxing/index.min.js?v=20260616-mobile-login-dealer-fix';

  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const byId = (id) => document.getElementById(id);

  const MODE_INFO = {
    INWARD: {
      label: 'Inward',
      requiresBin: true,
      note: 'Use for parts coming into stock.'
    },
    OUTWARD: {
      label: 'Outward',
      requiresBin: false,
      note: 'Bin is auto-detected by the backend.'
    },
    FITTED: {
      label: 'Fitted',
      requiresBin: false,
      note: 'Fill vehicle and job card details after the camera scan.'
    },
    DAMAGE: {
      label: 'Damage',
      requiresBin: true,
      note: 'Damaged stock needs a bin location.'
    },
    VERIFICATION: {
      label: 'Verification',
      requiresBin: false,
      note: 'Quick verification scan. Part number is enough.'
    }
  };

  const state = {
    db: null,
    session: loadSession(),
    canonicalUrl: '',
    mode: loadMode(),
    allRows: [],
    scanReader: null,
    cameraRequested: false,
    scanning: false,
    paused: false,
    saveInFlight: false,
    syncRunning: false,
    syncAgain: false,
    syncTimer: null,
    heartbeatTimer: null,
    cameraTimer: null,
    lastDecodeAtByKey: new Map(),
    recentCleanupTimer: null,
    manualRaw: '',
    manualResumeAfterClose: false,
    manualMode: loadMode(),
    cameraDevices: [],
    selectedCameraId: storageGet(CAMERA_KEY, ''),
    health: null,
    healthStatus: 'checking',
    healthMessage: '',
    authReady: false,
    zxingPromise: null,
    loginDealers: [],
    loginBusy: false
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

  function normalizeText(value) {
    return upper(String(value ?? '').replace(/\s+/g, ' ').trim());
  }

  function parsePartCandidate(raw = '') {
    const text = clean(raw).toUpperCase();
    if (!text) return '';

    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        const fromObject = clean(
          parsed.partNumber ||
          parsed.partNo ||
          parsed.part ||
          parsed.sku ||
          parsed.itemCode ||
          parsed.code ||
          ''
        );
        if (fromObject) return upper(fromObject);
      }
    } catch (_) {}

    const patterns = [
      /(?:PART\s*NO|PART\s*NUMBER|PART|PN|SKU|ITEM)\s*[:=#-]?\s*([A-Z0-9._\/-]+)/i,
      /"partNumber"\s*:\s*"([^"]+)"/i,
      /"partNo"\s*:\s*"([^"]+)"/i,
      /"part"\s*:\s*"([^"]+)"/i,
      /"sku"\s*:\s*"([^"]+)"/i
    ];

    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (match && match[1]) return upper(match[1]);
    }

    const compact = text.replace(/[^A-Z0-9._\/-]+/g, ' ').trim();
    const collapsed = compact.replace(/\s+/g, '');
    if (/^[A-Z0-9][A-Z0-9._\/-]{2,39}$/.test(collapsed)) return collapsed;
    if (compact && compact.length <= 60) return compact;
    return text.slice(0, 60);
  }

  function parseRawPreview(raw = '') {
    const text = clean(raw);
    if (!text) return '';
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
  }

  function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    const body = options.body && typeof options.body === 'object' && !(options.body instanceof FormData)
      ? JSON.stringify(options.body)
      : options.body;
    if (!(body instanceof FormData)) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    if (state.session?.token && options.auth !== false) headers.Authorization = `Bearer ${state.session.token}`;

    return fetch(path, { ...options, headers, body }).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) {
        const error = new Error(data.message || response.statusText || 'Request failed');
        error.status = response.status;
        error.data = data;
        throw error;
      }
      return data;
    });
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

  function setLoginMessage(message = '', kind = '') {
    const node = byId('loginMessage');
    if (!node) return;
    node.textContent = message;
    node.className = kind ? `field-message ${kind}` : 'field-message';
  }

  function setLoginBusy(isBusy) {
    state.loginBusy = Boolean(isBusy);
    const button = byId('loginForm')?.querySelector('.login-btn');
    if (!button) return;
    button.disabled = state.loginBusy;
    button.textContent = state.loginBusy ? 'Signing In...' : 'Sign In';
  }

  function renderLoginDealerOptions(dealers = []) {
    const select = byId('loginDealerSelect');
    if (!select) return;
    const current = upper(select.value || '');
    const options = ['<option value="">Select dealer code</option>'];
    dealers.forEach((dealer) => {
      const code = upper(dealer.dealerCode || dealer.code || dealer.id || '');
      if (!code) return;
      const name = clean(dealer.dealerName || dealer.name || '');
      options.push(`<option value="${escapeHtml(code)}">${escapeHtml(code)}${name ? ` - ${escapeHtml(name)}` : ''}</option>`);
    });
    select.innerHTML = options.join('');
    if (current && Array.from(select.options).some((option) => upper(option.value) === current)) {
      select.value = current;
    } else if (state.session?.dealerCode) {
      select.value = upper(state.session.dealerCode);
    }
  }

  function updateLoginDealerMode(useManualFallback = false) {
    const selectLabel = byId('dealerSelectLabel');
    const manualLabel = byId('dealerCodeInputLabel');
    if (selectLabel) selectLabel.classList.remove('hidden');
    if (manualLabel) manualLabel.classList.toggle('hidden', !useManualFallback);
    const select = byId('loginDealerSelect');
    if (select) select.disabled = Boolean(useManualFallback);
  }

  async function loadLoginDealers() {
    try {
      const data = await api('/api/mobile/public-dealers', { auth: false });
      state.loginDealers = Array.isArray(data.dealers) ? data.dealers : [];
      renderLoginDealerOptions(state.loginDealers);
      updateLoginDealerMode(state.loginDealers.length === 0);
      if (state.loginDealers.length) {
        setLoginMessage('Select your dealer code, then sign in.');
      } else {
        setLoginMessage('Dealer list unavailable. Enter dealer code manually.', 'warning');
      }
      return state.loginDealers;
    } catch (error) {
      state.loginDealers = [];
      renderLoginDealerOptions([]);
      updateLoginDealerMode(true);
      setLoginMessage(error.message || 'Dealer list unavailable. Enter dealer code manually.', 'warning');
      return [];
    }
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

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        const store = db.createObjectStore(STORE, { keyPath: 'scanId' });
        store.createIndex('status', 'status');
        store.createIndex('syncStatus', 'syncStatus');
        store.createIndex('timestamp', 'timestamp');
        store.createIndex('dealerCode', 'dealerCode');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
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

  function rowStatus(row = {}) {
    return clean(row.syncStatus || row.status || 'pending').toLowerCase();
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

  function renderUrlState() {
    const url = canonicalScanUrl();
    state.canonicalUrl = url;
    const scannerUrlText = byId('scannerUrlText');
    if (scannerUrlText) scannerUrlText.textContent = url;
    const openScanUrl = byId('openScanUrl');
    if (openScanUrl) openScanUrl.href = url;
    const copyUrlBtn = byId('copyUrlBtn');
    if (copyUrlBtn) copyUrlBtn.dataset.url = url;
    const copyScannerUrlBtn = byId('copyScannerUrlBtn');
    if (copyScannerUrlBtn) copyScannerUrlBtn.dataset.url = url;
    const notice = byId('contextNotice');
    const secure = isSecureScannerContext();
    const secureBadge = byId('secureBadge');
    if (secureBadge) {
      secureBadge.textContent = secure ? 'Secure' : 'Insecure';
      secureBadge.className = `status-pill ${secure ? 'online' : 'warning'}`;
    }

    const health = state.health || {};
    const dbOnline = health.mongoStatus === 'online' || health.mongodb === 'online' || health.db === 'connected';
    const dbBadge = byId('dbBadge');
    if (dbBadge) {
      if (state.healthStatus === 'checking') {
        dbBadge.textContent = 'Checking...';
        dbBadge.className = 'status-pill neutral';
      } else if (dbOnline || state.healthStatus === 'online') {
        dbBadge.textContent = 'Database connected';
        dbBadge.className = 'status-pill online';
      } else {
        dbBadge.textContent = 'Database offline';
        dbBadge.className = 'status-pill warning';
      }
    }

    if (notice) {
      notice.hidden = false;
      if (state.healthStatus === 'checking') {
        notice.textContent = 'Checking database connection...';
      } else if (state.healthStatus === 'offline' || (state.health && !dbOnline)) {
        notice.textContent = state.healthMessage || 'Server not reachable. Please check internet or try again.';
      } else if (secure) {
        notice.textContent = 'Sign in with your inventory credentials to open the live scanner.';
      } else {
        notice.textContent = 'Open the secure scanner URL to enable camera access on this phone.';
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
    if (health.mongoStatus || health.mongodb) parts.push(`DB ${health.mongoStatus || health.mongodb}`);
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
      ? info.note
      : 'Camera access is blocked on non-HTTPS pages. Use the secure Railway scanner URL.';
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
    const qtyWrap = byId('manualQtyWrap');
    const regWrap = byId('manualRegWrap');
    const jobWrap = byId('manualJobWrap');
    const qtyInput = byId('manualQty');
    const mrpInput = byId('manualMrp');
    const binInput = byId('manualBinLocation');
    const regInput = byId('manualRegdNo');
    const jobInput = byId('manualJobCardNo');

    binWrap.classList.toggle('hidden', !info.requiresBin);
    mrpWrap.classList.toggle('hidden', verification);
    qtyWrap.classList.toggle('hidden', verification);
    regWrap.classList.toggle('hidden', !fitted);
    jobWrap.classList.toggle('hidden', !fitted);

    binInput.required = info.requiresBin;
    qtyInput.required = !verification;
    mrpInput.required = !verification;
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
        : 'Enter a bin location before starting inward or damage scanning.';
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
    if (state.scanning) stopCamera({ preserveRequest: true });
    state.cameraRequested = true;
    cameraState('Enter a bin location before scanning this mode.');
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

  function renderHistoryRows() {
    const rows = sessionRows().slice(0, 10);
    const body = byId('scanRows');
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="6">No scans yet</td></tr>';
      return;
    }
    body.innerHTML = rows.map((row) => {
      const status = rowStatus(row);
      const statusLabel = status === 'failed-duplicate' ? 'Duplicate' : status || 'pending';
      const time = fmtTime(row.mobileCreatedAt || row.timestamp || row.createdAt);
      const title = escapeHtml(row.syncError || '');
      return `
        <tr>
          <td>${escapeHtml(time)}</td>
          <td>${escapeHtml(rowPart(row))}</td>
          <td>${escapeHtml(fmtNumber(rowQty(row)))}</td>
          <td>${escapeHtml(rowMode(row))}</td>
          <td>${escapeHtml(rowBin(row) || '-')}</td>
          <td title="${title}">${escapeHtml(statusLabel)}</td>
        </tr>
      `;
    }).join('');
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
    byId('loginPanel').classList.toggle('hidden', loggedIn);
    byId('scannerPanel').classList.toggle('hidden', !loggedIn);
    if (!loggedIn) return;
    renderAll();
  }

  function cameraState(text) {
    byId('cameraState').textContent = text;
  }

  function stopCamera({ preserveRequest = false } = {}) {
    if (state.scanReader) {
      try {
        state.scanReader.stopContinuousDecode();
      } catch (_) {}
      try {
        state.scanReader.reset();
      } catch (_) {}
    }
    const video = byId('cameraPreview');
    if (video) {
      try {
        video.pause();
      } catch (_) {}
      video.srcObject = null;
    }
    clearTimeout(state.cameraTimer);
    state.cameraTimer = null;
    state.scanning = false;
    if (!preserveRequest) state.cameraRequested = false;
    cameraState(state.paused ? 'Paused' : preserveRequest ? 'Camera stopped' : 'Camera stopped');
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
    state.scanReader = new BrowserMultiFormatReader(hints, 120);
    return state.scanReader;
  }

  function setSelectedCamera(deviceIdValue) {
    state.cameraDevices = state.cameraDevices || [];
    state.selectedCameraId = deviceIdValue || '';
    storageSet(CAMERA_KEY, state.selectedCameraId);
    const select = byId('cameraSelect');
    if (select) select.value = state.selectedCameraId;
  }

  function preferredCameraId(devices = []) {
    const selected = state.selectedCameraId || storageGet(CAMERA_KEY, '');
    if (selected && devices.some((device) => device.deviceId === selected)) return selected;
    const preferred = devices.find((device) => /back|rear|environment|world/i.test(device.label || ''));
    return preferred ? preferred.deviceId : (devices[0] ? devices[0].deviceId : '');
  }

  async function refreshCameraList() {
    let devices = [];
    try {
      const reader = await ensureReader();
      devices = await reader.listVideoInputDevices();
    } catch (error) {
      try {
        devices = await navigator.mediaDevices.enumerateDevices();
        devices = devices.filter((item) => item.kind === 'videoinput').map((item) => ({
          deviceId: item.deviceId,
          label: item.label || 'Camera'
        }));
      } catch (_) {
        devices = [];
      }
    }
    state.cameraDevices = devices;
    const select = byId('cameraSelect');
    if (!select) return;
    if (devices.length <= 1) {
      select.classList.add('hidden');
      select.innerHTML = '';
      return;
    }
    select.classList.remove('hidden');
    select.innerHTML = devices.map((device, index) => {
      const label = clean(device.label || `Camera ${index + 1}`);
      return `<option value="${escapeHtml(device.deviceId)}">${escapeHtml(label)}</option>`;
    }).join('');
    setSelectedCamera(preferredCameraId(devices));
  }

  function createScanRecord({ rawText = '', manual = false, partNumber = '', qty = 1, mrp = '', binLocation = '', regdNo = '', jobCardNo = '' } = {}) {
    const timestamp = nowIso();
    const scanType = currentScanType();
    const part = normalizeText(partNumber || parsePartCandidate(rawText));
    const scanId = `SCAN-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`.toUpperCase();
    const sourceType = manual ? 'manual' : 'mobile';
    const record = {
      scanId,
      uniqueScanId: scanId,
      clientScanId: scanId,
      localId: scanId,
      syncKey: scanId,
      clientSyncKey: scanId,
      rawScanString: rawText,
      rawScan: rawText,
      rawBarcode: rawText,
      rawUpi: rawText,
      rawQR: rawText,
      partNumber: part,
      normalizedPartNumber: part,
      part: part,
      qty: scanType === 'VERIFICATION' ? 1 : Number(qty || 1) || 1,
      quantity: scanType === 'VERIFICATION' ? 1 : Number(qty || 1) || 1,
      mrp: manual && Number(mrp) > 0 ? Number(mrp) : undefined,
      manualMRP: manual && Number(mrp) > 0 ? Number(mrp) : undefined,
      mrpProvided: manual && Number(mrp) > 0,
      binLocation: upper(binLocation),
      bin: upper(binLocation),
      regdNo: upper(regdNo),
      jobCardNo: upper(jobCardNo),
      dealerCode: activeDealerCode(),
      dealerName: activeDealerName(),
      auditId: activeAuditId(),
      deviceId: deviceId(),
      deviceName: clean(state.session?.deviceName || DEFAULT_DEVICE_NAME),
      userId: clean(state.session?.user?.id || ''),
      loginId: clean(state.session?.user?.username || state.session?.loginId || ''),
      userName: clean(state.session?.user?.name || state.session?.user?.username || state.session?.userName || ''),
      staffName: clean(state.session?.user?.name || state.session?.user?.username || state.session?.staffName || ''),
      role: clean(state.session?.user?.role || state.session?.role || ''),
      scanType,
      type: scanType,
      scanSource: sourceType,
      source: { source: sourceType, scanSource: sourceType },
      entryMode: manual ? 'manual' : 'camera',
      entryChannel: 'web',
      appVersion: APP_VERSION,
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

  function updateLastScan(row = {}) {
    const part = rowPart(row);
    const mode = rowMode(row);
    const status = rowStatus(row);
    const qty = rowQty(row);
    const bin = rowBin(row);
    const mrp = Number(row.mrp ?? row.manualMRP ?? row.scanMRP ?? 0);
    byId('lastScanTitle').textContent = part || 'Scan captured';
    byId('lastScanMeta').textContent = [
      mode,
      `Qty ${fmtNumber(qty)}`,
      bin ? `Bin ${bin}` : '',
      mrp > 0 ? `MRP ${fmtNumber(mrp)}` : '',
      status === 'synced' ? 'Synced to server' : status === 'duplicate' || status === 'failed-duplicate' ? 'Duplicate rejected' : status === 'failed' ? 'Sync failed' : 'Queued for sync'
    ].filter(Boolean).join(' · ');
  }

  function applyRecordToUi(record) {
    updateLastScan(record);
    renderAll();
  }

  async function saveRecord(record, { silent = false } = {}) {
    await putRecord(record);
    state.allRows = await getAllRecords();
    applyRecordToUi(record);
    if (!silent) {
      toast(state.paused ? 'Saved locally' : navigator.onLine ? 'Saved locally. Sync starting...' : 'Saved locally. Will sync when online.', 'success');
      beep('ok');
      vibrate(40);
    }
    if (navigator.onLine && state.session?.token) scheduleSync();
  }

  function scheduleSync() {
    if (!navigator.onLine || !state.session?.token) return;
    clearTimeout(state.syncTimer);
    state.syncTimer = setTimeout(() => {
      syncQueue({ silent: true }).catch(() => undefined);
    }, 900);
  }

  function recordStatusCounts(rows) {
    const statuses = rows.map((row) => rowStatus(row));
    const pending = statuses.filter((status) => status === 'pending').length;
    const synced = statuses.filter((status) => status === 'synced').length;
    const failed = statuses.filter((status) => ['failed', 'failed-duplicate', 'invalid', 'duplicate', 'rejected'].includes(status)).length;
    return { total: rows.length, pending, synced, failed };
  }

  function convertToSyncPayload(row = {}) {
    const timestamp = row.timestamp || row.scanTime || row.mobileCreatedAt || nowIso();
    return {
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
      partNumber: row.partNumber || row.part || '',
      normalizedPartNumber: row.normalizedPartNumber || row.partNumber || row.part || '',
      part: row.part || row.partNumber || '',
      qty: row.qty ?? row.quantity ?? 1,
      quantity: row.quantity ?? row.qty ?? 1,
      mrp: row.mrp,
      manualMRP: row.manualMRP,
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
      scanSource: row.scanSource || 'mobile',
      source: row.source || { source: row.scanSource || 'mobile', scanSource: row.scanSource || 'mobile' },
      entryMode: row.entryMode || 'camera',
      entryChannel: row.entryChannel || 'web',
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

  async function refreshHealth(timeoutMs = 2000) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    state.healthStatus = 'checking';
    state.healthMessage = '';
    renderAll();
    try {
      const health = await api('/api/health', { auth: false, signal: controller ? controller.signal : undefined });
      state.health = health;
      const dbOnline = health.mongoStatus === 'online' || health.mongodb === 'online' || health.db === 'connected';
      state.healthStatus = dbOnline ? 'online' : 'offline';
      state.healthMessage = dbOnline ? '' : 'Server not reachable. Please check internet or try again.';
      if (health.mobileScannerUrl) {
        state.canonicalUrl = health.mobileScannerUrl;
      }
      renderAll();
      return health;
    } catch (error) {
      state.health = null;
      state.healthStatus = 'offline';
      state.healthMessage = error && error.name === 'AbortError'
        ? 'Server not reachable. Please check internet or try again.'
        : (error.message || 'Server not reachable. Please check internet or try again.');
      renderAll();
      return null;
    } finally {
      if (timer) clearTimeout(timer);
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
      }
      renderAll();
      return data;
    } catch (error) {
      if (authExpired(error)) {
        handleAuthExpired(error);
        return null;
      }
      return null;
    }
  }

  function resetScannerSession() {
    stopCamera({ preserveRequest: false });
    clearInterval(state.syncTimer);
    clearInterval(state.heartbeatTimer);
    setLoginBusy(false);
    state.syncTimer = null;
    state.heartbeatTimer = null;
    clearSession();
    state.allRows = [];
    state.manualRaw = '';
    state.manualResumeAfterClose = false;

    const loginForm = byId('loginForm');
    if (loginForm) {
      loginForm.reset();
      if (loginForm.elements.deviceName) loginForm.elements.deviceName.value = DEFAULT_DEVICE_NAME;
      if (loginForm.elements.secret) loginForm.elements.secret.value = '';
      if (loginForm.elements.dealerCode) loginForm.elements.dealerCode.value = '';
      if (loginForm.elements.dealerCodeManual) loginForm.elements.dealerCodeManual.value = '';
    }

    const dealerSelect = byId('loginDealerSelect');
    if (dealerSelect) dealerSelect.value = '';
    updateLoginDealerMode(state.loginDealers.length === 0);

    updateScannerPanel();
    renderAll();

    setLoginMessage('Select a dealer code, then sign in.');
  }

  function handleAuthExpired(error) {
    resetScannerSession();
    toast(error?.message || 'Login expired. Please sign in again.', 'error');
  }

  function logout() {
    resetScannerSession();
    toast('Signed out', 'info');
  }

  function ensureScanSession() {
    if (!state.session?.token) {
      toast('Please login first', 'error');
      return false;
    }
    return true;
  }

  async function startCamera() {
    if (!ensureScanSession()) return;
    if (!isSecureScannerContext() && !LOCALHOST_NAMES.has(window.location.hostname)) {
      cameraState('Open the secure Railway URL to use the camera.');
      return;
    }
    if (requiresBin() && !ensureActiveBinReady()) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      cameraState('Camera API unavailable. Use manual entry.');
      return;
    }
    stopCamera({ preserveRequest: true });
    state.cameraRequested = true;
    state.paused = false;
    state.scanning = true;
    const video = byId('cameraPreview');
    const selected = state.selectedCameraId || preferredCameraId(state.cameraDevices || []);
    cameraState('Loading scanner library...');
    try {
      const reader = await ensureReader();
      cameraState('Starting camera...');
      const promise = reader.decodeFromVideoDevice(selected || null, video, (result) => {
        if (result) handleDecodeResult(result);
      });
      promise.catch((error) => {
        if (state.scanning) {
          state.scanning = false;
          const message = error?.message || 'Camera failed to start';
          cameraState(message);
          toast(message, 'error');
        }
      });
      state.cameraTimer = setTimeout(() => {
        if (state.scanning) cameraState('Scanning');
      }, 400);
      renderCameraListSoon();
    } catch (error) {
      state.scanning = false;
      cameraState(error.message || 'Camera failed to start');
      toast(error.message || 'Camera failed to start', 'error');
    }
  }

  function renderCameraListSoon() {
    clearTimeout(state.recentCleanupTimer);
    state.recentCleanupTimer = setTimeout(() => {
      refreshCameraList().catch(() => undefined);
    }, 700);
  }

  function handleDecodeResult(result) {
    const raw = clean(typeof result?.getText === 'function' ? result.getText() : result?.text || result?.rawValue || result);
    if (!raw || state.saveInFlight) return;
    const key = `${state.mode}|${raw}`;
    const lastSeen = state.lastDecodeAtByKey.get(key) || 0;
    if (Date.now() - lastSeen < DEDUPE_MS) return;
    state.lastDecodeAtByKey.set(key, Date.now());
    if (state.lastDecodeAtByKey.size > 40) {
      for (const [entryKey, timestamp] of state.lastDecodeAtByKey.entries()) {
        if (Date.now() - timestamp > 30000) state.lastDecodeAtByKey.delete(entryKey);
      }
    }
    void processDecodedText(raw);
  }

  async function processDecodedText(raw) {
    if (state.saveInFlight) return;
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
    const partCandidate = parsePartCandidate(raw);
    if (requiresBin() && !ensureActiveBinReady()) {
      return;
    }
    const record = createScanRecord({
      rawText: raw,
      manual: false,
      partNumber: partCandidate,
      binLocation: requiresBin() ? loadActiveBin() : ''
    });
    state.saveInFlight = true;
    try {
      await saveRecord(record);
      cameraState('Scan captured');
      byId('manualRawPreview').hidden = true;
    } catch (error) {
      toast(error.message || 'Unable to save scan', 'error');
      vibrate([30, 30, 30]);
    } finally {
      state.saveInFlight = false;
    }
  }

  async function syncQueue({ silent = false } = {}) {
    if (state.syncRunning) {
      state.syncAgain = true;
      return;
    }
    if (!state.session?.token || !navigator.onLine) return;
    const rows = sessionRows().filter((row) => ['pending', 'failed', 'failed-duplicate'].includes(rowStatus(row)));
    if (!rows.length) {
      renderAll();
      return;
    }
    const batch = rows.slice(0, BATCH_SIZE);
    state.syncRunning = true;
    try {
      const response = await api('/api/mobile/sync-batch', {
        method: 'POST',
        body: {
          deviceId: deviceId(),
          deviceName: clean(state.session?.deviceName || DEFAULT_DEVICE_NAME),
          dealerCode: activeDealerCode(),
          dealerName: activeDealerName(),
          appVersion: APP_VERSION,
          serverUrl: window.location.origin.replace(/\/+$/, ''),
          records: batch.map(convertToSyncPayload)
        }
      });

      const inserted = new Map((response.insertedRecords || []).map((row) => [
        clean(row.clientScanId || row.localId || row.scanId || row.uniqueScanId),
        row
      ]));
      const logs = Array.isArray(response.logs) ? response.logs : [];
      const duplicateLogs = new Map(logs
        .filter((log) => log.status === 'duplicate')
        .map((log) => [clean(log.clientScanId || log.localId || log.mobileScanId || log.scanId), clean(log.errorMessage || log.reason || 'Duplicate rejected')]));
      const failedLogs = new Map(logs
        .filter((log) => log.status === 'failed' || log.status === 'invalid')
        .map((log) => [clean(log.clientScanId || log.localId || log.mobileScanId || log.scanId), clean(log.errorMessage || log.reason || response.message || 'Sync failed')]));

      for (const row of batch) {
        const key = clean(row.scanId);
        const saved = inserted.get(key) || inserted.get(clean(row.clientScanId || '')) || inserted.get(clean(row.uniqueScanId || ''));
        if (saved) {
          await putRecord({
            ...row,
            status: 'synced',
            syncStatus: 'synced',
            syncError: '',
            retryCount: Number(row.retryCount || 0),
            serverAck: saved,
            timestamp: saved.timestamp || row.timestamp,
            mobileCreatedAt: row.mobileCreatedAt || saved.timestamp || row.timestamp
          });
          updateLastScan({ ...row, status: 'synced', syncStatus: 'synced' });
          continue;
        }
        if (duplicateLogs.has(key) || duplicateLogs.has(clean(row.clientScanId || ''))) {
          const message = duplicateLogs.get(key) || duplicateLogs.get(clean(row.clientScanId || ''));
          await putRecord({
            ...row,
            status: 'duplicate',
            syncStatus: 'duplicate',
            syncError: message,
            retryCount: Number(row.retryCount || 0)
          });
          if (!silent) toast(message, 'warning');
          continue;
        }
        if (failedLogs.has(key) || failedLogs.has(clean(row.clientScanId || ''))) {
          const message = failedLogs.get(key) || failedLogs.get(clean(row.clientScanId || ''));
          await putRecord({
            ...row,
            status: 'failed',
            syncStatus: 'failed',
            syncError: message,
            retryCount: Number(row.retryCount || 0) + 1
          });
          continue;
        }
        if (response.success) {
          await putRecord({
            ...row,
            status: 'synced',
            syncStatus: 'synced',
            syncError: '',
            retryCount: Number(row.retryCount || 0)
          });
        }
      }

      storageSet(LAST_SYNC_KEY, nowIso());
      if (!silent) toast(response.message || 'Sync complete', 'success');
      sendHeartbeat().catch(() => undefined);
      if (response.duplicateCount && !silent) {
        toast(`${response.duplicateCount} duplicate scan(s) skipped`, 'warning');
      }
    } catch (error) {
      if (authExpired(error)) {
        handleAuthExpired(error);
        return;
      }
      const retryable = !Number(error.status) || Number(error.status) >= 500 || Number(error.status) === 408 || Number(error.status) === 429;
      const logs = Array.isArray(error.data?.logs) ? error.data.logs : [];
      const failedMap = new Map(logs
        .filter((log) => log.status === 'failed' || log.status === 'invalid')
        .map((log) => [clean(log.clientScanId || log.localId || log.mobileScanId || log.scanId), clean(log.errorMessage || log.reason || error.message)]));
      const duplicateMap = new Map(logs
        .filter((log) => log.status === 'duplicate')
        .map((log) => [clean(log.clientScanId || log.localId || log.mobileScanId || log.scanId), clean(log.errorMessage || log.reason || error.message)]));

      for (const row of batch) {
        const key = clean(row.scanId);
        if (duplicateMap.has(key)) {
          await putRecord({
            ...row,
            status: 'duplicate',
            syncStatus: 'duplicate',
            syncError: duplicateMap.get(key),
            retryCount: Number(row.retryCount || 0)
          });
        } else if (failedMap.has(key)) {
          await putRecord({
            ...row,
            status: retryable ? 'pending' : 'failed',
            syncStatus: retryable ? 'pending' : 'failed',
            syncError: failedMap.get(key),
            retryCount: Number(row.retryCount || 0) + 1
          });
        } else {
          await putRecord({
            ...row,
            status: retryable ? 'pending' : 'failed',
            syncStatus: retryable ? 'pending' : 'failed',
            syncError: error.message,
            retryCount: Number(row.retryCount || 0) + 1
          });
        }
      }
      if (!silent) toast(retryable ? 'Network/server issue. Scans remain queued.' : error.message, retryable ? 'warning' : 'error');
    } finally {
      state.syncRunning = false;
      state.allRows = await getAllRecords().catch(() => []);
      renderAll();
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
    const mrp = Number(String(form.get('mrp') || '').replace(/,/g, '').trim());
    const binLocation = upper(form.get('binLocation') || '');
    const regdNo = upper(form.get('regdNo') || '');
    const jobCardNo = upper(form.get('jobCardNo') || '');

    if (mode !== 'VERIFICATION' && !Number.isFinite(mrp) && !Number.isFinite(Number(form.get('mrp')))) {
      toast('Enter a valid MRP or use a QR/barcode scan', 'error');
      byId('manualMrp').focus();
      return;
    }

    if (mode !== 'VERIFICATION' && Number.isFinite(mrp) && mrp <= 0) {
      toast('MRP must be greater than zero for manual entry', 'error');
      byId('manualMrp').focus();
      return;
    }

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
    const record = createScanRecord({
      rawText,
      manual: true,
      partNumber,
      qty: mode === 'VERIFICATION' ? 1 : qty,
      mrp: mode === 'VERIFICATION' ? '' : mrp,
      binLocation,
      regdNo,
      jobCardNo
    });

    state.saveInFlight = true;
    try {
      await saveRecord(record);
      closeManualDialog();
      updateLastScan(record);
      toast('Manual scan saved', 'success');
    } catch (error) {
      toast(error.message || 'Manual save failed', 'error');
      vibrate([30, 30, 30]);
    } finally {
      state.saveInFlight = false;
    }
  }

  function bindEvents() {
    byId('copyUrlBtn')?.addEventListener('click', () => copyScanUrl());
    byId('copyScannerUrlBtn')?.addEventListener('click', () => copyScanUrl());
    byId('loginForm').addEventListener('submit', (event) => {
      void submitLogin(event);
    });
    byId('logoutBtn')?.addEventListener('click', () => logout());
    byId('saveBinBtn').addEventListener('click', () => {
      const bin = setActiveBin(byId('activeBinLocation').value);
      if (bin) {
        toast(`Bin ${bin} saved`, 'success');
        if (state.cameraRequested && !state.paused) {
          startCamera().catch((error) => toast(error.message || 'Camera failed to start', 'error'));
        }
      } else {
        toast('Enter a bin location first', 'error');
        byId('activeBinLocation').focus();
      }
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
      state.paused = false;
      state.cameraRequested = true;
      startCamera().catch((error) => toast(error.message || 'Camera failed to start', 'error'));
    });
    byId('pauseScanBtn').addEventListener('click', () => {
      state.paused = true;
      state.cameraRequested = true;
      stopCamera({ preserveRequest: true });
      cameraState('Paused');
    });
    byId('resumeScanBtn').addEventListener('click', () => {
      state.paused = false;
      state.cameraRequested = true;
      startCamera().catch((error) => toast(error.message || 'Camera failed to resume', 'error'));
    });
    byId('manualBtn').addEventListener('click', () => openManualDialog({}));
    byId('syncNowBtn').addEventListener('click', () => {
      syncQueue({ silent: false }).catch((error) => toast(error.message || 'Sync failed', 'error'));
    });
    byId('clearSyncedBtn').addEventListener('click', () => clearSyncedRows());
    byId('refreshCamerasBtn').addEventListener('click', () => refreshCameraList().catch((error) => toast(error.message || 'Unable to refresh cameras', 'error')));
    byId('cameraSelect').addEventListener('change', (event) => {
      setSelectedCamera(event.target.value);
      if (state.scanning) {
        startCamera().catch((error) => toast(error.message || 'Camera restart failed', 'error'));
      }
    });
    byId('activeBinLocation').addEventListener('input', (event) => {
      event.target.value = upper(event.target.value);
    });
    qsa('.mode-btn').forEach((button) => {
      button.addEventListener('click', () => setMode(button.dataset.mode));
    });
    byId('manualCancelBtn').addEventListener('click', () => closeManualDialog());
    byId('manualCloseBtn').addEventListener('click', () => closeManualDialog());
    byId('manualForm').addEventListener('submit', (event) => {
      void submitManual(event);
    });
    window.addEventListener('online', () => {
      renderConnectionBadge();
      renderUrlState();
      if (state.session?.token) {
        refreshHealth().catch(() => undefined);
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
        startCamera().catch(() => undefined);
      }
    });
    window.addEventListener('pagehide', () => stopCamera({ preserveRequest: false }));
    window.addEventListener('beforeunload', () => stopCamera({ preserveRequest: false }));
  }

  async function submitLogin(event) {
    event.preventDefault();
    if (state.loginBusy) return;
    const form = new FormData(event.currentTarget);
    const selectedDealer = upper(form.get('dealerCode') || form.get('dealerCodeManual') || form.get('selectedDealerCode'));
    const username = clean(form.get('username'));
    const secret = String(form.get('secret') || form.get('password') || form.get('pin') || '');
    const deviceName = clean(form.get('deviceName')) || DEFAULT_DEVICE_NAME;

    console.log('Selected dealer:', selectedDealer);
    console.log('Mobile login payload:', {
      username,
      dealerCode: selectedDealer,
      passwordOrPin: secret ? '[masked]' : '',
      deviceId: deviceId(),
      deviceName,
      appVersion: APP_VERSION
    });

    if (!selectedDealer) {
      setLoginMessage('Please select dealer code before login.', 'error');
      toast('Please select dealer code before login.', 'error');
      return;
    }

    if (!username) {
      setLoginMessage('User ID is required.', 'error');
      toast('User ID is required', 'error');
      return;
    }

    if (!secret) {
      setLoginMessage('Password or PIN is required.', 'error');
      toast('Password or PIN is required', 'error');
      return;
    }

    const payload = {
      username,
      passwordOrPin: secret,
      secret,
      password: secret,
      pin: secret,
      dealerCode: selectedDealer,
      deviceId: deviceId(),
      deviceName,
      appVersion: APP_VERSION,
      model: navigator.userAgent.slice(0, 120)
    };

    setLoginBusy(true);
    setLoginMessage('Signing in...', 'loading');
    try {
      const response = await api('/api/mobile/login', {
        method: 'POST',
        auth: false,
        body: payload
      });
      console.log('Login response:', {
        success: response.success,
        dealerCode: response.dealerCode || selectedDealer,
        activeDealerId: response.activeDealerId || '',
        message: response.message || '',
        assignedDealers: Array.isArray(response.assignedDealers) ? response.assignedDealers.map((dealer) => ({
          dealerCode: dealer.dealerCode || dealer.code || dealer.id || '',
          dealerName: dealer.dealerName || dealer.name || ''
        })) : []
      });

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
        loginId: response.user?.username || username,
        userId: response.user?.id || response.user?.userId || '',
        userName: response.user?.name || response.user?.username || username,
        staffName: response.user?.name || response.user?.username || username,
        role: response.user?.role || ''
      };

      saveSession(session);
      state.allRows = await getAllRecords().catch(() => []);
      setLoginMessage(response.message || 'Login successful.', 'success');
      const dealerSelect = byId('loginDealerSelect');
      if (dealerSelect && session.dealerCode) dealerSelect.value = upper(session.dealerCode);
      state.cameraRequested = false;
      state.paused = false;
      updateScannerPanel();
      await refreshSessionContext();
      await refreshHealth();
      state.allRows = await getAllRecords().catch(() => []);
      renderAll();
      byId('cameraState').textContent = isSecureScannerContext()
        ? 'Tap Start Camera to begin scanning'
        : 'Camera is blocked on this HTTP page. Use the secure scanner URL.';
      startTimers();
      toast('Login successful', 'success');
      sendHeartbeat().catch(() => undefined);
    } catch (error) {
      const message = error?.data?.message || error.message || 'Login failed';
      setLoginMessage(message, 'error');
      toast(message, 'error');
    } finally {
      setLoginBusy(false);
    }
  }

  function startTimers() {
    clearInterval(state.syncTimer);
    clearInterval(state.heartbeatTimer);
    state.syncTimer = setInterval(() => {
      syncQueue({ silent: true }).catch(() => undefined);
    }, SYNC_INTERVAL_MS);
    state.heartbeatTimer = setInterval(() => {
      sendHeartbeat().catch(() => undefined);
    }, HEARTBEAT_INTERVAL_MS);
    syncQueue({ silent: true }).catch(() => undefined);
    sendHeartbeat().catch(() => undefined);
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
    state.allRows = await getAllRecords().catch(() => []);
    renderAll();
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
    try {
      state.db = await openDb();
    } catch (error) {
      toast('Local browser storage is unavailable. Scans may not persist offline.', 'warning');
      console.warn(error);
    }

    state.allRows = await getAllRecords().catch(() => []);
    bindEvents();
    bindManualSearch();
    setMode(state.mode, { silent: true });
    renderUrlState();
    renderConnectionBadge();
    renderSessionHeader();
    renderServerSummary();

    if (state.session?.token) {
      byId('loginPanel').classList.add('hidden');
      byId('scannerPanel').classList.remove('hidden');
      state.cameraRequested = false;
      await refreshSessionContext();
      await refreshHealth();
      state.allRows = await getAllRecords().catch(() => []);
      renderAll();
      startTimers();
      byId('cameraState').textContent = isSecureScannerContext()
        ? 'Tap Start Camera to begin scanning'
        : 'Camera is blocked on this HTTP page. Use the secure scanner URL.';
    } else {
      byId('scannerPanel').classList.add('hidden');
      byId('loginPanel').classList.remove('hidden');
      renderAll();
    }

    if (!state.session?.token) {
      await Promise.allSettled([loadLoginDealers(), refreshHealth()]);
    }

    if (state.session?.token) {
      state.allRows = await getAllRecords().catch(() => []);
      renderAll();
    }

    if (!state.session?.token) {
      updateLoginDealerMode(state.loginDealers.length === 0);
    }
  }

  init().catch((error) => {
    console.error(error);
    toast(error.message || 'Scanner failed to initialize', 'error');
  });
})();
