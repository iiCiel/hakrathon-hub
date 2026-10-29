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
  // an on-time checkpoint edited after its deadline keeps its time and stays on time
  const cp1At = ok(await admin.get('/api/admin/settings')).settings.cp1_at;
  ok(await admin.put('/api/admin/settings', { cp1_at: new Date(Date.now() - 3600000).toISOString() }));
  ok(await p[0].put('/api/teams/mine/checkpoints/cp1', { user: 'Advising office', problem: 'Walk-in lines are long (typo fixed)', outcome: 'Shorter waits', evidence: 'Observed 40 min waits', success: 'Median wait < 10 min', tech: 'Flask + SQLite' }));
  const after = ok(await p[2].get('/api/teams/mine/checkpoints')).checkpoints.cp1;
  assert.equal(after.late, false); assert.equal(after.submitted_at, cps.cp1.submitted_at); assert.ok(after.updated_at);
  assert.match(after.data.problem, /typo fixed/);
  ok(await admin.put('/api/admin/settings', { cp1_at: cp1At }));
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
  // "+ File" with a name that exists must not empty the team's file
  const dupe = await p[0].put(`/api/workspace/${teamA.id}/file`, { path: 'main.py', content: '', create: 'only' });
  status(dupe, 409);
  assert.notEqual(ok(await p[0].get(`/api/workspace/${teamA.id}/file?path=main.py`)).file.content, '');
  ok(await p[0].post(`/api/workspace/${teamA.id}/rename`, { from: 'README.md', to: 'docs/README.md' }));
  // A teammate's autosave for the old name arrives after the rename: refused, the old file isn't recreated
  const late = await p[1].put(`/api/workspace/${teamA.id}/file`, { path: 'README.md', content: 'late edit', baseVersion: 1 });
  status(late, 409); assert.match(late.data.error, /renamed or deleted/);
  assert.ok(!ok(await p[0].get(`/api/workspace/${teamA.id}/files`)).files.some((f) => f.path === 'README.md'));
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
  // Windows-hostile names are left out and reported; deep paths and unicode are kept
  const w = new AdmZip();
  const deep = 'p/' + Array.from({ length: 12 }, (_, i) => `folder_number_${i}`).join('/') + '/deep_file.py';
  for (const [n, c] of [['p/README.md', 'upper'], ['p/readme.md', 'lower'], ['p/CON.txt', 'x'], ['p/a:b.txt', 'x'], ['p/trail.', 'x'], ['p/données/été.txt', 'u'], [deep, 'd']]) w.addFile(n, Buffer.from(c));
  const wr = ok(await p[0].upload('/api/submission/zip', 'win.zip', w.toBuffer()));
  assert.deepEqual(wr.skipped.map((x) => x.why).sort(), ['character not allowed in file names', 'name ends with a dot or space', 'name reserved by Windows', 'same name as another file except for upper/lower case'].sort());
  const wt = ok(await p[0].get(`/api/source/${teamA.id}/zip/tree`)).tree.filter((x) => !x.dir).map((x) => x.path);
  assert.ok(wt.includes(deep.slice(2)) && wt.includes('données/été.txt') && wt.includes('README.md'));
  assert.equal(ok(await p[0].get(`/api/source/${teamA.id}/zip/file?path=${encodeURIComponent('README.md')}`)).file.text, 'upper', 'first of a case pair kept');
  ok(await p[0].get(`/api/source/${teamA.id}/zip/file?path=${encodeURIComponent(deep.slice(2))}`));
  ok(await p[0].upload('/api/submission/zip', 'proj.zip', z.toBuffer()));
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

test('uploads: teammates at once, Mac zips, encodings, notebooks, downloads', async () => {
  const teamDir = path.join(DATA, 'source', `team-${teamA.id}`);
  const mk = (files) => { const z = new AdmZip(); for (const [n, c] of files) z.addFile(n, Buffer.isBuffer(c) ? c : Buffer.from(c)); return z.toBuffer(); };
  // Three teammates upload different zips at the same moment: no errors, one wins, nothing left over.
  const zips = [0, 1, 2].map((i) => mk([[`proj/who.txt`, `p${i}`], ['proj/run.sh', 'echo hi\n']]));
  const res = await Promise.all([0, 1, 2].map((i) => p[i].upload('/api/submission/zip', `p${i}.zip`, zips[i])));
  for (const r of res) ok(r, 'concurrent zip');
  const left = fs.readdirSync(teamDir).filter((n) => /zip-tmp-|\.old-/.test(n));
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(fs.readdirSync(teamDir).filter((n) => /zip-tmp-|\.old-/.test(n)), [], `leftovers: ${left}`);
  assert.match(ok(await p[0].get(`/api/source/${teamA.id}/zip/file?path=who.txt`)).file.text, /^p[012]$/);
  if (process.platform !== 'win32') assert.ok(fs.statSync(path.join(teamDir, 'zip', 'run.sh')).mode & 0o100, 'scripts stay executable');
  // A Mac "Compress" zip: __MACOSX and .DS_Store left out, single top folder still stripped.
  ok(await p[0].upload('/api/submission/zip', 'mac.zip', mk([['MyApp/main.py', 'print(1)'], ['__MACOSX/MyApp/._main.py', 'x'], ['MyApp/.DS_Store', 'x']])));
  assert.deepEqual(ok(await p[0].get(`/api/source/${teamA.id}/zip/tree`)).tree.map((x) => x.path), ['main.py']);
  // A file and a folder with the same name: the folder's files are kept, the clash is reported
  const clash = ok(await p[0].upload('/api/submission/zip', 'clash.zip', mk([['p/a', 'file'], ['p/A/b.txt', 'in folder'], ['p/c/d.txt', 'x'], ['p/C', 'file2']])));
  assert.equal(clash.skipped.length, 2, JSON.stringify(clash.skipped));
  assert.ok(clash.skipped.every((x) => /same name as its folder|folder has the same name/.test(x.why)));
  assert.equal(ok(await p[0].get(`/api/source/${teamA.id}/zip/tree`)).tree.filter((x) => !x.dir).length, 2);
  // Empty / folders-only zip, password-protected zip
  const empty = new AdmZip(); empty.addFile('only/', Buffer.alloc(0));
  status(await p[0].upload('/api/submission/zip', 'empty.zip', empty.toBuffer()), 400, 'empty zip');
  const enc = Buffer.from(mk([['a.txt', 'secret']]));
  enc.writeUInt16LE(enc.readUInt16LE(6) | 1, 6); // local header flag
  const cd = enc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); enc.writeUInt16LE(enc.readUInt16LE(cd + 8) | 1, cd + 8);
  const er = await p[0].upload('/api/submission/zip', 'locked.zip', enc);
  status(er, 400); assert.match(er.data.error, /password/);
  // Encodings and notebooks in the viewer
  const nb = JSON.stringify({ cells: [{ cell_type: 'markdown', source: ['# Title'] }, { cell_type: 'code', source: ['x = 1\n', 'print(x)'], outputs: [{ text: 'HUGE OUTPUT' }] }] });
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('héllo from PowerShell', 'utf16le')]);
  ok(await p[0].upload('/api/submission/zip', 'mix.zip', mk([['analysis.ipynb', nb], ['out.txt', utf16], ['old.csv', Buffer.from([0x63, 0x61, 0x66, 0xe9])], ['doc.pdf', '%PDF-1.4 plain'], ['model.pbix', Buffer.from([0, 1, 2, 3])]])));
  const read = async (f) => ok(await p[0].get(`/api/source/${teamA.id}/zip/file?path=${encodeURIComponent(f)}`)).file;
  const n = await read('analysis.ipynb');
  assert.ok(n.notebook && n.text.includes('print(x)') && n.text.includes('# # Title') && !n.text.includes('HUGE OUTPUT'), n.text);
  assert.equal((await read('out.txt')).text, 'héllo from PowerShell');
  assert.equal((await read('old.csv')).text, 'café');
  assert.ok((await read('doc.pdf')).binary, 'PDF is not shown as text');
  // Binary files download; other teams can't
  const dl = await p[0].req('GET', `/api/source/${teamA.id}/zip/raw?path=model.pbix`, undefined, { raw: true });
  assert.equal(dl.status, 200); assert.match(dl.headers.get('content-disposition'), /attachment/); assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
  assert.deepEqual([...new Uint8Array(await dl.arrayBuffer())], [0, 1, 2, 3]);
  assert.equal((await p[3].req('GET', `/api/source/${teamA.id}/zip/raw?path=model.pbix`, undefined, { raw: true })).status, 403);
  status(await p[0].get(`/api/source/${teamA.id}/zip/raw?path=${encodeURIComponent('../../users.db')}`), 400);
  // Three teammates replace the video at once: exactly one file stays on disk
  const upDir = path.join(DATA, 'uploads', `team-${teamA.id}`);
  for (const r of await Promise.all([0, 1, 2].map((i) => p[i].upload('/api/submission/video', 'v.mp4', Buffer.alloc(4096, i), { seconds: String(100 + i) })))) ok(r);
  assert.equal(fs.readdirSync(upDir).filter((f) => f.startsWith('video-')).length, 1);
  // A replacement whose length the browser couldn't read doesn't keep the old length
  const unk = ok(await p[0].upload('/api/submission/video', 'iphone.mov', Buffer.alloc(1024, 9))).submission;
  assert.equal(unk.video_seconds, null);
  assert.match(unk.completeness.items.find((i) => i.id === 'video').warn, /Length unknown/);
  // MP4/MOV length comes from the file itself, not from what the browser says
  const box = (type, body) => { const b = Buffer.alloc(8 + body.length); b.writeUInt32BE(8 + body.length); b.write(type, 4, 'latin1'); body.copy(b, 8); return b; };
  const mv = Buffer.alloc(100); mv.writeUInt32BE(1000, 12); mv.writeUInt32BE(372000, 16); // v0: timescale 1000, 372 s
  const mp4 = Buffer.concat([box('ftyp', Buffer.from('isom0000')), box('mdat', Buffer.alloc(64)), box('moov', box('mvhd', mv))]);
  const lied = ok(await p[0].upload('/api/submission/video', 'demo.mov', mp4, { seconds: '100' })).submission;
  assert.equal(lied.video_seconds, 372);
  assert.match(lied.completeness.items.find((i) => i.id === 'video').warn, /6:12/);
  // Too-large message says the limit
  assert.match((await p[0].upload('/api/submission/brief', 'b.pdf', Buffer.alloc(16 * 1024 * 1024))).data.error, /15 MB/);
  // Restore the package the later tests expect
  const z = new AdmZip(); z.addFile('project-main/app.py', Buffer.from('print("from zip")\n')); z.addFile('project-main/README.md', Buffer.from('# Zip Coders\n'));
  ok(await p[0].upload('/api/submission/zip', 'proj.zip', z.toBuffer()));
  ok(await p[1].upload('/api/submission/video', 'demo.mp4', Buffer.alloc(2048, 1), { seconds: '290' }));
  assert.equal(server.requestTimeout, 3600000, 'long uploads are not cut off at 5 minutes');
});

test('GitHub repo snapshot', { skip: process.env.SKIP_NET && 'no network' }, async () => {
  status(await p[3].post('/api/submission/repo', { repo_url: 'https://gitlab.com/x/y' }), 400);
  status(await p[3].post('/api/submission/repo', { repo_url: 'https://github.com/octocat/this-repo-does-not-exist-hak' }), 400);
  const r = await p[3].post('/api/submission/repo', { repo_url: 'https://github.com/octocat/Hello-World' });
  if (r.status !== 200) { console.log('  (repo clone unavailable here:', r.data.error, ')'); return; }
  assert.match(r.data.submission.repo_sha, /^[0-9a-f]{40}$/);
  const tree = ok(await p[3].get(`/api/source/${teamB.id}/repo/tree`));
  assert.ok(tree.tree.some((x) => x.path === 'README'));
  // freeze snapshots take the last commit made before the freeze, not whatever HEAD is by then
  const source = require('../server/source');
  const head = r.data.submission.repo_sha;
  const old = await source.snapshotRepo(teamB.id, 'https://github.com/octocat/Hello-World', { before: Date.parse('2011-06-01T00:00:00Z') });
  assert.notEqual(old.sha, head); assert.ok(Date.parse(old.commitDate) < Date.parse('2011-06-01T00:00:00Z')); assert.equal(old.afterFreeze, false);
  const now = await source.snapshotRepo(teamB.id, 'https://github.com/octocat/Hello-World', { before: Date.now() });
  assert.equal(now.sha, head);
  const none = await source.snapshotRepo(teamB.id, 'https://github.com/octocat/Hello-World', { before: Date.parse('2000-01-01T00:00:00Z') });
  assert.equal(none.afterFreeze, true);
});

// Local stand-in for GitHub: a git daemon serving bare repos, reached through an insteadOf rewrite
// of https://github.com/qa-local/. Repos are built with plumbing so odd names work on Windows too.
test('GitHub linking: URL forms, odd file names, empty repos, reservations, freeze pin', async (t) => {
  const { execFileSync, spawn } = require('node:child_process');
  const source = require('../server/source');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hak-git-'));
  fs.mkdirSync(path.join(base, 'qa-local'));
  const g = (cwd, args, opts = {}) => execFileSync('git', ['-c', 'core.protectNTFS=false', '-c', 'user.name=QA', '-c', 'user.email=qa@example.com', ...args], { cwd, encoding: 'utf8', ...opts }).trim();
  // Trees are written with mktree (no index), so names Git for Windows won't index still go in.
  const mkTree = (dir, files) => {
    const here = [], sub = {};
    for (const [p, v] of Object.entries(files)) {
      const i = p.indexOf('/');
      if (i >= 0) { (sub[p.slice(0, i)] ||= {})[p.slice(i + 1)] = v; continue; }
      here.push(v.gitlink ? `160000 commit ${v.gitlink}\t${p}` : `${v.mode || '100644'} blob ${g(dir, ['hash-object', '-w', '--stdin'], { input: v.content ?? v })}\t${p}`);
    }
    for (const [n, f] of Object.entries(sub)) here.push(`040000 tree ${mkTree(dir, f)}\t${n}`);
    return g(dir, ['mktree'], { input: `${here.join('\n')}\n` });
  };
  const commit = (dir, files, date, parent) => {
    const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    const c = g(dir, ['commit-tree', mkTree(dir, files), ...(parent ? ['-p', parent] : []), '-m', 'c'], { env });
    g(dir, ['update-ref', 'refs/heads/main', c]);
    return c;
  };
  const mkRepo = (name, commits) => {
    const dir = path.join(base, 'qa-local', `${name}.git`);
    g(base, ['init', '-q', '--bare', '-b', 'main', dir]);
    let parent = '';
    for (const c of commits) parent = commit(dir, c.files, c.date, parent);
    return parent;
  };
  const port = 20000 + Math.floor(Math.random() * 20000);
  const daemon = spawn('git', ['daemon', '--reuseaddr', '--export-all', `--base-path=${base}`, '--listen=127.0.0.1', `--port=${port}`, base], { stdio: 'ignore' });
  t.after(() => { daemon.kill(); fs.rmSync(base, { recursive: true, force: true }); });
  const n = Number(process.env.GIT_CONFIG_COUNT || 0);
  process.env.GIT_CONFIG_COUNT = String(n + 1);
  process.env[`GIT_CONFIG_KEY_${n}`] = `url.git://127.0.0.1:${port}/qa-local/.insteadOf`;
  process.env[`GIT_CONFIG_VALUE_${n}`] = 'https://github.com/qa-local/';
  const d0 = '2026-11-06T10:00:00Z';
  mkRepo('attrs', [{ date: d0, files: { '.gitattributes': 'secret.py export-ignore\nver.txt export-subst\n', 'secret.py': 'print("hidden?")\n', 'ver.txt': '$Format:%H$\n' } }]);
  mkRepo('odd', [{ date: d0, files: { 'README.md': '# Odd\n![shot](docs/shot.png)\n[guide](docs/guide.md) [top](#odd)\n<form><input type="text"></form>\n', 'readme.md': 'lower', 'CON.txt': 'x', 'a:b.txt': 'x', 'run.sh': { mode: '100755', content: 'echo hi\n' },
    'docs/shot.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'big.psd': 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 9999999\n', 'lib/sub': { gitlink: 'a'.repeat(40) } } }]);
  let wait = 0;
  while (!(await source.remoteHead('https://github.com/qa-local/odd')) && wait++ < 50) await new Promise((r) => setTimeout(r, 100));
  // SSH / folder / www links all normalise to the repo
  for (const u of ['git@github.com:qa-local/odd.git', 'www.github.com/qa-local/odd/tree/main/docs', 'http://GitHub.com/qa-local/odd.GIT', 'https://github.com/qa-local/odd/blob/main/run.sh?plain=1#L1'])
    assert.equal(source.parseGithubUrl(u).url, 'https://github.com/qa-local/odd', u);
  assert.match((await p[3].post('/api/submission/repo', { repo_url: 'https://github.com/qa-local' })).data.error, /profile, not a repository/);
  assert.equal(source.parseGithubUrl('ssh://git@github.com:22/qa-local/odd.git').url, 'https://github.com/qa-local/odd');
  // The repo's own .gitattributes can't hide files from judges or rewrite their text
  const at = await source.snapshotRepo(teamB.id, 'https://github.com/qa-local/attrs');
  assert.equal(at.files, 3);
  assert.equal(fs.readFileSync(path.join(DATA, 'source', `team-${teamB.id}`, 'repo', 'ver.txt'), 'utf8'), '$Format:%H$\n');
  const r = ok(await p[3].post('/api/submission/repo', { repo_url: 'git@github.com:qa-local/odd.git' }));
  assert.equal(r.submission.repo_url, 'https://github.com/qa-local/odd');
  const why = Object.fromEntries(r.skipped.map((x) => [x.path, x.why]));
  assert.match(why['CON.txt'], /reserved/); assert.match(why['a:b.txt'], /character/); assert.match(why['readme.md'], /upper\/lower/);
  assert.match(why['lib/sub'], /submodule/); assert.match(why['big.psd'], /LFS/);
  const tree = ok(await p[3].get(`/api/source/${teamB.id}/repo/tree`));
  const files = tree.tree.filter((x) => !x.dir).map((x) => x.path).sort();
  assert.deepEqual(files, ['README.md', 'big.psd', 'docs/shot.png', 'run.sh']);
  if (process.platform !== 'win32') assert.ok(fs.statSync(path.join(DATA, 'source', `team-${teamB.id}`, 'repo', 'run.sh')).mode & 0o100);
  assert.ok(tree.readme.includes(`/api/source/${teamB.id}/repo/raw?inline=1&amp;path=docs%2Fshot.png`), tree.readme);
  assert.ok(!/href="docs\/guide.md"/.test(tree.readme) && /href="#odd"/.test(tree.readme) && !tree.readme.includes('<input'), tree.readme);
  const img = await p[3].req('GET', `/api/source/${teamB.id}/repo/raw?inline=1&path=docs%2Fshot.png`, undefined, { raw: true });
  assert.equal(img.headers.get('content-type'), 'image/png');
  const notImg = await p[3].req('GET', `/api/source/${teamB.id}/repo/raw?inline=1&path=run.sh`, undefined, { raw: true });
  assert.equal(notImg.headers.get('content-type'), 'application/octet-stream');
  // The Windows fallback (copy by object id) gives the same files, for normal and freeze snapshots
  process.env.HAK_TEST_NO_ARCHIVE = '1';
  try {
    for (const before of [0, Date.parse('2027-01-01T00:00:00Z')]) {
      const fb = await source.snapshotRepo(teamB.id, 'https://github.com/qa-local/odd', { before });
      assert.deepEqual(fb.skipped.map((x) => x.path).sort(), r.skipped.map((x) => x.path).sort());
      const t2 = ok(await p[3].get(`/api/source/${teamB.id}/repo/tree`)).tree.filter((x) => !x.dir).map((x) => x.path).sort();
      assert.deepEqual(t2, files);
      assert.equal(ok(await p[3].get(`/api/source/${teamB.id}/repo/file?path=run.sh`)).file.text, 'echo hi\n');
    }
  } finally { delete process.env.HAK_TEST_NO_ARCHIVE; }
  // Empty repository
  g(base, ['init', '-q', '--bare', '-b', 'main', path.join(base, 'qa-local', 'empty.git')]);
  assert.match((await p[0].post('/api/submission/repo', { repo_url: 'https://github.com/qa-local/empty' })).data.error, /no commits yet/);
  // A failed link doesn't reserve the URL; a working one does
  status(await p[0].post('/api/submission/repo', { repo_url: 'https://github.com/qa-local/later' }), 400);
  mkRepo('later', [{ date: d0, files: { 'a.py': 'print(1)' } }]);
  ok(await p[3].post('/api/submission/repo', { repo_url: 'https://github.com/qa-local/later' }), 'not blocked by the failed attempt');
  assert.match((await p[0].post('/api/submission/repo', { repo_url: 'https://github.com/qa-local/LATER' })).data.error, /Another team/);
  // Two teams linking the same repo at the same moment: only one gets it
  mkRepo('race', [{ date: d0, files: { 'a.py': 'print(1)' } }]);
  const both = await Promise.all([p[0], p[3]].map((c) => c.post('/api/submission/repo', { repo_url: 'https://github.com/qa-local/race' })));
  assert.deepEqual(both.map((x) => x.status).sort(), [200, 409]);
  // Freeze at 12:00. Pushed before: c1 (10:00). Pushed after: c2 (13:00) and c3 back-dated to 11:30.
  const F = Date.parse('2026-11-06T12:00:00Z');
  const c1 = mkRepo('frz', [{ date: d0, files: { 'v.txt': '1' } }]);
  const pin = await source.remoteHead('https://github.com/qa-local/frz');
  assert.equal(pin, c1);
  const dir = path.join(base, 'qa-local', 'frz.git');
  const add = (parent, content, date) => commit(dir, { 'v.txt': content }, date, parent);
  const c3 = add(add(c1, '2', '2026-11-06T13:00:00Z'), '3 (sneaky)', '2026-11-06T11:30:00Z');
  const dated = await source.snapshotRepo(teamB.id, 'https://github.com/qa-local/frz', { before: F });
  assert.equal(dated.sha, c3, 'without the record of what GitHub had, the back-dated commit would win');
  const pinned = await source.snapshotRepo(teamB.id, 'https://github.com/qa-local/frz', { before: F, pin });
  assert.equal(pinned.sha, c1); assert.equal(pinned.pinned, true);
  // Leave both teams without a repo so the freeze tests below don't try to clone these.
  ok(await p[0].del('/api/submission/repo')); ok(await p[3].del('/api/submission/repo'));
});

test('build freeze locks edits; judges get access', async () => {
  const past = new Date(Date.now() - 60000).toISOString();
  ok(await admin.put('/api/admin/settings', { build_freeze_at: past }));
  status(await p[0].put('/api/submission', { project_title: 'late change' }), 403);
  status(await p[0].put(`/api/workspace/${teamA.id}/file`, { path: 'main.py', content: 'late' }), 403);
  // Saves already on the way at the freeze moment land for a few seconds (existing files only)
  ok(await admin.put('/api/admin/settings', { build_freeze_at: new Date(Date.now() - 1000).toISOString() }));
  const mv = ok(await p[0].get(`/api/workspace/${teamA.id}/file?path=main.py`)).file.version;
  ok(await p[0].put(`/api/workspace/${teamA.id}/file`, { path: 'main.py', content: 'print("last second")\n', baseVersion: mv }), 'grace save');
  status(await p[0].put(`/api/workspace/${teamA.id}/file`, { path: 'new_after_freeze.py', content: 'x' }), 403, 'no new files after freeze');
  status(await p[3].put(`/api/workspace/${teamA.id}/file`, { path: 'main.py', content: 'x', baseVersion: mv + 1 }), 403, 'other teams never');
  ok(await admin.put('/api/admin/settings', { build_freeze_at: past }));
  status(await p[0].put(`/api/workspace/${teamA.id}/file`, { path: 'main.py', content: 'late', baseVersion: mv + 1 }), 403, 'grace is only seconds');
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
  // The demo clock only exists in the demo copy.
  status(await admin.get('/api/admin/demo-clock'), 404);
  status(await admin.post('/api/admin/demo-clock', { stage: 'judging' }), 404);
  ok(await p[0].post('/api/chat/general', { body: '=HYPERLINK("http://evil")' }));
  const csv = await admin.req('GET', '/api/admin/export/scores.csv', undefined, { raw: true });
  assert.equal(csv.status, 200);
  // offline judging package: static pages, admin only, team files served as text
  status(await p[0].post('/api/admin/offline-package'), 403);
  const pkg = ok(await admin.post('/api/admin/offline-package'));
  assert.ok(pkg.teams >= 2 && pkg.built_at);
  const idx = await admin.req('GET', '/api/admin/offline/index.html', undefined, { raw: true });
  assert.equal(idx.status, 200); const html = await idx.text();
  assert.ok(html.includes(teamA.name) && html.includes('scoresheets.html'));
  status(await admin.get('/api/admin/offline/..%2F..%2Fhakrathon.db'), 404);
  status(await p[0].get('/api/admin/offline/index.html'), 403);
  // rehearsal checklist
  const reh = ok(await admin.get('/api/admin/rehearsal'));
  assert.ok(reh.auto.find((x) => x.id === 'codes').ok && reh.manual.length >= 5 && Array.isArray(reh.lan));
  ok(await admin.put('/api/admin/rehearsal/power', { done: true }));
  assert.equal(ok(await admin.get('/api/admin/rehearsal')).manual.find((x) => x.id === 'power').done, true);
  status(await admin.put('/api/admin/rehearsal/nope', { done: true }), 404);
  status(await p[0].get('/api/admin/rehearsal'), 403);
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

test('tie-break ranking is a strict order (same result for any input order)', () => {
  const { rankScored } = require('../server/routes/judge');
  const mk = (id, avg, impact) => ({ team_id: id, team: `T${id}`, average: avg, criteria: { impact, technical: 5, innovation: 5 }, flags: [] });
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const seen = new Set();
  for (const p of perms) {
    const base = [mk(1, 80.0, 6), mk(2, 79.8, 7), mk(3, 79.6, 8)];
    seen.add(rankScored(p.map((i) => base[i])).map((x) => x.team).join('>'));
  }
  assert.equal(seen.size, 1, `orders differ: ${[...seen].join(' | ')}`);
  // T1 (80.0) groups with T2 (79.8, within 0.25), Impact puts T2 first; T3 (79.6) is 0.4 below T1.
  assert.equal([...seen][0], 'T2>T1>T3');
  const r = rankScored([mk(1, 70, 5), mk(2, 70, 5)]);
  assert.ok(r[0].flags.some((f) => f.includes('judge vote needed')));
});
