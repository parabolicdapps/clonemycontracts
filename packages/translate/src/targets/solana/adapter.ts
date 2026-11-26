import { own } from '../../own.js';
import type { ContractSpec, Scenario, ScenarioSet, Step, Val } from '../../types.js';
import type { AccountRole, InstructionDesign, KeyRef, ObservableDesign, Scale, SolanaDesign, StateAccountDesign } from './design-types.js';
import { snake } from './design.js';

// ------------------------------------------------------------ runner protocol types (see toolchains/solana/RUNNER.md)
export type Ref = string | { ata: { owner: Ref; mint: Ref } } | { pda: { seeds: Seed[] } } | { field: { account: Ref; type: string; path: string } };
export type Seed = { str: string } | { u64: string } | { ref: Ref } | { hex: string };
export interface RunnerPlan { version: 1; clock_start: number; actors: string[]; scenarios: { id: string; steps: Record<string, unknown>[] }[] }
export interface RunnerStepResult {
  index: number; op: string; id?: string; ok?: boolean; error?: string | null; error_code?: number | null; error_name?: string | null; error_message?: string | null;
  runner_error?: string; logs?: string[]; events?: { name: string; data: unknown }[]; return_data?: { program: string; base64: string } | null;
  exists?: boolean; value?: any; units?: number;
}
export interface RunnerResult { runner: string; litesvm?: string; scenarios: { id: string; fatal: string | null; steps: RunnerStepResult[] }[] }

export const SYSTEM_ZERO = '11111111111111111111111111111111';

/** What the plan builder remembers about each runner step so results can be compared with the original. */
export interface StepMeta {
  kind: 'setup' | 'deploy' | 'call' | 'view' | 'time';
  /** index into scenario.steps (call/view) */
  scenarioStep?: number;
  fn?: string;
  /** a reason this step could not be expressed on Solana */
  notRunnable?: string;
  /** not compared at all (stated once in the report header instead): metadata and decimals */
  skip?: string;
  /** a documented difference: a mismatch here is reported but does not fail the rewrite */
  documented?: string;
  observable?: ObservableDesign;
  scale?: Scale;
  /** how to turn the runner result into a neutral value */
  read?: { type: 'field'; path: (string | number)[]; default: unknown } | { type: 'return'; rust: string } | { type: 'membership'; actor: string } | { type: 'token'; field: string } | { type: 'mint-token'; field: string; map: Record<string, string> } | { type: 'allowance'; spender: string } | { type: 'const'; value: unknown };
}
export interface BuiltPlan { plan: RunnerPlan; meta: Map<string, StepMeta[]>; notRunnable: Map<string, string> }

export interface AdapterContext { spec: ContractSpec; design: SolanaDesign; set: ScenarioSet }

const T0 = (set: ScenarioSet) => set.t0;

class NotRunnable extends Error {}

const actorRef = (a: string) => `actor:${a}`;
const configPda = (): Ref => ({ pda: { seeds: [{ str: 'config' }] } });

function pow10(n: number): bigint { return 10n ** BigInt(n); }

/** Convert a scenario value into the Solana argument, applying the scale rules. */
function argValue(v: Val, rust: string, scale: Scale | 'time', ctx: AdapterContext, tokenKeys: Map<string, string>): unknown {
  const div = BigInt(ctx.design.decimals.divisor);
  if (rust === 'Pubkey') {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      if ('actor' in v) return actorRef(v.actor);
      if ('zero' in v) return SYSTEM_ZERO;
      if ('token' in v) return `name:${tokenKeys.get(v.token) ?? v.token}_mint`;
    }
    throw new NotRunnable(`cannot express ${JSON.stringify(v)} as a pubkey`);
  }
  if (/^\[Pubkey; \d+\]$/.test(rust)) return (v as Val[]).map((x) => argValue(x, 'Pubkey', 'plain', ctx, tokenKeys));
  if (rust === 'bool') return v === true || v === 'true';
  if (rust === 'String') return String(v);
  if (rust === 'Vec<u8>') return typeof v === 'object' && v && 'hex' in v ? v.hex.replace(/^0x/, '') : '';
  const m = /^([ui])(\d+)$/.exec(rust);
  if (!m) throw new NotRunnable(`unsupported argument type ${rust}`);
  let n: bigint;
  if (typeof v === 'object' && v !== null && !Array.isArray(v) && 'time' in v) n = BigInt(T0(ctx.set) + v.time);
  else n = BigInt(v as string | number);
  if (scale === 'token' && n !== 0n) {
    if (n % div !== 0n) throw new NotRunnable(`amount ${n} is not a multiple of the unit conversion 10^${ctx.design.decimals.original - ctx.design.decimals.solana}`);
    n = n / div;
  }
  const bits = BigInt(m[2]!);
  const max = m[1] === 'u' ? (1n << bits) - 1n : (1n << (bits - 1n)) - 1n;
  if (n > max) throw new NotRunnable(`value ${n} does not fit ${rust}`);
  return n.toString();
}

function seedForKey(k: KeyRef, st: StateAccountDesign, i: number, args: Map<string, unknown>, actor: string): Seed | null {
  const rustKey = st.keys[i]?.rust ?? 'u64';
  if (k.kind === 'caller') return { ref: actorRef(actor) };
  if (k.kind === 'arg') {
    const v = args.get(k.name);
    if (v === undefined) return null;
    return rustKey === 'Pubkey' ? { ref: v as Ref } : { u64: String(v) };
  }
  return null; // config-sourced u64: let the IDL's own seeds resolve it
}

export interface BuildOptions { mode: 'program' | 'template'; solDecimals?: number }

export function buildProgramPlan(ctx: AdapterContext): BuiltPlan {
  const { spec, design, set } = ctx;
  const tokenKeys = new Map(design.tokens.map((t) => [t.solidity, t.key]));
  const plan: RunnerPlan = { version: 1, clock_start: set.t0 - 2000, actors: set.actors, scenarios: [] };
  const meta = new Map<string, StepMeta[]>();
  const notRunnable = new Map<string, string>();
  const init = design.instructions.find((i) => i.kind === 'initialize')!;

  const roleRef = (role: AccountRole, ins: InstructionDesign, actor: string, args: Map<string, unknown>): Ref | undefined => {
    switch (role.kind) {
      case 'caller': return actorRef(actor);
      case 'config': return configPda();
      case 'system_program': return 'system';
      case 'token_program': return 'token_program';
      case 'associated_token_program': return 'ata_program';
      case 'mint': return `name:${role.token}_mint`;
      case 'vault': return { ata: { owner: configPda(), mint: `name:${role.token}_mint` } };
      case 'user_token': {
        const o = role.owner!;
        let owner: Ref | undefined;
        if (o.kind === 'msg.sender') owner = actorRef(actor);
        else if (o.kind === 'param') owner = args.get(snake(o.name)) as Ref | undefined;
        else if (o.kind === 'statevar') owner = { field: { account: configPda(), type: 'Config', path: snake(o.name) } };
        return owner ? { ata: { owner, mint: `name:${role.token}_mint` } } : undefined;
      }
      case 'entry': {
        const st = design.accounts.find((a) => a.name === role.state)!;
        const seeds: Seed[] = [{ str: st.seedPrefix }];
        for (const [i, k] of (role.keys ?? []).entries()) { const s = seedForKey(k, st, i, args, actor); if (!s) return undefined; seeds.push(s); }
        return { pda: { seeds } };
      }
      case 'recipient': {
        if (!role.from) return undefined;
        const from = role.from;
        if ('arg' in from) return args.get(from.arg) as Ref | undefined;
        const st = design.accounts.find((a) => a.name === from.state)!;
        if (st.role === 'config') return { field: { account: configPda(), type: 'Config', path: from.field } };
        const seeds: Seed[] = [{ str: st.seedPrefix }];
        for (const [i, k] of (from.keys ?? []).entries()) { const s = seedForKey(k, st, i, args, actor); if (!s) return undefined; seeds.push(s); }
        return { field: { account: { pda: { seeds } }, type: st.name, path: from.field } };
      }
    }
  };

  let touched = new Set<string>();
  const ixStep = (ins: InstructionDesign, actor: string, vals: Val[] | null, valueWei: string | undefined, label: string, expectOk = true): Record<string, unknown> => {
    const argMap = new Map<string, unknown>();
    const out: Record<string, unknown> = {};
    for (const a of ins.args) {
      if (a.src >= 0) {
        if (!vals) throw new NotRunnable('missing arguments');
        const v = vals[a.src];
        if (v === undefined) throw new NotRunnable(`argument ${a.name} missing`);
        const conv = argValue(v, a.rust, a.scale, ctx, tokenKeys);
        argMap.set(a.name, conv); out[a.name] = conv;
      } else {
        const wei = BigInt(valueWei ?? '0');
        const div = BigInt(design.decimals.divisor);
        if (wei % div !== 0n) throw new NotRunnable(`msg.value ${wei} is not a multiple of the unit conversion`);
        const lam = wei / div;
        if (lam > (1n << 64n) - 1n) throw new NotRunnable('msg.value does not fit u64 lamports');
        argMap.set(a.name, lam.toString()); out[a.name] = lam.toString();
      }
    }
    const accounts: Record<string, Ref | null> = {};
    for (const role of ins.accounts) {
      const r = roleRef(role, ins, actor, argMap);
      if (r === undefined) continue;
      // an optional (view) entry that no earlier successful call could have created is passed as None
      accounts[role.name] = role.optional && !touched.has(JSON.stringify(r)) ? null : r;
      if (role.kind === 'entry' && role.init && expectOk) touched.add(JSON.stringify(r));
    }
    return { op: 'ix', id: label, name: ins.name, args: out, accounts, signers: [actorRef(actor)], payer: actorRef(actor) };
  };

  const readConfig = (as: string, id: string): Record<string, unknown> => ({ op: 'read_account', id, as, account: configPda(), type: 'Config' });

  for (const sc of set.scenarios) {
    touched = new Set<string>();
    const steps: Record<string, unknown>[] = [];
    const m: StepMeta[] = [];
    const push = (s: Record<string, unknown>, mm: StepMeta) => { steps.push(s); m.push(mm); };
    try {
      // fixtures
      push({ op: 'warp', unix_timestamp: T0(set) + sc.deploy.at - 300 }, { kind: 'setup' });
      for (const t of set.tokens) {
        const key = tokenKeys.get(t.name) ?? t.name;
        push({ op: 'spl_create_mint', name: `${key}_mint`, decimals: design.decimals.solana, authority: actorRef('deployer'), freeze: null, payer: actorRef('deployer') }, { kind: 'setup' });
        for (const a of set.actors) push({ op: 'spl_create_ata', owner: actorRef(a), mint: `name:${key}_mint`, payer: actorRef('deployer') }, { kind: 'setup' });
        for (const f of t.fundings) {
          const n = BigInt(f.amount); const div = BigInt(design.decimals.divisor);
          push({ op: 'spl_mint_to', mint: `name:${key}_mint`, to: { ata: { owner: actorRef(f.actor), mint: `name:${key}_mint` } }, amount: (n / div).toString(), authority: actorRef('deployer') }, { kind: 'setup' });
        }
      }
      // deployment
      push({ op: 'warp', unix_timestamp: T0(set) + sc.deploy.at }, { kind: 'time' });
      push(ixStep(init, sc.deploy.actor, sc.deploy.args, sc.deploy.valueWei, 'deploy', sc.deploy.expect?.status !== 'revert'), { kind: 'deploy' });
      // steps
      for (const [i, st] of sc.steps.entries()) {
        push({ op: 'warp', unix_timestamp: T0(set) + st.at }, { kind: 'time' });
        if (st.type === 'call' && st.fn === 'tokenTransfer') {
          // fixture step: the actor moves mock-token units to the contract's vault (or another actor)
          const [tk, dest, amount] = st.args as [{ token: string }, Val, string];
          const key = tokenKeys.get(tk.token) ?? tk.token;
          const q = BigInt(amount); const dv = BigInt(design.decimals.divisor);
          const meta0: StepMeta = { kind: 'call', scenarioStep: i, fn: st.fn };
          if (q % dv !== 0n) { push({ op: 'advance', seconds: 0 }, { ...meta0, notRunnable: `funding ${q} is not a multiple of the unit conversion` }); continue; }
          const toOwner: Ref = dest === 'contract' ? configPda() : actorRef((dest as { actor: string }).actor);
          push({ op: 'spl_transfer', from: { ata: { owner: actorRef(st.actor), mint: `name:${key}_mint` } }, to: { ata: { owner: toOwner, mint: `name:${key}_mint` } }, amount: (q / dv).toString(), authority: actorRef(st.actor) }, meta0);
          continue;
        }
        if (st.type === 'call') {
          const ins = st.fn === 'receive' ? design.instructions.find((x) => x.kind === 'receive') : design.instructions.find((x) => x.solidity === st.fn && x.kind === 'function');
          if (!ins) { push({ op: 'advance', seconds: 0 }, { kind: 'call', scenarioStep: i, fn: st.fn, notRunnable: `${st.fn} has no instruction in the design (not translated)` }); continue; }
          try { push(ixStep(ins, st.actor, st.args, st.valueWei, `step${i}`, st.expect?.status !== 'revert'), { kind: 'call', scenarioStep: i, fn: st.fn }); }
          catch (e) { if (!(e instanceof NotRunnable)) throw e; push({ op: 'advance', seconds: 0 }, { kind: 'call', scenarioStep: i, fn: st.fn, notRunnable: e.message }); }
        } else {
          viewStep(st, i, ctx, push, readConfig, roleRef, tokenKeys, touched);
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
  void spec;
  return { plan, meta, notRunnable };
}

function viewStep(
  st: Extract<Step, { type: 'view' }>, i: number, ctx: AdapterContext, push: (s: Record<string, unknown>, m: StepMeta) => void,
  readConfig: (as: string, id: string) => Record<string, unknown>, roleRef: (r: AccountRole, ins: InstructionDesign, actor: string, args: Map<string, unknown>) => Ref | undefined, tokenKeys: Map<string, string>, touched: Set<string>,
) {
  const { design } = ctx;
  const obs = own(design.observables, st.fn);
  const id = `view${i}`;
  const nr = (reason: string) => push({ op: 'advance', seconds: 0 }, { kind: 'view', scenarioStep: i, fn: st.fn, notRunnable: reason });
  if (!obs) return nr(`${st.fn} is not mapped to anything on Solana`);
  const argRef = (k: number): Ref | undefined => { const v = st.args[k]; return v && typeof v === 'object' && !Array.isArray(v) && 'actor' in v ? actorRef(v.actor) : undefined; };
  switch (obs.kind) {
    case 'unobservable': return nr(obs.reason);
    case 'config-field': {
      const field = obs.field;
      const idx = st.args[0];
      const path: (string | number)[] = [field, ...(st.args.length === 1 && (typeof idx === 'string' || typeof idx === 'number') ? [Number(idx)] : [])];
      return push(readConfig(id, id), { kind: 'view', scenarioStep: i, fn: st.fn, observable: obs, scale: obs.scale, read: { type: 'field', path, default: undefined } });
    }
    case 'array-length': return push(readConfig(id, id), { kind: 'view', scenarioStep: i, fn: st.fn, observable: obs, scale: 'plain', read: { type: 'field', path: [obs.field], default: undefined } });
    case 'membership': {
      const a = argRef(0);
      if (!a) return nr('membership argument is not an actor');
      return push(readConfig(id, id), { kind: 'view', scenarioStep: i, fn: st.fn, observable: obs, read: { type: 'membership', actor: String(a) } });
    }
    case 'mint-pubkey': {
      const map: Record<string, string> = {};
      for (const t of design.tokens) map[`name:${t.key}_mint`] = `token:${t.solidity}`;
      return push(readConfig(id, id), { kind: 'view', scenarioStep: i, fn: st.fn, observable: obs, read: { type: 'mint-token', field: design.tokens.find((t) => t.key === obs.token)!.mintField, map } });
    }
    case 'entry-field': {
      const acc = design.accounts.find((a) => a.name === obs.state)!;
      const seeds: Seed[] = [{ str: acc.seedPrefix }];
      for (const [k, key] of acc.keys.entries()) {
        const v = st.args[k];
        if (key.rust === 'Pubkey') { const r = argRef(k); if (!r) return nr('mapping key is not an actor'); seeds.push({ ref: r }); }
        else { if (v === undefined) return nr('missing key'); seeds.push({ u64: String(typeof v === 'object' ? 0 : v) }); }
      }
      const field = acc.fields.find((f) => f.name === obs.field)!;
      const def = field.rust === 'bool' ? false : field.rust === 'Pubkey' ? 'zero' : '0';
      return push({ op: 'read_account', id, as: id, account: { pda: { seeds } }, type: acc.name }, { kind: 'view', scenarioStep: i, fn: st.fn, observable: obs, scale: obs.scale, read: { type: 'field', path: [obs.field], default: def } });
    }
    case 'view-instruction': {
      const ins = design.instructions.find((x) => x.name === obs.instruction)!;
      try {
        const argMap = new Map<string, unknown>();
        const out: Record<string, unknown> = {};
        for (const a of ins.args) { if (a.src < 0) continue; const conv = argValue(st.args[a.src]!, a.rust, a.scale, ctx, tokenKeys); argMap.set(a.name, conv); out[a.name] = conv; }
        const accounts: Record<string, Ref | null> = {};
        for (const role of ins.accounts) { const r = roleRef(role, ins, 'deployer', argMap); if (r !== undefined) accounts[role.name] = role.optional && !touched.has(JSON.stringify(r)) ? null : r; }
        return push({ op: 'ix', id, name: ins.name, args: out, accounts, signers: [actorRef('deployer')], payer: actorRef('deployer') }, { kind: 'view', scenarioStep: i, fn: st.fn, observable: obs, scale: obs.scale, read: { type: 'return', rust: ins.returns!.rust } });
      } catch (e) { if (e instanceof NotRunnable) return nr(e.message); throw e; }
    }
    case 'token-balance': {
      const [tk, holder] = st.args as [{ token: string }, Val];
      const key = tokenKeys.get(tk.token) ?? tk.token;
      const owner: Ref = holder === 'contract' ? configPda() : actorRef((holder as { actor: string }).actor);
      return push({ op: 'read_account', id, as: id, account: { ata: { owner, mint: `name:${key}_mint` } }, type: 'token' }, { kind: 'view', scenarioStep: i, fn: st.fn, observable: obs, scale: 'token', read: { type: 'token', field: 'amount' } });
    }
  }
}

// ------------------------------------------------------------------- template (SPL) plan

export interface TemplateInfo { initialSupplyParam: number | null; decimalsFn: boolean; mintable: boolean; burnable: boolean; ownable: boolean }

export function buildSplPlan(ctx: AdapterContext, t: TemplateInfo): BuiltPlan {
  const { design, set } = ctx;
  const div = BigInt(design.decimals.divisor);
  const plan: RunnerPlan = { version: 1, clock_start: set.t0 - 2000, actors: set.actors, scenarios: [] };
  const meta = new Map<string, StepMeta[]>();
  const notRunnable = new Map<string, string>();
  const MINT = 'name:mint';
  const ata = (a: Ref): Ref => ({ ata: { owner: a, mint: MINT } });
  const who = (v: Val): string => {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) { if ('actor' in v) return actorRef(v.actor); if ('zero' in v) return SYSTEM_ZERO; }
    throw new NotRunnable(`cannot express ${JSON.stringify(v)} as an owner`);
  };
  const amt = (v: Val): string => {
    const n = BigInt(v as string);
    if (n % div !== 0n) throw new NotRunnable(`amount ${n} is not a multiple of 10^${design.decimals.original - design.decimals.solana}`);
    const r = n / div;
    if (r > (1n << 64n) - 1n) throw new NotRunnable(`amount ${n} does not fit a u64 SPL amount at ${design.decimals.solana} decimals`);
    return r.toString();
  };
  for (const sc of set.scenarios) {
    const steps: Record<string, unknown>[] = [];
    const m: StepMeta[] = [];
    const push = (s: Record<string, unknown>, mm: StepMeta) => { steps.push(s); m.push(mm); };
    const ensureAta = (owner: Ref) => push({ op: 'spl_create_ata', owner, mint: MINT, payer: actorRef('deployer') }, { kind: 'setup' });
    const approvals = new Map<string, Set<string>>();
    const allowed = new Map<string, bigint>(); // (owner->spender) in SPL base units, mirrors the Solidity allowance mapping
    try {
      push({ op: 'warp', unix_timestamp: T0(set) + sc.deploy.at }, { kind: 'time' });
      // deployment = create the mint; deployer is the mint authority (the Solidity owner)
      const depArgs = sc.deploy.args;
      let supply = 0n;
      if (t.initialSupplyParam !== null && depArgs[t.initialSupplyParam] !== undefined) supply = BigInt(depArgs[t.initialSupplyParam] as string);
      const bad = supply !== 0n && supply % div !== 0n;
      if (bad) throw new NotRunnable('initial supply is not a multiple of the unit conversion');
      if (supply / div > (1n << 64n) - 1n) throw new NotRunnable(`initial supply ${supply} does not fit a u64 SPL amount at ${design.decimals.solana} decimals`);
      push({ op: 'spl_create_mint', name: 'mint', decimals: design.decimals.solana, authority: actorRef(sc.deploy.actor), freeze: null, payer: actorRef('deployer') }, { kind: 'deploy' });
      for (const a of set.actors) ensureAta(actorRef(a));
      if (supply > 0n) push({ op: 'spl_mint_to', mint: MINT, to: ata(actorRef(sc.deploy.actor)), amount: (supply / div).toString(), authority: actorRef(sc.deploy.actor) }, { kind: 'deploy' });
      // a fixed-supply, non-ownable original has no mint path: the deploy recipe disables the mint authority after the initial supply, so the test does too
      if (!t.mintable && !t.ownable) push({ op: 'spl_set_authority', target: MINT, authority_type: 'mint', new: null, current: actorRef(sc.deploy.actor) }, { kind: 'setup' });
      for (const [i, st] of sc.steps.entries()) {
        push({ op: 'warp', unix_timestamp: T0(set) + st.at }, { kind: 'time' });
        if (st.type === 'call') {
          const a = actorRef(st.actor);
          const callMeta: StepMeta = { kind: 'call', scenarioStep: i, fn: st.fn };
          const zeroArg = st.args.some((x) => typeof x === 'object' && x !== null && !Array.isArray(x) && 'zero' in x);
          const zeroNote = zeroArg ? 'SPL Token has no zero-address guard: the zero address is just another owner key' : undefined;
          try {
            switch (st.fn) {
              case 'transfer': { const to = who(st.args[0]!); if (to === SYSTEM_ZERO) ensureAta(to); push({ op: 'spl_transfer', from: ata(a), to: ata(to), amount: amt(st.args[1]!), authority: a }, { ...callMeta, ...(zeroNote ? { documented: zeroNote } : {}) }); break; }
              case 'approve': {
                const sp = who(st.args[0]!);
                const set2 = approvals.get(st.actor) ?? new Set(); set2.add(String(sp)); approvals.set(st.actor, set2);
                const am = amt(st.args[1]!); allowed.set(`${a}->${sp}`, BigInt(am));
                push({ op: 'spl_approve', account: ata(a), delegate: sp, amount: am, owner: a }, { ...callMeta, ...(zeroNote ? { documented: zeroNote } : {}) }); break;
              }
              case 'increaseAllowance': case 'decreaseAllowance': {
                const sp = who(st.args[0]!); const delta = BigInt(amt(st.args[1]!));
                const key = `${a}->${sp}`; const cur = allowed.get(key) ?? 0n;
                if (st.fn === 'decreaseAllowance' && delta > cur) { push({ op: 'advance', seconds: 0 }, { ...callMeta, documented: 'decreasing an allowance below zero reverts in Solidity; an SPL delegate amount has no such check, so the rewrite performs no call here (documented difference: the revert is not reproduced)' }); break; }
                const next = st.fn === 'increaseAllowance' ? cur + delta : cur - delta;
                if (next > (1n << 64n) - 1n) throw new NotRunnable('allowance does not fit u64');
                allowed.set(key, next);
                const set2 = approvals.get(st.actor) ?? new Set(); set2.add(String(sp)); approvals.set(st.actor, set2);
                push({ op: 'spl_approve', account: ata(a), delegate: sp, amount: next.toString(), owner: a }, { ...callMeta, documented: 'increase/decreaseAllowance are modelled as an SPL approve of the new total' }); break;
              }
              case 'transferFrom': { const from = who(st.args[0]!), to = who(st.args[1]!); if (to === SYSTEM_ZERO) ensureAta(to); { const k2 = `${from}->${a}`; const c2 = allowed.get(k2); if (c2 !== undefined && c2 < (1n << 64n) - 1n) { const am2 = BigInt(amt(st.args[2]!)); if (am2 <= c2) allowed.set(k2, c2 - am2); } } push({ op: 'spl_transfer', from: ata(from), to: ata(to), amount: amt(st.args[2]!), authority: a }, { ...callMeta, ...(zeroNote ? { documented: zeroNote } : {}) }); break; }
              case 'mint': { const to = who(st.args[0]!); if (to === SYSTEM_ZERO) ensureAta(to); push({ op: 'spl_mint_to', mint: MINT, to: ata(to), amount: amt(st.args[1]!), authority: a }, { ...callMeta, ...(zeroNote ? { documented: zeroNote } : {}) }); break; }
              case 'burn': push({ op: 'spl_burn', account: ata(a), mint: MINT, amount: amt(st.args[0]!), authority: a }, callMeta); break;
              case 'transferOwnership': { const to = who(st.args[0]!); push({ op: 'spl_set_authority', target: MINT, authority_type: 'mint', new: to, current: a }, { ...callMeta, ...(zeroNote ? { documented: 'SPL set_authority accepts the zero address; the Solidity contract rejects it' } : {}) }); break; }
              case 'renounceOwnership': push({ op: 'spl_set_authority', target: MINT, authority_type: 'mint', new: null, current: a }, callMeta); break;
              default: throw new NotRunnable(`${st.fn} is not part of the standard token recipe`);
            }
          } catch (e) { if (!(e instanceof NotRunnable)) throw e; push({ op: 'advance', seconds: 0 }, { ...callMeta, notRunnable: e.message }); }
        } else {
          const id = `view${i}`;
          const base = { kind: 'view' as const, scenarioStep: i, fn: st.fn };
          try {
            switch (st.fn) {
              case 'balanceOf': push({ op: 'read_account', id, as: id, account: ata(who(st.args[0]!)), type: 'token' }, { ...base, scale: 'token', read: { type: 'token', field: 'amount' } }); break;
              case 'totalSupply': push({ op: 'read_account', id, as: id, account: MINT, type: 'mint' }, { ...base, scale: 'token', read: { type: 'field', path: ['supply'], default: undefined } }); break;
              case 'owner': push({ op: 'read_account', id, as: id, account: MINT, type: 'mint' }, { ...base, read: { type: 'field', path: ['mint_authority'], default: undefined } }); break;
              case 'decimals': push({ op: 'advance', seconds: 0 }, { ...base, skip: `decimals differ by design (${design.decimals.original} vs ${design.decimals.solana})` }); break;
              case 'name': case 'symbol': case 'tokenURI': push({ op: 'advance', seconds: 0 }, { ...base, skip: 'metadata is not on the mint' }); break;
              case 'allowance': { const owner = who(st.args[0]!); const sp = who(st.args[1]!); push({ op: 'read_account', id, as: id, account: ata(owner), type: 'token' }, { ...base, scale: 'token', read: { type: 'allowance', spender: String(sp) } }); break; }
              case 'tokenBalance': throw new NotRunnable('no token fixtures in a standard token');
              default: throw new NotRunnable(`${st.fn} is not readable from an SPL mint (metadata/other)`);
            }
          } catch (e) { if (!(e instanceof NotRunnable)) throw e; push({ op: 'advance', seconds: 0 }, { ...base, notRunnable: e.message }); }
        }
      }
    } catch (e) {
      if (!(e instanceof NotRunnable)) throw e;
      notRunnable.set(sc.id, e.message);
      plan.scenarios.push({ id: sc.id, steps: [] }); meta.set(sc.id, []);
      continue;
    }
    for (const mm of m) if (mm.fn === 'allowance' && [...approvals.values()].some((s) => s.size > 1)) mm.documented = 'SPL Token keeps one delegate per token account: a second approve replaces the first';
    plan.scenarios.push({ id: sc.id, steps }); meta.set(sc.id, m);
  }
  return { plan, meta, notRunnable };
}
