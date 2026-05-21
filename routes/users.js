const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const auth = require('./auth');

const router = express.Router();

router.use(auth.requireAuth, auth.requireAdmin);

router.get('/', async (req, res) => {
  try {
    const users = await User.find({}).sort({ approved: 1, createdAt: -1 }).lean();
    res.json({ success: true, users: users.map(auth.cleanPublicUser) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post(['/', '/create'], async (req, res) => {
  try {
    const approved = req.body.approved !== false && req.body.approved !== 'false';
    const active = req.body.active !== false && req.body.active !== 'false' && req.body.isActive !== false && req.body.isActive !== 'false';
    const user = await auth.createUserFromPayload(req.body, {
      role: req.body.role || 'staff',
      active,
      approved,
      approvedBy: req.user.username || req.user.name || 'admin'
    });
    res.status(201).json({ success: true, user: auth.cleanPublicUser(user) });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const update = {
      name: String(req.body.name || req.body.userName || '').trim(),
      username: auth.cleanUsername(req.body.username || req.body.userId || req.body.email),
      email: String(req.body.email || req.body.userId || '').trim().toLowerCase(),
      mobileNumber: String(req.body.mobileNumber || req.body.mobile || '').trim(),
      role: auth.ROLES.includes(req.body.role) ? req.body.role : 'staff',
      responsibility: String(req.body.responsibility || '').trim(),
      dealerAccess: auth.normalizeDealerAccess(req.body.dealerAccess),
      active: req.body.active !== false && req.body.active !== 'false',
      isActive: req.body.active !== false && req.body.active !== 'false',
      approved: req.body.approved !== false && req.body.approved !== 'false'
    };
    if (update.approved) update.approvedAt = new Date();
    else update.approvedAt = undefined;
    if (!update.name) delete update.name;
    if (!update.username) delete update.username;
    if (!update.email) delete update.email;
    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.json({ success: true, user: auth.cleanPublicUser(user) });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
});

router.put('/:id/password', async (req, res) => {
  try {
    const password = String(req.body.password || req.body.newPassword || '');
    const pin = String(req.body.pin || req.body.newPin || '').trim();
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      user.passwordHash = hash;
      user.password = hash;
      user.forcePasswordChange = req.body.forcePasswordChange === true || req.body.forcePasswordChange === 'true';
    }
    if (pin) {
      if (!/^\d{4}$/.test(pin)) return res.status(400).json({ success: false, message: 'PIN must be exactly 4 digits' });
      const hash = await bcrypt.hash(pin, 10);
      user.pinHash = hash;
      user.pin = hash;
    }
    if (!password && !pin) return res.status(400).json({ success: false, message: 'Password or PIN is required' });
    await user.save();
    return res.json({ success: true, user: auth.cleanPublicUser(user), message: 'Password/PIN updated' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/:id/approve', async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      {
        approved: true,
        active: true,
        isActive: true,
        approvedBy: req.user.username || req.user.name || 'admin',
        approvedAt: new Date()
      },
      { new: true }
    );
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.json({ success: true, user: auth.cleanPublicUser(user), message: 'User approved' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/:id/block', async (req, res) => {
  try {
    const active = req.body.active === true || req.body.active === 'true';
    const user = await User.findByIdAndUpdate(req.params.id, { active, isActive: active }, { new: true });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.json({ success: true, user: auth.cleanPublicUser(user), message: active ? 'User activated' : 'User blocked' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/:id/role', async (req, res) => {
  try {
    const role = auth.ROLES.includes(req.body.role) ? req.body.role : '';
    if (!role) return res.status(400).json({ success: false, message: 'Valid role is required' });
    const user = await User.findByIdAndUpdate(req.params.id, { role }, { new: true });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.json({ success: true, user: auth.cleanPublicUser(user), message: 'Role updated' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (String(req.params.id) === String(req.user.id)) {
      return res.status(400).json({ success: false, message: 'You cannot delete your own logged-in admin user' });
    }
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.json({ success: true, deletedCount: 1, message: 'User deleted. This user can no longer login.' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/:id/permissions', async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { permissions: auth.normalizePermissions(req.body.permissions || req.body) }, { new: true });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.json({ success: true, user: auth.cleanPublicUser(user) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const username = auth.cleanUsername(req.body.username);
    const password = String(req.body.newPassword || req.body.password || '');
    if (!username) return res.status(400).json({ success: false, message: 'Username is required' });
    if (!password) return res.status(400).json({ success: false, message: 'Password is required' });

    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const passwordHash = await bcrypt.hash(password, 10);
    user.passwordHash = passwordHash;
    user.password = passwordHash;
    await user.save();
    return res.json({ success: true, message: 'Password reset successful', user: auth.cleanPublicUser(user) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/reset-pin', async (req, res) => {
  try {
    const username = auth.cleanUsername(req.body.username);
    const pin = String(req.body.newPin || req.body.pin || '').trim();
    if (!username) return res.status(400).json({ success: false, message: 'Username is required' });
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ success: false, message: 'PIN must be exactly 4 digits' });

    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const pinHash = await bcrypt.hash(pin, 10);
    user.pinHash = pinHash;
    user.pin = pinHash;
    await user.save();
    return res.json({ success: true, message: 'PIN reset successful', user: auth.cleanPublicUser(user) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
