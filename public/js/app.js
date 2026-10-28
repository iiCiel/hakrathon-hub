import { h, clear, toast, initials, fmtCountdown, fmtTime, ROLE_LABEL } from './ui.js';
import { api, ApiError } from './api.js';

export const state = { me: null, team: null, event: null, runner: null, github: false, offset: 0, socket: null };
export const now = () => Date.now() + state.offset;

// ---------- page registry ----------
const pages = {};
export function page(name, loader) { pages[name] = loader; }
page('login', () => import('./pages/login.js'));
page('home', () => import('./pages/home.js'));
page('team', () => import('./pages/team.js'));
page('teams', () => import('./pages/teams.js'));
page('workspace', () => import('./pages/workspace.js'));
page('chat', () => import('./pages/chat.js'));
page('help', () => import('./pages/help.js'));
page('submit', () => import('./pages/submit.js'));
page('judge', () => import('./pages/judge.js'));
page('review', () => import('./pages/review.js'));
page('admin', () => import('./pages/admin.js'));
page('results', () => import('./pages/results.js'));
page('profile', () => import('./pages/profile.js'));

// ---------- per-page socket listeners, cleared on navigation ----------
let pageHandlers = [];
let cleanups = [];
export function on(ev, fn) { pageHandlers.push([ev, fn]); }
export function onLeave(fn) { cleanups.push(fn); }
function dispatch(ev, data) { for (const [e, fn] of pageHandlers) if (e === ev) { try { fn(data); } catch (err) { console.error(err); } } }

// ---------- data ----------
export async function loadMe() {
  const d = await api.get('/api/me', { quiet401: true });
  state.me = d.user; state.team = d.team; state.event = d.event; state.runner = d.runner; state.github = d.github;
  state.offset = new Date(d.serverTime).getTime() - Date.now();
  return d;
}
export const role = () => (state.me ? state.me.role : null);
export const isStaff = () => ['admin', 'judge', 'mentor'].includes(role());
export function freezeAt() {
  if (state.team) return new Date(state.team.freeze_at).getTime();
  return state.event ? new Date(state.event.build_freeze_at).getTime() : Infinity;
}
export const frozen = () => now() >= freezeAt();
export const laneName = (id) => ((state.event && state.event.lanes.find((l) => l.id === id)) || {}).name || '';

// ---------- nav ----------
function navItems() {
  const r = role();
  if (!r) return [];
  const items = [['#/', 'Home', 'home']];
  if (r === 'participant') items.push(['#/team', 'Team', 'team'], ['#/workspace', 'Code', 'workspace'], ['#/chat', 'Chat', 'chat'], ['#/help', 'Mentors', 'help'], ['#/submit', 'Submit', 'submit']);
  if (r === 'mentor') items.push(['#/help', 'Help queue', 'help'], ['#/teams', 'Teams', 'teams'], ['#/chat', 'Chat', 'chat']);
  if (r === 'judge') items.push(['#/judge', 'Judging', 'judge'], ['#/teams', 'Teams', 'teams'], ['#/chat', 'Chat', 'chat']);
  if (r === 'admin') items.push(['#/admin', 'Admin', 'admin'], ['#/teams', 'Teams', 'teams'], ['#/help', 'Help queue', 'help'], ['#/chat', 'Chat', 'chat'], ['#/judge', 'Judging', 'judge']);
  if (state.event && state.event.results_published) items.push(['#/results', 'Results', 'results']);
  return items;
}
let menuOpen = false;
export function renderChrome() {
  const bar = document.getElementById('topbar');
  // The bar is rebuilt on live updates; keep keyboard focus where it was.
  const a = document.activeElement;
  const keep = a && bar.contains(a) ? (a.getAttribute('href') ? `[href="${a.getAttribute('href')}"]` : a.classList.contains('menu-btn') ? '.menu-btn' : a.dataset.key ? `[data-key="${a.dataset.key}"]` : null) : null;
  const cur = currentRoute().name;
  const items = navItems();
  const unread = chatUnread();
  const user = state.me;
  clear(bar, h('div', { class: 'topbar-inner' },
    h('a', { class: 'brand', href: '#/' }, h('span', { class: 'mark' }, '<H>'),
      h('span', { class: 'name' }, (state.event ? state.event.event_name : 'HAkrathon 2026').replace(/(\d{4})$/, ''), h('span', { class: 'year' }, ((state.event ? state.event.event_name : '2026').match(/\d{4}$/) || [''])[0]))),
    h('nav', { class: 'nav', 'aria-label': 'Main' }, items.map(([href, label, name]) =>
      h('a', { href, class: cur === name ? 'active' : '', 'aria-current': cur === name ? 'page' : null }, label, name === 'chat' && unread ? [h('span', { class: 'dot', title: 'New messages', 'aria-hidden': 'true' }), h('span', { class: 'sr' }, ' (new messages)')] : null))),
    user ? h('div', { class: 'clock-pill', id: 'clock-pill', 'aria-live': 'off' }) : null,
    user ? h('div', { class: 'userbox' },
      h('button', { class: 'menu-btn', 'aria-label': 'Account menu', 'aria-expanded': String(menuOpen), 'aria-controls': 'account-menu', onclick: (e) => {
        e.stopPropagation(); menuOpen = !menuOpen; renderChrome();
        if (menuOpen) document.querySelector('#account-menu a, #account-menu button')?.focus();
      } },
        h('span', { class: 'avatar' }, initials(user.name)))) : null));
  if (user && menuOpen) {
    bar.append(h('div', { class: 'dropdown', id: 'account-menu', onclick: (e) => e.stopPropagation(), onkeydown: (e) => {
      if (e.key === 'Escape') { menuOpen = false; renderChrome(); document.querySelector('.menu-btn')?.focus(); }
    }, onfocusout: (e) => { if (menuOpen && e.relatedTarget && !bar.contains(e.relatedTarget)) { menuOpen = false; renderChrome(); } } },
      h('div', { class: 'who' }, h('b', null, user.name), h('br'), user.email, h('br'), h('span', { class: `role-${user.role}` }, ROLE_LABEL[user.role]), state.team ? ` · ${state.team.name}` : ''),
      h('a', { href: '#/profile', onclick: () => { menuOpen = false; setTimeout(renderChrome); } }, 'Profile & password'),
      h('a', { href: '#/teams', onclick: () => { menuOpen = false; setTimeout(renderChrome); } }, 'All teams'),
      h('button', { 'data-key': 'signout', onclick: logout }, 'Sign out')));
  }
  if (keep) bar.querySelector(keep)?.focus();
  tickClock();
  renderBanner();
}
document.addEventListener('click', () => { if (menuOpen) { menuOpen = false; renderChrome(); } });

async function logout() {
  dropSocket();
  try { await api.post('/api/auth/logout'); } catch {}
  state.me = null; state.team = null;
  location.hash = '#/login';
}

// ---------- clock + banners ----------
function nextMoment() {
  const e = state.event;
  if (!e) return null;
  const t = now();
  const marks = [];
  if (role() === 'participant') {
    marks.push([new Date(e.roster_lock_at).getTime(), 'Roster lock'], [new Date(e.cp1_at).getTime(), 'Checkpoint 1 due'],
      [new Date(e.cp2_at).getTime(), 'Checkpoint 2 due'], [freezeAt(), 'Build freeze']);
  } else {
    marks.push([freezeAt(), 'Build freeze'], [new Date(e.validation_end_at).getTime(), 'Validation ends']);
  }
  const sched = (e.schedule || []).map((s) => [new Date(s.start).getTime(), s.title]);
  const next = marks.filter(([ts]) => ts > t).sort((a, b) => a[0] - b[0])[0];
  const nextSched = sched.filter(([ts]) => ts > t).sort((a, b) => a[0] - b[0])[0];
  return next || nextSched || null;
}
function tickClock() {
  const pill = document.getElementById('clock-pill');
  if (!pill) return;
  const n = nextMoment();
  if (!n) { clear(pill, h('span', null, fmtTime(new Date(now()).toISOString(), { second: undefined }))); pill.classList.remove('urgent'); return; }
  const left = n[0] - now();
  const short = { 'Checkpoint 1 due': 'CP1', 'Checkpoint 2 due': 'CP2', 'Build freeze': 'Freeze', 'Roster lock': 'Roster', 'Validation ends': 'Validation' }[n[1]] || n[1].split(/\s+/)[0];
  clear(pill, h('span', { class: 'lbl' }, `${n[1]} in`), h('span', { class: 'lbl-s', 'aria-hidden': 'true' }, short), h('b', null, fmtCountdown(left)));
  pill.classList.toggle('urgent', left < 15 * 60000);
  pill.title = `${n[1]} at ${fmtTime(new Date(n[0]).toISOString())}`;
}
let lastBannerKey = '';
function renderBanner() {
  const el = document.getElementById('banner');
  let key = '', node = null;
  if (state.me && state.event) {
    const fz = freezeAt(), t = now();
    if (role() === 'participant' && state.team) {
      if (t >= fz) { key = 'frozen'; node = h('div', { class: 'banner freeze' }, 'Build freeze has passed. Code and submissions are locked.'); }
      else if (fz - t < 15 * 60000) { key = `soon:${fz}`; node = h('div', { class: 'banner warn' }, `Build freeze at ${fmtTime(new Date(fz).toISOString())}. Upload everything and verify judge access now. No new features.`); }
    }
    if (!key && state.event.is_demo) { key = 'demo'; node = h('div', { class: 'banner freeze' }, 'DEMO copy — not the real event. Nothing here is kept.'); }
    if (!key && role() === 'participant' && !state.team) { key = 'noteam'; node = h('div', { class: 'banner info' }, 'You are not on a team yet. ', h('a', { href: '#/team' }, 'Create or join one')); }
  }
  if (key === lastBannerKey) return;
  lastBannerKey = key;
  clear(el, node);
  document.documentElement.style.setProperty('--banner-h', node ? `${el.offsetHeight}px` : '0px');
}
setInterval(() => { tickClock(); renderBanner(); dispatch('tick', now()); }, 1000);

// ---------- chat unread tracking ----------
const seenKey = () => `hak:seen:${state.me ? state.me.id : 0}`;
export function chatSeen() { try { return JSON.parse(localStorage.getItem(seenKey()) || '{}'); } catch { return {}; } }
export function markSeen(channel, id) {
  try { const s = chatSeen(); if (!s[channel] || s[channel] < id) { s[channel] = id; localStorage.setItem(seenKey(), JSON.stringify(s)); } } catch {}
}
const latest = {};
export function noteLatest(channel, id) { if (!latest[channel] || latest[channel] < id) latest[channel] = id; }
export function chatUnread(channel) {
  const s = chatSeen();
  if (channel) return (latest[channel] || 0) > (s[channel] || 0);
  return Object.keys(latest).some((c) => latest[c] > (s[c] || 0));
}

// ---------- realtime ----------
function connectSocket() {
  if (state.socket || !window.io) return;
  const s = window.io({ transports: ['websocket', 'polling'] });
  state.socket = s;
  s.on('connect_error', (e) => { if (e.message === 'unauthorized') { s.disconnect(); state.socket = null; } });
  s.on('announce', (m) => {
    toast(h('div', null, h('b', null, 'Announcement · '), m.body.length > 240 ? m.body.slice(0, 240) + '…' : m.body), 'announce', 15000);
  });
  s.on('chat:message', (m) => {
    noteLatest(m.channel, m.id);
    if (m.user.id === (state.me && state.me.id)) markSeen(m.channel, m.id);
    dispatch('chat:message', m);
    if (currentRoute().name !== 'chat') renderChrome();
  });
  for (const ev of ['chat:update', 'file:update', 'presence', 'help:update', 'help:new', 'submission:update', 'staff:update', 'teams:update']) s.on(ev, (d) => dispatch(ev, d));
  s.on('help:new', (r) => { if (['admin', 'mentor'].includes(role()) && currentRoute().name !== 'help') toast(`Help needed: ${r.team_name} (table ${r.table_no || '?'}) · ${r.kind}`, '', 8000); });
  for (const ev of ['me:update', 'team:update', 'event:update']) {
    s.on(ev, async () => {
      const before = JSON.stringify([state.me, state.team && state.team.id, state.event]);
      await loadMe().catch(() => {});
      renderChrome();
      dispatch(ev, {});
      if (ev !== 'team:update' && JSON.stringify([state.me, state.team && state.team.id, state.event]) !== before && ev === 'me:update') route();
    });
  }
  s.on('connect', () => { dispatch('reconnect', {}); });
  // The server drops sockets on password change/reset, logout and disable, and Socket.IO does not
  // retry after that. Start a fresh one if the session is still good.
  s.on('disconnect', (reason) => {
    if (reason !== 'io server disconnect') return;
    if (state.socket === s) state.socket = null;
    s.removeAllListeners();
    setTimeout(() => { loadMe().then(() => { if (state.me) { connectSocket(); renderChrome(); } }).catch(() => {}); }, 500);
  });
}
function dropSocket() {
  const s = state.socket;
  state.socket = null;
  if (s) { s.removeAllListeners(); s.disconnect(); }
}

// ---------- router ----------
export function currentRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, query = ''] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  const map = { '': 'home', team: 'team', teams: 'teams', workspace: 'workspace', chat: 'chat', help: 'help', submit: 'submit', judge: 'judge', review: 'review', admin: 'admin', results: 'results', profile: 'profile', login: 'login' };
  return { name: map[parts[0] || ''] || 'home', params: parts.slice(1), query: new URLSearchParams(query) };
}
export function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

let routeSeq = 0;
export async function route() {
  const seq = ++routeSeq;
  for (const fn of cleanups) { try { fn(); } catch {} }
  cleanups = []; pageHandlers = [];
  const r = currentRoute();
  const main = document.getElementById('main');
  if (!state.me && r.name !== 'login') { location.hash = '#/login'; return; }
  if (state.me && r.name === 'login') { location.hash = '#/'; return; }
  main.className = ['chat', 'workspace', 'login'].includes(r.name) ? 'full' : '';
  clear(main, h('div', { class: 'loading' }, h('span', { class: 'spinner' }), ' Loading…'));
  renderChrome();
  try {
    const mod = await pages[r.name]();
    if (seq !== routeSeq) return;
    const el = await mod.render(r);
    if (seq !== routeSeq) return;
    clear(main, el);
    main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  } catch (e) {
    console.error(e);
    if (seq !== routeSeq) return;
    clear(main, h('div', { class: 'card empty' }, h('div', { class: 'big' }, '⚠'), h('p', null, e.message || 'Something went wrong.'), h('a', { class: 'btn secondary', href: '#/' }, 'Go home')));
  }
}

window.addEventListener('hashchange', route);
// Any button whose request fails without its own handler still tells the person why.
window.addEventListener('unhandledrejection', (e) => { if (e.reason instanceof ApiError && e.reason.status !== 401) { toast(e.reason.message, 'bad'); e.preventDefault(); } });
window.addEventListener('hak:unauthorized', () => { dropSocket(); if (state.me) { state.me = null; toast('Your session ended. Please sign in again.', 'bad'); location.hash = '#/login'; } });

export async function boot() {
  try { await loadMe(); } catch { /* offline handled below */ }
  if (state.me) connectSocket();
  renderChrome();
  route();
}
export async function afterLogin() {
  await loadMe();
  connectSocket();
  location.hash = '#/';
}

boot();
