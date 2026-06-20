const { randomUUID } = require('crypto');
const { Prisma, prisma } = require('../services/prisma');

const MIRROR_FIELDS = [
  'dealerCode',
  'auditId',
  'partNumber',
  'normalizedPartNumber',
  'uniqueScanId',
  'scanId',
  'globalUpiKey',
  'upiCode',
  'qrFingerprint',
  'upiNo',
  'rawUpiHash',
  'bin',
  'binLocation',
  'scanType',
  'movementType',
  'type',
  'activeInventory',
  'remainingQty',
  'syncStatus',
  'scanStatus',
  'status',
  'source',
  'userId',
  'loginId',
  'username',
  'email',
  'deviceId',
  'key',
  'reportName',
  'currentAuditId',
  'timestamp',
  'scanTime',
  'time',
  'dateTime'
];

const DATE_FIELDS = new Set([
  'timestamp',
  'scanTime',
  'time',
  'dateTime',
  'createdAt',
  'updatedAt',
  'uploadedAt',
  'lastSeen',
  'connectedAt',
  'lastSyncTime',
  'lastScanAt',
  'lastActivity',
  'serverReceivedAt',
  'mrpPendingUpdatedAt',
  'pricePeriodFrom',
  'pricePeriodTo',
  'auditStartDate',
  'auditClosedDate',
  'approvedAt',
  'resetExpiresAt',
  'resetRequestedAt',
  'printedAt',
  'transferredAt',
  'deletedTime',
  'dateDeleted',
  'effectiveFrom',
  'effectiveTo',
  'created_at',
  'updated_at'
]);

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof RegExp);
}

function cleanObject(input) {
  if (input === undefined) return undefined;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input.toISOString();
  if (input instanceof RegExp) return input;
  if (Array.isArray(input)) return input.map(cleanObject).filter((item) => item !== undefined);
  if (!isPlainObject(input)) return input;
  const output = {};
  Object.entries(input).forEach(([key, value]) => {
    const cleaned = cleanObject(value);
    if (cleaned !== undefined) output[key] = cleaned;
  });
  return output;
}

function asDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function hydrateDates(row) {
  DATE_FIELDS.forEach((field) => {
    if (row[field] === undefined || row[field] === null || row[field] === '') return;
    const date = asDate(row[field]);
    if (date) row[field] = date;
  });
  return row;
}

function publicRow(record = {}) {
  const data = isPlainObject(record.data) ? { ...record.data } : {};
  const output = { ...data };
  MIRROR_FIELDS.forEach((field) => {
    if (record[field] !== undefined && record[field] !== null && output[field] === undefined) output[field] = record[field];
  });
  output.id = record.id;
  output._id = record.id;
  output.createdAt = record.createdAt || output.createdAt;
  output.updatedAt = record.updatedAt || output.updatedAt;
  return hydrateDates(output);
}

function valueForMirror(data, field) {
  const value = data[field];
  if (value === undefined || value === null || value === '') return null;
  if (DATE_FIELDS.has(field)) return asDate(value);
  return String(value);
}

function buildRow(data, id) {
  const now = new Date();
  const clean = cleanObject({ ...data });
  const createdAt = asDate(clean.createdAt) || now;
  const updatedAt = asDate(clean.updatedAt) || now;
  clean.createdAt = createdAt.toISOString();
  clean.updatedAt = updatedAt.toISOString();
  const row = {
    id,
    data: clean,
    createdAt,
    updatedAt
  };
  MIRROR_FIELDS.forEach((field) => {
    row[field] = valueForMirror(clean, field);
  });
  return row;
}

function normalizeSort(sortSpec = {}) {
  if (typeof sortSpec === 'string') {
    return sortSpec.split(/\s+/).filter(Boolean).reduce((acc, item) => {
      if (item.startsWith('-')) acc[item.slice(1)] = -1;
      else acc[item] = 1;
      return acc;
    }, {});
  }
  return sortSpec || {};
}

function normalizeSelect(selectSpec) {
  if (!selectSpec) return null;
  if (typeof selectSpec === 'string') {
    const fields = selectSpec.split(/\s+/).filter(Boolean);
    const excludes = fields.filter((field) => field.startsWith('-')).map((field) => field.slice(1));
    if (excludes.length) return { mode: 'exclude', fields: new Set(excludes) };
    return { mode: 'include', fields: new Set(fields) };
  }
  if (isPlainObject(selectSpec)) {
    const include = Object.entries(selectSpec).filter(([, value]) => Boolean(value)).map(([key]) => key);
    const exclude = Object.entries(selectSpec).filter(([, value]) => !value).map(([key]) => key);
    if (include.length) return { mode: 'include', fields: new Set(include) };
    if (exclude.length) return { mode: 'exclude', fields: new Set(exclude) };
  }
  return null;
}

function applySelect(row, select) {
  if (!select) return row;
  if (select.mode === 'include') {
    const picked = {};
    select.fields.forEach((field) => {
      if (row[field] !== undefined) picked[field] = row[field];
    });
    if (row._id !== undefined && !picked._id && !picked.id) picked._id = row._id;
    return picked;
  }
  const next = { ...row };
  select.fields.forEach((field) => {
    delete next[field];
  });
  return next;
}

function getPath(row, path) {
  if (path === '$$ROOT') return row;
  if (typeof path !== 'string') return undefined;
  const cleanPath = path.startsWith('$') ? path.slice(1) : path;
  return cleanPath.split('.').reduce((value, key) => (value === undefined || value === null ? undefined : value[key]), row);
}

function textValue(value) {
  if (value === undefined || value === null) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function convertValue(value, type, onError = null, onNull = null) {
  if (value === undefined || value === null || value === '') return onNull;
  try {
    if (type === 'double' || type === 'decimal' || type === 'int' || type === 'long') {
      const number = Number(value);
      if (!Number.isFinite(number)) return onError;
      return type === 'int' || type === 'long' ? Math.trunc(number) : number;
    }
    if (type === 'string') return textValue(value);
    if (type === 'bool' || type === 'boolean') return Boolean(value);
    if (type === 'date') {
      const date = asDate(value);
      return date || onError;
    }
    return value;
  } catch (error) {
    return onError;
  }
}

function compareValues(left, right) {
  const leftDate = asDate(left);
  const rightDate = asDate(right);
  if (leftDate && rightDate) return leftDate.getTime() - rightDate.getTime();
  if (typeof left === 'number' || typeof right === 'number') return Number(left || 0) - Number(right || 0);
  return textValue(left).localeCompare(textValue(right), undefined, { numeric: true, sensitivity: 'base' });
}

function regexMatches(value, regex) {
  if (regex instanceof RegExp) return regex.test(textValue(value));
  return new RegExp(String(regex || ''), 'i').test(textValue(value));
}

function matchesOperator(actual, operators = {}) {
  for (const [operator, expected] of Object.entries(operators)) {
    if (operator === '$options') continue;
    if (operator === '$in') {
      const items = Array.isArray(expected) ? expected : [expected];
      if (!items.some((item) => item instanceof RegExp ? regexMatches(actual, item) : compareValues(actual, item) === 0)) return false;
    } else if (operator === '$nin') {
      const items = Array.isArray(expected) ? expected : [expected];
      if (items.some((item) => item instanceof RegExp ? regexMatches(actual, item) : compareValues(actual, item) === 0)) return false;
    } else if (operator === '$ne') {
      if (compareValues(actual, expected) === 0) return false;
    } else if (operator === '$exists') {
      const exists = actual !== undefined && actual !== null;
      if (Boolean(expected) !== exists) return false;
    } else if (operator === '$gte') {
      if (compareValues(actual, expected) < 0) return false;
    } else if (operator === '$gt') {
      if (compareValues(actual, expected) <= 0) return false;
    } else if (operator === '$lte') {
      if (compareValues(actual, expected) > 0) return false;
    } else if (operator === '$lt') {
      if (compareValues(actual, expected) >= 0) return false;
    } else if (operator === '$regex') {
      const flags = operators.$options || 'i';
      if (!new RegExp(String(expected || ''), flags).test(textValue(actual))) return false;
    } else if (operator === '$not') {
      if (expected instanceof RegExp) {
        if (regexMatches(actual, expected)) return false;
      } else if (matchesOperator(actual, expected)) {
        return false;
      }
    } else if (operator === '$type') {
      if (expected === 'string' && typeof actual !== 'string') return false;
      if (expected === 'number' && typeof actual !== 'number') return false;
    }
  }
  return true;
}

function matchesFilter(row = {}, filter = {}) {
  if (!filter || !Object.keys(filter).length) return true;
  for (const [key, expected] of Object.entries(filter)) {
    if (key === '$or') {
      if (!Array.isArray(expected) || !expected.some((item) => matchesFilter(row, item))) return false;
      continue;
    }
    if (key === '$and') {
      if (!Array.isArray(expected) || !expected.every((item) => matchesFilter(row, item))) return false;
      continue;
    }
    if (key === '$nor') {
      if (Array.isArray(expected) && expected.some((item) => matchesFilter(row, item))) return false;
      continue;
    }
    const actual = key === '_id' ? row._id : getPath(row, key);
    if (expected instanceof RegExp) {
      if (!regexMatches(actual, expected)) return false;
    } else if (isPlainObject(expected) && Object.keys(expected).some((item) => item.startsWith('$'))) {
      if (!matchesOperator(actual, expected)) return false;
    } else if (expected === null) {
      if (actual !== null && actual !== undefined) return false;
    } else if (compareValues(actual, expected) !== 0) {
      return false;
    }
  }
  return true;
}

function columnSql(field) {
  const normalized = field === '_id' ? 'id' : field;
  if (normalized === 'id' || MIRROR_FIELDS.includes(normalized) || normalized === 'createdAt' || normalized === 'updatedAt') {
    return Prisma.raw(quoteIdent(normalized));
  }
  return null;
}

function fieldTextSql(field) {
  const normalized = field === '_id' ? 'id' : field;
  const column = columnSql(normalized);
  if (column) return Prisma.sql`COALESCE(${column}::text, "data"->>${normalized})`;
  return Prisma.sql`"data"->>${normalized}`;
}

function fieldCompareSql(field, sample) {
  const normalized = field === '_id' ? 'id' : field;
  const column = columnSql(normalized);
  if (DATE_FIELDS.has(normalized) || sample instanceof Date) {
    if (column) return column;
    return Prisma.sql`NULLIF("data"->>${normalized}, '')::timestamptz`;
  }
  if (typeof sample === 'number') {
    const text = fieldTextSql(normalized);
    return Prisma.sql`CASE WHEN ${text} ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (${text})::double precision ELSE NULL END`;
  }
  return fieldTextSql(normalized);
}

function regexSql(field, regex, options = '') {
  const pattern = regex instanceof RegExp ? regex.source : String(regex || '');
  const flags = regex instanceof RegExp ? regex.flags : String(options || 'i');
  return flags.includes('i')
    ? Prisma.sql`${fieldTextSql(field)} ~* ${pattern}`
    : Prisma.sql`${fieldTextSql(field)} ~ ${pattern}`;
}

function scalarText(value) {
  if (value instanceof Date) return value.toISOString();
  if (value === null || value === undefined) return null;
  return String(value);
}

function predicateSql(filter = {}) {
  const clauses = [];
  let supported = true;
  for (const [key, expected] of Object.entries(filter || {})) {
    if (key === '$or' || key === '$and') {
      const children = (Array.isArray(expected) ? expected : []).map(predicateSql);
      if (!children.length) continue;
      supported = children.every((child) => child.supported) && supported;
      const joined = Prisma.join(children.map((child) => child.sql), key === '$or' ? ' OR ' : ' AND ');
      clauses.push(Prisma.sql`(${joined})`);
      continue;
    }
    if (key === '$nor') {
      const children = (Array.isArray(expected) ? expected : []).map(predicateSql);
      if (!children.length) continue;
      supported = children.every((child) => child.supported) && supported;
      clauses.push(Prisma.sql`NOT (${Prisma.join(children.map((child) => child.sql), ' OR ')})`);
      continue;
    }

    if (expected instanceof RegExp) {
      clauses.push(regexSql(key, expected));
      continue;
    }

    if (isPlainObject(expected) && Object.keys(expected).some((item) => item.startsWith('$'))) {
      const fieldClauses = [];
      for (const [operator, value] of Object.entries(expected)) {
        if (operator === '$options') continue;
        if (operator === '$in' || operator === '$nin') {
          const items = Array.isArray(value) ? value : [value];
          const regexItems = items.filter((item) => item instanceof RegExp);
          const scalarItems = items.filter((item) => !(item instanceof RegExp)).map(scalarText).filter((item) => item !== null);
          const nullWanted = items.some((item) => item === null || item === undefined);
          const parts = [];
          if (scalarItems.length) parts.push(Prisma.sql`${fieldTextSql(key)} IN (${Prisma.join(scalarItems)})`);
          regexItems.forEach((item) => parts.push(regexSql(key, item)));
          if (nullWanted) parts.push(Prisma.sql`${fieldTextSql(key)} IS NULL`);
          const clause = parts.length ? Prisma.sql`(${Prisma.join(parts, ' OR ')})` : Prisma.sql`FALSE`;
          fieldClauses.push(operator === '$nin' ? Prisma.sql`NOT ${clause}` : clause);
        } else if (operator === '$ne') {
          const scalar = scalarText(value);
          fieldClauses.push(scalar === null ? Prisma.sql`${fieldTextSql(key)} IS NOT NULL` : Prisma.sql`${fieldTextSql(key)} IS DISTINCT FROM ${scalar}`);
        } else if (operator === '$exists') {
          fieldClauses.push(Boolean(value) ? Prisma.sql`${fieldTextSql(key)} IS NOT NULL` : Prisma.sql`${fieldTextSql(key)} IS NULL`);
        } else if (['$gt', '$gte', '$lt', '$lte'].includes(operator)) {
          const compare = fieldCompareSql(key, value);
          const op = { $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' }[operator];
          fieldClauses.push(Prisma.sql`${compare} ${Prisma.raw(op)} ${value instanceof Date ? value : value}`);
        } else if (operator === '$regex') {
          fieldClauses.push(regexSql(key, value, expected.$options));
        } else if (operator === '$not') {
          if (value instanceof RegExp) fieldClauses.push(Prisma.sql`NOT (${regexSql(key, value)})`);
          else {
            supported = false;
          }
        } else if (operator === '$type') {
          if (value === 'string') fieldClauses.push(Prisma.sql`jsonb_typeof("data"->${key}) = 'string'`);
          else supported = false;
        } else {
          supported = false;
        }
      }
      if (fieldClauses.length) clauses.push(Prisma.sql`(${Prisma.join(fieldClauses, ' AND ')})`);
      continue;
    }

    if (expected === null || expected === undefined) {
      clauses.push(Prisma.sql`${fieldTextSql(key)} IS NULL`);
    } else {
      clauses.push(Prisma.sql`${fieldTextSql(key)} = ${scalarText(expected)}`);
    }
  }
  return { sql: clauses.length ? Prisma.sql`${Prisma.join(clauses, ' AND ')}` : Prisma.sql`TRUE`, supported };
}

function orderSql(sortSpec = {}) {
  const entries = Object.entries(normalizeSort(sortSpec));
  if (!entries.length) return Prisma.empty;
  const parts = entries.map(([field, direction]) => {
    const normalized = field === '_id' ? 'id' : field;
    const expr = columnSql(normalized) || fieldTextSql(normalized);
    return Prisma.sql`${expr} ${Prisma.raw(Number(direction) < 0 ? 'DESC' : 'ASC')} NULLS LAST`;
  });
  return Prisma.sql` ORDER BY ${Prisma.join(parts, ', ')}`;
}

class Document {
  constructor(Model, data = {}, isNew = true) {
    Object.defineProperty(this, '__model', { value: Model, enumerable: false, writable: true });
    Object.defineProperty(this, '__isNew', { value: isNew, enumerable: false, writable: true });
    Object.assign(this, data);
    if (this.id && !this._id) this._id = this.id;
    if (this._id && !this.id) this.id = this._id;
  }

  isModified() {
    return true;
  }

  toObject() {
    const output = {};
    Object.keys(this).forEach((key) => {
      if (!key.startsWith('__')) output[key] = this[key];
    });
    return output;
  }

  toJSON() {
    return this.toObject();
  }

  async save() {
    const saved = await this.__model.__save(this.toObject(), { isNew: this.__isNew });
    Object.keys(this).forEach((key) => {
      if (!key.startsWith('__')) delete this[key];
    });
    Object.assign(this, saved.toObject ? saved.toObject() : saved);
    this.__isNew = false;
    return this;
  }
}

class Query {
  constructor(Model, filter = {}, options = {}) {
    this.Model = Model;
    this.filter = filter || {};
    this.single = Boolean(options.single);
    this.asLean = Boolean(options.lean);
    this.sortSpec = options.sort || null;
    this.limitValue = options.limit || null;
    this.skipValue = options.skip || 0;
    this.selectSpec = normalizeSelect(options.select);
  }

  sort(spec) {
    this.sortSpec = spec;
    return this;
  }

  limit(value) {
    this.limitValue = Number(value) || 0;
    return this;
  }

  skip(value) {
    this.skipValue = Number(value) || 0;
    return this;
  }

  select(spec) {
    this.selectSpec = normalizeSelect(spec);
    return this;
  }

  lean() {
    this.asLean = true;
    return this;
  }

  session() {
    return this;
  }

  allowDiskUse() {
    return this;
  }

  async exec() {
    const rows = await this.Model.__findRows(this.filter, {
      sort: this.sortSpec,
      limit: this.limitValue,
      skip: this.skipValue,
      single: this.single
    });
    const selected = rows.map((row) => applySelect(row, this.selectSpec));
    const result = this.asLean
      ? selected
      : selected.map((row) => new Document(this.Model, row, false));
    return this.single ? (result[0] || null) : result;
  }

  then(resolve, reject) {
    return this.exec().then(resolve, reject);
  }

  catch(reject) {
    return this.exec().catch(reject);
  }

  finally(handler) {
    return this.exec().finally(handler);
  }
}

class MutationQuery {
  constructor(action) {
    this.action = action;
    this.asLean = false;
  }

  lean() {
    this.asLean = true;
    return this;
  }

  session() {
    return this;
  }

  async exec() {
    const result = await this.action();
    if (!result) return result;
    return this.asLean && result.toObject ? result.toObject() : result;
  }

  then(resolve, reject) {
    return this.exec().then(resolve, reject);
  }

  catch(reject) {
    return this.exec().catch(reject);
  }
}

function evaluateExpression(expr, row, vars = {}) {
  if (expr === '$$ROOT') return row;
  if (typeof expr === 'string') {
    if (expr.startsWith('$$')) return vars[expr.slice(2)];
    if (expr.startsWith('$')) return getPath(row, expr);
    return expr;
  }
  if (expr === null || expr === undefined || typeof expr !== 'object' || expr instanceof Date || expr instanceof RegExp) return expr;
  if (Array.isArray(expr)) return expr.map((item) => evaluateExpression(item, row, vars));

  if ('$ifNull' in expr) {
    for (const item of expr.$ifNull) {
      const value = evaluateExpression(item, row, vars);
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return null;
  }
  if ('$convert' in expr) {
    const spec = expr.$convert || {};
    return convertValue(
      evaluateExpression(spec.input, row, vars),
      evaluateExpression(spec.to, row, vars),
      evaluateExpression(spec.onError, row, vars),
      evaluateExpression(spec.onNull, row, vars)
    );
  }
  if ('$toString' in expr) return textValue(evaluateExpression(expr.$toString, row, vars));
  if ('$toUpper' in expr) return textValue(evaluateExpression(expr.$toUpper, row, vars)).toUpperCase();
  if ('$trim' in expr) return textValue(evaluateExpression(expr.$trim.input, row, vars)).trim();
  if ('$concat' in expr) return expr.$concat.map((item) => textValue(evaluateExpression(item, row, vars))).join('');
  if ('$abs' in expr) return Math.abs(numberValue(evaluateExpression(expr.$abs, row, vars)));
  if ('$multiply' in expr) return expr.$multiply.reduce((value, item) => value * numberValue(evaluateExpression(item, row, vars)), 1);
  if ('$add' in expr) return expr.$add.reduce((value, item) => value + numberValue(evaluateExpression(item, row, vars)), 0);
  if ('$eq' in expr) return compareValues(evaluateExpression(expr.$eq[0], row, vars), evaluateExpression(expr.$eq[1], row, vars)) === 0;
  if ('$ne' in expr) return compareValues(evaluateExpression(expr.$ne[0], row, vars), evaluateExpression(expr.$ne[1], row, vars)) !== 0;
  if ('$gt' in expr) return compareValues(evaluateExpression(expr.$gt[0], row, vars), evaluateExpression(expr.$gt[1], row, vars)) > 0;
  if ('$gte' in expr) return compareValues(evaluateExpression(expr.$gte[0], row, vars), evaluateExpression(expr.$gte[1], row, vars)) >= 0;
  if ('$lt' in expr) return compareValues(evaluateExpression(expr.$lt[0], row, vars), evaluateExpression(expr.$lt[1], row, vars)) < 0;
  if ('$lte' in expr) return compareValues(evaluateExpression(expr.$lte[0], row, vars), evaluateExpression(expr.$lte[1], row, vars)) <= 0;
  if ('$and' in expr) return expr.$and.every((item) => Boolean(evaluateExpression(item, row, vars)));
  if ('$or' in expr) return expr.$or.some((item) => Boolean(evaluateExpression(item, row, vars)));
  if ('$not' in expr) return !evaluateExpression(Array.isArray(expr.$not) ? expr.$not[0] : expr.$not, row, vars);
  if ('$in' in expr) {
    const value = evaluateExpression(expr.$in[0], row, vars);
    const items = evaluateExpression(expr.$in[1], row, vars) || [];
    return items.some((item) => compareValues(value, item) === 0);
  }
  if ('$cond' in expr) {
    const parts = Array.isArray(expr.$cond) ? expr.$cond : [expr.$cond.if, expr.$cond.then, expr.$cond.else];
    return evaluateExpression(parts[0], row, vars) ? evaluateExpression(parts[1], row, vars) : evaluateExpression(parts[2], row, vars);
  }
  if ('$switch' in expr) {
    const branch = (expr.$switch.branches || []).find((item) => evaluateExpression(item.case, row, vars));
    return branch ? evaluateExpression(branch.then, row, vars) : evaluateExpression(expr.$switch.default, row, vars);
  }
  if ('$let' in expr) {
    const scoped = { ...vars };
    Object.entries(expr.$let.vars || {}).forEach(([key, value]) => {
      scoped[key] = evaluateExpression(value, row, scoped);
    });
    return evaluateExpression(expr.$let.in, row, scoped);
  }
  if ('$regexMatch' in expr) {
    const input = evaluateExpression(expr.$regexMatch.input, row, vars);
    return regexMatches(input, expr.$regexMatch.regex);
  }
  if ('$reduce' in expr) {
    const items = evaluateExpression(expr.$reduce.input, row, vars) || [];
    let value = evaluateExpression(expr.$reduce.initialValue, row, vars);
    for (const item of items) {
      value = evaluateExpression(expr.$reduce.in, row, { ...vars, value, this: item });
    }
    return value;
  }

  const output = {};
  Object.entries(expr).forEach(([key, value]) => {
    output[key] = evaluateExpression(value, row, vars);
  });
  return output;
}

function groupKeyValue(idExpr, row) {
  const value = evaluateExpression(idExpr, row);
  return { value, key: JSON.stringify(value) };
}

function sortRows(rows, sortSpec = {}) {
  const entries = Object.entries(normalizeSort(sortSpec));
  if (!entries.length) return rows;
  return rows.sort((left, right) => {
    for (const [field, direction] of entries) {
      const diff = compareValues(getPath(left, field), getPath(right, field));
      if (diff) return Number(direction) < 0 ? -diff : diff;
    }
    return 0;
  });
}

function projectRow(row, spec = {}) {
  const includes = Object.entries(spec).filter(([, value]) => value && value !== 0);
  const excludes = Object.entries(spec).filter(([, value]) => value === 0);
  if (includes.length) {
    const output = {};
    includes.forEach(([field, expr]) => {
      output[field] = expr === 1 ? row[field] : evaluateExpression(expr, row);
    });
    if (spec._id !== 0 && row._id !== undefined && output._id === undefined) output._id = row._id;
    return output;
  }
  const output = { ...row };
  excludes.forEach(([field]) => delete output[field]);
  return output;
}

function runGroup(rows, groupSpec = {}) {
  const groups = new Map();
  rows.forEach((row) => {
    const { value: idValue, key } = groupKeyValue(groupSpec._id, row);
    if (!groups.has(key)) groups.set(key, { _id: idValue, __rows: [] });
    groups.get(key).__rows.push(row);
  });
  return Array.from(groups.values()).map((group) => {
    const output = { _id: group._id };
    Object.entries(groupSpec).forEach(([field, accumulator]) => {
      if (field === '_id') return;
      if ('$sum' in accumulator) {
        output[field] = group.__rows.reduce((sum, row) => sum + numberValue(evaluateExpression(accumulator.$sum, row)), 0);
      } else if ('$first' in accumulator) {
        output[field] = evaluateExpression(accumulator.$first, group.__rows[0]);
      } else if ('$max' in accumulator) {
        output[field] = group.__rows.reduce((max, row) => {
          const value = evaluateExpression(accumulator.$max, row);
          return max === undefined || compareValues(value, max) > 0 ? value : max;
        }, undefined);
      } else if ('$min' in accumulator) {
        output[field] = group.__rows.reduce((min, row) => {
          const value = evaluateExpression(accumulator.$min, row);
          return min === undefined || compareValues(value, min) < 0 ? value : min;
        }, undefined);
      } else if ('$push' in accumulator) {
        output[field] = group.__rows.map((row) => evaluateExpression(accumulator.$push, row));
      } else if ('$addToSet' in accumulator) {
        const map = new Map();
        group.__rows.forEach((row) => {
          const value = evaluateExpression(accumulator.$addToSet, row);
          map.set(JSON.stringify(value), value);
        });
        output[field] = Array.from(map.values());
      }
    });
    return output;
  });
}

function runPipeline(rows, pipeline = []) {
  let output = rows.slice();
  for (const stage of pipeline) {
    if (stage.$match) output = output.filter((row) => matchesFilter(row, stage.$match));
    else if (stage.$addFields || stage.$set) {
      const spec = stage.$addFields || stage.$set;
      output = output.map((row) => {
        const next = { ...row };
        Object.entries(spec).forEach(([field, expr]) => {
          next[field] = evaluateExpression(expr, next);
        });
        return next;
      });
    } else if (stage.$sort) output = sortRows(output, stage.$sort);
    else if (stage.$group) output = runGroup(output, stage.$group);
    else if (stage.$replaceRoot) output = output.map((row) => evaluateExpression(stage.$replaceRoot.newRoot, row));
    else if (stage.$project) output = output.map((row) => projectRow(row, stage.$project));
    else if (stage.$limit) output = output.slice(0, Number(stage.$limit) || 0);
    else if (stage.$skip) output = output.slice(Number(stage.$skip) || 0);
    else if (stage.$count) output = [{ [stage.$count]: output.length }];
    else if (stage.$facet) {
      const base = output;
      output = [Object.fromEntries(Object.entries(stage.$facet).map(([key, facetPipeline]) => [key, runPipeline(base, facetPipeline)]))];
    } else if (stage.$unwind) {
      const field = String(typeof stage.$unwind === 'string' ? stage.$unwind : stage.$unwind.path || '').replace(/^\$/, '');
      output = output.flatMap((row) => {
        const value = getPath(row, field);
        if (!Array.isArray(value)) return [row];
        return value.map((item) => ({ ...row, [field]: item }));
      });
    }
  }
  return output;
}

class AggregateQuery {
  constructor(Model, pipeline = []) {
    this.Model = Model;
    this.pipeline = pipeline;
  }

  allowDiskUse() {
    return this;
  }

  async exec() {
    let pipeline = this.pipeline || [];
    let rows;
    if (pipeline[0] && pipeline[0].$match) {
      rows = await this.Model.find(pipeline[0].$match).lean();
      pipeline = pipeline.slice(1);
    } else {
      rows = await this.Model.find({}).lean();
    }
    return runPipeline(rows, pipeline);
  }

  then(resolve, reject) {
    return this.exec().then(resolve, reject);
  }

  catch(reject) {
    return this.exec().catch(reject);
  }
}

function duplicateWriteError(error, index = 0) {
  const writeError = new Error(error.message || 'Duplicate key');
  writeError.code = 11000;
  writeError.index = index;
  writeError.errmsg = error.message;
  return writeError;
}

function isUniqueError(error) {
  return error && (error.code === 'P2002' || /unique|duplicate/i.test(String(error.message || '')));
}

function makeBulkError(writeErrors, insertedCount) {
  const error = new Error('Bulk write failed');
  error.writeErrors = writeErrors;
  error.result = { insertedCount, result: { nInserted: insertedCount, writeErrors } };
  return error;
}

function applyUpdate(doc = {}, update = {}, { inserting = false } = {}) {
  if (Array.isArray(update)) {
    return update.reduce((next, stage = {}) => {
      const current = { ...next };
      if (stage.$set || stage.$addFields) {
        Object.entries(stage.$set || stage.$addFields).forEach(([key, expr]) => {
          current[key] = evaluateExpression(expr, current);
        });
      }
      if (stage.$unset) {
        const fields = Array.isArray(stage.$unset) ? stage.$unset : Object.keys(stage.$unset);
        fields.forEach((key) => delete current[key]);
      }
      return current;
    }, { ...doc });
  }

  const next = { ...doc };
  const operatorUpdate = Object.keys(update || {}).some((key) => key.startsWith('$'));
  if (!operatorUpdate) return { ...next, ...update };
  if (update.$set) Object.assign(next, update.$set);
  if (inserting && update.$setOnInsert) Object.assign(next, update.$setOnInsert);
  if (update.$unset) Object.keys(update.$unset).forEach((key) => delete next[key]);
  if (update.$inc) {
    Object.entries(update.$inc).forEach(([key, value]) => {
      next[key] = numberValue(next[key]) + numberValue(value);
    });
  }
  if (update.$push) {
    Object.entries(update.$push).forEach(([key, value]) => {
      const items = value && value.$each ? value.$each : [value];
      const current = Array.isArray(next[key]) ? next[key] : next[key] === undefined ? [] : [next[key]];
      next[key] = current.concat(items);
    });
  }
  if (update.$addToSet) {
    Object.entries(update.$addToSet).forEach(([key, value]) => {
      const items = value && value.$each ? value.$each : [value];
      const current = Array.isArray(next[key]) ? next[key].slice() : next[key] === undefined ? [] : [next[key]];
      items.forEach((item) => {
        if (!current.some((existing) => JSON.stringify(existing) === JSON.stringify(item))) current.push(item);
      });
      next[key] = current;
    });
  }
  return next;
}

function filterSeed(filter = {}) {
  const output = {};
  Object.entries(filter || {}).forEach(([key, value]) => {
    if (key.startsWith('$')) return;
    if (key === '_id') output._id = value;
    else if (!isPlainObject(value) && !(value instanceof RegExp)) output[key] = value;
  });
  return output;
}

function createModel(config) {
  const delegateName = config.delegate;
  const tableName = config.tableName;
  const indexes = config.indexes || [];
  const defaults = config.defaults || {};

  class Model extends Document {
    constructor(data = {}) {
      super(Model, data, true);
    }

    static get collection() {
      return { name: tableName };
    }

    static get schema() {
      return { indexes: () => indexes };
    }

    static get __delegate() {
      return prisma[delegateName];
    }

    static async __prepare(data = {}, options = {}) {
      const prepared = { ...defaults, ...data };
      if (typeof config.prepare === 'function') await config.prepare(prepared, options);
      return prepared;
    }

    static async __save(input = {}, options = {}) {
      const rawId = input._id || input.id || randomUUID();
      const id = String(rawId);
      const prepared = await this.__prepare({ ...input, id, _id: id }, options);
      prepared.id = id;
      prepared._id = id;
      const row = buildRow(prepared, id);
      const saved = await this.__delegate.upsert({
        where: { id },
        create: row,
        update: row
      });
      return new Document(this, publicRow(saved), false);
    }

    static async __findRows(filter = {}, options = {}) {
      const where = predicateSql(filter);
      const limit = Number(options.limit || 0);
      const skip = Number(options.skip || 0);
      const order = orderSql(options.sort);
      const limitSql = where.supported && limit ? Prisma.sql` LIMIT ${limit}` : Prisma.empty;
      const offsetSql = where.supported && skip ? Prisma.sql` OFFSET ${skip}` : Prisma.empty;
      const sql = Prisma.sql`SELECT * FROM ${Prisma.raw(quoteIdent(tableName))} WHERE ${where.sql}${order}${limitSql}${offsetSql}`;
      let records = await prisma.$queryRaw(sql);
      let rows = records.map(publicRow).filter((row) => matchesFilter(row, filter));
      if (!where.supported) {
        rows = sortRows(rows, options.sort || {});
        if (skip) rows = rows.slice(skip);
        if (limit) rows = rows.slice(0, limit);
      }
      if (options.single && rows.length > 1) return rows.slice(0, 1);
      return rows;
    }

    static find(filter = {}) {
      return new Query(this, filter);
    }

    static findOne(filter = {}) {
      return new Query(this, filter, { single: true, limit: 1 });
    }

    static findById(id) {
      return this.findOne({ _id: String(id || '') });
    }

    static async create(data, options = {}) {
      if (Array.isArray(data)) {
        const docs = [];
        for (const item of data) docs.push(await this.create(item, options));
        return docs;
      }
      return new this(data).save();
    }

    static async insertMany(items = [], options = {}) {
      const inserted = [];
      const writeErrors = [];
      for (let index = 0; index < items.length; index += 1) {
        try {
          inserted.push(await this.create(items[index]));
        } catch (error) {
          if (isUniqueError(error) && options.ordered === false) writeErrors.push(duplicateWriteError(error, index));
          else throw error;
        }
      }
      if (writeErrors.length) throw makeBulkError(writeErrors, inserted.length);
      return inserted;
    }

    static async countDocuments(filter = {}) {
      const where = predicateSql(filter);
      if (where.supported) {
        const rows = await prisma.$queryRaw(Prisma.sql`SELECT COUNT(*)::int AS count FROM ${Prisma.raw(quoteIdent(tableName))} WHERE ${where.sql}`);
        return Number(rows[0]?.count || 0);
      }
      return (await this.find(filter).lean()).length;
    }

    static estimatedDocumentCount() {
      return this.__delegate.count();
    }

    static async exists(filter = {}) {
      const row = await this.findOne(filter).select('_id').lean();
      return row ? { _id: row._id } : null;
    }

    static async distinct(field, filter = {}) {
      const rows = await this.find(filter).select(`${field}`).lean();
      return Array.from(new Set(rows.map((row) => row[field]).filter((value) => value !== undefined && value !== null)));
    }

    static async updateOne(filter = {}, update = {}, options = {}) {
      const existing = await this.findOne(filter).lean();
      if (!existing) {
        if (!options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
        const doc = applyUpdate(filterSeed(filter), update, { inserting: true });
        const created = await this.create(doc);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: created._id };
      }
      const next = applyUpdate(existing, update);
      await this.__save(next, { isNew: false });
      return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
    }

    static async updateMany(filter = {}, update = {}) {
      const rows = await this.find(filter).lean();
      for (const row of rows) await this.__save(applyUpdate(row, update), { isNew: false });
      return { matchedCount: rows.length, modifiedCount: rows.length };
    }

    static async __findOneAndUpdate(filter = {}, update = {}, options = {}) {
      const existing = await this.findOne(filter).lean();
      if (!existing) {
        if (!options.upsert) return null;
        const created = await this.create(applyUpdate(filterSeed(filter), update, { inserting: true }));
        return created;
      }
      const before = { ...existing };
      const saved = await this.__save(applyUpdate(existing, update), { isNew: false });
      return options.new ? saved : new Document(this, before, false);
    }

    static findOneAndUpdate(filter = {}, update = {}, options = {}) {
      return new MutationQuery(() => this.__findOneAndUpdate(filter, update, options));
    }

    static findByIdAndUpdate(id, update = {}, options = {}) {
      return this.findOneAndUpdate({ _id: String(id || '') }, update, options);
    }

    static async deleteMany(filter = {}) {
      const where = predicateSql(filter);
      if (where.supported) {
        const deletedCount = await prisma.$executeRaw(Prisma.sql`DELETE FROM ${Prisma.raw(quoteIdent(tableName))} WHERE ${where.sql}`);
        return { deletedCount: Number(deletedCount) || 0 };
      }

      const rows = await this.find(filter).select('_id').lean();
      if (!rows.length) return { deletedCount: 0 };

      const ids = rows.map((row) => row._id).filter(Boolean);
      const batchSize = 1000;
      let deletedCount = 0;

      for (let index = 0; index < ids.length; index += batchSize) {
        const batch = ids.slice(index, index + batchSize);
        if (!batch.length) continue;
        const result = await this.__delegate.deleteMany({ where: { id: { in: batch } } });
        deletedCount += Number(result?.count ?? result?.deletedCount ?? batch.length) || 0;
      }

      return { deletedCount };
    }

    static async deleteOne(filter = {}) {
      const row = await this.findOne(filter).select('_id').lean();
      if (!row) return { deletedCount: 0 };
      await this.__delegate.delete({ where: { id: row._id } });
      return { deletedCount: 1 };
    }

    static findByIdAndDelete(id) {
      return new MutationQuery(async () => {
        const row = await this.findById(id).lean();
        if (!row) return null;
        await this.deleteOne({ _id: row._id });
        return new Document(this, row, false);
      });
    }

    static findOneAndDelete(filter = {}) {
      return new MutationQuery(async () => {
        const row = await this.findOne(filter).lean();
        if (!row) return null;
        await this.deleteOne({ _id: row._id });
        return new Document(this, row, false);
      });
    }

    static async bulkWrite(operations = [], options = {}) {
      let insertedCount = 0;
      let modifiedCount = 0;
      let deletedCount = 0;
      let upsertedCount = 0;
      const writeErrors = [];
      for (let index = 0; index < operations.length; index += 1) {
        const operation = operations[index] || {};
        try {
          if (operation.insertOne) {
            await this.create(operation.insertOne.document || {});
            insertedCount += 1;
          } else if (operation.updateOne) {
            const result = await this.updateOne(operation.updateOne.filter || {}, operation.updateOne.update || {}, { upsert: operation.updateOne.upsert });
            modifiedCount += result.modifiedCount || 0;
            upsertedCount += result.upsertedCount || 0;
          } else if (operation.deleteOne) {
            const result = await this.deleteOne(operation.deleteOne.filter || {});
            deletedCount += result.deletedCount || 0;
          } else if (operation.deleteMany) {
            const result = await this.deleteMany(operation.deleteMany.filter || {});
            deletedCount += result.deletedCount || 0;
          }
        } catch (error) {
          if (isUniqueError(error) && options.ordered === false) writeErrors.push(duplicateWriteError(error, index));
          else throw error;
        }
      }
      if (writeErrors.length) throw makeBulkError(writeErrors, insertedCount);
      return { insertedCount, modifiedCount, deletedCount, upsertedCount, matchedCount: modifiedCount };
    }

    static aggregate(pipeline = []) {
      return new AggregateQuery(this, pipeline);
    }

    static createIndexes() {
      return Promise.resolve();
    }
  }

  return Model;
}

module.exports = {
  createModel,
  matchesFilter
};
