// usage: vite-node scripts/cosmwasm-mutant.ts <rewrite-out-dir>   "load instead of may_load": every generated map/item getter fails with NotFound on a missing key (the bug that made a benchmark multisig unusable)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CosmWasmPack } from '../src/targets/cosmwasm/pack.js';
import { readTree } from '../src/pipeline/container.js';

const dir = process.argv[2]!;
const spec = JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8'));
const design = JSON.parse(readFileSync(join(dir, 'design.json'), 'utf8'));
const set = JSON.parse(readFileSync(join(dir, 'scenarios.json'), 'utf8'));
const files = Object.fromEntries(Object.entries(readTree(join(dir, 'project'))).map(([k, v]) => [k, v.toString('utf8')]));
const st = files['src/state.rs']!;
const re = /(\w+)\.may_load\((storage, (?:\([^)]*\)|[^)])*)\)\?\.unwrap_or_else\(\|\| (?:[^()]|\(\))*\)/g;
const mutated = st.replace(re, '$1.load($2)?');
if (mutated === st) throw new Error('mutation did not apply');
console.log(`mutated ${(st.match(re) ?? []).length} getters`);
files['src/state.rs'] = mutated;
const pack = new CosmWasmPack();
const c = await pack.compile(files);
console.log('mutant compiles:', c.ok); if (!c.ok) console.log(c.log.split('\n').filter((l) => /^error/.test(l)).slice(0, 5).join('\n'));
const run = await pack.runScenarios(files, c, design, spec, set);
const failed = run.outcomes.filter((o) => o.status === 'failed');
console.log(`scenarios: ${run.outcomes.length}, failed ${failed.length}, passed ${run.outcomes.filter((o) => o.status === 'passed').length}, not runnable ${run.outcomes.filter((o) => o.status === 'not-runnable').length}`);
for (const f of failed.slice(0, 5)) console.log(f.id, JSON.stringify(f.mismatches[0]).slice(0, 240));
