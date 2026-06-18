const { spawn } = require('child_process');
const path = require('path');

const role = String(process.env.DAKSH_SERVICE_ROLE || process.env.SERVICE_ROLE || 'api').trim().toLowerCase();
const entry = role === 'web' ? 'web-server.js' : 'server.js';
const entryPath = role === 'web' ? path.join(__dirname, entry) : path.join(__dirname, '..', entry);

const child = spawn(process.execPath, [entryPath], {
  stdio: 'inherit',
  env: process.env
});

function forward(signal) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

forward('SIGINT');
forward('SIGTERM');

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code || 0);
});
