'use strict';
const express = require('express');
const crypto = require('node:crypto');
const { get, all, run, tx, audit } = require('../db');
const A = require('../auth');
const S = require('../settings');
const { wrap, str, now, code, bus, HttpError } = require('../util');
const runner = require('../runner');
const source = require('../source');

const r = express.Router();

// ---------- helpers ----------
function teamMembers(teamId) {
  return all('SELECT id, name, email, role, preferred_role, major, checked_in, github_login FROM users WHERE team_id = ? AND disabled = 0 ORDER BY id', teamId);
}
function teamPublic(t, { withCode = false } = {}) {
  if (!t) return null;
  const out = {
    id: t.id, name: t.name, lane: t.lane, table_no: t.table_no, extension_minutes: t.extension_minutes,
    members: teamMembers(t.id).map((m) => ({ id: m.id, name: m.name, preferred_role: m.preferred_role, major: m.major })),
    freeze_at: new Date(S.freezeAt(t)).toISOString(), frozen: S.isFrozen(t),
  };
  if (withCode) out.join_code = t.join_code;
  return out;
}
function publicSettings() {
  const s = S.getSettings();
  return {
    event_name: s.event_name, tagline: s.tagline,
    challenge: s.challenge_released ? s.challenge : '', challenge_released: !!s.challenge_released,
    roster_lock_at: s.roster_lock_at, cp1_at: s.cp1_at, cp2_at: s.cp2_at, upload_open_at: s.upload_open_at,
    build_freeze_at: new Date(Date.parse(s.build_freeze_at) + (s.global_extension_minutes || 0) * 60000).toISOString(),
    global_extension_minutes: s.global_extension_minutes, validation_end_at: s.validation_end_at,
    judging_open: !!s.judging_open, finalists_open: !!s.finalists_open, results_published: !!s.results_published,
    registration_open: !!s.registration_open, max_teams: s.max_teams, team_min: s.team_min, team_max: s.team_max,
    max_video_seconds: s.max_video_seconds, lanes: s.lanes, criteria: s.criteria, awards: s.awards, schedule: s.schedule,
    runner_enabled: !!s.runner_enabled, is_demo: !!s.is_demo, demo_shift_ms: s.is_demo ? Number(s.demo_shift_ms) || 0 : 0,
  };
}
const githubEnabled = () => !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
function emailAllowed(email, role) {
  if (role !== 'participant') return true;
  const doms = String(S.getSettings().participant_email_domains || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (!doms.length) return true;
  const dom = email.split('@')[1].toLowerCase();
  return doms.some((d) => dom === d || dom.endsWith('.' + d));
}

// ---------- auth ----------
r.post('/auth/register', wrap(async (req, res) => {
  if (!A.rateLimit(`reg:${req.ip}`, 300, 15 * 60000)) throw new HttpError(429, 'Too many attempts. Wait a few minutes.');
  const b = req.body || {};
  const inviteCode = str(b.invite, { max: 40, required: true, name: 'Access code' }).toUpperCase().replace(/\s+/g, '');
  const email = str(b.email, { max: 200, required: true, name: 'Email' }).toLowerCase();
  const name = str(b.name, { max: 80, required: true, name: 'Name' });
  const password = String(b.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (password.length < 8 || password.length > 200) throw new HttpError(400, 'Password must be at least 8 characters.');
  if (!b.agree) throw new HttpError(400, 'You must agree to the event rules and code of conduct.');
  const passwordHash = await A.hashPasswordAsync(password); // before the transaction: it takes ~45 ms

  const user = tx(() => {
    const inv = get('SELECT * FROM invites WHERE code = ?', inviteCode);
    if (!inv || inv.revoked || inv.uses >= inv.max_uses) throw new HttpError(400, 'That access code is not valid or has been used up.');
    if (inv.role === 'participant' && !S.getSettings().registration_open) throw new HttpError(403, 'Participant registration is closed.');
    // Personal codes (bulk-created from the registration list) only work for that one email.
    if (inv.email && inv.email.toLowerCase() !== email) throw new HttpError(400, 'That access code belongs to a different email address. Use the email you registered with.');
    if (!emailAllowed(email, inv.role)) throw new HttpError(400, `Participants must use a University of Akron email (${S.getSettings().participant_email_domains}).`);
    if (get('SELECT id FROM users WHERE email = ?', email)) throw new HttpError(409, 'An account with that email already exists. Sign in instead.');
    run('UPDATE invites SET uses = uses + 1 WHERE code = ?', inviteCode);
    const info = run(`INSERT INTO users (email, name, password_hash, role, major, class_level, skills, preferred_role, agreed_rules)
      VALUES (?,?,?,?,?,?,?,?,1)`, email, name, passwordHash, inv.role,
      str(b.major, { max: 80 }), str(b.class_level, { max: 40 }), str(b.skills, { max: 500 }), str(b.preferred_role, { max: 80 }));
    return get('SELECT * FROM users WHERE id = ?', Number(info.lastInsertRowid));
  });
  audit(user.id, 'register', { role: user.role, invite: inviteCode.slice(0, 5) + '…' });
  if (user.role === 'admin') require('node:fs').rm(require('node:path').join(require('../db').DATA_DIR, 'ADMIN-SETUP.txt'), { force: true }, () => {});
  A.setSessionCookie(req, res, A.createSession(user.id));
  return { user: A.publicUser(user) };
}));

r.post('/auth/login', wrap(async (req, res) => {
  const email = str((req.body || {}).email, { max: 200, required: true, name: 'Email' }).toLowerCase();
  const password = String((req.body || {}).password || '');
  // Per IP+email (so one person can't lock a classmate out), per email (slows guessing), per IP (coarse).
  if (!A.rateLimit(`login:${req.ip}`, 600, 15 * 60000) || !A.rateLimit(`login:${req.ip}:${email}`, 10, 15 * 60000) || !A.rateLimit(`login:${email}`, 40, 15 * 60000)) {
    throw new HttpError(429, 'Too many sign-in attempts. Wait a few minutes or ask staff to reset your password.');
  }
  const u = get('SELECT * FROM users WHERE email = ?', email);
  const ok = await A.verifyPasswordAsync(password, u ? u.password_hash : A.DUMMY_HASH);
  if (!u || !ok) throw new HttpError(401, 'Email or password is incorrect.');
  if (u.disabled) throw new HttpError(403, 'This account is disabled. Ask event staff.');
  A.setSessionCookie(req, res, A.createSession(u.id));
  return { user: A.publicUser(u) };
}));

r.post('/auth/logout', wrap((req, res) => {
  A.destroySession(req.sessionToken);
  if (req.user && bus.disconnectToken) bus.disconnectToken(req.sessionToken);
  A.clearSessionCookie(res);
  return { ok: true };
}));

// ---------- me ----------
r.get('/me', wrap((req) => {
  const u = req.user;
  const team = u && u.team_id ? get('SELECT * FROM teams WHERE id = ?', u.team_id) : null;
  return {
    user: A.publicUser(u),
    team: teamPublic(team, { withCode: true }),
    event: publicSettings(),
    serverTime: now(),
    github: githubEnabled(),
    runner: { ...runner.runnerStatus(), langs: Object.fromEntries(Object.entries(runner.LANGS).map(([k, v]) => [k, { name: v.name, entry: v.entry }])) },
  };
}));

r.patch('/me', wrap((req) => {
  const u = A.requireUser(req);
  const b = req.body || {};
  run('UPDATE users SET name = ?, major = ?, class_level = ?, skills = ?, preferred_role = ? WHERE id = ?',
    str(b.name ?? u.name, { max: 80, required: true, name: 'Name' }), str(b.major ?? u.major, { max: 80 }),
    str(b.class_level ?? u.class_level, { max: 40 }), str(b.skills ?? u.skills, { max: 500 }),
    str(b.preferred_role ?? u.preferred_role, { max: 80 }), u.id);
  if (u.team_id) bus.emit(`team:${u.team_id}`, 'team:update', {});
  return { user: A.publicUser(get('SELECT * FROM users WHERE id = ?', u.id)) };
}));

r.post('/me/password', wrap(async (req, res) => {
  const u = A.requireUser(req);
  const { current, next } = req.body || {};
  if (u.password_hash && !(await A.verifyPasswordAsync(String(current || ''), u.password_hash))) throw new HttpError(400, 'Current password is incorrect.');
  if (!next || String(next).length < 8) throw new HttpError(400, 'New password must be at least 8 characters.');
  run('UPDATE users SET password_hash = ? WHERE id = ?', await A.hashPasswordAsync(String(next)), u.id);
  A.destroyUserSessions(u.id);
  if (bus.disconnectUser) bus.disconnectUser(u.id);
  A.setSessionCookie(req, res, A.createSession(u.id));
  return { ok: true };
}));

r.post('/me/unlink-github', wrap((req) => {
  const u = A.requireUser(req);
  if (!u.password_hash) throw new HttpError(400, 'Set a password before unlinking GitHub.');
  run('UPDATE users SET github_id = NULL, github_login = NULL WHERE id = ?', u.id);
  return { ok: true };
}));

r.get('/event', wrap(() => ({ event: publicSettings(), serverTime: now() })));

// ---------- teams ----------
function requireParticipant(req) {
  const u = A.requireRole(req, 'participant');
  return u;
}
function laneOk(lane) {
  if (!lane) return '';
  if (!S.getSettings().lanes.some((l) => l.id === lane)) throw new HttpError(400, 'Pick one of the listed lanes.');
  return lane;
}

r.get('/teams', wrap((req) => {
  const u = A.requireUser(req);
  const teams = all('SELECT * FROM teams ORDER BY CAST(table_no AS INTEGER), id');
  return { teams: teams.map((t) => teamPublic(t, { withCode: u.role === 'admin' })) };
}));

r.post('/teams', wrap((req) => {
  const u = requireParticipant(req);
  if (u.team_id) throw new HttpError(400, 'You are already on a team. Leave it first.');
  if (S.rosterLocked()) throw new HttpError(403, 'Rosters are locked. Ask event staff to change teams.');
  const name = str(req.body.name, { max: 60, required: true, name: 'Team name' });
  const lane = laneOk(str(req.body.lane, { max: 30 }));
  const team = tx(() => {
    const count = get('SELECT COUNT(*) AS c FROM teams').c;
    if (count >= S.getSettings().max_teams) throw new HttpError(403, `The event is full (${S.getSettings().max_teams} teams). Ask staff about the waitlist.`);
    if (get('SELECT id FROM teams WHERE name = ?', name)) throw new HttpError(409, 'That team name is taken.');
    let jc; do { jc = code(6); } while (get('SELECT id FROM teams WHERE join_code = ?', jc));
    const info = run('INSERT INTO teams (name, join_code, lane, created_by) VALUES (?,?,?,?)', name, jc, lane, u.id);
    const id = Number(info.lastInsertRowid);
    run('UPDATE users SET team_id = ? WHERE id = ?', id, u.id);
    run('INSERT INTO submissions (team_id, updated_at) VALUES (?, ?)', id, now());
    return get('SELECT * FROM teams WHERE id = ?', id);
  });
  audit(u.id, 'team.create', { team: team.id, name });
  bus.syncUser(u.id);
  bus.emit('all', 'teams:update', {});
  return { team: teamPublic(team, { withCode: true }) };
}));

r.post('/teams/join', wrap((req) => {
  const u = requireParticipant(req);
  if (u.team_id) throw new HttpError(400, 'You are already on a team. Leave it first.');
  if (S.rosterLocked()) throw new HttpError(403, 'Rosters are locked. Ask event staff to change teams.');
  const jc = str(req.body.code, { max: 12, required: true, name: 'Team code' }).toUpperCase();
  if (!A.rateLimit(`join:${u.id}`, 15, 10 * 60000)) throw new HttpError(429, 'Too many tries. Wait a few minutes.');
  const team = tx(() => {
    const t = get('SELECT * FROM teams WHERE join_code = ?', jc);
    if (!t) throw new HttpError(404, 'No team has that code.');
    const n = get("SELECT COUNT(*) AS c FROM users WHERE team_id = ? AND disabled = 0", t.id).c;
    if (n >= S.getSettings().team_max) throw new HttpError(403, `That team is full (${S.getSettings().team_max} max).`);
    run('UPDATE users SET team_id = ? WHERE id = ?', t.id, u.id);
    return t;
  });
  audit(u.id, 'team.join', { team: team.id });
  bus.syncUser(u.id);
  bus.emit(`team:${team.id}`, 'team:update', {});
  bus.emit('all', 'teams:update', {});
  return { team: teamPublic(team, { withCode: true }) };
}));

r.post('/teams/leave', wrap((req) => {
  const u = requireParticipant(req);
  if (!u.team_id) throw new HttpError(400, 'You are not on a team.');
  if (S.rosterLocked()) throw new HttpError(403, 'Rosters are locked. Ask event staff to change teams.');
  const teamId = u.team_id;
  tx(() => {
    run('UPDATE users SET team_id = NULL WHERE id = ?', u.id);
    const left = get('SELECT COUNT(*) AS c FROM users WHERE team_id = ?', teamId).c;
    if (left === 0) run('DELETE FROM teams WHERE id = ?', teamId); // empty teams disappear
  });
  if (!get('SELECT id FROM teams WHERE id = ?', teamId)) source.purgeTeam(teamId);
  audit(u.id, 'team.leave', { team: teamId });
  bus.syncUser(u.id);
  bus.emit(`team:${teamId}`, 'team:update', {});
  bus.emit('all', 'teams:update', {});
  return { ok: true };
}));

r.patch('/teams/mine', wrap((req) => {
  const u = requireParticipant(req);
  if (!u.team_id) throw new HttpError(400, 'You are not on a team.');
  const t = get('SELECT * FROM teams WHERE id = ?', u.team_id);
  const b = req.body || {};
  const name = b.name !== undefined ? str(b.name, { max: 60, required: true, name: 'Team name' }) : t.name;
  const lane = b.lane !== undefined ? laneOk(str(b.lane, { max: 30 })) : t.lane;
  if (name !== t.name && S.rosterLocked()) throw new HttpError(403, 'Team names lock with the roster.');
  if (S.isFrozen(t)) throw new HttpError(403, 'Build freeze has passed.');
  if (name.toLowerCase() !== t.name.toLowerCase() && get('SELECT id FROM teams WHERE name = ?', name)) throw new HttpError(409, 'That team name is taken.');
  run('UPDATE teams SET name = ?, lane = ? WHERE id = ?', name, lane, t.id);
  bus.emit(`team:${t.id}`, 'team:update', {});
  bus.emit('all', 'teams:update', {});
  return { team: teamPublic(get('SELECT * FROM teams WHERE id = ?', t.id), { withCode: true }) };
}));

r.post('/teams/mine/new-code', wrap((req) => {
  const u = requireParticipant(req);
  if (!u.team_id) throw new HttpError(400, 'You are not on a team.');
  if (S.rosterLocked()) throw new HttpError(403, 'Rosters are locked.');
  let jc; do { jc = code(6); } while (get('SELECT id FROM teams WHERE join_code = ?', jc));
  run('UPDATE teams SET join_code = ? WHERE id = ?', jc, u.team_id);
  bus.emit(`team:${u.team_id}`, 'team:update', {});
  return { join_code: jc };
}));

// ---------- checkpoints ----------
const CP_FIELDS = {
  cp1: [['user', 'Primary user', 400], ['problem', 'One-sentence problem', 600], ['outcome', 'Proposed outcome', 600],
    ['evidence', 'Evidence', 800], ['success', 'Success measure', 400], ['tech', 'Planned technology', 600]],
  cp2: [['core', 'Working core shown to mentor', 400], ['blockers', 'Blockers', 800], ['demo1', 'Demo plan bullet 1', 300],
    ['demo2', 'Demo plan bullet 2', 300], ['demo3', 'Demo plan bullet 3', 300]],
};
const CP_OPTIONAL = new Set(['blockers', 'core']);

function getCheckpoints(teamId) {
  const out = {};
  for (const row of all('SELECT * FROM checkpoints WHERE team_id = ?', teamId)) {
    out[row.kind] = { data: JSON.parse(row.data), submitted_at: row.submitted_at, late: !!row.late,
      submitted_by: (get('SELECT name FROM users WHERE id = ?', row.submitted_by) || {}).name || '',
      updated_at: row.updated_at && row.updated_at !== row.submitted_at ? row.updated_at : '',
      updated_by: row.updated_by ? (get('SELECT name FROM users WHERE id = ?', row.updated_by) || {}).name || '' : '' };
  }
  return out;
}

r.get('/teams/mine/checkpoints', wrap((req) => {
  const u = requireParticipant(req);
  if (!u.team_id) throw new HttpError(400, 'Join a team first.');
  return { checkpoints: getCheckpoints(u.team_id) };
}));

r.put('/teams/mine/checkpoints/:kind', wrap((req) => {
  const u = requireParticipant(req);
  const kind = req.params.kind;
  if (!CP_FIELDS[kind]) throw new HttpError(404, 'Unknown checkpoint.');
  if (!u.team_id) throw new HttpError(400, 'Join a team first.');
  const t = get('SELECT * FROM teams WHERE id = ?', u.team_id);
  if (S.isFrozen(t)) throw new HttpError(403, 'Build freeze has passed.');
  const data = {};
  for (const [k, label, max] of CP_FIELDS[kind]) data[k] = str((req.body || {})[k], { max, required: !CP_OPTIONAL.has(k), name: label });
  if (kind === 'cp1' && !t.lane) throw new HttpError(400, 'Pick your team lane first (Team page).');
  const s = S.getSettings();
  const late = Date.now() > Date.parse(kind === 'cp1' ? s.cp1_at : s.cp2_at) + 60000 ? 1 : 0;
  // The first submission sets the time and the late flag; later edits only change the content
  // (and are logged), so fixing a typo after the deadline doesn't turn an on-time checkpoint late.
  const had = get('SELECT late FROM checkpoints WHERE team_id = ? AND kind = ?', t.id, kind);
  const ts = now();
  run(`INSERT INTO checkpoints (team_id, kind, data, submitted_by, submitted_at, late, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(team_id, kind) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  t.id, kind, JSON.stringify(data), u.id, ts, late, ts, u.id);
  run('INSERT INTO submission_log (team_id, user_id, action, detail) VALUES (?,?,?,?)', t.id, u.id, had ? `checkpoint.${kind}.edit` : `checkpoint.${kind}`,
    had ? (late ? 'edited after the deadline' : '') : (late ? 'late' : ''));
  bus.emit(`team:${t.id}`, 'team:update', {});
  bus.emit('staff', 'staff:update', { kind: 'checkpoint' });
  return { checkpoints: getCheckpoints(t.id) };
}));

// ---------- GitHub OAuth (optional) ----------
r.get('/auth/github/start', wrap((req, res) => {
  if (!githubEnabled()) throw new HttpError(404, 'GitHub sign-in is not set up on this server.');
  const mode = req.query.mode === 'link' ? 'link' : 'login';
  if (mode === 'link') A.requireUser(req);
  const state = crypto.randomBytes(16).toString('hex');
  res.append('Set-Cookie', `hak_gh=${state}.${mode}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secureReq(req) ? '; Secure' : ''}`);
  const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const q = new URLSearchParams({ client_id: process.env.GITHUB_CLIENT_ID, redirect_uri: `${base}/api/auth/github/callback`, state, scope: 'read:user', allow_signup: 'true' });
  res.redirect(`https://github.com/login/oauth/authorize?${q}`);
}));

const secureReq = (req) => req.secure || /^https:/i.test(process.env.PUBLIC_URL || '');
r.get('/auth/github/callback', async (req, res) => {
  if (!githubEnabled()) return res.status(404).send('GitHub sign-in is not set up on this server.');
  const cookie = A.parseCookies(req.headers.cookie).hak_gh || '';
  const [state, mode] = cookie.split('.');
  // Someone already signed in (linking from their profile) goes back to the profile with the reason.
  const fail = (code) => res.redirect(mode === 'link' || req.user ? `/#/profile?error=${code}` : `/#/login?error=${code}`);
  try {
    res.append('Set-Cookie', `hak_gh=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureReq(req) ? '; Secure' : ''}`);
    if (req.query.error) return fail(req.query.error === 'access_denied' ? 'gh_cancel' : 'gh_denied');
    if (!state || state !== req.query.state || !req.query.code) return fail('gh_expired');
    const tokRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, code: String(req.query.code) }),
    });
    const tok = await tokRes.json();
    if (!tok.access_token) return fail('gh_denied');
    const gu = await (await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${tok.access_token}`, 'User-Agent': 'hakrathon-hub' } })).json();
    if (!gu || !gu.id) return fail('gh_profile');
    const ghId = String(gu.id);
    if (mode === 'link') {
      if (!req.user) return fail('gh_signin');
      const other = get('SELECT id FROM users WHERE github_id = ? AND id != ?', ghId, req.user.id);
      if (other) return fail('gh_taken');
      run('UPDATE users SET github_id = ?, github_login = ? WHERE id = ?', ghId, gu.login, req.user.id);
      return res.redirect('/#/profile?linked=1');
    }
    const u = get('SELECT * FROM users WHERE github_id = ?', ghId);
    if (!u) return fail('gh_nolink');
    if (u.disabled) return fail('disabled');
    run('UPDATE users SET github_login = ? WHERE id = ?', gu.login, u.id);
    A.setSessionCookie(req, res, A.createSession(u.id));
    return res.redirect('/#/');
  } catch (e) {
    console.error('[github]', e.message);
    return fail('gh_failed');
  }
});

module.exports = { router: r, emailAllowed, teamPublic, teamMembers, publicSettings, getCheckpoints, CP_FIELDS };
