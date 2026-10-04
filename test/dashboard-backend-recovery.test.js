const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

function startupHarness(source = fs.readFileSync('server.js', 'utf8')) {
  let connected = false;
  let taskAttempts = 0;
  let connectAttempts = 0;
  const timers = new Map();
  const failures = [];
  const context = {
    databaseInitTimer: null, databaseStartupPromise: null,
    databaseStartupState: { attempts: 0 }, applicationInitializationState: {},
    isDatabaseReady: () => connected,
    applicationReady: () => connected && context.applicationInitializationState.status === 'ready',
    runPrismaMigrations: async () => {},
    connectDatabase: async () => { connected = true; connectAttempts++; },
    verifyApplicationSchema: async () => { context.applicationInitializationState.schemaVerified = true; },
    runPostgresStartupTasks: async () => {
      taskAttempts++;
      if (taskAttempts === 1) {
        throw Object.assign(new Error('Invalid prisma.$queryRaw() invocation: Server has closed the connection.'), { code: 'P2010' });
      }
    },
    markDatabaseUnavailable: error => { connected = false; failures.push(error); },
    DATABASE_INIT_RETRY_MS: 15000,
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.set(timer, timer); return timer;
    },
    clearTimeout: timer => timers.delete(timer),
    console: { log() {}, error() {} }, Date
  };
  vm.createContext(context);
  const start = source.indexOf('function scheduleDatabaseInitialization(delayMs = 0)');
  const end = source.indexOf('\nasync function start()', start);
  vm.runInContext(source.slice(start, end), context);
  return { context, timers, failures, connectAttempts: () => connectAttempts };
}

test('connection loss after successful schema verification schedules full initialization recovery', async () => {
  const { context, timers, failures, connectAttempts } = startupHarness();
  assert.equal(await context.initializeDatabaseInBackground(), false);
  assert.equal(context.applicationInitializationState.schemaVerified, true);
  assert.equal(context.applicationInitializationState.status, 'failed');
  assert.equal(context.isDatabaseReady(), false);
  assert.equal(context.applicationReady(), false);
  assert.equal(failures.length, 1);
  assert.equal(timers.size, 1, 'startup must retry even though its initial connection succeeded');
  const timer = [...timers.values()][0];
  assert.equal(timer.delay, 15000);
  timers.delete(timer);
  timer.callback();
  await new Promise(setImmediate);
  assert.equal(connectAttempts(), 2);
  assert.equal(context.databaseStartupState.attempts, 2);
  assert.equal(context.applicationReady(), true);
  assert.equal(context.applicationInitializationState.lastError, '');
  assert.equal(context.databaseStartupState.lastError, '');
  assert.equal(timers.size, 0);
});

test('connected database alone does not suppress initialization when application is unready', async () => {
  const { context, timers } = startupHarness();
  await context.connectDatabase();
  context.applicationInitializationState.status = 'failed';
  context.scheduleDatabaseInitialization(15000);
  assert.equal(timers.size, 1);
  assert.equal(await context.initializeDatabaseInBackground(), false);
  assert.equal(await context.initializeDatabaseInBackground(), true);
  assert.equal(context.applicationReady(), true);
});

module.exports = { startupHarness };
