const mongoose = require('mongoose');
const { normalizePartNumber } = require('../utils/normalize');

const inventoryMovementSummarySchema = new mongoose.Schema(
  {
    summaryKey: { type: String, required: true, unique: true, trim: true, index: true },
    partNumber: { type: String, required: true, trim: true, uppercase: true, index: true },
    normalizedPartNumber: { type: String, required: true, trim: true, uppercase: true, index: true },
    dealerCode: { type: String, trim: true, uppercase: true, default: '', index: true },
    auditId: { type: String, trim: true, default: '', index: true },
    mrp: { type: Number, default: 0, index: true },
    scanUPIMRP: { type: Number, default: 0, index: true },
    priceSource: { type: String, trim: true, uppercase: true, default: '' },
    currentCatalogueMrp: { type: Number, default: 0 },
    averageMRP: { type: Number, default: 0 },
    totalQty: { type: Number, default: 0 },
    scannedQty: { type: Number, default: 0 },
    manualQty: { type: Number, default: 0 },
    inwardQty: { type: Number, default: 0 },
    outwardQty: { type: Number, default: 0 },
    fittedQty: { type: Number, default: 0 },
    damageQty: { type: Number, default: 0 },
    remainingQty: { type: Number, default: 0 },
    movementCount: { type: Number, default: 0 },
    totalScanValue: { type: Number, default: 0 },
    totalManualValue: { type: Number, default: 0 },
    finalInventoryValue: { type: Number, default: 0 },
    finalValue: { type: Number, default: 0 },
    firstScanDate: { type: Date, default: null },
    lastScanDate: { type: Date, default: null },
    ageingDays: { type: Number, default: 0 },
    oldestPricePeriod: { type: Date, default: null },
    newestPricePeriod: { type: Date, default: null },
    pricePeriodFrom: { type: Date, default: null },
    pricePeriodTo: { type: Date, default: null },
    priceAgeingDays: { type: Number, default: 0 },
    remarks: { type: String, trim: true, default: '' },
    calculatedAt: { type: Date, default: Date.now, index: true },
    rawScanCount: { type: Number, default: 0 }
  },
  { timestamps: true }
);

inventoryMovementSummarySchema.pre('validate', function normalizeSummary(next) {
  const partNo = normalizePartNumber(this.normalizedPartNumber || this.partNumber);
  this.partNumber = partNo;
  this.normalizedPartNumber = partNo;
  this.dealerCode = String(this.dealerCode || '').trim().toUpperCase();
  this.priceSource = String(this.priceSource || '').trim().toUpperCase();
  this.summaryKey = [
    this.dealerCode || 'ALL',
    this.auditId || 'ALL',
    partNo,
    Number(this.mrp || 0).toFixed(2),
    'SCAN-UPI-MRP'
  ].join('::');
  next();
});

inventoryMovementSummarySchema.index({ dealerCode: 1, auditId: 1, normalizedPartNumber: 1 });
inventoryMovementSummarySchema.index({ normalizedPartNumber: 1, mrp: 1, firstScanDate: 1 });

module.exports = mongoose.model('InventoryMovementSummary', inventoryMovementSummarySchema);
