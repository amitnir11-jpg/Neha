const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_APP_ID = 'daksh-inventory-v2';
const DEFAULT_PRODUCT_NAME = 'Daksh Inventory';
const STATUS_CACHE_MS = 5000;

function clean(value) {
  return String(value || '').trim();
}

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(raw).trim().toLowerCase());
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return null;
  }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function base64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function fromBase64Url(input) {
  const text = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = text + '='.repeat((4 - (text.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function stableJson(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseDateMs(value) {
  if (!value) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 100000000000 ? value : value * 1000;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function maskLicenseKey(value) {
  const text = clean(value);
  if (!text) return '';
  if (text.length <= 8) return `${text.slice(0, 2)}***${text.slice(-2)}`;
  return `${text.slice(0, 4)}-${'*'.repeat(Math.min(12, text.length - 8))}-${text.slice(-4)}`;
}

function isPlausibleLicenseKey(value) {
  return /^(?:DAKSH|LICENSE)(?:-[A-Z0-9]{4,8}){3,5}$/.test(clean(value).toUpperCase().replace(/\s+/g, ''));
}

function firstText(...values) {
  return clean(values.find((value) => clean(value)) || '');
}

function runPowerShell(script, input = '') {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encoded
  ], {
    input,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(clean(result.stderr) || clean(result.stdout) || `PowerShell exited with code ${result.status}`);
  }
  return clean(result.stdout);
}

function dpapiPowerShellScript(operation, scope) {
  const localMachineFlag = scope === 'LocalMachine' ? 4 : 0;
  return `
$ErrorActionPreference = 'Stop'
if (-not ('DakshDpapi' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DakshDpapi {
  [StructLayout(LayoutKind.Sequential)] public struct DATA_BLOB { public int cbData; public IntPtr pbData; }
  [DllImport("crypt32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  private static extern bool CryptProtectData(ref DATA_BLOB input, string description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, ref DATA_BLOB output);
  [DllImport("crypt32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  private static extern bool CryptUnprotectData(ref DATA_BLOB input, IntPtr description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, ref DATA_BLOB output);
  public static byte[] Protect(byte[] data, int flags) {
    var input = new DATA_BLOB(); var output = new DATA_BLOB();
    input.cbData = data.Length; input.pbData = Marshal.AllocHGlobal(data.Length); Marshal.Copy(data, 0, input.pbData, data.Length);
    try { if (!CryptProtectData(ref input, "DAKSH", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, flags, ref output)) throw new InvalidOperationException("CryptProtectData failed: " + Marshal.GetLastWin32Error()); var result = new byte[output.cbData]; Marshal.Copy(output.pbData, result, 0, output.cbData); return result; }
    finally { if (input.pbData != IntPtr.Zero) Marshal.FreeHGlobal(input.pbData); if (output.pbData != IntPtr.Zero) Marshal.FreeHGlobal(output.pbData); }
  }
  public static byte[] Unprotect(byte[] data) {
    var input = new DATA_BLOB(); var output = new DATA_BLOB();
    input.cbData = data.Length; input.pbData = Marshal.AllocHGlobal(data.Length); Marshal.Copy(data, 0, input.pbData, data.Length);
    try { if (!CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, ref output)) throw new InvalidOperationException("CryptUnprotectData failed: " + Marshal.GetLastWin32Error()); var result = new byte[output.cbData]; Marshal.Copy(output.pbData, result, 0, output.cbData); return result; }
    finally { if (input.pbData != IntPtr.Zero) Marshal.FreeHGlobal(input.pbData); if (output.pbData != IntPtr.Zero) Marshal.FreeHGlobal(output.pbData); }
  }
}
'@
}
$inputText = [Console]::In.ReadToEnd().Trim()
$bytes = [Convert]::FromBase64String($inputText)
${operation === 'protect' ? `$result = [DakshDpapi]::Protect($bytes, ${localMachineFlag})` : `$result = [DakshDpapi]::Unprotect($bytes)`}
[Convert]::ToBase64String($result)
`;
}

function isLocalRequest(req) {
  const address = clean(req.socket?.remoteAddress || req.connection?.remoteAddress || req.ip);
  const normalized = address.replace(/^::ffff:/, '');
  return ['127.0.0.1', '::1', 'localhost'].includes(normalized) || normalized === '';
}

class LicenseService {
  constructor() {
    this.statusCache = null;
    this.deviceIdentityCache = null;
    this.periodicTimer = null;
  }

  appId() {
    return clean(process.env.DAKSH_LICENSE_APP_ID) || DEFAULT_APP_ID;
  }

  appVersion() {
    return clean(process.env.DAKSH_LICENSE_APP_VERSION || process.env.npm_package_version) || '2.0.0';
  }

  productName() {
    return clean(process.env.DAKSH_PRODUCT_NAME) || DEFAULT_PRODUCT_NAME;
  }

  isRequired() {
    return envBool('DAKSH_LICENSE_REQUIRED', false);
  }

  serverBaseUrl() {
    return clean(process.env.DAKSH_LICENSE_SERVER_URL).replace(/\/+$/, '');
  }

  storeDir() {
    const configured = clean(process.env.DAKSH_LICENSE_STORE_DIR);
    if (configured) return path.resolve(configured);
    const programData = clean(process.env.ProgramData);
    if (process.platform === 'win32' && programData) return path.join(programData, 'DAKSH', 'license');
    return path.join(ROOT_DIR, 'local-data', 'license');
  }

  tokenPath() {
    return path.join(this.storeDir(), 'activation-token.json');
  }

  deviceKeyPath() {
    return path.join(this.storeDir(), 'device-key.json');
  }

  publicKey() {
    const keyPath = clean(process.env.DAKSH_LICENSE_PUBLIC_KEY_PATH);
    let key = clean(process.env.DAKSH_LICENSE_PUBLIC_KEY);
    if (!key && keyPath) {
      try {
        key = fs.readFileSync(path.resolve(keyPath), 'utf8');
      } catch (error) {
        return '';
      }
    }
    if (!key && clean(process.env.DAKSH_LICENSE_PUBLIC_KEY_B64)) {
      try {
        key = Buffer.from(clean(process.env.DAKSH_LICENSE_PUBLIC_KEY_B64), 'base64').toString('utf8');
      } catch (error) {
        key = '';
      }
    }
    return key.replace(/\\n/g, '\n').trim();
  }

  protectSecret(secret) {
    if (process.platform === 'win32' && envBool('DAKSH_LICENSE_USE_DPAPI', true)) {
      const scope = clean(process.env.DAKSH_LICENSE_DPAPI_SCOPE) === 'LocalMachine' ? 'LocalMachine' : 'CurrentUser';
      const script = dpapiPowerShellScript('protect', scope);
      return {
        format: 'dpapi',
        scope,
        value: runPowerShell(script, Buffer.from(String(secret || ''), 'utf8').toString('base64'))
      };
    }

    return {
      format: 'base64',
      value: Buffer.from(String(secret || ''), 'utf8').toString('base64')
    };
  }

  unprotectSecret(record) {
    if (!record || !record.value) return '';
    if (record.format === 'dpapi') {
      const scope = record.scope === 'LocalMachine' ? 'LocalMachine' : 'CurrentUser';
      const script = dpapiPowerShellScript('unprotect', scope);
      return Buffer.from(runPowerShell(script, record.value), 'base64').toString('utf8');
    }
    if (record.format === 'base64') return Buffer.from(record.value, 'base64').toString('utf8');
    return '';
  }

  windowsMachineParts() {
    if (process.platform !== 'win32') return {};
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
$machineGuid = (Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid).MachineGuid
$bios = Get-CimInstance Win32_BIOS
$board = Get-CimInstance Win32_BaseBoard
$system = Get-CimInstance Win32_ComputerSystemProduct
[ordered]@{
  machineGuid = $machineGuid
  biosSerial = $bios.SerialNumber
  baseBoardSerial = $board.SerialNumber
  systemUuid = $system.UUID
} | ConvertTo-Json -Compress
`;
    try {
      return JSON.parse(runPowerShell(script) || '{}');
    } catch (error) {
      return {};
    }
  }

  linuxMachineId() {
    for (const filePath of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        const value = clean(fs.readFileSync(filePath, 'utf8'));
        if (value) return value;
      } catch (error) {
      }
    }
    return '';
  }

  machineFingerprintMaterial() {
    const platformParts = process.platform === 'win32'
      ? this.windowsMachineParts()
      : { machineId: this.linuxMachineId() };
    const strongParts = Object.fromEntries(Object.entries(platformParts).filter(([, value]) => clean(value)));
    const fallback = Object.keys(strongParts).length ? {} : {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().map((cpu) => cpu.model).slice(0, 2)
    };
    return stableJson({
      appId: this.appId(),
      platform: os.platform(),
      arch: os.arch(),
      strongParts,
      fallback
    });
  }

  deviceIdentity() {
    if (this.deviceIdentityCache) return this.deviceIdentityCache;
    const material = this.machineFingerprintMaterial();
    this.deviceIdentityCache = {
      appId: this.appId(),
      fingerprintHash: sha256(material),
      fingerprintVersion: 'v1',
      deviceName: os.hostname(),
      platform: os.platform(),
      arch: os.arch()
    };
    return this.deviceIdentityCache;
  }

  ensureDeviceKeyPair() {
    const existing = readJson(this.deviceKeyPath());
    if (existing && existing.publicKey && existing.privateKey) {
      try {
        return {
          algorithm: existing.algorithm || 'RS256',
          publicKey: existing.publicKey,
          privateKey: this.unprotectSecret(existing.privateKey)
        };
      } catch (error) {
      }
    }

    const pair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    writeJson(this.deviceKeyPath(), {
      algorithm: 'RS256',
      publicKey: pair.publicKey,
      privateKey: this.protectSecret(pair.privateKey),
      createdAt: new Date().toISOString()
    });
    return { algorithm: 'RS256', publicKey: pair.publicKey, privateKey: pair.privateKey };
  }

  signPayload(payload, privateKey) {
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(stableJson(payload));
    signer.end();
    return base64Url(signer.sign(privateKey));
  }

  signedRequest(type, extra = {}) {
    const identity = this.deviceIdentity();
    const keys = this.ensureDeviceKeyPair();
    const payload = {
      ...extra,
      requestType: type,
      requestId: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
      appId: this.appId(),
      appVersion: this.appVersion(),
      productName: this.productName(),
      device: {
        id: identity.fingerprintHash,
        fingerprintHash: identity.fingerprintHash,
        fingerprintVersion: identity.fingerprintVersion,
        name: identity.deviceName,
        platform: identity.platform,
        arch: identity.arch
      },
      devicePublicKey: keys.publicKey
    };
    return {
      algorithm: 'RS256',
      canonical: 'stable-json-v1',
      payload,
      signature: this.signPayload(payload, keys.privateKey)
    };
  }

  endpoint(pathEnvName, fallbackPath) {
    const base = this.serverBaseUrl();
    if (!base) return '';
    const endpointPath = clean(process.env[pathEnvName]) || fallbackPath;
    return new URL(endpointPath, `${base}/`).toString();
  }

  postJson(url, body, headers = {}) {
    return new Promise((resolve, reject) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch (error) {
        reject(new Error('License server URL is invalid'));
        return;
      }

      const payload = JSON.stringify(body || {});
      const client = parsed.protocol === 'https:' ? https : http;
      const request = client.request({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        timeout: Number(process.env.DAKSH_LICENSE_HTTP_TIMEOUT_MS || 15000),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent': `${this.appId()}/${this.appVersion()}`,
          ...headers
        }
      }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => {
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch (error) {
            reject(new Error('License server returned invalid JSON'));
            return;
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const error = new Error((data && data.message) || `License server rejected request (${response.statusCode})`);
            error.statusCode = response.statusCode;
            error.code = data && data.code;
            reject(error);
            return;
          }
          resolve(data || {});
        });
      });
      request.on('timeout', () => request.destroy(new Error('License server request timed out')));
      request.on('error', reject);
      request.write(payload);
      request.end();
    });
  }

  extractToken(response) {
    return firstText(
      response && response.activationToken,
      response && response.licenseToken,
      response && response.token,
      response && response.data && response.data.activationToken,
      response && response.data && response.data.licenseToken
    );
  }

  readStoredToken() {
    const record = readJson(this.tokenPath());
    if (!record) return '';
    return this.unprotectSecret(record.token || record);
  }

  writeStoredToken(token) {
    writeJson(this.tokenPath(), {
      token: this.protectSecret(token),
      savedAt: new Date().toISOString()
    });
    this.statusCache = null;
  }

  clearStoredToken() {
    try {
      fs.unlinkSync(this.tokenPath());
    } catch (error) {
    }
    this.statusCache = null;
  }

  parseToken(token) {
    const parts = clean(token).split('.');
    if (parts.length !== 3) throw new Error('Activation token is not a valid signed token');
    const header = JSON.parse(fromBase64Url(parts[0]).toString('utf8'));
    const payload = JSON.parse(fromBase64Url(parts[1]).toString('utf8'));
    return {
      header,
      payload,
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: fromBase64Url(parts[2])
    };
  }

  verifySignature(parsed) {
    const publicKey = this.publicKey();
    if (!publicKey) throw new Error('License public key is not configured');
    const alg = clean(parsed.header.alg);
    if (alg === 'RS256') {
      return crypto.verify('RSA-SHA256', Buffer.from(parsed.signingInput), publicKey, parsed.signature);
    }
    if (alg === 'PS256') {
      return crypto.verify('RSA-SHA256', Buffer.from(parsed.signingInput), {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32
      }, parsed.signature);
    }
    throw new Error(`Unsupported license token algorithm: ${alg || 'none'}`);
  }

  verifyToken(token) {
    const parsed = this.parseToken(token);
    if (!this.verifySignature(parsed)) throw new Error('Activation token signature is invalid');

    const payload = parsed.payload || {};
    const now = Date.now();
    const tokenAppId = firstText(payload.appId, payload.applicationId);
    if (tokenAppId && tokenAppId !== this.appId()) throw new Error('Activation token belongs to another application');
    const licenseId = firstText(payload.licenseId, payload.license, payload.sub);
    if (!licenseId) throw new Error('Activation token has no license identifier');
    if (payload.status && !['active', 'grace'].includes(String(payload.status).toLowerCase())) throw new Error('License activation is not active');
    const standardExp = parseDateMs(payload.exp);
    const tokenExpiresAt = parseDateMs(payload.tokenExpiresAt || payload.validUntil || payload.offlineUntil || payload.graceUntil);
    const licenseExpiresAt = parseDateMs(payload.licenseExpiresAt || payload.expiresAt);
    const graceUntil = parseDateMs(payload.graceUntil || payload.offlineUntil);
    if (standardExp && standardExp <= now) throw new Error('Activation token has expired');
    if (licenseExpiresAt && licenseExpiresAt <= now) throw new Error('License has expired');
    const inGrace = Boolean(tokenExpiresAt && tokenExpiresAt <= now && graceUntil && graceUntil > now);
    if (tokenExpiresAt && tokenExpiresAt <= now && !inGrace) throw new Error('Activation token must be revalidated');
    if (payload.revoked === true || payload.status === 'revoked' || payload.status === 'blocked') {
      throw new Error('License activation is blocked');
    }

    const expectedDevice = this.deviceIdentity().fingerprintHash;
    const tokenDevice = firstText(
      payload.deviceFingerprintHash,
      payload.deviceFingerprint,
      payload.deviceId,
      payload.machineIdHash,
      payload.device && payload.device.fingerprintHash,
      payload.device && payload.device.id
    );
    if (!tokenDevice && !envBool('DAKSH_LICENSE_ALLOW_UNBOUND_TOKENS', false)) {
      throw new Error('Activation token is not bound to this device');
    }
    if (tokenDevice && tokenDevice !== expectedDevice) {
      throw new Error('Activation token belongs to a different PC');
    }

    return {
      token,
      payload,
      licenseId,
      licenseKey: '',
      activationId: firstText(payload.activationId, payload.jti),
      customerName: firstText(payload.customerName, payload.customer, payload.accountName),
      licenseExpiresAt: licenseExpiresAt ? new Date(licenseExpiresAt).toISOString() : '',
      tokenExpiresAt: (tokenExpiresAt || standardExp) ? new Date(tokenExpiresAt || standardExp).toISOString() : '',
      graceUntil: graceUntil ? new Date(graceUntil).toISOString() : '',
      isInGrace: inGrace,
      deviceId: expectedDevice
    };
  }

  publicStatus(status, options = {}) {
    const includeDevice = options.includeDevice !== false;
    const payload = status.payload || {};
    return {
      required: Boolean(status.required),
      runAllowed: Boolean(status.runAllowed),
      activated: Boolean(status.activated),
      status: status.status,
      message: status.message,
      serverConfigured: Boolean(status.serverConfigured),
      publicKeyConfigured: Boolean(status.publicKeyConfigured),
      licenseKey: maskLicenseKey(status.licenseKey),
      activationId: status.activationId || payload.leaseId || '',
      customerName: status.customerName || '',
      licenseExpiresAt: status.licenseExpiresAt || '',
      tokenExpiresAt: status.tokenExpiresAt || '',
      graceUntil: status.graceUntil || '',
      grace: Boolean(status.isInGrace),
      maxDevices: payload.maxDevices || payload.allowedActivations || payload.maxActivations || null,
      deviceId: includeDevice ? (status.deviceId || this.deviceIdentity().fingerprintHash) : '',
      appId: this.appId(),
      appVersion: this.appVersion()
    };
  }

  async currentStatus(options = {}) {
    const now = Date.now();
    if (!options.force && this.statusCache && now - this.statusCache.at < STATUS_CACHE_MS) {
      return this.statusCache.status;
    }

    const required = this.isRequired();
    const serverConfigured = Boolean(this.serverBaseUrl());
    const publicKeyConfigured = Boolean(this.publicKey());
    let status;
    let token = '';
    let tokenReadError = null;
    try {
      token = this.readStoredToken();
    } catch (error) {
      tokenReadError = error;
    }

    if (tokenReadError) {
      status = {
        required,
        runAllowed: !required,
        activated: false,
        status: 'invalid',
        message: tokenReadError.message || 'Local activation token could not be read',
        serverConfigured,
        publicKeyConfigured,
        deviceId: this.deviceIdentity().fingerprintHash
      };
    } else if (!token) {
      status = {
        required,
        runAllowed: !required,
        activated: false,
        status: required ? 'activation_required' : 'not_required',
        message: required ? 'Activation required for this PC.' : 'Licensing is not required in this environment.',
        serverConfigured,
        publicKeyConfigured,
        deviceId: this.deviceIdentity().fingerprintHash
      };
    } else {
      try {
        const verified = this.verifyToken(token);
        status = {
          ...verified,
          required,
          runAllowed: true,
          activated: true,
          status: verified.isInGrace ? 'grace' : 'active',
          message: verified.isInGrace ? 'Activation server revalidation is due; offline grace is active.' : 'Activated.',
          serverConfigured,
          publicKeyConfigured
        };
      } catch (error) {
        status = {
          required,
          runAllowed: !required,
          activated: false,
          status: 'invalid',
          message: error.message,
          serverConfigured,
          publicKeyConfigured,
          deviceId: this.deviceIdentity().fingerprintHash
        };
      }
    }

    this.statusCache = { at: now, status };
    return status;
  }

  async activate(licenseKey, details = {}) {
    const key = clean(licenseKey).toUpperCase();
    if (!key) throw new Error('License key is required');
    if (!isPlausibleLicenseKey(key)) throw new Error('License key format is invalid');
    if (!this.serverBaseUrl()) throw new Error('License server URL is not configured');
    if (!this.publicKey()) throw new Error('License public key is not configured');

    const body = this.signedRequest('activate', {
      licenseKey: key,
      activationName: clean(details.activationName || details.name)
    });
    const response = await this.postJson(this.endpoint('DAKSH_LICENSE_ACTIVATE_PATH', '/api/licenses/activate'), body);
    const token = this.extractToken(response);
    if (!token) throw new Error('License server did not return an activation token');
    this.verifyToken(token);
    this.writeStoredToken(token);
    return this.publicStatus(await this.currentStatus({ force: true }));
  }

  async revalidate() {
    const token = this.readStoredToken();
    if (!token) throw new Error('No local activation token found');
    if (!this.serverBaseUrl()) throw new Error('License server URL is not configured');
    if (!this.publicKey()) throw new Error('License public key is not configured');

    const body = this.signedRequest('revalidate', { activationToken: token });
    let response;
    try {
      response = await this.postJson(
        this.endpoint('DAKSH_LICENSE_REVALIDATE_PATH', '/api/licenses/revalidate'),
        body,
        { Authorization: `Bearer ${token}` }
      );
    } catch (error) {
      if ([401, 403, 409].includes(Number(error.statusCode))) this.clearStoredToken();
      throw error;
    }
    const nextToken = this.extractToken(response);
    if (nextToken) {
      this.verifyToken(nextToken);
      this.writeStoredToken(nextToken);
    }
    return this.publicStatus(await this.currentStatus({ force: true }));
  }

  async deactivate(options = {}) {
    const token = this.readStoredToken();
    if (!token) {
      this.clearStoredToken();
      return this.publicStatus(await this.currentStatus({ force: true }));
    }

    if (!options.forceLocal && this.serverBaseUrl()) {
      const body = this.signedRequest('deactivate', { activationToken: token });
      await this.postJson(
        this.endpoint('DAKSH_LICENSE_DEACTIVATE_PATH', '/api/licenses/deactivate'),
        body,
        { Authorization: `Bearer ${token}` }
      );
    }
    this.clearStoredToken();
    return this.publicStatus(await this.currentStatus({ force: true }));
  }

  middleware() {
    return async (req, res, next) => {
      try {
        if (!this.isRequired()) return next();
        const status = await this.currentStatus();
        if (status.runAllowed) return next();
        return res.status(402).json({
          success: false,
          code: 'LICENSE_REQUIRED',
          message: status.message || 'Activation required for this PC.',
          license: this.publicStatus(status, { includeDevice: false })
        });
      } catch (error) {
        return res.status(503).json({
          success: false,
          code: 'LICENSE_CHECK_FAILED',
          message: error.message || 'License check failed'
        });
      }
    };
  }

  async assertSocketAllowed(socket) {
    if (!this.isRequired()) return true;
    const status = await this.currentStatus();
    if (status.runAllowed) return true;
    socket.emit('license:required', this.publicStatus(status, { includeDevice: false }));
    socket.disconnect(true);
    return false;
  }

  startPeriodicRevalidation() {
    if (this.periodicTimer || !this.isRequired() || !this.serverBaseUrl()) return;
    const hours = Math.max(1, Number(process.env.DAKSH_LICENSE_REVALIDATE_HOURS || 24));
    const intervalMs = hours * 60 * 60 * 1000;
    const run = () => {
      this.currentStatus({ force: true })
        .then((status) => {
          if (status.activated) return this.revalidate();
          return null;
        })
        .catch((error) => {
          console.warn(`License revalidation failed: ${error.message}`);
        });
    };
    this.periodicTimer = setInterval(run, intervalMs);
    this.periodicTimer.unref?.();
    const initial = setTimeout(run, Math.min(intervalMs, 60 * 1000));
    initial.unref?.();
  }
}

const service = new LicenseService();

module.exports = service;
module.exports.LicenseService = LicenseService;
module.exports.isLocalRequest = isLocalRequest;
