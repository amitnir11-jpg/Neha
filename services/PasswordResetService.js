const crypto = require('crypto');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const PasswordResetToken = require('../models/PasswordResetToken');
const AuditLogService = require('./AuditLogService');
const { withDatabaseTransaction } = require('./prisma');

const GENERIC_RESPONSE = 'If the account exists and has a registered email address, a password reset link has been sent.';
const INVALID_RESPONSE = 'This password reset link is invalid or has expired. Please request a new password reset link.';
const TOO_MANY_RESPONSE = 'Please wait before requesting another password reset email.';
const MAIL_ERROR = 'Unable to send the password reset email at this time. Please check the internet connection or contact your administrator.';
const attempts = new Map();
let nextPruneAt = 0;

function appEnv() { return String(process.env.APP_ENV || 'production').trim().toLowerCase(); }
function expiryMinutes() {
  const n = Number(process.env.RESET_TOKEN_EXPIRY_MINUTES || 15);
  return Number.isInteger(n) && n > 0 && n <= 60 ? n : 15;
}
function appUrl() {
  const value = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (!value) throw new Error('APP_URL is not configured');
  const parsed = new URL(value);
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('APP_URL must use HTTP or HTTPS');
  return value;
}
function passwordProblem(value) {
  const password = String(value || '');
  if (password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    return 'Use at least 8 characters with an uppercase letter, lowercase letter, number, and special character.';
  }
  return '';
}
function ipOf(req) {
  return String(req.ip || req.socket?.remoteAddress || '').replace('::ffff:', '').slice(0, 128);
}
function recordAudit(eventType, user, req, result, extra = {}) {
  const actor = extra.adminTriggered && req.user ? req.user : (user || {});
  return AuditLogService.record({
    eventType, module: 'authentication', severity: result === 'SUCCESS' || result === 'EMAIL_SENT' ? 'info' : 'warning',
    message: `${eventType} ${result}`, actorId: actor.username || actor.id || '', actorName: actor.name || actor.username || '',
    actorRole: actor.role || '', ipAddress: ipOf(req), userAgent: String(req.headers['user-agent'] || '').slice(0, 500),
    metadata: { result, targetUserId: user?.username || user?.id || '', ...extra }
  });
}
function allowAttempt(req, identifier) {
  const now = Date.now();
  if (now >= nextPruneAt) {
    for (const [key, times] of attempts) {
      const fresh = times.filter((time) => now - time < 15 * 60 * 1000);
      if (fresh.length) attempts.set(key, fresh); else attempts.delete(key);
    }
    nextPruneAt = now + 60 * 1000;
  }
  const ipKey = `ip:${ipOf(req)}`;
  const identifierKey = `identifier:${crypto.createHash('sha256').update(identifier).digest('hex')}`;
  const ipTimes = attempts.get(ipKey) || [];
  const idTimes = attempts.get(identifierKey) || [];
  if (ipTimes.length >= 10 || idTimes.length >= 3) return false;
  attempts.set(ipKey, [...ipTimes, now]);
  attempts.set(identifierKey, [...idTimes, now]);
  while (attempts.size > 50000) attempts.delete(attempts.keys().next().value);
  return true;
}
function transporter() {
  const user = String(process.env.EMAIL_USER || '').trim();
  const pass = String(process.env.EMAIL_APP_PASSWORD || '').replace(/\s/g, '');
  if (!user || !pass) throw new Error('Password reset email is not configured');
  if (user.toLowerCase() !== 'dakshinventory@gmail.com') throw new Error('Password reset sender must be dakshinventory@gmail.com');
  return { user, transport: nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    auth: { user, pass }
  }) };
}
function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
async function sendResetMail(user, token) {
  const { user: email, transport } = transporter();
  const url = `${appUrl()}/?resetToken=${encodeURIComponent(token)}`;
  const fromName = String(process.env.EMAIL_FROM_NAME || 'Daksh Inventory Solution v2').trim();
  const text = [
    'Dear User,', '', 'We received a request to reset the password for your Daksh Inventory Solution v2 account.',
    `Reset Password: ${url}`, '', `This password reset link is valid for ${expiryMinutes()} minutes and can be used only once.`,
    'If you did not request a password reset, please ignore this email. Your existing password will remain unchanged.', '',
    'Daksh Inventory Solution v2', 'Official System Email: dakshinventory@gmail.com'
  ].join('\n');
  await transport.sendMail({
    from: { name: fromName, address: email }, to: user.email,
    subject: 'Password Reset – Daksh Inventory Solution v2', text,
    html: `<p>Dear User,</p><p>We received a request to reset the password for your Daksh Inventory Solution v2 account.</p><p><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 20px;background:#174a7e;color:#fff;text-decoration:none;border-radius:6px">Reset Password</a></p><p>This password reset link is valid for ${expiryMinutes()} minutes and can be used only once.</p><p>If you did not request a password reset, please ignore this email. Your existing password will remain unchanged.</p><p>Daksh Inventory Solution v2<br>Official System Email: dakshinventory@gmail.com</p>`
  });
}
async function requestReset(identifier, req, { admin = false } = {}) {
  const normalized = String(identifier || '').trim().toLowerCase();
  if (!allowAttempt(req, normalized || 'empty')) return { limited: true, message: admin ? TOO_MANY_RESPONSE : GENERIC_RESPONSE };
  if (normalized.length > 254) return { sent: false, message: GENERIC_RESPONSE };
  let user = normalized ? await User.findOne({ username: normalized }) : null;
  if (!user && normalized) {
    const emailMatches = await User.find({ email: normalized }).limit(2);
    if (emailMatches.length === 1) user = emailMatches[0];
  }
  await recordAudit('PASSWORD_RESET_REQUEST', user, req, user ? 'REQUESTED' : 'NO_MATCH', {
    adminTriggered: admin, requestedIdentifier: normalized.slice(0, 254), adminUsername: admin ? String(req.user?.username || '') : ''
  });
  if (!user || !user.email || user.approved === false || user.active === false || user.isActive === false) {
    return { sent: false, message: GENERIC_RESPONSE };
  }
  const recentRequests = await PasswordResetToken.countDocuments({
    userId: user._id, appEnv: appEnv(), createdAt: { $gt: new Date(Date.now() - 15 * 60 * 1000) }
  });
  if (recentRequests >= 3) return { limited: true, message: admin ? TOO_MANY_RESPONSE : GENERIC_RESPONSE };

  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + expiryMinutes() * 60 * 1000);
  try {
    await withDatabaseTransaction(async () => {
      await PasswordResetToken.updateMany({ userId: user._id, appEnv: appEnv(), usedAt: null }, { usedAt: new Date() });
      await PasswordResetToken.create({
        userId: user._id, tokenHash, expiresAt, usedAt: null, createdAt: new Date(), requestIp: ipOf(req),
        userAgent: String(req.headers['user-agent'] || '').slice(0, 500), appEnv: appEnv()
      });
    });
  } catch (error) {
    console.error('Password reset token persistence failed:', error.message);
    if (admin) return { sent: false, message: MAIL_ERROR };
    return { sent: false, message: GENERIC_RESPONSE };
  }

  try {
    await sendResetMail(user, token);
    await recordAudit('PASSWORD_RESET_EMAIL', user, req, 'EMAIL_SENT', { adminTriggered: admin });
    return { sent: true, message: GENERIC_RESPONSE };
  } catch (error) {
    await PasswordResetToken.updateMany({ tokenHash }, { usedAt: new Date() }).catch(() => null);
    console.error('Password reset email failed:', error.message);
    await recordAudit('PASSWORD_RESET_EMAIL', user, req, 'EMAIL_FAILED', { adminTriggered: admin });
    return { sent: false, message: admin ? MAIL_ERROR : GENERIC_RESPONSE };
  }
}
async function completeReset(token, password, req) {
  const rawToken = String(token || '').trim();
  if (!rawToken || rawToken.length > 256) return { ok: false, status: 400, message: INVALID_RESPONSE };
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const now = new Date();
  const candidate = await PasswordResetToken.findOne({ tokenHash, appEnv: appEnv(), usedAt: null, expiresAt: { $gt: now } }).lean();
  if (!candidate) {
    await recordAudit('PASSWORD_RESET_TOKEN_REJECTED', null, req, 'INVALID_OR_EXPIRED');
    return { ok: false, status: 400, message: INVALID_RESPONSE };
  }
  const candidateUser = await User.findById(candidate.userId).lean();
  if (!candidateUser || candidateUser.approved === false || candidateUser.active === false || candidateUser.isActive === false) {
    await recordAudit('PASSWORD_RESET_TOKEN_REJECTED', candidateUser, req, 'INVALID_OR_EXPIRED');
    return { ok: false, status: 400, message: INVALID_RESPONSE };
  }
  const problem = passwordProblem(password);
  if (problem) return { ok: false, status: 400, message: problem };
  let user;
  try {
    user = await withDatabaseTransaction(async () => {
      const validationTime = new Date();
      const reset = await PasswordResetToken.findOne({ tokenHash, appEnv: appEnv(), usedAt: null, expiresAt: { $gt: validationTime } });
      if (!reset) return null;
      const target = await User.findById(reset.userId);
      if (!target || target.approved === false || target.active === false || target.isActive === false) return null;
      const hash = await bcrypt.hash(String(password), 12);
      const consumedAt = new Date();
      const consumed = await PasswordResetToken.updateOne({ _id: reset._id, usedAt: null, expiresAt: { $gt: consumedAt } }, { usedAt: consumedAt });
      if (!consumed || consumed.matchedCount !== 1) return null;
      await User.findByIdAndUpdate(target._id, { passwordHash: hash, password: hash, forcePasswordChange: false, passwordChangedAt: consumedAt });
      await PasswordResetToken.updateMany({ userId: target._id, appEnv: appEnv(), usedAt: null }, { usedAt: consumedAt });
      return target;
    });
  } catch (error) {
    console.error('Password reset transaction failed:', error.message);
    return { ok: false, status: 503, message: 'Unable to reset the password at this time. Please try again.' };
  }
  if (!user) {
    await recordAudit('PASSWORD_RESET_TOKEN_REJECTED', null, req, 'INVALID_OR_EXPIRED');
    return { ok: false, status: 400, message: INVALID_RESPONSE };
  }
  await recordAudit('PASSWORD_RESET_COMPLETED', user, req, 'SUCCESS');
  try {
    const { user: email, transport } = transporter();
    await transport.sendMail({
      from: { name: String(process.env.EMAIL_FROM_NAME || 'Daksh Inventory Solution v2').trim(), address: email },
      to: user.email, subject: 'Your Daksh Inventory Password Has Been Changed',
      text: `Your Daksh Inventory Solution v2 account password was successfully changed on ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}.\n\nIf you did not perform this action, please contact your administrator immediately.`,
      html: `<p>Your Daksh Inventory Solution v2 account password was successfully changed on ${escapeHtml(new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))}.</p><p>If you did not perform this action, please contact your administrator immediately.</p>`
    });
    await recordAudit('PASSWORD_RESET_CONFIRMATION_EMAIL', user, req, 'EMAIL_SENT');
  } catch (error) {
    console.error('Password reset confirmation email failed:', error.message);
    await recordAudit('PASSWORD_RESET_CONFIRMATION_EMAIL', user, req, 'EMAIL_FAILED');
  }
  return { ok: true, message: 'Password reset successfully. Please login again using your new password.' };
}

module.exports = { GENERIC_RESPONSE, INVALID_RESPONSE, MAIL_ERROR, TOO_MANY_RESPONSE, completeReset, passwordProblem, requestReset };
