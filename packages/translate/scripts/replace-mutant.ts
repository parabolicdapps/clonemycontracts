// usage: vite-node scripts/replace-mutant.ts <solana|cosmwasm|aptos|tezos> <rewrite-out-dir> <project-file> <regex> <replacement>
// Re-injects a bug (for example the wrong reward formula `(balance - paid) * rpt` instead of `balance * (rpt - paid)`) into a generated project,
// recompiles it and runs the SAME scenarios; the behaviour check must now FAIL. Prints a JSON summary; exit 1 when the mutant survives.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTree } from '../src/pipeline/container.js';
import { SolanaPack } from '../src/targets/solana/pack.js';
import { CosmWasmPack } from '../src/targets/cosmwasm/pack.js';
import { AptosPack } from '../src/targets/aptos/pack.js';
import { TezosPack } from '../src/targets/tezos/pack.js';

const [target, dir, file, re, rep] = process.argv.slice(2) as [string, string, string, string, string];
const spec = JSON.parse(readFileSync(join(dir, 'spec.json'), 'utf8'));
const design = JSON.parse(readFileSync(join(dir, 'design.json'), 'utf8'));
const set = JSON.parse(readFileSync(join(dir, 'scenarios.json'), 'utf8'));
const files = Object.fromEntries(Object.entries(readTree(join(dir, 'project'))).map(([k, v]) => [k, v.toString('utf8')]));
const pack = target === 'solana' ? new SolanaPack() : target === 'cosmwasm' ? new CosmWasmPack() : target === 'aptos' ? new AptosPack() : new TezosPack();
const before = files[file];
if (before === undefined) throw new Error(`no such project file ${file}`);
const after = before.replace(new RegExp(re, 'g'), rep);
if (after === before && !process.env.BASELINE) { console.log(JSON.stringify({ target, verdict: 'NO-MATCH', file, regex: re })); process.exit(2); }
files[file] = after;
const compiled = await pack.compile(files);
if (!compiled.ok) { console.log(JSON.stringify({ target, verdict: 'MUTANT-DOES-NOT-COMPILE', log: compiled.log.split('\n').filter((l) => /^error|error\[/.test(l)).slice(0, 5) })); process.exit(3); }
const run = await pack.runScenarios(files, compiled, design, spec, set);
const failed = run.outcomes.filter((o) => o.status === 'failed');
const exitFailures = failed.filter((o) => !process.env.FN || o.fn === process.env.FN).slice(0, 6).map((o) => ({ id: o.id, at: o.mismatches[0]?.at, what: String(o.mismatches[0]?.what).slice(0, 70), expected: String(o.mismatches[0]?.expected).slice(0, 70), actual: String(o.mismatches[0]?.actual).slice(0, 90) }));
console.log(JSON.stringify({ target, file, scenarios: run.outcomes.length, exitFailures, passed: run.outcomes.filter((o) => o.status === 'passed').length, failed: failed.length, failedIds: failed.slice(0, 8).map((o) => o.id), first: failed[0]?.mismatches[0] ?? null, verdict: failed.length ? 'KILLED' : 'SURVIVED' }));
process.exit(failed.length ? 0 : 1);
