const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const reader = require('zxing-wasm/reader');
const QRCode = require('qrcode');
const vm = require('node:vm');

// Generated barcode fixtures test symbologies, not the unidentified barcode in
// the user's photograph. They contain deliberately known test values.
test('on-device WASM decoder reads QR and all eight required 1D symbologies', async () => {
  await reader.prepareZXingModule({ overrides: { wasmBinary: fs.readFileSync(path.resolve('node_modules/zxing-wasm/dist/reader/zxing_reader.wasm')) }, fireImmediately: true });
  for (const [name, expected] of [
    ['code128', '32410KTC920S'], ['code39', '32410KTC920S'], ['ean13', '4006381333931'],
    ['ean8', '96385074'], ['upca', '0012345678905'], ['upce', '0012345000065'],
    ['interleaved2of5', '1234567890'], ['rationalizedCodabar', 'A123456B'],
    ['qrcode', 'D/132/HE5B0199510/EBHPE5EQTWD4/44831KVH900S      /001/20170505125743/00'],
    ['hero-sku-code128', '32410KTC920S/G3223000065001'],
    ['datamatrix', 'PART=32410KTC920S|UPI=DMUNIQUE123']
  ]) {
    const decoded = await reader.readBarcodes(fs.readFileSync(path.join(__dirname, 'fixtures/barcodes', `fixture-${name}.png`)),
      { formats: ['AllReadable'], tryHarder: true, maxNumberOfSymbols: 1 });
    assert.equal(decoded[0]?.text, expected, `actual decoded ${name} raw value`);
  }
});

test('WASM camera decoder reads the exact spaced Hero QR and fields remain intact', async () => {
  await reader.prepareZXingModule({ overrides: { wasmBinary: fs.readFileSync(path.resolve('node_modules/zxing-wasm/dist/reader/zxing_reader.wasm')) }, fireImmediately: true });
  const raw = 'D/GHCG0000926915/HCGLDYY6KJ2T/20K1120S          /000001/0000920.00/ABL/1/G/000/0';
  const image = await QRCode.toBuffer(raw, { width: 620, margin: 4, color: { dark: '#ffffff', light: '#000000' } });
  const decoded = await reader.readBarcodes(image, { formats: ['AllReadable'], tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true, tryDenoise: true, maxNumberOfSymbols: 1 });
  assert.equal(decoded[0]?.text, raw, 'decoder returns the complete raw QR text including internal spaces');
  const source = fs.readFileSync(path.resolve('public/js/scan-parser.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context);
  const parsed = context.DakshScanParser.parseScannedCode(decoded[0].text, decoded[0].format);
  assert.equal(parsed.partNumber, '20K1120S');
  assert.equal(parsed.upi, 'HCGLDYY6KJ2T');
  assert.equal(parsed.quantity, 1);
  assert.equal(parsed.mrp, 920);
});
