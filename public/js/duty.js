// On-duty check-in for mentors and judges, plus the "who is here" list.
import { h, clear, toast, busy, fmtAgo } from './ui.js';
import { api } from './api.js';
import { on, now } from './app.js';

// Card for mentors, judges and admins: your own toggle + everyone's status.
export function dutyCard() {
  const body = h('div', { class: 'stack' });
  const draw = async () => {
    const d = await api.get('/api/duty').catch(() => null);
    if (!d) return;
    const here = d.staff.filter((s) => s.on_duty);
    const away = d.staff.filter((s) => !s.on_duty);
    const row = (s) => h('div', { class: 'row between', style: { padding: '4px 0' } },
      h('span', null, s.on_duty ? '🟢 ' : '⚪ ', h('b', null, s.name), h('span', { class: 'faint' }, ` · ${s.role}`)),
      h('span', { class: 'faint', 'data-ago': s.since || '' }, s.on_duty && s.since ? `in ${fmtAgo(s.since, now())}` : 'away'));
    clear(body,
      d.me ? h('button', { class: d.me.on_duty ? 'btn secondary' : 'btn', onclick: async (e) => {
        busy(e.target, true, 'Saving…');
        try { await api.post('/api/duty', { on: !d.me.on_duty }); toast(d.me.on_duty ? 'Marked away.' : 'Checked in. Thanks!', 'ok'); }
        catch (ex) { toast(ex.message, 'bad'); }
        draw();
      } }, d.me.on_duty ? 'Step away (check out)' : 'I’m here (check in)') : null,
      h('div', { class: 'faint' }, `${here.length} on duty`),
      h('div', null, here.concat(away).map(row)),
      d.staff.length ? null : h('p', { class: 'faint' }, 'No mentors or judges registered yet.'));
  };
  draw();
  on('duty:update', draw);
  return h('section', { class: 'card' }, h('h2', null, 'Who’s here'), body);
}

// One line for students: which mentors are in right now.
export function mentorsHereLine() {
  const el = h('p', { class: 'faint' });
  const draw = async () => {
    const d = await api.get('/api/duty').catch(() => null);
    if (!d) return;
    const names = d.staff.filter((s) => s.on_duty).map((s) => s.name);
    el.textContent = names.length ? `Mentors here now: ${names.join(', ')}` : 'No mentor is checked in right now. Your request still goes in the queue.';
  };
  draw();
  on('duty:update', draw);
  return el;
}
