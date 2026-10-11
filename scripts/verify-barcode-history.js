const fs = require('node:fs');
const { reviewBarcodeHistory, writeReviewWorkbook } = require('../services/BarcodeHistoryReviewService');

async function main() {
  const args = process.argv.slice(2);
  const value = key => args[args.indexOf(key) + 1];
  const has = key => args.includes(key);
  if (!has('--output') || (!has('--input') && !has('--database')) || (has('--input') && has('--database'))) {
    throw new Error('Usage: node scripts/verify-barcode-history.js (--input snapshot.json | --database --dealer DEALER) --output review.xlsx');
  }
  let rows;
  if (has('--input')) {
    rows = JSON.parse(fs.readFileSync(value('--input'), 'utf8'));
    if (!Array.isArray(rows)) throw new Error('Snapshot must be an array of original stored records.');
  } else {
    const dealer = has('--dealer') ? String(value('--dealer')).trim().toUpperCase() : '';
    const url = process.env.BARCODE_REVIEW_DATABASE_URL;
    if (!url || !/^[A-Z0-9_-]+$/.test(dealer)) throw new Error('Explicit BARCODE_REVIEW_DATABASE_URL and --dealer are required; no default database is used.');
    const { PrismaClient } = require('@prisma/client');
    const db = new PrismaClient({ datasources: { db: { url } } });
    try {
      rows = await db.$transaction(async tx => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        const records = [];
        for (const [model, collection] of [['inventory', 'inventories'], ['scan', 'scans']]) {
          let cursor;
          while (true) {
            const page = await tx[model].findMany({ where: { dealerCode: dealer }, orderBy: { id: 'asc' }, take: 1000,
              ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
            records.push(...page.map(row => ({ ...row.data, ...row, collection })));
            if (page.length < 1000) break;
            cursor = page.at(-1).id;
          }
        }
        return records;
      }, { isolationLevel: 'RepeatableRead', timeout: 120000 });
    } finally { await db.$disconnect(); }
  }
  const review = reviewBarcodeHistory(rows);
  await writeReviewWorkbook(review, value('--output'));
  console.log(JSON.stringify({ sourceRows: rows.length, counts: Object.fromEntries(Object.entries(review).map(([key, data]) => [key, data.length])), output: value('--output'), sourceModified: false }));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
