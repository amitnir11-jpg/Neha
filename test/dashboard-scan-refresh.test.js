const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function extractFunction(source, name, nextName) {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf(`  function ${nextName}(`, start);
  assert.notEqual(start, -1, `${name} should exist`);
  assert.notEqual(end, -1, `${nextName} should follow ${name}`);
  return source.slice(start, end);
}

test('scan socket events update only the bounded recent-scan list', () => {
  const source = fs.readFileSync('public/js/app.js', 'utf8');
  const state = { recentScans: [] };
  const inserted = [];
  const rows = [];
  const dealerFilter = { value: 'D1' };
  const auditFilter = { value: 'A1' };
  const body = {
    get children() { return rows; },
    get firstElementChild() { return rows[0] || null; },
    get lastElementChild() { return rows[rows.length - 1] || null; },
    querySelector() { return null; },
    insertAdjacentHTML(_position, html) {
      inserted.push(html);
      rows.unshift({ querySelectorAll: () => [] });
    },
    removeChild(row) {
      const index = rows.indexOf(row);
      if (index >= 0) rows.splice(index, 1);
    }
  };
  const countLabel = { textContent: '' };
  const context = {
    state,
    document: {},
    clean: (value) => String(value ?? '').trim(),
    recentScanRow: (scan) => `<tr>${scan._id}</tr>`,
    bindRecentScanDeleteButtons() {},
    $: (selector) => ({
      '#recentScanBody': body,
      '#scanCountLabel': countLabel,
      '#dashboardDealerFilter': dealerFilter,
      '#dashboardAuditFilter': auditFilter
    })[selector],
    $$: () => []
  };
  vm.createContext(context);
  vm.runInContext(
    extractFunction(source, 'prependRecentScan', 'deleteScanById'),
    context
  );

  for (let index = 0; index < 50; index += 1) {
    context.prependRecentScan({
      _id: `scan-${index}`,
      dealerCode: 'D1',
      auditId: 'A1'
    });
  }
  context.prependRecentScan({ _id: 'scan-49', dealerCode: 'D1', auditId: 'A1' });
  context.prependRecentScan({ _id: 'other-dealer', dealerCode: 'D2', auditId: 'A1' });

  assert.equal(inserted.length, 50);
  assert.equal(state.recentScans.length, 50);
  assert.equal(rows.length, 50);
  assert.equal(countLabel.textContent, '50 records');
  assert.match(source, /socket\.on\('scan:new', \(scan = \{\}\) => prependRecentScan\(scan\)\)/);
  assert.match(source, /socket\.on\('scan:saved', \(scan = \{\}\) => prependRecentScan\(scan\)\)/);
});
