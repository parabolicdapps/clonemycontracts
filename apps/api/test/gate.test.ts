import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AccessDenied, AccessVerifier, assertSafeToStart, bearerMatches, securityFromEnv } from '../src/hosted/index.js';
import { ADDR, startApp } from './helpers.js';

const TEAM = 'acme.cloudflareaccess.com';
const AUD = 'aud-tag-123';
const NOW = 1_800_000_000_000;

function keypair(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(kp: { kid: string; privateKey: KeyObject }, claims: Record<string, unknown>, header: Record<string, unknown> = {}) {
  const data = `${b64({ alg: 'RS256', kid: kp.kid, typ: 'JWT', ...header })}.${b64(claims)}`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), kp.privateKey).toString('base64url')}`;
}
const good = (extra: Record<string, unknown> = {}) => ({ iss: `https://${TEAM}`, aud: [AUD], exp: NOW / 1000 + 600, nbf: NOW / 1000 - 10, email: 'Tester@Example.com', ...extra });

/** a fake team domain: serves the current key set, can be switched off */
function fakeJwks(initial: ReturnType<typeof keypair>[]) {
  const state = { keys: initial, up: true, calls: 0 };
  const fetchImpl = (async () => {
    state.calls++;
    if (!state.up) throw new Error('down');
    return new Response(JSON.stringify({ keys: state.keys.map((k) => k.jwk), public_cert: {} }), { status: 200 });
  }) as unknown as typeof fetch;
  return { state, fetchImpl };
}
const verifier = (j: ReturnType<typeof fakeJwks>) => new AccessVerifier({ teamDomain: TEAM, aud: AUD, fetchImpl: j.fetchImpl, now: () => NOW, minRefreshMs: 0 });

describe('Cloudflare Access JWT verification', () => {
  it('accepts a valid token and names the subject (person by email, service token by common_name)', async () => {
    const k = keypair('k1');
    const v = verifier(fakeJwks([k]));
    expect(await v.verify(jwt(k, good()))).toEqual({ subject: 'email:tester@example.com', email: 'tester@example.com' });
    const svc = await v.verify(jwt(k, good({ email: undefined, common_name: 'agent-1.access', sub: '' })));
    expect(svc).toMatchObject({ subject: 'svc:agent-1.access', commonName: 'agent-1.access' });
  });

  const cases: [string, (k: ReturnType<typeof keypair>) => string][] = [
    ['wrong audience', (k) => jwt(k, good({ aud: ['other'] }))],
    ['wrong issuer', (k) => jwt(k, good({ iss: 'https://evil.cloudflareaccess.com' }))],
    ['expired', (k) => jwt(k, good({ exp: NOW / 1000 - 600 }))],
    ['not yet valid', (k) => jwt(k, good({ nbf: NOW / 1000 + 600 }))],
    ['no exp', (k) => jwt(k, good({ exp: undefined }))],
    ['no subject', (k) => jwt(k, good({ email: undefined }))],
    ['alg none/HS256', (k) => jwt(k, good(), { alg: 'HS256' })],
    ['garbage', () => 'not.a.jwt'],
    ['empty', () => ''],
  ];
  for (const [name, make] of cases) {
    it(`rejects: ${name}`, async () => {
      const k = keypair('k1');
      await expect(verifier(fakeJwks([k])).verify(make(k))).rejects.toBeInstanceOf(AccessDenied);
    });
  }

  it('tolerates small clock skew on exp and nbf', async () => {
    const k = keypair('k1');
    const v = verifier(fakeJwks([k]));
    await expect(v.verify(jwt(k, good({ exp: NOW / 1000 - 30 })))).resolves.toBeTruthy();
    await expect(v.verify(jwt(k, good({ nbf: NOW / 1000 + 30 })))).resolves.toBeTruthy();
  });

  it('rejects a bad signature (token signed by another key under a known kid)', async () => {
    const k = keypair('k1');
    const evil = { ...keypair('k1') };
    await expect(verifier(fakeJwks([k])).verify(jwt(evil, good()))).rejects.toThrow('signature');
  });

  it('refreshes the key set on an unknown kid (key rotation), then accepts', async () => {
    const k1 = keypair('k1'); const k2 = keypair('k2');
    const j = fakeJwks([k1]);
    const v = verifier(j);
    await v.verify(jwt(k1, good()));
    j.state.keys = [k1, k2];
    await expect(v.verify(jwt(k2, good()))).resolves.toBeTruthy();
    expect(j.state.calls).toBe(2);
    // a kid that does not exist anywhere stays rejected
    await expect(v.verify(jwt(keypair('zz'), good()))).rejects.toThrow('unknown key');
  });

  it('does not hammer the team domain: refreshes are rate limited', async () => {
    const k = keypair('k1');
    const j = fakeJwks([k]);
    const v = new AccessVerifier({ teamDomain: TEAM, aud: AUD, fetchImpl: j.fetchImpl, now: () => NOW, minRefreshMs: 30_000 });
    await v.verify(jwt(k, good()));
    for (let i = 0; i < 5; i++) await expect(v.verify(jwt(keypair(`x${i}`), good()))).rejects.toBeInstanceOf(AccessDenied);
    expect(j.state.calls).toBe(1);
  });

  it('fails closed when the keys cannot be fetched and none are cached', async () => {
    const k = keypair('k1');
    const j = fakeJwks([k]);
    j.state.up = false;
    await expect(verifier(j).verify(jwt(k, good()))).rejects.toBeInstanceOf(AccessDenied);
  });

  it('keeps using cached keys when the team domain goes down later', async () => {
    const k = keypair('k1');
    const j = fakeJwks([k]);
    const v = verifier(j);
    await v.verify(jwt(k, good()));
    j.state.up = false;
    await expect(v.verify(jwt(k, good()))).resolves.toBeTruthy();
    await expect(v.verify(jwt(keypair('new'), good()))).rejects.toBeInstanceOf(AccessDenied);
  });

  it('rejects bad configuration', () => {
    expect(() => new AccessVerifier({ teamDomain: 'a/b', aud: 'x' })).toThrow();
    expect(() => new AccessVerifier({ teamDomain: TEAM, aud: ' ' })).toThrow();
    expect(new AccessVerifier({ teamDomain: `https://${TEAM}/`, aud: 'x' }).issuer).toBe(`https://${TEAM}`);
  });
});

describe('bearer token', () => {
  it('matches only the exact token', () => {
    expect(bearerMatches('Bearer s3cret', 's3cret')).toBe(true);
    expect(bearerMatches('bearer s3cret', 's3cret')).toBe(true);
    for (const h of [undefined, '', 'Bearer', 'Bearer s3cre', 'Bearer s3cretx', 's3cret', 'Basic s3cret', 'Bearer  s3cret x']) expect(bearerMatches(h, 's3cret'), String(h)).toBe(false);
  });
});

describe('refuse to start open', () => {
  const none = { accessTeamDomain: '', accessAud: '', authToken: '', allowOpen: false };
  it('loopback without gates is fine; a public bind without gates is refused', () => {
    expect(() => assertSafeToStart('127.0.0.1', none)).not.toThrow();
    expect(() => assertSafeToStart('localhost', none)).not.toThrow();
    expect(() => assertSafeToStart('0.0.0.0', none)).toThrow(/Refusing/);
    expect(() => assertSafeToStart('10.1.2.3', none)).toThrow(/CMC_ALLOW_OPEN/);
  });
  it('a gate or the explicit override allows it', () => {
    expect(() => assertSafeToStart('0.0.0.0', { ...none, authToken: 'x' })).not.toThrow();
    expect(() => assertSafeToStart('0.0.0.0', { ...none, accessTeamDomain: TEAM, accessAud: AUD })).not.toThrow();
    expect(() => assertSafeToStart('0.0.0.0', { ...none, allowOpen: true })).not.toThrow();
  });
  it('half an Access configuration is an error', () => {
    expect(() => assertSafeToStart('127.0.0.1', { ...none, accessTeamDomain: TEAM })).toThrow(/together/);
  });
  it('reads the environment', () => {
    const s = securityFromEnv({ CMC_BADGE: 'Private test', CMC_TRUST_PROXY: '1', CMC_PUBLIC_ORIGIN: 'https://app.example.test/', CMC_ALLOW_OPEN: '1' });
    expect(s).toMatchObject({ badge: 'Private test', footerNote: 'Private test', trustProxy: true, publicOrigin: 'https://app.example.test', allowOpen: true });
    expect(securityFromEnv({})).toMatchObject({ badge: 'LAN tool', footerNote: 'LAN only', trustProxy: false });
    expect(() => securityFromEnv({ CMC_PUBLIC_ORIGIN: 'nope' })).toThrow();
  });
});

describe('the gates on the server', () => {
  const dai = { address: ADDR.dai, from: 'eth', to: 'base-sepolia' };

  it('Access: every request needs a valid assertion; /healthz does not', async () => {
    const k = keypair('k1');
    const j = fakeJwks([k]);
    const t = await startApp({ access: verifier(j) });
    const tok = jwt(k, good());
    const H = { 'cf-access-jwt-assertion': tok };
    expect(await (await fetch(`${t.base}/healthz`)).text()).toBe('ok');
    for (const p of ['/', '/index.html', '/api/chains', '/api/config', '/api/jobs/00000000-0000-0000-0000-000000000000/events']) {
      const r = await fetch(t.base + p);
      expect(r.status, p).toBe(403);
      expect(await r.text()).toBe('Forbidden');
    }
    expect((await t.post('/api/inspect', dai)).status).toBe(403);
    expect((await fetch(`${t.base}/api/chains`, { headers: { 'cf-access-jwt-assertion': 'x.y.z' } })).status).toBe(403);
    expect((await fetch(`${t.base}/api/chains`, { headers: H })).status).toBe(200);
    expect((await fetch(`${t.base}/`, { headers: H })).status).toBe(200);
    await t.close();
  });

  it('Access: fails closed when the key service is down', async () => {
    const k = keypair('k1');
    const j = fakeJwks([k]);
    j.state.up = false;
    const t = await startApp({ access: verifier(j) });
    expect((await fetch(`${t.base}/api/chains`, { headers: { 'cf-access-jwt-assertion': jwt(k, good()) } })).status).toBe(403);
    await t.close();
  });

  it('Bearer: API calls need the token, pages and config do not, errors do not leak', async () => {
    const t = await startApp({ security: { authToken: 'tok-123' } });
    expect((await fetch(`${t.base}/`)).status).toBe(200);
    expect(await (await fetch(`${t.base}/api/config`)).json()).toMatchObject({ authRequired: true, badge: 'LAN tool' });
    const no = await fetch(`${t.base}/api/chains`);
    expect(no.status).toBe(401);
    expect(no.headers.get('www-authenticate')).toMatch(/Bearer/);
    expect((await no.json()).error.code).toBe('AUTH');
    expect((await fetch(`${t.base}/api/chains`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await fetch(`${t.base}/api/chains`, { headers: { authorization: 'Bearer tok-123' } })).status).toBe(200);
    expect((await t.post('/api/inspect', dai)).status).toBe(401);
    expect((await fetch(`${t.base}/api/jobs/00000000-0000-0000-0000-000000000000`)).status).toBe(401);
    await t.close();
  });

  it('both gates at once: each must pass', async () => {
    const k = keypair('k1');
    const t = await startApp({ access: verifier(fakeJwks([k])), security: { authToken: 'tok' } });
    const A = { 'cf-access-jwt-assertion': jwt(k, good()) };
    expect((await fetch(`${t.base}/api/chains`, { headers: A })).status).toBe(401);
    expect((await fetch(`${t.base}/api/chains`, { headers: { authorization: 'Bearer tok' } })).status).toBe(403);
    expect((await fetch(`${t.base}/api/chains`, { headers: { ...A, authorization: 'Bearer tok' } })).status).toBe(200);
    await t.close();
  });

  it('limits are keyed on the verified subject, not the (shared) address', async () => {
    const a = keypair('k1');
    const t = await startApp({ access: verifier(fakeJwks([a])), rateLimit: 3 });
    const as = (email: string) => ({ 'cf-access-jwt-assertion': jwt(a, good({ email })) });
    const hit = (email: string) => fetch(`${t.base}/api/chains`, { headers: as(email) }).then((r) => r.status);
    expect([await hit('a@x.io'), await hit('a@x.io'), await hit('a@x.io'), await hit('a@x.io')]).toEqual([200, 200, 200, 429]);
    expect(await hit('b@x.io')).toBe(200); // same 127.0.0.1, different person
    await t.close();
  });

  it('the proxy header never decides identity: spoofed Cf-Connecting-Ip / X-Forwarded-For do not change the limit bucket', async () => {
    const t = await startApp({ rateLimit: 2, security: { trustProxy: true } });
    const hit = (ip: string) => fetch(`${t.base}/api/chains`, { headers: { 'cf-connecting-ip': ip, 'x-forwarded-for': ip } }).then((r) => r.status);
    expect([await hit('1.1.1.1'), await hit('2.2.2.2'), await hit('3.3.3.3')]).toEqual([200, 200, 429]);
    await t.close();
  });

  it('one active rewrite per subject: the same person is refused, another person is not', async () => {
    const { runRewriteFake } = await import('./rewrite-fake.js');
    const a = keypair('k1');
    const t = await startApp({ access: verifier(fakeJwks([a])), rewrite: runRewriteFake(), maxRewritesPerDay: 0, rateLimit: 1000, rateLimitHeavy: 1000 });
    const H = (email: string) => ({ 'cf-access-jwt-assertion': jwt(a, good({ email })) });
    const dai = { address: ADDR.dai, from: 'eth', to: 'tezos', rights: true };
    expect((await t.post('/api/rewrite', dai, H('a@x.io'))).status).toBe(202);
    const again = await t.post('/api/rewrite', dai, H('a@x.io'));
    expect(again.status).toBe(429);
    expect((await again.json()).error.code).toBe('BUSY');
    expect((await t.post('/api/rewrite', dai, H('b@x.io'))).status).toBe(202);
    await t.app.shutdown(1000);
  });

  it('Origin: same host or the configured public origin; others are refused', async () => {
    const t = await startApp({ security: { publicOrigin: 'https://app.example.test' } });
    const body = { address: ADDR.dai, from: 'eth' };
    expect((await t.post('/api/inspect', body, { origin: 'https://app.example.test' })).status).toBe(200);
    expect((await t.post('/api/inspect', body, { origin: t.base })).status).toBe(200);
    expect((await t.post('/api/inspect', body, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await t.post('/api/inspect', body, { origin: 'http://app.example.test' })).status).toBe(403);
    await t.close();
  });

  it('https edge: HSTS and upgrade-insecure-requests; none without an https public origin', async () => {
    const s = await startApp({ security: { publicOrigin: 'https://app.example.test' } });
    const r = await fetch(`${s.base}/api/chains`);
    expect(r.headers.get('strict-transport-security')).toMatch(/max-age/);
    expect(r.headers.get('content-security-policy')).toContain('upgrade-insecure-requests');
    await s.close();
    const p = await startApp();
    const r2 = await fetch(`${p.base}/api/chains`);
    expect(r2.headers.get('strict-transport-security')).toBeNull();
    expect(r2.headers.get('content-security-policy')).not.toContain('upgrade-insecure-requests');
    await p.close();
  });

  it('/api/config serves the configured badge and footer (no inline script needed)', async () => {
    const t = await startApp({ security: { badge: 'Private test', footerNote: 'Private test' } });
    expect(await (await fetch(`${t.base}/api/config`)).json()).toEqual({ badge: 'Private test', footerNote: 'Private test', authRequired: false });
    await t.close();
  });

  it('logs every request, including fast authenticated GETs on a kept-alive connection', async () => {
    const lines: string[] = [];
    const t = await startApp({ log: (l) => lines.push(l), security: { authToken: 't' } });
    for (let i = 0; i < 25; i++) await (await fetch(`${t.base}/api/chains`, { headers: { authorization: 'Bearer t' } })).arrayBuffer();
    await new Promise((r) => setTimeout(r, 100));
    expect(lines).toHaveLength(25);
    await t.close();
  });

  it('writes one structured access line per request without query, token or body', async () => {
    const lines: string[] = [];
    const k = keypair('k1');
    const t = await startApp({ log: (l) => lines.push(l), access: verifier(fakeJwks([k])), security: { authToken: 'sekrit-token', trustProxy: true } });
    await fetch(`${t.base}/api/chains?x=secretquery`, { headers: { 'cf-access-jwt-assertion': jwt(k, good()), authorization: 'Bearer sekrit-token', 'cf-connecting-ip': '203.0.113.9' } });
    await fetch(`${t.base}/api/chains`);
    await new Promise((r) => setTimeout(r, 50));
    expect(lines).toHaveLength(2);
    const l = JSON.parse(lines[0]!);
    expect(l).toMatchObject({ sub: 'email:tester@example.com', ip: '203.0.113.9', m: 'GET', p: '/api/chains', s: 200 });
    expect(typeof l.ms).toBe('number');
    expect(JSON.parse(lines[1]!)).toMatchObject({ sub: null, s: 403 });
    expect(lines.join('\n')).not.toMatch(/sekrit|secretquery|eyJ/);
    await t.close();
  });
});

describe('caps and shutdown', () => {
  it('limits rewrites per subject per day', async () => {
    const { runRewriteFake } = await import('./rewrite-fake.js');
    const t = await startApp({ rewrite: runRewriteFake(), maxRewritesPerDay: 2, rateLimit: 1000, rateLimitHeavy: 1000, clientKey: () => 'one' });
    const dai = { address: ADDR.dai, from: 'eth', to: 'tezos', rights: true };
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await t.post('/api/rewrite', dai);
      expect(r.status).toBe(202);
      ids.push((await r.json()).jobId);
      await t.app.jobs.cancel(ids[i]!, 'one');
      await new Promise((r) => setTimeout(r, 60));
    }
    const third = await t.post('/api/rewrite', dai);
    expect(third.status).toBe(429);
    expect((await third.json()).error.code).toBe('DAILY_LIMIT');
    await t.close();
  });

  it('caps the global queue and cancels queued jobs and aborts running ones on shutdown', async () => {
    const { runRewriteFake } = await import('./rewrite-fake.js');
    const t = await startApp({ rewrite: runRewriteFake(), maxQueued: 1, maxRewritesPerDay: 0, rateLimit: 1000, rateLimitHeavy: 1000, clientKey: (req) => String(req.headers['x-c'] ?? 'x') });
    const dai = { address: ADDR.dai, from: 'eth', to: 'tezos', rights: true };
    const a = await (await t.post('/api/rewrite', dai, { 'x-c': '1' })).json(); // runs
    const b = await t.post('/api/rewrite', dai, { 'x-c': '2' }); // queued (1 allowed)
    expect(b.status).toBe(202);
    const c = await t.post('/api/rewrite', dai, { 'x-c': '3' });
    expect(c.status).toBe(429);
    expect((await c.json()).error.code).toBe('BUSY');
    await new Promise((r) => setTimeout(r, 100));
    await t.app.shutdown(2000);
    expect(t.app.jobs.get(a.jobId)!.status).toBe('cancelled');
    expect(t.app.jobs.get((await b.json()).jobId)!.status).toBe('cancelled');
  });
});

describe('server entry point', () => {
  const main = new URL('../dist/main.js', import.meta.url).pathname;
  it('hosted mode (CMC_HOSTED=1) still refuses to listen open on a non-loopback address', () => {
    const r = spawnSync(process.execPath, [main], { env: { PATH: process.env.PATH, CMC_HOSTED: '1', CMC_HOST: '0.0.0.0', CMC_PORT: '0' }, encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Refusing to listen/);
  });
});
