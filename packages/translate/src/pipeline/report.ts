import type { ContractSpec, ScenarioSet } from '../types.js';
import type { ScenarioOutcomeLike } from '../targets/pack.js';

/**
 * PASSED: compiles; every state-changing function has a passing scenario with non-trivial values; no failed and no not-runnable scenarios;
 *   no unchecked function; public state getters match the original after initialisation.
 * PASSED-WITH-DOCUMENTED-DIFFERENCES: same coverage as PASSED, but some differences are by design and are listed (not hidden behaviour).
 * PARTIALLY-VERIFIED: compiles and nothing failed, but coverage is incomplete (unchecked functions, trivial-value-only functions, not-runnable
 *   scenarios, not translated functions, uncompared return values). The report lists exactly what is not verified up front.
 * FAILED-COMPILE / FAILED-BEHAVIOUR: as named. UNVERIFIED: behaviour could not be checked at all (or the spec failed its sanity gate).
 */
export type RewriteStatus = 'PASSED' | 'PASSED-WITH-DOCUMENTED-DIFFERENCES' | 'PARTIALLY-VERIFIED' | 'FAILED-COMPILE' | 'FAILED-BEHAVIOUR' | 'UNVERIFIED';

export interface FunctionReport {
  name: string;
  status: 'translated' | 'translated-with-differences' | 'not translated' | 'not-available-on-target';
  unit: string | null;
  fidelity: string | null;
  differences: string[];
  scenarios: { passed: number; failed: number; notRunnable: number; documented: number };
  /** state-changing (constructor included): needs a passing scenario with non-trivial values */
  stateChanging: boolean;
  /** passing scenario with a successful call whose values were non-trivial on the original (value coverage) */
  valueCoverage: 'valued' | 'trivial-only' | 'none' | 'n/a';
  unchecked: boolean;
  /**
   * exactly one bucket per function (mutually exclusive):
   * verified = exists on the target, a PASSED scenario with non-trivial values, nothing failed;
   * absent-by-design = the target has no equivalent (listed up front, never counted as verified);
   * not-translated, unchecked (no scenario), failed, trivial-only (only trivial values), unverified (scenarios exist but none passed with non-trivial values);
   * view = not state-changing.
   */
  bucket: 'verified' | 'absent-by-design' | 'not-translated' | 'unchecked' | 'failed' | 'trivial-only' | 'unverified' | 'view';
  /** why the function has no equivalent on the target (absent-by-design only) */
  absentReason?: string;
  /** return values the target runner cannot compare and that are not constantly `true` */
  uncomparedReturns?: string;
  failing: { scenario: string; at: string; what: string; expected: unknown; actual: unknown }[];
}

export interface Coverage {
  /** state-changing functions of the ORIGINAL (constructor included) = verified + absentByDesign + unverified */
  functionsTotal: number;
  /** exist on the target and were verified with non-trivial values */
  functionsVerified: number;
  /** the target has no equivalent (by design, listed up front); never counted as verified */
  functionsAbsent: string[];
  /** functions that exist on the target (functionsTotal - functionsAbsent.length) */
  functionsPresent: number;
  /** present functions that are not verified (every other bucket except verified/absent) */
  functionsUnverified: string[];
  failedFunctions: string[];
  /** present functions with scenarios but none passed with non-trivial values (and none failed) */
  otherUnverifiedFunctions: string[];
  uncheckedFunctions: string[];
  trivialOnlyFunctions: string[];
  notTranslatedFunctions: string[];
  uncomparedReturns: string[];
  notRunnableScenarios: { id: string; title: string; reason: string }[];
  /** distinct read-only observations (public getters and views) compared against the original; mismatched is a subset of checked; 0 when nothing ran */
  getters: { planned: number; checked: number; mismatched: number; /** read-only observations the target could not compare (never counted as checked) */ notCompared: string[] };
  summary: string;
}

export interface RoundRecord { kind: 'compile' | 'behaviour'; round: number; ok: boolean; seconds: number; detail: string }

export interface RewriteReport {
  version: 1;
  contract: string;
  source: ContractSpec['source'];
  target: string;
  path: 'template' | 'model';
  standard?: string;
  status: RewriteStatus;
  compile: { ok: boolean; round: number | null; rounds: RoundRecord[] };
  /** machine readable coverage: what was verified and what was not */
  coverage: Coverage;
  /** why the status is what it is (one line each) */
  statusReasons: string[];
  behaviour: { ran: boolean; passed: number; failed: number; notRunnable: number; documented: number; total: number; rounds: RoundRecord[]; conformance: string[]; fatal?: string };
  functions: FunctionReport[];
  nonPortable: { id: string; title: string; where: string[]; treatment: string; detail: string }[];
  notTranslated: { feature: string; where: string; reason: string }[];
  /** set when the address was a proxy: the rewrite targets the implementation behind it */
  proxy?: { address: string; type: string; implementation: string; proxyName: string; implementationName: string; initializer?: string };
  designNotes: string[];
  /** initialiser / upgrade functions: each is probed on the original (called by an unprivileged account after deployment) and must not be an entry point of the rewrite */
  security?: {
    checked: number; probes: { fn: string; result: 'EXPOSED' | 'not exposed' }[]; problems: string[];
    /** true when any SECURITY check failed: the rewrite must not be deployed */
    unsafe?: boolean;
    /** static lint of the generated bodies (guards of the original present before the first write) */
    lint?: { fn: string; unit: string; expected: string[]; status: 'ok' | 'FAIL'; problems: string[] }[];
    /** negative scenarios (denied paths) that the rewrite allowed although the original reverted */
    negativeFailures?: string[];
    negativeScenarios?: number;
    /** branches behind a bool flag that is false on the source chain and were dropped (or kept) */
    deadBranches?: string[];
  };
  /** state set by re-initialisers on the source chain: what was applied and what could not be */
  reinit?: { applied: { fn: string; variable: string; value: string }[]; notApplied: { fn: string; reason: string }[] };
  /** capabilities the target contract HAS and the original does NOT (burn, mint, freeze, admin ...): a difference in the dangerous direction */
  extraCapabilities: { name: string; reason: string }[];
  deploy: string[];
  usage: { requests: number; tokensIn: number; tokensOut: number; modelSecs: number };
  wallSecs: number;
  decimalsNote?: string;
  outcomes: ScenarioOutcomeLike[];
  scenarioCount: number;
  /** target specific wording; absent = the Solana wording */
  labels?: { runtime: string; template: string; model: string; deployTitle: string };
}

const bar = (r: RewriteReport) => r.status === 'FAILED-COMPILE' || r.status === 'FAILED-BEHAVIOUR' ? '**FAILED**' : r.status === 'UNVERIFIED' ? '**UNVERIFIED**' : r.status === 'PARTIALLY-VERIFIED' ? '**PARTIALLY VERIFIED**' : r.status === 'PASSED' ? 'passed its behaviour checks' : 'passed its behaviour checks with documented differences';

/** Elide the middle of a long value with an explicit ellipsis, keeping both ends; never cuts a short value. */
/** explicit truncation for user-facing prose: never cuts silently */
export const ell = (t: string, max: number): string => {
  if (t.length <= max) return t;
  const cut = t.slice(0, Math.max(1, max - 1));
  // close what the cut left open (brackets, backticks, quotes) so the prose stays balanced
  const stack: string[] = [];
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  let q: string | null = null;
  for (const ch of cut) {
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '`' || ch === '"') { q = ch; continue; }
    if (pairs[ch]) stack.push(pairs[ch]!); else if (stack.length && stack[stack.length - 1] === ch) stack.pop();
  }
  return `${cut}\u2026${q ?? ''}${stack.reverse().join('')}`;
};
export const more = (list: string[], n: number): string => (list.length <= n ? list.join('; ') : `${list.slice(0, n).join('; ')}; \u2026 (+${list.length - n} more)`);

export function clip(v: unknown, max = 120): string {
  const t = typeof v === 'string' ? v : JSON.stringify(v);
  if (t === undefined) return 'undefined';
  if (t.length <= max) return t;
  const keep = Math.floor((max - 1) / 2);
  return `${t.slice(0, keep)}\u2026${t.slice(t.length - keep)}`;
}
/** JSON for display: long string values inside are elided in the middle, quotes stay balanced. */
export function showValue(v: unknown, max = 120): string {
  const cut = (x: unknown): unknown => (typeof x === 'string' && x.length > max ? `${x.slice(0, Math.floor((max - 1) / 2))}\u2026${x.slice(x.length - Math.floor((max - 1) / 2))}` : Array.isArray(x) ? x.map(cut) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, cut(y)])) : x);
  return JSON.stringify(cut(v)) ?? 'undefined';
}

export function renderReport(r: RewriteReport): string {
  const L: string[] = [];
  L.push(`# Rewrite report: ${r.contract} -> ${r.target}`, '');
  if (r.security?.unsafe) L.push('> **UNSAFE: DO NOT DEPLOY.** A security check failed (see the SECURITY reason and the Security lint section). This rewrite has a missing guard or an exposed privileged function.', '');
  L.push(r.behaviour.ran ? `> **UNAUDITED. Review before mainnet. The behaviour checks cover only the ${r.scenarioCount} scenarios listed below (what the original does on a local chain, compared with the rewrite on ${r.labels?.runtime ?? 'a local Solana runtime'}); passing them does not prove equivalence.**` : `> **UNAUDITED. Review before mainnet. NO scenario was run against this rewrite (${r.scenarioCount} were planned from the original): nothing about its behaviour is verified.**`, '');
  L.push(`**Result: ${r.status}** (${bar(r)}). ${r.coverage.summary}. Path: ${r.path === 'template' ? `standard-first template (${r.standard}, ${(r.labels?.template ?? 'native SPL token').replace(/,? ?no model-written code\.?$/i, '')}, no model-written code)` : (r.labels?.model ?? 'model-generated Anchor program (accounts, state, events and errors are generated by code; the model wrote the instruction bodies)')}.`, '');
  if (r.proxy) L.push(`> **Proxy: rewrote the implementation ${r.proxy.implementationName} (${r.proxy.implementation}) behind the ${r.proxy.type} proxy ${r.proxy.address} (${r.proxy.proxyName}). The proxy shell holds no logic and is not rewritten; the upgradeability and admin of the original are NOT reproduced.${r.proxy.initializer && r.behaviour.ran ? ` Ground truth was recorded by running the implementation behind a proxy initialised through \`${r.proxy.initializer}\`.` : r.proxy.initializer ? ' Ground truth could NOT be recorded (see below).' : ''}**`, '');
  if (r.statusReasons.length) L.push(`Why this status: ${r.statusReasons.join('; ')}.`, '');
  if (r.coverage.functionsAbsent.length) L.push(`> **${r.coverage.functionsAbsent.length} of ${r.coverage.functionsTotal} original state-changing functions have NO equivalent on this target: ${r.coverage.functionsAbsent.join(', ')}.** They were not executed and are not counted as verified; only the ${r.coverage.functionsPresent} functions that exist here were checked.`, '');
  if (r.status === 'PARTIALLY-VERIFIED' || r.status === 'UNVERIFIED') {
    const c = r.coverage;
    L.push('### Not verified', '');
    if (c.uncheckedFunctions.length) L.push(`- Unchecked functions (no successful call could be found on the original): ${c.uncheckedFunctions.join(', ')}`);
    if (c.trivialOnlyFunctions.length) L.push(`- Functions exercised only with trivial values: ${c.trivialOnlyFunctions.join(', ')}`);
    if (c.notTranslatedFunctions.length) L.push(`- Functions not translated: ${c.notTranslatedFunctions.join(', ')}`);
    if (c.uncomparedReturns.length) L.push(`- Return values not compared: ${c.uncomparedReturns.join(', ')}`);
    for (const n of c.notRunnableScenarios) L.push(`- Scenario not runnable \`${n.id}\` (${n.title}): ${clip(n.reason, 200)}`);
    L.push('');
  }
  if (r.status === 'FAILED-COMPILE') L.push('The program did not compile within the repair limit. The generated project is incomplete and must not be used.', '');
  if (r.status === 'FAILED-BEHAVIOUR' && r.behaviour.failed === 0 && r.path === 'model') {
    const conf = r.behaviour.conformance.length > 0, unsafe = !!r.security?.unsafe;
    const confText = 'The program compiles but does not follow the generated design (see "Design conformance problems"), so most scenarios could not be run. It is NOT a faithful rewrite.';
    const secText = `Every scenario that ran passed, but the static security check found a problem (see 'Security lint'), so it is marked unsafe. It is NOT cleared for use.`;
    if (conf && unsafe) L.push(confText, '', secText, '');
    else if (unsafe) L.push(secText, '');
    else L.push(confText, '');
  }
  if (r.status === 'FAILED-BEHAVIOUR' && r.behaviour.failed > 0) L.push('The program compiles but did not reproduce the original behaviour in the scenarios listed under "Failing scenarios". It is NOT a faithful rewrite.', '');
  if (r.status === 'FAILED-BEHAVIOUR' && r.behaviour.failed === 0 && r.path === 'template') L.push('Most scenarios could not even be expressed on the target because the original\'s amounts do not fit its number range at this decimals setting. This design is not usable; choose fewer decimals.', '');
  if (r.status === 'UNVERIFIED') L.push(r.behaviour.fatal === 'ground truth could not be recorded' ? '**Ground truth could not be recorded: the original could not be run on the local chain, so nothing was behaviour-checked and nothing was generated.** Treat as untested.' : 'Behaviour could not be checked (disabled, nothing runnable, or the spec failed its sanity gate). Treat as untested.', '');
  L.push('## Summary', '');
  L.push(`| | |`, `|---|---|`);
  L.push(`| compile | ${r.compile.ok ? `ok at round ${r.compile.round}` : 'FAILED'} (${r.compile.rounds.length} compile run(s)) |`);
  L.push(`| coverage | ${r.coverage.summary}; read-only observations (getters and views) compared with the original: ${r.coverage.getters.checked} of ${r.coverage.getters.planned} planned (${r.coverage.getters.mismatched} mismatched) |`);
  L.push(`| scenarios | ${r.behaviour.ran ? r.behaviour.total : `0 run (${r.scenarioCount} planned)`}: ${r.behaviour.passed} passed, ${r.behaviour.failed} failed, ${r.behaviour.notRunnable} not runnable, ${r.behaviour.documented} documented differences |`);
  L.push(`| model | ${r.usage.requests} requests, ${r.usage.tokensIn} tokens in, ${r.usage.tokensOut} tokens out, ${r.usage.modelSecs.toFixed(0)} s model time |`);
  L.push(`| wall time | ${r.wallSecs.toFixed(0)} s |`, '');
  if (r.decimalsNote) L.push(r.decimalsNote, '');
  L.push('## Functions', '', '| function | status | value coverage | scenarios (passed / failed / not runnable / documented) | notes |', '|---|---|---|---|---|');
  for (const f of r.functions) L.push(`| ${f.name} | ${f.status} | ${f.valueCoverage} | ${f.scenarios.passed} / ${f.scenarios.failed} / ${f.scenarios.notRunnable} / ${f.scenarios.documented} | ${[...f.differences, ...(f.fidelity ? [`model's own note (unverified claim, not a check): ${f.fidelity}`] : [])].join('; ').replace(/\|/g, '/')} |`);
  L.push('');
  const failing = r.functions.flatMap((f) => f.failing.map((x) => ({ fn: f.name, ...x })));
  if (failing.length) {
    L.push('## Failing scenarios', '');
    for (const x of failing) L.push(`- \`${x.scenario}\` (${x.fn}): at step ${x.at}, ${x.what}: expected ${showValue(x.expected)}, got ${showValue(x.actual)}`);
    L.push('');
  }
  const dd = r.outcomes.filter((o) => o.status === 'documented-difference');
  if (dd.length) { L.push('## Documented differences', ''); for (const o of dd) for (const m of o.mismatches) L.push(`- \`${o.id}\`: ${m.what}: original ${showValue(m.expected)}, ${r.target} ${showValue(m.actual)} (${m.documented})`); L.push(''); }
  const nr = r.outcomes.filter((o) => o.status === 'not-runnable');
  if (nr.length) { L.push('## Scenarios not runnable', ''); for (const o of nr) L.push(`- \`${o.id}\` ${o.title}: ${o.notRunnable.slice(0, 2).map((x) => clip(x, 300)).join('; ')}`); L.push(''); }
  if (r.behaviour.conformance.length) { L.push('## Design conformance problems', ''); for (const c of r.behaviour.conformance) L.push(`- ${c}`); L.push(''); }
  if (r.security?.deadBranches?.length) { L.push('## Branches decided by a flag on the source chain', ''); for (const d of r.security.deadBranches) L.push(`- ${d}`); L.push(''); }
  if (r.security?.lint?.length || r.security?.negativeScenarios) {
    const lint = r.security.lint ?? [];
    L.push('## Security lint', '', `Static check of every generated function whose original has a caller / role / token-pull guard (the guard must appear before the first state write or value transfer), plus ${r.security.negativeScenarios ?? 0} negative scenario(s) (denied paths: unauthorised caller, invalid signature, no funds). Functions that depend on signatures or on another contract's answer are not translated at all (fail closed).`, '');
    for (const x of lint) L.push(`- \`${x.fn}\`: ${x.status}${x.expected.length ? ` (checked: ${x.expected.join('; ')})` : ''}${x.problems.length ? ` -- ${x.problems.join('; ')}` : ''}`);
    for (const x of r.security.negativeFailures ?? []) L.push(`- NEGATIVE SCENARIO ALLOWED: ${x}`);
    L.push('');
  }
  if (r.reinit && (r.reinit.applied.length || r.reinit.notApplied.length)) {
    L.push('## State set by later initialisers on the source chain', '');
    for (const a of r.reinit.applied) L.push(`- applied: \`${a.variable}\` = ${a.value} (set by \`${a.fn}\`, read from the source chain)`);
    for (const a of r.reinit.notApplied) L.push(`- **could not be applied**: \`${a.fn}\`: ${a.reason}`);
    L.push('');
  }
  if (r.security && r.security.checked > 0) L.push('## Security probes', '', `Initialisers, re-initialisers and upgrade / admin functions are never translated. ${r.security.checked} probe(s) (the function called by an unprivileged account right after deployment): ${r.security.probes.map((x) => `${x.fn}: ${x.result}`).join(', ')}.`, '');
  if ((r.extraCapabilities ?? []).length) { L.push('## Extra capabilities on the target (not in the original)', '', 'The standard contract the template deploys can do these things although the original cannot. Review each one before using the token.', ''); for (const x of r.extraCapabilities!) L.push(`- **${x.name}**: ${x.reason}`); L.push(''); }
  L.push('## Non-portable features', '');
  if (!r.nonPortable.length) L.push('None detected.');
  for (const n of r.nonPortable) L.push(`- **${n.title}** (${n.treatment}) in ${n.where.join(', ') || '-'}: ${n.detail}`);
  L.push('', '## Not translated', '');
  if (!r.notTranslated.length) L.push('Nothing was dropped silently; nothing is listed as not translated.');
  for (const n of r.notTranslated) L.push(`- **${n.feature}** (${n.where}): ${n.reason}`);
  L.push('', '## Design notes', '', ...r.designNotes.filter((d) => !(r.decimalsNote && /^Decimals:/.test(d))).map((d) => `- ${d}`), '', `## ${r.labels?.deployTitle ?? 'Deploy to devnet'}`, '', '```', ...r.deploy, '```', '');
  L.push('## Rounds', '', ...[...r.compile.rounds, ...r.behaviour.rounds].map((x) => `- ${x.kind} round ${x.round}: ${x.ok ? 'ok' : 'not ok'} (${x.seconds.toFixed(0)} s) ${x.detail}`), '');
  return L.join('\n');
}

export interface ReturnFacts { /** function -> distinct JSON of returns seen on successful original calls */ seen: Map<string, Set<string>> }

/** bool-only returns that were `true` on every successful original call are equivalent to "the call did not revert". */
export function uncomparedReturnsOf(spec: ContractSpec, facts: ReturnFacts): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of spec.functions) {
    if (f.kind !== 'function' || !(f.visibility === 'public' || f.visibility === 'external') || f.mutability === 'view' || f.mutability === 'pure' || !f.returns.length) continue;
    const seen = facts.seen.get(f.name);
    const onlyBool = f.returns.every((r) => r.type.kind === 'bool');
    if (onlyBool && seen && [...seen].every((j) => /^\[(true,?)+\]$/.test(j))) continue; // documented by design, see returnDropNote
    out.set(f.name, onlyBool ? `bool return observed as ${[...(seen ?? [])].join(' / ') || 'never observed'} on the original; the ${'rewrite'} runner does not compare it` : `returns ${f.returns.map((r) => r.type.solidity).join(', ')}; the rewrite runner does not compare return values of state-changing functions`);
  }
  return out;
}
export const returnDropNote = (): string => 'bool return value dropped by design: the original returned true on every successful call and reverts otherwise, which a success/revert status reproduces';

export function buildFunctionReports(spec: ContractSpec, outcomes: ScenarioOutcomeLike[], opts: { unitOf: (fn: string) => string | null; fidelity: Record<string, string>; notTranslatedFns: Map<string, string>; differences: Map<string, string[]>; template: boolean; set?: ScenarioSet; uncompared?: Map<string, string>; boolReturnFns?: Set<string>; absent?: Map<string, string> }): FunctionReport[] {
  const fns = [...(spec.constructor ? ['constructor'] : []), ...(spec.hasReceive ? ['receive'] : []), ...(spec.hasFallback ? ['fallback'] : []), ...spec.functions.filter((f) => f.kind === 'function' && (f.visibility === 'public' || f.visibility === 'external')).map((f) => f.name)];
  const out: FunctionReport[] = [];
  const valuedBy = new Map<string, string[]>();
  for (const sc of opts.set?.scenarios ?? []) if (sc.valued) valuedBy.set(sc.id, sc.valued);
  const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  for (const name of fns) {
    const unit = opts.unitOf(name);
    const related = outcomes.filter((o) => (o.fn ?? (o.kind === 'init' ? 'constructor' : undefined)) === name);
    const sc = { passed: related.filter((o) => o.status === 'passed').length, failed: related.filter((o) => o.status === 'failed').length, notRunnable: related.filter((o) => o.status === 'not-runnable').length, documented: related.filter((o) => o.status === 'documented-difference').length };
    const diffs = [...new Set(opts.differences.get(name) ?? [])];
    const nt = opts.notTranslatedFns.get(name);
    let status: FunctionReport['status'] = 'translated';
    if ((!unit && !opts.template) || nt) { status = 'not translated'; if (nt) diffs.push(nt); }
    const f0 = name === 'constructor' ? spec.constructor : spec.functions.find((f) => f.name === name);
    const stateChanging = name === 'constructor' || name === 'receive' || name === 'fallback' || (!!f0 && f0.mutability !== 'view' && f0.mutability !== 'pure');
    // value coverage: a passing scenario flagged valued for this function (explorer saw non-trivial values on the original), or the init scenario for the constructor
    // only scenarios that really PASSED count: a documented difference is a mismatch that was explained, not an execution that matched
    const passedIds = new Set(outcomes.filter((o) => o.status === 'passed').map((o) => o.id));
    const absentReason = stateChanging ? opts.absent?.get(name) : undefined;
    const hasSuccessCall = related.some((o) => passedIds.has(o.id));
    const valuedPass = !absentReason && (name === 'constructor' ? hasSuccessCall : [...valuedBy.entries()].some(([id, fns2]) => fns2.includes(name) && passedIds.has(id)));
    const unchecked = !absentReason && stateChanging && !related.length && !String(status).startsWith('not');
    if (unchecked) diffs.push('UNCHECKED: no scenario exercised this function (no successful call could be found on the original)');
    if (absentReason) { status = 'not-available-on-target'; diffs.length = 0; diffs.push(`NOT AVAILABLE ON THIS TARGET: ${absentReason}`); }
    const valueCoverage: FunctionReport['valueCoverage'] = !stateChanging || absentReason ? 'n/a' : valuedPass ? 'valued' : hasSuccessCall ? 'trivial-only' : 'none';
    if (stateChanging && valueCoverage === 'trivial-only') diffs.push('only trivial values were exercised (no scenario moved tokens or changed observable state with non-zero values)');
    const unc = opts.uncompared?.get(name);
    if (stateChanging && !absentReason && opts.boolReturnFns?.has(name) && !unc) diffs.push(returnDropNote());
    if (status === 'translated' && (diffs.length || sc.documented)) status = 'translated-with-differences';
    const bucket: FunctionReport['bucket'] = !stateChanging ? 'view' : absentReason ? 'absent-by-design' : status === 'not translated' ? 'not-translated' : unchecked ? 'unchecked' : sc.failed > 0 ? 'failed' : valueCoverage === 'valued' ? 'verified' : valueCoverage === 'trivial-only' ? 'trivial-only' : 'unverified';
    out.push({
      name, status, unit, bucket, ...(absentReason ? { absentReason } : {}), fidelity: unit && hasOwn(opts.fidelity, unit) ? opts.fidelity[unit]! : null, differences: [...new Set(diffs)], scenarios: sc, stateChanging, valueCoverage, unchecked,
      ...(unc ? { uncomparedReturns: unc } : {}),
      failing: related.filter((o) => o.status === 'failed').flatMap((o) => o.mismatches.filter((m) => !m.documented).map((m) => ({ scenario: o.id, at: m.at, what: m.what, expected: m.expected, actual: m.actual }))),
    });
  }
  return out;
}

export interface VerdictInput {
  compileOk: boolean; ran: boolean; behaviourCheck: boolean;
  outcomes: ScenarioOutcomeLike[]; conformance: string[];
  functions: FunctionReport[]; template: boolean; set: ScenarioSet;
  gateProblems?: string[];
}

export function decideVerdict(v: VerdictInput): { status: RewriteStatus; reasons: string[]; coverage: Coverage } {
  const counts = { passed: v.outcomes.filter((x) => x.status === 'passed').length, failed: v.outcomes.filter((x) => x.status === 'failed').length, notRunnable: v.outcomes.filter((x) => x.status === 'not-runnable').length, documented: v.outcomes.filter((x) => x.status === 'documented-difference').length };
  const sc = v.functions.filter((f) => f.stateChanging);
  const names = (b: FunctionReport['bucket']) => sc.filter((f) => f.bucket === b).map((f) => f.name);
  const unchecked = names('unchecked'), trivial = names('trivial-only'), notTranslated = names('not-translated'), absent = names('absent-by-design'), failedFns = names('failed'), otherUnv = names('unverified');
  const uncompared = sc.filter((f) => f.uncomparedReturns && f.bucket !== 'absent-by-design').map((f) => f.name);
  const verified = sc.filter((f) => f.bucket === 'verified');
  const ran = v.ran && v.compileOk && !v.gateProblems?.length;
  const viewLabels = new Set<string>();
  for (const s of v.set.scenarios) for (const st of s.steps) if (st.type === 'view' && st.fn !== 'tokenBalance') viewLabels.add(st.label);
  const bad = new Set(v.outcomes.flatMap((o) => o.mismatches.filter((m) => !m.documented && viewLabels.has(m.what)).map((m) => m.what)));
  const notComparedSet = new Set<string>();
  for (const o of v.outcomes) for (const m of o.notRunnable) { const i = m.indexOf(': '); if (i > 0 && viewLabels.has(m.slice(0, i))) notComparedSet.add(m.slice(0, i)); }
  const notCompared = ran ? [...notComparedSet].sort() : [];
  const checked = ran && v.outcomes.some((o) => o.status !== 'not-runnable') ? viewLabels.size - notCompared.length : 0;
  const nrScen = v.outcomes.filter((x) => x.status === 'not-runnable').map((x) => ({ id: x.id, title: x.title, reason: x.notRunnable[0] ?? '' }));
  const present = sc.length - absent.length;
  const coverage: Coverage = {
    functionsTotal: sc.length, functionsVerified: verified.length, functionsAbsent: absent, functionsPresent: present,
    functionsUnverified: sc.filter((f) => f.bucket !== 'verified' && f.bucket !== 'absent-by-design').map((f) => f.name),
    failedFunctions: failedFns, otherUnverifiedFunctions: otherUnv,
    uncheckedFunctions: unchecked, trivialOnlyFunctions: trivial, notTranslatedFunctions: notTranslated, uncomparedReturns: uncompared,
    notRunnableScenarios: nrScen, getters: { planned: viewLabels.size, checked, mismatched: Math.min(bad.size, checked), notCompared },
    summary: `${verified.length} of ${sc.length} state-changing functions verified with non-trivial values${absent.length ? `; ${absent.length} not available on this target (${absent.join(', ')})` : ''}`,
  };
  const reasons: string[] = [];
  let status: RewriteStatus;
  if (v.gateProblems?.length) { status = 'UNVERIFIED'; reasons.push(`spec sanity gate failed: ${more(v.gateProblems, 3)}`); }
  else if (!v.compileOk) { status = 'FAILED-COMPILE'; reasons.push('the rewrite does not compile'); }
  else if (!v.ran || !v.behaviourCheck) { status = 'UNVERIFIED'; reasons.push('behaviour was not checked'); }
  else if (counts.failed > 0 || v.conformance.length > 0) { status = 'FAILED-BEHAVIOUR'; reasons.push(`${counts.failed} scenario(s) failed${v.conformance.length ? `, ${v.conformance.length} design conformance problem(s)` : ''}`); }
  else if (v.template && v.outcomes.filter((x) => x.notRunnable.some((r) => /does not fit/.test(r))).length >= v.outcomes.length / 2) { status = 'FAILED-BEHAVIOUR'; reasons.push('most scenarios do not fit the target number range'); }
  else if (counts.passed + counts.documented === 0 || counts.notRunnable > v.outcomes.length / 2) { status = 'UNVERIFIED'; reasons.push('nothing (or less than half of the scenarios) could be run'); }
  else if (present > 0 && verified.length === 0) { status = 'UNVERIFIED'; reasons.push('no state-changing function has a passing scenario with non-trivial values'); }
  else {
    if (absent.length) reasons.push(`${absent.length} of ${sc.length} original state-changing functions have no equivalent on this target (${absent.join(', ')}); the ${present} that exist ${verified.length === present ? 'are all verified' : 'are not all verified'}`);
    if (failedFns.length) reasons.push(`functions with failing scenarios: ${failedFns.join(', ')}`);
    if (otherUnv.length) reasons.push(`functions with no passing scenario that has non-trivial values: ${otherUnv.join(', ')}`);
    if (unchecked.length) reasons.push(`unchecked functions (no successful call on the original): ${unchecked.join(', ')}`);
    if (trivial.length) reasons.push(`functions only exercised with trivial values: ${trivial.join(', ')}`);
    if (notTranslated.length) reasons.push(`functions not translated: ${notTranslated.join(', ')}`);
    if (uncompared.length) reasons.push(`return values not compared: ${uncompared.join(', ')}`);
    if (notCompared.length) reasons.push(`getters not compared on this target: ${more(notCompared, 6)}`);
    if (counts.notRunnable > 0) reasons.push(`${counts.notRunnable} scenario(s) not runnable, which hides behaviour`);
    if (reasons.length) status = 'PARTIALLY-VERIFIED';
    else if (counts.documented > 0 || v.functions.some((f) => f.status === 'translated-with-differences')) { status = 'PASSED-WITH-DOCUMENTED-DIFFERENCES'; reasons.push('the listed differences are by design: every function exists on the target and behaves differently only in the stated ways'); }
    else { status = 'PASSED'; reasons.push('full coverage, no failures'); }
  }
  return { status, reasons, coverage };
}

export function exitCodeFor(s: RewriteStatus): number {
  return s === 'PASSED' || s === 'PASSED-WITH-DOCUMENTED-DIFFERENCES' ? 0 : s === 'PARTIALLY-VERIFIED' ? 10 : s === 'FAILED-COMPILE' ? 6 : s === 'FAILED-BEHAVIOUR' ? 8 : 9;
}
export type { ScenarioSet };
