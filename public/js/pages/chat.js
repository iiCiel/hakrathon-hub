import { h, clear, toast, initials, richText, fmtTime, fmtDateTime, confirmBox, ROLE_LABEL } from '../ui.js';
import { api } from '../api.js';
import { state, on, role, go, markSeen, noteLatest, chatUnread, renderChrome } from '../app.js';

export async function render(route) {
  const { channels } = await api.get('/api/chat/channels');
  let current = route.params.join('/') || (state.team ? `team:${state.team.id}` : 'general');
  if (!channels.some((c) => c.id === current)) current = 'general';
  const chan = channels.find((c) => c.id === current);

  const side = h('nav', { class: 'chat-side', 'aria-label': 'Channels' });
  const drawSide = () => {
    const groups = [['Event', channels.filter((c) => !c.team && c.id !== 'staff')], ['Staff', channels.filter((c) => c.id === 'staff')], ['Teams', channels.filter((c) => c.team)]];
    clear(side, groups.filter(([, list]) => list.length).map(([title, list]) => [h('h4', null, title),
      list.map((c) => h('button', { class: `chan ${c.id === current ? 'on' : ''}`, 'aria-current': c.id === current ? 'page' : null, onclick: () => go(`#/chat/${c.id}`) },
        c.id === 'announcements' ? '📣' : c.team ? '👥' : c.id === 'staff' ? '🔒' : '#', ' ', c.name,
        c.id !== current && chatUnread(c.id) ? [h('span', { class: 'unread', 'aria-hidden': 'true' }, '•'), h('span', { class: 'sr' }, ' (new messages)')] : null))]));
    // On phones the channels are one scrolling row: keep the open one in view.
    requestAnimationFrame(() => { const on_ = side.querySelector('.chan.on'); if (on_ && side.scrollWidth > side.clientWidth) side.scrollLeft = on_.offsetLeft - (side.clientWidth - on_.offsetWidth) / 2; });
  };

  const list = h('div', { class: 'msgs', role: 'log', 'aria-live': 'polite', 'aria-label': `${chan.name} messages` });
  const pins = h('div', { class: 'pins', hidden: true });
  let messages = [];
  let pinned = [];

  const msgNode = (m, prev) => {
    const cont = prev && prev.user.id === m.user.id && !prev.deleted && new Date(m.created_at) - new Date(prev.created_at) < 5 * 60000;
    const tools = h('span', { class: 'tools' },
      !m.deleted && (m.user.id === state.me.id || role() === 'admin') ? h('button', { class: 'btn ghost sm', title: 'Delete', 'aria-label': 'Delete message', onclick: async () => {
        if (await confirmBox('Delete message?', 'This removes the message for everyone.', 'Delete', true)) api.del(`/api/chat/messages/${m.id}`).catch((e) => toast(e.message, 'bad'));
      } }, '🗑') : null,
      !m.deleted && role() === 'admin' ? h('button', { class: 'btn ghost sm', title: m.pinned ? 'Unpin' : 'Pin', 'aria-label': m.pinned ? 'Unpin message' : 'Pin message', onclick: () => api.post(`/api/chat/messages/${m.id}/pin`, { pinned: !m.pinned }).catch((e) => toast(e.message, 'bad')) }, m.pinned ? '📌✕' : '📌') : null);
    return h('div', { class: `msg ${cont ? 'cont' : ''} ${m.deleted ? 'deleted' : ''}`, 'data-id': m.id },
      h('span', { class: 'avatar', 'aria-hidden': 'true', style: m.user.role !== 'participant' ? { background: 'var(--navy)', color: '#fff' } : null }, initials(m.user.name)),
      h('div', null,
        cont ? null : h('div', { class: 'meta' }, h('b', null, m.user.name),
          m.user.role !== 'participant' ? h('span', { class: `role-${m.user.role}`, style: { fontWeight: 700 } }, ROLE_LABEL[m.user.role]) : (m.user.team ? h('span', null, m.user.team) : null),
          h('span', { title: fmtDateTime(m.created_at) }, fmtTime(m.created_at)), m.pinned ? h('span', null, '📌') : null, h('span', { class: 'spacer' }), tools),
        h('div', { class: 'body' }, m.deleted ? 'Message deleted' : richText(m.body)), cont ? h('div', { class: 'meta' }, h('span', { class: 'spacer' }), tools) : null));
  };
  // Channels keep everything; the page loads the latest 100 and fetches older ones on demand.
  let hasMore = false, loadingOlder = false;
  const loadOlder = async () => {
    if (loadingOlder || !hasMore || !messages.length) return;
    loadingOlder = true;
    const h0 = list.scrollHeight, top0 = list.scrollTop;
    const d = await api.get(`/api/chat/${encodeURIComponent(current)}?before=${messages[0].id}`).catch((e) => { toast(e.message, 'bad'); return null; });
    loadingOlder = false;
    if (!d) return;
    hasMore = d.messages.length >= 100;
    messages = d.messages.filter((m) => !messages.some((x) => x.id === m.id)).concat(messages);
    drawMsgs(false);
    list.scrollTop = list.scrollHeight - h0 + top0; // keep the reader where they were
  };
  list.addEventListener('scroll', () => { if (list.scrollTop < 40) loadOlder(); });
  const drawMsgs = (stick = true) => {
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    clear(list, hasMore ? h('button', { class: 'btn ghost sm', style: { display: 'block', margin: '6px auto' }, onclick: loadOlder }, 'Load older messages') : null,
      messages.length ? messages.map((m, i) => msgNode(m, messages[i - 1])) : h('div', { class: 'empty' }, h('div', { class: 'big' }, '💬'), `No messages in ${chan.name} yet.`));
    if (stick || atBottom) list.scrollTop = list.scrollHeight;
    pins.hidden = !pinned.length;
    clear(pins, pinned.map((p) => h('div', null, '📌 ', h('b', null, p.user.name, ': '), p.body.length > 200 ? p.body.slice(0, 200) + '…' : p.body)));
    if (messages.length) { const last = messages[messages.length - 1].id; noteLatest(current, last); markSeen(current, last); renderChrome(); }
  };
  // New and edited messages change one node, so screen readers announce just that message.
  const seen = () => { if (messages.length) { const last = messages[messages.length - 1].id; noteLatest(current, last); markSeen(current, last); renderChrome(); } };
  const appendMsg = (m) => {
    if (messages.length === 1 || !list.querySelector('.msg')) return drawMsgs(true);
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.append(msgNode(m, messages[messages.length - 2]));
    if (atBottom || m.user.id === state.me.id) list.scrollTop = list.scrollHeight;
    seen();
  };
  const load = async () => {
    const d = await api.get(`/api/chat/${encodeURIComponent(current)}`);
    messages = d.messages; pinned = d.pinned; hasMore = d.messages.length >= 100;
    drawMsgs(true);
    drawSide();
  };

  const input = h('textarea', { placeholder: chan.canPost ? `Message ${chan.name}` : 'Only event staff can post here', disabled: !chan.canPost, maxlength: 4000, 'aria-label': 'Message', rows: 2 });
  const send = async () => {
    const body = input.value.trim();
    if (!body) return;
    input.disabled = true;
    try {
      const { message } = role() === 'admin' && current === 'announcements'
        ? await api.post('/api/admin/announce', { body })
        : await api.post(`/api/chat/${encodeURIComponent(current)}`, { body });
      input.value = '';
      if (!messages.some((m) => m.id === message.id)) { messages.push(message); appendMsg(message); }
    } catch (e) { toast(e.message, 'bad'); }
    input.disabled = false; input.focus();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });

  on('chat:message', (m) => {
    if (m.channel === current) { if (!messages.some((x) => x.id === m.id)) { messages.push(m); appendMsg(m); } }
    else drawSide();
  });
  on('chat:update', (m) => {
    if (m.channel !== current) return;
    const i = messages.findIndex((x) => x.id === m.id);
    if (i >= 0) messages[i] = m;
    pinned = messages.filter((x) => x.pinned && !x.deleted).reverse().concat(pinned.filter((p) => !messages.some((x) => x.id === p.id) && p.id !== m.id)).slice(0, 10);
    const node = list.querySelector(`.msg[data-id="${m.id}"]`);
    if (node && i >= 0) {
      node.replaceWith(msgNode(m, messages[i - 1]));
      pins.hidden = !pinned.length;
      clear(pins, pinned.map((p) => h('div', null, '📌 ', h('b', null, p.user.name, ': '), p.body.length > 200 ? p.body.slice(0, 200) + '…' : p.body)));
    } else drawMsgs(false);
  });
  on('reconnect', load);

  await load();
  return h('div', { class: 'chat' }, side,
    h('section', { class: 'chat-main' },
      h('div', { class: 'chat-head' }, h('b', null, chan.name), h('div', { class: 'd' }, chan.desc)),
      pins, list,
      h('div', { class: 'compose' },
        h('div', { class: 'row', style: { alignItems: 'flex-end', flexWrap: 'nowrap' } }, input, h('button', { class: 'btn', onclick: send, disabled: !chan.canPost }, 'Send')),
        h('div', { class: 'hint' }, current === 'announcements' && role() === 'admin' ? 'Posting here notifies everyone with a pop-up.' : 'Enter to send · Shift+Enter for a new line · ```code``` for code blocks'))));
}
