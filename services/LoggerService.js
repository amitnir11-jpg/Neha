const fs = require('fs');
const path = require('path');

const SECRET_KEY = /password|secret|token|authorization|cookie|databaseurl|privatekey|pgpassword/i;

function safeValue(value, key = '') {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (Array.isArray(value)) return value.map((item) => safeValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, safeValue(childValue, childKey)]));
  }
  return value;
}

function printable(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(safeValue(value)); } catch (_) { return String(value); }
}

class LoggerService {
  constructor({ dataRoot, maxBytes = 5 * 1024 * 1024, keepFiles = 8 } = {}) {
    this.logDir = path.join(path.resolve(dataRoot || process.cwd()), 'logs');
    this.logPath = path.join(this.logDir, 'application.log');
    this.maxBytes = maxBytes;
    this.keepFiles = keepFiles;
    this.originalConsole = null;
    try { fs.mkdirSync(this.logDir, { recursive: true }); } catch (_) {}
  }

  rotateIfNeeded() {
    try {
      if (!fs.existsSync(this.logPath) || fs.statSync(this.logPath).size < this.maxBytes) return;
      for (let index = this.keepFiles - 1; index >= 1; index -= 1) {
        const from = `${this.logPath}.${index}`;
        const to = `${this.logPath}.${index + 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      fs.renameSync(this.logPath, `${this.logPath}.1`);
    } catch (_) {}
  }

  write(level, message, details = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level: String(level || 'info').toLowerCase(),
      message: String(message || ''),
      details: safeValue(details)
    };
    try {
      this.rotateIfNeeded();
      fs.appendFileSync(this.logPath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (_) {}
    return entry;
  }

  info(message, details) { return this.write('info', message, details); }
  warn(message, details) { return this.write('warn', message, details); }
  error(message, details) { return this.write('error', message, details); }

  installConsoleBridge() {
    if (this.originalConsole) return;
    this.originalConsole = { log: console.log, warn: console.warn, error: console.error };
    ['log', 'warn', 'error'].forEach((method) => {
      const original = this.originalConsole[method];
      console[method] = (...args) => {
        try { original.apply(console, args); } catch (_) {}
        const message = args.map(printable).join(' ');
        this.write(method === 'log' ? 'info' : method, message);
      };
    });
  }

  readRecent(limit = 200) {
    const max = Math.min(1000, Math.max(1, Number(limit) || 200));
    const paths = [];
    for (let index = this.keepFiles; index >= 1; index -= 1) paths.push(`${this.logPath}.${index}`);
    paths.push(this.logPath);
    const entries = [];
    for (const logPath of paths) {
      if (!fs.existsSync(logPath)) continue;
      let lines = [];
      try { lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean); } catch (_) { continue; }
      for (const line of lines) {
        try { entries.push(JSON.parse(line)); } catch (_) { entries.push({ timestamp: '', level: 'info', message: line, details: {} }); }
      }
    }
    return entries.slice(-max).reverse();
  }

  fileInfo() {
    let size = 0;
    try { size = fs.statSync(this.logPath).size; } catch (_) {}
    return { directory: this.logDir, file: this.logPath, sizeBytes: size, rotation: { maxBytes: this.maxBytes, keepFiles: this.keepFiles } };
  }
}

module.exports = LoggerService;
