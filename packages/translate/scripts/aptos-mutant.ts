// usage: vite-node scripts/aptos-mutant.ts <rewrite-out-dir> <mutant>: applies a deliberate bug to the saved (passing) Aptos rewrite and re-runs compile + all scenarios (no model)
// mutants: drop-acl (remove the first `assert!(signer::address_of(caller) == ..., E_NOT_*)` of the named function), ignore-cliff (a vesting limit treated as unlimited)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AptosPack } from '../src/targets/aptos/pack.js';
import { readTree } from '../src/pipeline/container.js';
const [dir, mutant, fn = 'revoke'] = [process.argv[2]!, process.argv[3]!, process.argv[4]];
const spec = JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8'));
const set = JSON.parse(readFileSync(join(dir, 'scenarios.json'), 'utf8'));
const design = JSON.parse(readFileSync(join(dir, 'design.json'), 'utf8'));
const files = Object.fromEntries(Object.entries(readTree(join(dir, 'project'))).map(([k, v]) => [k, v.toString('utf8')]));
const f = `sources/${design.moduleName}.move`;
let src = files[f]!;
if (mutant === 'drop-acl') {
  const start = src.indexOf(`<<unit ${fn}>>`); const end = src.indexOf(`<<end ${fn}>>`);
  const seg = src.slice(start, end);
  const m = /^\s*assert!\(signer::address_of\(caller\) == [^\n]*E_NOT_\w+\);\n/m.exec(seg);
  if (!m) throw new Error(`no access-control assert found in ${fn}`);
  console.log(`removing from ${fn}: ${m[0].trim()}`);
  src = src.slice(0, start) + seg.replace(m[0], '') + src.slice(end);
} else if (mutant === 'ignore-cliff') {
  const m = /if \(now < get_cliff\(\)\) \{\s*\n?\s*0u256|if \(now < cliff\) \{ return 0 \};/.exec(src);
  if (!m) throw new Error('cliff check not found');
  console.log(`removing: ${m[0]}`);
  src = src.replace(/if \(now < cliff\) \{ return 0 \};\n/, '').replace(/if \(now < get_cliff\(\)\) \{\s*\n\s*0u256\s*\n\s*\} else if/g, 'if');
} else throw new Error('unknown mutant');
files[f] = src;
const pack = new AptosPack();
const c = await pack.compile(files);
console.log('mutant compiles:', c.ok);
if (!c.ok) { console.log(c.log.slice(0, 1500)); process.exit(1); }
const run = await pack.runScenarios(files, c, design, spec, set);
const n = (s: string) => run.outcomes.filter((o) => o.status === s).length;
console.log(`scenarios ${run.outcomes.length}: passed ${n('passed')}, failed ${n('failed')}, not runnable ${n('not-runnable')}, documented ${n('documented-difference')}`);
for (const o of run.outcomes.filter((x) => x.status === 'failed')) console.log('FAILED', o.id, '|', o.title, '|', JSON.stringify(o.mismatches[0]).slice(0, 220));
