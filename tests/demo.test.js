'use strict';
// Demo copy: seeds, shows event-day times, and the Admin "Demo clock" moves the whole event.
// Starts scripts/demo.js in its own throwaway folder and port.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hak-demo-test-'));
const PORT = 3190 + Math.floor(Math.random() * 50);
const BASE = `http://127.0.0.1:${PORT}`;
let child;
let cookie = '';
async function req(method, url, body) {
  const headers = { Cookie: cookie, 'X-Hak': '1' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const c of res.headers.getSetCookie()) if (c.startsWith('hak_sid=')) cookie = c.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null) };
}
// Event-day clock time ("HH:MM", Eastern) of a stored instant, as the browser shows it.
const eventHM = (iso, shift) => new Date(Date.parse(iso) - shift).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });

test.before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'demo.js')], {
    env: { ...process.env, DEMO_DATA_DIR: path.join(DATA, 'data-demo'), DEMO_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100 && !out.includes('DEMO running'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(out.includes('DEMO running'), out);
});
test.after(() => { child.kill(); setTimeout(() => { try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {} }, 300); });

test('demo shows event-day times and the demo clock moves everything together', async () => {
  assert.equal((await req('POST', '/api/auth/login', { email: 'admin@demo.uakron.edu', password: 'demo-pass-2026' })).status, 200);
  let me = (await req('GET', '/api/me')).data;
  assert.equal(me.event.is_demo, true);
  const shift = me.event.demo_shift_ms;
  // "Now" is 1:30 PM on event day; the schedule reads as the real event times.
  assert.equal(eventHM(me.serverTime, shift), '13:30');
  assert.equal(eventHM(me.event.cp1_at, shift), '10:00');
  assert.equal(eventHM(me.event.build_freeze_at, shift), '16:30');
  assert.equal(me.event.judging_open, false);

  // Seeded data is there: two finished packages, a help request, 2 of 3 judges scored.
  const ov = (await req('GET', '/api/admin/overview')).data;
  assert.equal(ov.teams.filter((t) => t.completeness.complete).length, 2);
  assert.equal(ov.help.open, 1);

  const clock = (await req('GET', '/api/admin/demo-clock')).data;
  assert.ok(clock.stages.some((s) => s.id === 'judging'));
  const before = (await req('GET', '/api/admin/overview')).data.teams.find((t) => t.name === 'Phish Finders');

  const j = await req('POST', '/api/admin/demo-clock', { stage: 'judging' });
  assert.equal(j.status, 200, JSON.stringify(j.data));
  me = (await req('GET', '/api/me')).data;
  const shift2 = me.event.demo_shift_ms;
  assert.equal(eventHM(me.serverTime, shift2), '17:15');
  assert.equal(eventHM(me.event.cp1_at, shift2), '10:00');
  assert.equal(me.event.judging_open, true);
  assert.ok(Date.now() >= Date.parse(me.event.build_freeze_at), 'freeze has passed');
  // Stored timestamps moved with the event: checkpoints are still on time, not late.
  const after = (await req('GET', '/api/admin/overview')).data.teams.find((t) => t.name === 'Phish Finders');
  assert.deepEqual(after.completeness.items.map((i) => [i.id, i.ok, i.detail || '']), before.completeness.items.map((i) => [i.id, i.ok, i.detail || '']));
  // Two judges' scores count in the tabulation; the third judge scores live.
  const tab = await req('GET', '/api/admin/tabulation');
  assert.equal(tab.status, 200);
  assert.ok(JSON.stringify(tab.data).includes('Phish Finders'));

  // And back to the sprint: judging closes again.
  assert.equal((await req('POST', '/api/admin/demo-clock', { stage: 'sprint' })).status, 200);
  me = (await req('GET', '/api/me')).data;
  assert.equal(eventHM(me.serverTime, me.event.demo_shift_ms), '13:30');
  assert.equal(me.event.judging_open, false);
  assert.equal((await req('POST', '/api/admin/demo-clock', { stage: 'nope' })).status >= 400, true);
});

test('server-made text (Rehearsal, offline package) shows event-day times in the demo', async () => {
  assert.equal((await req('POST', '/api/auth/login', { email: 'admin@demo.uakron.edu', password: 'demo-pass-2026' })).status, 200);
  for (const stage of ['sprint', 'judging']) {
    assert.equal((await req('POST', '/api/admin/demo-clock', { stage })).status, 200);
    const times = (await req('GET', '/api/admin/rehearsal')).data.auto.find((a) => a.id === 'times');
    assert.equal(times.detail, 'Freeze Friday, Nov 6 4:30 PM', stage);
  }
  assert.equal((await req('POST', '/api/admin/demo-clock', { stage: 'sprint' })).status, 200);
  assert.equal((await req('POST', '/api/admin/offline-package')).status, 200);
  const html = await (await fetch(BASE + '/api/admin/offline/index.html', { headers: { Cookie: cookie } })).text();
  assert.match(html, /Built Nov 6, 2026, 1:3\d\sPM/);
  const off = (await req('GET', '/api/admin/rehearsal')).data.auto.find((a) => a.id === 'offline');
  assert.match(off.detail, /^Built 11\/6\/2026, 1:3\d:\d\d\sPM$/);
});
