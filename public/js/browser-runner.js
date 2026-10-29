// Runs Python and JavaScript in the browser when the event's Docker sandbox is unavailable
// (laptop without Docker, the hosted demo). The code runs inside /runner/frame.html, an iframe
// sandboxed WITHOUT allow-same-origin: it gets an opaque origin, so a program can't read this page,
// use this person's session, or call the portal API. Everything it sends back is shown as text.
export const BROWSER_LANGS = ['python', 'javascript'];
export const browserCanRun = (lang) => BROWSER_LANGS.includes(lang);

let frame = null, frameReady = null, seq = 0;
const runs = new Map(); // id -> { onOutput, onStatus, resolve }

function ensureFrame() {
  if (frameReady) return frameReady;
  frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.title = 'Code runner';
  frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
  frameReady = new Promise((resolve, reject) => {
    const t = setTimeout(() => { reject(new Error('The in-browser runner did not load.')); reset(); }, 15000);
    window.addEventListener('message', function hello(e) {
      if (!frame || e.source !== frame.contentWindow || !e.data || e.data.type !== 'hello') return;
      clearTimeout(t); window.removeEventListener('message', hello); resolve();
    });
  });
  frame.src = '/runner/frame.html';
  document.body.append(frame);
  return frameReady;
}
function reset() { if (frame) frame.remove(); frame = null; frameReady = null; }

window.addEventListener('message', (e) => {
  if (!frame || e.source !== frame.contentWindow) return;
  const d = e.data || {};
  const r = runs.get(d.id);
  if (!r) return;
  if (d.type === 'out') r.onOutput(d.stream === 'stderr' ? 'stderr' : 'stdout', String(d.text));
  else if (d.type === 'status') r.onStatus(String(d.text));
  else if (d.type === 'done') {
    runs.delete(d.id);
    r.resolve({ exitCode: typeof d.exitCode === 'number' ? d.exitCode : null, durationMs: Number(d.durationMs) || 0, timedOut: !!d.timedOut, truncated: !!d.truncated, error: d.error ? String(d.error) : '' });
  }
});

// Start Python loading in the background (it takes a few seconds the first time).
export function warmPython() { ensureFrame().then(() => frame.contentWindow.postMessage({ type: 'warm' }, '*')).catch(() => {}); }

export async function browserRun({ lang, entry, files, stdin = '', timeoutMs = 10000, onOutput = () => {}, onStatus = () => {} }) {
  await ensureFrame();
  const id = ++seq;
  for (const [rid, r] of runs) { runs.delete(rid); r.resolve({ exitCode: null, durationMs: 0, timedOut: false, truncated: false, error: 'Stopped: a new run started.' }); }
  return new Promise((resolve) => {
    runs.set(id, { onOutput, onStatus, resolve });
    frame.contentWindow.postMessage({ type: 'run', id, lang, entry, files, stdin, timeoutMs }, '*');
  });
}
