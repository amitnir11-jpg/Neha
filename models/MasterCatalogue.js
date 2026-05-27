const mongoose = require('mongoose');
const { cleanText, normalizePartNumber } = require('../utils/normalize');

const masterCatalogueSchema = new mongoose.Schema(
  {
    partNumber: { type: String, required: true, trim: true, uppercase: true, index: true },
    normalizedPartNumber: { type: String, required: true, trim: true, uppercase: true, unique: true, index: true },
    partDescription: { type: String, trim: true, uppercase: true, default: '', index: true },
    productCategory: { type: String, trim: true, uppercase: true, default: '', index: true },
    mrp: { type: Number, default: 0 },
    dlc: { type: Number, default: 0 },
    productGroup: { type: String, trim: true, uppercase: true, default: '', index: true },
    model: { type: String, trim: true, uppercase: true, default: '', index: true },
    year: { type: String, trim: true, uppercase: true, default: '', index: true },
    manufacturingYear: { type: String, trim: true, uppercase: true, default: '' },
    productType: { type: String, trim: true, uppercase: true, default: '' },
    superceededBy: { type: String, trim: true, uppercase: true, default: '' },
    partGroup: { type: String, trim: true, uppercase: true, default: '' },
    partSubGroup: { type: String, trim: true, uppercase: true, default: '', index: true },
    gstCategory: { type: String, trim: true, uppercase: true, default: '' },
    sourceFileName: { type: String, trim: true, default: '' },
    uploadedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

masterCatalogueSchema.pre('save', function normalizeCatalogue(next) {
  const partNo = normalizePartNumber(this.normalizedPartNumber || this.partNumber);
  this.partNumber = partNo;
  this.normalizedPartNumber = partNo;
  [
    'partDescription',
    'productCategory',
    'productGroup',
    'model',
    'year',
    'manufacturingYear',
    'productType',
    'superceededBy',
    'partGroup',
    'partSubGroup',
    'gstCategory'
  ].forEach((field) => {
    this[field] = cleanText(this[field]).toUpperCase();
  });
  if (!this.manufacturingYear && this.year) this.manufacturingYear = this.year;
  if (!this.year && this.manufacturingYear) this.year = this.manufacturingYear;
  next();
});

masterCatalogueSchema.index({
  partNumber: 'text',
  partDescription: 'text',
  productCategory: 'text',
  model: 'text',
  year: 'text',
  productGroup: 'text'
});
masterCatalogueSchema.index({ normalizedPartNumber: 1, productCategory: 1, productGroup: 1 });
masterCatalogueSchema.index({ productCategory: 1, productGroup: 1, partSubGroup: 1 });

module.exports = mongoose.model('MasterCatalogue', masterCatalogueSchema);
