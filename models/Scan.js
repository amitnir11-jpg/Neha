const mongoose = require('mongoose');

const scanSchema = new mongoose.Schema({
    syncKey: { type: String, required: true, unique: true },
    partNumber: String,
    partName: String,
    binLocation: String,
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