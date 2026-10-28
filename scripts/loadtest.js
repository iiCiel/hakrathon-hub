'use strict';
// Load test: starts a throwaway copy of the portal (its own temp data folder, never data\),
// signs up STUDENTS students in teams of 5, connects each one's live socket, then for MINUTES
// minutes every student chats, autosaves code and runs it the way the real pages do.
// Prints response times, errors and server memory/event-loop lag.
//
//   node scripts/loadtest.js                 (50 students, 10 minutes)
//   set STUDENTS=50& set MINUTES=2& node scripts/loadtest.js
//
// Runs only use Docker if it is set up (setup-runner.bat); otherwise run calls are counted as skipped.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { monitorEventLoopDelay } = require('node:perf_hooks');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hak-load-'));
process.env.DATA_DIR = DATA;
const WebSocket = require('ws');
const { server, bootstrapAdmin } = require('../server/index.js');
const { get } = require('../server/db');
const runner = require('../server/runner');

const STUDENTS = Number(process.env.STUDENTS) || 50;
const MINUTES = Number(process.env.MINUTES) || 10;
const TEAM = 5;
let BASE, HOST;

const stats = {};
function note(kind, ms, okay) {
  const s = stats[kind] || (stats[kind] = { n: 0, err: 0, t: [], codes: {} });
  s.n++; if (!okay) s.err++; s.t.push(ms);
}
async function call(c, kind, method, url, body) {
  const t0 = performance.now();
  try {
    const r = await c.req(method, url, body);
    const ok = r.status >= 200 && r.status < 300;
    note(kind, performance.now() - t0, ok);
    if (!ok) { const s = stats[kind]; s.codes[r.status] = (s.codes[r.status] || 0) + 1; }
    return r;
  } catch (e) { note(kind, performance.now() - t0, false); stats[kind].codes[e.code || 'net'] = (stats[kind].codes[e.code || 'net'] || 0) + 1; return { status: 0, data: {} }; }
}

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body) {
    const headers = { Cookie: this.cookie, 'X-Hak': '1' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) if (c.startsWith('hak_sid=')) this.cookie = c.split(';')[0];
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  }
  // Minimal Socket.IO (Engine.IO v4) client over a raw WebSocket, same as the browser's.
  socket() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${HOST}/socket.io/?EIO=4&transport=websocket`, { headers: { Cookie: this.cookie, Origin: BASE } });
      this.events = 0;
      ws.on('message', (buf) => {
        const m = buf.toString();
        if (m[0] === '0') ws.send('40');
        else if (m === '2') ws.send('3');
        else if (m.startsWith('40')) resolve(ws);
        else if (m.startsWith('42')) this.events++;
        else if (m.startsWith('44')) reject(new Error('socket refused: ' + m));
      });
      ws.on('error', reject);
      ws.on('close', () => { this.closed = true; });
      this.ws = ws;
    });
  }
}

const PY = (i, n) => `# team file ${i}\nimport math\n\ndef score(x):\n    return math.sqrt(x) * ${n}\n\nfor k in range(5):\n    print(k, score(k))\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms * (0.5 + Math.random());

async function main() {
  bootstrapAdmin();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  HOST = `127.0.0.1:${server.address().port}`; BASE = `http://${HOST}`;
  await runner.checkRunner();
  const runOk = runner.runnerStatus().ready;
  console.log(`\n  Load test: ${STUDENTS} students for ${MINUTES} min against ${BASE} (data ${DATA})`);
  console.log(`  Code runner: ${runOk ? 'ready' : 'not available, run calls are skipped'}\n`);

  const admin = new Client();
  const code = get("SELECT code FROM invites WHERE role = 'admin'").code;
  await admin.req('POST', '/api/auth/register', { invite: code, email: 'lead@uakron.edu', name: 'Lead', password: 'password123', agree: true });
  const s = (await admin.req('GET', '/api/admin/settings')).data.settings || {};
  await admin.req('PUT', '/api/admin/settings', { challenge_released: true, max_teams: Math.max(Number(s.max_teams) || 10, Math.ceil(STUDENTS / TEAM)) });
  const par = (await admin.req('POST', '/api/admin/invites', { role: 'participant', max_uses: STUDENTS + 5 })).data.invite.code;

  // Sign up and form teams (one creates, four join).
  const kids = [];
  const teams = [];
  for (let i = 0; i < STUDENTS; i++) {
    const c = new Client(); c.i = i;
    await call(c, 'register', 'POST', '/api/auth/register', { invite: par, email: `load${i}@zips.uakron.edu`, name: `Load ${i}`, password: 'password123', agree: true });
    if (i % TEAM === 0) {
      const r = await call(c, 'team create', 'POST', '/api/teams', { name: `Load Team ${i / TEAM + 1}`, lane: 'student' });
      const t = r.data.team || r.data;
      teams.push({ id: t.id, code: t.join_code });
    } else await call(c, 'team join', 'POST', '/api/teams/join', { code: teams[teams.length - 1].code });
    c.team = teams[teams.length - 1].id;
    kids.push(c);
  }
  await Promise.all(kids.map((c) => c.socket().catch((e) => { note('socket connect', 0, false); console.error('  socket:', e.message); })));
  console.log(`  ${kids.length} students in ${teams.length} teams, ${kids.filter((c) => c.ws && !c.closed).length} sockets connected\n`);

  const lag = monitorEventLoopDelay({ resolution: 20 }); lag.enable();
  let peakRss = 0;
  const memTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 1000);
  const end = Date.now() + MINUTES * 60000;

  // What one student does: open a page now and then, type (autosave ~every 3 s while typing),
  // chat with the team, sometimes in general, run their code about twice a minute.
  async function student(c) {
    const file = `src/part${c.i % TEAM}.py`;
    let n = 0, version;
    await sleep(Math.random() * 3000);
    while (Date.now() < end) {
      const roll = Math.random();
      if (roll < 0.55) {
        const r = await call(c, 'file save', 'PUT', `/api/workspace/${c.team}/file`, { path: file, content: PY(c.i, ++n), baseVersion: version });
        if (r.data.file) version = r.data.file.version; else if (r.data.conflict) version = r.data.current.version;
        if (c.ws && !c.ws.closed) c.ws.send(`42${JSON.stringify(['presence', { teamId: c.team, path: file }])}`);
      } else if (roll < 0.70) await call(c, 'chat team', 'POST', `/api/chat/${encodeURIComponent('team:' + c.team)}`, { body: `update ${n} from ${c.i}: tests pass?` });
      else if (roll < 0.73) await call(c, 'chat general', 'POST', '/api/chat/general', { body: `general ${n} from ${c.i}` });
      else if (roll < 0.83) {
        await call(c, 'page load', 'GET', '/api/me');
        await call(c, 'page load', 'GET', `/api/chat/${encodeURIComponent('team:' + c.team)}`);
        await call(c, 'page load', 'GET', `/api/workspace/${c.team}/files`);
      } else if (roll < 0.88) await call(c, 'page load', 'GET', '/api/event');
      else if (roll < 0.95) await call(c, 'file open', 'GET', `/api/workspace/${c.team}/all`);
      else if (runOk) await call(c, 'code run', 'POST', '/api/run', { lang: 'python', entry: 'main.py', files: { 'main.py': PY(c.i, n) } });
      else note('code run (skipped)', 0, true);
      await sleep(jitter(3000));
    }
  }
  const tick = setInterval(() => {
    const left = Math.max(0, Math.round((end - Date.now()) / 1000));
    const total = Object.values(stats).reduce((a, s) => a + s.n, 0);
    process.stdout.write(`\r  ${left}s left, ${total} requests so far   `);
  }, 2000);
  await Promise.all(kids.map(student));
  clearInterval(tick); clearInterval(memTimer); lag.disable();

  const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  console.log('\n\n  kind                 count   errors    p50 ms    p95 ms    p99 ms    max ms');
  for (const [k, v] of Object.entries(stats)) {
    console.log(`  ${k.padEnd(20)} ${String(v.n).padStart(5)} ${String(v.err).padStart(8)} ${pct(v.t, 0.5).toFixed(0).padStart(9)} ${pct(v.t, 0.95).toFixed(0).padStart(9)} ${pct(v.t, 0.99).toFixed(0).padStart(9)} ${Math.max(0, ...v.t).toFixed(0).padStart(9)}` +
      (Object.keys(v.codes).length ? `   (${Object.entries(v.codes).map(([c, x]) => `${c}×${x}`).join(', ')})` : ''));
  }
  const events = kids.reduce((a, c) => a + (c.events || 0), 0);
  const dropped = kids.filter((c) => c.closed).length;
  console.log(`\n  live events received: ${events}  ·  sockets dropped: ${dropped}`);
  console.log(`  event-loop lag p99: ${(lag.percentile(99) / 1e6).toFixed(1)} ms, max ${(lag.max / 1e6).toFixed(1)} ms  ·  peak memory ${(peakRss / 1048576).toFixed(0)} MB`);
  const dbMB = fs.statSync(path.join(DATA, 'hakrathon.db')).size / 1048576;
  console.log(`  database size: ${dbMB.toFixed(1)} MB\n`);
  for (const c of kids) try { c.ws.close(); } catch {}
  server.close();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
  setTimeout(() => process.exit(0), 300).unref();
}
main().catch((e) => { console.error(e); process.exit(1); });
