const express = require('express');
const ReportFilterSetting = require('../models/ReportFilterSetting');
const auth = require('./auth');

const router = express.Router();

const FILTER_KEYS = [
  'dealer',
  'dateRange',
  'scanType',
  'scanStatus',
  'userName',
  'syncStatus',
  'upiRawQr',
  'role',
  'deviceName',
  'deviceId',
  'entryMode',
  'entryChannel',
  'entrySource',
  'binLocation',
  'partNumber',
  'productCategory',
  'model'
];

const DEFAULT_FILTERS = ['dealer', 'dateRange', 'scanType', 'scanStatus', 'userName', 'syncStatus'];
const DEFAULT_FILTERS_BY_REPORT = {
  'scan-register': ['dealer', 'dateRange', 'scanType', 'scanStatus', 'userName', 'deviceName', 'syncStatus', 'entryMode']
};

function cleanReportName(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

function cleanSelectedFilters(value) {
  const requested = Array.isArray(value) ? value : [];
  const allowed = new Set(FILTER_KEYS);
  return Array.from(new Set(requested.map((item) => String(item || '').trim()).filter((item) => allowed.has(item))));
}

function userId(req) {
  return String(req.user && (req.user.id || req.user._id || req.user.username || req.user.email) || '').trim();
}

router.get('/:reportName', auth.requireAuth, async (req, res) => {
  try {
    const reportName = cleanReportName(req.params.reportName);
    if (!reportName) return res.status(400).json({ success: false, message: 'Report name is required' });
    const defaults = DEFAULT_FILTERS_BY_REPORT[reportName] || DEFAULT_FILTERS;
    const setting = await ReportFilterSetting.findOne({ userId: userId(req), reportName }).lean();
    const selectedFilters = setting ? cleanSelectedFilters(setting.selectedFilters) : defaults;
    res.json({
      success: true,
      reportName,
      selectedFilters,
      defaults,
      availableFilters: FILTER_KEYS,
      saved: Boolean(setting)
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to load report filter settings' });
  }
});

router.post('/:reportName', auth.requireAuth, async (req, res) => {
  try {
    const reportName = cleanReportName(req.params.reportName);
    if (!reportName) return res.status(400).json({ success: false, message: 'Report name is required' });
    const defaults = DEFAULT_FILTERS_BY_REPORT[reportName] || DEFAULT_FILTERS;
    const selectedFilters = cleanSelectedFilters(req.body && req.body.selectedFilters);
    const setting = await ReportFilterSetting.findOneAndUpdate(
      { userId: userId(req), reportName },
      { $set: { selectedFilters } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
    res.json({
      success: true,
      reportName,
      selectedFilters: cleanSelectedFilters(setting.selectedFilters),
      defaults
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to save report filter settings' });
  }
});

module.exports = router;
