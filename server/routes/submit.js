'use strict';
const express = require('express');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const { get, all, run, audit, DATA_DIR } = require('../db');
const A = require('../auth');
const S = require('../settings');
const source = require('../source');
const { canRead, teamOr404 } = require('./workspace');
const { getCheckpoints } = require('./core');
const { wrap, str, url, now, bus, HttpError } = require('../util');

const r = express.Router();
const UP_DIR = path.join(DATA_DIR, 'uploads');
const TMP_DIR = path.join(UP_DIR, 'tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

const BRIEF_FIELDS = [
  ['team_roles', 'Team and roles', 600], ['user', 'Primary user', 400], ['problem', 'Problem', 1200],
  ['solution', 'Solution', 1500], ['success_metric', 'Success metric', 600], ['architecture', 'Architecture / approach', 1500],
  ['limitations', 'Current limitations', 1000], ['implementation_path', 'Implementation path', 1000],
];
const DISCLOSURE_FIELDS = [
  ['data_sources', 'Data sources', 1200], ['apis_libraries', 'APIs and libraries', 1500], ['templates', 'Templates and pre-existing assets', 1000],
  ['ai_use', 'AI / model use', 2000], ['licenses', 'Licenses', 800], ['external_help', 'External assistance', 800],
];
const UPLOADS = {
  video: { col: 'video_file', max: 500, exts: { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4' }, inline: true },
  brief: { col: 'brief_file', max: 15, exts: { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, inline: ['.pdf'] },
  fallback: { col: 'fallback_file', max: 100, exts: { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.zip': 'application/zip' }, inline: ['.png', '.jpg', '.jpeg', '.pdf', '.mp4', '.webm'] },
};

function subRow(teamId) {
  let s = get('SELECT * FROM submissions WHERE team_id = ?', teamId);
  if (!s) { run('INSERT INTO submissions (team_id, updated_at) VALUES (?, ?)', teamId, now()); s = get('SELECT * FROM submissions WHERE team_id = ?', teamId); }
  return s;
}
function log(teamId, userId, action, detail = '') {
  run('INSERT INTO submission_log (team_id, user_id, action, detail) VALUES (?,?,?,?)', teamId, userId, action, detail);
}

function completeness(t, s, cps) {
  const st = S.getSettings();
  const brief = JSON.parse(s.brief || '{}'), disc = JSON.parse(s.disclosure || '{}');
  const members = get('SELECT COUNT(*) AS c FROM users WHERE team_id = ? AND disabled = 0', t.id).c;
  const briefOk = !!s.brief_file || BRIEF_FIELDS.every(([k]) => (brief[k] || '').trim());
  const discOk = DISCLOSURE_FIELDS.every(([k]) => (disc[k] || '').trim());
  const videoTooLong = s.video_seconds && s.video_seconds > st.max_video_seconds + 0.5;
  const items = [
    { id: 'roster', label: `Roster has ${st.team_min}–${st.team_max} members`, ok: members >= st.team_min && members <= st.team_max, detail: `${members} member${members === 1 ? '' : 's'}` },
    { id: 'lane', label: 'Solution lane chosen', ok: !!t.lane },
    { id: 'cp1', label: 'Checkpoint 1: problem statement', ok: !!cps.cp1, detail: cps.cp1 && cps.cp1.late ? 'submitted late' : '' },
    { id: 'cp2', label: 'Checkpoint 2: demo plan', ok: !!cps.cp2, detail: cps.cp2 && cps.cp2.late ? 'submitted late' : '' },
    { id: 'prototype', label: '1. Working prototype (repo, zip, or live link)', ok: !!(s.repo_sha || s.zip_at || s.prototype_url), required: true },
    { id: 'video', label: '2. Recorded demo (5:00 max)', ok: !!(s.video_url || s.video_file), required: true, warn: videoTooLong ? `Video is ${fmtDur(s.video_seconds)} — judging stops at 5:00` : '' },
    { id: 'brief', label: '3. One-page project brief', ok: briefOk, required: true },
    { id: 'disclosure', label: '4. Disclosure appendix', ok: discOk, required: true },
    { id: 'fallback', label: 'Backup evidence (screenshots or short capture)', ok: !!s.fallback_file, optional: true },
  ];
  const complete = items.filter((i) => i.required).every((i) => i.ok);
  return { items, complete };
}
const fmtDur = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

function shapeSub(t, s, viewer) {
  const cps = getCheckpoints(t.id);
  return {
    team_id: t.id, project_title: s.project_title, prototype_url: s.prototype_url,
    repo_url: s.repo_url, repo_sha: s.repo_sha, repo_branch: s.repo_branch, repo_commit_date: s.repo_commit_date,
    repo_snapshot_at: s.repo_snapshot_at, repo_error: s.repo_error, repo_final: !!s.repo_final,
    // "Official" only when the freeze snapshot actually succeeded (taken at/after this team's freeze, no error).
    repo_official: !!s.repo_final && !s.repo_error && !!s.repo_snapshot_at && Date.parse(s.repo_snapshot_at) >= S.freezeAt(t) - 1000,
    zip_name: s.zip_name, zip_at: s.zip_at, has_repo: source.hasSource(t.id, 'repo'), has_zip: source.hasSource(t.id, 'zip'),
    video_url: s.video_url, video_file: !!s.video_file, video_seconds: s.video_seconds,
    brief: JSON.parse(s.brief || '{}'), brief_file: s.brief_file ? path.extname(s.brief_file) : '',
    disclosure: JSON.parse(s.disclosure || '{}'), fallback_file: s.fallback_file ? path.extname(s.fallback_file) : '',
    run_lang: s.run_lang, run_command: s.run_command, updated_at: s.updated_at,
    checkpoints: cps, completeness: completeness(t, s, cps),
    frozen: S.isFrozen(t), freeze_at: new Date(S.freezeAt(t)).toISOString(),
    canEdit: viewer.role === 'admin' || (viewer.team_id === t.id && !S.isFrozen(t)),
  };
}

function viewable(req, teamId) {
  const u = A.requireUser(req);
  const t = teamOr404(teamId);
  if (!canRead(u, t)) throw new HttpError(403, u.role === 'judge' ? 'Submissions open to judges at build freeze (or when staff open judging).' : 'You cannot view this submission.');
  return { u, t };
}
function editable(req) {
  const u = A.requireUser(req);
  const teamId = u.role === 'admin' && req.query.team ? Number(req.query.team) : u.team_id;
  if (!teamId) throw new HttpError(400, 'Join a team first.');
  const t = teamOr404(teamId);
  if (u.role !== 'admin') {
    if (u.role !== 'participant' || u.team_id !== t.id) throw new HttpError(403, 'Not your team.');
    if (S.isFrozen(t)) throw new HttpError(403, 'Build freeze has passed. Submissions are locked.');
  }
  return { u, t };
}
const changed = (t) => { bus.emit(`team:${t.id}`, 'submission:update', { teamId: t.id }); bus.emit('staff', 'staff:update', { kind: 'submission', teamId: t.id }); };

r.get('/submission', wrap((req) => {
  const u = A.requireUser(req);
  if (!u.team_id) throw new HttpError(400, 'Join a team first.');
  const t = teamOr404(u.team_id);
  return { submission: shapeSub(t, subRow(t.id), u), briefFields: BRIEF_FIELDS, disclosureFields: DISCLOSURE_FIELDS };
}));

r.get('/submissions/:teamId', wrap((req) => {
  const { u, t } = viewable(req, req.params.teamId);
  const members = all('SELECT name, preferred_role, major FROM users WHERE team_id = ? AND disabled = 0', t.id);
  return { team: { id: t.id, name: t.name, lane: t.lane, table_no: t.table_no, members }, submission: shapeSub(t, subRow(t.id), u), briefFields: BRIEF_FIELDS, disclosureFields: DISCLOSURE_FIELDS };
}));

r.put('/submission', wrap((req) => {
  const { u, t } = editable(req);
  const s = subRow(t.id);
  const b = req.body || {};
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if ('brief' in b && !isObj(b.brief)) throw new HttpError(400, 'Bad brief.');
  if ('disclosure' in b && !isObj(b.disclosure)) throw new HttpError(400, 'Bad disclosure.');
  const brief = {}, disc = {};
  const oldBrief = JSON.parse(s.brief || '{}'), oldDisc = JSON.parse(s.disclosure || '{}');
  for (const [k, label, max] of BRIEF_FIELDS) brief[k] = b.brief && k in b.brief ? str(b.brief[k], { max, name: label }) : (oldBrief[k] || '');
  for (const [k, label, max] of DISCLOSURE_FIELDS) disc[k] = b.disclosure && k in b.disclosure ? str(b.disclosure[k], { max, name: label }) : (oldDisc[k] || '');
  const pick = (k, fn) => (k in b ? fn(b[k]) : s[k]);
  const lang = pick('run_lang', (v) => str(v, { max: 20 }));
  run(`UPDATE submissions SET project_title = ?, prototype_url = ?, video_url = ?, video_seconds = ?, brief = ?, disclosure = ?,
       run_lang = ?, run_command = ?, updated_at = ? WHERE team_id = ?`,
  pick('project_title', (v) => str(v, { max: 120, name: 'Project title' })),
  pick('prototype_url', (v) => url(v, { name: 'Prototype link' })),
  pick('video_url', (v) => url(v, { name: 'Demo video link' })),
  'video_seconds' in b ? (b.video_seconds === null || b.video_seconds === '' ? null : Math.max(0, Math.min(36000, Number(b.video_seconds) || 0))) : s.video_seconds,
  JSON.stringify(brief), JSON.stringify(disc), lang,
  pick('run_command', (v) => str(v, { max: 500, name: 'Run command' })), now(), t.id);
  log(t.id, u.id, 'package.save');
  changed(t);
  return { submission: shapeSub(t, subRow(t.id), u) };
}));

// Per-team lock so two teammates can't start overlapping clones.
const cloning = new Set();
async function doSnapshot(t, repoUrl, userId, final = false, useToken = false) {
  if (cloning.has(t.id)) throw new HttpError(409, 'A snapshot is already in progress for this team.');
  const other = get("SELECT t.name FROM submissions s JOIN teams t ON t.id = s.team_id WHERE s.team_id != ? AND lower(s.repo_url) = lower(?)", t.id, repoUrl);
  if (other) throw new HttpError(409, 'Another team already linked that repository. Use your own team\'s repo, or ask staff.');
  cloning.add(t.id);
  try {
    const snap = await source.snapshotRepo(t.id, repoUrl, { useToken, before: final ? S.freezeAt(t) : 0 });
    run(`UPDATE submissions SET repo_url = ?, repo_sha = ?, repo_branch = ?, repo_commit_date = ?, repo_snapshot_at = ?, repo_error = '',
         repo_final = ?, updated_at = ? WHERE team_id = ?`, snap.url, snap.sha, snap.branch, snap.commitDate, now(), final ? 1 : 0, now(), t.id);
    log(t.id, userId, final ? 'repo.final-snapshot' : 'repo.snapshot', `${snap.url}@${snap.sha}${final ? (snap.afterFreeze ? ' (no commit before the freeze; took the latest)' : ' (last commit before the freeze)') : ''}`);
    return snap;
  } catch (e) {
    const msg = e.status ? e.message : 'Snapshot failed on the server. Try again or ask staff.';
    if (!e.status) console.error(`[snapshot] team ${t.id}:`, e);
    const cur = get('SELECT repo_url, repo_sha FROM submissions WHERE team_id = ?', t.id) || {};
    if (cur.repo_sha && String(cur.repo_url).toLowerCase() !== String(repoUrl).toLowerCase()) {
      // Keep URL and snapshot in agreement: the files on record are still from the old repo.
      run('UPDATE submissions SET repo_error = ?, updated_at = ? WHERE team_id = ?', `${msg} (tried ${repoUrl}; the snapshot on record is still from ${cur.repo_url})`, now(), t.id);
    } else run('UPDATE submissions SET repo_url = ?, repo_error = ?, updated_at = ? WHERE team_id = ?', repoUrl, msg, now(), t.id);
    log(t.id, userId, final ? 'repo.final-snapshot-failed' : 'repo.snapshot-failed', msg);
    throw e.status ? e : new HttpError(500, msg);
  } finally { cloning.delete(t.id); }
}

r.post('/submission/repo', wrap(async (req) => {
  const { u, t } = editable(req);
  const repoUrl = str((req.body || {}).repo_url, { max: 300, required: true, name: 'Repository URL' });
  const gh = source.parseGithubUrl(repoUrl);
  if (!gh) throw new HttpError(400, 'Use a GitHub repository URL like https://github.com/owner/repo');
  if (!A.rateLimit(`snap:${t.id}`, 8, 10 * 60000)) throw new HttpError(429, 'Too many snapshots. Wait a few minutes.');
  await doSnapshot(t, gh.url, u.id);
  changed(t);
  return { submission: shapeSub(t, subRow(t.id), u) };
}));

r.delete('/submission/repo', wrap((req) => {
  const { u, t } = editable(req);
  fsp.rm(source.teamDir(t.id, 'repo'), { recursive: true, force: true }).catch(() => {});
  run("UPDATE submissions SET repo_url = '', repo_sha = '', repo_branch = '', repo_commit_date = '', repo_snapshot_at = '', repo_error = '', repo_final = 0 WHERE team_id = ?", t.id);
  log(t.id, u.id, 'repo.remove');
  changed(t);
  return { submission: shapeSub(t, subRow(t.id), u) };
}));

// ---------- uploads ----------
const upload = (maxMb) => multer({ dest: TMP_DIR, limits: { fileSize: maxMb * 1024 * 1024, files: 1, fields: 10 } }).single('file');
function guardUpload(req, _res, next) {
  try {
    req.ctx = editable(req);
    if (!A.rateLimit(`upload:${req.ctx.t.id}`, 20, 10 * 60000)) throw new HttpError(429, 'Too many uploads from your team. Wait a few minutes.');
    next();
  } catch (e) { next(e); }
}
function runUpload(mw) {
  return (req, res, next) => mw(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, 'That file is too large.'));
    if (err && err.name === 'MulterError') return next(new HttpError(400, 'Upload one file in the "file" field.'));
    next(err);
  });
}

r.post('/submission/zip', guardUpload, runUpload(upload(100)), wrap(async (req) => {
  const { u, t } = req.ctx;
  if (!req.file) throw new HttpError(400, 'Choose a .zip file.');
  let skipped = [];
  try {
    if (path.extname(req.file.originalname).toLowerCase() !== '.zip') throw new HttpError(400, 'Upload a .zip file.');
    const res = await source.extractZip(t.id, req.file.path);
    const name = req.file.originalname.slice(0, 120);
    run('UPDATE submissions SET zip_name = ?, zip_at = ?, updated_at = ? WHERE team_id = ?', name, now(), now(), t.id);
    log(t.id, u.id, 'zip.upload', `${name} (${res.files} files${res.skipped.length ? `, ${res.skipped.length} skipped: ${res.skipped.slice(0, 5).map((x) => `${x.path} (${x.why})`).join('; ')}` : ''})`);
    skipped = res.skipped;
  } finally { fsp.rm(req.file.path, { force: true }).catch(() => {}); }
  changed(t);
  return { submission: shapeSub(t, subRow(t.id), u), skipped };
}));

r.delete('/submission/zip', wrap((req) => {
  const { u, t } = editable(req);
  fsp.rm(source.teamDir(t.id, 'zip'), { recursive: true, force: true }).catch(() => {});
  run("UPDATE submissions SET zip_name = '', zip_at = '' WHERE team_id = ?", t.id);
  log(t.id, u.id, 'zip.remove');
  changed(t);
  return { submission: shapeSub(t, subRow(t.id), u) };
}));

for (const [kind, spec] of Object.entries(UPLOADS)) {
  r.post(`/submission/${kind}`, guardUpload, runUpload(upload(spec.max)), wrap(async (req) => {
    const { u, t } = req.ctx;
    if (!req.file) throw new HttpError(400, 'Choose a file.');
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!spec.exts[ext]) { fsp.rm(req.file.path, { force: true }).catch(() => {}); throw new HttpError(400, `Allowed types: ${Object.keys(spec.exts).join(', ')}`); }
    const dir = path.join(UP_DIR, `team-${t.id}`);
    await fsp.mkdir(dir, { recursive: true });
    const old = subRow(t.id)[spec.col];
    const name = `${kind}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    await fsp.rename(req.file.path, path.join(dir, name));
    if (old) fsp.rm(path.join(dir, old), { force: true }).catch(() => {});
    const secs = kind === 'video' && req.body.seconds ? Math.max(0, Math.min(36000, Number(req.body.seconds) || 0)) : null;
    if (kind === 'video') run('UPDATE submissions SET video_file = ?, video_seconds = COALESCE(?, video_seconds), updated_at = ? WHERE team_id = ?', name, secs, now(), t.id);
    else run(`UPDATE submissions SET ${spec.col} = ?, updated_at = ? WHERE team_id = ?`, name, now(), t.id);
    log(t.id, u.id, `${kind}.upload`, `${req.file.originalname.slice(0, 120)} (${Math.round(req.file.size / 1024)} KB)`);
    changed(t);
    return { submission: shapeSub(t, subRow(t.id), u) };
  }));

  r.delete(`/submission/${kind}`, wrap((req) => {
    const { u, t } = editable(req);
    const old = subRow(t.id)[spec.col];
    if (old) fsp.rm(path.join(UP_DIR, `team-${t.id}`, old), { force: true }).catch(() => {});
    run(`UPDATE submissions SET ${spec.col} = ''${kind === 'video' ? ', video_seconds = NULL' : ''} WHERE team_id = ?`, t.id);
    log(t.id, u.id, `${kind}.remove`);
    changed(t);
    return { submission: shapeSub(t, subRow(t.id), u) };
  }));

  r.get(`/submissions/:teamId/${kind}`, (req, res, next) => {
    try {
      const { t } = viewable(req, req.params.teamId);
      const f = subRow(t.id)[spec.col];
      if (!f) throw new HttpError(404, 'No file uploaded.');
      const ext = path.extname(f).toLowerCase();
      const inline = spec.inline === true || (Array.isArray(spec.inline) && spec.inline.includes(ext));
      res.setHeader('Content-Type', spec.exts[ext] || 'application/octet-stream');
      res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="team-${t.id}-${kind}${ext}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.sendFile(path.join(UP_DIR, `team-${t.id}`, f), { headers: { 'Content-Type': spec.exts[ext] } }, (err) => { if (err && !res.headersSent) next(err); });
    } catch (e) { next(e); }
  });
}

// ---------- source browsing (repo snapshot / zip) ----------
r.get('/source/:teamId/:kind/tree', wrap(async (req) => {
  const { t } = viewable(req, req.params.teamId);
  const kind = req.params.kind === 'zip' ? 'zip' : 'repo';
  return { tree: await source.listTree(t.id, kind), readme: await source.readme(t.id, kind) };
}));
r.get('/source/:teamId/:kind/file', wrap(async (req) => {
  const { t } = viewable(req, req.params.teamId);
  const kind = req.params.kind === 'zip' ? 'zip' : 'repo';
  return { file: await source.readSourceFile(t.id, kind, String(req.query.path || '')) };
}));

r.get('/submissions/:teamId/log', wrap((req) => {
  const { t } = viewable(req, req.params.teamId);
  return { log: all('SELECT l.action, l.detail, l.created_at, u.name FROM submission_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.team_id = ? ORDER BY l.id DESC LIMIT 200', t.id) };
}));

// ---------- build-freeze sweep: take the official repo snapshot when each team freezes ----------
const finalizing = new Set();
const finalTries = new Map(), finalRetryAt = new Map();
async function freezeSweep() {
  const due = all('SELECT * FROM teams').filter((t) => {
    if (!S.isFrozen(t) || finalizing.has(t.id) || cloning.has(t.id)) return false; // a running snapshot: next sweep
    if (Date.now() < (finalRetryAt.get(t.id) || 0)) return false;
    const s = get('SELECT repo_url, repo_final FROM submissions WHERE team_id = ?', t.id);
    return s && s.repo_url && !s.repo_final;
  });
  // All teams freeze at once, so clone in parallel (a few at a time) rather than one by one.
  const one = async (t) => {
    const s = get('SELECT repo_url FROM submissions WHERE team_id = ?', t.id);
    finalizing.add(t.id);
    try {
      await doSnapshot(t, s.repo_url, null, true);
      console.log(`[freeze] final snapshot taken for team ${t.name}`);
      finalTries.delete(t.id); finalRetryAt.delete(t.id);
    } catch (e) {
      // Wi-Fi blips happen at 4:30: try three times, 30 s then 90 s apart, then leave it to staff.
      const n = (finalTries.get(t.id) || 0) + 1;
      finalTries.set(t.id, n);
      if (n >= 3) {
        run('UPDATE submissions SET repo_final = 1, repo_error = ? WHERE team_id = ?', `Official freeze snapshot failed (${e.message}) Staff: use Re-snapshot repo.`, t.id);
        finalTries.delete(t.id); finalRetryAt.delete(t.id);
      } else finalRetryAt.set(t.id, Date.now() + (n === 1 ? 30000 : 90000));
      console.log(`[freeze] final snapshot attempt ${n} failed for team ${t.name}: ${e.message}`);
    } finally { finalizing.delete(t.id); changed(t); }
  };
  const queue = [...due];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => { while (queue.length) await one(queue.shift()); }));
}
async function adminSnapshot(teamId, userId) {
  const t = teamOr404(teamId);
  const s = subRow(t.id);
  if (!s.repo_url) throw new HttpError(400, 'Team has no repository URL.');
  await doSnapshot(t, s.repo_url, userId, S.isFrozen(t), true);
  audit(userId, 'repo.admin-snapshot', { team: t.id });
  changed(t);
}

module.exports = { router: r, completeness, subRow, freezeSweep, adminSnapshot, BRIEF_FIELDS, DISCLOSURE_FIELDS, shapeSub };
