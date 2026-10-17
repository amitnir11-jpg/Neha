const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

test('valid mobile credentials register a pending phone without device approval', async () => {
  const source = fs.readFileSync('routes/mobile.js', 'utf8');
  const start = source.indexOf("router.post('/device-register'");
  const end = source.indexOf('async function processMobileScan', start);
  let register;
  let existing = { deviceId: 'phone-1', approved: false, status: 'pending', dealerCode: 'OLD' };
  let saved;
  const context = {
    router: { post: (_path, _auth, handler) => { register = handler; } },
    auth: { requireAuth: () => {}, normalizeAccessCode: (value) => String(value || '').trim().toUpperCase() },
    clean: (value) => String(value || '').trim(),
    dealerAccessForUser: async () => ({ allowed: true, requestedDealer: '24644' }),
    Dealer: { findOne: () => ({ lean: async () => ({ dealerName: 'POONIA MOTORS' }) }) },
    getActiveAudit: async () => null,
    Device: {
      findOne: () => ({ lean: async () => existing }),
      findOneAndUpdate: (_filter, update) => {
        saved = update;
        return { lean: async () => update };
      }
    },
    MOBILE_APP_VERSION: 'test',
    serverInfo: () => ({ serverUrl: 'https://example.test' })
  };
  vm.runInNewContext(source.slice(start, end), context);
  const req = {
    body: { deviceId: 'phone-1', dealerCode: '24644', serverUrl: 'https://example.test', userId: 'spoofed' },
    user: { id: 'user-1', username: 'test', name: 'TEST', role: 'mobile_user' },
    app: { get: () => ({ emit() {} }), locals: {} }
  };
  async function run() {
    let status = 200;
    let payload;
    await register(req, { status(code) { status = code; return this; }, json(value) { payload = value; return this; } });
    return { status, payload };
  }

  const accepted = await run();
  assert.equal(accepted.status, 200);
  assert.equal(accepted.payload.success, true);
  assert.equal(saved.approved, true);
  assert.equal(saved.dealerCode, '24644');
  assert.equal(saved.userId, 'user-1');

  existing = { deviceId: 'phone-1', scannerStatus: 'blocked' };
  saved = null;
  const blocked = await run();
  assert.equal(blocked.status, 403);
  assert.match(blocked.payload.message, /blocked/i);
  assert.equal(saved, null);
});
