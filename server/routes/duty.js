'use strict';
// Mentor / judge "on duty" check-in. Staff toggle themselves in and out; everyone can see which mentors are in.
const express = require('express');
const { all, run, audit } = require('../db');
const A = require('../auth');
const { wrap, now, bus } = require('../util');

const r = express.Router();
const DUTY_ROLES = ['mentor', 'judge'];

function list(viewer) {
  const staff = viewer.role === 'participant' ? ['mentor'] : DUTY_ROLES;
  const rows = all(`SELECT id, name, role, on_duty, duty_since FROM users WHERE disabled = 0 AND role IN (${staff.map(() => '?').join(',')}) ORDER BY on_duty DESC, role, name`, ...staff);
  return rows.map((u) => ({ id: u.id, name: u.name, role: u.role, on_duty: !!u.on_duty, since: u.on_duty ? u.duty_since : '' }));
}

r.get('/duty', wrap((req) => {
  const u = A.requireUser(req);
  return { staff: list(u), me: DUTY_ROLES.includes(u.role) ? { on_duty: !!(all('SELECT on_duty FROM users WHERE id = ?', u.id)[0] || {}).on_duty } : null };
}));

r.post('/duty', wrap((req) => {
  const u = A.requireRole(req, 'mentor', 'judge');
  const on = !!(req.body || {}).on;
  run('UPDATE users SET on_duty = ?, duty_since = ? WHERE id = ?', on ? 1 : 0, on ? now() : '', u.id);
  audit(u.id, on ? 'duty.in' : 'duty.out', {});
  bus.emit('all', 'duty:update', {});
  return { ok: true, on_duty: on };
}));

module.exports = { router: r };
