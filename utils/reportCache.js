const {
  addCacheMetadata,
  applyCacheHeaders,
  clearCache,
  getCachedResponse,
  invalidateCache,
  normalizeCacheQuery,
  scopeFromQuery,
  currentDataVersion
} = require('./safeCache');

async function getCachedReport(namespace, query, builder, options = {}) {
  return getCachedResponse(namespace, query, builder, options);
}

function reportDataVersion(query = {}, options = {}) {
  const scope = options.scope || scopeFromQuery(query, options.fallback || {});
  return currentDataVersion(options.tags || [], scope);
}

function clearReportCache(match = {}) {
  clearCache(match);
}

module.exports = {
  addCacheMetadata,
  applyCacheHeaders,
  clearReportCache,
  currentDataVersion,
  getCachedReport,
  getCachedResponse,
  invalidateCache,
  normalizeCacheQuery,
  reportDataVersion,
  scopeFromQuery
};
