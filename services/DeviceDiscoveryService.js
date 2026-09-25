const os = require('os');
const { serverInfo } = require('../utils/network');
const { getConnectionConfig } = require('./ConnectionConfig');

function networkInterfaces() {
  return Object.entries(os.networkInterfaces() || {}).flatMap(([name, entries]) => (
    entries || []
  ).filter((item) => item.family === 'IPv4' && !item.internal).map((item) => ({
    name,
    address: item.address,
    mac: item.mac,
    cidr: item.cidr || '',
    netmask: item.netmask || ''
  })));
}

class DeviceDiscoveryService {
  constructor({ portProvider, identityService, versionProvider } = {}) {
    this.portProvider = portProvider || (() => process.env.PORT || 3000);
    this.identityService = identityService;
    this.versionProvider = versionProvider || (() => '');
  }

  discoveryPayload(extra = {}) {
    const port = this.portProvider();
    const info = serverInfo(port);
    const config = getConnectionConfig(port);
    const identity = this.identityService ? this.identityService.get(port) : {};
    return {
      success: true,
      app: 'daksh-inventory-v2',
      name: 'Daksh Inventory Realtime Scanner Server',
      serverStatus: 'online',
      discoveryMode: 'mdns-udp-http-socketio',
      mode: config.mode,
      version: extra.version || this.versionProvider(),
      serverId: identity.serverId || '',
      hostname: identity.hostname || config.hostname,
      mdnsService: `${config.serviceName}.${config.serviceType}.local`,
      supportedConnections: ['wifi', 'qr_pair', 'manual_ip', 'android_pda', 'mobile_camera', 'usb_keyboard_wedge', 'bluetooth_keyboard_wedge'],
      heartbeatSeconds: 10,
      reconnect: true,
      ip: info.ip,
      lanIp: info.lanIp,
      port: info.port,
      serverUrl: info.serverUrl,
      mobileWebUrl: info.mobileWebUrl,
      mobileScannerUrl: info.mobileScannerUrl,
      legacyMobileScannerUrl: info.legacyMobileScannerUrl,
      healthUrl: info.healthUrl,
      connectUrl: info.connectUrl,
      syncUrl: info.syncUrl,
      socketUrl: info.serverUrl,
      mdnsUrl: info.mdnsUrl,
      lanUrl: info.lanUrl,
      networkInterfaces: networkInterfaces(),
      fallbackOrder: ['saved_server_identity', 'daksh.local', 'mdns', 'qr_pairing', 'subnet_probe'],
      ...extra
    };
  }
}

module.exports = DeviceDiscoveryService;
