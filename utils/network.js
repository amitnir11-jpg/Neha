const os = require('os');

function cleanIpv4(ip) {
  const text = String(ip || '').trim().replace(/^::ffff:/, '');
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(text) ? text : '';
}

function ipv4ToNumber(ip) {
  const clean = cleanIpv4(ip);
  if (!clean) return null;
  return clean.split('.').reduce((total, part) => {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return NaN;
    return (total << 8) + value;
  }, 0) >>> 0;
}

function isPreferredLanIp(ip) {
  if (/^192\.168\./.test(ip)) return true;
  if (/^10\./.test(ip)) return true;
  const match = ip.match(/^172\.(\d+)\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function detectLanIp() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  Object.values(interfaces).forEach((items = []) => {
    items.forEach((item) => {
      if (item.family !== 'IPv4' || item.internal) return;
      if (!item.address || item.address === '127.0.0.1') return;
      candidates.push(item.address);
    });
  });

  return candidates.find(isPreferredLanIp) || candidates[0] || '127.0.0.1';
}

function detectLanIpForRemote(remoteIp) {
  const remote = ipv4ToNumber(remoteIp);
  if (remote === null || Number.isNaN(remote)) return detectLanIp();

  const interfaces = os.networkInterfaces();
  for (const items of Object.values(interfaces)) {
    for (const item of items || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      const local = ipv4ToNumber(item.address);
      const mask = ipv4ToNumber(item.netmask);
      if (local === null || mask === null || Number.isNaN(local) || Number.isNaN(mask)) continue;
      if ((local & mask) === (remote & mask)) return item.address;
    }
  }

  return detectLanIp();
}

function isLocalhostUrl(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return false;
  try {
    const url = new URL(text);
    return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch (error) {
    return /localhost|127\.0\.0\.1|\[::1\]/.test(text);
  }
}

function publicBaseUrl(port, remoteIp = '') {
  const explicit = String(process.env.PUBLIC_BASE_URL || process.env.SERVER_URL || '').trim().replace(/\/+$/, '');
  if (explicit) return /^https?:\/\//i.test(explicit) ? explicit : `https://${explicit}`;

  const railwayUrl = String(process.env.RAILWAY_STATIC_URL || '').trim().replace(/\/+$/, '');
  if (railwayUrl) return /^https?:\/\//i.test(railwayUrl) ? railwayUrl : `https://${railwayUrl}`;

  const railwayDomain = String(process.env.RAILWAY_PUBLIC_DOMAIN || '').trim().replace(/\/+$/, '');
  if (railwayDomain) return /^https?:\/\//i.test(railwayDomain) ? railwayDomain : `https://${railwayDomain}`;

  const activePort = Number(port || process.env.PORT || 3001);
  return `http://${detectLanIpForRemote(remoteIp)}:${activePort}`;
}

function serverInfo(port, remoteIp = '') {
  const activePort = Number(port || process.env.PORT || 3001);
  const serverUrl = publicBaseUrl(activePort, remoteIp);
  const parsed = new URL(serverUrl);
  const ip = parsed.hostname;
  const hostPort = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  const connectUrl = `${serverUrl}/api/mobile/connect`;
  const syncUrl = `${serverUrl}/api/mobile/sync`;
  return {
    ip,
    port: activePort,
    hostPort,
    serverUrl,
    healthUrl: `${serverUrl}/api/health`,
    connectUrl,
    syncUrl
  };
}

module.exports = {
  cleanIpv4,
  detectLanIp,
  detectLanIpForRemote,
  isLocalhostUrl,
  publicBaseUrl,
  serverInfo
};
