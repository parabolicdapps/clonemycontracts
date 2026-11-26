import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { LocalGuard } from '../src/local.js';
import { createSecretStore, FileSecretStore, MemorySecretStore, ShellSecretStore } from '../src/secrets.js';
import type { RuntimeService } from '../src/runtime-service.js';
import { startApp } from './helpers.js';

const TOKEN = 'T'.repeat(64);
const AUTH = { authorization: `Bearer ${TOKEN}` };

/** raw http so Host and Origin can be set freely */
function raw(base: string, path: string, headers: Record<string, string> = {}, method = 'GET', body?: string): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const r = request({ host: u.hostname, port: u.port, path, method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      let t = ''; res.on('data', (d) => (t += d)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text: t }));
    });
    r.on('error', reject); r.end(body);
  });
}
const local = (o: ConstructorParameters<typeof LocalGuard>[0] = {}) => startApp({ guard: new LocalGuard({ token: TOKEN, ...o }) });
const port = (base: string) => new URL(base).port;

describe('local security: token, Host, Origin', () => {
  it('every request needs the launch token; the static page and /healthz are not exempt', async () => {
    const t = await local();
    for (const p of ['/', '/index.html', '/healthz', '/api/chains', '/api/config', '/api/settings']) expect((await raw(t.base, p)).status, p).toBe(401);
    expect((await raw(t.base, '/api/chains', { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await raw(t.base, '/api/chains', { authorization: `Bearer ${TOKEN.slice(0, -1)}` })).status).toBe(401);
    for (const p of ['/', '/healthz', '/api/chains', '/api/config']) expect((await raw(t.base, p, AUTH)).status, p).toBe(200);
    expect((await raw(t.base, '/api/config', AUTH)).text).toContain('"badge":"Local"');
    await t.close();
  });
  it('rejects a wrong Host (DNS rebinding) even with the token', async () => {
    const t = await local();
    for (const h of ['evil.example', `evil.example:${port(t.base)}`, '127.0.0.1', `127.0.0.1:${Number(port(t.base)) + 1}`, `localhost.evil.com:${port(t.base)}`, '203.0.113.7:80']) {
      expect((await raw(t.base, '/api/chains', { ...AUTH, host: h })).status, h).toBe(403);
    }
    expect((await raw(t.base, '/api/chains', { ...AUTH, host: `localhost:${port(t.base)}` })).status).toBe(200);
    expect((await raw(t.base, '/api/chains', { ...AUTH, host: `127.0.0.1:${port(t.base)}` })).status).toBe(200);
    await t.close();
  });
  it('rejects a foreign or null Origin on any method; accepts the app\'s own', async () => {
    const t = await local();
    for (const o of ['https://evil.example', 'null', `http://127.0.0.1:${Number(port(t.base)) + 1}`, 'http://localhost']) {
      expect((await raw(t.base, '/api/chains', { ...AUTH, origin: o })).status, o).toBe(403);
      expect((await raw(t.base, '/api/inspect', { ...AUTH, origin: o }, 'POST', '{}')).status, o).toBe(403);
    }
    expect((await raw(t.base, '/api/chains', { ...AUTH, origin: `http://127.0.0.1:${port(t.base)}` })).status).toBe(200);
    expect((await raw(t.base, '/api/chains', { ...AUTH, origin: `http://localhost:${port(t.base)}` })).status).toBe(200);
    await t.close();
  });
  it('keeps the strict CSP and security headers', async () => {
    const t = await local();
    const r = await raw(t.base, '/', AUTH);
    expect(r.headers['content-security-policy']).toContain("script-src 'self'");
    expect(r.headers['content-security-policy']).toContain("require-trusted-types-for 'script'");
    expect(r.headers['x-frame-options']).toBe('DENY');
    await t.close();
  });
});

describe('browser session: one-time code -> HttpOnly SameSite=Strict cookie', () => {
  it('mints a code only with the token, exchanges it once, and the cookie then works', async () => {
    const t = await local();
    expect((await raw(t.base, '/api/auth/code', {}, 'POST', '{}')).status).toBe(401);
    const m = await raw(t.base, '/api/auth/code', AUTH, 'POST', '{}');
    expect(m.status).toBe(200);
    const { code } = JSON.parse(m.text);
    expect(code).toMatch(/^[0-9a-f]{32}$/);
    expect(code).not.toContain(TOKEN);
    const x = await raw(t.base, `/auth/exchange?code=${code}`);
    expect(x.status).toBe(302);
    expect(x.headers.location).toBe('/');
    const cookie = String(x.headers['set-cookie']);
    expect(cookie).toMatch(/^cmc_session=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/$/);
    expect(cookie).not.toContain(TOKEN);
    const c = { cookie: cookie.split(';')[0]! };
    expect((await raw(t.base, '/api/chains', c)).status).toBe(200);
    expect((await raw(t.base, '/', c)).status).toBe(200);
    // single use
    expect((await raw(t.base, `/auth/exchange?code=${code}`)).status).toBe(403);
    // a made-up cookie is not a session
    expect((await raw(t.base, '/api/chains', { cookie: 'cmc_session=' + 'a'.repeat(64) })).status).toBe(401);
    // a cookie cannot mint more codes
    expect((await raw(t.base, '/api/auth/code', { ...c, origin: `http://127.0.0.1:${port(t.base)}` }, 'POST', '{}')).status).toBe(403);
    await t.close();
  });
  it('cookie-authenticated writes must be same-origin', async () => {
    const t = await local();
    const { code } = JSON.parse((await raw(t.base, '/api/auth/code', AUTH, 'POST', '{}')).text);
    const c = { cookie: String((await raw(t.base, `/auth/exchange?code=${code}`)).headers['set-cookie']).split(';')[0]! };
    const body = JSON.stringify({ address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', from: 'eth' });
    expect((await raw(t.base, '/api/inspect', c, 'POST', body)).status).toBe(403); // no Origin, no Sec-Fetch-Site
    expect((await raw(t.base, '/api/inspect', { ...c, origin: 'https://evil.example' }, 'POST', body)).status).toBe(403);
    expect((await raw(t.base, '/api/inspect', { ...c, origin: `http://127.0.0.1:${port(t.base)}` }, 'POST', body)).status).toBe(200);
    expect((await raw(t.base, '/api/inspect', { ...c, 'sec-fetch-site': 'same-origin' }, 'POST', body)).status).toBe(200);
    await t.close();
  });
  it('codes expire after 30 s; repeated bad codes are throttled', async () => {
    let now = 1_000_000;
    const t = await local({ now: () => now });
    const { code } = JSON.parse((await raw(t.base, '/api/auth/code', AUTH, 'POST', '{}')).text);
    now += 31_000;
    expect((await raw(t.base, `/auth/exchange?code=${code}`)).status).toBe(403);
    for (let i = 0; i < 12; i++) await raw(t.base, '/auth/exchange?code=nope');
    expect((await raw(t.base, '/auth/exchange?code=nope')).status).toBe(429);
    await t.close();
  });
});

describe('secret stores', () => {
  it('file store: 0600 file in a 0700 directory, with the unencrypted notice', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'cmc-sec-')), 'cfg');
    const s = new FileSecretStore(dir);
    expect(s.notice).toMatch(/unencrypted/i);
    await s.set('provider:openai', 'sk-test-12345678');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(s.path).mode & 0o777).toBe(0o600);
    expect(await s.get('provider:openai')).toBe('sk-test-12345678');
    expect(await s.has('provider:gemini')).toBe(false);
    await s.delete('provider:openai');
    expect(await s.has('provider:openai')).toBe(false);
    await expect(s.set('../evil', 'x')).rejects.toThrow();
  });
  it('shell store: loads keys from stdin lines and reports changes on the output channel', async () => {
    const inp = new PassThrough(), out = new PassThrough();
    let written = '';
    out.on('data', (d) => (written += d));
    const s = new ShellSecretStore(inp, out);
    inp.write(`${JSON.stringify({ type: 'secrets', values: { 'provider:anthropic': 'sk-ant-xxxxxxxx' } })}\nnot json\n`);
    await new Promise((r) => setTimeout(r, 30));
    expect(await s.get('provider:anthropic')).toBe('sk-ant-xxxxxxxx');
    expect(s.kind).toBe('shell');
    await s.set('provider:openai', 'sk-abcdefgh');
    await s.delete('provider:anthropic');
    await new Promise((r) => setTimeout(r, 10));
    const lines = written.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([{ type: 'secret-set', id: 'provider:openai', value: 'sk-abcdefgh' }, { type: 'secret-delete', id: 'provider:anthropic' }]);
    expect(await s.has('provider:anthropic')).toBe(false);
  });
  it('shell store: an empty value or secret-delete removes the key', async () => {
    const inp = new PassThrough(), out = new PassThrough();
    const s = new ShellSecretStore(inp, out);
    const send = async (o: unknown) => { inp.write(`${JSON.stringify(o)}\n`); await new Promise((r) => setTimeout(r, 20)); };
    await send({ type: 'secrets', values: { 'provider:openai': 'sk-abcdefgh', 'provider:anthropic': 'sk-ant-xxxxxxxx' } });
    expect(await s.has('provider:openai')).toBe(true);
    await send({ type: 'secret', id: 'provider:openai', value: '' });
    expect(await s.has('provider:openai')).toBe(false);
    expect(await s.get('provider:openai')).toBeUndefined();
    await send({ type: 'secret-delete', id: 'provider:anthropic' });
    expect(await s.has('provider:anthropic')).toBe(false);
  });
  it('selection: explicit, linux without secret-tool -> file, linux with it -> libsecret, macOS -> memory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmc-sel-'));
    const bin = mkdtempSync(join(tmpdir(), 'cmc-bin-'));
    expect(createSecretStore({ env: { CMC_SECRET_STORE: 'memory' }, configDir: dir }).kind).toBe('memory');
    expect(createSecretStore({ env: { PATH: bin }, platform: 'linux', configDir: dir }).kind).toBe('file');
    writeFileSync(join(bin, 'secret-tool'), '#!/bin/sh\n'); chmodSync(join(bin, 'secret-tool'), 0o755);
    expect(createSecretStore({ env: { PATH: bin }, platform: 'linux', configDir: dir }).kind).toBe('libsecret');
    expect(createSecretStore({ env: {}, platform: 'darwin', configDir: dir }).kind).toBe('memory');
    expect(createSecretStore({ env: { CMC_SECRET_STORE: 'shell' }, configDir: dir, stdin: new PassThrough(), stdout: new PassThrough() }).kind).toBe('shell');
    expect(() => createSecretStore({ env: { CMC_SECRET_STORE: 'vault' }, configDir: dir })).toThrow();
  });
  it('libsecret store passes the value on stdin, never in argv (fake secret-tool)', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'cmc-st-'));
    const log = join(bin, 'log.txt'), data = join(bin, 'data.txt');
    writeFileSync(join(bin, 'secret-tool'), `#!/bin/bash
echo "$@" >> "${log}"
case "$1" in store) cat > "${data}";; lookup) cat "${data}" 2>/dev/null || exit 1;; clear) rm -f "${data}";; esac
`);
    chmodSync(join(bin, 'secret-tool'), 0o755);
    const { LibsecretStore } = await import('../src/secrets.js');
    const s = new LibsecretStore(join(bin, 'secret-tool'));
    await s.set('provider:openai', 'sk-supersecret-1');
    expect(await s.get('provider:openai')).toBe('sk-supersecret-1');
    expect(readFileSync(log, 'utf8')).not.toContain('supersecret');
    await s.delete('provider:openai');
    expect(await s.has('provider:openai')).toBe(false);
  });
});

// A local OpenAI-compatible server for "test connection".
const mock = createServer((req, res) => {
  if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return void res.end(JSON.stringify({ data: [{ id: 'local-a' }] })); }
  res.writeHead(404); res.end();
});
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
const mockUrl = `http://127.0.0.1:${(mock.address() as { port: number }).port}/v1`;
import { afterAll } from 'vitest';
afterAll(() => mock.close());

const fakeRuntime = (): RuntimeService & { pulled: string[] } => {
  const present = new Set<string>();
  const pulled: string[] = [];
  const status = { state: 'ready' as const, kind: 'docker' as const, binary: '/x/docker', version: '27', dockerHost: null, rootless: false, selinuxEnforcing: false, limits: { cpus: true, memory: true, pids: true, note: '' }, message: 'Docker 27 is ready.', guidance: [] };
  return {
    pulled,
    async snapshot() { return { status, images: ['solana', 'cosmwasm', 'aptos', 'tezos'].map((target) => ({ target, image: `ghcr.io/parabolicdapps/cmc-toolchain-${target}:0.2`, present: present.has(target) })) }; },
    async pull(image, onProgress) { pulled.push(image); onProgress({ line: 'abc: Pull complete', layersTotal: 1, layersDone: 1 }); present.add(/toolchain-(\w+):/.exec(image)![1]!); return { ok: true, message: 'Downloaded.' }; },
  };
};

describe('settings and runtime API (under the local guard)', () => {
  const get = (t: { base: string }, p: string) => raw(t.base, p, AUTH);
  const post = (t: { base: string }, p: string, b: unknown) => raw(t.base, p, AUTH, 'POST', JSON.stringify(b));

  it('stores a key without ever returning it, writes no key to settings.json, and tests the connection', async () => {
    const rt = fakeRuntime();
    const t = await startApp({ guard: new LocalGuard({ token: TOKEN }), runtime: rt });
    const KEY = 'sk-test-SECRETKEY-0123456789';
    const r = await post(t, '/api/settings/provider/openai', { config: { model: 'gpt-6-luna' }, key: KEY });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('SECRETKEY');
    const v = JSON.parse(r.text);
    expect(v.active).toBe('openai');
    expect(v.providers.find((p: any) => p.id === 'openai')).toMatchObject({ hasKey: true, configured: true, settings: { model: 'gpt-6-luna' } });
    expect(v.secretStore.kind).toBe('memory');
    expect(v.ack).toMatchObject({ needed: true });
    expect((await get(t, '/api/settings')).text).not.toContain('SECRETKEY');
    expect(readFileSync(join(t.settings.paths.config, 'settings.json'), 'utf8')).not.toContain('SECRETKEY');
    expect(await t.settings.secrets.get('provider:openai')).toBe(KEY);
    // bad input is a 400, not a stored value
    expect((await post(t, '/api/settings/provider/openai', { config: { model: 'm' }, key: 'short' })).status).toBe(400);
    expect((await post(t, '/api/settings/provider/openai', { config: { model: 'm', baseUrl: 'http://evil/' } })).status).toBe(400);
    expect((await post(t, '/api/settings/provider/bogus', { config: { model: 'm' } })).status).toBe(400);
    // custom provider: test connection against the mock, with an unsaved draft
    const ok = JSON.parse((await post(t, '/api/settings/test/custom', { config: { model: 'local-a', baseUrl: mockUrl } })).text);
    expect(ok).toMatchObject({ ok: true, modelListed: true, models: ['local-a'] });
    const wrong = JSON.parse((await post(t, '/api/settings/test/custom', { config: { model: 'nope', baseUrl: mockUrl } })).text);
    expect(wrong.message).toMatch(/not in that list/);
    const dead = JSON.parse((await post(t, '/api/settings/test/custom', { config: { model: 'm', baseUrl: 'http://127.0.0.1:1/v1' } })).text);
    expect(dead.ok).toBe(false);
    expect(dead.message).toMatch(/Could not reach/);
    // active provider can only be one that is set up
    expect((await post(t, '/api/settings/active', { provider: 'gemini' })).status).toBe(400);
    expect((await post(t, '/api/settings/active', { provider: 'openai' })).status).toBe(200);
    await t.close();
  });

  it('the Claude Code connector is off by default and needs an explicit switch; acknowledgement is versioned', async () => {
    const t = await startApp({ guard: new LocalGuard({ token: TOKEN }), runtime: fakeRuntime() });
    let v = JSON.parse((await get(t, '/api/settings')).text);
    expect(v.claudeCli.enabled).toBe(false);
    expect(v.providers.find((p: any) => p.id === 'claude-cli')).toMatchObject({ experimental: true, configured: false });
    expect((await post(t, '/api/settings/active', { provider: 'claude-cli' })).status).toBe(400);
    expect((await post(t, '/api/settings/claude-cli', { enabled: true, binary: 'relative/claude' })).status).toBe(400);
    v = JSON.parse((await post(t, '/api/settings/claude-cli', { enabled: true, model: 'haiku' })).text);
    expect(v.claudeCli.enabled).toBe(true);
    expect((await post(t, '/api/settings/active', { provider: 'claude-cli' })).status).toBe(200);
    v = JSON.parse((await post(t, '/api/settings/claude-cli', { enabled: false })).text);
    expect(v.active).toBeNull();
    expect((await post(t, '/api/settings/ack', { version: 99 })).status).toBe(400);
    v = JSON.parse((await post(t, '/api/settings/ack', { version: v.ack.current })).text);
    expect(v.ack.needed).toBe(false);
    await t.close();
  });

  it('runtime status, and a first-run image download with progress events', async () => {
    const rt = fakeRuntime();
    const t = await startApp({ guard: new LocalGuard({ token: TOKEN }), runtime: rt });
    const s = JSON.parse((await get(t, '/api/runtime')).text);
    expect(s.status).toMatchObject({ state: 'ready', version: '27' });
    expect(s.images.every((i: any) => !i.present)).toBe(true);
    const p = JSON.parse((await post(t, '/api/runtime/pull', { targets: ['solana', 'tezos', 'not-a-target'] })).text);
    expect(p.targets.map((x: any) => x.target)).toEqual(['solana', 'tezos']);
    const ev = await get(t, `/api/runtime/pull/${p.pullId}/events`);
    expect(ev.text).toMatch(/event: done/);
    expect(rt.pulled).toEqual(['ghcr.io/parabolicdapps/cmc-toolchain-solana:0.2', 'ghcr.io/parabolicdapps/cmc-toolchain-tezos:0.2']);
    const after = JSON.parse((await post(t, '/api/runtime/check', {})).text);
    expect(after.images.filter((i: any) => i.present).map((i: any) => i.target)).toEqual(['solana', 'tezos']);
    expect((await get(t, '/api/runtime/pull/00000000-0000-0000-0000-000000000000/events')).status).toBe(404);
    await t.close();
  });
});
