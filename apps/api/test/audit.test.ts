import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADDR, fakeSim, fixtureBackend, startApp } from './helpers.js';
import type { Backend } from '../src/backend.js';
import { apiText } from '../src/surface.js';
import { runRewriteFake } from './rewrite-fake.js';

let t: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => { t = await startApp({ rateLimit: 10000, rateLimitHeavy: 10000, maxSimulations: 4 }); });
afterAll(async () => { await t.close(); });

const dai = { address: ADDR.dai, from: 'eth', to: 'base' };
const getJob = async (base: string, id: string) => (await (await fetch(`${base}/api/jobs/${id}`)).json()).job;
async function waitFor(base: string, id: string, status: string[], ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const j = await getJob(base, id);
    if (status.includes(j.status)) return j;
    if (Date.now() > end) throw new Error(`job stays ${j.status}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const del = (base: string, id: string) => fetch(`${base}/api/jobs/${id}`, { method: 'DELETE' });

/** A Vyper contract, as Sourcify would report 0.2.4. */
const vyper = (): Partial<Backend> => ({ analyse: async (a, c) => { const x = await fixtureBackend().analyse(a, c); x.contract = { ...x.contract, language: 'Vyper', compilerVersion: '0.2.4' }; x.unsupported = ['Vyper 0.2.4 contracts are not supported in v1 (Solidity only)']; return x; } });

describe('finding 1: simulate jobs can be cancelled', () => {
  it('cancels a running simulation: aborts the pipeline, frees the slot, is idempotent, and a finished job is a 409', async () => {
    let seenSignal: AbortSignal | undefined;
    let stopped = false;
    const t2 = await startApp({
      rateLimit: 1000, rateLimitHeavy: 1000, maxSimulations: 1,
      backend: fixtureBackend({ simulate: (_p, onProgress, signal) => new Promise((_res, rej) => { seenSignal = signal; onProgress('forked fake chain'); signal!.addEventListener('abort', () => { stopped = true; rej(new Error('anvil killed')); }); }) }),
    });
    const { jobId } = await (await t2.post('/api/simulate', dai)).json();
    await waitFor(t2.base, jobId, ['running']);
    await new Promise((r) => setTimeout(r, 150));
    const r = await del(t2.base, jobId);
    expect(r.status).toBe(200);
    expect((await r.json()).job.status).toBe('cancelled');
    expect(stopped).toBe(true);
    expect(seenSignal!.aborted).toBe(true);
    // idempotent
    const again = await del(t2.base, jobId);
    expect(again.status).toBe(200);
    expect((await again.json()).job.status).toBe('cancelled');
    // the slot is free again: a second simulation starts (maxSimulations is 1)
    t2.app.jobs.shutdown(0).catch(() => undefined);
    await t2.close();
  });

  it('frees the slot for the next job', async () => {
    let n = 0;
    const t2 = await startApp({
      rateLimit: 1000, rateLimitHeavy: 1000, maxSimulations: 1,
      backend: fixtureBackend({ simulate: (_p, _o, signal) => new Promise((res, rej) => { n++; if (n > 1) return res(fakeSim()); signal!.addEventListener('abort', () => rej(new Error('killed'))); }) }),
    });
    const a = (await (await t2.post('/api/simulate', dai)).json()).jobId;
    await waitFor(t2.base, a, ['running']);
    const b = (await (await t2.post('/api/simulate', { ...dai, to: 'arbitrum' })).json()).jobId;
    expect((await getJob(t2.base, b)).status).toBe('queued');
    await del(t2.base, a);
    const done = await waitFor(t2.base, b, ['done', 'failed']);
    expect(done.status).toBe('done');
    await t2.close();
  });

  it('cancels a queued simulation, and says 409 for a finished one with its final status', async () => {
    const t2 = await startApp({ rateLimit: 1000, rateLimitHeavy: 1000, maxSimulations: 1, backend: fixtureBackend({ simulate: (_p, _o, signal) => new Promise((_r, rej) => signal!.addEventListener('abort', () => rej(new Error('x')))) }) });
    const a = (await (await t2.post('/api/simulate', dai)).json()).jobId;
    await waitFor(t2.base, a, ['running']);
    const b = (await (await t2.post('/api/simulate', { ...dai, to: 'arbitrum' })).json()).jobId;
    const r = await del(t2.base, b);
    expect(r.status).toBe(200);
    expect((await r.json()).job.status).toBe('cancelled');
    await del(t2.base, a);
    await t2.close();

    const t3 = await startApp({ rateLimit: 1000, rateLimitHeavy: 1000 });
    const id = (await (await t3.post('/api/simulate', dai)).json()).jobId;
    await waitFor(t3.base, id, ['done']);
    const f = await del(t3.base, id);
    expect(f.status).toBe(409);
    const body = await f.json();
    expect(body.error.code).toBe('FINISHED');
    expect(body.error.message).toMatch(/already finished \(done\)/);
    expect(body.status).toBe('done');
    expect(body.job.status).toBe('done');
    await t3.close();
  });

  it('cancels an inspect job; a SSE listener of a cancelled job ends with a done event', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t2 = await startApp({ rateLimit: 1000, rateLimitHeavy: 1000, backend: fixtureBackend({ analyse: async (a, c) => { await gate; return fixtureBackend().analyse(a, c); } }) });
    const { jobId } = await (await t2.post('/api/inspect-job', { address: ADDR.dai, from: 'eth' })).json();
    expect((await del(t2.base, jobId)).status).toBe(200);
    release();
    await new Promise((r) => setTimeout(r, 100));
    const j = await getJob(t2.base, jobId);
    expect(j.status).toBe('cancelled');
    expect(j.result).toBeUndefined();
    const sse = await (await fetch(`${t2.base}/api/jobs/${jobId}/events`)).text();
    expect(sse).toMatch(/event: done\ndata: {"status":"cancelled"/);
    await t2.close();
  });
});

describe('finding 2: files of every job kind that has a project', () => {
  it('a finished simulate job lists and serves its project files, like project.zip', async () => {
    const { jobId } = await (await t.post('/api/simulate', dai)).json();
    const j = await waitFor(t.base, jobId, ['done']);
    expect(j.result.hasProject).toBe(true);
    expect((await fetch(`${t.base}/api/jobs/${jobId}/project.zip`)).status).toBe(200);
    const files = (await (await fetch(`${t.base}/api/jobs/${jobId}/files`)).json()).files as { path: string; size: number }[];
    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining(['plan.json', 'report.md', 'README.md', 'deploy.sh', 'contracts/contract/foundry.toml', 'contracts/contract/src/dai.sol']));
    const f = await (await fetch(`${t.base}/api/jobs/${jobId}/file?path=report.md`)).json();
    expect(f.content).toMatch(/^# Clone report: Dai/);
    const toml = await (await fetch(`${t.base}/api/jobs/${jobId}/file?path=contracts/contract/foundry.toml`)).json();
    expect(toml.content).toContain('solc = "0.5.12"');
  });
  it('project jobs too; traversal is refused; a job with no project is 404 and says hasProject false', async () => {
    const { jobId } = await (await t.post('/api/project', dai)).json();
    await waitFor(t.base, jobId, ['done']);
    expect((await fetch(`${t.base}/api/jobs/${jobId}/files`)).status).toBe(200);
    for (const bad of ['../plan.json', '..%2f..%2fetc%2fpasswd', 'a//b', '.']) expect((await fetch(`${t.base}/api/jobs/${jobId}/file?path=${bad}`)).status).toBe(400);
    expect((await fetch(`${t.base}/api/jobs/${jobId}/file?path=nope.txt`)).status).toBe(404);
    const ins = (await (await t.post('/api/inspect-job', { address: ADDR.dai, from: 'eth' })).json()).jobId;
    const ij = await waitFor(t.base, ins, ['done']);
    expect(ij.result.hasProject).toBe(false);
    expect((await fetch(`${t.base}/api/jobs/${ins}/files`)).status).toBe(404);
  });
  it('hasProject is false when the folder is gone', async () => {
    const { jobId } = await (await t.post('/api/project', dai)).json();
    await waitFor(t.base, jobId, ['done']);
    const { rm } = await import('node:fs/promises');
    await rm(t.app.jobs.projectDir(jobId), { recursive: true, force: true });
    expect((await getJob(t.base, jobId)).result.hasProject).toBe(false);
    expect((await fetch(`${t.base}/api/jobs/${jobId}/project.zip`)).status).toBe(404);
  });
});

describe('finding 3: licences in the summary', () => {
  it('shows a licence per contract and the most restrictive overall; the gate and warnings follow it', async () => {
    const be = fixtureBackend({
      analyse: async (a, c) => {
        const x = await fixtureBackend().analyse(a, c);
        // a permissive proxy over a BUSL implementation (EigenPodManager's shape)
        x.license = { id: 'MIT', class: 'permissive', ids: ['MIT'] };
        x.proxy = { isProxy: true, type: 'EIP-1967', implementations: [x.contract.address] };
        x.implementation = { ...structuredClone(x), implementation: null, license: { id: 'BUSL-1.1', class: 'restricted', ids: ['BUSL-1.1', 'MIT'] }, warnings: ['Source is BUSL-1.1: a restricted/source-available licence. You need the rights holder\'s permission to deploy a clone (e.g. BUSL usually forbids production use).'] };
        return x;
      },
    });
    const t2 = await startApp({ rateLimit: 1000, rateLimitHeavy: 1000, backend: be });
    const j = await (await t2.post('/api/inspect', { address: ADDR.dai, from: 'eth' })).json();
    expect(j.summary.license).toMatchObject({ id: 'BUSL-1.1', class: 'restricted', all: ['MIT', 'BUSL-1.1'] });
    expect(j.summary.licenses.map((l: any) => [l.role, l.id])).toEqual([['proxy', 'MIT'], ['implementation', 'BUSL-1.1']]);
    expect(j.summary.licenseGate).toBe(true);
    expect(j.summary.warnings.filter((w: string) => /BUSL-1\.1/.test(w))).toHaveLength(1);
    expect(j.summary.warnings.join('\n')).toMatch(/Dai \(implementation\): Source is BUSL-1.1/);
    await t2.close();
  });
  it('detects MIT on Dai and copyleft header text (AGPL-3.0), not "none"', async () => {
    const j = await (await t.post('/api/inspect', { address: ADDR.dai, from: 'eth' })).json();
    expect(j.summary.license).toMatchObject({ class: 'permissive', id: 'MIT' });
    expect(j.summary.licenses[0]).toMatchObject({ role: 'contract', name: 'Dai' });
    const { analyseContract } = await import('@cmc/core');
    const be = fixtureBackend({
      analyse: async (a, c) => {
        const x = await fixtureBackend().analyse(a, c);
        const mod = structuredClone(x.contract);
        const [k] = Object.keys(mod.stdJsonInput.sources);
        mod.stdJsonInput.sources[k!] = { content: '// GNU Affero General Public License, version 3\npragma solidity 0.5.12; contract Dai {}' };
        mod.license = null;
        return analyseContract(mod, { reader: null });
      },
    });
    const t2 = await startApp({ rateLimit: 1000, rateLimitHeavy: 1000, backend: be });
    const j2 = await (await t2.post('/api/inspect', { address: ADDR.dai, from: 'eth' })).json();
    expect(j2.summary.license).toMatchObject({ class: 'copyleft', id: 'AGPL-3.0' });
    expect(j2.summary.licenses[0]).toMatchObject({ role: 'contract', name: 'Dai' });
    await t2.close();
  });
});

describe('finding 4: one rule for unsupported targets and sources', () => {
  const bodies = (to: string) => ({ ...dai, to });
  it('zkSync target: the same 422 UNSUPPORTED and message on plan, simulate, deploy-payload and project', async () => {
    const msgs = new Set<string>();
    for (const p of ['/api/plan', '/api/simulate', '/api/deploy-payload', '/api/project']) {
      const r = await t.post(p, bodies('zksync'));
      expect(r.status, p).toBe(422);
      const e = (await r.json()).error;
      expect(e.code).toBe('UNSUPPORTED');
      msgs.add(e.message);
    }
    expect([...msgs]).toHaveLength(1);
    expect([...msgs][0]).toMatch(/zkSync .*not supported/);
  });
  it('Vyper source: the same 422 everywhere (no doomed job), named as Vyper, not solc', async () => {
    const t2 = await startApp({ rateLimit: 1000, rateLimitHeavy: 1000, backend: fixtureBackend(vyper()) });
    const msgs = new Set<string>();
    for (const p of ['/api/plan', '/api/simulate', '/api/deploy-payload', '/api/project']) {
      const r = await t2.post(p, dai);
      expect(r.status, p).toBe(422);
      msgs.add((await r.json()).error.message);
    }
    expect([...msgs]).toHaveLength(1);
    expect([...msgs][0]).toMatch(/Vyper 0\.2\.4/);
    expect([...msgs][0]).not.toMatch(/solc 0\.2\.4/);
    expect((await t2.post('/api/rewrite', { ...dai, to: 'tezos', rights: true })).status).toBe(422);
    const ins = await (await t2.post('/api/inspect', { address: ADDR.dai, from: 'eth' })).json();
    expect(ins.summary.compiler).toBe('Vyper 0.2.4');
    expect(ins.summary.language).toBe('Vyper');
    expect(t2.app.jobs['jobs'].size).toBe(0);
    await t2.close();
  });
  it('zkSync as the source of inspect is the same message', async () => {
    const r = await t.post('/api/inspect', { address: ADDR.dai, from: 'zksync' });
    expect(r.status).toBe(422);
    expect((await r.json()).error.message).toMatch(/zkSync .*not supported/);
  });
});

describe('minor: same chain, validation shape, surface wording', () => {
  it('eth -> eth is a 400 on plan, simulate, deploy-payload and project', async () => {
    for (const p of ['/api/plan', '/api/simulate', '/api/deploy-payload', '/api/project']) {
      const r = await t.post(p, { ...dai, to: 'eth' });
      expect(r.status, p).toBe(400);
      const e = (await r.json()).error;
      expect(e.code).toBe('INPUT');
      expect(e.message).toMatch(/from and to must be different/);
      expect(e.fields).toEqual([{ field: 'to', message: 'from and to must be different chains' }]);
    }
    // chain id and alias are the same chain
    expect((await t.post('/api/plan', { ...dai, to: '1' })).status).toBe(400);
  });
  it('an empty body reports every missing field, in one order and one shape, on inspect, plan and rewrite/plan', async () => {
    const t2 = await startApp({ rateLimit: 1000, rateLimitHeavy: 1000, rewrite: runRewriteFake() });
    const shape = async (p: string) => (await (await t2.post(p, {})).json()).error;
    const inspect = await shape('/api/inspect');
    const plan = await shape('/api/plan');
    const rw = await shape('/api/rewrite/plan');
    expect(inspect).toMatchObject({ code: 'INPUT', fields: [{ field: 'address' }, { field: 'from' }] });
    expect(plan.fields.map((f: any) => f.field)).toEqual(['address', 'from', 'to']);
    expect(rw.fields.map((f: any) => f.field)).toEqual(['address', 'from', 'to']);
    expect(plan.message).toBe(plan.fields.map((f: any) => f.message).join('; '));
    for (const e of [inspect, plan, rw]) { expect(typeof e.code).toBe('string'); expect(typeof e.message).toBe('string'); }
    expect((await t2.post('/api/plan', { address: '0x12', from: 'narnia', to: 'base' })).status).toBe(400);
    const mix = (await (await t2.post('/api/plan', { address: '0x12', from: 'narnia', to: 'base' })).json()).error;
    expect(mix.fields.map((f: any) => f.field)).toEqual(['address', 'from']);
    await t2.close();
  });
  it('error messages name JSON fields and endpoints, never CLI flags or commands', async () => {
    const msgs: string[] = [];
    const take = async (r: Response) => { const j = await r.json(); msgs.push(JSON.stringify(j)); return j; };
    await take(await t.post('/api/plan', { ...dai, from: 'narnia' }));
    await take(await t.post('/api/plan', { ...dai, overrides: { nonexistent: '1' } }));
    await take(await t.post('/api/plan', { ...dai, overrides: { '0x1111111111111111111111111111111111111111': '0x2' } }));
    await take(await t.post('/api/plan', { ...dai, overrides: { chainId_: 'abc' } }));
    for (const m of msgs) { expect(m).not.toMatch(/--[a-z]/); expect(m).not.toMatch(/\bcmc\b/); }
    expect(msgs[0]).toMatch(/GET \/api\/chains/);
    expect(msgs[1]).toMatch(/overrides/);
  });
  it('plan notes and warnings are worded for the API too (USDC, Transparent proxy, beacon)', async () => {
    const out: string[] = [];
    for (const a of [ADDR.usdcProxy, ADDR.router]) {
      for (const to of ['base-sepolia', 'polygon']) out.push(JSON.stringify(await (await t.post('/api/plan', { address: a, from: 'eth', to })).json()));
    }
    for (const m of out) { expect(m).not.toMatch(/--set/); expect(m).not.toMatch(/\bcmc [a-z]/); }
  });
  it('apiText turns every CLI phrase of the core into an API one', () => {
    expect(apiText('--set 0xabc=<address>: nope')).toBe('"overrides" {"0xabc": "address"}: nope');
    expect(apiText('overridden by --set 0xabc')).toBe('overridden by "overrides" key "0xabc"');
    expect(apiText('(clone it separately or pass --set)')).toBe('(clone it separately or pass "overrides")');
    expect(apiText('Unknown chain "x". Run `cmc chains` to list supported chains.')).toBe('Unknown chain "x". GET /api/chains lists the supported chains.');
    expect(apiText('pass --set or --keep-unresolved')).toBe('give a value in "overrides"');
  });
});

describe('minor: SSE lines are API-worded too', () => {
  it('a check detail with a CLI flag never reaches the event stream', async () => {
    const sim = fakeSim();
    sim.checks = [{ name: 'skipped x', ok: false, level: 'fail', kind: 'skipped-step', subject: 'x', detail: 'needs input (pass --set <name>=<value>)' }];
    const t2 = await startApp({ rateLimit: 1000, rateLimitHeavy: 1000, backend: fixtureBackend({ simulate: async () => sim }) });
    const { jobId } = await (await t2.post('/api/simulate', dai)).json();
    await waitFor(t2.base, jobId, ['done']);
    const sse = await (await fetch(`${t2.base}/api/jobs/${jobId}/events`)).text();
    expect(sse).toContain('overrides');
    expect(sse).not.toMatch(/--set/);
    await t2.close();
  });
});

describe('minor: call steps and check marks', () => {
  it('job lines say "called <fn> on <target> (tx ...)" for call steps and use the check level for the marks', async () => {
    const sim = fakeSim();
    sim.results.push({ stepId: 'init:initialize', name: 'initialize', address: '0x3333333333333333333333333333333333333333', txHash: ('0x' + 'ab'.repeat(32)) as `0x${string}`, gasUsed: '5', runtimeMatch: { result: 'match', detail: 'call step: no code deployed' }, kind: 'call' });
    sim.checks = [
      { name: 'proxy: name()', ok: true, level: 'warn', kind: 'view-call', subject: 'proxy', detail: 'clone="USD Coin" original="USD//C"' },
      { name: 'proxy: symbol()', ok: true, level: 'pass', kind: 'view-call', subject: 'proxy', detail: 'same' },
    ];
    const t2 = await startApp({ rateLimit: 1000, rateLimitHeavy: 1000, backend: fixtureBackend({ simulate: async () => sim }) });
    const { jobId } = await (await t2.post('/api/simulate', dai)).json();
    const j = await waitFor(t2.base, jobId, ['done']);
    const lines = j.lines.map((l: any) => l.text) as string[];
    expect(lines.some((l) => /^ {2}called initialize on 0x3333333333333333333333333333333333333333 \(tx 0xabab/.test(l))).toBe(true);
    expect(lines.some((l) => /deployed initialize/.test(l))).toBe(false);
    expect(lines.filter((l) => /runtime vs recompile/.test(l))).toHaveLength(1); // only the real deployment is compared
    expect(lines).toContain('  [WARN] proxy: name(): clone="USD Coin" original="USD//C"');
    expect(lines.some((l) => l.includes('[PASS] ') && l.includes('symbol()'))).toBe(true);
    const call = j.result.checks.find((c: any) => c.kind === 'call');
    expect(call).toMatchObject({ level: 'pass' });
    await t2.close();
  });
});

describe('E4: generated project files use API wording', () => {
  it('report.md, README.md, deploy.sh, plan.json and analysis.json of an EVM project never mention CLI flags', async () => {
    const { jobId } = await (await t.post('/api/project', { address: ADDR.usdcProxy, from: 'eth', to: 'base-sepolia' })).json();
    await waitFor(t.base, jobId, ['done']);
    const files = (await (await fetch(`${t.base}/api/jobs/${jobId}/files`)).json()).files as { path: string }[];
    for (const p of ['report.md', 'README.md', 'deploy.sh', 'plan.json', 'analysis.json']) {
      expect(files.map((f) => f.path)).toContain(p);
      const c = (await (await fetch(`${t.base}/api/jobs/${jobId}/file?path=${p}`)).json()).content as string;
      expect(c, p).not.toMatch(/--set|--keep-unresolved|--mainnet|\bcmc [a-z]/);
    }
    const report = (await (await fetch(`${t.base}/api/jobs/${jobId}/file?path=report.md`)).json()).content as string;
    expect(report).toContain('"overrides"');
  });
});

describe('override keys are printed whole and round-trip', () => {
  it('every key quoted in a generated text or API message is a valid overrides key (step:function.arg)', async () => {
    const plan = (await (await t.post('/api/plan', { address: ADDR.usdcProxy, from: 'eth', to: 'base-sepolia' })).json()).plan;
    const valid = new Set<string>();
    for (const s of plan.steps) for (const a of s.args) { valid.add(a.name); valid.add(`${s.id}.${a.name}`); for (const y of a.call?.args ?? []) { valid.add(y.name); valid.add(`${s.id}.${a.name}.${y.name}`); } }
    const { jobId } = await (await t.post('/api/project', { address: ADDR.usdcProxy, from: 'eth', to: 'base-sepolia' })).json();
    await waitFor(t.base, jobId, ['done']);
    const texts: string[] = [JSON.stringify(plan)];
    for (const p of ['report.md', 'README.md', 'deploy.sh']) texts.push((await (await fetch(`${t.base}/api/jobs/${jobId}/file?path=${p}`)).json()).content);
    const keys = new Set<string>();
    for (const x of texts) for (const m of x.matchAll(/"overrides"[ ]?(?:\{\\?"([^"\\]+)\\?"|key \\?"([^"\\]+)\\?")/g)) keys.add(m[1] ?? m[2]!);
    expect(keys.size).toBeGreaterThan(0);
    for (const k of keys) expect(valid.has(k) || /^<.*>$/.test(k), `printed key ${k}`).toBe(true);
    // and a printed key really works as an override
    const r = await t.post('/api/plan', { address: ADDR.usdcProxy, from: 'eth', to: 'base-sepolia', overrides: { [[...keys][0]!]: 'deployer' } });
    expect(r.status).toBe(200);
    // and a whole step:function.arg key, which contains ':' and '.', survives the rewording intact
    expect(apiText('give it with --set init:initialize.newOwner=<address>: x')).toBe('give it with "overrides" {"init:initialize.newOwner": "address"}: x');
    expect(apiText('set by --set admin:changeAdmin.newAdmin;')).toBe('set by "overrides" key "admin:changeAdmin.newAdmin";');
    expect(apiText('--set 0xabc=<address>: nope')).toBe('"overrides" {"0xabc": "address"}: nope');
  });
});
