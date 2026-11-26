import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileVerified, extractSpec } from '@cmc/translate';
import type { RewriteReport } from '@cmc/translate';
import { checkSpecAgainstAbi, rewrite as realRewrite } from '@cmc/translate';
import { SpecMismatch, type RewriteBackend } from '../src/rewrite.js';
import { ADDR, fixtureBackend, startApp } from './helpers.js';
import { analyseContract } from '@cmc/core';
import { loadVc, offlineExplorer, stubReader } from '../../../packages/core/test/helpers.js';
import { verifiedOf } from '../src/jobs.js';

const TARGETS = ['solana', 'cosmwasm', 'aptos', 'tezos'].map((id) => ({ id, label: id, language: id, nativeStandard: id, runtime: id, modelPath: 'm', deployTitle: 'Deploy' }));
const GOOD = { ok: true, model: { ok: true, message: '' }, sandbox: { ok: true, message: '' }, images: { solana: true, cosmwasm: true, aptos: true, tezos: true } };
const dai = { address: ADDR.dai, from: 'eth', to: 'tezos', rights: true };
const fixture = (n: string) => JSON.parse(readFileSync(new URL(`../../../packages/translate/test/fixtures/${n}.vc.json`, import.meta.url), 'utf8'));

const cov = (over = {}) => ({ functionsTotal: 3, functionsVerified: 1, functionsUnverified: ['transfer'], uncheckedFunctions: ['transfer'], trivialOnlyFunctions: [], notTranslatedFunctions: [], uncomparedReturns: [], notRunnableScenarios: [], getters: { checked: 4, mismatched: 0 }, summary: '1 of 3 functions verified', ...over });
const report = (status: string, early = false): RewriteReport => ({
  version: 1, contract: 'Dai', source: { address: ADDR.dai }, target: 'tezos', path: 'model', status, statusReasons: early ? ['the extracted spec disagrees with the contract\'s ABI, so nothing was generated'] : ['r1'],
  coverage: early ? cov({ functionsTotal: 0, functionsVerified: 0, functionsUnverified: [], uncheckedFunctions: [], summary: '0 of 0' }) : cov(),
  compile: { ok: status !== 'FAILED-COMPILE' && !early, round: early || status === 'FAILED-COMPILE' ? null : 1, rounds: [] },
  behaviour: { ran: !early, passed: 1, failed: 0, notRunnable: 0, documented: 0, total: 1, rounds: [], conformance: [], ...(early ? { fatal: 'spec sanity gate' } : {}) },
  functions: early ? [] : [{ name: 'transfer', status: 'translated', unit: null, fidelity: null, differences: [], scenarios: { passed: 0, failed: 0, notRunnable: 0, documented: 0 }, stateChanging: true, valueCoverage: 'none', unchecked: true, failing: [] }],
  nonPortable: [], notTranslated: [], designNotes: [], deploy: [], usage: { requests: 0, tokensIn: 0, tokensOut: 0, modelSecs: 0 }, wallSecs: 1, scenarioCount: 1, outcomes: [],
} as unknown as RewriteReport);

const backend = (status: string, early = false): RewriteBackend => ({
  targets: () => TARGETS, health: async () => GOOD,
  plan: async () => ({ contract: 'Dai', path: 'model', standard: null, reasons: [], functions: ['transfer'], units: [], designNotes: [], notTranslated: [], nonPortable: [], decimalsNote: null }),
  run: async (_r, o) => {
    await mkdir(join(o.outDir, 'project'), { recursive: true });
    await writeFile(join(o.outDir, 'report.md'), '# r\n');
    if (!early) await writeFile(join(o.outDir, 'project', 'a.txt'), 'x');
    return { status, report: report(status, early) };
  },
});
const until = async (base: string, id: string) => { for (let i = 0; i < 200; i++) { const j = (await (await fetch(`${base}/api/jobs/${id}`)).json()).job; if (['done', 'failed', 'cancelled'].includes(j.status)) return j; await new Promise((r) => setTimeout(r, 20)); } throw new Error('stuck'); };

describe('every verdict is a completed job with a stable `verified` field', () => {
  const cases: [string, string, boolean, boolean][] = [
    ['PASSED', 'full', true, true], ['PASSED-WITH-DOCUMENTED-DIFFERENCES', 'documented-differences', true, true], ['PARTIALLY-VERIFIED', 'partial', false, true],
    ['FAILED-COMPILE', 'failed-compile', false, true], ['FAILED-BEHAVIOUR', 'failed-behaviour', false, true], ['UNVERIFIED', 'unverified', false, true], ['SOMETHING-NEW', 'none', false, true],
  ];
  for (const [status, verified, ok, project] of cases) {
    it(`${status} -> done, verified=${verified}, ok=${ok}`, async () => {
      const t = await startApp({ rewrite: backend(status), rateLimit: 1000, rateLimitHeavy: 1000 });
      const { jobId } = await (await t.post('/api/rewrite', dai)).json();
      const j = await until(t.base, jobId);
      expect(j.status).toBe('done');
      expect(j.error).toBeUndefined();
      expect(j.result.ok).toBe(ok);
      expect(j.result.rewrite).toMatchObject({ status, verified });
      expect(j.result.rewrite.report.coverage.functionsTotal).toBe(3);
      expect(j.result.rewrite.report.statusReasons).toEqual(['r1']);
      expect(j.result.hasProject).toBe(project);
      expect((await fetch(`${t.base}/api/jobs/${jobId}/project.zip`)).status).toBe(200);
      await t.close();
    });
  }
  it('the early UNVERIFIED stop (spec does not match the ABI) is a done job with no project: files and zip are a clear 404', async () => {
    const t = await startApp({ rewrite: backend('UNVERIFIED', true), rateLimit: 1000, rateLimitHeavy: 1000 });
    const { jobId } = await (await t.post('/api/rewrite', dai)).json();
    const j = await until(t.base, jobId);
    expect(j).toMatchObject({ status: 'done', result: { ok: false, hasProject: false, rewrite: { verified: 'unverified' } } });
    for (const p of ['files', 'project.zip']) {
      const r = await fetch(`${t.base}/api/jobs/${jobId}/${p}`);
      expect(r.status).toBe(404);
      expect((await r.json()).error.message).toMatch(/produced no project.*nothing was generated/);
    }
    await t.close();
  });
  it('verifiedOf maps every known status', () => {
    expect(['PASSED', 'PASSED-WITH-DOCUMENTED-DIFFERENCES', 'PARTIALLY-VERIFIED', 'FAILED-COMPILE', 'FAILED-BEHAVIOUR', 'UNVERIFIED', 'x'].map(verifiedOf)).toEqual(['full', 'documented-differences', 'partial', 'failed-compile', 'failed-behaviour', 'unverified', 'none']);
  });
});

describe('the spec/ABI gate at plan time (legacy 0.4.x AST fixtures)', () => {
  /** A planner that runs the real gate on a recorded verified contract, like the core backend does. */
  const gated = (name: string, tamper?: (spec: any) => void): RewriteBackend => ({
    ...backend('PASSED'),
    plan: async () => {
      const v = fixture(name);
      const spec: any = extractSpec(await compileVerified(v), {});
      tamper?.(spec);
      const gate = checkSpecAgainstAbi(spec, (await compileVerified(v)).abi, v.abi);
      if (!gate.ok) throw new SpecMismatch(gate.problems);
      return { contract: spec.name, path: 'model', standard: null, reasons: [], functions: spec.functions.filter((f: any) => f.kind === 'function').map((f: any) => f.name), units: [], designNotes: [], notTranslated: [], nonPortable: [], decimalsNote: null };
    },
  });
  for (const [name, fn] of [['weth', 'withdraw'], ['usdt', 'issue']] as const) {
    it(`${name}: plans normally with its functions listed`, async () => {
      const t = await startApp({ rewrite: gated(name), rateLimit: 1000, rateLimitHeavy: 1000 });
      const r = await t.post('/api/rewrite/plan', dai);
      expect(r.status).toBe(200);
      expect((await r.json()).plan.functions).toContain(fn);
      expect((await t.post('/api/rewrite', dai)).status).toBe(202);
      await t.close();
    }, 120_000);
  }
  it('a broken spec is refused with 422 SPEC_MISMATCH and the mismatch list, on plan and on start (no job)', async () => {
    const t = await startApp({ rewrite: gated('weth', (spec) => { spec.functions = []; }), rateLimit: 1000, rateLimitHeavy: 1000 });
    for (const p of ['/api/rewrite/plan', '/api/rewrite']) {
      const r = await t.post(p, dai);
      expect(r.status, p).toBe(422);
      const b = await r.json();
      expect(b.error.code).toBe('SPEC_MISMATCH');
      expect(b.error.message).toMatch(/could not be analysed reliably/);
      expect(b.problems.join(' ')).toMatch(/withdraw/);
    }
    expect(t.app.jobs['jobs'].size).toBe(0);
    await t.close();
  }, 120_000);
});

describe('E1: one synchronous 422 UNSUPPORTED on every rewrite endpoint', () => {
  const old = (language: string, version: string) => fixtureBackend({ analyse: async (a, c) => { const x = await fixtureBackend().analyse(a, c); x.contract = { ...x.contract, language, compilerVersion: version }; x.unsupported = language === 'Vyper' ? [`Vyper ${version} contracts are not supported in v1 (Solidity only)`] : []; return x; } });
  for (const [label, lang, ver, re] of [['Vyper 0.2.4', 'Vyper', '0.2.4+commit.7949850', /Vyper 0\.2\.4.*Solidity only/], ['solc 0.4.10', 'Solidity', '0.4.10+commit.f0d539ae', /0\.4\.10.*older than 0\.4\.12/], ['solc 0.4.11', 'Solidity', '0.4.11+commit.68ef5810', /0\.4\.11.*older than 0\.4\.12/]] as const) {
    it(`${label}: plan and start give the same 422`, async () => {
      const t = await startApp({ rewrite: backend('PASSED'), backend: old(lang, ver), rateLimit: 1000, rateLimitHeavy: 1000 });
      const msgs = new Set<string>();
      for (const p of ['/api/rewrite/plan', '/api/rewrite']) {
        const r = await t.post(p, dai);
        expect(r.status, p).toBe(422);
        const e = (await r.json()).error;
        expect(e.code).toBe('UNSUPPORTED');
        expect(e.message).toMatch(re);
        msgs.add(e.message);
      }
      expect(msgs.size).toBe(1);
      expect(t.app.jobs['jobs'].size).toBe(0);
      await t.close();
    });
  }
  it('typed pipeline errors keep their meaning; an unexpected planner exception is a clean 500, never a 502 with internals', async () => {
    const mk = (err: Error) => ({ ...backend('PASSED'), plan: async () => { throw err; } });
    const { CmcError } = await import('@cmc/core');
    const spy = (await import('vitest')).vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let t = await startApp({ rewrite: mk(new CmcError('solc 0.2.4 is not in the official release list', 'UNSUPPORTED')), rateLimit: 1000, rateLimitHeavy: 1000 });
    let r = await t.post('/api/rewrite/plan', dai);
    expect(r.status).toBe(422);
    expect((await r.json()).error.code).toBe('UNSUPPORTED');
    await t.close();
    t = await startApp({ rewrite: mk(new TypeError("Cannot read properties of undefined (reading 'x') at /home/u/secret.ts:1")), rateLimit: 1000, rateLimitHeavy: 1000 });
    r = await t.post('/api/rewrite/plan', dai);
    expect(r.status).toBe(500);
    const body = JSON.stringify(await r.json());
    expect(body).toContain('"code":"INTERNAL"');
    expect(body).not.toMatch(/secret|Cannot read|home/);
    expect(spy).toHaveBeenCalled();
    await t.close();
    spy.mockRestore();
  });
});

describe('E3: a stopped rewrite keeps its last good project and an honest verdict', () => {
  /** writes round-0 files, logs a round, then hangs until aborted or throws */
  const stopper = (mode: 'hang' | 'throw' | 'throw-early', withReport = false): RewriteBackend => ({
    ...backend('PASSED'),
    run: async (_r, o) => {
      if (mode !== 'throw-early') {
        await mkdir(join(o.outDir, 'project'), { recursive: true });
        await writeFile(join(o.outDir, 'project', 'round0.txt'), 'x');
        if (withReport) await writeFile(join(o.outDir, 'report.json'), JSON.stringify({ ...report('FAILED-BEHAVIOUR'), behaviour: { ...report('x').behaviour, rounds: [{ kind: 'behaviour', round: 2, ok: false, seconds: 1, detail: '' }] } }));
        o.onProgress('[compile] round 1 ok');
      }
      if (mode === 'hang') return new Promise((_res, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted'))));
      throw new Error('ssh: connect to host 10.0.0.1 port 22: refused');
    },
  });
  it('timeout with files: a done job, stopped.reason=timeout, project available, status from the last completed stage', async () => {
    const t = await startApp({ rewrite: stopper('hang'), rewriteTimeoutMs: 400, rateLimit: 1000, rateLimitHeavy: 1000 });
    const { jobId } = await (await t.post('/api/rewrite', dai)).json();
    const j = await until(t.base, jobId);
    expect(j.status).toBe('done');
    expect(j.error).toBeUndefined();
    expect(j.result).toMatchObject({ ok: false, hasProject: true, rewrite: { status: 'UNVERIFIED', verified: 'unverified', stopped: { reason: 'timeout', afterRound: 1 } } });
    expect(j.result.rewrite.stopped.message).toMatch(/time limit/);
    expect((await fetch(`${t.base}/api/jobs/${jobId}/project.zip`)).status).toBe(200);
    await t.close();
  });
  it('a persisted report.json decides the status and the round', async () => {
    const t = await startApp({ rewrite: stopper('hang', true), rewriteTimeoutMs: 400, rateLimit: 1000, rateLimitHeavy: 1000 });
    const { jobId } = await (await t.post('/api/rewrite', dai)).json();
    const j = await until(t.base, jobId);
    expect(j.result.rewrite).toMatchObject({ status: 'FAILED-BEHAVIOUR', verified: 'failed-behaviour', stopped: { reason: 'timeout', afterRound: 2 } });
    await t.close();
  });
  it('error after files: done with stopped.reason=error and no internals in the message; error with no files is still failed', async () => {
    let t = await startApp({ rewrite: stopper('throw'), rateLimit: 1000, rateLimitHeavy: 1000 });
    let id = (await (await t.post('/api/rewrite', dai)).json()).jobId;
    let j = await until(t.base, id);
    expect(j).toMatchObject({ status: 'done', result: { hasProject: true, rewrite: { stopped: { reason: 'error' } } } });
    expect(JSON.stringify(j.result.rewrite.stopped)).not.toMatch(/10\.0\.0\.1|ssh/);
    await t.close();
    t = await startApp({ rewrite: stopper('throw-early'), rateLimit: 1000, rateLimitHeavy: 1000 });
    id = (await (await t.post('/api/rewrite', dai)).json()).jobId;
    j = await until(t.base, id);
    expect(j.status).toBe('failed');
    expect((await fetch(`${t.base}/api/jobs/${id}/project.zip`)).status).toBe(404);
    await t.close();
  });
  it('cancel with files: the job is cancelled but keeps its project and a result', async () => {
    const t = await startApp({ rewrite: stopper('hang'), rateLimit: 1000, rateLimitHeavy: 1000 });
    const { jobId } = await (await t.post('/api/rewrite', dai)).json();
    await new Promise((r) => setTimeout(r, 300));
    await fetch(`${t.base}/api/jobs/${jobId}`, { method: 'DELETE' });
    const j = await until(t.base, jobId);
    expect(j.status).toBe('cancelled');
    expect(j.result).toMatchObject({ hasProject: true, rewrite: { stopped: { reason: 'cancelled' } } });
    expect((await fetch(`${t.base}/api/jobs/${jobId}/files`)).status).toBe(200);
    await t.close();
  });
});

describe('compiler version boundaries on every endpoint', () => {
  const at = (ver: string) => fixtureBackend({ analyse: async (a, c) => analyseContract({ ...loadVc(a as never, c), compilerVersion: ver }, { reader: stubReader(), ...offlineExplorer }) });
  const cloneBody = { address: ADDR.dai, from: 'eth', to: 'base' };
  const code = async (r: Response) => ((await r.json()) as any).error?.code;

  it('0.4.10: clone endpoints say which compilers are supported and why; rewrite endpoints say 0.4.12', async () => {
    const t = await startApp({ backend: at('0.4.10+commit.f0d539ae'), rewrite: backend('PASSED'), rateLimit: 1000, rateLimitHeavy: 1000 });
    for (const p of ['/api/plan', '/api/simulate', '/api/project', '/api/deploy-payload']) {
      const r = await t.post(p, cloneBody);
      expect(r.status, p).toBe(422);
      const e = (await r.json()).error;
      expect(e.code).toBe('UNSUPPORTED');
      expect(e.message).toMatch(/0\.4\.10.*before 0\.4\.11.*standard JSON.*0\.4\.11 and newer/);
    }
    for (const p of ['/api/rewrite/plan', '/api/rewrite']) {
      const r = await t.post(p, dai);
      expect(r.status, p).toBe(422);
      expect((await r.json()).error.message).toMatch(/0\.4\.10.*older than 0\.4\.12/);
    }
    await t.close();
  });
  it('0.4.11: cloning is accepted, rewriting is refused with the 0.4.12 rule', async () => {
    const t = await startApp({ backend: at('0.4.11+commit.68ef5810'), rewrite: backend('PASSED'), rateLimit: 1000, rateLimitHeavy: 1000 });
    expect((await t.post('/api/plan', cloneBody)).status).toBe(200);
    expect((await t.post('/api/simulate', cloneBody)).status).toBe(202);
    expect((await t.post('/api/project', cloneBody)).status).toBe(202);
    expect(await code(await t.post('/api/deploy-payload', cloneBody))).not.toBe('UNSUPPORTED'); // it may fail to compile the stand-in source, but not on support
    for (const p of ['/api/rewrite/plan', '/api/rewrite']) {
      const r = await t.post(p, dai);
      expect(r.status, p).toBe(422);
      expect((await r.json()).error.message).toMatch(/0\.4\.11.*older than 0\.4\.12/);
    }
    await t.close();
  });
  it('0.4.12: both are accepted', async () => {
    const t = await startApp({ backend: at('0.4.12+commit.194ff033'), rewrite: backend('PASSED'), rateLimit: 1000, rateLimitHeavy: 1000 });
    expect((await t.post('/api/plan', cloneBody)).status).toBe(200);
    expect((await t.post('/api/rewrite/plan', dai)).status).toBe(200);
    expect((await t.post('/api/rewrite', dai)).status).toBe(202);
    await t.close();
  });
});

describe('a slow rewrite plan is answered within a bound', () => {
  it('202 pending with Retry-After, then the same request returns the cached plan', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const slow: RewriteBackend = { ...backend('PASSED'), plan: async () => { calls++; await gate; return { contract: 'Dai', path: 'model', standard: null, reasons: [], functions: ['f'], units: [], designNotes: [], notTranslated: [], nonPortable: [], decimalsNote: null }; } };
    const t = await startApp({ rewrite: slow, rewritePlanWaitMs: 100, rateLimit: 1000, rateLimitHeavy: 1000 });
    const r = await t.post('/api/rewrite/plan', dai);
    expect(r.status).toBe(202);
    expect(r.headers.get('retry-after')).toBe('5');
    expect(await r.json()).toMatchObject({ status: 'pending', retryAfterSeconds: 5 });
    release();
    await new Promise((x) => setTimeout(x, 50));
    const r2 = await t.post('/api/rewrite/plan', dai);
    expect(r2.status).toBe(200);
    expect((await r2.json()).plan.functions).toEqual(['f']);
    expect(calls).toBe(1);
    await t.close();
  });
});

describe('application errors are never 502/503/504 (reverse proxies can replace the JSON body)', () => {
  it('an unreachable upstream during a plan is a 424 with the JSON error', async () => {
    const { CmcError } = await import('@cmc/core');
    const t = await startApp({ rewrite: { ...backend('PASSED'), plan: async () => { throw new CmcError('rpc down', 'RPC'); } }, rateLimit: 1000, rateLimitHeavy: 1000 });
    const r = await t.post('/api/rewrite/plan', dai);
    expect(r.status).toBe(424);
    expect((await r.json()).error.code).toBe('RPC');
    await t.close();
  });
});


describe('the real pipeline (scripted model, fake pack): checkpoints survive a stop', () => {
  const hasAnvil = (() => { try { require('node:child_process').execFileSync('anvil', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  it.skipIf(!hasAnvil)('a cancel after the first checkpoint keeps the checkpointed project and report with stopped.reason=cancelled', async () => {
    const { ScriptedProvider } = await import('../../../packages/translate/src/llm/client.js');
    const { buildDesign } = await import('../../../packages/translate/src/targets/solana/design.js');
    const { fixture } = await import('../../../packages/translate/test/helpers.js');
    const pack: any = {
      id: 'fake', label: 'fake', design: (spec: any) => buildDesign(spec, {}), templates: () => null, units: (d: any) => d.instructions.map((i: any) => i.name),
      generatePrompt: (_c: any, unit: string) => ({ system: 's', user: `gen ${unit}` }), assemble: (_s: any, _d: any, bodies: any) => ({ 'bodies.json': JSON.stringify(bodies) }),
      compile: async () => ({ ok: true, log: '', seconds: 0, artifacts: {} }), blame: () => ({ units: new Set(), other: false }),
      repairPrompt: (_d: any, unit: string) => ({ system: 's', user: `repair ${unit}` }), behaviourRepairPrompt: (_d: any, unit: string) => ({ system: 's', user: `behaviour ${unit}` }),
      runScenarios: async (_f: any, _c: any, _d: any, _s: any, set: any) => { await new Promise((r) => setTimeout(r, 400)); return { seconds: 0, conformance: [], outcomes: set.scenarios.map((x: any) => ({ id: x.id, title: x.title, kind: x.kind, ...(x.fn ? { fn: x.fn } : {}), status: x.fn === 'fund' ? 'failed' : 'passed', mismatches: x.fn === 'fund' ? [{ at: '1', what: 'fund()', expected: 'success', actual: 'revert' }] : [], notRunnable: [], checked: 2, notes: [] })) }; },
      unitOf: (d: any, fn: string) => d.instructions.find((i: any) => i.solidity === fn)?.name ?? (fn === 'constructor' ? 'initialize' : null), deployCommands: () => ['echo deploy'],
    };
    const llm = new ScriptedProvider((msgs: any[]) => { const unit = /(?:gen|repair|behaviour) (\w+)/.exec(msgs[msgs.length - 1]!.content)![1]!; return `=== BODY: ${unit} ===\n    Ok(())\n=== END BODY ===`; });
    let cps = 0; // checkpoint 1 = after the first compile, 2 = after behaviour round 1
    let firstCheckpoint!: () => void;
    const got = new Promise<void>((r) => (firstCheckpoint = r));
    const be: RewriteBackend = {
      ...backend('PASSED'),
      run: (_req, o) => realRewrite({ source: { kind: 'file', path: fixture('LinearVesting') }, pack, llm, outDir: o.outDir, maxBehaviourRepairs: 3, signal: o.signal, timeBudgetMs: o.budgetMs, onProgress: o.onProgress, onCheckpoint: (r) => { o.onCheckpoint?.(r.report); if (++cps === 2) firstCheckpoint(); } }) as never,
    };
    const t = await startApp({ rewrite: be, rateLimit: 1000, rateLimitHeavy: 1000 });
    const { jobId } = await (await t.post('/api/rewrite', dai)).json();
    await got;
    await fetch(`${t.base}/api/jobs/${jobId}`, { method: 'DELETE' });
    const j = await until(t.base, jobId);
    expect(j.status).toBe('cancelled');
    expect(j.result.hasProject).toBe(true);
    expect(j.result.rewrite.stopped).toMatchObject({ reason: 'cancelled' });
    expect(j.result.rewrite.status).toMatch(/FAILED-BEHAVIOUR|PARTIALLY-VERIFIED|UNVERIFIED/); // the checkpointed report, not the stub
    expect(j.result.rewrite.report.compile.ok).toBe(true);
    expect(j.result.rewrite.report.behaviour.rounds.length).toBeGreaterThanOrEqual(1);
    expect((await fetch(`${t.base}/api/jobs/${jobId}/project.zip`)).status).toBe(200);
    await t.close();
  }, 60_000);
});

describe('failure mapping with fake upstreams', () => {
  const planThrowing = (e: Error): RewriteBackend => ({ ...backend('PASSED'), plan: async () => { throw e; } });
  it('rewrite plan: model, sandbox, rpc and network failures are 424 with a JSON error and no internals', async () => {
    const { CmcError } = await import('@cmc/core');
    const cases: [Error, string][] = [
      [new Error('model call failed: read timeout from http://10.1.2.3:8000'), 'MODEL'],
      [new Error('ssh: connect to host 10.1.2.4 port 22: Connection refused'), 'SANDBOX'],
      [new CmcError('rpc 10.1.1.1 down', 'RPC'), 'RPC'],
      [new CmcError('explorer unreachable', 'NETWORK'), 'NETWORK'],
    ];
    for (const [err, code] of cases) {
      const t = await startApp({ rewrite: planThrowing(err), rateLimit: 1000, rateLimitHeavy: 1000 });
      const r = await t.post('/api/rewrite/plan', dai);
      expect(r.status, code).toBe(424);
      const text = JSON.stringify(await r.json());
      expect(text).toContain(`"code":"${code}"`);
      expect(text).not.toMatch(/10\.1\.2\.3|10\.1\.2\.4|10\.1\.1\.1|8000|ssh:/);
      await t.close();
    }
  });
  it('clone endpoints: an upstream NETWORK/RPC failure in analysis is 424, never 502/503/504', async () => {
    const { CmcError } = await import('@cmc/core');
    for (const code of ['NETWORK', 'RPC'] as const) {
      const t = await startApp({ backend: fixtureBackend({ analyse: async () => { throw new CmcError('upstream down', code); } }), rateLimit: 1000, rateLimitHeavy: 1000 });
      for (const p of ['/api/inspect', '/api/plan', '/api/simulate']) {
        const r = await t.post(p, p === '/api/inspect' ? { address: ADDR.dai, from: 'eth' } : { address: ADDR.dai, from: 'eth', to: 'base' });
        // simulate starts a job that fails; inspect/plan answer synchronously
        if (p === '/api/simulate') { expect([202, 424]).toContain(r.status); continue; }
        expect(r.status, `${code} ${p}`).toBe(424);
        expect((await r.json()).error.code).toBe(code);
      }
      await t.close();
    }
  });
  it('a request that takes too long is a 408 JSON error', async () => {
    const t = await startApp({ backend: fixtureBackend({ analyse: () => new Promise(() => undefined) }), requestTimeout: 150, rateLimit: 1000, rateLimitHeavy: 1000 });
    const r = await t.post('/api/inspect', { address: ADDR.dai, from: 'eth' });
    expect(r.status).toBe(408);
    expect((await r.json()).error.code).toBe('TIMEOUT');
    await t.close();
  });
  it('an unexpected planner exception is a clean 500 INTERNAL without the exception text', async () => {
    const spy = (await import('vitest')).vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const t = await startApp({ rewrite: planThrowing(new RangeError('boom at /Users/x/secret.ts:12 token=abc')), rateLimit: 1000, rateLimitHeavy: 1000 });
    for (const p of ['/api/rewrite/plan']) {
      const r = await t.post(p, dai);
      expect(r.status).toBe(500);
      const b = await r.json();
      expect(b.error).toEqual({ code: 'INTERNAL', message: 'The rewrite failed unexpectedly.' });
    }
    expect(spy.mock.calls.flat().join(' ')).toMatch(/boom/); // the detail is logged server-side only
    spy.mockRestore();
    await t.close();
  });
  it('a slow ANALYSIS answers 202 pending with Retry-After; the retry returns the plan without recomputing', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let analyses = 0, plans = 0;
    const be = fixtureBackend({ analyse: async (a, c) => { analyses++; await gate; return fixtureBackend().analyse(a, c); } });
    const rw: RewriteBackend = { ...backend('PASSED'), plan: async () => { plans++; return { contract: 'Dai', path: 'model', standard: null, reasons: [], functions: ['f'], units: [], designNotes: [], notTranslated: [], nonPortable: [], decimalsNote: null }; } };
    const t = await startApp({ backend: be, rewrite: rw, rewritePlanWaitMs: 100, rateLimit: 1000, rateLimitHeavy: 1000 });
    const r = await t.post('/api/rewrite/plan', dai);
    expect(r.status).toBe(202);
    expect(r.headers.get('retry-after')).toBe('5');
    expect(await r.json()).toMatchObject({ status: 'pending' });
    release();
    await new Promise((x) => setTimeout(x, 100));
    const r2 = await t.post('/api/rewrite/plan', dai);
    expect(r2.status).toBe(200);
    expect((await r2.json()).plan.functions).toEqual(['f']);
    const r3 = await t.post('/api/rewrite/plan', dai);
    expect(r3.status).toBe(200);
    expect(analyses).toBe(1);
    expect(plans).toBe(1);
    await t.close();
  });
  it('a slow analysis that later fails does not crash the server (no unhandled rejection)', async () => {
    const { CmcError } = await import('@cmc/core');
    const unhandled: unknown[] = [];
    const h = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', h);
    const t = await startApp({ backend: fixtureBackend({ analyse: async () => { await new Promise((r) => setTimeout(r, 250)); throw new CmcError('late failure', 'NETWORK'); } }), rewrite: backend('PASSED'), rewritePlanWaitMs: 50, rateLimit: 1000, rateLimitHeavy: 1000 });
    expect((await t.post('/api/rewrite/plan', dai)).status).toBe(202);
    await new Promise((r) => setTimeout(r, 500));
    process.off('unhandledRejection', h);
    expect(unhandled).toEqual([]);
    expect((await t.post('/api/rewrite/plan', dai)).status).toBeLessThan(600);
    await t.close();
  });
});
