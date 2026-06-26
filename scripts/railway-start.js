const { spawnSync } = require('child_process');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  acceptedDatabaseEnvVars,
  applyResolvedDatabaseUrl,
  maskDatabaseUrl
} = require('../utils/postgresEnv');

const role = String(process.env.DAKSH_SERVICE_ROLE || process.env.SERVICE_ROLE || 'api').trim().toLowerCase();
const entry = role === 'web' ? 'web-server.js' : 'server.js';
const entryPath = role === 'web' ? path.join(__dirname, entry) : path.join(__dirname, '..', entry);
const IS_PRODUCTION = String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
const IS_RAILWAY = Boolean(process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_ENVIRONMENT_NAME);
const IS_RENDER = Boolean(process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL || process.env.RENDER_EXTERNAL_HOSTNAME);
const ALLOW_LOCAL_FALLBACK = !IS_PRODUCTION && !IS_RAILWAY && !IS_RENDER;
const SKIP_MIGRATIONS = String(process.env.DAKSH_SKIP_MIGRATIONS || '').trim().toLowerCase() === 'true';
const PRESTART_MIGRATIONS_SETTING = String(process.env.DAKSH_PRESTART_MIGRATIONS || '').trim().toLowerCase();
const PRESTART_MIGRATIONS = PRESTART_MIGRATIONS_SETTING
  ? ['1', 'true', 'yes', 'on'].includes(PRESTART_MIGRATIONS_SETTING)
  : role === 'api' && !ALLOW_LOCAL_FALLBACK;

function runApiMigrations() {
  if (role !== 'api') return;
  const currentDatabase = applyResolvedDatabaseUrl();
  if (!currentDatabase.url) {
    const message = `PostgreSQL URL is missing. Set one of: ${acceptedDatabaseEnvVars().join(', ')}.`;
    if (ALLOW_LOCAL_FALLBACK) {
      console.warn(`${message} Starting local fallback mode without Prisma migrations.`);
      return;
    }
    console.error(message);
    process.exit(1);
  }
  if (SKIP_MIGRATIONS) {
    console.log('Skipping Prisma migrations because DAKSH_SKIP_MIGRATIONS=true');
    process.env.DAKSH_MIGRATIONS_COMPLETED = 'true';
    return;
  }
  console.log(`Running Prisma migrations using ${currentDatabase.source}: ${maskDatabaseUrl(currentDatabase.url)}`);
  const prismaCli = require.resolve('prisma/build/index.js');
  const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: process.env
  });
  if (result.status !== 0) {
    if (ALLOW_LOCAL_FALLBACK) {
      console.warn(`Prisma migration failed locally with exit code ${result.status || 1}; continuing in fallback mode.`);
      return;
    }
    process.exit(result.status || 1);
  }
  process.env.DAKSH_MIGRATIONS_COMPLETED = 'true';
  console.log('Prisma migration completed');
}

if (PRESTART_MIGRATIONS) {
  runApiMigrations();
} else if (role === 'api') {
  console.log('Skipping pre-start Prisma migrations; server.js will initialize PostgreSQL in background.');
}

require(entryPath);
