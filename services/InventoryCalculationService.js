const Inventory = require('../models/Inventory');
const Audit = require('../models/Audit');
const Dealer = require('../models/Dealer');
const { getActiveAudit, auditWorkflowStatus } = require('../utils/audit');
const { normalizePartNumber } = require('../utils/normalize');
const { uniqueReportScans } = require('../utils/reportScanIdentity');
const { stockQuantitySummary, stockMovementType, stockUnitQuantity, activeStockTransaction } = require('../utils/stockQuantity');
const { applyInventoryLedgerFilter } = require('../utils/inventoryLedgerFilter');
const { getPricesFromPartMaster } = require('../utils/partMasterPrice');
const { invalidateCache } = require('../utils/safeCache');

const clean = value => String(value ?? '').trim();
function dealerCodeValue(value) {
  const text = clean(value).toUpperCase();
  const parenthesized = text.match(/\(([^()]+)\)\s*$/);
  return parenthesized ? parenthesized[1] : text.split(/\s+-\s+/)[0];
}

async function resolveCurrentAudit(dealerInput, options = {}) {
  let dealerCode = dealerCodeValue(dealerInput);
  if (options.dealerId && !dealerCode) {
    const dealer = await Dealer.findOne({ _id: clean(options.dealerId) }).lean();
    dealerCode = dealerCodeValue(dealer?.dealerCode);
  }
  if (!dealerCode || dealerCode === 'ALL') return { dealerId: clean(options.dealerId), dealerCode: '__NO_DEALER_SELECTED__', auditId: '__NO_AUDIT_SELECTED__', auditStatus: 'NONE' };
  const hint = options.auditMode === 'current' ? '' : clean(options.auditId || options.audit);
  if (hint && !['active', 'activeaudit', 'current', 'currentaudit', 'all'].includes(hint.toLowerCase())) {
    return { dealerId: clean(options.dealerId) || dealerCode, dealerCode, auditId: hint, auditStatus: 'EXPLICIT' };
  }
  // Prefer the actual active audit over a potentially stale dealer.currentAuditId.
  let audit = await getActiveAudit({ dealerCode });
  if (!audit) audit = await Audit.findOne({ dealerCode, isDeleted: { $ne: true }, isArchived: { $ne: true },
    $nor: [{ status: 'ARCHIVED' }, { auditStatus: 'ARCHIVED' }] })
    .sort({ auditStartDate: -1, createdAt: -1 }).lean();
  return { dealerId: clean(options.dealerId) || dealerCode, dealerCode,
    auditId: clean(audit?.auditId || audit?._id) || '__NO_AUDIT_SELECTED__',
    auditStatus: audit ? auditWorkflowStatus(audit) : 'NONE' };
}

async function resolveInventoryScope(query = {}) {
  return resolveCurrentAudit(query.dealerCode || query.dealer || '', query);
}

async function loadLedgerRows(query = {}, options = {}) {
  const scope = options.scope || await resolveInventoryScope(query);
  const filter = applyInventoryLedgerFilter({ ...(options.filter || {}), dealerCode: scope.dealerCode, auditId: scope.auditId }, query.testScanMode || 'real');
  const reader = Inventory.find(filter).sort({ timestamp: -1, createdAt: -1 });
  if (options.select) reader.select(options.select);
  if (options.skip) reader.skip(options.skip);
  if (options.limit) reader.limit(options.limit);
  const records = await reader.lean();
  return { scope, filter, records };
}

function calculateInventoryLedger(input = [], options = {}) {
  const records = uniqueReportScans(input).filter(activeStockTransaction);
  const groups = new Map();
  for (const scan of records) {
    const partNumber = normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part);
    if (!partNumber) continue;
    if (!groups.has(partNumber)) groups.set(partNumber, []);
    groups.get(partNumber).push(scan);
  }
  const parts = [];
  const binBreakdown = [];
  const workshopBreakdown = [];
  let transactionQty = 0;
  for (const [partNumber, scans] of groups) {
    const quantities = stockQuantitySummary(scans);
    const latest = scans.slice().sort((a, b) => new Date(b.timestamp || b.createdAt || 0) - new Date(a.timestamp || a.createdAt || 0))[0] || {};
    const price = options.prices?.get(partNumber) || latest;
    const mrp = Number(price.valuationMRP ?? price.mrp ?? price.currentCatalogueMRP ?? 0) || 0;
    const dlc = Number(price.dlc ?? price.currentCatalogueDLC ?? 0) || 0;
    const fittedMovementQty = scans.reduce((sum, scan) => sum + (stockMovementType(scan) === 'FITTED' ? stockUnitQuantity(scan) : 0), 0);
    const byBin = new Map();
    for (const scan of scans) {
      transactionQty += stockUnitQuantity(scan);
      const type = stockMovementType(scan);
      const bin = clean(type === 'FITTED' || type === 'OUTWARD' || type === 'DAMAGE'
        ? scan.stockDeductedFromBin || scan.sourceBin || scan.binLocation || scan.bin
        : scan.binLocation || scan.bin || scan.currentBin).toUpperCase();
      if (!bin) continue;
      if (!byBin.has(bin)) byBin.set(bin, []);
      byBin.get(bin).push(scan);
    }
    const bins = Array.from(byBin, ([binLocation, binScans]) => {
      const q = stockQuantitySummary(binScans);
      const fittedQty = binScans.reduce((sum, scan) => sum + (stockMovementType(scan) === 'FITTED' ? stockUnitQuantity(scan) : 0), 0);
      return { partNumber, binLocation, ...q, fittedQty, workshopQty: 0, physicalBinQty: q.storeQty,
        availableQty: q.storeQty, mrp, dlc, stockValue: q.storeQty * dlc, mrpStockValue: q.storeQty * mrp };
    });
    binBreakdown.push(...bins);
    if (quantities.fittedQty) workshopBreakdown.push({ partNumber, workshopQty: quantities.fittedQty, mrp, dlc });
    parts.push({ partNumber, ...quantities, fittedQty: fittedMovementQty, workshopQty: quantities.fittedQty,
      physicalBinQty: quantities.storeQty, totalDealerQty: quantities.availableQty, mrp, dlc,
      stockValue: quantities.availableQty * dlc, mrpStockValue: quantities.availableQty * mrp,
      partDescription: price.partDescription || price.description || latest.partDescription || latest.partName || '',
      category: price.productCategory || price.category || latest.productCategory || latest.category || '', binBreakdown: bins });
  }
  const sum = key => parts.reduce((total, part) => total + Number(part[key] || 0), 0);
  const scope = options.scope || {};
  const summary = { ...scope, transactionQty, inwardQty: sum('inwardQty'), outwardQty: sum('outwardQty'),
    fittedQty: sum('fittedQty'), damageQty: sum('damageQty'), physicalBinQty: sum('physicalBinQty'),
    workshopQty: sum('workshopQty'), availableQty: sum('availableQty'), totalDealerQty: sum('totalDealerQty'),
    uniqueParts: parts.length, scanRows: records.length, stockValue: Math.round(sum('stockValue') * 100) / 100,
    mrpStockValue: Math.round(sum('mrpStockValue') * 100) / 100 };
  return { scope, summary, parts, binBreakdown, workshopBreakdown, records };
}

async function getInventorySnapshot(query = {}, options = {}) {
  const ledger = await loadLedgerRows(query, options);
  const partNumbers = Array.from(new Set(ledger.records.map(scan => normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part)).filter(Boolean)));
  const prices = options.prices || (options.withPrices === false ? new Map() : await getPricesFromPartMaster(partNumbers, ledger.scope.dealerCode));
  const snapshot = calculateInventoryLedger(ledger.records, { scope: ledger.scope, prices });
  if (process.env.INVENTORY_SCOPE_LOGS === 'true') console.info('[INVENTORY_SCOPE]', JSON.stringify({ ...ledger.scope,
    validScanCount: snapshot.summary.scanRows, activeTransactionCount: snapshot.summary.scanRows }));
  return snapshot;
}

async function rebuildInventorySummary(query = {}) {
  const scope = await resolveInventoryScope(query);
  invalidateCache({ scope, tags: ['inventory', 'scans', 'dashboard', 'reports', 'reconciliation'] });
  return getInventorySnapshot(query, { scope });
}

module.exports = { resolveCurrentAudit, resolveInventoryScope, loadLedgerRows, calculateInventoryLedger, getInventorySnapshot, rebuildInventorySummary };
