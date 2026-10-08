const { createHash } = require('crypto');

function clean(value) {
  return String(value || '').trim();
}

function normalizeToken(value) {
  return clean(value).toUpperCase().replace(/\s+/g, ' ');
}

function legacyHeroBarcodeIdentity(input = {}) {
  const raw = clean(input.rawDecodedValue || input.rawScanString || input.rawScan || input.rawBarcode || input.rawQR || input.rawUpi || input.barcode || input.raw || input.scanText);
  if (!raw) return '';
  const isHeroLabelType = type => ['HERO_LEGACY_1D', 'HERO_SKU_LABEL'].includes(type);
  const parsed = input.parsedCode && isHeroLabelType(input.parsedCode.type)
    ? input.parsedCode
    : require('./scanParser').parseScannedCode(raw, input.barcodeFormat || input.source?.barcodeFormat);
  return isHeroLabelType(parsed.type) ? normalizeToken(parsed.normalizedValue || raw) : '';
}

function makeQrFingerprint(input = {}) {
  const legacyHeroBarcode = legacyHeroBarcodeIdentity(input);
  const scanType = normalizeToken(input.scanType || input.type || '');
  if (legacyHeroBarcode && scanType !== 'INWARD') return '';
  if (input.barcodeIdentityKind === 'SKU' && !legacyHeroBarcode) return '';
  const uniqueUpi = require('./scanDuplicatePolicy').uniqueUpiIdentityToken(input);
  const rawScan = clean(input.rawScanString || input.rawScan || input.rawBarcode || input.rawQR || input.rawUpi || input.barcode || input.raw || input.scanText);
  const fallback = [
    input.upiNo,
    input.upiId,
    input.scanId,
    input.uniqueScanId,
    input.clientScanId
  ].map(normalizeToken).filter(Boolean).join('|');
  const identity = legacyHeroBarcode
    ? `HERO_1D:${legacyHeroBarcode}`
    : uniqueUpi ? `UPI:${uniqueUpi}` : rawScan || fallback;
  if (!identity) return '';

  const scope = [
    input.dealerCode || input.dealer || '',
    input.auditId || input.audit || '',
    input.scanType || input.type || '',
    identity,
    // Include bin so the same scan can exist in multiple bins without colliding.
    uniqueUpi || legacyHeroBarcode ? '' : input.binLocation || input.bin || input.location || ''
  ].map(normalizeToken).filter(Boolean).join('|');

  return createHash('sha256').update(scope).digest('hex');
}

function isDuplicateKeyError(error) {
  return Boolean(error && ([11000, 'P2002', '23505'].includes(error.code) || /duplicate key|unique constraint/i.test(String(error.message || ''))));
}

module.exports = {
  makeQrFingerprint,
  legacyHeroBarcodeIdentity,
  isDuplicateKeyError
};
