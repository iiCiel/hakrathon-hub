import { h, clear, toast, promptBox, confirmBox, initials, badge } from '../ui.js';
import { api } from '../api.js';
import { state, on, onLeave, role, go, freezeAt, route } from '../app.js';
import { loadMonaco, monacoLang, darkMode } from '../monaco.js';

const RUN_EXT = { py: 'python', js: 'javascript', mjs: 'javascript', c: 'c', cpp: 'cpp', cc: 'cpp', java: 'java', sh: 'bash' };

export async function render(rt) {
  const teamId = Number(rt.params[0]) || (state.team && state.team.id);
  if (!teamId) {
    if (role() === 'participant') return h('div', { class: 'card empty', style: { margin: '24px' } }, h('div', { class: 'big' }, '👥'), h('p', null, 'Join a team to get a shared workspace.'), h('a', { class: 'btn', href: '#/team' }, 'Team page'));
    go('#/teams'); return h('div');
  }
  const [meta, all, monaco] = await Promise.all([api.get(`/api/workspace/${teamId}/files`), api.get(`/api/workspace/${teamId}/all`), loadMonaco()]);
  let canWrite = meta.canWrite;
  const mine = state.team && state.team.id === teamId;
  const teamName = mine ? state.team.name : ((await api.get('/api/teams')).teams.find((t) => t.id === teamId) || {}).name || `Team ${teamId}`;

  // ---- file state ----
  const files = new Map(); // path -> { model, version, saved, saving, timer, conflict }
  const mk = (path, content, version) => {
    const uri = monaco.Uri.parse(`file:///t${teamId}/${encodeURI(path)}`);
    const stale = monaco.editor.getModel(uri); // left over from a rename/delete race: start clean
    if (stale) stale.dispose();
    const model = monaco.editor.createModel(content, monacoLang(path), uri);
    const f = { path, model, version, saved: content, saving: false, timer: null, conflict: null };
    model.onDidChangeContent(() => { if (!f.applyingRemote) { drawFiles(); scheduleSave(f); } });
    files.set(path, f);
    return f;
  };
  for (const f of all.files) mk(f.path, f.content, f.version);
  const dirty = (f) => f.model.getValue() !== f.saved;
  let current = [...files.keys()].find((p) => /^main\./.test(p)) || [...files.keys()][0] || null;
  const presence = new Map(); // userId -> {name, path, at}

  // ---- layout ----
  const fileList = h('div', { class: 'list', role: 'listbox', 'aria-label': 'Files' });
  const pathLabel = h('span', { class: 'path' });
  const saveState = h('span', { class: 'faint' });
  const conflictBar = h('div', { class: 'conflict', hidden: true });
  const editorEl = h('div', { id: 'editor' });
  const output = h('pre', { class: 'output', 'aria-live': 'polite' }, h('span', { class: 'sys' }, 'Output appears here. Ctrl+Enter runs your code.'));
  const langSel = h('select', { 'aria-label': 'Language' }, Object.entries(state.runner.langs).map(([k, v]) => h('option', { value: k }, v.name)));
  const entrySel = h('select', { 'aria-label': 'Entry file' });
  const stdin = h('textarea', { 'aria-label': 'Program input (stdin)', placeholder: 'Program input (stdin), optional', style: { minHeight: '60px', fontFamily: 'var(--mono)', fontSize: '.85rem' } });
  const runBtn = h('button', { class: 'btn', onclick: () => runCode() }, '▶ Run ', h('span', { class: 'kbd' }, 'Ctrl+↵'));
  const kbdHint = h('div', { class: 'faint', style: { marginTop: '4px' } }, 'In the editor, Tab indents. Press Ctrl+M first to make Tab move focus out.');
  const runnerNote = h('div', { class: 'faint', style: { marginTop: '6px' } });

  const editor = monaco.editor.create(editorEl, {
    model: current ? files.get(current).model : null, theme: darkMode() ? 'vs-dark' : 'vs', automaticLayout: true, fontSize: 14,
    minimap: { enabled: false }, scrollBeyondLastLine: false, readOnly: !canWrite, tabSize: 4, renderWhitespace: 'selection',
    fontFamily: 'Cascadia Code, Consolas, monospace', fontLigatures: true,
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runCode());
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { const f = files.get(current); if (f) save(f); });
  // Leaving the page: send every unsaved file first (content is read now, the request finishes on
  // its own), then free the editor. One handler so the order can't flip.
  let left = false;
  onLeave(() => {
    left = true;
    window.removeEventListener('beforeunload', unloadGuard);
    for (const f of files.values()) {
      clearTimeout(f.timer);
      if (canWrite && !f.conflict && f.model.getValue() !== f.saved) {
        // A save already in flight bumped the version; ours carries the newest text, so force it.
        api.put(`/api/workspace/${teamId}/file`, { path: f.path, content: f.model.getValue(), baseVersion: f.version, force: f.saving })
          .then((r) => { if (r && r.conflict) toast(`${f.path}: a teammate saved a newer version, so your last edits were not saved.`, 'bad', 10000); })
          .catch((e) => toast(`${f.path} was not saved: ${e.message}`, 'bad', 10000));
      }
    }
    editor.dispose();
    for (const f of files.values()) f.model.dispose();
  });

  // ---- drawing ----
  function drawFiles() {
    const now_ = Date.now();
    const focusedPath = fileList.contains(document.activeElement) ? document.activeElement.dataset.path : null;
    clear(fileList, [...files.keys()].sort().map((p) => {
      const f = files.get(p);
      const viewers = [...presence.values()].filter((x) => x.path === p && x.id !== state.me.id && now_ - x.at < 60000);
      return h('div', { class: `file ${p === current ? 'on' : ''}`, role: 'option', 'aria-selected': String(p === current), tabindex: 0, 'data-path': p,
        onclick: () => open(p), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(p); } } },
      h('span', null, p), dirty(f) ? h('span', { class: 'dirty', title: 'Unsaved' }, '●') : null, f.conflict ? h('span', { title: 'Conflict' }, '⚠') : null,
      h('span', { class: 'who' }, viewers.map((v) => h('i', { title: `${v.name} is here` }, initials(v.name)))));
    }));
    if (focusedPath) [...fileList.children].find((el) => el.dataset.path === focusedPath)?.focus();
  }
  function drawBar() {
    const f = current && files.get(current);
    pathLabel.textContent = current || 'No file';
    saveState.textContent = !canWrite ? 'Read-only' : !f ? '' : f.saving ? 'Saving…' : dirty(f) ? 'Unsaved' : 'Saved';
    if (f && f.conflict) {
      conflictBar.hidden = false;
      clear(conflictBar, h('span', null, `⚠ ${f.conflict.by || 'A teammate'} saved a newer version of ${f.path} while you were editing.`),
        h('button', { class: 'btn sm secondary', onclick: () => { applyRemote(f, f.conflict.content, f.conflict.version); f.conflict = null; drawBar(); drawFiles(); } }, 'Load theirs'),
        canWrite ? h('button', { class: 'btn sm', onclick: () => { const c = f.conflict; f.conflict = null; f.version = c.version; save(f, true); } }, 'Keep mine') : null);
    } else conflictBar.hidden = true;
  }
  function drawRun() {
    const ext = (current || '').split('.').pop().toLowerCase();
    if (RUN_EXT[ext]) langSel.value = RUN_EXT[ext];
    const L = langSel.value;
    const exts = { python: ['py'], javascript: ['js', 'mjs'], c: ['c'], cpp: ['cpp', 'cc'], java: ['java'], bash: ['sh'] }[L] || [];
    const cands = [...files.keys()].filter((p) => exts.includes(p.split('.').pop().toLowerCase())).sort();
    const prev = entrySel.value;
    clear(entrySel, cands.length ? cands.map((p) => h('option', { value: p }, p)) : h('option', { value: '' }, `(no ${exts.join('/')} files)`));
    if (current && cands.includes(current)) entrySel.value = current; else if (cands.includes(prev)) entrySel.value = prev;
    const st = state.runner;
    runBtn.disabled = !cands.length;
    runnerNote.textContent = st.ready ? 'Runs in an isolated sandbox: no internet, 10 s limit, 384 MB memory.' : `Runner unavailable: ${st.reason}`;
  }
  langSel.addEventListener('change', drawRun);

  function open(p) {
    const f = files.get(p);
    if (!f) return;
    current = p;
    editor.setModel(f.model);
    editor.focus();
    drawFiles(); drawBar(); drawRun();
    sendPresence();
  }

  // ---- saving / sync ----
  // Save 1.2 s after typing stops, but never wait more than 4 s while there are unsaved changes:
  // someone typing steadily (or right up to the freeze) still gets saved.
  let offline = false, lateUntil = 0;
  function scheduleSave(f, delay) {
    drawBar();
    if (!canWrite || f.gone) return;
    clearTimeout(f.timer);
    if (!f.dirtySince) f.dirtySince = Date.now();
    const wait = delay ?? Math.max(0, Math.min(1200, f.dirtySince + 4000 - Date.now()));
    f.timer = setTimeout(() => save(f), wait);
  }
  async function save(f, force = false, late = false) {
    if ((!canWrite && !late) || f.saving || f.gone || (!dirty(f) && !force)) return;
    clearTimeout(f.timer);
    f.saving = true; f.dirtySince = 0; drawBar();
    const content = f.model.getValue();
    let retry = 0;
    try {
      const r = await api.put(`/api/workspace/${teamId}/file`, { path: f.path, content, baseVersion: f.version, force });
      if (r.conflict) { if (!(f.lateFlushed && !canWrite)) f.conflict = { content: r.current.content, version: r.current.version, by: r.current.updated_by }; }
      else if (r.file.version > f.version) { f.version = r.file.version; f.saved = content; } // a later save may already have landed
      if (offline) { offline = false; toast('Back online: your changes are saved.', 'ok'); }
      f.backoff = 0;
    } catch (e) {
      if (!e.status) { // no connection: say so once, keep the text, retry with a growing gap
        if (!offline) { offline = true; toast('Can’t reach the server. Your edits are kept here and will save when the connection is back.', 'bad', 8000); }
        f.backoff = Math.min((f.backoff || 1500) * 2, 15000); retry = f.backoff;
      } else if (e.status === 409) { f.gone = true; if (files.get(f.path) === f) toast(`${f.path}: ${e.message}`, 'bad', 12000); }
      else if (!(e.status === 403 && !canWrite && f.lateFlushed)) { // (the freeze save already carried this text)
        toast(e.message, 'bad');
        if (e.status === 403) { canWrite = false; editor.updateOptions({ readOnly: true }); }
      }
    }
    f.saving = false;
    if (left || files.get(f.path) !== f) return; // page closed, or the file was renamed/deleted meanwhile
    drawBar(); drawFiles();
    if (dirty(f) && !f.conflict) {
      if (canWrite) scheduleSave(f, retry || undefined);
      else if (Date.now() < lateUntil && !f.lateFlushed) save(f, false, true); // typed while the last save was on its way
    }
  }
  function applyRemote(f, content, version) {
    const pos = editor.getModel() === f.model ? editor.getPosition() : null;
    f.applyingRemote = true;
    f.model.pushEditOperations([], [{ range: f.model.getFullModelRange(), text: content }], () => null);
    f.applyingRemote = false;
    f.saved = content; f.version = version;
    if (pos) editor.setPosition(pos);
  }
  on('file:update', async (ev) => {
    if (ev.teamId !== teamId || (ev.by && ev.by.id === state.me.id && !ev.renamed && !ev.deleted)) return;
    if (ev.deleted) {
      const f = files.get(ev.path);
      const mineEv = ev.by && ev.by.id === state.me.id;
      if (f && dirty(f) && !mineEv) {
        navigator.clipboard?.writeText(f.model.getValue()).catch(() => {});
        toast(`${ev.by.name} deleted ${ev.path} while you had unsaved edits. Your text was copied to the clipboard (if the browser allowed it).`, 'bad', 12000);
      }
      if (f) { clearTimeout(f.timer); f.model.dispose(); files.delete(ev.path); if (current === ev.path) { current = [...files.keys()][0] || null; editor.setModel(current ? files.get(current).model : null); } }
      if (!mineEv) toast(`${ev.by.name} deleted ${ev.path}`);
    } else if (ev.renamed) {
      const f = files.get(ev.from);
      if (f && !files.has(ev.path)) {
        clearTimeout(f.timer);
        files.delete(ev.from);
        const nf = mk(ev.path, f.model.getValue(), f.version + 1);
        nf.saved = f.saved;
        if (current === ev.from) { const pos = editor.getPosition(); current = ev.path; editor.setModel(nf.model); if (pos) editor.setPosition(pos); if (ev.by && ev.by.id === state.me.id) editor.focus(); }
        f.model.dispose();
        if (dirty(nf)) { toast(`${ev.by.name} renamed ${ev.from} to ${ev.path}. Your unsaved edits moved with it.`, '', 8000); scheduleSave(nf); }
      }
    } else {
      const { file } = await api.get(`/api/workspace/${teamId}/file?path=${encodeURIComponent(ev.path)}`);
      const f = files.get(ev.path);
      if (!f) mk(file.path, file.content, file.version);
      else if (file.version > f.version) {
        if (dirty(f)) f.conflict = { content: file.content, version: file.version, by: ev.by.name };
        else applyRemote(f, file.content, file.version);
      }
    }
    drawFiles(); drawBar(); drawRun();
  });
  on('presence', (p) => { if (p.teamId !== undefined && p.teamId !== teamId) return; presence.set(p.user.id, { id: p.user.id, name: p.user.name, path: p.path, at: Date.now() }); drawFiles(); });
  const sendPresence = () => { if (state.socket) state.socket.emit('presence', { teamId, path: current || '' }); };
  const pt = setInterval(sendPresence, 20000);
  onLeave(() => { clearInterval(pt); if (state.socket) state.socket.emit('presence', { teamId, path: '' }); });
  // After a dropped connection (Wi-Fi, ngrok, a server restart) catch up on what teammates did.
  on('reconnect', () => { sendPresence(); resync(); });
  async function resync() {
    const d = await api.get(`/api/workspace/${teamId}/all`).catch(() => null);
    if (!d || left) return;
    const seen = new Set();
    for (const sf of d.files) {
      seen.add(sf.path);
      try { // one bad file must not stop the rest of the catch-up
        const f = files.get(sf.path);
        if (!f) mk(sf.path, sf.content, sf.version);
        else if (sf.version > f.version && !f.saving) {
          if (dirty(f)) f.conflict = { content: sf.content, version: sf.version, by: 'A teammate' };
          else applyRemote(f, sf.content, sf.version);
        }
      } catch (e) { console.error('resync', sf.path, e); }
    }
    for (const [p, f] of [...files]) {
      if (seen.has(p) || f.saving) continue;
      if (dirty(f)) { f.gone = true; toast(`${p} was renamed or deleted while you were offline. Your text is still open here: copy it into another file.`, 'bad', 12000); continue; }
      clearTimeout(f.timer); files.delete(p); f.model.dispose();
      if (current === p) { current = [...files.keys()][0] || null; editor.setModel(current ? files.get(current).model : null); }
    }
    drawFiles(); drawBar(); drawRun();
  }
  // Freeze happens on the clock; flip to read-only when it passes. freezeAt() follows extensions
  // (it is refreshed on team/event updates), so an extension keeps or re-opens the workspace.
  const member = mine && role() === 'participant';
  let reopening = false, freezeTimer = null;
  const fzAtRender = freezeAt();
  // At the freeze: send every unsaved file right away, even if a save is already on its way (this one
  // carries the newest text), then make the editor read-only.
  function lateSave(f) {
    const content = f.model.getValue();
    f.lateFlushed = true;
    api.put(`/api/workspace/${teamId}/file`, { path: f.path, content, baseVersion: f.version, force: true })
      .then((r) => { if (r.file && r.file.version > f.version) { f.version = r.file.version; f.saved = content; } if (!left) { drawBar(); drawFiles(); } })
      .catch((e) => toast(`${f.path} was not saved at the freeze: ${e.message}`, 'bad', 12000));
  }
  function freezeNow() {
    clearTimeout(freezeTimer); freezeTimer = null;
    if (!canWrite || left) return;
    lateUntil = Date.now() + 4000;
    for (const f of files.values()) { clearTimeout(f.timer); if (dirty(f) && !f.conflict && !f.gone) lateSave(f); }
    canWrite = false; editor.updateOptions({ readOnly: true });
    tools.hidden = true; saveTop.hidden = true; modeNote.textContent = 'Frozen at build freeze';
    drawBar(); toast('Build freeze: the workspace is now read-only.', 'bad', 10000);
  }
  onLeave(() => clearTimeout(freezeTimer));
  on('tick', (t) => {
    if (!member) return;
    const fz = freezeAt();
    const open_ = t < fz;
    // The last seconds before the freeze: save whatever is unsaved right away.
    if (canWrite && open_ && fz - t < 3500) for (const f of files.values()) if (dirty(f) && !f.saving && !f.conflict) save(f);
    // Lock at the exact moment, not up to a second late on the next tick.
    if (canWrite && open_ && fz - t < 1500) { clearTimeout(freezeTimer); freezeTimer = setTimeout(freezeNow, Math.max(0, fz - t)); }
    if (canWrite && !open_) freezeNow();
    else if (!canWrite && open_ && fz > fzAtRender && !reopening) { // only a real extension re-opens it
      reopening = true;
      toast('Your team got more time: the workspace is open again.', 'ok', 8000);
      route(); // redraw with the editing tools
    }
  });
  const unloadGuard = (e) => { if ([...files.values()].some(dirty)) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', unloadGuard);

  // ---- file ops ----
  async function newFile() {
    const p = await promptBox('New file', 'File path (folders allowed)', '', { placeholder: 'e.g. app.py or src/utils.js' });
    if (!p) return;
    if (files.has(p.trim())) { open(p.trim()); return toast(`${p.trim()} already exists.`, 'bad'); }
    try {
      const r = await api.put(`/api/workspace/${teamId}/file`, { path: p.trim(), content: '', create: 'only' });
      if (!files.has(r.file.path)) mk(r.file.path, '', r.file.version);
      open(r.file.path);
    } catch (e) { toast(e.message, 'bad'); }
  }
  async function renameFile() {
    if (!current) return;
    const to = await promptBox('Rename file', 'New path', current);
    if (!to || to === current) return;
    const f = files.get(current);
    for (let i = 0; f.saving && i < 100; i++) await new Promise((r) => setTimeout(r, 100)); // let a save on its way finish
    await save(f);
    try {
      const from = current, dest = to.trim();
      await api.post(`/api/workspace/${teamId}/rename`, { from, to: dest });
      // Our own "renamed" event can arrive before this reply and has already moved the file.
      if (files.has(dest) || !files.has(from) || files.get(from) !== f) { if (files.has(dest) && current !== dest) open(dest); else editor.focus(); return; }
      const pos = editor.getPosition(); // keep the cursor where it was
      clearTimeout(f.timer);
      files.delete(from);
      const nf = mk(dest, f.model.getValue(), f.version + 1);
      nf.saved = f.saved;
      f.model.dispose();
      open(dest);
      if (pos) { editor.setPosition(pos); editor.revealPositionInCenterIfOutsideViewport(pos); }
      if (dirty(nf)) scheduleSave(nf);
    } catch (e) { toast(e.message, 'bad'); }
  }
  async function deleteFile() {
    if (!current || !(await confirmBox('Delete file?', `Delete ${current} for the whole team? This cannot be undone.`, 'Delete', true))) return;
    const p = current, f = files.get(p);
    try {
      await api.del(`/api/workspace/${teamId}/file?path=${encodeURIComponent(p)}`);
      // Our own "deleted" event may already have removed it: only touch this exact file.
      if (files.get(p) === f) {
        clearTimeout(f.timer); files.delete(p); f.model.dispose();
        if (current === p) { current = [...files.keys()][0] || null; editor.setModel(current ? files.get(current).model : null); }
      }
      drawFiles(); drawBar(); drawRun();
    } catch (e) { toast(e.message, 'bad'); }
  }
  const importInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: async () => {
    for (const file of importInput.files) {
      if (file.size > 512 * 1024) { toast(`${file.name} is over 512 KB. Use GitHub for big files.`, 'bad'); continue; }
      let text = await file.text();
      if (/\.sh$/i.test(file.name)) text = text.replace(/\r\n/g, '\n'); // bash in the sandbox needs LF
      if (text.includes('\u0000')) { toast(`${file.name} looks binary; skipped.`, 'bad'); continue; }
      const had = files.get(file.name);
      if (had && !(await confirmBox(`Replace ${file.name}?`, `The team already has ${file.name}. Replace it with the file from your computer for everyone?`, 'Replace', true))) continue;
      try {
        const r = await api.put(`/api/workspace/${teamId}/file`, { path: file.name, content: text, ...(had ? { baseVersion: had.version, force: true } : { create: 'only' }) });
        const ex = files.get(r.file.path);
        if (ex) applyRemote(ex, text, r.file.version); else mk(r.file.path, text, r.file.version);
        current = r.file.path;
      } catch (e) { toast(e.message, 'bad'); }
    }
    importInput.value = '';
    if (current) open(current);
  } });

  // ---- running ----
  async function runCode() {
    const entry = entrySel.value;
    if (!entry) return toast('Pick a file to run.', 'bad');
    const payload = {};
    for (const [p, f] of files) payload[p] = f.model.getValue();
    runBtn.disabled = true;
    clear(output, h('span', { class: 'sys' }, `$ run ${entry} (${state.runner.langs[langSel.value].name})\n`), h('span', { class: 'spinner' }));
    try {
      const r = await api.post('/api/run', { lang: langSel.value, entry, files: payload, stdin: stdin.value });
      clear(output, h('span', { class: 'sys' }, `$ run ${entry}\n`), r.stdout, r.stderr ? h('span', { class: 'err' }, r.stderr) : null,
        h('span', { class: 'sys' }, `\n[exit ${r.exitCode ?? '?'} · ${(r.durationMs / 1000).toFixed(2)} s]`));
    } catch (e) {
      clear(output, h('span', { class: 'err' }, e.message));
      if (e.status === 503) { state.runner.ready = false; state.runner.reason = e.message.replace(/^Code runner unavailable: /, ''); drawRun(); }
    }
    runBtn.disabled = false;
  }

  drawFiles(); drawBar(); drawRun(); sendPresence();
  // Editing tools (hidden when the workspace turns read-only at the freeze).
  const modeNote = h('div', { class: 'faint', style: { margin: '2px 0 8px' } }, canWrite ? 'Shared with your team · autosaves' : meta.frozen ? 'Frozen at build freeze' : 'Read-only');
  const tools = h('div', { class: 'row', style: { gap: '4px' }, hidden: !canWrite },
    h('button', { class: 'btn sm', onclick: newFile }, '+ File'),
    h('button', { class: 'btn secondary sm', onclick: () => importInput.click() }, 'Import'),
    h('button', { class: 'btn ghost sm', onclick: renameFile, title: 'Rename current file' }, 'Rename'),
    h('button', { class: 'btn ghost sm', onclick: deleteFile, title: 'Delete current file', 'aria-label': 'Delete current file' }, '🗑'), importInput);
  const saveTop = h('button', { class: 'btn ghost sm', hidden: !canWrite, onclick: () => { const f = files.get(current); if (f) save(f, false); } }, 'Save');

  return h('div', { class: 'ws' },
    h('aside', { class: 'ws-files' },
      h('div', { class: 'head' },
        h('div', { class: 'row between' }, h('b', null, teamName), !mine ? badge(role() === 'admin' ? 'Admin view' : 'Read-only', 'gold') : null),
        modeNote,
        tools),
      fileList,
      h('div', { class: 'faint', style: { padding: '10px 12px', borderTop: '1px solid var(--line)' } }, 'Big project? Keep it in GitHub and link the repo on the Submit page.')),
    h('section', { class: 'ws-editor' },
      h('div', { class: 'ws-bar' }, pathLabel, saveState, h('span', { class: 'spacer' }), saveTop),
      conflictBar, editorEl),
    h('aside', { class: 'ws-run' },
      h('div', { class: 'sec' },
        h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, langSel, entrySel),
        h('div', { style: { marginTop: '8px' } }, stdin),
        h('div', { class: 'row between', style: { marginTop: '8px' } }, runBtn, h('button', { class: 'btn ghost sm', onclick: () => clear(output) }, 'Clear')),
        runnerNote, kbdHint),
      output));
}
