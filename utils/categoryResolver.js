const { cleanText } = require('./normalize');

const CATEGORY_RULES = [
  { match: /^(HHML\s+)?PARTS?$/i, value: 'HHML Parts' },
  { match: /^LUBRICANT(S)?$/i, value: 'Lubricant' },
  { match: /^VIDA\s+PARTS?$/i, value: 'VIDA Parts' },
  { match: /^HHML\s+PUBLICATION(S)?$/i, value: 'HHML Publication' },
  { match: /^HHML\s+TYRE$/i, value: 'HHML Tyre' },
  { match: /^HHML\s+TIRE$/i, value: 'HHML Tyre' },
  { match: /^ACCESSOR(?:Y|IES)$/i, value: 'Accessories' },
  { match: /^MERCHANDISE$/i, value: 'Merchandise' },
  { match: /^HELMET$/i, value: 'Helmet' },
  { match: /^TOOLS?$/i, value: 'Tools' },
  { match: /^HHML\s+CONSUMABLES?$/i, value: 'HHML Consumables' },
  { match: /^(UNKNOWN|UNCATEGORIZED|NA|N\/A|NONE|null)$/i, value: 'Uncategorized' }
];

const PRESERVE_WORDS = new Set(['HHML', 'VIDA', 'OEM', 'MRP', 'DLC', 'UPI']);

function formatCategoryWord(word = '') {
  const text = String(word || '').trim();
  if (!text) return '';
  const upper = text.toUpperCase();
  if (PRESERVE_WORDS.has(upper)) return upper;
  if (/^[A-Z0-9._/-]+$/.test(text) && /[0-9]/.test(text)) return upper;
  if (/^[A-Z0-9]+$/.test(text) && text.length <= 4) return upper;
  if (/^[A-Z0-9]+$/.test(text)) return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function canonicalizePartCategory(value, { uncategorized = 'Uncategorized' } = {}) {
  const text = cleanText(value).replace(/\s+/g, ' ').trim();
  if (!text) return uncategorized;
  for (const rule of CATEGORY_RULES) {
    if (rule.match.test(text)) return rule.value;
  }
  return text.split(' ').map(formatCategoryWord).join(' ');
}

function resolveCategoryFromMaster(master = {}, options = {}) {
  const raw = master.productCategory || master.category || master.partCategory || master.categories || '';
  return canonicalizePartCategory(raw, options);
}

function categoryCountMap(rows = [], key = 'productCategory', options = {}) {
  const counts = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const label = canonicalizePartCategory(row && row[key], options);
    counts.set(label, (counts.get(label) || 0) + 1);
  });
  return counts;
}

function categoriesMatch(left = '', right = '', options = {}) {
  return canonicalizePartCategory(left, options) === canonicalizePartCategory(right, options);
}

module.exports = {
  categoriesMatch,
  canonicalizePartCategory,
  categoryCountMap,
  resolveCategoryFromMaster
};
