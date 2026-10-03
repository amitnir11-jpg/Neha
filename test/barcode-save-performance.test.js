const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

function scannerHarness() {
  const source = fs.readFileSync('public/ui.js', 'utf8');
  const timers = new Map();
  const nodes = new Map();
  const saves = [];
  let clock = 10000;
  let timerId = 0;
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: '', listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback; }
    });
    return nodes.get(selector);
  };
  node('[name="type"]').value = 'INWARD';
  node('[name="binLocation"]').value = 'A1';
  const context = {
    $: node, state: { barcodeAutoSaving: false, barcodeLastRaw: '', barcodeLastAt: 0 },
    normalizePartText: value => String(value).trim().toUpperCase(),
    Date: { now: () => clock },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    currentDealerCode: () => '11646', activeAuditIdForScope: () => 'AUD1',
    lockBarcodeDuplicateNotice: () => false, setLivePill: () => {}, setStatusPill: () => {},
    playScanTone: () => {}, toast: () => {}, fillBarcodePartFromRaw: () => {}, focusNextBarcodeField: () => {},
    submitScan: async (_form, options) => { saves.push(options.expectedRaw); node('#barcodeRaw').value = ''; }
  };
  vm.createContext(context);
  const start = source.indexOf('  function scheduleBarcodeAutosave(');
  const end = source.indexOf('  function labelEndpoint(', start);
  vm.runInContext(source.slice(start, end), context);
  const handlersStart = source.indexOf("    $('#barcodeScanForm').addEventListener('submit'");
  const handlersEnd = source.indexOf("    $$('#manualScanForm", handlersStart);
  vm.runInContext(source.slice(handlersStart, handlersEnd), context);
  return {
    context, saves, node,
    async advance(ms) {
      clock += ms;
      for (const [id, timer] of Array.from(timers)) {
        if (timer.at > clock || !timers.has(id)) continue;
        timers.delete(id);
        await timer.callback();
      }
    },
    input(value) { node('#barcodeRaw').value = value; node('#barcodeRaw').listeners.input(); }
  };
}

test('scanner without an Enter suffix saves once after the input settles', async () => {
  const h = scannerHarness();
  h.input('35010');
  await h.advance(100);
  h.input('35010ACK00099S');
  await h.advance(199);
  assert.equal(h.saves.length, 0, 'must not submit partial scanner input');
  await h.advance(1);
  assert.deepEqual(h.saves, ['35010ACK00099S']);
  assert.equal(h.context.state.barcodeAutoSaving, false);
});

for (const key of ['Enter', 'Tab']) {
  test(`${key} scanner suffix replaces the idle timer with an immediate save`, async () => {
    const h = scannerHarness();
    h.input('35010ACK00099S');
    let prevented = false;
    h.node('#barcodeRaw').listeners.keydown({ key, shiftKey: false, preventDefault() { prevented = true; } });
    await h.advance(20);
    assert.equal(prevented, true);
    assert.deepEqual(h.saves, ['35010ACK00099S']);
    await h.advance(200);
    assert.equal(h.saves.length, 1);
  });
}

test('Save Web Scan uses the same autosave guard as scanner events', async () => {
  const h = scannerHarness();
  h.input('35010ACK00099S');
  h.node('#barcodeScanForm').listeners.submit({ preventDefault() {} });
  await h.advance(0);
  await h.advance(200);
  assert.deepEqual(h.saves, ['35010ACK00099S']);
});

test('audit users do not poll the admin-only devices endpoint', async () => {
  const source = fs.readFileSync('public/ui.js', 'utf8');
  const start = source.indexOf('  function queueDeviceRefresh(');
  const end = source.indexOf('  function refreshScanViewsSoon(', start);
  let scheduled = 0;
  let loads = 0;
  let admin = false;
  let callback;
  const context = { state: {}, document: { hidden: false }, isAdmin: () => admin,
    clearTimeout: () => {}, setTimeout: fn => { scheduled++; callback = fn; },
    loadDevices: async () => { loads++; }, console };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  context.queueDeviceRefresh();
  assert.equal(scheduled, 0);
  admin = true;
  context.queueDeviceRefresh();
  await callback();
  assert.equal(loads, 1);
  context.document.hidden = true;
  await callback();
  assert.equal(loads, 1);
});

test('database readiness rejects a missing bin projection even when inventory exists', async () => {
  const source = fs.readFileSync('server.js', 'utf8');
  const start = source.indexOf('async function verifyApplicationSchema(');
  const end = source.indexOf('async function runPrismaMigrations(', start);
  let rows = [{ table_name: 'users' }, { table_name: 'inventories' }];
  const context = { prisma: { $queryRaw: async () => rows },
    licenseService: { isRequired: () => false }, applicationInitializationState: { schemaVerified: false } };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  await assert.rejects(context.verifyApplicationSchema(), /part_bin_locations/);
  assert.equal(context.applicationInitializationState.schemaVerified, false);
  rows.push({ table_name: 'part_bin_locations' });
  await context.verifyApplicationSchema();
  assert.equal(context.applicationInitializationState.schemaVerified, true);
});

test('repair migration creates the bin table and preserves rows when replayed',
  { skip: !process.env.DATABASE_URL }, async () => {
    const { PrismaClient } = require('@prisma/client');
    const db = new PrismaClient();
    const schema = `barcode_migration_test_${process.pid}_${Date.now()}`;
    const rollback = new Error('Rollback migration test');
    const sql = fs.readFileSync('prisma/migrations/20261004100000_restore_part_bin_locations/migration.sql', 'utf8')
      .replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
    const statements = sql.split(';').map(value => value.trim()).filter(Boolean);
    try {
      await assert.rejects(db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}", public`);
        for (const statement of statements) await tx.$executeRawUnsafe(statement);
        await tx.$executeRawUnsafe(`INSERT INTO part_bin_locations
          (id, "dealerCode", "auditId", "partNumber", "normalizedPartNumber", "binLocation", quantity)
          VALUES ('fixture', 'TEST', 'AUD1', 'PART1', 'PART1', 'A1', 9)`);
        for (const statement of statements) await tx.$executeRawUnsafe(statement);
        const rows = await tx.$queryRawUnsafe('SELECT quantity FROM part_bin_locations');
        assert.deepEqual(rows, [{ quantity: 9 }]);
        const indexes = await tx.$queryRawUnsafe(`SELECT indexname FROM pg_indexes WHERE schemaname = '${schema}'`);
        assert.ok(indexes.some(row => row.indexname === 'part_bin_locations_unique_part_bin'));
        throw rollback;
      }, { timeout: 60000 }), error => error === rollback);
    } finally {
      await db.$disconnect();
    }
  });
