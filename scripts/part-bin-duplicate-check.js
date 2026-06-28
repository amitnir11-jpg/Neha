const assert = require('assert');
const fs = require('fs');
const path = require('path');
const duplicatePolicy = require('../utils/scanDuplicatePolicy');

const base = {
  dealerCode: 'D01',
  scanType: 'INWARD',
  partNumber: '33402KCC710S',
  binLocation: 'A23',
  auditId: 'AUD-1'
};

const sameBinDifferentAudit = {
  ...base,
  auditId: 'AUD-2'
};

const differentBin = {
  ...base,
  binLocation: 'A24'
};

const differentType = {
  ...base,
  scanType: 'DAMAGE'
};
const qr001A23 = {
  ...base,
  rawScan: 'OEM/QR001/X/33402KCC710S/1/100'
};
const qr002A23 = {
  ...base,
  rawScan: 'OEM/QR002/X/33402KCC710S/1/100'
};
const qr002A24 = {
  ...differentBin,
  rawScan: 'OEM/QR002/X/33402KCC710S/1/100'
};

assert.strictEqual(
  duplicatePolicy.businessDuplicateKey(base),
  ''
);
assert.strictEqual(
  duplicatePolicy.businessDuplicateKey(sameBinDifferentAudit),
  duplicatePolicy.businessDuplicateKey(base)
);
assert.strictEqual(duplicatePolicy.businessDuplicateKey(differentBin), '');

const filter = duplicatePolicy.partBinDuplicateFilter(base);
assert.strictEqual(filter, null, 'part/bin duplicate filter must not block scans');

const otherFilter = duplicatePolicy.partBinDuplicateFilter(differentBin);
assert.strictEqual(otherFilter, null, 'different-bin part scan must not be a duplicate');

assert.strictEqual(duplicatePolicy.sameBinLocation(base, sameBinDifferentAudit), true);
assert.strictEqual(duplicatePolicy.sameBinLocation(base, differentBin), false);
assert.strictEqual(duplicatePolicy.businessDuplicateFilter(differentType), null);
assert.notStrictEqual(duplicatePolicy.globalUpiKey(qr001A23), duplicatePolicy.globalUpiKey(qr002A23));
assert.strictEqual(duplicatePolicy.globalUpiKey(qr002A23), duplicatePolicy.globalUpiKey(qr002A24));
assert.strictEqual(duplicatePolicy.duplicateUpiMessage(qr001A23), 'This QR code is already scanned.');

const hondaQr1A15 = {
  dealerCode: 'D01',
  scanType: 'INWARD',
  partNumber: '957010805000S',
  binLocation: 'A15',
  rawScan: 'D/GCSG0000272850/CCG8FN2C6D4C/957010805000S     /000010/0000011.00/AAB/1/G/000/00'
};
const hondaQr2A16 = {
  ...hondaQr1A15,
  binLocation: 'A16',
  rawScan: 'D/FDWG0000852103/DCF7PL8MCW8A/957010805000S     /000010/0000011.00/AAB/1/G/000/00'
};
assert.notStrictEqual(duplicatePolicy.globalUpiKey(hondaQr1A15), duplicatePolicy.globalUpiKey(hondaQr2A16), 'same part in different bin with different QR must be allowed');
assert.strictEqual(duplicatePolicy.globalUpiKey(hondaQr1A15), duplicatePolicy.globalUpiKey({ ...hondaQr1A15, binLocation: 'A16' }), 'same QR in any bin must be duplicate');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'prisma', 'migrations', '20260627183000_allow_cross_bin_upi_duplicates', 'migration.sql'),
  'utf8'
);
assert(/DROP INDEX IF EXISTS inventories_active_inward_upi_unique/i.test(migration));
assert(/DROP INDEX IF EXISTS dealer_audit_upi_unique/i.test(migration));
assert(/DROP INDEX IF EXISTS global_upi_key_unique/i.test(migration));
assert(/CREATE INDEX IF NOT EXISTS inventories_active_inward_upi_bin_lookup_idx/i.test(migration));
assert(!/CREATE UNIQUE INDEX IF NOT EXISTS inventories_active_inward_upi_bin_lookup_idx/i.test(migration));

const qrRuleMigration = fs.readFileSync(
  path.join(__dirname, '..', 'prisma', 'migrations', '20260628053000_qr_identity_duplicate_rule', 'migration.sql'),
  'utf8'
);
assert(/DROP INDEX IF EXISTS inventories_active_inward_upi_unique/i.test(qrRuleMigration));
assert(/indexdef ILIKE '%"dealerCode"%'/i.test(qrRuleMigration));
assert(/indexdef ILIKE '%"upiCode"%'/i.test(qrRuleMigration));
assert(/inventories_dealer_global_upi_lookup_idx/i.test(qrRuleMigration));

const syncRoute = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sync.js'), 'utf8');
assert(!/businessDuplicateClauses/.test(syncRoute));
assert(/duplicatePolicy\.globalUpiKey/.test(syncRoute));
assert(/duplicatePolicy\.activeUpiDuplicateFilter/.test(syncRoute));

const mobileScanner = fs.readFileSync(path.join(__dirname, '..', 'public', 'scan.js'), 'utf8');
assert(/Scan in/.test(mobileScanner));
assert(/Continue with/.test(mobileScanner));
assert(!/window\.confirm\(message\)/.test(mobileScanner));

console.log('Part/bin duplicate policy checks passed.');
