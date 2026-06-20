const Inventory = require('../models/Inventory');
const Scan = require('../models/Scan');
const { disconnectDatabase } = require('../services/prisma');
const { getPricesFromPartMaster } = require('../utils/partMasterPrice');
const { canonicalizePartCategory, resolveCategoryFromMaster } = require('../utils/categoryResolver');
const { normalizePartNumber } = require('../utils/normalize');

const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
const batchSize = Math.max(1, Number(process.env.BACKFILL_BATCH_SIZE || 500));

function scanCategoryFilter() {
  return {
    $or: [
      { partNumber: { $exists: true, $ne: '' } },
      { part: { $exists: true, $ne: '' } },
      { normalizedPartNumber: { $exists: true, $ne: '' } }
    ]
  };
}

async function backfillModel(label, Model) {
  let processed = 0;
  let updated = 0;
  let unchanged = 0;
  let missingMaster = 0;

  for (let skip = 0; ; skip += batchSize) {
    const batch = await Model.find(scanCategoryFilter())
      .select('_id partNumber part normalizedPartNumber category productCategory')
      .sort({ _id: 1 })
      .skip(skip)
      .limit(batchSize)
      .lean();

    if (!batch.length) break;

    const partNumbers = Array.from(new Set(batch.map((row) => normalizePartNumber(row.normalizedPartNumber || row.partNumber || row.part || '')).filter(Boolean)));
    const priceByPart = partNumbers.length ? await getPricesFromPartMaster(partNumbers) : new Map();
    const operations = [];

    batch.forEach((row) => {
      processed += 1;
      const partNo = normalizePartNumber(row.normalizedPartNumber || row.partNumber || row.part || '');
      if (!partNo) {
        unchanged += 1;
        return;
      }
      const master = priceByPart.get(partNo) || null;
      if (!master) missingMaster += 1;
      const targetCategory = resolveCategoryFromMaster(master || {}, { uncategorized: 'Uncategorized' });
      const currentCategory = canonicalizePartCategory(row.productCategory || row.category || '', { uncategorized: 'Uncategorized' });
      if (currentCategory === targetCategory) {
        unchanged += 1;
        return;
      }
      operations.push({
        updateOne: {
          filter: { _id: row._id },
          update: {
            $set: {
              category: targetCategory,
              productCategory: targetCategory
            }
          }
        }
      });
      updated += 1;
    });

    if (operations.length && !dryRun) {
      await Model.bulkWrite(operations, { ordered: false });
    }

    console.log(`[${label}] batch complete`, {
      processed,
      updated,
      unchanged,
      missingMaster,
      dryRun
    });
  }

  return { processed, updated, unchanged, missingMaster };
}

async function main() {
  try {
    console.log('[category-backfill] starting', { dryRun, batchSize });
    const results = [];
    results.push(['Inventory', await backfillModel('Inventory', Inventory)]);
    results.push(['Scan', await backfillModel('Scan', Scan)]);
    console.log('[category-backfill] finished', Object.fromEntries(results));
  } catch (error) {
    console.error('[category-backfill] failed', error);
    process.exitCode = 1;
  } finally {
    await disconnectDatabase().catch(() => undefined);
  }
}

main();
