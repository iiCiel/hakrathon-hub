'use strict';
const crypto = require('node:crypto');
const { HttpError } = require('./auth');

// Express async wrapper: thrown errors become JSON responses.
const wrap = (fn) => (req, res, next) => {
  Promise.resolve().then(() => fn(req, res, next)).then((out) => {
    if (out !== undefined && !res.headersSent) res.json(out);
  }).catch(next);
};

function str(v, { max = 500, required = false, name = 'Field' } = {}) {
  const s = (v === undefined || v === null) ? '' : String(v).replace(/\r\n/g, '\n').trim();
  if (required && !s) throw new HttpError(400, `${name} is required.`);
  if (s.length > max) throw new HttpError(400, `${name} is too long (${max} characters max).`);
  return s;
}
function int(v, { min = -Infinity, max = Infinity, name = 'Value', nullable = false } = {}) {
  if ((v === null || v === undefined || v === '') && nullable) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} must be a whole number from ${min} to ${max}.`);
  return n;
}
function url(v, { name = 'Link', required = false } = {}) {
  const s = str(v, { max: 600, name, required });
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch { throw new HttpError(400, `${name} must be a full link starting with https://`); }
  if (!['https:', 'http:'].includes(u.protocol)) throw new HttpError(400, `${name} must start with https://`);
  return u.toString();
}
const now = () => new Date().toISOString();
const code = (len = 8) => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
};

// Socket.IO handle, set by index.js; lets routes push realtime updates.
const bus = { io: null, emit(room, ev, data) { if (this.io) this.io.to(room).emit(ev, data); } };

module.exports = { wrap, str, int, url, now, code, bus, HttpError };
