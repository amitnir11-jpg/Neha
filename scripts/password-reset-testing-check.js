// Run only with Railway's isolated testing service variables:
// railway run --environment testing --service Neha-testing -- node scripts/password-reset-testing-check.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const nodemailer = require('nodemailer');
const User = require('../models/User');
const PasswordResetToken = require('../models/PasswordResetToken');
const AuditLogService = require('../services/AuditLogService');
const { getPrismaClient } = require('../services/prisma');

async function main() {
  if (String(process.env.RAILWAY_ENVIRONMENT_NAME || '').toLowerCase() !== 'testing') {
    throw new Error('Refusing to run unless RAILWAY_ENVIRONMENT_NAME is testing.');
  }
  const prisma = getPrismaClient();
  const db = await prisma.$queryRaw`SELECT current_database() AS name, to_regclass('public.password_reset_tokens') AS token_table`;
  if (!db[0]?.token_table || /prod/i.test(String(db[0].name))) throw new Error('Expected the isolated testing database and password_reset_tokens table.');

  const suffix = crypto.randomUUID();
  const userId = `password-reset-test-${suffix}`;
  const fakeUser = {
    _id: userId, id: userId, username: `password-reset-test-${suffix}@example.invalid`,
    email: 'dakshinventory@gmail.com', approved: true, active: true, isActive: true,
    passwordHash: 'unchanged-before-test', password: 'unchanged-before-test'
  };
  const original = {
    findOne: User.findOne, find: User.find, findById: User.findById,
    findByIdAndUpdate: User.findByIdAndUpdate, audit: AuditLogService.record,
    createTransport: nodemailer.createTransport
  };
  let sentResetMail = null;
  let realTransportUsed = false;
  try {
    User.findOne = async (filter) => filter.username === fakeUser.username ? fakeUser : null;
    User.find = async () => ({ limit: async () => [] });
    User.findById = async (id) => id === userId ? fakeUser : null;
    User.findByIdAndUpdate = async (id, update) => {
      if (id === userId) Object.assign(fakeUser, update);
      return fakeUser;
    };
    AuditLogService.record = async () => null;
    nodemailer.createTransport = (...args) => {
      const transport = original.createTransport(...args);
      return { ...transport, sendMail: async (message) => {
        if (!sentResetMail) {
          realTransportUsed = true;
          sentResetMail = message;
          return transport.sendMail(message);
        }
        return { messageId: 'test-confirmation-suppressed' };
      } };
    };

    process.env.APP_ENV = 'testing';
    process.env.RESET_TOKEN_EXPIRY_MINUTES = '15';
    const service = require('../services/PasswordResetService');
    const startedAt = Date.now();
    const request = await service.requestReset(fakeUser.username, {
      ip: '127.0.0.1', socket: {}, headers: { 'user-agent': 'isolated-password-reset-check' }
    });
    assert.equal(request.sent, true, 'requestReset should create and email a token');
    assert.ok(realTransportUsed, 'the reset email should use the configured Gmail SMTP transport');
    assert.ok(sentResetMail, 'capture sent reset message');
    assert.equal(sentResetMail.to, 'dakshinventory@gmail.com');
    const link = sentResetMail.text.match(/https?:\/\/[^\s]+/);
    assert.ok(link, 'email contains a recovery URL');
    const rawToken = new URL(link[0]).searchParams.get('resetToken');
    assert.ok(rawToken, 'recovery URL contains the raw token');
    assert.match(sentResetMail.text, /valid for 15 minutes and can be used only once/);

    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const persisted = await PasswordResetToken.findOne({ tokenHash, userId, appEnv: 'testing', usedAt: null }).lean();
    assert.ok(persisted, 'token is created and can be validated by relational fields');
    assert.ok(persisted.expiresAt.getTime() >= startedAt + 14 * 60 * 1000, 'token has approximately 15-minute expiry');
    assert.ok(persisted.expiresAt.getTime() <= startedAt + 16 * 60 * 1000, 'token expiry is bounded to approximately 15 minutes');

    // Suppress only the separate confirmation message; the reset email above was sent through Gmail.
    nodemailer.createTransport = () => ({ sendMail: async () => ({ messageId: 'test-confirmation-suppressed' }) });
    const reset = await service.completeReset(rawToken, 'NewTestingPassword!7', {
      ip: '127.0.0.1', socket: {}, headers: { 'user-agent': 'isolated-password-reset-check' }
    });
    assert.equal(reset.ok, true, 'a valid token completes a reset');
    assert.notEqual(fakeUser.passwordHash, 'unchanged-before-test', 'test user fixture receives password update');
    const consumed = await PasswordResetToken.findOne({ tokenHash, appEnv: 'testing', usedAt: null }).lean();
    assert.equal(consumed, null, 'consumed token cannot be validated again');
    const replay = await service.completeReset(rawToken, 'AnotherTestingPassword!8', {
      ip: '127.0.0.1', socket: {}, headers: { 'user-agent': 'isolated-password-reset-check' }
    });
    assert.equal(replay.ok, false, 'the recovery link works only once');

    const expiredRaw = crypto.randomBytes(32).toString('base64url');
    const expiredHash = crypto.createHash('sha256').update(expiredRaw).digest('hex');
    await PasswordResetToken.create({
      id: `password-reset-expired-${suffix}`, userId, tokenHash: expiredHash,
      expiresAt: new Date(Date.now() - 1000), usedAt: null, createdAt: new Date(Date.now() - 16 * 60 * 1000),
      requestIp: '127.0.0.1', userAgent: 'isolated-password-reset-check', appEnv: 'testing'
    });
    const expired = await service.completeReset(expiredRaw, 'NewTestingPassword!7', {
      ip: '127.0.0.1', socket: {}, headers: { 'user-agent': 'isolated-password-reset-check' }
    });
    assert.equal(expired.ok, false, 'expired token is rejected');
    console.log('PASS: isolated testing database, relational token CRUD/count/filter, Gmail reset email, 15-minute expiry, one-time consumption, and expired-link rejection.');
  } finally {
    nodemailer.createTransport = original.createTransport;
    User.findOne = original.findOne;
    User.find = original.find;
    User.findById = original.findById;
    User.findByIdAndUpdate = original.findByIdAndUpdate;
    AuditLogService.record = original.audit;
    // userId is a unique synthetic fixture identifier; this removes only tokens
    // created by this run, including a row left behind if SMTP fails mid-test.
    await PasswordResetToken.deleteMany({ userId, appEnv: 'testing' });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('FAIL: isolated password reset check:', error.message);
  process.exitCode = 1;
});
