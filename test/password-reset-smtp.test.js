const test = require('node:test');
const assert = require('node:assert/strict');
const nodemailer = require('nodemailer');
const { exactIgnoreCase, transporter } = require('../services/PasswordResetService');

test('password reset lookup is case-insensitive and treats the supplied identifier literally', () => {
  const pattern = exactIgnoreCase('Daksh.Inventory+Test@gmail.com');
  assert.equal(pattern.test('daksh.inventory+test@gmail.com'), true);
  assert.equal(pattern.test('xDaksh.Inventory+Test@gmail.com'), false);
  assert.equal(pattern.test('DakshXInventory+Test@gmail.com'), false);
});

test('password reset transport honors Gmail SMTP host, 587 STARTTLS, and secret env names', () => {
  const names = ['SMTP_USER', 'SMTP_PASS', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const originalCreateTransport = nodemailer.createTransport;
  let options;
  try {
    process.env.SMTP_USER = 'dakshinventory@gmail.com';
    process.env.SMTP_PASS = 'test-only-app-password';
    process.env.SMTP_HOST = 'smtp.gmail.com';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_SECURE = 'false';
    nodemailer.createTransport = (config) => { options = config; return { verify: async () => true }; };

    transporter();
    assert.equal(options.host, 'smtp.gmail.com');
    assert.equal(options.port, 587);
    assert.equal(options.secure, false);
    assert.equal(options.requireTLS, true);
    assert.equal(options.auth.user, 'dakshinventory@gmail.com');
    assert.equal(options.auth.pass, 'test-only-app-password');
  } finally {
    nodemailer.createTransport = originalCreateTransport;
    names.forEach((name) => {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    });
  }
});
