const express = require('express');
const Setting = require('../models/Setting');
const auth = require('./auth');

const router = express.Router();
const SMART_BIN_KEY = 'smart-bin-suggestion';
const DEFAULT_SETTINGS = {
  enabled: true,
  allowMultipleLocations: true,
  requireReason: true,
  maxAllowedLocationsPerPart: 3
};

function clean(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return Boolean(fallback);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = clean(value).toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(text)) return false;
  return Boolean(fallback);
}

function toInteger(value, fallback) {
  const parsed = Number.parseInt(String(value === undefined || value === null || value === '' ? fallback : value), 10);
  return Number.isFinite(parsed) ? parsed : Number.parseInt(String(fallback), 10);
}

function normalizeSettings(input = {}) {
  const source = input && typeof input === 'object'
    ? (input.data && typeof input.data === 'object' ? { ...input.data, ...input } : { ...input })
    : {};
  return {
    enabled: toBoolean(source.enabled, DEFAULT_SETTINGS.enabled),
    allowMultipleLocations: toBoolean(source.allowMultipleLocations, DEFAULT_SETTINGS.allowMultipleLocations),
    requireReason: toBoolean(source.requireReason, DEFAULT_SETTINGS.requireReason),
    maxAllowedLocationsPerPart: Math.max(1, toInteger(source.maxAllowedLocationsPerPart, DEFAULT_SETTINGS.maxAllowedLocationsPerPart) || DEFAULT_SETTINGS.maxAllowedLocationsPerPart)
  };
}

async function readSettings() {
  const record = await Setting.findOne({ key: SMART_BIN_KEY }).lean().catch(() => null);
  if (!record) return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...normalizeSettings(record) };
}

router.get('/smart-bin-suggestion', auth.requireAuth, async (req, res) => {
  try {
    const settings = await readSettings();
    return res.json({
      success: true,
      key: SMART_BIN_KEY,
      ...settings
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load smart bin suggestion settings',
      key: SMART_BIN_KEY,
      ...DEFAULT_SETTINGS
    });
  }
});

router.post('/smart-bin-suggestion', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const payload = normalizeSettings(req.body || {});
    const updated = await Setting.findOneAndUpdate(
      { key: SMART_BIN_KEY },
      {
      $set: {
          key: SMART_BIN_KEY,
          enabled: payload.enabled,
          allowMultipleLocations: payload.allowMultipleLocations,
          requireReason: payload.requireReason,
          maxAllowedLocationsPerPart: payload.maxAllowedLocationsPerPart,
          updatedBy: clean(req.user && (req.user.username || req.user.email || req.user.name || req.user.id)),
          updatedByName: clean(req.user && (req.user.name || req.user.username || req.user.email))
        }
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();

    const settings = normalizeSettings(updated || payload);
    return res.json({
      success: true,
      key: SMART_BIN_KEY,
      ...settings,
      updatedBy: clean(req.user && (req.user.username || req.user.email || req.user.name || req.user.id)),
      updatedByName: clean(req.user && (req.user.name || req.user.username || req.user.email))
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to save smart bin suggestion settings'
    });
  }
});

module.exports = router;
module.exports.readSettings = readSettings;
module.exports.normalizeSettings = normalizeSettings;
module.exports.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
