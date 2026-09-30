const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Dealer = require('../models/Dealer');
const UserDealerMapping = require('../models/UserDealerMapping');
const Audit = require('../models/Audit');
const passwordReset = require('../services/PasswordResetService');
const { getActiveAudit, publicAudit } = require('../utils/audit');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'daksh_inventory_secret';
const DEFAULT_ADMIN_USERNAME = String(process.env.DEFAULT_ADMIN_USERNAME || 'admin').trim().toLowerCase();
const DEFAULT_ADMIN_PASSWORD = String(process.env.DEFAULT_ADMIN_PASSWORD || 'admin');
const MOBILE_TOKEN_TTL = String(process.env.MOBILE_JWT_EXPIRES_IN || '30d').trim() || '30d';
const AUTH_COOKIE_NAME = 'daksh_auth';
const AUTH_COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;
const ROLES = ['super_admin', 'admin', 'audit_user', 'mobile_user'];
const LEGACY_ROLE_MAP = {
  super_admin: 'super_admin',
  'super admin': 'super_admin',
  admin: 'admin',
  audit_user: 'audit_user',
  mobile_user: 'mobile_user',
  staff: 'audit_user',
  supervisor: 'audit_user',
  scanner: 'audit_user',
  outward_counter: 'audit_user'
};

function safeRequestUrl(req) {
  try {
    const parsed = new URL(req.originalUrl || '/', 'http://localhost');
    ['token', 'resetToken', 'otp'].forEach((key) => parsed.searchParams.delete(key));
    return `${parsed.pathname}${parsed.search}`;
  } catch (_) {
    return '/';
  }
}

function normalizeRole(value, fallback = 'audit_user') {
  const role = String(value || '').trim().toLowerCase();
  return LEGACY_ROLE_MAP[role] || fallback;
}

function isAdminRole(value) {
  return ['admin', 'super_admin'].includes(normalizeRole(value));
}

function roleDisplayName(role) {
  return {
    super_admin: 'Super Admin',
    admin: 'Admin',
    audit_user: 'Audit User',
    mobile_user: 'Mobile User'
  }[normalizeRole(role)] || 'Audit User';
}

function publicUser(user) {
  const role = normalizeRole(user.role);
  return {
    id: user._id,
    username: user.username,
    email: user.email,
    name: user.name,
    mobileNumber: user.mobileNumber || '',
    role,
    roleName: roleDisplayName(role),
    responsibility: user.responsibility || '',
    dealerAccess: normalizeDealerAccess(user.dealerAccess),
    permissions: user.permissions || {},
    approved: user.approved !== false,
    forcePasswordChange: user.forcePasswordChange === true,
    active: user.isActive !== undefined ? user.isActive !== false : user.active !== false,
    isActive: user.isActive !== undefined ? user.isActive !== false : user.active !== false
  };
}

function signToken(user, expiresIn = '12h') {
  return jwt.sign(publicUser(user), JWT_SECRET, { expiresIn });
}

function signMobileToken(user) {
  return signToken(user, MOBILE_TOKEN_TTL);
}

function requestIsSecure(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return Boolean(req.secure || forwardedProto === 'https');
}

function setAuthCookie(res, req, token) {
  const value = encodeURIComponent(String(token || ''));
  const attributes = [
    `${AUTH_COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}`
  ];
  if (requestIsSecure(req)) attributes.push('Secure');
  res.append('Set-Cookie', attributes.join('; '));
}

function clearAuthCookie(res, req) {
  const attributes = [`${AUTH_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'];
  if (requestIsSecure(req)) attributes.push('Secure');
  res.append('Set-Cookie', attributes.join('; '));
}

function readCookie(req, name) {
  const header = String(req.headers.cookie || '');
  for (const item of header.split(';')) {
    const [rawName, ...rawValue] = item.trim().split('=');
    if (rawName !== name) continue;
    try {
      return decodeURIComponent(rawValue.join('='));
    } catch (error) {
      return '';
    }
  }
  return '';
}

async function requirePageAuth(req, res, next) {
  const token = readCookie(req, AUTH_COOKIE_NAME);
  if (!token) return res.redirect(302, '/?forceLogin=1');

  try {
    const claims = jwt.verify(token, JWT_SECRET);
    const freshUser = await User.findOne({ _id: claims.id, approved: { $ne: false } }).lean();
    if (!freshUser || !isUserActive(freshUser) || !sessionIsCurrent(claims, freshUser)) throw new Error('Session is no longer active');
    req.user = { ...publicUser(freshUser), dealerAccess: await userDealerAccessCodes(freshUser) };
    return next();
  } catch (error) {
    clearAuthCookie(res, req);
    return res.redirect(302, '/?forceLogin=1');
  }
}

async function authenticateSocket(socket, next) {
  const authHeader = String(socket.handshake.headers.authorization || '');
  const token = String(socket.handshake.auth?.token || (authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '')).trim();
  if (!token) return next(new Error('Authentication required'));

  try {
    const claims = jwt.verify(token, JWT_SECRET);
    const freshUser = await User.findOne({ _id: claims.id, approved: { $ne: false } }).lean();
    if (!freshUser || !isUserActive(freshUser) || !sessionIsCurrent(claims, freshUser)) return next(new Error('User is inactive or not approved'));
    socket.user = { ...publicUser(freshUser), dealerAccess: await userDealerAccessCodes(freshUser) };
    return next();
  } catch (error) {
    return next(new Error('Authentication required'));
  }
}

async function optionalAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
    req.authTokenPresent = Boolean(token);
    req.authError = null;
    if (!token) {
      req.user = null;
      return next();
    }
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (error) {
    req.user = null;
    req.authError = error;
    return next();
  }
}

async function requireAuth(req, res, next) {
  try {
    await optionalAuth(req, res, () => {});
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: req.authTokenPresent ? 'Auth expired: please login again' : 'Login required'
      });
    }
    const freshUser = await User.findOne({ _id: req.user.id, approved: { $ne: false } }).lean();
    if (!freshUser || !isUserActive(freshUser) || !sessionIsCurrent(req.user, freshUser)) {
      return res.status(401).json({
        success: false,
        message: 'User is inactive or not approved'
      });
    }
    const dealerAccess = await userDealerAccessCodes(freshUser);
    req.user = { ...publicUser({ ...freshUser, dealerAccess }), dealerAccess };
    let requestedDealer = extractRequestDealer(req);
    // Resolve a single-dealer auditor's context from the backend mapping. The
    // client does not need to choose or persist an authoritative dealer.
    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
    if (!requestedDealer && !isAdmin && dealerAccess.length === 1 && dealerAccess[0] !== 'ALL') {
      requestedDealer = dealerAccess[0];
    }
    if (requestedDealer && requestedDealer !== 'ALL') {
      const access = await validateUserDealerAccess(req.user, requestedDealer);
      if (!access.allowed) {
        return res.status(403).json({
          success: false,
          message: 'Unauthorized dealer access',
          requestedDealer: access.requestedDealer,
          userDealerAccess: access.userDealerAccess
        });
      }
      applyRequestDealer(req, access.requestedDealer);
    } else if (requestedDealer === 'ALL' && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Only Admin can access All Dealers.'
      });
    } else if (!isAdmin && isDealerScopedRequest(req)) {
      return res.status(400).json({
        success: false,
        message: 'Select dealer first',
        userDealerAccess: dealerAccess
      });
    }
    const writeMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(req.method || '').toUpperCase());
    const auditWriteBases = ['/api/scans', '/api/scan', '/api/inventory', '/api/reconciliation', '/api/bin-transfer'];
    if (writeMethod && !isAdmin && auditWriteBases.includes(String(req.baseUrl || '').toLowerCase())) {
      const dealerCode = req.activeDealerId || extractRequestDealer(req);
      const auditId = String(req.body?.auditId || req.body?.auditSessionId || req.query?.auditId || req.query?.auditSessionId || '').trim();
      const audit = auditId
        ? await Audit.findOne({ dealerCode, auditId }).lean()
        : await getActiveAudit({ dealerCode });
      const status = audit ? String(audit.auditStatus || audit.status || '').trim().toUpperCase() : '';
      if (!audit || !['ACTIVE', 'IN_PROGRESS', 'OPEN'].includes(status)) {
        return res.status(423).json({ success: false, code: 'AUDIT_NOT_WRITABLE', message: 'Changes are allowed only while the selected audit is ACTIVE.' });
      }
    }
    const matrixError = matrixAccessError(req.user, req);
    if (matrixError) return res.status(403).json({ success: false, message: matrixError });
    return next();
  } catch (error) {
    console.error('Auth database check failed', {
      url: safeRequestUrl(req),
      message: error.message
    });
    return res.status(503).json({
      success: false,
      message: 'Database connection is temporarily unavailable. Please retry.'
    });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || !['admin', 'super_admin'].includes(normalizeRole(req.user.role))) {
    return res.status(403).json({
      success: false,
      message: 'Admin permission required.'
    });
  }
  return next();
}

function sessionIsCurrent(claims = {}, user = {}) {
  if (!user.passwordChangedAt || !claims.iat) return true;
  return Number(claims.iat) >= Math.ceil(new Date(user.passwordChangedAt).getTime() / 1000);
}

function matrixAccessError(user, req) {
  const role = normalizeRole(user && user.role);
  if (!user || isAdminRole(role)) return '';
  const base = String(req.baseUrl || '').toLowerCase();
  const path = String(req.path || '/').toLowerCase();
  const method = String(req.method || 'GET').toUpperCase();
  const write = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  const adminOnly = 'This action is available to Admin users only.';

  if (['/api/admin', '/api/admin-delete', '/api/users', '/api/system', '/api/backup', '/api/audit-backup', '/api/scan-audit', '/api/master-catalogue', '/api/bin-master'].includes(base)) return adminOnly;
  if (base === '/api/dealers') return adminOnly;
  if (base === '/api/audit' && !(method === 'GET' && path === '/active')) return adminOnly;
  if (base === '/api/reconciliation' || base === '/api/dealer-stock') return adminOnly;
  if (base === '/api/devices' || base === '/api/scanner-network' || base === '/api/settings') return adminOnly;

  if (base === '/api/master' || base === '/api/master-parts') {
    if (write) return adminOnly;
    const allowedReads = ['/dealers', '/parts', '/parts/search', '/parts/suggest', '/search', '/suggestions', '/categories', '/parts/categories', '/filters', '/bins'];
    if (!allowedReads.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return adminOnly;
  }

  if (base === '/api/reports') {
    if (user.permissions?.canViewReports === false) return 'Report access is disabled for this account.';
    const reportPath = path.replace(/\/$/, '');
    const limitedReport = /^\/(?:bin-wise-stock|bin-wise|bin-stock|category-wise-variance-summary)(?:\/(?:email|export))?$/.test(reportPath);
    if (!limitedReport) return 'This role can access bin-wise and category-wise reports only.';
    if (write) return adminOnly;
    if (role === 'mobile_user' && ['excel', 'xlsx', 'csv', 'pdf'].includes(String(req.query?.format || '').toLowerCase())) {
      return 'Report export is not enabled for Mobile Users.';
    }
  }

  if (base === '/api/mobile' && role === 'mobile_user' && path === '/reports/export-excel') {
    return 'Report export is not enabled for Mobile Users.';
  }

  return '';
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

function redactMobileLoginBody(body = {}) {
  const redacted = { ...body };
  ['password', 'pin', 'secret', 'passwordOrPin'].forEach((field) => {
    if (redacted[field] !== undefined && redacted[field] !== '') redacted[field] = '[redacted]';
  });
  return redacted;
}

const MOBILE_LOGIN_DEBUG = process.env.MOBILE_LOGIN_DEBUG === 'true';

function debugMobileLogin(...args) {
  if (MOBILE_LOGIN_DEBUG) console.log(...args);
}

async function findUserByLogin(value) {
  const login = cleanUsername(value);
  if (!login) return null;

  const byUsername = await User.findOne({ username: login });
  if (byUsername) return byUsername;

  const emailMatches = await User.find({ email: login }).limit(2);
  if (emailMatches.length > 1) throw duplicateEmailLoginError();
  if (emailMatches[0]) return emailMatches[0];

  const fallbackFields = ['loginId', 'userId'];
  for (const field of fallbackFields) {
    const match = await User.findOne({ [field]: login });
    if (match) return match;
  }

  return null;
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

async function syncUserDealerMappings(userId, dealerAccess = []) {
  const normalized = normalizeDealerAccess(dealerAccess);
  if (!userId) return normalized;
  await UserDealerMapping.updateMany({ userId }, { $set: { isActive: false } });
  const dealerCodes = normalized.filter((code) => code && code !== 'ALL');
  if (dealerCodes.length) {
    await Promise.all(dealerCodes.map((dealerCode) => UserDealerMapping.findOneAndUpdate(
      { userId, dealerId: dealerCode, auditId: '' },
      { userId, dealerId: dealerCode, auditId: '', isActive: true },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    )));
  }
  return normalized;
}

async function userDealerAccessCodes(user = {}) {
  const userId = user._id || user.id;
  const legacyAccess = normalizeDealerAccess(user.dealerAccess);
  if (!userId) return legacyAccess;
  const mappings = await UserDealerMapping.find({ userId, isActive: true }).select('dealerId').lean();
  const mappedAccess = normalizeDealerAccess(mappings.map((row) => row.dealerId));
  if (mappedAccess.length) return mappedAccess;
  if (legacyAccess.length) await syncUserDealerMappings(userId, legacyAccess).catch(() => null);
  return legacyAccess;
}

async function activeDealersForUser(user = {}) {
  const access = await userDealerAccessCodes(user);
  const canSeeAll = ['admin', 'super_admin'].includes(normalizeRole(user.role));
  const filter = {
    dealerCode: { $not: /^SYNC/i },
    dealerName: { $not: /Sync Test/i },
    active: { $ne: false }
  };
  if (!canSeeAll) filter.dealerCode = access.length ? { $in: access } : '__none__';
  const dealers = await Dealer.find(filter).sort({ dealerName: 1, dealerCode: 1 }).lean();
  return dealers.map((dealer) => ({
    id: dealer.dealerCode,
    dealerId: dealer.dealerCode,
    dealerCode: dealer.dealerCode,
    dealerName: dealer.dealerName || dealer.dealerCode,
    currentAuditId: dealer.currentAuditId || '',
    auditId: dealer.currentAuditId || '',
    brand: dealer.brand || '',
    location: dealer.location || ''
  }));
}

function extractRequestDealer(req) {
  const firstScan = Array.isArray(req.body) ? req.body[0] : null;
  const sources = [
    req.query && (req.query.activeDealerId || req.query.dealerId || req.query.dealerCode || req.query.dealer),
    req.body && (req.body.activeDealerId || req.body.dealerId || req.body.dealerCode || req.body.dealer)
      || firstScan && (firstScan.activeDealerId || firstScan.dealerId || firstScan.dealerCode || firstScan.dealer),
    req.params && (req.params.dealerId || req.params.dealerCode)
  ];
  return normalizeAccessCode(sources.find(Boolean) || '');
}

function isDealerScopedRequest(req) {
  const base = String(req.baseUrl || '').toLowerCase();
  const path = String(req.path || '').toLowerCase();
  if (base === '/api/auth' || base === '/api/users') return false;
  if (base === '/api/master' && ['/dealers', '/filters', '/suggestions'].includes(path)) return false;
  if (base === '/api/dealers' && req.method === 'GET') return false;
  if (base === '/api/mobile' && req.method === 'GET' && ['/dealers', '/config'].includes(path)) return false;
  return [
    '/api/scans',
    '/api/inventory',
    '/api/reports',
    '/api/reconciliation',
    '/api/dealer-stock',
    '/api/bin',
    '/api/bin-master',
    '/api/bin-transfer',
    '/api/devices',
    '/api/qr',
    '/api/sync',
    '/api/mobile',
    '/api/audit-backup',
    '/api/audit',
    '/api/master-parts',
    '/api/master'
  ].includes(base);
}

async function validateUserDealerAccess(user, dealerCode) {
  const requestedDealer = normalizeAccessCode(dealerCode);
  const userDealerAccess = await userDealerAccessCodes(user);
    const isAdmin = ['admin', 'super_admin'].includes(normalizeRole(user.role));
    const allowed = isAdmin || userDealerAccess.includes(requestedDealer)
    || (requestedDealer !== 'ALL' && userDealerAccess.includes('ALL') && isAdmin);
  return { requestedDealer, userDealerAccess, allowed };
}

function applyRequestDealer(req, dealerCode) {
  const cleanDealer = normalizeAccessCode(dealerCode);
  if (!cleanDealer || cleanDealer === 'ALL') return;
  req.activeDealerId = cleanDealer;
  req.query = req.query || {};
  req.query.activeDealerId = req.query.activeDealerId || cleanDealer;
  req.query.dealerCode = req.query.dealerCode || cleanDealer;
  if (req.body && typeof req.body === 'object' && !(req.body instanceof Buffer)) {
    req.body.activeDealerId = req.body.activeDealerId || cleanDealer;
    req.body.dealerCode = req.body.dealerCode || cleanDealer;
  }
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
  if (allowedRoles.length && !allowedRoles.includes(normalizeRole(user.role))) return 'Role permission does not allow login.';
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
  if (!value) return false;

  const fields = hashFields.filter(Boolean);
  let matchedStored = '';

  for (const field of fields) {
    const stored = user[field];
    if (!stored) continue;
    const matched = isBcryptHash(stored) ? await bcrypt.compare(value, stored) : stored === value;
    if (matched) {
      matchedStored = stored;
      break;
    }
  }

  if (!matchedStored) return false;

  if (!isBcryptHash(matchedStored) || fields.some((field) => !user[field] || user[field] !== matchedStored)) {
    const hash = isBcryptHash(matchedStored) ? matchedStored : await bcrypt.hash(value, 10);
    fields.forEach((field) => {
      user[field] = hash;
    });
    await user.save();
  }

  return true;
}

function cleanPublicUser(user) {
  const role = normalizeRole(user.role);
  return {
    id: user._id,
    username: user.username || '',
    email: user.email || '',
    name: user.name || '',
    mobileNumber: user.mobileNumber || '',
    role,
    roleName: roleDisplayName(role),
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

async function createUserFromPayload(payload, defaults = {}) {
  const username = cleanUsername(payload.username);
  const email = cleanEmail(payload.email);
  const name = String(payload.name || payload.fullName || username || 'Audit User').trim();
  const role = normalizeRole(payload.role || defaults.role || 'audit_user');
  const dealerAccess = normalizeDealerAccess(payload.dealerAccess);
  const password = String(payload.password || '');
  const pin = String(payload.pin || '').trim();

  if (!username) throw new Error('Username is required');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Registered email address is required');
  if (pin && !/^\d{4}$/.test(pin)) throw new Error('PIN must be exactly 4 digits');
  if (['audit_user', 'mobile_user'].includes(role) && (!dealerAccess.length || dealerAccess.includes('ALL'))) {
    throw new Error(`${roleDisplayName(role)}s must be assigned to at least one specific dealer.`);
  }
  if (isAdminRole(role) && !password) throw new Error('Admin users require a password');
  if (['audit_user', 'mobile_user'].includes(role) && !pin && !password) throw new Error('Audit and Mobile users require a password or 4-digit PIN');

  const duplicate = await User.findOne({ username }).lean();
  if (duplicate) throw new Error('Username already exists');

  const userPayload = {
    username,
    name,
    mobileNumber: String(payload.mobileNumber || payload.mobile || '').trim(),
    role,
    responsibility: String(payload.responsibility || '').trim(),
    dealerAccess,
    permissions: normalizePermissions(payload.permissions || payload),
    active: defaults.active !== undefined ? defaults.active : true,
    isActive: defaults.active !== undefined ? defaults.active : true,
    approved: defaults.approved !== undefined ? defaults.approved : false,
    approvedBy: defaults.approvedBy || '',
    approvedAt: defaults.approved ? new Date() : undefined
  };
  userPayload.email = email;

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
  await syncUserDealerMappings(user._id, user.dealerAccess);
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
    const password = String(req.body.password || req.body.passwordOrPin || '');

    const pin = String(req.body.pin || req.body.passwordOrPin || '').trim();
    const user = await findUserByLogin(username);

    const ruleError = loginRuleError(user, ['super_admin', 'admin', 'audit_user', 'mobile_user']);
    if (ruleError) return res.status(401).json({ success: false, message: ruleError });

    let valid = false;
    const role = normalizeRole(user.role);
    if (isAdminRole(role)) {
      valid = await compareAndUpgradeSecret(user, password, ['passwordHash', 'password']);
    } else if (role === 'audit_user') {
      const secret = pin || password;
      valid = await compareAndUpgradeSecret(user, secret, ['pinHash', 'pin']);
      if (!valid && password) {
        valid = await compareAndUpgradeSecret(user, password, ['passwordHash', 'password']);
      }
    } else {
      valid = await compareAndUpgradeSecret(user, password, ['passwordHash', 'password']);
      if (!valid && pin) valid = await compareAndUpgradeSecret(user, pin, ['pinHash', 'pin']);
    }

    if (!valid) {
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }

    const token = signToken(user);
    setAuthCookie(res, req, token);
    const dealerAccess = await userDealerAccessCodes(user);
    const assignedDealers = await activeDealersForUser(user);
    return res.json({
      success: true,
      token,
      user: { ...publicUser(user), dealerAccess },
      assignedDealers,
      activeDealers: assignedDealers,
      needsDealerSelection: !isAdminRole(role) && assignedDealers.length > 1,
      activeDealerId: !isAdminRole(role) && assignedDealers.length === 1 ? assignedDealers[0].dealerCode : ''
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

async function mobileLoginHandler(req, res) {
  try {
    debugMobileLogin('MOBILE_LOGIN_PAYLOAD', redactMobileLoginBody(req.body));
    const dealerCode = normalizeAccessCode(req.body.dealerCode || req.body.activeDealerId || req.body.dealer || req.body.selectedDealerCode);
    const login = cleanUsername(req.body.login || req.body.username || req.body.userId || req.body.email || req.body.loginId);
    const secret = String(req.body.passwordOrPin || req.body.secret || req.body.password || req.body.pin || '').trim();
    debugMobileLogin('LOGIN_VALUE', login);
    debugMobileLogin('DEALER_CODE', dealerCode);
    if (!dealerCode) return res.status(400).json({ success: false, message: 'Dealer code required' });
    if (!login) return res.status(404).json({ success: false, message: 'User not found' });
    if (!secret) return res.status(401).json({ success: false, message: 'Password/PIN incorrect' });

    const user = await findUserByLogin(login);
    debugMobileLogin('USER_FOUND', user ? user.username : null);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    debugMobileLogin('APPROVED', user?.approved);
    if (!isUserApproved(user)) return res.status(403).json({ success: false, message: 'User not approved' });
    debugMobileLogin('ACTIVE', user?.active);
    if (!isUserActive(user)) return res.status(403).json({ success: false, message: 'User inactive' });

    const dealerAccess = await userDealerAccessCodes(user);
    debugMobileLogin('DEALER_ACCESS', dealerAccess);
    const accessCheck = await validateUserDealerAccess(user, dealerCode);
    if (!accessCheck.allowed) {
      return res.status(403).json({
        success: false,
        message: 'User does not have access to this dealer',
        requestedDealer: accessCheck.requestedDealer,
        userDealerAccess: accessCheck.userDealerAccess
      });
    }

    let passwordMatch = await compareAndUpgradeSecret(user, secret, ['passwordHash', 'password']);
    let pinMatch = false;
    if (!passwordMatch) pinMatch = await compareAndUpgradeSecret(user, secret, ['pinHash', 'pin']);
    debugMobileLogin('PASSWORD_MATCH', passwordMatch);
    debugMobileLogin('PIN_MATCH', pinMatch);
    if (!passwordMatch && !pinMatch) return res.status(401).json({ success: false, message: 'Password/PIN incorrect' });

    const [assignedDealers, activeAudit, dealer] = await Promise.all([
      activeDealersForUser(user),
      getActiveAudit({ dealerCode: accessCheck.requestedDealer }).catch(() => null),
      Dealer.findOne({ dealerCode: accessCheck.requestedDealer }).lean()
    ]);

    debugMobileLogin('LOGIN_SUCCESS', {
      username: user.username,
      dealerCode: accessCheck.requestedDealer,
      auditId: activeAudit ? activeAudit.auditId : ''
    });

    return res.json({
      success: true,
      message: 'Login successful',
      token: signMobileToken(user),
      user: { ...publicUser(user), dealerAccess },
      dealerCode: accessCheck.requestedDealer,
      activeDealerId: accessCheck.requestedDealer,
      dealerName: dealer?.dealerName || '',
      auditId: activeAudit ? activeAudit.auditId : '',
      activeAudit: activeAudit ? publicAudit(activeAudit) : null,
      assignedDealers,
      activeDealers: assignedDealers
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
}

router.post('/mobile-login', mobileLoginHandler);

router.post('/pin-login', async (req, res) => {
  try {
    const pin = String(req.body.pin || '').trim();
    const dealerCode = normalizeAccessCode(req.body.dealerCode);
    const username = cleanUsername(req.body.username || req.body.userId || req.body.login || req.body.email);
    if (!dealerCode) return res.status(400).json({ success: false, message: 'Dealer code is required' });
    if (!/^\d{4}$/.test(pin)) {
      return res.status(400).json({ success: false, message: 'Enter a valid 4-digit PIN' });
    }
    if (!username) return res.status(400).json({ success: false, message: 'Username is required for PIN login' });

    const user = await findUserByLogin(username);
    const ruleError = loginRuleError(user, ['audit_user', 'mobile_user']);
    if (ruleError) return res.status(401).json({ success: false, message: ruleError });
    const accessCheck = await validateUserDealerAccess(user, dealerCode);
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
      const token = signToken(user);
      setAuthCookie(res, req, token);
      const dealerAccess = await userDealerAccessCodes(user);
      const assignedDealers = await activeDealersForUser(user);
      return res.json({
        success: true,
        token,
        user: { ...publicUser(user), dealerAccess },
        dealerCode: accessCheck.requestedDealer,
        activeDealerId: accessCheck.requestedDealer,
        assignedDealers,
        activeDealers: assignedDealers
      });
    }

    return res.status(401).json({ success: false, message: 'Invalid staff PIN' });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

router.post('/logout', (req, res) => {
  clearAuthCookie(res, req);
  return res.json({ success: true });
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const assignedDealers = await activeDealersForUser(req.user);
    res.json({
      success: true,
      user: req.user,
      assignedDealers,
      activeDealers: assignedDealers,
      activeDealerId: req.activeDealerId || ''
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/register', async (req, res) => {
  try {
    const user = await createUserFromPayload(req.body, {
      role: 'audit_user',
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
    const identifier = req.body.identifier || req.body.usernameOrEmail || req.body.username || req.body.email || '';
    const result = await passwordReset.requestReset(identifier, req);
    return res.json({ success: true, message: result.message });
  } catch (error) {
    console.error('Password reset request failed:', error.message);
    return res.status(503).json({ success: false, message: 'Unable to process the password reset request at this time. Please try again.' });
  }
}

router.post('/request-password-reset', requestPasswordReset);
router.post('/forgot-password', requestPasswordReset);
router.post('/send-otp', requestPasswordReset);

router.post('/reset-password', async (req, res) => {
  try {
    const newPassword = req.body.newPassword || req.body.password;
    if (String(req.body.confirmPassword || '') !== String(newPassword || '')) {
      return res.status(400).json({ success: false, message: 'New password and confirmation must match.' });
    }
    const result = await passwordReset.completeReset(req.body.token, newPassword, req);
    return res.status(result.status || 200).json({ success: result.ok, message: result.message });
  } catch (error) {
    console.error('Password reset completion failed:', error.message);
    return res.status(503).json({ success: false, message: 'Unable to reset the password at this time. Please try again.' });
  }
});

router.get('/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await User.find({}).sort({ approved: 1, createdAt: -1 }).lean();
    const cleaned = await Promise.all(users.map(async (user) => ({
      ...cleanPublicUser(user),
      dealerAccess: await userDealerAccessCodes(user)
    })));
    res.json({ success: true, users: cleaned });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post(['/users', '/users/create'], requireAuth, requireAdmin, async (req, res) => {
  try {
    const approved = req.body.approved !== false && req.body.approved !== 'false';
    const user = await createUserFromPayload(req.body, {
      role: req.body.role || 'audit_user',
      active: req.body.active !== false && req.body.active !== 'false',
      approved,
      approvedBy: req.user.username || req.user.name || 'admin'
    });
    const dealerAccess = await userDealerAccessCodes(user);
    res.status(201).json({ success: true, user: { ...cleanPublicUser(user), dealerAccess } });
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
    const role = ROLES.includes(normalizeRole(req.body.role, '')) ? normalizeRole(req.body.role, '') : '';
    if (!role) return res.status(400).json({ success: false, message: 'Valid role is required' });
    const currentUser = await User.findById(req.params.id).lean();
    if (!currentUser) return res.status(404).json({ success: false, message: 'User not found' });
    if (role === 'audit_user') {
      const access = await userDealerAccessCodes(currentUser);
      if (!access.length || access.includes('ALL')) return res.status(400).json({ success: false, message: 'Assign this user to a specific dealer before changing the role to Audit User.' });
    }
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

router.post('/users/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
  try {
    const password = String(req.body.password || '').trim();
    const pin = String(req.body.pin || '').trim();
    if (!password && !pin) {
      return res.status(400).json({ success: false, message: 'Password or 4-digit PIN is required' });
    }
    if (pin && !/^\d{4}$/.test(pin)) {
      return res.status(400).json({ success: false, message: 'PIN must be exactly 4 digits' });
    }
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (password) {
      const passwordHash = await bcrypt.hash(password, 10);
      user.passwordHash = passwordHash;
      user.password = passwordHash;
    }
    if (pin) {
      const pinHash = await bcrypt.hash(pin, 10);
      user.pinHash = pinHash;
      user.pin = pinHash;
    }
    user.forcePasswordChange = req.body.forcePasswordChange === true || req.body.forcePasswordChange === 'true';
    user.resetOtpHash = '';
    user.resetTokenHash = '';
    user.resetExpiresAt = undefined;
    user.resetRequestedAt = undefined;
    await user.save();
    res.json({
      success: true,
      user: cleanPublicUser(user),
      message: password && pin ? 'Password and PIN reset by admin' : password ? 'Password reset by admin' : 'PIN reset by admin'
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/users/:id/send-reset', requireAuth, requireAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const result = await passwordReset.requestReset(user.username, req, { admin: true });
    res.status(result.limited ? 429 : 200).json({ success: !result.limited && result.sent, message: result.message });
  } catch (error) {
    console.error('Admin password reset request failed:', error.message);
    res.status(503).json({ success: false, message: passwordReset.MAIL_ERROR });
  }
});

async function migrateLegacyUserRoles() {
  const users = await User.find({}).lean();
  let migrated = 0;
  for (const user of users) {
    const normalized = normalizeRole(user.role);
    if (String(user.role || '').trim().toLowerCase() === normalized) continue;
    await User.updateOne({ _id: user._id }, { $set: { role: normalized } });
    migrated += 1;
  }
  return { scanned: users.length, migrated };
}

module.exports = router;
module.exports.optionalAuth = optionalAuth;
module.exports.requireAuth = requireAuth;
module.exports.requireAdmin = requireAdmin;
module.exports.matrixAccessError = matrixAccessError;
module.exports.cleanPublicUser = cleanPublicUser;
module.exports.createUserFromPayload = createUserFromPayload;
module.exports.cleanUsername = cleanUsername;
module.exports.normalizePermissions = normalizePermissions;
module.exports.normalizeAccessCode = normalizeAccessCode;
module.exports.normalizeDealerAccess = normalizeDealerAccess;
module.exports.dealerAccessIncludes = dealerAccessIncludes;
module.exports.syncUserDealerMappings = syncUserDealerMappings;
module.exports.userDealerAccessCodes = userDealerAccessCodes;
module.exports.activeDealersForUser = activeDealersForUser;
module.exports.validateUserDealerAccess = validateUserDealerAccess;
module.exports.mobileLoginHandler = mobileLoginHandler;
module.exports.publicUser = publicUser;
module.exports.requirePageAuth = requirePageAuth;
module.exports.authenticateSocket = authenticateSocket;
module.exports.setAuthCookie = setAuthCookie;
module.exports.clearAuthCookie = clearAuthCookie;
module.exports.ROLES = ROLES;
module.exports.LEGACY_ROLE_MAP = LEGACY_ROLE_MAP;
module.exports.normalizeRole = normalizeRole;
module.exports.isAdminRole = isAdminRole;
module.exports.roleDisplayName = roleDisplayName;
module.exports.migrateLegacyUserRoles = migrateLegacyUserRoles;
