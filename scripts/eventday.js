'use strict';
// Full event-day rehearsal against a throwaway copy of the portal (its own temp data folder, never
// data\). Walks the whole day with 50 students in 10 teams, 3 judges and 2 mentors: check-in with
// personal codes, teams, checkpoints, live chat and announcements, mentor queue, the shared editor
// and sandbox runs in every language, GitHub snapshots, heavy zips, videos and briefs, the build
// freeze, validation, judging, finalist Q&A, awards, results, exports, the offline package and a
// backup. Prints PASS/FAIL per check and how long each phase took.
//
//   node scripts/eventday.js            (SKIP_NET=1 to skip GitHub, HEAVY=0 for small uploads only)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const net = require('node:net');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hak-eventday-'));
const WebSocket = require('ws');
const AdmZip = require('adm-zip');

const STUDENTS = 50, TEAM = 5, JUDGES = 3, MENTORS = 2;
const HEAVY = process.env.HEAVY !== '0';
const NET = !process.env.SKIP_NET;
let BASE, HOST;

// ---------- reporting ----------
const results = [];
let phase = '';
function check(ok, what, detail = '') {
  results.push({ phase, ok: !!ok, what, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
  return !!ok;
}
const timings = [];
// What students feel: a tiny request every 100 ms; its slowest answer per phase is how long the
// whole portal was stuck (the server runs in its own process, like on event day).
let pings = [];
async function pinger(stop) {
  while (!stop.done) {
    const t0 = performance.now();
    try { await fetch(`${BASE}/api/event`); } catch {}
    pings.push(performance.now() - t0);
    await sleep(100);
  }
}
async function stage(name, fn) {
  phase = name;
  console.log(`\n== ${name}`);
  pings = [];
  const t0 = performance.now();
  try { await fn(); } catch (e) { check(false, `${name} crashed`, e.stack.split('\n').slice(0, 3).join(' | ')); }
  const sorted = [...pings].sort((a, b) => a - b);
  timings.push([name, performance.now() - t0, sorted.length ? sorted[sorted.length - 1] : 0, sorted.length ? sorted[Math.floor(sorted.length * 0.99)] : 0]);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString();

// ---------- clients ----------
class Client {
  constructor(name) { this.name = name; this.cookie = ''; this.events = []; }
  async req(method, url, body, { raw = false, headers = {}, form } = {}) {
    const h = { Cookie: this.cookie, 'X-Hak': '1', ...headers };
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(BASE + url, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) if (c.startsWith('hak_sid=')) this.cookie = c.split(';')[0];
    if (raw) return res;
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  }
  get(u) { return this.req('GET', u); }
  post(u, b = {}) { return this.req('POST', u, b); }
  put(u, b = {}) { return this.req('PUT', u, b); }
  patch(u, b = {}) { return this.req('PATCH', u, b); }
  upload(u, name, buf, extra = {}) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    fd.append('file', new Blob([buf]), name);
    return this.req('POST', u, undefined, { form: fd });
  }
  socket() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${HOST}/socket.io/?EIO=4&transport=websocket`, { headers: { Cookie: this.cookie, Origin: BASE } });
      ws.on('message', (buf) => {
        const m = buf.toString();
        if (m[0] === '0') ws.send('40');
        else if (m === '2') ws.send('3');
        else if (m.startsWith('40')) resolve(ws);
        else if (m.startsWith('42')) { try { const [ev, data] = JSON.parse(m.slice(2)); this.events.push({ ev, data }); } catch {} }
        else if (m.startsWith('44')) reject(new Error(m));
      });
      ws.on('error', reject);
      ws.on('close', () => { this.closed = true; });
      this.ws = ws;
    });
  }
  saw(ev, pred = () => true) { return this.events.filter((e) => e.ev === ev && pred(e.data)).map((e) => e.data); }
}
const ok2 = (r) => r.status >= 200 && r.status < 300;
const errText = (r) => `${r.status} ${typeof r.data === 'object' ? r.data.error || '' : String(r.data).slice(0, 80)}`;

// ---------- fixtures ----------
const PROGRAMS = {
  python: ['main.py', { 'main.py': 'from helpers import total\nname = input().strip()\nprint(f"{name}: {total([1, 2, 3, 4])}")\n', 'helpers.py': 'def total(xs):\n    return sum(xs)\n' }, 'Ava', 'Ava: 10'],
  javascript: ['main.js', { 'main.js': 'const { avg } = require("./lib/stats");\nconsole.log("avg", avg([2, 4, 6]));\n', 'lib/stats.js': 'exports.avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;\n' }, '', 'avg 4'],
  c: ['main.c', { 'main.c': '#include <stdio.h>\n#include "q.h"\nint main(void){ printf("queue %d\\n", wait_minutes(3)); return 0; }\n', 'q.c': 'int wait_minutes(int n){ return n * 7; }\n', 'q.h': 'int wait_minutes(int n);\n' }, '', 'queue 21'],
  cpp: ['main.cpp', { 'main.cpp': '#include <iostream>\n#include <vector>\n#include <numeric>\nint main(){ std::vector<int> v{5,5,5}; std::cout << "sum " << std::accumulate(v.begin(), v.end(), 0) << "\\n"; }\n' }, '', 'sum 15'],
  java: ['Main.java', { 'Main.java': 'import util.Greeter;\npublic class Main { public static void main(String[] a) { System.out.println(Greeter.hi("COB")); } }\n', 'util/Greeter.java': 'package util;\npublic class Greeter { public static String hi(String n) { return "Hello " + n; } }\n' }, '', 'Hello COB'],
  bash: ['main.sh', { 'main.sh': 'total=0\r\nfor n in 1 2 3 4; do total=$((total + n)); done\r\necho "rooms: $total"\r\n' }, '', 'rooms: 10'],
};
const LANG_OF_TEAM = ['python', 'javascript', 'c', 'cpp', 'java', 'bash', 'python', 'javascript', 'python', 'java'];
// Small, stable public repositories (GitHub-hosted examples) for the snapshot tests.
const REPOS = ['https://github.com/octocat/Hello-World', 'https://github.com/octocat/Spoon-Knife', 'https://github.com/octocat/linguist', 'https://github.com/octocat/git-consortium'];

function makeVideo(file, seconds) {
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=160x120:rate=5:duration=${seconds}`, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', file], { stdio: 'ignore', timeout: 120000 });
    return fs.readFileSync(file);
  } catch { return null; }
}
function zipOf(files) { const z = new AdmZip(); for (const [p, c] of Object.entries(files)) z.addFile(p, Buffer.isBuffer(c) ? c : Buffer.from(c)); return z.toBuffer(); }

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function main() {
  const port = await freePort();
  HOST = `127.0.0.1:${port}`; BASE = `http://${HOST}`;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, DATA_DIR: DATA, PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const srvLog = [];
  for (const st of [srv.stdout, srv.stderr]) st.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) srvLog.push(l); });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/api/event`)).ok) break; } catch {} await sleep(100); }
  let peak = 0;
  const mem = setInterval(() => { try { const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${srv.pid}/status`, 'utf8')); if (m) peak = Math.max(peak, Number(m[1]) * 1024); } catch {} }, 500);
  const stopPing = { done: false }; pinger(stopPing);

  const admin = new Client('admin');
  const students = Array.from({ length: STUDENTS }, (_, i) => new Client(`s${i + 1}`));
  const judges = Array.from({ length: JUDGES }, (_, i) => new Client(`judge${i + 1}`));
  const mentors = Array.from({ length: MENTORS }, (_, i) => new Client(`mentor${i + 1}`));
  const teams = []; // { id, name, members: [Client], lang, kind }
  const now0 = Date.now();
  let RUN = false;
  console.log(`\n  HAkrathon event-day rehearsal against ${BASE} (server pid ${srv.pid})\n  data: ${DATA}`);

  await stage('Setup: admin, event times, access codes', async () => {
    const code = /ADMIN-[A-Z0-9]+/.exec(fs.readFileSync(path.join(DATA, 'ADMIN-SETUP.txt'), 'utf8'))[0];
    check(ok2(await admin.post('/api/auth/register', { invite: code, email: 'lead@uakron.edu', name: 'Event Lead', password: 'lead-pass-2026', agree: true })), 'first admin registers with the setup code');
    const rs = (await admin.get('/api/me')).data.runner || {};
    RUN = !!rs.ready;
    console.log(`  code runner: ${RUN ? 'ready' : `NOT available: ${rs.reason} (run checks skipped)`} · GitHub: ${NET ? 'on' : 'skipped'} · heavy uploads: ${HEAVY ? 'on' : 'off'}`);
    const r = await admin.put('/api/admin/settings', {
      roster_lock_at: iso(now0 + 3600e3), cp1_at: iso(now0 + 3600e3), cp2_at: iso(now0 + 7200e3), upload_open_at: iso(now0 - 60e3),
      build_freeze_at: iso(now0 + 3 * 3600e3), validation_end_at: iso(now0 + 3.5 * 3600e3),
    });
    check(ok2(r), 'event times set', errText(r));
    const emails = students.map((_, i) => `student${String(i + 1).padStart(2, '0')}@zips.uakron.edu`).join('\n');
    const bulk = await admin.post('/api/admin/invites/bulk', { role: 'participant', emails });
    check(ok2(bulk) && bulk.data.made.length === STUDENTS, `${STUDENTS} personal codes created`, ok2(bulk) ? `${bulk.data.made.length} made` : errText(bulk));
    students.forEach((s, i) => { s.email = bulk.data.made[i].email; s.code = bulk.data.made[i].code; });
    const jc = await admin.post('/api/admin/invites', { role: 'judge', max_uses: JUDGES });
    const mc = await admin.post('/api/admin/invites', { role: 'mentor', max_uses: MENTORS });
    judges.forEach((j) => { j.code = jc.data.invite.code; }); mentors.forEach((m) => { m.code = mc.data.invite.code; });
    const csv = await admin.req('GET', '/api/admin/export/invites.csv', undefined, { raw: true });
    const text = await csv.text();
    check(csv.status === 200 && text.split('\n').length >= STUDENTS + 1, 'codes CSV export lists every personal code');
  });

  await stage('7:30 Check-in: everyone registers at once', async () => {
    const t0 = performance.now();
    const rs = await Promise.all(students.map((s, i) => s.post('/api/auth/register', { invite: s.code, email: s.email, name: `Student ${i + 1}`, password: `pw-${i}-hakrathon`, agree: true, major: ['IT', 'Finance', 'Marketing', 'Cybersecurity', 'Business Analytics'][i % 5] })));
    check(rs.every(ok2), `${STUDENTS} students registered concurrently`, `${Math.round(performance.now() - t0)} ms total; failures: ${rs.filter((r) => !ok2(r)).map(errText).join(', ') || 'none'}`);
    const steal = await new Client('x').post('/api/auth/register', { invite: students[0].code, email: 'thief@uakron.edu', name: 'T', password: 'password123', agree: true });
    check(steal.status === 400, 'a personal code cannot register a different email', errText(steal));
    const jr = await Promise.all(judges.map((j, i) => j.post('/api/auth/register', { invite: j.code, email: `judge${i + 1}@example.com`, name: `Judge ${i + 1}`, password: 'judge-pass-2026', agree: true })));
    const mr = await Promise.all(mentors.map((m, i) => m.post('/api/auth/register', { invite: m.code, email: `mentor${i + 1}@example.com`, name: `Mentor ${i + 1}`, password: 'mentor-pass-2026', agree: true })));
    check(jr.every(ok2) && mr.every(ok2), 'judges and mentors registered');
    const users = (await admin.get('/api/admin/users')).data.users;
    let ticked = 0;
    for (const u of users.filter((x) => x.role === 'participant')) if (ok2(await admin.patch(`/api/admin/users/${u.id}`, { checked_in: true }))) ticked++;
    check(ticked === STUDENTS, 'admin checks everyone in', `${ticked}`);
    const login = await new Client('relog').post('/api/auth/login', { email: students[3].email.toUpperCase(), password: 'pw-3-hakrathon' });
    check(ok2(login), 'login works with a differently-cased email');
    // live connections for everybody
    const all = [admin, ...students, ...judges, ...mentors];
    const conn = await Promise.allSettled(all.map((c) => c.socket()));
    check(conn.every((x) => x.status === 'fulfilled'), `${all.length} live connections open`, conn.filter((x) => x.status === 'rejected').map((x) => x.reason.message).join('; '));
  });

  await stage('8:20 Challenge release + announcement reaches every screen', async () => {
    check(ok2(await admin.put('/api/admin/settings', { challenge_released: true })), 'challenge released');
    const r = await admin.post('/api/admin/announce', { body: 'Challenge is live! Form teams by 9:15. **Mentors** are at the help desk.' });
    check(ok2(r), 'announcement posted', errText(r));
    await sleep(800);
    const everyone = [...students, ...judges, ...mentors];
    const got = everyone.filter((c) => c.saw('announce').length);
    check(got.length === everyone.length, 'every connected person got the announcement pop-up', `${got.length}/${everyone.length}`);
    const ev = everyone.filter((c) => c.saw('event:update').length);
    check(ev.length === everyone.length, 'every screen got the event update (challenge text)', `${ev.length}/${everyone.length}`);
  });

  await stage('8:35 Team formation (10 teams of 5, joining at once)', async () => {
    const lanes = ['student', 'learning', 'operations', 'community', 'cyber'];
    const names = ['ZipQueue', 'Phish Finders', 'RoomRadar', 'AdviseMe', 'CareerCompass', 'ParkSmart', 'StudyBuddy', 'Kent Rivals', 'LabLink', 'Roo Data'];
    for (let t = 0; t < 10; t++) {
      const lead = students[t * TEAM];
      const r = await lead.post('/api/teams', { name: names[t], lane: lanes[t % 5] });
      if (!check(ok2(r), `team ${names[t]} created`, ok2(r) ? '' : errText(r))) continue;
      const team = r.data.team || r.data;
      teams.push({ id: team.id, name: team.name, code: team.join_code, members: [lead], lang: LANG_OF_TEAM[t] });
    }
    // everyone joins at the same moment
    const joins = await Promise.all(teams.flatMap((t, ti) => students.slice(ti * TEAM + 1, ti * TEAM + TEAM).map(async (s) => {
      const r = await s.post('/api/teams/join', { code: t.code.toLowerCase() });
      if (ok2(r)) t.members.push(s);
      return r;
    })));
    check(joins.every(ok2), '40 students joined their teams concurrently', joins.filter((r) => !ok2(r)).map(errText).join(', ') || '');
    // a sixth member is refused (team_max 5)
    const extra = new Client('late');
    const dc = await admin.post('/api/admin/invites', { role: 'participant', max_uses: 2 });
    await extra.post('/api/auth/register', { invite: dc.data.invite.code, email: 'late1@uakron.edu', name: 'Late Arrival', password: 'password123', agree: true });
    const six = await extra.post('/api/teams/join', { code: teams[0].code });
    check(six.status >= 400, 'a sixth member is refused', errText(six));
    // tables
    let tablesOk = 0;
    for (const [i, t] of teams.entries()) if (ok2(await admin.patch(`/api/admin/teams/${t.id}`, { table_no: String(i + 1) }))) tablesOk++;
    check(tablesOk === teams.length, 'admin assigns table numbers');
    const me = await students[7].get('/api/me');
    check(me.data.team && me.data.team.members.length === TEAM && me.data.team.table_no === '2', 'a member sees the full roster and table', me.data.team ? `${me.data.team.members.length} members, table ${me.data.team.table_no}` : 'no team');
    const reh = await admin.get('/api/admin/rehearsal');
    check(reh.data.auto.find((x) => x.id === 'tables').ok, 'rehearsal checklist: every team has a table');
    const upd = students[1].saw('team:update').length;
    check(upd > 0, 'teammates got live roster updates', `${upd} updates`);
    teams.extra = extra;
  });

  await stage('9:15 Roster lock', async () => {
    await admin.put('/api/admin/settings', { roster_lock_at: iso(Date.now() - 1000) });
    const leave = await students[2].post('/api/teams/leave');
    check(leave.status >= 400, 'leaving a team after roster lock is refused', errText(leave));
    const join = await teams.extra.post('/api/teams/join', { code: teams[1].code });
    check(join.status >= 400, 'joining after roster lock is refused', errText(join));
    const mv = await admin.patch(`/api/admin/users/${(await teams.extra.get('/api/me')).data.user.id}`, { team_id: teams[9].id });
    check(mv.status === 409, 'admin is warned before putting a 6th member on a full team', errText(mv));
  });

  await stage('10:00 Checkpoint 1 (one team late)', async () => {
    const cp1 = (t) => ({ user: `${t.name} users`, problem: 'Something at the College takes too long', outcome: 'Make it faster', evidence: 'Observed at the front desk', success: 'Half the wait', tech: t.lang });
    const rs = await Promise.all(teams.slice(0, 9).map((t, i) => t.members[i % TEAM].put('/api/teams/mine/checkpoints/cp1', cp1(t))));
    check(rs.every(ok2), '9 teams submit CP1 on time', rs.filter((r) => !ok2(r)).map(errText).join(', '));
    await admin.put('/api/admin/settings', { cp1_at: iso(Date.now() - 120e3) });
    const late = await teams[9].members[0].put('/api/teams/mine/checkpoints/cp1', cp1(teams[9]));
    check(ok2(late), 'the 10th team can still submit late');
    const ov = (await admin.get('/api/admin/overview')).data;
    const t10 = ov.teams.find((x) => x.id === teams[9].id);
    check(t10 && t10.checkpoints.cp1 && t10.checkpoints.cp1.late, 'late checkpoint is flagged for staff');
    const edit = await teams[0].members[1].put('/api/teams/mine/checkpoints/cp1', { ...cp1(teams[0]), problem: 'Fixed a typo after the deadline' });
    const after = (await teams[0].members[2].get('/api/teams/mine/checkpoints')).data.checkpoints.cp1;
    check(ok2(edit) && !after.late, 'editing an on-time CP1 after the deadline keeps it on time');
  });

  await stage('Build sprint: chat, mentors, shared editor, sandbox', async () => {
    // team chat: 3 messages from every student at once; must stay inside the team
    const before = Date.now();
    const sends = await Promise.all(teams.flatMap((t) => t.members.flatMap((s, k) => [1, 2, 3].map((n) => s.post(`/api/chat/${encodeURIComponent(`team:${t.id}`)}`, { body: `${t.name} msg ${k}-${n}: \`code\` and **bold**` })))));
    check(sends.every(ok2), `${sends.length} team messages sent at once`, sends.filter((r) => !ok2(r)).slice(0, 3).map(errText).join(', '));
    await sleep(1000);
    let leaks = 0, missing = 0;
    for (const t of teams) for (const s of t.members) {
      const got = s.saw('chat:message', (m) => m.channel.startsWith('team:'));
      leaks += got.filter((m) => m.channel !== `team:${t.id}`).length;
      if (got.filter((m) => m.channel === `team:${t.id}`).length < TEAM * 3) missing++;
    }
    check(leaks === 0, 'no team message ever reached another team', `${leaks} leaked`);
    check(missing === 0, 'every member received all of their team’s messages live', `${missing} people missing some`);
    const adminTeam = admin.saw('chat:message', (m) => m.channel.startsWith('team:')).length;
    check(adminTeam >= sends.length, 'admins see team chats (moderation)', `${adminTeam}`);
    // general chat burst + rate limit
    const gen = await Promise.all(students.slice(0, 30).map((s, i) => s.post('/api/chat/general', { body: `Anyone know the Wi-Fi password? (${i})` })));
    check(gen.every(ok2), '30 people post in General at once');
    const spam = []; for (let i = 0; i < 16; i++) spam.push(await students[40].post('/api/chat/general', { body: `spam ${i}` }));
    check(spam.some((r) => r.status === 429), 'chat flood is rate-limited with a clear message', spam.find((r) => r.status === 429) ? errText(spam.find((r) => r.status === 429)) : 'no 429');
    const hist = (await students[49].get('/api/chat/general')).data.messages;
    const ids = hist.map((m) => m.id);
    check(new Set(ids).size === ids.length && ids.every((v, i) => !i || v > ids[i - 1]), 'General history is ordered with no duplicates', `${hist.length} messages`);
    const big = await students[5].post('/api/chat/general', { body: 'x'.repeat(4001) });
    check(big.status === 400, 'over-long message refused', errText(big));
    // mentor queue
    const reqs = await Promise.all(teams.slice(0, 5).map((t, i) => t.members[0].post('/api/help', { kind: ['technical', 'business', 'presentation'][i % 3], summary: `Stuck on ${t.lang} setup` })));
    check(reqs.every(ok2), '5 teams request mentors');
    await sleep(400);
    check(mentors.every((m) => m.saw('help:new').length >= 5), 'both mentors got every new request live');
    const id0 = reqs[0].data.request.id;
    const [c1, c2] = await Promise.all([mentors[0].post(`/api/help/${id0}/claim`), mentors[1].post(`/api/help/${id0}/claim`)]);
    check([c1, c2].filter(ok2).length === 1, 'two mentors claiming the same request: only one wins', `${c1.status}/${c2.status}`);
    let resolved = 0;
    for (const [i, r] of reqs.entries()) {
      const m = mentors[i % 2];
      const id = r.data.request.id;
      if (i) await m.post(`/api/help/${id}/claim`);
      const who = i === 0 ? (ok2(c1) ? mentors[0] : mentors[1]) : m;
      if (ok2(await who.post(`/api/help/${id}/resolve`, { note: 'Talked through the error; pointed to docs' }))) resolved++;
    }
    check(resolved === 5, 'all requests resolved with a log note', `${resolved}`);
    const two = [await teams[6].members[0].post('/api/help', { kind: 'technical', summary: 'a' }), await teams[6].members[1].post('/api/help', { kind: 'technical', summary: 'b' }), await teams[6].members[2].post('/api/help', { kind: 'technical', summary: 'c' })];
    check(two[2].status >= 400, 'a team can have at most two open requests', errText(two[2]));
    // shared editor: each team writes its program, two teammates collide on one file
    for (const t of teams) {
      const [entry, files] = PROGRAMS[t.lang];
      for (const [p, c] of Object.entries(files)) await t.members[0].put(`/api/workspace/${t.id}/file`, { path: p, content: c });
      t.entry = entry;
    }
    const t0 = teams[0];
    const f = (await t0.members[0].get(`/api/workspace/${t0.id}/file?path=main.py`)).data.file;
    const [w1, w2] = await Promise.all([
      t0.members[1].put(`/api/workspace/${t0.id}/file`, { path: 'main.py', content: f.content + '# from s2\n', baseVersion: f.version }),
      t0.members[2].put(`/api/workspace/${t0.id}/file`, { path: 'main.py', content: f.content + '# from s3\n', baseVersion: f.version }),
    ]);
    check([w1, w2].filter((r) => r.data.conflict).length === 1 && [w1, w2].filter((r) => r.data.file).length === 1, 'simultaneous saves of one file: one saves, the other gets a conflict');
    await sleep(300);
    check(t0.members[3].saw('file:update', (e) => e.path === 'main.py').length > 0, 'teammates see file changes live');
    const pres = t0.members[4]; pres.ws.send(`42${JSON.stringify(['presence', { teamId: t0.id, path: 'main.py' }])}`);
    await sleep(300);
    check(t0.members[0].saw('presence', (e) => e.path === 'main.py').length > 0, 'presence (who is in which file) is shared');
    const other = await teams[1].members[0].get(`/api/workspace/${t0.id}/files`);
    check(other.status === 403, 'another team cannot open this workspace', errText(other));
    if (RUN) {
      // every team runs its program at once (runner: 3 at a time, queue behind)
      const t1 = performance.now();
      const runs = await Promise.all(teams.map(async (t) => {
        const all = (await t.members[1].get(`/api/workspace/${t.id}/all`)).data.files;
        const files = Object.fromEntries(all.map((x) => [x.path, x.content]));
        const [, , stdin, expect] = PROGRAMS[t.lang];
        const r = await t.members[1].post('/api/run', { lang: t.lang, entry: t.entry, files, stdin });
        return { t, r, expect };
      }));
      for (const { t, r, expect } of runs) check(ok2(r) && String(r.data.stdout).includes(expect), `sandbox runs ${t.lang} for ${t.name}`, ok2(r) ? `exit ${r.data.exitCode}, ${r.data.durationMs} ms${String(r.data.stdout).includes(expect) ? '' : `, got ${JSON.stringify(String(r.data.stdout + r.data.stderr).slice(0, 120))}`}` : errText(r));
      check(true, `10 concurrent runs finished in ${Math.round(performance.now() - t1)} ms`);
      const loop = await teams[0].members[0].post('/api/run', { lang: 'python', entry: 'main.py', files: { 'main.py': 'while True: pass' } });
      check(ok2(loop) && loop.data.timedOut, 'an infinite loop is stopped at the time limit', ok2(loop) ? `${loop.data.durationMs} ms` : errText(loop));
      const net = await teams[0].members[0].post('/api/run', { lang: 'python', entry: 'main.py', files: { 'main.py': 'import urllib.request\nurllib.request.urlopen("https://github.com", timeout=3)' } });
      check(ok2(net) && net.data.exitCode !== 0, 'sandbox has no internet');
      const flood = await teams[0].members[0].post('/api/run', { lang: 'python', entry: 'main.py', files: { 'main.py': 'print("y" * 10_000_000)' } });
      check(ok2(flood) && String(flood.data.stdout).length <= 70 * 1024, 'huge output is capped', ok2(flood) ? `${String(flood.data.stdout).length} chars` : errText(flood));
    } else check(true, 'sandbox runs skipped (no Docker)');
  });

  await stage('3:15 Checkpoint 2', async () => {
    const rs = await Promise.all(teams.map((t) => t.members[2].put('/api/teams/mine/checkpoints/cp2', { core: 'Working queue', blockers: '', demo1: 'Problem', demo2: 'Live demo', demo3: 'Impact' })));
    check(rs.every(ok2), 'all teams submit CP2');
  });

  const VID = path.join(DATA, 'demo-6min.mp4');
  await stage('Submission package: repos, zips, videos, briefs, disclosures', async () => {
    const brief = (t) => ({ team_roles: t.members.map((m) => m.name).join(', '), user: 'COB students', problem: 'Long waits', solution: `${t.name} app`, success_metric: 'Wait under 10 min', architecture: `${t.lang} + SQLite`, limitations: 'No SSO yet', implementation_path: 'Pilot with advising' });
    const disclosure = { data_sources: 'Synthetic data we made', apis_libraries: 'Standard library', templates: 'None', ai_use: 'Claude for debugging', licenses: 'MIT', external_help: 'Mentor advice' };
    // GitHub teams 0-3
    if (NET) {
      const t0 = performance.now();
      const rs = await Promise.all(teams.slice(0, 4).map((t, i) => t.members[0].post('/api/submission/repo', { repo_url: REPOS[i] }).then((r) => ({ t, r }))));
      for (const { t, r } of rs) {
        check(ok2(r) && /^[0-9a-f]{40}$/.test(r.data.submission.repo_sha || ''), `${t.name} linked ${REPOS[teams.indexOf(t)].split('github.com/')[1]}`, ok2(r) ? r.data.submission.repo_sha.slice(0, 10) : errText(r));
        t.kind = 'repo';
      }
      check(true, `4 repos cloned in parallel in ${Math.round(performance.now() - t0)} ms`);
      const dup = await teams[4].members[0].post('/api/submission/repo', { repo_url: REPOS[0] });
      check(dup.status === 409, 'a second team cannot claim the same repo', errText(dup));
      const bad = await teams[4].members[0].post('/api/submission/repo', { repo_url: 'https://github.com/octocat/definitely-not-a-repo-hak' });
      check(bad.status === 400, 'a missing/private repo gives a clear error', errText(bad));
      const tree = await judges[0].get(`/api/source/${teams[0].id}/repo/tree`);
      check(tree.status === 403, 'judges cannot browse repos before the freeze', errText(tree));
    } else check(true, 'GitHub skipped (SKIP_NET)');
    // zip teams 4-9 (heavy ones included)
    for (const [i, t] of teams.slice(4).entries()) {
      const [entry, files] = PROGRAMS[t.lang];
      const proj = Object.fromEntries(Object.entries(files).map(([p, c]) => [`${t.name.replace(/\s/g, '-')}-main/${p}`, c]));
      const top = `${t.name.replace(/\s/g, '-')}-main/`; // like a "Download ZIP" from GitHub
      proj[`${top}README.md`] = `# ${t.name}\n\nRun: see "How to run".\n\n![diagram](docs/arch.png)\n`;
      if (HEAVY && i === 0) { for (let k = 0; k < 3; k++) proj[`${top}big/data-${k}.bin`] = crypto.randomBytes(25 * 1024 * 1024); } // ~75 MB incompressible
      if (HEAVY && i === 1) for (let k = 0; k < 3000; k++) proj[`${top}src/gen/mod_${k}.py`] = `X_${k} = ${k}\n`;
      if (HEAVY && i === 2) { proj[`${top}node_modules/left-pad/index.js`] = 'module.exports=()=>{}'; proj[`${top}notebook.ipynb`] = JSON.stringify({ cells: [{ cell_type: 'markdown', source: ['# Analysis'] }], nbformat: 4 }); proj[`${top}data/rooms.csv`] = 'room,seats\n' + 'A1,30\n'.repeat(200000); }
      if (i === 3) { proj[`${top}docs/arch.png`] = crypto.randomBytes(4096); proj[`${top}report.pdf`] = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(2048)]); proj[`${top}slides.pptx`] = crypto.randomBytes(9000); }
      if (i === 4) proj['__MACOSX/._junk'] = 'mac'; // zipped on a Mac: junk folder next to the project
      const buf = zipOf(proj);
      const t0 = performance.now();
      const r = await t.members[1].upload('/api/submission/zip', `${t.name}.zip`, buf);
      check(ok2(r) && r.data.submission.has_zip, `${t.name} uploaded a ${(buf.length / 1048576).toFixed(1)} MB zip (${Object.keys(proj).length} files)`, ok2(r) ? `${Math.round(performance.now() - t0)} ms` : errText(r));
      t.kind = 'zip';
      const runCmd = { python: 'python3 main.py', javascript: 'node main.js', c: 'gcc -o /tmp/a *.c && /tmp/a', cpp: 'g++ -o /tmp/a main.cpp && /tmp/a', java: 'mkdir -p /tmp/o && javac -d /tmp/o $(find . -name "*.java") && java -cp /tmp/o Main', bash: 'bash main.sh' }[t.lang];
      t.runCmd = runCmd;
    }
    if (HEAVY) {
      const over = await teams[9].members[0].upload('/api/submission/zip', 'too-big.zip', crypto.randomBytes(101 * 1024 * 1024));
      check(over.status === 413 || over.status === 400, 'a zip over 100 MB is refused', errText(over));
      const still = (await teams[9].members[0].get('/api/submission')).data.submission;
      check(still.has_zip, 'the refused upload did not remove the earlier zip');
    }
    const notzip = await teams[9].members[0].upload('/api/submission/zip', 'fake.zip', Buffer.from('this is not a zip'));
    check(notzip.status === 400, 'a fake .zip is refused cleanly', errText(notzip));
    // videos
    const vid = makeVideo(VID, 360);
    for (const [i, t] of teams.entries()) {
      if (i === 8) continue; // one team forgets the video (incomplete package)
      const r = i === 0 && vid ? await t.members[2].upload('/api/submission/video', 'demo.mp4', vid, { seconds: '360' })
        : i === 1 ? await t.members[2].put('/api/submission', { video_url: 'https://youtu.be/dQw4w9WgXcQ', video_seconds: 270 })
          : await t.members[2].upload('/api/submission/video', i % 2 ? 'demo.webm' : 'demo.mov', crypto.randomBytes(HEAVY && i === 2 ? 300 * 1024 * 1024 : 512 * 1024), { seconds: '280' });
      check(ok2(r), `${t.name} demo video ${i === 1 ? 'link' : 'upload'}${HEAVY && i === 2 ? ' (300 MB)' : ''}`, ok2(r) ? '' : errText(r));
    }
    const exe = await teams[3].members[0].upload('/api/submission/video', 'demo.exe', Buffer.from('MZ'));
    check(exe.status === 400, 'a non-video file is refused as the demo video', errText(exe));
    // briefs, disclosures, run commands, backup evidence
    for (const [i, t] of teams.entries()) {
      const body = { project_title: `${t.name}: a better College`, prototype_url: i % 3 === 0 ? `https://${t.name.toLowerCase().replace(/\s/g, '')}.example.com` : '', disclosure, run_command: t.runCmd || '' };
      if (i !== 7) body.brief = brief(t); // team 8 uploads a PDF brief instead
      const r = await t.members[3].put('/api/submission', body);
      check(ok2(r), `${t.name} saved brief, disclosures, run command`, ok2(r) ? '' : errText(r));
    }
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')]);
    check(ok2(await teams[7].members[0].upload('/api/submission/brief', 'brief.pdf', pdf)), 'PDF brief upload');
    check(ok2(await teams[5].members[0].upload('/api/submission/fallback', 'screens.png', crypto.randomBytes(200 * 1024))), 'backup evidence (screenshots) upload');
    const svg = await teams[5].members[0].upload('/api/submission/fallback', 'x.svg', Buffer.from('<svg onload="alert(1)"/>'));
    check(svg.status === 400, 'SVG/HTML evidence (could run scripts) is refused', errText(svg));
    const sub = (await teams[0].members[4].get('/api/submission')).data.submission;
    check(sub.completeness.complete, `${teams[0].name} package shows complete`, sub.completeness.items.filter((x) => x.required && !x.ok).map((x) => x.label).join('; '));
    const warn = sub.completeness.items.find((x) => x.id === 'video');
    check(!vid || (warn && warn.warn), 'a 6-minute video is flagged (judging stops at 5:00)', warn && warn.warn);
    const ov = (await admin.get('/api/admin/overview')).data;
    const nComplete = ov.teams.filter((x) => x.completeness.complete).length;
    // Without GitHub (SKIP_NET) the repo-only teams have no prototype, so fewer are complete.
    check(NET ? nComplete === 9 : nComplete >= 5, NET ? '9 of 10 packages complete on the admin overview' : 'packages complete on the admin overview (repo teams skipped)', `${nComplete}`);
    if (RUN) {
      const zt = teams.find((t) => t.kind === 'zip' && t.lang === 'python');
      const r = await zt.members[0].post('/api/run/source', { teamId: zt.id, kind: 'zip', stdin: 'Ava' });
      check(ok2(r) && r.data.exitCode === 0, `a team test-runs its zip with its run command (${zt.name})`, ok2(r) ? `${r.data.durationMs} ms` : errText(r));
    }
  });

  await stage('4:30 Build freeze + official repo snapshots', async () => {
    const fz = Date.now() - 2000;
    check(ok2(await admin.put('/api/admin/settings', { build_freeze_at: iso(fz) })), 'freeze time reached');
    await sleep(600);
    const flipped = students.filter((s) => s.saw('event:update').length >= 2).length;
    check(flipped === STUDENTS, 'every student screen was told about the freeze', `${flipped}/${STUDENTS}`);
    const w = await Promise.all(teams.map((t) => t.members[0].put(`/api/workspace/${t.id}/file`, { path: 'late.py', content: 'x' })));
    check(w.every((r) => r.status === 403), 'all workspaces are read-only');
    const s = await Promise.all(teams.map((t) => t.members[1].put('/api/submission', { project_title: 'late change' })));
    check(s.every((r) => r.status === 403), 'all submissions are locked');
    const up = await teams[4].members[0].upload('/api/submission/zip', 'late.zip', zipOf({ 'a.py': 'print(1)' }));
    check(up.status === 403, 'late uploads are refused');
    if (NET) {
      const t0 = Date.now();
      let done = [];
      while (Date.now() - t0 < 120000) {
        const subs = await Promise.all(teams.slice(0, 4).map((t) => judges[0].get(`/api/submissions/${t.id}`)));
        done = subs.filter((r) => ok2(r) && r.data.submission.repo_official);
        if (done.length === 4) break;
        await sleep(2000);
      }
      check(done.length === 4, 'the freeze sweep took an official snapshot of all 4 repos', `${done.length}/4 in ${Math.round((Date.now() - t0) / 1000)} s`);
    }
    // one team gets 10 more minutes (network trouble at their table)
    check(ok2(await admin.patch(`/api/admin/teams/${teams[6].id}`, { extension_minutes: 10 })), 'per-team extension granted');
    const reopened = await teams[6].members[0].put('/api/submission', { project_title: 'StudyBuddy (final)' });
    const others = await teams[5].members[0].put('/api/submission', { project_title: 'nope' });
    check(ok2(reopened) && others.status === 403, 'extension re-opens only that team');
    const early = await judges[0].put(`/api/judge/scores/${teams[6].id}`, { innovation: 5, impact: 5, technical: 5, usability: 5, presentation: 5, strength: 's', risk: 'r', next_step: 'n', submitted: true });
    check(early.status === 403, 'a team that is still building cannot be scored', errText(early));
    await admin.patch(`/api/admin/teams/${teams[6].id}`, { extension_minutes: 0 });
  });

  await stage('4:30–5:00 Staff validation + offline package', async () => {
    let n = 0;
    for (const [i, t] of teams.entries()) {
      const all = i !== 8;
      if (ok2(await admin.put(`/api/admin/validation/${t.id}`, { links_ok: true, video_ok: all, brief_ok: true, disclosure_ok: true, eligibility_ok: true, notes: all ? '' : 'No video' }))) n++;
    }
    check(n === teams.length, 'validation checklist saved for every team');
    const t0 = performance.now();
    const pkg = await admin.post('/api/admin/offline-package');
    check(ok2(pkg) && pkg.data.teams === teams.length, 'offline judging package built', ok2(pkg) ? `${(pkg.data.bytes / 1048576).toFixed(0)} MB, ${Math.round(performance.now() - t0)} ms` : errText(pkg));
    const idx = await admin.req('GET', '/api/admin/offline/index.html', undefined, { raw: true });
    const html = await idx.text();
    check(teams.every((t) => html.includes(t.name)), 'offline index lists every team');
  });

  await stage('5:00 Judging (3 judges at once, one conflict)', async () => {
    check(ok2(await admin.put('/api/admin/settings', { judging_open: true })), 'judging open');
    // judges look at everything first
    let browse = 0, vids = 0, runs = 0;
    for (const t of teams) {
      const r = await judges[1].get(`/api/submissions/${t.id}`);
      if (!ok2(r)) continue;
      const kind = t.kind || (r.data.submission.has_zip ? 'zip' : r.data.submission.has_repo ? 'repo' : null);
      if (kind) {
        const tree = await judges[1].get(`/api/source/${t.id}/${kind}/tree`);
        const first = ok2(tree) && tree.data.tree.find((x) => !x.dir);
        const file = first ? await judges[1].get(`/api/source/${t.id}/${kind}/file?path=${encodeURIComponent(first.path)}`) : null;
        if (ok2(tree) && (!first || ok2(file))) browse++;
      } else browse++;
      if (r.data.submission.video_file) {
        const v = await judges[1].req('GET', `/api/submissions/${t.id}/video`, undefined, { raw: true, headers: { Range: 'bytes=0-1023' } });
        if (v.status === 206 && (await v.arrayBuffer()).byteLength === 1024) vids++;
      }
    }
    check(browse === teams.length, 'judges can open every team’s code (repo or zip)', `${browse}/${teams.length}`);
    check(vids === teams.filter((_, i) => i !== 1 && i !== 8).length, 'uploaded videos stream with seeking (HTTP Range)', `${vids}`);
    if (RUN) {
      for (const t of teams.filter((x) => x.kind === 'zip')) {
        const [, , stdin, expect] = PROGRAMS[t.lang];
        const r = await judges[2].post('/api/run/source', { teamId: t.id, kind: 'zip', stdin });
        if (ok2(r) && String(r.data.stdout).includes(expect)) runs++;
        else check(false, `judge run of ${t.name} (${t.lang})`, ok2(r) ? JSON.stringify(String(r.data.stdout + r.data.stderr).slice(0, 160)) : errText(r));
      }
      check(runs === teams.filter((x) => x.kind === 'zip').length, 'judges ran every zip team’s project in the sandbox', `${runs}`);
    }
    check(ok2(await judges[2].put(`/api/judge/conflicts/${teams[3].id}`, { conflict: true, reason: 'Former student of mine' })), 'judge declares a conflict');
    const rnd = (k, jx, ti) => 4 + ((k * 7 + jx * 3 + ti * 5) % 7);
    const crit = ['innovation', 'impact', 'technical', 'usability', 'presentation'];
    const scores = await Promise.all(judges.flatMap((j, jx) => teams.map((t, ti) => {
      if (jx === 2 && ti === 3) return Promise.resolve({ status: 200, skip: true });
      const body = Object.fromEntries(crit.map((c, k) => [c, rnd(k, jx, ti)]));
      return j.put(`/api/judge/scores/${t.id}`, { ...body, strength: `Strong demo (${j.name})`, risk: 'Scale?', next_step: 'Pilot', submitted: true });
    })));
    check(scores.every(ok2), `${scores.length - 1} scorecards submitted concurrently`, scores.filter((r) => !ok2(r)).map(errText).slice(0, 3).join(', '));
    const tab = (await admin.get('/api/admin/tabulation')).data;
    check(tab.rows.length === teams.length && tab.rows.filter((r) => r.rank).length === teams.length, 'tabulation ranks all teams');
    const t3 = tab.rows.find((r) => r.team_id === teams[3].id);
    check(t3.totals.length === 2 && t3.flags.some((f) => f.startsWith('Only 2 valid')), 'conflicted team has 2 cards and is flagged', t3.flags.join('; '));
    const t8 = tab.rows.find((r) => r.team_id === teams[8].id);
    check(t8.flags.some((f) => /incomplete|validated/i.test(f)), 'team with no video is flagged', t8.flags.join('; '));
    const draft = await judges[0].put(`/api/judge/scores/${teams[0].id}`, { innovation: 1, impact: 1, technical: 1, usability: 1, presentation: 1, strength: '', risk: '', next_step: '', submitted: false });
    check(draft.status === 400, 'a submitted card cannot be turned back into a draft', errText(draft));
    teams.top3 = tab.top3;
  });

  await stage('6:10 Finalists + Q&A adjustments', async () => {
    check(ok2(await admin.put('/api/admin/settings', { finalists: teams.top3, finalists_open: true })), 'top 3 marked as finalists, Q&A open');
    const before = (await admin.get('/api/admin/tabulation')).data.rows.find((r) => r.team_id === teams.top3[0]).average;
    const adj = await judges[0].put(`/api/judge/adjust/${teams.top3[0]}`, { adj_technical: 10, adj_presentation: 10, adj_note: 'Live deploy verified in Q&A' });
    check(ok2(adj), 'judge adjusts Technical + Presentation for a finalist', errText(adj));
    const sneaky = await judges[0].put(`/api/judge/adjust/${teams.top3[0]}`, { adj_technical: 10, innovation: 10, adj_note: 'x' });
    const after = (await admin.get('/api/admin/tabulation')).data.rows.find((r) => r.team_id === teams.top3[0]);
    check(after.average >= before && after.criteria.innovation === (await admin.get('/api/admin/tabulation')).data.rows.find((r) => r.team_id === teams.top3[0]).criteria.innovation, 'only Technical/Presentation can change', `${before} → ${after.average}; sneaky ${sneaky.status}`);
    const non = teams.find((t) => !teams.top3.includes(t.id));
    const na = await judges[1].put(`/api/judge/adjust/${non.id}`, { adj_technical: 10, adj_note: 'x' });
    check(na.status === 403, 'non-finalists cannot be adjusted', errText(na));
  });

  await stage('6:50 Awards + results', async () => {
    const tab = (await admin.get('/api/admin/tabulation')).data;
    const sug = tab.suggestions;
    for (const [award, teamId] of Object.entries(sug)) check(ok2(await admin.put(`/api/admin/awards/${award}`, { team_id: teamId, rationale: `Judges' pick for ${award}` })), `award ${award} assigned`);
    const dup = await admin.put('/api/admin/awards/ai', { team_id: sug.champion, rationale: 'x' });
    check(dup.status === 409, 'one prize per team is enforced (with an override)', errText(dup));
    const hidden = (await students[0].get('/api/results')).data;
    check(!hidden.published, 'results stay hidden until published');
    check(ok2(await admin.put('/api/admin/settings', { results_published: true })), 'results published');
    await sleep(500);
    const res = (await students[0].get('/api/results')).data;
    check(res.published && res.awards.some((a) => a.team), 'students see the awards', res.awards.map((a) => `${a.id}:${a.team}`).join(', '));
    check(res.feedback && res.feedback.strengths.length >= 2, 'each team gets summarized judge feedback');
    check(!JSON.stringify(res).includes('Judge 1') && !JSON.stringify(res).includes('judge1@'), 'judge identities are not exposed to students');
    const locked = await judges[0].put(`/api/judge/scores/${teams[1].id}`, { innovation: 9, impact: 9, technical: 9, usability: 9, presentation: 9, strength: 's', risk: 'r', next_step: 'n', submitted: true });
    check(locked.status === 403, 'scores are locked after publishing');
  });

  await stage('After: exports, audit, backup, cleanup', async () => {
    for (const what of ['results', 'scores', 'teams', 'users', 'mentor-log', 'submission-log', 'invites']) {
      const r = await admin.req('GET', `/api/admin/export/${what}.csv`, undefined, { raw: true });
      const text = await r.text();
      check(r.status === 200 && text.split('\n').length > 2, `export ${what}.csv`, `${text.split('\n').length - 1} rows`);
    }
    const audit = (await admin.get('/api/admin/audit')).data;
    check((audit.entries || audit.audit || audit.rows || []).length > 20, 'audit log recorded the day', `${(audit.entries || audit.audit || audit.rows || []).length} entries`);
    try {
      execFileSync(process.execPath, [path.join(__dirname, 'backup.js')], { env: { ...process.env, DATA_DIR: DATA }, stdio: 'pipe' });
      const b = fs.readdirSync(path.join(DATA, 'backups'));
      check(b.length === 1, 'backup.js wrote a database copy while the server runs', b[0]);
    } catch (e) { check(false, 'backup.js', String(e.stderr || e.message).slice(0, 200)); }
    const tmp = path.join(DATA, 'uploads', 'tmp');
    const left = fs.existsSync(tmp) ? fs.readdirSync(tmp) : [];
    check(left.length === 0, 'no stray temp upload files left behind (refused/failed uploads cleaned up)', `${left.length} files`);
    const errs = srvLog.filter((l) => /\[error\]|Error:|ERR_/.test(l));
    check(errs.length === 0, 'server logged no errors all day', errs.slice(0, 3).join(' | '));
    const dropped = [admin, ...students, ...judges, ...mentors].filter((c) => c.closed).length;
    check(dropped === 0, 'no live connection dropped all day', `${dropped}`);
  });

  clearInterval(mem); stopPing.done = true;
  const du = (dir) => { let n = 0; const st = [dir]; while (st.length) { const d = st.pop(); for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) st.push(p); else n += fs.statSync(p).size; } } return n; };
  const fails = results.filter((r) => !r.ok);
  console.log('\n== Summary');
  console.log('    phase time   slowest reply   p99 reply   phase');
  for (const [n, ms, mx, p99] of timings) console.log(`  ${(ms / 1000).toFixed(1).padStart(8)} s ${mx.toFixed(0).padStart(11)} ms ${p99.toFixed(0).padStart(8)} ms   ${n}`);
  console.log(`\n  ${results.length - fails.length} passed, ${fails.length} failed`);
  console.log(`  server peak memory ${peak ? `${(peak / 1048576).toFixed(0)} MB` : 'n/a'} · data folder ${(du(DATA) / 1048576).toFixed(0)} MB`);
  for (const f of fails) console.log(`  FAILED [${f.phase}] ${f.what}${f.detail ? ` (${f.detail})` : ''}`);
  for (const c of [admin, ...students, ...judges, ...mentors]) try { c.ws.close(); } catch {}
  srv.kill();
  await sleep(500);
  if (!process.env.KEEP) try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
  setTimeout(() => process.exit(fails.length ? 1 : 0), 300).unref();
}
main().catch((e) => { console.error(e); process.exit(2); });
