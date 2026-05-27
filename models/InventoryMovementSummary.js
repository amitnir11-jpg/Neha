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
    priceSource: { type: String, trim: true, uppercase: true, default: '' },
    currentCatalogueMrp: { type: Number, default: 0 },
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
    inventoryRiskValue: { type: Number, default: 0 },
    firstScanDate: { type: Date, default: null },
    lastScanDate: { type: Date, default: null },
    lastMovementDate: { type: Date, default: null },
    movementQtyLast30Days: { type: Number, default: 0 },
    movementQtyLast90Days: { type: Number, default: 0 },
    movementQtyLast180Days: { type: Number, default: 0 },
    movementQtyLast365Days: { type: Number, default: 0 },
    ageingDays: { type: Number, default: 0 },
    daysSinceLastMovement: { type: Number, default: null },
    movementCategory: {
      type: String,
      enum: ['FAST', 'SLOW', 'DEAD', 'NON-MOVING', ''],
      default: '',
      index: true
    },
    oldestPricePeriod: { type: Date, default: null },
    newestPricePeriod: { type: Date, default: null },
    priceAgeingDays: { type: Number, default: 0 },
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
    this.priceSource || 'UNKNOWN'
  ].join('::');
  next();
});

inventoryMovementSummarySchema.index({ dealerCode: 1, auditId: 1, normalizedPartNumber: 1 });
inventoryMovementSummarySchema.index({ dealerCode: 1, auditId: 1, normalizedPartNumber: 1, movementCategory: 1 });
inventoryMovementSummarySchema.index({ normalizedPartNumber: 1, mrp: 1, firstScanDate: 1 });

module.exports = mongoose.model('InventoryMovementSummary', inventoryMovementSummarySchema);
