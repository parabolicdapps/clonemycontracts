import { FAIL_CLOSED_PROMPT } from '../../spec/guards.js';
import { readFileSync } from 'node:fs';
import type { ContractSpec, FunctionSpec } from '../../types.js';
import { FILE_FORMAT } from '../../llm/files.js';
import type { InstructionDesign, SolanaDesign } from './design-types.js';
import { errorVariants, handlerSignature, structName, roleDoc } from './codegen.js';
import { rustType } from './design.js';

const TARGET_DIR = new URL('../../../targets/solana/', import.meta.url);
export const primer = (): string => readFileSync(new URL('primer.md', TARGET_DIR), 'utf8');
export const workedExample = (): string => readFileSync(new URL('example.md', TARGET_DIR), 'utf8');

export const SYSTEM = `You are an expert Solana/Anchor engineer porting one Solidity function at a time to an existing Anchor 1.2.2 program.
Be faithful: keep every check, the order of checks and effects, the arithmetic semantics (no silent overflow) and the events. Do not invent features. Where Solana cannot express something exactly, implement the closest equivalent and add a comment starting with \`DEVIATION:\`. ${FAIL_CLOSED_PROMPT}
Token logic (transfers, vaults, mints) is already delegated to SPL through the provided helpers; never re-implement balances of a token.
The project has no network access when compiled, so use only what is imported and the primer describes.

${primer()}

${workedExample()}

Output format (strict). For the instruction you are asked about, reply with exactly:

=== BODY: <instruction_name> ===
<the statements of the function body, 4-space indented, last statement Ok(...)>
=== END BODY ===
FIDELITY <instruction_name>: <one or two sentences: what you kept, what you changed or could not translate>

Nothing else (no markdown fences, no explanation).`;

export interface SourceLookup { text(range: { file: string; start: number; length: number }): string }

export function sourceLookup(sources: Record<string, string>): SourceLookup {
  const bufs = new Map<string, Buffer>();
  return { text: (r) => { if (!bufs.has(r.file)) bufs.set(r.file, Buffer.from(sources[r.file] ?? '', 'utf8')); return bufs.get(r.file)!.subarray(r.start, r.start + r.length).toString('utf8'); } };
}

function stateSummary(design: SolanaDesign): string {
  const L: string[] = [];
  for (const a of design.accounts) {
    L.push(`struct ${a.name} (${a.role}${a.keys.length ? `, PDA seeds [b"${a.seedPrefix}", ${a.keys.map((k) => k.rust).join(', ')}]` : ', PDA seeds [b"config"]'}):`);
    for (const f of a.fields) if (f.name !== 'bump' || a.role === 'config') L.push(`  pub ${f.name}: ${f.rust},   // ${f.source}${f.note ? ` - ${f.note}` : ''}`);
  }
  return L.join('\n');
}

export function instructionPrompt(spec: ContractSpec, design: SolanaDesign, ins: InstructionDesign, src: SourceLookup): string {
  const { variants } = errorVariants(spec);
  const fn: FunctionSpec | null = ins.kind === 'initialize' ? spec.constructor : spec.functions.find((f) => (ins.kind === 'receive' ? f.kind === 'receive' : f.name === ins.solidity && f.kind === 'function')) ?? null;
  const L: string[] = [];
  L.push(`Instruction to implement: \`${ins.name}\` (Solidity: ${ins.solidity === 'constructor' ? 'constructor' : ins.solidity === 'receive' ? 'receive()' : `function ${ins.solidity}`}).`);
  if (fn) {
    L.push('', 'Original Solidity:', '```solidity', src.text(fn.range).trim(), '```');
    const helpers = new Set<string>();
    for (const c of fn.calls) {
      if (c.startsWith('modifier:') && /nonReentrant/i.test(c)) { if (!helpers.has(c)) { helpers.add(c); L.push('', `Modifier ${c.slice(9)} is a reentrancy guard: do NOT implement it and do NOT touch its state variable (it is not stored on Solana; see the design notes).`); } }
      else if (c.startsWith('modifier:')) { const m = spec.modifiers.find((x) => x.name === c.slice(9)); if (m && !helpers.has(c)) { helpers.add(c); L.push('', `Modifier ${m.name} (applied before/after the body):`, '```solidity', src.text(m.range).trim(), '```'); } }
      else { const h = spec.functions.find((f) => f.name === c && f !== fn); if (h && !helpers.has(c)) { helpers.add(c); L.push('', `Internal function ${c} that it calls (inline its logic):`, '```solidity', src.text(h.range).trim(), '```'); } }
    }
  }
  L.push('', 'Generated Rust you must fit into (already exists, do not repeat it):', '```rust', handlerSignature(ins) + ' { ... }', '```');
  L.push('', `Accounts (\`ctx.accounts.<name>\`) of ${structName(ins)}:`);
  for (const r of ins.accounts) L.push(`  - ${r.name}: ${roleDoc(r)}${r.state ? ` of struct ${r.state}` : ''}${r.token ? ` (token ${r.token})` : ''}${r.note ? ` - ${r.note}` : ''}`);
  L.push('', 'State structs:', stateSummary(design));
  const evs = spec.events.filter((e) => ins.emits.includes(e.name));
  if (evs.length) { L.push('', 'Events you can emit (already defined):'); for (const e of evs) L.push(`  ${e.name} { ${e.params.map((p) => `${p.name || 'value'}: ${rustType(p.type)}`).join(', ')} }`.replace(/\{ ([^}]*) \}/, (_m, g) => `{ ${g.replace(/\b([a-z]\w*(?:[A-Z]\w*)+)\b/g, (x: string) => x.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase())} }`)); }
  L.push('', 'Error variants (use AppError::<Variant>):', variants.map((v) => `  ${v.name} = "${v.msg}"`).join('\n'));
  if (ins.requires.length) L.push('', 'Checks the Solidity performs (keep them, in this order):', ...ins.requires.map((r) => `  - ${r}`));
  if (ins.notes.length) L.push('', 'Design notes:', ...ins.notes.map((n) => `  - ${n}`));
  const args = ins.args.map((a) => `  - ${a.name}: ${a.rust}${a.note ? ` (${a.note})` : ''}`);
  L.push('', 'Instruction arguments (already in scope as variables):', args.length ? args.join('\n') : '  (none)');
  if (ins.returns) L.push('', `This is a view: the handler returns Result<${ins.returns.rust}>; end with Ok(value).`);
  L.push('', 'Reply in the strict output format.');
  return L.join('\n');
}

// ------------------------------------------------------------------ repair

/** Hints for common rustc/Anchor errors, appended to the repair prompt when the error code is present in the log. */
export const HINTS: { re: RegExp; hint: string }[] = [
  { re: /E0382/, hint: 'E0382 use after move: the value was moved (e.g. a non-Copy struct or Pubkey passed by value). Use `.clone()` or pass a reference (`&x`); for Pubkey use `.key()` / it is Copy.' },
  { re: /E0308/, hint: 'E0308 mismatched types: state numbers are u128 (or the narrower declared width), instruction args use the types shown; convert with `u128::from(x)` (widening) or `u64::try_from(x).map_err(|_| error!(AppError::Overflow))?` (narrowing). `require!` takes a bool and an error variant. A function returning Result<()> must end with `Ok(())`.' },
  { re: /E0716/, hint: 'E0716 temporary value dropped: bind the temporary to a `let` first (e.g. `let key = ctx.accounts.caller.key();` then use `key.as_ref()`).' },
  { re: /E0499|E0502|E0505|E0506/, hint: 'borrow checker: do not hold `&mut ctx.accounts.a` while reading or borrowing `ctx.accounts.b`/`ctx.accounts` again; copy the numbers you need into locals, finish the mutable use, then call helpers.' },
  { re: /E0599/, hint: 'E0599 no method/variant: only use the helpers, fields and AppError variants listed; integers have checked_add/checked_sub/checked_mul/checked_div; Pubkey has `.key()` only on accounts (a Pubkey value is already the key).' },
  { re: /E0425|E0433|E0412/, hint: 'unresolved name: use only the arguments, `ctx.accounts.<name>` fields, `helpers::*`, `AppError::*`, event structs and state structs that were listed; modules are already imported.' },
  { re: /E0277/, hint: 'E0277 trait bound: you probably compared/added different integer types, or used `?` on a non-Result. Convert integer widths explicitly; `.ok_or(AppError::Overflow)?` turns Option into Result.' },
  { re: /E0614|E0609|E0610/, hint: 'field/deref error: accounts hold their data directly (`ctx.accounts.config.total`); Pubkey and integers are not dereferenced with `*` unless they are references.' },
  { re: /ConstraintSeeds|ConstraintAddress|ConstraintTokenOwner|AccountNotInitialized/, hint: 'account constraint errors come from the generated accounts struct; do not try to fix them in the body unless the body passes wrong accounts to a helper.' },
];

export function trimLog(log: string, headChars = 6000, tailChars = 2500): string {
  const lines = log.split('\n').filter((l) => !/^\s*(Compiling|Downloaded|Downloading|Finished|Fresh|Blocking|Locking|Updating)\b/.test(l));
  const t = lines.join('\n');
  return t.length <= headChars + tailChars ? t : t.slice(0, headChars) + '\n...[truncated]...\n' + t.slice(-tailChars);
}

/** Keep only the first error blocks (rustc prints each error as a block starting with `error`). */
export function firstErrorBlocks(log: string, maxBlocks = 6, maxChars = 6000): string {
  const lines = log.split('\n');
  const blocks: string[] = [];
  let cur: string[] | null = null;
  for (const l of lines) {
    if (/^error(\[E\d+\])?:/.test(l) && !/^error: could not compile/.test(l)) { if (cur) blocks.push(cur.join('\n')); cur = [l]; }
    else if (cur) { if (/^warning/.test(l)) { blocks.push(cur.join('\n')); cur = null; } else cur.push(l); }
  }
  if (cur) blocks.push(cur.join('\n'));
  const out = blocks.slice(0, maxBlocks).join('\n\n');
  return out.length > maxChars ? out.slice(0, maxChars) + '\n...[truncated]...' : out;
}

export function hintsFor(log: string): string[] { return HINTS.filter((h) => h.re.test(log)).map((h) => h.hint); }

/** Which instruction handler files a rustc log points at. */
export function failingHandlers(log: string, design: SolanaDesign): { handlers: Set<string>; other: boolean } {
  const handlers = new Set<string>();
  let other = false;
  for (const m of log.matchAll(/^\s*--> (programs\/app\/src\/[^:]+):(\d+)/gm)) {
    const h = /logic\/(\w+)\.rs$/.exec(m[1]!);
    if (h && design.instructions.some((i) => i.name === h[1])) handlers.add(h[1]!);
    else other = true;
  }
  return { handlers, other };
}

export function repairPrompt(ins: InstructionDesign, currentBody: string, errorText: string, extra: string[]): string {
  return [
    `The handler body you wrote for \`${ins.name}\` does not compile. The generated file is the signature \`${handlerSignature(ins)}\` wrapping your body.`,
    '', 'Your current body:', '```rust', currentBody, '```', '', 'Compiler errors (first ones only):', '```', errorText, '```',
    ...(extra.length ? ['', 'Hints:', ...extra.map((h) => `- ${h}`)] : []),
    '', 'Return the corrected body in the strict format (=== BODY: ... === END BODY === and the FIDELITY line). Keep all behaviour; fix the errors only.',
  ].join('\n');
}

export function behaviourRepairPrompt(ins: InstructionDesign, currentBody: string, problems: string[]): string {
  return [
    `The handler for \`${ins.name}\` compiles, but running it on Solana does not behave like the original Solidity contract. Observed differences (the Solidity result is ground truth):`,
    ...problems.map((p) => `- ${p}`),
    '', 'Your current body:', '```rust', currentBody, '```',
    '', 'Fix the logic so the Solana behaviour matches (same success/revert decisions, same resulting state). Do not change the signature. Return the corrected body in the strict format.',
  ].join('\n');
}

export { FILE_FORMAT };
