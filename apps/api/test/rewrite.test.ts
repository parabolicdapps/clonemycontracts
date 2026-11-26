import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RewriteReport } from '@cmc/translate';
import { createRewriteBackend, sanitize, sanitizeDeep, plainRewriteError, type RewriteBackend, type RewriteHealth } from '../src/rewrite.js';
import { ADDR, fixtureBackend, startApp } from './helpers.js';

const TARGETS = ['solana', 'cosmwasm', 'aptos', 'tezos'].map((id) => ({ id, label: `${id} label`, language: `${id} lang`, nativeStandard: `${id} token`, runtime: `${id} runtime`, modelPath: 'model', deployTitle: 'Deploy' }));
const GOOD: RewriteHealth = { ok: true, model: { ok: true, message: 'The language model service answers.' }, sandbox: { ok: true, message: 'The build sandbox answers.' }, images: { solana: true, cosmwasm: true, aptos: true, tezos: true } };

const report = (status: string): RewriteReport => ({
  version: 1, contract: 'Dai', source: { address: ADDR.dai } as never, target: 'tezos', path: 'template', standard: 'ERC-20', status: status as never,
  compile: { ok: true, round: 0, rounds: [] },
  behaviour: { ran: true, passed: 3, failed: 0, notRunnable: 1, documented: 1, total: 5, rounds: [], conformance: [] },
  functions: [{ name: 'transfer', status: 'translated', unit: null, fidelity: null, differences: [], scenarios: { passed: 3, failed: 0, notRunnable: 0, documented: 0 }, failing: [] }],
  nonPortable: [], notTranslated: [], designNotes: ['note one'], deploy: ['octez-client originate ...'], usage: { requests: 0, tokensIn: 0, tokensOut: 0, modelSecs: 0 }, wallSecs: 1, scenarioCount: 5,
  outcomes: [
    { id: 's1', title: 'transfer ok', kind: 'call', status: 'passed', mismatches: [], notRunnable: [], checked: 1, notes: [] },
    { id: 's2', title: 'approve', kind: 'call', fn: 'approve', status: 'documented-difference', mismatches: [{ at: 'step 1', what: 'allowance', expected: '5', actual: '4', documented: 'FA1.2 set-style approve' }], notRunnable: [], checked: 1, notes: [] },
    { id: 's3', title: 'huge', kind: 'call', status: 'not-runnable', mismatches: [], notRunnable: ['value does not fit'], checked: 0, notes: [] },
  ],
} as unknown as RewriteReport);

interface Control { release: (status?: string) => void; fail: (e: Error) => void; started: boolean; signal?: AbortSignal; lines: (s: string) => void }

/** A fake pipeline that waits until the test lets it finish (or aborts). */
function fakeBackend(over: Partial<RewriteBackend> = {}): { backend: RewriteBackend; runs: Control[] } {
  const runs: Control[] = [];
  const backend: RewriteBackend = {
    targets: () => TARGETS,
    health: async () => GOOD,
    plan: async () => ({ contract: 'Dai', path: 'template', standard: 'ERC-20', reasons: [], functions: ['transfer'], units: [], designNotes: ['n'], notTranslated: [], nonPortable: [], decimalsNote: null }),
    run: (req, o) => new Promise((resolve, reject) => {
      const c: Control = {
        started: true, signal: o.signal, lines: (s) => o.onProgress(s),
        release: async (status = 'PASSED') => {
          await mkdir(join(o.outDir, 'project', 'src'), { recursive: true });
          await mkdir(join(o.outDir, 'llm'), { recursive: true });
          await writeFile(join(o.outDir, 'project', 'src', 'main.py'), 'print("hi")\n');
          await writeFile(join(o.outDir, 'report.md'), '# report\n');
          await writeFile(join(o.outDir, 'llm', '001.request.json'), '{"secret":"prompt"}');
          resolve({ status, report: report(status) });
        },
        fail: (e) => reject(e),
      };
      o.signal.addEventListener('abort', () => setTimeout(() => reject(new Error('aborted')), 20), { once: true });
      runs.push(c);
      o.onProgress('[source] fetching');
    }),
    ...over,
  };
  return { backend, runs };
}

const dai = { address: ADDR.dai, from: 'eth', to: 'tezos', rights: true };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const started = async (runs: unknown[], n: number) => { while (runs.length < n) await wait(10); }; // status flips to running just before the pipeline is called
async function job(t: { base: string }, id: string) { return (await (await fetch(`${t.base}/api/jobs/${id}`)).json()).job; }
async function until(t: { base: string }, id: string, st: string[], ms = 3000) {
  const end = Date.now() + ms;
  for (;;) { const j = await job(t, id); if (st.includes(j.status)) return j; if (Date.now() > end) throw new Error(`job stuck in ${j.status}`); await wait(20); }
}
const opts = (b: RewriteBackend) => ({ rewrite: b, rateLimit: 1000, rateLimitHeavy: 1000, clientKey: (req: import('node:http').IncomingMessage) => String(req.headers['x-test-client'] ?? '') || undefined });
const ip = (n: number) => ({ 'x-test-client': `client-${n}` });

describe('rewrite targets and health', () => {
  it('describes the four targets from the packs (not hard-coded in the API)', () => {
    const ts = createRewriteBackend({ settings: {} as never }).targets();
    expect(ts.map((t) => t.id)).toEqual(['solana', 'cosmwasm', 'aptos', 'tezos']);
    for (const t of ts) { expect(t.label).toBeTruthy(); expect(t.language).toBeTruthy(); expect(t.nativeStandard).toBeTruthy(); expect(t.runtime).toBeTruthy(); }
    expect(ts.find((t) => t.id === 'tezos')!.nativeStandard).toMatch(/FA1\.2/);
    expect(ts.find((t) => t.id === 'aptos')!.nativeStandard).toMatch(/Fungible Asset/);
  });
  it('GET /api/targets and /api/rewrite/health', async () => {
    const t = await startApp(opts(fakeBackend().backend));
    expect((await (await fetch(`${t.base}/api/targets`)).json()).targets).toHaveLength(4);
    expect(await (await fetch(`${t.base}/api/rewrite/health`)).json()).toMatchObject({ ok: true });
    await t.close();
  });
  it('refuses to start when a dependency is down and says so in plain words without hosts', async () => {
    const bad: RewriteHealth = { ok: false, model: { ok: false, message: 'The language model service is not reachable right now.' }, sandbox: { ok: true, message: 'The build sandbox answers.' }, images: GOOD.images };
    const t = await startApp(opts(fakeBackend({ health: async () => bad }).backend));
    const r = await t.post('/api/rewrite', dai);
    expect(r.status).toBe(424);
    const e = (await r.json()).error;
    expect(e.code).toBe('UNAVAILABLE');
    expect(e.message).toMatch(/language model service is not reachable/);
    expect(e.message).not.toMatch(/\d+\.\d+\.\d+\.\d+|ssh|8000/);
    await t.close();
  });
  it('refuses a target whose build image is missing', async () => {
    const t = await startApp(opts(fakeBackend({ health: async () => ({ ...GOOD, images: { ...GOOD.images, tezos: false } }) }).backend));
    const r = await t.post('/api/rewrite', dai);
    expect(r.status).toBe(424);
    expect((await r.json()).error.message).toMatch(/image for tezos/);
    await t.close();
  });
});

describe('rewrite validation and the licence gate', () => {
  it('validates the target and the source', async () => {
    const t = await startApp(opts(fakeBackend().backend));
    expect((await t.post('/api/rewrite', { ...dai, to: 'cobol' })).status).toBe(400);
    expect((await t.post('/api/rewrite', { ...dai, address: '0x12' })).status).toBe(400);
    expect((await t.post('/api/rewrite', { ...dai, from: 'nowhere' })).status).toBe(400);
    expect((await t.post('/api/rewrite', { ...dai, from: 'zksync' })).status).toBe(422);
    await t.close();
  });
  it('needs the rights confirmation when the licence is missing or restricted', async () => {
    const restricted = fixtureBackend({ analyse: async (a, c) => { const x = await fixtureBackend().analyse(a, c); x.license = { id: 'BUSL-1.1', class: 'restricted' }; return x; } });
    const t = await startApp({ ...opts(fakeBackend().backend), backend: restricted });
    const r = await t.post('/api/rewrite', { ...dai, rights: false });
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe('LICENCE');
    expect((await t.post('/api/rewrite', dai)).status).toBe(202); // dai carries rights: true
    await t.close();
  });
  it('does not gate a copyleft licence', async () => {
    const copyleft = fixtureBackend({ analyse: async (a, c) => { const x = await fixtureBackend().analyse(a, c); x.license = { id: 'GPL-3.0', class: 'copyleft' }; return x; } });
    const t = await startApp({ ...opts(fakeBackend().backend), backend: copyleft });
    expect((await t.post('/api/rewrite', { ...dai, rights: false })).status).toBe(202);
    await t.close();
  });
  it('plans a rewrite (template or model path) without running it', async () => {
    const t = await startApp(opts(fakeBackend().backend));
    const j = await (await t.post('/api/rewrite/plan', dai)).json();
    expect(j.plan).toMatchObject({ path: 'template', standard: 'ERC-20', contract: 'Dai' });
    await t.close();
  });
});

describe('rewrite jobs', () => {
  it('runs a job: progress over SSE, result without raw outcomes, zip without model logs, file viewer', async () => {
    const { backend, runs } = fakeBackend();
    const t = await startApp(opts(backend));
    const r = await t.post('/api/rewrite', dai);
    expect(r.status).toBe(202);
    const { jobId } = await r.json();
    await until(t, jobId, ['running']);
    await started(runs, 1);
    runs[0]!.lines('[scenarios] 5 scenarios');
    const sse = fetch(`${t.base}/api/jobs/${jobId}/events`).then((x) => x.text());
    await wait(50);
    await runs[0]!.release('PASSED-WITH-DOCUMENTED-DIFFERENCES');
    const text = await sse;
    expect(text).toContain('[scenarios] 5 scenarios');
    expect(text).toContain('event: done');
    const j = await until(t, jobId, ['done']);
    expect(j.result.ok).toBe(true);
    expect(j.result.rewrite.status).toBe('PASSED-WITH-DOCUMENTED-DIFFERENCES');
    expect(j.result.rewrite.report.outcomes).toBeUndefined();
    expect(j.result.rewrite.documented).toEqual([expect.objectContaining({ id: 's2', why: 'FA1.2 set-style approve' })]);
    expect(j.result.rewrite.notRunnable).toEqual([expect.objectContaining({ id: 's3' })]);
    const zip = Buffer.from(await (await fetch(`${t.base}/api/jobs/${jobId}/project.zip`)).arrayBuffer());
    expect(zip.includes(Buffer.from('project/src/main.py'))).toBe(true);
    expect(zip.includes(Buffer.from('report.md'))).toBe(true);
    expect(zip.includes(Buffer.from('llm/'))).toBe(false);
    const files = (await (await fetch(`${t.base}/api/jobs/${jobId}/files`)).json()).files.map((f: any) => f.path);
    expect(files).toEqual(['project/src/main.py', 'report.md']);
    const f = await (await fetch(`${t.base}/api/jobs/${jobId}/file?path=project/src/main.py`)).json();
    expect(f.content).toBe('print("hi")\n');
    for (const bad of ['../x', 'llm/001.request.json', '/etc/passwd', 'project/../../x', '']) {
      expect((await fetch(`${t.base}/api/jobs/${jobId}/file?path=${encodeURIComponent(bad)}`)).status, bad).toBe(400);
    }
    await t.close();
  });

  it('runs one rewrite at a time, queues the rest with positions, one active rewrite per client', async () => {
    const { backend, runs } = fakeBackend();
    const t = await startApp(opts(backend));
    const a = (await (await t.post('/api/rewrite', dai, ip(1))).json()).jobId;
    const b = await (await t.post('/api/rewrite', dai, ip(2))).json();
    const c = await (await t.post('/api/rewrite', dai, ip(3))).json();
    expect(b.queuePosition).toBe(1);
    expect(c.queuePosition).toBe(2);
    await until(t, a, ['running']);
    await started(runs, 1);
    expect(runs).toHaveLength(1);
    expect((await job(t, b.jobId)).status).toBe('queued');
    // the same client cannot start a second one while the first is active
    const again = await t.post('/api/rewrite', dai, ip(2));
    expect(again.status).toBe(429);
    expect((await again.json()).error.code).toBe('BUSY');
    await runs[0]!.release();
    await until(t, a, ['done']);
    await until(t, b.jobId, ['running']);
    await started(runs, 2);
    expect(runs).toHaveLength(2);
    expect((await job(t, c.jobId)).queuePosition).toBe(1);
    await runs[1]!.release('FAILED-BEHAVIOUR');
    const bj = await until(t, b.jobId, ['done']);
    expect(bj.result.ok).toBe(false); // a FAILED rewrite is never reported as ok
    expect(bj.result.rewrite.status).toBe('FAILED-BEHAVIOUR');
    await until(t, c.jobId, ['running']);
    await started(runs, 3);
    await runs[2]!.release();
    await t.close();
  });

  it('cancels a queued job and a running job; only its owner may', async () => {
    const { backend, runs } = fakeBackend();
    const t = await startApp(opts(backend));
    const a = (await (await t.post('/api/rewrite', dai, ip(1))).json()).jobId;
    const b = (await (await t.post('/api/rewrite', dai, ip(2))).json()).jobId;
    await until(t, a, ['running']);
    await started(runs, 1);
    const del = (id: string, h: Record<string, string>) => fetch(`${t.base}/api/jobs/${id}`, { method: 'DELETE', headers: h });
    expect((await del(b, ip(9))).status).toBe(403);
    expect((await del(b, ip(2))).status).toBe(200);
    expect((await job(t, b)).status).toBe('cancelled');
    expect((await del(a, ip(1))).status).toBe(200);
    const aj = await until(t, a, ['cancelled']);
    expect(aj.status).toBe('cancelled');
    expect(runs[0]!.signal!.aborted).toBe(true);
    // the slot frees once the pipeline stopped: a new job starts
    const c = (await (await t.post('/api/rewrite', dai, ip(3))).json()).jobId;
    await until(t, c, ['running']);
    await started(runs, 2);
    await runs[1]!.release();
    await t.close();
  });

  it('stops a job at the wall-clock cap', async () => {
    const { backend } = fakeBackend();
    const t = await startApp({ ...opts(backend), rewriteTimeoutMs: 150 });
    const id = (await (await t.post('/api/rewrite', dai)).json()).jobId;
    const j = await until(t, id, ['failed']);
    expect(j.error.code).toBe('TIMEOUT');
    await t.close();
  });

  it('never shows internal hosts, accounts or paths: errors and progress lines are mapped to plain text', async () => {
    const { backend, runs } = fakeBackend();
    const t = await startApp(opts(backend));
    const id = (await (await t.post('/api/rewrite', dai)).json()).jobId;
    await until(t, id, ['running']);
    await started(runs, 1);
    runs[0]!.lines('[compile] upload failed: ssh: connect to host 10.1.2.3 port 22 as user@10.1.2.3 in /home/user/cmc-work/job-1');
    runs[0]!.fail(new Error('upload failed: ssh: connect to host 10.1.2.3 port 22: Connection refused'));
    const j = await until(t, id, ['failed']);
    const all = JSON.stringify(j);
    expect(all).not.toMatch(/10\.1\.2\.3|user|\/home\/|ssh:/);
    expect(j.error).toEqual({ code: 'SANDBOX', message: expect.stringMatching(/build sandbox/) });
    await t.close();
  });
});

describe('sanitizing', () => {
  it('removes hosts, accounts and paths', () => {
    expect(sanitize('ssh user@10.1.2.3 failed at http://10.1.2.3:8000/v1/x in /home/user/cmc-work/j and /tmp/runs/a')).not.toMatch(/10\.1\.2\.3|user|8000|\/home|\/tmp/);
    expect(sanitizeDeep({ a: ['10.1.2.3'], b: { c: 'fine' } })).toEqual({ a: ['a local host'], b: { c: 'fine' } });
  });
  it('maps pipeline errors to plain messages', () => {
    expect(plainRewriteError(new Error('model call failed: HTTP 500')).code).toBe('MODEL');
    expect(plainRewriteError(new Error('docker: command failed')).code).toBe('SANDBOX');
    expect(plainRewriteError(new Error('boom /Users/x/y')).message).toBe('The rewrite failed unexpectedly.');
  });
});
