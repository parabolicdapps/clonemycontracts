import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage, ChatOptions, ChatResult, LlmProvider, LlmUsage } from './provider.js';

/** Counting semaphore: at most `max` callers run at once, the rest queue. */
export class Semaphore {
  private waiters: (() => void)[] = [];
  private active = 0;
  constructor(public readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try { return await fn(); } finally { this.active--; this.waiters.shift()?.(); }
  }
}

export const MAX_CONCURRENCY = 4;

export type LlmErrorKind = 'auth' | 'rate_limit' | 'bad_request' | 'not_found' | 'server' | 'network' | 'timeout' | 'aborted' | 'refused' | 'unavailable';

/** Provider failure with a stable kind; `message` is already redacted and safe to show to the user. */
export class LlmError extends Error {
  constructor(public kind: LlmErrorKind, message: string, public status?: number, public retryable = false) { super(message); this.name = 'LlmError'; }
}

/** Maps an HTTP status to an error kind. 408/409/425/429 and 5xx are retryable. */
export function errorFromStatus(status: number, body: string): LlmError {
  const detail = redactSecrets(extractErrorMessage(body)).slice(0, 300);
  const msg = `HTTP ${status}${detail ? `: ${detail}` : ''}`;
  if (status === 401 || status === 403) return new LlmError('auth', msg, status, false);
  if (status === 404) return new LlmError('not_found', msg, status, false);
  if (status === 429) return new LlmError('rate_limit', msg, status, true);
  if (status === 408 || status === 409 || status === 425 || status >= 500) return new LlmError('server', msg, status, true);
  return new LlmError('bad_request', msg, status, false);
}

function extractErrorMessage(body: string): string {
  try {
    const j = JSON.parse(body);
    const e = Array.isArray(j) ? j[0]?.error ?? j[0] : j?.error ?? j;
    if (typeof e === 'string') return e;
    if (typeof e?.message === 'string') return e.message;
  } catch { /* not JSON */ }
  return body;
}

// --- secret redaction ------------------------------------------------------------------------------------------

const SECRET_HEADERS = /^(authorization|proxy-authorization|x-api-key|api-key|x-goog-api-key|cookie|set-cookie)$/i;
const SECRET_PARAMS = /^(key|api[_-]?key|access[_-]?token|token|auth|authorization)$/i;

/** Copy of a header bag with every credential header replaced. Safe to log. */
export function redactHeaders(h: Record<string, string> | Headers): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = h instanceof Headers ? [...h.entries()] : Object.entries(h);
  for (const [k, v] of entries) out[k] = SECRET_HEADERS.test(k) ? '[redacted]' : v;
  return out;
}

/** URL with credential-bearing query parameters and userinfo removed. Safe to log. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = ''; u.password = '';
    for (const k of [...u.searchParams.keys()]) if (SECRET_PARAMS.test(k)) u.searchParams.set(k, '[redacted]');
    return u.toString();
  } catch { return redactSecrets(raw); }
}

/** Removes anything in free text that looks like a credential: bearer tokens, `sk-…`/`AIza…` style keys, `key=…` parameters. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(/\b(x-api-key|api-key|x-goog-api-key|authorization)\s*[:=]\s*\S+/gi, '$1: [redacted]')
    .replace(/([?&](?:key|api[_-]?key|access[_-]?token|token)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/\bsk-(?:ant-|or-v1-|proj-)?[A-Za-z0-9_-]{6,}/g, 'sk-[redacted]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, 'AIza[redacted]');
}

// --- SSE -------------------------------------------------------------------------------------------------------

export interface SseEvent { event: string; data: string }

/** Incremental server-sent-events parser: comment lines (`: keep-alive`) are skipped, CRLF is accepted. */
export class SseParser {
  private buf = '';
  private event = 'message';
  private data: string[] = [];
  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const out: SseEvent[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      if (line === '') {
        if (this.data.length) out.push({ event: this.event, data: this.data.join('\n') });
        this.event = 'message'; this.data = [];
      } else if (line.startsWith(':')) { /* comment */ }
      else if (line.startsWith('event:')) this.event = line.slice(6).trim();
      else if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''));
    }
    return out;
  }
}

// --- shared request machinery ---------------------------------------------------------------------------------

export interface BaseOptions {
  /** max simultaneous requests (default 2, hard cap 4) */
  concurrency?: number;
  /** abort when no stream data has arrived for this long (default 300 s). There is no total cutoff. */
  readTimeoutMs?: number;
  retries?: number;
  /** base back-off between retries (default 3000 ms, multiplied by the attempt number) */
  retryBaseMs?: number;
  /** directory for request/response logs (one file group per request). Credentials are never written there. */
  logDir?: string;
}

export interface Attempt { content: string; reasoningChars: number; finish: string | null; tokensIn: number; tokensOut: number; model?: string; reportedCostUsd?: number }

let seq = 0;

/** Retry loop, semaphore, usage totals and credential-free request logs shared by every network provider. */
export abstract class BaseProvider implements LlmProvider {
  abstract readonly name: string;
  protected sem: Semaphore;
  protected u: LlmUsage = { requests: 0, tokensIn: 0, tokensOut: 0, modelSecs: 0 };
  protected readonly base: Required<Pick<BaseOptions, 'concurrency' | 'readTimeoutMs' | 'retries' | 'retryBaseMs'>> & Pick<BaseOptions, 'logDir'>;

  constructor(o: BaseOptions) {
    this.base = {
      concurrency: Math.max(1, Math.min(MAX_CONCURRENCY, o.concurrency ?? 2)),
      readTimeoutMs: o.readTimeoutMs ?? 300_000,
      retries: o.retries ?? 2,
      retryBaseMs: o.retryBaseMs ?? 3000,
      logDir: o.logDir,
    };
    this.sem = new Semaphore(this.base.concurrency);
  }

  usage(): LlmUsage { return { ...this.u }; }

  chat(messages: ChatMessage[], co: ChatOptions = {}): Promise<ChatResult> { return this.sem.run(() => this.once(messages, co)); }

  /** One network attempt. `body` is what gets logged (never headers). */
  protected abstract attempt(messages: ChatMessage[], co: ChatOptions, signal: AbortSignal | undefined, readTimeoutMs: number): Promise<Attempt>;
  /** the request body to write to the request log (credential-free by construction) */
  protected abstract logBody(messages: ChatMessage[], co: ChatOptions): unknown;

  private async once(messages: ChatMessage[], co: ChatOptions): Promise<ChatResult> {
    const id = String(++seq).padStart(3, '0');
    const label = (co.label ?? 'req').replace(/[^\w.-]+/g, '_');
    const base = this.base.logDir ? join(this.base.logDir, 'llm', `${id}_${label}`) : null;
    if (base) {
      mkdirSync(join(this.base.logDir!, 'llm'), { recursive: true });
      writeFileSync(`${base}.request.json`, redactSecrets(JSON.stringify(this.logBody(messages, co), null, 1)));
    }
    const sig = co.totalTimeoutMs ? (co.signal ? AbortSignal.any([co.signal, AbortSignal.timeout(co.totalTimeoutMs)]) : AbortSignal.timeout(co.totalTimeoutMs)) : co.signal;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= (co.retries ?? this.base.retries); attempt++) {
      const t0 = Date.now();
      try {
        const r = await this.attempt(messages, co, sig, co.readTimeoutMs ?? this.base.readTimeoutMs);
        const secs = (Date.now() - t0) / 1000;
        const tokensIn = r.tokensIn || Math.ceil(messages.reduce((s, m) => s + m.content.length, 0) / 3);
        const tokensOut = r.tokensOut || Math.ceil((r.content.length + r.reasoningChars) / 3);
        this.u.requests++; this.u.tokensIn += tokensIn; this.u.tokensOut += tokensOut; this.u.modelSecs += secs;
        if (base) writeFileSync(`${base}.response.txt`, `# finish=${r.finish} tokens_in=${tokensIn} tokens_out=${tokensOut} reasoning_chars=${r.reasoningChars} secs=${secs.toFixed(1)}\n${r.content}`);
        return { content: r.content, tokensIn, tokensOut, reasoningChars: r.reasoningChars, finish: r.finish, secs, ...(r.model ? { model: r.model } : {}), ...(r.reportedCostUsd !== undefined ? { reportedCostUsd: r.reportedCostUsd } : {}) };
      } catch (e) {
        lastErr = e;
        const msg = redactSecrets((e as Error).message ?? String(e));
        if (base) appendFileSync(`${base}.errors.txt`, `attempt ${attempt}: ${msg}\n`);
        if (sig?.aborted) break;
        if (e instanceof LlmError && !e.retryable) break;
        if (attempt < (co.retries ?? this.base.retries)) await new Promise((res) => setTimeout(res, this.base.retryBaseMs * (attempt + 1)));
      }
    }
    if (lastErr instanceof LlmError) throw new LlmError(lastErr.kind, `model call failed: ${lastErr.message}`, lastErr.status, false);
    throw new LlmError(co.signal?.aborted ? 'aborted' : 'network', `model call failed: ${redactSecrets((lastErr as Error)?.message ?? String(lastErr))}`);
  }
}

/** Streaming POST with an idle read timeout. Calls `onEvent` for every SSE event; throws LlmError on HTTP/network errors. */
export async function streamSse(
  url: string, init: { headers: Record<string, string>; body: unknown }, signal: AbortSignal | undefined, readTimeoutMs: number,
  onEvent: (e: SseEvent) => void,
): Promise<void> {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(new Error('aborted'));
  signal?.addEventListener('abort', onAbort);
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; ctl.abort(new Error(`no data for ${readTimeoutMs} ms (read timeout)`)); }, readTimeoutMs); };
  try {
    arm();
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...init.headers }, body: JSON.stringify(init.body), signal: ctl.signal });
    } catch (e) {
      throw new LlmError(timedOut ? 'timeout' : 'network', timedOut ? `no data for ${readTimeoutMs} ms (read timeout)` : `could not reach ${redactUrl(url)}: ${redactSecrets(String(((e as Error).cause as Error | undefined)?.message ?? (e as Error).message))}`, undefined, true);
    }
    if (!res.ok || !res.body) throw errorFromStatus(res.status, await res.text().catch(() => ''));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const p = new SseParser();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // any bytes (including keep-alive comments) prove the connection is alive, but only real events reset the model-progress clock
        for (const ev of p.push(dec.decode(value, { stream: true }))) { arm(); onEvent(ev); }
      }
    } catch (e) {
      if (e instanceof LlmError) throw e;
      throw new LlmError(timedOut ? 'timeout' : 'network', timedOut ? `no data for ${readTimeoutMs} ms (read timeout)` : `stream interrupted: ${redactSecrets((e as Error).message)}`, undefined, true);
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
