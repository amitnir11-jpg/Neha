(function () {
  function storageGet(key) {
    try {
      return window.localStorage ? localStorage.getItem(key) : null;
    } catch (error) {
      console.warn('Local browser storage read failed:', key, error);
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      if (window.localStorage) localStorage.setItem(key, value);
    } catch (error) {
      console.warn('Local browser storage write failed:', key, error);
    }
  }

  function storageRemove(key) {
    try {
      if (window.localStorage) localStorage.removeItem(key);
    } catch (error) {
      console.warn('Local browser storage remove failed:', key, error);
    }
  }

  function storageJson(key) {
    const raw = storageGet(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (error) {
      console.warn('Local browser storage JSON was invalid and has been reset:', key, error);
      storageRemove(key);
      return null;
    }
  }

  const state = {
    token: storageGet('dakshToken') || '',
    user: storageJson('dakshUser'),
    dealers: [],
    audits: [],
    deleteAction: null,
    lastReportRows: [],
    reportFilterSettings: {}
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const REPORT_FILTER_DEFAULTS = ['dealer', 'dateRange', 'scanType', 'scanStatus', 'userName', 'syncStatus'];
  const REPORT_FILTER_OPTIONS = [
    ['dealer', 'Dealer'],
    ['dateRange', 'Date / Scan Time Range'],
    ['scanType', 'Scan Type'],
    ['scanStatus', 'Scan Status'],
    ['userName', 'User Name'],
    ['syncStatus', 'Sync Status'],
    ['audit', 'Audit'],
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
    ['model', 'Model']
  ];

  function page() {
    return document.body.dataset.page;
  }

  function currency(value) {
    return Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }

  function dateTime(value) {
    if (!value) return '';
    if (typeof value === 'string' && /^\d{2}-[A-Za-z]{3}-\d{4}\s+\d{2}:\d{2}:\d{2}\s+(AM|PM)$/i.test(value.trim())) {
      return value.trim().replace(/\s+(am|pm)$/i, (match) => match.toUpperCase());
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    }).formatToParts(date).reduce((acc, part) => {
      if (part.type !== 'literal') acc[part.type] = part.value;
      return acc;
    }, {});
    return `${parts.day}-${parts.month}-${parts.year} ${parts.hour}:${parts.minute}:${parts.second} ${String(parts.dayPeriod || '').toUpperCase()}`;
  }

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function selectedLegacyReportFilterKeys() {
    return new Set((state.reportFilterSettings['legacy-final-report'] || REPORT_FILTER_DEFAULTS).filter(Boolean));
  }

  function applyLegacyReportFilterVisibility() {
    const selected = selectedLegacyReportFilterKeys();
    $$('[data-report-filter-key]', $('#reportFilterForm')).forEach((node) => {
      const visible = selected.has(node.dataset.reportFilterKey);
      node.classList.toggle('hidden', !visible);
      if (!visible) {
        $$('input, select, textarea', node).forEach((field) => {
          if (field.type === 'checkbox' || field.type === 'radio') field.checked = false;
          else field.value = '';
        });
      }
    });
  }

  function renderLegacyReportFilterSettingsList() {
    const list = $('#legacyReportFilterSettingsList');
    if (!list) return;
    const selected = selectedLegacyReportFilterKeys();
    list.innerHTML = REPORT_FILTER_OPTIONS.map(([key, label]) => `
      <label>
        <input type="checkbox" value="${escapeHtml(key)}" ${selected.has(key) ? 'checked' : ''}>
        <span>${escapeHtml(label)}</span>
      </label>
    `).join('');
  }

  async function loadLegacyReportFilterSettings() {
    try {
      const data = await api('/api/report-filter-settings/legacy-final-report');
      state.reportFilterSettings['legacy-final-report'] = Array.isArray(data.selectedFilters) ? data.selectedFilters : REPORT_FILTER_DEFAULTS;
    } catch (error) {
      state.reportFilterSettings['legacy-final-report'] = REPORT_FILTER_DEFAULTS;
      console.warn('Report filter settings load failed', error);
    }
    applyLegacyReportFilterVisibility();
  }

  async function saveLegacyReportFilterSettings(selectedFilters) {
    const data = await api('/api/report-filter-settings/legacy-final-report', {
      method: 'POST',
      body: { selectedFilters }
    });
    state.reportFilterSettings['legacy-final-report'] = Array.isArray(data.selectedFilters) ? data.selectedFilters : selectedFilters;
    applyLegacyReportFilterVisibility();
    toast('Report filter settings saved');
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
      return new URL(href, window.location.origin).origin !== window.location.origin;
    } catch (error) {
      return false;
    }
  }

  function enterpriseLink(value, href, options = {}) {
    const text = String(value === undefined || value === null || value === '' ? '-' : value);
    if (text === '-' || !href) return escapeHtml(text);
    const external = options.external ?? isExternalHref(href);
    const className = ['enterprise-link', options.className || ''].filter(Boolean).join(' ');
    return `<a class="${escapeHtml(className)}" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(options.label || `Open ${text} in a new tab`)}" data-external="${external ? 'true' : 'false'}">${escapeHtml(text)}</a>`;
  }

  function partLink(partNumber) {
    const part = String(partNumber || '').trim();
    return part ? enterpriseLink(part, dashboardHref({ view: 'master', partNumber: part }), { className: 'table-link', label: `Open part ${part} in a new tab` }) : escapeHtml('-');
  }

  function deviceLink(deviceId) {
    const id = String(deviceId || '').trim();
    return id ? enterpriseLink(id, dashboardHref({ view: 'devices', deviceId: id }), { className: 'table-link', label: `Open device ${id} in a new tab` }) : escapeHtml('-');
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

  function toast(message, type = 'success') {
    const node = $('#toast');
    if (!node) return;
    node.textContent = message;
    node.className = `toast active ${type}`;
    setTimeout(() => node.classList.remove('active'), 3800);
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
      const error = new Error(apiErrorMessage(data, response.statusText));
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  async function fetchBlob(path, fileName) {
    const response = await fetch(path, {
      headers: state.token ? { Authorization: `Bearer ${state.token}` } : {}
    });
    if (!response.ok) {
      let message = response.statusText;
      try {
        const data = await parseApiResponse(response);
        message = apiErrorMessage(data, message);
      } catch (error) {
        message = response.statusText;
      }
      throw new Error(message);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function requireSession() {
    if (!state.token) {
      window.location.href = '/';
      return false;
    }
    return true;
  }

  function clearSession() {
    state.token = '';
    state.user = null;
    storageRemove('dakshToken');
    storageRemove('dakshUser');
  }

  function saveSession(payload) {
    state.token = payload.token;
    state.user = payload.user;
    storageSet('dakshToken', payload.token);
    storageSet('dakshUser', JSON.stringify(payload.user));
  }

  function logout() {
    clearSession();
    window.location.href = '/';
  }

  function setUserChrome() {
    const badge = $('#userBadge');
    if (badge && state.user) badge.textContent = `${state.user.name || state.user.username} - ${state.user.role}`;
    $$('.admin-only').forEach((node) => node.classList.toggle('hidden', !state.user || state.user.role !== 'admin'));
    const logoutButton = $('#logoutButton');
    if (logoutButton) logoutButton.addEventListener('click', logout);
  }

  function formValues(form) {
    return Object.fromEntries(new FormData(form).entries());
  }

  function cleanDealerCode(value) {
    const text = String(value || '').trim();
    if (text.toLowerCase() === 'all') return 'all';
    const match = text.match(/\(([^()]+)\)\s*$/);
    return (match ? match[1] : text).trim().toUpperCase();
  }

  function queryFromForm(form) {
    const params = new URLSearchParams();
    Object.entries(formValues(form)).forEach(([key, value]) => {
      if (value === undefined || value === null || String(value).trim() === '') return;
      params.set(key, key === 'dealerCode' ? cleanDealerCode(value) : String(value).trim());
    });
    return params.toString();
  }

  function clientDeviceId() {
    let id = storageGet('dakshDeviceId');
    if (!id) {
      id = `WEB-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      storageSet('dakshDeviceId', id);
    }
    return id;
  }

  async function validateStoredLogin() {
    if (!state.token) return false;
    try {
      const data = await api('/api/auth/me');
      state.user = data.user || state.user;
      storageSet('dakshUser', JSON.stringify(state.user));
      return true;
    } catch (error) {
      clearSession();
      return false;
    }
  }

  async function initLogin() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('logout') === '1' || params.get('forceLogin') === '1') {
      clearSession();
      window.history.replaceState({}, document.title, '/');
    }

    if (await validateStoredLogin()) {
      window.location.href = '/dashboard';
      return;
    }

    $$('.tab-button').forEach((button) => {
      button.addEventListener('click', () => {
        $$('.tab-button').forEach((item) => item.classList.remove('active'));
        button.classList.add('active');
        $$('.login-form').forEach((form) => form.classList.remove('active'));
        
        const tab = button.dataset.loginTab;
        if (tab === 'reset') {
          const tokenInput = $('#resetTokenInput');
          if (tokenInput && tokenInput.value) {
            const f = $('#resetPasswordForm'); if (f) f.classList.add('active');
          } else {
            const f = $('#resetRequestForm'); if (f) f.classList.add('active');
          }
        } else {
          const f = $(`#${tab}LoginForm`); if (f) f.classList.add('active');
        }
      });
    });

    if (params.get('resetToken')) {
      const tokenInput = $('#resetTokenInput');
      const emailInput = $('#resetEmailInput');
      if (tokenInput) tokenInput.value = params.get('resetToken') || '';
      if (emailInput) emailInput.value = params.get('email') || '';
      const resetButton = $('[data-login-tab="reset"]');
      if (resetButton) resetButton.click();
    }

    $('#adminLoginForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const message = $('#loginMessage');
      try {
        const payload = formValues(event.currentTarget);
        console.log("Login request:", payload);
        const data = await api('/api/auth/login', { method: 'POST', body: payload });
        console.log("Login response:", data);
        saveSession(data);
        message.className = 'form-message success';
        message.textContent = 'Login successful';
        window.location.href = '/dashboard';
      } catch (error) {
        message.className = 'form-message error';
        message.textContent = error.message;
      }
    });

    $('#staffLoginForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const message = $('#loginMessage');
      try {
        const payload = formValues(event.currentTarget);
        console.log("Login request:", payload);
        const data = await api('/api/auth/login', { method: 'POST', body: payload });
        console.log("Login response:", data);
        saveSession(data);
        message.className = 'form-message success';
        message.textContent = 'Login successful';
        window.location.href = '/dashboard';
      } catch (error) {
        message.className = 'form-message error';
        message.textContent = error.message;
      }
    });

    $('#registerLoginForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const message = $('#loginMessage');
      try {
        const payload = formValues(event.currentTarget);
        const data = await api('/api/auth/register', { method: 'POST', body: payload });
        event.currentTarget.reset();
        message.className = 'form-message success';
        message.textContent = data.message || 'User request created. Wait for admin approval.';
      } catch (error) {
        message.className = 'form-message error';
        message.textContent = error.message;
      }
    });

    $('#resetRequestForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const message = $('#loginMessage');
      try {
        const data = await api('/api/auth/forgot-password', { method: 'POST', body: formValues(event.currentTarget) });
        message.className = data.mailSent === false ? 'form-message error' : 'form-message success';
        message.textContent = data.message || 'OTP reset link sent.';
      } catch (error) {
        message.className = 'form-message error';
        message.textContent = error.message;
      }
    });

    $('#resetPasswordForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const message = $('#loginMessage');
      try {
        const data = await api('/api/auth/reset-password', { method: 'POST', body: formValues(event.currentTarget) });
        event.currentTarget.reset();
        message.className = 'form-message success';
        message.textContent = data.message || 'Password reset successful.';
      } catch (error) {
        message.className = 'form-message error';
        message.textContent = error.message;
      }
    });
  }

  function selectOptions(dealers, selected = '') {
    return '<option value="all">All dealers</option>' + dealers.map((dealer) => {
      const isSelected = cleanDealerCode(selected) === cleanDealerCode(dealer.dealerCode) ? 'selected' : '';
      return `<option value="${escapeHtml(dealer.dealerCode)}" ${isSelected}>${escapeHtml(dealer.dealerName)} (${escapeHtml(dealer.dealerCode)})</option>`;
    }).join('');
  }

  async function loadDealers() {
    const data = await api('/api/dealers');
    state.dealers = data.dealers || [];
    state.audits = data.audits || [];

    $$('.dealer-select').forEach((select) => {
      const current = select.value;
      const first = select.id === 'scanDealerSelect' ? '<option value="">Select dealer</option>' : '<option value="">All dealers</option>';
      select.innerHTML = first + state.dealers.map((dealer) => {
        const isSelected = current === dealer.dealerCode ? 'selected' : '';
        return `<option value="${escapeHtml(dealer.dealerCode)}" ${isSelected}>${escapeHtml(dealer.dealerName)} (${escapeHtml(dealer.dealerCode)})</option>`;
      }).join('');
    });

    renderDealerTable();
  }

  function renderDealerTable() {
    const body = $('#dealerTableBody');
    if (!body) return;
    body.innerHTML = state.dealers.map((dealer) => `
      <tr>
        <td>${escapeHtml(dealer.dealerName)}</td>
        <td>${escapeHtml(dealer.dealerCode)}</td>
        <td>${escapeHtml(dealer.brand)}</td>
        <td>${escapeHtml(dealer.location)}</td>
        <td>${escapeHtml(dealer.currentAuditId)}</td>
        <td>${escapeHtml(dealer.auditorName)}</td>
        <td>${escapeHtml(dealer.generalManager)}</td>
        <td>${escapeHtml(dealer.spmName)}</td>
      </tr>
    `).join('');
  }

  function dashboardQuery() {
    const params = new URLSearchParams();
    const dealerCode = $('#dashboardDealerFilter') ? $('#dashboardDealerFilter').value : '';
    const auditId = $('#dashboardAuditFilter') ? $('#dashboardAuditFilter').value.trim() : '';
    if (dealerCode) params.set('dealerCode', dealerCode);
    if (auditId) params.set('auditId', auditId);
    params.set('limit', '300');
    return params.toString();
  }

  async function loadInventory() {
    const data = await api(`/api/inventory/list?${dashboardQuery()}`);
    renderStats(data.stats || {});
    renderRecentScans(data.records || []);
  }

  function renderStats(stats) {
    const map = {
      statToday: stats.totalScannedToday,
      statInward: stats.totalInward,
      statOutward: stats.totalOutward,
      statFitted: stats.fittedCount,
      statDamage: stats.damageCount,
      statDevices: stats.activeDevices,
      statPending: stats.pendingSync,
      statDuplicates: stats.duplicateCount,
      statMismatch: stats.mismatchCount,
      statValue: currency(stats.totalScannedValue)
    };
    Object.entries(map).forEach(([id, value]) => {
      const node = $(`#${id}`);
      if (node) node.textContent = value || 0;
    });
  }

  function scanStatus(scan) {
    const warnings = scan.warnings || [];
    if (warnings.length) return `<span class="status-warning">${escapeHtml(warnings.join(', '))}</span>`;
    return `<span class="status-ok">${scan.synced ? 'Synced' : 'OK'}</span>`;
  }

  function renderRecentScans(records) {
    const body = $('#recentScanBody');
    if (!body) return;
    $('#scanCountLabel').textContent = `${records.length} records`;
    body.innerHTML = records.map((scan) => `
      <tr>
        <td><input class="scan-checkbox" type="checkbox" value="${escapeHtml(scan._id)}"></td>
        <td>${escapeHtml(dateTime(scan.timestamp))}</td>
        <td>${partLink(scan.part)}</td>
        <td>${escapeHtml(scan.partDescription || scan.partName)}</td>
        <td>${escapeHtml(scan.qty)}</td>
        <td>${escapeHtml(scan.type)}</td>
        <td>${escapeHtml(scan.bin)}</td>
        <td>${escapeHtml(scan.dealerName || scan.dealerCode)}</td>
        <td>${deviceLink(scan.deviceId)}</td>
        <td>${scanStatus(scan)}</td>
        <td class="raw-cell" title="${escapeHtml(scan.rawScan)}">${escapeHtml(scan.rawScan)}</td>
        <td class="admin-only ${state.user && state.user.role === 'admin' ? '' : 'hidden'}">
          <button class="danger-light-button single-delete-button" data-id="${escapeHtml(scan._id)}" type="button">Delete</button>
        </td>
      </tr>
    `).join('');

    $$('.single-delete-button').forEach((button) => {
      button.addEventListener('click', () => openDeleteModal('Delete Record', 'Type DELETE to delete this scan.', async (confirmText) => {
        await api('/api/inventory/delete-selected', { method: 'POST', body: { ids: [button.dataset.id], confirmText } });
        toast('Record deleted');
        await loadInventory();
      }));
    });
  }

  async function loadDevices() {
    const data = await api('/api/devices/list');
    const list = $('#deviceList');
    if (!list) return;
    $('#deviceCountLabel').textContent = `${data.activeCount || 0} active`;
    $('#statDevices').textContent = data.activeCount || 0;
    list.innerHTML = (data.devices || []).map((device) => `
      <div class="device-item">
        <strong>${enterpriseLink(device.deviceName || device.deviceId, dashboardHref({ view: 'devices', deviceId: device.deviceId }), { className: 'table-link', label: `Open scanner ${(device.deviceName || device.deviceId)} in a new tab` })}</strong>
        <span class="muted">${deviceLink(device.deviceId)}</span>
        <span>Status: <b>${escapeHtml(device.status)}</b></span>
        <span>IP: ${escapeHtml(device.ipAddress)}</span>
        <span>Last seen: ${escapeHtml(dateTime(device.lastSeen))}</span>
        <button class="danger-light-button admin-only disconnect-device ${state.user && state.user.role === 'admin' ? '' : 'hidden'}" data-id="${escapeHtml(device.deviceId)}" type="button">Disconnect</button>
      </div>
    `).join('');

    $$('.disconnect-device').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          await api('/api/devices/disconnect', { method: 'POST', body: { deviceId: button.dataset.id } });
          toast('Device disconnected');
          await loadDevices();
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    });
  }

  function openDeleteModal(title, text, action) {
    state.deleteAction = action;
    $('#deleteModalTitle').textContent = title;
    $('#deleteModalText').textContent = text;
    $('#deleteConfirmInput').value = '';
    $('#deleteModal').classList.add('active');
    $('#deleteConfirmInput').focus();
  }

  function closeDeleteModal() {
    state.deleteAction = null;
    $('#deleteModal').classList.remove('active');
  }

  async function submitScan(form, override = false) {
    const payload = formValues(form);
    payload.override = override;
    payload.deviceId = clientDeviceId();
    if (!payload.staffName && state.user) payload.staffName = state.user.name || state.user.username;
    const data = await api('/api/inventory/scan', { method: 'POST', body: payload });
    toast(data.warnings && data.warnings.length ? 'Scan saved with admin override' : 'Scan saved');
    form.reset();
    $('#rawScanInput').focus();
    await loadInventory();
  }

  async function searchParts(q, target) {
    if (!q || q.length < 1) {
      target.style.display = 'none';
      target.innerHTML = '';
      return;
    }
    const data = await api(`/api/master/search?q=${encodeURIComponent(q)}&limit=12`);
    const parts = data.parts || [];
    target.innerHTML = parts.map((part) => `
      <div class="suggestion-item" data-part='${escapeHtml(JSON.stringify(part))}'>
        <strong>${escapeHtml(part.partNo)}</strong>
        <span>${escapeHtml(part.partDescription || part.partName)} | ${escapeHtml(part.bin || part.binLocation || '')}</span>
      </div>
    `).join('');
    target.style.display = parts.length ? 'block' : 'none';
    $$('.suggestion-item', target).forEach((item) => {
      item.addEventListener('click', () => {
        const part = JSON.parse(item.dataset.part);
        $('#partInput').value = part.partNo || '';
        $('#partNameInput').value = part.partDescription || part.partName || '';
        $('#modelInput').value = part.model || '';
        $('#yearInput').value = part.year || '';
        $('#categoryInput').value = part.category || '';
        $('#mrpInput').value = part.mrp || 0;
        $('#dlcInput').value = part.dlc || 0;
        $('#binInput').value = part.bin || '';
        target.style.display = 'none';
      });
    });
  }

  async function loadMasterSearch() {
    const q = $('#masterSearchInput').value.trim();
    const data = await api(`/api/master/search?q=${encodeURIComponent(q)}&limit=100`);
    const body = $('#masterTableBody');
    body.innerHTML = (data.parts || []).map((part) => `
      <tr>
        <td>${partLink(part.partNo || part.partNumber)}</td>
        <td>${escapeHtml(part.partDescription || part.partName)}</td>
        <td>${escapeHtml(part.model || '')}</td>
        <td>${escapeHtml(part.manufacturingYear || part.year || '')}</td>
        <td>${escapeHtml(part.productCategory || part.category)}</td>
        <td>${escapeHtml(part.mrp)}</td>
        <td>${escapeHtml(part.dlc)}</td>
        <td>${escapeHtml(part.bin || part.binLocation)}</td>
        <td>${escapeHtml(part.dealerCode || part.dealerName)}</td>
        <td>${escapeHtml(part.openingStockQty || part.quantity || part.qty || 0)}</td>
      </tr>
    `).join('');
  }

  async function loadVerification() {
    const params = dashboardQuery();
    const data = await api(`/api/reports/data?${params}`);
    const body = $('#verifyTableBody');
    if (!body) return;
    body.innerHTML = (data.finalRows || []).map((row) => `
      <tr>
        <td>${escapeHtml(row.partNo)}</td>
        <td>${escapeHtml(row.partDescription || row.partName)}</td>
        <td>${escapeHtml(row.systemQty)}</td>
        <td>${escapeHtml(row.physicalQty)}</td>
        <td>${escapeHtml(row.differenceQty)}</td>
        <td>${escapeHtml(row.status)}</td>
        <td>${escapeHtml(row.mrp)}</td>
        <td class="raw-cell" title="${escapeHtml(row.rawScanProof)}">${escapeHtml(row.rawScanProof)}</td>
      </tr>
    `).join('');
  }

  async function loadPartIntelligence(partNo) {
    const data = await api(`/api/master/intelligence/${encodeURIComponent(partNo)}`);
    const master = data.master || {};
    const result = $('#partIntelResult');
    result.innerHTML = `
      <div class="intel-grid">
        <div class="intel-cell"><span>Part Number</span>${partLink(master.partNumber || master.partNo || partNo)}</div>
        <div class="intel-cell"><span>Part Description</span>${escapeHtml(master.partDescription || master.partName || '')}</div>
        <div class="intel-cell"><span>Model</span>${escapeHtml(master.model || '')}</div>
        <div class="intel-cell"><span>Year</span>${escapeHtml(master.year || '')}</div>
        <div class="intel-cell"><span>Category</span>${escapeHtml(master.category || '')}</div>
        <div class="intel-cell"><span>MRP</span>${escapeHtml(master.mrp || 0)}</div>
        <div class="intel-cell"><span>DLC</span>${escapeHtml(master.dlc || 0)}</div>
        <div class="intel-cell"><span>Opening Stock</span>${escapeHtml(master.openingStockQty || 0)}</div>
        <div class="intel-cell"><span>Current Scanned Qty</span>${escapeHtml(data.currentScannedQty || 0)}</div>
        <div class="intel-cell"><span>Last Scanned Date</span>${escapeHtml(dateTime(data.lastScannedDate))}</div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Dealer</th><th>Type</th><th>Qty</th><th>Last Seen</th></tr></thead>
          <tbody>${(data.dealerWiseMovement || []).map((item) => `
            <tr>
              <td>${escapeHtml((item._id && (item._id.dealerName || item._id.dealerCode)) || '')}</td>
              <td>${escapeHtml(item._id ? item._id.type : '')}</td>
              <td>${escapeHtml(item.qty)}</td>
              <td>${escapeHtml(dateTime(item.lastScannedDate))}</td>
            </tr>
          `).join('')}</tbody>
        </table>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Dealer</th><th>Qty</th><th>Type</th><th>Bin</th><th>Raw Scan History</th></tr></thead>
          <tbody>${(data.rawScanHistory || []).map((scan) => `
            <tr>
              <td>${escapeHtml(dateTime(scan.time))}</td>
              <td>${escapeHtml(scan.dealerName || scan.dealerCode)}</td>
              <td>${escapeHtml(scan.qty)}</td>
              <td>${escapeHtml(scan.type)}</td>
              <td>${escapeHtml(scan.bin)}</td>
              <td class="raw-cell" title="${escapeHtml(scan.rawScan)}">${escapeHtml(scan.rawScan)}</td>
            </tr>
          `).join('')}</tbody>
        </table>
      </div>
    `;
  }

  async function downloadBackup(params, fileName) {
    const query = params ? `?${params}` : '';
    await fetchBlob(`/api/backup/download${query}`, fileName);
  }

  async function connectThisDevice() {
    try {
      const isMobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
      await api('/api/devices/connect', {
        method: 'POST',
        body: {
          deviceId: clientDeviceId(),
          deviceName: isMobile ? 'Mobile Scanner' : 'Dashboard Browser'
        }
      });
    } catch (error) {
      console.warn(error.message);
    }
  }

  function initDashboardEvents() {
    $$('.nav-link[data-view]').forEach((button) => {
      button.addEventListener('click', () => {
        $$('.nav-link').forEach((item) => item.classList.remove('active'));
        button.classList.add('active');
        $$('.view').forEach((view) => view.classList.remove('active'));
        $(`#${button.dataset.view}`).classList.add('active');
        $('#pageTitle').textContent = button.textContent;
        if (button.dataset.view === 'verifyView') loadVerification().catch((error) => toast(error.message, 'error'));
      });
    });

    $('#refreshButton')?.addEventListener('click', async () => {
      await Promise.all([loadDealers(), loadInventory(), loadDevices()]);
      toast('Dashboard refreshed');
    });
    $('#loadDashboardButton').addEventListener('click', loadInventory);
    $('#loadDealersButton').addEventListener('click', loadDealers);
    $('#loadVerifyButton').addEventListener('click', loadVerification);

    $('#scanDealerSelect').addEventListener('change', (event) => {
      const dealer = state.dealers.find((item) => item.dealerCode === event.target.value);
      $('#scanAuditId').value = dealer ? dealer.currentAuditId || '' : '';
    });

    $('#scanForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await submitScan(event.currentTarget);
      } catch (error) {
        if (error.status === 409 && error.data && error.data.requiresOverride) {
          const warnings = (error.data.warnings || []).join('\n');
          if (state.user && state.user.role === 'admin' && window.confirm(`Warnings:\n${warnings}\n\nOverride and save this scan?`)) {
            try {
              await submitScan(event.currentTarget, true);
            } catch (overrideError) {
              toast(overrideError.message, 'error');
            }
          } else {
            toast(`Scan blocked: ${warnings}`, 'error');
          }
        } else {
          toast(error.message, 'error');
        }
      }
    });

    $('#rawScanInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        $('#scanForm').requestSubmit();
      }
    });

    let partTimer;
    $('#partInput').addEventListener('input', (event) => {
      clearTimeout(partTimer);
      partTimer = setTimeout(() => {
        searchParts(event.target.value.trim(), $('#partSuggestions')).catch((error) => toast(error.message, 'error'));
      }, 180);
    });

    $('#auditForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await api('/api/dealers', { method: 'POST', body: formValues(event.currentTarget) });
        toast('Audit setup saved');
        event.currentTarget.reset();
        await loadDealers();
      } catch (error) {
        toast(error.message, 'error');
      }
    });

    // Dealer Search Functionality
    $('#dealerSearchButton').addEventListener('click', async () => {
      const dealerCode = $('#dealerSearchCode').value.trim();
      if (!dealerCode) {
        toast('Please enter dealer code', 'error');
        return;
      }

      try {
        const dealer = state.dealers.find(d => d.dealerCode === dealerCode);
        if (!dealer) {
          toast('Dealer not found', 'error');
          return;
        }

        const audit = state.audits.find(a => a.dealerCode === dealerCode);
        const startDate = audit?.auditStartDate ? new Date(audit.auditStartDate).toLocaleDateString() : 'N/A';
        const status = audit?.status || 'No Active Audit';

        const resultsDiv = $('#dealerSearchResults');
        const table = $('#dealerSearchResultsTable');
        table.innerHTML = `
          <tr>
            <td>${escapeHtml(dealer.dealerName)}</td>
            <td>${escapeHtml(dealer.dealerCode)}</td>
            <td>${startDate}</td>
            <td>${escapeHtml(status)}</td>
            <td>
              <select id="auditAction_${escapeHtml(dealer.dealerCode)}" class="dealer-action-select" data-dealer-code="${escapeHtml(dealer.dealerCode)}">
                <option value="">-- Select Action --</option>
                <option value="close">Close Audit</option>
                <option value="open">Open Audit</option>
                <option value="reopen">Reopen Audit</option>
                <option value="delete">Delete Dealer</option>
              </select>
            </td>
          </tr>
        `;
        resultsDiv.style.display = 'block';
      } catch (error) {
        toast(error.message, 'error');
      }
    });

    // Handle Dealer Action Selection
    document.addEventListener('change', async (event) => {
      if (event.target.classList.contains('dealer-action-select')) {
        const action = event.target.value;
        const dealerCode = event.target.dataset.dealerCode;

        if (!action) return;

        try {
          if (action === 'close') {
            const audit = state.audits.find(a => a.dealerCode === dealerCode);
            if (!audit) {
              toast('No active audit found', 'error');
              return;
            }
            const response = await api(`/api/audit/${audit.auditId}/close`, { method: 'POST' });
            toast('Audit closed successfully. Completed by: ' + (response.completedBy || 'Unknown'));
            $('#dealerSearchCode').value = '';
            $('#dealerSearchResults').style.display = 'none';
            await loadDealers();
          } else if (action === 'open') {
            const dealer = state.dealers.find(d => d.dealerCode === dealerCode);
            if (!dealer) return toast('Dealer not found', 'error');
            await api('/api/dealers', {
              method: 'POST',
              body: {
                dealerName: dealer.dealerName,
                dealerCode: dealer.dealerCode,
                brand: dealer.brand,
                location: dealer.location,
                auditStartDate: new Date().toISOString(),
                auditStatus: 'Active'
              }
            });
            toast('Audit opened successfully');
            $('#dealerSearchCode').value = '';
            $('#dealerSearchResults').style.display = 'none';
            await loadDealers();
          } else if (action === 'reopen') {
            const audit = state.audits.find(a => a.dealerCode === dealerCode);
            if (!audit) {
              toast('No audit found', 'error');
              return;
            }
            await api('/api/dealers', {
              method: 'POST',
              body: {
                auditId: audit.auditId,
                dealerName: audit.dealerName,
                dealerCode: audit.dealerCode,
                brand: audit.brand,
                location: audit.location,
                auditStartDate: audit.auditStartDate,
                auditStatus: 'Active'
              }
            });
            toast('Audit reopened successfully');
            $('#dealerSearchCode').value = '';
            $('#dealerSearchResults').style.display = 'none';
            await loadDealers();
          } else if (action === 'delete') {
            if (confirm('Are you sure you want to delete this dealer? This action cannot be undone.')) {
              await api(`/api/dealers/${dealerCode}`, { method: 'DELETE' });
              toast('Dealer deleted successfully');
              $('#dealerSearchCode').value = '';
              $('#dealerSearchResults').style.display = 'none';
              await loadDealers();
            }
          }

          // Reset dropdown
          event.target.value = '';
        } catch (error) {
          toast(error.message, 'error');
          event.target.value = '';
        }
      }
    });

    $('#masterUploadForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const data = await api('/api/master/upload', { method: 'POST', body: new FormData(event.currentTarget) });
        toast(`${data.imported} master parts uploaded, cleared ${data.clearedMasterRows || 0} old master rows`);
        await loadMasterSearch();
      } catch (error) {
        toast(error.message, 'error');
      }
    });

    $('#masterSearchButton').addEventListener('click', () => loadMasterSearch().catch((error) => toast(error.message, 'error')));
    $('#partIntelForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await loadPartIntelligence($('#partIntelInput').value.trim());
      } catch (error) {
        toast(error.message, 'error');
      }
    });

    $('#selectAllScans').addEventListener('change', (event) => {
      $$('.scan-checkbox').forEach((box) => {
        box.checked = event.target.checked;
      });
    });

    $('#deleteSelectedButton').addEventListener('click', () => {
      const ids = $$('.scan-checkbox:checked').map((box) => box.value);
      if (!ids.length) return toast('Select records first', 'error');
      openDeleteModal('Delete Selected Records', 'Type DELETE to delete selected scans.', async (confirmText) => {
        await api('/api/inventory/delete-selected', { method: 'POST', body: { ids, confirmText } });
        toast('Selected records deleted');
        await loadInventory();
      });
    });

    $('#deleteDealerButton').addEventListener('click', () => {
      const dealerCode = $('#dashboardDealerFilter').value;
      if (!dealerCode) return toast('Choose a dealer filter first', 'error');
      openDeleteModal('Delete Dealer Records', 'Type DELETE to delete all records for the selected dealer.', async (confirmText) => {
        await api('/api/inventory/delete-all', { method: 'POST', body: { scope: 'dealer', dealerCode, confirmText } });
        toast('Dealer records deleted');
        await loadInventory();
      });
    });

    $('#deleteSystemButton').addEventListener('click', () => {
      openDeleteModal('Delete All System Records', 'Type DELETE to delete all scan records in the system.', async (confirmText) => {
        await api('/api/inventory/delete-all', { method: 'POST', body: { scope: 'system', confirmText } });
        toast('All scan records deleted');
        await loadInventory();
      });
    });

    const deleteOldBtn = $('#deleteOldButton');
    if (deleteOldBtn) {
      deleteOldBtn.addEventListener('click', () => {
        const dateStr = window.prompt('Enter date (YYYY-MM-DD) to delete records before:');
        if (!dateStr) return;
        const dateBefore = new Date(dateStr);
        if (Number.isNaN(dateBefore.getTime())) return toast('Invalid date format', 'error');
        openDeleteModal('Delete Old Records', `Type DELETE to delete all scans before ${dateBefore.toLocaleDateString()}.`, async (confirmText) => {
          await api('/api/inventory/delete-all', { method: 'POST', body: { scope: 'date', dateBefore: dateBefore.toISOString(), confirmText } });
          toast('Old scan records deleted');
          await loadInventory();
        });
      });
    }

    const deleteCategoryBtn = $('#deleteCategoryButton');
    if (deleteCategoryBtn) {
      deleteCategoryBtn.addEventListener('click', () => {
        const category = window.prompt('Enter exact category name to delete:');
        if (!category) return;
        openDeleteModal('Delete Category Records', `Type DELETE to delete all scans in category "${category}".`, async (confirmText) => {
          await api('/api/inventory/delete-all', { method: 'POST', body: { scope: 'category', category, confirmText } });
          toast(`Category "${category}" records deleted`);
          await loadInventory();
        });
      });
    }

    const deleteBinBtn = $('#deleteBinButton');
    if (deleteBinBtn) {
      deleteBinBtn.addEventListener('click', () => {
        const bin = window.prompt('Enter exact bin location to delete:');
        if (!bin) return;
        openDeleteModal('Delete Bin Records', `Type DELETE to delete all scans in bin "${bin}".`, async (confirmText) => {
          await api('/api/inventory/delete-all', { method: 'POST', body: { scope: 'bin', bin, confirmText } });
          toast(`Bin "${bin}" records deleted`);
          await loadInventory();
        });
      });
    }

    const mergeBinBtn = $('#mergeBinButton');
    if (mergeBinBtn) {
      mergeBinBtn.addEventListener('click', async () => {
        const sourceBin = window.prompt('Enter the exact SOURCE bin location to move items FROM:');
        if (!sourceBin) return;
        const destBin = window.prompt('Enter the exact DESTINATION bin location to move items INTO:');
        if (!destBin) return;
        if (sourceBin === destBin) return toast('Source and destination cannot be the same', 'error');

        if (window.confirm(`Are you sure you want to merge "${sourceBin}" into "${destBin}"? This will update all master parts and scan records.`)) {
          try {
            const data = await api('/api/master/bins/merge', { method: 'POST', body: { sourceBin, destBin } });
            toast(`Merged successfully! ${data.masterUpdated} parts and ${data.inventoryUpdated} scans moved.`);
            await loadInventory();
          } catch (error) {
            toast(error.message, 'error');
          }
        }
      });
    }

    const migrateDataButton = $('#migrateDataButton');
    if (migrateDataButton) {
      migrateDataButton.addEventListener('click', async () => {
        if (!window.confirm('This will normalize old field names (like partNumber -> partNo) in your master parts data. This operation is safe to run multiple times but should only be needed once. Continue?')) {
          return;
        }
        try {
          const data = await api('/api/master/migrate', { method: 'POST' });
          toast(`Migration complete. ${data.migrated} documents updated.`);
          await loadMasterSearch();
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    }

    $('#cancelDeleteButton').addEventListener('click', closeDeleteModal);
    $('#confirmDeleteButton').addEventListener('click', async () => {
      const confirmText = $('#deleteConfirmInput').value;
      if (confirmText !== 'DELETE') return toast('Type DELETE to confirm', 'error');
      try {
        if (state.deleteAction) await state.deleteAction(confirmText);
        closeDeleteModal();
      } catch (error) {
        toast(error.message, 'error');
      }
    });

    $('#downloadBackupButton').addEventListener('click', () => {
      downloadBackup('', 'Daksh_Inventory_Backup.json').catch((error) => toast(error.message, 'error'));
    });
    $('#downloadDealerBackupButton').addEventListener('click', () => {
      const dealerCode = $('#dashboardDealerFilter').value;
      if (!dealerCode) return toast('Choose a dealer filter first', 'error');
      downloadBackup(`dealerCode=${encodeURIComponent(dealerCode)}`, `Daksh_Dealer_${dealerCode}_Backup.json`).catch((error) => toast(error.message, 'error'));
    });
    $('#downloadDateBackupButton').addEventListener('click', () => {
      const today = new Date().toISOString().slice(0, 10);
      downloadBackup(`from=${today}&to=${today}`, `Daksh_Date_${today}_Backup.json`).catch((error) => toast(error.message, 'error'));
    });
    $('#restoreBackupForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await api('/api/backup/restore', { method: 'POST', body: new FormData(event.currentTarget) });
        toast('Backup restored');
        await Promise.all([loadDealers(), loadInventory(), loadDevices()]);
      } catch (error) {
        toast(error.message, 'error');
      }
    });

    const resetUserForm = $('#resetUserForm');
    if (resetUserForm) {
      resetUserForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const message = $('#resetUserMessage') || { set className(c) {}, set textContent(t) { toast(t); } };
        try {
          const payload = formValues(event.currentTarget);
          if (!payload.username) throw new Error("User not found");

          let url, body;
          if (payload.newPassword) {
            url = '/api/auth/users/reset-password';
            body = { username: payload.username, newPassword: payload.newPassword };
          } else if (payload.newPin) {
            url = '/api/auth/users/reset-pin';
            body = { username: payload.username, newPin: payload.newPin };
          } else {
            throw new Error("Provide a new Password or PIN");
          }

          const data = await api(url, { method: 'POST', body });
          message.className = 'form-message success';
          message.textContent = data.message || 'Reset successful';
          event.currentTarget.reset();
        } catch (error) {
          message.className = 'form-message error';
          message.textContent = error.message;
        }
      });
    }
  }

  async function initDashboard() {
    if (!requireSession()) return;
    setUserChrome();
    $('#staffNameInput').value = state.user ? state.user.name || state.user.username || '' : '';
    $('#mobileUrl').textContent = `Mobile scanner: ${window.location.origin}/dashboard`;
    initDashboardEvents();
    await connectThisDevice();
    await Promise.all([loadDealers(), loadInventory(), loadDevices(), loadMasterSearch()]);

    if (window.io) {
      const socket = window.io();
      socket.on('connect', () => socket.emit('device:hello', { deviceId: clientDeviceId(), deviceName: 'Dashboard Browser' }));
      socket.on('scan:new', () => loadInventory().catch(console.warn));
      socket.on('scan:deleted', () => loadInventory().catch(console.warn));
      socket.on('stats:update', () => loadInventory().catch(console.warn));
      socket.on('devices:update', () => loadDevices().catch(console.warn));
      socket.on('dealers:update', () => loadDealers().catch(console.warn));
      socket.on('master:update', () => loadMasterSearch().catch(console.warn));
      socket.on('backup:restored', () => Promise.all([loadDealers(), loadInventory(), loadDevices()]).catch(console.warn));
    }
  }

  function renderReport(data) {
    const summary = data.summary || {};
    $('#reportSystemQty').textContent = summary.totalSystemQty || 0;
    $('#reportPhysicalQty').textContent = summary.totalPhysicalQty || 0;
    $('#reportMatched').textContent = summary.matched || 0;
    $('#reportShort').textContent = summary.short || 0;
    $('#reportExcess').textContent = summary.excess || 0;
    $('#reportNotScanned').textContent = summary.notScanned || 0;

    state.lastReportRows = data.finalRows || [];
    $('#reportRowsLabel').textContent = `${state.lastReportRows.length} rows`;
    $('#reportTableBody').innerHTML = state.lastReportRows.map((row) => `
      <tr>
        <td>${partLink(row.partNo ?? row.partNumber)}</td>
        <td>${escapeHtml(row.partDescription ?? row.partName)}</td>
        <td>${escapeHtml(row.model || '')}</td>
        <td>${escapeHtml(row.manufacturingYear || row.year || '')}</td>
        <td>${escapeHtml(row.category ?? row.productCategory)}</td>
        <td>${escapeHtml(row.scanUPIMRP || '')}</td>
        <td>${escapeHtml(currency(row.currentCatalogueMRP || 0))}</td>
        <td>${escapeHtml(currency(row.averageScannedMRP || 0))}</td>
        <td>${escapeHtml(row.pricePeriod || '')}</td>
        <td>${escapeHtml(row.priceAgeingDays || 0)}</td>
        <td>${escapeHtml(row.partMovement || '')}</td>
        <td>${escapeHtml(row.dlc)}</td>
        <td>${escapeHtml(row.productGroup || '')}</td>
        <td>${escapeHtml(row.partSubGroup ?? row.productSubGroup ?? '')}</td>
        <td>${escapeHtml(row.systemQty)}</td>
        <td>${escapeHtml(row.physicalQty)}</td>
        <td>${escapeHtml(row.differenceQty ?? row.difference)}</td>
        <td>${escapeHtml(currency(row.finalInventoryValue || row.physicalMrpValue || 0))}</td>
        <td>${escapeHtml(row.status)}</td>
      </tr>
    `).join('');
  }

  async function loadReportPreview() {
    const selectedDealerCode = cleanDealerCode($('#reportDealerFilter')?.value || '');
    const selectedDealer = state.dealers.find((dealer) => cleanDealerCode(dealer.dealerCode) === selectedDealerCode);
    const dealerCode = selectedDealer?.dealerCode || selectedDealerCode || '';
    const params = Object.fromEntries(new URLSearchParams(queryFromForm($('#reportFilterForm'))).entries());
    const hasFilter = Object.values(params).some((value) => String(value || '').trim());
    if (!hasFilter) {
      renderReport({ summary: {}, finalRows: [] });
      const message = $('#legacyReportMessage');
      if (message) {
        message.className = 'form-message';
        message.textContent = 'Please select filters and click Submit.';
      }
      return;
    }
    params.dealerCode = dealerCode;
    console.log("Selected dealer value:", selectedDealerCode);
    console.log("Report params:", params);
    const query = new URLSearchParams(params).toString();
    const url = `/api/reports/data?${query}`;
    console.log("Report API URL:", url);
    const message = $('#legacyReportMessage');
    if (message) {
      message.className = 'form-message loading';
      message.textContent = 'Loading report...';
    }
    const data = await api(url);
    renderReport(data);
    if (message) {
      const rows = data.finalRows || [];
      message.className = rows.length ? 'form-message success' : 'form-message error';
      message.textContent = rows.length ? '' : 'No report data found for selected filter';
    }
  }

  async function loadReportDealers() {
    const data = await api('/api/dealers');
    state.dealers = data.dealers || [];
    $('#reportDealerFilter').innerHTML = selectOptions(state.dealers);
  }

  function initReportEvents() {
    $('#reportFilterForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await loadReportPreview();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
    $('#resetReportFilterButton')?.addEventListener('click', () => {
      $('#reportFilterForm').reset();
      renderReport({ summary: {}, finalRows: [] });
      const message = $('#legacyReportMessage');
      if (message) {
        message.className = 'form-message';
        message.textContent = 'Please select filters and click Submit.';
      }
    });
    $('#legacyReportFilterSettingsOpen')?.addEventListener('click', () => {
      renderLegacyReportFilterSettingsList();
      $('#legacyReportFilterSettingsModal')?.classList.remove('hidden');
    });
    $('#legacyReportFilterSettingsClose')?.addEventListener('click', () => $('#legacyReportFilterSettingsModal')?.classList.add('hidden'));
    $('#legacyReportFilterSettingsModal')?.addEventListener('click', (event) => {
      if (event.target.id === 'legacyReportFilterSettingsModal') $('#legacyReportFilterSettingsModal')?.classList.add('hidden');
    });
    $('#legacyReportFilterSettingsDefault')?.addEventListener('click', () => {
      $$('#legacyReportFilterSettingsList input[type="checkbox"]').forEach((box) => {
        box.checked = REPORT_FILTER_DEFAULTS.includes(box.value);
      });
    });
    $('#legacyReportFilterSettingsSave')?.addEventListener('click', async () => {
      const selected = $$('#legacyReportFilterSettingsList input[type="checkbox"]:checked').map((box) => box.value);
      try {
        await saveLegacyReportFilterSettings(selected);
        $('#legacyReportFilterSettingsModal')?.classList.add('hidden');
        renderReport({ summary: {}, finalRows: [] });
        const message = $('#legacyReportMessage');
        if (message) {
          message.className = 'form-message';
          message.textContent = 'Report filters updated. Click Submit to fetch data.';
        }
      } catch (error) {
        toast(error.message, 'error');
      }
    });

    $('#downloadFullReportButton').addEventListener('click', () => {
      const query = queryFromForm($('#reportFilterForm'));
      fetchBlob(`/api/reports/full?${query}`, 'Daksh_Inventory_Full_Report.xlsx').catch((error) => toast(error.message, 'error'));
    });

    $('#downloadCsvReportButton')?.addEventListener('click', () => {
      const query = queryFromForm($('#reportFilterForm'));
      fetchBlob(`/api/reports/full.csv?${query}`, 'Daksh_Inventory_Full_Report.csv').catch((error) => toast(error.message, 'error'));
    });

    $('#downloadPartsRefreshTemplateButton')?.addEventListener('click', () => {
      const query = queryFromForm($('#reportFilterForm'));
      fetchBlob(`/api/reports/parts-inventory-refresh-template.csv?${query}`, 'Parts_Inventory_Refresh_Template.csv').catch((error) => toast(error.message, 'error'));
    });

    $('#downloadPdfButton').addEventListener('click', () => {
      const query = queryFromForm($('#reportFilterForm'));
      fetchBlob(`/api/reports/pdf?${query}`, 'Daksh_Inventory_Report.pdf').catch((error) => toast(error.message, 'error'));
    });

    $('#printReportButton').addEventListener('click', () => window.print());

    $('#emailReportButton').addEventListener('click', async () => {
      const email = window.prompt('Enter dealer email');
      if (!email) return;
      try {
        const filters = formValues($('#reportFilterForm'));
        await api('/api/reports/email', { method: 'POST', body: { email, filters } });
        toast('Report email sent');
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  }

  async function initReport() {
    if (!requireSession()) return;
    setUserChrome();
    initReportEvents();
    await loadReportDealers();
    await loadLegacyReportFilterSettings();
    if (window.io) {
      const socket = window.io();
      socket.on('scan:new', () => {});
      socket.on('scan:deleted', () => {});
      socket.on('stats:update', () => {});
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    secureNewTabLinks();
    if (page() === 'login') initLogin().catch((error) => toast(error.message, 'error'));
    if (page() === 'dashboard') initDashboard().catch((error) => toast(error.message, 'error'));
    if (page() === 'report') initReport().catch((error) => toast(error.message, 'error'));
  });
})();
