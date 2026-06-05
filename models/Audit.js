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
      enum: ['IN_PROGRESS', 'COMPLETED', 'active', 'open', 'closed'],
      default: 'IN_PROGRESS',
      index: true
    },
    auditStatus: {
      type: String,
      enum: ['IN_PROGRESS', 'COMPLETED'],
      default: 'IN_PROGRESS',
      index: true
    },
    completedAt: {
      type: Date
    },
    completedByUserId: {
      type: String,
      trim: true,
      default: ''
    },
    completionRemark: {
      type: String,
      trim: true,
      default: ''
    },
    statusHistory: [{
      status: {
        type: String,
        enum: ['IN_PROGRESS', 'COMPLETED']
      },
      changedAt: {
        type: Date,
        default: Date.now
      },
      changedBy: {
        type: String,
        trim: true
      },
      remark: {
        type: String,
        trim: true
      }
    }]
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('Audit', auditSchema);
