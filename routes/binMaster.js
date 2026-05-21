const express = require('express');
const mongoose = require('mongoose');
const Bin = require('../models/Bin');
const auth = require('./auth');

const router = express.Router();

function clean(value) {
  return String(value || '').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isValidBinCode(value) {
  const binCode = upper(value);
  return binCode && !['NULL', 'UNDEFINED'].includes(binCode);
}

function publicBin(bin) {
  return {
    id: String(bin._id || ''),
    _id: String(bin._id || ''),
    binCode: upper(bin.binCode),
    binName: clean(bin.binName || bin.binCode),
    dealerCode: upper(bin.dealerCode),
    category: clean(bin.category),
    active: bin.active !== false,
    createdAt: bin.createdAt,
    updatedAt: bin.updatedAt
  };
}

function compactBins(rows = []) {
  const seen = new Set();
  return rows
    .map(publicBin)
    .filter((bin) => {
      if (!isValidBinCode(bin.binCode)) return false;
      const key = `${bin.dealerCode}:${bin.binCode}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.binCode.localeCompare(b.binCode, undefined, { numeric: true, sensitivity: 'base' }));
}

function csvCell(value) {
  const text = String(value === undefined || value === null ? '' : value);
  return `"${text.replace(/"/g, '""')}"`;
}

async function loadBins({ dealerCode, q }) {
  const filter = {
    dealerCode,
    active: { $ne: false },
    binCode: { $nin: [null, '', 'null', 'undefined', 'NULL', 'UNDEFINED'] }
  };
  if (q) {
    const safeQ = escapeRegExp(q);
    filter.$or = [
      { binCode: { $regex: safeQ, $options: 'i' } },
      { binName: { $regex: safeQ, $options: 'i' } },
      { category: { $regex: safeQ, $options: 'i' } }
    ];
  }
  const rows = await Bin.find(filter).sort({ binCode: 1 }).lean();
  return compactBins(rows);
}

router.get('/', auth.requireAuth, async (req, res) => {
  try {
    const dealerCode = upper(req.query.dealerCode);
    if (!dealerCode) {
      return res.json({ success: true, bins: [], count: 0, message: 'Select dealer to view bins' });
    }
    const bins = await loadBins({ dealerCode, q: clean(req.query.q) });
    return res.json({ success: true, dealerCode, bins, count: bins.length });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/export', auth.requireAuth, async (req, res) => {
  try {
    const dealerCode = upper(req.query.dealerCode);
    if (!dealerCode) return res.status(400).json({ success: false, message: 'Dealer code is required' });
    const bins = await loadBins({ dealerCode, q: clean(req.query.q) });
    const header = ['Dealer Code', 'Bin Code', 'Bin Name', 'Category', 'Active'];
    const rows = bins.map((bin) => [bin.dealerCode, bin.binCode, bin.binName, bin.category, bin.active ? 'YES' : 'NO']);
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Bin_Master_${dealerCode}.csv"`);
    return res.send(csv);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/create', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const dealerCode = upper(req.body.dealerCode);
    const binCode = upper(req.body.binCode || req.body.bin || req.body.name);
    if (!dealerCode) return res.status(400).json({ success: false, message: 'Dealer code is required' });
    if (!isValidBinCode(binCode)) return res.status(400).json({ success: false, message: 'Bin code is required' });

    const bin = await Bin.findOneAndUpdate(
      { dealerCode, binCode },
      {
        dealerCode,
        binCode,
        binName: clean(req.body.binName || req.body.name || binCode) || binCode,
        category: clean(req.body.category),
        active: req.body.active === undefined ? true : req.body.active !== false
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    req.io.emit('master:update', { dealerCode, scope: 'bins' });
    return res.json({ success: true, bin: publicBin(bin), message: 'Bin saved' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/bulk-create', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const dealerCode = upper(req.body.dealerCode);
    const prefix = upper(req.body.prefix);
    const suffix = upper(req.body.suffix);
    const start = Number(req.body.startNumber ?? req.body.start);
    const end = Number(req.body.endNumber ?? req.body.end);
    const padding = Math.max(0, Math.min(Number(req.body.padding || 0), 8));
    const category = clean(req.body.category);

    if (!dealerCode) return res.status(400).json({ success: false, message: 'Dealer code is required' });
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      return res.status(400).json({ success: false, message: 'Start Number and End Number are required' });
    }
    if (start > end) return res.status(400).json({ success: false, message: 'Start Number must be less than or equal to End Number' });
    if (end - start + 1 > 5000) return res.status(400).json({ success: false, message: 'Bin sequence limit is 5000 bins at a time' });

    const requestedBins = [];
    for (let value = start; value <= end; value += 1) {
      const sequence = padding > 0 ? String(value).padStart(padding, '0') : String(value);
      const binCode = upper(`${prefix}${sequence}${suffix}`);
      if (isValidBinCode(binCode)) {
        requestedBins.push({ dealerCode, binCode, binName: binCode, category, active: true });
      }
    }
    const uniqueBins = Array.from(new Map(requestedBins.map((bin) => [bin.binCode, bin])).values());
    const existing = await Bin.find({ dealerCode, binCode: { $in: uniqueBins.map((bin) => bin.binCode) } }).select('binCode').lean();
    const existingSet = new Set(existing.map((bin) => upper(bin.binCode)));
    const newBins = uniqueBins.filter((bin) => !existingSet.has(bin.binCode));

    if (newBins.length) await Bin.insertMany(newBins, { ordered: false });

    req.io.emit('master:update', { dealerCode, scope: 'bins' });
    return res.json({
      success: true,
      dealerCode,
      createdCount: newBins.length,
      skippedDuplicateCount: uniqueBins.length - newBins.length,
      duplicateCount: uniqueBins.length - newBins.length,
      bins: newBins,
      duplicates: uniqueBins.filter((bin) => existingSet.has(bin.binCode)).map((bin) => bin.binCode)
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/:id', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const id = clean(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, message: 'Invalid bin id' });
    const existing = await Bin.findById(id);
    if (!existing) return res.status(404).json({ success: false, message: 'Bin not found' });

    const dealerCode = upper(req.body.dealerCode || existing.dealerCode);
    const binCode = upper(req.body.binCode || existing.binCode);
    if (!dealerCode) return res.status(400).json({ success: false, message: 'Dealer code is required' });
    if (!isValidBinCode(binCode)) return res.status(400).json({ success: false, message: 'Bin code is required' });

    const duplicate = await Bin.findOne({ _id: { $ne: id }, dealerCode, binCode }).lean();
    if (duplicate) return res.status(409).json({ success: false, message: 'Bin already exists for this dealer' });

    existing.dealerCode = dealerCode;
    existing.binCode = binCode;
    existing.binName = clean(req.body.binName || binCode) || binCode;
    existing.category = clean(req.body.category);
    existing.active = req.body.active === undefined ? existing.active !== false : req.body.active !== false;
    await existing.save();

    req.io.emit('master:update', { dealerCode, scope: 'bins' });
    return res.json({ success: true, bin: publicBin(existing), message: 'Bin updated' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/:id', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const id = clean(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ success: false, message: 'Invalid bin id' });
    const bin = await Bin.findByIdAndDelete(id).lean();
    if (!bin) return res.status(404).json({ success: false, message: 'Bin not found' });
    req.io.emit('master:update', { dealerCode: upper(bin.dealerCode), scope: 'bins' });
    return res.json({ success: true, deletedCount: 1, bin: publicBin(bin), message: 'Bin deleted' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
