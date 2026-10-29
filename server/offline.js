'use strict';
// Offline judging package (Event Scope Sec. 15 fallback): if the network dies, judges still get
// every team's submission. Builds data/offline-package/ — plain HTML pages plus copies of each
// team's source snapshot, video, brief and backup evidence — that opens from a USB stick in any
// browser with no server. Everything team-written is HTML-escaped; nothing in it runs scripts.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { all, get, DATA_DIR } = require('./db');
const S = require('./settings');
const source = require('./source');

const OUT = path.join(DATA_DIR, 'offline-package');
const UP_DIR = path.join(DATA_DIR, 'uploads');
const TEXT_MAX = 200 * 1024; // per file shown on the code page
const CODE_PAGE_MAX = 3 * 1024 * 1024;
const TEXT_EXT = new Set(['.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt', '.html', '.htm', '.css', '.scss', '.c', '.h', '.cpp', '.hpp', '.cc',
  '.java', '.kt', '.cs', '.go', '.rs', '.rb', '.php', '.sh', '.bat', '.ps1', '.sql', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.xml', '.csv', '.r', '.swift', '.dart', '.vue', '.svelte', '.ipynb', '.env.example', '.gitignore']);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? esc(u) : '');
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'team';
const fmtTime = (iso) => { if (!iso) return ''; try { const ms = Date.parse(iso); if (Number.isNaN(ms)) return iso; return new Date(S.displayMs(ms)).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso; } };

const CSS = `body{font:15px/1.5 system-ui,Segoe UI,Arial,sans-serif;color:#1b1f3a;margin:0;background:#f5f6fb}
main{max-width:980px;margin:0 auto;padding:24px 16px 60px}h1{color:#041e42;margin:.2em 0}h2{color:#041e42;border-bottom:2px solid #a89968;padding-bottom:4px;margin-top:28px}
a{color:#1f4fd1}table{border-collapse:collapse;width:100%;background:#fff}th,td{border:1px solid #d5d8e6;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#041e42;color:#fff}.card{background:#fff;border:1px solid #d5d8e6;border-radius:8px;padding:12px 16px;margin:12px 0}
.k{font-weight:600;color:#3b4166}.miss{color:#a4161a;font-weight:600}.ok{color:#1b7a3a;font-weight:600}pre{background:#0f1430;color:#e8ebff;padding:12px;border-radius:6px;overflow:auto;font-size:13px}
.top{background:#041e42;color:#fff;padding:10px 16px}.top a{color:#fff}video{max-width:100%;background:#000}@media print{.top{display:none}body{background:#fff}}`;
const page = (title, body, up = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https: data:; media-src 'self'; frame-src 'none'">
<title>${esc(title)}</title><style>${CSS}</style></head><body><div class="top">${up ? `<a href="${up}">← All teams</a> · ` : ''}HAkrathon offline judging package</div><main>${body}</main></body></html>`;

async function copyDir(src, dst) {
  if (!fs.existsSync(src)) return 0;
  await fsp.cp(src, dst, { recursive: true, force: true, dereference: false, filter: (p) => !/[\\/]\.git([\\/]|$)/.test(p) });
  return 1;
}
async function walk(root) {
  const out = [];
  const go = async (dir, rel) => {
    for (const d of (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (d.name === '.git' || d.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) await go(path.join(dir, d.name), r);
      else if (d.isFile()) out.push({ rel: r, size: (await fsp.stat(path.join(dir, d.name))).size });
    }
  };
  if (fs.existsSync(root)) await go(root, '');
  return out;
}

function fields(defs, data) {
  return defs.map(([k, label]) => `<p><span class="k">${esc(label)}:</span> ${(data[k] || '').trim() ? esc(data[k]).replace(/\n/g, '<br>') : '<span class="miss">(blank)</span>'}</p>`).join('');
}

async function build() {
  const { BRIEF_FIELDS, DISCLOSURE_FIELDS, completeness } = require('./routes/submit');
  const { getCheckpoints, CP_FIELDS } = require('./routes/core');
  const { ANCHORS } = require('./routes/judge');
  const st = S.getSettings();
  await fsp.rm(OUT, { recursive: true, force: true });
  await fsp.mkdir(OUT, { recursive: true });
  const teams = all('SELECT * FROM teams ORDER BY CAST(table_no AS INTEGER), name');
  const rows = [];
  let bytes = 0;
  for (const t of teams) {
    const s = get('SELECT * FROM submissions WHERE team_id = ?', t.id) || {};
    const dirName = `team-${t.id}-${slug(t.name)}`;
    const dir = path.join(OUT, dirName);
    await fsp.mkdir(dir, { recursive: true });
    const members = all('SELECT name, major FROM users WHERE team_id = ? AND disabled = 0 ORDER BY name', t.id);
    const cps = getCheckpoints(t.id);
    const comp = completeness(t, s, cps);
    const lane = (st.lanes.find((l) => l.id === t.lane) || {}).name || t.lane || '';
    // Files
    const files = {};
    for (const [kind, col] of [['video', 'video_file'], ['brief', 'brief_file'], ['backup', 'fallback_file']]) {
      if (!s[col]) continue;
      const src = path.join(UP_DIR, `team-${t.id}`, s[col]);
      if (!fs.existsSync(src)) continue;
      const name = `${kind}${path.extname(s[col]).toLowerCase()}`;
      await fsp.copyFile(src, path.join(dir, name));
      files[kind] = name; bytes += (await fsp.stat(src)).size;
    }
    const kind = s.source_kind || (source.hasSource(t.id, 'repo') ? 'repo' : source.hasSource(t.id, 'zip') ? 'zip' : '');
    let tree = [];
    let fromEditor = false;
    if (kind && await copyDir(source.teamDir(t.id, kind), path.join(dir, 'source'))) tree = await walk(path.join(dir, 'source'));
    else {
      // No repo or zip: include the team's shared-editor files so judges still see their code.
      const ws = all('SELECT path, content FROM files WHERE team_id = ? ORDER BY path', t.id);
      for (const f of ws) {
        const dst = path.join(dir, 'source', ...f.path.split('/'));
        if (!dst.startsWith(path.join(dir, 'source') + path.sep)) continue;
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await fsp.writeFile(dst, f.content);
      }
      if (ws.length) { fromEditor = true; tree = await walk(path.join(dir, 'source')); }
    }
    bytes += tree.reduce((a, f) => a + f.size, 0);
    // Code page: every readable text file, escaped.
    let codeBytes = 0;
    const blocks = [];
    for (const f of tree) {
      const ext = path.extname(f.rel).toLowerCase() || path.basename(f.rel).toLowerCase();
      if (!TEXT_EXT.has(ext) && !/^(readme|license|dockerfile|makefile|requirements\.txt)$/i.test(path.basename(f.rel))) continue;
      if (f.size > TEXT_MAX || codeBytes + f.size > CODE_PAGE_MAX) { blocks.push(`<h3>${esc(f.rel)}</h3><p><a href="source/${f.rel.split('/').map(encodeURIComponent).join('/')}">Open file</a> (too large to show here)</p>`); continue; }
      const txt = await fsp.readFile(path.join(dir, 'source', f.rel), 'utf8');
      codeBytes += f.size;
      blocks.push(`<h3 id="f-${blocks.length}">${esc(f.rel)}</h3><pre>${esc(txt)}</pre>`);
    }
    await fsp.writeFile(path.join(dir, 'code.html'), page(`${t.name} — code`, `<h1>${esc(t.name)}: code</h1>
<p>${kind === 'repo' ? `GitHub snapshot of <b>${esc(s.repo_url)}</b> at commit <code>${esc(s.repo_sha)}</code>${s.repo_final ? ' (official build-freeze snapshot)' : ' (not the freeze snapshot)'}` : kind === 'zip' ? `Uploaded zip: ${esc(s.zip_name)}` : fromEditor ? 'No repo or zip was submitted; these are the files from the team’s shared editor.' : 'No source submitted.'}</p>
<p>${tree.length} files. The raw files are in the <a href="source/">source</a> folder.</p>${blocks.join('\n') || '<p>No text files.</p>'}`, '../index.html'));

    const brief = JSON.parse(s.brief || '{}'), disc = JSON.parse(s.disclosure || '{}');
    const yt = safeUrl(s.video_url);
    const body = `<h1>${esc(t.name)}</h1>
<p><b>Table ${esc(t.table_no || '—')}</b> · ${esc(lane)} · ${members.map((m) => esc(m.name)).join(', ') || 'no members'}</p>
${s.project_title ? `<p><span class="k">Project:</span> ${esc(s.project_title)}</p>` : ''}
<div class="card"><b>Package check</b><ul>${comp.items.map((i) => `<li class="${i.ok ? 'ok' : i.optional ? '' : 'miss'}">${i.ok ? '✓' : '✗'} ${esc(i.label)}${i.detail ? ` — ${esc(i.detail)}` : ''}${i.warn ? ` — ${esc(i.warn)}` : ''}</li>`).join('')}</ul></div>
<h2>1. Prototype</h2>
<p>${s.prototype_url ? `Live link: ${safeUrl(s.prototype_url) ? `<a href="${safeUrl(s.prototype_url)}">${esc(s.prototype_url)}</a> (needs internet)` : esc(s.prototype_url)}<br>` : ''}
${kind ? `<a href="code.html">Read the code (${tree.length} files)</a>` : fromEditor ? `<span class="miss">No repo or zip.</span> <a href="code.html">Shared-editor files (${tree.length})</a>` : '<span class="miss">No repo or zip.</span>'}
${s.repo_url ? `<br>Repo: ${esc(s.repo_url)}${s.repo_sha ? ` @ <code>${esc(s.repo_sha.slice(0, 12))}</code>` : ''}${s.repo_snapshot_at ? `, snapshot ${esc(fmtTime(s.repo_snapshot_at))}` : ''}` : ''}
${s.run_command ? `<br>Run command: <code>${esc(s.run_command)}</code>` : ''}</p>
<h2>2. Demo video</h2>
${files.video ? `<video controls preload="metadata" src="${files.video}"></video><p>Judging stops at 5:00${s.video_seconds ? `; this video is ${Math.floor(s.video_seconds / 60)}:${String(Math.round(s.video_seconds % 60)).padStart(2, '0')}` : ''}.</p>` : ''}
${yt ? `<p>Video link: <a href="${yt}">${esc(s.video_url)}</a> (needs internet)</p>` : ''}${!files.video && !yt ? '<p class="miss">No video.</p>' : ''}
<h2>3. Project brief</h2>${files.brief ? `<p><a href="${files.brief}">Open the uploaded brief</a></p>` : ''}${fields(BRIEF_FIELDS, brief)}
<h2>4. Disclosures</h2>${fields(DISCLOSURE_FIELDS, disc)}
<h2>Backup evidence</h2>${files.backup ? `<p><a href="${files.backup}">Open backup evidence</a></p>` : '<p>None uploaded.</p>'}
<h2>Checkpoints</h2>${['cp1', 'cp2'].map((k) => cps[k] ? `<div class="card"><b>Checkpoint ${k.slice(2)}</b>${cps[k].late ? ' <span class="miss">late</span>' : ''} · ${esc(fmtTime(cps[k].submitted_at))}${fields(CP_FIELDS[k], cps[k].data)}</div>` : `<p class="miss">Checkpoint ${k.slice(2)} not submitted.</p>`).join('')}`;
    await fsp.writeFile(path.join(dir, 'index.html'), page(t.name, body, '../index.html'));
    rows.push({ t, s, dirName, lane, complete: comp.complete, members: members.length, video: !!(files.video || yt), files: tree.length });
  }

  // Printable paper scoresheet, one per team.
  const crit = st.criteria;
  const sheet = (t) => `<section style="page-break-after:always"><h1>Scoresheet — ${esc(t.name)} (table ${esc(t.table_no || '—')})</h1><p>Judge: ____________________ &nbsp; Conflict of interest? ☐ yes ☐ no</p>
<table><tr><th>Criterion</th><th>Weight</th><th>Score 1–10</th><th>Notes</th></tr>${crit.map((c) => `<tr><td><b>${esc(c.name)}</b><br><small>${esc(c.hint)}</small></td><td>${c.weight}%</td><td style="width:90px"></td><td style="width:40%"></td></tr>`).join('')}</table>
<p><small>${ANCHORS.map((a) => `<b>${esc(a.range)}</b> ${esc(a.text)}`).join(' · ')}</small></p><p>Strength: __________________________________________</p><p>Risk: ______________________________________________</p><p>Next step: _________________________________________</p></section>`;
  await fsp.writeFile(path.join(OUT, 'scoresheets.html'), page('Scoresheets', `<p>Print this page: one sheet per team. Weighted total = Σ score × weight ÷ 10.</p>${teams.map(sheet).join('')}`, 'index.html'));

  const made = new Date().toISOString();
  await fsp.writeFile(path.join(OUT, 'index.html'), page('HAkrathon offline judging package', `<h1>${esc(st.event_name)} — offline judging package</h1>
<p>Built ${esc(fmtTime(made))}. Open a team to see its prototype code, demo video, brief, disclosures and checkpoints. Live links and online videos need internet. <a href="scoresheets.html">Printable scoresheets</a>.</p>
<table><tr><th>Table</th><th>Team</th><th>Lane</th><th>Project</th><th>Package</th><th>Video</th><th>Code files</th></tr>
${rows.map((r) => `<tr><td>${esc(r.t.table_no || '—')}</td><td><a href="${r.dirName}/index.html">${esc(r.t.name)}</a></td><td>${esc(r.lane)}</td><td>${esc(r.s.project_title || '')}</td><td class="${r.complete ? 'ok' : 'miss'}">${r.complete ? 'Complete' : 'Incomplete'}</td><td>${r.video ? 'yes' : '<span class="miss">no</span>'}</td><td>${r.files}</td></tr>`).join('\n')}</table>`));
  return { path: OUT, teams: rows.length, bytes, built_at: made };
}

let building = null;
function buildOnce() {
  if (!building) building = build().finally(() => { building = null; });
  return building;
}
function info() {
  const f = path.join(OUT, 'index.html');
  if (!fs.existsSync(f)) return { path: OUT, built_at: null };
  return { path: OUT, built_at: fs.statSync(f).mtime.toISOString() };
}

module.exports = { buildOnce, info, OUT, esc };
