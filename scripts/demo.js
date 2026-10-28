'use strict';
// Demo mode: a separate data folder (data-demo) filled with sample teams, shifted so "now" is
// the middle of Build Sprint 2. Lets you click through every role before the real event.
const path = require('node:path');
const fs = require('node:fs');
// The demo never touches the real data folder, and by default only this computer can open it
// (its accounts share a published password).
process.env.DATA_DIR = path.resolve(process.env.DEMO_DATA_DIR || path.join(__dirname, '..', 'data-demo'));
if (path.basename(process.env.DATA_DIR) === 'data' || fs.existsSync(path.join(process.env.DATA_DIR, 'ADMIN-SETUP.txt'))) {
  console.error('  Refusing to run the demo in what looks like the real data folder. Use data-demo.');
  process.exit(1);
}
const fresh = !fs.existsSync(path.join(process.env.DATA_DIR, 'hakrathon.db'));
const { server } = require('../server/index.js');
const { get, run } = require('../server/db');
const A = require('../server/auth');
const S = require('../server/settings');

const PW = 'demo-pass-2026';
const PORT = Number(process.env.DEMO_PORT) || 3100;
const HOST = process.env.DEMO_HOST || '127.0.0.1';

function user(email, name, role, extra = {}) {
  run(`INSERT INTO users (email, name, password_hash, role, agreed_rules, major, preferred_role, skills, team_id, checked_in) VALUES (?,?,?,?,1,?,?,?,?,1)`,
    email, name, A.hashPassword(PW), role, extra.major || '', extra.pref || '', extra.skills || '', extra.team || null);
  return get('SELECT id FROM users WHERE email = ?', email).id;
}

function seed() {
  // Shift every event time so that "now" is 1:30 p.m. on event day.
  const s = S.getSettings();
  const shift = Date.now() - Date.parse('2026-11-06T13:30:00-05:00');
  const mv = (iso) => new Date(Date.parse(iso) + shift).toISOString();
  S.setSettings({
    roster_lock_at: mv(s.roster_lock_at), cp1_at: mv(s.cp1_at), cp2_at: mv(s.cp2_at), upload_open_at: mv(s.upload_open_at),
    build_freeze_at: mv(s.build_freeze_at), validation_end_at: mv(s.validation_end_at), challenge_released: true,
    event_name: 'HAkrathon DEMO', is_demo: true,
    schedule: s.schedule.map((x) => ({ ...x, start: mv(x.start), end: mv(x.end) })),
  });
  user('admin@demo.uakron.edu', 'Demo Admin', 'admin');
  for (const [i, n] of ['Dr. Rivera', 'Pat Chen', 'Alex Morgan'].entries()) user(`judge${i + 1}@demo.com`, n, 'judge');
  user('mentor@demo.com', 'Morgan Mentor', 'mentor');
  const teams = [
    ['ZipQueue', 'student', '1', [['Ava Patel', 'Technical builder', 'Computer Science'], ['Ben Ortiz', 'Problem / business lead', 'Marketing'], ['Chloe Kim', 'Presentation / UX lead', 'Graphic Design']]],
    ['Phish Finders', 'cyber', '2', [['Dan Wu', 'Technical builder', 'Cybersecurity'], ['Eve Brooks', 'Technical builder', 'Cybersecurity'], ['Finn Lee', 'Presentation / UX lead', 'Business Analytics']]],
    ['RoomRadar', 'operations', '3', [['Gia Russo', 'Technical builder', 'IT'], ['Hank Shaw', 'Problem / business lead', 'Management'], ['Ivy Nguyen', 'Flexible', 'Finance']]],
  ];
  let n = 1;
  for (const [name, lane, table, members] of teams) {
    run('INSERT INTO teams (name, join_code, lane, table_no) VALUES (?,?,?,?)', name, `DEMO${table}${table}`, lane, table);
    const tid = get('SELECT id FROM teams WHERE name = ?', name).id;
    run('INSERT INTO submissions (team_id, updated_at) VALUES (?, ?)', tid, new Date().toISOString());
    for (const [mname, pref, major] of members) user(`student${n++}@zips.uakron.edu`, mname, 'participant', { team: tid, pref, major, skills: 'Python, SQL' });
    run('INSERT INTO checkpoints (team_id, kind, data, submitted_by, submitted_at) VALUES (?,?,?,?,?)', tid, 'cp1', JSON.stringify({
      user: 'COB undergraduate advisees', problem: `${name}: a real College of Business pain point`, outcome: 'Faster, easier', evidence: 'Observed at the advising office', success: 'Median wait under 10 minutes', tech: 'Python + Flask + SQLite',
    }), null, new Date(Date.now() - 3.5 * 3600000).toISOString());
  }
  const t1 = get("SELECT id FROM teams WHERE name = 'ZipQueue'").id;
  run('INSERT INTO files (team_id, path, content) VALUES (?,?,?)', t1, 'main.py',
    'from queue_model import Queue\n\nq = Queue()\nfor name in ["Ava", "Ben", "Chloe"]:\n    q.join(name)\nprint("Now serving:", q.next())\nprint("Estimated wait for next:", q.estimate(), "min")\n');
  run('INSERT INTO files (team_id, path, content) VALUES (?,?,?)', t1, 'queue_model.py',
    'class Queue:\n    AVG_MIN = 7\n\n    def __init__(self):\n        self.people = []\n\n    def join(self, name):\n        self.people.append(name)\n\n    def next(self):\n        return self.people.pop(0) if self.people else None\n\n    def estimate(self):\n        return len(self.people) * self.AVG_MIN\n');
  run('INSERT INTO files (team_id, path, content) VALUES (?,?,?)', t1, 'README.md', '# ZipQueue\n\nWalk-in advising queue for the College of Business.\n');
  run("INSERT INTO invites (code, role, max_uses, note) VALUES ('DEMO-STUDENT', 'participant', 100, 'Demo participant code')");
  const ann = get("SELECT id FROM users WHERE role = 'admin'").id;
  run("INSERT INTO messages (channel, user_id, body) VALUES ('announcements', ?, ?)", ann, 'Welcome to HAkrathon 2026! Checkpoint 2 is at 3:00. Mentors are at the help desk; request one from the **Mentors** tab.');
  run("INSERT INTO messages (channel, user_id, body) VALUES ('general', ?, ?)", get("SELECT id FROM users WHERE email = 'student1@zips.uakron.edu'").id, 'Anyone know if the Wi-Fi blocks port 5000? Our Flask app works with:\n```python\napp.run(host="0.0.0.0", port=8080)\n```');
}

if (fresh) seed();
server.on('error', (e) => { if (e.code === 'EADDRINUSE') { console.error(`  Port ${PORT} is busy. Close the other demo window first.`); process.exit(1); } throw e; });
server.listen(PORT, HOST, () => {
  console.log(`\n  HAkrathon DEMO running at http://localhost:${PORT}  (data: ${process.env.DATA_DIR})`);
  console.log(`  Every demo account uses the password:  ${PW}\n`);
  console.log('    Admin        admin@demo.uakron.edu');
  console.log('    Judges       judge1@demo.com, judge2@demo.com, judge3@demo.com');
  console.log('    Mentor       mentor@demo.com');
  console.log('    Students     student1@zips.uakron.edu … student9@zips.uakron.edu (teams of 3)');
  console.log('    New sign-up  access code DEMO-STUDENT\n');
  console.log('  Delete the data-demo folder to reset the demo.\n');
});
