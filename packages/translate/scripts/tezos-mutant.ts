// usage: vite-node scripts/tezos-mutant.ts <runDir> [lineRegex] [nthMatch=0]
// Takes a passing rewrite (<runDir>/project, spec.json, design.json, scenarios.json), deletes every line of contract_def.py that matches
// lineRegex (default: the first access-control assert `assert sp.sender == ...`) and runs compile + the behaviour check on the mutant.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TezosPack } from '../src/targets/tezos/pack.js';
import type { ContractSpec, ScenarioSet } from '../src/types.js';

const dir = process.argv[2]!;
const re = new RegExp(process.argv[3] ?? '^\\s*assert sp\\.sender == self\\.data\\.(?!deployer)\\w+, ');
const rd = (n: string) => readFileSync(join(dir, n), 'utf8');
const spec = JSON.parse(rd('spec.json')) as ContractSpec;
const design = JSON.parse(rd('design.json'));
const set = JSON.parse(rd('scenarios.json')) as ScenarioSet;
const files: Record<string, string> = { 'contract_def.py': rd('project/contract_def.py'), 'contract.py': rd('project/contract.py') };
const lines = files['contract_def.py']!.split('\n');
const hit = lines.map((l, i) => (re.test(l) ? i : -1)).filter((i) => i >= 0);
if (!hit.length) { console.error('no line matches'); process.exit(2); }
console.log(`${hit.length} matching line(s); mutating #${process.argv[4] ?? 0}:`);
for (const i of hit.slice(0, 3)) console.log(`  ${i + 1}: ${lines[i]!.trim()}`);
// replace by `pass` (keeps the block valid when the assert was the only statement)
const nth = Number(process.argv[4] ?? 0);
for (const i of hit.slice(nth, nth + 1)) lines[i] = lines[i]!.replace(/\S.*$/, 'pass');
files['contract_def.py'] = lines.join('\n');
const pack = new TezosPack();
const c = await pack.compile(files);
console.log('mutant compiles:', c.ok);
if (!c.ok) { console.log(c.log.slice(-1500)); process.exit(3); }
const run = await pack.runScenarios(files, c, design, spec, set);
const failed = run.outcomes.filter((o) => o.status === 'failed');
console.log(`scenarios: ${run.outcomes.filter((o) => o.status === 'passed').length} passed, ${failed.length} failed, ${run.outcomes.filter((o) => o.status === 'not-runnable').length} not runnable`);
for (const f of failed.slice(0, 6)) console.log(`  FAIL ${f.id}: ${f.mismatches[0]?.what} expected ${JSON.stringify(f.mismatches[0]?.expected)} got ${JSON.stringify(f.mismatches[0]?.actual)}`);
