import { h, clear, field, toast, formData, busy, confirmBox, fmtTime, fmtDateTime, badge, initials } from '../ui.js';
import { api } from '../api.js';
import { state, loadMe, renderChrome, route, now, on, role, frozen, go } from '../app.js';

const CP = {
  cp1: { title: 'Checkpoint 1 · Problem statement', due: () => state.event.cp1_at, fields: [
    ['user', 'Primary user', 'Who specifically experiences the problem? (a College of Business user)', false],
    ['problem', 'One-sentence problem', 'What happens today, and why is it worth fixing?', true],
    ['outcome', 'Proposed outcome', 'What should be faster, safer, easier, more accessible, or more effective?', true],
    ['evidence', 'Evidence', 'Observation, public data, interview insight, or reasonable assumption that supports the need.', true],
    ['success', 'Success measure', 'What result would show that the solution works?', false],
    ['tech', 'Planned technology', 'Languages, frameworks, data, AI tools you plan to use.', true],
  ] },
  cp2: { title: 'Checkpoint 2 · Demo plan', due: () => state.event.cp2_at, fields: [
    ['core', 'Working core (optional note)', 'What did you show your mentor?', false],
    ['blockers', 'Blockers (optional)', 'Anything stopping you right now?', true],
    ['demo1', 'Demo plan · bullet 1', '', false], ['demo2', 'Demo plan · bullet 2', '', false], ['demo3', 'Demo plan · bullet 3', '', false],
  ] },
};

export async function render() {
  if (role() !== 'participant') { go('#/teams'); return h('div'); }
  await loadMe();
  if (!state.team) return noTeam();
  const root = h('div');
  const draw = async () => {
    const cps = (await api.get('/api/teams/mine/checkpoints')).checkpoints;
    clear(root, teamView(cps, draw));
  };
  await draw();
  on('team:update', async () => { await loadMe(); if (!state.team) return route(); draw(); });
  return root;
}

function noTeam() {
  const ev = state.event;
  const locked = now() >= new Date(ev.roster_lock_at).getTime();
  const create = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    const btn = create.querySelector('button');
    busy(btn, true);
    try { await api.post('/api/teams', formData(create)); await loadMe(); renderChrome(); toast('Team created. Share the join code with your teammates.', 'ok'); route(); }
    catch (ex) { toast(ex.message, 'bad'); busy(btn, false); }
  } },
  h('h2', null, 'Create a team'),
  field('Team name', h('input', { type: 'text', name: 'name', required: true, maxlength: 60, disabled: locked })),
  field('Solution lane', h('select', { name: 'lane', disabled: locked }, h('option', { value: '' }, 'Decide later'), ev.lanes.map((l) => h('option', { value: l.id }, l.name))), 'You can change this until build freeze.'),
  h('button', { class: 'btn', type: 'submit', disabled: locked }, 'Create team'));
  const join = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    const btn = join.querySelector('button');
    busy(btn, true);
    try { const r = await api.post('/api/teams/join', formData(join)); await loadMe(); renderChrome(); toast(`You joined ${r.team.name}.`, 'ok'); route(); }
    catch (ex) { toast(ex.message, 'bad'); busy(btn, false); }
  } },
  h('h2', null, 'Join a team'),
  field('Team code', h('input', { type: 'text', name: 'code', required: true, maxlength: 12, placeholder: 'e.g. K7M2QX', autocomplete: 'off', style: { textTransform: 'uppercase', fontFamily: 'var(--mono)', letterSpacing: '.1em' }, disabled: locked }), 'Ask a teammate for the 6-character code on their Team page.'),
  h('button', { class: 'btn', type: 'submit', disabled: locked }, 'Join team'));
  return h('div', null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Your team'),
      h('p', null, `Teams of ${ev.team_min}–${ev.team_max}. Recommended mix: a technical builder, a problem/business lead, and a presentation/UX lead.`))),
    locked ? h('div', { class: 'card', style: { marginBottom: '16px', borderColor: 'var(--warn)' } }, h('b', null, 'Rosters locked at ' + fmtTime(ev.roster_lock_at) + '.'), ' Ask event staff to place you on a team.') : null,
    h('div', { class: 'grid two' }, create, join));
}

function teamView(cps, redraw) {
  const t = state.team, ev = state.event;
  const locked = now() >= new Date(ev.roster_lock_at).getTime();
  const isFrozen = frozen();

  const roster = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, 'Roster'), badge(`${t.members.length}/${ev.team_max}`, t.members.length >= ev.team_min ? 'ok' : 'warn')),
    h('div', { class: 'stack' }, t.members.map((m) => h('div', { class: 'row' }, h('span', { class: 'avatar' }, initials(m.name)),
      h('div', null, h('b', null, m.name, m.id === state.me.id ? ' (you)' : ''), h('div', { class: 'faint' }, [m.preferred_role, m.major].filter(Boolean).join(' · ') || '—'))))),
    t.members.length < ev.team_min ? h('p', { class: 'faint', style: { color: 'var(--warn)', marginTop: '10px' } }, `You need at least ${ev.team_min} members before rosters lock at ${fmtTime(ev.roster_lock_at)}.`) : null,
    hrule(),
    h('div', { class: 'faint' }, 'Team join code'),
    h('div', { class: 'row' }, h('span', { class: 'codebox' }, t.join_code),
      h('button', { class: 'btn secondary sm', onclick: () => navigator.clipboard.writeText(t.join_code).then(() => toast('Copied.', 'ok')) }, 'Copy'),
      !locked ? h('button', { class: 'btn ghost sm', onclick: async () => { await api.post('/api/teams/mine/new-code'); await loadMe(); redraw(); } }, 'New code') : null),
    h('p', { class: 'faint', style: { marginTop: '8px' } }, locked ? `Rosters locked at ${fmtTime(ev.roster_lock_at)}.` : `Rosters lock at ${fmtTime(ev.roster_lock_at)}.`),
    !locked ? h('button', { class: 'btn ghost sm', style: { color: 'var(--bad)' }, onclick: async () => {
      if (!(await confirmBox('Leave team?', `You will leave ${t.name}.${t.members.length === 1 ? ' The team will be deleted because you are the last member.' : ''}`, 'Leave team', true))) return;
      try { await api.post('/api/teams/leave'); await loadMe(); renderChrome(); route(); } catch (e) { toast(e.message, 'bad'); }
    } }, 'Leave team') : null);

  const nameInput = h('input', { type: 'text', value: t.name, maxlength: 60, disabled: locked || isFrozen });
  const details = h('section', { class: 'card' }, h('h2', null, 'Project lane'),
    h('p', { class: 'faint' }, 'Pick your primary lane. All lanes are judged together on the same rubric.'),
    h('div', { class: 'lanes' }, ev.lanes.map((l) => h('button', { class: `lane ${t.lane === l.id ? 'on' : ''}`, disabled: isFrozen, 'aria-pressed': String(t.lane === l.id), onclick: async () => {
      try { await api.patch('/api/teams/mine', { lane: l.id }); await loadMe(); redraw(); } catch (e) { toast(e.message, 'bad'); }
    } }, h('b', null, l.name), h('small', null, l.hint)))),
    hrule(),
    h('div', { class: 'row', style: { alignItems: 'flex-end' } },
      h('label', { class: 'field', style: { flex: 1, margin: 0 } }, h('span', null, 'Team name'), nameInput),
      h('button', { class: 'btn secondary', disabled: locked || isFrozen, onclick: async () => {
        try { await api.patch('/api/teams/mine', { name: nameInput.value }); await loadMe(); renderChrome(); toast('Saved.', 'ok'); } catch (e) { toast(e.message, 'bad'); }
      } }, 'Rename')),
    h('p', { class: 'faint', style: { marginTop: '8px' } }, `Table ${t.table_no || 'not assigned yet'}`));

  return h('div', null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, t.name), h('p', null, 'Roster, lane and the two required checkpoints.'))),
    h('div', { class: 'split wide-side' },
      h('div', { class: 'stack' }, details, cpForm('cp1', cps.cp1, isFrozen, redraw), cpForm('cp2', cps.cp2, isFrozen, redraw)),
      h('aside', { class: 'stack sticky' }, roster)));
}
const hrule = () => h('hr');

function cpForm(kind, existing, isFrozen, redraw) {
  const spec = CP[kind];
  const data = existing ? existing.data : {};
  const due = new Date(spec.due());
  const form = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    busy(btn, true, 'Submitting…');
    try { await api.put(`/api/teams/mine/checkpoints/${kind}`, formData(form)); toast(`${spec.title.split(' · ')[0]} submitted.`, 'ok'); redraw(); }
    catch (ex) { toast(ex.message, 'bad'); busy(btn, false); }
  } },
  h('div', { class: 'card-head' }, h('h2', null, spec.title),
    existing ? badge(existing.late ? `Submitted late · ${fmtTime(existing.submitted_at)}` : `Submitted ${fmtTime(existing.submitted_at)}`, existing.late ? 'warn' : 'ok')
      : badge(`Due ${fmtTime(due.toISOString())}`, now() > due.getTime() ? 'bad' : 'blue')),
  existing ? h('p', { class: 'faint' }, `Last submitted by ${existing.submitted_by} at ${fmtDateTime(existing.submitted_at)}. You can update it until build freeze.`) : null,
  spec.fields.map(([k, label, hint, multi]) => field(label,
    multi ? h('textarea', { name: k, disabled: isFrozen, maxlength: 800 }, data[k] || '') : h('input', { type: 'text', name: k, value: data[k] || '', disabled: isFrozen, maxlength: 600 }), hint)),
  h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'submit', disabled: isFrozen }, existing ? 'Update' : 'Submit checkpoint')));
  return form;
}
