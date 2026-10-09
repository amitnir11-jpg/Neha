const { Prisma } = require('@prisma/client');
const { getPrismaClient } = require('./prisma');
const { mergePriceRecordCandidates } = require('../utils/partMasterPrice');

const SOURCES = { MASTER_CATALOGUE: 'mastercatalogues', MASTER_PART: 'masterparts' };
// These expressions also appear in the dedicated prefix/trigram indexes.
const PART_KEY = Prisma.raw(`upper(COALESCE(NULLIF("normalizedPartNumber", ''), "partNumber", data->>'partNo', data->>'part', ''))`);
const DESCRIPTION = Prisma.raw(`upper(COALESCE(data->>'partDescription', data->>'partName', ''))`);
const escapeLike = value => value.replace(/[\\%_]/g, character => `\\${character}`);

function searchOptions(input = {}) {
  const q = String(input.q ?? input.query ?? input.partNumber ?? '').trim().toUpperCase();
  const suppliedLimit = Number(input.limit ?? 10);
  return { q: q.slice(0, 120), limit: Number.isFinite(suppliedLimit) ? Math.min(10, Math.max(1, Math.floor(suppliedLimit))) : 10 };
}

function dealerScope(dealerCode) {
  return dealerCode ? Prisma.sql`("dealerCode" IS NULL OR "dealerCode" = '' OR upper("dealerCode") IN (${dealerCode}, 'ALL'))` : Prisma.sql`TRUE`;
}

function candidateQuery(source, stage, q, dealerCode, limit, excluded = []) {
  if (!SOURCES[source]) throw new Error('Invalid master source');
  const prefix = `${escapeLike(q)}%`;
  const partial = `%${escapeLike(q)}%`;
  const match = stage === 'exact' ? Prisma.sql`${PART_KEY} = ${q}`
    : stage === 'prefix' ? Prisma.sql`${PART_KEY} LIKE ${prefix}`
      : Prisma.sql`(${PART_KEY} LIKE ${partial} OR ${DESCRIPTION} LIKE ${partial})`;
  const exclusion = excluded.length ? Prisma.sql`AND ${PART_KEY} NOT IN (${Prisma.join(excluded)})` : Prisma.empty;
  return Prisma.sql`SELECT DISTINCT ${PART_KEY} COLLATE "C" AS "partNumber" FROM ${Prisma.raw(SOURCES[source])}
    WHERE ${dealerScope(dealerCode)} AND ${match} AND ${PART_KEY} <> '' ${exclusion}
    ORDER BY "partNumber" LIMIT ${limit}`;
}

function recordsQuery(source, parts, dealerCode) {
  return Prisma.sql`SELECT data, "partNumber", "normalizedPartNumber", "dealerCode", "createdAt", "updatedAt" FROM (
    SELECT data, "partNumber", "normalizedPartNumber", "dealerCode", "createdAt", "updatedAt",
      row_number() OVER (PARTITION BY ${PART_KEY} ORDER BY "updatedAt" DESC, id DESC) AS position
    FROM ${Prisma.raw(SOURCES[source])} WHERE ${dealerScope(dealerCode)} AND ${PART_KEY} IN (${Prisma.join(parts)})
  ) records WHERE position <= 25`;
}

async function partSuggestions(input, dealerCode = '', client = getPrismaClient()) {
  const { q, limit } = searchOptions(input);
  if (!q) return [];
  dealerCode = String(dealerCode || '').trim().toUpperCase();
  const numbers = [];
  for (const stage of ['exact', 'prefix', 'partial']) {
    if (numbers.length >= limit) break;
    const rows = await Promise.all(Object.keys(SOURCES).map(source =>
      client.$queryRaw(candidateQuery(source, stage, q, dealerCode, limit - numbers.length, numbers))));
    const matches = [...new Set(rows.flat().map(row => row.partNumber))].sort();
    numbers.push(...matches.slice(0, limit - numbers.length));
  }
  if (!numbers.length) return [];
  const byNumber = new Map(numbers.map(number => [number, []]));
  await Promise.all(Object.keys(SOURCES).map(async source => {
    const rows = await client.$queryRaw(recordsQuery(source, numbers, dealerCode));
    for (const row of rows) {
      const record = { ...(row.data || {}), ...row, data: undefined };
      const number = String(record.normalizedPartNumber || record.partNumber || record.partNo || record.part || '').toUpperCase();
      byNumber.get(number)?.push({ source, record });
    }
  }));
  return numbers.map(number => {
    const price = mergePriceRecordCandidates(byNumber.get(number), dealerCode);
    if (!price) return null;
    return {
      partNumber: price.partNumber, partDescription: price.description,
      mrp: price.mrp, dlc: price.dlc, category: price.category,
      model: price.model, year: price.year, productGroup: price.productGroup
    };
  }).filter(Boolean);
}

async function suggestionsHandler(req, res) {
  try {
    const requestedDealer = req.activeDealerId || req.query.dealerCode || req.query.activeDealerId || '';
    const dealerCode = requestedDealer === 'ALL' ? '' : requestedDealer;
    if (!dealerCode && !['admin', 'super_admin'].includes(req.user?.role)) {
      return res.status(400).json({ success: false, message: 'Select dealer first' });
    }
    const suggestions = await partSuggestions(req.query, dealerCode);
    res.set('Cache-Control', 'private, no-store');
    if (req.baseUrl === '/api/parts') return res.json({ success: true, suggestions });
    // Compatibility for previously installed APKs; all aliases use this engine.
    const parts = suggestions.map(part => ({ ...part, partNo: part.partNumber, partName: part.partDescription, productCategory: part.category }));
    return res.json({ success: true, suggestions: parts, parts });
  } catch (error) {
    return res.status(503).json({ success: false, message: 'Part suggestions are temporarily unavailable. Please retry.' });
  }
}

module.exports = { partSuggestions, searchOptions, candidateQuery, recordsQuery, suggestionsHandler };
