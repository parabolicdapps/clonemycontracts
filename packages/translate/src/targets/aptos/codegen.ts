import { own } from '../../own.js';
import type { ContractSpec } from '../../types.js';
import type { AptosDesign, InstructionDesign, MoveField, StructDesign } from './design-types.js';
import { defaultExpr } from './design.js';
import { ident } from './names.js';

export const PUBLISHER_ADDRESS = '0xcafe';

export function genMoveToml(): string {
  return `[package]\nname = "app"\nversion = "0.1.0"\n\n[addresses]\napp = "${PUBLISHER_ADDRESS}"\n\n[dependencies]\nAptosFramework = { local = "/opt/aptos-framework/aptos-framework" }\n`;
}

const fieldsText = (fs: MoveField[], indent = '        ') => fs.map((f) => `${indent}${f.name}: ${f.move},`).join('\n');

export function genStructs(design: AptosDesign): string {
  const out: string[] = [];
  for (const s of design.structs) {
    out.push(`    struct ${s.name} has ${s.abilities.join(', ')} {\n${fieldsText(s.fields)}\n    }`);
    if (s.role === 'struct') out.push(`    fun default_${ident(s.name)}(): ${s.name} {\n        ${s.name} {\n${s.fields.map((f) => `            ${f.name}: ${defaultExpr(f.move)},`).join('\n')}\n        }\n    }`);
  }
  return out.join('\n\n');
}

export function genState(design: AptosDesign): string {
  const fields = [
    '        cap: SignerCapability,',
    ...design.scalars.map((s) => `        ${s.field}: ${s.move},   // ${s.solidity}${s.note ? ` (${s.note})` : ''}`),
    ...design.tables.map((t) => `        ${t.field}: Table<${t.tableKey}, ${t.value.move}>,   // ${t.solidity}`),
    ...design.arrays.map((a) => `        ${a.field}: vector<${a.element.move}>,   // ${a.solidity}${a.fixed ? ` (fixed length ${a.fixed})` : ''}`),
  ];
  return `    struct State has key {\n${fields.join('\n')}\n    }`;
}

function stateInit(design: AptosDesign): string {
  const inits = [
    '            cap,',
    ...design.scalars.map((s) => `            ${s.field}: ${s.init ?? defaultExpr(s.move)},${s.init ? `   // inline initialiser ${s.initShown}` : ''}`),
    ...design.tables.map((t) => `            ${t.field}: table::new(),`),
    ...design.arrays.map((a) => `            ${a.field}: ${a.fixed ? `vector[${Array.from({ length: a.fixed }, () => defaultExpr(a.element.move)).join(', ')}]` : 'vector[]'},`),
  ];
  return `        move_to(&res_signer, State {\n${inits.join('\n')}\n        });`;
}

export function genConstsAndErrors(design: AptosDesign): string {
  return [
    ...design.errors.map((e) => `    const ${e.name}: u64 = ${e.code};   // ${e.source.replace(/\n/g, ' ')}`),
    ...design.constants.map((c) => `    const ${c.name}: ${c.move} = ${c.value};   // Solidity constant ${c.solidity}`),
  ].join('\n');
}

export function genEvents(design: AptosDesign): string {
  return design.events.map((e) => `    #[event]\n    struct ${e.name} has drop, store {\n${fieldsText(e.fields)}\n    }`).join('\n\n');
}

export function typedParams(ins: InstructionDesign): string {
  const ps = ins.params.map((p) => `${p.name}: ${p.move}`);
  return (ins.kind === 'view' ? ps : ['caller: &signer', ...ps]).join(', ');
}

export function returnType(ins: InstructionDesign): string {
  if (ins.kind !== 'view' || ins.returns.length === 0) return '';
  return ins.returns.length === 1 ? `: ${ins.returns[0]!.move}` : `: (${ins.returns.map((r) => r.move).join(', ')})`;
}

/** `acquires State` is decided by code from what the body calls, never by the model. */
export function acquiresFor(design: AptosDesign, body: string, ins: InstructionDesign): boolean {
  if (/\bborrow_global(_mut)?\b|\bmove_from\b|\bexists</.test(body)) return true;
  return design.helpers.some((h) => h.acquires && new RegExp(`\\b${h.name}\\b`).test(body)) || (ins.kind === 'initialize' && false);
}

export function handlerSignature(design: AptosDesign, ins: InstructionDesign, body = ''): string {
  const head = ins.kind === 'view' ? '#[view]\n    public fun' : 'public entry fun';
  return `${head} ${ins.name}(${typedParams(ins)})${returnType(ins)}${acquiresFor(design, body, ins) ? ' acquires State' : ''}`;
}

export function prologue(design: AptosDesign, ins: InstructionDesign): string[] {
  const L: string[] = [];
  if (ins.kind === 'initialize') {
    L.push('        assert!(signer::address_of(caller) == @app, E_NOT_PUBLISHER);', '        let (res_signer, cap) = account::create_resource_account(caller, b"cmc_state");', stateInit(design));
  }
  if (ins.payable) L.push('        native_pull(caller, value);');
  return L;
}

export function stubBody(ins: InstructionDesign): string { return `abort 0   // STUB: no body was generated for ${ins.solidity}`; }

/** strip the common indentation of a model-written body and indent it for the function */
export function indentBody(body: string): string {
  const ls = body.replace(/\s+$/, '').split('\n');
  const min = Math.min(1e9, ...ls.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length));
  return ls.map((l) => (l.trim() ? `        ${l.slice(Math.min(min, l.length))}` : '')).join('\n');
}

export function genHandler(design: AptosDesign, ins: InstructionDesign, body: string | undefined): string {
  const b = body ?? stubBody(ins);
  const pro = prologue(design, ins);
  return `    // <<unit ${ins.name}>>\n    ${handlerSignature(design, ins, b)} {\n${pro.join('\n')}${pro.length ? '\n' : ''}${indentBody(b)}\n    }\n    // <<end ${ins.name}>>`;
}

export function genGetters(design: AptosDesign): string {
  const out: string[] = [];
  const tuple = (v: { move: string; struct?: string }, fields: Map<string, MoveField[]>) => (v.struct ? { ret: `(${fields.get(v.struct)!.map((f) => f.move).join(', ')})`, expr: (e: string) => `{ let v = ${e}; (${fields.get(v.struct!)!.map((f) => `v.${f.name}`).join(', ')}) }` } : { ret: v.move, expr: (e: string) => e });
  const sf = new Map(design.structs.map((s) => [s.name, s.fields]));
  for (const c of design.constants) if (c.public) out.push(`    #[view]\n    public fun ${ident(c.solidity)}(): ${c.move} {\n        ${c.name}\n    }`);
  for (const s of design.scalars) {
    const sv = own(design.observables, s.solidity);
    if (sv && sv.kind === 'view' && !design.instructions.some((i) => i.name === sv.fn)) out.push(`    #[view]\n    public fun ${sv.fn}(): ${s.move} acquires State {\n        get_${s.field}()\n    }`);
  }
  for (const t of design.tables) {
    const o = own(design.observables, t.solidity);
    if (!o || o.kind !== 'view') continue;
    const tp = tuple(t.value, sf);
    out.push(`    #[view]\n    public fun ${o.fn}(${t.keys.map((k) => `${k.name}: ${k.move}`).join(', ')}): ${tp.ret} acquires State {\n        ${t.value.struct ? `let v = get_${t.field}(${t.keys.map((k) => k.name).join(', ')});\n        (${sf.get(t.value.struct)!.map((f) => `v.${f.name}`).join(', ')})` : `get_${t.field}(${t.keys.map((k) => k.name).join(', ')})`}\n    }`);
  }
  for (const a of design.arrays) {
    const o = own(design.observables, a.solidity);
    if (!o || o.kind !== 'view') continue;
    const tp = tuple(a.element, sf);
    out.push(`    #[view]\n    public fun ${o.fn}(i: u256): ${tp.ret} acquires State {\n        ${a.element.struct ? `let v = get_${a.field}(i);\n        (${sf.get(a.element.struct)!.map((f) => `v.${f.name}`).join(', ')})` : `get_${a.field}(i)`}\n    }`);
  }
  return out.join('\n\n');
}

const USES: [RegExp, string][] = [
  [/\bsigner::/, 'use std::signer;'], [/\bString\b|\bstring::/, 'use std::string::{Self, String};'], [/\bvector\b/, 'use std::vector;'], [/\boption::/, 'use std::option::{Self, Option};'],
  [/\bTable<|\btable::/, 'use aptos_std::table::{Self, Table};'], [/\bstring_utils::/, 'use aptos_std::string_utils;'],
  [/\baccount::|\bSignerCapability\b/, 'use aptos_framework::account::{Self, SignerCapability};'], [/\bevent::/, 'use aptos_framework::event;'], [/\btimestamp::/, 'use aptos_framework::timestamp;'],
  [/\bobject::|\bObject</, 'use aptos_framework::object::{Self, Object};'], [/\bMetadata\b/, 'use aptos_framework::fungible_asset::Metadata;'], [/\bprimary_fungible_store::/, 'use aptos_framework::primary_fungible_store;'],
  [/\baptos_account::/, 'use aptos_framework::aptos_account;'], [/\bcoin::/, 'use aptos_framework::coin;'], [/\bAptosCoin\b/, 'use aptos_framework::aptos_coin::AptosCoin;'],
];

export function genModule(spec: ContractSpec, design: AptosDesign, bodies: Record<string, string>): string {
  const parts: string[] = [];
  parts.push(genConstsAndErrors(design));
  const st = genStructs(design); if (st) parts.push(st);
  parts.push(genState(design));
  const ev = genEvents(design); if (ev) parts.push(ev);
  parts.push('    // ---- generated helpers: the only way function bodies touch state, tokens and APT ----\n' + design.helpers.map((h) => h.code.split('\n').map((l) => `    ${l}`).join('\n')).join('\n\n'));
  const g = genGetters(design); if (g) parts.push('    // ---- generated getters (public state variables) ----\n' + g);
  parts.push('    // ---- functions: signature, prologue and acquires are generated; the bodies are written per function ----\n' + design.instructions.map((i) => genHandler(design, i, bodies[i.name])).join('\n\n'));
  const text = parts.join('\n\n');
  const uses = USES.filter(([re]) => re.test(text)).map(([, u]) => `    ${u}`);
  void spec;
  return `// Generated by cmc (Aptos pack). Unaudited. Header, structs, state, events, errors, helpers and signatures come from code; the function bodies were written by a model and checked against scenarios.\nmodule app::${design.moduleName} {\n${uses.join('\n')}\n\n${text}\n}\n`;
}

export function moduleFile(design: AptosDesign): string { return `sources/${design.moduleName}.move`; }

export function assembleAptos(spec: ContractSpec, design: AptosDesign, bodies: Record<string, string>): Record<string, string> {
  return { 'Move.toml': genMoveToml(), [moduleFile(design)]: genModule(spec, design, bodies) };
}

/** Map `file:line` of a compiler log to the unit whose markers enclose the line, and annotate the log. */
export function annotateLog(log: string, files: Record<string, string>): string {
  const ranges = new Map<string, { unit: string; from: number; to: number }[]>();
  for (const [name, text] of Object.entries(files)) {
    if (!name.endsWith('.move')) continue;
    const rs: { unit: string; from: number; to: number }[] = [];
    const lines = text.split('\n');
    let open: { unit: string; from: number } | null = null;
    lines.forEach((l, i) => {
      const a = /<<unit (\w+)>>/.exec(l); if (a) open = { unit: a[1]!, from: i + 1 };
      const b = /<<end (\w+)>>/.exec(l); if (b && open) { rs.push({ unit: open.unit, from: open.from, to: i + 1 }); open = null; }
    });
    ranges.set(name, rs);
  }
  return log.replace(/(\S*?((?:sources|tests)\/[\w./-]+\.move)):(\d+):(\d+)/g, (m, _p, rel: string, line: string) => {
    const r = ranges.get(rel)?.find((x) => Number(line) >= x.from && Number(line) <= x.to);
    return r ? `${m} [unit ${r.unit}]` : m;
  });
}
