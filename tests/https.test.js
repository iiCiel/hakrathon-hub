'use strict';
// HTTPS mode: the portal's own TLS, the port 80 redirect, Secure cookies and live updates over wss.
// Starts real servers on throwaway data folders. Skipped if openssl isn't available.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const { spawn, spawnSync } = require('node:child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hak-https-'));
const CERTS = path.join(TMP, 'certs');
const MAKE = path.join(ROOT, 'scripts', 'make-cert.js');
const made = spawnSync(process.execPath, [MAKE, '--out', CERTS], { encoding: 'utf8' });
const skip = made.status === 3 ? 'openssl not available' : false;
const CERT = path.join(CERTS, 'fullchain.pem'), KEY = path.join(CERTS, 'privkey.pem');
const ca = () => fs.readFileSync(CERT);

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kids = [];
function start(script, env) {
  const log = [];
  const kid = spawn(process.execPath, [path.join(ROOT, script)], { cwd: ROOT, env: { ...process.env, RUNNER: 'off', HOST: '127.0.0.1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const s of [kid.stdout, kid.stderr]) s.on('data', (d) => log.push(String(d)));
  kids.push(kid);
  return { kid, log };
}
// Certificate checks stay ON (only our test certificate is trusted), so a bad setup fails here.
function req(lib, port, method, url, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = lib.request({ host: '127.0.0.1', port, method, path: url, ...(lib === https ? { ca: ca() } : {}), headers: { 'X-Hak': '1', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      let data = ''; res.on('data', (d) => { data += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data }));
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
async function waitUp(lib, port) {
  for (let i = 0; i < 300; i++) { try { const r = await req(lib, port, 'GET', '/api/event'); if (r.status === 200) return; } catch {} await sleep(100); }
  throw new Error('server did not start');
}
const exited = (kid) => new Promise((r) => kid.on('exit', (c) => r(c)));

test.after(() => {
  for (const k of kids) { try { k.kill(); } catch {} }
  setTimeout(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(0); }, 300).unref();
});

test('HTTPS: login cookie, wss live updates, port 80 redirect, TLS versions', { skip }, async () => {
  const port = await freePort(), redirectPort = await freePort();
  const data = path.join(TMP, 'data');
  start('server/index.js', { DATA_DIR: data, PORT: String(port), TLS_CERT: CERT, TLS_KEY: KEY, HTTP_REDIRECT_PORT: String(redirectPort), TRUST_PROXY: '' });
  await waitUp(https, port);

  const code = /ADMIN-[A-Z0-9]+/.exec(fs.readFileSync(path.join(data, 'ADMIN-SETUP.txt'), 'utf8'))[0];
  const reg = await req(https, port, 'POST', '/api/auth/register', { body: { invite: code, email: 'lead@uakron.edu', name: 'Lead', password: 'password123', agree: true } });
  assert.ok(reg.status < 300, reg.data);
  const setCookie = reg.headers['set-cookie'].find((c) => c.startsWith('hak_sid='));
  assert.match(setCookie, /; HttpOnly/);
  assert.match(setCookie, /; Secure/, 'session cookie must be Secure over HTTPS');
  const cookie = setCookie.split(';')[0];

  // Live updates: a real WebSocket over TLS gets a chat message.
  const events = [];
  const origin = `https://127.0.0.1:${port}`;
  const ws = new WebSocket(`wss://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`, { ca: ca(), headers: { Cookie: cookie, Origin: origin } });
  await new Promise((resolve, reject) => {
    ws.on('message', (b) => { const m = b.toString(); if (m[0] === '0') ws.send('40'); else if (m.startsWith('40')) resolve(); else if (m.startsWith('42')) events.push(JSON.parse(m.slice(2))); else if (m.startsWith('44')) reject(new Error(m)); });
    ws.on('error', reject);
  });
  const posted = await req(https, port, 'POST', '/api/chat/announcements', { body: { body: 'over wss' }, headers: { Cookie: cookie } });
  assert.ok(posted.status < 300, posted.data);
  for (let i = 0; i < 50 && !events.some((e) => e[0] === 'chat:message'); i++) await sleep(50);
  assert.ok(events.some((e) => e[0] === 'chat:message' && e[1].body === 'over wss'), 'chat message arrives over wss');
  ws.close();

  // Foreign pages still can't open the socket.
  assert.equal((await req(https, port, 'GET', '/socket.io/?EIO=4&transport=polling', { headers: { Origin: 'https://evil.example' } })).status, 403);

  // Admin > Rehearsal lists https addresses with the right port.
  const reh = JSON.parse((await req(https, port, 'GET', '/api/admin/rehearsal', { headers: { Cookie: cookie } })).data);
  for (const u of reh.lan) assert.match(u, new RegExp(`^https://[^/]+:${port}$`));

  // Port 80 only ever redirects: it serves no pages or API, and never sets a cookie.
  const g = await req(http, redirectPort, 'GET', '/some/page?x=1');
  assert.equal(g.status, 301);
  assert.equal(g.headers.location, `https://127.0.0.1:${port}/some/page?x=1`);
  const p = await req(http, redirectPort, 'POST', '/api/auth/login', { body: { email: 'lead@uakron.edu', password: 'password123' } });
  assert.equal(p.status, 308);
  assert.equal(p.headers['set-cookie'], undefined);
  const bad = await req(http, redirectPort, 'GET', '/', { headers: { Host: 'evil"><script>' } });
  assert.equal(bad.status, 400, 'a junk Host header is refused');

  // Old TLS is refused, TLS 1.2 works.
  const old = await new Promise((resolve) => {
    const s = tls.connect({ host: '127.0.0.1', port, ca: ca(), minVersion: 'TLSv1', maxVersion: 'TLSv1.1', ciphers: 'DEFAULT@SECLEVEL=0' }, () => { s.destroy(); resolve('connected'); });
    s.on('error', () => resolve('refused'));
  });
  assert.equal(old, 'refused');
  const cur = await new Promise((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port, ca: ca(), minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' }, () => { const v = s.getProtocol(); s.destroy(); resolve(v); });
    s.on('error', reject);
  });
  assert.equal(cur, 'TLSv1.2');
});

test('HTTPS: with PUBLIC_URL set, the redirect always goes to that hostname', { skip }, async () => {
  const port = await freePort(), redirectPort = await freePort();
  start('server/index.js', { DATA_DIR: path.join(TMP, 'data-pub'), PORT: String(port), TLS_CERT: CERT, TLS_KEY: KEY, HTTP_REDIRECT_PORT: String(redirectPort), PUBLIC_URL: 'https://hub.example.edu' });
  await waitUp(https, port);
  const r = await req(http, redirectPort, 'GET', '/a?b=1', { headers: { Host: '10.0.0.5' } });
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, 'https://hub.example.edu/a?b=1', 'people typing the IP land on the name the certificate covers');
});

test('HTTPS: a bad certificate setup stops with a clear message', { skip }, async () => {
  const other = path.join(TMP, 'other');
  assert.equal(spawnSync(process.execPath, [MAKE, '--out', other]).status, 0);
  const cases = [
    [{ TLS_CERT: CERT, TLS_KEY: '' }, /both TLS_CERT and TLS_KEY/],
    [{ TLS_CERT: path.join(TMP, 'nope.pem'), TLS_KEY: KEY }, /could not read/i],
    [{ TLS_CERT: CERT, TLS_KEY: path.join(other, 'privkey.pem') }, /do not match/i],
  ];
  for (const [i, [env, msg]] of cases.entries()) {
    const { kid, log } = start('server/index.js', { DATA_DIR: path.join(TMP, `bad${i}`), PORT: String(await freePort()), ...env });
    assert.equal(await exited(kid), 1, `case ${i} must not fall back to plain http`);
    assert.match(log.join(''), msg);
  }
});

test('HTTPS: the demo stays plain http even with TLS settings around', { skip }, async () => {
  const port = await freePort();
  start('scripts/demo.js', { DEMO_DATA_DIR: path.join(TMP, 'data-demo'), DEMO_PORT: String(port), TLS_CERT: CERT, TLS_KEY: KEY });
  await waitUp(http, port);
  const r = await req(http, port, 'POST', '/api/auth/login', { body: { email: 'admin@demo.uakron.edu', password: 'demo-pass-2026' } });
  assert.ok(r.status < 300, r.data);
  assert.doesNotMatch(r.headers['set-cookie'].join(';'), /Secure/, 'plain http cannot use Secure cookies');
});

test('make-cert: refuses to overwrite a key, and makes a request (CSR) for IT', { skip }, () => {
  assert.equal(spawnSync(process.execPath, [MAKE, '--out', CERTS]).status, 4);
  const dir = path.join(TMP, 'csr');
  const r = spawnSync(process.execPath, [MAKE, '--csr', '--host', 'hub.example.edu', '--host', '10.0.0.5', '--out', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(dir, 'request.csr'), 'utf8'), /BEGIN CERTIFICATE REQUEST/);
  assert.match(r.stdout, /DNS:hub\.example\.edu,IP:10\.0\.0\.5/);
});
