'use strict';
// Team source code for judges: GitHub repo snapshots (git clone at a known commit) and zip uploads.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');
const { DATA_DIR } = require('./db');
const { safeRel } = require('./runner');

const SRC_DIR = path.join(DATA_DIR, 'source');
fs.mkdirSync(SRC_DIR, { recursive: true });
const MAX_BYTES = 300 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', '.gradle', 'target', 'bin', 'obj', '.idea', '.vs']);
const GIT = process.env.GIT_BIN || 'git';

const GH_RE = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;
function parseGithubUrl(url) {
  const m = GH_RE.exec(String(url || '').trim());
  if (!m || m[2] === '.' || m[2] === '..') return null;
  return { owner: m[1], repo: m[2], url: `https://github.com/${m[1]}/${m[2]}` };
}

const teamDir = (teamId, kind) => path.join(SRC_DIR, `team-${Number(teamId)}`, kind);

function git(args, opts = {}) {
  return new Promise((resolve) => {
    execFile(GIT, args, {
      timeout: opts.timeout || 90000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}), GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' },
    }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim(), err }));
  });
}

async function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) total += (await fsp.stat(p)).size;
      if (total > MAX_BYTES) return total;
    }
  }
  return total;
}

// Windows can briefly lock folders (antivirus, an open file), so renames retry a few times.
async function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { return await fsp.rename(from, to); }
    catch (e) {
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
}
async function replaceDir(finalDir, tmpDir) {
  const old = `${finalDir}.old-${Date.now()}`;
  if (fs.existsSync(finalDir)) await renameRetry(finalDir, old);
  await renameRetry(tmpDir, finalDir);
  fsp.rm(old, { recursive: true, force: true }).catch(() => {});
}

// Clone a public (or token-accessible) GitHub repo at its default branch head. With `before`
// (the team's freeze time, ms) it takes the last commit made before then instead, so pushes that
// land while the freeze sweep is still cloning don't become the official snapshot.
async function snapshotRepo(teamId, url, { useToken = false, before = 0 } = {}) {
  const gh = parseGithubUrl(url);
  if (!gh) throw Object.assign(new Error('Use a GitHub repository URL like https://github.com/owner/repo'), { status: 400 });
  const root = path.join(SRC_DIR, `team-${Number(teamId)}`);
  await fsp.mkdir(root, { recursive: true });
  const tmp = path.join(root, `repo-tmp-${crypto.randomBytes(4).toString('hex')}`);
  // The token is only used for snapshots an admin starts, so a team can't point the portal at a
  // private repo the token can read (another team's, or the organizer's).
  const token = useToken ? process.env.GITHUB_TOKEN : '';
  const cloneUrl = `${gh.url}.git`;
  // Token goes in through GIT_CONFIG_* env vars: never in argv, the URL, or .git/config.
  const authEnv = token ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` } : {};
  const safe = ['-c', 'core.symlinks=false', '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=',
    '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never'];
  // A freeze snapshot needs history to find the pre-freeze commit: blobless clone, checkout after.
  const how = before ? ['--filter=blob:none', '--no-checkout'] : ['--depth', '1'];
  const r = await git([...safe, 'clone', ...how, '--single-branch', '--no-tags', '--', cloneUrl, tmp], { env: authEnv, timeout: before ? 150000 : 90000 });
  const scrub = (s) => (token ? s.split(token).join('***') : s);
  if (!r.ok) {
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    const msg = /not found|could not read Username|Authentication failed|terminal prompts disabled/i.test(r.stderr)
      ? 'Repository not found or not public. Make it public (or ask staff to add access) and try again.'
      : (r.err && r.err.killed ? 'Cloning took too long (90s limit).' : 'Clone failed. Check the URL and that the repository is public, then try again or ask staff.');
    if (!/not found|terminal prompts disabled/i.test(r.stderr)) console.error(`[git] team ${teamId} clone failed: ${scrub(r.stderr).slice(-500)}`);
    throw Object.assign(new Error(msg), { status: 400 });
  }
  let afterFreeze = false;
  if (before) {
    let pick = (await git(['rev-list', '-1', `--before=${Math.floor(before / 1000)}`, 'HEAD'], { cwd: tmp })).stdout;
    if (!pick) { pick = 'HEAD'; afterFreeze = true; } // every commit is dated after the freeze
    const co = await git([...safe, 'checkout', '--detach', '-q', pick], { cwd: tmp, env: authEnv, timeout: 150000 });
    if (!co.ok) {
      fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      console.error(`[git] team ${teamId} checkout failed: ${scrub(co.stderr).slice(-500)}`);
      throw Object.assign(new Error('Snapshot failed while checking out the pre-freeze commit. Try again or ask staff.'), { status: 400 });
    }
  }
  const sha = (await git(['rev-parse', 'HEAD'], { cwd: tmp })).stdout;
  const date = (await git(['log', '-1', '--format=%cI'], { cwd: tmp })).stdout;
  const branch = before ? (await git(['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'], { cwd: tmp })).stdout.replace(/^origin\//, '')
    || (await git(['branch', '--show-current'], { cwd: tmp })).stdout || 'HEAD'
    : (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmp })).stdout;
  await fsp.rm(path.join(tmp, '.git'), { recursive: true, force: true });
  if ((await dirSize(tmp)) > MAX_BYTES) {
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw Object.assign(new Error('Repository is larger than 300 MB. Remove large files and try again.'), { status: 400 });
  }
  await replaceDir(teamDir(teamId, 'repo'), tmp);
  return { sha, commitDate: date, branch, url: gh.url, afterFreeze };
}

// Extract an uploaded zip safely: no path traversal, no symlinks, size/entry caps.
async function extractZip(teamId, zipPath) {
  let zip;
  try { zip = new AdmZip(zipPath); } catch { throw Object.assign(new Error('That file is not a valid zip.'), { status: 400 }); }
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  if (entries.length > 20000) throw Object.assign(new Error('Zip has too many files (20,000 max).'), { status: 400 });
  let total = 0;
  for (const e of entries) total += e.header.size;
  if (total > MAX_BYTES) throw Object.assign(new Error('Zip unpacks to more than 300 MB.'), { status: 400 });
  // Strip a single shared top-level folder (e.g. GitHub "repo-main/").
  const names = entries.map((e) => e.entryName.replace(/\\/g, '/'));
  const real = names.filter((n) => !/^([\\/]|[a-zA-Z]:)/.test(n) && !n.startsWith('__MACOSX/'));
  const firsts = new Set(real.map((n) => n.split('/')[0]));
  const strip = firsts.size === 1 && real.every((n) => n.includes('/')) ? [...firsts][0] + '/' : '';
  const root = path.join(SRC_DIR, `team-${Number(teamId)}`);
  await fsp.mkdir(root, { recursive: true });
  const tmp = path.join(root, `zip-tmp-${crypto.randomBytes(4).toString('hex')}`);
  await fsp.mkdir(tmp);
  let written = 0;
  try {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const mode = (e.attr >>> 16) & 0o170000;
      if (mode === 0o120000) continue; // symlink
      let name = names[i];
      if (/^([\\/]|[a-zA-Z]:)/.test(name)) continue; // absolute paths are never valid zip entries
      if (strip) name = name.slice(strip.length);
      if (name.startsWith('__MACOSX/') || name.endsWith('.DS_Store')) continue;
      const rel = safeRel(name);
      if (!rel) continue;
      const full = path.join(tmp, rel);
      if (!full.startsWith(tmp + path.sep)) continue;
      const data = e.getData();
      written += data.length;
      if (written > MAX_BYTES) throw Object.assign(new Error('Zip unpacks to more than 300 MB.'), { status: 400 });
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, data);
    }
  } catch (err) {
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err.status ? err : Object.assign(new Error('Could not unpack that zip.'), { status: 400 });
  }
  await replaceDir(teamDir(teamId, 'zip'), tmp);
  return { files: entries.length };
}

async function listTree(teamId, kind) {
  const root = teamDir(teamId, kind);
  if (!fs.existsSync(root)) return null;
  const out = [];
  const walk = async (dir, rel) => {
    const items = (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) =>
      (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of items) {
      if (out.length >= 5000) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) { out.push({ path: r, dir: true, skipped: true }); continue; }
        out.push({ path: r, dir: true });
        await walk(path.join(dir, e.name), r);
      } else if (e.isFile()) {
        out.push({ path: r, size: (await fsp.stat(path.join(dir, e.name))).size });
      }
    }
  };
  await walk(root, '');
  return out;
}

async function readSourceFile(teamId, kind, relPath) {
  const root = teamDir(teamId, kind);
  const rel = safeRel(relPath);
  if (!rel) throw Object.assign(new Error('Bad path.'), { status: 400 });
  const full = path.resolve(root, rel);
  if (!full.startsWith(path.resolve(root) + path.sep)) throw Object.assign(new Error('Bad path.'), { status: 400 });
  let st;
  try { st = await fsp.lstat(full); } catch { throw Object.assign(new Error('File not found.'), { status: 404 }); }
  if (!st.isFile()) throw Object.assign(new Error('Not a file.'), { status: 400 });
  if (st.size > 1024 * 1024) return { path: rel, size: st.size, tooLarge: true };
  const buf = await fsp.readFile(full);
  const binary = buf.subarray(0, 8000).includes(0);
  return { path: rel, size: st.size, binary, text: binary ? '' : buf.toString('utf8') };
}

async function readme(teamId, kind) {
  const root = teamDir(teamId, kind);
  if (!fs.existsSync(root)) return '';
  const f = (await fsp.readdir(root)).find((n) => /^readme(\.md|\.markdown|\.txt)?$/i.test(n));
  if (!f) return '';
  const st = await fsp.stat(path.join(root, f));
  if (st.size > 512 * 1024) return '';
  const md = await fsp.readFile(path.join(root, f), 'utf8');
  return renderMarkdown(f.toLowerCase().endsWith('.txt') ? '```\n' + md + '\n```' : md);
}

function renderMarkdown(md) {
  const html = marked.parse(md, { gfm: true, breaks: false });
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'del', 'input', 'details', 'summary']),
    allowedAttributes: { a: ['href', 'title', 'rel', 'target'], img: ['src', 'alt', 'title', 'width', 'height', 'referrerpolicy', 'loading'], code: ['class'], input: ['type', 'checked', 'disabled'], th: ['align'], td: ['align'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['https'] },
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow', target: '_blank' }),
      img: sanitizeHtml.simpleTransform('img', { referrerpolicy: 'no-referrer', loading: 'lazy' }),
      // Only GitHub-style task-list checkboxes; never a text or password field.
      input: (tag, attribs) => ({ tagName: 'input', attribs: { type: 'checkbox', disabled: '', ...(attribs.checked !== undefined ? { checked: '' } : {}) } }),
    },
  });
}

function hasSource(teamId, kind) { return fs.existsSync(teamDir(teamId, kind)); }

// Remove everything a deleted team left behind so nothing can surface again.
function purgeTeam(teamId) {
  const { run } = require('./db');
  const id = Number(teamId);
  run('DELETE FROM messages WHERE channel = ?', `team:${id}`);
  run('DELETE FROM submission_log WHERE team_id = ?', id);
  run('DELETE FROM runs WHERE team_id = ?', id);
  fsp.rm(path.join(SRC_DIR, `team-${id}`), { recursive: true, force: true }).catch(() => {});
  fsp.rm(path.join(DATA_DIR, 'uploads', `team-${id}`), { recursive: true, force: true }).catch(() => {});
}

module.exports = { parseGithubUrl, snapshotRepo, extractZip, listTree, readSourceFile, readme, renderMarkdown, teamDir, hasSource, purgeTeam, SRC_DIR };
