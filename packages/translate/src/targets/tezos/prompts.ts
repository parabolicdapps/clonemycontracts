import { FAIL_CLOSED_PROMPT } from '../../spec/guards.js';
import { readFileSync } from 'node:fs';
import type { ContractSpec, FunctionSpec } from '../../types.js';
import type { HandlerD, TezosDesign } from './design-types.js';
import { eventSignatures, handlerSignature } from './codegen.js';

const TARGET_DIR = new URL('../../../targets/tezos/', import.meta.url);
export const primer = (): string => readFileSync(new URL('primer.md', TARGET_DIR), 'utf8');
export const workedExample = (): string => readFileSync(new URL('example.md', TARGET_DIR), 'utf8');

export const SYSTEM = `You are an expert Tezos (SmartPy) engineer porting one Solidity function at a time into an existing, generated SmartPy 0.25.3 contract.
Be faithful: keep every check, the order of checks and effects, the arithmetic semantics (no silent underflow, no silent narrowing) and the events. Do not invent features. Do not drop zero-address or access-control checks. Where Tezos cannot express something exactly, implement the closest equivalent and add a comment starting with \`# DEVIATION:\`. ${FAIL_CLOSED_PROMPT} Hashes: write every \`keccak256(abi.encode(a, b))\` / \`abi.encodePacked\` as \`sp.keccak(sp.pack((a, b)))\` (ONE packing, always the same field order), so the hash of one operation is identical in queue / cancel / execute entrypoints.
Storage, signatures, helpers and events are already generated; use only the names listed in the prompt and described in the primer, never invent a method, field or sp.* function.
The project is compiled with no network access, so use only what is described.

${primer()}

${workedExample()}

Output format (strict). For the function you are asked about, reply with exactly:

=== BODY: <unit_name> ===
<the statements of the function body, written at column 0 (no indentation of the whole block)>
=== END BODY ===
FIDELITY <unit_name>: <one or two sentences: what you kept, what you changed or could not translate>

Nothing else (no markdown fences, no explanation).`;

export interface SourceLookup { text(range: { file: string; start: number; length: number }): string }
export function sourceLookup(sources: Record<string, string>): SourceLookup {
  const bufs = new Map<string, Buffer>();
  return { text: (r) => { if (!bufs.has(r.file)) bufs.set(r.file, Buffer.from(sources[r.file] ?? '', 'utf8')); return bufs.get(r.file)!.subarray(r.start, r.start + r.length).toString('utf8'); } };
}

export function handlerFunction(spec: ContractSpec, h: HandlerD): FunctionSpec | null {
  if (h.kind === 'initialize') return spec.constructor;
  if (h.solidity === 'receive') return spec.functions.find((f) => f.kind === 'receive') ?? null;
  return spec.functions.find((f) => f.name === h.solidity && f.kind === 'function') ?? null;
}

export function storageSummary(d: TezosDesign): string[] {
  const out: string[] = [];
  for (const s of d.state) {
    if (s.unsupported) { out.push(`  (${s.solidity}: not available, ${s.unsupported})`); continue; }
    if (s.kind === 'item') out.push(`  self.data.${s.name}: ${s.value.sp}   (Solidity ${s.solidity}${s.immutable ? ', immutable: set once in initialize' : ''})`);
    else if (s.kind === 'map') out.push(`  ${s.solidity}${s.keys.map((k) => `[${k.sp}]`).join('')} -> ${s.value.sp}: big_map, read self.get_${s.name}(${s.keys.length === 1 ? 'key' : '(k1, k2)'}), write self.data.${s.name}[key] = v`);
    else if (s.fixedLen) out.push(`  ${s.solidity}[${s.fixedLen}]: ${s.value.sp} FIXED array of length ${s.fixedLen}: read self.get_${s.name}(i), write self.data.${s.name}[i] = v (i < ${s.fixedLen}); no length field, no push/pop`);
    else out.push(`  ${s.solidity}[]: ${s.value.sp} array: self.get_${s.name}(i), self.push_${s.name}(v), self.pop_${s.name}(), length self.data.${s.name}_len`);
  }
  return out;
}

export function handlerPrompt(spec: ContractSpec, design: TezosDesign, h: HandlerD, src: SourceLookup): string {
  const fn = handlerFunction(spec, h);
  const L: string[] = [];
  L.push(`Function to implement: \`${h.unit}\` (Solidity: ${h.solidity === 'constructor' ? 'constructor' : h.solidity === 'receive' ? 'receive()' : `function ${h.solidity}`}).`);
  if (fn) {
    L.push('', 'Original Solidity:', '```solidity', src.text(fn.range).trim(), '```');
    const seen = new Set<string>();
    for (const c of fn.calls) {
      if (seen.has(c)) continue;
      seen.add(c);
      if (c.startsWith('modifier:')) { const m = spec.modifiers.find((x) => x.name === c.slice(9)); if (m) L.push('', `Modifier ${m.name} (inline it before/after the body):`, '```solidity', src.text(m.range).trim(), '```'); }
      else { const g = spec.functions.find((f) => f.name === c && f !== fn); if (g) L.push('', `Internal function ${c} that it calls (inline its logic):`, '```solidity', src.text(g.range).trim(), '```'); }
    }
  }
  L.push('', `Generated SmartPy signature (already exists, do not repeat it; your text is the body):`, '```python', handlerSignature(h), '```');
  if (h.kind === 'initialize') L.push('This is the contract\'s one-time initialisation (the Solidity constructor): the generated prologue already checked that the caller is the deployer and that it runs once; `self.data.initialized = True` is appended after your body. `sp.sender` is the deployer (Solidity msg.sender).');
  const args = h.args.map((a) => `  - ${a.name}: ${a.t.sp}   (Solidity ${a.solidity}${a.note ? `; ${a.note}` : ''})`);
  L.push('', 'Arguments (in scope as variables):', args.length ? args.join('\n') : '  (none)');
  if (h.returns) L.push('', h.returns.single ? `This is a view returning ${h.returns.fields[0]!.t.sp} (Solidity ${h.returns.fields[0]!.solidity}); end with \`return <value>\`.` : `This is a view returning several values (Solidity returns ${h.returns.fields.map((f) => f.solidity).join(', ')}); end with \`return sp.record(${h.returns.fields.map((f) => `${f.name}=<${f.t.sp}>`).join(', ')})\` (exactly these field names).`);
  L.push('', 'Storage (only these fields exist; scalars are read/written directly, mappings through the helpers):', ...storageSummary(design));
  if (design.structs.length) { L.push('', 'Struct types (records; `sp.record(...)` builds one, `.field` reads one):'); for (const s of design.structs) L.push(`  ${s.name} = sp.record(${s.fields.map((f) => `${f.name}=${f.t.sp}`).join(', ')})   zero value: ${s.name}_ZERO`); }
  L.push('', 'Helpers you may call (and nothing else on `self`):', ...design.helpers.map((x) => `  ${x.sig}   -- ${x.doc}`));
  const evs = spec.events.filter((e) => h.emits.includes(e.name));
  if (evs.length) { const sigs = eventSignatures(spec); L.push('', 'Events you emit:'); for (const e of evs) L.push(`  ${sigs[e.name]}`); }
  if (design.constants.length) L.push('', 'Solidity constants (inline them, they are not stored):', ...design.constants.map((c) => `  ${c.solidity} = ${c.value ?? '(see source)'}`));
  if (design.tokens.length) L.push('', `ERC-20 tokens this contract calls: ${design.tokens.map((t) => `${t.solidity}${t.stateName ? ` (address in self.data.${t.stateName})` : ''}`).join(', ')}; they are FA1.2 token contracts, called ONLY through the erc20_* helpers (queued operations).`);
  if (h.requires.length) L.push('', 'Checks the Solidity performs (keep them, in this order):', ...h.requires.map((r) => `  - ${r}`));
  if (h.notes.length) L.push('', 'Design notes:', ...h.notes.map((n) => `  - ${n}`));
  L.push('', 'Reply in the strict output format.');
  return L.join('\n');
}

// ------------------------------------------------------------------ repair

/** Hints for the messages SmartPy 0.25.3 actually produces (each seen in a real run), appended to the repair prompt. */
export const HINTS: { re: RegExp; hint: string }[] = [
  { re: /cannot delete function call/, hint: 'delete a mapping entry with `del self.data.<name>[key]` (the get_* helpers only read).' },
  { re: /sp\.mod|sp\.div/, hint: 'there is no sp.mod / sp.div: use the operators `%` and `/`.' },
  { re: /sp\.is_nat: mismatch between sp\.int and sp\.nat/, hint: '`sp.as_nat(x)` only accepts an INT. `a + b` of nats is already a nat: do not wrap it. Use `sp.as_nat(a - b, error="MSG")` only around a subtraction (or an `sp.to_int(..)`).' },
  { re: /mismatch between sp\.int and sp\.nat|Expected type sp\.nat, but got sp\.int|Expected type sp\.int, but got sp\.nat/, hint: 'nat/int mismatch: `a - b` of nats is an INT. Store or compare it as a nat with `sp.as_nat(a - b, error="MESSAGE")`; turn a nat into an int with `sp.to_int(n)`. `abs(i)` gives a nat.' },
  { re: /cannot be multiplied|Type class "Mul"|Expected type sp\.mutez/, hint: 'mutez vs nat: native amounts are converted by the generated helpers only (`self.msg_value()` gives a nat, `self.send_native(sp.record(to=..., amount=<nat>))` sends). Never multiply a nat by sp.mutez yourself.' },
  { re: /may not have been initialised|has no field/, hint: 'unknown field: only the storage fields listed in the prompt exist (`self.data.<name>`); mappings are read through `self.get_<name>(key)`.' },
  { re: /Not a statement|Not an expression/, hint: 'syntax: this is not a SmartPy statement. No type annotations (`x: T = v`), no helper called with two arguments (`self.get_m((a, b))` takes ONE tuple), no Python comprehensions/f-strings.' },
  { re: /elseif is not allowed/, hint: 'SmartPy has no `elif`: write `else:` and put a nested `if` under it.' },
  { re: /unknown operator '(\*\*|\/\/)'/, hint: 'no `**` or `//`: use `pow_nat((base, exponent))` and `/` (floor division on nats).' },
  { re: /is undefined or wrong number of arguments|wrong number of arguments/, hint: 'this sp.* function does not exist in SmartPy 0.25 or has the wrong arguments. Use: assert/raise for errors, `sp.as_nat`, `sp.to_int`, `sp.record`, `sp.emit`, `sp.send` only through the generated helpers. `sp.nat(x)` / `sp.int(x)` take a literal only.' },
  { re: /'return' in non-terminal position/, hint: 'SmartPy has no early return. In a view, `return` must be the last statement (or the last statement of BOTH branches of a final if/else). Declare a local before the if (`t = 0`), assign it inside the branches, and `return t` at the end.' },
  { re: /Not a statement: return/, hint: 'entrypoints and initialize cannot `return`: to skip the remaining statements, put them in an `else:` block.' },
  { re: /\w+ is not defined\./, hint: 'a name that is not defined here. If you assigned it inside an if/else/for block, SmartPy does not keep it after the block: declare it BEFORE the block (e.g. `t = 0`) and assign it inside. Otherwise only the arguments, the listed helpers and storage fields exist.' },
  { re: /non-unit return type/, hint: 'an entrypoint cannot `return` a value: remove it (state-changing functions return nothing on Tezos).' },
  { re: /Comparison: Expected type/, hint: 'comparing values of different types (e.g. an address with a string, a nat with a timestamp). Time is `self.now_secs()` (a nat); addresses compare with addresses.' },
  { re: /has no length or size/, hint: 'a big_map has no length: keep a counter in storage, or use the generated `<array>_len`.' },
  { re: /print is not defined|str is not defined|is not defined/, hint: 'this Python name does not exist inside a SmartPy contract; remove it.' },
  { re: /Missing item in map|Expected variant Some, got None/, hint: 'a runtime abort: reading a missing key with `self.data.m[k]` (use `self.get_m(k)`), or `sp.as_nat` of a negative number (check the order of your arithmetic).' },
  { re: /Sender is undefined|view/, hint: 'views run without a transaction context: no `sp.sender`, `sp.amount`; pass the address as an argument.' },
  { re: /Expected type sp\.unit, but got/, hint: 'a bare expression statement (a value that is computed and thrown away, e.g. `self.get_x(k)` on its own line). Remove it or assign it.' },
];
export const hintsFor = (text: string): string[] => HINTS.filter((h) => h.re.test(text)).map((h) => h.hint);

export interface UnitLog { unit: string; text: string }
/** compile() assembles its log from per-unit sections: `=== UNIT <unit> ===` followed by lint lines and/or the compiler tail for that unit. */
export function parseUnitSections(log: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of log.matchAll(/^=== UNIT (\w+) ===\n([\s\S]*?)(?=^=== (?:UNIT|FULL) |\s*$(?![\s\S]))/gm)) out.set(m[1]!, m[2]!.trim());
  return out;
}

export function repairPrompt(h: HandlerD, currentBody: string, errorText: string, hints: string[]): string {
  return [
    `The body you wrote for \`${h.unit}\` does not compile. The generated code is the signature \`${handlerSignature(h)}\` wrapping your body.`,
    '', 'Your current body:', '```python', currentBody, '```', '', 'Problems (lint messages are static checks that list ALL problems found; compiler messages show the first error only, so re-read the whole body for similar mistakes):', '```', errorText, '```',
    ...(hints.length ? ['', 'Hints:', ...hints.map((x) => `- ${x}`)] : []),
    '', 'Return the corrected body in the strict format (=== BODY: ... === END BODY === and the FIDELITY line). Keep all behaviour; fix the problems only.',
  ].join('\n');
}

export function behaviourRepairPrompt(h: HandlerD, currentBody: string, problems: string[]): string {
  return [
    `The function \`${h.unit}\` compiles, but running it does not behave like the original Solidity contract. Observed differences (the Solidity result is ground truth):`,
    ...problems.map((p) => `- ${p}`),
    '', 'Your current body:', '```python', currentBody, '```',
    '', 'Fix the logic so the Tezos behaviour matches (same success/revert decisions, same resulting state). Read mappings through the generated `get_*` helpers, subtract with `sp.as_nat(.., error=..)`. Do not change the signature. Return the corrected body in the strict format.',
  ].join('\n');
}
