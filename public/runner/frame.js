'use strict';
// In-browser code runner, used by the code editor when the event's Docker sandbox is unavailable.
// This page is loaded in an iframe sandboxed WITHOUT allow-same-origin, so its origin is opaque:
// nothing that runs here can read the portal page or call the portal API as the signed-in person.
// Each program runs in a Web Worker that is killed after the time limit.
(function () {
  const BASE = new URL('/', location.href).href;
  const OUTPUT_CAP = 64 * 1024;
  const LOAD_LIMIT_MS = 60000; // first Python start downloads ~5 MB; slow Wi-Fi gets a minute

  // Every run gets its own worker, and it is terminated the moment the run ends (done, error, time
  // limit, output limit, or a new run). Nothing a program leaves behind (timers, a patched print(),
  // files) reaches the next run. A spare Python worker loads in the background so the next Python run
  // doesn't wait for Pyodide to start.
  let spare = null; // { worker, ready, dead } for the next Python run
  let current = null; // the run in progress
  let pySrc = null;

  const send = (msg) => parent.postMessage(msg, '*'); // the parent checks event.source; nothing secret is sent

  function blobWorker(src) {
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const w = new Worker(url);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return w;
  }

  function pySource() {
    if (!pySrc) {
      pySrc = fetch(BASE + 'runner/py-worker.js').then((res) => {
        if (!res.ok) throw new Error('Could not load the Python runner.');
        return res.text();
      }).then((t) => `const BASE = ${JSON.stringify(BASE)};\n${t}`);
      pySrc.catch(() => { pySrc = null; });
    }
    return pySrc;
  }
  function startPython() {
    const p = { worker: null, dead: false, ready: null };
    p.ready = (async () => {
      const src = await pySource();
      if (p.dead) throw new Error('Stopped.');
      const worker = blobWorker(src);
      p.worker = worker;
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Python took too long to start. Check the connection and try again.')), LOAD_LIMIT_MS);
        worker.addEventListener('message', function onReady(e) {
          if (e.data && e.data.type === 'ready') { clearTimeout(t); worker.removeEventListener('message', onReady); resolve(); }
          if (e.data && e.data.type === 'fatal') { clearTimeout(t); reject(new Error(e.data.message)); }
        });
        worker.addEventListener('error', (e) => { clearTimeout(t); reject(new Error(e.message || 'Python could not start.')); });
      });
    })();
    p.ready.catch(() => { endPython(p); if (spare === p) spare = null; });
    return p;
  }
  function endPython(p) { if (!p) return; p.dead = true; if (p.worker) p.worker.terminate(); }
  function warm() { if (!spare) spare = startPython(); }

  function finish(run, extra) {
    if (current !== run) return;
    current = null;
    clearTimeout(run.timer);
    if (run.worker) { run.worker.removeEventListener('message', run.onMessage); run.worker.terminate(); }
    if (run.worker && run.py) run.py.dead = true; // a used interpreter is never reused
    send({ type: 'done', id: run.id, durationMs: run.started ? Math.round(performance.now() - run.started) : 0, truncated: run.bytes > OUTPUT_CAP, ...extra });
    if (run.lang === 'python') setTimeout(warm, 100);
  }
  function kill(run, reason) {
    finish(run, { exitCode: null, timedOut: reason === 'timeout', error: reason === 'timeout' ? '' : reason });
  }
  function onOutput(run, stream, text) {
    if (current !== run || run.bytes > OUTPUT_CAP) return;
    run.bytes += text.length;
    if (run.bytes > OUTPUT_CAP) { text = text.slice(0, Math.max(0, text.length - (run.bytes - OUTPUT_CAP))); }
    if (text) send({ type: 'out', id: run.id, stream, text });
    if (run.bytes > OUTPUT_CAP) kill(run, 'Output limit reached (64 KB). The program was stopped.');
  }

  async function start(m) {
    if (current) kill(current, 'Stopped: a new run started.');
    const run = { id: m.id, lang: m.lang, bytes: 0, started: 0, timer: null, worker: null, py: null, onMessage: null };
    current = run;
    const limit = Math.min(Math.max(Number(m.timeoutMs) || 10000, 1000), 30000);
    try {
      if (m.lang === 'python') {
        if (!spare || !spare.worker) send({ type: 'status', id: m.id, text: 'Starting Python in your browser (the first run takes a few seconds)…' });
        const p = spare || startPython();
        spare = null;
        run.py = p;
        await p.ready;
        if (current !== run) { if (!spare && !p.dead) spare = p; else endPython(p); return; } // cancelled while loading: keep the unused interpreter
        run.worker = p.worker;
      } else if (m.lang === 'javascript') {
        const b = jsBundle(m.files, m.entry, m.stdin);
        run.lineMap = b.map;
        run.worker = blobWorker(b.src);
      } else throw new Error('This language needs the event code runner.');
    } catch (e) {
      if (current === run) finish(run, { exitCode: null, error: e.message || String(e) });
      return;
    }
    run.onMessage = (e) => {
      const d = e.data || {};
      if (d.type === 'out') onOutput(run, d.stream, String(d.text));
      else if (d.type === 'done') finish(run, { exitCode: typeof d.exitCode === 'number' ? d.exitCode : null });
    };
    run.worker.addEventListener('message', run.onMessage);
    if (m.lang === 'javascript') {
      run.worker.addEventListener('error', (e) => {
        e.preventDefault();
        const at = (run.lineMap || []).find((x) => e.lineno >= x.start && e.lineno <= x.end);
        onOutput(run, 'stderr', `${e.message || 'Error'}${at ? ` (${at.path}, line ${e.lineno - at.start + 1})` : ''}\n`);
        finish(run, { exitCode: 1 });
      });
    }
    run.started = performance.now();
    run.timer = setTimeout(() => kill(run, 'timeout'), limit);
    if (m.lang === 'python') run.worker.postMessage({ type: 'run', files: m.files, entry: m.entry, stdin: m.stdin || '' });
  }

  // ---------- JavaScript: CommonJS-style bundle of the team's .js/.json files ----------
  // Each file becomes a function, so require('./x') works without eval. Node built-ins that make
  // sense here are shimmed (console, process.argv/exit/stdout, fs.readFileSync for stdin and project
  // files, readline line-by-line input); the rest throw a clear message.
  const PRELUDE = String.raw`
const __files = __FILES__;
const __stdin = __STDIN__;
const __entry = __ENTRY__;
const __map = __MAP__;
function __where(line) { const m = __map.find((x) => line >= x.start && line <= x.end); return m ? m.path + ':' + (line - m.start + 1) : null; }
const __defs = Object.create(null), __cache = Object.create(null);
let __timers = 0, __finished = false, __rl = 0;
const __setTimeout = setTimeout, __clearTimeout = clearTimeout, __setInterval = setInterval, __clearInterval = clearInterval;
class __Exit { constructor(code) { this.code = code; } }
function __fmt(v, depth) {
  depth = depth || 0;
  if (typeof v === 'string') return depth ? JSON.stringify(v) : v;
  if (v instanceof Error) {
    if (!v.stack || !v.stack.includes(v.message)) return String(v);
    // Point stack lines at the student's file and line instead of the bundled blob.
    return v.stack.split('\n').map((l) => {
      const mm = /blob:[^)\s]*:(\d+):\d+/.exec(l);
      if (!mm) return l;
      const w = __where(Number(mm[1]));
      return w ? l.replace(/\(?blob:[^)\s]*:\d+:\d+\)?/, '(' + w + ')') : null;
    }).filter((l) => l !== null).join('\n');
  }
  if (typeof v === 'function') return '[Function: ' + (v.name || 'anonymous') + ']';
  if (typeof v === 'bigint') return v + 'n';
  if (typeof v === 'symbol') return v.toString();
  if (v === null || typeof v !== 'object') return String(v);
  if (depth > 3) return Array.isArray(v) ? '[Array]' : '[Object]';
  try {
    if (Array.isArray(v)) return '[ ' + v.map((x) => __fmt(x, depth + 1)).join(', ') + ' ]';
    if (v instanceof Map) return 'Map(' + v.size + ') { ' + [...v].map(([k, x]) => __fmt(k, depth + 1) + ' => ' + __fmt(x, depth + 1)).join(', ') + ' }';
    if (v instanceof Set) return 'Set(' + v.size + ') { ' + [...v].map((x) => __fmt(x, depth + 1)).join(', ') + ' }';
    const keys = Object.keys(v);
    if (!keys.length) return '{}';
    return '{ ' + keys.map((k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)) + ': ' + __fmt(v[k], depth + 1)).join(', ') + ' }';
  } catch (e) { return String(v); }
}
const __out = (stream, text) => postMessage({ type: 'out', stream, text });
const __line = (stream) => (...a) => __out(stream, a.map((x) => __fmt(x)).join(' ') + '\n');
const console = { log: __line('stdout'), info: __line('stdout'), debug: __line('stdout'), error: __line('stderr'), warn: __line('stderr'),
  table: (x) => __out('stdout', JSON.stringify(x, null, 2) + '\n'), dir: __line('stdout'), trace: __line('stderr'), assert: (c, ...a) => { if (!c) __line('stderr')('Assertion failed:', ...a); } };
self.console = console;
function __done(code) {
  if (__finished) return;
  __finished = true;
  postMessage({ type: 'done', exitCode: code });
}
function __guard(fn) {
  return function () {
    try { return fn.apply(this, arguments); }
    catch (e) { __fail(e); }
  };
}
function __fail(e) {
  if (e instanceof __Exit) return __done(e.code);
  __out('stderr', __fmt(e) + '\n');
  __done(1);
}
function __maybeDone() { __setTimeout(() => { if (!__timers && !__rl) __done(0); }, 0); }
self.setTimeout = (fn, ms, ...a) => { __timers++; return __setTimeout(() => { __timers--; __guard(fn)(...a); __maybeDone(); }, ms); };
self.clearTimeout = (id) => { if (id != null) { __timers = Math.max(0, __timers - 1); __clearTimeout(id); __maybeDone(); } };
self.setInterval = (fn, ms, ...a) => { __timers++; return __setInterval(__guard(fn), ms, ...a); };
self.clearInterval = (id) => { if (id != null) { __timers = Math.max(0, __timers - 1); __clearInterval(id); __maybeDone(); } };
self.addEventListener('unhandledrejection', (e) => { e.preventDefault(); __fail(e.reason); });
const __stdinLines = __stdin.split('\n'); if (__stdinLines[__stdinLines.length - 1] === '') __stdinLines.pop();
self.prompt = (q) => { if (q) __out('stdout', String(q)); return __stdinLines.length ? __stdinLines.shift() : null; };
const process = {
  argv: ['node', __entry], env: {}, platform: 'browser', exitCode: undefined,
  exit: (code) => { throw new __Exit(code == null ? (process.exitCode || 0) : Number(code) || 0); },
  stdout: { write: (s) => { __out('stdout', String(s)); return true; } },
  stderr: { write: (s) => { __out('stderr', String(s)); return true; } },
  stdin: { isTTY: false },
  on: () => process, nextTick: (fn, ...a) => Promise.resolve().then(() => __guard(fn)(...a)),
  hrtime: Object.assign(() => [0, 0], { bigint: () => BigInt(Math.round(performance.now() * 1e6)) }),
  memoryUsage: () => ({ heapUsed: 0 }),
};
self.process = process;
function __norm(p) {
  const out = [];
  for (const part of p.split('/')) { if (!part || part === '.') continue; if (part === '..') out.pop(); else out.push(part); }
  return out.join('/');
}
function __dirname(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
const __shims = {
  fs: {
    readFileSync: (p, enc) => {
      if (p === 0 || p === '/dev/stdin') return __stdinLines.join('\n') + (__stdinLines.length ? '\n' : '');
      const k = __norm(String(p));
      if (!(k in __files)) { const e = new Error("ENOENT: no such file or directory, open '" + p + "'"); e.code = 'ENOENT'; throw e; }
      return __files[k];
    },
    existsSync: (p) => __norm(String(p)) in __files,
  },
  readline: {
    createInterface: () => {
      const handlers = { line: [], close: [] };
      let closed = false, started = false;
      __rl++;
      const rl = {
        on(ev, fn) {
          (handlers[ev] = handlers[ev] || []).push(fn);
          if (ev === 'line' && !started) { started = true; __setTimeout(feed, 0); }
          return rl;
        },
        question(q, fn) {
          __out('stdout', String(q));
          // Like Node with piped input: at the end of the input the interface closes and the callback never runs.
          __setTimeout(() => { if (closed) return; if (__stdinLines.length) __guard(fn)(__stdinLines.shift()); else rl.close(); __maybeDone(); }, 0);
        },
        close() { if (closed) return; closed = true; __rl--; for (const f of handlers.close) __guard(f)(); __maybeDone(); },
        [Symbol.asyncIterator]: async function* () { while (__stdinLines.length) yield __stdinLines.shift(); rl.close(); },
      };
      function feed() {
        while (__stdinLines.length && !closed && !__finished) { const l = __stdinLines.shift(); for (const f of handlers.line) __guard(f)(l); }
        rl.close();
      }
      return rl;
    },
  },
  util: { inspect: (v) => __fmt(v, 1), format: (...a) => a.map((x) => __fmt(x)).join(' ') },
  path: { join: (...a) => __norm(a.join('/')), resolve: (...a) => '/' + __norm(a.join('/')), basename: (p) => String(p).split('/').pop(), dirname: __dirname, extname: (p) => { const m = /\.[^./]*$/.exec(String(p)); return m ? m[0] : ''; } },
  assert: Object.assign((c, m) => { if (!c) throw new Error(m || 'Assertion failed'); }, { strictEqual: (a, b, m) => { if (a !== b) throw new Error(m || ('Expected ' + __fmt(a, 1) + ' to equal ' + __fmt(b, 1))); } }),
};
function __require(spec, from) {
  spec = String(spec).replace(/^node:/, '');
  if (!spec.startsWith('.') && !spec.startsWith('/')) {
    if (spec in __shims) return __shims[spec];
    throw new Error("require('" + spec + "') isn't available when code runs in the browser. Only your own files and fs, readline, path, util, assert work here.");
  }
  const base = __norm((spec.startsWith('/') ? '' : from + '/') + spec);
  const key = [base, base + '.js', base + '.json', base + '/index.js'].find((k) => k in __defs);
  if (!key) throw new Error("Cannot find module '" + spec + "'");
  if (__cache[key]) return __cache[key].exports;
  const module = { exports: {} };
  __cache[key] = module;
  __defs[key].call(module.exports, module, module.exports, (s) => __require(s, __dirname(key)), key, __dirname(key));
  return module.exports;
}
`;

  function jsBundle(files, entry, stdin) {
    const mods = Object.keys(files).filter((p) => /\.(js|cjs|json)$/i.test(p));
    let src = PRELUDE.replace('__FILES__', () => JSON.stringify(files)).replace('__STDIN__', () => JSON.stringify(String(stdin || ''))).replace('__ENTRY__', () => JSON.stringify(entry));
    const map = []; // where each file's lines landed, so error line numbers point at the right file
    for (const p of mods) {
      if (/\.json$/i.test(p)) { src += `__defs[${JSON.stringify(p)}] = function (module) { module.exports = JSON.parse(${JSON.stringify(files[p])}); };\n`; continue; }
      src += `__defs[${JSON.stringify(p)}] = function (module, exports, require, __filename, __dirname) {\n`;
      const start = src.split('\n').length;
      src += `${files[p]}\n};\n`;
      map.push({ path: p, start, end: start + files[p].split('\n').length - 1 });
    }
    src += `try { __require(${JSON.stringify('./' + entry)}, ''); __maybeDone(); } catch (e) { __fail(e); }\n`;
    src = src.replace('__MAP__', () => JSON.stringify(map)); // one line, so the line numbers above stay right
    return { src, map };
  }

  window.addEventListener('message', (e) => {
    if (e.source !== parent) return;
    const m = e.data || {};
    if (m.type === 'run' && typeof m.files === 'object' && typeof m.entry === 'string') start(m);
    else if (m.type === 'stop' && current) kill(current, 'Stopped.');
    else if (m.type === 'warm') warm();
  });
  send({ type: 'hello' });
})();
