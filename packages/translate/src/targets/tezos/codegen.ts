import type { ContractSpec } from '../../types.js';
import type { HandlerD, ReturnD, StateVarD, TezosDesign } from './design-types.js';
import { keyType } from './design.js';
import { MAX_UINT256, ZERO_ADDRESS, snake } from './names.js';

export const DEF_FILE = 'contract_def.py';
const I = (n: number) => ' '.repeat(n);
export const BEGIN = (unit: string) => `# cmc:begin ${unit}`;
export const END = (unit: string) => `# cmc:end ${unit}`;

/** the FA1.2 transfer/approve parameter types, with the TZIP-7 layouts (field names `from` / `to` are Python keywords, hence `as`) */
export const FA12_TRANSFER_T = 'sp.record(from_=sp.address, to_=sp.address, value=sp.nat).layout(("from_ as from", ("to_ as to", "value")))';
export const FA12_APPROVE_T = 'sp.record(spender=sp.address, value=sp.nat).layout(("spender", "value"))';

export function eventSignatures(spec: ContractSpec): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of spec.events) {
    const fields = e.params.map((p, i) => `${snake(p.name || `field${i}`)}=<${p.type.kind === 'uint' || p.type.kind === 'enum' ? 'nat' : p.type.kind === 'int' ? 'int' : p.type.kind === 'address' || p.type.kind === 'contract' ? 'address' : p.type.kind === 'bool' ? 'bool' : p.type.kind === 'string' ? 'string' : p.type.kind === 'bytes' || p.type.kind === 'fixedbytes' ? 'bytes' : 'value'}>`);
    out[e.name] = fields.length ? `sp.emit(sp.record(${fields.join(', ')}), tag="${e.name}")` : `sp.emit(sp.unit, tag="${e.name}")`;
  }
  return out;
}

const retZero = (r: ReturnD): string => (r.single ? r.fields[0]!.t.zero : `sp.record(${r.fields.map((f) => `${f.name}=${f.t.zero}`).join(', ')})`);

/** `def name(self, a: sp.nat, ...):` */
export function handlerSignature(h: HandlerD): string {
  return `def ${h.name}(self${h.args.map((a) => `, ${a.name}: ${a.t.sp}`).join('')}):`;
}

function genStorageInit(d: TezosDesign): string[] {
  const L: string[] = [];
  L.push('self.data.deployer = deployer');
  if (d.hasInitialize) L.push('self.data.initialized = False');
  for (const sv of d.state) {
    if (sv.unsupported) continue;
    if (sv.kind === 'item') L.push(`self.data.${sv.name} = ${sv.init ?? sv.zero}`);
    else if (sv.kind === 'map') L.push(`self.data.${sv.name} = sp.cast(sp.big_map(), sp.big_map[${keyType(sv.keys)}, ${sv.value.sp}])`);
    else { L.push(`self.data.${sv.name} = sp.cast(sp.big_map(), sp.big_map[sp.nat, ${sv.value.sp}])`); if (!sv.fixedLen) L.push(`self.data.${sv.name}_len = sp.nat(0)`); }
  }
  return L;
}

function genHelperMethods(d: TezosDesign): string[] {
  const L: string[] = [];
  const m = (lines: string[]) => { for (const l of lines) L.push(l ? I(8) + l : ''); L.push(''); };
  for (const sv of d.state as StateVarD[]) {
    if (sv.unsupported) continue;
    if (sv.kind === 'map') m(['@sp.private(with_storage="read-only")', `def get_${sv.name}(self, key):`, `    return self.data.${sv.name}.get(key, default=${sv.zero})`]);
    if (sv.kind === 'array' && sv.fixedLen) {
      m(['@sp.private(with_storage="read-only")', `def get_${sv.name}(self, index):`, `    assert index < ${sv.fixedLen}, "INDEX_OUT_OF_BOUNDS"`, `    return self.data.${sv.name}.get(index, default=${sv.zero})`]);
    } else if (sv.kind === 'array') {
      m(['@sp.private(with_storage="read-only")', `def get_${sv.name}(self, index):`, `    assert index < self.data.${sv.name}_len, "INDEX_OUT_OF_BOUNDS"`, `    return self.data.${sv.name}[index]`]);
      m(['@sp.private(with_storage="read-write")', `def push_${sv.name}(self, value):`, `    self.data.${sv.name}[self.data.${sv.name}_len] = value`, `    self.data.${sv.name}_len += 1`]);
      m(['@sp.private(with_storage="read-write")', `def pop_${sv.name}(self):`, `    assert self.data.${sv.name}_len > 0, "EMPTY_ARRAY"`, `    self.data.${sv.name}_len = sp.as_nat(self.data.${sv.name}_len - 1)`, `    del self.data.${sv.name}[self.data.${sv.name}_len]`]);
    }
  }
  m(['@sp.private()', 'def now_secs(self):', '    return sp.as_nat(sp.now - sp.timestamp(0))']);
  if (d.helpers.some((h) => h.name === 'msg_value')) {
    m(['@sp.private()', 'def msg_value(self):', '    return sp.fst(sp.ediv(sp.amount, sp.mutez(1)).unwrap_some())']);
    m(['@sp.private(with_operations=True)', 'def send_native(self, p):', '    sp.cast(p, sp.record(to=sp.address, amount=sp.nat))', '    sp.send(p.to, sp.mul(p.amount, sp.mutez(1)))']);
    m(['@sp.private()', 'def native_balance(self):', '    return sp.fst(sp.ediv(sp.balance, sp.mutez(1)).unwrap_some())']);
  }
  if (d.tokens.length) {
    m(['@sp.private(with_operations=True)', 'def erc20_transfer(self, p):', '    sp.cast(p, sp.record(token=sp.address, to=sp.address, amount=sp.nat))', `    c = sp.contract(${FA12_TRANSFER_T}, p.token, entrypoint="transfer").unwrap_some(error="BAD_TOKEN")`, '    sp.transfer(sp.record(from_=sp.self_address, to_=p.to, value=p.amount), sp.mutez(0), c)']);
    m(['@sp.private(with_operations=True)', 'def erc20_transfer_from(self, p):', '    sp.cast(p, sp.record(token=sp.address, from_=sp.address, to=sp.address, amount=sp.nat))', `    c = sp.contract(${FA12_TRANSFER_T}, p.token, entrypoint="transfer").unwrap_some(error="BAD_TOKEN")`, '    sp.transfer(sp.record(from_=p.from_, to_=p.to, value=p.amount), sp.mutez(0), c)']);
    m(['@sp.private(with_operations=True)', 'def erc20_approve(self, p):', '    sp.cast(p, sp.record(token=sp.address, spender=sp.address, amount=sp.nat))', `    c = sp.contract(${FA12_APPROVE_T}, p.token, entrypoint="approve").unwrap_some(error="BAD_TOKEN")`, '    sp.transfer(sp.record(spender=p.spender, value=p.amount), sp.mutez(0), c)']);
  }
  return L;
}

/** reindent a model-written body (any consistent indentation) to `ind` spaces */
export function indentBody(body: string, ind: number): string[] {
  const lines = body.replace(/\t/g, '    ').split('\n');
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  const min = Math.min(...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length), Infinity);
  const cut = Number.isFinite(min) ? min : 0;
  const out = lines.map((l) => (l.trim() ? I(ind) + l.slice(cut) : ''));
  return out.length ? out : [I(ind) + 'pass'];
}

function genHandler(d: TezosDesign, h: HandlerD, body: string | undefined): string[] {
  const L: string[] = [];
  const dec = h.kind === 'view' ? '@sp.onchain_view()' : '@sp.entrypoint';
  L.push(I(8) + dec, I(8) + handlerSignature(h));
  if (h.kind !== 'view') {
    if (h.kind === 'initialize') { L.push(I(12) + 'assert not self.data.initialized, "ALREADY_INITIALIZED"', I(12) + 'assert sp.sender == self.data.deployer, "NOT_DEPLOYER"'); for (const n of d.senderInits ?? []) L.push(I(12) + `self.data.${n} = sp.sender   # generated: ${n} = msg.sender`); }
    else if (d.hasInitialize) L.push(I(12) + 'assert self.data.initialized, "NOT_INITIALIZED"');
    if (!h.payable) L.push(I(12) + 'assert sp.amount == sp.mutez(0), "NOT_PAYABLE"');
    for (const a of h.args) if (a.t.kind === 'array' && a.t.fixed) L.push(I(12) + `assert sp.len(${a.name}) == ${a.t.fixed}, "BAD_ARRAY_LENGTH"`);
  }
  if (h.generated) { L.push(I(12) + `# generated: ${h.generated.why}`, I(12) + h.generated.body); L.push(''); return L; }
  L.push(I(12) + `# cmc:stub ${h.unit} ${h.kind === 'view' ? `return ${h.returns ? retZero(h.returns) : 'sp.unit'}` : 'pass'}`);
  L.push(I(12) + BEGIN(h.unit));
  if (body !== undefined) L.push(...indentBody(body, 12));
  else if (h.kind === 'view') L.push(I(12) + `return ${h.returns ? retZero(h.returns) : 'sp.unit'}`);
  else L.push(I(12) + 'pass');
  L.push(I(12) + END(h.unit));
  if (h.kind === 'initialize') L.push(I(12) + 'self.data.initialized = True');
  L.push('');
  return L;
}

/** the whole `contract_def.py`. `bodies` maps unit -> model-written body text; a missing body becomes a type-correct stub. */
export function genContractDef(spec: ContractSpec, d: TezosDesign, bodies: Record<string, string>): string {
  const L: string[] = [];
  L.push('# Generated by CloneMyContracts (Tezos pack). Everything outside the `# cmc:begin` / `# cmc:end` blocks is generated from the Solidity spec by code;', `# the blocks are the model-written bodies of ${spec.name}'s functions. UNAUDITED.`, 'import smartpy as sp', '', '', '@sp.module', 'def main():');
  L.push(I(4) + 'import smartpy.stdlib.string_utils as string_utils', I(4) + `ZERO_ADDRESS = sp.address("${ZERO_ADDRESS}")`, I(4) + `MAX_UINT256 = ${MAX_UINT256}`, '');
  L.push(I(4) + 'def u256(x):', I(8) + 'assert x <= MAX_UINT256, "OVERFLOW"', I(8) + 'return x', '');
  L.push(I(4) + 'def pow_nat(p):', I(8) + '(b, e) = sp.cast(p, sp.pair[sp.nat, sp.nat])', I(8) + 'r = sp.nat(1)', I(8) + 'i = sp.nat(0)', I(8) + 'while i < e:', I(12) + 'r = r * b', I(12) + 'i += 1', I(8) + 'return r', '');
  for (const s of d.structs) {
    L.push(I(4) + `${s.name}: type = sp.record(${s.fields.map((f) => `${f.name}=${f.t.sp}`).join(', ')})`);
    L.push(I(4) + `${s.name}_ZERO = sp.record(${s.fields.map((f) => `${f.name}=${f.t.zero.replace(/_ZERO$/, '_ZERO')}`).join(', ')})`, '');
  }
  L.push(I(4) + `class ${d.className}(sp.Contract):`);
  L.push(I(8) + 'def __init__(self, deployer):');
  for (const l of genStorageInit(d)) L.push(I(12) + l);
  L.push('');
  L.push(...genHelperMethods(d));
  for (const h of d.instructions) L.push(...genHandler(d, h, bodies[h.unit]));
  while (L[L.length - 1] === '') L.pop();
  L.push('');
  return L.join('\n');
}

/** `contract.py`: the SmartPy scenario that compiles the contract (python3 contract.py [deployer-address]) and writes the Michelson + initial storage */
export function genCompileScenario(d: TezosDesign, ctorArgs = ''): string {
  return `# Compiles ${d.className} to Michelson: python3 contract.py [DEPLOYER_ADDRESS]
# (needs the smartpy-tezos package). The deployer address becomes the initial storage's \`deployer\` field.
import sys
import smartpy as sp
from contract_def import main

DEPLOYER = sys.argv[1] if len(sys.argv) > 1 else "${ZERO_ADDRESS}"


@sp.add_test()
def test():
    scenario = sp.test_scenario("compile")
    c = main.${d.className}(${ctorArgs || 'deployer=sp.address(DEPLOYER)'})
    scenario += c
`;
}

export function genProject(spec: ContractSpec, d: TezosDesign, bodies: Record<string, string>): Record<string, string> {
  return { [DEF_FILE]: genContractDef(spec, d, bodies), 'contract.py': genCompileScenario(d) };
}

/** one body block of a generated file */
export interface UnitBlock { unit: string; startLine: number; endLine: number; body: string; stub: string }
export function parseUnits(def: string): UnitBlock[] {
  const lines = def.split('\n');
  const out: UnitBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*# cmc:begin (\w+)$/.exec(lines[i]!);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !new RegExp(`^\\s*# cmc:end ${m[1]}$`).test(lines[j]!)) j++;
    const st = /^\s*# cmc:stub \w+ (.*)$/.exec(lines[i - 1] ?? '');
    out.push({ unit: m[1]!, startLine: i + 2, endLine: j, body: lines.slice(i + 1, j).join('\n'), stub: st?.[1] ?? 'pass' });
    i = j;
  }
  return out;
}
/** replace every model-written body except `keep` by its type-correct stub (used to isolate one unit's compile errors) */
export function stubUnits(def: string, keep: string): string {
  const lines = def.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)# cmc:begin (\w+)$/.exec(lines[i]!);
    if (!m || m[2] === keep) { out.push(lines[i]!); continue; }
    let j = i + 1;
    while (j < lines.length && !new RegExp(`^\\s*# cmc:end ${m[2]}$`).test(lines[j]!)) j++;
    const st = /^\s*# cmc:stub \w+ (.*)$/.exec(lines[i - 1] ?? '');
    out.push(lines[i]!, m[1]! + (st?.[1] ?? 'pass'), lines[j]!);
    i = j;
  }
  return out.join('\n');
}
