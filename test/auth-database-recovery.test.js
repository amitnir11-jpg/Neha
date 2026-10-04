const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');
const express = require('express');
const { isDatabaseConnectionError } = require('../utils/databaseErrors');

test('connection failure classification preserves unrelated authentication errors', () => {
  for (const error of [{ code: 'P1001' }, { errorCode: 'P1002' }, { code: 'P1017' },
    { code: 'P2010', message: "Invalid prisma.$queryRaw() invocation: Can't reach database server at postgres.railway.internal:5432" }]) {
    assert.equal(isDatabaseConnectionError(error), true);
  }
  for (const error of [null, { code: 'P2002' }, { message: 'Invalid password' }]) {
    assert.equal(isDatabaseConnectionError(error), false);
  }
});

test('database readiness becomes false after an outage and recovers after reconnecting', async () => {
  let failure;
  const context = {
    module: { exports: {} }, process: { env: { DATABASE_URL: 'postgresql://test:test@localhost/test' } },
    Date, setTimeout,
    require: (name) => name === '@prisma/client' ? {
      Prisma: {}, PrismaClient: class {
        async $connect() {}
        async $queryRaw() { if (failure) throw failure; }
      }
    } : name === '../utils/postgresEnv' ? {
      applyResolvedDatabaseUrl: () => ({ url: context.process.env.DATABASE_URL, source: 'DATABASE_URL' }),
      acceptedDatabaseEnvVars: () => ['DATABASE_URL'], maskDatabaseUrl: () => ''
    } : require(name)
  };
  vm.runInNewContext(fs.readFileSync('services/prisma.js', 'utf8'), context);
  const service = context.module.exports;
  await service.connectDatabase();
  assert.equal(service.isDatabaseReady(), true);
  failure = Object.assign(new Error('Database unreachable'), { code: 'P1001' });
  service.markDatabaseUnavailable(failure);
  assert.equal(service.isDatabaseReady(), false);
  await assert.rejects(service.connectDatabase(), /Database unreachable/);
  failure = null;
  await service.connectDatabase();
  assert.equal(service.isDatabaseReady(), true);
  assert.equal(service.databaseHealthDetails().databaseLastError, '');
});

function authRouter(findUser) {
  const localRequire = createRequire(require.resolve('../routes/auth'));
  const context = {
    module: { exports: {} }, process, console, URL,
    require: (name) => {
      if (name === '../models/User') return { findOne: findUser };
      if (name.startsWith('../models/') || name === '../services/PasswordResetService' || name === '../utils/audit') return {};
      return localRequire(name);
    }
  };
  vm.runInNewContext(fs.readFileSync('routes/auth.js', 'utf8'), context);
  return context.module.exports;
}

async function loginHarness(t, findUser, initiallyReady = true) {
  const app = express();
  app.use(express.json());
  let ready = initiallyReady;
  const failures = [];
  const retries = [];
  const context = {
    app, applicationReady: () => ready,
    databaseUnavailableMessage: () => 'Database temporarily unavailable',
    DEPLOYMENT_NAME: 'Railway', IS_RENDER: false, IS_RAILWAY: true,
    ...require('../utils/databaseErrors'),
    markDatabaseUnavailable: (error) => { ready = false; failures.push(error); },
    applicationInitializationState: {}, databaseStartupState: {},
    console: { error() {} }, DATABASE_INIT_RETRY_MS: 15000,
    scheduleDatabaseInitialization: (delay) => retries.push(delay)
  };
  const source = fs.readFileSync('server.js', 'utf8');
  const gateStart = source.indexOf("app.use('/api/auth', (req, res, next) => {");
  const gateEnd = source.indexOf("app.use('/api/auth', authRoutes);", gateStart);
  vm.runInNewContext(source.slice(gateStart, gateEnd), context);
  app.use('/api/auth', authRouter(findUser));
  const handlerStart = source.indexOf("app.use('/api/auth', (error, req, res, next) => {");
  const handlerEnd = source.indexOf("\napp.use('/api',", handlerStart);
  vm.runInNewContext(source.slice(handlerStart, handlerEnd), context);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return {
    failures, retries,
    request: (path, body) => fetch(`http://127.0.0.1:${server.address().port}/api/auth/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
  };
}

for (const path of ['login', 'mobile-login', 'pin-login']) {
  test(`${path} handles a lost database connection and schedules recovery`, async t => {
    const error = Object.assign(new Error("Can't reach database server at postgres.railway.internal:5432"), { code: 'P1001' });
    const harness = await loginHarness(t, async () => { throw error; });
    const body = { username: 'admin', password: 'test', pin: '1234', dealerCode: 'TEST' };
    const response = await harness.request(path, body);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '15');
    const data = await response.json();
    assert.equal(data.success, false);
    assert.match(data.message, /temporarily unavailable/);
    assert.doesNotMatch(JSON.stringify(data), /prisma|railway\.internal/i);
    assert.equal(harness.failures[0], error);
    assert.deepEqual(harness.retries, [15000]);
    const second = await harness.request(path, body);
    assert.equal(second.status, 503);
    assert.equal(harness.failures.length, 1);
  });
}

test('authentication waits for application initialization even when HTTP is online', async t => {
  const harness = await loginHarness(t, () => assert.fail('Queried users before readiness'), false);
  const response = await harness.request('login', { username: 'admin', password: 'test' });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '15');
});

test('invalid login credentials still return 401 without reconnecting', async t => {
  const harness = await loginHarness(t, async () => null);
  const response = await harness.request('login', { username: '', password: 'wrong' });
  assert.equal(response.status, 401);
  assert.deepEqual(harness.retries, []);
});

test('failed initialization after connecting retries and eventually enables login', async () => {
  let connected = false;
  let schemaAttempts = 0;
  const retries = [];
  const context = {
    databaseStartupPromise: null,
    databaseStartupState: { attempts: 0 }, applicationInitializationState: {},
    applicationReady: () => connected && context.applicationInitializationState.status === 'ready',
    runPrismaMigrations: async () => {}, connectDatabase: async () => { connected = true; },
    verifyApplicationSchema: async () => {
      schemaAttempts += 1;
      if (schemaAttempts === 1) throw new Error('Schema not ready');
      context.applicationInitializationState.schemaVerified = true;
    },
    runPostgresStartupTasks: async () => {}, markDatabaseUnavailable: () => { connected = false; },
    scheduleDatabaseInitialization: delay => retries.push(delay), DATABASE_INIT_RETRY_MS: 15000,
    console: { log() {}, error() {} }, Date
  };
  const source = fs.readFileSync('server.js', 'utf8');
  const start = source.indexOf('async function initializeDatabaseInBackground() {');
  const end = source.indexOf('\nasync function start()', start);
  vm.runInNewContext(source.slice(start, end), context);
  assert.equal(await context.initializeDatabaseInBackground(), false);
  assert.equal(context.applicationReady(), false);
  assert.deepEqual(retries, [15000]);
  assert.equal(await context.initializeDatabaseInBackground(), true);
  assert.equal(context.applicationReady(), true);
  assert.equal(schemaAttempts, 2);
});
