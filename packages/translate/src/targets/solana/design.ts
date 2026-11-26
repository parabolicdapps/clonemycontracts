import { nullRecord } from '../../own.js';
import { initialPlans, unresolvedInitials } from '../../spec/initial.js';
import { erc20Delegation, untranslatable } from '../../spec/standard.js';
import type { ContractSpec, FunctionSpec, KeySource, ParamSpec, StateVarSpec, TypeRef } from '../../types.js';
import type {
  AccountRole, ArgDesign, FieldDesign, InstructionDesign, KeyRef, ObservableDesign, Scale, SolanaDesign, StateAccountDesign, TokenDesign,
} from './design-types.js';

const RESERVED = new Set(['as', 'break', 'const', 'continue', 'crate', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while', 'async', 'await', 'dyn', 'abstract', 'become', 'box', 'do', 'final', 'macro', 'override', 'priv', 'typeof', 'unsized', 'virtual', 'yield', 'try']);
export const snake = (s: string): string => { const r = s.replace(/^_+/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase(); return RESERVED.has(r) ? `${r}_` : r; };
export const pascal = (s: string): string => snake(s).split('_').filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');

export function rustType(t: TypeRef): string {
  switch (t.kind) {
    case 'uint': { const b = t.bits ?? 256; return b <= 8 ? 'u8' : b <= 16 ? 'u16' : b <= 32 ? 'u32' : b <= 64 ? 'u64' : 'u128'; }
    case 'int': { const b = t.bits ?? 256; return b <= 8 ? 'i8' : b <= 16 ? 'i16' : b <= 32 ? 'i32' : b <= 64 ? 'i64' : 'i128'; }
    case 'bool': return 'bool';
    case 'address': case 'contract': return 'Pubkey';
    case 'string': return 'String';
    case 'bytes': return 'Vec<u8>';
    case 'fixedbytes': return `[u8; ${(t.bits ?? 8) / 8}]`;
    case 'enum': return 'u8';
    case 'array': return t.length ? `[${rustType(t.element!)}; ${t.length}]` : `Vec<${rustType(t.element!)}>`;
    default: return 'u128';
  }
}

const AMOUNT_RE = /amount|balance|staked|stake|reward|^supply|totalSupply|allocation|released|releasable|total|earned|paid|value|vest|refund|price|cost|fee/i;
const NOT_AMOUNT_RE = /time|period|finish|update|duration|count|index|id$|confirmations|start|cliff|end|bps|perToken|^ratio/i;

export function scaleOfName(name: string, type: TypeRef): Scale {
  if (type.kind !== 'uint') return 'plain';
  if (NO_SCALE.value) return 'plain';
  if (/^(balance|balances|balanceOf|_balances)$/i.test(name) && NFT_CONTEXT.value) return 'plain';
  if (/PerToken|perToken|^ratio|Ratio$/.test(name)) return 'ratio';
  if (NOT_AMOUNT_RE.test(name) && !/^(total|released|staked)/i.test(name)) return 'plain';
  return AMOUNT_RE.test(name) ? 'token' : 'plain';
}

function flattenMapping(t: TypeRef): { keys: TypeRef[]; value: TypeRef } {
  const keys: TypeRef[] = [];
  let cur = t;
  while (cur.kind === 'mapping') { keys.push(cur.key!); cur = cur.value!; }
  return { keys, value: cur };
}

const keyRust = (t: TypeRef): 'Pubkey' | 'u64' => (t.kind === 'address' || t.kind === 'contract' ? 'Pubkey' : 'u64');

const NFT_CONTEXT = { value: false };
/** a custom ERC-20 kept as program state (not an SPL mint): its amounts are NOT rescaled to SPL units */
const NO_SCALE = { value: false };

/** A PDA seed may never read a field of an account that is created by the same instruction (`init`): the field does not exist yet. */
export function selfReferentialSeeds(d: Pick<SolanaDesign, 'instructions'>): string[] {
  const out: string[] = [];
  for (const ins of d.instructions) {
    if (!ins.accounts.some((r) => r.init && r.kind === 'config')) continue;
    for (const r of ins.accounts) for (const k of r.keys ?? []) if (k.kind === 'config') out.push(`${ins.name}: account ${r.name} derives a PDA seed from config.${k.field}, but config is created by the same instruction`);
  }
  return out;
}

export interface DesignOptions { solanaDecimals?: number; originalDecimals?: number }

export function buildDesign(spec: ContractSpec, opts: DesignOptions = {}): SolanaDesign {
  NFT_CONTEXT.value = spec.tokenStandards.includes('ERC-721');
  { const dg = erc20Delegation(spec); NO_SCALE.value = spec.tokenStandards.includes('ERC-20') && (dg.custom || dg.reasons.size > 0) && spec.tokenDependencies.length === 0; }
  const solDec = opts.solanaDecimals ?? 9;
  const origDec = opts.originalDecimals ?? 18;
  const notTranslated: SolanaDesign['notTranslated'] = [];
  const notes: string[] = [];
  const integerPolicy = [
    'uint256/int256 values are stored as u128/i128; uint64-or-narrower keep their width. Checked arithmetic everywhere; an operation that would exceed the width fails with an overflow error.',
    `Token amounts are SPL base units (u64 on the wire, u128 in intermediate arithmetic). The original's 18-decimal amounts correspond to ${solDec}-decimal SPL units (divide by 10^${origDec - solDec}).`,
    'block.timestamp becomes Clock::get()?.unix_timestamp (i64, cast to u128/u64 with a non-negative check).',
  ];

  // ---------- tokens
  const tokens: TokenDesign[] = spec.tokenDependencies.map((t) => {
    const raw = t.name.replace(/^_/, '');
    const k = snake(raw).replace(/_?token$/, '') || 'token';
    return { solidity: raw, key: k, mintAccount: `${k}_mint`, mintField: `${k}_mint`, vault: `${k}_vault`, methods: t.methods };
  });
  const tokenByVar = (target: string) => tokens.find((t) => t.solidity === target.replace(/^_/, ''));
  const ctorMap = new Map((spec.constructor?.paramAssignments ?? []).map((a) => [a.param, a.stateVar]));
  /** constructor/function parameter that carries a token dependency (directly, or assigned to a token state variable) */
  const tokenOfParam = (pname: string) => tokenByVar(pname) ?? (ctorMap.has(pname) ? tokenByVar(ctorMap.get(pname)!) : undefined);

  // ---------- derived mappings (owner sets)
  const derivedMappings: SolanaDesign['derivedMappings'] = [];
  const ctorWrites = new Set(spec.constructor?.writes ?? []);
  const writtenElsewhere = new Set(spec.functions.flatMap((f) => f.writes));
  for (const sv of spec.stateVars) {
    if (sv.type.kind !== 'mapping' || sv.type.key?.kind !== 'address' || sv.type.value?.kind !== 'bool') continue;
    if (!ctorWrites.has(sv.name) || writtenElsewhere.has(sv.name)) continue;
    const arr = spec.stateVars.find((a) => a.type.kind === 'array' && a.type.length && a.type.element?.kind === 'address' && ctorWrites.has(a.name));
    if (arr) derivedMappings.push({ mapping: sv.name, arrayField: snake(arr.name) });
  }
  const derived = new Set(derivedMappings.map((d) => d.mapping));

  // ---------- reentrancy guards: Solana has no reentrancy through CPI (only self recursion), so the guard variable is not stored and the modifier is not translated
  const guardVars = new Set<string>();
  if (spec.functions.some((f) => f.modifiers.some((m) => /nonReentrant/i.test(m)))) {
    for (const sv of spec.stateVars) if (!sv.constant && ['uint', 'bool'].includes(sv.type.kind) && /^_?(status|locked|unlocked|notEntered|entered|reentrancy\w*|guard\w*)$/i.test(sv.name) && spec.functions.some((f) => f.modifiers.some((m) => /nonReentrant/i.test(m)) && f.writes.includes(sv.name))) guardVars.add(sv.name);
    if (guardVars.size) notes.push(`Reentrancy guard (modifier nonReentrant, variable ${[...guardVars].join(', ')}): NOT translated and not stored. Solana programs cannot be re-entered through CPI (only by self recursion), so there is no counter to update; keep the order "update state, then CPI" instead.`);
  }

  // ---------- config + entry accounts
  const configFields: FieldDesign[] = [];
  const entryGroups = new Map<string, { sv: StateVarSpec; keys: TypeRef[]; value: TypeRef }[]>();
  const arrays: StateVarSpec[] = [];
  for (const sv of spec.stateVars) {
    if (sv.constant || guardVars.has(sv.name)) continue;
    if (sv.type.kind === 'mapping') {
      if (derived.has(sv.name)) continue;
      const fm = flattenMapping(sv.type);
      const sig = fm.keys.map((k) => keyRust(k)).join(',');
      if (!entryGroups.has(sig)) entryGroups.set(sig, []);
      entryGroups.get(sig)!.push({ sv, keys: fm.keys, value: fm.value });
    } else if (sv.type.kind === 'array' && !sv.type.length) {
      arrays.push(sv);
    } else if (sv.type.kind === 'contract') {
      const tk = tokenByVar(sv.name);
      if (tk) configFields.push({ name: tk.mintField, rust: 'Pubkey', solidity: sv.type.solidity, source: sv.name, scale: 'plain', note: 'SPL mint address of this token' });
      else configFields.push({ name: snake(sv.name), rust: 'Pubkey', solidity: sv.type.solidity, source: sv.name, scale: 'plain' });
    } else if (sv.type.kind === 'string') {
      configFields.push({ name: snake(sv.name), rust: 'String', solidity: 'string', source: sv.name, scale: 'plain', note: 'bounded to 64 bytes (#[max_len(64)])' });
    } else {
      configFields.push({ name: snake(sv.name), rust: rustType(sv.type), solidity: sv.type.solidity, source: sv.name, scale: scaleOfName(sv.name, sv.type) });
    }
  }
  // token deps that are only constructor parameters
  for (const tk of tokens) if (!configFields.some((f) => f.name === tk.mintField)) configFields.push({ name: tk.mintField, rust: 'Pubkey', solidity: 'contract', source: tk.solidity, scale: 'plain', note: 'SPL mint address of this token (constructor parameter)' });
  for (const a of arrays) configFields.push({ name: `${snake(a.name)}_len`, rust: 'u64', solidity: 'uint256', source: `${a.name}.length`, scale: 'plain', note: `length of the Solidity array ${a.name}` });
  configFields.push({ name: 'bump', rust: 'u8', solidity: '-', source: '-', scale: 'plain', note: 'PDA bump' });
  const accounts: StateAccountDesign[] = [{ name: 'Config', role: 'config', sources: [], seedPrefix: 'config', keys: [], fields: configFields, defaultsToZero: false }];

  const groupName = new Map<string, string>(); // mapping var -> account name
  const groupOf = new Map<string, StateAccountDesign>();
  for (const [sig, members] of entryGroups) {
    const name = members.length === 1 ? pascal(members[0]!.sv.name) : sig.startsWith('Pubkey') ? 'User' : 'Entry';
    const fields: FieldDesign[] = [];
    for (const m of members) {
      if (m.value.kind === 'struct') {
        const st = spec.structs.find((s) => s.name === m.value.name);
        for (const f of st?.fields ?? []) fields.push({ name: snake(f.name), rust: rustType(f.type), solidity: f.type.solidity, source: `${m.sv.name}.${f.name}`, scale: scaleOfName(f.name, f.type) });
      } else fields.push({ name: snake(m.sv.name), rust: rustType(m.value), solidity: m.value.solidity, source: m.sv.name, scale: scaleOfName(m.sv.name, m.value) });
    }
    fields.push({ name: 'bump', rust: 'u8', solidity: '-', source: '-', scale: 'plain', note: 'PDA bump' });
    const first = members[0]!;
    const acc: StateAccountDesign = {
      name, role: 'entry', sources: members.map((m) => m.sv.name), seedPrefix: snake(name), fields, defaultsToZero: true,
      keys: first.keys.map((k, i) => ({ name: i === 0 ? 'key' : `key${i + 1}`, rust: keyRust(k), solidity: k.solidity })),
    };
    accounts.push(acc);
    for (const m of members) { groupName.set(m.sv.name, name); groupOf.set(m.sv.name, acc); }
    if (members.some((m) => m.keys.some((k) => k.kind === 'uint' && (k.bits ?? 256) > 64))) notes.push(`${name}: uint256 mapping keys are narrowed to u64 PDA seeds.`);
  }
  for (const a of arrays) {
    const el = a.type.element!;
    const fields: FieldDesign[] = [];
    if (el.kind === 'struct') {
      const st = spec.structs.find((s) => s.name === el.name);
      for (const f of st?.fields ?? []) fields.push({ name: snake(f.name), rust: rustType(f.type), solidity: f.type.solidity, source: `${a.name}[].${f.name}`, scale: scaleOfName(f.name, f.type) });
    } else fields.push({ name: 'value', rust: rustType(el), solidity: el.solidity, source: `${a.name}[]`, scale: scaleOfName(a.name, el) });
    fields.push({ name: 'bump', rust: 'u8', solidity: '-', source: '-', scale: 'plain', note: 'PDA bump' });
    const acc: StateAccountDesign = { name: `${pascal(a.name)}Item`, role: 'item', sources: [a.name], seedPrefix: `${snake(a.name)}_item`, fields, defaultsToZero: false, keys: [{ name: 'index', rust: 'u64', solidity: 'uint256' }] };
    accounts.push(acc);
    groupName.set(a.name, acc.name); groupOf.set(a.name, acc);
  }

  // state account names must not collide with event / error / instruction type names
  const taken = new Set([...spec.events.map((e) => e.name), ...spec.errors.map((e) => e.name), 'Config']);
  for (const a of accounts) if (a.role !== 'config' && taken.has(a.name)) { const old = a.name; a.name = `${a.name}State`; for (const m of [...groupName.entries()]) if (m[1] === old) groupName.set(m[0], a.name); }
  // ---------- instructions
  const isPublic = (f: FunctionSpec) => f.visibility === 'public' || f.visibility === 'external';
  const instructions: InstructionDesign[] = [];
  const tokenStd = spec.tokenStandards.includes('ERC-20');

  const keyFromSource = (ks: KeySource, fn: FunctionSpec, pushArr: StateVarSpec | undefined): KeyRef | null => {
    if (ks.kind === 'msg.sender') return { kind: 'caller' };
    if (ks.kind === 'param') {
      const p = fn.params.find((x) => x.name === ks.name);
      return { kind: 'arg', name: snake(ks.name), rust: p ? (keyRust(p.type) === 'Pubkey' ? 'Pubkey' : 'u64') : 'u64' };
    }
    if (ks.kind === 'statevar') {
      if (fn.kind === 'constructor') {
        // the config account is being created by this very instruction: a seed may never read one of its fields. Resolve the variable to what
        // the constructor assigned it from: the signer (`owner = msg.sender`) or an argument (`owner = _owner`).
        if (fn.senderAssignments?.includes(ks.name)) return { kind: 'caller' };
        const pa = fn.paramAssignments?.find((a) => a.stateVar === ks.name);
        if (pa) { const p = fn.params.find((x) => x.name === pa.param); return { kind: 'arg', name: snake(pa.param), rust: p ? (keyRust(p.type) === 'Pubkey' ? 'Pubkey' : 'u64') : 'Pubkey' }; }
        return null;
      }
      return { kind: 'config', field: snake(ks.name), rust: 'Pubkey' };
    }
    if (ks.kind === 'expr' && pushArr && /^\w+$/.test(ks.text)) return { kind: 'config', field: `${snake(pushArr.name)}_len`, rust: 'u64' };
    return null;
  };
  const keyName = (k: KeyRef) => (k.kind === 'caller' ? 'caller' : k.kind === 'arg' ? k.name : k.field);

  const buildInstruction = (fn: FunctionSpec, kind: InstructionDesign['kind']): InstructionDesign => {
    const name = kind === 'initialize' ? 'initialize' : kind === 'receive' ? 'deposit' : snake(fn.name);
    const roles: AccountRole[] = [];
    const insNotes: string[] = [];
    const addRole = (r: AccountRole) => { const ex = roles.find((x) => x.name === r.name); if (ex) { ex.writable = ex.writable || r.writable; ex.init = ex.init ?? r.init; } else roles.push(r); };
    const pushArr = arrays.find((a) => fn.writes.includes(a.name) && fn.mappingAccesses.every((m) => m.variable !== a.name || m.keys.length === 0 || true));
    const isView = kind === 'view';
    const writesAny = fn.writes.length > 0 || kind === 'initialize';

    // args
    const args: ArgDesign[] = [];
    for (const [pi, p] of fn.params.entries()) {
      if (tokenOfParam(p.name)) continue; // becomes a mint account (also `address _token` that is cast to IERC20 in the constructor)
      const sc = p.type.kind === 'uint' ? scaleOfParam(p, fn) : 'plain';
      const isTime = p.type.kind === 'uint' && /start|time|deadline|expir|until|end$|cliff$/i.test(p.name) && !/seconds|duration|period/i.test(p.name);
      args.push({ name: snake(p.name), rust: rustType(p.type), solidity: p.type.solidity, src: pi, scale: isTime ? 'time' : sc, ...(p.type.kind === 'uint' && (p.type.bits ?? 0) > 64 ? { note: 'uint256 narrowed to u128' } : {}) });
    }
    if (fn.payable && kind !== 'initialize') args.push({ name: 'value', rust: 'u64', solidity: 'msg.value', src: -1, scale: 'token', note: 'lamports moved from the caller to the config PDA (system program transfer); replaces msg.value' });
    else if (fn.payable && kind === 'initialize') args.push({ name: 'value', rust: 'u64', solidity: 'msg.value', src: -1, scale: 'token', note: 'lamports sent with the deployment' });

    const needCaller = !isView || fn.mappingAccesses.some((m) => m.keys.some((k) => k.kind === 'msg.sender')) || fn.externalCalls.some((e) => e.args.some((a) => a.kind === 'msg.sender'));
    if (needCaller) addRole({ name: 'caller', kind: 'caller', writable: !isView, signer: true });
    addRole({ name: 'config', kind: 'config', writable: kind === 'initialize' || writesAny || fn.payable || fn.externalCalls.some((e) => e.low && e.sendsValue), state: 'Config', ...(kind === 'initialize' ? { init: 'init' as const } : {}) });

    // entries / array items
    for (const m of fn.mappingAccesses) {
      if (derived.has(m.variable)) { insNotes.push(`${m.variable}[...] is checked as membership in config.${derivedMappings.find((d) => d.mapping === m.variable)!.arrayField} (no account)`); continue; }
      const acc = groupOf.get(m.variable);
      if (!acc) continue;
      const keys: KeyRef[] = [];
      let skip = false;
      for (const ks of m.keys) {
        if (ks.kind === 'literal' || (ks.kind === 'expr' && /address\(0\)|^0$/.test(ks.text))) { skip = true; insNotes.push(`${m.variable}[address(0)] access is skipped (the zero-address entry has no meaning on Solana)`); break; }
        const k = keyFromSource(ks, fn, pushArr && acc.role === 'item' ? pushArr : pushArr);
        if (!k) { insNotes.push(`${m.variable}: key expression ${ks.kind === 'expr' ? `\`${ks.text}\`` : ks.kind} could not be resolved to an account; handle it by hand and keep the behaviour`); skip = true; break; }
        keys.push(k);
      }
      if (skip) continue;
      const nm = acc.role === 'item' ? `${snake(m.variable)}_item${roles.filter((r) => r.name.startsWith(`${snake(m.variable)}_item`) && JSON.stringify(r.keys) !== JSON.stringify(keys)).length ? '_' + (roles.length) : ''}` : `${snake(acc.name)}_${keys.map(keyName).join('_')}`;
      if (isView) { addRole({ name: nm, kind: 'entry', writable: false, state: acc.name, keys, ...(acc.role === 'entry' ? { optional: true } : {}) }); continue; }
      addRole({ name: nm, kind: 'entry', writable: m.write || !isView || acc.role === 'entry', state: acc.name, keys, ...(acc.role === 'item' && keys.some((k) => k.kind === 'config') ? { init: 'init' as const } : acc.role === 'entry' ? { init: 'init_if_needed' as const } : {}) });
    }
    for (const r of roles) for (const k of r.keys ?? []) if (k.kind === 'arg' && k.rust === 'u64') { const a = args.find((x) => x.name === k.name); if (a && a.rust !== 'u64' && /^u/.test(a.rust)) { a.rust = 'u64'; a.note = 'narrowed to u64 because it is a PDA seed'; } }
    if (!roles.some((r) => r.kind === 'caller') && roles.some((r) => r.init)) roles.unshift({ name: 'caller', kind: 'caller', writable: true, signer: true });
    // token interactions
    const roleOf = (ks: KeySource | undefined): { name: string; owner: KeySource } | null => {
      if (!ks) return null;
      if (ks.kind === 'this') return null;
      if (ks.kind === 'msg.sender') return { name: 'caller', owner: ks };
      if (ks.kind === 'param') return { name: snake(ks.name), owner: ks };
      if (ks.kind === 'statevar') return { name: snake(ks.name), owner: ks };
      return null;
    };
    const touched = new Set<string>();
    for (const e of fn.externalCalls) {
      if (e.low) continue;
      const tk = tokenByVar(e.target);
      if (!tk) continue;
      touched.add(tk.key);
      const ends: (KeySource | undefined)[] = /transferFrom/i.test(e.method) ? [e.args[0], e.args[1]] : /transfer/i.test(e.method) ? [e.args[0]] : [];
      for (const ks of ends) {
        const r = roleOf(ks);
        if (r) addRole({ name: `${r.name}_${tk.key}_ata`, kind: 'user_token', writable: true, token: tk.key, owner: r.owner });
      }
    }
    if (kind === 'initialize') for (const tk of tokens) touched.add(tk.key);
    for (const tk of tokens) {
      if (!touched.has(tk.key)) continue;
      addRole({ name: tk.mintAccount, kind: 'mint', writable: false, token: tk.key });
      addRole({ name: tk.vault, kind: 'vault', writable: true, token: tk.key, ...(kind === 'initialize' ? { init: 'init' as const } : {}) });
    }
    // native value out (low-level call with value / transfer / send)
    for (const e of fn.externalCalls) {
      if (!e.low || !e.sendsValue) continue;
      const tgt = e.target;
      const m = /\.(\w+)$/.exec(tgt);
      const holder = m ? accounts.find((a) => a.fields.some((f) => f.name === snake(m[1]!))) : undefined;
      if (tgt === 'msg.sender') { insNotes.push('pays out to msg.sender: use `ctx.accounts.caller.to_account_info()` as the destination of helpers::lamports_out (no extra account)'); continue; }
      const sameArg = m ? args.find((a) => a.name === snake(m[1]!) && a.rust === 'Pubkey') : undefined;
      if (sameArg) addRole({ name: 'recipient', kind: 'recipient', writable: true, from: { arg: sameArg.name }, note: `lamports are paid out of the config PDA to this account; its key must equal the \`${sameArg.name}\` argument/stored address (${tgt})` });
      else if (m && holder && holder.role !== 'config') {
        const key = roles.find((r) => r.kind === 'entry' && r.state === holder.name);
        addRole({ name: 'recipient', kind: 'recipient', writable: true, from: { state: holder.name, field: snake(m[1]!), ...(key?.keys ? { keys: key.keys } : {}) }, note: `lamports are paid out of the config PDA to this account (${tgt})` });
      } else if (m && tgt.match(/^\w+$/) && fn.params.some((p) => p.name === tgt)) addRole({ name: 'recipient', kind: 'recipient', writable: true, from: { arg: snake(tgt) } });
      else if (/^\w+$/.test(tgt) && spec.stateVars.some((s) => s.name === tgt)) addRole({ name: 'recipient', kind: 'recipient', writable: true, from: { state: 'Config', field: snake(tgt) } });
      else addRole({ name: 'recipient', kind: 'recipient', writable: true, note: `pays out to ${tgt}: pass the destination account and check its key against the stored address` });
    }
    const needsSystem = fn.payable || fn.externalCalls.some((e) => e.low && e.sendsValue) || roles.some((r) => r.init);
    if (needsSystem) addRole({ name: 'system_program', kind: 'system_program', writable: false });
    if (roles.some((r) => r.kind === 'mint')) addRole({ name: 'token_program', kind: 'token_program', writable: false });
    if (roles.some((r) => r.kind === 'vault' && r.init)) addRole({ name: 'associated_token_program', kind: 'associated_token_program', writable: false });

    // several mutable entries of one mapping: their keys may coincide at run time
    for (const r of roles) if (r.kind === 'entry' && r.writable && roles.filter((x) => x.kind === 'entry' && x.writable && x.state === r.state).length > 1) { r.dup = true; r.note = `${r.note ? r.note + '; ' : ''}may be the SAME account as another entry of ${r.state} (self-transfer, sender == fee owner): when the keys are equal apply every change to ONE of them and leave the other untouched (two copies are written back in order, the last one wins)`; }
    // return
    let returns: InstructionDesign['returns'];
    if (isView && fn.returns.length === 1) {
      const r = fn.returns[0]!;
      returns = { rust: rustType(r.type), solidity: r.type.solidity, scale: scaleOfName(fn.name, r.type) };
    } else if (isView && fn.returns.length > 1) insNotes.push('multiple return values: not exposed on Solana');
    for (const e of fn.externalCalls) if (e.low && !e.sendsValue) insNotes.push(`low-level call ${e.target}.${e.method}(...) is not translated`);
    for (const e of fn.externalCalls) if (e.low && e.sendsValue && /\bdata\b|\.data/.test(e.args.map((a) => (a.kind === 'expr' ? a.text : '')).join(' ')) ) insNotes.push(`${e.target}.call{value}(data): the calldata part is not translated (value transfer only)`);
    if (fn.usesTimestamp) insNotes.push('uses block.timestamp: read Clock::get()?.unix_timestamp');
    return {
      name, solidity: kind === 'initialize' ? 'constructor' : kind === 'receive' ? 'receive' : fn.name, kind, args, accounts: roles, ...(returns ? { returns } : {}), emits: fn.events, payable: fn.payable,
      writes: fn.writes, requires: fn.requires.map((r) => `${r.kind}(${r.condition})${r.message ? ` "${r.message}"` : ''}${r.fromModifier ? ` [from modifier ${r.fromModifier}]` : ''}`), notes: insNotes,
    };
  };
  const scaleOfParam = (p: ParamSpec, fn: FunctionSpec): Scale | 'plain' => {
    if (NO_SCALE.value) return 'plain';
    if (fn.externalCalls.some((e) => !e.low && e.args.some((a) => a.kind === 'param' && a.name === p.name) && /transfer/i.test(e.method))) return 'token';
    return scaleOfName(p.name, p.type);
  };

  // constructor
  if (spec.constructor) instructions.push(buildInstruction(spec.constructor, 'initialize'));
  else instructions.push(buildInstruction({ name: 'constructor', kind: 'constructor', visibility: 'public', mutability: 'nonpayable', payable: false, params: [], returns: [], modifiers: [], definedIn: spec.name, events: [], reads: [], writes: [], externalCalls: [], requires: [], mappingAccesses: [], calls: [], usesTimestamp: false, nonPortable: [], range: { file: '', start: 0, length: 0, line: 0, endLine: 0 } }, 'initialize'));
  // the contract's own ERC-20 functions are delegated to the SPL Token program ONLY when they are the plain standard; guards, pausing, blacklists, fees,
  // hooks, upgrade redirects, max-uint allowance semantics or other writers of the token state keep the functions as program code
  const deleg = erc20Delegation(spec);
  const delegated = new Set(tokenStd && !deleg.custom && deleg.reasons.size === 0 ? ['transfer', 'transferFrom', 'approve', 'balanceOf', 'allowance', 'totalSupply', 'decimals', 'name', 'symbol'] : []);
  for (const f of spec.functions) {
    { const u = untranslatable(f); if (u && isPublic(f)) { notTranslated.push({ feature: u.feature, where: f.name, reason: u.reason }); continue; } }
    if (f.kind === 'receive') { instructions.push(buildInstruction(f, 'receive')); continue; }
    if (f.kind !== 'function' || !isPublic(f)) continue;
    if (tokenStd && delegated.has(f.name)) { notTranslated.push({ feature: 'ERC-20 standard function', where: f.name, reason: 'delegated to the SPL Token program (the contract is an ERC-20; its token must be a real SPL mint)' }); continue; }
    const isView = f.mutability === 'view' || f.mutability === 'pure';
    if (isView) {
      // plain public getters of state variables are read from accounts, not instructions
      if (isGetterOf(f, spec)) continue;
      if (f.returns.length !== 1) { notTranslated.push({ feature: 'view with several return values', where: f.name, reason: 'not exposed; read the underlying accounts instead' }); continue; }
      if (f.returnExpr && /^\w+\.length$/.test(f.returnExpr)) continue; // array length view
      instructions.push(buildInstruction(f, 'view'));
    } else instructions.push(buildInstruction(f, 'function'));
  }
  for (const nf of spec.nonPortable) if (nf.treatment === 'not-translated') notTranslated.push({ feature: nf.title, where: nf.where.join(', '), reason: nf.detail });
  // drop duplicates by feature+where
  const seenNT = new Set<string>();
  const nt = notTranslated.filter((x) => { const k = x.feature + '|' + x.where; if (seenNT.has(k)) return false; seenNT.add(k); return true; });

  // ---------- observables
  const observables: Record<string, ObservableDesign> = nullRecord<ObservableDesign>();
  const cfgField = (n: string) => configFields.find((f) => f.name === snake(n));
  for (const sv of spec.stateVars) {
    if (sv.visibility !== 'public' || sv.constant) continue;
    if (sv.type.kind === 'mapping') {
      if (derived.has(sv.name)) { observables[sv.name] = { kind: 'membership', arrayField: derivedMappings.find((d) => d.mapping === sv.name)!.arrayField }; continue; }
      const acc = groupOf.get(sv.name)!;
      const f = acc.fields.find((x) => x.source === sv.name || x.name === snake(sv.name));
      if (acc && f) observables[sv.name] = { kind: 'entry-field', state: acc.name, keyArgs: acc.keys.map((_, i) => (i === 0 ? 'arg0' : 'arg1')), field: f.name, scale: f.scale };
      continue;
    }
    if (sv.type.kind === 'array' && sv.type.length) { observables[sv.name] = { kind: 'config-field', field: snake(sv.name), scale: 'plain' }; continue; }
    if (sv.type.kind === 'contract') { const tk = tokenByVar(sv.name); if (tk) observables[sv.name] = { kind: 'mint-pubkey', token: tk.key }; continue; }
    if (sv.type.kind === 'string') { const sf = cfgField(sv.name); observables[sv.name] = sf ? { kind: 'config-field', field: sf.name, scale: 'plain' } : { kind: 'unobservable', reason: 'string state variable has no config field' }; continue; }
    const f = cfgField(sv.name);
    if (f) observables[sv.name] = { kind: 'config-field', field: f.name, scale: f.scale };
  }
  for (const f of spec.functions) {
    if (f.kind !== 'function' || !isPublic(f) || !(f.mutability === 'view' || f.mutability === 'pure')) continue;
    if (observables[f.name]) continue;
    if (f.returnExpr && /^(\w+)\.length$/.test(f.returnExpr)) { const arr = /^(\w+)\./.exec(f.returnExpr)![1]!; observables[f.name] = { kind: 'array-length', field: `${snake(arr)}_len` }; continue; }
    const ins = instructions.find((i) => i.solidity === f.name && i.kind === 'view');
    if (ins?.returns) observables[f.name] = { kind: 'view-instruction', instruction: ins.name, scale: ins.returns.scale };
    else observables[f.name] = { kind: 'unobservable', reason: 'no scalar return value is exposed on Solana' };
  }
  observables['tokenBalance'] = { kind: 'token-balance' };

  if (spec.hasReceive) notes.push('receive(): native deposits become the `deposit(value)` instruction (system program transfer into the config PDA).');
  if (derivedMappings.length) notes.push(`Mapping ${derivedMappings.map((d) => d.mapping).join(', ')} is only written by the constructor from a fixed address array: it is replaced by a membership test on config.${derivedMappings[0]!.arrayField}.`);
  if (tokenStd && delegated.size) notes.push('The contract is an ERC-20: its own token must be an SPL mint (not re-implemented). Standard ERC-20 functions are delegated to the SPL Token program.');
  if (tokenStd && !delegated.size) {
    const items = [...deleg.reasons.entries()].map(([fn, rs]) => `${fn}: ${rs.join('; ')}`);
    notes.push(`The contract is an ERC-20 with extra behaviour, so it is NOT delegated to the SPL Token program (which would silently bypass it): balances, allowances and supply are program state, and the token is not an SPL mint (wallets and other programs will not treat it as one). Behaviour that must be preserved and is checked by scenarios: ${items.length ? items.join(' | ') : 'balances/supply written outside transfer/transferFrom/approve'}. A Token-2022 mint would only match transfer fees (TransferFee extension, basis points + max fee, not a flat fee) and freeze/pause via the freeze authority (per-account freeze, not a global pause); neither is generated here.`);
    for (const ins of instructions) { const rs = deleg.reasons.get(ins.solidity); if (rs?.length) ins.notes.push(`custom ERC-20 behaviour to preserve exactly: ${rs.join('; ')}`); }
  }
  notes.push('Mapping entries are PDAs created with init_if_needed (payer = caller); an entry that does not exist reads as the Solidity default (zero / false).');
  notes.push('Token vaults are associated token accounts of the config PDA (one per token), created in `initialize`; this is the only vault model used by every instruction.');

  // ---------- inline initialisers (evaluated by code, applied by generated code at the top of `initialize`)
  const initials: NonNullable<SolanaDesign['initials']> = [];
  const initIns = instructions.find((i) => i.kind === 'initialize');
  for (const pl of initialPlans(spec)) {
    if (pl.zero) continue;
    const f = configFields.find((x) => x.source === pl.sv.name);
    if (!f) { notes.push(`initialiser of \`${pl.sv.name}\` (= ${pl.sv.initialValue}) has no config field to receive it: set it in initialize`); continue; }
    let rustValue: string | null = null;
    if (pl.value.kind === 'bool') rustValue = pl.value.value;
    else if (pl.value.kind === 'string' && f.rust === 'String') rustValue = `${JSON.stringify(pl.value.value)}.to_string()`;
    else if (pl.value.kind === 'uint' || pl.value.kind === 'int') {
      let v = BigInt(pl.value.value);
      if (f.scale === 'token') { const dv = 10n ** BigInt(Math.max(0, origDec - solDec)); if (v % dv !== 0n) { notes.push(`initialiser of \`${pl.sv.name}\` = ${v} is not a multiple of the unit conversion (${dv}); set it in initialize`); continue; } v /= dv; }
      const bits = Number(/\d+/.exec(f.rust)?.[0] ?? 128);
      const max = f.rust.startsWith('u') ? (1n << BigInt(bits)) - 1n : (1n << BigInt(bits - 1)) - 1n;
      if (v > max) { notes.push(`initialiser of \`${pl.sv.name}\` = ${v} does not fit ${f.rust}; set it in initialize`); continue; }
      rustValue = `${v}${f.rust}`;
    }
    if (rustValue === null) continue;
    initials.push({ field: f.name, solidity: pl.sv.name, rustValue, shown: `${pl.sv.initialValue} = ${pl.value.value}` });
  }
  for (const nm of spec.constructor?.senderAssignments ?? []) {
    const f = configFields.find((x) => x.source === nm && x.rust === 'Pubkey');
    if (f && !initials.some((i) => i.solidity === nm)) initials.push({ field: f.name, solidity: nm, rustValue: 'ctx.accounts.caller.key()', shown: 'msg.sender (the signer)' });
  }
  if (initials.length && initIns) initIns.notes.push(`already applied by generated code before your body (do NOT set them again): ${initials.map((i) => `${i.solidity} (${i.shown})`).join(', ')}`);
  for (const sv of unresolvedInitials(spec)) if (initIns) initIns.notes.push(`state variable ${sv.name} has the initialiser \`${sv.initialValue}\` that code could not evaluate: set it in initialize`);

  const selfRef = selfReferentialSeeds({ instructions });
  if (selfRef.length) throw new Error(`Solana design rejected: ${selfRef.join('; ')}`);

  return {
    version: 1, mode: 'program', programName: 'app', decimals: NO_SCALE.value ? { original: origDec, solana: origDec, divisor: '1' } : { original: origDec, solana: solDec, divisor: (10n ** BigInt(Math.max(0, origDec - solDec))).toString() },
    integerPolicy, accounts, tokens, instructions, observables, derivedMappings, notTranslated: nt, notes, initials,
  };
}

/** A view that only returns one state variable (the compiler's auto getter or a hand-written equivalent). */
function isGetterOf(f: FunctionSpec, spec: ContractSpec): boolean {
  if (spec.stateVars.some((s) => s.name === f.name && s.visibility === 'public')) return true;
  return false;
}
