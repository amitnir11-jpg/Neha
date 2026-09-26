'use strict';

const os = require('os');
const path = require('path');

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function isCloudDeployment(env = process.env) {
  const target = String(env.DAKSH_DEPLOY_TARGET || env.DEPLOY_TARGET || '').trim().toLowerCase();
  return target === 'railway' || target === 'render' ||
    Boolean(env.RAILWAY_STATIC_URL || env.RAILWAY_PUBLIC_DOMAIN || env.RAILWAY_ENVIRONMENT_NAME ||
      env.RENDER_SERVICE_ID || env.RENDER_EXTERNAL_URL || env.RENDER_EXTERNAL_HOSTNAME ||
      String(env.NODE_ENV || '').trim().toLowerCase() === 'production');
}

function connectionMode(env = process.env) {
  const explicit = String(env.CONNECTION_MODE || env.DAKSH_CONNECTION_MODE || '').trim().toUpperCase();
  if (explicit === 'LOCAL' || explicit === 'CLOUD') return explicit;
  return isCloudDeployment(env) ? 'CLOUD' : 'LOCAL';
}

function getConnectionConfig(port = process.env.PORT || process.env.APP_PORT || 3000, env = process.env) {
  const mode = connectionMode(env);
  const isLocal = mode === 'LOCAL';
  const hostnameOs = os.hostname();
  const hostname = isLocal
    ? String(env.DAKSH_MDNS_HOSTNAME || 'daksh.local').trim().toLowerCase()
    : String(env.RAILWAY_PUBLIC_DOMAIN || env.RENDER_EXTERNAL_HOSTNAME || hostnameOs).trim().toLowerCase();
  const serviceName = String(env.DAKSH_MDNS_SERVICE_NAME || 'daksh-inventory').trim().toLowerCase();
  const dataRoot = path.resolve(env.DAKSH_DATA_ROOT || path.join(process.cwd(), 'runtime'));
  const discoveryPort = Number(env.MOBILE_DISCOVERY_PORT || port || 3000);

  return {
    mode,
    isLocal,
    isCloud: !isLocal,
    host: hostname,
    hostname,
    hostnameOs,
    serviceName,
    serviceType: '_http._tcp',
    dataRoot,
    discoveryPort,
    mdnsEnabled: isLocal && (env.MDNS_ENABLED === undefined
      ? !truthy(env.MDNS_DISABLED)
      : truthy(env.MDNS_ENABLED)),
    databaseProvider: 'postgresql'
  };
}

module.exports = { connectionMode, getConnectionConfig, isCloudDeployment };
