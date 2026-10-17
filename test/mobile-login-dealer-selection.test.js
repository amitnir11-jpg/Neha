const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const auth = require('../routes/auth');
const User = require('../models/User');
const Dealer = require('../models/Dealer');
const Mapping = require('../models/UserDealerMapping');
const Audit = require('../models/Audit');

test('mobile login resolves one dealer, requires a choice for two, and rejects other dealers', async (t) => {
  const originals = [];
  const replace = (model, method, implementation) => {
    originals.push([model, method, model[method]]);
    model[method] = implementation;
  };
  t.after(() => originals.forEach(([model, method, original]) => { model[method] = original; }));
  const query = (value) => ({ lean: async () => value, select() { return this; }, sort() { return this; } });
  const user = { _id: 'user-1', username: 'mobile_user', role: 'mobile_user', approved: true,
    isActive: true, passwordHash: bcrypt.hashSync('secret', 4), dealerAccess: ['11646'], async save() {} };
  let assigned = [{ dealerCode: '11646', dealerName: 'SURYA', active: true }];
  replace(User, 'findOne', async () => user);
  replace(Mapping, 'find', () => query(assigned.map((dealer) => ({ dealerId: dealer.dealerCode }))));
  replace(Dealer, 'find', () => query(assigned));
  replace(Dealer, 'findOne', (filter) => query(assigned.find((dealer) => dealer.dealerCode === filter.dealerCode) || null));
  replace(Audit, 'findOne', (filter) => query(filter.dealerCode === '11646'
    ? { dealerCode: '11646', auditId: 'AUD-11646', status: 'ACTIVE' } : null));

  async function login(body) {
    let status = 200;
    let payload;
    const response = { status(code) { status = code; return this; }, json(data) { payload = data; return this; } };
    await auth.mobileLoginHandler({ body }, response, (error) => { throw error; });
    return { status, payload };
  }

  const single = await login({ username: 'mobile_user', password: 'secret' });
  assert.equal(single.status, 200, JSON.stringify(single.payload));
  assert.equal(single.payload.dealerCode, '11646');
  assert.equal(single.payload.auditId, 'AUD-11646');
  assert.ok(single.payload.token);

  assigned = [...assigned, { dealerCode: '12320', dealerName: 'NAVEEN MOTORS', active: true }];
  const multiple = await login({ username: 'mobile_user', password: 'secret' });
  assert.equal(multiple.payload.needsDealerSelection, true);
  assert.equal(multiple.payload.assignedDealers.length, 2);
  assert.equal(multiple.payload.token, undefined);

  const wrong = await login({ username: 'mobile_user', password: 'secret', dealerCode: 'OTHER' });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.payload.success, false);

  const noAudit = await login({ username: 'mobile_user', password: 'secret', dealerCode: '12320' });
  assert.equal(noAudit.status, 409);
  assert.match(noAudit.payload.message, /active audit/i);
});
