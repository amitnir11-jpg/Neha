const test = require('node:test');
const assert = require('node:assert/strict');
const { Prisma } = require('@prisma/client');
const { buildRow, predicateSql, publicRow } = require('../models/prismaModel');

const model = Prisma.dmmf.datamodel.models.find((item) => item.name === 'PasswordResetToken');
const scalarFields = model.fields.filter((field) => field.kind === 'scalar').map((field) => field.name);
const fieldTypes = new Map(model.fields.map((field) => [field.name, field]));

test('password reset throttling predicate targets relational columns and never references data JSONB', () => {
  const where = predicateSql({
    userId: 'fixture-user',
    appEnv: 'testing',
    createdAt: { $gt: new Date('2026-10-11T12:00:00Z') }
  }, scalarFields, false);

  assert.equal(where.supported, true);
  assert.match(where.sql.sql, /"userId"::text/);
  assert.match(where.sql.sql, /"appEnv"::text/);
  assert.match(where.sql.sql, /"createdAt"/);
  assert.doesNotMatch(where.sql.sql, /"data"/);
});

test('relational token rows contain only declared scalar columns and hydrate without JSONB data', () => {
  const row = buildRow({
    userId: 'fixture-user', tokenHash: 'fixture-hash', expiresAt: new Date('2026-10-11T12:15:00Z'),
    usedAt: null, createdAt: new Date('2026-10-11T12:00:00Z'), appEnv: 'testing'
  }, 'fixture-id', scalarFields, fieldTypes, false);

  assert.equal(Object.hasOwn(row, 'data'), false);
  assert.equal(Object.hasOwn(row, 'updatedAt'), false);
  assert.deepEqual(Object.keys(row).sort(), ['appEnv', 'createdAt', 'expiresAt', 'id', 'tokenHash', 'userId', 'usedAt'].sort());
  const hydrated = publicRow({ ...row, requestIp: null, userAgent: null }, scalarFields, false);
  assert.equal(hydrated._id, 'fixture-id');
  assert.equal(hydrated.userId, 'fixture-user');
  assert.equal(hydrated.expiresAt.toISOString(), '2026-10-11T12:15:00.000Z');
});
