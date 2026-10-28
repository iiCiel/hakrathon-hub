import { h, clear, badge } from '../ui.js';
import { api } from '../api.js';
import { state, on, role, laneName } from '../app.js';

export async function render() {
  const root = h('div', { class: 'grid three' });
  const draw = async () => {
    const { teams } = await api.get('/api/teams');
    clear(root, teams.length ? teams.map((t) => h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', null, t.name), t.table_no ? badge(`Table ${t.table_no}`, 'blue') : null),
      h('div', { class: 'faint' }, laneName(t.lane) || 'No lane yet'),
      h('ul', { style: { paddingLeft: '18px', margin: '10px 0' } }, t.members.map((m) => h('li', null, m.name, m.preferred_role ? h('span', { class: 'faint' }, ` · ${m.preferred_role}`) : null))),
      role() === 'judge' && !t.frozen ? h('p', { class: 'faint' }, 'Code and submission open to judges at build freeze.')
      : ['admin', 'mentor', 'judge'].includes(role()) ? h('div', { class: 'row' },
        h('a', { class: 'btn secondary sm', href: `#/workspace/${t.id}` }, 'Code'),
        h('a', { class: 'btn secondary sm', href: `#/review/${t.id}` }, 'Submission'),
        role() === 'judge' ? h('a', { class: 'btn sm', href: `#/judge/${t.id}` }, 'Score') : null) : null))
      : h('div', { class: 'card empty' }, h('div', { class: 'big' }, '👥'), 'No teams yet.'));
  };
  await draw();
  on('teams:update', draw);
  return h('div', null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Teams'), h('p', null, `${state.event.event_name} · up to ${state.event.max_teams} teams`))),
    root);
}
