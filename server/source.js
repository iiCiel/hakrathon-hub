'use strict';
// Team source code for judges: GitHub repo snapshots (git clone at a known commit) and zip uploads.
const { execFile, spawn } = require('node:child_process');
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

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
// Accept the forms students actually paste: with or without https:// or www., http, the SSH
// address (git@github.com:o/r.git), and links to a folder, file, branch or the PR list inside it.
function parseGithubUrl(url) {
  let u = String(url || '').trim();
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/](.+)$/i.exec(u);
  if (ssh) u = `https://github.com/${ssh[1]}`;
  u = u.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com(?=\/|$)/i, 'https://github.com');
  const m = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)/.exec(u);
  if (!m) return null;
  const owner = m[1], repo = m[2].replace(/\.git$/i, '');
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === '.' || repo === '..') return null;
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}
function githubUrlProblem(url) {
  const u = String(url || '').trim();
  if (/gist\.github\.com/i.test(u)) return 'That is a Gist. Put the code in a repository and paste its link.';
  if (/gitlab|bitbucket|dev\.azure|sourceforge/i.test(u)) return 'Only GitHub repositories can be linked. Upload a zip of the code instead.';
  if (/github\.com\/[^/?#]+\/?(?:[?#].*)?$/i.test(u)) return 'That is a GitHub profile, not a repository. Open the repository and copy its link (https://github.com/owner/repo).';
  return 'Use a GitHub repository URL like https://github.com/owner/repo';
}

const teamDir = (teamId, kind) => path.join(SRC_DIR, `team-${Number(teamId)}`, kind);

function git(args, opts = {}) {
  return new Promise((resolve) => {
    execFile(GIT, args, {
      timeout: opts.timeout || 90000, windowsHide: true, maxBuffer: opts.maxBuffer || 4 * 1024 * 1024, cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}), GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' },
    }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim(), err }));
  });
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
  const old = `${finalDir}.old-${crypto.randomBytes(4).toString('hex')}`;
  try {
    if (fs.existsSync(finalDir)) await renameRetry(finalDir, old);
    await renameRetry(tmpDir, finalDir);
  } catch (e) {
    fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    if (!fs.existsSync(finalDir) && fs.existsSync(old)) await fsp.rename(old, finalDir).catch(() => {});
    throw e;
  }
  fsp.rm(old, { recursive: true, force: true }).catch(() => {});
}

// One change at a time per key (e.g. a team's zip): teammates uploading at the same moment are
// handled in turn (the last one wins) instead of racing on the same folders.
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return next;
}
const MAX_ENTRY = 100 * 1024 * 1024;
const NOTEBOOK_MAX = 1024 * 1024;
const entryData = (e) => new Promise((resolve, reject) => e.getDataAsync((data, err) => (err ? reject(err) : resolve(data))));
const EXEC_NAME = /(\.(sh|bash|py|pl|rb)$)|(^|\/)(gradlew|mvnw|configure|run|start)$/;

// Options that make cloning a stranger's repository safe: no hooks, no credential prompts, no
// local/ext transports, symlinks as plain files. longpaths/autocrlf keep files exactly as committed.
const SAFE_GIT = ['-c', 'core.symlinks=false', '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=',
  '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'core.longpaths=true', '-c', 'core.autocrlf=false'];
// Token goes in through GIT_CONFIG_* env vars: never in argv, the URL, or .git/config.
function authEnv(useToken) {
  const token = useToken ? process.env.GITHUB_TOKEN : '';
  return token ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` } : {};
}
const scrub = (s) => (process.env.GITHUB_TOKEN ? String(s).split(process.env.GITHUB_TOKEN).join('***') : String(s));

// The commit GitHub has on the default branch right now (one quick request). Recorded at each team's
// freeze so the official snapshot can't be steered by commits pushed later with back-dated times.
async function remoteHead(url, { useToken = false } = {}) {
  const gh = parseGithubUrl(url);
  if (!gh) return '';
  const r = await git([...SAFE_GIT, 'ls-remote', '--', `${gh.url}.git`, 'HEAD'], { env: authEnv(useToken), timeout: 20000 });
  const sha = r.ok ? r.stdout.split(/\s/)[0] : '';
  return /^[0-9a-f]{40}$/.test(sha) ? sha : '';
}

// Clone a public (or token-accessible) GitHub repo and copy out the files of one commit:
// - normally the default branch head;
// - for a freeze snapshot (`before` = the team's freeze time, ms), the last commit made before then,
//   looked for in the history of `pin` (what GitHub had at the freeze) when we recorded it.
// Files come out through `git archive`, never a checkout, so names Windows can't store (CON.txt,
// a:b.txt, README.md next to readme.md) are skipped and reported instead of failing the clone,
// and nothing in the repository can write into the .git folder.
async function snapshotRepo(teamId, url, { useToken = false, before = 0, pin = '' } = {}) {
  const gh = parseGithubUrl(url);
  if (!gh) throw Object.assign(new Error(githubUrlProblem(url)), { status: 400 });
  const root = path.join(SRC_DIR, `team-${Number(teamId)}`);
  await fsp.mkdir(root, { recursive: true });
  const id = crypto.randomBytes(4).toString('hex');
  const gitDir = path.join(root, `repo-git-${id}`), tmp = path.join(root, `repo-tmp-${id}`);
  const env = authEnv(useToken);
  const cleanup = () => { for (const d of [gitDir, tmp]) fsp.rm(d, { recursive: true, force: true }).catch(() => {}); };
  const fail = (msg, log) => { cleanup(); if (log) console.error(`[git] team ${teamId}: ${scrub(log).slice(-500)}`); return Object.assign(new Error(msg), { status: 400 }); };
  const limit = before ? 150000 : 90000;
  // A freeze snapshot needs some history to find the pre-freeze commit (blobless: file contents come later).
  const how = before ? ['--filter=blob:none', '--depth', '200'] : ['--depth', '1'];
  const r = await git([...SAFE_GIT, 'clone', ...how, '--no-checkout', '--single-branch', '--no-tags', '--', `${gh.url}.git`, gitDir], { env, timeout: limit });
  if (!r.ok) {
    const missing = /not found|could not read Username|Authentication failed|terminal prompts disabled/i.test(r.stderr);
    throw fail(missing ? 'Repository not found or not public. Make it public (or ask staff to add access) and try again.'
      : (r.err && r.err.killed ? `Cloning took too long (${limit / 1000} s limit). Large files or history? Try again, or upload a zip.` : 'Clone failed. Check the URL and that the repository is public, then try again or ask staff.'),
    missing ? '' : `clone failed: ${r.stderr}`);
  }
  const head = (await git(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { cwd: gitDir })).stdout;
  if (!/^[0-9a-f]{40}$/.test(head)) throw fail('This repository has no commits yet. Push your code to GitHub, then link it again.');
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: gitDir })).stdout || 'HEAD';
  let pick = head, afterFreeze = false, pinned = false;
  if (before) {
    let tip = head;
    if (/^[0-9a-f]{40}$/.test(pin)) {
      let has = (await git(['cat-file', '-e', `${pin}^{commit}`], { cwd: gitDir })).ok;
      if (!has) { // force-pushed away since the freeze: GitHub still serves it by id for a while
        await git([...SAFE_GIT, 'fetch', '-q', '--depth', '200', '--filter=blob:none', 'origin', pin], { cwd: gitDir, env, timeout: 90000 });
        has = (await git(['cat-file', '-e', `${pin}^{commit}`], { cwd: gitDir })).ok;
      }
      if (has) { tip = pin; pinned = true; }
    }
    pick = (await git(['rev-list', '-1', `--before=${Math.floor(before / 1000)}`, tip], { cwd: gitDir })).stdout;
    if (!pick) { pick = tip; afterFreeze = true; } // every commit is dated after the freeze
  }
  const date = (await git(['log', '-1', '--format=%cI', pick], { cwd: gitDir })).stdout;
  // Submodules are separate repositories: git archive leaves them out, so say so.
  const notes = [];
  const ls = await git(['ls-tree', '-r', '-z', pick], { cwd: gitDir, maxBuffer: 128 * 1024 * 1024, timeout: 60000 });
  const entries = ls.stdout.split('\0').filter(Boolean).map((rec) => {
    const tab = rec.indexOf('\t'); const [mode, type, sha] = rec.slice(0, tab).split(' ');
    return { mode, type, sha, path: rec.slice(tab + 1) };
  });
  for (const e of entries) if (e.type === 'commit') notes.push({ path: e.path, why: 'submodule (a separate repository; not included)' });
  await fsp.mkdir(tmp);
  let w = makeWriter(tmp, { maxBytes: MAX_BYTES });
  try {
    await untarGit(gitDir, pick, env, w, limit);
  } catch (e) {
    if (e.status) { cleanup(); throw e; }
    if (!/invalid path|too long/i.test(e.message)) throw fail('Could not copy the files out of the repository. Try again or ask staff.', `archive failed: ${e.message}`);
    // Git for Windows refuses to archive a tree holding a name Windows can't store (a:b.txt, CON).
    // Read the file contents by id instead: no paths go through git, and the writer skips the bad ones.
    try {
      await fsp.rm(tmp, { recursive: true, force: true }); await fsp.mkdir(tmp);
      w = makeWriter(tmp, { maxBytes: MAX_BYTES });
      let from = gitDir;
      if (before) { // the freeze clone has no file contents yet: fetch just this commit, in full
        from = `${gitDir}-full`;
        await git(['init', '-q', from]);
        const f = await git([...SAFE_GIT, 'fetch', '-q', '--depth', '1', '--no-tags', '--', `${gh.url}.git`, pick], { cwd: from, env, timeout: limit });
        if (!f.ok) throw new Error(`fetch of ${pick} failed: ${f.stderr}`);
      }
      await copyByIds(from, entries, w, limit).finally(() => { if (from !== gitDir) fsp.rm(from, { recursive: true, force: true }).catch(() => {}); });
    } catch (e2) {
      if (e2.status) { cleanup(); throw e2; }
      throw fail('Could not copy the files out of the repository. Try again or ask staff.', `copy failed: ${e2.message}`);
    }
  }
  fsp.rm(gitDir, { recursive: true, force: true }).catch(() => {});
  try { await replaceDir(teamDir(teamId, 'repo'), tmp); } catch (e) { cleanup(); throw e; }
  return { sha: pick, commitDate: date, branch, url: gh.url, afterFreeze, pinned, skipped: [...notes, ...w.skipped], files: w.count };
}

// Stream `git archive` (tar) straight into the writer: big repos never sit in memory, and the
// 300 MB cap stops the copy as soon as it's passed.
function untarGit(gitDir, sha, env, w, limit) {
  if (process.env.HAK_TEST_NO_ARCHIVE) return Promise.reject(new Error('invalid path (test: archive disabled)'));
  return new Promise((resolve, reject) => {
    // protectNTFS off for archive only: git writes nothing to disk here (the tar goes to us, and the
    // writer below checks every name), and Git for Windows would otherwise refuse the whole repo.
    const child = spawn(GIT, [...SAFE_GIT, '-c', 'core.protectNTFS=false', 'archive', '--format=tar', sha], { cwd: gitDir, windowsHide: true,
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' } });
    let stderr = '', settled = false;
    const timer = setTimeout(() => { child.kill(); finish(Object.assign(new Error(`Copying the files took too long (${limit / 1000} s limit).`), { status: 400 })); }, limit);
    const finish = (err) => { if (settled) return; settled = true; clearTimeout(timer); if (err) { child.kill(); reject(err); } else resolve(); };
    child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d; });
    child.on('error', finish);
    const parsed = readTar(child.stdout, (e) => w.add(e.name, e.mode, e.data, e.type, e.size)).catch(finish);
    child.on('close', async (code) => {
      await parsed;
      if (settled) return;
      finish(code === 0 ? null : new Error(`git archive exited ${code}: ${stderr}`));
    });
  });
}

// Pull-style reader over a byte stream: read exactly n bytes, skip n bytes, or read a line.
function byteReader(stream) {
  const it = stream[Symbol.asyncIterator]();
  let chunks = [], len = 0, done = false;
  const fill = async (n) => { while (len < n && !done) { const r = await it.next(); if (r.done) done = true; else if (r.value.length) { chunks.push(r.value); len += r.value.length; } } return len >= n; };
  const take = (n) => {
    const out = []; let need = n;
    while (need > 0) { const c = chunks[0]; if (c.length <= need) { out.push(c); chunks.shift(); need -= c.length; } else { out.push(c.subarray(0, need)); chunks[0] = c.subarray(need); need = 0; } }
    len -= n; return out.length === 1 ? out[0] : Buffer.concat(out, n);
  };
  const read = async (n) => { if (!(await fill(n))) throw new Error('truncated stream'); return take(n); };
  const skip = async (n) => { while (n > 0) { if (!(await fill(1))) throw new Error('truncated stream'); const k = Math.min(n, len); take(k); n -= k; } };
  const line = async () => {
    const acc = [];
    for (;;) {
      if (!(await fill(1))) throw new Error('truncated stream');
      const c = chunks[0], i = c.indexOf(10);
      if (i >= 0) { acc.push(take(i)); take(1); return Buffer.concat(acc).toString('utf8'); }
      acc.push(take(c.length));
    }
  };
  return { fill, take, read, skip, line };
}

// Copy files by object id with `git cat-file --batch` (used when `git archive` refuses a path).
function copyByIds(cwd, entries, w, limit) {
  const files = entries.filter((e) => e.type === 'blob');
  return new Promise((resolve, reject) => {
    const child = spawn(GIT, ['cat-file', '--batch'], { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' } });
    let settled = false;
    const finish = (err) => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); if (err) reject(err); else resolve(); };
    const timer = setTimeout(() => finish(Object.assign(new Error(`Copying the files took too long (${limit / 1000} s limit).`), { status: 400 })), limit);
    child.on('error', finish);
    child.stdin.on('error', () => {});
    child.stdin.end(files.map((f) => f.sha).join('\n') + '\n');
    const r = byteReader(child.stdout);
    (async () => {
      for (const f of files) {
        const head = (await r.line()).split(' ');
        if (head[1] !== 'blob') throw new Error(`object ${f.sha} is ${head[1] || 'missing'}`);
        const size = Number(head[2]);
        if (f.mode === '120000') { await r.skip(size + 1); await w.add(f.path, 0, null, 'link'); continue; }
        if (size > MAX_ENTRY) { await r.skip(size + 1); await w.add(f.path, 0, null); continue; }
        const data = await r.read(size); await r.skip(1);
        await w.add(f.path, parseInt(f.mode, 8), data);
      }
    })().then(() => finish(), finish);
  });
}

// Minimal streaming tar reader (ustar + pax long names), enough for what `git archive` writes.
async function readTar(stream, onEntry) {
  const { fill, take, read, skip } = byteReader(stream);
  let pax = {};
  for (;;) {
    if (!(await fill(512))) return;
    const hd = take(512);
    if (hd.every((b) => b === 0)) return;
    const field = (a, b) => hd.subarray(a, b).toString('utf8').replace(/\0[\s\S]*$/, '');
    const type = hd[156] ? String.fromCharCode(hd[156]) : '0';
    let size = parseInt(field(124, 136).trim() || '0', 8) || 0;
    const mode = parseInt(field(100, 108).trim() || '0', 8) || 0;
    if (type === 'x' || type === 'g') {
      const body = (await read(Math.ceil(size / 512) * 512)).subarray(0, size).toString('utf8');
      if (type === 'x') { pax = {}; for (const m of body.matchAll(/\d+ ([^=]+)=([^\n]*)\n/g)) pax[m[1]] = m[2]; }
      continue;
    }
    const prefix = hd.subarray(257, 262).toString('latin1') === 'ustar' ? field(345, 500) : '';
    let name = pax.path || (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    if (pax.size) size = Number(pax.size) || size;
    pax = {};
    const padded = Math.ceil(size / 512) * 512;
    if ((type === '0' || type === '7') && size <= MAX_ENTRY) {
      const data = (await read(padded)).subarray(0, size);
      await onEntry({ name, mode, type: 'file', data, size });
    } else {
      await skip(padded);
      if (type === '0' || type === '7') await onEntry({ name, mode, type: 'file', data: null, size });
      else if (type === '2' || type === '1') await onEntry({ name, mode, type: 'link', data: null, size });
    }
  }
}

// Writes extracted files into a folder with the same rules for zips and repos: safe relative
// paths only, nothing Windows can't store, case-insensitive duplicates skipped, a total size cap,
// and scripts kept executable. Every file left out is recorded with a plain-English reason.
function makeWriter(dir, { maxBytes = MAX_BYTES } = {}) {
  const seen = new Set();
  const w = { skipped: [], count: 0, bytes: 0,
    async add(name, mode, data, type = 'file', size = 0) {
      name = String(name).replace(/\\/g, '/');
      if (type === 'link') { w.skipped.push({ path: name, why: 'link (shortcut)' }); return; }
      if (name.endsWith('/')) return;
      const rel = safeRel(name, 400);
      if (!rel) { w.skipped.push({ path: name, why: badNameReason(name) }); return; }
      if (rel.split('/').some((seg) => /^\.git$/i.test(seg) || /^git~\d+$/i.test(seg))) { w.skipped.push({ path: name, why: 'inside a .git folder' }); return; }
      const full = path.join(dir, rel);
      if (!full.startsWith(dir + path.sep)) { w.skipped.push({ path: name, why: 'outside the project folder' }); return; }
      const key = rel.toLowerCase();
      if (seen.has(key)) { w.skipped.push({ path: name, why: 'same name as another file except for upper/lower case' }); return; }
      if (!data) { w.skipped.push({ path: name, why: `single file larger than ${MAX_ENTRY / 1048576} MB` }); return; }
      seen.add(key);
      w.bytes += data.length;
      if (w.bytes > maxBytes) throw Object.assign(new Error(`Files add up to more than ${maxBytes / 1048576} MB. Remove large files (datasets, videos, build output) and try again.`), { status: 400 });
      if (data.length < 300 && data.subarray(0, 40).toString('latin1').startsWith('version https://git-lfs.github.com/spec/')) w.skipped.push({ path: name, why: 'stored with Git LFS: only a placeholder is in the repository' });
      await fsp.mkdir(path.dirname(full), { recursive: true });
      // Keep scripts runnable (./run.sh, ./gradlew): zips and git record the executable bit.
      await fsp.writeFile(full, data, { mode: (mode & 0o111) || EXEC_NAME.test(rel) ? 0o755 : 0o644 });
      w.count++;
    } };
  return w;
}

// Extract an uploaded zip safely: no path traversal, no symlinks, size/entry caps.
function extractZip(teamId, zipPath) { return withLock(`zip:${Number(teamId)}`, () => extractZipNow(teamId, zipPath)); }
async function extractZipNow(teamId, zipPath) {
  let zip;
  try { zip = new AdmZip(zipPath); } catch { throw Object.assign(new Error('That file is not a valid zip.'), { status: 400 }); }
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  if (entries.length > 20000) throw Object.assign(new Error('Zip has too many files (20,000 max).'), { status: 400 });
  if (entries.some((e) => e.header.encrypted)) throw Object.assign(new Error('That zip is password-protected. Zip the folder again without a password.'), { status: 400 });
  let total = 0;
  for (const e of entries) total += e.header.size;
  if (total > MAX_BYTES) throw Object.assign(new Error('Zip unpacks to more than 300 MB.'), { status: 400 });
  // Strip a single shared top-level folder (e.g. GitHub "repo-main/").
  const names = entries.map((e) => e.entryName.replace(/\\/g, '/'));
  const junk = (n) => n.startsWith('__MACOSX/') || /(^|\/)\.DS_Store$/.test(n) || /(^|\/)Thumbs\.db$/i.test(n);
  const real = names.filter((n) => !/^([\\/]|[a-zA-Z]:)/.test(n) && !junk(n));
  if (!real.length) throw Object.assign(new Error('That zip has no files in it.'), { status: 400 });
  const firsts = new Set(real.map((n) => n.split('/')[0]));
  const strip = firsts.size === 1 && real.every((n) => n.includes('/')) ? [...firsts][0] + '/' : '';
  const root = path.join(SRC_DIR, `team-${Number(teamId)}`);
  await fsp.mkdir(root, { recursive: true });
  // Leftovers from a crash mid-upload: nothing else is unpacking for this team right now.
  for (const n of await fsp.readdir(root)) if (/^(zip-tmp-|zip\.old-)/.test(n)) await fsp.rm(path.join(root, n), { recursive: true, force: true }).catch(() => {});
  const tmp = path.join(root, `zip-tmp-${crypto.randomBytes(4).toString('hex')}`);
  await fsp.mkdir(tmp);
  const w = makeWriter(tmp, { maxBytes: MAX_BYTES });
  try {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      let name = names[i];
      if (/^([\\/]|[a-zA-Z]:)/.test(name)) { w.skipped.push({ path: name, why: 'absolute path' }); continue; } // never valid in a zip
      if (junk(name)) continue; // Mac/Windows clutter (checked before the top folder is stripped)
      if (strip && name.startsWith(strip)) name = name.slice(strip.length);
      if (((e.attr >>> 16) & 0o170000) === 0o120000) { await w.add(name, 0, null, 'link'); continue; }
      // async inflate: a big file doesn't freeze everyone else's page
      await w.add(name, (e.attr >>> 16) & 0o777, e.header.size > MAX_ENTRY ? null : await entryData(e));
    }
  } catch (err) {
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err.status ? err : Object.assign(new Error('Could not unpack that zip.'), { status: 400 });
  }
  await replaceDir(teamDir(teamId, 'zip'), tmp);
  return { files: w.count, skipped: w.skipped };
}
function removeZip(teamId) { return withLock(`zip:${Number(teamId)}`, () => fsp.rm(teamDir(teamId, 'zip'), { recursive: true, force: true })); }
function badNameReason(name) {
  const parts = String(name).replace(/\\/g, '/').split('/');
  if (name.length > 400) return 'path too long';
  if (parts.some((s) => s === '..')) return 'points outside the project folder';
  if (parts.some((s) => /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(s))) return 'name reserved by Windows';
  if (parts.some((s) => /[:*?"<>|\x00-\x1f]/.test(s))) return 'character not allowed in file names';
  if (parts.some((s) => /[. ]$/.test(s))) return 'name ends with a dot or space';
  return 'file name not allowed';
}

async function listTree(teamId, kind) {
  const root = teamDir(teamId, kind);
  if (!fs.existsSync(root)) return null;
  const out = [];
  const walk = async (dir, rel) => {
    const items = (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) =>
      (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of items) {
      if (out.length >= 5000) { out.truncated = true; return; }
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
  const rel = safeRel(relPath, 400);
  if (!rel) throw Object.assign(new Error('Bad path.'), { status: 400 });
  const full = path.resolve(root, rel);
  if (!full.startsWith(path.resolve(root) + path.sep)) throw Object.assign(new Error('Bad path.'), { status: 400 });
  let st;
  try { st = await fsp.lstat(full); } catch { throw Object.assign(new Error('File not found.'), { status: 404 }); }
  if (!st.isFile()) throw Object.assign(new Error('Not a file.'), { status: 400 });
  if (st.size > 1024 * 1024) return { path: rel, size: st.size, tooLarge: true };
  const buf = await fsp.readFile(full);
  const text = decodeText(buf);
  if (text === null) return { path: rel, size: st.size, binary: true, text: '' };
  if (/\.ipynb$/i.test(rel)) {
    const nb = notebookText(text);
    if (nb !== null) return { path: rel, size: st.size, binary: false, text: nb, as: 'notebook.py', notebook: true };
  }
  return { path: rel, size: st.size, binary: false, text };
}
// Text in whatever encoding students' tools produce: UTF-8, UTF-16 with a byte-order mark
// (PowerShell's `>`), or old Windows/Latin-1 files. null = really binary.
function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const head = buf.subarray(0, 8000);
  if (head.includes(0) || head.subarray(0, 5).toString('latin1') === '%PDF-') return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
}
// Jupyter notebooks: show the cells as readable code and text instead of raw JSON (outputs left out).
function notebookText(raw) {
  let nb;
  try { nb = JSON.parse(raw); } catch { return null; }
  if (!nb || !Array.isArray(nb.cells)) return null;
  const src = (c) => (Array.isArray(c.source) ? c.source.join('') : String(c.source || ''));
  let n = 0;
  const out = nb.cells.map((c) => c.cell_type === 'code'
    ? `# ── In [${++n}] ──\n${src(c)}`
    : `# ── ${c.cell_type === 'markdown' ? 'Text' : c.cell_type} ──\n${src(c).split('\n').map((l) => `# ${l}`).join('\n')}`).join('\n\n');
  return out.slice(0, NOTEBOOK_MAX);
}
// Full path of one file in a snapshot, for downloads (binary files, spreadsheets, Power BI files).
async function sourceFilePath(teamId, kind, relPath) {
  const root = teamDir(teamId, kind);
  const rel = safeRel(relPath, 400);
  if (!rel) throw Object.assign(new Error('Bad path.'), { status: 400 });
  const full = path.resolve(root, rel);
  if (!full.startsWith(path.resolve(root) + path.sep)) throw Object.assign(new Error('Bad path.'), { status: 400 });
  let st;
  try { st = await fsp.lstat(full); } catch { throw Object.assign(new Error('File not found.'), { status: 404 }); }
  if (!st.isFile()) throw Object.assign(new Error('Not a file.'), { status: 400 });
  return full;
}

async function readme(teamId, kind) {
  const root = teamDir(teamId, kind);
  if (!fs.existsSync(root)) return '';
  const names = await fsp.readdir(root);
  const f = ['md', 'markdown', 'rst', 'txt', ''].map((ext) => names.find((n) => n.toLowerCase() === (ext ? `readme.${ext}` : 'readme'))).find(Boolean);
  if (!f) return '';
  const st = await fsp.stat(path.join(root, f));
  if (st.size > 512 * 1024) return '';
  const md = decodeText(await fsp.readFile(path.join(root, f))) || '';
  const plain = !/\.(md|markdown)$/i.test(f);
  // Pictures the README shows from the repo itself ("docs/screenshot.png") load from the snapshot.
  return renderMarkdown(plain ? '```\n' + md.replace(/```/g, '`‍``') + '\n```' : md, { base: `/api/source/${Number(teamId)}/${kind === 'zip' ? 'zip' : 'repo'}` });
}

const IMG_EXT = /\.(png|jpe?g|gif|webp)$/i;
function localRef(src) {
  const v = String(src || '').trim();
  if (!v || /^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith('//') || v.startsWith('#')) return null;
  let p;
  try { p = decodeURIComponent(v.split(/[?#]/)[0]); } catch { return null; }
  return safeRel(path.posix.normalize(p.replace(/^\.\//, '').replace(/^\/+/, '')), 400);
}
function renderMarkdown(md, { base = '' } = {}) {
  const html = marked.parse(md, { gfm: true, breaks: false });
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'del', 'input', 'details', 'summary']),
    allowedAttributes: { a: ['href', 'title', 'rel', 'target'], img: ['src', 'alt', 'title', 'width', 'height', 'referrerpolicy', 'loading'], code: ['class'], span: ['title'], input: ['type', 'checked', 'disabled'], th: ['align'], td: ['align'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['https'] }, allowProtocolRelative: false,
    transformTags: {
      a: (tag, attribs) => {
        const href = String(attribs.href || '');
        if (href.startsWith('#')) return { tagName: 'a', attribs: { href } }; // in-page anchor: same tab
        if (base && localRef(href) !== null) return { tagName: 'span', attribs: { title: `File in the project: ${localRef(href)}` } }; // repo-relative link: plain text
        return { tagName: 'a', attribs: { ...attribs, rel: 'noopener noreferrer nofollow', target: '_blank' } };
      },
      img: (tag, attribs) => {
        const rel = base ? localRef(attribs.src) : null;
        const src = rel && IMG_EXT.test(rel) ? `${base}/raw?inline=1&path=${encodeURIComponent(rel)}` : attribs.src;
        return { tagName: 'img', attribs: { ...attribs, src, referrerpolicy: 'no-referrer', loading: 'lazy' } };
      },
      // Only GitHub-style task-list checkboxes; never a text or password field (others are dropped).
      input: (tag, attribs) => (attribs.type === 'checkbox'
        ? { tagName: 'input', attribs: { type: 'checkbox', disabled: '', ...(attribs.checked !== undefined ? { checked: '' } : {}) } }
        : { tagName: 'dropped-input', attribs: {} }), // not an allowed tag, so it's removed
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

module.exports = { parseGithubUrl, githubUrlProblem, remoteHead, readTar, snapshotRepo, extractZip, removeZip, withLock, sourceFilePath, decodeText, notebookText, listTree, readSourceFile, readme, renderMarkdown, teamDir, hasSource, purgeTeam, SRC_DIR };
