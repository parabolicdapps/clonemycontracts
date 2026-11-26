import { FAIL_CLOSED_PROMPT } from '../../spec/guards.js';
import { readFileSync } from 'node:fs';
import type { ContractSpec, FunctionSpec } from '../../types.js';
import type { CwDesign, HandlerD } from './design-types.js';
import { accessorSignatures, errorVariants, eventSignatures, handlerSignature, helperSignatures } from './codegen.js';

const TARGET_DIR = new URL('../../../targets/cosmwasm/', import.meta.url);
export const primer = (): string => readFileSync(new URL('primer.md', TARGET_DIR), 'utf8');
export const workedExample = (): string => readFileSync(new URL('example.md', TARGET_DIR), 'utf8');

export const SYSTEM = `You are an expert CosmWasm (Rust) engineer porting one Solidity function at a time into an existing CosmWasm 2.2 contract.
Be faithful: keep every check, the order of checks and effects, the arithmetic semantics (no silent overflow, no silent narrowing) and the events. Do not invent features. Do not drop zero-address or access-control checks. Where CosmWasm cannot express something exactly, implement the closest equivalent and add a comment starting with \`DEVIATION:\`. ${FAIL_CLOSED_PROMPT}
Storage, messages, errors, events and helper functions are already generated; use only the names listed in the prompt and described in the primer, never invent a method, type or import.
The project has no network access when compiled, so use only what is described.

${primer()}

${workedExample()}

Output format (strict). For the handler you are asked about, reply with exactly:

=== BODY: <unit_name> ===
<the statements of the function body, 4-space indented, last expression Ok(...)>
=== END BODY ===
FIDELITY <unit_name>: <one or two sentences: what you kept, what you changed or could not translate>

Nothing else (no markdown fences, no explanation).`;

export interface SourceLookup { text(range: { file: string; start: number; length: number }): string }

export function sourceLookup(sources: Record<string, string>): SourceLookup {
  const bufs = new Map<string, Buffer>();
  return { text: (r) => { if (!bufs.has(r.file)) bufs.set(r.file, Buffer.from(sources[r.file] ?? '', 'utf8')); return bufs.get(r.file)!.subarray(r.start, r.start + r.length).toString('utf8'); } };
}

export function handlerFunction(spec: ContractSpec, h: HandlerD): FunctionSpec | null {
  if (h.kind === 'instantiate') return spec.constructor;
  if (h.solidity === 'receive') return spec.functions.find((f) => f.kind === 'receive') ?? null;
  return spec.functions.find((f) => f.name === h.solidity && f.kind === 'function') ?? null;
}

export function handlerPrompt(spec: ContractSpec, design: CwDesign, h: HandlerD, src: SourceLookup): string {
  const { variants } = errorVariants(spec);
  const fn = handlerFunction(spec, h);
  const L: string[] = [];
  L.push(`Handler to implement: \`${h.unit}\` (Solidity: ${h.solidity === 'constructor' ? 'constructor' : h.solidity === 'receive' ? 'receive()' : `function ${h.solidity}`}).`);
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
  L.push('', 'Generated Rust signature (already exists, do not repeat it; your text is the body inside the braces):', '```rust', handlerSignature(h) + ' { ... }', '```');
  const args = h.args.filter((a) => a.src >= 0).map((a) => `  - ${a.name}: ${a.t.handler}   (Solidity ${a.solidity}${a.note ? `; ${a.note}` : ''})`);
  L.push('', 'Arguments (in scope as variables):', args.length ? args.join('\n') : '  (none)');
  if (h.returns) L.push('', h.returns.single ? `This is a query returning \`${h.returns.rust}\` (Solidity ${h.returns.fields[0]!.solidity}); end with Ok(value).` : `This is a query returning the struct \`${h.returns.struct} { ${h.returns.fields.map((f) => `${f.name}: ${f.t.msg}`).join(', ')} }\` (Solidity returns ${h.returns.fields.map((f) => f.solidity).join(', ')}); end with Ok(${h.returns.struct} { .. }).`);
  L.push('', 'State accessors (call with `deps.storage`; a missing entry reads as the Solidity default):', ...accessorSignatures(design).map((s) => `  ${s}`));
  if (design.structs.length) { L.push('', 'Structs (public fields, `Default` = all zero):'); for (const s of design.structs) L.push(`  struct ${s.name} { ${s.fields.map((f) => `${f.name}: ${f.t.handler}`).join(', ')} }`); }
  L.push('', 'Helpers (already imported):', ...helperSignatures(design).map((s) => `  ${s}`));
  const evs = spec.events.filter((e) => h.emits.includes(e.name));
  if (evs.length) { const sigs = eventSignatures(spec); L.push('', 'Events you emit (Response::add_event):'); for (const e of evs) L.push(`  ${sigs[spec.events.indexOf(e)]}`); }
  L.push('', 'Error variants (use ContractError::<Variant> {}):', variants.map((v) => `  ${v.name} = "${v.msg}"`).join('\n'));
  if (design.constants.length) L.push('', 'Solidity constants (inline them, they are not stored):', ...design.constants.map((c) => `  ${c.solidity} = ${c.value ?? '(see source)'}`));
  if (design.tokens.length) L.push('', `ERC-20 tokens this contract calls: ${design.tokens.map((t) => `${t.solidity}${t.stateName ? ` (address in get_${t.stateName}(deps.storage)?)` : ''}`).join(', ')}; they are cw20 contracts.`);
  if (h.requires.length) L.push('', 'Checks the Solidity performs (keep them, in this order):', ...h.requires.map((r) => `  - ${r}`));
  if (h.notes.length) L.push('', 'Design notes:', ...h.notes.map((n) => `  - ${n}`));
  L.push('', 'Reply in the strict output format.');
  return L.join('\n');
}

// ------------------------------------------------------------------ repair

/** Hints for common rustc errors, appended to the repair prompt when the error code is present in the log. */
export const HINTS: { re: RegExp; hint: string }[] = [
  { re: /E0382/, hint: 'E0382 use after move: an Addr, String, Binary or struct was moved. Borrow it (`&x`) or `.clone()` it. `Uint256` is Copy and never needs a clone; `info.sender` should be used as `&info.sender`.' },
  { re: /E0308/, hint: 'E0308 mismatched types: Uint256 and u128/u64 are different types (`Uint256::from(x)` widens, `to_u128(x)?` / `to_u64(x)?` narrow). Setters take a reference (`set_x(deps.storage, &key, &value)?`), getters return the value. A handler ends with `Ok(Response::new()...)` (execute) or `Ok(value)` of the exact return type shown (query). Addresses returned from a query are `String`.' },
  { re: /E0599/, hint: 'E0599 no such method/variant: use only the accessors, helpers, events and ContractError variants listed in the prompt. Uint256 has checked_add/checked_sub/checked_mul/checked_div/checked_pow, is_zero(), min/max; Addr has as_str()/to_string() (no arithmetic); a Response has add_message/add_messages/add_event/add_attribute.' },
  { re: /E0432|E0433|E0412|E0425/, hint: 'unresolved name or import: do not add `use` lines (the generated header imports `cosmwasm_std::*`, `crate::helpers::*`, `crate::state::*`, `crate::msg::*`, `ContractError`, `events`); only use names from the prompt.' },
  { re: /E0277/, hint: 'E0277 trait bound: usually `?` on something that is not a Result of a convertible error, or comparing different integer types, or `+`/`-` on Uint256 (use checked_add/checked_sub with `?`). `Option` needs `.ok_or(ContractError::Variant {})?`.' },
  { re: /E0502|E0499|E0505|E0506/, hint: 'borrow checker: copy the values you need into locals before calling a setter with `deps.storage`; do not hold a reference into `deps` across a `set_*` call.' },
  { re: /E0614|E0609|E0610/, hint: 'field/deref error: structs returned by `get_x` are owned values with public fields (`t.executed = true;` on a `let mut t`); integers and Uint256 are not dereferenced with `*` unless they are references.' },
  { re: /E0061|E0107/, hint: 'wrong number of arguments: check the accessor/helper/event signature in the prompt (events take every field in order, keys of maps are passed as separate arguments).' },
  { re: /E0603|E0616/, hint: 'private item: only use the public names listed in the prompt.' },
];

export function firstErrorBlocks(log: string, maxBlocks = 6, maxChars = 6000): string {
  const blocks: string[] = [];
  let cur: string[] | null = null;
  for (const l of log.split('\n')) {
    if (/^error(\[E\d+\])?:/.test(l) && !/^error: could not compile/.test(l) && !/^error: aborting/.test(l)) { if (cur) blocks.push(cur.join('\n')); cur = [l]; }
    else if (cur) { if (/^warning/.test(l)) { blocks.push(cur.join('\n')); cur = null; } else cur.push(l); }
  }
  if (cur) blocks.push(cur.join('\n'));
  const out = blocks.slice(0, maxBlocks).join('\n\n');
  return out.length > maxChars ? out.slice(0, maxChars) + '\n...[truncated]...' : out;
}

export function hintsFor(log: string): string[] { return HINTS.filter((h) => h.re.test(log)).map((h) => h.hint); }

/** Which handler files a rustc log points at. */
export function failingHandlers(log: string, design: CwDesign): { handlers: Set<string>; other: boolean } {
  const handlers = new Set<string>();
  let other = false;
  for (const m of log.matchAll(/^\s*--> (src\/[^:]+):(\d+)/gm)) {
    const h = /handlers\/(\w+)\.rs$/.exec(m[1]!);
    if (h && design.instructions.some((i) => i.unit === h[1] && !i.generated)) handlers.add(h[1]!);
    else other = true;
  }
  return { handlers, other };
}

export function repairPrompt(h: HandlerD, currentBody: string, errorText: string, extra: string[]): string {
  return [
    `The handler body you wrote for \`${h.unit}\` does not compile. The generated file is the signature \`${handlerSignature(h)}\` wrapping your body.`,
    '', 'Your current body:', '```rust', currentBody, '```', '', 'Compiler errors (first ones only):', '```', errorText, '```',
    ...(extra.length ? ['', 'Hints:', ...extra.map((x) => `- ${x}`)] : []),
    '', 'Return the corrected body in the strict format (=== BODY: ... === END BODY === and the FIDELITY line). Keep all behaviour; fix the errors only.',
  ].join('\n');
}

export function behaviourRepairPrompt(h: HandlerD, currentBody: string, problems: string[]): string {
  return [
    `The handler for \`${h.unit}\` compiles, but running it does not behave like the original Solidity contract. Observed differences (the Solidity result is ground truth):`,
    ...problems.map((p) => `- ${p}`),
    '', 'Your current body:', '```rust', currentBody, '```',
    '', 'Fix the logic so the CosmWasm behaviour matches (same success/revert decisions, same resulting state). Keep missing-key reads going through the generated accessors (never a failing load). Do not change the signature. Return the corrected body in the strict format.',
  ].join('\n');
}
