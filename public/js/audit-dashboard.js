/**
 * PREMIUM INVENTORY AUDIT DASHBOARD
 * Enterprise-grade dashboard with real-time updates and performance optimizations
 * Requires: Socket.IO, minimal dependencies
 */

class AuditDashboard {
  constructor() {
    this.currentUser = null;
    this.currentDealer = null;
    this.currentAudit = null;
    this.dashboardData = null;
    this.recentScans = [];
    this.currentPage = 1;
    this.pageSize = 20;
    this.autoRefresh = true;
    this.autoRefreshInterval = null;
    this.filterCache = {};
    this.socket = null;
    this.isLoading = false;
    
    this.init();
  }

  /**
   * Initialize dashboard
   */
  async init() {
    this.setupEventListeners();
    this.setupRealtime();
    await this.loadInitialData();
    this.startAutoRefresh();
  }

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    // Sidebar navigation
    document.querySelectorAll('.menu-item').forEach(item => {
      item.addEventListener('click', e => {
        const section = item.dataset.section;
        if (section === 'dashboard') {
          e.preventDefault();
          this.refreshDashboard();
        } else if (item.getAttribute('href') === '#') {
          e.preventDefault();
        }
      });
    });

    // Sidebar toggle
    document.getElementById('sidebarToggle')?.addEventListener('click', () => {
      document.getElementById('sidebar').classList.toggle('collapsed');
    });

    // Logout
    document.getElementById('logoutBtn')?.addEventListener('click', () => this.logout());
    document.getElementById('mobileLogoutBtn')?.addEventListener('click', () => this.logout());

    // Refresh button
    document.getElementById('refreshBtn')?.addEventListener('click', () => this.refreshDashboard());

    // Filter controls
    document.getElementById('applyFiltersBtn')?.addEventListener('click', () => this.applyFilters());
    document.getElementById('clearFiltersBtn')?.addEventListener('click', () => this.clearFilters());

    // Auto-refresh toggle
    document.getElementById('autoRefreshToggle')?.addEventListener('change', (e) => {
      this.autoRefresh = e.target.checked;
      if (this.autoRefresh) {
        this.startAutoRefresh();
      } else {
        this.stopAutoRefresh();
      }
    });

    // Scan table controls
    document.getElementById('scanTableSearch')?.addEventListener('input', () => this.filterScansTable());
    document.getElementById('scanTableSort')?.addEventListener('change', () => this.sortScansTable());

    // Pagination
    document.getElementById('prevPageBtn')?.addEventListener('click', () => this.previousPage());
    document.getElementById('nextPageBtn')?.addEventListener('click', () => this.nextPage());

    // Alert action buttons
    document.querySelectorAll('.alert-action').forEach(btn => {
      btn.addEventListener('click', (e) => this.handleAlertAction(e.currentTarget.dataset.alertType));
    });

    // Modal close
    document.getElementById('closeModalBtn')?.addEventListener('click', () => this.closeModal());

    // Scan row clicks
    document.addEventListener('click', (e) => {
      const row = e.target.closest('.scans-table tbody tr');
      if (row && !row.classList.contains('loading-row')) {
        const partNumber = row.querySelector('td:nth-child(2)')?.textContent;
        if (partNumber) {
          this.showPartDetails(partNumber);
        }
      }
    });
  }

  /**
   * Setup real-time updates via Socket.IO
   */
  setupRealtime() {
    if (typeof io !== 'undefined') {
      this.socket = io();

      this.socket.on('scan:new', (data) => {
        if (this.autoRefresh) {
          this.prependScan(data);
        }
      });

      this.socket.on('scan:synced', (data) => {
        this.updateScanStatus(data);
      });

      this.socket.on('dashboard:update', (data) => {
        this.updateDashboardStats(data);
      });

      this.socket.on('connect', () => {
        this.updateConnectionStatus(true);
      });

      this.socket.on('disconnect', () => {
        this.updateConnectionStatus(false);
      });
    }
  }

  /**
   * Load initial dashboard data
   */
  async loadInitialData() {
    try {
      // Get current user
      await this.loadCurrentUser();
      
      // Get active audit
      await this.loadActivAudit();
      
      // Load dashboard stats
      await this.refreshDashboard();
      
      // Load filter options
      await this.loadFilterOptions();
    } catch (error) {
      console.error('Error loading initial data:', error);
      this.showErrorNotification('Failed to load dashboard data');
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Load current user information
   */
  async loadCurrentUser() {
    try {
      const response = await fetch('/api/auth/me');
      if (response.ok) {
        const user = await response.json();
        this.currentUser = user;
        document.getElementById('currentUser').textContent = user.username || 'User';
      }
    } catch (error) {
      console.error('Error loading user:', error);
    }
  }

  /**
   * Load active audit
   */
  async loadActivAudit() {
    try {
      const response = await fetch('/api/audit/active');
      if (response.ok) {
        const audit = await response.json();
        this.currentAudit = audit;
        document.getElementById('dealerCode').textContent = audit.dealerCode || '-';
        document.getElementById('auditDate').textContent = this.formatDate(new Date(audit.createdAt));
      }
    } catch (error) {
      console.error('Error loading active audit:', error);
    }
  }

  /**
   * Refresh entire dashboard
   */
  async refreshDashboard() {
    if (this.isLoading) return;

    try {
      this.isLoading = true;
      const filters = this.getActiveFilters();
      
      const response = await fetch(`/api/inventory/dashboard?${this.buildQueryString(filters)}`);
      if (!response.ok) throw new Error('Failed to fetch dashboard data');
      
      const data = await response.json();
      this.dashboardData = data;
      
      // Update UI
      this.updateKPICards(data.stats);
      this.updateScansList(data.recent);
      this.updateInfoPanel(data.stats);
      this.updateAlerts(data.stats);
      this.updateLastSyncTime();
      
      // Update pagination
      this.currentPage = 1;
      this.displayScansTable();
    } catch (error) {
      console.error('Error refreshing dashboard:', error);
      this.showErrorNotification('Failed to refresh dashboard');
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Update KPI cards with data
   */
  updateKPICards(stats) {
    // DMS Stock Value
    const dmsValue = stats.dmsStockValue || 0;
    document.getElementById('dmsStockValue').textContent = this.formatCurrency(dmsValue);

    // Actual Scanned Value
    const actualValue = stats.totalScannedValue || 0;
    document.getElementById('actualScannedValue').textContent = this.formatCurrency(actualValue);

    // Difference Value
    const difference = dmsValue - actualValue;
    document.getElementById('differenceValue').textContent = this.formatCurrency(difference);
    
    const diffTrend = document.getElementById('differenceTrend');
    if (difference < 0) {
      diffTrend.classList.add('down');
    } else {
      diffTrend.classList.remove('down');
    }

    // Audit Completion %
    const completion = Math.min(stats.auditCompletion || 0, 100);
    document.getElementById('auditCompletion').textContent = completion + '%';
    document.getElementById('completionBar').style.width = completion + '%';
    const ring = document.querySelector('.progress-ring');
    const ringValue = document.getElementById('ringValue');
    if (ring) ring.style.setProperty('--completion', `${completion}%`);
    if (ringValue) ringValue.textContent = completion + '%';

    // DMS Quantity
    document.getElementById('dmsQuantity').textContent = this.formatNumber(stats.dmsQuantity || 0);

    // Actual Quantity
    document.getElementById('actualQuantity').textContent = this.formatNumber(stats.actualQuantity || 0);

    // Duplicate Scans
    document.getElementById('duplicateScans').textContent = this.formatNumber(stats.duplicateCount || 0);

    // Short Parts
    document.getElementById('shortParts').textContent = this.formatNumber(stats.shortPartCount || 0);

    // Update trend indicators
    this.updateTrendIndicators(stats);
  }

  /**
   * Update trend indicators
   */
  updateTrendIndicators(stats) {
    const indicators = [
      { element: 'dmsStockTrendText', value: stats.dmsTrend || 0 },
      { element: 'actualValueTrendText', value: stats.actualValueTrend || 0 },
      { element: 'differenceTrendText', value: stats.differenceTrend || 0 },
      { element: 'dmsQtyTrendText', value: stats.dmsQtyTrend || 0 },
      { element: 'actualQtyTrendText', value: stats.actualQtyTrend || 0 },
      { element: 'duplicateTrendText', value: stats.duplicateTrend || 0 },
      { element: 'shortPartsTrendText', value: stats.shortPartsTrend || 0 }
    ];

    indicators.forEach(({ element, value }) => {
      const el = document.getElementById(element);
      if (el) {
        el.textContent = Math.abs(value).toFixed(1) + '%';
      }
    });
  }

  /**
   * Update scans table
   */
  updateScansList(scans) {
    this.recentScans = scans || [];
    this.displayScansTable();
  }

  /**
   * Display scans in table with pagination
   */
  displayScansTable() {
    const start = (this.currentPage - 1) * this.pageSize;
    const end = start + this.pageSize;
    const pageScans = this.recentScans.slice(start, end);

    const tbody = document.getElementById('scansTableBody');
    if (pageScans.length === 0) {
      tbody.innerHTML = '<tr class="loading-row"><td colspan="9" style="text-align: center; padding: 20px;">No scans found</td></tr>';
      this.updatePagination(0);
      return;
    }

    tbody.innerHTML = pageScans.map(scan => this.createScanRow(scan)).join('');
    this.updatePagination(this.recentScans.length);
  }

  /**
   * Create a single scan table row
   */
  createScanRow(scan) {
    const time = this.formatDateTime(new Date(scan.timestamp || scan.createdAt));
    const partNumber = scan.partNumber || '-';
    const description = scan.partDescription || '-';
    const category = scan.category || '-';
    const bin = scan.bin || scan.binLocation || '-';
    const type = scan.scanType || scan.type || '-';
    const status = this.getStatusBadge(scan.scanStatus || scan.status);
    const user = scan.userId || '-';

    return `
      <tr>
        <td>${time}</td>
        <td><strong>${partNumber}</strong></td>
        <td>${description}</td>
        <td>${category}</td>
        <td>${bin}</td>
        <td>${type}</td>
        <td>${status}</td>
        <td>${user}</td>
        <td><span class="row-action" aria-hidden="true">→</span></td>
      </tr>
    `;
  }

  /**
   * Get status badge HTML
   */
  getStatusBadge(status) {
    const statusMap = {
      'valid': { class: 'valid', label: 'Valid' },
      'verification': { class: 'verification', label: 'Verification' },
      'duplicate': { class: 'duplicate', label: 'Duplicate' },
      'outward': { class: 'outward', label: 'Outward' },
      'pending': { class: 'pending', label: 'Pending' },
      'synced': { class: 'valid', label: 'Synced' }
    };

    const statusInfo = statusMap[status?.toLowerCase()] || { class: 'pending', label: status || 'Unknown' };
    return `<span class="status-badge ${statusInfo.class}">${statusInfo.label}</span>`;
  }

  /**
   * Update info panel
   */
  updateInfoPanel(stats) {
    document.getElementById('todayScans').textContent = this.formatNumber(stats.todayScanCount || 0);
    document.getElementById('totalCategories').textContent = this.formatNumber(stats.totalCategories || 0);
    document.getElementById('binLocations').textContent = this.formatNumber(stats.totalBinLocations || 0);
    document.getElementById('pendingSync').textContent = this.formatNumber(stats.pendingSync || 0);
    document.getElementById('missingDLC').textContent = this.formatNumber(stats.missingDLC || 0);
    document.getElementById('totalDuplicates').textContent = this.formatNumber(stats.duplicateCount || 0);
  }

  /**
   * Update alerts section
   */
  updateAlerts(stats) {
    document.getElementById('alertDuplicateCount').textContent = this.formatNumber(stats.duplicateCount || 0);
    document.getElementById('alertShortCount').textContent = this.formatNumber(stats.shortPartCount || 0);
    document.getElementById('alertPendingSyncCount').textContent = this.formatNumber(stats.pendingSync || 0);
    document.getElementById('alertMissingDLCCount').textContent = this.formatNumber(stats.missingDLC || 0);
  }

  /**
   * Update pagination info
   */
  updatePagination(total) {
    const start = (this.currentPage - 1) * this.pageSize + 1;
    const end = Math.min(this.currentPage * this.pageSize, total);
    
    document.getElementById('paginationInfo').textContent = 
      total === 0 ? 'No records' : `Showing ${start}-${end} of ${total}`;
    
    document.getElementById('pageNumber').textContent = this.currentPage;
    document.getElementById('prevPageBtn').disabled = this.currentPage === 1;
    document.getElementById('nextPageBtn').disabled = end >= total;
  }

  /**
   * Load filter options
   */
  async loadFilterOptions() {
    try {
      const response = await fetch('/api/inventory/filter-options');
      if (response.ok) {
        const options = await response.json();
        
        // Populate category filter
        const categorySelect = document.getElementById('categoryFilter');
        (options.categories || []).forEach(cat => {
          const option = document.createElement('option');
          option.value = cat;
          option.textContent = cat;
          categorySelect.appendChild(option);
        });

        // Populate bin location filter
        const binSelect = document.getElementById('binLocationFilter');
        (options.bins || []).forEach(bin => {
          const option = document.createElement('option');
          option.value = bin;
          option.textContent = bin;
          binSelect.appendChild(option);
        });
      }
    } catch (error) {
      console.error('Error loading filter options:', error);
    }
  }

  /**
   * Apply filters
   */
  applyFilters() {
    this.currentPage = 1;
    this.refreshDashboard();
  }

  /**
   * Clear filters
   */
  clearFilters() {
    document.getElementById('auditDateFilter').value = '';
    document.getElementById('categoryFilter').value = '';
    document.getElementById('binLocationFilter').value = '';
    document.getElementById('scanTypeFilter').value = '';
    document.getElementById('partSearchFilter').value = '';
    this.applyFilters();
  }

  /**
   * Get active filters
   */
  getActiveFilters() {
    return {
      auditDate: document.getElementById('auditDateFilter').value,
      category: document.getElementById('categoryFilter').value,
      binLocation: document.getElementById('binLocationFilter').value,
      scanType: document.getElementById('scanTypeFilter').value,
      partNumber: document.getElementById('partSearchFilter').value
    };
  }

  /**
   * Filter scans table
   */
  filterScansTable() {
    const searchText = document.getElementById('scanTableSearch').value.toLowerCase();
    const rows = document.querySelectorAll('.scans-table tbody tr');

    rows.forEach(row => {
      const text = row.textContent.toLowerCase();
      row.style.display = text.includes(searchText) ? '' : 'none';
    });
  }

  /**
   * Sort scans table
   */
  sortScansTable() {
    const sortBy = document.getElementById('scanTableSort').value;

    switch (sortBy) {
      case 'oldest':
        this.recentScans.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        break;
      case 'part':
        this.recentScans.sort((a, b) => (a.partNumber || '').localeCompare(b.partNumber || ''));
        break;
      case 'status':
        this.recentScans.sort((a, b) => (a.scanStatus || '').localeCompare(b.scanStatus || ''));
        break;
      case 'newest':
      default:
        this.recentScans.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    }

    this.currentPage = 1;
    this.displayScansTable();
  }

  /**
   * Previous page
   */
  previousPage() {
    if (this.currentPage > 1) {
      this.currentPage--;
      this.displayScansTable();
    }
  }

  /**
   * Next page
   */
  nextPage() {
    const maxPage = Math.ceil(this.recentScans.length / this.pageSize);
    if (this.currentPage < maxPage) {
      this.currentPage++;
      this.displayScansTable();
    }
  }

  /**
   * Prepend new scan
   */
  prependScan(scan) {
    this.recentScans.unshift(scan);
    this.displayScansTable();
  }

  /**
   * Update scan status
   */
  updateScanStatus(data) {
    const scan = this.recentScans.find(s => s._id === data.id);
    if (scan) {
      scan.scanStatus = data.status;
      this.displayScansTable();
    }
  }

  /**
   * Update dashboard stats in real-time
   */
  updateDashboardStats(stats) {
    this.dashboardData.stats = stats;
    this.updateKPICards(stats);
    this.updateInfoPanel(stats);
    this.updateAlerts(stats);
  }

  /**
   * Update last sync time
   */
  updateLastSyncTime() {
    const now = new Date();
    document.getElementById('lastSync').textContent = this.formatTime(now);
  }

  /**
   * Update connection status
   */
  updateConnectionStatus(connected) {
    const status = document.getElementById('syncStatus');
    if (status) {
      if (connected) {
        status.classList.add('online');
      } else {
        status.classList.remove('online');
      }
    }
  }

  /**
   * Start auto-refresh
   */
  startAutoRefresh() {
    if (this.autoRefreshInterval) clearInterval(this.autoRefreshInterval);
    this.autoRefreshInterval = setInterval(() => {
      if (!this.isLoading) {
        this.refreshDashboard();
      }
    }, 30000); // 30 seconds
  }

  /**
   * Stop auto-refresh
   */
  stopAutoRefresh() {
    if (this.autoRefreshInterval) {
      clearInterval(this.autoRefreshInterval);
      this.autoRefreshInterval = null;
    }
  }

  /**
   * Show part details modal
   */
  async showPartDetails(partNumber) {
    try {
      const response = await fetch(`/api/inventory/part/${encodeURIComponent(partNumber)}`);
      if (response.ok) {
        const part = await response.json();
        const modal = document.getElementById('partDetailsModal');
        document.getElementById('modalPartNumber').textContent = part.partNumber;
        
        let detailsHtml = `
          <div class="part-detail">
            <div class="detail-row">
              <span class="label">Part Number:</span>
              <span class="value">${part.partNumber}</span>
            </div>
            <div class="detail-row">
              <span class="label">Description:</span>
              <span class="value">${part.partDescription}</span>
            </div>
            <div class="detail-row">
              <span class="label">Category:</span>
              <span class="value">${part.category}</span>
            </div>
            <div class="detail-row">
              <span class="label">DMS Quantity:</span>
              <span class="value">${this.formatNumber(part.dmsQuantity || 0)}</span>
            </div>
            <div class="detail-row">
              <span class="label">Scanned Quantity:</span>
              <span class="value">${this.formatNumber(part.scannedQuantity || 0)}</span>
            </div>
            <div class="detail-row">
              <span class="label">Difference:</span>
              <span class="value">${this.formatNumber((part.dmsQuantity || 0) - (part.scannedQuantity || 0))}</span>
            </div>
          </div>
        `;

        document.getElementById('partDetailsContent').innerHTML = detailsHtml;
        modal.classList.add('active');
      }
    } catch (error) {
      console.error('Error showing part details:', error);
    }
  }

  /**
   * Close modal
   */
  closeModal() {
    document.getElementById('partDetailsModal').classList.remove('active');
  }

  /**
   * Handle alert action
   */
  handleAlertAction(alertType) {
    console.log('Alert action:', alertType);
    // TODO: Navigate to detailed view
  }

  /**
   * Logout
   */
  async logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/';
    } catch (error) {
      console.error('Error logging out:', error);
      window.location.href = '/';
    }
  }

  /**
   * Show error notification
   */
  showErrorNotification(message) {
    // TODO: Implement notification system
    console.error(message);
  }

  /**
   * Utility: Format currency
   */
  formatCurrency(value) {
    if (!value) return '₹ 0';
    const formatted = new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(value);
    return formatted;
  }

  /**
   * Utility: Format number
   */
  formatNumber(value) {
    if (!value) return '0';
    return new Intl.NumberFormat('en-IN').format(value);
  }

  /**
   * Utility: Format date
   */
  formatDate(date) {
    return new Intl.DateTimeFormat('en-IN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);
  }

  /**
   * Utility: Format date time
   */
  formatDateTime(date) {
    return new Intl.DateTimeFormat('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    }).format(date);
  }

  /**
   * Utility: Format time
   */
  formatTime(date) {
    return new Intl.DateTimeFormat('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    }).format(date);
  }

  /**
   * Utility: Build query string
   */
  buildQueryString(filters) {
    return Object.entries(filters)
      .filter(([, v]) => v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
  }
}

// Initialize dashboard on page load
document.addEventListener('DOMContentLoaded', () => {
  window.auditDashboard = new AuditDashboard();
});
