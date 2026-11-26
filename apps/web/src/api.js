export class ApiError extends Error {
  constructor(code, message, status, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    /** the rest of the error body, e.g. `problems` of a SPEC_MISMATCH refusal or `fields` of a validation error */
    this.extra = extra;
  }
}

/* ---------- optional access token (server started with CMC_AUTH_TOKEN) ---------- */
const TOKEN_KEY = 'cmc-token';
export function getToken() {
  try { return window.sessionStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
}
export function setToken(t) {
  try { if (t) window.sessionStorage.setItem(TOKEN_KEY, t); else window.sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked: the token only lives until reload */ }
}

let askForToken = null;
/** main.js registers the dialog that asks for the token; it resolves to the entered token or '' when dismissed */
export function onTokenNeeded(fn) { askForToken = fn; }

async function rawFetch(path, init = {}) {
  const headers = new Headers(init.headers);
  const t = getToken();
  if (t) headers.set('authorization', `Bearer ${t}`);
  return fetch(path, { ...init, headers });
}

/** fetch with the token; on 401 asks for the token once and retries */
export async function authFetch(path, init = {}) {
  let res;
  try { res = await rawFetch(path, init); } catch { throw new ApiError('NETWORK', 'Could not reach the CloneMyContracts engine. Is the app still running?', 0); }
  if (res.status === 401 && askForToken) {
    const t = await askForToken(!!getToken());
    if (t) {
      setToken(t);
      try { res = await rawFetch(path, init); } catch { throw new ApiError('NETWORK', 'Could not reach the CloneMyContracts engine. Is the app still running?', 0); }
      if (res.status === 401) setToken('');
    }
  }
  return res;
}

async function parse(res) {
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const e = body && body.error;
    throw new ApiError(e?.code ?? 'HTTP', e?.message ?? `Request failed (${res.status})`, res.status, { ...(Array.isArray(body?.problems) ? { problems: body.problems } : {}), ...(Array.isArray(e?.fields) ? { fields: e.fields } : {}) });
  }
  return body;
}

export async function post(path, payload) {
  return parse(await authFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }));
}

export async function get(path) {
  return parse(await authFetch(path));
}

export async function del(path) {
  return parse(await authFetch(path, { method: 'DELETE' }));
}

/** Download a file through the token-carrying fetch (a plain link cannot send the header). */
export async function download(path, fallbackName) {
  const res = await authFetch(path);
  if (!res.ok) { await parse(res); return; }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Server-sent events over fetch, so the Authorization header can be sent (EventSource cannot).
 * Same small surface as EventSource: addEventListener, onerror, readyState, close.
 */
export class EventStream {
  static CLOSED = 2;
  constructor(path) {
    this.readyState = 0;
    this.onerror = null;
    this.handlers = new Map();
    this.ctl = new AbortController();
    this.run(path);
  }
  addEventListener(type, fn) { (this.handlers.get(type) ?? this.handlers.set(type, []).get(type)).push(fn); }
  close() { this.readyState = EventStream.CLOSED; this.ctl.abort(); }
  fail() { if (this.readyState === EventStream.CLOSED) return; if (this.ended) { this.readyState = EventStream.CLOSED; return; } this.readyState = EventStream.CLOSED; this.onerror?.(new Event('error')); }
  async run(path) {
    try {
      const res = await rawFetch(path, { signal: this.ctl.signal, headers: { accept: 'text/event-stream' } });
      if (!res.ok || !res.body) return this.fail();
      this.readyState = 1;
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let type = 'message';
          const data = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) type = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          }
          if (!data.length) continue;
          if (type === 'done') this.ended = true;
          for (const fn of this.handlers.get(type) ?? []) fn({ data: data.join('\n') });
        }
      }
      this.fail(); // the server ends the stream after `done`; callers close() on done first
    } catch {
      this.fail();
    }
  }
}
