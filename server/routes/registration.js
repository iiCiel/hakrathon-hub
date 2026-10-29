'use strict';
// Event registration (weeks before the event) and attendance (the check-in desk on event day).
// The public form needs no account (Event Scope §5). Staff review registrations, confirm spots, and at
// check-in each student gets a personal access code to create their portal account (Scope §7).
// Student status is checked with the Zip card at the desk, so no ID numbers are collected.
const express = require('express');
const { get, all, run, tx, audit } = require('../db');
const A = require('../auth');
const S = require('../settings');
const { wrap, str, code, now, bus, HttpError } = require('../util');
const { emailAllowed } = require('./core');

const r = express.Router();
const STATUSES = ['pending', 'confirmed', 'waitlist', 'declined', 'cancelled'];
const CLASS_LEVELS = ['Freshman', 'Sophomore', 'Junior', 'Senior', 'Graduate'];
const PREF_ROLES = ['Technical builder', 'Problem / business lead', 'Presentation / UX lead', 'Flexible'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const capacity = () => { const s = S.getSettings(); return s.max_teams * s.team_max; };
const admin = (req) => A.requireRole(req, 'admin');
const changed = () => bus.emit('admins', 'staff:update', { kind: 'registration' });
const oneOf = (v, list, name, required = false) => {
  const s = str(v, { max: 80 });
  if (!s && !required) return '';
  if (!list.includes(s)) throw new HttpError(400, `Pick a ${name}.`);
  return s;
};

// ---------- public form ----------
r.get('/registration', wrap(() => {
  const s = S.getSettings();
  return { open: !!s.signup_open, event_name: s.event_name, email_domains: s.participant_email_domains, capacity: capacity(), max_teams: s.max_teams, team_min: s.team_min, team_max: s.team_max,
    lanes: s.lanes.map((l) => ({ id: l.id, name: l.name })), class_levels: CLASS_LEVELS, roles: PREF_ROLES };
}));

r.post('/registration', wrap((req) => {
  // Generous per network (a whole class may register from campus Wi-Fi after an announcement); tight per email.
  if (!A.rateLimit(`signup:${req.ip}`, 300, 60 * 60000) || !A.rateLimit(`signup:${String((req.body || {}).email || '').toLowerCase()}`, 10, 60 * 60000)) {
    throw new HttpError(429, 'Too many registration attempts. Wait a while, or ask event staff.');
  }
  const s = S.getSettings();
  if (!s.signup_open) throw new HttpError(403, 'Registration is closed. Ask event staff about the waitlist.');
  const b = req.body || {};
  const name = str(b.name, { max: 80, required: true, name: 'Full name' });
  const email = str(b.email, { max: 200, required: true, name: 'University email' }).toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (!emailAllowed(email, 'participant')) throw new HttpError(400, `Use your University of Akron email (${s.participant_email_domains}).`);
  const major = str(b.major, { max: 80, required: true, name: 'Major' });
  const classLevel = oneOf(b.class_level, CLASS_LEVELS, 'class level', true);
  const teamMode = b.team_mode === 'team' ? 'team' : 'match';
  const teamName = teamMode === 'team' ? str(b.team_name, { max: 60, required: true, name: 'Team name' }) : '';
  const teammates = teamMode === 'team' ? str(b.teammates, { max: 1000 }) : '';
  const lane = b.lane ? oneOf(b.lane, s.lanes.map((l) => l.id), 'lane') : '';
  const role = oneOf(b.preferred_role, PREF_ROLES, 'preferred role');
  const skills = str(b.skills, { max: 500 });
  const experience = str(b.experience, { max: 1000 });
  const dietary = str(b.dietary, { max: 300 });
  const accommodations = str(b.accommodations, { max: 500 });
  if (!b.agree_rules) throw new HttpError(400, 'Please agree to the event rules and code of conduct.');
  if (!b.agree_disclosure) throw new HttpError(400, 'Please agree to disclose outside code, data, tools and AI help.');
  const id = tx(() => {
    if (get('SELECT id FROM registrations WHERE email = ?', email)) throw new HttpError(409, 'This email is already registered. To change your details, or if you did not register it, contact event staff.');
    const info = run(`INSERT INTO registrations (email, name, major, class_level, team_mode, team_name, teammates, lane, preferred_role, skills, experience,
      technical, dietary, accommodations, media_ok, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    email, name, major, classLevel, teamMode, teamName, teammates, lane, role, skills, experience,
    b.technical ? 1 : 0, dietary, accommodations, b.media_ok ? 1 : 0, now());
    return Number(info.lastInsertRowid);
  });
  audit(null, 'registration.new', { id });
  changed();
  return { ok: true, name, status: 'pending' };
}));

// ---------- staff: registrations ----------
function regRows() {
  return all(`SELECT g.*, u.id AS user_id, u.name AS account_name, t.name AS account_team, t.table_no AS account_table, c.name AS checked_in_by_name,
      i.uses AS code_uses, i.max_uses AS code_max, i.revoked AS code_revoked
    FROM registrations g
    LEFT JOIN users u ON u.email = g.email
    LEFT JOIN teams t ON t.id = u.team_id
    LEFT JOIN users c ON c.id = g.checked_in_by
    LEFT JOIN invites i ON i.code = g.invite_code
    ORDER BY g.id`);
}
function summary(rows) {
  const by = (st) => rows.filter((x) => x.status === st).length;
  const groups = new Map();
  for (const x of rows.filter((y) => y.team_mode === 'team' && y.team_name && !['declined', 'cancelled'].includes(y.status))) {
    const k = x.team_name.trim().toLowerCase();
    if (!groups.has(k)) groups.set(k, { team_name: x.team_name.trim(), members: [], technical: false });
    const g = groups.get(k);
    g.members.push({ id: x.id, name: x.name, status: x.status, checked_in: !!x.checked_in_at });
    g.technical = g.technical || !!x.technical;
  }
  const active = rows.filter((x) => !['declined', 'cancelled'].includes(x.status));
  return {
    total: rows.length, pending: by('pending'), confirmed: by('confirmed'), waitlist: by('waitlist'), declined: by('declined'), cancelled: by('cancelled'),
    capacity: capacity(), checked_in: rows.filter((x) => x.checked_in_at).length, expected: by('confirmed'),
    match: active.filter((x) => x.team_mode === 'match').length,
    dietary: active.filter((x) => x.dietary).map((x) => ({ id: x.id, name: x.name, text: x.dietary })),
    accommodations: active.filter((x) => x.accommodations).map((x) => ({ id: x.id, name: x.name, text: x.accommodations })),
    teams: [...groups.values()].sort((a, c) => a.team_name.localeCompare(c.team_name)),
  };
}
r.get('/admin/registrations', wrap((req) => {
  admin(req);
  const rows = regRows();
  return { registrations: rows, summary: summary(rows), open: !!S.getSettings().signup_open };
}));

function regById(id) {
  const g = get('SELECT * FROM registrations WHERE id = ?', Number(id));
  if (!g) throw new HttpError(404, 'Registration not found.');
  return g;
}
// A personal, single-use participant access code bound to this email (same as Access codes → bulk).
function ensureCode(g) {
  if (get('SELECT id FROM users WHERE email = ?', g.email)) return g.invite_code || ''; // already has an account
  const cur = g.invite_code && get('SELECT * FROM invites WHERE code = ? AND revoked = 0 AND uses < max_uses', g.invite_code);
  if (cur) return cur.code;
  const other = get('SELECT code FROM invites WHERE email = ? AND revoked = 0 AND uses < max_uses', g.email);
  let c = other && other.code;
  if (!c) {
    do { c = `PAR-${code(6)}`; } while (get('SELECT code FROM invites WHERE code = ?', c));
    run('INSERT INTO invites (code, role, max_uses, note, email) VALUES (?,?,1,?,?)', c, 'participant', 'From event registration', g.email);
  }
  run('UPDATE registrations SET invite_code = ? WHERE id = ?', c, g.id);
  return c;
}

// A declined, cancelled or removed registration's access code stops working if nobody used it yet.
function revokeUnused(g) {
  if (g.invite_code) run('UPDATE invites SET revoked = 1 WHERE code = ? AND uses = 0', g.invite_code);
  run('UPDATE registrations SET invite_code = ? WHERE id = ?', '', g.id);
}

r.patch('/admin/registrations/:id', wrap((req) => {
  admin(req);
  const g = regById(req.params.id);
  const b = req.body || {};
  const status = 'status' in b ? String(b.status) : g.status;
  if (!STATUSES.includes(status)) throw new HttpError(400, 'Bad status.');
  const note = 'staff_note' in b ? str(b.staff_note, { max: 500 }) : g.staff_note;
  run('UPDATE registrations SET status = ?, staff_note = ?, updated_at = ? WHERE id = ?', status, note, now(), g.id);
  if (['declined', 'cancelled'].includes(status)) revokeUnused(g);
  audit(req.user.id, 'registration.update', { id: g.id, status });
  changed();
  const conf = get("SELECT COUNT(*) AS c FROM registrations WHERE status = 'confirmed'").c;
  return { ok: true, warning: status === 'confirmed' && conf > capacity() ? `${conf} confirmed: that is over the capacity of ${capacity()}.` : '' };
}));

r.delete('/admin/registrations/:id', wrap((req) => {
  admin(req);
  const g = regById(req.params.id);
  revokeUnused(g);
  run('DELETE FROM registrations WHERE id = ?', g.id);
  audit(req.user.id, 'registration.delete', { id: g.id, email: g.email });
  changed();
  return { ok: true };
}));

r.post('/admin/registrations/codes', wrap((req) => {
  admin(req);
  const made = [];
  tx(() => {
    for (const g of all("SELECT * FROM registrations WHERE status = 'confirmed' ORDER BY id")) {
      const before = g.invite_code;
      const c = ensureCode(g);
      if (c && c !== before) made.push({ email: g.email, code: c });
    }
  });
  audit(req.user.id, 'registration.codes', { made: made.length });
  changed();
  return { made };
}));

// ---------- staff: attendance (check-in desk) ----------
function checkIn(g, on, idChecked, by) {
  const at = on ? (g.checked_in_at || now()) : '';
  const status = on && ['pending', 'waitlist', 'declined', 'cancelled'].includes(g.status) ? 'confirmed' : g.status; // here = attending
  run('UPDATE registrations SET checked_in_at = ?, checked_in_by = ?, id_checked = ?, status = ?, updated_at = ? WHERE id = ?',
    at, on ? by : null, on ? (idChecked == null ? g.id_checked : idChecked ? 1 : 0) : 0, status, now(), g.id);
  const u = get('SELECT id FROM users WHERE email = ?', g.email);
  if (u) { run('UPDATE users SET checked_in = ? WHERE id = ?', on ? 1 : 0, u.id); bus.syncUser && bus.syncUser(u.id); }
  return on && status !== 'declined' ? ensureCode({ ...g, status }) : '';
}
r.post('/admin/registrations/:id/checkin', wrap((req) => {
  admin(req);
  const b = req.body || {};
  const on = b.in !== false;
  const out = tx(() => {
    const g = regById(req.params.id);
    const c = checkIn(g, on, 'id_checked' in b ? !!b.id_checked : null, req.user.id);
    return { code: c, was: g.status };
  });
  audit(req.user.id, on ? 'checkin' : 'checkin.undo', { id: Number(req.params.id) });
  changed();
  bus.emit('admins', 'teams:update', {});
  return { ok: true, code: out.code, confirmed_now: on && out.was !== 'confirmed' };
}));

r.post('/admin/registrations/walkin', wrap((req) => {
  admin(req);
  const b = req.body || {};
  const name = str(b.name, { max: 80, required: true, name: 'Name' });
  const email = str(b.email, { max: 200, required: true, name: 'Email' }).toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (!emailAllowed(email, 'participant')) throw new HttpError(400, `Participants need a University of Akron email (${S.getSettings().participant_email_domains}).`);
  const out = tx(() => {
    const dup = get('SELECT id FROM registrations WHERE email = ?', email);
    if (dup) throw new HttpError(409, 'That email is already registered: find them in the list and check them in.');
    const info = run(`INSERT INTO registrations (email, name, major, team_mode, status, staff_note, updated_at) VALUES (?,?,?,?,?,?,?)`,
      email, name, str(b.major, { max: 80 }), 'match', 'confirmed', 'Walk-in', now());
    const g = regById(Number(info.lastInsertRowid));
    return { id: g.id, code: checkIn(g, true, !!b.id_checked, req.user.id) };
  });
  audit(req.user.id, 'checkin.walkin', { id: out.id });
  changed();
  return { ok: true, ...out };
}));

module.exports = { router: r, STATUSES };
