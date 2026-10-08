const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const parser = require('../utils/scanParser');
const heroQr = 'D/132/HE5B0199510/EBHPE5EQTWD4/44831KVH900S      /001/20170505125743/00';

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
  assert.equal(unknownHeroPart.message, 'Part 88888KTC900ZCS not found in Part Master');
  const rejected = await resolve('PREFIX-32410KTC920S', 'code128', 'D01');
  assert.equal(rejected.success, false);
  assert.equal(rejected.message, 'Part PREFIX-32410KTC920S not found in Part Master');
  assert.equal((await resolve('unrecognized/data', 'qrCode', 'D01')).success, false);
  assert.ok(calls.every(call => call.options.exact === true && call.dealer === 'D01'));
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
