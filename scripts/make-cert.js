'use strict';
// Makes a key plus either a self-signed certificate (for testing, or the fallback if UA IT cannot issue
// one) or a certificate request (CSR) to hand to whoever issues certificates. Needs openssl.
//
//   node scripts/make-cert.js                                     self-signed for localhost, in certs\
//   node scripts/make-cert.js --host my.server --host 10.0.0.5    self-signed for those names/addresses
//   node scripts/make-cert.js --csr --host hub.example.edu        key + request, no certificate
//
// Options: --out <folder> (default certs), --days <n> (default 30), --force (replace existing files).
// The private key must never be committed or shared: certs\, *.key and *.pem are git-ignored.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { execFileSync } = require('node:child_process');

const args = process.argv.slice(2);
const hosts = [];
let out = path.join(__dirname, '..', 'certs'), days = 30, force = false, csr = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--host') hosts.push(args[++i]);
  else if (a === '--out') out = path.resolve(args[++i]);
  else if (a === '--days') days = Number(args[++i]);
  else if (a === '--force') force = true;
  else if (a === '--csr') csr = true;
  else { console.error(`Unknown option: ${a}`); process.exit(2); }
}
if (csr && !hosts.length) { console.error('--csr needs at least one --host (the name the certificate is for).'); process.exit(2); }
if (!hosts.length) hosts.push('localhost', '127.0.0.1');
if (!hosts.every((h) => /^[A-Za-z0-9.:*-]+$/.test(h || ''))) { console.error('Each --host must be a plain hostname or IP address.'); process.exit(2); }
if (!(days > 0)) { console.error('--days must be a positive number.'); process.exit(2); }

// openssl comes with Linux and with Git for Windows, whose folder is not always on PATH.
function findOpenssl() {
  const places = ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe'];
  for (const p of places) { try { execFileSync(p, ['version'], { stdio: 'ignore' }); return p; } catch {} }
  console.error('openssl was not found. Install it (it comes with Git for Windows), then run this again.');
  process.exit(3);
}

const keyFile = path.join(out, 'privkey.pem');
const certFile = path.join(out, csr ? 'request.csr' : 'fullchain.pem');
const openssl = findOpenssl();
fs.mkdirSync(out, { recursive: true });
if (!force && (fs.existsSync(keyFile) || fs.existsSync(certFile))) {
  console.error(`${keyFile} already exists. Use --force to replace it (a replaced key makes any certificate issued for it useless).`);
  process.exit(4);
}
const san = hosts.map((h) => `${net.isIP(h) ? 'IP' : 'DNS'}:${h}`).join(',');
execFileSync(openssl, [
  'req', ...(csr ? ['-new'] : ['-x509', '-days', String(days)]),
  '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', keyFile, '-out', certFile,
  '-subj', `/CN=${hosts[0]}`, '-addext', `subjectAltName=${san}`,
], { stdio: ['ignore', 'ignore', 'pipe'] });
try { fs.chmodSync(keyFile, 0o600); } catch {}

console.log(`Key:         ${keyFile}  (keep private)`);
if (csr) console.log(`Request:     ${certFile}  (send this to whoever issues the certificate)\nFor:         ${san}`);
else {
  console.log(`Certificate: ${certFile}  (self-signed, ${days} days, browsers will warn)\nFor:         ${san}`);
  console.log(`\nStart with:  TLS_CERT=${certFile}  TLS_KEY=${keyFile}`);
}
