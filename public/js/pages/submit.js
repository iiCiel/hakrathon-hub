import { h, clear, field, toast, busy, confirmBox, modal, fmtDateTime, fmtTime, fmtDur, fmtAgo, badge, tick } from '../ui.js';
import { api, upload } from '../api.js';
import { state, on, onLeave, role, now, go, freezeAt } from '../app.js';
import { sourceBrowser, sourceRunner } from '../components.js';

export async function render() {
  if (role() !== 'participant') { go('#/teams'); return h('div'); }
  if (!state.team) return h('div', { class: 'card empty' }, h('p', null, 'Join a team first.'), h('a', { class: 'btn', href: '#/team' }, 'Team page'));
  const root = h('div');
  let data, dirtyForm = false;

  const load = async () => { data = await api.get('/api/submission'); draw(); };
  const draw = () => clear(root, view());
  on('submission:update', (ev) => { if (!dirtyForm) load(); else if (!(ev && ev.resync)) toast('A teammate saved part of the package. When you save, only the fields you changed are sent, so their work is kept.', '', 8000); });
  // Registered once (view() runs on every redraw). An extension or freeze changes what can be edited.
  let tickFn = null;
  on('tick', (t) => tickFn && tickFn(t));
  const refresh = () => { if (!dirtyForm) load(); };
  on('team:update', refresh); on('event:update', refresh);
  const guard = (e) => { if (dirtyForm) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', guard);
  onLeave(() => window.removeEventListener('beforeunload', guard));

  function view() {
    const s = data.submission;
    let locked = !s.canEdit;
    const markDirty = () => { dirtyForm = true; saveBar.hidden = false; };

    // ---------- text fields ----------
    const title = h('input', { type: 'text', value: s.project_title, maxlength: 120, disabled: locked, oninput: markDirty, placeholder: 'e.g. ZipQueue — advising walk-in queue' });
    const protoUrl = h('input', { type: 'url', value: s.prototype_url, disabled: locked, oninput: markDirty, placeholder: 'https://… (deployed app, dashboard, notebook)' });
    const videoUrl = h('input', { type: 'url', value: s.video_url, disabled: locked, oninput: markDirty, placeholder: 'Panopto / Stream / YouTube (unlisted) link' });
    const videoSecs = h('input', { type: 'text', value: s.video_seconds && !s.video_file ? fmtDur(s.video_seconds) : '', disabled: locked || !!s.video_file, oninput: markDirty, placeholder: 'm:ss', style: { width: '90px' } });
    const runCmd = h('input', { type: 'text', value: s.run_command, disabled: locked, oninput: markDirty, placeholder: 'python3 main.py', style: { fontFamily: 'var(--mono)' } });
    const brief = {}, disc = {};
    for (const [k, , max] of data.briefFields) brief[k] = h('textarea', { disabled: locked, oninput: markDirty, maxlength: max, style: { minHeight: '64px' } }, s.brief[k] || '');
    for (const [k, , max] of data.disclosureFields) disc[k] = h('textarea', { disabled: locked, oninput: markDirty, maxlength: max, style: { minHeight: '64px' } }, s.disclosure[k] || '');
    const BRIEF_HINT = { team_roles: 'Who did what', user: 'Primary College of Business user', problem: 'What happens today and why it matters', solution: 'What you built', success_metric: 'How you would measure that it works',
      architecture: 'Tech stack, data flow, AI components, your original contribution', limitations: 'What it can’t do yet; privacy/security considerations', implementation_path: 'How the College could actually adopt it' };
    const DISC_HINT = { data_sources: 'Public, synthetic or de-identified data only. Write "None" if none.', apis_libraries: 'Frameworks, packages, external APIs', templates: 'Starter templates, boilerplate, pre-existing assets',
      ai_use: 'Which AI tools, for what, with a summary of prompts and generated components', licenses: 'Licenses of reused code/assets', external_help: 'Anyone outside the team who helped (mentor advice counts)' };

    const parseDur = (v) => { if (!v.trim()) return null; const m = /^(\d+):(\d{1,2})$/.exec(v.trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : (Number(v) || null); };
    const saveBtn = h('button', { class: 'btn', onclick: async () => {
      busy(saveBtn, true, 'Saving…');
      try {
        // Send only what this person changed, so teammates editing other fields at the same time don't
        // get their work overwritten with this page's older copy (the server merges partial saves).
        const body = {};
        for (const [k, el] of [['project_title', title], ['prototype_url', protoUrl], ['video_url', videoUrl], ['run_command', runCmd]]) if (el.value !== (s[k] || '')) body[k] = el.value;
        const changedOf = (els, old) => Object.fromEntries(Object.entries(els).filter(([k, el]) => el.value !== (old[k] || '')).map(([k, el]) => [k, el.value]));
        const bc = changedOf(brief, s.brief), dc = changedOf(disc, s.disclosure);
        if (Object.keys(bc).length) body.brief = bc;
        if (Object.keys(dc).length) body.disclosure = dc;
        const oldSecs = s.video_seconds && !s.video_file ? fmtDur(s.video_seconds) : '';
        if (!s.video_file && videoSecs.value !== oldSecs) body.video_seconds = parseDur(videoSecs.value);
        data.submission = (await api.put('/api/submission', body)).submission;
        dirtyForm = false;
        toast('Submission saved.', 'ok');
        draw();
      } catch (e) { toast(e.message, 'bad'); busy(saveBtn, false); }
    } }, 'Save changes');
    const saveBar = h('div', { class: 'card', hidden: true, style: { position: 'sticky', bottom: '12px', zIndex: 5, display: 'flex', alignItems: 'center', gap: '12px', borderColor: 'var(--gold)' } },
      h('b', null, 'Unsaved changes'), h('span', { class: 'spacer' }), saveBtn);

    // ---------- repo ----------
    const repoInput = h('input', { type: 'text', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'GitHub repository URL', value: s.repo_url, disabled: locked, placeholder: 'https://github.com/your-team/project' });
    const snapBtn = h('button', { class: 'btn', disabled: locked, onclick: async () => {
      busy(snapBtn, true, 'Cloning…');
      try {
        const r = await api.post('/api/submission/repo', { repo_url: repoInput.value });
        data.submission = r.submission; toast('Snapshot saved. Judges will see this commit.', 'ok'); draw();
        if (r.skipped && r.skipped.length) leftOut(r.skipped, 'The rest of the repository was saved. Judges won’t see these files on the event computer; rename them on GitHub and snapshot again if they matter:');
      }
      catch (e) { toast(e.message, 'bad'); busy(snapBtn, false); }
    } }, s.repo_sha ? 'Update snapshot' : 'Link & snapshot');

    const uploader = (kind, accept, label, after) => {
      const input = h('input', { type: 'file', accept, hidden: true });
      const bar = h('div', { class: 'progress', hidden: true, style: { marginTop: '8px' } }, h('i', { style: { width: '0%' } }));
      const btn = h('button', { class: 'btn secondary', disabled: locked, onclick: () => input.click() }, label);
      input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        const maxMb = LIMIT_MB[kind];
        if (maxMb && file.size > maxMb * 1024 * 1024) { toast(`That file is ${Math.round(file.size / 1048576)} MB. The limit is ${maxMb} MB.`, 'bad', 8000); input.value = ''; return; }
        const extra = {};
        if (kind === 'video') {
          const secs = await videoDuration(file);
          if (secs) extra.seconds = String(secs);
          if (!secs && !(await confirmBox('This browser can’t play that video', 'Its length couldn’t be read, which usually means judges’ browsers can’t play it either (common with iPhone HEVC .mov files). Export it as an H.264 MP4 if you can, or upload it anyway and check the preview.', 'Upload anyway'))) { input.value = ''; return; }
          if (secs > state.event.max_video_seconds + 0.5 && !(await confirmBox('Video is over 5:00', `This video is ${fmtDur(secs)}. Judges stop watching at 5:00. Upload anyway?`, 'Upload anyway'))) { input.value = ''; return; }
        }
        bar.hidden = false; btn.disabled = true;
        try {
          const r = await upload(`/api/submission/${kind}`, file, extra, (p) => { bar.firstChild.style.width = `${Math.round(p * 100)}%`; });
          data.submission = r.submission; toast('Uploaded.', 'ok'); if (after) after(); draw();
          if (r.skipped && r.skipped.length) leftOut(r.skipped, 'The rest of the zip was saved. These files can’t be stored on the event computer, so judges won’t see them. Rename them and upload again if they matter:');
        } catch (e) { toast(e.message, 'bad'); bar.hidden = true; btn.disabled = false; }
        input.value = '';
      });
      return h('div', null, h('div', { class: 'row' }, btn, input), bar);
    };
    const remover = (kind, what) => h('button', { class: 'btn ghost sm', disabled: locked, onclick: async () => {
      if (!(await confirmBox(`Remove ${what}?`, `This removes the ${what} from your submission.`, 'Remove', true))) return;
      try { data.submission = (await api.del(`/api/submission/${kind}`)).submission; draw(); } catch (e) { toast(e.message, 'bad'); }
    } }, 'Remove');

    // ---------- sections ----------
    const kinds = [s.has_repo ? 'repo' : null, s.has_zip ? 'zip' : null].filter(Boolean);
    const proto = h('section', { class: 'card stack', id: 'prototype' },
      h('div', { class: 'card-head' }, h('h2', null, '1 · Working prototype'), status(s, 'prototype')),
      h('p', { class: 'faint' }, 'Give judges something they can test: a GitHub repo, a zip of your code, and/or a live link. Add backup screenshots or a short capture in case something breaks.'),
      field('Project title', title),
      h('div', null, h('b', null, 'GitHub repository'), h('div', { class: 'faint', style: { margin: '2px 0 6px' } }, 'Must be public (or shared with staff). We take an official snapshot automatically at build freeze; you can snapshot any time before then to check it works.'),
        h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, repoInput, snapBtn),
        s.repo_sha ? h('div', { class: 'faint', style: { marginTop: '6px' } }, tick(true), ' Snapshot ', h('code', null, s.repo_sha.slice(0, 10)), ` · ${s.repo_branch} · captured ${fmtAgo(s.repo_snapshot_at, now())}`, ' ', s.repo_official ? badge('Official freeze snapshot', 'ok') : s.repo_after_freeze ? badge('No commit before the freeze', 'bad') : null, ' ', remover('repo', 'repository')) : null,
        s.repo_error ? h('div', { class: 'badge bad', style: { whiteSpace: 'normal', marginTop: '6px', display: 'block', padding: '6px 10px' } }, s.repo_error) : null),
      h('div', null, h('b', null, 'Or upload a zip'), h('div', { class: 'faint', style: { margin: '2px 0 6px' } }, 'Up to 100 MB (300 MB unpacked). Leave out venv and build folders. The sandbox has no internet, so a Node project only runs if node_modules is included; otherwise give judges a live link.'),
        s.zip_name ? h('div', { class: 'faint', style: { marginBottom: '6px' } }, tick(true), ` ${s.zip_name} · ${fmtDateTime(s.zip_at)} `, remover('zip', 'zip')) : null,
        uploader('zip', '.zip', s.zip_name ? 'Replace zip' : 'Upload .zip')),
      field('Live link (optional)', protoUrl, 'Deployed site, Power BI / Tableau dashboard, Colab notebook, Power Automate flow, etc. Test it from a non-team account.'),
      field('How to run it', runCmd, 'One command judges can run in the sandbox (no internet; Python, Node, C/C++, Java available), e.g. python3 main.py --demo'),
      kinds.length ? h('details', null, h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, 'Preview what judges see / test run'),
        h('div', { class: 'stack', style: { marginTop: '10px' } }, sourceBrowser(state.team.id, kinds[0]), sourceRunner(state.team.id, kinds[0], s.run_command))) : null,
      h('div', null, h('b', null, 'Backup evidence'), h('div', { class: 'faint', style: { margin: '2px 0 6px' } }, 'Screenshots (PNG/JPG/PDF), a short screen capture (MP4/WebM), or a zip of images. If the live prototype fails, this shows it worked before the deadline.'),
        s.fallback_file ? h('div', { class: 'faint', style: { marginBottom: '6px' } }, tick(true), ' ', h('a', { href: `/api/submissions/${state.team.id}/fallback`, target: '_blank', rel: 'noopener' }, `Uploaded ${s.fallback_file}`), ' ', remover('fallback', 'backup evidence')) : null,
        uploader('fallback', '.png,.jpg,.jpeg,.pdf,.mp4,.webm,.zip', s.fallback_file ? 'Replace file' : 'Upload backup evidence')));

    const vid = h('section', { class: 'card stack', id: 'video' },
      h('div', { class: 'card-head' }, h('h2', null, '2 · Recorded demo (5:00 max)'), status(s, 'video')),
      h('p', { class: 'faint' }, 'Show the problem, target user, key workflow, technical approach, the actual prototype, impact, limitations, and next step. Videos are stopped at 5:00.'),
      s.video_file ? h('div', null, h('video', { controls: true, preload: 'metadata', src: `/api/submissions/${state.team.id}/video?v=${encodeURIComponent(s.updated_at)}`, style: { width: '100%', maxHeight: '320px', background: '#000', borderRadius: '8px' } }),
        h('div', { class: 'row', style: { marginTop: '6px' } }, s.video_seconds ? badge(fmtDur(s.video_seconds), s.video_seconds > state.event.max_video_seconds + 0.5 ? 'bad' : 'ok') : null, remover('video', 'video'))) : null,
      uploader('video', '.mp4,.webm,.mov,.m4v', s.video_file ? 'Replace video file' : 'Upload video file (MP4/WebM/MOV, 500 MB max)'),
      h('div', { class: 'row', style: { alignItems: 'flex-end' } }, h('label', { class: 'field', style: { flex: 1, margin: 0 } }, h('span', null, 'Or a video link'), videoUrl),
        !s.video_file ? h('label', { class: 'field', style: { margin: 0 } }, h('span', null, 'Length'), videoSecs) : null),
      h('div', { class: 'faint' }, 'Using a link? Set sharing so anyone at the University (or anyone with the link) can view it, and open it in a private window to check.'));

    const briefSec = h('section', { class: 'card', id: 'brief' },
      h('div', { class: 'card-head' }, h('h2', null, '3 · One-page project brief'), status(s, 'brief')),
      h('p', { class: 'faint' }, 'Fill in the fields below, or upload your one-page brief as PDF/DOCX. Your lane and team name are added automatically.'),
      s.brief_file ? h('div', { class: 'faint', style: { marginBottom: '8px' } }, tick(true), ' ', h('a', { href: `/api/submissions/${state.team.id}/brief`, target: '_blank', rel: 'noopener' }, `Uploaded brief (${s.brief_file})`), ' ', remover('brief', 'uploaded brief')) : null,
      uploader('brief', '.pdf,.docx', s.brief_file ? 'Replace brief file' : 'Upload brief (PDF/DOCX)'),
      h('hr'),
      data.briefFields.map(([k, label]) => field(label, brief[k], BRIEF_HINT[k])));

    const discSec = h('section', { class: 'card', id: 'disclosure' },
      h('div', { class: 'card-head' }, h('h2', null, '4 · Disclosure appendix'), status(s, 'disclosure')),
      h('p', { class: 'faint' }, 'Required. Missing disclosure or undisclosed outside work can lead to a scoring penalty or disqualification. Write “None” where nothing applies.'),
      data.disclosureFields.map(([k, label]) => field(label, disc[k], DISC_HINT[k])));

    // ---------- side ----------
    const fz = freezeAt();
    const countdown = h('b', { style: { fontFamily: 'var(--mono)', fontSize: '1.4rem', color: 'var(--gold-ink)' } });
    const tickDown = (t) => { countdown.textContent = t >= fz ? 'Locked' : fmtCountdownSafe(fz - t); };
    tickDown(now());
    let autoSaved = false;
    tickFn = (t) => {
      tickDown(t);
      // Unsaved edits a few seconds before the freeze: save them rather than lose them.
      if (dirtyForm && !locked && !autoSaved && t < fz && fz - t < 5000) { autoSaved = true; saveBtn.click(); toast('Build freeze is seconds away: saving your changes now.', '', 6000); }
      if (t >= fz && s.canEdit && !locked) {
        locked = true;
        if (!dirtyForm) load();
        else { for (const el of root.querySelectorAll('input, textarea, select, button')) el.disabled = true; toast('Build freeze passed: this page is now read-only.', 'bad', 10000); }
      }
    };
    const logBox = h('div', { class: 'faint', style: { fontSize: '.82rem', maxHeight: '220px', overflowY: 'auto' } });
    api.get(`/api/submissions/${state.team.id}/log`).then((d) => clear(logBox, d.log.slice(0, 40).map((l) => h('div', { style: { padding: '3px 0', borderBottom: '1px dashed var(--line)' } }, `${fmtTime(l.created_at)} · ${l.name || 'system'} · ${l.action}${l.detail ? ` · ${l.detail}` : ''}`)))).catch(() => {});

    const side = h('aside', { class: 'stack sticky' },
      h('section', { class: 'card' },
        h('div', { class: 'row between' }, h('span', { class: 'faint' }, locked ? 'Build freeze passed' : `Build freeze · ${fmtTime(new Date(fz).toISOString())}`), countdown),
        h('div', { style: { marginTop: '10px' } }, s.completeness.complete ? badge('All four deliverables in', 'ok') : badge('Not complete yet', 'warn')),
        h('ul', { class: 'checklist', style: { marginTop: '8px' } }, s.completeness.items.map((i) => h('li', null, tick(i.ok, i.warn ? 'warn' : i.optional && !i.ok ? 'opt' : undefined),
          h('div', null, i.label, i.detail ? h('span', { class: 'faint' }, ` · ${i.detail}`) : null, i.warn ? h('div', { style: { color: 'var(--warn)', fontSize: '.82rem' } }, i.warn) : null))))),
      h('section', { class: 'card' }, h('h3', null, 'Before 4:30'),
        h('ul', { style: { paddingLeft: '18px', margin: 0, fontSize: '.88rem', color: 'var(--ink-2)' } },
          ['Repository/prototype access works from a non-team account', 'Video is 5:00 or less and viewable by judges', 'No confidential or unauthorized data is included', 'Data, APIs, libraries, templates, AI use and outside assets are disclosed'].map((x) => h('li', null, x)))),
      h('section', { class: 'card' }, h('h3', null, 'Activity'), logBox));

    return h('div', null,
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Submission package'),
        h('p', null, locked ? 'Build freeze has passed. This is what judges see.' : 'Everything below is saved with a timestamp. Teammates see changes live.'))),
      locked ? h('div', { class: 'card', style: { borderColor: 'var(--bad)', marginBottom: '16px' } }, h('b', null, 'Locked. '), 'If a link is broken, you may only fix access permissions on the hosting site (not the underlying work) during the 4:30–5:00 validation window.') : null,
      h('div', { class: 'split' }, h('div', { class: 'stack' }, proto, vid, briefSec, discSec, saveBar), side));
  }

  await load();
  return root;
}

function leftOut(list, intro) {
  modal(`${list.length} file${list.length === 1 ? ' was' : 's were'} left out`, h('div', null,
    h('p', null, intro),
    h('ul', { style: { maxHeight: '240px', overflow: 'auto' } }, list.slice(0, 50).map((x) => h('li', null, h('code', null, x.path), ` — ${x.why}`))),
    list.length > 50 ? h('p', { class: 'faint' }, `…and ${list.length - 50} more.`) : null), [{ label: 'OK', value: true }]);
}
const LIMIT_MB = { zip: 100, video: 500, brief: 15, fallback: 100 };
function status(s, id) {
  const i = s.completeness.items.find((x) => x.id === id);
  return i && i.ok ? badge(i.warn ? 'Check length' : 'Done', i.warn ? 'warn' : 'ok') : badge('Missing', 'bad');
}
function fmtCountdownSafe(ms) { const s = Math.floor(ms / 1000); const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60; return hh > 47 ? `${Math.floor(hh / 24)}d ${hh % 24}h` : `${hh ? hh + ':' : ''}${String(mm).padStart(hh ? 2 : 1, '0')}:${String(ss).padStart(2, '0')}`; }
function videoDuration(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    const url = URL.createObjectURL(file);
    v.onloadedmetadata = () => { const d = v.duration; URL.revokeObjectURL(url); resolve(Number.isFinite(d) ? Math.round(d * 10) / 10 : null); };
    v.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    v.src = url;
    setTimeout(() => resolve(null), 8000);
  });
}
