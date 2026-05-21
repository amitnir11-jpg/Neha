const mongoose = require('mongoose');

const binSchema = new mongoose.Schema(
  {
    binCode: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      index: true
    },
    binName: {
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
    category: {
      type: String,
      trim: true,
      default: ''
    },
    active: {
      type: Boolean,
      default: true
    }
  },
  {
    timestamps: true
  }
);

binSchema.index({ binCode: 1, dealerCode: 1 }, { unique: true });

module.exports = mongoose.model('Bin', binSchema);
