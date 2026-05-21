const mongoose = require('mongoose');
const { normalizePartNumber } = require('../utils/normalize');

const masterPartSchema = new mongoose.Schema(
  {
    partNo: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      index: true
    },
    partNumber: {
      type: String,
      trim: true,
      uppercase: true,
      index: true
    },
    normalizedPartNumber: {
      type: String,
      trim: true,
      uppercase: true,
      index: true
    },
    partName: {
      type: String,
      trim: true,
      default: ''
    },
    partDescription: {
      type: String,
      trim: true,
      default: ''
    },
    model: {
      type: String,
      trim: true,
      default: ''
    },
    year: {
      type: String,
      trim: true,
      default: ''
    },
    manufacturingYear: {
      type: String,
      trim: true,
      default: ''
    },
    category: {
      type: String,
      trim: true,
      default: ''
    },
    productCategory: {
      type: String,
      trim: true,
      default: ''
    },
    mrp: {
      type: Number,
      default: 0
    },
    dlc: {
      type: Number,
      default: 0
    },
    bin: {
      type: String,
      trim: true,
      default: ''
    },
    binLocation: {
      type: String,
      trim: true,
      default: ''
    },
    dealerCode: {
      type: String,
      trim: true,
      uppercase: true,
      default: '',
      index: true
    },
    dealerName: {
      type: String,
      trim: true,
      default: ''
    },
    activeStatus: {
      type: Boolean,
      default: true
    },
    openingStockQty: {
      type: Number,
      default: 0
    },
    quantity: {
      type: Number,
      default: 0
    },
    qty: {
      type: Number,
      default: 0
    }
  },
  {
    timestamps: true
  }
);

masterPartSchema.pre('save', function syncMasterAliases(next) {
  if (!this.partNumber && this.partNo) this.partNumber = this.partNo;
  if (!this.partNo && this.partNumber) this.partNo = this.partNumber;
  const partNo = normalizePartNumber(this.normalizedPartNumber || this.partNumber || this.partNo || '');
  this.partNo = partNo;
  this.partNumber = partNo;
  this.normalizedPartNumber = partNo;
  if (!this.partDescription && this.partName) this.partDescription = this.partName;
  if (!this.partName && this.partDescription) this.partName = this.partDescription;
  if (!this.productCategory && this.category) this.productCategory = this.category;
  if (!this.category && this.productCategory) this.category = this.productCategory;
  if (!this.manufacturingYear && this.year) this.manufacturingYear = this.year;
  if (!this.year && this.manufacturingYear) this.year = this.manufacturingYear;
  if (!this.binLocation && this.bin) this.binLocation = this.bin;
  if (!this.bin && this.binLocation) this.bin = this.binLocation;
  if (!this.qty && this.quantity) this.qty = this.quantity;
  if (!this.quantity && this.qty) this.quantity = this.qty;
  if (!this.openingStockQty && (this.quantity || this.qty)) this.openingStockQty = this.quantity || this.qty;
  next();
});

masterPartSchema.index({ bin: 1, category: 1, dealerCode: 1 });
masterPartSchema.index({ partDescription: 1 });
masterPartSchema.index({ productCategory: 1 });
masterPartSchema.index({ model: 1 });
masterPartSchema.index({ manufacturingYear: 1 });

module.exports = mongoose.model('MasterPart', masterPartSchema);
