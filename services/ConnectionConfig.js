const os = require('os');
const path = require('path');

function clean(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function asBoolean(value, fallback) {
  const text = clean(value).toLowerCase();
  if (!text) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function connectionMode() {
  const railwayEnvironment = clean(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT);
  const isRailway = Boolean(railwayEnvironment || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL);
  if (isRailway) return 'CLOUD';
  const configured = clean(process.env.CONNECTION_MODE || process.env.DAKSH_CONNECTION_MODE).toUpperCase();
  if (configured === 'LOCAL' || configured === 'CLOUD') return configured;
  const target = clean(process.env.DAKSH_DEPLOY_TARGET || process.env.DEPLOY_TARGET).toLowerCase();
  if (['railway', 'render', 'cloud', 'production'].includes(target)) return 'CLOUD';
  return clean(process.env.NODE_ENV).toLowerCase() === 'production' ? 'CLOUD' : 'LOCAL';
}

function dataRoot() {
  return path.resolve(clean(process.env.DAKSH_DATA_ROOT) || (
    process.platform === 'win32'
      ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'DAKSH')
      : path.join(process.cwd(), 'local-data')
  ));
}

function mdnsHostname() {
  const configured = clean(process.env.DAKSH_MDNS_HOSTNAME || 'daksh.local').toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.local$/.test(configured)) return 'daksh.local';
  return configured;
}

function getConnectionConfig(port = process.env.PORT) {
  const mode = connectionMode();
  const configuredPort = positiveInteger(process.env.PORT || process.env.APP_PORT || port, 3000);
  const hostname = mdnsHostname();
  const serviceName = clean(process.env.DAKSH_MDNS_SERVICE_NAME || 'daksh-inventory').toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '') || 'daksh-inventory';
  return {
    mode,
    isLocal: mode === 'LOCAL',
    isCloud: mode === 'CLOUD',
    host: clean(process.env.HOST) || '0.0.0.0',
    port: configuredPort,
    hostname,
    serviceName,
    serviceType: '_daksh._tcp',
    mdnsEnabled: mode === 'LOCAL' && asBoolean(process.env.MDNS_ENABLED ?? process.env.DAKSH_MDNS_ENABLED, true),
    discoveryPort: positiveInteger(process.env.MOBILE_DISCOVERY_PORT, configuredPort),
    dataRoot: dataRoot(),
    configPath: clean(process.env.DAKSH_CONFIG_PATH),
    databaseProvider: 'postgresql',
    databaseServicePatterns: ['postgresql-x64-*', 'postgresql-*'],
    platform: process.platform,
    hostnameOs: os.hostname()
  };
}

module.exports = {
  asBoolean,
  connectionMode,
  dataRoot,
  getConnectionConfig,
  positiveInteger
};
