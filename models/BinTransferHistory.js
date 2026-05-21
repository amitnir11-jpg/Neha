const mongoose = require('mongoose');

const binTransferHistorySchema = new mongoose.Schema(
  {
    transferId: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    dealerCode: {
      type: String,
      trim: true,
      uppercase: true,
      index: true
    },
    fromBin: {
      type: String,
      trim: true,
      index: true
    },
    toBin: {
      type: String,
      trim: true,
      index: true
    },
    partNumber: {
      type: String,
      trim: true,
      uppercase: true,
      index: true
    },
    partDescription: {
      type: String,
      trim: true,
      default: ''
    },
    qty: {
      type: Number,
      default: 0
    },
    transferType: {
      type: String,
      enum: ['single', 'multiple', 'bulk'],
      default: 'single',
      index: true
    },
    transferredBy: {
      type: String,
      trim: true,
      default: ''
    },
    transferredAt: {
      type: Date,
      default: Date.now,
      index: true
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('BinTransferHistory', binTransferHistorySchema);
