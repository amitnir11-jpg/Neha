const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const configuredEnvPath = process.env.DAKSH_CONFIG_PATH || (process.platform === 'win32'
  ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'DAKSH', 'config', 'daksh.env')
  : '');
require('dotenv').config({ path: configuredEnvPath || undefined });
// A dedicated environment must not inherit missing values from the source .env.
if (!process.env.DAKSH_CONFIG_PATH) require('dotenv').config();
const bcrypt = require('bcryptjs');
const cors = require('cors');
const express = require('express');
const { Server } = require('socket.io');

function wrapAsyncHandler(fn) {
  if (typeof fn !== 'function' || fn.__dakshAsyncWrapped) return fn;
  const wrapped = function wrappedAsyncHandler(...args) {
    const next = args[args.length - 1];
    try {
      const result = fn.apply(this, args);
      if (result && typeof result.catch === 'function' && typeof next === 'function') {
        result.catch(next);
      }
      return result;
    } catch (error) {
      if (typeof next === 'function') return next(error);
      throw error;
    }
  };
  Object.defineProperty(wrapped, '__dakshAsyncWrapped', { value: true });
  try {
    Object.defineProperty(wrapped, 'length', { value: fn.length });
  } catch (error) {
    // Best effort only. Express uses function length to identify error handlers.
  }
  return wrapped;
}

function patchExpressAsyncErrors() {
  try {
    const Layer = require('express/lib/router/layer');
    const descriptor = Object.getOwnPropertyDescriptor(Layer.prototype, 'handle');
    if (descriptor && descriptor.set && descriptor.set.__dakshAsyncPatch) return;
    const setHandle = function setHandle(fn) {
      this.__dakshHandle = wrapAsyncHandler(fn);
    };
    Object.defineProperty(setHandle, '__dakshAsyncPatch', { value: true });
    Object.defineProperty(Layer.prototype, 'handle', {
      configurable: true,
      enumerable: true,
      get() {
        return this.__dakshHandle;
      },
      set: setHandle
    });
  } catch (error) {
    console.warn(`Async route protection disabled: ${error.message}`);
  }
}

patchExpressAsyncErrors();

function corsOriginAllowed(origin) {
  if (!origin) return true;
  const configured = [
    process.env.DAKSH_ALLOWED_ORIGINS,
    process.env.PUBLIC_API_BASE_URL,
    process.env.PUBLIC_BASE_URL
  ].filter(Boolean).join(',').split(',').map((value) => parseRequestHost(value).hostname).filter(Boolean);
  const hostname = parseRequestHost(origin).hostname;
  if (configured.includes(hostname)) return true;
  return ['localhost', '127.0.0.1', '::1', 'daksh.local'].includes(hostname) || hostname.endsWith('.localhost');
}

const User = require('./models/User');
const Device = require('./models/Device');
const Inventory = require('./models/Inventory');
const SyncLog = require('./models/SyncLog');
const { isPlaceholderPublicUrl, parseRequestHost, serverInfo } = require('./utils/network');
const { getActiveAudit, publicAudit } = require('./utils/audit');
const authRoutes = require('./routes/auth');
const licenseService = require('./services/LicenseService');
const licenseRoutes = require('./routes/license');
const reportsRouter = require('./routes/reports');
const localPartsRouter = require('./routes/localParts');
const syncRoutes = require('./routes/sync');
const settingsRoutes = require('./routes/settings');
const ScannerManager = require('./services/ScannerManager');
const DeviceDiscoveryService = require('./services/DeviceDiscoveryService');
const SocketRealtimeService = require('./services/SocketRealtimeService');
const QRPairService = require('./services/QRPairService');
const OfflineSyncService = require('./services/OfflineSyncService');
const { getConnectionConfig } = require('./services/ConnectionConfig');
const ServerIdentityService = require('./services/ServerIdentityService');
const LoggerService = require('./services/LoggerService');
const MdnsDiscoveryService = require('./services/MdnsDiscoveryService');
const {
  connectDatabase,
  isDatabaseReady,
  prisma,
  databaseHealthDetails,
  databaseUrlSource,
  acceptedDatabaseEnvVars
} = require('./services/prisma');
const {
  applyResolvedDatabaseUrl,
  maskDatabaseUrl
} = require('./utils/postgresEnv');

const app = express();
app.locals.reportRoutesVersion = 'dealer-report-dlc-20260602';
app.locals.deployConfigVersion = 'railway-postgresql-ready-20260618';
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => callback(null, corsOriginAllowed(origin) ? origin || true : false),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
  },
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true
  },
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 30000,
  maxHttpBufferSize: 10 * 1024 * 1024
});

const PORT = Number(process.env.PORT || process.env.APP_PORT || 3000);
const HOST = String(process.env.HOST || '0.0.0.0').trim() || '0.0.0.0';
const RELEASE_BUILD = require('./utils/buildInfo').readBuildInfo();
const APP_VERSION = RELEASE_BUILD.appVersion || RELEASE_BUILD.version;
const WEB_SCANNER_BUILD = '20260926-all-barcode-formats-v1';
const MOBILE_APP_VERSION = 'Daksh Scan Lite v1.2.12';
const DEFAULT_ADMIN_USERNAME = String(process.env.DEFAULT_ADMIN_USERNAME || 'admin').trim().toLowerCase();
const DEFAULT_ADMIN_PASSWORD = String(process.env.DEFAULT_ADMIN_PASSWORD || 'admin');
const DEFAULT_ADMIN_PIN = String(process.env.DEFAULT_ADMIN_PIN ?? '1234').trim();
const ENSURE_DEFAULT_ADMIN_LOGIN = String(process.env.DAKSH_ENSURE_DEFAULT_ADMIN_LOGIN || 'false').trim().toLowerCase() === 'true';
const IS_PRODUCTION = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const DEPLOY_TARGET = String(process.env.DAKSH_DEPLOY_TARGET || process.env.DEPLOY_TARGET || '').trim().toLowerCase();
const IS_RENDER = DEPLOY_TARGET === 'render' ||
  String(process.env.RENDER || '').toLowerCase() === 'true' ||
  Boolean(process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL || process.env.RENDER_EXTERNAL_HOSTNAME);
const IS_RAILWAY = DEPLOY_TARGET === 'railway' ||
  Boolean(process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_ENVIRONMENT_NAME);
const EXPLICIT_CONNECTION_MODE = String(process.env.CONNECTION_MODE || process.env.DAKSH_CONNECTION_MODE || '').trim().toUpperCase();
const IS_OFFLINE = EXPLICIT_CONNECTION_MODE === 'LOCAL'
  ? true
  : EXPLICIT_CONNECTION_MODE === 'CLOUD'
    ? false
    : !IS_RENDER && !IS_RAILWAY && !IS_PRODUCTION;
const DEPLOYMENT_NAME = IS_RENDER
  ? 'Render'
  : IS_RAILWAY
    ? 'Railway'
    : IS_OFFLINE ? 'Offline' : 'local PC';
if (IS_PRODUCTION) {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'daksh_inventory_secret') throw new Error('JWT_SECRET must be configured with a unique production secret.');
  if (!process.env.DEFAULT_ADMIN_PASSWORD || process.env.DEFAULT_ADMIN_PASSWORD === 'admin') throw new Error('DEFAULT_ADMIN_PASSWORD must be configured with a unique production secret.');
}
const ALLOW_LOCAL_DB_FALLBACK = IS_OFFLINE;
const SKIP_MIGRATIONS = String(process.env.DAKSH_SKIP_MIGRATIONS || '').trim().toLowerCase() === 'true';
const DATABASE_INIT_RETRY_MS = Math.max(5000, Number(process.env.DAKSH_DATABASE_INIT_RETRY_MS || 15000));
const DATABASE_URL_SOURCE = databaseUrlSource();
const connectionConfig = getConnectionConfig(PORT);
const serverIdentity = new ServerIdentityService({
  dataRoot: connectionConfig.dataRoot,
  hostname: connectionConfig.hostname,
  serviceName: connectionConfig.serviceName
});
const logger = new LoggerService({ dataRoot: connectionConfig.dataRoot });
logger.installConsoleBridge();
const MOBILE_DISCOVERY_PORT = Number(process.env.MOBILE_DISCOVERY_PORT || connectionConfig.discoveryPort || PORT);
const MOBILE_DISCOVERY_REQUEST = 'DAKSH_DISCOVER_V1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROTECTED_BROWSER_PAGES = new Set([
  '/dashboard',
  '/dashboard/',
  '/daksh.html',
  '/report',
  '/report/',
  '/report.html',
  '/audit-dashboard',
  '/audit-dashboard/',
  '/audit-dashboard.html',
  '/admin-network.html',
  '/admin-logs.html'
]);
const STATIC_CACHEABLE_EXTENSIONS = new Set(['.css', '.js', '.mjs', '.map', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.eot']);
const activePort = () => app.locals.activePort || PORT;
const scannerManager = new ScannerManager({ io, activeAuditProvider: getActiveAudit });
const deviceDiscoveryService = new DeviceDiscoveryService({ portProvider: activePort, identityService: serverIdentity, versionProvider: () => APP_VERSION });
const socketRealtimeService = new SocketRealtimeService(io);
const qrPairService = new QRPairService({ portProvider: activePort, identityService: serverIdentity });
const offlineSyncService = new OfflineSyncService();
const mdnsDiscoveryService = new MdnsDiscoveryService({
  portProvider: activePort,
  identityService: serverIdentity,
  versionProvider: () => APP_VERSION,
  logger
});

const ADMIN_PERMISSIONS = {
  canScanInward: true,
  canScanOutward: true,
  canScanFitted: true,
  canScanDamage: true,
  canVerifyParts: true,
  canViewReports: true,
  canDeleteScanData: true,
  canExportExcel: true,
  canManageUsers: true
};

process.on('unhandledRejection', (reason) => {
  const message = reason && reason.stack ? reason.stack : reason;
  console.error('Unhandled async error:', message);
});

app.set('io', io);
app.set('scannerManager', scannerManager);
app.set('deviceDiscoveryService', deviceDiscoveryService);
app.set('socketRealtimeService', socketRealtimeService);
app.set('qrPairService', qrPairService);
app.set('offlineSyncService', offlineSyncService);
app.set('serverIdentity', serverIdentity);
app.set('logger', logger);
app.set('mdnsDiscoveryService', mdnsDiscoveryService);
app.set('licenseService', licenseService);
app.locals.appVersion = APP_VERSION;
app.locals.webScannerBuild = WEB_SCANNER_BUILD;
app.locals.mobileAppVersion = MOBILE_APP_VERSION;
app.locals.connectionConfig = connectionConfig;
app.locals.serverIdentity = serverIdentity;
app.set('trust proxy', 1);

app.use(cors({ origin: (origin, callback) => callback(null, corsOriginAllowed(origin) ? origin || true : false) }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

function databaseEnvLocation() {
  if (IS_RAILWAY) return 'Railway Variables';
  if (IS_RENDER) return 'Render Environment Variables';
  if (!IS_OFFLINE) return 'your hosting environment variables';
  return 'your .env file or environment variables';
}

function databaseUnavailableMessage() {
  if (connectionConfig.isLocal) return 'PostgreSQL is unavailable. Start the configured PostgreSQL Windows service and retry; Daksh will continue automatic readiness retries.';
  return `PostgreSQL is unavailable. Set Railway PostgreSQL connection variables in ${databaseEnvLocation()} (${acceptedDatabaseEnvVars().join(', ')}) and redeploy.`;
}

function currentDatabaseStatus() {
  return isDatabaseReady() ? 'connected' : 'disconnected';
}

function currentDatabasePayload() {
  const connected = isDatabaseReady();
  return {
    database: connected ? 'online' : 'offline',
    databaseStatus: connected ? 'online' : 'offline',
    postgresStatus: connected ? 'online' : 'offline',
    db: connected ? 'connected' : 'disconnected',
    acceptedDatabaseEnvVars: acceptedDatabaseEnvVars(),
    configuredDatabaseEnvVar: databaseUrlSource() || DATABASE_URL_SOURCE,
    databaseStartupStatus: databaseStartupState.status,
    databaseStartupAttempts: databaseStartupState.attempts,
    databaseStartupLastAttemptAt: databaseStartupState.lastAttemptAt,
    databaseStartupLastSuccessAt: databaseStartupState.lastSuccessAt,
    databaseStartupLastError: databaseStartupState.lastError,
    applicationInitializationStatus: applicationInitializationState.status,
    applicationSchemaVerified: applicationInitializationState.schemaVerified,
    applicationInitializedAt: applicationInitializationState.initializedAt,
    applicationInitializationError: applicationInitializationState.lastError,
    ...databaseHealthDetails()
  };
}

function currentStoragePayload() {
  const storagePath = connectionConfig.dataRoot || process.cwd();
  try {
    if (typeof fs.statfsSync !== 'function') throw new Error('Filesystem capacity API unavailable');
    const stats = fs.statfsSync(storagePath, { bigint: true });
    const blockSize = BigInt(stats.bsize || 0);
    const totalBytes = Number(BigInt(stats.blocks || 0) * blockSize);
    const freeBytes = Number(BigInt(stats.bavail || stats.bfree || 0) * blockSize);
    const freePercent = totalBytes > 0 ? Number(((freeBytes / totalBytes) * 100).toFixed(1)) : 0;
    const status = freeBytes < 1024 ** 3 || freePercent < 5
      ? 'low'
      : (freeBytes < 5 * 1024 ** 3 || freePercent < 10 ? 'warning' : 'normal');
    return {
      storageStatus: status,
      storage: { status, totalBytes, freeBytes, freePercent }
    };
  } catch (error) {
    return {
      storageStatus: 'unavailable',
      storage: { status: 'unavailable', message: error.message }
    };
  }
}

app.locals.getHealthSnapshot = async () => ({
  database: {
    provider: connectionConfig.databaseProvider,
    ...currentDatabasePayload()
  }
});

let mobileDiscoverySocket = null;
let databaseInitTimer = null;
let databaseStartupPromise = null;
const databaseStartupState = {
  status: 'pending',
  attempts: 0,
  initializing: false,
  lastAttemptAt: '',
  lastSuccessAt: '',
  lastError: ''
};
const applicationInitializationState = {
  status: 'pending',
  schemaVerified: false,
  initializedAt: '',
  lastError: ''
};

function applicationReady() {
  return isDatabaseReady() && databaseStartupState.status === 'connected' && applicationInitializationState.status === 'ready' && applicationInitializationState.schemaVerified;
}

function runtimePayload(port, info = serverInfo(port)) {
  const config = getConnectionConfig(port);
  const identity = serverIdentity.get(port);
  return {
    mode: config.mode.toLowerCase(),
    connectionMode: config.mode,
    serverId: identity.serverId,
    hostname: identity.hostname,
    machineHostname: config.hostnameOs,
    configuredHost: config.host,
    version: APP_VERSION,
    appVersion: APP_VERSION,
    uptimeSeconds: Math.round(process.uptime()),
    port: Number(port),
    mdnsEnabled: config.mdnsEnabled,
    mdnsStatus: mdnsDiscoveryService ? mdnsDiscoveryService.status() : null,
    serverUrl: info.serverUrl,
    lanUrl: info.lanUrl,
    mdnsUrl: info.mdnsUrl
  };
}

function mobileDiscoveryPayload(activePort, remoteAddress = '') {
  const info = serverInfo(activePort, remoteAddress);
  const config = getConnectionConfig(activePort);
  const identity = serverIdentity.get(activePort);
  return {
    success: true,
    type: 'daksh-server',
    app: 'daksh-inventory-v2',
    name: 'Daksh Inventory PC Server',
    status: 'online',
    serverStatus: 'online',
    ...currentDatabasePayload(),
    discovery: 'udp+mdns',
    mode: config.mode,
    version: APP_VERSION,
    serverId: identity.serverId,
    hostname: identity.hostname,
    mdnsUrl: info.mdnsUrl,
    lanUrl: info.lanUrl,
    fallbackOrder: ['saved_server_identity', 'daksh.local', 'mdns', 'qr_pairing', 'subnet_probe'],
    ip: info.ip,
    lanIp: info.lanIp,
    port: info.port,
    serverUrl: info.serverUrl,
    mobileScannerUrl: info.mobileScannerUrl,
    healthUrl: info.healthUrl,
    connectUrl: info.connectUrl,
    syncUrl: info.syncUrl
  };
}

function startMobileDiscoveryServer(activePort) {
  if (mobileDiscoverySocket) return;

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  mobileDiscoverySocket = socket;

  socket.on('error', (error) => {
    console.warn(`Mobile auto-discovery disabled: ${error.message}`);
    socket.close();
    if (mobileDiscoverySocket === socket) mobileDiscoverySocket = null;
  });

  socket.on('message', (message, rinfo) => {
    const text = message.toString('utf8').trim();
    if (text !== MOBILE_DISCOVERY_REQUEST) return;

    const payload = Buffer.from(JSON.stringify(mobileDiscoveryPayload(activePort, rinfo.address)));
    socket.send(payload, 0, payload.length, rinfo.port, rinfo.address, (error) => {
      if (error) console.warn(`Mobile discovery reply failed: ${error.message}`);
    });
  });

  socket.bind(MOBILE_DISCOVERY_PORT, '0.0.0.0', () => {
    try {
      socket.setBroadcast(true);
    } catch (error) {
      console.warn(`Mobile discovery broadcast option failed: ${error.message}`);
    }
  });
}

app.use((req, res, next) => {
  const origin = req.get('origin');
  if (corsOriginAllowed(origin)) {
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-Token');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});
app.use((req, res, next) => {
  req.io = io;
  next();
});
app.use((req, res, next) => {
  const normalizedPath = String(req.path || '').replace(/\/+$/, '') || '/';
  if (
    normalizedPath === '/' ||
    normalizedPath === '/login' ||
    normalizedPath === '/dashboard' ||
    normalizedPath === '/report' ||
    normalizedPath === '/scan' ||
    normalizedPath === '/mobile' ||
    normalizedPath === '/mobile-scanner' ||
    normalizedPath === '/mobile-web' ||
    normalizedPath === '/config.js' ||
    normalizedPath.startsWith('/api/')
  ) {
    setNoStoreHeaders(res);
  }
  next();
});

app.use((req, res, next) => {
  const explicitPublicBaseUrl = String(
    process.env.PUBLIC_BASE_URL ||
    process.env.SERVER_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    process.env.RENDER_EXTERNAL_HOSTNAME ||
    process.env.RAILWAY_STATIC_URL ||
    process.env.RAILWAY_PUBLIC_DOMAIN ||
    ''
  ).trim().replace(/\/+$/, '');
  if (IS_OFFLINE) return next();
  if (!explicitPublicBaseUrl || isPlaceholderPublicUrl(explicitPublicBaseUrl) || !/^(GET|HEAD)$/i.test(req.method)) return next();
  if (req.path === '/health' || req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) return next();
  if (/\.(?:css|js|mjs|map|png|jpe?g|gif|svg|webp|ico|txt|json|woff2?|ttf|eot)$/i.test(req.path)) return next();

  const requestHost = req.get('x-forwarded-host') || req.get('host') || '';
  const currentHost = parseRequestHost(requestHost).host;
  const targetHost = parseRequestHost(explicitPublicBaseUrl).host || requestHost;
  if (!currentHost || currentHost === targetHost) return next();

  const targetUrl = new URL(req.originalUrl, /^https?:\/\//i.test(explicitPublicBaseUrl) ? explicitPublicBaseUrl : `https://${explicitPublicBaseUrl}`);
  return res.redirect(302, targetUrl.toString());
});

app.get('/config.js', (req, res) => {
  const apiBaseUrl = String(process.env.PUBLIC_API_BASE_URL || process.env.API_BASE_URL || '').trim().replace(/\/+$/, '');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  setNoStoreHeaders(res);
  res.send(`window.DAKSH_CONFIG=${JSON.stringify({
    apiBaseUrl,
    appVersion: APP_VERSION,
    version: APP_VERSION,
    webScannerBuild: WEB_SCANNER_BUILD,
    mobileAppVersion: MOBILE_APP_VERSION,
    connectionMode: connectionConfig.mode,
    serverId: serverIdentity.get(activePort()).serverId,
    hostname: connectionConfig.hostname,
    licenseRequired: licenseService.isRequired()
  })};`);
});

app.use('/vendor/zxing', express.static(path.join(__dirname, 'node_modules', '@zxing', 'library', 'umd'), {
  etag: true,
  lastModified: true,
  setHeaders: setStaticAssetHeaders
}));

app.use(async (req, res, next) => {
  if (!PROTECTED_BROWSER_PAGES.has(String(req.path || '').toLowerCase())) return next();
  try {
    const licenseStatus = await licenseService.currentStatus();
    if (licenseStatus.required && !licenseStatus.runAllowed) {
      return res.redirect(302, '/?licenseRequired=1');
    }
  } catch (error) {
    return res.status(503).send('License validation is temporarily unavailable.');
  }
  return authRoutes.requirePageAuth(req, res, next);
});

app.use(express.static(PUBLIC_DIR, {
  etag: true,
  lastModified: true,
  setHeaders: setStaticAssetHeaders
}));

app.get(['/apk', '/download-apk', '/api/apk/download'], (req, res) => {
  const apkPath = path.join(PUBLIC_DIR, 'downloads', 'daksh-mobile-scanner.apk');
  res.download(apkPath, 'daksh-mobile-scanner.apk');
});

app.get(['/lite-apk', '/download-lite-apk', '/api/apk/lite'], (req, res) => {
  // Both APK names previously pointed to byte-for-byte identical packages.
  // Keep the legacy Lite download URL while storing a single APK on disk.
  const apkPath = path.join(PUBLIC_DIR, 'downloads', 'daksh-mobile-scanner.apk');
  res.download(apkPath, 'daksh-lite-scanner.apk');
});

app.get(['/scan', '/scan/'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(PUBLIC_DIR, 'scan.html'));
});

app.get(['/mobile', '/mobile-scanner', '/mobile-scanner/', '/mobile-web', '/mobile-web/'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(PUBLIC_DIR, 'scan.html'));
});

app.get('/force-login', (req, res) => {
  authRoutes.clearAuthCookie(res, req);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Daksh Logout</title></head>
<body>
  <script>
    localStorage.removeItem('dakshToken');
    localStorage.removeItem('dakshUser');
    sessionStorage.clear();
    window.location.replace('/');
  </script>
  <p>Opening Daksh login...</p>
</body></html>`);
});

app.get('/live', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.status(200).json({ status: 'ok', serverStatus: 'online' });
});

app.get('/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const ready = applicationReady();
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'starting',
    mode: IS_OFFLINE ? 'offline' : 'online',
    ready,
    ...runtimePayload(req.app.locals.activePort || PORT),
    ...currentDatabasePayload(),
    ...currentStoragePayload()
  });
});

app.get('/api/version', (req, res) => {
  const info = serverInfo(req.app.locals.activePort || PORT, req.ip || req.socket.remoteAddress, req.protocol, req.get('x-forwarded-host') || req.get('host') || '');
  res.json({
    success: true,
    buildInfo: RELEASE_BUILD,
    appVersion: APP_VERSION,
    version: APP_VERSION,
    webScannerBuild: WEB_SCANNER_BUILD,
    mobileAppVersion: MOBILE_APP_VERSION,
    deployConfigVersion: req.app.locals.deployConfigVersion || '',
    reportRoutesVersion: req.app.locals.reportRoutesVersion || '',
    ...runtimePayload(req.app.locals.activePort || PORT, info),
    serverUrl: info.serverUrl
  });
});

app.get('/api/health', async (req, res) => {
  const activePort = req.app.locals.activePort || PORT;
  const info = serverInfo(activePort, req.ip || req.socket.remoteAddress, req.protocol, req.get('x-forwarded-host') || req.get('host') || '');
  const dbReady = isDatabaseReady();
  const ready = applicationReady();
  const dbStatus = currentDatabaseStatus();
  const databaseDetails = currentDatabasePayload();
  const [connectedDevices, pending, failed, lastSyncDoc, lastSyncLog, lastSyncDevice] = await Promise.all([
    dbReady ? Device.countDocuments({ status: 'online' }).catch(() => 0) : 0,
    dbReady ? Inventory.countDocuments({ $or: [{ syncStatus: 'pending' }, { isSynced: false }] }).catch(() => 0) : 0,
    dbReady ? Inventory.countDocuments({ syncStatus: 'failed' }).catch(() => 0) : 0,
    dbReady ? Inventory.findOne({ $or: [{ syncStatus: 'synced' }, { isSynced: true }, { synced: true }] }).sort({ updatedAt: -1, timestamp: -1 }).select('updatedAt timestamp').lean().catch(() => null) : null,
    dbReady ? SyncLog.findOne({ status: { $in: ['success', 'partial'] } }).sort({ updatedAt: -1, createdAt: -1 }).select('updatedAt createdAt').lean().catch(() => null) : null,
    dbReady ? Device.findOne({ lastSyncTime: { $exists: true, $ne: null } }).sort({ lastSyncTime: -1 }).select('lastSyncTime').lean().catch(() => null) : null
  ]);
  const lastSyncTimes = [
    lastSyncLog && (lastSyncLog.updatedAt || lastSyncLog.createdAt),
    lastSyncDevice && lastSyncDevice.lastSyncTime,
    lastSyncDoc && (lastSyncDoc.updatedAt || lastSyncDoc.timestamp)
  ].map((value) => (value ? new Date(value) : null)).filter((date) => date && !Number.isNaN(date.getTime()));
  const lastSyncAt = lastSyncTimes.sort((a, b) => b.getTime() - a.getTime())[0] || null;
  const lastSync = lastSyncAt ? lastSyncAt.toISOString() : '';
  res.status(ready ? 200 : 503).json({
    databaseType: 'postgresql',
    buildInfo: RELEASE_BUILD,
    status: ready ? 'OK' : 'STARTING',
    message: 'Daksh Inventory Backend Running',
    success: true,
    server: 'online',
    reportRoutesVersion: req.app.locals.reportRoutesVersion || '',
    deployConfigVersion: req.app.locals.deployConfigVersion || '',
    deploymentTarget: DEPLOYMENT_NAME,
    render: IS_RENDER,
    railway: IS_RAILWAY,
    serverStatus: 'online',
    ready,
    ...runtimePayload(activePort, info),
    ...databaseDetails,
    ...currentStoragePayload(),
    connectedDevices,
    mobileConnectedDevices: connectedDevices,
    lastSync,
    lastSyncTime: lastSync,
    lastSuccessfulSyncAt: lastSync,
    hasSyncData: Boolean(lastSync),
    pending,
    failed,
    db: dbStatus,
    ip: info.ip,
    lanIp: info.lanIp,
    currentLanIp: info.lanIp,
    port: info.port,
    serverUrl: info.serverUrl,
    scanUrl: info.scanUrl,
    mobileWebUrl: info.mobileWebUrl,
    mobileScannerUrl: info.mobileScannerUrl,
    legacyMobileScannerUrl: info.legacyMobileScannerUrl,
    healthUrl: info.healthUrl,
    connectUrl: info.connectUrl,
    syncUrl: info.syncUrl
  });
});

app.get('/api/ping', (req, res) => {
  const info = serverInfo(req.app.locals.activePort || PORT, req.ip || req.socket.remoteAddress, req.protocol, req.get('x-forwarded-host') || req.get('host') || '');
  res.json({
    success: true,
    status: 'online',
    message: 'pong',
    time: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    deployConfigVersion: req.app.locals.deployConfigVersion || '',
    deploymentTarget: DEPLOYMENT_NAME,
    render: IS_RENDER,
    railway: IS_RAILWAY,
    ...currentDatabasePayload(),
    ...runtimePayload(req.app.locals.activePort || PORT, info),
    serverUrl: info.serverUrl,
    mobileScannerUrl: info.mobileScannerUrl
  });
});

app.get('/api/ready', (req, res) => {
  const port = req.app.locals.activePort || PORT;
  const info = serverInfo(port, req.ip || req.socket.remoteAddress, req.protocol, req.get('x-forwarded-host') || req.get('host') || '');
  const ready = applicationReady();
  res.status(ready ? 200 : 503).json({
    success: ready,
    ready,
    status: ready ? 'ready' : 'not_ready',
    serverStatus: 'online',
    ...currentDatabasePayload(),
    ...runtimePayload(port, info),
    deploymentTarget: DEPLOYMENT_NAME,
    render: IS_RENDER,
    railway: IS_RAILWAY,
    message: ready
      ? 'Daksh is ready.'
      : databaseUnavailableMessage()
  });
});

app.get('/api/discovery', (req, res) => {
  const port = req.app.locals.activePort || PORT;
  const info = serverInfo(port, req.ip || req.socket.remoteAddress, req.protocol, req.get('x-forwarded-host') || req.get('host') || '');
  res.json({
    success: true,
    type: 'daksh-server',
    app: 'daksh-inventory-v2',
    name: 'Daksh Inventory PC Server',
    status: 'online',
    serverStatus: 'online',
    fallbackOrder: ['saved_server_identity', 'daksh.local', 'mdns', 'qr_pairing', 'subnet_probe'],
    ...runtimePayload(port, info),
    ...currentDatabasePayload(),
    ip: info.ip,
    lanIp: info.lanIp,
    currentLanIp: info.lanIp,
    port: info.port,
    serverUrl: info.serverUrl,
    scanUrl: info.scanUrl,
    mobileWebUrl: info.mobileWebUrl,
    mobileScannerUrl: info.mobileScannerUrl,
    legacyMobileScannerUrl: info.legacyMobileScannerUrl,
    healthUrl: info.healthUrl,
    connectUrl: info.connectUrl,
    syncUrl: info.syncUrl
  });
});

app.use('/api/license', licenseRoutes);
app.use('/api/auth', licenseService.middleware());

app.use('/api/auth', (req, res, next) => {
  if (isDatabaseReady()) return next();
  return res.status(503).json({
    success: false,
    message: databaseUnavailableMessage(),
    serverStatus: 'online',
    ...currentDatabasePayload(),
    deploymentTarget: DEPLOYMENT_NAME,
    render: IS_RENDER,
    railway: IS_RAILWAY
  });
});

app.use('/api/auth', authRoutes);

app.use('/api', (req, res, next) => {
  if (req.path === '/mobile/version') return next();
  return licenseService.middleware()(req, res, next);
});

app.use('/api', (req, res, next) => {
  if (req.path === '/mobile/version') return next();
  if (isDatabaseReady()) return next();
  return res.status(503).json({
    success: false,
    message: databaseUnavailableMessage(),
    serverStatus: 'online',
    ...currentDatabasePayload(),
    deploymentTarget: DEPLOYMENT_NAME,
    render: IS_RENDER,
    railway: IS_RAILWAY
  });
});

app.use('/api/admin', require('./routes/admin'));
app.use('/api/admin-delete', require('./routes/adminDelete'));
app.use('/api/users', require('./routes/users'));
app.use('/api/bin', require('./routes/bin'));
app.use('/api/bin-master', require('./routes/binMaster'));
app.use('/api/bin-transfer', require('./routes/binTransfer'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/scans', require('./routes/inventory'));
app.use('/api/scan', require('./routes/inventory'));
app.use('/api/scan-audit', require('./routes/scanAudit'));
app.use('/api/audit-dashboard', require('./routes/audit-dashboard'));
app.use('/api/local-parts', localPartsRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/report-filter-settings', require('./routes/reportFilterSettings'));
app.use('/api/settings', settingsRoutes);
app.use('/api/dealers', require('./routes/dealer'));
app.use('/api/devices', require('./routes/devices'));
app.use('/api/master', require('./routes/master'));
app.use('/api/master-parts', require('./routes/master'));
app.use('/api/master-catalogue', require('./routes/masterCatalogue'));
app.use('/api/backup', require('./routes/backup'));
app.use('/api/audit-backup', require('./routes/auditBackup'));
const reconciliationRouter = require('./routes/reconciliation');
app.use('/api/reconciliation', reconciliationRouter);
app.use('/api/dealer-stock', reconciliationRouter);
app.use('/api/qr', require('./routes/qr'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/scanner-network', require('./routes/scannerNetwork'));
app.use('/api/sync', syncRoutes);
app.use('/api/mobile', require('./routes/mobile'));
app.use('/api/system', require('./routes/system'));

app.get(['/', '/login'], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'Daksh.html'));
});

app.get('/audit-dashboard', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'audit-dashboard.html'));
});

app.get('/report', (req, res) => {
  // The legacy standalone report page only exposes the Final Compile Report.
  // Keep existing /report bookmarks working, but open the complete report
  // workspace so every report type is available from one place.
  const query = new URLSearchParams(req.query);
  query.set('view', 'reports');
  res.redirect(`/dashboard?${query.toString()}`);
});

app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'API endpoint not found'
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status || error.statusCode || 500;
  console.error('API error', {
    method: req.method,
    url: req.originalUrl,
    status,
    message: error.message
  });
  return res.status(status).json({
    success: false,
    message: status >= 500 ? 'Server error. Please retry.' : error.message,
    error: process.env.NODE_ENV === 'production' ? undefined : error.message
  });
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/socket.io') || path.extname(req.path)) {
    return next();
  }
  return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((req, res) => {
  if (path.extname(req.path)) return res.status(404).send('Not found');
  return res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

io.use(authRoutes.authenticateSocket);

io.on('connection', async (socket) => {
  if (!(await licenseService.assertSocketAllowed(socket))) return;
  socket.emit('server:ready', { app: 'Daksh Inventory v2', socketId: socket.id, recovered: socket.recovered });

  socket.on('device:hello', async (payload = {}) => {
    try {
      const deviceType = String(payload.deviceType || '').toLowerCase();
      const isBrowser = /dashboard browser|web scanner/i.test(String(payload.deviceName || ''));
      if (deviceType !== 'mobile' || isBrowser) {
        if (!isBrowser && deviceType && deviceType !== 'web') {
          const device = await scannerManager.register(payload, { socket });
          socket.data.deviceId = device.deviceId;
          socket.emit('audit:active', publicAudit(await getActiveAudit(payload.dealerCode ? { dealerCode: payload.dealerCode } : {})));
          return;
        }
        socket.data.deviceId = '';
        socket.emit('audit:active', publicAudit(await getActiveAudit(payload.dealerCode ? { dealerCode: payload.dealerCode } : {})));
        return;
      }
      const deviceId = String(payload.deviceId || socket.id).trim();
      const activeAudit = await getActiveAudit(payload.dealerCode ? { dealerCode: payload.dealerCode } : {});
      socket.data.deviceId = deviceId;
      const ipAddress = socket.handshake.address ? socket.handshake.address.replace('::ffff:', '') : '';
      const device = await Device.findOneAndUpdate(
        { deviceId },
        {
          deviceId,
          deviceName: payload.deviceName || 'Web Scanner',
          model: payload.model || '',
          deviceType: 'mobile',
          approved: true,
          dealerCode: activeAudit ? activeAudit.dealerCode : payload.dealerCode || '',
          dealerName: activeAudit ? activeAudit.dealerName : payload.dealerName || '',
          auditId: activeAudit ? activeAudit.auditId : payload.auditId || '',
          serverUrl: payload.serverUrl || '',
          ipAddress,
          status: 'online',
          lastSeen: new Date(),
          connectedAt: new Date(),
          appVersion: payload.appVersion || payload.version || '',
          batteryPercent: payload.batteryPercent ?? payload.battery,
          disconnectedAt: undefined,
          disconnectedBy: '',
          removedAt: null
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      io.emit('devices:update');
      io.emit('device:connected', device);
      socket.emit('audit:active', publicAudit(activeAudit));
    } catch (error) {
      console.error('Socket device registration failed:', error.message);
    }
  });

  socket.on('device:heartbeat', async (payload = {}) => {
    try {
      const deviceType = String(payload.deviceType || '').toLowerCase();
      const isBrowser = /dashboard browser|web-dashboard/i.test(String(payload.deviceName || payload.appVersion || ''));
      if (deviceType !== 'mobile' || isBrowser) {
        if (!isBrowser && deviceType && deviceType !== 'web') {
          const device = await scannerManager.heartbeat(payload, { socket });
          socket.data.deviceId = device.deviceId;
        }
        return;
      }
      const deviceId = String(payload.deviceId || socket.data.deviceId || '').trim();
      if (!deviceId) return;
      const activeAudit = await getActiveAudit(payload.dealerCode ? { dealerCode: payload.dealerCode } : {});
      socket.data.deviceId = deviceId;
      const device = await Device.findOneAndUpdate(
        { deviceId },
        {
          deviceId,
          deviceName: payload.deviceName || 'Scanner Device',
          model: payload.model || '',
          deviceType: 'mobile',
          approved: true,
          dealerCode: activeAudit ? activeAudit.dealerCode : payload.dealerCode || '',
          dealerName: activeAudit ? activeAudit.dealerName : payload.dealerName || '',
          auditId: activeAudit ? activeAudit.auditId : payload.auditId || '',
          serverUrl: payload.serverUrl || '',
          ipAddress: socket.handshake.address ? socket.handshake.address.replace('::ffff:', '') : '',
          status: 'online',
          lastSeen: new Date(),
          appVersion: payload.appVersion || payload.version || '',
          batteryPercent: payload.batteryPercent ?? payload.battery,
          pendingCount: Number(payload.pendingCount || 0),
          failedCount: Number(payload.failedCount || 0),
          syncStatus: activeAudit ? (payload.syncStatus || 'idle') : 'blocked',
          disconnectedAt: undefined,
          disconnectedBy: '',
          removedAt: null
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      io.emit('devices:update');
      io.emit('device:heartbeat', device);
    } catch (error) {
      console.error('Socket device heartbeat failed:', error.message);
    }
  });

  socket.on('scanData', async (payload = {}, ack) => {
    try {
      const deviceId = String(payload.deviceId || socket.data.deviceId || socket.id).trim();
      socket.data.deviceId = deviceId;
      const result = await syncRoutes.saveNormalizedScan(syncRoutes.normalizeScan({ ...payload, deviceId }), {
        io,
        app,
        user: null
      });
      if (result.scan) scannerManager.recordScanActivity(result.scan).catch((error) => console.warn('Scanner activity update failed:', error.message));
      const response = {
        success: ['synced', 'duplicate'].includes(result.status),
        status: result.status,
        message: result.error || 'Scan processed',
        scan: result.scan
      };
      socket.emit('syncData', response);
      if (typeof ack === 'function') ack(response);
    } catch (error) {
      const response = { success: false, status: 'failed', message: error.message };
      console.error('[SOCKET] scanData failed', response);
      socket.emit('syncData', response);
      if (typeof ack === 'function') ack(response);
    }
  });

  socket.on('syncData', async (payload = {}, ack) => {
    try {
      const records = Array.isArray(payload.records) ? payload.records : Array.isArray(payload.scans) ? payload.scans : Array.isArray(payload) ? payload : [payload];
      const deviceId = String(payload.deviceId || socket.data.deviceId || (records[0] && records[0].deviceId) || socket.id).trim();
      socket.data.deviceId = deviceId;
      const results = [];
      for (const record of records) {
        const result = await syncRoutes.saveNormalizedScan(syncRoutes.normalizeScan({ ...record, deviceId: record.deviceId || deviceId }), {
          io,
          app,
          user: null
        });
        if (result.scan) scannerManager.recordScanActivity(result.scan).catch((error) => console.warn('Scanner activity update failed:', error.message));
        results.push(result);
      }
      const insertedCount = results.filter((item) => item.status === 'synced').length;
      const duplicateCount = results.filter((item) => item.status === 'duplicate').length;
      const failedCount = results.filter((item) => item.status === 'failed').length;
      const response = {
        success: failedCount === 0,
        insertedCount,
        syncedCount: insertedCount,
        duplicateCount,
        failedCount,
        logs: results.map((item) => ({
          time: new Date(),
          partNumber: item.scan && (item.scan.partNumber || item.scan.part),
          syncKey: item.scan && item.scan.syncKey,
          status: item.status,
          errorMessage: item.error || ''
        })),
        completedAt: new Date()
      };
      io.emit('sync:completed', response);
      io.emit('syncData', response);
      if (typeof ack === 'function') ack(response);
    } catch (error) {
      const response = { success: false, failedCount: 1, message: error.message, failedAt: new Date() };
      console.error('[SOCKET] syncData failed', response);
      io.emit('sync:failed', response);
      socket.emit('syncData', response);
      if (typeof ack === 'function') ack(response);
    }
  });

  socket.on('disconnect', async () => {
    if (!socket.data.deviceId) return;
    try {
      const device = await Device.findOneAndUpdate(
        { deviceId: socket.data.deviceId },
        { status: 'offline', scannerStatus: 'disconnected', healthStatus: 'offline', disconnectedAt: new Date(), disconnectedBy: 'socket-disconnect' },
        { new: true }
      );
      io.emit('devices:update');
      io.emit('device:disconnected', device || { deviceId: socket.data.deviceId, status: 'offline' });
    } catch (error) {
      console.error('Socket device disconnect failed:', error.message);
    }
  });
});

async function createDefaultAdmin() {
  const existingAdmin = await User.findOne({ username: DEFAULT_ADMIN_USERNAME });
  const passwordHash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);
  const defaultPinEnabled = /^\d{4}$/.test(DEFAULT_ADMIN_PIN);
  const pinHash = defaultPinEnabled ? await bcrypt.hash(DEFAULT_ADMIN_PIN, 10) : '';
  if (existingAdmin) {
    const update = {};
    const defaultEmail = process.env.REPORT_EMAIL || 'amitsvision4u@gmail.com';
    if (existingAdmin.approved === false || existingAdmin.approved === undefined) update.approved = true;
    if (existingAdmin.active === false || existingAdmin.active === undefined) update.active = true;
    if (existingAdmin.isActive === false || existingAdmin.isActive === undefined) update.isActive = true;
    if (existingAdmin.role !== 'admin') update.role = 'admin';
    if (!existingAdmin.name) update.name = 'Administrator';
    if (!Array.isArray(existingAdmin.dealerAccess) || !existingAdmin.dealerAccess.includes('ALL')) update.dealerAccess = ['ALL'];
    update.permissions = { ...(existingAdmin.permissions || {}), ...ADMIN_PERMISSIONS };
    if (ENSURE_DEFAULT_ADMIN_LOGIN || (!existingAdmin.passwordHash && !existingAdmin.password)) {
      update.passwordHash = passwordHash;
      update.password = passwordHash;
      update.forcePasswordChange = false;
    }
    if (defaultPinEnabled && (ENSURE_DEFAULT_ADMIN_LOGIN || (!existingAdmin.pinHash && !existingAdmin.pin))) {
      update.pinHash = pinHash;
      update.pin = pinHash;
    }
    if (!existingAdmin.email) {
      const emailOwner = await User.findOne({ email: defaultEmail, _id: { $ne: existingAdmin._id } }).lean();
      if (!emailOwner) update.email = defaultEmail;
    }
    if (Object.keys(update).length) {
      update.approvedBy = 'system';
      update.approvedAt = existingAdmin.approvedAt || new Date();
      await User.updateOne({ _id: existingAdmin._id }, update);
    }
    return;
  }

  await User.create({
    username: DEFAULT_ADMIN_USERNAME,
    email: process.env.REPORT_EMAIL || 'amitsvision4u@gmail.com',
    passwordHash,
    password: passwordHash,
    ...(defaultPinEnabled ? { pinHash, pin: pinHash } : {}),
    role: 'admin',
    name: 'Administrator',
    dealerAccess: ['ALL'],
    permissions: ADMIN_PERMISSIONS,
    approved: true,
    approvedBy: 'system',
    approvedAt: new Date(),
    active: true,
    isActive: true
  });

}

async function runPostgresStartupTasks() {
  await createDefaultAdmin();
  const roleMigration = await authRoutes.migrateLegacyUserRoles();
  if (roleMigration.migrated) console.log(`Canonicalized ${roleMigration.migrated} legacy user role(s).`);
}

async function verifyApplicationSchema() {
  const rows = await prisma.$queryRaw`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('users', 'inventories', 'license_records')
  `;
  const names = new Set(rows.map((row) => row.table_name));
  const required = ['users', 'inventories'];
  if (licenseService.isRequired()) required.push('license_records');
  const missing = required.filter((name) => !names.has(name));
  if (missing.length) throw new Error(`Required PostgreSQL tables are missing: ${missing.join(', ')}.`);
  applicationInitializationState.schemaVerified = true;
}

async function runPrismaMigrations() {
  if (String(process.env.DAKSH_MIGRATIONS_COMPLETED || '').toLowerCase() === 'true') return;
  if (SKIP_MIGRATIONS) {
    console.log('Skipping Prisma migrations because DAKSH_SKIP_MIGRATIONS=true');
    process.env.DAKSH_MIGRATIONS_COMPLETED = 'true';
    return;
  }
  const resolvedDatabase = applyResolvedDatabaseUrl();
  if (!resolvedDatabase.url) {
    throw new Error(`PostgreSQL URL is missing. Set one of: ${acceptedDatabaseEnvVars().join(', ')}.`);
  }
  console.log(`Running Prisma migrations using ${resolvedDatabase.source}: ${maskDatabaseUrl(resolvedDatabase.url)}`);
  const prismaCli = require.resolve('prisma/build/index.js');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      stdio: 'inherit',
      env: process.env
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        signal
          ? `Prisma migration failed with signal ${signal}`
          : `Prisma migration failed with exit code ${code || 1}`
      ));
    });
  });
  console.log('Prisma migration completed');
  process.env.DAKSH_MIGRATIONS_COMPLETED = 'true';
}

async function listenOnConfiguredPort(port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

function setNoStoreHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function setStaticAssetHeaders(res, filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  if (!ext || ext === '.html') {
    setNoStoreHeaders(res);
    return;
  }
  if (STATIC_CACHEABLE_EXTENSIONS.has(ext)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}

function scheduleDatabaseInitialization(delayMs = 0) {
  if (isDatabaseReady() || databaseStartupState.initializing) return;
  if (databaseInitTimer) clearTimeout(databaseInitTimer);
  const waitMs = Math.max(0, Number(delayMs) || 0);
  databaseInitTimer = setTimeout(() => {
    databaseInitTimer = null;
    initializeDatabaseInBackground().catch((error) => {
      console.error('Database background initialization crashed.');
      console.error(error.stack || error.message);
    });
  }, waitMs);
  if (typeof databaseInitTimer.unref === 'function') databaseInitTimer.unref();
}

async function initializeDatabaseInBackground() {
  if (isDatabaseReady()) return true;
  if (databaseStartupPromise) return databaseStartupPromise;

  databaseStartupState.initializing = true;
  applicationInitializationState.status = 'starting';
  applicationInitializationState.lastError = '';
  databaseStartupState.attempts += 1;
  databaseStartupState.status = databaseStartupState.attempts === 1 ? 'starting' : 'retrying';
  databaseStartupState.lastAttemptAt = new Date().toISOString();

  let retryDelayMs = 0;
  databaseStartupPromise = (async () => {
    try {
      await runPrismaMigrations();
      await connectDatabase();
      console.log('PostgreSQL connected successfully');
      await verifyApplicationSchema();
      await runPostgresStartupTasks();
      console.log('Database seed completed');
      databaseStartupState.status = 'connected';
      databaseStartupState.lastSuccessAt = new Date().toISOString();
      databaseStartupState.lastError = '';
      applicationInitializationState.status = 'ready';
      applicationInitializationState.initializedAt = new Date().toISOString();
      applicationInitializationState.lastError = '';
      return true;
    } catch (error) {
      databaseStartupState.status = 'retrying';
      databaseStartupState.lastError = error.message || String(error);
      applicationInitializationState.status = 'failed';
      applicationInitializationState.lastError = error.message || String(error);
      console.error(`PostgreSQL startup attempt ${databaseStartupState.attempts} failed: ${databaseStartupState.lastError}`);
      retryDelayMs = DATABASE_INIT_RETRY_MS;
      return false;
    } finally {
      databaseStartupState.initializing = false;
      databaseStartupPromise = null;
      if (retryDelayMs) scheduleDatabaseInitialization(retryDelayMs);
    }
  })();

  return databaseStartupPromise;
}

async function start() {
  const activePort = await listenOnConfiguredPort(PORT);
  app.locals.activePort = activePort;
  const portMarkerRoot = process.env.DAKSH_DATA_ROOT || __dirname;
  try {
    fs.mkdirSync(portMarkerRoot, { recursive: true });
    fs.writeFileSync(path.join(portMarkerRoot, 'server_port.txt'), String(activePort));
  } catch (error) {
    console.warn(`Could not write the server port marker: ${error.message}`);
  }
  startMobileDiscoveryServer(activePort);
  mdnsDiscoveryService.start();
  licenseService.startPeriodicRevalidation();

  let healthBroadcastTimer = null;
  const startHealthBroadcast = () => {
    if (healthBroadcastTimer) clearInterval(healthBroadcastTimer);
    healthBroadcastTimer = setInterval(() => {
      try {
        const dbStatus = currentDatabaseStatus();
        if (io && io.sockets && io.sockets.sockets.size > 0) {
          io.emit('database:health', {
            status: dbStatus === 'connected' ? 'online' : 'offline',
            databaseStatus: dbStatus === 'connected' ? 'online' : 'offline',
            db: dbStatus,
            timestamp: new Date().toISOString(),
            details: currentDatabasePayload()
          });
        }
      } catch (error) {
        console.warn('Health broadcast failed:', error.message);
      }
    }, 60000);
    if (typeof healthBroadcastTimer.unref === 'function') healthBroadcastTimer.unref();
  };
  startHealthBroadcast();
  if (!isDatabaseReady()) {
    console.warn('Server started before PostgreSQL was ready. /health is live, while API routes may return 503 until database startup completes.');
  }
  console.log(`Server started successfully on port ${activePort}`);
  const info = serverInfo(activePort);
  console.log(`PC app URL: ${info.serverUrl}`);
  console.log(`Mobile web URL for same WiFi/hotspot: ${info.mobileWebUrl || info.mobileScannerUrl}`);
  console.log(`Server identity: ${serverIdentity.get(activePort).serverId}`);
  scheduleDatabaseInitialization(0);
}

start().catch((error) => {
  console.error('Server bootstrap failed.');
  console.error(error.stack || error.message);
  process.exit(1);
});

async function shutdown(signal) {
  logger.info('DAKSH server shutting down', { signal });
  mdnsDiscoveryService.stop();
  if (mobileDiscoverySocket) {
    try { mobileDiscoverySocket.close(); } catch (_) {}
    mobileDiscoverySocket = null;
  }
  try { await prisma.$disconnect(); } catch (_) {}
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
