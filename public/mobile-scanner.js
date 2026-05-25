(function () {
  const APP_VERSION = 'Daksh Mobile Web Scanner v1.0.0';
  const DB_NAME = 'daksh-mobile-scanner';
  const STORE = 'scans';
  const SESSION_KEY = 'dakshMobileSession';
  const DEVICE_KEY = 'dakshMobileDeviceId';
  const ACTIVE_BIN_KEY = 'dakshMobileActiveBinLocation';
  const SYNC_INTERVAL_MS = 120000;
  const DUPLICATE_GUARD_MS = 1500;
  const BATCH_SIZE = 50;

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
    recentRaw: new Map(),
    lastScanAtByRaw: new Map(),
    socket: null,
    manualPart: null,
    activeBinLocation: upper(localStorage.getItem(ACTIVE_BIN_KEY) || '')
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

  async function deleteScan(scanId) {
    await requestToPromise(txStore('readwrite').delete(scanId));
  }

  async function counts() {
    const rows = await getAllScans();
    return {
      rows,
      pending: rows.filter((row) => row.status === 'pending').length,
      failed: rows.filter((row) => row.status === 'failed').length,
      synced: rows.filter((row) => row.status === 'synced').length
    };
  }

  function api(path, options = {}) {
    const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
    if (state.session?.token) headers.authorization = `Bearer ${state.session.token}`;
    return fetch(path, {
      ...options,
      headers,
      body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) throw new Error(data.message || `HTTP ${res.status}`);
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
    }
    updateSyncUi().catch(() => undefined);
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
    if (state.activeBinLocation) localStorage.setItem(ACTIVE_BIN_KEY, state.activeBinLocation);
    else localStorage.removeItem(ACTIVE_BIN_KEY);
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
    const last = localStorage.getItem('dakshMobileLastSync') || '';
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
        <td>${escapeHtml(row.scanType)}</td>
        <td>${escapeHtml(row.status)}</td>
      </tr>
    `).join('') : '<tr><td colspan="5">No scans yet</td></tr>';
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
      qty: Number(keyed(['QTY', 'QUANTITY']) || 1) || 1,
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
    const now = Date.now();
    const recentAt = state.lastScanAtByRaw.get(rawUPI);
    if (recentAt && now - recentAt < DUPLICATE_GUARD_MS) {
      beep('bad');
      toast('Already scanned', 'error');
      return null;
    }
    state.lastScanAtByRaw.set(rawUPI, now);
    const existing = (await getAllScans()).find((row) => row.rawUPI === rawUPI && row.status !== 'failed-duplicate');
    if (existing) {
      beep('bad');
      toast('Already scanned', 'error');
      return null;
    }
    const master = input.master || await enrichPart(partNumber);
    let record = {
      scanId: input.scanId || `${deviceId()}-${now}-${Math.random().toString(16).slice(2, 8)}`,
      userId: state.session.user?.id || state.session.user?.username || '',
      loginId: state.session.user?.username || '',
      userName: state.session.user?.name || state.session.user?.username || '',
      role: state.session.user?.role || '',
      dealerCode: state.session.dealerCode,
      dealerName: state.session.dealerName || '',
      partNumber,
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
      partDescription: master?.partDescription || master?.partName || '',
      category: master?.productCategory || master?.category || '',
      productCategory: master?.productCategory || master?.category || '',
      mrp: Number(master?.mrp || input.mrp || 0),
      dlc: Number(master?.dlc || input.dlc || 0),
      model: master?.model || '',
      year: master?.year || master?.manufacturingYear || ''
    };
    record = await promptExtraFields(record);
    await putScan(record);
    $('#lastPart').textContent = record.partNumber;
    $('#lastMeta').textContent = `${record.scanType} | Qty ${record.qty} | ${record.status === 'pending' && navigator.onLine ? 'Queued for sync' : 'Offline Saved'}`;
    beep('ok');
    toast(navigator.onLine ? 'Saved locally, syncing' : 'Offline Saved', 'success');
    updateSyncUi().catch(() => undefined);
    if (navigator.onLine) syncPending({ silent: true }).catch(() => undefined);
    return record;
  }

  async function syncPending(options = {}) {
    if (state.syncing || !state.session?.token || !navigator.onLine) return;
    state.syncing = true;
    try {
      const all = await getAllScans();
      const batch = all.filter((row) => row.status === 'pending' || row.status === 'failed').slice(0, BATCH_SIZE);
      if (!batch.length) {
        if (!options.silent) toast('Nothing pending');
        return;
      }
      const data = await api('/api/mobile/sync-batch', {
        method: 'POST',
        body: {
          deviceId: deviceId(),
          deviceName: state.session.deviceName || '',
          appVersion: APP_VERSION,
          pendingCount: batch.length,
          batteryPercent: await batteryPercent(),
          records: batch.map((row) => ({ ...row, localCreatedAt: row.mobileCreatedAt }))
        }
      });
      const inserted = new Map((data.insertedRecords || []).map((row) => [clean(row.clientScanId || row.scanId || row.uniqueScanId), row]));
      const duplicateIds = new Set((data.logs || []).filter((log) => log.status === 'duplicate').map((log) => clean(log.clientScanId || log.localId || log.scanId)));
      const failedIds = new Set((data.logs || []).filter((log) => log.status === 'failed').map((log) => clean(log.clientScanId || log.localId || log.scanId)));
      for (const row of batch) {
        const saved = inserted.get(row.scanId) || inserted.get(row.clientScanId);
        if (saved || duplicateIds.has(row.scanId)) {
          await putScan({ ...row, status: 'synced', syncStatus: 'synced', timestamp: saved?.timestamp || saved?.serverReceivedAt || nowIso(), serverAck: saved || null });
        } else if (failedIds.has(row.scanId)) {
          await putScan({ ...row, status: 'failed', syncStatus: 'failed', syncError: 'Server failed this record' });
        } else if (data.success) {
          await putScan({ ...row, status: 'synced', syncStatus: 'synced', timestamp: nowIso() });
        }
      }
      localStorage.setItem('dakshMobileLastSync', nowIso());
      if (!options.silent) toast(data.message || 'Sync complete', 'success');
      sendHeartbeat().catch(() => undefined);
    } catch (error) {
      const batch = (await getAllScans()).filter((row) => row.status === 'pending').slice(0, BATCH_SIZE);
      for (const row of batch) await putScan({ ...row, status: 'failed', syncStatus: 'failed', syncError: error.message });
      if (!options.silent) toast(error.message, 'error');
    } finally {
      state.syncing = false;
      updateSyncUi().catch(() => undefined);
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
        width: { ideal: 960, max: 1280 },
        height: { ideal: 540, max: 720 },
        frameRate: { ideal: 12, max: 18 }
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
    if (!state.stream || state.paused || !state.detector) {
      state.scanTimer = setTimeout(scanLoop, 450);
      return;
    }
    try {
      const codes = await state.detector.detect($('#cameraPreview'));
      const raw = clean(codes && codes[0] && codes[0].rawValue);
      if (raw) await saveLocalScan({ rawUPI: raw }, 'mobile');
    } catch (_) {
      $('#cameraState').textContent = 'Scanner active. If QR is not detected, use Manual Entry.';
    } finally {
      state.scanTimer = setTimeout(scanLoop, 360);
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

  async function login(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = {
      username: clean(form.get('username')),
      password: String(form.get('password') || ''),
      pin: String(form.get('pin') || ''),
      dealerCode: upper(form.get('dealerCode')),
      deviceId: deviceId(),
      deviceName: clean(form.get('deviceName')) || 'Android Chrome',
      appVersion: APP_VERSION,
      model: navigator.userAgent.slice(0, 120)
    };
    $('#loginMessage').textContent = 'Verifying...';
    const data = await api('/api/mobile/login', { method: 'POST', body: payload });
    saveSession({ ...data, deviceName: payload.deviceName });
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
    clearSession();
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
    await Promise.all(rows.filter((row) => row.status === 'synced').map((row) => deleteScan(row.scanId)));
    toast('Synced local cache cleared', 'success');
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
      await Promise.all(rows.filter((row) => row.status === 'failed').map((row) => putScan({ ...row, status: 'pending', syncStatus: 'pending' })));
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
    bindEvents();
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
