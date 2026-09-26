const database = require('../services/prisma');
const Inventory = require('../models/Inventory');
const DealerStock = require('../models/DealerStock');
const AuditLog = require('../models/AuditLog');
const partMasterPrice = require('./partMasterPrice');
const { normalizePartNumber } = require('./normalize');

function refreshError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function partKey(row) {
  return normalizePartNumber(row.normalizedPartNumber || row.partNumber || row.part || row.partNo);
}

function pricePatch(row, price, stock = false) {
  const fields = partMasterPrice.masterPriceScanFields(price, row.qty ?? row.quantity ?? 0);
  // Retain scan evidence, identities, quantities, status, and price history.
  const patch = Object.fromEntries([
    'mrp', 'valuationMRP', 'valuationSource', 'finalInventoryValue', 'finalMRP',
    'defaultMRP', 'currentCatalogueMRP', 'currentCatalogueDLC', 'dlc', 'mrpStatus'
  ].map((field) => [field, fields[field]]));
  patch.displayMRP = fields.mrp;
  if (stock) {
    patch.dlp = fields.dlc;
    patch.stockValue = Math.round(Number(row.dmsStock ?? row.systemQty ?? 0) * fields.dlc * 100) / 100;
  }
  return patch;
}

async function writePatches(db, table, rows, prices, scope, stock = false) {
  const changes = rows.flatMap((row) => {
    const price = prices.get(partKey(row));
    if (!price) return [];
    const patch = pricePatch(row, price, stock);
    return Object.entries(patch).some(([key, value]) => row[key] !== value)
      ? [{ id: String(row._id || row.id), patch }] : [];
  });
  let updated = 0;
  for (let offset = 0; offset < changes.length; offset += 500) {
    const values = changes.slice(offset, offset + 500).map(({ id, patch }) =>
      database.Prisma.sql`(${id}, ${JSON.stringify(patch)}::jsonb)`);
    updated += Number(await db.$executeRaw(database.Prisma.sql`
      UPDATE ${database.Prisma.raw(table)} AS target
      SET data = target.data || patch.data, "updatedAt" = CURRENT_TIMESTAMP
      FROM (VALUES ${database.Prisma.join(values)}) AS patch(id, data)
      WHERE target.id = patch.id AND target."dealerCode" = ${scope.dealerCode}
        AND target."auditId" = ${scope.auditId}
    `));
  }
  return updated;
}

async function refreshOngoingAuditPrices(input = {}, user = {}) {
  const dealerCode = String(input.dealerCode || '').trim().toUpperCase();
  const auditId = String(input.auditId || '').trim();
  if (!dealerCode || dealerCode === 'ALL' || !auditId) {
    throw refreshError('Select a dealer and its ongoing audit before refreshing prices.', 400);
  }
  const scope = { dealerCode, auditId };
  return database.withDatabaseTransaction(async (db) => {
    // Lock the audit through commit so a concurrent close cannot be repriced.
    const audits = await db.$queryRaw(database.Prisma.sql`
      SELECT id, data, status FROM "audits"
      WHERE "dealerCode" = ${dealerCode} AND COALESCE(NULLIF("auditId", ''), id) = ${auditId}
      FOR UPDATE
    `);
    if (audits.length !== 1) throw refreshError('The selected audit was not found for this dealer.', 404);
    const audit = audits[0];
    const data = audit.data || {};
    const status = String(data.status ?? audit.status ?? '').trim().toUpperCase();
    const workflow = String(data.auditStatus || '').trim().toUpperCase();
    if (!['', 'ACTIVE', 'OPEN', 'IN_PROGRESS'].includes(status)
        || !['', 'IN_PROGRESS'].includes(workflow) || data.auditClosedDate) {
      throw refreshError('Prices can only be refreshed for an ongoing audit.', 409);
    }
    const [scans, stocks] = await Promise.all([
      Inventory.find(scope).lean(), DealerStock.find(scope).lean()
    ]);
    const parts = [...new Set([...scans, ...stocks].map(partKey).filter(Boolean))];
    const masterPrices = await partMasterPrice.getPricesFromPartMaster(parts, dealerCode);
    const prices = new Map([...masterPrices].filter(([, price]) => !partMasterPrice.masterPriceMissing(price)));
    const updatedScanCount = await writePatches(db, '"inventories"', scans, prices, scope);
    const updatedStockCount = await writePatches(db, '"dealer_stock_master"', stocks, prices, scope, true);
    const result = {
      ...scope, updatedScanCount, updatedStockCount,
      matchedPartCount: parts.filter((part) => prices.has(part)).length,
      missingPartCount: parts.filter((part) => !prices.has(part)).length
    };
    await AuditLog.create({
      ...scope, action: 'AUDIT_PRICE_REFRESH', userId: user.id || '',
      username: user.username || '', timestamp: new Date(), ...result
    });
    return result;
  }, { timeout: 120000 });
}

module.exports = { refreshOngoingAuditPrices };
