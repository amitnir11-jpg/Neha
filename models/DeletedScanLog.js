const mongoose = require('mongoose');

const deletedScanLogSchema = new mongoose.Schema(
  {
    deletedTime: { type: Date, default: Date.now, index: true },
    deletedBy: { type: String, trim: true, default: '' },
    dealerCode: { type: String, trim: true, uppercase: true, index: true },
    partNumber: { type: String, trim: true, uppercase: true, index: true },
    qty: { type: Number, default: 0 },
    scanType: { type: String, trim: true, uppercase: true, default: '' },
    reason: { type: String, trim: true, default: '' },
    source: { type: String, trim: true, default: 'PC' },
    scanId: { type: String, trim: true, default: '' },
    archivedDocument: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  { timestamps: true }
);

module.exports = mongoose.model('DeletedScanLog', deletedScanLogSchema);
