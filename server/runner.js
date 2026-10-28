'use strict';
// Runs student code. Default: a throwaway Docker container with no network, capped CPU/memory/PIDs,
// read-only root, all capabilities dropped, running as nobody. "local" mode runs on the host with
// no sandbox and is restricted to admins in routes (for testing without Docker only).
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR } = require('./db');

let MODE = (process.env.RUNNER || 'docker').toLowerCase(); // docker | local | off
// LOCAL runs code on this PC with no sandbox. Only allow it when the portal isn't reachable from the network.
if (MODE === 'local' && !['127.0.0.1', 'localhost', '::1'].includes(process.env.HOST || '')) {
  console.warn('\n  RUNNER=local refused: it only works with HOST=127.0.0.1 (no sandbox). Code running is OFF.\n');
  MODE = 'off';
}
const IMAGE = process.env.RUNNER_IMAGE || 'hakrathon-runner:latest';
const DOCKER = process.env.DOCKER_BIN || 'docker';
const EXTRA = (process.env.RUNNER_EXTRA_ARGS || '').split(/\s+/).filter(Boolean); // test hook
const MAX_CONCURRENT = Math.max(1, Number(process.env.RUNNER_CONCURRENCY) || 3);
const MAX_QUEUE = 40;
const OUTPUT_CAP = 64 * 1024;
const RUN_DIR = path.join(DATA_DIR, 'runs');
fs.mkdirSync(RUN_DIR, { recursive: true });

const LANGS = {
  python: { name: 'Python 3', entry: 'main.py', exts: ['.py'], cmd: 'python3 -u "$1"', local: ['python', ['-u']] },
  javascript: { name: 'JavaScript (Node)', entry: 'main.js', exts: ['.js', '.mjs'], cmd: 'node "$1"', local: [process.execPath, []] },
  c: { name: 'C (gcc)', entry: 'main.c', exts: ['.c', '.h'], cmd: 'gcc -O2 -std=c17 -o /tmp/a.out $(find . -name "*.c") -lm && /tmp/a.out' },
  cpp: { name: 'C++ (g++)', entry: 'main.cpp', exts: ['.cpp', '.cc', '.hpp', '.h'], cmd: 'g++ -O2 -std=c++17 -o /tmp/a.out $(find . -name "*.cpp" -o -name "*.cc") && /tmp/a.out' },
  java: { name: 'Java', entry: 'Main.java', exts: ['.java'], cmd: 'mkdir -p /tmp/out && javac -J-Xmx192m -d /tmp/out $(find . -name "*.java") && java -Xmx192m -XX:+UseSerialGC -cp /tmp/out "$(basename "$1" .java)"', local: ['java', []] },
  bash: { name: 'Bash', entry: 'main.sh', exts: ['.sh'], cmd: 'bash "$1"' },
};

function langForPath(p) {
  const ext = path.extname(p).toLowerCase();
  for (const [id, l] of Object.entries(LANGS)) if (l.exts.includes(ext) && !(ext === '.h')) return id;
  return null;
}

let status = { mode: MODE, ready: false, reason: 'Checking…', image: IMAGE, checkedAt: 0 };
function sh(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim(), err }));
  });
}
async function checkRunner() {
  if (MODE === 'off') status = { ...status, ready: false, reason: 'Code running is turned off (RUNNER=off).' };
  else if (MODE === 'local') status = { ...status, ready: true, reason: 'LOCAL mode: code runs on this computer with no sandbox. Admin-only.' };
  else {
    const v = await sh(DOCKER, ['version', '--format', '{{.Server.Version}}']);
    if (!v.ok || !v.stdout) {
      status = { ...status, ready: false, reason: 'Docker is not running. Install/start Docker Desktop, then run setup-runner.' };
    } else {
      const img = await sh(DOCKER, ['image', 'inspect', '--format', '{{.Id}}', IMAGE]);
      status = img.ok
        ? { ...status, ready: true, reason: `Docker ${v.stdout}, sandbox image ready.` }
        : { ...status, ready: false, reason: `Docker is running but the sandbox image "${IMAGE}" is missing. Run setup-runner.` };
    }
  }
  status.checkedAt = Date.now();
  return status;
}
function runnerStatus() { return status; }
checkRunner();
setInterval(() => { if (!status.ready) checkRunner(); }, 30000).unref();

// ---- queue ----
let active = 0;
const queue = [];
function enqueue(job, priority = false) {
  return new Promise((resolve, reject) => {
    if (queue.length >= MAX_QUEUE && !priority) return reject(Object.assign(new Error('The code runner is busy. Try again in a moment.'), { status: 503 }));
    // Judges/admins jump the queue so 50 students can't starve judging.
    if (priority) { const i = queue.findIndex((q) => !q.priority); queue.splice(i < 0 ? queue.length : i, 0, { job, resolve, reject, priority }); }
    else queue.push({ job, resolve, reject });
    pump();
  });
}
function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const { job, resolve, reject } = queue.shift();
    active++;
    job().then(resolve, reject).finally(() => { active--; pump(); });
  }
}
const queueDepth = () => ({ active, waiting: queue.length, max: MAX_CONCURRENT });

function safeRel(p) {
  const norm = String(p).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!norm || norm.length > 200) return null;
  const parts = norm.split('/');
  // Also reject Windows device names (CON, NUL, COM1.txt...) and segments ending in a dot or space,
  // which Windows silently rewrites (so "a. " could alias another path).
  if (parts.some((s) => !s || s === '.' || s === '..' || /[\x00-\x1f:*?"<>|]/.test(s) || /[. ]$/.test(s)
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(s))) return null;
  return parts.join('/');
}

function writeTree(dir, files) {
  let total = 0;
  for (const [p, content] of Object.entries(files)) {
    const rel = safeRel(p);
    if (!rel) throw Object.assign(new Error(`Bad file path: ${p}`), { status: 400 });
    total += Buffer.byteLength(content);
    if (total > 2 * 1024 * 1024) throw Object.assign(new Error('Project is too large to run (2 MB limit).'), { status: 400 });
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function collect(child, timeoutMs, onTimeout) {
  return new Promise((resolve) => {
    const out = { stdout: '', stderr: '', truncated: false, timedOut: false, exitCode: null };
    const add = (k) => (d) => {
      if (out[k].length >= OUTPUT_CAP) { out.truncated = true; return; }
      out[k] += d.toString('utf8');
      if (out[k].length > OUTPUT_CAP) { out[k] = out[k].slice(0, OUTPUT_CAP); out.truncated = true; }
    };
    child.stdout.on('data', add('stdout'));
    child.stderr.on('data', add('stderr'));
    const t = setTimeout(() => { out.timedOut = true; onTimeout(); }, timeoutMs);
    child.on('error', (e) => { out.stderr += `\n[runner] ${e.message}`; });
    child.on('close', (code) => { clearTimeout(t); out.exitCode = code; resolve(out); });
  });
}

function dockerArgs(name, srcDir, script, entry, opts) {
  return [
    'run', '--rm', '-i', '--name', name,
    '--network', 'none',
    '--memory', opts.memory || '384m', '--memory-swap', opts.memory || '384m',
    '--cpus', '1', '--pids-limit', '128',
    '--read-only', '--tmpfs', `/tmp:rw,exec,nosuid,mode=1777,size=${opts.tmpSize || "96m"}`,
    '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL',
    '--user', '65534:65534', '--ulimit', 'fsize=33554432:33554432', '--ulimit', 'nofile=256:256',
    '-e', 'HOME=/tmp', '-e', 'PYTHONDONTWRITEBYTECODE=1',
    ...(srcDir.includes(',') ? ['-v', `${srcDir}:/src:ro`] : ['--mount', `type=bind,source=${srcDir},target=/src,readonly`]),
    '-w', '/tmp',
    ...EXTRA,
    IMAGE,
    'sh', '-c', `cp -r /src /tmp/w && cd /tmp/w && ${script}`, 'sh', entry || '',
  ];
}

// files: {path: content}; or srcDir: an existing directory to copy (repo snapshots).
async function execute({ lang, entry, files, srcDir, command, stdin = '', timeoutMs = 10000, memory, priority = false }) {
  if (!status.ready) await checkRunner();
  if (!status.ready) throw Object.assign(new Error(status.reason), { status: 503 });
  const L = lang ? LANGS[lang] : null;
  if (!command && !L) throw Object.assign(new Error('Unsupported language.'), { status: 400 });
  const script = command || L.cmd;
  const id = crypto.randomBytes(6).toString('hex');
  const tmp = path.join(RUN_DIR, id);

  return enqueue(async () => {
    const started = Date.now();
    let src = srcDir;
    try {
      if (!src) { fs.mkdirSync(tmp, { recursive: true }); writeTree(tmp, files || {}); src = tmp; }
      let child, out;
      if (MODE === 'local') {
        out = await runLocal({ L, lang, entry, src, stdin, timeoutMs, command });
      } else {
        const name = `hak-run-${id}`;
        child = spawn(DOCKER, dockerArgs(name, src, script, entry, { memory, tmpSize: srcDir ? '256m' : '96m' }), { windowsHide: true });
        child.stdin.on('error', () => {});
        child.stdin.end(String(stdin).slice(0, 256 * 1024));
        out = await collect(child, timeoutMs, () => {
          execFile(DOCKER, ['kill', name], { windowsHide: true }, () => {});
          setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
        });
        if (out.exitCode === 125 && /Unable to find image|No such image/i.test(out.stderr)) { status.ready = false; checkRunner(); }
        if (out.exitCode === 137 && !out.timedOut) out.stderr += '\n[runner] Process was killed (memory or process limit reached).';
      }
      if (out.timedOut) out.stderr += `\n[runner] Time limit reached (${Math.round(timeoutMs / 1000)}s). Process stopped.`;
      if (out.truncated) out.stderr += `\n[runner] Output truncated at ${OUTPUT_CAP / 1024} KB.`;
      return { ...out, durationMs: Date.now() - started };
    } finally {
      if (!srcDir) fs.rm(tmp, { recursive: true, force: true }, () => {});
    }
  }, priority);
}

// LOCAL mode never gets the server's environment (GitHub token, OAuth secret).
const LOCAL_ENV = Object.fromEntries(['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG']
  .filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
async function runLocal({ L, lang, entry, src, stdin, timeoutMs, command }) {
  let child;
  if (command) {
    // Team-supplied run commands only ever run in the Docker sandbox.
    return { stdout: '', stderr: '[runner] Running a team repository needs the Docker sandbox; LOCAL test mode only runs editor code.', exitCode: 1 };
  } else {
    if (!L.local) return { stdout: '', stderr: `[runner] ${L.name} needs Docker; LOCAL mode only runs Python, JavaScript and Java.`, exitCode: 1 };
    const [bin, pre] = L.local;
    // Java uses single-file source launch (java Main.java).
    child = spawn(bin, [...pre, entry], { cwd: src, windowsHide: true, env: LOCAL_ENV });
  }
  child.stdin.on('error', () => {});
  child.stdin.end(String(stdin));
  return collect(child, timeoutMs, () => { try { child.kill('SIGKILL'); } catch {} });
}

module.exports = { LANGS, langForPath, execute, runnerStatus, checkRunner, queueDepth, safeRel, get MODE() { return MODE; } };
