// This script refuses every remote/production database. It starts a temporary
// API server, tests it, and saves the isolated fixture session for UI review.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const url = new URL(process.env.SMART_SEARCH_DATABASE_URL || 'http://missing');
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  && url.pathname === '/scan_acceptance', 'Use only the isolated local scan_acceptance database');
process.env.DATABASE_URL = url.href;
const { prisma } = require('../services/prisma');
const models = require('../models/registry');
const auth = require('../routes/auth');
const { partSuggestions, candidateQuery } = require('../services/PartSuggestionService');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const artifactDir = path.resolve('.codex-artifacts/smart-part-search');
fs.mkdirSync(artifactDir, { recursive: true });
const suffix = randomUUID().slice(0, 8).toUpperCase();
const dealers = [`SMART${suffix}A`, `SMART${suffix}B`];
const stem = `20K${suffix}`;
const secret = randomUUID();
const port = Number(process.env.SMART_SEARCH_PORT || 55441);
const origin = `http://127.0.0.1:${port}`;
const checks = [];
let server;
const passed = name => { checks.push(name); console.log(`PASS ${name}`); };
async function api(route, token) {
  const response = await fetch(`${origin}${route}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(15000) });
  return { status: response.status, body: await response.json() };
}

async function main() {
  const inventoryBefore = await models.Inventory.countDocuments({});
  const localBefore = await prisma.localPartEntry.count();
  for (const dealerCode of dealers) {
    await models.Dealer.create({ dealerCode, dealerName: `Smart Search ${dealerCode.slice(-1)}`, active: true, currentAuditId: `AUD-${dealerCode}` });
    await models.Audit.create({ dealerCode, auditId: `AUD-${dealerCode}`, status: 'ACTIVE', auditStatus: 'ACTIVE' });
    await models.Bin.create({ dealerCode, binCode: '1', active: true });
    await models.MasterPart.create({ dealerCode, partNumber: stem, partDescription: `Dealer ${dealerCode.slice(-1)} exact master`, mrp: dealerCode.endsWith('A') ? 770 : 990, dlc: 600 });
  }
  for (let index = 0; index < 15; index++) {
    await models.MasterPart.create({ dealerCode: dealers[0], partNumber: `${stem}${String(index).padStart(2, '0')}`, partDescription: `Test prefix ${index}`, mrp: 100 + index, dlc: 80 });
  }
  const partialNumber = `X${stem}PARTIAL`;
  const sharedNumber = `${stem}GLOBAL`;
  await models.MasterPart.create({ dealerCode: dealers[0], partNumber: partialNumber, partDescription: 'Partial fixture', mrp: 200, dlc: 150 });
  await models.MasterPart.create({ dealerCode: dealers[1], partNumber: `${stem}BONLY`, partDescription: 'Private B fixture', mrp: 400, dlc: 300 });
  await models.MasterCatalogue.create({ partNumber: sharedNumber, partDescription: 'Shared global catalogue fixture', mrp: 500, dlc: 400 });
  const users = [];
  for (const [index, role] of ['audit_user', 'mobile_user', 'audit_user', 'admin', 'audit_user'].entries()) {
    const dealerCode = dealers[index === 2 ? 1 : 0];
    const user = await models.User.create({ username: `smart-${suffix.toLowerCase()}-${role}-${index}`, name: `Smart Search ${role}`, role,
      dealerAccess: index === 4 ? dealers : [dealerCode], passwordHash: await bcrypt.hash('SmartSearch-Local-Only-2026', 10), active: true, approved: true,
      permissions: auth.normalizePermissions() });
    users.push({ user: auth.publicUser(user), token: jwt.sign(auth.publicUser(user), secret, { expiresIn: '24h' }), dealerCode });
  }
  const log = fs.openSync(path.join(artifactDir, 'server.log'), 'w');
  server = spawn(process.execPath, ['server.js'], { cwd: path.resolve('.'), windowsHide: true,
    env: { ...process.env, PORT: String(port), HOST: '0.0.0.0', JWT_SECRET: secret, NODE_ENV: 'test',
      DAKSH_LICENSE_REQUIRED: 'false', MDNS_ENABLED: 'false', MOBILE_DISCOVERY_ENABLED: 'false', DAKSH_DATA_ROOT: path.join(artifactDir, 'runtime') },
    stdio: ['ignore', log, log] });
  server.unref();
  for (let attempt = 0; ; attempt++) {
    try { if ((await api('/api/ready')).status === 200) break; } catch {}
    assert.ok(attempt < 90 && server.exitCode === null, 'Local server did not become ready. Inspect server.log');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const search = (query, who = users[0], limit = 10) => api(`/api/parts/suggestions?${new URLSearchParams({ q: query, dealerCode: who.dealerCode, limit })}`, who.token);
  assert.equal((await api('/api/parts/suggestions?q=20K')).status, 401);
  assert.equal((await api(`/api/parts/suggestions?q=${stem}&dealerCode=${dealers[1]}`, users[0].token)).status, 403);
  assert.equal((await api(`/api/parts/suggestions?q=${stem}`, users[4].token)).status, 400);
  assert.equal((await api(`/api/master/suggestions?q=${stem}`, users[4].token)).status, 400);
  passed('authentication and unauthorized dealer rejection');
  const web = (await search(stem.toLowerCase())).body.suggestions;
  const mobile = (await search(stem, users[1])).body.suggestions;
  assert.deepEqual(web, mobile);
  assert.equal(web[0].partNumber, stem);
  assert.equal(web[0].mrp, 770);
  assert.equal(web.length, 10);
  assert.equal((await search(stem, users[0], 1000)).body.suggestions.length, 10);
  assert.ok(!web.some(part => part.partNumber.endsWith('BONLY')));
  assert.equal((await search(stem, users[2])).body.suggestions[0].mrp, 990);
  passed('web/mobile/native API contract, exact-first ranking, case folding, ten-result cap and dealer price isolation');
  const partial = await partSuggestions({ q: `${suffix}PARTIAL` }, dealers[0]);
  assert.equal(partial[0].partNumber, partialNumber);
  assert.equal((await search('Partial fixture')).body.suggestions[0].partNumber, partialNumber);
  assert.equal((await search(sharedNumber)).body.suggestions[0].partNumber, sharedNumber);
  assert.equal((await search('%_\\')).body.suggestions.length, 0);
  assert.deepEqual((await search(' ')).body.suggestions, []);
  passed('substring/description search, shared catalogue, literal wildcard escaping and empty search');
  for (const alias of ['/api/master/parts/suggest', '/api/master/suggestions', '/api/mobile/master-search']) {
    const result = await api(`${alias}?q=${stem}&dealerCode=${dealers[0]}&limit=10`, users[0].token);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.suggestions.map(part => part.partNumber), web.map(part => part.partNumber));
    assert.equal(result.body.parts[0].mrp, 770);
  }
  passed('old web and installed APK routes delegate to the same engine');
  const start = performance.now();
  const simultaneous = await Promise.all(Array.from({ length: 24 }, (_, i) => search(stem, users[i % 3])));
  assert.ok(simultaneous.every(result => result.status === 200));
  simultaneous.forEach((result, index) => assert.equal(result.body.suggestions[0].mrp, index % 3 === 2 ? 990 : 770));
  passed(`24 concurrent requests across users/dealers preserve isolation (${Math.round(performance.now() - start)} ms total)`);
  const plans = {};
  // Tiny fixture tables normally prefer a sequential scan; disabling it here
  // verifies the exact expressions can use the deployed index definitions.
  await prisma.$transaction(async client => {
    await client.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
    const { Prisma } = require('@prisma/client');
    for (const stage of ['prefix', 'partial']) {
      const plan = await client.$queryRaw(Prisma.sql`EXPLAIN (FORMAT JSON) ${candidateQuery('MASTER_PART', stage, stem, dealers[0], 10)}`);
      const serialized = JSON.stringify(plan);
      assert.match(serialized, /smart_part_(?:prefix|trgm)_idx/);
      plans[stage] = JSON.parse(serialized);
    }
  });
  fs.writeFileSync(path.join(artifactDir, 'query-plans.json'), JSON.stringify(plans, null, 2));
  passed('PostgreSQL prefix and trigram indexes are usable');
  assert.equal(await models.Inventory.countDocuments({}), inventoryBefore);
  assert.equal(await prisma.localPartEntry.count(), localBefore);
  passed('all search checks leave inventory and authorized Local Part records unchanged');
  fs.writeFileSync(path.join(artifactDir, 'session.json'), JSON.stringify({ origin, port, pid: server.pid, secret, stem, dealers, users }, null, 2));
  fs.writeFileSync(path.join(artifactDir, 'api-results.json'), JSON.stringify({ checks, sample: web, inventoryBefore, localBefore }, null, 2));
  console.log(`Testing server ready at ${origin}; fixture login ${users[0].user.username} / SmartSearch-Local-Only-2026`);
  server.kill();
}

main().catch(error => { console.error(error); server?.kill(); process.exitCode = 1; }).finally(() => prisma.$disconnect());
