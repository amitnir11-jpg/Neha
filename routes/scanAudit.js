const express = require('express');
const ScanAuditLog = require('../models/ScanAuditLog');
const auth = require('./auth');

const router = express.Router();

function clean(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function parseDate(value, endOfDay = false) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (endOfDay) date.setHours(23, 59, 59, 999);
  return date;
}

function historyFilter(query = {}) {
  const filter = {};
  const dealerCode = upper(query.dealerCode || query.dealer);
  const partNumber = upper(query.partNumber || query.part || '');
  const username = clean(query.username || query.user || query.performedByUsername).toLowerCase();
  const action = upper(query.action);
  const from = parseDate(query.dateFrom || query.from);
  const to = parseDate(query.dateTo || query.to, true);
  if (dealerCode && dealerCode !== 'ALL') filter.dealerCode = dealerCode;
  if (partNumber) filter.partNumber = { $regex: partNumber, $options: 'i' };
  if (username) filter.performedByUsername = { $regex: username, $options: 'i' };
  if (action) filter.action = action;
  if (from || to) {
    filter.timestamp = {};
    if (from) filter.timestamp.$gte = from;
    if (to) filter.timestamp.$lte = to;
  }
  return filter;
}

function publicAudit(row = {}) {
  return {
    id: row._id || row.id,
    action: row.action || '',
    scanId: row.scanId || '',
    dealerCode: row.dealerCode || '',
    dealerName: row.dealerName || '',
    partNumber: row.partNumber || '',
    performedByUserId: row.performedByUserId || '',
    performedByUsername: row.performedByUsername || '',
    performedByName: row.performedByName || '',
    performedByRole: row.performedByRole || '',
    reason: row.reason || '',
    remarks: row.remarks || '',
    oldData: row.oldData || null,
    newData: row.newData || null,
    timestamp: row.timestamp || row.createdAt || null,
    ipAddress: row.ipAddress || '',
    deviceId: row.deviceId || '',
    userAgent: row.userAgent || ''
  };
}

router.get('/history', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500);
    const page = Math.max(Number(req.query.page || 1), 1);
    const filter = historyFilter(req.query);
    const [rows, total] = await Promise.all([
      ScanAuditLog.find(filter).sort({ timestamp: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      ScanAuditLog.countDocuments(filter)
    ]);
    return res.json({
      success: true,
      rows: rows.map(publicAudit),
      history: rows.map(publicAudit),
      total,
      page,
      limit
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/history/:id', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const row = await ScanAuditLog.findById(req.params.id).lean();
    if (!row) return res.status(404).json({ success: false, message: 'Scan modification audit not found' });
    return res.json({ success: true, audit: publicAudit(row) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
