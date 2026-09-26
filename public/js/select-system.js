/* Print Bin Label only: native dealer select enhancement with one chevron. */
(function () {
  'use strict';

  const TARGET_SELECTOR = '#binLabelPrintTab select.bin-transfer-print-label-dealer';
  const SELECTOR = `${TARGET_SELECTOR}:not([multiple])`;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function createChevron() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.classList.add('ds-select-chevron');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M6 9l6 6 6-6');
    svg.appendChild(path);
    return svg;
  }

  function getHost(select) {
    const parent = select.parentElement;
    if (!parent) return null;

    if (parent.classList.contains('ds-select-host') && parent.dataset.dsSelectHost === 'true') {
      return parent;
    }

    const host = document.createElement('span');
    host.className = 'ds-select-host';
    host.dataset.dsSelectHost = 'true';
    host.setAttribute('data-ds-select-host', 'true');
    parent.insertBefore(host, select);
    host.appendChild(select);
    return host;
  }

  function ensureSingleChevron(host) {
    const chevrons = Array.from(host.querySelectorAll(':scope > .ds-select-chevron'));
    chevrons.slice(1).forEach((icon) => icon.remove());
    if (!chevrons[0]) host.appendChild(createChevron());
  }

  function enhance(select) {
    if (!(select instanceof HTMLSelectElement) || select.multiple || !select.matches(TARGET_SELECTOR)) return;
    const host = getHost(select);
    if (!host) return;

    select.classList.add('ds-select-control');
    select.dataset.dsSelectEnhanced = 'true';
    select.title = select.options[select.selectedIndex]?.textContent?.trim() || '';
    ensureSingleChevron(host);
  }

  function enhanceTree(root = document) {
    if (root instanceof HTMLSelectElement) enhance(root);
    if (root && typeof root.querySelectorAll === 'function') {
      root.querySelectorAll(SELECTOR).forEach(enhance);
    }
  }

  function removeEnhancement(select) {
    if (!(select instanceof HTMLSelectElement) || !select.matches(TARGET_SELECTOR)) return;
    select.classList.remove('ds-select-control');
    delete select.dataset.dsSelectEnhanced;
    delete select.title;

    const host = select.parentElement;
    if (!host || !host.classList.contains('ds-select-host') || host.dataset.dsSelectHost !== 'true') return;
    if (host.parentElement) host.parentElement.insertBefore(select, host);
    host.remove();
  }

  function boot() {
    enhanceTree(document);
    if (!document.body || typeof MutationObserver === 'undefined') return;

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes') {
          if (mutation.target instanceof HTMLSelectElement) {
            if (mutation.target.multiple) removeEnhancement(mutation.target);
            else enhance(mutation.target);
          }
          return;
        }

        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) enhanceTree(node);
        });
      });
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['multiple', 'disabled']
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
