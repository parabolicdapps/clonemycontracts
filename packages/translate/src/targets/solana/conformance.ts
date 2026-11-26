import type { SolanaDesign } from './design-types.js';
import { snake } from './design.js';

const norm = (s: string) => s.replace(/_/g, '').toLowerCase();

function idlTypeToRust(t: any): string {
  if (typeof t === 'string') return t === 'pubkey' ? 'Pubkey' : t === 'bytes' ? 'Vec<u8>' : t === 'string' ? 'String' : t;
  if (t === 'bytes') return 'Vec<u8>';
  if (t?.array) return `[${idlTypeToRust(t.array[0])}; ${t.array[1]}]`;
  if (t?.vec) return `Vec<${idlTypeToRust(t.vec)}>`;
  return JSON.stringify(t);
}

/** Compare the Anchor IDL of the built program with the design. Returns human readable problems (empty = conformant). */
export function checkConformance(idl: any, design: SolanaDesign): string[] {
  const problems: string[] = [];
  const ixs: any[] = idl?.instructions ?? [];
  for (const d of design.instructions) {
    const ix = ixs.find((x) => norm(x.name) === norm(d.name));
    if (!ix) { problems.push(`instruction \`${d.name}\` is missing from the IDL`); continue; }
    const idlArgs: any[] = ix.args ?? [];
    if (idlArgs.length !== d.args.length) problems.push(`\`${d.name}\`: expected ${d.args.length} arguments (${d.args.map((a) => a.name).join(', ')}), IDL has ${idlArgs.length} (${idlArgs.map((a) => a.name).join(', ')})`);
    else d.args.forEach((a, i) => {
      if (norm(a.name) !== norm(idlArgs[i].name)) problems.push(`\`${d.name}\`: argument ${i} should be \`${a.name}\`, IDL has \`${idlArgs[i].name}\``);
      else if (idlTypeToRust(idlArgs[i].type) !== a.rust) problems.push(`\`${d.name}\`: argument \`${a.name}\` should be ${a.rust}, IDL has ${idlTypeToRust(idlArgs[i].type)}`);
    });
    const idlAccs: any[] = ix.accounts ?? [];
    for (const r of d.accounts) {
      const ia = idlAccs.find((x) => norm(x.name) === norm(r.name));
      if (!ia) { problems.push(`\`${d.name}\`: account \`${r.name}\` is missing from the IDL`); continue; }
      if (r.kind === 'entry' || r.kind === 'config') {
        const st = design.accounts.find((a) => a.name === r.state);
        const first = ia.pda?.seeds?.[0];
        const prefix = st?.seedPrefix ?? 'config';
        if (!first || first.kind !== 'const' || Buffer.from(first.value).toString() !== prefix) problems.push(`\`${d.name}\`: account \`${r.name}\` must be a PDA whose first seed is b"${prefix}"`);
        else if (ia.pda.seeds.length !== 1 + (r.keys?.length ?? 0)) problems.push(`\`${d.name}\`: account \`${r.name}\` must have ${1 + (r.keys?.length ?? 0)} seeds`);
      }
    }
  }
  for (const a of design.accounts) if (!(idl?.accounts ?? []).some((x: any) => x.name === a.name)) problems.push(`account type \`${a.name}\` is missing from the IDL`);
  void snake;
  return problems;
}
