require('dotenv').config();
const mongoose = require('mongoose');
const Inventory = require('../models/Inventory');
const DeletedScanLog = require('../models/DeletedScanLog');
const { normalizePartNumber } = require('../utils/normalize');

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
  const uris = [
    process.env.MONGO_URI,
    process.env.MONGO_FALLBACK_URI,
    'mongodb://127.0.0.1:27017/daksh_inventory_v2'
  ].filter(Boolean);
  let connected = false;
  for (const uri of uris) {
    try {
      await mongoose.connect(uri);
      connected = true;
      break;
    } catch (error) {
      await mongoose.disconnect().catch(() => undefined);
      console.warn(`Mongo connect failed, trying next URI: ${error.message}`);
    }
  }
  if (!connected) throw new Error('Unable to connect to MongoDB');
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

  console.log(JSON.stringify({ success: true, dryRun, fittedRowsScanned: rows.length, duplicateGroups, archivedCount }, null, 2));
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
