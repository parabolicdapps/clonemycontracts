import { nullRecord } from '../../own.js';
import { untranslatable } from '../../spec/standard.js';
import { initialPlans, unresolvedInitials } from '../../spec/initial.js';
import type { InitialValue, ContractSpec, FunctionSpec, TypeRef } from '../../types.js';
import type { ArgD, HandlerD, KeyD, ObservableD, ReturnD, StateVarD, StructD, TezosDesign, TokenDepD } from './design-types.js';
import { entryName, pascal, snake, typeMap, type TypeMap } from './names.js';

export interface DesignOptions { originalDecimals?: number }

const isPublic = (f: FunctionSpec) => f.visibility === 'public' || f.visibility === 'external';

function keyOf(t: TypeRef): KeyD | null {
  switch (t.kind) {
    case 'address': case 'contract': case 'uint': case 'int': case 'string': case 'bool': case 'enum': case 'fixedbytes': case 'bytes': { const m = typeMap(t); return { t: m, sp: m.sp }; }
    default: return null;
  }
}

/** SmartPy type of the key of a (possibly nested) mapping */
export const keyType = (keys: KeyD[]): string => (keys.length === 1 ? keys[0]!.sp : keys.length === 2 ? `sp.pair[${keys[0]!.sp}, ${keys[1]!.sp}]` : `sp.tuple[${keys.map((k) => k.sp).join(', ')}]`);

const initLiteral = (sv: { initial?: InitialValue }, m: TypeMap): string | undefined => {
  const v = sv.initial;
  if (!v) return undefined;
  if (m.kind === 'uint' && v.kind === 'uint') return `sp.nat(${v.value})`;
  if (m.kind === 'int' && (v.kind === 'int' || v.kind === 'uint')) return `sp.int(${v.value})`;
  if (m.kind === 'bool' && v.kind === 'bool') return v.value === 'true' ? 'True' : 'False';
  if (m.kind === 'string' && v.kind === 'string') return JSON.stringify(v.value);
  return undefined;
};

export function buildDesign(spec: ContractSpec, opts: DesignOptions = {}): TezosDesign {
  const origDec = opts.originalDecimals ?? 18;
  const notTranslated: TezosDesign['notTranslated'] = [];
  const notes: string[] = [];
  const nt = (feature: string, where: string, reason: string) => { if (!notTranslated.some((x) => x.feature === feature && x.where === where)) notTranslated.push({ feature, where, reason }); };

  // ------------------------------------------------------------ structs
  const structs: StructD[] = [];
  for (const s of spec.structs) {
    const fields = s.fields.map((f) => ({ name: snake(f.name), solidity: f.name, t: typeMap(f.type) }));
    const bad = fields.find((f) => f.t.kind === 'unsupported' || f.t.kind === 'struct');
    if (bad) { nt('struct with an unsupported field', s.name, `field ${bad.solidity}: ${bad.t.why ?? 'nested struct'}`); continue; }
    structs.push({ name: s.name, solidity: s.name, fields });
  }
  const structOf = (t: TypeRef): string | undefined => (t.kind === 'struct' ? structs.find((s) => s.name === t.name)?.name : undefined);

  // ------------------------------------------------------------ constants and state
  const state: StateVarD[] = [];
  const constants: TezosDesign['constants'] = [];
  const used = new Set<string>();
  const uniq = (n: string) => { let x = n; while (used.has(x) || x === 'deployer' || x === 'initialized') x += '_'; used.add(x); return x; };
  for (const sv of spec.stateVars) {
    if (sv.constant) { constants.push({ name: snake(sv.name), solidity: sv.name, value: sv.initialValue ?? null }); continue; }
    const base = { solidity: sv.name, name: uniq(snake(sv.name)), public: sv.visibility === 'public', immutable: sv.immutable };
    const bail = (why: string): void => { state.push({ ...base, kind: 'item', value: { kind: 'unsupported', sp: 'sp.unit', zero: '()' }, keys: [], zero: '()', unsupported: why }); nt('unsupported state variable type', sv.name, why); };
    let t = sv.type;
    const keys: KeyD[] = [];
    let kind: StateVarD['kind'] = 'item';
    let fixedLen: number | undefined;
    if (t.kind === 'mapping') {
      kind = 'map';
      let ok = true;
      while (t.kind === 'mapping') { const k = keyOf(t.key!); if (!k) { ok = false; bail(`mapping key ${t.key!.solidity}`); break; } keys.push(k); t = t.value!; }
      if (!ok) continue;
    } else if (t.kind === 'array') {
      kind = 'array'; fixedLen = t.length; keys.push({ t: typeMap({ solidity: 'uint256', kind: 'uint', bits: 256 }), sp: 'sp.nat' }); t = t.element!;
    }
    const sname = structOf(t);
    if (t.kind === 'struct' && !sname) { bail(`struct ${t.name} has unsupported fields`); continue; }
    const value = typeMap(t);
    if (value.kind === 'unsupported' || (value.kind === 'array' && kind !== 'item')) { bail(value.why ?? `type ${t.solidity}`); continue; }
    if (value.kind === 'array') { bail('array-valued state variable inside a mapping/array'); continue; }
    const init = kind === 'item' ? initLiteral(sv, value) : undefined;
    state.push({ ...base, kind, value, ...(sname ? { struct: sname } : {}), keys, ...(fixedLen ? { fixedLen } : {}), zero: value.zero, ...(init ? { init } : {}) });
  }
  const stateByName = new Map(state.map((s) => [s.solidity, s]));

  // ------------------------------------------------------------ token dependencies
  const tokens: TokenDepD[] = spec.tokenDependencies.map((t) => ({ solidity: t.name.replace(/^_/, ''), stateName: state.find((s) => s.solidity === t.name)?.name ?? null, methods: t.methods }));

  // ------------------------------------------------------------ handlers
  const handlers: HandlerD[] = [];
  const sendsNative = (fn: FunctionSpec) => fn.externalCalls.some((e) => e.low && e.sendsValue);
  const allFns = [...(spec.constructor ? [spec.constructor] : []), ...spec.functions.filter((f) => f.kind === 'receive' || (f.kind === 'function' && isPublic(f)))];
  const nativeUsed = allFns.some((f) => f.payable || sendsNative(f)) || spec.functions.some((f) => sendsNative(f));

  const argsOf = (fn: FunctionSpec, label: string): ArgD[] | null => {
    const out: ArgD[] = [];
    const seen = new Set<string>();
    for (const [i, p] of fn.params.entries()) {
      const t = typeMap(p.type);
      if (t.kind === 'unsupported' || t.kind === 'struct') { nt('unsupported parameter type', label, `${label}: parameter ${p.name} has type ${p.type.solidity}`); return null; }
      let n = snake(p.name || `arg${i}`);
      while (seen.has(n)) n += '_';
      seen.add(n);
      out.push({ name: n, solidity: p.type.solidity, t, src: i, ...(t.kind === 'array' && t.fixed ? { note: `fixed array of ${t.fixed}: the length is checked by the generated prologue` } : {}) });
    }
    return out;
  };
  const reqs = (fn: FunctionSpec) => fn.requires.map((r) => `${r.kind}(${r.condition})${r.message ? ` "${r.message}"` : ''}${r.fromModifier ? ` [from modifier ${r.fromModifier}]` : ''}`);
  const fnNotes = (fn: FunctionSpec): string[] => {
    const n: string[] = [];
    if (fn.usesTimestamp) n.push('uses block.timestamp: `self.now_secs()` gives it as a nat (seconds)');
    for (const e of fn.externalCalls) {
      if (e.low && e.sendsValue) n.push(`${e.target}.call{value: ..}(data): only the value transfer is translated, as \`self.send_native(..)\`; the calldata is not executed (a Tezos contract cannot run arbitrary calldata)`);
      else if (e.low) n.push(`low-level call ${e.target}.${e.method}(...) is not translated`);
      else if (/^(balanceOf|allowance|totalSupply|decimals)$/.test(e.method)) n.push(`${e.target}.${e.method}(...) reads another contract: Tezos has no synchronous call-and-read (operations run after this entrypoint returns); this read is NOT translated, keep an internal accounting variable instead and add a DEVIATION comment`);
      else if (e.targetType && /^I?ERC20/.test(e.targetType) === false && !spec.tokenDependencies.some((t) => e.target.includes(t.name.replace(/^_/, '')))) n.push(`external call ${e.target}.${e.method}(...) to a contract that is not an ERC-20 is not translated`);
    }
    for (const m of fn.mappingAccesses) { const sv = stateByName.get(m.variable); if (sv?.unsupported) n.push(`${m.variable} is not available in the generated state (${sv.unsupported})`); }
    return n;
  };

  const taken = new Set<string>();
  // constructor -> initialize
  const ctor = spec.constructor;
  const hasInitialize = !!ctor;
  if (ctor) {
    const args = argsOf(ctor, 'constructor') ?? [];
    handlers.push({ unit: 'initialize', kind: 'initialize', name: 'initialize', solidity: 'constructor', args, payable: !!ctor.payable, emits: ctor.events, requires: reqs(ctor), writes: ctor.writes, notes: fnNotes(ctor) });
    taken.add('initialize');
  }
  const mkReturns = (fn: FunctionSpec): ReturnD | undefined | null => {
    if (!fn.returns.length) return undefined;
    const fields = fn.returns.map((r, i) => ({ name: r.name ? snake(r.name) : `field${i}`, solidity: r.type.solidity, t: typeMap(r.type) }));
    if (fields.some((f) => f.t.kind === 'unsupported' || f.t.kind === 'struct')) return null;
    const seen = new Set<string>(); for (const f of fields) { while (seen.has(f.name)) f.name += '_'; seen.add(f.name); }
    return { single: fields.length === 1, fields };
  };

  for (const f of spec.functions) {
    { const u = untranslatable(f); if (u && isPublic(f)) { nt(u.feature, f.name, u.reason); continue; } }
    if (f.kind === 'fallback') { nt('fallback function', 'fallback', 'Tezos has no fallback entrypoint; unknown entrypoints are rejected'); continue; }
    if (f.kind === 'receive') {
      const name = entryName('deposit', taken);
      handlers.push({ unit: `ep_${name}`, kind: 'entrypoint', name, solidity: 'receive', args: [], payable: true, emits: f.events, requires: reqs(f), writes: f.writes, notes: ['receive(): plain native deposits become an explicit entrypoint (call it with an amount); read the attached amount with `self.msg_value()`', ...fnNotes(f)] });
      continue;
    }
    if (f.kind !== 'function' || !isPublic(f)) continue;
    // a function that reads or writes state the target cannot represent (struct-valued `_roles`, nested structs, bytes32-keyed role data) is left out cleanly instead of referencing missing state
    { const missing = [...new Set([...f.reads, ...f.writes, ...f.mappingAccesses.map((m) => m.variable)])].filter((v) => stateByName.get(v)?.unsupported); if (missing.length) { nt('depends on state that is not generated', f.name, `uses ${missing.join(', ')}: ${stateByName.get(missing[0]!)!.unsupported}; the function is not translated rather than left referencing missing state`); continue; } }
    const isView = f.mutability === 'view' || f.mutability === 'pure';
    const args = argsOf(f, f.name);
    if (!args) continue;
    const name = entryName(f.name, taken);
    if (isView) {
      const ret = mkReturns(f);
      if (ret === null) { nt('unsupported return type', f.name, 'a returned value has a type that is not mapped'); continue; }
      if (!ret) { nt('view without return value', f.name, 'nothing to expose'); continue; }
      handlers.push({ unit: `view_${name}`, kind: 'view', name, solidity: f.name, args, payable: false, returns: ret, emits: [], requires: reqs(f), writes: [], notes: fnNotes(f) });
    } else {
      handlers.push({ unit: `ep_${name}`, kind: 'entrypoint', name, solidity: f.name, args, payable: f.payable, emits: f.events, requires: reqs(f), writes: f.writes, notes: [...fnNotes(f), ...(f.returns.length ? ['the Solidity return value is dropped (a Tezos entrypoint returns nothing)'] : [])] });
    }
  }

  // public getters of state variables: views written by code
  const hasFn = (name: string) => spec.functions.some((f) => f.name === name && f.kind === 'function' && isPublic(f));
  for (const sv of state) {
    if (!sv.public || sv.unsupported || hasFn(sv.solidity) || sv.struct || sv.value.kind === 'array') continue;
    const name = entryName(sv.solidity, taken);
    const args: ArgD[] = sv.keys.map((k, i) => ({ name: i === 0 ? 'key' : `key${i + 1}`, solidity: k.t.kind === 'address' ? 'address' : 'uint256', t: k.t, src: i }));
    const call = args.length === 1 ? args[0]!.name : `(${args.map((a) => a.name).join(', ')})`;
    const body = sv.kind === 'item' ? `return self.data.${sv.name}` : `return self.get_${sv.name}(${call})`;
    handlers.push({ unit: `view_${name}`, kind: 'view', name, solidity: sv.solidity, args, payable: false, returns: { single: true, fields: [{ name: 'value', solidity: sv.value.sp, t: sv.value }] }, generated: { why: `public state variable ${sv.solidity}`, body }, emits: [], requires: [], writes: [], notes: [] });
  }
  for (const c of constants) {
    const sv = spec.stateVars.find((s) => s.name === c.solidity)!;
    if (sv.visibility !== 'public' || hasFn(sv.name)) continue;
    const m = typeMap(sv.type);
    const lit = c.value?.trim();
    let body: string | null = null;
    if (lit && /^\d+$/.test(lit) && m.kind === 'uint') body = `return sp.nat(${lit})`;
    else if (lit === 'true' || lit === 'false') body = `return ${lit === 'true' ? 'True' : 'False'}`;
    if (!body) { nt('public constant with a computed value', sv.name, `\`${lit ?? '?'}\` is not a plain literal: not exposed as a view (inline it where used)`); continue; }
    const name = entryName(c.solidity, taken);
    handlers.push({ unit: `view_${name}`, kind: 'view', name, solidity: sv.name, args: [], payable: false, returns: { single: true, fields: [{ name: 'value', solidity: sv.type.solidity, t: m }] }, generated: { why: `public constant ${sv.name}`, body }, emits: [], requires: [], writes: [], notes: [] });
  }

  // ------------------------------------------------------------ observables
  const observables: Record<string, ObservableD> = nullRecord<ObservableD>();
  for (const h of handlers) if (h.kind === 'view') observables[h.solidity] = { kind: 'view', unit: h.unit };
  for (const sv of state) if (sv.public && !observables[sv.solidity]) observables[sv.solidity] = { kind: 'unobservable', reason: sv.unsupported ?? (sv.struct ? 'public getter of a struct-valued variable returns a tuple: not generated' : 'no view generated') };
  for (const c of constants) if (!observables[c.solidity]) observables[c.solidity] = { kind: 'unobservable', reason: 'constant is inlined, not stored' };
  observables['tokenBalance'] = { kind: 'token-balance' };

  // ------------------------------------------------------------ non-portable features, Tezos wording
  for (const nf of spec.nonPortable) {
    const where = nf.where.join(', ');
    switch (nf.id) {
      case 'delegatecall': nt('delegatecall', where, 'Tezos has no delegatecall; code reuse is by calling another contract or by lambdas, which changes the storage semantics'); break;
      case 'assembly': nt('inline assembly', where, 'no equivalent; must be re-expressed by hand'); break;
      case 'selfdestruct': nt('selfdestruct', where, 'no equivalent; Tezos contracts cannot be destroyed'); break;
      case 'tx.origin': nt('tx.origin', where, 'Tezos has sp.source (the account that started the chain of operations) and sp.sender (the direct caller); not generated, use sp.sender'); break;
      case 'block.coinbase': case 'block.prevrandao': case 'block.difficulty': case 'block.gaslimit': case 'block-context': nt(nf.title, where, 'not available to contracts'); break;
      case 'signatures': nt('ecrecover / signature verification', where, 'Tezos verifies signatures with sp.check_signature against a public key; the EVM hashing/recovery scheme must be redesigned'); break;
      case 'contract-creation': nt('contract creation (new)', where, 'a Tezos contract can originate another (sp.create_contract) but this is not generated'); break;
      case 'msg.data': nt('msg.data', where, 'raw calldata does not exist'); break;
      case 'low-level-call': {
        const sendOnly = spec.functions.concat(spec.constructor ? [spec.constructor] : []).filter((f) => nf.where.includes(f.name)).every((f) => f.externalCalls.every((e) => !e.low || e.sendsValue));
        if (sendOnly) notes.push(`Low-level \`call{value}(data)\` in ${where}: the value transfer becomes \`self.send_native\`; the calldata is dropped (documented difference: a Solidity multisig that executes arbitrary data can only send native coin here).`);
        else nt('low-level call with arbitrary data', where, 'arbitrary calldata to arbitrary targets has no form in Tezos without an explicit entrypoint type');
        break;
      }
      case 'block.number': notes.push(`block.number is used in ${where}: sp.level is the closest value; Tezos levels and block times differ from Ethereum.`); break;
      case 'block.chainid': notes.push(`block.chainid is used in ${where}: sp.chain_id is a 4-byte value, not an integer.`); break;
      case 'abi-encoding': notes.push(`abi.encode / keccak hashing in ${where}: encodings differ (Michelson uses sp.pack and sp.keccak/sp.blake2b); hashes that must equal EVM hashes cannot be reproduced.`); break;
      case 'upgradeability': notes.push('Upgradeability: proxy patterns are not translated; a Tezos contract is upgraded only if it was written with an updatable lambda/entrypoint table (not generated).'); break;
      case 'reentrancy-guard': notes.push(`Reentrancy guard in ${where}: not needed on Tezos. Operations emitted by an entrypoint run after it returns, so the contract cannot be re-entered in the middle of its own execution; update state before emitting operations anyway.`); break;
      default: break;
    }
  }

  if (spec.tokenStandards.length) notes.push(`The contract implements ${spec.tokenStandards.join(', ')} itself: it is rewritten as custom code, so it is NOT an FA1.2/FA2 token other contracts can rely on (use the template path for a plain token).`);
  if (tokens.length) notes.push('ERC-20 tokens the contract calls are FA1.2 contracts (TZIP-7), chosen over FA2 because FA1.2 keeps the ERC-20 allowance model: `approve(spender, value)` and `transfer(from, to, value)` where the sender spends an allowance when from is not the sender. FA2 has operators (a spender may move ANY amount) and token ids, which is a different trust model. `transferFrom(msg.sender, address(this), x)` becomes `self.erc20_transfer_from(...)` (the caller approves this contract first); `transfer(to, x)` becomes `self.erc20_transfer(...)`. Tezos operations are executed AFTER the entrypoint returns: a token call is queued, not run inline, and its result cannot be read in the same entrypoint (so `balanceOf` of another contract mid-function is not translated). If a queued operation fails, the whole transaction including this entrypoint\'s state changes is reverted.');
  if (nativeUsed) notes.push('Native value: `msg.value` is `self.msg_value()` = the attached amount in mutez as a nat; sending native value is `self.send_native(...)`. Unit choice: 1 mutez is treated as the base unit exactly like 1 wei (NO rescaling: amounts keep the magnitude the Solidity code and its scenarios use; 18-decimal ether amounts become 18-decimal mutez amounts). That keeps the arithmetic identical and the behaviour check meaningful, but a real deployment must reinterpret the constants (1 tez = 10^6 mutez, 1 ETH = 10^18 wei): amounts written as `1 ether` are 10^12 tez here, so such contracts must have their constants rescaled by hand before use on a network (documented difference). Non-payable entrypoints reject attached tez (generated check).');
  notes.push('Addresses are `sp.address` (tz1/KT1). Solidity `address(0)` is the tz1 burn address `ZERO_ADDRESS` (Tezos has no zero address); a check `!= address(0)` still works as written.');
  notes.push('Storage: every Solidity state variable is a storage field; mappings are `big_map`s (nested mappings use a pair/tuple key) and a missing entry reads as the Solidity default (zero/false/zero address) through generated `get_*` helpers. Dynamic arrays are a `big_map[nat, T]` plus a `<name>_len` counter with generated `get_/push_/pop_` helpers.');
  if (hasInitialize) notes.push('Constructor: a Tezos contract has no constructor code, only initial storage. The generated storage starts with the Solidity defaults plus a `deployer` address and `initialized = False`; the constructor body is the entrypoint `initialize(...)`, callable once and only by `deployer` (the Solidity `msg.sender` of the constructor). Every other entrypoint refuses to run before `initialize` (generated check). Origination and `initialize` are two operations, not atomic like an EVM deployment.');
  notes.push('Execution model differences: (1) operations emitted by an entrypoint (token calls, sends) execute AFTER it returns, in order; there is no synchronous call-and-read of another contract; (2) there is no EVM-style reentrancy in the middle of an entrypoint; (3) if any entrypoint or any queued operation fails, the whole transaction is reverted (like a Solidity revert); (4) there is no gas limit visible to the contract and no loops over unbounded data should be written.');
  notes.push('Views: Solidity `view`/`pure` functions and public state getters are on-chain views (`@sp.onchain_view`), callable from other contracts and, via an RPC `run_view`, from off-chain clients without a transaction. They cannot read `sp.sender` or `sp.amount`.');
  if (spec.stateVars.some((v) => v.type.kind === 'enum')) notes.push('Enums are stored as nat.');

  const helpers = helperList({ state, tokens, native: nativeUsed || spec.functions.some((f) => f.usesTimestamp || /balance/.test(f.name)), structs });
  // inline initialisers: evaluated by code and written into the initial storage (never by the model)
  const initH = handlers.find((h) => h.kind === 'initialize');
  const senderInits = (spec.constructor?.senderAssignments ?? []).map((n) => state.find((x) => x.solidity === n && x.kind === 'item' && x.value.kind === 'address' && !x.unsupported)).filter(Boolean).map((x) => x!.name);
  if (initH && senderInits.length) initH.notes.push(`already applied by generated code (do NOT set them again): ${senderInits.join(', ')} = msg.sender`);
  if (initH) {
    const applied = state.filter((x) => x.init).map((x) => `${x.solidity} (${spec.stateVars.find((v) => v.name === x.solidity)?.initialValue})`);
    if (applied.length) initH.notes.push(`already applied by generated code in the initial storage (do NOT set them again): ${applied.join(', ')}`);
    for (const sv of unresolvedInitials(spec)) initH.notes.push(`state variable ${sv.name} has the initialiser \`${sv.initialValue}\` that code could not evaluate: set it in initialize`);
  }
  for (const pl of initialPlans(spec)) if (!pl.zero && !state.find((x) => x.solidity === pl.sv.name && x.init)) notes.push(`initialiser of \`${pl.sv.name}\` (= ${pl.sv.initialValue}) could not be placed in the initial storage (type or mapping): set it in initialize`);

  for (const h of handlers) if (h.kind !== 'initialize' && /_[0-9a-f]{8}$/.test(h.name) && h.name.length === 31) notes.push(`Entrypoint \`${h.name}\` is the deterministic short name (Michelson limits entrypoint names to 31 characters: 22 characters + hash of the full name) of the Solidity function \`${h.solidity}\`; the report and the scenarios use the Solidity name.`);

  return {
    senderInits,
    version: 1, mode: 'program', contractName: spec.name, className: pascal(spec.name), decimals: { original: origDec, target: origDec, divisor: '1' },
    integerPolicy: [
      'All Solidity unsigned integers (uint8..uint256) are `sp.nat` (arbitrary precision) and signed ones `sp.int`: no narrowing, no wrap-around, so no width conversions anywhere.',
      'Underflow: nat subtraction is `sp.as_nat(a - b, error="...")` which aborts the transaction when negative (the Solidity 0.8 behaviour).',
      'Overflow: Solidity reverts when a uint256 sum/product exceeds 2^256-1; a nat never does. Where a scenario depends on it the body wraps the result in `u256(x)` (aborts above 2^256-1). Narrower widths (uint8, uint64, ...) are NOT range checked, a documented difference.',
      'block.timestamp is `self.now_secs()` (seconds as a nat); durations are plain nat seconds; `sp.add_seconds` is not needed.',
    ],
    native: { used: nativeUsed }, hasSigned: [...state.map((x) => x.value), ...state.flatMap((x) => x.keys.map((k) => k.t)), ...handlers.flatMap((h) => [...h.args.map((a) => a.t), ...(h.returns?.fields.map((f) => f.t) ?? [])]), ...structs.flatMap((x) => x.fields.map((f) => f.t))].some((t) => t.kind === 'int'), hasInitialize, state, structs, tokens, instructions: handlers, observables, notTranslated, notes, constants, helpers,
  };
}

export function helperList(o: { state: StateVarD[]; tokens: TokenDepD[]; native: boolean; structs: StructD[] }): TezosDesign['helpers'] {
  const out: TezosDesign['helpers'] = [];
  for (const sv of o.state) {
    if (sv.unsupported) continue;
    if (sv.kind === 'map') out.push({ name: `get_${sv.name}`, sig: `self.get_${sv.name}(${sv.keys.length === 1 ? 'key' : `(${sv.keys.map((_, i) => `key${i + 1}`).join(', ')})`})`, doc: `reads ${sv.solidity}${sv.keys.map((k) => `[${k.sp}]`).join('')}: ${sv.value.sp}, a missing entry reads as the Solidity default (${sv.zero}). Write with \`self.data.${sv.name}[${sv.keys.length === 1 ? 'key' : '(k1, k2)'}] = value\`; \`del self.data.${sv.name}[key]\` is allowed` });
    if (sv.kind === 'array' && sv.fixedLen) {
      out.push({ name: `get_${sv.name}`, sig: `self.get_${sv.name}(index)`, doc: `reads ${sv.solidity}[index]: ${sv.value.sp} of the FIXED array of length ${sv.fixedLen}; aborts "INDEX_OUT_OF_BOUNDS" when index >= ${sv.fixedLen}; an unset element is the Solidity default. Write an element with \`self.data.${sv.name}[index] = value\` (index < ${sv.fixedLen}). There is no length field and no push/pop` });
    } else if (sv.kind === 'array') {
      out.push({ name: `get_${sv.name}`, sig: `self.get_${sv.name}(index)`, doc: `reads ${sv.solidity}[index]: ${sv.value.sp}; aborts "INDEX_OUT_OF_BOUNDS" when index >= length. Length: \`self.data.${sv.name}_len\` (a nat, read only). Write an element with \`self.data.${sv.name}[index] = value\` (after bounds are known)` });
      out.push({ name: `push_${sv.name}`, sig: `self.push_${sv.name}(value)`, doc: `${sv.solidity}.push(value)` });
      out.push({ name: `pop_${sv.name}`, sig: `self.pop_${sv.name}()`, doc: `${sv.solidity}.pop(); aborts "EMPTY_ARRAY" when empty` });
    }
  }
  out.push({ name: 'now_secs', sig: 'self.now_secs()', doc: 'block.timestamp as a nat (seconds since 1970)' });
  if (o.native) {
    out.push({ name: 'msg_value', sig: 'self.msg_value()', doc: 'msg.value: the attached amount in mutez as a nat (treated like wei, no rescaling)' });
    out.push({ name: 'send_native', sig: 'self.send_native(sp.record(to=<address>, amount=<nat>))', doc: 'sends `amount` mutez to `to` (queued; runs after the entrypoint returns)' });
    out.push({ name: 'native_balance', sig: 'self.native_balance()', doc: 'address(this).balance as a nat of mutez (includes the amount attached to the current call)' });
  }
  if (o.tokens.length) {
    out.push({ name: 'erc20_transfer', sig: 'self.erc20_transfer(sp.record(token=<address>, to=<address>, amount=<nat>))', doc: 'token.transfer(to, amount): FA1.2 transfer from this contract (queued)' });
    out.push({ name: 'erc20_transfer_from', sig: 'self.erc20_transfer_from(sp.record(token=<address>, from_=<address>, to=<address>, amount=<nat>))', doc: 'token.transferFrom(from_, to, amount): FA1.2 transfer where this contract spends the allowance the owner granted it (queued)' });
    out.push({ name: 'erc20_approve', sig: 'self.erc20_approve(sp.record(token=<address>, spender=<address>, amount=<nat>))', doc: 'token.approve(spender, amount) from this contract (queued)' });
  }
  return out;
}
