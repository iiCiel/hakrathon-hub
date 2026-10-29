import { h, clear, toast, highlightCode, fmtBytes, fmtDateTime, fmtTime, fmtDur, badge, tick } from './ui.js';
import { api } from './api.js';
import { state, laneName, role } from './app.js';

// Browse a repo snapshot or extracted zip: file tree on the left, highlighted file or README on the right.
export function sourceBrowser(teamId, kind) {
  const tree = h('nav', { class: 'tree', 'aria-label': 'Files' });
  const view = h('div', { class: 'view' }, h('div', { class: 'loading' }, h('span', { class: 'spinner' })));
  const box = h('div', { class: 'browser' }, tree, view);
  let readmeHtml = '';
  const showReadme = () => clear(view, readmeHtml ? h('div', { class: 'markdown', html: readmeHtml }) : h('div', { class: 'empty' }, 'No README. Pick a file on the left.'));
  (async () => {
    try {
      const d = await api.get(`/api/source/${teamId}/${kind}/tree`);
      readmeHtml = d.readme;
      if (!d.tree) { clear(box, h('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, 'Nothing uploaded yet.')); return; }
      // Files are plain buttons in a list (Tab/Enter/Space work); folders are labels. Up/Down also move.
      clear(tree, h('button', { type: 'button', class: 'node on', 'data-readme': '1', 'aria-current': 'true', onclick: (e) => { select(e.currentTarget); showReadme(); } }, '📘 README'),
        d.tree.map((n) => {
          const depth = n.path.split('/').length - 1;
          const name = n.path.split('/').pop();
          if (n.dir) return h('div', { class: 'node dir', style: { paddingLeft: `${8 + depth * 14}px` } }, h('span', { 'aria-hidden': 'true' }, '📁 '), name, '/', n.skipped ? h('span', { class: 'faint' }, ' (hidden)') : null);
          return h('button', { type: 'button', class: 'node', style: { paddingLeft: `${8 + depth * 14}px` }, title: `${n.path} · ${fmtBytes(n.size)}`, 'aria-label': n.path,
            onclick: (e) => { select(e.currentTarget); openFile(n.path); } }, name);
        }),
        d.truncated ? h('div', { class: 'node faint' }, 'Only the first 5,000 files are listed.') : null);
      showReadme();
    } catch (e) { clear(view, h('div', { class: 'empty' }, e.message)); }
  })();
  function select(el) { for (const x of tree.querySelectorAll('.node.on')) { x.classList.remove('on'); x.removeAttribute('aria-current'); } el.classList.add('on'); el.setAttribute('aria-current', 'true'); }
  tree.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const btns = [...tree.querySelectorAll('button.node')], i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault(); btns[Math.max(0, Math.min(btns.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
  });
  async function openFile(p) {
    clear(view, h('div', { class: 'loading' }, h('span', { class: 'spinner' })));
    try {
      const { file } = await api.get(`/api/source/${teamId}/${kind}/file?path=${encodeURIComponent(p)}`);
      const dl = h('a', { class: 'btn secondary sm', href: `/api/source/${teamId}/${kind}/raw?path=${encodeURIComponent(p)}`, download: '' }, 'Download file');
      if ((file.binary || file.tooLarge) && /\.(png|jpe?g|gif|webp)$/i.test(p)) return clear(view, h('div', { class: 'empty' }, h('img', { src: `/api/source/${teamId}/${kind}/raw?inline=1&path=${encodeURIComponent(p)}`, alt: p, style: { maxWidth: '100%', maxHeight: '520px' } }), h('p', null, dl)));
      if (file.tooLarge) return clear(view, h('div', { class: 'empty' }, h('p', null, `${p} is ${fmtBytes(file.size)} — too large to preview.`), dl));
      if (file.binary) return clear(view, h('div', { class: 'empty' }, h('p', null, `${p} can’t be shown as text (${fmtBytes(file.size)}). Open it on your computer:`), dl));
      clear(view, h('div', { class: 'faint row', style: { padding: '8px 14px', borderBottom: '1px solid var(--line)', fontFamily: 'var(--mono)', gap: '10px', flexWrap: 'nowrap' } },
        h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: p }, `${p} · ${fmtBytes(file.size)} · ${file.notebook ? 'notebook cells (outputs hidden)' : `${file.text.split('\n').length} lines`}`), h('span', { class: 'spacer' }), dl),
        h('pre', null, highlightCode(file.text, file.as || p)));
    } catch (e) { clear(view, h('div', { class: 'empty' }, e.message)); }
  }
  return box;
}

// Run a team's snapshot in the sandbox with its declared (or a custom) run command.
export function sourceRunner(teamId, kind, command, { allowEdit = true } = {}) {
  const cmd = h('input', { type: 'text', 'aria-label': 'Run command', value: command || '', placeholder: 'e.g. python3 app.py', style: { fontFamily: 'var(--mono)' }, readonly: !allowEdit });
  const stdin = h('textarea', { 'aria-label': 'Program input (stdin)', placeholder: 'stdin (optional)', style: { minHeight: '50px', fontFamily: 'var(--mono)', fontSize: '.85rem' } });
  const out = h('pre', { class: 'output', style: { minHeight: '120px', maxHeight: '360px', borderRadius: '8px' } }, h('span', { class: 'sys' }, 'Runs offline in the sandbox (no internet, 30 s). Projects that need packages installed or a web server should be judged from the live link or demo video.'));
  const btn = h('button', { class: 'btn', onclick: async () => {
    if (!cmd.value.trim()) return toast('Enter a run command.', 'bad');
    btn.disabled = true;
    // Installs need the internet, which the sandbox doesn't have: say so instead of a silent timeout.
    const installs = /\b(npm|yarn|pnpm)\s+(i|install|ci|add)\b|\bpip3?\s+install\b|\bpython3?\s+-m\s+pip\s+install\b|\bapt(-get)?\s+install\b|\bgem\s+install\b/.test(cmd.value);
    if (installs) toast('The sandbox has no internet, so package installs fail. Dependencies must already be in the project (or use the live link / video).', '', 10000);
    clear(out, h('span', { class: 'sys' }, `$ ${cmd.value}\n`), h('span', { class: 'spinner' }));
    try {
      const r = await api.post('/api/run/source', { teamId, kind, command: cmd.value, stdin: stdin.value });
      out.dataset.ran = '1';
      clear(out, h('span', { class: 'sys' }, `$ ${cmd.value}\n`), r.stdout, r.stderr ? h('span', { class: 'err' }, r.stderr) : null, h('span', { class: 'sys' }, `\n[exit ${r.exitCode ?? '?'} · ${(r.durationMs / 1000).toFixed(2)} s]`));
    } catch (e) { clear(out, h('span', { class: 'err' }, e.message)); }
    btn.disabled = false;
  } }, '▶ Run');
  return h('div', { class: 'stack' }, h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, cmd, btn), stdin, out);
}

const isVideoHost = (u) => /panopto|stream\.microsoft|sharepoint|youtube|youtu\.be|vimeo|loom|drive\.google/i.test(u || '');

// Read-only view of a full submission package (judges, admins, mentors).
export function submissionView(team, sub, { briefFields, disclosureFields }) {
  const s = sub;
  const sections = [];
  const linkRow = (label, url) => url ? h('div', { class: 'row' }, h('b', null, label), h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url, ' ↗')) : null;

  sections.push(h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('div', null, h('h2', null, s.project_title || team.name), h('div', { class: 'faint' }, `${team.name} · Table ${team.table_no || '—'} · ${laneName(team.lane) || 'No lane'}`)),
      s.completeness.complete ? badge('Package complete', 'ok') : badge('Incomplete', 'bad')),
    h('div', { class: 'faint' }, 'Team: ', team.members.map((m) => `${m.name}${m.preferred_role ? ` (${m.preferred_role})` : ''}`).join(', ')),
    h('ul', { class: 'checklist', style: { marginTop: '10px' } }, s.completeness.items.map((i) => h('li', null, tick(i.ok, i.warn ? 'warn' : i.optional && !i.ok ? 'opt' : undefined), h('div', null, i.label, i.detail ? h('span', { class: 'faint' }, ` · ${i.detail}`) : null, i.warn ? h('div', { style: { color: 'var(--warn)', fontSize: '.85rem' } }, i.warn) : null))))));

  // 1. Prototype
  const proto = h('section', { class: 'card stack' }, h('h2', null, '1 · Working prototype'), linkRow('Live link:', s.prototype_url));
  if (s.repo_url) {
    proto.append(h('div', null, linkRow('Repository:', s.repo_url),
      s.repo_sha ? h('div', { class: 'faint', style: { marginTop: '4px' } }, `Snapshot${s.repo_official ? ' (official, last commit before build freeze)' : s.repo_after_freeze ? ' (taken at freeze, but every commit is dated after the freeze)' : s.repo_unpinned ? ' (freeze snapshot, but the commit GitHub had at the freeze couldn’t be recorded: commit dates not verified)' : s.frozen ? ' (not the official freeze snapshot)' : ''}: `, h('code', null, s.repo_sha.slice(0, 10)), ` on ${s.repo_branch || 'default branch'} · last commit ${fmtDateTime(s.repo_commit_date)} · captured ${fmtDateTime(s.repo_snapshot_at)}`,
        s.repo_commit_date && new Date(s.repo_commit_date) > new Date(s.freeze_at) ? h('span', { class: 'badge bad', style: { marginLeft: '6px' } }, 'Commit after freeze') : null) : null,
      s.repo_error ? h('div', { class: 'badge bad', style: { whiteSpace: 'normal', marginTop: '6px' } }, s.repo_error) : null));
  }
  const kinds = [s.has_repo ? 'repo' : null, s.has_zip ? 'zip' : null].filter(Boolean);
  if (kinds.length) {
    let kind = kinds[0];
    const holder = h('div');
    const runHolder = h('div');
    const canRun = role() !== 'mentor'; // mentors can read code but the sandbox is for teams, judges and staff
    const drawSrc = () => { clear(holder, sourceBrowser(team.id, kind)); if (canRun) clear(runHolder, sourceRunner(team.id, kind, s.run_command)); };
    proto.append(...[kinds.length > 1 ? h('div', { class: 'seg' }, kinds.map((k) => h('button', { class: k === kind ? 'on' : '', 'aria-pressed': String(k === kind), onclick: (e) => { kind = k; for (const b of e.currentTarget.parentNode.children) { b.classList.toggle('on', b === e.currentTarget); b.setAttribute('aria-pressed', String(b === e.currentTarget)); } drawSrc(); } }, k === 'repo' ? 'GitHub snapshot' : `Zip: ${s.zip_name}`))) : null,
      holder,
      !canRun ? null : h('details', null, h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, 'Run it in the sandbox', s.run_command ? h('span', { class: 'faint' }, ` · team says: ${s.run_command}`) : null), h('div', { style: { marginTop: '10px' } }, runHolder))].filter(Boolean));
    drawSrc();
  }
  if (!s.prototype_url && !kinds.length && !s.repo_url) proto.append(h('p', { class: 'faint' }, 'No prototype submitted.'));
  if (s.fallback_file) proto.append(h('div', null, h('b', null, 'Backup evidence: '), h('a', { href: `/api/submissions/${team.id}/fallback`, target: '_blank', rel: 'noopener' }, `Open file (${s.fallback_file})`)));
  sections.push(proto);

  // 2. Video
  const vid = h('section', { class: 'card stack' }, h('div', { class: 'card-head' }, h('h2', null, '2 · Recorded demo'),
    s.video_seconds ? badge(fmtDur(s.video_seconds), s.video_seconds > state.event.max_video_seconds + 0.5 ? 'bad' : 'ok') : null));
  if (s.video_file) {
    const v = h('video', { controls: true, preload: 'metadata', src: `/api/submissions/${team.id}/video`, style: { width: '100%', borderRadius: '8px', background: '#000', maxHeight: '460px' } });
    const warn = h('div', { class: 'faint' });
    v.addEventListener('timeupdate', () => {
      if (v.currentTime >= state.event.max_video_seconds) { v.pause(); warn.textContent = 'Stopped at 5:00 — content after this point is not judged.'; warn.style.color = 'var(--bad)'; }
    });
    vid.append(v, warn);
  }
  if (s.video_url) vid.append(linkRow(isVideoHost(s.video_url) ? 'Video link:' : 'Link:', s.video_url),
    h('p', { class: 'faint' }, 'Linked videos can’t be stopped automatically: judge only the first 5:00.', s.video_seconds && !s.video_file ? ` The team says it runs ${Math.floor(s.video_seconds / 60)}:${String(Math.round(s.video_seconds % 60)).padStart(2, '0')} (not checked).` : ''));
  if (!s.video_file && !s.video_url) vid.append(h('p', { class: 'faint' }, 'No demo submitted.'));
  sections.push(vid);

  // 3. Brief
  const brief = h('section', { class: 'card' }, h('h2', null, '3 · One-page brief'));
  if (s.brief_file) brief.append(h('p', null, h('a', { class: 'btn secondary sm', href: `/api/submissions/${team.id}/brief`, target: '_blank', rel: 'noopener' }, `Open uploaded brief (${s.brief_file})`)));
  if (briefFields.some(([k]) => s.brief[k])) brief.append(h('dl', { class: 'kv' }, briefFields.map(([k, label]) => [h('dt', null, label), h('dd', null, s.brief[k] || '—')])));
  else if (!s.brief_file) brief.append(h('p', { class: 'faint' }, 'No brief submitted.'));
  sections.push(brief);

  // 4. Disclosure
  sections.push(h('section', { class: 'card' }, h('h2', null, '4 · Disclosure appendix'),
    h('dl', { class: 'kv' }, disclosureFields.map(([k, label]) => [h('dt', null, label), h('dd', null, s.disclosure[k] || h('span', { style: { color: 'var(--bad)' } }, 'Missing'))]))));

  // Checkpoints
  const cp = s.checkpoints;
  sections.push(h('section', { class: 'card' }, h('h2', null, 'Checkpoints'),
    cp.cp1 ? [h('h3', null, 'Problem statement ', h('span', { class: 'faint' }, `· ${fmtTime(cp.cp1.submitted_at)}${cp.cp1.late ? ' (late)' : ''}`)),
      h('dl', { class: 'kv' }, [['user', 'Primary user'], ['problem', 'Problem'], ['outcome', 'Proposed outcome'], ['evidence', 'Evidence'], ['success', 'Success measure'], ['tech', 'Planned tech']].map(([k, l]) => [h('dt', null, l), h('dd', null, cp.cp1.data[k] || '—')]))] : h('p', { class: 'faint' }, 'Checkpoint 1 not submitted.'),
    cp.cp2 ? [h('h3', { style: { marginTop: '14px' } }, 'Demo plan ', h('span', { class: 'faint' }, `· ${fmtTime(cp.cp2.submitted_at)}${cp.cp2.late ? ' (late)' : ''}`)),
      h('ul', null, ['demo1', 'demo2', 'demo3'].map((k) => h('li', null, cp.cp2.data[k]))), cp.cp2.data.blockers ? h('p', { class: 'faint' }, 'Blockers: ', cp.cp2.data.blockers) : null] : h('p', { class: 'faint' }, 'Checkpoint 2 not submitted.')));

  return h('div', { class: 'stack' }, sections);
}
