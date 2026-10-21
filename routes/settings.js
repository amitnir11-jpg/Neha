const express = require('express');
const Setting = require('../models/Setting');
const auth = require('./auth');

const router = express.Router();
const SMART_BIN_KEY = 'smart-bin-suggestion';
const QUOTATION_COMPANY_PROFILE_KEY = 'quotation-company-profile';
const DEFAULT_SETTINGS = {
  enabled: true,
  allowMultipleLocations: true,
  requireReason: true,
  maxAllowedLocationsPerPart: 3
};
const DEFAULT_QUOTATION_COMPANY_PROFILE = Object.freeze({
  companyName: 'DAKSH INVENTORY SOLUTION V2',
  addressLine1: 'S-2/63, Deep Nagar, Benad Road,',
  addressLine2: 'Jhotwara, Jaipur, Rajasthan - 302012',
  quotationTitle: 'PART INVENTORY AUDIT QUOTATION',
  quotationSubtitle: 'INVENTORY AUDIT / STOCK VERIFICATION / RECONCILIATION',
  authorizedSignatory: 'Bineet',
  signatoryTitle: 'Authorized Signatory',
  stampLabel: 'DAKSH INVENTORY SOLUTION V2'
});
let smartBinSettingsCache = null;
let smartBinSettingsRead = null;

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

function normalizeQuotationCompanyProfile(input = {}) {
  const source = input && typeof input === 'object'
    ? (input.data && typeof input.data === 'object' ? { ...input.data, ...input } : { ...input })
    : {};
  const value = (key, fallback, limit) => clean(source[key] === undefined ? fallback : source[key]).slice(0, limit);
  return {
    companyName: value('companyName', DEFAULT_QUOTATION_COMPANY_PROFILE.companyName, 160) || DEFAULT_QUOTATION_COMPANY_PROFILE.companyName,
    addressLine1: value('addressLine1', DEFAULT_QUOTATION_COMPANY_PROFILE.addressLine1, 240),
    addressLine2: value('addressLine2', DEFAULT_QUOTATION_COMPANY_PROFILE.addressLine2, 240),
    quotationTitle: value('quotationTitle', DEFAULT_QUOTATION_COMPANY_PROFILE.quotationTitle, 160) || DEFAULT_QUOTATION_COMPANY_PROFILE.quotationTitle,
    quotationSubtitle: value('quotationSubtitle', DEFAULT_QUOTATION_COMPANY_PROFILE.quotationSubtitle, 240),
    authorizedSignatory: value('authorizedSignatory', DEFAULT_QUOTATION_COMPANY_PROFILE.authorizedSignatory, 120),
    signatoryTitle: value('signatoryTitle', DEFAULT_QUOTATION_COMPANY_PROFILE.signatoryTitle, 120),
    stampLabel: value('stampLabel', DEFAULT_QUOTATION_COMPANY_PROFILE.stampLabel, 160)
  };
}

async function readQuotationCompanyProfile() {
  const record = await Setting.findOne({ key: QUOTATION_COMPANY_PROFILE_KEY }).lean();
  return normalizeQuotationCompanyProfile(record || DEFAULT_QUOTATION_COMPANY_PROFILE);
}

async function readSettings() {
  if (smartBinSettingsCache) return { ...smartBinSettingsCache };
  if (smartBinSettingsRead) return { ...(await smartBinSettingsRead) };
  smartBinSettingsRead = (async () => {
    let record;
    try {
      record = await Setting.findOne({ key: SMART_BIN_KEY }).lean();
    } catch (_) {
      return { ...DEFAULT_SETTINGS };
    }
    smartBinSettingsCache = record
      ? { ...DEFAULT_SETTINGS, ...normalizeSettings(record) }
      : { ...DEFAULT_SETTINGS };
    return smartBinSettingsCache;
  })();
  try {
    return { ...(await smartBinSettingsRead) };
  } finally {
    smartBinSettingsRead = null;
  }
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
    smartBinSettingsCache = { ...settings };
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

router.get('/quotation-company-profile', auth.requireAuth, async (req, res) => {
  try {
    return res.json({ success: true, key: QUOTATION_COMPANY_PROFILE_KEY, profile: await readQuotationCompanyProfile() });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to load quotation company profile' });
  }
});

router.put('/quotation-company-profile', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const profile = normalizeQuotationCompanyProfile(req.body || {});
    await Setting.findOneAndUpdate(
      { key: QUOTATION_COMPANY_PROFILE_KEY },
      { $set: { key: QUOTATION_COMPANY_PROFILE_KEY, ...profile, updatedBy: clean(req.user && (req.user.username || req.user.email || req.user.id)) } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return res.json({ success: true, key: QUOTATION_COMPANY_PROFILE_KEY, profile });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Failed to save quotation company profile' });
  }
});

module.exports = router;
module.exports.readSettings = readSettings;
module.exports.normalizeSettings = normalizeSettings;
module.exports.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
module.exports.QUOTATION_COMPANY_PROFILE_KEY = QUOTATION_COMPANY_PROFILE_KEY;
module.exports.DEFAULT_QUOTATION_COMPANY_PROFILE = DEFAULT_QUOTATION_COMPANY_PROFILE;
module.exports.normalizeQuotationCompanyProfile = normalizeQuotationCompanyProfile;
module.exports.readQuotationCompanyProfile = readQuotationCompanyProfile;
