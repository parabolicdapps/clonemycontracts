import { own } from '../../own.js';
import type { ContractSpec, ScenarioSet, Step, Val } from '../../types.js';
import type { ArgD, HandlerD, TezosDesign } from './design-types.js';
import type { Erc20Info } from './template.js';
import { MAX_UINT256, ZERO_ADDRESS, type TypeMap, typeMap } from './names.js';

// ------------------------------------------------------------ runner protocol (toolchains/tezos/runner/cmc_runner.py)
export type PVal = Record<string, unknown>;
export interface TzPlan { version: 1; t0: number; zero: string; actors: string[]; scenarios: { id: string; steps: Record<string, unknown>[] }[] }
export interface RunnerStepResult { i: number; op: string; ok: boolean; error?: string; failwith?: boolean; runner_error?: string; value?: string }
export interface RunnerResult { runner: string; scenarios: { id: string; fatal: string | null; addresses?: Record<string, string>; steps: RunnerStepResult[] }[] }

export type ReadSpec = { type: 'value'; t: TypeMap } | { type: 'record'; fields: { name: string; t: TypeMap }[] };

export interface StepMeta {
  kind: 'setup' | 'deploy' | 'call' | 'view' | 'time';
  scenarioStep?: number;
  fn?: string;
  notRunnable?: string;
  /** a documented difference: a mismatch here is reported but does not fail the rewrite */
  documented?: string;
  /** the call passes a value >= 2^128: if the original reverted with an arithmetic panic and the rewrite succeeded, that is the documented overflow difference */
  hugeArg?: boolean;
  read?: ReadSpec;
}
export interface BuiltPlan { plan: TzPlan; meta: Map<string, StepMeta[]>; notRunnable: Map<string, string> }
export interface AdapterContext { spec: ContractSpec; design: TezosDesign; set: ScenarioSet }

class NotRunnable extends Error {}
export const MAX_MUTEZ = (1n << 63n) - 1n;

const isTagged = (v: Val): v is Extract<Val, { actor: string } | { token: string } | { time: number } | { zero: true } | { hex: string }> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Convert a neutral scenario value into a runner VALUE of the Tezos type `t`. */
export function pval(v: Val, t: TypeMap, set: ScenarioSet): PVal {
  switch (t.kind) {
    case 'address': {
      if (isTagged(v)) {
        if ('actor' in v) return { addr: `actor:${String(v.actor)}` };
        if ('zero' in v) return { addr: 'zero' };
        if ('token' in v) return { addr: `contract:token_${String(v.token)}` };
      }
      if (v === 'contract') return { addr: 'contract:app' };
      throw new NotRunnable(`cannot express ${JSON.stringify(v)} as an address`);
    }
    case 'uint': case 'int': case 'enum': {
      let n: bigint;
      if (isTagged(v) && 'time' in v) n = BigInt(set.t0 + Number(v.time));
      else if (typeof v === 'string' || typeof v === 'number') n = BigInt(v);
      else throw new NotRunnable(`cannot express ${JSON.stringify(v)} as an integer`);
      if (t.kind !== 'int' && n < 0n) throw new NotRunnable(`value ${n} is negative: a nat cannot hold it`);
      return { int: n.toString() };
    }
    case 'bool': return { bool: v === true || v === 'true' };
    case 'string': return { str: String(v) };
    case 'bytes': return { bytes: isTagged(v) && 'hex' in v ? (String(v.hex).startsWith('0x') ? String(v.hex) : `0x${String(v.hex)}`) : '0x' };
    case 'array': {
      if (!Array.isArray(v)) throw new NotRunnable('array expected');
      return { list: v.map((x) => pval(x, t.elem!, set)) };
    }
    default: throw new NotRunnable(`unsupported type ${t.kind}`);
  }
}

const argValues = (args: ArgD[], vals: Val[], set: ScenarioSet): unknown => {
  const objs = args.map((a) => {
    const v = vals[a.src];
    if (v === undefined) throw new NotRunnable(`argument ${a.name} missing`);
    return [a.name, pval(v, a.t, set)] as const;
  });
  if (objs.length <= 1) return objs.map((o) => o[1]);
  return Object.fromEntries(objs);
};
const viewArg = (args: ArgD[], vals: Val[], set: ScenarioSet): PVal | null => {
  if (!args.length) return null;
  const vs = args.map((a) => {
    const v = vals[a.src];
    if (v === undefined) throw new NotRunnable(`argument ${a.name} missing`);
    return [a.name, pval(v, a.t, set)] as const;
  });
  return vs.length === 1 ? vs[0]![1] : { rec: Object.fromEntries(vs) };
};
const mutezOf = (valueWei: string | undefined): string => {
  if (!valueWei) return '0';
  const n = BigInt(valueWei);
  if (n > MAX_MUTEZ) throw new NotRunnable(`msg.value ${n} does not fit a mutez amount (a signed 64-bit integer, at most 9.2e18)`);
  return n.toString();
};
const readOf = (h: HandlerD): ReadSpec => (h.returns!.single ? { type: 'value', t: h.returns!.fields[0]!.t } : { type: 'record', fields: h.returns!.fields.map((f) => ({ name: f.name, t: f.t })) });

const BIG = 1n << 128n;
const hasHuge = (v: Val): boolean => (Array.isArray(v) ? v.some(hasHuge) : (typeof v === 'string' && /^\d{39,}$/.test(v) && BigInt(v) >= BIG));

// ------------------------------------------------------------ mock token fixtures (the same generated FA1.2 module as the template)
export const MOCK_MODULE = 'cmc_mock_token';
export function fixtureSteps(set: ScenarioSet, push: (s: Record<string, unknown>, m: StepMeta) => void) {
  for (const t of set.tokens) {
    const info = { name: `Mock ${t.name}`, symbol: 'MCK' };
    push({ op: 'originate', id: `token_${t.name}`, module: MOCK_MODULE, modname: 'mock_token', class: 'Token', args: { owner: { addr: 'actor:deployer' }, supply: { int: '0' }, name: { str: info.name }, symbol: { str: info.symbol }, decimals: { int: String(t.decimals) }, token_info: { map: [] } } }, { kind: 'setup' });
    for (const f of t.fundings) push({ op: 'call', contract: `token_${t.name}`, entry: 'mint', args: { to_: { addr: `actor:${f.actor}` }, value: { int: f.amount } }, sender: 'deployer', now: set.t0 - 1000 }, { kind: 'setup' });
  }
}
export function approvalSteps(set: ScenarioSet, push: (s: Record<string, unknown>, m: StepMeta) => void) {
  for (const t of set.tokens) {
    if (!t.approveContract) continue;
    for (const f of t.fundings) push({ op: 'call', contract: `token_${t.name}`, entry: 'approve', args: { spender: { addr: 'contract:app' }, value: { int: MAX_UINT256 } }, sender: f.actor, now: set.t0 - 1000 }, { kind: 'setup' });
  }
}

// ------------------------------------------------------------ program plan
export function buildProgramPlan(ctx: AdapterContext): BuiltPlan {
  const { design, set } = ctx;
  const plan: TzPlan = { version: 1, t0: set.t0, zero: ZERO_ADDRESS, actors: set.actors, scenarios: [] };
  const meta = new Map<string, StepMeta[]>();
  const notRunnable = new Map<string, string>();
  const init = design.instructions.find((h) => h.kind === 'initialize');

  for (const sc of set.scenarios) {
    const steps: Record<string, unknown>[] = [];
    const m: StepMeta[] = [];
    const push = (s: Record<string, unknown>, mm: StepMeta) => { steps.push(s); m.push(mm); };
    const noop = (mm: StepMeta) => push({ op: 'time' }, mm);
    try {
      fixtureSteps(set, push);
      push({ op: 'originate', id: 'app', module: 'contract_def', class: design.className, args: { deployer: { addr: `actor:${sc.deploy.actor}` } } }, design.hasInitialize ? { kind: 'setup' } : { kind: 'deploy' });
      if (init) push({ op: 'call', contract: 'app', entry: init.name, args: argValues(init.args, sc.deploy.args, set), sender: sc.deploy.actor, now: set.t0 + sc.deploy.at, amount: mutezOf(sc.deploy.valueWei) }, { kind: 'deploy' });
      approvalSteps(set, push);
      for (const [i, st] of sc.steps.entries()) {
        push({ op: 'time' }, { kind: 'time' });
        if (st.type === 'call') callStep(st, i); else viewStep(st, i);
      }
    } catch (e) {
      if (!(e instanceof NotRunnable)) throw e;
      notRunnable.set(sc.id, e.message);
      plan.scenarios.push({ id: sc.id, steps: [] }); meta.set(sc.id, []);
      continue;
    }
    plan.scenarios.push({ id: sc.id, steps }); meta.set(sc.id, m);

    function callStep(st: Extract<Step, { type: 'call' }>, i: number) {
      if (st.fn === 'tokenTransfer') {
        // fixture step: the actor moves mock-token units to the contract (or another actor)
        const [tk, dest, amount] = st.args as [{ token: string }, Val, string];
        const to = dest === 'contract' ? { addr: 'contract:app' } : { addr: `actor:${(dest as { actor: string }).actor}` };
        return push({ op: 'call', contract: `token_${tk.token}`, entry: 'transfer', args: { from_: { addr: `actor:${st.actor}` }, to_: to, value: { int: amount } }, sender: st.actor, now: set.t0 + st.at }, { kind: 'call', scenarioStep: i, fn: st.fn });
      }
      const h = st.fn === 'receive' ? design.instructions.find((x) => x.solidity === 'receive') : design.instructions.find((x) => x.solidity === st.fn && x.kind === 'entrypoint');
      const base: StepMeta = { kind: 'call', scenarioStep: i, fn: st.fn, ...(st.args.some(hasHuge) || (st.valueWei && BigInt(st.valueWei) >= BIG) ? { hugeArg: true } : {}) };
      if (!h) return noop({ ...base, notRunnable: `${st.fn} has no entrypoint in the design (not translated)` });
      try {
        push({ op: 'call', contract: 'app', entry: h.name, args: argValues(h.args, st.args, set), sender: st.actor, now: set.t0 + st.at, amount: mutezOf(st.valueWei) }, base);
      } catch (e) { if (!(e instanceof NotRunnable)) throw e; noop({ ...base, notRunnable: e.message }); }
    }
    function viewStep(st: Extract<Step, { type: 'view' }>, i: number) {
      const base: StepMeta = { kind: 'view', scenarioStep: i, fn: st.fn };
      const obs = own(design.observables, st.fn);
      if (!obs) return noop({ ...base, notRunnable: `${st.fn} is not mapped to a view` });
      if (obs.kind === 'unobservable') return noop({ ...base, notRunnable: obs.reason });
      try {
        if (obs.kind === 'token-balance') {
          const [tk, holder] = st.args as [{ token: string }, Val];
          return push({ op: 'view', contract: `token_${tk.token}`, name: 'get_balance', now: set.t0 + st.at, arg: pval(holder, typeMap({ solidity: 'address', kind: 'address' }), set) }, { ...base, read: { type: 'value', t: typeMap({ solidity: 'uint256', kind: 'uint', bits: 256 }) } });
        }
        const h = design.instructions.find((x) => x.unit === obs.unit)!;
        push({ op: 'view', contract: 'app', name: h.name, now: set.t0 + st.at, arg: viewArg(h.args, st.args, set) }, { ...base, read: readOf(h) });
      } catch (e) { if (!(e instanceof NotRunnable)) throw e; noop({ ...base, notRunnable: e.message }); }
    }
  }
  return { plan, meta, notRunnable };
}

// ------------------------------------------------------------ template plan (FA1.2 token)

/** what the original reports for a view (first recorded value over all scenarios) */
function observed(set: ScenarioSet, fn: string): unknown {
  for (const sc of set.scenarios) for (const st of sc.steps) if (st.type === 'view' && st.fn === fn && st.expect !== undefined && !(typeof st.expect === 'object' && st.expect !== null && '__revert' in st.expect)) return st.expect;
  return undefined;
}
const hex = (s: string) => `0x${Buffer.from(s, 'utf8').toString('hex')}`;

export function tokenOriginateArgs(info: Erc20Info, args: Val[], deployer: string, observedName?: unknown, observedSymbol?: unknown, observedDecimals?: unknown): Record<string, PVal> {
  const str = (i: number, dflt: string) => (i >= 0 && typeof args[i] === 'string' ? (args[i] as string) : dflt);
  const name = str(info.nameParam, info.fixedName ?? (typeof observedName === 'string' ? observedName : 'Token'));
  const symbol = str(info.symbolParam, info.fixedSymbol ?? (typeof observedSymbol === 'string' ? observedSymbol : 'TKN'));
  const decimals = typeof observedDecimals === 'string' && /^\d+$/.test(observedDecimals) ? Number(observedDecimals) : info.decimals;
  let supply = 0n;
  if (info.supplyParam !== null && args[info.supplyParam] !== undefined) supply = BigInt(args[info.supplyParam] as string);
  return { owner: { addr: `actor:${deployer}` }, supply: { int: supply.toString() }, name: { str: name }, symbol: { str: symbol }, decimals: { int: String(decimals) }, token_info: { map: [[{ str: 'name' }, { bytes: hex(name) }], [{ str: 'symbol' }, { bytes: hex(symbol) }], [{ str: 'decimals' }, { bytes: hex(String(decimals)) }]] } };
}

export function buildTokenPlan(ctx: AdapterContext, info: Erc20Info): BuiltPlan {
  const { set } = ctx;
  const plan: TzPlan = { version: 1, t0: set.t0, zero: ZERO_ADDRESS, actors: set.actors, scenarios: [] };
  const meta = new Map<string, StepMeta[]>();
  const notRunnable = new Map<string, string>();
  const nm = observed(set, 'name'), sy = observed(set, 'symbol'), dc = observed(set, 'decimals');
  const A = typeMap({ solidity: 'address', kind: 'address' });
  const U = typeMap({ solidity: 'uint256', kind: 'uint', bits: 256 });
  const S = typeMap({ solidity: 'string', kind: 'string' });
  const addr = (v: Val): PVal => pval(v, A, set);
  const amt = (v: Val): PVal => pval(v, U, set);

  for (const sc of set.scenarios) {
    const steps: Record<string, unknown>[] = [];
    const m: StepMeta[] = [];
    const push = (s: Record<string, unknown>, mm: StepMeta) => { steps.push(s); m.push(mm); };
    try {
      push({ op: 'originate', id: 'app', module: 'contract_def', class: 'Token', args: tokenOriginateArgs(info, sc.deploy.args, sc.deploy.actor, nm, sy, dc) }, { kind: 'deploy' });
      for (const [i, st] of sc.steps.entries()) {
        push({ op: 'time' }, { kind: 'time' });
        const base = { scenarioStep: i, fn: st.fn, ...(st.type === 'call' && st.args.some(hasHuge) ? { hugeArg: true } : {}) };
        const nop = (extra: Partial<StepMeta>) => push({ op: 'time' }, { kind: st.type === 'call' ? 'call' : 'view', ...base, ...extra });
        try {
          if (st.type === 'call') {
            const call = (entry: string, args: unknown) => push({ op: 'call', contract: 'app', entry, args, sender: st.actor, now: set.t0 + st.at, amount: '0' }, { kind: 'call', ...base });
            switch (st.fn) {
              case 'transfer': call('transfer', { from_: { addr: `actor:${st.actor}` }, to_: addr(st.args[0]!), value: amt(st.args[1]!) }); break;
              case 'transferFrom': call('transfer', { from_: addr(st.args[0]!), to_: addr(st.args[1]!), value: amt(st.args[2]!) }); break;
              case 'approve': call('approve', { spender: addr(st.args[0]!), value: amt(st.args[1]!) }); break;
              case 'increaseAllowance': case 'decreaseAllowance': call(st.fn, { spender: addr(st.args[0]!), value: amt(st.args[1]!) }); break;
              case 'mint': call('mint', { to_: addr(st.args[0]!), value: amt(st.args[1]!) }); break;
              case 'burn': if (st.args.length !== 1) throw new NotRunnable('burn with several parameters is not part of the FA1.2 recipe'); call('burn', [amt(st.args[0]!)]); break;
              case 'transferOwnership': call('transferOwnership', [addr(st.args[0]!)]); break;
              case 'renounceOwnership': call('renounceOwnership', []); break;
              default: throw new NotRunnable(`${st.fn} is not part of the FA1.2 recipe`);
            }
          } else {
            const view = (name: string, arg: PVal | null, t: TypeMap) => push({ op: 'view', contract: 'app', name, now: set.t0 + st.at, arg }, { kind: 'view', ...base, read: { type: 'value', t } });
            switch (st.fn) {
              case 'balanceOf': view('get_balance', addr(st.args[0]!), U); break;
              case 'totalSupply': view('get_total_supply', null, U); break;
              case 'decimals': view('get_decimals', null, U); break;
              case 'name': view('get_name', null, S); break;
              case 'symbol': view('get_symbol', null, S); break;
              case 'allowance': view('get_allowance', { rec: { owner: addr(st.args[0]!), spender: addr(st.args[1]!) } }, U); break;
              case 'owner': if (!(info.mintable || info.ownable)) throw new NotRunnable('this token has no owner'); view('get_owner', null, A); break;
              case 'tokenBalance': throw new NotRunnable('no token fixtures in a standard token');
              default: throw new NotRunnable(`${st.fn} is not readable from the FA1.2 recipe`);
            }
          }
        } catch (e) { if (!(e instanceof NotRunnable)) throw e; nop({ notRunnable: e.message }); }
      }
    } catch (e) {
      if (!(e instanceof NotRunnable)) throw e;
      notRunnable.set(sc.id, e.message);
      plan.scenarios.push({ id: sc.id, steps: [] }); meta.set(sc.id, []);
      continue;
    }
    plan.scenarios.push({ id: sc.id, steps }); meta.set(sc.id, m);
  }
  return { plan, meta, notRunnable };
}
