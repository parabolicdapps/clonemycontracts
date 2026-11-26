import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorBody, HttpError } from './errors.js';
import type { Guard, JobCaps, PublicConfig } from './guard.js';

export const SESSION_COOKIE = 'cmc_session';
const CODE_TTL_MS = 30_000;
const MAX_FAILED_EXCHANGES = 10;

export interface LocalGuardOptions {
  /** the per-launch secret; default: 32 random bytes */
  token?: string;
  /** job limits; local use is one person, so these only stop runaway loops */
  caps?: Partial<JobCaps>;
  now?: () => number;
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** `127.0.0.1:<port>` and `localhost:<port>`: the only names this server answers to (defeats DNS rebinding). */
export function allowedHosts(port: number) { return new Set([`127.0.0.1:${port}`, `localhost:${port}`]); }

/**
 * Loopback-only access control:
 *  - every request: strict Host check, strict Origin check when an Origin is sent;
 *  - every request except /auth/exchange: the per-launch token in `Authorization: Bearer` (the shell) or an HttpOnly SameSite=Strict
 *    session cookie (the browser), which is obtained by exchanging a short-lived one-time code. The token itself never appears in a URL.
 */
export class LocalGuard implements Guard {
  readonly token: string;
  readonly hsts = false;
  readonly caps: JobCaps;
  private server: Server | null = null;
  private codes = new Map<string, number>();
  private sessions = new Set<string>();
  private failures: number[] = [];
  private now: () => number;

  constructor(o: LocalGuardOptions = {}) {
    this.token = o.token ?? randomBytes(32).toString('hex');
    this.caps = { maxQueued: 50, maxRewritesPerDay: 0, maxActivePerClient: 8, ...o.caps };
    this.now = o.now ?? Date.now;
  }

  attach(server: Server) { this.server = server; }
  private port() { const a = this.server?.address(); return a && typeof a === 'object' ? (a as AddressInfo).port : 0; }

  /** One-time code for a browser: valid 30 s, usable once. Minted through POST /api/auth/code with the launch token. */
  mintCode(): string {
    const t = this.now();
    for (const [c, exp] of this.codes) if (exp < t) this.codes.delete(c);
    const code = randomBytes(16).toString('hex');
    this.codes.set(code, t + CODE_TTL_MS);
    return code;
  }

  private exchange(code: string): string | null {
    const t = this.now();
    this.failures = this.failures.filter((f) => f > t - 60_000);
    if (this.failures.length >= MAX_FAILED_EXCHANGES) throw new HttpError(429, 'RATE_LIMIT', 'Too many failed attempts. Restart the app.');
    const exp = this.codes.get(code);
    this.codes.delete(code); // single use, even when expired
    if (exp === undefined || exp < t) { this.failures.push(t); return null; }
    const sid = randomBytes(32).toString('hex');
    this.sessions.add(sid);
    return sid;
  }

  private cookieSession(req: IncomingMessage): string | null {
    const raw = req.headers.cookie;
    if (!raw) return null;
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) { const v = part.slice(i + 1).trim(); return this.sessions.has(v) ? v : null; }
    }
    return null;
  }
  private bearerOk(req: IncomingMessage): boolean {
    const m = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '');
    return !!m && safeEqual(m[1]!, this.token);
  }

  private deny(res: ServerResponse, status: number, code: string, message: string, wantsHtml: boolean) {
    if (wantsHtml) { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); return void res.end(`${status} ${message}`); }
    const body = Buffer.from(JSON.stringify(errorBody(new HttpError(status, code, message))));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
    res.end(body);
  }

  async preflight(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const port = this.port();
    const hosts = allowedHosts(port);
    const html = !url.pathname.startsWith('/api/');
    if (!port || !hosts.has(String(req.headers.host ?? '').toLowerCase())) { this.deny(res, 403, 'FORBIDDEN', 'Unexpected Host header', html); return true; }
    const origin = req.headers.origin;
    if (origin !== undefined && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) { this.deny(res, 403, 'FORBIDDEN', 'Cross-origin requests are not allowed', html); return true; }

    if (url.pathname === '/auth/exchange' && req.method === 'GET') {
      let sid: string | null;
      try { sid = this.exchange(url.searchParams.get('code') ?? ''); } catch (e) { const he = e as HttpError; this.deny(res, he.status, he.code, he.message, true); return true; }
      if (!sid) { this.deny(res, 403, 'FORBIDDEN', 'That sign-in link is no longer valid. Reopen the app.', true); return true; }
      res.writeHead(302, { Location: '/', 'Set-Cookie': `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.end();
      return true;
    }

    const viaBearer = this.bearerOk(req);
    const viaCookie = !viaBearer && !!this.cookieSession(req);
    if (!viaBearer && !viaCookie) {
      this.deny(res, 401, 'AUTH', 'Open this app from the CloneMyContracts window; this address needs the app\'s session.', html);
      return true;
    }
    // cookie-authenticated writes must be provably same-origin (belt and braces on top of SameSite=Strict)
    if (viaCookie && req.method !== 'GET' && req.method !== 'HEAD') {
      const sfs = req.headers['sec-fetch-site'];
      if (origin === undefined && sfs !== 'same-origin') { this.deny(res, 403, 'FORBIDDEN', 'Cross-origin requests are not allowed', html); return true; }
    }
    if (url.pathname === '/api/auth/code' && req.method === 'POST') {
      if (!viaBearer) { this.deny(res, 403, 'FORBIDDEN', 'Only the launcher may request a sign-in code', false); return true; }
      const body = Buffer.from(JSON.stringify({ code: this.mintCode(), expiresInSeconds: CODE_TTL_MS / 1000 }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      res.end(body);
      return true;
    }
    return false;
  }

  apiGate() { /* authentication happened in preflight; no per-IP limits for a single local user */ }
  clientOf() { return 'local'; }
  subjectOf() { return null; }
  logIp() { return '127.0.0.1'; }
  publicConfig(): PublicConfig { return { badge: 'Local', footerNote: 'Runs on this computer', authRequired: false }; }
  csp(base: string) { return base; }
  close() { this.codes.clear(); this.sessions.clear(); }
}
