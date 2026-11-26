// usage: vite-node scripts/tezos-example.ts [outDir]   compiles targets/tezos/example.md's bodies on the CosmwasmLocker fixture (and shows normalisations/lint)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { load } from '../test/helpers.js';
import { TezosPack } from '../src/targets/tezos/pack.js';
import { workedExample } from '../src/targets/tezos/prompts.js';

const { spec } = await load('CosmwasmLocker');
const pack = new TezosPack();
const design = pack.design(spec, {});
const bodies: Record<string, string> = {};
for (const m of workedExample().matchAll(/=== BODY: (\w+) ===\n([\s\S]*?)\n=== END BODY ===/g)) bodies[m[1]!] = m[2]!;
const missing = pack.units(design).filter((u) => !bodies[u]);
console.log('bodies', Object.keys(bodies).join(', '), 'missing:', missing.join(', ') || 'none');
const files = pack.assemble(spec, design, bodies);
console.log('lint:', files['cmc/lint.txt'] ?? 'clean', '| normalisations:', JSON.stringify([...pack.normalisations.entries()]));
const r = await pack.compile(files);
const out = process.argv[2];
if (out) for (const [p, b] of Object.entries(files)) { const fp = join(out, p); mkdirSync(dirname(fp), { recursive: true }); writeFileSync(fp, b); }
console.log('compile ok:', r.ok, `${r.seconds.toFixed(1)}s`);
console.log(r.log.split('\n').slice(-30).join('\n'));
