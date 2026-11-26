import { nullRecord } from '../../own.js';
import { untranslatable } from '../../spec/standard.js';
import { initialPlans, unresolvedInitials } from '../../spec/initial.js';
import type { ContractSpec, FunctionSpec, ParamSpec, StateVarSpec, TypeRef } from '../../types.js';
import type {
  AptosDesign, ArrayDesign, ConstDesign, ErrorDesign, EventDesign, HelperDesign, InstructionDesign, MoveField, ObservableDesign, ParamDesign, Scale, ScalarDesign, StructDesign, TableDesign, TokenDesign,
} from './design-types.js';
import { arrayHelpers, baseHelpers, nativeHelpers, scalarHelpers, tableHelpers, tokenHelpers } from './helpers.js';
import { ident, pascal, upperSnake } from './names.js';

export function moveType(t: TypeRef): string {
  switch (t.kind) {
    case 'uint': case 'int': { const b = t.bits ?? 256; return b <= 8 ? 'u8' : b <= 16 ? 'u16' : b <= 32 ? 'u32' : b <= 64 ? 'u64' : b <= 128 ? 'u128' : 'u256'; }
    case 'bool': return 'bool';
    case 'address': case 'contract': return 'address';
    case 'string': return 'String';
    case 'bytes': case 'fixedbytes': return 'vector<u8>';
    case 'enum': return 'u8';
    case 'array': return `vector<${moveType(t.element!)}>`;
    case 'struct': return pascal(t.name ?? 'Struct');
    default: return 'u256';
  }
}

export function defaultExpr(move: string): string {
  if (/^u\d+$/.test(move)) return '0';
  if (move === 'bool') return 'false';
  if (move === 'address') return '@0x0';
  if (move === 'String') return 'string::utf8(b"")';
  if (move.startsWith('vector<')) return 'vector[]';
  return `default_${ident(move)}()`;
}

const AMOUNT_RE = /amount|balance|staked|stake|reward|^supply|totalSupply|allocation|released|releasable|total|earned|paid|value|vest|refund|price|cost|fee/i;
const NOT_AMOUNT_RE = /time|period|finish|update|duration|count|index|id$|confirmations|start|cliff|end|bps|perToken|^ratio/i;
export function scaleOfName(name: string, type: TypeRef, nft: boolean): Scale {
  if (type.kind !== 'uint') return 'plain';
  if (/^(balance|balances|balanceOf|_balances)$/i.test(name) && nft) return 'plain';
  if (/PerToken|perToken|^ratio|Ratio$/.test(name)) return 'ratio';
  if (NOT_AMOUNT_RE.test(name) && !/^(total|released|staked)/i.test(name)) return 'plain';
  return AMOUNT_RE.test(name) ? 'token' : 'plain';
}

const UNITS: Record<string, bigint> = { seconds: 1n, second: 1n, minutes: 60n, minute: 60n, hours: 3600n, hour: 3600n, days: 86400n, day: 86400n, weeks: 604800n, week: 604800n, wei: 1n, gwei: 10n ** 9n, ether: 10n ** 18n };
/** Evaluate the simple constant expressions Solidity uses (`18`, `1e18`, `10 ** 18`, `7 days`, `a * b`); null when not recognised. */
export function evalConstant(text: string): bigint | null {
  const t = text.trim().replace(/_/g, '').replace(/^\((.*)\)$/, '$1');
  const prod = t.split('*').map((x) => x.trim());
  if (t.includes('**') ) { const m = /^(\d+)\s*\*\*\s*(\d+)$/.exec(t); return m ? BigInt(m[1]!) ** BigInt(m[2]!) : null; }
  let acc = 1n;
  for (const f of prod) {
    const m = /^(\d+)(?:e(\d+))?(?:\s+(\w+))?$/.exec(f);
    if (!m) return null;
    let v = BigInt(m[1]!) * (m[2] ? 10n ** BigInt(m[2]) : 1n);
    if (m[3]) { const u = UNITS[m[3]]; if (u === undefined) return null; v *= u; }
    acc *= v;
  }
  return acc;
}

function abilitiesOf(fieldTypes: string[]): string[] { return fieldTypes.some((m) => /Table<|SignerCapability/.test(m)) ? ['store'] : ['copy', 'drop', 'store']; }

export interface DesignOptions { decimals?: number; originalDecimals?: number }

export function buildAptosDesign(spec: ContractSpec, opts: DesignOptions = {}): AptosDesign {
  const nft = spec.tokenStandards.includes('ERC-721');
  const aptDec = opts.decimals ?? 8;
  const origDec = opts.originalDecimals ?? 18;
  const notTranslated: AptosDesign['notTranslated'] = [];
  const notes: string[] = [];
  const sc = (name: string, t: TypeRef) => scaleOfName(name, t, nft);
  const mf = (name: string, t: TypeRef, solidity = t.solidity): MoveField => ({ name: ident(name) || 'v', move: moveType(t), solidity, scale: sc(name, t) });

  // ---------- structs
  const structs: StructDesign[] = spec.structs.map((s) => {
    const fields = s.fields.map((f) => mf(f.name, f.type));
    return { name: pascal(s.name), role: 'struct' as const, fields, abilities: abilitiesOf(fields.map((f) => f.move)) };
  });
  if (spec.stateVars.some((v) => v.type.kind === 'int' || (v.type.kind === 'mapping' && v.type.value?.kind === 'int'))) notTranslated.push({ feature: 'signed integers (intN)', where: 'state', reason: 'Move has no signed integers: stored as the unsigned type of the same width; negative values cannot be represented' });

  // ---------- tokens
  const tokens: TokenDesign[] = spec.tokenDependencies.map((t) => {
    const raw = t.name.replace(/^_/, '');
    return { solidity: raw, key: ident(raw), field: ident(raw), methods: t.methods };
  });
  const tokenByVar = (target: string) => tokens.find((t) => t.solidity === target.replace(/^_/, ''));
  const ctorMap = new Map((spec.constructor?.paramAssignments ?? []).map((a) => [a.param, a.stateVar]));
  const tokenOfParam = (pname: string) => tokenByVar(pname) ?? (ctorMap.has(pname) ? tokenByVar(ctorMap.get(pname)!) : undefined);

  // ---------- state variables
  const constants: ConstDesign[] = [];
  const scalars: ScalarDesign[] = [];
  const tables: TableDesign[] = [];
  const arrays: ArrayDesign[] = [];
  const takenFields = new Set<string>();
  const fieldName = (n: string) => { let f = ident(n); while (takenFields.has(f)) f += '_'; takenFields.add(f); return f; };
  for (const sv of spec.stateVars) {
    if (sv.constant) {
      const v = sv.initialValue !== undefined ? evalConstant(sv.initialValue) : null;
      if (v !== null && (sv.type.kind === 'uint' || sv.type.kind === 'int')) { constants.push({ solidity: sv.name, name: upperSnake(sv.name), move: moveType(sv.type), value: v.toString(), scale: sc(sv.name, sv.type), public: sv.visibility === 'public' }); continue; }
      if (sv.type.kind === 'bool' && /^(true|false)$/.test(sv.initialValue ?? '')) { constants.push({ solidity: sv.name, name: upperSnake(sv.name), move: 'bool', value: sv.initialValue!, scale: 'plain', public: sv.visibility === 'public' }); continue; }
      notes.push(`constant \`${sv.name}\` = \`${sv.initialValue ?? '?'}\` could not be evaluated by code: it is a normal state field starting at its default; set it in \`initialize\` yourself.`);
    }
    if (sv.type.kind === 'mapping') {
      const keys: TypeRef[] = []; let cur = sv.type;
      while (cur.kind === 'mapping') { keys.push(cur.key!); cur = cur.value!; }
      if (cur.kind === 'struct' && !spec.structs.some((st) => st.name === cur.name)) { notTranslated.push({ feature: 'struct type not available', where: sv.name, reason: `the value type ${cur.solidity} of \`${sv.name}\` has no definition in the spec, so no Move struct can be generated for it; the state variable is left out` }); continue; }
      const field = fieldName(sv.name);
      const keyDs = keys.map((k, i) => ({ name: keys.length === 1 ? 'k' : `k${i + 1}`, move: moveType(k), solidity: k.solidity }));
      const tableKey = keys.length === 1 ? keyDs[0]!.move : `${pascal(sv.name)}Key`;
      if (keys.length > 1) structs.push({ name: tableKey, role: 'key', fields: keyDs.map((k) => ({ name: k.name, move: k.move, solidity: k.solidity, scale: 'plain' as Scale })), abilities: ['copy', 'drop', 'store'] });
      tables.push({ solidity: sv.name, field, keys: keyDs, tableKey, value: { move: moveType(cur), solidity: cur.solidity, scale: sc(sv.name, cur), ...(cur.kind === 'struct' ? { struct: pascal(cur.name!) } : {}) } });
    } else if (sv.type.kind === 'array') {
      arrays.push({ solidity: sv.name, field: fieldName(sv.name), element: { move: moveType(sv.type.element!), solidity: sv.type.element!.solidity, scale: sc(sv.name, sv.type.element!), ...(sv.type.element!.kind === 'struct' ? { struct: pascal(sv.type.element!.name!) } : {}) }, fixed: sv.type.length ?? null });
    } else {
      scalars.push({ name: ident(sv.name), field: fieldName(sv.name), solidity: sv.name, move: moveType(sv.type), scale: sc(sv.name, sv.type), immutable: sv.immutable, isString: sv.type.kind === 'string', ...(sv.immutable ? {} : {}) } as ScalarDesign);
    }
  }
  // tokens that are only constructor parameters need a State field too
  for (const tk of tokens) if (!scalars.some((s) => s.solidity === tk.solidity)) { const f = fieldName(tk.solidity); tk.field = f; scalars.push({ name: f, field: f, solidity: tk.solidity, move: 'address', scale: 'plain', immutable: false, isString: false, note: 'fungible-asset metadata address (constructor parameter)' }); }
  for (const tk of tokens) { const s = scalars.find((x) => x.solidity === tk.solidity); if (s) { tk.field = s.field; s.move = 'address'; s.note = 'fungible-asset metadata object address'; } }

  const usesNative = spec.hasReceive || spec.functions.some((f) => f.payable || f.externalCalls.some((e) => e.low && e.sendsValue)) || !!spec.constructor?.payable;

  // ---------- events and errors
  const taken = new Set([...structs.map((s) => s.name), 'State']);
  const events: EventDesign[] = spec.events.map((e) => {
    let name = pascal(e.name); while (taken.has(name)) name += 'Event'; taken.add(name);
    return { name, fields: e.params.map((p, i) => ({ ...mf(p.name || `v${i}`, p.type), name: ident(p.name || `v${i}`) })) };
  });
  const evName = new Map(spec.events.map((e, i) => [e.name, events[i]!.name]));
  const errors: ErrorDesign[] = [{ name: 'E_NOT_PUBLISHER', code: 1, source: 'initialize may only be called by the account that published the module' }, { name: 'E_INDEX_OUT_OF_RANGE', code: 2, source: 'array index out of range' }, { name: 'E_REQUIRE_FAILED', code: 3, source: 'require/assert without a message' }];
  const errByMsg = new Map<string, string>();
  const errFor = (msg: string | undefined, source: string): string => {
    if (!msg) return 'E_REQUIRE_FAILED';
    if (errByMsg.has(msg)) return errByMsg.get(msg)!;
    let name = `E_${upperSnake(msg).slice(0, 40).replace(/_+$/, '') || 'FAILED'}`;
    while (errors.some((e) => e.name === name)) name += '_';
    errors.push({ name, code: errors.length + 1, source });
    errByMsg.set(msg, name);
    return name;
  };
  for (const e of spec.errors) errFor(e.name, `custom error ${e.name}`);
  for (const f of [...(spec.constructor ? [spec.constructor] : []), ...spec.functions]) for (const r of f.requires) errFor(r.message, `${f.name}: ${r.kind}(${r.condition})`);

  // ---------- helpers
  const helpers: HelperDesign[] = [...baseHelpers()];
  const defaultOf = (move: string) => defaultExpr(move);
  for (const s of scalars) helpers.push(...scalarHelpers(s.field, s.move, s.solidity, defaultOf(s.move)));
  for (const t of tables) helpers.push(...tableHelpers(t, defaultOf(t.value.move)));
  for (const a of arrays) helpers.push(...arrayHelpers(a, defaultOf(a.element.move)));
  for (const tk of tokens) helpers.push(...tokenHelpers(tk.key, tk.field, tk.solidity));
  if (usesNative) helpers.push(...nativeHelpers());

  // ---------- instructions
  const isPublic = (f: FunctionSpec) => f.visibility === 'public' || f.visibility === 'external';
  const instructions: InstructionDesign[] = [];
  const usedNames = new Set<string>(helpers.map((h) => h.name));
  const fnName = (n: string) => { let x = ident(n); while (usedNames.has(x)) x += '_'; usedNames.add(x); return x; };
  const scaleOfParam = (p: ParamSpec, fn: FunctionSpec): Scale => {
    if (fn.externalCalls.some((e) => !e.low && e.args.some((a) => a.kind === 'param' && a.name === p.name) && /transfer/i.test(e.method))) return 'token';
    return sc(p.name, p.type);
  };
  const build = (fn: FunctionSpec, kind: InstructionDesign['kind']): InstructionDesign | null => {
    const name = kind === 'initialize' ? 'initialize' : kind === 'receive' ? 'deposit' : fnName(fn.name);
    const params: ParamDesign[] = [];
    const insNotes: string[] = [];
    const taken2 = new Set<string>();
    for (const [pi, p] of fn.params.entries()) {
      if (p.type.kind === 'struct' && kind !== 'view') { notTranslated.push({ feature: 'struct parameter', where: fn.name, reason: 'Move entry functions cannot take structs' }); return null; }
      let nm = ident(p.name || `arg${pi}`); while (taken2.has(nm)) nm += '_'; taken2.add(nm);
      const tk = tokenOfParam(p.name);
      const isTime = p.type.kind === 'uint' && /start|time|deadline|expir|until|end$|cliff$/i.test(p.name) && !/seconds|duration|period/i.test(p.name);
      params.push({ name: nm, move: tk ? 'address' : moveType(p.type), solidity: p.type.solidity, scale: isTime ? 'time' : p.type.kind === 'uint' ? scaleOfParam(p, fn) : 'plain', src: pi, ...(tk ? { note: 'fungible-asset metadata object address of the token' } : {}) });
    }
    const payable = fn.payable || kind === 'receive';
    if (payable) params.push({ name: 'value', move: 'u256', solidity: 'msg.value', src: -1, scale: 'token', note: 'octas of APT sent with the call (replaces msg.value); the generated prologue already moved them from the caller into the contract' });
    const uses = new Set<string>();
    for (const v of [...fn.reads, ...fn.writes]) uses.add(v);
    for (const m of fn.mappingAccesses) uses.add(m.variable);
    for (const e of fn.externalCalls) { const tk = tokenByVar(e.target); if (tk) uses.add(tk.solidity); if (e.low && e.sendsValue) uses.add('native'); }
    if (payable) uses.add('native');
    for (const nf of fn.nonPortable) insNotes.push(`non-portable: ${nf}`);
    if (fn.usesTimestamp) insNotes.push('uses block.timestamp: call now_secs()');
    for (const e of fn.externalCalls) if (e.low && !e.sendsValue) insNotes.push(`low-level call ${e.target}.${e.method}(...) is not translated`);
    for (const e of fn.externalCalls) if (e.low && e.sendsValue && e.args.some((a) => a.kind === 'expr' && /\bdata\b/.test(a.text))) insNotes.push(`${e.target}.call{value}(data): the calldata part is not translated (value transfer only)`);
    const returns = (kind === 'view' ? fn.returns : []).map((r) => ({ move: moveType(r.type), solidity: r.type.solidity, scale: sc(r.name || fn.name, r.type) }));
    if (kind !== 'view' && fn.returns.length) insNotes.push('the Solidity return value is not returned (entry functions return nothing); callers read the state through the view functions');
    return {
      name, solidity: kind === 'initialize' ? 'constructor' : kind === 'receive' ? 'receive' : fn.name, kind, params, returns, payable, emits: fn.events.map((e) => evName.get(e) ?? e),
      requires: fn.requires.map((r) => `${r.kind}(${r.condition}) -> ${errFor(r.message, '')}${r.fromModifier ? ` [from modifier ${r.fromModifier}]` : ''}`), writes: fn.writes, uses: [...uses], notes: insNotes,
    };
  };
  const emptyCtor = { name: 'constructor', kind: 'constructor', visibility: 'public', mutability: 'nonpayable', payable: false, params: [], returns: [], modifiers: [], definedIn: spec.name, events: [], reads: [], writes: [], externalCalls: [], requires: [], mappingAccesses: [], calls: [], usesTimestamp: false, nonPortable: [], range: { file: '', start: 0, length: 0, line: 0, endLine: 0 } } as FunctionSpec;
  const init = build(spec.constructor ?? emptyCtor, 'initialize');
  if (init) instructions.push(init);
  const getterNames = new Set(spec.stateVars.filter((s) => s.visibility === 'public').map((s) => s.name));
  for (const f of spec.functions) {
    { const u = untranslatable(f); if (u && isPublic(f)) { notTranslated.push({ feature: u.feature, where: f.name, reason: u.reason }); continue; } }
    if (f.kind === 'receive') { const i = build(f, 'receive'); if (i) instructions.push(i); continue; }
    if (f.kind !== 'function' || !isPublic(f)) continue;
    const isView = f.mutability === 'view' || f.mutability === 'pure';
    if (isView && getterNames.has(f.name)) continue;
    const i = build(f, isView ? 'view' : 'entry');
    if (i) instructions.push(i);
  }
  for (const nf of spec.nonPortable) if (nf.treatment === 'not-translated' && nf.id !== 'low-level-call') notTranslated.push({ feature: nf.title, where: nf.where.join(', '), reason: nf.detail });
  // low-level calls: the value part is translated (native_push); a call that carries calldata, or has no value, is not
  const lowData = [...spec.functions, ...(spec.constructor ? [spec.constructor] : [])].filter((f) => f.externalCalls.some((e) => e.low && (!e.sendsValue || e.args.some((a) => a.kind === 'expr' && /\bdata\b|\.data/.test(a.text)))));
  if (lowData.length) notTranslated.push({ feature: 'low-level call calldata / non-value calls', where: lowData.map((f) => f.name).join(', '), reason: 'the value transfer of `target.call{value: v}(data)` is translated (native_push) but the calldata is not executed: Move has no dynamic dispatch' });
  const seen = new Set<string>();
  const nt = notTranslated.filter((x) => { const k = `${x.feature}|${x.where}`; if (seen.has(k)) return false; seen.add(k); return true; });

  // ---------- public getters and observables
  const observables: Record<string, ObservableDesign> = nullRecord<ObservableDesign>();
  for (const sv of spec.stateVars) {
    if (sv.visibility !== 'public') continue;
    const name = ident(sv.name);
    const valScales = (v: { scale: Scale; struct?: string }): Scale[] => (v.struct ? structs.find((s) => s.name === v.struct)!.fields.map((f) => f.scale) : [v.scale]);
    if (sv.type.kind === 'mapping') { const t = tables.find((x) => x.solidity === sv.name); if (t) observables[sv.name] = { kind: 'view', fn: name, scales: valScales(t.value), params: t.keys.map((k) => k.move) }; }
    else if (sv.type.kind === 'array') { const a = arrays.find((x) => x.solidity === sv.name); if (a) observables[sv.name] = { kind: 'view', fn: name, scales: valScales(a.element), params: ['u256'] }; }
    else { const s = scalars.find((x) => x.solidity === sv.name) ?? constants.find((x) => x.solidity === sv.name); if (s) observables[sv.name] = { kind: 'view', fn: name, scales: [s.scale], params: [] }; }
  }
  for (const i of instructions) if (i.kind === 'view') observables[i.solidity] = { kind: 'view', fn: i.name, scales: i.returns.map((r) => r.scale), params: i.params.map((p) => p.move) };
  observables['tokenBalance'] = { kind: 'token-balance' };

  if (spec.hasReceive) notes.push('receive(): native deposits become the `deposit(caller, value)` entry (the prologue pulls `value` octas of APT from the caller into the contract).');
  if (spec.tokenStandards.includes('ERC-20') && tokens.length === 0) notes.push('The contract is itself an ERC-20 with extra behaviour, so it is rewritten as a module with its own balance/allowance tables (not a Fungible Asset): wallets and explorers will not list it as a coin. Plain ERC-20s use the Fungible Asset template instead.');
  const integerPolicy = [
    'Integer widths follow the Solidity declaration (uint8..uint256 -> u8..u256, mixed widths need explicit `as` casts); arithmetic aborts on overflow (like Solidity 0.8). Signed integers do not exist in Move.',
    `Fungible-asset and APT amounts are u64 in the framework: the generated helpers cast u256 -> u64 (abort if larger). Fixture tokens use ${aptDec} decimals (the original's ${origDec}-decimal amounts are divided by 10^${origDec - aptDec}), so u64 holds about ${(2n ** 64n / 10n ** BigInt(aptDec)).toString()} whole tokens.`,
    'block.timestamp becomes timestamp::now_seconds() (u64).',
  ];
  notes.push(`State: one \`State\` resource stored at a deterministic resource account (\`account::create_resource_address(@app, b"cmc_state")\`) created by \`initialize\`. The resource account's SignerCapability sits in State, so the contract can pay out from its own primary fungible stores / APT balance, with no extra signer and no other module-controlled store.`);
  notes.push('Constructor: an explicit `initialize` entry (init_module cannot take arguments), callable once, only by the publisher account (@app), which plays the Solidity deployer (msg.sender in the constructor).');
  notes.push('ERC-20 pulls: there is no allowance/transferFrom pull on Aptos. The caller signs the transaction, so `<token>_pull(caller, amount)` takes the funds from the caller directly. Solidity code that needed an `approve` first just skips it. This is a design difference, not a bug.');
  notes.push('Mappings are `aptos_std::table::Table` fields of State (a missing key reads as the Solidity default); nested mappings use a generated composite key struct. Tables cannot be iterated (like Solidity mappings).');
  notes.push('Errors: every Solidity revert message / custom error has an abort-code constant `E_*` (see design.json); Solidity panics (overflow, index out of range) are Move aborts as well.');
  notes.push('A Sui Move profile would share the language level of this design (structs, abilities, generated accessors, test-module generation) but differ in storage: Sui has no global storage (`State` becomes a shared object, `borrow_global` -> object parameters, `acquires` disappears), no resource accounts (the vault is a `Balance<T>` field), coins are `Coin<T>`/`Balance<T>` instead of fungible-asset stores, and entry functions take `&mut TxContext` and objects instead of `&signer`.');
  void (null as unknown as StateVarSpec);
  // inline initialisers: evaluated by code, written into the State literal in `initialize` (not by the model)
  const initIns = instructions.find((i) => i.kind === 'initialize');
  const appliedInits: string[] = [];
  for (const pl of initialPlans(spec)) {
    if (pl.zero) continue;
    const sc0 = scalars.find((x) => x.solidity === pl.sv.name);
    if (!sc0) { notes.push(`initialiser of \`${pl.sv.name}\` (= ${pl.sv.initialValue}) has no State field to receive it: set it in initialize`); continue; }
    let lit: string | null = null;
    if (pl.value.kind === 'bool') lit = pl.value.value;
    else if ((pl.value.kind === 'uint' || pl.value.kind === 'int') && /^[ui](8|16|32|64|128|256)$/.test(sc0.move)) {
      let v = BigInt(pl.value.value);
      if (sc0.scale === 'token') { const dv = 10n ** BigInt(Math.max(0, origDec - aptDec)); if (v % dv !== 0n) { notes.push(`initialiser of \`${pl.sv.name}\` = ${v} is not a multiple of the unit conversion (${dv}); set it in initialize`); continue; } v /= dv; }
      const bits = Number(sc0.move.slice(1)); const max = (1n << BigInt(bits)) - 1n;
      if (v > max || v < 0n) { notes.push(`initialiser of \`${pl.sv.name}\` = ${v} does not fit ${sc0.move}; set it in initialize`); continue; }
      lit = `${v}${sc0.move}`;
    }
    if (lit === null) { notes.push(`initialiser of \`${pl.sv.name}\` (= ${pl.sv.initialValue}) has a type that code cannot apply: set it in initialize`); continue; }
    sc0.init = lit; sc0.initShown = `${pl.sv.initialValue} = ${pl.value.value}`; appliedInits.push(`${pl.sv.name} (${sc0.initShown})`);
  }
  for (const nm of spec.constructor?.senderAssignments ?? []) {
    const sc0 = scalars.find((x) => x.solidity === nm);
    if (sc0 && sc0.move === 'address' && !sc0.init) { sc0.init = 'signer::address_of(caller)'; sc0.initShown = 'msg.sender (the publisher)'; appliedInits.push(`${nm} (msg.sender)`); }
  }
  if (initIns) {
    if (appliedInits.length) initIns.notes.push(`already applied by generated code in the State literal (do NOT set them again): ${appliedInits.join(', ')}`);
    for (const sv of unresolvedInitials(spec)) initIns.notes.push(`state variable ${sv.name} has the initialiser \`${sv.initialValue}\` that code could not evaluate: set it in initialize`);
  }

  return {
    version: 1, mode: 'program', packageName: 'app', moduleName: ident(spec.name), decimals: { original: origDec, aptos: aptDec, divisor: (10n ** BigInt(Math.max(0, origDec - aptDec))).toString() },
    integerPolicy, structs, scalars, constants, tables, arrays, tokens, usesNative, events, errors, helpers, instructions, observables, notTranslated: nt, notes,
  };
}
