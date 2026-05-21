const mongoose = require('mongoose');

const dealerSchema = new mongoose.Schema(
  {
    dealerName: {
      type: String,
      required: true,
      trim: true
    },
    dealerCode: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      index: true
    },
    brand: {
      type: String,
      trim: true,
      default: ''
    },
    location: {
      type: String,
      trim: true,
      default: ''
    },
    auditName: {
      type: String,
      trim: true,
      default: ''
    },
    auditStartDate: {
      type: Date
    },
    auditClosedDate: {
      type: Date
    },
    auditorName: {
      type: String,
      trim: true,
      default: ''
    },
    generalManager: {
      type: String,
      trim: true,
      default: ''
    },
    spmName: {
      type: String,
      trim: true,
      default: ''
    },
    currentAuditId: {
      type: String,
      trim: true,
      index: true
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

dealerSchema.pre('save', function uppercaseDealer(next) {
  ['dealerName', 'dealerCode', 'brand', 'location', 'auditName', 'auditorName', 'generalManager', 'spmName', 'currentAuditId'].forEach((field) => {
    if (this[field]) this[field] = String(this[field]).trim().toUpperCase();
  });
  next();
});

module.exports = mongoose.model('Dealer', dealerSchema);
