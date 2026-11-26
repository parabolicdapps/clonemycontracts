import type { ContractSpec, DeploySpec, FunctionSpec, ParamSpec, Scenario, ScenarioSet, Step, TokenFixture, TypeRef, Val } from '../types.js';
import { expectedGuards, signatureGuarded } from '../spec/guards.js';
import { OriginalRunner, type ScenarioTrace } from './original.js';

export const T0 = 1_700_000_000;
export const ACTORS = ['deployer', 'alice', 'bob', 'carol', 'mallory'];
const E18 = 10n ** 18n;

export interface GenerateOptions {
  /** upper bound on scenarios (default 60) */
  maxScenarios?: number;
  onProgress?: (m: string) => void;
  /** explicit constructor argument override */
  deployArgs?: Val[];
}

// ---------------------------------------------------------------- value heuristics

const tokenAmount = (k: number, dec = 18) => (BigInt(k) * 10n ** BigInt(dec)).toString();

function tokenDepFor(spec: ContractSpec, p: ParamSpec): string | null {
  if (p.type.kind !== 'contract') return null;
  const n = p.name.replace(/^_/, '');
  const assigned = spec.constructor?.paramAssignments?.find((a) => a.param === p.name)?.stateVar;
  const dep = (assigned && spec.tokenDependencies.find((t) => t.name === assigned)) || spec.tokenDependencies.find((t) => t.name.replace(/^_/, '') === n) || spec.tokenDependencies.find((t) => t.type === p.type.name);
  return dep ? dep.name.replace(/^_/, '') : null;
}

/** Candidate values for a parameter, most likely first. */
export function candidates(spec: ContractSpec, p: ParamSpec, ctx: { at: number; role: 'deploy' | 'call'; caller?: string; dec: number; idx: number }): Val[] {
  const n = p.name.replace(/^_/, '');
  const t: TypeRef = p.type;
  switch (t.kind) {
    case 'uint': case 'int': {
      if (/duration|period|seconds|window|interval|lock/i.test(n) && !/start|cliff/i.test(n)) return ['1000', '100'];
      if (/cliff/i.test(n)) return ['200'];
      if (/^(start|begin)|startTime|timestamp/i.test(n)) return [{ time: ctx.role === 'deploy' ? 100 : ctx.at + 10 }];
      if (/deadline|expir|until|end(Time)?$/i.test(n)) return [{ time: ctx.at + 5000 }];
      if (/(^|[a-z])(id|index|idx|slot)$/i.test(n) || /^(id|index|idx)/i.test(n)) return ['0', '1'];
      if (/fee|bps|percent|rate$/i.test(n) && ctx.role === 'deploy') return ['100'];
      if (/max|limit/i.test(n) && ctx.role === 'deploy') return [/ERC-721/.test(spec.tokenStandards.join()) ? '3' : tokenAmount(1_000_000, ctx.dec)];
      if (/price|cost/i.test(n) || /^value$|wei$|ether/i.test(n)) return [tokenAmount(1, 15)];
      if (/supply|cap|initial|total/i.test(n) && ctx.role === 'deploy') return [tokenAmount(1_000_000, ctx.dec)];
      if (t.bits !== undefined && t.bits <= 8) return ['1', '2'];
      return [tokenAmount(100, ctx.dec), tokenAmount(1, ctx.dec)];
    }
    case 'address': {
      { const asg = spec.constructor?.paramAssignments?.find((a) => a.param === p.name)?.stateVar; if (ctx.role === 'deploy' && asg && spec.tokenDependencies.some((t) => t.name === asg)) return [{ token: asg.replace(/^_/, '') }]; }
      if (/owner|admin|governor|manager/i.test(n)) return ctx.role === 'deploy' ? [{ actor: 'deployer' }] : [{ actor: 'bob' }, { actor: 'carol' }];
      if (/spender|operator/i.test(n)) return [{ actor: 'bob' }, { actor: 'carol' }];
      if (/from|sender|account|user|holder/i.test(n) && ctx.role === 'call') return [...new Set([ctx.caller ?? 'alice', 'alice', 'deployer', 'bob'])].map((a) => ({ actor: a }));
      if (ctx.role === 'deploy') return [{ actor: 'alice' }];
      return [{ actor: ctx.caller === 'bob' ? 'carol' : 'bob' }, { actor: 'alice' }];
    }
    case 'contract': {
      const dep = tokenDepFor(spec, p);
      return dep ? [{ token: dep }] : [{ actor: 'carol' }];
    }
    case 'bool': return [true, false];
    case 'string': return [/symbol/i.test(n) ? 'TST' : /name/i.test(n) ? 'Test Token' : /uri/i.test(n) ? 'ipfs://cid/' : 'x'];
    case 'bytes': return [{ hex: '0x' }];
    case 'fixedbytes': return [{ hex: '0x' + '00'.repeat((t.bits ?? 8) / 8) }];
    case 'enum': return ['0', '1'];
    case 'array': {
      const len = t.length ?? 1;
      const elem = t.element ?? { solidity: 'uint256', kind: 'uint' as const };
      if (elem.kind === 'address') return [Array.from({ length: len }, (_, i) => ({ actor: ACTORS[1 + (i % 3)]! }))];
      return [Array.from({ length: len }, () => (candidates(spec, { name: p.name, type: elem }, ctx)[0] ?? '0'))];
    }
    case 'struct': {
      const st = spec.structs.find((s) => s.name === t.name);
      return st ? [st.fields.map((f) => candidates(spec, f, ctx)[0] ?? '0')] : ['0'];
    }
    default: return ['0'];
  }
}

/** Candidate argument tuples, the most plausible first: the all-first tuple, then tuples that differ from it in one position, then two, ... (a plain cartesian prefix would never vary the first parameter). */
function product(pools: Val[][], cap: number): Val[][] {
  const size = pools.reduce((n, p) => n * Math.max(1, p.length), 1);
  if (size > 5000) {
    let out: Val[][] = [[]];
    for (const pool of pools) { const next: Val[][] = []; for (const o of out) for (const v of pool) { next.push([...o, v]); if (next.length >= cap) break; } out = next.slice(0, cap); }
    return out;
  }
  const idx: number[][] = [[]];
  let all: number[][] = idx;
  for (const pool of pools) { const next: number[][] = []; for (const o of all) for (let k = 0; k < Math.max(1, pool.length); k++) next.push([...o, k]); all = next; }
  const scored = all.map((ix, n) => ({ ix, n, score: ix.filter((k) => k > 0).length, sum: ix.reduce((a, k) => a + k, 0) }));
  scored.sort((x, y) => x.score - y.score || x.sum - y.sum || x.n - y.n);
  return scored.slice(0, cap).map((c) => c.ix.map((k, i) => (pools[i]!.length ? pools[i]![k]! : ('0' as Val))));
}

export function defaultDeployArgs(spec: ContractSpec, dec = 18): Val[] {
  return (spec.constructor?.params ?? []).map((p, idx) => candidates(spec, p, { at: 0, role: 'deploy', dec, idx })[0] ?? '0');
}

// ---------------------------------------------------------------- views to observe

const SCALAR_GETTER = new Set(['uint', 'int', 'bool', 'address', 'contract', 'enum', 'fixedbytes', 'string', 'bytes']);
const GETTER_ACTORS = ['deployer', 'alice', 'bob', 'carol'];
/** (owner, spender) pairs observed for allowance-style views/getters: every pair an explored call can create */
const PAIRS: [string, string][] = [['alice', 'bob'], ['bob', 'alice'], ['deployer', 'alice'], ['deployer', 'bob'], ['alice', 'carol'], ['bob', 'carol'], ['deployer', 'carol'], ['carol', 'bob']];

/**
 * Getters of public state variables (the compiler-generated view functions). Hand-written views with the same name are covered by
 * `viewSteps`. Mappings get actor / small index keys; strings, structs, dynamic arrays and non-token contract references are skipped
 * (the first two have no comparable representation on every target, the last is a raw chain address).
 */
export function getterSteps(spec: ContractSpec, at: number): Step[] {
  const steps: Step[] = [];
  const handWritten = new Set(spec.functions.filter((f) => f.kind === 'function').map((f) => f.name));
  const tokenNames = new Set(spec.tokenDependencies.map((t) => t.name));
  for (const sv of spec.stateVars) {
    if (sv.visibility !== 'public' || handWritten.has(sv.name)) continue;
    let t = sv.type;
    const keys: TypeRef[] = [];
    while (t.kind === 'mapping') { keys.push(t.key!); t = t.value!; }
    if (!SCALAR_GETTER.has(t.kind)) continue;
    if (t.kind === 'contract' && !tokenNames.has(sv.name)) continue;
    const add = (args: Val[], label: string) => steps.push({ type: 'view', fn: sv.name, args, at, label, getter: true });
    const lab = (args: string[]) => `${sv.name}(${args.join(',')})`;
    if (keys.length === 0) { add([], lab([])); continue; }
    const kinds = keys.map((k) => k.kind);
    if (keys.length === 1 && kinds[0] === 'address') for (const a of GETTER_ACTORS) add([{ actor: a }], lab([a]));
    else if (keys.length === 1 && kinds[0] === 'uint') for (const i of ['0', '1']) add([i], lab([i]));
    else if (keys.length === 2 && kinds[0] === 'address' && kinds[1] === 'address') for (const [a, b] of PAIRS) add([{ actor: a }, { actor: b }], lab([a, b]));
    else if (keys.length === 2 && kinds[0] === 'address' && kinds[1] === 'uint') for (const i of ['0', '1']) add([{ actor: 'alice' }, i], lab(['alice', i]));
  }
  return steps;
}

export function viewSteps(spec: ContractSpec, at: number, tokens: TokenFixture[]): Step[] {
  const steps: Step[] = [];
  const views = spec.functions.filter((f) => (f.visibility === 'public' || f.visibility === 'external') && (f.mutability === 'view' || f.mutability === 'pure') && f.kind === 'function' && !f.excluded);
  for (const f of views) {
    const ps = f.params;
    if (ps.length > 1) continue;
    if (ps.length === 0) { steps.push({ type: 'view', fn: f.name, args: [], at, label: f.name }); continue; }
    const p = ps[0]!;
    if (p.type.kind === 'address') for (const a of ['deployer', 'alice', 'bob', 'carol']) steps.push({ type: 'view', fn: f.name, args: [{ actor: a }], at, label: `${f.name}(${a})` });
    else if (p.type.kind === 'uint') for (const i of ['0', '1']) steps.push({ type: 'view', fn: f.name, args: [i], at, label: `${f.name}(${i})` });
  }
  // public mappings with two address keys: allowance-style
  for (const f of spec.functions.filter((x) => (x.visibility === 'public' || x.visibility === 'external') && (x.mutability === 'view') && x.params.length === 2 && x.params.every((q) => q.type.kind === 'address') && x.kind === 'function')) {
    for (const [a, b] of PAIRS) steps.push({ type: 'view', fn: f.name, args: [{ actor: a }, { actor: b }], at, label: `${f.name}(${a},${b})` });
  }
  steps.push(...getterSteps(spec, at));
  for (const t of tokens) {
    for (const a of ['alice', 'bob', 'deployer']) steps.push({ type: 'view', fn: 'tokenBalance', args: [{ token: t.name }, { actor: a }], at, label: `${t.name}.balanceOf(${a})` });
    steps.push({ type: 'view', fn: 'tokenBalance', args: [{ token: t.name }, 'contract'], at, label: `${t.name}.balanceOf(contract)` });
  }
  return steps;
}

// ---------------------------------------------------------------- generator

const DESTRUCTIVE = /revoke|pause|close|cancel|destroy|renounce|kill|shutdown|stop|deprecat|retire|terminate|sunset|disable|migrate/i;
/** functions that tend to consume the position they act on: tried last when looking for non-trivial values */
const CONSUMING = /exit|withdrawAll|liquidate|claimAll|redeemAll/i;

function publicStateChanging(spec: ContractSpec): FunctionSpec[] {
  const fs = spec.functions.filter((f) => f.kind === 'function' && (f.visibility === 'public' || f.visibility === 'external') && f.mutability !== 'view' && f.mutability !== 'pure');
  const ok = fs.filter((f) => !DESTRUCTIVE.test(f.name) && !f.excluded);
  return [...ok, ...fs.filter((f) => DESTRUCTIVE.test(f.name) && !f.excluded)];
}

export function tokenFixtures(spec: ContractSpec, dec = 18): TokenFixture[] {
  const names = [...new Set(spec.tokenDependencies.map((t) => t.name.replace(/^_/, '')))];
  // mallory (the unprivileged actor) is funded and approved like everybody else: the ONLY thing she lacks is the permission
  return names.map((name) => ({ name, decimals: dec, fundings: ['deployer', 'alice', 'bob', 'carol', 'mallory'].map((a) => ({ actor: a, amount: tokenAmount(1_000_000, dec) })), approveContract: true }));
}

const RECEIVE_FN = { name: 'receive', kind: 'receive', params: [], externalCalls: [], payable: true, usesTimestamp: false } as unknown as FunctionSpec;
const FUND_FN = { name: 'tokenTransfer', kind: 'function', params: [], externalCalls: [], usesTimestamp: false } as unknown as FunctionSpec;
interface Found { step: Extract<Step, { type: 'call' }>; fn: FunctionSpec; /** non-trivial values were observed on the original */ valued: boolean }

const isZeroish = (v: Val): boolean => v === '0' || v === 0 || v === false || (typeof v === 'object' && v !== null && !Array.isArray(v) && 'zero' in v);
const TRANSFERISH = /^(transfer|transferFrom|safeTransfer|safeTransferFrom|mint|burn|burnFrom)$/;

/** the token fixtures a function is expected to move (from its external ERC-20 calls) */
function tokensMovedBy(spec: ContractSpec, f: FunctionSpec): string[] {
  const out = new Set<string>();
  for (const e of f.externalCalls) {
    if (e.low || !TRANSFERISH.test(e.method)) continue;
    const dep = spec.tokenDependencies.find((t) => t.name === e.target || t.name.replace(/^_/, '') === e.target.replace(/^_/, ''));
    if (dep) out.add(dep.name.replace(/^_/, ''));
  }
  return [...out];
}

export async function generateScenarios(spec: ContractSpec, runner: OriginalRunner, opts: GenerateOptions = {}): Promise<ScenarioSet> {
  const log = opts.onProgress ?? (() => {});
  const tokens = tokenFixtures(spec);
  const deployArgs = opts.deployArgs ?? defaultDeployArgs(spec);
  const deploy: DeploySpec = { actor: 'deployer', args: deployArgs, at: -20 };
  const base: ScenarioSet = { version: 1, contract: spec.name, t0: T0, actors: ACTORS, tokens, scenarios: [] };
  const fns = publicStateChanging(spec);
  const guarded = new Set(spec.accessControl.guarded.map((g) => g.fn));

  // ---- 1. explore on the original (one live session)
  const found: Found[] = [];
  let clock = 0;
  await runner.withSession(base, deploy, async (session, dep, fatal) => {
    if (!session) { log(`original: deployment with default arguments ${dep.status === 'revert' ? 'reverted' : 'failed'}${fatal ? ` (${fatal})` : ''}${dep.reason ? ` [${dep.reason}]` : ''}`); return; }

    // what the original looks like (tokens + state getters); used to decide whether a call carried non-trivial values
    // everything observable: hand-written views (balanceOf, earned, ...), public state getters, and the token balances of every actor and the contract
    const probe: Step[] = viewSteps(spec, 0, []);
    for (const t of tokens) {
      for (const a of [...GETTER_ACTORS, 'mallory']) probe.push({ type: 'view', fn: 'tokenBalance', args: [{ token: t.name }, { actor: a }], at: 0, label: `${t.name}:${a}` });
      probe.push({ type: 'view', fn: 'tokenBalance', args: [{ token: t.name }, 'contract'], at: 0, label: `${t.name}:contract` });
    }
    /** non-zero numbers seen in the original's state (balances the contract holds, amounts the actors own): good arguments for amount parameters */
    let hints: string[] = [];
    const observe = async (at: number): Promise<Map<string, string>> => {
      const m = new Map<string, string>();
      const nums = new Set<string>();
      for (const v of probe) {
        const r = await session.check({ ...v, at } as Step);
        m.set(`${v.type === 'view' ? v.fn : ''}|${v.type === 'view' ? v.label : ''}`, JSON.stringify(r.value ?? r.observed ?? null));
        if (typeof r.value === 'string' && /^[1-9]\d{0,29}$/.test(r.value)) nums.add(r.value);
      }
      // only amounts every target can represent: multiples of 10^10 (the unit conversion of the 8/9-decimals targets), never durations or counters
      hints = [...nums].filter((x) => BigInt(x) < 10n ** 24n && BigInt(x) % 10n ** 10n === 0n).sort((a, b) => (BigInt(a) < BigInt(b) ? 1 : -1)).slice(0, 3);
      return m;
    };
    await observe(0);
    /** execute for real, return whether the values flowing through were non-trivial */
    const execObserved = async (step: Extract<Step, { type: 'call' }>, f: FunctionSpec): Promise<boolean> => {
      const before = await observe(step.at);
      await session.exec(step);
      const after = await observe(step.at + 1);
      const changed = [...after.entries()].filter(([k, v]) => before.get(k) !== v).map(([k]) => k);
      const movedTokens = new Set(changed.filter((k) => k.startsWith('tokenBalance|')).map((k) => k.slice('tokenBalance|'.length).split(':')[0]!));
      const want = f === FUND_FN ? [] : tokensMovedBy(spec, f);
      const numericArgsNonZero = f.params.every((p, i) => !['uint', 'int'].includes(p.type.kind) || !isZeroish(step.args[i] as Val));
      const stateMoved = changed.some((k) => !k.startsWith('tokenBalance|')) || f.payable;
      return numericArgsNonZero && changed.length > 0 && want.every((t) => movedTokens.has(t)) && (want.length > 0 || stateMoved || f === RECEIVE_FN);
    };
    const record = async (step: Extract<Step, { type: 'call' }>, f: FunctionSpec) => { const valued = await execObserved(step, f); found.push({ step, fn: f, valued }); return valued; };

    if (spec.hasReceive) {
      const rs: Extract<Step, { type: 'call' }> = { type: 'call', actor: 'alice', fn: 'receive', args: [], at: 1, valueWei: tokenAmount(1, 18) };
      const chk = await session.check(rs);
      if (chk.observed?.status === 'success') { await record(rs, RECEIVE_FN); clock = 2; }
    }
    const callersOf = (f: FunctionSpec) => (guarded.has(f.name) ? ['deployer', 'alice', 'bob'] : ['alice', 'deployer', 'bob']);
    const valueOf = (f: FunctionSpec) => (f.payable ? (/mint|buy|purchase|deposit/i.test(f.name) ? tokenAmount(1, 15) : tokenAmount(1, 16)) : undefined);
    /** try the argument candidates for one caller; commit the first success (optionally only when its values are non-trivial) */
    const tryFnAs = async (f: FunctionSpec, caller: string, at: number, mustBeValued: boolean, cap = 16): Promise<boolean> => {
      // accounts that earlier calls in this run already touched (blacklisted / approved / registered ...): a later call often has to name the same one
      const recent: Val[] = [];
      for (const x of found.slice(-4).reverse()) for (const a of x.step.args) if (a && typeof a === 'object' && !Array.isArray(a) && 'actor' in a && !recent.some((r) => JSON.stringify(r) === JSON.stringify(a))) recent.push(a);
      const pools = f.params.map((p, idx) => {
        const pool = candidates(spec, p, { at, role: 'call', caller, dec: 18, idx });
        if (p.type.kind === 'address' && recent.length) return [...pool, ...recent.filter((r) => !pool.some((q) => JSON.stringify(q) === JSON.stringify(r)))];
        if (p.type.kind === 'uint' && hints.length && !/id$|^id|index|idx|time|deadline|duration|period|expir/i.test(p.name)) return [...pool, ...hints, ...hints.map((h) => (BigInt(h) / 2n).toString()).filter((h) => h !== '0' && BigInt(h) % 10n ** 10n === 0n)];
        return pool;
      });
      for (const args of product(pools, hints.length ? cap + 8 : cap)) {
        const valueWei = valueOf(f);
        const step: Extract<Step, { type: 'call' }> = { type: 'call', actor: caller, fn: f.name, args, at, ...(valueWei ? { valueWei } : {}) };
        if ((await session.check(step)).observed?.status !== 'success') continue;
        if (!mustBeValued) { await record(step, f); return true; }
        const snap = await session.snapshot();
        const valued = await execObserved(step, f);
        if (valued) { found.push({ step, fn: f, valued: true }); return true; }
        await session.revert(snap);
      }
      return false;
    };
    const tryFn = async (f: FunctionSpec, at: number, mustBeValued: boolean, cap = 16): Promise<boolean> => {
      for (const caller of callersOf(f)) if (await tryFnAs(f, caller, at, mustBeValued, cap)) return true;
      return false;
    };
    /** run prerequisite g (as every possible caller in turn) and then f; the first pair that works is committed, everything else is rolled back */
    const tryAfter = async (g: FunctionSpec, f: FunctionSpec, atG: number, atF: number, mustBeValued: boolean): Promise<boolean> => {
      for (const callerG of callersOf(g)) {
        const snap = await session.snapshot();
        const n0 = found.length;
        if (await tryFnAs(g, callerG, atG, false, 6) && await tryFn(f, atF, mustBeValued)) return true;
        found.length = n0; await session.revert(snap);
      }
      return false;
    };

    // non-destructive functions first (while the contract is fully alive); the ones that retire/pause/deprecate it run last, after the value pass
    const nonD = fns.filter((x) => !DESTRUCTIVE.test(x.name));
    // functions that end the contract's life (deprecate, kill, shutdown ...) go last of all
    const FINAL = /deprecat|shutdown|kill|terminate|retire|sunset|renounce/i;
    const dest = fns.filter((x) => DESTRUCTIVE.test(x.name)).sort((a, b) => Number(FINAL.test(a.name)) - Number(FINAL.test(b.name)));
    const passes: { gap: number; destructive: boolean }[] = [{ gap: 0, destructive: false }, { gap: 500, destructive: false }, { gap: 2000, destructive: false }];
    for (const [pi, pass] of passes.entries()) {
      clock = Math.max(clock, pass.gap) + 1;
      let progressed = false;
      for (const f of fns.filter((x) => DESTRUCTIVE.test(x.name) === pass.destructive)) {
        if (await tryFn(f, clock, false)) { clock += 1; progressed = true; }
      }
      log(`exploration pass ${pi + 1}: ${found.length} successful calls so far`);
      if (!progressed && !pass.destructive && pi >= 1) break;
    }

    const succeeded = () => fns.filter((f) => found.some((x) => x.fn.name === f.name));
    // rescue 1: the function may need the CONTRACT to hold tokens first (e.g. a distributor that must be pre-funded)
    const fundContract = async (): Promise<boolean> => {
      let any = false;
      for (const t of tokens) for (const src of ['deployer', 'alice']) {
        const st: Extract<Step, { type: 'call' }> = { type: 'call', actor: src, fn: 'tokenTransfer', args: [{ token: t.name }, 'contract', tokenAmount(100_000, 18)], at: clock + 1 };
        if ((await session.check(st)).observed?.status === 'success') { await record(st, FUND_FN); clock += 1; any = true; break; }
      }
      return any;
    };
    for (const f of nonD.filter((x) => !found.some((y) => y.fn.name === x.name))) {
      const snap = await session.snapshot();
      const n0 = found.length;
      if (tokens.length && await fundContract() && await tryFn(f, clock + 1, false)) { clock += 3; continue; }
      found.length = n0; await session.revert(snap);
    }
    // rescue 2: one other call first (e.g. stake before exit)
    const rescue2 = async (scope: FunctionSpec[]) => { for (const f of scope.filter((x) => !found.some((y) => y.fn.name === x.name))) {
      let solved = false;
      for (const g of fns) {
        if (solved || g.name === f.name || DESTRUCTIVE.test(g.name)) continue;
        if (await tryAfter(g, f, clock + 1, clock + 2, false)) { clock += 3; solved = true; break; }
      }
    }
    };
    await rescue2(nonD);
    // value pass: every function needs a successful call whose values are non-trivial (tokens moved, state changed, non-zero amounts).
    // Direct attempt first, then with one prerequisite call (e.g. stake, wait, then getReward/exit) and a time gap so that accruals are non-zero.
    const order = (list: FunctionSpec[]) => [...list.filter((f) => !CONSUMING.test(f.name)), ...list.filter((f) => CONSUMING.test(f.name))];
    const valuePass = async (scope: FunctionSpec[]) => {
    for (let round = 0; round < 3; round++) {
      const need = order(scope.filter((f) => !found.some((x) => x.fn.name === f.name && x.valued) && found.some((x) => x.fn.name === f.name)));
      if (!need.length) break;
      let progressed = false;
      for (const f of need) {
        clock += 200;
        if (await tryFn(f, clock, true)) { progressed = true; continue; }
        let solved = false;
        // one prerequisite call, then a gap so that accruals are non-zero (e.g. stake, wait, getReward)
        for (const g of order(succeeded().filter((x) => x.name !== f.name && !DESTRUCTIVE.test(x.name)))) {
          if (await tryAfter(g, f, clock + 1, clock + 300, true)) { clock += 302; solved = true; progressed = true; break; }
        }
        if (solved) continue;
        // set-up replay: run every set-up style function again in its original order (e.g. fund + notify, then stake), then wait and try f
        const setup = succeeded().filter((x) => x.name !== f.name && !DESTRUCTIVE.test(x.name) && !CONSUMING.test(x.name) && !/withdraw|unstake|claim|getReward|redeem|burn|cancel|revoke/i.test(x.name));
        if (setup.length) {
          const snap = await session.snapshot();
          const n0 = found.length;
          let all = true;
          if (tokens.length) await fundContract();
          for (const g of setup) { if (!(await tryFn(g, clock + 1, false, 6))) { all = false; break; } clock += 1; }
          if (all && await tryFn(f, clock + 300, true)) { clock += 302; progressed = true; continue; }
          found.length = n0; await session.revert(snap);
        }
      }
      log(`value pass ${round + 1}: ${fns.filter((f) => found.some((x) => x.fn.name === f.name && x.valued)).length} of ${fns.length} functions with non-trivial values`);
      if (!progressed) break;
    }
    };
    await valuePass(nonD);
    // history pass: a second non-trivial call of the same function on a state that already has history (accrued per-user checkpoints, earlier claims):
    // formulas that only differ once a "paid" / "last" checkpoint is non-zero (e.g. balance * (rate - paid)) are invisible to a first call
    for (const f of nonD) {
      if (!found.some((x) => x.fn.name === f.name && x.valued)) continue;
      clock += 300;
      const n0 = found.length;
      if (await tryFn(f, clock, true)) continue;
      for (const g of succeeded().filter((x) => x.name !== f.name && !DESTRUCTIVE.test(x.name) && !CONSUMING.test(x.name))) {
        if (await tryAfter(g, f, clock + 1, clock + 300, true)) { clock += 302; break; }
      }
      void n0;
    }
    // destructive functions: last, on the state the value pass left
    clock += 3000;
    for (const f of dest) { if (await tryFn(f, clock, false)) clock += 1; }
    await rescue2(dest);
    await valuePass(dest);
  });
  const uncovered = fns.filter((f) => !found.some((x) => x.fn.name === f.name)).map((f) => f.name);
  if (uncovered.length) log(`no successful call found on the original for: ${uncovered.join(', ')}`);
  const trivialOnly = fns.filter((f) => found.some((x) => x.fn.name === f.name) && !found.some((x) => x.fn.name === f.name && x.valued)).map((f) => f.name);
  if (trivialOnly.length) log(`only trivial values reached for: ${trivialOnly.join(', ')}`);

  // ---- 2. assemble scenarios
  const sc: Scenario[] = [];
  let n = 0;
  const id = (k: string) => `${k}-${String(++n).padStart(2, '0')}`;
  const finalAt = () => Math.max(clock, ...found.map((x) => x.step.at)) + 10;
  sc.push({ id: id('init'), title: 'deploy and read initial state (every public getter must equal the original right after initialisation)', kind: 'init', deploy, steps: viewSteps(spec, 5, tokens), source: 'template' });
  // constructor argument violations
  const ctorP = spec.constructor?.params ?? [];
  ctorP.forEach((p, i) => {
    const bad: Val | null = p.type.kind === 'address' ? { zero: true } : p.type.kind === 'uint' && !/^(start|_start)/.test(p.name) ? '0' : null;
    if (bad === null) return;
    const args = deployArgs.map((a, j) => (j === i ? bad : a));
    sc.push({ id: id('init'), title: `deploy with ${p.name} = ${p.type.kind === 'address' ? 'zero address' : '0'}`, kind: 'init', deploy: { ...deploy, args }, steps: [], source: 'template' });
  });
  const seenFn = new Set<string>();
  const seenValued = new Map<string, number>();
  found.forEach((f, i) => {
    if (f.fn === FUND_FN) return;
    const prefix = found.slice(0, i).map((x) => x.step);
    const at = f.step.at + 1;
    const first = !seenFn.has(f.fn.name);
    const nValued = seenValued.get(f.fn.name) ?? 0;
    const firstValued = f.valued && nValued === 0;
    const secondValued = f.valued && nValued === 1;
    if (!first && !firstValued && !secondValued) return;
    if (first) seenFn.add(f.fn.name);
    if (f.valued) seenValued.set(f.fn.name, nValued + 1);
    sc.push({ id: id(`fn-${f.fn.name}`), title: `${f.fn.name}: valid call (${f.step.actor})${secondValued ? ', non-trivial values on a state with history' : f.valued ? ', non-trivial values' : ''}`, kind: 'function', fn: f.fn.name, deploy, steps: [...prefix, f.step, ...viewSteps(spec, at, tokens)], source: 'template', ...(f.valued ? { valued: [f.fn.name] } : {}) });
    if (!first) return;
    // access control: someone with no rights, who holds everything else the call needs (tokens, allowances, ETH)
    sc.push({ id: id(`acl-${f.fn.name}`), title: `${f.fn.name}: called by an unprivileged account${guarded.has(f.fn.name) ? ' (guarded: the only missing thing is the permission)' : ''}`, kind: 'access', fn: f.fn.name, deploy, steps: [...prefix, { ...f.step, actor: 'mallory', args: f.step.args.map((a) => (typeof a === 'object' && a !== null && !Array.isArray(a) && 'actor' in a && a.actor === f.step.actor ? { actor: 'mallory' } : a)) }, ...viewSteps(spec, at, tokens)], source: 'template' });
    // classic edge cases: an address argument equal to the caller (self-transfer), and the same call by the owner/admin account (sender == fee owner, sender == recipient of fees)
    const addrIdx = f.fn.params.map((p, j) => (p.type.kind === 'address' ? j : -1)).filter((j) => j >= 0);
    if (addrIdx.length) sc.push({ id: id(`self-${f.fn.name}`), title: `${f.fn.name}: every address argument is the caller itself`, kind: 'extra', fn: f.fn.name, deploy, steps: [...prefix, { ...f.step, args: f.step.args.map((a, j) => (addrIdx.includes(j) ? { actor: f.step.actor } : a)) }, ...viewSteps(spec, at, tokens)], source: 'template' });
    if (f.step.actor !== 'deployer' && !guarded.has(f.fn.name)) sc.push({ id: id(`owner-${f.fn.name}`), title: `${f.fn.name}: called by the deployer (owner / fee recipient) instead`, kind: 'extra', fn: f.fn.name, deploy, steps: [...prefix, { ...f.step, actor: 'deployer', args: f.step.args.map((a) => (typeof a === 'object' && a !== null && !Array.isArray(a) && 'actor' in a && a.actor === 'deployer' ? { actor: f.step.actor } : a)) }, ...viewSteps(spec, at, tokens)], source: 'template' });
    // argument violations
    f.fn.params.forEach((p, k) => {
      const mut = (v: Val, title: string) => sc.push({ id: id(`rev-${f.fn.name}`), title: `${f.fn.name}: ${p.name} ${title}`, kind: 'revert', fn: f.fn.name, deploy, steps: [...prefix, { ...f.step, args: f.step.args.map((a, j) => (j === k ? v : a)) }, ...viewSteps(spec, at, tokens)], source: 'template' });
      if (p.type.kind === 'uint') { mut('0', '= 0'); mut(tokenAmount(1_000_000_000, 18), 'too large'); }
      else if (p.type.kind === 'address') mut({ zero: true }, '= zero address');
    });
    // doing it twice in a row
    sc.push({ id: id(`twice-${f.fn.name}`), title: `${f.fn.name}: repeated call`, kind: 'sequence', fn: f.fn.name, deploy, steps: [...prefix, f.step, { ...f.step, at: f.step.at + 1 }, ...viewSteps(spec, f.step.at + 2, tokens)], source: 'template' });
  });
  // time dependent functions: view state at several moments along the happy path
  const valuedFns = [...new Set(found.filter((x) => x.valued && x.fn !== FUND_FN).map((x) => x.fn.name))];
  if (found.some((x) => x.fn.usesTimestamp) || spec.functions.some((f) => f.usesTimestamp && f.mutability === 'view')) {
    const all = found.map((x) => x.step);
    for (const gap of [1, 400, 1500, 5000]) {
      sc.push({ id: id('time'), title: `full happy path, state read ${gap}s after the last call`, kind: 'time', deploy, steps: [...all, ...viewSteps(spec, finalAt() + gap, tokens)], source: 'template', ...(valuedFns.length ? { valued: valuedFns } : {}) });
    }
  }
  if (found.length > 1) sc.push({ id: id('seq'), title: 'full happy path', kind: 'sequence', deploy, steps: [...found.map((x) => x.step), ...viewSteps(spec, finalAt(), tokens)], source: 'template', ...(valuedFns.length ? { valued: valuedFns } : {}) });
  // security probes: every excluded state-changing function (initialisers, upgrade / admin plumbing) called by the unprivileged account right after deployment
  for (const f of spec.functions.filter((x) => x.excluded && x.mutability !== 'view' && x.mutability !== 'pure' && x.kind === 'function')) {
    const pools = f.params.map((p, idx) => candidates(spec, p, { at: 1, role: 'call', caller: 'mallory', dec: 18, idx }));
    const args = product(pools, 1)[0] ?? [];
    sc.push({ id: id(`probe-${f.name}`), title: `security probe: ${f.name} called by an unprivileged account after deployment must not work`, kind: 'access', fn: f.name, probe: f.name, deploy, steps: [{ type: 'call', actor: 'mallory', fn: f.name, args, at: 1, ...(f.payable ? { valueWei: '0' } : {}) }], source: 'template' });
  }
  // timelock / queue style contracts: queue -> cancel (-> execute must now fail) with the SAME arguments, so a hash or key computed differently in the
  // queue and cancel paths is caught
  {
    const pub = spec.functions.filter((x) => x.kind === 'function' && (x.visibility === 'public' || x.visibility === 'external') && x.mutability !== 'view' && x.mutability !== 'pure' && !x.excluded);
    for (const q of pub.filter((x) => /^(queue|schedule|propose|submit)/i.test(x.solidityName ?? x.name))) {
      const qi = found.findIndex((x) => x.fn.name === q.name && x.fn !== FUND_FN);
      if (qi < 0) continue;
      const qs = found[qi]!.step;
      for (const c of pub.filter((x) => /^(cancel|unqueue|dequeue|revoke)/i.test(x.solidityName ?? x.name) || /^execute/i.test(x.solidityName ?? x.name))) {
        const args = c.params.map((p, idx) => { const k = q.params.findIndex((x) => x.name === p.name && x.type.solidity === p.type.solidity); return k >= 0 ? qs.args[k]! : (candidates(spec, p, { at: qs.at + 1, role: 'call', caller: qs.actor, dec: 18, idx })[0] ?? '0'); });
        const prefix = found.slice(0, qi + 1).map((x) => x.step);
        const isCancel = /^(cancel|unqueue|dequeue|revoke)/i.test(c.solidityName ?? c.name);
        const steps: Step[] = [...prefix, { type: 'call', actor: qs.actor, fn: c.name, args, at: qs.at + 1 }];
        if (isCancel) for (const e of pub.filter((x) => /^execute/i.test(x.solidityName ?? x.name))) {
          const eargs = e.params.map((p, idx) => { const k = q.params.findIndex((x) => x.name === p.name && x.type.solidity === p.type.solidity); return k >= 0 ? qs.args[k]! : (candidates(spec, p, { at: qs.at + 2, role: 'call', caller: qs.actor, dec: 18, idx })[0] ?? '0'); });
          steps.push({ type: 'call', actor: qs.actor, fn: e.name, args: eargs, at: qs.at + 2 });
        }
        sc.push({ id: id(`queue-${c.name}`), title: `${q.name} then ${c.name} with the same arguments${isCancel ? ', then execute (must fail)' : ''}`, kind: 'sequence', fn: c.name, deploy, steps: [...steps, ...viewSteps(spec, qs.at + 3, tokens)], source: 'template' });
      }
    }
  }
  // negative scenarios: every guarded function gets a denied-path scenario even when no positive path could be found on the original
  const negs: Scenario[] = [];
  const negHave = new Set(sc.filter((x) => x.kind === 'access' && x.fn).map((x) => x.fn!));
  for (const f of spec.functions.filter((x) => x.kind === 'function' && (x.visibility === 'public' || x.visibility === 'external') && x.mutability !== 'view' && x.mutability !== 'pure' && !x.excluded)) {
    const g = expectedGuards(f);
    const sig = signatureGuarded(f);
    const recoverLike = /^(recover|rescue|sweep|emergency|withdrawAll|skim|drain)/i.test(f.solidityName ?? f.name);
    const neg = (kind: 'unauthorised' | 'bad-signature' | 'unfunded', title: string, args: Val[]) => negs.push({ id: id(`neg-${kind}-${f.name}`), title: `${f.name}: ${title}`, kind: 'access', fn: f.name, negative: { fn: f.name, kind }, deploy, steps: [{ type: 'call', actor: 'mallory', fn: f.name, args, at: 1, ...(f.payable ? { valueWei: '0' } : {}) }], source: 'template' });
    const pools = f.params.map((p, idx) => candidates(spec, p, { at: 1, role: 'call', caller: 'mallory', dec: 18, idx }));
    const args = product(pools, 1)[0] ?? [];
    if ((g.caller !== null || recoverLike || g.valueOut || sig) && !negHave.has(f.name)) neg('unauthorised', 'called by an unprivileged funded account right after deployment (must be denied)', args);
    if (sig) neg('bad-signature', 'called with an empty / invalid signature by an unprivileged account (must be denied)', f.params.map((p, i) => (p.type.kind === 'bytes' ? { hex: '0x' } : p.type.kind === 'fixedbytes' ? { hex: '0x' + '00'.repeat((p.type.bits ?? 8) / 8) } : (args[i] ?? '0'))));
    if (g.pulls.length || g.valueOut) neg('unfunded', 'amounts far beyond anything the caller holds or pulled (no funds behind the call must not pay out or mint)', f.params.map((p, i) => (p.type.kind === 'uint' && !/id$|index|deadline|time|nonce/i.test(p.name) ? tokenAmount(1_000_000_000_000, 18) : (args[i] ?? '0'))));
  }
  base.scenarios = [...sc.slice(0, (opts.maxScenarios ?? 90) + 40), ...negs];
  return base;
}

// ---------------------------------------------------------------- initial values cross-check

/**
 * Cross-check the initial values that code evaluated from the AST against the original deployed on anvil (default constructor arguments):
 * a public variable's getter right after deployment must equal the evaluated value, unless the constructor writes the variable.
 * A mismatch drops the AST value (the variable becomes "unresolved"). A public uint/int/bool whose initialiser code could not evaluate
 * and that the constructor does not write adopts the original's getter value (via: 'original-getter'), except time dependent expressions.
 */
export async function verifyInitialValues(spec: ContractSpec, runner: OriginalRunner, opts: { deployArgs?: Val[]; onProgress?: (m: string) => void } = {}): Promise<{ checked: number; dropped: string[]; adopted: string[] }> {
  const tokens = tokenFixtures(spec);
  const deploy: DeploySpec = { actor: 'deployer', args: opts.deployArgs ?? defaultDeployArgs(spec), at: -20 };
  const base: ScenarioSet = { version: 1, contract: spec.name, t0: T0, actors: ACTORS, tokens, scenarios: [] };
  const ctorWrites = new Set(spec.constructor?.writes ?? []);
  const res = { checked: 0, dropped: [] as string[], adopted: [] as string[] };
  await runner.withSession(base, deploy, async (session) => {
    if (!session) return;
    for (const sv of spec.stateVars) {
      if (sv.constant || sv.visibility !== 'public' || !['uint', 'int', 'bool'].includes(sv.type.kind)) continue;
      if (!sv.initial && !(sv.initialUnresolved && !ctorWrites.has(sv.name) && !/block\.|\bnow\b|msg\.|tx\.|this/.test(sv.initialValue ?? ''))) continue;
      const r = await session.check({ type: 'view', fn: sv.name, args: [], at: 5, label: sv.name });
      if (r.observed || r.value === undefined) continue;
      const got = typeof r.value === 'boolean' ? String(r.value) : String(r.value);
      if (sv.initial) {
        res.checked++;
        if (ctorWrites.has(sv.name)) continue; // the constructor overrides it: the getter shows the constructor's value
        if (got !== sv.initial.value) { res.dropped.push(`${sv.name}: AST says ${sv.initial.value}, the original reads ${got}`); delete sv.initial; sv.initialUnresolved = true; }
      } else if (/^-?\d+$/.test(got) || got === 'true' || got === 'false') {
        sv.initial = { kind: sv.type.kind as 'uint' | 'int' | 'bool', value: got, via: 'original-getter' }; delete sv.initialUnresolved; res.adopted.push(`${sv.name} = ${got}`);
      }
    }
  });
  if (res.dropped.length) opts.onProgress?.(`initial values: ${res.dropped.length} AST value(s) disagreed with the original and were dropped: ${res.dropped.join('; ')}`);
  if (res.adopted.length) opts.onProgress?.(`initial values: read from the original's getters: ${res.adopted.join(', ')}`);
  opts.onProgress?.(`initial values: ${res.checked} AST-evaluated value(s) cross-checked against the original`);
  return res;
}

// ---------------------------------------------------------------- ground truth

/** Run every scenario on the original and write the observed behaviour back as the expectation. */
export async function recordGroundTruth(set: ScenarioSet, runner: OriginalRunner, onProgress?: (m: string) => void): Promise<{ traces: ScenarioTrace[]; fatal: string[] }> {
  const traces: ScenarioTrace[] = [];
  const fatal: string[] = [];
  for (const sc of set.scenarios) {
    const tr = await runner.runScenario(set, sc);
    traces.push(tr);
    if (tr.fatal) { fatal.push(`${sc.id}: ${tr.fatal}`); continue; }
    sc.deploy.expect = { status: tr.deploy.status, ...(tr.deploy.reason ? { reason: tr.deploy.reason } : {}) };
    sc.steps.forEach((st, i) => {
      const t = tr.steps[i];
      if (!t) return;
      if (st.type === 'call' && t.observed) {
        st.expect = { status: t.observed.status, ...(t.observed.reason ? { reason: t.observed.reason } : {}), ...(t.observed.returns !== undefined ? { returns: Array.isArray(t.observed.returns) ? t.observed.returns : [t.observed.returns] } : {}), ...(t.observed.events ? { events: t.observed.events } : {}) };
      } else if (st.type === 'view') {
        if (t.observed) st.expect = { __revert: true, reason: t.observed.reason };
        else st.expect = t.value;
      }
    });
  }
  // a getter whose value is a raw chain address (not an actor, token fixture, zero or the contract) cannot be compared across chains
  for (const sc of set.scenarios) sc.steps = sc.steps.filter((st) => !(st.type === 'view' && st.getter && typeof st.expect === 'string' && /^0x[0-9a-fA-F]{40}$/.test(st.expect)));
  onProgress?.(`ground truth recorded for ${traces.length} scenarios on the original`);
  return { traces, fatal };
}
