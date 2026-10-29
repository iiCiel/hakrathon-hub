'use strict';
// SQLite via Node's built-in driver (no native build step on Windows).
const fs = require('node:fs');
const path = require('node:path');

// Silence the one-time "SQLite is experimental" warning so the console stays readable.
const origEmit = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  const msg = typeof w === 'string' ? w : w && w.message;
  if (msg && msg.includes('SQLite is an experimental feature')) return;
  return origEmit.call(process, w, ...rest);
};
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'hakrathon.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin','judge','mentor','participant')),
  github_id TEXT UNIQUE,
  github_login TEXT,
  major TEXT DEFAULT '',
  class_level TEXT DEFAULT '',
  skills TEXT DEFAULT '',
  preferred_role TEXT DEFAULT '',
  agreed_rules INTEGER NOT NULL DEFAULT 0,
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  checked_in INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  note TEXT DEFAULT '',
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  join_code TEXT NOT NULL UNIQUE,
  lane TEXT DEFAULT '',
  table_no TEXT DEFAULT '',
  extension_minutes INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, id);
CREATE TABLE IF NOT EXISTS help_requests (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  mentor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  mentor_note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  claimed_at TEXT,
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (team_id, path)
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  team_id INTEGER,
  kind TEXT NOT NULL,
  lang TEXT,
  exit_code INTEGER,
  duration_ms INTEGER,
  status TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS checkpoints (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  submitted_by INTEGER,
  submitted_at TEXT NOT NULL,
  late INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (team_id, kind)
);
CREATE TABLE IF NOT EXISTS submissions (
  team_id INTEGER PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  project_title TEXT DEFAULT '',
  prototype_url TEXT DEFAULT '',
  repo_url TEXT DEFAULT '',
  repo_sha TEXT DEFAULT '',
  repo_commit_date TEXT DEFAULT '',
  repo_snapshot_at TEXT DEFAULT '',
  repo_error TEXT DEFAULT '',
  repo_branch TEXT DEFAULT '',
  repo_final INTEGER NOT NULL DEFAULT 0,
  zip_name TEXT DEFAULT '',
  zip_at TEXT DEFAULT '',
  source_kind TEXT DEFAULT '',
  video_url TEXT DEFAULT '',
  video_file TEXT DEFAULT '',
  video_seconds REAL,
  brief TEXT DEFAULT '{}',
  brief_file TEXT DEFAULT '',
  disclosure TEXT DEFAULT '{}',
  fallback_file TEXT DEFAULT '',
  run_lang TEXT DEFAULT '',
  run_command TEXT DEFAULT '',
  updated_at TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS submission_log (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS validations (
  team_id INTEGER PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  links_ok INTEGER NOT NULL DEFAULT 0,
  video_ok INTEGER NOT NULL DEFAULT 0,
  brief_ok INTEGER NOT NULL DEFAULT 0,
  disclosure_ok INTEGER NOT NULL DEFAULT 0,
  eligibility_ok INTEGER NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  validated_by INTEGER,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS conflicts (
  judge_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  reason TEXT DEFAULT '',
  PRIMARY KEY (judge_id, team_id)
);
CREATE TABLE IF NOT EXISTS scores (
  judge_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  innovation INTEGER, impact INTEGER, technical INTEGER, usability INTEGER, presentation INTEGER,
  adj_technical INTEGER, adj_presentation INTEGER, adj_note TEXT DEFAULT '',
  strength TEXT DEFAULT '', risk TEXT DEFAULT '', next_step TEXT DEFAULT '',
  submitted INTEGER NOT NULL DEFAULT 0,
  excluded INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  PRIMARY KEY (judge_id, team_id)
);
CREATE TABLE IF NOT EXISTS awards (
  award TEXT PRIMARY KEY,
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  rationale TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`);

// Columns added after the first release (CREATE TABLE IF NOT EXISTS won't add them to an existing file).
function addColumn(table, col, def) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('invites', 'email', "TEXT DEFAULT ''");
addColumn('checkpoints', 'updated_at', "TEXT DEFAULT ''");
addColumn('checkpoints', 'updated_by', 'INTEGER');
addColumn('submissions', 'repo_after_freeze', 'INTEGER DEFAULT 0');
addColumn('submissions', 'repo_freeze_head', "TEXT DEFAULT ''"); // "<url> <sha>": what GitHub had at the freeze

const stmtCache = new Map();
function prep(sql) {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}
const get = (sql, ...p) => prep(sql).get(...p);
const all = (sql, ...p) => prep(sql).all(...p);
const run = (sql, ...p) => prep(sql).run(...p);

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

function audit(userId, action, detail = '') {
  run('INSERT INTO audit (user_id, action, detail) VALUES (?,?,?)', userId ?? null, action,
    typeof detail === 'string' ? detail : JSON.stringify(detail));
}

module.exports = { db, get, all, run, tx, audit, DATA_DIR };
