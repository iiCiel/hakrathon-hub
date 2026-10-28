// DOM helpers. Everything user-supplied goes through textContent; innerHTML is only used for
// server-sanitized README HTML and highlight.js output (which escapes its input).

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export function clear(el, ...children) { el.replaceChildren(); append(el, children); return el; }

export function toast(msg, kind = '', ms = 4500) {
  const box = document.getElementById('toasts');
  const t = h('div', { class: `toast ${kind}`, role: kind === 'bad' ? 'alert' : 'status' },
    h('div', null, msg), h('button', { class: 'x', 'aria-label': 'Dismiss', onclick: () => t.remove() }, '×'));
  box.append(t);
  if (ms) setTimeout(() => t.remove(), ms);
  return t;
}

export function modal(title, body, actions = []) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const close = (v) => {
      back.remove(); document.removeEventListener('keydown', onKey); resolve(v);
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus(); // give focus back
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(null); return; }
      if (e.key !== 'Tab') return;
      // Keep Tab inside the dialog.
      const items = [...box.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !box.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;
    const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, h('h2', { id: titleId }, title), body,
      h('div', { class: 'row end', style: { marginTop: '16px' } },
        actions.map((a) => h('button', { class: `btn ${a.class || ''}`, onclick: async () => {
          if (a.handler) { try { const r = await a.handler(); if (r === false) return; close(r ?? a.value); } catch (e) { toast(e.message, 'bad'); } }
          else close(a.value);
        } }, a.label))));
    const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(null); } }, box);
    document.body.append(back);
    document.addEventListener('keydown', onKey);
    const f = box.querySelector('input, textarea, select, button');
    if (f) setTimeout(() => f.focus(), 30);
  });
}
export async function confirmBox(title, text, okLabel = 'Confirm', danger = false) {
  return (await modal(title, h('p', null, text), [{ label: 'Cancel', class: 'secondary', value: false }, { label: okLabel, class: danger ? 'danger' : '', value: true }])) === true;
}
export async function promptBox(title, label, value = '', { multiline = false, placeholder = '' } = {}) {
  const input = multiline ? h('textarea', { placeholder }, value) : h('input', { type: 'text', value, placeholder });
  input.addEventListener('keydown', (e) => { if (!multiline && e.key === 'Enter') e.target.closest('.modal').querySelector('.row.end .btn:last-child').click(); });
  const r = await modal(title, h('label', { class: 'field' }, h('span', null, label), input),
    [{ label: 'Cancel', class: 'secondary', value: null }, { label: 'OK', handler: () => input.value }]);
  return r;
}

export const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0].toUpperCase()).join('') || '?';
export function fmtTime(iso, opts = {}) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', ...opts });
}
export function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function fmtAgo(iso, now = Date.now()) {
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return fmtDateTime(iso);
}
export function fmtCountdown(ms) {
  if (ms <= 0) return '0:00';
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  if (hh > 47) return `${Math.floor(hh / 24)}d ${hh % 24}h`;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
}
export const fmtDur = (sec) => (sec == null ? '' : `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`);
export const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// Chat formatting: ```code fences```, `inline code`, **bold**, and links. Built as DOM nodes.
export function richText(text) {
  const frag = document.createDocumentFragment();
  const parts = String(text).split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      let lang = '', code = part;
      const m = /^([a-zA-Z0-9+#-]{1,20})\n/.exec(part);
      if (m) { lang = m[1].toLowerCase(); code = part.slice(m[0].length); }
      code = code.replace(/^\n/, '').replace(/\n$/, '');
      const c = h('code');
      if (window.hljs) {
        try { c.innerHTML = lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang }).value : hljs.highlightAuto(code).value; c.className = 'hljs'; }
        catch { c.textContent = code; }
      } else c.textContent = code;
      frag.append(h('pre', null, c));
    } else inline(part, frag);
  });
  return frag;
}
function inline(text, into) {
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'")\]])/g;
  let last = 0, m;
  const pushText = (s) => {
    const lines = s.split('\n');
    lines.forEach((ln, j) => { if (j) into.append(h('br')); if (ln) into.append(document.createTextNode(ln)); });
  };
  while ((m = re.exec(text))) {
    pushText(text.slice(last, m.index));
    if (m[1]) into.append(h('code', { class: 'inline' }, m[1].slice(1, -1)));
    else if (m[2]) into.append(h('strong', null, m[2].slice(2, -2)));
    else if (m[3]) into.append(h('a', { href: m[3], target: '_blank', rel: 'noopener noreferrer nofollow' }, m[3]));
    last = m.index + m[0].length;
  }
  pushText(text.slice(last));
}

export function highlightCode(code, path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  const map = { js: 'javascript', mjs: 'javascript', ts: 'typescript', py: 'python', rb: 'ruby', cs: 'csharp', kt: 'kotlin', rs: 'rust', sh: 'bash', yml: 'yaml', md: 'markdown', h: 'c', hpp: 'cpp', cc: 'cpp', jsx: 'javascript', tsx: 'typescript', vue: 'xml', html: 'xml', htm: 'xml', svg: 'xml' };
  const lang = map[ext] || ext;
  const c = h('code', { class: 'hljs' });
  try {
    if (window.hljs && code.length < 300000) c.innerHTML = hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang }).value : hljs.highlightAuto(code).value;
    else c.textContent = code;
  } catch { c.textContent = code; }
  return c;
}

export function badge(text, kind = '') { return h('span', { class: `badge ${kind}` }, text); }
export function tick(ok, kind) {
  const said = kind === 'warn' ? 'Needs attention: ' : ok ? 'Done: ' : kind === 'opt' ? 'Optional, not done: ' : 'Missing: ';
  return [h('span', { class: `tick ${kind || (ok ? 'ok' : 'no')}`, 'aria-hidden': 'true' }, ok ? '✓' : kind === 'warn' ? '!' : ''), h('span', { class: 'sr' }, said)];
}
export const ROLE_LABEL = { admin: 'Event staff', judge: 'Judge', mentor: 'Mentor', participant: 'Participant' };
export function field(label, input, hint) { return h('label', { class: 'field' }, h('span', null, label), input, hint ? h('small', null, hint) : null); }

// Collect named inputs from a container into an object.
export function formData(root) {
  const out = {};
  for (const el of root.querySelectorAll('[name]')) {
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else out[el.name] = el.value;
  }
  return out;
}
export function busy(btn, on, label) {
  if (on) { btn.dataset.label = btn.textContent; btn.disabled = true; clear(btn, h('span', { class: 'spinner' }), ' ', label || 'Working…'); }
  else { btn.disabled = false; btn.textContent = btn.dataset.label || btn.textContent; }
}
