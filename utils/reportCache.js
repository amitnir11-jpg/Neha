const Inventory = require('../models/Inventory');
const DealerStock = require('../models/DealerStock');
const MasterCatalogue = require('../models/MasterCatalogue');
const MasterPart = require('../models/MasterPart');
const PartPriceHistory = require('../models/PartPriceHistory');
const Dealer = require('../models/Dealer');
const Audit = require('../models/Audit');

const MAX_CACHE_ENTRIES = Math.max(8, Number(process.env.REPORT_CACHE_MAX_ENTRIES || 32));
const cache = new Map();
const inFlight = new Map();

function clean(value) {
  return String(value || '').trim();
}

function dataQuery(query = {}) {
  const ignored = new Set(['page', 'limit', 'format', 'columns', 'fields', 'refresh', '_']);
  return Object.fromEntries(Object.entries(query)
    .filter(([key, value]) => !ignored.has(key) && value !== undefined && value !== null && value !== '')
    .sort(([left], [right]) => left.localeCompare(right)));
}

function scopeFilter(query = {}) {
  const filter = {};
  const dealerCode = clean(query.dealerCode || query.activeDealerId).toUpperCase();
  const auditId = clean(query.auditId || query.audit);
  if (dealerCode && dealerCode !== 'ALL') filter.dealerCode = dealerCode;
  if (auditId && auditId.toLowerCase() !== 'active') filter.auditId = auditId;
  return filter;
}

async function collectionVersion(Model, filter = {}, globalCount = false) {
  const [latest, count] = await Promise.all([
    Model.findOne(filter).sort({ updatedAt: -1, _id: -1 }).select('_id updatedAt').lean(),
    globalCount ? Model.estimatedDocumentCount() : Model.countDocuments(filter)
  ]);
  return `${count}:${latest ? `${latest._id}:${new Date(latest.updatedAt || 0).getTime()}` : 'empty'}`;
}

async function reportDataVersion(query = {}) {
  const scope = scopeFilter(query);
  const dealerScope = scope.dealerCode ? { dealerCode: scope.dealerCode } : {};
  const versions = await Promise.all([
    collectionVersion(Inventory, scope),
    collectionVersion(DealerStock, scope),
    collectionVersion(MasterCatalogue, {}, true),
    collectionVersion(MasterPart, {}, true),
    collectionVersion(PartPriceHistory, {}, true),
    collectionVersion(Dealer, dealerScope),
    collectionVersion(Audit, scope)
  ]);
  return versions.join('|');
}

function touch(key, entry) {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
}

async function getCachedReport(namespace, query, builder) {
  const forceRefresh = /^(1|true|yes|on)$/i.test(clean(query && query.refresh));
  const normalizedQuery = dataQuery(query);
  const key = `${namespace}:${JSON.stringify(normalizedQuery)}`;
  const version = await reportDataVersion(normalizedQuery);
  const existing = cache.get(key);
  if (!forceRefresh && existing && existing.version === version) {
    touch(key, existing);
    return { data: existing.data, cacheHit: true, version };
  }
  const pendingKey = `${key}:${version}`;
  if (inFlight.has(pendingKey)) {
    return { data: await inFlight.get(pendingKey), cacheHit: true, version };
  }
  const pending = Promise.resolve().then(() => builder(normalizedQuery));
  inFlight.set(pendingKey, pending);
  try {
    const data = await pending;
    touch(key, { data, version, savedAt: Date.now() });
    return { data, cacheHit: false, version };
  } finally {
    inFlight.delete(pendingKey);
  }
}

function clearReportCache() {
  cache.clear();
  inFlight.clear();
}

module.exports = {
  clearReportCache,
  dataQuery,
  getCachedReport,
  reportDataVersion
};
