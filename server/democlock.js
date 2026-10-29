'use strict';
// Demo only: move the whole demo so "now" is a chosen moment on event day (e.g. 1:30 PM, 5:15 PM).
// Event times AND every stored timestamp move by the same amount, so checkpoints stay on time,
// chat stays in order, and the browser can show event-day clock times (it subtracts demo_shift_ms).
const { db, all, run } = require('./db');
const S = require('./settings');

const STAGES = [
  { id: 'morning', at: '08:40', label: '8:40 AM · Team lock & ideation', judging: false },
  { id: 'sprint', at: '13:30', label: '1:30 PM · Build Sprint 2', judging: false },
  { id: 'prefreeze', at: '16:20', label: '4:20 PM · 10 min before the build freeze', judging: false },
  { id: 'judging', at: '17:15', label: '5:15 PM · Primary judging', judging: true },
  { id: 'awards', at: '18:55', label: '6:55 PM · Final decision & awards', judging: true },
];

// ISO text columns (written by toISOString() or strftime('%Y-%m-%dT%H:%M:%fZ')).
const TIME_COLUMNS = {
  users: ['created_at'], invites: ['created_at'], teams: ['created_at'], messages: ['created_at'],
  help_requests: ['created_at', 'claimed_at', 'resolved_at'], files: ['updated_at'], runs: ['created_at'],
  checkpoints: ['submitted_at', 'updated_at'], submissions: ['repo_snapshot_at', 'zip_at', 'updated_at'],
  submission_log: ['created_at'], validations: ['updated_at'], scores: ['updated_at'], audit: ['created_at'],
};

function jump(stageId, nowMs = Date.now()) {
  const s = S.getSettings();
  if (!s.is_demo) throw new Error('The demo clock only works in the demo.');
  const stage = STAGES.find((x) => x.id === stageId);
  if (!stage) throw new Error('Unknown demo stage.');
  const newShift = nowMs - Date.parse(S.T(stage.at));
  const delta = newShift - (Number(s.demo_shift_ms) || 0);
  const mv = (iso) => new Date(Date.parse(iso) + delta).toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const cols = new Set();
    for (const [table, list] of Object.entries(TIME_COLUMNS)) {
      for (const c of db.prepare(`PRAGMA table_info(${table})`).all()) cols.add(`${table}.${c.name}`);
      for (const col of list) {
        if (!cols.has(`${table}.${col}`)) continue;
        db.prepare(`UPDATE ${table} SET ${col} = strftime('%Y-%m-%dT%H:%M:%fZ', julianday(${col}) + ? / 86400000.0) WHERE ${col} LIKE '____-__-__T%'`).run(delta);
      }
    }
    S.setSettings({
      roster_lock_at: mv(s.roster_lock_at), cp1_at: mv(s.cp1_at), cp2_at: mv(s.cp2_at), upload_open_at: mv(s.upload_open_at),
      build_freeze_at: mv(s.build_freeze_at), validation_end_at: mv(s.validation_end_at),
      schedule: s.schedule.map((x) => ({ ...x, start: mv(x.start), end: mv(x.end) })),
      demo_shift_ms: newShift,
      judging_open: stage.judging, ...(stage.judging ? {} : { finalists_open: false, results_published: false }),
    });
    // Back before the freeze: the official repo snapshot has to be taken again at the freeze.
    for (const t of all('SELECT * FROM teams')) if (!S.isFrozen(t)) run("UPDATE submissions SET repo_final = 0, repo_freeze_head = '' WHERE team_id = ?", t.id);
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  return stage;
}

// What event-day time the demo is at right now ("HH:MM" in event time), or null outside the demo.
function demoNow(nowMs = Date.now()) {
  const s = S.getSettings();
  if (!s.is_demo) return null;
  return new Date(nowMs - (Number(s.demo_shift_ms) || 0));
}

module.exports = { STAGES, jump, demoNow };
