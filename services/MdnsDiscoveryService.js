const multicastDns = require('multicast-dns');
const { detectLanIp, lanAddresses } = require('../utils/network');
const { getConnectionConfig } = require('./ConnectionConfig');

class MdnsDiscoveryService {
  constructor({ portProvider, identityService, versionProvider, logger } = {}) {
    this.portProvider = portProvider || (() => process.env.PORT || 3000);
    this.identityService = identityService;
    this.versionProvider = versionProvider || (() => '');
    this.logger = logger;
    this.instance = null;
    this.startedAt = '';
    this.error = '';
  }

  getNames() {
    const config = getConnectionConfig(this.portProvider());
    const service = `${config.serviceName}.${config.serviceType}.local`;
    return { hostname: config.hostname, service, serviceType: `${config.serviceType}.local` };
  }

  records() {
    const config = getConnectionConfig(this.portProvider());
    const identity = this.identityService ? this.identityService.get(config.port) : { serverId: '' };
    const names = this.getNames();
    const ips = lanAddresses();
    const ip = ips[0] || detectLanIp();
    const txt = [
      'app=daksh-inventory-v2',
      `serverId=${identity.serverId}`,
      `hostname=${names.hostname}`,
      `port=${config.port}`,
      `version=${this.versionProvider()}`,
      `mode=${config.mode}`
    ];
    return {
      answers: [
        ...ips.map((address) => ({ name: names.hostname, type: 'A', ttl: 120, flush: true, data: address })),
        ...(ips.length ? [] : [{ name: names.hostname, type: 'A', ttl: 120, flush: true, data: ip }]),
        { name: config.serviceType + '.local', type: 'PTR', ttl: 120, data: names.service }
      ],
      additionals: [
        { name: names.service, type: 'SRV', ttl: 120, flush: true, data: { port: config.port, weight: 0, priority: 0, target: names.hostname } },
        { name: names.service, type: 'TXT', ttl: 120, flush: true, data: txt },
        ...ips.map((address) => ({ name: names.hostname, type: 'A', ttl: 120, flush: true, data: address }))
      ]
    };
  }

  start() {
    if (this.instance) return this.status();
    const config = getConnectionConfig(this.portProvider());
    if (!config.mdnsEnabled) return this.status('disabled');
    try {
      const instance = multicastDns({ reuseAddr: true, loopback: true });
      instance.on('query', (query) => {
        const names = this.getNames();
        const wants = (query.questions || []).some((question) => {
          const name = String(question.name || '').toLowerCase();
          return name === names.hostname || name === names.service || name === names.serviceType;
        });
        if (wants) instance.respond(this.records());
      });
      instance.on('error', (error) => {
        this.error = error.message || String(error);
        this.logger?.warn('mDNS discovery error', { error: this.error });
      });
      this.instance = instance;
      this.startedAt = new Date().toISOString();
      instance.respond(this.records());
      instance.query([{ name: config.serviceType + '.local', type: 'PTR' }, { name: config.hostname, type: 'A' }]);
      this.logger?.info('mDNS discovery started', { hostname: config.hostname, service: this.getNames().service, port: config.port });
    } catch (error) {
      this.error = error.message || String(error);
      this.logger?.warn('mDNS discovery could not start', { error: this.error });
    }
    return this.status();
  }

  stop() {
    if (!this.instance) return;
    try { this.instance.destroy(); } catch (_) {}
    this.instance = null;
  }

  status(forced = '') {
    const config = getConnectionConfig(this.portProvider());
    return {
      enabled: config.mdnsEnabled,
      status: forced || (this.instance ? 'advertising' : this.error ? 'error' : 'not_started'),
      hostname: config.hostname,
      service: this.getNames().service,
      port: config.port,
      lanIp: detectLanIp(),
      startedAt: this.startedAt,
      error: this.error
    };
  }
}

module.exports = MdnsDiscoveryService;
