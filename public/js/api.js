// Thin fetch wrapper. Adds the X-Hak header the server requires on writes (CSRF guard).
export class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function request(method, url, body, opts = {}) {
  const init = { method, headers: { 'X-Hak': '1' }, credentials: 'same-origin' };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, init); }
  catch { throw new ApiError(0, 'Cannot reach the server. Check your connection.'); }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    if (res.status === 401 && !opts.quiet401) window.dispatchEvent(new CustomEvent('hak:unauthorized'));
    throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status}).`);
  }
  return data;
}

// Upload with progress (fetch has no upload progress).
export function upload(url, file, extra = {}, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    fd.append('file', file);
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.setRequestHeader('X-Hak', '1');
    x.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    x.onload = () => {
      let d = {};
      try { d = JSON.parse(x.responseText); } catch {}
      if (x.status >= 200 && x.status < 300) resolve(d);
      else reject(new ApiError(x.status, d.error || `Upload failed (${x.status}).`));
    };
    x.onerror = () => reject(new ApiError(0, 'Upload failed. Check your connection.'));
    x.send(fd);
  });
}

export const api = {
  get: (u, o) => request('GET', u, undefined, o),
  post: (u, b) => request('POST', u, b ?? {}),
  put: (u, b) => request('PUT', u, b ?? {}),
  patch: (u, b) => request('PATCH', u, b ?? {}),
  del: (u) => request('DELETE', u),
};
