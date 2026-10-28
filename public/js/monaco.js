// Loads the self-hosted Monaco editor once (works without internet at the venue).
let promise = null;
export function loadMonaco() {
  if (promise) return promise;
  promise = new Promise((resolve, reject) => {
    window.MonacoEnvironment = { getWorkerUrl: () => '/js/monaco-worker.js' };
    const s = document.createElement('script');
    s.src = '/vendor/monaco/vs/loader.js';
    s.onload = () => {
      window.require.config({ paths: { vs: '/vendor/monaco/vs' } });
      window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
    };
    s.onerror = () => reject(new Error('Could not load the code editor.'));
    document.head.append(s);
  });
  return promise;
}

const EXT_LANG = {
  py: 'python', js: 'javascript', mjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', java: 'java', c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', go: 'go', rs: 'rust', rb: 'ruby', php: 'php', html: 'html', htm: 'html', css: 'css',
  scss: 'scss', json: 'json', md: 'markdown', sql: 'sql', sh: 'shell', yml: 'yaml', yaml: 'yaml', xml: 'xml', kt: 'kotlin', swift: 'swift',
  r: 'r', ps1: 'powershell', txt: 'plaintext', csv: 'plaintext', dockerfile: 'dockerfile',
};
export function monacoLang(path) {
  const base = path.split('/').pop().toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  return EXT_LANG[base.split('.').pop()] || 'plaintext';
}
export const darkMode = () => window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
