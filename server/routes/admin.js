'use strict';
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { get, all, run, tx, audit, DATA_DIR } = require('../db');
const A = require('../auth');
const S = require('../settings');
const runner = require('../runner');
const source = require('../source');
const offline = require('../offline');
const democlock = require('../democlock');
const { teamPublic, getCheckpoints, emailAllowed } = require('./core');
const { postMessage } = require('./chat');
const { completeness, subRow, adminSnapshot, resetFreezeSnapshot } = require('./submit');
const { tabulate } = require('./judge');
const { wrap, str, int, now, code, bus, HttpError } = require('../util');

const r = express.Router();
r.use((req, _res, next) => { try { A.requireRole(req, 'admin'); next(); } catch (e) { next(e); } });

const ROLES = ['admin', 'judge', 'mentor', 'participant'];

r.get('/admin/overview', wrap(() => {
  const teams = all('SELECT * FROM teams ORDER BY CAST(table_no AS INTEGER), name').map((t) => {
    const s = subRow(t.id);
    const cps = getCheckpoints(t.id);
    const comp = completeness(t, s, cps);
    const val = get('SELECT * FROM validations WHERE team_id = ?', t.id) || {};
    return { ...teamPublic(t, { withCode: true }), project_title: s.project_title, completeness: comp,
      checkpoints: { cp1: cps.cp1 ? { at: cps.cp1.submitted_at, late: cps.cp1.late } : null, cp2: cps.cp2 ? { at: cps.cp2.submitted_at, late: cps.cp2.late } : null },
      repo: { url: s.repo_url, sha: s.repo_sha, at: s.repo_snapshot_at, final: !!s.repo_final, error: s.repo_error },
      video_seconds: s.video_seconds, validation: val, open_help: get("SELECT COUNT(*) AS c FROM help_requests WHERE team_id = ? AND status IN ('open','claimed')", t.id).c };
  });
  const counts = Object.fromEntries(ROLES.map((r2) => [r2, get('SELECT COUNT(*) AS c FROM users WHERE role = ? AND disabled = 0', r2).c]));
  const unassigned = all("SELECT id, name, email, preferred_role, skills, major FROM users WHERE role = 'participant' AND team_id IS NULL AND disabled = 0 ORDER BY name");
  return {
    teams, counts, unassigned, checkedIn: get("SELECT COUNT(*) AS c FROM users WHERE role='participant' AND checked_in = 1").c,
    help: { open: get("SELECT COUNT(*) AS c FROM help_requests WHERE status = 'open'").c, claimed: get("SELECT COUNT(*) AS c FROM help_requests WHERE status = 'claimed'").c },
    runner: { ...runner.runnerStatus(), queue: runner.queueDepth(), runsLastHour: get("SELECT COUNT(*) AS c FROM runs WHERE created_at > ?", new Date(Date.now() - 3600000).toISOString()).c },
    settings: S.getSettings(), github: !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
  };
}));

// ---------- settings ----------
const ISO_KEYS = ['roster_lock_at', 'cp1_at', 'cp2_at', 'upload_open_at', 'build_freeze_at', 'validation_end_at'];
r.get('/admin/settings', wrap(() => ({ settings: S.getSettings() })));
r.put('/admin/settings', wrap((req) => {
  const b = req.body || {};
  const before = S.getSettings();
  const patch = {};
  for (const k of ISO_KEYS) if (k in b) { if (Number.isNaN(Date.parse(b[k]))) throw new HttpError(400, `Bad date for ${k}.`); patch[k] = new Date(b[k]).toISOString(); }
  for (const k of ['event_name', 'tagline']) if (k in b) patch[k] = str(b[k], { max: 120, required: true, name: k });
  if ('challenge' in b) patch.challenge = str(b.challenge, { max: 4000, required: true, name: 'Challenge' });
  if ('participant_email_domains' in b) patch.participant_email_domains = str(b.participant_email_domains, { max: 300 });
  for (const k of ['challenge_released', 'judging_open', 'finalists_open', 'results_published', 'registration_open', 'signup_open', 'one_prize_per_team', 'runner_enabled']) if (k in b) patch[k] = !!b[k];
  if ('global_extension_minutes' in b) patch.global_extension_minutes = int(b.global_extension_minutes, { min: 0, max: 240, name: 'Extension minutes' });
  if ('max_teams' in b) patch.max_teams = int(b.max_teams, { min: 1, max: 100, name: 'Max teams' });
  if ('team_min' in b) patch.team_min = int(b.team_min, { min: 1, max: 20, name: 'Team minimum' });
  if ('team_max' in b) patch.team_max = int(b.team_max, { min: 1, max: 20, name: 'Team maximum' });
  if ('min_judges' in b) patch.min_judges = int(b.min_judges, { min: 1, max: 20, name: 'Minimum judges' });
  if ('max_video_seconds' in b) patch.max_video_seconds = int(b.max_video_seconds, { min: 30, max: 3600, name: 'Max video length' });
  if ('finalists' in b) {
    if (!Array.isArray(b.finalists) || b.finalists.length > 10) throw new HttpError(400, 'Finalists must be a list of teams.');
    patch.finalists = b.finalists.map((x) => teamExists(x));
  }
  const timedRows = (list, max, what) => {
    if (!Array.isArray(list) || list.length > max) throw new HttpError(400, `Bad ${what}.`);
    return list.map((x) => {
      if (!x || Number.isNaN(Date.parse(x.start)) || Number.isNaN(Date.parse(x.end || x.start))) throw new HttpError(400, `Every ${what} row needs valid times.`);
      if (Date.parse(x.end || x.start) < Date.parse(x.start)) throw new HttpError(400, `A ${what} row ends before it starts.`);
      return { start: new Date(x.start).toISOString(), end: new Date(x.end || x.start).toISOString(), title: str(x.title, { max: 80, required: true, name: `${what[0].toUpperCase()}${what.slice(1)} title` }), detail: str(x.detail, { max: 400 }) };
    }).sort((a, c) => Date.parse(a.start) - Date.parse(c.start));
  };
  if ('schedule' in b) patch.schedule = timedRows(b.schedule, 60, 'schedule');
  if ('meals' in b) patch.meals = timedRows(b.meals, 12, 'meal');
  const s = S.setSettings(patch);
  if (s.team_min > s.team_max) { S.setSettings({ team_min: before.team_min, team_max: before.team_max }); throw new HttpError(400, 'Team minimum is larger than maximum.'); }
  // Moving the freeze later re-opens teams; their official snapshot must be re-taken at the new freeze.
  if ('build_freeze_at' in patch || 'global_extension_minutes' in patch) {
    for (const t of all('SELECT * FROM teams')) if (!S.isFrozen(t)) resetFreezeSnapshot(t.id);
  }
  audit(req.user.id, 'settings', Object.keys(patch));
  bus.emit('all', 'event:update', {});
  return { settings: S.getSettings() };
}));
// ---------- demo clock (demo copy only) ----------
r.get('/admin/demo-clock', wrap(() => {
  if (!S.getSettings().is_demo) throw new HttpError(404, 'Only in the demo.');
  return { stages: democlock.STAGES, now: democlock.demoNow().toISOString() };
}));
r.post('/admin/demo-clock', wrap((req) => {
  if (!S.getSettings().is_demo) throw new HttpError(404, 'Only in the demo.');
  const id = String((req.body || {}).stage || '');
  if (!democlock.STAGES.some((x) => x.id === id)) throw new HttpError(400, 'Unknown demo stage.');
  const stage = democlock.jump(id);
  audit(req.user.id, 'demo-clock', stage.id);
  bus.emit('all', 'event:update', {});
  bus.emit('all', 'staff:update', {});
  return { stage, now: democlock.demoNow().toISOString() };
}));
function teamExists(id) { const t = get('SELECT id FROM teams WHERE id = ?', Number(id)); if (!t) throw new HttpError(400, 'Unknown team.'); return t.id; }

// ---------- people ----------
r.get('/admin/users', wrap(() => ({
  users: all(`SELECT u.id, u.email, u.name, u.role, u.team_id, t.name AS team_name, u.major, u.class_level, u.skills, u.preferred_role,
    u.github_login, u.disabled, u.checked_in, u.created_at FROM users u LEFT JOIN teams t ON t.id = u.team_id ORDER BY u.role, u.name`),
})));

r.patch('/admin/users/:id', wrap((req) => {
  const u = get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
  if (!u) throw new HttpError(404, 'User not found.');
  const b = req.body || {};
  const role = 'role' in b ? String(b.role) : u.role;
  if (!ROLES.includes(role)) throw new HttpError(400, 'Bad role.');
  if (u.id === req.user.id && (role !== 'admin' || b.disabled)) throw new HttpError(400, 'You cannot demote or disable yourself.');
  let teamId = 'team_id' in b ? (b.team_id ? teamExists(b.team_id) : null) : u.team_id;
  if (role !== 'participant') teamId = null;
  const oldTeam = u.team_id;
  if (teamId && teamId !== oldTeam && !b.force) {
    const st = S.getSettings();
    const n = get("SELECT COUNT(*) AS c FROM users WHERE team_id = ? AND disabled = 0 AND role = 'participant'", teamId).c;
    if (n >= st.team_max) throw new HttpError(409, `That team already has ${n} members (the maximum is ${st.team_max}).`);
  }
  run('UPDATE users SET role = ?, team_id = ?, disabled = ?, checked_in = ?, name = ? WHERE id = ?', role, teamId,
    'disabled' in b ? (b.disabled ? 1 : 0) : u.disabled, 'checked_in' in b ? (b.checked_in ? 1 : 0) : u.checked_in,
    'name' in b ? str(b.name, { max: 80, required: true, name: 'Name' }) : u.name, u.id);
  if (b.disabled) { A.destroyUserSessions(u.id); bus.disconnectUser(u.id); }
  // Keep the check-in desk in step when staff tick "checked in" on the People tab.
  if ('checked_in' in b && !!b.checked_in !== !!u.checked_in) {
    run("UPDATE registrations SET checked_in_at = ?, checked_in_by = ?, updated_at = ? WHERE email = ?", b.checked_in ? now() : '', b.checked_in ? req.user.id : null, now(), u.email);
  }
  audit(req.user.id, 'user.update', { id: u.id, role, teamId, disabled: b.disabled });
  bus.syncUser(u.id);
  for (const t of new Set([oldTeam, teamId].filter(Boolean))) bus.emit(`team:${t}`, 'team:update', {});
  bus.emit('all', 'teams:update', {});
  return { ok: true };
}));

r.post('/admin/users/:id/reset-password', wrap((req) => {
  const u = get('SELECT id, email FROM users WHERE id = ?', Number(req.params.id));
  if (!u) throw new HttpError(404, 'User not found.');
  const temp = `${code(4)}-${code(4)}`;
  run('UPDATE users SET password_hash = ? WHERE id = ?', A.hashPassword(temp), u.id);
  A.destroyUserSessions(u.id);
  bus.disconnectUser(u.id);
  audit(req.user.id, 'user.reset-password', { id: u.id });
  return { email: u.email, tempPassword: temp };
}));

// ---------- invites ----------
r.get('/admin/invites', wrap(() => ({ invites: all('SELECT * FROM invites ORDER BY created_at DESC') })));
r.post('/admin/invites', wrap((req) => {
  const b = req.body || {};
  const role = String(b.role || '');
  if (!ROLES.includes(role)) throw new HttpError(400, 'Pick a role.');
  const maxUses = int(b.max_uses ?? 1, { min: 1, max: 1000, name: 'Uses' });
  let c = str(b.code, { max: 30 }).toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (c && c.length < 6) throw new HttpError(400, 'Custom codes need at least 6 characters.');
  if (!c) c = `${role.slice(0, 3).toUpperCase()}-${code(6)}`;
  if (get('SELECT code FROM invites WHERE code = ?', c)) throw new HttpError(409, 'That code already exists.');
  run('INSERT INTO invites (code, role, max_uses, note) VALUES (?,?,?,?)', c, role, maxUses, str(b.note, { max: 120 }));
  audit(req.user.id, 'invite.create', { code: c.slice(0, 5) + '…', role, maxUses });
  return { invite: get('SELECT * FROM invites WHERE code = ?', c) };
}));
// One single-use code per email (paste the registration list). Stops anyone with a shared code
// from registering under a classmate's address.
r.post('/admin/invites/bulk', wrap((req) => {
  const b = req.body || {};
  const role = String(b.role || 'participant');
  if (!ROLES.includes(role)) throw new HttpError(400, 'Pick a role.');
  const emails = [...new Set(String(b.emails || '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!emails.length) throw new HttpError(400, 'Paste at least one email.');
  if (emails.length > 300) throw new HttpError(400, 'At most 300 emails at a time.');
  const bad = emails.filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  if (bad.length) throw new HttpError(400, `Not an email: ${bad.slice(0, 3).join(', ')}`);
  const note = str(b.note, { max: 120 });
  const made = [], skipped = [];
  tx(() => {
    for (const e of emails) {
      const why = !emailAllowed(e, role) ? 'not a university email' : get('SELECT id FROM users WHERE email = ?', e) ? 'already registered'
        : get('SELECT code FROM invites WHERE email = ? AND revoked = 0 AND uses < max_uses', e) ? 'already has a code' : '';
      if (why) { skipped.push({ email: e, why }); continue; }
      let c; do { c = `${role.slice(0, 3).toUpperCase()}-${code(6)}`; } while (get('SELECT code FROM invites WHERE code = ?', c));
      run('INSERT INTO invites (code, role, max_uses, note, email) VALUES (?,?,1,?,?)', c, role, note, e);
      made.push({ email: e, code: c });
    }
  });
  audit(req.user.id, 'invite.bulk', { role, made: made.length, skipped: skipped.length });
  return { made, skipped };
}));
r.post('/admin/invites/:code/revoke', wrap((req) => {
  run('UPDATE invites SET revoked = 1 WHERE code = ?', req.params.code);
  audit(req.user.id, 'invite.revoke', { code: req.params.code });
  return { ok: true };
}));

// ---------- teams ----------
r.post('/admin/teams', wrap((req) => {
  const name = str((req.body || {}).name, { max: 60, required: true, name: 'Team name' });
  if (get('SELECT id FROM teams WHERE name = ?', name)) throw new HttpError(409, 'That team name is taken.');
  let jc; do { jc = code(6); } while (get('SELECT id FROM teams WHERE join_code = ?', jc));
  const info = run('INSERT INTO teams (name, join_code, table_no, created_by) VALUES (?,?,?,?)', name, jc, str(req.body.table_no, { max: 10 }), req.user.id);
  run('INSERT INTO submissions (team_id, updated_at) VALUES (?, ?)', Number(info.lastInsertRowid), now());
  audit(req.user.id, 'team.create', { name });
  bus.emit('all', 'teams:update', {});
  return { team: teamPublic(get('SELECT * FROM teams WHERE id = ?', Number(info.lastInsertRowid)), { withCode: true }) };
}));

r.patch('/admin/teams/:id', wrap((req) => {
  const t = get('SELECT * FROM teams WHERE id = ?', Number(req.params.id));
  if (!t) throw new HttpError(404, 'Team not found.');
  const b = req.body || {};
  const name = 'name' in b ? str(b.name, { max: 60, required: true, name: 'Team name' }) : t.name;
  if (name.toLowerCase() !== t.name.toLowerCase() && get('SELECT id FROM teams WHERE name = ?', name)) throw new HttpError(409, 'That team name is taken.');
  const lane = 'lane' in b ? str(b.lane, { max: 30 }) : t.lane;
  if (lane && !S.getSettings().lanes.some((l) => l.id === lane)) throw new HttpError(400, 'Unknown lane.');
  const ext = 'extension_minutes' in b ? int(b.extension_minutes, { min: 0, max: 240, name: 'Extension' }) : t.extension_minutes;
  run('UPDATE teams SET name = ?, lane = ?, table_no = ?, extension_minutes = ? WHERE id = ?', name, lane,
    'table_no' in b ? str(b.table_no, { max: 10 }) : t.table_no, ext, t.id);
  if (ext !== t.extension_minutes) {
    const nt = get('SELECT * FROM teams WHERE id = ?', t.id);
    if (!S.isFrozen(nt)) resetFreezeSnapshot(t.id);
    run('INSERT INTO submission_log (team_id, user_id, action, detail) VALUES (?,?,?,?)', t.id, req.user.id, 'freeze.extension', `${ext} minutes`);
  }
  audit(req.user.id, 'team.update', { id: t.id, name, lane, ext });
  bus.emit(`team:${t.id}`, 'team:update', {});
  bus.emit('all', 'teams:update', {});
  return { ok: true };
}));

r.delete('/admin/teams/:id', wrap((req) => {
  const t = get('SELECT * FROM teams WHERE id = ?', Number(req.params.id));
  if (!t) throw new HttpError(404, 'Team not found.');
  const members = all('SELECT id FROM users WHERE team_id = ?', t.id);
  tx(() => {
    run('UPDATE users SET team_id = NULL WHERE team_id = ?', t.id);
    run('DELETE FROM teams WHERE id = ?', t.id);
  });
  source.purgeTeam(t.id);
  audit(req.user.id, 'team.delete', { id: t.id, name: t.name });
  for (const m of members) bus.syncUser(m.id);
  bus.emit(`team:${t.id}`, 'team:update', {});
  bus.emit('all', 'teams:update', {});
  return { ok: true };
}));

// ---------- validation (4:30–5:00) ----------
r.put('/admin/validation/:teamId', wrap((req) => {
  const t = teamExists(req.params.teamId);
  const b = req.body || {};
  const f = (k) => (b[k] ? 1 : 0);
  run(`INSERT INTO validations (team_id, links_ok, video_ok, brief_ok, disclosure_ok, eligibility_ok, notes, validated_by, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(team_id) DO UPDATE SET links_ok = excluded.links_ok, video_ok = excluded.video_ok,
       brief_ok = excluded.brief_ok, disclosure_ok = excluded.disclosure_ok, eligibility_ok = excluded.eligibility_ok,
       notes = excluded.notes, validated_by = excluded.validated_by, updated_at = excluded.updated_at`,
  t, f('links_ok'), f('video_ok'), f('brief_ok'), f('disclosure_ok'), f('eligibility_ok'), str(b.notes, { max: 1000 }), req.user.id, now());
  audit(req.user.id, 'validation', { team: t });
  return { validation: get('SELECT * FROM validations WHERE team_id = ?', t) };
}));

r.post('/admin/snapshot/:teamId', wrap(async (req) => { await adminSnapshot(Number(req.params.teamId), req.user.id, { useToken: !!(req.body || {}).use_token }); return { ok: true }; }));
r.post('/admin/snapshot-all', wrap(async (req) => {
  const results = [];
  for (const t of all("SELECT t.id, t.name FROM teams t JOIN submissions s ON s.team_id = t.id WHERE s.repo_url != ''")) {
    try { await adminSnapshot(t.id, req.user.id); results.push({ team: t.name, ok: true }); }
    catch (e) { results.push({ team: t.name, ok: false, error: e.message }); }
  }
  return { results };
}));

// ---------- scoring ----------
r.get('/admin/tabulation', wrap(() => {
  const tab = tabulate();
  const awards = Object.fromEntries(all('SELECT * FROM awards').map((a) => [a.award, a]));
  return { ...tab, awards, settings: S.getSettings() };
}));
r.get('/admin/scorecards/:teamId', wrap((req) => ({
  cards: all('SELECT s.*, u.name AS judge FROM scores s JOIN users u ON u.id = s.judge_id WHERE s.team_id = ? ORDER BY u.name', Number(req.params.teamId)),
})));
r.put('/admin/scores/:judgeId/:teamId/exclude', wrap((req) => {
  run('UPDATE scores SET excluded = ? WHERE judge_id = ? AND team_id = ?', (req.body || {}).excluded ? 1 : 0, Number(req.params.judgeId), Number(req.params.teamId));
  audit(req.user.id, 'score.exclude', { judge: req.params.judgeId, team: req.params.teamId, excluded: !!req.body.excluded });
  return { ok: true };
}));
r.put('/admin/awards/:award', wrap((req) => {
  const award = req.params.award;
  if (!S.getSettings().awards.some((a) => a.id === award)) throw new HttpError(404, 'Unknown award.');
  const b = req.body || {};
  const teamId = b.team_id ? teamExists(b.team_id) : null;
  if (teamId && S.getSettings().one_prize_per_team) {
    const other = get('SELECT award FROM awards WHERE team_id = ? AND award != ?', teamId, award);
    if (other && !b.allowDuplicate) throw new HttpError(409, `That team already has the "${other.award}" award (one prize per team).`);
  }
  run('INSERT INTO awards (award, team_id, rationale) VALUES (?,?,?) ON CONFLICT(award) DO UPDATE SET team_id = excluded.team_id, rationale = excluded.rationale',
    award, teamId, str(b.rationale, { max: 400 }));
  audit(req.user.id, 'award', { award, teamId });
  return { ok: true };
}));

// ---------- announcements ----------
r.post('/admin/announce', wrap((req) => {
  const body = str((req.body || {}).body, { max: 4000, required: true, name: 'Announcement' });
  const m = postMessage(req.user, 'announcements', body);
  bus.emit('all', 'announce', m);
  return { message: m };
}));

// ---------- exports ----------
const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // block spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows, cols) => [cols.join(','), ...rows.map((r2) => cols.map((c) => csvCell(r2[c])).join(','))].join('\r\n');
// ---------- rehearsal checklist (Nov 5): what can be checked automatically, plus manual ticks ----------
const REHEARSAL_MANUAL = [
  ['lan', 'A phone on the event Wi-Fi opened the “Same Wi-Fi” address and signed in'],
  ['ngrok', 'If Wi-Fi blocks devices: share-online.bat link tested from a phone (skip if LAN works)'],
  ['testsub', 'A test team made a full submission: repo snapshot, video, brief, disclosures'],
  ['testrun', 'Run in the code editor and a judge “Run it in the sandbox” both worked'],
  ['testscore', 'A judge test-scored the test team; test team then deleted'],
  ['offline', 'Offline judging package built and opened from a USB stick'],
  ['power', 'Laptop plugged in; Windows sleep set to Never; updates paused'],
  ['backup', 'backup.bat ran and the backup copy exists'],
  ['demo', 'demo.bat window closed'],
];
function rehearsalAuto() {
  const st = S.getSettings();
  const n = (sql, ...a) => get(sql, ...a).c;
  const personal = n("SELECT COUNT(*) AS c FROM invites WHERE role = 'participant' AND email != '' AND revoked = 0");
  const shared = n("SELECT COUNT(*) AS c FROM invites WHERE role = 'participant' AND email = '' AND revoked = 0 AND uses < max_uses");
  const judges = n("SELECT COUNT(*) AS c FROM users WHERE role = 'judge' AND disabled = 0");
  const judgeCodes = n("SELECT COUNT(*) AS c FROM invites WHERE role = 'judge' AND revoked = 0 AND uses < max_uses");
  const mentors = n("SELECT COUNT(*) AS c FROM users WHERE role = 'mentor' AND disabled = 0");
  const mentorCodes = n("SELECT COUNT(*) AS c FROM invites WHERE role = 'mentor' AND revoked = 0 AND uses < max_uses");
  const teams = all('SELECT name, table_no FROM teams');
  const noTable = teams.filter((t) => !String(t.table_no || '').trim());
  const r = runner.runnerStatus();
  const T = (k) => Date.parse(st[k]);
  const order = ['roster_lock_at', 'cp1_at', 'cp2_at', 'build_freeze_at', 'validation_end_at'];
  const ordered = order.every((k, i) => i === 0 || T(order[i - 1]) < T(k));
  const freezeShown = new Date(S.displayMs(T('build_freeze_at')));
  const day = freezeShown.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric' });
  let backupAt = null;
  try {
    const dir = path.join(DATA_DIR, 'backups');
    for (const f of fs.readdirSync(dir)) { const m = fs.statSync(path.join(dir, f)).mtimeMs; if (!backupAt || m > backupAt) backupAt = m; }
  } catch {}
  let freeGB = null;
  try { const sf = fs.statfsSync(DATA_DIR); freeGB = (sf.bavail * sf.bsize) / 1e9; } catch {}
  const off = offline.info();
  return [
    { id: 'codes', label: 'Participant access codes made', ok: personal + shared > 0, detail: `${personal} personal, ${shared} shared` },
    { id: 'judges', label: `Judges registered (minimum ${st.min_judges})`, ok: judges >= st.min_judges, detail: `${judges} registered, ${judgeCodes} unused judge code${judgeCodes === 1 ? '' : 's'}` },
    { id: 'mentors', label: 'Mentors registered', ok: mentors > 0, detail: `${mentors} registered, ${mentorCodes} unused mentor code${mentorCodes === 1 ? '' : 's'}` },
    { id: 'tables', label: 'Every team has a table number', ok: teams.length > 0 && !noTable.length, info: !teams.length, detail: teams.length ? (noTable.length ? `Missing: ${noTable.slice(0, 5).map((t) => t.name).join(', ')}${noTable.length > 5 ? '…' : ''}` : `${teams.length} teams`) : 'No teams yet (they form at 8:35 on the day)' },
    { id: 'git', label: 'Git installed (2.39.1 or newer) for repo snapshots', ok: source.gitInfo.ok, detail: source.gitInfo.version ? `git ${source.gitInfo.version}` : 'Git not found: install Git for Windows' },
    { id: 'runner', label: 'Code runner ready (Docker sandbox)', ok: !!r.ready && runner.MODE === 'docker', detail: r.ready ? (runner.MODE === 'docker' ? 'Ready' : `Mode ${runner.MODE}: not safe for students`) : r.reason || 'Not ready' },
    { id: 'times', label: 'Event times in order (roster lock → CP1 → CP2 → freeze → validation)', ok: ordered, detail: `Freeze ${day} ${freezeShown.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })}` },
    { id: 'future', label: 'Build freeze is still ahead', ok: T('build_freeze_at') > Date.now() },
    { id: 'states', label: 'Judging, Q&A and results are switched off before the event', ok: !st.judging_open && !st.finalists_open && !st.results_published },
    { id: 'domains', label: 'Participant email domains set', ok: !!String(st.participant_email_domains || '').trim(), detail: st.participant_email_domains || 'Anyone can register with a participant code' },
    { id: 'notdemo', label: 'This is the real event server (not the demo)', ok: !st.is_demo },
    { id: 'backup', label: 'A backup was made in the last 24 hours', ok: !!backupAt && Date.now() - backupAt < 86400000, warn: true, detail: backupAt ? `Last ${new Date(S.displayMs(backupAt)).toLocaleString('en-US', { timeZone: 'America/New_York' })}` : 'No backup yet: run backup.bat' },
    { id: 'disk', label: 'At least 10 GB free for videos and snapshots', ok: freeGB == null || freeGB >= 10, warn: true, detail: freeGB == null ? 'Unknown' : `${freeGB.toFixed(0)} GB free` },
    { id: 'offline', label: 'Offline judging package built at least once', ok: !!off.built_at, warn: true, detail: off.built_at ? `Built ${new Date(S.displayMs(Date.parse(off.built_at) || off.built_at)).toLocaleString('en-US', { timeZone: 'America/New_York' })}` : 'Admin → Overview → Build offline package' },
  ];
}
r.get('/admin/rehearsal', wrap((req) => {
  const port = Number(process.env.PORT) || 3000;
  const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => `http://${i.address}:${port}`);
  const ticks = S.getSettings().rehearsal || {};
  return { auto: rehearsalAuto(), manual: REHEARSAL_MANUAL.map(([id, label]) => ({ id, label, ...(ticks[id] || { done: false }) })), lan, public_url: process.env.PUBLIC_URL || '' };
}));
r.put('/admin/rehearsal/:id', wrap((req) => {
  const id = req.params.id;
  if (!REHEARSAL_MANUAL.some(([k]) => k === id)) throw new HttpError(404, 'Unknown checklist item.');
  const ticks = { ...(S.getSettings().rehearsal || {}) };
  ticks[id] = (req.body || {}).done ? { done: true, by: req.user.name, at: now() } : { done: false };
  S.setSettings({ rehearsal: ticks });
  audit(req.user.id, 'rehearsal.tick', { id, done: !!ticks[id].done });
  return { ok: true };
}));

// Offline judging package (if the network dies): a folder of static pages to copy to a USB stick.
r.get('/admin/offline-package', wrap(() => offline.info()));
r.post('/admin/offline-package', wrap(async (req) => {
  const out = await offline.buildOnce();
  audit(req.user.id, 'offline.build', { teams: out.teams });
  return out;
}));
r.get('/admin/offline/*', (req, res, next) => {
  try {
    const rel = String(req.params[0] || 'index.html');
    const file = path.resolve(offline.OUT, rel);
    if (!file.startsWith(path.resolve(offline.OUT) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'Not built yet. Press Build.');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https: data:; media-src 'self'; frame-ancestors 'self'");
    // Team-supplied files (anything under source/) are shown as text, never rendered as pages.
    const teamFile = rel.split('/').includes('source');
    if (teamFile ? !/\.(png|jpe?g|gif|webp)$/i.test(file) : !/\.(html|png|jpe?g|gif|webp|mp4|webm|mov|m4v|pdf|docx|zip)$/i.test(file)) res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(file, (err) => { if (err && !res.headersSent) next(err); });
  } catch (e) { next(e); }
});

r.get('/admin/export/:what', (req, res, next) => {
  try {
    let rows, cols;
    const what = req.params.what.replace(/\.csv$/, '');
    if (what === 'scores') {
      rows = all(`SELECT t.name AS team, u.name AS judge, s.innovation, s.impact, s.technical, s.usability, s.presentation, s.adj_technical, s.adj_presentation,
        s.submitted, s.excluded, s.strength, s.risk, s.next_step, s.adj_note, s.updated_at FROM scores s JOIN teams t ON t.id = s.team_id JOIN users u ON u.id = s.judge_id ORDER BY t.name, u.name`);
      cols = ['team', 'judge', 'innovation', 'impact', 'technical', 'usability', 'presentation', 'adj_technical', 'adj_presentation', 'submitted', 'excluded', 'strength', 'risk', 'next_step', 'adj_note', 'updated_at'];
    } else if (what === 'results') {
      rows = tabulate().rows.map((x) => ({ rank: x.rank || '', team: x.team, project: x.project_title, average: x.average, ...x.criteria, judges: x.totals.length, flags: x.flags.join('; ') }));
      cols = ['rank', 'team', 'project', 'average', 'innovation', 'impact', 'technical', 'usability', 'presentation', 'judges', 'flags'];
    } else if (what === 'teams') {
      rows = all(`SELECT t.name AS team, t.table_no, t.lane, t.join_code, u.name, u.email, u.major, u.class_level, u.preferred_role, u.checked_in
        FROM teams t LEFT JOIN users u ON u.team_id = t.id ORDER BY t.name, u.name`);
      cols = ['team', 'table_no', 'lane', 'join_code', 'name', 'email', 'major', 'class_level', 'preferred_role', 'checked_in'];
    } else if (what === 'users') {
      rows = all('SELECT u.name, u.email, u.role, t.name AS team, u.major, u.class_level, u.skills, u.preferred_role, u.checked_in, u.disabled, u.created_at FROM users u LEFT JOIN teams t ON t.id = u.team_id ORDER BY u.role, u.name');
      cols = ['name', 'email', 'role', 'team', 'major', 'class_level', 'skills', 'preferred_role', 'checked_in', 'disabled', 'created_at'];
    } else if (what === 'invites') {
      rows = all("SELECT email, code, role, note, uses, max_uses, revoked FROM invites WHERE email != '' ORDER BY email");
      cols = ['email', 'code', 'role', 'note', 'uses', 'max_uses', 'revoked'];
    } else if (what === 'registrations' || what === 'attendance') {
      rows = all(`SELECT g.name, g.email, g.status, g.major, g.class_level, g.team_mode, g.team_name, g.teammates, g.lane, g.preferred_role, g.skills, g.experience,
        g.technical, g.dietary, g.accommodations, g.media_ok, g.invite_code, g.checked_in_at, g.id_checked, g.staff_note, g.created_at, t.name AS account_team
        FROM registrations g LEFT JOIN users u ON u.email = g.email LEFT JOIN teams t ON t.id = u.team_id ORDER BY ${what === 'attendance' ? "g.checked_in_at = '', g.name" : 'g.id'}`);
      if (what === 'attendance') rows = rows.filter((x) => x.status === 'confirmed' || x.checked_in_at);
      cols = what === 'attendance' ? ['name', 'email', 'status', 'checked_in_at', 'id_checked', 'account_team', 'invite_code', 'dietary', 'accommodations']
        : ['name', 'email', 'status', 'major', 'class_level', 'team_mode', 'team_name', 'teammates', 'lane', 'preferred_role', 'skills', 'experience', 'technical', 'dietary', 'accommodations', 'media_ok', 'invite_code', 'checked_in_at', 'id_checked', 'staff_note', 'created_at'];
    } else if (what === 'mentor-log') {
      rows = all(`SELECT h.created_at, t.name AS team, h.kind, h.summary, h.status, m.name AS mentor, h.mentor_note, h.resolved_at
        FROM help_requests h JOIN teams t ON t.id = h.team_id LEFT JOIN users m ON m.id = h.mentor_id ORDER BY h.id`);
      cols = ['created_at', 'team', 'kind', 'summary', 'status', 'mentor', 'mentor_note', 'resolved_at'];
    } else if (what === 'submission-log') {
      rows = all('SELECT l.created_at, t.name AS team, u.name AS user, l.action, l.detail FROM submission_log l LEFT JOIN teams t ON t.id = l.team_id LEFT JOIN users u ON u.id = l.user_id ORDER BY l.id');
      cols = ['created_at', 'team', 'user', 'action', 'detail'];
    } else throw new HttpError(404, 'Unknown export.');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="hakrathon-${what}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + toCsv(rows, cols));
  } catch (e) { next(e); }
});

r.get('/admin/audit', wrap(() => ({ audit: all('SELECT a.*, u.name FROM audit a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 300') })));

module.exports = { router: r };
