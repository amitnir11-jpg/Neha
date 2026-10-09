const assert = require('node:assert/strict');
const fs = require('node:fs');
const session = JSON.parse(fs.readFileSync('.codex-artifacts/smart-part-search/session.json', 'utf8'));
assert.equal(session.origin, 'http://127.0.0.1:55441', 'Only the isolated testing server is allowed');
process.env.DATABASE_URL = 'postgresql://scan_test@127.0.0.1:55438/scan_acceptance';
const { prisma } = require('../services/prisma');
const User = require('../models/User');
const jwt = require('jsonwebtoken');
const auth = require('../routes/auth');
async function main() {
  const username = `smart-multi-${session.stem.toLowerCase()}`;
  const user = await User.findOne({ username }).lean() || await User.create({ username, role: 'audit_user', approved: true, active: true, dealerAccess: session.dealers });
  const token = jwt.sign(auth.publicUser(user), session.secret, { expiresIn: '1h' });
  for (const [route, code] of [
    ['/api/parts/suggestions', 400], ['/api/master/suggestions', 400],
    ['/api/parts/suggestions?dealerCode=ALL', 403], ['/api/parts/suggestions?dealerCode=OTHER', 403]
  ]) {
    const response = await fetch(`${session.origin}${route}${route.includes('?') ? '&' : '?'}q=${session.stem}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, code, route);
  }
  for (const [index, dealerCode] of session.dealers.entries()) {
    const response = await fetch(`${session.origin}/api/parts/suggestions?${new URLSearchParams({ q: session.stem, dealerCode })}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).suggestions[0].mrp, index ? 990 : 770);
  }
  fs.writeFileSync('.codex-artifacts/smart-part-search/scope-results.json', JSON.stringify({ checks: ['multi-dealer accounts must select a dealer, including legacy aliases', 'ALL and unauthorized dealers remain blocked', 'one user switching dealers receives the correct isolated master prices'] }, null, 2));
  console.log('PASS multi-dealer scope, legacy aliases, unauthorized dealers and isolated prices');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
