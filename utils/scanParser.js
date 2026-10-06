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

module.exports = {
  clean,
  normalizePartToken,
  parseScanValue,
  isQuantityToken,
  isLikelyPartToken,
  resolveHeroPartIndex
};
