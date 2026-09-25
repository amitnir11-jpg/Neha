const { PrismaClient, Prisma } = require('@prisma/client');
const { AsyncLocalStorage } = require('async_hooks');
const {
  acceptedDatabaseEnvVars,
  applyResolvedDatabaseUrl,
  maskDatabaseUrl
} = require('../utils/postgresEnv');

let resolvedDatabaseUrl = applyResolvedDatabaseUrl();

const prisma = new PrismaClient({
  log: process.env.PRISMA_LOG_QUERIES === 'true' ? ['query', 'warn', 'error'] : ['warn', 'error']
});

// A transaction client follows adapter calls across awaits without changing the
// public Prisma client used by existing direct-query services.
const transactionContext = new AsyncLocalStorage();

function getPrismaClient() {
  return transactionContext.getStore() || prisma;
}

function inDatabaseTransaction() {
  return Boolean(transactionContext.getStore());
}

async function withDatabaseTransaction(work, options = {}) {
  if (inDatabaseTransaction()) return work(getPrismaClient());
  const attempts = options.attempts || 5;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await prisma.$transaction(
        (client) => transactionContext.run(client, () => work(client)),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10000, timeout: options.timeout || 30000 }
      );
    } catch (error) {
      // Retry the entire read/modify/write against a fresh serializable snapshot.
      // The callback must contain database work only, never external side effects.
      if (error.code !== 'P2034' || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
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
  connectDatabase,
  disconnectDatabase,
  isDatabaseReady,
  databaseHealthDetails,
  databaseUrlSource,
  acceptedDatabaseEnvVars,
  maskDatabaseUrl
};
