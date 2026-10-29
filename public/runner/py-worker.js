/* global BASE, loadPyodide */
// Python worker for the in-browser runner (see frame.js, which prepends `const BASE = "<origin>/"`).
// Pyodide = CPython compiled to WebAssembly, served from this portal (/vendor/pyodide), standard
// library only. One run at a time; the frame kills this worker when a run goes over the time limit.
importScripts(BASE + 'vendor/pyodide/pyodide.js');

const ROOT = '/home/pyodide/run';
let stdinLines = [];
let runNo = 0;

function streamTo(stream) {
  const dec = new TextDecoder();
  return { write(buf) { postMessage({ type: 'out', stream, text: dec.decode(buf, { stream: true }) }); return buf.length; } };
}

const ready = (async () => {
  const py = await loadPyodide({ indexURL: BASE + 'vendor/pyodide/' });
  py.setStdout(streamTo('stdout'));
  py.setStderr(streamTo('stderr'));
  py.setStdin({ stdin: () => (stdinLines.length ? stdinLines.shift() : undefined), autoEOF: true });
  py.runPython(`
import sys, os, runpy, traceback

def __hak_run(root, entry):
    # Forget the previous run's modules, so an edited helper file is imported fresh.
    for name, mod in list(sys.modules.items()):
        f = getattr(mod, '__file__', None) or ''
        if f.startswith('${ROOT}'):
            del sys.modules[name]
    sys.path[:] = [p for p in sys.path if not p.startswith('${ROOT}')]
    path = os.path.join(root, entry)
    sys.path.insert(0, os.path.dirname(path))
    if os.path.dirname(path) != root:
        sys.path.insert(1, root)
    os.chdir(root)
    sys.argv = [entry]
    try:
        runpy.run_path(path, run_name='__main__')
        return 0
    except SystemExit as e:
        c = e.code
        if c is None:
            return 0
        if isinstance(c, int):
            return c
        print(c, file=sys.stderr)
        return 1
    except BaseException as e:
        # Show only the student's own lines, with paths relative to the project.
        frames = [f for f in traceback.extract_tb(e.__traceback__) if f.filename.startswith(root + '/')]
        for f in frames:
            f.filename = f.filename[len(root) + 1:]
        out = ''
        if frames:
            out = 'Traceback (most recent call last):\\n' + ''.join(traceback.format_list(frames))
        out += ''.join(traceback.format_exception_only(type(e), e)).replace(root + '/', '')
        sys.stderr.write(out)
        return 1
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
`);
  return py;
})();
ready.then(() => postMessage({ type: 'ready' }), (e) => postMessage({ type: 'fatal', message: 'Python could not start: ' + (e && e.message ? e.message : e) }));

onmessage = async (e) => {
  const m = e.data || {};
  if (m.type !== 'run') return;
  const py = await ready;
  const root = `${ROOT}${++runNo}`;
  try {
    py.FS.mkdirTree(root);
    for (const [p, content] of Object.entries(m.files || {})) {
      if (typeof content !== 'string' || p.includes('..') || p.startsWith('/')) continue;
      const full = `${root}/${p}`;
      py.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
      py.FS.writeFile(full, content);
    }
    stdinLines = String(m.stdin || '').split('\n');
    if (stdinLines[stdinLines.length - 1] === '') stdinLines.pop();
    const runFn = py.globals.get('__hak_run');
    const code = runFn(root, m.entry);
    runFn.destroy();
    postMessage({ type: 'done', exitCode: code });
  } catch (err) {
    postMessage({ type: 'out', stream: 'stderr', text: String(err && err.message ? err.message : err) + '\n' });
    postMessage({ type: 'done', exitCode: 1 });
  }
};
