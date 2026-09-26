const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class ServerIdentityService {
  constructor({ dataRoot, hostname = 'daksh.local', serviceName = 'daksh-inventory' } = {}) {
    this.dataRoot = path.resolve(dataRoot || process.cwd());
    this.identityPath = process.env.DAKSH_SERVER_ID_PATH
      ? path.resolve(process.env.DAKSH_SERVER_ID_PATH)
      : path.join(this.dataRoot, 'config', 'server-id.txt');
    this.hostname = hostname;
    this.serviceName = serviceName;
    this.cachedId = '';
  }

  getId() {
    if (this.cachedId) return this.cachedId;
    try {
      const existing = fs.readFileSync(this.identityPath, 'utf8').trim();
      if (existing && /^[a-f0-9-]{16,80}$/i.test(existing)) {
        this.cachedId = existing;
        return existing;
      }
    } catch (_) {}

    const generated = crypto.randomUUID();
    try {
      fs.mkdirSync(path.dirname(this.identityPath), { recursive: true });
      const temporary = `${this.identityPath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${generated}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, this.identityPath);
    } catch (_) {
      // A read-only deployment still gets a stable identity for its process.
    }
    this.cachedId = generated;
    return generated;
  }

  get(port) {
    return {
      serverId: this.getId(),
      hostname: this.hostname,
      serviceName: this.serviceName,
      port: Number(port || 0) || 0
    };
  }
}

module.exports = ServerIdentityService;
