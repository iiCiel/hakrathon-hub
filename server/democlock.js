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
  registrations: ['created_at', 'updated_at', 'checked_in_at'],
};

// Work that happens later in the day (checkpoints, packages, scores, chat, help requests) is put
// aside when the demo clock goes back before it, and comes back when the clock passes it again.
// Otherwise 8:40 AM would show Checkpoint 2 and finished packages made at 1:30 PM.
// Put-aside rows keep their times as event-day times (stored time minus the shift), so they
// need no moving on later jumps.
const FUTURE = {
  checkpoints: 'submitted_at', validations: 'updated_at', scores: 'updated_at',
  messages: 'created_at', help_requests: 'created_at', submission_log: 'created_at', submissions: 'updated_at',
};
function hideFuture(nowMs, shift) {
  db.exec('CREATE TABLE IF NOT EXISTS demo_future (id INTEGER PRIMARY KEY, tbl TEXT NOT NULL, event_at INTEGER NOT NULL, row TEXT NOT NULL)');
  const isTime = (v) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v);
  const moveRow = (table, row, by) => {
    const out = { ...row };
    for (const c of TIME_COLUMNS[table] || []) if (isTime(out[c])) out[c] = new Date(Date.parse(out[c]) + by).toISOString();
    return out;
  };
  const insert = (table, row) => {
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
  };
  // 1. Bring back what is no longer in the future.
  for (const x of all('SELECT * FROM demo_future WHERE event_at + ? <= ? ORDER BY id', shift, nowMs)) {
    const row = moveRow(x.tbl, JSON.parse(x.row), shift);
    try {
      if (x.tbl === 'submissions') {
        // Only if nobody has worked on that package since it was put aside.
        const cur = db.prepare("SELECT 1 AS x FROM submissions WHERE team_id = ? AND COALESCE(updated_at, '') = ''").get(row.team_id);
        if (cur) { db.prepare('DELETE FROM submissions WHERE team_id = ?').run(row.team_id); insert('submissions', row); }
      } else {
        try { insert(x.tbl, row); } catch (e) {
          // Its id was taken by a newer row: add it with a new id. Anything else (e.g. the team
          // already re-did that checkpoint live) keeps the live version.
          if (!('id' in row)) throw e;
          const { id, ...rest } = row; insert(x.tbl, rest);
        }
      }
    } catch { /* the live version wins */ }
    run('DELETE FROM demo_future WHERE id = ?', x.id);
  }
  // 2. Put aside what is still in the future.
  const now = new Date(nowMs).toISOString();
  for (const [table, col] of Object.entries(FUTURE)) {
    for (const row of all(`SELECT rowid AS _rid, * FROM ${table} WHERE ${col} LIKE '____-__-__T%' AND ${col} > ?`, now)) {
      const { _rid, ...data } = row;
      run('INSERT INTO demo_future (tbl, event_at, row) VALUES (?,?,?)', table, Date.parse(row[col]) - shift, JSON.stringify(moveRow(table, data, -shift)));
      if (table === 'submissions') {
        run('DELETE FROM submissions WHERE team_id = ?', row.team_id);
        run("INSERT INTO submissions (team_id, updated_at) VALUES (?, '')", row.team_id);
      } else run(`DELETE FROM ${table} WHERE rowid = ?`, _rid);
    }
  }
}

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
      meals: (s.meals || []).map((x) => ({ ...x, start: mv(x.start), end: mv(x.end) })),
      demo_shift_ms: newShift,
      judging_open: stage.judging, ...(stage.judging ? {} : { finalists_open: false, results_published: false }),
    });
    hideFuture(nowMs, newShift);
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
