require('dotenv').config();
const Inventory = require('../models/Inventory');
const DeletedScanLog = require('../models/DeletedScanLog');
const { normalizePartNumber } = require('../utils/normalize');
const { connectDatabase, disconnectDatabase } = require('../services/prisma');

function clean(value) {
  return String(value || '').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function qtyOf(row = {}) {
  const qty = Number(row.fittedQty || row.qty || row.quantity || 0);
  return Number.isFinite(qty) ? qty : 0;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  await connectDatabase();
  const rows = await Inventory.find({
    scanType: 'FITTED',
    syncStatus: { $nin: ['duplicate', 'rejected', 'failed'] },
    isDuplicate: { $ne: true }
  }).sort({ updatedAt: -1, createdAt: -1, timestamp: -1 }).lean();
  const groups = new Map();
  rows.forEach((row) => {
    const dealerCode = upper(row.dealerCode);
    const partNumber = normalizePartNumber(row.normalizedPartNumber || row.partNumber || row.part);
    const regdNo = upper(row.regdNo);
    const jobCardNo = upper(row.jobCardNo);
    if (!dealerCode || !partNumber || !regdNo || !jobCardNo) return;
    const key = [dealerCode, partNumber, regdNo, jobCardNo].join('::');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });

  let duplicateGroups = 0;
  let archivedCount = 0;
  for (const [, group] of groups) {
    if (group.length < 2) continue;
    duplicateGroups += 1;
    const [keeper, ...duplicates] = group;
    const totalQty = group.reduce((sum, row) => sum + qtyOf(row), 0);
    if (dryRun) {
      archivedCount += duplicates.length;
      continue;
    }
    await DeletedScanLog.insertMany(duplicates.map((scan) => ({
      deletedBy: 'system:migrate-fitted-duplicates',
      dealerCode: scan.dealerCode || '',
      partNumber: scan.partNumber || scan.part || '',
      qty: qtyOf(scan),
      scanType: 'FITTED',
      reason: 'Archived duplicate FITTED row during vehicle/job-card merge',
      source: scan.source || 'MIGRATION',
      scanId: scan.scanId || scan.uniqueScanId || String(scan._id),
      archivedDocument: scan
    })));
    archivedCount += duplicates.length;
    await Inventory.updateOne({ _id: keeper._id }, {
      $set: {
        qty: totalQty,
        quantity: totalQty,
        fittedQty: totalQty,
        bin: '',
        binLocation: '',
        fittedLocation: 'VEHICLE',
        status: 'FITTED_ON_VEHICLE',
        isFitted: true
      }
    });
    await Inventory.deleteMany({ _id: { $in: duplicates.map((scan) => scan._id) } });
  }

  await disconnectDatabase();
}

main().catch(async (error) => {
  console.error(error);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
