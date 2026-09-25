const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const ignored = new Set(['node_modules', '.git', 'logs', 'Audit Data', 'mobile_scanner_app', '_local_backups', 'local-data', 'DAKSH-DEPLOYMENT', 'installer', 'release', '.codex-artifacts']);
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    if (entry.name.startsWith('.chrome-check-profile')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) files.push(fullPath);
  }
}

walk(root);

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

process.stdout.write(`Build check passed (${files.length} JavaScript files).\n`);
