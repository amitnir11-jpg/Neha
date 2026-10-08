const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const parser = require('../utils/scanParser');
const heroQr = 'D/132/HE5B0199510/EBHPE5EQTWD4/44831KVH900S      /001/20170505125743/00';
const suppliedHeroSamples = [
  ['77238KTC900ZCS/G3122000021001', '77238KTC900ZCS', null, 1],
  ['61108AACH40ZCS/D3533000166001', '61108AACH40ZCS', null, 1],
  [heroQr, '44831KVH900S', 'EBHPE5EQTWD4', 1],
  ['D/GCJG0000991624/CCGGT289DMFE/K99996ABSE001S    /000001/0000349.00/AAC/1/G/000/00', 'K99996ABSE001S', 'CCGGT289DMFE', 1],
  ['D/GCSG0000272850/CCG8FN2C6D4C/957010805000S     /000010/0000011.00/AAB/1/G/000/00', '957010805000S', 'CCG8FN2C6D4C', 10],
  ['D/FDWG0000852103/DCF7PL8MCW8A/957010805000S     /000010/0000011.00/AAB/1/G/000/00', '957010805000S', 'DCF7PL8MCW8A', 10],
  ['D/130/JABC0040512/ABJP5929U2C7/19510KTP900S      /001/20180111081312/00', '19510KTP900S', 'ABJP5929U2C7', 1],
  ['D/BCSG0000693868/CCBWR5ZSBY3Y/14610AAT001S      /000005/0000025.00/AAA/1/G/000/00', '14610AAT001S', 'CCBWR5ZSBY3Y', 5]
];

for (const format of ['CODE_128', 'CODE_39', 'EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'ITF', 'CODABAR', 'QR_CODE']) {
  test(`decoded ${format} value is normalized without inventing a mapping`, () => {
    const value = ' \r\n32410ktc920s\t ';
    const parsed = parser.parseScannedCode(value, format);
    assert.equal(parsed.rawValue, value);
    assert.equal(parsed.partNumber, '32410KTC920S');
    assert.equal(parsed.upi, null);
    assert.equal(parsed.quantity, 1);
  });
}
test('supplied Hero QR chooses part field and preceding UPI, including padding', () => {
  for (const raw of [heroQr, `${heroQr} \r\n\t`]) {
    const parsed = parser.parseScannedCode(raw, 'qrCode');
    assert.equal(parsed.partNumber, '44831KVH900S');
    assert.equal(parsed.upi, 'EBHPE5EQTWD4');
    assert.equal(parsed.quantity, 1);
    assert.equal(parsed.sourceType, 'QR');
  }
});
test('browser and backend load the identical parser implementation', () => {
  const context = vm.createContext({ URLSearchParams });
  vm.runInContext(fs.readFileSync('public/js/scan-parser.js', 'utf8'), context);
  for (const raw of [heroQr, '32410KTC920S', '4006381333931', '{"partNumber":"32410KTC920S"}', 'part=32410KTC920S|qty=1']) {
    assert.equal(JSON.stringify(context.DakshScanParser.parseScannedCode(raw, 'UNKNOWN')), JSON.stringify(parser.parseScannedCode(raw, 'UNKNOWN')));
  }
});
test('exact master identity takes precedence over QR shape', () => {
  const raw = 'D/132/HE5B0199510/EBHPE5EQTWD4/44831KVH900S/001';
  assert.equal(parser.parseScannedCode(raw, 'CODE_128', [raw]).type, 'DIRECT_BARCODE');
});
test('older Hero 1D labels extract the Part Master candidate and retain packaging data as SKU', () => {
  const samples = [
    ['77238KTC900ZCS/G3122000021001', '77238KTC900ZCS', 'G3122000021001'],
    ['61108AACH40ZCS/D3533000166001', '61108AACH40ZCS', 'D3533000166001']
  ];
  for (const [raw, partNumber, packagingCode] of samples) {
    const parsed = parser.parseScannedCode(raw, 'CODE_128');
    assert.equal(parsed.success, true);
    assert.equal(parsed.type, 'HERO_LEGACY_1D');
    assert.equal(parsed.partNumber, partNumber);
    assert.equal(parsed.packagingCode, packagingCode);
    assert.equal(parsed.identityKind, 'SKU');
    assert.equal(parsed.hasUniqueItemId, false);
    assert.equal(parsed.rawValue, raw);
  }
});
test('server validates exact candidates, preserves numeric barcode and rejects unknown prefix', async () => {
  const calls = [];
  const master = new Map(['32410KTC920S', '44831KVH900S', '4006381333931', '77238KTC900ZCS', '61108AACH40ZCS'].map(part => [part, { masterRecord: { partNumber: part } }]));
  const context = vm.createContext({ module: { exports: {} }, require: name => name.includes('scanParser') ? parser : {
    getPriceFromPartMaster: async (part, dealer, options) => { calls.push({ part, dealer, options }); return master.get(part) || null; }
  } });
  vm.runInContext(fs.readFileSync('services/ScannedCodeService.js', 'utf8'), context);
  const resolve = context.module.exports.resolveScannedCode;
  assert.equal((await resolve('32410ktc920s ', 'code128', 'D01')).partNumber, '32410KTC920S');
  assert.equal((await resolve(heroQr, 'qrCode', 'D01')).upi, 'EBHPE5EQTWD4');
  assert.equal((await resolve('4006381333931', 'ean13', 'D01')).partNumber, '4006381333931');
  for (const [raw, part] of [
    ['77238KTC900ZCS/G3122000021001', '77238KTC900ZCS'],
    ['61108AACH40ZCS/D3533000166001', '61108AACH40ZCS']
  ]) {
    const resolved = await resolve(raw, 'code128', 'D01');
    assert.equal(resolved.partNumber, part);
    assert.equal(resolved.packagingCode, raw.split('/')[1]);
    assert.equal(resolved.identityKind, 'SKU');
  }
  const unknownHeroPart = await resolve('88888KTC900ZCS/G3122000021001', 'code128', 'D01');
  assert.equal(unknownHeroPart.success, false);
  assert.equal(unknownHeroPart.partNumber, '88888KTC900ZCS');
  assert.match(unknownHeroPart.message, /Raw barcode: 88888KTC900ZCS\/G3122000021001\. Reason: Part 88888KTC900ZCS not found in Part Master for dealer D01/);
  const rejected = await resolve('PREFIX-32410KTC920S', 'code128', 'D01');
  assert.equal(rejected.success, false);
  assert.match(rejected.message, /Raw barcode: PREFIX-32410KTC920S\. Reason: Part PREFIX-32410KTC920S not found in Part Master for dealer D01/);
  assert.equal((await resolve('unrecognized/data', 'qrCode', 'D01')).success, false);
  assert.ok(calls.every(call => call.options.exact === true && call.dealer === 'D01'));
});
test('all eight supplied Hero labels decode and resolve by exact Part Master candidate', async () => {
  const calls = [];
  const parts = [...new Set(suppliedHeroSamples.map((sample) => sample[1]))];
  const master = new Map(parts.map(part => [part, { masterRecord: { partNumber: part } }]));
  const context = vm.createContext({ module: { exports: {} }, require: name => name.includes('scanParser') ? parser : {
    getPriceFromPartMaster: async (part, dealer, options) => { calls.push({ part, dealer, options }); return master.get(part) || null; }
  } });
  vm.runInContext(fs.readFileSync('services/ScannedCodeService.js', 'utf8'), context);
  const resolve = context.module.exports.resolveScannedCode;
  for (const [raw, partNumber, upi, quantity] of suppliedHeroSamples) {
    const parsed = parser.parseScannedCode(raw, 'UNKNOWN');
    const resolved = await resolve(raw, 'UNKNOWN', 'D01');
    assert.equal(parsed.success, true, `parser failed raw=${raw}`);
    assert.equal(resolved.success, true, `master lookup failed raw=${raw}`);
    assert.equal(parsed.rawValue, raw);
    assert.equal(resolved.rawValue, raw);
    assert.equal(resolved.partNumber, partNumber);
    assert.equal(resolved.upi, upi);
    assert.equal(resolved.quantity, quantity);
    if (!upi) {
      assert.equal(resolved.identityKind, 'SKU');
      assert.equal(resolved.hasUniqueItemId, false);
    } else {
      assert.equal(resolved.identityKind, 'UNIQUE_UPI');
      assert.equal(resolved.hasUniqueItemId, true);
    }
  }
  for (const part of parts) assert.ok(calls.some(call => call.part === part));
  assert.ok(calls.every(call => call.options.exact === true && call.dealer === 'D01'));
});
test('same Hero QR UPI yields the same duplicate identity even when scanned in another bin', () => {
  const policy = require('../utils/scanDuplicatePolicy');
  const scan = { rawScanString: heroQr, partNumber: '44831KVH900S', upiId: 'EBHPE5EQTWD4',
    barcodeIdentityKind: 'UNIQUE_UPI', scanType: 'INWARD', dealerCode: 'D01', auditId: 'A1', binLocation: 'BIN-1' };
  const repeated = { ...scan, binLocation: 'BIN-2' };
  assert.equal(policy.uniqueUpiIdentityToken(scan), 'EBHPE5EQTWD4');
  assert.equal(policy.globalUpiKey(scan), policy.globalUpiKey(repeated));
  const filter = policy.activeUpiDuplicateFilter(scan);
  assert.ok(filter.$or.some(term => term.upiId?.$regex === '^EBHPE5EQTWD4(?:::.+)?$'));
  assert.equal(policy.activeUpiDuplicateFilter({ ...scan, barcodeIdentityKind: 'SKU', upiId: '' }), null);
});
test('web camera debounce coalesces repeats but accepts a later legitimate frame', () => {
  const source = fs.readFileSync('public/scan.js', 'utf8');
  let now = 10000;
  const captures = [], logs = [];
  const context = vm.createContext({ state: { mode: 'INWARD', lastDecodeAtByKey: new Map() },
    Date: { now: () => now }, window: { DakshScanParser: parser }, URLSearchParams, location: { search: '?scanDebug=1' },
    storageGet: () => '', DEDUPE_MS: 1800, decodeResultText: result => result.rawValue, cameraState() {}, byId: () => null,
    console: { debug: (...args) => logs.push(args) }, processDecodedText: (...args) => captures.push(args) });
  vm.runInContext(source.slice(source.indexOf('  function handleDecodeResult('), source.indexOf('  async function processDecodedText(')), context);
  context.handleDecodeResult({ rawValue: ' 32410ktc920s\r\n', format: 'code_128' });
  now += 500;
  context.handleDecodeResult({ rawValue: '32410KTC920S', format: 'code_128' });
  now += 1500;
  context.handleDecodeResult({ rawValue: '32410KTC920S', format: 'code_128' });
  assert.equal(captures.length, 2);
  assert.equal(captures[0][1].rawDecodedValue, ' 32410ktc920s\r\n');
  assert.equal(captures[0][1].barcodeFormat, 'CODE_128');
  assert.equal(logs.length, 2);
});
