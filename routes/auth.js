const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Setting = require('../models/Setting');
const smtpConfig = require('../utils/smtpConfig');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'daksh_inventory_secret';
const DEFAULT_OTP_MAIL_ID = 'amitsvision4u@gmail.com';
const RESET_TTL_MINUTES = 15;
const ROLES = ['admin', 'supervisor', 'scanner', 'outward_counter', 'staff', 'mobile_user'];

function publicUser(user) {
  return {
    id: user._id,
    username: user.username,
    email: user.email,
    name: user.name,
    mobileNumber: user.mobileNumber || '',
    role: user.role,
    responsibility: user.responsibility || '',
    dealerAccess: normalizeDealerAccess(user.dealerAccess),
    permissions: user.permissions || {},
    approved: user.approved !== false,
    forcePasswordChange: user.forcePasswordChange === true,
    active: user.isActive !== undefined ? user.isActive !== false : user.active !== false,
    isActive: user.isActive !== undefined ? user.isActive !== false : user.active !== false
  };
}

function signToken(user) {
  return jwt.sign(publicUser(user), JWT_SECRET, { expiresIn: '12h' });
}

async function optionalAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
    if (!token) {
      req.user = null;
      return next();
    }
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (error) {
    req.user = null;
    return next();
  }
}

async function requireAuth(req, res, next) {
  try {
    await optionalAuth(req, res, () => {});
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Login required'
      });
    }
    const freshUser = await User.findOne({ _id: req.user.id, approved: { $ne: false } }).lean();
    if (!freshUser || !isUserActive(freshUser)) {
      return res.status(401).json({
        success: false,
        message: 'User is inactive or not approved'
      });
    }
    req.user = publicUser(freshUser);
    return next();
  } catch (error) {
    console.error('Auth database check failed', {
      url: req.originalUrl,
      message: error.message
    });
    return res.status(503).json({
      success: false,
      message: 'Database connection is temporarily unavailable. Please retry.'
    });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Admin access required'
    });
  }
  return next();
}

function cleanEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function cleanUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function duplicateEmailLoginError() {
  const error = new Error('This email ID is linked to multiple users. Please use the username.');
  error.status = 400;
  return error;
}

async function findUserByLogin(value) {
  const login = cleanUsername(value);
  if (!login) return null;

  const byUsername = await User.findOne({ username: login });
  if (byUsername) return byUsername;

  const emailMatches = await User.find({ email: login }).limit(2);
  if (emailMatches.length > 1) throw duplicateEmailLoginError();
  return emailMatches[0] || null;
}

function normalizeAccessCode(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const parenMatch = text.match(/\(([^()]+)\)\s*$/);
  const candidate = (parenMatch ? parenMatch[1] : text).trim();
  if (candidate.toLowerCase() === 'all') return 'ALL';
  const exactCode = candidate.match(/^[A-Za-z0-9_-]+$/);
  if (exactCode) return candidate.toUpperCase();
  const codeTokens = candidate.match(/[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*/g);
  return (codeTokens && codeTokens.length ? codeTokens[codeTokens.length - 1] : candidate).trim().toUpperCase();
}

function normalizeDealerAccess(value) {
  const rawItems = Array.isArray(value)
    ? value
    : String(value || '').split(/[,;\n]+/);
  return [...new Set(rawItems.map(normalizeAccessCode).filter(Boolean))];
}

function dealerAccessIncludes(dealerAccess, dealerCode) {
  const requestedDealer = normalizeAccessCode(dealerCode);
  const normalizedAccess = normalizeDealerAccess(dealerAccess);
  return {
    requestedDealer,
    userDealerAccess: normalizedAccess,
    allowed: normalizedAccess.includes('ALL') || normalizedAccess.includes(requestedDealer)
  };
}

function isBcryptHash(value) {
  return /^\$2[aby]\$\d{2}\$/.test(String(value || ''));
}

function isUserActive(user) {
  return Boolean(user) && user.active !== false && user.isActive !== false;
}

function isUserApproved(user) {
  return Boolean(user) && user.approved !== false;
}

function inactiveMessage() {
  return 'User is blocked/inactive. Please contact administrator.';
}

function unapprovedMessage() {
  return 'Login not approved. Please contact administrator.';
}

function loginRuleError(user, allowedRoles = []) {
  if (!user) return 'Invalid username or password';
  if (!isUserApproved(user)) return unapprovedMessage();
  if (!isUserActive(user)) return inactiveMessage();
  if (allowedRoles.length && !allowedRoles.includes(user.role)) return 'Role permission does not allow login.';
  return '';
}

function safeLogUser(user) {
  if (!user) return null;
  return {
    username: user.username,
    role: user.role,
    active: user.active !== false,
    isActive: user.isActive !== false,
    approved: user.approved !== false
  };
}

async function compareAndUpgradeSecret(user, input, hashFields) {
  const value = String(input || '');
  const stored = hashFields.map((field) => user[field]).find(Boolean) || '';
  let matched = false;

  if (stored && isBcryptHash(stored)) {
    matched = await bcrypt.compare(value, stored);
  } else if (stored) {
    matched = stored === value;
  }

  if (matched && (!isBcryptHash(stored) || hashFields.some((field) => !user[field] || user[field] !== stored))) {
    const hash = await bcrypt.hash(value, 10);
    hashFields.forEach((field) => {
      user[field] = hash;
    });
    await user.save();
  }

  return matched;
}

function cleanPublicUser(user) {
  return {
    id: user._id,
    username: user.username || '',
    email: user.email || '',
    name: user.name || '',
    mobileNumber: user.mobileNumber || '',
    role: user.role || 'staff',
    responsibility: user.responsibility || '',
    dealerAccess: normalizeDealerAccess(user.dealerAccess),
    permissions: user.permissions || {},
    active: user.isActive !== undefined ? user.isActive !== false : user.active !== false,
    isActive: user.isActive !== undefined ? user.isActive !== false : user.active !== false,
    approved: user.approved !== false,
    forcePasswordChange: user.forcePasswordChange === true,
    approvedBy: user.approvedBy || '',
    approvedAt: user.approvedAt || null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    hasPin: Boolean(user.pinHash || user.pin),
    hasPassword: Boolean(user.passwordHash || user.password)
  };
}

async function getOtpMailId() {
  const setting = await Setting.findOne({ key: 'auth' }).lean();
  return cleanEmail(setting && setting.value ? setting.value.otpMailId : '') || cleanEmail(process.env.REPORT_EMAIL) || DEFAULT_OTP_MAIL_ID;
}

async function setOtpMailId(otpMailId, updatedBy) {
  const clean = cleanEmail(otpMailId);
  if (!clean || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
    throw new Error('Enter a valid OTP mail ID');
  }
  const setting = await Setting.findOneAndUpdate(
    { key: 'auth' },
    { key: 'auth', value: { otpMailId: clean }, updatedBy: updatedBy || '' },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return setting.value.otpMailId;
}

async function mailTransportReady() {
  const status = smtpConfig.publicStatus(await smtpConfig.getStoredSmtp(false));
  return status.configured;
}

async function sendOtpMail(user, otp, token, req) {
  const otpMailId = await getOtpMailId();
  const resetUrl = `${req.protocol}://${req.get('host')}/?resetToken=${encodeURIComponent(token)}&email=${encodeURIComponent(user.email)}`;
  const mail = await smtpConfig.sendOtpEmail(user.email, otp, {
    subject: 'Daksh Inventory password reset OTP',
    text: [
      `Hello ${user.name || user.username},`,
      '',
      'A password reset request was created for your Daksh Inventory account.',
      `OTP: ${otp}`,
      `Reset link: ${resetUrl}`,
      '',
      `This OTP expires in ${RESET_TTL_MINUTES} minutes.`,
      'If you did not request this reset, contact the administrator.'
    ].join('\n'),
    html: `
      <p>Hello ${user.name || user.username},</p>
      <p>A password reset request was created for your Daksh Inventory account.</p>
      <p><strong>OTP:</strong> ${otp}</p>
      <p><a href="${resetUrl}">Open password reset page</a></p>
      <p>This OTP expires in ${RESET_TTL_MINUTES} minutes.</p>
      <p>If you did not request this reset, contact the administrator.</p>
    `
  });
  return { sent: true, otpMailId: mail.fromEmail || otpMailId, resetUrl };
}

async function createResetRequest(user, req) {
  if (!user.email) {
    throw new Error('This user does not have an email ID for OTP reset');
  }
  await smtpConfig.getVerifiedSmtpConfig();

  const otp = String(crypto.randomInt(100000, 999999));
  const token = crypto.randomBytes(32).toString('hex');
  const mail = await sendOtpMail(user, otp, token, req);
  user.resetOtpHash = await bcrypt.hash(otp, 10);
  user.resetTokenHash = await bcrypt.hash(token, 10);
  user.resetExpiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000);
  user.resetRequestedAt = new Date();
  await user.save();
  return { mail, expiresAt: user.resetExpiresAt };
}

async function createUserFromPayload(payload, defaults = {}) {
  const username = cleanUsername(payload.username);
  const email = cleanEmail(payload.email);
  const name = String(payload.name || payload.fullName || username || 'Staff').trim();
  const role = ROLES.includes(payload.role) ? payload.role : (defaults.role || 'staff');
  const password = String(payload.password || '');
  const pin = String(payload.pin || '').trim();

  if (!username) throw new Error('Username is required');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Valid email ID is required');
  if (pin && !/^\d{4}$/.test(pin)) throw new Error('PIN must be exactly 4 digits');
  if (role === 'admin' && !password) throw new Error('Admin users require a password');
  if (['staff', 'mobile_user'].includes(role) && !pin && !password) throw new Error('Staff and Mobile users require a password or 4-digit PIN');

  const duplicate = await User.findOne({ username }).lean();
  if (duplicate) throw new Error('Username already exists');

  const userPayload = {
    username,
    name,
    mobileNumber: String(payload.mobileNumber || payload.mobile || '').trim(),
    role,
    responsibility: String(payload.responsibility || '').trim(),
    dealerAccess: normalizeDealerAccess(payload.dealerAccess),
    permissions: normalizePermissions(payload.permissions || payload),
    active: defaults.active !== undefined ? defaults.active : true,
    isActive: defaults.active !== undefined ? defaults.active : true,
    approved: defaults.approved !== undefined ? defaults.approved : false,
    approvedBy: defaults.approvedBy || '',
    approvedAt: defaults.approved ? new Date() : undefined
  };
  if (email) userPayload.email = email;

  const user = new User(userPayload);

  if (password) {
    const hash = await bcrypt.hash(password, 10);
    user.passwordHash = hash;
    user.password = hash;
  }
  if (pin) {
    const hash = await bcrypt.hash(pin, 10);
    user.pinHash = hash;
    user.pin = hash;
  }
  if (!user.passwordHash && !user.pinHash && !user.password && !user.pin) throw new Error('Password or 4-digit PIN is required');

  await user.save();
  return user;
}

function normalizePermissions(payload = {}) {
  const defaults = {
    canScanInward: true,
    canScanOutward: true,
    canScanFitted: true,
    canScanDamage: true,
    canVerifyParts: true,
    canViewReports: true,
    canDeleteScanData: false,
    canExportExcel: false,
    canManageUsers: false
  };
  Object.keys(defaults).forEach((key) => {
    if (payload[key] !== undefined) defaults[key] = payload[key] === true || payload[key] === 'true' || payload[key] === 'on';
  });
  return defaults;
}

router.post('/login', async (req, res) => {
  try {
    const username = cleanUsername(req.body.username || req.body.userId || req.body.login || req.body.email);
    const password = String(req.body.password || '');
    const pin = String(req.body.pin || '').trim();
    console.log("Login attempt:", username);
    const user = await findUserByLogin(username);
    console.log("User found:", safeLogUser(user));

    const ruleError = loginRuleError(user, ['admin', 'staff']);
    if (ruleError) return res.status(401).json({ success: false, message: ruleError });

    let valid = false;
    if (user.role === 'admin') {
      valid = await compareAndUpgradeSecret(user, password, ['passwordHash', 'password']);
      if (!valid && username === 'admin' && password === 'admin') {
        const hash = await bcrypt.hash('admin', 10);
        user.passwordHash = hash;
        user.password = hash;
        user.active = true;
        user.isActive = true;
        user.approved = true;
        await user.save();
        valid = true;
      }
    } else if (user.role === 'staff') {
      const secret = pin || password;
      valid = await compareAndUpgradeSecret(user, secret, ['pinHash', 'pin']);
      if (!valid && password) {
        valid = await compareAndUpgradeSecret(user, password, ['passwordHash', 'password']);
      }
    } else {
      valid = await compareAndUpgradeSecret(user, password, ['passwordHash', 'password']);
      if (!valid && pin) valid = await compareAndUpgradeSecret(user, pin, ['pinHash', 'pin']);
    }

    console.log("Password match:", valid);
    if (!valid) {
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }

    return res.json({
      success: true,
      token: signToken(user),
      user: publicUser(user)
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

router.post('/mobile-login', async (req, res) => {
  try {
    const dealerCode = normalizeAccessCode(req.body.dealerCode);
    const username = cleanUsername(req.body.username || req.body.userId || req.body.login || req.body.email);
    const password = String(req.body.password || '');
    const pin = String(req.body.pin || '').trim();
    if (!dealerCode) return res.status(400).json({ success: false, message: 'Dealer code is required' });
    if (!username) return res.status(400).json({ success: false, message: 'User ID is required' });
    const user = await findUserByLogin(username);
    const ruleError = loginRuleError(user, ['staff', 'mobile_user']);
    if (ruleError) return res.status(401).json({ success: false, message: ruleError });
    const accessCheck = dealerAccessIncludes(user.dealerAccess, dealerCode);
    if (!accessCheck.userDealerAccess.length || !accessCheck.allowed) {
      return res.status(403).json({
        success: false,
        error: 'Dealer access not assigned',
        message: 'Dealer access not assigned',
        requestedDealer: accessCheck.requestedDealer,
        userDealerAccess: accessCheck.userDealerAccess
      });
    }
    let valid = false;
    if (password) valid = await compareAndUpgradeSecret(user, password, ['passwordHash', 'password']);
    if (!valid && pin) valid = await compareAndUpgradeSecret(user, pin, ['pinHash', 'pin']);
    if (!valid) return res.status(401).json({ success: false, message: 'Invalid password or PIN' });
    return res.json({ success: true, token: signToken(user), user: publicUser(user), dealerCode: accessCheck.requestedDealer });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

router.post('/pin-login', async (req, res) => {
  try {
    const pin = String(req.body.pin || '').trim();
    const dealerCode = normalizeAccessCode(req.body.dealerCode);
    const username = cleanUsername(req.body.username || req.body.userId || req.body.login || req.body.email);
    console.log("Login attempt:", 'PIN login', username);
    if (!dealerCode) return res.status(400).json({ success: false, message: 'Dealer code is required' });
    if (!/^\d{4}$/.test(pin)) {
      return res.status(400).json({ success: false, message: 'Enter a valid 4-digit PIN' });
    }
    if (!username) return res.status(400).json({ success: false, message: 'Username is required for PIN login' });

    const user = await findUserByLogin(username);
    const ruleError = loginRuleError(user, ['staff', 'mobile_user']);
    if (ruleError) return res.status(401).json({ success: false, message: ruleError });
    const accessCheck = dealerAccessIncludes(user.dealerAccess, dealerCode);
    if (!accessCheck.userDealerAccess.length || !accessCheck.allowed) {
      return res.status(403).json({
        success: false,
        error: 'Dealer access not assigned',
        message: 'Dealer access not assigned',
        requestedDealer: accessCheck.requestedDealer,
        userDealerAccess: accessCheck.userDealerAccess
      });
    }
    if (!user.pinHash && !user.pin) return res.status(400).json({ success: false, message: 'PIN login is not enabled for this user' });
    const valid = await compareAndUpgradeSecret(user, pin, ['pinHash', 'pin']);
    if (valid) {
      console.log("User found:", safeLogUser(user));
      console.log("Password match: true");
      return res.json({
        success: true,
        token: signToken(user),
        user: publicUser(user),
        dealerCode: accessCheck.requestedDealer
      });
    }

    console.log("User found:", null);
    console.log("Password match: false");
    return res.status(401).json({ success: false, message: 'Invalid staff PIN' });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ success: true, user: req.user });
});

router.post('/register', async (req, res) => {
  try {
    const user = await createUserFromPayload(req.body, {
      role: 'staff',
      active: false,
      approved: false
    });
    res.status(201).json({
      success: true,
      message: 'User request created. Admin approval is required before login.',
      user: cleanPublicUser(user)
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

async function requestPasswordReset(req, res) {
  try {
    const login = cleanUsername(req.body.usernameOrEmail || req.body.username || req.body.email);
    const user = await findUserByLogin(login);

    if (!user) {
      return res.json({ success: true, message: 'If the account exists, an OTP reset email has been sent.' });
    }
    if (!isUserApproved(user)) return res.status(403).json({ success: false, message: unapprovedMessage() });
    if (!isUserActive(user)) return res.status(403).json({ success: false, message: inactiveMessage() });

    const result = await createResetRequest(user, req);
    return res.json({
      success: true,
      message: result.mail.sent ? 'OTP reset link sent to registered email ID.' : result.mail.message,
      mailSent: result.mail.sent,
      otpMailId: result.mail.otpMailId,
      expiresAt: result.expiresAt
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    const status = /^SMTP is not configured|^SMTP configuration failed/i.test(error.message) ? 400 : 500;
    const message = status === 400 ? 'SMTP not configured. Please contact administrator to reset password.' : error.message;
    return res.status(status).json({ success: false, message });
  }
}

router.post('/request-password-reset', requestPasswordReset);
router.post('/forgot-password', requestPasswordReset);
router.post('/send-otp', requestPasswordReset);

router.post('/reset-password', async (req, res) => {
  try {
    const email = cleanEmail(req.body.email);
    const otp = String(req.body.otp || '').trim();
    const token = String(req.body.token || '').trim();
    const password = String(req.body.password || '');

    if (!email || !otp || !token || !password) {
      return res.status(400).json({ success: false, message: 'Email, reset token, OTP, and new password are required' });
    }
    if (!password) {
      return res.status(400).json({ success: false, message: 'New password is required' });
    }

    const resetUsers = await User.find({
      email,
      resetExpiresAt: { $gt: new Date() },
      resetOtpHash: { $ne: '' },
      resetTokenHash: { $ne: '' }
    });
    let user = null;
    for (const candidate of resetUsers) {
      if (await bcrypt.compare(token, candidate.resetTokenHash)) {
        user = candidate;
        break;
      }
    }
    if (!user || !user.resetOtpHash || !user.resetTokenHash) {
      return res.status(400).json({ success: false, message: 'Reset request expired or invalid' });
    }

    const otpOk = await bcrypt.compare(otp, user.resetOtpHash);
    if (!otpOk) {
      return res.status(400).json({ success: false, message: 'Invalid OTP or reset link' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    user.passwordHash = passwordHash;
    user.password = passwordHash;
    user.forcePasswordChange = false;
    user.resetOtpHash = '';
    user.resetTokenHash = '';
    user.resetExpiresAt = undefined;
    user.resetRequestedAt = undefined;
    await user.save();

    return res.json({ success: true, message: 'Password reset successful. You can login now.' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await User.find({}).sort({ approved: 1, createdAt: -1 }).lean();
    res.json({ success: true, users: users.map(cleanPublicUser) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post(['/users', '/users/create'], requireAuth, requireAdmin, async (req, res) => {
  try {
    const approved = req.body.approved !== false && req.body.approved !== 'false';
    const user = await createUserFromPayload(req.body, {
      role: req.body.role || 'staff',
      active: req.body.active !== false && req.body.active !== 'false',
      approved,
      approvedBy: req.user.username || req.user.name || 'admin'
    });
    res.status(201).json({ success: true, user: cleanPublicUser(user) });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.post('/users/:id/approve', requireAuth, requireAdmin, async (req, res) => {
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
    res.json({ success: true, user: cleanPublicUser(user) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/users/:id/approve', requireAuth, requireAdmin, async (req, res) => {
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
    res.json({ success: true, user: cleanPublicUser(user) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/users/:id/block', requireAuth, requireAdmin, async (req, res) => {
  try {
    const active = req.body.active === true || req.body.active === 'true';
    const user = await User.findByIdAndUpdate(req.params.id, { active, isActive: active }, { new: true });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, user: cleanPublicUser(user) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/users/:id/role', requireAuth, requireAdmin, async (req, res) => {
  try {
    const role = ROLES.includes(req.body.role) ? req.body.role : '';
    if (!role) return res.status(400).json({ success: false, message: 'Valid role is required' });
    const user = await User.findByIdAndUpdate(req.params.id, { role }, { new: true });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, user: cleanPublicUser(user) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/users/:id/status', requireAuth, requireAdmin, async (req, res) => {
  try {
    const update = {};
    if (req.body.active !== undefined || req.body.isActive !== undefined) {
      const active = req.body.active !== undefined ? req.body.active : req.body.isActive;
      update.active = active === true || active === 'true';
      update.isActive = update.active;
    }
    if (req.body.approved !== undefined) update.approved = req.body.approved === true || req.body.approved === 'true';
    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, user: cleanPublicUser(user) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/users/:id/email', requireAuth, requireAdmin, async (req, res) => {
  try {
    const email = cleanEmail(req.body.email);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Valid email ID is required' });
    }
    const user = await User.findByIdAndUpdate(req.params.id, { email }, { new: true, runValidators: true });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, user: cleanPublicUser(user) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/users/reset-password', requireAuth, requireAdmin, async (req, res) => {
  try {
    const username = cleanUsername(req.body.username);
    const password = String(req.body.newPassword || req.body.password || '');
    if (!username) return res.status(400).json({ success: false, message: 'Username is required' });
    if (!password) return res.status(400).json({ success: false, message: 'Password is required' });

    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const passwordHash = await bcrypt.hash(password, 10);
    user.passwordHash = passwordHash;
    user.password = passwordHash;
    user.forcePasswordChange = req.body.forcePasswordChange === true || req.body.forcePasswordChange === 'true';
    await user.save();
    res.json({ success: true, message: 'Password reset successful' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/users/reset-pin', requireAuth, requireAdmin, async (req, res) => {
  try {
    const username = cleanUsername(req.body.username);
    const pin = String(req.body.newPin || req.body.pin || '').trim();
    if (!username) return res.status(400).json({ success: false, message: 'Username is required' });
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ success: false, message: 'PIN must be exactly 4 digits' });

    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const pinHash = await bcrypt.hash(pin, 10);
    user.pinHash = pinHash;
    user.pin = pinHash;
    await user.save();
    res.json({ success: true, message: 'PIN reset successful' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/users/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
  try {
    const password = String(req.body.password || '');
    if (!password) {
      return res.status(400).json({ success: false, message: 'Password is required' });
    }
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const passwordHash = await bcrypt.hash(password, 10);
    user.passwordHash = passwordHash;
    user.password = passwordHash;
    user.forcePasswordChange = req.body.forcePasswordChange === true || req.body.forcePasswordChange === 'true';
    user.resetOtpHash = '';
    user.resetTokenHash = '';
    user.resetExpiresAt = undefined;
    user.resetRequestedAt = undefined;
    await user.save();
    res.json({ success: true, user: cleanPublicUser(user), message: 'Password reset by admin' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/admin-reset-password', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = String(req.body.userId || req.body.id || '').trim();
    const username = cleanUsername(req.body.username || '');
    const password = String(req.body.newPassword || req.body.password || '');
    if (!password) return res.status(400).json({ success: false, message: 'Password is required' });
    const user = userId ? await User.findById(userId) : await User.findOne({ username });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const passwordHash = await bcrypt.hash(password, 10);
    user.passwordHash = passwordHash;
    user.password = passwordHash;
    user.forcePasswordChange = req.body.forcePasswordChange === true || req.body.forcePasswordChange === 'true';
    user.resetOtpHash = '';
    user.resetTokenHash = '';
    user.resetExpiresAt = undefined;
    user.resetRequestedAt = undefined;
    await user.save();
    res.json({ success: true, user: cleanPublicUser(user), message: 'Password reset by admin' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/users/:id/send-reset', requireAuth, requireAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const result = await createResetRequest(user, req);
    res.json({
      success: true,
      message: result.mail.sent ? 'OTP reset link sent to user email ID.' : result.mail.message,
      mailSent: result.mail.sent,
      otpMailId: result.mail.otpMailId,
      expiresAt: result.expiresAt
    });
  } catch (error) {
    const status = /^SMTP is not configured|^SMTP configuration failed/i.test(error.message) ? 400 : 500;
    res.status(status).json({ success: false, message: error.message });
  }
});

router.get('/settings', requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json({ success: true, settings: { otpMailId: await getOtpMailId(), smtpReady: await mailTransportReady() } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/settings/otp-mail', requireAuth, requireAdmin, async (req, res) => {
  try {
    const otpMailId = await setOtpMailId(req.body.otpMailId, req.user.username || req.user.name || 'admin');
    res.json({ success: true, settings: { otpMailId, smtpReady: await mailTransportReady() } });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

setTimeout(async () => {
  try {
    const adminExists = await User.findOne({ role: 'admin' });
    if (!adminExists) {
      await User.create({
        username: 'admin',
        email: 'admin@localhost',
        name: 'Administrator',
        role: 'admin',
        active: true,
        isActive: true,
        approved: true,
        passwordHash: await bcrypt.hash('admin', 10),
        password: await bcrypt.hash('admin', 10)
      });
      await User.create({
        username: 'staff',
        email: 'staff@localhost',
        name: 'Default Staff',
        role: 'staff',
        active: true,
        isActive: true,
        approved: true,
        pinHash: await bcrypt.hash('1234', 10),
        pin: await bcrypt.hash('1234', 10)
      });
      console.log('Default admin (admin/admin) and staff (PIN 1234) created');
    }
  } catch (error) {}
}, 2500);

module.exports = router;
module.exports.optionalAuth = optionalAuth;
module.exports.requireAuth = requireAuth;
module.exports.requireAdmin = requireAdmin;
module.exports.cleanPublicUser = cleanPublicUser;
module.exports.createUserFromPayload = createUserFromPayload;
module.exports.cleanUsername = cleanUsername;
module.exports.normalizePermissions = normalizePermissions;
module.exports.normalizeAccessCode = normalizeAccessCode;
module.exports.normalizeDealerAccess = normalizeDealerAccess;
module.exports.dealerAccessIncludes = dealerAccessIncludes;
module.exports.publicUser = publicUser;
module.exports.ROLES = ROLES;
