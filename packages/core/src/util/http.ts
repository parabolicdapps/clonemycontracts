import { CmcError } from '../types.js';

const USER_AGENT = 'clonemycontracts/0.1';
const lastCall = new Map<string, number>();
const MIN_INTERVAL_MS = Number(process.env.CMC_HTTP_MIN_INTERVAL_MS ?? 250);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FetchJsonOptions {
  retries?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** statuses that should be returned as `null` instead of throwing (e.g. 404) */
  nullOn?: number[];
}

/** Polite JSON GET: per-host spacing, retries on 429/5xx/network errors with backoff. */
export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOptions = {}): Promise<T | null> {
  const { retries = 3, timeoutMs = 60_000, nullOn = [404] } = opts;
  const host = new URL(url).host;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const wait = (lastCall.get(host) ?? 0) + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall.set(host, Date.now());
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...opts.headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (nullOn.includes(res.status)) return null;
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get('retry-after'));
        lastErr = new Error(`HTTP ${res.status} from ${host}`);
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 800 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new CmcError(`HTTP ${res.status} from ${host}`, 'NETWORK');
      return (await res.json()) as T;
    } catch (e) {
      if (e instanceof CmcError) throw e;
      lastErr = e;
      await sleep(800 * 2 ** attempt);
    }
  }
  throw new CmcError(`Request to ${host} failed: ${(lastErr as Error)?.message ?? lastErr}`, 'NETWORK');
}

export async function fetchBuffer(url: string, retries = 3): Promise<Uint8Array> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      await sleep(800 * 2 ** attempt);
    }
  }
  throw new CmcError(`Download of ${url} failed: ${(lastErr as Error)?.message}`, 'NETWORK');
}
