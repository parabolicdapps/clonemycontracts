// usage: vite-node scripts/aptos-example.ts [--write]: assembles the worked example (Escrow.sol + hand-written bodies) with the real generator, compiles it in the container and, with --write, regenerates targets/aptos/example.md
import { readFileSync, writeFileSync } from 'node:fs';
import { AptosPack } from '../src/targets/aptos/pack.js';
import { compileWithAst, stdInputForSource, DEFAULT_SOLC } from '../src/spec/compile.js';
import { extractSpec } from '../src/spec/extract.js';
import { cheatSheet } from '../src/targets/aptos/prompts.js';
import { handlerSignature } from '../src/targets/aptos/codegen.js';

const dir = new URL('../targets/aptos/', import.meta.url).pathname;
const content = readFileSync(`${dir}example/Escrow.sol`, 'utf8');
const c = await compileWithAst({ compilerVersion: DEFAULT_SOLC, stdJsonInput: stdInputForSource('Escrow.sol', content), contract: 'Escrow' });
const spec = extractSpec(c, { file: 'Escrow.sol' });
const pack = new AptosPack();
const design = pack.design(spec, {});
const bodies: Record<string, string> = JSON.parse(readFileSync(`${dir}example/bodies.json`, 'utf8'));
const files = pack.assemble(spec, design, bodies);
const r = await pack.compile(files);
console.log('compiles:', r.ok, `${r.seconds.toFixed(0)}s`);
if (!r.ok) { console.log(r.log.slice(0, 4000)); process.exit(1); }
writeFileSync(`${dir}example/escrow.generated.move`, files[`sources/${design.moduleName}.move`]!);
if (process.argv.includes('--write')) {
  const src = (name: string) => { const f = spec.functions.find((x) => x.name === name) ?? spec.constructor!; return Buffer.from(content).subarray(f.range.start, f.range.start + f.range.length).toString('utf8').trim(); };
  const L: string[] = ['WORKED EXAMPLE (a different contract, `Escrow`; this exact module was generated and compiled by the toolchain; your function will be inserted the same way).', '', 'Helper functions generated for Escrow (the same kind of list you get for your function):', '```move', ...design.helpers.filter((h) => !/^(len|push|pop)_/.test(h.name)).map((h) => `${h.signature};   // ${h.doc}`), '```', ''];
  for (const ins of design.instructions) {
    const name = ins.solidity === 'constructor' ? 'constructor' : ins.solidity;
    L.push(`Solidity ${name}:`, '```solidity', src(name), '```', `Generated signature: \`${handlerSignature(design, ins, 'x').replace(/\n\s*/g, ' ')}\``, 'Body you would write:', '```', bodies[ins.name]!, '```', '');
  }
  L.push('Notes from the example: the Solidity `require(token.transferFrom(msg.sender, address(this), amount))` became `token_pull(caller, amount)` (no approve, no bool); `msg.sender` is `signer::address_of(caller)`; `address(0)` is `@0x0`; mapping reads/writes go through `get_deposits` / `set_deposits`; a getter value is read into a local before the setter is called; `uint256 + uint64` needs `(now_secs() as u256)`.', '');
  void cheatSheet;
  writeFileSync(`${dir}example.md`, L.join('\n'));
}
