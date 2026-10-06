const assert = require('node:assert/strict');
const test = require('node:test');

test('optional slow-query logging records duration and SQL without string literals', () => {
  const prismaPath = require.resolve('../services/prisma');
  const clientPath = require.resolve('@prisma/client');
  const previousPrisma = require.cache[prismaPath];
  const previousClient = require.cache[clientPath];
  const previousThreshold = process.env.PRISMA_SLOW_QUERY_MS;
  const originalWarn = console.warn;
  class TestPrismaClient {
    constructor(options) {
      this.options = options;
    }

    $on(event, listener) {
      this.eventName = event;
      this.listener = listener;
    }
  }

  process.env.PRISMA_SLOW_QUERY_MS = '10';
  require.cache[clientPath] = {
    id: clientPath,
    filename: clientPath,
    loaded: true,
    exports: {
      PrismaClient: TestPrismaClient,
      Prisma: { TransactionIsolationLevel: { Serializable: 'Serializable' } }
    }
  };
  delete require.cache[prismaPath];

  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    const { prisma } = require('../services/prisma');
    assert.equal(prisma.eventName, 'query');
    assert.ok(prisma.options.log.some((item) => item && item.emit === 'event' && item.level === 'query'));

    prisma.listener({ duration: 9, query: 'SELECT 1', target: 'db' });
    prisma.listener({
      duration: 12,
      query: "SELECT * FROM users WHERE email = 'private@example.test'",
      target: 'db'
    });

    assert.equal(warnings.length, 1);
    assert.match(warnings[0][0], /\[SLOW QUERY\]/);
    assert.match(warnings[0][1], /"durationMs":12/);
    assert.doesNotMatch(warnings[0][1], /private@example\.test/);
    assert.match(warnings[0][1], /email = '\?'/);
  } finally {
    console.warn = originalWarn;
    if (previousThreshold === undefined) delete process.env.PRISMA_SLOW_QUERY_MS;
    else process.env.PRISMA_SLOW_QUERY_MS = previousThreshold;
    if (previousPrisma) require.cache[prismaPath] = previousPrisma;
    else delete require.cache[prismaPath];
    if (previousClient) require.cache[clientPath] = previousClient;
    else delete require.cache[clientPath];
  }
});
