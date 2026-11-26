// usage: vite-node scripts/aptos-smoke.ts <FixtureName> [--compile]: design + generated module with stub bodies, optionally compiled in the container
import { writeFileSync } from 'node:fs';
import { AptosPack } from '../src/targets/aptos/pack.js';
import { load } from '../test/helpers.js';
const name = process.argv[2]!;
const { spec } = await load(name);
const pack = new AptosPack();
const design = pack.design(spec, {});
const files = pack.assemble(spec, design, {});
writeFileSync(`/tmp/aptos-smoke-${name}.move`, files[`sources/${design.moduleName}.move`]!);
writeFileSync(`/tmp/aptos-smoke-${name}.design.json`, JSON.stringify(design, null, 2));
console.log(`design: ${design.instructions.map((i) => `${i.kind}:${i.name}`).join(', ')}; helpers ${design.helpers.length}; errors ${design.errors.length}`);
if (process.argv.includes('--compile')) { const c = await pack.compile(files); console.log('compiles:', c.ok, `${c.seconds.toFixed(0)}s`); if (!c.ok) console.log(c.log.slice(0, 3500)); }
