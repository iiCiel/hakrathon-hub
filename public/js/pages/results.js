import { h, badge } from '../ui.js';
import { api } from '../api.js';
import { state, role, on, route } from '../app.js';

const ICON = { champion: '🏆', ai: '🤖', creative: '💡', practical: '🛠' };

export async function render() {
  let once = false;
  on('event:update', () => { if (!once) { once = true; route(); } }); // results published while the page is open
  const d = await api.get('/api/results');
  if (!d.published && role() !== 'admin') return h('div', { class: 'card empty' }, h('div', { class: 'big' }, '⏳'), 'Results are announced at the awards ceremony.');
  const champion = d.awards.find((a) => a.id === 'champion');
  const others = d.awards.filter((a) => a.id !== 'champion');
  const card = (a, big) => h('div', { class: `award ${big ? 'champion' : ''}` }, h('div', { class: 'trophy' }, ICON[a.id] || '🎖'), h('h3', null, a.name),
    a.team ? h('div', { class: 'team' }, a.team) : h('div', { class: 'faint' }, 'Not announced'),
    a.project_title ? h('div', { style: { opacity: 0.85 } }, a.project_title) : null,
    a.rationale ? h('p', { style: { marginTop: '8px', opacity: 0.9 } }, a.rationale) : null);
  return h('div', { class: 'stack' },
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, `${state.event.event_name} results`), h('p', null, 'Congratulations to every team that built something today.')),
      !d.published ? badge('Preview — not published yet', 'warn') : null),
    others.length ? h('div', { class: 'grid three' }, others.map((a) => card(a))) : null,
    champion ? card(champion, true) : null,
    d.feedback ? h('section', { class: 'card' }, h('h2', null, 'Your team’s judge feedback'),
      h('p', { class: 'faint' }, 'Average criterion scores (1–10) across judges. Individual scorecards stay internal.'),
      h('table', { class: 'tbl' }, h('tbody', null, d.criteria.map((c) => h('tr', null, h('td', null, c.name), h('td', { class: 'num' }, h('b', null, d.feedback.criteria[c.id] ?? '—')))))),
      d.feedback.strengths.length ? [h('h3', { style: { marginTop: '16px' } }, 'Strengths judges noted'), h('ul', null, d.feedback.strengths.map((x) => h('li', null, x)))] : null,
      d.feedback.next_steps.length ? [h('h3', null, 'Recommended next steps'), h('ul', null, d.feedback.next_steps.map((x) => h('li', null, x)))] : null) : null);
}
