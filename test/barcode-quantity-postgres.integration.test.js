const url = process.env.QUANTITY_TEST_DATABASE_URL || '';
if (url) {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' || parsed.port !== '55441' || parsed.pathname !== '/daksh_quantity_isolated_test') {
    throw new Error('Quantity tests require the dedicated loopback PostgreSQL database.');
  }
  process.env.DATABASE_URL = url;
}
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { decodeBarcode } = require('../services/BarcodeDecoderService');
const genuine = 'D/GE9G0000206291/ECGSLTX9L2B2/12395AANB00S     /000005/0000010.00/AAA/1/G/000/00';

test('authoritative decoder preserves raw text, pack quantities, price, and rejects unknown D variants', () => {
  const real = decodeBarcode(genuine, 'QR_CODE');
  assert.equal(real.encodedQuantity, 5);
  assert.equal(real.mrp, 10);
  assert.equal(real.rawBarcode, genuine);
  for (const qty of [1, 2, 3, 4, 5, 10, 20, 50, 100]) {
    assert.equal(decodeBarcode(genuine.replace('000005', String(qty).padStart(6, '0'))).quantity, qty);
  }
  for (const token of ['000000', '-5', '5.5', 'BAD', '']) {
    assert.equal(decodeBarcode(genuine.replace('000005', token)).success, false);
  }
  assert.equal(decodeBarcode(genuine + '/EXTRA').success, false);
  for (const qty of [0, -1, 1.5, 'BAD', '']) {
    assert.equal(decodeBarcode(JSON.stringify({ partNumber: 'PART100', qty })).success, false);
  }
});

test('PostgreSQL save pipeline preserves packs across clients, rejects duplicates and deducts eligible stock', {
  skip: !url && 'Set QUANTITY_TEST_DATABASE_URL to the dedicated isolated database.'
}, async () => {
  const { connectDatabase, disconnectDatabase, getPrismaClient } = require('../services/prisma');
  const { processScan } = require('../services/ScanProcessingService');
  const { calculatePartStock } = require('../services/StockCalculationService');
  const { stockQuantitySummary } = require('../utils/stockQuantity');
  const { summarizeMovementBucket } = require('../utils/inventoryValueEngine');
  const { reportTotals, applyMovementCountRules } = require('../utils/reportTotals');
  const { Audit, Dealer, Bin, MasterCatalogue, Inventory } = require('../models/registry');
  const dealerCode = `QT${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  const auditId = `${dealerCode}-AUDIT`;
  const req = { user: { role: 'admin', username: 'quantity-regression' }, activeDealerId: dealerCode };
  let sequence = 0;
  const save = (raw, extra = {}, overrideReq = req) => processScan({
    dealerCode, auditId, binLocation: 'Q1', scanType: 'INWARD', quantity: 1,
    rawBarcode: raw, scanId: `${dealerCode}-${++sequence}`, ...extra
  }, { req: overrideReq });
  try {
    await connectDatabase();
    await Dealer.create({ dealerCode, dealerName: 'Isolated quantity regression' });
    await Audit.create({ dealerCode, auditId, status: 'ACTIVE', auditStartDate: new Date() });
    await Bin.create({ dealerCode, binCode: 'Q1', active: true });
    await MasterCatalogue.create({ dealerCode, partNumber: '12395AANB00S', normalizedPartNumber: '12395AANB00S', mrp: 12, dlc: 8, partDescription: 'Quantity test part', activeStatus: true });
    for (const [index, qty] of [1, 2, 3, 4, 5, 10, 20, 50, 100].entries()) {
      const raw = genuine.replace('ECGSLTX9L2B2', `TESTUPI${index}`).replace('000005', String(qty).padStart(6, '0'));
      const source = ['barcode', 'mobile-web', 'mobile'][index % 3];
      const result = await save(raw, { source, cameraDecoded: index % 2 === 0, barcodeFormat: 'QR_CODE' });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(result.scan.qty, qty);
      const dbRow = await getPrismaClient().inventory.findUnique({ where: { id: result.scan._id } });
      assert.equal(dbRow.data.quantity, qty);
      assert.equal(dbRow.data.transactionQuantity, qty);
      assert.equal(dbRow.data.encodedQuantity, qty);
      assert.equal(dbRow.data.scanEventCount, 1);
      assert.equal(dbRow.data.rawBarcode, raw);
      assert.equal(dbRow.data.barcodePriceMismatch, true);
      assert.equal((await save(raw)).status, 'duplicate');
    }
    const concurrent = await Promise.all([save(genuine), save(genuine)]);
    assert.equal(concurrent.filter(r => r.success).length, 1, JSON.stringify(concurrent));
    assert.equal(concurrent.filter(r => r.status === 'duplicate').length, 1);
    const stored = await Inventory.find({ dealerCode, auditId }).lean();
    const expected = 200; // 195 controlled units + genuine pack of 5.
    assert.equal(stored.length, 10);
    assert.equal(stockQuantitySummary(stored).availableQty, expected);
    assert.equal(calculatePartStock(stored, '12395AANB00S').availableQty, expected);
    assert.equal(summarizeMovementBucket(stored).totalDealerStockQty, expected);
    assert.equal(reportTotals(applyMovementCountRules(stored)).totalDealerStockQty, expected);
    assert.equal((await save(genuine, { dealerCode: 'OTHER' })).httpStatus, 403);
    const out = await save(genuine, { scanType: 'OUTWARD', binLocation: '' });
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.scan.quantity, 5);
    assert.equal((await save(genuine, { scanType: 'OUTWARD', binLocation: '' })).success, false);
    const fittedRaw = genuine.replace('ECGSLTX9L2B2', 'TESTUPI5').replace('000005', '000010');
    const fit = await save(fittedRaw, { scanType: 'FITTED', binLocation: '', regdNo: 'TEST123', jobCardNo: 'TESTJOB' });
    assert.equal(fit.success, true, JSON.stringify(fit));
    assert.equal(fit.scan.quantity, 10);
    const absent = await save(genuine.replace('ECGSLTX9L2B2', 'ABSENTUPI'), { scanType: 'OUTWARD', binLocation: '' });
    assert.equal(absent.success, false);
    assert.equal((await save(genuine.replace('000005', 'BAD'))).success, false);
    const after = await Inventory.find({ dealerCode, auditId }).lean();
    assert.equal(stockQuantitySummary(after).storeQty, 185);
    assert.equal(stockQuantitySummary(after).availableQty, 195); // fitted stock remains in workshop until billed.
    const damageRaw = genuine.replace('ECGSLTX9L2B2', 'TESTUPI4');
    const damage = await save(damageRaw, { scanType: 'DAMAGE' });
    assert.equal(damage.success, true, JSON.stringify(damage));
    assert.equal(damage.scan.quantity, 5);
    assert.equal((await save(damageRaw, { scanType: 'DAMAGE' })).success, false);
    const finalRows = await Inventory.find({ dealerCode, auditId }).lean();
    assert.equal(stockQuantitySummary(finalRows).availableQty, 190);
    assert.equal(stockQuantitySummary(finalRows).damageQty, 5);
    const syncRaw = genuine.replace('ECGSLTX9L2B2', 'TESTOFFLINE').replace('000005', '000020');
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await require('../routes/sync').pushHandler({ ...req, app: { get: () => null }, headers: {},
      body: { dealerCode, auditId, scans: [{ dealerCode, auditId, binLocation: 'Q1', source: 'mobile',
        rawDecodedValue: syncRaw, rawBarcode: syncRaw, cameraDecoded: true, barcodeFormat: 'qrCode',
        scanId: `${dealerCode}-OFFLINE`, quantity: 1 }] }
    }, response);
    assert.equal(response.body.insertedCount, 1, JSON.stringify(response.body));
    assert.equal(response.body.insertedRecords[0].qty, 20);
    const offline = await getPrismaClient().inventory.findFirst({ where: { dealerCode, uniqueScanId: `${dealerCode}-OFFLINE` } });
    assert.equal(offline.data.quantity, 20);
    assert.equal(offline.data.rawBarcode, syncRaw);
  } finally {
    // All cleanup is restricted to this random dealer in the guarded test DB.
    for (const model of [Inventory, MasterCatalogue, Bin, Audit, Dealer]) await model.deleteMany({ dealerCode });
    await disconnectDatabase();
  }
});
