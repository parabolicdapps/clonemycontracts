import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify, type KeyObject } from 'node:crypto';

/** Who made a request, as proven by the Cloudflare Access JWT. */
export interface AccessIdentity {
  /** stable key for limits and logs: `email:<address>`, `svc:<common_name>` or `sub:<id>` */
  subject: string;
  email?: string;
  commonName?: string;
}

export class AccessDenied extends Error {}

export interface AccessOptions {
  /** `<team>.cloudflareaccess.com` (a leading https:// is tolerated) */
  teamDomain: string;
  /** the Access application audience tag */
  aud: string;
  /** injectable for tests */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** seconds of clock skew tolerated for exp/nbf */
  skewSeconds?: number;
  fetchTimeoutMs?: number;
  /** at most one JWKS refresh per this many ms (stops an unknown `kid` from hammering the team domain) */
  minRefreshMs?: number;
  /** override the certs URL (tests) */
  certsUrl?: string;
}

const b64u = (s: string) => Buffer.from(s, 'base64url');

function parseJson(buf: Buffer): Record<string, unknown> {
  const v = JSON.parse(buf.toString('utf8'));
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new AccessDenied('not an object');
  return v as Record<string, unknown>;
}

/** Verifies `Cf-Access-Jwt-Assertion` tokens (RS256) against the team's published keys. Fails closed. */
export class AccessVerifier {
  readonly issuer: string;
  private readonly aud: string;
  private readonly certsUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly skew: number;
  private readonly timeout: number;
  private readonly minRefresh: number;
  private keys = new Map<string, KeyObject>();
  private lastRefresh = 0;
  private inflight: Promise<void> | null = null;

  constructor(o: AccessOptions) {
    const team = o.teamDomain.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (!team || /[/\s]/.test(team)) throw new Error('CMC_ACCESS_TEAM_DOMAIN must be a host name such as myteam.cloudflareaccess.com');
    if (!o.aud.trim()) throw new Error('CMC_ACCESS_AUD must be the Access application audience tag');
    this.issuer = `https://${team}`;
    this.aud = o.aud.trim();
    this.certsUrl = o.certsUrl ?? `${this.issuer}/cdn-cgi/access/certs`;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.now = o.now ?? Date.now;
    this.skew = o.skewSeconds ?? 60;
    this.timeout = o.fetchTimeoutMs ?? 5000;
    this.minRefresh = o.minRefreshMs ?? 30_000;
  }

  private async refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    if (this.now() - this.lastRefresh < (this.keys.size ? this.minRefresh : Math.min(this.minRefresh, 2000))) return;
    this.lastRefresh = this.now();
    this.inflight = (async () => {
      try {
        const r = await this.fetchImpl(this.certsUrl, { signal: AbortSignal.timeout(this.timeout), headers: { accept: 'application/json' } });
        if (!r.ok) return;
        const body = (await r.json()) as { keys?: Record<string, unknown>[] };
        const next = new Map<string, KeyObject>();
        for (const jwk of body.keys ?? []) {
          if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
          try { next.set(jwk.kid, createPublicKey({ key: jwk as never, format: 'jwk' })); } catch { /* skip a key we cannot read */ }
        }
        if (next.size) this.keys = next; // never replace good keys with an empty set
      } catch { /* network failure: keep whatever is cached; no keys means closed */ }
    })().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async verify(token: string | undefined): Promise<AccessIdentity> {
    if (!token || token.length > 8192) throw new AccessDenied('missing');
    const parts = token.split('.');
    if (parts.length !== 3) throw new AccessDenied('malformed');
    let header: Record<string, unknown>, claims: Record<string, unknown>;
    try { header = parseJson(b64u(parts[0]!)); claims = parseJson(b64u(parts[1]!)); } catch { throw new AccessDenied('malformed'); }
    if (header.alg !== 'RS256') throw new AccessDenied('algorithm');
    const kid = typeof header.kid === 'string' ? header.kid : '';
    if (!kid) throw new AccessDenied('no kid');
    let key = this.keys.get(kid);
    if (!key) { await this.refresh(); key = this.keys.get(kid); }
    if (!key) throw new AccessDenied('unknown key');
    const okSig = cryptoVerify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, b64u(parts[2]!));
    if (!okSig) throw new AccessDenied('signature');
    const nowS = Math.floor(this.now() / 1000);
    if (claims.iss !== this.issuer) throw new AccessDenied('issuer');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.aud)) throw new AccessDenied('audience');
    if (typeof claims.exp !== 'number' || claims.exp + this.skew < nowS) throw new AccessDenied('expired');
    if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf - this.skew > nowS)) throw new AccessDenied('not yet valid');
    const email = typeof claims.email === 'string' && claims.email ? claims.email.toLowerCase() : undefined;
    const commonName = typeof claims.common_name === 'string' && claims.common_name ? claims.common_name : undefined;
    const sub = typeof claims.sub === 'string' && claims.sub ? claims.sub : undefined;
    const subject = email ? `email:${email}` : commonName ? `svc:${commonName}` : sub ? `sub:${sub}` : '';
    if (!subject) throw new AccessDenied('no subject');
    return { subject, ...(email ? { email } : {}), ...(commonName ? { commonName } : {}) };
  }
}

/** Constant-time check of an `Authorization: Bearer <token>` header against the configured token. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer ([^\s]+)$/i.exec(header ?? '');
  const given = createHash('sha256').update(m ? m[1]! : '').digest();
  const want = createHash('sha256').update(token).digest();
  return timingSafeEqual(given, want) && !!m;
}

export interface SecurityConfig {
  accessTeamDomain: string;
  accessAud: string;
  authToken: string;
  trustProxy: boolean;
  publicOrigin: string;
  allowOpen: boolean;
  badge: string;
  footerNote: string;
}

const clean = (s: string | undefined, max: number) => (s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

export function securityFromEnv(env: NodeJS.ProcessEnv = process.env): SecurityConfig {
  const badge = clean(env.CMC_BADGE, 40);
  return {
    accessTeamDomain: (env.CMC_ACCESS_TEAM_DOMAIN ?? '').trim(),
    accessAud: (env.CMC_ACCESS_AUD ?? '').trim(),
    authToken: env.CMC_AUTH_TOKEN ?? '',
    trustProxy: env.CMC_TRUST_PROXY === '1',
    publicOrigin: normaliseOrigin(env.CMC_PUBLIC_ORIGIN),
    allowOpen: env.CMC_ALLOW_OPEN === '1',
    badge: badge || 'LAN tool',
    footerNote: clean(env.CMC_FOOTER_NOTE, 60) || badge || 'LAN only',
  };
}

export function normaliseOrigin(v: string | undefined): string {
  if (!v || !v.trim()) return '';
  try { const u = new URL(v.trim()); return u.origin; } catch { throw new Error('CMC_PUBLIC_ORIGIN must be an origin such as https://app.example.com'); }
}

/** Hosted-only (CMC_HOSTED=1). The local app never reads these variables. */
export const isLoopback = (host: string) => host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host);

/** Throws when the server would be reachable beyond this machine with no gate at all. */
export function assertSafeToStart(host: string, sec: Pick<SecurityConfig, 'accessTeamDomain' | 'accessAud' | 'authToken' | 'allowOpen'>) {
  const gated = !!(sec.accessTeamDomain && sec.accessAud) || !!sec.authToken;
  if ((!!sec.accessTeamDomain) !== (!!sec.accessAud)) throw new Error('CMC_ACCESS_TEAM_DOMAIN and CMC_ACCESS_AUD must be set together');
  if (!gated && !isLoopback(host) && !sec.allowOpen) {
    throw new Error(`Refusing to listen on ${host} with no authentication. Set CMC_AUTH_TOKEN and/or CMC_ACCESS_TEAM_DOMAIN + CMC_ACCESS_AUD, bind CMC_HOST to 127.0.0.1, or set CMC_ALLOW_OPEN=1 to accept the risk.`);
  }
}
