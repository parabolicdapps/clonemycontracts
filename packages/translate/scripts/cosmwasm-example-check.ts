// usage: vite-node scripts/cosmwasm-example-check.ts   compiles targets/cosmwasm/example.md's bodies on the CosmwasmLocker fixture
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { load } from '../test/helpers.js';
import { buildDesign } from '../src/targets/cosmwasm/design.js';
import { assembleProject } from '../src/targets/cosmwasm/project.js';
import { workedExample } from '../src/targets/cosmwasm/prompts.js';
import { DEFAULT_CONTAINER, runToolchain } from '../src/pipeline/container.js';

const { spec } = await load('CosmwasmLocker');
const design = buildDesign(spec);
const bodies: Record<string, string> = {};
for (const m of workedExample().matchAll(/=== BODY: (\w+) ===\n([\s\S]*?)\n=== END BODY ===/g)) bodies[m[1]!] = m[2]!;
const missing = design.instructions.filter((h) => !h.generated && !bodies[h.unit]).map((h) => h.unit);
console.log('bodies', Object.keys(bodies).join(', '), 'missing:', missing.join(', ') || 'none');
const files = assembleProject(spec, design, bodies);
const out = process.argv[2];
if (out) for (const [p, b] of Object.entries(files)) { const fp = join(out, p); mkdirSync(dirname(fp), { recursive: true }); writeFileSync(fp, b); }
const r = await runToolchain({ ...DEFAULT_CONTAINER, image: process.env.CMC_COSMWASM_IMAGE ?? 'cmc-toolchain-cosmwasm:0.1' }, 'compile', files, {});
console.log('exit', r.code, `${r.seconds.toFixed(0)}s`);
console.log(r.log.split('\n').filter((l) => !/^\s*(Compiling|Downloaded|Fresh)/.test(l)).slice(-50).join('\n'));
void readFileSync;
