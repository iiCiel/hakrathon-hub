'use strict';
const express = require('express');
const { get, all, run, audit } = require('../db');
const A = require('../auth');
const S = require('../settings');
const runner = require('../runner');
const source = require('../source');
const { wrap, str, now, bus, HttpError } = require('../util');

const r = express.Router();
const MAX_FILES = 200, MAX_FILE = 512 * 1024, MAX_TOTAL = 5 * 1024 * 1024;

function teamOr404(id) {
  const t = get('SELECT * FROM teams WHERE id = ?', Number(id));
  if (!t) throw new HttpError(404, 'Team not found.');
  return t;
}
// Who can see a team's code: its members, admins, mentors, and judges once judging opens / the team is frozen.
function canRead(u, t) {
  if (u.role === 'admin' || u.role === 'mentor') return true;
  if (u.team_id === t.id) return true;
  if (u.role === 'judge') return S.getSettings().judging_open || S.isFrozen(t);
  return false;
}
function canWrite(u, t) {
  if (u.role === 'admin') return true;
  return u.team_id === t.id && !S.isFrozen(t);
}
function readable(req, teamId) {
  const u = A.requireUser(req);
  const t = teamOr404(teamId);
  if (!canRead(u, t)) throw new HttpError(403, 'You cannot view this team’s work.');
  return { u, t };
}
function writable(req, teamId) {
  const { u, t } = readable(req, teamId);
  if (!canWrite(u, t)) throw new HttpError(403, S.isFrozen(t) ? 'Build freeze has passed. Code is read-only.' : 'Read-only.');
  return { u, t };
}

const STARTER = {
  'README.md': '# Our HAkrathon project\n\n**Primary user:** \n\n**Problem:** \n\n**How to run:** \n',
  'main.py': 'print("Hello, HAkrathon!")\n',
};

function listFiles(teamId) {
  if (get('SELECT COUNT(*) AS c FROM files WHERE team_id = ?', teamId).c === 0) {
    for (const [p, c] of Object.entries(STARTER)) run('INSERT OR IGNORE INTO files (team_id, path, content) VALUES (?,?,?)', teamId, p, c);
  }
  return all(`SELECT f.path, f.version, length(CAST(f.content AS BLOB)) AS size, f.updated_at, u.name AS updated_by
    FROM files f LEFT JOIN users u ON u.id = f.updated_by WHERE f.team_id = ? ORDER BY f.path`, teamId);
}

r.get('/workspace/:teamId/files', wrap((req) => {
  const { u, t } = readable(req, req.params.teamId);
  return { files: listFiles(t.id), canWrite: canWrite(u, t), frozen: S.isFrozen(t), freeze_at: new Date(S.freezeAt(t)).toISOString() };
}));

r.get('/workspace/:teamId/file', wrap((req) => {
  const { t } = readable(req, req.params.teamId);
  const p = runner.safeRel(req.query.path || '');
  const f = p && get('SELECT path, content, version, updated_at FROM files WHERE team_id = ? AND path = ?', t.id, p);
  if (!f) throw new HttpError(404, 'File not found.');
  return { file: f };
}));

r.get('/workspace/:teamId/all', wrap((req) => {
  const { t } = readable(req, req.params.teamId);
  return { files: all('SELECT path, content, version FROM files WHERE team_id = ? ORDER BY path', t.id) };
}));

// Saves already on their way at the freeze moment (typed in the last seconds, a slow connection)
// still land: edits to existing files are accepted for a few seconds after the team's freeze.
const FREEZE_GRACE_MS = 5000;
r.put('/workspace/:teamId/file', wrap((req) => {
  const b = req.body || {};
  let ctx;
  try { ctx = writable(req, req.params.teamId); } catch (e) {
    const u0 = req.user, t0 = e.status === 403 && u0 ? get('SELECT * FROM teams WHERE id = ?', Number(req.params.teamId)) : null;
    const late = t0 && u0.team_id === t0.id && S.isFrozen(t0) && Date.now() - S.freezeAt(t0) < FREEZE_GRACE_MS && b.baseVersion !== undefined;
    if (!late) throw e;
    ctx = { u: u0, t: t0 };
  }
  const { u, t } = ctx;
  const p = runner.safeRel(b.path || '');
  if (!p) throw new HttpError(400, 'Use a simple file path like src/app.py (no "..").');
  const content = typeof b.content === 'string' ? b.content : '';
  if (Buffer.byteLength(content) > MAX_FILE) throw new HttpError(413, 'File is too big for the editor (512 KB). Put large files in your GitHub repo.');
  const existing = get('SELECT version, length(CAST(content AS BLOB)) AS size FROM files WHERE team_id = ? AND path = ?', t.id, p);
  const totals = get('SELECT COUNT(*) AS n, COALESCE(SUM(length(CAST(content AS BLOB))),0) AS bytes FROM files WHERE team_id = ?', t.id);
  if (!existing && totals.n >= MAX_FILES) throw new HttpError(413, `Workspace file limit reached (${MAX_FILES}).`);
  if (totals.bytes - (existing ? existing.size : 0) + Buffer.byteLength(content) > MAX_TOTAL) throw new HttpError(413, 'Workspace is full (5 MB). Use GitHub for larger projects.');
  if (existing) {
    if (b.baseVersion !== undefined && !b.force && Number(b.baseVersion) !== existing.version) {
      const cur = get('SELECT f.content, f.version, u.name AS updated_by FROM files f LEFT JOIN users u ON u.id = f.updated_by WHERE f.team_id = ? AND f.path = ?', t.id, p);
      return { conflict: true, current: cur };
    }
    run('UPDATE files SET content = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE team_id = ? AND path = ?', content, u.id, now(), t.id, p);
  } else {
    if (b.create === false) throw new HttpError(404, 'File not found.');
    // An editor saving a file it already had (it sends the version it started from): the file was
    // renamed or deleted meanwhile, so don't bring it back under the old name.
    if (b.baseVersion !== undefined) throw new HttpError(409, 'A teammate renamed or deleted this file. Copy your changes into the file it became.');
    run('INSERT INTO files (team_id, path, content, updated_by, updated_at) VALUES (?,?,?,?,?)', t.id, p, content, u.id, now());
  }
  const f = get('SELECT path, version, updated_at FROM files WHERE team_id = ? AND path = ?', t.id, p);
  bus.emit([`team:${t.id}`, 'helpdesk'], 'file:update', { teamId: t.id, path: p, version: f.version, by: { id: u.id, name: u.name }, created: !existing });
  return { file: f };
}));

r.post('/workspace/:teamId/rename', wrap((req) => {
  const { u, t } = writable(req, req.params.teamId);
  const from = runner.safeRel(req.body.from || ''), to = runner.safeRel(req.body.to || '');
  if (!from || !to) throw new HttpError(400, 'Bad file name.');
  if (!get('SELECT id FROM files WHERE team_id = ? AND path = ?', t.id, from)) throw new HttpError(404, 'File not found.');
  if (get('SELECT id FROM files WHERE team_id = ? AND path = ?', t.id, to)) throw new HttpError(409, 'A file with that name exists.');
  run('UPDATE files SET path = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE team_id = ? AND path = ?', to, u.id, now(), t.id, from);
  bus.emit([`team:${t.id}`, 'helpdesk'], 'file:update', { teamId: t.id, path: to, from, renamed: true, by: { id: u.id, name: u.name } });
  return { ok: true };
}));

r.delete('/workspace/:teamId/file', wrap((req) => {
  const { u, t } = writable(req, req.params.teamId);
  const p = runner.safeRel(req.query.path || '');
  if (!p) throw new HttpError(400, 'Bad file name.');
  run('DELETE FROM files WHERE team_id = ? AND path = ?', t.id, p);
  bus.emit([`team:${t.id}`, 'helpdesk'], 'file:update', { teamId: t.id, path: p, deleted: true, by: { id: u.id, name: u.name } });
  return { ok: true };
}));

// ---------- running code ----------
const inFlight = new Set();
const teamRuns = new Map(); // teamId -> running count (participants)
function runGate(u) {
  const st = runner.runnerStatus();
  if (runner.MODE === 'local' && u.role !== 'admin') throw new HttpError(403, 'Code running is in admin-only test mode. Ask staff.');
  if (!S.getSettings().runner_enabled && u.role !== 'admin') throw new HttpError(403, 'Code running is paused by event staff.');
  if (!st.ready) throw new HttpError(503, `Code runner unavailable: ${st.reason}`);
  if (inFlight.has(u.id)) throw new HttpError(429, 'You already have code running. Wait for it to finish.');
  if (u.role === 'participant' && u.team_id && (teamRuns.get(u.team_id) || 0) >= 2) throw new HttpError(429, 'Two teammates are already running code. Try again in a few seconds.');
  if (!A.rateLimit(`run:${u.id}`, 20, 60000)) throw new HttpError(429, 'Too many runs in a minute. Wait a few seconds.');
}
async function guarded(u, fn) {
  inFlight.add(u.id);
  const t = u.role === 'participant' ? u.team_id : null;
  if (t) teamRuns.set(t, (teamRuns.get(t) || 0) + 1);
  try { return await fn(); } finally {
    inFlight.delete(u.id);
    if (t) teamRuns.set(t, Math.max(0, (teamRuns.get(t) || 1) - 1));
  }
}

r.get('/runner', wrap((req) => {
  A.requireUser(req);
  return { status: runner.runnerStatus(), queue: runner.queueDepth(), langs: Object.fromEntries(Object.entries(runner.LANGS).map(([k, v]) => [k, { name: v.name, entry: v.entry }])) };
}));

r.post('/run', wrap(async (req) => {
  const u = A.requireUser(req);
  runGate(u);
  const b = req.body || {};
  const lang = String(b.lang || '');
  if (!runner.LANGS[lang]) throw new HttpError(400, 'Pick a language.');
  const entry = runner.safeRel(b.entry || runner.LANGS[lang].entry);
  if (!entry) throw new HttpError(400, 'Bad entry file.');
  const files = {};
  if (b.files && typeof b.files === 'object') {
    const keys = Object.keys(b.files);
    if (keys.length > MAX_FILES) throw new HttpError(400, 'Too many files.');
    // Scripts saved on Windows carry CRLF, which bash in the Linux sandbox can't run ($'\r').
    for (const k of keys) files[k] = /\.sh$/i.test(k) ? String(b.files[k] ?? '').replace(/\r\n/g, '\n') : String(b.files[k] ?? '');
  }
  if (!(entry in files)) throw new HttpError(400, `Entry file ${entry} is missing.`);
  const started = Date.now();
  const out = await guarded(u, () => runner.execute({ lang, entry, files, stdin: String(b.stdin || '').slice(0, 65536), timeoutMs: 10000, priority: u.role !== 'participant' }));
  run('INSERT INTO runs (user_id, team_id, kind, lang, exit_code, duration_ms, status) VALUES (?,?,?,?,?,?,?)',
    u.id, u.team_id, 'editor', lang, out.exitCode, Date.now() - started, out.timedOut ? 'timeout' : 'done');
  return out;
}));

// Run a team's submitted repo/zip snapshot with its run command (judges, admins, and the team itself).
r.post('/run/source', wrap(async (req) => {
  const u = A.requireUser(req);
  runGate(u);
  const b = req.body || {};
  const t = teamOr404(b.teamId);
  const isJudge = u.role === 'judge' && (S.getSettings().judging_open || S.isFrozen(t));
  if (!(u.role === 'admin' || isJudge || u.team_id === t.id)) throw new HttpError(403, 'You cannot run this team’s code.');
  const kind = b.kind === 'zip' ? 'zip' : 'repo';
  if (!source.hasSource(t.id, kind)) throw new HttpError(404, kind === 'zip' ? 'No zip uploaded.' : 'No repository snapshot yet.');
  const sub = get('SELECT run_command FROM submissions WHERE team_id = ?', t.id) || {};
  const command = str(b.command || sub.run_command, { max: 500, required: true, name: 'Run command' });
  const started = Date.now();
  const out = await guarded(u, () => runner.execute({ command, srcDir: source.teamDir(t.id, kind), stdin: String(b.stdin || '').slice(0, 65536), timeoutMs: 30000, memory: '512m', priority: u.role !== 'participant' }));
  run('INSERT INTO runs (user_id, team_id, kind, lang, exit_code, duration_ms, status) VALUES (?,?,?,?,?,?,?)',
    u.id, t.id, `source:${kind}`, '', out.exitCode, Date.now() - started, out.timedOut ? 'timeout' : 'done');
  if (u.team_id !== t.id) audit(u.id, 'run.source', { team: t.id, kind });
  return out;
}));

module.exports = { router: r, canRead, canWrite, teamOr404 };
