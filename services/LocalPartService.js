const { Prisma, prisma } = require('./prisma');
const { getActiveAudit } = require('../utils/audit');
const { cleanText, normalizePartNumber } = require('../utils/normalize');

const ACTIVE_STATUS = 'ACTIVE';
const DELETED_STATUS = 'DELETED';
const MAX_PAGE_SIZE = 200;
const MAX_DECIMAL_INTEGER = new Prisma.Decimal('1000000000000000');
const ALLOWED_SORT_FIELDS = new Set([
  'createdAt',
  'updatedAt',
  'dealerCode',
  'referenceAuditId',
  'partNumber',
  'partDescription',
  'quantity',
  'mrp',
  'dlc',
  'enteredByName',
  'status'
]);

class LocalPartError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'LocalPartError';
    this.statusCode = statusCode;
  }
}

function upper(value) {
  return cleanText(value).toUpperCase();
}

function requiredText(value, label, maxLength) {
  const text = cleanText(value);
  if (!text) throw new LocalPartError(`${label} is required`);
  if (maxLength && text.length > maxLength) throw new LocalPartError(`${label} must be ${maxLength} characters or fewer`);
  return text;
}

function optionalText(value, maxLength) {
  const text = cleanText(value);
  if (maxLength && text.length > maxLength) throw new LocalPartError(`Remarks must be ${maxLength} characters or fewer`);
  return text || null;
}

function decimalValue(value, label, scale, options = {}) {
  const text = cleanText(value).replace(/,/g, '');
  if (!text) throw new LocalPartError(`${label} is required`);
  let decimal;
  try {
    decimal = new Prisma.Decimal(text);
  } catch (error) {
    throw new LocalPartError(`${label} must be a valid number`);
  }
  if (!decimal.isFinite()) throw new LocalPartError(`${label} must be a valid number`);
  if (options.positive ? decimal.lte(0) : decimal.lt(0)) {
    throw new LocalPartError(options.positive ? `${label} must be greater than zero` : `${label} must be zero or greater`);
  }
  if (decimal.abs().gte(MAX_DECIMAL_INTEGER)) throw new LocalPartError(`${label} is too large`);
  return decimal.toDecimalPlaces(scale, Prisma.Decimal.ROUND_HALF_UP);
}

function actorDetails(actor = {}) {
  const id = cleanText(actor.id || actor._id);
  const name = cleanText(actor.name || actor.username || actor.email || id);
  if (!id || !name) throw new LocalPartError('Authenticated user details are required', 401);
  return { id, name };
}

function parseDate(value, endOfDay = false) {
  const text = cleanText(value);
  if (!text) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const date = new Date(dateOnly ? `${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}` : text);
  if (Number.isNaN(date.getTime())) throw new LocalPartError('Invalid date filter');
  return date;
}

function localDateParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return { entryDate: '', entryTime: '' };
  return {
    entryDate: new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    }).format(date),
    entryTime: new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    }).format(date)
  };
}

function decimalNumber(value) {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = Number(value.toString ? value.toString() : value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function decimalTotal(quantity, price) {
  return decimalNumber(new Prisma.Decimal(quantity || 0).mul(new Prisma.Decimal(price || 0)).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP));
}

function publicEntry(row = {}, dealerName = '') {
  const quantity = decimalNumber(row.quantity);
  const mrp = decimalNumber(row.mrp);
  const dlc = decimalNumber(row.dlc);
  const dateParts = localDateParts(row.createdAt);
  return {
    id: row.id,
    dealerCode: row.dealerCode || '',
    dealerName: dealerName || '',
    referenceAuditId: row.referenceAuditId || '',
    partNumber: row.partNumber || '',
    normalizedPartNumber: row.normalizedPartNumber || '',
    partDescription: row.partDescription || '',
    quantity,
    mrp,
    totalMrpValue: decimalTotal(row.quantity, row.mrp),
    dlc,
    totalDlcValue: decimalTotal(row.quantity, row.dlc),
    remarks: row.remarks || '',
    enteredByUserId: row.enteredByUserId || '',
    enteredByName: row.enteredByName || '',
    lastUpdatedByUserId: row.lastUpdatedByUserId || '',
    lastUpdatedByName: row.lastUpdatedByName || '',
    deletedByUserId: row.deletedByUserId || '',
    deletedByName: row.deletedByName || '',
    status: row.status || ACTIVE_STATUS,
    deletedAt: row.deletedAt ? new Date(row.deletedAt).toISOString() : null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    lastUpdatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    ...dateParts
  };
}

function dataObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

async function dealerNameMap(db, codes = []) {
  const uniqueCodes = Array.from(new Set(codes.map(upper).filter(Boolean)));
  if (!uniqueCodes.length || !db.dealer || typeof db.dealer.findMany !== 'function') return new Map();
  const rows = await db.dealer.findMany({
    where: { dealerCode: { in: uniqueCodes } },
    select: { dealerCode: true, data: true }
  });
  return new Map(rows.map((row) => {
    const data = dataObject(row.data);
    return [upper(row.dealerCode), cleanText(data.dealerName || data.name || '')];
  }));
}

function buildWhere(filters = {}, allowedDealerCodes = null) {
  const where = {};
  const dealerCode = upper(filters.dealerCode);
  if (dealerCode && dealerCode !== 'ALL') where.dealerCode = dealerCode;
  else if (Array.isArray(allowedDealerCodes)) where.dealerCode = { in: allowedDealerCodes.map(upper) };

  const status = upper(filters.status);
  if (!status || status === ACTIVE_STATUS) {
    where.status = ACTIVE_STATUS;
    where.deletedAt = null;
  } else if (status !== 'ALL') {
    where.status = status;
  }

  const referenceAuditId = cleanText(filters.referenceAuditId || filters.auditId);
  if (referenceAuditId) where.referenceAuditId = referenceAuditId;
  const normalizedPart = normalizePartNumber(filters.partNumber);
  if (normalizedPart) where.normalizedPartNumber = { contains: normalizedPart };
  const userName = cleanText(filters.userName || filters.user);
  if (userName) where.enteredByName = { contains: userName, mode: 'insensitive' };
  const fromDate = parseDate(filters.fromDate, false);
  const toDate = parseDate(filters.toDate, true);
  if (fromDate || toDate) where.createdAt = { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lte: toDate } : {}) };
  return where;
}

function normalizeInput(payload = {}) {
  const partNumber = upper(requiredText(payload.partNumber, 'Part Number', 120));
  return {
    dealerCode: upper(requiredText(payload.dealerCode, 'Dealer', 80)),
    partNumber,
    normalizedPartNumber: normalizePartNumber(partNumber),
    partDescription: requiredText(payload.partDescription, 'Part Description', 500),
    quantity: decimalValue(payload.quantity, 'Quantity', 3, { positive: true }),
    mrp: decimalValue(payload.mrp, 'MRP', 2),
    dlc: decimalValue(payload.dlc, 'DLC', 2),
    remarks: optionalText(payload.remarks, 2000)
  };
}

function createLocalPartService(options = {}) {
  const db = options.db || prisma;
  const activeAuditLookup = options.getActiveAudit || getActiveAudit;

  async function create(payload, actor) {
    const values = normalizeInput(payload);
    const enteredBy = actorDetails(actor);
    const audit = await activeAuditLookup({ dealerCode: values.dealerCode }).catch(() => null);
    const referenceAuditId = cleanText(audit && (audit.auditId || audit.id || audit._id)) || null;
    const row = await db.localPartEntry.create({
      data: {
        ...values,
        referenceAuditId,
        enteredByUserId: enteredBy.id,
        enteredByName: enteredBy.name,
        status: ACTIVE_STATUS
      }
    });
    const names = await dealerNameMap(db, [row.dealerCode]);
    return publicEntry(row, names.get(upper(row.dealerCode)) || '');
  }

  async function findRawById(id) {
    const cleanId = cleanText(id);
    if (!cleanId) throw new LocalPartError('Local Part entry ID is required');
    const row = await db.localPartEntry.findUnique({ where: { id: cleanId } });
    if (!row) throw new LocalPartError('Local Part entry not found', 404);
    return row;
  }

  async function getById(id) {
    const row = await findRawById(id);
    const names = await dealerNameMap(db, [row.dealerCode]);
    return publicEntry(row, names.get(upper(row.dealerCode)) || '');
  }

  async function update(id, payload, actor) {
    const existing = await findRawById(id);
    if (existing.status === DELETED_STATUS || existing.deletedAt) throw new LocalPartError('Deleted Local Part entries cannot be edited', 409);
    const values = normalizeInput(payload);
    const updatedBy = actorDetails(actor);
    let referenceAuditId = existing.referenceAuditId;
    if (values.dealerCode !== existing.dealerCode || !referenceAuditId) {
      const audit = await activeAuditLookup({ dealerCode: values.dealerCode }).catch(() => null);
      referenceAuditId = cleanText(audit && (audit.auditId || audit.id || audit._id)) || null;
    }
    const row = await db.localPartEntry.update({
      where: { id: existing.id },
      data: {
        ...values,
        referenceAuditId,
        lastUpdatedByUserId: updatedBy.id,
        lastUpdatedByName: updatedBy.name
      }
    });
    const names = await dealerNameMap(db, [row.dealerCode]);
    return publicEntry(row, names.get(upper(row.dealerCode)) || '');
  }

  async function softDelete(id, actor) {
    const existing = await findRawById(id);
    if (existing.status === DELETED_STATUS || existing.deletedAt) return getById(existing.id);
    const deletedBy = actorDetails(actor);
    const row = await db.localPartEntry.update({
      where: { id: existing.id },
      data: {
        status: DELETED_STATUS,
        deletedAt: new Date(),
        deletedByUserId: deletedBy.id,
        deletedByName: deletedBy.name,
        lastUpdatedByUserId: deletedBy.id,
        lastUpdatedByName: deletedBy.name
      }
    });
    const names = await dealerNameMap(db, [row.dealerCode]);
    return publicEntry(row, names.get(upper(row.dealerCode)) || '');
  }

  async function list(filters = {}, optionsForList = {}) {
    const where = buildWhere(filters, optionsForList.allowedDealerCodes || null);
    const page = Math.max(1, Number.parseInt(filters.page || '1', 10) || 1);
    const requestedLimit = Number.parseInt(filters.limit || '25', 10) || 25;
    const limit = optionsForList.all ? undefined : Math.min(MAX_PAGE_SIZE, Math.max(1, requestedLimit));
    const sortBy = ALLOWED_SORT_FIELDS.has(cleanText(filters.sortBy)) ? cleanText(filters.sortBy) : 'createdAt';
    const sortDir = cleanText(filters.sortDir).toLowerCase() === 'asc' ? 'asc' : 'desc';
    const [totalRows, rows, totalSource] = await Promise.all([
      db.localPartEntry.count({ where }),
      db.localPartEntry.findMany({
        where,
        orderBy: { [sortBy]: sortDir },
        ...(limit ? { skip: (page - 1) * limit, take: limit } : {})
      }),
      db.localPartEntry.findMany({ where, select: { quantity: true, mrp: true, dlc: true } })
    ]);
    const names = await dealerNameMap(db, rows.map((row) => row.dealerCode));
    const entries = rows.map((row, index) => ({
      serialNumber: limit ? ((page - 1) * limit) + index + 1 : index + 1,
      ...publicEntry(row, names.get(upper(row.dealerCode)) || '')
    }));
    const totals = totalSource.reduce((summary, row) => {
      summary.quantity = summary.quantity.add(row.quantity || 0);
      summary.mrpValue = summary.mrpValue.add(new Prisma.Decimal(row.quantity || 0).mul(row.mrp || 0));
      summary.dlcValue = summary.dlcValue.add(new Prisma.Decimal(row.quantity || 0).mul(row.dlc || 0));
      return summary;
    }, {
      quantity: new Prisma.Decimal(0),
      mrpValue: new Prisma.Decimal(0),
      dlcValue: new Prisma.Decimal(0)
    });
    return {
      entries,
      totalRows,
      pagination: {
        page,
        limit: limit || totalRows || 1,
        totalRows,
        totalPages: limit ? Math.max(1, Math.ceil(totalRows / limit)) : 1
      },
      summary: {
        totalRows,
        grandTotalQuantity: decimalNumber(totals.quantity.toDecimalPlaces(3)),
        grandTotalMrpValue: decimalNumber(totals.mrpValue.toDecimalPlaces(2)),
        grandTotalDlcValue: decimalNumber(totals.dlcValue.toDecimalPlaces(2))
      }
    };
  }

  return {
    create,
    findRawById,
    getById,
    list,
    softDelete,
    update
  };
}

module.exports = {
  ACTIVE_STATUS,
  DELETED_STATUS,
  LocalPartError,
  createLocalPartService,
  decimalTotal,
  normalizeInput,
  publicEntry
};
