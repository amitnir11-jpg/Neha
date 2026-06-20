(function () {
  const UI_BOOT_VERSION = '20260620-dashboard-stream-camera-fix';
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
    if (level === 'error') console.error(`[DAKSH_UI_BOOT] ${label}`, entry);
    else if (level === 'warn') console.warn(`[DAKSH_UI_BOOT] ${label}`, entry);
  }

  const bootLog = (label, details = {}) => bootMark('log', label, details);
  const bootWarn = (label, details = {}) => bootMark('warn', label, details);
  const bootError = (label, details = {}) => bootMark('error', label, details);

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

  const ACTIVE_DEALER_KEY = 'dakshActiveDealerId';

  function userScopedStorageKey(baseKey, user = null) {
    const currentUser = arguments.length > 1 ? (user || {}) : (state.user || readStoredJson('dakshUser') || {});
    const keyPart = String(currentUser.id || currentUser.username || currentUser.email || currentUser.name || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_');
    return keyPart ? `${baseKey}:${keyPart}` : baseKey;
  }

  const storedUser = readStoredJson('dakshUser');

  const state = {
    token: storageGet('dakshToken') || '',
    user: storedUser,
    activeDealerId: String(storageGet(userScopedStorageKey(ACTIVE_DEALER_KEY, storedUser)) || storageGet(ACTIVE_DEALER_KEY) || '').trim().toUpperCase(),
    assignedDealers: readStoredJson('dakshAssignedDealers') || [],
    dealers: [],
    users: [],
    categories: [],
    reportProductGroups: [],
    reportProductSubGroups: [],
    reportGroupSubGroups: {},
    autoSyncTimer: null,
    barcodeSyncTimer: null,
    dashboardFallbackTimer: null,
    dashboardRefreshTimer: null,
    dashboardLoadPromise: null,
    dashboardLoaded: false,
    dashboardLastLoadedAt: 0,
    scanRefreshTimer: null,
    scanRefreshInFlight: false,
    scanRefreshQueued: false,
    deviceRefreshTimer: null,
    lastRealtimeAt: 0,
    dashboardFallbackBusy: false,
    recentRealtimeScanIds: new Set(),
    dashboardProductGroupRows: [],
    dashboardProductGroupLoadPromise: null,
    dashboardProductGroupLoadedAt: 0,
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
    reportAutoLoadTimer: null,
    reportRealtimeTimer: null,
    reportStaleNoticeAt: 0,
    reportTableRows: [],
    reportTableColumns: [],
    reportTableTotalRows: 0,
    reportTableGrandTotal: null,
    reportTableSummary: null,
    reportTableSections: null,
    reportFilterSettings: {},
    reportFilterSettingsLoaded: new Set(),
    reportFilterDropdownsLoadedAt: 0,
    reportSort: { reportType: '', key: '', direction: 'asc' },
    dashboardDealerCode: '',
    dealersLoadPromise: null,
    dealersLoadedAt: 0,
    reconLoaded: false,
    reconRefreshTimer: null,
    validatorInvalidRows: [],
    validatorMapIndex: null,
    catalogueFailureDownloadId: '',
    catalogueUploadSessionId: '',
    catalogueUploadInFlight: false,
    catalogueUploadProgress: { stage: '', percent: 0, message: '', processedRows: 0, totalRows: 0, savedRowsCount: 0, failedRowsCount: 0, duplicateRowsCount: 0 },
    masterCatalogueCount: 0,
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
    plainBinLocations: [],
    plainBinSelectedBins: new Set(),
    binMasterRows: [],
    barcodeAutoSaving: false,
    barcodeLastRaw: '',
    barcodeLastAt: 0,
    barcodeScanLocks: new Map(),
    barcodeDuplicateLocks: new Map(),
    barcodeServerDuplicateChecks: new Map(),
    scanStreamRecords: []
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
    'scan-register': ['dealer', 'dateRange', 'scanType', 'scanStatus', 'userName', 'deviceName', 'syncStatus', 'entryMode'],
    'partwise-inventory-audit': ['dealer', 'dateRange', 'productCategory', 'productGroup', 'productSubGroup', 'partNumber', 'binLocation', 'varianceType', 'scanModeOptions'],
    short: ['dealer', 'dateRange', 'productCategory', 'productGroup', 'productSubGroup', 'partNumber', 'binLocation'],
    excess: ['dealer', 'dateRange', 'productCategory', 'productGroup', 'productSubGroup', 'partNumber', 'binLocation'],
    movement_wise_stock_analysis: ['dealer', 'audit', 'binLocation', 'productCategory', 'partNumber', 'movementStatus'],
    damage: ['dealer', 'dateRange', 'scanType', 'productCategory', 'productGroup', 'productSubGroup', 'partNumber', 'binLocation']
  };
  const REPORT_FILTER_OPTIONS = [
    ['dealer', 'Dealer'],
    ['dealerName', 'Dealer Name'],
    ['dateRange', 'Date / Scan Time Range'],
    ['scanType', 'Scan Type'],
    ['scanStatus', 'Scan Status'],
    ['userName', 'User Name'],
    ['syncStatus', 'Sync Status'],
    ['audit', 'Active Audit ID'],
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
    ['movementStatus', 'Movement Status'],
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
    'raw-upi': 'Raw UPI Report',
    'scan-register': 'Scan Register Report',
    'wrong-not-found-master': 'Rejected Report',
    'stock-summary': 'Stock Summary',
    short: 'Short Report',
    excess: 'Excess Report',
    movement_wise_stock_analysis: 'Movement Wise Stock Analysis Report',
    damage: 'Damage Report',
    'category-wise-variance-summary': 'Category Wise Variance Summary',
    'partwise-inventory-audit': 'Partwise Inventory Audit Report',
    'parts-inventory-refresh-template': 'Part Inventory Refresh Template'
  };
  const CSV_REPORT_TYPES = new Set();
  const NO_PDF_EMAIL_REPORT_TYPES = new Set(['stock-summary', 'parts-inventory-refresh-template']);
  const REPORT_LAYOUT_KEYS = {
    'partwise-inventory-audit': 'partwise_inventory_audit_report_layout_v2',
    short: 'short_report_layout',
    excess: 'excess_report_layout',
    movement_wise_stock_analysis: 'movement_wise_stock_analysis_report_layout',
    damage: 'damage_report_layout',
    'bin-wise-stock': 'bin_wise_report_layout',
    'bin-stock': 'bin_wise_report_layout',
    'bin-wise': 'bin_wise_report_layout',
    'category-wise-variance-summary': 'category_variance_report_layout',
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
    } catch (error) {}
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
    if (normalized) storageSet(scopedStorageKey(LAST_SYNC_KEY), normalized);
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
    const wrapper = $('#dashboardDealerFilters');
    const left = (wrapper || select).getBoundingClientRect().left || 0;
    const button = $('#dashboardViewReportBtn');
    const gap = 10;
    const actionWidth = Math.ceil((button?.getBoundingClientRect().width || 132) + gap);
    const viewportRoom = Math.max(280, window.innerWidth - left - 24);
    const maxSelectWidth = Math.max(220, Math.min(760 - actionWidth, viewportRoom - actionWidth));
    const width = Math.min(Math.max(300, textWidth + 64), maxSelectWidth);
    select.style.width = `${width}px`;
    select.style.maxWidth = '100%';
    if (wrapper) {
      wrapper.style.width = `min(${width + actionWidth}px, 100%)`;
    }
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
    navigateTo('/', { replace: true });
  }

  function clearSession() {
    bootLog('clearSession called');
    const scopedActiveDealerKey = userScopedStorageKey(ACTIVE_DEALER_KEY);
    state.token = '';
    state.user = null;
    state.activeDealerId = '';
    state.assignedDealers = [];
    storageRemove('dakshToken');
    storageRemove('dakshUser');
    storageRemove(ACTIVE_DEALER_KEY);
    storageRemove(scopedActiveDealerKey);
    storageRemove('dakshAssignedDealers');
  }

  function appUrl(path) {
    return new URL(path, window.location.origin).href;
  }

  function navigateTo(path, options = {}) {
    const href = appUrl(path);
    try {
      if (options.replace) window.location.replace(href);
      else window.location.assign(href);
    } catch (error) {
      bootWarn('browser blocked navigation', {
        href,
        error: errorDetails(error)
      });
      const toastNode = $('#toast');
      if (toastNode) {
        toastNode.innerHTML = `Session expired. <a href="${escapeHtml(href)}">Open login</a>`;
        toastNode.className = 'toast active error';
      }
    }
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

  function isAdminUser() {
    return state.user && String(state.user.role || '').toLowerCase() === 'admin';
  }

  function activeDealerId() {
    if (isAdminUser()) return '';
    return cleanDealerCode(state.activeDealerId || storageGet(userScopedStorageKey(ACTIVE_DEALER_KEY)) || storageGet(ACTIVE_DEALER_KEY) || '');
  }

  function dealerByCode(dealerCode) {
    const code = cleanDealerCode(dealerCode || '');
    return (state.dealers || state.assignedDealers || []).find((dealer) => cleanDealerCode(dealer.dealerCode || dealer.code || dealer.id || '') === code) ||
      (state.assignedDealers || []).find((dealer) => cleanDealerCode(dealer.dealerCode || dealer.code || dealer.id || '') === code) ||
      null;
  }

  function activeDealer() {
    return dealerByCode(activeDealerId());
  }

  function shouldAttachDealerScope(path) {
    if (!state.token || isAdminUser()) return false;
    const dealerCode = activeDealerId();
    if (!dealerCode) return false;
    const url = new URL(String(path || ''), window.location.origin);
    if (!url.pathname.startsWith('/api/')) return false;
    return !/^\/api\/auth\//.test(url.pathname) && url.pathname !== '/api/health';
  }

  function withActiveDealerQuery(path) {
    if (!shouldAttachDealerScope(path)) return path;
    const dealerCode = activeDealerId();
    const isAbsolute = /^https?:\/\//i.test(String(path || ''));
    const url = new URL(String(path || ''), window.location.origin);
    if (!url.searchParams.get('activeDealerId')) url.searchParams.set('activeDealerId', dealerCode);
    if (!url.searchParams.get('dealerCode')) url.searchParams.set('dealerCode', dealerCode);
    return isAbsolute ? url.href : `${url.pathname}${url.search}${url.hash}`;
  }

  function withActiveDealerBody(body) {
    if (!body || isAdminUser()) return body;
    const dealerCode = activeDealerId();
    if (!dealerCode) return body;
    if (body instanceof FormData) {
      if (!body.has('activeDealerId')) body.append('activeDealerId', dealerCode);
      if (!body.has('dealerCode') || cleanDealerCode(body.get('dealerCode')) === 'ALL') body.set('dealerCode', dealerCode);
      return body;
    }
    if (typeof body !== 'object' || Array.isArray(body)) return body;
    const next = { ...body, activeDealerId: body.activeDealerId || dealerCode };
    const bodyDealer = cleanDealerCode(next.dealerCode || '');
    if (!bodyDealer || bodyDealer === 'ALL') next.dealerCode = dealerCode;
    return next;
  }

  async function api(path, options = {}) {
    const headers = options.headers ? { ...options.headers } : {};
    const requestPath = apiUrl(withActiveDealerQuery(path));
    const requestBody = options.body ? withActiveDealerBody(options.body) : options.body;
    const isFormData = requestBody instanceof FormData;
    if (!isFormData) headers['Content-Type'] = 'application/json';
    if (state.token) headers.Authorization = `Bearer ${state.token}`;

    const isMobileSyncRequest = /^\/api\/mobile\/|^\/api\/sync\//.test(path);

    const response = await fetch(requestPath, {
      ...options,
      headers,
      body: isFormData ? requestBody : requestBody ? JSON.stringify(requestBody) : undefined
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
    const response = await fetch(apiUrl(withActiveDealerQuery(path)), {
      headers: state.token ? { Authorization: `Bearer ${state.token}` } : {}
    });
    if (!response.ok) throw new Error(apiErrorMessage(await parseApiResponse(response), response.statusText));
    const blob = await response.blob();
    triggerDownload(blob, fileName);
  }

  async function downloadPost(path, body, fileName) {
    const response = await fetch(apiUrl(withActiveDealerQuery(path)), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {})
      },
      body: JSON.stringify(withActiveDealerBody(body))
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

  function moveMasterDataAdminTools() {
    const userPanel = $('#userApprovalTab');
    const deletePanel = $('#adminDeleteMasterTab');
    const userCard = $('#createUserForm')?.closest('.card');
    const editModal = $('#editUserModal');
    const adminDeleteCard = $('.admin-delete-card');

    if (userPanel && userCard && userCard.parentElement !== userPanel) userPanel.appendChild(userCard);
    if (userPanel && editModal && editModal.parentElement !== userPanel) userPanel.appendChild(editModal);
    if (deletePanel && adminDeleteCard && adminDeleteCard.parentElement !== deletePanel) deletePanel.appendChild(adminDeleteCard);
  }

  function formObject(form) {
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());
    const dealerAccessValues = formData.getAll('dealerAccess')
      .flatMap((value) => Array.isArray(value) ? value : String(value || '').split(/[,;\n]+/))
      .map(cleanDealerCode)
      .filter(Boolean);
    if (dealerAccessValues.length) data.dealerAccess = dealerAccessValues;
    if (data.dealerCode) data.dealerCode = cleanDealerCode(data.dealerCode);
    return data;
  }

  function cleanDealerCode(value) {
    const text = String(value || '').trim();
    if (text.toLowerCase() === 'all') return 'ALL';
    const match = text.match(/\(([^()]+)\)\s*$/);
    if (match) return match[1].trim().toUpperCase();
    const dashMatch = text.match(/^([A-Za-z0-9_]{3,})\s+-\s+.+$/);
    return (dashMatch ? dashMatch[1] : text).trim().toUpperCase();
  }

  function cleanDealerAccessInput(value) {
    const rawItems = Array.isArray(value) ? value : String(value || '').split(/[,;\n]+/);
    return Array.from(new Set(rawItems
      .map(cleanDealerCode)
      .filter(Boolean)));
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
    node.classList.remove('green-dot', 'red-dot', 'orange-dot', 'blue-dot', 'yellow-dot');
    node.classList.add(ok ? 'green-dot' : 'red-dot');
  }

  function setStatusPill(id, text, status = 'green') {
    const node = $(`#${id}`);
    if (!node) return;
    node.textContent = text;
    node.classList.remove('green-dot', 'red-dot', 'orange-dot', 'blue-dot', 'yellow-dot');
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
      status.databaseStatus ||
      status.postgresStatus ||
      status.activeDatabase ||
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
    const activeDealer = activeDealerId();
    if (activeDealer) return activeDealer;
    const selected = $$('.dealerSelect')
      .map((select) => cleanDealerCode(select.value || ''))
      .find((value) => value && value !== 'ALL');
    if (selected) return selected;
    if (state.activeAudit && state.activeAudit.dealerCode) return cleanDealerCode(state.activeAudit.dealerCode);
    return '';
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
    const selectedDealer = activeDealerId();
    if (selectedDealer) {
      const dealer = activeDealer() || {};
      return {
        ...payload,
        dealerCode: selectedDealer,
        activeDealerId: selectedDealer,
        dealerName: dealer.dealerName || dealer.name || payload.dealerName || '',
        auditId: (state.activeAudit && state.activeAudit.auditId) || dealer.currentAuditId || payload.auditId || '',
        syncKey: ''
      };
    }
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
    const selectedDealer = activeDealerId();
    if (selectedDealer) {
      params.set('dealerCode', selectedDealer);
      params.set('activeDealerId', selectedDealer);
      const dealer = activeDealer() || {};
      const auditId = (state.activeAudit && state.activeAudit.auditId) || dealer.currentAuditId || '';
      if (auditId) params.set('auditId', auditId);
      return params;
    }
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

  function availableActiveDealers() {
    const source = (state.assignedDealers && state.assignedDealers.length ? state.assignedDealers : state.dealers) || [];
    return source.filter((dealer) => !isTestDealer(dealer));
  }

  function setActiveDealerId(dealerCode, options = {}) {
    const code = cleanDealerCode(dealerCode || '');
    state.activeDealerId = code;
    const scopedActiveDealerKey = userScopedStorageKey(ACTIVE_DEALER_KEY);
    if (code) {
      storageSet(ACTIVE_DEALER_KEY, code);
      storageSet(scopedActiveDealerKey, code);
    } else {
      storageRemove(ACTIVE_DEALER_KEY);
      storageRemove(scopedActiveDealerKey);
    }
    if (options.persistAssigned !== false && state.assignedDealers) {
      storageSet('dakshAssignedDealers', JSON.stringify(state.assignedDealers));
    }
    $$('.dealerSelect').forEach((select) => {
      if (code && Array.from(select.options || []).some((option) => cleanDealerCode(option.value) === code)) {
        setDealerSelectValue(select, code);
        syncDealerSelectDisplay(select);
      }
    });
    renderSyncQueue();
    renderSyncLog();
    updateSyncBadges();
    updateActiveAuditUi();
  }

  function ensureActiveDealerSelection() {
    if (isAdminUser()) return;
    const dealers = availableActiveDealers();
    const current = activeDealerId();
    if (current && dealers.some((dealer) => cleanDealerCode(dealer.dealerCode || dealer.code || dealer.id || '') === current)) return;
    if (current) setActiveDealerId('', { persistAssigned: true });
    if (dealers.length === 1) setActiveDealerId(dealers[0].dealerCode || dealers[0].code || dealers[0].id || '');
  }

  function renderActiveDealerSwitch() {
    const select = $('#activeDealerSwitch');
    if (!select) return;
    const dealers = availableActiveDealers();
    select.hidden = isAdminUser() || !dealers.length;
    if (select.hidden) return;
    const selected = activeDealerId();
    select.innerHTML = dealers.length > 1
      ? '<option value="">Select Dealer</option>'
      : '';
    select.innerHTML += dealers.map((dealer) => (
      `<option value="${escapeHtml(dealer.dealerCode || dealer.code || dealer.id || '')}">${escapeHtml(formatDealerDisplay(dealer))}</option>`
    )).join('');
    if (selected) setDealerSelectValue(select, selected);
  }

  async function switchActiveDealer(dealerCode) {
    const next = cleanDealerCode(dealerCode || '');
    if (!next || next === activeDealerId()) return;
    const counts = syncCounts();
    if (counts.total && !window.confirm(`Pending scans exist for ${activeDealerId() || 'current dealer'}. Switch dealer now?`)) {
      renderActiveDealerSwitch();
      return;
    }
    setActiveDealerId(next);
    state.dashboardDealerCode = next;
    syncScanDealerScope(next);
    state.selectedProductGroupSummary = null;
    state.productGroupDetailRows = [];
    state.productGroupDetailTotals = null;
    renderProductGroupDetails({ rows: [], totals: {} });
    const jobs = [];
    if ($('#dashboard')?.classList.contains('active')) jobs.push(loadDashboard({ force: true }));
    if ($('#scan')?.classList.contains('active')) jobs.push(loadScanHistory());
    if ($('#syncCenter')?.classList.contains('active')) jobs.push(loadSyncStatus());
    if ($('#devices')?.classList.contains('active')) jobs.push(loadDevices());
    await Promise.all(jobs.map((job) => job.catch((error) => toast(error.message, 'error'))));
  }

  function updateActiveAuditUi() {
    const audit = state.activeAudit;
    const selectedDealer = activeDealer();
    if (selectedDealer) {
      $$('.dealerSelect').forEach((select) => {
        if (select.closest('#reportFilters') && isAdminUser()) return;
        if (select.id === 'dashboardDealerSelect' && state.dashboardDealerCode) {
          setDealerSelectValue(select, state.dashboardDealerCode);
          syncDealerSelectDisplay(select);
          return;
        }
        setDealerSelectValue(select, selectedDealer.dealerCode || selectedDealer.code || selectedDealer.id || '');
        syncDealerSelectDisplay(select);
      });
      setLivePill('activeAuditBadge', `${formatDealerDisplay(selectedDealer)}`, true);
      setLivePill('pairingConnectionStatus', 'Ready', true);
      setDashboardKpiValue('dashActiveAuditDealer', formatDealerDisplay(selectedDealer));
      setText('pairingActiveAudit', formatDealerDisplay(selectedDealer));
      setText('pairingStatusText', 'Mobile sync enabled');
    } else if (audit && audit.dealerCode) {
      setLivePill('activeAuditBadge', `Active Audit: ${formatDealerDisplay(audit)}`, true);
      setLivePill('pairingConnectionStatus', 'Ready', true);
      setDashboardKpiValue('dashActiveAuditDealer', formatDealerDisplay(audit));
      setText('pairingActiveAudit', formatDealerDisplay(audit));
      setText('pairingStatusText', 'Mobile sync enabled');
      const createUserDealerAccess = $('#createUserForm [name="dealerAccess"]');
      if (createUserDealerAccess && !Array.from(createUserDealerAccess.selectedOptions || []).length) {
        setMultiSelectValues(createUserDealerAccess, [audit.dealerCode]);
      }
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
      if (!data.success) {
        const message = data.message || 'No active audit found. Please start audit from PC Admin.';
        if (options.allowMissing && /no active audit/i.test(message)) {
          state.activeAudit = null;
          updateActiveAuditUi();
          return null;
        }
        throw new Error(message);
      }
      state.activeAudit = data;
      updateActiveAuditUi();
      return data;
    } catch (error) {
      state.activeAudit = null;
      updateActiveAuditUi();
      if (options.allowMissing && /no active audit/i.test(error.message || '')) return null;
      if (!options.silent) toast(error.message, 'error');
      throw error;
    }
  }

  function resolveMobileScannerUrl(info = {}) {
    const serverUrl = info.serverUrl || (info.ip && info.port ? `http://${info.ip}:${info.port}` : '');
    if (info.scanUrl) return info.scanUrl;
    if (info.mobileScannerUrl) return info.mobileScannerUrl;
    if (serverUrl) return `${String(serverUrl).replace(/\/+$/, '')}/mobile-scanner`;
    return `${window.location.origin.replace(/\/+$/, '')}/mobile-scanner`;
  }

  function applyServerInfo(info = {}) {
    const serverUrl = info.serverUrl || (info.ip && info.port ? `http://${info.ip}:${info.port}` : '');
    const mobileScannerUrl = resolveMobileScannerUrl({ ...state.serverInfo, ...info, serverUrl });
    state.serverInfo = {
      ...state.serverInfo,
      ...info,
      serverUrl,
      mobileScannerUrl
    };
    setText('pairingServerIp', state.serverInfo.ip || 'Unavailable');
    setText('pairingServerPort', state.serverInfo.port || '3001');
    setText('pairingServerUrl', serverUrl || 'Unavailable');
    setText('pairingMobileScannerUrl', mobileScannerUrl || 'Unavailable');
    setText('pairingHealthUrl', state.serverInfo.healthUrl || (serverUrl ? `${serverUrl}/api/health` : 'Unavailable'));
    setText('syncServerIp', state.serverInfo.ip || 'Unavailable');
    setText('syncServerPort', state.serverInfo.port || '3001');
    setText('syncServerUrlText', serverUrl || 'Unavailable');
    setText('syncMobileScannerUrlText', mobileScannerUrl || 'Unavailable');
    setText('systemSubline', `Mobile scanner: ${mobileScannerUrl || 'Unavailable'}`);
    setText('mobileUrl', `Mobile scanner: ${mobileScannerUrl || 'Unavailable'}`);
  }

  async function loadHealth() {
    const data = await api('/api/health');
    applyServerInfo(data);
    const serverOk = data.server === 'online';
    const dbOk = data.db === 'connected';
    setLivePill('syncServerStatus', serverOk ? 'Connected' : 'Offline', serverOk);
    setLivePill('syncDatabaseStatus', dbOk ? 'Connected' : 'Offline', dbOk);
    setDashboardSyncStatus(serverOk && dbOk ? 'Synced' : 'Failed', serverOk && dbOk);
    if (!serverOk || !dbOk) throw new Error('Server or PostgreSQL is not connected');
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

  function activeAuditIdForScope() {
    return String((state.activeAudit && state.activeAudit.auditId) || (activeDealer() && activeDealer().currentAuditId) || 'activeAudit').trim() || 'activeAudit';
  }

  function scopedStorageKey(baseKey) {
    const dealerCode = activeDealerId();
    if (!dealerCode) return baseKey;
    return `${baseKey}:${dealerCode}:${activeAuditIdForScope()}`;
  }

  function getSyncQueue() {
    const queue = readJsonStorage(scopedStorageKey(SYNC_QUEUE_KEY), []);
    return Array.isArray(queue) ? queue : [];
  }

  function saveSyncQueue(queue) {
    writeJsonStorage(scopedStorageKey(SYNC_QUEUE_KEY), queue);
    renderSyncQueue();
  }

  function getSyncLog() {
    const log = readJsonStorage(scopedStorageKey(SYNC_LOG_KEY), []);
    return Array.isArray(log) ? log : [];
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
    writeJsonStorage(scopedStorageKey(SYNC_LOG_KEY), logs.slice(0, 200));
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

  function barcodeScanKey(scan = {}) {
    const dealerCode = cleanDealerCode(scan.dealerCode || currentDealerCode() || '');
    const auditId = String(scan.auditId || activeAuditIdForScope() || '').trim();
    const upiId = normalizePartText(extractUpiIdFromText(scan) || scan.upiId || scan.upiNo || '');
    if (dealerCode && auditId && upiId) return [dealerCode, auditId, upiId].join('|');
    const raw = normalizePartText(scan.rawScan || scan.rawScanString || scan.rawBarcode || scan.rawScanValue || scan.barcodeValue || scan.scanText || '');
    if (raw) return [dealerCode || 'NO-DEALER', auditId || 'NO-AUDIT', 'RAW', raw].join('|');
    const id = clean(scan.uniqueScanId || scan.scanId || scan.syncKey || scan.localId || '');
    return id ? [dealerCode || 'NO-DEALER', auditId || 'NO-AUDIT', 'ID', id].join('|') : '';
  }

  function suppressTimedKey(map, key, ttlMs = 3000) {
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

  function lockBarcodeScan(scan = {}, ttlMs = 3000) {
    return suppressTimedKey(state.barcodeScanLocks, barcodeScanKey(scan), ttlMs);
  }

  function lockBarcodeDuplicateNotice(scan = {}, ttlMs = 3000) {
    return suppressTimedKey(state.barcodeDuplicateLocks, barcodeScanKey(scan), ttlMs);
  }

  function barcodeDuplicateMessage(existing = {}) {
    const bin = clean(existing.binLocation || existing.bin || '-');
    const part = clean(existing.partNumber || existing.part || '-');
    return `This UPI is already scanned in Bin ${bin}, Part No ${part}`;
  }

  function normalizeQueuedHistoryScan(scan = {}) {
    const syncStatus = String(scan.localStatus || scan.syncStatus || '').trim().toLowerCase();
    const displayStatus = ['synced', 'failed', 'duplicate', 'rejected'].includes(syncStatus) ? syncStatus : 'pending';
    const timestamp = scan.timestamp || scan.createdAt || scan.scanTime || new Date().toISOString();
    return {
      ...scan,
      timestamp,
      createdAt: scan.createdAt || timestamp,
      scanTime: scan.scanTime || timestamp,
      syncStatus: displayStatus,
      synced: displayStatus === 'synced',
      isSynced: displayStatus === 'synced',
      scanStatus: displayStatus === 'failed'
        ? 'FAILED'
        : displayStatus === 'duplicate'
          ? 'DUPLICATE_BLOCKED'
          : (scan.scanStatus || 'ACCEPTED'),
      localQueued: ['pending', 'failed'].includes(displayStatus)
    };
  }

  function scanHistoryRecordKey(scan = {}) {
    const upiKey = barcodeScanKey(scan);
    if (upiKey) return upiKey;
    const explicit = clean(scan.scanId || scan.uniqueScanId || scan.syncKey || scan.localId || '');
    if (explicit) return explicit;
    return normalizePartText(scan.rawScan || scan.rawScanString || scan.rawBarcode || scan.rawScanValue || '');
  }

  function scanHistoryRecordAlreadyVisible(scan = {}) {
    const key = scanHistoryRecordKey(scan);
    if (!key) return false;
    return (state.scanHistoryRecords || []).some((item) => scanHistoryRecordKey(item) === key);
  }

  function localQueuedScanHistoryRecords() {
    return getSyncQueue()
      .filter((item) => String(item.scanType || item.type || '').toUpperCase() !== 'VERIFICATION')
      .map((item) => normalizeQueuedHistoryScan(item))
      .filter((scan) => activeAuditMatchesScan(scan) && scanMatchesScanHistoryFilters(scan));
  }

  function localQueuedStreamRecords() {
    return getSyncQueue()
      .filter((item) => String(item.scanType || item.type || '').toUpperCase() !== 'VERIFICATION')
      .map((item) => normalizeQueuedHistoryScan(item))
      .filter((scan) => activeAuditMatchesScan(scan));
  }

  function mergeScanHistoryRecords(serverRecords = []) {
    const merged = [...localQueuedScanHistoryRecords(), ...(Array.isArray(serverRecords) ? serverRecords : [])];
    const seen = new Set();
    return merged.filter((scan) => {
      const key = scanHistoryRecordKey(scan);
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((left, right) => new Date(right.timestamp || right.createdAt || 0) - new Date(left.timestamp || left.createdAt || 0));
  }

  function mergeScanStreamRecords(scans = []) {
    const merged = [...localQueuedStreamRecords(), ...(Array.isArray(scans) ? scans : [])];
    const seen = new Set();
    return merged.filter((scan) => {
      const key = scanHistoryRecordKey(scan);
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((left, right) => new Date(right.timestamp || right.createdAt || 0) - new Date(left.timestamp || left.createdAt || 0)).slice(0, 12);
  }

  function barcodeDuplicateRecord(scan = {}) {
    const key = barcodeScanKey(scan);
    if (!key) return null;
    const queue = getSyncQueue().filter((item) => String(item.scanType || item.type || '').toUpperCase() !== 'VERIFICATION');
    const visibleHistory = state.scanHistoryRecords || [];
    const visibleStream = state.scanStreamRecords || [];
    const allRecords = queue.concat(visibleHistory, visibleStream);
    return allRecords.find((item) => barcodeScanKey(item) === key) || null;
  }

  function removeQueuedBarcodeScan(scan = {}) {
    const key = barcodeScanKey(scan);
    const syncKey = clean(scan.syncKey || '');
    const localId = clean(scan.localId || '');
    if (!key && !syncKey && !localId) return;
    const nextQueue = getSyncQueue().filter((item) => {
      if (syncKey && item.syncKey === syncKey) return false;
      if (localId && item.localId === localId) return false;
      return key ? barcodeScanKey(item) !== key : true;
    });
    saveSyncQueue(nextQueue);
  }

  function replaceVisibleBarcodeScan(scan = {}, replacement = {}) {
    const key = scanHistoryRecordKey(scan);
    const replace = (records = []) => {
      let replaced = false;
      const next = records.map((item) => {
        if (key && scanHistoryRecordKey(item) === key) {
          replaced = true;
          return replacement;
        }
        return item;
      });
      return replaced ? next : [replacement].concat(next);
    };
    state.scanHistoryRecords = mergeScanHistoryRecords(replace(state.scanHistoryRecords || [])).slice(0, 500);
    state.scanStreamRecords = mergeScanStreamRecords(replace(state.scanStreamRecords || []));
    const historyBody = $('#scanHistoryRows');
    if (historyBody) {
      historyBody.innerHTML = state.scanHistoryRecords.length ? state.scanHistoryRecords.map(scanHistoryRow).join('') : '<tr><td colspan="18" class="muted">No scan history found</td></tr>';
      updateScanHistorySummary(state.scanHistoryRecords, scanHistorySummary(state.scanHistoryRecords, {}));
      bindScanHistoryActions();
    }
    renderScanStream(state.scanStreamRecords);
  }

  function isBarcodeScanRecentlyLocked(scan = {}, ttlMs = 3000) {
    const key = barcodeScanKey(scan);
    if (!key) return false;
    return suppressTimedKey(state.barcodeScanLocks, key, ttlMs);
  }

  function validPartText(value) {
    return /^[A-Z0-9][A-Z0-9._/-]{2,39}$/.test(normalizePartText(value));
  }

  function parseRawScanText(rawScan) {
    const raw = String(rawScan || '').trim();
    const parts = raw.split('/');
    if (parts.length >= 6 && parts[3] && parts[4] && parts[5]) {
      const slashQty = optionalScanNumber(parts[4]);
      const slashMrp = optionalScanNumber(parts[5]);
      return {
        upiId: normalizePartText(parts[1]),
        partNumber: normalizePartText(parts[3]),
        qty: slashQty !== undefined ? slashQty : 1,
        qtyProvided: slashQty !== undefined,
        mrp: slashMrp,
        mrpProvided: slashMrp !== undefined,
        rawScan: raw
      };
    }
    const data = {};
    try {
      const params = new URLSearchParams(raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : raw.replace(/[|;]/g, '&'));
      params.forEach((value, key) => {
        data[key.toLowerCase().replace(/[^a-z0-9]/g, '')] = value;
      });
    } catch (error) {
      raw.split(/[|,;\n\r]+/).forEach((token) => {
        const splitAt = token.search(/[:=]/);
        if (splitAt <= 0) return;
        data[token.slice(0, splitAt).toLowerCase().replace(/[^a-z0-9]/g, '')] = token.slice(splitAt + 1).trim();
      });
    }
    raw.split(/[|,;\n\r]+/).forEach((token) => {
      const splitAt = token.search(/[:=]/);
      if (splitAt <= 0) return;
      data[token.slice(0, splitAt).toLowerCase().replace(/[^a-z0-9]/g, '')] = token.slice(splitAt + 1).trim();
    });
    const firstRaw = (keys) => {
      for (const key of keys) {
        const value = data[key.toLowerCase()];
        if (value !== undefined && String(value).trim() !== '') return String(value).trim();
      }
      return '';
    };
    const kvMatch = raw.match(/(?:part\s*no|part|pn|sku)\s*[:=#-]?\s*([a-z0-9._/-]+)/i);
    const qtyMatch = raw.match(/(?:qty|quantity|q)\s*[:=]\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
    const explicitQty = optionalScanNumber(firstRaw(['qty', 'quantity', 'q']) || (qtyMatch ? qtyMatch[1] : ''));
    const mrpMatch = raw.match(/(?:mrp|price)\s*[:=]\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
    const explicitMrp = optionalScanNumber(firstRaw(['mrp', 'price']) || (mrpMatch ? mrpMatch[1] : ''));
    const parsedPart = firstRaw(['partno', 'partnumber', 'part', 'pn', 'sku', 'item', 'p']) || (kvMatch ? kvMatch[1] : '');
    const meta = {
      dealerCode: normalizePartText(firstRaw(['dealercode', 'dealer', 'dc'])),
      auditId: firstRaw(['auditid', 'audit', 'auditno', 'auditnumber']),
      binLocation: firstRaw(['bin', 'binlocation', 'location', 'rack']),
      scanType: normalizePartText(firstRaw(['type', 'scantype', 'movement'])),
      staffName: firstRaw(['staffname', 'staff', 'username', 'user', 'operator', 'scannedby']),
      upiId: normalizePartText(firstRaw(['upino', 'upi', 'upiid', 'serial', 'sequence']))
    };
    if (parsedPart) {
      const partNumber = normalizePartText(parsedPart);
      return {
        ...meta,
        partNumber: validPartText(partNumber) ? partNumber : '',
        qty: explicitQty,
        qtyProvided: explicitQty !== undefined,
        mrp: explicitMrp,
        mrpProvided: explicitMrp !== undefined,
        rawScan: raw
      };
    }
    const simple = normalizePartText(raw);
    return {
      ...meta,
      partNumber: validPartText(simple) ? simple : '',
      qty: undefined,
      qtyProvided: false,
      mrp: explicitMrp,
      mrpProvided: explicitMrp !== undefined,
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
    const scanType = String(payload.scanType || payload.action || payload.type || payload.movement || parsedRaw.scanType || 'INWARD').trim().toUpperCase();
    const dealerCode = String(payload.dealerCode || payload.dealer || parsedRaw.dealerCode || '').trim().toUpperCase();
    const upiId = extractUpiIdFromText(payload) || parsedRaw.upiId || '';
    const payloadMrp = optionalScanNumber(payload.mrp);
    const parsedMrp = optionalScanNumber(parsedRaw.mrp);
    const manualPayload = /\bmanual\b/i.test([payload.source, payload.scanMode, payload.entryMode].filter(Boolean).join(' '));
    const mrpProvided = parsedRaw.mrpProvided === true || payload.mrpProvided === true || payload.mrpProvided === 'true' || (manualPayload && payloadMrp !== undefined);
    const payloadDlc = optionalScanNumber(payload.dlc);
    const dlcProvided = payload.dlcProvided === true || payload.dlcProvided === 'true' || (manualPayload && payloadDlc !== undefined);
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
      auditId: payload.auditId || parsedRaw.auditId || '',
      upiId,
      quantity: finalQty,
      qty: finalQty,
      binLocation: payload.binLocation || payload.bin || parsedRaw.binLocation || '',
      bin: payload.bin || payload.binLocation || parsedRaw.binLocation || '',
      rawScanString: rawScanValue || partNumber,
      rawScan: rawScanValue || partNumber,
      rawBarcode: payload.rawBarcode || rawScanValue || partNumber,
      rawScanValue: payload.rawScanValue || rawScanValue || partNumber,
      staffName: payload.staffName || parsedRaw.staffName || (state.user ? state.user.name || state.user.username : ''),
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
    if (String(normalized.scanType || normalized.type || '').toUpperCase() === 'VERIFICATION') return normalized;
    const queue = getSyncQueue();
    const existingHistory = barcodeDuplicateRecord(normalized);
    if (existingHistory) {
      return { ...normalized, queueAdded: false, queueDuplicate: true, existingLocalScan: existingHistory };
    }
    const exists = queue.find((item) => item.syncKey === normalized.syncKey || barcodeScanKey(item) === barcodeScanKey(normalized) || (normalized.upiId && normalizePartText(item.upiId) === normalizePartText(normalized.upiId)));
    let queuedRecord = null;
    if (!exists) {
      queuedRecord = {
        ...normalized,
        localId: normalized.localId || `LOCAL-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        synced: false,
        isSynced: false,
        syncStatus: 'pending',
        localStatus: 'pending',
        retryCount: 0,
        syncError: errorMessage
      };
      queuedRecord.scanId = queuedRecord.scanId || queuedRecord.localId;
      queuedRecord.uniqueScanId = queuedRecord.uniqueScanId || queuedRecord.localId;
      queue.push(queuedRecord);
      saveSyncQueue(queue);
    } else {
      return { ...normalized, queueAdded: false, queueDuplicate: true, existingLocalScan: exists };
    }
    addSyncLog({
      partNumber: normalized.partNumber,
      upiId: normalized.upiId,
      dealer: normalized.dealerCode,
      status: 'queued',
      errorMessage
    });
    return { ...queuedRecord, queueAdded: true, queueDuplicate: false };
  }

  function schedulePendingSync(delay = 120) {
    clearTimeout(state.barcodeSyncTimer);
    state.barcodeSyncTimer = setTimeout(() => {
      if (document.hidden) return;
      syncPendingQueue({ checkHealth: false, silent: true, includeFailed: false })
        .then((result) => {
          if (result && result.skipped && syncCounts().pending) schedulePendingSync(700);
        })
        .catch((error) => addConnectionLog(`Background sync skipped: ${error.message}`, 'warning'));
    }, delay);
  }

  async function checkServerBarcodeDuplicate(scan = {}) {
    const key = barcodeScanKey(scan) || clean(scan.syncKey || scan.localId || '');
    if (!key) return null;
    if (state.barcodeServerDuplicateChecks.has(key)) return state.barcodeServerDuplicateChecks.get(key);
    const promise = api('/api/scans/duplicate-check', {
      method: 'POST',
      body: scan
    }).then((data) => (data && data.duplicate ? data : null))
      .catch((error) => {
        addConnectionLog(`Duplicate check skipped: ${error.message}`, 'warning');
        return null;
      })
      .finally(() => {
        setTimeout(() => state.barcodeServerDuplicateChecks.delete(key), 3000);
      });
    state.barcodeServerDuplicateChecks.set(key, promise);
    return promise;
  }

  function handleBarcodeDuplicate(scan = {}, duplicate = {}) {
    const existing = duplicate.scan || duplicate.existing || duplicate;
    const duplicateRow = normalizeQueuedHistoryScan({
      ...scan,
      ...existing,
      localId: scan.localId || existing.localId,
      syncKey: scan.syncKey || existing.syncKey,
      uniqueScanId: scan.uniqueScanId || scan.localId || existing.uniqueScanId,
      scanId: scan.scanId || scan.localId || existing.scanId,
      timestamp: scan.timestamp || existing.timestamp || new Date().toISOString(),
      syncStatus: 'duplicate',
      localStatus: 'duplicate',
      scanStatus: 'DUPLICATE_BLOCKED',
      syncError: duplicate.message || barcodeDuplicateMessage(existing || scan)
    });
    removeQueuedBarcodeScan(scan);
    replaceVisibleBarcodeScan(scan, duplicateRow);
    const message = barcodeDuplicateMessage(existing && (existing.partNumber || existing.part || existing.binLocation || existing.bin) ? existing : scan);
    addSyncLog({
      partNumber: scan.partNumber || existing.partNumber || existing.part,
      upiId: scan.upiId || existing.upiId || existing.upiNo,
      dealer: scan.dealerCode || existing.dealerCode,
      status: 'duplicate',
      errorMessage: message
    });
    if (!lockBarcodeDuplicateNotice(scan, 3000)) {
      playScanTone('duplicate');
      toast(message, 'error');
    }
    setLivePill('barcodeReadyStatus', 'Duplicate - Not Added', false);
    updateSyncBadges();
  }

  async function syncBarcodeScanAfterDuplicateCheck(scan = {}) {
    const duplicate = await checkServerBarcodeDuplicate(scan);
    if (duplicate && duplicate.duplicate) {
      handleBarcodeDuplicate(scan, duplicate);
      return duplicate;
    }
    return syncPendingQueue({ checkHealth: false, silent: true, includeFailed: true });
  }

  function syncCounts() {
    const queue = getSyncQueue().filter((item) => String(item.scanType || item.type || '').toUpperCase() !== 'VERIFICATION');
    return {
      pending: queue.filter((item) => item.localStatus === 'pending' || !item.localStatus).length,
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
    state.autoSyncTimer = setInterval(() => {
      if (document.hidden) return;
      const counts = syncCounts();
      if (!counts.pending && !counts.failed) return;
      syncPendingQueue({ silent: true, includeFailed: true }).catch(console.warn);
    }, 30000);
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
    const lastSync = rememberLastSyncTime(reportedLastSync) || (serverReportedNoSync ? '' : normalizeLastSyncValue(storageGet(scopedStorageKey(LAST_SYNC_KEY))));
    storageSet(AUTO_SYNC_KEY, 'true');
    const serverStatusText = String(connectionStatus.server || connectionStatus.serverStatus || '').toLowerCase();
    const databaseStatusText = String(connectionStatus.db || connectionStatus.databaseStatus || connectionStatus.postgresStatus || '').toLowerCase();
    const serverKnown = Boolean(serverStatusText);
    const databaseKnown = Boolean(databaseStatusText);
    const serverOnline = serverKnown ? serverStatusText === 'online' : null;
    const databaseOnline = databaseKnown ? databaseStatusText === 'connected' || databaseStatusText === 'online' : null;
    const connectedDevices = Number(status.connectedDevices ?? connectionStatus.connectedDevices ?? state.activeDeviceCount ?? 0);
    const totalSynced = Number(status.totalSynced ?? connectionStatus.totalSynced ?? $('#syncTotal')?.textContent ?? 0);
    state.activeDeviceCount = connectedDevices;

    const connectionOk = (!serverKnown || serverOnline) && (!databaseKnown || databaseOnline);
    const syncDetail = connectionOk ? (counts.total ? 'Pending' : 'Synced') : 'Failed';
    const syncOk = connectionOk && !counts.total;
    if (serverKnown) setStatusPill('topServerStatus', serverOnline ? 'Server: Connected' : 'Server: Offline', serverOnline ? 'green' : 'red');
    if (serverKnown && databaseKnown) setDashboardSyncStatus(syncDetail, syncOk);
    setHeaderDeviceStatus(connectedDevices);
    setHeaderSyncStatus(syncDetail, syncOk);
    setStatusPill('topPendingStatus', `Pending: ${counts.total}`, counts.total ? 'orange' : 'green');
    if (serverKnown) setLivePill('syncServerStatus', serverOnline ? 'Connected' : 'Offline', serverOnline);
    if (databaseKnown) setLivePill('syncDatabaseStatus', databaseOnline ? 'Connected' : 'Offline', databaseOnline);
    setLivePill('syncCenterAutoState', 'Auto ON', true);
    setText('syncActiveDatabase', connectionStatus.activeDatabase || 'Unknown');
    setStatusPill('syncDatabaseProvider', connectionStatus.databaseProvider || 'postgresql', 'green');
    setStatusPill('syncDatabaseUrl', connectionStatus.activeDatabaseUrl ? 'Configured' : 'Missing', connectionStatus.activeDatabaseUrl ? 'green' : 'red');
    setText('syncCurrentLanIp', connectionStatus.currentLanIp || connectionStatus.lanIp || connectionStatus.ip || '-');
    setStatusPill('syncDatabaseServiceStatus', databaseOnline ? 'Connected' : 'Offline', databaseOnline ? 'green' : 'red');
    setText('syncDatabasePending', counts.total);

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
        updateSyncBadges({ serverStatus: 'offline', databaseStatus: 'offline', db: 'disconnected' });
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
          <td>${escapeHtml(item.localStatus === 'failed' ? 'Failed' : 'Pending')}</td>
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
    markReportsStale('sync completed');
    const scans = Array.isArray(payload.insertedRecords) ? payload.insertedRecords : [];
    scans.slice(-20).forEach((scan) => handleNewScan(scan).catch(() => undefined));
    const jobs = [loadSyncStatus(), loadDevices()];
    if ($('#dashboard')?.classList.contains('active')) jobs.push(loadDashboard({ force: true }));
    if ($('#scan')?.classList.contains('active')) jobs.push(loadScanHistory());
    if (!scans.length && !jobs.some((job) => job === state.dashboardLoadPromise)) jobs.push(loadDashboard({ force: true }), loadScanHistory());
    await Promise.all(jobs);
  }

  function queueReconciliationRefresh(reason = 'realtime scan') {
    if (!state.reconLoaded) return;
    clearTimeout(state.reconRefreshTimer);
    state.reconRefreshTimer = setTimeout(() => {
      loadReconciliation({ silent: true }).catch((error) => {
        addConnectionLog(`Reconciliation refresh skipped after ${reason}: ${error.message}`, 'warning');
      });
    }, 900);
  }

  function queueRealtimeReportRefresh(reason = 'realtime scan') {
    queueReconciliationRefresh(reason);
    markReportsStale(reason);
  }

  function markReportsStale(reason = 'scan update') {
    localStorage.removeItem('dakshReportPreviewCache');
    state.reportCache.clear();
    if (!state.reportHasRun || !activeReportType()) return;
    clearTimeout(state.reportRealtimeTimer);
    state.reportRealtimeTimer = setTimeout(() => {
      if (!$('#reports')?.classList.contains('active') || state.reportLoading) return;
      const message = $('#reportMessage');
      if (message) {
        message.className = 'form-message warning';
        message.textContent = `Report data changed after ${reason}. Refreshing automatically...`;
      }
      loadReport({ forceRefresh: true }).catch((error) => toast(error.message, 'error'));
    }, 500);
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
      navigateTo('/', { replace: true });
      return false;
    }
    bootLog('setUserChrome start', {
      userPresent: Boolean(state.user),
      role: state.user && state.user.role,
      login: userLoginName()
    });
    const roleName = roleDisplayName(state.user && state.user.role);
    const loginName = userLoginName();
    setText('userBadge', `${roleName} - ${loginName} | ${ensureDeviceId()}`);
    setText('userDropdownLogin', loginName);
    setText('userDropdownRole', roleName);
    $$('.admin-only').forEach((node) => node.classList.toggle('hidden', !state.user || state.user.role !== 'admin'));
    const mobileScannerUrl = resolveMobileScannerUrl(state.serverInfo || {});
    setText('systemSubline', `Mobile scanner: ${mobileScannerUrl}`);
    setText('mobileUrl', `Mobile scanner: ${mobileScannerUrl}`);
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
      navigateTo('/', { replace: true });
      return false;
    }
    try {
      bootLog('validateSession request start', {
        endpoint: '/api/auth/me',
        tokenPresent: true
      });
      const data = await api('/api/auth/me');
      state.user = data.user || state.user;
      state.assignedDealers = data.assignedDealers || data.activeDealers || state.assignedDealers || [];
      storageSet('dakshAssignedDealers', JSON.stringify(state.assignedDealers));
      if (!isAdminUser()) {
        const selected = cleanDealerCode(data.activeDealerId || activeDealerId() || '');
        if (selected) setActiveDealerId(selected, { persistAssigned: true });
        else if (state.assignedDealers.length === 1) setActiveDealerId(state.assignedDealers[0].dealerCode || state.assignedDealers[0].id || '', { persistAssigned: true });
      }
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
      navigateTo('/', { replace: true });
      return false;
    }
  }

  async function loadDealers(options = {}) {
    const force = options.force === true;
    if (state.dealersLoadPromise) return state.dealersLoadPromise;
    if (!force && state.dealers.length && Date.now() - state.dealersLoadedAt < 60000) return state.dealers;
    state.dealersLoadPromise = (async () => {
    const data = await api('/api/master/dealers');
    state.dealers = data.dealers || [];
    if (!isAdminUser() && (!state.assignedDealers || !state.assignedDealers.length)) {
      state.assignedDealers = state.dealers.filter((dealer) => !isTestDealer(dealer));
      storageSet('dakshAssignedDealers', JSON.stringify(state.assignedDealers));
    }
    const realDealers = state.dealers.filter((dealer) => !isTestDealer(dealer));
    ensureActiveDealerSelection();
    $$('.dealerSelect').forEach((select) => {
      const selected = cleanDealerCode(select.value);
      const firstOption = !isAdminUser()
        ? '<option value="">Select Dealer</option>'
        : (select.closest('#reportFilters') ? '<option value="">Select Dealer</option>' : (select.id === 'dashboardDealerSelect' ? '<option value="">Active Audit</option>' : (select.classList.contains('bin-transfer-dealer') || select.id === 'binManagementDealer' || select.closest('#binSequenceTab') || select.closest('#reconciliation')) ? '<option value="">Select Dealer</option>' : '<option value="">All Dealers</option>'));
      select.innerHTML = firstOption + realDealers.map((dealer) => (
        `<option value="${escapeHtml(dealer.dealerCode)}">${escapeHtml(formatDealerDisplay(dealer))}</option>`
      )).join('');
      const activeDealer = state.activeAudit && state.activeAudit.dealerCode ? cleanDealerCode(state.activeAudit.dealerCode) : '';
      const scopedDealer = activeDealerId();
      const preferred = select.id === 'scanHistoryDealer'
        ? (scopedDealer || activeDealer || selected)
        : select.closest('#reportFilters')
          ? (selected || scopedDealer || activeDealer)
          : select.id === 'dashboardDealerSelect'
            ? (cleanDealerCode(state.dashboardDealerCode || '') || scopedDealer || activeDealer || selected)
            : (scopedDealer || selected || (select.classList.contains('bin-transfer-dealer') ? activeDealer : ''));
      select.value = Array.from(select.options).some((option) => option.value === preferred) ? preferred : select.options[0].value;
      syncDealerSelectDisplay(select);
    });
    renderActiveDealerSwitch();
    renderDealerAccessOptions();
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
    state.dealersLoadedAt = Date.now();
    return state.dealers;
    })();
    try {
      return await state.dealersLoadPromise;
    } finally {
      state.dealersLoadPromise = null;
    }
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

  async function loadCatalogueRequiredColumns() {
    const body = $('#catalogueRequiredColumnsBody');
    if (!body) return;
    try {
      const data = await api('/api/master-catalogue/required-columns');
      const columns = data.columns || [];
      body.innerHTML = columns.map((col) => `
        <tr>
          <td>${escapeHtml(col.label || col.field || '')}</td>
          <td style="font-family: monospace; font-size: 11px;">${escapeHtml((col.aliases || []).join(', '))}</td>
          <td>${col.mandatory ? '<span class="catalogue-required-yes">Yes</span>' : '<span class="catalogue-required-no">No</span>'}</td>
          <td>${escapeHtml(col.description || '')}</td>
        </tr>
      `).join('') || '<tr><td colspan="4" class="muted">No required columns configured</td></tr>';
    } catch (error) {
      body.innerHTML = `<tr><td colspan="4" class="muted">${escapeHtml(error.message || 'Failed to load column reference')}</td></tr>`;
    }
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
    setDashboardKpiValue('dashStockValueDlc', groupSummaryValue(stats.actualStockValueDLC || stats.totalScannedValue || 0));
    setDashboardKpiValue('dashDamage', wholeNumber(stats.damageCount || 0));
    setDashboardKpiValue('dashDuplicates', wholeNumber(stats.duplicateCount || 0));
    setDashboardKpiValue('dashInventoryCount', wholeNumber(stats.totalScanRecords || stats.totalUniqueScannedParts || 0));
    setDashboardKpiValue('dashConnectedScanners', wholeNumber(stats.activeDevices || 0));
    setDashboardKpiValue('dashFailedScans', wholeNumber(stats.failedCount || stats.mismatchCount || 0));
    setDashboardKpiValue('dashLastScanTime', stats.lastScanTime ? compactDateTime(stats.lastScanTime) : 'Never', { time: true });
    setDashboardKpiValue('dashLastScannedPart', stats.lastScannedPart || '-');
    if (stats.activeDevices !== undefined) setHeaderDeviceStatus(Number(stats.activeDevices || 0));
  }

  function scanQuantity(scan = {}, fallback = 0) {
    const value = scan.qty !== undefined && scan.qty !== null && scan.qty !== '' ? scan.qty : scan.quantity;
    return value !== undefined && value !== null && value !== '' ? value : fallback;
  }

  function scanHistoryPartNumber(scan = {}) {
    return normalizePartText(scan.partNumber || scan.part || scan.normalizedPartNumber || '');
  }

  function scanHistoryQuantity(scan = {}, fallback = 1) {
    const qty = Number(scanQuantity(scan, fallback));
    return Number.isFinite(qty) && qty > 0 ? qty : fallback;
  }

  function scanHistorySummary(records = [], summary = {}) {
    const visibleTotalQty = records.reduce((sum, scan) => sum + scanHistoryQuantity(scan, 1), 0);
    const visibleParts = new Set(records.map(scanHistoryPartNumber).filter(Boolean));
    return {
      scanRows: Number(summary.scanRows ?? summary.totalRecords ?? summary.totalRows ?? records.length),
      partsScanned: Number(summary.partsScanned ?? summary.totalQuantity ?? visibleTotalQty),
      uniqueParts: Number(summary.uniqueParts ?? summary.uniquePartCount ?? visibleParts.size),
      visibleRows: Number(summary.visibleRows ?? records.length)
    };
  }

  function updateScanHistorySummary(records = [], summary = {}) {
    const totals = scanHistorySummary(records, summary);
    setText('scanHistoryTotalQty', wholeNumber(totals.partsScanned));
    setText('scanHistoryTotalRows', wholeNumber(totals.scanRows));
    setText('scanHistoryUniqueParts', wholeNumber(totals.uniqueParts));
    setText('scanHistoryVisibleRows', wholeNumber(totals.visibleRows));
  }

  function scanHistoryQueryParams() {
    const params = new URLSearchParams(queryFromForm($('#scanHistoryFilters')));
    const dealerCode = cleanDealerCode(params.get('dealerCode') || selectedScanDealerCode());
    if (dealerCode && dealerCode !== 'ALL') {
      params.set('dealerCode', dealerCode);
      params.delete('dealer');
    } else {
      params.delete('dealerCode');
    }
    if (!params.has('page')) params.set('page', '1');
    if (!params.has('limit')) params.set('limit', '100');
    return params;
  }

  function scanHistoryFieldText(scan = {}, fields = []) {
    return fields.map((field) => scan[field] || '').join(' ').toUpperCase();
  }

  function scanLooksLikeTestRecord(scan = {}) {
    return /SYNCPT|SCAN TEST|SYNC TEST/i.test([
      scan.dealerCode,
      scan.dealerName,
      scan.deviceId,
      scan.deviceName,
      scan.rawUpi,
      scan.rawScan,
      scan.rawScanString,
      scan.staffName,
      scan.partName,
      scan.partDescription
    ].filter(Boolean).join(' '));
  }

  function scanMatchesScanHistoryFilters(scan = {}) {
    const params = scanHistoryQueryParams();
    const dealerCode = cleanDealerCode(params.get('dealerCode') || '');
    if (dealerCode && dealerCode !== 'ALL' && cleanDealerCode(scan.dealerCode || '') !== dealerCode) return false;

    const part = normalizePartText(params.get('part') || '');
    if (part) {
      const text = scanHistoryFieldText(scan, ['part', 'partNumber', 'normalizedPartNumber', 'rawScan', 'rawScanString', 'rawUpi']);
      if (!text.includes(part)) return false;
    }

    const bin = String(params.get('bin') || '').trim().toUpperCase();
    if (bin) {
      const text = scanHistoryFieldText(scan, ['bin', 'binLocation']);
      if (!text.includes(bin)) return false;
    }

    const type = String(params.get('type') || '').trim().toUpperCase();
    if (type && String(scan.scanType || scan.type || '').trim().toUpperCase() !== type) return false;

    const testScanMode = String(params.get('testScanMode') || 'real').trim().toLowerCase();
    if (testScanMode === 'real' && scanLooksLikeTestRecord(scan)) return false;
    if (testScanMode === 'test' && !scanLooksLikeTestRecord(scan)) return false;
    return true;
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
        <td>${escapeHtml(money(scan.displayMRP ?? scan.currentCatalogueMRP ?? 0))}</td>
        <td>${escapeHtml(scan.scanType || scan.type)}</td>
        <td>${escapeHtml(scan.binLocation || scan.bin)}</td>
        <td>${escapeHtml(scan.dealerCode || '')}</td>
        <td>${escapeHtml(scanEntrySourceLabel(scan))}</td>
        <td>${deviceLink(scan.deviceId)}</td>
        <td>${syncStatusBadge(syncStatus)}</td>
      </tr>
    `;
  }

  function safeScanStreamRow(scan = {}) {
    const syncStatus = normalizedDisplaySyncStatus(scan) || 'pending';
    return `
      <tr>
        <td>${escapeHtml(compactDateTime(scan.timestamp || scan.scanTime || scan.createdAt || ''))}</td>
        <td>${escapeHtml(scan.partNumber || scan.part || scan.normalizedPartNumber || '-')}</td>
        <td>${escapeHtml(scanQuantity(scan, 0))}</td>
        <td>${escapeHtml(money(scan.displayMRP ?? scan.currentCatalogueMRP ?? scan.mrp ?? 0))}</td>
        <td>${escapeHtml(scan.scanType || scan.type || '-')}</td>
        <td>${escapeHtml(scan.binLocation || scan.bin || '-')}</td>
        <td>${escapeHtml(scan.dealerCode || '-')}</td>
        <td>${escapeHtml(scanEntrySourceLabel(scan))}</td>
        <td>${escapeHtml(scan.deviceId || '-')}</td>
        <td>${syncStatusBadge(syncStatus)}</td>
      </tr>
    `;
  }

  function renderScanStream(scans = [], options = {}) {
    const body = $('#streamRows');
    try {
      const merged = mergeScanStreamRecords(scans);
      const rows = options.skipActiveAuditFilter === true ? merged : filterActiveAuditScans(merged);
      state.scanStreamRecords = rows;
      if (body) {
        const emptyLabel = rows.length
          ? ''
          : (options.skipActiveAuditFilter === true
            ? 'No scans yet'
            : (Array.isArray(scans) && scans.length ? 'No scans match the active dealer / audit filter' : 'No scans yet'));
        body.innerHTML = rows.length
          ? rows.map((scan, index) => {
            try {
              return scanStreamRow(scan);
            } catch (rowError) {
              console.warn('[DASHBOARD] stream row render failed', {
                index,
                message: rowError.message
              });
              return safeScanStreamRow(scan);
            }
          }).join('')
          : `<tr><td colspan="10" class="muted">${escapeHtml(emptyLabel)}</td></tr>`;
      }
      if (!rows.length && Array.isArray(merged) && merged.length && options.skipActiveAuditFilter !== true) {
        console.warn('[DASHBOARD] stream filtered to zero rows', {
          activeDealer: dashboardScopeDealerCode(),
          activeAuditId: state.activeAudit && state.activeAudit.auditId ? String(state.activeAudit.auditId).trim() : '',
          inputRows: merged.length
        });
      }
      try {
        enhanceCoreTables();
      } catch (enhanceError) {
        console.warn('[DASHBOARD] stream enhance failed', enhanceError.message);
      }
      return rows;
    } catch (error) {
      console.warn('[DASHBOARD] stream render failed', error.message);
      state.scanStreamRecords = [];
      if (body) body.innerHTML = '<tr><td colspan="10" class="muted">No scans yet</td></tr>';
      return [];
    }
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
    const allRows = (Array.isArray(state.dashboardProductGroupRows) ? state.dashboardProductGroupRows : []).slice().sort((a, b) => {
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
            <td class="number-cell">${escapeHtml(groupSummaryValue(item.totalDlcValue || 0))}</td>
            <td class="number-cell">${escapeHtml(groupSummaryValue(item.totalMrpValue || 0))}</td>
          </tr>
        `;
      }).join('') : '<tr><td colspan="7" class="muted">No product group data found</td></tr>';
    }
    setText('productGroupSummaryCount', `${rows.length} of ${allRows.length} groups`);
    enhanceCoreTables();
  }

  async function loadDashboardProductGroupSummary(options = {}) {
    const force = options.force === true;
    if (state.dashboardProductGroupLoadPromise) return state.dashboardProductGroupLoadPromise;
    if (!force && state.dashboardProductGroupLoadedAt && Date.now() - state.dashboardProductGroupLoadedAt < 5000) return state.dashboardProductGroupRows;
    state.dashboardProductGroupLoadPromise = (async () => {
      const query = dashboardQueryString();
      const data = await api(`/api/scans/dashboard/product-group-summary${query ? `?${query}` : ''}`);
      state.dashboardProductGroupRows = Array.isArray(data.rows) ? data.rows : [];
      state.dashboardProductGroupLoadedAt = Date.now();
      renderProductGroupSummary();
      return state.dashboardProductGroupRows;
    })();
    try {
      return await state.dashboardProductGroupLoadPromise;
    } finally {
      state.dashboardProductGroupLoadPromise = null;
    }
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
    setText('productGroupDetailTotals', `Parts ${groupSummaryNumber(totals.partCount || rows.length)} | Qty ${groupSummaryNumber(totals.totalQty || 0)} | DLC Value ${groupSummaryValue(totals.totalDlcValue || 0)} | MRP Reference ${groupSummaryValue(totals.totalMrpValue || 0)}`);
    body.innerHTML = rows.length ? rows.map((row) => `
      <tr>
        <td>${partLink(row.partNumber)}</td>
        <td>${escapeHtml(row.partDescription || '')}</td>
        <td class="number-cell">${escapeHtml(groupSummaryNumber(row.qty || 0))}</td>
        <td>${escapeHtml(row.binLocation || '')}</td>
        <td class="number-cell">${escapeHtml(groupSummaryValue(row.dlc || 0))}</td>
        <td class="number-cell">${escapeHtml(groupSummaryValue(row.dlcTotal || 0))}</td>
        <td class="number-cell">${escapeHtml(groupSummaryValue(row.mrp || 0))}</td>
        <td class="number-cell">${escapeHtml(groupSummaryValue(row.mrpTotal || 0))}</td>
      </tr>
    `).join('') + `
      <tr class="summary-total-row">
        <td colspan="2">Total</td>
        <td class="number-cell">${escapeHtml(groupSummaryNumber(totals.totalQty || 0))}</td>
        <td>${escapeHtml(groupSummaryNumber(totals.partCount || rows.length))} parts</td>
        <td></td>
        <td class="number-cell">${escapeHtml(groupSummaryValue(totals.totalDlcValue || 0))}</td>
        <td></td>
        <td class="number-cell">${escapeHtml(groupSummaryValue(totals.totalMrpValue || 0))}</td>
      </tr>
    ` : '<tr><td colspan="8" class="muted">No parts found for this group</td></tr>';
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
    state.scanStreamRecords = mergeScanStreamRecords([scan].concat(state.scanStreamRecords || []));
    renderScanStream(state.scanStreamRecords);
  }

  async function handleNewScan(scan = {}, options = {}) {
    if (String(scan.scanType || scan.type || '').trim().toUpperCase() === 'VERIFICATION') return;
    if (!activeAuditMatchesScan(scan)) {
      return;
    }
    const realtimeId = scan.scanId || scan.uniqueScanId || scan._id || scan.syncKey || '';
    if (realtimeId) {
      if (state.recentRealtimeScanIds.has(realtimeId)) return;
      state.recentRealtimeScanIds.add(realtimeId);
      setTimeout(() => state.recentRealtimeScanIds.delete(realtimeId), 15000);
    }
    state.lastRealtimeAt = Date.now();
    if (options.showSuccess === true) showScanPopup(scan);
    addScanToStream(scan);
    prependScanHistory(scan);
    const currentToday = Number(String(($('#dashToday') || {}).textContent || 0).replace(/,/g, ''));
    if (Number.isFinite(currentToday)) setDashboardKpiValue('dashToday', wholeNumber(currentToday + 1));
    const currentScanQty = Number(String(($('#dashTotalScanQty') || {}).textContent || 0).replace(/,/g, ''));
    const scanQty = Number(scanQuantity(scan, 1));
    if (Number.isFinite(currentScanQty)) setDashboardKpiValue('dashTotalScanQty', wholeNumber(currentScanQty + (Number.isFinite(scanQty) ? scanQty : 1)));
    setDashboardKpiValue('dashLastScanTime', compactDateTime(scan.timestamp || new Date()), { time: true });
    setDashboardKpiValue('dashLastScannedPart', scan.partNumber || scan.part || '-');
    setStatusPill('topRealtimeStatus', 'Realtime: Scan Received', 'blue');
    setDashboardKpiValue('dashRealtimeActivity', compactDateTime(scan.timestamp || new Date()), { time: true });
  }

  function setDashboardLoading(loading) {
    const dashboard = $('#dashboard');
    if (dashboard) dashboard.setAttribute('aria-busy', loading ? 'true' : 'false');
    document.body.classList.toggle('app-booting', Boolean(loading));
  }

  async function loadDashboard(options = {}) {
    const force = options.force === true;
    if (state.dashboardLoadPromise) return state.dashboardLoadPromise;
    if (!force && state.dashboardLoaded && Date.now() - state.dashboardLastLoadedAt < 1500) return null;
    if (!state.dashboardLoaded) setDashboardLoading(true);
    state.dashboardLoadPromise = (async () => {
      const query = dashboardQueryString();
      const data = await api(`/api/scans/dashboard${query ? `?${query}` : ''}`);
      if (data.activeAudit && data.activeAudit.dealerCode) {
        state.activeAudit = data.activeAudit;
        updateActiveAuditUi();
      }
      const stats = data.stats || {};
      updateDashboardCards(stats);
      try {
        let recent = data.recent || data.records || data.scans || [];
        if ((!Array.isArray(recent) || !recent.length) && Number(stats.totalScanRecords || stats.totalScannedQuantity || stats.totalScannedValue || 0) > 0) {
          try {
            const fallback = await api(`/api/scans/live?limit=12${query ? `&${query}` : ''}`);
            recent = fallback.records || fallback.scans || recent;
            if (!Array.isArray(recent) || !recent.length) {
              const secondFallback = await api('/api/scans/recent?limit=12');
              recent = secondFallback.records || secondFallback.scans || recent;
            }
          } catch (fallbackError) {
            console.warn('[DASHBOARD] fallback recent load failed', fallbackError.message);
          }
        }
        const rows = renderScanStream(Array.isArray(recent) ? recent : [], { skipActiveAuditFilter: true });
        if (!rows.length && Array.isArray(recent) && recent.length) {
          console.warn('[DASHBOARD] server returned recent scans but none rendered', {
            dealerCode: data.dealerCode || '',
            auditId: data.auditId || '',
            recentCount: recent.length
          });
        }
      } catch (error) {
        console.warn('[DASHBOARD] recent stream load failed', error.message);
        renderScanStream([]);
      }
      state.dashboardLoaded = true;
      state.dashboardLastLoadedAt = Date.now();
      loadDashboardProductGroupSummary({ force }).catch((error) => {
        const body = $('#productGroupSummaryRows');
        if (body) body.innerHTML = `<tr><td colspan="7" class="muted">${escapeHtml(error.message)}</td></tr>`;
      });
      return data;
    })();
    try {
      return await state.dashboardLoadPromise;
    } finally {
      state.dashboardLoadPromise = null;
      setDashboardLoading(false);
    }
  }

  function syncScanDealerScope(dealerCode, sourceSelect = null) {
    const cleanCode = cleanDealerCode(dealerCode || '');
    if (cleanCode) {
      $$('#scan select[name="dealerCode"].dealerSelect').forEach((select) => {
        if (select !== sourceSelect) setDealerSelectValue(select, cleanCode);
      });
    }
    const dashboardDealer = $('#dashboardDealerSelect');
    if (dashboardDealer && dashboardDealer !== sourceSelect && cleanCode && cleanCode !== 'ALL') {
      setDealerSelectValue(dashboardDealer, cleanCode);
      syncDealerSelectDisplay(dashboardDealer);
      state.dashboardDealerCode = cleanCode;
    }
    const reportDealer = $('[name="dealerCode"]', $('#reportFilters'));
    if (reportDealer && reportDealer !== sourceSelect && cleanCode) {
      setDealerSelectValue(reportDealer, cleanCode, 'all');
      syncDealerSelectDisplay(reportDealer);
    }
  }

  async function loadScanHistory() {
    const params = scanHistoryQueryParams();
    const query = params.toString();
    const requestId = `${Date.now()}:${Math.random()}`;
    state.scanHistoryLoadRequestId = requestId;
    const data = await api(`/api/scans/history?${query}`);
    if (state.scanHistoryLoadRequestId !== requestId) return;
    const records = mergeScanHistoryRecords(data.records || []);
    state.scanHistoryRecords = records;
    const summary = scanHistorySummary(records, {});
    state.scanHistorySummary = { ...(data.summary || {}), ...summary };
    updateScanHistorySummary(records, state.scanHistorySummary);
    $('#scanHistoryRows').innerHTML = records.map(scanHistoryRow).join('') || '<tr><td colspan="18" class="muted">No scan history found</td></tr>';
    enhanceCoreTables();
    bindScanHistoryActions();
  }

  function canEditScanDetails(scan = {}) {
    return Boolean(scan);
  }

  function scanHistoryRecord(scanId = '') {
    return (state.scanHistoryRecords || []).find((scan) => {
      const id = scan.scanId || scan.uniqueScanId || scan._id || '';
      return String(id) === String(scanId);
    }) || null;
  }

  function closeScanEditModal() {
    $('#scanEditModal')?.classList.add('hidden');
    $('#scanEditForm')?.reset();
    const message = $('#scanEditMessage');
    if (message) {
      message.className = 'form-message';
      message.textContent = '';
    }
  }

  function openScanEditModal(scanId = '', focusField = 'partNumber') {
    const scan = scanHistoryRecord(scanId);
    if (!scan) throw new Error('Scan record not found');
    const form = $('#scanEditForm');
    if (!form) throw new Error('Scan edit form is unavailable');
    const scanType = String(scan.scanType || scan.type || '').trim().toUpperCase();
    form.elements.scanId.value = scanId;
    form.elements.partNumber.value = scan.partNumber || scan.part || scan.normalizedPartNumber || '';
    form.elements.quantity.value = scanQuantity(scan, 1);
    form.elements.mrp.value = scan.displayMRP ?? scan.currentCatalogueMRP ?? scan.valuationMRP ?? 0;
    form.elements.dlc.value = scan.currentCatalogueDLC ?? 0;
    form.elements.binLocation.value = scan.binLocation || scan.bin || '';
    form.elements.scanType.value = scanType;
    form.elements.binLocation.disabled = scanType === 'FITTED';
    form.elements.binLocation.required = ['INWARD', 'OUTWARD', 'DAMAGE'].includes(scanType);
    const title = $('#scanEditTitle');
    if (title) title.textContent = focusField === 'quantity' ? 'Edit Part Quantity' : 'Edit Scanned Part';
    const message = $('#scanEditMessage');
    if (message) {
      message.className = 'form-message';
      message.textContent = scanType === 'FITTED' ? 'Fitted rows remain assigned to the vehicle.' : '';
    }
    $('#scanEditModal')?.classList.remove('hidden');
    setTimeout(() => form.elements[focusField]?.focus(), 0);
  }

  function scanHistoryRow(scan = {}) {
    const id = scan.scanId || scan.uniqueScanId || scan._id || '';
    const rowMrp = scan.displayMRP || scan.currentCatalogueMRP || 0;
    const totalQty = scan.totalQty ?? scan.totalQuantity ?? scanHistoryQuantity(scan, 1);
    const canEditDetails = canEditScanDetails(scan);
    const editOption = canEditDetails ? '<option value="edit-qty">Edit Quantity</option><option value="edit">Edit Part Details</option>' : '';
    const deleteOption = isAdminUser() ? '<option value="delete">Delete Row</option>' : '';
    const actionDropdown = editOption || deleteOption
      ? `<select class="app-action-dropdown scan-row-action" data-id="${escapeHtml(id)}" data-details-edit="${canEditDetails ? 'true' : 'false'}" aria-label="Scan row action"><option value="">Edit / Delete</option>${editOption}${deleteOption}</select>`
      : '<span class="muted">No action</span>';
    return `
      <tr>
        <td class="select-cell"><input class="scan-history-checkbox" type="checkbox" value="${escapeHtml(id)}"></td>
        <td>${escapeHtml(dateTime(scan.timestamp))}</td>
        <td>${partLink(scan.partNumber || scan.part)}</td>
        <td>${escapeHtml(scan.partDescription || scan.partName)}</td>
        <td>${escapeHtml(scan.productCategory || 'Uncategorized')}</td>
        <td>${escapeHtml(money(rowMrp))}</td>
        <td>${escapeHtml(money(scan.currentCatalogueDLC ?? 0))}</td>
        <td>${escapeHtml(scan.productGroup || '')}</td>
        <td>${escapeHtml(scan.model || '')}</td>
        <td>${escapeHtml(scan.manufacturingYear || scan.year || '')}</td>
        <td>${escapeHtml(scanQuantity(scan, 0))}</td>
        <td>${escapeHtml(totalQty)}</td>
        <td>${escapeHtml(scan.type)}</td>
        <td>${escapeHtml(scan.bin)}</td>
        <td>${escapeHtml(scan.dealerName || scan.dealerCode)}</td>
        <td>${deviceLink(scan.deviceId)}</td>
        <td>${statusCell(scan)}</td>
        <td>${actionDropdown}</td>
      </tr>
    `;
  }

  function bindScanHistoryActions() {
    $$('.scan-row-action').forEach((select) => {
      if (select.dataset.bound === 'true') return;
      select.dataset.bound = 'true';
      select.addEventListener('change', () => {
        const action = select.value;
        select.value = '';
        if (action === 'edit') {
          try {
            openScanEditModal(select.dataset.id);
          } catch (error) {
            toast(error.message, 'error');
          }
        }
        if (action === 'edit-qty') {
          try {
            openScanEditModal(select.dataset.id, 'quantity');
          } catch (error) {
            toast(error.message, 'error');
          }
        }
        if (action === 'delete') {
          deleteSingleScan(select.dataset.id).catch((error) => toast(error.message, 'error'));
        }
      });
    });
  }

  function prependScanHistory(scan = {}) {
    const body = $('#scanHistoryRows');
    if (!body || !activeAuditMatchesScan(scan)) return;
    if (!scanMatchesScanHistoryFilters(scan)) return;
    if (body.querySelector('.muted')) body.innerHTML = '';
    const recordKey = scanHistoryRecordKey(scan);
    const nextRecords = recordKey
      ? (state.scanHistoryRecords || []).map((item) => scanHistoryRecordKey(item) === recordKey ? scan : item)
      : [scan].concat(state.scanHistoryRecords || []);
    state.scanHistoryRecords = mergeScanHistoryRecords(nextRecords).slice(0, 500);
    body.innerHTML = state.scanHistoryRecords.length ? state.scanHistoryRecords.map(scanHistoryRow).join('') : '<tr><td colspan="18" class="muted">No scan history found</td></tr>';
    const summary = scanHistorySummary(state.scanHistoryRecords, {});
    state.scanHistorySummary = summary;
    updateScanHistorySummary(state.scanHistoryRecords, state.scanHistorySummary);
    bindScanHistoryActions();
    enhanceCoreTables();
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
    ['partName', 'bin', 'mrp', 'dlc', 'category'].forEach((key) => {
      const node = `[data-fill="${key}"]`;
      const input = $(node, form) || $(`[name="${key}"]`, form);
      if (input) {
        const value = key === 'bin' ? part.binLocation || part.bin || '' : part[key];
        input.value = ['mrp', 'dlc'].includes(key) && !(Number(value || 0) > 0)
          ? ''
          : value === undefined || value === null ? '' : value;
      }
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
      const jobs = [];
      if ($('#dashboard')?.classList.contains('active')) jobs.push(loadDashboard({ force: true }));
      if ($('#scan')?.classList.contains('active')) jobs.push(loadScanHistory());
      if ($('#syncCenter')?.classList.contains('active')) jobs.push(loadSyncStatus());
      return await Promise.all(jobs)
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
    ['part', 'partName', 'bin', 'mrp', 'dlc', 'category', 'rawScan'].forEach((name) => {
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
    if (normalized.scanType === 'VERIFICATION') {
      if (!validPartText(normalized.partNumber || normalized.part)) {
        playScanTone('error');
        toast('Invalid part number format', 'error');
        return;
      }
      try {
        const data = await api('/api/scans/verify', { method: 'POST', body: normalized });
        playScanTone(data.found ? 'success' : 'error');
        toast(data.message || (data.found ? 'Part Found' : 'Part Not Found'), data.found ? 'success' : 'error');
        if (isBarcodeForm) {
          resetBarcodeScanFields(form, normalized, options.expectedRaw);
          setStatusPill('barcodeReadyStatus', data.message || (data.found ? 'Part Found' : 'Part Not Found'), data.found ? 'yellow' : 'red');
          setTimeout(() => {
            setLivePill('barcodeReadyStatus', 'Ready for Scan', true);
            $('#barcodeRaw')?.focus();
          }, 1200);
        } else {
          resetManualScanFields(form);
        }
      } catch (error) {
        playScanTone('error');
        toast(error.message, 'error');
        if (isBarcodeForm) {
          setLivePill('barcodeReadyStatus', 'Verification failed', false);
          resetBarcodeScanFields(form, normalized, options.expectedRaw);
          setTimeout(() => $('#barcodeRaw')?.focus(), 900);
        }
      }
      return;
    }
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
    const rawBarcodeText = normalizePartText(normalized.rawScan || normalized.rawScanString || normalized.rawBarcode || normalized.rawScanValue || normalized.barcode || normalized.barcodeValue || normalized.scanValue || normalized.scanText || '');
    if ((!isBarcodeForm || !rawBarcodeText) && !validPartText(normalized.partNumber)) {
      playScanTone('error');
      toast('Invalid part number format', 'error');
      return;
    }

    if (!isBarcodeForm && options.confirmBeforeSave !== false) {
      const confirmMessage = [
        'Do you want to save this manual scan?',
        `Part: ${normalized.partNumber}`,
        `Quantity: ${normalized.qty}`,
        `Bin: ${normalized.binLocation || '-'}`
      ].join('\n');
      if (!window.confirm(confirmMessage)) return;
    }
    if (!isBarcodeForm) {
      const requestId = normalized.manualAddRequestId || normalized.uniqueScanId || `WEB-MANUAL-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      normalized.manualAddRequestId = requestId;
      normalized.uniqueScanId = normalized.uniqueScanId || requestId;
      normalized.scanId = normalized.scanId || requestId;
    }

    if (isBarcodeForm) {
      if (isBarcodeScanRecentlyLocked(normalized, 3000)) {
        setLivePill('barcodeReadyStatus', 'Duplicate blocked', false);
        resetBarcodeScanFields(form, normalized, options.expectedRaw);
        setTimeout(() => $('#barcodeRaw')?.focus(), 700);
        return;
      }
      normalized.synced = false;
      normalized.isSynced = false;
      normalized.syncStatus = 'pending';
      normalized.localStatus = 'pending';
      const queued = enqueueScan(normalized, 'Pending sync');
      if (!queued.queueAdded) {
        playScanTone('duplicate');
        const existing = queued.existingLocalScan || normalized;
        const message = String(existing.localStatus || existing.syncStatus || '').toLowerCase() === 'pending'
          ? `Part ${existing.partNumber || existing.part || normalized.partNumber} is already pending sync.`
          : barcodeDuplicateMessage(existing);
        setLivePill('barcodeReadyStatus', 'Duplicate blocked', false);
        toast(message, 'error');
        resetBarcodeScanFields(form, normalized, options.expectedRaw);
        setTimeout(() => $('#barcodeRaw')?.focus(), 500);
        return;
      }
      const pendingScan = normalizeQueuedHistoryScan(queued);
      replaceVisibleBarcodeScan(pendingScan, pendingScan);
      localStorage.setItem(BARCODE_LAST_BIN_KEY, normalized.binLocation);
      lockBarcodeScan(pendingScan, 900);
      state.barcodeLastRaw = rawBarcodeText || state.barcodeLastRaw;
      state.barcodeLastAt = Date.now();
      resetBarcodeScanFields(form, normalized, options.expectedRaw);
      playScanTone('success');
      setLivePill('barcodeReadyStatus', 'Pending - Syncing', true);
      toast(`Queued ${pendingScan.partNumber || pendingScan.part || 'scan'} for sync`);
      updateSyncBadges();
      schedulePendingSync(80);
      setTimeout(() => {
        setLivePill('barcodeReadyStatus', 'Ready for Scan', true);
        $('#barcodeRaw')?.focus();
      }, 450);
      return;
    }

    try {
      const data = await api('/api/scans/process', { method: 'POST', body: normalized });
      if (data && data.scan) {
        const savedScan = data.scan || {};
        addSyncLog({
          partNumber: savedScan.partNumber || savedScan.part || normalized.partNumber,
          upiId: savedScan.upiId || savedScan.upiNo || normalized.upiId,
          dealer: savedScan.dealerCode || normalized.dealerCode,
          status: data.duplicate ? 'duplicate' : 'synced',
          errorMessage: data.duplicate ? 'Duplicate scan skipped' : ''
        });
        rememberLastSyncTime(data.completedAt || data.lastSyncTime || data.lastSync || new Date().toISOString());
        handleNewScan(data.scan, { showSuccess: !data.duplicate }).catch((error) => console.warn('[SCAN] latest row update failed', error));
      }
      playScanTone(data.duplicate ? 'duplicate' : 'success');
      if (isBarcodeForm) {
        localStorage.setItem(BARCODE_LAST_BIN_KEY, normalized.binLocation);
        lockBarcodeScan(data.scan || normalized, 1800);
        state.barcodeLastRaw = rawBarcodeText || state.barcodeLastRaw;
        state.barcodeLastAt = Date.now();
        resetBarcodeScanFields(form, normalized, options.expectedRaw);
        setLivePill('barcodeReadyStatus', data.duplicate ? 'Duplicate skipped' : 'Saved - Ready Next', true);
        setTimeout(() => {
          setLivePill('barcodeReadyStatus', 'Ready for Scan', true);
          $('#barcodeRaw')?.focus();
        }, 900);
      } else {
        resetManualScanFields(form);
      }
      queueRealtimeReportRefresh(isBarcodeForm ? 'barcode scan' : 'manual scan');
    } catch (error) {
      if (
        error.status === 409
        && (isBarcodeForm || error.data?.duplicate || error.data?.upiDuplicate)
        && !error.data?.fittedDuplicate
        && !(!isBarcodeForm && error.data?.manualDuplicate)
      ) {
        playScanTone('duplicate');
        const duplicateScan = error.data?.scan || error.data?.existing || normalized;
        addSyncLog({
          partNumber: duplicateScan.partNumber || duplicateScan.part || normalized.partNumber,
          upiId: duplicateScan.upiId || duplicateScan.upiNo || normalized.upiId,
          dealer: duplicateScan.dealerCode || normalized.dealerCode,
          status: 'duplicate',
          errorMessage: error.message
        });
        toast(error.message, 'error');
        if (isBarcodeForm) {
          setLivePill('barcodeReadyStatus', 'Duplicate - Ready Next', false);
          resetBarcodeScanFields(form, normalized, options.expectedRaw);
          setTimeout(() => $('#barcodeRaw')?.focus(), 700);
        }
        return;
      }
      if (!isBarcodeForm && error.status === 409 && error.data?.manualDuplicate) {
        playScanTone('duplicate');
        const duplicate = error.data;
        const partNumber = duplicate.partNumber || normalized.partNumber;
        const binLocation = duplicate.binLocation || normalized.binLocation || '-';
        const existingQty = Number(duplicate.existingQty ?? duplicate.scan?.qty ?? duplicate.scan?.quantity ?? 0);
        const addQty = Number(duplicate.requestedQty ?? normalized.qty ?? normalized.quantity ?? 0);
        const message = `Part ${partNumber} is already available in bin ${binLocation}.\nCurrent quantity: ${existingQty}.\nDo you want to add ${addQty} more?`;
        if (window.confirm(message)) {
          normalized.addManualQuantity = true;
          normalized.confirmAddQuantity = true;
          const updateData = await api('/api/scans/process', { method: 'POST', body: normalized });
          playScanTone('success');
          toast(updateData.message || 'Manual quantity updated');
          resetManualScanFields(form);
          if (updateData.scan) handleNewScan(updateData.scan, { showSuccess: true }).catch(() => undefined);
          queueRealtimeReportRefresh('manual quantity update');
        }
        return;
      }
      if (error.status === 409 && error.data?.fittedDuplicate) {
        playScanTone('duplicate');
        if (window.confirm(error.data.message || 'This fitted part already exists for this vehicle/job card. Add quantity?')) {
          normalized.addFittedQuantity = true;
          const updateData = await api('/api/scans/process', { method: 'POST', body: normalized });
          playScanTone('success');
          toast(updateData.message || 'Fitted part quantity updated');
          if (isBarcodeForm) resetBarcodeScanFields(form, normalized, options.expectedRaw);
          else resetManualScanFields(form);
          if (updateData.scan) handleNewScan(updateData.scan, { showSuccess: true }).catch(() => undefined);
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
          if (overrideData.scan) handleNewScan(overrideData.scan, { showSuccess: true }).catch(() => undefined);
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
        await loadActiveAudit({ silent: true, allowMissing: true });
        setHeaderSyncStatus('Synced', true);
        setDashboardSyncStatus('Synced', true);
      }
    } catch (error) {
      error.healthFailed = true;
      setHeaderSyncStatus('Failed', false);
      setDashboardSyncStatus('Failed', false);
      updateSyncBadges({ serverStatus: 'offline', databaseStatus: 'offline', db: 'disconnected' });
      if (!options.silent) toast(error.message, 'error');
      if (!options.silent) addSyncLog({ status: 'failed', errorMessage: error.message });
      return { success: false, message: error.message, healthFailed: true };
    }

    const queue = getSyncQueue();
    const records = queue
      .filter((item) => String(item.scanType || item.type || '').toUpperCase() !== 'VERIFICATION')
      .filter((item) => options.includeFailed || item.localStatus !== 'failed');
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
      const duplicateLogs = [];
      (data.logs || []).forEach((log) => {
        addSyncLog(log);
        if (log.syncKey && ['inserted', 'synced', 'duplicate'].includes(log.status)) completedKeys.add(log.syncKey);
        if (log.syncKey && log.status === 'failed') failedByKey.set(log.syncKey, log.errorMessage || 'Sync failed');
        if (log.status === 'duplicate') duplicateLogs.push(log);
      });

      const nextQueue = getSyncQueue()
        .filter((item) => !completedKeys.has(item.syncKey) && !completedKeys.has(outboundKeyByLocalKey.get(item.syncKey)))
        .map((item) => failedByKey.has(item.syncKey)
          ? { ...item, localStatus: 'failed', retryCount: Number(item.retryCount || 0) + 1, syncError: failedByKey.get(item.syncKey) }
          : failedByKey.has(outboundKeyByLocalKey.get(item.syncKey))
            ? { ...item, localStatus: 'failed', retryCount: Number(item.retryCount || 0) + 1, syncError: failedByKey.get(outboundKeyByLocalKey.get(item.syncKey)) }
          : item);
      saveSyncQueue(nextQueue);
      if (duplicateLogs.length) {
        let handledDuplicateLog = false;
        duplicateLogs.forEach((log) => {
          const original = records.find((record) => (
            record.syncKey === log.syncKey
            || outboundKeyByLocalKey.get(record.syncKey) === log.syncKey
            || record.localId === log.localId
            || record.uniqueScanId === log.uniqueScanId
            || record.upiId === log.upiId
          ));
          if (original) {
            handledDuplicateLog = true;
            handleBarcodeDuplicate(original, {
              message: log.errorMessage || 'Duplicate UPI rejected by server',
              scan: {
                ...original,
                partNumber: log.partNumber || original.partNumber || original.part,
                upiId: log.upiId || original.upiId,
                dealerCode: log.dealer || original.dealerCode
              }
            });
          }
        });
        const message = duplicateLogs[0].errorMessage || 'Duplicate UPI rejected by server';
        if (!handledDuplicateLog && !lockBarcodeDuplicateNotice({ syncKey: duplicateLogs[0].syncKey, upiId: duplicateLogs[0].upiId, dealerCode: duplicateLogs[0].dealer }, 3000)) {
          playScanTone('duplicate');
          toast(message, 'error');
        }
        setLivePill('barcodeReadyStatus', 'Duplicate - Not Added', false);
      }

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
      const noActiveAudit = /no active audit/i.test(error.message || '');
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
      setHeaderSyncStatus(noActiveAudit ? 'Pending' : 'Failed', false);
      setDashboardSyncStatus(noActiveAudit ? 'Pending' : 'Failed', false);
      updateSyncBadges(noActiveAudit ? { serverStatus: 'online', databaseStatus: 'online', db: 'connected' } : { serverStatus: 'offline', databaseStatus: 'offline', db: 'disconnected' });
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
    const dealerSelect = $('[name="dealerCode"]', form);
    const selectedDealerCode = reportFilterValue(cleanDealerCode(dealerSelect?.value || ''))
      || reportFilterValue(cleanDealerCode(selectedOptionText(dealerSelect)));
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
      productCategory: ['category-wise-variance-summary', 'partwise-inventory-audit', 'stock-summary', 'movement_wise_stock_analysis'].includes(reportType) ? reportFilterValue(formData.category) : undefined,
      model: reportFilterValue(formData.model),
      year: reportFilterValue(formData.year),
      partNumber: reportFilterValue(formData.partNumber),
      productGroup: reportFilterValue(formData.productGroup),
      partSubGroup: reportFilterValue(formData.partSubGroup),
      binLocation: reportFilterValue(formData.binLocation || formData.bin),
      movementStatus: reportFilterValue(formData.movementStatus),
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
      const reportType = paramsObject.reportType || activeReportType();
      if (!['stock-summary', 'movement_wise_stock_analysis'].includes(reportType)) {
        const selectedColumns = currentReportColumnKeys(reportType);
        if (selectedColumns && selectedColumns.length) params.set('columns', selectedColumns.join(','));
      }
    }
    if (format) params.set('format', format);
    if (!format) {
      params.set('page', '1');
      params.set('limit', '100');
    }
    const query = params.toString();
    const url = `/api/reports/${paramsObject.reportType || activeReportType()}${query ? `?${query}` : ''}`;
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

  function movementWiseSummaryValue(summary = {}, keys = []) {
    const key = keys.find((item) => summary[item] !== undefined && summary[item] !== null && summary[item] !== '');
    return key ? summary[key] : 0;
  }

  function renderMovementWiseStockSummary(summary = {}, reportType = activeReportType()) {
    const panel = $('#movementWiseStockSummary');
    if (!panel) return;
    if (reportType !== 'movement_wise_stock_analysis') {
      panel.hidden = true;
      panel.innerHTML = '';
      return;
    }
    const cards = [
      ['Total Parts', wholeNumber(movementWiseSummaryValue(summary, ['totalParts', 'totalRows']))],
      ['Fast Moving Parts', wholeNumber(movementWiseSummaryValue(summary, ['fastMovingParts', 'fastMovingCount']))],
      ['Slow Moving Parts', wholeNumber(movementWiseSummaryValue(summary, ['slowMovingParts', 'slowMovingCount']))],
      ['Dead Stock Parts', wholeNumber(movementWiseSummaryValue(summary, ['deadStockParts', 'deadStockCount']))],
      ['Critical Shortage Parts', wholeNumber(movementWiseSummaryValue(summary, ['criticalShortageParts', 'criticalShortageCount']))],
      ['Excess Stock Parts', wholeNumber(movementWiseSummaryValue(summary, ['excessStockParts', 'excessStockCount']))],
      ['Total Stock Value', money2(movementWiseSummaryValue(summary, ['totalStockValue']))],
      ['Dead Stock Value', money2(movementWiseSummaryValue(summary, ['deadStockValue', 'totalDeadStockValue']))],
      ['Excess Stock Value', money2(movementWiseSummaryValue(summary, ['excessStockValue', 'totalExcessStockValue']))]
    ];
    panel.innerHTML = cards.map(([label, value]) => `
      <div class="metric mini">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
    `).join('');
    panel.hidden = false;
  }

  function applyReportData(data, reportType = activeReportType()) {
    $('#reportTitle').textContent = data.title || REPORT_TITLES[reportType];
    const rows = data.rows || [];
    const totalRows = Number(data.totalRows || rows.length || 0);
    state.reportTableSummary = data.summary || null;
    state.reportTableSections = data.sections || null;
    renderMovementWiseStockSummary(data.summary || {}, reportType);
    renderReportTable(data.columns || [], rows, data.totalRows, data.grandTotal, reportType);
    const message = $('#reportMessage');
    if (message) {
      message.className = rows.length ? 'form-message success' : 'form-message error';
      message.textContent = rows.length
        ? `Report loaded${totalRows > rows.length ? ` - showing ${wholeNumber(rows.length)} of ${wholeNumber(totalRows)} rows` : ` - ${wholeNumber(rows.length)} rows`}.`
        : (data.message || 'No report data found for selected filter');
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
    const missingDealerMessage = 'Select dealer code first to load report automatically.';
    if (params.reportType && !params.dealerCode) {
      const box = $('#reportMessage');
      if (box) {
        box.className = 'form-message error';
        box.textContent = missingDealerMessage;
      }
      if (showToast) toast(missingDealerMessage, 'error');
      return false;
    }
    const box = $('#reportMessage');
    if (box && box.textContent === missingDealerMessage) {
      box.className = 'form-message';
      box.textContent = 'Select filters to load report automatically.';
    }
    return true;
  }

  function cancelScheduledReportLoad() {
    clearTimeout(state.reportAutoLoadTimer);
    state.reportAutoLoadTimer = null;
  }

  function scheduleReportLoad(delay = 350, pendingMessage = 'Applying filters...') {
    cancelScheduledReportLoad();
    const params = reportParams();
    if (!params.reportType) return;
    if (!params.dealerCode) {
      resetReportPreview('Select dealer code first to load report automatically.');
      updateReportButtons();
      return;
    }
    if (state.reportAbortController) state.reportAbortController.abort();
    const message = $('#reportMessage');
    if (message) {
      message.className = 'form-message loading';
      message.textContent = pendingMessage;
    }
    updateReportButtons();
    state.reportAutoLoadTimer = setTimeout(() => {
      state.reportAutoLoadTimer = null;
      loadReport().catch((error) => toast(error.message, 'error'));
    }, delay);
  }

  function queueDashboardRefresh(delay = 1200) {
    clearTimeout(state.dashboardRefreshTimer);
    state.dashboardRefreshTimer = setTimeout(() => {
      if (document.hidden || !document.body.classList.contains('dashboard-view-active')) return;
      loadDashboard({ force: true }).catch((error) => console.warn('[DASHBOARD] queued refresh failed', error.message));
    }, delay);
  }

  function setScanFormSubmitting(form, submitting) {
    if (!form) return;
    form.dataset.submitting = submitting ? 'true' : 'false';
    const submitButton = $('button[type="submit"]', form);
    if (!submitButton) return;
    if (submitting) {
      submitButton.dataset.idleText = submitButton.textContent;
      submitButton.textContent = 'Saving...';
      submitButton.disabled = true;
    } else {
      submitButton.textContent = submitButton.dataset.idleText || 'Save Manual Scan';
      submitButton.disabled = false;
    }
  }

  function reportDownloadName(extension) {
    return `${(REPORT_TITLES[activeReportType()] || 'Report').replace(/\s+/g, '_')}.${extension}`;
  }

  function updateReportButtons() {
    const reportType = activeReportType();
    const canShow = Boolean(reportType) && validateReportSelection(false);
    const isCsvReport = CSV_REPORT_TYPES.has(reportType);
    const blocksPdfEmail = NO_PDF_EMAIL_REPORT_TYPES.has(reportType);
    $('#reportShow').disabled = !canShow || state.reportLoading;
    $('#reportRefresh').disabled = !canShow || state.reportLoading;
    $('#reportExcel').disabled = isCsvReport || !canShow || state.reportLoading;
    if ($('#reportPdf')) $('#reportPdf').disabled = isCsvReport || blocksPdfEmail || !state.reportLoaded || state.reportLoading;
    if ($('#reportEmail')) $('#reportEmail').disabled = isCsvReport || blocksPdfEmail || !state.reportLoaded || state.reportLoading;
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

  function resetReportPreview(message = 'Select filters to load report automatically.') {
    state.reportLoaded = false;
    state.reportHasRun = false;
    state.reportTableRows = [];
    state.reportTableColumns = [];
    state.reportTableTotalRows = 0;
    state.reportTableGrandTotal = null;
    state.reportTableSummary = null;
    state.reportTableSections = null;
    renderMovementWiseStockSummary({}, '');
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
      return `<th class="${reportColumnClass(column, index)} ${isSorted ? `sorted-${escapeHtml(sort.direction)}` : ''}" draggable="true" data-col-index="${index}" data-col-key="${escapeHtml(key)}" aria-sort="${escapeHtml(direction)}" style="width:${width}px;text-align:left"><button type="button" class="report-sort-button" title="Sort ${escapeHtml(column.header)}" aria-label="Sort ${escapeHtml(column.header)}" style="justify-content:flex-start;text-align:left"><span class="report-th-content" style="text-align:left">${escapeHtml(column.header)}</span><span class="sr-only">${escapeHtml(sortLabel)}</span></button><span class="report-col-resize" role="separator" aria-label="Resize column. Double click to auto fit."></span></th>`;
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

  function stockSummaryNumber(value) {
    if (value === undefined || value === null || value === '') return '';
    const num = Number(value);
    return Number.isFinite(num) ? String(Math.round(num)) : String(value);
  }

  function stockSummaryMoney(value, signed = false) {
    if (value === undefined || value === null || value === '') return '';
    const num = Number(value);
    if (!Number.isFinite(num)) return String(value);
    const amount = Math.round(Math.abs(num)).toLocaleString('en-IN');
    if (!signed) return `₹ ${amount}`;
    return num < 0 ? `₹ (${amount})` : `₹ ${amount}`;
  }

  function stockSummaryReconciliationRows(summary = {}, sections = {}) {
    const reconciliation = summary.reconciliationSummary || sections.reconciliationSummary || {};
    const rows = Array.isArray(reconciliation.rows) ? reconciliation.rows : [];
    if (rows.length) return rows;
    const dmsStockValue = Number(reconciliation.dmsStockValue ?? summary.dmsStockValueDLC ?? summary.dmsStockValue ?? 0);
    const actualPhysicalStockValue = Number(reconciliation.actualPhysicalStockValue ?? summary.actualStockValueDLC ?? summary.actualPhysicalStockValue ?? 0);
    const varianceValue = Number(reconciliation.varianceValue ?? actualPhysicalStockValue - dmsStockValue);
    const shortagesIdentified = Number(reconciliation.shortagesIdentified ?? summary.totalShortValue ?? 0);
    const excessStockIdentified = Number(reconciliation.excessStockIdentified ?? summary.totalExcessValue ?? 0);
    const damagedItemsConsidered = Number(reconciliation.damagedItemsConsidered ?? summary.damagedItemsValue ?? 0);
    const manualContributionAdjustment = Number(reconciliation.manualContributionAdjustment ?? summary.manualContribution ?? 0);
    const undefinedDeadLineItems = Number(reconciliation.undefinedDeadLineItems ?? summary.undefinedDeadLineItems ?? 0);
    const finalNetDifference = Number(reconciliation.finalNetDifference ?? summary.netDiff ?? varianceValue);
    const status = reconciliation.status || (finalNetDifference < 0 ? 'NET SHORTAGE' : finalNetDifference > 0 ? 'NET EXCESS' : 'BALANCED');
    const remarks = reconciliation.remarks || (finalNetDifference < 0
      ? `Physical inventory is lower than DMS inventory by ₹ ${Math.abs(Math.round(finalNetDifference)).toLocaleString('en-IN')} after adjusting excess stock.`
      : finalNetDifference > 0
        ? `Physical inventory is higher than DMS inventory by ₹ ${Math.abs(Math.round(finalNetDifference)).toLocaleString('en-IN')} after adjusting shortage stock.`
        : 'Physical inventory matches DMS inventory after adjustments.');
    return [
      { label: 'DMS Stock Value', value: dmsStockValue, displayValue: stockSummaryMoney(dmsStockValue), kind: 'currency' },
      { label: 'Actual Physical Stock Value', value: actualPhysicalStockValue, displayValue: stockSummaryMoney(actualPhysicalStockValue), kind: 'currency' },
      { label: 'Variance Value', value: varianceValue, displayValue: stockSummaryMoney(varianceValue, true), kind: 'variance' },
      { label: 'Shortages Identified', value: shortagesIdentified, displayValue: stockSummaryMoney(shortagesIdentified), kind: 'short' },
      { label: 'Excess Stock Identified', value: excessStockIdentified, displayValue: stockSummaryMoney(excessStockIdentified), kind: 'excess' },
      { label: 'Damaged Items Considered', value: damagedItemsConsidered, displayValue: stockSummaryMoney(damagedItemsConsidered), kind: 'damage' },
      { label: 'Manual Contribution / Adjustment', value: manualContributionAdjustment, displayValue: stockSummaryMoney(manualContributionAdjustment), kind: 'manual' },
      { label: 'Undefined / Dead Line Items', value: undefinedDeadLineItems, displayValue: stockSummaryMoney(undefinedDeadLineItems), kind: 'undefined' },
      { label: 'FINAL NET DIFFERENCE', value: finalNetDifference, displayValue: stockSummaryMoney(finalNetDifference, true), kind: 'net' },
      { label: 'Status', value: status, displayValue: status, kind: 'status' },
      { label: 'Remarks', value: remarks, displayValue: remarks, kind: 'remarks' }
    ];
  }

  function stockSummaryCellClass(key) {
    if (/^dms/i.test(key)) return 'stock-summary-dms-cell';
    if (/^physical/i.test(key)) return 'stock-summary-physical-cell';
    if (/^excess/i.test(key)) return 'stock-summary-excess-cell';
    if (/^short/i.test(key)) return 'stock-summary-short-cell';
    if (/^net/i.test(key)) return 'stock-summary-net-cell';
    return 'stock-summary-category-cell';
  }

  function renderStockSummaryTable(columns, rows, totalRows, reportType = activeReportType()) {
    const keys = columns && columns.length ? columns : [
      { header: 'Category', key: 'category' },
      { header: 'Value', key: 'dmsValue' },
      { header: 'Part Lines', key: 'dmsPartLines' },
      { header: 'Quantity', key: 'dmsQuantity' },
      { header: 'Value', key: 'physicalValue' },
      { header: 'Part Lines', key: 'physicalPartLines' },
      { header: 'Quantity', key: 'physicalQuantity' },
      { header: 'Value', key: 'excessValue' },
      { header: 'Part Lines', key: 'excessPartLines' },
      { header: 'Value', key: 'shortValue' },
      { header: 'Part Lines', key: 'shortPartLines' },
      { header: 'Value', key: 'netDifference' }
    ];
    const table = $('#reportTable');
    const wrap = $('#reportTableWrap');
    if (table) table.dataset.reportType = reportType || '';
    if (wrap) wrap.dataset.reportType = reportType || '';
    const widths = [150, 128, 82, 96, 128, 82, 96, 110, 82, 110, 82, 118];
    let colgroup = $('colgroup', table);
    if (!colgroup) {
      colgroup = document.createElement('colgroup');
      table.insertBefore(colgroup, table.firstChild);
    }
    colgroup.innerHTML = widths.map((width, index) => {
      const key = reportColumnKey(keys[index], index);
      return `<col data-col-index="${index}" data-col-key="${escapeHtml(key)}" style="width:${width}px;min-width:${Math.min(width, 82)}px">`;
    }).join('');
    applyReportTableWidth(table);

    const filteredRows = reportVisibleRows(rows || []);
    const pageRows = filteredRows.slice(0, 500);
    const summary = state.reportTableSummary || {};
    const sections = state.reportTableSections || {};
    const metaRows = Array.isArray(summary.metadata) && summary.metadata.length
      ? summary.metadata
      : Array.isArray(sections.metadata) ? sections.metadata : [];
    const title = summary.title || sections.title || 'Stock Summary Report';
    const reconciliationRows = stockSummaryReconciliationRows(summary, sections);
    const reconciliationTitle = reconciliationRows.length ? 'Inventory Reconciliation Summary' : title;
    const metaMarkup = metaRows.map((item) => `
      <tr class="stock-summary-meta-row">
        <th colspan="3" class="stock-summary-meta-label">${escapeHtml(item.label || '')} :</th>
        <td colspan="9" class="stock-summary-meta-value">${escapeHtml(item.value || '')}</td>
      </tr>
    `).join('');
    const reconciliationMarkup = reconciliationRows.map((item) => `
      <tr class="stock-summary-summary-row stock-summary-summary-${escapeHtml(item.kind || 'normal')}">
        <th colspan="4" class="stock-summary-summary-label">${escapeHtml(item.label || '')} :</th>
        <td colspan="8" class="stock-summary-summary-value">${escapeHtml(item.displayValue !== undefined && item.displayValue !== null ? item.displayValue : (item.value === undefined || item.value === null ? '' : item.value))}</td>
      </tr>
    `).join('');
    $('#reportHead').innerHTML = `
      <tr class="stock-summary-app-title-row">
        <th colspan="${keys.length}" class="stock-summary-app-title-cell">Daksh Inventory Solution V2</th>
      </tr>
      <tr class="stock-summary-title-row">
        <th colspan="${keys.length}" class="stock-summary-title-cell">${escapeHtml(title)}</th>
      </tr>
      ${metaMarkup}
      <tr class="stock-summary-service-row">
        <th colspan="${keys.length}" class="stock-summary-service-cell">${escapeHtml(reconciliationTitle)}</th>
      </tr>
      ${reconciliationMarkup}
      <tr class="stock-summary-group-row">
        <th rowspan="2" data-col-key="category" class="stock-summary-category-head">Category</th>
        <th colspan="3" class="stock-summary-dms-head">DMS Stock</th>
        <th colspan="3" class="stock-summary-physical-head">Physical Stock as Counted</th>
        <th colspan="2" class="stock-summary-excess-head">Excess Found</th>
        <th colspan="2" class="stock-summary-short-head">Short Found</th>
        <th class="stock-summary-net-head">Net Difference</th>
      </tr>
      <tr class="stock-summary-subhead-row">
        ${keys.slice(1).map((column, index) => {
          const key = reportColumnKey(column, index + 1);
          return `<th data-col-key="${escapeHtml(key)}" class="${stockSummaryCellClass(key).replace('-cell', '-head')}">${escapeHtml(column.header || '')}</th>`;
        }).join('')}
      </tr>
    `;
    $('#reportRows').innerHTML = pageRows.map((row) => {
      const isTotal = row.rowType === 'total';
      return `
        <tr class="${isTotal ? 'stock-summary-grand-total-row' : 'stock-summary-matrix-row'}">
          ${keys.map((column) => {
            const key = reportColumnKey(column);
            const value = key === 'category' ? row[key] : stockSummaryNumber(row[key]);
            return `<td class="${stockSummaryCellClass(key)}" data-type="${key === 'category' ? 'text' : 'number'}" title="${escapeHtml(value)}">${escapeHtml(value)}</td>`;
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
    cancelScheduledReportLoad();
    const reportType = activeReportType();
    if (!reportType) {
      resetReportPreview('Select report type to load report automatically.');
      return;
    }
    if (!validateReportSelection(true)) {
      state.reportHasRun = false;
      return;
    }
    if (!hasReportCriteria()) {
      resetReportPreview('Select filters to load report automatically.');
      state.reportHasRun = false;
      return;
    }
    let url = CSV_REPORT_TYPES.has(reportType) ? partsRefreshTemplatePreviewPath() : reportPath();
    if (forceRefresh) {
      const joiner = url.includes('?') ? '&' : '?';
      url = `${url}${joiner}refresh=true&_=${Date.now()}`;
    }
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
    resetReportPreview(CSV_REPORT_TYPES.has(type) ? 'Select filters to load report automatically.' : 'Select filters to load report automatically.');
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
    const dmsQty = summary.totalDmsStockQty ?? summary.dmsStock ?? 0;
    const actualQty = summary.totalActualScannedQty ?? summary.physicalStock ?? summary.actualStock ?? 0;
    setText('reconDms', dmsQty);
    setText('reconPhysical', actualQty);
    setText('reconMatched', summary.totalMatchedParts || 0);
    setText('reconShortageParts', summary.totalShortageParts || 0);
    setText('reconExcessParts', summary.totalExcessParts || 0);
    setText('reconNet', summary.netDifference || 0);
    setText('reconExcess', summary.excess || 0);
    setText('reconShort', summary.short || 0);
    setText('reconSummaryPartsUploaded', summary.totalPartsUploaded || 0);
    setText('reconSummaryDms', dmsQty);
    setText('reconSummaryPhysical', actualQty);
    setText('reconSummaryMatched', summary.totalMatchedParts || 0);
    setText('reconSummaryShortageParts', summary.totalShortageParts || 0);
    setText('reconSummaryExcessParts', summary.totalExcessParts || 0);
    setText('reconSummaryFast', summary.totalFastMovingParts || 0);
    setText('reconSummarySlow', summary.totalSlowMovingParts || 0);
    setText('reconSummaryDead', summary.totalDeadStockParts || 0);
    setText('reconSummaryInventoryValue', money2(summary.totalInventoryValue || 0));
    setText('reconSummaryShortageValue', money2(summary.totalShortageValue || 0));
    setText('reconSummaryExcessValue', money2(summary.totalExcessValue || 0));
    setText('reconSummaryNotInDms', summary.totalScannedButNotInDms || 0);
    setText('reconSummaryExcess', summary.excess || 0);
    setText('reconSummaryShort', summary.short || 0);
    setText('reconSummaryNet', summary.netDifference || 0);
    setText('reconSummaryMrp', money2(summary.varianceMrp || 0));
    setText('reconSummaryDlc', money2(summary.varianceDlc || 0));
  }

  function activeReconDealer() {
    return cleanDealerCode($('#reconDealer')?.value || $('#dealerStockDealer')?.value || '');
  }

  function renderDealerStockErrors(errorRows = [], skippedCount = errorRows.length, truncated = false) {
    const box = $('#dealerStockErrorReport');
    if (!box) return;
    const rows = Array.isArray(errorRows) ? errorRows : [];
    if (!rows.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML = `
      <div class="stock-error-title">Skipped rows: ${escapeHtml(skippedCount || rows.length)}${truncated ? `, showing first ${rows.length}` : ''}</div>
      <div class="table-wrap compact-error-table">
        <table>
          <thead><tr><th>Row</th><th>Part Number</th><th>Dealer Code</th><th>Error</th></tr></thead>
          <tbody>${rows.map((row) => `
            <tr>
              <td>${escapeHtml(row.rowNumber || '')}</td>
              <td>${escapeHtml(row.partNumber || '')}</td>
              <td>${escapeHtml(row.dealerCode || '')}</td>
              <td>${escapeHtml(row.message || '')}</td>
            </tr>
          `).join('')}</tbody>
        </table>
      </div>
    `;
  }

  function renderDealerStockPreview(rows = [], total = rows.length) {
    $('#dealerStockPreviewRows').innerHTML = rows.map((row) => `
      <tr>
        <td>${partLink(row.partNumber)}</td>
        <td>${escapeHtml(row.partDescription)}</td>
        <td>${escapeHtml(row.productCategory)}</td>
        <td>${escapeHtml(money(row.mrp))}</td>
        <td>${escapeHtml(money(row.dlp || row.dlc))}</td>
        <td>${escapeHtml(row.dmsStock || row.systemQty || 0)}</td>
        <td>${escapeHtml(row.binLoc1 || row.systemBinLoc1 || '')}</td>
        <td>${escapeHtml(row.binLoc2 || row.systemBinLoc2 || '')}</td>
        <td>${escapeHtml(row.binLoc3 || row.systemBinLoc3 || '')}</td>
        <td>${escapeHtml(row.reservedQty || 0)}</td>
        <td>${escapeHtml(row.dealerCode)}</td>
        <td>${escapeHtml([row.movementCodeA, row.movementCodeB].filter(Boolean).join(' / '))}</td>
        <td>${escapeHtml(row.averageDemand || 0)}</td>
        <td>${escapeHtml(row.forecast || 0)}</td>
        <td>${escapeHtml(row.safetyStock || 0)}</td>
        <td>${escapeHtml(row.rop || 0)}</td>
        <td>${escapeHtml(row.pendingOrder || 0)}</td>
        <td>${escapeHtml(money2(row.dmsStockValue ?? row.stockValue ?? 0))}</td>
        <td>${escapeHtml(money2(row.actualStockValue || 0))}</td>
      </tr>
    `).join('') || '<tr><td colspan="18" class="muted">No dealer stock uploaded yet</td></tr>';
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
    renderDealerStockErrors([]);
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
    renderDealerStockErrors(data.errorRows || [], data.skippedCount || 0, data.errorRowsTruncated);
    if (message) {
      message.className = 'form-message success';
      message.textContent = data.message || `Saved ${data.savedCount || 0} DMS stock row(s).`;
    }
    loadReconciliation({ silent: true }).catch(() => undefined);
    toast('Dealer DMS stock saved');
    return data;
  }

  async function deleteDealerStock() {
    const dealerCode = activeReconDealer();
    if (!dealerCode || dealerCode === 'ALL') throw new Error('Select Dealer Code first');
    if (!window.confirm(`Delete old DMS stock for dealer ${dealerCode}?`)) return;
    const data = await api(`/api/reconciliation/stock?dealerCode=${encodeURIComponent(dealerCode)}`, { method: 'DELETE' });
    renderDealerStockPreview([]);
    renderDealerStockErrors([]);
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

  async function loadReconciliation(options = {}) {
    const silent = Boolean(options.silent);
    const dealerCode = cleanDealerCode($('#reconDealer')?.value || '');
    const message = $('#reconMessage');
    if (!dealerCode || dealerCode === 'ALL') {
      $('#reconRows').innerHTML = '';
      setReconciliationSummary({});
      if (message && !silent) {
        message.className = 'form-message';
        message.textContent = 'Select Dealer Code to load the reconciliation report.';
      }
      state.reconLoaded = false;
      return;
    }
    if (message && !silent) {
      message.className = 'form-message loading';
      message.textContent = 'Loading reconciliation report...';
    }
    const query = queryFromForm($('#reconFilters'));
    const data = await api(`/api/reconciliation/report?${query}`);
    const summary = data.summary || {};
    setReconciliationSummary(summary);
    $('#reconRows').innerHTML = (data.rows || []).slice(0, 500).map((row) => `
      <tr>
        <td>${partLink(row.partNumber || row.partNo)}</td>
        <td>${escapeHtml(row.partDescription || row.partName || '')}</td>
        <td>${escapeHtml(row.productCategory || 'Uncategorized')}</td>
        <td>${escapeHtml(row.dmsStock || 0)}</td>
        <td>${escapeHtml(row.actualStock ?? row.physicalStock ?? 0)}</td>
        <td>${escapeHtml(row.variance ?? row.netDifference ?? 0)}</td>
        <td>${escapeHtml(row.status || '')}</td>
        <td>${escapeHtml(money(row.mrp || 0))}</td>
        <td>${escapeHtml(money(row.dlp || row.dlc || 0))}</td>
        <td>${escapeHtml(money2(row.stockValue || 0))}</td>
        <td>${escapeHtml(row.binLocation || row.bin || '')}</td>
        <td>${escapeHtml(row.movementType || '')}</td>
        <td>${escapeHtml(row.movementStatus || row.fastSlowDeadStatus || '')}</td>
      </tr>
    `).join('') || '<tr><td colspan="14" class="muted">No reconciliation data found for selected dealer/filter</td></tr>';
    if (message && !silent) {
      message.className = (data.rows || []).length ? 'form-message success' : 'form-message error';
      message.textContent = (data.rows || []).length ? `${data.rows.length} reconciliation row(s) loaded.` : (data.message || 'No reconciliation data found for selected filter');
    }
    state.reconLoaded = true;
  }

  function reconciliationExportQuery(format, full = false) {
    const params = new URLSearchParams(queryFromForm($('#reconFilters')));
    params.set('format', format);
    if (full) params.set('full', '1');
    else params.set('report', $('#reconExportType')?.value || 'dealer');
    return params.toString();
  }

  function clearPartSearch(message = 'Click Show to view all parts, or use filters to narrow master details.') {
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
    const params = partSearchParams(page);
    state.masterSearch = { ...state.masterSearch, q: params.get('partNumber') || '', page, limit: state.masterSearch.limit || 25 };
    const box = $('#partSearchMessage');
    if (box) {
      box.className = 'form-message loading';
      box.textContent = hasPartSearchFilter() ? 'Searching master data...' : 'Loading all master parts...';
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
      box.textContent = state.masterSearchRows.length ? `${wholeNumber(data.total || 0)} master part(s) found.` : 'No master parts found';
    }
  }

  function setPartMasterRecordCount(count) {
    const numeric = Math.max(Number(count || 0), 0);
    state.masterCatalogueCount = numeric;
    const node = $('#partMasterRecordCount');
    if (node) node.textContent = `Part master records: ${wholeNumber(numeric)}`;
  }

  async function loadPartSearchFilters() {
    const data = await api('/api/master/filters');
    setPartMasterRecordCount(data.totalParts || data.masterCatalogueCount || 0);
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

  function createCatalogueUploadSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return `catalogue-upload-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function catalogueUploadProgressPercent(progress = {}) {
    const explicit = Number(progress.percent);
    if (Number.isFinite(explicit)) return Math.max(0, Math.min(100, explicit));
    const stage = String(progress.stage || '').toLowerCase();
    if (stage.includes('complete') || stage.includes('error') || stage.includes('blocked')) return 100;
    const processed = Number(progress.processedRows ?? 0);
    const total = Number(progress.totalRows ?? progress.fileRowsCount ?? 0);
    if (total > 0) return Math.max(0, Math.min(100, (processed / total) * 100));
    return 0;
  }

  function catalogueUploadProgressVariant(progress = {}, fallback = 'loading') {
    const stage = String(progress.stage || '').toLowerCase();
    if (stage.includes('error')) return 'error';
    if (stage.includes('complete') || stage === 'completed') return 'success';
    if (stage.includes('blocked') || stage.includes('warning')) return 'warning';
    return fallback;
  }

  function catalogueUploadProgressLabel(progress = {}) {
    if (String(progress.message || '').trim()) return String(progress.message).trim();
    const stage = String(progress.stage || '').toLowerCase();
    if (stage.includes('received')) return 'File received. Preparing upload...';
    if (stage.includes('parsed')) return 'Parsing catalogue file...';
    if (stage.includes('validat')) return 'Validating rows...';
    if (stage.includes('deleting')) return 'Deleting old catalogue...';
    if (stage.includes('writing-master')) return 'Saving master rows...';
    if (stage.includes('writing-price-history')) return 'Saving price history rows...';
    if (stage.includes('finalizing')) return 'Finalizing upload...';
    if (stage.includes('complete')) return 'Upload completed';
    if (stage.includes('error')) return 'Upload failed';
    return 'Uploading...';
  }

  function catalogueUploadProgressText(progress = {}) {
    const stage = String(progress.stage || '').toLowerCase();
    const parts = [];
    const fileRows = Number(progress.fileRowsCount ?? progress.totalRows ?? 0);
    const processedRows = Number(progress.processedRows ?? 0);
    const acceptedRowsCount = Number(progress.acceptedRowsCount ?? 0);
    const savedRowsCount = Number(progress.savedRowsCount ?? 0);
    const insertedRowsCount = Number(progress.insertedRowsCount ?? 0);
    const updatedRowsCount = Number(progress.updatedRowsCount ?? 0);
    const failedRowsCount = Number(progress.failedRowsCount ?? 0);
    const duplicateRowsCount = Number(progress.duplicateRowsCount ?? 0);
    const deletedOldRowsCount = Number(progress.deletedOldRowsCount ?? 0);
    const deletedPriceHistoryRowsCount = Number(progress.deletedPriceHistoryRowsCount ?? 0);
    const currentCount = Number(progress.currentMasterRecordCount ?? progress.finalMasterRecordCount ?? progress.masterCatalogueCount ?? 0);

    if (deletedOldRowsCount) parts.push(`Old catalogue deleted: ${wholeNumber(deletedOldRowsCount)} rows`);
    if (deletedPriceHistoryRowsCount) parts.push(`Price history deleted: ${wholeNumber(deletedPriceHistoryRowsCount)} rows`);
    if (fileRows) parts.push(`File rows: ${wholeNumber(fileRows)}`);
    if (processedRows && !stage.includes('complete') && !stage.includes('error')) parts.push(`Processed: ${wholeNumber(processedRows)}`);
    if (acceptedRowsCount && !stage.includes('complete') && !stage.includes('error')) parts.push(`Valid rows: ${wholeNumber(acceptedRowsCount)}`);
    if (insertedRowsCount || updatedRowsCount) {
      parts.push(`Inserted: ${wholeNumber(insertedRowsCount)}`);
      parts.push(`Updated existing: ${wholeNumber(updatedRowsCount)}`);
    } else if (savedRowsCount || stage.includes('complete')) {
      parts.push(`Saved: ${wholeNumber(savedRowsCount)}`);
    }
    if (duplicateRowsCount) parts.push(`Duplicates merged: ${wholeNumber(duplicateRowsCount)}`);
    if (failedRowsCount || stage.includes('complete') || stage.includes('error')) parts.push(`Failed rows: ${wholeNumber(failedRowsCount)}`);
    if (currentCount) parts.push(`Final Part Master Records: ${wholeNumber(currentCount)}`);
    return parts.join(' | ');
  }

  function setCatalogueUploadProgress(progress = {}, options = {}) {
    const node = $('#catalogueUploadProgress');
    if (!node) return;
    const stage = String(progress.stage || options.stage || '').trim();
    const variant = catalogueUploadProgressVariant(progress, options.variant || 'loading');
    const percent = catalogueUploadProgressPercent(progress);
    const label = catalogueUploadProgressLabel(progress);
    const text = String(options.text || catalogueUploadProgressText(progress) || '').trim();
    const visible = options.visible !== false && Boolean(stage || label || text || progress.uploadId || state.catalogueUploadInFlight);

    if (progress.uploadId) state.catalogueUploadSessionId = String(progress.uploadId);
    state.catalogueUploadProgress = { ...state.catalogueUploadProgress, ...progress, stage, percent, message: label };
    state.catalogueUploadInFlight = variant === 'loading';

    node.hidden = !visible;
    node.className = `catalogue-upload-progress ${variant}`.trim();
    node.setAttribute('aria-busy', variant === 'loading' ? 'true' : 'false');

    const labelNode = $('#catalogueUploadProgressLabel');
    const percentNode = $('#catalogueUploadProgressPercent');
    const textNode = $('#catalogueUploadProgressText');
    const barNode = $('#catalogueUploadProgressBarFill');
    const progressBarNode = $('#catalogueUploadProgress .catalogue-upload-progress-bar');
    if (labelNode) labelNode.textContent = label;
    if (percentNode) percentNode.textContent = `${Math.round(percent)}%`;
    if (textNode) textNode.textContent = text;
    if (barNode) barNode.style.width = `${Math.round(percent)}%`;
    if (progressBarNode) progressBarNode.setAttribute('aria-valuenow', String(Math.round(percent)));
  }

  function setCatalogueUploadBusy(busy, progress = {}) {
    const form = $('#partUploadForm');
    const submitButton = $('#partUploadForm button[type="submit"]');
    const deleteReuploadButton = $('#deleteReuploadCatalogueBtn');
    const deleteButton = $('#deleteCatalogueBtn');
    const fileInput = $('[name="file"]', form);
    const failedRowsButton = $('#downloadCatalogueFailedRowsBtn');
    if (form) {
      form.classList.toggle('is-uploading', Boolean(busy));
      form.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
    if (fileInput) fileInput.disabled = Boolean(busy);
    if (submitButton) submitButton.disabled = Boolean(busy);
    if (deleteReuploadButton) deleteReuploadButton.disabled = Boolean(busy);
    if (deleteButton) deleteButton.disabled = Boolean(busy);
    if (failedRowsButton) failedRowsButton.disabled = Boolean(busy);
    state.catalogueUploadInFlight = Boolean(busy);
    if (busy) {
      const uploadStats = $('#uploadStats');
      if (uploadStats) uploadStats.textContent = 'Upload in progress...';
      setCatalogueUploadProgress(progress, { visible: true, variant: 'loading' });
    }
  }

  function setCatalogueUploadMessage(message = '', variant = 'success') {
    const node = $('#catalogueUploadMessage');
    if (!node) return;
    if (!message) {
      node.hidden = true;
      node.className = 'form-message';
      node.textContent = '';
      return;
    }
    node.hidden = false;
    node.className = `form-message ${variant || 'success'}`;
    node.textContent = message;
  }

  function catalogueUploadFailureBreakdown(data = {}) {
    const reasons = data.failureReasons || data.failureReasonCounts || {};
    const entries = [
      ['Missing Part Number', Number(reasons['Missing Part Number'] || data.missingPartNumberCount || 0)],
      ['Blank mandatory fields', Number(reasons['Blank mandatory fields'] || data.blankMandatoryFieldsCount || data.blankRowsCount || 0)],
      ['Invalid MRP/DLC', Number(reasons['Invalid MRP/DLC'] || data.invalidMrpDlcCount || 0)],
      ['Duplicate conflict', Number(reasons['Duplicate conflict'] || data.duplicateConflictCount || data.duplicateRowsCount || 0)],
      ['Database insert error', Number(reasons['Database insert error'] || data.databaseInsertErrorCount || 0)]
    ].filter(([, count]) => count > 0);
    return entries.length ? `Failure reasons: ${entries.map(([label, count]) => `${label}: ${wholeNumber(count)}`).join(' | ')}` : '';
  }

  function updateCatalogueUploadStats(data = {}, options = {}) {
    const action = String(options.action || 'upload');
    state.catalogueFailureDownloadId = String(data.failureDownloadId || '');
    const failedRowsButton = $('#downloadCatalogueFailedRowsBtn');
    if (failedRowsButton) failedRowsButton.hidden = !state.catalogueFailureDownloadId;
    const fileRowsCount = Number(data.fileRowsCount ?? data.totalRowsCount ?? data.totalRowsUploaded ?? data.uploadedRowsCount ?? 0);
    const insertedRowsCount = Number(data.insertedRowsCount ?? 0);
    const updatedRowsCount = Number(data.updatedRowsCount ?? data.updatedDuplicateCount ?? 0);
    const duplicateRowsCount = Number(data.duplicateRowsCount ?? data.duplicateMergedRowsCount ?? data.duplicateSkippedRows ?? 0);
    const failedRowsCount = Number(data.failedRowsCount ?? 0);
    const savedRowsCount = Number(data.savedRowsCount ?? data.importedRowsCount ?? data.importedCount ?? (insertedRowsCount + updatedRowsCount));
    const currentCount = Number(data.currentMasterRecordCount ?? data.finalMasterRecordCount ?? data.masterCatalogueCount ?? savedRowsCount ?? 0);
    const deletedOldRowsCount = Number(data.deletedOldRowsCount ?? 0);
    const deletedPriceHistoryRowsCount = Number(data.deletedPriceHistoryRowsCount ?? 0);
    const accountingGapCount = Number(data.accountingGapCount ?? 0);
    const mismatch = Boolean(data.rowCountMismatch) || (action !== 'delete' && fileRowsCount > 0 && savedRowsCount !== fileRowsCount);
    const failureBreakdown = catalogueUploadFailureBreakdown(data);
    setPartMasterRecordCount(currentCount);

    const summarySegments = [];
    if (action === 'delete' || action === 'delete-reupload') {
      summarySegments.push(`Old catalogue deleted: ${wholeNumber(deletedOldRowsCount)} rows`);
      if (deletedPriceHistoryRowsCount) summarySegments.push(`Price history deleted: ${wholeNumber(deletedPriceHistoryRowsCount)} rows`);
    }
    if (action === 'delete-reupload') summarySegments.push(`New catalogue uploaded: ${wholeNumber(savedRowsCount)} rows`);
    if (action !== 'delete') {
      summarySegments.push(`File rows: ${wholeNumber(fileRowsCount)}`);
      summarySegments.push(`Inserted: ${wholeNumber(insertedRowsCount)}`);
      summarySegments.push(`Updated existing: ${wholeNumber(updatedRowsCount)}`);
      summarySegments.push(`Duplicates merged: ${wholeNumber(duplicateRowsCount)}`);
      summarySegments.push(`Failed rows: ${wholeNumber(failedRowsCount)}`);
      summarySegments.push(`Final Part Master Records: ${wholeNumber(currentCount)}`);
    } else {
      summarySegments.push(`Final Part Master Records: ${wholeNumber(currentCount)}`);
    }
    const summary = summarySegments.filter(Boolean).join(' | ');
    $('#uploadStats').textContent = summary;

    if (action === 'delete' || action === 'delete-reupload' || fileRowsCount || savedRowsCount || failedRowsCount || duplicateRowsCount || currentCount || deletedOldRowsCount) {
      const variant = action === 'delete' ? 'warning' : (mismatch || accountingGapCount ? 'warning' : 'success');
      const lines = [];
      if (action === 'delete') {
        lines.push(`Old catalogue deleted: ${wholeNumber(deletedOldRowsCount)} rows`);
        lines.push(`Price history deleted: ${wholeNumber(deletedPriceHistoryRowsCount)} rows`);
        lines.push(`Final Part Master Records: ${wholeNumber(currentCount)}`);
      } else {
        lines.push('Upload Completed');
        if (action === 'delete-reupload') {
          lines.push(`Old catalogue deleted: ${wholeNumber(deletedOldRowsCount)} rows`);
          lines.push(`New catalogue uploaded: ${wholeNumber(savedRowsCount)} rows`);
        }
        lines.push(`File rows: ${wholeNumber(fileRowsCount)}`);
        lines.push(`Successfully inserted: ${wholeNumber(insertedRowsCount)}`);
        lines.push(`Updated existing: ${wholeNumber(updatedRowsCount)}`);
        lines.push(`Duplicates merged: ${wholeNumber(duplicateRowsCount)}`);
        lines.push(`Failed rows: ${wholeNumber(failedRowsCount)}`);
        lines.push(`Final Part Master Records: ${wholeNumber(currentCount)}`);
        if (failureBreakdown) lines.push(failureBreakdown);
        if (accountingGapCount) lines.push(`Warning: ${wholeNumber(Math.abs(accountingGapCount))} rows were not accounted for.`);
        if (mismatch) lines.push('Upload completed with mismatch. Download failed rows to check missing parts.');
      }
      setCatalogueUploadMessage(lines.join('\n'), variant);
    } else if (data.message) {
      setCatalogueUploadMessage(data.message, data.success === false ? 'error' : 'warning');
    } else {
      setCatalogueUploadMessage('', 'success');
    }
  }

  function downloadCatalogueFailedRows() {
    if (!state.catalogueFailureDownloadId) return toast('No failed rows are available for download', 'error');
    return downloadGet(
      `/api/master-catalogue/upload-failures/${encodeURIComponent(state.catalogueFailureDownloadId)}`,
      'Master_Catalogue_Failed_Rows.xlsx'
    );
  }

  function normalizeAuditWorkflowStatus(value) {
    const status = String(value || '').trim().toUpperCase();
    return status === 'COMPLETED' || status === 'CLOSED' ? 'COMPLETED' : 'IN_PROGRESS';
  }

  function renderDealerMaster() {
    $('#dealerMasterRows').innerHTML = state.dealers.length ? state.dealers.map((dealer) => {
      const auditStatus = normalizeAuditWorkflowStatus(dealer.auditStatus || dealer.status || (dealer.active === false ? 'COMPLETED' : 'IN_PROGRESS'));
      const auditStatusDisplay = auditStatus === 'COMPLETED' ? 'Completed' : 'In Progress';
      const auditStatusClass = auditStatus === 'COMPLETED' ? 'status-completed' : 'status-in-progress';
      return `
      <tr>
        <td>${escapeHtml(dealer.dealerName)}</td>
        <td>${escapeHtml(dealer.dealerCode)}</td>
        <td>${escapeHtml(dealer.location)}</td>
        <td>${escapeHtml(auditUserDisplay(dealer) || '-')}</td>
        <td><span class="audit-status-badge ${auditStatusClass}">${auditStatusDisplay}</span></td>
        <td>
          <select class="btn light small dealer-action-select" data-code="${escapeHtml(dealer.dealerCode)}" data-audit-id="${escapeHtml(dealer.currentAuditId || '')}">
            <option value="">Select Action</option>
            <option value="delete">Delete</option>
            ${auditStatus === 'IN_PROGRESS' ? `<option value="complete">Mark Complete</option>` : `<option value="reopen">Reopen</option>`}
          </select>
        </td>
      </tr>
    `;
    }).join('') : '<tr><td colspan="6" class="muted">No dealers yet</td></tr>';
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

  async function handleAuditComplete(auditId, dealerCode) {
    if (!auditId || !dealerCode) {
      toast('Audit ID and Dealer Code are required', 'error');
      return;
    }

    // Show remark dialog
    const remark = window.prompt('Please enter the reason for marking this audit as complete:', '');
    if (remark === null) return; // User cancelled

    if (!window.confirm('Once you mark this audit as COMPLETED, no scanning will be allowed. You sure?')) return;

    try {
      const data = await api(`/api/audit/${encodeURIComponent(auditId)}/status/complete`, {
        method: 'POST',
        body: { remark: remark || '' }
      });

      // Show completion popup
      alert('✓ Audit marked as COMPLETED successfully.\n\nNo further changes can be made to this audit unless it is reopened by an admin.');

      toast('Audit marked as completed', 'success');
      await loadActiveAudit({ silent: true, allowMissing: true });
      await loadDealers();
    } catch (error) {
      toast(`Failed to complete audit: ${error.message}`, 'error');
    }
  }

  async function handleAuditReopen(auditId, dealerCode) {
    if (!auditId || !dealerCode) {
      toast('Audit ID and Dealer Code are required', 'error');
      return;
    }

    // Show remark dialog
    const remark = window.prompt('Please enter the reason for reopening this audit:', '');
    if (remark === null) return; // User cancelled

    if (!window.confirm('Reopen this completed audit? Only admins can do this.')) return;

    try {
      const data = await api(`/api/audit/${encodeURIComponent(auditId)}/status/reopen`, {
        method: 'POST',
        body: { remark: remark || '' }
      });

      alert('✓ Audit reopened successfully.\n\nScanning is now allowed for this audit.');

      toast('Audit reopened', 'success');
      if (data.activeAudit) {
        state.activeAudit = data.activeAudit;
        updateActiveAuditUi();
      } else {
        await loadActiveAudit({ silent: true, allowMissing: true });
      }
      await loadDealers();
    } catch (error) {
      toast(`Failed to reopen audit: ${error.message}`, 'error');
    }
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
    const existingSheet = $('#binLabelPrintSheet');
    if (existingSheet) existingSheet.remove();
    const existingStyle = $('#binLabelPrintStyle');
    if (existingStyle) existingStyle.remove();
    const printStyle = document.createElement('style');
    printStyle.id = 'binLabelPrintStyle';
    printStyle.textContent = `
      @media print {
        @page { size: A4 portrait; margin: 8mm; }
        body.print-bin-labels { margin: 0 !important; background: #fff !important; }
        body.print-bin-labels > *:not(#binLabelPrintSheet) { display: none !important; }
        body.print-bin-labels #binLabelPrintSheet {
          display: grid !important;
          grid-template-columns: repeat(auto-fill, var(--bin-label-width));
          gap: 3mm;
          align-items: start;
          justify-content: start;
          width: 100%;
          padding: 0;
          background: #fff !important;
        }
        body.print-bin-labels #binLabelPrintSheet .bin-label-card {
          border: 1px solid #111827 !important;
          border-radius: 1.5mm !important;
          box-shadow: none !important;
        }
        body.print-bin-labels #binLabelPrintSheet .bin-label-left strong,
        body.print-bin-labels #binLabelPrintSheet .bin-label-continuation {
          display: none !important;
        }
        body.print-bin-labels #binLabelPrintSheet a,
        body.print-bin-labels #binLabelPrintSheet .enterprise-link,
        body.print-bin-labels #binLabelPrintSheet .table-link {
          color: #020617 !important;
          text-decoration: none !important;
        }
      }
    `;
    const printSheet = document.createElement('div');
    printSheet.id = 'binLabelPrintSheet';
    printSheet.className = 'bin-label-print-area';
    printSheet.innerHTML = items.map(binLabelCard).join('');
    applyBinLabelVariables(printSheet, settings);
    document.head.appendChild(printStyle);
    document.body.appendChild(printSheet);
    const cleanupPrintSheet = () => {
      document.body.classList.remove('print-bin-labels');
      printSheet.remove();
      printStyle.remove();
      window.removeEventListener('afterprint', cleanupPrintSheet);
    };
    window.addEventListener('afterprint', cleanupPrintSheet);
    document.body.classList.add('print-bin-labels');
    void printSheet.offsetHeight;
    window.print();
    setTimeout(() => {
      cleanupPrintSheet();
    }, 400);
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
    localStorage.removeItem(scopedStorageKey(SYNC_QUEUE_KEY));
    localStorage.removeItem(scopedStorageKey(SYNC_LOG_KEY));
    localStorage.removeItem(scopedStorageKey(LAST_SYNC_KEY));
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
      queueRealtimeReportRefresh('audit restore');
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
    writeJsonStorage(scopedStorageKey(SYNC_LOG_KEY), log);
    renderSyncLog();
    return { localQueueDeleted: beforeQueue.length - queue.length, localLogDeleted: beforeLog.length - log.length };
  }

  async function refreshAfterDelete() {
    await Promise.all([loadDashboard(), loadScanHistory(), loadDealers(), loadCategories(), loadSyncStatus()].map((job) => job.catch ? job : Promise.resolve(job)));
  }

  async function saveEditedScan(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const message = $('#scanEditMessage');
    const scanId = String(form.elements.scanId.value || '').trim();
    const quantity = Number(form.elements.quantity.value);
    const scanType = String(form.elements.scanType.value || '').trim().toUpperCase();
    const binLocation = scanType === 'FITTED' ? '' : cleanDealerCode(form.elements.binLocation.value || '');
    if (!scanId) throw new Error('Scan record not found');
    if (!String(form.elements.partNumber.value || '').trim()) throw new Error('Part number is required');
    if (!(quantity > 0)) throw new Error('Quantity must be greater than zero');
    if (['INWARD', 'OUTWARD', 'DAMAGE'].includes(scanType) && !binLocation) throw new Error('Bin location is required');
    if (message) {
      message.className = 'form-message loading';
      message.textContent = 'Saving changes...';
    }
    const data = await api(`/api/scans/${encodeURIComponent(scanId)}/details`, {
      method: 'PATCH',
      body: {
        partNumber: normalizePartText(form.elements.partNumber.value),
        quantity,
        binLocation,
        deviceId: ensureDeviceId()
      }
    });
    closeScanEditModal();
    toast(data.message || 'Part details updated');
    if (data.scan) {
      addScanToStream(data.scan);
      queueRealtimeReportRefresh('scan details update');
    }
    await Promise.all([loadDashboard(), loadScanHistory()]);
    if (state.reportHasRun && activeReportType()) {
      await loadReport({ forceRefresh: true, showLoading: false });
    }
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
    writeJsonStorage(scopedStorageKey(SYNC_LOG_KEY), log);
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

  function setMultiSelectValues(select, values = []) {
    if (!select) return;
    const selected = new Set(cleanDealerAccessInput(values));
    const options = Array.from(select.options || []);
    if (select.multiple) {
      options.forEach((option) => {
        option.selected = selected.has(cleanDealerCode(option.value));
      });
    } else {
      const preferred = selected.has('ALL') ? 'ALL' : Array.from(selected)[0] || '';
      const match = options.find((option) => cleanDealerCode(option.value) === preferred);
      select.value = match ? match.value : (options[0] ? options[0].value : '');
    }
    updateDealerAccessBoxes();
  }

  function dealerAccessDisplay(access = []) {
    const codes = cleanDealerAccessInput(access);
    if (!codes.length) return '';
    if (codes.includes('ALL')) return 'All Dealers';
    return codes.map((code) => {
      const dealer = dealerByCode(code);
      return dealer ? formatDealerDisplay(dealer) : code;
    }).join(', ');
  }

  function dealerAccessSummary(select) {
    if (!select) return 'Select dealer access';
    const codes = cleanDealerAccessInput(select.multiple
      ? Array.from(select.selectedOptions || []).map((option) => option.value)
      : select.value);
    return dealerAccessDisplay(codes) || 'Select dealer access';
  }

  function updateDealerAccessBoxes() {
    const pairs = [
      ['#createUserDealerAccess', '#createUserDealerAccessBox'],
      ['#editUserDealerAccess', '#editUserDealerAccessBox']
    ];
    pairs.forEach(([selectId, boxId]) => {
      const box = $(boxId);
      if (box) box.textContent = dealerAccessSummary($(selectId));
    });
  }

  function renderDealerAccessOptions() {
    const dealers = (state.dealers || []).filter((dealer) => !isTestDealer(dealer) && dealer.active !== false);
    $$('.dealer-access-select').forEach((select) => {
      const selected = cleanDealerAccessInput(Array.from(select.selectedOptions || []).map((option) => option.value));
      select.innerHTML = '<option value="ALL">All Dealers</option>' + dealers.map((dealer) => (
        `<option value="${escapeHtml(dealer.dealerCode)}">${escapeHtml(formatDealerDisplay(dealer))}</option>`
      )).join('');
      setMultiSelectValues(select, selected);
    });
    updateDealerAccessBoxes();
  }

  function auditUserLabel(user = {}) {
    const role = user.role === 'mobile_user' ? 'Mobile User' : (user.role || 'staff');
    const name = user.name || user.username || user.email || 'User';
    const username = user.username ? ` (${user.username})` : '';
    return `${name}${username} - ${role}`;
  }

  function auditAssignableUsers() {
    return (state.users || [])
      .filter((user) => user && user.active !== false && user.approved !== false)
      .sort((a, b) => String(a.name || a.username || '').localeCompare(String(b.name || b.username || ''), undefined, { numeric: true }));
  }

  function renderAuditUserOptions() {
    const select = $('#dealerAuditUserSelect');
    if (!select) return;
    const selected = select.value;
    const users = auditAssignableUsers();
    select.innerHTML = '<option value="">Select User</option>' + users.map((user) => (
      `<option value="${escapeHtml(user.id || '')}" data-name="${escapeHtml(user.name || user.username || '')}" data-username="${escapeHtml(user.username || '')}">${escapeHtml(auditUserLabel(user))}</option>`
    )).join('');
    if (selected && Array.from(select.options).some((option) => option.value === selected)) select.value = selected;
  }

  function applySelectedAuditUserToForm() {
    const select = $('#dealerAuditUserSelect');
    const input = $('#dealerAuditUserName');
    if (!select || !input) return;
    const option = select.selectedOptions && select.selectedOptions[0];
    if (!option || !option.value) return;
    input.value = option.dataset.name || option.dataset.username || option.textContent || '';
  }

  function auditUserDisplay(dealer = {}) {
    return dealer.auditorName || dealer.auditorUsername || dealer.auditUserName || '';
  }

  async function loadUsers() {
    if (!state.user || state.user.role !== 'admin') return;
    const data = await api('/api/users');
    state.users = data.users || [];
    renderUsers();
    renderAuditUserOptions();
  }

  function onUserActionChange(event) {
    const select = event.target.closest('.user-action-dropdown');
    if (!select || !$('#userRows')?.contains(select)) return;
    const action = select.value;
    select.value = '';
    if (!action) return;
    handleUserAction(select, action).catch((error) => toast(error.message, 'error'));
  }

  function renderUsers() {
    renderResetUserOptions();
    $('#userRows').innerHTML = state.users.map((user) => `
      <tr>
        <td>${escapeHtml(user.name)}</td>
        <td>${escapeHtml(user.username)}</td>
        <td>${escapeHtml(user.email)}</td>
        <td>${escapeHtml(user.role === 'mobile_user' ? 'Mobile User' : user.role)}</td>
        <td>${escapeHtml(dealerAccessDisplay(user.dealerAccess || []))}</td>
        <td>${user.approved ? '<span class="status-ok">Approved</span>' : '<span class="status-warn">Pending</span>'}</td>
        <td>${user.active ? '<span class="status-ok">Active</span>' : '<span class="status-warn">Blocked</span>'}</td>
        <td class="user-actions-cell">
          <select class="app-action-dropdown user-action-dropdown" data-id="${escapeHtml(user.id)}" data-active="${user.active ? 'false' : 'true'}" data-email="${escapeHtml(user.email)}" data-username="${escapeHtml(user.username)}" aria-label="Actions for ${escapeHtml(user.username || user.name || 'user')}">
            <option value="">Actions</option>
            <option value="edit">Edit</option>
            <option value="approve">Approve</option>
            <option value="toggle">${user.active ? 'Block' : 'Activate'}</option>
            <option value="email">Email</option>
            <option value="send-reset">Send OTP</option>
            <option value="reset-password">Reset</option>
            <option value="delete">Delete</option>
          </select>
        </td>
      </tr>
    `).join('');
  }

  async function handleUserAction(select, action) {
    const id = select.dataset.id;
    if (!id) return;
    if (action === 'edit') {
      openEditUserModal(id);
      return;
    }
    if (action === 'approve') {
      await api(`/api/users/${id}/approve`, { method: 'PUT', body: {} });
      toast('User approved');
      await loadUsers();
      return;
    }
    if (action === 'toggle') {
      await api(`/api/users/${id}/block`, { method: 'PUT', body: { active: select.dataset.active } });
      toast(select.dataset.active === 'true' ? 'User activated' : 'User blocked');
      await loadUsers();
      return;
    }
    if (action === 'email') {
      const email = window.prompt('Enter new email ID for OTP reset', select.dataset.email || '');
      if (!email) return;
      await api(`/api/auth/users/${id}/email`, { method: 'POST', body: { email } });
      toast('User email updated');
      await loadUsers();
      return;
    }
    if (action === 'send-reset') {
      const data = await api(`/api/auth/users/${id}/send-reset`, { method: 'POST', body: {} });
      toast(data.message || 'OTP reset link sent', data.mailSent === false ? 'error' : 'success');
      return;
    }
    if (action === 'reset-password') {
      const password = window.prompt('Enter new password for this user');
      if (!password) return;
      await api(`/api/auth/users/${id}/reset-password`, { method: 'POST', body: { password } });
      toast('Password reset by admin');
      await loadUsers();
      return;
    }
    if (action === 'delete') {
      if (state.user && String(state.user.id) === String(id)) {
        toast('You cannot delete your own logged-in admin user', 'error');
        return;
      }
      const username = select.dataset.username || 'this user';
      if (!window.confirm(`Delete user "${username}" permanently? This user will not be able to login.`)) return;
      const previousUsers = state.users.slice();
      const deletedId = String(id);
      state.users = state.users.filter((user) => String(user.id || user._id || '') !== deletedId);
      renderUsers();
      try {
        await api(`/api/users/${id}`, { method: 'DELETE', body: {} });
      } catch (error) {
        state.users = previousUsers;
        renderUsers();
        throw error;
      }
      toast('User deleted. Login blocked for that user.');
      loadUsers().catch((error) => toast(error.message, 'error'));
    }
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
    renderDealerAccessOptions();
    setMultiSelectValues(form.elements.dealerAccess, user.dealerAccess || []);
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

  async function copyMobileScannerUrl() {
    if (!state.serverInfo || !state.serverInfo.mobileScannerUrl) await loadPairingQr();
    const url = resolveMobileScannerUrl(state.serverInfo || {});
    if (!url || isLocalhostUrl(url)) {
      toast('Do not use localhost on mobile. Use the cloud server URL from pairing QR.', 'error');
      return;
    }
    await copyTextValue(url, 'Mobile scanner URL');
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

  async function refreshAll() {
    await loadDealers();
    const viewJobs = [
      loadDashboard(),
      loadSyncStatus()
    ];
    if ($('#reports')?.classList.contains('active')) viewJobs.push(loadCategories());
    if ($('#scan')?.classList.contains('active')) viewJobs.push(loadScanHistory(), loadBins(), loadBarcodeBins(), loadPairingQr());
    if ($('#binTransfer')?.classList.contains('active')) viewJobs.push(loadBinTransferHistory());
    if ($('#master')?.classList.contains('active')) viewJobs.push(loadPartSearchFilters());
    if ($('#validator')?.classList.contains('active')) viewJobs.push(loadMasterScanValidator());
    if ($('#devices')?.classList.contains('active')) viewJobs.push(loadDevices(), loadPairingQr());
    if ($('#admin')?.classList.contains('active')) viewJobs.push(loadAuthSettings(), loadUsers());
    await Promise.all(viewJobs);
    renderSyncQueue();
    renderSyncLog();
    renderConnectionLog();
  }

  function startDashboardFallbackRefresh() {
    if (state.dashboardFallbackTimer) clearInterval(state.dashboardFallbackTimer);
    state.dashboardFallbackTimer = setInterval(async () => {
      if (document.hidden || state.dashboardFallbackBusy) return;
      if (!document.body.classList.contains('dashboard-view-active')) return;
      const realtimeQuietMs = Date.now() - Number(state.lastRealtimeAt || 0);
      if (realtimeQuietMs < 120000) return;
      state.dashboardFallbackBusy = true;
      try {
        await loadDashboard({ force: true });
      } catch (error) {
        console.warn('[DASHBOARD] fallback refresh failed', error.message);
      } finally {
        state.dashboardFallbackBusy = false;
      }
    }, 120000);
  }

  function expandCodeRange(startValue, endValue) {
    const start = String(startValue || '').trim();
    const end = String(endValue || '').trim();
    const startMatch = start.match(/^(.+?)(\d+)$/);
    const endMatch = end.match(/^(.+?)(\d+)$/);
    if (startMatch && endMatch && startMatch[1].toUpperCase() === endMatch[1].toUpperCase()) {
      const first = Number(startMatch[2]);
      const last = Number(endMatch[2]);
      if (!Number.isFinite(first) || !Number.isFinite(last)) return [];
      const min = Math.min(first, last);
      const max = Math.max(first, last);
      const total = max - min + 1;
      if (total > 1000) throw new Error('Maximum 1000 labels can be generated at once');
      const prefix = startMatch[1].toUpperCase();
      const width = Math.max(startMatch[2].length, endMatch[2].length);
      return Array.from({ length: total }, (_, index) => `${prefix}${String(min + index).padStart(width, '0')}`);
    }
    const letterStart = start.match(/^(.+?)([A-Za-z])$/);
    const letterEnd = end.match(/^(.+?)([A-Za-z])$/);
    if (!letterStart || !letterEnd || letterStart[1].toUpperCase() !== letterEnd[1].toUpperCase()) return [];
    const first = letterStart[2].toUpperCase().charCodeAt(0);
    const last = letterEnd[2].toUpperCase().charCodeAt(0);
    const step = first <= last ? 1 : -1;
    const total = Math.abs(last - first) + 1;
    if (total > 1000) throw new Error('Maximum 1000 labels can be generated at once');
    const prefix = letterStart[1].toUpperCase();
    return Array.from({ length: total }, (_, index) => `${prefix}${String.fromCharCode(first + index * step)}`);
  }

  function splitPlainPartNumbers(value) {
    return String(value || '')
      .split(/[\n,/]+/)
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean);
  }

  function parsePlainBinLabelLine(line) {
    const text = String(line || '').trim();
    if (!text) return null;
    let binLocation = text;
    let partText = '';
    const separator = text.match(/^(.+?)\s*(?:\||:|=>)\s*(.+)$/);
    if (separator) {
      binLocation = separator[1];
      partText = separator[2];
    } else {
      const firstSplit = text.match(/^(\S+)\s+(.+)$/);
      if (firstSplit && /\d/.test(firstSplit[2])) {
        binLocation = firstSplit[1];
        partText = firstSplit[2];
      }
    }
    return {
      binLocation: binLocation.trim().toUpperCase(),
      partNumbers: splitPlainPartNumbers(partText)
    };
  }

  function plainBinLabelOptions() {
    return {
      dealerCode: cleanDealerCode($('#plainBinDealer')?.value || ''),
      paperSize: $('#plainBinPaperSize').value,
      orientation: $('#plainBinOrientation').value,
      paperWidthMm: Number($('#plainBinPaperWidth').value || 210),
      paperHeightMm: Number($('#plainBinPaperHeight').value || 297),
      labelWidthMm: Number($('#plainBinLabelWidth').value || 62),
      labelHeightMm: Number($('#plainBinLabelHeight').value || 24),
      columns: Number($('#plainBinColumns').value || 3),
      maxParts: Number($('#plainBinMaxParts').value || 5),
      marginMm: Number($('#plainBinMarginMm').value || 8),
      gapMm: Number($('#plainBinGapMm').value || 4),
      binFontSize: Number($('#plainBinFontSize').value || 10),
      partFontSize: Number($('#plainPartFontSize').value || 8)
    };
  }

  function plainBinLabelItemsFromInput() {
    const mode = $('#plainBinLabelMode')?.value || 'single';
    const dealerCode = cleanDealerCode($('#plainBinDealer')?.value || '');
    const selectedBins = plainBinSelectedValues();
    const manualBin = cleanDealerCode($('#plainBinLocation')?.value || '');
    const targetBins = selectedBins.length ? selectedBins : (manualBin ? [manualBin] : []);
    const items = [];
    const addItem = (item) => {
      if (!item || !item.binLocation) return;
      items.push(item);
    };

    if (mode === 'single' || mode === 'bin-part' || mode === 'bin-auto-parts') {
      targetBins.forEach((binLocation) => addItem({
        binLocation,
        dealerCode,
        includeAvailableParts: mode === 'bin-auto-parts',
        partNumbers: mode === 'bin-part' ? splitPlainPartNumbers($('#plainBinParts')?.value || '') : []
      }));
    }

    if (mode === 'bulk') {
      String($('#plainBulkBinLocations')?.value || '').split(/\r?\n/).forEach((line) => addItem(parsePlainBinLabelLine(line)));
      const from = $('#plainBinRangeFrom')?.value || '';
      const to = $('#plainBinRangeTo')?.value || '';
      if (from || to) {
        const range = expandCodeRange(from, to);
        if (!range.length) throw new Error('Enter a valid bulk bin range');
        range.forEach((binLocation) => addItem({ binLocation, partNumbers: [] }));
      }
    }

    const byBin = new Map();
    items.forEach((item) => {
      const key = item.binLocation.toUpperCase();
      const existing = byBin.get(key) || { binLocation: key, dealerCode: item.dealerCode || '', includeAvailableParts: false, partNumbers: [] };
      const parts = new Set(existing.partNumbers);
      (item.partNumbers || []).forEach((partNumber) => parts.add(partNumber));
      byBin.set(key, {
        binLocation: key,
        dealerCode: existing.dealerCode || item.dealerCode || '',
        includeAvailableParts: existing.includeAvailableParts || item.includeAvailableParts === true,
        partNumbers: Array.from(parts)
      });
    });
    return Array.from(byBin.values());
  }

  function plainBinSelectedValues() {
    return Array.from(state.plainBinSelectedBins || [])
      .map(cleanDealerCode)
      .filter(Boolean);
  }

  function plainBinValuesFromBins(bins = []) {
    return bins
      .map((bin) => cleanDealerCode(bin.binLocation || bin.binCode || bin.bin || ''))
      .filter(Boolean);
  }

  function syncPlainBinHiddenSelect() {
    const select = $('#plainBinSelect');
    if (!select) return;
    const selected = new Set(plainBinSelectedValues());
    Array.from(select.options || []).forEach((option) => {
      option.selected = selected.has(cleanDealerCode(option.value));
    });
  }

  function updatePlainBinSelectedView() {
    const values = plainBinSelectedValues();
    const button = $('#plainBinSelectButton');
    if (button) {
      button.textContent = values.length ? (values.length === 1 ? values[0] : `${values.length} bins selected`) : 'Select bin location(s)';
      button.title = values.join(', ');
    }
    const list = $('#plainBinSelectedList');
    if (list) {
      list.innerHTML = values.length
        ? values.map((value) => `<span class="plain-bin-chip" title="${escapeHtml(value)}">${escapeHtml(value)}</span>`).join('')
        : '<span class="muted">No bin selected</span>';
    }
    if (values.length && $('#plainBinLocation')) $('#plainBinLocation').value = values[0];
    syncPlainBinHiddenSelect();
  }

  function renderPlainBinShowList(bins = state.plainBinLocations || []) {
    const rows = bins || [];
    setText('plainBinShowCount', `${rows.length} bin location${rows.length === 1 ? '' : 's'}`);
    const selected = new Set(plainBinSelectedValues());
    const body = $('#plainBinShowRows');
    if (!body) return;
    body.innerHTML = rows.length ? rows.map((bin) => {
      const binCode = cleanDealerCode(bin.binLocation || bin.binCode || bin.bin || '');
      const isSelected = selected.has(binCode);
      return `
        <tr class="${isSelected ? 'plain-bin-list-selected' : ''}">
          <td>${escapeHtml(binCode)}</td>
          <td>${escapeHtml(cleanDealerCode(bin.dealerCode || $('#plainBinDealer')?.value || ''))}</td>
          <td>${escapeHtml(bin.category || bin.binName || '')}</td>
          <td>${isSelected ? 'Selected' : 'Available'}</td>
        </tr>
      `;
    }).join('') : '<tr><td colspan="4" class="muted">No bin locations found for selected dealer.</td></tr>';
  }

  function renderPlainBinOptions(bins = []) {
    state.plainBinLocations = bins;
    const values = plainBinValuesFromBins(bins);
    const allowed = new Set(values);
    state.plainBinSelectedBins = new Set(plainBinSelectedValues().filter((value) => allowed.has(value)));

    const select = $('#plainBinSelect');
    if (select) {
      select.innerHTML = values.length
        ? values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('')
        : '<option value="">No bins found</option>';
    }

    const panel = $('#plainBinSelectPanel');
    if (panel) {
      panel.innerHTML = values.length ? values.map((value, index) => `
        <label class="plain-bin-multi-option">
          <input class="plain-bin-option" type="checkbox" value="${escapeHtml(value)}" data-index="${escapeHtml(index)}" ${state.plainBinSelectedBins.has(value) ? 'checked' : ''}>
          <span>${escapeHtml(value)}</span>
        </label>
      `).join('') : '<div class="bin-label-multi-empty">No bins found</div>';
    }

    updatePlainBinSelectedView();
    renderPlainBinShowList(bins);
  }

  async function loadPlainBinOptions() {
    const dealerCode = cleanDealerCode($('#plainBinDealer')?.value || '');
    if (!dealerCode) {
      state.plainBinSelectedBins = new Set();
      renderPlainBinOptions([]);
      if ($('#plainBinShowPanel')) $('#plainBinShowPanel').hidden = true;
      return [];
    }
    const data = await api(`/api/qr/bins?dealerCode=${encodeURIComponent(dealerCode)}`);
    renderPlainBinOptions(data.bins || []);
    toast(`Loaded ${(data.bins || []).length} bin location(s)`);
    return data.bins || [];
  }

  async function showPlainBinLocations() {
    const dealerCode = cleanDealerCode($('#plainBinDealer')?.value || '');
    if (!dealerCode) throw new Error('Select dealer first');
    if (!state.plainBinLocations.length) await loadPlainBinOptions();
    renderPlainBinShowList(state.plainBinLocations || []);
    const panel = $('#plainBinShowPanel');
    if (panel) {
      panel.hidden = false;
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
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

  function scheduleBarcodeAutosave(delay = 35) {
    const form = $('#barcodeScanForm');
    const raw = String($('#barcodeRaw')?.value || '').trim();
    if (!form || !raw || state.barcodeAutoSaving) return;
    const normalizedRaw = normalizePartText(raw);
    const now = Date.now();
    if (state.barcodeLastRaw === normalizedRaw && now - state.barcodeLastAt < 3000) {
      if (!lockBarcodeDuplicateNotice({
        rawScan: raw,
        rawScanString: raw,
        dealerCode: currentDealerCode(),
        auditId: activeAuditIdForScope()
      }, 3000)) {
        setLivePill('barcodeReadyStatus', 'Duplicate blocked', false);
        playScanTone('duplicate');
      }
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
        if (nextRaw && normalizePartText(nextRaw) !== normalizedRaw) scheduleBarcodeAutosave(20);
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
    if (viewId === 'dashboard' && state.dashboardLoaded) {
      loadDashboard({ force: true }).catch((error) => toast(error.message, 'error'));
    } else if (viewId !== 'dashboard') {
      document.body.classList.remove('app-booting');
    }
    if (viewId === 'binTransfer') {
      const dealerCode = binTransferCriteria().dealerCode;
      if (dealerCode) loadBinTransferBins(dealerCode).then(() => loadBinTransferHistory()).catch((error) => toast(error.message, 'error'));
      else loadBinTransferHistory().catch((error) => toast(error.message, 'error'));
    }
    if (viewId === 'scan') {
      Promise.all([loadScanHistory(), loadBins(), loadBarcodeBins(), loadPairingQr()]).catch((error) => toast(error.message, 'error'));
    }
    if (viewId === 'reports') {
      loadCategories().catch((error) => toast(error.message, 'error'));
    }
    if (viewId === 'master') {
      loadPartSearchFilters().catch((error) => toast(error.message, 'error'));
      loadCatalogueRequiredColumns().catch((error) => toast(error.message, 'error'));
    }
    if (viewId === 'validator') {
      loadMasterScanValidator().catch((error) => toast(error.message, 'error'));
    }
    if (viewId === 'devices') {
      Promise.all([loadDevices(), loadPairingQr()]).catch((error) => toast(error.message, 'error'));
    }
    if (viewId === 'admin') {
      Promise.all([loadAuthSettings(), loadUsers()]).catch((error) => toast(error.message, 'error'));
    }
    if (viewId === 'archiveRestore') {
      loadAuditBackups().catch((error) => toast(error.message, 'error'));
    }
    if (viewId === 'reconciliation' && !state.reconLoaded && activeReconDealer()) {
      loadReconciliation().catch((error) => toast(error.message, 'error'));
    }
  }

  function restoreActiveViewShell() {
    const params = new URLSearchParams(window.location.search);
    const requestedView = params.get('view') || '';
    const savedView = requestedView || localStorage.getItem(ACTIVE_VIEW_KEY) || 'dashboard';
    const viewId = $(`#${savedView}`) ? savedView : 'dashboard';
    openView(viewId, VIEW_TITLES[viewId]);
    let hasPartSearch = false;
    if (viewId === 'reports') {
      restoreReportState();
      const reportType = params.get('reportType');
      if (reportType && REPORT_TITLES[reportType]) setReportTab(reportType, { persist: false });
    }
    if (viewId === 'master') {
      const form = $('#partSearchForm');
      ['partNumber', 'category', 'group', 'year', 'model', 'mrp'].forEach((key) => {
        const value = params.get(key);
        if (!value || !form) return;
        const field = $(`[name="${CSS.escape(key)}"]`, form);
        if (field) {
          field.value = value;
          hasPartSearch = true;
        }
      });
    }
    return { viewId, hasPartSearch };
  }

  async function finishRestoredViewLoad(restored = {}) {
    if (restored.viewId === 'reports') {
      resetReportPreview('Saved report filters loaded. Changes will load automatically.');
    }
    if (restored.viewId === 'master' && restored.hasPartSearch) {
      await loadParts();
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
      if (event.key === 'Escape') {
        setUserMenuOpen(false);
        closeScanEditModal();
      }
    });
    $('#scanEditForm')?.addEventListener('submit', (event) => saveEditedScan(event).catch((error) => {
      const message = $('#scanEditMessage');
      if (message) {
        message.className = 'form-message error';
        message.textContent = error.message || 'Part update failed';
      }
    }));
    $('#scanEditClose')?.addEventListener('click', closeScanEditModal);
    $('#scanEditCancel')?.addEventListener('click', closeScanEditModal);
    $('#scanEditModal')?.addEventListener('click', (event) => {
      if (event.target.id === 'scanEditModal') closeScanEditModal();
    });
    window.addEventListener('resize', () => fitDashboardDealerSelect());
    $('#copyServerUrlBtn').addEventListener('click', () => copyServerUrl().catch((error) => toast(error.message, 'error')));
    $('#copyHealthUrlBtn')?.addEventListener('click', () => copyHealthUrl().catch((error) => toast(error.message, 'error')));
    $('#copyMobileScannerUrlBtn')?.addEventListener('click', () => copyMobileScannerUrl().catch((error) => toast(error.message, 'error')));
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
    $('#syncCopyMobileScannerUrlBtn')?.addEventListener('click', () => copyMobileScannerUrl().catch((error) => toast(error.message, 'error')));
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
    $('#manualScanForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      if (form.dataset.submitting === 'true') return;
      setScanFormSubmitting(form, true);
      try {
        await submitScan(form, { confirmBeforeSave: true });
      } catch (error) {
        playScanTone('error');
        toast(error.message || 'Manual scan could not be saved', 'error');
      } finally {
        setScanFormSubmitting(form, false);
      }
    });
    $('#barcodeScanForm').addEventListener('submit', (event) => {
      event.preventDefault();
      const raw = String($('#barcodeRaw')?.value || '').trim();
      fillBarcodePartFromRaw();
      submitScan(event.currentTarget, { backgroundRefresh: true, expectedRaw: raw });
    });
    $('#focusScanner').addEventListener('click', () => $('#barcodeRaw').focus());
    $('#barcodeRaw').addEventListener('input', () => {
      fillBarcodePartFromRaw();
    });
    $('#barcodeRaw').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        scheduleBarcodeAutosave(20);
      }
    });
    $('#barcodeRaw').addEventListener('change', () => scheduleBarcodeAutosave(35));
    $$('#manualScanForm [name="type"], #barcodeScanForm [name="type"]').forEach((select) => {
      updateScanTypeFields(select.closest('form'));
      select.addEventListener('change', () => {
        updateScanTypeFields(select.closest('form'));
        if (select.closest('#barcodeScanForm')) scheduleBarcodeAutosave(35);
      });
    });
    $('#manualSyncBtn').addEventListener('click', runSync);
    $('#homeManualSyncBtn').addEventListener('click', runSync);
    $('#dashboardViewReportBtn')?.addEventListener('click', () => {
      const select = $('#dashboardDealerSelect');
      state.dashboardDealerCode = cleanDealerCode((select && select.value) || state.dashboardDealerCode || '');
      state.selectedProductGroupSummary = null;
      state.productGroupDetailRows = [];
      state.productGroupDetailTotals = null;
      renderProductGroupDetails({ rows: [], totals: {} });
      loadDashboard().catch((error) => toast(error.message, 'error'));
    });
    $('#repairSyncStatusBtn')?.addEventListener('click', () => repairSyncStatus().catch((error) => toast(error.message, 'error')));
    $('#syncCenterManualBtn').addEventListener('click', runSync);
    $('#syncCenterRetryBtn').addEventListener('click', () => syncPendingQueue({ includeFailed: true }).catch((error) => toast(error.message, 'error')));
    $('#syncDebugRefreshBtn')?.addEventListener('click', () => loadLatestSyncDebug().catch((error) => toast(error.message, 'error')));
    $('#clearSyncLogBtn').addEventListener('click', () => {
      localStorage.removeItem(scopedStorageKey(SYNC_LOG_KEY));
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
        if (select.id === 'activeDealerSwitch') {
          switchActiveDealer(select.value).catch((error) => toast(error.message, 'error'));
          return;
        }
        if (select.id === 'dashboardDealerSelect') {
          state.dashboardDealerCode = cleanDealerCode(select.value || '');
          syncScanDealerScope(state.dashboardDealerCode, select);
          state.selectedProductGroupSummary = null;
          state.productGroupDetailRows = [];
          state.productGroupDetailTotals = null;
          renderProductGroupDetails({ rows: [], totals: {} });
          state.reportCache.clear();
          loadDashboard({ force: true }).catch((error) => toast(error.message, 'error'));
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
    let scanHistoryFilterTimer = null;
    $$('#scanHistoryFilters input, #scanHistoryFilters select').forEach((field) => {
      field.addEventListener(field.tagName === 'SELECT' ? 'change' : 'input', () => {
        clearTimeout(scanHistoryFilterTimer);
        scanHistoryFilterTimer = setTimeout(() => {
          loadScanHistory().catch((error) => toast(error.message, 'error'));
        }, field.tagName === 'SELECT' ? 0 : 250);
      });
    });
    $('#scanHistorySelectAll')?.addEventListener('change', (event) => {
      $$('.scan-history-checkbox').forEach((box) => { box.checked = event.target.checked; });
    });
    $('#scanHistoryDeleteSelectedBtn')?.addEventListener('click', () => deleteSelectedScans().catch((error) => toast(error.message, 'error')));
    $('#scanHistoryDeleteUnknownBtn')?.addEventListener('click', () => cleanUnknownParts({}).catch((error) => toast(error.message, 'error')));
    $('#scanHistoryDeleteDealerBtn')?.addEventListener('click', () => deleteByDealerCode().catch((error) => toast(error.message, 'error')));
    $('#validatorRefreshBtn')?.addEventListener('click', () => loadMasterScanValidator().catch((error) => toast(error.message, 'error')));
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

    const reportFiltersForm = $('#reportFilters');
    reportFiltersForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      loadReport().catch((error) => toast(error.message, 'error'));
    });
    reportFiltersForm?.addEventListener('input', (event) => {
      const field = event.target;
      if (!field || field.disabled) return;
      if (field.type === 'checkbox' || field.type === 'radio' || field.type === 'button' || field.type === 'submit' || field.type === 'reset' || field.type === 'file') return;
      if (!field.name || field.name === 'reportTableSearch') return;
      scheduleReportLoad(field.type === 'date' || field.type === 'datetime-local' ? 220 : 450);
    });
    reportFiltersForm?.addEventListener('change', (event) => {
      const field = event.target;
      if (!field || field.disabled) return;
      if (field.type === 'submit' || field.type === 'button' || field.type === 'reset') return;
      const fieldName = String(field.name || '').trim();
      if (!fieldName) return;
      if (fieldName === 'productGroup') refreshReportSubGroupOptions();
      if (fieldName === 'showScannedPartsOnly' && field.checked) {
        const opposite = $('[name="showFullMasterWithZeroScan"]', reportFiltersForm);
        if (opposite) opposite.checked = false;
      }
      if (fieldName === 'showFullMasterWithZeroScan' && field.checked) {
        const opposite = $('[name="showScannedPartsOnly"]', reportFiltersForm);
        if (opposite) opposite.checked = false;
      }
      if (fieldName === 'dealerCode') {
        const params = reportParams();
        if (!params.dealerCode) {
          cancelScheduledReportLoad();
          resetReportPreview('Select dealer code first to load report automatically.');
          return;
        }
        syncScanDealerScope(params.dealerCode, field);
        scheduleReportLoad(220, 'Loading report...');
        return;
      }
      if (!reportParams().dealerCode) {
        cancelScheduledReportLoad();
        resetReportPreview('Select dealer code first to load report automatically.');
        return;
      }
      scheduleReportLoad(field.type === 'date' || field.type === 'datetime-local' ? 220 : 350, 'Loading report...');
    });
    $('#reportTypeSelect').addEventListener('change', (event) => {
      setReportTab(event.target.value);
      state.reportCache.clear();
      updateReportButtons();
      scheduleReportLoad(220, 'Loading report...');
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
        resetReportPreview('Report filters updated. Changes will load automatically.');
        scheduleReportLoad(220, 'Loading report...');
      } catch (error) {
        toast(error.message, 'error');
      }
    });
    $('#reportReset')?.addEventListener('click', () => {
      cancelScheduledReportLoad();
      if (state.reportAbortController) state.reportAbortController.abort();
      $('#reportFilters').reset();
      applyReportScanModeDefaults();
      resetReportPreview('Select filters to load report automatically.');
    });
    $('#reportTableSearch')?.addEventListener('input', () => {
      clearTimeout(state.reportSearchTimer);
      state.reportSearchTimer = setTimeout(() => {
        if (state.reportTableRows.length || state.reportTableColumns.length) {
          renderReportTable(state.reportTableColumns, state.reportTableRows, state.reportTableTotalRows, state.reportTableGrandTotal, activeReportType());
        }
      }, 500);
    });
    $('#reportExcel').addEventListener('click', () => {
      if (!validateReportSelection(true)) return;
      downloadGet(reportPath('excel'), reportDownloadName('xlsx')).catch((error) => toast(error.message, 'error'));
    });
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
        renderDealerStockErrors(error.data?.errorRows || [], error.data?.skippedCount || 0, error.data?.errorRowsTruncated);
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
    $('#reconExcel').addEventListener('click', () => downloadGet(`/api/reconciliation/report?${reconciliationExportQuery('excel')}`, 'Daksh_Reconciliation.xlsx').catch((error) => toast(error.message, 'error')));
    $('#reconPdf').addEventListener('click', () => downloadGet(`/api/reconciliation/report?${reconciliationExportQuery('pdf')}`, 'Daksh_Reconciliation.pdf').catch((error) => toast(error.message, 'error')));

    $('#partUploadForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const uploadId = createCatalogueUploadSessionId();
        const formData = new FormData(event.currentTarget);
        formData.set('uploadId', uploadId);
        state.catalogueUploadSessionId = uploadId;
        setCatalogueUploadBusy(true, {
          uploadId,
          stage: 'received',
          percent: 0,
          message: 'Sending file to server...'
        });
        const data = await api('/api/master-catalogue/upload', { method: 'POST', body: formData });
        setCatalogueUploadBusy(false);
        updateCatalogueUploadStats(data, { action: 'upload' });
        const uploadMismatch = Boolean(data.rowCountMismatch) || (Number(data.fileRowsCount || 0) > 0 && Number(data.savedRowsCount ?? data.importedRowsCount ?? 0) !== Number(data.fileRowsCount || 0));
        setCatalogueUploadProgress({
          ...data,
          stage: 'completed',
          message: uploadMismatch ? 'Upload completed with mismatch' : 'Upload completed'
        }, {
          visible: true,
          variant: uploadMismatch ? 'warning' : 'success',
          text: catalogueUploadProgressText(data)
        });
        toast(uploadMismatch
          ? 'Upload completed with mismatch. Download failed rows to check missing parts.'
          : 'Upload completed', uploadMismatch ? 'warning' : 'success');
        if (hasPartSearchFilter() || !$('#partMasterResultsCard')?.hidden) await loadParts(state.masterSearch.page || 1);
      } catch (error) {
        setCatalogueUploadBusy(false);
        if (error.data) updateCatalogueUploadStats(error.data);
        setCatalogueUploadProgress({
          stage: 'error',
          percent: 100,
          message: error.message || 'Upload failed'
        }, {
          visible: true,
          variant: 'error',
          text: error.message || 'Upload failed'
        });
        if (error.message) setCatalogueUploadMessage(error.message, 'error');
        toast(error.message, 'error');
      }
    });
    $('#downloadCatalogueTemplateBtn')?.addEventListener('click', () => downloadGet('/api/master-catalogue/template', 'Part_Master_Catalogue_Template.xlsx').catch((error) => toast(error.message, 'error')));
    $('#deleteCatalogueBtn')?.addEventListener('click', async () => {
      if (!window.confirm('This will permanently delete the current Part Master catalogue. Scan and audit data will not be deleted. Continue?')) return;
      try {
        setCatalogueUploadBusy(true, {
          stage: 'deleting-old-catalogue',
          percent: 0,
          message: 'Deleting old catalogue...'
        });
        const data = await api('/api/master-catalogue', { method: 'DELETE', body: {} });
        setCatalogueUploadBusy(false);
        updateCatalogueUploadStats({
          fileRowsCount: 0,
          totalRowsCount: 0,
          importedRowsCount: 0,
          savedRowsCount: 0,
          failedRowsCount: 0,
          duplicateRowsCount: 0,
          skippedRowsCount: 0,
          insertedRowsCount: 0,
          updatedRowsCount: 0,
          missingMandatoryFieldsCount: 0,
          deletedPriceHistoryRowsCount: data.deletedPriceHistoryRowsCount || 0,
          currentMasterRecordCount: data.currentMasterRecordCount || 0,
          finalMasterRecordCount: data.currentMasterRecordCount || 0,
          masterCatalogueCount: data.currentMasterRecordCount || 0,
          deletedOldRowsCount: data.deletedOldRowsCount || 0,
          message: `Old catalogue deleted: ${data.deletedOldRowsCount || 0} rows`
        }, { action: 'delete' });
        setCatalogueUploadProgress({
          stage: 'deleted-old-catalogue',
          percent: 100,
          deletedOldRowsCount: data.deletedOldRowsCount || 0,
          deletedPriceHistoryRowsCount: data.deletedPriceHistoryRowsCount || 0,
          currentMasterRecordCount: data.currentMasterRecordCount || 0,
          message: 'Old catalogue deleted'
        }, {
          visible: true,
          variant: 'warning',
          text: `Old catalogue deleted: ${wholeNumber(data.deletedOldRowsCount || 0)} rows | Price history deleted: ${wholeNumber(data.deletedPriceHistoryRowsCount || 0)} rows | Final Part Master Records: ${wholeNumber(data.currentMasterRecordCount || 0)}`
        });
        state.catalogueFailureDownloadId = '';
        if ($('#downloadCatalogueFailedRowsBtn')) $('#downloadCatalogueFailedRowsBtn').hidden = true;
        clearPartSearch('Old catalogue deleted. Scan and audit data was not deleted.');
        toast(`Old catalogue deleted: ${data.deletedOldRowsCount || 0} rows`);
      } catch (error) {
        setCatalogueUploadBusy(false);
        if (error.data) updateCatalogueUploadStats(error.data);
        setCatalogueUploadProgress({
          stage: 'error',
          percent: 100,
          message: error.message || 'Delete failed'
        }, {
          visible: true,
          variant: 'error',
          text: error.message || 'Delete failed'
        });
        setCatalogueUploadMessage(error.message || 'Delete failed', 'error');
        toast(error.message, 'error');
      }
    });
    $('#downloadCatalogueFailedRowsBtn')?.addEventListener('click', () => downloadCatalogueFailedRows().catch((error) => toast(error.message, 'error')));
    $('#deleteReuploadCatalogueBtn')?.addEventListener('click', async () => {
      const form = $('#partUploadForm');
      const fileInput = $('[name="file"]', form);
      if (!fileInput || !fileInput.files.length) return toast('Select new master file first', 'error');
      if (!window.confirm('This will delete the current Part Master catalogue completely, then upload the selected file. Scan and audit data will not be deleted. Continue?')) return;
      try {
        const uploadId = createCatalogueUploadSessionId();
        const formData = new FormData(form);
        formData.set('uploadId', uploadId);
        state.catalogueUploadSessionId = uploadId;
        setCatalogueUploadBusy(true, {
          uploadId,
          stage: 'deleting-old-catalogue',
          percent: 0,
          message: 'Deleting old catalogue...'
        });
        const data = await api('/api/master-catalogue/delete-and-reupload', { method: 'POST', body: formData });
        setCatalogueUploadBusy(false);
        updateCatalogueUploadStats(data, { action: 'delete-reupload' });
        const uploadMismatch = Boolean(data.rowCountMismatch) || (Number(data.fileRowsCount || 0) > 0 && Number(data.savedRowsCount ?? data.importedRowsCount ?? 0) !== Number(data.fileRowsCount || 0));
        setCatalogueUploadProgress({
          ...data,
          stage: 'completed',
          message: uploadMismatch ? 'Delete and reupload completed with mismatch' : 'Delete and reupload completed'
        }, {
          visible: true,
          variant: uploadMismatch ? 'warning' : 'success',
          text: catalogueUploadProgressText(data)
        });
        toast([
          `Old catalogue deleted: ${data.deletedOldRowsCount || 0} rows`,
          `New catalogue uploaded: ${data.importedRowsCount || 0} rows`,
          uploadMismatch ? 'Upload completed with mismatch. Download failed rows to check missing parts.' : ''
        ].filter(Boolean).join(' | '), uploadMismatch ? 'warning' : 'success');
        if (hasPartSearchFilter() || !$('#partMasterResultsCard')?.hidden) await loadParts(state.masterSearch.page || 1);
      } catch (error) {
        setCatalogueUploadBusy(false);
        if (error.data) updateCatalogueUploadStats(error.data);
        setCatalogueUploadProgress({
          stage: 'error',
          percent: 100,
          message: error.message || 'Delete and reupload failed'
        }, {
          visible: true,
          variant: 'error',
          text: error.message || 'Delete and reupload failed'
        });
        if (error.message) setCatalogueUploadMessage(error.message, 'error');
        toast(error.message, 'error');
      }
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
    $('#dealerMasterForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const payload = formObject(event.currentTarget);
      const auditUserOption = $('#dealerAuditUserSelect')?.selectedOptions?.[0];
      if (auditUserOption && auditUserOption.value) {
        payload.auditUserId = auditUserOption.value;
        payload.auditorUsername = auditUserOption.dataset.username || '';
        payload.auditorName = payload.auditorName || auditUserOption.dataset.name || auditUserOption.dataset.username || '';
      }
      await api('/api/master/dealers', { method: 'POST', body: payload });
      toast('Dealer saved');
      event.currentTarget.reset();
      renderAuditUserOptions();
      const auditStartDate = $('[name="auditStartDate"]', event.currentTarget);
      if (auditStartDate) auditStartDate.value = new Date().toISOString().slice(0, 10);
      await loadDealers();
    });
    $('#dealerMasterRows')?.addEventListener('click', (event) => {
      const button = event.target.closest('.dealer-master-delete');
      if (!button) return;
      deleteDealerMaster(button.dataset.code, button.dataset.name).catch((error) => toast(error.message, 'error'));
    });
    $('#dealerMasterRows')?.addEventListener('change', (event) => {
      const select = event.target.closest('.dealer-action-select');
      if (!select) return;
      const action = select.value;
      const dealerCode = select.dataset.code;
      const auditId = select.dataset.auditId;
      if (!action) return;
      
      if (action === 'delete') {
        deleteDealerMaster(dealerCode).catch((error) => toast(error.message, 'error'));
      } else if (action === 'complete') {
        handleAuditComplete(auditId, dealerCode).catch((error) => toast(error.message, 'error'));
      } else if (action === 'reopen') {
        handleAuditReopen(auditId, dealerCode).catch((error) => toast(error.message, 'error'));
      }
      select.value = '';
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
        $('#plainBinLabelMode').value = 'bulk';
        $('#plainBulkBinLocations').value = data.bins.map((bin) => bin.binCode).join('\n');
      }
      toast('Bulk bin sequence created');
      if ($('#binManagementDealer')) $('#binManagementDealer').value = dealerCode;
      await loadBins();
      await loadBinTransferDestinationBins(dealerCode, $('.bin-transfer-from')?.value || '').catch(() => null);
    });

    $('#plainLoadBinsBtn')?.addEventListener('click', () => loadPlainBinOptions().catch((error) => toast(error.message, 'error')));
    $('#plainShowBinsBtn')?.addEventListener('click', () => showPlainBinLocations().catch((error) => toast(error.message, 'error')));
    $('#plainBinLabelMode')?.addEventListener('change', () => {
      if ($('#plainBinLabelMode')?.value === 'bin-auto-parts') loadPlainBinOptions().catch((error) => toast(error.message, 'error'));
    });
    $('#plainBinDealer')?.addEventListener('change', () => loadPlainBinOptions().catch((error) => toast(error.message, 'error')));
    $('#plainBinSelectButton')?.addEventListener('click', (event) => {
      event.stopPropagation();
      const panel = $('#plainBinSelectPanel');
      if (!panel) return;
      panel.hidden = !panel.hidden;
      $('#plainBinSelectControl')?.classList.toggle('open', panel.hidden === false);
    });
    $('#plainBinSelectPanel')?.addEventListener('click', (event) => event.stopPropagation());
    $('#plainBinSelectPanel')?.addEventListener('change', (event) => {
      const box = event.target.closest('.plain-bin-option');
      if (!box) return;
      const value = cleanDealerCode(box.value || '');
      if (box.checked) state.plainBinSelectedBins.add(value);
      else state.plainBinSelectedBins.delete(value);
      updatePlainBinSelectedView();
      renderPlainBinShowList(state.plainBinLocations || []);
    });
    document.addEventListener('click', () => {
      const panel = $('#plainBinSelectPanel');
      if (!panel) return;
      panel.hidden = true;
      $('#plainBinSelectControl')?.classList.remove('open');
    });
    $('#plainBinRangeBtn')?.addEventListener('click', () => {
      try {
        const range = expandCodeRange($('#plainBinRangeFrom').value, $('#plainBinRangeTo').value);
        if (!range.length) throw new Error('Enter a valid bulk bin range');
        const existing = String($('#plainBulkBinLocations').value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
        const combined = [...existing, ...range];
        const seen = new Set();
        $('#plainBulkBinLocations').value = combined.filter((item) => {
          const key = item.toUpperCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }).join('\n');
        $('#plainBinLabelMode').value = 'bulk';
        toast(`${range.length} bin location label(s) added`);
      } catch (error) {
        toast(error.message, 'error');
      }
    });
    $('#plainBinLabelPdfBtn')?.addEventListener('click', () => {
      try {
        const items = plainBinLabelItemsFromInput();
        if (!items.length) throw new Error('Enter at least one bin location');
        downloadPost('/api/qr/bin-location-label-pdf', {
          items,
          ...plainBinLabelOptions()
        }, 'Daksh_Bin_Location_Labels.pdf').catch((error) => toast(error.message, 'error'));
      } catch (error) {
        toast(error.message, 'error');
      }
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
    $$('.dealer-access-select').forEach((select) => {
      select.addEventListener('change', updateDealerAccessBoxes);
    });
    $('#dealerAuditUserSelect')?.addEventListener('change', applySelectedAuditUserToForm);
    $('#createUserForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const payload = formObject(event.currentTarget);
        if (payload.role !== 'admin' && !cleanDealerAccessInput(payload.dealerAccess).length) {
          payload.dealerAccess = selectedScanDealerCode() || selectedDashboardDealerCode() || (state.activeAudit && state.activeAudit.dealerCode) || '';
        }
        payload.dealerAccess = cleanDealerAccessInput(payload.dealerAccess);
        payload.approved = $('[name="approved"]', event.currentTarget).checked;
        payload.active = $('[name="active"]', event.currentTarget).checked;
        const data = await api('/api/users/create', { method: 'POST', body: payload });
        toast('User created');
        event.currentTarget.reset();
        renderDealerAccessOptions();
        $('[name="approved"]', event.currentTarget).checked = true;
        $('[name="active"]', event.currentTarget).checked = true;
        showCreatedUser(data.user);
        renderAuditUserOptions();
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
    $('#userRows')?.addEventListener('change', onUserActionChange);
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
    if (state.dashboardSocket) return;
    const socketOptions = { transports: ['websocket', 'polling'], reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000, reconnectionDelayMax: 5000 };
    const socket = apiBaseUrl() ? window.io(apiBaseUrl(), socketOptions) : window.io(socketOptions);
    state.dashboardSocket = socket;
    socket.on('connect', () => {
      state.lastRealtimeAt = Date.now();
      socket.emit('device:hello', { deviceId: ensureDeviceId(), deviceName: 'Dashboard Browser', deviceType: 'web' });
      addConnectionLog('Device connected', 'success');
    });
    if (state.dashboardHeartbeatTimer) clearInterval(state.dashboardHeartbeatTimer);
    state.dashboardHeartbeatTimer = setInterval(() => {
      if (!socket.connected) return;
      socket.emit('device:heartbeat', {
        deviceId: ensureDeviceId(),
        deviceName: 'Dashboard Browser',
        model: navigator.userAgent,
        serverUrl: state.serverInfo ? state.serverInfo.serverUrl : '',
        appVersion: 'web-dashboard'
      });
    }, 30000);
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
      handleNewScan(scan).catch(console.warn);
    });
    socket.on('scan:saved', (scan = {}) => {
      state.lastRealtimeAt = Date.now();
      if (scan && (scan.partNumber || scan.part || scan.scanId || scan.uniqueScanId)) {
        handleNewScan(scan).catch(console.warn);
      }
      queueRealtimeReportRefresh('scan saved');
      if ($('#dashboard')?.classList.contains('active')) queueDashboardRefresh(700);
      if ($('#scan')?.classList.contains('active')) queueScanRefresh(700);
      if ($('#binTransfer')?.classList.contains('active')) {
        Promise.all([loadBinTransferParts(activeBinTransferForm()), loadBinTransferHistory()]).catch(console.warn);
      }
    });
    socket.on('scan:duplicate', (scan = {}) => {
      state.lastRealtimeAt = Date.now();
      toast(`Duplicate scan: ${scan.partNumber || scan.part || ''}`, 'error');
    });
    socket.on('scan:deleted', () => {
      queueReconciliationRefresh('scan deleted');
      queueDashboardRefresh(500);
      if ($('#scan')?.classList.contains('active')) queueScanRefresh(500);
      if ($('#binTransfer')?.classList.contains('active')) loadBinTransferParts(activeBinTransferForm()).catch(console.warn);
    });
    socket.on('scan:count:update', (payload = {}) => {
      const stats = payload.stats || payload;
      if (stats && dashboardStatsMatchesActiveAudit(stats)) {
        updateDashboardCards(stats);
      }
    });
    socket.on('dashboard:update', (payload = {}) => {
      state.lastRealtimeAt = Date.now();
      queueRealtimeReportRefresh('dashboard update');
      if (!dashboardPayloadMatchesActiveAudit(payload)) return;
      if (payload.stats && dashboardStatsMatchesActiveAudit(payload.stats)) updateDashboardCards(payload.stats);
      if (Array.isArray(payload.recent)) renderScanStream(payload.recent, { skipActiveAuditFilter: true });
      updateScannerStatusBar({ at: new Date() });
    });
    socket.on('inventory:update', (payload = {}) => {
      state.lastRealtimeAt = Date.now();
      queueRealtimeReportRefresh('inventory update');
      if (!dashboardPayloadMatchesActiveAudit(payload)) return;
      if (payload.stats && dashboardStatsMatchesActiveAudit(payload.stats)) updateDashboardCards(payload.stats);
      if (Array.isArray(payload.recent)) renderScanStream(payload.recent, { skipActiveAuditFilter: true });
    });
    socket.on('reports:update', () => {
      state.lastRealtimeAt = Date.now();
      queueRealtimeReportRefresh('report broadcast');
    });
    socket.on('dealer-stock:update', (payload = {}) => {
      state.lastRealtimeAt = Date.now();
      markReportsStale('dealer stock update');
      if (activeReconDealer() && (!payload.dealerCode || cleanDealerCode(payload.dealerCode) === activeReconDealer())) {
        loadDealerStockPreview().catch(() => undefined);
        queueReconciliationRefresh('dealer stock update');
      }
    });
    socket.on('mrp:updated', (scan = {}) => {
      state.lastRealtimeAt = Date.now();
      prependScanHistory(scan);
      queueRealtimeReportRefresh('scan pricing update');
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
    socket.on('scan:last10:update', (payload = []) => {
      state.lastRealtimeAt = Date.now();
      const scans = Array.isArray(payload) ? payload : (Array.isArray(payload.recent) ? payload.recent : []);
      if (scans.length) renderScanStream(scans, { skipActiveAuditFilter: true });
    });
    socket.on('stats:update', (payload = {}) => {
      const stats = payload.stats || payload;
      if (stats && dashboardStatsMatchesActiveAudit(stats)) updateDashboardCards(stats);
      else queueDashboardRefresh(1200);
    });
    socket.on('devices:update', () => queueDeviceRefresh(1200));
    socket.on('device:connected', () => {
      addConnectionLog('Device connected', 'success');
      queueDeviceRefresh(500);
    });
    socket.on('device:heartbeat', () => queueDeviceRefresh());
    socket.on('device:disconnected', () => {
      addConnectionLog('Device disconnected', 'warning');
      queueDeviceRefresh(500);
    });
    socket.on('audit:active', (audit) => {
      state.activeAudit = audit;
      updateActiveAuditUi();
      loadBins().catch(console.warn);
      loadDashboard({ force: true }).catch(console.warn);
    });
    function handleInactiveAuditEvent() {
      state.activeAudit = null;
      updateActiveAuditUi();
      loadBins().catch(console.warn);
      loadDashboard({ force: true }).catch(console.warn);
      loadDevices().catch(console.warn);
      loadDealers({ force: true }).catch(console.warn);
    }
    socket.on('audit:completed', handleInactiveAuditEvent);
    socket.on('audit:closed', handleInactiveAuditEvent);
    socket.on('audit:reopened', () => {
      loadActiveAudit({ silent: true, allowMissing: true }).catch(console.warn);
      loadDealers({ force: true }).catch(console.warn);
      loadDashboard({ force: true }).catch(console.warn);
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
      updateSyncBadges(payload || {});
      refreshAfterSync(payload || {}).catch(console.warn);
    });
    socket.on('sync:failed', () => {
      setHeaderSyncStatus('Failed', false);
      setDashboardSyncStatus('Failed', false);
      updateSyncBadges({ serverStatus: 'offline', databaseStatus: 'offline', db: 'disconnected' });
      addConnectionLog('Sync failed', 'error');
    });
    socket.on('catalogue:upload:progress', (payload = {}) => {
      const uploadId = String(payload.uploadId || '').trim();
      if (state.catalogueUploadSessionId && uploadId && uploadId !== state.catalogueUploadSessionId) return;
      if (uploadId) state.catalogueUploadSessionId = uploadId;
      setCatalogueUploadProgress(payload, { visible: true });
      const stage = String(payload.stage || '').toLowerCase();
      if (stage.includes('error') || stage.includes('complete') || stage.includes('blocked')) {
        setCatalogueUploadBusy(false, payload);
      }
    });
    socket.on('offline-queue:update', (payload = {}) => {
      updateScannerStatusBar({ pendingSyncCount: payload.queuedCount || syncCounts().total, at: new Date() });
      renderSyncQueue();
    });
    socket.on('dealers:update', () => loadDealers({ force: true }).catch(console.warn));
    socket.on('master:update', () => {
      state.reportFilterDropdownsLoadedAt = 0;
      markReportsStale('master update');
      const jobs = [];
      if ($('#scan')?.classList.contains('active')) jobs.push(loadBins());
      if ($('#reports')?.classList.contains('active')) jobs.push(loadCategories());
      if ($('#master')?.classList.contains('active')) jobs.push(loadPartSearchFilters());
      if ($('#master')?.classList.contains('active')) jobs.push(loadCatalogueRequiredColumns());
      if ($('#dashboard')?.classList.contains('active')) jobs.push(loadDashboard({ force: true }));
      if (hasPartSearchFilter() || !$('#partMasterResultsCard')?.hidden) jobs.push(loadParts(state.masterSearch.page || 1));
      if (jobs.length) Promise.all(jobs).catch(console.warn);
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
      moveMasterDataAdminTools();
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
      resetReportPreview('Select filters to load report automatically.');
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
      if (!(restoredView.viewId === 'master' && restoredView.hasPartSearch)) clearPartSearch();
      setAutoSyncState();
      window.addEventListener('online', () => syncPendingQueue({ silent: true, includeFailed: true }).catch(console.warn));
      window.addEventListener('storage', (event) => {
        if (event.key === 'dakshToken' && !event.newValue) {
          bootWarn('storage event cleared token; redirecting to login');
          state.token = '';
          state.user = null;
          navigateTo('/', { replace: true });
        }
      });
      if (state.headerHeartbeatTimer) clearInterval(state.headerHeartbeatTimer);
      state.headerHeartbeatTimer = null;
      if (isMobileClient()) {
        state.headerHeartbeatTimer = setInterval(() => {
          if (!document.hidden) sendHeartbeat().catch(console.warn);
        }, 60000);
      }
      if (state.healthRefreshTimer) clearInterval(state.healthRefreshTimer);
      state.healthRefreshTimer = setInterval(() => {
        if (!document.hidden) loadHealth().catch(console.warn);
      }, 60000);
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
      if ($('#scan')?.classList.contains('active')) await loadBarcodeBins().catch(() => null);
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
