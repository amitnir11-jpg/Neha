const express = require('express');
const multer = require('multer');
const Inventory = require('../models/Inventory');
const MasterPart = require('../models/MasterPart');
const Dealer = require('../models/Dealer');
const Device = require('../models/Device');
const Audit = require('../models/Audit');
const User = require('../models/User');
const auth = require('./auth');
const inventoryRoute = require('./inventory');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

function cleanDocument(document) {
  if (!document) return document;
  const clone = { ...document };
  delete clone._id;
  delete clone.__v;
  return clone;
}

router.get('/download', auth.requireAuth, async (req, res) => {
  try {
    const inventoryFilter = inventoryRoute.buildListQuery(req.query);
    const [inventory, masterParts, dealers, devices, audits, users] = await Promise.all([
      Inventory.find(inventoryFilter).lean(),
      MasterPart.find({}).lean(),
      Dealer.find(req.query.dealerCode ? { dealerCode: String(req.query.dealerCode).trim().toUpperCase() } : {}).lean(),
      Device.find({}).lean(),
      Audit.find(req.query.dealerCode ? { dealerCode: String(req.query.dealerCode).trim().toUpperCase() } : {}).lean(),
      User.find({}).lean()
    ]);

    const backup = {
      app: 'Daksh Inventory v2',
      generatedAt: new Date().toISOString(),
      filters: req.query,
      collections: {
        inventory,
        masterParts,
        dealers,
        devices,
        audits,
        users: users.map((user) => ({
          username: user.username,
          email: user.email,
          passwordHash: user.passwordHash,
          password: user.password,
          pinHash: user.pinHash,
          pin: user.pin,
          role: user.role,
          name: user.name,
          active: user.active,
          isActive: user.isActive,
          approved: user.approved,
          approvedBy: user.approvedBy,
          approvedAt: user.approvedAt,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt
        }))
      }
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="Daksh_Inventory_Backup.json"');
    res.send(JSON.stringify(backup, null, 2));
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/restore', auth.requireAuth, auth.requireAdmin, upload.single('file'), async (req, res) => {
  try {
    let backup = req.body;
    if (req.file) {
      backup = JSON.parse(req.file.buffer.toString('utf8'));
    }
    const collections = backup.collections || backup;
    const counts = {};

    if (Array.isArray(collections.masterParts)) {
      counts.masterParts = collections.masterParts.length;
      for (const item of collections.masterParts) {
        const doc = cleanDocument(item);
        if (doc.partNo) await MasterPart.findOneAndUpdate({ partNo: doc.partNo }, doc, { upsert: true, setDefaultsOnInsert: true });
      }
    }
    if (Array.isArray(collections.dealers)) {
      counts.dealers = collections.dealers.length;
      for (const item of collections.dealers) {
        const doc = cleanDocument(item);
        if (doc.dealerCode) await Dealer.findOneAndUpdate({ dealerCode: doc.dealerCode }, doc, { upsert: true, setDefaultsOnInsert: true });
      }
    }
    if (Array.isArray(collections.audits)) {
      counts.audits = collections.audits.length;
      for (const item of collections.audits) {
        const doc = cleanDocument(item);
        if (doc.auditId) await Audit.findOneAndUpdate({ auditId: doc.auditId }, doc, { upsert: true, setDefaultsOnInsert: true });
      }
    }
    if (Array.isArray(collections.devices)) {
      counts.devices = collections.devices.length;
      for (const item of collections.devices) {
        const doc = cleanDocument(item);
        if (doc.deviceId) await Device.findOneAndUpdate({ deviceId: doc.deviceId }, doc, { upsert: true, setDefaultsOnInsert: true });
      }
    }
    if (Array.isArray(collections.inventory)) {
      counts.inventory = collections.inventory.length;
      for (const item of collections.inventory) {
        const doc = cleanDocument(item);
        if (doc.uniqueScanId) await Inventory.findOneAndUpdate({ uniqueScanId: doc.uniqueScanId }, doc, { upsert: true, setDefaultsOnInsert: true });
      }
    }
    if (Array.isArray(collections.users)) {
      counts.users = collections.users.length;
      for (const item of collections.users) {
        const doc = cleanDocument(item);
        if (doc.username) await User.findOneAndUpdate({ username: doc.username }, doc, { upsert: true, setDefaultsOnInsert: true });
      }
    }

    req.io.emit('backup:restored');
    req.io.emit('stats:update');
    res.json({ success: true, restored: counts });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
