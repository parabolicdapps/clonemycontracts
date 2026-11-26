import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScriptedProvider } from '../src/llm/client.js';
import { rewrite, RewriteCancelled } from '../src/pipeline/rewrite.js';
import type { CompileResult, TargetPack } from '../src/targets/pack.js';
import { buildDesign } from '../src/targets/solana/design.js';
import { hasAnvil, fixture } from './helpers.js';

/** A fake pack: "compiles" when the body for `release` contains `Ok(`; behaviour passes once `fixed` appears. Exercises the target independent loops. */
function fakePack(calls: { compiles: number; repairs: number; behaviour: number }): TargetPack<any> {
  return {
    id: 'fake', label: 'fake',
    design: (spec) => buildDesign(spec, {}), templates: () => null,
    units: (d) => d.instructions.map((i: any) => i.name),
    generatePrompt: (_c, unit) => ({ system: 's', user: `gen ${unit}` }),
    assemble: (_s, _d, bodies) => ({ 'bodies.json': JSON.stringify(bodies) }),
    compile: async (files): Promise<CompileResult> => { calls.compiles++; const b = JSON.parse(files['bodies.json']!); const ok = !Object.values<string>(b).some((x) => x.includes('BROKEN')); return { ok, log: ok ? '' : `error[E0308]: x\n --> programs/app/src/logic/release.rs:3:1\n`, seconds: 0, artifacts: {} }; },
    blame: (log) => ({ units: new Set(/logic\/(\w+)\.rs/.exec(log) ? [/logic\/(\w+)\.rs/.exec(log)![1]!] : []), other: false }),
    repairPrompt: (_d, unit) => { calls.repairs++; return { system: 's', user: `repair ${unit}` }; },
    behaviourRepairPrompt: (_d, unit) => ({ system: 's', user: `behaviour ${unit}` }),
    runScenarios: async (files, _c, _d, _s, set) => { calls.behaviour++; const fixed = files['bodies.json']!.includes('fixed'); return { seconds: 0, conformance: [], outcomes: set.scenarios.map((s) => ({ id: s.id, title: s.title, kind: s.kind, ...(s.fn ? { fn: s.fn } : {}), status: !fixed && s.fn === 'fund' ? 'failed' as const : 'passed' as const, mismatches: !fixed && s.fn === 'fund' ? [{ at: '1', what: 'fund()', expected: 'success', actual: 'revert' }] : [], notRunnable: [], checked: 2, notes: [] })) }; },
    unitOf: (d, fn) => d.instructions.find((i: any) => i.solidity === fn)?.name ?? (fn === 'constructor' ? 'initialize' : null),
    deployCommands: () => ['echo deploy'],
  };
}

const d = hasAnvil ? describe : describe.skip;
d('pipeline core (fake target pack, scripted model)', () => {
  it('compile-repair then behaviour-repair loops converge and the report records both', async () => {
    const calls = { compiles: 0, repairs: 0, behaviour: 0 };
    let broken = true;
    const llm = new ScriptedProvider((msgs) => {
      const u = msgs[msgs.length - 1]!.content;
      const unit = /(?:gen|repair|behaviour) (\w+)/.exec(u)![1]!;
      let body = '    Ok(())';
      if (unit === 'release' && u.startsWith('gen') && broken) { body = '    BROKEN'; broken = false; }
      if (u.startsWith('behaviour') && unit === 'fund') body = '    fixed';
      return `=== BODY: ${unit} ===\n${body}\n=== END BODY ===\nFIDELITY ${unit}: scripted`;
    });
    const out = mkdtempSync(join(tmpdir(), 'cmc-rw-'));
    const progress: string[] = [];
    const res = await rewrite({ source: { kind: 'file', path: fixture('LinearVesting') }, pack: fakePack(calls), llm, outDir: out, onProgress: (l) => progress.push(l) });
    expect(calls.repairs).toBe(1);
    expect(calls.behaviour).toBe(2);
    // every scenario passes, but `revoke` never moved tokens on the original (vesting has not started): the strict policy says so instead of PASSED
    expect(res.status).toBe('PARTIALLY-VERIFIED');
    expect(res.report.coverage.trivialOnlyFunctions).toEqual(['revoke']);
    expect(res.report.coverage.summary).toMatch(/\d+ of \d+ state-changing functions verified/);
    const rep = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    expect(rep.compile).toMatchObject({ ok: true, round: 1 });
    expect(rep.behaviour.rounds.length).toBe(2);
    expect(rep.functions.find((f: any) => f.name === 'fund').fidelity).toBe('scripted');
    expect(readFileSync(join(out, 'report.md'), 'utf8')).toContain('UNAUDITED');
    expect(progress.some((l) => /^\[compile\] round 0: failed/.test(l))).toBe(true);
  });
  it('a rewrite that never compiles is FAILED-COMPILE, one that fails behaviour is FAILED-BEHAVIOUR', async () => {
    const calls = { compiles: 0, repairs: 0, behaviour: 0 };
    const stubborn = new ScriptedProvider((msgs) => { const unit = /(?:gen|repair|behaviour) (\w+)/.exec(msgs[msgs.length - 1]!.content)![1]!; return `=== BODY: ${unit} ===\n    BROKEN\n=== END BODY ===`; });
    const r1 = await rewrite({ source: { kind: 'file', path: fixture('LinearVesting') }, pack: fakePack(calls), llm: stubborn, outDir: mkdtempSync(join(tmpdir(), 'cmc-rw-')), maxRepairs: 2 });
    expect(r1.status).toBe('FAILED-COMPILE');
    expect(calls.compiles).toBe(3);
    const calls2 = { compiles: 0, repairs: 0, behaviour: 0 };
    const noFix = new ScriptedProvider((msgs) => { const unit = /(?:gen|repair|behaviour) (\w+)/.exec(msgs[msgs.length - 1]!.content)![1]!; return `=== BODY: ${unit} ===\n    Ok(())\n=== END BODY ===`; });
    const r2 = await rewrite({ source: { kind: 'file', path: fixture('LinearVesting') }, pack: fakePack(calls2), llm: noFix, outDir: mkdtempSync(join(tmpdir(), 'cmc-rw-')), maxBehaviourRepairs: 1 });
    expect(r2.status).toBe('FAILED-BEHAVIOUR');
    expect(r2.report.functions.find((f) => f.name === 'fund')!.failing.length).toBeGreaterThan(0);
  });
  it('checkpoints after every round; a spent time budget stops the repair round gracefully and keeps the project', async () => {
    const calls = { compiles: 0, repairs: 0, behaviour: 0 };
    const llm = new ScriptedProvider((msgs) => { const unit = /(?:gen|repair|behaviour) (\w+)/.exec(msgs[msgs.length - 1]!.content)![1]!; return `=== BODY: ${unit} ===\n    Ok(())\n=== END BODY ===`; });
    const out = mkdtempSync(join(tmpdir(), 'cmc-rw-'));
    const cps: string[] = [];
    const res = await rewrite({ source: { kind: 'file', path: fixture('LinearVesting') }, pack: fakePack(calls), llm, outDir: out, timeBudgetMs: 1000, onCheckpoint: (r) => cps.push(r.status) });
    expect(calls.behaviour).toBe(1);
    expect(cps.length).toBeGreaterThanOrEqual(2); // after the compile and after the behaviour round
    expect(res.status).toBe('FAILED-BEHAVIOUR');
    expect(res.report.statusReasons.join(' ')).toMatch(/repair stopped: time budget exhausted after round 0/);
    expect(readFileSync(join(out, 'report.json'), 'utf8')).toContain('time budget exhausted');
    expect(readFileSync(join(out, 'project', 'bodies.json'), 'utf8')).toContain('release');
  });
  it('a cancel during a repair round still leaves the last checkpoint on disk and on the error', async () => {
    const calls = { compiles: 0, repairs: 0, behaviour: 0 };
    const ctl = new AbortController();
    const llm = new ScriptedProvider((msgs) => { const u = msgs[msgs.length - 1]!.content; const unit = /(?:gen|repair|behaviour) (\w+)/.exec(u)![1]!; if (u.startsWith('behaviour')) ctl.abort(); return `=== BODY: ${unit} ===\n    Ok(())\n=== END BODY ===`; });
    const out = mkdtempSync(join(tmpdir(), 'cmc-rw-'));
    let err: any;
    try { await rewrite({ source: { kind: 'file', path: fixture('LinearVesting') }, pack: fakePack(calls), llm, outDir: out, signal: ctl.signal }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(RewriteCancelled);
    expect(err.partial.status).toBe('FAILED-BEHAVIOUR');
    expect(JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')).status).toBe('FAILED-BEHAVIOUR');
    expect(readFileSync(join(out, 'project', 'bodies.json'), 'utf8').length).toBeGreaterThan(5);
  });
});
