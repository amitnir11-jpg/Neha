const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const { normalizePartNumber } = require('../utils/normalize');

function evaluateFunction(sourcePath, startMarker, endMarker, context) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `Missing ${startMarker}`);
  assert.notEqual(end, -1, `Missing ${endMarker}`);
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context;
}

test('part-number history searches try exact normalized values before substring fallback', () => {
  const context = evaluateFunction(
    'routes/inventory.js',
    'function scanHistoryPartClause(',
    'function applyScanVisibility(',
    {
      upper: value => String(value || '').trim().toUpperCase(),
      normalizePartNumber,
      escapeRegex: value => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  );

  const partFilter = context.scanHistoryPartClause('13011KCC942S');
  const partClause = Array.from(partFilter.$or);
  assert.deepEqual(Array.from(partFilter.$or, item => Object.keys(item)[0]), [
    'normalizedPartNumber', 'partNumber', 'part'
  ]);
  assert.ok(partClause.every(item => item[Object.keys(item)[0]] === '13011KCC942S'));

  const fallbackFilter = context.scanHistoryPartClause('13011KCC942S', { exactPart: false });
  assert.equal(fallbackFilter.$or.length, 6);
  assert.equal(fallbackFilter.$or[0].part.$regex, '13011KCC942S');
  assert.equal(fallbackFilter.$or[0].part.$options, 'i');

  const textFilter = context.scanHistoryPartClause('piston ring');
  assert.equal(textFilter.$or.length, 6);
  assert.equal(textFilter.$or[0].part.$regex, 'PISTON RING');
  assert.equal(textFilter.$or[0].part.$options, 'i');
});

test('Scan History outward movements deduct the requested quantity without reusing QR identity', () => {
  let id = 0;
  const context = evaluateFunction(
    'routes/inventory.js',
    'function buildScanHistoryOutwardMovement(',
    'async function verifyPartOnly(',
    {
      clean: value => String(value || '').trim(),
      normalizeDealerCode: value => String(value || '').trim().toUpperCase(),
      normalizePartNumber,
      numberValue: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
      randomUUID: () => `outward-${++id}`,
      upper: value => String(value || '').trim().toUpperCase()
    }
  );
  const timestamp = new Date('2026-01-02T03:04:05.000Z');
  const movement = context.buildScanHistoryOutwardMovement({
    _id: 'source-scan',
    dealerCode: 'd01',
    auditId: 'audit-1',
    partNumber: 'PART-123',
    binLocation: 'bin-4',
    qty: 8,
    upiCode: 'QR-IDENTITY',
    rawScanString: 'QR-IDENTITY/PART-123',
    valuationMRP: 12.5
  }, 3, { id: 'admin-1', username: 'admin', role: 'admin' }, timestamp);

  assert.equal(movement.scanType, 'OUTWARD');
  assert.equal(movement.qty, 3);
  assert.equal(movement.binLocation, 'BIN-4');
  assert.equal(movement.dealerCode, 'D01');
  assert.equal(movement.sourceScanId, 'source-scan');
  assert.equal(movement.scanStatus, 'OUTWARD_DONE');
  assert.equal(movement.syncStatus, 'synced');
  assert.equal(movement.activeInventory, false);
  assert.equal(movement.upiCode, '');
  assert.equal(movement.rawScanString, '');
  assert.equal(movement.globalUpiKey, '');
  assert.equal(movement.finalInventoryValue, 37.5);
  assert.equal(movement.timestamp, timestamp);
});

test('Scan History outward movement reduces available stock in its bin', async () => {
  const inward = {
    dealerCode: 'D01', auditId: 'AUD-1', partNumber: 'PART-123',
    binLocation: 'BIN-4', scanType: 'INWARD', scanStatus: 'ACCEPTED',
    syncStatus: 'synced', qty: 8
  };
  const outward = {
    dealerCode: 'D01', auditId: 'AUD-1', partNumber: 'PART-123',
    binLocation: 'BIN-4', scanType: 'OUTWARD', scanStatus: 'OUTWARD_DONE',
    syncStatus: 'synced', qty: 3, uniqueScanId: 'outward-1'
  };
  const context = evaluateFunction(
    'routes/inventory.js',
    'async function availableInwardStock(',
    'function buildScanHistoryOutwardMovement(',
    {
      Inventory: {
        find: () => ({
          sort: () => ({ lean: async () => [inward, outward] })
        })
      },
      inwardQty: scan => scan.scanType === 'INWARD' ? Math.abs(Number(scan.qty || 0)) : 0,
      partStockMatch: () => ({ $and: [{ $or: [] }] }),
      stockQty: scan => scan.scanType === 'INWARD' ? Number(scan.qty || 0) : -Number(scan.qty || 0),
      uniqueReportScans: rows => rows,
      upper: value => String(value || '').trim().toUpperCase()
    }
  );

  const stock = await context.availableInwardStock({
    dealerCode: 'D01', auditId: 'AUD-1', partNumber: 'PART-123'
  });
  assert.equal(stock.availableQty, 5);
  assert.equal(stock.bins[0].binLocation, 'BIN-4');
  assert.equal(stock.bins[0].availableQty, 5);
});

test('UPI advisory lock is scoped to the transaction and not used without a key', async () => {
  const calls = [];
  const context = evaluateFunction(
    'routes/sync.js',
    'async function lockUpiIdentity(',
    'async function saveNormalizedScan(',
    {
      clean: value => String(value || '').trim(),
      getPrismaClient: () => ({
        async $queryRaw(strings, ...values) {
          calls.push({ sql: strings.join('?'), values });
        }
      })
    }
  );

  await context.lockUpiIdentity({});
  assert.equal(calls.length, 0);
  await context.lockUpiIdentity({ globalUpiKey: 'identity-key' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /pg_advisory_xact_lock\(hashtextextended\(\?, 0\)\) IS NULL AS locked/);
  assert.deepEqual(calls[0].values, ['daksh-upi:identity-key']);
});

test('manual duplicate and request-identity checks run concurrently', async () => {
  const calls = [];
  let finishManual;
  let finishIdentity;
  const manualResult = new Promise(resolve => { finishManual = resolve; });
  const identityResult = new Promise(resolve => { finishIdentity = resolve; });
  const context = evaluateFunction(
    'routes/sync.js',
    'async function scanPolicyResult(',
    'async function lockUpiIdentity(',
    {
      clean: value => String(value || '').trim(),
      duplicatePolicy: {
        globalUpiKey: () => 'key',
        activeUpiDuplicateFilter: () => null,
        identityDuplicateFilter: () => ({ uniqueScanId: 'scan-1' }),
        rawUpiHash: () => ''
      },
      Inventory: {
        findOne: () => ({
          sort: () => ({
            lean: () => {
              calls.push('identity');
              return identityResult;
            }
          })
        })
      },
      findManualPartBinDuplicate: () => {
        calls.push('manual');
        return manualResult;
      },
      requestedQuantity: () => 1,
      manualDuplicatePayload: () => ({}),
      duplicateQuery: () => ({}),
      normalizePartNumber: value => value,
      upper: value => String(value || '').toUpperCase()
    }
  );

  const result = context.scanPolicyResult({ scanType: 'INWARD' });
  await new Promise(setImmediate);
  assert.deepEqual(calls.sort(), ['identity', 'manual']);
  finishManual(null);
  finishIdentity(null);
  assert.equal((await result).ok, true);
});
