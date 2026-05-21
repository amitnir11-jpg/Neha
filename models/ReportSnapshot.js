const mongoose = require('mongoose');
const { randomUUID } = require('crypto');

const reportSnapshotSchema = new mongoose.Schema(
  {
    reportId: { type: String, required: true, unique: true, default: randomUUID, trim: true, index: true },
    reportType: { type: String, trim: true, default: '', index: true },
    title: { type: String, trim: true, default: '' },
    dealerCode: { type: String, trim: true, uppercase: true, default: '', index: true },
    auditId: { type: String, trim: true, default: '', index: true },
    generatedBy: { type: String, trim: true, default: '' },
    generatedAt: { type: Date, default: Date.now, index: true },
    rowCount: { type: Number, default: 0 },
    filters: { type: mongoose.Schema.Types.Mixed, default: {} },
    summary: { type: mongoose.Schema.Types.Mixed, default: {} },
    realtimeVersion: { type: Number, default: 1 }
  },
  { timestamps: true }
);

module.exports = mongoose.model('ReportSnapshot', reportSnapshotSchema);
