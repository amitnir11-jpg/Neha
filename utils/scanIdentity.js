const { createHash } = require('crypto');

function clean(value) {
  return String(value || '').trim();
}

function normalizeToken(value) {
  return clean(value).toUpperCase().replace(/\s+/g, ' ');
}

function makeQrFingerprint(input = {}) {
  const rawScan = clean(input.rawScanString || input.rawScan || input.rawUpi || input.raw || input.scanText);
  const fallback = [
    input.upiId,
    input.partNumber || input.part,
    input.scanType || input.type
  ].map(normalizeToken).filter(Boolean).join('|');
  const identity = rawScan || fallback;
  if (!identity) return '';

  const scope = [
    input.dealerCode || input.dealer || '',
    input.auditId || input.audit || '',
    identity
  ].map(normalizeToken).filter(Boolean).join('|');

  return createHash('sha256').update(scope).digest('hex');
}

function isDuplicateKeyError(error) {
  return Boolean(error && (error.code === 11000 || /duplicate key/i.test(String(error.message || ''))));
}

module.exports = {
  makeQrFingerprint,
  isDuplicateKeyError
};
