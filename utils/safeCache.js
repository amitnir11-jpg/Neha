const DEFAULT_CACHE_VERSION = process.env.SAFE_CACHE_VERSION || '2026-06-20-safe-cache-v1';
const DEFAULT_TTL_MS = Math.max(15_000, Number(process.env.SAFE_CACHE_TTL_MS || 120_000));
const MAX_CACHE_ENTRIES = Math.max(32, Number(process.env.SAFE_CACHE_MAX_ENTRIES || 256));

const cache = new Map();
const inFlight = new Map();
const versionCounters = new Map();

const NAMESPACE_DEFAULTS = {
  report: {
    ttlMs: Math.max(60_000, Number(process.env.REPORT_CACHE_TTL_MS || 300_000)),
    tags: ['report', 'scan', 'stock', 'master', 'catalogue', 'dealer', 'bin', 'price', 'audit'],
    ignoreKeys: ['page', 'limit', 'format', 'columns', 'fields', 'refresh', '_', 'cacheStatus', 'cacheVersion', 'dataVersion']
  },
  'report-download': {
    ttlMs: Math.max(60_000, Number(process.env.REPORT_DOWNLOAD_CACHE_TTL_MS || 300_000)),
    tags: ['report', 'scan', 'stock', 'master', 'catalogue', 'dealer', 'bin', 'price', 'audit'],
    ignoreKeys: ['refresh', '_', 'cacheStatus', 'cacheVersion', 'dataVersion']
  },
  search: {
    ttlMs: Math.max(30_000, Number(process.env.SEARCH_CACHE_TTL_MS || 120_000)),
    tags: ['search', 'master', 'catalogue', 'dealer', 'bin', 'price', 'audit'],
    ignoreKeys: ['refresh', '_', 'cacheStatus', 'cacheVersion', 'dataVersion']
  },
  dashboard: {
    ttlMs: Math.max(10_000, Number(process.env.DASHBOARD_CACHE_TTL_MS || 30_000)),
    tags: ['dashboard', 'scan', 'stock', 'master', 'catalogue', 'dealer', 'bin', 'price', 'audit'],
    ignoreKeys: ['refresh', '_', 'cacheStatus', 'cacheVersion', 'dataVersion']
  },
  lookup: {
    ttlMs: Math.max(60_000, Number(process.env.LOOKUP_CACHE_TTL_MS || 600_000)),
    tags: ['master', 'catalogue', 'price'],
    ignoreKeys: ['refresh', '_', 'cacheStatus', 'cacheVersion', 'dataVersion']
  },
  dealer: {
    ttlMs: Math.max(30_000, Number(process.env.DEALER_CACHE_TTL_MS || 60_000)),
    tags: ['dealer', 'master', 'bin', 'audit'],
    ignoreKeys: ['refresh', '_', 'cacheStatus', 'cacheVersion', 'dataVersion']
  },
  reconciliation: {
    ttlMs: Math.max(30_000, Number(process.env.RECONCILIATION_CACHE_TTL_MS || 300_000)),
    tags: ['reconciliation', 'stock', 'scan', 'master', 'catalogue', 'dealer', 'audit'],
    ignoreKeys: ['refresh', '_', 'cacheStatus', 'cacheVersion', 'dataVersion']
  },
  mobile: {
    ttlMs: Math.max(30_000, Number(process.env.MOBILE_CACHE_TTL_MS || 120_000)),
    tags: ['search', 'master', 'catalogue', 'dealer', 'bin', 'price', 'audit'],
    ignoreKeys: ['refresh', '_', 'cacheStatus', 'cacheVersion', 'dataVersion']
  }
};

function clean(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function normalizeDealerCode(value) {
  const text = clean(value);
  if (!text) return '';
  const match = text.match(/\(([^()]+)\)\s*$/);
  return upper(match ? match[1] : text);
}

function normalizeAuditId(value) {
  const text = clean(value);
  return text.toLowerCase() === 'active' ? '' : text;
}

function isPlainObject(value) {
  return Boolean(value) && Object.prototype.toString.call(value) === '[object Object]';
}

function normalizeValue(value) {
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item));
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value;
  if (isPlainObject(value)) {
    const result = {};
    Object.keys(value).sort((left, right) => left.localeCompare(right)).forEach((key) => {
      const item = value[key];
      if (item === undefined || item === null || item === '') return;
      result[key] = normalizeValue(item);
    });
    return result;
  }
  if (typeof value === 'string') return value.trim();
  return value;
}

function normalizeQuery(query = {}, options = {}) {
  const ignored = new Set([
    'cacheStatus',
    'cacheVersion',
    'dataVersion',
    'refresh',
    '_',
    ...[].concat(options.ignoreKeys || []).map((key) => String(key).trim()).filter(Boolean)
  ]);
  const entries = Object.entries(query || {})
    .filter(([key, value]) => !ignored.has(key) && value !== undefined && value !== null && value !== '')
    .sort(([left], [right]) => left.localeCompare(right));
  const normalized = {};
  entries.forEach(([key, value]) => {
    normalized[key] = normalizeValue(value);
  });
  return normalized;
}

function stringifyQuery(query = {}) {
  return JSON.stringify(normalizeValue(query));
}

function scopeFromQuery(query = {}, fallback = {}) {
  const dealerCode = normalizeDealerCode(
    query.dealerCode ||
    query.activeDealerId ||
    query.dealer ||
    fallback.dealerCode ||
    fallback.activeDealerId ||
    ''
  );
  const auditId = normalizeAuditId(
    query.auditId ||
    query.audit ||
    query.auditIdOn ||
    fallback.auditId ||
    fallback.audit ||
    ''
  );
  return { dealerCode, auditId };
}

function scopeKey(scope = {}) {
  const dealerCode = normalizeDealerCode(scope.dealerCode || scope.activeDealerId || '');
  const auditId = normalizeAuditId(scope.auditId || scope.audit || '');
  return `${dealerCode || 'GLOBAL'}|${auditId || 'ALL'}`;
}

function scopeVersionKeys(scope = {}) {
  const dealerCode = normalizeDealerCode(scope.dealerCode || scope.activeDealerId || '');
  const auditId = normalizeAuditId(scope.auditId || scope.audit || '');
  const keys = ['scope:global'];
  if (dealerCode) keys.push(`scope:dealer:${dealerCode}`);
  if (dealerCode && auditId) keys.push(`scope:audit:${dealerCode}|${auditId}`);
  return keys;
}

function currentCounter(key) {
  return Number(versionCounters.get(key) || 0);
}

function bumpCounter(key) {
  const next = currentCounter(key) + 1;
  versionCounters.set(key, next);
  return next;
}

function currentDataVersion(tags = [], scope = {}) {
  const uniqueTags = Array.from(new Set([].concat(tags || []).map((tag) => clean(tag)).filter(Boolean)));
  const parts = [`cache=${DEFAULT_CACHE_VERSION}`];
  scopeVersionKeys(scope).forEach((key) => {
    parts.push(`${key}=${currentCounter(key)}`);
  });
  uniqueTags.forEach((tag) => {
    parts.push(`tag:${tag}=${currentCounter(`tag:${tag}`)}`);
  });
  return parts.join('|');
}

function namespaceDefaults(namespace = '') {
  return NAMESPACE_DEFAULTS[namespace] || {
    ttlMs: DEFAULT_TTL_MS,
    tags: ['report', 'scan', 'master', 'catalogue', 'dealer', 'bin', 'price', 'audit'],
    ignoreKeys: ['refresh', '_', 'cacheStatus', 'cacheVersion', 'dataVersion']
  };
}

function cacheKey(namespace, query = {}, options = {}) {
  const defaults = namespaceDefaults(namespace);
  const normalizedQuery = normalizeQuery(query, {
    ignoreKeys: [...(defaults.ignoreKeys || []), ...(options.ignoreKeys || [])]
  });
  const scope = options.scope || scopeFromQuery(normalizedQuery, query);
  const tags = Array.from(new Set([
    ...(defaults.tags || []),
    ...[].concat(options.tags || []).map((tag) => clean(tag)).filter(Boolean)
  ]));
  const dataVersion = currentDataVersion(tags, scope);
  return {
    key: `${DEFAULT_CACHE_VERSION}|${namespace}|${scopeKey(scope)}|${dataVersion}|${stringifyQuery(normalizedQuery)}`,
    normalizedQuery,
    scope,
    tags,
    dataVersion
  };
}

function lruTouch(key, entry) {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
}

function entryMatches(entry, match = {}) {
  if (!entry) return false;
  const namespaces = [].concat(match.namespaces || []).map((item) => clean(item)).filter(Boolean);
  if (namespaces.length && !namespaces.includes(entry.namespace)) return false;
  const scope = match.scope || {};
  const dealerCode = normalizeDealerCode(scope.dealerCode || scope.activeDealerId || '');
  const auditId = normalizeAuditId(scope.auditId || scope.audit || '');
  if (dealerCode && entry.scope.dealerCode !== dealerCode) return false;
  if (auditId && entry.scope.auditId !== auditId) return false;
  const tags = [].concat(match.tags || []).map((tag) => clean(tag)).filter(Boolean);
  if (tags.length && !tags.some((tag) => (entry.tags || []).includes(tag))) return false;
  return true;
}

function clearCache(match = {}) {
  if (!match || (!match.namespaces && !match.scope && !match.tags)) {
    cache.clear();
    inFlight.clear();
    return;
  }
  for (const [key, entry] of cache.entries()) {
    if (entryMatches(entry, match)) cache.delete(key);
  }
  if (match.clearInFlight) {
    for (const [key, pending] of inFlight.entries()) {
      if (entryMatches(pending && pending.entryMeta, match)) inFlight.delete(key);
    }
  }
}

function invalidateCache(match = {}) {
  const tags = Array.from(new Set([].concat(match.tags || []).map((tag) => clean(tag)).filter(Boolean)));
  const scope = match.scope || {};
  const namespaces = [].concat(match.namespaces || []).map((item) => clean(item)).filter(Boolean);
  if (!tags.length && !scope.dealerCode && !scope.activeDealerId && !scope.auditId && !scope.audit && !namespaces.length) {
    bumpCounter('scope:global');
  }
  scopeVersionKeys(scope).forEach((key) => bumpCounter(key));
  tags.forEach((tag) => bumpCounter(`tag:${tag}`));
  clearCache({ namespaces, scope, tags });
  return currentDataVersion(tags, scope);
}

function applyCacheHeaders(res, meta = {}) {
  if (!res || typeof res.setHeader !== 'function') return res;
  res.setHeader('X-Cache-Status', meta.cacheStatus || (meta.cacheHit ? 'Generated from cache' : 'Fresh generated'));
  res.setHeader('X-Cache-Version', meta.cacheVersion || DEFAULT_CACHE_VERSION);
  if (meta.dataVersion) res.setHeader('X-Data-Version', meta.dataVersion);
  return res;
}

async function getCachedResponse(namespace, query, builder, options = {}) {
  const defaults = namespaceDefaults(namespace);
  const mergedOptions = {
    ttlMs: defaults.ttlMs,
    tags: defaults.tags,
    ignoreKeys: defaults.ignoreKeys,
    ...options
  };
  const prepared = cacheKey(namespace, query, mergedOptions);
  const ttlMs = Math.max(5_000, Number(mergedOptions.ttlMs || defaults.ttlMs || DEFAULT_TTL_MS));
  const existing = cache.get(prepared.key);
  const now = Date.now();
  if (existing && existing.expiresAt > now) {
    lruTouch(prepared.key, existing);
    return {
      data: existing.data,
      cacheHit: true,
      cacheStatus: 'Generated from cache',
      cacheVersion: DEFAULT_CACHE_VERSION,
      dataVersion: existing.dataVersion,
      scope: existing.scope,
      key: prepared.key
    };
  }

  if (inFlight.has(prepared.key)) return inFlight.get(prepared.key);

  async function buildOnce(dataVersion) {
    return Promise.resolve().then(() => builder(prepared.normalizedQuery, {
      namespace,
      scope: prepared.scope,
      cacheVersion: DEFAULT_CACHE_VERSION,
      dataVersion,
      cacheHit: false,
      cacheStatus: 'Fresh generated'
    }));
  }

  const pending = (async () => {
    const startVersion = prepared.dataVersion;
    const payload = await buildOnce(startVersion);
    const endVersion = currentDataVersion(prepared.tags, prepared.scope);
    if (endVersion !== startVersion) {
      const retryVersion = currentDataVersion(prepared.tags, prepared.scope);
      const retryPayload = await buildOnce(retryVersion);
      const retryEndVersion = currentDataVersion(prepared.tags, prepared.scope);
      if (retryEndVersion !== retryVersion) {
        return {
          data: retryPayload,
          cacheHit: false,
          cacheStatus: 'Fresh generated',
          cacheVersion: DEFAULT_CACHE_VERSION,
          dataVersion: retryEndVersion,
          scope: prepared.scope,
          key: prepared.key
        };
      }
      const retryEntry = {
        data: retryPayload,
        savedAt: now,
        expiresAt: now + ttlMs,
        namespace,
        scope: prepared.scope,
        tags: prepared.tags,
        dataVersion: retryVersion
      };
      if (retryPayload !== undefined) {
        cache.set(prepared.key, retryEntry);
        lruTouch(prepared.key, retryEntry);
      }
      return {
        data: retryPayload,
        cacheHit: false,
        cacheStatus: 'Fresh generated',
        cacheVersion: DEFAULT_CACHE_VERSION,
        dataVersion: retryVersion,
        scope: prepared.scope,
        key: prepared.key
      };
    }
    const entry = {
      data: payload,
      savedAt: now,
      expiresAt: now + ttlMs,
      namespace,
      scope: prepared.scope,
      tags: prepared.tags,
      dataVersion: startVersion
    };
    if (payload !== undefined) {
      cache.set(prepared.key, entry);
      lruTouch(prepared.key, entry);
    }
    return {
      data: payload,
      cacheHit: false,
      cacheStatus: 'Fresh generated',
      cacheVersion: DEFAULT_CACHE_VERSION,
      dataVersion: startVersion,
      scope: prepared.scope,
      key: prepared.key
    };
  })();

  inFlight.set(prepared.key, pending);
  try {
    return await pending;
  } finally {
    inFlight.delete(prepared.key);
  }
}

function cacheMeta(cacheHit = false, meta = {}) {
  return {
    cacheHit,
    cacheStatus: cacheHit ? 'Generated from cache' : 'Fresh generated',
    cacheVersion: meta.cacheVersion || DEFAULT_CACHE_VERSION,
    dataVersion: meta.dataVersion || '',
    generatedFromCache: cacheHit
  };
}

function addCacheMetadata(payload, meta = {}) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return payload;
  return {
    ...payload,
    ...cacheMeta(Boolean(meta.cacheHit), meta)
  };
}

module.exports = {
  CACHE_VERSION: DEFAULT_CACHE_VERSION,
  addCacheMetadata,
  applyCacheHeaders,
  cacheKey,
  cacheMeta,
  clearCache,
  currentDataVersion,
  getCachedResponse,
  invalidateCache,
  normalizeCacheQuery: normalizeQuery,
  scopeFromQuery,
  scopeKey
};
