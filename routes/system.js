const express = require('express');
const os = require('os');
const auth = require('./auth');
const { getConnectionConfig } = require('../services/ConnectionConfig');
const { serverInfo } = require('../utils/network');

const router = express.Router();

router.use(auth.requireAuth, auth.requireAdmin);

router.get('/network-status', async (req, res) => {
  const port = req.app.locals.activePort || process.env.PORT || 3000;
  const config = getConnectionConfig(port);
  const identity = req.app.locals.serverIdentity?.get(port) || {};
  const info = serverInfo(port, req.ip || req.socket.remoteAddress, req.protocol, req.get('host') || '');
  const mdns = req.app.get('mdnsDiscoveryService');
  const health = req.app.locals.getHealthSnapshot ? await req.app.locals.getHealthSnapshot(req) : {};
  return res.json({
    success: true,
    mode: config.mode,
    server: {
      ...identity,
      version: req.app.locals.appVersion || '',
      hostname: identity.hostname || config.hostname,
      machineHostname: os.hostname(),
      configuredHost: config.host,
      port,
      uptimeSeconds: Math.round(process.uptime()),
      urls: info
    },
    discovery: {
      mdns: mdns ? mdns.status() : { enabled: config.mdnsEnabled, status: 'not_available' },
      udp: { enabled: true, port: config.discoveryPort },
      fallbackOrder: ['saved_server_identity', 'daksh.local', 'mdns', 'qr_pairing', 'subnet_probe']
    },
    database: health.database || { provider: config.databaseProvider },
    interfaces: Object.entries(os.networkInterfaces() || {}).flatMap(([name, entries]) => (entries || [])
      .filter((entry) => entry.family === 'IPv4')
      .map((entry) => ({ name, address: entry.address, internal: Boolean(entry.internal), cidr: entry.cidr || '' })))
  });
});

router.get('/logs', (req, res) => {
  const logger = req.app.get('logger');
  if (!logger) return res.json({ success: true, logs: [], file: null });
  return res.json({ success: true, logs: logger.readRecent(req.query.limit), file: logger.fileInfo() });
});

router.get('/logs/download', (req, res) => {
  const logger = req.app.get('logger');
  if (!logger) return res.status(404).json({ success: false, message: 'Logs are not available.' });
  return res.download(logger.logPath, 'daksh-application.log');
});

module.exports = router;
