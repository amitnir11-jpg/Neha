const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const User = require('../models/User');
const { runDealerCleanup } = require('../services/PermanentDealerCleanupService');

function harness(confirm) {
  const source = fs.readFileSync('public/ui.js', 'utf8');
  const start = source.indexOf('  async function executePermanentCleanup(');
  const end = source.indexOf('  function selectedAdminDeleteIds()', start);
  const select = { value: 'dealer-primary-id', disabled: false };
  const buttons = { '#permanentCleanupDealer': select,
    '#permanentDeleteDataBtn': { textContent: 'Delete All Dealer Data' },
    '#permanentDeleteDealerBtn': { textContent: 'Permanently Delete Dealer & All Data' } };
  const requests = [];
  const prompts = [];
  const context = {
    permanentCleanupInProgress: false, permanentCleanupPreviewData: null,
    $: id => { assert.ok(buttons[id], `Unexpected extra form field ${id}`); return buttons[id]; },
    window: { confirm: message => { prompts.push(message); return confirm(select); } },
    previewPermanentCleanup: async () => {
      context.permanentCleanupPreviewData = { dealer: { id: select.value, dealerCode: '24064', dealerName: 'SHIVYA' }, previewToken: 'signed-preview' };
    },
    api: async (path, options) => {
      requests.push({ path, ...options });
      return { jobId: 'test-job', deletedCounts: {}, dealerDeleted: options.body.operation === 'DELETE_DEALER' };
    },
    setText() {}, loadPermanentCleanupDealers: async () => {}, loadDealers: async () => {}, refreshAfterDelete: async () => {}
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return { context, requests, prompts, select };
}

test('permanent dealer deletion asks once and sends only explicit confirmation', async () => {
  const { context, requests, prompts } = harness(() => true);
  await context.executePermanentCleanup('DELETE_DEALER');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /24064.*SHIVYA.*all their data/);
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].body)), {
    dealerId: 'dealer-primary-id', previewToken: 'signed-preview', operation: 'DELETE_DEALER', confirmed: true
  });
});

test('cancelling the single confirmation sends no deletion', async () => {
  const { context, requests, prompts, select } = harness(() => false);
  await context.executePermanentCleanup('DELETE_DATA');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /account will remain/);
  assert.equal(requests.length, 0);
  assert.equal(select.disabled, false);
});

test('switching the selected dealer during confirmation cannot delete the old target', async () => {
  const { context, requests } = harness(select => { select.value = 'another-dealer'; return true; });
  await assert.rejects(context.executePermanentCleanup('DELETE_DEALER'), /Dealer changed/);
  assert.equal(requests.length, 0);
});

test('double clicking permanent deletion sends one request and one confirmation', async () => {
  const { context, requests, prompts } = harness(() => true);
  await Promise.all([context.executePermanentCleanup('DELETE_DATA'), context.executePermanentCleanup('DELETE_DATA')]);
  assert.equal(prompts.length, 1);
  assert.equal(requests.length, 1);
});

test('backend rejects unconfirmed deletion and rechecks current Super Admin access', async () => {
  const original = User.findOne;
  const input = { dealerId: 'dealer-primary-id', operation: 'DELETE_DEALER', actor: { id: 'user-id', role: 'super_admin' } };
  try {
    User.findOne = () => assert.fail('Unconfirmed cleanup accessed the database');
    for (const confirmed of [undefined, false, 'true']) {
      await assert.rejects(runDealerCleanup({ ...input, confirmed }), error => error.code === 'CLEANUP_CONFIRMATION_REQUIRED');
    }
    await assert.rejects(runDealerCleanup({ ...input, confirmed: true, actor: { id: 'user-id', role: 'admin' } }), error => error.code === 'SUPER_ADMIN_REQUIRED');
    User.findOne = () => ({ lean: async () => ({ role: 'admin', active: true }) });
    await assert.rejects(runDealerCleanup({ ...input, confirmed: true }), error => error.code === 'SUPER_ADMIN_REQUIRED');
  } finally {
    User.findOne = original;
  }
});
