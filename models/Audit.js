const mongoose = require('mongoose');

const auditSchema = new mongoose.Schema(
  {
    auditId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true
    },
    auditName: {
      type: String,
      trim: true,
      default: ''
    },
    dealerName: {
      type: String,
      trim: true,
      default: ''
    },
    dealerCode: {
      type: String,
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
    completedBy: {
      type: String,
      trim: true,
      default: ''
    },
    status: {
      type: String,
      enum: ['active', 'open', 'closed'],
      default: 'active',
      index: true
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('Audit', auditSchema);
