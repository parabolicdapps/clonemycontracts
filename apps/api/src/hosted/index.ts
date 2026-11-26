import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { HttpError } from '../errors.js';
import type { Guard, JobCaps, PublicConfig } from '../guard.js';
import { AccessDenied, AccessVerifier, assertSafeToStart, bearerMatches, securityFromEnv, type SecurityConfig } from './access.js';

export * from './access.js';

/** Per-key counter over a rolling window: the old per-IP request limits meant for strangers. */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  private timer: NodeJS.Timeout;
  constructor(private windowMs = 60_000) {
    this.timer = setInterval(() => { const now = Date.now(); for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k); }, windowMs).unref();
  }
  /** returns seconds to wait when over the limit, else 0 */
  take(key: string, limit: number): number {
    const now = Date.now();
    let h = this.hits.get(key);
    if (!h || h.reset < now) { h = { n: 0, reset: now + this.windowMs }; this.hits.set(key, h); }
    h.n++;
    return h.n > limit ? Math.ceil((h.reset - now) / 1000) : 0;
  }
  close() { clearInterval(this.timer); }
}

const HEAVY = new Set(['/api/rewrite', '/api/rewrite/plan', '/api/inspect', '/api/inspect-job', '/api/recompile', '/api/plan', '/api/simulate', '/api/project', '/api/deploy-payload']);

export interface HostedOptions {
  security?: Partial<SecurityConfig>;
  /** a ready verifier for Cloudflare Access tokens (tests); default: built from security.accessTeamDomain/accessAud */
  access?: AccessVerifier | null;
  rateLimit?: number;
  rateLimitHeavy?: number;
  trustProxy?: boolean;
  /** test seam: a stable client key per request, used when there is no verified identity */
  clientKey?: (req: IncomingMessage) => string | undefined;
  caps?: Partial<JobCaps>;
}

/**
 * The public-deployment policy (Cloudflare Access JWT, bearer token, per-IP rate limits, public-origin handling).
 * OFF in the local app: it is only built when `CMC_HOSTED=1` (apps/api/src/main.ts) and by tests that keep covering it.
 */
export class HostedGuard implements Guard {
  readonly sec: SecurityConfig;
  readonly caps: JobCaps;
  readonly hsts: boolean;
  private access: AccessVerifier | null;
  private limiter = new RateLimiter();
  private limiterHeavy = new RateLimiter();
  private subjects = new WeakMap<IncomingMessage, string>();
  private limit: number;
  private limitHeavy: number;
  constructor(private o: HostedOptions = {}) {
    this.sec = { ...securityFromEnv(), ...o.security, ...(o.trustProxy !== undefined ? { trustProxy: o.trustProxy } : {}) };
    this.access = o.access !== undefined ? o.access : this.sec.accessTeamDomain && this.sec.accessAud ? new AccessVerifier({ teamDomain: this.sec.accessTeamDomain, aud: this.sec.accessAud }) : null;
    this.limit = o.rateLimit ?? Number(process.env.CMC_RATE_LIMIT ?? 120);
    this.limitHeavy = o.rateLimitHeavy ?? Number(process.env.CMC_RATE_LIMIT_HEAVY ?? 30);
    this.hsts = this.sec.publicOrigin.startsWith('https://');
    this.caps = { maxQueued: Number(process.env.CMC_MAX_QUEUED ?? 20), maxRewritesPerDay: Number(process.env.CMC_MAX_REWRITES_PER_DAY ?? 20), maxActivePerClient: 3, ...o.caps };
  }

  /** Refuses to start a hosted server that listens beyond loopback without a gate. */
  static assertSafe(host: string, sec: SecurityConfig) { assertSafeToStart(host, sec); }

  attach(_server: Server) { /* no port-dependent checks */ }

  async preflight(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) return false;
    if (this.access) {
      try {
        const who = await this.access.verify(String(req.headers['cf-access-jwt-assertion'] ?? ''));
        this.subjects.set(req, who.subject);
      } catch (e) {
        if (!(e instanceof AccessDenied)) console.error('access check error:', (e as Error)?.message);
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('Forbidden');
        return true;
      }
    }
    return false;
  }

  /** The caller as the origin sees it. Never from a request header: behind the tunnel everything is 127.0.0.1, so identity comes from the verified Access token. */
  private socketIp = (req: IncomingMessage) => req.socket.remoteAddress ?? 'unknown';
  clientOf(req: IncomingMessage) { return this.subjects.get(req) ?? this.o.clientKey?.(req) ?? this.socketIp(req); }
  subjectOf(req: IncomingMessage) { return this.subjects.get(req) ?? null; }
  logIp(req: IncomingMessage) {
    if (this.sec.trustProxy) { const x = String(req.headers['cf-connecting-ip'] ?? '').trim(); if (/^[0-9a-fA-F:.]{3,45}$/.test(x)) return x; }
    return this.socketIp(req);
  }

  apiGate(req: IncomingMessage, path: string) {
    const ip = this.clientOf(req);
    const wait = this.limiter.take(ip, this.limit);
    if (wait) throw new HttpError(429, 'RATE_LIMIT', `Too many requests. Try again in ${wait}s.`, { 'Retry-After': String(wait) });
    if (HEAVY.has(path)) {
      const w = this.limiterHeavy.take(ip, this.limitHeavy);
      if (w) throw new HttpError(429, 'RATE_LIMIT', `Too many analysis requests. Try again in ${w}s.`, { 'Retry-After': String(w) });
    }
    if (req.method === 'GET' && path === '/api/config') return;
    if (this.sec.authToken && !bearerMatches(req.headers.authorization, this.sec.authToken)) {
      throw new HttpError(401, 'AUTH', 'A valid access token is required.', { 'WWW-Authenticate': 'Bearer realm="cmc"' });
    }
    if (req.method === 'POST' || req.method === 'DELETE') {
      const origin = req.headers.origin;
      if (origin && origin !== 'null') {
        let same = false;
        try { const u = new URL(origin); same = u.host === req.headers.host || (!!this.sec.publicOrigin && u.origin === this.sec.publicOrigin); } catch { /* not a URL */ }
        if (!same) throw new HttpError(403, 'FORBIDDEN', 'Cross-origin requests are not allowed');
      }
    }
  }

  publicConfig(): PublicConfig { return { badge: this.sec.badge, footerNote: this.sec.footerNote, authRequired: !!this.sec.authToken }; }
  csp(base: string) { return this.hsts ? `${base}; upgrade-insecure-requests` : base; }
  close() { this.limiter.close(); this.limiterHeavy.close(); }
}
