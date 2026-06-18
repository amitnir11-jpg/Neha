const DATABASE_URL_ENV_KEYS = [
  'DATABASE_URL',
  'DATABASE_PRIVATE_URL',
  'DATABASE_PUBLIC_URL',
  'POSTGRES_URL',
  'POSTGRES_PRISMA_URL',
  'POSTGRES_URL_NON_POOLING',
  'PGDATABASE_URL',
  'RAILWAY_DATABASE_URL'
];

const PG_COMPONENT_KEYS = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'];

function clean(value) {
  return String(value || '').trim();
}

function encodePart(value) {
  return encodeURIComponent(clean(value));
}

function formatHost(host) {
  const text = clean(host);
  if (!text) return '';
  return text.includes(':') && !text.startsWith('[') ? `[${text}]` : text;
}

function appendSslMode(url, env = process.env) {
  const sslMode = clean(env.PGSSLMODE || env.POSTGRES_SSLMODE);
  if (!sslMode) return url;
  const joiner = url.includes('?') ? '&' : '?';
  return `${url}${joiner}sslmode=${encodeURIComponent(sslMode)}`;
}

function buildDatabaseUrlFromPgVars(env = process.env) {
  const host = clean(env.PGHOST);
  const port = clean(env.PGPORT || 5432);
  const user = clean(env.PGUSER);
  const password = clean(env.PGPASSWORD);
  const database = clean(env.PGDATABASE);
  if (!host || !user || !password || !database) return null;
  const url = `postgresql://${encodePart(user)}:${encodePart(password)}@${formatHost(host)}:${encodePart(port)}/${encodePart(database)}`;
  return {
    url: appendSslMode(url, env),
    source: PG_COMPONENT_KEYS.filter((key) => clean(env[key])).join('+')
  };
}

function resolveDatabaseUrl(env = process.env) {
  for (const key of DATABASE_URL_ENV_KEYS) {
    const value = clean(env[key]);
    if (value) return { url: value, source: key };
  }
  return buildDatabaseUrlFromPgVars(env) || { url: '', source: '' };
}

function acceptedDatabaseEnvVars() {
  return DATABASE_URL_ENV_KEYS.concat([PG_COMPONENT_KEYS.join('+')]);
}

function applyResolvedDatabaseUrl(env = process.env) {
  const resolved = resolveDatabaseUrl(env);
  if (resolved.url && clean(env.DATABASE_URL) !== resolved.url) env.DATABASE_URL = resolved.url;
  return resolved;
}

function maskDatabaseUrl(url = '') {
  return clean(url).replace(/\/\/([^:@/?#]+):([^@/?#]+)@/, '//***:***@');
}

module.exports = {
  DATABASE_URL_ENV_KEYS,
  PG_COMPONENT_KEYS,
  acceptedDatabaseEnvVars,
  applyResolvedDatabaseUrl,
  buildDatabaseUrlFromPgVars,
  maskDatabaseUrl,
  resolveDatabaseUrl
};
