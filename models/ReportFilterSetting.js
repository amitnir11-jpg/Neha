const mongoose = require('mongoose');

const reportFilterSettingSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    reportName: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true
    },
    selectedFilters: {
      type: [String],
      default: []
    }
  },
  {
    timestamps: true,
    collection: 'report_filter_settings'
  }
);

reportFilterSettingSchema.index({ userId: 1, reportName: 1 }, { unique: true });

module.exports = mongoose.model('ReportFilterSetting', reportFilterSettingSchema);
