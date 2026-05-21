const express = require('express');
const Bin = require('../models/Bin');
const auth = require('./auth');

const router = express.Router();

function clean(value) {
  return String(value || '').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

router.post('/create-sequence', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const prefix = upper(req.body.prefix);
    const suffix = upper(req.body.suffix);
    const start = Number(req.body.startNumber || req.body.start);
    const end = Number(req.body.endNumber || req.body.end);
    const dealerCode = upper(req.body.dealerCode);
    const category = clean(req.body.category);
    if (!dealerCode) {
      return res.status(400).json({ success: false, message: 'Dealer code is required' });
    }

    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      return res.status(400).json({ success: false, message: 'Start Number and End Number are required' });
    }
    if (start > end) {
      return res.status(400).json({ success: false, message: 'Start Number must be less than or equal to End Number' });
    }
    if (end - start + 1 > 5000) {
      return res.status(400).json({ success: false, message: 'Bin sequence limit is 5000 bins at a time' });
    }

    const bins = [];
    for (let value = start; value <= end; value += 1) {
      const binCode = upper(`${prefix}${value}${suffix}`);
      if (binCode) bins.push({ binCode, binName: binCode, category, dealerCode, active: true });
    }

    const existing = await Bin.find({ dealerCode, binCode: { $in: bins.map((bin) => bin.binCode) } }).select('binCode').lean();
    const existingSet = new Set(existing.map((bin) => bin.binCode));
    const created = bins.filter((bin) => !existingSet.has(bin.binCode));
    if (created.length) await Bin.insertMany(created, { ordered: false });

    req.io.emit('master:update');
    return res.json({
      success: true,
      createdCount: created.length,
      skippedDuplicateCount: bins.length - created.length,
      duplicateCount: bins.length - created.length,
      bins: created
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
