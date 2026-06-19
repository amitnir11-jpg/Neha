const { PrismaClient, Prisma } = require('@prisma/client');
const {
  acceptedDatabaseEnvVars,
  applyResolvedDatabaseUrl,
  maskDatabaseUrl
} = require('../utils/postgresEnv');

let resolvedDatabaseUrl = applyResolvedDatabaseUrl();

const prisma = new PrismaClient({
  log: process.env.PRISMA_LOG_QUERIES === 'true' ? ['query', 'warn', 'error'] : ['warn', 'error']
});

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
  return {
    activeDatabase: 'railway-postgresql',
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
  connectDatabase,
  disconnectDatabase,
  isDatabaseReady,
  databaseHealthDetails,
  databaseUrlSource,
  acceptedDatabaseEnvVars,
  maskDatabaseUrl
};
