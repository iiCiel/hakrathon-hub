'use strict';
const express = require('express');
const { get, all, run, audit } = require('../db');
const A = require('../auth');
const S = require('../settings');
const { wrap, str, now, bus, HttpError } = require('../util');

const r = express.Router();

// Channel access rules.
//   announcements: everyone reads, admins post
//   general/help:  everyone reads and posts
//   staff:         admins, judges, mentors
//   team:<id>:     that team's members + admins
function channelsFor(u) {
  const list = [
    { id: 'announcements', name: 'Announcements', canPost: u.role === 'admin', desc: 'Official updates and challenge clarifications' },
    { id: 'general', name: 'General', canPost: true, desc: 'Everyone at the event' },
    { id: 'help', name: 'Tech help', canPost: true, desc: 'Public questions for staff and mentors' },
  ];
  if (u.team_id) {
    const t = get('SELECT name FROM teams WHERE id = ?', u.team_id);
    if (t) list.push({ id: `team:${u.team_id}`, name: `Team · ${t.name}`, canPost: true, desc: 'Private to your team', team: true });
  }
  if (A.isStaff(u)) list.push({ id: 'staff', name: 'Staff room', canPost: true, desc: 'Admins, judges and mentors only' });
  if (u.role === 'admin') {
    for (const t of all('SELECT id, name FROM teams ORDER BY name')) {
      if (t.id !== u.team_id) list.push({ id: `team:${t.id}`, name: `Team · ${t.name}`, canPost: true, desc: 'Team channel (admin view)', team: true, moderating: true });
    }
  }
  return list;
}
function access(u, channel) {
  const c = channelsFor(u).find((x) => x.id === channel);
  if (!c) throw new HttpError(403, 'You do not have access to that channel.');
  return c;
}
const roomFor = (channel) => (channel.startsWith('team:') ? channel : channel === 'staff' ? 'staff' : 'all');

function shape(m) {
  return { id: m.id, channel: m.channel, body: m.deleted ? '' : m.body, deleted: !!m.deleted, pinned: !!m.pinned, created_at: m.created_at,
    user: { id: m.user_id, name: m.name, role: m.role, team: m.team_name || '' } };
}
const MSG_SQL = `SELECT m.*, u.name, u.role, t.name AS team_name FROM messages m JOIN users u ON u.id = m.user_id LEFT JOIN teams t ON t.id = u.team_id`;

r.get('/chat/channels', wrap((req) => ({ channels: channelsFor(A.requireUser(req)) })));

r.get('/chat/:channel', wrap((req) => {
  const u = A.requireUser(req);
  const ch = req.params.channel;
  access(u, ch);
  const before = Number(req.query.before) || 1e15;
  const rows = all(`${MSG_SQL} WHERE m.channel = ? AND m.id < ? ORDER BY m.id DESC LIMIT 100`, ch, before).reverse();
  const pinned = all(`${MSG_SQL} WHERE m.channel = ? AND m.pinned = 1 AND m.deleted = 0 ORDER BY m.id DESC LIMIT 10`, ch);
  return { messages: rows.map(shape), pinned: pinned.map(shape) };
}));

function postMessage(u, ch, body) {
  const info = run('INSERT INTO messages (channel, user_id, body) VALUES (?,?,?)', ch, u.id, body);
  const m = shape(get(`${MSG_SQL} WHERE m.id = ?`, Number(info.lastInsertRowid)));
  bus.emit(roomFor(ch), 'chat:message', m);
  if (ch.startsWith('team:')) bus.emit('admins', 'chat:message', m);
  return m;
}

r.post('/chat/:channel', wrap((req) => {
  const u = A.requireUser(req);
  const ch = req.params.channel;
  const c = access(u, ch);
  if (!c.canPost) throw new HttpError(403, 'Only event staff can post here.');
  if (!A.rateLimit(`chat:${u.id}`, 12, 10000)) throw new HttpError(429, 'Slow down a little.');
  const body = str((req.body || {}).body, { max: 4000, required: true, name: 'Message' });
  return { message: postMessage(u, ch, body) };
}));

r.delete('/chat/messages/:id', wrap((req) => {
  const u = A.requireUser(req);
  const m = get('SELECT * FROM messages WHERE id = ?', Number(req.params.id));
  if (!m) throw new HttpError(404, 'Message not found.');
  if (m.user_id !== u.id && u.role !== 'admin') throw new HttpError(403, 'You can only delete your own messages.');
  run('UPDATE messages SET deleted = 1, pinned = 0 WHERE id = ?', m.id);
  if (m.user_id !== u.id) audit(u.id, 'chat.delete', { id: m.id, channel: m.channel });
  bus.emit(roomFor(m.channel), 'chat:update', shape(get(`${MSG_SQL} WHERE m.id = ?`, m.id)));
  return { ok: true };
}));

r.post('/chat/messages/:id/pin', wrap((req) => {
  const u = A.requireRole(req, 'admin');
  const m = get('SELECT * FROM messages WHERE id = ?', Number(req.params.id));
  if (!m) throw new HttpError(404, 'Message not found.');
  run('UPDATE messages SET pinned = ? WHERE id = ?', (req.body || {}).pinned ? 1 : 0, m.id);
  audit(u.id, 'chat.pin', { id: m.id });
  bus.emit(roomFor(m.channel), 'chat:update', shape(get(`${MSG_SQL} WHERE m.id = ?`, m.id)));
  return { ok: true };
}));

// ---------- mentor help queue ----------
const HELP_KINDS = { technical: 'Technical', business: 'Problem / business', presentation: 'Presentation' };
const HELP_SQL = `SELECT h.*, t.name AS team_name, t.table_no, u.name AS requester, m.name AS mentor_name
  FROM help_requests h JOIN teams t ON t.id = h.team_id JOIN users u ON u.id = h.user_id LEFT JOIN users m ON m.id = h.mentor_id`;
const helpStaff = (u) => u.role === 'admin' || u.role === 'mentor';
function helpShape(h, viewer) {
  const staff = helpStaff(viewer);
  return { id: h.id, team_id: h.team_id, team_name: h.team_name, table_no: h.table_no, kind: h.kind, summary: h.summary,
    status: h.status, requester: h.requester, mentor_id: h.mentor_id, mentor_name: h.mentor_name || '',
    mentor_note: staff ? h.mentor_note : '', created_at: h.created_at, claimed_at: h.claimed_at, resolved_at: h.resolved_at };
}
function helpChanged(h) {
  bus.emit('helpdesk', 'help:update', {});
  bus.emit(`team:${h.team_id}`, 'help:update', {});
}

r.get('/help', wrap((req) => {
  const u = A.requireUser(req);
  if (u.role === 'judge') throw new HttpError(403, 'The help queue is for mentors.');
  if (helpStaff(u)) {
    const active = all(`${HELP_SQL} WHERE h.status IN ('open','claimed') ORDER BY h.id`);
    const done = all(`${HELP_SQL} WHERE h.status IN ('resolved','cancelled') ORDER BY h.id DESC LIMIT 100`);
    return { requests: active.concat(done).map((h) => helpShape(h, u)), kinds: HELP_KINDS };
  }
  if (!u.team_id) return { requests: [], kinds: HELP_KINDS };
  return { requests: all(`${HELP_SQL} WHERE h.team_id = ? ORDER BY h.id DESC LIMIT 50`, u.team_id).map((h) => helpShape(h, u)), kinds: HELP_KINDS };
}));

r.post('/help', wrap((req) => {
  const u = A.requireRole(req, 'participant');
  if (!u.team_id) throw new HttpError(400, 'Join a team first.');
  if (S.isFrozen(get('SELECT * FROM teams WHERE id = ?', u.team_id))) throw new HttpError(403, 'Build freeze has passed. Ask staff at the help desk.');
  const kind = String((req.body || {}).kind || '');
  if (!HELP_KINDS[kind]) throw new HttpError(400, 'Pick a help type.');
  const summary = str(req.body.summary, { max: 500, required: true, name: 'What you need' });
  const open = get("SELECT COUNT(*) AS c FROM help_requests WHERE team_id = ? AND status IN ('open','claimed')", u.team_id).c;
  if (open >= 2) throw new HttpError(429, 'Your team already has 2 open requests. A mentor will be with you soon.');
  const info = run('INSERT INTO help_requests (team_id, user_id, kind, summary) VALUES (?,?,?,?)', u.team_id, u.id, kind, summary);
  const h = get(`${HELP_SQL} WHERE h.id = ?`, Number(info.lastInsertRowid));
  helpChanged(h);
  bus.emit('helpdesk', 'help:new', helpShape(h, u));
  return { request: helpShape(h, u) };
}));

r.post('/help/:id/:action', wrap((req) => {
  const u = A.requireUser(req);
  const h = get('SELECT * FROM help_requests WHERE id = ?', Number(req.params.id));
  if (!h) throw new HttpError(404, 'Request not found.');
  const action = req.params.action;
  const t = now();
  if (action === 'cancel') {
    if (!(u.team_id === h.team_id || u.role === 'admin')) throw new HttpError(403, 'Not your request.');
    if (!['open', 'claimed'].includes(h.status)) throw new HttpError(400, 'Already closed.');
    run("UPDATE help_requests SET status = 'cancelled', resolved_at = ? WHERE id = ?", t, h.id);
  } else {
    if (!['admin', 'mentor'].includes(u.role)) throw new HttpError(403, 'Mentors only.');
    if (action === 'claim') {
      if (h.status !== 'open') throw new HttpError(409, 'Someone already picked this up.');
      run("UPDATE help_requests SET status = 'claimed', mentor_id = ?, claimed_at = ? WHERE id = ? AND status = 'open'", u.id, t, h.id);
    } else if (action === 'release') {
      if (h.status !== 'claimed') throw new HttpError(400, 'Not claimed.');
      if (h.mentor_id !== u.id && u.role !== 'admin') throw new HttpError(403, 'Another mentor has this request.');
      run("UPDATE help_requests SET status = 'open', mentor_id = NULL, claimed_at = NULL WHERE id = ?", h.id);
    } else if (action === 'resolve') {
      if (!['open', 'claimed'].includes(h.status)) throw new HttpError(409, 'This request is already closed; its log note can\'t be changed.');
      if (h.status === 'claimed' && h.mentor_id !== u.id && u.role !== 'admin') throw new HttpError(403, 'Another mentor has this request.');
      // Mentor log entry: required short note of what was discussed (scope §10).
      const note = str((req.body || {}).note, { max: 1000, required: true, name: 'Mentor log note' });
      run("UPDATE help_requests SET status = 'resolved', mentor_id = COALESCE(mentor_id, ?), mentor_note = ?, resolved_at = ? WHERE id = ?", u.id, note, t, h.id);
    } else throw new HttpError(404, 'Unknown action.');
  }
  helpChanged(h);
  return { request: helpShape(get(`${HELP_SQL} WHERE h.id = ?`, h.id), u) };
}));

module.exports = { router: r, channelsFor, postMessage };
