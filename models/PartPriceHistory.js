const mongoose = require('mongoose');
const { normalizePartNumber } = require('../utils/normalize');

const partPriceHistorySchema = new mongoose.Schema(
  {
    partNumber: { type: String, required: true, trim: true, uppercase: true, index: true },
    normalizedPartNumber: { type: String, required: true, trim: true, uppercase: true, index: true },
    mrp: { type: Number, default: 0 },
    dlc: { type: Number, default: 0 },
    effectiveFrom: { type: Date, default: null, index: true },
    effectiveTo: { type: Date, default: null, index: true },
    isCurrentPrice: { type: Boolean, default: false, index: true },
    sourceFileName: { type: String, trim: true, default: '' },
    uploadedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

partPriceHistorySchema.pre('validate', function normalizePriceHistory(next) {
  const partNo = normalizePartNumber(this.normalizedPartNumber || this.partNumber);
  const today = new Date();
  const effectiveTo = this.effectiveTo instanceof Date ? this.effectiveTo : (this.effectiveTo ? new Date(this.effectiveTo) : null);
  this.partNumber = partNo;
  this.normalizedPartNumber = partNo;
  this.isCurrentPrice = !effectiveTo || (!Number.isNaN(effectiveTo.getTime()) && effectiveTo >= today);
  next();
});

partPriceHistorySchema.index({ normalizedPartNumber: 1, effectiveFrom: 1, effectiveTo: 1 });
partPriceHistorySchema.index({ normalizedPartNumber: 1, mrp: 1, effectiveFrom: 1, effectiveTo: 1 });
partPriceHistorySchema.index({ partNumber: 1, effectiveFrom: 1, effectiveTo: 1 });

module.exports = mongoose.model('PartPriceHistory', partPriceHistorySchema);
