import { h, clear, field, toast, formData, busy, fmtAgo, fmtTime, badge, modal } from '../ui.js';
import { api } from '../api.js';
import { state, on, role, now } from '../app.js';

const STATUS = { open: ['Waiting', 'warn'], claimed: ['Mentor on the way', 'blue'], resolved: ['Resolved', 'ok'], cancelled: ['Cancelled', ''] };

export async function render() {
  return ['admin', 'mentor'].includes(role()) ? mentorView() : participantView();
}

async function participantView() {
  const listEl = h('div', { class: 'stack' });
  let kinds = {};
  const draw = async () => {
    const d = await api.get('/api/help');
    kinds = d.kinds;
    clear(listEl, d.requests.length ? d.requests.map((r) => h('div', { class: 'card flat' },
      h('div', { class: 'row between' }, h('b', null, kinds[r.kind] || r.kind), badge(...STATUS[r.status])),
      h('p', { style: { margin: '6px 0' } }, r.summary),
      h('div', { class: 'faint' }, `Asked by ${r.requester} · ${fmtAgo(r.created_at, now())}`, r.mentor_name ? ` · ${r.mentor_name}` : ''),
      ['open', 'claimed'].includes(r.status) ? h('button', { class: 'btn ghost sm', style: { marginTop: '6px' }, onclick: async () => { await api.post(`/api/help/${r.id}/cancel`); draw(); } }, 'Cancel request') : null))
      : h('p', { class: 'faint' }, 'No requests yet.'));
  };
  await draw();
  on('help:update', draw);
  if (!state.team) return h('div', { class: 'card empty' }, 'Join a team to request a mentor.');
  const form = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    busy(btn, true, 'Sending…');
    try { await api.post('/api/help', formData(form)); form.reset(); toast('Request sent. A mentor will come to your table.', 'ok'); draw(); }
    catch (ex) { toast(ex.message, 'bad'); }
    busy(btn, false);
  } },
  h('h2', null, 'Ask for a mentor'),
  h('p', { class: 'faint' }, 'Mentors ask diagnostic questions, suggest documentation or architecture options, and help you get unstuck. They advise; they do not build.'),
  field('Type of help', h('div', { class: 'seg', role: 'radiogroup' }, Object.entries({ technical: 'Technical', business: 'Problem / business', presentation: 'Presentation' }).map(([k, v], i) =>
    h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px', cursor: 'pointer' } }, h('input', { type: 'radio', name: 'kind', value: k, checked: i === 0 }), v)))),
  field('What do you need?', h('textarea', { name: 'summary', required: true, maxlength: 500, placeholder: 'e.g. Our Flask app can’t read the CSV after deploying — getting a FileNotFoundError.' })),
  h('button', { class: 'btn', type: 'submit' }, 'Request mentor'));
  return h('div', null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Mentors'), h('p', null, `Table ${state.team.table_no || '—'} · requests go to every mentor on duty.`))),
    h('div', { class: 'split' }, form, h('aside', { class: 'card' }, h('h2', null, 'Your team’s requests'), listEl)));
}

async function mentorView() {
  const root = h('div', { class: 'stack' });
  let filter = 'active';
  const draw = async () => {
    const d = await api.get('/api/help');
    const active = d.requests.filter((r) => ['open', 'claimed'].includes(r.status));
    const done = d.requests.filter((r) => !['open', 'claimed'].includes(r.status));
    const shown = filter === 'active' ? active : done;
    clear(root,
      h('div', { class: 'row' }, h('div', { class: 'seg' },
        h('button', { class: filter === 'active' ? 'on' : '', onclick: () => { filter = 'active'; draw(); } }, `Active (${active.length})`),
        h('button', { class: filter === 'done' ? 'on' : '', onclick: () => { filter = 'done'; draw(); } }, `Mentor log (${done.length})`)),
      role() === 'admin' ? h('a', { class: 'btn secondary sm', href: '/api/admin/export/mentor-log.csv' }, 'Export mentor log') : null),
      shown.length ? h('div', { class: 'grid two' }, shown.map((r) => card(r, d.kinds, draw)))
        : h('div', { class: 'card empty' }, h('div', { class: 'big' }, filter === 'active' ? '✅' : '📒'), filter === 'active' ? 'No teams waiting. Nice.' : 'No resolved requests yet.'));
  };
  await draw();
  on('help:update', draw);
  on('tick', () => { for (const el of root.querySelectorAll('[data-ago]')) el.textContent = fmtAgo(el.dataset.ago, now()); });
  return h('div', null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Help queue'), h('p', null, 'Claim a request, go to the table, then resolve it with a short log note.'))),
    root);
}

function card(r, kinds, redraw) {
  const mine = r.mentor_id === state.me.id;
  const act = async (action, body) => { try { await api.post(`/api/help/${r.id}/${action}`, body); redraw(); } catch (e) { toast(e.message, 'bad'); } };
  return h('section', { class: 'card', style: r.status === 'open' ? { borderLeft: '4px solid var(--gold)' } : null },
    h('div', { class: 'row between' }, h('h3', { style: { margin: 0 } }, r.team_name, h('span', { class: 'faint' }, ` · table ${r.table_no || '?'}`)), badge(...STATUS[r.status])),
    h('div', { class: 'faint', style: { margin: '4px 0 8px' } }, h('b', null, kinds[r.kind] || r.kind), ' · asked by ', r.requester, ' · ', h('span', { 'data-ago': r.created_at }, fmtAgo(r.created_at, now()))),
    h('p', null, r.summary),
    r.mentor_name ? h('div', { class: 'faint' }, `${r.status === 'claimed' ? 'With' : 'Handled by'} ${r.mentor_name}${r.claimed_at ? ` since ${fmtTime(r.claimed_at)}` : ''}`) : null,
    r.mentor_note ? h('div', { class: 'card flat', style: { background: 'var(--panel-2)', padding: '8px 10px', marginTop: '8px', fontSize: '.9rem' } }, h('b', null, 'Log: '), r.mentor_note) : null,
    h('div', { class: 'row', style: { marginTop: '10px' } },
      r.status === 'open' ? h('button', { class: 'btn', onclick: () => act('claim') }, 'I’ll take it') : null,
      r.status === 'claimed' && (mine || role() === 'admin') ? [
        h('button', { class: 'btn', onclick: async () => {
          const ta = h('textarea', { placeholder: 'What did you discuss? (no solution code)', maxlength: 1000 });
          const note = await modal('Resolve & log', h('div', null, h('p', { class: 'faint' }, 'Mentor logs are kept for event review. Note the questions asked and guidance given.'), ta),
            [{ label: 'Cancel', class: 'secondary', value: null }, { label: 'Resolve', handler: () => { if (!ta.value.trim()) { toast('Add a short note.', 'bad'); return false; } return ta.value; } }]);
          if (note) act('resolve', { note });
        } }, 'Resolve'),
        h('button', { class: 'btn secondary', onclick: () => act('release') }, 'Release')] : null,
      h('a', { class: 'btn ghost sm', href: `#/workspace/${r.team_id}` }, 'View code')));
}
