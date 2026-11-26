import { own } from '../../own.js';
import type { ContractSpec, ScenarioSet, Step, Val } from '../../types.js';
import type { ArgD, CwDesign, HandlerD } from './design-types.js';
import { snake } from './names.js';
import type { TypeMap } from './names.js';

// ------------------------------------------------------------ runner protocol (see toolchains/cosmwasm/RUNNER.md)
export interface CwPlan {
  version: 1; clock_start: number; bech32_prefix?: string; actors: string[]; native_denom: string; actor_native: string;
  scenarios: { id: string; steps: Record<string, unknown>[] }[];
}
export interface RunnerStepResult {
  index: number; op: string; id?: string; ok?: boolean; error?: string | null; error_chain?: string; data?: unknown;
  attributes?: { ty: string; key: string; value: string }[]; runner_error?: string | null;
}
export interface RunnerResult { runner: string; scenarios: { id: string; fatal: string | null; addresses?: Record<string, string>; steps: RunnerStepResult[] }[] }

export const NATIVE_DENOM = 'untrn';
/** actors get as much native coin as anvil's accounts (10 000 ETH) */
export const ACTOR_NATIVE = '10000000000000000000000';
export const MAX_U128 = '340282366920938463463374607431768211455';

export type ReadSpec =
  | { type: 'query'; handler: string }
  | { type: 'cw20-balance' }
  | { type: 'cw20-field'; field: string; query: Record<string, unknown> }
  | { type: 'cw20-allowance' }
  | { type: 'cw20-minter' };

export interface StepMeta {
  kind: 'setup' | 'deploy' | 'call' | 'view' | 'time';
  scenarioStep?: number;
  fn?: string;
  notRunnable?: string;
  /** not compared at all (stated once in the report header instead) */
  skip?: string;
  /** a documented difference: a mismatch here is reported but does not fail the rewrite */
  documented?: string;
  /** a mismatch "original succeeded, rewrite reverted" is documented (the call passes address(0)) */
  documentedZero?: string;
  read?: ReadSpec;
}
export interface BuiltPlan { plan: CwPlan; meta: Map<string, StepMeta[]>; notRunnable: Map<string, string> }
export interface AdapterContext { spec: ContractSpec; design: CwDesign; set: ScenarioSet }

class NotRunnable extends Error {}

export const ZERO_NOTE = 'address(0) cannot be passed to a CosmWasm message: the zero address is the empty string and fails address validation before the handler runs';
const actorRef = (a: string) => `actor:${a}`;

/** serde `rename_all = "snake_case"` of a PascalCase variant name */
export function serdeSnake(s: string): string {
  let o = '';
  for (const [i, c] of [...s].entries()) { if (c >= 'A' && c <= 'Z') { if (i > 0) o += '_'; o += c.toLowerCase(); } else o += c; }
  return o;
}

const isTagged = (v: Val): v is Extract<Val, { actor: string } | { token: string } | { time: number } | { zero: true } | { hex: string }> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const hasZero = (v: Val): boolean => (Array.isArray(v) ? v.some(hasZero) : isTagged(v) && 'zero' in v);

function hexToBase64(h: string): string { return Buffer.from(h.replace(/^0x/, ''), 'hex').toString('base64'); }

/** Convert a scenario value into the JSON a message field of this wire type expects. */
export function wireValue(v: Val, t: TypeMap, set: ScenarioSet): unknown {
  switch (t.kind) {
    case 'address': {
      if (isTagged(v)) {
        if ('actor' in v) return actorRef(String(v.actor));
        if ('zero' in v) return '';
        if ('token' in v) return `name:${String(v.token)}`;
      }
      if (v === 'contract') return 'app';
      throw new NotRunnable(`cannot express ${JSON.stringify(v)} as an address`);
    }
    case 'uint': case 'int': {
      let n: bigint;
      if (isTagged(v) && 'time' in v) n = BigInt(set.t0 + Number(v.time));
      else if (typeof v === 'string' || typeof v === 'number') n = BigInt(v);
      else throw new NotRunnable(`cannot express ${JSON.stringify(v)} as an integer`);
      const bits = t.bits ?? 256;
      const max = t.kind === 'uint' ? (1n << BigInt(bits)) - 1n : (1n << BigInt(bits - 1)) - 1n;
      if (n > max || (t.kind === 'uint' && n < 0n)) throw new NotRunnable(`value ${n} does not fit ${t.kind}${bits}`);
      // keyed uint256 and Uint64 are strings on the wire; u8/u16/u32 are numbers
      if (/^[ui](8|16|32)$/.test(t.msg)) return Number(n);
      if (t.msg === 'Uint64' && n > (1n << 64n) - 1n) throw new NotRunnable(`value ${n} does not fit u64 (mapping key / index / uint64)`);
      if (t.msg === 'Uint128' && n > (1n << 128n) - 1n) throw new NotRunnable(`value ${n} does not fit Uint128`);
      return n.toString();
    }
    case 'bool': return v === true || v === 'true';
    case 'string': return String(v);
    case 'bytes': return isTagged(v) && 'hex' in v ? hexToBase64(String(v.hex)) : '';
    case 'enum': return Number(v as string | number);
    case 'array': {
      if (!Array.isArray(v)) throw new NotRunnable('array expected');
      return v.map((x) => wireValue(x, t.elem!, set));
    }
    default: throw new NotRunnable(`unsupported type ${t.kind}`);
  }
}

const argsObject = (args: ArgD[], vals: Val[], set: ScenarioSet, denom: string): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const a of args) {
    if (a.src < 0) { out[a.name] = denom; continue; }
    const v = vals[a.src];
    if (v === undefined) throw new NotRunnable(`argument ${a.name} missing`);
    out[a.name] = wireValue(v, a.t, set);
  }
  return out;
};

const message = (h: HandlerD, body: Record<string, unknown>) => ({ [serdeSnake(h.variant)]: body });

const fundsFor = (h: HandlerD | null, valueWei: string | undefined): { denom: string; amount: string }[] | undefined => {
  if (!valueWei || BigInt(valueWei) === 0n) return undefined;
  const n = BigInt(valueWei);
  if (n > (1n << 128n) - 1n) throw new NotRunnable(`msg.value ${n} does not fit a Uint128 coin amount`);
  void h;
  return [{ denom: NATIVE_DENOM, amount: n.toString() }];
};

// ------------------------------------------------------------ program plan

export function buildProgramPlan(ctx: AdapterContext): BuiltPlan {
  const { design, set } = ctx;
  const plan: CwPlan = { version: 1, clock_start: set.t0 - 2000, bech32_prefix: 'cosmwasm', actors: set.actors, native_denom: NATIVE_DENOM, actor_native: ACTOR_NATIVE, scenarios: [] };
  const meta = new Map<string, StepMeta[]>();
  const notRunnable = new Map<string, string>();
  const init = design.instructions.find((h) => h.kind === 'instantiate')!;

  for (const sc of set.scenarios) {
    const steps: Record<string, unknown>[] = [];
    const m: StepMeta[] = [];
    const push = (s: Record<string, unknown>, mm: StepMeta) => { steps.push(s); m.push(mm); };
    const noop = (mm: StepMeta) => push({ op: 'advance', seconds: 0 }, mm);
    try {
      // fixtures: cw20 mocks with the funded actors
      for (const t of set.tokens) {
        push({ op: 'instantiate', id: `token_${t.name}`, code: 'cw20-base', name: t.name, sender: actorRef('deployer'),
          msg: { name: `Mock ${t.name}`.slice(0, 50), symbol: 'MOCK', decimals: t.decimals, initial_balances: t.fundings.map((f) => ({ address: actorRef(f.actor), amount: f.amount })), mint: null } }, { kind: 'setup' });
      }
      push({ op: 'warp', unix_timestamp: set.t0 + sc.deploy.at }, { kind: 'time' });
      // deployment
      const depMeta: StepMeta = { kind: 'deploy', ...(sc.deploy.args.some(hasZero) ? { documentedZero: ZERO_NOTE } : {}) };
      push({ op: 'instantiate', id: 'deploy', code: 'app', name: 'app', sender: actorRef(sc.deploy.actor), msg: argsObject(init.args, sc.deploy.args, set, NATIVE_DENOM), ...(fundsFor(init, sc.deploy.valueWei) ? { funds: fundsFor(init, sc.deploy.valueWei) } : {}) }, depMeta);
      // allowances for the funded actors (the original fixture approved the contract)
      for (const t of set.tokens) {
        if (!t.approveContract) continue;
        for (const f of t.fundings) push({ op: 'execute', id: `allow_${t.name}_${f.actor}`, contract: `name:${t.name}`, sender: actorRef(f.actor), msg: { increase_allowance: { spender: 'app', amount: MAX_U128 } } }, { kind: 'setup' });
      }
      for (const [i, st] of sc.steps.entries()) {
        push({ op: 'warp', unix_timestamp: set.t0 + st.at }, { kind: 'time' });
        if (st.type === 'call') callStep(st, i);
        else viewStep(st, i);
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
        const to = dest === 'contract' ? 'app' : actorRef((dest as { actor: string }).actor);
        return push({ op: 'execute', id: `step${i}`, contract: `name:${tk.token}`, sender: actorRef(st.actor), msg: { transfer: { recipient: to, amount } } }, { kind: 'call', scenarioStep: i, fn: st.fn });
      }
      const h = st.fn === 'receive' ? design.instructions.find((x) => x.solidity === 'receive') : design.instructions.find((x) => x.solidity === st.fn && x.kind === 'execute');
      const base: StepMeta = { kind: 'call', scenarioStep: i, fn: st.fn, ...(st.args.some(hasZero) ? { documentedZero: ZERO_NOTE } : {}) };
      if (!h) return noop({ ...base, notRunnable: `${st.fn} has no handler in the design (not translated)` });
      try {
        const funds = fundsFor(h, st.valueWei);
        push({ op: 'execute', id: `step${i}`, contract: 'app', sender: actorRef(st.actor), msg: message(h, argsObject(h.args, st.args, set, NATIVE_DENOM)), ...(funds ? { funds } : {}) }, base);
      } catch (e) { if (!(e instanceof NotRunnable)) throw e; noop({ ...base, notRunnable: e.message }); }
    }
    function viewStep(st: Extract<Step, { type: 'view' }>, i: number) {
      const base: StepMeta = { kind: 'view', scenarioStep: i, fn: st.fn };
      const obs = own(design.observables, st.fn);
      if (!obs) return noop({ ...base, notRunnable: `${st.fn} is not mapped to a query` });
      if (obs.kind === 'unobservable') return noop({ ...base, notRunnable: obs.reason });
      try {
        if (obs.kind === 'token-balance') {
          const [tk, holder] = st.args as [{ token: string }, Val];
          const who = holder === 'contract' ? 'app' : actorRef((holder as { actor: string }).actor);
          return push({ op: 'query', id: `view${i}`, contract: `name:${tk.token}`, msg: { balance: { address: who } } }, { ...base, read: { type: 'cw20-balance' } });
        }
        const h = design.instructions.find((x) => x.unit === obs.unit)!;
        push({ op: 'query', id: `view${i}`, contract: 'app', msg: message(h, argsObject(h.args, st.args, set, NATIVE_DENOM)) }, { ...base, read: { type: 'query', handler: h.unit } });
      } catch (e) { if (!(e instanceof NotRunnable)) throw e; noop({ ...base, notRunnable: e.message }); }
    }
  }
  return { plan, meta, notRunnable };
}

// ------------------------------------------------------------ template plan (cw20-base)

export interface Cw20TemplateInfo {
  /** constructor parameter index of name / symbol / initial supply (-1 when absent) */
  nameParam: number; symbolParam: number; supplyParam: number | null;
  decimals: number;
  /** name / symbol when the constructor does not take them (read from the original's views) */
  fixedName?: string; fixedSymbol?: string;
  mintable: boolean; burnable: boolean; ownable: boolean;
}

/** InstantiateMsg of cw20-base for one deployment of the ERC-20 (also used by the recipe). */
export function cw20InstantiateMsg(info: Cw20TemplateInfo, args: Val[], deployer: string, cap: string | null = null): Record<string, unknown> {
  const str = (i: number, dflt: string) => (i >= 0 && typeof args[i] === 'string' ? (args[i] as string) : dflt);
  const name = str(info.nameParam, info.fixedName ?? 'Token'), symbol = str(info.symbolParam, info.fixedSymbol ?? 'TKN');
  if (name.length < 3 || name.length > 50) throw new NotRunnable(`cw20-base needs a token name of 3..50 characters, got "${name}"`);
  if (!/^[a-zA-Z\-]{3,12}$/.test(symbol)) throw new NotRunnable(`cw20-base needs a symbol of 3..12 letters or '-', got "${symbol}"`);
  let supply = 0n;
  if (info.supplyParam !== null && args[info.supplyParam] !== undefined) supply = BigInt(args[info.supplyParam] as string);
  if (supply > (1n << 128n) - 1n) throw new NotRunnable(`initial supply ${supply} does not fit cw20's Uint128`);
  return {
    name, symbol, decimals: info.decimals,
    initial_balances: supply > 0n ? [{ address: actorRef(deployer), amount: supply.toString() }] : [],
    mint: info.mintable ? { minter: actorRef(deployer), cap } : null,
  };
}

/** what the original reports for a view (first recorded value over all scenarios) */
function observed(set: ScenarioSet, fn: string): unknown {
  for (const sc of set.scenarios) for (const st of sc.steps) if (st.type === 'view' && st.fn === fn && st.expect !== undefined && !(typeof st.expect === 'object' && st.expect !== null && '__revert' in st.expect)) return st.expect;
  return undefined;
}

export function buildCw20Plan(ctx: AdapterContext, info0: Cw20TemplateInfo): BuiltPlan {
  const { spec, set } = ctx;
  const nm = observed(set, 'name'), sy = observed(set, 'symbol'), dc = observed(set, 'decimals');
  const info: Cw20TemplateInfo = { ...info0, ...(typeof nm === 'string' ? { fixedName: nm } : {}), ...(typeof sy === 'string' ? { fixedSymbol: sy } : {}), ...(typeof dc === 'string' && /^\d+$/.test(dc) ? { decimals: Number(dc) } : {}) };
  const plan: CwPlan = { version: 1, clock_start: set.t0 - 2000, bech32_prefix: 'cosmwasm', actors: set.actors, native_denom: NATIVE_DENOM, actor_native: ACTOR_NATIVE, scenarios: [] };
  const meta = new Map<string, StepMeta[]>();
  const notRunnable = new Map<string, string>();
  const TOK = 'name:token';
  void spec;
  const U128 = (1n << 128n) - 1n;
  const addr = (v: Val): string => {
    if (isTagged(v)) { if ('actor' in v) return actorRef(String(v.actor)); if ('zero' in v) return ''; }
    throw new NotRunnable(`cannot express ${JSON.stringify(v)} as an address`);
  };
  const amt = (v: Val): string => {
    const n = BigInt(v as string);
    if (n > U128) throw new NotRunnable(`amount ${n} does not fit cw20's Uint128 (e.g. the "unlimited allowance" sentinel 2^256-1)`);
    return n.toString();
  };

  for (const sc of set.scenarios) {
    const steps: Record<string, unknown>[] = [];
    const m: StepMeta[] = [];
    const push = (s: Record<string, unknown>, mm: StepMeta) => { steps.push(s); m.push(mm); };
    const allowed = new Map<string, bigint>(); // `${owner}->${spender}` mirror of the ERC-20 allowance, cw20 only has increase/decrease
    try {
      push({ op: 'warp', unix_timestamp: set.t0 + sc.deploy.at }, { kind: 'time' });
      push({ op: 'instantiate', id: 'deploy', code: 'cw20-base', name: 'token', sender: actorRef(sc.deploy.actor), msg: cw20InstantiateMsg(info, sc.deploy.args, sc.deploy.actor) }, { kind: 'deploy' });
      for (const [i, st] of sc.steps.entries()) {
        push({ op: 'warp', unix_timestamp: set.t0 + st.at }, { kind: 'time' });
        if (st.type === 'call') {
          const a = actorRef(st.actor);
          const base: StepMeta = { kind: 'call', scenarioStep: i, fn: st.fn, ...(st.args.some(hasZero) ? { documentedZero: ZERO_NOTE } : {}) };
          const exec = (msg: Record<string, unknown>, extra: Partial<StepMeta> = {}) => push({ op: 'execute', id: `step${i}`, contract: TOK, sender: a, msg }, { ...base, ...extra });
          const nop = (extra: Partial<StepMeta>) => push({ op: 'advance', seconds: 0 }, { ...base, ...extra });
          try {
            switch (st.fn) {
              case 'transfer': exec({ transfer: { recipient: addr(st.args[0]!), amount: amt(st.args[1]!) } }); break;
              case 'transferFrom': exec({ transfer_from: { owner: addr(st.args[0]!), recipient: addr(st.args[1]!), amount: amt(st.args[2]!) } }); {
                const k = `${addr(st.args[0]!)}->${a}`; const cur = allowed.get(k);
                if (cur !== undefined && cur !== U128) allowed.set(k, cur - BigInt(amt(st.args[2]!)) < 0n ? 0n : cur - BigInt(amt(st.args[2]!)));
              } break;
              case 'approve': case 'increaseAllowance': case 'decreaseAllowance': {
                const sp = addr(st.args[0]!); const target = BigInt(amt(st.args[1]!));
                const k = `${a}->${sp}`; const cur = allowed.get(k) ?? 0n;
                let next = target; let docu: string | undefined;
                if (st.fn === 'increaseAllowance') next = cur + target; else if (st.fn === 'decreaseAllowance') { if (target > cur) { nop({ documented: 'decreasing an allowance below zero reverts in Solidity; cw20 decrease_allowance saturates at zero instead of reverting, so the rewrite performs no call here (documented difference: the revert is not reproduced)' }); break; } next = cur - target; }
                if (next > U128) throw new NotRunnable('allowance does not fit Uint128');
                allowed.set(k, next);
                const delta = next - cur;
                docu = st.fn === 'approve' ? 'approve(spender, amount) sets the allowance; cw20 has increase_allowance/decrease_allowance, so the adapter sends the delta (an unchanged allowance is a no-op)' : undefined;
                if (delta === 0n) nop({ ...(docu ? { documented: docu } : {}) });
                else if (delta > 0n) exec({ increase_allowance: { spender: sp, amount: delta.toString() } }, docu ? { documented: docu } : {});
                else exec({ decrease_allowance: { spender: sp, amount: (-delta).toString() } }, docu ? { documented: docu } : {});
                break;
              }
              case 'mint': exec({ mint: { recipient: addr(st.args[0]!), amount: amt(st.args[1]!) } }); break;
              case 'burn':
                if (st.args.length === 1) exec({ burn: { amount: amt(st.args[0]!) } });
                else exec({ burn_from: { owner: addr(st.args[0]!), amount: amt(st.args[1]!) } });
                break;
              case 'transferOwnership': exec({ update_minter: { new_minter: addr(st.args[0]!) } }, { documented: 'owner = cw20 minter: transferOwnership(newOwner) becomes update_minter' }); break;
              case 'renounceOwnership': exec({ update_minter: { new_minter: null } }, { documented: 'owner = cw20 minter: renounceOwnership becomes update_minter(None)' }); break;
              default: throw new NotRunnable(`${st.fn} is not part of the cw20-base recipe`);
            }
          } catch (e) { if (!(e instanceof NotRunnable)) throw e; nop({ notRunnable: e.message }); }
        } else {
          const id = `view${i}`;
          const base: StepMeta = { kind: 'view', scenarioStep: i, fn: st.fn };
          const q = (msg: Record<string, unknown>, read: ReadSpec, extra: Partial<StepMeta> = {}) => push({ op: 'query', id, contract: TOK, msg }, { ...base, read, ...extra });
          const nop = (extra: Partial<StepMeta>) => push({ op: 'advance', seconds: 0 }, { ...base, ...extra });
          try {
            switch (st.fn) {
              case 'balanceOf': q({ balance: { address: addr(st.args[0]!) } }, { type: 'cw20-balance' }); break;
              case 'totalSupply': q({ token_info: {} }, { type: 'cw20-field', field: 'total_supply', query: { token_info: {} } }); break;
              case 'decimals': q({ token_info: {} }, { type: 'cw20-field', field: 'decimals', query: { token_info: {} } }); break;
              case 'name': q({ token_info: {} }, { type: 'cw20-field', field: 'name', query: { token_info: {} } }); break;
              case 'symbol': q({ token_info: {} }, { type: 'cw20-field', field: 'symbol', query: { token_info: {} } }); break;
              case 'allowance': q({ allowance: { owner: addr(st.args[0]!), spender: addr(st.args[1]!) } }, { type: 'cw20-allowance' }); break;
              case 'owner': if (!info.mintable) throw new NotRunnable('owner() of a token without minting has no cw20 counterpart (the minter is the closest, and this token is not mintable)'); q({ minter: {} }, { type: 'cw20-minter' }); break;
              case 'tokenBalance': throw new NotRunnable('no token fixtures in a standard token');
              default: throw new NotRunnable(`${st.fn} is not readable from cw20-base`);
            }
          } catch (e) { if (!(e instanceof NotRunnable)) throw e; nop({ notRunnable: e.message }); }
        }
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
