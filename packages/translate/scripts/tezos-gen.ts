// usage: vite-node scripts/tezos-gen.ts <FixtureName> <outDir>   writes the generated project with stub bodies (checks the scaffolding)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { load } from '../test/helpers.js';
import { buildDesign } from '../src/targets/tezos/design.js';
import { genProject } from '../src/targets/tezos/codegen.js';

const [name, out] = process.argv.slice(2);
const { spec } = await load(name!);
const design = buildDesign(spec);
const files = genProject(spec, design, {});
for (const [p, b] of Object.entries(files)) { const fp = join(out!, p); mkdirSync(dirname(fp), { recursive: true }); writeFileSync(fp, b); }
writeFileSync(join(out!, 'design.json'), JSON.stringify(design, null, 2));
console.log(`wrote ${Object.keys(files).length} files to ${out}; units: ${design.instructions.map((h) => h.unit).join(', ')}`);
