const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { parseScanValue } = require('../utils/scanParser');
const { parseSlashDelimitedUpi } = require('../utils/inventoryValueEngine');
const { normalizeScan } = require('../routes/sync');

const cases = [
  ['D/132/HE5B0199510/EBHPE5EQTWD4/44831KVH900S      /001/20170505125743/00', { part: '44831KVH900S', qty: 1, uniqueId: 'EBHPE5EQTWD4' }],
  ['D/GCJG0000991624/CCGGT289DMFE/K99996ABSE001S    /000001/0000349.00/AAC/1/G/000/00', { part: 'K99996ABSE001S', qty: 1, uniqueId: 'CCGGT289DMFE' }],
  ['D/GCSG0000272850/CCG8FN2C6D4C/957010805000S     /000010/0000011.00/AAB/1/G/000/00', { part: '957010805000S', qty: 10, uniqueId: 'CCG8FN2C6D4C' }],
  ['D/FDWG0000852103/DCF7PL8MCW8A/957010805000S     /000010/0000011.00/AAB/1/G/000/00', { part: '957010805000S', qty: 10, uniqueId: 'DCF7PL8MCW8A' }],
  ['D/130/JABC0040512/ABJP5929U2C7/19510KTP900S      /001/20180111081312/00', { part: '19510KTP900S', qty: 1, uniqueId: 'ABJP5929U2C7' }],
  ['D/BCSG0000693868/CCBWR5ZSBY3Y/14610AAT001S      /000005/0000025.00/AAA/1/G/000/00', { part: '14610AAT001S', qty: 5, uniqueId: 'CCBWR5ZSBY3Y' }],
  ['D/CB9G0000323033/BCCS23AJXK2P/35200KVT911S      /000003/0000050.00/AAC/1/G/000/00', { part: '35200KVT911S', qty: 3, uniqueId: 'BCCS23AJXK2P' }],
  ['D/124/KAQB0341282/ABKBT8CFNZBG/42303KZAW00S      /003/20190124165552/00', { part: '42303KZAW00S', qty: 3, uniqueId: 'ABKBT8CFNZBG' }],
  ['D/BLQG0000269248/LCBV2TYLL8PT/53155AAW000S      /0000010/0000010.00/AAB/1/G/000/00', { part: '53155AAW000S', qty: 10, uniqueId: 'LCBV2TYLL8PT' }]
];

test('UPI parser finds the master-matched part token dynamically and extracts the next quantity token', () => {
  for (const [raw, expected] of cases) {
    const parsed = parseScanValue(raw);
    assert.equal(parsed.success, true, `expected successful parse for ${raw}`);
    assert.equal(parsed.type, 'UPI', `expected UPI detection for ${raw}`);
    assert.equal(parsed.partNumber, expected.part, `expected ${expected.part} from ${raw}`);
    assert.equal(parsed.quantity, expected.qty, `expected quantity ${expected.qty} from ${raw}`);
    assert.equal(parsed.upiId, expected.uniqueId, `expected unique ID ${expected.uniqueId} from ${raw}`);
    assert.equal(parsed.rawUpi, raw.trim(), `expected raw UPI to be stored unchanged for ${raw}`);
  }
});

test('browser QR parser matches server parsing for all slash QR samples', () => {
  const browserContext = {};
  vm.runInNewContext(fs.readFileSync('public/js/scan-parser.js', 'utf8'), browserContext);

  for (const [raw, expected] of cases) {
    const parsed = browserContext.DakshScanParser.parseScanValue(raw);
    assert.equal(parsed.success, true, `expected browser parse success for ${raw}`);
    assert.equal(parsed.type, 'UPI', `expected UPI QR for ${raw}`);
    assert.equal(parsed.partNumber, expected.part, `expected ${expected.part} from ${raw}`);
    assert.equal(parsed.quantity, expected.qty, `expected quantity ${expected.qty} from ${raw}`);
    assert.equal(parsed.upiId, expected.uniqueId, `expected UPI ${expected.uniqueId} from ${raw}`);
  }
});

test('UPI field is selected independently of part-master matches in other QR fields', () => {
  const parsed = parseScanValue(cases[0][0], [
    '132',
    'HE5B0199510',
    'EBHPE5EQTWD4',
    '44831KVH900S'
  ]);
  assert.equal(parsed.partNumber, '44831KVH900S');
  assert.equal(parsed.upiId, 'EBHPE5EQTWD4');
});

test('server scan normalization overrides a stale mobile part candidate with the QR part field', () => {
  for (const [raw, expected] of cases) {
    const normalized = normalizeScan({
      source: 'mobile',
      rawScan: raw,
      partNumber: expected.uniqueId,
      dealerCode: '11646',
      binLocation: 'A1'
    });
    assert.equal(normalized.partNumber, expected.part, `server must use QR part field from ${raw}`);
    assert.equal(normalized.upiId, expected.uniqueId, `server must retain QR UPI from ${raw}`);
    assert.equal(normalized.quantity, expected.qty, `server must retain quantity from ${raw}`);
  }
});

test('generic slash QR resolves the part immediately before its numeric quantity', () => {
  const parsed = parseScanValue('OEM/UNIQUE-77/X/19510KTP900S/0002/99.00');
  assert.equal(parsed.type, 'UPI');
  assert.equal(parsed.partNumber, '19510KTP900S');
  assert.equal(parsed.upiId, 'UNIQUE-77');
  assert.equal(parsed.quantity, 2);
});

test('inventory valuation keeps the part and UPI fields separate for both slash formats', () => {
  const hero = parseSlashDelimitedUpi(cases[0][0]);
  assert.equal(hero.partNumber, '44831KVH900S');
  assert.equal(hero.upiId, 'EBHPE5EQTWD4');
  assert.equal(hero.qty, 1);

  const legacy = parseSlashDelimitedUpi('OEM/UPI-987654/X/PART-100/1/500');
  assert.equal(legacy.partNumber, 'PART100');
  assert.equal(legacy.upiId, 'UPI-987654');
  assert.equal(legacy.qty, 1);
});

test('non-UPI barcodes keep normal fallback behavior', () => {
  const parsed = parseScanValue('32410KTC920S');
  assert.equal(parsed.type, 'NORMAL_BARCODE');
  assert.equal(parsed.partNumber, '32410KTC920S');
  assert.equal(parsed.rawUpi, null);
});
