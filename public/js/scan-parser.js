(function (global) {
  const invalidScannerSequenceTitle = 'Invalid Barcode / QR Sequence';
  const invalidScannerSequenceMessage = 'Only valid 1D barcode or 2D QR sequences are allowed here. To enter a part number, use Manual Entry, Local Part, or Excel Stock Upload.';

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

  function resolveDecodedQuantity(parsed, fallback = 1, verification = false) {
    if (verification) return 1;
    if (parsed?.type === 'UPI' || parsed?.type === 'HERO_QR') {
      return parsed.success && Number.isInteger(parsed.quantity) && parsed.quantity > 0 ? parsed.quantity : 0;
    }
    const requested = Number(fallback);
    return Number.isFinite(requested) && requested > 0 ? requested : 1;
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

  function parseFixedDBarcode(raw, tokens) {
    if (tokens[0]?.toUpperCase() !== 'D' || ![8, 11].includes(tokens.length)) return null;
    const partIndex = tokens.length === 11 ? 3 : 4;
    const partNumber = clean(tokens[partIndex]).toUpperCase();
    const rawQuantity = clean(tokens[partIndex + 1]);
    const upiId = normalizePartToken(tokens[partIndex - 1]);
    const valid = /^[A-Z0-9][A-Z0-9._-]{2,79}$/.test(partNumber) && isQuantityToken(rawQuantity)
      && /^[A-Z0-9._-]+$/i.test(tokens[partIndex - 1])
      && (tokens.length === 11 ? /^\d+\.\d{2}$/.test(tokens[5]) : /^\d{14}$/.test(tokens[6]));
    return {
      success: valid,
      reason: valid ? '' : 'INVALID_QTY',
      type: 'HERO_QR',
      rawUpi: raw,
      rawQr: raw,
      normalizedQr: tokens.map((segment) => normalizePartToken(segment)).join('/'),
      partNumber,
      upiId,
      uniqueId: upiId,
      rawScan: raw,
      fields: tokens,
      quantity: valid ? Number.parseInt(rawQuantity, 10) : 0,
      rawQuantity
    };
  }

  function parseScanValue(rawValue, masterLookup = []) {
    const raw = String(rawValue ?? '');
    if (!clean(raw)) {
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
    const fixedDBarcode = parseFixedDBarcode(raw, tokens);
    if (fixedDBarcode) {
      if (fixedDBarcode.success) fixedDBarcode.type = 'UPI';
      return fixedDBarcode;
    }
    if (tokens[0]?.toUpperCase() === 'D') return {
      success: false, reason: 'UNSUPPORTED_D_FORMAT', type: 'HERO_QR',
      rawScan: raw, rawUpi: raw, rawQr: raw, fields: tokens,
      partNumber: '', upiId: '', quantity: 0, rawQuantity: ''
    };
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
    const slash = parseScanValue(raw, masterLookup);
    if (slash.type === 'UPI' || slash.type === 'HERO_QR') {
      return { ...base, sourceType: 'QR', success: slash.success, reason: slash.reason, type: 'HERO_QR',
        partNumber: slash.partNumber, upi: slash.upiId || null, quantity: slash.quantity,
        rawQuantity: slash.rawQuantity, quantityProvided: true,
        manufacturerFormat: slash.fields.length === 11 ? 'D_11' : slash.fields.length === 8 ? 'D_LEGACY_8' : 'GENERIC_SLASH',
        mrp: slash.fields[0]?.toUpperCase() === 'D' && slash.fields.length === 11 ? Number(slash.fields[5]) : null,
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
    const quantityProvided = Object.hasOwn(keyed, 'QTY') || Object.hasOwn(keyed, 'QUANTITY') || Object.hasOwn(keyed, 'Q');
    const rawQuantity = keyed.QTY ?? keyed.QUANTITY ?? keyed.Q;
    const quantityValid = !quantityProvided || isQuantityToken(rawQuantity);
    if (part) return { ...base, success: quantityValid, reason: quantityValid ? '' : 'INVALID_QTY', type: 'STRUCTURED_CODE', partNumber: normalizeDecodedValue(part),
      upi: explicitUpi, identityKind: explicitUpi ? 'UNIQUE_UPI' : 'SKU', hasUniqueItemId: Boolean(explicitUpi),
      quantityProvided, rawQuantity, quantity: quantityValid ? (quantityProvided ? Number(rawQuantity) : 1) : 0 };
    // No guessed prefix/suffix removal and no similar-part substitution.
    if (/^[A-Z0-9][A-Z0-9._-]{2,79}$/.test(normalizedValue)) {
      return { ...base, success: true, type: 'DIRECT_BARCODE', partNumber: normalizedValue };
    }
    return { ...base, success: false, reason: 'UNSUPPORTED_CODE' };
  }

  function hasValidCheckDigit(value) {
    if (!/^\d+$/.test(value)) return false;
    const digits = value.split('').map(Number);
    const checkDigit = digits.pop();
    const weightedSum = digits.reverse().reduce((sum, digit, index) =>
      sum + digit * (index % 2 === 0 ? 3 : 1), 0);
    return (10 - (weightedSum % 10)) % 10 === checkDigit;
  }

  function hasKnownOneDimensionalStructure(value) {
    const normalized = normalizeDecodedValue(value);
    if ((normalized.length === 13 || normalized.length === 8) && hasValidCheckDigit(normalized)) return true;
    if (normalized.length === 12 && hasValidCheckDigit(normalized)) return true;
    return /^[A-D][0-9$+./:-]{4,}[A-D]$/.test(normalized);
  }

  function validateScannerSequence(rawValue, format) {
    const parsed = parseScannedCode(rawValue, format);
    if (!parsed.success) return { valid: false, parsed, reason: parsed.reason || 'UNSUPPORTED_CODE' };

    if (['HERO_QR', 'HERO_SKU_LABEL', 'HERO_LEGACY_1D', 'LEGACY_UPI'].includes(parsed.type)) {
      return { valid: true, parsed, reason: '' };
    }

    // JSON, URL/query and key-value labels already carry explicit field names.
    // Keep the existing parser authoritative for those supported structures.
    if (parsed.type === 'STRUCTURED_CODE') return { valid: true, parsed, reason: '' };

    // Symbology metadata alone must not make a bare Hero part number valid.
    // Recognize the catalogue part structures, rather than rejecting all
    // alphanumeric 1D identifiers or relying on the presence of a slash.
    if (/^(?=.*[A-Z])(?:\d{2}[A-Z]\d{3,4}S|\d{5}[A-Z0-9]{5,10}|K\d{5}[A-Z0-9]{5,10})$/.test(parsed.normalizedValue)) {
      return { valid: false, parsed, reason: 'PLAIN_PART_NUMBER' };
    }

    if (['EAN_8', 'EAN_13', 'UPC_A'].includes(parsed.barcodeFormat)) {
      const length = { EAN_8: 8, EAN_13: 13, UPC_A: 12 }[parsed.barcodeFormat];
      return { valid: parsed.normalizedValue.length === length && hasValidCheckDigit(parsed.normalizedValue),
        parsed, reason: parsed.normalizedValue.length === length && hasValidCheckDigit(parsed.normalizedValue) ? '' : 'INVALID_CHECK_DIGIT' };
    }

    const oneDimensionalFormats = [
      'CODABAR', 'CODE_39', 'CODE_93', 'CODE_128', 'EAN_8', 'EAN_13',
      'ITF', 'UPC_A', 'UPC_E', 'RSS_14'
    ];
    if (parsed.type === 'DIRECT_BARCODE' && (
      oneDimensionalFormats.includes(parsed.barcodeFormat)
      || (parsed.barcodeFormat === 'UNKNOWN' && hasKnownOneDimensionalStructure(rawValue))
    )) {
      return { valid: true, parsed, reason: '' };
    }

    return { valid: false, parsed, reason: 'UNSUPPORTED_CODE',
      requiresIdentityLookup: parsed.type === 'DIRECT_BARCODE' && parsed.barcodeFormat === 'UNKNOWN' };
  }

  const cameraBarcodeFormats = ['QR_CODE', 'CODE_128', 'CODE_39', 'CODE_93', 'EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'ITF', 'CODABAR', 'RSS_14', 'DATA_MATRIX', 'AZTEC', 'PDF_417'];
  const api = { cameraBarcodeFormats, clean, normalizePartToken, parseScanValue, parseScannedCode, validateScannerSequence, invalidScannerSequenceTitle, invalidScannerSequenceMessage, parseHeroSkuLabel, parseHeroLegacyOneDLabel, normalizeDecodedValue, normalizeBarcodeFormat, isQuantityToken, isLikelyPartToken, resolveHeroPartIndex, resolveDecodedQuantity };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.DakshScanParser = api;
  global.scanParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
