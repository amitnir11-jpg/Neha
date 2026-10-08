const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../utils/scanDuplicatePolicy');
const { makeQrFingerprint } = require('../utils/scanIdentity');
const { matchesFilter } = require('../models/prismaModel');
const { buildSuggestionPayload, normalizePartBinScope } = require('../services/PartBinLocationService');

const raw = 'D/GCSG0000272850/CCG8FN2C6D4C/957010805000S     /000010/0000011.00/AAB/1/G/000/00';
const variant = 'D/OTHERBATCH123/CCG8FN2C6D4C/957010805000S/000001/0000012.00/OTHER/1/G/000/00';
function scan(rawScan = raw, binLocation = 'A1') {
  return { dealerCode: 'D01', auditId: 'AUD1', scanType: 'INWARD', type: 'INWARD',
    rawScan, partNumber: '957010805000S', binLocation, syncStatus: 'synced', deletedAt: null, isDeleted: false };
}

test('one unique UPI has the same lock/fingerprint across QR variants and bins', () => {
  const original = scan();
  const changed = scan(variant, 'B1');
  assert.equal(policy.uniqueUpiIdentityToken(original), 'CCG8FN2C6D4C');
  assert.equal(policy.globalUpiKey(original), policy.globalUpiKey(changed));
  assert.equal(makeQrFingerprint(original), makeQrFingerprint(changed));
  assert.notEqual(makeQrFingerprint(original), makeQrFingerprint({ ...changed, auditId: 'AUD2' }));
  assert.notEqual(makeQrFingerprint(original), makeQrFingerprint({ ...changed, scanType: 'OUTWARD' }));
  assert.notEqual(policy.globalUpiKey(original), policy.globalUpiKey(scan(raw.replace('CCG8FN2C6D4C', 'DIFFERENTUPI1'))));
});

test('UPI duplicate lookup recognizes unchanged legacy rows with full QR aliases', () => {
  const legacy = { ...scan(), upiCode: raw, upiNo: raw, upiId: raw, globalUpiKey: 'legacy-key' };
  const filter = policy.activeUpiDuplicateFilter(scan(variant, 'B1'));
  assert.equal(matchesFilter(legacy, filter), true);
  assert.equal(matchesFilter({ ...legacy, isDeleted: true }, filter), false);
  assert.equal(matchesFilter({ ...legacy, dealerCode: 'D02' }, filter), false);
  assert.equal(matchesFilter({ ...legacy, auditId: 'OLD' }, filter), false);
  assert.equal(matchesFilter(scan(raw.replace('CCG8FN2C6D4C', 'DIFFERENTUPI1')), filter), false);
});

test('manual bin prompt suggests the latest bin rather than the largest bin', () => {
  const rows = [{ binLocation: 'A1', quantity: 100, lastScanDate: '2026-10-01' },
    { binLocation: 'B1', quantity: 2, lastScanDate: '2026-10-08' }];
  const result = buildSuggestionPayload(rows, { dealerCode: 'D01', auditId: 'AUD1', partNumber: 'PART123', binLocation: 'A1', promptOnLastBin: true });
  assert.equal(result.sameBinExists, true);
  assert.equal(result.shouldPrompt, true);
  assert.equal(result.lastBin, 'B1');
  assert.equal(result.suggestedBin, 'B1');
  assert.match(result.message, /LAST SAVED IN BIN B1/);
  assert.match(result.message, /different bin A1/);
  assert.equal(buildSuggestionPayload(rows, { binLocation: 'B1', promptOnLastBin: true }).shouldPrompt, false);
  assert.equal(buildSuggestionPayload(rows, { binLocation: 'A1' }).shouldPrompt, false);
});

test('normalized bin scope preserves its current bin across backend helper calls', () => {
  const scope = normalizePartBinScope({ dealerCode: 'D01', auditId: 'AUD1', partNumber: 'PART123', binLocation: 'B1' });
  assert.deepEqual(normalizePartBinScope(scope), scope);
  const result = buildSuggestionPayload([{ binLocation: 'A1', quantity: 3 }], { ...scope, promptOnLastBin: true });
  assert.equal(result.currentBin, 'B1');
  assert.equal(result.shouldPrompt, true);
});
