const assert = require('node:assert/strict');
const {
  MASTER_PRICE_SOURCE,
  MISSING_PART_MASTER_PRICE_MESSAGE,
  asPriceRecord,
  masterPriceMissing,
  masterPriceScanFields,
  pickBestPriceRecord,
  scanWithPartMasterPrice
} = require('../utils/partMasterPrice');
const { getFinalInventoryMRP } = require('../utils/inventoryValueEngine');
const { resolvePartPricing } = require('../utils/partPricing');

const older = asPriceRecord({
  partNumber: 'ABC-123',
  partDescription: 'Older part',
  mrp: 100,
  dlc: 70,
  uploadedAt: '2026-01-01T00:00:00.000Z'
}, 'MASTER_PART');
const latest = asPriceRecord({
  partNumber: 'ABC-123',
  partDescription: 'Latest part',
  category: 'Electrical',
  model: 'X1',
  productGroup: 'Parts',
  mrp: 240,
  dlc: 180,
  uploadedAt: '2026-06-01T00:00:00.000Z'
}, 'MASTER_CATALOGUE');

assert.equal(pickBestPriceRecord([{ normalized: older }, { normalized: latest }]).mrp, 240);
assert.equal(masterPriceMissing(latest), false);
assert.equal(masterPriceMissing({ mrp: 240, dlc: 0 }), true);
assert.equal(MISSING_PART_MASTER_PRICE_MESSAGE, 'MRP/DLC missing in Part Master. Please update Part Master first.');

assert.deepEqual(masterPriceScanFields(latest, 3), {
  mrp: 240,
  scanMRP: 0,
  manualMRP: 0,
  valuationMRP: 240,
  valuationSource: MASTER_PRICE_SOURCE,
  finalInventoryValue: 720,
  finalMRP: 240,
  defaultMRP: 240,
  currentCatalogueMRP: 240,
  currentCatalogueDLC: 180,
  dlc: 180,
  mrpStatus: 'AVAILABLE',
  mrpPendingUpdatedAt: null,
  priceHistoryId: '',
  pricePeriodFrom: null,
  pricePeriodTo: null,
  pricePeriodMatched: false,
  pricePeriodStatus: 'PART_MASTER_CURRENT'
});

const pricedScan = scanWithPartMasterPrice({
  partNumber: 'ABC-123',
  qty: 3,
  mrp: 999,
  dlc: 888,
  scanMRP: 999,
  manualMRP: 777,
  valuationSource: 'UPI_SCANNED_MRP'
}, latest);
assert.equal(pricedScan.mrp, 240);
assert.equal(pricedScan.currentCatalogueDLC, 180);
assert.equal(pricedScan.dlc, 180);
assert.equal(pricedScan.scanMRP, 0);
assert.equal(pricedScan.manualMRP, 0);
assert.equal(pricedScan.finalInventoryValue, 720);
assert.equal(pricedScan.partDescription, 'LATEST PART');

const reportPricing = resolvePartPricing({
  partNumber: 'ABC-123',
  partMasterPrice: latest,
  stock: { mrp: 999, dlc: 888 },
  actualQty: 3,
  dmsQty: 5
});
assert.equal(reportPricing.mrp, 240);
assert.equal(reportPricing.dlc, 180);
assert.equal(reportPricing.actualStockValue, 540);
assert.equal(reportPricing.dmsStockValue, 900);
assert.equal(reportPricing.actualMrpValue, 720);
assert.equal(reportPricing.dmsMrpValue, 1200);

assert.deepEqual(
  getFinalInventoryMRP(
    { qty: 1, scanMRP: 999, manualMRP: 777, mrp: 888, valuationSource: 'UPI_SCANNED_MRP' },
    { mrp: 240 }
  ),
  { mrp: 240, source: MASTER_PRICE_SOURCE }
);

process.stdout.write('Part Master pricing checks passed.\n');
