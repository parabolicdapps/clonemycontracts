import { FAIL_CLOSED_PROMPT } from '../../spec/guards.js';
import { readFileSync } from 'node:fs';
import type { ContractSpec, FunctionSpec } from '../../types.js';
import { FILE_FORMAT } from '../../llm/files.js';
import type { AptosDesign, InstructionDesign } from './design-types.js';
import { handlerSignature, prologue } from './codegen.js';
import { upperSnake } from './names.js';

const TARGET_DIR = new URL('../../../targets/aptos/', import.meta.url);
export const primer = (): string => readFileSync(new URL('primer.md', TARGET_DIR), 'utf8');
export const workedExample = (): string => readFileSync(new URL('example.md', TARGET_DIR), 'utf8');

export const SYSTEM = `You are an expert Aptos Move engineer porting one Solidity function at a time into an existing Move module (Aptos framework 9.6, Move 2).
Be faithful: keep every check, the order of checks and effects, the arithmetic semantics and the events. Do not invent features. Where Move cannot express something exactly, implement the closest equivalent and add a comment starting with \`DEVIATION:\`. ${FAIL_CLOSED_PROMPT}
You only write the BODY of one function. Everything else (State, structs, events, error constants, signatures, acquires, and the helper functions that read and write state, tokens and APT) is generated and correct: use the helpers, never framework functions you are not given.
The project has no network access when compiled.

${primer()}

${workedExample()}

Output format (strict). For the function you are asked about, reply with exactly:

=== BODY: <function_name> ===
<the statements of the function body>
=== END BODY ===
FIDELITY <function_name>: <one or two sentences: what you kept, what you changed or could not translate>

Nothing else (no markdown fences, no explanation).`;

export interface SourceLookup { text(range: { file: string; start: number; length: number }): string }
export function sourceLookup(sources: Record<string, string>): SourceLookup {
  const bufs = new Map<string, Buffer>();
  return { text: (r) => { if (!bufs.has(r.file)) bufs.set(r.file, Buffer.from(sources[r.file] ?? '', 'utf8')); return bufs.get(r.file)!.subarray(r.start, r.start + r.length).toString('utf8'); } };
}

/** Helpers the model may call for this function: the base ones plus those of the state it touches. */
export function helpersFor(design: AptosDesign, ins: InstructionDesign) {
  const groups = new Set(ins.uses);
  return design.helpers.filter((h) => h.group === '*' || groups.has(h.group) || (h.group === 'native' && (ins.payable || groups.has('native'))));
}

export function cheatSheet(design: AptosDesign, ins: InstructionDesign): string {
  return helpersFor(design, ins).map((h) => `  ${h.signature};   // ${h.doc}`).join('\n');
}

function structText(design: AptosDesign, names: Set<string>): string {
  return design.structs.filter((s) => names.has(s.name)).map((s) => `  struct ${s.name} has ${s.abilities.join(', ')} { ${s.fields.map((f) => `${f.name}: ${f.move}`).join(', ')} }`).join('\n');
}

export function instructionPrompt(spec: ContractSpec, design: AptosDesign, ins: InstructionDesign, src: SourceLookup): string {
  const fn: FunctionSpec | null = ins.kind === 'initialize' ? spec.constructor : spec.functions.find((f) => (ins.kind === 'receive' ? f.kind === 'receive' : f.name === ins.solidity && f.kind === 'function')) ?? null;
  const L: string[] = [];
  L.push(`Function to implement: \`${ins.name}\` (Solidity: ${ins.solidity === 'constructor' ? 'constructor' : ins.solidity === 'receive' ? 'receive()' : `function ${ins.solidity}`}).`);
  if (fn) {
    L.push('', 'Original Solidity:', '```solidity', src.text(fn.range).trim(), '```');
    const seen = new Set<string>();
    for (const c of fn.calls) {
      if (c.startsWith('modifier:')) { const m = spec.modifiers.find((x) => x.name === c.slice(9)); if (m && !seen.has(c)) { seen.add(c); L.push('', `Modifier ${m.name} (its code runs before/after the body; inline it):`, '```solidity', src.text(m.range).trim(), '```'); } }
      else { const h = spec.functions.find((f) => f.name === c && f !== fn); if (h && !seen.has(c)) { seen.add(c); L.push('', `Internal function ${c} that it calls (inline its logic):`, '```solidity', src.text(h.range).trim(), '```'); } }
    }
  }
  L.push('', 'Generated Move you must fit into (it already exists, do not repeat it; your body replaces `...`):', '```move', `${handlerSignature(design, ins, 'x')} {`, ...(ins.kind === 'initialize' ? ['        // prologue (generated): checks the publisher, creates the resource account and the State resource with DEFAULT values.', '        // Nothing from it is available to your body (no res_signer, no cap): set every field with the set_* helpers.'] : prologue(design, ins)), '        ...', '}', '```');
  L.push('', 'Helper functions you may call (module-private, generated, correct):', cheatSheet(design, ins));
  const used = new Set<string>();
  for (const h of helpersFor(design, ins)) for (const s of design.structs) if (h.signature.includes(s.name) || h.code.includes(`${s.name} {`)) used.add(s.name);
  for (const p of ins.params) for (const s of design.structs) if (p.move.includes(s.name)) used.add(s.name);
  const st = structText(design, used); if (st) L.push('', 'Structs:', st);
  const evs = design.events.filter((e) => ins.emits.includes(e.name));
  if (evs.length) { L.push('', 'Events you can emit (already defined):'); for (const e of evs) L.push(`  ${e.name} { ${e.fields.map((f) => `${f.name}: ${f.move}`).join(', ')} }`); }
  L.push('', 'Error constants (u64; use with assert!(cond, E_X) / abort E_X):', design.errors.map((e) => `  ${e.name}`).join(', '));
  if (ins.requires.length) L.push('', 'Checks the Solidity performs (keep them, in this order):', ...ins.requires.map((r) => `  - ${r}`));
  if (ins.notes.length) L.push('', 'Design notes:', ...ins.notes.map((n) => `  - ${n}`));
  L.push('', 'Parameters (already in scope):', ...(ins.params.length ? ins.params.map((a) => `  - ${a.name}: ${a.move}${a.note ? ` (${a.note})` : ''}`) : ['  (none)']));
  if (ins.kind !== 'view') L.push('  - caller: &signer (msg.sender is signer::address_of(caller))');
  if (ins.kind === 'view') L.push('', `This is a view${ins.returns.length ? `: the body's last expression (no semicolon) is the result, type ${ins.returns.length === 1 ? ins.returns[0]!.move : `(${ins.returns.map((r) => r.move).join(', ')})`}` : ''}. It cannot use \`caller\`.`);
  L.push('', 'Reply in the strict output format.');
  return L.join('\n');
}

// ------------------------------------------------------------------ errors and repair

/** Hints for common Move compiler errors, appended to the repair prompt when the pattern appears in the log. */
export const HINTS: { re: RegExp; hint: string }[] = [
  { re: /ability|does not have|cannot ignore values|unused value/i, hint: 'Ability error: only values with `drop` can be ignored or overwritten, only `copy` values can be used twice. Bind unwanted results with `let _ = expr;`. Structs read through getters are copies, so use the setter to store changes. `signer` and `Table` values are not copyable.' },
  { re: /borrow|already (mutably )?borrowed|invalid (usage|return) of reference|mutable ownership|cannot (mutably )?borrow/i, hint: 'Borrow error: you never need references to State. Call getters into locals (`let b = get_x(k);`), compute, then call the setter. Pass `&v` / `&mut v` only for local vectors or strings; do not hold a reference while calling a helper.' },
  { re: /acquires/i, hint: 'The `acquires` list is generated for you; never call borrow_global/move_from yourself, use the getters and setters.' },
  { re: /unbound (variable|local|name|function|module member|type)|undeclared|cannot find|not found in scope|unknown (name|function)/i, hint: 'Unbound name: use only the parameters, `caller`, the listed helper functions (exact names), the listed event structs and E_* constants. Qualify std functions as `vector::`, `string::`, `signer::`, `event::`. Do not call framework functions that are not in the helper list.' },
  { re: /incompatible|mismatch|expected .* but found|cannot (use|cast|convert)|invalid (cast|operation)/i, hint: 'Type mismatch: Move never widens implicitly. Cast with `(x as u256)` / `(x as u64)`, compare and add only equal types (state fields have the widths shown in the helper signatures), vector indices are u64, `now_secs()` is u64.' },
  { re: /unexpected token|invalid (syntax|term|expression)|expected one of|unexpected/i, hint: 'Syntax error: this is Move, not Rust. No `let mut`, no `?`, no `+=` on fields, no `Ok(())`, no `self`, no `&&=`; `if (cond) { .. } else { .. }` needs parentheses; the last expression of a view has no `;`.' },
  { re: /type annotation|cannot infer|could not infer/i, hint: 'Type annotation needed: write `vector::empty<u8>()`, `let x: u256 = 0;` or `0u256`.' },
  { re: /(not|never) used|unused|unreachable/i, hint: 'Unused or unreachable code is only a warning; fix the real errors first.' },
  { re: /(invalid|unexpected) (struct|pack|unpack)|missing (field|argument)|unknown field|no field/i, hint: 'Struct literals must list every field of the struct as shown in the Structs section; read fields as `t.name`.' },
  { re: /wrong number of (type )?arguments|arity|expected \d+ argument/i, hint: 'Wrong number of arguments: check the exact helper signature in the list (setters take the keys first, then the value; `*_pull` takes `caller` first).' },
];

export function hintsFor(log: string): string[] { return HINTS.filter((h) => h.re.test(log)).map((h) => h.hint); }

/** Split a Move compiler log into error blocks (a block starts with `error` and runs until the next `error`/`warning`). */
export function errorBlocks(log: string): string[] {
  const blocks: string[] = []; let cur: string[] | null = null;
  for (const l of log.replace(/^\[aptos\] ?/gm, '').split('\n')) {
    if (/^error(\[\w+\])?:/.test(l)) { if (cur) blocks.push(cur.join('\n').trimEnd()); cur = [l]; }
    else if (/^warning(\[\w+\])?:/.test(l)) { if (cur) blocks.push(cur.join('\n').trimEnd()); cur = null; }
    else if (cur) cur.push(l);
  }
  if (cur) blocks.push(cur.join('\n').trimEnd());
  return blocks.filter((b) => !/Failed to run tests|^error: could not compile/.test(b));
}

export function firstErrorBlocks(log: string, maxBlocks = 6, maxChars = 6000): string {
  const out = errorBlocks(log).slice(0, maxBlocks).join('\n\n');
  return out.length > maxChars ? `${out.slice(0, maxChars)}\n...[truncated]...` : out;
}

/** Which units a compile log blames (the log was annotated with `[unit NAME]` by `annotateLog`). */
export function failingUnits(log: string, design: AptosDesign): { units: Set<string>; other: boolean } {
  const units = new Set<string>(); let other = false;
  for (const b of errorBlocks(log)) {
    const ms = [...b.matchAll(/\[unit (\w+)\]/g)];
    const known = ms.filter((m) => design.instructions.some((i) => i.name === m[1]));
    if (known.length) known.forEach((m) => units.add(m[1]!)); else other = true;
  }
  return { units, other };
}

export function repairPrompt(design: AptosDesign, ins: InstructionDesign, currentBody: string, errorText: string, extra: string[]): string {
  return [
    `The body you wrote for \`${ins.name}\` does not compile. The generated function is \`${handlerSignature(design, ins, currentBody)} { <prologue> ...your body... }\`.`,
    '', 'Your current body:', '```move', currentBody, '```', '', 'Compiler errors (first ones only; line numbers are of the generated file):', '```', errorText, '```',
    ...(extra.length ? ['', 'Hints:', ...extra.map((h) => `- ${h}`)] : []),
    '', 'Helper functions you may call:', cheatSheet(design, ins),
    '', 'Return the corrected body in the strict format (=== BODY: ... === END BODY === and the FIDELITY line). Keep all behaviour; fix the errors only.',
  ].join('\n');
}

export function behaviourRepairPrompt(design: AptosDesign, ins: InstructionDesign, currentBody: string, problems: string[]): string {
  return [
    `The function \`${ins.name}\` compiles, but running it in the Move unit-test VM does not behave like the original Solidity contract. Observed differences (the Solidity result is ground truth):`,
    ...problems.map((p) => `- ${p}`),
    '', 'Your current body:', '```move', currentBody, '```',
    '', 'Helper functions you may call:', cheatSheet(design, ins),
    '', 'Fix the logic so the Move behaviour matches (same success/abort decisions, same resulting state). Do not change the signature. Return the corrected body in the strict format.',
  ].join('\n');
}

export { FILE_FORMAT, upperSnake };
