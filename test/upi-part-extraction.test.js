const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { parseScanValue } = require('../utils/scanParser');

const cases = [
  ['D/132/HE5B0199510/EBHPE5EQTWD4/44831KVH900S      /001/20170505125743/00', { part: '44831KVH900S', qty: 1 }],
  ['D/GCJG0000991624/CCGGT289DMFE/K99996ABSE001S    /000001/0000349.00/AAC/1/G/000/00', { part: 'K99996ABSE001S', qty: 1 }],
  ['D/GCSG0000272850/CCG8FN2C6D4C/957010805000S     /000010/0000011.00/AAB/1/G/000/00', { part: '957010805000S', qty: 10 }],
  ['D/FDWG0000852103/DCF7PL8MCW8A/957010805000S     /000010/0000011.00/AAB/1/G/000/00', { part: '957010805000S', qty: 10 }],
  ['D/130/JABC0040512/ABJP5929U2C7/19510KTP900S      /001/20180111081312/00', { part: '19510KTP900S', qty: 1 }],
  ['D/BCSG0000693868/CCBWR5ZSBY3Y/14610AAT001S      /000005/0000025.00/AAA/1/G/000/00', { part: '14610AAT001S', qty: 5 }],
  ['D/CB9G0000323033/BCCS23AJXK2P/35200KVT911S      /000003/0000050.00/AAC/1/G/000/00', { part: '35200KVT911S', qty: 3 }],
  ['D/124/KAQB0341282/ABKBT8CFNZBG/42303KZAW00S      /003/20190124165552/00', { part: '42303KZAW00S', qty: 3 }],
  ['D/BLQG0000269248/LCBV2TYLL8PT/53155AAW000S      /0000010/0000010.00/AAB/1/G/000/00', { part: '53155AAW000S', qty: 10 }]
];

test('UPI parser finds the master-matched part token dynamically and extracts the next quantity token', () => {
  for (const [raw, expected] of cases) {
    const parsed = parseScanValue(raw);
    assert.equal(parsed.success, true, `expected successful parse for ${raw}`);
    assert.equal(parsed.type, 'UPI', `expected UPI detection for ${raw}`);
    assert.equal(parsed.partNumber, expected.part, `expected ${expected.part} from ${raw}`);
    assert.equal(parsed.quantity, expected.qty, `expected quantity ${expected.qty} from ${raw}`);
    assert.equal(parsed.rawUpi, raw.trim(), `expected raw UPI to be stored unchanged for ${raw}`);
  }
});

test('browser QR parser accepts the seven-digit zero-padded Hero QR quantity', () => {
  const browserContext = {};
  vm.runInNewContext(fs.readFileSync('public/js/scan-parser.js', 'utf8'), browserContext);

  const [raw, expected] = cases[cases.length - 1];
  const parsed = browserContext.DakshScanParser.parseScanValue(raw);
  assert.equal(parsed.success, true);
  assert.equal(parsed.type, 'UPI');
  assert.equal(parsed.partNumber, expected.part);
  assert.equal(parsed.quantity, expected.qty);
});

test('non-UPI barcodes keep normal fallback behavior', () => {
  const parsed = parseScanValue('32410KTC920S');
  assert.equal(parsed.type, 'NORMAL_BARCODE');
  assert.equal(parsed.partNumber, '32410KTC920S');
  assert.equal(parsed.rawUpi, null);
});
