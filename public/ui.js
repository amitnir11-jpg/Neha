(function () {
  const UI_BOOT_VERSION = '20260818-global-select-runtime-v6';
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
      const sessionValue = window.sessionStorage ? sessionStorage.getItem(key) : null;
      if (sessionValue !== null) return sessionValue;
      return window.localStorage ? localStorage.getItem(key) : null;
    } catch (error) {
      bootWarn('browser storage read failed', { key, error: errorDetails(error) });
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
      if (window.sessionStorage) sessionStorage.removeItem(key);
    } catch (error) {
      bootWarn('browser storage remove failed', { key, error: errorDetails(error) });
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
    dealerMasterSelected: new Set(),
    dealerMasterPage: 1,
    dealerMasterSort: { key: 'dealerCode', direction: 'asc' },
    categories: [],
    reportProductGroups: [],
    reportProductSubGroups: [],
    reportGroupSubGroups: {},
    autoSyncTimer: null,
    barcodeSyncTimer: null,
    dashboardFallbackTimer: null,
    dashboardRefreshTimer: null,
    dashboardLoadPromise: null,
    dashboardLoadRequestId: 0,
    dashboardAbortController: null,
    dashboardTopBinsAbortController: null,
    dashboardLoaded: false,
    dashboardLastLoadedAt: 0,
    dashboardStats: {},
    scanRefreshTimer: null,
    scanRefreshInFlight: false,
    scanRefreshQueued: false,
    deviceRefreshTimer: null,
    lastRealtimeAt: 0,
    dashboardFallbackBusy: false,
    recentRealtimeScanIds: new Set(),
    dealerStockUploadId: '',
    dashboardProductGroupRows: [],
    dashboardProductGroupLoadPromise: null,
    dashboardProductGroupLoadRequestId: 0,
    dashboardProductGroupAbortController: null,
    dashboardProductGroupLoadedAt: 0,
    selectedProductGroupSummary: null,
    productGroupDetailRows: [],
    productGroupDetailTotals: null,
    adminDeleteRows: [],
    adminDeleteSelectedIds: new Set(),
    adminDeleteLastPreview: null,
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
    localPartsReportPage: 1,
    localPartsReportTotalPages: 1,
    localPartsReportStale: false,
    reportFilterSettings: {},
    reportFilterSettingsLoaded: new Set(),
    reportFilterDropdownsLoadedAt: 0,
    smartBinSettings: { enabled: true, allowMultipleLocations: true, requireReason: true, maxAllowedLocationsPerPart: 3 },
    smartBinSettingsLoaded: false,
    smartBinSettingsSaving: false,
    reportSort: { reportType: '', key: '', direction: 'asc' },
    scanHistorySort: { key: 'time', direction: 'desc' },
    dashboardDealerCode: '',
    dealersLoadPromise: null,
    dealersLoadedAt: 0,
    reconLoaded: false,
    reconRefreshTimer: null,
    reconRows: [],
    reconPage: 1,
    reconPageSize: 10,
    reconDashboardStats: null,
    reconLastUpdatedAt: null,
    validatorInvalidRows: [],
    validatorMapIndex: null,
    catalogueFailureDownloadId: '',
    catalogueUploadSessionId: '',
    catalogueUploadInFlight: false,
    auditPriceRefreshInFlight: false,
    auditPriceScopeLoading: false,
    catalogueUploadProgress: { stage: '', percent: 0, message: '', processedRows: 0, totalRows: 0, savedRowsCount: 0, failedRowsCount: 0, duplicateRowsCount: 0 },
    masterCatalogueCount: 0,
    partMasterExportInFlight: false,
    masterSearch: { q: '', page: 1, limit: 10, total: 0, sort: 'partNumber', direction: 'asc' },
    masterSearchRows: [],
    partMasterSelected: new Set(),
    activeAudit: null,
    auditPackInProgress: false,
    auditPackProgress: { stage: 'idle', percent: 0, message: '', activeStep: 0, status: 'idle' },
    auditPackAbortController: null,
    auditPackTimer: null,
    auditPackCloseTimer: null,
    auditPackRequestId: 0,
    auditPackSettings: null,
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
    barcodeCaptureQueue: [],
    barcodeLastCaptureKey: '',
    scanHistoryPage: 1,
    barcodeLastRaw: '',
    barcodeLastAt: 0,
    barcodeScanLocks: new Map(),
    barcodeDuplicateLocks: new Map(),
    partMasterLookupCache: new Map(),
    partMasterLookupPromise: new Map(),
    barcodeServerDuplicateChecks: new Map(),
    scanStreamRecords: [],
    localPartPage: 1,
    localPartTotalPages: 1,
    localPartEditingId: '',
    localPartHistoryLoaded: false,
    localPartRows: [],
    localPartFilterTimer: null
  };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  // The Print Bin Label dealer select gets one scoped SVG chevron from
  // /js/select-system.js; the Select Bin(s) trigger owns its own single icon.

  function clean(value) {
    return String(value ?? '').trim();
  }
  if (typeof window.clean !== 'function') window.clean = clean;
  const cleanId = (value) => String(value || '').trim();
  let deleteModalResolver = null;
  let deleteModalDetails = { reason: '', remarks: '' };
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
    damage: ['dealer', 'dateRange', 'scanType', 'productCategory', 'productGroup', 'productSubGroup', 'partNumber', 'binLocation'],
    'product-group-summary': ['dealer'],
    'multiple-bin-location-alert': ['dealer', 'audit', 'dateRange', 'partNumber', 'binLocation', 'userName'],
    'local-parts': ['dealer', 'audit', 'dateRange', 'partNumber', 'userName', 'status'],
    
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
    ['status', 'Status'],
    ['scanModeOptions', 'Inventory Audit Options']
  ];
  const DATA_VERSION_KEY = 'dakshDataVersion';
  const BARCODE_LAST_BIN_KEY = 'dakshBarcodeLastBin';
  const SIDEBAR_WIDTH_KEY = 'dakshSidebarWidth';
  const SIDEBAR_MIN_WIDTH = 90;
  const SIDEBAR_MAX_WIDTH = 260;
  const SIDEBAR_WIDE_WIDTH = 132;
  const CURRENT_DATA_VERSION = '2026-06-21-invalid-scan-validation';
  if (storageGet(DATA_VERSION_KEY) !== CURRENT_DATA_VERSION) {
    bootLog('local data version refresh', {
      from: storageGet(DATA_VERSION_KEY) || '',
      to: CURRENT_DATA_VERSION
    });
    [SYNC_QUEUE_KEY, SYNC_LOG_KEY, CONNECTION_LOG_KEY, 'dakshReportPreviewCache'].forEach((key) => storageRemove(key));
    storageSet(DATA_VERSION_KEY, CURRENT_DATA_VERSION);
  }
  const AUDIT_PACK_REPORTS = [
    { key: 'bin-wise-stock', label: 'Bin Wise Stock Report' },
    { key: 'user-dealer-wise', label: 'User & Dealer Wise Report' },
    { key: 'raw-upi', label: 'Raw UPI Report' },
    { key: 'scan-register', label: 'Scan Register Report' },
    { key: 'invalid-scan-report', label: 'Invalid Scan Report' },
    { key: 'stock-summary', label: 'Stock Summary Report' },
    { key: 'product-group-summary', label: 'Product Group Summary' },
    { key: 'short', label: 'Short Report' },
    { key: 'excess', label: 'Excess Report' },
    { key: 'movement_wise_stock_analysis', label: 'Movement Wise Stock Analysis Report' },
    { key: 'damage', label: 'Damage Report' },
    { key: 'category-wise-variance-summary', label: 'Category Wise Variance Summary' },
    { key: 'partwise-inventory-audit', label: 'Partwise Inventory Report' },
    { key: 'parts-inventory-refresh-template', label: 'Part Inventory Refresh Template' },
    { key: 'local-parts', label: 'Local Parts Report' },
    { key: 'reconciliation-report', label: 'Reconciliation Report' },
    { key: 'dealer-reconciliation-report', label: 'Dealer Reconciliation Report' },
    { key: 'dead-stock-report', label: 'Dead Stock Report' },
    { key: 'fast-moving-report', label: 'Fast Moving Report' },
    { key: 'slow-moving-report', label: 'Slow Moving Report' },
    { key: 'critical-shortage-report', label: 'Critical Shortage Report' }
  ];
  const AUDIT_PACK_REPORT_KEYS = new Set(AUDIT_PACK_REPORTS.map((item) => item.key));
  const AUDIT_PACK_EXTRA_OPTIONS = [
    { key: 'includeDashboardSummary', label: 'Include Dashboard Summary' },
    { key: 'includeAuditInformation', label: 'Include Audit Information' },
    { key: 'includeDealerInformation', label: 'Include Dealer Information' },
    { key: 'includeScanStatistics', label: 'Include Scan Statistics' },
    { key: 'includePendingOfflineScanDetails', label: 'Include Pending/Offline Scan Details' },
    { key: 'includeUserWiseSummary', label: 'Include User Wise Summary' }
  ];
  const AUDIT_PACK_EXTRA_KEYS = new Set(AUDIT_PACK_EXTRA_OPTIONS.map((item) => item.key));
  const AUDIT_PACK_REPORT_GROUPS = [
    {
      title: 'Stock Reports',
      keys: ['stock-summary', 'product-group-summary', 'bin-wise-stock', 'partwise-inventory-audit', 'parts-inventory-refresh-template']
    },
    {
      title: 'Local Reports',
      keys: ['local-parts']
    },
    {
      title: 'Scan Reports',
      keys: ['scan-register', 'raw-upi', 'invalid-scan-report']
    },
    {
      title: 'Variance Reports',
      keys: ['category-wise-variance-summary', 'short', 'excess', 'damage']
    },
    {
      title: 'Analysis Reports',
      keys: ['movement_wise_stock_analysis', 'dead-stock-report', 'fast-moving-report', 'slow-moving-report', 'critical-shortage-report']
    },
    {
      title: 'Dealer & Reconciliation',
      keys: ['user-dealer-wise', 'reconciliation-report', 'dealer-reconciliation-report']
    }
  ];
  const AUDIT_PACK_STORAGE_KEY = 'dakshCompleteAuditPackSettingsV2';
  const REPORT_TITLES = {
    'bin-wise-stock': 'Bin Wise Stock Report',
    'user-dealer-wise': 'User & Dealer Wise Report',
    'raw-upi': 'Raw UPI Report',
    'scan-register': 'Scan Register Report',
    'invalid-scan-report': 'Invalid Scan Report',
    'wrong-not-found-master': 'Invalid Scan Report',
    'multiple-bin-location-alert': 'Multiple Bin Location Alert Report',
    'stock-summary': 'Stock Summary Report',
    'product-group-summary': 'Product Group Summary',
    short: 'Short Report',
    excess: 'Excess Report',
    movement_wise_stock_analysis: 'Movement Wise Stock Analysis Report',
    damage: 'Damage Report',
    'category-wise-variance-summary': 'Category Wise Variance Summary',
    'partwise-inventory-audit': 'Partwise Inventory Report',
    'parts-inventory-refresh-template': 'Part Inventory Refresh Template',
    'local-parts': 'Local Parts Report'
  };
  const CSV_REPORT_TYPES = new Set();
  const NO_PDF_EMAIL_REPORT_TYPES = new Set(['stock-summary', 'product-group-summary', 'parts-inventory-refresh-template']);
  const HEAVY_REPORT_TYPES = new Set([
    'multiple-bin-location-alert',
    'partwise-inventory-audit',
    'category-wise-variance-summary',
    'movement_wise_stock_analysis'
  ]);
  const REPORT_PREVIEW_TIMEOUT_MS = 45000;
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
    'invalid-scan-report': 'invalid_scan_report_layout',
    'wrong-not-found-master': 'invalid_scan_report_layout',
    'multiple-bin-location-alert': 'multiple_bin_location_alert_report_layout'
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
    archiveRestore: 'Archive & Restore Center'
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
    if ($('#scan')?.classList.contains('active') && $('#barcodeEntry')?.classList.contains('active') && $('#barcodeBeep')?.checked === false) return;
    if (type === 'warning') {
      playTone(620, 0.12);
      return;
    }
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

  let smartBinPromptResolver = null;
  let smartBinPromptPayload = null;

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

  function syncDealerSelectDisplay(select) {
    if (!select) return;
    select.title = selectedOptionText(select);
  }

  function applySidebarWidth(width, persist = false) {
    // This function is deprecated. Sidebar width is now fixed via CSS.
    return;
  }

  function initSidebarResize() {
    // This function is deprecated as the sidebar is now a fixed width.
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

  function partActionButtonHtml(kind, part, options = {}) {
    const isCopy = kind === 'copy';
    const removeMode = String(options.removeMode || options.deleteMode || '').trim().toLowerCase();
    const disabled = !isCopy && !removeMode && !options.onRemove && !options.scanId && !options.partNumber;
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
      if (options.confirmText) attrs.push(`data-confirm-text="${escapeHtml(options.confirmText)}"`);
      if (options.partNumber) attrs.push(`data-part-number="${escapeHtml(options.partNumber)}"`);
      if (disabled) {
        attrs.push('disabled');
        attrs.push('aria-disabled="true"');
      }
    }
    return `<button ${attrs.join(' ')}>${isCopy ? '⧉' : '✕'}</button>`;
  }

  function partLink(partNumber, className = 'table-link', options = {}) {
    const part = String(partNumber || '').trim();
    if (!part) return escapeHtml(partNumber || '-');
    const extraClasses = String(className || '')
      .split(/\s+/)
      .map((cls) => cls.trim())
      .filter((cls) => cls && cls !== 'table-link');
    const classes = ['part-link-copy-group', 'part-link-static', ...extraClasses].join(' ');
    return `<span class="${escapeHtml(classes)}"><span class="part-number-selectable">${escapeHtml(part)}</span></span>`;
  }

  function deviceLink(deviceId, className = 'table-link') {
    const id = String(deviceId || '').trim();
    return id ? enterpriseLink(id, dashboardHref({ view: 'devices', deviceId: id }), { className, label: `Open device ${id} in a new tab` }) : escapeHtml(deviceId || '-');
  }

  function dashboardDeviceCell(deviceId) {
    const id = String(deviceId || '').trim();
    if (!id) return '<span class="device-id-cell">-</span>';
    return `<span class="device-id-cell" title="${escapeHtml(id)}">${deviceLink(id, 'table-link device-id-link')}</span>`;
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
        <div><dt>Part Number</dt><dd>${partLink(partNumber)}</dd></div>
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
    fetch(apiUrl('/api/auth/logout'), { method: 'POST', credentials: 'include' }).catch(() => {});
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
    clearScopedLiveCaches({ clearReportCache: true });
    storageRemove('dakshToken');
    storageRemove('dakshUser');
    storageRemove(ACTIVE_DEALER_KEY);
    storageRemove(scopedActiveDealerKey);
    storageRemove('dakshAssignedDealers');
    try {
      if (window.sessionStorage) sessionStorage.clear();
    } catch (error) {
      bootWarn('sessionStorage clear failed', { error: errorDetails(error) });
    }
  }

  async function clearCacheAndReload() {
    if (window.DAKSH_RUNTIME && typeof window.DAKSH_RUNTIME.clearCacheAndReload === 'function') {
      await window.DAKSH_RUNTIME.clearCacheAndReload();
      return;
    }
    try {
      if (window.caches && typeof caches.keys === 'function') {
        const keys = await caches.keys().catch(() => []);
        await Promise.all(keys.map((key) => caches.delete(key).catch(() => false)));
      }
    } catch (error) {
      bootWarn('cache storage clear failed', { error: errorDetails(error) });
    }
    try {
      if (window.sessionStorage) sessionStorage.clear();
    } catch (error) {
      bootWarn('sessionStorage clear failed', { error: errorDetails(error) });
    }
    window.location.reload();
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

  function isRetryableTransportError(error = {}) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    const status = Number(error.status || 0);
    if ([408, 502, 503, 504].includes(status)) return true;
    if (status) return false;
    return /network|failed to fetch|load failed|timed?\s*out|timeout|offline|connection/i.test(String(error.message || ''));
  }

  function isAdminUser() {
    return state.user && ['admin', 'super_admin'].includes(normalizeUiRole(state.user.role));
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

  const pendingStatusRequests = new Map();

  function api(path, options = {}) {
    const statusRead = (options.method || 'GET').toUpperCase() === 'GET'
      && /^\/api\/(?:health|devices|scans\/history|sync\/status)(?:\?|$)/.test(path);
    // Include dealer scope and credentials; never share independently cancelled reads.
    if (!statusRead || options.signal) return apiRequest(path, options);
    const key = `${state.token || ''}:${apiUrl(withActiveDealerQuery(path))}`;
    if (pendingStatusRequests.has(key)) return pendingStatusRequests.get(key);
    const request = apiRequest(path, options).finally(() => pendingStatusRequests.delete(key));
    pendingStatusRequests.set(key, request);
    return request;
  }

  async function apiRequest(path, options = {}) {
    const statusRead = (options.method || 'GET').toUpperCase() === 'GET'
      && /^\/api\/(?:health|devices|scans\/history|sync\/status)(?:\?|$)/.test(path);
    const dashboardRead = (options.method || 'GET').toUpperCase() === 'GET'
      && /^\/api\/scans\/(?:dashboard(?:\/product-group-summary(?:\/details)?)?|live|recent)(?:\?|$)/.test(path);
    const { timeoutMs = dashboardRead ? 30000 : statusRead ? 15000 : 0, ...fetchOptions } = options;
    const headers = fetchOptions.headers ? { ...fetchOptions.headers } : {};
    const requestPath = apiUrl(withActiveDealerQuery(path));
    const requestBody = fetchOptions.body ? withActiveDealerBody(fetchOptions.body) : fetchOptions.body;
    const isFormData = requestBody instanceof FormData;
    if (!isFormData) headers['Content-Type'] = 'application/json';
    if (state.token) headers.Authorization = `Bearer ${state.token}`;

    const isMobileSyncRequest = /^\/api\/mobile\/|^\/api\/sync\//.test(path);
    let timeout = null;
    let timeoutTriggered = false;
    let externalAbortHandler = null;
    const externalSignal = fetchOptions.signal;
    if (Number(timeoutMs) > 0 && typeof AbortController !== 'undefined') {
      const controller = new AbortController();
      fetchOptions.signal = controller.signal;
      if (externalSignal) {
        externalAbortHandler = () => controller.abort(externalSignal.reason || 'cancelled');
        if (externalSignal.aborted) externalAbortHandler();
        else externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
      }
      timeout = setTimeout(() => {
        timeoutTriggered = true;
        controller.abort('timeout');
      }, Number(timeoutMs));
    }
    let response;
    try {
      response = await fetch(requestPath, {
        ...fetchOptions,
        cache: fetchOptions.cache || 'no-store',
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
    } catch (error) {
      if (timeoutTriggered) throw new Error(dashboardRead
        ? `Server response delayed — retry. (${path})`
        : 'Server response delayed — retry.');
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (externalSignal && externalAbortHandler) externalSignal.removeEventListener('abort', externalAbortHandler);
    }
  }

  function sanitizeDownloadFileName(value, fallback = 'download.bin') {
    const text = String(value || '').trim().replace(/^["']|["']$/g, '');
    if (!text) return fallback;
    return text.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim() || fallback;
  }

  function filenameFromContentDisposition(header = '') {
    const text = String(header || '').trim();
    if (!text) return '';
    const utf8Match = text.match(/filename\*\s*=\s*([^']*)''([^;]+)/i);
    if (utf8Match) {
      try {
        return sanitizeDownloadFileName(decodeURIComponent(utf8Match[2].trim().replace(/^"|"$/g, '')));
      } catch (error) {
        return sanitizeDownloadFileName(utf8Match[2]);
      }
    }
    const quotedMatch = text.match(/filename\s*=\s*"([^"]+)"/i);
    if (quotedMatch) return sanitizeDownloadFileName(quotedMatch[1]);
    const plainMatch = text.match(/filename\s*=\s*([^;]+)/i);
    if (plainMatch) return sanitizeDownloadFileName(plainMatch[1]);
    return '';
  }

  function downloadFileNameFromPath(path, fallback = 'download.bin') {
    try {
      const url = new URL(String(path || ''), window.location.origin);
      const lastSegment = decodeURIComponent((url.pathname.split('/').filter(Boolean).pop() || '').trim());
      return sanitizeDownloadFileName(lastSegment || fallback, fallback);
    } catch (error) {
      return fallback;
    }
  }

  function resolveDownloadFileName(response, path, requestedName) {
    const fromHeader = filenameFromContentDisposition(response.headers.get('content-disposition'));
    return sanitizeDownloadFileName(fromHeader || requestedName || downloadFileNameFromPath(path), 'download.bin');
  }

  async function downloadGet(path, fileName, options = {}) {
    const { headers: optionHeaders, timeoutMs = 120000, ...fetchOptions } = options || {};
    const controller = new AbortController();
    const externalSignal = fetchOptions.signal;
    const abort = () => controller.abort(externalSignal.reason);
    if (externalSignal?.aborted) abort();
    else externalSignal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetch(apiUrl(withActiveDealerQuery(path)), {
        ...fetchOptions,
        signal: controller.signal,
        cache: fetchOptions.cache || 'no-store',
        headers: {
          ...(optionHeaders || {}),
          ...(state.token ? { Authorization: `Bearer ${state.token}` } : {})
        }
      });
      if (!response.ok) throw new Error(apiErrorMessage(await parseApiResponse(response), response.statusText));
      const blob = await response.blob();
      const finalName = resolveDownloadFileName(response, path, fileName);
      triggerDownload(blob, finalName);
      return finalName;
    } catch (error) {
      if (timedOut) throw new Error('Report download timed out. Please retry.');
      throw error;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abort);
    }
  }

  async function downloadPost(path, body, fileName, options = {}) {
    const { headers: optionHeaders, timeoutMs = 0, ...fetchOptions } = options || {};
    const externalSignal = fetchOptions.signal;
    const controller = Number(timeoutMs) > 0 ? new AbortController() : null;
    const abort = () => controller?.abort(externalSignal.reason);
    let timedOut = false;
    let timer = null;
    if (controller) {
      fetchOptions.signal = controller.signal;
      if (externalSignal?.aborted) abort();
      else externalSignal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    }
    try {
      const response = await fetch(apiUrl(withActiveDealerQuery(path)), {
        ...fetchOptions,
        method: 'POST',
        cache: fetchOptions.cache || 'no-store',
        headers: {
          ...(optionHeaders || {}),
          'Content-Type': 'application/json',
          ...(state.token ? { Authorization: `Bearer ${state.token}` } : {})
        },
        body: JSON.stringify(withActiveDealerBody(body))
      });
      if (!response.ok) throw new Error(apiErrorMessage(await parseApiResponse(response), response.statusText));
      const blob = await response.blob();
      const finalName = resolveDownloadFileName(response, path, fileName);
      triggerDownload(blob, finalName);
      return finalName;
    } catch (error) {
      if (timedOut) throw new Error('Report download timed out. Please retry.');
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (controller) externalSignal?.removeEventListener('abort', abort);
    }
  }

  function triggerDownload(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = sanitizeDownloadFileName(fileName, 'download.bin');
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Browsers consume the blob URL asynchronously after the click. Revoking it
    // synchronously can cancel the save, especially for large workbooks.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
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

  function normalizeUiRole(role) {
    const normalized = String(role || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    return ['staff', 'scanner', 'supervisor', 'outward_counter'].includes(normalized) ? 'audit_user' : normalized;
  }

  function roleDisplayName(role) {
    const normalized = normalizeUiRole(role);
    if (normalized === 'admin') return 'Administrator';
    if (normalized === 'mobile_user') return 'Mobile User';
    if (['audit_user', 'staff', 'scanner', 'supervisor', 'outward_counter'].includes(normalized)) return 'Audit User';
    return role ? String(role).replace(/^./, (char) => char.toUpperCase()) : 'User';
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
    setDashboardKpiValue('auditConnectedScanners', wholeNumber(activeScanners));
    setDashboardKpiValue('auditOfflineDevices', wholeNumber(offlineDevices));
    updateDashboardHealth({ ...state.lastSyncStatus, connectedDevices: activeScanners, offlineDevices, pending: pendingSyncCount });
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
    node.textContent = text.replace(/\n/g, ' ');
    node.title = text;
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
    const select = $('#dashboardAuditDealerSelect') || $('#dashboardDealerSelect');
    const dealerCode = cleanDealerCode(select ? select.value : (state.dashboardDealerCode || activeDealerId() || state.activeAudit?.dealerCode || ''));
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
    const dealerSelect = $('#dashboardAuditDealerSelect') || $('#dashboardDealerSelect');
    if (isAdminUser() && dealerSelect && !cleanDealerCode(dealerSelect.value)) {
      params.set('dealerCode', '__NO_DEALER_SELECTED__');
      return params;
    }
    const dealerCode = selectedDashboardDealerCode();
    if (dealerCode) params.set('dealerCode', dealerCode);
    else appendActiveAuditQuery(params);
    return params;
  }

  function selectedDashboardRange() {
    const value = String($('#dashboardDateRange')?.value || 'audit').trim().toLowerCase();
    return ['today', '7d', '30d', 'audit'].includes(value) ? value : 'audit';
  }

  function updateDashboardScopeSummary() {
    const dealerCode = dashboardScopeDealerCode();
    const dealer = dealerByCode(dealerCode) || {};
    const dealerName = String(dealer.dealerName || dealer.name || state.activeAudit?.dealerName || '').trim();
    const header = dealerCode ? `${dealerCode}${dealerName ? ` - ${dealerName}` : ''}` : 'Select a dealer';
    const audit = state.activeAudit && cleanDealerCode(state.activeAudit.dealerCode) === cleanDealerCode(dealerCode)
      ? state.activeAudit
      : null;
    setText('dashboardScopeSummary', `${header}${audit ? ` · Audit ${audit.auditId} · ${audit.auditStatus || 'ACTIVE'}` : dealerCode ? ' · No active audit' : ''}`);
  }

  function setDashboardRefreshState(refreshing) {
    const button = $('#dashboardRefreshButton');
    if (button) {
      button.disabled = Boolean(refreshing);
      button.classList.toggle('is-refreshing', Boolean(refreshing));
    }
    setText('dashboardRefreshLabel', refreshing ? 'Refreshing' : 'Refresh');
  }

  function dashboardQueryString(options = {}) {
    const params = appendDashboardScopeQuery(new URLSearchParams());
    params.set('range', selectedDashboardRange());
    if (options.forceRefresh === true) {
      params.set('refresh', 'true');
      params.set('_', String(Date.now()));
    }
    return params.toString();
  }

  function activeAuditMatchesScan(scan = {}) {
    const dashboardDealer = dashboardScopeDealerCode();
    if (!dashboardDealer) return true;
    const scanDealer = cleanDealerCode(scan.dealerCode || scan.dealer || '');
    return !scanDealer || scanDealer === dashboardDealer;
  }

  function filterActiveAuditScans(scans = []) {
    return Array.isArray(scans) ? scans.filter(activeAuditMatchesScan) : [];
  }

  function dashboardStatsMatchesActiveAudit(stats = {}) {
    const dashboardDealer = dashboardScopeDealerCode();
    const selectedRange = selectedDashboardRange();
    const statsRange = String(stats.dashboardRange || '').trim().toLowerCase();
    if (selectedRange !== 'audit' && statsRange !== selectedRange) return false;
    if (!dashboardDealer) return true;
    const dealerCode = cleanDealerCode(stats.dealerCode || stats.activeDealerCode || '');
    if (!dealerCode) return false;
    return dealerCode === dashboardDealer;
  }

  function dashboardPayloadMatchesActiveAudit(payload = {}) {
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
      return payloadDealer === dashboardDealer;
    }
    const scans = Array.isArray(payload.recent) ? payload.recent : (Array.isArray(payload.scans) ? payload.scans : []);
    return scans.some((scan) => cleanDealerCode(scan.dealerCode || scan.dealer || '') === dashboardDealer);
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

  function clearScopedLiveCaches({ clearReportCache = false } = {}) {
    state.barcodeServerDuplicateChecks.clear();
    state.barcodeScanLocks.clear();
    state.barcodeDuplicateLocks.clear();
    state.recentRealtimeScanIds.clear();
    state.scanHistoryRecords = [];
    state.scanStreamRecords = [];
    state.dashboardStats = null;
    state.dashboardLoaded = false;
    state.dashboardLastLoadedAt = 0;
    state.dashboardLoadPromise = null;
    state.dashboardAbortController = null;
    if (clearReportCache) state.reportCache.clear();
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
    clearScopedLiveCaches({ clearReportCache: true });
    state.dashboardDealerCode = next;
    state.activeAudit = null;
    syncScanDealerScope(next);
    state.selectedProductGroupSummary = null;
    state.productGroupDetailRows = [];
    state.productGroupDetailTotals = null;
    renderProductGroupDetails({ rows: [], totals: {} });
    const jobs = [];
    if ($('#scan')?.classList.contains('active')) jobs.push(loadScanHistory());
    if ($('#localPartEntry')?.classList.contains('active')) {
      syncLocalPartFormIdentity();
      jobs.push(loadLocalPartHistory({ page: 1 }));
    }
    if ($('#syncCenter')?.classList.contains('active')) jobs.push(loadSyncStatus());
    if ($('#devices')?.classList.contains('active')) jobs.push(loadDevices());
    await Promise.all(jobs.map((job) => job.catch((error) => toast(error.message, 'error'))));
  }

  function updateActiveAuditUi() {
    const audit = state.activeAudit;
    const selectedDealer = activeDealer();
    const selectedCode = cleanDealerCode(selectedDealer?.dealerCode || selectedDealer?.code || selectedDealer?.id || dashboardScopeDealerCode());
    const matchingAudit = audit && (!selectedCode || cleanDealerCode(audit.dealerCode) === selectedCode) ? audit : null;
    const auditLabel = matchingAudit
      ? `${formatDealerDisplay(matchingAudit)} · Audit ${matchingAudit.auditId} · ${matchingAudit.auditStatus || 'ACTIVE'}`
      : '';
    if (selectedDealer) {
      $$('.dealerSelect').forEach((select) => {
        if (select.closest('#reportFilters') && isAdminUser()) return;
        if (['dashboardDealerSelect', 'dashboardAuditDealerSelect'].includes(select.id) && state.dashboardDealerCode) {
          setDealerSelectValue(select, state.dashboardDealerCode);
          syncDealerSelectDisplay(select);
          return;
        }
        setDealerSelectValue(select, selectedDealer.dealerCode || selectedDealer.code || selectedDealer.id || '');
        syncDealerSelectDisplay(select);
      });
      setLivePill('activeAuditBadge', matchingAudit ? auditLabel : `${formatDealerDisplay(selectedDealer)} · No active audit`, Boolean(matchingAudit));
      setLivePill('pairingConnectionStatus', matchingAudit ? 'Ready' : 'No active audit', Boolean(matchingAudit));
      setDashboardKpiValue('dashActiveAuditDealer', matchingAudit ? auditLabel : formatDealerDisplay(selectedDealer));
      setText('pairingActiveAudit', matchingAudit ? auditLabel : `${formatDealerDisplay(selectedDealer)} · No active audit`);
      setText('pairingStatusText', matchingAudit ? 'Mobile sync enabled' : 'Mobile sync disabled');
      setText('sideActiveAuditDealer', formatDealerDisplay(selectedDealer));
      setText('sideActiveAuditStatus', matchingAudit ? `Audit ${matchingAudit.auditId} · ${matchingAudit.auditStatus || 'ACTIVE'}` : 'No active audit');
    } else if (audit && audit.dealerCode) {
      setLivePill('activeAuditBadge', auditLabel, true);
      setLivePill('pairingConnectionStatus', 'Ready', true);
      setDashboardKpiValue('dashActiveAuditDealer', formatDealerDisplay(audit));
      setText('pairingActiveAudit', auditLabel);
      setText('pairingStatusText', 'Mobile sync enabled');
      setText('sideActiveAuditDealer', formatDealerDisplay(audit));
      setText('sideActiveAuditStatus', `Audit ${audit.auditId} · ${audit.auditStatus || 'ACTIVE'}`);
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
      setText('sideActiveAuditDealer', 'No active audit');
      setText('sideActiveAuditStatus', 'Mobile sync disabled');
    }
    updateDashboardScopeSummary();
    syncLocalPartFormIdentity();
    restoreManualScanBin();
    updateAuditPriceRefreshUi();
  }

  async function loadActiveAudit(options = {}) {
    try {
      const dealerCode = cleanDealerCode(options.dealerCode || dashboardScopeDealerCode() || activeDealerId());
      if (!dealerCode) {
        state.activeAudit = null;
        updateActiveAuditUi();
        return null;
      }
      const data = await api(`/api/audit/active?dealerCode=${encodeURIComponent(dealerCode)}`);
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

  function localPartUserName() {
    return state.user ? state.user.name || state.user.username || state.user.email || '' : '';
  }

  function localPartSelectedDealer(form = $('#localPartForm')) {
    return cleanDealerCode($('[name="dealerCode"]', form)?.value || selectedScanDealerCode() || currentDealerCode());
  }

  function localPartReferenceAuditId(dealerCode = localPartSelectedDealer()) {
    const code = cleanDealerCode(dealerCode);
    if (state.activeAudit && cleanDealerCode(state.activeAudit.dealerCode) === code) return clean(state.activeAudit.auditId || '');
    const dealer = dealerByCode(code);
    return clean(dealer && (dealer.currentAuditId || dealer.auditId) || '');
  }

  function syncLocalPartFormIdentity() {
    const form = $('#localPartForm');
    if (!form) return;
    const dealerCode = localPartSelectedDealer(form);
    const referenceField = $('[name="referenceAuditId"]', form);
    const enteredByField = $('[name="enteredByName"]', form);
    if (referenceField) referenceField.value = localPartReferenceAuditId(dealerCode);
    if (enteredByField) enteredByField.value = localPartUserName();
  }

  function resetLocalPartForm(options = {}) {
    const form = $('#localPartForm');
    if (!form) return;
    const dealerCode = options.dealerCode || localPartSelectedDealer(form) || selectedScanDealerCode() || currentDealerCode();
    form.reset();
    state.localPartEditingId = '';
    $('[name="id"]', form).value = '';
    $('[name="quantity"]', form).value = '1.000';
    if (dealerCode) setDealerSelectValue($('[name="dealerCode"]', form), dealerCode);
    syncLocalPartFormIdentity();
    const button = $('#localPartSaveBtn');
    if (button) button.textContent = 'Save Local Part';
    const message = $('#localPartFormMessage');
    if (message && options.keepMessage !== true) {
      message.className = 'form-message';
      message.textContent = '';
    }
  }

  function localPartHistoryQuery(page = state.localPartPage || 1) {
    const form = $('#localPartHistoryFilters');
    const values = form ? formObject(form) : {};
    const params = new URLSearchParams();
    const dealerCode = cleanDealerCode(values.dealerCode || localPartSelectedDealer());
    if (dealerCode && dealerCode !== 'ALL') params.set('dealerCode', dealerCode);
    ['fromDate', 'toDate', 'partNumber', 'userName', 'status'].forEach((key) => {
      const value = clean(values[key]);
      if (value) params.set(key, value);
    });
    params.set('page', String(Math.max(1, Number(page || 1))));
    params.set('limit', '25');
    params.set('sortBy', 'createdAt');
    params.set('sortDir', 'desc');
    return params;
  }

  function localPartQuantity(value) {
    const number = Number(value || 0);
    return Number.isFinite(number) ? number.toFixed(3) : '0.000';
  }

  function renderLocalPartHistory(data = {}) {
    const rows = Array.isArray(data.entries) ? data.entries : [];
    state.localPartRows = rows;
    state.localPartPage = Number(data.pagination?.page || 1);
    state.localPartTotalPages = Number(data.pagination?.totalPages || 1);
    state.localPartHistoryLoaded = true;
    const canManage = isAdminUser();
    $('#localPartHistoryRows').innerHTML = rows.map((row) => `
      <tr data-local-part-id="${escapeHtml(row.id)}">
        <td>${escapeHtml(row.entryDate || '')}</td>
        <td>${escapeHtml(row.entryTime || '')}</td>
        <td>${escapeHtml(row.dealerCode || '')}</td>
        <td>${escapeHtml(row.referenceAuditId || '-')}</td>
        <td>${escapeHtml(row.partNumber || '')}</td>
        <td>${escapeHtml(row.partDescription || '')}</td>
        <td data-type="number">${escapeHtml(localPartQuantity(row.quantity))}</td>
        <td data-type="number">${escapeHtml(money2(row.mrp))}</td>
        <td data-type="number">${escapeHtml(money2(row.totalMrpValue))}</td>
        <td data-type="number">${escapeHtml(money2(row.dlc))}</td>
        <td data-type="number">${escapeHtml(money2(row.totalDlcValue))}</td>
        <td>${escapeHtml(row.enteredByName || '')}</td>
        <td>${escapeHtml(row.remarks || '')}</td>
        <td><span class="status-pill ${row.status === 'DELETED' ? 'danger' : 'success'}">${escapeHtml(row.status || 'ACTIVE')}</span></td>
        <td>${canManage && row.status !== 'DELETED' ? `<button class="btn light local-part-edit" type="button" data-id="${escapeHtml(row.id)}">Edit</button>` : '-'}</td>
        <td>${canManage && row.status !== 'DELETED' ? `<button class="btn danger-soft local-part-delete" type="button" data-id="${escapeHtml(row.id)}">Delete</button>` : '-'}</td>
      </tr>
    `).join('') || '<tr><td colspan="16" class="muted">No Local Part entries found for selected filter</td></tr>';
    const summary = data.summary || {};
    setText('localPartTotalQuantity', localPartQuantity(summary.grandTotalQuantity));
    setText('localPartTotalMrpValue', money2(summary.grandTotalMrpValue || 0));
    setText('localPartTotalDlcValue', money2(summary.grandTotalDlcValue || 0));
    setText('localPartPageInfo', `Page ${state.localPartPage} of ${state.localPartTotalPages}`);
    $('#localPartPrevPage').disabled = state.localPartPage <= 1;
    $('#localPartNextPage').disabled = state.localPartPage >= state.localPartTotalPages;
    enhanceDataTable($('#localPartHistoryTable'), 'daksh_table_local_part_history');
  }

  async function loadLocalPartHistory(options = {}) {
    const page = Math.max(1, Number(options.page || state.localPartPage || 1));
    const data = await api(`/api/local-parts?${localPartHistoryQuery(page).toString()}`);
    renderLocalPartHistory(data);
    return data;
  }

  function markLocalPartsReportStale() {
    state.localPartsReportStale = true;
    Array.from(state.reportCache.keys()).forEach((key) => {
      if (String(key).startsWith('local-parts|')) state.reportCache.delete(key);
    });
  }

  async function refreshLocalPartsReportIfVisible() {
    if (!$('#reports')?.classList.contains('active') || activeReportType() !== 'local-parts') return;
    await loadReport({ forceRefresh: true, showLoading: false });
  }

  function localPartPayload(form) {
    const values = formObject(form);
    return {
      dealerCode: cleanDealerCode(values.dealerCode),
      partNumber: clean(values.partNumber).toUpperCase(),
      quantity: clean(values.quantity),
      mrp: clean(values.mrp),
      dlc: clean(values.dlc),
      partDescription: clean(values.partDescription),
      remarks: clean(values.remarks)
    };
  }

  async function saveLocalPart(form) {
    const payload = localPartPayload(form);
    const editingId = state.localPartEditingId || clean($('[name="id"]', form)?.value);
    const message = $('#localPartFormMessage');
    if (message) {
      message.className = 'form-message loading';
      message.textContent = editingId ? 'Updating Local Part...' : 'Saving Local Part...';
    }
    setScanFormSubmitting(form, true);
    try {
      const data = await api(editingId ? `/api/local-parts/${encodeURIComponent(editingId)}` : '/api/local-parts', {
        method: editingId ? 'PUT' : 'POST',
        body: payload
      });
      if (message) {
        message.className = 'form-message success';
        message.textContent = data.message || (editingId ? 'Local Part updated' : 'Local Part saved');
      }
      const dealerCode = payload.dealerCode;
      markLocalPartsReportStale();
      resetLocalPartForm({ dealerCode, keepMessage: true });
      const historyDealer = $('#localPartHistoryFilters [name="dealerCode"]');
      if (historyDealer && dealerCode) setDealerSelectValue(historyDealer, dealerCode);
      state.localPartPage = 1;
      await loadLocalPartHistory({ page: 1 });
      await refreshLocalPartsReportIfVisible();
      toast(data.message || 'Local Part saved', 'success');
      return data;
    } finally {
      setScanFormSubmitting(form, false);
      const button = $('#localPartSaveBtn');
      if (button && !state.localPartEditingId) button.textContent = 'Save Local Part';
    }
  }

  async function editLocalPart(id) {
    const data = await api(`/api/local-parts/${encodeURIComponent(id)}`);
    const entry = data.entry || {};
    const form = $('#localPartForm');
    state.localPartEditingId = entry.id || id;
    $('[name="id"]', form).value = state.localPartEditingId;
    setDealerSelectValue($('[name="dealerCode"]', form), entry.dealerCode || '');
    $('[name="referenceAuditId"]', form).value = entry.referenceAuditId || '';
    $('[name="partNumber"]', form).value = entry.partNumber || '';
    $('[name="quantity"]', form).value = localPartQuantity(entry.quantity);
    $('[name="mrp"]', form).value = Number(entry.mrp || 0).toFixed(2);
    $('[name="dlc"]', form).value = Number(entry.dlc || 0).toFixed(2);
    $('[name="partDescription"]', form).value = entry.partDescription || '';
    $('[name="remarks"]', form).value = entry.remarks || '';
    $('[name="enteredByName"]', form).value = entry.enteredByName || localPartUserName();
    $('#localPartSaveBtn').textContent = 'Update Local Part';
    $('#localPartFormMessage').className = 'form-message';
    $('#localPartFormMessage').textContent = 'Editing Local Part entry';
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function deleteLocalPart(id) {
    const row = state.localPartRows.find((entry) => entry.id === id);
    const label = row ? `${row.partNumber} (${row.quantity})` : 'this Local Part entry';
    if (!window.confirm(`Delete ${label}? This will keep a traceable soft-deleted record.`)) return;
    const data = await api(`/api/local-parts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    markLocalPartsReportStale();
    if (state.localPartEditingId === id) resetLocalPartForm();
    await loadLocalPartHistory({ page: state.localPartPage });
    await refreshLocalPartsReportIfVisible();
    toast(data.message || 'Local Part deleted', 'success');
  }

  function resolveMobileScannerUrl(info = {}) {
    const serverUrl = info.serverUrl || (info.ip && info.port ? `http://${info.ip}:${info.port}` : '');
    if (info.mobileWebUrl) return info.mobileWebUrl;
    if (info.mobileScannerUrl) return info.mobileScannerUrl;
    if (info.scanUrl) return info.scanUrl;
    if (serverUrl) return `${String(serverUrl).replace(/\/+$/, '')}/mobile-web`;
    return `${window.location.origin.replace(/\/+$/, '')}/mobile-web`;
  }

  function dashboardWelcomeText() {
    return `Welcome back, ${roleDisplayName(state.user && state.user.role)}`;
  }

  function updateSystemSubline() {
    const node = $('#systemSubline');
    if (!node) return;
    if ($('#dashboard')?.classList.contains('active')) {
      node.textContent = dashboardWelcomeText();
      return;
    }
    const mobileScannerUrl = resolveMobileScannerUrl(state.serverInfo || {});
    node.textContent = mobileScannerUrl ? `Mobile scanner: ${mobileScannerUrl}` : '';
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
    updateSystemSubline();
  }

  function setDashboardHealthRow(name, label, stateName = 'ok') {
    setDashboardKpiValue(`dashboardHealth${name}`, label);
    const row = $(`#dashboardHealth${name}Row`);
    if (!row) return;
    row.classList.remove('is-checking', 'is-warning', 'is-error');
    if (stateName === 'checking') row.classList.add('is-checking');
    if (stateName === 'warning') row.classList.add('is-warning');
    if (stateName === 'error') row.classList.add('is-error');
  }

  function updateDashboardHealth(data = {}) {
    const serverStatus = String(data.server || data.serverStatus || '').trim().toLowerCase();
    const databaseStatus = String(data.db || data.database || data.databaseStatus || data.postgresStatus || '').trim().toLowerCase();
    const serverKnown = Boolean(serverStatus);
    const databaseKnown = Boolean(databaseStatus);
    const serverOk = ['online', 'ok', 'ready', 'connected'].includes(serverStatus);
    const databaseOk = ['connected', 'online', 'ok', 'ready'].includes(databaseStatus);
    const connectedDevices = Math.max(0, Number(data.connectedDevices ?? data.mobileConnectedDevices ?? state.activeDeviceCount ?? 0) || 0);
    const pending = Math.max(0, Number(data.pending ?? data.pendingSync ?? 0) || 0);
    const failed = Math.max(0, Number(data.failed ?? data.failedSync ?? 0) || 0);
    const storageStatus = String(data.storageStatus || (data.storage && data.storage.status) || '').trim().toLowerCase();

    setDashboardHealthRow('Server', serverKnown ? (serverOk ? 'Online' : 'Offline') : 'Checking', serverKnown ? (serverOk ? 'ok' : 'error') : 'checking');
    setDashboardHealthRow('Database', databaseKnown ? (databaseOk ? 'Online' : 'Offline') : 'Checking', databaseKnown ? (databaseOk ? 'ok' : 'error') : 'checking');
    setDashboardHealthRow('Scanner', serverKnown ? (serverOk ? (connectedDevices ? `${wholeNumber(connectedDevices)} Online` : 'Ready') : 'Offline') : 'Checking', serverKnown ? (serverOk ? 'ok' : 'error') : 'checking');
    setDashboardHealthRow('Sync', failed ? `${wholeNumber(failed)} Failed` : (pending ? `${wholeNumber(pending)} Pending` : 'Healthy'), failed ? 'error' : (pending ? 'warning' : 'ok'));
    setDashboardHealthRow('Storage', storageStatus ? ({ normal: 'Normal', warning: 'Low', low: 'Critical', unavailable: 'Unavailable' }[storageStatus] || storageStatus) : 'Checking', !storageStatus ? 'checking' : (storageStatus === 'normal' ? 'ok' : (storageStatus === 'warning' || storageStatus === 'unavailable' ? 'warning' : 'error')));

    const pageStatus = $('#dashboardPageStatus');
    const known = serverKnown && databaseKnown;
    const operational = known && serverOk && databaseOk && !failed && storageStatus !== 'low';
    if (pageStatus) {
      pageStatus.classList.toggle('is-checking', !known);
      pageStatus.classList.toggle('is-degraded', known && !operational);
    }
    setText('dashboardPageStatusText', !known ? 'Checking system' : (operational ? 'System Operational' : 'System Needs Attention'));
  }

  async function loadHealth() {
    const data = await api('/api/health');
    applyServerInfo(data);
    updateDashboardHealth(data);
    const serverOk = data.server === 'online';
    const dbOk = data.db === 'connected';
    setLivePill('syncServerStatus', serverOk ? 'Connected' : 'Offline', serverOk);
    setLivePill('syncDatabaseStatus', dbOk ? 'Connected' : 'Offline', dbOk);
    setDashboardSyncStatus(serverOk && dbOk ? 'Synced' : 'Failed', serverOk && dbOk);
    if (!serverOk || !dbOk) throw new Error('Server or PostgreSQL is not connected');
    if (isLocalhostUrl(data.serverUrl)) {
      throw new Error('Use automatic discovery, daksh.local, or the temporary pairing QR for mobile.');
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
    const raw = String(payload.rawScan || payload.rawScanString || payload.rawBarcode || payload.rawQR || payload.rawUpi || payload.scanText || '');
    if (raw) {
      const parser = window && window.DakshScanParser ? window.DakshScanParser : null;
      const parsed = parser ? parser.parseScanValue(raw) : null;
      if (parsed && parsed.type === 'UPI' && parsed.upiId) return normalizePartText(parsed.upiId).split('::')[0];
      const match = raw.match(/(?:upi|upid|upiid|txn|txnid|transaction|scanid)\s*[:=#-]?\s*([a-z0-9._/-]+)/i);
      if (match) return match[1].trim().toUpperCase().split('::')[0];
    }
    const direct = payload.upiCode || payload.upiNo || payload.upiId || payload.upiID || payload.upiScanId || payload.transactionId || payload.txnId;
    const value = String(direct || '').trim().toUpperCase().split('::')[0];
    const part = normalizePartText(payload.partNumber || payload.part || payload.normalizedPartNumber || '');
    if (!value || (part && value === part)) return '';
    return value;
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
    if (scan.barcodeIdentityKind === 'SKU' || window.DakshScanParser?.parseHeroSkuLabel(scan.rawScan || scan.rawScanString || '')) return '';
    const dealerCode = cleanDealerCode(scan.dealerCode || currentDealerCode() || '');
    const partNumber = normalizePartText(scan.partNumber || scan.part || scan.normalizedPartNumber || '');
    const auditId = String(scan.auditId || activeAuditIdForScope() || '').trim();
    const upiId = normalizePartText(extractUpiIdFromText(scan) || scan.upiId || scan.upiNo || '');
    const raw = normalizePartText(scan.rawScan || scan.rawScanString || scan.rawBarcode || scan.rawScanValue || scan.barcodeValue || scan.scanText || '');
    if (upiId) return ['UPI', upiId].join('|');
    if (/^MANUAL[:|#-]/i.test(String(scan.rawScan || scan.rawScanString || ''))) return '';
    if (raw && raw !== partNumber) return ['RAW', raw].join('|');
    const id = cleanId(scan.id || scan._id || scan.uniqueScanId || scan.scanId || scan.syncKey || scan.localId || scan.uniqueLocalId || '');
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
    void existing;
    return 'This QR code is already scanned.';
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
    const explicit = scan._id || scan.scanId || scan.uniqueScanId || scan.localId || scan.rowId || scan.id || scan.syncKey || '';
    if (explicit) return explicit;
    return normalizePartText(scan.rawScan || scan.rawScanString || scan.rawBarcode || scan.rawScanValue || '');
  }

  function scanHistoryRecordId(scan = {}) {
    const explicit = scan._id || scan.scanId || scan.uniqueScanId || scan.localId || scan.rowId || scan.id || '';
    return String(explicit || '').trim();
  }

  function scanHistoryRecordIdentity(scan = {}) {
    const id = scanHistoryRecordId(scan);
    return {
      key: scanHistoryRecordKey(scan),
      barcodeKey: barcodeScanKey(scan),
      id,
      scanId: String(scan.scanId || scan.uniqueScanId || scan._id || '').trim(),
      uniqueScanId: String(scan.uniqueScanId || scan.scanId || scan._id || '').trim(),
      syncKey: String(scan.syncKey || '').trim(),
      localId: String(scan.localId || '').trim()
    };
  }

  function scanHistoryRecordMatches(candidate = {}, reference = {}) {
    const left = scanHistoryRecordIdentity(candidate);
    const right = scanHistoryRecordIdentity(reference);
    if (left.key && right.key && left.key === right.key) return true;
    if (left.barcodeKey && right.barcodeKey && left.barcodeKey === right.barcodeKey) return true;
    if (left.scanId && right.scanId && left.scanId === right.scanId) return true;
    if (left.uniqueScanId && right.uniqueScanId && left.uniqueScanId === right.uniqueScanId) return true;
    if (left.id && right.id && left.id === right.id) return true;
    if (left.syncKey && right.syncKey && left.syncKey === right.syncKey) return true;
    if (left.localId && right.localId && left.localId === right.localId) return true;
    return false;
  }

  function scanHistoryRecordAlreadyVisible(scan = {}) {
    const key = scanHistoryRecordKey(scan);
    if (!key) return false;
    return (state.scanHistoryRecords || []).some((item) => scanHistoryRecordKey(item) === key);
  }

  function removeScanHistoryRecords(scans = []) {
    const references = (Array.isArray(scans) ? scans : [scans]).filter(Boolean);
    if (!references.length) return { queueDeleted: 0, logDeleted: 0, historyDeleted: 0, streamDeleted: 0 };
    const matches = (record = {}) => references.some((reference) => scanHistoryRecordMatches(record, reference));
    const beforeQueue = getSyncQueue();
    const beforeLog = getSyncLog();
    const nextQueue = beforeQueue.filter((record) => !matches(record));
    const nextLog = beforeLog.filter((record) => !matches(record));
    saveSyncQueue(nextQueue);
    writeJsonStorage(scopedStorageKey(SYNC_LOG_KEY), nextLog);
    renderSyncLog();

    const beforeHistory = state.scanHistoryRecords || [];
    const beforeStream = state.scanStreamRecords || [];
    state.scanHistoryRecords = sortScanHistoryRecords(beforeHistory.filter((record) => !matches(record))).slice(0, 500);
    state.scanStreamRecords = beforeStream.filter((record) => !matches(record)).slice(0, 12);

    const historyBody = $('#scanHistoryRows');
    if (historyBody) {
      renderScanHistoryRecords(state.scanHistoryRecords, scanHistorySummary(state.scanHistoryRecords, {}));
    }
    renderScanStream(state.scanStreamRecords);

    return {
      queueDeleted: beforeQueue.length - nextQueue.length,
      logDeleted: beforeLog.length - nextLog.length,
      historyDeleted: beforeHistory.length - state.scanHistoryRecords.length,
      streamDeleted: beforeStream.length - state.scanStreamRecords.length
    };
  }

  function localQueuedScanHistoryRecords() {
    return [];
  }

  function localQueuedStreamRecords() {
    return [];
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

  function smartBinScanDecision(scan = {}) {
    return String(scan.smartBinDecision || scan.smartBinAction || scan.smartBinOverride || '').trim().toUpperCase();
  }

  function smartBinDecisionAllowsNewBin(scan = {}) {
    return ['SAVE_NEW_BIN', 'CONTINUE_NEW', 'ADD_ADDITIONAL'].includes(smartBinScanDecision(scan));
  }

  function smartBinDecisionUsesExistingBin(scan = {}) {
    return ['USE_EXISTING', 'USE_EXISTING_BIN'].includes(smartBinScanDecision(scan));
  }

  function smartBinRowCounted(row = {}) {
    const status = String(row.syncStatus || row.localStatus || row.status || '').trim().toLowerCase();
    if (['duplicate', 'failed-duplicate', 'failed', 'invalid', 'deleted', 'rejected'].includes(status)) return false;
    if (row.deletedAt || row.activeInventory === false) return false;
    const scanType = String(row.scanType || row.type || row.movementType || 'INWARD').trim().toUpperCase();
    if (!['INWARD', 'AUDIT', 'DAMAGE'].includes(scanType)) return false;
    return Number(row.qty ?? row.quantity ?? 1) > 0;
  }

  function localSmartBinSuggestion(scan = {}) {
    const partNumber = normalizePartText(scan.partNumber || scan.part || scan.normalizedPartNumber || '');
    const currentBin = cleanDealerCode(scan.binLocation || scan.bin || '');
    const dealerCode = cleanDealerCode(scan.dealerCode || currentDealerCode() || '');
    const auditId = String(scan.auditId || activeAuditIdForScope() || '').trim();
    if (!partNumber || !currentBin || !dealerCode || !auditId) return null;
    const currentKey = barcodeScanKey(scan);
    const rows = getSyncQueue()
      .concat(state.scanHistoryRecords || [])
      .concat(state.scanStreamRecords || []);
    const bins = new Map();
    rows.forEach((row) => {
      if (!smartBinRowCounted(row)) return;
      if (dealerCode && cleanDealerCode(row.dealerCode || row.dealer || '') !== dealerCode) return;
      if (auditId && String(row.auditId || row.audit || '').trim() !== auditId) return;
      if (normalizePartText(row.partNumber || row.part || row.normalizedPartNumber || '') !== partNumber) return;
      if (currentKey && barcodeScanKey(row) === currentKey) return;
      const rowBin = cleanDealerCode(row.binLocation || row.bin || '');
      if (!rowBin || rowBin === currentBin) return;
      const qty = Math.abs(Number(row.qty ?? row.quantity ?? 1) || 1);
      const existing = bins.get(rowBin) || {
        binLocation: rowBin,
        qty: 0,
        locationType: 'SECONDARY',
        partDescription: row.partDescription || row.partName || row.description || '',
        lastScanDate: row.timestamp || row.scanTime || row.createdAt || '',
        createdBy: row.userName || row.staffName || row.loginId || ''
      };
      existing.qty += qty;
      bins.set(rowBin, existing);
    });
    const existingBins = Array.from(bins.values())
      .sort((left, right) => Number(right.qty || 0) - Number(left.qty || 0) || String(left.binLocation).localeCompare(String(right.binLocation), undefined, { numeric: true, sensitivity: 'base' }))
      .map((row, index) => ({ ...row, locationType: index === 0 ? 'PRIMARY' : 'SECONDARY' }));
    if (!existingBins.length) return null;
    const existingBin = existingBins[0].binLocation;
    const existingBinText = existingBins.map((row) => row.binLocation).join(', ');
    return {
      success: true,
      shouldPrompt: true,
      promptTitle: 'PART ALREADY AVAILABLE IN OTHER BIN',
      dealerCode,
      auditId,
      partNumber,
      partDescription: existingBins.find((row) => row.partDescription)?.partDescription || scan.partDescription || scan.partName || '',
      currentBin,
      newBin: currentBin,
      existingBin,
      suggestedBin: existingBin,
      primaryBin: existingBin,
      existingBins,
      existingBinCount: existingBins.length,
      totalQty: existingBins.reduce((sum, row) => sum + Number(row.qty || 0), 0),
      sameBinExists: false,
      allowMultipleLocations: state.smartBinSettings?.allowMultipleLocations === undefined ? true : Boolean(state.smartBinSettings.allowMultipleLocations),
      reasonRequired: Boolean(state.smartBinSettings?.requireReason ?? true),
      maxAllowedLocationsPerPart: Math.max(1, Number.parseInt(String(state.smartBinSettings?.maxAllowedLocationsPerPart || 3), 10) || 3),
      message: `PART ${partNumber} IS AVAILABLE IN BIN ${existingBinText}\n\nWill you continue scanning in ${existingBinText} or continue with ${currentBin}?`
    };
  }

  function applySmartBinDecisionToScan(scan = {}, suggestion = {}, decision = {}, options = {}) {
    const action = String(decision.action || scan.smartBinDecision || '').trim().toUpperCase();
    const currentBin = cleanDealerCode(decision.currentBin || suggestion.currentBin || scan.binLocation || scan.bin || '');
    const selectedBin = cleanDealerCode(decision.selectedBin || suggestion.suggestedBin || suggestion.existingBin || currentBin || '');
    const finalBin = smartBinDecisionUsesExistingBin({ smartBinDecision: action }) && selectedBin ? selectedBin : currentBin;
    const existingBins = Array.isArray(decision.existingBins)
      ? decision.existingBins
      : (Array.isArray(suggestion.existingBins) ? suggestion.existingBins : []);
    const decisionAt = String(decision.decisionAt || new Date().toISOString());
    const checkedAt = String(decision.checkedAt || suggestion.checkedAt || new Date().toISOString());
    const decisionBy = String(decision.decisionBy || state.user?.name || state.user?.username || state.user?.email || '').trim();
    scan.smartBinEnabled = true;
    scan.smartBinSuggestedBin = cleanDealerCode(decision.suggestedBin || suggestion.suggestedBin || suggestion.existingBin || finalBin || currentBin || '');
    scan.smartBinCurrentBin = currentBin;
    scan.smartBinSelectedBin = finalBin || selectedBin || currentBin;
    scan.smartBinExistingBins = existingBins;
    scan.smartBinAllowMultipleLocations = suggestion.allowMultipleLocations === undefined ? true : Boolean(suggestion.allowMultipleLocations);
    scan.smartBinMaxAllowedLocationsPerPart = Math.max(1, Number.parseInt(String(suggestion.maxAllowedLocationsPerPart || 3), 10) || 3);
    scan.smartBinReasonRequired = options.reasonRequired === undefined
      ? (suggestion.reasonRequired === undefined ? true : Boolean(suggestion.reasonRequired))
      : Boolean(options.reasonRequired);
    scan.smartBinDecision = action;
    scan.smartBinReason = action === 'SAVE_NEW_BIN'
      ? 'User confirmed different bin'
      : String(decision.reason || 'User selected existing bin').trim();
    scan.smartBinCheckedAt = checkedAt;
    scan.smartBinDecisionAt = decisionAt;
    scan.smartBinDecisionBy = decisionBy;
    scan.smartBinLocationType = action === 'SAVE_NEW_BIN' ? 'SECONDARY' : 'PRIMARY';
    scan.smartBinIsSecondaryLocation = action === 'SAVE_NEW_BIN';
    scan.allowCrossBinDuplicate = scan.smartBinIsSecondaryLocation || Boolean(scan.allowCrossBinDuplicate);
    scan.smartBinAuditTrail = {
      enabled: true,
      decision: scan.smartBinDecision,
      reason: scan.smartBinReason,
      suggestedBin: scan.smartBinSuggestedBin,
      selectedBin: scan.smartBinSelectedBin,
      currentBin: scan.smartBinCurrentBin,
      existingBins: scan.smartBinExistingBins,
      allowMultipleLocations: scan.smartBinAllowMultipleLocations,
      maxAllowedLocationsPerPart: scan.smartBinMaxAllowedLocationsPerPart,
      reasonRequired: scan.smartBinReasonRequired,
      checkedAt,
      decisionAt,
      decisionBy,
      locationType: scan.smartBinLocationType,
      isSecondaryLocation: scan.smartBinIsSecondaryLocation
    };
    if (smartBinDecisionUsesExistingBin(scan) && finalBin) {
      scan.binLocation = finalBin;
      scan.bin = finalBin;
    }
    return scan;
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
    state.scanHistoryRecords = sortScanHistoryRecords(mergeScanHistoryRecords(replace(state.scanHistoryRecords || []))).slice(0, 500);
    state.scanStreamRecords = mergeScanStreamRecords(replace(state.scanStreamRecords || []));
    const historyBody = $('#scanHistoryRows');
    if (historyBody) {
      renderScanHistoryRecords(state.scanHistoryRecords, scanHistorySummary(state.scanHistoryRecords, {}));
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
    const parser = window && window.DakshScanParser ? window.DakshScanParser : null;
    const parsed = parser ? parser.parseScanValue(raw) : null;
    if (parsed && ['UPI', 'HERO_SKU_LABEL'].includes(parsed.type) && parsed.partNumber) {
      return {
        upiId: normalizePartText(parsed.upiId || ''),
        partNumber: normalizePartText(parsed.partNumber),
        qty: parsed.quantity || 1,
        qtyProvided: Boolean(parsed.rawQuantity),
        mrp: undefined,
        mrpProvided: false,
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

  function partMasterLookupKey(partNumber = '', dealerCode = currentDealerCode()) {
    return [cleanDealerCode(dealerCode || ''), normalizePartText(partNumber || '')].join('|');
  }

  function masterPartFromValidation(data = {}, fallbackPart = '') {
    const partNumber = normalizePartText(data.partNumber || fallbackPart);
    const mrp = optionalScanNumber(data.mrp);
    const dlc = optionalScanNumber(data.dlc);
    return {
      partNumber,
      part: partNumber,
      partName: data.partDescription || data.partName || '',
      partDescription: data.partDescription || data.partName || '',
      category: data.category || data.productCategory || '',
      productCategory: data.productCategory || data.category || '',
      mrp,
      dlc,
      currentCatalogueMRP: mrp,
      currentCatalogueDLC: dlc,
      masterFound: true,
      masterMatch: true,
      isMasterMatched: true
    };
  }

  async function validatePartAgainstMaster(partNumber = '', dealerCode = currentDealerCode()) {
    const normalizedPart = normalizePartText(partNumber);
    if (!validPartText(normalizedPart)) {
      throw new Error('Invalid part number format');
    }
    const key = partMasterLookupKey(normalizedPart, dealerCode);
    if (!key) return null;
    if (state.partMasterLookupCache.has(key)) return state.partMasterLookupCache.get(key);
    if (state.partMasterLookupPromise.has(key)) return state.partMasterLookupPromise.get(key);
    const promise = api(`/api/mobile/validate-part?${new URLSearchParams({
      partNumber: normalizedPart,
      dealerCode: cleanDealerCode(dealerCode || currentDealerCode() || '')
    }).toString()}`, { timeoutMs: 15000 })
      .then((data) => {
        const master = data && data.found ? masterPartFromValidation(data, normalizedPart) : null;
        state.partMasterLookupCache.set(key, master);
        return master;
      })
      .catch((error) => {
        state.partMasterLookupCache.delete(key);
        throw error;
      })
      .finally(() => {
        state.partMasterLookupPromise.delete(key);
      });
    state.partMasterLookupPromise.set(key, promise);
    return promise;
  }

  function optionalScanNumber(value) {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = Number(String(value).replace(/,/g, '').trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  function normalizeScanPayload(payload) {
    if (payload.serverUrl && isLocalhostUrl(payload.serverUrl)) {
      throw new Error('Use automatic discovery, daksh.local, or the temporary pairing QR for mobile.');
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
      allowCrossBinDuplicate: Boolean(payload.allowCrossBinDuplicate),
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
    normalized.uniqueLocalId = payload.uniqueLocalId || payload.localId || payload.scanId || payload.uniqueScanId || normalized.uniqueScanId;
    return normalized;
  }

  function enqueueScan(payload, errorMessage = 'Saved locally. Sync will retry automatically.') {
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
      const uniqueLocalId = normalized.uniqueLocalId || normalized.localId || normalized.scanId || normalized.uniqueScanId || `LOCAL-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      queuedRecord = {
        ...normalized,
        uniqueLocalId,
        localId: normalized.localId || uniqueLocalId,
        synced: false,
        isSynced: false,
        syncStatus: 'pending',
        localStatus: 'pending',
        retryCount: 0,
        syncError: errorMessage
      };
      queuedRecord.scanId = queuedRecord.scanId || queuedRecord.localId;
      queuedRecord.uniqueScanId = queuedRecord.uniqueScanId || queuedRecord.localId;
      queuedRecord.uniqueLocalId = queuedRecord.uniqueLocalId || queuedRecord.localId;
      queue.push(queuedRecord);
      saveSyncQueue(queue);
    } else {
      return { ...normalized, queueAdded: false, queueDuplicate: true, existingLocalScan: exists };
    }
    addSyncLog({
      partNumber: normalized.partNumber,
      upiId: normalized.upiId,
      dealer: normalized.dealerCode,
      status: 'pending',
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
    const decision = smartBinScanDecision(scan);
    const key = [
      barcodeScanKey(scan) || clean(scan.syncKey || scan.localId || ''),
      decision,
      cleanDealerCode(scan.binLocation || scan.bin || '')
    ].filter(Boolean).join('|');
    if (!key) return null;
    if (state.barcodeServerDuplicateChecks.has(key)) return state.barcodeServerDuplicateChecks.get(key);
    const allowSmartBinCrossBin = Boolean(
      scan.allowCrossBinDuplicate ||
      scan.smartBinAllowCrossBinDuplicate ||
      scan.smartBinIsSecondaryLocation ||
      smartBinDecisionAllowsNewBin(scan)
    );
    const duplicatePayload = {
      ...scan,
      allowCrossBinDuplicate: allowSmartBinCrossBin,
      smartBinAllowCrossBinDuplicate: allowSmartBinCrossBin,
      smartBinIsSecondaryLocation: Boolean(scan.smartBinIsSecondaryLocation || smartBinDecisionAllowsNewBin(scan)),
      smartBinDecision: decision
    };
    const promise = api('/api/scans/duplicate-check', {
      method: 'POST',
      body: duplicatePayload
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
    }, 60000);
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
    const offlineDevices = Number(status.offlineDevices ?? connectionStatus.offlineDevices ?? 0);

    const connectionOk = (!serverKnown || serverOnline) && (!databaseKnown || databaseOnline);
    const syncDetail = connectionOk ? (counts.total ? 'Pending' : 'Synced') : 'Failed';
    const syncOk = connectionOk && !counts.total;
    if (serverKnown) setStatusPill('topServerStatus', serverOnline ? 'Server: Connected' : 'Server: Offline', serverOnline ? 'green' : 'red');
    if (serverKnown && databaseKnown) setDashboardSyncStatus(syncDetail, syncOk);
    setHeaderDeviceStatus(connectedDevices);
    setHeaderSyncStatus(syncDetail, syncOk);
    setStatusPill('topPendingStatus', `Pending: ${counts.total}`, counts.total ? 'orange' : 'green');
    setDashboardKpiValue('dashConnectedScanners', wholeNumber(connectedDevices));
    setDashboardKpiValue('dashOfflineDevices', wholeNumber(offlineDevices));
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
    setText('homeFailedSync', counts.failed);
    setDashboardKpiValue('dashboardPendingKpi', wholeNumber(counts.total));
    setDashboardKpiValue('auditPending', wholeNumber(counts.total));
    setDashboardKpiValue('auditFailed', wholeNumber(counts.failed));
    setDashboardKpiValue('auditConnectedScanners', wholeNumber(connectedDevices));
    setDashboardKpiValue('auditOfflineDevices', wholeNumber(offlineDevices));
    updateDashboardHealth({
      ...connectionStatus,
      connectedDevices,
      pending: counts.total,
      failed: counts.failed
    });
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
    queueDashboardRefresh(300);
    if ($('#scan')?.classList.contains('active')) jobs.push(loadScanHistory());
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

  function markReportsStale(reason = 'scan update', options = {}) {
    localStorage.removeItem('dakshReportPreviewCache');
    state.reportCache.clear();
    if (!state.reportHasRun || !activeReportType()) return;
    clearTimeout(state.reportRealtimeTimer);
    const message = $('#reportMessage');
    const reportType = activeReportType();
    if (options.autoRefresh === false) {
      if (message) {
        message.className = 'form-message warning';
        message.textContent = `Report data changed after ${reason}. Click Refresh Now when ready.`;
      }
      return;
    }
    if (state.auditPackInProgress || HEAVY_REPORT_TYPES.has(reportType)) {
      if (message) {
        message.className = 'form-message warning';
        message.textContent = `Report data changed after ${reason}. Click Refresh Now when ready.`;
      }
      return;
    }
    state.reportRealtimeTimer = setTimeout(() => {
      if (!$('#reports')?.classList.contains('active') || state.reportLoading) return;
      if (message) {
        message.className = 'form-message warning';
        message.textContent = `Report data changed after ${reason}. Refreshing automatically...`;
      }
      loadReport({ forceRefresh: true }).catch((error) => toast(error.message, 'error'));
    }, 2500);
  }

  async function loadLatestSyncDebug() {
    const data = await api('/api/sync/debug/latest');
    renderSyncApiResponse(data);
    return data;
  }

  function statusCell(item) {
    const syncStatus = normalizedDisplaySyncStatus(item);
    if (syncStatus) return syncStatusBadge(syncStatus);
    const warnings = (item.warnings || []).map((warning) => /unknown part saved from sync|part does not exist|part not found in master|not found in master/i.test(warning) ? 'Invalid part number - not found in master catalogue' : warning);
    if (warnings.length) return `<span class="status-warn">${escapeHtml(Array.from(new Set(warnings)).join(', '))}</span>`;
    if (item.isMasterMatched === false) return '<span class="status-warn">Invalid part number - not found in master catalogue</span>';
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
      description: 260,
      qty: 70,
      mrp: 100,
      'bin-location': 120,
      'entry-source': 190,
      'device-id': 220,
      status: 120
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
      'total-qty': 90,
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
    const scanHistoryTable = $('#scanHistoryRows')?.closest('table');
    if (!isBarcodeWorkspaceActive()) enhanceDataTable(scanHistoryTable, 'daksh_table_scan_history');
    initScanHistorySorting(scanHistoryTable);
    enhanceDataTable($('#dealerStockPreviewTable'), 'daksh_table_dealer_stock_preview');
    enhanceDataTable($('#localPartHistoryTable'), 'daksh_table_local_part_history');
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
    const role = normalizeUiRole(state.user && state.user.role);
    const isAdmin = ['admin', 'super_admin'].includes(role);
    const limitedRole = ['audit_user', 'mobile_user'].includes(role);
    const canViewReports = state.user?.permissions?.canViewReports !== false;
    const loginName = userLoginName();
    setText('userRoleLabel', roleName);
    setText('userBadge', loginName);
    setText('userDropdownLogin', loginName);
    setText('userDropdownRole', roleName);
    document.body.classList.toggle('restricted-role', limitedRole);
    const masterLink = $('.side-link[data-view="master"]');
    if (masterLink) masterLink.querySelector('span').textContent = limitedRole ? 'Part Search' : 'Master Data';
    if (limitedRole) {
      $$('.master-tab').forEach((node) => {
        const partMaster = node.dataset.masterTab === 'partMasterTab';
        node.classList.toggle('hidden', !partMaster);
        node.classList.toggle('active', partMaster);
        node.setAttribute('aria-selected', String(partMaster));
      });
      $$('.master-tab-panel').forEach((node) => {
        const partMaster = node.id === 'partMasterTab';
        node.hidden = !partMaster;
        node.classList.toggle('hidden', !partMaster);
        node.classList.toggle('active', partMaster);
      });
      const partHeading = $('#partMasterHeading');
      if (partHeading) partHeading.textContent = 'Part Search';
      const partSubheading = $('#partMasterSubheading');
      if (partSubheading) partSubheading.textContent = 'Search the part catalogue for your assigned dealer.';
    }
    const binSequenceTabButton = $('.bin-transfer-tab[data-bin-transfer-tab="binSequenceTab"]');
    if (binSequenceTabButton) binSequenceTabButton.classList.toggle('hidden', limitedRole);
    $$('.admin-only').forEach((node) => node.classList.toggle('hidden', !isAdmin));
    const operationalViews = new Set(['dashboard', 'scan', 'binTransfer', 'reports', 'master']);
    $$('.side-link').forEach((node) => {
      node.classList.toggle('hidden', limitedRole && !operationalViews.has(node.dataset.view));
      if (node.dataset.view === 'reports') node.classList.toggle('hidden', !canViewReports);
    });
    const reportTypeSelect = $('#reportTypeSelect');
    if (reportTypeSelect) {
      const limitedReports = new Set(['bin-wise-stock', 'category-wise-variance-summary']);
      Array.from(reportTypeSelect.options).forEach((option) => {
        if (!option.value) return;
        option.hidden = limitedRole && !limitedReports.has(option.value);
        option.disabled = option.hidden;
      });
      if (limitedRole && !limitedReports.has(reportTypeSelect.value)) {
        reportTypeSelect.value = 'bin-wise-stock';
      }
    }
    ['#reportExcel', '#reportPdf', '#reportPrint', '#downloadCompleteAuditPackBtn'].forEach((selector) => {
      const node = $(selector);
      if (node) node.classList.toggle('hidden', role === 'mobile_user');
    });
    updateSystemSubline();
    const manualStaff = $('#manualStaff');
    if (manualStaff) manualStaff.value = state.user ? state.user.name || state.user.username || '' : '';
    syncLocalPartFormIdentity();
    const barcodeDeviceId = $('#barcodeDeviceId');
    if (barcodeDeviceId) barcodeDeviceId.value = ensureDeviceId();
    const allowUnknownToggle = $('#allowUnknownToggle');
    if (allowUnknownToggle) allowUnknownToggle.checked = storageGet('dakshAllowUnknown') === 'true';
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
      const scanDealers = select.closest('#scan')
        ? realDealers.filter((dealer) => ['ACTIVE', 'IN_PROGRESS'].includes(
          normalizeAuditWorkflowStatus(dealer.auditStatus || dealer.status || 'NONE')
        ))
        : realDealers;
      const firstOption = !isAdminUser()
        ? '<option value="">Select Dealer</option>'
        : (select.closest('#reportFilters') ? '<option value="">Select Dealer</option>' : (['dashboardDealerSelect', 'dashboardAuditDealerSelect'].includes(select.id) ? '<option value="">Select Dealer</option>' : (select.classList.contains('bin-transfer-dealer') || select.id === 'binManagementDealer' || select.closest('#binSequenceTab') || select.closest('#reconciliation')) ? '<option value="">Select Dealer</option>' : '<option value="">All Dealers</option>'));
      select.innerHTML = firstOption + scanDealers.map((dealer) => (
        `<option value="${escapeHtml(dealer.dealerCode)}">${escapeHtml(formatDealerDisplay(dealer))}</option>`
      )).join('');
      const activeDealer = state.activeAudit && state.activeAudit.dealerCode ? cleanDealerCode(state.activeAudit.dealerCode) : '';
      const scopedDealer = activeDealerId();
      const preferred = select.id === 'scanHistoryDealer'
        ? (scopedDealer || activeDealer || selected)
        : select.closest('#reportFilters')
          ? (selected || scopedDealer || activeDealer)
          : ['dashboardDealerSelect', 'dashboardAuditDealerSelect'].includes(select.id)
            ? (cleanDealerCode(state.dashboardDealerCode || '') || scopedDealer || activeDealer || selected)
            : (scopedDealer || selected || (select.classList.contains('bin-transfer-dealer') ? activeDealer : ''));
      select.value = Array.from(select.options).some((option) => option.value === preferred) ? preferred : select.options[0].value;
      syncDealerSelectDisplay(select);
    });
    if (!state.dashboardDealerCode) state.dashboardDealerCode = cleanDealerCode($('#dashboardAuditDealerSelect')?.value || $('#dashboardDealerSelect')?.value || activeDealerId() || '');
    if (state.dashboardDealerCode) ['#dashboardDealerSelect', '#dashboardAuditDealerSelect'].forEach((selector) => {
      const select = $(selector);
      if (select) { setDealerSelectValue(select, state.dashboardDealerCode); syncDealerSelectDisplay(select); }
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
    syncReportDealerAfterDealerRefresh();
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
    setDashboardKpiValue('dashTotalScanQty', wholeNumber(stats.totalScannedQuantity || stats.totalQuantity || stats.partsScanned || stats.totalScanQty || 0));
    setDashboardKpiValue('dashStockValueDlc', `₹ ${money2(stats.actualStockValueDLC || stats.totalScannedValue || 0)}`);
    setDashboardKpiValue('dashboardPhysicalStockQty', wholeNumber(stats.physicalBinStockQty || 0));
    setDashboardKpiValue('dashboardFittedStockQty', wholeNumber(stats.fittedWorkshopQty || 0));
    setDashboardKpiValue('dashboardTotalDealerStockQty', wholeNumber(stats.totalDealerStockQty || 0));
    setDashboardKpiValue('dashDamage', wholeNumber(stats.damageCount || 0));
    setDashboardKpiValue('dashDuplicates', wholeNumber(stats.duplicateCount || 0));
    setDashboardKpiValue('dashMultiBinParts', wholeNumber(stats.multipleBinPartCount || 0));
    setDashboardKpiValue('dashInventoryCount', wholeNumber(stats.totalUniqueScannedParts || stats.totalScanRecords || 0));
    setDashboardKpiValue('dashConnectedScanners', wholeNumber(stats.activeDevices || 0));
    setDashboardKpiValue('dashOfflineDevices', wholeNumber(stats.offlineDevices || 0));
    setDashboardKpiValue('dashboardPendingKpi', wholeNumber(stats.pendingSyncCount || stats.pendingSync || 0));
    const completion = Math.max(0, Math.min(100, Number(stats.auditCompletionPercent ?? stats.completionPercent ?? 0) || 0));
    setText('dashboardCompletionPercent', `${Math.round(completion)}%`);
    const completionRing = $('#dashboardCompletionRing');
    if (completionRing) {
      completionRing.setAttribute('aria-valuenow', String(Math.round(completion)));
      completionRing.style.setProperty('--completion', `${completion}%`);
    }
    setDashboardKpiValue('auditLiveInventory', wholeNumber(stats.totalUniqueScannedParts || stats.totalScanRecords || 0));
    setDashboardKpiValue('auditPending', wholeNumber(stats.pendingSyncCount || stats.pendingSync || 0));
    setDashboardKpiValue('auditFailed', wholeNumber(stats.failedCount || 0));
    setDashboardKpiValue('auditConnectedScanners', wholeNumber(stats.activeDevices || 0));
    setDashboardKpiValue('auditOfflineDevices', wholeNumber(stats.offlineDevices || 0));
    const scannedValue = Number(stats.actualStockValueDLC || stats.totalScannedValue || 0);
    const systemValue = Number(stats.systemStockValue || stats.masterStockValue || stats.totalSystemValue || 0);
    const chartMax = Math.max(systemValue, scannedValue, 1);
    setDashboardKpiValue('dashboardSystemValue', `₹ ${money2(systemValue)}`);
    setDashboardKpiValue('dashboardScannedValue', `₹ ${money2(scannedValue)}`);
    const systemBar = $('#dashboardSystemValueBar');
    const scannedBar = $('#dashboardScannedValueBar');
    if (systemBar) systemBar.style.height = `${systemValue > 0 ? Math.max(4, Math.round((systemValue / chartMax) * 100)) : 0}%`;
    if (scannedBar) scannedBar.style.height = `${scannedValue > 0 ? Math.max(4, Math.round((scannedValue / chartMax) * 100)) : 0}%`;
    setDashboardKpiValue('dashboardDealerStockLineCount', wholeNumber(stats.dealerStockPartLines || stats.uploadedPartLineCount || 0));
    if (stats.activeDevices !== undefined) setHeaderDeviceStatus(Number(stats.activeDevices || 0));
  }

  function dashboardScanSourceText(scan = {}) {
    return [
      scan.source,
      scan.scanSource,
      scan.entryMode,
      scan.entryChannel,
      scan.entrySource,
      scan.scanMode
    ].map((value) => String(value || '').trim()).filter(Boolean).join(' ').toLowerCase();
  }

  function dashboardIsManualScan(scan = {}) {
    return /manual/.test(dashboardScanSourceText(scan)) || /manual/.test(scanEntrySourceLabel(scan));
  }

  function dashboardIsFailedScan(scan = {}) {
    if (normalizedDisplaySyncStatus(scan) === 'failed') return true;
    return /fail|error|rejected/i.test([
      scan.syncStatus,
      scan.status,
      scan.scanStatus,
      scan.errorMessage
    ].map((value) => String(value || '').trim()).filter(Boolean).join(' '));
  }

  function dashboardOverviewBucket(scan = {}) {
    if (dashboardIsFailedScan(scan)) return 'failed';
    if (dashboardIsManualScan(scan)) return 'manual';
    const scanType = String(scan.scanType || scan.type || '').trim().toUpperCase();
    if (scanType === 'OUTWARD') return 'outward';
    return 'inward';
  }

  function dashboardOverviewCounts(stats = {}, scans = []) {
    void scans;
    const toCount = (value) => {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 ? number : 0;
    };
    const distribution = stats.scanTypeDistribution || {};
    const inward = toCount(distribution.inward ?? stats.totalInward);
    const outward = toCount(distribution.outward ?? stats.totalOutward);
    const manual = toCount(distribution.manual ?? stats.manualCount ?? stats.manualScanCount ?? stats.manualScans);
    const damage = toCount(distribution.damage ?? stats.damageCount);
    const fitted = toCount(distribution.fitted ?? stats.fittedCount ?? stats.totalFitted);
    const failed = toCount(stats.failedCount || stats.mismatchCount);
    const total = [
      distribution.total,
      stats.totalScannedQuantity,
      stats.totalQuantity,
      stats.partsScanned,
      stats.totalScanQty,
      stats.totalScanRecords,
      stats.scanRows,
      stats.totalScannedToday
    ].map(toCount).find((value) => value > 0) || (inward + outward + manual + damage + fitted);
    return { inward, outward, manual, damage, fitted, failed, total };
  }

  function renderDashboardQuickOverview(stats = {}, scans = []) {
    const counts = dashboardOverviewCounts(stats, scans);
    const fallbackTotal = Number(String($('#dashTotalScanQty')?.textContent || '').replace(/[^\d.-]/g, '')) || 0;
    if (!counts.total && fallbackTotal > 0) {
      counts.total = fallbackTotal;
    }
    const total = Math.max(0, Number(counts.total || 0));
    const values = [
      ['Inward', 'dashboardDistributionInward', 'dashboardDistributionInwardBar', counts.inward],
      ['Outward', 'dashboardDistributionOutward', 'dashboardDistributionOutwardBar', counts.outward],
      ['Manual', 'dashboardDistributionManual', 'dashboardDistributionManualBar', counts.manual],
      ['Damage', 'dashboardDistributionDamage', 'dashboardDistributionDamageBar', counts.damage],
      ['Fitted', 'dashboardDistributionFitted', 'dashboardDistributionFittedBar', counts.fitted]
    ];
    values.forEach(([, id, barId, value]) => {
      const percent = total > 0 ? Math.round((Number(value || 0) / total) * 100) : 0;
      setText(id, `${wholeNumber(value)} (${percent}%)`);
      const bar = $(`#${barId}`);
      if (bar) bar.style.width = `${Math.min(100, percent)}%`;
    });
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
      partsScanned: Number(summary.netAvailableQuantity ?? summary.partsScanned ?? summary.totalQuantity ?? visibleTotalQty),
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

  const SCAN_HISTORY_SORT_LABELS = {
    time: 'Time',
    partNumber: 'Part Number',
    partDescription: 'Part Description',
    productCategory: 'Product Category',
    mrp: 'MRP',
    dlc: 'DLC',
    productGroup: 'Product Group',
    model: 'Model',
    year: 'Year',
    qty: 'Qty',
    totalQty: 'Total Qty',
    type: 'Type',
    bin: 'Bin',
    dealer: 'Dealer',
    device: 'Device',
    status: 'Status'
  };
  const SCAN_HISTORY_NUMERIC_SORTS = new Set(['time', 'mrp', 'dlc', 'qty', 'totalQty']);
  const SCAN_HISTORY_DESC_FIRST = new Set(['time', 'mrp', 'dlc', 'qty', 'totalQty']);

  function scanHistoryDefaultSort() {
    return { key: 'time', direction: 'desc' };
  }

  function normalizeScanHistorySort(sort = state.scanHistorySort) {
    const fallback = scanHistoryDefaultSort();
    const key = Object.prototype.hasOwnProperty.call(SCAN_HISTORY_SORT_LABELS, sort && sort.key) ? sort.key : fallback.key;
    const direction = String(sort && sort.direction || fallback.direction).toLowerCase() === 'asc' ? 'asc' : 'desc';
    return { key, direction };
  }

  function scanHistoryTimeValue(scan = {}) {
    const value = scan.timestamp || scan.scanTime || scan.createdAt || scan.updatedAt || '';
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : 0;
  }

  function scanHistorySortValue(scan = {}, key = '') {
    switch (key) {
      case 'time':
        return scanHistoryTimeValue(scan);
      case 'partNumber':
        return scanHistoryPartNumber(scan);
      case 'partDescription':
        return scan.partDescription || scan.partName || scan.description || scanHistoryPartNumber(scan);
      case 'productCategory':
        return scan.productCategory || scan.category || '';
      case 'mrp':
        return Number(scan.displayMRP ?? scan.currentCatalogueMRP ?? scan.valuationMRP ?? scan.mrp ?? 0) || 0;
      case 'dlc':
        return Number(scan.currentCatalogueDLC ?? scan.dlc ?? 0) || 0;
      case 'productGroup':
        return scan.productGroup || '';
      case 'model':
        return scan.model || '';
      case 'year':
        return scan.manufacturingYear || scan.year || '';
      case 'qty':
        return Number(scanQuantity(scan, 0)) || 0;
      case 'totalQty':
        return Number(scan.totalQty ?? scan.totalQuantity ?? scanHistoryQuantity(scan, 1)) || 0;
      case 'type':
        return scan.scanType || scan.type || '';
      case 'bin':
        return scan.binLocation || scan.bin || '';
      case 'dealer':
        return scan.dealerName || scan.dealerCode || '';
      case 'device':
        return scan.deviceName || scan.deviceId || '';
      case 'status':
        return normalizedDisplaySyncStatus(scan) || scan.syncStatus || scan.scanStatus || scan.status || '';
      default:
        return '';
    }
  }

  function compareScanHistoryValues(left, right, key) {
    const leftValue = scanHistorySortValue(left, key);
    const rightValue = scanHistorySortValue(right, key);
    if (SCAN_HISTORY_NUMERIC_SORTS.has(key)) {
      return (Number(leftValue) || 0) - (Number(rightValue) || 0);
    }
    return String(leftValue || '').localeCompare(String(rightValue || ''), undefined, {
      numeric: true,
      sensitivity: 'base'
    });
  }

  function sortScanHistoryRecords(records = [], sort = state.scanHistorySort) {
    const sortState = normalizeScanHistorySort(sort);
    state.scanHistorySort = sortState;
    const direction = sortState.direction === 'asc' ? 1 : -1;
    return (Array.isArray(records) ? records : []).slice().sort((left, right) => {
      const primary = compareScanHistoryValues(left, right, sortState.key);
      if (primary !== 0) return primary * direction;
      const timeFallback = scanHistoryTimeValue(right) - scanHistoryTimeValue(left);
      if (timeFallback !== 0) return timeFallback;
      return scanHistoryRecordId(left).localeCompare(scanHistoryRecordId(right), undefined, { numeric: true, sensitivity: 'base' });
    });
  }

  function isBarcodeWorkspaceActive() {
    return Boolean($('#barcodeEntry')?.classList.contains('active'));
  }

  function configureScanHistoryLayout() {
    const table = $('#scanHistoryRows')?.closest('table');
    if (!table?.tHead) return;
    const compact = isBarcodeWorkspaceActive();
    if (!state.scanHistoryFullHeader) state.scanHistoryFullHeader = table.tHead.innerHTML;
    const mode = compact ? 'barcode' : 'full';
    if (table.dataset.workspaceMode !== mode) {
      table.dataset.workspaceMode = mode;
      if (compact) {
        table.querySelector('colgroup')?.remove();
        const columns = [['select', ''], ['row', '#'], ['time', 'Date & Time'], ['type', 'Type'], ['partNumber', 'Part Number'], ['partDescription', 'Description'], ['bin', 'Bin'], ['qty', 'Qty'], ['mrp', 'MRP (₹)'], ['dlc', 'DLC (₹)'], ['regdNo', 'Regd No'], ['jobCardNo', 'Job Card No'], ['device', 'Device'], ['action', 'Action']];
        table.tHead.innerHTML = `<tr>${columns.map(([key, title]) => `<th data-col-key="${key}"${['time', 'type', 'partNumber', 'partDescription', 'bin', 'qty', 'mrp', 'dlc', 'device'].includes(key) ? ` data-sort-key="${key}"` : ''}>${key === 'select' ? '<input id="scanHistorySelectAll" type="checkbox" aria-label="Select all visible scans">' : title}</th>`).join('')}</tr>`;
      } else {
        table.tHead.innerHTML = state.scanHistoryFullHeader;
      }
      table.tHead.querySelector('#scanHistorySelectAll')?.removeAttribute('data-workspace-bound');
    }
    setText('scanHistoryTitle', compact ? 'Recent Scan History' : 'Scan History');
    const filters = $('#scanHistoryFilters');
    const searching = Boolean(filters?.elements.part.value || filters?.elements.bin.value || filters?.elements.type.value);
    setText('scanHistoryScopeBadge', searching || (state.scanHistoryPage || 1) > 1 ? 'Search Results' : 'Last 10 Scans');
    bindScanHistorySelection();
  }

  function bindScanHistorySelection() {
    const checkbox = $('#scanHistorySelectAll');
    if (!checkbox || checkbox.dataset.workspaceBound === 'true') return;
    checkbox.dataset.workspaceBound = 'true';
    checkbox.addEventListener('change', (event) => {
      $$('.scan-history-checkbox').forEach((box) => { box.checked = event.target.checked; });
    });
  }

  function renderScanHistoryRecords(records = state.scanHistoryRecords || [], summary = state.scanHistorySummary || {}) {
    const body = $('#scanHistoryRows');
    if (!body) return;
    configureScanHistoryLayout();
    const rows = (Array.isArray(records) ? records : []).slice(0, isBarcodeWorkspaceActive() ? 10 : 500);
    body.innerHTML = rows.length ? rows.map((scan, index) => scanHistoryRow(scan, index)).join('') : `<tr><td colspan="${isBarcodeWorkspaceActive() ? 14 : 18}" class="muted">No scan history found</td></tr>`;
    updateScanHistorySummary(rows, summary);
    bindScanHistoryActions();
    renderScanHistorySortHeaders();
  }

  function initScanHistorySorting(table = $('#scanHistoryRows')?.closest('table')) {
    if (!table || !table.tHead || !table.tHead.rows.length) return;
    table.classList.add('scan-history-sortable-table');
    Array.from(table.tHead.rows[0].children).forEach((th) => {
      const key = th.dataset.sortKey || '';
      if (!Object.prototype.hasOwnProperty.call(SCAN_HISTORY_SORT_LABELS, key)) return;
      const label = th.dataset.sortLabel || String(th.textContent || SCAN_HISTORY_SORT_LABELS[key]).replace(/\s+/g, ' ').trim();
      th.dataset.sortLabel = label || SCAN_HISTORY_SORT_LABELS[key];
      th.classList.add('scan-history-sortable');
      if (th.querySelector('.scan-history-sort-button')) return;
      const resizer = th.querySelector('.column-resizer');
      Array.from(th.childNodes).forEach((node) => {
        if (node !== resizer) node.remove();
      });
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'scan-history-sort-button';
      button.dataset.sortKey = key;
      button.setAttribute('aria-label', `Sort ${th.dataset.sortLabel}`);
      button.title = `Sort ${th.dataset.sortLabel}`;
      const labelNode = document.createElement('span');
      labelNode.className = 'scan-history-sort-label';
      labelNode.textContent = th.dataset.sortLabel;
      const indicator = document.createElement('span');
      indicator.className = 'scan-history-sort-indicator is-none';
      indicator.setAttribute('aria-hidden', 'true');
      const up = document.createElement('span');
      up.className = 'scan-history-sort-caret scan-history-sort-up';
      const down = document.createElement('span');
      down.className = 'scan-history-sort-caret scan-history-sort-down';
      const screenReader = document.createElement('span');
      screenReader.className = 'sr-only scan-history-sort-status';
      indicator.append(up, down);
      button.append(labelNode, indicator, screenReader);
      if (resizer) th.insertBefore(button, resizer);
      else th.appendChild(button);
    });
    if (table.dataset.scanHistorySortBound !== 'true') {
      table.dataset.scanHistorySortBound = 'true';
      table.tHead.addEventListener('click', (event) => {
        const button = event.target.closest('.scan-history-sort-button');
        if (!button) return;
        const key = button.dataset.sortKey || button.closest('th')?.dataset.sortKey || '';
        if (!Object.prototype.hasOwnProperty.call(SCAN_HISTORY_SORT_LABELS, key)) return;
        const current = normalizeScanHistorySort();
        const direction = current.key === key
          ? (current.direction === 'asc' ? 'desc' : 'asc')
          : (SCAN_HISTORY_DESC_FIRST.has(key) ? 'desc' : 'asc');
        state.scanHistorySort = { key, direction };
        state.scanHistoryRecords = sortScanHistoryRecords(state.scanHistoryRecords || [], state.scanHistorySort);
        renderScanHistoryRecords(state.scanHistoryRecords, state.scanHistorySummary || {});
        enhanceCoreTables();
      });
    }
    renderScanHistorySortHeaders(table);
  }

  function renderScanHistorySortHeaders(table = $('#scanHistoryRows')?.closest('table')) {
    if (!table || !table.tHead || !table.tHead.rows.length) return;
    const sort = normalizeScanHistorySort();
    Array.from(table.tHead.rows[0].children).forEach((th) => {
      const key = th.dataset.sortKey || '';
      if (!Object.prototype.hasOwnProperty.call(SCAN_HISTORY_SORT_LABELS, key)) return;
      const sorted = key === sort.key;
      th.classList.toggle('sorted-asc', sorted && sort.direction === 'asc');
      th.classList.toggle('sorted-desc', sorted && sort.direction === 'desc');
      th.setAttribute('aria-sort', sorted ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
      const indicator = th.querySelector('.scan-history-sort-indicator');
      if (indicator) {
        indicator.classList.toggle('is-none', !sorted);
        indicator.classList.toggle('is-asc', sorted && sort.direction === 'asc');
        indicator.classList.toggle('is-desc', sorted && sort.direction === 'desc');
      }
      const label = th.dataset.sortLabel || SCAN_HISTORY_SORT_LABELS[key];
      const button = th.querySelector('.scan-history-sort-button');
      if (button) {
        button.setAttribute('aria-label', sorted ? `${label}, sorted ${sort.direction === 'asc' ? 'ascending' : 'descending'}. Activate to sort ${sort.direction === 'asc' ? 'descending' : 'ascending'}.` : `Sort ${label}`);
        button.title = sorted ? `${label} sorted ${sort.direction === 'asc' ? 'ascending' : 'descending'}` : `Sort ${label}`;
      }
      const status = th.querySelector('.scan-history-sort-status');
      if (status) status.textContent = sorted ? `Sorted ${sort.direction === 'asc' ? 'ascending' : 'descending'}` : 'Not sorted';
    });
  }

  function scanHistoryQueryParams() {
    const params = new URLSearchParams(queryFromForm($('#scanHistoryFilters')));
    const allDealers = isBarcodeWorkspaceActive() && isAdminUser() && $('#scanHistoryFilters')?.elements.dealerCode.value === '';
    const dealerCode = allDealers ? 'ALL' : cleanDealerCode(params.get('dealerCode') || selectedScanDealerCode());
    if (dealerCode && dealerCode !== 'ALL') {
      params.set('dealerCode', dealerCode);
      params.delete('dealer');
    } else {
      params.delete('dealerCode');
    }
    if (!params.has('page')) params.set('page', String(state.scanHistoryPage || 1));
    if (!params.has('limit')) params.set('limit', isBarcodeWorkspaceActive() ? '10' : '100');
    if (isBarcodeWorkspaceActive()) params.set('partMatch', 'partial');
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
    const partDescription = scan.partDescription || scan.partName || scan.description || scan.part || '-';
    const entryBy = scan.enteredByName || scan.staffName || scan.userName || scan.userId || scanEntrySourceLabel(scan);
    return `
      <tr>
        <td>${escapeHtml(compactDateTime(scan.timestamp))}</td>
        <td>${partLink(scan.partNumber || scan.part || scan.normalizedPartNumber || '', 'table-link', {
          removeMode: isAdminUser() ? 'scan' : '',
          scanId: scanHistoryRecordId(scan),
          dealerCode: scan.dealerCode || '',
          auditId: scan.auditId || '',
          copyLabel: 'Part number'
        })}</td>
        <td>${escapeHtml(partDescription)}</td>
        <td>${escapeHtml(scanQuantity(scan, 0))}</td>
        <td>${escapeHtml(scan.binLocation || scan.bin)}</td>
        <td>${escapeHtml(entryBy)}</td>
      </tr>
    `;
  }

  function safeScanStreamRow(scan = {}) {
    const partDescription = scan.partDescription || scan.partName || scan.description || scan.part || '-';
    const entryBy = scan.enteredByName || scan.staffName || scan.userName || scan.userId || scanEntrySourceLabel(scan);
    return `
      <tr>
        <td>${escapeHtml(compactDateTime(scan.timestamp || scan.scanTime || scan.createdAt || ''))}</td>
        <td>${partLink(scan.partNumber || scan.part || scan.normalizedPartNumber || '', 'table-link', {
          removeMode: isAdminUser() ? 'scan' : '',
          scanId: scanHistoryRecordId(scan),
          dealerCode: scan.dealerCode || '',
          auditId: scan.auditId || '',
          copyLabel: 'Part number'
        })}</td>
        <td>${escapeHtml(partDescription)}</td>
        <td>${escapeHtml(scanQuantity(scan, 0))}</td>
        <td>${escapeHtml(scan.binLocation || scan.bin || '-')}</td>
        <td>${escapeHtml(entryBy)}</td>
      </tr>
    `;
  }

  function renderScanStream(scans = [], options = {}) {
    const body = $('#streamRows');
    try {
      const merged = mergeScanStreamRecords(scans);
      const rows = options.skipActiveAuditFilter === true ? merged : filterActiveAuditScans(merged);
      state.scanStreamRecords = rows;
      renderDashboardQuickOverview(state.dashboardStats || {}, rows);
      renderDashboardTopBins(rows);
      if (body) {
        const emptyLabel = rows.length
          ? ''
          : (options.skipActiveAuditFilter === true
            ? 'No scans yet'
            : (Array.isArray(scans) && scans.length ? 'No scans match the active dealer / audit filter' : 'No scans yet'));
        const previewRows = rows.slice(0, 5);
        body.innerHTML = previewRows.length
          ? previewRows.map((scan, index) => {
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
          : `<tr><td colspan="6" class="muted">${escapeHtml(emptyLabel)}</td></tr>`;
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
      renderDashboardQuickOverview(state.dashboardStats || {}, []);
      renderDashboardTopBins([]);
      if (body) body.innerHTML = '<tr><td colspan="6" class="muted">No scans yet</td></tr>';
      return [];
    }
  }

  function dashboardBinLabel(scan = {}) {
    const bin = String(scan.binLocation || scan.bin || '').trim();
    return bin ? bin.toUpperCase() : 'UNASSIGNED';
  }

  function renderDashboardTopBins(scans = []) {
    const body = $('#topBinsRows');
    if (!body) return [];
    const records = Array.isArray(scans) ? scans : [];
    const counts = new Map();
    records.forEach((scan) => {
      const bin = dashboardBinLabel(scan);
      const quantity = Math.abs(Number(scanQuantity(scan, 0)) || 0);
      if (quantity > 0) counts.set(bin, (counts.get(bin) || 0) + quantity);
    });
    const rows = Array.from(counts.entries())
      .map(([bin, count]) => ({ bin, count }))
      .sort((a, b) => Number(b.count || 0) - Number(a.count || 0) || String(a.bin).localeCompare(String(b.bin), undefined, { numeric: true, sensitivity: 'base' }))
      .slice(0, 5);
    if (!rows.length) {
      body.innerHTML = '<div class="dashboard-top-bins-empty">No bins yet</div>';
      return rows;
    }
    const max = Math.max(1, ...rows.map((row) => Number(row.count || 0)));
    body.innerHTML = rows.map((row) => {
      const width = Math.max(1, Math.round((Number(row.count || 0) / max) * 100));
      return `
        <div class="dashboard-top-bin-row">
          <strong class="dashboard-top-bin-label">${escapeHtml(row.bin)}</strong>
          <div class="dashboard-top-bin-count">${wholeNumber(row.count || 0)}</div>
          <div class="dashboard-top-bin-copy">
            <div class="dashboard-top-bin-track">
              <span class="dashboard-top-bin-bar" style="width: ${width}%"></span>
            </div>
          </div>
          <div class="dashboard-top-bin-percent">${width}%</div>
        </div>
      `;
    }).join('');
    return rows;
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

  function renderProductGroupSummary(options = {}) {
    const loading = options === true || options.loading === true;
    const body = $('#productGroupSummaryRows');
    if (loading) {
      if (body) {
        body.innerHTML = Array.from({ length: 4 }, () => '<tr class="dashboard-skeleton-row"><td colspan="7"><span></span></td></tr>').join('');
      }
      setText('productGroupSummaryCount', 'Loading...');
      enhanceCoreTables();
      return;
    }

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
    if (body) { // This is a duplicate line
      body.innerHTML = rows.length ? rows.map((item) => {
        const totalScans = productGroupSummaryValue(item, 'totalScans', 'scanCount');
        const totalQuantity = productGroupSummaryValue(item, 'totalQuantity', 'qty');
        const productGroup = item.productGroup || 'OTHERS';
        const partSubGroup = item.partSubGroup || item.productSubGroup || 'GENERAL';
        const rowKey = productGroupKey(productGroup, partSubGroup);
        return `
          <tr class="${rowKey === selectedKey ? 'selected' : ''}">
            <td><button class="btn light product-group-detail-link" type="button" data-product-group="${escapeHtml(productGroup)}" data-part-sub-group="${escapeHtml(partSubGroup)}">${escapeHtml(productGroup)}</button></td>
            <td><button class="btn light product-group-detail-link" type="button" data-product-group="${escapeHtml(productGroup)}" data-part-sub-group="${escapeHtml(partSubGroup)}">${escapeHtml(partSubGroup)}</button></td>
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

  function clearProductGroupSummaryState() {
    state.dashboardProductGroupRows = [];
    state.dashboardProductGroupLoadedAt = 0;
    state.selectedProductGroupSummary = null;
    state.productGroupDetailRows = [];
    state.productGroupDetailTotals = null;
    renderProductGroupSummary();
    renderProductGroupDetails({ rows: [], totals: {} });
  }

  function setProductGroupSummaryLoading() {
    state.selectedProductGroupSummary = null;
    state.productGroupDetailRows = [];
    state.productGroupDetailTotals = null;
    renderProductGroupSummary({ loading: true });
    renderProductGroupDetails({ rows: [], totals: {} });
  }

  async function loadDashboardProductGroupSummary(options = {}) {
    const force = options.force === true;
    if (state.dashboardProductGroupLoadPromise && !force) return state.dashboardProductGroupLoadPromise;
    if (!force && state.dashboardProductGroupLoadedAt && Date.now() - state.dashboardProductGroupLoadedAt < 5000) return state.dashboardProductGroupRows;
    if (state.dashboardProductGroupAbortController) state.dashboardProductGroupAbortController.abort();
    const requestId = (state.dashboardProductGroupLoadRequestId || 0) + 1;
    state.dashboardProductGroupLoadRequestId = requestId;
    const controller = new AbortController();
    state.dashboardProductGroupAbortController = controller;
    state.dashboardProductGroupLoadPromise = (async () => {
      try {
        const signal = options.signal || controller.signal;
        const query = dashboardQueryString({ forceRefresh: force });
        const data = await api(`/api/scans/dashboard/product-group-summary${query ? `?${query}` : ''}`, { signal });
        if (state.dashboardProductGroupLoadRequestId !== requestId) return state.dashboardProductGroupRows;
        state.dashboardProductGroupRows = Array.isArray(data.rows) ? data.rows : [];
        state.dashboardProductGroupLoadedAt = Date.now();
        renderProductGroupSummary();
        return state.dashboardProductGroupRows;
      } catch (error) {
        if (error && error.name === 'AbortError') return state.dashboardProductGroupRows;
        throw error;
      }
    })();
    try {
      return await state.dashboardProductGroupLoadPromise;
    } finally {
      if (state.dashboardProductGroupLoadRequestId === requestId) {
        state.dashboardProductGroupLoadPromise = null;
        state.dashboardProductGroupAbortController = null;
      }
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
    prependScanHistory(scan);
    refreshPartStockSummary(scan).catch(error => console.warn('[SCAN] part summary refresh failed', error.message));
    clearTimeout(state.scanHistoryRealtimeTimer);
    state.scanHistoryRealtimeTimer = setTimeout(() => loadScanHistory().catch((error) => console.warn('[SCAN] history refresh failed', error.message)), 80);
    // Keep the dashboard snapshot stable until the user explicitly refreshes it.
  }

  function setDashboardLoading(loading) {
    const dashboard = $('#dashboard');
    if (dashboard) dashboard.setAttribute('aria-busy', loading ? 'true' : 'false');
    document.body.classList.toggle('app-booting', Boolean(loading));
  }

  async function loadDashboard(options = {}) {
    const force = options.force === true;
    if (state.dashboardLoadPromise && !force) return state.dashboardLoadPromise;
    if (!force && state.dashboardLoaded && Date.now() - state.dashboardLastLoadedAt < 1500) return null;
    clearTimeout(state.dashboardRefreshTimer);
    state.dashboardRefreshTimer = null;
    if (state.dashboardAbortController) state.dashboardAbortController.abort();
    if (state.dashboardTopBinsAbortController) state.dashboardTopBinsAbortController.abort();
    const requestId = (state.dashboardLoadRequestId || 0) + 1;
    state.dashboardLoadRequestId = requestId;
    const controller = new AbortController();
    const topBinsController = new AbortController();
    state.dashboardAbortController = controller;
    state.dashboardTopBinsAbortController = topBinsController;
    let dashboardSucceeded = false;
    setDashboardRefreshState(true);
    updateDashboardScopeSummary();
    if (!state.dashboardLoaded) setDashboardLoading(true);
    state.dashboardLoadPromise = (async () => {
      try {
        const query = dashboardQueryString({ forceRefresh: force });
        loadHealth()
          .then((health) => {
            if (state.dashboardLoadRequestId !== requestId) return null;
            applyServerInfo(health);
            updateSyncBadges(health);
            updateDashboardHealth(health);
            return health;
          })
          .catch((error) => {
            if (state.dashboardLoadRequestId !== requestId) return null;
            if (error && error.name !== 'AbortError') {
              updateDashboardHealth({ server: 'offline', db: 'disconnected', storageStatus: 'unavailable' });
              console.warn('[DASHBOARD] health load failed', error.message);
            }
            return null;
          });
        const topBinsPromise = api(`/api/scans/live?limit=200${query ? `&${query}` : ''}`, {
          signal: topBinsController.signal,
          timeoutMs: 7000
        })
          .catch((error) => {
            if (state.dashboardLoadRequestId !== requestId || topBinsController.signal.aborted) return null;
            if (error && error.name !== 'AbortError') {
              console.warn('[DASHBOARD] top bins load failed', error.message);
            }
            return null;
          });
        const data = await api(`/api/scans/dashboard${query ? `?${query}` : ''}`, { signal: controller.signal });
        if (state.dashboardLoadRequestId !== requestId) return null;
        if (data.success === false || !data.stats || typeof data.stats !== 'object') {
          throw new Error(data.message || 'Dashboard response is missing summary data.');
        }
        if (data.activeAudit && data.activeAudit.dealerCode) {
          state.activeAudit = data.activeAudit;
          updateActiveAuditUi();
        }
        updateDashboardScopeSummary();
        const stats = data.stats || {};
        state.dashboardStats = stats;
        updateDashboardCards(stats);
        try {
          let recent = data.recent || data.records || data.scans || [];
          if ((!Array.isArray(recent) || !recent.length) && Number(stats.totalScanRecords || stats.totalScannedQuantity || stats.totalScannedValue || 0) > 0) {
            try {
              const fallback = await api(`/api/scans/live?limit=12${query ? `&${query}` : ''}`, { signal: controller.signal });
              if (state.dashboardLoadRequestId !== requestId) return null;
              recent = fallback.records || fallback.scans || recent;
              if (!Array.isArray(recent) || !recent.length) {
                const secondFallback = await api(`/api/scans/recent?limit=12${query ? `&${query}` : ''}`, { signal: controller.signal });
                if (state.dashboardLoadRequestId !== requestId) return null;
                recent = secondFallback.records || secondFallback.scans || recent;
              }
            } catch (fallbackError) {
              if (fallbackError && fallbackError.name !== 'AbortError') {
                console.warn('[DASHBOARD] fallback recent load failed', fallbackError.message);
              }
            }
          }
          if (state.dashboardLoadRequestId !== requestId) return null;
          const rows = renderScanStream(Array.isArray(recent) ? recent : [], { skipActiveAuditFilter: true });
          renderDashboardTopBins(rows);
          topBinsPromise.then((liveData) => {
            if (state.dashboardLoadRequestId !== requestId || topBinsController.signal.aborted) return;
            const liveRows = liveData && (liveData.records || liveData.scans);
            if (Array.isArray(liveRows)) {
              try {
                renderDashboardTopBins(liveRows);
              } catch (error) {
                console.warn('[DASHBOARD] top bins render failed', error.message);
              }
            }
          }).finally(() => {
            if (state.dashboardTopBinsAbortController === topBinsController) {
              state.dashboardTopBinsAbortController = null;
            }
          });
          if (!rows.length && Array.isArray(recent) && recent.length) {
            console.warn('[DASHBOARD] server returned recent scans but none rendered', {
              dealerCode: data.dealerCode || '',
              auditId: data.auditId || '',
              recentCount: recent.length
            });
          }
        } catch (error) {
          if (state.dashboardLoadRequestId !== requestId) return null;
          if (error && error.name !== 'AbortError') {
            console.warn('[DASHBOARD] recent stream load failed', error.message);
            renderScanStream([]);
          }
        }
        if (state.dashboardLoadRequestId !== requestId) return null;
        state.dashboardLoaded = true;
        state.dashboardLastLoadedAt = Date.now();
        dashboardSucceeded = true;
        return data;
      } catch (error) {
        if (controller.signal.aborted || state.dashboardLoadRequestId !== requestId) return null;
        if (error && error.name === 'AbortError') return null;
        throw error;
      }
    })();
    try {
      return await state.dashboardLoadPromise;
    } finally {
      controller.abort();
      if (!dashboardSucceeded) topBinsController.abort();
      if (state.dashboardLoadRequestId === requestId) {
        state.dashboardLoadPromise = null;
        state.dashboardAbortController = null;
        if (!dashboardSucceeded && state.dashboardTopBinsAbortController === topBinsController) {
          state.dashboardTopBinsAbortController = null;
        }
        setDashboardLoading(false);
        setDashboardRefreshState(false);
      }
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
    const records = sortScanHistoryRecords(mergeScanHistoryRecords(data.records || []));
    state.scanHistoryRecords = records;
    state.scanHistoryPagination = data.pagination || {};
    setText('scanHistoryPageInfo', `Page ${state.scanHistoryPage || 1} of ${data.pagination?.totalPages || 1}`);
    if ($('#scanHistoryPrev')) $('#scanHistoryPrev').disabled = (state.scanHistoryPage || 1) <= 1;
    if ($('#scanHistoryNext')) $('#scanHistoryNext').disabled = (state.scanHistoryPage || 1) >= (data.pagination?.totalPages || 1);
    const summary = scanHistorySummary(records, data.summary || {});
    state.scanHistorySummary = { ...(data.summary || {}), ...summary };
    renderScanHistoryRecords(records, state.scanHistorySummary);
    enhanceCoreTables();
  }

  function canEditScanDetails(scan = {}) {
    return Boolean(scan && isAdminUser() && scan.isDeleted !== true);
  }

  function scanHistoryRecord(scanId = '') {
    const targetId = cleanId(scanId);
    if (!targetId) return null;
    return (state.scanHistoryRecords || []).find((scan) => {
      const id = scanHistoryRecordId(scan);
      return id === targetId
        || cleanId(scan.scanId || scan.uniqueScanId || scan._id || '') === targetId
        || cleanId(scan.syncKey || '') === targetId
        || cleanId(scan.localId || '') === targetId;
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

  function scanHistoryDeleteReference(scanId = '') {
    const id = cleanId(scanId);
    return {
      id,
      scanId: id,
      uniqueScanId: id,
      localId: id,
      _id: id
    };
  }

  function openDeleteModal(message = 'Are you sure you want to delete this scan?') {
    const modal = $('#deleteModal');
    if (!modal) return Promise.resolve(window.confirm(message));
    const title = $('#deleteModalTitle');
    const text = $('#deleteModalText');
    if (deleteModalResolver) {
      deleteModalResolver(false);
      deleteModalResolver = null;
    }
    if (title) title.textContent = 'Confirm Delete';
    if (text) text.textContent = message;
    deleteModalDetails = { reason: '', remarks: '' };
    if ($('#deleteReasonInput')) $('#deleteReasonInput').value = '';
    if ($('#deleteRemarksInput')) $('#deleteRemarksInput').value = '';
    modal.classList.remove('hidden');
    return new Promise((resolve) => {
      deleteModalResolver = resolve;
      $('#cancelDeleteButton')?.focus();
    });
  }

  function closeDeleteModal(confirmed = false) {
    if (confirmed) {
      const reason = clean($('#deleteReasonInput')?.value || '');
      const remarks = clean($('#deleteRemarksInput')?.value || '');
      if (!reason) {
        toast('Select a deletion reason.', 'error');
        $('#deleteReasonInput')?.focus();
        return;
      }
      if (reason.toLowerCase() === 'other' && !remarks) {
        toast('Remarks are required when the reason is Other.', 'error');
        $('#deleteRemarksInput')?.focus();
        return;
      }
      deleteModalDetails = { reason, remarks };
    } else {
      deleteModalDetails = { reason: '', remarks: '' };
    }
    const modal = $('#deleteModal');
    if (modal) modal.classList.add('hidden');
    const resolve = deleteModalResolver;
    deleteModalResolver = null;
    if (resolve) resolve(confirmed);
  }

  function confirmDeleteAction(message = 'Are you sure you want to delete this scan?') {
    return openDeleteModal(message);
  }

  function lastDeleteDetails() {
    return { ...deleteModalDetails };
  }

  function deleteFailureError(error) {
    return new Error(error?.data?.message || error?.message || 'Unable to delete scan. Please try again.');
  }

  function openScanEditModal(scanId = '', focusField = 'partNumber') {
    const scan = scanHistoryRecord(scanId);
    if (!scan) throw new Error('Scan record not found');
    const form = $('#scanEditForm');
    if (!form) throw new Error('Scan edit form is unavailable');
    const scanType = String(scan.scanType || scan.type || '').trim().toUpperCase();
    const identity = scanHistoryRecordIdentity(scan);
    form.dataset.scanIdentity = JSON.stringify({
      ...identity,
      originalPartNumber: scan.partNumber || scan.part || scan.normalizedPartNumber || '',
      originalQuantity: scanQuantity(scan, 1),
      originalBinLocation: scan.binLocation || scan.bin || '',
      originalScanType: scanType,
      partNumber: scan.partNumber || scan.part || scan.normalizedPartNumber || '',
      quantity: scanQuantity(scan, 1),
      binLocation: scan.binLocation || scan.bin || '',
      scanType,
      dealerCode: scan.dealerCode || '',
      timestamp: scan.timestamp || scan.createdAt || ''
    });
    form.elements.scanId.value = identity.id || identity.scanId || identity.uniqueScanId || scanId;
    form.elements.partNumber.value = scan.partNumber || scan.part || scan.normalizedPartNumber || '';
    form.elements.quantity.value = scanQuantity(scan, 1);
    form.elements.mrp.value = scan.displayMRP ?? scan.currentCatalogueMRP ?? scan.valuationMRP ?? 0;
    form.elements.dlc.value = scan.currentCatalogueDLC ?? 0;
    form.elements.binLocation.value = scan.binLocation || scan.bin || '';
    form.elements.scanType.value = ['INWARD', 'OUTWARD', 'FITTED', 'DAMAGE'].includes(scanType) ? scanType : 'INWARD';
    if (form.elements.reason) form.elements.reason.value = focusField === 'binLocation' ? 'Wrong bin' : '';
    if (form.elements.remarks) form.elements.remarks.value = '';
    ['partNumber', 'quantity', 'mrp', 'dlc', 'scanType'].forEach((name) => {
      form.elements[name].disabled = focusField === 'binLocation';
    });
    form.elements.binLocation.disabled = false;
    form.elements.binLocation.required = ['INWARD', 'OUTWARD', 'FITTED', 'DAMAGE'].includes(scanType);
    const title = $('#scanEditTitle');
    if (title) {
      title.textContent = focusField === 'binLocation'
        ? 'Edit Bin Location'
        : focusField === 'quantity' ? 'Edit Part Quantity' : 'Edit Scanned Part';
    }
    const message = $('#scanEditMessage');
    if (message) {
      message.className = 'form-message';
      message.textContent = scanType === 'FITTED' ? 'Fitted rows remain assigned to the vehicle.' : '';
    }
    $('#scanEditModal')?.classList.remove('hidden');
    setTimeout(() => form.elements[focusField]?.focus(), 0);
  }

  function scanHistoryDisplayQuantity(scan = {}) {
    return String(scan.scanType || scan.type || '').toUpperCase() === 'INWARD'
      && scan.remainingQty !== undefined && scan.remainingQty !== null
      ? Math.max(0, Number(scan.remainingQty) || 0) : scanQuantity(scan, 0);
  }

  function scanHistoryRow(scan = {}, index = 0) {
    const id = scanHistoryRecordId(scan);
    const partNumber = scan.partNumber || scan.part || scan.normalizedPartNumber || '';
    const partDescription = scan.partDescription || scan.partName || scan.description || partNumber || '-';
    const rowMrp = scan.displayMRP ?? scan.currentCatalogueMRP ?? scan.valuationMRP ?? scan.mrp ?? 0;
    const rowDlc = scan.currentCatalogueDLC ?? scan.dlc ?? 0;
    const displayQty = scanHistoryDisplayQuantity(scan);
    const totalQty = String(scan.scanType || scan.type || '').toUpperCase() === 'INWARD'
      ? displayQty : scan.totalQty ?? scan.totalQuantity ?? scanHistoryQuantity(scan, 1);
    const canEditDetails = canEditScanDetails(scan);
    const scanType = String(scan.scanType || scan.type || '').toUpperCase();
    const editBinOption = canEditDetails && ['INWARD', 'OUTWARD', 'DAMAGE'].includes(scanType)
      ? '<option value="edit-bin">Edit Bin Location</option>'
      : '';
    const outwardOption = canEditDetails && scanType === 'INWARD'
      ? '<option value="mark-outward">Mark Outward</option>'
      : '';
    const editOption = canEditDetails
      ? `${editBinOption}${outwardOption}<option value="edit-qty">Edit Quantity</option><option value="edit">Edit Part Details</option>`
      : '';
    const fittedPending = String(scan.scanType || scan.type || '').toUpperCase() === 'FITTED'
      && !['BILLED', 'RETURNED_TO_BIN', 'CANCELLED'].includes(String(scan.fittedStatus || scan.status || '').toUpperCase().replace(/[\s-]+/g, '_'));
    const fittedOptions = isAdminUser() && fittedPending
      ? '<option value="fitted-billed">Mark Fitted as Billed</option><option value="fitted-return">Return Fitted Part to Bin</option>'
      : '';
    const deleteOption = isAdminUser() ? '<option value="delete">Delete Row</option>' : '';
    const actionDropdown = editOption || fittedOptions || deleteOption
      ? `<select class="app-action-dropdown scan-row-action" data-id="${escapeHtml(id)}" data-details-edit="${canEditDetails ? 'true' : 'false'}" data-return-bin="${escapeHtml(scan.stockDeductedFromBin || scan.binLocation || scan.bin || '')}" aria-label="Scan row action"><option value="">Edit / Delete</option>${editOption}${fittedOptions}${deleteOption}</select>`
      : '<span class="muted">No action</span>';
    if (isBarcodeWorkspaceActive()) {
      return `<tr>
        <td><input class="scan-history-checkbox" type="checkbox" value="${escapeHtml(id)}" aria-label="Select ${escapeHtml(partNumber)}"></td>
        <td>${((state.scanHistoryPage || 1) - 1) * 10 + index + 1}</td>
        <td>${escapeHtml(dateTime(scan.timestamp))}</td>
        <td><span class="scan-type-badge ${escapeHtml(scanType.toLowerCase())}">${escapeHtml(scanType)}</span></td>
        <td>${partLink(partNumber, 'table-link', { scanId: id, dealerCode: scan.dealerCode || '', auditId: scan.auditId || '', copyLabel: 'Part number' })}</td>
        <td title="${escapeHtml(partDescription)}">${escapeHtml(partDescription)}</td>
        <td>${escapeHtml(scan.binLocation || scan.bin || '')}</td><td>${escapeHtml(displayQty)}</td>
        <td>${escapeHtml(money(rowMrp))}</td><td>${escapeHtml(money(rowDlc))}</td>
        <td>${escapeHtml(scan.regdNo || '-')}</td><td>${escapeHtml(scan.jobCardNo || '-')}</td>
        <td title="${escapeHtml(scan.deviceId || '')}">${escapeHtml(String(scan.deviceId || '').startsWith('WEB-') ? 'WEB' : scan.deviceName || scan.deviceId || '-')}</td>
        <td>${actionDropdown}</td></tr>`;
    }
    return `
      <tr>
        <td class="select-cell"><input class="scan-history-checkbox" type="checkbox" value="${escapeHtml(id)}"></td>
        <td>${escapeHtml(dateTime(scan.timestamp))}</td>
        <td>${partLink(partNumber || scan.rawScanString || scan.rawScan || '', 'table-link', {
          removeMode: isAdminUser() ? 'scan' : '',
          scanId: id,
          dealerCode: scan.dealerCode || '',
          auditId: scan.auditId || '',
          copyLabel: 'Part number'
        })}</td>
        <td>${escapeHtml(partDescription)}</td>
        <td>${escapeHtml(scan.productCategory || scan.category || 'Uncategorized')}</td>
        <td>${escapeHtml(money(rowMrp))}</td>
        <td>${escapeHtml(money(rowDlc))}</td>
        <td>${escapeHtml(scan.productGroup || '')}</td>
        <td>${escapeHtml(scan.model || '')}</td>
        <td>${escapeHtml(scan.manufacturingYear || scan.year || '')}</td>
        <td>${escapeHtml(displayQty)}</td>
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
        if (action === 'edit-bin') {
          try {
            openScanEditModal(select.dataset.id, 'binLocation');
          } catch (error) {
            toast(error.message, 'error');
          }
        }
        if (action === 'mark-outward') {
          markScanOutward(select.dataset.id).catch((error) => toast(error.message, 'error'));
        }
        if (action === 'delete') {
          deleteSingleScan(select.dataset.id).catch((error) => toast(error.message, 'error'));
        }
        if (action === 'fitted-billed') {
          updateFittedStatus(select.dataset.id, 'BILLED').catch((error) => toast(error.message, 'error'));
        }
        if (action === 'fitted-return') {
          const bin = window.prompt('Return to which bin?', select.dataset.returnBin || '');
          if (bin === null) return;
          updateFittedStatus(select.dataset.id, 'RETURNED_TO_BIN', bin).catch((error) => toast(error.message, 'error'));
        }
      });
    });
  }

  async function markScanOutward(scanId) {
    const scan = scanHistoryRecord(scanId);
    if (!scan) throw new Error('Scan record not found');
    const partNumber = normalizePartText(scan.partNumber || scan.part || scan.normalizedPartNumber || '');
    const binLocation = cleanDealerCode(scan.binLocation || scan.bin || '');
    const defaultQty = scanHistoryDisplayQuantity(scan);
    const answer = window.prompt(
      `Enter the quantity sold for ${partNumber} from bin ${binLocation}. The remaining stock will be updated.`,
      String(defaultQty)
    );
    if (answer === null) return;
    const quantity = Number(answer);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error('Outward quantity must be greater than zero.');
    }
    if (!window.confirm(`Mark ${quantity} unit(s) of ${partNumber} in bin ${binLocation} as outward?`)) return;

    const result = await api(`/api/scans/${encodeURIComponent(scanId)}/mark-outward`, {
      method: 'POST',
      body: { quantity }
    });
    toast(`${result.message || 'Stock marked outward'} Remaining in ${binLocation}: ${result.remainingQty}.`, 'success');
    markReportsStale('scan marked outward', { autoRefresh: false });
    queueDashboardRefresh(250);
    await loadScanHistory();
  }

  async function updateFittedStatus(scanId, status, returnedToBin = '') {
    const reason = window.prompt('Enter the billing/return reference or reason:', '');
    if (reason === null) return;
    const result = await api(`/api/scans/${encodeURIComponent(scanId)}/fitted-status`, {
      method: 'POST',
      body: JSON.stringify({ status, returnedToBin, reason })
    });
    toast(result.message || 'Fitted status updated', 'success');
    await loadScanHistory();
  }

  function prependScanHistory(scan = {}) {
    const body = $('#scanHistoryRows');
    if (!body || !activeAuditMatchesScan(scan)) return;
    if (!scanMatchesScanHistoryFilters(scan)) return;
    if (body.querySelector('.muted')) body.innerHTML = '';
    const recordKey = scanHistoryRecordKey(scan);
    const alreadyVisible = recordKey && (state.scanHistoryRecords || []).some((item) => scanHistoryRecordKey(item) === recordKey);
    const nextRecords = alreadyVisible
      ? (state.scanHistoryRecords || []).map((item) => scanHistoryRecordKey(item) === recordKey ? scan : item)
      : [scan].concat(state.scanHistoryRecords || []);
    state.scanHistoryRecords = sortScanHistoryRecords(mergeScanHistoryRecords(nextRecords)).slice(0, isBarcodeWorkspaceActive() ? 10 : 500);
    const summary = { ...state.scanHistorySummary, visibleRows: state.scanHistoryRecords.length };
    state.scanHistorySummary = summary;
    renderScanHistoryRecords(state.scanHistoryRecords, state.scanHistorySummary);
    enhanceCoreTables();
  }

  async function repairSyncStatus() {
    if (!window.confirm('Repair WEB/server-saved pending scan records to synced?')) return;
    const data = await api('/api/scans/repair-sync-status', { method: 'POST', body: {} });
    toast(data.message || 'Sync status repaired');
    queueDashboardRefresh(250);
    await Promise.all([
      loadScanHistory(),
      loadSyncStatus()
    ]);
  }

  function fillPart(form, part) {
    const partInput = $('.partSuggestInput', form);
    if (partInput) partInput.value = part.partNumber || part.partNo || '';
    ['partName', 'bin', 'mrp', 'dlc', 'category'].forEach((key) => {
      if (form.id === 'manualScanForm' && key === 'bin') return;
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
      let requestSequence = 0;
      input.addEventListener('input', () => {
        clearTimeout(timer);
        const sequence = ++requestSequence;
        const q = input.value.trim();
        const wrap = input.closest('.suggest-wrap');
        const menu = $('.suggest-menu', wrap);
        if (q.length < 3) {
          menu.style.display = 'none';
          menu.innerHTML = '';
          return;
        }
        timer = setTimeout(async () => {
          try {
            const data = await api(`/api/master/parts/suggest?q=${encodeURIComponent(q)}&limit=8`);
            if (sequence !== requestSequence || input.value.trim() !== q) return;
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
            if (sequence === requestSequence) toast(error.message, 'error');
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
    let searchSequence = 0;
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
        const sequence = ++searchSequence;
        if (!q) {
          menu.style.display = 'none';
          menu.innerHTML = '';
          if (!hasPartSearchFilter()) clearPartSearch();
          return;
        }
        try {
          const data = await api(`/api/master/parts/suggest?q=${encodeURIComponent(q)}&limit=20`);
          if (sequence !== searchSequence || input.value.trim() !== q) return;
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
          if (sequence === searchSequence && error.name !== 'AbortError') toast(error.message, 'error');
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
      queueDashboardRefresh(250);
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
    if (!isAdmin()) return;
    clearTimeout(state.deviceRefreshTimer);
    state.deviceRefreshTimer = setTimeout(() => {
      if (!isAdmin() || document.hidden) return;
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

  function manualBinStorageKey(form) {
    const dealerCode = cleanDealerCode($('[name="dealerCode"]', form)?.value || activeDealerId() || '');
    const dealer = (state.dealers || []).find((item) => cleanDealerCode(item.dealerCode) === dealerCode);
    const auditId = cleanDealerCode(state.activeAudit?.dealerCode) === dealerCode
      ? state.activeAudit?.auditId : dealer?.currentAuditId;
    return `dakshManualLastBin:${state.user?.id || state.user?.username || ''}:${dealerCode}:${auditId || 'active'}`;
  }

  function restoreManualScanBin(form = $('#manualScanForm')) {
    if (!form) return;
    const key = manualBinStorageKey(form);
    if (form.dataset.binScope === key) return;
    form.dataset.binScope = key;
    const binInput = $('[name="bin"]', form);
    if (binInput) binInput.value = storageGet(key) || '';
    updateScanTypeFields(form);
  }

  function resetManualScanFields(form, options = {}) {
    if (!form) return;
    const dealerCode = $('[name="dealerCode"]', form)?.value || selectedScanDealerCode() || '';
    const staffName = $('[name="staffName"]', form)?.value || (state.user ? state.user.name || state.user.username || '' : '');
    const scanType = $('[name="type"]', form)?.value || 'INWARD';
    const bin = options.keepBin === false ? '' : $('[name="bin"]', form)?.value || '';
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
    const binInput = $('[name="bin"]', form);
    if (binInput) binInput.value = bin;
    $$('.suggest-menu', form).forEach((menu) => {
      menu.innerHTML = '';
      menu.style.display = 'none';
    });
    updateScanTypeFields(form);
    if (form.elements.type.value === 'INWARD' && bin) validateManualSourceBin(form).catch(console.warn);
    (bin ? $('[name="part"]', form) : binInput)?.focus();
  }

  function updateScanTypeFields(form) {
    if (!form) return;
    if (form.id === 'barcodeScanForm') {
      updateBarcodeWorkspace(form);
      return;
    }
    const scanType = String($('[name="type"]', form)?.value || 'INWARD').trim().toUpperCase();
    const isFitted = scanType === 'FITTED';
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
    const needsSourceBinFirst = ['OUTWARD', 'FITTED'].includes(scanType);
    const upiFirstBarcode = form.id === 'barcodeScanForm' && needsSourceBinFirst;
    const manualBinFirst = form.id === 'manualScanForm' && scanType !== 'VERIFICATION';
    const manualBinValue = String(binInput?.value || '').trim();
    const manualBinMissing = manualBinFirst && (!manualBinValue || (scanType === 'INWARD' && state.validatedManualBin !== `${form.elements.dealerCode.value}|${cleanDealerCode(manualBinValue)}`));
    const showPartLookupBin = !upiFirstBarcode;
    if (binInput) {
      binInput.required = manualBinFirst || (!upiFirstBarcode && needsSourceBinFirst) || (form.id === 'barcodeScanForm' && ['INWARD', 'DAMAGE'].includes(scanType));
      binInput.disabled = form.id === 'barcodeScanForm' && scanType === 'VERIFICATION';
    }
    if (binLabel && form.id === 'barcodeScanForm') {
      const showBin = !['VERIFICATION'].includes(scanType)
        && showPartLookupBin;
      binLabel.classList.toggle('hidden', !showBin);
    }
    if (binLabel) {
      binLabel.classList.toggle('source-bin-required', needsSourceBinFirst);
      binLabel.classList.toggle('source-bin-missing', needsSourceBinFirst && !String(binInput?.value || '').trim());
    }
    const partInput = $('[name="part"]', form);
    const rawInput = $('[name="rawScan"]', form);
    if (partInput) {
      partInput.disabled = manualBinMissing;
      if (form.id === 'manualScanForm') partInput.placeholder = manualBinMissing ? 'Enter bin first' : 'Enter part number';
      partInput.required = !upiFirstBarcode;
      partInput.readOnly = upiFirstBarcode;
      partInput.closest('label')?.classList.toggle('hidden', upiFirstBarcode);
    }
    if (rawInput) rawInput.disabled = manualBinMissing;
    if (form.id === 'manualScanForm') $$('button[type="submit"]', form).forEach(button => { button.disabled = manualBinMissing; });
    if (form.id === 'barcodeScanForm') {
      const ready = upiFirstBarcode || !needsSourceBinFirst || Boolean(String(binInput?.value || '').trim());
      setLivePill('barcodeReadyStatus', ready ? (upiFirstBarcode ? 'Ready for UPI / QR Scan' : 'Ready for Scan') : 'Enter Bin Location', ready);
    }
  }

  async function confirmManualDuplicateAndAddQuantity(form, normalized, error) {
    const duplicate = error?.data || {};
    const partNumber = duplicate.partNumber || normalized.partNumber;
    const binLocation = duplicate.binLocation || normalized.binLocation || '-';
    const existingQty = Number(duplicate.existingQty ?? duplicate.scan?.qty ?? duplicate.scan?.quantity ?? 0);
    const addQty = Number(duplicate.requestedQty ?? normalized.qty ?? normalized.quantity ?? 0);
    const message = `Part ${partNumber} is already available in bin ${binLocation}.\nCurrent quantity: ${existingQty}.\nDo you want to add ${addQty} more?`;
    if (!window.confirm(message)) return;

    normalized.reason = 'Manual quantity addition';
    normalized.remarks = '';
    normalized.addManualQuantity = true;
    normalized.confirmAddQuantity = true;
    normalized.manualAddRequestId = `MANUAL-ADD-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
    try {
      const updateData = await api('/api/scans/process', { method: 'POST', body: normalized, timeoutMs: 20000 });
      playScanTone('success');
      toast(updateData.message || 'Manual quantity updated');
      resetManualScanFields(form);
      if (updateData.scan) {
        prependScanHistory(updateData.scan);
        handleNewScan(updateData.scan, { showSuccess: true }).catch(() => undefined);
      }
      loadScanHistory().catch(() => undefined);
      queueReconciliationRefresh('manual quantity update');
      markReportsStale('manual quantity update', { autoRefresh: false });
    } catch (updateError) {
      playScanTone('error');
      toast(updateError.message || 'Manual quantity update failed', 'error');
    }
  }

  async function submitScan(form, options = {}) {
    if (form.id === 'barcodeScanForm' && !['OUTWARD', 'FITTED', 'VERIFICATION'].includes(String((options.payload || formObject(form)).type || '').toUpperCase()) && !String((options.payload || formObject(form)).binLocation || '').trim()) {
      toast('Please select or scan Source Bin Location first.', 'error');
      $('#barcodeBinLocation')?.focus();
      return;
    }
    if (form.id === 'manualScanForm' && $('[name="type"]', form)?.value !== 'VERIFICATION'
      && !String($('[name="bin"]', form)?.value || '').trim()) {
      toast('Enter Source Bin Location first.', 'error');
      $('[name="bin"]', form)?.focus();
      return;
    }
    const payload = options.payload || formObject(form);
    const isBarcodeForm = form.id === 'barcodeScanForm';
    payload.deviceId = payload.deviceId || ensureDeviceId();
    if (!payload.staffName && state.user) payload.staffName = state.user.name || state.user.username;
    if (isBarcodeForm && !payload.rawScan) payload.rawScan = payload.part || '';
    const normalized = normalizeScanPayload(payload);
    normalized.scanType = String(normalized.scanType || normalized.type || 'INWARD').trim().toUpperCase();
    normalized.type = normalized.scanType;
    if (isBarcodeForm && (normalized.upiId || normalized.upiNo || extractUpiIdFromText(normalized))) {
      normalized.qty = 1;
      normalized.quantity = 1;
    }
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
            focusNextBarcodeField();
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
          setTimeout(focusNextBarcodeField, 900);
        }
      }
      return;
    }
    const scanPartNumber = normalizePartText(normalized.partNumber || normalized.part || '');
    const upiFirstBarcode = isBarcodeForm && ['OUTWARD', 'FITTED'].includes(normalized.scanType);
    const hasUpiIdentity = Boolean(normalized.upiId || normalized.upiNo || extractUpiIdFromText(normalized));
    if (!validPartText(scanPartNumber) && !(upiFirstBarcode && hasUpiIdentity)) {
      playScanTone('error');
      toast('Invalid part number format', 'error');
      if (isBarcodeForm) {
        setLivePill('barcodeReadyStatus', 'Rejected - Ready', false);
        resetBarcodeScanFields(form, normalized, options.expectedRaw);
        setTimeout(focusNextBarcodeField, 900);
      }
      return;
    }
    // Keep manual saves to one request. The save endpoint validates the part
    // against master data and enriches the saved inventory record itself.
    if (!isBarcodeForm && !payload.rawScan && !payload.rawScanString && !payload.rawBarcode && !payload.rawScanValue && !payload.barcode && !payload.barcodeValue && !payload.scanValue && !payload.scanText) {
      normalized.rawScan = '';
      normalized.rawScanString = '';
      normalized.rawBarcode = '';
      normalized.rawScanValue = '';
    }
    normalized.synced = true;
    normalized.isSynced = true;
    normalized.syncStatus = 'synced';
    const needsManualBin = ['INWARD', 'OUTWARD', 'FITTED', 'DAMAGE'].includes(normalized.scanType) && !upiFirstBarcode;
    if (needsManualBin && !normalized.binLocation) {
      playScanTone('error');
      const prompt = 'Please enter/select bin location before scanning.';
      toast(prompt, 'error');
      if (isBarcodeForm) {
        setLivePill('barcodeReadyStatus', 'Enter Bin Location', false);
        $('#barcodeBinLocation')?.focus();
      } else if (!isBarcodeForm) {
        form.elements.bin?.focus();
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
    if (isBarcodeForm && isBarcodeScanRecentlyLocked(normalized, 3000)) {
      playScanTone('error');
      toast('This UPI / QR was just scanned. Check the previous scan result.', 'error');
      setLivePill('barcodeReadyStatus', 'Duplicate blocked', false);
      resetBarcodeScanFields(form, normalized, options.expectedRaw);
      setTimeout(focusNextBarcodeField, 700);
      return;
    }

    // The save endpoint validates duplicates and smart-bin conflicts together.
    // Do not make a separate preflight request for manual saves.

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
    // Persist a physical scanner capture before starting its online request.
    // The same scan ID is used for retries, so a page close or lost response
    // cannot turn the retry into a second inventory row.
    if (isBarcodeForm) {
      try {
        enqueueScan(normalized, 'Awaiting server confirmation');
      } catch (queueError) {
        console.warn('[SCAN] local barcode queue write failed', queueError.message);
      }
    }

    try {
      const requestStartedAt = performance.now();
      let data;
      try { data = await api('/api/scans/process', { method: 'POST', body: normalized, timeoutMs: 20000 }); }
      catch (error) {
        if (!error.data?.requiresBinSelection) throw error;
        const bin = await window.DakshSkuBinPicker.choose(error.data.binOptions, normalized.partNumber);
        if (!bin) throw error;
        normalized.binLocation = normalized.bin = bin;
        data = await api('/api/scans/process', { method: 'POST', body: normalized, timeoutMs: 20000 });
      }
      if (window.SCAN_PERF_LOGS === true) {
        console.info('[SCAN_PERF_BROWSER]', JSON.stringify({
          scanId: clean(normalized.scanId || normalized.uniqueScanId || ''),
          scanType: normalized.scanType,
          requestMs: Math.round(performance.now() - requestStartedAt),
          status: clean(data.status || (data.duplicate ? 'duplicate' : 'synced')),
          apiCalls: 1
        }));
      }
      if (data.partSummary && cleanDealerCode(data.scan?.dealerCode || '') === scanStockDealerCode()) renderPartStockSummary(data.partSummary);
      if (data && data.scan) {
        // Handle successful save
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
      if (isBarcodeForm) removeQueuedBarcodeScan(normalized);
      playScanTone(data.duplicate ? 'duplicate' : 'success');
      if (isBarcodeForm) {
        if (data.scan && !String($('#barcodeRaw')?.value || '').trim() && !form.elements.part.value) fillPart(form, {
          ...data.scan,
          partName: data.scan.partDescription || data.scan.partName,
          category: data.scan.category || data.scan.productCategory
        });
        if (normalized.scanType === 'OUTWARD' && data.scan) {
          setText('barcodeCurrentBin', data.scan.binLocation || data.scan.bin || 'Workshop');
          toast(`Picked From: ${data.scan.binLocation || data.scan.bin || 'Workshop'}`);
        } else {
          localStorage.setItem(BARCODE_LAST_BIN_KEY, form.elements.binLocation.value);
        }
        lockBarcodeScan(data.scan || normalized, 1800);
        state.barcodeLastRaw = rawBarcodeText || state.barcodeLastRaw;
        state.barcodeLastAt = Date.now();
        resetBarcodeScanFields(form, normalized, options.expectedRaw);
        setLivePill('barcodeReadyStatus', data.duplicate ? 'Duplicate skipped' : 'Saved', true);
        focusNextBarcodeField();
      } else {
        if (normalized.binLocation) storageSet(manualBinStorageKey(form), normalized.binLocation);
        resetManualScanFields(form);
      }
      markReportsStale(isBarcodeForm ? 'barcode scan' : 'manual scan', { autoRefresh: false });
      return data;
    } catch (error) {
      if (error.status === 409 && error.data?.smartBinWarning) {
        // Handle the smart bin warning returned from the server
        const smartBinPayload = error.data.smartBinSuggestion || error.data || {};
        const decision = await openSmartBinSuggestionModal({
          ...smartBinPayload,
          partDescription: normalized.partDescription || normalized.partName || error.data.partDescription || '',
          currentBin: smartBinPayload.currentBin || normalized.binLocation || '',
          requireReason: false
        });
        if (!decision) {
          if (isBarcodeForm) removeQueuedBarcodeScan(normalized);
          if (isBarcodeForm) {
            resetBarcodeScanFields(form, normalized, options.expectedRaw);
            setTimeout(focusNextBarcodeField, 700);
          } else {
            resetManualScanFields(form);
          }
          return;
        }
        normalized.smartBinEnabled = true;

        // Apply user's decision from the popup
        normalized.smartBinSuggestedBin = cleanDealerCode(decision.suggestedBin || smartBinPayload.suggestedBin || normalized.binLocation || '');
        normalized.smartBinCurrentBin = cleanDealerCode(decision.currentBin || smartBinPayload.currentBin || normalized.binLocation || '');
        normalized.smartBinSelectedBin = cleanDealerCode(decision.selectedBin || normalized.binLocation || '');
        normalized.smartBinExistingBins = Array.isArray(decision.existingBins) ? decision.existingBins : (Array.isArray(smartBinPayload.existingBins) ? smartBinPayload.existingBins : []);
        normalized.smartBinAllowMultipleLocations = smartBinPayload.allowMultipleLocations === undefined
          ? true
          : Boolean(smartBinPayload.allowMultipleLocations);
        normalized.smartBinMaxAllowedLocationsPerPart = Math.max(1, Number.parseInt(String(smartBinPayload.maxAllowedLocationsPerPart || 3), 10) || 3);
        normalized.smartBinReasonRequired = false;
        normalized.smartBinDecision = String(decision.action || '').trim().toUpperCase();
        normalized.smartBinReason = normalized.smartBinDecision === 'SAVE_NEW_BIN'
          ? 'User confirmed different bin'
          : String(decision.reason || 'User selected existing bin').trim();
        normalized.smartBinCheckedAt = String(decision.checkedAt || new Date().toISOString());
        normalized.smartBinDecisionAt = String(decision.decisionAt || new Date().toISOString());
        normalized.smartBinDecisionBy = String(decision.decisionBy || state.user?.name || state.user?.username || state.user?.email || '').trim();
        normalized.smartBinLocationType = normalized.smartBinDecision === 'SAVE_NEW_BIN' ? 'SECONDARY' : 'PRIMARY';
        normalized.smartBinIsSecondaryLocation = normalized.smartBinDecision === 'SAVE_NEW_BIN';
        normalized.allowCrossBinDuplicate = normalized.smartBinIsSecondaryLocation;
        normalized.smartBinAuditTrail = {
          enabled: true,
          decision: normalized.smartBinDecision,
          reason: normalized.smartBinReason,
          suggestedBin: normalized.smartBinSuggestedBin,
          selectedBin: normalized.smartBinSelectedBin,
          currentBin: normalized.smartBinCurrentBin,
          existingBins: normalized.smartBinExistingBins,
          allowMultipleLocations: normalized.smartBinAllowMultipleLocations,
          maxAllowedLocationsPerPart: normalized.smartBinMaxAllowedLocationsPerPart,
          reasonRequired: normalized.smartBinReasonRequired,
          checkedAt: normalized.smartBinCheckedAt,
          decisionAt: normalized.smartBinDecisionAt,
          decisionBy: normalized.smartBinDecisionBy,
          locationType: normalized.smartBinLocationType,
          isSecondaryLocation: normalized.smartBinIsSecondaryLocation
        };
        if (normalized.smartBinDecision === 'USE_EXISTING_BIN') {
          const selectedBin = cleanDealerCode(normalized.smartBinSelectedBin || smartBinPayload.suggestedBin || normalized.binLocation || '');
          if (selectedBin) {
            normalized.binLocation = selectedBin;
            normalized.bin = selectedBin;
          }
        }
        let retryData;
        try {
          const retryStartedAt = performance.now();
          retryData = await api('/api/scans/process', { method: 'POST', body: normalized, timeoutMs: 20000 });
          if (window.SCAN_PERF_LOGS === true) {
            console.info('[SCAN_PERF_BROWSER]', JSON.stringify({
              scanId: clean(normalized.scanId || normalized.uniqueScanId || ''),
              scanType: normalized.scanType,
              requestMs: Math.round(performance.now() - retryStartedAt),
              status: clean(retryData.status || (retryData.duplicate ? 'duplicate' : 'synced')),
              apiCalls: 1,
              retry: true
            }));
          }
        } catch (retryError) {
          if (!isBarcodeForm && retryError.status === 409 && retryError.data?.manualDuplicate) {
            await confirmManualDuplicateAndAddQuantity(form, normalized, retryError);
            return;
          }
          throw retryError;
        }
        if (retryData.partSummary && cleanDealerCode(retryData.scan?.dealerCode || '') === scanStockDealerCode()) renderPartStockSummary(retryData.partSummary);
        if (retryData && retryData.scan) {
          const savedScan = retryData.scan || {};
          addSyncLog({
            partNumber: savedScan.partNumber || savedScan.part || normalized.partNumber,
            upiId: savedScan.upiId || savedScan.upiNo || normalized.upiId,
            dealer: savedScan.dealerCode || normalized.dealerCode,
            status: retryData.duplicate ? 'duplicate' : 'synced',
            errorMessage: retryData.duplicate ? 'Duplicate scan skipped' : ''
          });
          rememberLastSyncTime(retryData.completedAt || retryData.lastSyncTime || retryData.lastSync || new Date().toISOString());
          handleNewScan(retryData.scan, { showSuccess: !retryData.duplicate }).catch((error) => console.warn('[SCAN] latest row update failed', error));
        }
        if (isBarcodeForm) removeQueuedBarcodeScan(normalized);
        playScanTone(retryData.duplicate ? 'duplicate' : 'success');
        if (isBarcodeForm) {
          if (normalized.scanType !== 'OUTWARD') localStorage.setItem(BARCODE_LAST_BIN_KEY, form.elements.binLocation.value);
          lockBarcodeScan(retryData.scan || normalized, 1800);
          state.barcodeLastRaw = rawBarcodeText || state.barcodeLastRaw;
          state.barcodeLastAt = Date.now();
          resetBarcodeScanFields(form, normalized, options.expectedRaw);
          setLivePill('barcodeReadyStatus', retryData.duplicate ? 'Duplicate skipped' : 'Saved', true);
          focusNextBarcodeField();
        } else {
          resetManualScanFields(form);
        }
        markReportsStale(isBarcodeForm ? 'barcode scan' : 'manual scan', { autoRefresh: false });
        return retryData;
      }
      if (
        error.status === 409
        && (isBarcodeForm || error.data?.duplicate || error.data?.upiDuplicate)
        && !error.data?.fittedDuplicate
        && !(!isBarcodeForm && error.data?.manualDuplicate)
      ) {
        if (isBarcodeForm) removeQueuedBarcodeScan(normalized);
        playScanTone(error.data?.upiDuplicate ? 'error' : 'duplicate');
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
          setTimeout(focusNextBarcodeField, 700);
        }
        return;
      }
      if (!isBarcodeForm && error.status === 409 && error.data?.manualDuplicate) {
        playScanTone('duplicate');
        await confirmManualDuplicateAndAddQuantity(form, normalized, error);
        return;
      }
      if (error.status === 409 && error.data?.fittedDuplicate) {
        playScanTone('duplicate');
        if (window.confirm(error.data.message || 'This fitted part already exists for this vehicle/job card. Add quantity?')) {
          normalized.reason = 'Fitted quantity addition';
          normalized.remarks = '';
          normalized.addFittedQuantity = true;
          const updateData = await api('/api/scans/process', { method: 'POST', body: normalized });
          playScanTone('success');
          toast(updateData.message || 'Fitted part quantity updated');
          if (isBarcodeForm) {
            resetBarcodeScanFields(form, normalized, options.expectedRaw);
            setTimeout(focusNextBarcodeField, 700);
          }
          else resetManualScanFields(form);
          if (updateData.scan) handleNewScan(updateData.scan, { showSuccess: true }).catch(() => undefined);
        }
        return;
      }
      if (error.status === 409 && isAdmin()) {
        const warnings = (error.data.warnings || []).join(', ');
        const unknownBlocked = /part does not exist|unknown/i.test(warnings) && localStorage.getItem('dakshAllowUnknown') !== 'true';
        if (unknownBlocked) {
          playScanTone('error');
          toast('Unknown part save is disabled for this account', 'error');
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
      if (isRetryableTransportError(error)) {
        const queued = enqueueScan(normalized, error.message || 'Server unavailable; scan saved locally');
        if (isBarcodeForm) {
          if (normalized.scanType !== 'OUTWARD') localStorage.setItem(BARCODE_LAST_BIN_KEY, form.elements.binLocation.value);
          lockBarcodeScan(queued, 900);
          state.barcodeLastRaw = rawBarcodeText || state.barcodeLastRaw;
          state.barcodeLastAt = Date.now();
          resetBarcodeScanFields(form, normalized, options.expectedRaw);
          setStatusPill('barcodeReadyStatus', 'Pending - saved locally', 'yellow');
          setTimeout(focusNextBarcodeField, 900);
        } else {
          resetManualScanFields(form);
        }
        playScanTone('warning');
        toast('Server unavailable. Scan saved locally and will retry automatically.', 'warning');
        updateSyncBadges();
        schedulePendingSync(350);
        return;
      }
      if (isBarcodeForm) removeQueuedBarcodeScan(normalized);
      playScanTone('error');
      toast(error.message, 'error');
      if (isBarcodeForm) {
        setLivePill('barcodeReadyStatus', /not found|reject/i.test(error.message) ? 'Rejected - Ready' : 'Fix Error', false);
        resetBarcodeScanFields(form, normalized, options.expectedRaw);
        setTimeout(focusNextBarcodeField, 1000);
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
      scans.forEach((scan) => enqueueScan(scan, 'Imported from mobile sync input'));
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
      const outcomes = new Map();
      const insertedRecords = [];
      const logs = [];
      let syncedCount = 0;
      let duplicateCount = 0;
      let rejectedCount = 0;
      let failedCount = 0;
      let pendingCount = 0;

      for (const record of records) {
        const recordKey = record.syncKey || record.localId || record.uniqueScanId || record.scanId;
        let outbound = normalizeScanPayload(applyActiveAuditToPayload({
          ...record,
          uniqueScanId: record.uniqueScanId || record.localId || record.scanId,
          scanId: record.scanId || record.localId || record.uniqueScanId,
          clientScanId: record.clientScanId || record.localId || record.scanId,
          clientSyncKey: record.clientSyncKey || record.syncKey
        }));
        const smartBinEligibleScan = ['INWARD', 'DAMAGE', 'AUDIT'].includes(outbound.scanType);
        if (state.smartBinSettings?.enabled !== false && smartBinEligibleScan && outbound.dealerCode && outbound.auditId && outbound.partNumber && outbound.binLocation) {
          try {
            let suggestion = localSmartBinSuggestion(outbound);
            if (!suggestion?.shouldPrompt) {
              suggestion = await api('/api/scans/smart-bin-check', {
                method: 'POST',
                body: {
                  dealerCode: outbound.dealerCode,
                  auditId: outbound.auditId,
                  partNumber: outbound.partNumber,
                  partDescription: outbound.partDescription || outbound.partName || '',
                  binLocation: outbound.binLocation,
                  scanType: outbound.scanType,
                  qty: outbound.qty,
                  refresh: true
                },
                timeoutMs: 1800
              });
            }
            if (suggestion && suggestion.shouldPrompt) {
              const decision = await openSmartBinSuggestionModal({
                ...suggestion,
                currentBin: suggestion.currentBin || outbound.binLocation || outbound.bin || '',
                newBin: suggestion.newBin || outbound.binLocation || outbound.bin || '',
                existingBin: suggestion.existingBin || (Array.isArray(suggestion.existingBins) && suggestion.existingBins[0] && suggestion.existingBins[0].binLocation) || '',
                requireReason: Boolean(state.smartBinSettings?.requireReason ?? true)
              });
              if (!decision) {
                outcomes.set(recordKey, { remove: true, status: 'rejected', message: 'Smart bin confirmation cancelled' });
                rejectedCount += 1;
                logs.push({
                  partNumber: record.partNumber || record.part,
                  upiId: record.upiId,
                  dealer: record.dealerCode,
                  status: 'rejected',
                  errorMessage: 'Smart bin confirmation cancelled'
                });
                continue;
              }
              applySmartBinDecisionToScan(outbound, suggestion, decision, {
                reasonRequired: Boolean(state.smartBinSettings?.requireReason ?? true)
              });
            }
          } catch (error) {
            console.warn('[SMART BIN] preflight skipped', error.message);
            addConnectionLog(`Smart bin preflight skipped: ${error.message}`, 'warning');
          }
        }
        // /api/scans/process applies the duplicate policy as part of the save.
        // A separate duplicate request here can hang queue retries and repeats
        // work already done by the authoritative save endpoint.
        try {
          const result = await api('/api/scans/process', { method: 'POST', body: outbound, timeoutMs: 20000 });
          const saved = result.scan || outbound;
          outcomes.set(recordKey, { remove: true });
          syncedCount += 1;
          insertedRecords.push(saved);
          logs.push({
            partNumber: saved.partNumber || saved.part || record.partNumber || record.part,
            upiId: saved.upiId || saved.upiNo || record.upiId,
            dealer: saved.dealerCode || record.dealerCode,
            status: 'synced',
            errorMessage: ''
          });
        } catch (error) {
          const message = error.message || 'Scan could not be synced';
          if (Number(error.status) === 409 && error.data?.smartBinWarning) {
            const smartBinPayload = error.data.smartBinSuggestion || error.data;
            const decision = await openSmartBinSuggestionModal({
              ...smartBinPayload,
              partDescription: outbound.partDescription || outbound.partName || error.data.partDescription || '',
              currentBin: smartBinPayload.currentBin || outbound.binLocation || outbound.bin || '',
              requireReason: false
            });
            if (!decision) {
              outcomes.set(recordKey, { remove: true, status: 'rejected', message: 'Smart bin confirmation cancelled' });
              rejectedCount += 1;
              logs.push({
                partNumber: record.partNumber || record.part,
                upiId: record.upiId,
                dealer: record.dealerCode,
                status: 'rejected',
                errorMessage: 'Smart bin confirmation cancelled'
              });
              continue;
            }
            const decisionAction = String(decision.action || '').trim().toUpperCase();
            const selectedBin = cleanDealerCode(decision.selectedBin || outbound.binLocation || outbound.bin || '');
            outbound.smartBinEnabled = true;
            outbound.smartBinSuggestedBin = cleanDealerCode(decision.suggestedBin || smartBinPayload.suggestedBin || outbound.binLocation || '');
            outbound.smartBinCurrentBin = cleanDealerCode(decision.currentBin || smartBinPayload.currentBin || outbound.binLocation || '');
            outbound.smartBinSelectedBin = selectedBin || cleanDealerCode(outbound.binLocation || '');
            outbound.smartBinExistingBins = Array.isArray(decision.existingBins) ? decision.existingBins : (Array.isArray(smartBinPayload.existingBins) ? smartBinPayload.existingBins : []);
            outbound.smartBinAllowMultipleLocations = smartBinPayload.allowMultipleLocations === undefined
              ? true
              : Boolean(smartBinPayload.allowMultipleLocations);
            outbound.smartBinMaxAllowedLocationsPerPart = Math.max(1, Number.parseInt(String(smartBinPayload.maxAllowedLocationsPerPart || 3), 10) || 3);
            outbound.smartBinReasonRequired = false;
            outbound.smartBinDecision = decisionAction;
            outbound.smartBinReason = decisionAction === 'SAVE_NEW_BIN'
              ? 'User confirmed different bin'
              : 'User selected existing bin';
            outbound.smartBinCheckedAt = String(decision.checkedAt || new Date().toISOString());
            outbound.smartBinDecisionAt = String(decision.decisionAt || new Date().toISOString());
            outbound.smartBinDecisionBy = String(decision.decisionBy || state.user?.name || state.user?.username || state.user?.email || '').trim();
            outbound.smartBinLocationType = decisionAction === 'SAVE_NEW_BIN' ? 'SECONDARY' : 'PRIMARY';
            outbound.smartBinIsSecondaryLocation = decisionAction === 'SAVE_NEW_BIN';
            outbound.allowCrossBinDuplicate = outbound.smartBinIsSecondaryLocation;
            outbound.smartBinAuditTrail = {
              enabled: true,
              decision: outbound.smartBinDecision,
              reason: outbound.smartBinReason,
              suggestedBin: outbound.smartBinSuggestedBin,
              selectedBin: outbound.smartBinSelectedBin,
              currentBin: outbound.smartBinCurrentBin,
              existingBins: outbound.smartBinExistingBins,
              allowMultipleLocations: outbound.smartBinAllowMultipleLocations,
              maxAllowedLocationsPerPart: outbound.smartBinMaxAllowedLocationsPerPart,
              reasonRequired: outbound.smartBinReasonRequired,
              checkedAt: outbound.smartBinCheckedAt,
              decisionAt: outbound.smartBinDecisionAt,
              decisionBy: outbound.smartBinDecisionBy,
              locationType: outbound.smartBinLocationType,
              isSecondaryLocation: outbound.smartBinIsSecondaryLocation
            };
            if (decisionAction === 'USE_EXISTING_BIN') {
              if (selectedBin) {
                outbound.binLocation = selectedBin;
                outbound.bin = selectedBin;
              }
            }
            try {
              const retryResult = await api('/api/scans/process', { method: 'POST', body: outbound, timeoutMs: 20000 });
              const saved = retryResult.scan || outbound;
              outcomes.set(recordKey, { remove: true });
              syncedCount += 1;
              insertedRecords.push(saved);
              logs.push({
                partNumber: saved.partNumber || saved.part || record.partNumber || record.part,
                upiId: saved.upiId || saved.upiNo || record.upiId,
                dealer: saved.dealerCode || record.dealerCode,
                status: 'synced',
                errorMessage: ''
              });
              continue;
            } catch (retryError) {
              const retryMessage = retryError.message || 'Scan could not be synced';
              const retryDuplicate = Number(retryError.status) === 409 || retryError.data?.duplicate || retryError.data?.upiDuplicate;
              if (retryDuplicate) {
                outcomes.set(recordKey, { remove: true });
                duplicateCount += 1;
                logs.push({
                  partNumber: record.partNumber || record.part,
                  upiId: record.upiId,
                  dealer: record.dealerCode,
                  status: 'duplicate',
                  errorMessage: retryMessage
                });
                handleBarcodeDuplicate(record, retryError.data || { message: retryMessage });
              } else {
                outcomes.set(recordKey, { status: 'failed', message: retryMessage });
                failedCount += 1;
                logs.push({
                  partNumber: record.partNumber || record.part,
                  upiId: record.upiId,
                  dealer: record.dealerCode,
                  status: 'failed',
                  errorMessage: retryMessage
                });
              }
              continue;
            }
          }
          const duplicate = Number(error.status) === 409 || error.data?.duplicate || error.data?.upiDuplicate;
          if (duplicate) {
            outcomes.set(recordKey, { remove: true });
            duplicateCount += 1;
            logs.push({
              partNumber: record.partNumber || record.part,
              upiId: record.upiId,
              dealer: record.dealerCode,
              status: 'duplicate',
              errorMessage: message
            });
            handleBarcodeDuplicate(record, error.data || { message });
          } else if (isRetryableTransportError(error)) {
            outcomes.set(recordKey, { status: 'pending', message });
            pendingCount += 1;
            logs.push({
              partNumber: record.partNumber || record.part,
              upiId: record.upiId,
              dealer: record.dealerCode,
              status: 'pending',
              errorMessage: message
            });
          } else {
            const rejected = [400, 404, 422].includes(Number(error.status))
              || ['invalid', 'rejected'].includes(String(error.data?.status || '').toLowerCase());
            outcomes.set(recordKey, rejected ? { remove: true, status: 'rejected', message } : { status: 'failed', message });
            if (rejected) rejectedCount += 1;
            else failedCount += 1;
            logs.push({
              partNumber: record.partNumber || record.part,
              upiId: record.upiId,
              dealer: record.dealerCode,
              status: rejected ? 'rejected' : 'failed',
              errorMessage: message
            });
          }
        }
      }

      const nextQueue = getSyncQueue().flatMap((item) => {
        const itemKey = item.syncKey || item.localId || item.uniqueScanId || item.scanId;
        const outcome = outcomes.get(itemKey);
        if (!outcome) return [item];
        if (outcome.remove) return [];
        return [{
          ...item,
          localStatus: outcome.status,
          syncStatus: outcome.status,
          retryCount: Number(item.retryCount || 0) + 1,
          syncError: outcome.message
        }];
      });
      saveSyncQueue(nextQueue);
      logs.forEach(addSyncLog);

      const syncTime = syncedCount
        ? rememberLastSyncTime(new Date().toISOString())
        : normalizeLastSyncValue(storageGet(scopedStorageKey(LAST_SYNC_KEY)));
      if (syncTime) setText('deviceLastSync', dateTime(syncTime));
      setText('syncTotal', syncedCount);
      const data = {
        success: failedCount === 0,
        message: failedCount
          ? `${failedCount} scan(s) failed. Review the exact reason in Sync Log.`
          : rejectedCount
            ? `${rejectedCount} invalid scan(s) rejected and removed from the pending queue.`
          : pendingCount
            ? `${pendingCount} scan(s) remain pending until the connection is restored.`
            : 'Sync complete',
        insertedRecords,
        insertedCount: syncedCount,
        syncedCount,
        duplicateCount,
        rejectedCount,
        failedCount,
        pendingCount,
        logs,
        completedAt: new Date().toISOString()
      };
      updateSyncBadges(data);
      const remaining = syncCounts();
      const detail = remaining.pending ? 'Pending' : remaining.failed ? 'Failed' : 'Synced';
      const statusOk = !remaining.pending && !remaining.failed;
      setHeaderSyncStatus(detail, statusOk);
      setDashboardSyncStatus(detail, statusOk);
      await refreshAfterSync(data);
      if (!options.silent) toast(data.message, failedCount || rejectedCount ? 'error' : pendingCount ? 'warning' : 'success');
      return data;
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

  function initialReportType() {
    const requested = new URLSearchParams(window.location.search).get('reportType') || '';
    if (REPORT_TITLES[requested]) return requested;

    try {
      const saved = JSON.parse(localStorage.getItem(REPORT_STATE_KEY) || 'null');
      if (saved && REPORT_TITLES[saved.reportType]) return saved.reportType;
    } catch (error) {
      // A malformed saved preference should not stop the report workspace from opening.
    }

    const current = activeReportType();
    if (current) return current;
    if (REPORT_TITLES[state.lastReportType]) return state.lastReportType;
    return Object.keys(REPORT_TITLES)[0];
  }

  function isProductGroupSummaryReport(reportType = activeReportType()) {
    return reportType === 'product-group-summary';
  }

  function setReportProductGroupSummaryVisible(visible) {
    const summaryCard = $('.report-product-summary-card');
    const previewCard = $('#reportPreviewCard');
    if (summaryCard) summaryCard.hidden = !visible;
    if (previewCard) previewCard.hidden = Boolean(visible);
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

  function smartBinSettingsNodes() {
    return {
      enabled: $('#smartBinSuggestionToggle'),
      allowMultipleLocations: $('#smartBinAllowMultipleLocationsToggle'),
      requireReason: $('#smartBinRequireReasonToggle'),
      maxAllowedLocationsPerPart: $('#smartBinMaxLocationsInput'),
      status: $('#smartBinSettingsStatus')
    };
  }

  function renderSmartBinSettingsUi() {
    const { enabled, allowMultipleLocations, requireReason, maxAllowedLocationsPerPart, status } = smartBinSettingsNodes();
    const settings = state.smartBinSettings || { enabled: true, allowMultipleLocations: true, requireReason: true, maxAllowedLocationsPerPart: 3 };
    if (enabled) enabled.checked = Boolean(settings.enabled);
    if (allowMultipleLocations) allowMultipleLocations.checked = Boolean(settings.allowMultipleLocations);
    if (requireReason) requireReason.checked = Boolean(settings.requireReason);
    if (maxAllowedLocationsPerPart) maxAllowedLocationsPerPart.value = String(Number(settings.maxAllowedLocationsPerPart || 3));
    if (status) {
      status.textContent = settings.enabled
        ? `ON${settings.allowMultipleLocations ? ' · Multi-location' : ' · Single-location'}${settings.requireReason ? ' · Reason required' : ' · Reason optional'} · Max ${Number(settings.maxAllowedLocationsPerPart || 3)}`
        : 'OFF';
    }
  }

  async function loadSmartBinSuggestionSettings(options = {}) {
    if (!options.force && state.smartBinSettingsLoaded) {
      renderSmartBinSettingsUi();
      return state.smartBinSettings;
    }
    try {
      const data = await api('/api/settings/smart-bin-suggestion');
      state.smartBinSettings = normalizeSmartBinSettings(data);
      state.smartBinSettingsLoaded = true;
    } catch (error) {
      state.smartBinSettings = { enabled: true, allowMultipleLocations: true, requireReason: true, maxAllowedLocationsPerPart: 3 };
      state.smartBinSettingsLoaded = true;
      if (options.log !== false) console.warn('Smart bin settings load failed', error.message);
    }
    renderSmartBinSettingsUi();
    return state.smartBinSettings;
  }

  async function saveSmartBinSuggestionSettings(nextSettings = {}) {
    if (!isAdminUser()) return state.smartBinSettings;
    const payload = {
      enabled: nextSettings.enabled !== undefined
        ? Boolean(nextSettings.enabled)
        : Boolean($('#smartBinSuggestionToggle')?.checked),
      allowMultipleLocations: nextSettings.allowMultipleLocations !== undefined
        ? Boolean(nextSettings.allowMultipleLocations)
        : Boolean($('#smartBinAllowMultipleLocationsToggle')?.checked),
      requireReason: nextSettings.requireReason !== undefined
        ? Boolean(nextSettings.requireReason)
        : Boolean($('#smartBinRequireReasonToggle')?.checked),
      maxAllowedLocationsPerPart: nextSettings.maxAllowedLocationsPerPart !== undefined
        ? Math.max(1, Number.parseInt(String(nextSettings.maxAllowedLocationsPerPart), 10) || 3)
        : Math.max(1, Number.parseInt(String($('#smartBinMaxLocationsInput')?.value || 3), 10) || 3)
    };
    state.smartBinSettingsSaving = true;
    try {
      const data = await api('/api/settings/smart-bin-suggestion', {
        method: 'POST',
        body: payload
      });
      state.smartBinSettings = normalizeSmartBinSettings(data);
      state.smartBinSettingsLoaded = true;
      toast('Smart bin settings saved');
      return state.smartBinSettings;
    } finally {
      state.smartBinSettingsSaving = false;
      renderSmartBinSettingsUi();
    }
  }

  function smartBinPromptNodes() {
    return {
      modal: $('#smartBinSuggestionModal'),
      title: $('#smartBinSuggestionTitle'),
      message: $('#smartBinSuggestionMessage'),
      bins: $('#smartBinExistingBins'),
      selectWrap: $('#smartBinExistingBinSelectWrap'),
      select: $('#smartBinExistingBinSelect'),
      useExisting: $('#smartBinUseExistingBtn'),
      saveNew: $('#smartBinSaveNewBtn'),
      cancel: $('#smartBinCancelBtn')
    };
  }

  function closeSmartBinSuggestionModal(result = null) {
    const { modal } = smartBinPromptNodes();
    if (modal) modal.classList.add('hidden');
    const resolve = smartBinPromptResolver;
    smartBinPromptResolver = null;
    smartBinPromptPayload = null;
    if (resolve) resolve(result);
  }

  function smartBinExistingBinMarkup(existingBins = [], selectedBin = '') {
    if (!Array.isArray(existingBins) || !existingBins.length) {
      return '<div class="muted smart-bin-empty">No existing bin locations found.</div>';
    }
    const selected = cleanDealerCode(selectedBin || (existingBins[0] && existingBins[0].binLocation) || '');
    return existingBins.map((bin) => {
      const binLocation = cleanDealerCode(bin.binLocation || '');
      const active = binLocation === selected;
      return `
      <button type="button" class="smart-bin-bin-row${active ? ' active' : ''}" data-bin="${escapeHtml(binLocation)}" aria-pressed="${active ? 'true' : 'false'}">
        <strong>${escapeHtml(bin.binLocation || '-')} ${bin.locationType ? `<span class="smart-bin-location-type">${escapeHtml(bin.locationType)}</span>` : ''}</strong>
        <span>Qty ${escapeHtml(wholeNumber(bin.qty || 0))}${bin.createdBy ? ` · ${escapeHtml(bin.createdBy)}` : ''}${bin.reason ? ` · ${escapeHtml(bin.reason)}` : ''}</span>
      </button>
    `;
    }).join('');
  }

  function selectSmartBinExistingBin(selectedBin) {
    const { bins, select } = smartBinPromptNodes();
    const selected = cleanDealerCode(selectedBin || '');
    if (!selected) return;
    if (select) select.value = selected;
    smartBinPromptPayload = {
      ...(smartBinPromptPayload || {}),
      selectedBin: selected
    };
    if (bins) {
      $$('#smartBinExistingBins [data-bin]').forEach((row) => {
        const active = cleanDealerCode(row.dataset.bin || '') === selected;
        row.classList.toggle('active', active);
        row.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }
    refreshSmartBinActionLabels(smartBinPromptPayload || {});
  }

  function refreshSmartBinActionLabels(payload = {}) {
    const { useExisting, saveNew, select } = smartBinPromptNodes();
    const existingBin = cleanDealerCode((select && select.value) || payload.selectedBin || payload.existingBin || payload.suggestedBin || payload.primaryBin || '');
    const newBin = cleanDealerCode(payload.newBin || payload.currentBin || payload.binLocation || '');
    if (useExisting) useExisting.textContent = payload.promptOnLastBin ? `Save in ${existingBin === payload.lastBin ? 'same' : 'selected'} bin ${existingBin}` : existingBin ? `Scan in ${existingBin}` : 'Scan in Existing Bin';
    if (saveNew) saveNew.textContent = payload.promptOnLastBin ? `Save in different bin ${newBin}` : newBin ? `Continue with ${newBin}` : 'Continue with Current Bin';
  }

  function renderSmartBinSuggestionModal(payload = {}) {
    const { modal, title, message, bins, selectWrap, select, useExisting } = smartBinPromptNodes();
    if (!modal) return;
    const existingBins = Array.isArray(payload.existingBins) ? payload.existingBins : [];
    const suggestedBin = cleanDealerCode(payload.suggestedBin || (existingBins[0] && existingBins[0].binLocation) || payload.currentBin || '');
    const currentBin = cleanDealerCode(payload.currentBin || '');
    const partNumber = cleanDealerCode(payload.partNumber || '');
    const partDescription = cleanDealerCode(payload.partDescription || payload.partName || '');
    const primaryBin = cleanDealerCode(payload.primaryBin || suggestedBin || currentBin || (existingBins[0] && existingBins[0].binLocation) || '');
    const showSelect = existingBins.length > 1;
    const existingBin = cleanDealerCode(payload.existingBin || suggestedBin || primaryBin || '');
    const newBin = cleanDealerCode(payload.newBin || currentBin || '');
    const promptTitle = cleanDealerCode(payload.promptTitle || 'PART ALREADY AVAILABLE IN OTHER BIN');
    smartBinPromptPayload = {
      ...payload,
      suggestedBin,
      currentBin,
      primaryBin,
      existingBins,
      partDescription,
      existingBin,
      newBin,
      selectedBin: cleanDealerCode(payload.selectedBin || suggestedBin || existingBin || ''),
      promptTitle
    };
    if (title) {
      title.textContent = promptTitle;
    }
    if (message) {
      message.textContent = clean(payload.message || '') || `PART ${partNumber || '-'} IS AVAILABLE IN BIN ${existingBin || '-'}\n\nWill you continue scanning in ${existingBin || '-'} or continue with ${newBin || 'this bin'}?`;
    }
    if (bins) {
      bins.innerHTML = smartBinExistingBinMarkup(existingBins, smartBinPromptPayload.selectedBin);
      $$('#smartBinExistingBins [data-bin]').forEach((row) => {
        row.addEventListener('click', () => selectSmartBinExistingBin(row.dataset.bin || ''));
      });
    }
    if (selectWrap) selectWrap.classList.toggle('hidden', !showSelect);
    if (select) {
      select.innerHTML = existingBins.map((bin) => `<option value="${escapeHtml(bin.binLocation)}">${escapeHtml(bin.binLocation)} · Qty ${escapeHtml(wholeNumber(bin.qty || 0))}</option>`).join('');
      select.value = cleanDealerCode(payload.selectedBin || suggestedBin || (existingBins[0] ? existingBins[0].binLocation : ''));
      select.onchange = () => selectSmartBinExistingBin(select.value || '');
    }
    if (useExisting) useExisting.hidden = !existingBin;
    refreshSmartBinActionLabels(smartBinPromptPayload || {});
    modal.classList.remove('hidden');
  }

  function openSmartBinSuggestionModal(payload = {}) {
    const { modal } = smartBinPromptNodes();
    if (!modal) return Promise.resolve(null);
    if (smartBinPromptResolver) closeSmartBinSuggestionModal(null);
    renderSmartBinSuggestionModal(payload);
    return new Promise((resolve) => {
      smartBinPromptResolver = resolve;
    });
  }

  async function resolveSmartBinSuggestionAction(action, payload = {}) {
    const { select } = smartBinPromptNodes();
    const currentBin = cleanDealerCode(payload.currentBin || '');
    const selectedBin = cleanDealerCode((select && select.value) || payload.suggestedBin || currentBin || '');
    const useExisting = action === 'USE_EXISTING_BIN';
    const saveNew = action === 'SAVE_NEW_BIN';

    if (!useExisting && !saveNew) {
      closeSmartBinSuggestionModal(null);
      return null;
    }

    const finalBin = useExisting ? selectedBin : currentBin;
    const decision = {
      action,
      currentBin,
      selectedBin: finalBin,
      suggestedBin: cleanDealerCode(payload.suggestedBin || payload.primaryBin || selectedBin || ''),
      existingBins: Array.isArray(payload.existingBins) ? payload.existingBins : [],
      decisionBy: String(state.user?.name || state.user?.username || state.user?.email || '').trim(),
      decisionAt: new Date().toISOString(),
      checkedAt: payload.checkedAt || new Date().toISOString()
    };
    if (finalBin) {
      const barcodeBin = $('#barcodeBinLocation');
      if (barcodeBin) barcodeBin.value = finalBin;
      localStorage.setItem(BARCODE_LAST_BIN_KEY, finalBin);
    }
    closeSmartBinSuggestionModal(decision);
    return decision;
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

  function normalizeReportDealerCode(value) {
    const raw = String(value || '').trim();
    const code = cleanDealerCode(raw);
    if (!code || code === 'ALL') return '';
    if (/^(SELECT DEALER|ALL DEALERS|ACTIVE AUDIT|DEALER CODE)$/.test(code)) return '';
    const exactDealer = state.dealers.find((dealer) => cleanDealerCode(dealer.dealerCode) === code);
    if (exactDealer?.dealerCode) return cleanDealerCode(exactDealer.dealerCode);
    const leadingCode = raw.match(/^([A-Za-z0-9_]{3,})\b/);
    if (leadingCode) {
      const leading = cleanDealerCode(leadingCode[1]);
      const leadingDealer = state.dealers.find((dealer) => cleanDealerCode(dealer.dealerCode) === leading);
      if (leadingDealer?.dealerCode) return cleanDealerCode(leadingDealer.dealerCode);
      if (!/^(SELECT|ALL|ACTIVE|DEALER)$/.test(leading)) return leading;
    }
    return code;
  }

  function selectedReportDealerCode() {
    const form = $('#reportFilters');
    const dealerSelect = $('[name="dealerCode"]', form);
    const candidates = [
      dealerSelect?.value || '',
      selectedOptionText(dealerSelect),
      selectedDashboardDealerCode(),
      state.dashboardDealerCode || '',
      activeDealerId(),
      state.activeAudit?.dealerCode || '',
      currentDealerCode()
    ];
    const selectedDealerCode = candidates.map(normalizeReportDealerCode).find(Boolean) || '';
    const selectedDealer = state.dealers.find((dealer) => cleanDealerCode(dealer.dealerCode) === selectedDealerCode);
    return selectedDealer?.dealerCode || selectedDealerCode || '';
  }

  function syncReportDealerSelection() {
    const form = $('#reportFilters');
    const dealerSelect = $('[name="dealerCode"]', form);
    const dealerCode = selectedReportDealerCode();
    if (dealerSelect && dealerCode && normalizeReportDealerCode(dealerSelect.value) !== dealerCode) {
      setDealerSelectValue(dealerSelect, dealerCode);
      syncDealerSelectDisplay(dealerSelect);
    }
    return dealerCode;
  }

  function reportParams() {
    const form = $('#reportFilters');
    const formData = formObject(form);
    const reportType = activeReportType();
    const dealerCode = syncReportDealerSelection();
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
      const reportType = paramsObject.reportType || activeReportType();
      params.set('page', reportType === 'local-parts' ? String(state.localPartsReportPage || 1) : '1');
      params.set('limit', reportType === 'local-parts' ? '50' : '100');
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
    if (reportType === 'local-parts') {
      const cards = [
        ['Total Entries', wholeNumber(movementWiseSummaryValue(summary, ['totalRows']))],
        ['Total Quantity', localPartQuantity(movementWiseSummaryValue(summary, ['grandTotalQuantity']))],
        ['Total MRP Value', money2(movementWiseSummaryValue(summary, ['grandTotalMrpValue']))],
        ['Total DLC Value', money2(movementWiseSummaryValue(summary, ['grandTotalDlcValue']))]
      ];
      panel.innerHTML = cards.map(([label, value]) => `
        <div class="metric mini">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
        </div>
      `).join('');
      panel.hidden = false;
      return;
    }
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
    const localPagination = $('#localPartsReportPagination');
    if (reportType === 'local-parts') {
      state.localPartsReportStale = false;
      state.localPartsReportPage = Number(data.pagination?.page || 1);
      state.localPartsReportTotalPages = Number(data.pagination?.totalPages || 1);
      if (localPagination) localPagination.hidden = false;
      setText('localPartsReportPageInfo', `Page ${state.localPartsReportPage} of ${state.localPartsReportTotalPages}`);
      if ($('#localPartsReportPrev')) $('#localPartsReportPrev').disabled = state.localPartsReportPage <= 1;
      if ($('#localPartsReportNext')) $('#localPartsReportNext').disabled = state.localPartsReportPage >= state.localPartsReportTotalPages;
    } else if (localPagination) {
      localPagination.hidden = true;
    }
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
    if (box && /select dealer code first/i.test(box.textContent || '')) {
      box.className = 'form-message';
      box.textContent = 'Select filters to load report automatically.';
    }
    return true;
  }

  function cancelScheduledReportLoad() {
    clearTimeout(state.reportAutoLoadTimer);
    state.reportAutoLoadTimer = null;
  }

  function scheduleReportLoad(delay = 350, pendingMessage = 'Applying filters...', options = {}) {
    const { autoDownloadExcel = false } = options;
    cancelScheduledReportLoad();
    const params = reportParams();
    if (!params.reportType) return;
    if (!params.dealerCode) {
      resetReportPreview('Select dealer code first to load report automatically.');
      updateReportButtons();
      return;
    }
    syncReportDealerSelection();
    if (state.reportAbortController) state.reportAbortController.abort();
    const message = $('#reportMessage');
    if (message) {
      message.className = 'form-message loading';
      message.textContent = pendingMessage;
    }
    updateReportButtons();
    if (state.reportAbortController) {
      state.reportAbortController.abort('new-report-scheduled');
    }
    const scheduledReportType = params.reportType;
    state.reportAutoLoadTimer = setTimeout(async () => {
      state.reportAutoLoadTimer = null;
      try {
        await loadReport();
        if (autoDownloadExcel && activeReportType() === scheduledReportType && state.reportLoaded) {
          await downloadActiveReportExcel({ silent: true });
        }
      } catch (error) {
        toast(error.message, 'error');
      }
    }, delay);
  }

  function syncReportDealerAfterDealerRefresh() {
    const form = $('#reportFilters');
    if (!form || !$('#reports')?.classList.contains('active')) return;
    const dealerCode = syncReportDealerSelection();
    const dealerSelect = $('[name="dealerCode"]', form);
    if (dealerCode && dealerSelect && normalizeReportDealerCode(dealerSelect.value) !== cleanDealerCode(dealerCode)) {
      setDealerSelectValue(dealerSelect, dealerCode);
      syncDealerSelectDisplay(dealerSelect);
    }
    if (!dealerCode || !activeReportType()) return;
    const message = $('#reportMessage');
    if (message && /select dealer code first/i.test(message.textContent || '')) {
      resetReportPreview('Select filters to load report automatically.');
    }
    if (!state.reportLoading && !state.reportLoaded) {
      scheduleReportLoad(220, 'Loading report...');
    }
  }

  function queueDashboardRefresh() {
    // Dashboard data is refreshed on initial open and by the explicit Refresh button only.
    clearTimeout(state.dashboardRefreshTimer);
    state.dashboardRefreshTimer = null;
  }

  function setScanFormSubmitting(form, submitting) {
    if (!form) return;
    form.dataset.submitting = submitting ? 'true' : 'false';
    const submitButton = form.id === 'localPartForm' ? $('#localPartSaveBtn') : $('button[type="submit"]', form);
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
    const reportType = activeReportType();
    if (isProductGroupSummaryReport(reportType)) {
      return `Product_Group_Summary.${extension}`;
    }
    return `${(REPORT_TITLES[reportType] || 'Report').replace(/\s+/g, '_')}.${extension}`;
  }

  async function downloadActiveReportExcel(options = {}) {
    const { silent = false } = options;
    if (state.reportExcelDownloading) return false;
    if (!validateReportSelection(!silent)) return false;
    if (isProductGroupSummaryReport()) {
      await exportProductGroupSummary();
      return true;
    }
    state.reportExcelDownloading = true;
    updateReportButtons();
    try {
      await downloadGet(reportPath('excel'), reportDownloadName('xlsx'));
      return true;
    } finally {
      state.reportExcelDownloading = false;
      updateReportButtons();
    }
  }

  function updateReportButtons() {
    const reportType = activeReportType();
    const canShow = Boolean(reportType) && validateReportSelection(false);
    const isCsvReport = CSV_REPORT_TYPES.has(reportType);
    const blocksPdfEmail = NO_PDF_EMAIL_REPORT_TYPES.has(reportType);
    const auditPackDealerCode = auditPackDealerCodeValue();
    const auditPackButton = $('#downloadCompleteAuditPackBtn');
    $('#reportShow').disabled = !canShow || state.reportLoading;
    $('#reportRefresh').disabled = !canShow || state.reportLoading;
    $('#reportExcel').disabled = isCsvReport || !canShow || state.reportLoading || state.reportExcelDownloading;
    if ($('#reportPdf')) $('#reportPdf').disabled = isCsvReport || blocksPdfEmail || !state.reportLoaded || state.reportLoading;
    if ($('#reportPrint')) $('#reportPrint').disabled = !state.reportLoaded || state.reportLoading;
    if ($('#reportEmail')) $('#reportEmail').disabled = isCsvReport || blocksPdfEmail || !state.reportLoaded || state.reportLoading;
    if (auditPackButton) {
      auditPackButton.disabled = !auditPackDealerCode || state.auditPackInProgress;
      auditPackButton.title = state.auditPackInProgress
        ? 'Generating audit pack...'
        : (auditPackDealerCode ? 'Download the complete audit pack workbook' : 'Select a dealer code first');
    }
    updateAuditPackGenerateButton();
  }

  function auditPackDealerCodeValue() {
    const dealerCode = cleanDealerCode(
      ($('#reportFilters') && formObject($('#reportFilters')).dealerCode) ||
      (state.activeAudit && state.activeAudit.dealerCode) ||
      activeDealerId() ||
      ''
    );
    return dealerCode === 'ALL' ? '' : dealerCode;
  }

  function auditPackStorageKey() {
    return userScopedStorageKey(AUDIT_PACK_STORAGE_KEY);
  }

  function defaultAuditPackSettings() {
    return {
      reports: [],
      extras: []
    };
  }

  function normalizeAuditPackSettings(settings = {}) {
    const selectedReports = Array.isArray(settings.reports)
      ? settings.reports
      : Object.entries(settings)
        .filter(([key, value]) => AUDIT_PACK_REPORT_KEYS.has(key) && (value === true || value === 'true' || value === 1 || value === '1'))
        .map(([key]) => key);
    const selectedExtras = Array.isArray(settings.extras)
      ? settings.extras
      : Object.entries(settings)
        .filter(([key, value]) => AUDIT_PACK_EXTRA_KEYS.has(key) && (value === true || value === 'true' || value === 1 || value === '1'))
        .map(([key]) => key);
    const reports = Array.from(new Set(selectedReports.filter((key) => AUDIT_PACK_REPORT_KEYS.has(key))));
    const extras = Array.from(new Set(selectedExtras.filter((key) => AUDIT_PACK_EXTRA_KEYS.has(key))));
    return { reports, extras };
  }

  function readAuditPackSettings() {
    try {
      return normalizeAuditPackSettings(JSON.parse(storageGet(auditPackStorageKey()) || 'null') || {});
    } catch (error) {
      return defaultAuditPackSettings();
    }
  }

  function saveAuditPackSettings(settings = state.auditPackSettings || defaultAuditPackSettings()) {
    const normalized = normalizeAuditPackSettings(settings);
    state.auditPackSettings = normalized;
    storageSet(auditPackStorageKey(), JSON.stringify(normalized));
    return normalized;
  }

  function auditPackDealerCode() {
    const form = $('#reportFilters');
    const formData = form ? formObject(form) : {};
    const dealerCode = cleanDealerCode(
      formData.dealerCode ||
      (state.activeAudit && state.activeAudit.dealerCode) ||
      activeDealerId() ||
      ''
    );
    return dealerCode === 'ALL' ? '' : dealerCode;
  }

  function auditPackSelectedReportKeys() {
    return $$('#completeAuditPackReports input[type="checkbox"]:checked')
      .map((box) => String(box.value || '').trim())
      .filter((key) => AUDIT_PACK_REPORT_KEYS.has(key));
  }

  function auditPackSelectedExtraKeys() {
    return $$('#completeAuditPackExtras input[type="checkbox"]:checked')
      .map((box) => String(box.value || '').trim())
      .filter((key) => AUDIT_PACK_EXTRA_KEYS.has(key));
  }

  function auditPackSelectedCount() {
    return Array.isArray(state.auditPackSettings?.reports)
      ? state.auditPackSettings.reports.length
      : auditPackSelectedReportKeys().length;
  }

  function auditPackSelectedCountText(count = auditPackSelectedCount()) {
    const total = Math.max(0, Number(count || 0));
    return `${wholeNumber(total)} Report${total === 1 ? '' : 's'} Selected`;
  }

  function updateAuditPackSelectedCount(count = auditPackSelectedCount()) {
    const node = $('#completeAuditPackSelectedCount');
    if (node) node.textContent = auditPackSelectedCountText(count);
  }

  function auditPackMatchesSearch(item = {}, searchTerm = '') {
    const term = String(searchTerm || '').trim().toLowerCase();
    if (!term) return true;
    const haystack = [
      item.key,
      item.label,
      item.group
    ].map((value) => String(value || '').toLowerCase());
    return haystack.some((value) => value.includes(term));
  }

  function auditPackGroupedReports(searchTerm = '') {
    const lookup = new Map(AUDIT_PACK_REPORTS.map((item) => [item.key, item]));
    return AUDIT_PACK_REPORT_GROUPS.map((group) => {
      const items = group.keys
        .map((key) => lookup.get(key))
        .filter(Boolean)
        .map((item) => {
          const withGroup = { ...item, group: group.title };
          return {
            ...withGroup,
            matchesSearch: auditPackMatchesSearch(withGroup, searchTerm)
          };
        });
      return {
        title: group.title,
        items,
        hasVisibleItems: items.some((item) => item.matchesSearch)
      };
    }).filter((group) => group.items.length);
  }

  function syncAuditPackSettingsFromDom() {
    const settings = normalizeAuditPackSettings({
      reports: auditPackSelectedReportKeys(),
      extras: auditPackSelectedExtraKeys()
    });
    state.auditPackSettings = settings;
    saveAuditPackSettings(settings);
    updateAuditPackSelectedCount(settings.reports.length);
    updateAuditPackGenerateButton();
    return settings;
  }

  function updateAuditPackGenerateButton() {
    const button = $('#completeAuditPackGenerate');
    if (!button) return;
    const settings = state.auditPackSettings || defaultAuditPackSettings();
    const dealerCode = auditPackDealerCode();
    button.disabled = state.auditPackInProgress || !dealerCode;
    button.title = state.auditPackInProgress
      ? 'Generating audit pack...'
      : (!dealerCode ? 'Select a dealer code first' : 'Generate the complete audit pack workbook');
  }

  function renderAuditPackModal(searchTerm = null) {
    const settings = saveAuditPackSettings(state.auditPackSettings || readAuditPackSettings());
    const reportSet = new Set(settings.reports);
    const extraSet = new Set(settings.extras);
    const searchInput = $('#completeAuditPackSearch');
    const term = searchTerm === null ? String(searchInput?.value || '').trim() : String(searchTerm || '').trim();
    if (searchInput && searchTerm !== null) searchInput.value = term;

    const reportGrid = $('#completeAuditPackReports');
    const extraGrid = $('#completeAuditPackExtras');
    const groups = auditPackGroupedReports(term);
    const hasVisibleReports = groups.some((group) => group.hasVisibleItems);
    if (reportGrid) {
      reportGrid.innerHTML = groups.length ? groups.map((group) => `
        <section class="audit-pack-report-group${group.hasVisibleItems ? '' : ' hidden'}">
          <h4 class="audit-pack-report-group-title">${escapeHtml(group.title)}</h4>
          <div class="audit-pack-group-items">
            ${group.items.map((item) => `
              <label class="audit-pack-option${item.matchesSearch ? '' : ' hidden'}">
                <input type="checkbox" value="${escapeHtml(item.key)}" ${reportSet.has(item.key) ? 'checked' : ''}>
                <span>${escapeHtml(item.label)}</span>
              </label>
            `).join('')}
          </div>
        </section>
      `).join('') : '';
      if (!hasVisibleReports) {
        reportGrid.innerHTML += '<p class="audit-pack-empty-state">No reports match your search.</p>';
      }
    }
    if (extraGrid) {
      extraGrid.innerHTML = AUDIT_PACK_EXTRA_OPTIONS.map((item) => `
        <label class="audit-pack-option audit-pack-option-soft">
          <input type="checkbox" value="${escapeHtml(item.key)}" ${extraSet.has(item.key) ? 'checked' : ''}>
          <span>${escapeHtml(item.label)}</span>
        </label>
      `).join('');
    }
    updateAuditPackSelectedCount(settings.reports.length);
    updateAuditPackGenerateButton();
  }

  function openAuditPackModal() {
    if (state.auditPackInProgress) return;
    const dealerCode = auditPackDealerCode();
    if (!dealerCode) {
      toast('Select dealer code first', 'error');
      return;
    }
    renderAuditPackModal('');
    $('#completeAuditPackModal')?.classList.remove('hidden');
    $('#completeAuditPackGenerate')?.focus();
  }

  function closeAuditPackModal() {
    $('#completeAuditPackModal')?.classList.add('hidden');
  }

  function clearAuditPackTimers() {
    clearInterval(state.auditPackTimer);
    clearTimeout(state.auditPackCloseTimer);
    state.auditPackTimer = null;
    state.auditPackCloseTimer = null;
  }

  function setAuditPackProgressStepState(activeStep = 0, status = 'loading') {
    const steps = $$('#completeAuditPackProgressSteps li');
    steps.forEach((step, index) => {
      step.classList.remove('active', 'complete', 'error');
      if (status === 'error') {
        if (index < activeStep) step.classList.add('complete');
        else if (index === activeStep) step.classList.add('error');
        return;
      }
      if (status === 'complete') {
        if (index <= activeStep) step.classList.add('complete');
        return;
      }
      if (index < activeStep) step.classList.add('complete');
      else if (index === activeStep) step.classList.add('active');
    });
  }

  function setAuditPackProgress(progress = {}) {
    const percent = Math.max(0, Math.min(100, Number(progress.percent ?? state.auditPackProgress.percent ?? 0)));
    const activeStep = Math.max(0, Math.min(3, Number.isFinite(Number(progress.activeStep)) ? Number(progress.activeStep) : Number(state.auditPackProgress.activeStep || 0)));
    const status = String(progress.status || state.auditPackProgress.status || 'loading').trim() || 'loading';
    const message = String(progress.message ?? state.auditPackProgress.message ?? '').trim() || 'Preparing workbook...';
    state.auditPackProgress = {
      ...state.auditPackProgress,
      ...progress,
      percent,
      activeStep,
      status,
      message
    };
    const fill = $('#completeAuditPackProgressFill');
    if (fill) fill.style.width = `${percent}%`;
    const bar = $('#completeAuditPackProgressModal .audit-pack-progress-bar');
    if (bar) bar.setAttribute('aria-valuenow', String(Math.round(percent)));
    setText('completeAuditPackProgressText', message);
    const action = $('#completeAuditPackProgressAction');
    if (action) action.textContent = status === 'loading' ? 'Cancel' : 'Close';
    setAuditPackProgressStepState(activeStep, status);
  }

  function openAuditPackProgress() {
    clearAuditPackTimers();
    $('#completeAuditPackProgressModal')?.classList.remove('hidden');
    setAuditPackProgress({
      stage: 'preparing',
      percent: 6,
      message: 'Preparing workbook...',
      activeStep: 0,
      status: 'loading'
    });
  }

  function closeAuditPackProgress() {
    clearAuditPackTimers();
    $('#completeAuditPackProgressModal')?.classList.add('hidden');
    state.auditPackInProgress = false;
    state.auditPackAbortController = null;
    state.auditPackProgress = {
      stage: 'idle',
      percent: 0,
      message: '',
      activeStep: 0,
      status: 'idle'
    };
    updateReportButtons();
  }

  function cancelAuditPackGeneration() {
    if (!state.auditPackInProgress) {
      closeAuditPackProgress();
      return;
    }
    state.auditPackRequestId += 1;
    try {
      state.auditPackAbortController?.abort();
    } catch (error) {}
    clearAuditPackTimers();
    state.auditPackInProgress = false;
    state.auditPackAbortController = null;
    setAuditPackProgress({
      stage: 'cancelled',
      percent: Math.max(0, Number(state.auditPackProgress.percent || 0)),
      message: 'Audit pack generation cancelled',
      activeStep: Number(state.auditPackProgress.activeStep || 0),
      status: 'error'
    });
    updateReportButtons();
    state.auditPackCloseTimer = setTimeout(() => {
      closeAuditPackProgress();
    }, 300);
  }

  function collectAuditPackPayload() {
    const form = $('#reportFilters');
    const payload = form ? formObject(form) : {};
    const settings = syncAuditPackSettingsFromDom();
    delete payload.reportType;
    payload.dealerCode = auditPackDealerCode();
    payload.auditId = String(payload.auditId || (state.activeAudit && state.activeAudit.auditId) || '').trim();
    payload.fromDate = String(payload.fromDate || (state.activeAudit && (state.activeAudit.auditStartDate || state.activeAudit.auditDate)) || '').trim();
    payload.toDate = String(payload.toDate || (state.activeAudit && (state.activeAudit.auditClosedDate || state.activeAudit.auditEndDate)) || '').trim();
    payload.includeSummary = true;
    payload.reports = settings.reports;
    AUDIT_PACK_EXTRA_OPTIONS.forEach((item) => {
      payload[item.key] = settings.extras.includes(item.key);
    });
    return payload;
  }

  function auditPackStageForElapsed(elapsedMs) {
    const stages = [
      { at: 0, percent: 8, activeStep: 0, message: 'Preparing workbook...' },
      { at: 650, percent: 22, activeStep: 0, message: 'Validating selection and filters...' },
      { at: 1600, percent: 44, activeStep: 1, message: 'Fetching report data...' },
      { at: 2900, percent: 70, activeStep: 2, message: 'Building workbook sheets...' },
      { at: 8000, percent: 84, activeStep: 2, message: 'Building workbook sheets...' },
      { at: 20_000, percent: 88, activeStep: 3, message: 'Finalizing download...' },
      { at: 45_000, percent: 91, activeStep: 3, message: 'Still generating the workbook. Larger audits can take a little longer...' },
      { at: 90_000, percent: 93, activeStep: 3, message: 'The workbook is taking longer than usual. Please keep this window open...' }
    ];
    let stage = stages[0];
    stages.forEach((candidate) => {
      if (elapsedMs >= candidate.at) stage = candidate;
    });
    const percent = Math.min(94, Math.max(stage.percent, stage.percent + Math.floor((elapsedMs - stage.at) / 350)));
    return { ...stage, percent };
  }

  async function generateAuditPack() {
    if (state.auditPackInProgress) return;
    const payload = collectAuditPackPayload();
    if (!payload.dealerCode) {
      toast('Select dealer code first', 'error');
      return;
    }

    closeAuditPackModal();
    openAuditPackProgress();

    const requestId = ++state.auditPackRequestId;
    state.auditPackInProgress = true;
    state.auditPackAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    updateReportButtons();
    const startedAt = Date.now();
    state.auditPackTimer = setInterval(() => {
      if (requestId !== state.auditPackRequestId || !state.auditPackInProgress) return;
      const stage = auditPackStageForElapsed(Date.now() - startedAt);
      setAuditPackProgress({
        stage: 'loading',
        percent: stage.percent,
        message: stage.message,
        activeStep: stage.activeStep,
        status: 'loading'
      });
    }, 250);

    try {
      const downloadOptions = {
        timeoutMs: 120000,
        ...(state.auditPackAbortController ? { signal: state.auditPackAbortController.signal } : {})
      };
      const fileName = await downloadPost('/api/reports/download-complete-audit-pack', payload, undefined, downloadOptions);
      if (requestId !== state.auditPackRequestId) return;
      clearAuditPackTimers();
      state.auditPackInProgress = false;
      state.auditPackAbortController = null;
      setAuditPackProgress({
        stage: 'complete',
        percent: 100,
        message: fileName ? `Download started: ${fileName}` : 'Download started',
        activeStep: 3,
        status: 'complete'
      });
      updateReportButtons();
      toast('Audit pack download started', 'success');
      state.auditPackCloseTimer = setTimeout(() => {
        if (requestId !== state.auditPackRequestId) return;
        closeAuditPackProgress();
      }, 900);
    } catch (error) {
      if (requestId !== state.auditPackRequestId) return;
      clearAuditPackTimers();
      state.auditPackInProgress = false;
      state.auditPackAbortController = null;
      updateReportButtons();
      if (error && error.name === 'AbortError') {
        setAuditPackProgress({
          stage: 'cancelled',
          percent: Math.max(0, Number(state.auditPackProgress.percent || 0)),
          message: 'Audit pack generation cancelled',
          activeStep: Number(state.auditPackProgress.activeStep || 0),
          status: 'error'
        });
        state.auditPackCloseTimer = setTimeout(() => {
          if (requestId !== state.auditPackRequestId) return;
          closeAuditPackProgress();
        }, 250);
        return;
      }
      const message = error.message || 'Audit Pack generation failed. Please try again.';
      setAuditPackProgress({
        stage: 'error',
        percent: Math.max(0, Number(state.auditPackProgress.percent || 0)),
        message,
        activeStep: Number(state.auditPackProgress.activeStep || 0),
        status: 'error'
      });
      toast(message, 'error');
    }
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
    setText('reportPartCount', 'Total Parts: 0');
    const box = $('#reportMessage');
    if (box) {
      box.className = 'form-message';
      box.textContent = message;
    }
    if (isProductGroupSummaryReport()) {
      clearProductGroupSummaryState();
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
    return { layout: 'full', width: '100%', height: 'auto', columnWidths: {}, columnOrder: [] };
  }

  function normalizeReportLayoutPrefs(prefs = {}) {
    const normalized = { ...defaultReportLayout(), ...(prefs || {}) };
    const height = String(normalized.height || '').trim();
    const isCustomHeight = /^\d+(\.\d+)?px$/i.test(height);
    const isLegacyDefault = !height || height === 'calc(100vh - 360px)';
    if (isLegacyDefault || (!isCustomHeight && height !== 'auto')) {
      normalized.height = normalized.layout === 'compact' ? '440px' : 'auto';
    } else if (normalized.layout === 'compact' && !isCustomHeight) {
      normalized.height = '440px';
    }
    return normalized;
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

  function updateReportPartCount(rows = [], totalRows = 0) {
    const requestedTotal = Number(totalRows);
    const count = Number.isFinite(requestedTotal) && requestedTotal >= 0 ? requestedTotal : (rows || []).length;
    setText('reportPartCount', `Total Parts: ${wholeNumber(count)}`);
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
      const sortStateClass = isSorted ? `is-${sort.direction}` : 'is-none';
      return `<th class="${reportColumnClass(column, index)} ${isSorted ? `sorted-${escapeHtml(sort.direction)}` : ''}" draggable="true" data-col-index="${index}" data-col-key="${escapeHtml(key)}" aria-sort="${escapeHtml(direction)}" style="width:${width}px;text-align:left"><button type="button" class="report-sort-button" title="Sort ${escapeHtml(column.header)}" aria-label="Sort ${escapeHtml(column.header)}" style="justify-content:flex-start;text-align:left"><span class="report-th-content" style="text-align:left">${escapeHtml(column.header)}</span><span class="report-sort-indicator ${escapeHtml(sortStateClass)}" aria-hidden="true"><span class="report-sort-caret report-sort-up"></span><span class="report-sort-caret report-sort-down"></span></span><span class="sr-only">${escapeHtml(sortLabel)}</span></button><span class="report-col-resize" role="separator" aria-label="Resize column. Double click to auto fit."></span></th>`;
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
    updateReportPartCount(rows || [], state.reportTableTotalRows);
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
    const useCache = options.useCache === true;
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
    if (isProductGroupSummaryReport(reportType)) {
      const message = $('#reportMessage');
      const requestId = Date.now();
      state.reportLoadRequestId = requestId;
      if (state.reportAbortController) state.reportAbortController.abort('new-report-load');
      const reportController = typeof AbortController !== 'undefined' ? new AbortController() : null;
      state.reportAbortController = reportController;
      state.reportLoading = true;
      state.lastReportType = reportType;
      saveReportState(true);
      setReportProductGroupSummaryVisible(true);
      state.reportTableRows = [];
      state.reportTableColumns = [];
      state.reportTableTotalRows = 0;
      state.reportTableGrandTotal = null;
      state.reportTableSummary = null;
      state.reportTableSections = null;
      setProductGroupSummaryLoading();
      $('#reportHead').innerHTML = '';
      $('#reportRows').innerHTML = '<tr><td class="muted" colspan="12">Loading product group summary...</td></tr>';
      if ($('#reportTableSearch')) $('#reportTableSearch').value = '';
      setText('reportCount', 'Loading...');
      $('#reportShow').disabled = true;
      if (showLoading && message) {
        message.className = 'form-message loading';
        message.textContent = 'Loading product group summary...';
      }
      try {
        const rows = await loadDashboardProductGroupSummary({ force: true, signal: reportController ? reportController.signal : undefined });
        if (state.reportLoadRequestId !== requestId) return;
        state.reportLoaded = true;
        state.reportHasRun = true;
        renderProductGroupSummary();
        renderProductGroupDetails({ rows: [], totals: {} });
        if (message) {
          message.className = 'form-message success';
          message.textContent = `Loaded ${wholeNumber(Array.isArray(rows) ? rows.length : (state.dashboardProductGroupRows || []).length)} product group rows.`;
        }
      } catch (error) {
        if (state.reportLoadRequestId !== requestId) return;
        if (error.name === 'AbortError') return;
        state.reportLoaded = false;
        state.reportHasRun = false;
        clearProductGroupSummaryState();
        if (message) {
          message.className = 'form-message error';
          message.textContent = error.message || 'Product group summary failed';
        }
        toast(error.message || 'Product group summary failed', 'error');
      } finally {
        if (state.reportLoadRequestId === requestId) {
          state.reportLoading = false;
          if (state.reportAbortController === reportController) state.reportAbortController = null;
        }
        updateReportButtons();
      }
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
    if (state.reportAbortController) state.reportAbortController.abort('new-report-load');
    const reportController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    state.reportAbortController = reportController;
    state.reportLoading = true;
    state.lastReportType = reportType;
    saveReportState(true);
    $('#reportTitle').textContent = REPORT_TITLES[reportType];
    const reportTitle = REPORT_TITLES[reportType] || 'Report';
    $('#reportTitle').textContent = reportTitle;
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
      const data = await api(url, {
        ...(reportController ? { signal: reportController.signal } : {}),
        timeoutMs: REPORT_PREVIEW_TIMEOUT_MS
      });
      if (state.reportLoadRequestId !== requestId) return;
      if (useCache) rememberReportCache(cacheKey, data);
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
        if (state.reportAbortController === reportController) state.reportAbortController = null;
      }
      updateReportButtons();
    }
  }

  function setReportTab(type, options = {}) {
    if (!REPORT_TITLES[type]) return;
    if (type === 'local-parts') {
      state.localPartsReportPage = 1;
      const statusFilter = $('#reportFilters [name="status"]');
      if (statusFilter && !statusFilter.value) statusFilter.value = 'ACTIVE';
    }
    if ($('#localPartsReportPagination')) $('#localPartsReportPagination').hidden = true;
    cancelScheduledReportLoad();
    if (state.reportAbortController) state.reportAbortController.abort('report-tab-changed');
    state.reportLoadRequestId = Date.now();
    state.reportLoading = false;
    state.reportAbortController = null;
    state.lastReportType = type;
    if ($('#reportTypeSelect')) $('#reportTypeSelect').value = type;
    $$('.report-tab').forEach((button) => button.classList.toggle('active', button.dataset.reportType === type));
    $('#reportTitle').textContent = REPORT_TITLES[type];
    setReportProductGroupSummaryVisible(isProductGroupSummaryReport(type));
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
      setReportTab(initialReportType(), { persist: false });
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
      const horizontalIntent = event.shiftKey || Math.abs(event.deltaX) > Math.max(6, Math.abs(event.deltaY) * 1.25);
      if (!horizontalIntent) return;
      const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (Math.abs(delta) < 4) return;
      event.preventDefault();
      const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      scroller.scrollLeft = Math.min(maxLeft, Math.max(0, scroller.scrollLeft + delta));
    }, { passive: false });
    setReportTab(initialReportType(), { persist: false });
  }

  function readReportLayoutPrefs() {
    try {
      const specific = localStorage.getItem(reportLayoutStorageKey());
      if (specific) return normalizeReportLayoutPrefs(JSON.parse(specific));
      return normalizeReportLayoutPrefs(JSON.parse(localStorage.getItem(REPORT_LAYOUT_KEY) || '{}'));
    } catch (error) {
      return defaultReportLayout();
    }
  }

  function saveReportLayoutPrefs(prefs) {
    localStorage.setItem(reportLayoutStorageKey(), JSON.stringify({ ...readReportLayoutPrefs(), ...prefs }));
  }

  function applyReportLayout(layout, dimensions = {}) {
    // This function is deprecated. The report page now uses the standard global layout.
    // The layout is no longer user-configurable to ensure consistency.
    const reports = $('#reports');
    if (!reports) return;
    reports.classList.remove('report-layout-full', 'report-layout-compact', 'report-layout-split', 'report-layout-drag');
    // All pages now use the same layout defined in global-layout.css
    // No dynamic classes or styles are needed here.
  }

  function resetReportLayout() {
    const prefs = readReportLayoutPrefs();
    saveReportLayoutPrefs({ ...prefs, layout: 'full', width: '100%', height: 'auto' });
    applyReportLayout('full', { width: '100%', height: 'auto' });
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
    // This function is deprecated as the layout is no longer user-configurable.
    toast('Report layout saved');
  }

  function initReportLayout() {
    // This function is deprecated. The report layout is now fixed and standardized.
    // The resizable/draggable layout has been removed for consistency.
    const wrap = $('#reportTableWrap');
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
    wrap?.addEventListener('wheel', (event) => {
      if (event.ctrlKey) return;
      const horizontalIntent = event.shiftKey || Math.abs(event.deltaX) > Math.max(6, Math.abs(event.deltaY) * 1.25);
      if (!horizontalIntent) return;
      const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (Math.abs(delta) < 4) return;
      const maxLeft = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
      const nextLeft = Math.min(maxLeft, Math.max(0, wrap.scrollLeft + delta));
      if (nextLeft === wrap.scrollLeft) return;
      event.preventDefault();
      wrap.scrollLeft = nextLeft;
    }, { passive: false });
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

  function reconciliationNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function setReconciliationSummary(summary = {}, stats = state.reconDashboardStats, rowCount = state.reconRows.length) {
    const dmsQty = reconciliationNumber(summary.totalDmsStockQty ?? summary.dmsStock, 0);
    const actualQty = reconciliationNumber(summary.totalActualScannedQty ?? summary.physicalStock ?? summary.actualStock, 0);
    const netVariance = reconciliationNumber(summary.netDifference, actualQty - dmsQty);
    const coverage = dmsQty > 0 ? (actualQty / dmsQty) * 100 : 0;
    const partLineCount = dealerStockSummaryCount({
      partLineCount: summary.totalPartsUploaded ?? stats?.dealerStockPartLines ?? stats?.uploadedPartLineCount
    });
    const stockValue = reconciliationNumber(
      stats?.systemStockValue ?? stats?.dealerStockValue ?? stats?.masterStockValue ?? stats?.totalSystemValue ?? summary.totalInventoryValue,
      0
    );
    const scanValue = reconciliationNumber(
      stats?.actualStockValueDLC ?? stats?.totalScannedValue ?? summary.actualStockValueDLC ?? summary.actualStockValueMRP,
      0
    );
    const totalRows = Math.max(0, Math.trunc(reconciliationNumber(rowCount, 0)));

    setText('dealerStockUploadedLineCount', wholeNumber(partLineCount));
    setText('dealerStockUploadedDmsQty', wholeNumber(dmsQty));
    setText('dealerStockUploadedSystemValue', `₹ ${money2(stockValue)}`);
    setText('reconScanValue', `₹ ${money2(scanValue)}`);
    setText('reconPhysical', wholeNumber(actualQty));
    setText('reconNet', wholeNumber(netVariance));
    setText('reconQuantityCoverage', `${coverage.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`);
    setText('reconMatched', wholeNumber(summary.totalMatchedParts || 0));
    setText('reconShortageParts', wholeNumber(summary.totalShortageParts || 0));
    setText('reconExcessParts', wholeNumber(summary.totalExcessParts || 0));
    setText('reconTotalRows', wholeNumber(totalRows));
    setText('reconSummaryLastUpdated', state.reconLastUpdatedAt ? compactDateTime(state.reconLastUpdatedAt) : '-');

    setText('reconSummaryPartsUploaded', wholeNumber(summary.totalPartsUploaded || 0));
    setText('reconSummaryDms', wholeNumber(dmsQty));
    setText('reconSummaryPhysical', wholeNumber(actualQty));
    setText('reconSummaryMatched', wholeNumber(summary.totalMatchedParts || 0));
    setText('reconSummaryShortageParts', wholeNumber(summary.totalShortageParts || 0));
    setText('reconSummaryExcessParts', wholeNumber(summary.totalExcessParts || 0));
    setText('reconSummaryFast', wholeNumber(summary.totalFastMovingParts || 0));
    setText('reconSummarySlow', wholeNumber(summary.totalSlowMovingParts || 0));
    setText('reconSummaryDead', wholeNumber(summary.totalDeadStockParts || 0));
    setText('reconSummaryInventoryValue', money2(summary.totalInventoryValue || 0));
    setText('reconSummaryShortageValue', money2(summary.totalShortageValue || 0));
    setText('reconSummaryExcessValue', money2(summary.totalExcessValue || 0));
    setText('reconSummaryNotInDms', wholeNumber(summary.totalScannedButNotInDms || 0));
    setText('reconSummaryExcess', wholeNumber(summary.excess || 0));
    setText('reconSummaryShort', wholeNumber(summary.short || 0));
    setText('reconSummaryNet', wholeNumber(summary.netDifference || 0));
    setText('reconSummaryMrp', money2(summary.varianceMrp || 0));
    setText('reconSummaryDlc', money2(summary.varianceDlc || 0));
  }

  function dealerStockSummaryCount(summary = {}) {
    return Math.max(0, Math.trunc(Number(
      summary.partLineCount ??
      summary.totalPartsUploaded ??
      summary.rows ??
      summary.total ??
      summary.savedCount ??
      0
    ) || 0));
  }

  function dealerStockLineRangeText(total) {
    const count = dealerStockSummaryCount({ partLineCount: total });
    return count > 0 ? `1-${count}` : '0';
  }

  function dealerStockPreviewRangeText(total, visible) {
    const count = dealerStockSummaryCount({ partLineCount: total });
    const shown = Math.min(count, Math.max(0, Math.trunc(Number(visible || 0) || 0)));
    return count > 0 && shown > 0 ? `1-${shown} of ${count}` : `0 of ${count}`;
  }

  function setDealerStockUploadSummary(summary = {}) {
    const partLineCount = dealerStockSummaryCount(summary);
    const dmsStock = Number(summary.totalDmsStockQty ?? summary.dmsStockQty ?? summary.dmsStock ?? 0);
    const scopedStats = state.reconDashboardStats
      && cleanDealerCode(state.reconDashboardStats.dealerCode || '') === activeReconDealer()
      ? state.reconDashboardStats
      : null;
    const stockValue = Number(
      scopedStats?.systemStockValue ??
      scopedStats?.dealerStockValue ??
      summary.systemStockValue ??
      summary.stockValue ??
      summary.dmsStockValueDLC ??
      summary.totalDmsStockValue ??
      0
    );
    setText('dealerStockUploadedLineCount', wholeNumber(partLineCount));
    setText('dealerStockUploadedLineRange', summary.lineRange?.text || dealerStockLineRangeText(partLineCount));
    setText('dealerStockUploadedDmsQty', wholeNumber(dmsStock));
    setText('dealerStockUploadedSystemValue', `₹ ${money2(stockValue)}`);
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
              <td>${partLink(row.partNumber || row.part || row.normalizedPartNumber || '')}</td>
              <td>${escapeHtml(row.dealerCode || '')}</td>
              <td>${escapeHtml(row.message || '')}</td>
            </tr>
          `).join('')}</tbody>
        </table>
      </div>
    `;
  }

  function renderDealerStockPreview(rows = [], total = rows.length, summary = {}) {
    const safeRows = Array.isArray(rows) ? rows : [];
    const panel = $('#dealerStockPreviewPanel');
    if (panel) panel.hidden = false;
    const totalRows = dealerStockSummaryCount({ partLineCount: summary.partLineCount ?? summary.totalPartsUploaded ?? summary.rows ?? total ?? safeRows.length });
    const fallbackSummary = {
      partLineCount: totalRows,
      dmsStock: safeRows.reduce((sum, row) => sum + Number(row.dmsStock || row.systemQty || 0), 0),
      stockValue: safeRows.reduce((sum, row) => sum + Number(row.stockValue || 0), 0)
    };
    setDealerStockUploadSummary({ ...fallbackSummary, ...summary, partLineCount: totalRows });
    $('#dealerStockPreviewRows').innerHTML = safeRows.map((row) => `
      <tr>
        <td>${escapeHtml(row.dealerCode)}</td>
        <td>${partLink(row.partNumber)}</td>
        <td>${escapeHtml(row.partDescription)}</td>
        <td>${escapeHtml(row.dmsStock || row.systemQty || 0)}</td>
        <td>${escapeHtml(row.binLoc1 || row.systemBinLoc1 || '')}</td>
        <td>${escapeHtml(row.binLoc2 || row.systemBinLoc2 || '')}</td>
        <td>${escapeHtml(row.binLoc3 || row.systemBinLoc3 || '')}</td>
      </tr>
    `).join('') || '<tr><td colspan="7" class="muted">No dealer stock uploaded yet</td></tr>';
    enhanceDataTable($('#dealerStockPreviewTable'), 'daksh_table_dealer_stock_preview');
    const message = $('#dealerStockUploadMessage');
    if (message && safeRows.length) {
      message.className = 'form-message success';
      message.textContent = `Preview showing ${dealerStockPreviewRangeText(totalRows, safeRows.length)} DMS stock row(s).`;
    }
  }

  async function loadDealerStockPreview() {
    const dealerCode = activeReconDealer();
    if (!dealerCode || dealerCode === 'ALL') throw new Error('Select Dealer Code first');
    const data = await api(`/api/reconciliation/stock-preview?dealerCode=${encodeURIComponent(dealerCode)}`);
    renderDealerStockPreview(data.stock || [], data.total || 0, data.summary || {});
    renderDealerStockErrors([]);
    const message = $('#dealerStockUploadMessage');
    if (message) {
      message.className = (data.stock || []).length ? 'form-message success' : 'form-message';
      const lineRange = data.summary?.lineRange?.text || dealerStockLineRangeText(data.total || 0);
      message.textContent = (data.stock || []).length ? `Loaded ${data.total || 0} uploaded DMS stock row(s) for ${dealerCode}. Line range ${lineRange}.` : `No uploaded DMS stock found for ${dealerCode}.`;
    }
    loadReconciliation({ silent: true }).catch(() => undefined);
    return data;
  }

  async function uploadDealerStock(form, messageSelector = '#dealerStockUploadMessage') {
    if (form.dataset.uploading === 'true') return null;
    form.dataset.uploading = 'true';
    const submitButton = form.querySelector('[type="submit"]');
    if (submitButton) submitButton.disabled = true;
    const dealerCode = cleanDealerCode($('[name="dealerCode"]', form)?.value || '');
    const message = $(messageSelector);
    try {
      if (!dealerCode) throw new Error('Select Dealer Code first');
      if (message) {
        message.className = 'form-message loading';
        message.textContent = 'Uploading Dealer Stock...';
      }
      const uploadId = window.crypto?.randomUUID ? window.crypto.randomUUID() : `stock-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      state.dealerStockUploadId = uploadId;
      const uploadBody = new FormData(form);
      uploadBody.set('progressId', uploadId);
      const data = await api('/api/reconciliation/upload-stock', { method: 'POST', body: uploadBody });
      syncReconDealer(data.dealerCode || dealerCode);
      renderDealerStockPreview(data.preview || [], data.savedCount || 0, data.summary || {});
      renderDealerStockErrors(data.errorRows || [], data.skippedCount || 0, data.errorRowsTruncated);
      if (message) {
        message.className = 'form-message success';
        const lineRange = data.summary?.lineRange?.text || dealerStockLineRangeText(data.savedCount || 0);
        message.textContent = data.message || `Saved ${data.savedCount || 0} DMS stock row(s). Line range ${lineRange}.`;
      }
      loadReconciliation({ silent: true }).catch(() => undefined);
      toast('Dealer DMS stock saved');
      return data;
    } finally {
      state.dealerStockUploadId = '';
      form.dataset.uploading = 'false';
      if (submitButton) submitButton.disabled = false;
    }
  }

  function syncReconDealer(dealerCode) {
    const value = cleanDealerCode(dealerCode || '');
    ['#reconDealer', '#dealerStockDealer'].forEach((selector) => {
      const select = $(selector);
      if (select) select.value = value;
    });
  }

  function activateReconciliationTab(target) {
    const targetTab = $(`.recon-tab[data-recon-tab="${target}"]`);
    if (!targetTab || !document.getElementById(target)) return;
    $$('.recon-tab').forEach((item) => {
      const active = item === targetTab;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
    });
    $$('.recon-panel').forEach((panel) => {
      const active = panel.id === target;
      panel.classList.toggle('active', active);
      panel.hidden = !active;
    });
  }

  async function deleteDealerStock() {
    const dealerCode = activeReconDealer();
    if (!dealerCode || dealerCode === 'ALL') throw new Error('Select Dealer Code first');
    if (!window.confirm(`Delete old DMS stock for dealer ${dealerCode}?`)) return;
    const data = await api(`/api/reconciliation/stock?dealerCode=${encodeURIComponent(dealerCode)}`, { method: 'DELETE' });
    renderDealerStockPreview([]);
    renderDealerStockErrors([]);
    state.reconRows = [];
    state.reconDashboardStats = null;
    state.reconLastUpdatedAt = null;
    setDealerStockUploadSummary({});
    setReconciliationSummary({}, null, 0);
    renderReconciliationRows();
    toast(data.message || 'Dealer stock deleted');
  }

  async function reprocessReconciliation() {
    const dealerCode = activeReconDealer();
    if (!dealerCode || dealerCode === 'ALL') throw new Error('Select Dealer Code first');
    const data = await api(`/api/reconciliation/reprocess?dealerCode=${encodeURIComponent(dealerCode)}`, { method: 'POST', body: {} });
    setReconciliationSummary(data.summary || {});
    await loadReconciliation({ silent: true });
    toast(data.message || 'Reconciliation reprocessed');
    return data;
  }

  function reconciliationStatusClass(status = '') {
    const text = String(status || '').toLowerCase();
    if (/matched/.test(text)) return 'matched';
    if (/shortage/.test(text)) return 'shortage';
    if (/excess/.test(text)) return 'excess';
    if (/manual|not in dms|new/.test(text)) return 'manual';
    return '';
  }

  function reconciliationValue(...values) {
    for (const value of values) {
      if (value === undefined || value === null || value === '') continue;
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
    return 0;
  }

  function renderReconciliationRows() {
    const rows = Array.isArray(state.reconRows) ? state.reconRows : [];
    const totalRows = rows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / state.reconPageSize));
    state.reconPage = Math.max(1, Math.min(state.reconPage || 1, totalPages));
    const start = totalRows ? (state.reconPage - 1) * state.reconPageSize : 0;
    const visibleRows = rows.slice(start, start + state.reconPageSize);
    const body = $('#reconRows');
    if (body) {
      body.innerHTML = visibleRows.map((row) => {
        const status = row.status || '';
        const dmsValue = reconciliationValue(row.stockValue, row.dmsStockValue, row.dmsMrpValue);
        const scannedValue = reconciliationValue(row.actualStockValue, row.actualMrpValue, row.finalInventoryValue);
        return `
          <tr>
            <td>${partLink(row.partNumber || row.partNo)}</td>
            <td>${escapeHtml(row.partDescription || row.partName || '')}</td>
            <td>${escapeHtml(row.productCategory || 'Uncategorized')}</td>
            <td>${escapeHtml(wholeNumber(row.dmsStock || 0))}</td>
            <td>${escapeHtml(wholeNumber(row.actualStock ?? row.physicalStock ?? 0))}</td>
            <td>${escapeHtml(wholeNumber(row.variance ?? row.netDifference ?? 0))}</td>
            <td><span class="recon-status ${reconciliationStatusClass(status)}">${escapeHtml(status)}</span></td>
            <td>${escapeHtml(money2(row.mrp || 0))}</td>
            <td>${escapeHtml(money2(row.dlp || row.dlc || 0))}</td>
            <td>${escapeHtml(money2(dmsValue))}</td>
            <td>${escapeHtml(money2(scannedValue))}</td>
            <td>${escapeHtml(row.binLocation || row.bin || '')}</td>
            <td>${escapeHtml(row.movementType || '')}</td>
            <td>${escapeHtml(row.movementStatus || row.fastSlowDeadStatus || '')}</td>
          </tr>
        `;
      }).join('') || '<tr><td colspan="14" class="muted">No reconciliation data found for selected dealer/filter</td></tr>';
    }
    setText('reconReportCount', `(${wholeNumber(totalRows)} records)`);
    setText('reconPageSummary', totalRows ? `Showing ${wholeNumber(start + 1)} to ${wholeNumber(start + visibleRows.length)} of ${wholeNumber(totalRows)} records` : 'Showing 0 of 0 records');
    setText('reconPageInfo', `Page ${wholeNumber(state.reconPage)} of ${wholeNumber(totalPages)}`);
    const previous = $('#reconPrevPage');
    const next = $('#reconNextPage');
    if (previous) previous.disabled = state.reconPage <= 1;
    if (next) next.disabled = state.reconPage >= totalPages;
  }

  async function loadReconciliation(options = {}) {
    const silent = Boolean(options.silent);
    const dealerCode = activeReconDealer();
    const message = $('#reconMessage');
    if (!dealerCode || dealerCode === 'ALL') {
      state.reconRows = [];
      state.reconDashboardStats = null;
      state.reconLastUpdatedAt = null;
      renderReconciliationRows();
      setReconciliationSummary({}, null, 0);
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
    syncReconDealer(dealerCode);
    const params = new URLSearchParams(queryFromForm($('#reconFilters')));
    if (!params.get('dealerCode')) params.set('dealerCode', dealerCode);
    params.set('dealerStockOnly', '1');
    const query = params.toString();
    const dashboardParams = new URLSearchParams();
    dashboardParams.set('dealerCode', dealerCode);
    if (params.get('auditId')) dashboardParams.set('auditId', params.get('auditId'));
    dashboardParams.set('range', 'audit');
    const [data, dashboardData] = await Promise.all([
      api(`/api/reconciliation/report?${query}`),
      api(`/api/scans/dashboard?${dashboardParams.toString()}`).catch(() => null)
    ]);
    const summary = data.summary || {};
    state.reconRows = Array.isArray(data.rows) ? data.rows : [];
    state.reconDashboardStats = dashboardData && dashboardData.stats ? dashboardData.stats : null;
    state.reconLastUpdatedAt = new Date();
    state.reconPage = 1;
    renderReconciliationRows();
    setReconciliationSummary(summary, state.reconDashboardStats, state.reconRows.length);
    if (message && !silent) {
      message.className = state.reconRows.length ? 'form-message success' : 'form-message error';
      message.textContent = state.reconRows.length ? `${state.reconRows.length} reconciliation row(s) loaded.` : (data.message || 'No reconciliation data found for selected filter');
    }
    state.reconLoaded = true;
  }

  function reconciliationExportQuery(format, full = false) {
    const params = new URLSearchParams(queryFromForm($('#reconFilters')));
    params.set('dealerStockOnly', '1');
    params.set('format', format);
    if (full) params.set('full', '1');
    else params.set('report', $('#reconExportType')?.value || 'dealer');
    return params.toString();
  }

  function clearPartSearch(message = '') {
    state.masterSearch = { ...state.masterSearch, q: '', page: 1, limit: 10, total: 0 };
    state.masterSearchRows = [];
    state.partMasterSelected.clear();
    const rows = $('#partMasterRows');
    if (rows) rows.innerHTML = '<tr><td colspan="12" class="muted">No parts loaded</td></tr>';
    $('#partMasterResultsCard').hidden = false;
    $('#partMasterCount').textContent = 'Total Parts: 0';
    $('#partListRange').textContent = '0 - 0 of 0';
    $('#partPageInfo').textContent = 'Page 1 of 1';
    $('#partPageButtons').innerHTML = '';
    $('#partSelectAll').checked = false;
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
    ['partNumber', 'category', 'group', 'year', 'model'].forEach((key) => {
      const value = String(payload[key] || '').trim();
      if (value) params.set(key, value);
    });
    const min = $('#partMrpMinFilter')?.value.trim() || '';
    const max = $('#partMrpMaxFilter')?.value.trim() || '';
    if (min || max) params.set('mrp', min && max ? `${min}-${max}` : min ? `>=${min}` : `<=${max}`);
    params.set('page', String(page));
    params.set('limit', String(state.masterSearch.limit || 10));
    params.set('sort', state.masterSearch.sort || 'partNumber');
    params.set('direction', state.masterSearch.direction || 'asc');
    return params;
  }

  function hasPartSearchFilter() {
    const params = partSearchParams(1);
    return ['partNumber', 'category', 'group', 'year', 'model', 'mrp'].some((key) => params.has(key));
  }

  async function loadParts(page = 1) {
    const params = partSearchParams(page);
    state.masterSearch = { ...state.masterSearch, q: params.get('partNumber') || '', page, limit: state.masterSearch.limit || 10 };
    const box = $('#partSearchMessage');
    if (box) {
      box.className = 'form-message loading';
      box.textContent = hasPartSearchFilter() ? 'Searching master data...' : 'Loading all master parts...';
    }
    const data = await api(`/api/master/search?${params.toString()}`);
    state.masterSearchRows = data.parts || [];
    state.masterSearch.total = Number(data.total || 0);
    $('#partMasterResultsCard').hidden = false;
    $('#partMasterRows').innerHTML = state.masterSearchRows.map((part, index) => {
      const code = String(part.partNumber || part.partNo || '');
      const checked = state.partMasterSelected.has(code) ? 'checked' : '';
      const updated = part.updatedAt || part.uploadedAt || part.createdAt;
      return `<tr><td><input class="part-row-select" type="checkbox" data-part-number="${escapeHtml(code)}" ${checked} aria-label="Select ${escapeHtml(code)}"></td>
        <td>${(page - 1) * state.masterSearch.limit + index + 1}</td><td>${partLink(code)}</td><td>${escapeHtml(part.partDescription || part.partName || '')}</td>
        <td>${escapeHtml(part.productCategory || part.category || '')}</td><td>${escapeHtml(part.productGroup || '')}</td><td>${escapeHtml(part.model || '')}</td>
        <td>${escapeHtml(part.manufacturingYear || part.year || '')}</td><td>${escapeHtml(money(part.mrp))}</td><td>${escapeHtml(money(part.dlc))}</td>
        <td>${updated ? escapeHtml(new Date(updated).toLocaleDateString()) : '—'}</td><td><button class="btn part-row-edit" data-part-number="${escapeHtml(code)}" type="button" aria-label="Edit ${escapeHtml(code)}">✎</button><button class="btn danger-soft part-row-delete" data-part-number="${escapeHtml(code)}" type="button" aria-label="Delete ${escapeHtml(code)}">▣</button></td></tr>`;
    }).join('') || '<tr><td colspan="12" class="muted">No matching master catalogue parts found</td></tr>';
    const totalPages = Math.max(Number(data.totalPages || 1), 1);
    $('#partPageInfo').textContent = `Page ${data.page || page} of ${totalPages} | ${data.total || 0} records`;
    $('#partMasterCount').textContent = `Total Parts: ${wholeNumber(data.total || 0)}`;
    const start = data.total ? (page - 1) * state.masterSearch.limit + 1 : 0;
    const end = Math.min(page * state.masterSearch.limit, Number(data.total || 0));
    $('#partListRange').textContent = `${wholeNumber(start)} - ${wholeNumber(end)} of ${wholeNumber(data.total || 0)}`;
    $('#partPageButtons').innerHTML = Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
      const p = Math.max(1, Math.min(totalPages - 4, page - 2)) + i;
      return `<button class="btn ${p === page ? 'primary' : 'light'} part-page-button" type="button" data-page="${p}">${p}</button>`;
    }).join('');
    $('#partSelectAll').checked = Boolean(state.masterSearchRows.length && state.masterSearchRows.every((part) => state.partMasterSelected.has(String(part.partNumber || part.partNo || ''))));
    $('#partPrevPageBtn').disabled = page <= 1;
    $('#partNextPageBtn').disabled = page >= totalPages;
    if (box) {
      box.className = state.masterSearchRows.length ? 'form-message success' : 'form-message error';
      box.textContent = state.masterSearchRows.length ? `${wholeNumber(data.total || 0)} master part(s) found.` : 'No master parts found';
    }
  }

  function setPartEntryMode(mode, part = {}) {
    const form = $('#partEntryForm');
    if (!form) return;
    form.elements.mode.value = mode;
    form.elements.partNumber.value = part.partNumber || part.partNo || '';
    form.elements.partNumber.readOnly = mode === 'edit';
    form.elements.partDescription.value = part.partDescription || part.partName || '';
    form.elements.category.value = part.productCategory || part.category || '';
    form.elements.productGroup.value = part.productGroup || '';
    form.elements.model.value = part.model || '';
    form.elements.year.value = part.manufacturingYear || part.year || '';
    form.elements.mrp.value = part.mrp ?? '';
    form.elements.dlc.value = part.dlc ?? '';
    $('#partEntryTitle').textContent = mode === 'edit' ? '✎  Edit Part' : '＋  Add New Part';
    $('#cancelPartEditBtn').hidden = mode !== 'edit';
    $('#partEntryCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function csvCell(value) { return `"${String(value ?? '').replace(/"/g, '""')}"`; }

  async function submitPartEntry(event) {
    event.preventDefault();
    if (!isAdminUser()) return toast('Only administrators can add or edit master parts.', 'error');
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    const mode = data.mode;
    const headers = ['Part Number', 'Part Description', 'Category', 'Product Group', 'Model', 'Year', 'MRP', 'DLP'];
    const values = [data.partNumber, data.partDescription, data.category, data.productGroup, data.model, data.year, data.mrp || '0', data.dlc || '0'];
    const file = new File([[headers, values].map((row) => row.map(csvCell).join(',')).join('\n')], 'part-master-entry.csv', { type: 'text/csv' });
    const body = new FormData(); body.append('file', file); body.set('mode', mode === 'edit' ? 'upsert' : 'add-missing');
    try {
      const result = await api('/api/master-catalogue/upload', { method: 'POST', body });
      if (mode === 'add' && Number(result.skippedExistingRowsCount || 0)) throw new Error('That part number already exists. Use Edit Part to change it.');
      form.reset(); setPartEntryMode('add'); await loadParts(1); await loadPartSearchFilters();
      toast(mode === 'edit' ? 'Part updated' : 'Part added', 'success');
    } catch (error) { toast(error.message || 'Could not save part.', 'error'); }
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

  async function downloadCompletePartMaster() {
    if (state.partMasterExportInFlight || state.catalogueUploadInFlight) return;
    const button = $('#downloadCompletePartMasterBtn');
    const status = $('#partMasterExportStatus');
    state.partMasterExportInFlight = true;
    button.disabled = true;
    button.textContent = 'Preparing Download...';
    button.setAttribute('aria-busy', 'true');
    status.hidden = false;
    status.textContent = `Preparing complete Part Master... ${wholeNumber(state.masterCatalogueCount)} records`;
    let objectUrl;
    try {
      const response = await fetch(apiUrl('/api/master-catalogue/export'), {
        credentials: 'include', cache: 'no-store',
        headers: state.token ? { Authorization: `Bearer ${state.token}` } : {}
      });
      if (!response.ok || !String(response.headers.get('content-type') || '').includes('spreadsheetml.sheet')) {
        throw new Error('Complete Part Master could not be downloaded. Please try again or contact administrator.');
      }
      const blob = await response.blob();
      objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = resolveDownloadFileName(response, '/api/master-catalogue/export', 'Daksh_Complete_Part_Master.xlsx');
      document.body.appendChild(link);
      link.click();
      link.remove();
      const count = Number(response.headers.get('x-export-record-count'));
      status.textContent = Number.isFinite(count) ? `Complete Part Master downloaded: ${wholeNumber(count)} records` : 'Complete Part Master downloaded';
    } catch (error) {
      status.textContent = 'Complete Part Master could not be downloaded. Please try again or contact administrator.';
      toast(status.textContent, 'error');
    } finally {
      // Leave the Blob alive while the browser starts saving the attachment.
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      state.partMasterExportInFlight = false;
      button.disabled = Boolean(state.catalogueUploadInFlight);
      button.textContent = 'Download Complete Part Master';
      button.setAttribute('aria-busy', 'false');
    }
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
    const skippedExistingRowsCount = Number(progress.skippedExistingRowsCount ?? 0);
    const skippedMissingRowsCount = Number(progress.skippedMissingRowsCount ?? 0);
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
    if (skippedExistingRowsCount) parts.push(`Existing skipped: ${wholeNumber(skippedExistingRowsCount)}`);
    if (skippedMissingRowsCount) parts.push(`Missing skipped: ${wholeNumber(skippedMissingRowsCount)}`);
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
    const submitButtons = Array.from(document.querySelectorAll('#partUploadForm button[type="submit"]'));
    const deleteReuploadButton = $('#deleteReuploadCatalogueBtn');
    const deleteButton = $('#deleteCatalogueBtn');
    const exportButton = $('#downloadCompletePartMasterBtn');
    const fileInput = $('[name="file"]', form);
    const failedRowsButton = $('#downloadCatalogueFailedRowsBtn');
    if (form) {
      form.classList.toggle('is-uploading', Boolean(busy));
      form.setAttribute('aria-busy', busy ? 'true' : 'false');
    }
    if (fileInput) fileInput.disabled = Boolean(busy);
    submitButtons.forEach((button) => { button.disabled = Boolean(busy); });
    if (deleteReuploadButton) deleteReuploadButton.disabled = Boolean(busy);
    if (deleteButton) deleteButton.disabled = Boolean(busy);
    if (exportButton) exportButton.disabled = Boolean(busy || state.partMasterExportInFlight);
    if (failedRowsButton) failedRowsButton.disabled = Boolean(busy);
    state.catalogueUploadInFlight = Boolean(busy);
    updateAuditPriceRefreshUi();
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
      ['Database insert error', Number(reasons['Database insert error'] || data.databaseInsertErrorCount || 0)],
      ['Already exists in part master', Number(reasons['Already exists in part master'] || data.skippedExistingRowsCount || 0)],
      ['Part not found in master catalogue', Number(reasons['Part not found in master catalogue'] || data.skippedMissingRowsCount || 0)]
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
    const skippedExistingRowsCount = Number(data.skippedExistingRowsCount ?? 0);
    const skippedMissingRowsCount = Number(data.skippedMissingRowsCount ?? 0);
    const modeSkippedRowsCount = Number(data.modeSkippedRowsCount ?? (skippedExistingRowsCount + skippedMissingRowsCount));
    const savedRowsCount = Number(data.savedRowsCount ?? data.importedRowsCount ?? data.importedCount ?? (insertedRowsCount + updatedRowsCount));
    const currentCount = Number(data.currentMasterRecordCount ?? data.finalMasterRecordCount ?? data.masterCatalogueCount ?? savedRowsCount ?? 0);
    const deletedOldRowsCount = Number(data.deletedOldRowsCount ?? 0);
    const deletedPriceHistoryRowsCount = Number(data.deletedPriceHistoryRowsCount ?? 0);
    const accountingGapCount = Number(data.accountingGapCount ?? 0);
    const selectedModeUpload = action === 'missing-upload' || action === 'price-update';
    const accountedClientRows = savedRowsCount + duplicateRowsCount + failedRowsCount + modeSkippedRowsCount;
    const mismatch = selectedModeUpload
      ? Boolean(accountingGapCount) || (fileRowsCount > 0 && accountedClientRows !== fileRowsCount)
      : Boolean(data.rowCountMismatch) || (action !== 'delete' && fileRowsCount > 0 && savedRowsCount !== fileRowsCount);
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
      if (skippedExistingRowsCount) summarySegments.push(`Existing skipped: ${wholeNumber(skippedExistingRowsCount)}`);
      if (skippedMissingRowsCount) summarySegments.push(`Missing skipped: ${wholeNumber(skippedMissingRowsCount)}`);
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
        if (skippedExistingRowsCount) lines.push(`Existing skipped: ${wholeNumber(skippedExistingRowsCount)}`);
        if (skippedMissingRowsCount) lines.push(`Missing skipped: ${wholeNumber(skippedMissingRowsCount)}`);
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
    if (status === 'CLOSED') return 'COMPLETED';
    if (['COMPLETED', 'DRAFT', 'ACTIVE', 'PAUSED', 'LOCKED', 'ARCHIVED', 'IN_PROGRESS'].includes(status)) return status;
    return 'NONE';
  }

  function auditPriceRefreshTarget() {
    const dealerCode = cleanDealerCode($('#auditPriceDealerSelect')?.value || '');
    const dealer = dealerCode && dealerCode !== 'ALL' ? dealerByCode(dealerCode) : null;
    const auditId = String(dealer?.currentAuditId || '').trim();
    const status = String(dealer?.auditStatus || dealer?.status || '').trim().toUpperCase();
    const ongoing = Boolean(auditId && dealer?.active !== false && ['IN_PROGRESS', 'ACTIVE'].includes(status));
    return { dealerCode, dealer, auditId, ongoing };
  }

  function setAuditPriceRefreshMessage(message = '', variant = '') {
    const node = $('#auditPriceRefreshMessage');
    if (!node) return;
    node.hidden = !message;
    node.className = `form-message ${variant}`.trim();
    node.textContent = message;
  }

  function updateAuditPriceRefreshUi() {
    const select = $('#auditPriceDealerSelect');
    if (!select) return;
    const target = auditPriceRefreshTarget();
    const busy = state.auditPriceRefreshInFlight || state.auditPriceScopeLoading;
    select.disabled = Boolean(busy || !isAdminUser());
    syncDealerSelectDisplay(select);
    $('#auditPriceCurrentAudit').value = target.auditId || '';
    $('#auditPriceAuditStatus').value = target.dealer ? (target.ongoing ? 'In Progress' : (target.auditId ? 'Not ongoing' : 'No current audit')) : '';
    const button = $('#refreshAuditPricesBtn');
    button.disabled = Boolean(!isAdminUser() || busy || state.catalogueUploadInFlight || !target.ongoing);
    button.textContent = state.auditPriceRefreshInFlight ? 'Refreshing MRP / DLC...' : 'Refresh MRP / DLC from Master';
    $('#auditPriceRefreshForm').setAttribute('aria-busy', String(Boolean(busy)));
    setText('auditPriceRefreshHint', state.auditPriceScopeLoading ? 'Checking current audit...' : state.catalogueUploadInFlight
      ? 'Wait for the catalogue upload to finish before refreshing audit prices.'
      : !target.dealer ? 'Select one dealer with an ongoing audit.'
        : !target.ongoing ? 'This dealer has no ongoing current audit. Prices cannot be refreshed.'
          : `Refresh applies only to ${formatDealerDisplay(target.dealer)}, audit ${target.auditId}.`);
  }

  function renderAuditPriceDealers() {
    const select = $('#auditPriceDealerSelect');
    if (!select) return;
    const selected = cleanDealerCode(select.value || '');
    select.innerHTML = '<option value="">Select Dealer</option>' + state.dealers.filter((dealer) => !isTestDealer(dealer)).map((dealer) => (
      `<option value="${escapeHtml(dealer.dealerCode)}">${escapeHtml(formatDealerDisplay(dealer))}</option>`
    )).join('');
    select.value = Array.from(select.options).some((option) => option.value === selected) ? selected : '';
    updateAuditPriceRefreshUi();
  }

  async function loadAuditPriceRefreshScope() {
    if (!isAdminUser() || state.auditPriceScopeLoading) return;
    state.auditPriceScopeLoading = true;
    updateAuditPriceRefreshUi();
    try {
      await loadDealers({ force: true });
    } catch (error) {
      setAuditPriceRefreshMessage(`Could not check the current audit: ${error.message}`, 'error');
      throw error;
    } finally {
      state.auditPriceScopeLoading = false;
      updateAuditPriceRefreshUi();
    }
  }

  function refreshViewsAfterAuditPriceRefresh() {
    state.partMasterLookupCache.clear();
    queueRealtimeReportRefresh('manual audit price refresh');
    queueDashboardRefresh(400);
    if ($('#scan')?.classList.contains('active')) queueScanRefresh(400);
  }

  async function refreshAuditPricesFromMaster() {
    if (state.auditPriceRefreshInFlight || state.auditPriceScopeLoading || state.catalogueUploadInFlight) return;
    try {
      if (!isAdminUser()) throw new Error('Only administrators can refresh audit prices.');
      const target = auditPriceRefreshTarget();
      if (!target.dealer || !target.ongoing) throw new Error('Select one dealer with an ongoing current audit.');
      const updateFor = $('input[name="updateFor"]:checked')?.value || 'all';
      const partNumbers = updateFor === 'selected' ? Array.from(state.partMasterSelected) : null;
      if (updateFor === 'selected' && !partNumbers.length) throw new Error('Select one or more parts from the current Part List first.');
      const uploadFile = $('#auditPriceUploadFile')?.files?.[0];
      const source = $('input[name="priceSource"]:checked')?.value || 'master';
      if (source === 'upload' && !uploadFile) throw new Error('Choose a price file to upload.');
      if (!window.confirm(`Refresh saved MRP and DLC for ${updateFor === 'selected' ? `${partNumbers.length} selected part(s)` : 'all matched parts'} in ${formatDealerDisplay(target.dealer)}?\n\nAudit: ${target.auditId}\n\nMatched scans in this audit will use the latest master prices and their valuation totals will change. Continue?`)) return;
      state.auditPriceRefreshInFlight = true;
      updateAuditPriceRefreshUi();
      setAuditPriceRefreshMessage(`Refreshing MRP and DLC for audit ${target.auditId}...`);
      if (source === 'upload') {
        const uploadBody = new FormData(); uploadBody.append('file', uploadFile); uploadBody.set('mode', 'price-only');
        await api('/api/master-catalogue/upload', { method: 'POST', body: uploadBody });
      }
      const data = await api('/api/master-catalogue/refresh-audit-prices', {
        method: 'POST',
        body: { dealerCode: target.dealerCode, auditId: target.auditId, ...(partNumbers ? { partNumbers } : {}) }
      });
      if (!data.success) throw new Error(data.message || 'Audit prices could not be refreshed.');
      refreshViewsAfterAuditPriceRefresh();
      setAuditPriceRefreshMessage(`${data.message || 'Audit prices refreshed.'} Audit: ${target.auditId}. Updated scans: ${wholeNumber(data.updatedScanCount || 0)}. Matched parts: ${wholeNumber(data.matchedPartCount || 0)}.`, 'success');
      toast('Audit MRP and DLC refreshed from master', 'success');
    } catch (error) {
      setAuditPriceRefreshMessage(error.message || 'Audit prices could not be refreshed.', 'error');
      toast(error.message || 'Audit prices could not be refreshed.', 'error');
    } finally {
      state.auditPriceRefreshInFlight = false;
      updateAuditPriceRefreshUi();
    }
  }

  async function editPartEntry(partNumber) {
    const part = state.masterSearchRows.find((row) => String(row.partNumber || row.partNo) === String(partNumber));
    if (!part) return toast('That part is not on the current page. Search for it again.', 'error');
    setPartEntryMode('edit', part);
  }

  async function deletePartEntry(partNumber) {
    if (!isAdminUser()) return toast('Only administrators can remove master parts.', 'error');
    if (!window.confirm(`Remove ${partNumber} from the active Part Master list? Existing audit and inventory history will be preserved.`)) return;
    try {
      await api(`/api/master-catalogue/part/${encodeURIComponent(partNumber)}`, { method: 'DELETE' });
      state.partMasterSelected.delete(String(partNumber));
      await loadParts(state.masterSearch.page || 1);
      await loadPartSearchFilters();
      toast('Part removed from active master list', 'success');
    } catch (error) { toast(error.message || 'Could not remove part.', 'error'); }
  }

  function renderDealerMaster() {
    renderAuditPriceDealers();
    const auditors = auditAssignableUsers();
    const modalAuditorSelect = $('#dealerModalAuditUser');
    if (modalAuditorSelect) {
      const selected = modalAuditorSelect.value;
      modalAuditorSelect.innerHTML = '<option value="">No audit user</option>' + auditors.map((user) =>
        `<option value="${escapeHtml(user.id || user._id || '')}">${escapeHtml(auditUserLabel(user))}</option>`
      ).join('');
      modalAuditorSelect.value = selected;
    }
    const uniqueOptions = (values) => Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const refreshFilterOptions = (selector, values) => {
      const select = $(selector);
      if (!select) return;
      const current = select.value;
      select.innerHTML = '<option value="">All</option>' + values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
      if (values.includes(current)) select.value = current;
    };
    refreshFilterOptions('#dealerFilterBrand', uniqueOptions(state.dealers.map((dealer) => dealer.brand)));
    refreshFilterOptions('#dealerFilterLocation', uniqueOptions(state.dealers.map((dealer) => dealer.location)));
    refreshFilterOptions('#dealerFilterAuditUser', uniqueOptions(state.dealers.map((dealer) => auditUserDisplay(dealer))));

    const selectedCodes = state.dealerMasterSelected;
    const query = String($('#dealerFilterSearch')?.value || '').trim().toLowerCase();
    const brandFilter = $('#dealerFilterBrand')?.value || '';
    const locationFilter = $('#dealerFilterLocation')?.value || '';
    const auditUserFilter = $('#dealerFilterAuditUser')?.value || '';
    const statusFilter = $('#dealerFilterStatus')?.value || '';
    const statusOf = (dealer) => {
      const raw = normalizeAuditWorkflowStatus(dealer.auditStatus || dealer.status || 'NONE');
      if (!dealer.currentAuditId) return dealer.active === false ? 'INACTIVE' : raw === 'COMPLETED' ? 'COMPLETED' : 'NOT_STARTED';
      if (raw === 'NONE') return 'NOT_STARTED';
      return raw;
    };
    let filtered = state.dealers.filter((dealer) => {
      const haystack = [dealer.dealerCode, dealer.dealerName, dealer.location].join(' ').toLowerCase();
      return (!query || haystack.includes(query))
        && (!brandFilter || String(dealer.brand || '') === brandFilter)
        && (!locationFilter || String(dealer.location || '') === locationFilter)
        && (!auditUserFilter || auditUserDisplay(dealer) === auditUserFilter)
        && (!statusFilter || statusOf(dealer) === statusFilter);
    });
    const { key, direction } = state.dealerMasterSort;
    filtered.sort((a, b) => {
      const left = key === 'auditStatus' ? statusOf(a) : key === 'auditorName' ? auditUserDisplay(a) : a[key];
      const right = key === 'auditStatus' ? statusOf(b) : key === 'auditorName' ? auditUserDisplay(b) : b[key];
      const compare = key === 'createdAt'
        ? new Date(left || 0).getTime() - new Date(right || 0).getTime()
        : String(left || '').localeCompare(String(right || ''), undefined, { numeric: true, sensitivity: 'base' });
      return direction === 'asc' ? compare : -compare;
    });
    const pageSize = 10;
    const total = filtered.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    state.dealerMasterPage = Math.min(state.dealerMasterPage, pageCount);
    const start = total ? (state.dealerMasterPage - 1) * pageSize : 0;
    const pageRows = filtered.slice(start, start + pageSize);
    $('#dealerMasterRows').innerHTML = pageRows.length ? pageRows.map((dealer, index) => {
      const code = String(dealer.dealerCode || '');
      const status = statusOf(dealer);
      const normalized = status;
      const statusInfo = {
        ACTIVE: ['Active', 'active'], IN_PROGRESS: ['In Progress', 'in-progress'], COMPLETED: ['Completed', 'completed'],
        PAUSED: ['Paused', 'paused'], LOCKED: ['Locked', 'locked'], NOT_STARTED: ['Not Started', 'not-started'], INACTIVE: ['Inactive', 'inactive']
      }[normalized] || [normalized.replace(/_/g, ' '), 'not-started'];
      const createdDate = dealer.createdAt ? new Date(dealer.createdAt) : null;
      const created = createdDate && !Number.isNaN(createdDate.getTime())
        ? `${String(createdDate.getDate()).padStart(2, '0')}-${String(createdDate.getMonth() + 1).padStart(2, '0')}-${createdDate.getFullYear()}`
        : '-';
      return `<tr class="${selectedCodes.has(code) ? 'dealer-row-selected' : ''}">
        <td><input class="dealer-row-select" type="checkbox" data-code="${escapeHtml(code)}" aria-label="Select ${escapeHtml(dealer.dealerName || code)}" ${selectedCodes.has(code) ? 'checked' : ''}></td>
        <td>${start + index + 1}</td><td>${escapeHtml(code)}</td><td>${escapeHtml(dealer.dealerName || '-')}</td>
        <td>${escapeHtml(dealer.brand || '-')}</td><td>${escapeHtml(dealer.location || '-')}</td>
        <td>${escapeHtml(auditUserDisplay(dealer) || '-')}</td><td><span class="dealer-status-badge ${statusInfo[1]}">${statusInfo[0]}</span></td>
        <td>${escapeHtml(created)}</td><td class="dealer-row-actions">
          <button class="dealer-icon-btn edit dealer-row-edit" type="button" data-code="${escapeHtml(code)}" aria-label="Edit dealer ${escapeHtml(code)}">✎</button>
          <button class="dealer-icon-btn delete dealer-row-delete" type="button" data-code="${escapeHtml(code)}" data-name="${escapeHtml(dealer.dealerName || code)}" aria-label="Deactivate dealer ${escapeHtml(code)}">🗑</button>
          <select class="dealer-audit-action" data-code="${escapeHtml(code)}" data-audit-id="${escapeHtml(dealer.currentAuditId || '')}" aria-label="Audit actions for ${escapeHtml(code)}">
            <option value="">Audit Actions</option><option value="start">Start New Audit</option>
            ${['ACTIVE', 'IN_PROGRESS'].includes(status) && dealer.currentAuditId ? '<option value="complete">Complete Current Audit</option><option value="lock">Lock Current Audit</option>' : ''}
            ${status === 'COMPLETED' && dealer.currentAuditId ? '<option value="reopen">Reopen Historical Audit</option>' : ''}
          </select>
        </td></tr>`;
    }).join('') : '<tr><td colspan="10" class="muted">No dealers match these filters.</td></tr>';
    $('#dealerListCount').textContent = `Total Dealers: ${state.dealers.length}`;
    const range = total ? `${start + 1} - ${Math.min(start + pageSize, total)} of ${total}` : `0 - 0 of 0`;
    $('#dealerListRange').textContent = range;
    $('#dealerPaginationCount').textContent = range;
    const pageButtons = $('#dealerPageButtons');
    pageButtons.innerHTML = Array.from({ length: pageCount }, (_, index) => {
      const page = index + 1;
      return `<button class="dealer-page-btn ${page === state.dealerMasterPage ? 'active' : ''}" type="button" data-page="${page}" aria-current="${page === state.dealerMasterPage ? 'page' : 'false'}">${page}</button>`;
    }).join('');
    $('#dealerPrevPage').disabled = state.dealerMasterPage <= 1;
    $('#dealerNextPage').disabled = state.dealerMasterPage >= pageCount;
    $('#dealerSelectVisible').checked = pageRows.length > 0 && pageRows.every((dealer) => selectedCodes.has(String(dealer.dealerCode || '')));
    $('#dealerSelectVisible').indeterminate = pageRows.some((dealer) => selectedCodes.has(String(dealer.dealerCode || ''))) && !$('#dealerSelectVisible').checked;
  }

  function editDealerMaster(dealerCode) {
    const dealer = dealerByCode(dealerCode);
    if (!dealer) return toast('Dealer not found', 'error');
    const form = $('#dealerModalForm');
    form.reset();
    $('[name="mode"]', form).value = 'edit';
    $('[name="dealerCode"]', form).value = dealer.dealerCode || '';
    $('[name="dealerCode"]', form).readOnly = true;
    $('[name="dealerName"]', form).value = dealer.dealerName || '';
    $('[name="brand"]', form).value = dealer.brand || '';
    $('[name="location"]', form).value = dealer.location || '';
    $('#dealerModalAuditUser').value = dealer.auditUserId || '';
    $('[name="active"]', form).value = dealer.active === false ? 'false' : 'true';
    $('#dealerModalTitle').textContent = 'Edit Dealer';
    $('button[type="submit"]', form).textContent = 'Update Dealer';
    $('#dealerModal').classList.remove('hidden');
  }

  function openAddDealerModal() {
    const form = $('#dealerModalForm');
    form.reset();
    $('[name="mode"]', form).value = 'add';
    $('[name="dealerCode"]', form).readOnly = false;
    $('[name="active"]', form).value = 'true';
    $('#dealerModalTitle').textContent = 'Add New Dealer';
    $('button[type="submit"]', form).textContent = 'Save Dealer';
    $('#dealerModal').classList.remove('hidden');
    $('[name="dealerCode"]', form).focus();
  }

  function closeDealerModal() {
    $('#dealerModal').classList.add('hidden');
    $('#dealerModalForm').reset();
  }

  async function deleteDealerMaster(dealerCode, dealerName = '') {
    const code = cleanDealerCode(dealerCode);
    if (!code) return toast('Dealer code is required', 'error');
    const label = dealerName ? `${dealerName} (${code})` : code;
    if (!window.confirm(`Deactivate ${label}? Historical audits and inventory will be retained.`)) return;
    const data = await api(`/api/master/dealers/${encodeURIComponent(code)}`, { method: 'DELETE', body: {} });
    toast(data.message || 'Dealer deactivated');
    await loadDealers({ force: true });
  }

  async function startNewAuditForDealer(dealerCode) {
    const code = cleanDealerCode(dealerCode);
    const dealer = dealerByCode(code);
    if (!code || !dealer) throw new Error('Select a valid dealer first.');
    const auditName = window.prompt(`Audit name for ${formatDealerDisplay(dealer)}:`, `${code} Audit`);
    if (auditName === null) return;
    try {
      const data = await api('/api/audit', {
        method: 'POST',
        body: {
          dealerCode: code,
          dealerName: dealer.dealerName || code,
          brand: dealer.brand || '',
          location: dealer.location || '',
          auditName: auditName.trim() || `${code} Audit`,
          auditStatus: 'ACTIVE',
          auditStartDate: new Date().toISOString()
        }
      });
      state.dashboardDealerCode = code;
      state.activeAudit = data.activeAudit || data.audit;
      setDealerSelectValue($('#dashboardDealerSelect'), code);
      state.reportCache.clear();
      await loadDealers({ force: true });
      await loadActiveAudit({ dealerCode: code, silent: true });
      await loadDashboard({ force: true });
      toast(`Started ${state.activeAudit?.auditId || 'new audit'} for ${code}`, 'success');
    } catch (error) {
      if (error.data?.code !== 'ACTIVE_AUDIT_EXISTS') throw error;
      const current = error.data.activeAudit || {};
      const choice = window.prompt(
        `Active audit already exists: ${current.auditId || ''}\nType OPEN to open it or COMPLETE to complete it.`,
        'OPEN'
      );
      if (String(choice || '').trim().toUpperCase() === 'OPEN') {
        state.dashboardDealerCode = code;
        setDealerSelectValue($('#dashboardDealerSelect'), code);
        await loadActiveAudit({ dealerCode: code, silent: true });
        await loadDashboard({ force: true });
      } else if (String(choice || '').trim().toUpperCase() === 'COMPLETE') {
        await handleAuditComplete(current.auditId, code);
        toast('Start the new audit after the current audit is completed.');
      }
    }
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
      const path = `/api/audit/${encodeURIComponent(auditId)}/status/complete`;
      let data;
      try {
        data = await api(path, { method: 'POST', body: { remark: remark || '' } });
      } catch (error) {
        if (error.data?.code !== 'AUDIT_COMPLETION_PENDING_ITEMS') throw error;
        const blockers = error.data.blockers || {};
        const warning = `Pending items for this audit:\nOffline pending: ${blockers.pendingOfflineSync || 0}\nOffline failed: ${blockers.failedOfflineSync || 0}\nServer sync pending: ${blockers.pendingServerSync || 0}\n\nComplete anyway?`;
        if (!window.confirm(warning)) return;
        data = await api(path, { method: 'POST', body: { remark: remark || '', confirmPending: true } });
      }

      // Show completion popup
      alert('✓ Audit marked as COMPLETED successfully.\n\nNo further changes can be made to this audit unless it is reopened by an admin.');

      toast('Audit marked as completed', 'success');
      await loadActiveAudit({ silent: true, allowMissing: true });
      await loadDealers();
      if ($('#dashboard')?.classList.contains('active')) await loadDashboard({ force: true });
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

  async function handleAuditLock(auditId, dealerCode) {
    if (!auditId || !dealerCode) throw new Error('Audit ID and Dealer Code are required');
    if (!window.confirm(`Lock audit ${auditId} for dealer ${dealerCode}? Normal changes will be blocked.`)) return;
    await api(`/api/audit/${encodeURIComponent(auditId)}/status`, {
      method: 'POST',
      body: { status: 'LOCKED', remark: 'Locked after final review' }
    });
    toast('Audit locked', 'success');
    await loadDealers({ force: true });
    await loadActiveAudit({ dealerCode, silent: true, allowMissing: true });
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
          <td><select class="bin-transfer-row-to select-control">${destinationOptions(defaultDestination)}</select></td>
          <td>${escapeHtml(availableQty)}</td>
          <td><input class="bin-transfer-qty input-control" type="number" min="1" max="${escapeHtml(availableQty)}" value="${escapeHtml(availableQty || 1)}" data-part="${escapeHtml(part.partNumber)}"></td>
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

  let binTransferStockRefreshTimer = null;
  function queueBinTransferStockRefresh() {
    clearTimeout(binTransferStockRefreshTimer);
    binTransferStockRefreshTimer = setTimeout(async () => {
      const form = activeBinTransferForm();
      const { dealerCode, fromBin } = binTransferCriteria(form);
      if (!dealerCode) return;
      try {
        await loadBinTransferBins(dealerCode);
        const matchingSource = $$('.bin-transfer-from').find((select) => Array.from(select.options).some((option) => option.value === fromBin));
        if (matchingSource) matchingSource.value = fromBin;
        await loadBinTransferParts(form);
      } catch (error) {
        console.warn('BIN_TRANSFER_STOCK_REFRESH_FAILED', error);
      }
    }, 100);
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
    const data = await api(`/api/bin-transfer/bins?dealerCode=${encodeURIComponent(dealerCode)}`);
    const fromOptions = sourceBinOptionList(data.bins || data.sourceBins || []);
    $$('.bin-transfer-from').forEach((select) => {
      select.innerHTML = fromOptions;
      select.value = 'ALL';
    });
    applyDestinationBinOptions({ bins: data.destinationBins || [] }, '');
    renderBinTransferParts([], 'Parts are not loaded automatically. Choose a specific source bin for a faster search, or click Show Parts to load all bins.');
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
      loadScanHistory().catch(() => null)
    ]);
    queueDashboardRefresh(300);
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
      binFontSize: Number($('#binLabelBinFont')?.value || 18),
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
      panel.innerHTML = bins.length ? `<label class="bin-label-multi-option bin-label-select-all-option"><input id="binLabelSelectAllBins" type="checkbox"><span>Select All Bins</span></label><div class="bin-label-multi-divider" role="separator"></div>${bins.map((bin, index) => {
        const value = binOptionValue(bin);
        return `<label class="bin-label-multi-option"><input class="bin-label-bin-option" type="checkbox" value="${escapeHtml(value)}" data-index="${escapeHtml(index)}"><span>${escapeHtml(value)}</span></label>`;
      }).join('')}` : '<div class="bin-label-multi-empty">No bins found</div>';
    }
    updateBinLabelBinsButton();
  }

  function syncBinLabelBinsSelectAllState() {
    const boxes = $$('.bin-label-bin-option');
    const checkedCount = boxes.filter((box) => box.checked).length;
    const selectAll = $('#binLabelSelectAllBins');
    if (selectAll) {
      selectAll.checked = boxes.length > 0 && checkedCount === boxes.length;
      selectAll.indeterminate = checkedCount > 0 && checkedCount < boxes.length;
    }
    const select = $('#binLabelBins');
    if (select) {
      const selectedValues = new Set(boxes.filter((box) => box.checked).map((box) => box.value));
      Array.from(select.options).forEach((option) => {
        option.selected = selectedValues.has(option.value);
      });
    }
  }

  function updateBinLabelBinsButton() {
    const values = selectedMultiValues($('#binLabelBins'));
    const button = $('#binLabelBinsButton');
    if (!button) return;
    const label = values.length ? (values.length === 1 ? values[0] : `${values.length} bins selected`) : 'Select Bin(s)';
    const labelNode = button.querySelector('.ds-select-label');
    if (labelNode) labelNode.textContent = label;
    else button.textContent = label;
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
    clearBinLabelSelection(bins.length
      ? 'Select bin(s), then print bin labels directly or click Show Parts to select part labels.'
      : 'No bins found for selected dealer.');
    return bins;
  }

  async function refreshBinLabelBinsAndSelect(dealerCode, binCodes = []) {
    const bins = await loadBinLabelBins(dealerCode);
    const wanted = new Set(binCodes.map(binOptionKey));
    $$('.bin-label-bin-option').forEach((box) => { box.checked = wanted.has(binOptionKey(box.value)); });
    syncBinLabelBinsSelectAllState();
    updateBinLabelBinsButton();
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
    node.style.setProperty('--bin-label-bin-font', `${settings.binFontSize || 18}pt`);
    node.style.setProperty('--bin-label-weight', settings.boldText === false ? '700' : '900');
  }

  function binLabelCard(item = {}) {
    return `
      <div class="bin-label-card">
        <img class="bin-label-qr" src="${escapeHtml(item.dataUrl || '')}" alt="">
        <strong class="bin-label-name">${escapeHtml(item.binNumber)}</strong>
      </div>
    `;
  }

  function fitBinLabelNames(node, settings = {}) {
    if (!node) return;
    const context = document.createElement('canvas').getContext('2d');
    if (!context) return;
    const pixelsPerMm = 96 / 25.4;
    // Match the shared card's 2mm padding, 3mm gap and configured QR size.
    const width = Math.max(1, (Number(settings.labelWidthMm || 70) - 4 - 3 - Number(settings.qrSizeMm || 20)) * pixelsPerMm);
    const height = Math.max(1, (Number(settings.labelHeightMm || 28) - 4) * pixelsPerMm);
    const fontSize = Number(settings.binFontSize || 18) * 96 / 72;
    const weight = settings.boldText === false ? '700' : '900';
    context.font = `${weight} ${fontSize}px Arial`;
    node.querySelectorAll('.bin-label-name').forEach((name) => {
      const textWidth = context.measureText(name.textContent).width;
      const scale = Math.min(1, width / Math.max(1, textWidth), height / (fontSize * 1.05));
      name.style.fontSize = `${Math.floor(fontSize * scale * 100) / 100}px`;
    });
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
    fitBinLabelNames(preview, settings);
    fitBinLabelNames(printArea, settings);
    setText('binLabelPreviewCount', `${items.length} labels`);
  }

  async function previewBinLabels() {
    const dealerCode = cleanDealerCode($('#binLabelDealer')?.value || currentDealerCode());
    const bins = selectedMultiValues($('#binLabelBins'));
    const selectedItems = selectedBinLabelParts();
    if (!dealerCode) throw new Error('Dealer required');
    if (!bins.length) throw new Error('Select at least one bin');
    const settings = binLabelSettingsFromForm();
    setBinLabelMessage('Preparing label preview...');
    const data = await api('/api/bin-transfer/labels/preview', {
      method: 'POST',
      body: { dealerCode, bins, selectedItems, ...settings }
    });
    renderBinLabelPreview(data.items || [], data.settings || settings);
    setBinLabelMessage(`${data.count || (data.items || []).length} ${selectedItems.length ? 'label(s)' : 'bin label(s)'} ready for print.`, 'success');
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
          border: 0 !important;
          border-radius: 0 !important;
          box-shadow: none !important;
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
    fitBinLabelNames(printSheet, settings);
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
    return Boolean(state.user && ['admin', 'super_admin'].includes(normalizeUiRole(state.user.role)));
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
          <button class="btn light admin-only renameScanner ${isAdmin() ? '' : 'hidden'}" data-id="${escapeHtml(device.deviceId)}" data-name="${escapeHtml(device.deviceName)}" type="button">Rename</button>
          <button class="btn light admin-only priorityScanner ${isAdmin() ? '' : 'hidden'}" data-id="${escapeHtml(device.deviceId)}" data-priority="${escapeHtml(device.scannerPriority || 0)}" type="button">Priority</button>
          <button class="btn light admin-only messageMobileDevice ${isAdmin() && device.deviceType === 'mobile' ? '' : 'hidden'}" data-id="${escapeHtml(device.deviceId)}" type="button">Message</button>
          <button class="btn danger-soft admin-only blockMobileDevice ${isAdmin() && device.deviceType === 'mobile' ? '' : 'hidden'}" data-id="${escapeHtml(device.deviceId)}" data-block="${device.approved === false ? 'false' : 'true'}" type="button">${device.approved === false ? 'Approve Device' : 'Block Device'}</button>
          <button class="btn danger-soft admin-only forceLogoutMobileDevice ${isAdmin() && device.deviceType === 'mobile' ? '' : 'hidden'}" data-id="${escapeHtml(device.deviceId)}" type="button">Force Logout</button>
          <button class="btn danger-soft admin-only disconnectDevice ${isAdmin() ? '' : 'hidden'}" data-id="${escapeHtml(device.deviceId)}" type="button">Disconnect</button>
          <button class="btn light admin-only forceReconnectDevice ${isAdmin() ? '' : 'hidden'}" data-id="${escapeHtml(device.deviceId)}" type="button">Force Reconnect</button>
          <button class="btn danger-soft admin-only removeDevice ${isAdmin() ? '' : 'hidden'}" data-id="${escapeHtml(device.deviceId)}" type="button">Remove Device</button>
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
          <td><button class="btn danger-soft admin-only disconnectDevice ${isAdmin() ? '' : 'hidden'}" data-id="${escapeHtml(device.deviceId)}" type="button">Disconnect</button></td>
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
            <button class="btn light admin-only forceReconnectDevice ${isAdmin() ? '' : 'hidden'}" data-id="${escapeHtml(device.deviceId)}" type="button">Reconnect</button>
            <button class="btn danger-soft admin-only removePermanentDevice ${isAdmin() ? '' : 'hidden'}" data-id="${escapeHtml(device.deviceId)}" type="button">Remove Permanently</button>
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
          <td title="${escapeHtml(row.reason || 'Invalid part number - not found in master catalogue')}">${escapeHtml(row.reason || 'Invalid part number - not found in master catalogue')}</td>
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
    if (!(await confirmDeleteAction(DELETE_CONFIRM_TEXT))) return;
    const deleteDetails = lastDeleteDetails();
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
          <div class="archive-row-actions"> <button class="btn light preview-audit-backup" data-id="${escapeHtml(archive.archiveId)}" type="button">Preview Backup</button> <button class="btn primary restore-audit-backup" data-id="${
        escapeHtml(archive.archiveId)
      }" type="button" ${archive.backupStatus !== 'valid' ? 'disabled' : ''}>Restore Audit</button> <button class="btn light download-audit-backup" data-id="${escapeHtml(archive.archiveId)}" type="button">Download Backup</button>
            <button class="btn danger-soft remove-audit-backup" data-id="${escapeHtml(archive.archiveId)}" type="button">Delete Backup Permanently</button> 
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
    return $$('.scan-history-checkbox:checked').map((box) => cleanId(box.value)).filter(Boolean);
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
    queueReconciliationRefresh('delete');
    markReportsStale('delete', { autoRefresh: false });
    await Promise.allSettled([loadScanHistory(), loadDealers(), loadCategories(), loadSyncStatus()]);
  }

  async function saveEditedScan(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const message = $('#scanEditMessage');
    const scanId = String(form.elements.scanId.value || '').trim();
    let scanIdentity = {};
    if (form.dataset?.scanIdentity) {
      try {
        scanIdentity = JSON.parse(form.dataset.scanIdentity);
      } catch (error) {
        scanIdentity = {};
      }
    }
    const quantity = Number(form.elements.quantity.value);
    const scanType = String(form.elements.scanType.value || '').trim().toUpperCase();
    const binLocation = scanType === 'FITTED' ? '' : cleanDealerCode(form.elements.binLocation.value || '');
    const reason = clean(form.elements.reason?.value || '');
    const remarks = clean(form.elements.remarks?.value || '');
    if (!scanId) throw new Error('Scan record not found');
    if (!String(form.elements.partNumber.value || '').trim()) throw new Error('Part number is required');
    if (!(quantity > 0)) throw new Error('Quantity must be greater than zero');
    if (['INWARD', 'OUTWARD', 'DAMAGE'].includes(scanType) && !binLocation) throw new Error('Bin location is required');
    if (!reason) throw new Error('Select a modification reason');
    if (reason.toLowerCase() === 'other' && !remarks) throw new Error('Remarks are required when the reason is Other');
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
        scanType,
        reason,
        remarks,
        scanIdentity: JSON.stringify(scanIdentity || {}),
        deviceId: ensureDeviceId()
      }
    });
    closeScanEditModal();
    toast(data.message || 'Part details updated');
    if (data.scan) {
      prependScanHistory(data.scan);
      markReportsStale('scan details update', { autoRefresh: false });
    }
    queueDashboardRefresh(250);
    await loadScanHistory();
  }

  async function deleteSingleScan(scanId) {
    const id = String(scanId || '').trim();
    if (!id) {
      toast('Select a scan first', 'error');
      return;
    }
    if (!(await confirmDeleteAction('Are you sure you want to delete this scan?'))) return;
    const deleteDetails = lastDeleteDetails();
    const scan = scanHistoryRecord(id) || scanHistoryDeleteReference(id);
    try {
      await api(`/api/admin/scans/${encodeURIComponent(id)}`, { method: 'DELETE', body: deleteDetails });
    } catch (error) {
      throw deleteFailureError(error);
    }
    removeScanHistoryRecords([scan]);
    toast('Scan deleted');
    await refreshAfterDelete();
  }

  async function deletePartScansByNumber(partNumber, options = {}) {
    const part = normalizePartText(partNumber || '');
    if (!part) {
      toast('Part number is not available', 'error');
      return;
    }
    const dealerCode = cleanDealerCode(options.dealerCode || currentDealerCode() || '');
    if (!dealerCode) {
      toast('Select a dealer first', 'error');
      return;
    }
    if (!(await confirmDeleteAction(`Are you sure you want to delete all scans for part ${part}?`))) return;
    const deleteDetails = lastDeleteDetails();
    const payload = {
      dealerCode,
      parts: part,
      deleteType: 'single-part',
      ...deleteDetails
    };
    if (options.auditId) payload.auditId = String(options.auditId).trim();
    let data;
    try {
      data = await api('/api/admin/scans/delete-by-parts', { method: 'POST', body: payload });
    } catch (error) {
      throw deleteFailureError(error);
    }
    toast(`Part deleted: ${data.deletedCount || 0} scan(s) removed`);
    queueDashboardRefresh(250);
    if (state.reportHasRun && activeReportType()) {
      loadReport({ forceRefresh: true, showLoading: false }).catch(() => undefined);
    }
    await refreshAfterDelete();
  }

  async function deleteSelectedScans() {
    const ids = selectedScanIds();
    if (!ids.length) {
      toast('Select scans first', 'error');
      return;
    }
    if (!(await confirmDeleteAction('Are you sure you want to delete the selected scans?'))) return;
    const deleteDetails = lastDeleteDetails();
    const scans = ids.map((id) => scanHistoryRecord(id) || scanHistoryDeleteReference(id));
    try {
      await api('/api/admin/scans/delete-selected', { method: 'POST', body: { ids, ...deleteDetails } });
    } catch (error) {
      throw deleteFailureError(error);
    }
    removeScanHistoryRecords(scans);
    toast('Selected scans deleted');
    await refreshAfterDelete();
  }

  async function cleanUnknownParts(criteria = {}) {
    if (!(await confirmDeleteAction('Are you sure you want to delete unknown part scans?'))) return;
    const deleteDetails = lastDeleteDetails();
    try {
      await api('/api/admin/cleanup-unknown-parts', { method: 'POST', body: { ...criteria, ...deleteDetails } });
    } catch (error) {
      throw deleteFailureError(error);
    }
    removeLocalMatching(criteria);
    toast('Unknown part scans deleted');
    await refreshAfterDelete();
  }

  async function deleteByDealerCode(code) {
    const dealer = cleanDealerCode(code || cleanupCriteriaFromForm().dealerCode || window.prompt('Dealer Code') || '');
    if (!dealer) {
      toast('Dealer code is required', 'error');
      return;
    }
    if (!(await confirmDeleteAction(`Are you sure you want to delete all scans for dealer ${dealer}?`))) return;
    const deleteDetails = lastDeleteDetails();
    try {
      await api(`/api/admin/dealer/${encodeURIComponent(dealer)}/scans`, { method: 'DELETE', body: deleteDetails });
    } catch (error) {
      throw deleteFailureError(error);
    }
    removeLocalMatching({ dealerCode: dealer });
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
        await api(`/api/admin/scans/${encodeURIComponent(ids[0])}`, { method: 'DELETE', body: deleteDetails });
        removeScanHistoryRecords([scanHistoryRecord(ids[0]) || { scanId: ids[0], uniqueScanId: ids[0], localId: ids[0] }]);
      } else if (action === 'selected-scans') {
        const ids = selectedScanIds();
        if (!ids.length) throw new Error('Select scans in Scan History first');
        await api('/api/admin/scans/delete-selected', { method: 'POST', body: { ids, ...deleteDetails } });
        removeScanHistoryRecords(ids.map((id) => scanHistoryRecord(id) || { scanId: id, uniqueScanId: id, localId: id }));
      } else if (action === 'multiple-parts') {
        await api('/api/admin/scans/delete-by-parts', { method: 'POST', body: { ...criteria, ...deleteDetails } });
        removeLocalMatching(criteria);
      } else if (action === 'dealer-scans') {
        if (!criteria.dealerCode) throw new Error('Dealer code is required');
        await api(`/api/admin/dealer/${encodeURIComponent(cleanDealerCode(criteria.dealerCode))}/scans`, { method: 'DELETE', body: deleteDetails });
        removeLocalMatching({ dealerCode: cleanDealerCode(criteria.dealerCode) });
      } else if (action === 'dealer-master') {
        if (!criteria.dealerCode) throw new Error('Dealer code is required');
        await api(`/api/admin/dealer/${encodeURIComponent(cleanDealerCode(criteria.dealerCode))}/master`, { method: 'DELETE', body: {} });
      } else if (action === 'dealer-full') {
        if (!criteria.dealerCode) throw new Error('Dealer code is required');
        await api(`/api/admin/dealer/${encodeURIComponent(cleanDealerCode(criteria.dealerCode))}/all`, { method: 'DELETE', body: deleteDetails });
        removeLocalMatching({ dealerCode: cleanDealerCode(criteria.dealerCode) });
      } else if (action === 'unknown') {
        await api('/api/admin/cleanup-unknown-parts', { method: 'POST', body: { ...criteria, ...deleteDetails } });
        removeLocalMatching(criteria);
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
    if (!(await confirmDeleteAction('Are you sure? This will archive selected part data and keep it in scan history.'))) return;
    const data = await api(`/api/admin/part/${scope}`, { method: 'DELETE', body: { ...payload, ...lastDeleteDetails() } });
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
    if (!(await confirmDeleteAction('Preview checked? This will archive listed part data and keep it in scan history.'))) return;
    const endpoint = scope === 'all' ? '/api/admin/parts/all' : '/api/admin/parts/scans';
    const data = await api(endpoint, { method: 'DELETE', body: { ...payload, ...lastDeleteDetails() } });
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

  async function loadScanModificationHistory() {
    if (!isAdminUser()) return;
    const form = $('#scanModificationHistoryFilters');
    const query = form ? queryFromForm(form) : '';
    const data = await api(`/api/scan-audit/history${query ? `?${query}` : ''}`);
    const rows = data.rows || data.history || [];
    const tbody = $('#scanModificationHistoryRows');
    if (!tbody) return;
    tbody.innerHTML = rows.length ? rows.map((row) => `
      <tr>
        <td>${escapeHtml(row.timestamp ? dateTime(row.timestamp) : '-')}</td>
        <td><span class="status-pill">${escapeHtml(row.action || '-')}</span></td>
        <td>${escapeHtml(row.scanId || '-')}</td>
        <td>${escapeHtml(row.dealerCode || '-')}</td>
        <td>${escapeHtml(row.partNumber || '-')}</td>
        <td>${escapeHtml(row.performedByUsername || row.performedByName || '-')}</td>
        <td>${escapeHtml(row.reason || '-')}<br><span class="muted">${escapeHtml(row.remarks || '')}</span></td>
        <td><details><summary>View snapshots</summary><pre class="scan-audit-snapshot">${escapeHtml(JSON.stringify({ oldData: row.oldData, newData: row.newData }, null, 2))}</pre>${row.action === 'DELETE' ? `<button class="btn light restore-audited-scan" type="button" data-scan-id="${escapeHtml(row.scanId || '')}">Restore</button>` : ''}</details></td>
      </tr>
    `).join('') : '<tr><td colspan="8" class="muted">No scan modifications found.</td></tr>';
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
    if (!(await confirmDeleteAction(`Preview count: ${count}. Archive selected rows for dealer ${dealerDeleteCriteria().dealerCode}?`))) return;
    const data = await api('/api/admin-delete/delete-selected', { method: 'POST', body: { dealerCode: dealerDeleteCriteria().dealerCode, ids, ...lastDeleteDetails() } });
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
    if (!(await confirmDeleteAction(`Preview count: ${count}. Archive ALL selected type data for dealer ${criteria.dealerCode}?`))) return;
    const data = await api('/api/admin-delete/delete-all-dealer', { method: 'POST', body: { ...criteria, ...lastDeleteDetails() } });
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
    if (!(await confirmDeleteAction(`Preview count: ${preview.total}. Archive ${criteria.dataType} from ${criteria.dataLocation} for dealer ${criteria.dealerCode}?`))) return;
    const deleteDetails = lastDeleteDetails();
    let local = { deletedCount: 0 };
    let server = { deletedCount: 0 };
    if (['local', 'both'].includes(criteria.dataLocation)) local = deleteLocalDealerData(criteria);
    if (['server', 'both'].includes(criteria.dataLocation)) server = await api('/api/admin-delete/delete-location-data', { method: 'POST', body: { ...criteria, ...deleteDetails } });
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
    const role = roleDisplayName(user.role);
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
    if (!isAdmin()) return;
    const data = await api('/api/users');
    state.users = data.users || [];
    renderUsers();
    renderAuditUserOptions();
    if ($('#dealerAuditTab')) renderDealerMaster();
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
    $('#userRows').innerHTML = state.users.map((user) => `
      <tr>
        <td>${escapeHtml(user.name)}</td>
        <td>${escapeHtml(user.username)}</td>
        <td>${escapeHtml(user.email)}</td>
        <td>${escapeHtml(roleDisplayName(user.role))}</td>
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
            <option value="send-reset">Send Password Reset Link</option>
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
      const email = String(select.dataset.email || '').trim();
      const [localPart, domain] = email.split('@');
      const masked = domain ? `${localPart.slice(0, 2)}****@${domain}` : '';
      if (!email) throw new Error('Add a registered email address before sending a reset link.');
      if (!window.confirm(`Send password reset link to the registered email address?\n\n${masked}`)) return;
      const data = await api(`/api/admin/users/${encodeURIComponent(id)}/send-password-reset`, { method: 'POST', body: {} });
      toast(data.message || 'Password reset request submitted', data.success === false ? 'error' : 'success');
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
    form.elements.role.value = ['admin', 'audit_user', 'mobile_user'].includes(user.role) ? user.role : 'audit_user';
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
      toast('Use automatic discovery, daksh.local, or the temporary pairing QR for mobile.', 'error');
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
      toast('Use automatic discovery, daksh.local, or the temporary pairing QR for mobile.', 'error');
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
      loadSyncStatus(),
      loadSmartBinSuggestionSettings()
    ];
    if ($('#reports')?.classList.contains('active')) viewJobs.push(loadCategories());
    if ($('#scan')?.classList.contains('active')) {
      viewJobs.push(loadScanHistory(), loadBarcodeBins(), loadPairingQr());
      if (isAdmin()) viewJobs.push(loadBins());
    }
    if ($('#binTransfer')?.classList.contains('active')) viewJobs.push(loadBinTransferHistory());
    if ($('#master')?.classList.contains('active')) {
      viewJobs.push(loadPartSearchFilters());
      if (isAdmin()) viewJobs.push(loadCatalogueRequiredColumns(), loadUsers());
    }
    if ($('#validator')?.classList.contains('active')) viewJobs.push(loadMasterScanValidator());
    if ($('#devices')?.classList.contains('active')) viewJobs.push(loadDevices(), loadPairingQr());
    await Promise.all(viewJobs);
    renderSyncQueue();
    renderSyncLog();
    renderConnectionLog();
  }

  function startDashboardFallbackRefresh() {
    if (state.dashboardFallbackTimer) clearInterval(state.dashboardFallbackTimer);
    state.dashboardFallbackTimer = null;
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
      const label = values.length ? (values.length === 1 ? values[0] : `${values.length} bins selected`) : 'Select bin location(s)';
      const labelNode = button.querySelector('.ds-select-label');
      if (labelNode) labelNode.textContent = label;
      else button.textContent = label;
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

  async function lookupBarcodePartLocation() {
    const form = $('#barcodeScanForm');
    const partInput = $('#barcodePartNumber');
    const status = $('#barcodePartLocationStatus');
    if (!form || !partInput || !status) return [];
    const partNumber = normalizePartText(partInput.value);
    const scanType = String(form.elements.type.value || '').toUpperCase();
    if (!['OUTWARD', 'FITTED'].includes(scanType) || !partNumber) return [];

    const dealerCode = cleanDealerCode(form.elements.dealerCode.value || currentDealerCode());
    if (!dealerCode) {
      status.textContent = 'Select a dealer to check available bin locations.';
      return [];
    }

    status.dataset.lookupDone = 'false';
    status.dataset.lookupPart = partNumber;
    status.textContent = 'Checking available bin locations...';
    const binInput = $('#barcodeBinLocation');
    binInput.value = '';
    localStorage.removeItem(BARCODE_LAST_BIN_KEY);
    updateScanTypeFields(form);
    try {
      const query = new URLSearchParams({ dealerCode, partNumber });
      const data = await api(`/api/bin-transfer/parts?${query.toString()}`);
      if (normalizePartText(partInput.value) !== partNumber) return [];
      const matches = (data.parts || []).filter((row) => normalizePartText(row.partNumber) === partNumber);
      const bins = Array.from(new Set(matches.map((row) => cleanDealerCode(row.currentBin || row.binLocation || row.binCode || '')).filter(Boolean)));
      status.dataset.lookupDone = 'true';
      status.dataset.lookupPart = partNumber;
      if (bins.length === 1) {
        binInput.value = bins[0];
        localStorage.setItem(BARCODE_LAST_BIN_KEY, bins[0]);
        $('#barcodeBinOptions').innerHTML = `<option value="${escapeHtml(bins[0])}"></option>`;
        status.textContent = `Available in bin ${bins[0]}. Scan the UPI / QR code next.`;
      } else if (bins.length > 1) {
        $('#barcodeBinOptions').innerHTML = bins.map((bin) => `<option value="${escapeHtml(bin)}"></option>`).join('');
        status.textContent = `Available in ${bins.length} bins. Select the bin for this part, then scan its UPI / QR code.`;
      } else {
        status.textContent = 'No available bin was found for this part. Enter the source bin location, then scan the UPI / QR code.';
      }
      updateScanTypeFields(form);
      if (bins.length > 1 || bins.length === 0) binInput.focus();
      return bins;
    } catch (error) {
      if (normalizePartText(partInput.value) !== partNumber) return [];
      status.dataset.lookupDone = 'true';
      status.textContent = `Could not check bin locations (${error.message}). Enter the source bin location manually.`;
      $('#barcodeBinLabel').classList.remove('hidden');
      binInput.focus();
      updateScanTypeFields(form);
      return [];
    }
  }

  function renderPartStockSummary(summary) {
    const node = $('#scanPartSummary');
    if (!node || !summary) return;
    state.lastStockSummaryPart = summary.partNumber;
    node.hidden = false;
    node.textContent = `${summary.partNumber} | Inward ${wholeNumber(summary.inwardQty)} | Outward ${wholeNumber(summary.outwardQty)} | Fitted ${wholeNumber(summary.fittedQty)} | Damage ${wholeNumber(summary.damageQty)} | Available ${wholeNumber(summary.availableQty)}`;
  }

  function scanStockDealerCode() {
    return cleanDealerCode($('#barcodeScanForm [name="dealerCode"]')?.value || currentDealerCode());
  }

  async function refreshPartStockSummary(scan = {}) {
    const partNumber = scan.partNumber || scan.part || state.lastStockSummaryPart;
    const dealerCode = cleanDealerCode(scan.dealerCode || scanStockDealerCode());
    if (!partNumber || !dealerCode || dealerCode !== scanStockDealerCode()) return;
    const requestId = (state.partSummaryRequestId || 0) + 1;
    state.partSummaryRequestId = requestId;
    const query = new URLSearchParams({ dealerCode, partNumber });
    if (scan.auditId) query.set('auditId', scan.auditId);
    const summary = await api(`/api/scans/part-summary?${query}`);
    if (requestId === state.partSummaryRequestId && dealerCode === scanStockDealerCode()) renderPartStockSummary(summary);
  }

  async function validateManualSourceBin(form = $('#manualScanForm')) {
    if (!form || form.elements.type.value !== 'INWARD') return;
    const binLocation = cleanDealerCode(form.elements.bin.value);
    const dealerCode = form.elements.dealerCode.value;
    const key = `${dealerCode}|${binLocation}`;
    if (state.validatedManualBin === key) return;
    state.validatedManualBin = '';
    updateScanTypeFields(form);
    if (!binLocation || !dealerCode) return;
    try {
      const result = await api('/api/scans/set-bin', { method: 'POST', body: {
        dealerCode, auditId: activeAuditIdForScope(), binLocation
      } });
      if (`${form.elements.dealerCode.value}|${cleanDealerCode(form.elements.bin.value)}` !== key) return;
      state.validatedManualBin = result.valid ? key : '';
      updateScanTypeFields(form);
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function validateBarcodeSourceBin(form = $('#barcodeScanForm')) {
    if (!form || form.elements.type.value !== 'INWARD') return;
    const binLocation = cleanDealerCode(form.elements.binLocation.value);
    const dealerCode = form.elements.dealerCode.value;
    const key = `${dealerCode}|${binLocation}`;
    if (state.validatedBarcodeBin === key) return;
    state.validatedBarcodeBin = '';
    updateBarcodeWorkspace(form);
    if (!binLocation || !dealerCode) return;
    try {
      const result = await api('/api/scans/set-bin', { method: 'POST', body: {
        dealerCode, auditId: activeAuditIdForScope(), binLocation
      } });
      if (`${form.elements.dealerCode.value}|${cleanDealerCode(form.elements.binLocation.value)}` !== key) return;
      state.validatedBarcodeBin = result.valid ? key : '';
      updateBarcodeWorkspace(form);
    } catch (error) {
      if (`${form.elements.dealerCode.value}|${cleanDealerCode(form.elements.binLocation.value)}` === key) {
        $('#barcodeBinReady').textContent = error.message;
      }
    }
  }

  function updateBarcodeWorkspace(form = $('#barcodeScanForm')) {
    if (!form) return;
    updateLocalPartScanMode(form);
    if (form.elements.type.value === 'LOCAL_PART') return;
    const bin = cleanDealerCode(form.elements.binLocation.value || '');
    const fitted = form.elements.type.value === 'FITTED';
    const autoOutward = ['OUTWARD', 'FITTED'].includes(form.elements.type.value);
    form.elements.binLocation.readOnly = autoOutward;
    form.elements.binLocation.placeholder = autoOutward ? 'Auto-detected from scanned QR / UPI' : 'Select, type or scan bin';
    $('#clearBarcodeBin')?.classList.toggle('hidden', autoOutward);
    $('#barcodeBinLabel small').textContent = autoOutward ? 'Auto-detected from QR / UPI. Part-only entry asks for its source bin.' : 'Enter / Scan bin first (Mandatory)';
    $('#barcodeBinStep small').textContent = autoOutward ? 'Auto-detected from QR / UPI' : 'Enter / Scan bin first (Mandatory)';
    form.elements.binLocation.required = !autoOutward;
    form.elements.binLocation.disabled = autoOutward;
    const inward = form.elements.type.value === 'INWARD';
    const binReady = Boolean(bin) && state.validatedBarcodeBin === `${form.elements.dealerCode.value}|${bin}`;
    form.elements.rawScan.disabled = inward && !binReady;
    form.elements.part.disabled = inward ? !binReady : !bin && !autoOutward;
    $$('button[type="submit"], #saveBarcodeManualScan', form).forEach(button => { button.disabled = inward && !binReady; });
    $('#barcodeBinLabel')?.classList.toggle('hidden', autoOutward);
    $('#barcodeBinStep')?.classList.toggle('hidden', autoOutward);
    $('#barcodeScanStep b').textContent = autoOutward ? '2' : '3';
    form.elements.part.readOnly = false;
    form.elements.part.required = false;
    form.elements.part.placeholder = autoOutward ? 'Enter part number or scan its barcode / QR' : bin ? 'Enter part number' : 'Select source bin first';
    form.elements.regdNo.required = fitted;
    form.elements.jobCardNo.required = fitted;
    $('#barcodeBinLabel')?.classList.toggle('source-bin-missing', !bin && !autoOutward);
    $('#barcodeBinLabel .required-mark')?.classList.toggle('hidden', autoOutward);
    $('#barcodeBinStep')?.classList.toggle('missing', !bin && !autoOutward);
    const status = $('#barcodeBinReady');
    if (status) {
      status.textContent = autoOutward ? 'Auto-detected from scanned QR / UPI' : bin && (!inward || binReady) ? `Bin ${bin} selected. Ready to scan or enter part.` : (inward && bin ? 'Validating bin location...' : 'Enter bin location first');
      status.classList.toggle('ready', autoOutward || (inward ? binReady : Boolean(bin)));
    }
    setText('barcodeCurrentBin', bin || '—');
  }

  function updateLocalPartScanMode(form) {
    const local = form.elements.type.value === 'LOCAL_PART';
    const panel = $('#localPartEntry');
    if (!panel) return;
    if (local && panel.parentElement !== $('#barcodeEntry')) $('#barcodeEntry').appendChild(panel);
    panel.hidden = !local;
    panel.inert = !local;
    panel.setAttribute('aria-hidden', String(!local));
    panel.classList.toggle('active', local);
    const inputs = $('.barcode-entry-panels', form);
    if (inputs) inputs.hidden = local;
    const workflow = $('#barcodeEntry .barcode-workflow');
    if (workflow) workflow.hidden = local;
    const history = $('#scan .scan-history-card');
    if (history) history.hidden = local;
    if (!local) { state.localPartScanScope = ''; return; }
    clearTimeout(form.elements.rawScan.autoSaveTimer);
    form.elements.rawScan.disabled = true;
    form.elements.binLocation.disabled = true;
    form.elements.binLocation.required = false;
    $('#barcodeBinLabel')?.classList.add('hidden');
    $('#clearBarcodeBin')?.classList.add('hidden');
    $('#scanPartSummary').hidden = true;
    $('#barcodeBinReady').textContent = 'Local Part entry — enter quantity, description, MRP and DLC.';
    $('#barcodeBinReady').classList.add('ready');
    setText('barcodeCurrentBin', 'Not required');
    const dealerCode = form.elements.dealerCode.value;
    const localForm = $('#localPartForm');
    if (localForm.elements.dealerCode.value !== dealerCode) resetLocalPartForm({ dealerCode });
    setDealerSelectValue(localForm.elements.dealerCode, dealerCode);
    syncLocalPartFormIdentity();
    const scope = `${dealerCode}|${activeAuditIdForScope()}`;
    if (state.localPartScanScope !== scope) {
      state.localPartScanScope = scope;
      const filter = $('#localPartHistoryFilters [name="dealerCode"]');
      if (filter) setDealerSelectValue(filter, dealerCode);
      if (dealerCode) loadLocalPartHistory({ page: 1 }).catch(error => toast(error.message, 'error'));
    }
  }

  function acceptBarcodeBinQr(raw, target = $('#barcodeRaw')) {
    if (!/^BIN\s*[:=]/i.test(String(raw || '').trim())) return false;
    const parsed = parseRawScanText(raw);
    const bin = cleanDealerCode(parsed.binLocation || '');
    if (!bin) return false;
    const form = $('#barcodeScanForm');
    if (['OUTWARD', 'FITTED'].includes(form.elements.type.value)) {
      if (target === $('#barcodeRaw')) target.value = '';
      return true;
    }
    form.elements.binLocation.value = bin;
    localStorage.setItem(BARCODE_LAST_BIN_KEY, bin);
    if (target === $('#barcodeRaw')) target.value = '';
    updateScanTypeFields(form);
    validateBarcodeSourceBin(form).then(() => { if (!form.elements.rawScan.disabled) form.elements.rawScan.focus(); }).catch(console.warn);
    playScanTone('success');
    return true;
  }

  async function refreshBarcodePartDetails(partNumber = '') {
    const form = $('#barcodeScanForm');
    const part = normalizePartText(partNumber || form?.elements.part.value || '');
    if (!form || !validPartText(part)) return;
    const dealer = form.elements.dealerCode.value;
    try {
      const master = await validatePartAgainstMaster(part, dealer);
      if (normalizePartText(form.elements.part.value) !== part || form.elements.dealerCode.value !== dealer) return;
      if (master) fillPart(form, master);
      else ['partName', 'category', 'mrp', 'dlc'].forEach((name) => { form.elements[name].value = ''; });
    } catch (error) {
      console.warn('[SCAN] Part details lookup failed', error.message);
    }
  }

  async function saveBarcodeManualScan() {
    const form = $('#barcodeScanForm');
    if (!form || state.barcodeAutoSaving) return;
    if (form.elements.type.value === 'LOCAL_PART') { $('#localPartSaveBtn').click(); return; }
    const stockMovement = ['OUTWARD', 'FITTED'].includes(form.elements.type.value);
    if (!form.elements.dealerCode.value || !form.elements.part.value.trim() || !(Number(form.elements.qty.value) > 0)) {
      toast('Dealer, part number and a quantity greater than zero are required.', 'error');
      return;
    }
    if (!stockMovement && !form.elements.binLocation.value.trim()) {
      toast('Please select or scan Source Bin Location first.', 'error');
      form.elements.binLocation.focus();
      return;
    }
    let sourceBin = form.elements.binLocation.value;
    if (stockMovement) {
      state.barcodeAutoSaving = true;
      $('#saveBarcodeManualScan').disabled = true;
      try {
        const resolved = await api(`/api/scans/resolve-code?${new URLSearchParams({ dealerCode: form.elements.dealerCode.value,
          rawValue: form.elements.part.value.trim(), barcodeFormat: 'UNKNOWN' })}`);
        const bins = (resolved.binOptions || []).filter(bin => Number(bin.availableQty) >= Number(form.elements.qty.value));
        if (!bins.length) {
          toast('No eligible physical stock for this quantity. Scan its unique UPI if the stock is individually tracked.', 'error');
          return;
        }
        sourceBin = bins.length === 1 ? bins[0].binLocation
          : await window.DakshSkuBinPicker.choose(bins, form.elements.part.value.trim());
        if (!sourceBin) return;
      } catch (error) {
        toast(error.message || 'Could not resolve source stock.', 'error');
        return;
      } finally {
        state.barcodeAutoSaving = false;
        $('#saveBarcodeManualScan').disabled = false;
      }
    }
    // Adapt the screen to the proven manual-save path, including its duplicate
    // confirmation, master validation and permission checks. The clone is detached.
    const manualForm = $('#manualScanForm').cloneNode(true);
    ['dealerCode', 'type', 'part', 'qty', 'regdNo', 'jobCardNo', 'partName', 'category', 'mrp', 'dlc'].forEach((name) => {
      manualForm.elements[name].value = form.elements[name].value;
    });
    manualForm.elements.bin.value = sourceBin;
    manualForm.elements.rawScan.value = '';
    manualForm.elements.part.disabled = false;
    if (form.elements.type.value === 'INWARD') state.validatedManualBin = state.validatedBarcodeBin;
    manualForm.elements.regdNo.disabled = false;
    manualForm.elements.jobCardNo.disabled = false;
    clearTimeout(form.elements.rawScan.autoSaveTimer);
    state.barcodeAutoSaving = true;
    $('#saveBarcodeManualScan').disabled = true;
    try {
      const result = await submitScan(manualForm, { confirmBeforeSave: false });
      if (result?.scan) fillPart(form, {
        ...result.scan,
        partName: result.scan.partDescription || result.scan.partName,
        category: result.scan.category || result.scan.productCategory
      });
      if (!manualForm.elements.part.value) resetBarcodeScanFields(form);
    } finally {
      state.barcodeAutoSaving = false;
      $('#saveBarcodeManualScan').disabled = false;
      focusNextBarcodeField();
      drainBarcodeCaptures();
    }
  }

  function restoreBarcodeScanDefaults() {
    const form = $('#barcodeScanForm');
    if (!form) return;
    if (['OUTWARD', 'FITTED'].includes(form.elements.type.value)) form.elements.binLocation.value = '';
    $('#barcodeDeviceId').value = ensureDeviceId();
    $('[name="qty"]', form).value = $('[name="qty"]', form).value || 1;
    const savedBin = localStorage.getItem(BARCODE_LAST_BIN_KEY) || '';
    if (savedBin && !$('[name="binLocation"]', form).value) $('[name="binLocation"]', form).value = savedBin;
    updateScanTypeFields(form);
    validateBarcodeSourceBin(form).catch(console.warn);
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
    const rawStillCurrent = !expectedRaw || !normalizePartText(rawInput?.value || '') || normalizePartText(rawInput?.value || '') === normalizePartText(expectedRaw);
    if (rawStillCurrent) {
      if (rawInput) rawInput.value = '';
      $('[name="part"]', form).value = '';
      $('[name="qty"]', form).value = 1;
      $$('.suggest-menu', form).forEach((menu) => { menu.innerHTML = ''; menu.style.display = 'none'; });
    } else {
      fillBarcodePartFromRaw();
    }
    const scanType = String($('[name="type"]', form)?.value || normalized.scanType || normalized.type || '').toUpperCase();
    if (['OUTWARD', 'FITTED'].includes(scanType)) {
      form.elements.binLocation.value = '';
      localStorage.removeItem(BARCODE_LAST_BIN_KEY);
    }
    if (['OUTWARD', 'FITTED'].includes(scanType)) {
      const status = $('#barcodePartLocationStatus');
      if (status) {
        status.dataset.lookupDone = 'false';
        status.dataset.lookupPart = '';
        status.textContent = '';
      }
    }
    $('#barcodeDeviceId').value = ensureDeviceId();
    updateScanTypeFields(form);
    return rawStillCurrent;
  }

  function focusNextBarcodeField() {
    if ($('#barcodeScanForm')?.elements.type.value === 'LOCAL_PART') { $('#localPartForm [name="partNumber"]')?.focus(); return; }
    $('#barcodeRaw')?.focus();
  }

  function scheduleBarcodeAutosave(delay = 35) {
    if ($('#barcodeScanForm')?.elements.type.value === 'LOCAL_PART') return;
    const form = $('#barcodeScanForm');
    const input = $('#barcodeRaw');
    const raw = String(input?.value || '').trim();
    if (!form || !raw) return;
    clearTimeout(input.autoSaveTimer);
    input.autoSaveTimer = setTimeout(() => {
      const capturedRaw = String(input.value || '').trim();
      if (!capturedRaw || acceptBarcodeBinQr(capturedRaw)) return;
      const bin = normalizePartText(form.elements.binLocation.value || '');
      if (!bin && !['OUTWARD', 'FITTED', 'VERIFICATION'].includes(form.elements.type.value)) {
        playScanTone('error');
        toast('Please select or scan Source Bin Location first.', 'error');
        setLivePill('barcodeReadyStatus', 'Enter Bin Location', false);
        form.elements.binLocation.focus();
        return;
      }
      if (form.elements.type.value === 'FITTED' && (!form.elements.regdNo.value.trim() || !form.elements.jobCardNo.value.trim())) {
        setLivePill('barcodeReadyStatus', 'Enter Regd No and Job Card No to save this QR', false);
        (!form.elements.regdNo.value.trim() ? form.elements.regdNo : form.elements.jobCardNo).focus();
        return;
      }
      fillBarcodePartFromRaw();
      const payload = formObject(form);
      const normalizedRaw = normalizePartText(capturedRaw);
      const key = [payload.dealerCode, bin, payload.type, normalizedRaw].join('|');
      if (state.barcodeLastCaptureKey === key && Date.now() - state.barcodeLastAt < 3000) {
        setLivePill('barcodeReadyStatus', 'Duplicate blocked', false);
        playScanTone('error');
        toast('This barcode / QR was just scanned. Check the previous scan result.', 'error');
        resetBarcodeScanFields(form);
        return;
      }
      state.barcodeLastCaptureKey = key;
      state.barcodeLastRaw = normalizedRaw;
      state.barcodeLastAt = Date.now();
      state.barcodeCaptureQueue.push({ payload, raw: capturedRaw });
      // Free the physical input immediately, so the next USB capture cannot be
      // appended to an in-flight scan. Each snapshot still uses submitScan.
      input.value = '';
      form.elements.part.value = '';
      form.elements.qty.value = 1;
      drainBarcodeCaptures();
    }, delay);
  }

  async function drainBarcodeCaptures() {
    if (state.barcodeAutoSaving) return;
    const form = $('#barcodeScanForm');
    state.barcodeAutoSaving = true;
    try {
      while (state.barcodeCaptureQueue.length) {
        const capture = state.barcodeCaptureQueue.shift();
        setStatusPill('barcodeReadyStatus', 'Saving...', 'yellow');
        await submitScan(form, { backgroundRefresh: true, expectedRaw: capture.raw, payload: capture.payload });
      }
    } catch (error) {
      playScanTone('error');
      toast(error.message || 'Scan could not be saved', 'error');
    } finally {
      state.barcodeAutoSaving = false;
    }
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
    if (viewId === 'admin') viewId = 'master';
    const role = normalizeUiRole(state.user && state.user.role);
    if (['audit_user', 'mobile_user'].includes(role)
      && !['dashboard', 'scan', 'binTransfer', 'reports', 'master'].includes(viewId)) {
      toast('This section is not available for your role.', 'error');
      return;
    }
    if (viewId === 'reports' && state.user?.permissions?.canViewReports === false) {
      toast('Report access is disabled for this account.', 'error');
      return;
    }
    if (!$(`#${viewId}`)) viewId = 'dashboard';
    localStorage.setItem(ACTIVE_VIEW_KEY, viewId);
    Array.from(document.body.classList)
      .filter((className) => className.startsWith('view-active-'))
      .forEach((className) => document.body.classList.remove(className));
    document.body.classList.add(`view-active-${viewId}`);
    $$('.side-link').forEach((item) => item.classList.toggle('active', item.dataset.view === viewId));
    $$('.view').forEach((view) => view.classList.remove('active'));
    const target = $(`#${viewId}`);
    if (target) target.classList.add('active');
    const viewTitle = viewId === 'master' && ['audit_user', 'mobile_user'].includes(normalizeUiRole(state.user?.role))
      ? 'Part Search'
      : VIEW_TITLES[viewId] || title || 'Dashboard';
    $('#viewTitle').textContent = viewTitle;
    document.title = `DAKSH INVENTORY SYSTEM - ${viewTitle}`;
    updateSystemSubline();
    if (viewId === 'dashboard' && !state.dashboardLoaded) {
      loadDashboard().catch((error) => toast(error.message, 'error'));
    } else if (viewId !== 'dashboard') {
      document.body.classList.remove('app-booting');
    }
    if (viewId === 'binTransfer') {
      const dealerCode = binTransferCriteria().dealerCode;
      if (dealerCode) loadBinTransferBins(dealerCode).catch((error) => toast(error.message, 'error'));
    }
    if (viewId === 'scan') {
      // Scan has one operator workspace; legacy controls only support existing adapters.
      $$('#scan .subview').forEach((panel) => panel.classList.toggle('active', panel.id === 'barcodeEntry'));
      state.scanHistoryPage = 1;
      restoreBarcodeScanDefaults();
      renderScanHistoryRecords();
      focusNextBarcodeField();
      const scanJobs = [loadScanHistory(), loadBarcodeBins(), loadPairingQr()];
      if (isAdmin()) scanJobs.push(loadBins());
      Promise.all(scanJobs).catch((error) => toast(error.message, 'error'));
    }
    if (viewId === 'reports') {
      loadCategories().catch((error) => toast(error.message, 'error'));
      setReportProductGroupSummaryVisible(isProductGroupSummaryReport());
      if (isProductGroupSummaryReport()) {
        loadReport({ forceRefresh: false }).catch((error) => toast(error.message, 'error'));
      } else if (activeReportType() === 'local-parts' && (state.localPartsReportStale || !state.reportLoaded || state.lastReportType !== 'local-parts')) {
        loadReport({ forceRefresh: state.localPartsReportStale }).catch((error) => toast(error.message, 'error'));
      }
    }
    if (viewId === 'master') {
      const searchJobs = [loadPartSearchFilters(), loadParts(1)];
      if (isAdmin()) searchJobs.push(loadCatalogueRequiredColumns(), loadUsers());
      Promise.all(searchJobs).catch((error) => toast(error.message, 'error'));
    }
    if (viewId === 'validator') {
      loadMasterScanValidator().catch((error) => toast(error.message, 'error'));
    }
    if (viewId === 'devices') {
      Promise.all([loadDevices(), loadPairingQr()]).catch((error) => toast(error.message, 'error'));
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
    const normalizedView = savedView === 'admin' ? 'master' : savedView;
    const viewId = $(`#${normalizedView}`) ? normalizedView : 'dashboard';
    openView(viewId, VIEW_TITLES[viewId]);
    let hasPartSearch = false;
    if (viewId === 'reports') {
      restoreReportState();
      const reportType = params.get('reportType');
      if (reportType && REPORT_TITLES[reportType]) setReportTab(reportType, { persist: false });
      if (isProductGroupSummaryReport()) {
        loadReport({ forceRefresh: false }).catch((error) => toast(error.message, 'error'));
      }
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
      if (!isProductGroupSummaryReport()) {
        resetReportPreview('Saved report filters loaded. Changes will load automatically.');
      }
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
        const target = $(`#${button.dataset.subview}`);
        target.classList.add('active');
        state.scanHistoryPage = 1;
        renderScanHistoryRecords();
        loadScanHistory().catch((error) => toast(error.message, 'error'));
        if (button.dataset.subview === 'barcodeEntry') {
          restoreBarcodeScanDefaults();
          loadBarcodeBins().catch((error) => toast(error.message, 'error'));
          focusNextBarcodeField();
        }
        if (button.dataset.subview === 'localPartEntry') {
          syncLocalPartFormIdentity();
          if (!state.localPartHistoryLoaded) loadLocalPartHistory({ page: 1 }).catch((error) => toast(error.message, 'error'));
        }
      });
    });
    $$('.master-tab').forEach((button) => {
      button.addEventListener('click', () => {
        const target = button.dataset.masterTab;
        if (button.classList.contains('admin-only') && !isAdmin()) {
          toast('Administrator access is required to open this section.', 'error');
          return;
        }
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
        if (target === 'scanModificationHistoryTab') loadScanModificationHistory().catch((error) => toast(error.message, 'error'));
        if (target === 'partMasterTab') loadAuditPriceRefreshScope().catch((error) => toast(error.message, 'error'));
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
          renderBinTransferParts(state.binTransferParts, state.binTransferParts.length ? '' : 'Click Show Parts to load available scanned parts.');
        }
      });
    });
  }

  function bindEvents() {
    if (state.eventsBound) return;
    state.eventsBound = true;
    $('#logoutBtn')?.addEventListener('click', logout);
    $('#clearCacheReloadBtn')?.addEventListener('click', () => clearCacheAndReload().catch((error) => toast(error.message, 'error')));
    $('#userMenuButton')?.addEventListener('click', (event) => {
      event.stopPropagation();
      setUserMenuOpen($('#userDropdown')?.hidden !== false);
    });
    document.addEventListener('click', (event) => {
      const copyButton = event.target.closest('.copy-part-btn');
      if (copyButton) {
        event.preventDefault();
        event.stopPropagation();
        const part = String(copyButton.dataset.part || '').trim();
        if (!part) {
          toast('Part number is not available', 'error');
          return;
        }
        copyTextValue(part, copyButton.dataset.copyLabel || 'Part number').catch((error) => toast(error.message, 'error'));
        return;
      }
      const removeButton = event.target.closest('.remove-part-btn');
      if (removeButton) {
        event.preventDefault();
        event.stopPropagation();
        if (removeButton.disabled) return;
        const part = String(removeButton.dataset.part || removeButton.dataset.partNumber || '').trim();
        const mode = String(removeButton.dataset.deleteMode || '').trim().toLowerCase();
        const scanId = String(removeButton.dataset.scanId || '').trim();
        if (mode === 'scan' && scanId) {
          deleteSingleScan(scanId).catch((error) => toast(error.message, 'error'));
          return;
        }
        deletePartScansByNumber(part, {
          dealerCode: removeButton.dataset.dealerCode || currentDealerCode(),
          auditId: removeButton.dataset.auditId || ''
        }).catch((error) => toast(error.message, 'error'));
        return;
      }
      if (!event.target.closest('#userMenu')) setUserMenuOpen(false);
    }, true);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if ($('#deleteModal') && !$('#deleteModal')?.classList.contains('hidden')) {
          closeDeleteModal(false);
          return;
        }
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
    $('#streamViewAll')?.addEventListener('click', () => openView('scan'));
    $('#topBinsViewAll')?.addEventListener('click', () => openView('reports'));
    $('#loadLabelBinsBtn')?.addEventListener('click', () => loadLabelBins().catch((error) => toast(error.message, 'error')));
    $('#labelDealerSelect')?.addEventListener('change', () => loadLabelBins().catch((error) => toast(error.message, 'error')));
    $('#barcodeBinLocation')?.addEventListener('input', (event) => {
      event.target.value = cleanDealerCode(event.target.value);
      localStorage.setItem(BARCODE_LAST_BIN_KEY, event.target.value);
      state.barcodeServerDuplicateChecks.clear();
      state.barcodeScanLocks.clear();
      state.barcodeDuplicateLocks.clear();
      setLivePill('barcodeReadyStatus', event.target.value ? 'Ready for Scan' : 'Enter Bin Location', Boolean(event.target.value));
      updateScanTypeFields(event.target.closest('form'));
      clearTimeout(state.binValidationTimer);
      state.binValidationTimer = setTimeout(() => validateBarcodeSourceBin().catch(console.warn), 250);
    });
    $('#barcodePartNumber')?.addEventListener('input', (event) => {
      clearTimeout(event.target.lookupTimer);
      event.target.lookupTimer = setTimeout(() => refreshBarcodePartDetails(), 400);
    });
    $('#barcodePartNumber')?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      saveBarcodeManualScan().catch((error) => toast(error.message, 'error'));
    });
    $('#barcodeBinLocation')?.addEventListener('keydown', (event) => {
      if (!['Enter', 'Tab'].includes(event.key)) return;
      event.preventDefault();
      acceptBarcodeBinQr(event.target.value, event.target);
      updateScanTypeFields(event.target.closest('form'));
      validateBarcodeSourceBin().then(() => { if (state.validatedBarcodeBin) focusNextBarcodeField(); }).catch(console.warn);
    });
    $('#barcodeBinLocation')?.addEventListener('change', (event) => {
      acceptBarcodeBinQr(event.target.value, event.target);
      updateScanTypeFields(event.target.closest('form'));
      validateBarcodeSourceBin().catch(console.warn);
    });
    $('#barcodeBeep')?.addEventListener('change', (event) => setText('barcodeBeepLabel', event.target.checked ? 'Beep: ON' : 'Beep: OFF'));
    $('#saveBarcodeManualScan')?.addEventListener('click', () => saveBarcodeManualScan().catch((error) => toast(error.message, 'error')));
    $('#clearBarcodeScan')?.addEventListener('click', () => {
      clearTimeout($('#barcodeRaw').autoSaveTimer);
      resetBarcodeScanFields($('#barcodeScanForm'));
      setLivePill('barcodeReadyStatus', $('#barcodeBinLocation').value ? 'Ready for Scan' : 'Enter Bin Location', Boolean($('#barcodeBinLocation').value));
      focusNextBarcodeField();
    });
    $('#manualScanForm [name="bin"]')?.addEventListener('input', (event) => {
      event.target.value = cleanDealerCode(event.target.value);
      updateScanTypeFields(event.target.closest('form'));
      clearTimeout(state.manualBinValidationTimer);
      state.manualBinValidationTimer = setTimeout(() => validateManualSourceBin().catch(console.warn), 250);
    });
    $('#manualScanForm [name="bin"]')?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const form = event.target.closest('form');
      updateScanTypeFields(form);
      validateManualSourceBin(form).then(() => { if (!$('[name="part"]', form).disabled) $('[name="part"]', form).focus(); }).catch(console.warn);
    });
    $('#clearManualScan')?.addEventListener('click', () => {
      const form = $('#manualScanForm');
      localStorage.removeItem(manualBinStorageKey(form));
      resetManualScanFields(form, { keepBin: false });
    });
    $('#clearBarcodeBin')?.addEventListener('click', () => {
      $('#barcodeBinLocation').value = '';
      localStorage.removeItem(BARCODE_LAST_BIN_KEY);
      state.barcodeServerDuplicateChecks.clear();
      state.barcodeScanLocks.clear();
      state.barcodeDuplicateLocks.clear();
      setLivePill('barcodeReadyStatus', 'Enter Bin Location', false);
      $('#barcodeBinLocation').focus();
      updateScanTypeFields($('#barcodeBinLocation').closest('form'));
    });
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
    $('#binLabelBinsPanel')?.addEventListener('change', (event) => {
      if (event.target.id === 'binLabelSelectAllBins') {
        $$('.bin-label-bin-option').forEach((box) => {
          box.checked = event.target.checked;
        });
      }
      syncBinLabelBinsSelectAllState();
      updateBinLabelBinsButton();
      clearBinLabelSelection('Click Print Selected Labels for bin-only labels, or Show Parts to choose part labels.');
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
        await submitScan(form, { confirmBeforeSave: false });
      } catch (error) {
        playScanTone('error');
        toast(error.message || 'Manual scan could not be saved', 'error');
      } finally {
        setScanFormSubmitting(form, false);
      }
    });
    $('#localPartForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      if (form.dataset.submitting === 'true') return;
      try {
        await saveLocalPart(form);
      } catch (error) {
        const message = $('#localPartFormMessage');
        if (message) {
          message.className = 'form-message error';
          message.textContent = error.message || 'Local Part could not be saved';
        }
        toast(error.message || 'Local Part could not be saved', 'error');
      }
    });
    $('#localPartSaveBtn')?.addEventListener('click', () => {
      const form = $('#localPartForm');
      if (!form || form.dataset.submitting === 'true') return;
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
      } else {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
    });
    $('#localPartClearBtn')?.addEventListener('click', () => resetLocalPartForm());
    $('#localPartForm [name="dealerCode"]')?.addEventListener('change', syncLocalPartFormIdentity);
    $('#localPartForm [name="partNumber"]')?.addEventListener('blur', (event) => {
      event.target.value = clean(event.target.value).toUpperCase();
    });
    $('#localPartHistoryRefreshBtn')?.addEventListener('click', () => loadLocalPartHistory({ page: state.localPartPage }).catch((error) => toast(error.message, 'error')));
    const localPartHistoryFilters = $('#localPartHistoryFilters');
    const scheduleLocalPartHistory = (delay = 300) => {
      clearTimeout(state.localPartFilterTimer);
      state.localPartPage = 1;
      state.localPartFilterTimer = setTimeout(() => {
        loadLocalPartHistory({ page: 1 }).catch((error) => toast(error.message, 'error'));
      }, delay);
    };
    localPartHistoryFilters?.addEventListener('submit', (event) => {
      event.preventDefault();
      scheduleLocalPartHistory(0);
    });
    localPartHistoryFilters?.addEventListener('change', () => scheduleLocalPartHistory(120));
    localPartHistoryFilters?.addEventListener('input', (event) => {
      if (event.target.matches('input[type="date"], select')) return;
      scheduleLocalPartHistory(350);
    });
    $('#localPartHistoryRows')?.addEventListener('click', (event) => {
      const editButton = event.target.closest('.local-part-edit');
      const deleteButton = event.target.closest('.local-part-delete');
      if (editButton) editLocalPart(editButton.dataset.id).catch((error) => toast(error.message, 'error'));
      if (deleteButton) deleteLocalPart(deleteButton.dataset.id).catch((error) => toast(error.message, 'error'));
    });
    $('#localPartPrevPage')?.addEventListener('click', () => loadLocalPartHistory({ page: Math.max(1, state.localPartPage - 1) }).catch((error) => toast(error.message, 'error')));
    $('#localPartNextPage')?.addEventListener('click', () => loadLocalPartHistory({ page: Math.min(state.localPartTotalPages, state.localPartPage + 1) }).catch((error) => toast(error.message, 'error')));
    $('#barcodeScanForm').addEventListener('submit', (event) => {
      event.preventDefault();
      if (String($('#barcodeRaw').value || '').trim()) scheduleBarcodeAutosave(0);
      else saveBarcodeManualScan().catch((error) => toast(error.message, 'error'));
    });
    $('#focusScanner')?.addEventListener('click', () => {
      const rawInput = $('#barcodeRaw');
      (rawInput?.disabled ? $('#barcodeBinLocation') : rawInput)?.focus();
    });
    $('#barcodeRaw').addEventListener('input', () => {
      fillBarcodePartFromRaw();
      scheduleBarcodeAutosave(200);
    });
    $('#barcodeRaw').addEventListener('keydown', (event) => {
      if (['Enter', 'Tab'].includes(event.key) && !event.shiftKey) {
        event.preventDefault();
        scheduleBarcodeAutosave(20);
      }
    });
    $('#barcodeRaw').addEventListener('change', () => scheduleBarcodeAutosave(35));
    ['regdNo', 'jobCardNo'].forEach(name => $(`#barcodeScanForm [name="${name}"]`)?.addEventListener('change', () => scheduleBarcodeAutosave(35)));
    $$('#manualScanForm [name="type"], #barcodeScanForm [name="type"]').forEach((select) => {
      updateScanTypeFields(select.closest('form'));
      select.addEventListener('change', () => {
        if (select.closest('form')?.id === 'barcodeScanForm' && ['OUTWARD', 'FITTED'].includes(select.value)) {
          select.closest('form').elements.binLocation.value = '';
          localStorage.removeItem(BARCODE_LAST_BIN_KEY);
        }
        updateScanTypeFields(select.closest('form'));
        if (select.closest('form')?.id === 'barcodeScanForm' && select.value === 'INWARD') {
          validateBarcodeSourceBin().catch(console.warn);
          select.closest('form').elements.binLocation.focus();
        }
        if (['OUTWARD', 'FITTED'].includes(String(select.value || '').toUpperCase())) {
          const form = select.closest('form');
          if (form?.id === 'barcodeScanForm') form.elements.rawScan.focus();
          else form?.querySelector('[name="part"]')?.focus();
        }
        if (select.closest('#barcodeScanForm')) scheduleBarcodeAutosave(35);
      });
    });
    $('#manualSyncBtn').addEventListener('click', runSync);
    $('#homeManualSyncBtn')?.addEventListener('click', runSync);
    $('#quickActionStartScan')?.addEventListener('click', () => {
      openView('scan');
      setTimeout(() => {
        const rawInput = $('#barcodeRaw');
        (rawInput?.disabled ? $('#barcodeBinLocation') : rawInput)?.focus();
      }, 0);
    });
    $('#quickActionManualEntry')?.addEventListener('click', () => {
      openView('scan');
      setTimeout(() => {
        const nextField = $('#barcodeScanForm [name="part"]')?.disabled
          ? $('#barcodeBinLocation')
          : $('#barcodeScanForm [name="part"]');
        nextField?.focus();
      }, 0);
    });
    $('#dashboardViewAllScans')?.addEventListener('click', () => {
      openView('scan');
      setTimeout(() => {
        $('#scanHistorySearchBtn')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 0);
    });
    $('#dashboardRefreshButton')?.addEventListener('click', () => {
      loadDashboard({ force: true }).catch((error) => toast(error.message, 'error'));
    });
    $('#dashboardDateRange')?.addEventListener('change', () => {
      updateDashboardScopeSummary();
    });
    $('#dashboardViewBins')?.addEventListener('click', () => openView('reports'));
    $('#quickActionViewReports')?.addEventListener('click', () => openView('reports'));
    $('#quickActionBinTransfer')?.addEventListener('click', () => openView('binTransfer'));
    $('#quickActionSyncNow')?.addEventListener('click', () => runSync().catch((error) => toast(error.message, 'error')));
    $('#quickActionRepairSync')?.addEventListener('click', () => repairSyncStatus().catch((error) => toast(error.message, 'error')));
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
        if (select.closest('#scanHistoryFilters')) return;
        if (select.id === 'activeDealerSwitch') {
          switchActiveDealer(select.value).catch((error) => toast(error.message, 'error'));
          return;
        }
        if (select.id === 'dashboardDealerSelect' || select.id === 'dashboardAuditDealerSelect') {
          state.dashboardDealerCode = cleanDealerCode(select.value || '');
          ['#dashboardDealerSelect', '#dashboardAuditDealerSelect'].forEach((selector) => {
            const dashboardSelect = $(selector);
            if (dashboardSelect && dashboardSelect !== select && state.dashboardDealerCode) {
              setDealerSelectValue(dashboardSelect, state.dashboardDealerCode);
              syncDealerSelectDisplay(dashboardSelect);
            }
          });
          if (select.id === 'dashboardDealerSelect') syncScanDealerScope(state.dashboardDealerCode, select);
          state.activeAudit = null;
          updateDashboardScopeSummary();
          state.reportCache.clear();
          const jobs = [];
          if (state.dashboardDealerCode) jobs.push(loadActiveAudit({ dealerCode: state.dashboardDealerCode, silent: true, allowMissing: true }));
          if ($('#reports')?.classList.contains('active') && isProductGroupSummaryReport()) jobs.push(loadReport({ forceRefresh: true }));
          Promise.all(jobs.map((job) => job.catch((error) => toast(error.message, 'error'))));
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
            .then(() => {
              if ($('#binTransferHistoryTab')?.classList.contains('active')) return loadBinTransferHistory();
            })
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
          restoreManualScanBin();
          // History filter selects have their own refresh listener below.
          if (!select.closest('#scanHistoryFilters')) {
            loadScanHistory().catch((error) => toast(error.message, 'error'));
          }
        }
        if (select.closest('#barcodeScanForm')) {
          $('#barcodeBinLocation').value = '';
          localStorage.removeItem(BARCODE_LAST_BIN_KEY);
          state.scanHistoryPage = 1;
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
        if (String(fromBin).toUpperCase() === 'ALL') {
          loadBinTransferBins(dealerCode).catch((error) => toast(error.message, 'error'));
          return;
        }
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
        .then(() => toast('Bin Transfer refreshed'))
        .catch((error) => toast(error.message, 'error'));
    });
    $('#binTransferSubmitSelectedBtn')?.addEventListener('click', () => submitUnifiedBinTransfer().catch((error) => toast(error.message, 'error')));
    let scanHistoryFilterTimer = null;
    $('#scanHistoryFilters').addEventListener('submit', (event) => {
      event.preventDefault();
      clearTimeout(scanHistoryFilterTimer);
      state.scanHistoryPage = 1;
      loadScanHistory().catch((error) => toast(error.message, 'error'));
    });
    $('#scanHistoryClearBtn')?.addEventListener('click', () => {
      clearTimeout(scanHistoryFilterTimer);
      const form = $('#scanHistoryFilters');
      form.reset();
      if (isAdminUser()) setDealerSelectValue(form.elements.dealerCode, 'ALL');
      syncDealerSelectDisplay(form.elements.dealerCode);
      state.scanHistoryPage = 1;
      loadScanHistory().catch((error) => toast(error.message, 'error'));
    });
    $('#scanHistoryPrev')?.addEventListener('click', () => {
      state.scanHistoryPage = Math.max(1, (state.scanHistoryPage || 1) - 1);
      loadScanHistory().catch((error) => toast(error.message, 'error'));
    });
    $('#scanHistoryNext')?.addEventListener('click', () => {
      state.scanHistoryPage = Math.min(state.scanHistoryPagination?.totalPages || 1, (state.scanHistoryPage || 1) + 1);
      loadScanHistory().catch((error) => toast(error.message, 'error'));
    });
    $$('#scanHistoryFilters input, #scanHistoryFilters select').forEach((field) => {
      field.addEventListener(field.tagName === 'SELECT' ? 'change' : 'input', () => {
        clearTimeout(scanHistoryFilterTimer);
        scanHistoryFilterTimer = setTimeout(() => {
          state.scanHistoryPage = 1;
          loadScanHistory().catch((error) => toast(error.message, 'error'));
        }, field.tagName === 'SELECT' ? 0 : 400);
      });
    });
    bindScanHistorySelection();
    $('#scanHistoryDeleteSelectedBtn')?.addEventListener('click', () => deleteSelectedScans().catch((error) => toast(error.message, 'error')));
    $('#scanHistoryDeleteUnknownBtn')?.addEventListener('click', () => cleanUnknownParts({}).catch((error) => toast(error.message, 'error')));
    $('#scanHistoryDeleteDealerBtn')?.addEventListener('click', () => deleteByDealerCode().catch((error) => toast(error.message, 'error')));
    $('#scanModificationHistoryRefreshBtn')?.addEventListener('click', () => loadScanModificationHistory().catch((error) => toast(error.message, 'error')));
    $$('#scanModificationHistoryFilters input, #scanModificationHistoryFilters select').forEach((field) => {
      field.addEventListener('change', () => loadScanModificationHistory().catch((error) => toast(error.message, 'error')));
    });
    $('#scanModificationHistoryRows')?.addEventListener('click', async (event) => {
      const button = event.target.closest('.restore-audited-scan');
      if (!button || !button.dataset.scanId) return;
      if (!(await confirmDeleteAction('Restore this deleted scan?'))) return;
      const details = lastDeleteDetails();
      await api(`/api/inventory/${encodeURIComponent(button.dataset.scanId)}/restore`, { method: 'POST', body: details });
      toast('Scan restored');
      await loadScanModificationHistory();
      await refreshAfterDelete();
    });
    $('#cancelDeleteButton')?.addEventListener('click', () => closeDeleteModal(false));
    $('#confirmDeleteButton')?.addEventListener('click', () => closeDeleteModal(true));
    $('#deleteModal')?.addEventListener('click', (event) => {
      if (event.target.id === 'deleteModal') closeDeleteModal(false);
    });
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
      if (activeReportType() === 'local-parts') state.localPartsReportPage = 1;
      scheduleReportLoad(field.type === 'date' || field.type === 'datetime-local' ? 220 : 450);
    });
    reportFiltersForm?.addEventListener('change', (event) => {
      const field = event.target;
      if (!field || field.disabled) return;
      if (field.type === 'submit' || field.type === 'button' || field.type === 'reset') return;
      const fieldName = String(field.name || '').trim();
      if (!fieldName) return;
      if (activeReportType() === 'local-parts') state.localPartsReportPage = 1;
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
      if (!reportParams().dealerCode && !syncReportDealerSelection()) {
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
      scheduleReportLoad(220, 'Loading report...', { autoDownloadExcel: true });
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
      downloadActiveReportExcel().catch((error) => toast(error.message, 'error'));
    });
    $('#downloadCompleteAuditPackBtn')?.addEventListener('click', () => openAuditPackModal());
    $('#reportPdf')?.addEventListener('click', () => downloadGet(reportPath('pdf'), reportDownloadName('pdf')).catch((error) => toast(error.message, 'error')));
    $('#reportPrint')?.addEventListener('click', () => {
      if (!state.reportLoaded) return;
      window.print();
    });
    $('#localPartsReportPrev')?.addEventListener('click', () => {
      if (state.localPartsReportPage <= 1) return;
      state.localPartsReportPage -= 1;
      loadReport({ forceRefresh: true }).catch((error) => toast(error.message, 'error'));
    });
    $('#localPartsReportNext')?.addEventListener('click', () => {
      if (state.localPartsReportPage >= state.localPartsReportTotalPages) return;
      state.localPartsReportPage += 1;
      loadReport({ forceRefresh: true }).catch((error) => toast(error.message, 'error'));
    });
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
    $('#completeAuditPackClose')?.addEventListener('click', closeAuditPackModal);
    $('#completeAuditPackCancel')?.addEventListener('click', closeAuditPackModal);
    $('#completeAuditPackModal')?.addEventListener('click', (event) => {
      if (event.target.id === 'completeAuditPackModal') closeAuditPackModal();
    });
    $('#completeAuditPackSelectAll')?.addEventListener('click', () => {
      $$('#completeAuditPackReports input[type="checkbox"]').forEach((box) => {
        box.checked = true;
      });
      syncAuditPackSettingsFromDom();
    });
    $('#completeAuditPackUnselectAll')?.addEventListener('click', () => {
      $$('#completeAuditPackReports input[type="checkbox"]').forEach((box) => {
        box.checked = false;
      });
      syncAuditPackSettingsFromDom();
    });
    $('#completeAuditPackSearch')?.addEventListener('input', (event) => {
      renderAuditPackModal(event.target.value);
    });
    $('#completeAuditPackReports')?.addEventListener('change', syncAuditPackSettingsFromDom);
    $('#completeAuditPackExtras')?.addEventListener('change', syncAuditPackSettingsFromDom);
    $('#completeAuditPackGenerate')?.addEventListener('click', () => {
      generateAuditPack().catch((error) => {
        if (error && error.name === 'AbortError') return;
        toast(error.message, 'error');
      });
    });
    $('#completeAuditPackProgressClose')?.addEventListener('click', cancelAuditPackGeneration);
    $('#completeAuditPackProgressAction')?.addEventListener('click', () => {
      if (state.auditPackInProgress) cancelAuditPackGeneration();
      else closeAuditPackProgress();
    });
    $('#completeAuditPackProgressModal')?.addEventListener('click', (event) => {
      if (event.target.id === 'completeAuditPackProgressModal') {
        if (state.auditPackInProgress) cancelAuditPackGeneration();
        else closeAuditPackProgress();
      }
    });
    updateReportButtons();

    $('#reconFilters').addEventListener('submit', (event) => {
      event.preventDefault();
      loadReconciliation().catch((error) => toast(error.message, 'error'));
    });
    $$('.recon-tab').forEach((button) => button.addEventListener('click', () => activateReconciliationTab(button.dataset.reconTab)));
    $('#dealerStockDealer')?.addEventListener('change', (event) => {
      syncReconDealer(event.target.value);
      loadReconciliation().catch((error) => toast(error.message, 'error'));
    });
    $('#reconDealer')?.addEventListener('change', (event) => {
      syncReconDealer(event.target.value);
      loadReconciliation().catch((error) => toast(error.message, 'error'));
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
    $('#dealerStockTemplateDownloadBtn')?.addEventListener('click', () => downloadGet('/api/reconciliation/dealer-stock-template', 'Daksh_Dealer_Stock_Upload_Template.xlsx').catch((error) => toast(error.message, 'error')));
    $('#reconPreviewBtn')?.addEventListener('click', () => loadDealerStockPreview().catch((error) => toast(error.message, 'error')));
    $('#reconDeleteStockBtn')?.addEventListener('click', () => deleteDealerStock().catch((error) => toast(error.message, 'error')));
    $('#reconReprocessBtn')?.addEventListener('click', () => reprocessReconciliation().catch((error) => toast(error.message, 'error')));
    $('#reconReset')?.addEventListener('click', () => {
      $('#reconFilters').reset();
      loadReconciliation().catch((error) => toast(error.message, 'error'));
    });
    $('#reconExcel').addEventListener('click', () => downloadGet(`/api/reconciliation/report?${reconciliationExportQuery('excel')}`, 'Daksh_Reconciliation.xlsx').catch((error) => toast(error.message, 'error')));
    $('#reconPdf').addEventListener('click', () => downloadGet(`/api/reconciliation/report?${reconciliationExportQuery('pdf')}`, 'Daksh_Reconciliation.pdf').catch((error) => toast(error.message, 'error')));
    $('#reconPrevPage')?.addEventListener('click', () => {
      state.reconPage = Math.max(1, (state.reconPage || 1) - 1);
      renderReconciliationRows();
    });
    $('#reconNextPage')?.addEventListener('click', () => {
      state.reconPage += 1;
      renderReconciliationRows();
    });

    $('#auditPriceDealerSelect')?.addEventListener('change', () => {
      setAuditPriceRefreshMessage();
      updateAuditPriceRefreshUi();
    });
    $('#auditPriceRefreshForm')?.addEventListener('submit', (event) => {
      event.preventDefault();
      refreshAuditPricesFromMaster();
    });
    $('#partEntryForm')?.addEventListener('submit', submitPartEntry);
    $('#cancelPartEditBtn')?.addEventListener('click', () => { $('#partEntryForm').reset(); setPartEntryMode('add'); });
    $('#addPartTopBtn')?.addEventListener('click', () => setPartEntryMode('add'));
    $('#editPartTopBtn')?.addEventListener('click', () => {
      const selected = Array.from(state.partMasterSelected);
      if (selected.length !== 1) return toast('Select exactly one part in the Part List to edit.', 'error');
      editPartEntry(selected[0]);
    });
    $('#refreshPartPricesTopBtn')?.addEventListener('click', () => $('#auditPriceRefreshCard')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    $('#refreshPriceTemplateBtn')?.addEventListener('click', () => downloadGet('/api/master-catalogue/template', 'Part_Master_Catalogue_Template.xlsx').catch((error) => toast(error.message, 'error')));
    $('#auditPriceRefreshForm')?.addEventListener('change', (event) => {
      if (event.target.name === 'priceSource') $('#auditPriceUploadSource').hidden = event.target.value !== 'upload';
      updateAuditPriceRefreshUi();
    });
    $('#partSelectAll')?.addEventListener('change', (event) => {
      state.masterSearchRows.forEach((part) => {
        const code = String(part.partNumber || part.partNo || '');
        if (event.target.checked) state.partMasterSelected.add(code); else state.partMasterSelected.delete(code);
      });
      loadParts(state.masterSearch.page || 1).catch((error) => toast(error.message, 'error'));
    });
    $('#partMasterRows')?.addEventListener('change', (event) => {
      if (!event.target.matches('.part-row-select')) return;
      const code = event.target.dataset.partNumber;
      if (event.target.checked) state.partMasterSelected.add(code); else state.partMasterSelected.delete(code);
    });
    $('#partMasterRows')?.addEventListener('click', (event) => {
      const edit = event.target.closest('.part-row-edit');
      const remove = event.target.closest('.part-row-delete');
      if (edit) editPartEntry(edit.dataset.partNumber);
      if (remove) deletePartEntry(remove.dataset.partNumber);
    });
    $('#partPageSize')?.addEventListener('change', (event) => { state.masterSearch.limit = Number(event.target.value) || 10; loadParts(1).catch((error) => toast(error.message, 'error')); });
    $('#partPageButtons')?.addEventListener('click', (event) => { const button = event.target.closest('[data-page]'); if (button) loadParts(Number(button.dataset.page)).catch((error) => toast(error.message, 'error')); });
    $$('.part-sort').forEach((button) => button.addEventListener('click', () => {
      const key = button.dataset.sort;
      state.masterSearch.direction = state.masterSearch.sort === key && state.masterSearch.direction === 'asc' ? 'desc' : 'asc';
      state.masterSearch.sort = key;
      loadParts(1).catch((error) => toast(error.message, 'error'));
    }));
    $('#partUploadForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const submitter = event.submitter;
        const mode = String(submitter?.dataset?.catalogueUploadMode || 'add-missing');
        const confirmMessage = mode === 'price-only'
          ? 'Update only latest MRP and DLC for existing part master records? Missing parts in the file will be skipped. Saved audit prices stay unchanged until you use Refresh Audit Prices.'
          : 'Upload only part master records that are missing? Existing part master records will not be changed.';
        if (!window.confirm(confirmMessage)) return;
        const uploadId = createCatalogueUploadSessionId();
        const formData = new FormData(event.currentTarget);
        formData.set('uploadId', uploadId);
        formData.set('mode', mode);
        state.catalogueUploadSessionId = uploadId;
        setCatalogueUploadBusy(true, {
          uploadId,
          stage: 'received',
          percent: 0,
          message: 'Sending file to server...'
        });
        const data = await api('/api/master-catalogue/upload', { method: 'POST', body: formData });
        setCatalogueUploadBusy(false);
        const action = mode === 'price-only' ? 'price-update' : 'missing-upload';
        updateCatalogueUploadStats(data, { action });
        const fileRowsCount = Number(data.fileRowsCount || 0);
        const savedRowsCount = Number(data.savedRowsCount ?? data.importedRowsCount ?? 0);
        const duplicateRowsCount = Number(data.duplicateRowsCount ?? 0);
        const failedRowsCount = Number(data.failedRowsCount ?? 0);
        const skippedRowsCount = Number(data.modeSkippedRowsCount ?? ((data.skippedExistingRowsCount || 0) + (data.skippedMissingRowsCount || 0)));
        const accountedRowsCount = savedRowsCount + duplicateRowsCount + failedRowsCount + skippedRowsCount;
        const uploadMismatch = Boolean(data.accountingGapCount) || (fileRowsCount > 0 && accountedRowsCount !== fileRowsCount);
        const completedMessage = mode === 'price-only' ? 'MRP/DLC update completed' : 'Missing part upload completed';
        setCatalogueUploadProgress({
          ...data,
          stage: 'completed',
          message: uploadMismatch ? `${completedMessage} with mismatch` : completedMessage
        }, {
          visible: true,
          variant: uploadMismatch ? 'warning' : 'success',
          text: catalogueUploadProgressText(data)
        });
        toast(uploadMismatch
          ? `${completedMessage} with mismatch. Download failed rows to check details.`
          : completedMessage, uploadMismatch ? 'warning' : 'success');
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
    $('#downloadCompletePartMasterBtn')?.addEventListener('click', downloadCompletePartMaster);
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
      $('#partPageSize').value = '10'; state.masterSearch.limit = 10; clearPartSearch(); loadParts(1).catch((error) => toast(error.message, 'error'));
      const menu = $('#partMasterSuggestMenu');
      if (menu) menu.style.display = 'none';
    });
    $('#partExportSearchBtn')?.addEventListener('click', exportPartSearchResults);
    $('#partMasterSearchInput')?.addEventListener('blur', () => {
      setTimeout(() => {
        const menu = $('#partMasterSuggestMenu');
        if (menu) menu.style.display = 'none';
      }, 160);
    });
    $('#partPrevPageBtn')?.addEventListener('click', () => loadParts(Math.max(1, (state.masterSearch.page || 1) - 1)).catch((error) => toast(error.message, 'error')));
    $('#partNextPageBtn')?.addEventListener('click', () => loadParts((state.masterSearch.page || 1) + 1).catch((error) => toast(error.message, 'error')));
    $('#addDealerBtn')?.addEventListener('click', openAddDealerModal);
    $('#editSelectedDealerBtn')?.addEventListener('click', () => {
      const selected = Array.from(state.dealerMasterSelected);
      if (!selected.length) return toast('Please select a dealer to edit.', 'error');
      if (selected.length > 1) return toast('Please select only one dealer to edit.', 'error');
      editDealerMaster(selected[0]);
    });
    ['#closeDealerModalBtn', '#cancelDealerModalBtn'].forEach((selector) => $(selector)?.addEventListener('click', closeDealerModal));
    $('#dealerModal')?.addEventListener('click', (event) => { if (event.target.id === 'dealerModal') closeDealerModal(); });
    $('#dealerModalForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const payload = formObject(form);
      const mode = payload.mode;
      payload.active = payload.active !== 'false';
      delete payload.mode;
      try {
        if (mode === 'edit') {
          const code = cleanDealerCode(payload.dealerCode);
          await api(`/api/master/dealers/${encodeURIComponent(code)}`, { method: 'PUT', body: payload });
          toast('Dealer details updated successfully.');
        } else {
          await api('/api/master/dealers', { method: 'POST', body: payload });
          toast('Dealer created successfully.');
          $('#dealerFilterForm').reset();
          state.dealerMasterPage = 1;
        }
        closeDealerModal();
        await loadDealers({ force: true });
      } catch (error) {
        const message = error.status === 409 || /dealer code already exists/i.test(error.message || '') ? 'Dealer Code already exists.' : error.message || 'Dealer could not be saved.';
        toast(message, 'error');
      }
    });
    $('#dealerFilterForm')?.addEventListener('submit', (event) => { event.preventDefault(); state.dealerMasterPage = 1; renderDealerMaster(); });
    $('#clearDealerFiltersBtn')?.addEventListener('click', () => { $('#dealerFilterForm').reset(); state.dealerMasterPage = 1; renderDealerMaster(); });
    ['#dealerFilterBrand', '#dealerFilterLocation', '#dealerFilterAuditUser', '#dealerFilterStatus'].forEach((selector) => $(selector)?.addEventListener('change', () => { state.dealerMasterPage = 1; renderDealerMaster(); }));
    $('#dealerSelectVisible')?.addEventListener('change', (event) => {
      $('#dealerMasterRows').querySelectorAll('.dealer-row-select').forEach((checkbox) => {
        if (event.target.checked) state.dealerMasterSelected.add(checkbox.dataset.code);
        else state.dealerMasterSelected.delete(checkbox.dataset.code);
      });
      renderDealerMaster();
    });
    $('#dealerMasterRows')?.addEventListener('change', (event) => {
      const checkbox = event.target.closest('.dealer-row-select');
      if (checkbox) {
        if (checkbox.checked) state.dealerMasterSelected.add(checkbox.dataset.code);
        else state.dealerMasterSelected.delete(checkbox.dataset.code);
        renderDealerMaster();
        return;
      }
      const select = event.target.closest('.dealer-audit-action');
      if (!select) return;
      const action = select.value;
      const dealerCode = select.dataset.code;
      const auditId = select.dataset.auditId;
      if (action === 'start') startNewAuditForDealer(dealerCode).catch((error) => toast(error.message, 'error'));
      else if (action === 'complete') handleAuditComplete(auditId, dealerCode).catch((error) => toast(error.message, 'error'));
      else if (action === 'lock') handleAuditLock(auditId, dealerCode).catch((error) => toast(error.message, 'error'));
      else if (action === 'reopen') handleAuditReopen(auditId, dealerCode).catch((error) => toast(error.message, 'error'));
      select.value = '';
    });
    $('#dealerMasterRows')?.addEventListener('click', (event) => {
      const edit = event.target.closest('.dealer-row-edit');
      if (edit) return editDealerMaster(edit.dataset.code);
      const remove = event.target.closest('.dealer-row-delete');
      if (remove) deleteDealerMaster(remove.dataset.code, remove.dataset.name).catch((error) => toast(error.message, 'error'));
    });
    $$('.dealer-sort').forEach((button) => button.addEventListener('click', () => {
      const key = button.dataset.sort;
      const sort = state.dealerMasterSort;
      state.dealerMasterSort = { key, direction: sort.key === key && sort.direction === 'asc' ? 'desc' : 'asc' };
      renderDealerMaster();
    }));
    $('#dealerPrevPage')?.addEventListener('click', () => { state.dealerMasterPage = Math.max(1, state.dealerMasterPage - 1); renderDealerMaster(); });
    $('#dealerNextPage')?.addEventListener('click', () => { state.dealerMasterPage += 1; renderDealerMaster(); });
    $('#dealerPageButtons')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-page]');
      if (button) { state.dealerMasterPage = Number(button.dataset.page) || 1; renderDealerMaster(); }
    });
    $('#binMasterForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const dealerCode = cleanDealerCode($('[name="dealerCode"]', event.currentTarget)?.value || '');
      const saved = await api('/api/bin-master/create', { method: 'POST', body: formObject(event.currentTarget) });
      toast('Bin saved');
      event.currentTarget.reset();
      $('[name="dealerCode"]', event.currentTarget).value = dealerCode;
      if ($('#binManagementDealer')) $('#binManagementDealer').value = dealerCode;
      await loadBins();
      await loadBinTransferDestinationBins(dealerCode, $('.bin-transfer-from')?.value || '').catch(() => null);
      await refreshBinLabelBinsAndSelect(dealerCode, [saved.bin?.binCode || '']);
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
      await refreshBinLabelBinsAndSelect(dealerCode, (data.bins || []).map((bin) => bin.binCode));
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
      const form = event.currentTarget;
      try {
        const payload = formObject(form);
        if (payload.role !== 'admin' && !cleanDealerAccessInput(payload.dealerAccess).length) {
          payload.dealerAccess = selectedScanDealerCode() || selectedDashboardDealerCode() || (state.activeAudit && state.activeAudit.dealerCode) || '';
        }
        payload.dealerAccess = cleanDealerAccessInput(payload.dealerAccess);
        payload.approved = $('[name="approved"]', form).checked;
        payload.active = $('[name="active"]', form).checked;
        const data = await api('/api/users/create', { method: 'POST', body: payload });
        toast('User created');
        form.reset();
        renderDealerAccessOptions();
        $('[name="approved"]', form).checked = true;
        $('[name="active"]', form).checked = true;
        showCreatedUser(data.user);
        renderAuditUserOptions();
      } catch (error) {
        toast(error.message, 'error');
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
    $('#allowUnknownToggle')?.addEventListener('change', (event) => {
      localStorage.setItem('dakshAllowUnknown', event.target.checked ? 'true' : 'false');
      toast(event.target.checked ? 'Unknown save prompt enabled' : 'Unknown save prompt disabled');
    });
    $('#smartBinSuggestionToggle')?.addEventListener('change', () => saveSmartBinSuggestionSettings().catch((error) => toast(error.message, 'error')));
    $('#smartBinAllowMultipleLocationsToggle')?.addEventListener('change', () => saveSmartBinSuggestionSettings().catch((error) => toast(error.message, 'error')));
    $('#smartBinRequireReasonToggle')?.addEventListener('change', () => saveSmartBinSuggestionSettings().catch((error) => toast(error.message, 'error')));
    $('#smartBinMaxLocationsInput')?.addEventListener('change', () => saveSmartBinSuggestionSettings().catch((error) => toast(error.message, 'error')));
    $('#smartBinExistingBinSelect')?.addEventListener('change', () => refreshSmartBinActionLabels(smartBinPromptPayload || {}));
    $('#smartBinUseExistingBtn')?.addEventListener('click', () => resolveSmartBinSuggestionAction('USE_EXISTING_BIN', smartBinPromptPayload || {}).catch((error) => toast(error.message, 'error')));
    $('#smartBinSaveNewBtn')?.addEventListener('click', () => resolveSmartBinSuggestionAction('SAVE_NEW_BIN', smartBinPromptPayload || {}).catch((error) => toast(error.message, 'error')));
    $('#smartBinCancelBtn')?.addEventListener('click', () => resolveSmartBinSuggestionAction('CANCEL', smartBinPromptPayload || {}).catch((error) => toast(error.message, 'error')));
  }

  function bindSocket() {
    if (!window.io) return;
    if (state.dashboardSocket) return;
    const socketOptions = { transports: ['websocket', 'polling'], reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000, reconnectionDelayMax: 5000, auth: { token: state.token } };
    const socket = apiBaseUrl() ? window.io(apiBaseUrl(), socketOptions) : window.io(socketOptions);
    state.dashboardSocket = socket;
    socket.on('dealer-stock:upload:progress', (progress = {}) => {
      if (!state.dealerStockUploadId || progress.progressId !== state.dealerStockUploadId) return;
      const message = $('#dealerStockUploadMessage');
      if (!message) return;
      if (progress.stage === 'parsing') {
        message.textContent = 'Validating Dealer Stock...';
      } else if (progress.stage === 'validating') {
        message.textContent = `Validating ${progress.processed || 0} / ${progress.total || 0}`;
      } else if (progress.stage === 'processing') {
        message.textContent = `Processing ${progress.processed || 0} / ${progress.total || 0}`;
      }
    });
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
    }, 60000);
    socket.on('disconnect', (reason) => {
      console.warn('[DASHBOARD] socket disconnected', reason);
      addConnectionLog(`Socket disconnected: ${reason}`, 'warning');
    });
    socket.on('connect_error', (error) => {
      console.warn('[DASHBOARD] socket connect error', error.message);
      addConnectionLog(`Socket reconnecting: ${error.message}`, 'warning');
    });
    socket.on('scan:saved', (scan = {}) => {
      state.lastRealtimeAt = Date.now();
      if (scan && (scan.partNumber || scan.part || scan.scanId || scan.uniqueScanId)) {
        handleNewScan(scan).catch(console.warn);
      }
      markReportsStale('scan saved', { autoRefresh: false });
      // handleNewScan already inserts the committed scan into the visible list;
      // reloading full scan history after every save slows continuous scanning.
      if ($('#binTransfer')?.classList.contains('active')) {
        queueBinTransferStockRefresh();
        loadBinTransferHistory().catch(console.warn);
      }
    });
    socket.on('scan:duplicate', (scan = {}) => {
      state.lastRealtimeAt = Date.now();
      toast(`Duplicate scan: ${scan.partNumber || scan.part || ''}`, 'error');
    });
    socket.on('scan:deleted', () => {
      queueReconciliationRefresh('scan deleted');
      refreshPartStockSummary().catch(console.warn);
      if ($('#scan')?.classList.contains('active')) queueScanRefresh(500);
      if ($('#binTransfer')?.classList.contains('active')) queueBinTransferStockRefresh();
    });
    socket.on('scan:count:update', (payload = {}) => {
      state.lastRealtimeAt = Date.now();
    });
    socket.on('dashboard:update', (payload = {}) => {
      state.lastRealtimeAt = Date.now();
      markReportsStale('dashboard update', { autoRefresh: false });
      // Keep the displayed dashboard snapshot stable until the user refreshes it.
      updateScannerStatusBar({ at: new Date() });
    });
    socket.on('inventory:update', (payload = {}) => {
      state.lastRealtimeAt = Date.now();
      markReportsStale('inventory update', { autoRefresh: false });
      refreshPartStockSummary(payload).catch(console.warn);
      if ($('#scan')?.classList.contains('active')) {
        clearTimeout(state.scanHistoryRealtimeTimer);
        state.scanHistoryRealtimeTimer = setTimeout(() => loadScanHistory().catch(console.warn), 80);
      }
    });
    socket.on('reports:update', () => {
      state.lastRealtimeAt = Date.now();
      markReportsStale('report broadcast', { autoRefresh: false });
      if ($('#binTransfer')?.classList.contains('active')) queueBinTransferStockRefresh();
    });
    socket.on('dealer-stock:update', (payload = {}) => {
      state.lastRealtimeAt = Date.now();
      markReportsStale('dealer stock update', { autoRefresh: false });
      // The upload response already carries the bounded preview, and the
      // submitting tab refreshes reconciliation exactly once after commit.
      if (payload.reason === 'dealer-stock-uploaded') return;
      if (activeReconDealer() && (!payload.dealerCode || cleanDealerCode(payload.dealerCode) === activeReconDealer())) {
        loadDealerStockPreview().catch(() => undefined);
        queueReconciliationRefresh('dealer stock update');
      }
    });
    socket.on('local-parts:update', (payload = {}) => {
      state.lastRealtimeAt = Date.now();
      markLocalPartsReportStale();
      const payloadDealer = cleanDealerCode(payload.dealerCode || '');
      const localDealer = localPartSelectedDealer();
      if ($('#localPartEntry')?.classList.contains('active') && (!payloadDealer || !localDealer || payloadDealer === localDealer)) {
        loadLocalPartHistory({ page: state.localPartPage }).catch(() => undefined);
      }
      if ($('#reports')?.classList.contains('active') && activeReportType() === 'local-parts') {
        const reportDealer = cleanDealerCode(reportParams().dealerCode || '');
        if (!payloadDealer || !reportDealer || payloadDealer === reportDealer) refreshLocalPartsReportIfVisible().catch(() => undefined);
      }
    });
    socket.on('mrp:updated', (scan = {}) => {
      state.lastRealtimeAt = Date.now();
      prependScanHistory(scan);
      markReportsStale('scan pricing update', { autoRefresh: false });
    });
    socket.on('scanner:activity', (activity = {}) => {
      state.lastRealtimeAt = Date.now();
      queueDeviceRefresh();
    });
    socket.on('scanner:status', (device = {}) => {
      updateScannerStatusBar({ connectedDevices: state.activeDeviceCount, activeScannerCount: state.activeDeviceCount, lastActivityAt: device.lastActivity || device.lastSeen || new Date() });
    });
    socket.on('stats:update', (payload = {}) => {
      state.lastRealtimeAt = Date.now();
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
      if (isAdmin()) loadBins().catch(console.warn);
      queueDashboardRefresh(250);
    });
    function handleInactiveAuditEvent() {
      state.activeAudit = null;
      updateActiveAuditUi();
      if (isAdmin()) loadBins().catch(console.warn);
      queueDashboardRefresh(250);
      if (isAdmin()) loadDevices().catch(console.warn);
      loadDealers({ force: true }).catch(console.warn);
    }
    socket.on('audit:completed', handleInactiveAuditEvent);
    socket.on('audit:closed', handleInactiveAuditEvent);
    socket.on('audit:reopened', () => {
      loadActiveAudit({ silent: true, allowMissing: true }).catch(console.warn);
      loadDealers({ force: true }).catch(console.warn);
      queueDashboardRefresh(250);
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
      // The single-scan realtime event already updated the visible row. The
      // scan acknowledgement is not a sync completion and must not trigger
      // full sync status, device, and dashboard reloads for every barcode.
      if (payload.source === 'sync-api') return;
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
    socket.on('audit:prices-refreshed', () => {
      state.lastRealtimeAt = Date.now();
      refreshViewsAfterAuditPriceRefresh();
    });
    socket.on('master:update', (payload = {}) => {
      state.partMasterLookupCache.clear();
      state.reportFilterDropdownsLoadedAt = 0;
      markReportsStale('master update');
      const jobs = [];
      if ($('#scan')?.classList.contains('active') && isAdmin()) jobs.push(loadBins());
      if ($('#reports')?.classList.contains('active')) jobs.push(loadCategories());
      if ($('#master')?.classList.contains('active')) {
        jobs.push(loadPartSearchFilters());
        if (isAdmin()) jobs.push(loadCatalogueRequiredColumns(), loadUsers());
      }
      queueDashboardRefresh(400);
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
