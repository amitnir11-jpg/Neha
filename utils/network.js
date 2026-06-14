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

function parseRequestHost(value = '') {
  const text = String(value || '').trim();
  if (!text) return { host: '', hostname: '' };
  try {
    const parsed = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`);
    return {
      host: parsed.host,
      hostname: parsed.hostname.toLowerCase()
    };
  } catch (error) {
    const host = text.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const hostname = host.replace(/^\[|\]$/g, '').split(':')[0].toLowerCase();
    return { host, hostname };
  }
}

function isLoopbackHost(value = '') {
  const { hostname } = parseRequestHost(value);
  return ['localhost', '127.0.0.1', '::1'].includes(hostname) || hostname.endsWith('.localhost');
}

function isPlaceholderPublicUrl(value = '') {
  const text = String(value || '').trim().toLowerCase();
  return !text || text.includes('your-app.up.railway.app') || text.includes('your-live-app-url');
}

function inferRequestProtocol(requestProtocol = '', requestHost = '') {
  const explicit = String(requestProtocol || '').trim().toLowerCase();
  if (explicit === 'http' || explicit === 'https') return explicit;
  const { hostname } = parseRequestHost(requestHost);
  if (!hostname) return 'http';
  if (['localhost', '127.0.0.1', '::1'].includes(hostname) || hostname.endsWith('.localhost')) return 'http';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return 'http';
  return 'https';
}

function publicBaseUrl(port, remoteIp = '', requestProtocol = '', requestHost = '') {
  const explicit = String(process.env.PUBLIC_BASE_URL || process.env.SERVER_URL || '').trim().replace(/\/+$/, '');
  if (explicit && !isPlaceholderPublicUrl(explicit)) return /^https?:\/\//i.test(explicit) ? explicit : `https://${explicit}`;

  const renderUrl = String(process.env.RENDER_EXTERNAL_URL || process.env.RENDER_EXTERNAL_HOSTNAME || '').trim().replace(/\/+$/, '');
  if (renderUrl) return /^https?:\/\//i.test(renderUrl) ? renderUrl : `https://${renderUrl}`;

  const railwayUrl = String(process.env.RAILWAY_STATIC_URL || '').trim().replace(/\/+$/, '');
  if (railwayUrl) return /^https?:\/\//i.test(railwayUrl) ? railwayUrl : `https://${railwayUrl}`;

  const railwayDomain = String(process.env.RAILWAY_PUBLIC_DOMAIN || '').trim().replace(/\/+$/, '');
  if (railwayDomain) return /^https?:\/\//i.test(railwayDomain) ? railwayDomain : `https://${railwayDomain}`;

  const requestHostInfo = parseRequestHost(requestHost);
  if (requestHostInfo.host && !isLoopbackHost(requestHostInfo.host) && !isPlaceholderPublicUrl(requestHostInfo.host)) {
    const protocol = inferRequestProtocol(requestProtocol, requestHostInfo.host);
    return `${protocol}://${requestHostInfo.host}`;
  }

  const activePort = Number(port || process.env.PORT || 3001);
  return `http://${detectLanIpForRemote(remoteIp)}:${activePort}`;
}

function serverInfo(port, remoteIp = '', requestProtocol = '', requestHost = '') {
  const activePort = Number(port || process.env.PORT || 3001);
  const serverUrl = publicBaseUrl(activePort, remoteIp, requestProtocol, requestHost);
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
  parseRequestHost,
  publicBaseUrl,
  serverInfo
};
