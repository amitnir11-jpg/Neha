const { createHash } = require('crypto');

function clean(value) {
  return String(value || '').trim();
}

function normalizeToken(value) {
  return clean(value).toUpperCase().replace(/\s+/g, ' ');
}

function makeQrFingerprint(input = {}) {
  if (input.barcodeIdentityKind === 'SKU') return '';
  const uniqueUpi = require('./scanDuplicatePolicy').uniqueUpiIdentityToken(input);
  const rawScan = clean(input.rawScanString || input.rawScan || input.rawBarcode || input.rawQR || input.rawUpi || input.barcode || input.raw || input.scanText);
  const fallback = [
    input.upiNo,
    input.upiId,
    input.scanId,
    input.uniqueScanId,
    input.clientScanId
  ].map(normalizeToken).filter(Boolean).join('|');
  const identity = uniqueUpi ? `UPI:${uniqueUpi}` : rawScan || fallback;
  if (!identity) return '';

  const scope = [
    input.dealerCode || input.dealer || '',
    input.auditId || input.audit || '',
    input.scanType || input.type || '',
    identity,
    // Include bin so the same scan can exist in multiple bins without colliding.
    uniqueUpi ? '' : input.binLocation || input.bin || input.location || ''
  ].map(normalizeToken).filter(Boolean).join('|');

  return createHash('sha256').update(scope).digest('hex');
}

function isDuplicateKeyError(error) {
  return Boolean(error && ([11000, 'P2002', '23505'].includes(error.code) || /duplicate key|unique constraint/i.test(String(error.message || ''))));
}

module.exports = {
  makeQrFingerprint,
  isDuplicateKeyError
};
