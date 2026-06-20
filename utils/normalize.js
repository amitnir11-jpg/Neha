function cleanText(value) {
  let text = String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  while (text.length > 1 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function normalizePartNumber(value) {
  return cleanText(value)
    .toUpperCase()
    .replace(/[\s*\-\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '');
}

function normalizeCategory(value) {
  return cleanText(value);
}

function numberValue(value, fallback = 0) {
  const parsed = Number(cleanText(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNumericOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(cleanText(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const parsed = toNumericOrNull(value);
    if (parsed !== null && parsed > 0) return parsed;
  }
  return 0;
}

function firstNonZeroNumber(...values) {
  for (const value of values) {
    const parsed = toNumericOrNull(value);
    if (parsed !== null && parsed !== 0) return parsed;
  }
  return 0;
}

module.exports = {
  cleanText,
  firstNonZeroNumber,
  firstPositiveNumber,
  normalizePartNumber,
  normalizeCategory,
  numberValue
};
