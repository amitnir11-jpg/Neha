const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { getConnectionConfig } = require('../services/ConnectionConfig');
const ServerIdentityService = require('../services/ServerIdentityService');
const LoggerService = require('../services/LoggerService');
const MdnsDiscoveryService = require('../services/MdnsDiscoveryService');
const { serverInfo } = require('../utils/network');

const envKeys = ['CONNECTION_MODE', 'DAKSH_CONNECTION_MODE', 'PORT', 'APP_PORT', 'PUBLIC_BASE_URL', 'SERVER_URL', 'DAKSH_MDNS_HOSTNAME', 'MDNS_ENABLED', 'DAKSH_DATA_ROOT'];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

test.after(() => {
  envKeys.forEach((key) => {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  });
});

test('local connection config uses the stable hostname and configured port', () => {
  process.env.CONNECTION_MODE = 'LOCAL';
  process.env.PORT = '4321';
  process.env.APP_PORT = '9876';
  process.env.DAKSH_MDNS_HOSTNAME = 'daksh.local';
  process.env.PUBLIC_BASE_URL = 'http://stale-address.invalid:4321';
  const config = getConnectionConfig();
  const info = serverInfo(config.port);
  assert.equal(config.mode, 'LOCAL');
  assert.equal(config.port, 4321, 'explicit PORT remains authoritative for test/service overrides');
  assert.equal(info.serverUrl, 'http://daksh.local:4321');
  assert.equal(info.mdnsUrl, info.serverUrl);
  assert.match(info.lanUrl, /^http:\/\/\d+\.\d+\.\d+\.\d+:4321$/);
});

test('server identity persists and mDNS records contain no credentials', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daksh-network-test-'));
  const identity = new ServerIdentityService({ dataRoot: root, hostname: 'daksh.local', serviceName: 'daksh-inventory' });
  const first = identity.get(4321);
  const second = new ServerIdentityService({ dataRoot: root, hostname: 'daksh.local', serviceName: 'daksh-inventory' }).get(4321);
  assert.equal(first.serverId, second.serverId);

  process.env.CONNECTION_MODE = 'LOCAL';
  process.env.PORT = '4321';
  process.env.MDNS_ENABLED = 'true';
  const mdns = new MdnsDiscoveryService({ portProvider: () => 4321, identityService: identity, versionProvider: () => 'test' });
  const packet = mdns.records();
  const serialized = JSON.stringify(packet);
  assert.match(serialized, /serverId=/);
  assert.match(serialized, /_daksh\._tcp\.local/);
  assert.doesNotMatch(serialized, /password|authorization|secret/i);
  fs.rmSync(root, { recursive: true, force: true });
});

test('structured logger redacts secrets and reads recent entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daksh-log-test-'));
  const logger = new LoggerService({ dataRoot: root, maxBytes: 1024, keepFiles: 2 });
  logger.info('network check', { serverId: 'server-1', password: 'do-not-write' });
  const entries = logger.readRecent(5);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].details.password, '[REDACTED]');
  assert.equal(entries[0].details.serverId, 'server-1');
  fs.rmSync(root, { recursive: true, force: true });
});
