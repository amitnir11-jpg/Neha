const mongoose = require('mongoose');
const { randomUUID } = require('crypto');
const { normalizePartNumber } = require('../utils/normalize');

const inventorySchema = new mongoose.Schema(
  {
    uniqueScanId: {
      type: String,
      required: true,
      default: randomUUID,
      unique: true,
      index: true
    },
    scanId: {
      type: String,
      required: true,
      default: randomUUID,
      trim: true
    },
    part: {
      type: String,
      required: true,
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
    productGroup: {
      type: String,
      trim: true,
      uppercase: true,
      default: ''
    },
    productType: {
      type: String,
      trim: true,
      uppercase: true,
      default: ''
    },
    superceededBy: {
      type: String,
      trim: true,
      uppercase: true,
      default: ''
    },
    partGroup: {
      type: String,
      trim: true,
      uppercase: true,
      default: ''
    },
    partSubGroup: {
      type: String,
      trim: true,
      uppercase: true,
      default: ''
    },
    gstCategory: {
      type: String,
      trim: true,
      uppercase: true,
      default: ''
    },
    qty: {
      type: Number,
      default: 1,
      min: 0
    },
    quantity: {
      type: Number,
      default: 1,
      min: 0
    },
    mrp: {
      type: Number,
      default: 0
    },
    scanMRP: {
      type: Number,
      default: 0
    },
    manualMRP: {
      type: Number,
      default: 0
    },
    valuationMRP: {
      type: Number,
      default: 0,
      index: true
    },
    valuationSource: {
      type: String,
      enum: ['UPI_SCANNED_MRP', 'MANUAL_ENTERED_MRP', 'NO_SCANNED_OR_MANUAL_MRP', ''],
      default: '',
      index: true
    },
    finalInventoryValue: {
      type: Number,
      default: 0
    },
    // MRP Management Fields - NEW
    defaultMRP: {
      type: Number,
      default: 0,
      description: 'Latest MRP from Price History or Part Master (auto-fetched)'
    },
    finalMRP: {
      type: Number,
      default: 0,
      description: 'Final MRP used for calculations (user-entered or default)'
    },
    mrpStatus: {
      type: String,
      enum: ['AVAILABLE', 'PENDING', 'UPDATED', ''],
      default: '',
      index: true,
      description: 'PENDING = MRP not entered at scan time, AVAILABLE = MRP set, UPDATED = MRP updated later'
    },
    mrpPendingUpdatedAt: {
      type: Date,
      default: null,
      description: 'When MRP Pending status was last updated with actual MRP'
    },
    priceHistoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PartPriceHistory',
      default: null,
      index: true
    },
    pricePeriodFrom: {
      type: Date,
      default: null
    },
    pricePeriodTo: {
      type: Date,
      default: null
    },
    pricePeriodMatched: {
      type: Boolean,
      default: false
    },
    pricePeriodStatus: {
      type: String,
      trim: true,
      uppercase: true,
      default: ''
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
    autoDetectedBin: {
      type: Boolean,
      default: false,
      index: true
    },
    binSelectionMode: {
      type: String,
      enum: ['MANUAL', 'AUTO', ''],
      default: ''
    },
    stockDeductedFromBin: {
      type: String,
      trim: true,
      uppercase: true,
      default: ''
    },
    regdNo: {
      type: String,
      trim: true,
      uppercase: true,
      default: ''
    },
    jobCardNo: {
      type: String,
      trim: true,
      uppercase: true,
      default: ''
    },
    isFitted: {
      type: Boolean,
      default: false,
      index: true
    },
    fittedQty: {
      type: Number,
      default: 0,
      min: 0
    },
    fittedLocation: {
      type: String,
      trim: true,
      uppercase: true,
      default: ''
    },
    status: {
      type: String,
      trim: true,
      uppercase: true,
      default: ''
    },
    type: {
      type: String,
      enum: ['AUDIT', 'INWARD', 'OUTWARD', 'VERIFICATION', 'FITTED', 'DAMAGE'],
      default: 'INWARD',
      index: true
    },
    scanType: {
      type: String,
      enum: ['AUDIT', 'INWARD', 'OUTWARD', 'VERIFICATION', 'FITTED', 'DAMAGE'],
      default: 'INWARD',
      index: true
    },
    upiId: {
      type: String,
      trim: true,
      default: '',
      index: true
    },
    upiNo: {
      type: String,
      trim: true,
      uppercase: true,
      default: '',
      index: true
    },
    dealerCode: {
      type: String,
      trim: true,
      uppercase: true,
      index: true
    },
    dealerName: {
      type: String,
      trim: true,
      default: ''
    },
    auditId: {
      type: String,
      trim: true,
      index: true
    },
    rawScan: {
      type: String,
      default: ''
    },
    rawScanString: {
      type: String,
      default: ''
    },
    rawBarcode: {
      type: String,
      default: ''
    },
    rawQR: {
      type: String,
      default: ''
    },
    rawUpi: {
      type: String,
      default: ''
    },
    qrFingerprint: {
      type: String,
      trim: true,
      default: ''
    },
    deviceId: {
      type: String,
      trim: true,
      default: ''
    },
    deviceName: {
      type: String,
      trim: true,
      default: ''
    },
    userId: {
      type: String,
      trim: true,
      default: '',
      index: true
    },
    loginId: {
      type: String,
      trim: true,
      default: '',
      index: true
    },
    staffName: {
      type: String,
      trim: true,
      default: ''
    },
    userName: {
      type: String,
      trim: true,
      default: ''
    },
    role: {
      type: String,
      trim: true,
      lowercase: true,
      default: ''
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true
    },
    scanTime: {
      type: Date,
      default: Date.now,
      index: true
    },
    serverReceivedAt: {
      type: Date,
      default: Date.now
    },
    mobileReceivedTime: {
      type: String,
      trim: true,
      default: ''
    },
    mobileReceivedTimeUtc: {
      type: String,
      trim: true,
      default: ''
    },
    syncBatchId: {
      type: String,
      trim: true,
      default: ''
    },
    serverTimeZone: {
      type: String,
      trim: true,
      default: ''
    },
    synced: {
      type: Boolean,
      default: false,
      index: true
    },
    syncKey: {
      type: String,
      trim: true,
      default: ''
    },
    clientScanId: {
      type: String,
      trim: true,
      default: ''
    },
    clientSyncKey: {
      type: String,
      trim: true,
      default: ''
    },
    syncStatus: {
      type: String,
      enum: ['pending', 'synced', 'failed', 'duplicate', 'rejected'],
      default: 'pending',
      index: true
    },
    scanStatus: {
      type: String,
      enum: ['ACCEPTED', 'DUPLICATE_BLOCKED', 'SUPERVISOR_APPROVED', 'OUTWARD_DONE', 'FAILED'],
      default: 'ACCEPTED',
      index: true
    },
    syncError: {
      type: String,
      trim: true,
      default: ''
    },
    source: {
      type: String,
      enum: ['mobile', 'manual', 'scanner', 'bluetooth_scanner', 'Bluetooth Scanner', 'barcode', 'camera', 'qr', 'ocr_label', 'import', 'api', ''],
      default: ''
    },
    scanMode: {
      type: String,
      trim: true,
      default: ''
    },
    isSynced: {
      type: Boolean,
      default: false,
      index: true
    },
    warnings: {
      type: [String],
      default: []
    },
    remarks: {
      type: String,
      trim: true,
      default: ''
    },
    isDuplicate: {
      type: Boolean,
      default: false,
      index: true
    },
    masterFound: {
      type: Boolean,
      default: false,
      index: true
    },
    isMasterMatched: {
      type: Boolean,
      default: false,
      index: true
    },
    masterMatch: {
      type: Boolean,
      default: false,
      index: true
    },
    overrideBy: {
      type: String,
      trim: true,
      default: ''
    },
    rawScanArchivedAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true
  }
);

inventorySchema.index({ part: 1, dealerCode: 1, auditId: 1, timestamp: 1 });
inventorySchema.index({ normalizedPartNumber: 1, valuationMRP: 1, timestamp: 1 });
inventorySchema.index({ dealerCode: 1, auditId: 1, normalizedPartNumber: 1, valuationMRP: 1 });
inventorySchema.index({ dealerCode: 1, auditId: 1, normalizedPartNumber: 1, scanType: 1, scanMRP: 1, timestamp: -1 });
inventorySchema.index({ dealerCode: 1, auditId: 1, partNumber: 1, scanType: 1, valuationMRP: 1, scanTime: -1 });
inventorySchema.index({ dealerCode: 1, auditId: 1, timestamp: -1, createdAt: -1 });
inventorySchema.index({ dealerCode: 1, auditId: 1, scanStatus: 1, rawScan: 1 });
inventorySchema.index({ dealerCode: 1, auditId: 1, scanStatus: 1, rawScanString: 1 });
inventorySchema.index({ rawScan: 1, dealerCode: 1, auditId: 1 });
inventorySchema.index({ syncKey: 1 });
inventorySchema.index({ upiId: 1, dealerCode: 1 });
inventorySchema.index({ upiNo: 1, dealerCode: 1 });
inventorySchema.index({ rawScan: 1, dealerCode: 1 });
inventorySchema.index(
  { rawUpi: 1, dealerCode: 1, auditId: 1 },
  {
    name: 'unique_accepted_raw_upi_by_audit',
    unique: true,
    partialFilterExpression: {
      rawUpi: { $type: 'string', $gt: '' },
      scanStatus: { $in: ['ACCEPTED', 'SUPERVISOR_APPROVED'] },
      scanType: { $in: ['AUDIT', 'INWARD', 'VERIFICATION', 'DAMAGE'] }
    }
  }
);
inventorySchema.index(
  { qrFingerprint: 1 },
  {
    unique: true,
    partialFilterExpression: { qrFingerprint: { $type: 'string', $gt: '' } }
  }
);
inventorySchema.index(
  { scanId: 1 },
  {
    unique: true,
    partialFilterExpression: { scanId: { $type: 'string', $gt: '' } }
  }
);

inventorySchema.pre('save', function syncInventoryAliases(next) {
  if (!this.uniqueScanId && this.scanId) this.uniqueScanId = this.scanId;
  if (!this.scanId && this.uniqueScanId) this.scanId = this.uniqueScanId;
  if (!this.uniqueScanId) this.uniqueScanId = randomUUID();
  if (!this.scanId) this.scanId = this.uniqueScanId;
  const partNo = normalizePartNumber(this.normalizedPartNumber || this.partNumber || this.part || '');
  this.normalizedPartNumber = partNo;
  if (partNo) {
    this.partNumber = partNo;
    this.part = partNo;
  }
  if (!this.partNumber && this.part) this.partNumber = this.part;
  if (!this.part && this.partNumber) this.part = this.partNumber;
  if (!this.partDescription && this.partName) this.partDescription = this.partName;
  if (!this.partName && this.partDescription) this.partName = this.partDescription;
  if (!this.productCategory && this.category) this.productCategory = this.category;
  if (!this.category && this.productCategory) this.category = this.productCategory;
  if (!this.manufacturingYear && this.year) this.manufacturingYear = this.year;
  if (!this.year && this.manufacturingYear) this.year = this.manufacturingYear;
  [
    'partName',
    'partDescription',
    'model',
    'year',
    'manufacturingYear',
    'category',
    'productCategory',
    'productGroup',
    'productType',
    'superceededBy',
    'partGroup',
    'partSubGroup',
    'gstCategory',
    'bin',
    'binLocation',
    'stockDeductedFromBin',
    'regdNo',
    'jobCardNo',
    'fittedLocation',
    'status',
    'dealerCode',
    'dealerName',
    'staffName'
  ].forEach((field) => {
    if (this[field]) this[field] = String(this[field]).trim().toUpperCase();
  });
  this.masterMatch = Boolean(this.masterMatch || this.isMasterMatched);
  this.isMasterMatched = Boolean(this.isMasterMatched || this.masterMatch);
  this.masterFound = Boolean(this.masterFound || this.masterMatch || this.isMasterMatched);
  if (!this.timestamp && this.scanTime) this.timestamp = this.scanTime;
  if (!this.scanTime && this.timestamp) this.scanTime = this.timestamp;
  if (!this.rawUpi && (this.rawScan || this.rawScanString)) this.rawUpi = this.rawScan || this.rawScanString;
  if (!this.rawBarcode && (this.rawScan || this.rawScanString)) this.rawBarcode = this.rawScan || this.rawScanString;
  if (!this.rawQR && (this.rawScan || this.rawScanString)) this.rawQR = this.rawScan || this.rawScanString;
  if (!this.upiNo && this.upiId) this.upiNo = this.upiId;
  if (!this.upiId && this.upiNo) this.upiId = this.upiNo;
  next();
});

module.exports = mongoose.model('Inventory', inventorySchema);
