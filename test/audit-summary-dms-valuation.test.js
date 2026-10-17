const assert = require('node:assert/strict');
const test = require('node:test');

const report = require('../routes/report');
const Inventory = require('../models/Inventory');
const Dealer = require('../models/Dealer');
const Audit = require('../models/Audit');
const DealerStock = require('../models/DealerStock');
const MasterCatalogue = require('../models/MasterCatalogue');
const MasterPart = require('../models/MasterPart');

function query(rows) {
  return {
    select() { return this; },
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    lean: async () => rows
  };
}

test('Audit Summary values every uploaded DMS part, including an unscanned shortage', async (t) => {
  const originals = [];
  const replace = (model, method, implementation) => {
    originals.push([model, method, model[method]]);
    model[method] = implementation;
  };
  t.after(() => originals.forEach(([model, method, original]) => { model[method] = original; }));

  const dealerCode = 'DMS-VALUATION-TEST';
  const auditId = 'AUD-DMS-VALUATION-TEST';
  const stock = [
    { dealerCode, auditId, partNumber: 'SCANNED', normalizedPartNumber: 'SCANNED', dmsStock: 2 },
    { dealerCode, auditId, partNumber: 'SHORT-ONLY', normalizedPartNumber: 'SHORT-ONLY', dmsStock: 5 }
  ];
  const masters = [
    { partNumber: 'SCANNED', normalizedPartNumber: 'SCANNED', mrp: 20, dlc: 10 },
    { partNumber: 'SHORT-ONLY', normalizedPartNumber: 'SHORT-ONLY', mrp: 40, dlc: 20 }
  ];

  replace(Inventory, 'find', () => query([{
    dealerCode, auditId, partNumber: 'SCANNED', normalizedPartNumber: 'SCANNED',
    qty: 2, scanType: 'INWARD', type: 'INWARD', syncStatus: 'synced',
    scanStatus: 'ACCEPTED', timestamp: new Date('2026-10-14T00:00:00Z')
  }]));
  replace(Dealer, 'find', () => query([{ dealerCode, dealerName: 'Valuation Dealer' }]));
  replace(Audit, 'find', () => query([{ dealerCode, auditId }]));
  replace(DealerStock, 'find', () => query(stock));
  replace(MasterCatalogue, 'find', () => query(masters));
  replace(MasterPart, 'find', () => query([]));

  const data = await report.buildReportData({ dealerCode, auditId });
  const summary = data.summary[0];
  assert.equal(data.finalRows.length, 2);
  assert.equal(summary.totalDmsStockValue, 120);
  assert.equal(summary.totalActualStockValue, 20);
  assert.equal(summary.totalShortValue, 100);
  assert.equal(summary.totalExcessValue, 0);
  assert.equal(summary.netDifference, -100);
});
