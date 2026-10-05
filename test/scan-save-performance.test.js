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
  assert.match(calls[0].sql, /pg_advisory_xact_lock\(hashtextextended\(\?, 0\)\)/);
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
