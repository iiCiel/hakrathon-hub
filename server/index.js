'use strict';
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');

// Load .env (KEY=VALUE lines) without a dependency.
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const express = require('express');
const { Server } = require('socket.io');
const { get, run, DATA_DIR } = require('./db');
const A = require('./auth');
const S = require('./settings');
const { bus, code, HttpError } = require('./util');
const { canRead } = require('./routes/workspace');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback'); // ngrok / local reverse proxy

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: https:",
    "media-src 'self' blob:", "font-src 'self' data:", "connect-src 'self'", "worker-src 'self' blob:",
    "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'", "form-action 'self'",
  ].join('; '));
  next();
});

app.use(express.json({ limit: '3mb' }));
app.use(A.attachUser);

// CSRF: every state-changing API call must carry a custom header, which browsers
// won't send cross-site without a CORS preflight we never approve.
app.use('/api', (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Hak') !== '1') return next(new HttpError(403, 'Missing request header.'));
  next();
});

app.use('/api', require('./routes/core').router);
app.use('/api', require('./routes/chat').router);
app.use('/api', require('./routes/workspace').router);
app.use('/api', require('./routes/submit').router);
app.use('/api', require('./routes/judge').router);
app.use('/api', require('./routes/admin').router);
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found.')));

// Gzip the front end (the code editor alone is ~4 MB): matters over ngrok and busy Wi-Fi.
app.use(require('compression')({ threshold: 1024 }));
const nm = path.join(__dirname, '..', 'node_modules');
const staticOpts = { maxAge: '7d', immutable: false, fallthrough: true };
app.use('/vendor/monaco', express.static(path.join(nm, 'monaco-editor', 'min'), staticOpts));
app.use('/vendor/hljs', express.static(path.join(nm, '@highlightjs', 'cdn-assets'), staticOpts));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: 0, etag: true }));

app.use((err, req, res, _next) => {
  let status = err.status || err.statusCode || 500;
  if (err.type === 'entity.parse.failed') status = 400;
  if (err.type === 'entity.too.large') status = 413;
  if (status >= 500) console.error('[error]', req.method, req.originalUrl, err);
  const message = status >= 500 ? 'Something went wrong on the server. Try again.' : (err.type === 'entity.too.large' ? 'Request is too large.' : err.message);
  if (req.originalUrl.startsWith('/api')) return res.status(status).json({ error: message });
  res.status(status).send(message);
});

// ---------- realtime ----------
const server = http.createServer(app);
// Node cuts off any request still running after 5 minutes by default. A 300–500 MB demo video over
// busy Wi-Fi or ngrok can take longer than that, so uploads get an hour; headers must still arrive fast.
server.requestTimeout = 60 * 60 * 1000;
server.headersTimeout = 60 * 1000;
server.timeout = 120 * 1000; // but a connection that goes quiet for 2 minutes is dropped
// WebSocket upgrades ignore CORS, so check Origin ourselves: only pages served by this portal may connect.
const io = new Server(server, {
  serveClient: true, maxHttpBufferSize: 1e5, cors: { origin: false },
  allowRequest: (req, cb) => {
    const origin = req.headers.origin;
    if (!origin) return cb(null, true); // same-origin polling from older browsers, curl
    let host = '';
    try { host = new URL(origin).host.toLowerCase(); } catch {}
    const pub = process.env.PUBLIC_URL ? (() => { try { return new URL(process.env.PUBLIC_URL).host.toLowerCase(); } catch { return ''; } })() : '';
    const ok = host && (host === String(req.headers.host || '').toLowerCase() || host === pub || host === String(req.headers['x-forwarded-host'] || '').toLowerCase());
    cb(null, !!ok);
  },
});
bus.io = io;

function roomsFor(u) {
  const rooms = ['all', `user:${u.id}`];
  if (u.team_id) rooms.push(`team:${u.team_id}`);
  if (A.isStaff(u)) rooms.push('staff');
  if (u.role === 'admin' || u.role === 'mentor') rooms.push('helpdesk');
  if (u.role === 'admin') rooms.push('admins');
  return rooms;
}
io.use((socket, next) => {
  const token = A.parseCookies(socket.handshake.headers.cookie)[A.COOKIE];
  const u = A.userFromToken(token);
  if (!u) return next(new Error('unauthorized'));
  socket.data.userId = u.id;
  socket.data.token = token;
  next();
});
io.on('connection', (socket) => {
  const u = get('SELECT * FROM users WHERE id = ?', socket.data.userId);
  if (!u) return socket.disconnect(true);
  for (const r of roomsFor(u)) socket.join(r);
  // Lightweight "who is looking at which file" presence for the team workspace.
  socket.on('presence', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    const me = get('SELECT * FROM users WHERE id = ?', socket.data.userId);
    const t = me && get('SELECT * FROM teams WHERE id = ?', Number(msg.teamId));
    if (!t || !canRead(me, t)) return;
    const p = typeof msg.path === 'string' ? msg.path.slice(0, 200) : '';
    io.to([`team:${t.id}`, 'helpdesk']).emit('presence', { teamId: t.id, user: { id: me.id, name: me.name }, path: p, at: Date.now() });
  });
});
bus.disconnectToken = async (token) => {
  for (const s of await io.fetchSockets()) if (s.data.token && s.data.token === token) s.disconnect(true);
};
bus.disconnectUser = async (userId) => {
  for (const s of await io.in(`user:${userId}`).fetchSockets()) s.disconnect(true);
};
// Sockets are authenticated at connect; re-check every minute so ended/expired sessions lose live updates.
setInterval(async () => {
  for (const s of await io.fetchSockets()) {
    const u = A.userFromToken(s.data.token);
    if (!u || u.id !== s.data.userId) s.disconnect(true);
  }
}, 60000).unref();
bus.syncUser = async (userId) => {
  const u = get('SELECT * FROM users WHERE id = ?', userId);
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  for (const s of sockets) {
    if (!u || u.disabled) { s.disconnect(true); continue; }
    for (const r of s.rooms) if (r !== s.id && !r.startsWith('user:')) s.leave(r);
    for (const r of roomsFor(u)) s.join(r);
    s.emit('me:update', {});
  }
};

// ---------- first-run admin access code ----------
const SETUP_FILE = path.join(DATA_DIR, 'ADMIN-SETUP.txt');
function bootstrapAdmin() {
  if (get("SELECT id FROM users WHERE role = 'admin'")) { fs.rm(SETUP_FILE, { force: true }, () => {}); return; }
  let inv = get("SELECT code FROM invites WHERE role = 'admin' AND revoked = 0 AND uses < max_uses");
  if (!inv) {
    const c = `ADMIN-${code(8)}`;
    run("INSERT INTO invites (code, role, max_uses, note) VALUES (?, 'admin', 1, 'First-run admin code')", c);
    inv = { code: c };
  }
  fs.writeFileSync(SETUP_FILE, `Register the first admin account with this access code:\n\n  ${inv.code}\n\nDelete this file afterwards.\n`);
  console.log(`\n  First run: register your admin account with access code  ${inv.code}\n  (also saved in data/ADMIN-SETUP.txt)\n`);
}

// ---------- background jobs ----------
const { freezeSweep, pinSweep } = require('./routes/submit');
let pinBusy = false;
setInterval(async () => {
  if (pinBusy) return;
  pinBusy = true;
  try { await pinSweep(); } catch (e) { console.error('[pin]', e); } finally { pinBusy = false; }
}, 2000).unref();
let sweeping = false;
setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try { await freezeSweep(); } catch (e) { console.error('[freeze]', e); } finally { sweeping = false; }
}, 15000).unref();
setInterval(() => run('DELETE FROM sessions WHERE expires_at < ?', Date.now()), 3600000).unref();

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
if (require.main === module) {
  bootstrapAdmin();
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\n  Port ${PORT} is already in use. Is another copy of the portal (or the DEMO) still running?\n  Close that window, then start this again.\n`);
      process.exit(1);
    }
    throw e;
  });
  server.listen(PORT, HOST, () => {
    const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    console.log(`  ${S.getSettings().event_name} portal is running`);
    console.log(`    This computer:  http://localhost:${PORT}`);
    for (const ip of lan) console.log(`    Same Wi-Fi:     http://${ip}:${PORT}`);
    console.log(`    Code runner:    ${process.env.RUNNER || 'docker'} mode (status shown in Admin > Overview)\n`);
  });
}

module.exports = { app, server, io, bootstrapAdmin };

