const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { searchOptions, candidateQuery, recordsQuery, partSuggestions } = require('../services/PartSuggestionService');

test('search input is bounded and result limit never exceeds ten', () => {
  assert.deepEqual(searchOptions({ q: ' 20k ', limit: 1000 }), { q: '20K', limit: 10 });
  assert.equal(searchOptions({ q: 'a'.repeat(1000), limit: 'nan' }).q.length, 120);
  assert.equal(searchOptions({ limit: -5 }).limit, 1);
  assert.equal(searchOptions({ limit: 'nan' }).limit, 10);
});

test('SQL uses bounded indexed lookup and binds query/dealer/limit values', () => {
  const malicious = "20K%' OR 1=1 --";
  const query = candidateQuery('MASTER_PART', 'prefix', malicious, 'D1', 10, ['DONE']);
  assert.ok(!query.text.includes(malicious));
  assert.ok(query.values.includes("20K\\%' OR 1=1 --%"));
  assert.ok(query.values.includes('D1'));
  assert.match(query.text, /LIMIT \$/);
  assert.match(query.text, /"dealerCode" IS NULL/);
  assert.match(query.text, /NOT IN/);
  assert.throws(() => candidateQuery('INVENTORY', 'exact', '20K', '', 10));
  const details = recordsQuery('MASTER_PART', ['20K'], 'D1');
  assert.match(details.text, /position <= 25/);
  assert.match(details.text, /row_number/);
});

test('exact, prefix and partial results are deduplicated and use one master-price resolver', async () => {
  const seen = [];
  const client = { $queryRaw: async query => {
    seen.push(query);
    if (query.text.startsWith('SELECT data')) {
      return ['20K', '20K211', 'X20K'].map(partNumber => ({ partNumber, normalizedPartNumber: partNumber,
        data: { partDescription: 'Shared test detail', mrp: 770, dlc: 600 } }));
    }
    if (query.values.includes('20K%')) return [{ partNumber: '20K211' }];
    if (query.values.includes('%20K%')) return [{ partNumber: 'X20K' }];
    return [{ partNumber: '20K' }];
  } };
  const parts = await partSuggestions({ q: '20k', limit: 10 }, 'D1', client);
  assert.deepEqual(parts.map(part => part.partNumber), ['20K', '20K211', 'X20K']);
  assert.ok(parts.every(part => part.mrp === 770 && part.dlc === 600 && part.partDescription === 'SHARED TEST DETAIL'));
  assert.ok(parts.every(part => !('data' in part) && !('sourceRecord' in part)));
  assert.equal(seen.length, 8);
});

test('empty queries access no database and full exact/prefix results skip partial work', async () => {
  const client = { $queryRaw: () => assert.fail('No database work for an empty query') };
  assert.deepEqual(await partSuggestions({ q: ' ' }, 'D1', client), []);
  let candidates = 0;
  const fullClient = { $queryRaw: async query => {
    if (query.text.startsWith('SELECT data')) return [{ partNumber: '20K', data: { mrp: 1 } }];
    candidates++; return [{ partNumber: '20K' }];
  } };
  await partSuggestions({ q: '20K', limit: 1 }, 'D1', fullClient);
  assert.equal(candidates, 2);
});

test('web, mobile web and Android all call canonical suggestions with no stock selection writes', () => {
  for (const file of ['public/ui.js', 'public/scan.js', 'public/js/app.js', 'mobile_scanner_app/lib/services/api_client.dart']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /\/api\/parts\/suggestions\?/);
  }
  const component = fs.readFileSync('public/js/smart-part-search.js', 'utf8');
  assert.match(component, /}, 200\)/);
  assert.match(component, /version !== sequence/);
  assert.match(component, /displayedScope !== scope/);
  assert.match(component, /button.type = 'button'/);
  assert.ok(!component.includes('requestSubmit'));
  const auth = fs.readFileSync('routes/auth.js', 'utf8');
  const scoped = auth.slice(auth.indexOf('function isDealerScopedRequest('), auth.indexOf('async function validateUserDealerAccess('));
  assert.ok(scoped.includes("'/api/parts'"));
});
