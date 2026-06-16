(function () {
  const APP_VERSION = 'Daksh Mobile Scanner 2026-06-16';
  const STORAGE = {
    session: 'dakshFreshMobileSession',
    queue: 'dakshFreshMobileQueue',
    deviceId: 'dakshFreshMobileDeviceId',
    lastDealer: 'dakshFreshMobileLastDealerCode',
    binPrefix: 'dakshFreshMobileBin:'
  };
  const ZXING_SRC = '/vendor/zxing/index.min.js?v=20260616-fresh-mobile';
  const HEALTH_TIMEOUT_MS = 1800;
  const CAMERA_POLL_MS = 120;
  const DEDUPE_WINDOW_MS = 1800;
  const AUTO_SYNC_DELAY_MS = 1500;
  const MAX_QUEUE_RECORDS = 120;
  const MAX_HISTORY_ITEMS = 6;
  const CAMERA_CONSTRAINTS = {
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 }
    }
  };
  const BARCODE_FORMATS = [
    'qr_code',
    'code_128',
    'code_39',
    'code_93',
    'ean_13',
    'ean_8',
    'upc_a',
    'upc_e',
    'itf',
    'data_matrix',
    'pdf417',
    'aztec'
  ];

  const els = {};
  const state = {
    health: null,
    config: null,
    session: loadSession(),
    queue: loadQueue(),
    loginBusy: false,
    syncBusy: false,
    scanning: false,
    paused: false,
    cameraMode: 'idle',
    cameraStream: null,
    barcodeDetector: null,
    zxingReader: null,
    zxingPromise: null,
    scanLoopTimer: 0,
    scanLoopBusy: false,
    autoSyncTimer: 0,
    heartbeatTimer: 0,
    lastScanSeen: new Map(),
    cameraError: '',
    resumeAfterManual: false
  };

  function $(id) {
    return els[id];
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function nowMs() {
    return Date.now();
  }

  function clean(value) {
    return String(value == null ? '' : value).trim();
  }

  function upper(value) {
    return clean(value).toUpperCase();
  }

  function storageGet(key, fallback) {
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

  function safeJsonParse(value, fallback) {
    try {
      return JSON.parse(value);
    } catch (_) {
      return fallback;
    }
  }

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return `MOB-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`.toUpperCase();
  }

  function deviceId() {
    let id = storageGet(STORAGE.deviceId, '');
    if (!id) {
      id = makeId();
      storageSet(STORAGE.deviceId, id);
    }
    return id;
  }

  function buildDeviceName() {
    const platformData = navigator.userAgentData && navigator.userAgentData.platform ? navigator.userAgentData.platform : '';
    const platform = clean(navigator.platform || platformData || '');
    if (/android/i.test(platform)) return 'Android Mobile Scanner';
    if (/iphone|ipad|ipod/i.test(platform)) return 'iPhone Mobile Scanner';
    if (/win/i.test(platform)) return 'Windows Mobile Web';
    if (/mac/i.test(platform)) return 'Mac Mobile Web';
    return 'Daksh Mobile Web';
  }

  function normalizeSession(session) {
    if (!session || typeof session !== 'object') return null;
    const next = { ...session };
    const user = next.user && typeof next.user === 'object' ? next.user : {};
    const activeAudit = next.activeAudit && typeof next.activeAudit === 'object' ? next.activeAudit : null;
    next.deviceId = clean(next.deviceId || deviceId());
    next.deviceName = clean(next.deviceName || buildDeviceName());
    next.dealerCode = upper(next.dealerCode || next.activeDealerId || '');
    next.loginId = clean(next.loginId || next.userId || user.username || user.email || next.userName || '').toLowerCase();
    next.userName = clean(next.userName || next.staffName || user.name || user.username || next.loginId || '');
    next.role = clean(next.role || user.role || '').toLowerCase();
    next.dealerName = clean(next.dealerName || '');
    next.auditId = clean(next.auditId || (activeAudit && activeAudit.auditId) || '');
    return next;
  }

  function loadSession() {
    const raw = storageGet(STORAGE.session, '');
    if (!raw) return null;
    return normalizeSession(safeJsonParse(raw, null));
  }

  function saveSession(session) {
    state.session = normalizeSession(session);
    if (state.session) storageSet(STORAGE.session, JSON.stringify(state.session));
  }

  function clearSession() {
    state.session = null;
    storageRemove(STORAGE.session);
  }

  function loadQueue() {
    const raw = storageGet(STORAGE.queue, '[]');
    const parsed = safeJsonParse(raw, []);
    return Array.isArray(parsed) ? pruneQueue(parsed) : [];
  }

  function persistQueue() {
    state.queue = pruneQueue(state.queue);
    try {
      storageSet(STORAGE.queue, JSON.stringify(state.queue));
    } catch (_) {}
  }

  function pruneQueue(records) {
    if (!Array.isArray(records)) return [];
    const cutoff = nowMs() - (7 * 24 * 60 * 60 * 1000);
    return records
      .filter((record) => record && clean(record.clientScanId))
      .filter((record) => {
        const timestamp = new Date(record.timestamp || record.createdAt || 0).getTime();
        return !Number.isFinite(timestamp) || timestamp >= cutoff;
      })
      .sort((left, right) => {
        const rightTime = new Date(right.timestamp || right.createdAt || 0).getTime();
        const leftTime = new Date(left.timestamp || left.createdAt || 0).getTime();
        return rightTime - leftTime;
      })
      .slice(0, MAX_QUEUE_RECORDS)
      .map((record) => ({ ...record }));
  }

  function scopeKey(session = state.session) {
    if (!session || !session.dealerCode) return '';
    return [
      upper(session.dealerCode),
      clean(session.loginId || '').toLowerCase(),
      clean(session.deviceId || deviceId())
    ].join('|');
  }

  function binStorageKey(session = state.session) {
    const key = scopeKey(session);
    return key ? `${STORAGE.binPrefix}${key}` : `${STORAGE.binPrefix}default`;
  }

  function loadBin(session = state.session) {
    return upper(storageGet(binStorageKey(session), ''));
  }

  function saveBin(value, session = state.session) {
    const bin = upper(value);
    const key = binStorageKey(session);
    if (bin) storageSet(key, bin);
    else storageRemove(key);
    return bin;
  }

  function currentBin() {
    const input = $('binInput');
    return upper(clean((input && input.value) || loadBin()));
  }

  function scopeMatches(record, session = state.session) {
    if (!session || !session.token) return false;
    if (upper(record.dealerCode || '') !== upper(session.dealerCode || '')) return false;
    if (clean(record.deviceId || '') !== clean(session.deviceId || deviceId())) return false;
    if (clean(record.loginId || '').toLowerCase() !== clean(session.loginId || '').toLowerCase()) return false;
    return true;
  }

  function currentRecords() {
    return state.queue
      .filter((record) => scopeMatches(record))
      .sort((left, right) => {
        const rightTime = new Date(right.timestamp || right.createdAt || 0).getTime();
        const leftTime = new Date(left.timestamp || left.createdAt || 0).getTime();
        return rightTime - leftTime;
      });
  }

  function queueSummary() {
    const records = currentRecords();
    return records.reduce((summary, record) => {
      const status = clean(record.syncStatus || 'pending').toLowerCase();
      summary.total += 1;
      if (status === 'synced') summary.synced += 1;
      else if (status === 'failed') summary.failed += 1;
      else if (status === 'duplicate') summary.duplicate += 1;
      else summary.pending += 1;
      return summary;
    }, { total: 0, pending: 0, synced: 0, failed: 0, duplicate: 0 });
  }

  function normalizeText(value) {
    return upper(String(value == null ? '' : value).replace(/\s+/g, ' ').trim());
  }

  function normalizePartNumber(value) {
    const text = normalizeText(value);
    if (!text) return '';
    const collapsed = text.replace(/[^A-Z0-9._/-]+/g, '');
    if (collapsed) return collapsed.slice(0, 40);
    return text.slice(0, 40);
  }

  function parseScanValue(rawValue) {
    const raw = clean(rawValue);
    const upperRaw = upper(raw);
    const result = {
      raw,
      partNumber: '',
      qty: 1,
      binLocation: ''
    };

    if (!raw) return result;

    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        result.partNumber = normalizePartNumber(parsed.partNumber || parsed.partNo || parsed.part || parsed.sku || parsed.code || '');
        result.qty = Number(parsed.qty || parsed.quantity || result.qty || 1) || 1;
        result.binLocation = upper(parsed.binLocation || parsed.bin || '');
        if (result.partNumber) return result;
      }
    } catch (_) {}

    const patterns = [
      /(?:PART\s*NO|PART\s*NUMBER|PART|PN|SKU|ITEM)\s*[:=#-]?\s*([A-Z0-9._/-]+)/i,
      /(?:CODE|BARCODE|QR)\s*[:=#-]?\s*([A-Z0-9._/-]+)/i,
      /"(?:partNumber|partNo|part|sku|code)"\s*:\s*"([^"]+)"/i
    ];

    for (let index = 0; index < patterns.length; index += 1) {
      const match = patterns[index].exec(raw);
      if (match && match[1]) {
        result.partNumber = normalizePartNumber(match[1]);
        if (result.partNumber) return result;
      }
    }

    const compact = upperRaw.replace(/[^A-Z0-9._/-]+/g, ' ').trim();
    const collapsed = compact.replace(/\s+/g, '');
    if (/^[A-Z0-9][A-Z0-9._/-]{2,39}$/.test(collapsed)) {
      result.partNumber = collapsed;
      return result;
    }

    result.partNumber = normalizePartNumber(upperRaw.slice(0, 40));
    return result;
  }

  function parseSyncMessage(message) {
    const text = clean(message).toLowerCase();
    if (!text) return 'Saved';
    if (/duplicate/.test(text)) return 'Duplicate already scanned';
    if (/failed|error|invalid/.test(text)) return 'Sync failed';
    if (/saved|synced/.test(text)) return 'Synced';
    return message;
  }

  function escapeHtmlText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatTime(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return '-';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatDateTime(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return '-';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function updateMessage(node, text, kind) {
    if (!node) return;
    node.textContent = text || '';
    node.className = `message${kind ? ` ${kind}` : ''}`;
  }

  function toast(message, kind) {
    const node = $('toast');
    if (!node) return;
    node.textContent = message;
    node.hidden = false;
    node.dataset.kind = kind || 'info';
    clearTimeout(node._hideTimer);
    node._hideTimer = setTimeout(() => {
      node.hidden = true;
    }, 2800);
  }

  function beep(kind) {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const context = beep.context || (beep.context = new AudioContext());
      if (context.state === 'suspended' && typeof context.resume === 'function') {
        context.resume().catch(() => undefined);
      }
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = kind === 'error' ? 220 : kind === 'duplicate' ? 540 : 920;
      gain.gain.value = 0.001;
      const peak = kind === 'error' ? 0.15 : 0.11;
      gain.gain.exponentialRampToValueAtTime(peak, context.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + (kind === 'error' ? 0.28 : 0.12));
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + (kind === 'error' ? 0.31 : 0.14));
    } catch (_) {}
  }

  function vibrate(pattern) {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern || 20);
    } catch (_) {}
  }

  function canonicalScanUrl() {
    if (state.health && state.health.scanUrl) return clean(state.health.scanUrl);
    return `${window.location.origin.replace(/\/+$/, '')}/mobile-scanner`;
  }

  function updateUrlDisplay() {
    const url = canonicalScanUrl();
    $('scanUrlText').textContent = url;
  }

  function updateStatusChips() {
    const serverChip = $('serverChip');
    const dbChip = $('dbChip');
    const health = state.health || {};

    if (!state.health) {
      serverChip.textContent = navigator.onLine ? 'Server checking...' : 'Offline';
      serverChip.className = `chip ${navigator.onLine ? 'chip-muted' : 'chip-bad'}`;
      dbChip.textContent = 'Database checking...';
      dbChip.className = 'chip chip-muted';
      return;
    }

    const serverOnline = String(health.serverStatus || health.status || '').toLowerCase() === 'online' || String(health.status || '').toUpperCase() === 'OK';
    const dbOnline = String(health.mongoStatus || health.mongodb || '').toLowerCase() === 'online';

    serverChip.textContent = serverOnline ? 'Server OK' : 'Server unavailable';
    serverChip.className = `chip ${serverOnline ? 'chip-good' : 'chip-bad'}`;

    dbChip.textContent = dbOnline ? 'DB Online' : 'DB Offline';
    dbChip.className = `chip ${dbOnline ? 'chip-good' : 'chip-bad'}`;
  }

  function updateLoginHint() {
    const hint = $('dealerHint');
    const audit = state.config && state.config.activeAudit ? state.config.activeAudit : null;
    const dealerCode = clean(audit && (audit.dealerCode || audit.activeDealerId || '')).toUpperCase();
    const dealerName = clean(audit && (audit.dealerName || audit.name || ''));
    if (dealerCode) {
      hint.textContent = dealerName ? `Suggested dealer: ${dealerCode} - ${dealerName}` : `Suggested dealer: ${dealerCode}`;
    } else {
      hint.textContent = 'Dealer code is required before login.';
    }
  }

  function prefillLoginFields() {
    const dealerInput = $('dealerCodeInput');
    const lastDealer = upper(storageGet(STORAGE.lastDealer, ''));
    const auditDealer = clean(state.config && state.config.activeAudit && (state.config.activeAudit.dealerCode || state.config.activeAudit.activeDealerId || '')).toUpperCase();
    const preset = upper(dealerInput.value || lastDealer || auditDealer);
    if (preset) dealerInput.value = preset;
  }

  function renderSessionHeader() {
    const session = state.session || {};
    const dealerCode = upper(session.dealerCode || '');
    const dealerName = clean(session.dealerName || '');
    const userName = clean(session.userName || session.loginId || 'User');
    const role = clean(session.role || 'user');
    $('sessionTitle').textContent = dealerCode ? `${dealerCode}${dealerName ? ` - ${dealerName}` : ''}` : 'Ready';
    $('sessionMeta').textContent = dealerCode ? `${userName} · ${role} · ${session.deviceName || buildDeviceName()}` : 'Camera will open automatically after login.';
    $('dealerText').textContent = dealerCode ? `${dealerCode}${dealerName ? ` - ${dealerName}` : ''}` : '-';
  }

  function renderBinField() {
    const input = $('binInput');
    const bin = loadBin();
    if (bin) input.value = bin;
    else if (!input.value) input.value = '';
  }

  function renderStats() {
    const summary = queueSummary();
    $('queueCount').textContent = String(summary.total);
    $('pendingCount').textContent = String(summary.pending);
    $('syncedCount').textContent = String(summary.synced);
    $('failedCount').textContent = String(summary.failed);
    $('syncBtn').disabled = state.syncBusy || summary.pending === 0;
    $('syncBtn').textContent = state.syncBusy ? 'Syncing...' : 'Sync Now';
    $('pauseBtn').textContent = state.paused ? 'Resume' : 'Pause';
  }

  function renderHistory() {
    const list = $('historyList');
    const records = currentRecords().slice(0, MAX_HISTORY_ITEMS);
    list.innerHTML = '';

    if (!records.length) {
      const emptyItem = document.createElement('li');
      emptyItem.className = 'history-item';
      emptyItem.innerHTML = '<div><strong>No scans yet</strong><span>Scan a QR or barcode to see it here.</span></div>';
      list.appendChild(emptyItem);
      return;
    }

    records.forEach((record) => {
      const item = document.createElement('li');
      item.className = 'history-item';

      const left = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = record.partNumber || record.rawScan || 'Unknown scan';
      left.appendChild(title);

      const meta = document.createElement('span');
      const bits = [
        upper(record.scanType || 'INWARD'),
        record.binLocation ? `Bin ${upper(record.binLocation)}` : 'No bin',
        `Qty ${Number(record.qty || record.quantity || 1) || 1}`,
        formatTime(record.timestamp || record.createdAt)
      ];
      meta.textContent = bits.join(' · ');
      left.appendChild(meta);

      const badge = document.createElement('span');
      const status = clean(record.syncStatus || 'pending').toLowerCase();
      badge.className = `status-pill ${status}`;
      badge.textContent = status === 'pending' ? 'Pending' : status === 'synced' ? 'Synced' : status === 'duplicate' ? 'Duplicate' : 'Failed';

      item.appendChild(left);
      item.appendChild(badge);
      list.appendChild(item);
    });
  }

  function renderMessageState(message, kind, subtext) {
    updateMessage($('scanMessage'), message || 'Camera is ready to start.', kind);
    $('cameraSubtext').textContent = subtext || 'Hold the code inside the frame.';
  }

  function updateCameraStatus(text, kind, subtext) {
    $('cameraStatus').textContent = text;
    $('cameraStatus').className = kind ? `status-${kind}` : '';
    renderMessageState(text, kind, subtext);
  }

  function showLoginView() {
    $('loginView').classList.remove('hidden');
    $('scannerView').classList.add('hidden');
    $('manualModal').classList.add('hidden');
    $('manualModal').setAttribute('aria-hidden', 'true');
    updateMessage($('loginMessage'), '', '');
  }

  function showScannerView() {
    $('loginView').classList.add('hidden');
    $('scannerView').classList.remove('hidden');
  }

  function setRetryVisible(visible) {
    $('retryCameraBtn').classList.toggle('hidden', !visible);
  }

  function normalizeCameraError(error) {
    const message = clean(error && error.message ? error.message : error);
    const name = clean(error && error.name ? error.name : '');
    if (/NotAllowedError|PermissionDeniedError/i.test(name) || /denied|permission/i.test(message)) {
      return 'Camera permission was denied. Please allow camera access and tap Retry Camera.';
    }
    if (/NotFoundError/i.test(name) || /no camera|not found/i.test(message)) {
      return 'No camera was found on this device.';
    }
    if (/NotReadableError/i.test(name) || /in use|busy/i.test(message)) {
      return 'Camera is already in use by another app.';
    }
    if (/AbortError/i.test(name)) {
      return 'Camera start was interrupted. Tap Retry Camera.';
    }
    if (/TypeError/i.test(name) || /unsupported/i.test(message)) {
      return 'This browser does not support camera scanning on this device.';
    }
    return message || 'Unable to start camera.';
  }

  function updateCameraError(error) {
    const friendly = normalizeCameraError(error);
    state.cameraError = friendly;
    setRetryVisible(true);
    updateCameraStatus('Camera error', 'bad', friendly);
    toast(friendly, 'error');
  }

  function clearCameraError() {
    state.cameraError = '';
    setRetryVisible(false);
  }

  function stopHeartbeat() {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = 0;
  }

  function startHeartbeat() {
    stopHeartbeat();
    if (!state.session || !state.session.token) return;
    state.heartbeatTimer = setInterval(() => {
      void sendHeartbeat();
    }, 60000);
    void sendHeartbeat();
  }

  function scheduleAutoSync() {
    clearTimeout(state.autoSyncTimer);
    state.autoSyncTimer = setTimeout(() => {
      void syncQueue({ silent: true });
    }, AUTO_SYNC_DELAY_MS);
  }

  function cleanupFingerprintMap() {
    const cutoff = nowMs() - DEDUPE_WINDOW_MS;
    Array.from(state.lastScanSeen.keys()).forEach((key) => {
      const timestamp = state.lastScanSeen.get(key);
      if (!timestamp || timestamp < cutoff) state.lastScanSeen.delete(key);
    });
  }

  function makeFingerprint(rawValue, record) {
    const session = state.session || {};
    const bin = record && record.binLocation ? record.binLocation : currentBin();
    return [
      upper(rawValue || ''),
      upper(record && record.dealerCode ? record.dealerCode : session.dealerCode || ''),
      upper(bin || ''),
      clean(record && record.loginId ? record.loginId : session.loginId || '').toLowerCase(),
      clean(record && record.deviceId ? record.deviceId : session.deviceId || deviceId())
    ].join('|');
  }

  function seenRecently(fingerprint) {
    cleanupFingerprintMap();
    const last = state.lastScanSeen.get(fingerprint) || 0;
    return nowMs() - last < DEDUPE_WINDOW_MS;
  }

  function rememberFingerprint(fingerprint) {
    cleanupFingerprintMap();
    state.lastScanSeen.set(fingerprint, nowMs());
  }

  function isLoggedIn() {
    return Boolean(state.session && state.session.token);
  }

  function currentScopeMatches(record) {
    return scopeMatches(record);
  }

  function upsertQueueRecord(record) {
    const index = state.queue.findIndex((item) => clean(item.clientScanId) === clean(record.clientScanId));
    if (index >= 0) state.queue[index] = { ...state.queue[index], ...record };
    else state.queue.unshift({ ...record });
    state.queue = pruneQueue(state.queue);
    persistQueue();
  }

  function updateQueueRecords(predicate, updater) {
    let changed = false;
    state.queue = state.queue.map((record) => {
      if (!predicate(record)) return record;
      changed = true;
      return { ...record, ...updater(record) };
    });
    if (changed) persistQueue();
  }

  function clearDoneRecords() {
    const removableStatuses = new Set(['synced', 'duplicate']);
    const before = currentRecords().length;
    if (!before) return 0;
    const keep = state.queue.filter((record) => {
      if (!currentScopeMatches(record)) return true;
      return !removableStatuses.has(clean(record.syncStatus || '').toLowerCase());
    });
    if (keep.length === state.queue.length) return 0;
    const removed = state.queue.length - keep.length;
    state.queue = pruneQueue(keep);
    persistQueue();
    return removed;
  }

  function buildScanRecord(rawValue, source) {
    const session = state.session || {};
    const user = session.user && typeof session.user === 'object' ? session.user : {};
    const activeAudit = session.activeAudit && typeof session.activeAudit === 'object' ? session.activeAudit : null;
    const parsed = parseScanValue(rawValue);
    const timestamp = nowIso();
    const raw = clean(parsed.raw || rawValue);
    const partNumber = normalizePartNumber(parsed.partNumber || raw || '');
    const bin = upper(parsed.binLocation || currentBin() || '');
    const clientScanId = makeId();
    const clientSyncKey = makeId();
    return {
      clientScanId,
      clientSyncKey,
      scanId: clientScanId,
      uniqueScanId: clientScanId,
      rawScan: raw,
      rawScanString: raw,
      rawBarcode: raw,
      rawQR: raw,
      rawUpi: raw,
      partNumber,
      part: partNumber,
      qty: Number(parsed.qty || 1) || 1,
      quantity: Number(parsed.qty || 1) || 1,
      binLocation: bin,
      bin,
      dealerCode: upper(session.dealerCode || ''),
      dealerName: clean(session.dealerName || ''),
      auditId: clean(session.auditId || (activeAudit && activeAudit.auditId) || ''),
      deviceId: clean(session.deviceId || deviceId()),
      deviceName: clean(session.deviceName || buildDeviceName()),
      userId: clean(session.userId || user.id || ''),
      loginId: clean(session.loginId || user.username || user.email || '').toLowerCase(),
      staffName: clean(session.userName || user.name || user.username || ''),
      userName: clean(session.userName || user.name || user.username || ''),
      role: clean(session.role || user.role || '').toLowerCase(),
      source: source || 'camera',
      scanSource: source || 'camera',
      scanType: 'INWARD',
      type: 'INWARD',
      timestamp,
      scanTime: timestamp,
      createdAt: timestamp,
      mobileReceivedTime: timestamp,
      mobileReceivedTimeUtc: timestamp,
      syncStatus: 'pending',
      synced: false,
      isSynced: false,
      appVersion: APP_VERSION
    };
  }

  function recordExists(record) {
    const fingerprint = makeFingerprint(record.rawScan, record);
    return currentRecords().some((item) => makeFingerprint(item.rawScan, item) === fingerprint && (nowMs() - new Date(item.timestamp || item.createdAt || 0).getTime()) < 30000);
  }

  async function fetchJson(url, options) {
    const opts = options || {};
    const headers = { ...(opts.headers || {}) };
    const method = String(opts.method || 'GET').toUpperCase();
    let body = opts.body;

    if (body && typeof body === 'object' && !(body instanceof FormData)) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      body = JSON.stringify(body);
    }

    if (state.session && state.session.token && opts.auth !== false) {
      headers.Authorization = `Bearer ${state.session.token}`;
    }

    let controller = null;
    let timer = null;
    if (typeof AbortController !== 'undefined' && opts.timeout) {
      controller = new AbortController();
      timer = setTimeout(() => controller.abort(), opts.timeout);
    }

    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller ? controller.signal : undefined,
        credentials: 'same-origin'
      });
      let data = {};
      try {
        data = await response.json();
      } catch (_) {
        data = {};
      }
      if (!response.ok || (data.success === false && !opts.allowFailure)) {
        const error = new Error(data.message || response.statusText || 'Request failed');
        error.status = response.status;
        error.data = data;
        throw error;
      }
      return data;
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new Error('Server not reachable. Please check internet or try again.');
      }
      if (!navigator.onLine && opts.allowOffline !== true) {
        throw new Error('Server not reachable. Please check internet or try again.');
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function copyUrl() {
    const url = canonicalScanUrl();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const input = document.createElement('input');
        input.value = url;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        input.remove();
      }
      toast('URL copied', 'success');
    } catch (_) {
      toast(url, 'info');
    }
  }

  async function openManualModal() {
    if (!isLoggedIn()) return;
    state.resumeAfterManual = state.scanning && !state.paused;
    state.paused = true;
    stopCamera({ preserveStatus: true });
    $('manualModal').classList.remove('hidden');
    $('manualModal').setAttribute('aria-hidden', 'false');
    $('manualPartInput').value = '';
    $('manualQtyInput').value = '1';
    $('manualPartInput').focus();
  }

  function closeManualModal() {
    $('manualModal').classList.add('hidden');
    $('manualModal').setAttribute('aria-hidden', 'true');
    if (isLoggedIn() && state.resumeAfterManual) {
      state.resumeAfterManual = false;
      state.paused = false;
      void startCamera();
    }
  }

  async function submitManual(event) {
    event.preventDefault();
    if (!isLoggedIn()) {
      toast('Please sign in first', 'error');
      return;
    }
    const partNumber = normalizePartNumber($('manualPartInput').value);
    if (!partNumber) {
      toast('Part number is required', 'error');
      $('manualPartInput').focus();
      return;
    }
    const qty = Math.max(1, Number($('manualQtyInput').value || 1) || 1);
    const rawValue = `MANUAL:${partNumber}`;
    const record = buildScanRecord(rawValue, 'manual');
    record.partNumber = partNumber;
    record.part = partNumber;
    record.qty = qty;
    record.quantity = qty;
    record.syncStatus = 'pending';

    rememberFingerprint(makeFingerprint(rawValue, record));
    upsertQueueRecord(record);
    persistQueue();
    renderAll();
    closeManualModal();
    renderMessageState('Saved', 'ok', `Manual entry saved locally at ${formatDateTime(record.timestamp)}.`);
    toast('Saved', 'success');
    beep('ok');
    vibrate(24);
    scheduleAutoSync();
    await sendHeartbeat().catch(() => undefined);
  }

  async function handleDetectedValue(rawValue, source) {
    if (!isLoggedIn() || state.paused) return;
    const raw = clean(rawValue);
    if (!raw) {
      renderMessageState('Invalid QR', 'warn', 'The scanner returned an empty value.');
      beep('error');
      vibrate(20);
      return;
    }

    const fingerprint = makeFingerprint(raw, {
      dealerCode: state.session.dealerCode,
      binLocation: currentBin(),
      loginId: state.session.loginId,
      deviceId: state.session.deviceId
    });
    if (seenRecently(fingerprint) || recordExists({ rawScan: raw, dealerCode: state.session.dealerCode, binLocation: currentBin(), loginId: state.session.loginId, deviceId: state.session.deviceId })) {
      renderMessageState('Duplicate already scanned', 'warn', raw);
      toast('Duplicate already scanned', 'warn');
      beep('duplicate');
      vibrate([18, 20, 18]);
      return;
    }

    rememberFingerprint(fingerprint);
    const record = buildScanRecord(raw, source || 'camera');
    if (!record.partNumber) {
      record.partNumber = normalizePartNumber(raw);
      record.part = record.partNumber;
    }
    upsertQueueRecord(record);
    renderAll();
    renderMessageState('Saved', 'ok', `${record.partNumber || 'Scan'} saved locally at ${formatDateTime(record.timestamp)}.`);
    toast('Saved', 'success');
    beep('ok');
    vibrate(18);
    scheduleAutoSync();
    await sendHeartbeat().catch(() => undefined);
  }

  function cleanupAfterScanLoop() {
    clearTimeout(state.scanLoopTimer);
    state.scanLoopTimer = 0;
    state.scanLoopBusy = false;
  }

  function scheduleBarcodeLoop() {
    cleanupAfterScanLoop();
    if (!state.scanning || state.paused || state.cameraMode !== 'barcode') return;
    state.scanLoopTimer = setTimeout(() => {
      void barcodeLoop();
    }, CAMERA_POLL_MS);
  }

  async function barcodeLoop() {
    if (!state.scanning || state.paused || state.cameraMode !== 'barcode' || !state.barcodeDetector) {
      cleanupAfterScanLoop();
      return;
    }
    if (state.scanLoopBusy) {
      scheduleBarcodeLoop();
      return;
    }

    const video = $('cameraVideo');
    if (!video || video.readyState < 2) {
      scheduleBarcodeLoop();
      return;
    }

    state.scanLoopBusy = true;
    try {
      const codes = await state.barcodeDetector.detect(video);
      if (codes && codes.length) {
        const first = codes[0];
        const rawValue = first && first.rawValue ? first.rawValue : '';
        if (rawValue) await handleDetectedValue(rawValue, 'camera');
      }
    } catch (error) {
      if (error && !/NotFoundError|NotSupportedError|InvalidStateError/i.test(clean(error.name || error.message))) {
        console.warn('BarcodeDetector scan error', error);
      }
    } finally {
      state.scanLoopBusy = false;
      scheduleBarcodeLoop();
    }
  }

  function createBarcodeDetector() {
    if (!('BarcodeDetector' in window)) return null;
    const attempts = [
      { formats: BARCODE_FORMATS },
      null
    ];
    for (let index = 0; index < attempts.length; index += 1) {
      try {
        return attempts[index] ? new window.BarcodeDetector(attempts[index]) : new window.BarcodeDetector();
      } catch (_) {}
    }
    return null;
  }

  async function loadZxingLibrary() {
    if (window.ZXing && window.ZXing.BrowserMultiFormatReader) return window.ZXing;
    if (state.zxingPromise) return state.zxingPromise;

    state.zxingPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = ZXING_SRC;
      script.async = true;
      script.dataset.zxing = 'true';
      script.onload = () => {
        if (window.ZXing && window.ZXing.BrowserMultiFormatReader) resolve(window.ZXing);
        else reject(new Error('Scanner library failed to load'));
      };
      script.onerror = () => reject(new Error('Scanner library failed to load'));
      document.head.appendChild(script);
    });

    return state.zxingPromise;
  }

  function buildZxingHints(ZXing) {
    const hints = new Map();
    const formats = [];
    const formatNames = [
      'QR_CODE',
      'CODE_128',
      'CODE_39',
      'CODE_93',
      'EAN_13',
      'EAN_8',
      'UPC_A',
      'UPC_E',
      'ITF',
      'DATA_MATRIX',
      'PDF_417',
      'AZTEC'
    ];
    for (let index = 0; index < formatNames.length; index += 1) {
      const name = formatNames[index];
      if (ZXing.BarcodeFormat && ZXing.BarcodeFormat[name] !== undefined) {
        formats.push(ZXing.BarcodeFormat[name]);
      }
    }
    if (ZXing.DecodeHintType && ZXing.DecodeHintType.POSSIBLE_FORMATS && formats.length) {
      hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, formats);
    }
    if (ZXing.DecodeHintType && ZXing.DecodeHintType.TRY_HARDER) {
      hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    }
    return hints;
  }

  async function startBarcodeMode() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser does not support camera scanning on this device.');
    }
    const detector = createBarcodeDetector();
    if (!detector) throw new Error('Barcode detector is not available in this browser.');

    await stopCamera({ preserveStatus: true });
    const stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
    state.cameraStream = stream;
    state.barcodeDetector = detector;
    state.cameraMode = 'barcode';
    state.scanning = true;
    state.paused = false;
    clearCameraError();
    const video = $('cameraVideo');
    video.srcObject = stream;
    try {
      await video.play();
    } catch (_) {}
    updateCameraStatus('Scanning', 'good', 'Auto scan is active. Hold the code inside the frame.');
    scheduleBarcodeLoop();
  }

  async function startZxingMode() {
    const ZXing = await loadZxingLibrary();
    const reader = new ZXing.BrowserMultiFormatReader(buildZxingHints(ZXing), CAMERA_POLL_MS);
    await stopCamera({ preserveStatus: true });
    state.zxingReader = reader;
    state.cameraMode = 'zxing';
    state.scanning = true;
    state.paused = false;
    clearCameraError();
    updateCameraStatus('Scanning', 'good', 'ZXing fallback is active. Camera keeps retrying continuously.');

    const video = $('cameraVideo');
    reader.decodeFromConstraints(CAMERA_CONSTRAINTS, video, (result, error) => {
      if (result) {
        void handleDetectedValue(result.getText(), 'camera');
        return;
      }
      if (!error) return;
      const name = clean(error.name || '');
      if (/NotFoundException|ChecksumException|FormatException/i.test(name)) return;
      if (/NotAllowedError|PermissionDeniedError|NotReadableError|AbortError/i.test(name)) {
        updateCameraError(error);
        void stopCamera({ preserveStatus: true });
      } else {
        console.warn('ZXing scan error', error);
      }
    }).catch((error) => {
      if (!state.scanning) return;
      if (error && /NotAllowedError|PermissionDeniedError|NotReadableError|AbortError/i.test(clean(error.name || error.message))) {
        updateCameraError(error);
        void stopCamera({ preserveStatus: true });
        return;
      }
      console.warn('ZXing camera start error', error);
      updateCameraError(error);
      void stopCamera({ preserveStatus: true });
    });
  }

  async function startCamera() {
    if (!isLoggedIn()) return;
    state.paused = false;
    state.scanning = false;
    clearCameraError();
    renderAll();

    try {
      if ('BarcodeDetector' in window) {
        await startBarcodeMode();
      } else {
        await startZxingMode();
      }
    } catch (error) {
      const friendly = normalizeCameraError(error);
      if (state.cameraMode !== 'zxing' && 'BarcodeDetector' in window && !/permission|denied|in use|busy|not found/i.test(friendly)) {
        try {
          await startZxingMode();
          return;
        } catch (fallbackError) {
          updateCameraError(fallbackError);
          await stopCamera({ preserveStatus: true });
          state.scanning = false;
          state.cameraMode = 'idle';
          return;
        }
      }
      updateCameraError(error);
      await stopCamera({ preserveStatus: true });
      state.scanning = false;
      state.cameraMode = 'idle';
      renderMessageState('Camera unavailable', 'error', friendly);
    }
  }

  async function stopCamera(options) {
    const keepStatus = Boolean(options && options.preserveStatus);
    clearTimeout(state.scanLoopTimer);
    state.scanLoopTimer = 0;
    state.scanLoopBusy = false;
    state.scanning = false;

    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach((track) => {
        try { track.stop(); } catch (_) {}
      });
      state.cameraStream = null;
    }

    if (state.zxingReader && typeof state.zxingReader.reset === 'function') {
      try { state.zxingReader.reset(); } catch (_) {}
    }
    state.zxingReader = null;
    state.barcodeDetector = null;

    const video = $('cameraVideo');
    if (video) {
      try {
        video.pause();
      } catch (_) {}
      video.srcObject = null;
    }

    state.cameraMode = 'idle';
    if (!keepStatus) {
      updateCameraStatus('Idle', 'muted', 'Camera stopped.');
    }
  }

  async function sendHeartbeat() {
    if (!isLoggedIn()) return;
    const summary = queueSummary();
    try {
      await fetchJson('/api/mobile/heartbeat', {
        method: 'POST',
        auth: true,
        allowFailure: true,
        timeout: HEALTH_TIMEOUT_MS,
        body: {
          deviceId: state.session.deviceId,
          deviceName: state.session.deviceName,
          dealerCode: state.session.dealerCode,
          auditId: state.session.auditId,
          userId: state.session.userId,
          loginId: state.session.loginId,
          userName: state.session.userName,
          role: state.session.role,
          appVersion: APP_VERSION,
          pendingCount: summary.pending,
          failedCount: summary.failed,
          batteryPercent: null
        }
      });
    } catch (_) {}
  }

  async function refreshHealth() {
    try {
      const health = await fetchJson('/api/health', { auth: false, timeout: HEALTH_TIMEOUT_MS });
      state.health = health;
      updateStatusChips();
      updateUrlDisplay();
    } catch (error) {
      state.health = null;
      updateStatusChips();
      console.warn(error);
    }
  }

  async function refreshConfig() {
    const query = [];
    if (state.session && state.session.dealerCode) query.push(`dealerCode=${encodeURIComponent(state.session.dealerCode)}`);
    try {
      const config = await fetchJson(`/api/mobile/config${query.length ? `?${query.join('&')}` : ''}`, {
        auth: Boolean(state.session && state.session.token),
        timeout: HEALTH_TIMEOUT_MS
      });
      state.config = config;
      updateLoginHint();
      updateUrlDisplay();
      if (config && config.activeAudit) {
        const auditDealer = upper(config.activeAudit.dealerCode || config.activeAudit.activeDealerId || '');
        const auditDealerName = clean(config.activeAudit.dealerName || config.activeAudit.name || '');
        if (!state.session || !state.session.token) {
          const dealerInput = $('dealerCodeInput');
          if (!dealerInput.value && auditDealer) dealerInput.value = auditDealer;
          if (auditDealer) storageSet(STORAGE.lastDealer, auditDealer);
          if (auditDealerName) $('dealerHint').textContent = `Suggested dealer: ${auditDealer}${auditDealerName ? ` - ${auditDealerName}` : ''}`;
        }
      }
      if (config && config.loginVerified === false && state.session && state.session.token) {
        clearSession();
        toast('Session expired. Please sign in again.', 'warn');
        showLoginView();
        prefillLoginFields();
      }
    } catch (error) {
      console.warn(error);
      updateLoginHint();
    }
  }

  async function submitLogin(event) {
    event.preventDefault();
    if (state.loginBusy) return;

    const dealerCode = upper($('dealerCodeInput').value);
    const username = clean($('usernameInput').value);
    const secret = clean($('secretInput').value);

    if (!dealerCode) {
      updateMessage($('loginMessage'), 'Please select dealer code before login.', 'error');
      toast('Please select dealer code before login.', 'error');
      $('dealerCodeInput').focus();
      return;
    }
    if (!username) {
      updateMessage($('loginMessage'), 'User ID is required.', 'error');
      $('usernameInput').focus();
      return;
    }
    if (!secret) {
      updateMessage($('loginMessage'), 'Password or PIN is required.', 'error');
      $('secretInput').focus();
      return;
    }

    state.loginBusy = true;
    $('loginBtn').disabled = true;
    updateMessage($('loginMessage'), 'Signing in...', 'warn');

    const payload = {
      dealerCode,
      username,
      password: secret,
      pin: secret,
      passwordOrPin: secret,
      deviceId: deviceId(),
      deviceName: buildDeviceName(),
      model: clean(navigator.userAgent.slice(0, 120)),
      appVersion: APP_VERSION
    };

    try {
      const response = await fetchJson('/api/mobile/login', {
        method: 'POST',
        auth: false,
        timeout: 10000,
        body: payload
      });

      if (response && response.needsDealerSelection) {
        updateMessage($('loginMessage'), 'Select dealer code first to login.', 'error');
        toast('Select dealer code first to login.', 'error');
        return;
      }

      const session = normalizeSession({
        ...(state.session || {}),
        ...response,
        token: response.token,
        user: response.user || null,
        dealerCode: response.dealerCode || dealerCode,
        activeDealerId: response.activeDealerId || response.dealerCode || dealerCode,
        dealerName: response.dealerName || clean(response.activeAudit && response.activeAudit.dealerName || ''),
        activeAudit: response.activeAudit || null,
        auditId: response.auditId || (response.activeAudit && response.activeAudit.auditId) || '',
        loginId: clean((response.user && (response.user.username || response.user.email)) || username).toLowerCase(),
        userId: clean((response.user && (response.user.id || response.user.userId)) || ''),
        userName: clean((response.user && (response.user.name || response.user.username)) || username),
        staffName: clean((response.user && (response.user.name || response.user.username)) || username),
        role: clean((response.user && response.user.role) || '').toLowerCase(),
        deviceId: deviceId(),
        deviceName: buildDeviceName(),
        assignedDealers: response.assignedDealers || response.activeDealers || [],
        activeDealers: response.activeDealers || response.assignedDealers || []
      });

      saveSession(session);
      storageSet(STORAGE.lastDealer, dealerCode);
      showScannerView();
      renderSessionHeader();
      renderBinField();
      renderAll();
      updateMessage($('loginMessage'), '', '');
      toast('Login successful', 'success');
      await refreshConfig();
      await refreshHealth();
      startHeartbeat();
      void startCamera();
      scheduleAutoSync();
    } catch (error) {
      const message = clean(error && error.message ? error.message : 'Login failed');
      updateMessage($('loginMessage'), message, 'error');
      toast(message, 'error');
    } finally {
      state.loginBusy = false;
      $('loginBtn').disabled = false;
    }
  }

  function updatePauseButton() {
    $('pauseBtn').textContent = state.paused ? 'Resume' : 'Pause';
  }

  async function togglePause() {
    if (!isLoggedIn()) return;
    if (state.paused) {
      state.paused = false;
      updatePauseButton();
      renderMessageState('Camera restart requested', 'warn', 'Restarting continuous scan.');
      await startCamera();
      return;
    }
    state.paused = true;
    await stopCamera({ preserveStatus: false });
    updatePauseButton();
    updateCameraStatus('Paused', 'warn', 'Scanning is paused.');
  }

  async function syncQueue(options) {
    const silent = Boolean(options && options.silent);
    if (!isLoggedIn()) return;
    if (state.syncBusy) return;

    const pending = currentRecords().filter((record) => {
      const status = clean(record.syncStatus || 'pending').toLowerCase();
      return status === 'pending' || status === 'failed';
    });

    if (!pending.length) {
      renderAll();
      if (!silent) toast('Nothing to sync', 'info');
      return;
    }

    state.syncBusy = true;
    renderStats();

    const payload = {
      records: pending.map((record) => ({
        clientScanId: record.clientScanId,
        clientSyncKey: record.clientSyncKey,
        scanId: record.scanId || record.clientScanId,
        uniqueScanId: record.uniqueScanId || record.clientScanId,
        rawScan: record.rawScan,
        rawScanString: record.rawScanString || record.rawScan,
        rawBarcode: record.rawBarcode || record.rawScan,
        rawQR: record.rawQR || record.rawScan,
        rawUpi: record.rawUpi || record.rawScan,
        partNumber: record.partNumber,
        part: record.partNumber,
        qty: Number(record.qty || record.quantity || 1) || 1,
        quantity: Number(record.qty || record.quantity || 1) || 1,
        scanType: record.scanType || 'INWARD',
        type: record.type || 'INWARD',
        binLocation: record.binLocation || '',
        bin: record.bin || record.binLocation || '',
        dealerCode: record.dealerCode || state.session.dealerCode,
        dealerName: record.dealerName || state.session.dealerName || '',
        auditId: record.auditId || state.session.auditId || '',
        deviceId: record.deviceId || state.session.deviceId,
        deviceName: record.deviceName || state.session.deviceName || buildDeviceName(),
        userId: record.userId || state.session.userId || '',
        loginId: record.loginId || state.session.loginId || '',
        staffName: record.staffName || state.session.userName || '',
        userName: record.userName || state.session.userName || '',
        role: record.role || state.session.role || '',
        source: record.source || 'camera',
        scanSource: record.scanSource || 'camera',
        timestamp: record.timestamp,
        scanTime: record.scanTime || record.timestamp,
        mobileReceivedTime: record.mobileReceivedTime || record.createdAt || record.timestamp,
        mobileReceivedTimeUtc: record.mobileReceivedTimeUtc || record.createdAt || record.timestamp,
        appVersion: APP_VERSION
      }))
    };

    try {
      const response = await fetchJson('/api/mobile/sync-batch', {
        method: 'POST',
        auth: true,
        allowFailure: true,
        timeout: 20000,
        body: payload
      });

      const insertedIds = new Set();
      const duplicateIds = new Set();
      const failedMap = new Map();

      if (Array.isArray(response.insertedRecords)) {
        response.insertedRecords.forEach((row) => {
          const key = clean(row.clientScanId || row.clientSyncKey || row.scanId || row.uniqueScanId);
          if (key) insertedIds.add(key);
        });
      }

      if (Array.isArray(response.failedRows)) {
        response.failedRows.forEach((row) => {
          const key = clean(row.clientScanId || row.scanId || row.uniqueScanId);
          if (key) failedMap.set(key, clean(row.reason || response.message || 'Sync failed'));
        });
      }

      const submittedIds = new Set(pending.map((record) => clean(record.clientScanId)));
      const insertedCount = Number(response.insertedCount || response.syncedCount || insertedIds.size || 0);
      const duplicateCount = Number(response.duplicateCount || 0);
      const failedCount = Number(response.failedCount || failedMap.size || 0);

      state.queue = state.queue.map((record) => {
        if (!currentScopeMatches(record)) return record;
        const id = clean(record.clientScanId);
        if (!submittedIds.has(id)) return record;
        if (failedMap.has(id)) {
          return {
            ...record,
            syncStatus: 'failed',
            syncMessage: failedMap.get(id),
            updatedAt: nowIso()
          };
        }
        if (insertedIds.has(id)) {
          return {
            ...record,
            syncStatus: 'synced',
            synced: true,
            isSynced: true,
            syncMessage: 'Synced',
            syncedAt: nowIso(),
            updatedAt: nowIso()
          };
        }
        duplicateIds.add(id);
        return {
          ...record,
          syncStatus: 'duplicate',
          syncMessage: 'Duplicate already scanned',
          updatedAt: nowIso()
        };
      });

      persistQueue();
      renderAll();

      const message = parseSyncMessage(
        clean(response.message || '')
          || (insertedCount ? `Synced ${insertedCount} scan${insertedCount === 1 ? '' : 's'}` : '')
          || (duplicateCount ? 'Duplicate scans skipped' : 'Sync completed')
      );

      if (!silent) {
        if ((response.success === false || failedCount > 0) && !insertedCount && !duplicateCount) {
          toast(message, 'error');
          renderMessageState(message, 'error', 'Review failed scans and try again.');
          beep('error');
          vibrate([30, 30, 30]);
        } else if (failedCount > 0) {
          toast(message, 'warn');
          renderMessageState(message, 'warn', `${failedCount} scan${failedCount === 1 ? '' : 's'} need review.`);
          beep('duplicate');
          vibrate([20, 20]);
        } else {
          toast(message, 'success');
          renderMessageState(message, 'ok', 'Queue updated and ready for the next scan.');
          beep('ok');
          vibrate(24);
        }
      }
      await sendHeartbeat().catch(() => undefined);
    } catch (error) {
      const message = clean(error && error.message ? error.message : 'Sync failed');
      if (!silent) {
        toast(message, 'error');
        renderMessageState('Sync failed', 'error', message);
        beep('error');
        vibrate([28, 28, 28]);
      }
    } finally {
      state.syncBusy = false;
      renderStats();
    }
  }

  async function refreshSessionVerification() {
    if (!state.session || !state.session.token) return false;
    try {
      const config = await fetchJson(`/api/mobile/config${state.session.dealerCode ? `?dealerCode=${encodeURIComponent(state.session.dealerCode)}` : ''}`, {
        auth: true,
        timeout: HEALTH_TIMEOUT_MS
      });
      state.config = config;
      updateLoginHint();
      if (config && config.loginVerified === false) {
        clearSession();
        showLoginView();
        prefillLoginFields();
        updateMessage($('loginMessage'), 'Session expired. Please sign in again.', 'warn');
        toast('Session expired. Please sign in again.', 'warn');
        return false;
      }
      return true;
    } catch (error) {
      console.warn(error);
      return true;
    }
  }

  async function refreshAll() {
    await Promise.all([refreshHealth(), refreshConfig()]);
    renderAll();
  }

  function renderAll() {
    updateStatusChips();
    updateUrlDisplay();
    renderSessionHeader();
    renderBinField();
    renderStats();
    renderHistory();
    updatePauseButton();
    const statusNode = $('cameraStatus');
    if (state.cameraError) {
      statusNode.textContent = 'Camera error';
      statusNode.className = 'status-bad';
      setRetryVisible(true);
    } else if (state.paused) {
      statusNode.textContent = 'Paused';
      statusNode.className = 'status-warn';
    } else if (state.scanning) {
      statusNode.textContent = 'Scanning';
      statusNode.className = 'status-good';
    } else {
      statusNode.textContent = 'Idle';
      statusNode.className = 'status-muted';
    }
  }

  async function boot() {
    const ids = [
      'serverChip',
      'dbChip',
      'scanUrlText',
      'copyUrlBtn',
      'loginView',
      'scannerView',
      'dealerHint',
      'loginForm',
      'dealerCodeInput',
      'usernameInput',
      'secretInput',
      'loginBtn',
      'loginMessage',
      'sessionTitle',
      'sessionMeta',
      'retryCameraBtn',
      'logoutBtn',
      'dealerText',
      'binInput',
      'queueCount',
      'cameraStatus',
      'cameraVideo',
      'scanMessage',
      'cameraSubtext',
      'syncBtn',
      'manualBtn',
      'pauseBtn',
      'pendingCount',
      'syncedCount',
      'failedCount',
      'historyList',
      'clearDoneBtn',
      'toast',
      'manualModal',
      'manualForm',
      'manualPartInput',
      'manualQtyInput',
      'closeManualBtn'
    ];
    ids.forEach((id) => {
      els[id] = document.getElementById(id);
    });

    const dealerInput = $('dealerCodeInput');
    const usernameInput = $('usernameInput');
    const secretInput = $('secretInput');
    const binInput = $('binInput');
    const manualPartInput = $('manualPartInput');

    dealerInput.addEventListener('input', (event) => {
      event.target.value = upper(event.target.value);
    });
    usernameInput.addEventListener('input', (event) => {
      event.target.value = clean(event.target.value);
    });
    secretInput.addEventListener('input', (event) => {
      event.target.value = clean(event.target.value);
    });
    binInput.addEventListener('input', (event) => {
      event.target.value = upper(event.target.value);
      saveBin(event.target.value);
      renderAll();
    });
    manualPartInput.addEventListener('input', (event) => {
      event.target.value = upper(event.target.value);
    });

    $('copyUrlBtn').addEventListener('click', () => {
      void copyUrl();
    });
    $('loginForm').addEventListener('submit', (event) => {
      void submitLogin(event);
    });
    $('logoutBtn').addEventListener('click', () => {
      void logout();
    });
    $('retryCameraBtn').addEventListener('click', () => {
      if (isLoggedIn()) void startCamera();
    });
    $('syncBtn').addEventListener('click', () => {
      void syncQueue({ silent: false });
    });
    $('manualBtn').addEventListener('click', () => {
      void openManualModal();
    });
    $('pauseBtn').addEventListener('click', () => {
      void togglePause();
    });
    $('clearDoneBtn').addEventListener('click', () => {
      const removed = clearDoneRecords();
      renderAll();
      toast(removed ? `Cleared ${removed} completed scan${removed === 1 ? '' : 's'}` : 'No completed scans to clear', removed ? 'success' : 'info');
    });
    $('manualForm').addEventListener('submit', (event) => {
      void submitManual(event);
    });
    $('closeManualBtn').addEventListener('click', () => {
      closeManualModal();
    });
    $('manualModal').addEventListener('click', (event) => {
      if (event.target && event.target.dataset && event.target.dataset.close === 'true') {
        closeManualModal();
      }
    });

    window.addEventListener('online', () => {
      updateStatusChips();
      void refreshAll();
      if (isLoggedIn()) {
        void startHeartbeat();
        scheduleAutoSync();
      }
    });

    window.addEventListener('offline', () => {
      updateStatusChips();
      toast('Offline mode. Scans will stay on the device until connection returns.', 'warn');
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (state.scanning) {
          void stopCamera({ preserveStatus: true });
        }
      } else if (isLoggedIn() && !state.paused) {
        void startCamera();
      }
    });

    window.addEventListener('pagehide', () => {
      void stopCamera({ preserveStatus: true });
      stopHeartbeat();
    });

    window.addEventListener('beforeunload', () => {
      void stopCamera({ preserveStatus: true });
      stopHeartbeat();
    });

    updateUrlDisplay();
    updateStatusChips();
    updateLoginHint();
    prefillLoginFields();
    renderAll();

    await refreshAll();

    if (state.session && state.session.token) {
      showScannerView();
      renderSessionHeader();
      renderBinField();
      if (!(await refreshSessionVerification())) {
        return;
      }
      startHeartbeat();
      renderAll();
      void startCamera();
      scheduleAutoSync();
    } else {
      showLoginView();
      updateMessage($('loginMessage'), '', '');
      renderAll();
    }
  }

  async function logout() {
    await stopCamera({ preserveStatus: true });
    stopHeartbeat();
    clearSession();
    state.paused = false;
    updatePauseButton();
    showLoginView();
    prefillLoginFields();
    updateMessage($('loginMessage'), 'Signed out. Please login again.', 'warn');
    toast('Signed out', 'info');
  }

  boot().catch((error) => {
    console.error(error);
    toast(error && error.message ? error.message : 'Failed to initialize mobile scanner', 'error');
    showLoginView();
  });
})();
