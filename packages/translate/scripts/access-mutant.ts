// usage: vite-node scripts/access-mutant.ts <solana|cosmwasm|aptos|tezos> <rewrite-out-dir> "<revert message of the access check>" [function]
// Mutation test for access control: remove EVERY statement of the rewrite that enforces the given check (found by its error name / message in
// the handler files), recompile, run the SAME scenarios again and require that the behaviour check now FAILS (the unprivileged-caller scenario
// must notice that the call no longer reverts). Prints a JSON summary line and exits 1 when the mutant survives.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTree } from '../src/pipeline/container.js';
import { SolanaPack } from '../src/targets/solana/pack.js';
import { CosmWasmPack } from '../src/targets/cosmwasm/pack.js';
import { AptosPack } from '../src/targets/aptos/pack.js';
import { TezosPack } from '../src/targets/tezos/pack.js';

const [target, dir, message, fn] = process.argv.slice(2) as [string, string, string, string | undefined];
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
// error constants are truncated on some targets (Aptos: 40 characters), so the first 28 alphanumerics identify the check
const want = norm(message).slice(0, 28);
const spec = JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8'));
const design = JSON.parse(readFileSync(join(dir, 'design.json'), 'utf8'));
const set = JSON.parse(readFileSync(join(dir, 'scenarios.json'), 'utf8'));
const files = Object.fromEntries(Object.entries(readTree(join(dir, 'project'))).map(([k, v]) => [k, v.toString('utf8')]));
const pack = target === 'solana' ? new SolanaPack() : target === 'cosmwasm' ? new CosmWasmPack() : target === 'aptos' ? new AptosPack() : new TezosPack();
const handlerFile = (p: string) => (target === 'solana' ? /programs\/app\/src\/logic\/.*\.rs$/ : target === 'cosmwasm' ? /src\/handlers\/.*\.rs$/ : target === 'aptos' ? /sources\/.*\.move$/ : /contract_def\.py$/).test(p);

/** remove the statement that contains line i (a one-line require/assert, or an `if ... { ... }` / `if ...:` block) */
export function removeStatement(lines: string[], i: number): [number, number] {
  const braces = target !== 'tezos';
  let a = i;
  const t = (k: number) => lines[k]!.trim();
  if (braces) {
    // walk up to the `if` that opens the block when the line is inside one
    let depth = 0;
    for (let k = i; k >= Math.max(0, i - 6); k--) {
      depth += (lines[k]!.match(/\}/g) ?? []).length - (lines[k]!.match(/\{/g) ?? []).length;
      if (/^(if|else if)\b/.test(t(k)) && /\{\s*$/.test(t(k)) && depth <= 0) { a = k; break; }
    }
    let b = a;
    if (/^(if|else if)\b/.test(t(a)) && /\{\s*$/.test(t(a))) {
      let d = 0;
      for (let k = a; k < lines.length; k++) { d += (lines[k]!.match(/\{/g) ?? []).length - (lines[k]!.match(/\}/g) ?? []).length; if (d <= 0) { b = k; break; } }
    } else { while (b < lines.length - 1 && !/[;{}]\s*(\/\/.*)?$/.test(t(b))) b++; a = i; while (a > 0 && !/[;{}]\s*(\/\/.*)?$/.test(t(a - 1)) && /^[\s)\w.,!&|<>=:"-]+$/.test(t(a - 1))) a--; }
    return [a, b];
  }
  const ind = (k: number) => lines[k]!.length - lines[k]!.trimStart().length;
  if (/^assert\b/.test(t(i))) return [i, i];
  let k = i; while (k > 0 && !/^(if|elif)\b/.test(t(k))) { if (ind(k - 1) < ind(i)) { k--; break; } k--; }
  let b = k; while (b + 1 < lines.length && (t(b + 1) === '' || ind(b + 1) > ind(k))) b++;
  return [k, b];
}

let removed = 0; const touched: string[] = [];
for (const [p, text] of Object.entries(files)) {
  if (!handlerFile(p)) continue;
  let lines = text.split('\n');
  for (let guard = 0; guard < 20; guard++) {
    const i = lines.findIndex((l) => norm(l).includes(want) && !/^\s*(\/\/|#)/.test(l) && !/^\s*(const|pub enum|#\[error)/.test(l));
    if (i < 0) break;
    const [a, b] = removeStatement(lines, i);
    lines = [...lines.slice(0, a), `${target === 'tezos' ? '' : ''}${target === 'tezos' ? '            pass' : '    /* access check removed by the mutation test */'}`, ...lines.slice(b + 1)];
    removed++; if (!touched.includes(p)) touched.push(p);
  }
  files[p] = lines.join('\n');
}
if (!removed) { console.log(JSON.stringify({ target, mutated: 0, verdict: 'NO-GUARD-FOUND', message })); process.exit(2); }
const compiled = await pack.compile(files);
if (!compiled.ok) { console.log(JSON.stringify({ target, mutated: removed, files: touched, compiles: false, verdict: 'MUTANT-DOES-NOT-COMPILE', log: compiled.log.split('\n').filter((l) => /^error|error\[|Error/.test(l)).slice(0, 5) })); process.exit(3); }
const run = await pack.runScenarios(files, compiled, design, spec, set);
const failed = run.outcomes.filter((o) => o.status === 'failed');
const acl = failed.filter((o) => o.kind === 'access' && (!fn || o.fn === fn));
const killed = acl.length > 0;
console.log(JSON.stringify({ target, mutated: removed, files: touched, compiles: true, scenarios: run.outcomes.length, failed: failed.length, aclFailed: acl.map((o) => o.id), verdict: killed ? 'KILLED' : 'SURVIVED', first: acl[0]?.mismatches[0] ?? failed[0]?.mismatches[0] ?? null }));
process.exit(killed ? 0 : 1);
