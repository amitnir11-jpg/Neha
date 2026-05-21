const mongoose = require('mongoose');

const dealerStockSchema = new mongoose.Schema(
  {
    dealerCode: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
      index: true
    },
    partNumber: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
      index: true
    },
    normalizedPartNumber: {
      type: String,
      trim: true,
      uppercase: true,
      index: true
    },
    partDescription: { type: String, trim: true, default: '' },
    productCategory: { type: String, trim: true, default: '' },
    category: { type: String, trim: true, default: '' },
    model: { type: String, trim: true, default: '' },
    year: { type: String, trim: true, default: '' },
    manufacturingYear: { type: String, trim: true, default: '' },
    productGroup: { type: String, trim: true, default: '' },
    partSubGroup: { type: String, trim: true, default: '' },
    mrp: { type: Number, default: 0 },
    dlc: { type: Number, default: 0 },
    systemQty: { type: Number, default: 0 },
    dmsStock: { type: Number, default: 0 },
    systemBinLoc1: { type: String, trim: true, default: '' },
    systemBinLoc2: { type: String, trim: true, default: '' },
    systemBinLoc3: { type: String, trim: true, default: '' },
    reservedQty: { type: Number, default: 0 },
    uploadedBy: { type: String, trim: true, default: '' },
    uploadedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

dealerStockSchema.index({ dealerCode: 1, normalizedPartNumber: 1 }, { unique: true });

module.exports = mongoose.model('DealerStock', dealerStockSchema);
