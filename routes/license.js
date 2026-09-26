const express = require('express');
const licenseService = require('../services/LicenseService');
const { isLocalRequest } = require('../services/LicenseService');

const router = express.Router();

function localActivationAllowed(req) {
  if (isLocalRequest(req)) return true;
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.DAKSH_LICENSE_ALLOW_REMOTE_ACTIVATION || '').trim().toLowerCase());
}

function requireLocalActivation(req, res, next) {
  if (localActivationAllowed(req)) return next();
  return res.status(403).json({
    success: false,
    message: 'License activation is only allowed from this PC.'
  });
}

router.get('/status', async (req, res) => {
  const status = await licenseService.currentStatus({ force: true });
  res.json({
    success: true,
    license: licenseService.publicStatus(status, { includeDevice: isLocalRequest(req) })
  });
});

router.post('/activate', requireLocalActivation, async (req, res) => {
  try {
    const status = await licenseService.activate(req.body.licenseKey, req.body);
    res.json({
      success: true,
      message: 'Activation successful.',
      license: status
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message || 'Activation failed'
    });
  }
});

router.post('/revalidate', requireLocalActivation, async (req, res) => {
  try {
    const status = await licenseService.revalidate();
    res.json({
      success: true,
      message: 'License revalidated.',
      license: status
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message || 'License revalidation failed'
    });
  }
});

router.post('/deactivate', requireLocalActivation, async (req, res) => {
  try {
    const status = await licenseService.deactivate({
      forceLocal: req.body.forceLocal === true || req.body.forceLocal === 'true'
    });
    res.json({
      success: true,
      message: 'Activation removed from this PC.',
      license: status
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message || 'License deactivation failed'
    });
  }
});

module.exports = router;
