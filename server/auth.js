'use strict';
const crypto = require('node:crypto');
const { get, run } = require('./db');

const SESSION_DAYS = 3;
const COOKIE = 'hak_sid';

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, s, h] = stored.split('$');
  const expected = Buffer.from(h, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(s, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, got);
}
// Used when the email doesn't exist, so login time doesn't reveal which emails are registered.
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)',
    sha256(token), userId, now, now + SESSION_DAYS * 86400000);
  return token;
}
function destroySession(token) { if (token) run('DELETE FROM sessions WHERE token_hash = ?', sha256(token)); }
function destroyUserSessions(userId) { run('DELETE FROM sessions WHERE user_id = ?', userId); }

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

function userFromToken(token) {
  if (!token) return null;
  const s = get('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?', sha256(token));
  if (!s) return null;
  if (s.expires_at < Date.now()) { destroySession(token); return null; }
  const u = get('SELECT * FROM users WHERE id = ?', s.user_id);
  if (!u || u.disabled) return null;
  return u;
}

function setSessionCookie(req, res, token) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.append('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}
function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function attachUser(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  req.sessionToken = token;
  req.user = userFromToken(token);
  next();
}

// Minimal in-memory rate limiter keyed by an arbitrary string.
const buckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count++;
  return b.count <= limit;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60000).unref();

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

const STAFF = ['admin', 'judge', 'mentor'];
function requireUser(req) { if (!req.user) throw new HttpError(401, 'Please sign in.'); return req.user; }
function requireRole(req, ...roles) {
  const u = requireUser(req);
  if (!roles.includes(u.role)) throw new HttpError(403, 'You do not have access to this.');
  return u;
}
const isStaff = (u) => !!u && STAFF.includes(u.role);

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, email: u.email, name: u.name, role: u.role, team_id: u.team_id,
    github_login: u.github_login || '', major: u.major, class_level: u.class_level,
    skills: u.skills, preferred_role: u.preferred_role, agreed_rules: !!u.agreed_rules,
    checked_in: !!u.checked_in,
  };
}

module.exports = {
  COOKIE, hashPassword, verifyPassword, DUMMY_HASH, createSession, destroySession, destroyUserSessions,
  parseCookies, userFromToken, setSessionCookie, clearSessionCookie, attachUser, rateLimit,
  HttpError, requireUser, requireRole, isStaff, publicUser, sha256,
};
