const mongoose = require('mongoose');

const dealerStockSchema = new mongoose.Schema(
  {
    auditId: {
      type: String,
      trim: true,
      required: true,
      index: true
    },
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
    dlp: { type: Number, default: 0 },
    systemQty: { type: Number, default: 0 },
    dmsStock: { type: Number, default: 0 },
    systemBinLoc1: { type: String, trim: true, default: '' },
    systemBinLoc2: { type: String, trim: true, default: '' },
    systemBinLoc3: { type: String, trim: true, default: '' },
    binLoc1: { type: String, trim: true, default: '' },
    binLoc2: { type: String, trim: true, default: '' },
    binLoc3: { type: String, trim: true, default: '' },
    reservedQty: { type: Number, default: 0 },
    movementCodeA: { type: String, trim: true, uppercase: true, default: '' },
    movementCodeB: { type: String, trim: true, uppercase: true, default: '' },
    averageDemand: { type: Number, default: 0 },
    forecast: { type: Number, default: 0 },
    safetyStock: { type: Number, default: 0 },
    rop: { type: Number, default: 0 },
    pendingOrder: { type: Number, default: 0 },
    stockValue: { type: Number, default: 0 },
    stockValueMrp: { type: Number, default: 0 },
    stockValueDlc: { type: Number, default: 0 },
    uploadBatchId: { type: String, trim: true, index: true, default: '' },
    uploadedBy: { type: String, trim: true, default: '' },
    uploadedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

dealerStockSchema.index({ dealerCode: 1, auditId: 1, normalizedPartNumber: 1 }, { unique: true, name: 'dealer_audit_part_unique' });
dealerStockSchema.index({ dealerCode: 1, auditId: 1, partNumber: 1 }, { name: 'dealer_audit_part_lookup' });
dealerStockSchema.index({ dealerCode: 1, auditId: 1, productCategory: 1 }, { name: 'dealer_audit_category_lookup' });
dealerStockSchema.index({ dealerCode: 1, auditId: 1, systemBinLoc1: 1 }, { name: 'dealer_audit_bin_lookup' });
dealerStockSchema.index({ dealerCode: 1, auditId: 1, category: 1, updatedAt: -1 }, { name: 'dealer_audit_category_updated' });
dealerStockSchema.index({ dealerCode: 1, auditId: 1, updatedAt: -1 }, { name: 'dealer_audit_updated' });

dealerStockSchema.pre('validate', function syncDealerStockAliases(next) {
  if (!this.normalizedPartNumber && this.partNumber) {
    this.normalizedPartNumber = String(this.partNumber || '').trim().toUpperCase().replace(/[\s*-]+/g, '');
  }
  if (!this.dlp && this.dlc) this.dlp = this.dlc;
  if (!this.dlc && this.dlp) this.dlc = this.dlp;
  if (!this.dmsStock && this.systemQty) this.dmsStock = this.systemQty;
  if (!this.systemQty && this.dmsStock) this.systemQty = this.dmsStock;
  if (!this.binLoc1 && this.systemBinLoc1) this.binLoc1 = this.systemBinLoc1;
  if (!this.binLoc2 && this.systemBinLoc2) this.binLoc2 = this.systemBinLoc2;
  if (!this.binLoc3 && this.systemBinLoc3) this.binLoc3 = this.systemBinLoc3;
  if (!this.systemBinLoc1 && this.binLoc1) this.systemBinLoc1 = this.binLoc1;
  if (!this.systemBinLoc2 && this.binLoc2) this.systemBinLoc2 = this.binLoc2;
  if (!this.systemBinLoc3 && this.binLoc3) this.systemBinLoc3 = this.binLoc3;
  const qty = Number(this.dmsStock || this.systemQty || 0);
  this.stockValueMrp = qty * Number(this.mrp || 0);
  this.stockValueDlc = qty * Number(this.dlp || this.dlc || 0);
  this.stockValue = this.stockValueDlc;
  next();
});

module.exports = mongoose.model('DealerStock', dealerStockSchema, 'dealer_stock_master');
