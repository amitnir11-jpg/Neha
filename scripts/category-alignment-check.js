const assert = require('node:assert/strict');
const {
  categoriesMatch,
  canonicalizePartCategory,
  categoryCountMap,
  resolveCategoryFromMaster
} = require('../utils/categoryResolver');

const samples = [
  { productCategory: 'HHML PARTS' },
  { productCategory: 'HHML Part' },
  { category: 'LUBRICANT' },
  { category: 'Lubricants' },
  { productCategory: 'Accessories' },
  { productCategory: '' }
];

assert.equal(canonicalizePartCategory('HHML PARTS'), 'HHML Parts');
assert.equal(canonicalizePartCategory('HHML Part'), 'HHML Parts');
assert.equal(canonicalizePartCategory('LUBRICANT'), 'Lubricant');
assert.equal(canonicalizePartCategory('Lubricants'), 'Lubricant');
assert.equal(canonicalizePartCategory(''), 'Uncategorized');
assert.equal(resolveCategoryFromMaster({ productCategory: 'HHML PARTS' }), 'HHML Parts');
assert.equal(resolveCategoryFromMaster({ category: 'LUBRICANT' }), 'Lubricant');
assert.equal(resolveCategoryFromMaster({}), 'Uncategorized');
assert.equal(categoriesMatch('HHML PARTS', 'HHML Parts'), true);

const stockSummaryRows = samples.map((row) => ({ productCategory: canonicalizePartCategory(row.productCategory || row.category || '') }));
const partwiseRows = samples.map((row) => ({ category: canonicalizePartCategory(row.productCategory || row.category || '') }));

const stockSummaryCounts = Object.fromEntries(categoryCountMap(stockSummaryRows).entries());
const partwiseCounts = Object.fromEntries(categoryCountMap(partwiseRows, 'category').entries());

assert.deepEqual(partwiseCounts, stockSummaryCounts);
assert.equal(stockSummaryCounts.Lubricant, 2);
assert.equal(stockSummaryCounts['HHML Parts'], 2);
assert.equal(stockSummaryCounts.Accessories, 1);
assert.equal(stockSummaryCounts.Uncategorized, 1);

process.stdout.write('Category alignment checks passed.\n');
