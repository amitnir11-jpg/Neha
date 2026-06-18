const { PrismaClient, Prisma } = require('@prisma/client');

const databaseUrl = String(process.env.DATABASE_URL || '').trim();

const prisma = new PrismaClient({
  log: process.env.PRISMA_LOG_QUERIES === 'true' ? ['query', 'warn', 'error'] : ['warn', 'error']
});

let ready = false;
let lastError = '';
let connectedAt = null;

function hasDatabaseUrl() {
  return Boolean(databaseUrl);
}

function maskDatabaseUrl(url = databaseUrl) {
  return String(url || '').replace(/\/\/([^:@/?#]+):([^@/?#]+)@/, '//***:***@');
}

async function connectDatabase() {
  if (!hasDatabaseUrl()) {
    ready = false;
    lastError = 'DATABASE_URL is required for Railway PostgreSQL.';
    throw new Error(lastError);
  }
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
  }
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
    activeDatabaseUrl: maskDatabaseUrl(),
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
  maskDatabaseUrl
};
