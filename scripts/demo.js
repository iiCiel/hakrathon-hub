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
const { get, all, run } = require('../server/db');
const A = require('../server/auth');
const S = require('../server/settings');
const democlock = require('../server/democlock');

// A hosted copy (render.yaml) sets its own password, so only people given it can sign in.
const PW = process.env.DEMO_PASSWORD || 'demo-pass-2026';
const PORT = Number(process.env.DEMO_PORT) || 3100;
const HOST = process.env.DEMO_HOST || '127.0.0.1';

function user(email, name, role, extra = {}) {
  run(`INSERT INTO users (email, name, password_hash, role, agreed_rules, major, preferred_role, skills, team_id, checked_in) VALUES (?,?,?,?,1,?,?,?,?,1)`,
    email, name, A.hashPassword(PW), role, extra.major || '', extra.pref || '', extra.skills || '', extra.team || null);
  return get('SELECT id FROM users WHERE email = ?', email).id;
}

function seed() {
  // Move the event so "now" is 1:30 p.m. on event day (before any rows exist, so the rows below are
  // stamped in demo time). The browser shows event-day clock times.
  S.setSettings({ challenge_released: true, event_name: 'HAkrathon DEMO', is_demo: true });
  democlock.jump('sprint');
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
  // Two teams are further along so every role has something to show: Checkpoint 2, a finished
  // package and staff validation; two of the three judges have already scored them (judge1 scores live).
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  const pkgs = {
    'Phish Finders': {
      title: 'Phish Finders: a 2-minute phishing check for COB inboxes', url: 'https://example.com/phish-finders',
      brief: { team_roles: 'Dan Wu (backend), Eve Brooks (detection rules), Finn Lee (UX + pitch)', user: 'COB students and staff who get suspicious email', problem: 'Students forward suspicious emails to IT and wait a day for an answer; many click first.', solution: 'Paste an email or forward it to the bot; it scores the phishing risk and explains the red flags in plain words.', success_metric: 'Answer in under 10 seconds; 9 of 10 test phishes flagged in our sample set.', architecture: 'Python + Flask, rule engine plus header checks, SQLite log with no message bodies kept.', limitations: 'English only; rules tuned on 40 sample emails.', implementation_path: 'Pilot with COB IT for one semester, then hand the rules to the security office.' },
      scores: [[8, 9, 7, 8, 8], [7, 9, 8, 7, 9]],
    },
    RoomRadar: {
      title: 'RoomRadar: live study-room availability for CBA', url: 'https://example.com/roomradar',
      brief: { team_roles: 'Gia Russo (build), Hank Shaw (problem + data), Ivy Nguyen (pitch + budget)', user: 'Students looking for a group study room in the CBA building', problem: 'Students walk three floors to find every room taken; the booking sheet is out of date.', solution: 'A phone page that shows free rooms now, from the booking calendar plus a one-tap "we left" check-out.', success_metric: 'Time to find a room drops from ~12 to under 3 minutes in a hallway test.', architecture: 'Node + Express, calendar import, mobile-first page, no personal data stored.', limitations: 'Depends on people tapping check-out; no sensors.', implementation_path: 'Facilities owns the calendar feed; a student org runs it for a semester pilot.' },
      scores: [[7, 8, 8, 9, 7], [8, 7, 7, 8, 8]],
    },
  };
  const disclosure = { data_sources: 'Sample data we made ourselves; no real student records.', apis_libraries: 'Flask/Express, SQLite, Bootstrap (MIT).', templates: 'None.', ai_use: 'Used the approved AI assistant to draft tests and polish the brief; all code reviewed by the team.', licenses: 'All MIT/BSD.', external_help: 'Mentor feedback at Checkpoint 2.' };
  const judges = all("SELECT id FROM users WHERE role = 'judge' ORDER BY id").map((x) => x.id);
  for (const [name, p] of Object.entries(pkgs)) {
    const tid = get('SELECT id FROM teams WHERE name = ?', name).id;
    const by = get('SELECT id FROM users WHERE team_id = ? ORDER BY id', tid).id;
    run('INSERT INTO checkpoints (team_id, kind, data, submitted_by, submitted_at) VALUES (?,?,?,?,?)', tid, 'cp2', JSON.stringify({
      core: 'Main flow works end to end on a phone', blockers: 'None right now', demo1: 'The problem in 30 seconds', demo2: 'Live walk-through of the main flow', demo3: 'Measured result + next step',
    }), by, ago(25));
    run(`UPDATE submissions SET project_title = ?, prototype_url = ?, video_url = ?, brief = ?, disclosure = ?, updated_at = ? WHERE team_id = ?`,
      p.title, p.url, 'https://example.com/demo-video', JSON.stringify(p.brief), JSON.stringify(disclosure), ago(10), tid);
    run('INSERT INTO validations (team_id, links_ok, video_ok, brief_ok, disclosure_ok, eligibility_ok, notes, validated_by, updated_at) VALUES (?,1,1,1,1,1,?,?,?)',
      tid, 'Checked by demo admin.', get("SELECT id FROM users WHERE role = 'admin'").id, ago(5));
    p.scores.forEach((sc, i) => run(`INSERT INTO scores (judge_id, team_id, innovation, impact, technical, usability, presentation, strength, risk, next_step, submitted, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`, judges[i + 1], tid, ...sc, 'Clear user and a working demo.', 'Small test sample.', 'Pilot with real users.', ago(2)));
  }
  // A little team chat so the Team channel isn't empty.
  const zq = get("SELECT id FROM teams WHERE name = 'ZipQueue'").id;
  const zqm = all('SELECT id FROM users WHERE team_id = ? ORDER BY id', zq).map((x) => x.id);
  for (const [who, min, body] of [
    [1, 40, 'Advising office says the walk-in line peaks 11-1. Can we show that in the demo?'],
    [0, 32, 'Yes. I pushed queue_model.py with the wait estimate. Try `python main.py` in the Code tab.'],
    [2, 18, 'Slides outline is in the brief draft. I will record the 5-minute demo at 4:00.'],
  ]) run('INSERT INTO messages (channel, user_id, body, created_at) VALUES (?,?,?,?)', `team:${zq}`, zqm[who], body, ago(min));
  const rr = get("SELECT id FROM teams WHERE name = 'RoomRadar'").id;
  run("INSERT INTO help_requests (team_id, user_id, kind, summary, created_at) VALUES (?,?,?,?,?)", rr,
    get('SELECT id FROM users WHERE team_id = ? ORDER BY id', rr).id, 'technical', 'Calendar import returns times one hour off. Timezone?', ago(4));
  run("INSERT INTO invites (code, role, max_uses, note) VALUES ('DEMO-STUDENT', 'participant', 100, 'Demo participant code')");
  const ann = get("SELECT id FROM users WHERE role = 'admin'").id;
  // Posted at 7:45 AM, so it is already there when the Demo clock goes back to 8:40 AM.
  run("INSERT INTO messages (channel, user_id, body, created_at) VALUES ('announcements', ?, ?, ?)", ann, 'Welcome to HAkrathon 2026! Checkpoint 2 is due at 3:15. Mentors are at the help desk; request one from the **Mentors** tab.', ago(345));
  run("INSERT INTO messages (channel, user_id, body) VALUES ('general', ?, ?)", get("SELECT id FROM users WHERE email = 'student1@zips.uakron.edu'").id, 'Anyone know if the Wi-Fi blocks port 5000? Our Flask app works with:\n```python\napp.run(host="0.0.0.0", port=8080)\n```');
  // Event registration + check-in: the nine team members registered weeks ago and checked in at
  // 7:30-8:00; a few more are pending, waitlisted, or confirmed but not here.
  const adminId = get("SELECT id FROM users WHERE role = 'admin'").id;
  const diet = { 'student1@zips.uakron.edu': 'Vegetarian', 'student4@zips.uakron.edu': 'Nut allergy' };
  const regAt = (days) => new Date(Date.now() - days * 86400000).toISOString();
  all("SELECT u.email, u.name, u.major, u.preferred_role, t.name AS team, t.lane FROM users u JOIN teams t ON t.id = u.team_id WHERE u.role = 'participant' ORDER BY u.id").forEach((u, i) => {
    run(`INSERT INTO registrations (email, name, major, class_level, team_mode, team_name, lane, preferred_role, skills, technical, dietary, media_ok, status, checked_in_at, checked_in_by, id_checked, created_at, updated_at)
      VALUES (?,?,?,?,'team',?,?,?,?,?,?,1,'confirmed',?,?,1,?,?)`, u.email, u.name, u.major, ['Junior', 'Senior', 'Sophomore'][i % 3], u.team, u.lane, u.preferred_role, 'Python, SQL',
    u.preferred_role === 'Technical builder' ? 1 : 0, diet[u.email] || '', ago(345 - i * 3), adminId, regAt(20 - i), ago(345 - i * 3));
  });
  for (const [email, name, major, mode, team, status, dietary, days] of [
    ['jordan.blake@zips.uakron.edu', 'Jordan Blake', 'Information Systems', 'match', '', 'confirmed', 'Halal', 9],
    ['lena.ortiz@zips.uakron.edu', 'Lena Ortiz', 'Computer Science', 'team', 'Data Dawgs', 'confirmed', '', 8],
    ['kai.turner@zips.uakron.edu', 'Kai Turner', 'Finance', 'team', 'Data Dawgs', 'waitlist', '', 4],
    ['sam.reyes@zips.uakron.edu', 'Sam Reyes', 'Marketing', 'match', '', 'pending', 'Gluten-free', 1],
  ]) {
    run(`INSERT INTO registrations (email, name, major, class_level, team_mode, team_name, preferred_role, skills, technical, dietary, media_ok, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?)`, email, name, major, 'Junior', mode, team, mode === 'team' ? 'Technical builder' : 'Flexible', 'Python, Excel', mode === 'team' ? 1 : 0, dietary, status, regAt(days), regAt(days));
  }
}

if (fresh) seed();
else {
  // A demo made before meal times existed: put the default meals on the demo's moved clock.
  if (!get("SELECT 1 AS x FROM settings WHERE key = 'meals'")) {
    const sh = Number(S.getSettings().demo_shift_ms) || 0;
    S.setSettings({ meals: S.DEFAULTS.meals.map((m) => ({ ...m, start: new Date(Date.parse(m.start) + sh).toISOString(), end: new Date(Date.parse(m.end) + sh).toISOString() })) });
  }
  // A demo left from another day would show the event as long over: put it back to Build Sprint 2
  // unless it is somewhere inside event day (7:30 a.m.-7:30 p.m.).
  const t = democlock.demoNow();
  const evStart = Date.parse(S.T('07:30')), evEnd = Date.parse(S.T('19:30'));
  if (!(t >= evStart && t <= evEnd)) { democlock.jump('sprint'); console.log('  Demo clock reset to 1:30 PM (Build Sprint 2).'); }
}
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
