const { spawn, spawnSync } = require('child_process');
const path = require('path');
const {
  acceptedDatabaseEnvVars,
  applyResolvedDatabaseUrl,
  maskDatabaseUrl
} = require('../utils/postgresEnv');

const role = String(process.env.DAKSH_SERVICE_ROLE || process.env.SERVICE_ROLE || 'api').trim().toLowerCase();
const entry = role === 'web' ? 'web-server.js' : 'server.js';
const entryPath = role === 'web' ? path.join(__dirname, entry) : path.join(__dirname, '..', entry);
const resolvedDatabase = applyResolvedDatabaseUrl();

function runApiMigrations() {
  if (role !== 'api') return;
  if (String(process.env.DAKSH_SKIP_MIGRATIONS || '').toLowerCase() === 'true') {
    console.log('Skipping Prisma migrations because DAKSH_SKIP_MIGRATIONS=true.');
    return;
  }
  if (!resolvedDatabase.url) {
    console.warn(`Skipping Prisma migrations: PostgreSQL URL is missing. Set one of: ${acceptedDatabaseEnvVars().join(', ')}.`);
    return;
  }
  console.log(`Running Prisma migrations using ${resolvedDatabase.source}: ${maskDatabaseUrl(resolvedDatabase.url)}`);
  const prismaCli = require.resolve('prisma/build/index.js');
  const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: process.env
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

runApiMigrations();

const child = spawn(process.execPath, [entryPath], {
  stdio: 'inherit',
  env: process.env
});

function forward(signal) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

forward('SIGINT');
forward('SIGTERM');

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code || 0);
});
