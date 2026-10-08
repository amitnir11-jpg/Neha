(function (global) {
  function clean(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .trim();
  }

  function normalizePartToken(value) {
    return clean(value).replace(/\s+/g, '').toUpperCase();
  }

  function isQuantityToken(value) {
    const token = clean(value);
    if (!/^\d{1,7}$/.test(token)) return false;
    const qty = Number.parseInt(token, 10);
    return Number.isInteger(qty) && qty >= 1 && qty <= 999999;
  }

  function isLikelyPartToken(value) {
    const token = normalizePartToken(value);
    if (!token || token === 'D' || /^\d+$/.test(token)) return false;
    return /^[A-Z0-9][A-Z0-9._/-]{2,79}$/.test(token);
  }

  function resolveHeroPartIndex(tokens, masterLookup = []) {
    const masterSet = new Set((Array.isArray(masterLookup) ? masterLookup : [])
      .map((entry) => normalizePartToken(entry))
      .filter(Boolean));
    const candidates = [];

    for (let index = 1; index < tokens.length - 1; index += 1) {
      const token = normalizePartToken(tokens[index]);
      if (isLikelyPartToken(token) && isQuantityToken(tokens[index + 1])) candidates.push(index);
    }

    return candidates.find((index) => masterSet.has(normalizePartToken(tokens[index]))) ?? candidates[0] ?? -1;
  }

  function parseScanValue(rawValue, masterLookup = []) {
    const raw = clean(rawValue);
    if (!raw) {
      return {
        success: false,
        reason: 'EMPTY_SCAN',
        type: 'EMPTY',
        rawUpi: null,
        rawQr: null,
        normalizedQr: '',
        partNumber: '',
        rawScan: raw,
        fields: [],
        quantity: 0,
        rawQuantity: ''
      };
    }

    const tokens = raw.split('/').map((field) => clean(field));
    const skuLabel = parseHeroSkuLabel(raw);
    if (skuLabel) return { success: true, type: 'HERO_SKU_LABEL', rawUpi: null, rawQr: null,
      normalizedQr: normalizeDecodedValue(raw), rawScan: raw, fields: tokens, quantity: 1,
      rawQuantity: '', upiId: '', ...skuLabel };
    const legacyOneD = parseHeroLegacyOneDLabel(raw);
    if (legacyOneD) return { success: true, type: 'HERO_SKU_LABEL', rawUpi: null, rawQr: null,
      normalizedQr: normalizeDecodedValue(raw), rawScan: raw, fields: tokens, quantity: 1,
      rawQuantity: '', upiId: '', ...legacyOneD };
    const looksLikeHeroQr = tokens.length >= 5
      && (tokens[0].toUpperCase() === 'D' || resolveHeroPartIndex(tokens, masterLookup) >= 0);

    if (looksLikeHeroQr) {
      const partIndex = resolveHeroPartIndex(tokens, masterLookup);
      if (partIndex > -1 && partIndex + 1 < tokens.length) {
        const partNumber = normalizePartToken(tokens[partIndex]);
        const rawQuantity = clean(tokens[partIndex + 1]);
        const uniqueId = tokens[0].toUpperCase() === 'D'
          ? (partIndex > 0 ? normalizePartToken(tokens[partIndex - 1]) : '')
          : normalizePartToken(tokens[1] || '');
        if (!isQuantityToken(rawQuantity)) {
          return {
            success: false,
            reason: 'INVALID_QTY',
            type: 'HERO_QR',
            rawUpi: raw,
            rawQr: raw,
            normalizedQr: tokens.map((segment) => normalizePartToken(segment)).join('/'),
            partNumber,
            upiId: uniqueId,
            uniqueId,
            rawScan: raw,
            fields: tokens,
            quantity: 0,
            rawQuantity
          };
        }
        return {
          success: true,
          type: 'UPI',
          rawUpi: raw,
          rawQr: raw,
          normalizedQr: tokens.map((segment) => normalizePartToken(segment)).join('/'),
          partNumber,
          rawScan: raw,
          fields: tokens,
          quantity: Number.parseInt(rawQuantity, 10),
          rawQuantity,
          upiId: uniqueId,
          uniqueId
        };
      }
    }

    return {
      success: true,
      type: 'NORMAL_BARCODE',
      rawUpi: null,
      rawQr: null,
      normalizedQr: raw,
      partNumber: normalizePartToken(raw),
      rawScan: raw,
      fields: tokens,
      quantity: 1,
      rawQuantity: '',
      upiId: ''
    };
  }

  function normalizeDecodedValue(value) {
    return String(value ?? '').replace(/[\r\n\t]/g, '').trim().toUpperCase();
  }

  function normalizeBarcodeFormat(format) {
    const value = String(format ?? '').replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[ -]/g, '_').toUpperCase();
    return ({ QRCODE: 'QR_CODE', CODE128: 'CODE_128', CODE39: 'CODE_39', CODE93: 'CODE_93',
      EAN13: 'EAN_13', EAN8: 'EAN_8', UPCA: 'UPC_A', UPCE: 'UPC_E', DATAMATRIX: 'DATA_MATRIX', PDF417: 'PDF_417' })[value] || value || 'UNKNOWN';
  }

  function parseHeroSkuLabel(value) {
    // Validated Hero packaging format. The G suffix is not a verified piece serial.
    const match = normalizeDecodedValue(value).match(/^(\d{5}[A-Z0-9]{6,8})\/(G\d{13})$/);
    return match ? { partNumber: match[1], packagingCode: match[2] } : null;
  }

  function parseHeroLegacyOneDLabel(value) {
    // Older Hero 1D labels carry a part number followed by a longer packaging
    // code. Keep the suffix as packaging data; it is not a proven item serial.
    const match = normalizeDecodedValue(value).match(/^(\d{5}[A-Z0-9]{7,9})\/([A-Z0-9]\d{13})$/);
    return match ? { partNumber: match[1], packagingCode: match[2] } : null;
  }

  // Shared browser/Node parser. Master validation and approved identity mapping
  // belong to the backend, never to camera adapters.
  function parseScannedCode(rawValue, format, masterLookup = []) {
    const raw = String(rawValue ?? '');
    const normalizedValue = normalizeDecodedValue(raw);
    const barcodeFormat = normalizeBarcodeFormat(format);
    const matrixFormat = ['QR_CODE', 'DATA_MATRIX', 'AZTEC', 'PDF_417'].includes(barcodeFormat);
    const base = { rawValue: raw, normalizedValue, barcodeFormat, barcodeType: matrixFormat ? '2D' : barcodeFormat === 'UNKNOWN' ? 'UNKNOWN' : '1D', sourceType: matrixFormat ? 'QR' : 'BARCODE', quantity: 1, upi: null, partNumber: '', identityKind: 'SKU', hasUniqueItemId: false };
    if (!normalizedValue) return { ...base, success: false, reason: 'EMPTY_SCAN' };
    const direct = masterLookup.find(part => normalizeDecodedValue(part) === normalizedValue);
    if (direct) return { ...base, success: true, type: 'DIRECT_BARCODE', partNumber: normalizedValue };
    const skuLabel = parseHeroSkuLabel(normalizedValue);
    if (skuLabel) return { ...base, ...skuLabel, barcodeType: barcodeFormat === 'UNKNOWN' ? '1D' : base.barcodeType, success: true, type: 'HERO_SKU_LABEL' };
    // Retain the established PART/UPI... test/scanner protocol, not arbitrary slash suffixes.
    const legacyUpi = normalizedValue.match(/^([A-Z0-9._-]{3,79})\/(UPI[A-Z0-9._-]+)$/);
    if (legacyUpi) return { ...base, success: true, type: 'LEGACY_UPI', partNumber: legacyUpi[1],
      upi: legacyUpi[2], identityKind: 'UNIQUE_UPI', hasUniqueItemId: true };
    const legacyOneD = parseHeroLegacyOneDLabel(normalizedValue);
    if (legacyOneD) return { ...base, ...legacyOneD, success: true, type: 'HERO_LEGACY_1D', identityKind: 'SKU' };
    const slash = parseScanValue(normalizedValue, masterLookup);
    if (slash.type === 'UPI' || slash.type === 'HERO_QR') {
      return { ...base, sourceType: 'QR', success: slash.success, reason: slash.reason, type: 'HERO_QR',
        partNumber: slash.partNumber, upi: slash.upiId || null, quantity: slash.quantity,
        identityKind: slash.upiId ? 'UNIQUE_UPI' : 'SKU', hasUniqueItemId: Boolean(slash.upiId) };
    }
    let fields = {};
    try { const value = JSON.parse(normalizedValue); if (value && typeof value === 'object' && !Array.isArray(value)) fields = value; } catch (_) {}
    if (!Object.keys(fields).length) {
      const query = normalizedValue.includes('?') ? normalizedValue.split('?').slice(1).join('?') : normalizedValue;
      if (query.includes('=')) {
        for (const [key, value] of new URLSearchParams(query.replace(/[|;]/g, '&'))) fields[key] = value;
      }
      for (const match of normalizedValue.matchAll(/(?:^|[|;,\s])([A-Z][A-Z0-9 _-]{0,24})\s*[:=]\s*([^|;,\r\n]+)/g)) fields[match[1]] = match[2];
    }
    const keyed = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key.replace(/[^A-Z0-9]/g, ''), value]));
    const part = keyed.PARTNUMBER || keyed.PARTNO || keyed.PART || keyed.PN || keyed.SKU || keyed.ITEMCODE;
    const explicitUpi = normalizeDecodedValue(keyed.UPI || keyed.UPIID || keyed.UNIQUEID || '') || null;
    if (part) return { ...base, success: true, type: 'STRUCTURED_CODE', partNumber: normalizeDecodedValue(part),
      upi: explicitUpi, identityKind: explicitUpi ? 'UNIQUE_UPI' : 'SKU', hasUniqueItemId: Boolean(explicitUpi),
      quantity: Number(keyed.QTY || keyed.QUANTITY || 1) || 1 };
    // No guessed prefix/suffix removal and no similar-part substitution.
    if (/^[A-Z0-9][A-Z0-9._-]{2,79}$/.test(normalizedValue)) {
      return { ...base, success: true, type: 'DIRECT_BARCODE', partNumber: normalizedValue };
    }
    return { ...base, success: false, reason: 'UNSUPPORTED_CODE' };
  }

  const cameraBarcodeFormats = ['QR_CODE', 'CODE_128', 'CODE_39', 'CODE_93', 'EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'ITF', 'CODABAR', 'RSS_14', 'DATA_MATRIX', 'AZTEC', 'PDF_417'];
  const api = { cameraBarcodeFormats, clean, normalizePartToken, parseScanValue, parseScannedCode, parseHeroSkuLabel, parseHeroLegacyOneDLabel, normalizeDecodedValue, normalizeBarcodeFormat, isQuantityToken, isLikelyPartToken, resolveHeroPartIndex };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.DakshScanParser = api;
  global.scanParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
