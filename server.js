require('dotenv').config();

const dns = require('dns');
const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const express = require('express');
const mongoose = require('mongoose');
const { Server } = require('socket.io');

mongoose.set('bufferCommands', false);
mongoose.set('bufferTimeoutMS', 0);

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

const User = require('./models/User');
const Device = require('./models/Device');
const Inventory = require('./models/Inventory');
const SyncLog = require('./models/SyncLog');
const { serverInfo } = require('./utils/network');
const { getActiveAudit, publicAudit } = require('./utils/audit');
const syncRoutes = require('./routes/sync');
const ScannerManager = require('./services/ScannerManager');
const DeviceDiscoveryService = require('./services/DeviceDiscoveryService');
const SocketRealtimeService = require('./services/SocketRealtimeService');
const QRPairService = require('./services/QRPairService');
const OfflineSyncService = require('./services/OfflineSyncService');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
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

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const DEFAULT_MONGO_URI = 'mongodb://127.0.0.1:27017/daksh_inventory_v2';
const IS_PRODUCTION = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const MONGO_URI_ENV_NAMES = ['MONGO_URI', 'MONGODB_URI', 'MONGO_URL', 'DATABASE_URL'];
const configuredMongoUri = firstEnvValue(MONGO_URI_ENV_NAMES);
const MONGO_ALLOW_LOCAL_DEFAULT = String(process.env.MONGO_ALLOW_LOCAL_DEFAULT || (IS_PRODUCTION ? 'false' : 'true')).toLowerCase() === 'true';
const MONGO_URI = String(configuredMongoUri.value || (MONGO_ALLOW_LOCAL_DEFAULT ? DEFAULT_MONGO_URI : '')).trim();
const MONGO_URI_SOURCE = configuredMongoUri.name || (MONGO_URI ? 'local default' : '');
const MONGO_FALLBACK_URI = String(process.env.MONGO_FALLBACK_URI || (IS_PRODUCTION ? '' : DEFAULT_MONGO_URI)).trim();
const MONGO_AUTO_LOCAL_FALLBACK = String(process.env.MONGO_AUTO_LOCAL_FALLBACK || (IS_PRODUCTION ? 'false' : 'true')).toLowerCase() !== 'false';
const MONGO_AUTO_PROMOTE_TO_ATLAS = String(process.env.MONGO_AUTO_PROMOTE_TO_ATLAS || 'true').toLowerCase() !== 'false';
const MONGO_PRIMARY_RETRY_MS = envNumber('MONGO_PRIMARY_RETRY_MS', 30000);
const MONGO_CLOUD_SYNC_BATCH_SIZE = envNumber('MONGO_CLOUD_SYNC_BATCH_SIZE', 500);
const MONGO_DB_NAME = String(process.env.MONGO_DB_NAME || 'daksh_inventory_v2').trim();
const MOBILE_DISCOVERY_PORT = Number(process.env.MOBILE_DISCOVERY_PORT || PORT);
const MOBILE_DISCOVERY_REQUEST = 'DAKSH_DISCOVER_V1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const activePort = () => app.locals.activePort || PORT;
const scannerManager = new ScannerManager({ io, activeAuditProvider: getActiveAudit });
const deviceDiscoveryService = new DeviceDiscoveryService({ portProvider: activePort });
const socketRealtimeService = new SocketRealtimeService(io);
const qrPairService = new QRPairService({ portProvider: activePort });
const offlineSyncService = new OfflineSyncService();

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
app.set('trust proxy', 1);

let activeMongoUri = MONGO_URI;
let activeMongoLabel = 'primary';
const mongoCandidateStatus = {};
let atlasMonitorTimer = null;
let atlasPromotionRunning = false;
const cloudSyncState = {
  status: 'idle',
  pendingRecords: 0,
  lastStartedAt: '',
  lastSuccessAt: '',
  lastError: '',
  lastPromotionAt: '',
  collections: {}
};

const CLOUD_SYNC_COLLECTIONS = [
  { name: 'users', identity: ['username'] },
  { name: 'settings', identity: ['key'] },
  { name: 'dealers', identity: ['dealerCode'] },
  { name: 'audits', identity: ['auditId'] },
  { name: 'bins', identity: ['binCode', 'dealerCode'] },
  { name: 'mastercatalogues', identity: ['normalizedPartNumber'] },
  { name: 'masterparts', identity: ['partNo'] },
  { name: 'inventories', identity: ['scanId'] },
  { name: 'rejectedscans', identity: ['originalScanId'] },
  { name: 'duplicatescanlogs', identity: ['uniqueScanId'] },
  { name: 'verificationlogs' },
  { name: 'deletedscanlogs' },
  { name: 'auditlogs' },
  { name: 'synclogs' },
  { name: 'devices', identity: ['deviceId'] },
  { name: 'bluetoothdevices', identity: ['deviceId'] },
  { name: 'bluetoothscanlogs' },
  { name: 'scannerlogs' },
  { name: 'scannersessions', identity: ['sessionId'] },
  { name: 'bintransferhistories' },
  { name: 'binlabelprintlogs' },
  { name: 'dealerstocks' },
  { name: 'offlinequeues' }
];

mongoose.connection.on('error', (error) => {
  console.error(`MongoDB connection error: ${error.message}`);
});
mongoose.connection.on('disconnected', () => {
  console.warn('MongoDB disconnected. The driver will keep retrying in the background.');
  scheduleMongoReconnect(15000);
});
mongoose.connection.on('reconnected', () => {
  console.log(`MongoDB reconnected: ${mongoose.connection.name}`);
});

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function firstEnvValue(names) {
  for (const name of names) {
    const value = String(process.env[name] || '').trim();
    if (value) return { name, value };
  }
  return { name: '', value: '' };
}

function configureMongoDnsServers() {
  const servers = String(process.env.MONGO_DNS_SERVERS || '')
    .split(',')
    .map((server) => server.trim())
    .filter(Boolean);

  if (!servers.length) return;

  try {
    dns.setServers(servers);
    console.log(`MongoDB DNS servers: ${servers.join(', ')}`);
  } catch (error) {
    console.warn(`Invalid MONGO_DNS_SERVERS value: ${error.message}`);
  }
}

function maskMongoUri(uri) {
  return String(uri || '').replace(/\/\/([^:@/?#]+):([^@/?#]+)@/, '//***:***@');
}

function sameMongoUri(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

function isLocalMongoUri(uri) {
  return /^mongodb:\/\/(127\.0\.0\.1|localhost)(?::|\/|$)/i.test(String(uri || '').trim());
}

function isProductionLocalMongoBlocked(uri) {
  return IS_PRODUCTION && isLocalMongoUri(uri) && !MONGO_ALLOW_LOCAL_DEFAULT;
}

function mongoUriHasDatabaseName(uri) {
  try {
    const parsed = new URL(uri);
    return Boolean(parsed.pathname && parsed.pathname !== '/');
  } catch (error) {
    return /\/[^/?#]+(?:[?#].*)?$/.test(String(uri || '').replace(/^[a-z+]+:\/\/[^/]+/i, ''));
  }
}

function mongoConnectOptions(uri) {
  const options = {
    serverSelectionTimeoutMS: envNumber('MONGO_SERVER_SELECTION_TIMEOUT_MS', 15000),
    connectTimeoutMS: envNumber('MONGO_CONNECT_TIMEOUT_MS', 15000),
    socketTimeoutMS: envNumber('MONGO_SOCKET_TIMEOUT_MS', 45000),
    maxPoolSize: envNumber('MONGO_MAX_POOL_SIZE', 20)
  };

  if (MONGO_DB_NAME && !mongoUriHasDatabaseName(uri)) {
    options.dbName = MONGO_DB_NAME;
  }

  return options;
}

let mongoReconnectTimer = null;
let mongoConnecting = false;

function mongoConnectionCandidates() {
  const candidates = [];
  if (!MONGO_URI) return candidates;

  const primaryLabel = /^mongodb\+srv:\/\//i.test(MONGO_URI) ? 'Atlas primary' : 'primary';
  candidates.push({ label: primaryLabel, uri: MONGO_URI, source: MONGO_URI_SOURCE });
  if (MONGO_AUTO_LOCAL_FALLBACK && MONGO_FALLBACK_URI && !sameMongoUri(MONGO_FALLBACK_URI, MONGO_URI)) {
    candidates.push({ label: 'local fallback', uri: MONGO_FALLBACK_URI, source: 'MONGO_FALLBACK_URI' });
  }
  return candidates;
}

function mongoCandidateKey(candidate = {}) {
  if (/^mongodb\+srv:\/\//i.test(candidate.uri)) return 'atlas';
  if (/^mongodb:\/\/(127\.0\.0\.1|localhost)/i.test(candidate.uri)) return 'local';
  return String(candidate.label || 'primary').replace(/\s+/g, '_').toLowerCase();
}

function markMongoCandidate(candidate = {}, patch = {}) {
  const key = mongoCandidateKey(candidate);
  mongoCandidateStatus[key] = {
    key,
    label: candidate.label || key,
    uri: maskMongoUri(candidate.uri),
    rawUri: candidate.uri,
    checkedAt: new Date().toISOString(),
    ...patch
  };
  return mongoCandidateStatus[key];
}

function publicMongoCandidateStatus(key) {
  const status = mongoCandidateStatus[key] || {};
  return {
    connected: status.connected === true,
    status: status.status || 'not checked',
    message: status.message || '',
    uri: status.uri || '',
    checkedAt: status.checkedAt || ''
  };
}

function activeMongoKey() {
  return mongoCandidateKey({ label: activeMongoLabel, uri: activeMongoUri });
}

function mongoHealthDetails() {
  const activeConnected = mongoose.connection.readyState === 1;
  const activeKey = activeMongoKey();
  const atlas = publicMongoCandidateStatus('atlas');
  const local = publicMongoCandidateStatus('local');

  if (activeConnected && activeKey === 'atlas') {
    atlas.connected = true;
    atlas.status = 'connected';
    atlas.uri = maskMongoUri(activeMongoUri);
    atlas.message = '';
  }
  if (activeConnected && activeKey === 'local') {
    local.connected = true;
    local.status = 'connected';
    local.uri = maskMongoUri(activeMongoUri);
    local.message = '';
  }

  return {
    activeDatabase: activeMongoLabel,
    activeDatabaseUri: maskMongoUri(activeMongoUri),
    atlasConnected: atlas.connected,
    atlasStatus: atlas.status,
    atlasLastError: atlas.connected ? '' : atlas.message,
    atlasCheckedAt: atlas.checkedAt,
    localDbConnected: local.connected,
    localDbStatus: local.status,
    localDbLastError: local.connected ? '' : local.message,
    localDbCheckedAt: local.checkedAt,
    cloudSyncStatus: cloudSyncState.status,
    cloudSyncPendingRecords: cloudSyncState.pendingRecords,
    cloudSyncLastStartedAt: cloudSyncState.lastStartedAt,
    cloudSyncLastSuccessAt: cloudSyncState.lastSuccessAt,
    cloudSyncLastError: cloudSyncState.lastError,
    cloudSyncLastPromotionAt: cloudSyncState.lastPromotionAt
  };
}

function primaryMongoCandidate() {
  return mongoConnectionCandidates()[0];
}

function shouldMonitorPrimaryMongo() {
  const primary = primaryMongoCandidate();
  return Boolean(
    MONGO_AUTO_PROMOTE_TO_ATLAS &&
    MONGO_AUTO_LOCAL_FALLBACK &&
    primary &&
    mongoCandidateKey(primary) === 'atlas' &&
    !sameMongoUri(MONGO_URI, MONGO_FALLBACK_URI)
  );
}

function scheduleAtlasMonitor(delayMs = MONGO_PRIMARY_RETRY_MS) {
  if (!shouldMonitorPrimaryMongo() || atlasMonitorTimer) return;
  atlasMonitorTimer = setTimeout(() => {
    atlasMonitorTimer = null;
    monitorAtlasAndPromote().catch((error) => {
      cloudSyncState.status = 'failed';
      cloudSyncState.lastError = error.message;
      console.error(`Atlas monitor failed: ${error.message}`);
    }).finally(() => {
      scheduleAtlasMonitor(MONGO_PRIMARY_RETRY_MS);
    });
  }, delayMs);
  if (typeof atlasMonitorTimer.unref === 'function') atlasMonitorTimer.unref();
}

async function openMongoCandidateConnection(candidate) {
  configureMongoDnsServers();
  const connection = await mongoose.createConnection(candidate.uri, mongoConnectOptions(candidate.uri)).asPromise();
  markMongoCandidate(candidate, { connected: true, status: 'connected', message: '' });
  return connection;
}

function identityFilterForDoc(doc = {}, config = {}) {
  const fields = Array.isArray(config.identity) ? config.identity : [];
  const filter = {};
  for (const field of fields) {
    const value = doc[field];
    if (value === undefined || value === null || String(value).trim() === '') return { _id: doc._id };
    filter[field] = value;
  }
  return fields.length ? filter : { _id: doc._id };
}

function upsertOperationForDoc(doc = {}, config = {}) {
  const filter = identityFilterForDoc(doc, config);
  const setDoc = { ...doc };
  delete setDoc._id;
  return {
    updateOne: {
      filter,
      update: {
        $set: setDoc,
        $setOnInsert: { _id: doc._id }
      },
      upsert: true
    }
  };
}

async function flushCloudSyncBatch(targetCollection, operations) {
  if (!operations.length) return { upserted: 0, modified: 0, matched: 0, errors: 0 };
  try {
    const result = await targetCollection.bulkWrite(operations, { ordered: false });
    return {
      upserted: result.upsertedCount || 0,
      modified: result.modifiedCount || 0,
      matched: result.matchedCount || 0,
      errors: 0
    };
  } catch (error) {
    const writeErrors = error.writeErrors || error.result?.result?.writeErrors || [];
    return {
      upserted: error.result?.upsertedCount || error.result?.result?.nUpserted || 0,
      modified: error.result?.modifiedCount || error.result?.result?.nModified || 0,
      matched: error.result?.matchedCount || error.result?.result?.nMatched || 0,
      errors: writeErrors.length || 1,
      message: error.message
    };
  }
}

async function syncCollectionToAtlas(localDb, atlasDb, config) {
  const source = localDb.collection(config.name);
  const target = atlasDb.collection(config.name);
  const sourceCount = await source.countDocuments().catch(() => 0);
  let processed = 0;
  let upserted = 0;
  let modified = 0;
  let matched = 0;
  let errors = 0;
  const messages = [];
  const cursor = source.find({}).sort({ _id: 1 }).batchSize(MONGO_CLOUD_SYNC_BATCH_SIZE);
  let operations = [];

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    operations.push(upsertOperationForDoc(doc, config));
    processed += 1;
    if (operations.length >= MONGO_CLOUD_SYNC_BATCH_SIZE) {
      const result = await flushCloudSyncBatch(target, operations);
      upserted += result.upserted;
      modified += result.modified;
      matched += result.matched;
      errors += result.errors;
      if (result.message) messages.push(result.message);
      operations = [];
    }
  }

  if (operations.length) {
    const result = await flushCloudSyncBatch(target, operations);
    upserted += result.upserted;
    modified += result.modified;
    matched += result.matched;
    errors += result.errors;
    if (result.message) messages.push(result.message);
  }

  const targetCount = await target.countDocuments().catch(() => 0);
  return {
    sourceCount,
    targetCount,
    processed,
    upserted,
    modified,
    matched,
    errors,
    message: messages[0] || ''
  };
}

async function syncDatabasesToAtlas(localDb, atlasDb) {
  cloudSyncState.status = 'syncing';
  cloudSyncState.lastStartedAt = new Date().toISOString();
  cloudSyncState.lastError = '';
  cloudSyncState.collections = {};
  let totalErrors = 0;

  for (const config of CLOUD_SYNC_COLLECTIONS) {
    const summary = await syncCollectionToAtlas(localDb, atlasDb, config);
    cloudSyncState.collections[config.name] = summary;
    totalErrors += summary.errors || 0;
  }

  const inventorySummary = cloudSyncState.collections.inventories || {};
  cloudSyncState.pendingRecords = Math.max(0, Number(inventorySummary.sourceCount || 0) - Number(inventorySummary.targetCount || 0));
  cloudSyncState.status = totalErrors ? 'partial' : 'synced';
  cloudSyncState.lastSuccessAt = new Date().toISOString();
  if (totalErrors) cloudSyncState.lastError = `${totalErrors} cloud sync write error${totalErrors === 1 ? '' : 's'}`;
  return cloudSyncState;
}

async function syncLocalDatabaseToAtlas(atlasConnection) {
  if (!mongoose.connection.db || activeMongoKey() !== 'local') return cloudSyncState;
  return syncDatabasesToAtlas(mongoose.connection.db, atlasConnection.db);
}

async function localFallbackNeedsAtlasSync(localDb, atlasDb) {
  const [localInventoryCount, atlasInventoryCount, localCatalogueCount, atlasCatalogueCount, localLatest, atlasLatest] = await Promise.all([
    localDb.collection('inventories').countDocuments().catch(() => 0),
    atlasDb.collection('inventories').countDocuments().catch(() => 0),
    localDb.collection('mastercatalogues').countDocuments().catch(() => 0),
    atlasDb.collection('mastercatalogues').countDocuments().catch(() => 0),
    localDb.collection('inventories').findOne({}, { sort: { updatedAt: -1, createdAt: -1, timestamp: -1 }, projection: { updatedAt: 1, createdAt: 1, timestamp: 1 } }).catch(() => null),
    atlasDb.collection('inventories').findOne({}, { sort: { updatedAt: -1, createdAt: -1, timestamp: -1 }, projection: { updatedAt: 1, createdAt: 1, timestamp: 1 } }).catch(() => null)
  ]);
  const localLatestTime = localLatest ? new Date(localLatest.updatedAt || localLatest.createdAt || localLatest.timestamp || 0).getTime() : 0;
  const atlasLatestTime = atlasLatest ? new Date(atlasLatest.updatedAt || atlasLatest.createdAt || atlasLatest.timestamp || 0).getTime() : 0;
  cloudSyncState.pendingRecords = Math.max(0, localInventoryCount - atlasInventoryCount);
  return localInventoryCount > atlasInventoryCount ||
    localCatalogueCount > atlasCatalogueCount ||
    localLatestTime > atlasLatestTime;
}

async function syncConfiguredLocalFallbackToActiveAtlas() {
  if (!MONGO_AUTO_LOCAL_FALLBACK || activeMongoKey() !== 'atlas' || sameMongoUri(MONGO_URI, MONGO_FALLBACK_URI)) return;

  const localCandidate = { label: 'local fallback', uri: MONGO_FALLBACK_URI };
  let localConnection = null;
  try {
    localConnection = await openMongoCandidateConnection(localCandidate);
    const needsSync = await localFallbackNeedsAtlasSync(localConnection.db, mongoose.connection.db);
    if (needsSync) {
      console.log('Local fallback has data not present in Atlas. Syncing local data to Atlas.');
      await syncDatabasesToAtlas(localConnection.db, mongoose.connection.db);
    } else if (cloudSyncState.status !== 'atlas active') {
      cloudSyncState.status = 'atlas active';
      cloudSyncState.lastError = '';
    }
  } catch (error) {
    markMongoCandidate(localCandidate, { connected: false, status: 'failed', message: error.message });
    console.warn(`Local fallback availability check failed: ${error.message}`);
  } finally {
    if (localConnection) await localConnection.close().catch(() => undefined);
  }
}

async function promoteActiveConnectionToAtlas(candidate) {
  if (mongoConnecting) return;
  mongoConnecting = true;
  try {
    await mongoose.disconnect().catch(() => undefined);
    await connectMongoCandidate(candidate);
    await runMongoStartupTasks();
    cloudSyncState.status = 'atlas active';
    cloudSyncState.pendingRecords = 0;
    cloudSyncState.lastPromotionAt = new Date().toISOString();
    io.emit('database:status', mongoHealthDetails());
    io.emit('stats:update');
    console.log('MongoDB active connection promoted back to Atlas.');
  } catch (error) {
    markMongoCandidate(candidate, { connected: false, status: 'failed', message: error.message });
    console.error(`Atlas promotion failed: ${error.message}`);
    mongoConnecting = false;
    await connectMongoWithFallback().catch((fallbackError) => {
      console.error(`Fallback reconnect after failed promotion failed: ${fallbackError.message}`);
    });
    return;
  } finally {
    mongoConnecting = false;
  }
}

async function monitorAtlasAndPromote() {
  if (atlasPromotionRunning || mongoConnecting || !shouldMonitorPrimaryMongo()) return;
  const candidate = primaryMongoCandidate();
  if (!candidate || activeMongoKey() === 'atlas') {
    markMongoCandidate(candidate || { label: 'primary', uri: MONGO_URI }, {
      connected: mongoose.connection.readyState === 1,
      status: mongoose.connection.readyState === 1 ? 'connected' : 'not checked',
      message: ''
    });
    return;
  }

  atlasPromotionRunning = true;
  let atlasConnection = null;
  try {
    cloudSyncState.status = 'checking atlas';
    atlasConnection = await openMongoCandidateConnection(candidate);
    await syncLocalDatabaseToAtlas(atlasConnection);
    await atlasConnection.close().catch(() => undefined);
    atlasConnection = null;
    await promoteActiveConnectionToAtlas(candidate);
  } catch (error) {
    markMongoCandidate(candidate, { connected: false, status: 'failed', message: error.message });
    cloudSyncState.status = activeMongoKey() === 'local' ? 'queued locally' : 'failed';
    cloudSyncState.lastError = error.message;
    throw error;
  } finally {
    if (atlasConnection) await atlasConnection.close().catch(() => undefined);
    atlasPromotionRunning = false;
  }
}

async function connectMongoCandidate(candidate) {
  if (!candidate || !candidate.uri) {
    throw new Error(`Missing MongoDB connection string. Set one of ${MONGO_URI_ENV_NAMES.join(', ')} in Railway Variables.`);
  }
  if (isProductionLocalMongoBlocked(candidate.uri)) {
    throw new Error(`Refusing local MongoDB URI from ${candidate.source || 'configuration'} in production. Railway needs a hosted MongoDB URI, not 127.0.0.1.`);
  }
  configureMongoDnsServers();
  const source = candidate.source ? ` from ${candidate.source}` : '';
  console.log(`Connecting MongoDB (${candidate.label}${source}): ${maskMongoUri(candidate.uri)}`);
  await mongoose.connect(candidate.uri, mongoConnectOptions(candidate.uri));
  activeMongoUri = candidate.uri;
  activeMongoLabel = candidate.label;
  app.locals.mongoConnection = {
    label: activeMongoLabel,
    uri: maskMongoUri(activeMongoUri),
    dbName: mongoose.connection.name
  };
  markMongoCandidate(candidate, { connected: true, status: 'connected', message: '' });
  if (mongoCandidateKey(candidate) === 'atlas') {
    cloudSyncState.status = 'atlas active';
    cloudSyncState.pendingRecords = 0;
    cloudSyncState.lastError = '';
  } else if (mongoCandidateKey(candidate) === 'local') {
    cloudSyncState.status = 'queued locally';
  }
  console.log(`MongoDB connected (${candidate.label}): ${mongoose.connection.name}`);
  return candidate;
}

async function connectMongoWithFallback() {
  if (mongoConnecting) return null;
  mongoConnecting = true;
  let lastError = null;
  try {
    const candidates = mongoConnectionCandidates();
    if (!candidates.length) {
      throw new Error(`Missing MongoDB connection string. Set one of ${MONGO_URI_ENV_NAMES.join(', ')} in Railway Variables.`);
    }
    for (const candidate of candidates) {
      try {
        return await connectMongoCandidate(candidate);
      } catch (error) {
        lastError = error;
        lastError.mongoUri = candidate.uri;
        lastError.mongoLabel = candidate.label;
        markMongoCandidate(candidate, { connected: false, status: 'failed', message: error.message });
        console.error(`MongoDB ${candidate.label} connection failed: ${error.message}`);
        if (candidate.label === 'primary' && candidates.length > 1) {
          console.warn('Trying local MongoDB fallback so PC and mobile scans can continue.');
        }
        if (mongoose.connection.readyState !== 0) {
          await mongoose.disconnect().catch(() => undefined);
        }
      }
    }
    throw lastError || new Error('No MongoDB connection candidates configured');
  } finally {
    mongoConnecting = false;
  }
}

async function runMongoStartupTasks() {
  await fixInventoryIndexes();
  await fixUserIndexes();
  await normalizeDeviceTypes();
  await createDefaultAdmin();
}

function scheduleMongoReconnect(delayMs = 30000) {
  if (mongoReconnectTimer || mongoConnecting || mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) return;
  mongoReconnectTimer = setTimeout(async () => {
    mongoReconnectTimer = null;
    if (mongoConnecting || mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) return;
    try {
      await connectMongoWithFallback();
      await runMongoStartupTasks();
      scheduleAtlasMonitor(5000);
    } catch (error) {
      console.error(`MongoDB retry failed: ${error.message}`);
      scheduleMongoReconnect(delayMs);
    }
  }, delayMs);
}

function mongoConnectionHelp(error, uri = activeMongoUri || MONGO_URI) {
  if (!uri) {
    return [
      'MongoDB connection string is missing.',
      `Reason: ${error.message}`,
      'Fix:',
      `- In Railway Variables, add one of: ${MONGO_URI_ENV_NAMES.join(', ')}.`,
      '- Use a MongoDB Atlas mongodb+srv URI or Railway MongoDB private URI.',
      '- Do not use 127.0.0.1 or localhost for the Railway deployment.'
    ].join('\n');
  }
  const isAtlas = /^mongodb\+srv:\/\//i.test(uri);
  const hints = isAtlas
    ? [
        'Check MongoDB Atlas username/password in MONGO_URI.',
        'Add your server IP address in Atlas Network Access, or use 0.0.0.0/0 during testing.',
        'If the error mentions querySrv, set MONGO_DNS_SERVERS=8.8.8.8,1.1.1.1.',
        'Confirm the Atlas database user has readWrite permission.',
        'Keep MONGO_URI inside hosting environment variables, not in GitHub.'
      ]
    : [
        'Check that MongoDB Community Server service is running on this PC.',
        'Confirm local MongoDB is listening at 127.0.0.1:27017.',
        'For online hosting, replace MONGO_URI with a MongoDB Atlas mongodb+srv URI.'
      ];
  return [
    `MongoDB connection failed for ${maskMongoUri(uri)}.`,
    `Reason: ${error.message}`,
    'Fix:',
    ...hints.map((hint) => `- ${hint}`)
  ].join('\n');
}

let mobileDiscoverySocket = null;

function mobileDiscoveryPayload(activePort, remoteAddress = '') {
  const info = serverInfo(activePort, remoteAddress);
  return {
    success: true,
    app: 'daksh-inventory-v2',
    name: 'Daksh Inventory PC Server',
    status: 'online',
    serverStatus: 'online',
    mongoStatus: mongoose.connection.readyState === 1 ? 'online' : 'offline',
    db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    ...mongoHealthDetails(),
    discovery: 'udp',
    ip: info.ip,
    lanIp: info.ip,
    port: info.port,
    serverUrl: info.serverUrl,
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
    console.log(`Mobile auto-discovery listening on UDP ${MOBILE_DISCOVERY_PORT}`);
  });
}

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});
app.use((req, res, next) => {
  req.io = io;
  next();
});
app.use((req, res, next) => {
  if (req.path.startsWith('/api/mobile') || req.path.startsWith('/api/sync')) {
    const body = req.body || {};
    const scans = Array.isArray(body) ? body : Array.isArray(body.scans) ? body.scans : Array.isArray(body.records) ? body.records : [];
    console.log('[MOBILE API] request received', {
      method: req.method,
      url: req.originalUrl,
      ip: req.ip || req.socket.remoteAddress,
      deviceId: body.deviceId || (scans[0] && scans[0].deviceId) || '',
      scanCount: scans.length || (Object.keys(body).length ? 1 : 0),
      bodyKeys: Object.keys(body).slice(0, 20)
    });
  }
  next();
});
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api')) {
      console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - startedAt}ms`);
    }
  });
  next();
});

app.use((req, res, next) => {
  if (/\.(html|js|css)$/i.test(req.path) || req.path === '/' || req.path === '/dashboard' || req.path === '/report') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use(express.static(PUBLIC_DIR));

app.get(['/apk', '/download-apk', '/api/apk/download'], (req, res) => {
  const apkPath = path.join(PUBLIC_DIR, 'downloads', 'daksh-mobile-scanner.apk');
  res.download(apkPath, 'daksh-mobile-scanner.apk');
});

app.get('/force-login', (req, res) => {
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

app.get('/api/health', async (req, res) => {
  const activePort = req.app.locals.activePort || PORT;
  const info = serverInfo(activePort, req.ip || req.socket.remoteAddress);
  const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  const databaseDetails = mongoHealthDetails();
  const [connectedDevices, pending, failed, lastSyncDoc, lastSyncLog, lastSyncDevice] = await Promise.all([
    mongoose.connection.readyState === 1 ? Device.countDocuments({ status: 'online' }).catch(() => 0) : 0,
    mongoose.connection.readyState === 1 ? Inventory.countDocuments({ $or: [{ syncStatus: 'pending' }, { isSynced: false }] }).catch(() => 0) : 0,
    mongoose.connection.readyState === 1 ? Inventory.countDocuments({ syncStatus: 'failed' }).catch(() => 0) : 0,
    mongoose.connection.readyState === 1 ? Inventory.findOne({ $or: [{ syncStatus: 'synced' }, { isSynced: true }, { synced: true }] }).sort({ updatedAt: -1, timestamp: -1 }).select('updatedAt timestamp').lean().catch(() => null) : null,
    mongoose.connection.readyState === 1 ? SyncLog.findOne({ status: { $in: ['success', 'partial'] } }).sort({ updatedAt: -1, createdAt: -1 }).select('updatedAt createdAt').lean().catch(() => null) : null,
    mongoose.connection.readyState === 1 ? Device.findOne({ lastSyncTime: { $exists: true, $ne: null } }).sort({ lastSyncTime: -1 }).select('lastSyncTime').lean().catch(() => null) : null
  ]);
  const lastSyncTimes = [
    lastSyncLog && (lastSyncLog.updatedAt || lastSyncLog.createdAt),
    lastSyncDevice && lastSyncDevice.lastSyncTime,
    lastSyncDoc && (lastSyncDoc.updatedAt || lastSyncDoc.timestamp)
  ].map((value) => (value ? new Date(value) : null)).filter((date) => date && !Number.isNaN(date.getTime()));
  const lastSyncAt = lastSyncTimes.sort((a, b) => b.getTime() - a.getTime())[0] || null;
  const lastSync = lastSyncAt ? lastSyncAt.toISOString() : '';
  res.json({
    status: 'OK',
    message: 'Daksh Inventory Backend Running',
    success: true,
    server: 'online',
    mongodb: dbStatus === 'connected' ? 'online' : 'offline',
    serverStatus: 'online',
    mongoStatus: dbStatus === 'connected' ? 'online' : 'offline',
    ...databaseDetails,
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
    lanIp: info.ip,
    currentLanIp: info.ip,
    port: info.port,
    serverUrl: info.serverUrl,
    healthUrl: info.healthUrl,
    connectUrl: info.connectUrl,
    syncUrl: info.syncUrl
  });
});

app.get('/api/ping', (req, res) => {
  const info = serverInfo(req.app.locals.activePort || PORT, req.ip || req.socket.remoteAddress);
  res.json({
    success: true,
    status: 'online',
    message: 'pong',
    time: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    serverUrl: info.serverUrl
  });
});

app.get('/api/ready', (req, res) => {
  const mongoReady = mongoose.connection.readyState === 1;
  res.status(mongoReady ? 200 : 503).json({
    success: mongoReady,
    status: mongoReady ? 'ready' : 'not_ready',
    serverStatus: 'online',
    mongoStatus: mongoReady ? 'online' : 'offline',
    db: mongoReady ? 'connected' : 'disconnected',
    activeDatabase: activeMongoLabel,
    activeDatabaseUri: maskMongoUri(activeMongoUri),
    acceptedMongoEnvVars: MONGO_URI_ENV_NAMES,
    configuredMongoEnvVar: MONGO_URI_SOURCE,
    message: mongoReady
      ? 'Daksh is ready.'
      : `MongoDB is not connected. Set one of ${MONGO_URI_ENV_NAMES.join(', ')} to a hosted MongoDB URI in Railway.`
  });
});

app.get('/api/discovery', (req, res) => {
  const info = serverInfo(req.app.locals.activePort || PORT, req.ip || req.socket.remoteAddress);
  res.json({
    success: true,
    app: 'daksh-inventory-v2',
    name: 'Daksh Inventory PC Server',
    status: 'online',
    serverStatus: 'online',
    mongoStatus: mongoose.connection.readyState === 1 ? 'online' : 'offline',
    db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    ...mongoHealthDetails(),
    ip: info.ip,
    lanIp: info.ip,
    currentLanIp: info.ip,
    port: info.port,
    serverUrl: info.serverUrl,
    healthUrl: info.healthUrl,
    connectUrl: info.connectUrl,
    syncUrl: info.syncUrl
  });
});

app.use('/api', (req, res, next) => {
  if (mongoose.connection.readyState === 1) return next();
  return res.status(503).json({
    success: false,
    message: 'Database is offline. Check MongoDB Atlas Network Access or keep local MongoDB running.',
    serverStatus: 'online',
    mongoStatus: 'offline',
    db: 'disconnected',
    activeDatabase: activeMongoLabel,
    activeDatabaseUri: maskMongoUri(activeMongoUri),
    fallbackEnabled: MONGO_AUTO_LOCAL_FALLBACK
  });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/admin-delete', require('./routes/adminDelete'));
app.use('/api/users', require('./routes/users'));
app.use('/api/bin', require('./routes/bin'));
app.use('/api/bin-master', require('./routes/binMaster'));
app.use('/api/bin-transfer', require('./routes/binTransfer'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/scans', require('./routes/inventory'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/report-filter-settings', require('./routes/reportFilterSettings'));
app.use('/api/dealers', require('./routes/dealer'));
app.use('/api/devices', require('./routes/devices'));
app.use('/api/master', require('./routes/master'));
app.use('/api/master-parts', require('./routes/master'));
app.use('/api/master-catalogue', require('./routes/masterCatalogue'));
app.use('/api/backup', require('./routes/backup'));
app.use('/api/audit-backup', require('./routes/auditBackup'));
app.use('/api/reconciliation', require('./routes/reconciliation'));
app.use('/api/qr', require('./routes/qr'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/scanner-network', require('./routes/scannerNetwork'));
app.use('/api/sync', syncRoutes);
app.use('/api/mobile', require('./routes/mobile'));

app.get(['/', '/login'], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'Daksh.html'));
});

app.get('/report', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'report.html'));
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

io.on('connection', (socket) => {
  console.log('[SOCKET] connect', {
    socketId: socket.id,
    ip: socket.handshake.address ? socket.handshake.address.replace('::ffff:', '') : '',
    transport: socket.conn && socket.conn.transport ? socket.conn.transport.name : ''
  });
  socket.emit('server:ready', { app: 'Daksh Inventory v2', socketId: socket.id, recovered: socket.recovered });

  socket.on('device:hello', async (payload = {}) => {
    try {
      const deviceType = String(payload.deviceType || '').toLowerCase();
      const isBrowser = /dashboard browser|web scanner/i.test(String(payload.deviceName || ''));
      if (deviceType !== 'mobile' || isBrowser) {
        if (!isBrowser && deviceType && deviceType !== 'web') {
          const device = await scannerManager.register(payload, { socket });
          socket.data.deviceId = device.deviceId;
          socket.emit('audit:active', publicAudit(await getActiveAudit()));
          return;
        }
        socket.data.deviceId = '';
        socket.emit('audit:active', publicAudit(await getActiveAudit()));
        return;
      }
      const deviceId = String(payload.deviceId || socket.id).trim();
      const activeAudit = await getActiveAudit();
      socket.data.deviceId = deviceId;
      console.log('[SOCKET] device:hello', { socketId: socket.id, deviceId, deviceType, activeAudit: Boolean(activeAudit) });
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
      const activeAudit = await getActiveAudit();
      socket.data.deviceId = deviceId;
      console.log('[SOCKET] device:heartbeat', { socketId: socket.id, deviceId, pendingCount: payload.pendingCount || 0, syncStatus: payload.syncStatus || '' });
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
      console.log('[SOCKET] scanData received', {
        socketId: socket.id,
        deviceId,
        partNumber: payload.partNumber || payload.partNo || payload.part || '',
        scanId: payload.scanId || payload.uniqueScanId || payload.mobileScanId || payload.localId || ''
      });
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
      console.log('[SOCKET] syncData received', { socketId: socket.id, deviceId, count: records.length });
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
    console.log('[SOCKET] disconnect', { socketId: socket.id, deviceId: socket.data.deviceId || '' });
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
  const existingAdmin = await User.findOne({ username: 'admin' });
  if (existingAdmin) {
    const update = {};
    const defaultEmail = process.env.REPORT_EMAIL || 'amitsvision4u@gmail.com';
    if (existingAdmin.approved === false || existingAdmin.approved === undefined) update.approved = true;
    if (existingAdmin.active === false || existingAdmin.active === undefined) update.active = true;
    if (existingAdmin.isActive === false || existingAdmin.isActive === undefined) update.isActive = true;
    if (!existingAdmin.passwordHash && !existingAdmin.password) {
      const passwordHash = await bcrypt.hash('admin', 10);
      update.passwordHash = passwordHash;
      update.password = passwordHash;
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

  const passwordHash = await bcrypt.hash('admin', 10);
  await User.create({
    username: 'admin',
    email: process.env.REPORT_EMAIL || 'amitsvision4u@gmail.com',
    passwordHash,
    password: passwordHash,
    role: 'admin',
    name: 'Administrator',
    approved: true,
    approvedBy: 'system',
    approvedAt: new Date(),
    active: true,
    isActive: true
  });

  console.log('Default admin created: admin / admin');
}

async function fixInventoryIndexes() {
  try {
    const collection = mongoose.connection.db.collection('inventories');
    const cleanupResult = await Inventory.deleteMany({
      $or: [
        { scanId: { $exists: false } },
        { scanId: null },
        { scanId: '' },
        { uniqueScanId: { $exists: false } },
        { uniqueScanId: null },
        { uniqueScanId: '' },
        {
          $and: [
            { $or: [{ part: { $exists: false } }, { part: null }, { part: '' }] },
            { $or: [{ partNumber: { $exists: false } }, { partNumber: null }, { partNumber: '' }] }
          ]
        }
      ]
    });
    if (cleanupResult.deletedCount) {
      console.log(`Cleaned invalid inventory records: ${cleanupResult.deletedCount}`);
    }

    const indexes = await collection.indexes();
    for (const index of indexes) {
      const isOldSyncUnique = index.name === 'syncKey_1' && index.unique;
      const isOldUpiUnique = index.name === 'upiId_1_dealerCode_1' && index.unique;
      const isOldRawUpiUnique = index.name === 'unique_accepted_raw_upi' || (index.unique && index.key && index.key.rawUpi === 1 && !index.key.dealerCode);
      const isNonUniqueScanId = index.name === 'scanId_1' && !index.unique;
      if (isOldSyncUnique || isOldUpiUnique || isOldRawUpiUnique || isNonUniqueScanId) {
        await collection.dropIndex(index.name);
        console.log(`Dropped old duplicate-blocking inventory index: ${index.name}`);
      }
    }
    await collection.createIndex(
      { scanId: 1 },
      {
        name: 'scanId_1',
        unique: true,
        partialFilterExpression: { scanId: { $type: 'string', $gt: '' } }
      }
    );
    await collection.createIndex({ uniqueScanId: 1 }, { name: 'uniqueScanId_1', unique: true });
    await collection.createIndex(
      { qrFingerprint: 1 },
      {
        name: 'qrFingerprint_1',
        unique: true,
        partialFilterExpression: { qrFingerprint: { $type: 'string', $gt: '' } }
      }
    );
    await collection.createIndex(
      { rawUpi: 1, dealerCode: 1, auditId: 1 },
      {
        name: 'unique_accepted_raw_upi_by_audit',
        unique: true,
        partialFilterExpression: {
          rawUpi: { $type: 'string', $gt: '' },
          scanStatus: { $in: ['ACCEPTED', 'SUPERVISOR_APPROVED'] },
          scanType: { $in: ['AUDIT', 'INWARD', 'VERIFICATION', 'FITTED', 'DAMAGE'] }
        }
      }
    );
  } catch (error) {
    console.warn('Inventory index cleanup skipped:', error.message);
  }
}

async function fixUserIndexes() {
  try {
    const collection = mongoose.connection.db.collection('users');
    const indexes = await collection.indexes();
    for (const index of indexes) {
      const isUniqueEmailIndex = index.unique && index.key && Object.keys(index.key).length === 1 && index.key.email === 1;
      if (isUniqueEmailIndex) {
        await collection.dropIndex(index.name);
        console.log(`Dropped old duplicate-blocking user email index: ${index.name}`);
      }
    }
    await collection.createIndex({ username: 1 }, { name: 'username_1', unique: true, sparse: true });
    await collection.createIndex({ email: 1 }, { name: 'email_1', sparse: true });
  } catch (error) {
    console.warn('User index cleanup skipped:', error.message);
  }
}

async function normalizeDeviceTypes() {
  try {
    await Device.updateMany(
      {
        $or: [
          { deviceName: /Dashboard Browser/i },
          { deviceName: /Web Scanner/i },
          { appVersion: 'web-dashboard' },
          { ipAddress: { $in: ['127.0.0.1', '::1'] } }
        ]
      },
      {
        $set: {
          deviceType: 'web',
          status: 'offline',
          disconnectedAt: new Date(),
          disconnectedBy: 'browser-hidden'
        }
      }
    );
    await Device.updateMany(
      {
        $and: [
          { $or: [{ deviceType: { $exists: false } }, { deviceType: 'unknown' }, { deviceType: '' }] },
          { deviceName: { $not: /Dashboard Browser|Web Scanner/i } }
        ]
      },
      { $set: { deviceType: 'mobile', approved: true } }
    );
  } catch (error) {
    console.warn('Device type normalization skipped:', error.message);
  }
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

async function start() {
  let mongoConnected = false;
  try {
    await connectMongoWithFallback();
    mongoConnected = true;
    await runMongoStartupTasks();
  } catch (error) {
    console.error('MongoDB startup is offline. Daksh HTTP server will still start.');
    console.error(mongoConnectionHelp(error, error.mongoUri || activeMongoUri || MONGO_URI));
    scheduleMongoReconnect(30000);
  }

  try {
    const activePort = await listenOnConfiguredPort(PORT);
    app.locals.activePort = activePort;
    fs.writeFileSync(path.join(__dirname, 'server_port.txt'), String(activePort));
    startMobileDiscoveryServer(activePort);

    const info = serverInfo(activePort);
    console.log(`Server running on port ${PORT}`);
    console.log(`Daksh running on port ${activePort}`);
    console.log(`Daksh backend running on http://${HOST}:${activePort}`);
    console.log('Daksh Inventory v2 is running');
    console.log(`Daksh server running on port ${activePort}`);
    console.log(`Listening host: ${HOST}`);
    console.log(`Local development URL: http://localhost:${activePort}`);
    console.log(`Public API URL: ${info.serverUrl}`);
    console.log(`Mobile scanner cloud URL: ${info.serverUrl}`);
    if (!mongoConnected) {
      console.warn('Daksh is running with MongoDB offline. Health will show mongoStatus=offline until Atlas allows this IP.');
    }
    if (mongoConnected) {
      setTimeout(() => {
        syncConfiguredLocalFallbackToActiveAtlas()
          .catch((error) => {
            cloudSyncState.status = activeMongoKey() === 'local' ? 'queued locally' : 'failed';
            cloudSyncState.lastError = error.message;
            console.error(`Background local-to-Atlas sync failed: ${error.message}`);
          });
      }, 2000);
    }
    scheduleAtlasMonitor(5000);
  } catch (error) {
    console.error('Failed to start Daksh Inventory v2');
    console.error(error.stack || error.message);
    process.exit(1);
  }
}

start();
