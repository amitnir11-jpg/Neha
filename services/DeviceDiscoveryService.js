const os = require('os');
const { serverInfo } = require('../utils/network');

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
  constructor({ portProvider } = {}) {
    this.portProvider = portProvider || (() => process.env.PORT || 3001);
  }

  discoveryPayload(extra = {}) {
    const port = this.portProvider();
    const info = serverInfo(port);
    return {
      success: true,
      app: 'daksh-inventory-v2',
      name: 'Daksh Inventory Realtime Scanner Server',
      serverStatus: 'online',
      discoveryMode: 'lan-http-socketio',
      supportedConnections: ['wifi', 'qr_pair', 'manual_ip', 'android_pda', 'mobile_camera', 'usb_keyboard_wedge', 'bluetooth_keyboard_wedge'],
      heartbeatSeconds: 10,
      reconnect: true,
      ip: info.ip,
      port: info.port,
      serverUrl: info.serverUrl,
      healthUrl: info.healthUrl,
      connectUrl: info.connectUrl,
      syncUrl: info.syncUrl,
      socketUrl: info.serverUrl,
      networkInterfaces: networkInterfaces(),
      ...extra
    };
  }
}

module.exports = DeviceDiscoveryService;
