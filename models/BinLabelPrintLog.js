const mongoose = require('mongoose');

const binLabelPrintLogSchema = new mongoose.Schema(
  {
    dealerCode: { type: String, trim: true, uppercase: true, index: true },
    binNumber: { type: String, trim: true, uppercase: true, index: true },
    partNumber: { type: String, trim: true, uppercase: true, index: true },
    printedBy: { type: String, trim: true, default: '' },
    printedAt: { type: Date, default: Date.now, index: true },
    deviceId: { type: String, trim: true, default: '' },
    copies: { type: Number, default: 1 },
    labelWidthMm: { type: Number, default: 70 },
    labelHeightMm: { type: Number, default: 28 },
    qrSizeMm: { type: Number, default: 20 },
    printArea: { type: String, trim: true, default: 'full' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('BinLabelPrintLog', binLabelPrintLogSchema);
