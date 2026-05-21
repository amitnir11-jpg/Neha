function cleanText(value) {
  let text = String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '')
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
    .replace(/[\s*\-\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '');
}

function normalizeCategory(value) {
  return cleanText(value);
}

function numberValue(value, fallback = 0) {
  const parsed = Number(cleanText(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = {
  cleanText,
  normalizePartNumber,
  normalizeCategory,
  numberValue
};
