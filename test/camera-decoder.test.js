const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const reader = require('zxing-wasm/reader');

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
