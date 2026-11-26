// usage: vite-node scripts/cosmwasm-gen.ts <FixtureName> <outDir> [--compile]   writes the generated project with stub handlers (for checking the scaffolding)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { load } from '../test/helpers.js';
import { buildDesign } from '../src/targets/cosmwasm/design.js';
import { assembleProject } from '../src/targets/cosmwasm/project.js';
import { DEFAULT_CONTAINER, runToolchain } from '../src/pipeline/container.js';

const [name, out, flag] = process.argv.slice(2);
const { spec } = await load(name!);
const design = buildDesign(spec);
const files = assembleProject(spec, design, {});
for (const [p, b] of Object.entries(files)) { const fp = join(out!, p); mkdirSync(dirname(fp), { recursive: true }); writeFileSync(fp, b); }
writeFileSync(join(out!, 'design.json'), JSON.stringify(design, null, 2));
console.log(`wrote ${Object.keys(files).length} files to ${out}; units: ${design.instructions.map((h) => h.unit).join(', ')}`);
if (flag === '--compile') {
  const r = await runToolchain({ ...DEFAULT_CONTAINER, image: process.env.CMC_COSMWASM_IMAGE ?? 'cmc-toolchain-cosmwasm:0.1' }, 'compile', files, {});
  console.log('exit', r.code, `${r.seconds.toFixed(0)}s`);
  console.log(r.log.split('\n').filter((l) => !/^\s*(Compiling|Downloaded|Fresh)/.test(l)).slice(-60).join('\n'));
}
