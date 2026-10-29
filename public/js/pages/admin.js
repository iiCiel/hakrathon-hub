import { h, clear, field, toast, busy, confirmBox, modal, promptBox, fmtTime, fmtDateTime, fmtDur, badge, tick, ROLE_LABEL, toDisplay, displayShift } from '../ui.js';
import { api } from '../api.js';
import { state, on, role, go, loadMe, renderChrome, laneName, route } from '../app.js';

const TABS = [['overview', 'Overview'], ['rehearsal', 'Rehearsal'], ['event', 'Event & schedule'], ['people', 'People'], ['codes', 'Access codes'], ['scoring', 'Scoring & awards'], ['audit', 'Audit log']];

export async function render(route) {
  if (role() !== 'admin') { go('#/'); return h('div'); }
  const tab = TABS.some(([k]) => k === route.params[0]) ? route.params[0] : 'overview';
  const [body, clock] = await Promise.all([({ overview, rehearsal, event: eventTab, people, codes, scoring, audit })[tab](), state.event.is_demo ? demoClock() : null]);
  return h('div', null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Admin'), h('p', null, `${state.event.event_name} · event staff controls`))),
    clock,
    h('nav', { class: 'tabs' }, TABS.map(([k, label]) => h('a', { href: `#/admin/${k}`, class: k === tab ? 'on' : '', 'aria-current': k === tab ? 'page' : null }, label))),
    body);
}

// ---------------- demo clock (demo copy only) ----------------
// Jump the whole demo to a moment of event day so a walkthrough can show the sprint, the freeze,
// judging and awards without waiting. Every open screen updates live.
async function demoClock() {
  const d = await api.get('/api/admin/demo-clock').catch(() => null);
  if (!d) return null;
  const cur = new Date(d.now);
  const curHM = cur.getUTCHours() * 60 + cur.getUTCMinutes(); // both in UTC: compare against the stage times below
  const stageMin = (at) => { const dt = new Date(`2026-11-06T${at}:00-05:00`); return dt.getUTCHours() * 60 + dt.getUTCMinutes(); };
  const active = d.stages.filter((x) => stageMin(x.at) <= curHM + 1).pop();
  return h('section', { class: 'card demo-clock' },
    h('div', { class: 'card-head' }, h('h2', null, 'Demo clock'), h('span', { class: 'faint' }, `Event time now: ${fmtTime(new Date(cur.getTime() + displayShift()).toISOString())}`)),
    h('p', { class: 'faint', style: { margin: '0 0 10px' } }, 'Jump the demo to any part of event day. Times, checkpoints, the freeze and judging all move together; every open screen updates.'),
    h('div', { class: 'row wrap' }, d.stages.map((x) => h('button', {
      class: `btn sm ${active && active.id === x.id ? '' : 'secondary'}`, 'aria-pressed': String(!!(active && active.id === x.id)),
      onclick: async (e) => {
        busy(e.target, true, 'Moving…');
        try { await api.post('/api/admin/demo-clock', { stage: x.id }); await loadMe(); renderChrome(); toast(`Demo is now at ${x.label}.`, 'ok'); route(); }
        catch (ex) { toast(ex.message, 'bad'); busy(e.target, false); }
      },
    }, x.label))));
}

// ---------------- overview ----------------
async function overview() {
  const root = h('div', { class: 'stack' });
  const draw = async () => {
    const d = await api.get('/api/admin/overview');
    const stat = (label, value, sub) => h('div', { class: 'card' }, h('div', { class: 'faint' }, label), h('div', { style: { fontSize: '1.7rem', fontWeight: 800 } }, value), sub ? h('div', { class: 'faint' }, sub) : null);
    const r = d.runner;
    clear(root,
      h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' } },
        stat('Teams', `${d.teams.length} / ${d.settings.max_teams}`, `${d.teams.filter((t) => t.completeness.complete).length} complete packages`),
        stat('Participants', d.counts.participant, `${d.checkedIn} checked in · ${d.unassigned.length} without team`),
        stat('Judges / mentors', `${d.counts.judge} / ${d.counts.mentor}`, `min ${d.settings.min_judges} judges`),
        stat('Help queue', d.help.open, `${d.help.claimed} being helped`),
        h('div', { class: 'card' }, h('div', { class: 'faint' }, 'Code runner'), h('div', { style: { margin: '6px 0' } }, r.ready ? badge(r.mode === 'local' ? 'LOCAL (unsafe)' : 'Ready', r.mode === 'local' ? 'warn' : 'ok') : badge('Unavailable', 'bad')),
          h('div', { class: 'faint', style: { fontSize: '.8rem' } }, r.reason), h('div', { class: 'faint', style: { fontSize: '.8rem' } }, `${r.queue.active} running · ${r.queue.waiting} queued · ${r.runsLastHour} runs/h`))),
      h('section', { class: 'card table-wrap' },
        h('div', { class: 'card-head' }, h('h2', null, 'Teams'), h('div', { class: 'row' },
          h('button', { class: 'btn secondary sm', onclick: async () => { const n = await promptBox('New team', 'Team name'); if (!n) return; try { await api.post('/api/admin/teams', { name: n }); draw(); } catch (e) { toast(e.message, 'bad'); } } }, '+ Team'),
          h('button', { class: 'btn secondary sm', onclick: async (e) => {
            busy(e.target, true, 'Snapshotting…');
            try { const res = await api.post('/api/admin/snapshot-all'); toast(`${res.results.filter((x) => x.ok).length}/${res.results.length} repos snapshotted.`, 'ok'); draw(); } catch (ex) { toast(ex.message, 'bad'); busy(e.target, false); }
          } }, 'Snapshot all repos'))),
        h('table', { class: 'tbl' },
          h('thead', null, h('tr', null, ['Table', 'Team', 'CP1', 'CP2', 'Prototype', 'Video', 'Brief', 'Discl.', 'Validated', 'Help', ''].map((x) => h('th', null, x)))),
          h('tbody', null, d.teams.map((t) => {
            const it = Object.fromEntries(t.completeness.items.map((i) => [i.id, i]));
            const v = t.validation || {};
            const validated = v.links_ok && v.video_ok && v.brief_ok && v.disclosure_ok && v.eligibility_ok;
            return h('tr', null,
              h('td', null, t.table_no || '—'),
              h('td', null, h('b', null, t.name), h('div', { class: 'faint' }, `${t.members.length} · ${laneName(t.lane) || 'no lane'}`), t.extension_minutes ? badge(`+${t.extension_minutes} min`, 'gold') : null,
                t.repo.url ? h('div', { class: 'faint', style: { fontSize: '.78rem' } }, t.repo.sha ? `repo ${t.repo.sha.slice(0, 7)}${t.repo.final ? ' (final)' : ''}` : 'repo not snapshotted', t.repo.error ? h('span', { style: { color: 'var(--bad)' } }, ' · error') : null) : null),
              h('td', null, t.checkpoints.cp1 ? h('span', { title: fmtTime(t.checkpoints.cp1.at) }, tick(true, t.checkpoints.cp1.late ? 'warn' : undefined)) : tick(false)),
              h('td', null, t.checkpoints.cp2 ? h('span', { title: fmtTime(t.checkpoints.cp2.at) }, tick(true, t.checkpoints.cp2.late ? 'warn' : undefined)) : tick(false)),
              ...['prototype', 'video', 'brief', 'disclosure'].map((k) => h('td', { title: it[k].warn || '' }, tick(it[k].ok, it[k].warn ? 'warn' : undefined), k === 'video' && t.video_seconds ? h('span', { class: 'faint' }, ` ${fmtDur(t.video_seconds)}`) : null)),
              h('td', null, validated ? badge('Yes', 'ok') : badge('No', '')),
              h('td', null, t.open_help ? badge(t.open_help, 'warn') : ''),
              h('td', { class: 'num' }, h('div', { class: 'row end', style: { flexWrap: 'nowrap', gap: '4px' } },
                h('a', { class: 'btn sm', href: `#/review/${t.id}` }, 'Review'),
                h('button', { class: 'btn secondary sm', onclick: () => editTeam(t, d.settings, draw) }, 'Edit'))));
          })))),
      d.unassigned.length ? h('section', { class: 'card' }, h('h2', null, `Participants without a team (${d.unassigned.length})`),
        h('p', { class: 'faint' }, 'Use for team matching. Assign them from here or the People tab.'),
        h('table', { class: 'tbl' }, h('tbody', null, d.unassigned.map((u) => h('tr', null, h('td', null, h('b', null, u.name), h('div', { class: 'faint' }, u.email)),
          h('td', null, u.preferred_role || '—', h('div', { class: 'faint' }, u.major)), h('td', { class: 'faint' }, u.skills),
          h('td', null, h('select', { 'aria-label': `Assign ${u.name} to a team`, onchange: async (e) => { if (!e.target.value) return; if (await assignTeam(u, Number(e.target.value))) { toast(`${u.name} assigned.`, 'ok'); draw(); } else e.target.value = ''; } },
            h('option', { value: '' }, 'Assign to…'), d.teams.map((t) => h('option', { value: t.id }, `${t.name} (${t.members.length})`))))))))) : null,
      h('section', { class: 'card' }, h('h2', null, 'Exports'), h('div', { class: 'row' },
        [['results', 'Results'], ['scores', 'All scorecards'], ['teams', 'Rosters'], ['users', 'Users'], ['mentor-log', 'Mentor log'], ['submission-log', 'Submission timestamps']]
          .map(([k, label]) => h('a', { class: 'btn secondary sm', href: `/api/admin/export/${k}.csv` }, `⬇ ${label}`)))),
      offlineCard());
  };
  // Offline judging package: if the network dies, judges still get every submission from a USB stick.
  let offlineInfo = null;
  const offlineOut = h('div', { class: 'faint', style: { marginTop: '8px' }, 'aria-live': 'polite' });
  const showOffline = () => {
    if (!offlineInfo || !offlineInfo.built_at) return clear(offlineOut, 'Not built yet.');
    clear(offlineOut, `Built ${fmtTime(offlineInfo.built_at)}`, offlineInfo.teams != null ? ` · ${offlineInfo.teams} teams · ${(offlineInfo.bytes / 1048576).toFixed(1)} MB of files` : '', '. Folder on this computer: ',
      h('code', null, offlineInfo.path), ' — copy it to a USB stick; judges open index.html in any browser. ',
      h('a', { href: '/api/admin/offline/index.html', target: '_blank', rel: 'noopener' }, 'Preview'));
  };
  api.get('/api/admin/offline-package').then((r) => { offlineInfo = r; showOffline(); }).catch(() => {});
  function offlineCard() {
    const btn = h('button', { class: 'btn secondary sm', onclick: async () => {
      busy(btn, true, 'Building…');
      try { offlineInfo = await api.post('/api/admin/offline-package'); showOffline(); toast('Offline package built.', 'ok'); } catch (e) { toast(e.message, 'bad'); }
      busy(btn, false);
    } }, 'Build offline package');
    return h('section', { class: 'card' }, h('h2', null, 'Offline judging package'),
      h('p', { class: 'faint' }, 'Backup for a network outage: every team’s code, video, brief, disclosures and checkpoints as plain pages, plus printable scoresheets. Build it right after the freeze snapshots finish (about 4:35), and again if anything changes.'),
      btn, offlineOut);
  }
  await draw();
  on('staff:update', draw); on('teams:update', draw); on('help:update', draw);
  return root;
}

async function editTeam(t, settings, redraw) {
  const name = h('input', { type: 'text', value: t.name });
  const table = h('input', { type: 'text', value: t.table_no || '', maxlength: 10 });
  const lane = h('select', null, h('option', { value: '' }, '—'), settings.lanes.map((l) => h('option', { value: l.id, selected: l.id === t.lane }, l.name)));
  const ext = h('input', { type: 'number', min: 0, max: 240, value: t.extension_minutes || 0 });
  const r = await modal(`Edit ${t.name}`, h('div', null, field('Team name', name), field('Table number', table), field('Lane', lane),
    field('Freeze extension (minutes)', ext, 'Only for this team, e.g. after a documented technical failure. Logged with a timestamp.'),
    h('p', { class: 'faint' }, `Join code: ${t.join_code}`)),
  [{ label: 'Delete team', class: 'danger', handler: async () => {
    if (!(await confirmBox('Delete team?', `Delete ${t.name}, its code, checkpoints and submission? Members become unassigned.`, 'Delete', true))) return false;
    await api.del(`/api/admin/teams/${t.id}`); return 'deleted';
  } }, { label: 'Cancel', class: 'secondary', value: null }, { label: 'Save', handler: async () => {
    await api.patch(`/api/admin/teams/${t.id}`, { name: name.value, table_no: table.value, lane: lane.value, extension_minutes: Number(ext.value) || 0 }); return 'saved';
  } }]);
  if (r) { toast(r === 'deleted' ? 'Team deleted.' : 'Team saved.', 'ok'); redraw(); }
}

// ---------------- event ----------------
const toLocal = (iso) => { if (!iso) return ''; const d = toDisplay(iso); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const fromLocal = (v) => (v ? new Date(new Date(v).getTime() + displayShift()).toISOString() : '');

async function eventTab() {
  const { settings: s } = await api.get('/api/admin/settings');
  const inp = (k, type = 'text', extra = {}) => h('input', { type, name: k, value: type === 'datetime-local' ? toLocal(s[k]) : s[k], ...extra });
  const chk = (k, label, hint) => h('label', { class: 'check', style: { marginBottom: '10px' } }, h('input', { type: 'checkbox', name: k, checked: !!s[k] }), h('span', null, h('b', null, label), hint ? h('div', { class: 'faint' }, hint) : null));
  const sched = s.schedule.map((x) => ({ ...x }));
  const schedBox = h('div');
  const drawSched = () => clear(schedBox, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Start', 'End', 'Title', 'Detail', ''].map((x) => h('th', null, x)))),
    h('tbody', null, sched.map((x, i) => h('tr', null,
      h('td', null, h('input', { type: 'datetime-local', 'aria-label': `Row ${i + 1} start`, value: toLocal(x.start), onchange: (e) => { x.start = fromLocal(e.target.value); } })),
      h('td', null, h('input', { type: 'datetime-local', 'aria-label': `Row ${i + 1} end`, value: toLocal(x.end), onchange: (e) => { x.end = fromLocal(e.target.value); } })),
      h('td', null, h('input', { type: 'text', 'aria-label': `Row ${i + 1} title`, value: x.title, oninput: (e) => { x.title = e.target.value; } })),
      h('td', null, h('input', { type: 'text', 'aria-label': `Row ${i + 1} detail`, value: x.detail, oninput: (e) => { x.detail = e.target.value; } })),
      h('td', null, h('button', { class: 'btn ghost sm', 'aria-label': `Remove row ${i + 1}`, onclick: () => { sched.splice(i, 1); drawSched(); } }, '✕')))))),
  h('button', { class: 'btn secondary sm', style: { marginTop: '8px' }, onclick: () => { const last = sched[sched.length - 1]; sched.push({ start: last ? last.end : new Date().toISOString(), end: last ? last.end : new Date().toISOString(), title: 'New item', detail: '' }); drawSched(); } }, '+ Row'));
  drawSched();

  const form = h('div', { class: 'stack' });
  const save = async (btn) => {
    const v = {};
    for (const el of form.querySelectorAll('[name]')) v[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'datetime-local' ? fromLocal(el.value) : el.type === 'number' ? Number(el.value) : el.value;
    v.schedule = sched;
    busy(btn, true, 'Saving…');
    try { await api.put('/api/admin/settings', v); await loadMe(); renderChrome(); toast('Event settings saved. Everyone sees the new times now.', 'ok'); }
    catch (e) { toast(e.message, 'bad'); }
    busy(btn, false);
  };
  const saveBtn = h('button', { class: 'btn', onclick: (e) => save(e.currentTarget) }, 'Save event settings');
  form.append(
    h('section', { class: 'card' }, h('h2', null, 'Event'),
      h('div', { class: 'grid two' }, field('Event name', inp('event_name')), field('Tagline', inp('tagline'))),
      field('Umbrella challenge', h('textarea', { name: 'challenge', style: { minHeight: '90px' } }, s.challenge)),
      chk('challenge_released', 'Challenge released', 'Shows the challenge on everyone’s home page. Turn on at 8:20 a.m.')),
    h('section', { class: 'card' }, h('h2', null, 'Deadlines'),
      h('p', { class: 'faint' }, 'Times are in this computer’s time zone. The build freeze locks code and submissions for every team (plus any per-team extension).'),
      h('div', { class: 'grid three' },
        field('Roster lock', inp('roster_lock_at', 'datetime-local')), field('Checkpoint 1 due', inp('cp1_at', 'datetime-local')), field('Checkpoint 2 due', inp('cp2_at', 'datetime-local')),
        field('Upload window opens', inp('upload_open_at', 'datetime-local')), field('Build freeze', inp('build_freeze_at', 'datetime-local')), field('Validation ends', inp('validation_end_at', 'datetime-local'))),
      field('Global freeze extension (minutes)', inp('global_extension_minutes', 'number', { min: 0, max: 240, style: { maxWidth: '160px' } }),
        'Scope §15: if the network is down for more than 30 minutes, extend equally for all teams and announce it.')),
    h('section', { class: 'card' }, h('h2', null, 'Rules & capacity'),
      h('div', { class: 'grid three' },
        field('Max teams', inp('max_teams', 'number', { min: 1, max: 100 })), field('Team minimum', inp('team_min', 'number', { min: 1, max: 20 })), field('Team maximum', inp('team_max', 'number', { min: 1, max: 20 })),
        field('Max video length (seconds)', inp('max_video_seconds', 'number', { min: 30, max: 3600 })), field('Minimum judges per team', inp('min_judges', 'number', { min: 1, max: 20 })),
        field('Participant email domains', inp('participant_email_domains'), 'Comma-separated. Blank allows any email.')),
      chk('registration_open', 'Participant registration open'),
      chk('runner_enabled', 'Code runner on for participants', 'Turn off to pause all code runs (e.g. if the computer is overloaded).')),
    h('section', { class: 'card' }, h('h2', null, 'Schedule'), h('p', { class: 'faint' }, 'Shown on everyone’s home page and drives the “Now / Next” clock.'), h('div', { class: 'table-wrap' }, schedBox)),
    h('div', { class: 'row end', style: { position: 'sticky', bottom: '12px' } }, saveBtn));
  return form;
}

// ---------------- people ----------------
async function people() {
  const root = h('div', { class: 'stack' });
  let q = '';
  const draw = async () => {
    const [{ users }, { teams }] = await Promise.all([api.get('/api/admin/users'), api.get('/api/teams')]);
    const shown = users.filter((u) => !q || `${u.name} ${u.email} ${u.team_name || ''} ${u.role}`.toLowerCase().includes(q.toLowerCase()));
    const search = h('input', { type: 'search', placeholder: 'Search name, email, team…', value: q, style: { maxWidth: '320px' }, oninput: (e) => { q = e.target.value; clearTimeout(search.t); search.t = setTimeout(() => draw().then(() => { const s = root.querySelector('input[type=search]'); s.focus(); s.setSelectionRange(q.length, q.length); }), 250); } });
    clear(root, h('section', { class: 'card table-wrap' },
      h('div', { class: 'card-head' }, h('h2', null, `People (${users.length})`), search),
      h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Name', 'Role', 'Team', 'Checked in', 'GitHub', ''].map((x) => h('th', null, x)))),
        h('tbody', null, shown.map((u) => h('tr', { style: u.disabled ? { opacity: 0.5 } : null },
          h('td', null, h('b', null, u.name), h('div', { class: 'faint' }, u.email), u.disabled ? badge('Disabled', 'bad') : null),
          h('td', null, h('select', { 'aria-label': `Role for ${u.name}`, disabled: u.id === state.me.id, onchange: (e) => patch(u, { role: e.target.value }) }, Object.entries(ROLE_LABEL).map(([k, v]) => h('option', { value: k, selected: k === u.role }, v)))),
          h('td', null, u.role === 'participant' ? h('select', { 'aria-label': `Team for ${u.name}`, onchange: (e) => patch(u, { team_id: e.target.value ? Number(e.target.value) : null }) },
            h('option', { value: '' }, '— none —'), teams.map((t) => h('option', { value: t.id, selected: t.id === u.team_id }, t.name))) : h('span', { class: 'faint' }, '—')),
          h('td', null, h('input', { type: 'checkbox', checked: !!u.checked_in, 'aria-label': `${u.name} checked in`, onchange: (e) => patch(u, { checked_in: e.target.checked }) })),
          h('td', { class: 'faint' }, u.github_login || ''),
          h('td', { class: 'num' }, h('div', { class: 'row end', style: { flexWrap: 'nowrap', gap: '4px' } },
            h('button', { class: 'btn ghost sm', onclick: async () => {
              if (!(await confirmBox('Reset password?', `Give ${u.name} a temporary password? Their current sessions end.`, 'Reset'))) return;
              try { const r = await api.post(`/api/admin/users/${u.id}/reset-password`); await modal('Temporary password', h('div', null, h('p', null, `Give this to ${u.name} (${r.email}). They can change it under Profile.`), h('div', { class: 'codebox' }, r.tempPassword)), [{ label: 'Done', value: true }]); }
              catch (e) { toast(e.message, 'bad'); }
            } }, 'Reset pw'),
            u.id !== state.me.id ? h('button', { class: 'btn ghost sm', onclick: () => patch(u, { disabled: !u.disabled }) }, u.disabled ? 'Enable' : 'Disable') : null))))))));
  };
  const patch = async (u, body) => {
    if ('team_id' in body && body.team_id) { if (await assignTeam(u, body.team_id)) toast('Saved.', 'ok'); draw(); return; }
    try { await api.patch(`/api/admin/users/${u.id}`, body); toast('Saved.', 'ok'); draw(); } catch (e) { toast(e.message, 'bad'); draw(); }
  };
  await draw();
  return root;
}

// Put someone on a team; a full team asks first (the event rule is 3–5 per team).
async function assignTeam(u, teamId) {
  try { await api.patch(`/api/admin/users/${u.id}`, { team_id: teamId }); return true; } catch (e) {
    if (e.status !== 409) { toast(e.message, 'bad'); return false; }
    if (!(await confirmBox('Team is full', `${e.message} Add ${u.name} anyway?`, 'Add anyway'))) return false;
    try { await api.patch(`/api/admin/users/${u.id}`, { team_id: teamId, force: true }); return true; } catch (e2) { toast(e2.message, 'bad'); return false; }
  }
}

// ---------------- access codes ----------------
async function codes() {
  const root = h('div', { class: 'split' });
  const listBox = h('section', { class: 'card table-wrap' });
  const draw = async () => {
    const { invites } = await api.get('/api/admin/invites');
    clear(listBox, h('h2', null, 'Codes'), invites.length ? h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Code', 'Role', 'Used', 'Note', ''].map((x) => h('th', null, x)))),
      h('tbody', null, invites.map((i) => h('tr', { style: i.revoked || i.uses >= i.max_uses ? { opacity: 0.5 } : null },
        h('td', null, h('code', { style: { fontSize: '1rem' } }, i.code), i.email ? h('div', { class: 'faint' }, i.email) : null), h('td', null, ROLE_LABEL[i.role]), h('td', null, `${i.uses} / ${i.max_uses}`), h('td', { class: 'faint' }, i.note),
        h('td', { class: 'num' }, h('div', { class: 'row end', style: { flexWrap: 'nowrap', gap: '4px' } },
          h('button', { class: 'btn ghost sm', onclick: () => navigator.clipboard.writeText(i.code).then(() => toast('Copied.', 'ok')) }, 'Copy'),
          !i.revoked ? h('button', { class: 'btn ghost sm', onclick: async () => { if (await confirmBox('Revoke code?', `${i.code} will stop working for new sign-ups.`, 'Revoke', true)) { await api.post(`/api/admin/invites/${encodeURIComponent(i.code)}/revoke`); draw(); } } }, 'Revoke') : badge('Revoked'))))))) : h('p', { class: 'faint' }, 'No codes yet.'));
  };
  const roleSel = h('select', { name: 'role' }, Object.entries(ROLE_LABEL).reverse().map(([k, v]) => h('option', { value: k }, v)));
  const uses = h('input', { type: 'number', min: 1, max: 1000, value: 60 });
  roleSel.addEventListener('change', () => { uses.value = roleSel.value === 'participant' ? 60 : 1; });
  const note = h('input', { type: 'text', maxlength: 120, placeholder: 'e.g. Check-in table A' });
  const custom = h('input', { type: 'text', maxlength: 30, placeholder: 'Optional, e.g. HAK2026', style: { textTransform: 'uppercase', fontFamily: 'var(--mono)' } });
  const form = h('section', { class: 'card' }, h('h2', null, 'New access code'),
    h('p', { class: 'faint' }, 'People register with a code, which sets their role. Use one multi-use code for participants at check-in, and single-use codes for each judge and mentor.'),
    field('Role', roleSel), field('How many sign-ups', uses), field('Note', note), field('Custom code', custom),
    h('button', { class: 'btn', onclick: async () => {
      try { const r = await api.post('/api/admin/invites', { role: roleSel.value, max_uses: Number(uses.value), note: note.value, code: custom.value }); toast(`Created ${r.invite.code}`, 'ok'); custom.value = ''; draw(); }
      catch (e) { toast(e.message, 'bad'); }
    } }, 'Create code'));
  const emails = h('textarea', { placeholder: 'Paste emails from the registration list (one per line, or separated by commas)', style: { minHeight: '120px' } });
  const bulkRole = h('select', null, h('option', { value: 'participant' }, 'Participant'), h('option', { value: 'judge' }, 'Judge'), h('option', { value: 'mentor' }, 'Mentor'));
  const bulkOut = h('div', { class: 'faint', style: { marginTop: '8px' } });
  const bulk = h('section', { class: 'card', style: { marginTop: '16px' } }, h('h2', null, 'Personal codes'),
    h('p', { class: 'faint' }, 'One single-use code per email. A personal code only works for that email, so nobody can register as a classmate. Hand them out at check-in.'),
    field('Role', bulkRole), field('Emails', emails),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: async (e) => {
        const btn = e.currentTarget;
        busy(btn, true, 'Creating…');
        try {
          const r = await api.post('/api/admin/invites/bulk', { role: bulkRole.value, emails: emails.value });
          clear(bulkOut, `Created ${r.made.length} code${r.made.length === 1 ? '' : 's'}.`, r.skipped.length ? [` Skipped ${r.skipped.length}:`,
            h('ul', { style: { margin: '4px 0 0', paddingLeft: '18px' } }, r.skipped.slice(0, 20).map((x) => h('li', null, `${x.email} — ${x.why}`))),
            r.skipped.length > 20 ? `…and ${r.skipped.length - 20} more.` : null] : null);
          emails.value = ''; draw();
        } catch (ex) { toast(ex.message, 'bad'); }
        busy(btn, false);
      } }, 'Create personal codes'),
      h('a', { class: 'btn secondary', href: '/api/admin/export/invites.csv' }, '⬇ Codes CSV')),
    bulkOut);
  await draw();
  clear(root, listBox, h('aside', null, form, bulk));
  return root;
}

// ---------------- scoring ----------------
async function scoring() {
  const root = h('div', { class: 'stack' });
  let typing = false;
  const draw = async () => {
    const d = await api.get('/api/admin/tabulation');
    typing = false;
    const s = d.settings;
    const teamName = (id) => (d.rows.find((r) => r.team_id === id) || {}).team || '—';
    const toggle = (k, label, hint, confirmText) => h('label', { class: 'check', style: { marginBottom: '10px' } },
      h('input', { type: 'checkbox', checked: !!s[k], onchange: async (e) => {
        if (confirmText && e.target.checked && !(await confirmBox(label, confirmText, 'Yes'))) { e.target.checked = false; return; }
        try { await api.put('/api/admin/settings', { [k]: e.target.checked }); await loadMe(); renderChrome(); toast('Saved.', 'ok'); draw(); } catch (ex) { toast(ex.message, 'bad'); }
      } }), h('span', null, h('b', null, label), h('div', { class: 'faint' }, hint)));
    const finalists = new Set(s.finalists || []);
    const C = s.criteria;

    const table = h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, ['#', 'Team', 'Score', ...C.map((c) => ({ innovation: 'Innov.', impact: 'Impact', technical: 'Tech.', usability: 'Usab.', presentation: 'Pres.' }[c.id] || c.name.split(' ')[0])), 'Judges', 'Flags', 'Finalist', ''].map((x, i) => h('th', { title: i >= 3 && i < 3 + C.length ? C[i - 3].name : null }, x)))),
      h('tbody', null, d.rows.map((r) => {
        const detail = h('tr', { hidden: true }, h('td', { colspan: 7 + C.length }));
        return [h('tr', null,
          h('td', null, r.rank || '—'),
          h('td', null, h('b', null, r.team), h('div', { class: 'faint' }, r.project_title || '')),
          h('td', { class: 'num' }, h('b', { style: { fontSize: '1.1rem' } }, r.average ?? '—')),
          ...C.map((c) => h('td', { class: 'num' }, r.criteria[c.id] ?? '—')),
          h('td', null, `${r.totals.length}`, r.pending.length ? h('div', { class: 'faint', style: { fontSize: '.78rem' } }, `waiting: ${r.pending.join(', ')}`) : null,
            r.conflicts.length ? h('div', { class: 'faint', style: { fontSize: '.78rem' } }, `conflict: ${r.conflicts.map((c) => c.judge).join(', ')}`) : null),
          h('td', { style: { fontSize: '.8rem', maxWidth: '260px' } }, r.flags.map((f) => h('div', { style: { color: /Outlier|Tied|incomplete|Only|Not fully/.test(f) ? 'var(--warn)' : 'var(--ink-2)' } }, '• ', f))),
          h('td', null, h('input', { type: 'checkbox', checked: finalists.has(r.team_id), 'aria-label': `Finalist ${r.team}`, onchange: async (e) => {
            if (e.target.checked) finalists.add(r.team_id); else finalists.delete(r.team_id);
            try { await api.put('/api/admin/settings', { finalists: [...finalists] }); } catch (ex) { toast(ex.message, 'bad'); }
          } })),
          h('td', null, h('button', { class: 'btn ghost sm', onclick: async () => {
            if (!detail.hidden) { detail.hidden = true; return; }
            const { cards } = await api.get(`/api/admin/scorecards/${r.team_id}`);
            clear(detail.firstChild, cards.length ? h('table', { class: 'tbl' }, h('tbody', null, cards.map((c) => h('tr', null,
              h('td', null, h('b', null, c.judge), c.submitted ? '' : h('span', { class: 'faint' }, ' (draft)')),
              h('td', { class: 'faint' }, C.map((k) => `${k.name.split(' ')[0]} ${c[k.id] ?? '–'}${k.id === 'technical' && c.adj_technical != null ? `→${c.adj_technical}` : ''}${k.id === 'presentation' && c.adj_presentation != null ? `→${c.adj_presentation}` : ''}`).join(' · ')),
              h('td', { style: { fontSize: '.82rem' } }, c.strength ? h('div', null, '＋ ', c.strength) : null, c.risk ? h('div', null, '？ ', c.risk) : null, c.next_step ? h('div', null, '→ ', c.next_step) : null, c.adj_note ? h('div', { class: 'faint' }, 'Q&A: ', c.adj_note) : null),
              h('td', null, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!c.excluded, onchange: async (e) => { await api.put(`/api/admin/scores/${c.judge_id}/${r.team_id}/exclude`, { excluded: e.target.checked }); draw(); } }), 'Exclude')))))) : h('p', { class: 'faint' }, 'No scorecards yet.'));
            detail.hidden = false;
          } }, 'Cards'))), detail];
      })));

    const awards = h('div', { class: 'grid two' }, s.awards.map((a) => {
      const cur = d.awards[a.id] || {};
      const sug = d.suggestions[a.id];
      const sel = h('select', { 'aria-label': `${a.name}: team` }, h('option', { value: '' }, '— not assigned —'), d.rows.map((r) => h('option', { value: r.team_id, selected: r.team_id === cur.team_id }, `${r.team}${r.average != null ? ` (${r.average})` : ''}`)));
      const why = h('textarea', { maxlength: 400, 'aria-label': `${a.name}: rationale`, placeholder: 'One-sentence judge rationale (read at the ceremony)', style: { minHeight: '60px' } }, cur.rationale || '');
      return h('div', { class: 'card flat' }, h('b', null, a.name), h('div', { class: 'faint', style: { marginBottom: '8px' } }, a.hint),
        sug ? h('div', { class: 'faint', style: { marginBottom: '6px' } }, 'Suggested: ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); sel.value = sug; } }, teamName(sug))) : a.id === 'ai' ? h('div', { class: 'faint', style: { marginBottom: '6px' } }, 'Judge vote — no automatic suggestion.') : null,
        sel, h('div', { style: { marginTop: '8px' } }, why),
        h('button', { class: 'btn sm', style: { marginTop: '8px' }, onclick: async () => {
          try { await api.put(`/api/admin/awards/${a.id}`, { team_id: sel.value ? Number(sel.value) : null, rationale: why.value }); toast(`${a.name} saved.`, 'ok'); }
          catch (e) {
            if (e.status === 409 && (await confirmBox('One prize per team', `${e.message} Assign anyway?`, 'Assign anyway'))) { await api.put(`/api/admin/awards/${a.id}`, { team_id: Number(sel.value), rationale: why.value, allowDuplicate: true }); toast('Saved.', 'ok'); }
            else if (e.status !== 409) toast(e.message, 'bad');
          }
        } }, 'Save'));
    }));

    clear(root,
      h('section', { class: 'card' }, h('h2', null, 'Judging phases'),
        h('div', { class: 'grid three' },
          toggle('judging_open', 'Primary judging open', 'Judges can submit scorecards. Open at 5:00 p.m. after validation.'),
          toggle('finalists_open', 'Finalist Q&A open', 'Judges may adjust Technical and Presentation for checked finalists only.'),
          toggle('results_published', 'Results published', 'Shows awards to everyone and summarized feedback to each team. Locks scores.', 'Publish results to all participants now? Scores lock.'))),
      h('section', { class: 'card table-wrap' },
        h('div', { class: 'card-head' }, h('h2', null, 'Tabulation'), h('div', { class: 'row' },
          h('button', { class: 'btn secondary sm', onclick: async () => { try { await api.put('/api/admin/settings', { finalists: d.top3 }); toast('Top 3 marked as finalists.', 'ok'); draw(); } catch (e) { toast(e.message, 'bad'); } } }, 'Mark top 3 as finalists'),
          h('a', { class: 'btn secondary sm', href: '/api/admin/export/results.csv' }, '⬇ CSV'))),
        h('p', { class: 'faint' }, 'Score = average of valid judge totals (submitted, not excluded, no conflict). Within 0.25 points, ties break on Impact, then Technical, then Innovation averages, then a judge vote.'),
        table),
      h('section', { class: 'card' }, h('h2', null, 'Awards'),
        h('p', { class: 'faint' }, s.one_prize_per_team ? 'One funded prize per team: Champion is assigned first; specialty awards go to the highest eligible remaining team.' : 'Teams may win more than one award.'),
        awards,
        h('div', { class: 'row', style: { marginTop: '12px' } }, h('a', { class: 'btn secondary', href: '#/results' }, 'Preview results page'))));
  };
  await draw();
  // Live updates must not wipe award notes being typed: offer a refresh instead while editing.
  let banner = null;
  root.addEventListener('input', (e) => { if (e.target.matches('textarea, input[type=text]')) typing = true; });
  const update = () => {
    if (!typing && !root.querySelector('textarea:focus, input[type=text]:focus')) { banner = null; return draw(); }
    if (banner && banner.isConnected) return;
    banner = h('div', { class: 'card row', role: 'status', style: { borderColor: 'var(--gold)', position: 'sticky', top: '8px', zIndex: 6 } },
      h('b', null, 'Scores changed.'), h('span', { class: 'spacer' }), h('button', { class: 'btn sm', onclick: () => { typing = false; banner = null; draw(); } }, 'Refresh (unsaved notes are lost)'));
    root.prepend(banner);
  };
  on('staff:update', update); on('event:update', update);
  return root;
}

// ---------------- audit ----------------
// ---------------- rehearsal checklist (Nov 5) ----------------
async function rehearsal() {
  const root = h('div', { class: 'stack' });
  const draw = async () => {
    const d = await api.get('/api/admin/rehearsal');
    const autoOk = d.auto.filter((x) => x.ok || x.info).length, manOk = d.manual.filter((x) => x.done).length;
    const total = d.auto.length + d.manual.length, done = autoOk + manOk;
    clear(root,
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Rehearsal checklist'), badge(`${done} / ${total} ready`, done === total ? 'ok' : 'warn')),
        h('p', { class: 'faint' }, 'Run through this at the Nov 5 rehearsal and again at 7:00 a.m. on event day. The first list checks itself every time you open this page; tick the second list as you go.'),
        h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': done, 'aria-label': 'Rehearsal progress' }, h('i', { style: { width: `${Math.round((done / total) * 100)}%` } }))),
      h('div', { class: 'grid two' },
        h('section', { class: 'card' }, h('h3', null, 'Checked automatically'),
          h('ul', { class: 'checklist' }, d.auto.map((x) => h('li', null, tick(x.ok, !x.ok && x.warn ? 'warn' : x.info ? 'opt' : undefined),
            h('div', null, x.label, x.detail ? h('div', { class: 'faint' }, x.detail) : null))))),
        h('section', { class: 'card' }, h('h3', null, 'Tick when done'),
          h('ul', { class: 'checklist' }, d.manual.map((x) => h('li', null,
            h('label', { class: 'check', style: { width: '100%' } },
              h('input', { type: 'checkbox', checked: !!x.done, onchange: async (e) => {
                try { await api.put(`/api/admin/rehearsal/${x.id}`, { done: e.target.checked }); draw(); } catch (ex) { toast(ex.message, 'bad'); e.target.checked = !e.target.checked; }
              } }),
              h('span', null, x.label, x.done && x.by ? h('span', { class: 'faint' }, ` · ${x.by}, ${fmtDateTime(x.at)}`) : null))))))),
      h('section', { class: 'card' }, h('h3', null, 'Addresses to test'),
        h('p', { class: 'faint' }, 'Open one of these on a phone that is on the event Wi-Fi. If none work, campus Wi-Fi is blocking device-to-device traffic: use share-online.bat.'),
        d.lan.length ? h('ul', null, d.lan.map((u) => h('li', null, h('code', null, u)))) : h('p', null, 'No network address found. Is the laptop on Wi-Fi?'),
        d.public_url ? h('p', null, 'Public link (PUBLIC_URL): ', h('code', null, d.public_url)) : null));
  };
  await draw();
  return root;
}

async function audit() {
  const { audit: rows } = await api.get('/api/admin/audit');
  return h('section', { class: 'card table-wrap' }, h('h2', null, 'Audit log (latest 300)'),
    h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['When', 'Who', 'Action', 'Detail'].map((x) => h('th', null, x)))),
      h('tbody', null, rows.map((r) => h('tr', null, h('td', { class: 'faint' }, fmtDateTime(r.created_at)), h('td', null, r.name || 'system'), h('td', null, h('code', null, r.action)), h('td', { class: 'faint', style: { fontFamily: 'var(--mono)', fontSize: '.8rem' } }, r.detail))))));
}
