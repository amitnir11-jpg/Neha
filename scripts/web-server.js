require('dotenv').config();

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const SOCKET_IO_CLIENT = path.resolve(__dirname, '..', 'node_modules', 'socket.io', 'client-dist', 'socket.io.js');

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function sendPublicFile(res, fileName) {
  noStore(res);
  res.sendFile(path.join(PUBLIC_DIR, fileName));
}

app.get('/config.js', (req, res) => {
  const apiBaseUrl = String(process.env.PUBLIC_API_BASE_URL || process.env.API_BASE_URL || '').trim().replace(/\/+$/, '');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  noStore(res);
  res.send(`window.DAKSH_CONFIG=${JSON.stringify({ apiBaseUrl })};`);
});

app.get(['/api/ready', '/api/health'], (req, res) => {
  noStore(res);
  res.json({
    success: true,
    status: 'ready',
    role: 'web',
    serverStatus: 'online',
    apiBaseUrl: String(process.env.PUBLIC_API_BASE_URL || process.env.API_BASE_URL || '').trim().replace(/\/+$/, '')
  });
});

app.get('/socket.io/socket.io.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.sendFile(SOCKET_IO_CLIENT);
});

app.get(['/', '/login'], (req, res) => sendPublicFile(res, 'index.html'));
app.get(['/dashboard', '/dashboard/'], (req, res) => sendPublicFile(res, 'Daksh.html'));
app.get(['/report', '/report/'], (req, res) => sendPublicFile(res, 'report.html'));
app.get(['/scan', '/scan/', '/mobile', '/mobile-scanner', '/mobile-scanner/'], (req, res) => sendPublicFile(res, 'scan.html'));

app.use('/vendor/zxing', express.static(path.join(__dirname, '..', 'node_modules', '@zxing', 'library', 'umd')));
app.use(express.static(PUBLIC_DIR));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Daksh web service listening on ${PORT}`);
});
