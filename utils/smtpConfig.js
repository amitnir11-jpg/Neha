const crypto = require('crypto');
const nodemailer = require('nodemailer');
const Setting = require('../models/Setting');

const SMTP_KEY = 'smtp';
const DEFAULT_SMTP = {
  smtpEmail: 'amitsvision4u@gmail.com',
  smtpHost: 'smtp.gmail.com',
  smtpPort: 587,
  secure: false,
  requireTLS: true,
  fromEmail: 'amitsvision4u@gmail.com'
};

function cleanEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function cleanText(value) {
  return String(value || '').trim();
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 'true' || value === '1' || value === 1 || value === 'on';
}

function encryptionKey() {
  const secret = process.env.SMTP_ENCRYPTION_KEY || process.env.JWT_SECRET || 'daksh_inventory_secret';
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encryptSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  };
}

function decryptSecret(payload) {
  if (!payload || !payload.iv || !payload.tag || !payload.data) return '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

function normalizeInput(body = {}) {
  const smtpEmail = cleanEmail(body.smtpEmail || body.email || DEFAULT_SMTP.smtpEmail);
  const fromEmail = cleanEmail(body.fromEmail || smtpEmail || DEFAULT_SMTP.fromEmail);
  const smtpHost = cleanText(body.smtpHost || body.host || DEFAULT_SMTP.smtpHost);
  const smtpPort = Number(body.smtpPort || body.port || DEFAULT_SMTP.smtpPort);
  const secure = toBoolean(body.secure, DEFAULT_SMTP.secure);
  const requireTLS = toBoolean(body.requireTLS !== undefined ? body.requireTLS : body.tls, DEFAULT_SMTP.requireTLS);

  if (!smtpEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(smtpEmail)) throw new Error('Valid SMTP Email is required');
  if (!fromEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) throw new Error('Valid From Email is required');
  if (!smtpHost) throw new Error('SMTP Host is required');
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) throw new Error('Valid SMTP Port is required');

  return { smtpEmail, smtpHost, smtpPort, secure, requireTLS, fromEmail };
}

async function rawSetting() {
  return Setting.findOne({ key: SMTP_KEY }).lean();
}

async function getStoredSmtp(includePassword = false) {
  const setting = await rawSetting();
  const value = setting && setting.value ? setting.value : {};
  const config = {
    ...DEFAULT_SMTP,
    smtpEmail: cleanEmail(value.smtpEmail || process.env.SMTP_USER || DEFAULT_SMTP.smtpEmail),
    smtpHost: cleanText(value.smtpHost || process.env.SMTP_HOST || DEFAULT_SMTP.smtpHost),
    smtpPort: Number(value.smtpPort || process.env.SMTP_PORT || DEFAULT_SMTP.smtpPort),
    secure: value.secure !== undefined ? Boolean(value.secure) : Number(value.smtpPort || process.env.SMTP_PORT || DEFAULT_SMTP.smtpPort) === 465,
    requireTLS: value.requireTLS !== undefined ? Boolean(value.requireTLS) : DEFAULT_SMTP.requireTLS,
    fromEmail: cleanEmail(value.fromEmail || process.env.REPORT_EMAIL || value.smtpEmail || DEFAULT_SMTP.fromEmail),
    verified: Boolean(value.verified),
    verifiedAt: value.verifiedAt || null,
    lastError: value.lastError || '',
    hasPassword: Boolean(value.smtpPasswordEncrypted || process.env.SMTP_PASS)
  };
  if (includePassword) {
    config.password = value.smtpPasswordEncrypted ? decryptSecret(value.smtpPasswordEncrypted) : String(process.env.SMTP_PASS || '');
  }
  return config;
}

function publicStatus(config) {
  const requiredFieldsPresent = Boolean(config.smtpEmail && config.smtpHost && config.smtpPort && config.hasPassword);
  const configured = requiredFieldsPresent && Boolean(config.verified);
  return {
    configured,
    verified: Boolean(config.verified),
    requiredFieldsPresent,
    passwordSaved: Boolean(config.hasPassword),
    passwordMasked: config.hasPassword ? '********' : '',
    smtpEmail: config.smtpEmail,
    smtpHost: config.smtpHost,
    smtpPort: config.smtpPort,
    secure: Boolean(config.secure),
    requireTLS: Boolean(config.requireTLS),
    fromEmail: config.fromEmail,
    verifiedAt: config.verifiedAt,
    lastError: config.lastError || ''
  };
}

function createTransport(config) {
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: Number(config.smtpPort || 587),
    secure: Boolean(config.secure),
    requireTLS: Boolean(config.requireTLS),
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
    auth: {
      user: config.smtpEmail,
      pass: config.password
    }
  });
}

function friendlySmtpError(error) {
  const code = String(error && (error.code || error.command || error.responseCode) || '');
  const text = String(error && (error.message || error.response) || '');
  if (/EAUTH|Invalid login|Username and Password not accepted|535|534/i.test(`${code} ${text}`)) {
    return 'SMTP configuration failed. Please check email/app password.';
  }
  if (/ETIMEDOUT|timeout|Greeting never received/i.test(`${code} ${text}`)) {
    return 'SMTP configuration failed. Connection timed out. Please check host, port, TLS and network.';
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|Network|EHOSTUNREACH/i.test(`${code} ${text}`)) {
    return 'SMTP configuration failed. Please check network, host and port.';
  }
  return 'SMTP configuration failed. Please check email/app password.';
}

function assertComplete(config) {
  if (!config.smtpEmail) throw new Error('SMTP Email is required');
  if (!config.password) throw new Error('SMTP App Password is required');
  if (!config.smtpHost) throw new Error('SMTP Host is required');
  if (!config.smtpPort) throw new Error('SMTP Port is required');
}

async function verifySmtp(config) {
  assertComplete(config);
  const transporter = createTransport(config);
  try {
    await transporter.verify();
    return true;
  } catch (error) {
    throw new Error(friendlySmtpError(error));
  }
}

async function saveSmtpSettings(body = {}, updatedBy = '') {
  const current = await getStoredSmtp(true);
  const normalized = normalizeInput(body);
  const password = cleanText(body.smtpPassword || body.password || body.appPassword || '');
  if (!current.hasPassword && !password) throw new Error('SMTP App Password is required for first setup');

  const value = {
    ...normalized,
    verified: false,
    verifiedAt: null,
    lastError: ''
  };
  if (password) value.smtpPasswordEncrypted = encryptSecret(password);

  const existing = await rawSetting();
  if (!password && existing && existing.value && existing.value.smtpPasswordEncrypted) {
    value.smtpPasswordEncrypted = existing.value.smtpPasswordEncrypted;
  }

  let saved = await Setting.findOneAndUpdate(
    { key: SMTP_KEY },
    { key: SMTP_KEY, value, updatedBy },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  try {
    const config = await getStoredSmtp(true);
    await verifySmtp(config);
    saved.value.verified = true;
    saved.value.verifiedAt = new Date();
    saved.value.lastError = '';
    saved.markModified('value');
    await saved.save();
  } catch (error) {
    saved.value.verified = false;
    saved.value.verifiedAt = null;
    saved.value.lastError = error.message;
    saved.markModified('value');
    await saved.save();
    throw error;
  }

  return publicStatus(await getStoredSmtp(false));
}

async function changeSmtpPassword(newPassword, confirmPassword, updatedBy = '') {
  const password = cleanText(newPassword);
  const confirm = cleanText(confirmPassword);
  if (!password) throw new Error('New SMTP App Password is required');
  if (password !== confirm) throw new Error('SMTP App Password and Confirm Password must match');

  const current = await getStoredSmtp(false);
  const value = {
    smtpEmail: current.smtpEmail,
    smtpHost: current.smtpHost,
    smtpPort: current.smtpPort,
    secure: current.secure,
    requireTLS: current.requireTLS,
    fromEmail: current.fromEmail,
    smtpPasswordEncrypted: encryptSecret(password),
    verified: false,
    verifiedAt: null,
    lastError: ''
  };

  const saved = await Setting.findOneAndUpdate(
    { key: SMTP_KEY },
    { key: SMTP_KEY, value, updatedBy },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  try {
    await verifySmtp({ ...value, password });
    saved.value.verified = true;
    saved.value.verifiedAt = new Date();
    saved.value.lastError = '';
    saved.markModified('value');
    await saved.save();
  } catch (error) {
    saved.value.verified = false;
    saved.value.lastError = error.message;
    saved.markModified('value');
    await saved.save();
    throw error;
  }

  return publicStatus(await getStoredSmtp(false));
}

async function getVerifiedSmtpConfig() {
  const config = await getStoredSmtp(true);
  if (!config.smtpEmail || !config.password || !config.smtpHost || !config.smtpPort || !config.verified) {
    throw new Error('SMTP is not configured. Please configure SMTP from Admin Settings.');
  }
  return config;
}

async function sendOtpEmail(to, otp, extra = {}) {
  const config = await getVerifiedSmtpConfig();
  const transporter = createTransport(config);
  try {
    await transporter.sendMail({
      from: config.fromEmail,
      replyTo: config.fromEmail,
      to,
      subject: extra.subject || 'Daksh Inventory OTP',
      text: extra.text,
      html: extra.html
    });
  } catch (error) {
    throw new Error(friendlySmtpError(error));
  }
  return config;
}

async function sendTestOtp(to) {
  const email = cleanEmail(to);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Valid test email is required');
  const otp = String(crypto.randomInt(100000, 999999));
  await sendOtpEmail(email, otp, {
    subject: 'Daksh Inventory SMTP Test OTP',
    text: [`Daksh Inventory SMTP test OTP: ${otp}`, '', 'If you did not request this test, ignore this email.'].join('\n'),
    html: `<p>Daksh Inventory SMTP test OTP:</p><p><strong>${otp}</strong></p><p>If you did not request this test, ignore this email.</p>`
  });
  return { otpSent: true };
}

module.exports = {
  DEFAULT_SMTP,
  changeSmtpPassword,
  getStoredSmtp,
  getVerifiedSmtpConfig,
  publicStatus,
  saveSmtpSettings,
  sendOtpEmail,
  sendTestOtp,
  verifySmtp,
  friendlySmtpError
};
