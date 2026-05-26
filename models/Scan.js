const mongoose = require('mongoose');

const scanSchema = new mongoose.Schema({
    syncKey: { type: String, required: true, unique: true },
    partNumber: String,
    partName: String,
    binLocation: String,
    autoDetectedBin: { type: Boolean, default: false },
    binSelectionMode: String,
    regdNo: String,
    jobCardNo: String,
    isFitted: { type: Boolean, default: false },
    fittedQty: { type: Number, default: 0 },
    fittedLocation: String,
    status: String,
    stockDeductedFromBin: String,
    quantity: Number,
    mrp: Number,
    scanType: String,
    upiId: String,
    rawScanString: String,
    staffName: String,
    timestamp: String,
    deviceId: String,
    dealerCode: String
}, { timestamps: true });

module.exports = mongoose.model('Scan', scanSchema);
