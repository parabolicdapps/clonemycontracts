import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { CmcError, fetchVerifiedContract, type VerifiedContract } from '@cmc/core';
import type { LlmProvider } from '../llm/provider.js';
import { compileVerified, compileWithAst, DEFAULT_SOLC, stdInputForSource, type AstCompile } from '../spec/compile.js';
import { extractSpec } from '../spec/extract.js';
import { classifyStandard } from '../spec/standard.js';
import { OriginalRunner } from '../scenario/original.js';
import { generateScenarios, recordGroundTruth, verifyInitialValues } from '../scenario/generate.js';
import type { ContractSpec, ProxyInfoSpec, ScenarioSet } from '../types.js';
import type { CompileResult, ProjectFiles, ScenarioOutcomeLike, TargetPack } from '../targets/pack.js';
import { ell, more, showValue, buildFunctionReports, decideVerdict, renderReport, uncomparedReturnsOf, type RewriteReport, type RewriteStatus, type RoundRecord } from './report.js';
import { deadStatements, documentSelfSpend, lintSecurity, negativeFailures } from './security.js';
import { untranslatable } from '../spec/standard.js';
import { alignGetterExpectations, discoverReinitState, dropDeadBranches, type ReinitState } from '../spec/reinit.js';
import { checkSpecAgainstAbi } from '../spec/gate.js';
import { readTokenFacts } from '../spec/facts.js';
import { chainReader, resolveRewriteTarget } from '../spec/proxy.js';
import { prepareOriginal, type PreparedOriginal } from '../scenario/link.js';
import { writeTree } from './container.js';
import { sourceLookup } from '../targets/solana/prompts.js';

export interface RewriteOptions {
  source: { kind: 'address'; chain: string; address: string } | { kind: 'file'; path: string; contract?: string };
  pack: TargetPack<any>;
  llm: LlmProvider;
  outDir: string;
  maxRepairs?: number;
  maxBehaviourRepairs?: number;
  behaviourCheck?: boolean;
  decimals?: number;
  /** force the model path even for a plain standard (for testing) */
  noTemplate?: boolean;
  onProgress?: (line: string) => void;
  /** abort between stages and model requests (the sandbox call in flight finishes first); throws RewriteCancelled (with `partial` = the last checkpoint, when there is one) */
  signal?: AbortSignal;
  /** total time budget (default 22 min, leaving headroom under a 30 min job cap). Repair rounds that cannot fit are not started; the best result so far is finalised honestly. */
  timeBudgetMs?: number;
  /** called after the round-0 compile and after every behaviour round with the best-so-far result (project + report are already on disk) */
  onCheckpoint?: (r: RewriteResult) => void;
}

export class RewriteCancelled extends Error {
  /** the last checkpoint (project, report.json and report.md are on disk), when one existed */
  partial?: RewriteResult;
  constructor() { super('rewrite cancelled'); this.name = 'RewriteCancelled'; }
}

export interface RewriteResult { status: RewriteStatus; report: RewriteReport; outDir: string }

const parseBodies = (text: string): { bodies: Record<string, string>; fidelity: Record<string, string> } => {
  const bodies: Record<string, string> = Object.create(null); const fidelity: Record<string, string> = Object.create(null);
  for (const m of text.matchAll(/=== BODY: (\w+) ===\n([\s\S]*?)\n=== END BODY ===/g)) {
    bodies[m[1]!] = m[2]!.replace(/^```[a-z]*\n/, '').replace(/\n```\s*$/, '');
  }
  for (const m of text.matchAll(/^FIDELITY (\w+):\s*(.*)$/gm)) fidelity[m[1]!] = m[2]!.trim();
  return { bodies, fidelity };
};

/**
 * Runs the pipeline. After the first compile and after every behaviour round the best-so-far project and report are written to `outDir`
 * and passed to `onCheckpoint`; a cancel, a crash or an exhausted time budget therefore never loses the project (cancel throws RewriteCancelled
 * with `.partial`; any other late failure returns the last checkpoint with the reason appended).
 */
export async function rewrite(o: RewriteOptions): Promise<RewriteResult> {
  const ck: { latest?: RewriteResult } = {};
  try { return await rewriteInner(o, ck); } catch (e) {
    if (e instanceof RewriteCancelled) { if (ck.latest) e.partial = ck.latest; throw e; }
    if (ck.latest) {
      const r = ck.latest;
      r.report.statusReasons = [...r.report.statusReasons, `the run stopped early after the last checkpoint: ${(e as Error).message}`];
      writeJson(o.outDir, 'report.json', r.report); writeFileSync(join(o.outDir, 'report.md'), renderReport(r.report));
      return r;
    }
    throw e;
  }
}

async function rewriteInner(o: RewriteOptions, ck: { latest?: RewriteResult }): Promise<RewriteResult> {
  const t0 = Date.now();
  const deadline = t0 + (o.timeBudgetMs ?? 22 * 60_000);
  const left = () => deadline - Date.now();
  const log = (stage: string, msg: string) => o.onProgress?.(`[${stage}] ${msg}`);
  mkdirSync(o.outDir, { recursive: true });
  const maxRepairs = o.maxRepairs ?? 5, maxBeh = o.maxBehaviourRepairs ?? 1;
  const chk = () => { if (o.signal?.aborted) throw new RewriteCancelled(); };

  // ---- 1. source + spec
  log('source', o.source.kind === 'address' ? `fetching verified source for ${o.source.address} on ${o.source.chain}` : `reading ${o.source.path}`);
  let comp: AstCompile; let license: string | null = null;
  let vc: VerifiedContract | null = null;
  let proxyInfo: ProxyInfoSpec | null = null;
  if (o.source.kind === 'address') {
    const given = await fetchVerifiedContract(o.source.chain, o.source.address);
    const tgt = await resolveRewriteTarget(o.source.chain, given);
    proxyInfo = tgt.proxy;
    vc = tgt.vc;
    if (proxyInfo) log('source', `${o.source.address} is a ${proxyInfo.type} proxy (${proxyInfo.proxyName}): rewriting the implementation ${proxyInfo.implementationName} at ${proxyInfo.implementation}${proxyInfo.initializer ? `, initialised through ${proxyInfo.initializer}()` : ''}`);
    license = vc.license;
    comp = await compileVerified(vc);
  } else {
    const content = readFileSync(o.source.path, 'utf8');
    const name = o.source.contract ?? (/^\s*(?:abstract\s+)?contract\s+(\w+)/m.exec(content.split('\n').filter((l) => !/^\s*interface\b/.test(l)).join('\n'))?.[1] ?? basename(o.source.path, '.sol'));
    license = /SPDX-License-Identifier:\s*([^\s*]+)/.exec(content)?.[1] ?? null;
    comp = await compileWithAst({ compilerVersion: DEFAULT_SOLC, stdJsonInput: stdInputForSource(basename(o.source.path), content), contract: name });
  }
  const spec: ContractSpec = extractSpec(comp, o.source.kind === 'address' ? { address: o.source.address, ...(vc ? { chainId: vc.chainId } : {}), license, ...(proxyInfo ? { proxy: proxyInfo } : {}) } : { file: o.source.path, license });
  log('spec', `${spec.name}: ${spec.functions.filter((f) => f.visibility === 'public' || f.visibility === 'external').length} public functions, ${spec.stateVars.length} state variables, standards [${spec.tokenStandards.join(', ')}], ${spec.nonPortable.length} non-portable feature kinds`);
  writeJson(o.outDir, 'spec.json', spec);
  // hard sanity gate: the spec must agree with the compiler ABI (and the verified ABI from the explorer); otherwise nothing below may report success
  const gate = checkSpecAgainstAbi(spec, comp.abi, vc?.abi as any[] | undefined);
  if (!gate.ok) {
    log('spec', `SANITY GATE FAILED: ${more(gate.problems, 4)}`);
    return earlyStop(o, spec, gate.problems, t0);
  }

  chk();
  // ---- 2. scenarios on the original
  const foldName = proxyInfo?.initializer ?? spec.foldedInitializer;
  const initItem = foldName ? (comp.abi as any[]).filter((x) => x.type === 'function' && x.name === foldName).sort((a, b) => (b.inputs?.length ?? 0) - (a.inputs?.length ?? 0))[0] ?? null : null;
  let prepared: PreparedOriginal;
  try { prepared = await prepareOriginal(o.source.kind === 'address' ? o.source.chain : 'eth', vc ?? ({ libraries: {}, constructorArgs: null } as any), comp); } catch (e) { return groundTruthFailed(o, spec, proxyInfo, (e as Error).message, t0); }
  for (const n of prepared.notes) log('scenarios', n);
  const runner = await OriginalRunner.start(comp.abi, prepared.creation, undefined, { ...(foldName ? { proxy: { initializer: initItem } } : {}), libraries: prepared.libraries, ctorArgs: foldName ? prepared.ctorArgs : null });
  let set: ScenarioSet;
  let groundTruthReason = '';
  try {
    await verifyInitialValues(spec, runner, { onProgress: (m) => log('spec', m) });
    writeJson(o.outDir, 'spec.json', spec);
    log('scenarios', 'exploring the original on a local chain');
    set = await generateScenarios(spec, runner, { onProgress: (m) => log('scenarios', m) });
    const gt = await recordGroundTruth(set, runner, (m) => log('scenarios', m));
    if (gt.fatal.length) { groundTruthReason = gt.fatal[0]!; log('scenarios', `warning: ${gt.fatal.length} scenarios could not run on the original: ${gt.fatal[0]}`); }
    set.scenarios = set.scenarios.filter((s) => !gt.fatal.some((f) => f.startsWith(`${s.id}:`)));
  } finally { await runner.stop(); }
  if (set.scenarios.length === 0) return groundTruthFailed(o, spec, proxyInfo, groundTruthReason || 'the original could not be deployed and run on the local chain', t0);
  // state set by later initialisers (initializeV2*, reinitializer(n)): read from the SOURCE chain, applied where code can determine it, reported otherwise
  let reinit: ReinitState | undefined;
  if (o.source.kind === 'address') {
    try { reinit = await discoverReinitState(spec, comp.abi as any[], chainReader(o.source.chain), o.source.address); } catch (e) { reinit = { applied: [], notApplied: [{ fn: '(all re-initialisers)', reason: `the source chain could not be read: ${(e as Error).message.slice(0, 100)}` }] }; }
  } else reinit = await discoverReinitState(spec, comp.abi as any[], null, null);
  const deadNotes = await dropDeadBranches(spec, comp.abi as any[], o.source.kind === 'address' ? chainReader(o.source.chain) : null, o.source.kind === 'address' ? o.source.address : null).catch(() => [] as string[]);
  for (const n of deadNotes) log('spec', n);
  alignGetterExpectations(set, spec, reinit, comp.abi as any[]);
  if (reinit.applied.length || reinit.notApplied.length) { log('spec', `later initialisers: ${reinit.applied.length} value(s) applied from the source chain, ${reinit.notApplied.length} not applicable`); writeJson(o.outDir, 'spec.json', spec); }
  writeJson(o.outDir, 'scenarios.json', set);
  log('scenarios', `${set.scenarios.length} scenarios with ground truth recorded`);

  chk();
  // ---- 3. design / template
  const tokenFacts = !o.noTemplate && o.source.kind === 'address' && /ERC-20/.test(spec.tokenStandards.join()) ? await readTokenFacts(o.source.chain, o.source.address) : {};
  if (tokenFacts.source) log('design', `token facts read from ${tokenFacts.source}: ${tokenFacts.name ?? '?'} / ${tokenFacts.symbol ?? '?'} / ${tokenFacts.decimals ?? '?'} decimals / supply ${tokenFacts.totalSupply ?? '?'}`);
  const tpl = o.noTemplate ? null : o.pack.templates(spec, { ...(o.decimals !== undefined ? { decimals: o.decimals } : {}), facts: tokenFacts });
  const verdict = classifyStandard(spec);
  const design = tpl ? tpl.design : o.pack.design(spec, o.decimals !== undefined ? { decimals: o.decimals } : {});
  writeJson(o.outDir, 'design.json', design);
  log('design', tpl ? `${tpl.standard}: standard-first template, no model-written code` : `model path${verdict.reasons.length ? ` (not a plain standard: ${more(verdict.reasons, 3)})` : ''}; ${o.pack.units(design).length} instructions`);

  const compileRounds: RoundRecord[] = [];
  const behRounds: RoundRecord[] = [];
  let files: ProjectFiles = {};
  let compiled: CompileResult | null = null;
  let compileRound: number | null = null;
  const fidelity: Record<string, string> = Object.create(null);
  const bodies: Record<string, string> = Object.create(null);
  let outcomes: ScenarioOutcomeLike[] = [];
  let conformance: string[] = []; let fatal: string | undefined;
  let ran = false;
  let stopNote: string | undefined;

  /** build report + project from the current state, write them, remember them as the best-so-far checkpoint */
  const finalize = (): RewriteResult => {
    const counts = { passed: outcomes.filter((x) => x.status === 'passed').length, failed: outcomes.filter((x) => x.status === 'failed').length, notRunnable: outcomes.filter((x) => x.status === 'not-runnable').length, documented: outcomes.filter((x) => x.status === 'documented-difference').length };
  const notTranslatedFns = new Map<string, string>();
  const differences = new Map<string, string[]>();
  for (const n of design.notTranslated ?? []) for (const w of String(n.where).split(/,\s*/)) if (spec.functions.some((f) => f.name === w)) { if (tpl) { const a = differences.get(w) ?? []; a.push(`${n.feature}: ${n.reason}`); differences.set(w, a); } else notTranslatedFns.set(w, `${n.feature}: ${n.reason}`); }
  if (!tpl) for (const ins of design.instructions ?? []) for (const n of ins.notes) if (/not translated|DEVIATION|skipped|could not be resolved/i.test(n)) { const a = differences.get(ins.solidity) ?? []; a.push(n); differences.set(ins.solidity, a); }
  if (tpl && (design as { allowanceNote?: string }).allowanceNote) for (const f of ['approve', 'transferFrom']) { const a = differences.get(f) ?? []; a.push((design as { allowanceNote?: string }).allowanceNote!); differences.set(f, a); }
  // return values: bool returns that were `true` on every successful original call are documented (success == true); others are flagged as not compared
  const facts = { seen: new Map<string, Set<string>>() };
  for (const sc of set.scenarios) for (const st of sc.steps) if (st.type === 'call' && st.expect?.status === 'success' && st.expect.returns) { const k = JSON.stringify(st.expect.returns); (facts.seen.get(st.fn) ?? facts.seen.set(st.fn, new Set()).get(st.fn)!).add(k); }
  const uncompared = uncomparedReturnsOf(spec, facts);
  const boolReturnFns = new Set(spec.functions.filter((f) => f.kind === 'function' && f.mutability !== 'view' && f.mutability !== 'pure' && f.returns.length > 0 && f.returns.every((r) => r.type.kind === 'bool') && !uncompared.has(f.name)).map((f) => f.name));
  const functions = buildFunctionReports(spec, outcomes, { unitOf: (f) => o.pack.unitOf(design, f), fidelity, notTranslatedFns, differences, template: !!tpl, set, uncompared, boolReturnFns, absent: new Map([...((design as { droppedFns?: { fn: string; reason: string }[] }).droppedFns ?? []).map((d) => [d.fn, d.reason] as [string, string]), ...spec.functions.filter((f) => f.excluded).map((f) => [f.name, f.excluded!.reason] as [string, string])]) });
  const probes = set.scenarios.filter((x) => x.probe).map((x) => ({ fn: x.probe!, result: exposedUnit(x.probe!) ? 'EXPOSED' as const : 'not exposed' as const }));
  const exposedProblems = spec.functions.filter((f) => f.excluded && f.mutability !== 'view' && f.mutability !== 'pure' && exposedUnit(f.name)).map((f) => `${f.name} (${f.excluded!.category}) is an entry point of the rewrite`);
  // static security lint (model-written code only) + negative scenarios that the rewrite allowed
  const lint = tpl ? [] : lintSecurity(o.pack.id, spec, (fn) => o.pack.unitOf(design, fn), bodies, design as any);
  const lintProblems = lint.filter((x) => x.status === 'FAIL').flatMap((x) => x.problems.map((p) => `${x.fn}: ${p}`));
  const negBad = negativeFailures(set, outcomes);
  const negCount = set.scenarios.filter((x) => x.negative && exposedUnit(x.negative.fn)).length;
  const failClosedExposed = spec.functions.filter((f) => f.kind === 'function' && f.mutability !== 'view' && f.mutability !== 'pure' && !f.excluded && untranslatable(f) && exposedUnit(f.name)).map((f) => `${f.name} (${untranslatable(f)!.feature}) is an entry point of the rewrite`);
  const secProblems = [...exposedProblems, ...failClosedExposed.filter((x) => !lintProblems.some((l) => l.startsWith(x.split(' ')[0]!))), ...lintProblems, ...negBad];
  const verdict2 = decideVerdict({ compileOk: !!compiled?.ok, ran, behaviourCheck: o.behaviourCheck !== false, outcomes, conformance, functions, template: !!tpl, set });
  if (stopNote) verdict2.reasons.push(stopNote);
  if (secProblems.length) { verdict2.status = 'FAILED-BEHAVIOUR'; verdict2.reasons.unshift(`SECURITY: ${more(secProblems, 6)}: privileged functions must never be exposed and every guard of the original must be enforced before the first effect`); }
  if (proxyInfo) verdict2.reasons.push(`rewrote the implementation ${proxyInfo.implementationName} (${proxyInfo.implementation}) behind the ${proxyInfo.type} proxy ${proxyInfo.address}; the upgradeability and admin of the original are not reproduced`);
  // quantified explanation for failures that are decimal down-scaling (the original's amounts are divided by `divisor` on this target)
  const divisor = BigInt((design as { decimals?: { divisor?: string } }).decimals?.divisor ?? '1');
  if (divisor > 1n) {
    let near = 0, total = 0;
    for (const o2 of outcomes) for (const m of o2.mismatches) {
      if (m.documented || typeof m.expected !== 'string' || typeof m.actual !== 'string' || !/^\d+$/.test(m.expected) || !/^\d+$/.test(m.actual)) continue;
      total++;
      const e = BigInt(m.expected), a = BigInt(m.actual), scaled = a * divisor;
      const diff = e > scaled ? e - scaled : scaled - e;
      if (e > 0n && diff * 100n <= e) near++; // within 1 % of the original once scaled back
    }
    if (near > 0) verdict2.reasons.push(`${near} of ${total} numeric mismatches are within 1% of the original after scaling by 10^${divisor.toString().length - 1}: consistent with truncation from decimal down-scaling (every integer division of a scaled amount can lose up to 1 unit = ${divisor} original base units, and rates such as reward/duration lose it on every second of accrual); a design that keeps extra internal precision would remove it (not generated)`);
  }
  const extraCaps = (design as { extraCapabilities?: { name: string }[] }).extraCapabilities ?? [];
  if (extraCaps.length) verdict2.reasons.push(`the target contract has capabilities the original lacks: ${extraCaps.map((x) => x.name).join(', ')}`);
  if (reinit?.notApplied.length && (verdict2.status === 'PASSED' || verdict2.status === 'PASSED-WITH-DOCUMENTED-DIFFERENCES')) verdict2.status = 'PARTIALLY-VERIFIED';
  if (reinit?.notApplied.length) verdict2.reasons.push(`WARNING: ${reinit.notApplied.length} re-initialiser effect(s) of the source chain are NOT in the rewrite (${more(reinit.notApplied.map((x) => x.fn), 4)}): the original as deployed today may hold state the rewrite starts without; see "State set by later initialisers"`);
  const status: RewriteStatus = verdict2.status;
  const security = { checked: probes.length, probes, problems: secProblems, unsafe: secProblems.length > 0, deadBranches: deadNotes, lint, negativeFailures: negBad, negativeScenarios: negCount };

  const usage = o.llm.usage();
  const report: RewriteReport = {
    version: 1, contract: spec.name, source: spec.source, target: o.pack.id, path: tpl ? 'template' : 'model', ...(tpl ? { standard: tpl.standard } : {}), status, statusReasons: verdict2.reasons, coverage: verdict2.coverage,
    compile: { ok: !!compiled?.ok, round: compileRound, rounds: compileRounds },
    behaviour: { ran, passed: counts.passed, failed: counts.failed, notRunnable: counts.notRunnable, documented: counts.documented, total: outcomes.length, rounds: behRounds, conformance, ...(fatal ? { fatal } : {}) },
    ...(reinit && (reinit.applied.length || reinit.notApplied.length) ? { reinit } : {}),
    functions, nonPortable: (o.pack.describeNonPortable?.(spec) ?? spec.nonPortable).map((n) => ({ id: n.id, title: n.title, where: n.where, treatment: n.treatment, detail: n.detail })), notTranslated: design.notTranslated ?? [], security, ...(proxyInfo ? { proxy: proxyInfo } : {}), designNotes: design.notes ?? [], extraCapabilities: (design as { extraCapabilities?: { name: string; reason: string }[] }).extraCapabilities ?? [],
    deploy: o.pack.deployCommands(design, spec), usage, wallSecs: (Date.now() - t0) / 1000, outcomes, scenarioCount: set.scenarios.length, ...(o.pack.reportLabels ? { labels: o.pack.reportLabels } : {}),
    ...(tpl && (design as { decimalsNote?: string }).decimalsNote ? { decimalsNote: (design as { decimalsNote?: string }).decimalsNote! } : {}),
  };
  writeTree(join(o.outDir, 'project'), files);
  writeJson(o.outDir, 'report.json', report);
  writeFileSync(join(o.outDir, 'report.md'), renderReport(report));
  if (compiled && Object.keys(compiled.artifacts).length === 0 && !compiled.ok) writeFileSync(join(o.outDir, 'last_compile.log'), compiled.log.slice(-60000));
  log('report', `${status}: wrote ${o.outDir}/report.md`);
  void sourceLookup; void dirname; void CmcError;
  const result: RewriteResult = { status, report, outDir: o.outDir };
  ck.latest = result;
  return result;

  };

  if (tpl) {
    files = { ...tpl.files };
    if (tpl.needsProgram) {
      // a hand-written template that is still a program: compile it once (no model, so no repair loop)
      log('compile', 'template program: compiling in the sandbox');
      compiled = await o.pack.compile(files);
      compileRound = compiled.ok ? 0 : null;
      compileRounds.push({ kind: 'compile', round: 0, ok: compiled.ok, seconds: compiled.seconds, detail: compiled.ok ? 'template program' : 'template program does not compile' });
      if (!compiled.ok) writeFileSync(join(o.outDir, 'compile_round0.log'), compiled.log.slice(-60000));
    } else {
      compiled = { ok: true, log: '', seconds: 0, artifacts: {} };
      compileRound = 0;
      compileRounds.push({ kind: 'compile', round: 0, ok: true, seconds: 0, detail: `no program to compile (${o.pack.reportLabels?.template ?? 'native SPL token'})` });
    }
  } else {
    // ---- 4. generation (one request per instruction)
    const units = o.pack.units(design);
    chk();
    log('generate', `${units.length} instruction prompts`);
    const ctx = { spec, design, sources: comp.sources };
    await Promise.all(units.map(async (u) => {
      const p = o.pack.generatePrompt(ctx, u);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await o.llm.chat([{ role: 'system', content: p.system }, { role: 'user', content: p.user }], { label: `gen_${u}`, signal: o.signal });
          const parsed = parseBodies(r.content);
          if (parsed.bodies[u]) { bodies[u] = parsed.bodies[u]!; if (parsed.fidelity[u]) fidelity[u] = parsed.fidelity[u]!; log('generate', `${u}: body received (${r.tokensOut} tokens, ${r.secs.toFixed(0)} s)`); return; }
          log('generate', `${u}: no body block in the answer${r.finish === 'length' ? ' (truncated)' : ''}, retrying`);
        } catch (e) { log('generate', `${u}: ${(e as Error).message}`); }
      }
    }));
    // ---- 5. compile-repair
    for (let round = 0; round <= maxRepairs; round++) {
      chk();
      files = o.pack.assemble(spec, design, bodies);
      log('compile', `round ${round}: compiling in the sandbox`);
      const c = await o.pack.compile(files);
      compiled = c;
      // Rust targets: a dead `let x = f()?;` (unused variable) is an error for the repair step, not a warning (its `?` side effects hide a dropped statement)
      const dead = c.ok && round < maxRepairs && (o.pack.id === 'solana' || o.pack.id === 'cosmwasm') ? deadStatements(c.log) : '';
      if (c.ok) compileRound = round;
      const rlog = dead || c.log;
      const blame = o.pack.blame(rlog, design);
      compileRounds.push({ kind: 'compile', round, ok: c.ok && !dead, seconds: c.seconds, detail: dead ? `dead statements (unused variables): blamed ${[...blame.units].join(', ') || 'generated code'}` : c.ok ? '' : `blamed: ${[...blame.units].join(', ') || 'generated code'}` });
      if (c.ok && !dead) { log('compile', `round ${round}: compiled (${c.seconds.toFixed(0)} s)`); break; }
      writeFileSync(join(o.outDir, `compile_round${round}.log`), rlog.slice(-60000));
      if (round === maxRepairs) { log('compile', `FAILED after ${maxRepairs} repair rounds`); break; }
      if (left() < c.seconds * 1000 + 4 * 60_000) { stopNote = `compile repair stopped: time budget exhausted after round ${round}`; log('compile', stopNote); break; }
      const targets = [...blame.units].filter((u) => bodies[u] !== undefined || true);
      if (!targets.length) { log('compile', 'the errors are not in any model-written handler; repairing all units that exist'); targets.push(...o.pack.units(design)); }
      log('compile', `round ${round}: failed, asking the model to repair ${targets.join(', ')}`);
      await Promise.all(targets.map(async (u) => {
        const p = o.pack.repairPrompt(design, u, bodies[u] ?? '    // (no body was produced)\n    Ok(())', rlog);
        try {
          const r = await o.llm.chat([{ role: 'system', content: p.system }, { role: 'user', content: p.user }], { label: `repair${round + 1}_${u}`, signal: o.signal, readTimeoutMs: 120_000, totalTimeoutMs: Math.max(60_000, Math.min(8 * 60_000, left() - c.seconds * 1000 - 60_000)), retries: 1 });
          const parsed = parseBodies(r.content);
          if (parsed.bodies[u]) { bodies[u] = parsed.bodies[u]!; if (parsed.fidelity[u]) fidelity[u] = parsed.fidelity[u]!; }
        } catch (e) { log('compile', `${u}: repair request failed: ${(e as Error).message}`); }
      }));
    }
  }

  /** probes of functions the rewrite does not have pass by construction; probes of functions it DOES expose run like any scenario */
  const exposedUnit = (fn: string) => o.pack.unitOf(design, fn);
  const runSet = (): ScenarioSet => ({ ...set, scenarios: set.scenarios.filter((x) => (!x.probe || exposedUnit(x.probe)) && (!x.negative || exposedUnit(x.negative.fn))) });
  const checkpoint = () => { const r = finalize(); try { o.onCheckpoint?.(r); } catch { /* a callback must never break the run */ } return r; };
  // the first compile result is already a result: persist it before anything slow happens
  if (compiled) checkpoint();

  // ---- 6. behaviour check
  const score = () => outcomes.filter((x) => x.status === 'passed').length - 10 * outcomes.filter((x) => x.status === 'failed').length - 5 * conformance.length;
  let best: { score: number; round: number; bodies: Record<string, string>; fid: Record<string, string>; files: ProjectFiles; compiled: CompileResult | null; outcomes: ScenarioOutcomeLike[]; conformance: string[]; fatal?: string; ran: boolean } | null = null;
  let lastRunSecs = 30;
  if (compiled?.ok && o.behaviourCheck !== false) {
    for (let br = 0; br <= maxBeh; br++) {
      chk();
      log('behaviour', `round ${br}: running ${set.scenarios.length} scenarios on the rewrite`);
      const run = await o.pack.runScenarios(files, compiled!, design, spec, runSet());
      outcomes = tpl ? documentSelfSpend(o.pack.id, set, run.outcomes) : run.outcomes; conformance = run.conformance; fatal = run.fatal; ran = !run.fatal; lastRunSecs = run.seconds;
      const failed = outcomes.filter((x) => x.status === 'failed');
      const nr = outcomes.filter((x) => x.status === 'not-runnable').length;
      const nPassed = outcomes.filter((x) => x.status === 'passed').length;
      behRounds.push({ kind: 'behaviour', round: br, ok: !run.fatal && failed.length === 0 && conformance.length === 0, seconds: run.seconds, detail: `${nPassed} passed, ${failed.length} failed, ${nr} not runnable${conformance.length ? `, ${conformance.length} conformance problems` : ''} (run ${run.seconds.toFixed(0)} s, ${Math.round((Date.now() - t0) / 1000)} s since the start, ${Math.max(0, Math.round(left() / 1000))} s of the budget left)` });
      log('behaviour', `round ${br}: ${behRounds[behRounds.length - 1]!.detail}`);
      if (!best || score() >= best.score) best = { score: score(), round: br, bodies: { ...bodies }, fid: { ...fidelity }, files, compiled, outcomes, conformance, ...(fatal ? { fatal } : {}), ran };
      checkpoint();
      if (tpl || br === maxBeh || run.fatal) break;
      if (!failed.length && !conformance.length && nr <= outcomes.length / 2) break;
      // a repair round must fit in the remaining time budget (compile + run + a bounded model phase)
      const estimate = (compiled?.seconds ?? 60) * 1000 + lastRunSecs * 1000 + 6 * 60_000;
      if (left() < estimate) { stopNote = `repair stopped: time budget exhausted after round ${br} (${Math.round(left() / 1000)} s left, a round needs about ${Math.round(estimate / 1000)} s)`; log('behaviour', stopNote); break; }
      // setup / deploy failure (nothing passes, the constructor scenarios fail): do not send per-function repairs for a problem in the harness or the constructor
      const setupFailed = outcomes.length > 0 && nPassed === 0 && outcomes.filter((x) => x.kind === 'init' && x.status === 'passed').length === 0;
      const problems = new Map<string, string[]>();
      const brief = (t: string) => ell(t, 360);
      if (setupFailed) {
        const u = o.pack.unitOf(design, 'constructor');
        const first = failed.flatMap((f) => f.mismatches.filter((x) => !x.documented).slice(0, 1).map((m) => `scenario "${f.title}": at ${m.at}, ${m.what}: expected ${showValue(m.expected, 80)}, got ${showValue(m.actual, 80)}`))[0] ?? outcomes.flatMap((x) => x.notRunnable)[0] ?? 'no scenario passed';
        log('behaviour', `round ${br}: 0 scenarios pass, including the deployment: treated as a setup/deploy failure (first problem: ${ell(first, 160)}); only the constructor is sent for repair`);
        if (u) problems.set(u, [brief(first)]);
      } else {
        for (const f of failed) { const u = f.fn ? o.pack.unitOf(design, f.fn) : o.pack.unitOf(design, 'constructor'); if (!u) continue; const m = f.mismatches.find((x) => !x.documented)!; const arr = problems.get(u) ?? problems.set(u, []).get(u)!; if (arr.length < 2) arr.push(brief(`scenario "${f.title}": at step ${m.at}, ${m.what}: expected ${showValue(m.expected, 80)}, got ${showValue(m.actual, 80)}`)); }
        for (const f of outcomes.filter((x) => x.status === 'not-runnable' && x.notRunnable.some((s) => /unresolved account|runner_error|account/i.test(s))).slice(0, 3)) { const u = f.fn ? o.pack.unitOf(design, f.fn) : null; if (u) { const arr = problems.get(u) ?? problems.set(u, []).get(u)!; if (arr.length < 2) arr.push(brief(`scenario "${f.title}" could not run: ${f.notRunnable[0]}`)); } }
      }
      if (!problems.size) break;
      const snapshot = { bodies: { ...bodies }, files, compiled, fid: { ...fidelity } };
      log('behaviour', `round ${br}: asking the model to fix ${[...problems.keys()].join(', ')}`);
      // each request is bounded: a few failing scenarios, a short output, no endless reasoning
      const modelBudget = Math.max(60_000, Math.min(6 * 60_000, left() - (compiled?.seconds ?? 60) * 1000 - lastRunSecs * 1000 - 30_000));
      await Promise.all([...problems.entries()].map(async ([u, ps]) => {
        const p = o.pack.behaviourRepairPrompt(design, u, bodies[u] ?? '', ps.slice(0, 3));
        try {
          const r = await o.llm.chat([{ role: 'system', content: p.system }, { role: 'user', content: p.user }], { label: `behrepair${br + 1}_${u}`, signal: o.signal, maxTokens: 8000, readTimeoutMs: 90_000, totalTimeoutMs: modelBudget, retries: 0 });
          const parsed = parseBodies(r.content);
          if (parsed.bodies[u]) { bodies[u] = parsed.bodies[u]!; if (parsed.fidelity[u]) fidelity[u] = parsed.fidelity[u]!; }
        } catch (e) { if (o.signal?.aborted) throw new RewriteCancelled(); log('behaviour', `${u}: ${(e as Error).message}`); }
      }));
      files = o.pack.assemble(spec, design, bodies);
      const c = await o.pack.compile(files);
      compileRounds.push({ kind: 'compile', round: compileRounds.length, ok: c.ok, seconds: c.seconds, detail: 'after behaviour repair' });
      if (!c.ok) { log('behaviour', 'a behaviour repair broke the build; restoring the last compiling version (its failures stay in the report)'); writeFileSync(join(o.outDir, 'compile_after_behaviour_repair.log'), c.log.slice(-60000)); Object.keys(bodies).forEach((k) => delete bodies[k]); Object.assign(bodies, snapshot.bodies); Object.assign(fidelity, snapshot.fid); files = snapshot.files; compiled = snapshot.compiled; stopNote = `behaviour repair round ${br + 1} broke the build; the version of round ${br} was kept`; break; }
      compiled = c;
    }
    // a repair that made things worse is dropped: the best round wins
    if (best && behRounds.length > 1 && score() < best.score) {
      Object.keys(bodies).forEach((k) => delete bodies[k]); Object.assign(bodies, best.bodies); Object.assign(fidelity, best.fid);
      files = best.files; compiled = best.compiled; outcomes = best.outcomes; conformance = best.conformance; fatal = best.fatal; ran = best.ran;
      stopNote = `the last repair made the rewrite worse; the result of round ${best.round} was kept`;
    }
  }

  chk();
  // ---- 7. status + report (the same finalize() wrote the checkpoints)
  const counts = { passed: outcomes.filter((x) => x.status === 'passed').length, failed: outcomes.filter((x) => x.status === 'failed').length, notRunnable: outcomes.filter((x) => x.status === 'not-runnable').length, documented: outcomes.filter((x) => x.status === 'documented-difference').length };

  return finalize();
}

/** The original could not be run locally, so no ground truth exists: nothing was behaviour-checked. Always UNVERIFIED, nothing is generated. */
function groundTruthFailed(o: RewriteOptions, spec: ContractSpec, proxy: ProxyInfoSpec | null, reason: string, t0: number): RewriteResult {
  const r = earlyStop(o, spec, [reason], t0, true);
  r.report.statusReasons = [`ground truth could not be recorded: ${reason}; nothing was behaviour-checked and nothing was generated`, ...(proxy ? [`rewrote the implementation ${proxy.implementationName} (${proxy.implementation}) behind the ${proxy.type} proxy ${proxy.address}; the upgradeability and admin of the original are not reproduced`] : [])];
  r.report.coverage.summary = '0 functions verified (ground truth could not be recorded)';
  if (proxy) r.report.proxy = proxy;
  r.report.behaviour.fatal = 'ground truth could not be recorded';
  writeJson(o.outDir, 'report.json', r.report); writeFileSync(join(o.outDir, 'report.md'), renderReport(r.report));
  return r;
}

/** The spec failed its sanity gate: write what we know and stop with an UNVERIFIED report (never PASSED). */
function earlyStop(o: RewriteOptions, spec: ContractSpec, problems: string[], t0: number, groundTruth = false): RewriteResult {
  const report: RewriteReport = {
    version: 1, contract: spec.name, source: spec.source, target: o.pack.id, path: 'model', status: 'UNVERIFIED',
    statusReasons: [`the extracted spec disagrees with the contract's ABI, so nothing was generated: ${more(problems, 5)}`],
    coverage: { functionsTotal: 0, functionsVerified: 0, functionsUnverified: [], uncheckedFunctions: [], trivialOnlyFunctions: [], notTranslatedFunctions: [], uncomparedReturns: [], notRunnableScenarios: [], getters: { planned: 0, checked: 0, mismatched: 0, notCompared: [] }, functionsAbsent: [], functionsPresent: 0, failedFunctions: [], otherUnverifiedFunctions: [], summary: '0 of 0 functions verified (spec sanity gate failed)' },
    compile: { ok: false, round: null, rounds: [] }, behaviour: { ran: false, passed: 0, failed: 0, notRunnable: 0, documented: 0, total: 0, rounds: [], conformance: [], fatal: 'spec sanity gate' },
    functions: [], nonPortable: [], notTranslated: [], designNotes: [], extraCapabilities: [], deploy: [], usage: o.llm.usage(), wallSecs: (Date.now() - t0) / 1000, outcomes: [], scenarioCount: 0, ...(o.pack.reportLabels ? { labels: o.pack.reportLabels } : {}),
  };
  writeJson(o.outDir, 'report.json', report);
  writeFileSync(join(o.outDir, 'report.md'), renderReport(report));
  o.onProgress?.(`[report] UNVERIFIED (spec sanity gate): wrote ${o.outDir}/report.md`);
  return { status: 'UNVERIFIED', report, outDir: o.outDir };
}

function writeJson(dir: string, name: string, v: unknown) { writeFileSync(join(dir, name), JSON.stringify(v, null, 2) + '\n'); }
