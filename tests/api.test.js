'use strict';
// End-to-end API test: walks the whole event day against a throwaway data folder.
// Run with: npm test   (code-runner checks are skipped if Docker isn't available)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hak-test-'));
process.env.DATA_DIR = DATA;
process.env.RUNNER = process.env.RUNNER || 'docker';
const AdmZip = require('adm-zip');
const { server, bootstrapAdmin } = require('../server/index.js');
const { get } = require('../server/db');
const runner = require('../server/runner');

let BASE;
class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, { raw = false, noHeader = false, form } = {}) {
    const headers = { Cookie: this.cookie };
    if (!noHeader) headers['X-Hak'] = '1';
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(BASE + url, { method, headers, body: payload, redirect: 'manual' });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of sc) if (c.startsWith('hak_sid=')) this.cookie = c.split(';')[0];
    if (raw) return res;
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  }
  get(u) { return this.req('GET', u); }
  post(u, b = {}) { return this.req('POST', u, b); }
  put(u, b = {}) { return this.req('PUT', u, b); }
  patch(u, b = {}) { return this.req('PATCH', u, b); }
  del(u) { return this.req('DELETE', u); }
  upload(u, name, buf, extra = {}) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    fd.append('file', new Blob([buf]), name);
    return this.req('POST', u, undefined, { form: fd });
  }
}
const ok = (r, msg) => { assert.ok(r.status >= 200 && r.status < 300, `${msg || ''} → ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
const status = (r, code, msg) => assert.equal(r.status, code, `${msg || ''} → ${JSON.stringify(r.data)}`);

const admin = new Client(), p = [0, 1, 2, 3, 4].map(() => new Client()), j = [0, 1, 2].map(() => new Client()), mentor = new Client();
let teamA, teamB;

test.before(async () => {
  bootstrapAdmin();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  await runner.checkRunner();
});
test.after(() => { server.close(); try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {} setTimeout(() => process.exit(0), 200).unref(); });

test('accounts, invites and roles', async () => {
  const code = get("SELECT code FROM invites WHERE role = 'admin'").code;
  status(await admin.post('/api/auth/register', { invite: code, email: 'staff@uakron.edu', name: 'Event Lead', password: 'password123', agree: true }), 200);
  // admin code is single use
  status(await new Client().post('/api/auth/register', { invite: code, email: 'x@uakron.edu', name: 'X', password: 'password123', agree: true }), 400);
  const par = ok(await admin.post('/api/admin/invites', { role: 'participant', max_uses: 10 })).invite.code;
  const jud = ok(await admin.post('/api/admin/invites', { role: 'judge', max_uses: 3 })).invite.code;
  const men = ok(await admin.post('/api/admin/invites', { role: 'mentor', max_uses: 1 })).invite.code;
  // participants need a UA email
  status(await new Client().post('/api/auth/register', { invite: par, email: 'a@gmail.com', name: 'A', password: 'password123', agree: true }), 400);
  // must agree to rules
  status(await new Client().post('/api/auth/register', { invite: par, email: 'z@uakron.edu', name: 'Z', password: 'password123' }), 400);
  for (let i = 0; i < 5; i++) ok(await p[i].post('/api/auth/register', { invite: par.toLowerCase(), email: `p${i}@zips.uakron.edu`, name: `Student ${i}`, password: 'password123', agree: true }));
  for (let i = 0; i < 3; i++) ok(await j[i].post('/api/auth/register', { invite: jud, email: `judge${i}@example.com`, name: `Judge ${i}`, password: 'password123', agree: true }));
  ok(await mentor.post('/api/auth/register', { invite: men, email: 'mentor@example.com', name: 'Mentor M', password: 'password123', agree: true }));
  const me = ok(await j[0].get('/api/me'));
  assert.equal(me.user.role, 'judge');
  // duplicate email
  status(await new Client().post('/api/auth/register', { invite: par, email: 'P0@zips.uakron.edu', name: 'dup', password: 'password123', agree: true }), 409);
  // login / wrong password
  status(await new Client().post('/api/auth/login', { email: 'p0@zips.uakron.edu', password: 'nope-nope' }), 401);
  ok(await new Client().post('/api/auth/login', { email: 'P0@zips.uakron.edu', password: 'password123' }));
  // personal codes only work for their own email
  const bulk = ok(await admin.post('/api/admin/invites/bulk', { role: 'participant', emails: 'bound1@uakron.edu, P0@zips.uakron.edu, x@gmail.com' }));
  assert.equal(bulk.made.length, 1); assert.deepEqual(bulk.skipped.map((x) => x.why), ['already registered', 'not a university email']);
  status(await new Client().post('/api/auth/register', { invite: bulk.made[0].code, email: 'thief@uakron.edu', name: 'T', password: 'password123', agree: true }), 400);
  ok(await new Client().post('/api/auth/register', { invite: bulk.made[0].code, email: 'BOUND1@uakron.edu', name: 'B', password: 'password123', agree: true }));
  assert.ok(!fs.existsSync(path.join(DATA, 'ADMIN-SETUP.txt')), 'setup file removed once an admin exists');
});

test('socket handshake rejects foreign origins', async () => {
  const bad = await fetch(BASE + '/socket.io/?EIO=4&transport=polling', { headers: { Origin: 'http://evil.example' } });
  assert.equal(bad.status, 403);
  const good = await fetch(BASE + '/socket.io/?EIO=4&transport=polling', { headers: { Origin: BASE } });
  assert.equal(good.status, 200);
});

test('CSRF header required on writes; auth required', async () => {
  status(await p[0].req('POST', '/api/teams', { name: 'x' }, { noHeader: true }), 403);
  status(await new Client().get('/api/teams'), 401);
  status(await p[0].get('/api/admin/overview'), 403);
});

test('teams: create, join, caps, lanes', async () => {
  teamA = ok(await p[0].post('/api/teams', { name: 'Zip Coders', lane: 'student' })).team;
  ok(await p[1].post('/api/teams/join', { code: teamA.join_code.toLowerCase() }));
  ok(await p[2].post('/api/teams/join', { code: teamA.join_code }));
  status(await p[0].post('/api/teams', { name: 'Another' }), 400, 'already on team');
  status(await p[3].post('/api/teams', { name: 'zip coders' }), 409, 'name taken (case-insensitive)');
  teamB = ok(await p[3].post('/api/teams', { name: 'Kent Rivals', lane: 'cyber' })).team;
  status(await p[3].patch('/api/teams/mine', { lane: 'nope' }), 400);
  status(await j[0].post('/api/teams', { name: 'Judges' }), 403, 'staff cannot make teams');
  const mine = ok(await p[1].get('/api/me'));
  assert.equal(mine.team.id, teamA.id);
  assert.equal(mine.team.members.length, 3);
  // p4 joins then leaves B
  ok(await p[4].post('/api/teams/join', { code: teamB.join_code }));
  ok(await p[4].post('/api/teams/leave'));
  // admin sets tables
  ok(await admin.patch(`/api/admin/teams/${teamA.id}`, { table_no: '3' }));
  ok(await admin.patch(`/api/admin/users/${(ok(await p[4].get('/api/me'))).user.id}`, { team_id: teamB.id }));
});

test('a deleted team leaves nothing for the next team', async () => {
  const x = new Client(), y = new Client();
  const par = ok(await admin.post('/api/admin/invites', { role: 'participant', max_uses: 2 })).invite.code;
  ok(await x.post('/api/auth/register', { invite: par, email: 'x1@uakron.edu', name: 'X', password: 'password123', agree: true }));
  ok(await y.post('/api/auth/register', { invite: par, email: 'y1@uakron.edu', name: 'Y', password: 'password123', agree: true }));
  const t1 = ok(await x.post('/api/teams', { name: 'Ghost' })).team;
  ok(await x.post(`/api/chat/team:${t1.id}`, { body: 'ghost secret' }));
  ok(await x.post('/api/teams/leave'));
  const t2 = ok(await y.post('/api/teams', { name: 'Fresh' })).team;
  assert.notEqual(t2.id, t1.id, 'team ids are never reused');
  status(await y.get(`/api/chat/team:${t1.id}`), 403);
  assert.equal(get('SELECT COUNT(*) AS c FROM messages WHERE channel = ?', `team:${t1.id}`).c, 0, 'old team chat purged');
  ok(await y.post('/api/teams/leave'));
});

test('checkpoints', async () => {
  status(await p[0].put('/api/teams/mine/checkpoints/cp1', { user: 'x' }), 400, 'missing fields');
  ok(await p[0].put('/api/teams/mine/checkpoints/cp1', { user: 'Advising office', problem: 'Walk-in lines are long', outcome: 'Shorter waits', evidence: 'Observed 40 min waits', success: 'Median wait < 10 min', tech: 'Flask + SQLite' }));
  ok(await p[1].put('/api/teams/mine/checkpoints/cp2', { demo1: 'Problem', demo2: 'Queue demo', demo3: 'Impact' }));
  const cps = ok(await p[2].get('/api/teams/mine/checkpoints')).checkpoints;
  assert.ok(cps.cp1 && cps.cp2);
});

test('chat channels and isolation', async () => {
  ok(await p[0].post('/api/chat/general', { body: 'hello **world** `code`' }));
  ok(await p[0].post(`/api/chat/team:${teamA.id}`, { body: 'secret plan' }));
  status(await p[3].get(`/api/chat/team:${teamA.id}`), 403, 'other team cannot read');
  status(await p[3].post(`/api/chat/team:${teamA.id}`, { body: 'hi' }), 403);
  status(await p[0].post('/api/chat/announcements', { body: 'fake' }), 403, 'participants cannot announce');
  status(await p[0].get('/api/chat/staff'), 403);
  ok(await j[0].get('/api/chat/staff'));
  ok(await admin.post('/api/admin/announce', { body: 'Challenge released!' }));
  const ann = ok(await p[3].get('/api/chat/announcements'));
  assert.equal(ann.messages.length, 1);
  const msgs = ok(await admin.get(`/api/chat/team:${teamA.id}`));
  assert.equal(msgs.messages[0].body, 'secret plan');
  status(await p[1].del(`/api/chat/messages/${msgs.messages[0].id}`), 403, 'cannot delete others');
  ok(await admin.del(`/api/chat/messages/${msgs.messages[0].id}`));
});

test('mentor help queue', async () => {
  const r = ok(await p[0].post('/api/help', { kind: 'technical', summary: 'Flask will not start' })).request;
  status(await p[3].post(`/api/help/${r.id}/cancel`), 403);
  status(await p[0].post(`/api/help/${r.id}/claim`), 403, 'participants cannot claim');
  ok(await mentor.post(`/api/help/${r.id}/claim`));
  status(await j[1].post(`/api/help/${r.id}/claim`), 403, 'judges are not mentors');
  status(await mentor.post(`/api/help/${r.id}/resolve`, {}), 400, 'log note required');
  ok(await mentor.post(`/api/help/${r.id}/resolve`, { note: 'Asked about port conflict; pointed to docs' }));
  status(await mentor.post(`/api/help/${r.id}/resolve`, { note: 'rewrite history' }), 409, 'log note is final');
  status(await j[0].get('/api/help'), 403, 'judges do not see the help queue');
  const mine = ok(await p[1].get('/api/help')).requests;
  assert.equal(mine[0].status, 'resolved');
  assert.equal(mine[0].mentor_note, '', 'participants do not see mentor log');
});

test('workspace files, conflicts, access', async () => {
  const list = ok(await p[0].get(`/api/workspace/${teamA.id}/files`));
  assert.ok(list.files.some((f) => f.path === 'main.py'), 'starter files');
  const v1 = ok(await p[0].put(`/api/workspace/${teamA.id}/file`, { path: 'main.py', content: 'print(1)\n', baseVersion: 1 })).file;
  const c = ok(await p[1].put(`/api/workspace/${teamA.id}/file`, { path: 'main.py', content: 'print(2)\n', baseVersion: 1 }));
  assert.equal(c.conflict, true, 'stale write detected');
  ok(await p[1].put(`/api/workspace/${teamA.id}/file`, { path: 'main.py', content: 'print(2)\n', baseVersion: v1.version }));
  status(await p[0].put(`/api/workspace/${teamA.id}/file`, { path: '../escape.py', content: 'x' }), 400, 'path traversal');
  for (const bad of ['CON', 'nul.txt', 'src/com1.py', 'trailing.', 'space ']) status(await p[0].put(`/api/workspace/${teamA.id}/file`, { path: bad, content: 'x' }), 400, `windows name ${bad}`);
  status(await p[3].get(`/api/workspace/${teamA.id}/files`), 403, 'other team');
  status(await p[3].put(`/api/workspace/${teamA.id}/file`, { path: 'a.py', content: 'x' }), 403);
  ok(await mentor.get(`/api/workspace/${teamA.id}/files`));
  status(await mentor.put(`/api/workspace/${teamA.id}/file`, { path: 'a.py', content: 'x' }), 403, 'mentors read-only');
  status(await j[0].get(`/api/workspace/${teamA.id}/files`), 403, 'judges wait for freeze');
  ok(await p[0].post(`/api/workspace/${teamA.id}/rename`, { from: 'README.md', to: 'docs/README.md' }));
  ok(await p[0].put(`/api/workspace/${teamA.id}/file`, { path: 'util/helper.py', content: 'def f():\n    return 42\n' }));
});

test('code runner (sandbox)', async (t) => {
  if (!runner.runnerStatus().ready) return t.skip(`runner not available: ${runner.runnerStatus().reason}`);
  const r = ok(await p[0].post('/api/run', { lang: 'python', entry: 'main.py', files: { 'main.py': 'from util.helper import f\nprint(f(), input())', 'util/helper.py': 'def f():\n  return 42\n' }, stdin: 'hey' }));
  assert.equal(r.stdout.trim(), '42 hey');
  const bad = ok(await p[0].post('/api/run', { lang: 'python', entry: 'main.py', files: { 'main.py': 'import socket\nsocket.create_connection(("1.1.1.1",80),timeout=2)' } }));
  assert.notEqual(bad.exitCode, 0, 'no network');
  status(await p[0].post('/api/run', { lang: 'python', entry: 'x.py', files: { 'main.py': '' } }), 400);
});

test('submission package: zip, uploads, fields', async () => {
  const z = new AdmZip();
  z.addFile('project-main/app.py', Buffer.from('print("from zip")\n'));
  z.addFile('project-main/README.md', Buffer.from('# Zip Coders\n<script>alert(1)</script>\n[x](javascript:alert(1))\n'));
  z.addFile('project-main/evil.txt', Buffer.from('nope'));
  z.getEntries().find((e) => e.entryName.endsWith('evil.txt')).entryName = 'project-main/../../evil.txt';
  z.addFile('abs.txt', Buffer.from('abs'));
  z.getEntries().find((e) => e.entryName === 'abs.txt').entryName = '/tmp/abs.txt';
  const sub = ok(await p[0].upload('/api/submission/zip', 'proj.zip', z.toBuffer())).submission;
  assert.ok(sub.has_zip);
  const tree = ok(await j[0].get(`/api/source/${teamA.id}/zip/tree`).then(() => p[0].get(`/api/source/${teamA.id}/zip/tree`)));
  assert.deepEqual(tree.tree.map((x) => x.path).sort(), ['README.md', 'app.py'], 'top folder stripped, traversal dropped');
  assert.ok(!tree.readme.includes('<script'), 'README sanitized');
  assert.ok(!tree.readme.includes('javascript:'), 'no js: links');
  assert.ok(!fs.existsSync(path.join(DATA, 'source', 'evil.txt')) && !fs.existsSync(path.join(DATA, 'evil.txt')));
  status(await p[0].upload('/api/submission/zip', 'x.zip', Buffer.from('not a zip')), 400);
  status(await p[0].upload('/api/submission/video', 'x.exe', Buffer.from('MZ')), 400, 'bad extension');
  ok(await p[1].upload('/api/submission/video', 'demo.mp4', Buffer.alloc(2048, 1), { seconds: '290' }));
  ok(await p[1].upload('/api/submission/fallback', 'shot.png', Buffer.alloc(100, 2)));
  status(await p[1].put('/api/submission', { prototype_url: 'javascript:alert(1)' }), 400);
  const brief = { team_roles: 'A builds', user: 'Advisors', problem: 'Lines', solution: 'Queue app', success_metric: 'wait < 10', architecture: 'Flask', limitations: 'No SSO', implementation_path: 'Pilot' };
  const disclosure = { data_sources: 'Synthetic', apis_libraries: 'Flask', templates: 'None', ai_use: 'Copilot for CSS', licenses: 'MIT', external_help: 'Mentor advice' };
  const s = ok(await p[2].put('/api/submission', { project_title: 'ZipQueue', prototype_url: 'https://example.com/app', brief, disclosure, run_command: 'python3 app.py' })).submission;
  assert.equal(s.completeness.complete, true, JSON.stringify(s.completeness.items));
  const vid = await p[3].req('GET', `/api/submissions/${teamA.id}/video`, undefined, { raw: true });
  assert.equal(vid.status, 403, 'other team cannot fetch video');
  const own = await p[0].req('GET', `/api/submissions/${teamA.id}/video`, undefined, { raw: true });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('content-type'), 'video/mp4');
});

test('GitHub repo snapshot', { skip: process.env.SKIP_NET && 'no network' }, async () => {
  status(await p[3].post('/api/submission/repo', { repo_url: 'https://gitlab.com/x/y' }), 400);
  status(await p[3].post('/api/submission/repo', { repo_url: 'https://github.com/octocat/this-repo-does-not-exist-hak' }), 400);
  const r = await p[3].post('/api/submission/repo', { repo_url: 'https://github.com/octocat/Hello-World' });
  if (r.status !== 200) { console.log('  (repo clone unavailable here:', r.data.error, ')'); return; }
  assert.match(r.data.submission.repo_sha, /^[0-9a-f]{40}$/);
  const tree = ok(await p[3].get(`/api/source/${teamB.id}/repo/tree`));
  assert.ok(tree.tree.some((x) => x.path === 'README'));
});

test('build freeze locks edits; judges get access', async () => {
  const past = new Date(Date.now() - 60000).toISOString();
  ok(await admin.put('/api/admin/settings', { build_freeze_at: past }));
  status(await p[0].put('/api/submission', { project_title: 'late change' }), 403);
  status(await p[0].put(`/api/workspace/${teamA.id}/file`, { path: 'main.py', content: 'late' }), 403);
  status(await p[0].upload('/api/submission/fallback', 'late.png', Buffer.alloc(10)), 403);
  status(await p[0].put('/api/teams/mine/checkpoints/cp1', { user: 'a', problem: 'b', outcome: 'c', evidence: 'd', success: 'e', tech: 'f' }), 403);
  ok(await j[0].get(`/api/workspace/${teamA.id}/files`));
  ok(await j[0].get(`/api/submissions/${teamA.id}`));
  // per-team extension re-opens one team only
  ok(await admin.patch(`/api/admin/teams/${teamB.id}`, { extension_minutes: 30 }));
  ok(await p[3].put('/api/submission', { project_title: 'Rivals App' }));
  ok(await admin.patch(`/api/admin/teams/${teamB.id}`, { extension_minutes: 0 }));
  status(await p[3].put('/api/submission', { project_title: 'x' }), 403);
});

test('judging, tie-breaks, finalists, awards, results', async () => {
  const score = (o) => ({ innovation: 8, impact: 8, technical: 7, usability: 6, presentation: 9, strength: 's', risk: 'r', next_step: 'n', submitted: true, ...o });
  status(await j[0].put(`/api/judge/scores/${teamA.id}`, score()), 403, 'judging closed');
  ok(await admin.put('/api/admin/settings', { judging_open: true }));
  status(await admin.put(`/api/judge/scores/${teamA.id}`, score()), 403, 'admins do not score');
  status(await j[0].put(`/api/judge/scores/${teamA.id}`, score({ strength: '' })), 400, 'notes required');
  status(await j[0].put(`/api/judge/scores/${teamA.id}`, score({ innovation: 11 })), 400);
  ok(await j[0].put(`/api/judge/scores/${teamA.id}`, score()));
  ok(await j[1].put(`/api/judge/scores/${teamA.id}`, score({ innovation: 6 })));
  ok(await j[2].put(`/api/judge/conflicts/${teamA.id}`, { conflict: true, reason: 'Mentored them' }));
  status(await j[2].put(`/api/judge/scores/${teamA.id}`, score()), 403, 'conflicted');
  for (const c of j) ok(await c.put(`/api/judge/scores/${teamB.id}`, score({ innovation: 5, impact: 5, technical: 5, usability: 5, presentation: 5, strength: c === j[1] ? 'J1-CONFLICTED' : 's' })));
  ok(await j[1].put(`/api/judge/conflicts/${teamB.id}`, { conflict: true, reason: 'Realized I advised them' }));
  const tab = ok(await admin.get('/api/admin/tabulation'));
  const a = tab.rows.find((r) => r.team_id === teamA.id), b = tab.rows.find((r) => r.team_id === teamB.id);
  // judge0: 8*2.5+8*2.5+7*2.5+6*1.5+9*1 = 75.5 ; judge1: 70.5 → 73
  assert.equal(a.average, 73);
  assert.equal(b.average, 50);
  assert.equal(a.rank, 1);
  assert.ok(a.flags.some((f) => f.startsWith('Only 2 valid')), 'fewer than 3 judges flagged');
  assert.ok(a.conflicts.length === 1);
  // finalists + adjustment
  ok(await admin.put('/api/admin/settings', { finalists: [teamA.id], finalists_open: true }));
  status(await j[0].put(`/api/judge/scores/${teamA.id}`, score()), 403, 'primary locked during Q&A');
  status(await j[0].put(`/api/judge/adjust/${teamB.id}`, { adj_technical: 10, adj_note: 'x' }), 403, 'not a finalist');
  status(await j[2].put(`/api/judge/scores/${teamA.id}`, score()), 403, 'no new primary cards once Q&A opens');
  status(await j[0].put(`/api/judge/scores/${teamB.id}`, score()), 403, 'non-finalist cards frozen too');
  ok(await j[0].put(`/api/judge/adjust/${teamA.id}`, { adj_technical: 9, adj_note: 'Showed live deploy' }));
  const tab2 = ok(await admin.get('/api/admin/tabulation'));
  assert.equal(tab2.rows.find((r) => r.team_id === teamA.id).average, 75.5, 'adjustment applied (+5 for judge0 → avg +2.5)');
  // awards with one-prize rule
  ok(await admin.put('/api/admin/awards/champion', { team_id: teamA.id, rationale: 'Best overall' }));
  status(await admin.put('/api/admin/awards/creative', { team_id: teamA.id }), 409);
  ok(await admin.put('/api/admin/awards/creative', { team_id: teamB.id, rationale: 'Bold idea' }));
  // results hidden until published
  assert.equal(ok(await p[0].get('/api/results')).published, false);
  ok(await admin.put('/api/admin/settings', { results_published: true }));
  const res = ok(await p[0].get('/api/results'));
  assert.equal(res.awards.find((x) => x.id === 'champion').team, 'Zip Coders');
  assert.ok(res.feedback && res.feedback.strengths.length === 2);
  assert.ok(!JSON.stringify(res).includes('Judge 0'), 'judge identities hidden');
  const resB = ok(await p[3].get('/api/results'));
  assert.ok(!resB.feedback.strengths.includes('J1-CONFLICTED'), 'conflicted judge feedback dropped');
  status(await j[1].put(`/api/judge/scores/${teamB.id}`, score()), 403, 'locked after publish');
});

test('admin tools: exports, reset password, disable', async () => {
  ok(await p[0].post('/api/chat/general', { body: '=HYPERLINK("http://evil")' }));
  const csv = await admin.req('GET', '/api/admin/export/scores.csv', undefined, { raw: true });
  assert.equal(csv.status, 200);
  const users = ok(await admin.get('/api/admin/users')).users;
  const u = users.find((x) => x.email === 'p4@zips.uakron.edu');
  const reset = ok(await admin.post(`/api/admin/users/${u.id}/reset-password`));
  ok(await new Client().post('/api/auth/login', { email: u.email, password: reset.tempPassword }));
  status(await p[4].get('/api/teams'), 401, 'old session ended after reset');
  ok(await admin.patch(`/api/admin/users/${u.id}`, { disabled: true }));
  status(await new Client().post('/api/auth/login', { email: u.email, password: reset.tempPassword }), 403);
  const me = ok(await admin.get('/api/me')).user;
  status(await admin.patch(`/api/admin/users/${me.id}`, { role: 'judge' }), 400, 'cannot demote self');
  const t = await admin.req('GET', '/api/admin/export/teams.csv', undefined, { raw: true });
  assert.match(await t.text(), /Zip Coders/);
});
