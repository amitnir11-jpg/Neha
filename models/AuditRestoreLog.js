const mongoose = require('mongoose');

const auditRestoreLogSchema = new mongoose.Schema(
  {
    dealerCode: { type: String, trim: true, uppercase: true, index: true, default: '' },
    auditId: { type: String, trim: true, index: true, default: '' },
    archiveId: { type: String, trim: true, default: '' },
    restoreDate: { type: Date, default: Date.now, index: true },
    restoredBy: { type: String, trim: true, default: '' },
    restoreType: {
      type: String,
      enum: ['reports', 'scan-data', 'complete'],
      default: 'complete',
      index: true
    },
    restoreMode: {
      type: String,
      enum: ['merge', 'replace', 'new-audit-session'],
      default: 'merge'
    },
    restoreStatus: {
      type: String,
      enum: ['started', 'completed', 'failed', 'cancelled'],
      default: 'started',
      index: true
    },
    totalRecordsRestored: { type: Number, default: 0 },
    counts: { type: mongoose.Schema.Types.Mixed, default: {} },
    logs: { type: [String], default: [] },
    errorMessage: { type: String, trim: true, default: '' }
  },
  {
    timestamps: true,
    collection: 'audit_restore_logs'
  }
);

auditRestoreLogSchema.index({ dealerCode: 1, restoreDate: -1 });
auditRestoreLogSchema.index({ archiveId: 1, restoreDate: -1 });

module.exports = mongoose.model('AuditRestoreLog', auditRestoreLogSchema);
