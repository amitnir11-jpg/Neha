(function () {
  const UI_BOOT_VERSION = '20260521-frontend-diagnostics';
  const uiBootStartedAt = Date.now();
  const uiBootRoot = window.__DAKSH_DASHBOARD_BOOT__ || (window.__DAKSH_DASHBOARD_BOOT__ = {
    startedAt: new Date(uiBootStartedAt).toISOString(),
    markers: []
  });

  function errorDetails(error) {
    return {
      message: error && error.message ? error.message : String(error),
      status: error && error.status,
      stack: error && error.stack
    };
  }

  function bootMark(level, label, details = {}) {
    const entry = {
      label,
      ms: Date.now() - uiBootStartedAt,
      details
    };
    if (!Array.isArray(uiBootRoot.markers)) uiBootRoot.markers = [];
    uiBootRoot.markers.push(entry);
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    console[method](`[DAKSH_UI_BOOT] ${label}`, entry);
  }

  const bootLog = (label, details = {}) => bootMark('log', label, details);
  const bootWarn = (label, details = {}) => bootMark('warn', label, details);
  const bootError = (label, details = {}) => bootMark('error', label, details);

  function storageGet(key) {
    try {
      return window.localStorage ? localStorage.getItem(key) : null;
    } catch (error) {
      bootWarn('localStorage read failed', { key, error: errorDetails(error) });
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      if (window.localStorage) localStorage.setItem(key, value);
    } catch (error) {
      bootWarn('localStorage write failed', { key, error: errorDetails(error) });
    }
  }

  function storageRemove(key) {
    try {
      if (window.localStorage) localStorage.removeItem(key);
    } catch (error) {
      bootWarn('localStorage remove failed', { key, error: errorDetails(error) });
    }
  }

  function readStoredJson(key) {
    const raw = storageGet(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (error) {
      bootError('localStorage JSON parse failed', {
        key,
        rawPreview: raw.slice(0, 120),
        error: errorDetails(error)
      });
      return null;
    }
  }

  bootLog('ui.js executing', {
    version: UI_BOOT_VERSION,
    href: window.location.href,
    readyState: document.readyState,
    tokenPresent: Boolean(storageGet('dakshToken')),
    userPresent: Boolean(storageGet('dakshUser')),
    socketIoPresent: Boolean(window.io)
  });

  window.addEventListener('error', (event) => {
    bootError('window error observed by ui.js', {
      message: event.message,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
      error: event.error ? errorDetails(event.error) : null
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    bootError('unhandled promise rejection observed by ui.js', errorDetails(event.reason));
  });

  const state = {
    token: storageGet('dakshToken') || '',
    user: readStoredJson('dakshUser'),
    dealers: [],
    users: [],
    categories: [],
    reportProductGroups: [],
    reportProductSubGroups: [],
    reportGroupSubGroups: {},
    autoSyncTimer: null,
    dashboardFallbackTimer: null,
    scanRefreshTimer: null,
    scanRefreshInFlight: false,
    scanRefreshQueued: false,
    deviceRefreshTimer: null,
    lastRealtimeAt: 0,
    dashboardFallbackBusy: false,
    recentRealtimeScanIds: new Set(),
    dashboardProductGroupRows: [],
    selectedProductGroupSummary: null,
    productGroupDetailRows: [],
    productGroupDetailTotals: null,
    adminDeleteRows: [],
    adminDeleteSelectedIds: new Set(),
    adminDeleteLastPreview: null,
    clockSkewRows: [],
    clockSkewSelectedIds: new Set(),
    locationDeleteLastCount: null,
    auditBackups: [],
    auditRestoreSessionId: '',
    auditRestorePollTimer: null,
    syncInProgress: false,
    deviceId: storageGet('dakshDeviceId') || '',
    activeDeviceCount: 0,
    serverInfo: null,
    lastSyncStatus: {},
    lastSyncResponse: null,
    lastReportType: '',
    reportLoaded: false,
    reportHasRun: false,
    reportLoading: false,
    reportLoadRequestId: 0,
    reportAbortController: null,
    reportCache: new Map(),
    reportSearchTimer: null,
    reportStaleNoticeAt: 0,
    reportTableRows: [],
    reportTableColumns: [],
    reportTableTotalRows: 0,
    reportTableGrandTotal: null,
    reportFilterSettings: {},
    reportFilterSettingsLoaded: new Set(),
    reportFilterDropdownsLoadedAt: 0,
    reportSort: { reportType: '', key: '', direction: 'asc' },
    dashboardDealerCode: '',
    reconLoaded: false,
    validatorInvalidRows: [],
    validatorMapIndex: null,
    masterSearch: { q: '', page: 1, limit: 25, total: 0 },
    masterSearchRows: [],
    activeAudit: null,
    binTransferParts: [],
    binTransferLoadedParts: [],
    binTransferDestinationBins: [],
    binLabelBins: [],
    binLabelParts: [],
    binLabelSelectedKeys: new Set(),
    binLabelPreviewItems: [],
    binLabelSettings: null,
    binMasterRows: [],
    barcodeAutoSaving: false,
    barcodeLastRaw: '',
    barcodeLastAt: 0
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const SYNC_QUEUE_KEY = 'dakshInventorySyncQueue';
  const SYNC_LOG_KEY = 'dakshInventorySyncLog';
  const CONNECTION_LOG_KEY = 'dakshInventoryConnectionLog';
  const LAST_SYNC_KEY = 'dakshLastSyncTime';
  const AUTO_SYNC_KEY = 'dakshAutoSyncEnabled';
  const REPORT_LAYOUT_KEY = 'dakshReportLayoutPrefs';
  const REPORT_COLUMN_SETTINGS_KEY = 'dakshReportColumnSettings';
  const REPORT_TAB_WIDTHS_KEY = 'dakshReportTabWidthsSession';
  const ACTIVE_VIEW_KEY = 'dakshActiveView';
  const REPORT_STATE_KEY = 'dakshLastReportState';
  const REPORT_SCAN_MODE_DEFAULT_VERSION = 4;
  const REPORT_FILTER_DEFAULTS = ['dealer', 'dateRange', 'scanType', 'scanStatus', 'userName', 'syncStatus'];
  const REPORT_FILTER_DEFAULTS_BY_TYPE = {
    'scan-register': ['dealer', 'dateRange', 'scanType', 'scanStatus', 'userName', 'deviceName', 'syncStatus', 'entryMode']
  };
  const REPORT_FILTER_OPTIONS = [
    ['dealer', 'Dealer'],
    ['dealerName', 'Dealer Name'],
    ['dateRange', 'Date / Scan Time Range'],
    ['scanType', 'Scan Type'],
    ['scanStatus', 'Scan Status'],
    ['userName', 'User Name'],
    ['syncStatus', 'Sync Status'],
    ['audit', 'Audit'],
    ['auditDate', 'Audit Date'],
    ['productGroup', 'Product Group'],
    ['productSubGroup', 'Product Sub Group'],
    ['upiRawQr', 'UPI Raw / QR'],
    ['role', 'Role'],
    ['deviceName', 'Device Name'],
    ['deviceId', 'Device ID'],
    ['entryMode', 'Entry Mode'],
    ['entryChannel', 'Entry Channel'],
    ['entrySource', 'Entry Source'],
    ['binLocation', 'Bin Location'],
    ['partNumber', 'Part Number'],
    ['productCategory', 'Product Category'],
    ['model', 'Model'],
    ['year', 'Year'],
    ['action', 'Action'],
    ['varianceType', 'Variance Type'],
    ['scanModeOptions', 'Inventory Audit Options']
  ];
  const DATA_VERSION_KEY = 'dakshDataVersion';
  const BARCODE_LAST_BIN_KEY = 'dakshBarcodeLastBin';
  const SIDEBAR_WIDTH_KEY = 'dakshSidebarWidth';
  const SIDEBAR_MIN_WIDTH = 90;
  const SIDEBAR_MAX_WIDTH = 260;
  const SIDEBAR_WIDE_WIDTH = 132;
  const CURRENT_DATA_VERSION = '2026-05-12-real-scans-only';
  if (storageGet(DATA_VERSION_KEY) !== CURRENT_DATA_VERSION) {
    bootLog('local data version refresh', {
      from: storageGet(DATA_VERSION_KEY) || '',
      to: CURRENT_DATA_VERSION
    });
    [SYNC_QUEUE_KEY, SYNC_LOG_KEY, CONNECTION_LOG_KEY, 'dakshReportPreviewCache'].forEach((key) => storageRemove(key));
    storageSet(DATA_VERSION_KEY, CURRENT_DATA_VERSION);
  }
  const REPORT_TITLES = {
    'bin-wise-stock': 'Bin Wise Stock Report',
    'user-dealer-wise': 'User & Dealer Wise Report',
    'movement-scans': 'Movement Scan Report',
    'raw-upi': 'Raw UPI Report',
    'scan-register': 'Scan Register Report',
    'wrong-not-found-master': 'Rejected Report',
    'main-inventory-audit': 'Main Inventory Audit Report',
    'compile-audit': 'Compile Audit Report',
    'consolidated-final': 'Consolidated Final Report',
    'stock-summary': 'Stock Summary',
    'category-wise-variance-summary': 'Category Wise Variance Summary',
    'partwise-inventory-audit': 'Partwise Inventory Audit Report',
    'parts-inventory-refresh-template': 'Part Inventory Refresh Template CSV'
  };
  const CSV_REPORT_TYPES = new Set(['parts-inventory-refresh-template']);
  const EXCEL_ONLY_REPORT_TYPES = new Set(['stock-summary']);
  const REPORT_LAYOUT_KEYS = {
    'partwise-inventory-audit': 'partwise_inventory_audit_report_layout_v2',
    'bin-wise-stock': 'bin_wise_report_layout',
    'bin-stock': 'bin_wise_report_layout',
    'bin-wise': 'bin_wise_report_layout',
    'category-wise-variance-summary': 'category_variance_report_layout',
    'consolidated-final': 'consolidated_report_layout',
    'wrong-not-found-master': 'wrong_not_found_master_report_layout'
  };
  const VIEW_TITLES = {
    dashboard: 'Dashboard',
    scan: 'Scan',
    reports: 'Reports',
    binTransfer: 'Bin Transfer',
    reconciliation: 'Reconciliation',
    master: 'Master Data',
    validator: 'Validator',
    qr: 'QR / Barcode',
    devices: 'Device Control',
    syncCenter: 'Sync Report',
    archiveRestore: 'Archive & Restore Center',
    admin: 'Admin Settings'
  };

  function ensureDeviceId() {
    if (!state.deviceId) {
      state.deviceId = `WEB-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      localStorage.setItem('dakshDeviceId', state.deviceId);
    }
    return state.deviceId;
  }

  function isMobileClient() {
    return /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  }

  let scanAudioContext = null;
  function playTone(frequency, duration, delay = 0) {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      scanAudioContext = scanAudioContext || new AudioContext();
      const startAt = scanAudioContext.currentTime + delay;
      const oscillator = scanAudioContext.createOscillator();
      const gain = scanAudioContext.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, startAt);
      gain.gain.setValueAtTime(0.001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.16, startAt + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, startAt + duration);
      oscillator.connect(gain);
      gain.connect(scanAudioContext.destination);
      oscillator.start(startAt);
      oscillator.stop(startAt + duration + 0.02);
    } catch (error) {
      console.debug('Scan audio unavailable', error.message);
    }
  }

  function playScanTone(type = 'success') {
    if (type === 'duplicate') {
      playTone(880, 0.08);
      playTone(880, 0.08, 0.14);
      return;
    }
    if (type === 'error') {
      playTone(220, 0.45);
      return;
    }
    playTone(1040, 0.1);
  }

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatDealerDisplay(dealer = {}) {
    const code = cleanDealerCode(dealer.dealerCode || dealer.code || '');
    const name = String(dealer.dealerName || dealer.name || '').trim();
    if (code && name) return `${code} - ${name}`;
    return code || name || 'Dealer';
  }

  function normalizeLastSyncValue(...values) {
    for (const value of values) {
      const text = String(value || '').trim();
      if (!text || /^never$/i.test(text)) continue;
      const date = new Date(text);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
    return '';
  }

  function rememberLastSyncTime(...values) {
    const normalized = normalizeLastSyncValue(...values);
    if (normalized) storageSet(LAST_SYNC_KEY, normalized);
    return normalized;
  }

  function selectedOptionText(select) {
    if (!select) return '';
    const option = select.options && select.options[select.selectedIndex];
    return option ? String(option.textContent || option.label || option.value || '').trim() : '';
  }

  function fitDashboardDealerSelect(select = $('#dashboardDealerSelect')) {
    if (!select) return;
    const labels = Array.from(select.options || [])
      .map((option) => String(option.textContent || option.label || option.value || '').trim())
      .filter(Boolean);
    const longest = labels.reduce((best, label) => (label.length > best.length ? label : best), selectedOptionText(select));
    const measurer = document.createElement('span');
    const style = window.getComputedStyle(select);
    measurer.style.position = 'fixed';
    measurer.style.left = '-9999px';
    measurer.style.top = '-9999px';
    measurer.style.visibility = 'hidden';
    measurer.style.whiteSpace = 'nowrap';
    measurer.style.font = style.font;
    measurer.textContent = longest || 'Active Audit';
    document.body.appendChild(measurer);
    const textWidth = Math.ceil(measurer.getBoundingClientRect().width);
    measurer.remove();
    const left = select.getBoundingClientRect().left || 0;
    const viewportRoom = Math.max(320, window.innerWidth - left - 24);
    const width = Math.min(Math.max(360, textWidth + 64), Math.min(760, viewportRoom));
    const wrapper = $('#dashboardDealerFilters');
    select.style.width = `${width}px`;
    select.style.maxWidth = '100%';
    if (wrapper) wrapper.style.width = `min(${width}px, 100%)`;
  }

  function syncDealerSelectDisplay(select) {
    if (!select) return;
    select.title = selectedOptionText(select);
    if (select.id === 'dashboardDealerSelect') fitDashboardDealerSelect(select);
  }

  function clampSidebarWidth(width) {
    const parsed = Number.parseInt(width, 10);
    if (!Number.isFinite(parsed)) return SIDEBAR_MIN_WIDTH;
    return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, parsed));
  }

  let sidebarWidth = SIDEBAR_MIN_WIDTH;

  function storedSidebarWidth() {
    try {
      return window.localStorage ? localStorage.getItem(SIDEBAR_WIDTH_KEY) : '';
    } catch (error) {
      console.warn('Sidebar width preference unavailable', error.message);
      return '';
    }
  }

  function saveSidebarWidth(width) {
    try {
      if (window.localStorage) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
    } catch (error) {
      console.warn('Sidebar width preference not saved', error.message);
    }
  }

  function clearSidebarWidth() {
    try {
      if (window.localStorage) localStorage.removeItem(SIDEBAR_WIDTH_KEY);
    } catch (error) {
      console.warn('Sidebar width preference not cleared', error.message);
    }
  }

  function applySidebarWidth(width, persist = false) {
    sidebarWidth = clampSidebarWidth(width);
    document.documentElement.style.setProperty('--sidebar-width-desktop', `${sidebarWidth}px`);
    if (document.body) document.body.classList.toggle('sidebar-wide', sidebarWidth >= SIDEBAR_WIDE_WIDTH);
    if (persist) saveSidebarWidth(sidebarWidth);
    return sidebarWidth;
  }

  function initSidebarResize() {
    const handle = $('#sideResizeHandle');
    applySidebarWidth(storedSidebarWidth() || SIDEBAR_MIN_WIDTH);
    if (!handle) return;
    let startX = 0;
    let startWidth = sidebarWidth;
    let dragging = false;

    function stopDragging() {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('sidebar-resizing');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stopDragging);
      window.removeEventListener('pointercancel', stopDragging);
    }

    function onMove(event) {
      if (!dragging) return;
      applySidebarWidth(startWidth + event.clientX - startX, true);
      event.preventDefault();
    }

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      dragging = true;
      startX = event.clientX;
      startWidth = sidebarWidth;
      document.body.classList.add('sidebar-resizing');
      if (handle.setPointerCapture && event.pointerId !== undefined) handle.setPointerCapture(event.pointerId);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', stopDragging);
      window.addEventListener('pointercancel', stopDragging);
      event.preventDefault();
    });

    handle.addEventListener('dblclick', () => {
      clearSidebarWidth();
      applySidebarWidth(SIDEBAR_MIN_WIDTH);
    });
  }

  function dashboardHref(params = {}) {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && String(value).trim() !== '') query.set(key, String(value).trim());
    });
    const qs = query.toString();
    return qs ? `/dashboard?${qs}` : '/dashboard';
  }

  function isExternalHref(href) {
    try {
      const url = new URL(href, window.location.origin);
      return url.origin !== window.location.origin;
    } catch (error) {
      return false;
    }
  }

  function enterpriseLink(value, href, options = {}) {
    const text = String(value === undefined || value === null || value === '' ? '-' : value);
    if (text === '-' || !href) return escapeHtml(text);
    const label = options.label || `Open ${text} in a new tab`;
    const classes = ['enterprise-link', options.className || ''].filter(Boolean).join(' ');
    const external = options.external ?? isExternalHref(href);
    return `<a class="${escapeHtml(classes)}" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(label)}" data-external="${external ? 'true' : 'false'}">${escapeHtml(text)}</a>`;
  }

  function partLink(partNumber, className = 'table-link') {
    const part = String(partNumber || '').trim();
    return part ? enterpriseLink(part, dashboardHref({ view: 'master', partNumber: part }), { className, label: `Open part ${part} in a new tab` }) : escapeHtml(partNumber || '-');
  }

  function deviceLink(deviceId, className = 'table-link') {
    const id = String(deviceId || '').trim();
    return id ? enterpriseLink(id, dashboardHref({ view: 'devices', deviceId: id }), { className, label: `Open device ${id} in a new tab` }) : escapeHtml(deviceId || '-');
  }

  function scannerLink(device = {}, className = 'table-link') {
    const name = String(device.deviceName || device.deviceId || '').trim();
    const id = String(device.deviceId || name).trim();
    return name ? enterpriseLink(name, dashboardHref({ view: 'devices', deviceId: id }), { className, label: `Open scanner ${name} in a new tab` }) : escapeHtml('-');
  }

  function secureNewTabLinks(root = document) {
    root.querySelectorAll('a[href]').forEach((link) => {
      const href = link.getAttribute('href') || '';
      if (!href || href === '#' || href.startsWith('javascript:')) return;
      link.target = '_blank';
      const rel = new Set(String(link.rel || '').split(/\s+/).filter(Boolean));
      rel.add('noopener');
      rel.add('noreferrer');
      link.rel = Array.from(rel).join(' ');
      if (isExternalHref(link.href)) link.dataset.external = 'true';
    });
  }

  const IST_TIME_ZONE = 'Asia/Kolkata';
  const IST_DATE_TIME_FORMAT = new Intl.DateTimeFormat('en-IN', {
    timeZone: IST_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });
  const DISPLAY_IST_DATE_TIME_RE = /^\d{2}-[A-Za-z]{3}-\d{4}\s+\d{2}:\d{2}:\d{2}\s+(AM|PM)$/i;

  function istDateTimeParts(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return IST_DATE_TIME_FORMAT.formatToParts(date).reduce((acc, part) => {
      if (part.type !== 'literal') acc[part.type] = part.value;
      return acc;
    }, {});
  }

  function dateTime(value) {
    if (typeof value === 'string' && DISPLAY_IST_DATE_TIME_RE.test(value.trim())) {
      return value.trim().replace(/\s+(am|pm)$/i, (match) => match.toUpperCase());
    }
    const parts = istDateTimeParts(value);
    if (!parts) return value ? String(value) : '';
    return `${parts.day}-${parts.month}-${parts.year} ${parts.hour}:${parts.minute}:${parts.second} ${String(parts.dayPeriod || '').toUpperCase()}`;
  }

  function wholeNumber(value) {
    return Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  }

  function compactDateTime(value, separator = ' ') {
    const formatted = dateTime(value);
    return separator === ' ' ? formatted : formatted.replace(' ', separator);
  }

  function dashboardScanTime(value) {
    const formatted = dateTime(value);
    const match = formatted.match(/^(\d{2}-[A-Za-z]{3}-\d{4})\s+(\d{2}:\d{2}):\d{2}\s+(AM|PM)$/);
    return match ? `${match[1]}\n${match[2]} ${match[3]}` : formatted;
  }

  function money(value) {
    return Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }

  function money2(value) {
    return Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function percent2(value) {
    return `${(Number(value || 0) * 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  }

  function toast(message, type = 'success') {
    const node = $('#toast');
    node.textContent = message;
    node.className = `toast active ${type}`;
    setTimeout(() => node.classList.remove('active'), 3600);
  }

  function showScanPopup(scan = {}) {
    const node = $('#scanPopup');
    if (!node) return;
    const partNumber = scan.partNumber || scan.part || '-';
    const dealer = scan.dealerName || scan.dealerCode || '-';
    node.innerHTML = `
      <strong>Part Scanned Successfully</strong>
      <dl>
        <div><dt>Part Number</dt><dd>${escapeHtml(partNumber)}</dd></div>
        <div><dt>Part Description</dt><dd>${escapeHtml(scan.partDescription || scan.partName || '-')}</dd></div>
        <div><dt>Category</dt><dd>${escapeHtml(scan.category || '-')}</dd></div>
        <div><dt>Qty</dt><dd>${escapeHtml(scan.qty || scan.quantity || 0)}</dd></div>
        <div><dt>Bin</dt><dd>${escapeHtml(scan.binLocation || scan.bin || '-')}</dd></div>
        <div><dt>Dealer</dt><dd>${escapeHtml(dealer)}</dd></div>
        <div><dt>Time</dt><dd>${escapeHtml(dateTime(scan.timestamp || new Date()))}</dd></div>
      </dl>
    `;
    node.classList.add('active');
    clearTimeout(node.hideTimer);
    node.hideTimer = setTimeout(() => node.classList.remove('active'), 5200);
  }

  function logout() {
    clearSession();
    window.location.href = '/';
  }

  function clearSession() {
    bootLog('clearSession called');
    state.token = '';
    state.user = null;
    storageRemove('dakshToken');
    storageRemove('dakshUser');
  }

  async function parseApiResponse(response) {
    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    if (!text) return null;
    if (!contentType.includes('application/json')) return text;

    try {
      return JSON.parse(text);
    } catch (error) {
      return {
        invalidJson: true,
        success: false,
        message: 'Server returned an invalid JSON response.',
        raw: text
      };
    }
  }

  function apiErrorMessage(data, fallback) {
    if (data && typeof data === 'object' && data.message) return data.message;
    if (typeof data === 'string' && data.trim()) return data.trim().slice(0, 240);
    return fallback || 'Request failed';
  }

  async function api(path, options = {}) {
    const headers = options.headers ? { ...options.headers } : {};
    const isFormData = options.body instanceof FormData;
    if (!isFormData) headers['Content-Type'] = 'application/json';
    if (state.token) headers.Authorization = `Bearer ${state.token}`;

    const isMobileSyncRequest = /^\/api\/mobile\/|^\/api\/sync\//.test(path);
    if (isMobileSyncRequest && options.body) {
      const scans = Array.isArray(options.body.scans) ? options.body.scans : Array.isArray(options.body.records) ? options.body.records : [];
      console.log('[MOBILE SYNC] request sent', {
        path,
        deviceId: options.body.deviceId || '',
        scanCount: scans.length || 1,
        sample: scans.slice(0, 3).map((item) => ({
          scanId: item.scanId || item.uniqueScanId || item.mobileScanId || item.localId || '',
          partNumber: item.partNumber || item.partNo || item.part || '',
          dealerCode: item.dealerCode || '',
          syncKey: item.syncKey || ''
        }))
      });
    }

    const response = await fetch(path, {
      ...options,
      headers,
      body: isFormData ? options.body : options.body ? JSON.stringify(options.body) : undefined
    });
    const data = await parseApiResponse(response);
    if (data && data.invalidJson) {
      const error = new Error(data.message);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    if (!response.ok) {
      if (response.status === 401) logout();
      const error = new Error(apiErrorMessage(data, response.statusText));
      error.status = response.status;
      error.data = data;
      throw error;
    }
    if (isMobileSyncRequest) {
      console.log('[MOBILE SYNC] response received', {
        path,
        success: data && data.success,
        insertedCount: data && data.insertedCount,
        duplicateCount: data && data.duplicateCount,
        failedCount: data && data.failedCount,
        message: data && data.message
      });
      if (data && data.success === false) {
        const error = new Error(data.message || 'Mobile sync failed');
        error.status = response.status;
        error.data = data;
        throw error;
      }
    }
    return data;
  }

  async function downloadGet(path, fileName) {
    const response = await fetch(path, {
      headers: state.token ? { Authorization: `Bearer ${state.token}` } : {}
    });
    if (!response.ok) throw new Error(apiErrorMessage(await parseApiResponse(response), response.statusText));
    const blob = await response.blob();
    triggerDownload(blob, fileName);
  }

  async function downloadPost(path, body, fileName) {
    const response = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {})
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(apiErrorMessage(await parseApiResponse(response), response.statusText));
    const blob = await response.blob();
    triggerDownload(blob, fileName);
  }

  function triggerDownload(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function formObject(form) {
    const data = Object.fromEntries(new FormData(form).entries());
    if (data.dealerCode) data.dealerCode = cleanDealerCode(data.dealerCode);
    return data;
  }

  function cleanDealerCode(value) {
    const text = String(value || '').trim();
    if (text.toLowerCase() === 'all') return 'all';
    const match = text.match(/\(([^()]+)\)\s*$/);
    return (match ? match[1] : text).trim().toUpperCase();
  }

  function cleanDealerAccessInput(value) {
    return String(value || '')
      .split(/[,;\n]+/)
      .map(cleanDealerCode)
      .filter(Boolean)
      .join(', ');
  }

  function isTestDealer(dealer = {}) {
    return /^SYNC/i.test(dealer.dealerCode || '') || /sync test/i.test(dealer.dealerName || '');
  }

  function queryFromForm(form, omit = []) {
    const params = new URLSearchParams();
    Object.entries(formObject(form)).forEach(([key, value]) => {
      if (omit.includes(key)) return;
      if (String(value || '').trim()) params.set(key, String(value).trim());
    });
    return params.toString();
  }

  function setText(id, value) {
    const node = $(`#${id}`);
    if (node) node.textContent = value;
  }

  function setLivePill(id, text, ok) {
    const node = $(`#${id}`);
    if (!node) return;
    node.textContent = text;
    node.classList.remove('green-dot', 'red-dot', 'orange-dot', 'blue-dot');
    node.classList.add(ok ? 'green-dot' : 'red-dot');
  }

  function setStatusPill(id, text, status = 'green') {
    const node = $(`#${id}`);
    if (!node) return;
    node.textContent = text;
    node.classList.remove('green-dot', 'red-dot', 'orange-dot', 'blue-dot');
    node.classList.add(`${status}-dot`);
  }

  function setDbHealthPill(id, connected, statusText) {
    const normalized = String(statusText || '').trim().toLowerCase();
    const known = Boolean(normalized && normalized !== 'not checked');
    const ok = connected === true || normalized === 'connected' || normalized === 'online';
    const label = ok ? 'Connected' : known ? (statusText || 'Offline') : 'Not checked';
    setStatusPill(id, label, ok ? 'green' : known ? 'red' : 'orange');
  }

  function roleDisplayName(role) {
    return String(role || '').toLowerCase() === 'admin' ? 'Administrator' : (role ? String(role).replace(/^./, (char) => char.toUpperCase()) : 'User');
  }

  function userLoginName() {
    return state.user ? state.user.username || state.user.email || state.user.id || state.user.name || 'user' : 'user';
  }

  function setUserMenuOpen(open) {
    const menu = $('#userMenu');
    const button = $('#userMenuButton');
    const dropdown = $('#userDropdown');
    if (!menu || !button || !dropdown) return;
    menu.classList.toggle('open', Boolean(open));
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    dropdown.hidden = !open;
  }

  function deviceStatusText(count) {
    const value = Number(count || 0);
    return `Devices: ${value} ${value > 0 ? 'Online' : 'Connected'}`;
  }

  function setHeaderDeviceStatus(count) {
    const value = Number(count || 0);
    setLivePill('topDeviceStatus', deviceStatusText(value), value > 0);
  }

  function normalizeSyncDetail(detail) {
    const text = String(detail || 'Synced').trim();
    if (/fail|offline|error/i.test(text)) return 'Failed';
    if (/pending/i.test(text)) return 'Pending';
    if (/syncing|working/i.test(text)) return 'Syncing';
    return 'Synced';
  }

  function setHeaderSyncStatus(detail = 'Synced', ok = true) {
    const label = normalizeSyncDetail(detail);
    setLivePill('topSyncStatus', `Sync: Auto ON / ${label}`, ok);
  }

  function setDashboardSyncStatus(detail = 'Synced', ok = true) {
    const label = normalizeSyncDetail(detail);
    setLivePill('homeSyncBadge', `Sync: Auto ON / ${label}`, ok);
  }

  function updateScannerStatusBar(status = {}) {
    const counts = syncCounts();
    const connectedDevices = Number(status.connectedDevices ?? status.activeCount ?? state.activeDeviceCount ?? 0);
    const activeScanners = Number(status.activeScannerCount ?? connectedDevices);
    const offlineDevices = Number(status.offlineDevices ?? 0);
    const pendingSyncCount = Number(status.pendingSyncCount ?? counts.total ?? 0);
    const lastActivityAt = status.lastActivityAt || status.at || state.lastRealtimeAt;
    state.activeDeviceCount = connectedDevices;
    setStatusPill('topServerStatus', 'Server: Connected', 'green');
    setHeaderDeviceStatus(connectedDevices);
    setStatusPill('topScannerStatus', `Scanners: ${activeScanners} Active`, activeScanners ? 'green' : 'red');
    setStatusPill('topPendingStatus', `Pending: ${pendingSyncCount}`, pendingSyncCount ? 'orange' : 'green');
    setStatusPill('topOfflineStatus', `Offline: ${offlineDevices}`, offlineDevices ? 'orange' : 'green');
    setStatusPill('topRealtimeStatus', lastActivityAt ? 'Realtime: Live' : 'Realtime: Waiting', lastActivityAt ? 'blue' : 'red');
    setDashboardKpiValue('dashConnectedScanners', wholeNumber(activeScanners));
    setDashboardKpiValue('dashOfflineDevices', wholeNumber(offlineDevices));
    setDashboardKpiValue('dashRealtimeActivity', lastActivityAt ? compactDateTime(lastActivityAt) : 'Waiting', { time: true });
  }

  function kpiValueSize(text, options = {}) {
    if (options.time) return 16;
    const plain = String(text || '').trim();
    if (!plain || plain === '-' || plain === 'Never') return 20;
    const parts = plain.split(/\s+/).filter(Boolean);
    const longest = parts.reduce((max, part) => Math.max(max, part.length), 0);
    const total = plain.replace(/\s+/g, '').length;
    if (longest > 14 || total > 18) return 18;
    if (longest > 11 || total > 14) return 18;
    if (longest > 10 || total >= 12) return 18;
    if (longest > 9) return 20;
    if (longest > 7 || total > 10) return 22;
    return 24;
  }

  function setDashboardKpiValue(id, value, options = {}) {
    const node = $(`#${id}`);
    if (!node) return;
    const text = String(value === undefined || value === null || value === '' ? '-' : value);
    node.textContent = text;
    node.style.setProperty('--kpi-value-size', `${kpiValueSize(text, options)}px`);
    node.title = text.replace(/\n/g, ' ');
  }

  function hasConnectionStatus(status = {}) {
    return Boolean(
      status.server ||
      status.serverStatus ||
      status.db ||
      status.mongoStatus ||
      status.activeDatabase ||
      status.atlasStatus ||
      status.localDbStatus ||
      status.serverUrl ||
      status.ip
    );
  }

  function isLocalhostUrl(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text) return false;
    try {
      const url = new URL(text);
      return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    } catch (error) {
      return /localhost|127\.0\.0\.1|\[::1\]/.test(text);
    }
  }

  function currentDealerCode() {
    if (state.activeAudit && state.activeAudit.dealerCode) return cleanDealerCode(state.activeAudit.dealerCode);
    const selected = $$('.dealerSelect').map((select) => select.value).find(Boolean);
    return cleanDealerCode(selected || '');
  }

  function setDealerSelectValue(select, dealerCode, fallback = '') {
    if (!select) return;
    const value = cleanDealerCode(dealerCode || '');
    const fallbackValue = fallback === 'all' ? 'all' : cleanDealerCode(fallback || '');
    const options = Array.from(select.options || []);
    if (value && options.some((option) => cleanDealerCode(option.value) === value)) {
      select.value = options.find((option) => cleanDealerCode(option.value) === value).value;
    } else if (fallbackValue && options.some((option) => cleanDealerCode(option.value) === fallbackValue)) {
      select.value = options.find((option) => cleanDealerCode(option.value) === fallbackValue).value;
    } else if (options.some((option) => option.value === '')) {
      select.value = '';
    }
  }

  function selectedScanDealerCode() {
    const activeScanSelect = $('#scan .subview.active select[name="dealerCode"]');
    const historySelect = $('#scanHistoryDealer');
    const dealerCode = cleanDealerCode((activeScanSelect && activeScanSelect.value) || (historySelect && historySelect.value) || '');
    return dealerCode === 'ALL' ? '' : dealerCode;
  }

  function selectedDashboardDealerCode() {
    const select = $('#dashboardDealerSelect');
    const dealerCode = cleanDealerCode((select && select.value) || state.dashboardDealerCode || '');
    return dealerCode === 'ALL' ? '' : dealerCode;
  }

  function dashboardScopeDealerCode() {
    return selectedDashboardDealerCode() || (state.activeAudit && state.activeAudit.dealerCode ? cleanDealerCode(state.activeAudit.dealerCode) : '');
  }

  function applyActiveAuditToPayload(payload = {}) {
    if (!state.activeAudit || !state.activeAudit.dealerCode) return payload;
    return {
      ...payload,
      dealerCode: cleanDealerCode(state.activeAudit.dealerCode),
      dealerName: state.activeAudit.dealerName || '',
      auditId: state.activeAudit.auditId || '',
      syncKey: ''
    };
  }

  function appendActiveAuditQuery(params = new URLSearchParams()) {
    if (state.activeAudit && state.activeAudit.dealerCode) {
      params.set('dealerCode', cleanDealerCode(state.activeAudit.dealerCode));
      if (state.activeAudit.auditId) params.set('auditId', String(state.activeAudit.auditId).trim());
    }
    return params;
  }

  function appendDashboardScopeQuery(params = new URLSearchParams()) {
    const dealerCode = selectedDashboardDealerCode();
    if (dealerCode) params.set('dealerCode', dealerCode);
    else appendActiveAuditQuery(params);
    return params;
  }

  function dashboardQueryString() {
    const params = appendDashboardScopeQuery(new URLSearchParams());
    return params.toString();
  }

  function activeAuditMatchesScan(scan = {}) {
    const activeDealer = state.activeAudit && state.activeAudit.dealerCode ? cleanDealerCode(state.activeAudit.dealerCode) : '';
    const dashboardDealer = dashboardScopeDealerCode();
    if (!dashboardDealer) return true;
    const scanDealer = cleanDealerCode(scan.dealerCode || scan.dealer || '');
    if (scanDealer && scanDealer !== dashboardDealer) return false;
    const activeAuditId = String((state.activeAudit && state.activeAudit.auditId) || '').trim();
    const scanAuditId = String(scan.auditId || scan.audit || '').trim();
    if (activeDealer && dashboardDealer === activeDealer && activeAuditId && scanAuditId && scanAuditId !== activeAuditId) return false;
    return true;
  }

  function filterActiveAuditScans(scans = []) {
    return Array.isArray(scans) ? scans.filter(activeAuditMatchesScan) : [];
  }

  function dashboardStatsMatchesActiveAudit(stats = {}) {
    const activeDealer = state.activeAudit && state.activeAudit.dealerCode ? cleanDealerCode(state.activeAudit.dealerCode) : '';
    const dashboardDealer = dashboardScopeDealerCode();
    if (!dashboardDealer) return true;
    const dealerCode = cleanDealerCode(stats.dealerCode || stats.activeDealerCode || '');
    if (!dealerCode) return false;
    if (dealerCode !== dashboardDealer) return false;
    const activeAuditId = String((state.activeAudit && state.activeAudit.auditId) || '').trim();
    const auditId = String(stats.auditId || stats.activeAuditId || '').trim();
    return !(activeDealer && dashboardDealer === activeDealer && activeAuditId && auditId && auditId !== activeAuditId);
  }

  function dashboardPayloadMatchesActiveAudit(payload = {}) {
    const activeDealer = state.activeAudit && state.activeAudit.dealerCode ? cleanDealerCode(state.activeAudit.dealerCode) : '';
    const dashboardDealer = dashboardScopeDealerCode();
    if (!dashboardDealer) return true;
    const payloadDealer = cleanDealerCode(
      payload.dealerCode ||
      payload.activeDealerCode ||
      (payload.stats && payload.stats.dealerCode) ||
      (payload.activeAudit && payload.activeAudit.dealerCode) ||
      ''
    );
    if (payloadDealer) {
      if (payloadDealer !== dashboardDealer) return false;
      const activeAuditId = String((state.activeAudit && state.activeAudit.auditId) || '').trim();
      const payloadAuditId = String(payload.auditId || payload.activeAuditId || (payload.stats && payload.stats.auditId) || (payload.activeAudit && payload.activeAudit.auditId) || '').trim();
      return !(activeDealer && dashboardDealer === activeDealer && activeAuditId && payloadAuditId && payloadAuditId !== activeAuditId);
    }
    const scans = Array.isArray(payload.recent) ? payload.recent : (Array.isArray(payload.scans) ? payload.scans : []);
    return scans.some(activeAuditMatchesScan);
  }

  function updateActiveAuditUi() {
    const audit = state.activeAudit;
    if (audit && audit.dealerCode) {
      setLivePill('activeAuditBadge', `Active Audit: ${formatDealerDisplay(audit)}`, true);
      setLivePill('pairingConnectionStatus', 'Ready', true);
      setDashboardKpiValue('dashActiveAuditDealer', formatDealerDisplay(audit));
      setText('pairingActiveAudit', formatDealerDisplay(audit));
      setText('pairingStatusText', 'Mobile sync enabled');
      const createUserDealerAccess = $('#createUserForm [name="dealerAccess"]');
      if (createUserDealerAccess && !String(createUserDealerAccess.value || '').trim()) createUserDealerAccess.value = audit.dealerCode;
      $$('.dealerSelect').forEach((select) => {
        if (select.closest('#reportFilters')) return;
        const current = cleanDealerCode(select.value || '');
        if (!current || (current === 'ALL' && !select.closest('#reportFilters'))) {
          setDealerSelectValue(select, audit.dealerCode);
        }
      });
    } else {
      setLivePill('activeAuditBadge', 'No active audit', false);
      setLivePill('pairingConnectionStatus', 'No active audit', false);
      setDashboardKpiValue('dashActiveAuditDealer', '-');
      setText('pairingActiveAudit', 'No active audit');
      setText('pairingStatusText', 'Mobile sync disabled');
    }
  }

  async function loadActiveAudit(options = {}) {
    try {
      const data = await api('/api/audit/active');
      if (!data.success) throw new Error(data.message || 'No active audit found. Please start audit from PC Admin.');
      state.activeAudit = data;
      updateActiveAuditUi();
      return data;
    } catch (error) {
      state.activeAudit = null;
      updateActiveAuditUi();
      if (!options.silent) toast(error.message, 'error');
      throw error;
    }
  }

  function applyServerInfo(info = {}) {
    const serverUrl = info.serverUrl || (info.ip && info.port ? `http://${info.ip}:${info.port}` : '');
    state.serverInfo = {
      ...state.serverInfo,
      ...info,
      serverUrl
    };
    setText('pairingServerIp', state.serverInfo.ip || 'Unavailable');
    setText('pairingServerPort', state.serverInfo.port || '3001');
    setText('pairingServerUrl', serverUrl || 'Unavailable');
    setText('pairingHealthUrl', state.serverInfo.healthUrl || (serverUrl ? `${serverUrl}/api/health` : 'Unavailable'));
    setText('syncServerIp', state.serverInfo.ip || 'Unavailable');
    setText('syncServerPort', state.serverInfo.port || '3001');
    setText('syncServerUrlText', serverUrl || 'Unavailable');
  }

  async function loadHealth() {
    const data = await api('/api/health');
    applyServerInfo(data);
    const serverOk = data.server === 'online';
    const dbOk = data.db === 'connected';
    setLivePill('syncServerStatus', serverOk ? 'Connected' : 'Offline', serverOk);
    setLivePill('syncMongoStatus', dbOk ? 'Connected' : 'Offline', dbOk);
    setDashboardSyncStatus(serverOk && dbOk ? 'Synced' : 'Failed', serverOk && dbOk);
    if (!serverOk || !dbOk) throw new Error('Server or MongoDB is not connected');
    if (isLocalhostUrl(data.serverUrl)) {
      throw new Error('Do not use localhost on mobile. Use the cloud server URL from pairing QR.');
    }
    return data;
  }

  function readJsonStorage(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
    } catch (error) {
      return fallback;
    }
  }

  function writeJsonStorage(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function getSyncQueue() {
    return readJsonStorage(SYNC_QUEUE_KEY, []);
  }

  function saveSyncQueue(queue) {
    writeJsonStorage(SYNC_QUEUE_KEY, queue);
    renderSyncQueue();
  }

  function getSyncLog() {
    return readJsonStorage(SYNC_LOG_KEY, []);
  }

  function addSyncLog(entry) {
    const logs = getSyncLog();
    logs.unshift({
      time: new Date().toISOString(),
      partNumber: entry.partNumber || '',
      upiId: entry.upiId || '',
      dealer: entry.dealer || entry.dealerCode || '',
      status: entry.status || '',
      errorMessage: entry.errorMessage || ''
    });
    writeJsonStorage(SYNC_LOG_KEY, logs.slice(0, 200));
    renderSyncLog();
  }

  function getConnectionLog() {
    return readJsonStorage(CONNECTION_LOG_KEY, []);
  }

  function addConnectionLog(message, type = 'success') {
    const logs = getConnectionLog();
    logs.unshift({ time: new Date().toISOString(), message, type });
    writeJsonStorage(CONNECTION_LOG_KEY, logs.slice(0, 80));
    renderConnectionLog();
  }

  function renderConnectionLog() {
    const body = $('#connectionLogRows');
    if (!body) return;
    body.innerHTML = getConnectionLog().map((log) => `
      <div class="connection-log-item ${escapeHtml(log.type || 'success')}">
        <span>${escapeHtml(dateTime(log.time))}</span>
        <strong>${escapeHtml(log.message)}</strong>
      </div>
    `).join('') || '<div class="muted">No connection logs yet.</div>';
  }

  async function clearConnectionLogs() {
    localStorage.removeItem(CONNECTION_LOG_KEY);
    writeJsonStorage(CONNECTION_LOG_KEY, []);
    renderConnectionLog();
    const scannerRows = $('#scannerLogRows');
    if (scannerRows) scannerRows.innerHTML = '<div class="muted">No scanner logs yet.</div>';
    const data = await api('/api/scanner-network/logs/clear', { method: 'POST', body: {} });
    toast(`Connection logs cleared${data.deletedCount ? ` (${data.deletedCount} scanner log rows)` : ''}`);
    await loadScannerLogs().catch(() => null);
  }

  function extractUpiIdFromText(payload) {
    const direct = payload.upiId || payload.upiID || payload.upiScanId || payload.transactionId || payload.txnId;
    if (direct) return String(direct).trim();
    const raw = String(payload.rawScan || payload.rawScanString || '');
    const match = raw.match(/(?:upi|upid|upiid|txn|txnid|transaction|scanid)\s*[:=#-]?\s*([a-z0-9._/-]+)/i);
    return match ? match[1].trim() : '';
  }

  function buildClientSyncKey(payload) {
    const timestamp = payload.timestamp || new Date().toISOString();
    return [
      payload.dealerCode || 'NO-DEALER',
      payload.upiId || 'NO-UPI',
      payload.partNumber || payload.part || 'NO-PART',
      payload.scanType || payload.type || 'INWARD',
      timestamp
    ].map((value) => String(value).trim().toUpperCase().replace(/\s+/g, '_')).join('|');
  }

  function normalizePartText(value) {
    return String(value || '').trim().toUpperCase();
  }

  function validPartText(value) {
    return /^[A-Z0-9][A-Z0-9._/-]{2,39}$/.test(normalizePartText(value));
  }

  function parseRawScanText(rawScan) {
    const raw = String(rawScan || '').trim();
    const parts = raw.split('/');
    if (parts.length >= 6 && parts[3] && parts[4] && parts[5]) {
      const slashQty = optionalScanNumber(parts[4]);
      return {
        partNumber: normalizePartText(parts[3]),
        qty: slashQty !== undefined ? slashQty : 1,
        qtyProvided: slashQty !== undefined,
        mrp: undefined,
        mrpProvided: false,
        rawScan: raw
      };
    }
    const kvMatch = raw.match(/(?:part\s*no|part|pn|sku)\s*[:=#-]?\s*([a-z0-9._/-]+)/i);
    const qtyMatch = raw.match(/(?:qty|quantity|q)\s*[:=]\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
    const explicitQty = qtyMatch ? optionalScanNumber(qtyMatch[1]) : undefined;
    const mrpMatch = raw.match(/(?:mrp|price)\s*[:=]\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
    const explicitMrp = mrpMatch ? Number(String(mrpMatch[1]).replace(/,/g, '')) : undefined;
    if (kvMatch) {
      const partNumber = normalizePartText(kvMatch[1]);
      return {
        partNumber: validPartText(partNumber) ? partNumber : '',
        qty: explicitQty,
        qtyProvided: explicitQty !== undefined,
        mrp: Number.isFinite(explicitMrp) ? explicitMrp : undefined,
        mrpProvided: Number.isFinite(explicitMrp),
        rawScan: raw
      };
    }
    const simple = normalizePartText(raw);
    return {
      partNumber: validPartText(simple) ? simple : '',
      qty: undefined,
      qtyProvided: false,
      mrp: Number.isFinite(explicitMrp) ? explicitMrp : undefined,
      mrpProvided: Number.isFinite(explicitMrp),
      rawScan: raw
    };
  }

  function optionalScanNumber(value) {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = Number(String(value).replace(/,/g, '').trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  function normalizeScanPayload(payload) {
    if (payload.serverUrl && isLocalhostUrl(payload.serverUrl)) {
      throw new Error('Do not use localhost on mobile. Use the cloud server URL from pairing QR.');
    }
    payload = applyActiveAuditToPayload(payload);
    const rawScanValue = payload.rawScanString || payload.rawScan || payload.rawBarcode || payload.rawScanValue || payload.barcode || payload.barcodeValue || payload.scanValue || payload.scanText || '';
    const parsedRaw = parseRawScanText(rawScanValue);
    const timestamp = new Date().toISOString();
    const partNumber = normalizePartText(parsedRaw.partNumber || payload.partNumber || payload.partNo || payload.part || payload.sku || payload.itemCode || '');
    const scanType = String(payload.scanType || payload.action || payload.type || payload.movement || 'INWARD').trim().toUpperCase();
    const dealerCode = String(payload.dealerCode || payload.dealer || '').trim().toUpperCase();
    const upiId = extractUpiIdFromText(payload);
    const payloadMrp = optionalScanNumber(payload.mrp);
    const parsedMrp = optionalScanNumber(parsedRaw.mrp);
    const mrpProvided = parsedRaw.mrpProvided === true || payload.mrpProvided === true || payload.mrpProvided === 'true';
    const payloadDlc = optionalScanNumber(payload.dlc);
    const dlcProvided = payload.dlcProvided === true || payload.dlcProvided === 'true';
    const payloadQty = optionalScanNumber(payload.qty);
    const payloadQuantity = optionalScanNumber(payload.quantity);
    const parsedQty = parsedRaw.qtyProvided ? optionalScanNumber(parsedRaw.qty) : undefined;
    const finalQty = parsedQty !== undefined
      ? parsedQty
      : payloadQty !== undefined
        ? payloadQty
        : payloadQuantity !== undefined
          ? payloadQuantity
          : 1;
    const normalized = {
      ...payload,
      timestamp,
      partNumber,
      part: partNumber,
      scanType,
      type: scanType,
      dealerCode,
      dealerName: payload.dealerName || '',
      auditId: payload.auditId || '',
      upiId,
      quantity: finalQty,
      qty: finalQty,
      binLocation: payload.binLocation || payload.bin || '',
      bin: payload.bin || payload.binLocation || '',
      rawScanString: rawScanValue || partNumber,
      rawScan: rawScanValue || partNumber,
      rawBarcode: payload.rawBarcode || rawScanValue || partNumber,
      rawScanValue: payload.rawScanValue || rawScanValue || partNumber,
      staffName: payload.staffName || (state.user ? state.user.name || state.user.username : ''),
      userId: payload.userId || payload.loginId || (state.user ? state.user.id || state.user.username || '' : ''),
      loginId: payload.loginId || payload.userId || (state.user ? state.user.username || state.user.email || state.user.id || '' : ''),
      deviceId: payload.deviceId || ensureDeviceId()
    };
    if (mrpProvided && (parsedMrp !== undefined || payloadMrp !== undefined)) {
      normalized.mrp = parsedMrp !== undefined ? parsedMrp : payloadMrp;
      normalized.mrpProvided = true;
    } else {
      normalized.mrpProvided = false;
    }
    if (dlcProvided && payloadDlc !== undefined) {
      normalized.dlc = payloadDlc;
      normalized.dlcProvided = true;
    } else {
      normalized.dlcProvided = false;
    }
    normalized.syncKey = payload.syncKey || buildClientSyncKey(normalized);
    normalized.uniqueScanId = payload.uniqueScanId || normalized.syncKey;
    return normalized;
  }

  function enqueueScan(payload, errorMessage = 'Pending local sync') {
    const normalized = normalizeScanPayload(payload);
    const queue = getSyncQueue();
    const exists = queue.some((item) => item.syncKey === normalized.syncKey || (normalized.upiId && item.upiId === normalized.upiId && item.dealerCode === normalized.dealerCode));
    if (!exists) {
      queue.push({
        ...normalized,
        localId: normalized.localId || `LOCAL-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        localStatus: 'pending',
        retryCount: 0,
        syncError: errorMessage
      });
      saveSyncQueue(queue);
    }
    addSyncLog({
      partNumber: normalized.partNumber,
      upiId: normalized.upiId,
      dealer: normalized.dealerCode,
      status: 'queued',
      errorMessage
    });
    return normalized;
  }

  function syncCounts() {
    const queue = getSyncQueue();
    return {
      pending: queue.filter((item) => item.localStatus !== 'failed').length,
      failed: queue.filter((item) => item.localStatus === 'failed').length,
      total: queue.length
    };
  }

  function setAutoSyncState() {
    localStorage.setItem(AUTO_SYNC_KEY, 'true');
    ['autoSyncToggle', 'homeAutoSyncToggle', 'syncCenterAutoToggle'].forEach((id) => {
      const node = $(`#${id}`);
      if (node) {
        node.checked = true;
        node.disabled = true;
      }
    });
    setLivePill('syncCenterAutoState', 'Auto ON', true);
    setHeaderSyncStatus('Synced', true);
    if (state.autoSyncTimer) {
      clearInterval(state.autoSyncTimer);
      state.autoSyncTimer = null;
    }
    state.autoSyncTimer = setInterval(() => syncPendingQueue({ silent: true, includeFailed: true }), 10000);
  }

  function updateSyncBadges(status = {}) {
    if (hasConnectionStatus(status)) {
      state.lastSyncStatus = { ...state.lastSyncStatus, ...status };
    }
    const connectionStatus = hasConnectionStatus(status) ? state.lastSyncStatus : state.lastSyncStatus;
    if (connectionStatus.serverUrl || connectionStatus.ip) applyServerInfo(connectionStatus);
    const counts = syncCounts();
    const serverReportedNoSync = hasConnectionStatus(status) && (status.hasSyncData === false || connectionStatus.hasSyncData === false);
    const reportedLastSync = status.completedAt || status.lastSync || status.lastSyncTime || status.lastSuccessfulSyncAt || connectionStatus.lastSync || connectionStatus.lastSyncTime || connectionStatus.lastSuccessfulSyncAt;
    const lastSync = rememberLastSyncTime(reportedLastSync) || (serverReportedNoSync ? '' : normalizeLastSyncValue(storageGet(LAST_SYNC_KEY)));
    storageSet(AUTO_SYNC_KEY, 'true');
    const serverStatusText = String(connectionStatus.server || connectionStatus.serverStatus || '').toLowerCase();
    const mongoStatusText = String(connectionStatus.db || connectionStatus.mongoStatus || '').toLowerCase();
    const serverKnown = Boolean(serverStatusText);
    const mongoKnown = Boolean(mongoStatusText);
    const serverOnline = serverKnown ? serverStatusText === 'online' : null;
    const mongoOnline = mongoKnown ? mongoStatusText === 'connected' || mongoStatusText === 'online' : null;
    const connectedDevices = Number(status.connectedDevices ?? connectionStatus.connectedDevices ?? state.activeDeviceCount ?? 0);
    const totalSynced = Number(status.totalSynced ?? connectionStatus.totalSynced ?? $('#syncTotal')?.textContent ?? 0);
    state.activeDeviceCount = connectedDevices;

    const connectionOk = (!serverKnown || serverOnline) && (!mongoKnown || mongoOnline);
    const syncDetail = connectionOk ? (counts.total ? 'Pending' : 'Synced') : 'Failed';
    const syncOk = connectionOk && !counts.total;
    if (serverKnown) setStatusPill('topServerStatus', serverOnline ? 'Server: Connected' : 'Server: Offline', serverOnline ? 'green' : 'red');
    if (serverKnown && mongoKnown) setDashboardSyncStatus(syncDetail, syncOk);
    setHeaderDeviceStatus(connectedDevices);
    setHeaderSyncStatus(syncDetail, syncOk);
    setStatusPill('topPendingStatus', `Pending: ${counts.total}`, counts.total ? 'orange' : 'green');
    if (serverKnown) setLivePill('syncServerStatus', serverOnline ? 'Connected' : 'Offline', serverOnline);
    if (mongoKnown) setLivePill('syncMongoStatus', mongoOnline ? 'Connected' : 'Offline', mongoOnline);
    setLivePill('syncCenterAutoState', 'Auto ON', true);
    setText('syncActiveDatabase', connectionStatus.activeDatabase || 'Unknown');
    setDbHealthPill('syncAtlasStatus', connectionStatus.atlasConnected, connectionStatus.atlasStatus);
    setDbHealthPill('syncLocalDbStatus', connectionStatus.localDbConnected, connectionStatus.localDbStatus);
    setText('syncCurrentLanIp', connectionStatus.currentLanIp || connectionStatus.lanIp || connectionStatus.ip || '-');
    const cloudStatus = String(connectionStatus.cloudSyncStatus || '').trim() || 'idle';
    const cloudOk = /atlas active|synced/i.test(cloudStatus) || (connectionStatus.atlasConnected === true && Number(connectionStatus.cloudSyncPendingRecords || 0) === 0);
    setStatusPill('syncCloudStatus', cloudStatus.replace(/^./, (char) => char.toUpperCase()), cloudOk ? 'green' : /queued|syncing|checking|partial/i.test(cloudStatus) ? 'orange' : 'red');
    setText('syncCloudPending', Number(connectionStatus.cloudSyncPendingRecords || 0));

    setText('homeLastSync', lastSync ? dashboardScanTime(lastSync) : 'Never');
    setText('homePendingSync', counts.total);
    setText('homeConnectedDevices', connectedDevices);
    setText('homeFailedSync', counts.failed);
    setText('syncCenterLastSync', lastSync ? dateTime(lastSync) : 'Never');
    setText('syncCenterTotalSynced', totalSynced);
    setText('syncCenterPending', counts.total);
    setText('syncCenterFailed', counts.failed);
    setText('syncCenterDevices', connectedDevices);
    setText('syncPending', counts.total);
    setText('syncFailed', counts.failed);
    setText('syncLast', lastSync ? dateTime(lastSync) : 'Never');
  }

  async function loadSyncStatus() {
    let healthData = null;
    try {
      healthData = await loadHealth();
      const data = await api('/api/sync/status');
      setText('syncTotal', data.insertedCount ?? data.syncedCount ?? data.totalSynced ?? 0);
      updateSyncBadges(data);
      return data;
    } catch (error) {
      if (healthData) {
        updateSyncBadges(healthData);
        return healthData;
      }
      try {
        const data = await loadHealth();
        updateSyncBadges(data);
        return data;
      } catch (healthError) {
        updateSyncBadges({ serverStatus: 'offline', mongoStatus: 'offline', db: 'disconnected' });
      }
      return null;
    }
  }

  function renderSyncQueue() {
    const queue = getSyncQueue();
    const body = $('#pendingSyncRows');
    if (body) {
      body.innerHTML = queue.map((item) => `
        <tr>
          <td>${escapeHtml(dateTime(item.timestamp))}</td>
          <td>${partLink(item.partNumber || item.part)}</td>
          <td>${escapeHtml(item.upiId)}</td>
          <td>${escapeHtml(item.dealerCode)}</td>
          <td>${escapeHtml(item.scanType || item.type)}</td>
          <td class="raw-cell" title="${escapeHtml(item.syncKey)}">${escapeHtml(item.syncKey)}</td>
          <td>${escapeHtml(item.localStatus || 'pending')}</td>
        </tr>
      `).join('');
    }
    updateSyncBadges();
  }

  function renderSyncLog() {
    const body = $('#syncLogRows');
    if (!body) return;
    body.innerHTML = getSyncLog().map((log) => `
      <tr>
        <td>${escapeHtml(dateTime(log.time))}</td>
        <td>${partLink(log.partNumber)}</td>
        <td>${escapeHtml(log.upiId)}</td>
        <td>${escapeHtml(log.dealer)}</td>
        <td>${escapeHtml(log.status)}</td>
        <td>${escapeHtml(log.errorMessage)}</td>
      </tr>
    `).join('');
  }

  function renderSyncApiResponse(data) {
    if (!data) return;
    state.lastSyncResponse = data;
    setText('syncDebugInserted', data.insertedCount ?? data.syncedCount ?? 0);
    setText('syncDebugDuplicates', data.duplicateCount ?? data.duplicates ?? 0);
    setText('syncDebugFailed', data.failedCount ?? data.failed ?? 0);
    setText('syncDebugVerified', data.verifiedInsertedCount ?? data.insertedRecords?.length ?? 0);
    const viewer = $('#syncApiResponseViewer');
    if (viewer) viewer.textContent = JSON.stringify(data, null, 2);
  }

  async function refreshAfterSync(payload = {}) {
    renderSyncApiResponse(payload);
    localStorage.removeItem('dakshReportPreviewCache');
    state.reportCache.clear();
    const jobs = [loadDashboard(), loadScanHistory(), loadSyncStatus(), loadDevices()];
    await Promise.all(jobs);
  }

  function queueRealtimeReportRefresh(reason = 'realtime scan') {
    if (!state.reportHasRun || !activeReportType()) return;
    state.reportCache.clear();
    const now = Date.now();
    if (now - Number(state.reportStaleNoticeAt || 0) > 15000) {
      state.reportStaleNoticeAt = now;
      addConnectionLog(`Report data changed from ${reason}. Use Refresh Report to reload table.`, 'warning');
    }
  }

  async function loadLatestSyncDebug() {
    const data = await api('/api/sync/debug/latest');
    renderSyncApiResponse(data);
    return data;
  }

  function statusCell(item) {
    const syncStatus = normalizedDisplaySyncStatus(item);
    if (syncStatus) return syncStatusBadge(syncStatus);
    const warnings = (item.warnings || []).map((warning) => /unknown part saved from sync|part does not exist/i.test(warning) ? 'Not Found in Master' : warning);
    if (warnings.length) return `<span class="status-warn">${escapeHtml(Array.from(new Set(warnings)).join(', '))}</span>`;
    if (item.isMasterMatched === false) return '<span class="status-warn">Not Found in Master</span>';
    return `<span class="status-ok">${item.synced ? 'Synced' : 'OK'}</span>`;
  }

  function normalizedDisplaySyncStatus(item = {}) {
    const explicit = String(item.syncStatus || '').trim().toLowerCase();
    if (['synced', 'pending', 'failed', 'rejected', 'duplicate'].includes(explicit)) return explicit;
    if (item.synced === true || item.isSynced === true || String(item.deviceId || '').toUpperCase().startsWith('WEB-')) return 'synced';
    return explicit || '';
  }

  function syncStatusBadge(status) {
    const normalized = String(status || '').trim().toLowerCase();
    const label = normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : '';
    return `<span class="sync-status-badge ${escapeHtml(normalized)}">${escapeHtml(label)}</span>`;
  }

  function tablePrefs(storageKey) {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || '{}');
    } catch (error) {
      return {};
    }
  }

  function saveTablePrefs(storageKey, prefs) {
    localStorage.setItem(storageKey, JSON.stringify({ ...tablePrefs(storageKey), ...prefs }));
  }

  function tableColumnKey(th, index) {
    if (th.querySelector('input[type="checkbox"]')) return 'select';
    const text = String(th.textContent || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return th.dataset.colKey || text || `col-${index}`;
  }

  function tableDefaultColumnWidth(table, key) {
    const dashboardStreamWidths = {
      time: 160,
      'part-number': 150,
      qty: 70,
      mrp: 100,
      'scan-type': 110,
      'bin-location': 120,
      'dealer-code': 110,
      'device-id': 220,
      'sync-status': 120
    };
    const productSummaryWidths = {
      'product-group': 220,
      'product-sub-group': 230,
      'total-scans': 110,
      'total-quantity': 120,
      'unique-parts': 110,
      'total-mrp-value': 150,
      'total-dlc-value': 150
    };
    const scanHistoryWidths = {
      select: 44,
      time: 160,
      'part-number': 150,
      'part-description': 240,
      'product-category': 170,
      mrp: 100,
      dlc: 100,
      'product-group': 150,
      model: 120,
      year: 90,
      qty: 70,
      type: 110,
      bin: 110,
      dealer: 190,
      device: 220,
      status: 120,
      action: 150
    };
    if (table.classList.contains('dashboard-stream-table')) return dashboardStreamWidths[key] || 130;
    if (table.classList.contains('product-group-summary-table')) return productSummaryWidths[key] || 130;
    if (table.classList.contains('scan-history-table')) return scanHistoryWidths[key] || 130;
    if (key === 'select') return 44;
    return 130;
  }

  function tableColumnMinWidth(key) {
    return key === 'select' ? 44 : 70;
  }

  function applyTableColumnOrder(table, order) {
    const headRow = table.tHead && table.tHead.rows[0];
    if (!headRow || !order || !order.length) return;
    const orderSignature = order.join('|');
    const headers = Array.from(headRow.children);
    const byKey = new Map(headers.map((th) => [th.dataset.colKey, th]));
    const orderedHeaders = order.map((key) => byKey.get(key)).filter(Boolean).concat(headers.filter((th) => !order.includes(th.dataset.colKey)));
    orderedHeaders.forEach((th) => headRow.appendChild(th));
    const currentIndexes = headers.map((th) => Number(th.dataset.originalIndex));
    const orderedIndexes = orderedHeaders.map((th) => Number(th.dataset.originalIndex));
    Array.from(table.tBodies || []).forEach((tbody) => {
      Array.from(tbody.rows || []).forEach((row) => {
        if (row.dataset.columnOrder === orderSignature) return;
        const cells = Array.from(row.children);
        if (cells.length !== headers.length) return;
        const sourceIndexes = row.dataset.columnOrder ? currentIndexes : headers.map((_, index) => index);
        orderedIndexes.map((index) => cells[sourceIndexes.indexOf(index)]).filter(Boolean).forEach((cell) => row.appendChild(cell));
        row.dataset.columnOrder = orderSignature;
      });
    });
  }

  function resetEnhancedTableLayout(table, storageKey) {
    if (!table || !table.tHead || !table.tHead.rows.length) return;
    localStorage.removeItem(storageKey);
    const headRow = table.tHead.rows[0];
    const headers = Array.from(headRow.children);
    const orderedHeaders = headers.slice().sort((a, b) => Number(a.dataset.originalIndex || 0) - Number(b.dataset.originalIndex || 0));
    const currentHeaders = headers.slice();
    Array.from(table.tBodies || []).forEach((tbody) => {
      Array.from(tbody.rows || []).forEach((row) => {
        const cells = Array.from(row.children);
        if (cells.length !== currentHeaders.length) return;
        orderedHeaders
          .map((th) => cells[currentHeaders.indexOf(th)])
          .filter(Boolean)
          .forEach((cell) => row.appendChild(cell));
        delete row.dataset.columnOrder;
      });
    });
    orderedHeaders.forEach((th) => {
      th.style.width = '';
      headRow.appendChild(th);
    });
    const colgroup = table.querySelector('colgroup');
    if (colgroup) colgroup.remove();
    enhanceDataTable(table, storageKey);
  }

  function enhanceDataTable(table, storageKey) {
    if (!table || !table.tHead || !table.tHead.rows.length) return;
    const prefs = tablePrefs(storageKey);
    table.classList.add('resizable-data-table');
    table.style.tableLayout = 'fixed';
    table.style.borderCollapse = 'collapse';
    const wrap = table.closest('.table-wrap');
    if (wrap) wrap.classList.add('resizable-table-wrap');
    const headRow = table.tHead.rows[0];
    Array.from(headRow.children).forEach((th, index) => {
      if (!th.dataset.originalIndex) th.dataset.originalIndex = String(index);
      th.dataset.colKey = tableColumnKey(th, index);
    });
    applyTableColumnOrder(table, prefs.columnOrder || []);
    const headers = Array.from(headRow.children);
    let colgroup = table.querySelector('colgroup');
    if (!colgroup) {
      colgroup = document.createElement('colgroup');
      table.insertBefore(colgroup, table.firstChild);
    }
    const widths = headers.map((th) => {
      const key = th.dataset.colKey;
      if (key === 'select') return 44;
      return Math.max(tableColumnMinWidth(key), Number((prefs.columnWidths || {})[key]) || tableDefaultColumnWidth(table, key));
    });
    colgroup.innerHTML = headers.map((th, index) => {
      const key = th.dataset.colKey;
      const minWidth = tableColumnMinWidth(key);
      return `<col data-col-key="${escapeHtml(key)}" style="width:${Math.round(widths[index])}px;min-width:${minWidth}px">`;
    }).join('');
    headers.forEach((th, index) => {
      th.draggable = true;
      th.style.width = `${Math.round(widths[index])}px`;
      th.style.minWidth = `${tableColumnMinWidth(th.dataset.colKey)}px`;
      if (!th.querySelector('.column-resizer')) {
        th.insertAdjacentHTML('beforeend', '<span class="column-resizer" role="separator" aria-label="Resize column"></span>');
      }
    });
    table.style.minWidth = `${widths.reduce((sum, width) => sum + width, 0)}px`;
    table.style.width = '100%';
    if (table.dataset.enhancedTable === 'true') return;
    table.dataset.enhancedTable = 'true';
    table.tHead.addEventListener('pointerdown', (event) => {
      const grip = event.target.closest('.column-resizer');
      if (!grip) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      const th = grip.closest('th');
      const key = th.dataset.colKey;
      if (key === 'select') return;
      const col = table.querySelector(`col[data-col-key="${CSS.escape(key)}"]`);
      const startX = event.clientX;
      const startWidth = th.getBoundingClientRect().width;
      const onMove = (moveEvent) => {
        const width = Math.max(tableColumnMinWidth(key), startWidth + moveEvent.clientX - startX);
        th.style.width = `${Math.round(width)}px`;
        if (col) col.style.width = `${Math.round(width)}px`;
        const total = Array.from(table.querySelectorAll('col')).reduce((sum, item) => sum + (Number.parseFloat(item.style.width) || 120), 0);
        table.style.minWidth = `${Math.round(total)}px`;
      };
      const onUp = (upEvent) => {
        const width = Math.max(tableColumnMinWidth(key), startWidth + upEvent.clientX - startX);
        const columnWidths = { ...(tablePrefs(storageKey).columnWidths || {}) };
        columnWidths[key] = Math.round(width);
        saveTablePrefs(storageKey, { columnWidths });
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
    table.tHead.addEventListener('dragstart', (event) => {
      if (event.target.closest('.column-resizer')) {
        event.preventDefault();
        return;
      }
      const th = event.target.closest('th[data-col-key]');
      if (!th) return;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', th.dataset.colKey);
      th.classList.add('dragging');
    });
    table.tHead.addEventListener('dragover', (event) => {
      if (event.target.closest('th[data-col-key]')) event.preventDefault();
    });
    table.tHead.addEventListener('drop', (event) => {
      const target = event.target.closest('th[data-col-key]');
      const sourceKey = event.dataTransfer.getData('text/plain');
      if (!target || !sourceKey || sourceKey === target.dataset.colKey) return;
      event.preventDefault();
      const current = Array.from(headRow.children).map((th) => th.dataset.colKey);
      const next = current.filter((key) => key !== sourceKey);
      next.splice(next.indexOf(target.dataset.colKey), 0, sourceKey);
      saveTablePrefs(storageKey, { columnOrder: next });
      applyTableColumnOrder(table, next);
      enhanceDataTable(table, storageKey);
    });
    table.tHead.addEventListener('dragend', () => {
      Array.from(table.querySelectorAll('th.dragging')).forEach((th) => th.classList.remove('dragging'));
    });
  }

  function enhanceCoreTables() {
    enhanceDataTable($('#streamRows')?.closest('table'), 'daksh_table_realtime_stream');
    enhanceDataTable($('#productGroupSummaryRows')?.closest('table'), 'daksh_table_product_group_summary');
    enhanceDataTable($('#scanHistoryRows')?.closest('table'), 'daksh_table_scan_history');
  }

  function setUserChrome() {
    if (!state.token) {
      bootWarn('setUserChrome missing token; redirecting to login', {
        path: window.location.pathname
      });
      window.location.href = '/';
      return false;
    }
    bootLog('setUserChrome start', {
      userPresent: Boolean(state.user),
      role: state.user && state.user.role,
      login: userLoginName()
    });
    const roleName = roleDisplayName(state.user && state.user.role);
    const loginName = userLoginName();
    setText('userBadge', `${roleName} - ${loginName}`);
    setText('userDropdownLogin', loginName);
    setText('userDropdownRole', roleName);
    $$('.admin-only').forEach((node) => node.classList.toggle('hidden', !state.user || state.user.role !== 'admin'));
    $('#systemSubline').textContent = `${window.location.origin}/dashboard`;
    $('#manualStaff').value = state.user ? state.user.name || state.user.username || '' : '';
    $('#barcodeDeviceId').value = ensureDeviceId();
    $('#allowUnknownToggle').checked = storageGet('dakshAllowUnknown') === 'true';
    bootLog('setUserChrome complete', {
      userBadgePresent: Boolean($('#userBadge')),
      adminOnlyCount: $$('.admin-only').length
    });
    return true;
  }

  async function validateSession() {
    if (!state.token) {
      bootWarn('validateSession missing token; redirecting to login', {
        path: window.location.pathname
      });
      window.location.href = '/';
      return false;
    }
    try {
      bootLog('validateSession request start', {
        endpoint: '/api/auth/me',
        tokenPresent: true
      });
      const data = await api('/api/auth/me');
      state.user = data.user || state.user;
      storageSet('dakshUser', JSON.stringify(state.user));
      bootLog('validateSession success', {
        userPresent: Boolean(state.user),
        role: state.user && state.user.role,
        username: state.user && (state.user.username || state.user.email || state.user.name)
      });
      return true;
    } catch (error) {
      bootError('validateSession failed; clearing session and redirecting to login', errorDetails(error));
      clearSession();
      window.location.href = '/';
      return false;
    }
  }

  async function loadDealers() {
    const data = await api('/api/master/dealers');
    state.dealers = data.dealers || [];
    const realDealers = state.dealers.filter((dealer) => !isTestDealer(dealer));
    const options = '<option value="">All Dealers</option>' + realDealers.map((dealer) => (
      `<option value="${escapeHtml(dealer.dealerCode)}">${escapeHtml(formatDealerDisplay(dealer))}</option>`
    )).join('');
    $$('.dealerSelect').forEach((select) => {
      const selected = cleanDealerCode(select.value);
      const firstOption = select.closest('#reportFilters') ? '<option value="">Select Dealer</option>' : (select.id === 'dashboardDealerSelect' ? '<option value="">Active Audit</option>' : (select.classList.contains('bin-transfer-dealer') || select.id === 'binManagementDealer' || select.closest('#binSequenceTab') || select.closest('#reconciliation')) ? '<option value="">Select Dealer</option>' : '<option value="">All Dealers</option>');
      select.innerHTML = firstOption + realDealers.map((dealer) => (
        `<option value="${escapeHtml(dealer.dealerCode)}">${escapeHtml(formatDealerDisplay(dealer))}</option>`
      )).join('');
      const activeDealer = state.activeAudit && state.activeAudit.dealerCode ? cleanDealerCode(state.activeAudit.dealerCode) : '';
      const preferred = selected ||
        (select.id === 'dashboardDealerSelect' ? cleanDealerCode(state.dashboardDealerCode || activeDealer) : '') ||
        (select.id === 'scanHistoryDealer' ? selectedScanDealerCode() || activeDealer : '') ||
        (select.classList.contains('bin-transfer-dealer') ? activeDealer : '');
      select.value = Array.from(select.options).some((option) => option.value === preferred) ? preferred : select.options[0].value;
      syncDealerSelectDisplay(select);
    });
    updateActiveAuditUi();
    const cleanupOptions = '<option value="">Select Dealer</option>' + state.dealers.map((dealer) => (
      `<option value="${escapeHtml(dealer.dealerCode)}">${escapeHtml(formatDealerDisplay(dealer))}</option>`
    )).join('');
    $$('.cleanupDealerSelect').forEach((select) => {
      const selected = select.value;
      select.innerHTML = cleanupOptions;
      select.value = selected;
      syncDealerSelectDisplay(select);
    });
    renderDealerMaster();
  }

  function fillSelectOptions(select, values, emptyLabel) {
    if (!select) return;
    const selected = select.value;
    const cleanValues = Array.from(new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    select.innerHTML = `<option value="">${escapeHtml(emptyLabel)}</option>` + cleanValues.map((value) => (
      `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`
    )).join('');
    select.value = cleanValues.includes(selected) ? selected : '';
  }

  function refreshReportSubGroupOptions() {
    const group = $('#reportProductGroupFilter')?.value || '';
    const subGroups = group && state.reportGroupSubGroups[group] && state.reportGroupSubGroups[group].length
      ? state.reportGroupSubGroups[group]
      : state.reportProductSubGroups;
    fillSelectOptions($('#reportProductSubGroupFilter'), subGroups, 'All Product SubGroups');
  }

  async function loadCategories() {
    if (state.reportFilterDropdownsLoadedAt && Date.now() - state.reportFilterDropdownsLoadedAt < 5 * 60 * 1000) {
      return;
    }
    const data = await api('/api/master/filters');
    state.categories = data.categories || [];
    state.reportProductGroups = data.groups || [];
    state.reportProductSubGroups = data.subGroups || [];
    state.reportGroupSubGroups = data.groupSubGroups || {};
    state.reportFilterDropdownsLoadedAt = Date.now();
    fillSelectOptions($('#reportCategoryFilter'), state.categories, 'All Categories');
    fillSelectOptions($('#reportProductGroupFilter'), state.reportProductGroups, 'All Product Groups');
    refreshReportSubGroupOptions();
  }

  async function connectDevice() {
    if (!isMobileClient()) return;
    if (!state.serverInfo) await loadHealth();
    await api('/api/devices/connect', {
      method: 'POST',
      body: {
        deviceId: ensureDeviceId(),
        deviceName: 'Mobile Scanner',
        model: navigator.platform || '',
        deviceType: 'mobile',
        dealerCode: currentDealerCode(),
        serverUrl: state.serverInfo ? state.serverInfo.serverUrl : ''
      }
    });
  }

  async function sendHeartbeat() {
    if (!isMobileClient()) return;
    try {
      if (!state.serverInfo) await loadHealth();
      const counts = syncCounts();
      await api('/api/devices/heartbeat', {
        method: 'POST',
        body: {
          deviceId: ensureDeviceId(),
          deviceName: 'Mobile Scanner',
          model: navigator.platform || '',
          deviceType: 'mobile',
          dealerCode: currentDealerCode(),
          serverUrl: state.serverInfo ? state.serverInfo.serverUrl : '',
          pendingCount: counts.total,
          failedCount: counts.failed,
          syncStatus: counts.failed ? 'failed' : 'working'
        }
      });
      setHeaderDeviceStatus(state.activeDeviceCount || 0);
    } catch (error) {
      setHeaderDeviceStatus(0);
    }
  }

  function updateDashboardCards(stats = {}) {
    setDashboardKpiValue('dashToday', wholeNumber(stats.totalScannedToday || 0));
    setDashboardKpiValue('dashTotalScanQty', wholeNumber(stats.totalScannedQuantity || stats.totalScanQty || 0));
    setDashboardKpiValue('dashDamage', wholeNumber(stats.damageCount || 0));
    setDashboardKpiValue('dashDuplicates', wholeNumber(stats.duplicateCount || 0));
    setDashboardKpiValue('dashInventoryCount', wholeNumber(stats.totalScanRecords || stats.totalUniqueScannedParts || 0));
    setDashboardKpiValue('dashFailedScans', wholeNumber(stats.failedCount || stats.mismatchCount || 0));
    setDashboardKpiValue('dashLastScanTime', stats.lastScanTime ? compactDateTime(stats.lastScanTime) : 'Never', { time: true });
    setDashboardKpiValue('dashLastScannedPart', stats.lastScannedPart || '-');
  }

  function scanQuantity(scan = {}, fallback = 0) {
    const value = scan.qty !== undefined && scan.qty !== null && scan.qty !== '' ? scan.qty : scan.quantity;
    return value !== undefined && value !== null && value !== '' ? value : fallback;
  }

  function scanHistorySummary(records = [], summary = {}) {
    const visibleTotalQty = records.reduce((sum, scan) => sum + Number(scanQuantity(scan, 0) || 0), 0);
    const visibleParts = new Set(records.map((scan) => normalizePartText(scan.partNumber || scan.part || '')).filter(Boolean));
    return {
      totalRows: Number(summary.totalRecords ?? summary.totalRows ?? records.length),
      totalQty: Number(summary.totalQuantity ?? summary.totalQty ?? visibleTotalQty),
      uniqueParts: Number(summary.uniqueParts ?? summary.uniquePartCount ?? visibleParts.size),
      visibleRows: records.length
    };
  }

  function updateScanHistorySummary(records = [], summary = {}) {
    const totals = scanHistorySummary(records, summary);
    setText('scanHistoryTotalQty', wholeNumber(totals.totalQty));
    setText('scanHistoryTotalRows', wholeNumber(totals.totalRows));
    setText('scanHistoryUniqueParts', wholeNumber(totals.uniqueParts));
    setText('scanHistoryVisibleRows', wholeNumber(totals.visibleRows));
  }

  function scanEntrySourceLabel(scan = {}) {
    if (scan.scanSourceLabel) return scan.scanSourceLabel;
    const source = String(scan.source || scan.scanSource || '').trim().toLowerCase();
    const deviceId = String(scan.deviceId || '').trim().toUpperCase();
    const channel = deviceId.startsWith('MOB-') || /mobile|camera|qr|ocr/.test(source) ? 'Mobile' : deviceId.startsWith('WEB-') ? 'Web' : 'Server';
    if (/manual/.test(source)) return `${channel} Manual Entry`;
    if (/barcode|scanner|qr|camera|mobile|ocr/.test(source)) return `${channel} Barcode/QR Scan`;
    return `${channel} System/API`;
  }

  function scanStreamRow(scan = {}) {
    const syncStatus = normalizedDisplaySyncStatus(scan) || 'pending';
    return `
      <tr>
        <td>${escapeHtml(compactDateTime(scan.timestamp))}</td>
        <td>${partLink(scan.partNumber || scan.part)}</td>
        <td>${escapeHtml(scanQuantity(scan, 0))}</td>
        <td>${escapeHtml(money(scan.mrp || 0))}</td>
        <td>${escapeHtml(scan.scanType || scan.type)}</td>
        <td>${escapeHtml(scan.binLocation || scan.bin)}</td>
        <td>${escapeHtml(scan.dealerCode || '')}</td>
        <td>${escapeHtml(scanEntrySourceLabel(scan))}</td>
        <td>${deviceLink(scan.deviceId)}</td>
        <td>${syncStatusBadge(syncStatus)}</td>
      </tr>
    `;
  }

  function renderScanStream(scans = []) {
    const rows = filterActiveAuditScans(scans).slice(0, 12);
    $('#streamRows').innerHTML = rows.length ? rows.map(scanStreamRow).join('') : '<tr><td colspan="10" class="muted">No scans yet</td></tr>';
    enhanceCoreTables();
  }

  function groupSummaryNumber(value) {
    return Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  }

  function groupSummaryValue(value) {
    return Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function dashboardProductGroupSearch() {
    return String($('#productGroupSearch')?.value || '').trim().toUpperCase();
  }

  function productGroupSummaryValue(item = {}, primary, fallback) {
    return item[primary] !== undefined && item[primary] !== null ? item[primary] : item[fallback];
  }

  function productGroupKey(productGroup = '', partSubGroup = '') {
    return `${String(productGroup || 'OTHERS').trim().toUpperCase()}::${String(partSubGroup || 'GENERAL').trim().toUpperCase()}`;
  }

  function renderProductGroupSummary() {
    const search = dashboardProductGroupSearch();
    const selectedKey = state.selectedProductGroupSummary
      ? productGroupKey(state.selectedProductGroupSummary.productGroup, state.selectedProductGroupSummary.partSubGroup)
      : '';
    const allRows = (state.dashboardProductGroupRows || []).slice().sort((a, b) => {
      const qtyA = Number(productGroupSummaryValue(a, 'totalQuantity', 'qty') || 0);
      const qtyB = Number(productGroupSummaryValue(b, 'totalQuantity', 'qty') || 0);
      return qtyB - qtyA;
    });
    const rows = search
      ? allRows.filter((item) => `${item.productGroup || ''} ${item.partSubGroup || item.productSubGroup || ''}`.toUpperCase().includes(search))
      : allRows;
    const body = $('#productGroupSummaryRows');
    if (body) {
      body.innerHTML = rows.length ? rows.map((item) => {
        const totalScans = productGroupSummaryValue(item, 'totalScans', 'scanCount');
        const totalQuantity = productGroupSummaryValue(item, 'totalQuantity', 'qty');
        const productGroup = item.productGroup || 'OTHERS';
        const partSubGroup = item.partSubGroup || item.productSubGroup || 'GENERAL';
        const rowKey = productGroupKey(productGroup, partSubGroup);
        return `
          <tr class="${rowKey === selectedKey ? 'selected' : ''}">
            <td><button class="link-button product-group-detail-link" type="button" data-product-group="${escapeHtml(productGroup)}" data-part-sub-group="${escapeHtml(partSubGroup)}">${escapeHtml(productGroup)}</button></td>
            <td><button class="link-button product-group-detail-link" type="button" data-product-group="${escapeHtml(productGroup)}" data-part-sub-group="${escapeHtml(partSubGroup)}">${escapeHtml(partSubGroup)}</button></td>
            <td class="number-cell">${escapeHtml(groupSummaryNumber(totalScans))}</td>
            <td class="number-cell">${escapeHtml(groupSummaryNumber(totalQuantity))}</td>
            <td class="number-cell">${escapeHtml(groupSummaryNumber(item.uniqueParts || 0))}</td>
            <td class="number-cell">${escapeHtml(groupSummaryValue(item.totalMrpValue || 0))}</td>
            <td class="number-cell">${escapeHtml(groupSummaryValue(item.totalDlcValue || 0))}</td>
          </tr>
        `;
      }).join('') : '<tr><td colspan="7" class="muted">No product group data found</td></tr>';
    }
    setText('productGroupSummaryCount', `${rows.length} of ${allRows.length} groups`);
    enhanceCoreTables();
  }

  function renderProductGroupDetails(data = {}) {
    const panel = $('#productGroupDetailPanel');
    const body = $('#productGroupDetailRows');
    if (!panel || !body) return;
    const selected = state.selectedProductGroupSummary;
    if (!selected) {
      panel.hidden = true;
      return;
    }
    const rows = data.rows || state.productGroupDetailRows || [];
    const totals = data.totals || state.productGroupDetailTotals || {};
    panel.hidden = false;
    setText('productGroupDetailTitle', `${selected.productGroup} / ${selected.partSubGroup}`);
    setText('productGroupDetailTotals', `Parts ${groupSummaryNumber(totals.partCount || rows.length)} | Qty ${groupSummaryNumber(totals.totalQty || 0)} | MRP ${groupSummaryValue(totals.totalMrpValue || 0)}`);
    body.innerHTML = rows.length ? rows.map((row) => `
      <tr>
        <td>${partLink(row.partNumber)}</td>
        <td>${escapeHtml(row.partDescription || '')}</td>
        <td class="number-cell">${escapeHtml(groupSummaryNumber(row.qty || 0))}</td>
        <td>${escapeHtml(row.binLocation || '')}</td>
        <td class="number-cell">${escapeHtml(groupSummaryValue(row.mrp || 0))}</td>
        <td class="number-cell">${escapeHtml(groupSummaryValue(row.mrpTotal || 0))}</td>
      </tr>
    `).join('') + `
      <tr class="summary-total-row">
        <td colspan="2">Total</td>
        <td class="number-cell">${escapeHtml(groupSummaryNumber(totals.totalQty || 0))}</td>
        <td>${escapeHtml(groupSummaryNumber(totals.partCount || rows.length))} parts</td>
        <td></td>
        <td class="number-cell">${escapeHtml(groupSummaryValue(totals.totalMrpValue || 0))}</td>
      </tr>
    ` : '<tr><td colspan="6" class="muted">No parts found for this group</td></tr>';
  }

  async function loadProductGroupDetails(productGroup, partSubGroup) {
    state.selectedProductGroupSummary = { productGroup: productGroup || 'OTHERS', partSubGroup: partSubGroup || 'GENERAL' };
    state.productGroupDetailRows = [];
    state.productGroupDetailTotals = null;
    renderProductGroupSummary();
    renderProductGroupDetails({ rows: [], totals: {} });
    const query = new URLSearchParams({
      productGroup: state.selectedProductGroupSummary.productGroup,
      partSubGroup: state.selectedProductGroupSummary.partSubGroup
    });
    appendDashboardScopeQuery(query);
    const data = await api(`/api/scans/dashboard/product-group-summary/details?${query.toString()}`);
    state.productGroupDetailRows = data.rows || [];
    state.productGroupDetailTotals = data.totals || null;
    renderProductGroupDetails(data);
  }

  async function exportProductGroupSummary() {
    const query = new URLSearchParams();
    const search = dashboardProductGroupSearch();
    if (search) query.set('q', search);
    appendDashboardScopeQuery(query);
    await downloadGet(`/api/scans/dashboard/product-group-summary/export${query.toString() ? `?${query.toString()}` : ''}`, 'Daksh_Product_Group_Summary.xlsx');
  }

  async function exportProductGroupDetails() {
    const selected = state.selectedProductGroupSummary;
    if (!selected) return toast('Click a product group first', 'error');
    const query = new URLSearchParams({
      productGroup: selected.productGroup,
      partSubGroup: selected.partSubGroup,
      format: 'excel'
    });
    appendDashboardScopeQuery(query);
    await downloadGet(`/api/scans/dashboard/product-group-summary/details?${query.toString()}`, `Daksh_${selected.productGroup.replace(/[^a-z0-9]+/gi, '_')}_Parts.xlsx`);
  }

  function addScanToStream(scan = {}) {
    const body = $('#streamRows');
    if (!body) return;
    if (body.querySelector('.muted')) body.innerHTML = '';
    body.insertAdjacentHTML('afterbegin', scanStreamRow(scan));
    Array.from(body.querySelectorAll('tr')).slice(12).forEach((row) => row.remove());
    enhanceCoreTables();
  }

  async function handleNewScan(scan = {}) {
    if (!activeAuditMatchesScan(scan)) {
      console.log('[DASHBOARD] ignored scan outside active audit', {
        dealerCode: scan.dealerCode || '',
        auditId: scan.auditId || ''
      });
      return;
    }
    const realtimeId = scan.scanId || scan.uniqueScanId || scan._id || scan.syncKey || '';
    if (realtimeId) {
      if (state.recentRealtimeScanIds.has(realtimeId)) return;
      state.recentRealtimeScanIds.add(realtimeId);
      setTimeout(() => state.recentRealtimeScanIds.delete(realtimeId), 15000);
    }
    state.lastRealtimeAt = Date.now();
    console.log('[DASHBOARD] realtime scan received', {
      scanId: scan.scanId || scan.uniqueScanId || '',
      partNumber: scan.partNumber || scan.part || '',
      dealerCode: scan.dealerCode || '',
      deviceId: scan.deviceId || ''
    });
    showScanPopup(scan);
    addScanToStream(scan);
    const currentToday = Number(String(($('#dashToday') || {}).textContent || 0).replace(/,/g, ''));
    if (Number.isFinite(currentToday)) setDashboardKpiValue('dashToday', wholeNumber(currentToday + 1));
    const currentScanQty = Number(String(($('#dashTotalScanQty') || {}).textContent || 0).replace(/,/g, ''));
    const scanQty = Number(scanQuantity(scan, 1));
    if (Number.isFinite(currentScanQty)) setDashboardKpiValue('dashTotalScanQty', wholeNumber(currentScanQty + (Number.isFinite(scanQty) ? scanQty : 1)));
    setDashboardKpiValue('dashLastScanTime', compactDateTime(scan.timestamp || new Date()), { time: true });
    setDashboardKpiValue('dashLastScannedPart', scan.partNumber || scan.part || '-');
    setStatusPill('topRealtimeStatus', 'Realtime: Scan Received', 'blue');
    setDashboardKpiValue('dashRealtimeActivity', compactDateTime(scan.timestamp || new Date()), { time: true });
    queueScanRefresh(1200);
  }

  async function loadDashboard() {
    await loadActiveAudit({ silent: true }).catch(() => null);
    const query = dashboardQueryString();
    const data = await api(`/api/scans/dashboard${query ? `?${query}` : ''}`);
    if (data.activeAudit && data.activeAudit.dealerCode) {
      state.activeAudit = data.activeAudit;
      updateActiveAuditUi();
    }
    const stats = data.stats || {};
    console.log('[DASHBOARD] fetch success', {
      totalScannedToday: stats.totalScannedToday || 0,
      recentCount: Array.isArray(data.recent) ? data.recent.length : 0,
      lastScanTime: stats.lastScanTime || null,
      lastScannedPart: stats.lastScannedPart || ''
    });
    updateDashboardCards(stats);
    renderScanStream(filterActiveAuditScans(data.recent || []));
    state.dashboardProductGroupRows = data.productGroupSummary || [];
    renderProductGroupSummary();
  }

  function syncScanDealerScope(dealerCode, sourceSelect = null) {
    const cleanCode = cleanDealerCode(dealerCode || '');
    if (cleanCode) {
      $$('#scan select[name="dealerCode"].dealerSelect').forEach((select) => {
        if (select !== sourceSelect) setDealerSelectValue(select, cleanCode);
      });
    }
    const reportDealer = $('[name="dealerCode"]', $('#reportFilters'));
    if (reportDealer) setDealerSelectValue(reportDealer, cleanCode, 'all');
  }

  async function loadScanHistory() {
    const params = new URLSearchParams(queryFromForm($('#scanHistoryFilters')));
    const dealerCode = cleanDealerCode(params.get('dealerCode') || selectedScanDealerCode());
    if (dealerCode && dealerCode !== 'ALL') {
      params.set('dealerCode', dealerCode);
      params.delete('dealer');
    } else {
      params.delete('dealerCode');
    }
    const query = params.toString();
    const data = await api(`/api/scans/history?${query}`);
    console.log('[DASHBOARD] scan history fetch success', {
      query,
      count: Array.isArray(data.records) ? data.records.length : 0
    });
    const records = data.records || [];
    updateScanHistorySummary(records, data.summary || {});
    $('#scanHistoryRows').innerHTML = records.map((scan) => `
      <tr>
        <td class="select-cell"><input class="scan-history-checkbox" type="checkbox" value="${escapeHtml(scan.scanId || scan.uniqueScanId || scan._id)}"></td>
        <td>${escapeHtml(dateTime(scan.timestamp))}</td>
        <td>${partLink(scan.partNumber || scan.part)}</td>
        <td>${escapeHtml(scan.partDescription || scan.partName)}</td>
        <td>${escapeHtml(scan.productCategory || scan.category || '')}</td>
        <td>${escapeHtml(money(scan.mrp))}</td>
        <td>${escapeHtml(money(scan.dlc))}</td>
        <td>${escapeHtml(scan.productGroup || '')}</td>
        <td>${escapeHtml(scan.model || '')}</td>
        <td>${escapeHtml(scan.manufacturingYear || scan.year || '')}</td>
        <td>${escapeHtml(scanQuantity(scan, 0))}</td>
        <td>${escapeHtml(scan.type)}</td>
        <td>${escapeHtml(scan.bin)}</td>
        <td>${escapeHtml(scan.dealerName || scan.dealerCode)}</td>
        <td>${deviceLink(scan.deviceId)}</td>
        <td>${statusCell(scan)}</td>
        <td><button class="btn danger-soft scan-row-delete admin-only" data-id="${escapeHtml(scan.scanId || scan.uniqueScanId || scan._id)}" type="button">Delete This Row</button></td>
      </tr>
    `).join('') || '<tr><td colspan="17" class="muted">No scan history found</td></tr>';
    enhanceCoreTables();
    $$('.scan-row-delete').forEach((button) => {
      button.addEventListener('click', () => deleteSingleScan(button.dataset.id).catch((error) => toast(error.message, 'error')));
    });
  }

  async function repairSyncStatus() {
    if (!window.confirm('Repair WEB/server-saved pending scan records to synced?')) return;
    const data = await api('/api/scans/repair-sync-status', { method: 'POST', body: {} });
    toast(data.message || 'Sync status repaired');
    await Promise.all([
      loadDashboard(),
      loadScanHistory(),
      loadSyncStatus()
    ]);
  }

  function fillPart(form, part) {
    const partInput = $('.partSuggestInput', form);
    if (partInput) partInput.value = part.partNumber || part.partNo || '';
    ['partName', 'bin', 'mrp', 'category'].forEach((key) => {
      const node = `[data-fill="${key}"]`;
      const input = $(node, form) || $(`[name="${key}"]`, form);
      if (input) input.value = key === 'bin' ? part.binLocation || part.bin || '' : part[key] || '';
    });
  }

  function bindSuggestions() {
    $$('.partSuggestInput').forEach((input) => {
      let timer;
      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const q = input.value.trim();
          const wrap = input.closest('.suggest-wrap');
          const menu = $('.suggest-menu', wrap);
          if (!q) {
            menu.style.display = 'none';
            return;
          }
          try {
            const data = await api(`/api/master/parts/suggest?q=${encodeURIComponent(q)}`);
            const parts = data.suggestions || data.parts || [];
            menu.innerHTML = parts.map((part) => `
              <div class="suggest-item" data-part="${escapeHtml(JSON.stringify(part))}">
                <strong>${partLink(part.partNumber || part.partNo)}</strong>
                <span>${escapeHtml(part.partDescription || part.partName)} | ${escapeHtml(part.productCategory || part.category)} | MRP ${escapeHtml(money(part.mrp))} | DLC ${escapeHtml(money(part.dlc))}</span>
              </div>
            `).join('');
            menu.style.display = parts.length ? 'block' : 'none';
            $$('.suggest-item', menu).forEach((item) => {
              item.addEventListener('click', () => {
                fillPart(input.closest('form'), JSON.parse(item.dataset.part));
                menu.style.display = 'none';
              });
            });
          } catch (error) {
            toast(error.message, 'error');
          }
        }, 180);
      });
    });
  }

  function bindUppercaseInputs() {
    document.addEventListener('input', (event) => {
      const field = event.target;
      if (!field || !['INPUT', 'TEXTAREA'].includes(field.tagName)) return;
      const type = String(field.type || '').toLowerCase();
      if (['password', 'email', 'file', 'number', 'date', 'time', 'datetime-local', 'checkbox', 'radio'].includes(type)) return;
      const start = field.selectionStart;
      const end = field.selectionEnd;
      const upper = field.value.toUpperCase();
      if (field.value !== upper) {
        field.value = upper;
        if (typeof start === 'number' && typeof end === 'number') field.setSelectionRange(start, end);
      }
    });
  }

  function bindMasterSearchSuggestions() {
    const input = $('#partMasterSearchInput');
    if (!input) return;
    const menu = $('.master-suggest-menu', input.closest('.suggest-wrap'));
    let timer;
    let activeIndex = -1;
    const chooseItem = async (item) => {
      if (!item) return;
      const part = JSON.parse(item.dataset.part);
      console.log("Autocomplete selected:", part);
      input.value = part.partNumber || part.partNo || '';
      menu.style.display = 'none';
      activeIndex = -1;
      await loadParts();
    };
    const setActive = (index) => {
      const items = $$('.master-suggest-item', menu);
      activeIndex = Math.max(-1, Math.min(index, items.length - 1));
      items.forEach((item, itemIndex) => item.classList.toggle('active', itemIndex === activeIndex));
      if (items[activeIndex]) items[activeIndex].scrollIntoView({ block: 'nearest' });
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim();
        if (!q) {
          menu.style.display = 'none';
          return;
        }
        try {
          const data = await api(`/api/master/parts/suggest?q=${encodeURIComponent(q)}&limit=20`);
          const parts = data.suggestions || data.parts || [];
          menu.innerHTML = parts.map((part) => `
            <div class="suggest-item master-suggest-item" data-part="${escapeHtml(JSON.stringify(part))}">
              <strong>${partLink(part.partNumber || part.partNo)} <span>| ${escapeHtml(part.partDescription || part.partName || '')}</span></strong>
              <span>${escapeHtml(part.productCategory || part.category || '-')} | ${escapeHtml(part.model || '-')} | ${escapeHtml(part.year || part.manufacturingYear || '-')} | MRP ${escapeHtml(money(part.mrp))} | DLC ${escapeHtml(money(part.dlc))}</span>
            </div>
          `).join('');
          menu.style.display = parts.length ? 'block' : 'none';
          activeIndex = -1;
          $$('.master-suggest-item', menu).forEach((item) => {
            item.addEventListener('mousedown', (event) => event.preventDefault());
            item.addEventListener('click', () => chooseItem(item).catch((error) => toast(error.message, 'error')));
          });
        } catch (error) {
          toast(error.message, 'error');
        }
      }, 160);
    });
    input.addEventListener('keydown', (event) => {
      const items = $$('.master-suggest-item', menu);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive(activeIndex + 1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive(activeIndex <= 0 ? items.length - 1 : activeIndex - 1);
      } else if (event.key === 'Enter' && items.length && activeIndex >= 0) {
        event.preventDefault();
        chooseItem(items[activeIndex]).catch((error) => toast(error.message, 'error'));
      } else if (event.key === 'Escape') {
        menu.style.display = 'none';
        activeIndex = -1;
      }
    });
    input.addEventListener('blur', () => setTimeout(() => { menu.style.display = 'none'; }, 180));
  }

  async function refreshScanViews() {
    if (state.scanRefreshInFlight) {
      state.scanRefreshQueued = true;
      return null;
    }
    state.scanRefreshInFlight = true;
    state.scanRefreshQueued = false;
    try {
      return await Promise.all([loadDashboard(), loadScanHistory(), loadSyncStatus()])
        .catch((error) => console.warn('[SCAN] refresh failed', error));
    } finally {
      state.scanRefreshInFlight = false;
      if (state.scanRefreshQueued) queueScanRefresh(700);
    }
  }

  function queueScanRefresh(delay = 900) {
    clearTimeout(state.scanRefreshTimer);
    state.scanRefreshTimer = setTimeout(() => {
      refreshScanViews().catch((error) => console.warn('[SCAN] queued refresh failed', error));
    }, delay);
  }

  function queueDeviceRefresh(delay = 2500) {
    clearTimeout(state.deviceRefreshTimer);
    state.deviceRefreshTimer = setTimeout(() => {
      loadDevices().catch((error) => console.warn('[DEVICES] queued refresh failed', error));
    }, delay);
  }

  function refreshScanViewsSoon(delay = 900) {
    queueScanRefresh(delay);
    return Promise.resolve(null);
  }

  function refreshScanViewsNow() {
    clearTimeout(state.scanRefreshTimer);
    return refreshScanViews()
      .catch((error) => console.warn('[SCAN] refresh failed', error));
  }

  function resetManualScanFields(form) {
    if (!form) return;
    const dealerCode = $('[name="dealerCode"]', form)?.value || selectedScanDealerCode() || '';
    const staffName = $('[name="staffName"]', form)?.value || (state.user ? state.user.name || state.user.username || '' : '');
    const scanType = $('[name="type"]', form)?.value || 'INWARD';
    form.reset();
    if (dealerCode) setDealerSelectValue($('[name="dealerCode"]', form), dealerCode);
    const typeInput = $('[name="type"]', form);
    if (typeInput) typeInput.value = scanType;
    const staffInput = $('[name="staffName"]', form);
    if (staffInput) staffInput.value = staffName;
    const qtyInput = $('[name="qty"]', form);
    if (qtyInput) qtyInput.value = 1;
    ['part', 'partName', 'bin', 'mrp', 'category', 'rawScan'].forEach((name) => {
      const input = $(`[name="${name}"]`, form);
      if (input) input.value = '';
    });
    $$('.suggest-menu', form).forEach((menu) => {
      menu.innerHTML = '';
      menu.style.display = 'none';
    });
    updateScanTypeFields(form);
  }

  function updateScanTypeFields(form) {
    if (!form) return;
    const scanType = String($('[name="type"]', form)?.value || 'INWARD').trim().toUpperCase();
    const isFitted = scanType === 'FITTED';
    const needsManualBin = ['INWARD', 'DAMAGE'].includes(scanType);
    $$('.fitted-only', form).forEach((label) => {
      label.classList.toggle('hidden', !isFitted);
      $$('input, select, textarea', label).forEach((field) => {
        field.required = isFitted;
        field.disabled = !isFitted;
        if (!isFitted) field.value = '';
      });
    });
    const binInput = $('[name="bin"], [name="binLocation"]', form);
    const binLabel = binInput?.closest('label');
    if (binInput) {
      binInput.required = needsManualBin;
      binInput.disabled = !needsManualBin;
      if (!needsManualBin) binInput.value = '';
    }
    if (binLabel) {
      binLabel.classList.toggle('hidden', !needsManualBin);
    }
    if (form.id === 'barcodeScanForm') {
      setLivePill('barcodeReadyStatus', needsManualBin ? (binInput?.value ? 'Ready for Scan' : 'Enter Bin Location') : 'Ready for Scan', needsManualBin ? Boolean(binInput?.value) : true);
    }
  }

  async function submitScan(form, options = {}) {
    const payload = formObject(form);
    const isBarcodeForm = form.id === 'barcodeScanForm';
    payload.deviceId = payload.deviceId || ensureDeviceId();
    if (!payload.staffName && state.user) payload.staffName = state.user.name || state.user.username;
    if (isBarcodeForm && !payload.rawScan) payload.rawScan = payload.part || '';
    const normalized = normalizeScanPayload(payload);
    normalized.scanType = String(normalized.scanType || normalized.type || 'INWARD').trim().toUpperCase();
    normalized.type = normalized.scanType;
    normalized.binLocation = normalizePartText(normalized.binLocation);
    normalized.bin = normalized.binLocation;
    normalized.source = isBarcodeForm ? 'barcode' : (normalized.source || 'manual');
    normalized.scanMode = isBarcodeForm ? 'Barcode/Web Scan' : (normalized.scanMode || 'Manual');
    if (!isBarcodeForm && !payload.rawScan && !payload.rawScanString && !payload.rawBarcode && !payload.rawScanValue && !payload.barcode && !payload.barcodeValue && !payload.scanValue && !payload.scanText) {
      normalized.rawScan = '';
      normalized.rawScanString = '';
      normalized.rawBarcode = '';
      normalized.rawScanValue = '';
    }
    normalized.synced = true;
    normalized.isSynced = true;
    normalized.syncStatus = 'synced';
    const needsManualBin = ['INWARD', 'DAMAGE'].includes(normalized.scanType);
    if (needsManualBin && !normalized.binLocation) {
      playScanTone('error');
      toast(isBarcodeForm ? 'Please enter/select bin location before scanning.' : 'Please enter/select bin location first.', 'error');
      if (isBarcodeForm) {
        setLivePill('barcodeReadyStatus', 'Enter Bin Location', false);
        $('#barcodeBinLocation')?.focus();
      }
      return;
    }
    if (normalized.scanType === 'FITTED' && (!String(normalized.regdNo || '').trim() || !String(normalized.jobCardNo || '').trim())) {
      playScanTone('error');
      toast('Regd No and Job Card No are required for fitted parts.', 'error');
      return;
    }
    if (!validPartText(normalized.partNumber)) {
      playScanTone('error');
      toast('Invalid part number format', 'error');
      return;
    }

    try {
      const data = await api('/api/scans/manual', { method: 'POST', body: normalized });
      if (data && data.scan) {
        addSyncLog({
          partNumber: normalized.partNumber,
          upiId: normalized.upiId,
          dealer: normalized.dealerCode,
          status: data.duplicate ? 'duplicate' : 'synced',
          errorMessage: data.duplicate ? 'Duplicate scan skipped' : ''
        });
        rememberLastSyncTime(data.completedAt || data.lastSyncTime || data.lastSync || new Date().toISOString());
      }
      playScanTone(data.duplicate ? 'duplicate' : 'success');
      if (isBarcodeForm) {
        localStorage.setItem(BARCODE_LAST_BIN_KEY, normalized.binLocation);
        resetBarcodeScanFields(form, normalized, options.expectedRaw);
        setLivePill('barcodeReadyStatus', data.duplicate ? 'Duplicate skipped' : 'Saved - Ready Next', true);
        setTimeout(() => {
          setLivePill('barcodeReadyStatus', 'Ready for Scan', true);
          $('#barcodeRaw')?.focus();
        }, 900);
      } else {
        resetManualScanFields(form);
      }
      if (options.backgroundRefresh) {
        refreshScanViewsSoon(650);
      } else {
        await refreshScanViewsNow();
      }
    } catch (error) {
      if (error.status === 409 && error.data?.fittedDuplicate) {
        playScanTone('duplicate');
        if (window.confirm(error.data.message || 'This fitted part already exists for this vehicle/job card. Add quantity?')) {
          normalized.addFittedQuantity = true;
          const updateData = await api('/api/scans/manual', { method: 'POST', body: normalized });
          playScanTone('success');
          toast(updateData.message || 'Fitted part quantity updated');
          if (isBarcodeForm) resetBarcodeScanFields(form, normalized, options.expectedRaw);
          else resetManualScanFields(form);
          await refreshScanViewsNow();
        }
        return;
      }
      if (error.status === 409 && state.user && state.user.role === 'admin') {
        const warnings = (error.data.warnings || []).join(', ');
        const unknownBlocked = /part does not exist|unknown/i.test(warnings) && localStorage.getItem('dakshAllowUnknown') !== 'true';
        if (unknownBlocked) {
          playScanTone('error');
          toast('Unknown part save is disabled in Admin Settings', 'error');
          return;
        }
        if (window.confirm(`Warnings: ${warnings}\nOverride and save?`)) {
          normalized.override = true;
          const overrideData = await api('/api/scans/manual', { method: 'POST', body: normalized });
          playScanTone(overrideData.duplicate ? 'duplicate' : 'success');
          resetManualScanFields(form);
          await refreshScanViewsNow();
        }
        return;
      }
      if (!error.status || error.status >= 500) {
        enqueueScan(normalized, error.message || 'Server unavailable; scan saved locally');
        if (isBarcodeForm) {
          resetBarcodeScanFields(form, normalized, options.expectedRaw);
          setTimeout(() => $('#barcodeRaw')?.focus(), 900);
        } else {
          resetManualScanFields(form);
        }
        playScanTone('error');
        toast('Server unavailable. Scan saved in local pending queue.', 'error');
        return;
      }
      playScanTone('error');
      toast(error.message, 'error');
      if (isBarcodeForm) {
        setLivePill('barcodeReadyStatus', /not found|reject/i.test(error.message) ? 'Rejected - Ready' : 'Fix Error', false);
        resetBarcodeScanFields(form, normalized, options.expectedRaw);
        setTimeout(() => $('#barcodeRaw')?.focus(), 1000);
      }
    }
  }

  function readMobileQueue() {
    const text = $('#mobileSyncQueue').value.trim();
    if (!text) return [];
    if (text.startsWith('[') || text.startsWith('{')) {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [parsed];
    }
    return text.split(/\r?\n/).filter(Boolean).map((rawScan) => ({ rawScan }));
  }

  function enqueueMobileTextQueue() {
    let scans = [];
    try {
      scans = readMobileQueue();
    } catch (error) {
      toast('Mobile queue JSON is invalid', 'error');
      return false;
    }
    try {
      scans.forEach((scan) => enqueueScan(scan, 'Queued from mobile sync input'));
    } catch (error) {
      toast(error.message, 'error');
      return false;
    }
    if (scans.length) $('#mobileSyncQueue').value = '';
    return true;
  }

  async function syncPendingQueue(options = {}) {
    if (state.syncInProgress) return { skipped: true };
    try {
      if (options.checkHealth !== false) {
        await loadHealth();
        await loadActiveAudit();
        setHeaderSyncStatus('Synced', true);
        setDashboardSyncStatus('Synced', true);
      }
    } catch (error) {
      error.healthFailed = true;
      setHeaderSyncStatus('Failed', false);
      setDashboardSyncStatus('Failed', false);
      updateSyncBadges({ serverStatus: 'offline', mongoStatus: 'offline' });
      if (!options.silent) toast(error.message, 'error');
      if (!options.silent) addSyncLog({ status: 'failed', errorMessage: error.message });
      return { success: false, message: error.message, healthFailed: true };
    }

    const queue = getSyncQueue();
    const records = queue.filter((item) => options.includeFailed || item.localStatus !== 'failed');
    if (!records.length) {
      updateSyncBadges();
      setHeaderSyncStatus('Synced', true);
      setDashboardSyncStatus('Synced', true);
      return { success: true, syncedCount: 0, synced: 0 };
    }

    state.syncInProgress = true;
    setHeaderSyncStatus('Syncing', true);
    setDashboardSyncStatus('Syncing', true);
    try {
      const outboundRecords = records.map((record) => normalizeScanPayload(applyActiveAuditToPayload({
        ...record,
        uniqueScanId: record.uniqueScanId || record.localId,
        syncKey: ''
      })));
      const outboundKeyByLocalKey = new Map();
      records.forEach((record, index) => outboundKeyByLocalKey.set(record.syncKey, outboundRecords[index].syncKey));

      const data = await api('/api/mobile/sync', {
        method: 'POST',
        body: {
          scans: outboundRecords,
          deviceId: ensureDeviceId(),
          dealerCode: currentDealerCode(),
          serverUrl: state.serverInfo ? state.serverInfo.serverUrl : ''
        }
      });

      const completedKeys = new Set();
      const failedByKey = new Map();
      (data.logs || []).forEach((log) => {
        addSyncLog(log);
        if (log.syncKey && ['inserted', 'synced', 'duplicate'].includes(log.status)) completedKeys.add(log.syncKey);
        if (log.syncKey && log.status === 'failed') failedByKey.set(log.syncKey, log.errorMessage || 'Sync failed');
      });

      const nextQueue = getSyncQueue()
        .filter((item) => !completedKeys.has(item.syncKey) && !completedKeys.has(outboundKeyByLocalKey.get(item.syncKey)))
        .map((item) => failedByKey.has(item.syncKey)
          ? { ...item, localStatus: 'failed', retryCount: Number(item.retryCount || 0) + 1, syncError: failedByKey.get(item.syncKey) }
          : failedByKey.has(outboundKeyByLocalKey.get(item.syncKey))
            ? { ...item, localStatus: 'failed', retryCount: Number(item.retryCount || 0) + 1, syncError: failedByKey.get(outboundKeyByLocalKey.get(item.syncKey)) }
          : item);
      saveSyncQueue(nextQueue);

      const syncTime = rememberLastSyncTime(data.completedAt || data.lastSync || data.lastSyncTime || data.lastSuccessfulSyncAt || new Date().toISOString());
      setText('deviceLastSync', dateTime(syncTime));
      setText('syncTotal', data.totalSynced || 0);
      updateSyncBadges(data);
      setHeaderSyncStatus(getSyncQueue().length ? 'Pending' : 'Synced', !getSyncQueue().length);
      setDashboardSyncStatus(getSyncQueue().length ? 'Pending' : 'Synced', !getSyncQueue().length);
      await refreshAfterSync(data);
      return data;
    } catch (error) {
      if (error.data) renderSyncApiResponse(error.data);
      const failedQueue = getSyncQueue().map((item) => records.some((record) => record.syncKey === item.syncKey)
        ? { ...item, localStatus: 'failed', retryCount: Number(item.retryCount || 0) + 1, syncError: error.message }
        : item);
      saveSyncQueue(failedQueue);
      records.forEach((record) => addSyncLog({
        partNumber: record.partNumber || record.part,
        upiId: record.upiId,
        dealer: record.dealerCode,
        status: 'failed',
        errorMessage: error.message
      }));
      setHeaderSyncStatus('Failed', false);
      setDashboardSyncStatus('Failed', false);
      updateSyncBadges({ serverStatus: 'offline', mongoStatus: 'offline' });
      if (!options.silent) toast(error.message, 'error');
      return { success: false, message: error.message };
    } finally {
      state.syncInProgress = false;
    }
  }

  async function runSync() {
    const queued = enqueueMobileTextQueue();
    if (queued === false) return;
    try {
      const data = await syncPendingQueue({ includeFailed: true });
      if (data && data.success === false) return;
      if (data && !data.skipped) {
        setHeaderSyncStatus(syncCounts().total ? 'Pending' : 'Synced', syncCounts().total === 0);
      }
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function activeReportType() {
    const selected = $('#reportTypeSelect') ? $('#reportTypeSelect').value : state.lastReportType;
    return REPORT_TITLES[selected] ? selected : '';
  }

  function selectedReportFilterKeys(reportType = activeReportType()) {
    const saved = state.reportFilterSettings[reportType];
    const defaults = REPORT_FILTER_DEFAULTS_BY_TYPE[reportType] || REPORT_FILTER_DEFAULTS;
    return new Set((Array.isArray(saved) && saved.length ? saved : defaults).filter(Boolean));
  }

  function applyReportFilterVisibility(reportType = activeReportType()) {
    const selected = selectedReportFilterKeys(reportType);
    $$('[data-report-filter-key]', $('#reportFilters')).forEach((node) => {
      const key = node.dataset.reportFilterKey;
      const visible = selected.has(key);
      node.classList.toggle('hidden', !visible);
      if (!visible) {
        $$('input, select, textarea', node).forEach((field) => {
          if (field.type === 'checkbox' || field.type === 'radio') field.checked = false;
          else field.value = '';
        });
      }
    });
    updateReportButtons();
  }

  function renderReportFilterSettingsList() {
    const list = $('#reportFilterSettingsList');
    if (!list) return;
    const selected = selectedReportFilterKeys();
    list.innerHTML = REPORT_FILTER_OPTIONS.map(([key, label]) => `
      <label>
        <input type="checkbox" value="${escapeHtml(key)}" ${selected.has(key) ? 'checked' : ''}>
        <span>${escapeHtml(label)}</span>
      </label>
    `).join('');
  }

  async function loadReportFilterSettings(reportType = activeReportType(), options = {}) {
    if (!reportType) return;
    if (!options.force && state.reportFilterSettingsLoaded.has(reportType)) {
      applyReportFilterVisibility(reportType);
      return;
    }
    try {
      const data = await api(`/api/report-filter-settings/${encodeURIComponent(reportType)}`);
      state.reportFilterSettings[reportType] = Array.isArray(data.selectedFilters) ? data.selectedFilters : (REPORT_FILTER_DEFAULTS_BY_TYPE[reportType] || REPORT_FILTER_DEFAULTS);
      state.reportFilterSettingsLoaded.add(reportType);
    } catch (error) {
      state.reportFilterSettings[reportType] = REPORT_FILTER_DEFAULTS_BY_TYPE[reportType] || REPORT_FILTER_DEFAULTS;
      console.warn('Report filter settings load failed', error);
    }
    applyReportFilterVisibility(reportType);
  }

  async function saveReportFilterSettings(selectedFilters) {
    const reportType = activeReportType();
    if (!reportType) {
      toast('Select report type first', 'error');
      return;
    }
    const data = await api(`/api/report-filter-settings/${encodeURIComponent(reportType)}`, {
      method: 'POST',
      body: { selectedFilters }
    });
    state.reportFilterSettings[reportType] = Array.isArray(data.selectedFilters) ? data.selectedFilters : selectedFilters;
    state.reportFilterSettingsLoaded.add(reportType);
    applyReportFilterVisibility(reportType);
    saveReportState(false);
    toast('Report filter settings saved');
  }

  function openReportFilterSettings() {
    if (!activeReportType()) {
      toast('Select report type first', 'error');
      return;
    }
    renderReportFilterSettingsList();
    renderReportColumnSettingsList();
    $('#reportFilterSettingsModal')?.classList.remove('hidden');
  }

  function closeReportFilterSettings() {
    $('#reportFilterSettingsModal')?.classList.add('hidden');
  }

  function readReportColumnSettings() {
    try {
      return JSON.parse(localStorage.getItem(REPORT_COLUMN_SETTINGS_KEY) || '{}') || {};
    } catch (error) {
      return {};
    }
  }

  function saveReportColumnSettings(reportType, selectedColumns) {
    const settings = readReportColumnSettings();
    if (Array.isArray(selectedColumns)) settings[reportType] = selectedColumns.filter(Boolean);
    else delete settings[reportType];
    localStorage.setItem(REPORT_COLUMN_SETTINGS_KEY, JSON.stringify(settings));
  }

  function savedReportColumnKeys(reportType = activeReportType()) {
    const keys = readReportColumnSettings()[reportType];
    return Array.isArray(keys) && keys.length ? keys : null;
  }

  function baseReportColumns(columns, rows) {
    return columns && columns.length ? columns : columnsForRows(rows);
  }

  function defaultReportColumnLimit(reportType = activeReportType()) {
    return ['category-wise-variance-summary', 'partwise-inventory-audit', 'stock-summary'].includes(reportType) ? 0 : 18;
  }

  function defaultReportColumns(available, reportType = activeReportType(), defaultLimit = defaultReportColumnLimit(reportType)) {
    return (available || []).slice(0, defaultLimit || (available || []).length);
  }

  function reportColumnsForDisplay(columns, rows, reportType = activeReportType(), defaultLimit = 18) {
    const available = baseReportColumns(columns, rows);
    const selected = savedReportColumnKeys(reportType);
    const visible = selected
      ? available.filter((column, index) => selected.includes(reportColumnKey(column, index)))
      : defaultReportColumns(available, reportType, defaultLimit);
    return applyReportColumnOrder(visible.length ? visible : defaultReportColumns(available, reportType, defaultLimit), reportType);
  }

  function currentReportColumnKeys(reportType = activeReportType()) {
    const rendered = $$('#reportHead th[data-col-key]').map((th) => th.dataset.colKey).filter(Boolean);
    if (rendered.length) return rendered;
    const saved = savedReportColumnKeys(reportType);
    return saved && saved.length ? saved : null;
  }

  function rerenderCurrentReportTable() {
    if (state.reportTableRows.length || state.reportTableColumns.length) {
      renderReportTable(state.reportTableColumns, state.reportTableRows, state.reportTableTotalRows, state.reportTableGrandTotal, activeReportType());
    }
  }

  function renderReportColumnSettingsList() {
    const list = $('#reportColumnSettingsList');
    if (!list) return;
    const reportType = activeReportType();
    const available = baseReportColumns(state.reportTableColumns, state.reportTableRows);
    const selected = savedReportColumnKeys(reportType);
    const selectedSet = new Set(selected || defaultReportColumns(available, reportType).map((column, index) => reportColumnKey(column, index)));
    list.innerHTML = available.map((column, index) => {
      const key = reportColumnKey(column, index);
      const label = column.header || key;
      return `
        <label>
          <input type="checkbox" value="${escapeHtml(key)}" ${selectedSet.has(key) ? 'checked' : ''}>
          <span>${escapeHtml(label)}</span>
        </label>
      `;
    }).join('') || '<p class="muted">Submit a report first, then choose fields.</p>';
  }

  function openReportColumnSettings() {
    openReportFilterSettings();
  }

  function closeReportColumnSettings() {
    closeReportFilterSettings();
  }

  function compactParams(params) {
    return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== ''));
  }

  function reportFilterValue(value) {
    const text = String(value || '').trim();
    return /^all(\s|$)/i.test(text) ? '' : text;
  }

  function reportParams() {
    const form = $('#reportFilters');
    const formData = formObject(form);
    const reportType = activeReportType();
    const selectedDealerCode = reportFilterValue(cleanDealerCode($('[name="dealerCode"]', form)?.value || ''));
    const selectedDealer = state.dealers.find((dealer) => cleanDealerCode(dealer.dealerCode) === selectedDealerCode);
    const dealerCode = selectedDealer?.dealerCode || selectedDealerCode || '';
    const params = compactParams({
      reportType,
      dealerCode,
      auditId: reportFilterValue(formData.auditId),
      auditDate: reportFilterValue(formData.auditDate),
      fromDate: reportFilterValue(formData.fromDate),
      toDate: reportFilterValue(formData.toDate),
      category: reportFilterValue(formData.category),
      productCategory: ['category-wise-variance-summary', 'partwise-inventory-audit', 'stock-summary'].includes(reportType) ? reportFilterValue(formData.category) : undefined,
      model: reportFilterValue(formData.model),
      year: reportFilterValue(formData.year),
      partNumber: reportFilterValue(formData.partNumber),
      productGroup: reportFilterValue(formData.productGroup),
      partSubGroup: reportFilterValue(formData.partSubGroup),
      binLocation: reportFilterValue(formData.binLocation || formData.bin),
      scanType: reportFilterValue(formData.scanType),
      scanStatus: reportFilterValue(formData.scanStatus),
      userName: reportFilterValue(formData.userName),
      syncStatus: reportFilterValue(formData.syncStatus),
      upiRawQr: reportFilterValue(formData.upiRawQr),
      role: reportFilterValue(formData.role),
      deviceName: reportFilterValue(formData.deviceName),
      deviceId: reportFilterValue(formData.deviceId),
      entryMode: reportFilterValue(formData.entryMode),
      entryChannel: reportFilterValue(formData.entryChannel),
      entrySource: reportFilterValue(formData.entrySource),
      action: reportFilterValue(formData.action),
      status: reportFilterValue(formData.status),
      varianceType: reportFilterValue(formData.varianceType),
      showFullMasterWithZeroScan: formData.showFullMasterWithZeroScan === 'on' && formData.showScannedPartsOnly !== 'on' ? 'on' : undefined
    });
    console.log("Selected dealer value:", selectedDealerCode);
    console.log("Report params:", params);
    return params;
  }

  function reportPath(format) {
    const paramsObject = reportParams();
    const params = new URLSearchParams();
    Object.entries(paramsObject).forEach(([key, value]) => {
      if (key !== 'reportType') params.set(key, value);
    });
    params.delete('testScanMode');
    if (format) {
      const selectedColumns = currentReportColumnKeys(paramsObject.reportType || activeReportType());
      if (selectedColumns && selectedColumns.length) params.set('columns', selectedColumns.join(','));
    }
    if (format) params.set('format', format);
    const query = params.toString();
    const url = `/api/reports/${paramsObject.reportType || activeReportType()}${query ? `?${query}` : ''}`;
    console.log("Report API URL:", url);
    return url;
  }

  function reportCacheKey(url, reportType = activeReportType()) {
    return `${reportType || ''}|${url}`;
  }

  function rememberReportCache(key, data) {
    if (!key || !data) return;
    state.reportCache.set(key, {
      data,
      savedAt: Date.now()
    });
    if (state.reportCache.size > 12) {
      const oldestKey = state.reportCache.keys().next().value;
      state.reportCache.delete(oldestKey);
    }
  }

  function cachedReport(key) {
    const entry = state.reportCache.get(key);
    if (!entry) return null;
    return entry.data || null;
  }

  function applyReportData(data, reportType = activeReportType()) {
    $('#reportTitle').textContent = data.title || REPORT_TITLES[reportType];
    const rows = data.rows || [];
    console.log("Rows received:", rows.length);
    console.log("First row:", rows[0]);
    renderReportTable(data.columns || [], rows, data.totalRows, data.grandTotal, reportType);
    const message = $('#reportMessage');
    if (message) {
      message.className = rows.length ? 'form-message success' : 'form-message error';
      message.textContent = rows.length ? '' : (data.message || 'No report data found for selected filter');
    }
    state.reportLoaded = true;
    state.reportHasRun = true;
  }

  function partsRefreshTemplatePath() {
    const paramsObject = reportParams();
    const params = new URLSearchParams();
    Object.entries(paramsObject).forEach(([key, value]) => {
      if (key !== 'reportType') params.set(key, value);
    });
    params.delete('testScanMode');
    const query = params.toString();
    return `/api/reports/parts-inventory-refresh-template.csv${query ? `?${query}` : ''}`;
  }

  function partsRefreshTemplatePreviewPath() {
    const paramsObject = reportParams();
    const params = new URLSearchParams();
    Object.entries(paramsObject).forEach(([key, value]) => {
      if (key !== 'reportType') params.set(key, value);
    });
    params.delete('testScanMode');
    const query = params.toString();
    return `/api/reports/parts-inventory-refresh-template${query ? `?${query}` : ''}`;
  }

  function validateReportSelection(showToast = false) {
    const params = reportParams();
    if (params.reportType && !params.dealerCode) {
      const message = 'Select dealer code first to view report.';
      const box = $('#reportMessage');
      if (box) {
        box.className = 'form-message error';
        box.textContent = message;
      }
      if (showToast) toast(message, 'error');
      return false;
    }
    return true;
  }

  function reportDownloadName(extension) {
    return `${(REPORT_TITLES[activeReportType()] || 'Report').replace(/\s+/g, '_')}.${extension}`;
  }

  function updateReportButtons() {
    const reportType = activeReportType();
    const canShow = Boolean(reportType) && validateReportSelection(false);
    const isCsvReport = CSV_REPORT_TYPES.has(reportType);
    const isExcelOnlyReport = EXCEL_ONLY_REPORT_TYPES.has(reportType);
    $('#reportShow').disabled = !canShow || state.reportLoading;
    $('#reportRefresh').disabled = !canShow || state.reportLoading;
    $('#reportExcel').disabled = isCsvReport || !canShow || state.reportLoading;
    if ($('#reportPdf')) $('#reportPdf').disabled = isCsvReport || isExcelOnlyReport || !state.reportLoaded || state.reportLoading;
    if ($('#reportEmail')) $('#reportEmail').disabled = isCsvReport || isExcelOnlyReport || !state.reportLoaded || state.reportLoading;
  }

  function hasReportCriteria() {
    const params = reportParams();
    return Boolean(params.reportType);
  }

  function saveReportState(hasRun = state.reportHasRun) {
    const form = $('#reportFilters');
    if (!form) return;
    const params = reportParams();
    localStorage.setItem(REPORT_STATE_KEY, JSON.stringify({
      reportType: params.reportType || activeReportType(),
      filters: formObject(form),
      hasRun: Boolean(hasRun),
      scanModeDefaultVersion: REPORT_SCAN_MODE_DEFAULT_VERSION,
      savedAt: Date.now()
    }));
  }

  function restoreReportState() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(REPORT_STATE_KEY) || 'null');
    } catch (error) {
      saved = null;
    }
    if (!saved || !REPORT_TITLES[saved.reportType]) return false;
    setReportTab(saved.reportType, { persist: false });
    const form = $('#reportFilters');
    Object.entries(saved.filters || {}).forEach(([name, value]) => {
      const field = $(`[name="${CSS.escape(name)}"]`, form);
      if (!field) return;
      if (field.type === 'checkbox') field.checked = value === 'on' || value === true;
      else field.value = value;
    });
    if ((saved.scanModeDefaultVersion || 0) < REPORT_SCAN_MODE_DEFAULT_VERSION) {
      const scannedOnly = $('[name="showScannedPartsOnly"]', form);
      const fullMaster = $('[name="showFullMasterWithZeroScan"]', form);
      if (scannedOnly) scannedOnly.checked = false;
      if (fullMaster) fullMaster.checked = false;
    }
    applyReportScanModeDefaults();
    return Boolean(saved.hasRun);
  }

  function applyReportScanModeDefaults() {
    const form = $('#reportFilters');
    const scannedOnly = $('[name="showScannedPartsOnly"]', form);
    const fullMaster = $('[name="showFullMasterWithZeroScan"]', form);
    if (!scannedOnly || !fullMaster) return;
    if (scannedOnly.checked) fullMaster.checked = false;
    if (fullMaster.checked) scannedOnly.checked = false;
  }

  function resetReportPreview(message = 'Please select filters and click Submit.') {
    state.reportLoaded = false;
    state.reportHasRun = false;
    state.reportTableRows = [];
    state.reportTableColumns = [];
    state.reportTableTotalRows = 0;
    state.reportTableGrandTotal = null;
    $('#reportHead').innerHTML = '';
    $('#reportRows').innerHTML = '';
    if ($('#reportTableSearch')) $('#reportTableSearch').value = '';
    setText('reportCount', '0 rows');
    const box = $('#reportMessage');
    if (box) {
      box.className = 'form-message';
      box.textContent = message;
    }
    updateReportButtons();
  }

  function columnsForRows(rows) {
    const preferred = ['partNumber', 'partNo', 'partNum', 'partDescription', 'productCategory', 'category', 'mrp', 'dlc', 'productGroup', 'partSubGroup', 'model', 'manufacturingYear', 'year', 'binLocation', 'bin', 'systemQty', 'systemQuantity', 'physicalQty', 'physicalQuantity', 'totalPhysicalQty', 'differenceQty', 'varianceQuantity', 'status'];
    const keys = Object.keys(rows[0] || {}).filter((key) => !key.startsWith('_'));
    const sorted = preferred.filter((key) => keys.includes(key)).concat(keys.filter((key) => !preferred.includes(key)));
    return sorted.slice(0, 14).map((key) => ({ key, header: key.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase()) }));
  }

  function reportColumnKey(column, index) {
    return column.key || `col${index}`;
  }

  function reportLayoutStorageKey(reportType = activeReportType()) {
    return REPORT_LAYOUT_KEYS[reportType] || `${String(reportType || 'default').replace(/[^a-z0-9]+/gi, '_').toLowerCase()}_report_layout`;
  }

  function defaultReportLayout() {
    return { layout: 'full', width: '100%', height: 'calc(100vh - 360px)', columnWidths: {}, columnOrder: [] };
  }

  function reportColumnPrefs() {
    return readReportLayoutPrefs().columnWidths || {};
  }

  function saveReportColumnWidth(reportType, key, width) {
    const prefs = readReportLayoutPrefs();
    const columnWidths = { ...(prefs.columnWidths || {}) };
    columnWidths[key] = Math.max(70, Math.round(width));
    saveReportLayoutPrefs({ columnWidths });
  }

  function reportTableTotalWidth(table = $('#reportTable')) {
    if (!table) return 0;
    return $$('col', table).reduce((sum, item) => sum + (Number.parseFloat(item.style.width) || 120), 0);
  }

  function applyReportTableWidth(table = $('#reportTable')) {
    if (!table) return 0;
    const total = reportTableTotalWidth(table);
    if (total) {
      table.style.minWidth = `${Math.round(total)}px`;
      table.style.setProperty('--report-table-width', `${Math.round(total)}px`);
    }
    return total;
  }

  function setReportColumnWidth(index, width) {
    const table = $('#reportTable');
    const th = $(`#reportHead th[data-col-index="${index}"]`);
    const col = $(`col[data-col-index="${index}"]`, table);
    const nextWidth = Math.max(70, Math.round(width));
    if (th) th.style.width = `${nextWidth}px`;
    if (col) {
      col.style.width = `${nextWidth}px`;
      col.style.minWidth = '70px';
    }
    applyReportTableWidth(table);
    return nextWidth;
  }

  function measureReportColumnAutoWidth(index) {
    const th = $(`#reportHead th[data-col-index="${index}"]`);
    if (!th) return 120;
    const measurer = document.createElement('span');
    const headerStyle = window.getComputedStyle(th);
    measurer.style.position = 'fixed';
    measurer.style.left = '-9999px';
    measurer.style.top = '-9999px';
    measurer.style.visibility = 'hidden';
    measurer.style.whiteSpace = 'nowrap';
    measurer.style.font = headerStyle.font;
    document.body.appendChild(measurer);
    const measure = (text, font) => {
      measurer.style.font = font;
      measurer.textContent = String(text || '').trim();
      return Math.ceil(measurer.getBoundingClientRect().width);
    };
    let width = measure(th.querySelector('.report-th-content')?.textContent || th.textContent || '', headerStyle.font);
    $$('#reportRows tr').forEach((row) => {
      const cell = row.children[index];
      if (!cell || cell.colSpan > 1) return;
      const style = window.getComputedStyle(cell);
      width = Math.max(width, measure(cell.textContent || '', style.font));
    });
    measurer.remove();
    const padding = 34;
    const key = th.dataset.colKey || '';
    const maxWidth = isDescriptionReportColumn(key) || /raw/i.test(key) ? 560 : 420;
    return Math.max(70, Math.min(maxWidth, width + padding));
  }

  function autoFitReportColumn(index, key, reportType = activeReportType()) {
    if (!Number.isFinite(index)) return;
    const width = setReportColumnWidth(index, measureReportColumnAutoWidth(index));
    if (key) saveReportColumnWidth(reportType, key, width);
    refreshReportTableLayout();
  }

  function reportColumnOrder() {
    const order = readReportLayoutPrefs().columnOrder;
    return Array.isArray(order) ? order : [];
  }

  function applyReportColumnOrder(columns, reportType = activeReportType()) {
    const order = reportColumnOrder(reportType);
    if (!order.length) return columns;
    const byKey = new Map(columns.map((column, index) => [reportColumnKey(column, index), column]));
    return order.map((key) => byKey.get(key)).filter(Boolean).concat(columns.filter((column, index) => !order.includes(reportColumnKey(column, index))));
  }

  function saveReportColumnOrder(keys) {
    saveReportLayoutPrefs({ columnOrder: keys });
  }

  function isDescriptionReportColumn(key) {
    return /description|category|productGroup|partSubGroup|subGroup|name|reason|rawScannedValue|rawScan/i.test(key || '');
  }

  function isPartNumberColumn(key) {
    return /part(Number|No|Num)$|^part$|extractedPartNumber/i.test(key || '');
  }

  function isDeviceColumn(key) {
    return /device(Id|Name)?$|scanner/i.test(key || '');
  }

  function reportCellHref(column, row, displayValue) {
    const key = column.key || '';
    const rawValue = row[key];
    const value = String(rawValue ?? displayValue ?? '').trim();
    if (!value || value === '-') return '';
    if (isPartNumberColumn(key)) return dashboardHref({ view: 'master', partNumber: value });
    if (/deviceId$/i.test(key)) return dashboardHref({ view: 'devices', deviceId: value });
    if (/deviceName$|scanner/i.test(key)) return dashboardHref({ view: 'devices', deviceId: row.deviceId || value });
    if (/audit(Id|Name)?$/i.test(key)) return dashboardHref({ view: 'reports', auditId: value });
    if (/report/i.test(key)) return dashboardHref({ view: 'reports', reportType: value });
    return '';
  }

  function reportCellContent(column, row, displayValue) {
    const href = reportCellHref(column, row, displayValue);
    const className = `table-link ${isPartNumberColumn(column.key || '') ? 'part-link' : ''}`.trim();
    return href ? enterpriseLink(displayValue, href, { className, label: `Open ${column.header || column.key || 'record'} ${displayValue} in a new tab` }) : escapeHtml(displayValue);
  }

  function reportColumnWidth(column, index, reportType = activeReportType()) {
    const key = reportColumnKey(column, index);
    const saved = Number(reportColumnPrefs()[key] || 0);
    if (saved >= 70) return saved;
    if (reportType === 'category-wise-variance-summary') {
      const categoryVarianceWidths = {
        productCategory: 230,
        action: 180,
        totalScannedParts: 150,
        totalScannedQuantity: 175,
        sumPhysicalValueOnMRP: 220,
        sumPhysicalValueOnDLC: 220,
        sumVarianceOnMRP: 190,
        sumVarianceOnDLC: 190
      };
      if (categoryVarianceWidths[key]) return categoryVarianceWidths[key];
    }
    if (/^select$/i.test(key)) return 44;
    if (/raw.*scan|rawScannedValue/i.test(key)) return 320;
    if (/scanDetails/i.test(key)) return 360;
    if (/scanCount/i.test(key)) return 90;
    if (/device/i.test(key)) return 220;
    if (/dealerName/i.test(key)) return 190;
    if (/dealerCode/i.test(key)) return 100;
    if (/^(qty|quantity|availableQty|physicalQty|systemQty|differenceQty|varianceQuantity)$/i.test(key)) return 70;
    if (/^(mrp|dlc)$/i.test(key)) return 100;
    if (/scanType|^type$/i.test(key)) return 110;
    if (/binLocation|^bin$/i.test(key)) return 110;
    if (/syncStatus|status/i.test(key)) return 110;
    if (isDateReportColumn(key)) return 210;
    if (isNumericReportColumn(key)) return 100;
    if (isDescriptionReportColumn(key)) return /description/i.test(key) ? 240 : 180;
    if (isPartNumberColumn(key)) return 150;
    return 145;
  }

  function reportColumnClass(column, index) {
    const key = reportColumnKey(column, index);
    if (isNumericReportColumn(key)) return 'numeric-header';
    if (isDescriptionReportColumn(key)) return 'description-header';
    if (isPartNumberColumn(key)) return 'part-header';
    return '';
  }

  function activeReportSort(reportType = activeReportType()) {
    return state.reportSort.reportType === reportType ? state.reportSort : { reportType, key: '', direction: 'asc' };
  }

  function reportSortValue(row, column) {
    const key = column.key || '';
    const value = row ? row[key] : '';
    if (value === null || value === undefined || value === '') return { empty: true, value: '' };
    if (typeof value === 'number') return { empty: false, type: 'number', value };
    const text = String(value).trim();
    if (!text) return { empty: true, value: '' };
    const number = Number(text.replace(/,/g, ''));
    if ((isNumericReportColumn(key) || /^-?\d[\d,]*(\.\d+)?$/.test(text)) && !Number.isNaN(number)) {
      return { empty: false, type: 'number', value: number };
    }
    if (isDateReportColumn(key)) {
      const time = Date.parse(text);
      if (!Number.isNaN(time)) return { empty: false, type: 'number', value: time };
    }
    return { empty: false, type: 'text', value: text.toLowerCase(), text };
  }

  function sortReportRows(rows, columns, reportType = activeReportType()) {
    const sort = activeReportSort(reportType);
    if (!sort.key) return rows || [];
    const column = (columns || []).find((item, index) => reportColumnKey(item, index) === sort.key);
    if (!column) return rows || [];
    const direction = sort.direction === 'desc' ? -1 : 1;
    return (rows || []).map((row, index) => ({ row, index })).sort((a, b) => {
      const left = reportSortValue(a.row, column);
      const right = reportSortValue(b.row, column);
      if (left.empty && right.empty) return a.index - b.index;
      if (left.empty) return 1;
      if (right.empty) return -1;
      let result = 0;
      if (left.type === 'number' && right.type === 'number') {
        result = left.value - right.value;
      } else {
        result = String(left.text || left.value).localeCompare(String(right.text || right.value), undefined, { numeric: true, sensitivity: 'base' });
      }
      return result === 0 ? a.index - b.index : result * direction;
    }).map((item) => item.row);
  }

  function reportRowsForDisplay(rows, columns, reportType = activeReportType()) {
    return sortReportRows(reportVisibleRows(rows), columns, reportType);
  }

  function reportCellClass(column, value) {
    const key = column.key || '';
    const isNumber = typeof value === 'number' || (isNumericReportColumn(key) && value !== '' && value !== null && !Number.isNaN(Number(value)));
    return [
      isNumber ? 'numeric-cell number-cell' : '',
      isDescriptionReportColumn(key) ? 'description-cell' : '',
      isPartNumberColumn(key) ? 'part-cell' : '',
      key.toLowerCase().includes('raw') ? 'raw-cell' : ''
    ].filter(Boolean).join(' ');
  }

  function isDateReportColumn(key) {
    return /date|time|timestamp|createdAt|updatedAt/i.test(key || '');
  }

  function formatReportCellValue(column, value) {
    const key = column.key || '';
    if (isDateReportColumn(key) && value) return dateTime(value) || value;
    const isNumber = typeof value === 'number' || (isNumericReportColumn(key) && value !== '' && value !== null && !Number.isNaN(Number(value)));
    return isNumber ? money2(value) : value;
  }

  function renderReportHeader(keys, reportType = activeReportType()) {
    const widths = keys.map((column, index) => reportColumnWidth(column, index, reportType));
    const table = $('#reportTable');
    const wrap = $('#reportTableWrap');
    const sort = activeReportSort(reportType);
    if (table) table.dataset.reportType = reportType || '';
    if (wrap) wrap.dataset.reportType = reportType || '';
    let colgroup = $('colgroup', table);
    if (!colgroup) {
      colgroup = document.createElement('colgroup');
      table.insertBefore(colgroup, table.firstChild);
    }
    colgroup.innerHTML = widths.map((width, index) => {
      const key = reportColumnKey(keys[index], index);
      return `<col data-col-index="${index}" data-col-key="${escapeHtml(key)}" style="width:${width}px;min-width:70px">`;
    }).join('');
    applyReportTableWidth(table);
    $('#reportHead').innerHTML = `<tr>${keys.map((column, index) => {
      const key = reportColumnKey(column, index);
      const width = widths[index];
      const isSorted = sort.key === key;
      const direction = isSorted ? (sort.direction === 'desc' ? 'descending' : 'ascending') : 'none';
      const sortLabel = isSorted ? (sort.direction === 'desc' ? 'Sorted high to low' : 'Sorted low to high') : 'Not sorted';
      return `<th class="${reportColumnClass(column, index)} ${isSorted ? `sorted-${escapeHtml(sort.direction)}` : ''}" draggable="true" data-col-index="${index}" data-col-key="${escapeHtml(key)}" aria-sort="${escapeHtml(direction)}" style="width:${width}px"><button type="button" class="report-sort-button" title="Sort ${escapeHtml(column.header)}" aria-label="Sort ${escapeHtml(column.header)}"><span class="report-th-content">${escapeHtml(column.header)}</span><span class="sr-only">${escapeHtml(sortLabel)}</span></button><span class="report-col-resize" role="separator" aria-label="Resize column. Double click to auto fit."></span></th>`;
    }).join('')}</tr>`;
  }

  function refreshReportTableLayout() {
    const wrap = $('#reportTableWrap');
    const table = $('#reportTable');
    if (!wrap || !table) return;
    table.style.tableLayout = 'fixed';
    applyReportTableWidth(table);
    requestAnimationFrame(() => {
      const maxLeft = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
      wrap.scrollLeft = Math.min(maxLeft, Math.max(0, wrap.scrollLeft));
    });
  }

  function reportVisibleRows(rows) {
    const search = ($('#reportTableSearch')?.value || '').trim().toLowerCase();
    if (!search) return rows || [];
    return (rows || []).filter((row) => Object.values(row).some((value) => String(value ?? '').toLowerCase().includes(search)));
  }

  function renderReportTable(columns, rows, totalRows, grandTotal, reportType = activeReportType()) {
    state.reportTableRows = rows || [];
    state.reportTableColumns = columns || [];
    state.reportTableTotalRows = totalRows || rows.length;
    state.reportTableGrandTotal = grandTotal || null;
    if (reportType === 'category-wise-variance-summary') {
      renderCategoryWiseVarianceTable(rows, totalRows, grandTotal, reportType);
      return;
    }
    if (reportType === 'stock-summary') {
      renderStockSummaryTable(columns, rows, totalRows, reportType);
      return;
    }
    if (reportType === 'partwise-inventory-audit') {
      renderPartwiseInventoryAuditTable(columns, rows, totalRows, reportType);
      return;
    }
    const keys = reportColumnsForDisplay(columns, rows, reportType, 18);
    const visibleRows = reportRowsForDisplay(rows, keys, reportType);
    const pageRows = visibleRows.slice(0, 500);
    renderReportHeader(keys, reportType);
    $('#reportRows').innerHTML = pageRows.map((row) => `
      <tr>${keys.map((column) => {
        const value = formatReportCellValue(column, row[column.key]);
        const isNumber = reportCellClass(column, row[column.key]).includes('numeric-cell');
        return `<td class="${reportCellClass(column, row[column.key])}" data-type="${isNumber ? 'number' : 'text'}" title="${escapeHtml(value)}">${reportCellContent(column, row, value)}</td>`;
      }).join('')}</tr>
    `).join('');
    setText('reportCount', `${pageRows.length} shown${visibleRows.length !== pageRows.length ? ` of ${visibleRows.length}` : ''}${totalRows ? ` | ${totalRows} total` : ''}`);
    refreshReportTableLayout();
    enhanceCoreTables();
  }

  function isNumericReportColumn(key) {
    return /qty|quantity|mrp|dlc|value|variance|sale/i.test(key || '');
  }

  function statusBadge(status) {
    const sync = normalizedDisplaySyncStatus({ syncStatus: status });
    if (sync) return syncStatusBadge(sync);
    const normalized = String(status || '').toUpperCase();
    const cls = normalized.replace(/\s+/g, '-').toLowerCase();
    return `<span class="report-status-badge ${cls}">${escapeHtml(status || '')}</span>`;
  }

  function renderPartwiseInventoryAuditTable(columns, rows, totalRows, reportType = activeReportType()) {
    const keys = reportColumnsForDisplay(columns, rows, reportType, 0);
    const visibleRows = reportRowsForDisplay(rows, keys, reportType);
    const pageRows = visibleRows.slice(0, 500);
    renderReportHeader(keys, reportType);
    $('#reportRows').innerHTML = pageRows.map((row) => `
      <tr>${keys.map((column) => {
        const value = row[column.key];
        const isNumber = typeof value === 'number' || (isNumericReportColumn(column.key) && value !== '' && value !== null && !Number.isNaN(Number(value)));
        const text = isNumber ? money2(value) : (isDateReportColumn(column.key) && value ? dateTime(value) || value : value);
        const cell = column.key === 'status' ? statusBadge(value) : reportCellContent(column, row, text);
        return `<td class="${reportCellClass(column, value)}" data-type="${isNumber ? 'number' : 'text'}" title="${escapeHtml(text)}">${cell}</td>`;
      }).join('')}</tr>
    `).join('');
    setText('reportCount', `${pageRows.length} shown${visibleRows.length !== pageRows.length ? ` of ${visibleRows.length}` : ''}${totalRows ? ` | ${totalRows} total` : ''}`);
    refreshReportTableLayout();
    enhanceCoreTables();
  }

  function renderCategoryWiseVarianceTable(rows, totalRows, grandTotal, reportType = activeReportType()) {
    const keys = reportColumnsForDisplay(state.reportTableColumns && state.reportTableColumns.length ? state.reportTableColumns : [
      { header: 'Product Category', key: 'productCategory' },
      { header: 'Action / Scan Type', key: 'action' },
      { header: 'Total Scanned Parts', key: 'totalScannedParts' },
      { header: 'Total Scanned Quantity', key: 'totalScannedQuantity' },
      { header: 'Sum of Physical Value On MRP', key: 'sumPhysicalValueOnMRP' },
      { header: 'Sum of Physical Value On DLC', key: 'sumPhysicalValueOnDLC' },
      { header: 'Sum of Variance On MRP', key: 'sumVarianceOnMRP' },
      { header: 'Sum of Variance On DLC', key: 'sumVarianceOnDLC' }
    ], rows, reportType, 0);
    const filteredRows = reportRowsForDisplay(rows, keys, reportType);
    renderReportHeader(keys, reportType);
    let lastCategory = '';
    const pageRows = filteredRows.slice(0, 500);
    const bodyRows = pageRows.map((row) => {
      const isSubtotal = row.rowType === 'subtotal';
      const category = String(row.productCategory || '');
      const baseCategory = category.replace(/\s+TOTAL$/i, '');
      const showCategory = isSubtotal || baseCategory !== lastCategory;
      if (!isSubtotal) lastCategory = baseCategory;
      return `
        <tr class="${isSubtotal ? 'category-total-row' : ''}">
          ${keys.map((column) => {
            const value = column.key === 'productCategory' && !showCategory ? '' : row[column.key];
            const isNumber = isNumericReportColumn(column.key) || column.key === 'totalScannedParts';
            const text = isNumber ? money2(value) : (value || '');
            return `<td class="${column.key === 'productCategory' && showCategory ? 'category-first-cell' : ''} ${isNumber ? 'numeric-cell number-cell' : reportCellClass(column, value)}" data-type="${isNumber ? 'number' : 'text'}">${reportCellContent(column, row, text)}</td>`;
          }).join('')}
        </tr>
      `;
    }).join('');
    const totals = grandTotal || rows.reduce((total, row) => {
      if (row.rowType === 'subtotal') {
        total.totalScannedParts += Number(row.totalScannedParts || 0);
        total.totalScannedQuantity += Number(row.totalScannedQuantity || 0);
        total.sumPhysicalValueOnMRP += Number(row.sumPhysicalValueOnMRP || 0);
        total.sumPhysicalValueOnDLC += Number(row.sumPhysicalValueOnDLC || 0);
        total.sumVarianceOnMRP += Number(row.sumVarianceOnMRP || 0);
        total.sumVarianceOnDLC += Number(row.sumVarianceOnDLC || 0);
      }
      return total;
    }, { totalScannedParts: 0, totalScannedQuantity: 0, sumPhysicalValueOnMRP: 0, sumPhysicalValueOnDLC: 0, sumVarianceOnMRP: 0, sumVarianceOnDLC: 0 });
    $('#reportRows').innerHTML = `${bodyRows}
      <tr class="grand-total-row">
        ${keys.map((column) => {
          if (column.key === 'productCategory') return '<td>Grand Total</td>';
          if (column.key === 'action') return '<td></td>';
          const isNumber = isNumericReportColumn(column.key) || column.key === 'totalScannedParts';
          return `<td class="${isNumber ? 'numeric-cell number-cell' : ''}" data-type="${isNumber ? 'number' : 'text'}">${escapeHtml(isNumber ? money2(totals[column.key]) : (totals[column.key] || ''))}</td>`;
        }).join('')}
      </tr>
    `;
    setText('reportCount', `${pageRows.length} shown${filteredRows.length !== pageRows.length ? ` of ${filteredRows.length}` : ''}${totalRows ? ` | ${totalRows} total` : ''}`);
    refreshReportTableLayout();
    enhanceCoreTables();
  }

  function renderStockSummaryTable(columns, rows, totalRows, reportType = activeReportType()) {
    const keys = reportColumnsForDisplay(columns && columns.length ? columns : [
      { header: 'Report Section', key: 'section' },
      { header: 'Mismatch Cases / Metric', key: 'metric' },
      { header: 'SKU Counts', key: 'skuCount' },
      { header: 'Value On MRP', key: 'valueOnMrp' },
      { header: 'Value On DLC', key: 'valueOnDlc' },
      { header: '% of Opening Stock On MRP', key: 'percentMrp' },
      { header: '% of Opening Stock On DLC', key: 'percentDlc' }
    ], rows, reportType, 0);
    const filteredRows = reportRowsForDisplay(rows, keys, reportType);
    renderReportHeader(keys, reportType);
    const pageRows = filteredRows.slice(0, 500);
    $('#reportRows').innerHTML = pageRows.map((row) => {
      if (row.rowType === 'gap') return `<tr class="stock-summary-gap-row"><td colspan="${keys.length}"></td></tr>`;
      if (row.rowType === 'note') return `<tr class="stock-summary-note-row"><td colspan="${keys.length}">${escapeHtml(row.note || row.section || '')}</td></tr>`;
      const cls = row.rowType === 'section' ? 'stock-summary-section-row' : row.rowType === 'total' || row.rowType === 'net' ? 'stock-summary-total-row' : '';
      return `
        <tr class="${cls}">
          ${keys.map((column) => {
            const value = row[column.key];
            const isPercent = /^percent/i.test(column.key);
            const isNumber = isPercent || ['skuCount', 'valueOnMrp', 'valueOnDlc'].includes(column.key);
            const isBlank = value === undefined || value === null || value === '';
            const text = isBlank ? '' : isPercent ? percent2(value) : (column.key === 'skuCount' ? Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 }) : (isNumber ? money2(value) : (value || '')));
            return `<td class="${isNumber ? 'numeric-cell number-cell' : reportCellClass(column, value)}" data-type="${isNumber ? 'number' : 'text'}" title="${escapeHtml(text)}">${reportCellContent(column, row, text)}</td>`;
          }).join('')}
        </tr>
      `;
    }).join('');
    setText('reportCount', `${pageRows.length} shown${filteredRows.length !== pageRows.length ? ` of ${filteredRows.length}` : ''}${totalRows ? ` | ${totalRows} total` : ''}`);
    refreshReportTableLayout();
    enhanceCoreTables();
  }

  async function loadReport(options = {}) {
    const useCache = options.useCache !== false;
    const forceRefresh = options.forceRefresh === true;
    const showLoading = options.showLoading !== false;
    const reportType = activeReportType();
    if (!reportType) {
      resetReportPreview('Select report type, choose filters and click Submit.');
      return;
    }
    if (!validateReportSelection(true)) {
      state.reportHasRun = false;
      return;
    }
    if (!hasReportCriteria()) {
      resetReportPreview('Please select filters and click Submit.');
      state.reportHasRun = false;
      return;
    }
    console.log("Selected report:", reportType);
    const url = CSV_REPORT_TYPES.has(reportType) ? partsRefreshTemplatePreviewPath() : reportPath();
    const cacheKey = reportCacheKey(url, reportType);
    const cached = !forceRefresh && useCache ? cachedReport(cacheKey) : null;
    if (cached) {
      if (state.reportAbortController) state.reportAbortController.abort();
      state.reportLoading = false;
      state.reportAbortController = null;
      state.lastReportType = reportType;
      saveReportState(true);
      applyReportData(cached, reportType);
      updateReportButtons();
      return;
    }
    const message = $('#reportMessage');
    const requestId = Date.now();
    state.reportLoadRequestId = requestId;
    if (state.reportAbortController) state.reportAbortController.abort();
    state.reportAbortController = new AbortController();
    state.reportLoading = true;
    state.lastReportType = reportType;
    saveReportState(true);
    $('#reportTitle').textContent = REPORT_TITLES[reportType];
    if (showLoading && message) {
      message.className = 'form-message loading';
      message.textContent = 'Loading report...';
    }
    if (showLoading && !state.reportLoaded) {
      $('#reportHead').innerHTML = '';
      $('#reportRows').innerHTML = '<tr><td class="muted" colspan="12">Loading report...</td></tr>';
      setText('reportCount', 'Loading...');
    }
    $('#reportShow').disabled = true;
    try {
      const data = await api(url, { signal: state.reportAbortController.signal });
      if (state.reportLoadRequestId !== requestId) return;
      rememberReportCache(cacheKey, data);
      applyReportData(data, reportType);
    } catch (error) {
      if (state.reportLoadRequestId !== requestId) return;
      if (error.name === 'AbortError') return;
      state.reportLoaded = Boolean(state.reportTableRows.length);
      state.reportHasRun = Boolean(state.reportTableRows.length);
      if (!state.reportTableRows.length) {
        $('#reportRows').innerHTML = `<tr><td class="muted" colspan="12">${escapeHtml(error.message || 'Report API failed')}</td></tr>`;
        setText('reportCount', '0 rows');
      }
      if (message) {
        message.className = 'form-message error';
        message.textContent = error.message || 'Report API failed';
      }
      toast(error.message || 'Report API failed', 'error');
    } finally {
      if (state.reportLoadRequestId === requestId) {
        state.reportLoading = false;
        state.reportAbortController = null;
      }
      updateReportButtons();
    }
  }

  function setReportTab(type, options = {}) {
    if (!REPORT_TITLES[type]) return;
    state.lastReportType = type;
    if ($('#reportTypeSelect')) $('#reportTypeSelect').value = type;
    $$('.report-tab').forEach((button) => button.classList.toggle('active', button.dataset.reportType === type));
    $('#reportTitle').textContent = REPORT_TITLES[type];
    ensureActiveReportTabVisible();
    applyReportScanModeDefaults();
    loadReportFilterSettings(type).catch((error) => console.warn('Report filter settings failed', error));
    resetReportPreview(CSV_REPORT_TYPES.has(type) ? 'Click Submit to view rows.' : 'Please select filters and click Submit.');
    if (options.persist !== false) saveReportState(false);
  }

  function readReportTabWidths() {
    try {
      return JSON.parse(sessionStorage.getItem(REPORT_TAB_WIDTHS_KEY) || '{}') || {};
    } catch (error) {
      return {};
    }
  }

  function saveReportTabWidth(type, width) {
    try {
      const widths = readReportTabWidths();
      widths[type] = Math.max(88, Math.round(width));
      sessionStorage.setItem(REPORT_TAB_WIDTHS_KEY, JSON.stringify(widths));
    } catch (error) {
      console.warn('Report tab width not saved', error.message);
    }
  }

  function measureTabText(button) {
    const measurer = document.createElement('span');
    const style = window.getComputedStyle(button);
    measurer.style.position = 'fixed';
    measurer.style.left = '-9999px';
    measurer.style.top = '-9999px';
    measurer.style.visibility = 'hidden';
    measurer.style.whiteSpace = 'nowrap';
    measurer.style.font = style.font;
    measurer.textContent = button.textContent || '';
    document.body.appendChild(measurer);
    const width = Math.ceil(measurer.getBoundingClientRect().width) + 34;
    measurer.remove();
    return Math.min(280, Math.max(88, width));
  }

  function autoFitReportTab(button) {
    if (!button) return;
    const width = measureTabText(button);
    button.style.setProperty('--report-tab-width', `${width}px`);
    saveReportTabWidth(button.dataset.reportType, width);
    ensureTabVisible(button);
  }

  function ensureTabVisible(button) {
    const scroller = $('#reportTabsScroller');
    if (!scroller || !button) return;
    const left = button.offsetLeft;
    const right = left + button.offsetWidth;
    if (left < scroller.scrollLeft) scroller.scrollLeft = left;
    if (right > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = right - scroller.clientWidth;
  }

  function ensureActiveReportTabVisible() {
    ensureTabVisible($('.report-tab.active'));
  }

  function scrollReportTabs(direction) {
    const scroller = $('#reportTabsScroller');
    if (!scroller) return;
    const amount = Math.max(180, Math.floor(scroller.clientWidth * 0.75));
    const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    const nextLeft = Math.min(maxLeft, Math.max(0, scroller.scrollLeft + direction * amount));
    scroller.scrollTo({ left: nextLeft, behavior: 'smooth' });
  }

  function initReportTabs() {
    const scroller = $('#reportTabsScroller');
    if (!scroller) {
      setReportTab(activeReportType() || state.lastReportType || Object.keys(REPORT_TITLES)[0], { persist: false });
      return;
    }
    const widths = readReportTabWidths();
    scroller.innerHTML = Object.entries(REPORT_TITLES).map(([type, title]) => {
      const width = Number(widths[type] || 0);
      const style = width ? ` style="--report-tab-width:${width}px"` : '';
      return `<button class="report-tab" type="button" role="tab" data-report-type="${escapeHtml(type)}" title="${escapeHtml(title)}"${style}>${escapeHtml(title)}</button>`;
    }).join('');
    $$('.report-tab', scroller).forEach((button) => {
      button.addEventListener('click', () => setReportTab(button.dataset.reportType));
      button.addEventListener('dblclick', () => autoFitReportTab(button));
    });
    $('#reportTabsLeft')?.addEventListener('click', () => scrollReportTabs(-1));
    $('#reportTabsRight')?.addEventListener('click', () => scrollReportTabs(1));
    scroller.addEventListener('wheel', (event) => {
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      event.preventDefault();
      const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      scroller.scrollLeft = Math.min(maxLeft, Math.max(0, scroller.scrollLeft + delta));
    }, { passive: false });
    setReportTab(activeReportType() || state.lastReportType || Object.keys(REPORT_TITLES)[0], { persist: false });
  }

  function readReportLayoutPrefs() {
    try {
      const specific = localStorage.getItem(reportLayoutStorageKey());
      if (specific) return { ...defaultReportLayout(), ...JSON.parse(specific) };
      return { ...defaultReportLayout(), ...JSON.parse(localStorage.getItem(REPORT_LAYOUT_KEY) || '{}') };
    } catch (error) {
      return defaultReportLayout();
    }
  }

  function saveReportLayoutPrefs(prefs) {
    localStorage.setItem(reportLayoutStorageKey(), JSON.stringify({ ...readReportLayoutPrefs(), ...prefs }));
  }

  function applyReportLayout(layout, dimensions = {}) {
    const reports = $('#reports');
    const card = $('#reportPreviewCard');
    const wrap = $('#reportTableWrap');
    if (!reports || !card || !wrap) return;
    reports.classList.remove('report-layout-full', 'report-layout-compact', 'report-layout-split', 'report-layout-drag');
    reports.classList.add(`report-layout-${layout}`);
    $$('.report-layout-btn').forEach((button) => button.classList.toggle('active', button.dataset.reportLayout === layout));
    card.style.width = dimensions.width || (layout === 'compact' ? '72%' : layout === 'split' ? '100%' : '100%');
    wrap.style.height = dimensions.height || (layout === 'compact' ? '440px' : 'calc(100vh - 360px)');
    saveReportLayoutPrefs({ layout, width: card.style.width, height: wrap.style.height });
    refreshReportTableLayout();
  }

  function resetReportLayout() {
    const prefs = readReportLayoutPrefs();
    saveReportLayoutPrefs({ ...prefs, layout: 'full', width: '100%', height: 'calc(100vh - 360px)' });
    applyReportLayout('full', { width: '100%', height: 'calc(100vh - 360px)' });
    if (state.reportTableRows.length || state.reportTableColumns.length) {
      renderReportTable(state.reportTableColumns, state.reportTableRows, state.reportTableTotalRows, state.reportTableGrandTotal, activeReportType());
    }
  }

  function resetReportColumns() {
    saveReportLayoutPrefs({ ...readReportLayoutPrefs(), columnOrder: [], columnWidths: {} });
    localStorage.removeItem(`daksh_table_report_${activeReportType() || 'default'}`);
    if (state.reportTableRows.length || state.reportTableColumns.length) {
      renderReportTable(state.reportTableColumns, state.reportTableRows, state.reportTableTotalRows, state.reportTableGrandTotal, activeReportType());
    }
  }

  function saveCurrentReportLayout() {
    const card = $('#reportPreviewCard');
    const wrap = $('#reportTableWrap');
    const columnWidths = {};
    $$('th[data-col-key]', $('#reportHead')).forEach((th) => {
      columnWidths[th.dataset.colKey] = Math.max(80, Math.round(th.getBoundingClientRect().width));
    });
    const columnOrder = $$('th[data-col-key]', $('#reportHead')).map((th) => th.dataset.colKey).filter(Boolean);
    saveReportLayoutPrefs({
      ...readReportLayoutPrefs(),
      width: card?.style.width || '100%',
      height: wrap?.style.height || 'calc(100vh - 360px)',
      columnWidths,
      columnOrder
    });
    toast('Report layout saved');
  }

  function initReportLayout() {
    const prefs = readReportLayoutPrefs();
    applyReportLayout(prefs.layout || 'full', prefs);
    $$('.report-layout-btn').forEach((button) => {
      button.addEventListener('click', () => applyReportLayout(button.dataset.reportLayout));
    });
    $('#reportSaveLayout')?.addEventListener('click', saveCurrentReportLayout);
    $('#reportResetSize')?.addEventListener('click', resetReportLayout);
    $('#reportResetColumns')?.addEventListener('click', resetReportColumns);
    const handle = $('#reportResizeHandle');
    const card = $('#reportPreviewCard');
    const wrap = $('#reportTableWrap');
    if (!handle || !card || !wrap) return;
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      applyReportLayout('drag', readReportLayoutPrefs());
      const startX = event.clientX;
      const startY = event.clientY;
      const startWidth = card.getBoundingClientRect().width;
      const startHeight = wrap.getBoundingClientRect().height;
      const maxWidth = Math.max(360, $('#reports').getBoundingClientRect().width);
      const onMove = (moveEvent) => {
        const width = Math.max(420, Math.min(maxWidth, startWidth + moveEvent.clientX - startX));
        const height = Math.max(260, startHeight + moveEvent.clientY - startY);
        card.style.width = `${Math.round(width)}px`;
        wrap.style.height = `${Math.round(height)}px`;
        refreshReportTableLayout();
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        saveReportLayoutPrefs({ layout: 'drag', width: card.style.width, height: wrap.style.height });
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
    $('#reportHead')?.addEventListener('pointerdown', (event) => {
      const grip = event.target.closest('.report-col-resize');
      if (!grip) return;
      event.preventDefault();
      const th = grip.closest('th');
      const index = Number(th.dataset.colIndex);
      const key = th.dataset.colKey || `col${index}`;
      const table = $('#reportTable');
      const col = $(`col[data-col-index="${index}"]`, table);
      const startX = event.clientX;
      const startWidth = th.getBoundingClientRect().width;
      const reportType = activeReportType();
      const onMove = (moveEvent) => {
        const width = Math.max(70, startWidth + moveEvent.clientX - startX);
        th.style.width = `${Math.round(width)}px`;
        if (col) col.style.width = `${Math.round(width)}px`;
        applyReportTableWidth(table);
      };
      const onUp = (upEvent) => {
        const width = Math.max(70, startWidth + upEvent.clientX - startX);
        saveReportColumnWidth(reportType, key, width);
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        refreshReportTableLayout();
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
    $('#reportHead')?.addEventListener('dblclick', (event) => {
      const grip = event.target.closest('.report-col-resize');
      if (!grip) return;
      event.preventDefault();
      event.stopPropagation();
      const th = grip.closest('th');
      autoFitReportColumn(Number(th?.dataset.colIndex), th?.dataset.colKey || '', activeReportType());
    });
    wrap.addEventListener('wheel', (event) => {
      if (event.ctrlKey) return;
      const horizontalIntent = Math.abs(event.deltaX) >= Math.abs(event.deltaY) || event.shiftKey;
      if (!horizontalIntent) return;
      const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (!delta) return;
      const maxLeft = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
      const nextLeft = Math.min(maxLeft, Math.max(0, wrap.scrollLeft + delta));
      if (nextLeft === wrap.scrollLeft) return;
      event.preventDefault();
      wrap.scrollLeft = nextLeft;
    }, { passive: false });
    let reportPan = null;
    wrap.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button, input, select, textarea, a, .report-col-resize')) return;
      if (wrap.scrollWidth <= wrap.clientWidth) return;
      reportPan = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        scrollLeft: wrap.scrollLeft,
        scrollTop: wrap.scrollTop,
        moved: false
      };
      wrap.classList.add('report-table-panning');
      if (wrap.setPointerCapture) wrap.setPointerCapture(event.pointerId);
    });
    wrap.addEventListener('pointermove', (event) => {
      if (!reportPan || reportPan.pointerId !== event.pointerId) return;
      const dx = event.clientX - reportPan.startX;
      const dy = event.clientY - reportPan.startY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) reportPan.moved = true;
      wrap.scrollLeft = reportPan.scrollLeft - dx;
      wrap.scrollTop = reportPan.scrollTop - dy;
      event.preventDefault();
    });
    const stopReportPan = (event) => {
      if (!reportPan || (event && reportPan.pointerId !== event.pointerId)) return;
      reportPan = null;
      wrap.classList.remove('report-table-panning');
    };
    wrap.addEventListener('pointerup', stopReportPan);
    wrap.addEventListener('pointercancel', stopReportPan);
    $('#reportHead')?.addEventListener('click', (event) => {
      if (event.target.closest('.report-col-resize')) return;
      const button = event.target.closest('.report-sort-button');
      const th = button?.closest('th[data-col-key]');
      if (!th) return;
      const reportType = activeReportType();
      const key = th.dataset.colKey || '';
      const current = activeReportSort(reportType);
      state.reportSort = {
        reportType,
        key,
        direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc'
      };
      renderReportTable(state.reportTableColumns, state.reportTableRows, state.reportTableTotalRows, state.reportTableGrandTotal, reportType);
    });
    $('#reportHead')?.addEventListener('dragstart', (event) => {
      if (event.target.closest('.report-col-resize')) {
        event.preventDefault();
        return;
      }
      const th = event.target.closest('th[data-col-key]');
      if (!th) return;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', th.dataset.colKey);
      th.classList.add('dragging');
    });
    $('#reportHead')?.addEventListener('dragover', (event) => {
      if (event.target.closest('th[data-col-key]')) event.preventDefault();
    });
    $('#reportHead')?.addEventListener('drop', (event) => {
      const target = event.target.closest('th[data-col-key]');
      const sourceKey = event.dataTransfer.getData('text/plain');
      if (!target || !sourceKey || sourceKey === target.dataset.colKey) return;
      event.preventDefault();
      const current = $$('th[data-col-key]', $('#reportHead')).map((th) => th.dataset.colKey);
      const next = current.filter((key) => key !== sourceKey);
      next.splice(next.indexOf(target.dataset.colKey), 0, sourceKey);
      saveReportColumnOrder(next);
      renderReportTable(state.reportTableColumns, state.reportTableRows, state.reportTableTotalRows, state.reportTableGrandTotal, activeReportType());
    });
    $('#reportHead')?.addEventListener('dragend', () => {
      $$('#reportHead th.dragging').forEach((th) => th.classList.remove('dragging'));
    });
  }

  function setReconciliationSummary(summary = {}) {
    setText('reconDms', summary.dmsStock || 0);
    setText('reconPhysical', summary.physicalStock || 0);
    setText('reconExcess', summary.excess || 0);
    setText('reconShort', summary.short || 0);
    setText('reconNet', summary.netDifference || 0);
    setText('reconSummaryDms', summary.dmsStock || 0);
    setText('reconSummaryPhysical', summary.physicalStock || 0);
    setText('reconSummaryExcess', summary.excess || 0);
    setText('reconSummaryShort', summary.short || 0);
    setText('reconSummaryNet', summary.netDifference || 0);
    setText('reconSummaryMrp', money2(summary.varianceMrp || 0));
    setText('reconSummaryDlc', money2(summary.varianceDlc || 0));
  }

  function activeReconDealer() {
    return cleanDealerCode($('#reconDealer')?.value || $('#dealerStockDealer')?.value || '');
  }

  function renderDealerStockPreview(rows = [], total = rows.length) {
    $('#dealerStockPreviewRows').innerHTML = rows.map((row) => `
      <tr>
        <td>${partLink(row.partNumber)}</td>
        <td>${escapeHtml(row.partDescription)}</td>
        <td>${escapeHtml(row.productCategory)}</td>
        <td>${escapeHtml(money(row.mrp))}</td>
        <td>${escapeHtml(money(row.dlc))}</td>
        <td>${escapeHtml(row.dmsStock || row.systemQty || 0)}</td>
        <td>${escapeHtml(row.systemBinLoc1)}</td>
        <td>${escapeHtml(row.systemBinLoc2)}</td>
        <td>${escapeHtml(row.systemBinLoc3)}</td>
        <td>${escapeHtml(row.reservedQty || 0)}</td>
        <td>${escapeHtml(row.dealerCode)}</td>
      </tr>
    `).join('') || '<tr><td colspan="11" class="muted">No dealer stock uploaded yet</td></tr>';
    const message = $('#dealerStockUploadMessage');
    if (message && rows.length) {
      message.className = 'form-message success';
      message.textContent = `Preview showing ${rows.length} of ${total} DMS stock row(s).`;
    }
  }

  async function loadDealerStockPreview() {
    const dealerCode = activeReconDealer();
    if (!dealerCode || dealerCode === 'ALL') throw new Error('Select Dealer Code first');
    const data = await api(`/api/reconciliation/stock-preview?dealerCode=${encodeURIComponent(dealerCode)}`);
    renderDealerStockPreview(data.stock || [], data.total || 0);
    const message = $('#dealerStockUploadMessage');
    if (message) {
      message.className = (data.stock || []).length ? 'form-message success' : 'form-message';
      message.textContent = (data.stock || []).length ? `Loaded ${data.total || 0} uploaded DMS stock row(s) for ${dealerCode}.` : `No uploaded DMS stock found for ${dealerCode}.`;
    }
    return data;
  }

  async function uploadDealerStock(form) {
    const dealerCode = cleanDealerCode($('[name="dealerCode"]', form)?.value || '');
    if (!dealerCode) throw new Error('Select Dealer Code first');
    const message = $('#dealerStockUploadMessage');
    if (message) {
      message.className = 'form-message loading';
      message.textContent = 'Uploading and validating dealer DMS stock...';
    }
    const data = await api('/api/reconciliation/upload-stock', { method: 'POST', body: new FormData(form) });
    if ($('#reconDealer')) $('#reconDealer').value = data.dealerCode || dealerCode;
    renderDealerStockPreview(data.preview || [], data.savedCount || 0);
    if (message) {
      message.className = 'form-message success';
      message.textContent = data.message || `Saved ${data.savedCount || 0} DMS stock row(s).`;
    }
    toast('Dealer DMS stock saved');
    return data;
  }

  async function deleteDealerStock() {
    const dealerCode = activeReconDealer();
    if (!dealerCode || dealerCode === 'ALL') throw new Error('Select Dealer Code first');
    if (!window.confirm(`Delete old DMS stock for dealer ${dealerCode}?`)) return;
    const data = await api(`/api/reconciliation/stock?dealerCode=${encodeURIComponent(dealerCode)}`, { method: 'DELETE' });
    renderDealerStockPreview([]);
    setReconciliationSummary({});
    $('#reconRows').innerHTML = '';
    toast(data.message || 'Dealer stock deleted');
  }

  async function reprocessReconciliation() {
    const dealerCode = activeReconDealer();
    if (!dealerCode || dealerCode === 'ALL') throw new Error('Select Dealer Code first');
    const data = await api(`/api/reconciliation/reprocess?dealerCode=${encodeURIComponent(dealerCode)}`, { method: 'POST', body: {} });
    setReconciliationSummary(data.summary || {});
    toast(data.message || 'Reconciliation reprocessed');
    return data;
  }

  async function loadReconciliation() {
    const dealerCode = cleanDealerCode($('#reconDealer')?.value || '');
    const message = $('#reconMessage');
    if (!dealerCode || dealerCode === 'ALL') {
      $('#reconRows').innerHTML = '';
      setReconciliationSummary({});
      if (message) {
        message.className = 'form-message';
        message.textContent = 'Please select Dealer Code and click Submit.';
      }
      state.reconLoaded = false;
      return;
    }
    if (message) {
      message.className = 'form-message loading';
      message.textContent = 'Loading reconciliation report...';
    }
    const query = queryFromForm($('#reconFilters'));
    const data = await api(`/api/reconciliation/report?${query}`);
    const summary = data.summary || {};
    setReconciliationSummary(summary);
    $('#reconRows').innerHTML = (data.rows || []).slice(0, 500).map((row) => `
      <tr>
        <td>${partLink(row.partNo || row.partNumber)}</td>
        <td>${escapeHtml(row.partDescription || row.partName)}</td>
        <td>${escapeHtml(row.model || '')}</td>
        <td>${escapeHtml(row.manufacturingYear || row.year || '')}</td>
        <td>${escapeHtml(row.productCategory || row.category || '')}</td>
        <td>${escapeHtml(money(row.mrp))}</td>
        <td>${escapeHtml(money(row.dlc))}</td>
        <td>${escapeHtml(row.productGroup || '')}</td>
        <td>${escapeHtml(row.bin)}</td>
        <td>${escapeHtml(row.dmsStock)}</td>
        <td>${escapeHtml(row.physicalStock)}</td>
        <td>${escapeHtml(row.excess)}</td>
        <td>${escapeHtml(row.short)}</td>
        <td>${escapeHtml(row.netDifference)}</td>
        <td>${escapeHtml(row.status)}</td>
        <td class="raw-cell" title="${escapeHtml(row.rawScanProof)}">${escapeHtml(row.rawScanProof)}</td>
      </tr>
    `).join('') || '<tr><td colspan="16" class="muted">No reconciliation data found for selected dealer/filter</td></tr>';
    if (message) {
      message.className = (data.rows || []).length ? 'form-message success' : 'form-message error';
      message.textContent = (data.rows || []).length ? `${data.rows.length} reconciliation row(s) loaded.` : (data.message || 'No reconciliation data found for selected filter');
    }
    state.reconLoaded = true;
  }

  function clearPartSearch(message = 'Use filters and click Show to view master details.') {
    state.masterSearch = { q: '', page: 1, limit: 25, total: 0 };
    state.masterSearchRows = [];
    $('#partMasterRows').innerHTML = '';
    $('#partMasterResultsCard').hidden = true;
    $('#partPageInfo').textContent = 'Page 1';
    $('#partPrevPageBtn').disabled = true;
    $('#partNextPageBtn').disabled = true;
    const box = $('#partSearchMessage');
    if (box) {
      box.className = 'form-message';
      box.textContent = message;
    }
  }

  function partSearchParams(page = 1) {
    const form = $('#partSearchForm');
    const payload = form ? formObject(form) : {};
    const params = new URLSearchParams();
    ['partNumber', 'category', 'group', 'year', 'model', 'mrp'].forEach((key) => {
      const value = String(payload[key] || '').trim();
      if (value) params.set(key, value);
    });
    params.set('page', String(page));
    params.set('limit', String(state.masterSearch.limit || 25));
    return params;
  }

  function hasPartSearchFilter() {
    const params = partSearchParams(1);
    return ['partNumber', 'category', 'group', 'year', 'model', 'mrp'].some((key) => params.has(key));
  }

  async function loadParts(page = 1) {
    if (!hasPartSearchFilter()) {
      clearPartSearch();
      return;
    }
    const params = partSearchParams(page);
    state.masterSearch = { ...state.masterSearch, q: params.get('partNumber') || '', page, limit: state.masterSearch.limit || 25 };
    const box = $('#partSearchMessage');
    if (box) {
      box.className = 'form-message loading';
      box.textContent = 'Searching master data...';
    }
    const data = await api(`/api/master/search?${params.toString()}`);
    state.masterSearchRows = data.parts || [];
    state.masterSearch.total = Number(data.total || 0);
    $('#partMasterResultsCard').hidden = false;
    $('#partMasterRows').innerHTML = state.masterSearchRows.map((part) => `
      <tr>
        <td>${partLink(part.partNumber || part.partNo)}</td>
        <td>${escapeHtml(part.partDescription || part.partName)}</td>
        <td>${escapeHtml(part.productCategory || part.category)}</td>
        <td>${escapeHtml(part.productGroup || '')}</td>
        <td>${escapeHtml(part.partSubGroup || '')}</td>
        <td>${escapeHtml(part.manufacturingYear || part.year || '')}</td>
        <td>${escapeHtml(part.model || '')}</td>
        <td>${escapeHtml(money(part.mrp))}</td>
        <td>${escapeHtml(money(part.dlc))}</td>
      </tr>
    `).join('') || '<tr><td colspan="9" class="muted">No matching master catalogue parts found</td></tr>';
    const totalPages = Math.max(Number(data.totalPages || 1), 1);
    $('#partPageInfo').textContent = `Page ${data.page || page} of ${totalPages} | ${data.total || 0} records`;
    $('#partPrevPageBtn').disabled = page <= 1;
    $('#partNextPageBtn').disabled = page >= totalPages;
    if (box) {
      box.className = state.masterSearchRows.length ? 'form-message success' : 'form-message error';
      box.textContent = state.masterSearchRows.length ? `${data.total || 0} master part(s) found.` : 'No matching master parts found';
    }
  }

  async function loadPartSearchFilters() {
    const data = await api('/api/master/filters');
    const fill = (id, values = [], label) => {
      const select = $(`#${id}`);
      if (!select) return;
      const selected = select.value;
      select.innerHTML = `<option value="">${label}</option>` + values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
      select.value = values.includes(selected) ? selected : '';
    };
    fill('partCategoryFilter', data.categories || [], 'All Categories');
    fill('partGroupFilter', data.groups || [], 'All Groups');
    fill('partModelFilter', data.models || [], 'All Models');
    fill('partYearFilter', data.years || [], 'All Years');
  }

  async function loadPartNumberSuggestions(query) {
    const menu = $('#partMasterSuggestMenu');
    if (!menu) return;
    const value = String(query || '').trim();
    if (!value) {
      menu.style.display = 'none';
      menu.innerHTML = '';
      return;
    }
    const data = await api(`/api/master/suggestions?query=${encodeURIComponent(value)}&limit=20`);
    const parts = data.suggestions || data.parts || [];
    menu.innerHTML = parts.map((part) => `
      <div class="suggest-item master-suggest-item" data-part="${escapeHtml(part.partNumber || part.partNo || '')}">
        <strong>${partLink(part.partNumber || part.partNo)}</strong>
        <span>${escapeHtml(part.partDescription || part.partName || '')} | ${escapeHtml(part.productCategory || part.category || '')} | ${escapeHtml(part.model || '')}</span>
      </div>
    `).join('') || '<div class="suggest-item muted">No matching part numbers</div>';
    menu.style.display = 'block';
    $$('.master-suggest-item', menu).forEach((item) => {
      item.addEventListener('mousedown', (event) => {
        event.preventDefault();
        $('#partMasterSearchInput').value = item.dataset.part || '';
        menu.style.display = 'none';
      });
    });
  }

  function exportPartSearchResults() {
    const rows = state.masterSearchRows || [];
    if (!rows.length) {
      toast('No search result to export', 'error');
      return;
    }
    const headers = ['Part Number', 'Part Description', 'Category', 'Product Group', 'Product Sub Group', 'Year', 'Model', 'MRP', 'DLC'];
    const csvRows = rows.map((part) => [
      part.partNumber || part.partNo || '',
      part.partDescription || part.partName || '',
      part.productCategory || part.category || '',
      part.productGroup || '',
      part.partSubGroup || '',
      part.manufacturingYear || part.year || '',
      part.model || '',
      part.mrp || 0,
      part.dlc || 0
    ]);
    const csv = [headers].concat(csvRows).map((cols) => cols.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'Master_Part_Search_Result.csv');
  }

  function renderDealerMaster() {
    $('#dealerMasterRows').innerHTML = state.dealers.length ? state.dealers.map((dealer) => `
      <tr>
        <td>${escapeHtml(dealer.dealerName)}</td>
        <td>${escapeHtml(dealer.dealerCode)}</td>
        <td>${escapeHtml(dealer.location)}</td>
        <td><button class="btn danger-soft small dealer-master-delete admin-only" type="button" data-code="${escapeHtml(dealer.dealerCode)}" data-name="${escapeHtml(dealer.dealerName)}">Delete</button></td>
      </tr>
    `).join('') : '<tr><td colspan="4" class="muted">No dealers yet</td></tr>';
  }

  async function deleteDealerMaster(dealerCode, dealerName = '') {
    const code = cleanDealerCode(dealerCode);
    if (!code) return toast('Dealer code is required', 'error');
    const label = dealerName ? `${dealerName} (${code})` : code;
    if (!window.confirm(`Delete dealer setup for ${label}? Scan, master, BIN and transfer data will not be deleted.`)) return;
    const data = await api(`/api/master/dealers/${encodeURIComponent(code)}`, { method: 'DELETE', body: {} });
    toast(`Dealer deleted: ${data.dealersDeleted || 0}, audits deleted: ${data.auditsDeleted || 0}`);
    await loadDealers();
  }

  async function loadBins() {
    const dealerCode = cleanDealerCode($('#binManagementDealer')?.value || currentDealerCode());
    const search = ($('#binManagementSearch')?.value || '').trim();
    const status = $('#binManagementStatus');
    if (!dealerCode) {
      state.binMasterRows = [];
      if ($('#binMasterRows')) $('#binMasterRows').innerHTML = '<tr><td colspan="5" class="muted">Select dealer to view BIN locations</td></tr>';
      if (status) {
        status.className = 'form-message';
        status.textContent = 'Select dealer to manage BIN locations.';
      }
      return [];
    }
    if (status) {
      status.className = 'form-message';
      status.textContent = 'Loading BIN locations...';
    }
    const query = new URLSearchParams({ dealerCode });
    if (search) query.set('q', search);
    const data = await api(`/api/bin-master?${query.toString()}`);
    const bins = data.bins || [];
    state.binMasterRows = bins;
    $('#binMasterRows').innerHTML = bins.map((bin) => `
      <tr>
        <td><input class="bin-management-check" type="checkbox" value="${escapeHtml(bin.id || bin._id)}" data-bin="${escapeHtml(bin.binCode)}"></td>
        <td>${escapeHtml(bin.binCode)}</td>
        <td>${escapeHtml(bin.dealerCode)}</td>
        <td>${escapeHtml(bin.category)}</td>
        <td><div class="row-actions"><button class="btn light small edit-bin-btn admin-only" type="button" data-id="${escapeHtml(bin.id || bin._id)}">Edit</button><button class="btn danger-soft small delete-bin-btn admin-only" type="button" data-id="${escapeHtml(bin.id || bin._id)}" data-bin="${escapeHtml(bin.binCode)}">Delete</button></div></td>
      </tr>
    `).join('') || '<tr><td colspan="5" class="muted">No BIN locations found for selected dealer</td></tr>';
    if ($('#selectAllBins')) $('#selectAllBins').checked = false;
    if (status) {
      status.className = bins.length ? 'form-message success' : 'form-message';
      status.textContent = `${bins.length} BIN locations loaded for ${dealerCode}${data.removedDuplicates ? ` | Removed duplicates ${data.removedDuplicates}` : ''}`;
    }
    return bins;
  }

  function selectedBinIds() {
    return $$('.bin-management-check:checked').map((box) => String(box.value || '').trim()).filter(Boolean);
  }

  function findBinRow(id) {
    return state.binMasterRows.find((bin) => String(bin.id || bin._id) === String(id));
  }

  function confirmBinDelete(message) {
    return window.confirm(`${message}\n\nAre you sure?\nThis action cannot be undone.`);
  }

  async function deleteSingleBin(binId) {
    const dealerCode = cleanDealerCode($('#binManagementDealer')?.value || currentDealerCode());
    const bin = findBinRow(binId) || {};
    const binCode = bin.binCode || '';
    if (!dealerCode) throw new Error('Select dealer first');
    if (!binId) throw new Error('Select BIN first');
    if (!confirmBinDelete(`Delete BIN ${binCode} for dealer ${dealerCode}?`)) return;
    const data = await api(`/api/bin-master/${encodeURIComponent(binId)}`, { method: 'DELETE' });
    toast(`Deleted ${data.deletedCount || 0} BIN record`);
    await loadBins();
    await loadBinTransferDestinationBins(dealerCode, $('.bin-transfer-from')?.value || '').catch(() => null);
  }

  async function deleteSelectedBins() {
    const dealerCode = cleanDealerCode($('#binManagementDealer')?.value || currentDealerCode());
    const binIds = selectedBinIds();
    if (!dealerCode) throw new Error('Select dealer first');
    if (!binIds.length) throw new Error('Select at least one BIN');
    if (!confirmBinDelete(`Delete ${binIds.length} selected BIN location(s) for dealer ${dealerCode}?`)) return;
    await Promise.all(binIds.map((id) => api(`/api/bin-master/${encodeURIComponent(id)}`, { method: 'DELETE' })));
    toast(`Deleted ${binIds.length} BIN record(s)`);
    await loadBins();
    await loadBinTransferDestinationBins(dealerCode, $('.bin-transfer-from')?.value || '').catch(() => null);
  }

  async function deleteAllDealerBins() {
    const dealerCode = cleanDealerCode($('#binManagementDealer')?.value || currentDealerCode());
    if (!dealerCode) throw new Error('Select dealer first');
    if (!confirmBinDelete(`Delete ALL BIN locations for dealer ${dealerCode}?`)) return;
    const bins = state.binMasterRows.length ? state.binMasterRows : await loadBins();
    await Promise.all(bins.map((bin) => api(`/api/bin-master/${encodeURIComponent(bin.id || bin._id)}`, { method: 'DELETE' })));
    toast(`Deleted ${bins.length} BIN record(s) for ${dealerCode}`);
    await loadBins();
    await loadBinTransferDestinationBins(dealerCode, $('.bin-transfer-from')?.value || '').catch(() => null);
  }

  async function editBin(binId) {
    const bin = findBinRow(binId);
    if (!bin) throw new Error('Bin not found');
    const dealerInput = window.prompt('Dealer Code', bin.dealerCode || '');
    if (dealerInput === null) return;
    const dealerCode = cleanDealerCode(dealerInput);
    const binInput = window.prompt('Bin Code', bin.binCode || '');
    if (binInput === null) return;
    const binCode = cleanDealerCode(binInput);
    const categoryInput = window.prompt('Category', bin.category || '');
    if (categoryInput === null) return;
    if (!dealerCode) throw new Error('Dealer code is required');
    if (!binCode) throw new Error('Bin code is required');
    await api(`/api/bin-master/${encodeURIComponent(binId)}`, {
      method: 'PUT',
      body: { dealerCode, binCode, binName: binCode, category: categoryInput.trim() }
    });
    toast('Bin updated');
    if ($('#binManagementDealer')) $('#binManagementDealer').value = dealerCode;
    await loadBins();
    await loadBinTransferDestinationBins(dealerCode, $('.bin-transfer-from')?.value || '').catch(() => null);
  }

  async function exportBinMaster() {
    const dealerCode = cleanDealerCode($('#binManagementDealer')?.value || currentDealerCode());
    const search = ($('#binManagementSearch')?.value || '').trim();
    if (!dealerCode) throw new Error('Select dealer first');
    const query = new URLSearchParams({ dealerCode });
    if (search) query.set('q', search);
    await downloadGet(`/api/bin-master/export?${query.toString()}`, `Bin_Master_${dealerCode}.csv`);
  }

  function optionList(items, placeholder) {
    return `<option value="">${escapeHtml(placeholder)}</option>` + items.map((item) => {
      const value = typeof item === 'string' ? item : item.binCode || item.partNumber || '';
      const label = typeof item === 'string' ? item : item.label || item.binName || item.binCode || item.partNumber || '';
      return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
    }).join('');
  }

  function sourceBinOptionList(items) {
    return '<option value="ALL">All</option>' + items.map((item) => {
      const value = typeof item === 'string' ? item : item.binCode || item.binLocation || item.bin || '';
      const label = typeof item === 'string' ? item : item.label || item.binName || item.binCode || item.binLocation || item.bin || '';
      return value ? `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>` : '';
    }).join('');
  }

  function activeBinTransferForm() {
    const activeForms = $$('.bin-transfer-panel.active form');
    return activeForms.find((form) => $('.bin-transfer-dealer', form)) || $('#binTransferForm');
  }

  function binTransferCriteria(form = activeBinTransferForm()) {
    return {
      dealerCode: cleanDealerCode($('[name="dealerCode"]', form)?.value || ''),
      fromBin: $('[name="sourceBin"], [name="fromBin"]', form)?.value || '',
      toBin: $('[name="destinationBin"], [name="toBin"]', form)?.value || ''
    };
  }

  function destinationBinPlaceholder(data, bins) {
    return bins.length ? 'Select Transfer To Bin' : (data.message || 'No destination bins found. Please create bins in Bin Master / Sequence Creation.');
  }

  function binOptionValue(item) {
    return typeof item === 'string' ? item : item.binCode || item.binLocation || item.bin || '';
  }

  function binOptionKey(value) {
    return String(value || '').trim().toUpperCase();
  }

  function setBinTransferSubmitDisabled(disabled) {
    const button = $('#binTransferSubmitSelectedBtn');
    if (button) button.disabled = disabled;
  }

  function applyDestinationBinOptions(data = {}, preferredValue = '') {
    const bins = data.bins || data.destinationBins || data.toBins || [];
    state.binTransferDestinationBins = bins;
    const placeholder = destinationBinPlaceholder(data, bins);
    const options = optionList(bins, placeholder);
    const allowed = new Set(bins.map((bin) => binOptionKey(binOptionValue(bin))).filter(Boolean));
    $$('.bin-transfer-to').forEach((select) => {
      const nextValue = String(preferredValue || select.value || '').trim();
      select.innerHTML = options;
      select.value = nextValue && allowed.has(binOptionKey(nextValue)) ? nextValue : '';
      select.title = bins.length ? '' : placeholder;
    });
    setBinTransferSubmitDisabled(!bins.length);
    syncBinTransferRowDestinations();
    return bins;
  }

  async function loadBinTransferDestinationBins(dealerCode, sourceBin = '', preferredValue = '') {
    if (!dealerCode) {
      state.binTransferDestinationBins = [];
      $$('.bin-transfer-to').forEach((select) => {
        select.innerHTML = '<option value="">Select Transfer To Bin</option>';
        select.value = '';
        select.title = '';
      });
      setBinTransferSubmitDisabled(true);
      return [];
    }
    const query = new URLSearchParams({ dealerCode });
    if (sourceBin) query.set('sourceBin', sourceBin);
    const data = await api(`/api/bin-transfer/destination-bins?${query.toString()}`);
    return applyDestinationBinOptions(data, preferredValue);
  }

  function partAvailableQty(part = {}) {
    return Number(part.availableQty || part.quantity || 0);
  }

  function selectedMainDestinationBin() {
    return String($('#binTransferToBin')?.value || '').trim();
  }

  function destinationOptions(selectedValue = '') {
    const selectedKey = binOptionKey(selectedValue);
    return '<option value="">Select Transfer To Bin</option>' + (state.binTransferDestinationBins || []).map((bin) => {
      const value = binOptionValue(bin);
      const selected = selectedKey && binOptionKey(value) === selectedKey ? ' selected' : '';
      return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(value)}</option>`;
    }).join('');
  }

  function binTransferPartRows(parts = []) {
    return parts.map((part) => {
      const availableQty = partAvailableQty(part);
      const defaultDestination = selectedMainDestinationBin();
      return `
        <tr data-part="${escapeHtml(part.partNumber)}" data-current-bin="${escapeHtml(part.currentBin)}">
          <td><input class="bin-transfer-check" type="checkbox" value="${escapeHtml(part.partNumber)}"></td>
          <td>${partLink(part.partNumber)}</td>
          <td>${escapeHtml(part.partDescription)}</td>
          <td>${escapeHtml(part.productCategory || part.category)}</td>
          <td>${escapeHtml(part.currentBin)}</td>
          <td><select class="bin-transfer-row-to">${destinationOptions(defaultDestination)}</select></td>
          <td>${escapeHtml(availableQty)}</td>
          <td><input class="bin-transfer-qty" type="number" min="1" max="${escapeHtml(availableQty)}" value="${escapeHtml(availableQty || 1)}" data-part="${escapeHtml(part.partNumber)}"></td>
          <td>${escapeHtml(part.dealerCode)}</td>
          <td><span class="muted">Ready</span></td>
        </tr>
      `;
    }).join('');
  }

  function activeBinTransferPartRoot() {
    return $('#binTransferMainTab');
  }

  function syncBinTransferRowDestinations({ selectedOnly = true, force = false } = {}) {
    const value = selectedMainDestinationBin();
    if (!value) return;
    $$('.bin-transfer-row-to').forEach((select) => {
      const row = select.closest('tr');
      const checked = $('.bin-transfer-check', row)?.checked;
      if (selectedOnly && !checked) return;
      if (!force && select.dataset.manual === 'true') return;
      select.value = value;
    });
  }

  function selectedBinTransferParts(root = activeBinTransferPartRoot()) {
    return $$('.bin-transfer-check:checked', root).map((box) => {
      const part = state.binTransferParts.find((item) => item.partNumber === box.value);
      if (!part) return null;
      const row = box.closest('tr');
      const qtyInput = row?.querySelector('.bin-transfer-qty');
      const destinationBin = cleanDealerCode(row?.querySelector('.bin-transfer-row-to')?.value || '');
      const qty = Number(qtyInput?.value || partAvailableQty(part));
      return { ...part, qty, destinationBin };
    }).filter(Boolean);
  }

  function normalizeBinTransferPartsResponse(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.parts)) return data.parts;
    if (Array.isArray(data?.data)) return data.data;
    if (Array.isArray(data?.rows)) return data.rows;
    return [];
  }

  function renderBinTransferParts(parts = [], message = 'No scanned parts found for selected dealer and source bin.') {
    state.binTransferParts = parts;
    if (!parts.length && message) state.binTransferLoadedParts = state.binTransferLoadedParts || [];
    setText('binTransferPartsCount', `${parts.length} parts`);
    const rows = binTransferPartRows(parts);
    const tableBody = $('#binTransferPartsRows');
    if (tableBody) tableBody.innerHTML = rows || `<tr><td colspan="10" class="muted">${escapeHtml(message)}</td></tr>`;
    const selectAll = $('#binTransferSelectAll');
    if (selectAll) selectAll.checked = false;
    const messageNode = $('#binTransferMessage');
    if (messageNode) {
      messageNode.className = parts.length ? 'form-message success' : 'form-message';
      messageNode.textContent = parts.length ? `${parts.length} part(s) loaded. Select rows and choose destination bins.` : message;
    }
    const hasSourceBin = Boolean(binTransferCriteria(activeBinTransferForm()).fromBin);
    setBinTransferSubmitDisabled(!parts.length || !hasSourceBin || !(state.binTransferDestinationBins || []).length);
  }

  function setBinTransferLoading(message) {
    const option = `<option value="">${escapeHtml(message)}</option>`;
    $$('.bin-transfer-from').forEach((select) => { select.innerHTML = option; select.value = ''; });
    $$('.bin-transfer-to').forEach((select) => { select.innerHTML = option; select.value = ''; });
    setBinTransferSubmitDisabled(true);
    $('#binTransferPartsRows').innerHTML = `<tr><td colspan="10" class="muted">${escapeHtml(message)}</td></tr>`;
    setText('binTransferPartsCount', 'Loading...');
  }

  async function loadBinTransferBins(dealerCode) {
    state.binTransferLoadedParts = [];
    if (!dealerCode) {
      state.binTransferDestinationBins = [];
      $$('.bin-transfer-from').forEach((select) => { select.innerHTML = '<option value="">Select Source Bin</option>'; });
      $$('.bin-transfer-to').forEach((select) => { select.innerHTML = '<option value="">Select Transfer To Bin</option>'; });
      setBinTransferSubmitDisabled(true);
      renderBinTransferParts([], 'Select Dealer Code and Source Bin, then click Show Parts.');
      return;
    }
    setBinTransferLoading('Loading bin locations...');
    const [sourceData, toData] = await Promise.all([
      api(`/api/bin-transfer/source-bins?dealerCode=${encodeURIComponent(dealerCode)}`),
      api(`/api/bin-transfer/destination-bins?dealerCode=${encodeURIComponent(dealerCode)}`)
    ]);
    const fromOptions = sourceBinOptionList(sourceData.bins || sourceData.fromBins || []);
    $$('.bin-transfer-from').forEach((select) => {
      select.innerHTML = fromOptions;
      select.value = 'ALL';
    });
    applyDestinationBinOptions(toData, '');
    renderBinTransferParts([], sourceData.message || 'Source Bin All selected. Loading all available scanned parts...');
    await loadBinTransferParts(activeBinTransferForm()).catch((error) => {
      console.warn('BIN_TRANSFER_AUTO_LOAD_FAILED', error);
      renderBinTransferParts([], 'Click Show Parts to load available scanned parts.');
    });
  }

  function filterRenderedBinTransferParts() {
    const partFilter = String($('#binTransferPartSearch')?.value || '').trim().toUpperCase();
    const source = state.binTransferLoadedParts && state.binTransferLoadedParts.length ? state.binTransferLoadedParts : state.binTransferParts;
    const parts = partFilter
      ? source.filter((part) => String(part.partNumber || '').toUpperCase().includes(partFilter))
      : source;
    renderBinTransferParts(parts, partFilter ? 'No parts match the search in the displayed list.' : 'No scanned parts found for selected dealer and source bin.');
  }

  async function loadBinTransferParts(form = activeBinTransferForm()) {
    const { dealerCode, fromBin } = binTransferCriteria(form);
    const partNumber = String($('[name="partNumber"]', form)?.value || '').trim();
    console.log('SELECTED_DEALER', dealerCode);
    console.log('SELECTED_SOURCE_BIN', fromBin);
    if (!dealerCode || (!fromBin && !partNumber)) {
      renderBinTransferParts([], 'Select Dealer Code, or enter Part Number to find available bin.');
      return;
    }
    $('#binTransferPartsRows').innerHTML = '<tr><td colspan="10" class="muted">Loading parts...</td></tr>';
    setText('binTransferPartsCount', 'Loading...');
    if (fromBin) {
      await loadBinTransferDestinationBins(dealerCode, fromBin, selectedMainDestinationBin()).catch((error) => console.warn('DESTINATION_BINS_LOAD_FAILED', error));
    }
    const query = new URLSearchParams({ dealerCode });
    if (fromBin) query.set('sourceBin', fromBin);
    if (partNumber) query.set('partNumber', partNumber);
    const data = await api(`/api/bin-transfer/parts?${query.toString()}`);
    console.log('API_RESPONSE', data);
    const responseParts = normalizeBinTransferPartsResponse(data);
    state.binTransferLoadedParts = responseParts;
    filterRenderedBinTransferParts();
  }

  async function loadBinTransferHistory() {
    const form = $('#binTransferHistoryFilters');
    const query = form ? queryFromForm(form) : ($('.bin-transfer-dealer')?.value ? `dealerCode=${encodeURIComponent(cleanDealerCode($('.bin-transfer-dealer')?.value || ''))}` : '');
    const data = await api(`/api/bin-transfer/history${query ? `?${query}` : ''}`);
    $('#binTransferHistoryRows').innerHTML = (data.history || []).map((item) => `
      <tr>
        <td>${escapeHtml(dateTime(item.transferredAt))}</td>
        <td>${escapeHtml(item.dealerCode)}</td>
        <td>${escapeHtml(item.fromBin)}</td>
        <td>${escapeHtml(item.toBin)}</td>
        <td>${partLink(item.partNumber)}</td>
        <td>${escapeHtml(item.partDescription)}</td>
        <td>${escapeHtml(item.qty)}</td>
        <td>${escapeHtml(item.transferType)}</td>
        <td>${escapeHtml(item.transferredBy)}</td>
      </tr>
    `).join('') || '<tr><td colspan="9" class="muted">No transfer history yet</td></tr>';
  }

  function confirmBinTransfer(fromBin, toBin) {
    return window.confirm(`Are you sure you want to transfer selected parts from ${fromBin} to ${toBin}?`);
  }

  async function submitUnifiedBinTransfer() {
    const form = $('#binTransferForm');
    const { dealerCode, fromBin } = binTransferCriteria(form);
    const selectedParts = selectedBinTransferParts();
    if (!dealerCode) return toast('Dealer required', 'error');
    if (!fromBin) return toast('Source Bin required', 'error');
    if (!selectedParts.length) return toast('Select at least one part to transfer', 'error');

    for (const part of selectedParts) {
      const destinationBin = String(part.destinationBin || '').trim();
      const availableQty = partAvailableQty(part);
      const qty = Number(part.qty);
      const sourceKey = String(part.currentBin || fromBin).toUpperCase();
      if (!destinationBin) return toast(`Transfer To Bin required for ${part.partNumber}`, 'error');
      if (destinationBin.toUpperCase() === sourceKey) return toast(`Destination cannot be same as Source Bin for ${part.partNumber}`, 'error');
      if (!Number.isFinite(qty) || qty <= 0) return toast(`Transfer Qty must be greater than 0 for ${part.partNumber}`, 'error');
      if (qty > availableQty) return toast(`Transfer Qty cannot exceed Available Qty for ${part.partNumber}`, 'error');
    }

    const destinations = Array.from(new Set(selectedParts.map((part) => part.destinationBin)));
    const confirmTarget = destinations.length === 1 ? destinations[0] : `${destinations.length} destination bins`;
    if (!confirmBinTransfer(fromBin, confirmTarget)) return;

    setBinTransferSubmitDisabled(true);
    try {
      await api('/api/bin-transfer/transfer', {
        method: 'POST',
        body: {
          dealerCode,
          sourceBin: fromBin,
          destinationBin: selectedMainDestinationBin(),
          selectedParts: selectedParts.map((part) => ({
            partNumber: part.partNumber,
            qty: part.qty,
            sourceBin: part.currentBin || fromBin,
            destinationBin: part.destinationBin
          }))
        }
      });
      await refreshAfterBinTransfer();
      toast('Selected parts transferred');
    } finally {
      setBinTransferSubmitDisabled(!state.binTransferParts.length || !(state.binTransferDestinationBins || []).length);
    }
  }

  async function refreshAfterBinTransfer() {
    const criteria = binTransferCriteria(activeBinTransferForm());
    await loadBinTransferBins(criteria.dealerCode).catch(() => null);
    $$('.bin-transfer-dealer').forEach((select) => { select.value = criteria.dealerCode; });
    $$('.bin-transfer-from').forEach((select) => { select.value = criteria.fromBin || 'ALL'; });
    await loadBinTransferDestinationBins(criteria.dealerCode, criteria.fromBin, criteria.toBin).catch(() => null);
    await Promise.all([
      loadBinTransferParts(activeBinTransferForm()).catch(() => null),
      loadBinTransferHistory().catch(() => null),
      loadScanHistory().catch(() => null),
      loadDashboard().catch(() => null)
    ]);
    await loadBinLabelBins(criteria.dealerCode).catch(() => null);
    clearBinLabelSelection('Select updated bin(s), then click Show Parts.');
  }

  function selectedMultiValues(select) {
    if (select?.id === 'binLabelBins') {
      return $$('.bin-label-bin-option:checked').map((box) => String(box.value || '').trim()).filter(Boolean);
    }
    return Array.from(select?.selectedOptions || []).map((option) => String(option.value || '').trim()).filter(Boolean);
  }

  function binLabelSettingsFromForm() {
    const copies = Number($('#binLabelCopies')?.value || 1);
    return {
      labelWidthMm: Number($('#binLabelWidth')?.value || 70),
      labelHeightMm: Number($('#binLabelHeight')?.value || 28),
      qrSizeMm: Number($('#binLabelQrSize')?.value || 20),
      partFontSize: Number($('#binLabelPartFont')?.value || 12),
      binFontSize: Number($('#binLabelBinFont')?.value || 9),
      boldText: $('#binLabelBold')?.value !== 'false',
      printArea: $('#binLabelPrintAreaMode')?.value || 'full',
      copies: Number.isFinite(copies) ? Math.max(1, copies) : 1
    };
  }

  function selectedBinLabelParts() {
    return (state.binLabelParts || []).map((part) => {
      if (!state.binLabelSelectedKeys.has(binLabelPartKey(part))) return null;
      return {
        binNumber: part.binNumber,
        partNumber: part.partNumber
      };
    }).filter(Boolean);
  }

  function binLabelSelectedPartKeys() {
    return state.binLabelSelectedKeys || new Set();
  }

  function binLabelPartKey(part = {}) {
    return `${String(part.binNumber || '').trim().toUpperCase()}::${String(part.partNumber || '').trim().toUpperCase()}`;
  }

  function filteredBinLabelParts(parts = state.binLabelParts || []) {
    const search = String($('#binLabelPartSearch')?.value || '').trim().toUpperCase();
    if (!search) return parts.map((part, index) => ({ part, index }));
    return parts
      .map((part, index) => ({ part, index }))
      .filter(({ part }) => [part.partNumber, part.partDescription, part.binNumber]
        .some((value) => String(value || '').toUpperCase().includes(search)));
  }

  function syncBinLabelSelectAllState() {
    const boxes = $$('.bin-label-part-check');
    const visibleBoxes = boxes.filter((box) => box.closest('tr')?.hidden !== true);
    const checkedVisible = visibleBoxes.filter((box) => box.checked);
    if ($('#binLabelSelectAllParts')) {
      $('#binLabelSelectAllParts').checked = visibleBoxes.length > 0 && checkedVisible.length === visibleBoxes.length;
      $('#binLabelSelectAllParts').indeterminate = checkedVisible.length > 0 && checkedVisible.length < visibleBoxes.length;
    }
  }

  function clearBinLabelSelection(message = 'Select Dealer Code and bin(s), then click Show Parts.') {
    state.binLabelParts = [];
    state.binLabelSelectedKeys = new Set();
    state.binLabelPreviewItems = [];
    state.binLabelSettings = null;
    setText('binLabelPartsCount', '0 parts');
    setText('binLabelPreviewCount', '0 labels');
    if ($('#binLabelPartsRows')) $('#binLabelPartsRows').innerHTML = `<tr><td colspan="5" class="muted">${escapeHtml(message)}</td></tr>`;
    if ($('#binLabelPreviewArea')) $('#binLabelPreviewArea').innerHTML = '';
    if ($('#binLabelPrintArea')) $('#binLabelPrintArea').innerHTML = '';
    if ($('#binLabelSelectAllParts')) $('#binLabelSelectAllParts').checked = false;
    if ($('#binLabelPartSearch')) $('#binLabelPartSearch').value = '';
    const messageNode = $('#binLabelMessage');
    if (messageNode) {
      messageNode.className = 'form-message';
      messageNode.textContent = message;
    }
  }

  function setBinLabelMessage(message, type = '') {
    const messageNode = $('#binLabelMessage');
    if (!messageNode) return;
    messageNode.className = type ? `form-message ${type}` : 'form-message';
    messageNode.textContent = message;
  }

  function renderBinLabelBins(bins = []) {
    state.binLabelBins = bins;
    const select = $('#binLabelBins');
    if (select) {
      select.innerHTML = bins.length
      ? bins.map((bin) => {
        const value = binOptionValue(bin);
        return `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`;
      }).join('')
      : '<option value="">No bins found</option>';
    }
    const panel = $('#binLabelBinsPanel');
    if (panel) {
      panel.innerHTML = bins.length ? bins.map((bin, index) => {
        const value = binOptionValue(bin);
        return `<label class="bin-label-multi-option"><input class="bin-label-bin-option" type="checkbox" value="${escapeHtml(value)}" data-index="${escapeHtml(index)}"><span>${escapeHtml(value)}</span></label>`;
      }).join('') : '<div class="bin-label-multi-empty">No bins found</div>';
    }
    updateBinLabelBinsButton();
  }

  function updateBinLabelBinsButton() {
    const values = selectedMultiValues($('#binLabelBins'));
    const button = $('#binLabelBinsButton');
    if (!button) return;
    button.textContent = values.length ? (values.length === 1 ? values[0] : `${values.length} bins selected`) : 'Select Bin(s)';
    button.title = values.join(', ');
  }

  async function loadBinLabelBins(dealerCode = cleanDealerCode($('#binLabelDealer')?.value || currentDealerCode())) {
    if ($('#binLabelDealer') && dealerCode) $('#binLabelDealer').value = dealerCode;
    if (!dealerCode) {
      renderBinLabelBins([]);
      clearBinLabelSelection('Select Dealer Code to load bins.');
      return [];
    }
    renderBinLabelBins([]);
    clearBinLabelSelection('Loading bins...');
    const data = await api(`/api/bin-transfer/source-bins?dealerCode=${encodeURIComponent(dealerCode)}`);
    const bins = data.bins || data.fromBins || [];
    renderBinLabelBins(bins);
    clearBinLabelSelection(bins.length ? 'Select one or multiple bins, then click Show Parts.' : 'No bins found for selected dealer.');
    return bins;
  }

  function renderBinLabelParts(parts = []) {
    const selectedKeys = binLabelSelectedPartKeys();
    state.binLabelParts = parts;
    const filtered = filteredBinLabelParts(parts);
    setText('binLabelPartsCount', `${filtered.length}${filtered.length === parts.length ? '' : ` of ${parts.length}`} parts`);
    const body = $('#binLabelPartsRows');
    if (body) {
      body.innerHTML = filtered.length ? filtered.map(({ part, index }) => {
        const key = binLabelPartKey(part);
        return `
        <tr>
          <td><input class="bin-label-part-check" type="checkbox" value="${escapeHtml(part.partNumber)}" data-index="${escapeHtml(index)}" data-key="${escapeHtml(key)}" ${selectedKeys.has(key) ? 'checked' : ''}></td>
          <td>${escapeHtml(part.binNumber)}</td>
          <td>${partLink(part.partNumber)}</td>
          <td>${escapeHtml(part.partDescription || '')}</td>
          <td>${escapeHtml(part.availableQty || 0)}</td>
        </tr>
      `;
      }).join('') : '<tr><td colspan="5" class="muted">No available parts found for selected bins/search.</td></tr>';
    }
    syncBinLabelSelectAllState();
    setBinLabelMessage(parts.length ? `${parts.length} part(s) loaded. Select part numbers and preview labels.` : 'No available parts found for selected bins.', parts.length ? 'success' : '');
  }

  async function loadBinLabelParts() {
    const dealerCode = cleanDealerCode($('#binLabelDealer')?.value || currentDealerCode());
    const bins = selectedMultiValues($('#binLabelBins'));
    if (!dealerCode) return toast('Dealer required', 'error');
    if (!bins.length) return toast('Select at least one bin', 'error');
    setText('binLabelPartsCount', 'Loading...');
    if ($('#binLabelPartsRows')) $('#binLabelPartsRows').innerHTML = '<tr><td colspan="5" class="muted">Loading parts...</td></tr>';
    const query = new URLSearchParams({ dealerCode });
    bins.forEach((bin) => query.append('bins', bin));
    const data = await api(`/api/bin-transfer/label-parts?${query.toString()}`);
    state.binLabelSelectedKeys = new Set();
    renderBinLabelParts(data.parts || data.rows || []);
    state.binLabelPreviewItems = [];
    state.binLabelSettings = null;
    if ($('#binLabelPreviewArea')) $('#binLabelPreviewArea').innerHTML = '';
    if ($('#binLabelPrintArea')) $('#binLabelPrintArea').innerHTML = '';
    setText('binLabelPreviewCount', '0 labels');
  }

  function applyBinLabelVariables(node, settings = {}) {
    if (!node) return;
    node.style.setProperty('--bin-label-width', `${settings.labelWidthMm || 70}mm`);
    node.style.setProperty('--bin-label-height', `${settings.labelHeightMm || 28}mm`);
    node.style.setProperty('--bin-label-qr', `${settings.qrSizeMm || 20}mm`);
    node.style.setProperty('--bin-label-part-font', `${settings.partFontSize || 12}pt`);
    node.style.setProperty('--bin-label-bin-font', `${settings.binFontSize || 9}pt`);
    node.style.setProperty('--bin-label-weight', settings.boldText === false ? '700' : '900');
  }

  function binLabelCard(item = {}) {
    const parts = Array.isArray(item.parts) && item.parts.length
      ? item.parts
      : (Array.isArray(item.partNumbers) && item.partNumbers.length
        ? item.partNumbers.map((partNumber) => ({ partNumber }))
        : (item.partNumber ? [{ partNumber: item.partNumber, partDescription: item.partDescription }] : []));
    const partCount = parts.length;
    const shrinkClass = partCount > 8 ? ' dense' : partCount > 4 ? ' compact' : '';
    const continuation = Number(item.totalChunks || 1) > 1 ? `<span class="bin-label-continuation">Part list ${escapeHtml(item.chunkNo)} / ${escapeHtml(item.totalChunks)}</span>` : '';
    return `
      <div class="bin-label-card">
        <div class="bin-label-left">
          <img src="${escapeHtml(item.dataUrl || '')}" alt="">
          <strong>${escapeHtml(item.binNumber)}</strong>
        </div>
        <div class="bin-label-right${shrinkClass}">
          <div class="bin-label-part-list">
            ${parts.map((part) => `<strong>${partLink(part.partNumber)}</strong>`).join('')}
          </div>
          ${continuation}
        </div>
      </div>
    `;
  }

  function renderBinLabelPreview(items = [], settings = {}) {
    state.binLabelPreviewItems = items;
    state.binLabelSettings = settings;
    const preview = $('#binLabelPreviewArea');
    const printArea = $('#binLabelPrintArea');
    applyBinLabelVariables(preview, settings);
    applyBinLabelVariables(printArea, settings);
    const html = items.length ? items.map(binLabelCard).join('') : '<div class="muted">Preview will appear here after selecting parts.</div>';
    if (preview) preview.innerHTML = html;
    if (printArea) printArea.innerHTML = items.map(binLabelCard).join('');
    setText('binLabelPreviewCount', `${items.length} labels`);
  }

  async function previewBinLabels() {
    const dealerCode = cleanDealerCode($('#binLabelDealer')?.value || currentDealerCode());
    const bins = selectedMultiValues($('#binLabelBins'));
    const selectedItems = selectedBinLabelParts();
    if (!dealerCode) throw new Error('Dealer required');
    if (!bins.length) throw new Error('Select at least one bin');
    if (!selectedItems.length) throw new Error('Select at least one part number');
    const settings = binLabelSettingsFromForm();
    setBinLabelMessage('Preparing label preview...');
    const data = await api('/api/bin-transfer/labels/preview', {
      method: 'POST',
      body: { dealerCode, bins, selectedItems, ...settings }
    });
    renderBinLabelPreview(data.items || [], data.settings || settings);
    setBinLabelMessage(`${data.count || (data.items || []).length} label(s) ready for print.`, 'success');
    return data;
  }

  async function printBinLabels() {
    const data = await previewBinLabels();
    const items = data.items || [];
    const settings = data.settings || binLabelSettingsFromForm();
    if (!items.length) throw new Error('No labels selected for print');
    const dealerCode = cleanDealerCode($('#binLabelDealer')?.value || currentDealerCode());
    await api('/api/bin-transfer/labels/log', {
      method: 'POST',
      body: { dealerCode, items, settings, deviceId: state.deviceId }
    });
    document.body.classList.add('print-bin-labels');
    window.print();
    setTimeout(() => document.body.classList.remove('print-bin-labels'), 400);
    setBinLabelMessage('Print log saved.', 'success');
  }

  async function exportBinLabelLog() {
    const dealerCode = cleanDealerCode($('#binLabelDealer')?.value || currentDealerCode());
    const query = new URLSearchParams({ format: 'excel' });
    if (dealerCode) query.set('dealerCode', dealerCode);
    await downloadGet(`/api/bin-transfer/labels/logs?${query.toString()}`, 'Daksh_Bin_Label_Print_Log.xlsx');
  }

  function scannerIcon(device = {}) {
    const method = String(device.connectionMethod || device.deviceType || '').toLowerCase();
    if (/usb/.test(method)) return 'USB';
    if (/pda|android/.test(method)) return 'PDA';
    if (/camera/.test(method)) return 'CAM';
    if (/qr/.test(method)) return 'QR';
    return 'WiFi';
  }

  function scannerStatusClass(device = {}) {
    const health = String(device.healthStatus || '').toLowerCase();
    if (device.status !== 'online' || health === 'offline' || health === 'error') return 'red-dot';
    if (health === 'warning' || health === 'low-battery' || Number(device.connectionQuality || 0) < 50) return 'orange-dot';
    return 'green-dot';
  }

  function renderScannerNetworkSummary(data = {}) {
    const node = $('#scannerNetworkSummary');
    if (!node) return;
    const items = [
      ['Connected Mobile Devices', data.activeScannerCount || data.activeCount || 0],
      ['Offline Mobile Devices', data.offlineDevices || 0],
      ['Low Battery', data.lowBatteryCount || 0],
      ['Pending Sync', data.pendingSyncCount || syncCounts().total],
      ['Mobile API', data.wifiOnline ? 'Online' : 'Idle'],
      ['Realtime Sync', data.serverStatus === 'offline' ? 'Offline' : 'Ready']
    ];
    node.innerHTML = items.map(([label, value]) => `
      <div class="scanner-summary-tile"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>
    `).join('');
  }

  async function loadScannerLogs(deviceId = '') {
    const target = $('#scannerLogRows');
    if (!target) return;
    const query = new URLSearchParams({ limit: '30' });
    if (deviceId) query.set('deviceId', deviceId);
    const data = await api(`/api/scanner-network/logs?${query.toString()}`);
    const rows = data.logs || [];
    target.innerHTML = rows.length ? `
      <div class="table-wrap compact-table">
        <table>
          <thead><tr><th>Time</th><th>Device</th><th>Event</th><th>Message</th><th>Part</th><th>Quality</th></tr></thead>
          <tbody>
            ${rows.map((log) => `
              <tr>
                <td>${escapeHtml(compactDateTime(log.createdAt))}</td>
                <td>${deviceLink(log.deviceId)}</td>
                <td>${escapeHtml(log.event || '-')}</td>
                <td>${escapeHtml(log.message || '-')}</td>
                <td>${partLink(log.partNumber)}</td>
                <td>${escapeHtml(log.connectionQuality ?? '-')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    ` : '<div class="muted">No scanner logs yet.</div>';
  }

  function isAdmin() {
    return Boolean(state.user && state.user.role === 'admin');
  }

  async function autoDetectScanners() {
    const data = await api('/api/scanner-network/discover');
    updateScannerStatusBar({
      activeScannerCount: Array.isArray(data.knownDevices) ? data.knownDevices.length : 0,
      connectedDevices: Array.isArray(data.knownDevices) ? data.knownDevices.length : state.activeDeviceCount,
      offlineDevices: data.offlineDevices || 0,
      wifiOnline: true,
      at: new Date()
    });
    setText('networkDebugText', `Mobile discovery active at ${data.serverUrl}. ${data.knownDevices?.length || 0} known mobile/network device(s).`);
    addConnectionLog('Mobile/network auto discovery completed', 'success');
    toast('Mobile/network discovery completed');
    await loadDevices();
  }

  async function manualIpConnect() {
    const value = String($('#manualScannerIp')?.value || '').trim();
    if (!value) return toast('Enter mobile/API device IP or URL', 'error');
    const normalizedUrl = /^https?:\/\//i.test(value) ? value : `http://${value}`;
    const deviceId = `MANUAL-${normalizedUrl.replace(/^https?:\/\//i, '').replace(/[^a-z0-9]+/gi, '-').toUpperCase()}`;
    await api('/api/scanner-network/connect', {
      method: 'POST',
      body: {
        deviceId,
        deviceName: 'Manual IP Mobile/API Device',
        model: normalizedUrl,
        deviceType: 'wifi_scanner',
        connectionMethod: 'manual_ip',
        serverUrl: state.serverInfo ? state.serverInfo.serverUrl : '',
        capabilities: ['manual-ip', 'rest-sync']
      }
    });
    addConnectionLog(`Manual mobile/API device connected: ${normalizedUrl}`, 'success');
    toast('Manual mobile/API device connection saved');
    await loadDevices();
  }

  async function loadDevices() {
    const data = await api('/api/devices');
    const activeCount = Number(data.activeCount || 0);
    const activeScannerCount = Number(data.activeScannerCount ?? activeCount);
    state.activeDeviceCount = activeCount;
    setLivePill('deviceCount', `Devices: ${activeCount} Online`, activeCount > 0);
    setLivePill('syncDeviceCount', `${activeCount} active`, activeCount > 0);
    updateScannerStatusBar(data);
    renderScannerNetworkSummary(data);
    if (data.activeAudit) {
      state.activeAudit = data.activeAudit;
    } else if (data.mobileSyncEnabled === false) {
      state.activeAudit = null;
    }
    updateActiveAuditUi();
    const connected = data.devices || [];
    const oldDevices = data.oldDevices || [];
    $('#deviceRows').innerHTML = connected.length ? connected.map((device) => `
      <div class="device-card">
        <div class="device-card-head">
          <div class="scanner-device-title"><span class="scanner-device-icon">${escapeHtml(scannerIcon(device))}</span><strong>${scannerLink(device)}</strong></div>
          <span class="live-pill ${scannerStatusClass(device)}">${escapeHtml(device.healthStatus || 'Online')}</span>
        </div>
        <span class="muted">${deviceLink(device.deviceId)}</span>
        <div class="scanner-health-grid">
          <span>Type: <strong>${escapeHtml(device.deviceType || '-')}</strong></span>
          <span>Connection: <strong>${escapeHtml(device.connectionMethod || '-')}</strong></span>
          <span>Quality: <strong>${escapeHtml(device.connectionQuality ?? '-')}%</strong></span>
          <span>Signal: <strong>${escapeHtml(device.signalStrength ?? '-')}%</strong></span>
          <span>Battery: <strong>${device.batteryPercent === undefined || device.batteryPercent === null ? '-' : `${escapeHtml(device.batteryPercent)}%`}</strong></span>
          <span>Priority: <strong>${escapeHtml(device.scannerPriority || 0)}</strong></span>
        </div>
        <span>Model: ${escapeHtml(device.model || '-')}</span>
          <span>Dealer Assigned: ${escapeHtml(device.dealerName || device.dealerCode || '-')} ${device.dealerCode ? `(${escapeHtml(device.dealerCode)})` : ''}</span>
        <span>User: ${escapeHtml(device.userName || device.staffName || device.loginId || device.userId || '-')}</span>
        <span>Pending Sync: <strong>${escapeHtml(device.pendingCount || 0)}</strong> ${Number(device.failedCount || 0) ? `| Failed: <strong>${escapeHtml(device.failedCount || 0)}</strong>` : ''}</span>
        <span>IP: ${escapeHtml(device.ipAddress)}</span>
        <span>Connected: ${escapeHtml(dateTime(device.connectedAt || device.createdAt))}</span>
        <span>Last Sync: ${escapeHtml(dateTime(device.lastSyncTime) || 'Never')}</span>
        <span>Last seen: ${escapeHtml(dateTime(device.lastSeen))}</span>
        <span>Last Scan: ${partLink(device.lastScanPartNumber)} ${device.lastScanAt ? `at ${escapeHtml(dateTime(device.lastScanAt))}` : ''}</span>
        <span>App Version: ${escapeHtml(device.appVersion || '-')}</span>
        <div class="actions">
          <button class="btn light viewScannerLogs" data-id="${escapeHtml(device.deviceId)}" type="button">Logs</button>
          <button class="btn light admin-only renameScanner ${state.user && state.user.role === 'admin' ? '' : 'hidden'}" data-id="${escapeHtml(device.deviceId)}" data-name="${escapeHtml(device.deviceName)}" type="button">Rename</button>
          <button class="btn light admin-only priorityScanner ${state.user && state.user.role === 'admin' ? '' : 'hidden'}" data-id="${escapeHtml(device.deviceId)}" data-priority="${escapeHtml(device.scannerPriority || 0)}" type="button">Priority</button>
          <button class="btn light admin-only messageMobileDevice ${state.user && state.user.role === 'admin' && device.deviceType === 'mobile' ? '' : 'hidden'}" data-id="${escapeHtml(device.deviceId)}" type="button">Message</button>
          <button class="btn danger-soft admin-only blockMobileDevice ${state.user && state.user.role === 'admin' && device.deviceType === 'mobile' ? '' : 'hidden'}" data-id="${escapeHtml(device.deviceId)}" data-block="${device.approved === false ? 'false' : 'true'}" type="button">${device.approved === false ? 'Approve Device' : 'Block Device'}</button>
          <button class="btn danger-soft admin-only forceLogoutMobileDevice ${state.user && state.user.role === 'admin' && device.deviceType === 'mobile' ? '' : 'hidden'}" data-id="${escapeHtml(device.deviceId)}" type="button">Force Logout</button>
          <button class="btn danger-soft admin-only disconnectDevice ${state.user && state.user.role === 'admin' ? '' : 'hidden'}" data-id="${escapeHtml(device.deviceId)}" type="button">Disconnect</button>
          <button class="btn light admin-only forceReconnectDevice ${state.user && state.user.role === 'admin' ? '' : 'hidden'}" data-id="${escapeHtml(device.deviceId)}" type="button">Force Reconnect</button>
          <button class="btn danger-soft admin-only removeDevice ${state.user && state.user.role === 'admin' ? '' : 'hidden'}" data-id="${escapeHtml(device.deviceId)}" type="button">Remove Device</button>
        </div>
      </div>
    `).join('') : '<div class="muted">No live devices in the last 30 seconds.</div>';
    const syncRows = $('#syncDeviceRows');
    if (syncRows) {
      syncRows.innerHTML = connected.map((device) => `
        <tr>
          <td>${deviceLink(device.deviceId)}</td>
          <td>${scannerLink(device)}</td>
          <td>${escapeHtml(device.userName || device.staffName || device.loginId || device.userId || '-')}</td>
          <td>${escapeHtml(device.dealerName || device.dealerCode || '-')}</td>
          <td>${escapeHtml(dateTime(device.lastSeen))}</td>
          <td>${escapeHtml(dateTime(device.lastSyncTime) || 'Never')}</td>
          <td>${escapeHtml(device.pendingCount || 0)}</td>
          <td><span class="${scannerStatusClass(device) === 'green-dot' ? 'status-ok' : 'status-warn'}">${escapeHtml(device.healthStatus || 'Online')}</span></td>
          <td><button class="btn danger-soft admin-only disconnectDevice ${state.user && state.user.role === 'admin' ? '' : 'hidden'}" data-id="${escapeHtml(device.deviceId)}" type="button">Disconnect</button></td>
        </tr>
      `).join('');
    }
    const oldRows = $('#oldDeviceRows');
    if (oldRows) {
      oldRows.innerHTML = oldDevices.length ? oldDevices.map((device) => `
        <tr>
          <td>${scannerLink(device)}</td>
          <td>${escapeHtml(device.lastDealerName || device.dealerName || device.lastDealer || device.dealerCode || '-')}</td>
          <td>${escapeHtml(dateTime(device.lastSeen))}</td>
          <td>${escapeHtml(dateTime(device.lastSyncTime) || 'Never')}</td>
          <td><span class="status-warn">${escapeHtml(device.status || 'offline')}</span></td>
          <td>
            <button class="btn light admin-only forceReconnectDevice ${state.user && state.user.role === 'admin' ? '' : 'hidden'}" data-id="${escapeHtml(device.deviceId)}" type="button">Reconnect</button>
            <button class="btn danger-soft admin-only removePermanentDevice ${state.user && state.user.role === 'admin' ? '' : 'hidden'}" data-id="${escapeHtml(device.deviceId)}" type="button">Remove Permanently</button>
          </td>
        </tr>
      `).join('') : '<tr><td colspan="6" class="muted">No disconnected devices.</td></tr>';
    }
    $$('.disconnectDevice').forEach((button) => {
      button.addEventListener('click', async () => {
        await api('/api/scanner-network/disconnect', { method: 'POST', body: { deviceId: button.dataset.id } });
        button.closest('.device-card, tr')?.remove();
        addConnectionLog('Device disconnected', 'warning');
        toast('Device disconnected');
        await loadDevices();
      });
    });
    $$('.forceReconnectDevice').forEach((button) => {
      button.addEventListener('click', async () => {
        await api('/api/scanner-network/reconnect', { method: 'POST', body: { deviceId: button.dataset.id } });
        addConnectionLog('Force reconnect requested', 'warning');
        toast('Reconnect requested');
        await loadDevices();
      });
    });
    $$('.removeDevice, .removePermanentDevice').forEach((button) => {
      button.addEventListener('click', async () => {
        const permanent = button.classList.contains('removePermanentDevice');
        await api('/api/scanner-network/remove', { method: 'POST', body: { deviceId: button.dataset.id, permanent } });
        addConnectionLog(permanent ? 'Old device removed permanently' : 'Device removed', 'warning');
        toast(permanent ? 'Device removed permanently' : 'Device removed');
        await loadDevices();
      });
    });
    $$('.renameScanner').forEach((button) => {
      button.addEventListener('click', async () => {
        const deviceName = window.prompt('Scanner name', button.dataset.name || '');
        if (!deviceName) return;
        await api('/api/scanner-network/rename', { method: 'POST', body: { deviceId: button.dataset.id, deviceName } });
        toast('Scanner renamed');
        await loadDevices();
      });
    });
    $$('.priorityScanner').forEach((button) => {
      button.addEventListener('click', async () => {
        const priority = window.prompt('Scanner priority', button.dataset.priority || '0');
        if (priority === null) return;
        await api('/api/scanner-network/priority', { method: 'POST', body: { deviceId: button.dataset.id, priority } });
        toast('Scanner priority updated');
        await loadDevices();
      });
    });
    $$('.blockMobileDevice').forEach((button) => {
      button.addEventListener('click', async () => {
        const block = button.dataset.block === 'true';
        await api('/api/admin/mobile-device/block', { method: 'POST', body: { deviceId: button.dataset.id, block } });
        toast(block ? 'Mobile device blocked' : 'Mobile device approved');
        await loadDevices();
      });
    });
    $$('.forceLogoutMobileDevice').forEach((button) => {
      button.addEventListener('click', async () => {
        await api('/api/admin/mobile-device/force-logout', { method: 'POST', body: { deviceId: button.dataset.id } });
        toast('Force logout sent');
        await loadDevices();
      });
    });
    $$('.messageMobileDevice').forEach((button) => {
      button.addEventListener('click', async () => {
        const message = window.prompt('Message to mobile device');
        if (!message) return;
        await api('/api/admin/mobile-device/message', { method: 'POST', body: { deviceId: button.dataset.id, message } });
        toast('Message sent');
      });
    });
    $$('.viewScannerLogs').forEach((button) => {
      button.addEventListener('click', () => loadScannerLogs(button.dataset.id).catch((error) => toast(error.message, 'error')));
    });
    loadScannerLogs().catch(() => null);
  }

  async function loadAuthSettings() {
    if (!state.user || state.user.role !== 'admin') return;
    const data = await api('/api/admin/smtp-status');
    renderSmtpSettings(data.smtp || {});
  }

  function smtpPayloadFromForm(form) {
    const payload = formObject(form);
    payload.secure = Boolean($('#smtpSecure')?.checked);
    payload.requireTLS = Boolean($('#smtpRequireTls')?.checked);
    return payload;
  }

  function setSmtpMessage(selector, message, type = 'success') {
    const node = $(selector);
    if (!node) return;
    node.className = `form-message ${type}`;
    node.textContent = message || '';
  }

  function renderSmtpSettings(settings = {}) {
    const smtpEmail = settings.smtpEmail || 'amitsvision4u@gmail.com';
    $('#smtpEmail').value = smtpEmail;
    $('#smtpHost').value = settings.smtpHost || 'smtp.gmail.com';
    $('#smtpPort').value = settings.smtpPort || 587;
    $('#smtpSecure').checked = Boolean(settings.secure);
    $('#smtpRequireTls').checked = settings.requireTLS !== false;
    $('#fromEmail').value = settings.fromEmail || smtpEmail;
    $('#smtpPassword').value = settings.passwordSaved ? '********' : '';
    $('#smtpPassword').disabled = Boolean(settings.passwordSaved);
    $('#smtpPassword').placeholder = settings.passwordSaved ? '********' : 'Enter once during first setup';
    $('#smtpTestEmail').value = settings.fromEmail || smtpEmail;
    $('#smtpStatus').textContent = settings.configured ? 'SMTP Configured OK' : 'SMTP Not Configured';
    $('#smtpStatus').classList.toggle('green-dot', Boolean(settings.configured));
    $('#smtpStatus').classList.toggle('red-dot', !settings.configured);
    setSmtpMessage('#smtpSettingsMessage', settings.passwordSaved ? 'Password Saved Securely' : 'Change Password Required', settings.passwordSaved ? 'success' : 'error');
  }

  function clockSkewCriteria() {
    const form = $('#clockSkewFilters');
    return {
      dealerCode: cleanDealerCode($('[name="dealerCode"]', form)?.value || ''),
      deviceId: String($('[name="deviceId"]', form)?.value || '').trim(),
      userId: String($('[name="userId"]', form)?.value || '').trim(),
      thresholdMinutes: Number($('[name="thresholdMinutes"]', form)?.value || 5),
      sinceDays: Number($('[name="sinceDays"]', form)?.value || 7)
    };
  }

  function setClockSkewMessage(message, type = 'success') {
    const node = $('#clockSkewMessage');
    if (!node) return;
    node.className = `form-message ${type}`;
    node.textContent = message || '';
  }

  function selectedClockSkewDeviceIds() {
    return Array.from(state.clockSkewSelectedIds || []);
  }

  function renderClockSkewRows(rows = []) {
    state.clockSkewRows = rows;
    state.clockSkewSelectedIds = new Set();
    const body = $('#clockSkewRows');
    if (!body) return;
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="8" class="muted">No skewed device records found. Use Load or adjust filters.</td></tr>';
      const selectAll = $('#clockSkewSelectAll');
      if (selectAll) selectAll.checked = false;
      return;
    }
    body.innerHTML = rows.map((item) => `
      <tr>
        <td><input class="clock-skew-select" type="checkbox" data-id="${escapeHtml(item.deviceId || '')}" ${state.clockSkewSelectedIds.has(item.deviceId) ? 'checked' : ''}></td>
        <td>${deviceLink(item.deviceId)}</td>
        <td>${escapeHtml(item.dealerCode || '')}</td>
        <td>${escapeHtml(item.userId || '')}</td>
        <td>${escapeHtml(item.batchId || '')}</td>
        <td>${escapeHtml(item.serverTime || '')}</td>
        <td>${escapeHtml(item.deviceTime || '')}</td>
        <td>${escapeHtml(String(item.skewMs || 0))}</td>
      </tr>
    `).join('');
    $('#clockSkewSelectAll')?.addEventListener('change', (event) => {
      const checked = event.target.checked;
      $$('.clock-skew-select').forEach((box) => {
        box.checked = checked;
        const id = String(box.dataset.id || '').trim();
        if (id) {
          if (checked) state.clockSkewSelectedIds.add(id);
          else state.clockSkewSelectedIds.delete(id);
        }
      });
    });
    $$('.clock-skew-select').forEach((box) => {
      box.addEventListener('change', (event) => {
        const id = String(event.target.dataset.id || '').trim();
        if (!id) return;
        if (event.target.checked) state.clockSkewSelectedIds.add(id);
        else state.clockSkewSelectedIds.delete(id);
      });
    });
  }

  async function loadClockSkewDevices() {
    const criteria = clockSkewCriteria();
    const params = new URLSearchParams();
    if (criteria.dealerCode) params.set('dealerCode', criteria.dealerCode);
    if (criteria.deviceId) params.set('deviceId', criteria.deviceId);
    if (criteria.userId) params.set('userId', criteria.userId);
    params.set('thresholdMinutes', String(criteria.thresholdMinutes || 5));
    params.set('sinceDays', String(criteria.sinceDays || 7));
    setClockSkewMessage('Loading skewed devices...', 'success');
    const data = await api(`/api/admin/clock-skew?${params.toString()}`);
    renderClockSkewRows(data.list || []);
    setClockSkewMessage(`Loaded ${data.count || 0} skewed device(s).`, 'success');
  }

  async function notifySelectedClockSkewDevices() {
    const deviceIds = selectedClockSkewDeviceIds();
    if (!deviceIds.length) {
      setClockSkewMessage('Select at least one device to notify.', 'error');
      return;
    }
    setClockSkewMessage('Sending notify event to selected devices...', 'success');
    const data = await api('/api/admin/clock-skew/notify', {
      method: 'POST',
      body: { deviceIds }
    });
    setClockSkewMessage(data.message || 'Notification queued.', data.success ? 'success' : 'error');
  }

  async function loadMasterScanValidator() {
    const panel = $('#validatorStats');
    if (!panel) return;
    const query = queryFromForm($('#validatorFilters'));
    const data = await api(`/api/master/scan-validator${query ? `?${query}` : ''}`);
    state.validatorInvalidRows = data.invalidRows || data.missingRows || [];
    const stats = [
      ['Total Master Parts', data.totalMasterParts],
      ['Total Scanned Parts', data.scannedPartsCount || data.totalScannedRecords],
      ['Matched With Master', data.scannedPartsMatchedWithMaster],
      ['Invalid Scans', data.scannedPartsNotFoundInMaster],
      ['Duplicate Scans', data.duplicateScanIdCount],
      ['Failed Sync', data.failedSyncRecords]
    ];
    panel.innerHTML = stats.map(([label, value]) => `<div class="metric mini"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || 0)}</strong></div>`).join('');
    const rows = $('#validatorMissingRows');
    if (rows) {
      rows.innerHTML = state.validatorInvalidRows.map((row, index) => `
        <tr class="app-table-row">
          <td><button class="link-button validator-detail-btn" type="button" data-index="${index}">${escapeHtml(row.invalidPart || row.rawScannedValue || '-')}</button></td>
          <td><span class="validator-status-badge duplicate">${escapeHtml(row.scanCount || 0)}</span></td>
          <td>${escapeHtml(row.dealerCode || '-')}</td>
          <td title="${escapeHtml(row.deviceId || '')}">${deviceLink(row.deviceId)}</td>
          <td title="${escapeHtml(row.user || '')}">${escapeHtml(row.user || '-')}</td>
          <td>${escapeHtml(row.lastScanTime ? dateTime(row.lastScanTime) : '-')}</td>
          <td title="${escapeHtml(row.reason || 'Not Found In Master')}">${escapeHtml(row.reason || 'Not Found In Master')}</td>
          <td><span class="validator-status-badge ${row.status === 'mapped' || row.status === 'corrected' ? 'matched' : row.scanCount > 1 ? 'duplicate' : 'invalid'}">${escapeHtml(row.status === 'mapped' || row.status === 'corrected' ? row.status : row.scanCount > 1 ? 'Duplicate' : 'Invalid')}</span></td>
          <td>
            <select class="app-action-dropdown validator-action-dropdown" data-index="${index}" aria-label="Validation action">
              <option value="">Action</option>
              <option value="map">Correct / Map</option>
              <option value="corrected">Mark Corrected</option>
              <option value="ignore">Ignore</option>
              <option value="delete">Delete</option>
            </select>
          </td>
        </tr>
      `).join('') || '<tr><td colspan="9" class="muted">No invalid unmatched scans found.</td></tr>';
      bindValidatorRowActions();
    }
  }

  async function runValidatorAction(endpoint, message) {
    const data = await api(endpoint, { method: 'POST', body: {} });
    toast(data.message || message);
    await loadMasterScanValidator();
  }

  function validatorRowIds(index) {
    const row = state.validatorInvalidRows[Number(index)] || {};
    return (row.detailIds || (row.details || []).map((detail) => detail.id)).filter(Boolean);
  }

  function showValidatorDetails(index) {
    const row = state.validatorInvalidRows[Number(index)] || {};
    $('#validatorDetailTitle').textContent = `Invalid Scan Details - ${row.invalidPart || row.rawScannedValue || ''}`;
    $('#validatorDetailRows').innerHTML = (row.details || []).map((detail) => `
      <tr>
        <td>${escapeHtml(detail.time ? dateTime(detail.time) : '-')}</td>
        <td title="${escapeHtml(detail.rawScannedValue || '')}">${escapeHtml(detail.rawScannedValue || '-')}</td>
        <td title="${escapeHtml(detail.deviceId || '')}">${deviceLink(detail.deviceId)}</td>
        <td title="${escapeHtml(detail.user || '')}">${escapeHtml(detail.user || '-')}</td>
        <td>${escapeHtml(detail.scanType || '-')}</td>
        <td>${escapeHtml(detail.binLocation || '-')}</td>
      </tr>
    `).join('') || '<tr><td colspan="6" class="muted">No scan detail available.</td></tr>';
    $('#validatorDetailModal')?.classList.remove('hidden');
  }

  function closeValidatorMapModal() {
    state.validatorMapIndex = null;
    $('#validatorMapForm')?.reset();
    $('#validatorMapModal')?.classList.add('hidden');
  }

  function openValidatorMapModal(index) {
    state.validatorMapIndex = Number(index);
    const row = state.validatorInvalidRows[state.validatorMapIndex] || {};
    const input = $('#validatorMapPartNumber');
    if (input) {
      input.value = row.invalidPart || '';
      setTimeout(() => input.focus(), 0);
    }
    $('#validatorMapModal')?.classList.remove('hidden');
  }

  async function submitValidatorMap(event) {
    event.preventDefault();
    const index = state.validatorMapIndex;
    const ids = validatorRowIds(index);
    const partNumber = String($('#validatorMapPartNumber')?.value || '').trim();
    if (!ids.length) throw new Error('No invalid scan details selected');
    if (!partNumber) throw new Error('Existing master part number is required');
    const data = await api('/api/master/scan-validator/map', { method: 'POST', body: { ids, partNumber } });
    toast(data.message || 'Invalid scans mapped with existing part');
    closeValidatorMapModal();
    await loadMasterScanValidator();
  }

  async function validatorCorrectionAction(action, index) {
    const ids = validatorRowIds(index);
    if (!ids.length) throw new Error('No invalid scan details selected');
    let endpoint = '';
    let body = { ids };
    if (action === 'ignore') endpoint = '/api/master/scan-validator/ignore';
    if (action === 'corrected') endpoint = '/api/master/scan-validator/mark-corrected';
    if (action === 'delete') {
      if (!window.confirm('Delete these invalid scan records?')) return;
      endpoint = '/api/master/scan-validator/delete-invalid';
    }
    if (action === 'map') {
      openValidatorMapModal(index);
      return;
    }
    const data = await api(endpoint, { method: 'POST', body });
    toast(data.message || 'Validator action complete');
    await loadMasterScanValidator();
  }

  function bindValidatorRowActions() {
    $$('.validator-detail-btn').forEach((button) => button.addEventListener('click', () => showValidatorDetails(button.dataset.index)));
    $$('.validator-action-dropdown').forEach((select) => select.addEventListener('change', () => {
      const action = select.value;
      select.value = '';
      if (!action) return;
      validatorCorrectionAction(action, select.dataset.index).catch((error) => toast(error.message, 'error'));
    }));
  }

  function confirmPermanentDelete() {
    return window.confirm('Are you sure? This will permanently delete selected dealer data.');
  }

  async function deleteDealerScope(scope) {
    const code = cleanDealerCode($('#cleanupDealerCode')?.value || '');
    if (!code) {
      toast('Select dealer first', 'error');
      return;
    }
    if (!confirmPermanentDelete()) return;
    const data = await api(`/api/admin/dealer/${encodeURIComponent(code)}/${scope}`, { method: 'DELETE', body: {} });
    toast(`Deleted: scans ${data.scansDeleted || 0}, master ${data.masterPartsDeleted || 0}, bins ${data.binsDeleted || 0}, dealers ${data.dealersDeleted || 0}`);
    await refreshAll();
  }

  async function deleteCleanupScope() {
    const criteria = cleanupCriteriaFromForm();
    const scope = String(criteria.cleanupScope || '').trim();
    const code = cleanDealerCode(criteria.dealerCode || '');
    if (!scope) {
      toast('Select delete scope first', 'error');
      return;
    }
    if (scope === 'selected-dealer-data' && !code) {
      toast('Select dealer first', 'error');
      return;
    }
    if (!window.confirm(DELETE_CONFIRM_TEXT)) return;
    const data = await api('/api/admin/cleanup-delete', {
      method: 'POST',
      body: { scope, dealerCode: code }
    });
    toast(`Cleanup done: scans ${data.scansDeleted || 0}, verification ${data.verificationDeleted || 0}, bins ${data.binsDeleted || 0}`);
    await refreshAll();
  }

  function clearLocalDealerData() {
    localStorage.removeItem(SYNC_QUEUE_KEY);
    localStorage.removeItem(SYNC_LOG_KEY);
    localStorage.removeItem(LAST_SYNC_KEY);
    renderSyncQueue();
    renderSyncLog();
    toast('Local sync storage cleared');
  }

  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function auditBackupQuery() {
    const params = new URLSearchParams();
    const form = $('#auditBackupFilters');
    if (!form) return params;
    Object.entries(formObject(form)).forEach(([key, value]) => {
      if (String(value || '').trim()) params.set(key, String(value).trim());
    });
    return params;
  }

  function setAuditBackupMessage(message = '', type = '') {
    const box = $('#auditBackupMessage');
    if (!box) return;
    box.className = `form-message ${type}`.trim();
    box.textContent = message;
  }

  function archiveStatusBadge(status) {
    const normalized = String(status || '').toLowerCase();
    const cls = normalized === 'valid' ? 'success' : 'error';
    return `<span class="pill ${cls}">${escapeHtml(status || 'unknown')}</span>`;
  }

  function renderAuditBackups() {
    const rows = state.auditBackups || [];
    const tbody = $('#auditBackupRows');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="muted">No backup archives found in Audit Data.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((archive) => `
      <tr>
        <td>${escapeHtml(archive.dealerCode || '-')}</td>
        <td>${escapeHtml(archive.dealerName || '-')}</td>
        <td>${escapeHtml(archive.auditDate ? String(archive.auditDate).slice(0, 10) : '-')}</td>
        <td>${escapeHtml(formatBytes(archive.backupSize))}</td>
        <td>${escapeHtml(archive.createdBy || '-')}</td>
        <td>${escapeHtml(archive.totalScans || 0)}</td>
        <td>${archiveStatusBadge(archive.backupStatus)}${archive.existingDealer ? '<span class="pill">Dealer exists</span>' : ''}</td>
        <td>
          <div class="archive-row-actions">
            <button class="btn light small preview-audit-backup" data-id="${escapeHtml(archive.archiveId)}" type="button">Preview Backup</button>
            <button class="btn primary small restore-audit-backup" data-id="${escapeHtml(archive.archiveId)}" type="button" ${archive.backupStatus !== 'valid' ? 'disabled' : ''}>Restore Audit</button>
            <button class="btn light small download-audit-backup" data-id="${escapeHtml(archive.archiveId)}" type="button">Download Backup</button>
            <button class="btn danger-soft small remove-audit-backup" data-id="${escapeHtml(archive.archiveId)}" type="button">Delete Backup Permanently</button>
          </div>
        </td>
      </tr>
    `).join('');
  }

  async function loadAuditBackups() {
    const params = auditBackupQuery();
    const data = await api(`/api/audit-backup/list${params.toString() ? `?${params}` : ''}`);
    state.auditBackups = data.archives || [];
    renderAuditBackups();
    setAuditBackupMessage(`Loaded ${state.auditBackups.length} backup archive${state.auditBackups.length === 1 ? '' : 's'} from ${data.archiveDir || 'Audit Data'}.`, 'success');
  }

  function setAuditRestoreProgress(progress = {}) {
    const percent = Math.max(0, Math.min(100, Number(progress.percent || 0)));
    const bar = $('#auditRestoreProgressBar');
    if (bar) bar.style.width = `${percent}%`;
    setText('auditRestoreProgressText', `${progress.status || 'Idle'}${percent ? ` | ${percent}%` : ''}`);
    const logs = $('#auditRestoreLogs');
    if (logs) logs.textContent = (progress.logs || []).join('\n') || 'No restore running.';
    const active = ['started', 'running', 'cancelling'].includes(String(progress.status || '').toLowerCase());
    if ($('#cancelAuditRestoreBtn')) $('#cancelAuditRestoreBtn').disabled = !active || !state.auditRestoreSessionId;
  }

  function stopAuditRestorePoll() {
    if (state.auditRestorePollTimer) clearInterval(state.auditRestorePollTimer);
    state.auditRestorePollTimer = null;
  }

  function startAuditRestorePoll(sessionId) {
    state.auditRestoreSessionId = sessionId;
    stopAuditRestorePoll();
    state.auditRestorePollTimer = setInterval(async () => {
      try {
        const data = await api(`/api/audit-backup/progress/${encodeURIComponent(sessionId)}`);
        setAuditRestoreProgress(data.progress || {});
        const status = String(data.progress?.status || '').toLowerCase();
        if (['completed', 'failed', 'cancelled', 'unknown'].includes(status)) stopAuditRestorePoll();
      } catch (error) {
        console.warn('Restore progress poll failed', error);
      }
    }, 900);
  }

  async function previewAuditBackup(archiveId) {
    const data = await api(`/api/audit-backup/preview?archiveId=${encodeURIComponent(archiveId)}`);
    const archive = data.archive || {};
    setAuditRestoreProgress({
      status: 'preview',
      percent: 0,
      logs: [
        `Archive: ${archive.archiveId}`,
        `Dealer: ${archive.dealerCode || '-'} ${archive.dealerName || ''}`,
        `Audit: ${archive.auditId || '-'} | Date: ${archive.auditDate || '-'}`,
        `Backup size: ${formatBytes(archive.backupSize)} | Total scans: ${archive.totalScans || 0}`,
        `Existing active scan duplicates: ${archive.duplicates?.existingScans || 0}`,
        `Counts: ${JSON.stringify(archive.counts || {})}`
      ]
    });
    toast('Backup preview loaded');
  }

  async function restoreAuditBackup(archiveId) {
    const restoreType = $('#auditRestoreType')?.value || 'complete';
    const restoreMode = $('#auditRestoreMode')?.value || 'merge';
    if (!window.confirm('This will restore archived audit data back into active database.\nDo you want to continue?')) return;
    const archive = state.auditBackups.find((item) => item.archiveId === archiveId);
    if (archive?.existingDealer) {
      const labels = { merge: 'Merge Data', replace: 'Replace Existing', 'new-audit-session': 'Create New Audit Session' };
      if (!window.confirm(`Dealer ${archive.dealerCode} already exists.\nSelected action: ${labels[restoreMode] || restoreMode}.\nContinue?`)) return;
    }
    const sessionId = `RESTORE-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setAuditRestoreProgress({ status: 'started', percent: 1, logs: ['Restore request submitted...'] });
    startAuditRestorePoll(sessionId);
    try {
      const data = await api('/api/audit-backup/restore', {
        method: 'POST',
        body: {
          archiveId,
          restoreType,
          restoreMode,
          restoreSessionId: sessionId
        }
      });
      setAuditRestoreProgress({
        status: 'completed',
        percent: 100,
        logs: [`Restore completed. Total records restored: ${data.totalRecordsRestored || 0}`, `Counts: ${JSON.stringify(data.restored || {})}`]
      });
      toast(data.message || 'Audit restored');
      state.reportCache.clear();
      if (activeReportType() && state.reportHasRun) await loadReport({ forceRefresh: true });
      await refreshAll();
      await loadAuditBackups();
    } catch (error) {
      setAuditRestoreProgress({ status: 'failed', percent: 100, logs: [error.message || 'Restore failed'] });
      toast(error.message, 'error');
    } finally {
      stopAuditRestorePoll();
      if ($('#cancelAuditRestoreBtn')) $('#cancelAuditRestoreBtn').disabled = true;
    }
  }

  async function removeAuditBackup(archiveId) {
    if (!window.confirm('Delete this backup permanently? This cannot be undone.')) return;
    const data = await api(`/api/audit-backup/remove?archiveId=${encodeURIComponent(archiveId)}`, { method: 'DELETE', body: {} });
    toast(data.message || 'Backup removed');
    await loadAuditBackups();
  }

  async function cancelAuditRestore() {
    if (!state.auditRestoreSessionId) return;
    const data = await api(`/api/audit-backup/cancel/${encodeURIComponent(state.auditRestoreSessionId)}`, { method: 'POST', body: {} });
    toast(data.message || 'Restore cancel requested');
  }

  const DELETE_CONFIRM_TEXT = 'Are you sure you want to delete this data? This action cannot be undone.';

  function selectedScanIds() {
    return $$('.scan-history-checkbox:checked').map((box) => box.value).filter(Boolean);
  }

  function cleanupCriteriaFromForm() {
    const form = $('#adminCleanupForm');
    return form ? formObject(form) : {};
  }

  function removeLocalMatching(criteria = {}) {
    const partNumbers = new Set(String(criteria.parts || criteria.partNumbers || criteria.partNumber || '')
      .split(/[\n,;]+/).map((part) => part.trim().toUpperCase().replace(/\s+/g, '')).filter(Boolean));
    const dealerCode = cleanDealerCode(criteria.dealerCode || '');
    const from = criteria.fromDate ? new Date(criteria.fromDate) : null;
    const to = criteria.toDate ? new Date(criteria.toDate) : null;
    if (to && !Number.isNaN(to.getTime())) to.setHours(23, 59, 59, 999);

    const matches = (record = {}) => {
      const recordPart = String(record.normalizedPartNumber || record.partNumber || record.part || '').trim().toUpperCase().replace(/\s+/g, '');
      const recordDealer = cleanDealerCode(record.dealerCode || record.dealer || '');
      const recordTime = new Date(record.timestamp || record.time || record.createdAt || Date.now());
      if (partNumbers.size && !partNumbers.has(recordPart)) return false;
      if (dealerCode && recordDealer !== dealerCode) return false;
      if (from && !Number.isNaN(from.getTime()) && recordTime < from) return false;
      if (to && !Number.isNaN(to.getTime()) && recordTime > to) return false;
      return Boolean(partNumbers.size || dealerCode || criteria.fromDate || criteria.toDate);
    };

    const beforeQueue = getSyncQueue();
    const beforeLog = getSyncLog();
    const queue = beforeQueue.filter((record) => !matches(record));
    const log = beforeLog.filter((record) => !matches(record));
    saveSyncQueue(queue);
    writeJsonStorage(SYNC_LOG_KEY, log);
    renderSyncLog();
    return { localQueueDeleted: beforeQueue.length - queue.length, localLogDeleted: beforeLog.length - log.length };
  }

  async function refreshAfterDelete() {
    await Promise.all([loadDashboard(), loadScanHistory(), loadDealers(), loadCategories(), loadSyncStatus()].map((job) => job.catch ? job : Promise.resolve(job)));
  }

  async function deleteSingleScan(scanId) {
    if (!scanId) {
      toast('Select a scan first', 'error');
      return;
    }
    if (!window.confirm(DELETE_CONFIRM_TEXT)) return;
    await api(`/api/admin/scans/${encodeURIComponent(scanId)}`, { method: 'DELETE', body: {} });
    toast('Scan deleted');
    await refreshAfterDelete();
  }

  async function deleteSelectedScans() {
    const ids = selectedScanIds();
    if (!ids.length) {
      toast('Select scans first', 'error');
      return;
    }
    if (!window.confirm(DELETE_CONFIRM_TEXT)) return;
    await api('/api/admin/scans/delete-selected', { method: 'POST', body: { ids } });
    toast('Selected scans deleted');
    await refreshAfterDelete();
  }

  async function cleanUnknownParts(criteria = {}) {
    if (!window.confirm(DELETE_CONFIRM_TEXT)) return;
    await api('/api/admin/cleanup-unknown-parts', { method: 'POST', body: criteria });
    toast('Unknown part scans cleaned');
    await refreshAfterDelete();
  }

  async function deleteByDealerCode(code) {
    const dealer = cleanDealerCode(code || cleanupCriteriaFromForm().dealerCode || window.prompt('Dealer Code') || '');
    if (!dealer) {
      toast('Dealer code is required', 'error');
      return;
    }
    if (!window.confirm(DELETE_CONFIRM_TEXT)) return;
    await api(`/api/admin/dealer/${encodeURIComponent(dealer)}/scans`, { method: 'DELETE', body: {} });
    toast('Dealer scan data deleted');
    await refreshAfterDelete();
  }

  async function runCleanupAction(action) {
    const criteria = cleanupCriteriaFromForm();
    const source = String(criteria.dataSource || 'server').toLowerCase();
    const runLocal = source === 'local' || source === 'both';
    const runServer = source === 'server' || source === 'both';
    if (!window.confirm(DELETE_CONFIRM_TEXT)) return;
    let localResult = { localQueueDeleted: 0, localLogDeleted: 0 };
    if (runLocal) localResult = removeLocalMatching(criteria);
    if (runServer) {
      if (action === 'single-scan') {
        const ids = selectedScanIds();
        if (!ids.length) throw new Error('Select one scan in Scan History first');
        await api(`/api/admin/scans/${encodeURIComponent(ids[0])}`, { method: 'DELETE', body: {} });
      } else if (action === 'selected-scans') {
        const ids = selectedScanIds();
        if (!ids.length) throw new Error('Select scans in Scan History first');
        await api('/api/admin/scans/delete-selected', { method: 'POST', body: { ids } });
      } else if (action === 'multiple-parts') {
        await api('/api/admin/scans/delete-by-parts', { method: 'POST', body: criteria });
      } else if (action === 'dealer-scans') {
        if (!criteria.dealerCode) throw new Error('Dealer code is required');
        await api(`/api/admin/dealer/${encodeURIComponent(cleanDealerCode(criteria.dealerCode))}/scans`, { method: 'DELETE', body: {} });
      } else if (action === 'dealer-master') {
        if (!criteria.dealerCode) throw new Error('Dealer code is required');
        await api(`/api/admin/dealer/${encodeURIComponent(cleanDealerCode(criteria.dealerCode))}/master`, { method: 'DELETE', body: {} });
      } else if (action === 'dealer-full') {
        if (!criteria.dealerCode) throw new Error('Dealer code is required');
        await api(`/api/admin/dealer/${encodeURIComponent(cleanDealerCode(criteria.dealerCode))}/all`, { method: 'DELETE', body: {} });
      } else if (action === 'unknown') {
        await api('/api/admin/cleanup-unknown-parts', { method: 'POST', body: criteria });
      }
    }
    toast(`Cleanup complete${runLocal ? ` | Local ${localResult.localQueueDeleted}` : ''}`);
    await refreshAfterDelete();
  }

  async function checkPartCleanup(form) {
    const payload = formObject(form);
    const params = new URLSearchParams(payload);
    const data = await api(`/api/admin/part/check?${params.toString()}`);
    const node = $('#partCleanupResult');
    node.className = 'form-message success';
    node.innerHTML = `
      <strong>${escapeHtml(data.normalizedPartNumber)}</strong><br>
      Master: ${escapeHtml(data.masterRecord ? data.masterRecord.partName || 'Found' : 'Not found')}<br>
      Scan count: ${escapeHtml(data.scanCount || 0)}<br>
      Bin locations: ${escapeHtml((data.binLocations || []).join(', ') || '-')}<br>
      Last scan time: ${escapeHtml(data.lastScanTime ? dateTime(data.lastScanTime) : '-') }<br>
      Reports affected: ${escapeHtml((data.reportsAffected || []).join(', ') || '-')}
    `;
  }

  async function checkMultiPartCleanup(form) {
    const payload = formObject(form);
    const data = await api('/api/admin/parts/check', { method: 'POST', body: payload });
    const rows = data.rows || [];
    $('#multiPartPreviewRows').innerHTML = rows.map((row) => `
      <tr>
        <td>${partLink(row.partNumber)}</td>
        <td>${escapeHtml(row.dealer || '-')}</td>
        <td>${escapeHtml(row.scanCount || 0)}</td>
        <td>${escapeHtml(row.lastScanTime ? dateTime(row.lastScanTime) : '-')}</td>
        <td>${row.masterFound ? '<span class="status-ok">Yes</span>' : '<span class="status-warn">No</span>'}</td>
      </tr>
    `).join('') || '<tr><td colspan="5" class="muted">No parts listed</td></tr>';
  }

  async function deletePartScope(scope) {
    const form = $('#partCleanupForm');
    const payload = formObject(form);
    if (!payload.partNumber) {
      toast('Enter part number first', 'error');
      return;
    }
    if (!window.confirm('Are you sure? This will permanently delete selected part data.')) return;
    const data = await api(`/api/admin/part/${scope}`, { method: 'DELETE', body: payload });
    toast(`Part delete complete: ${data.deletedCount ?? data.scansDeleted ?? 0} removed`);
    await refreshAll();
    await checkPartCleanup(form).catch(() => {});
  }

  async function deleteMultiPartScope(scope) {
    const form = $('#multiPartCleanupForm');
    const payload = formObject(form);
    if (!payload.parts || !String(payload.parts).trim()) {
      toast('Enter part numbers first', 'error');
      return;
    }
    if (!window.confirm('Preview checked? This will permanently delete listed part data.')) return;
    const endpoint = scope === 'all' ? '/api/admin/parts/all' : '/api/admin/parts/scans';
    const data = await api(endpoint, { method: 'DELETE', body: payload });
    toast(scope === 'all' ? `Deleted master ${data.masterDeleted || 0}, scans ${data.scansDeleted || 0}` : `Deleted scans ${data.deletedCount || 0}`);
    await refreshAll();
    await checkMultiPartCleanup(form).catch(() => {});
  }

  function setAdminDeleteMessage(message, type = 'success') {
    const node = $('#adminDeleteMessage');
    if (!node) return;
    node.className = `form-message ${type}`;
    node.textContent = message || '';
  }

  function dealerDeleteCriteria() {
    const form = $('#dealerDeleteForm');
    const payload = form ? formObject(form) : {};
    payload.dealerCode = cleanDealerCode(payload.dealerCode || '');
    payload.deleteType = payload.deleteType || 'selected-parts';
    return payload;
  }

  function selectedAdminDeleteIds() {
    return Array.from(state.adminDeleteSelectedIds || []).filter(Boolean);
  }

  function adminDeleteVisibleRows() {
    const query = String($('#dealerDeleteSearch')?.value || '').trim().toLowerCase();
    const rows = state.adminDeleteRows || [];
    if (!query) return rows;
    return rows.filter((row) => [
      row.partNumber,
      row.partDescription,
      row.productCategory,
      row.binLocation,
      row.scanType,
      row.dealerCode,
      row.source,
      row.status
    ].some((value) => String(value || '').toLowerCase().includes(query)));
  }

  function updateAdminDeleteSelectionCount() {
    const visibleRows = adminDeleteVisibleRows();
    const selectedVisible = visibleRows.filter((row) => state.adminDeleteSelectedIds.has(row.id)).length;
    setText('dealerDeleteCount', `Selected: ${selectedAdminDeleteIds().length} | Visible: ${visibleRows.length}`);
    const selectAll = $('#dealerDeleteSelectAll');
    if (selectAll) {
      selectAll.checked = Boolean(visibleRows.length && selectedVisible === visibleRows.length);
      selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visibleRows.length;
    }
  }

  function renderAdminDeleteRows() {
    const rows = adminDeleteVisibleRows();
    const tbody = $('#dealerDeleteRows');
    if (!tbody) return;
    tbody.innerHTML = rows.length ? rows.map((row) => `
      <tr>
        <td><input class="admin-delete-row-check" type="checkbox" value="${escapeHtml(row.id)}" ${state.adminDeleteSelectedIds.has(row.id) ? 'checked' : ''}></td>
        <td title="${escapeHtml(row.partNumber || '')}">${partLink(row.partNumber)}</td>
        <td title="${escapeHtml(row.partDescription || '')}">${escapeHtml(row.partDescription || '-')}</td>
        <td title="${escapeHtml(row.productCategory || '')}">${escapeHtml(row.productCategory || '-')}</td>
        <td title="${escapeHtml(row.binLocation || '')}">${escapeHtml(row.binLocation || '-')}</td>
        <td>${escapeHtml(row.quantity ?? 0)}</td>
        <td>${escapeHtml(row.scanType || '-')}</td>
        <td>${escapeHtml(row.dealerCode || '-')}</td>
        <td>${escapeHtml(row.dateTime ? dateTime(row.dateTime) : '-')}</td>
        <td>${escapeHtml(row.source || '-')}</td>
        <td>${escapeHtml(row.status || '-')}</td>
      </tr>
    `).join('') : '<tr><td colspan="11" class="muted">No rows found for this dealer/filter.</td></tr>';
    $$('.admin-delete-row-check').forEach((box) => {
      box.addEventListener('change', () => {
        if (box.checked) state.adminDeleteSelectedIds.add(box.value);
        else state.adminDeleteSelectedIds.delete(box.value);
        updateAdminDeleteSelectionCount();
      });
    });
    updateAdminDeleteSelectionCount();
  }

  async function showDealerDeleteParts() {
    const criteria = dealerDeleteCriteria();
    if (!criteria.dealerCode) throw new Error('Dealer Code required');
    const params = new URLSearchParams({
      dealerCode: criteria.dealerCode,
      deleteType: criteria.deleteType || '',
      dateFrom: criteria.dateFrom || '',
      dateTo: criteria.dateTo || ''
    });
    const data = await api(`/api/admin-delete/parts?${params.toString()}`);
    state.adminDeleteRows = data.rows || [];
    state.adminDeleteSelectedIds = new Set();
    state.adminDeleteLastPreview = null;
    renderAdminDeleteRows();
    setAdminDeleteMessage(`Loaded ${state.adminDeleteRows.length} rows for dealer ${criteria.dealerCode}`);
  }

  async function previewDealerDelete(options = {}) {
    const criteria = dealerDeleteCriteria();
    if (!criteria.dealerCode) throw new Error('Dealer Code required');
    const ids = options.allDealer ? [] : selectedAdminDeleteIds();
    const body = { ...criteria, ids, allDealer: Boolean(options.allDealer) };
    const data = await api('/api/admin-delete/preview', { method: 'POST', body });
    state.adminDeleteLastPreview = data;
    const total = data.totalCount ?? data.count ?? 0;
    setAdminDeleteMessage(`Preview count: ${total} rows. Scans ${data.scanCount || 0}, master ${data.masterCount || 0}, bins ${data.binCount || 0}, transfers ${data.transferCount || 0}`);
    return data;
  }

  async function deleteDealerSelectedRows() {
    const ids = selectedAdminDeleteIds();
    if (!ids.length) throw new Error('Select at least one row before Delete Selected');
    const preview = await previewDealerDelete();
    const count = Number(preview.totalCount ?? preview.count ?? ids.length);
    if (!count) throw new Error('Preview count is 0. Nothing will be deleted.');
    if (!window.confirm(`Preview count: ${count}. Permanently delete selected rows for dealer ${dealerDeleteCriteria().dealerCode}?`)) return;
    const data = await api('/api/admin-delete/delete-selected', { method: 'POST', body: { dealerCode: dealerDeleteCriteria().dealerCode, ids } });
    toast(`Deleted selected rows: ${data.deletedCount || 0}`);
    await showDealerDeleteParts();
    await refreshAfterDelete();
  }

  async function deleteAllForDealer() {
    const criteria = dealerDeleteCriteria();
    if (!criteria.dealerCode) throw new Error('Dealer Code required');
    const preview = await previewDealerDelete({ allDealer: true });
    const count = Number(preview.totalCount ?? preview.count ?? 0);
    if (!count) throw new Error('Preview count is 0. Nothing will be deleted.');
    if (!window.confirm(`Preview count: ${count}. Permanently delete ALL selected type data for dealer ${criteria.dealerCode}?`)) return;
    const data = await api('/api/admin-delete/delete-all-dealer', { method: 'POST', body: criteria });
    toast(`Dealer delete complete: scans ${data.scansDeleted || 0}, master ${data.masterDeleted || 0}, bins ${data.binsDeleted || 0}, transfers ${data.transferDeleted || 0}`);
    await showDealerDeleteParts().catch(() => {
      state.adminDeleteRows = [];
      renderAdminDeleteRows();
    });
    await refreshAfterDelete();
  }

  function resetDealerDelete() {
    state.adminDeleteRows = [];
    state.adminDeleteSelectedIds = new Set();
    state.adminDeleteLastPreview = null;
    const rows = $('#dealerDeleteRows');
    if (rows) rows.innerHTML = '<tr><td colspan="11" class="muted">Select dealer and click Show Parts.</td></tr>';
    setText('dealerDeleteCount', 'Selected: 0');
    setAdminDeleteMessage('');
  }

  function localDealerDeleteCount(criteria = {}) {
    const dealer = cleanDealerCode(criteria.dealerCode || '');
    const type = String(criteria.dataType || 'scan-data');
    if (!dealer) return { count: 0, queue: 0, log: 0 };
    if (!['scan-data', 'full-dealer-data'].includes(type)) return { count: 0, queue: 0, log: 0 };
    const matches = (record = {}) => cleanDealerCode(record.dealerCode || record.dealer || '') === dealer;
    const queue = getSyncQueue().filter(matches).length;
    const log = getSyncLog().filter(matches).length;
    return { count: queue + log, queue, log };
  }

  function deleteLocalDealerData(criteria = {}) {
    const dealer = cleanDealerCode(criteria.dealerCode || '');
    const type = String(criteria.dataType || 'scan-data');
    if (!dealer || !['scan-data', 'full-dealer-data'].includes(type)) return { deletedCount: 0, queueDeleted: 0, logDeleted: 0 };
    const matches = (record = {}) => cleanDealerCode(record.dealerCode || record.dealer || '') === dealer;
    const beforeQueue = getSyncQueue();
    const beforeLog = getSyncLog();
    const queue = beforeQueue.filter((record) => !matches(record));
    const log = beforeLog.filter((record) => !matches(record));
    saveSyncQueue(queue);
    writeJsonStorage(SYNC_LOG_KEY, log);
    renderSyncQueue();
    renderSyncLog();
    return { deletedCount: (beforeQueue.length - queue.length) + (beforeLog.length - log.length), queueDeleted: beforeQueue.length - queue.length, logDeleted: beforeLog.length - log.length };
  }

  function locationDeleteCriteria() {
    const form = $('#locationDeleteForm');
    const payload = form ? formObject(form) : {};
    payload.dealerCode = cleanDealerCode(payload.dealerCode || '');
    payload.dataLocation = payload.dataLocation || 'local';
    payload.dataType = payload.dataType || 'scan-data';
    return payload;
  }

  async function checkLocationDeleteCount() {
    const criteria = locationDeleteCriteria();
    if (!criteria.dealerCode) throw new Error('Dealer Code required');
    const local = ['local', 'both'].includes(criteria.dataLocation) ? localDealerDeleteCount(criteria) : { count: 0 };
    const server = ['server', 'both'].includes(criteria.dataLocation)
      ? await api('/api/admin-delete/check-location-count', { method: 'POST', body: criteria })
      : { totalCount: 0 };
    const total = Number(local.count || 0) + Number(server.totalCount || server.count || 0);
    state.locationDeleteLastCount = { criteria, local, server, total };
    setText('locationDeleteCount', `Count: ${total} | Local: ${local.count || 0} | Server: ${server.totalCount || server.count || 0}`);
    setAdminDeleteMessage(`Location preview count: ${total}`);
    return state.locationDeleteLastCount;
  }

  async function deleteLocationData() {
    const criteria = locationDeleteCriteria();
    if (!criteria.dealerCode) throw new Error('Dealer Code required');
    const preview = await checkLocationDeleteCount();
    if (!preview.total) throw new Error('Preview count is 0. Nothing will be deleted.');
    if (!window.confirm(`Preview count: ${preview.total}. Permanently delete ${criteria.dataType} from ${criteria.dataLocation} for dealer ${criteria.dealerCode}?`)) return;
    let local = { deletedCount: 0 };
    let server = { deletedCount: 0 };
    if (['local', 'both'].includes(criteria.dataLocation)) local = deleteLocalDealerData(criteria);
    if (['server', 'both'].includes(criteria.dataLocation)) server = await api('/api/admin-delete/delete-location-data', { method: 'POST', body: criteria });
    toast(`Delete complete. Local ${local.deletedCount || 0}, Server ${server.totalDeleted || server.deletedCount || 0}`);
    await checkLocationDeleteCount().catch(() => {});
    await refreshAfterDelete();
  }

  function resetLocationDelete() {
    state.locationDeleteLastCount = null;
    setText('locationDeleteCount', 'Count: 0');
    setAdminDeleteMessage('');
  }

  function switchAdminDeleteTab(tab) {
    $$('.admin-delete-tab').forEach((button) => button.classList.toggle('active', button.dataset.adminDeleteTab === tab));
    $('#dealerDeletePanel')?.classList.toggle('active', tab === 'dealer');
    $('#locationDeletePanel')?.classList.toggle('active', tab === 'location');
  }

  async function loadUsers() {
    if (!state.user || state.user.role !== 'admin') return;
    const data = await api('/api/users');
    state.users = data.users || [];
    renderUsers();
  }

  function renderUsers() {
    renderResetUserOptions();
    $('#userRows').innerHTML = state.users.map((user) => `
      <tr>
        <td>${escapeHtml(user.name)}</td>
        <td>${escapeHtml(user.username)}</td>
        <td>${escapeHtml(user.email)}</td>
        <td>${escapeHtml(user.role === 'mobile_user' ? 'Mobile User' : user.role)}</td>
        <td>${escapeHtml((user.dealerAccess || []).join(', '))}</td>
        <td>${user.approved ? '<span class="status-ok">Approved</span>' : '<span class="status-warn">Pending</span>'}</td>
        <td>${user.active ? '<span class="status-ok">Active</span>' : '<span class="status-warn">Blocked</span>'}</td>
        <td>
          <div class="row-actions">
            <button class="btn light editUserBtn" data-id="${escapeHtml(user.id)}" type="button">Edit</button>
            <button class="btn light approveUserBtn" data-id="${escapeHtml(user.id)}" type="button">Approve</button>
            <button class="btn light toggleUserBtn" data-id="${escapeHtml(user.id)}" data-active="${user.active ? 'false' : 'true'}" type="button">${user.active ? 'Block' : 'Activate'}</button>
            <button class="btn light editUserEmailBtn" data-id="${escapeHtml(user.id)}" data-email="${escapeHtml(user.email)}" type="button">Email</button>
            <button class="btn light sendUserResetBtn" data-id="${escapeHtml(user.id)}" type="button">Send OTP</button>
            <button class="btn danger-soft adminResetUserBtn" data-id="${escapeHtml(user.id)}" type="button">Reset</button>
            <button class="btn danger-soft deleteUserBtn" data-id="${escapeHtml(user.id)}" data-username="${escapeHtml(user.username)}" type="button">Delete</button>
          </div>
        </td>
      </tr>
    `).join('');

    $$('.editUserBtn').forEach((button) => {
      button.addEventListener('click', () => openEditUserModal(button.dataset.id));
    });

    $$('.approveUserBtn').forEach((button) => {
      button.addEventListener('click', async () => {
        await api(`/api/users/${button.dataset.id}/approve`, { method: 'PUT', body: {} });
        toast('User approved');
        await loadUsers();
      });
    });

    $$('.toggleUserBtn').forEach((button) => {
      button.addEventListener('click', async () => {
        await api(`/api/users/${button.dataset.id}/block`, { method: 'PUT', body: { active: button.dataset.active } });
        toast(button.dataset.active === 'true' ? 'User activated' : 'User blocked');
        await loadUsers();
      });
    });

    $$('.editUserEmailBtn').forEach((button) => {
      button.addEventListener('click', async () => {
        const email = window.prompt('Enter new email ID for OTP reset', button.dataset.email || '');
        if (!email) return;
        await api(`/api/auth/users/${button.dataset.id}/email`, { method: 'POST', body: { email } });
        toast('User email updated');
        await loadUsers();
      });
    });

    $$('.sendUserResetBtn').forEach((button) => {
      button.addEventListener('click', async () => {
        const data = await api(`/api/auth/users/${button.dataset.id}/send-reset`, { method: 'POST', body: {} });
        toast(data.message || 'OTP reset link sent', data.mailSent === false ? 'error' : 'success');
      });
    });

    $$('.adminResetUserBtn').forEach((button) => {
      button.addEventListener('click', async () => {
        const password = window.prompt('Enter new password for this user');
        if (!password) return;
        await api(`/api/auth/users/${button.dataset.id}/reset-password`, { method: 'POST', body: { password } });
        toast('Password reset by admin');
        await loadUsers();
      });
    });

    $$('.deleteUserBtn').forEach((button) => {
      button.addEventListener('click', async () => {
        if (state.user && String(state.user.id) === String(button.dataset.id)) {
          toast('You cannot delete your own logged-in admin user', 'error');
          return;
        }
        const username = button.dataset.username || 'this user';
        if (!window.confirm(`Delete user "${username}" permanently? This user will not be able to login.`)) return;
        await api(`/api/users/${button.dataset.id}`, { method: 'DELETE', body: {} });
        toast('User deleted. Login blocked for that user.');
        await loadUsers();
      });
    });
  }

  function showCreatedUser(user) {
    if (!user) return;
    const userId = String(user.id || user._id || '');
    const username = String(user.username || '').toLowerCase();
    const existingIndex = state.users.findIndex((item) => (
      (userId && String(item.id || item._id || '') === userId) ||
      (username && String(item.username || '').toLowerCase() === username)
    ));
    if (existingIndex >= 0) state.users.splice(existingIndex, 1, user);
    else state.users.unshift(user);
    renderUsers();
  }

  function openEditUserModal(id) {
    const user = state.users.find((item) => String(item.id) === String(id));
    if (!user) {
      toast('User not found', 'error');
      return;
    }
    const form = $('#editUserForm');
    $('#editUserMessage').textContent = '';
    form.elements.id.value = user.id || '';
    form.elements.name.value = user.name || '';
    form.elements.username.value = user.username || '';
    form.elements.email.value = user.email || '';
    form.elements.role.value = user.role || 'staff';
    form.elements.dealerAccess.value = (user.dealerAccess || []).join(', ');
    form.elements.password.value = '';
    form.elements.pin.value = '';
    form.elements.approved.checked = user.approved !== false;
    form.elements.active.checked = user.active !== false;
    $('#editUserModal').classList.remove('hidden');
  }

  function closeEditUserModal() {
    $('#editUserModal')?.classList.add('hidden');
  }

  async function saveEditedUser(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const message = $('#editUserMessage');
    message.className = 'form-message';
    message.textContent = '';
    const payload = formObject(form);
    const id = payload.id;
    const password = String(payload.password || '');
    const pin = String(payload.pin || '').trim();
    if (!id) throw new Error('User not found');
    if (pin && !/^\d{4}$/.test(pin)) throw new Error('PIN must be exactly 4 digits');
    await api(`/api/users/${id}`, {
      method: 'PUT',
      body: {
        name: payload.name,
        username: payload.username,
        email: payload.email,
        role: payload.role,
        dealerAccess: cleanDealerAccessInput(payload.dealerAccess),
        approved: form.elements.approved.checked,
        active: form.elements.active.checked
      }
    });
    if (password || pin) {
      await api(`/api/users/${id}/password`, {
        method: 'PUT',
        body: {
          ...(password ? { password } : {}),
          ...(pin ? { pin } : {})
        }
      });
    }
    message.className = 'form-message success';
    message.textContent = 'User updated';
    toast('User updated');
    await loadUsers();
    closeEditUserModal();
  }

  function renderResetUserOptions() {
    const select = $('#resetUsernameSelect');
    if (!select) return;
    const selected = select.value;
    select.innerHTML = '<option value="">Select user</option>' + state.users.map((user) => (
      `<option value="${escapeHtml(user.username)}">${escapeHtml(user.name || user.username)} (${escapeHtml(user.username)} - ${escapeHtml(user.role)})</option>`
    )).join('');
    select.value = selected;
  }

  async function loadPairingQr() {
    const dealerCode = currentDealerCode();
    const data = await api(`/api/qr/pairing?dealerCode=${encodeURIComponent(dealerCode)}`);
    applyServerInfo(data);
    if (data.activeAudit) state.activeAudit = data.activeAudit;
    updateActiveAuditUi();
    setText('pairingStatusText', data.connectionStatus || (data.activeAudit ? 'Ready for mobile pairing' : 'Mobile sync disabled'));
    $('#pairingQrImage').src = data.dataUrl;
    const syncImage = $('#syncPairingQrImage');
    if (syncImage) syncImage.src = data.dataUrl;
    setText('syncQrPayload', data.value || JSON.stringify(data.pairing || {}));
    addConnectionLog('QR refreshed', data.activeAudit ? 'success' : 'warning');
  }

  async function copyTextValue(value, label) {
    if (!value) throw new Error(`${label} is not available`);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const input = document.createElement('input');
      input.value = value;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
    }
    toast(`${label} copied`);
  }

  async function copyServerUrl() {
    if (!state.serverInfo || !state.serverInfo.serverUrl) await loadPairingQr();
    const url = state.serverInfo ? state.serverInfo.serverUrl : '';
    if (!url || isLocalhostUrl(url)) {
      toast('Do not use localhost on mobile. Use the cloud server URL from pairing QR.', 'error');
      return;
    }
    await copyTextValue(url, 'Server URL');
  }

  async function copyHealthUrl() {
    if (!state.serverInfo || !state.serverInfo.healthUrl) await loadPairingQr();
    await copyTextValue(state.serverInfo.healthUrl, 'Health URL');
  }

  async function testConnection() {
    try {
      const data = await loadHealth();
      setLivePill('pairingConnectionStatus', 'Server Reachable', true);
      setText('pairingStatusText', 'Server Reachable');
      addConnectionLog('Health API success', 'success');
      toast(data.success ? 'Server Reachable' : 'Connection checked');
      return data;
    } catch (error) {
      setLivePill('pairingConnectionStatus', 'Connection Failed', false);
      setText('pairingStatusText', 'Connection Failed');
      addConnectionLog(`Connection Failed: ${error.message}`, 'error');
      throw error;
    }
  }

  async function runNetworkTest() {
    const data = await api('/api/devices/network-test');
    applyServerInfo(data);
    const firewallText = data.firewallBlocked ? 'Firewall may be blocking mobile access' : 'Port open on this server';
    setText('networkDebugText', `Server: ${data.serverUrl || data.healthUrl || '-'} | ${firewallText}. Cloud sync works across networks.`);
    addConnectionLog(`Network test: ${firewallText}`, data.firewallBlocked ? 'warning' : 'success');
    toast('Network test completed');
  }

  async function createQr(form, endpoint, imageId) {
    const params = new URLSearchParams(formObject(form)).toString();
    const data = await api(`${endpoint}?${params}`);
    $(`#${imageId}`).src = data.dataUrl;
  }

  async function refreshAll() {
    await loadActiveAudit({ silent: true }).catch(() => null);
    await loadDealers();
    await Promise.all([
      loadCategories(),
      loadDashboard(),
      loadScanHistory(),
      loadBins(),
      loadDevices(),
      loadBinTransferHistory(),
      loadPairingQr(),
      loadAuthSettings(),
      loadUsers(),
      loadSyncStatus(),
      loadMasterScanValidator(),
      loadPartSearchFilters()
    ]);
    renderSyncQueue();
    renderSyncLog();
    renderConnectionLog();
  }

  function startDashboardFallbackRefresh() {
    if (state.dashboardFallbackTimer) clearInterval(state.dashboardFallbackTimer);
    state.dashboardFallbackTimer = setInterval(async () => {
      if (document.hidden || state.dashboardFallbackBusy) return;
      const realtimeQuietMs = Date.now() - Number(state.lastRealtimeAt || 0);
      if (realtimeQuietMs < 5000) return;
      state.dashboardFallbackBusy = true;
      try {
        await Promise.all([loadDashboard(), loadSyncStatus(), loadDevices()]);
        console.log('[DASHBOARD] fallback refresh success');
      } catch (error) {
        console.warn('[DASHBOARD] fallback refresh failed', error.message);
      } finally {
        state.dashboardFallbackBusy = false;
      }
    }, 5000);
  }

  function bulkQrOptions() {
    return {
      paperSize: $('#qrPaperSize').value,
      orientation: $('#qrOrientation').value,
      paperWidthMm: Number($('#qrPaperWidth').value || 210),
      paperHeightMm: Number($('#qrPaperHeight').value || 297),
      qrSizeMm: Number($('#qrSizeMm').value || 44),
      columns: Number($('#qrColumns').value || 2),
      marginMm: Number($('#qrMarginMm').value || 10),
      labelFontSize: Number($('#qrLabelFont').value || 9)
    };
  }

  function selectedLabelBins() {
    return $('#labelSelectedBins').value
      .split(/[\n,]+/)
      .map((value) => cleanDealerCode(value))
      .filter(Boolean);
  }

  function labelOptions(format = 'json') {
    return {
      format,
      mode: $('#labelMode').value,
      dealerCode: cleanDealerCode($('#labelDealerSelect').value),
      binLocation: cleanDealerCode($('#labelBinSelect').value),
      category: $('#labelCategory').value.trim(),
      selectedBins: selectedLabelBins(),
      rangeFrom: cleanDealerCode($('#labelRangeFrom').value),
      rangeTo: cleanDealerCode($('#labelRangeTo').value),
      labelWidthMm: Number($('#labelWidthMm').value || 70),
      labelHeightMm: Number($('#labelHeightMm').value || 28),
      qrSizeMm: Number($('#labelQrSizeMm').value || 20),
      fontSize: Number($('#labelFontSize').value || 8),
      partFontSize: Number($('#labelPartFontSize').value || 11),
      descriptionFontSize: Number($('#labelDescriptionFontSize').value || 7),
      marginMm: Number($('#labelMarginMm').value || 8),
      gapMm: Number($('#labelGapMm').value || 3),
      labelsPerRow: Number($('#labelLabelsPerRow').value || 2),
      paperSize: $('#labelPaperSize').value,
      orientation: $('#labelOrientation').value,
      paperWidthMm: Number($('#labelPaperWidthMm').value || 210),
      paperHeightMm: Number($('#labelPaperHeightMm').value || 297)
    };
  }

  async function loadLabelBins() {
    const dealerCode = cleanDealerCode($('#labelDealerSelect').value);
    const category = $('#labelCategory').value.trim();
    const query = new URLSearchParams();
    if (dealerCode) query.set('dealerCode', dealerCode);
    if (category) query.set('category', category);
    const data = await api(`/api/qr/bins?${query.toString()}`);
    const selected = $('#labelBinSelect').value;
    $('#labelBinSelect').innerHTML = '<option value="">All bins</option>' + (data.bins || []).map((bin) => (
      `<option value="${escapeHtml(bin.binLocation || bin.binCode)}">${escapeHtml(bin.binLocation || bin.binCode)}${bin.category ? ` - ${escapeHtml(bin.category)}` : ''}</option>`
    )).join('');
    $('#labelBinSelect').value = Array.from($('#labelBinSelect').options).some((option) => option.value === selected) ? selected : '';
    toast(`Loaded ${(data.bins || []).length} bins`);
    return data.bins || [];
  }

  async function loadBarcodeBins() {
    const dealerCode = cleanDealerCode($('[name="dealerCode"]', $('#barcodeScanForm'))?.value || currentDealerCode());
    const list = $('#barcodeBinOptions');
    if (!list || !dealerCode) return [];
    const data = await api(`/api/qr/bins?dealerCode=${encodeURIComponent(dealerCode)}`);
    const bins = data.bins || [];
    list.innerHTML = bins.map((bin) => {
      const value = cleanDealerCode(bin.binLocation || bin.binCode || bin.bin || '');
      return value ? `<option value="${escapeHtml(value)}">${escapeHtml(bin.binName || bin.category || value)}</option>` : '';
    }).join('');
    return bins;
  }

  function restoreBarcodeScanDefaults() {
    const form = $('#barcodeScanForm');
    if (!form) return;
    $('#barcodeDeviceId').value = ensureDeviceId();
    $('[name="qty"]', form).value = $('[name="qty"]', form).value || 1;
    const savedBin = localStorage.getItem(BARCODE_LAST_BIN_KEY) || '';
    if (savedBin && !$('[name="binLocation"]', form).value) $('[name="binLocation"]', form).value = savedBin;
    updateScanTypeFields(form);
    setLivePill('barcodeAutoSaveStatus', 'Auto Save: ON', true);
  }

  function fillBarcodePartFromRaw() {
    const form = $('#barcodeScanForm');
    const raw = $('#barcodeRaw')?.value || '';
    const parsed = parseRawScanText(raw);
    if (parsed.partNumber) $('[name="part"]', form).value = parsed.partNumber;
    if (parsed.qty) $('[name="qty"]', form).value = parsed.qty || 1;
    return parsed;
  }

  function resetBarcodeScanFields(form, normalized = {}, expectedRaw = '') {
    const rawInput = $('textarea[name="rawScan"]', form);
    const rawStillCurrent = !expectedRaw || normalizePartText(rawInput?.value || '') === normalizePartText(expectedRaw);
    if (rawStillCurrent) {
      if (rawInput) rawInput.value = '';
      $('[name="part"]', form).value = '';
      $('[name="qty"]', form).value = 1;
    } else {
      fillBarcodePartFromRaw();
    }
    const scanType = String($('[name="type"]', form)?.value || normalized.scanType || normalized.type || '').toUpperCase();
    if (['INWARD', 'DAMAGE'].includes(scanType)) $('[name="binLocation"]', form).value = normalized.binLocation || $('[name="binLocation"]', form).value || '';
    $('#barcodeDeviceId').value = ensureDeviceId();
    updateScanTypeFields(form);
    return rawStillCurrent;
  }

  function scheduleBarcodeAutosave(delay = 120) {
    const form = $('#barcodeScanForm');
    const raw = String($('#barcodeRaw')?.value || '').trim();
    if (!form || !raw || state.barcodeAutoSaving) return;
    const normalizedRaw = normalizePartText(raw);
    const now = Date.now();
    if (state.barcodeLastRaw === normalizedRaw && now - state.barcodeLastAt < 2000) {
      setLivePill('barcodeReadyStatus', 'Duplicate blocked', false);
      playScanTone('duplicate');
      setTimeout(() => {
        $('#barcodeRaw').value = '';
        $('#barcodeRaw').focus();
        setLivePill('barcodeReadyStatus', 'Ready for Scan', true);
      }, 850);
      return;
    }
    clearTimeout($('#barcodeRaw').autoSaveTimer);
    $('#barcodeRaw').autoSaveTimer = setTimeout(async () => {
      if (state.barcodeAutoSaving) return;
      const scanType = String($('[name="type"]', form)?.value || 'INWARD').toUpperCase();
      const bin = normalizePartText($('[name="binLocation"]', form)?.value || '');
      if (['INWARD', 'DAMAGE'].includes(scanType) && !bin) {
        playScanTone('error');
        toast('Please enter/select bin location before scanning.', 'error');
        setLivePill('barcodeReadyStatus', 'Enter Bin Location', false);
        $('#barcodeBinLocation')?.focus();
        return;
      }
      state.barcodeAutoSaving = true;
      state.barcodeLastRaw = normalizedRaw;
      state.barcodeLastAt = Date.now();
      setLivePill('barcodeReadyStatus', 'Saving...', true);
      fillBarcodePartFromRaw();
      try {
        await submitScan(form, { backgroundRefresh: true, expectedRaw: raw });
      } finally {
        state.barcodeAutoSaving = false;
        const nextRaw = String($('#barcodeRaw')?.value || '').trim();
        if (nextRaw && normalizePartText(nextRaw) !== normalizedRaw) scheduleBarcodeAutosave(40);
      }
    }, delay);
  }

  function labelEndpoint() {
    return $('#labelMode').value === 'bin' ? '/api/qr/generate-bin-labels' : '/api/qr/generate-part-labels';
  }

  function renderLabelPreview(items = []) {
    setLivePill('labelPreviewCount', `${items.length} labels`, items.length > 0);
    const body = $('#labelPreviewRows');
    body.innerHTML = items.length ? items.map((item) => `
      <tr>
        <td>${item.partNumber ? partLink(item.partNumber) : escapeHtml(item.binLocation || item.binCode)}</td>
        <td>${escapeHtml(item.partDescription || item.binName || '')}</td>
        <td>${escapeHtml(item.category || '')}</td>
        <td>${escapeHtml(item.binLocation || item.binCode || '')}</td>
        <td>${escapeHtml(item.dealerCode || '')}</td>
        <td>${escapeHtml(item.qty || '')}</td>
      </tr>
    `).join('') : '<tr><td colspan="6" class="muted">No labels previewed yet.</td></tr>';
    $('#labelPrintArea').innerHTML = items.map((item) => `
      <div class="label-preview-card">
        <img src="${escapeHtml(item.dataUrl || '')}" alt="">
        <div>
          <strong>${item.partNumber ? partLink(item.partNumber) : escapeHtml(item.binLocation || item.binCode)}</strong>
          <span>${escapeHtml(item.partDescription || item.binName || '')}</span>
          <span>BIN: ${escapeHtml(item.binLocation || item.binCode || '')}</span>
          <span>${escapeHtml(item.category || '')} ${item.dealerCode ? `| Dealer: ${escapeHtml(item.dealerCode)}` : ''}</span>
        </div>
      </div>
    `).join('');
  }

  async function previewLabels() {
    const payload = labelOptions('json');
    const data = await api(labelEndpoint(), { method: 'POST', body: payload });
    renderLabelPreview(data.items || []);
    return data.items || [];
  }

  async function downloadLabels(format) {
    const endpoint = labelEndpoint();
    const names = {
      pdf: $('#labelMode').value === 'bin' ? 'Daksh_Bin_QR_Labels.pdf' : 'Daksh_Part_Labels.pdf',
      excel: $('#labelMode').value === 'bin' ? 'Daksh_Bin_QR_List.xlsx' : 'Daksh_Part_Label_List.xlsx',
      zip: $('#labelMode').value === 'bin' ? 'Daksh_Bin_QR_PNG.zip' : 'Daksh_Part_Label_QR_PNG.zip'
    };
    await downloadPost(endpoint, labelOptions(format), names[format]);
  }

  async function printLabels() {
    await previewLabels();
    document.body.classList.add('print-labels');
    window.print();
    setTimeout(() => document.body.classList.remove('print-labels'), 500);
  }

  function openView(viewId, title) {
    if (!$(`#${viewId}`)) viewId = 'dashboard';
    localStorage.setItem(ACTIVE_VIEW_KEY, viewId);
    document.body.classList.toggle('dashboard-view-active', viewId === 'dashboard');
    $$('.side-link').forEach((item) => item.classList.toggle('active', item.dataset.view === viewId));
    $$('.view').forEach((view) => view.classList.remove('active'));
    const target = $(`#${viewId}`);
    if (target) target.classList.add('active');
    $('#viewTitle').textContent = VIEW_TITLES[viewId] || title || viewId;
    if (viewId === 'binTransfer') {
      const dealerCode = binTransferCriteria().dealerCode;
      if (dealerCode) loadBinTransferBins(dealerCode).then(() => loadBinTransferHistory()).catch((error) => toast(error.message, 'error'));
      else loadBinTransferHistory().catch((error) => toast(error.message, 'error'));
    }
    if (viewId === 'archiveRestore') {
      loadAuditBackups().catch((error) => toast(error.message, 'error'));
    }
  }

  function restoreActiveViewShell() {
    const params = new URLSearchParams(window.location.search);
    const requestedView = params.get('view') || '';
    const savedView = requestedView || localStorage.getItem(ACTIVE_VIEW_KEY) || 'dashboard';
    const viewId = $(`#${savedView}`) ? savedView : 'dashboard';
    openView(viewId, VIEW_TITLES[viewId]);
    if (viewId === 'reports') {
      restoreReportState();
      const reportType = params.get('reportType');
      if (reportType && REPORT_TITLES[reportType]) setReportTab(reportType, { persist: false });
    }
    return { viewId };
  }

  async function finishRestoredViewLoad(restored = {}) {
    if (restored.viewId === 'reports') {
      resetReportPreview('Saved report filters loaded. Click Submit to fetch report data.');
    }
  }

  function bindNavigation() {
    $$('.side-link').forEach((button) => {
      button.addEventListener('click', () => {
        openView(button.dataset.view, button.textContent.trim());
      });
    });
    $$('.subtab').forEach((button) => {
      button.addEventListener('click', () => {
        $$('.subtab').forEach((item) => item.classList.remove('active'));
        button.classList.add('active');
        $$('.subview').forEach((view) => view.classList.remove('active'));
        $(`#${button.dataset.subview}`).classList.add('active');
      });
    });
    $$('.master-tab').forEach((button) => {
      button.addEventListener('click', () => {
        const target = button.dataset.masterTab;
        $$('.master-tab').forEach((item) => {
          const active = item === button;
          item.classList.toggle('active', active);
          item.setAttribute('aria-selected', String(active));
        });
        $$('.master-tab-panel').forEach((panel) => {
          const active = panel.id === target;
          panel.classList.toggle('active', active);
          panel.hidden = !active;
        });
      });
    });
    $$('.bin-transfer-tab').forEach((button) => {
      button.addEventListener('click', () => {
        const target = button.dataset.binTransferTab;
        $$('.bin-transfer-tab').forEach((item) => {
          const active = item === button;
          item.classList.toggle('active', active);
          item.setAttribute('aria-selected', String(active));
        });
        $$('.bin-transfer-panel').forEach((panel) => {
          const active = panel.id === target;
          panel.classList.toggle('active', active);
          panel.hidden = !active;
        });
        if (target === 'binSequenceTab') {
          loadBins().catch((error) => toast(error.message, 'error'));
        } else if (target === 'binLabelPrintTab') {
          loadBinLabelBins(cleanDealerCode($('#binLabelDealer')?.value || currentDealerCode())).catch((error) => toast(error.message, 'error'));
        } else if (target === 'binTransferHistoryTab') {
          loadBinTransferHistory().catch((error) => toast(error.message, 'error'));
        } else {
          const { dealerCode, fromBin, toBin } = binTransferCriteria(activeBinTransferForm());
          loadBinTransferDestinationBins(dealerCode, fromBin, toBin).catch((error) => toast(error.message, 'error'));
          renderBinTransferParts(state.binTransferParts, state.binTransferParts.length ? '' : 'Click Show Parts to load available scanned parts.');
        }
      });
    });
    $$('.qr-tool-tab').forEach((button) => {
      button.addEventListener('click', () => {
        const target = button.dataset.qrPanel;
        $$('.qr-tool-tab').forEach((item) => item.classList.toggle('active', item === button));
        $$('.qr-tool-panel').forEach((panel) => panel.classList.toggle('active', panel.id === target));
        if (target === 'qrBulkLabelPanel') loadLabelBins().catch(console.warn);
      });
    });
  }

  function bindEvents() {
    if (state.eventsBound) return;
    state.eventsBound = true;
    $('#logoutBtn')?.addEventListener('click', logout);
    $('#userMenuButton')?.addEventListener('click', (event) => {
      event.stopPropagation();
      setUserMenuOpen($('#userDropdown')?.hidden !== false);
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest('#userMenu')) setUserMenuOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setUserMenuOpen(false);
    });
    window.addEventListener('resize', () => fitDashboardDealerSelect());
    $('#copyServerUrlBtn').addEventListener('click', () => copyServerUrl().catch((error) => toast(error.message, 'error')));
    $('#copyHealthUrlBtn')?.addEventListener('click', () => copyHealthUrl().catch((error) => toast(error.message, 'error')));
    $('#testConnectionBtn')?.addEventListener('click', () => testConnection().catch((error) => toast(error.message, 'error')));
    $('#refreshPairingQrBtn')?.addEventListener('click', () => loadPairingQr().then(() => toast('QR refreshed')).catch((error) => toast(error.message, 'error')));
    $('#openPairingQrBtn')?.addEventListener('click', () => loadPairingQr().then(() => toast('Pairing QR ready')).catch((error) => toast(error.message, 'error')));
    $('#autoDetectScannersBtn')?.addEventListener('click', () => autoDetectScanners().catch((error) => toast(error.message, 'error')));
    $('#manualIpConnectBtn')?.addEventListener('click', () => manualIpConnect().catch((error) => toast(error.message, 'error')));
    $('#networkTestBtn')?.addEventListener('click', () => runNetworkTest().catch((error) => toast(error.message, 'error')));
    $('#productGroupSearch')?.addEventListener('input', () => renderProductGroupSummary());
    $('#productGroupExportBtn')?.addEventListener('click', () => exportProductGroupSummary().catch((error) => toast(error.message, 'error')));
    $('#productGroupSummaryRows')?.addEventListener('click', (event) => {
      const button = event.target.closest('.product-group-detail-link');
      if (!button) return;
      loadProductGroupDetails(button.dataset.productGroup, button.dataset.partSubGroup).catch((error) => toast(error.message, 'error'));
    });
    $('#productGroupDetailExportBtn')?.addEventListener('click', () => exportProductGroupDetails().catch((error) => toast(error.message, 'error')));
    $('#clearConnectionLogsBtn')?.addEventListener('click', () => clearConnectionLogs().catch((error) => toast(error.message, 'error')));
    $('#syncCopyServerUrlBtn').addEventListener('click', () => copyServerUrl().catch((error) => toast(error.message, 'error')));
    $('#loadLabelBinsBtn')?.addEventListener('click', () => loadLabelBins().catch((error) => toast(error.message, 'error')));
    $('#labelDealerSelect')?.addEventListener('change', () => loadLabelBins().catch((error) => toast(error.message, 'error')));
    $('#barcodeBinLocation')?.addEventListener('input', (event) => {
      event.target.value = cleanDealerCode(event.target.value);
      localStorage.setItem(BARCODE_LAST_BIN_KEY, event.target.value);
      setLivePill('barcodeReadyStatus', event.target.value ? 'Ready for Scan' : 'Enter Bin Location', Boolean(event.target.value));
    });
    $('#clearBarcodeBin')?.addEventListener('click', () => {
      $('#barcodeBinLocation').value = '';
      localStorage.removeItem(BARCODE_LAST_BIN_KEY);
      setLivePill('barcodeReadyStatus', 'Enter Bin Location', false);
      $('#barcodeBinLocation').focus();
    });
    $('#loadClockSkewBtn')?.addEventListener('click', () => loadClockSkewDevices().catch((error) => toast(error.message, 'error')));
    $('#loadClockSkewFiltersBtn')?.addEventListener('click', () => loadClockSkewDevices().catch((error) => toast(error.message, 'error')));
    $('#notifyClockSkewBtn')?.addEventListener('click', () => notifySelectedClockSkewDevices().catch((error) => toast(error.message, 'error')));
    $('#binManagementDealer')?.addEventListener('change', () => {
      $('#binMasterRows').innerHTML = '<tr><td colspan="5" class="muted">Loading BIN locations...</td></tr>';
      loadBins().catch((error) => toast(error.message, 'error'));
    });
    $('#binManagementSearch')?.addEventListener('input', () => {
      clearTimeout($('#binManagementSearch').searchTimer);
      $('#binManagementSearch').searchTimer = setTimeout(() => loadBins().catch((error) => toast(error.message, 'error')), 250);
    });
    $('#refreshBinManagementBtn')?.addEventListener('click', () => loadBins().catch((error) => toast(error.message, 'error')));
    $('#exportBinMasterBtn')?.addEventListener('click', () => exportBinMaster().catch((error) => toast(error.message, 'error')));
    $('#deleteSelectedBinsBtn')?.addEventListener('click', () => deleteSelectedBins().catch((error) => toast(error.message, 'error')));
    $('#deleteAllDealerBinsBtn')?.addEventListener('click', () => deleteAllDealerBins().catch((error) => toast(error.message, 'error')));
    $('#selectAllBins')?.addEventListener('change', (event) => {
      $$('.bin-management-check').forEach((box) => { box.checked = event.target.checked; });
    });
    $('#binMasterRows')?.addEventListener('click', (event) => {
      const editButton = event.target.closest('.edit-bin-btn');
      if (editButton) {
        editBin(editButton.dataset.id).catch((error) => toast(error.message, 'error'));
        return;
      }
      const deleteButton = event.target.closest('.delete-bin-btn');
      if (deleteButton) deleteSingleBin(deleteButton.dataset.id).catch((error) => toast(error.message, 'error'));
    });
    $('#previewLabelsBtn')?.addEventListener('click', () => previewLabels().catch((error) => toast(error.message, 'error')));
    $('#printLabelsBtn')?.addEventListener('click', () => printLabels().catch((error) => toast(error.message, 'error')));
    $('#downloadLabelPdfBtn')?.addEventListener('click', () => downloadLabels('pdf').catch((error) => toast(error.message, 'error')));
    $('#downloadLabelExcelBtn')?.addEventListener('click', () => downloadLabels('excel').catch((error) => toast(error.message, 'error')));
    $('#downloadLabelPngZipBtn')?.addEventListener('click', () => downloadLabels('zip').catch((error) => toast(error.message, 'error')));
    $('#openBinLabelPrintBtn')?.addEventListener('click', () => {
      $('[data-bin-transfer-tab="binLabelPrintTab"]')?.click();
    });
    $('#binLabelLoadBinsBtn')?.addEventListener('click', () => loadBinLabelBins().catch((error) => toast(error.message, 'error')));
    $('#binLabelBinsButton')?.addEventListener('click', (event) => {
      event.stopPropagation();
      const panel = $('#binLabelBinsPanel');
      if (panel) panel.hidden = !panel.hidden;
      $('#binLabelBinsControl')?.classList.toggle('open', panel?.hidden === false);
    });
    $('#binLabelBinsPanel')?.addEventListener('click', (event) => event.stopPropagation());
    $('#binLabelBinsPanel')?.addEventListener('change', () => {
      updateBinLabelBinsButton();
      clearBinLabelSelection('Click Show Parts to load available parts for selected bins.');
      updateBinLabelBinsButton();
    });
    document.addEventListener('click', () => {
      const panel = $('#binLabelBinsPanel');
      if (panel) panel.hidden = true;
      $('#binLabelBinsControl')?.classList.remove('open');
    });
    $('#binLabelLoadPartsBtn')?.addEventListener('click', () => loadBinLabelParts().catch((error) => toast(error.message, 'error')));
    $('#binLabelPartSearch')?.addEventListener('input', () => renderBinLabelParts(state.binLabelParts || []));
    $('#binLabelPartsRows')?.addEventListener('change', (event) => {
      const box = event.target.closest('.bin-label-part-check');
      if (!box) return;
      if (box.checked) state.binLabelSelectedKeys.add(box.dataset.key);
      else state.binLabelSelectedKeys.delete(box.dataset.key);
      state.binLabelPreviewItems = [];
      syncBinLabelSelectAllState();
      setText('binLabelPreviewCount', '0 labels');
    });
    $('#binLabelSelectAllParts')?.addEventListener('change', (event) => {
      $$('.bin-label-part-check').forEach((box) => {
        box.checked = event.target.checked;
        if (event.target.checked) state.binLabelSelectedKeys.add(box.dataset.key);
        else state.binLabelSelectedKeys.delete(box.dataset.key);
      });
      state.binLabelPreviewItems = [];
      syncBinLabelSelectAllState();
    });
    $('#binLabelSelectAllPartsBtn')?.addEventListener('click', () => {
      $$('.bin-label-part-check').forEach((box) => {
        box.checked = true;
        state.binLabelSelectedKeys.add(box.dataset.key);
      });
      state.binLabelPreviewItems = [];
      syncBinLabelSelectAllState();
    });
    $('#binLabelClearPartsBtn')?.addEventListener('click', () => {
      state.binLabelSelectedKeys = new Set();
      $$('.bin-label-part-check').forEach((box) => { box.checked = false; });
      state.binLabelPreviewItems = [];
      syncBinLabelSelectAllState();
      setText('binLabelPreviewCount', '0 labels');
    });
    ['binLabelWidth', 'binLabelHeight', 'binLabelQrSize', 'binLabelPartFont', 'binLabelBinFont', 'binLabelBold', 'binLabelPrintAreaMode', 'binLabelCopies'].forEach((id) => {
      $(`#${id}`)?.addEventListener('change', () => {
        if (!state.binLabelPreviewItems.length) return;
        previewBinLabels().catch((error) => toast(error.message, 'error'));
      });
    });
    $('#binLabelPreviewBtn')?.addEventListener('click', () => previewBinLabels().catch((error) => toast(error.message, 'error')));
    $('#binLabelPrintBtn')?.addEventListener('click', () => printBinLabels().catch((error) => toast(error.message, 'error')));
    $('#binLabelLogExportBtn')?.addEventListener('click', () => exportBinLabelLog().catch((error) => toast(error.message, 'error')));
    $('#manualScanForm').addEventListener('submit', (event) => {
      event.preventDefault();
      submitScan(event.currentTarget);
    });
    $('#barcodeScanForm').addEventListener('submit', (event) => {
      event.preventDefault();
      fillBarcodePartFromRaw();
      submitScan(event.currentTarget);
    });
    $('#focusScanner').addEventListener('click', () => $('#barcodeRaw').focus());
    $('#barcodeRaw').addEventListener('input', () => {
      fillBarcodePartFromRaw();
    });
    $('#barcodeRaw').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        scheduleBarcodeAutosave(80);
      }
    });
    $('#barcodeRaw').addEventListener('change', () => scheduleBarcodeAutosave(150));
    $$('#manualScanForm [name="type"], #barcodeScanForm [name="type"]').forEach((select) => {
      updateScanTypeFields(select.closest('form'));
      select.addEventListener('change', () => {
        updateScanTypeFields(select.closest('form'));
        if (select.closest('#barcodeScanForm')) scheduleBarcodeAutosave(120);
      });
    });
    $('#manualSyncBtn').addEventListener('click', runSync);
    $('#homeManualSyncBtn').addEventListener('click', runSync);
    $('#repairSyncStatusBtn')?.addEventListener('click', () => repairSyncStatus().catch((error) => toast(error.message, 'error')));
    $('#syncCenterManualBtn').addEventListener('click', runSync);
    $('#syncCenterRetryBtn').addEventListener('click', () => syncPendingQueue({ includeFailed: true }).catch((error) => toast(error.message, 'error')));
    $('#syncDebugRefreshBtn')?.addEventListener('click', () => loadLatestSyncDebug().catch((error) => toast(error.message, 'error')));
    $('#clearSyncLogBtn').addEventListener('click', () => {
      localStorage.removeItem(SYNC_LOG_KEY);
      renderSyncLog();
    });
    $('#clearSyncQueue').addEventListener('click', () => { $('#mobileSyncQueue').value = ''; });
    ['autoSyncToggle', 'homeAutoSyncToggle', 'syncCenterAutoToggle'].forEach((id) => {
      const node = $(`#${id}`);
      if (node) node.addEventListener('change', () => setAutoSyncState());
    });
    $$('.dealerSelect').forEach((select) => {
      select.addEventListener('change', () => {
        syncDealerSelectDisplay(select);
        if (select.id === 'dashboardDealerSelect') {
          state.dashboardDealerCode = cleanDealerCode(select.value || '');
          state.selectedProductGroupSummary = null;
          state.productGroupDetailRows = [];
          state.productGroupDetailTotals = null;
          renderProductGroupDetails({ rows: [], totals: {} });
          loadDashboard().catch((error) => toast(error.message, 'error'));
          return;
        }
        if (select.closest('#binLabelForm')) {
          const dealerCode = cleanDealerCode(select.value || '');
          $$('.bin-transfer-dealer').forEach((dealerSelect) => {
            if (dealerSelect !== select) dealerSelect.value = dealerCode;
          });
          loadBinLabelBins(dealerCode).catch((error) => toast(error.message, 'error'));
          return;
        }
        if (select.classList.contains('bin-transfer-dealer')) {
          const dealerCode = cleanDealerCode(select.value || '');
          $$('.bin-transfer-dealer').forEach((dealerSelect) => {
            if (dealerSelect !== select) dealerSelect.value = dealerCode;
          });
          setBinTransferLoading(dealerCode ? 'Loading bin locations...' : 'Select Dealer Code');
          loadBinTransferBins(dealerCode)
            .then(() => loadBinTransferHistory())
            .catch((error) => toast(error.message, 'error'));
          return;
        }
        if (select.id === 'binManagementDealer' || select.closest('#binSequenceTab')) {
          const dealerCode = cleanDealerCode(select.value || '');
          if ($('#binManagementDealer') && select.id !== 'binManagementDealer') $('#binManagementDealer').value = dealerCode;
          $('#binMasterRows').innerHTML = '<tr><td colspan="5" class="muted">Loading BIN locations...</td></tr>';
          loadBins()
            .then(() => loadBinTransferDestinationBins(dealerCode, $('.bin-transfer-from')?.value || ''))
            .catch((error) => toast(error.message, 'error'));
        }
        if (select.closest('#scan')) {
          const dealerCode = cleanDealerCode(select.value || '');
          syncScanDealerScope(dealerCode, select);
          loadScanHistory().catch((error) => toast(error.message, 'error'));
        }
        if (select.closest('#barcodeScanForm')) {
          loadBarcodeBins().catch((error) => toast(error.message, 'error'));
          restoreBarcodeScanDefaults();
        }
        loadPairingQr().catch((error) => toast(error.message, 'error'));
        sendHeartbeat().catch(console.warn);
      });
    });
    $$('.bin-transfer-from').forEach((select) => {
      select.addEventListener('change', () => {
        $$('.bin-transfer-from').forEach((fromSelect) => {
          if (fromSelect !== select) fromSelect.value = select.value;
        });
        const { dealerCode, fromBin, toBin } = binTransferCriteria(activeBinTransferForm());
        loadBinTransferDestinationBins(dealerCode, fromBin, toBin)
          .then(() => loadBinTransferParts(activeBinTransferForm()))
          .catch((error) => toast(error.message, 'error'));
      });
    });
    $$('.bin-transfer-to').forEach((select) => {
      select.addEventListener('change', () => {
        $$('.bin-transfer-to').forEach((toSelect) => {
          if (toSelect !== select) toSelect.value = select.value;
        });
        syncBinTransferRowDestinations({ selectedOnly: true });
      });
    });
    $('#binTransferPartsRows')?.addEventListener('change', (event) => {
      const row = event.target.closest('tr');
      if (!row) return;
      if (event.target.classList.contains('bin-transfer-check') && event.target.checked) {
        const select = $('.bin-transfer-row-to', row);
        if (select && select.dataset.manual !== 'true') select.value = selectedMainDestinationBin();
      }
      if (event.target.classList.contains('bin-transfer-row-to')) {
        event.target.dataset.manual = event.target.value ? 'true' : '';
      }
    });
    $('#binTransferShowPartsBtn')?.addEventListener('click', () => {
      console.log('SHOW_PARTS_CLICKED');
      loadBinTransferParts($('#binTransferForm')).catch((error) => toast(error.message, 'error'));
    });
    $('#binTransferPartSearch')?.addEventListener('input', () => filterRenderedBinTransferParts());
    $('#binTransferShowHistoryBtn')?.addEventListener('click', () => loadBinTransferHistory().catch((error) => toast(error.message, 'error')));
    $('#binTransferResetBtn')?.addEventListener('click', () => {
      $('#binTransferForm')?.reset();
      state.binTransferLoadedParts = [];
      renderBinTransferParts([], 'Select Dealer Code and Source Bin, then click Show Parts.');
      loadBinTransferBins('').catch(() => null);
    });
    $('#binTransferExportHistoryBtn')?.addEventListener('click', () => {
      const query = queryFromForm($('#binTransferHistoryFilters'));
      downloadGet(`/api/bin-transfer/history${query ? `?${query}&` : '?'}format=excel`, 'Daksh_Bin_Transfer_History.xlsx').catch((error) => toast(error.message, 'error'));
    });
    $('#binTransferExportPartsBtn')?.addEventListener('click', () => {
      const { dealerCode, fromBin } = binTransferCriteria($('#binTransferForm'));
      const partNumber = $('#binTransferPartSearch')?.value || '';
      if (!dealerCode || (!fromBin && !partNumber)) return toast('Dealer and Source Bin or Part Number required', 'error');
      const query = new URLSearchParams({ dealerCode, format: 'excel' });
      if (fromBin) query.set('sourceBin', fromBin);
      if (partNumber) query.set('partNumber', partNumber);
      downloadGet(`/api/bin-transfer/parts?${query.toString()}`, 'Daksh_Bin_Transfer_Parts.xlsx').catch((error) => toast(error.message, 'error'));
    });
    $('#binTransferSelectAll')?.addEventListener('change', (event) => {
      $$('.bin-transfer-check', $('#binTransferMainTab')).forEach((box) => { box.checked = event.target.checked; });
      syncBinTransferRowDestinations({ selectedOnly: true });
    });
    $('#binTransferSelectAllBtn')?.addEventListener('click', () => {
      $$('.bin-transfer-check', $('#binTransferMainTab')).forEach((box) => { box.checked = true; });
      if ($('#binTransferSelectAll')) $('#binTransferSelectAll').checked = true;
      syncBinTransferRowDestinations({ selectedOnly: true });
    });
    $('#binTransferClearSelectionBtn')?.addEventListener('click', () => {
      $$('.bin-transfer-check', $('#binTransferMainTab')).forEach((box) => { box.checked = false; });
      if ($('#binTransferSelectAll')) $('#binTransferSelectAll').checked = false;
    });
    $('#refreshBinTransferHistory')?.addEventListener('click', () => loadBinTransferHistory().catch((error) => toast(error.message, 'error')));
    $('#refreshBinTransferBtn')?.addEventListener('click', () => {
      const activePanelId = $('.bin-transfer-panel.active')?.id || '';
      if (activePanelId === 'binSequenceTab') {
        loadBins()
          .then(() => toast('Bin Master refreshed'))
          .catch((error) => toast(error.message, 'error'));
        return;
      }
      if (activePanelId === 'binTransferHistoryTab') {
        loadBinTransferHistory()
          .then(() => toast('Transfer history refreshed'))
          .catch((error) => toast(error.message, 'error'));
        return;
      }
      if (activePanelId === 'binLabelPrintTab') {
        loadBinLabelBins()
          .then(() => toast('Bin labels refreshed'))
          .catch((error) => toast(error.message, 'error'));
        return;
      }
      const dealerCode = binTransferCriteria().dealerCode;
      loadBinTransferBins(dealerCode)
        .then(() => loadBinTransferHistory())
        .then(() => toast('Bin Transfer refreshed'))
        .catch((error) => toast(error.message, 'error'));
    });
    $('#binTransferSubmitSelectedBtn')?.addEventListener('click', () => submitUnifiedBinTransfer().catch((error) => toast(error.message, 'error')));
    $('#scanHistorySearchBtn').addEventListener('click', () => loadScanHistory().catch((error) => toast(error.message, 'error')));
    $('#scanHistorySelectAll')?.addEventListener('change', (event) => {
      $$('.scan-history-checkbox').forEach((box) => { box.checked = event.target.checked; });
    });
    $('#scanHistoryDeleteSelectedBtn')?.addEventListener('click', () => deleteSelectedScans().catch((error) => toast(error.message, 'error')));
    $('#scanHistoryDeleteUnknownBtn')?.addEventListener('click', () => cleanUnknownParts({}).catch((error) => toast(error.message, 'error')));
    $('#scanHistoryDeleteDealerBtn')?.addEventListener('click', () => deleteByDealerCode().catch((error) => toast(error.message, 'error')));
    $('#validatorRefreshBtn')?.addEventListener('click', () => loadMasterScanValidator().catch((error) => toast(error.message, 'error')));
    $('#reprocessMasterLookupBtn')?.addEventListener('click', () => runValidatorAction('/api/admin/reprocess-master-lookup', 'Master lookup reprocessed').catch((error) => toast(error.message, 'error')));
    $('#recheckInvalidPartsBtn')?.addEventListener('click', () => runValidatorAction('/api/master/scan-validator/normalize-scans', 'Invalid parts rechecked').catch((error) => toast(error.message, 'error')));
    $('#exportMissingMasterBtn')?.addEventListener('click', () => {
      const query = queryFromForm($('#validatorFilters'));
      downloadGet(`/api/master/scan-validator/missing-master/export${query ? `?${query}` : ''}`, 'Invalid_Master_Parts.xlsx').catch((error) => toast(error.message, 'error'));
    });
    $('#validatorFilters')?.addEventListener('submit', (event) => {
      event.preventDefault();
      loadMasterScanValidator().catch((error) => toast(error.message, 'error'));
    });
    $$('#validatorFilters input, #validatorFilters select').forEach((field) => {
      field.addEventListener('change', () => loadMasterScanValidator().catch((error) => toast(error.message, 'error')));
    });
    let validatorFilterTimer;
    $$('#validatorFilters input').forEach((field) => {
      field.addEventListener('input', () => {
        clearTimeout(validatorFilterTimer);
        validatorFilterTimer = setTimeout(() => loadMasterScanValidator().catch((error) => toast(error.message, 'error')), 350);
      });
    });
    $('#validatorDetailClose')?.addEventListener('click', () => $('#validatorDetailModal')?.classList.add('hidden'));
    $('#validatorDetailModal')?.addEventListener('click', (event) => {
      if (event.target.id === 'validatorDetailModal') $('#validatorDetailModal')?.classList.add('hidden');
    });
    $('#validatorMapCancel')?.addEventListener('click', closeValidatorMapModal);
    $('#validatorMapForm')?.addEventListener('submit', (event) => submitValidatorMap(event).catch((error) => toast(error.message, 'error')));
    $('#validatorMapModal')?.addEventListener('click', (event) => {
      if (event.target.id === 'validatorMapModal') closeValidatorMapModal();
    });

    $('#reportFilters').addEventListener('submit', (event) => {
      event.preventDefault();
      loadReport().catch((error) => toast(error.message, 'error'));
    });
    $('#reportTypeSelect').addEventListener('change', (event) => {
      setReportTab(event.target.value);
      console.log("Selected report:", event.target.value);
    });
    $('#reportCategoryFilter')?.addEventListener('change', updateReportButtons);
    $('#reportProductGroupFilter')?.addEventListener('change', () => {
      refreshReportSubGroupOptions();
      updateReportButtons();
    });
    $('#reportProductSubGroupFilter')?.addEventListener('change', updateReportButtons);
    $('[name="dealerCode"]', $('#reportFilters')).addEventListener('change', () => {
      updateReportButtons();
      if (!reportParams().dealerCode) {
        resetReportPreview('Select dealer code first to view report.');
        return;
      }
    });
    $('[name="showScannedPartsOnly"]', $('#reportFilters'))?.addEventListener('change', (event) => {
      if (event.target.checked) $('[name="showFullMasterWithZeroScan"]', $('#reportFilters')).checked = false;
    });
    $('[name="showFullMasterWithZeroScan"]', $('#reportFilters'))?.addEventListener('change', (event) => {
      if (event.target.checked) $('[name="showScannedPartsOnly"]', $('#reportFilters')).checked = false;
    });
    $('#reportShow').addEventListener('click', () => loadReport().catch((error) => toast(error.message, 'error')));
    $('#reportRefresh')?.addEventListener('click', () => loadReport({ forceRefresh: true }).catch((error) => toast(error.message, 'error')));
    $('#reportFilterSettingsOpen')?.addEventListener('click', openReportFilterSettings);
    $('#reportResultSettingsOpen')?.addEventListener('click', openReportFilterSettings);
    $('#reportColumnSettingsOpen')?.addEventListener('click', openReportFilterSettings);
    $('#reportFilterSettingsClose')?.addEventListener('click', closeReportFilterSettings);
    $('#reportFilterSettingsModal')?.addEventListener('click', (event) => {
      if (event.target.id === 'reportFilterSettingsModal') closeReportFilterSettings();
    });
    $('#reportColumnSettingsAll')?.addEventListener('click', () => {
      $$('#reportColumnSettingsList input[type="checkbox"]').forEach((box) => {
        box.checked = true;
      });
    });
    $('#reportColumnSettingsDefault')?.addEventListener('click', () => {
      saveReportColumnSettings(activeReportType(), null);
      renderReportColumnSettingsList();
      rerenderCurrentReportTable();
      toast('Report columns reset');
    });
    $('#reportColumnSettingsSave')?.addEventListener('click', () => {
      const selected = $$('#reportColumnSettingsList input[type="checkbox"]:checked').map((box) => box.value);
      if (!selected.length) {
        toast('Select at least one report field', 'error');
        return;
      }
      saveReportColumnSettings(activeReportType(), selected);
      closeReportFilterSettings();
      rerenderCurrentReportTable();
      toast('Report columns saved');
    });
    $('#reportFilterSettingsDefault')?.addEventListener('click', () => {
      const defaults = REPORT_FILTER_DEFAULTS_BY_TYPE[activeReportType()] || REPORT_FILTER_DEFAULTS;
      $$('#reportFilterSettingsList input[type="checkbox"]').forEach((box) => {
        box.checked = defaults.includes(box.value);
      });
    });
    $('#reportFilterSettingsSave')?.addEventListener('click', async () => {
      const selected = $$('#reportFilterSettingsList input[type="checkbox"]:checked').map((box) => box.value);
      try {
        await saveReportFilterSettings(selected);
        closeReportFilterSettings();
        resetReportPreview('Report filters updated. Click Submit to fetch report data.');
      } catch (error) {
        toast(error.message, 'error');
      }
    });
    $('#reportReset')?.addEventListener('click', () => {
      if (state.reportAbortController) state.reportAbortController.abort();
      $('#reportFilters').reset();
      applyReportScanModeDefaults();
      resetReportPreview('Please select filters and click Submit.');
    });
    $('#reportTableSearch')?.addEventListener('input', () => {
      clearTimeout(state.reportSearchTimer);
      state.reportSearchTimer = setTimeout(() => {
        if (state.reportTableRows.length || state.reportTableColumns.length) {
          renderReportTable(state.reportTableColumns, state.reportTableRows, state.reportTableTotalRows, state.reportTableGrandTotal, activeReportType());
        }
      }, 500);
    });
    $('#reportExcel').addEventListener('click', () => downloadGet(reportPath('excel'), reportDownloadName('xlsx')).catch((error) => toast(error.message, 'error')));
    $('#reportPdf')?.addEventListener('click', () => downloadGet(reportPath('pdf'), reportDownloadName('pdf')).catch((error) => toast(error.message, 'error')));
    $('#partsRefreshTemplateCsv')?.addEventListener('click', () => downloadGet(partsRefreshTemplatePath(), 'Parts_Inventory_Refresh_Template.csv').catch((error) => toast(error.message, 'error')));
    $('#reportEmail')?.addEventListener('click', async () => {
      const to = window.prompt('To');
      if (!to) return;
      const cc = window.prompt('CC (optional)', '') || '';
      const subject = window.prompt('Subject', `Daksh Inventory - ${REPORT_TITLES[activeReportType()]}`) || `Daksh Inventory - ${REPORT_TITLES[activeReportType()]}`;
      const message = window.prompt('Message', 'Please find the attached report.') || 'Please find the attached report.';
      const attachmentType = window.prompt('Attachment Type: Excel / PDF / Both', 'Excel') || 'Excel';
      try {
        const data = await api(`/api/reports/${activeReportType()}/email`, {
          method: 'POST',
          body: {
            to,
            cc,
            subject,
            message,
            attachmentType,
            filters: formObject($('#reportFilters'))
          }
        });
        toast(data.message || 'Report email sent');
      } catch (error) {
        toast(error.message, 'error');
      }
    });
    updateReportButtons();

    $('#reconFilters').addEventListener('submit', (event) => {
      event.preventDefault();
      loadReconciliation().catch((error) => toast(error.message, 'error'));
    });
    $$('.recon-tab').forEach((button) => {
      button.addEventListener('click', () => {
        const target = button.dataset.reconTab;
        $$('.recon-tab').forEach((item) => {
          const active = item === button;
          item.classList.toggle('active', active);
          item.setAttribute('aria-selected', String(active));
        });
        $$('.recon-panel').forEach((panel) => {
          const active = panel.id === target;
          panel.classList.toggle('active', active);
          panel.hidden = !active;
        });
      });
    });
    $('#dealerStockDealer')?.addEventListener('change', (event) => {
      const dealerCode = cleanDealerCode(event.target.value || '');
      if ($('#reconDealer')) $('#reconDealer').value = dealerCode;
    });
    $('#reconDealer')?.addEventListener('change', (event) => {
      const dealerCode = cleanDealerCode(event.target.value || '');
      if ($('#dealerStockDealer')) $('#dealerStockDealer').value = dealerCode;
    });
    $('#dealerStockUploadForm')?.addEventListener('submit', (event) => {
      event.preventDefault();
      uploadDealerStock(event.currentTarget).catch((error) => {
        const message = $('#dealerStockUploadMessage');
        if (message) {
          message.className = 'form-message error';
          message.textContent = error.message;
        }
        toast(error.message, 'error');
      });
    });
    $('#reconPreviewBtn')?.addEventListener('click', () => loadDealerStockPreview().catch((error) => toast(error.message, 'error')));
    $('#reconDeleteStockBtn')?.addEventListener('click', () => deleteDealerStock().catch((error) => toast(error.message, 'error')));
    $('#reconReprocessBtn')?.addEventListener('click', () => reprocessReconciliation().catch((error) => toast(error.message, 'error')));
    $('#reconReset')?.addEventListener('click', () => {
      $('#reconFilters').reset();
      loadReconciliation().catch((error) => toast(error.message, 'error'));
    });
    $('#reconExcel').addEventListener('click', () => downloadGet(`/api/reconciliation/report?${queryFromForm($('#reconFilters'))}&format=excel`, 'Daksh_Reconciliation.xlsx').catch((error) => toast(error.message, 'error')));
    $('#reconPdf').addEventListener('click', () => downloadGet(`/api/reconciliation/report?${queryFromForm($('#reconFilters'))}&format=pdf`, 'Daksh_Reconciliation.pdf').catch((error) => toast(error.message, 'error')));
    $('#reconFullReport')?.addEventListener('click', () => downloadGet(`/api/reconciliation/report?${queryFromForm($('#reconFilters'))}&format=excel&full=1`, 'Daksh_Reconciliation_Full.xlsx').catch((error) => toast(error.message, 'error')));

    $('#partUploadForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const data = await api('/api/master-catalogue/upload', { method: 'POST', body: new FormData(event.currentTarget) });
        $('#uploadStats').textContent = `Imported ${data.importedCount || 0} | Updated duplicates ${data.updatedDuplicateCount || 0} | Skipped ${data.skippedInvalidRowsCount || 0}`;
        toast(`Master catalogue uploaded: imported ${data.importedCount || 0}`);
        if (hasPartSearchFilter()) await loadParts(state.masterSearch.page || 1);
      } catch (error) {
        toast(error.message, 'error');
      }
    });
    $('#deleteCatalogueBtn')?.addEventListener('click', async () => {
      if (!window.confirm('Are you sure you want to delete old catalogue? Scan and audit data will not be deleted.')) return;
      const data = await api('/api/master-catalogue', { method: 'DELETE', body: {} });
      $('#uploadStats').textContent = `Deleted old rows ${data.deletedOldRowsCount || 0}`;
      clearPartSearch('Old catalogue deleted. Scan and audit data was not deleted.');
    });
    $('#deleteReuploadCatalogueBtn')?.addEventListener('click', async () => {
      const form = $('#partUploadForm');
      const fileInput = $('[name="file"]', form);
      if (!fileInput || !fileInput.files.length) return toast('Select new master file first', 'error');
      if (!window.confirm('Are you sure you want to delete old catalogue? Scan and audit data will not be deleted.')) return;
      const data = await api('/api/master-catalogue/delete-and-reupload', { method: 'POST', body: new FormData(form) });
      $('#uploadStats').textContent = `Deleted ${data.deletedOldRowsCount || 0} | Imported ${data.importedCount || 0} | Updated duplicates ${data.updatedDuplicateCount || 0} | Skipped ${data.skippedInvalidRowsCount || 0}`;
      toast('Catalogue deleted, reuploaded and reports reprocessed');
      if (hasPartSearchFilter()) await loadParts(state.masterSearch.page || 1);
    });
    $('#partSearchForm').addEventListener('submit', (event) => {
      event.preventDefault();
      loadParts().catch((error) => toast(error.message, 'error'));
    });
    $('#partClearSearchBtn')?.addEventListener('click', () => {
      $('#partSearchForm').reset();
      clearPartSearch();
      const menu = $('#partMasterSuggestMenu');
      if (menu) menu.style.display = 'none';
    });
    $('#partExportSearchBtn')?.addEventListener('click', exportPartSearchResults);
    let partMasterSuggestTimer;
    $('#partMasterSearchInput')?.addEventListener('input', (event) => {
      clearTimeout(partMasterSuggestTimer);
      const value = event.target.value.trim();
      if (!value && !hasPartSearchFilter()) clearPartSearch();
      partMasterSuggestTimer = setTimeout(() => loadPartNumberSuggestions(value).catch((error) => toast(error.message, 'error')), 160);
    });
    $('#partMasterSearchInput')?.addEventListener('blur', () => {
      setTimeout(() => {
        const menu = $('#partMasterSuggestMenu');
        if (menu) menu.style.display = 'none';
      }, 160);
    });
    $('#partPrevPageBtn')?.addEventListener('click', () => loadParts(Math.max(1, (state.masterSearch.page || 1) - 1)).catch((error) => toast(error.message, 'error')));
    $('#partNextPageBtn')?.addEventListener('click', () => loadParts((state.masterSearch.page || 1) + 1).catch((error) => toast(error.message, 'error')));
    $('#reprocessMasterDataBtn')?.addEventListener('click', async () => {
      const data = await api('/api/master-catalogue/reprocess', { method: 'POST', body: {} });
      toast(`Reprocessed scans: updated ${data.updatedCount || 0}, unmatched ${data.unmatchedCount || 0}`);
      if (hasPartSearchFilter()) await loadParts(state.masterSearch.page || 1);
    });
    $('#reprocessProductGroupBtn')?.addEventListener('click', async () => {
      const data = await api('/api/master-catalogue/reprocess-product-groups', { method: 'POST', body: {} });
      toast(`Reprocessed product groups: ${data.updatedCount || 0} catalogue rows`);
      if (hasPartSearchFilter()) await loadParts(state.masterSearch.page || 1);
    });
    $('#reprocessScanCatalogueBtn')?.addEventListener('click', async () => {
      const data = await api('/api/scans/reprocess-with-catalogue', { method: 'POST', body: {} });
      toast(`Reprocessed scan history: updated ${data.updatedCount || 0}, unmatched ${data.unmatchedCount || 0}`);
    });
    $('#dealerMasterForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      await api('/api/master/dealers', { method: 'POST', body: formObject(event.currentTarget) });
      toast('Dealer saved');
      event.currentTarget.reset();
      await loadDealers();
    });
    $('#dealerMasterRows')?.addEventListener('click', (event) => {
      const button = event.target.closest('.dealer-master-delete');
      if (!button) return;
      deleteDealerMaster(button.dataset.code, button.dataset.name).catch((error) => toast(error.message, 'error'));
    });
    $('#binMasterForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const dealerCode = cleanDealerCode($('[name="dealerCode"]', event.currentTarget)?.value || '');
      await api('/api/bin-master/create', { method: 'POST', body: formObject(event.currentTarget) });
      toast('Bin saved');
      event.currentTarget.reset();
      $('[name="dealerCode"]', event.currentTarget).value = dealerCode;
      if ($('#binManagementDealer')) $('#binManagementDealer').value = dealerCode;
      await loadBins();
      await loadBinTransferDestinationBins(dealerCode, $('.bin-transfer-from')?.value || '').catch(() => null);
    });
    $('#bulkBinForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const dealerCode = cleanDealerCode($('[name="dealerCode"]', event.currentTarget)?.value || '');
      const data = await api('/api/bin-master/bulk-create', { method: 'POST', body: formObject(event.currentTarget) });
      $('#bulkBinStats').textContent = `Created ${data.createdCount} | Skipped duplicates ${data.skippedDuplicateCount || data.duplicateCount || 0}`;
      if (data.bins && data.bins.length) {
        $('#bulkQrItems').value = data.bins.map((bin) => bin.binCode).join('\n');
      }
      toast('Bulk bin sequence created');
      if ($('#binManagementDealer')) $('#binManagementDealer').value = dealerCode;
      await loadBins();
      await loadBinTransferDestinationBins(dealerCode, $('.bin-transfer-from')?.value || '').catch(() => null);
    });

    $('#binQrForm').addEventListener('submit', (event) => {
      event.preventDefault();
      createQr(event.currentTarget, '/api/qr/bin', 'binQrImage').catch((error) => toast(error.message, 'error'));
    });
    $('#partQrForm').addEventListener('submit', (event) => {
      event.preventDefault();
      createQr(event.currentTarget, '/api/qr/part', 'partQrImage').catch((error) => toast(error.message, 'error'));
    });
    $('#bulkQrBtn').addEventListener('click', () => {
      const items = $('#bulkQrItems').value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      downloadPost('/api/qr/bulk-pdf', { items, ...bulkQrOptions() }, 'Daksh_Bulk_QR.pdf').catch((error) => toast(error.message, 'error'));
    });

    $('#backupDbBtn').addEventListener('click', () => downloadGet('/api/backup/download', 'Daksh_Inventory_Backup.json').catch((error) => toast(error.message, 'error')));
    $('#refreshAuditBackupsBtn')?.addEventListener('click', () => loadAuditBackups().catch((error) => toast(error.message, 'error')));
    $('#applyAuditBackupFiltersBtn')?.addEventListener('click', () => loadAuditBackups().catch((error) => toast(error.message, 'error')));
    $('#resetAuditBackupFiltersBtn')?.addEventListener('click', () => setTimeout(() => loadAuditBackups().catch((error) => toast(error.message, 'error')), 0));
    $('#auditBackupRows')?.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-id]');
      if (!button) return;
      const archiveId = button.dataset.id;
      if (button.classList.contains('preview-audit-backup')) previewAuditBackup(archiveId).catch((error) => toast(error.message, 'error'));
      if (button.classList.contains('restore-audit-backup')) restoreAuditBackup(archiveId).catch((error) => toast(error.message, 'error'));
      if (button.classList.contains('download-audit-backup')) downloadGet(`/api/audit-backup/download?archiveId=${encodeURIComponent(archiveId)}`, `${archiveId.replace(/\.(json|zip)$/i, '')}.zip`).catch((error) => toast(error.message, 'error'));
      if (button.classList.contains('remove-audit-backup')) removeAuditBackup(archiveId).catch((error) => toast(error.message, 'error'));
    });
    $('#cancelAuditRestoreBtn')?.addEventListener('click', () => cancelAuditRestore().catch((error) => toast(error.message, 'error')));
    $('#dedupeBtn').addEventListener('click', async () => {
      if (!window.confirm('Run deduplication now?')) return;
      const data = await api('/api/scans/deduplicate', { method: 'POST', body: {} });
      toast(`Deduplication complete: ${data.deletedCount} removed`);
      await loadScanHistory();
    });
    $('#reprocessScansBtn')?.addEventListener('click', async () => {
      const data = await api('/api/admin/reprocess-scans', { method: 'POST', body: {} });
      toast(`Reprocessed ${data.updatedCount || 0} scans; matched ${data.matchedCount || 0}`);
      await refreshAll();
    });
    $$('.admin-delete-tab').forEach((button) => button.addEventListener('click', () => switchAdminDeleteTab(button.dataset.adminDeleteTab)));
    $('#dealerDeleteDealer')?.addEventListener('change', () => {
      state.adminDeleteRows = [];
      state.adminDeleteSelectedIds = new Set();
      renderAdminDeleteRows();
      setAdminDeleteMessage('Dealer selected. Click Show Parts to load available scans.');
    });
    $('#dealerShowPartsBtn')?.addEventListener('click', () => showDealerDeleteParts().catch((error) => toast(error.message, 'error')));
    $('#dealerPreviewDeleteBtn')?.addEventListener('click', () => previewDealerDelete().catch((error) => toast(error.message, 'error')));
    $('#dealerDeleteSelectedBtn')?.addEventListener('click', () => deleteDealerSelectedRows().catch((error) => toast(error.message, 'error')));
    $('#dealerDeleteAllBtn')?.addEventListener('click', () => deleteAllForDealer().catch((error) => toast(error.message, 'error')));
    $('#dealerDeleteSearch')?.addEventListener('input', renderAdminDeleteRows);
    $('#dealerDeleteSelectAll')?.addEventListener('change', (event) => {
      adminDeleteVisibleRows().forEach((row) => {
        if (event.target.checked) state.adminDeleteSelectedIds.add(row.id);
        else state.adminDeleteSelectedIds.delete(row.id);
      });
      renderAdminDeleteRows();
    });
    $('#dealerDeleteForm')?.addEventListener('reset', () => setTimeout(resetDealerDelete, 0));
    $('#locationCheckCountBtn')?.addEventListener('click', () => checkLocationDeleteCount().catch((error) => toast(error.message, 'error')));
    $('#locationDeleteBtn')?.addEventListener('click', () => deleteLocationData().catch((error) => toast(error.message, 'error')));
    $('#locationDeleteForm')?.addEventListener('reset', () => setTimeout(resetLocationDelete, 0));
    $('#restoreDbForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      await api('/api/backup/restore', { method: 'POST', body: new FormData(event.currentTarget) });
      toast('Database restored');
      await refreshAll();
    });
    $('#createUserForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const payload = formObject(event.currentTarget);
        if (payload.role !== 'admin' && !String(payload.dealerAccess || '').trim()) {
          payload.dealerAccess = selectedScanDealerCode() || selectedDashboardDealerCode() || (state.activeAudit && state.activeAudit.dealerCode) || '';
        }
        payload.dealerAccess = cleanDealerAccessInput(payload.dealerAccess);
        payload.approved = $('[name="approved"]', event.currentTarget).checked;
        payload.active = $('[name="active"]', event.currentTarget).checked;
        const data = await api('/api/users/create', { method: 'POST', body: payload });
        showCreatedUser(data.user);
        toast('User created');
        event.currentTarget.reset();
        if (payload.role !== 'admin') event.currentTarget.elements.dealerAccess.value = payload.dealerAccess || '';
        $('[name="approved"]', event.currentTarget).checked = true;
        $('[name="active"]', event.currentTarget).checked = true;
      } catch (error) {
        toast(error.message, 'error');
      }
    });
    $('#resetUserForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const message = $('#resetUserMessage');
      try {
        const payload = formObject(event.currentTarget);
        if (!payload.username) throw new Error('User not found');
        if (payload.newPassword && payload.newPassword !== payload.confirmPassword) throw new Error('New password and confirm password do not match');
        if (payload.newPassword && payload.newPin) throw new Error('Enter either a new Password or a new PIN');
        if (!payload.newPassword && !payload.newPin) throw new Error('Enter a new Password or PIN');

        const url = payload.newPassword ? '/api/auth/admin-reset-password' : '/api/users/reset-pin';
        const body = payload.newPassword
          ? { username: payload.username, newPassword: payload.newPassword, forcePasswordChange: payload.forcePasswordChange === 'on' }
          : { username: payload.username, newPin: payload.newPin };
        const data = await api(url, { method: 'POST', body });
        message.className = 'form-message success';
        message.textContent = data.message || (payload.newPassword ? 'Password reset successful' : 'PIN reset successful');
        event.currentTarget.reset();
        renderResetUserOptions();
      } catch (error) {
        message.className = 'form-message error';
        message.textContent = error.message || 'User not found';
      }
    });
    $('#editUserForm')?.addEventListener('submit', (event) => saveEditedUser(event).catch((error) => {
      const message = $('#editUserMessage');
      message.className = 'form-message error';
      message.textContent = error.message || 'User update failed';
    }));
    $('#closeEditUserModalBtn')?.addEventListener('click', closeEditUserModal);
    $('#editUserModal')?.addEventListener('click', (event) => {
      if (event.target.id === 'editUserModal') closeEditUserModal();
    });
    $('#refreshUsersBtn').addEventListener('click', () => loadUsers().then(() => toast('Users refreshed')).catch((error) => toast(error.message, 'error')));
    $('#smtpSettingsForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      setSmtpMessage('#smtpSettingsMessage', 'Saving SMTP settings...', 'success');
      try {
        const payload = smtpPayloadFromForm(event.currentTarget);
        if (payload.smtpPassword === '********') delete payload.smtpPassword;
        const data = await api('/api/admin/smtp-save', { method: 'POST', body: payload });
        renderSmtpSettings(data.smtp || {});
        setSmtpMessage('#smtpSettingsMessage', data.message || 'SMTP Configured', 'success');
        toast(data.message || 'SMTP Configured');
      } catch (error) {
        setSmtpMessage('#smtpSettingsMessage', error.message || 'SMTP Test Failed', 'error');
        toast(error.message || 'SMTP Test Failed', 'error');
      }
    });
    $('#changeSmtpPasswordBtn').addEventListener('click', () => {
      $('#smtpChangePasswordForm').classList.remove('hidden');
      setSmtpMessage('#smtpPasswordMessage', 'Change Password Required', 'error');
    });
    $('#cancelSmtpPasswordBtn').addEventListener('click', () => {
      $('#smtpChangePasswordForm').classList.add('hidden');
      $('#smtpChangePasswordForm').reset();
      setSmtpMessage('#smtpPasswordMessage', '');
    });
    $('#smtpChangePasswordForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = formObject(event.currentTarget);
      if (payload.newPassword !== payload.confirmPassword) {
        setSmtpMessage('#smtpPasswordMessage', 'SMTP App Password and Confirm Password must match', 'error');
        return;
      }
      setSmtpMessage('#smtpPasswordMessage', 'Testing new SMTP password...', 'success');
      try {
        const data = await api('/api/admin/smtp-change-password', { method: 'POST', body: payload });
        renderSmtpSettings(data.smtp || {});
        $('#smtpChangePasswordForm').reset();
        $('#smtpChangePasswordForm').classList.add('hidden');
        setSmtpMessage('#smtpPasswordMessage', data.message || 'Password Saved Securely', 'success');
        toast(data.message || 'Password Saved Securely');
      } catch (error) {
        setSmtpMessage('#smtpPasswordMessage', error.message || 'SMTP Test Failed', 'error');
        toast(error.message || 'SMTP Test Failed', 'error');
      }
    });
    $('#smtpTestForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      setSmtpMessage('#smtpTestMessage', 'Sending test OTP...', 'success');
      try {
        const data = await api('/api/admin/smtp-test', { method: 'POST', body: formObject(event.currentTarget) });
        setSmtpMessage('#smtpTestMessage', data.message || 'OTP Sent Successfully', 'success');
        toast(data.message || 'OTP Sent Successfully');
        await loadAuthSettings();
      } catch (error) {
        setSmtpMessage('#smtpTestMessage', error.message || 'SMTP Test Failed', 'error');
        toast(error.message || 'SMTP Test Failed', 'error');
      }
    });
    $('#allowUnknownToggle').addEventListener('change', (event) => {
      localStorage.setItem('dakshAllowUnknown', event.target.checked ? 'true' : 'false');
      toast(event.target.checked ? 'Unknown save prompt enabled' : 'Unknown save prompt disabled');
    });
  }

  function bindSocket() {
    if (!window.io) return;
    const socket = window.io({ transports: ['websocket', 'polling'], reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000, reconnectionDelayMax: 5000 });
    socket.on('connect', () => {
      state.lastRealtimeAt = Date.now();
      console.log('[DASHBOARD] socket connected', { socketId: socket.id });
      socket.emit('device:hello', { deviceId: ensureDeviceId(), deviceName: 'Dashboard Browser', deviceType: 'web' });
      addConnectionLog('Device connected', 'success');
    });
    setInterval(() => {
      if (!socket.connected) return;
      socket.emit('device:heartbeat', {
        deviceId: ensureDeviceId(),
        deviceName: 'Dashboard Browser',
        model: navigator.userAgent,
        serverUrl: state.serverInfo ? state.serverInfo.serverUrl : '',
        appVersion: 'web-dashboard'
      });
    }, 10000);
    socket.on('disconnect', (reason) => {
      console.warn('[DASHBOARD] socket disconnected', reason);
      addConnectionLog(`Socket disconnected: ${reason}`, 'warning');
    });
    socket.on('connect_error', (error) => {
      console.warn('[DASHBOARD] socket connect error', error.message);
      addConnectionLog(`Socket reconnecting: ${error.message}`, 'warning');
    });
    socket.on('scan:new', (scan) => {
      handleNewScan(scan).catch(console.warn);
    });
    socket.on('scanData', (scan) => {
      console.log('[DASHBOARD] scanData received', scan);
      handleNewScan(scan).catch(console.warn);
    });
    socket.on('scan:saved', () => {
      state.lastRealtimeAt = Date.now();
      queueRealtimeReportRefresh('scan saved');
      queueScanRefresh(1200);
      Promise.all([loadBinTransferParts(activeBinTransferForm()), loadBinTransferHistory()]).catch(console.warn);
    });
    socket.on('scan:duplicate', (scan = {}) => {
      state.lastRealtimeAt = Date.now();
      toast(`Duplicate scan: ${scan.partNumber || scan.part || ''}`, 'error');
      queueScanRefresh(1200);
    });
    socket.on('scan:deleted', () => Promise.all([loadDashboard(), loadScanHistory(), loadBinTransferParts(activeBinTransferForm())]).catch(console.warn));
    socket.on('scan:count:update', (stats) => {
      if (stats && dashboardStatsMatchesActiveAudit(stats)) {
        updateDashboardCards(stats);
      }
    });
    socket.on('dashboard:update', (payload = {}) => {
      state.lastRealtimeAt = Date.now();
      queueRealtimeReportRefresh('dashboard update');
      if (!dashboardPayloadMatchesActiveAudit(payload)) return;
      if (payload.stats && dashboardStatsMatchesActiveAudit(payload.stats)) updateDashboardCards(payload.stats);
      if (Array.isArray(payload.recent)) renderScanStream(payload.recent);
      updateScannerStatusBar({ at: new Date() });
      console.log('[DASHBOARD] dashboard:update received', { recent: Array.isArray(payload.recent) ? payload.recent.length : 0 });
    });
    socket.on('inventory:update', (payload = {}) => {
      state.lastRealtimeAt = Date.now();
      queueRealtimeReportRefresh('inventory update');
      if (!dashboardPayloadMatchesActiveAudit(payload)) return;
      if (payload.stats && dashboardStatsMatchesActiveAudit(payload.stats)) updateDashboardCards(payload.stats);
      if (Array.isArray(payload.recent)) renderScanStream(payload.recent);
    });
    socket.on('reports:update', () => {
      state.lastRealtimeAt = Date.now();
      queueRealtimeReportRefresh('report broadcast');
    });
    socket.on('scanner:activity', (activity = {}) => {
      state.lastRealtimeAt = Date.now();
      setStatusPill('topRealtimeStatus', 'Realtime: Active Scan', 'blue');
      setDashboardKpiValue('dashRealtimeActivity', compactDateTime(activity.timestamp || new Date()), { time: true });
      queueDeviceRefresh();
    });
    socket.on('scanner:status', (device = {}) => {
      updateScannerStatusBar({ connectedDevices: state.activeDeviceCount, activeScannerCount: state.activeDeviceCount, lastActivityAt: device.lastActivity || device.lastSeen || new Date() });
    });
    socket.on('scan:last10:update', (scans = []) => {
      state.lastRealtimeAt = Date.now();
      if (Array.isArray(scans)) renderScanStream(scans);
    });
    socket.on('stats:update', (stats) => {
      if (stats && dashboardStatsMatchesActiveAudit(stats)) updateDashboardCards(stats);
      else queueScanRefresh(1200);
    });
    socket.on('devices:update', () => queueDeviceRefresh(1200));
    socket.on('device:connected', () => {
      addConnectionLog('Device connected', 'success');
      queueDeviceRefresh(500);
    });
    socket.on('device:heartbeat', () => queueDeviceRefresh());
    socket.on('device:disconnected', () => {
      addConnectionLog('Device disconnected', 'warning');
      loadDevices().catch(console.warn);
    });
    socket.on('audit:active', (audit) => {
      state.activeAudit = audit;
      updateActiveAuditUi();
      loadBins().catch(console.warn);
      loadDashboard().catch(console.warn);
    });
    socket.on('audit:closed', () => {
      state.activeAudit = null;
      updateActiveAuditUi();
      loadBins().catch(console.warn);
      toast('Audit closed. Refresh active audit before syncing.', 'error');
    });
    socket.on('sync:started', () => {
      setHeaderSyncStatus('Syncing', true);
      addConnectionLog('Sync started', 'warning');
    });
    socket.on('sync:completed', (payload) => {
      state.lastRealtimeAt = Date.now();
      if (payload) rememberLastSyncTime(payload.completedAt || payload.lastSync || payload.lastSyncTime || payload.lastSuccessfulSyncAt);
      updateSyncBadges(payload || {});
      addConnectionLog('Sync completed', 'success');
      refreshAfterSync(payload || {}).catch(console.warn);
    });
    socket.on('syncData', (payload = {}) => {
      state.lastRealtimeAt = Date.now();
      console.log('[DASHBOARD] syncData received', {
        success: payload.success,
        insertedCount: payload.insertedCount,
        duplicateCount: payload.duplicateCount,
        failedCount: payload.failedCount
      });
      updateSyncBadges(payload || {});
      refreshAfterSync(payload || {}).catch(console.warn);
    });
    socket.on('sync:failed', () => {
      setHeaderSyncStatus('Failed', false);
      setDashboardSyncStatus('Failed', false);
      updateSyncBadges({ serverStatus: 'offline', mongoStatus: 'offline' });
      addConnectionLog('Sync failed', 'error');
    });
    socket.on('offline-queue:update', (payload = {}) => {
      updateScannerStatusBar({ pendingSyncCount: payload.queuedCount || syncCounts().total, at: new Date() });
      renderSyncQueue();
    });
    socket.on('dealers:update', () => loadDealers().catch(console.warn));
    socket.on('master:update', () => {
      state.reportFilterDropdownsLoadedAt = 0;
      const jobs = [loadBins(), loadCategories()];
      if (hasPartSearchFilter()) jobs.push(loadParts(state.masterSearch.page || 1));
      Promise.all(jobs).catch(console.warn);
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    bootLog('DOMContentLoaded handler entered', {
      readyState: document.readyState,
      bodyChildren: document.body ? document.body.children.length : 0,
      appShellPresent: Boolean($('.app')),
      tokenPresent: Boolean(state.token)
    });
    let restoredView = {};
    try {
      if (!await validateSession()) {
        bootWarn('startup stopped: validateSession returned false');
        return;
      }
      if (!setUserChrome()) {
        bootWarn('startup stopped: setUserChrome returned false');
        return;
      }
      ensureDeviceId();
      initSidebarResize();
      bootLog('device id ensured', {
        deviceIdPresent: Boolean(storageGet('dakshDeviceId'))
      });
      restoreBarcodeScanDefaults();
      bootLog('binding dashboard UI start');
      bindNavigation();
      bindEvents();
      bindSuggestions();
      bindMasterSearchSuggestions();
      bindUppercaseInputs();
      secureNewTabLinks();
      initReportTabs();
      initReportLayout();
      bootLog('binding dashboard UI complete', {
        sideLinks: $$('.side-link').length,
        views: $$('.view').length
      });
      renderSyncQueue();
      renderSyncLog();
      renderConnectionLog();
      resetReportPreview('Please select filters and click Submit.');
      applyReportFilterVisibility();
      restoredView = restoreActiveViewShell();
      bootLog('active view restored', restoredView);
      bootLog('socket bind start', {
        socketIoPresent: Boolean(window.io)
      });
      bindSocket();
      bootLog('socket bind complete');
      startDashboardFallbackRefresh();
      const auditStartDate = $('[name="auditStartDate"]', $('#dealerMasterForm'));
      if (auditStartDate && !auditStartDate.value) auditStartDate.value = new Date().toISOString().slice(0, 10);
      clearPartSearch();
      loadReconciliation().catch((error) => bootWarn('initial reconciliation load skipped', errorDetails(error)));
      setAutoSyncState();
      window.addEventListener('online', () => syncPendingQueue({ silent: true, includeFailed: true }).catch(console.warn));
      window.addEventListener('storage', (event) => {
        if (event.key === 'dakshToken' && !event.newValue) {
          bootWarn('storage event cleared token; redirecting to login');
          state.token = '';
          state.user = null;
          window.location.href = '/';
        }
      });
      setInterval(sendHeartbeat, 15000);
      setInterval(() => loadHealth().catch(console.warn), 5000);
    } catch (error) {
      bootError('fatal startup failure before network refresh', errorDetails(error));
      toast(`Startup failed: ${error.message}`, 'error');
      return;
    }
    try {
      bootLog('network startup start');
      await connectDevice();
      bootLog('connectDevice complete');
      await sendHeartbeat();
      bootLog('initial heartbeat complete');
      await refreshAll();
      bootLog('refreshAll complete');
      await finishRestoredViewLoad(restoredView);
      bootLog('finishRestoredViewLoad complete', restoredView);
      secureNewTabLinks();
      restoreBarcodeScanDefaults();
      await loadBarcodeBins().catch(() => null);
      bootLog('loadBarcodeBins complete or skipped');
      await syncPendingQueue({ silent: true, includeFailed: true });
      bootLog('initial syncPendingQueue complete');
      bootLog('DOMContentLoaded startup complete', {
        totalMs: Date.now() - uiBootStartedAt
      });
    } catch (error) {
      bootError('network startup failed', errorDetails(error));
      toast(error.message, 'error');
    }
  });
})();
