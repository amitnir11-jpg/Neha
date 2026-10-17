(function (root) {
  'use strict';
  const icons = {
    open: '<ellipse cx="12" cy="12" rx="9" ry="6"/><circle cx="12" cy="12" r="2.5"/>',
    edit: '<path d="m16 3 5 5-12 12H4v-5L16 3Z M14 5l5 5"/>',
    reverse: '<path d="M4 10V4 M4 10h6 M4 10a8 8 0 1 1 0 7"/>',
    delete: '<path d="M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7"/>'
  };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const svg = action => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[action]}</svg>`;
  const labels = { open: 'Open', edit: 'Edit', reverse: 'Reverse', delete: 'Delete' };
  function create(options) {
    const panel = document.getElementById('excelHistoryPanel');
    const $ = selector => panel.querySelector(selector);
    let batches = [], dealer = '', page = 1, sort = 'createdAt', direction = -1, busy = false, request = 0;
    const selected = new Set();
    function eligible(batch, action) {
      if (action === 'edit') return ['PENDING', 'PARTIALLY_COMMITTED'].includes(batch.status);
      if (action === 'reverse') return options.isAdmin() && batch.status === 'COMMITTED';
      return batch.status !== 'DELETED';
    }
    function date(batch) {
      const value = new Date(batch.createdAt);
      return { day: value.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' }), time: value.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kolkata' }).toUpperCase() };
    }
    function filtered() {
      const query = $('#excelHistorySearch').value.trim().toLowerCase();
      return batches.filter(batch => {
        const stamp = date(batch);
        return `${batch.fileName} ${batch.batchId} ${stamp.day} ${stamp.time} ${batch.createdAt} ${batch.status}`.toLowerCase().includes(query);
      }).sort((a, b) => {
        const left = sort === 'createdAt' ? new Date(a.createdAt).getTime() : a[sort];
        const right = sort === 'createdAt' ? new Date(b.createdAt).getTime() : b[sort];
        const comparison = typeof left === 'number' ? left - right : String(left || '').localeCompare(String(right || ''), undefined, { numeric: true });
        return direction * comparison || String(a.batchId).localeCompare(String(b.batchId));
      });
    }
    function paged(rows) {
      const size = Number($('#excelHistoryPageSize').value || 5);
      page = Math.min(page, Math.max(1, Math.ceil(rows.length / size)));
      return rows.slice((page - 1) * size, page * size);
    }
    function actionButton(batch, action) {
      const enabled = eligible(batch, action);
      const reason = action === 'edit' ? 'Only pending or partially uploaded files can be edited' : action === 'reverse' ? 'Administrator access and a fully committed upload are required' : '';
      const title = `${labels[action]}${enabled ? '' : ` — ${reason}`}`;
      return `<button type="button" class="excel-history-icon ${action}" data-history-action="${action}" data-batch-id="${escape(batch.batchId)}" title="${escape(title)}" aria-label="${labels[action]} ${escape(batch.batchId)}" ${!enabled || busy ? 'disabled' : ''}>${svg(action)}</button>`;
    }
    function render() {
      const rows = filtered(), visible = paged(rows), size = Number($('#excelHistoryPageSize').value || 5);
      $('#excelHistoryTotal').textContent = rows.length;
      $('#excelHistoryAccepted').textContent = rows.reduce((sum, batch) => sum + Number(batch.acceptedRows || 0), 0);
      $('#excelHistoryRejected').textContent = rows.reduce((sum, batch) => sum + Number(batch.rejectedRows || 0), 0);
      $('#excelHistoryQty').textContent = rows.reduce((sum, batch) => sum + Number(batch.uploadedQty || 0), 0);
      $('#excelHistoryRows').innerHTML = visible.map(batch => {
        const stamp = date(batch), status = batch.status.toLowerCase().replace(/_/g, '-');
        const text = batch.status === 'PARTIALLY_COMMITTED' ? 'PARTIAL' : batch.status;
        const extension = String(batch.fileName || '').match(/\.[a-z0-9]+$/i)?.[0] || '';
        const stem = extension ? batch.fileName.slice(0, -extension.length) : batch.fileName;
        const split = batch.batchId.lastIndexOf('-') + 1;
        const batchLabel = `<span>${escape(batch.batchId.slice(0, split))}</span><span>${escape(batch.batchId.slice(split))}</span>`;
        const marker = ['PENDING', 'PARTIALLY_COMMITTED'].includes(batch.status) ? '◷' : batch.status === 'REJECTED' ? '×' : '•';
        return `<tr class="${selected.has(batch.batchId) ? 'selected' : ''}"><td><input type="checkbox" data-history-select="${escape(batch.batchId)}" aria-label="Select ${escape(batch.batchId)}" ${selected.has(batch.batchId) ? 'checked' : ''} ${busy ? 'disabled' : ''}></td><td><time datetime="${escape(batch.createdAt)}">${escape(stamp.day)}<small>${escape(stamp.time)}</small></time></td><td class="excel-history-batch" title="${escape(batch.batchId)}">${batchLabel}</td><td><div class="excel-history-file" title="${escape(batch.fileName)}"><span class="excel-file-symbol" aria-hidden="true">X</span><span class="excel-file-copy"><span class="excel-file-name">${escape(stem)}</span><small class="excel-file-extension">${escape(extension)}</small></span></div></td><td class="excel-history-number">${Number(batch.acceptedRows || 0)}</td><td class="excel-history-number">${Number(batch.rejectedRows || 0)}</td><td class="excel-history-number">${Number(batch.uploadedQty || 0)}</td><td><span class="excel-history-status ${status}" title="${escape(batch.status)}"><span class="excel-history-status-mark" aria-hidden="true">${marker}</span>${escape(text)}</span></td><td><div class="excel-history-actions">${['open', 'edit', 'reverse', 'delete'].map(action => actionButton(batch, action)).join('')}</div></td></tr>`;
      }).join('') || '<tr><td colspan="9" class="excel-history-empty">No uploads match this search.</td></tr>';
      Array.from($('#excelHistoryRows').rows).forEach(row => {
        if (row.cells.length !== 9) return;
        Array.from(row.cells).forEach((cell, index) => { cell.dataset.label = ['Select', 'Date & Time', 'Batch ID', 'File Name', 'Accepted', 'Rejected', 'Uploaded Qty', 'Status', 'Actions'][index]; });
      });
      $('#excelHistorySelectedCount').textContent = `Selected (${selected.size})`;
      for (const [selector, set] of [['#excelHistorySelectAll', rows], ['#excelHistorySelectPage', visible]]) {
        const count = set.filter(batch => selected.has(batch.batchId)).length, checkbox = $(selector);
        checkbox.checked = set.length > 0 && count === set.length;
        checkbox.indeterminate = count > 0 && count < set.length;
        checkbox.disabled = busy || !set.length;
      }
      const chosen = batches.filter(batch => selected.has(batch.batchId));
      panel.querySelectorAll('[data-history-bulk]').forEach(button => {
        const action = button.dataset.historyBulk;
        button.disabled = busy || !chosen.length || (['open', 'edit'].includes(action) && chosen.length !== 1) || chosen.some(batch => !eligible(batch, action));
      });
      $('#excelHistoryPageLabel').textContent = `Showing ${rows.length ? (page - 1) * size + 1 : 0}–${Math.min(page * size, rows.length)} of ${rows.length}`;
      $('#excelHistoryPageNumber').textContent = page;
      $('#excelHistoryPrev').disabled = busy || page <= 1;
      $('#excelHistoryNext').disabled = busy || page * size >= rows.length;
      panel.querySelectorAll('[data-history-sort]').forEach(button => {
        const active = button.dataset.historySort === sort;
        button.closest('th').setAttribute('aria-sort', active ? direction === 1 ? 'ascending' : 'descending' : 'none');
        button.querySelector('span').textContent = active ? direction === 1 ? '↑' : '↓' : '↕';
      });
    }
    async function load() {
      const current = options.getDealer();
      if (!current) throw new Error('Select a dealer first.');
      if (current !== dealer) { dealer = current; selected.clear(); batches = []; page = 1; $('#excelHistorySearch').value = ''; render(); }
      const version = ++request;
      const response = await options.api(`/api/excel-stock-upload/batches?dealerCode=${encodeURIComponent(current)}`);
      if (version !== request || current !== options.getDealer()) return;
      batches = response.batches || [];
      const ids = new Set(batches.map(batch => batch.batchId));
      Array.from(selected).forEach(id => { if (!ids.has(id)) selected.delete(id); });
      panel.hidden = false; render();
    }
    async function run(action, ids) {
      if (busy || !ids.length) return;
      const chosen = batches.filter(batch => ids.includes(batch.batchId));
      if (chosen.length !== ids.length || chosen.some(batch => !eligible(batch, action))) return;
      if (['open', 'edit'].includes(action)) {
        if (chosen.length !== 1) return;
        const current = dealer; busy = true; render();
        try {
          const response = await options.api(`/api/excel-stock-upload/batches/${encodeURIComponent(chosen[0].batchId)}`);
          if (current === options.getDealer()) options.onOpen(response.batch, action);
        } finally { busy = false; render(); }
        return;
      }
      const note = action === 'delete' ? 'Uploaded stock will be removed using audited deletion. Files with dependent stock activity cannot be deleted.' : 'This records reversal transactions for the uploaded stock; the units must remain available in their original bins.';
      if (!root.confirm(`${labels[action]} ${chosen.length} selected upload${chosen.length === 1 ? '' : 's'}? ${note}`)) return;
      const current = dealer; busy = true; render();
      const failures = []; let completed = 0;
      try {
        for (const batch of chosen) {
          if (current !== options.getDealer()) { failures.push('Dealer selection changed; remaining actions were stopped.'); break; }
          try {
            await options.api(`/api/excel-stock-upload/batches/${encodeURIComponent(batch.batchId)}${action === 'reverse' ? '/reverse' : ''}`, { method: action === 'reverse' ? 'POST' : 'DELETE', body: { dealerCode: current } });
            completed++; selected.delete(batch.batchId);
            await options.onChanged?.(batch.batchId, action);
          } catch (error) { failures.push(`${batch.batchId}: ${error.message}`); }
        }
        if (current === options.getDealer()) await load();
        options.notify(`${completed} upload${completed === 1 ? '' : 's'} ${action === 'reverse' ? 'reversed' : 'deleted'}.${failures.length ? ` ${failures.join(' ')}` : ''}`, failures.length > 0);
      } finally { busy = false; render(); }
    }
    panel.addEventListener('change', event => {
      if (busy) return;
      if (event.target.matches('[data-history-select]')) {
        if (event.target.checked) selected.add(event.target.dataset.historySelect); else selected.delete(event.target.dataset.historySelect);
      } else if (['excelHistorySelectAll', 'excelHistorySelectPage'].includes(event.target.id)) {
        const rows = event.target.id === 'excelHistorySelectAll' ? filtered() : paged(filtered());
        rows.forEach(batch => { if (event.target.checked) selected.add(batch.batchId); else selected.delete(batch.batchId); });
      } else if (event.target.id === 'excelHistoryPageSize') page = 1;
      else return;
      render();
    });
    $('#excelHistorySearch').addEventListener('input', () => { page = 1; selected.clear(); render(); });
    panel.addEventListener('click', event => {
      const button = event.target.closest('button'); if (!button || button.disabled || busy) return;
      if (button.dataset.historySort) {
        direction = sort === button.dataset.historySort ? -direction : 1; sort = button.dataset.historySort; page = 1; render();
      } else if (button.dataset.historyAction || button.dataset.historyBulk) {
        const action = button.dataset.historyAction || button.dataset.historyBulk;
        const ids = button.dataset.historyAction ? [button.dataset.batchId] : Array.from(selected);
        run(action, ids).catch(error => options.notify(error.message, true));
      } else if (button.id === 'excelHistoryPrev' || button.id === 'excelHistoryNext') {
        page += button.id === 'excelHistoryNext' ? 1 : -1; render();
      }
    });
    render();
    return { load };
  }
  root.ExcelUploadHistory = { create };
})(window);
