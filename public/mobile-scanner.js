(function () {
  const APP_VERSION = 'Daksh Mobile Web Scanner v1.0.0';
  const DB_NAME = 'daksh-mobile-scanner';
  const STORE = 'scans';
  const SESSION_KEY = 'dakshMobileSession';
  const DEVICE_KEY = 'dakshMobileDeviceId';
  const ACTIVE_BIN_KEY = 'dakshMobileActiveBinLocation';
  const LAST_SYNC_KEY = 'dakshMobileLastSync';
  const CACHE_VERSION_KEY = 'dakshMobileCacheVersion';
  const CACHE_VERSION = '20260530-sync-mrp-fix';
  const SYNC_INTERVAL_MS = 120000;
  const DUPLICATE_GUARD_MS = 1500;
  const BATCH_SIZE = 50;
  const SCAN_READY_DELAY_MS = 90;
  const SCAN_IDLE_DELAY_MS = 140;
  const SCAN_BLOCKED_DELAY_MS = 220;
  const DETECTION_REPEAT_SUPPRESS_MS = 1200;
  const CLEARABLE_CACHE_STATUSES = new Set(['synced', 'failed', 'failed-duplicate', 'duplicate', 'invalid', 'rejected']);

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const state = {
    db: null,
    session: readSession(),
    mode: 'INWARD',
    stream: null,
    detector: null,
    scanTimer: null,
    syncTimer: null,
    paused: false,
    syncing: false,
    syncAgain: false,
    scanProcessing: false,
    pendingLogin: null,
    recentRaw: new Map(),
    lastScanAtByRaw: new Map(),
    scanIdentityKeys: new Set(),
    socket: null,
    manualPart: null,
    activeBinLocation: ''
  };

  function clean(value) { return String(value || '').trim(); }
  function upper(value) { return clean(value).toUpperCase(); }
  function nowIso() { return new Date().toISOString(); }
  function deviceId() {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = `MOB-WEB-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`.toUpperCase();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  }

  function sessionUserKey(session = state.session) {
    const user = session?.user || {};
    return clean(user.id || user.username || user.email || user.name || session?.userId || session?.loginId).toLowerCase();
  }

  function sessionAuditId(session = state.session) {
    return clean(session?.activeAudit?.auditId || session?.auditId || '');
  }

  function sessionScopeKey(session = state.session) {
    const dealerCode = upper(session?.dealerCode || '');
    if (!dealerCode) return '';
    return [dealerCode, sessionAuditId(session) || 'audit', sessionUserKey(session) || 'user', deviceId()].join('|');
  }

  function scopedStorageKey(baseKey, session = state.session) {
    const scope = sessionScopeKey(session);
    return scope ? `${baseKey}:${scope}` : baseKey;
  }

  function rowDealerCode(row = {}) {
    return upper(row.dealerCode || row.dealer || row.dealerId || row.activeDealerId || row.serverAck?.dealerCode || '');
  }

  function scopeDealerCode(scopeKey = '') {
    return upper(String(scopeKey || '').split('|')[0] || '');
  }

  function rowStatus(row = {}) {
    return clean(row.status || row.syncStatus || '').toLowerCase();
  }

  function numberValue(value, fallback = 0) {
    const parsed = Number(String(value ?? '').replace(/,/g, '').trim());
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function scanMrp(row = {}) {
    const values = [row.mrp, row.valuationMRP, row.finalMRP, row.scanMRP, row.serverAck?.mrp, row.serverAck?.valuationMRP];
    for (const value of values) {
      const parsed = numberValue(value, 0);
      if (parsed > 0) return parsed;
    }
    return 0;
  }

  function money(value) {
    const amount = numberValue(value, 0);
    return amount ? amount.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '-';
  }

  function scanIdentityKey(scanIdentity, mode = state.mode, session = state.session) {
    const scope = sessionScopeKey(session);
    const identity = normalizeScanIdentity(scanIdentity);
    const scanMode = upper(mode || state.mode);
    return scope && identity && scanMode ? `${scope}|${scanMode}|${identity}` : '';
  }

  function readSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { return null; }
  }

  function saveSession(session) {
    state.session = session;
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  function clearSession() {
    state.session = null;
    localStorage.removeItem(SESSION_KEY);
  }

  function rowBelongsToSession(row = {}, session = state.session) {
    if (!session) return false;
    const sessionDealer = upper(session.dealerCode || session.activeDealerId || '');
    if (!sessionDealer) return false;
    const rowDealer = rowDealerCode(row);
    const scopedDealer = scopeDealerCode(row.scopeKey);
    if (rowDealer && rowDealer !== sessionDealer) return false;
    if (scopedDealer && scopedDealer !== sessionDealer) return false;
    if (!rowDealer && !scopedDealer) return false;
    const scope = sessionScopeKey(session);
    if (row.scopeKey) return row.scopeKey === scope;
    const currentAuditId = sessionAuditId(session);
    const rowAuditId = clean(row.auditId || row.serverAck?.auditId);
    if (currentAuditId && rowAuditId && rowAuditId !== currentAuditId) return false;
    if (currentAuditId && row.status === 'synced' && !rowAuditId) return false;
    const possibleUsers = new Set([
      clean(session.user?.id).toLowerCase(),
      clean(session.user?.username).toLowerCase(),
      clean(session.user?.email).toLowerCase(),
      clean(session.user?.name).toLowerCase()
    ].filter(Boolean));
    const rowUser = clean(row.loginId || row.userId || row.userName).toLowerCase();
    return !rowUser || possibleUsers.has(rowUser);
  }

  function readActiveBin(session = state.session) {
    return upper(localStorage.getItem(scopedStorageKey(ACTIVE_BIN_KEY, session)) || '');
  }

  function authExpired(error) {
    return error && (
      error.status === 401 ||
      /login required|invalid token|jwt expired|token expired/i.test(error.message || '')
    );
  }

  function authExpiredMessage() {
    return 'Auth expired: please login again';
  }

  function handleAuthExpired(error) {
    clearInterval(state.syncTimer);
    state.syncTimer = null;
    if (state.socket) {
      state.socket.disconnect();
      state.socket = null;
    }
    clearSession();
    updateShell();
    toast(authExpired(error) ? authExpiredMessage() : (error?.message || 'Login required'), 'error');
  }

  function tokenPayload(token) {
    try {
      const payload = String(token || '').split('.')[1] || '';
      if (!payload) return {};
      const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')));
    } catch (_) {
      return {};
    }
  }

  function sessionTokenExpired(session = state.session) {
    const exp = Number(tokenPayload(session?.token).exp || 0);
    return Boolean(exp && Date.now() >= (exp * 1000 - 30000));
  }

  function normalizeScanIdentity(value) {
    return upper(value).replace(/\s+/g, ' ');
  }

  function recordScanIdentity(row = {}) {
    return normalizeScanIdentity(row.scanIdentity || row.rawUPI || row.rawScanString || row.rawScan || row.barcode || row.upiId || row.upiNo);
  }

  function isRetryableSyncError(error) {
    const status = Number(error?.status || 0);
    return !status || status === 408 || status === 429 || status >= 500;
  }

  async function refreshSessionContext() {
    if (!state.session?.token || !state.session?.dealerCode) return;
    try {
      const query = new URLSearchParams({ dealerCode: state.session.dealerCode, deviceId: deviceId() });
      const data = await api(`/api/mobile/status?${query.toString()}`);
      if (data.activeAudit || data.auditId) {
        saveSession({
          ...state.session,
          activeAudit: data.activeAudit || state.session.activeAudit || null,
          auditId: data.activeAudit?.auditId || data.auditId || state.session.auditId || ''
        });
      }
    } catch (error) {
      if (authExpired(error)) handleAuthExpired(error);
    }
  }

  async function purgeOutOfScopeRows() {
    if (!state.session?.token) return;
    const rows = await getAllScans();
    const staleRows = rows.filter((row) => !rowBelongsToSession(row));
    await Promise.all(staleRows.map((row) => deleteScan(row.scanId)));
    if (staleRows.length) {
      localStorage.setItem(CACHE_VERSION_KEY, CACHE_VERSION);
      state.lastScanAtByRaw.clear();
    }
  }

  function toast(message, type = '') {
    const node = $('#toast');
    node.textContent = message;
    node.hidden = false;
    node.style.background = type === 'error' ? '#b42318' : type === 'success' ? '#087443' : '#101828';
    clearTimeout(node._timer);
    node._timer = setTimeout(() => { node.hidden = true; }, 2600);
  }

  function beep(type = 'ok') {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const ctx = beep.ctx || (beep.ctx = new AudioContext());
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = type === 'ok' ? 1040 : 220;
      gain.gain.value = 0.001;
      gain.gain.exponentialRampToValueAtTime(type === 'ok' ? 0.13 : 0.18, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (type === 'ok' ? 0.11 : 0.32));
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + (type === 'ok' ? 0.13 : 0.36));
    } catch (_) {}
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        const store = db.createObjectStore(STORE, { keyPath: 'scanId' });
        store.createIndex('status', 'status');
        store.createIndex('rawUPI', 'rawUPI');
        store.createIndex('mobileCreatedAt', 'mobileCreatedAt');
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

  async function putScan(record) {
    await requestToPromise(txStore('readwrite').put(record));
  }

  async function getAllScans() {
    return requestToPromise(txStore().getAll());
  }

  async function getScan(scanId) {
    return requestToPromise(txStore().get(scanId));
  }

  async function deleteScan(scanId) {
    await requestToPromise(txStore('readwrite').delete(scanId));
  }

  function rememberScanIdentity(row = {}) {
    if (rowStatus(row) === 'failed-duplicate') return;
    const key = scanIdentityKey(recordScanIdentity(row), row.scanType || row.type);
    if (key) state.scanIdentityKeys.add(key);
  }

  async function rebuildSessionScanIndex() {
    state.scanIdentityKeys.clear();
    if (!state.db || !state.session) return;
    const rows = await getAllScans();
    rows.filter((row) => rowBelongsToSession(row)).forEach(rememberScanIdentity);
  }

  async function counts() {
    const rows = await getAllScans();
    const scopedRows = rows.filter((row) => rowBelongsToSession(row));
    return {
      rows: scopedRows,
      pending: scopedRows.filter((row) => rowStatus(row) === 'pending').length,
      failed: scopedRows.filter((row) => rowStatus(row) === 'failed').length,
      synced: scopedRows.filter((row) => rowStatus(row) === 'synced').length
    };
  }

  function withDealerScopePath(path) {
    if (!state.session?.dealerCode || !String(path || '').startsWith('/api/')) return path;
    const url = new URL(path, window.location.origin);
    if (!url.searchParams.get('activeDealerId')) url.searchParams.set('activeDealerId', state.session.dealerCode);
    if (!url.searchParams.get('dealerCode')) url.searchParams.set('dealerCode', state.session.dealerCode);
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function withDealerScopeBody(body) {
    if (!state.session?.dealerCode || !body || typeof body !== 'object' || Array.isArray(body)) return body;
    return {
      ...body,
      activeDealerId: body.activeDealerId || state.session.dealerCode,
      dealerCode: body.dealerCode || state.session.dealerCode,
      auditId: body.auditId || sessionAuditId() || ''
    };
  }

  function api(path, options = {}) {
    const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
    if (state.session?.token) headers.authorization = `Bearer ${state.session.token}`;
    const body = withDealerScopeBody(options.body);
    return fetch(withDealerScopePath(path), {
      ...options,
      headers,
      body: body && typeof body !== 'string' ? JSON.stringify(body) : body
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        const error = new Error(data.message || `HTTP ${res.status}`);
        error.status = res.status;
        error.data = data;
        throw error;
      }
      return data;
    });
  }

  function updateShell() {
    const loggedIn = Boolean(state.session?.token);
    $('#loginView').classList.toggle('hidden', loggedIn);
    $('#scannerView').classList.toggle('hidden', !loggedIn);
    if (loggedIn) {
      $('#dealerLabel').textContent = `${state.session.dealerCode} - ${state.session.dealerName || 'Dealer'}`;
      $('#userLabel').textContent = `${state.session.user?.name || state.session.user?.username || 'User'} | ${deviceId()}`;
      renderDealerSwitch();
    }
    updateSyncUi().catch(() => undefined);
  }

  function sessionDealers() {
    return state.session?.assignedDealers || state.session?.activeDealers || [];
  }

  function dealerOptionLabel(dealer = {}) {
    const code = upper(dealer.dealerCode || dealer.code || dealer.id || '');
    const name = clean(dealer.dealerName || dealer.name || '');
    return code && name ? `${code} - ${name}` : code || name || 'Dealer';
  }

  function renderDealerSwitch() {
    const select = $('#mobileDealerSwitch');
    if (!select) return;
    const dealers = sessionDealers();
    select.hidden = dealers.length <= 1;
    if (select.hidden) return;
    select.innerHTML = dealers.map((dealer) => {
      const code = upper(dealer.dealerCode || dealer.code || dealer.id || '');
      return `<option value="${escapeHtml(code)}">${escapeHtml(dealerOptionLabel(dealer))}</option>`;
    }).join('');
    select.value = state.session.dealerCode || '';
  }

  async function switchDealer(dealerCode) {
    const nextDealer = upper(dealerCode);
    if (!nextDealer || !state.session || nextDealer === state.session.dealerCode) return;
    const summary = await counts();
    if ((summary.pending || summary.failed) && !window.confirm('Pending scans exist for current dealer. Switch dealer now?')) {
      renderDealerSwitch();
      return;
    }
    state.paused = true;
    stopCamera();
    const dealer = sessionDealers().find((item) => upper(item.dealerCode || item.code || item.id || '') === nextDealer) || {};
    const data = await api(`/api/mobile/config?dealerCode=${encodeURIComponent(nextDealer)}`).catch(() => ({}));
    saveSession({
      ...state.session,
      dealerCode: nextDealer,
      activeDealerId: nextDealer,
      dealerName: dealer.dealerName || dealer.name || nextDealer,
      activeAudit: data.activeAudit || null,
      auditId: data.activeAudit?.auditId || dealer.currentAuditId || ''
    });
    state.activeBinLocation = readActiveBin();
    state.recentRaw.clear();
    state.lastScanAtByRaw.clear();
    await rebuildSessionScanIndex();
    state.paused = false;
    updateShell();
    await sendHeartbeat().catch(() => undefined);
    setMode(state.mode);
  }

  function updateOnlineUi() {
    const online = navigator.onLine;
    $('#onlineBadge').textContent = online ? 'Online' : 'Offline';
    $('#onlineBadge').className = `status-pill ${online ? 'online' : 'offline'}`;
    $('#networkState').textContent = online ? 'Online' : 'Offline';
  }

  function requiresPresetBin(mode = state.mode) {
    return mode === 'INWARD' || mode === 'DAMAGE';
  }

  function updateBinPanel() {
    const panel = $('#binPanel');
    const input = $('#activeBinLocation');
    const message = $('#binPanelMessage');
    if (!panel || !input || !message) return;
    const required = requiresPresetBin();
    panel.classList.toggle('hidden', !required);
    input.required = required;
    if (document.activeElement !== input) input.value = state.activeBinLocation;
    const ready = !required || Boolean(state.activeBinLocation);
    panel.classList.toggle('ready', ready && required);
    panel.classList.toggle('blocked', !ready);
    message.textContent = required
      ? (ready ? `Scanning will save to bin ${state.activeBinLocation}.` : 'Enter bin location before starting inward or damage scanning.')
      : 'Bin is not required for this mode.';
  }

  function setActiveBin(value) {
    state.activeBinLocation = upper(value);
    const key = scopedStorageKey(ACTIVE_BIN_KEY);
    if (state.activeBinLocation) localStorage.setItem(key, state.activeBinLocation);
    else localStorage.removeItem(key);
    updateBinPanel();
    return state.activeBinLocation;
  }

  function ensureScanCanStart() {
    if (!requiresPresetBin()) return true;
    if (state.activeBinLocation) return true;
    stopCamera();
    $('#cameraState').textContent = 'Enter bin location before scanning';
    toast('Bin location is mandatory before inward scanning', 'error');
    updateBinPanel();
    $('#activeBinLocation')?.focus();
    return false;
  }

  async function updateSyncUi() {
    updateOnlineUi();
    const summary = await counts();
    $('#pendingBadge').textContent = `Pending ${summary.pending}`;
    $('#pendingCount').textContent = summary.pending;
    $('#failedCount').textContent = summary.failed;
    const last = localStorage.getItem(scopedStorageKey(LAST_SYNC_KEY)) || '';
    $('#lastSyncTime').textContent = last ? new Date(last).toLocaleString() : 'Never';
    $('#lastSyncLabel').textContent = last ? `Last ${new Date(last).toLocaleTimeString()}` : 'Never synced';
    renderLastScans(summary.rows);
  }

  function renderLastScans(rows) {
    const latest = rows.slice().sort((a, b) => String(b.mobileCreatedAt).localeCompare(String(a.mobileCreatedAt))).slice(0, 10);
    $('#lastScanRows').innerHTML = latest.length ? latest.map((row) => `
      <tr>
        <td>${new Date(row.mobileCreatedAt).toLocaleTimeString()}</td>
        <td>${escapeHtml(row.partNumber || '-')}</td>
        <td>${escapeHtml(row.qty || 1)}</td>
        <td>${escapeHtml(money(scanMrp(row)))}</td>
        <td>${escapeHtml(row.scanType)}</td>
        <td>${escapeHtml(row.status || row.syncStatus)}</td>
      </tr>
    `).join('') : '<tr><td colspan="6">No scans yet</td></tr>';
  }

  function lastScanMeta(record = {}) {
    const mrp = scanMrp(record);
    return `${record.scanType} | Qty ${record.qty || 1}${mrp > 0 ? ` | MRP ${money(mrp)}` : ''} | ${rowStatus(record) === 'pending' && navigator.onLine ? 'Queued for sync' : rowStatus(record) === 'synced' ? 'Synced' : 'Offline Saved'}`;
  }

  function updateLastScanCard(record = {}) {
    $('#lastPart').textContent = record.partNumber || '-';
    $('#lastMeta').textContent = lastScanMeta(record);
  }

  function serverPriceFields(saved = {}) {
    const mrp = scanMrp(saved);
    return mrp > 0 ? {
      mrp,
      valuationMRP: numberValue(saved.valuationMRP, 0) > 0 ? numberValue(saved.valuationMRP, mrp) : mrp,
      scanMRP: numberValue(saved.scanMRP, 0),
      manualMRP: numberValue(saved.manualMRP, 0),
      valuationSource: saved.valuationSource || 'CATALOGUE_MRP_FALLBACK'
    } : {};
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
  }

  function parseRaw(raw) {
    const text = upper(raw);
    const slash = text.split('/');
    const keyed = (names) => {
      for (const name of names) {
        const match = text.match(new RegExp(`${name}\\s*[:=#-]?\\s*([A-Z0-9._/-]+)`, 'i'));
        if (match) return match[1];
      }
      return '';
    };
    return {
      rawUPI: raw,
      partNumber: keyed(['PART\\s*NO', 'PART', 'PN', 'SKU']) || (slash.length >= 4 ? slash[3] : '') || text,
      qty: Number(keyed(['QTY', 'QUANTITY']) || (slash.length >= 5 ? slash[4] : '') || 1) || 1,
      mrp: Number(keyed(['MRP', 'PRICE']) || (slash.length >= 6 ? slash[5] : '') || 0) || 0,
      mrpProvided: Boolean(keyed(['MRP', 'PRICE']) || (slash.length >= 6 && slash[5])),
      binLocation: keyed(['BIN', 'LOCATION'])
    };
  }

  async function enrichPart(partNumber) {
    if (!partNumber || !state.session) return null;
    try {
      const query = new URLSearchParams({ q: partNumber, dealerCode: state.session.dealerCode, limit: '1' });
      const data = await api(`/api/mobile/master-search?${query.toString()}`);
      return (data.parts || data.suggestions || [])[0] || null;
    } catch (_) {
      return null;
    }
  }

  function masterFields(master = {}, scannedMrpProvided = false, scannedMrp = 0, inputDlc = 0) {
    return {
      partDescription: master?.partDescription || master?.partName || '',
      category: master?.productCategory || master?.category || '',
      productCategory: master?.productCategory || master?.category || '',
      mrp: scannedMrpProvided ? scannedMrp : Number(master?.mrp || 0),
      scanMRP: scannedMrpProvided ? scannedMrp : 0,
      mrpProvided: scannedMrpProvided,
      dlc: Number(master?.dlc || inputDlc || 0),
      model: master?.model || '',
      year: master?.year || master?.manufacturingYear || ''
    };
  }

  async function enrichSavedScan(scanId, partNumber, scannedMrpProvided, scannedMrp, inputDlc) {
    const master = await enrichPart(partNumber);
    if (!master) return;
    const row = await getScan(scanId);
    if (!row || !rowBelongsToSession(row)) return;
    const updated = {
      ...row,
      ...masterFields(master, scannedMrpProvided, scannedMrp, inputDlc)
    };
    await putScan(updated);
    if ($('#lastPart').textContent === updated.partNumber) updateLastScanCard(updated);
    updateSyncUi().catch(() => undefined);
  }

  async function promptExtraFields(record) {
    if (record.scanType === 'FITTED') {
      record.regdNo = upper(window.prompt('Registration number') || '');
      record.jobCardNo = upper(window.prompt('Job card number') || '');
      if (!record.regdNo || !record.jobCardNo) throw new Error('Fitted scan requires registration and job card number');
    }
    if (record.scanType === 'INWARD' && !record.binLocation) {
      throw new Error('Inward scan requires bin location before scanning');
    }
    if (record.scanType === 'DAMAGE' && !record.binLocation) {
      throw new Error('Damage scan requires bin location before scanning');
    }
    if (record.scanType === 'OUTWARD') {
      record.binLocation = '';
      record.binSelectionMode = 'AUTO';
    }
    return record;
  }

  async function saveLocalScan(input, source = 'mobile') {
    const parsed = input.rawUPI ? parseRaw(input.rawUPI) : {};
    const partNumber = upper(input.partNumber || parsed.partNumber);
    if (!partNumber) throw new Error('Part number not found');
    const rawUPI = clean(input.rawUPI || input.rawScan || `${source}:${partNumber}:${Date.now()}`);
    const scanIdentity = normalizeScanIdentity(rawUPI);
    const now = Date.now();
    const duplicateScope = scanIdentityKey(scanIdentity, state.mode);
    const recentAt = state.lastScanAtByRaw.get(duplicateScope);
    if (recentAt && now - recentAt < DUPLICATE_GUARD_MS) {
      beep('bad');
      toast('Duplicate: exact same UPI/barcode already scanned', 'error');
      return null;
    }
    state.lastScanAtByRaw.set(duplicateScope, now);
    if (duplicateScope && state.scanIdentityKeys.has(duplicateScope)) {
      beep('bad');
      toast('Duplicate: exact same UPI/barcode already scanned', 'error');
      return null;
    }
    const inputMrp = Number(input.mrp || 0);
    const parsedMrp = Number(parsed.mrp || 0);
    const scannedMrp = parsedMrp || inputMrp;
    const scannedMrpProvided = Boolean(parsed.mrpProvided || input.mrpProvided || scannedMrp);
    const master = input.master || null;
    let record = {
      scanId: input.scanId || `${deviceId()}-${now}-${Math.random().toString(16).slice(2, 8)}`,
      scopeKey: sessionScopeKey(),
      userId: state.session.user?.id || state.session.user?.username || '',
      loginId: state.session.user?.username || '',
      userName: state.session.user?.name || state.session.user?.username || '',
      role: state.session.user?.role || '',
      dealerCode: state.session.dealerCode,
      dealerName: state.session.dealerName || '',
      auditId: sessionAuditId(),
      partNumber,
      scanIdentity,
      rawUPI,
      rawScan: rawUPI,
      rawScanString: rawUPI,
      qty: Number(input.qty || parsed.qty || 1) || 1,
      scanType: state.mode,
      type: state.mode,
      binLocation: upper(input.binLocation || parsed.binLocation || (requiresPresetBin() ? state.activeBinLocation : '')),
      mobileCreatedAt: nowIso(),
      timestamp: '',
      deviceId: deviceId(),
      deviceName: state.session.deviceName || '',
      source,
      syncStatus: 'pending',
      status: 'pending',
      ...masterFields(master, scannedMrpProvided, scannedMrp, input.dlc)
    };
    record = await promptExtraFields(record);
    await putScan(record);
    rememberScanIdentity(record);
    updateLastScanCard(record);
    beep('ok');
    toast(navigator.onLine ? 'Saved locally, syncing' : 'Offline Saved', 'success');
    updateSyncUi().catch(() => undefined);
    if (!master) enrichSavedScan(record.scanId, partNumber, scannedMrpProvided, scannedMrp, input.dlc).catch(() => undefined);
    if (navigator.onLine) syncPending({ silent: true }).catch(() => undefined);
    return record;
  }

  async function syncPending(options = {}) {
    if (state.syncing) {
      state.syncAgain = true;
      return;
    }
    if (!state.session?.token || !navigator.onLine) return;
    if (sessionTokenExpired()) {
      handleAuthExpired({ status: 401, message: authExpiredMessage() });
      return;
    }
    state.syncing = true;
    try {
      const all = await getAllScans();
      const batch = all.filter((row) => rowBelongsToSession(row) && (rowStatus(row) === 'pending' || rowStatus(row) === 'failed')).slice(0, BATCH_SIZE);
      if (!batch.length) {
        if (!options.silent) toast('Nothing pending');
        return;
      }
      const data = await api('/api/mobile/sync-batch', {
        method: 'POST',
        body: {
          deviceId: deviceId(),
          deviceName: state.session.deviceName || '',
          dealerCode: state.session.dealerCode,
          dealerName: state.session.dealerName || '',
          appVersion: APP_VERSION,
          pendingCount: batch.length,
          batteryPercent: await batteryPercent(),
          records: batch.map((row) => ({ ...row, localCreatedAt: row.mobileCreatedAt }))
        }
      });
      const inserted = new Map((data.insertedRecords || []).map((row) => [clean(row.clientScanId || row.scanId || row.uniqueScanId), row]));
      const duplicateIds = new Set((data.logs || []).filter((log) => log.status === 'duplicate').map((log) => clean(log.clientScanId || log.localId || log.scanId)));
      const failedLogs = new Map((data.logs || [])
        .filter((log) => log.status === 'failed' || log.status === 'invalid')
        .map((log) => [clean(log.clientScanId || log.localId || log.scanId), clean(log.errorMessage || log.reason || 'Server failed this record')]));
      for (const row of batch) {
        const saved = inserted.get(row.scanId) || inserted.get(row.clientScanId);
        if (saved || duplicateIds.has(row.scanId)) {
          const syncedRow = { ...row, ...serverPriceFields(saved || {}), auditId: saved?.auditId || row.auditId || sessionAuditId(), status: 'synced', syncStatus: 'synced', timestamp: saved?.timestamp || saved?.serverReceivedAt || nowIso(), serverAck: saved || null };
          await putScan(syncedRow);
          if ($('#lastPart').textContent === syncedRow.partNumber) updateLastScanCard(syncedRow);
        } else if (failedLogs.has(row.scanId)) {
          await putScan({ ...row, status: 'failed', syncStatus: 'failed', syncError: failedLogs.get(row.scanId) });
        } else if (data.success) {
          const syncedRow = { ...row, auditId: row.auditId || sessionAuditId(), status: 'synced', syncStatus: 'synced', timestamp: nowIso() };
          await putScan(syncedRow);
          if ($('#lastPart').textContent === syncedRow.partNumber) updateLastScanCard(syncedRow);
        }
      }
      localStorage.setItem(scopedStorageKey(LAST_SYNC_KEY), nowIso());
      if (!options.silent) toast(data.message || 'Sync complete', 'success');
      sendHeartbeat().catch(() => undefined);
    } catch (error) {
      if (authExpired(error)) {
        handleAuthExpired(error);
        return;
      }
      const batch = (await getAllScans()).filter((row) => rowBelongsToSession(row) && rowStatus(row) === 'pending').slice(0, BATCH_SIZE);
      const logs = Array.isArray(error.data?.logs) ? error.data.logs : [];
      if (logs.length) {
        const failedLogs = new Map(logs
          .filter((log) => log.status === 'failed' || log.status === 'invalid')
          .map((log) => [clean(log.clientScanId || log.localId || log.scanId), clean(log.errorMessage || log.reason || error.message)]));
        const duplicateIds = new Set(logs
          .filter((log) => log.status === 'duplicate')
          .map((log) => clean(log.clientScanId || log.localId || log.scanId)));
        for (const row of batch) {
          if (duplicateIds.has(row.scanId)) {
            await putScan({ ...row, status: 'synced', syncStatus: 'synced', syncError: '', timestamp: nowIso() });
          } else if (failedLogs.has(row.scanId)) {
            await putScan({ ...row, status: 'failed', syncStatus: 'failed', syncError: failedLogs.get(row.scanId) });
          }
        }
      } else if (isRetryableSyncError(error)) {
        for (const row of batch) await putScan({ ...row, status: 'pending', syncStatus: 'pending', syncError: `Network/server error: ${error.message}` });
      } else {
        for (const row of batch) await putScan({ ...row, status: 'failed', syncStatus: 'failed', syncError: error.message });
      }
      if (!options.silent) toast(isRetryableSyncError(error) ? 'Network/server error: scans kept pending' : error.message, 'error');
    } finally {
      state.syncing = false;
      updateSyncUi().catch(() => undefined);
      if (state.syncAgain && state.session?.token && navigator.onLine) {
        state.syncAgain = false;
        setTimeout(() => syncPending({ silent: true }).catch(() => undefined), 0);
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
    if (!state.session?.token) return;
    const summary = await counts();
    return api('/api/mobile/heartbeat', {
      method: 'POST',
      body: {
        deviceId: deviceId(),
        deviceName: state.session.deviceName || '',
        dealerCode: state.session.dealerCode,
        dealerName: state.session.dealerName,
        userId: state.session.user?.id || '',
        userName: state.session.user?.name || state.session.user?.username || '',
        role: state.session.user?.role || '',
        appVersion: APP_VERSION,
        pendingCount: summary.pending,
        failedCount: summary.failed,
        batteryPercent: await batteryPercent()
      }
    });
  }

  async function startCamera() {
    if (state.stream || state.paused) return;
    if (!ensureScanCanStart()) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      $('#cameraState').textContent = 'Camera API unavailable. Use Manual Entry.';
      return;
    }
    const constraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 },
        frameRate: { ideal: 24, max: 30 },
        advanced: [
          { focusMode: 'continuous' },
          { exposureMode: 'continuous' }
        ]
      },
      audio: false
    };
    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    $('#cameraPreview').srcObject = state.stream;
    await $('#cameraPreview').play();
    $('#cameraState').textContent = 'Scanning';
    if ('BarcodeDetector' in window && !state.detector) {
      state.detector = new BarcodeDetector({ formats: ['qr_code', 'code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'data_matrix'] });
    }
    scanLoop();
  }

  function stopCamera() {
    clearTimeout(state.scanTimer);
    state.scanTimer = null;
    if (state.stream) {
      state.stream.getTracks().forEach((track) => track.stop());
      state.stream = null;
    }
    $('#cameraPreview').srcObject = null;
    $('#cameraState').textContent = 'Camera stopped';
  }

  async function scanLoop() {
    clearTimeout(state.scanTimer);
    if (!state.stream || state.paused || !state.detector || state.scanProcessing) {
      state.scanTimer = setTimeout(scanLoop, SCAN_BLOCKED_DELAY_MS);
      return;
    }
    let nextDelay = SCAN_IDLE_DELAY_MS;
    try {
      const codes = await state.detector.detect($('#cameraPreview'));
      const raw = clean(codes && codes[0] && codes[0].rawValue);
      if (raw) {
        const detectedKey = scanIdentityKey(raw, state.mode) || `${state.mode}|${normalizeScanIdentity(raw)}`;
        const detectedAt = state.recentRaw.get(detectedKey) || 0;
        if (detectedAt && Date.now() - detectedAt < DETECTION_REPEAT_SUPPRESS_MS) {
          nextDelay = SCAN_READY_DELAY_MS;
          return;
        }
        state.recentRaw.set(detectedKey, Date.now());
        state.scanProcessing = true;
        nextDelay = SCAN_READY_DELAY_MS;
        saveLocalScan({ rawUPI: raw }, 'mobile')
          .catch((error) => toast(error.message, 'error'))
          .finally(() => { state.scanProcessing = false; });
      }
    } catch (error) {
      $('#cameraState').textContent = error.name === 'NotSupportedError'
        ? 'Barcode scanner unavailable. Use Manual Entry.'
        : 'Scanner active. If QR is not detected, use Manual Entry.';
      nextDelay = SCAN_BLOCKED_DELAY_MS;
    } finally {
      state.scanTimer = setTimeout(scanLoop, nextDelay);
    }
  }

  function setMode(mode) {
    state.mode = mode;
    $$('.mode-btn').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
    configureManualFields();
    updateBinPanel();
    state.paused = false;
    startCamera().catch((error) => {
      $('#cameraState').textContent = error.message;
      toast(error.message, 'error');
    });
  }

  function configureManualFields() {
    const needsBin = requiresPresetBin();
    $('#manualBinLabel').classList.toggle('hidden', !needsBin);
    $('#manualBinLabel input').required = needsBin;
    $('#manualRegLabel').classList.toggle('hidden', state.mode !== 'FITTED');
    $('#manualJobLabel').classList.toggle('hidden', state.mode !== 'FITTED');
  }

  function showDealerSelection(data, payload) {
    const dealers = data.assignedDealers || data.activeDealers || [];
    const select = $('#loginDealerSelect');
    if (!select || !dealers.length) return false;
    select.innerHTML = '<option value="">Select Dealer</option>' + dealers.map((dealer) => {
      const code = upper(dealer.dealerCode || dealer.code || dealer.id || '');
      const name = clean(dealer.dealerName || dealer.name || '');
      return `<option value="${escapeHtml(code)}">${escapeHtml(code)}${name ? ` - ${escapeHtml(name)}` : ''}</option>`;
    }).join('');
    $('#dealerSelectLabel').hidden = false;
    $('#dealerCodeInputLabel').hidden = true;
    state.pendingLogin = { data, payload };
    $('#loginMessage').textContent = 'Select dealer';
    return true;
  }

  async function login(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const selectedDealer = upper(form.get('selectedDealerCode') || form.get('dealerCode'));
    if (state.pendingLogin && !selectedDealer) {
      $('#loginMessage').textContent = 'Select dealer';
      return;
    }
    const payload = {
      ...(state.pendingLogin?.payload || {}),
      username: clean(form.get('username') || state.pendingLogin?.payload?.username),
      password: String(form.get('password') || state.pendingLogin?.payload?.password || ''),
      pin: String(form.get('pin') || state.pendingLogin?.payload?.pin || ''),
      dealerCode: selectedDealer,
      deviceId: deviceId(),
      deviceName: clean(form.get('deviceName')) || 'Android Chrome',
      appVersion: APP_VERSION,
      model: navigator.userAgent.slice(0, 120)
    };
    $('#loginMessage').textContent = 'Verifying...';
    const data = await api('/api/mobile/login', { method: 'POST', body: payload });
    if (!data.dealerCode && data.needsDealerSelection && showDealerSelection(data, payload)) return;
    state.pendingLogin = null;
    $('#dealerSelectLabel').hidden = true;
    $('#dealerCodeInputLabel').hidden = false;
    saveSession({ ...data, deviceName: payload.deviceName });
    state.recentRaw.clear();
    state.lastScanAtByRaw.clear();
    state.activeBinLocation = readActiveBin();
    await purgeOutOfScopeRows();
    await rebuildSessionScanIndex();
    $('#loginMessage').textContent = '';
    updateShell();
    connectSocket();
    sendHeartbeat().catch(() => undefined);
    startTimers();
    setMode(state.mode);
  }

  function logout() {
    stopCamera();
    clearInterval(state.syncTimer);
    state.syncTimer = null;
    if (state.socket) {
      state.socket.disconnect();
      state.socket = null;
    }
    clearSession();
    state.activeBinLocation = '';
    state.recentRaw.clear();
    state.lastScanAtByRaw.clear();
    state.scanIdentityKeys.clear();
    state.scanProcessing = false;
    state.syncAgain = false;
    updateShell();
  }

  function connectSocket() {
    if (!window.io || state.socket || !state.session?.token) return;
    state.socket = io({ auth: { token: state.session.token, deviceId: deviceId() }, transports: ['websocket', 'polling'] });
    state.socket.on('mobile:force-logout', (payload = {}) => {
      if (!payload.deviceId || payload.deviceId === deviceId()) {
        toast('Force logout requested by admin', 'error');
        logout();
      }
    });
    state.socket.on('mobile:message', (payload = {}) => {
      if (!payload.deviceId || payload.deviceId === deviceId()) toast(payload.message || 'Admin message');
    });
    state.socket.on('scan:saved', () => updateSyncUi().catch(() => undefined));
  }

  function startTimers() {
    clearInterval(state.syncTimer);
    state.syncTimer = setInterval(() => syncPending({ silent: true }).catch(() => undefined), SYNC_INTERVAL_MS);
    syncPending({ silent: true }).catch(() => undefined);
  }

  async function clearSynced() {
    const rows = await getAllScans();
    const clearableRows = rows.filter((row) => rowBelongsToSession(row) && CLEARABLE_CACHE_STATUSES.has(rowStatus(row)));
    const failedRows = clearableRows.filter((row) => rowStatus(row) === 'failed');
    if (!clearableRows.length) {
      toast('No local cache rows to clear for this dealer');
      return;
    }
    if (failedRows.length && !window.confirm('Clear failed local scans for this dealer? They will not be retried after clearing.')) return;
    await Promise.all(clearableRows.map((row) => deleteScan(row.scanId)));
    await rebuildSessionScanIndex();
    toast(`Cleared ${clearableRows.length} local cache row${clearableRows.length === 1 ? '' : 's'}`, 'success');
    updateSyncUi();
  }

  async function openManual() {
    configureManualFields();
    $('#manualForm').reset();
    $('#manualBinLabel input').value = requiresPresetBin() ? state.activeBinLocation : '';
    state.manualPart = null;
    $('#manualPartMeta').textContent = '';
    $('#partSuggestions').innerHTML = '';
    $('#manualDialog').showModal();
  }

  async function manualSubmit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const partNumber = upper(form.get('partNumber'));
    const binLocation = upper(form.get('binLocation') || (requiresPresetBin() ? state.activeBinLocation : ''));
    if (requiresPresetBin() && !binLocation) {
      toast('Bin location is mandatory for manual inward/damage entry', 'error');
      $('#manualBinLabel input').focus();
      return;
    }
    await saveLocalScan({
      partNumber,
      qty: Number(form.get('qty') || 1),
      binLocation,
      regdNo: upper(form.get('regdNo')),
      jobCardNo: upper(form.get('jobCardNo')),
      master: state.manualPart,
      rawUPI: `MANUAL:${partNumber}:${binLocation || 'NO-BIN'}:${Date.now()}`
    }, 'manual');
    $('#manualDialog').close();
  }

  function bindManualSuggest() {
    let timer = null;
    $('#manualPartNumber').addEventListener('input', (event) => {
      event.target.value = upper(event.target.value);
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = upper(event.target.value);
        if (q.length < 2 || !state.session) {
          $('#partSuggestions').innerHTML = '';
          return;
        }
        try {
          const query = new URLSearchParams({ q, dealerCode: state.session.dealerCode, limit: '5' });
          const data = await api(`/api/mobile/master-search?${query.toString()}`);
          const parts = data.parts || data.suggestions || [];
          $('#partSuggestions').innerHTML = parts.map((part, index) => `<button type="button" data-index="${index}">${escapeHtml(part.partNumber || part.partNo)} | ${escapeHtml(part.partDescription || part.partName || '')}</button>`).join('');
          $$('#partSuggestions button').forEach((button) => {
            button.addEventListener('click', () => {
              state.manualPart = parts[Number(button.dataset.index)];
              $('#manualPartNumber').value = upper(state.manualPart.partNumber || state.manualPart.partNo);
              $('#manualPartMeta').textContent = [state.manualPart.partDescription || state.manualPart.partName, state.manualPart.productCategory || state.manualPart.category, state.manualPart.model, state.manualPart.year || state.manualPart.manufacturingYear, `MRP ${state.manualPart.mrp || 0}`, `DLC ${state.manualPart.dlc || 0}`].filter(Boolean).join(' | ');
              $('#partSuggestions').innerHTML = '';
            });
          });
        } catch (_) {}
      }, 220);
    });
  }

  function bindEvents() {
    $('#loginForm').addEventListener('submit', (event) => login(event).catch((error) => {
      $('#loginMessage').textContent = error.message;
      toast(error.message, 'error');
    }));
    $('#logoutBtn').addEventListener('click', logout);
    $('#mobileDealerSwitch')?.addEventListener('change', (event) => switchDealer(event.target.value).catch((error) => {
      toast(error.message, 'error');
      renderDealerSwitch();
    }));
    $$('.mode-btn').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
    $('#pauseBtn').addEventListener('click', () => { state.paused = true; $('#cameraState').textContent = 'Paused'; });
    $('#resumeBtn').addEventListener('click', () => { state.paused = false; startCamera().catch((error) => toast(error.message, 'error')); });
    $('#manualBtn').addEventListener('click', openManual);
    $('#syncNowBtn').addEventListener('click', () => syncPending().catch((error) => toast(error.message, 'error')));
    $('#activeBinLocation').addEventListener('input', (event) => {
      event.target.value = upper(event.target.value);
    });
    $('#saveBinBtn').addEventListener('click', () => {
      const bin = setActiveBin($('#activeBinLocation').value);
      if (bin) {
        toast(`Bin ${bin} set for scanning`, 'success');
        if (state.session?.token && !state.paused) startCamera().catch((error) => toast(error.message, 'error'));
      } else {
        toast('Enter bin location before scanning', 'error');
      }
    });
    $('#clearBinBtn').addEventListener('click', () => {
      setActiveBin('');
      stopCamera();
      $('#cameraState').textContent = 'Enter bin location before scanning';
      $('#activeBinLocation').focus();
    });
    $('#retryFailedBtn').addEventListener('click', async () => {
      const rows = await getAllScans();
      const failedRows = rows.filter((row) => rowBelongsToSession(row) && rowStatus(row) === 'failed');
      const missingBinRows = failedRows.filter((row) => requiresPresetBin(row.scanType || row.type) && !upper(row.binLocation || row.bin));
      if (missingBinRows.length && !state.activeBinLocation) {
        toast('Set bin location, then retry failed scans', 'error');
        $('#activeBinLocation')?.focus();
        return;
      }
      await Promise.all(failedRows.map((row) => {
        const retryBin = upper(row.binLocation || row.bin || (requiresPresetBin(row.scanType || row.type) ? state.activeBinLocation : ''));
        return putScan({ ...row, binLocation: retryBin, bin: retryBin, status: 'pending', syncStatus: 'pending', syncError: '' });
      }));
      await syncPending();
    });
    $('#clearSyncedBtn').addEventListener('click', clearSynced);
    $('#manualCancelBtn').addEventListener('click', () => $('#manualDialog').close());
    $('#manualForm').addEventListener('submit', (event) => manualSubmit(event).catch((error) => toast(error.message, 'error')));
    window.addEventListener('online', () => { updateSyncUi(); syncPending({ silent: true }).catch(() => undefined); });
    window.addEventListener('offline', updateSyncUi);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopCamera();
      else if (state.session?.token && !state.paused) startCamera().catch(() => undefined);
    });
    window.addEventListener('pagehide', stopCamera);
    window.addEventListener('beforeunload', stopCamera);
    bindManualSuggest();
  }

  async function init() {
    state.db = await openDb();
    state.activeBinLocation = readActiveBin();
    bindEvents();
    if (state.session?.token) {
      await refreshSessionContext();
      state.activeBinLocation = readActiveBin();
      await purgeOutOfScopeRows();
      await rebuildSessionScanIndex();
    }
    updateShell();
    if (state.session?.token) {
      connectSocket();
      startTimers();
      setMode(state.mode);
      sendHeartbeat().catch(() => undefined);
    }
  }

  init().catch((error) => {
    console.error(error);
    toast(error.message, 'error');
  });
})();
