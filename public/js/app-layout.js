(function () {
  const PAGE_META = {
    dashboard: ['Dashboard', 'Operational overview for the selected dealer and active audit.'],
    scan: ['Scan', 'Manual entry, barcode scan, and mobile scan workflows.'],
    reports: ['Reports', 'Search, filter, export, and print audit reports.'],
    binTransfer: ['Bin Transfer', 'Move parts, print bin labels, and review transfer history.'],
    reconciliation: ['Reconciliation', 'Dealer stock upload, reconciliation reports, and final summary.'],
    master: ['Master Data', 'Part master, dealer setup, approvals, backup, and tools.'],
    validator: ['Validator', 'Validate scanned parts against master data.'],
    qr: ['QR / Barcode', 'Generate barcode and bin labels.'],
    devices: ['Device Control', 'Pair scanners and monitor connected devices.'],
    syncCenter: ['Sync Report', 'Monitor mobile and offline sync activity.'],
    archiveRestore: ['Archive & Restore Center', 'Manage local audit backups and restores.']
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  // Presentation classes only: keep native controls, values and handlers intact.
  const INPUT_TYPES = new Set(['text', 'number', 'date', 'datetime-local', 'month', 'week', 'time', 'email', 'tel', 'url', 'password']);
  const CONTROL_SELECTOR = 'input, select, .bin-label-multi-button, .plain-bin-multi-button';

  function normalizeControl(control) {
    const header = control.id === 'dashboardDealerSelect';
    if (!header && !control.closest('.view, .modal')) return;
    if (control.matches('input') && !INPUT_TYPES.has(control.type)) return;
    if (control.matches('select') && (control.multiple || control.size > 1)) return;
    if (control.hidden || control.matches('.app-action-dropdown') || control.closest('[data-control-size="custom"]')) return;

    control.classList.add('app-control');
    if (header) control.classList.add('app-header-control');
    if (control.matches('select')) control.classList.add('app-select');
    else if (control.matches('input')) control.classList.add('app-input');
    else control.classList.add('app-multiselect');
    const label = control.closest('label');
    if (label && !header) label.classList.add('app-field');
  }

  function normalizeControls(root) {
    if (root.matches?.(CONTROL_SELECTOR)) normalizeControl(root);
    root.querySelectorAll(CONTROL_SELECTOR).forEach(normalizeControl);
  }

  function ensurePageTitle(view, title, subtitle) {
    if (view.querySelector(':scope > .app-page-title, :scope > .dashboard-page-heading')) return;
    const header = el('div', 'app-page-title');
    header.append(el('span', '', 'Daksh Inventory Solution'));
    header.append(el('h1', '', title));
    if (subtitle) header.append(el('p', '', subtitle));
    view.prepend(header);
  }

  function normalizeView(view) {
    const meta = PAGE_META[view.id] || [view.id || 'Page', ''];
    view.classList.add('app-page');
    // Keyboard users can focus the scrolling content without changing routes.
    if (!view.hasAttribute('tabindex')) view.tabIndex = 0;
    ensurePageTitle(view, meta[0], meta[1]);
    view.querySelectorAll('table').forEach((table) => table.classList.add('app-table'));
    view.querySelectorAll('.toolbar, .actions').forEach((node) => node.classList.add('app-toolbar'));
    view.querySelectorAll('.filter-grid, .grid-form').forEach((node) => node.classList.add('app-filter-bar'));
  }

  function syncTitle() {
    const active = document.querySelector('.view.active');
    if (!active) return;
    const meta = PAGE_META[active.id];
    if (!meta) return;
    const viewTitle = document.getElementById('viewTitle');
    if (viewTitle) viewTitle.textContent = meta[0];
  }

  function init() {
    document.querySelectorAll('.view').forEach(normalizeView);
    normalizeControls(document);
    syncTitle();
    document.addEventListener('click', (event) => {
      if (event.target.closest('[data-view], .side-link')) window.setTimeout(syncTitle, 0);
    });
    const observer = new MutationObserver((mutations) => {
      let shouldSyncTitle = false;
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'class' && mutation.target.classList.contains('view')) {
          shouldSyncTitle = true;
        }
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          if (node.matches('.view')) normalizeView(node);
          normalizeControls(node);
          node.querySelectorAll?.('table').forEach((table) => table.classList.add('app-table'));
        });
      });
      if (shouldSyncTitle) syncTitle();
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.AppLayout = {
    init,
    normalizeView,
    syncTitle
  };
})();
