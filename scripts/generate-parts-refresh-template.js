const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const Inventory = require('../models/Inventory');
const { validScanClause } = require('../utils/masterValidation');

const outputPath = path.join(__dirname, '..', 'Parts Inventory Refresh Template.csv');

function csvCell(value) {
  return `"${String(value === undefined || value === null ? '' : value).replace(/"/g, '""')}"`;
}

function splitBins(value) {
  return String(value || '')
    .split(/[|,;/]+/)
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

function testScanClause() {
  return {
    $or: [
      { dealerName: /Sync Test/i },
      { deviceId: /sync-test/i },
      { deviceName: /sync-test/i },
      { rawUpi: /SYNCPT|scan test/i },
      { rawScan: /SYNCPT|scan test/i },
      { rawScanString: /SYNCPT|scan test/i },
      { staffName: /sync test|test sync/i },
      { partName: /Sync Test/i },
      { partDescription: /Sync Test/i }
    ]
  };
}

function scanTypeExpression() {
  return { $toUpper: { $ifNull: ['$scanType', { $ifNull: ['$type', ''] }] } };
}

function physicalBinQuantityExpression() {
  const qtyValue = { $ifNull: ['$qty', { $ifNull: ['$quantity', 0] }] };
  const qtyAbs = { $abs: qtyValue };
  const typeValue = scanTypeExpression();
  return {
    $cond: [
      { $in: [typeValue, ['OUTWARD', 'DAMAGE']] },
      { $multiply: [qtyAbs, -1] },
      {
        $cond: [
          { $eq: [typeValue, 'FITTED'] },
          0,
          qtyAbs
        ]
      }
    ]
  };
}

function fittedQuantityExpression() {
  const qtyValue = { $ifNull: ['$fittedQty', { $ifNull: ['$qty', { $ifNull: ['$quantity', 0] }] }] };
  return {
    $cond: [
      { $eq: [scanTypeExpression(), 'FITTED'] },
      { $abs: qtyValue },
      0
    ]
  };
}

function physicalBinExpression() {
  return {
    $cond: [
      { $eq: [scanTypeExpression(), 'FITTED'] },
      '',
      { $ifNull: ['$binLocation', '$bin'] }
    ]
  };
}

function fittedFieldExpression(field) {
  return {
    $cond: [
      { $eq: [scanTypeExpression(), 'FITTED'] },
      { $ifNull: [`$${field}`, ''] },
      ''
    ]
  };
}

async function main() {
  const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/daksh_inventory_v2';
  await mongoose.connect(mongoUri);

  const rows = await Inventory.aggregate([
    {
      $match: {
        $and: [
          { $nor: testScanClause().$or },
          validScanClause(),
          { syncStatus: { $nin: ['duplicate', 'rejected', 'failed'] } },
          { isDuplicate: { $ne: true } }
        ]
      }
    },
    {
      $group: {
        _id: { $ifNull: ['$normalizedPartNumber', { $ifNull: ['$partNumber', '$part'] }] },
        partNumber: { $first: { $ifNull: ['$partNumber', '$part'] } },
        physicalBinQty: { $sum: physicalBinQuantityExpression() },
        fittedQty: { $sum: fittedQuantityExpression() },
        bins: { $addToSet: physicalBinExpression() },
        fittedRegdNos: { $addToSet: fittedFieldExpression('regdNo') },
        fittedJobCardNos: { $addToSet: fittedFieldExpression('jobCardNo') }
      }
    },
    { $match: { _id: { $nin: [null, ''] } } },
    { $sort: { _id: 1 } }
  ]);

  const preparedRows = rows.map((row) => ({
    partNumber: row.partNumber || row._id,
    quantity: Number(row.physicalBinQty || 0) + Number(row.fittedQty || 0),
    physicalBinQty: Number(row.physicalBinQty || 0),
    fittedQty: Number(row.fittedQty || 0),
    fittedRegdNo: Array.from(new Set((row.fittedRegdNos || []).map((item) => String(item || '').trim()).filter(Boolean))).sort().join(', '),
    fittedJobCardNo: Array.from(new Set((row.fittedJobCardNos || []).map((item) => String(item || '').trim()).filter(Boolean))).sort().join(', '),
    binLocations: Array.from(new Set((row.bins || []).flatMap(splitBins))).sort()
  }));
  const maxBinCount = Math.max(1, ...preparedRows.map((row) => row.binLocations.length));
  const binHeaders = Array.from({ length: maxBinCount }, (_, index) => `Bin Loc ${index + 1}`);
  const csvRows = [
    ['Part Number', 'Qty', 'Physical Bin Qty', 'Fitted Qty', 'Fitted Regd No', 'Fitted Job Card No', ...binHeaders].map(csvCell).join(',')
  ];

  preparedRows.forEach((row) => {
    const binCells = Array.from({ length: maxBinCount }, (_, index) => row.binLocations[index] || '');
    csvRows.push([
      row.partNumber,
      row.quantity,
      row.physicalBinQty,
      row.fittedQty,
      row.fittedRegdNo,
      row.fittedJobCardNo,
      ...binCells
    ].map(csvCell).join(','));
  });

  fs.writeFileSync(outputPath, `${csvRows.join('\r\n')}\r\n`, 'utf8');
  console.log(`Created ${outputPath}`);
  console.log(`Parts: ${rows.length}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
