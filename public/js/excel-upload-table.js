(function () {
  'use strict';
  const keys = ['row', 'part', 'bin', 'qty', 'status', 'action'];
  const storageKey = 'dakshExcelUploadColumns.v1';
  const table = document.getElementById('excelUploadPartsTable');
  if (!table) return;
  const headerRow = table.tHead.rows[0];
  const body = table.tBodies[0];
  const headers = new Map(Array.from(headerRow.cells, (cell, index) => {
    cell.dataset.column = keys[index];
    return [keys[index], cell];
  }));
  let order = [...keys];
  let widths = {};
  let dragged = null;
  let resizing = false;
  let customWidths = false;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (saved && Array.isArray(saved.order) && saved.order.length === keys.length && new Set(saved.order).size === keys.length && saved.order.every(key => keys.includes(key))) order = saved.order;
    if (saved?.widths && keys.every(key => Number.isFinite(saved.widths[key]) && saved.widths[key] >= 52 && saved.widths[key] <= 1200)) {
      widths = saved.widths; customWidths = true;
    }
  } catch (_) { /* Storage may be unavailable; the table remains adjustable. */ }
  const columns = document.createElement('colgroup');
  table.insertBefore(columns, table.firstChild);
  const save = () => {
    try { localStorage.setItem(storageKey, JSON.stringify({ order, widths: customWidths ? widths : null })); } catch (_) {}
  };
  const apply = () => {
    order.forEach(key => headerRow.appendChild(headers.get(key)));
    Array.from(body.rows).forEach(row => {
      if (row.cells.length !== keys.length) return;
      Array.from(row.cells).forEach((cell, index) => { if (!cell.dataset.column) cell.dataset.column = keys[index]; });
      const cells = new Map(Array.from(row.cells, cell => [cell.dataset.column, cell]));
      order.forEach(key => row.appendChild(cells.get(key)));
    });
    columns.replaceChildren(...order.map(key => {
      const col = document.createElement('col');
      col.style.width = customWidths ? `${widths[key]}px` : `${({ row: 5, part: 36, bin: 12, qty: 8, status: 26, action: 13 })[key]}%`;
      return col;
    }));
    table.style.setProperty('table-layout', 'fixed', 'important');
    table.style.setProperty('width', customWidths ? `${keys.reduce((sum, key) => sum + widths[key], 0)}px` : '100%', 'important');
  };
  function resize(key, amount) {
    if (!customWidths) keys.forEach(column => { widths[column] = Math.max(52, Math.round(headers.get(column).getBoundingClientRect().width)); });
    customWidths = true;
    widths[key] = Math.max(52, Math.min(1200, widths[key] + amount));
    apply();
  }
  headers.forEach((header, key) => {
    header.draggable = true;
    header.title = 'Drag this heading to move the column. Drag its right edge to resize.';
    const handle = document.createElement('span');
    handle.className = 'excel-column-resize';
    handle.tabIndex = 0;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', `Resize ${header.textContent} column`);
    header.appendChild(handle);
    handle.addEventListener('pointerdown', event => {
      event.preventDefault(); event.stopPropagation();
      resizing = true; header.draggable = false;
      let lastX = event.clientX;
      const move = moveEvent => { resize(key, moveEvent.clientX - lastX); lastX = moveEvent.clientX; };
      const finish = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', finish);
        document.removeEventListener('pointercancel', finish);
        resizing = false; header.draggable = true; save();
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', finish);
      document.addEventListener('pointercancel', finish);
    });
    handle.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault(); resize(key, event.key === 'ArrowRight' ? 16 : -16); save();
    });
    header.addEventListener('dragstart', event => {
      if (resizing) { event.preventDefault(); return; }
      dragged = key; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', key);
    });
    header.addEventListener('dragover', event => { if (dragged && dragged !== key) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } });
    header.addEventListener('drop', event => {
      event.preventDefault(); if (!dragged || dragged === key) return;
      order = order.filter(column => column !== dragged);
      order.splice(order.indexOf(key), 0, dragged);
      dragged = null; apply(); save();
    });
    header.addEventListener('dragend', () => { dragged = null; });
  });
  new MutationObserver(apply).observe(body, { childList: true });
  document.querySelector('[data-excel-reset-columns]')?.addEventListener('click', () => {
    order = [...keys]; widths = {}; customWidths = false; apply(); save();
  });
  apply();
})();
