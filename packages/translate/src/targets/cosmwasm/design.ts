import { nullRecord } from '../../own.js';
import { untranslatable } from '../../spec/standard.js';
import { initialPlans, unresolvedInitials } from '../../spec/initial.js';
import type { ContractSpec, FunctionSpec, TypeRef } from '../../types.js';
import type { ArgD, CwDesign, HandlerD, KeyD, ObservableD, ReturnD, StateVarD, StructD, TokenDepD } from './design-types.js';
import { defaultExpr, pascal, snake, typeMap, type TypeMap } from './names.js';

export interface DesignOptions { originalDecimals?: number }

const isPublic = (f: FunctionSpec) => f.visibility === 'public' || f.visibility === 'external';

function keyOf(t: TypeRef): KeyD | null {
  switch (t.kind) {
    case 'address': case 'contract': return { t: typeMap(t), rust: '&Addr' };
    case 'uint': return { t: typeMap(t, { keyed: true }), rust: 'u64' };
    case 'string': return { t: typeMap(t), rust: '&str' };
    default: return null;
  }
}

/** Rust type a single returned value has in a handler (addresses leave as String). */
export const retRust = (m: TypeMap): string => (m.kind === 'address' ? 'String' : m.handler);

/** Conversion applied by the dispatch to a single returned value so the JSON has the wire type. */
export const wireWrap = (m: TypeMap, expr: string): string => {
  if (m.kind === 'uint' && m.handler === 'u64') return `Uint64::from(${expr})`;
  if (m.kind === 'int' && m.handler === 'i64') return `Int64::from(${expr})`;
  return expr;
};

const toStr = (m: TypeMap) => (m.kind === 'address' ? '.to_string()' : '');

export function buildDesign(spec: ContractSpec, opts: DesignOptions = {}): CwDesign {
  const origDec = opts.originalDecimals ?? 18;
  const notTranslated: CwDesign['notTranslated'] = [];
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
  const constants: CwDesign['constants'] = [];
  for (const sv of spec.stateVars) {
    if (sv.constant) { constants.push({ name: snake(sv.name), solidity: sv.name, value: sv.initialValue ?? null }); continue; }
    const base = { solidity: sv.name, name: snake(sv.name), public: sv.visibility === 'public', immutable: sv.immutable };
    const bail = (why: string): void => { state.push({ ...base, kind: 'item', value: { kind: 'unsupported', handler: '()', msg: '()' }, keys: [], zero: 'Default::default()', unsupported: why }); nt('unsupported state variable type', sv.name, why); };
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
      kind = 'array'; fixedLen = t.length; keys.push({ t: typeMap({ solidity: 'uint256', kind: 'uint', bits: 256 }, { keyed: true }), rust: 'u64' }); t = t.element!;
    }
    const sname = structOf(t);
    if (t.kind === 'struct' && !sname) { bail(`struct ${t.name} has unsupported fields`); continue; }
    const value = typeMap(t);
    if (value.kind === 'unsupported' || (value.kind === 'array' && kind !== 'item')) { bail(value.why ?? `type ${t.solidity}`); continue; }
    state.push({ ...base, kind, value, ...(sname ? { struct: sname } : {}), keys, ...(fixedLen ? { fixedLen } : {}), zero: defaultExpr(value, sname) });
  }
  const stateByName = new Map(state.map((s) => [s.solidity, s]));

  // ------------------------------------------------------------ token dependencies
  const tokens: TokenDepD[] = spec.tokenDependencies.map((t) => ({ solidity: t.name.replace(/^_/, ''), stateName: state.some((s) => s.solidity === t.name) ? snake(t.name) : null, methods: t.methods }));

  // ------------------------------------------------------------ handlers
  const handlers: HandlerD[] = [];
  const sendsNative = (fn: FunctionSpec) => fn.externalCalls.some((e) => e.low && e.sendsValue);
  const allFns = [...(spec.constructor ? [spec.constructor] : []), ...spec.functions.filter((f) => f.kind === 'receive' || (f.kind === 'function' && isPublic(f)))];
  const nativeUsed = allFns.some((f) => f.payable || sendsNative(f)) || spec.functions.some((f) => sendsNative(f));

  const keyedParams = (fn: FunctionSpec): Set<string> => {
    const out = new Set<string>();
    for (const m of fn.mappingAccesses) {
      const sv = stateByName.get(m.variable);
      if (!sv || sv.unsupported) continue;
      for (const k of m.keys) if (k.kind === 'param') out.add(k.name);
    }
    return out;
  };
  const argsOf = (fn: FunctionSpec, label: string): ArgD[] | null => {
    const keyed = keyedParams(fn);
    const out: ArgD[] = [];
    for (const [i, p] of fn.params.entries()) {
      const isKey = p.type.kind === 'uint' && keyed.has(p.name);
      const t = typeMap(p.type, { keyed: isKey });
      if (t.kind === 'unsupported' || t.kind === 'struct') { nt('unsupported parameter type', label, `${label}: parameter ${p.name} has type ${p.type.solidity}`); return null; }
      out.push({ name: snake(p.name), solidity: p.type.solidity, t, src: i, ...(isKey ? { note: 'uint used as a mapping key / array index: narrowed to u64' } : {}), ...(t.kind === 'array' && t.fixed ? { note: `fixed array of ${t.fixed}: the length is checked by the dispatch` } : {}) });
    }
    return out;
  };
  const reqs = (fn: FunctionSpec) => fn.requires.map((r) => `${r.kind}(${r.condition})${r.message ? ` "${r.message}"` : ''}${r.fromModifier ? ` [from modifier ${r.fromModifier}]` : ''}`);
  const fnNotes = (fn: FunctionSpec): string[] => {
    const n: string[] = [];
    if (fn.usesTimestamp) n.push('uses block.timestamp: `now(&env)` gives it as Uint256 (seconds)');
    for (const e of fn.externalCalls) {
      if (e.low && e.sendsValue) n.push(`${e.target}.call{value: ..}(data): only the value transfer is translated, as \`bank_send\`; the calldata is not executed (CosmWasm has no arbitrary calldata call)`);
      else if (e.low) n.push(`low-level call ${e.target}.${e.method}(...) is not translated`);
    }
    for (const m of fn.mappingAccesses) { const sv = stateByName.get(m.variable); if (sv?.unsupported) n.push(`${m.variable} is not available in the generated state (${sv.unsupported})`); }
    return n;
  };

  // constructor -> instantiate
  const ctor = spec.constructor;
  {
    const args = ctor ? argsOf(ctor, 'constructor') ?? [] : [];
    if (nativeUsed) args.push({ name: 'native_denom', solidity: 'native coin denom', t: typeMap({ solidity: 'string', kind: 'string' }), src: -1, note: 'the native coin the contract accepts/sends (msg.value); stored by the generated instantiate wrapper before your body runs' });
    handlers.push({ unit: 'instantiate', kind: 'instantiate', variant: '', solidity: 'constructor', args, payable: !!ctor?.payable, emits: ctor?.events ?? [], requires: ctor ? reqs(ctor) : [], writes: ctor?.writes ?? [], notes: ctor ? fnNotes(ctor) : [] });
  }

  const variants = new Set<string>();
  const uniqVariant = (v: string, prefix: string) => { let x = v; while (variants.has(prefix + x)) x += '2'; variants.add(prefix + x); return x; };

  const mkReturns = (fn: FunctionSpec, variant: string): ReturnD | undefined | null => {
    if (!fn.returns.length) return undefined;
    const fields = fn.returns.map((r, i) => ({ name: r.name ? snake(r.name) : `field${i}`, solidity: r.type.solidity, t: typeMap(r.type) }));
    if (fields.some((f) => f.t.kind === 'unsupported' || f.t.kind === 'struct')) return null;
    if (fields.length === 1) return { single: true, rust: retRust(fields[0]!.t), t: fields[0]!.t, fields };
    return { single: false, rust: `${variant}Response`, struct: `${variant}Response`, fields };
  };

  for (const f of spec.functions) {
    { const u = untranslatable(f); if (u && isPublic(f)) { nt(u.feature, f.name, u.reason); continue; } }
    if (f.kind === 'fallback') { nt('fallback function', 'fallback', 'CosmWasm has no fallback entry point; unknown messages are rejected'); continue; }
    if (f.kind === 'receive') {
      const variant = uniqVariant('Deposit', 'e');
      handlers.push({ unit: 'exec_deposit', kind: 'execute', variant, solidity: 'receive', args: [], payable: true, emits: f.events, requires: reqs(f), writes: f.writes, notes: ['receive(): native deposits become the explicit `Deposit {}` message that is sent with funds; read the amount with `sent_value`', ...fnNotes(f)] });
      continue;
    }
    if (f.kind !== 'function' || !isPublic(f)) continue;
    const isView = f.mutability === 'view' || f.mutability === 'pure';
    const variant = uniqVariant(pascal(f.name), isView ? 'q' : 'e');
    const args = argsOf(f, f.name);
    if (!args) continue;
    if (isView) {
      const ret = mkReturns(f, variant);
      if (ret === null) { nt('unsupported return type', f.name, 'a returned value has a type that is not mapped'); continue; }
      if (!ret) { nt('view without return value', f.name, 'nothing to expose'); continue; }
      const h: HandlerD = { unit: `query_${snake(f.name)}`, kind: 'query', variant, solidity: f.name, args, payable: false, returns: ret, emits: [], requires: reqs(f), writes: [], notes: fnNotes(f) };
      const m = f.returnExpr ? /^(\w+)\.length$/.exec(f.returnExpr) : null;
      const arr = m ? stateByName.get(m[1]!) : undefined;
      if (arr && arr.kind === 'array' && !arr.unsupported && ret.single && ret.t?.handler === 'Uint256') h.generated = { why: `length of ${arr.solidity}`, body: `    Ok(Uint256::from(len_${arr.name}(deps.storage)?))` };
      handlers.push(h);
    } else {
      handlers.push({ unit: `exec_${snake(f.name)}`, kind: 'execute', variant, solidity: f.name, args, payable: f.payable, emits: f.events, requires: reqs(f), writes: f.writes, notes: fnNotes(f) });
    }
  }

  // public getters of state variables and constants: written by code
  const hasFn = (name: string) => spec.functions.some((f) => f.name === name && f.kind === 'function' && isPublic(f));
  for (const sv of state) {
    if (!sv.public || sv.unsupported || hasFn(sv.solidity) || sv.struct) continue;
    const variant = uniqVariant(pascal(sv.solidity), 'q');
    const args: ArgD[] = sv.keys.map((k, i) => ({ name: i === 0 ? 'key' : `key${i + 1}`, solidity: k.t.kind === 'address' ? 'address' : 'uint256', t: k.t, src: i }));
    const call = args.map((a) => (a.t.kind === 'address' ? `&${a.name}` : a.name)).join(', ');
    const rt = sv.value;
    const body = sv.kind === 'item' ? `get_${sv.name}(deps.storage)` : `get_${sv.name}(deps.storage, ${call})`;
    handlers.push({ unit: `query_${sv.name}`, kind: 'query', variant, solidity: sv.solidity, args, payable: false, returns: { single: true, rust: retRust(rt), t: rt, fields: [{ name: 'value', solidity: rt.handler, t: rt }] }, generated: { why: `public state variable ${sv.solidity}`, body: `    Ok(${body}?${toStr(rt)})` }, emits: [], requires: [], writes: [], notes: [] });
  }
  for (const c of constants) {
    const sv = spec.stateVars.find((s) => s.name === c.solidity)!;
    if (sv.visibility !== 'public' || hasFn(sv.name)) continue;
    const m = typeMap(sv.type);
    const lit = c.value?.trim();
    let body: string | null = null;
    if (lit && /^\d+$/.test(lit) && m.kind === 'uint') body = m.handler === 'Uint256' || m.handler === 'Uint128' ? `${m.handler}::from(${lit}u128)` : lit;
    else if (lit === 'true' || lit === 'false') body = lit;
    if (!body) { nt('public constant with a computed value', sv.name, `\`${lit ?? '?'}\` is not a plain literal: not exposed as a query (inline it where used)`); continue; }
    handlers.push({ unit: `query_${c.name}`, kind: 'query', variant: uniqVariant(pascal(sv.name), 'q'), solidity: sv.name, args: [], payable: false, returns: { single: true, rust: retRust(m), t: m, fields: [{ name: 'value', solidity: sv.type.solidity, t: m }] }, generated: { why: `public constant ${sv.name}`, body: `    Ok(${body})` }, emits: [], requires: [], writes: [], notes: [] });
  }

  // ------------------------------------------------------------ observables
  const observables: Record<string, ObservableD> = nullRecord<ObservableD>();
  for (const h of handlers) if (h.kind === 'query') observables[h.solidity] = { kind: 'query', unit: h.unit };
  for (const sv of state) if (sv.public && !observables[sv.solidity]) observables[sv.solidity] = { kind: 'unobservable', reason: sv.unsupported ?? (sv.struct ? 'public getter of a struct-valued variable returns a tuple: not generated' : 'no query generated') };
  for (const c of constants) if (!observables[c.solidity]) observables[c.solidity] = { kind: 'unobservable', reason: 'constant is inlined, not stored' };
  observables['tokenBalance'] = { kind: 'token-balance' };

  // ------------------------------------------------------------ non-portable features, CosmWasm wording
  for (const nf of spec.nonPortable) {
    const where = nf.where.join(', ');
    switch (nf.id) {
      case 'delegatecall': nt('delegatecall', where, 'CosmWasm has no delegatecall; code reuse is by calling another contract, which changes the storage semantics'); break;
      case 'assembly': nt('inline assembly', where, 'no equivalent; must be re-expressed by hand'); break;
      case 'selfdestruct': nt('selfdestruct', where, 'no equivalent; contracts can be migrated or cleared, not destroyed'); break;
      case 'tx.origin': nt('tx.origin', where, 'CosmWasm has no tx.origin; only info.sender (the direct caller)'); break;
      case 'block.coinbase': case 'block.prevrandao': case 'block.difficulty': case 'block.gaslimit': case 'block-context': nt(nf.title, where, 'not available to contracts'); break;
      case 'signatures': nt('ecrecover / signature verification', where, 'secp256k1 verification exists as deps.api.secp256k1_verify, but the EVM message hashing/recovery scheme must be redesigned (Cosmos addresses are not Ethereum addresses)'); break;
      case 'contract-creation': nt('contract creation (new)', where, 'a contract can instantiate another by a WasmMsg::Instantiate for a stored code id; not generated'); break;
      case 'msg.data': nt('msg.data', where, 'raw calldata does not exist'); break;
      case 'low-level-call': {
        const sendOnly = spec.functions.concat(spec.constructor ? [spec.constructor] : []).filter((f) => nf.where.includes(f.name)).every((f) => f.externalCalls.every((e) => !e.low || e.sendsValue));
        if (sendOnly) notes.push(`Low-level \`call{value}(data)\` in ${where}: the value transfer becomes BankMsg::Send; the calldata is dropped (documented difference: a Solidity multisig that executes arbitrary data can only send native coin here).`);
        else nt('low-level call with arbitrary data', where, 'arbitrary calldata to arbitrary targets has no form in CosmWasm without an explicit WasmMsg');
        break;
      }
      case 'block.number': notes.push(`block.number is used in ${where}: env.block.height is the closest value; block times and heights differ from Ethereum.`); break;
      case 'block.chainid': notes.push(`block.chainid is used in ${where}: env.block.chain_id is a string.`); break;
      case 'abi-encoding': notes.push(`abi.encode / keccak hashing in ${where}: encodings differ; hashes that must equal EVM hashes cannot be reproduced.`); break;
      case 'upgradeability': notes.push('Upgradeability: CosmWasm contracts are migrated by the admin with a `migrate` entry point (not generated); proxy patterns are not translated.'); break;
      case 'reentrancy-guard': notes.push(`Reentrancy guard in ${where}: not needed for CosmWasm's message model (replies run after the handler), but update state before returning messages.`); break;
      default: break;
    }
  }

  const tokenStd = spec.tokenStandards.length ? `The contract implements ${spec.tokenStandards.join(', ')} itself: it is rewritten as custom code, so it is NOT a cw20/cw721 token other contracts can rely on (use the template path for a plain token).` : null;
  if (tokenStd) notes.push(tokenStd);
  if (tokens.length) notes.push('ERC-20 tokens the contract calls are cw20 contracts. The Solidity pull `transferFrom(msg.sender, this, amount)` is kept as `Cw20ExecuteMsg::TransferFrom{owner: caller}`: the caller grants an allowance to this contract on the cw20 first (`increase_allowance`), as with ERC-20 approve. The alternative idiom, the cw20 `Send` + `Receive(Cw20ReceiveMsg)` hook, is NOT used: it changes entry points (one `Receive` message that must check the cw20 contract is the expected token) and the call signature; it is the usual recommendation on Cosmos chains, so this is a documented difference. `transfer(to, amount)` becomes `Cw20ExecuteMsg::Transfer`. Messages are dispatched after the handler returns, so state must be updated before they are built and a token balance read inside the handler does not yet include them.');
  if (nativeUsed) notes.push('Native value: the contract is configured with one native denom at instantiate (`native_denom`). `msg.value` is the amount of that denom in `info.funds` (any other coin is rejected); sending value is `BankMsg::Send`. Non-payable messages reject attached funds.');
  notes.push('Addresses are bech32 `Addr` validated with `deps.api.addr_validate`; the Solidity zero address is represented by the empty string (`zero_addr()`), which is not a valid message argument: a message that passes `address(0)` is rejected before the handler runs (documented difference).');
  notes.push('Storage: every Solidity state variable is a cw-storage-plus `Item`/`Map`; a missing entry reads as the Solidity default (zero/false/zero address) through generated accessors, never as an error. Dynamic arrays are a `Map<u64, T>` plus a length item; uint256 mapping keys and array indexes are narrowed to u64.');
  notes.push('State-changing functions return no value (the Response carries events/attributes only); Solidity return values of those functions are dropped.');
  if (spec.stateVars.some((v) => v.type.kind === 'enum')) notes.push('Enums are stored as u8.');

  // ------------------------------------------------------------ inline initialisers (evaluated by code, applied by generated code)
  const initials: NonNullable<CwDesign['initials']> = [];
  const initH = handlers.find((h) => h.kind === 'instantiate');
  for (const pl of initialPlans(spec)) {
    if (pl.zero) continue;
    const sd = stateByName.get(pl.sv.name);
    if (!sd || sd.kind !== 'item' || sd.unsupported) { notes.push(`initialiser of \`${pl.sv.name}\` (= ${pl.sv.initialValue}) has no storage item to receive it: set it in instantiate`); continue; }
    const h = sd.value.handler; let expr: string | null = null;
    if (pl.value.kind === 'bool') expr = pl.value.value;
    else if (pl.value.kind === 'string') expr = JSON.stringify(pl.value.value) + '.to_string()';
    else if (pl.value.kind === 'uint' || pl.value.kind === 'int') expr = /^(Uint|Int)\d+$/.test(h) ? `<${h} as std::str::FromStr>::from_str("${pl.value.value}").unwrap()` : /^[ui]\d+$/.test(h) ? `${pl.value.value}${h}` : null;
    if (expr === null) { notes.push(`initialiser of \`${pl.sv.name}\` (= ${pl.sv.initialValue}) has an unsupported type for code application: set it in instantiate`); continue; }
    initials.push({ name: sd.name, solidity: pl.sv.name, rustExpr: expr, shown: `${pl.sv.initialValue} = ${pl.value.value}` });
  }
  for (const nm of spec.constructor?.senderAssignments ?? []) {
    const sd = stateByName.get(nm);
    if (sd && sd.kind === 'item' && !sd.unsupported && sd.value.kind === 'address' && !initials.some((i) => i.solidity === nm)) initials.push({ name: sd.name, solidity: nm, rustExpr: 'info.sender.clone()', shown: 'msg.sender (the instantiating account)' });
  }
  if (initH) {
    if (initials.length) initH.notes.push(`already applied by generated code before your body (do NOT set them again): ${initials.map((i) => `${i.solidity} (${i.shown})`).join(', ')}`);
    for (const sv of unresolvedInitials(spec)) initH.notes.push(`state variable ${sv.name} has the initialiser \`${sv.initialValue}\` that code could not evaluate: set it in instantiate`);
  }

  return {
    version: 1, mode: 'program', programName: 'app', decimals: { original: origDec, target: origDec, divisor: '1' },
    integerPolicy: [
      'uint8/16/32 keep their width (u8/u16/u32). uint33..64 are u64 in code and `Uint64` (decimal string) in messages. uint65..128 are `Uint128`, uint129..256 are `Uint256`. int types use i8/i16/i32/i64, Int128, Int256 the same way.',
      'Checked arithmetic everywhere: Uint256/Uint128 `checked_add/sub/mul/div/pow` return Result (`?` converts the error to ContractError); u8..u64 use `checked_*().ok_or_else(ovf)?`. An overflow fails the message like the Solidity 0.8 panic.',
      'cw20 amounts are Uint128 on the wire: helpers convert from Uint256 and fail when the value does not fit. The token keeps its own decimals; no rescaling.',
      'block.timestamp is `now(&env)`: env.block.time.seconds() as Uint256.',
    ],
    native: { used: nativeUsed }, state, structs, tokens, instructions: handlers, observables, notTranslated, notes, constants, initials,
  };
}
