import { h, clear, fmtTime, fmtCountdown, fmtAgo, richText, tick, badge, toDisplay } from '../ui.js';
import { api } from '../api.js';
import { state, now, on, role, freezeAt, laneName, route } from '../app.js';

function currentStage(schedule, t) {
  const list = schedule.map((s) => ({ ...s, s: new Date(s.start).getTime(), e: new Date(s.end).getTime() }));
  const cur = list.filter((x) => x.s <= t && (x.e > t || (x.e === x.s && t - x.s < 60000))).pop();
  const next = list.find((x) => x.s > t);
  return { cur, next, list };
}

export async function render() {
  const ev = state.event;
  const [ann, sub] = await Promise.all([
    api.get('/api/chat/announcements').catch(() => ({ messages: [] })),
    role() === 'participant' && state.team ? api.get('/api/submission').catch(() => null) : null,
  ]);

  const clockCells = h('div', { class: 'bigclock' });
  const timeline = h('ol', { class: 'timeline' });
  const drawClock = () => {
    const t = now();
    const { cur, next, list } = currentStage(ev.schedule || [], t);
    const fz = freezeAt();
    clear(clockCells,
      h('div', { class: 'cell' }, h('div', { class: 'label' }, 'Now'), h('div', { class: 'value', style: { fontSize: '1.25rem', fontFamily: 'var(--sans)' } }, cur ? cur.title : (list.length && t < list[0].s ? 'Event not started' : 'Event complete')),
        h('div', { class: 'sub' }, cur && cur.e > cur.s ? `until ${fmtTime(cur.end)}` : fmtTime(new Date(t).toISOString()))),
      next ? h('div', { class: 'cell' }, h('div', { class: 'label' }, `${next.title} starts in`), h('div', { class: 'value' }, fmtCountdown(next.s - t)), h('div', { class: 'sub' }, `at ${fmtTime(next.start)}`)) : null,
      h('div', { class: 'cell' }, h('div', { class: 'label' }, 'Build freeze'), h('div', { class: 'value gold' }, t < fz ? fmtCountdown(fz - t) : 'Frozen'),
        h('div', { class: 'sub' }, `${fmtTime(new Date(fz).toISOString())}${ev.global_extension_minutes ? ` (extended ${ev.global_extension_minutes} min)` : ''}`)));
    clear(timeline, list.map((x) => {
      const isNow = cur && x.start === cur.start && x.title === cur.title;
      return h('li', { class: isNow ? 'now' : (x.e < t || (x.e === x.s && x.s < t) ? 'past' : '') },
        h('div', { class: 't' }, fmtTime(x.start)), h('div', null, h('div', { class: 'ti' }, x.title), h('div', { class: 'de' }, x.detail)));
    }));
  };
  drawClock();
  on('tick', drawClock);
  // Scroll "Today" to the current item once the page is on screen (offsets are 0 before that).
  let tries = 0;
  const scrollNow = () => {
    if (!timeline.isConnected) { if (++tries < 40) setTimeout(scrollNow, 50); return; }
    const cur = timeline.querySelector('li.now') || timeline.querySelector('li:not(.past)');
    if (cur) timeline.scrollTop = cur.offsetTop - timeline.offsetTop - 40;
  };
  setTimeout(scrollNow, 0);

  const annList = h('div', { class: 'stack' });
  const drawAnn = (msgs) => clear(annList, msgs.length ? msgs.slice(-6).reverse().map((m) =>
    h('div', { style: { paddingBottom: '10px', borderBottom: '1px solid var(--line)' } },
      h('div', { class: 'faint' }, `${m.user.name} · ${fmtAgo(m.created_at, now())}`, m.pinned ? ' · 📌 pinned' : ''),
      h('div', null, richText(m.body)))) : h('p', { class: 'faint' }, 'No announcements yet.'));
  let annMsgs = ann.messages.filter((m) => !m.deleted);
  drawAnn(annMsgs);
  on('chat:message', (m) => { if (m.channel === 'announcements') { annMsgs.push(m); drawAnn(annMsgs); } });
  // Deleted/pinned announcements, a new table number, the challenge release: redraw (the page has no inputs).
  on('chat:update', async (u) => {
    if (u && u.channel && u.channel !== 'announcements') return;
    const d = await api.get('/api/chat/announcements').catch(() => null);
    if (d) { annMsgs = d.messages.filter((m) => !m.deleted); drawAnn(annMsgs); }
  });
  let redrawing = false;
  const redraw = () => { if (!redrawing) { redrawing = true; route(); } };
  on('team:update', redraw); on('event:update', redraw);

  const hero = h('section', { class: 'hero' },
    h('div', { class: 'kicker' }, (() => {
      const sc = (ev.schedule || []).slice().sort((a, b) => new Date(a.start) - new Date(b.start));
      if (!sc.length) return 'College of Business';
      const first = new Date(sc[0].start), last = new Date(Math.max(...sc.map((x) => new Date(x.end || x.start).getTime())));
      return `${toDisplay(first.toISOString()).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })} · College of Business · ${fmtTime(first.toISOString())}–${fmtTime(last.toISOString())}`;
    })()),
    h('h1', null, ev.event_name),
    ev.challenge_released
      ? h('div', null, h('div', { class: 'kicker', style: { marginTop: '6px' } }, 'The challenge'), h('p', { class: 'challenge' }, ev.challenge))
      : h('p', { class: 'challenge' }, 'The detailed challenge brief is released at the start of the event. Watch Announcements.'),
    clockCells);

  const side = h('div', { class: 'stack' }, h('section', { class: 'card' }, h('h2', null, 'Today'), timeline));
  const mainCol = h('div', { class: 'stack' });

  if (role() === 'participant') mainCol.append(teamCard(sub));
  if (role() === 'mentor') mainCol.append(h('section', { class: 'card' }, h('h2', null, 'Mentor desk'),
    h('p', { class: 'muted' }, 'Advise, ask diagnostic questions, and point to documentation. Do not write code, configure the final solution, or share another team’s approach. Log each interaction when you resolve a request.'),
    h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/help' }, 'Open help queue'), h('a', { class: 'btn secondary', href: '#/teams' }, 'Teams'))));
  if (role() === 'judge') mainCol.append(h('section', { class: 'card' }, h('h2', null, 'Judging'),
    h('p', { class: 'muted' }, ev.judging_open ? 'Judging is open. Review each recording and brief, inspect the prototype or repository as needed, and score independently.' : 'Judging opens after the 4:30 p.m. build freeze and staff validation. You can browse teams in the meantime.'),
    h('a', { class: 'btn', href: '#/judge' }, 'Go to judging')));
  if (role() === 'admin') mainCol.append(h('section', { class: 'card' }, h('h2', null, 'Run of show'),
    h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/admin' }, 'Admin overview'), h('a', { class: 'btn secondary', href: '#/admin/event' }, 'Event settings'),
      h('a', { class: 'btn secondary', href: '#/admin/scoring' }, 'Scoring'), h('a', { class: 'btn secondary', href: '#/help' }, 'Help queue'))));
  mainCol.append(h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Announcements'), h('a', { href: '#/chat/announcements' }, 'Open channel')), annList));
  mainCol.append(h('section', { class: 'card' }, h('h2', null, 'Solution lanes'),
    h('p', { class: 'faint' }, 'Every team answers the same challenge and picks one primary lane. Lanes organize ideas; they are not separate judging divisions.'),
    h('div', { class: 'lanes' }, ev.lanes.map((l) => h('div', { class: 'lane', style: { cursor: 'default' } }, h('b', null, l.name), h('small', null, l.hint))))));

  return h('div', { class: 'stack' }, hero, h('div', { class: 'split' }, mainCol, h('aside', { class: 'sticky' }, side)));
}

function teamCard(sub) {
  if (!state.team) {
    return h('section', { class: 'card' }, h('h2', null, 'Get on a team'),
      h('p', { class: 'muted' }, `Teams have ${state.event.team_min}–${state.event.team_max} students. Create a team and share its code, or enter a teammate’s code. Rosters lock at ${fmtTime(state.event.roster_lock_at)}.`),
      h('a', { class: 'btn', href: '#/team' }, 'Create or join a team'));
  }
  const c = sub && sub.submission.completeness;
  const done = c ? c.items.filter((i) => i.ok && !i.optional).length : 0;
  const total = c ? c.items.filter((i) => !i.optional).length : 1;
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, state.team.name), c && c.complete ? badge('Package complete', 'ok') : badge(`${done}/${total} done`, 'warn')),
    h('p', { class: 'faint' }, `Table ${state.team.table_no || '—'} · ${laneName(state.team.lane) || 'No lane yet'} · ${state.team.members.length} member${state.team.members.length === 1 ? '' : 's'}`),
    h('div', { class: 'progress', style: { margin: '8px 0 12px' } }, h('i', { style: { width: `${Math.round((done / total) * 100)}%` } })),
    c ? h('ul', { class: 'checklist' }, c.items.map((i) => h('li', null, tick(i.ok, i.warn ? 'warn' : i.optional && !i.ok ? 'opt' : undefined),
      h('div', null, i.label, i.detail ? h('span', { class: 'faint' }, ` · ${i.detail}`) : null, i.warn ? h('div', { class: 'faint', style: { color: 'var(--warn)' } }, i.warn) : null)))) : null,
    h('div', { class: 'row', style: { marginTop: '12px' } },
      h('a', { class: 'btn', href: '#/workspace' }, 'Open code'), h('a', { class: 'btn secondary', href: '#/team' }, 'Checkpoints'), h('a', { class: 'btn secondary', href: '#/submit' }, 'Submission')));
}
