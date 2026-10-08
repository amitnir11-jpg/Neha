const { PrismaClient, Prisma } = require('@prisma/client');
const { AsyncLocalStorage } = require('async_hooks');
const {
  acceptedDatabaseEnvVars,
  applyResolvedDatabaseUrl,
  maskDatabaseUrl
} = require('../utils/postgresEnv');

let resolvedDatabaseUrl = applyResolvedDatabaseUrl();

const slowQueryThresholdMs = Number(process.env.PRISMA_SLOW_QUERY_MS || 0);
const prismaLogLevels = process.env.PRISMA_LOG_QUERIES === 'true'
  ? ['query', 'warn', 'error']
  : ['warn', 'error'];
if (Number.isFinite(slowQueryThresholdMs) && slowQueryThresholdMs > 0) {
  prismaLogLevels.push({ emit: 'event', level: 'query' });
}

const prisma = new PrismaClient({
  log: prismaLogLevels
});

if (Number.isFinite(slowQueryThresholdMs) && slowQueryThresholdMs > 0) {
  prisma.$on('query', (event) => {
    if (event.duration < slowQueryThresholdMs) return;
    const query = String(event.query || '')
      .replace(/'(?:''|[^'])*'/g, "'?'")
      .slice(0, 1500);
    console.warn('[SLOW QUERY]', JSON.stringify({
      durationMs: event.duration,
      thresholdMs: slowQueryThresholdMs,
      target: event.target,
      query
    }));
  });
}

// A transaction client follows adapter calls across awaits without changing the
// public Prisma client used by existing direct-query services.
const transactionContext = new AsyncLocalStorage();

function getPrismaClient() {
  return transactionContext.getStore()?.client || prisma;
}

function inDatabaseTransaction() {
  return Boolean(transactionContext.getStore());
}

async function withDatabaseTransaction(work, options = {}) {
  if (inDatabaseTransaction()) return work(getPrismaClient());
  const attempts = options.attempts || 5;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const afterCommit = [];
    try {
      const result = await prisma.$transaction(
        (client) => transactionContext.run({ client, afterCommit }, () => work(client)),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10000, timeout: options.timeout || 30000 }
      );
      for (const callback of afterCommit) {
        try { await callback(); } catch (error) { console.error('Post-commit callback failed:', error); }
      }
      return result;
    } catch (error) {
      // Retry the entire read/modify/write against a fresh serializable snapshot.
      // The callback must contain database work only, never external side effects.
      if (error.code !== 'P2034' || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

function afterDatabaseCommit(callback) {
  if (typeof callback !== 'function') return;
  const context = transactionContext.getStore();
  if (context) context.afterCommit.push(callback);
  else return callback();
}

let ready = false;
let lastError = '';
let connectedAt = null;
let connectPromise = null;

function hasDatabaseUrl() {
  resolvedDatabaseUrl = applyResolvedDatabaseUrl();
  return Boolean(resolvedDatabaseUrl.url);
}

function databaseUrlSource() {
  resolvedDatabaseUrl = applyResolvedDatabaseUrl();
  return resolvedDatabaseUrl.source;
}

async function connectDatabase() {
  if (ready) return true;
  if (connectPromise) return connectPromise;
  if (!hasDatabaseUrl()) {
    ready = false;
    lastError = `PostgreSQL connection is not configured. Set one of: ${acceptedDatabaseEnvVars().join(', ')}.`;
    throw new Error(lastError);
  }
  connectPromise = (async () => {
    try {
      await prisma.$connect();
      await prisma.$queryRaw`SELECT 1`;
      ready = true;
      lastError = '';
      connectedAt = new Date();
      return true;
    } catch (error) {
      ready = false;
      lastError = error.message || String(error);
      throw error;
    } finally {
      connectPromise = null;
    }
  })();
  return connectPromise;
}

async function disconnectDatabase() {
  ready = false;
  await prisma.$disconnect();
}

function markDatabaseUnavailable(error) {
  ready = false;
  lastError = error.message || String(error);
}

function isDatabaseReady() {
  return ready;
}

function databaseHealthDetails() {
  const mode = String(process.env.CONNECTION_MODE || process.env.DAKSH_CONNECTION_MODE || '').trim().toUpperCase();
  return {
    activeDatabase: mode === 'LOCAL' ? 'local-postgresql' : 'railway-postgresql',
    activeDatabaseUrl: maskDatabaseUrl(resolvedDatabaseUrl.url),
    configuredDatabaseEnvVar: databaseUrlSource(),
    databaseProvider: 'postgresql',
    databaseConnectedAt: connectedAt ? connectedAt.toISOString() : '',
    databaseLastError: lastError
  };
}

module.exports = {
  Prisma,
  prisma,
  getPrismaClient,
  inDatabaseTransaction,
  withDatabaseTransaction,
  afterDatabaseCommit,
  connectDatabase,
  disconnectDatabase,
  markDatabaseUnavailable,
  isDatabaseReady,
  databaseHealthDetails,
  databaseUrlSource,
  acceptedDatabaseEnvVars,
  maskDatabaseUrl
};
